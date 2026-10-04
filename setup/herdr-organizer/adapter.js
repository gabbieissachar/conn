'use strict';

// The only module that runs Herdr tooling. Every command is a fixed argument
// shape spawned without a shell; nothing the browser sends becomes a command,
// an argument list or free text for a shell. Session names are checked against
// `herdr session list`, ids by pattern and against the live panes.
//
// The runner is injectable so tests drive the adapter with fixtures and never
// touch a real Herdr session, registry or bundle directory.

const { spawn } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');
const parse = require('./parse');
const { scrub, findLeaks } = require('./text');

class AdapterError extends Error {
  constructor(message, status = 400, code = 'error') {
    super(scrub(message));
    this.status = status;
    this.code = code;
  }
}

// A stopped session on this machine is literally named "-h", so a name must
// never be able to start with a dash and be read as an option.
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SESSIONS = 8;
const WORKSPACE_ID_RE = /^w[A-Za-z0-9]{1,10}$/;
const CLEANUP_CONCURRENCY = 4;
const PANE_ID_RE = /^w[A-Za-z0-9]{1,10}:p[A-Za-z0-9]{1,10}$/;
const SESSION_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CLIENTS = new Set(['claude', 'codex']);
// A manual identity may only be saved for a pane the most recent identity check
// found unverified, so a check older than this must be repeated first.
const VERIFY_FRESH_MS = 60 * 60 * 1000;

// Herdr context variables from the shell that started the server must never
// reach a child process: `register` prefers the current pane over explicit pane
// arguments, so an inherited HERDR_PANE_ID would register the wrong pane.
const ENV_KEEP = new Set(['HERDR_LAB_HELPER', 'HERDR_BIN_PATH']);

function childEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(base || {})) {
    if (key.startsWith('HERDR_') && !ENV_KEEP.has(key)) continue;
    env[key] = value;
  }
  return env;
}

function defaultRunner(file, args, { env, timeoutMs = 60000, maxBytes = 2 * 1024 * 1024, cwd, input } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(file, args, { env, cwd, shell: false, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ code: -1, stdout: '', stderr: error.message, timedOut: false, truncated: false });
      return;
    }
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8'); else truncated = true;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf8'); else truncated = true;
    });
    child.on('error', (error) => { clearTimeout(timer); finish({ code: -1, stdout, stderr: stderr || error.message, timedOut, truncated }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ code: code === null ? -1 : code, stdout, stderr, timedOut, truncated }); });
  });
}

