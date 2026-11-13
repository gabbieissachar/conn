'use strict';

// HTTP surface for the Herdr restart tools. organizer-serve.sh requires this module and
// hands it every /api/herdr-organizer/* request before its shared CORS handling.
//
//   GET  /api/herdr-organizer/token   same-origin only; returns the per-start token
//   POST /api/herdr-organizer/run     { action, params }; the browser names a fixed
//                                     action from ACTIONS and sends validated params
//
// The browser never sends a command, an argument list or free text that reaches
// a shell. Unknown actions and unknown params are refused.
//
// A request that came in on the phone listener (phone.js, opt-in) is handed to handle()
// with listener 'tailnet', after phone.js has checked the Host, Origin, Fetch-Metadata and
// the passcode session. The same routes then run under the tailnet guard instead: the
// Host and Origin must be the one Tailscale address and port, and the token, Fetch-Metadata,
// JSON and one-change-at-a-time rules are the loopback ones. The two listeners share one
// token and one lock.

const os = require('os');
const path = require('path');
const { createGuard, TOKEN_HEADER } = require('./guard');
const tailnetLane = require('../transcript-reader/tailnet');
const { createAdapter, AdapterError } = require('./adapter');
const { buildShareReport } = require('./redact');
const { createRollover } = require('./rollover');
const { createSwitches } = require('./rollover-switches');
const { createPreview } = require('./rollover-preview');

const PREFIX = '/api/herdr-organizer/';
// The organizer page the phone lands on, and the sign-in routes the phone listener adds. The passcode, the
// cookie and the sessions are the transcript reader's (one sign-in opens both apps on the tailnet address).
const PAGE_PATH = '/apps/wip-herdr-workspace-organizer.html';
const ORGANIZER_SITE = {
  noun: 'organizer', title: 'Herdr organizer', openLabel: 'Open the organizer', passcodeCommand: 'setup/transcript-reader/serve.sh passcode',
  prefix: '/herdr-organizer/', signin: '/herdr-organizer/signin', signout: '/herdr-organizer/signout', home: PAGE_PATH, landing: PAGE_PATH, rootRedirect: false,
};
const MAX_BODY_BYTES = 64 * 1024;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  // Deliberately no Access-Control-Allow-* headers on any response from here.
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(payload);
}

function fail(res, status, code, message, details) {
  send(res, status, { status: 'error', code, message, ...(details ? { details } : {}) });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { done = true; reject(new AdapterError('Request body too large.', 413)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        resolve(value);
      } catch { reject(new AdapterError('Invalid JSON body.')); }
    });
    req.on('error', () => { if (!done) { done = true; reject(new AdapterError('Request failed.')); } });
  });
}

const TYPE_CHECKS = {
  string: (value) => typeof value === 'string' && value.length <= 200,
  boolean: (value) => typeof value === 'boolean',
  array: (value) => Array.isArray(value) && value.length <= 64,
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
};

// params spec: { name: { type, optional } }. Unknown keys are refused.
function validateParams(spec, params) {
  const input = params === undefined ? {} : params;
  if (!TYPE_CHECKS.object(input)) throw new AdapterError('Invalid params.');
  for (const key of Object.keys(input)) if (!Object.prototype.hasOwnProperty.call(spec, key)) throw new AdapterError('Unknown param: ' + key.slice(0, 40));
  for (const [key, rule] of Object.entries(spec)) {
    if (input[key] === undefined) {
      if (!rule.optional) throw new AdapterError('Missing param: ' + key);
      continue;
    }
    if (!TYPE_CHECKS[rule.type](input[key])) throw new AdapterError('Invalid param: ' + key);
  }
  return input;
}

