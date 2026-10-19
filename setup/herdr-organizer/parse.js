'use strict';

// Parsers for the Herdr tooling's output. This is the one place that knows the
// text formats of `herdr-agent-verify-identity` and the restart preflight, so a
// tool-side JSON mode (a companion task for the personal project) replaces only
// this file. Parsers are tolerant: a line they do not recognise is skipped, and
// they never keep session ids, resume commands or paths.

const { readQuoted, scrub } = require('./text');

const VERIFIED_CLASSES = new Set(['native_verified', 'argv_verified', 'handle_verified', 'pid_record_verified']);
const ALL_CLASSES = new Set([...VERIFIED_CLASSES, 'candidate_ambiguous', 'unresolved']);

function unwrapResult(value) {
  return value && typeof value === 'object' && value.result && typeof value.result === 'object' ? value.result : value;
}

function parseSessions(jsonText) {
  let data;
  try { data = unwrapResult(JSON.parse(jsonText)); } catch { return null; }
  const list = data && Array.isArray(data.sessions) ? data.sessions : null;
  if (!list) return null;
  return list
    .filter((item) => item && typeof item.name === 'string')
    .map((item) => ({ name: item.name, running: item.running === true, isDefault: item.default === true || item.name === 'default' }));
}

// Internal pane records. `cwd` stays server-side; publicPane() is what the
// browser may see.
function parsePanes(jsonText) {
  let data;
  try { data = unwrapResult(JSON.parse(jsonText)); } catch { return null; }
  const list = data && Array.isArray(data.panes) ? data.panes : null;
  if (!list) return null;
  return list
    .filter((item) => item && typeof item.pane_id === 'string')
    .map((item) => ({
      pane_id: item.pane_id,
      workspace_id: typeof item.workspace_id === 'string' ? item.workspace_id : '',
      tab_id: typeof item.tab_id === 'string' ? item.tab_id : '',
      agent: typeof item.agent === 'string' ? item.agent : '',
      agent_status: typeof item.agent_status === 'string' ? item.agent_status : '',
      cwd: typeof item.foreground_cwd === 'string' && item.foreground_cwd ? item.foreground_cwd : (typeof item.cwd === 'string' ? item.cwd : ''),
    }));
}

// Panes that carry an agent session id, for the context gauge join only. The id is
// the join key held in memory by the caller; nothing that leaves the server keeps more
// than its first eight characters. `title` is the tab or pane title Herdr reports.
function parseAgentPanes(jsonText) {
  let data;
  try { data = unwrapResult(JSON.parse(jsonText)); } catch { return null; }
  const list = data && Array.isArray(data.panes) ? data.panes : null;
  if (!list) return null;
  return list
    .filter((item) => item && typeof item.pane_id === 'string' && item.agent_session && typeof item.agent_session.value === 'string' && item.agent_session.value)
    .map((item) => ({
      pane_id: item.pane_id,
      agent_session_id: item.agent_session.value,
      agent: typeof item.agent === 'string' ? item.agent : '',
      agent_status: typeof item.agent_status === 'string' ? item.agent_status : '',
      label: typeof item.label === 'string' ? item.label.slice(0, 80) : '',
      cwds: [item.cwd, item.foreground_cwd].filter((value) => typeof value === 'string' && value),
      title: typeof item.terminal_title_stripped === 'string' ? item.terminal_title_stripped.slice(0, 120) : '',
    }));
}

// Every pane that carries a label (herdr pane rename), with or without an agent. Used by the leader-space audit.
function parseLabelledPanes(jsonText) {
  let data;
  try { data = unwrapResult(JSON.parse(jsonText)); } catch { return null; }
  const list = data && Array.isArray(data.panes) ? data.panes : null;
  if (!list) return null;
  return list
    .filter((item) => item && typeof item.pane_id === 'string' && typeof item.label === 'string' && item.label)
    .map((item) => ({
      pane_id: item.pane_id,
      workspace_id: typeof item.workspace_id === 'string' ? item.workspace_id : '',
      label: item.label.slice(0, 80),
      agent_status: typeof item.agent_status === 'string' ? item.agent_status : '',
    }));
}