function createAdapter({ toolRoot, runner = defaultRunner, env = process.env, pythonBin = 'python3', herdrBin = 'herdr' } = {}) {
  if (!toolRoot) throw new Error('adapter needs the Herdr tool root');
  const registryScript = path.join(toolRoot, 'agent-session-registry.py');
  const storeCheckScript = path.join(__dirname, 'store_check.py');
  const lastVerify = new Map();
  const organizerScript = path.join(toolRoot, 'workspace-organizer.py');
  const runEnv = () => childEnv(env);

  // The verifier and preflight are slow on a busy machine (minutes). Identical
  // requests that arrive while one is running (a page reload, a second tab)
  // share that run instead of starting another.
  const inflight = new Map();
  function singleFlight(key, work) {
    if (inflight.has(key)) return inflight.get(key);
    const promise = Promise.resolve().then(work).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  // Read-only Herdr call against one named session. When HERDR_LAB_HELPER is
  // set, the isolated lab helper is the only route to Herdr, as the organizer does.
  function herdrCall(session, args, options = {}) {
    const helper = env.HERDR_LAB_HELPER;
    if (helper) return runner(helper, ['run', session, ...args], { env: runEnv(), ...options });
    return runner(herdrBin, ['--session', session, ...args], { env: runEnv(), ...options });
  }

  async function listSessions() {
    const result = await runner(herdrBin, ['session', 'list', '--json'], { env: runEnv(), timeoutMs: 15000 });
    const sessions = result.code === 0 ? parse.parseSessions(result.stdout) : null;
    if (!sessions) throw new AdapterError('Could not list Herdr sessions. Is Herdr installed and on PATH?', 502, 'herdr_unavailable');
    return sessions;
  }

  // The browser's session names are only ever looked up here, never used as-is.
  async function requireSessions(names) {
    if (!Array.isArray(names) || names.length === 0) throw new AdapterError('Select at least one session.');
    if (names.length > MAX_SESSIONS) throw new AdapterError('Too many sessions selected.');
    const seen = new Set();
    for (const name of names) {
      if (typeof name !== 'string' || !SESSION_NAME_RE.test(name)) throw new AdapterError('Invalid session name.');
      if (seen.has(name)) throw new AdapterError('Each session may be selected once.');
      seen.add(name);
    }
    const known = await listSessions();
    for (const name of names) {
      const match = known.find((item) => item.name === name);
      if (!match) throw new AdapterError('Unknown session.');
      if (match.isDefault) throw new AdapterError('The default Herdr session is not supported for restart recovery.');
      if (!match.running) throw new AdapterError('That session is not running. Attach it first.');
    }
    return names.slice();
  }

  async function requireSession(name) {
    return (await requireSessions([name]))[0];
  }

  // Internal pane records (include cwd); callers must use parse.publicPane for the browser.
  async function readPanes(session) {
    const result = await herdrCall(session, ['pane', 'list'], { timeoutMs: 20000 });
    const panes = result.code === 0 ? parse.parsePanes(result.stdout) : null;
    if (!panes) throw new AdapterError('Could not read the panes of that session.', 502, 'herdr_unavailable');
    return panes;
  }

  async function listSessionsView() {
    const sessions = await listSessions();
    return sessions.map((item) => ({ name: item.name, running: item.running, selectable: item.running && !item.isDefault && SESSION_NAME_RE.test(item.name), is_default: item.isDefault }));
  }

  async function verifyReport(session) {
    await requireSession(session);
    return singleFlight('verify|' + session, () => verifyReportRun(session));
  }

  async function verifyReportRun(session) {
    const result = await runner(pythonBin, [registryScript, 'verify-identity', '--herdr-session', session], { env: runEnv(), timeoutMs: 900000 });
    const report = parse.parseVerifierReport(result.stdout);
    if (report.rows.length === 0 && report.summary.total === null) {
      throw new AdapterError(result.stderr || result.stdout || 'The identity verifier returned nothing.', 502, 'verifier_failed');
    }
    let panes = [];
    try { panes = await readPanes(session); } catch { panes = []; }
    const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
    const rows = report.rows.map((row) => {
      const pane = byId.get(row.pane_id);
      return {
        pane_id: row.pane_id,
        workspace_id: pane ? pane.workspace_id : '',
        tab_id: pane ? pane.tab_id : '',
        client: pane ? pane.agent : '',
        agent_status: pane ? pane.agent_status : '',
        workspace_label: row.workspace_label,
        tab_label: row.tab_label,
        classification: row.classification,
        verified: row.verified,
        candidates: row.candidates,
        exact: row.exact,
        evidence: row.evidence,
        hint: scrub(row.hint),
      };
    });
    lastVerify.set(session, { at: Date.now(), verified: new Map(rows.map((row) => [row.pane_id, row.verified])) });
    return { session, generated_at: new Date().toISOString(), rows, summary: report.summary };
  }

  // Preflight acknowledgements are accepted only when the exact identity
  // appears in a current failure of the matching kind. No free text, no
  // global bypass.
  function allowedAcknowledgements(preflight) {
    const volatile = new Set();
    const mixed = new Set();
    for (const group of preflight.failures) {
      for (const entry of group.entries) {
        if (!entry.ack) continue;
        if (group.kind === 'blocker' && entry.ack.flag === 'volatile-pane') volatile.add(entry.ack.value);
        if (group.kind === 'mixed_workspace_cwd' && entry.ack.flag === 'mixed-cwd-workspace') mixed.add(entry.ack.value);
      }
    }
    return { volatile, mixed };
  }

  function preflightArgs(sessions, acks, { preflightOnly }) {
    const args = [organizerScript, 'prepare-restart-recovery'];
    for (const session of sessions) args.push('--session', session);
    for (const value of acks.volatile) args.push('--allow-volatile-pane', value);
    for (const value of acks.mixed) args.push('--allow-mixed-cwd-workspace', value);
    if (preflightOnly) args.push('--preflight-only');
    return args;
  }

  function runPreflight(sessions, acks) {
    return singleFlight('preflight|' + sessions.join(',') + '|' + JSON.stringify(acks), () => runPreflightOnce(sessions, acks));
  }

  async function runPreflightOnce(sessions, acks) {
    const result = await runner(pythonBin, preflightArgs(sessions, acks, { preflightOnly: true }), { env: runEnv(), timeoutMs: 600000 });
    const parsed = parse.parsePreflight(result.stdout);
    if (parsed.ready_to_seal === null) {
      throw new AdapterError(result.stderr || result.stdout || 'The preflight returned nothing.', 502, 'preflight_failed');
    }
    return parsed;
  }

  function normalizeAcks(input) {
    const acks = { volatile: [], mixed: [] };
    const source = input && typeof input === 'object' ? input : {};
    for (const [field, key] of [['volatile', 'volatile'], ['mixed', 'mixed']]) {
      const list = source[field];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length > 64) throw new AdapterError('Invalid acknowledgements.');
      for (const value of list) {
        if (typeof value !== 'string' || value.length > 200) throw new AdapterError('Invalid acknowledgements.');
        if (!acks[key].includes(value)) acks[key].push(value);
      }
    }
    return acks;
  }

  async function validatedAcks(sessions, requested) {
    const acks = normalizeAcks(requested);
    if (acks.volatile.length === 0 && acks.mixed.length === 0) return acks;
    const baseline = await runPreflight(sessions, { volatile: [], mixed: [] });
    const allowed = allowedAcknowledgements(baseline);
    for (const value of acks.volatile) if (!allowed.volatile.has(value)) throw new AdapterError('An acknowledgement does not match a current preflight failure. Re-run the preflight.');
    for (const value of acks.mixed) if (!allowed.mixed.has(value)) throw new AdapterError('An acknowledgement does not match a current preflight failure. Re-run the preflight.');
    return acks;
  }

  function preflightView(sessions, parsed, acks) {
    return {
      sessions: parsed.sessions,
      ready_to_seal: parsed.ready_to_seal,
      acknowledged: { volatile: acks.volatile.length, mixed: acks.mixed.length },
      generated_at: new Date().toISOString(),
      failures: parsed.failures.map((group) => ({
        kind: group.kind,
        count: group.count,
        tool_hint: scrub(group.tool_hint, 240),
        entries: group.entries.map((entry) => ({
          session: entry.identity.session,
          workspace_id: entry.identity.workspace_id,
          tab_id: entry.identity.tab_id,
          pane_id: entry.identity.pane_id,
          workspace_label: entry.workspace_label,
          tab_label: entry.tab_label,
          reason: entry.reason,
          agent: entry.agent,
          status: entry.status,
          trusted_restore: entry.trusted_restore,
          ack: entry.ack ? { flag: entry.ack.flag, value: entry.ack.value } : null,
        })),
      })),
    };
  }

  async function preflight(sessionNames, requestedAcks) {
    const sessions = await requireSessions(sessionNames);
    const acks = await validatedAcks(sessions, requestedAcks);
    const parsed = await runPreflight(sessions, acks);
    return preflightView(sessions, parsed, acks);
  }

  // Refreshes the shared live snapshot file the Workspaces and Archives views read.
  async function refreshSnapshot(session) {
    await requireSession(session);
    const result = await runner(pythonBin, [organizerScript, '--session', session, 'snapshot'], { env: runEnv(), timeoutMs: 60000 });
    if (result.code !== 0) throw new AdapterError(result.stderr || result.stdout || 'Snapshot refresh failed.', 502, 'snapshot_failed');
    return { session, refreshed_at: new Date().toISOString() };
  }

  // ---- Tier 1: private local writes (each needs the confirm token the page sends) ----

  function requireConfirm(actual, expected) {
    if (actual !== expected) throw new AdapterError('This change needs an explicit confirmation.', 400, 'confirm_required');
  }

  // Registers every row the verifier proves, using the tool's own guarded apply
  // path (it re-reads each live pane right before writing).
  async function applyVerified(sessionName, confirm) {
    const session = await requireSession(sessionName);
    requireConfirm(confirm, 'apply:' + session);
    const result = await runner(pythonBin, [registryScript, 'verify-identity', '--herdr-session', session, '--apply'], { env: runEnv(), timeoutMs: 900000 });
    const applied = parse.parseApplyResult(result.stdout);
    if (applied.written === null) throw new AdapterError(result.stderr || result.stdout || 'The apply step returned nothing.', 502, 'apply_failed');
    return { session, written: applied.written, skipped: applied.skipped, initially_verified: applied.initially_verified, applied_at: new Date().toISOString() };
  }

  const maskId = (id) => id.slice(0, 4) + '...' + id.slice(-4);

  // The id is validated in layers, cheapest first: format, present in the real
  // client store, the store's recorded folder matches the pane's folder (or the
  // override is sent), and not already claimed by another pane. It is never
  // logged, echoed or returned; the caller only gets a masked form.
  async function saveManualIdentity({ session: sessionName, pane_id: paneId, client, session_id: sessionId, folder_override: folderOverride, confirm }) {
    const session = await requireSession(sessionName);
    if (typeof paneId !== 'string' || !PANE_ID_RE.test(paneId)) throw new AdapterError('Invalid pane.');
    requireConfirm(confirm, 'save:' + paneId);
    if (!CLIENTS.has(client)) throw new AdapterError('Pick Claude or Codex.');
    if (typeof sessionId !== 'string' || !SESSION_UUID_RE.test(sessionId)) throw new AdapterError('That does not look like a session id. Expected the 36-character form.', 400, 'invalid_session_id');
    const id = sessionId.toLowerCase();

    const panes = await readPanes(session);
    const pane = panes.find((item) => item.pane_id === paneId);
    if (!pane) throw new AdapterError('That pane is no longer in the session.', 404, 'pane_missing');
    if (pane.agent !== client) throw new AdapterError('That pane is running ' + (pane.agent || 'no supported agent') + ', not ' + client + '.', 409, 'client_mismatch');

    const seen = lastVerify.get(session);
    if (!seen || Date.now() - seen.at > VERIFY_FRESH_MS || !seen.verified.has(paneId)) throw new AdapterError('Run the identity check for this session first, so the page knows this pane is unverified.', 409, 'verify_required');
    if (seen.verified.get(paneId) === true) throw new AdapterError('This pane already has a verified identity. Use Apply verified identities instead.', 409, 'already_verified');

    const checked = await runner(pythonBin, [storeCheckScript, toolRoot], {
      env: runEnv(),
      timeoutMs: 60000,
      input: JSON.stringify({ client, session_id: id, pane_cwd: pane.cwd, herdr_session: session, pane_id: paneId }),
    });
    let check = null;
    try { check = JSON.parse(checked.stdout); } catch { check = null; }
    if (!check || check.error || checked.code !== 0) throw new AdapterError('Could not check the client store.', 502, 'store_check_failed');
    if (!check.valid_format) throw new AdapterError('That does not look like a session id.', 400, 'invalid_session_id');
    if (!check.exists) throw new AdapterError('That session id is not in the ' + client + ' store on this machine.', 404, 'not_in_store');
    if (check.registered_elsewhere) throw new AdapterError('That session is already registered to another pane. Remove that registration first (herdr-agent-remove), then save again.', 409, 'already_registered');
    if (check.store_folder !== 'match' && folderOverride !== true) {
      const unknown = check.store_folder === 'unknown';
      throw new AdapterError(unknown
        ? 'The store does not record a folder for that session, so it cannot be matched to this pane. Confirm the override only if you are sure.'
        : 'That session was recorded in a different folder than this pane. Confirm the override only if you are sure it is the right session.',
      409, unknown ? 'folder_unknown' : 'folder_differs');
    }

    const registered = await runner(pythonBin, [
      registryScript, 'register', '--client', client, '--session-id', id, '--allow-no-herdr',
      '--pane-id', paneId, '--workspace-id', pane.workspace_id, '--tab-id', pane.tab_id,
      '--herdr-session', session, ...(pane.cwd ? ['--cwd', pane.cwd] : []),
    ], { env: runEnv(), timeoutMs: 60000 });
    if (registered.code !== 0) throw new AdapterError('The registry refused the identity. ' + scrub(registered.stderr || registered.stdout, 160), 502, 'register_failed');
    return { session, pane_id: paneId, client, masked_id: maskId(id), folder_confirmed: check.store_folder === 'match' ? 'match' : 'override', saved_at: new Date().toISOString() };
  }

  // Seals a private restart-recovery bundle through the tool's own command, which
  // re-runs the strict preflight itself and refuses on any failure.
  async function sealBundle(sessionNames, requestedAcks, confirm) {
    const sessions = await requireSessions(sessionNames);
    requireConfirm(confirm, 'seal:' + sessions.join(','));
    const acks = await validatedAcks(sessions, requestedAcks);
    const result = await runner(pythonBin, preflightArgs(sessions, acks, { preflightOnly: false }), { env: runEnv(), timeoutMs: 900000 });
    const sealed = parse.parseSealResult(result.stdout);
    if (sealed) return { sealed: true, bundle_id: sealed.bundle_id, session_count: sealed.session_count, sealed_at: new Date().toISOString() };
    const preflightResult = parse.parsePreflight(result.stdout);
    if (preflightResult.ready_to_seal === false) throw new AdapterError('The preflight failed, so no bundle was sealed. Check again for the current failures.', 409, 'preflight_failed');
    throw new AdapterError(result.stderr || result.stdout || 'Sealing returned nothing.', 502, 'seal_failed');
  }

  // Read-only preview of `cleanup-empty-tabs` for every workspace of one session.
  // The workspace ids come from the live pane list and must match a fixed pattern;
  // nothing from the browser except the validated session name is used. The
  // commands returned for copying are built here from those validated values.
  async function cleanupPreview(sessionName) {
    const session = await requireSession(sessionName);
    const panes = await readPanes(session);
    const ids = [...new Set(panes.map((pane) => pane.workspace_id).filter((id) => WORKSPACE_ID_RE.test(id)))]
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const results = new Array(ids.length);
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const index = cursor++;
        const id = ids[index];
        const result = await runner(pythonBin, [organizerScript, '--session', session, 'cleanup-empty-tabs', '--workspace', id], { env: runEnv(), timeoutMs: 120000 });
        const preview = result.code === 0 ? parse.parseCleanupPreview(result.stdout) : null;
        results[index] = preview && preview.workspace_id === id ? preview : { workspace_id: id, error: 'Preview failed for this workspace.' };
      }
    }
    await Promise.all(Array.from({ length: Math.min(CLEANUP_CONCURRENCY, ids.length) }, worker));
    const workspaces = results.map((item) => (item.error ? { workspace_id: item.workspace_id, error: item.error, tabs_to_close: [], protected_tabs: [], kept_tab_id: '' } : item));
    const closable = workspaces.filter((item) => item.tabs_to_close.length > 0);
    const base = 'herdr-organizer --session ' + session + ' cleanup-empty-tabs --workspace ';
    return {
      session,
      generated_at: new Date().toISOString(),
      workspaces,
      totals: {
        workspaces: workspaces.length,
        workspaces_with_empty_tabs: closable.length,
        tabs_to_close: closable.reduce((total, item) => total + item.tabs_to_close.length, 0),
        protected_tabs: workspaces.reduce((total, item) => total + item.protected_tabs.length, 0),
        errors: workspaces.filter((item) => item.error).length,
      },
      // Copy-only. Preview closes nothing; the execute command closes tabs, so the page never runs it.
      commands: {
        preview_all: 'for ws in ' + ids.join(' ') + '; do ' + base + '"$ws"; done',
        execute_all: closable.length ? closable.map((item) => base + item.workspace_id + ' --execute --confirm ' + item.workspace_id).join(' && \\\n') : '',
      },
    };
  }

  // The snapshot file the Workspaces and Archives views read. It is read from the
  // tool root (so an isolated copy of the tools is honoured) and refused if it
  // carries anything that looks private.
  async function readSnapshot() {
    const file = path.join(toolRoot, 'state', 'workspace-organizer', 'live-snapshot.json');
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch { throw new AdapterError('No snapshot yet. Refresh the snapshot first.', 404, 'no_snapshot'); }
    if (raw.length > 4 * 1024 * 1024) throw new AdapterError('The snapshot is too large to show.', 502, 'snapshot_invalid');
    if (findLeaks(raw).length) throw new AdapterError('The snapshot contains private values and was not shown.', 502, 'snapshot_invalid');
    try { return JSON.parse(raw); } catch { throw new AdapterError('The snapshot file is not valid JSON.', 502, 'snapshot_invalid'); }
  }

  return {
    listSessions,
    listSessionsView,
    requireSessions,
    requireSession,
    readPanes,
    verifyReport,
    preflight,
    refreshSnapshot,
    readSnapshot,
    cleanupPreview,
    applyVerified,
    saveManualIdentity,
    sealBundle,
    // exposed for later phases and tests
    _internal: { runner, runEnv, herdrCall, registryScript, organizerScript, pythonBin, runPreflight, validatedAcks, preflightArgs, allowedAcknowledgements, normalizeAcks, preflightView },
  };
}

module.exports = { createAdapter, AdapterError, childEnv, defaultRunner, SESSION_NAME_RE };
