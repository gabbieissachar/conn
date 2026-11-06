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
const os = require('os');
const path = require('path');
const parse = require('./parse');
const { readClearMarks } = require('./handoff-runs');
const { scrub, findLeaks } = require('./text');
const { otherClaudeHomes } = require('../transcript-reader/claude-homes');

class AdapterError extends Error {
  constructor(message, status = 400, code = 'error') {
    super(scrub(message));
    this.status = status;
    this.code = code;
  }
}

const minutes = (ms) => Math.round(ms / 60000);
const VERIFY_TIMEOUT_MS = 900000;
const PREFLIGHT_TIMEOUT_MS = 600000;
// A working folder the page may show and turn into a cd command: absolute, one line, no control characters.
const FOLDER_PATH = /^\/[^\u0000-\u001f\u007f]{0,1023}$/;
const PANE_ID = /^[A-Za-z0-9:_-]{1,40}$/;
const AGENT_CLIENTS = new Set(['claude', 'codex']);
const SEAL_TIMEOUT_MS = 900000;

// A tool run that was killed for taking too long gets its own message, so a busy
// machine is not mistaken for a broken tool.
function timeoutError(what, ms) {
  return new AdapterError(what + ' did not finish within ' + minutes(ms) + ' minutes, so it was stopped. The machine is probably busy. Try again when it is quieter.', 504, 'timeout');
}

// How long a typed /clear counts as "Herdr may still report the old session" (R5-7).
const CLEAR_MARK_MS = 12 * 60 * 60 * 1000;
// A stopped session on this machine is literally named "-h", so a name must
// never be able to start with a dash and be read as an option.
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SESSIONS = 8;
const WORKSPACE_ID_RE = /^w[A-Za-z0-9]{1,10}$/;
const CLEANUP_CONCURRENCY = 4;
const BUNDLE_ID_RE = /^recovery-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{10}$/;
const PANE_ID_RE = /^(w[A-Za-z0-9]{1,10}):p[A-Za-z0-9]{1,10}$/;
const TAB_ID_RE = /^(w[A-Za-z0-9]{1,10}):t[A-Za-z0-9]{1,10}$/;
const SESSION_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CLIENTS = new Set(['claude', 'codex']);
// An identity check newer than this still tells the manual save what it knows about a
// pane: a pane it proved verified is never overwritten, and a pane it found unverified
// may be replaced without asking again. No check is needed to save.
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

// Dropping the HERDR_ variables is not enough to give `register` no current pane. Without HERDR_PANE_ID, Herdr's
// `pane current --current` still answers: it names the focused pane of the default session, and `register` then
// ignores the pane, workspace, tab and session it was given and records an identity for that pane instead (no
// Herdr session either). The page said "Saved" while the identity sat on a pane in another session, and a second
// save of the same id was refused as "already registered to another pane". A socket path that cannot exist makes
// `pane current` fail with server_not_running, which is what `register --allow-no-herdr` needs to use the explicit
// ids. A path below /dev/null can never be created, so no Herdr server can ever listen there.
const NO_CURRENT_PANE_SOCKET = '/dev/null/herdr-organizer-no-current-pane.sock';

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