// tailnet: { ip, passcodeFile[, port] } when phone.js also listens on the Mac's Tailscale address; log takes
// one line of text, the sign-in record (the server's stderr when left out).
function create({ root, port, toolRoot, adapter, token, now = () => new Date(), env = process.env, rollover, switches, preview, tailnet = null, log } = {}) {
  const resolvedToolRoot = toolRoot || env.HERDR_ORGANIZER_TOOL_ROOT || path.join(root, 'setup', 'herdr');
  const guard = createGuard({ port, token });
  const lane = tailnet && tailnetLane.create({ ip: tailnet.ip, port: tailnet.port || port, token: guard.token, tokenHeader: TOKEN_HEADER, passcodeFile: tailnet.passcodeFile, site: ORGANIZER_SITE, ...(log ? { log } : {}) });
  // The guard that holds for a request: the loopback one, or the tailnet listener's (its own Host and
  // Origin, the same token). Set by handle().
  const guards = new WeakMap();
  const guardFor = (req) => guards.get(req) || guard;
  // The firstmate home and code root the context gauge reads, as organizer-serve.sh names them.
  const fmHome = env.HERDR_ORGANIZER_FM_HOME || path.join(os.homedir(), 'fm-homes', 'pmos');
  const gaugeScript = env.HERDR_ORGANIZER_GAUGE_SCRIPT || path.join(os.homedir(), 'workspace', 'firstmate', 'bin', 'fm-ctx-gauge.sh');
  const tools = adapter || createAdapter({ toolRoot: resolvedToolRoot, env, fmHome, gaugeScript });
  const rolloverView = rollover || createRollover({ env, now, ledgerPath: path.join(resolvedToolRoot, 'state', 'workspace-organizer', 'rollover-switches', 'ledger.json') });
  const rolloverSwitches = switches || createSwitches({ rollover: rolloverView, toolRoot: resolvedToolRoot, now });
  const rolloverPreview = preview || createPreview({ rollover: rolloverView, env });
  let tier1Busy = false;

  async function shareReport(params) {
    const sessions = await tools.requireSessions(params.sessions);
    const verifies = [];
    for (const name of sessions) verifies.push(await tools.verifyReport(name));
    const preflight = await tools.preflight(sessions, params.acknowledgements);
    return buildShareReport({
      sessions: sessions.map((name, index) => ({ name, verify: verifies[index], preflight })),
      includeLabels: params.include_labels === true,
      now: now(),
    });
  }

  // The fixed-action allowlist. tier 0 = read-only; tier 1 = private local writes
  // (added with the guarded-action phase). Anything not listed here is refused.
  const ACTIONS = {
    sessions: { tier: 0, params: {}, run: () => tools.listSessionsView() },
    snapshot: { tier: 0, params: { session: { type: 'string' } }, run: (p) => tools.refreshSnapshot(p.session) },
    'snapshot-data': { tier: 0, params: {}, run: () => tools.readSnapshot() },
    bundles: { tier: 0, params: {}, run: () => tools.listBundles() },
    'context-gauge': { tier: 0, params: {}, run: () => tools.contextGauge() },
    'archive-context': { tier: 0, params: { prefixes: { type: 'array' } }, run: (p) => tools.archiveContext(p.prefixes) },
    'plan-usage': { tier: 0, params: { fresh: { type: 'boolean', optional: true } }, run: (p) => tools.planUsage(p.fresh === true) },
    'codex-credits': { tier: 0, params: {}, run: () => tools.codexCredits() },
    // Read only: what firstmate's rollover switches say in each registered home, and whether that home's watcher runs.
    'rollover-state': { tier: 0, params: {}, run: () => rolloverView.state() },
    // Read only: asks the home's own firstmate who would roll for these ids (`fm-rollover.sh check`, run from that home's watcher code).
    'rollover-preview': { tier: 0, params: { home: { type: 'string' }, kind: { type: 'string' }, ids: { type: 'array' } }, run: (p) => rolloverPreview.preview(p) },
    // tier 1: create or remove one firstmate switch file in one registered home. The browser names a home id and ids, never a path.
    // `rollover-stop` never waits behind another change: stopping must always be possible.
    'rollover-arm': { tier: 1, params: { home: { type: 'string' }, kind: { type: 'string' }, ids: { type: 'array' }, confirm: { type: 'string' } }, run: (p, ctx) => rolloverSwitches.arm(p, ctx) },
    'rollover-stop': { tier: 1, lock: false, params: { homes: { type: 'array', optional: true }, scope: { type: 'string', optional: true } }, run: (p, ctx) => rolloverSwitches.stop(p, ctx) },
    // The primary switch (tier 1p, the operator's own session): step 1 writes no switch file and takes no lock, step 2 needs the typed phrase, the challenge and its token.
    'rollover-primary-prepare': { tier: 1, lock: false, params: { home: { type: 'string' } }, run: (p, ctx) => rolloverSwitches.primaryPrepare(p, ctx) },
    'rollover-primary-arm': { tier: 1, params: { home: { type: 'string' }, challenge: { type: 'string' }, phrase: { type: 'string' }, confirm: { type: 'string' } }, run: (p, ctx) => rolloverSwitches.primaryArm(p, ctx) },
    'rollover-undo': { tier: 1, params: { home: { type: 'string' }, file: { type: 'string' }, confirm: { type: 'string', optional: true } }, run: (p, ctx) => rolloverSwitches.undo(p, ctx) },
    'leader-space': { tier: 0, params: {}, run: () => tools.leaderSpace() },
    'handoff-command': { tier: 0, params: { labels: { type: 'array', optional: true }, panes: { type: 'array', optional: true } }, run: (p) => tools.handoffCommand(p.labels, p.panes) },
    // Copy-only: the `handoff-restart` command for ordinary Claude sessions, built from references the server re-checks against the live panes and the gauge. Nothing is sent to a pane.
    'handoff-restart-command': { tier: 0, params: { panes: { type: 'array' } }, run: (p) => tools.handoffRestartCommand(p.panes) },
    // View only (no confirm, no input into any pane): shows a session's tab in the attached Herdr window. It takes
    // the tier 1 route's cross-site protections but not its one-at-a-time lock, so opening a tab never waits on a seal.
    'focus-tab': { tier: 1, lock: false, params: { session: { type: 'string' }, pane_id: { type: 'string' }, id: { type: 'string' } }, run: (p) => tools.focusTab(p.session, p.pane_id, p.id) },
    'reconcile-preview': { tier: 0, params: { bundle: { type: 'string' } }, run: (p) => tools.reconcilePreview(p.bundle) },
    // tier 1: private local writes. Each needs a confirm token naming exactly what it changes.
    'verify-apply': { tier: 1, params: { session: { type: 'string' }, confirm: { type: 'string' } }, run: (p) => tools.applyVerified(p.session, p.confirm) },
    'save-manual-identity': {
      tier: 1,
      params: { session: { type: 'string' }, pane_id: { type: 'string' }, client: { type: 'string' }, session_id: { type: 'string' }, folder_override: { type: 'boolean', optional: true }, replace_existing: { type: 'boolean', optional: true }, confirm: { type: 'string' } },
      run: (p) => tools.saveManualIdentity(p),
    },
    'seal-bundle': {
      tier: 1,
      params: { sessions: { type: 'array' }, acknowledgements: { type: 'object', optional: true }, confirm: { type: 'string' } },
      run: (p) => tools.sealBundle(p.sessions, p.acknowledgements, p.confirm),
    },
    'cleanup-preview': { tier: 0, params: { session: { type: 'string' } }, run: (p) => tools.cleanupPreview(p.session) },
    'archive-all-preview': { tier: 0, params: { session: { type: 'string' } }, run: (p) => tools.archiveAllPreview(p.session) },
    verify: { tier: 0, params: { session: { type: 'string' } }, run: (p) => tools.verifyReport(p.session) },
    preflight: {
      tier: 0,
      params: { sessions: { type: 'array' }, acknowledgements: { type: 'object', optional: true } },
      run: (p) => tools.preflight(p.sessions, p.acknowledgements),
    },
    'share-report': {
      tier: 0,
      params: { sessions: { type: 'array' }, include_labels: { type: 'boolean', optional: true }, acknowledgements: { type: 'object', optional: true } },
      run: shareReport,
    },
  };

  async function runAction(req, res) {
    const body = await readJsonBody(req);
    if (typeof body.action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, body.action)) {
      fail(res, 400, 'unknown_action', 'Unknown action.');
      return;
    }
    const action = ACTIONS[body.action];
    for (const key of Object.keys(body)) if (key !== 'action' && key !== 'params') throw new AdapterError('Unknown field.');
    const params = validateParams(action.params, body.params);
    const locks = action.tier >= 1 && action.lock !== false;
    if (locks) {
      if (tier1Busy) { fail(res, 409, 'busy', 'Another change is still running. Wait for it to finish.'); return; }
      tier1Busy = true;
    }
    try {
      const data = await action.run(params, { origin: String(req.headers.origin || '').slice(0, 200) });
      send(res, 200, { status: 'ok', action: body.action, data });
    } finally {
      if (locks) tier1Busy = false;
    }
  }

  async function dispatch(req, res, pathname) {
    if (pathname === PREFIX + 'token' && req.method === 'GET') {
      const verdict = guardFor(req).check(req, { requireToken: false });
      if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
      send(res, 200, { status: 'ok', token: guard.token, header: guard.tokenHeader });
      return;
    }
    if (pathname === PREFIX + 'run' && (req.method === 'POST' || req.method === 'OPTIONS' || req.method === 'GET')) {
      const verdict = guardFor(req).check(req);
      if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
      if (req.method !== 'POST') { fail(res, 405, 'method', 'POST required.'); return; }
      await runAction(req, res);
      return;
    }
    // Unknown route under the prefix: still pass the guard first so probes learn nothing.
    const verdict = guardFor(req).check(req, { requireToken: false });
    if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
    fail(res, 404, 'not_found', 'Not found.');
  }

  // Returns true when the request belongs to this module (and is handled here). listener is 'tailnet' for a
  // request phone.js has already checked and signed in: it runs under the tailnet listener's guard.
  function handle(req, res, listener = 'loopback') {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return false; }
    if (!pathname.startsWith(PREFIX)) return false;
    if (listener === 'tailnet') {
      if (!lane) { fail(res, 403, 'refused', 'Not served here.'); return true; }
      guards.set(req, lane.guard);
    }
    dispatch(req, res, pathname).catch((error) => {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof AdapterError || (error && error.status && error.code)) fail(res, error.status || 400, error.code || 'error', error.message, error.reasons);
      else fail(res, 500, 'internal', 'Unexpected error.');
    });
    return true;
  }

  return { handle, guard, adapter: tools, ACTIONS, tailnet: lane };
}

module.exports = { create, validateParams, PREFIX, PAGE_PATH, ORGANIZER_SITE };
