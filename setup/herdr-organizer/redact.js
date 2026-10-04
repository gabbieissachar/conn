'use strict';

// Share report builder. The report is rebuilt from an allowlist of fields; raw
// tool output is never passed through, so a field that is not listed here cannot
// appear. A second-layer scan then refuses to return a report that still
// contains something private. Labels (workspace, tab, session names) are masked
// unless the user turns them on for that one report.

const { findLeaks } = require('./text');

class ReportBlockedError extends Error {
  constructor(kinds) {
    super('The report was not produced because it still contained private values (' + kinds.join(', ') + '). Keep labels masked and try again.');
    this.status = 422;
    this.code = 'report_blocked';
  }
}

const EXCLUDED = ['client session ids', 'resume commands', 'private paths', 'transcript text', 'bundle ids'];

function cell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim() || '-';
}

function letter(index) {
  let value = '';
  let n = index;
  do { value = String.fromCharCode(65 + (n % 26)) + value; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return value;
}

function createMasker(includeLabels) {
  const sessions = new Map();
  const workspaces = new Map();
  const tabs = new Map();
  const next = (map, key, prefix, render) => {
    if (!map.has(key)) map.set(key, render(map.size));
    return prefix ? prefix + map.get(key) : map.get(key);
  };
  return {
    session: (name) => (includeLabels ? name : 'Session ' + next(sessions, name, '', letter)),
    workspace: (session, id, label) => {
      const mask = 'Workspace ' + next(workspaces, session + '|' + id, '', (n) => String(n + 1));
      return includeLabels && label ? mask + ' (' + label + ')' : mask;
    },
    tab: (session, id, label) => {
      const mask = 'Tab ' + next(tabs, session + '|' + id, '', (n) => String(n + 1));
      return includeLabels && label ? mask + ' (' + label + ')' : mask;
    },
  };
}

function workspaceOf(row) {
  return row.workspace_id || String(row.pane_id || '').split(':')[0] || '?';
}

function verifySection(masker, session, verify) {
  const lines = ['### Identity verification (report only)', ''];
  if (!verify) return lines.concat(['Not requested.', '']);
  const s = verify.summary || {};
  const v = s.verified || {};
  lines.push('Supported panes: ' + cell(s.total) + '. Verified: ' + ((v.native || 0) + (v.argv || 0) + (v.handle || 0) + (v.pid_record || 0)) +
    ' (native ' + (v.native || 0) + ', command line ' + (v.argv || 0) + ', open handle ' + (v.handle || 0) + ', process record ' + (v.pid_record || 0) + '). ' +
    'Ambiguous: ' + (s.ambiguous || 0) + '. Unresolved: ' + (s.unresolved || 0) + '. Safe to apply: ' + cell(s.safe_to_apply) + '. Manual: ' + cell(s.manual) + '.', '');
  lines.push('| Pane | Workspace | Tab | Client | Result | Candidates | Exact | Evidence |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of verify.rows || []) {
    lines.push('| ' + [
      cell(row.pane_id),
      cell(masker.workspace(session, workspaceOf(row), row.workspace_label)),
      cell(masker.tab(session, row.tab_id || row.pane_id, row.tab_label)),
      cell(row.client),
      cell(row.classification),
      cell(row.candidates),
      cell(row.exact),
      cell((row.evidence || []).join(', ') || 'none'),
    ].join(' | ') + ' |');
  }
  lines.push('');
  return lines;
}

function preflightSection(masker, session, preflight) {
  const lines = ['### Restart preflight', ''];
  if (!preflight) return lines.concat(['Not requested.', '']);
  lines.push('Ready to seal: ' + (preflight.ready_to_seal ? 'yes' : 'no') + '.');
  const mine = (preflight.sessions || []).find((item) => item.session === session);
  if (mine) {
    const classes = Object.entries(mine.process_classes || {}).map(([name, count]) => name.replace(/_/g, ' ') + ' ' + count).join(', ');
    lines.push('Panes by class: ' + (classes || 'none') + '. Failures in this session: ' + mine.failure_count + '.');
  }
  lines.push('');
  const rows = [];
  for (const group of preflight.failures || []) {
    for (const entry of group.entries || []) {
      if (entry.session !== session) continue;
      rows.push('| ' + [
        cell(group.kind),
        cell(entry.pane_id || '-'),
        cell(masker.workspace(session, entry.workspace_id || '?', entry.workspace_label)),
        cell(entry.tab_id ? masker.tab(session, entry.tab_id, entry.tab_label) : '-'),
        cell([entry.reason, entry.agent && 'agent ' + entry.agent, entry.status && 'status ' + entry.status].filter(Boolean).join(', ')),
      ].join(' | ') + ' |');
    }
  }
  if (rows.length) lines.push('| Failure | Pane | Workspace | Tab | Detail |', '| --- | --- | --- | --- | --- |', ...rows, '');
  else lines.push('No failures listed for this session.', '');
  return lines;
}

// input: { sessions: [{ name, verify, preflight }], includeLabels, now }
function buildShareReport({ sessions, includeLabels = false, now = new Date() }) {
  const masker = createMasker(includeLabels);
  const lines = [
    '# Herdr restart readiness report (redacted)',
    '',
    'Generated: ' + now.toISOString(),
    'Names: ' + (includeLabels ? 'workspace, tab and session names included at the reader\'s request' : 'workspace, tab and session names masked'),
    'Excluded in every mode: ' + EXCLUDED.join(', ') + '.',
    'Built from an allowlist of fields and scanned for private values before it was shown.',
    '',
  ];
  for (const item of sessions) {
    lines.push('## ' + masker.session(item.name), '');
    lines.push(...verifySection(masker, item.name, item.verify));
    lines.push(...preflightSection(masker, item.name, item.preflight));
  }
  const markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  const kinds = findLeaks(markdown);
  if (kinds.length) throw new ReportBlockedError(kinds);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return { markdown, filename: 'herdr-restart-readiness-' + stamp + '.md', labels_included: includeLabels, excluded: EXCLUDED.slice(), leak_scan: 'passed' };
}

module.exports = { buildShareReport, ReportBlockedError, EXCLUDED };