function createAdapter({ toolRoot, runner = defaultRunner, env = process.env, pythonBin = 'python3', herdrBin = 'herdr', fmHome, gaugeScript, now = () => new Date(), homeDir = os.homedir() } = {}) {
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

  // Herdr call against one named session: read-only everywhere except focusTab, which only changes which tab the
  // attached client shows. When HERDR_LAB_HELPER is set, the isolated lab helper is the only route to Herdr, as the
  // organizer does.
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
    const result = await runner(pythonBin, [registryScript, 'verify-identity', '--herdr-session', session], { env: runEnv(), timeoutMs: VERIFY_TIMEOUT_MS });
    const report = parse.parseVerifierReport(result.stdout);
    if (report.rows.length === 0 && report.summary.total === null) {
      if (result.timedOut) throw timeoutError('The identity check', VERIFY_TIMEOUT_MS);
      throw new AdapterError(result.stderr || result.stdout || 'The identity verifier returned nothing (exit code ' + result.code + ').', 502, 'verifier_failed');
    }
    let panes = [];
    try { panes = await readPanes(session); } catch { panes = []; }
    const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
    const rows = report.rows.map((row) => {
      const pane = byId.get(row.pane_id);
      return {
        pane_id: row.pane_id,
        workspace_id: pane && WORKSPACE_ID_RE.test(pane.workspace_id) ? pane.workspace_id : '',
        tab_id: pane && TAB_ID_RE.test(pane.tab_id) ? pane.tab_id : '',
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
    const result = await runner(pythonBin, preflightArgs(sessions, acks, { preflightOnly: true }), { env: runEnv(), timeoutMs: PREFLIGHT_TIMEOUT_MS });
    const parsed = parse.parsePreflight(result.stdout);
    if (parsed.ready_to_seal === null) {
      if (result.timedOut) throw timeoutError('The preflight', PREFLIGHT_TIMEOUT_MS);
      throw new AdapterError(result.stderr || result.stdout || 'The preflight returned nothing (exit code ' + result.code + ').', 502, 'preflight_failed');
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
    const result = await runner(pythonBin, [registryScript, 'verify-identity', '--herdr-session', session, '--apply'], { env: runEnv(), timeoutMs: VERIFY_TIMEOUT_MS });
    const applied = parse.parseApplyResult(result.stdout);
    if (applied.written === null && result.timedOut) throw timeoutError('Applying the verified identities', VERIFY_TIMEOUT_MS);
    if (applied.written === null) throw new AdapterError(result.stderr || result.stdout || 'The apply step returned nothing.', 502, 'apply_failed');
    return { session, written: applied.written, skipped: applied.skipped, initially_verified: applied.initially_verified, applied_at: new Date().toISOString() };
  }

  const maskId = (id) => id.slice(0, 4) + '...' + id.slice(-4);

  // The one validator for the write path. Herdr's pane list is data from outside this
  // module, so before anything is written the pane must be listed exactly once, its
  // workspace, tab and pane ids must be well formed and belong together, and its folder
  // must be present, absolute, canonical, free of control characters and an existing
  // directory. The returned values are the normalized ones; the store check and the
  // registry write use these and never the raw pane list.
  async function validateLivePane(panes, paneId) {
    const matches = panes.filter((item) => item.pane_id === paneId);
    if (matches.length === 0) throw new AdapterError('That pane is no longer in the session.', 404, 'pane_missing');
    const invalid = () => new AdapterError('Herdr reported inconsistent details for that pane, so nothing was saved. Check the session again.', 409, 'pane_invalid');
    if (matches.length > 1) throw invalid();
    const pane = matches[0];
    const paneMatch = PANE_ID_RE.exec(pane.pane_id);
    const tabMatch = TAB_ID_RE.exec(pane.tab_id);
    if (!paneMatch || !tabMatch || !WORKSPACE_ID_RE.test(pane.workspace_id)) throw invalid();
    if (paneMatch[1] !== pane.workspace_id || tabMatch[1] !== pane.workspace_id) throw invalid();
    const cwd = pane.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096 || !path.isAbsolute(cwd)) throw invalid();
    if (/[\u0000-\u001f\u007f]/.test(cwd)) throw invalid();
    if (path.normalize(cwd) !== cwd || (cwd.length > 1 && cwd.endsWith('/'))) throw invalid();
    let real;
    try {
      real = await fsp.realpath(cwd);
      if (!(await fsp.stat(real)).isDirectory()) throw invalid();
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw invalid();
    }
    return { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id, agent: pane.agent, cwd: real };
  }

  // The id is validated in layers, cheapest first: format, present in the real
  // client store, the store's recorded folder matches the pane's folder (or the
  // override is sent), and not already claimed by another pane. It is never
  // logged, echoed or returned; the caller only gets a masked form.
  async function saveManualIdentity({ session: sessionName, pane_id: paneId, client, session_id: sessionId, folder_override: folderOverride, replace_existing: replaceExisting, confirm }) {
    const session = await requireSession(sessionName);
    if (typeof paneId !== 'string' || !PANE_ID_RE.test(paneId)) throw new AdapterError('Invalid pane.');
    requireConfirm(confirm, 'save:' + paneId);
    if (!CLIENTS.has(client)) throw new AdapterError('Pick Claude or Codex.');
    if (typeof sessionId !== 'string' || !SESSION_UUID_RE.test(sessionId)) throw new AdapterError('That does not look like a session id. Expected the 36-character form.', 400, 'invalid_session_id');
    const id = sessionId.toLowerCase();

    const panes = await readPanes(session);
    const pane = await validateLivePane(panes, paneId);
    if (pane.agent !== client) throw new AdapterError('That pane is running ' + (pane.agent || 'no supported agent') + ', not ' + client + '.', 409, 'client_mismatch');

    // The identity check is optional. When a recent one covers this pane it can only add information: a
    // verified pane is left alone, and a pane it found unverified needs no replace confirmation below.
    const seen = lastVerify.get(session);
    const fresh = seen && Date.now() - seen.at <= VERIFY_FRESH_MS && seen.verified.has(paneId);
    const knownUnverified = Boolean(fresh) && seen.verified.get(paneId) !== true;
    if (fresh && seen.verified.get(paneId) === true) throw new AdapterError('This pane already has a verified identity. Use Apply verified identities instead.', 409, 'already_verified');

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
    if (check.pane_registered_other && !knownUnverified && replaceExisting !== true) throw new AdapterError('This pane already has a different session registered. Confirm the replacement only if that one is wrong.', 409, 'pane_registered');
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
    ], { env: { ...runEnv(), HERDR_SOCKET_PATH: NO_CURRENT_PANE_SOCKET }, timeoutMs: 60000 });
    if (registered.code !== 0) throw new AdapterError('The registry refused the identity. ' + scrub(registered.stderr || registered.stdout, 160), 502, 'register_failed');
    // The tool reports the pane it recorded. When that is not the pane the user asked for, the write has landed on
    // another pane: say so and name it, so it can be removed, instead of showing "Saved" for this one.
    const landed = /^registered \S+ -> (\S+)\s*$/m.exec(registered.stdout || '');
    if (landed && landed[1] !== paneId) {
      throw new AdapterError('The registry recorded that identity for ' + scrub(landed[1], 40) + ' instead of ' + paneId + ', so this pane has no identity yet. Remove the wrong registration with herdr-agent-remove ' + scrub(landed[1], 40) + ', then save again.', 502, 'register_wrong_pane');
    }
    return { session, pane_id: paneId, client, masked_id: maskId(id), folder_confirmed: check.store_folder === 'match' ? 'match' : 'override', saved_at: new Date().toISOString() };
  }

  // Seals a private restart-recovery bundle through the tool's own command, which
  // re-runs the strict preflight itself and refuses on any failure.
  async function sealBundle(sessionNames, requestedAcks, confirm) {
    const sessions = await requireSessions(sessionNames);
    requireConfirm(confirm, 'seal:' + sessions.join(','));
    const acks = await validatedAcks(sessions, requestedAcks);
    const result = await runner(pythonBin, preflightArgs(sessions, acks, { preflightOnly: false }), { env: runEnv(), timeoutMs: SEAL_TIMEOUT_MS });
    const sealed = parse.parseSealResult(result.stdout);
    if (!sealed && result.timedOut) throw new AdapterError('Sealing did not finish within ' + minutes(SEAL_TIMEOUT_MS) + ' minutes and was stopped. Refresh the bundle list before trying again: a bundle is only usable once it shows as sealed.', 504, 'timeout');
    if (sealed) return { sealed: true, bundle_id: sealed.bundle_id, session_count: sealed.session_count, sealed_at: new Date().toISOString() };
    const preflightResult = parse.parsePreflight(result.stdout);
    if (preflightResult.ready_to_seal === false) throw new AdapterError('The preflight failed, so no bundle was sealed. Check again for the current failures.', 409, 'preflight_failed');
    throw new AdapterError(result.stderr || result.stdout || 'Sealing returned nothing.', 502, 'seal_failed');
  }

  // ---- After the restart: sealed bundles and the reconcile preview ----

  const toolState = (...parts) => path.join(toolRoot, 'state', 'workspace-organizer', ...parts);
  const bundleDir = () => toolState('restart-recovery', 'bundles');
  const journalDir = () => toolState('restart-recovery', 'journals');

  // Nothing under the bundle state is trusted unless every expected component is a
  // real directory or a regular file. lstat does not follow links, so a symlinked
  // bundle, manifest, marker or journal is refused instead of being read through.
  async function kindOf(file) {
    try {
      const stat = await fsp.lstat(file);
      if (stat.isSymbolicLink()) return 'unsafe';
      if (stat.isDirectory()) return 'dir';
      if (stat.isFile()) return 'file';
      return 'unsafe';
    } catch { return 'missing'; }
  }

  // 'ok' when every folder from the tool's state folder down to the bundle folder is a real
  // directory; 'missing' when the bundle state does not exist; 'unsafe' when any folder is a link.
  async function bundleChain() {
    let current = path.join(toolRoot, 'state');
    for (const part of ['', 'workspace-organizer', 'restart-recovery', 'bundles']) {
      current = part ? path.join(current, part) : current;
      const kind = await kindOf(current);
      if (kind === 'missing') return 'missing';
      if (kind !== 'dir') return 'unsafe';
    }
    return 'ok';
  }

  // One bundle checked against the live session list. It is compatible only when it
  // names at least one session, every member is well formed and distinct, none is the
  // default session, and Herdr knows every member. A member that is merely stopped
  // stays compatible: it is shown as not running, and the preview waits for it to be
  // attached. `live` is null when Herdr's session list could not be read.
  async function inspectBundle(id, { live, boot }) {
    const base = { bundle_id: id, created_at: '', ready: false, compatible: false, problem: '', sessions: [], before_boot: null, journal_status: '' };
    const chain = await bundleChain();
    if (chain === 'missing') return { ...base, problem: 'missing' };
    if (chain === 'unsafe') return { ...base, problem: 'unsafe_path' };
    const dir = path.join(bundleDir(), id);
    const dirKind = await kindOf(dir);
    if (dirKind === 'missing') return { ...base, problem: 'missing' };
    if (dirKind !== 'dir') return { ...base, problem: 'unsafe_path' };
    const manifestFile = path.join(dir, 'manifest.json');
    const manifestKind = await kindOf(manifestFile);
    if (manifestKind === 'missing') return { ...base, problem: 'missing' };
    if (manifestKind !== 'file') return { ...base, problem: 'unsafe_path' };
    const readyKind = await kindOf(path.join(dir, 'ready'));
    const journalsKind = await kindOf(journalDir());
    const journalFile = path.join(journalDir(), id + '.json');
    const journalKind = journalsKind === 'dir' ? await kindOf(journalFile) : journalsKind;
    if (readyKind === 'unsafe' || journalKind === 'unsafe') return { ...base, problem: 'unsafe_path' };

    let manifest = null;
    try { manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8')); } catch { manifest = null; }
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.sessions)) return { ...base, problem: 'malformed_manifest' };

    const names = [];
    let problem = '';
    for (const item of manifest.sessions) {
      const name = item && typeof item === 'object' && item.identity && typeof item.identity === 'object' ? item.identity.herdr_session : undefined;
      if (typeof name !== 'string' || !SESSION_NAME_RE.test(name) || names.includes(name)) problem = problem || 'malformed_member';
      else names.push(name);
    }
    if (!problem && names.length === 0) problem = 'no_members';
    if (!problem) {
      const known = new Map((live || []).map((item) => [item.name, item]));
      if (names.some((name) => name === 'default' || (known.get(name) && known.get(name).isDefault))) problem = 'default_session';
      else if (!live) problem = 'sessions_unavailable';
      else if (names.some((name) => !known.has(name))) problem = 'unknown_session';
    }

    const createdAt = typeof manifest.created_at === 'string' ? manifest.created_at : '';
    const created = Date.parse(createdAt);
    let journalStatus = '';
    if (journalKind === 'file') {
      try {
        const journal = JSON.parse(await fsp.readFile(journalFile, 'utf8'));
        journalStatus = journal && typeof journal.status === 'string' && /^[a-z_]{1,40}$/.test(journal.status) ? journal.status : 'unknown';
      } catch { journalStatus = 'unknown'; }
    }
    const running = new Set((live || []).filter((item) => item.running).map((item) => item.name));
    return {
      bundle_id: id,
      created_at: createdAt,
      ready: manifest.state === 'sealed' && readyKind === 'file',
      compatible: !problem,
      problem,
      // Members are only reported for a bundle that can be used.
      sessions: problem ? [] : names.map((name) => ({ name, running: running.has(name) })),
      // True once the computer has booted since the bundle was sealed.
      before_boot: Number.isFinite(created) ? created < boot : null,
      journal_status: journalStatus,
    };
  }

  async function liveSessionsOrNull() {
    try { return await listSessions(); } catch { return null; }
  }

  // Bundles on disk, newest first. Only the id, time, bundled session names, readiness
  // and compatibility are returned: a manifest also carries folders, which stay private.
  async function listBundles() {
    const boot = Date.now() - os.uptime() * 1000;
    const live = await liveSessionsOrNull();
    const bundles = [];
    if ((await bundleChain()) === 'ok') {
      let names = [];
      try { names = await fsp.readdir(bundleDir()); } catch { names = []; }
      for (const name of names.filter((item) => BUNDLE_ID_RE.test(item)).sort().reverse()) bundles.push(await inspectBundle(name, { live, boot }));
    }
    return { generated_at: new Date().toISOString(), boot_time: new Date(boot).toISOString(), bundles };
  }

  const BUNDLE_PROBLEM_TEXT = {
    unsafe_path: 'one of its files is a link or not a regular file',
    malformed_manifest: 'its manifest is malformed',
    malformed_member: 'it lists a malformed or repeated session',
    no_members: 'it lists no sessions',
    default_session: 'it includes the default session, which recovery does not support',
    unknown_session: 'it names a session Herdr does not know',
    sessions_unavailable: "Herdr's session list could not be read",
  };

  // Validates a bundle against the live session list right now and returns it, or throws.
  // Called by the preview immediately before it starts the tool.
  async function requirePreviewableBundle(bundleId) {
    const live = await listSessions();
    const bundle = await inspectBundle(bundleId, { live, boot: Date.now() - os.uptime() * 1000 });
    if (bundle.problem === 'missing' || (!bundle.problem && !bundle.ready)) throw new AdapterError('That bundle was not found or is not sealed.', 404, 'bundle_missing');
    if (bundle.problem) throw new AdapterError('That bundle cannot be used here: ' + (BUNDLE_PROBLEM_TEXT[bundle.problem] || 'it is not compatible') + '.', 409, 'bundle_incompatible');
    const notRunning = bundle.sessions.filter((item) => !item.running).map((item) => item.name);
    if (notRunning.length) throw new AdapterError('Attach ' + notRunning.join(', ') + ' in a terminal first. Recovery never starts a session for you.', 409, 'not_attached');
    return bundle;
  }

  // Read-only: `reconcile-all` without --confirm adopts nothing and creates no journal.
  // The confirm and rollback commands are built here from the validated id and copied by the user.
  async function reconcilePreview(bundleId) {
    if (typeof bundleId !== 'string' || !BUNDLE_ID_RE.test(bundleId)) throw new AdapterError('Invalid bundle.');
    // Validated against the live session list immediately before the tool starts.
    await requirePreviewableBundle(bundleId);
    const result = await runner(pythonBin, [organizerScript, 'reconcile-all', '--bundle', bundleId], { env: runEnv(), timeoutMs: 300000 });
    const sessions = result.code === 0 ? parse.parseReconcilePreview(result.stdout) : null;
    if (!sessions) throw new AdapterError(result.stderr || result.stdout || 'The reconcile preview returned nothing.', /not attached/i.test(result.stderr) ? 409 : 502, /not attached/i.test(result.stderr) ? 'not_attached' : 'preview_failed');
    const totals = sessions.reduce((sum, item) => ({ adopt: sum.adopt + item.adopt, rebuild: sum.rebuild + item.rebuild, ambiguous: sum.ambiguous + item.ambiguous, other: sum.other + item.other }), { adopt: 0, rebuild: 0, ambiguous: 0, other: 0 });
    const base = 'herdr-organizer reconcile-all --bundle ' + bundleId;
    return {
      bundle_id: bundleId,
      generated_at: new Date().toISOString(),
      sessions,
      totals,
      // Copy-only: these change live Herdr, so the page never runs them.
      commands: {
        confirm: base + ' --confirm ' + bundleId,
        confirm_resume: base + ' --confirm ' + bundleId + ' --resume-agents',
        confirm_extra_copy: totals.ambiguous ? base + ' --confirm ' + bundleId + ' --copy-ambiguous --confirm-extra copy:' + bundleId : '',
        rollback_preview: 'herdr-organizer rollback-reconcile --bundle ' + bundleId,
        rollback: 'herdr-organizer rollback-reconcile --bundle ' + bundleId + ' --confirm ' + bundleId,
      },
    };
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
    const workspaces = results.map((item) => (item.error ? { workspace_id: item.workspace_id, error: item.error, tabs_to_close: [], protected_tabs: [], kept_tab_id: '', kept_reason: '', close_workspace: false } : item));
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
        workspaces_to_close: closable.filter((item) => item.close_workspace).length,
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

  // Read-only preview of `archive-all` for one session: which live workspaces would be
  // archived and which are skipped, with reasons. The tool recomputes this itself when the
  // copied execute command runs, so a stale preview cannot archive anything it would refuse.
  // The page never runs the execute form. The commands are built here from the validated
  // session name only.
  async function archiveAllPreview(sessionName) {
    const session = await requireSession(sessionName);
    const result = await runner(pythonBin, [organizerScript, '--session', session, 'archive-all'], { env: runEnv(), timeoutMs: 180000 });
    if (result.timedOut) throw timeoutError('The archive preview', 180000);
    // An older copy of the organizer (this command lives in the personal project) rejects the subcommand.
    if (result.code !== 0 && /invalid choice: '?archive-all|unrecognized arguments: archive-all/.test(String(result.stderr))) {
      throw new AdapterError('The organizer tool on this machine does not have archive-all yet. Update personal/01-System/setup/herdr/workspace-organizer.py, then preview again.', 501, 'tool_outdated');
    }
    const preview = result.code === 0 ? parse.parseArchiveAllPreview(result.stdout) : null;
    if (!preview || preview.session !== session) throw new AdapterError(scrub(result.stderr || result.stdout || 'The archive preview failed.'), 502, 'archive_preview_failed');
    const base = 'herdr-organizer --session ' + session + ' archive-all';
    return {
      session,
      generated_at: new Date().toISOString(),
      to_archive: preview.to_archive,
      skipped: preview.skipped,
      totals: { workspaces: preview.to_archive.length + preview.skipped.length + preview.omitted, to_archive: preview.to_archive.length, skipped: preview.skipped.length, omitted: preview.omitted },
      // Copy-only. Archiving closes workspaces, so the page never runs the execute form. The snapshot form closes nothing
      // and also takes a workspace with a working agent, so it is offered whenever something could be saved.
      commands: {
        preview: base,
        execute: preview.to_archive.length ? base + ' --execute --confirm ' + session : '',
        snapshot_preview: base + ' --snapshot',
        snapshot: preview.to_archive.length || preview.skipped.some((item) => item.reasons.includes('active_agent')) ? base + ' --snapshot --execute --confirm ' + session : '',
      },
    };
  }

  // The snapshot file the Workspaces and Archives views read. It is read from the
  // tool root (so an isolated copy of the tools is honoured) and refused if it
  // carries anything that looks private.
  async function readSnapshot() {
    const file = path.join(toolRoot, 'state', 'workspace-organizer', 'live-snapshot.json');
    const kind = await kindOf(file);
    if (kind === 'unsafe') throw new AdapterError('The snapshot is a link or not a regular file, so it was not shown.', 502, 'snapshot_invalid');
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch { throw new AdapterError('No snapshot yet. Refresh the snapshot first.', 404, 'no_snapshot'); }
    if (raw.length > 4 * 1024 * 1024) throw new AdapterError('The snapshot is too large to show.', 502, 'snapshot_invalid');
    let snapshot;
    try { snapshot = JSON.parse(raw); } catch { throw new AdapterError('The snapshot file is not valid JSON.', 502, 'snapshot_invalid'); }
    // Two tab fields are meant to carry a value the scan would otherwise block: working folders (a local path, so the user
    // can cd into it) and agent sessions (a client session id, so the user can copy it). Each is validated on its own and
    // left out of the scan that guards everything else.
    const kept = [];
    for (const workspace of Array.isArray(snapshot && snapshot.workspaces) ? snapshot.workspaces : []) {
      for (const tab of Array.isArray(workspace && workspace.tabs) ? workspace.tabs : []) {
        if (!tab || typeof tab !== 'object') continue;
        const entry = { tab };
        if ('working_folders' in tab) {
          const list = Array.isArray(tab.working_folders) ? tab.working_folders : [];
          const valid = list.filter((item) => item && typeof item.path === 'string' && FOLDER_PATH.test(item.path)
            && Array.isArray(item.pane_ids) && item.pane_ids.every((id) => typeof id === 'string' && PANE_ID.test(id)));
          entry.folders = valid.map((item) => ({ path: item.path, source: item.source === 'agent_files' ? 'agent_files' : 'pane', pane_ids: item.pane_ids.slice() }));
          tab.working_folders = [];
        }
        if ('agent_sessions' in tab) {
          const list = Array.isArray(tab.agent_sessions) ? tab.agent_sessions : [];
          entry.sessions = list
            .filter((item) => item && typeof item.pane_id === 'string' && PANE_ID.test(item.pane_id)
              && AGENT_CLIENTS.has(item.client) && typeof item.session_id === 'string' && SESSION_UUID_RE.test(item.session_id))
            .map((item) => ({ pane_id: item.pane_id, client: item.client, session_id: item.session_id }));
          tab.agent_sessions = [];
        }
        kept.push(entry);
      }
    }
    // A folder may be a local path, but not a client session id, a socket, a bundle id or a resume command.
    const folderLeaks = kept.some((entry) => (entry.folders || []).some((item) => findLeaks(item.path).some((kind) => kind !== 'private-path')));
    if (folderLeaks || findLeaks(JSON.stringify(snapshot)).length) throw new AdapterError('The snapshot contains private values and was not shown.', 502, 'snapshot_invalid');
    for (const entry of kept) {
      if (entry.folders) entry.tab.working_folders = entry.folders;
      if (entry.sessions) entry.tab.agent_sessions = entry.sessions;
    }
    // When the computer last started, so the page can tell a snapshot taken before a restart from one taken after it.
    snapshot.boot_time = new Date(Date.now() - os.uptime() * 1000).toISOString();
    return snapshot;
  }

  // Context gauge: one read of the firstmate gauge (read-only, `fm-ctx-gauge.sh report --json`)
  // joined to the live panes of every running non-default session, so each row names the
  // tab to restart. The first-mate home and gauge script are fixed at construction; the
  // browser sends nothing. Only the first eight characters of a session id leave the server.
  const CONTEXT_WARN_PERCENT = 18;
  const CONTEXT_HIGH_PERCENT = 25;
  const GAUGE_TIMEOUT_MS = 120000;
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  // Leader-space audit: the convention says one workspace, `leader-space`, holding one tab per identity below, and a
  // label exists at most once. Read-only; it reports and never moves or closes anything. The same rule is enforced on
  // restore by the organizer tool (leader_restore_problems in workspace-organizer.py).
  const LEADER_WORKSPACE = 'leader-space';
  const LEADER_LABELS = ['big-boss', 'leader-esim', 'leader-workspaceos', 'leader-nip', 'leader-fleet-watch', 'leader-personal-work'];

  async function leaderSpace() {
    const sessions = (await listSessions()).filter((item) => item.running && !item.isDefault && SESSION_NAME_RE.test(item.name));
    const found = [];
    for (const session of sessions) {
      const [panesResult, workspacesResult] = await Promise.all([
        herdrCall(session.name, ['pane', 'list'], { timeoutMs: 20000 }).catch(() => null),
        herdrCall(session.name, ['workspace', 'list'], { timeoutMs: 20000 }).catch(() => null),
      ]);
      const panes = panesResult && panesResult.code === 0 ? parse.parseLabelledPanes(panesResult.stdout) : null;
      const workspaces = workspacesResult && workspacesResult.code === 0 ? parse.parseWorkspaceLabels(workspacesResult.stdout) : null;
      for (const pane of panes || []) {
        found.push({ label: pane.label, herdr_session: session.name, pane_id: pane.pane_id, id: pane.session_prefix, agent_status: pane.agent_status, in_leader_space: workspaces ? workspaces.get(pane.workspace_id) === LEADER_WORKSPACE : null });
      }
    }
    const rows = LEADER_LABELS.map((label) => {
      const panes = found.filter((item) => item.label === label).map(({ label: _label, ...rest }) => rest);
      let state = 'ok';
      if (panes.length === 0) state = 'missing';
      else if (panes.length > 1) state = 'duplicate';
      else if (panes[0].in_leader_space === false) state = 'elsewhere';
      return { label, state, panes };
    });
    const unexpected = found.filter((item) => item.label.startsWith('leader-') && !LEADER_LABELS.includes(item.label)).map(({ label, herdr_session: session, pane_id: paneId }) => ({ label, herdr_session: session, pane_id: paneId }));
    return { workspace: LEADER_WORKSPACE, rows, unexpected };
  }

  // View only: shows one session's tab in the Herdr window the user has attached, so a row of the Context tab can
  // be opened to check on it. It types nothing into a pane, closes nothing and writes no record, and a second click
  // is the same as the first. The browser names a session, a pane id and the first 8 characters of the session id the
  // row showed; the tab comes from the live pane list and is never taken from the browser. A row can be minutes old
  // and Herdr hands a pane id out again after a close, so the pane found must still run the row's session.
  const SESSION_PREFIX_RE = /^[A-Za-z0-9_-]{8}$/;
  async function focusTab(sessionName, paneId, sessionPrefix) {
    const session = await requireSession(sessionName);
    if (typeof paneId !== 'string' || !PANE_ID_RE.test(paneId)) throw new AdapterError('Invalid pane.');
    if (typeof sessionPrefix !== 'string' || !SESSION_PREFIX_RE.test(sessionPrefix)) throw new AdapterError('Invalid session.');
    const pane = (await readPanes(session)).find((item) => item.pane_id === paneId);
    if (!pane || !TAB_ID_RE.test(pane.tab_id)) throw new AdapterError('That session is not open any more. Refresh the list.', 404, 'pane_gone');
    if (!pane.agent_session_id.startsWith(sessionPrefix)) throw new AdapterError('That pane runs another session now. Refresh the list.', 409, 'session_moved');
    const result = await herdrCall(session, ['tab', 'focus', pane.tab_id], { timeoutMs: 15000 });
    if (result.code !== 0) throw new AdapterError('Herdr could not show that tab.', 502, 'herdr_unavailable');
    return { herdr_session: session, tab_id: pane.tab_id };
  }

  // Copy-only "send a handoff request" command for the sessions the user ticked. Nothing is sent here. A leader
  // identity is re-read from the audit and kept only with exactly one live pane inside leader-space. Any other session
  // is a `<herdr session>|<pane id>|<first 8 characters of its session id>` reference that must name a live Claude pane
  // of a running session that still runs that session, so a stale, reused or invented reference is skipped. The command is built from validated session names and pane ids with fixed text;
  // the browser never supplies any. Only a leader is told to persist its handoff in its own home folder, since any
  // other session (a crewmate in a task worktree) has no home of its own and the handoff skill picks the place.
  const HANDOFF_REQUEST = '/handoff to restart this session with cleaner context. Persist the handoff doc in your own home folder.';
  const HANDOFF_REQUEST_OTHER = '/handoff to restart this session with cleaner context.';
  const PANE_REF_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\|(w[A-Za-z0-9]{1,10}:p[A-Za-z0-9]{1,10})\|([A-Za-z0-9_-]{8})$/;
  const sendLine = (item, request) => `herdr --session ${item.herdr_session} pane send-text ${item.pane_id} '${request}' && herdr --session ${item.herdr_session} pane send-keys ${item.pane_id} Enter`;

  async function handoffCommand(labels = [], panes = []) {
    if (!Array.isArray(labels) || !Array.isArray(panes) || labels.length + panes.length === 0
      || labels.some((label) => typeof label !== 'string' || !LEADER_LABELS.includes(label))
      || panes.some((ref) => typeof ref !== 'string' || !PANE_REF_RE.test(ref))) {
      throw new AdapterError('Pick one or more sessions.');
    }
    const ready = [];
    const skipped = [];
    const lines = [];
    const taken = new Set();
    if (labels.length) {
      const { rows } = await leaderSpace();
      for (const label of new Set(labels)) {
        const row = rows.find((item) => item.label === label);
        const pane = row && row.state === 'ok' ? row.panes[0] : null;
        if (pane && PANE_ID_RE.test(pane.pane_id) && SESSION_NAME_RE.test(pane.herdr_session)) {
          const item = { label, herdr_session: pane.herdr_session, pane_id: pane.pane_id };
          ready.push(item);
          lines.push(sendLine(item, HANDOFF_REQUEST));
          taken.add(`${item.herdr_session}|${item.pane_id}`);
        } else skipped.push({ label, state: row ? row.state : 'missing' });
      }
    }
    if (panes.length) {
      const running = new Set((await listSessions()).filter((item) => item.running && !item.isDefault && SESSION_NAME_RE.test(item.name)).map((item) => item.name));
      const live = new Map();
      for (const ref of new Set(panes)) {
        const [, session, paneId, prefix] = PANE_REF_RE.exec(ref);
        if (taken.has(`${session}|${paneId}`)) continue;
        if (!running.has(session)) { skipped.push({ label: paneId, state: 'session not running' }); continue; }
        if (!live.has(session)) {
          const result = await herdrCall(session, ['pane', 'list'], { timeoutMs: 20000 }).catch(() => null);
          live.set(session, result && result.code === 0 ? parse.parseAgentPanes(result.stdout) : null);
        }
        const pane = (live.get(session) || []).find((item) => item.pane_id === paneId && item.agent === 'claude');
        if (!pane) { skipped.push({ label: paneId, state: 'no live Claude pane' }); continue; }
        if (!pane.agent_session_id.startsWith(prefix)) { skipped.push({ label: paneId, state: 'runs another session now' }); continue; }
        const item = { label: pane.label || '', herdr_session: session, pane_id: paneId };
        ready.push(item);
        lines.push(sendLine(item, HANDOFF_REQUEST_OTHER));
      }
    }
    return { text: HANDOFF_REQUEST, other_text: HANDOFF_REQUEST_OTHER, ready, skipped, command: lines.length ? lines.join('\n') : null };
  }

  // Copy-only "ask for a handoff, clear and resume" command (`workspace-organizer.py handoff-restart`) for the ordinary
  // Claude sessions the user ticked. Nothing is sent here and the page never runs it. A reference is
  // `<herdr session>|<pane id>|<first 8 characters of its session id>`. It is kept only when a running session has a live
  // Claude pane that still runs that session and the gauge calls the row an ordinary session (every firstmate, second
  // mate, crewmate and primary row is another kind). The command's own step 0 decides again when it runs, so this is a
  // cheap pre-filter. One command per Herdr session, built from validated values with the fixed confirm string and no
  // home paths or other flags.
  const RESTART_REF_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\|(w[A-Za-z0-9]{1,10}:p[A-Za-z0-9]{1,10})\|([A-Za-z0-9-]{8})$/;

  async function handoffRestartCommand(panes = []) {
    if (!Array.isArray(panes) || panes.length === 0 || panes.some((ref) => typeof ref !== 'string' || !RESTART_REF_RE.test(ref))) {
      throw new AdapterError('Pick one or more sessions.');
    }
    const refs = [...new Set(panes)].map((ref) => RESTART_REF_RE.exec(ref));
    const [{ rows }, sessions] = await Promise.all([contextGauge(), listSessions()]);
    const running = new Set(sessions.filter((item) => item.running && !item.isDefault && SESSION_NAME_RE.test(item.name)).map((item) => item.name));
    const kinds = new Map(rows.filter((row) => row.herdr_session && row.pane_id).map((row) => [`${row.herdr_session}|${row.pane_id}|${row.id}`, row.kind]));
    const live = new Map();
    const bySession = new Map();
    const ready = [];
    const skipped = [];
    for (const [, session, paneId, prefix] of refs) {
      if (!running.has(session)) { skipped.push({ label: paneId, state: 'session not running' }); continue; }
      if (!live.has(session)) {
        const result = await herdrCall(session, ['pane', 'list'], { timeoutMs: 20000 }).catch(() => null);
        live.set(session, result && result.code === 0 ? parse.parseAgentPanes(result.stdout) : null);
      }
      const pane = (live.get(session) || []).find((item) => item.pane_id === paneId && item.agent === 'claude');
      if (!pane) { skipped.push({ label: paneId, state: 'no live Claude pane' }); continue; }
      if (!pane.agent_session_id.startsWith(prefix)) { skipped.push({ label: paneId, state: 'runs another session now' }); continue; }
      const label = pane.label || paneId;
      if (kinds.get(`${session}|${paneId}|${prefix}`) !== 'session') { skipped.push({ label, state: 'a firstmate session, or one the gauge cannot name' }); continue; }
      ready.push({ label: pane.label || '', herdr_session: session, pane_id: paneId, id: prefix });
      if (!bySession.has(session)) bySession.set(session, []);
      bySession.get(session).push({ paneId, prefix });
    }
    const lines = [...bySession].map(([session, items]) => {
      const ids = [...new Set(items.map((item) => item.prefix))].sort();
      return `herdr-organizer --session ${session} handoff-restart ${items.map((item) => `--pane ${item.paneId}:${item.prefix}`).join(' ')} --execute --confirm handoff-restart:${session}:${ids.join(',')}`;
    });
    return { ready, skipped, command: lines.length ? lines.join('\n') : null };
  }

  // Herdr names the session a pane really runs; the gauge names the newest session it has a record for, and a
  // session restarted without the gauge's statusline wiring leaves that record pointing at the one it replaced. So
  // a live Claude pane the gauge has no usable row for is read from its own transcript, the same newest main-thread
  // usage line the gauge reads, and the replaced session's row is dropped.
  const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
  const LARGE_WINDOW = 1000000;
  // A transcript records tokens but not the window size. The user's decision (2026-10-21) is to assume every
  // session has the 1M window, so a count with no statusline percent is read against it and marked estimated.
  const assumedPercent = (tokens) => Math.round((tokens * 1000) / LARGE_WINDOW) / 10;

  // The Claude config folders a pane may run under: the organizer's own CLAUDE_CONFIG_DIR, ~/.claude, and every other one on
  // this machine (a second account such as ~/.claude-personal: the transcript reader's otherClaudeHomes, so both look in the same
  // places). Herdr names a pane's session id but not the folder its log is in, and the next look finds an account set up later.
  function claudeRoots() {
    return [...new Set([env.CLAUDE_CONFIG_DIR, path.join(homeDir, '.claude'), ...otherClaudeHomes({ homeDir, env })].filter(Boolean).map((root) => path.resolve(root)))];
  }

  // The newest of several logs with the same name, the one a running session keeps writing; the first folder wins a tie.
  const newestLog = (found) => found.reduce((best, item) => (!best || item.mtimeMs > best.mtimeMs ? item : best), null);

  async function claudeTranscript(sessionId) {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    const found = [];
    for (const root of claudeRoots()) {
      let dirs;
      try { dirs = await fsp.readdir(path.join(root, 'projects')); } catch { continue; }
      for (const dir of dirs) {
        const file = path.join(root, 'projects', dir, `${sessionId}.jsonl`);
        try {
          const info = await fsp.stat(file);
          if (info.isFile()) found.push({ file, mtimeMs: info.mtimeMs });
        } catch { /* not in this project folder */ }
      }
    }
    const newest = newestLog(found);
    return newest ? newest.file : null;
  }

  // Input-side tokens of the newest main-thread usage line, read from the end of the file in growing steps. A
  // compaction after that line makes the count unknown, as in the gauge.
  async function transcriptUsage(file) {
    let handle;
    try {
      handle = await fsp.open(file, 'r');
      const { size } = await handle.stat();
      for (const bytes of [262144, 4194304, 33554432]) {
        const length = Math.min(size, bytes);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const lines = buffer.toString('utf8').split('\n');
        if (size > length) lines.shift();
        let last = null;
        for (const line of lines) {
          let item;
          try { item = JSON.parse(line); } catch { continue; }
          if (!item || typeof item !== 'object') continue;
          if (item.type === 'system' && item.subtype === 'compact_boundary') { last = { compact: true }; continue; }
          const usage = item.message && item.message.usage;
          if (item.type !== 'assistant' || item.isSidechain === true || item.isApiErrorMessage === true || !usage || typeof usage !== 'object' || item.message.model === '<synthetic>') continue;
          const tokens = (number(usage.input_tokens) || 0) + (number(usage.cache_creation_input_tokens) || 0) + (number(usage.cache_read_input_tokens) || 0);
          if (tokens > 0) last = { tokens, at: Date.parse(item.timestamp) };
        }
        if (last) return last.compact ? { tokens: null, at: null } : { tokens: last.tokens, at: Number.isFinite(last.at) ? last.at : null };
        if (size <= length) break;
      }
    } catch { /* an unreadable transcript is an unknown count */ } finally {
      if (handle) await handle.close().catch(() => {});
    }
    return { tokens: null, at: null };
  }

  async function paneRow(pane) {
    const file = await claudeTranscript(pane.agent_session_id);
    if (!file) return null;
    const { tokens, at } = await transcriptUsage(file);
    const percent = tokens !== null ? assumedPercent(tokens) : null;
    return {
      id: pane.agent_session_id.slice(0, 8),
      map: pane.label || pane.title || pane.pane_id,
      kind: 'session',
      percent,
      tokens,
      estimated: true,
      busy: pane.agent_status === 'idle' || pane.agent_status === 'done' ? 'idle' : pane.agent_status === 'working' ? 'busy' : 'unknown',
      age_s: at === null ? null : Math.max(0, Math.round((Date.now() - at) / 1000)),
      herdr_session: pane.herdr_session,
      pane_id: pane.pane_id,
      title: pane.title,
      tab_label: pane.tab_label,
      cwds: pane.cwds,
    };
  }

  // The context an archived Claude session had when it last ran, for the Archive group tab. The page only knows the first
  // 8 characters of each session id (the gauge shows the same), so one pass over the transcript folders finds the files
  // whose name starts with a requested prefix. A session with no transcript, or one compacted after its last usage line,
  // simply has no row.
  const ARCHIVE_PREFIX_RE = /^[A-Za-z0-9_-]{8}$/;
  async function archiveContext(prefixes = []) {
    const wanted = [...new Set((Array.isArray(prefixes) ? prefixes : []).filter((item) => typeof item === 'string' && ARCHIVE_PREFIX_RE.test(item)))].slice(0, 64);
    if (!wanted.length) return { rows: [] };
    const found = new Map();
    for (const root of claudeRoots()) {
      let dirs;
      try { dirs = await fsp.readdir(path.join(root, 'projects')); } catch { continue; }
      for (const dir of dirs) {
        let names;
        try { names = await fsp.readdir(path.join(root, 'projects', dir)); } catch { continue; }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue;
          const prefix = name.slice(0, 8);
          if (!wanted.includes(prefix)) continue;
          const file = path.join(root, 'projects', dir, name);
          let info;
          try { info = await fsp.stat(file); } catch { continue; }
          if (!found.has(prefix)) found.set(prefix, []);
          found.get(prefix).push({ file, mtimeMs: info.mtimeMs });
        }
      }
    }
    const rows = [];
    for (const [id, candidates] of found) {
      const file = newestLog(candidates).file;
      const { tokens, at } = await transcriptUsage(file);
      if (tokens === null) continue;
      rows.push({ id, percent: assumedPercent(tokens), tokens, estimated: true, age_s: at === null ? null : Math.max(0, Math.round((Date.now() - at) / 1000)) });
    }
    return { rows };
  }

  function contextGauge() {
    return singleFlight('context-gauge', async () => {
      if (!fmHome || !gaugeScript) throw new AdapterError('The context gauge is not configured.', 501, 'gauge_unconfigured');
      const [gauge, sessions] = await Promise.all([
        runner('bash', [gaugeScript, 'report', '--json'], { env: { ...runEnv(), FM_HOME: fmHome }, timeoutMs: GAUGE_TIMEOUT_MS }),
        listSessions(),
      ]);
      if (gauge.code !== 0) throw new AdapterError('The context gauge could not be read.', 502, 'gauge_unavailable');
      const where = new Map();
      for (const session of sessions.filter((item) => item.running && !item.isDefault && SESSION_NAME_RE.test(item.name))) {
        let panes = null;
        let tabLabels = new Map();
        try {
          const result = await herdrCall(session.name, ['pane', 'list'], { timeoutMs: 20000 });
          panes = result.code === 0 ? parse.parseAgentPanes(result.stdout) : null;
        } catch { /* a session that cannot be read just has no pane column */ }
        try {
          const result = await herdrCall(session.name, ['tab', 'list'], { timeoutMs: 20000 });
          tabLabels = (result.code === 0 && parse.parseTabLabels(result.stdout)) || tabLabels;
        } catch { /* without tab labels a row keeps the gauge's own name */ }
        for (const pane of panes || []) where.set(pane.agent_session_id, { ...pane, tab_label: tabLabels.get(pane.tab_id) || null, herdr_session: session.name });
      }
      const rows = [];
      const homes = new Map();
      const seen = new Set();
      const unread = new Map();
      for (const line of gauge.stdout.split('\n')) {
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (!item || typeof item.session_id !== 'string' || item.current === false) continue;
        const pane = where.get(item.session_id);
        const busy = text(item.busy, 40).split(' ')[0];
        const percent = number(item.percent) === null ? null : Math.round(item.percent * 10) / 10;
        const row = {
          id: item.session_id.slice(0, 8),
          map: text(item.map, 120),
          kind: text(item.kind, 20),
          percent,
          tokens: number(item.input_tokens),
          estimated: item.source !== 'statusline' || item.window_inferred === true,
          busy: busy === 'idle' || busy === 'busy' ? busy : 'unknown',
          age_s: number(item.age_s),
          herdr_session: pane ? pane.herdr_session : null,
          pane_id: pane ? pane.pane_id : null,
          title: pane ? pane.title : null,
          tab_label: pane ? pane.tab_label : null,
        };
        // A live Claude pane on a session the gauge has no percent for is read from its own transcript below.
        if (pane && percent === null && pane.agent === 'claude') unread.set(item.session_id, row);
        else { rows.push(row); seen.add(item.session_id); }
        for (const key of [item.home, item.worktree]) if (typeof key === 'string' && key) homes.set(key, row);
      }
      const fromPanes = (await Promise.all([...where.values()].filter((pane) => pane.agent === 'claude' && !seen.has(pane.agent_session_id)).map(paneRow))).filter(Boolean);
      const read = new Set(fromPanes.map((row) => row.pane_id));
      for (const [sessionId, row] of unread) if (!read.has(row.pane_id)) rows.push(row);
      // A row for a session no pane runs any more is dropped when a live pane now runs in the same home or worktree.
      const replaced = new Set();
      for (const row of fromPanes) for (const cwd of row.cwds) if (homes.has(cwd) && !homes.get(cwd).pane_id) replaced.add(homes.get(cwd));
      const shown = [...rows.filter((row) => !replaced.has(row)), ...fromPanes.map(({ cwds: _cwds, ...row }) => row)]
        .map((row) => (row.percent === null && row.tokens !== null ? { ...row, percent: assumedPercent(row.tokens), estimated: true } : row));
      shown.sort((a, b) => (b.percent === null ? -1 : b.percent) - (a.percent === null ? -1 : a.percent));
      // A pane that had /clear typed into it by `handoff-restart` and that Herdr still reports under the session id it had
      // before. The record's own contents stay here: the row gets the time, the run id the page keys a dismissal by, and
      // whether the clear is under 12 hours old (R5-7).
      const marks = await readClearMarks(toolRoot).catch(() => new Map());
      for (const row of shown) {
        const mark = row.herdr_session && row.pane_id ? marks.get(`${row.herdr_session}|${row.pane_id}|${row.id}`) : null;
        if (mark) Object.assign(row, { cleared_at: new Date(mark.at).toISOString(), cleared_run: mark.run, still_old_id: now().getTime() - mark.at < CLEAR_MARK_MS });
      }
      return { thresholds: { warn: CONTEXT_WARN_PERCENT, high: CONTEXT_HIGH_PERCENT }, rows: shown };
    });
  }

  // Claude plan usage: one read-only `quota-axi --provider claude --full --json` call (the three windows the Context tab
  // shows, nothing else). The browser sends only a `fresh` flag; without it quota-axi may reuse a reading under a
  // minute old, so a page reload does not ask the vendor again. quota-axi runs on whichever `node` is first on PATH,
  // and a Node build whose bundled certificates cannot verify the vendor fails every request with "fetch failed",
  // so the macOS certificate bundle is added for this call when the caller has not set one. Only percentages, reset
  // times and pace leave the server; the account, plan and credential evidence quota-axi holds do not.
  const PLAN_WINDOWS = [
    { id: 'five_hour', label: 'Current session' },
    { id: 'seven_day', label: 'Current week' },
    { id: 'model:fable', label: 'Current week (Fable)' },
  ];
  const PLAN_TIMEOUT_MS = 60000;
  const PLAN_CA_BUNDLE = '/etc/ssl/cert.pem';
  const PLAN_PACE = new Set(['behind', 'on_pace', 'ahead', 'unknown']);
  const planTime = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);

  function planUsage(fresh = false) {
    return singleFlight(fresh ? 'plan-usage-fresh' : 'plan-usage', async () => {
      const callEnv = runEnv();
      if (!callEnv.NODE_EXTRA_CA_CERTS && await fsp.access(PLAN_CA_BUNDLE).then(() => true, () => false)) callEnv.NODE_EXTRA_CA_CERTS = PLAN_CA_BUNDLE;
      // --full is what carries percent used, elapsed percent and the run-out projection; the default report omits them.
      // --no-credential-refresh keeps this tier 0 read from letting quota-axi renew (rewrite) the Claude login through the vendor CLI.
      const args = ['--provider', 'claude', '--full', '--json', '--no-credential-refresh', ...(fresh ? [] : ['--max-age', '1m'])];
      const result = await runner('quota-axi', args, { env: callEnv, timeoutMs: PLAN_TIMEOUT_MS });
      let provider = null;
      try { provider = (JSON.parse(result.stdout).providers || []).find((item) => item && item.provider === 'claude') || null; } catch { /* no usable report */ }
      if (!provider) throw new AdapterError('Claude plan usage could not be read. Is quota-axi installed and on PATH?', 502, 'plan_unavailable');
      const reported = new Map((Array.isArray(provider.windows) ? provider.windows : []).filter((item) => item && typeof item.id === 'string').map((item) => [item.id, item]));
      const state = provider.state && typeof provider.state === 'object' ? provider.state : {};
      if (state.status === 'stale' || state.stale === true) {
        // quota-axi serves its last cached windows when the vendor read fails; those are old numbers, never shown as current.
        throw new AdapterError('Claude plan usage is stale: quota-axi could only return an old reading. Refresh to try again.', 502, 'plan_unavailable');
      }
      if (!PLAN_WINDOWS.some((item) => reported.has(item.id))) {
        const attempts = Array.isArray(provider.attempts) ? provider.attempts : [];
        if (state.status === 'auth_required' || attempts.some((item) => item && item.error === 'keychain_access_required')) {
          throw new AdapterError('Claude plan usage needs a one-time Keychain approval. Run quota-axi --allow-keychain-prompt in a terminal, choose Always Allow, then refresh.', 502, 'plan_needs_approval');
        }
        throw new AdapterError(`Claude plan usage could not be read (${text(state.error, 60).replace(/[^A-Za-z0-9_ .:-]/g, '') || 'no windows reported'}).`, 502, 'plan_unavailable');
      }
      const windows = PLAN_WINDOWS.map(({ id, label }) => {
        const item = reported.get(id);
        const pace = item && item.pace && typeof item.pace === 'object' ? item.pace : {};
        const percent = item ? number(item.percentUsed) : null;
        const elapsed = number(pace.elapsedPercent);
        return {
          id,
          label,
          percent_used: percent === null ? null : Math.round(percent * 10) / 10,
          resets_at: item ? planTime(item.resetsAt) : null,
          elapsed_percent: elapsed === null ? null : Math.round(elapsed * 10) / 10,
          pace: PLAN_PACE.has(pace.status) ? pace.status : 'unknown',
          projected_exhausted_at: planTime(pace.projectedExhaustedAt),
        };
      });
      return { windows, read_at: planTime(state.refreshedAt) };
    });
  }

  // Codex credits: week to date and month to date, summed from the per-day, per-model credit usage the ChatGPT backend
  // keeps for the signed-in Codex account (the endpoint behind Codex's own credit view; the sibling
  // daily-token-usage-breakdown reports percent of an allowance under a field named credits, which is not credits). The
  // dollar figure is credits times a fixed rate. It is read-only:
  // the access token is read from Codex's auth file and never renewed here, and it goes to curl on stdin, never on a
  // command line, so it cannot show in a process list. Only the sums, the dates and the model names leave the server.
  // The week starts Monday and the month on the 1st, in this machine's local calendar; the backend's day boundary is
  // its own, so a reading near midnight can be a day off.
  const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage/daily-workspace-user-credit-usage';
  const CODEX_USD_PER_CREDIT = 0.04;
  // The monthly credit limit the Month chip reads against; it sits beside the rate so the page holds no number of its own.
  const CODEX_MONTH_LIMIT = 3000;
  const CODEX_TIMEOUT_MS = 30000;
  const TOKEN_SHAPE = /^[A-Za-z0-9._-]{1,8192}$/;
  const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const round2 = (value) => Math.round(value * 100) / 100;

  function codexCredits() {
    return singleFlight('codex-credits', async () => {
      const authFile = path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), 'auth.json');
      let tokens = null;
      try { tokens = JSON.parse(await fsp.readFile(authFile, 'utf8')).tokens; } catch { /* not signed in */ }
      const token = tokens && typeof tokens.access_token === 'string' ? tokens.access_token : '';
      const account = tokens && typeof tokens.account_id === 'string' ? tokens.account_id : '';
      if (!TOKEN_SHAPE.test(token) || !TOKEN_SHAPE.test(account)) {
        throw new AdapterError('Codex credits need a Codex sign-in on this machine. Run codex login, then refresh.', 502, 'codex_unavailable');
      }
      // An inclusive UTC date range, as Codex's own client sends it, broken down by model, from the earlier of the week and
      // month starts to whichever of the local and UTC days is later.
      const today = now();
      const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
      const since = { week: localDay(weekStart), month: `${localDay(today).slice(0, 8)}01` };
      const utcToday = today.toISOString().slice(0, 10);
      const query = new URLSearchParams({ start_date: since.week < since.month ? since.week : since.month, end_date: localDay(today) > utcToday ? localDay(today) : utcToday, breakdown: 'model' });
      const config = [`url = "${CODEX_USAGE_URL}?${query}"`, `header = "Authorization: Bearer ${token}"`, `header = "chatgpt-account-id: ${account}"`, 'silent', `max-time = ${CODEX_TIMEOUT_MS / 1000 - 5}`, 'write-out = "\\n%{http_code}"'].join('\n');
      const result = await runner('curl', ['-K', '-'], { env: runEnv(), timeoutMs: CODEX_TIMEOUT_MS, input: config });
      const cut = result.stdout.lastIndexOf('\n');
      const status = Number(result.stdout.slice(cut + 1));
      if (result.code !== 0 || !Number.isInteger(status)) throw new AdapterError('Codex credits could not be read. Is curl installed and the network up?', 502, 'codex_unavailable');
      if (status === 401) throw new AdapterError('Codex credits need a fresh Codex sign-in (the saved one expired). Open codex once to renew it, then refresh.', 502, 'codex_unavailable');
      // The credit report is an enterprise route, so a 403 is more likely "this account has no access" than an expired login.
      if (status === 403) throw new AdapterError('Codex credits are not available for this account (the credit report refused access). Check the account has the Codex credit report, then refresh.', 502, 'codex_unavailable');
      let body = null;
      try { body = JSON.parse(result.stdout.slice(0, cut)); } catch { /* not json */ }
      if (status !== 200 || !body || !Array.isArray(body.data)) throw new AdapterError(`Codex credits could not be read (HTTP ${status || 'none'}).`, 502, 'codex_unavailable');
      // A day with a missing or non-numeric amount is unknown, not zero: refuse the whole reading rather than undercount.
      const incomplete = () => new AdapterError('Codex credits came back incomplete (a day is missing or has no usable amount), so no total is shown. Refresh to try again.', 502, 'codex_unavailable');
      const sums = { week: 0, month: 0 };
      const models = new Map();
      const byModel = body.breakdown === 'model';
      const seen = new Set();
      let through = null;
      // The backend lists a model on every day only when that model has usage somewhere in the requested range, so a range
      // with no usage at all (the week after the last credits were spent, once the month has just rolled over) comes back
      // with an empty `series` and an empty `values` on every day. That whole-range answer is a real zero, but only while
      // the backend vouches for it: `series` is an empty list, every row has an empty `values`, and its data is fresh
      // through at least the day before the last requested day. One empty day beside days with amounts stays unknown.
      const lastRequired = query.get('end_date') < utcToday ? query.get('end_date') : utcToday;
      const dayBefore = new Date(Date.parse(`${lastRequired}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const freshAt = typeof body.data_freshness_ts === 'string' ? Date.parse(body.data_freshness_ts) : NaN;
      const noUsage = Array.isArray(body.series) && body.series.length === 0
        && Number.isFinite(freshAt) && new Date(freshAt).toISOString().slice(0, 10) >= dayBefore
        && body.data.length > 0 && body.data.every((row) => row && row.values && typeof row.values === 'object' && !Array.isArray(row.values) && Object.keys(row.values).length === 0);
      for (const row of body.data) {
        if (!row || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !row.values || typeof row.values !== 'object' || Array.isArray(row.values)) throw incomplete();
        const credits = Object.entries(row.values);
        if ((credits.length === 0 && !noUsage) || credits.some(([, value]) => number(value) === null)) throw incomplete();
        if (seen.has(row.date)) throw incomplete();
        seen.add(row.date);
        if (through === null || row.date > through) through = row.date;
        const total = credits.reduce((sum, [, value]) => sum + value, 0);
        if (row.date >= since.week) sums.week += total;
        if (row.date >= since.month) {
          sums.month += total;
          if (byModel) for (const [model, value] of credits) models.set(text(model, 60), (models.get(text(model, 60)) || 0) + value);
        }
      }
      // Every UTC day from the first requested day through today (UTC) must be present: a missing day is unknown, not zero.
      // A later local-only day the service has not started yet is not required.
      for (let day = query.get('start_date'); day <= lastRequired; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
        if (!seen.has(day)) throw incomplete();
      }
      return {
        week: { since: since.week, credits: round2(sums.week), usd: round2(sums.week * CODEX_USD_PER_CREDIT) },
        month: { since: since.month, credits: round2(sums.month), usd: round2(sums.month * CODEX_USD_PER_CREDIT) },
        usd_per_credit: CODEX_USD_PER_CREDIT,
        month_limit: CODEX_MONTH_LIMIT,
        models: [...models].map(([model, credits]) => ({ model, credits: round2(credits) })).filter((item) => item.model && item.credits > 0).sort((a, b) => b.credits - a.credits).slice(0, 6),
        data_through: through,
        read_at: today.toISOString(),
      };
    });
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
    archiveAllPreview,
    applyVerified,
    saveManualIdentity,
    sealBundle,
    listBundles,
    reconcilePreview,
    contextGauge,
    archiveContext,
    planUsage,
    codexCredits,
    leaderSpace,
    handoffCommand,
    handoffRestartCommand,
    focusTab,
    // exposed for later phases and tests
    _internal: { runner, runEnv, herdrCall, registryScript, organizerScript, pythonBin, runPreflight, validatedAcks, preflightArgs, allowedAcknowledgements, normalizeAcks, preflightView },
  };
}

module.exports = { createAdapter, AdapterError, childEnv, defaultRunner, SESSION_NAME_RE };