function parseWorkspaceLabels(jsonText) {
  let data;
  try { data = unwrapResult(JSON.parse(jsonText)); } catch { return null; }
  const list = data && Array.isArray(data.workspaces) ? data.workspaces : null;
  if (!list) return null;
  const labels = new Map();
  for (const item of list) if (item && typeof item.workspace_id === 'string') labels.set(item.workspace_id, typeof item.label === 'string' ? item.label : '');
  return labels;
}

function publicPane(pane) {
  return { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id, agent: pane.agent, agent_status: pane.agent_status };
}

function parseVerifierLine(line) {
  const head = /^([a-z_]+) workspace=/.exec(line);
  if (!head || !ALL_CLASSES.has(head[1])) return null;
  let pos = head[0].length;
  const workspace = readQuoted(line, pos);
  if (!workspace) return null;
  pos = workspace.end;
  if (!line.startsWith(' tab=', pos)) return null;
  const tab = readQuoted(line, pos + 5);
  if (!tab) return null;
  pos = tab.end;
  if (!line.startsWith(' pane=', pos)) return null;
  const pane = readQuoted(line, pos + 6);
  if (!pane) return null;
  const rest = /^ pane_id=(\S+) candidates=(\d+) exact=(\d+) evidence=(\S*)(?: session_id=\S+)?\s*$/.exec(line.slice(pane.end));
  if (!rest) return null;
  return {
    classification: head[1],
    verified: VERIFIED_CLASSES.has(head[1]),
    workspace_label: workspace.value,
    tab_label: tab.value,
    pane_id: rest[1],
    candidates: Number(rest[2]),
    exact: Number(rest[3]),
    evidence: rest[4] === 'none' || rest[4] === '' ? [] : rest[4].split(','),
    hint: '',
  };
}

function parseVerifierReport(stdout) {
  const rows = [];
  const summary = { total: null, verified: { native: 0, argv: 0, handle: 0, pid_record: 0 }, ambiguous: 0, unresolved: 0, safe_to_apply: null, manual: null };
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const row = parseVerifierLine(raw);
    if (row) { rows.push(row); continue; }
    const hint = /^\s+hint: (.*)$/.exec(raw);
    if (hint && rows.length) { rows[rows.length - 1].hint = hint[1]; continue; }
    let match;
    if ((match = /^total panes: (\d+)$/.exec(raw))) summary.total = Number(match[1]);
    else if ((match = /^verified: native (\d+); argv (\d+); handle (\d+); pid record (\d+)$/.exec(raw))) {
      summary.verified = { native: Number(match[1]), argv: Number(match[2]), handle: Number(match[3]), pid_record: Number(match[4]) };
    } else if ((match = /^ambiguous: (\d+); unresolved: (\d+)$/.exec(raw))) {
      summary.ambiguous = Number(match[1]);
      summary.unresolved = Number(match[2]);
    } else if ((match = /^safe to apply with --apply: (\d+); manual: (\d+)$/.exec(raw))) {
      summary.safe_to_apply = Number(match[1]);
      summary.manual = Number(match[2]);
    }
  }
  return { rows, summary };
}

// Applied-result lines printed after `--apply`. Only counts are kept.
function parseApplyResult(stdout) {
  const result = { written: null, skipped: null, initially_verified: null };
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const match = /^apply result: written (\d+); skipped (\d+); initially verified (\d+)$/.exec(raw);
    if (match) {
      result.written = Number(match[1]);
      result.skipped = Number(match[2]);
      result.initially_verified = Number(match[3]);
    }
  }
  return result;
}

function splitIdentity(key) {
  const parts = String(key).split('|');
  return { session: parts[0] || '', workspace_id: parts[1] || '', tab_id: parts[2] || '', pane_id: parts[3] || '' };
}

function parseFailureEntry(line) {
  const head = /^ {2}(\S+)(.*)$/.exec(line);
  if (!head || head[1].indexOf('|') === -1) return null;
  const entry = { key: head[1], identity: splitIdentity(head[1]), workspace_label: '', tab_label: '', reason: '', agent: '', status: '', trusted_restore: null, ack: null };
  let rest = head[2];
  if (rest.startsWith(' workspace ')) {
    const workspace = readQuoted(rest, ' workspace '.length);
    if (workspace) { entry.workspace_label = workspace.value; rest = rest.slice(workspace.end); }
  }
  if (rest.startsWith(', tab ')) {
    const tab = readQuoted(rest, ', tab '.length);
    if (tab) { entry.tab_label = tab.value; rest = rest.slice(tab.end); }
  }
  const pair = / (reason|agent|status|trusted_restore)=(\S+)/g;
  let match;
  while ((match = pair.exec(rest))) {
    if (match[1] === 'trusted_restore') entry.trusted_restore = match[2] === 'true';
    else entry[match[1]] = match[2];
  }
  return entry;
}

function parsePreflight(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  let summary = null;
  const start = lines.indexOf('{');
  if (start !== -1) {
    const end = lines.indexOf('}', start);
    if (end !== -1) {
      try { summary = JSON.parse(lines.slice(start, end + 1).join('\n')); } catch { summary = null; }
    }
  }
  const failures = [];
  let group = null;
  let last = null;
  let inFailures = false;
  for (const raw of lines) {
    if (raw === 'Preflight failures:') { inFailures = true; continue; }
    if (!inFailures) continue;
    if (raw === 'Summary:') break;
    const heading = /^- (\w+) \((\d+)\): (.*)$/.exec(raw);
    if (heading) { group = { kind: heading[1], count: Number(heading[2]), tool_hint: heading[3], entries: [] }; failures.push(group); last = null; continue; }
    const ack = /^ {4}--allow-(volatile-pane|mixed-cwd-workspace) (?:'([^']*)'|(\S+))\s*$/.exec(raw);
    if (ack && last) { last.ack = { flag: ack[1], value: ack[2] !== undefined ? ack[2] : ack[3] }; continue; }
    const entry = group ? parseFailureEntry(raw) : null;
    if (entry) { group.entries.push(entry); last = entry; }
  }
  const sessions = summary && Array.isArray(summary.sessions) ? summary.sessions.map((item) => ({
    session: String(item.session || ''),
    process_classes: item && item.process_classes && typeof item.process_classes === 'object' ? item.process_classes : {},
    failure_count: Number(item.failure_count) || 0,
  })) : [];
  const ready = summary ? summary.ready_to_seal === true : null;
  return { ready_to_seal: ready, sessions, failures };
}

// `cleanup-empty-tabs --workspace W` without --execute prints a JSON preview
// followed by a "Preview only" line. It is read-only.
function parseCleanupPreview(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const start = lines.indexOf('{');
  const end = start === -1 ? -1 : lines.indexOf('}', start);
  if (start === -1 || end === -1) return null;
  let value;
  try { value = JSON.parse(lines.slice(start, end + 1).join('\n')); } catch { return null; }
  if (!value || typeof value.workspace_id !== 'string') return null;
  const tab = (item) => ({ tab_id: String(item.tab_id || ''), label: typeof item.label === 'string' ? item.label : '', pane_count: Array.isArray(item.pane_ids) ? item.pane_ids.length : 0 });
  return {
    workspace_id: value.workspace_id,
    tabs_to_close: (Array.isArray(value.tabs_to_close) ? value.tabs_to_close : []).map(tab),
    protected_tabs: (Array.isArray(value.protected_tabs) ? value.protected_tabs : []).map((item) => ({ ...tab(item), reason: String(item.reason || '') })),
    kept_tab_id: typeof value.kept_tab_id === 'string' ? value.kept_tab_id : '',
    // Set when every tab is an empty shell: the workspace itself closes with its last tab.
    close_workspace: value.close_workspace === true,
    kept_reason: value.kept_reason === 'running_inside' || value.kept_reason === 'only_workspace' ? value.kept_reason : '',
  };
}

const SKIP_REASONS = new Set(['active_agent', 'unverified_agent_session', 'capture_failed', 'workspace_gone', 'workspace_changed']);
const WORKSPACE_ID_RE = /^w[A-Za-z0-9]{1,10}$/;
const PANE_ID_RE = /^w[A-Za-z0-9]{1,10}:p[A-Za-z0-9]{1,10}$/;

// `archive-all` without --execute prints a JSON object and a "Preview only" line.
// Only fixed fields survive: ids must match their patterns, reasons are an allowlist,
// the free-text error the tool may attach to a skipped row is dropped, and labels are scrubbed.
function parseArchiveAllPreview(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const start = lines.indexOf('{');
  const end = start === -1 ? -1 : lines.indexOf('}', start);
  if (start === -1 || end === -1) return null;
  let value;
  try { value = JSON.parse(lines.slice(start, end + 1).join('\n')); } catch { return null; }
  if (!value || typeof value.session !== 'string' || !Array.isArray(value.to_archive) || !Array.isArray(value.skipped)) return null;
  const label = (item) => scrub(typeof item.label === 'string' ? item.label : '', 120);
  const count = (number) => (Number.isInteger(number) && number >= 0 ? number : 0);
  const ready = (item) => ({ workspace_id: item.workspace_id, label: label(item), tab_count: count(item.tab_count), pane_count: count(item.pane_count), resumable_agent_panes: count(item.resumable_agent_panes) });
  const skipped = (item) => ({
    workspace_id: item.workspace_id,
    label: label(item),
    reasons: (Array.isArray(item.reasons) ? item.reasons : []).filter((reason) => SKIP_REASONS.has(reason)),
    active_pane_ids: (Array.isArray(item.active_pane_ids) ? item.active_pane_ids : []).filter((id) => typeof id === 'string' && PANE_ID_RE.test(id)),
    unverified_panes: (Array.isArray(item.unverified_panes) ? item.unverified_panes : [])
      .filter((pane) => pane && typeof pane.pane_id === 'string' && PANE_ID_RE.test(pane.pane_id))
      .map((pane) => ({ pane_id: pane.pane_id, client: pane.client === 'claude' || pane.client === 'codex' ? pane.client : '' })),
  });
  const valid = (item) => item && typeof item.workspace_id === 'string' && WORKSPACE_ID_RE.test(item.workspace_id);
  const readyRows = value.to_archive.filter(valid).map(ready);
  const skippedRows = value.skipped.filter(valid).map(skipped);
  // Workspaces the tool counted that did not make it through (a malformed id, or a tool that listed fewer rows than its total)
  // are counted, never silently lost, so the page can say the list is incomplete.
  const listed = value.to_archive.length + value.skipped.length;
  const expected = Number.isInteger(value.workspace_total) ? Math.max(value.workspace_total, listed) : listed;
  return { session: value.session, to_archive: readyRows, skipped: skippedRows, omitted: Math.max(0, expected - readyRows.length - skippedRows.length) };
}

// `reconcile-all --bundle ID` without --confirm prints {"sessions": [{"session", "workspaces": {action: count}}]}
// and a "Preview only" line. It is read-only.
function parseReconcilePreview(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const start = lines.indexOf('{');
  if (start === -1) return null;
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) if (lines[i] === '}') { end = i; break; }
  if (end === -1) return null;
  let value;
  try { value = JSON.parse(lines.slice(start, end + 1).join('\n')); } catch { return null; }
  if (!value || !Array.isArray(value.sessions)) return null;
  return value.sessions
    .filter((item) => item && typeof item.session === 'string' && item.workspaces && typeof item.workspaces === 'object')
    .map((item) => {
      const count = (name) => (Number.isInteger(item.workspaces[name]) ? item.workspaces[name] : 0);
      const known = ['adopt', 'rebuild', 'ambiguous'];
      const other = Object.entries(item.workspaces).filter(([name]) => !known.includes(name)).reduce((total, [, value]) => total + (Number.isInteger(value) ? value : 0), 0);
      return { session: item.session, adopt: count('adopt'), rebuild: count('rebuild'), ambiguous: count('ambiguous'), other };
    });
}

function parseSealResult(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const start = lines.indexOf('{');
  const end = start === -1 ? -1 : lines.indexOf('}', start);
  if (start === -1 || end === -1) return null;
  try {
    const value = JSON.parse(lines.slice(start, end + 1).join('\n'));
    if (value && typeof value.bundle_id === 'string' && value.ready === true) return { bundle_id: value.bundle_id, session_count: Number(value.session_count) || 0 };
  } catch { /* fall through */ }
  return null;
}

module.exports = {
  VERIFIED_CLASSES,
  parseSessions,
  parsePanes,
  parseAgentPanes,
  parseLabelledPanes,
  parseWorkspaceLabels,
  publicPane,
  parseVerifierLine,
  parseVerifierReport,
  parseApplyResult,
  parsePreflight,
  parseSealResult,
  parseCleanupPreview,
  parseArchiveAllPreview,
  parseReconcilePreview,
  splitIdentity,
};
