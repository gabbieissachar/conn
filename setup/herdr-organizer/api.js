'use strict';

// HTTP surface for the Herdr restart tools. serve.sh requires this module and
// hands it every /api/herdr-organizer/* request before its shared CORS handling.
//
//   GET  /api/herdr-organizer/token   same-origin only; returns the per-start token
//   POST /api/herdr-organizer/run     { action, params }; the browser names a fixed
//                                     action from ACTIONS and sends validated params
//
// The browser never sends a command, an argument list or free text that reaches
// a shell. Unknown actions and unknown params are refused.

const path = require('path');
const { createGuard } = require('./guard');
const { createAdapter, AdapterError } = require('./adapter');
const { buildShareReport } = require('./redact');

const PREFIX = '/api/herdr-organizer/';
const MAX_BODY_BYTES = 64 * 1024;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  // Deliberately no Access-Control-Allow-* headers on any response from here.
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(payload);
}

function fail(res, status, code, message) {
  send(res, status, { status: 'error', code, message });
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

function create({ root, port, toolRoot, adapter, token, now = () => new Date(), env = process.env } = {}) {
  const resolvedToolRoot = toolRoot || env.HERDR_ORGANIZER_TOOL_ROOT || path.join(root, 'personal', '01-System', 'setup', 'herdr');
  const guard = createGuard({ port, token });
  const tools = adapter || createAdapter({ toolRoot: resolvedToolRoot, env });
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
    // tier 1: private local writes. Each needs a confirm token naming exactly what it changes.
    'verify-apply': { tier: 1, params: { session: { type: 'string' }, confirm: { type: 'string' } }, run: (p) => tools.applyVerified(p.session, p.confirm) },
    'save-manual-identity': {
      tier: 1,
      params: { session: { type: 'string' }, pane_id: { type: 'string' }, client: { type: 'string' }, session_id: { type: 'string' }, folder_override: { type: 'boolean', optional: true }, confirm: { type: 'string' } },
      run: (p) => tools.saveManualIdentity(p),
    },
    'seal-bundle': {
      tier: 1,
      params: { sessions: { type: 'array' }, acknowledgements: { type: 'object', optional: true }, confirm: { type: 'string' } },
      run: (p) => tools.sealBundle(p.sessions, p.acknowledgements, p.confirm),
    },
    'cleanup-preview': { tier: 0, params: { session: { type: 'string' } }, run: (p) => tools.cleanupPreview(p.session) },
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
    if (action.tier >= 1) {
      if (tier1Busy) { fail(res, 409, 'busy', 'Another change is still running. Wait for it to finish.'); return; }
      tier1Busy = true;
    }
    try {
      const data = await action.run(params);
      send(res, 200, { status: 'ok', action: body.action, data });
    } finally {
      if (action.tier >= 1) tier1Busy = false;
    }
  }

  async function dispatch(req, res, pathname) {
    if (pathname === PREFIX + 'token' && req.method === 'GET') {
      const verdict = guard.check(req, { requireToken: false });
      if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
      send(res, 200, { status: 'ok', token: guard.token, header: guard.tokenHeader });
      return;
    }
    if (pathname === PREFIX + 'run' && (req.method === 'POST' || req.method === 'OPTIONS' || req.method === 'GET')) {
      const verdict = guard.check(req);
      if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
      if (req.method !== 'POST') { fail(res, 405, 'method', 'POST required.'); return; }
      await runAction(req, res);
      return;
    }
    // Unknown route under the prefix: still pass the guard first so probes learn nothing.
    const verdict = guard.check(req, { requireToken: false });
    if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
    fail(res, 404, 'not_found', 'Not found.');
  }

  // Returns true when the request belongs to this module (and is handled here).
  function handle(req, res) {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return false; }
    if (!pathname.startsWith(PREFIX)) return false;
    dispatch(req, res, pathname).catch((error) => {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof AdapterError || (error && error.status && error.code)) fail(res, error.status || 400, error.code || 'error', error.message);
      else fail(res, 500, 'internal', 'Unexpected error.');
    });
    return true;
  }

  return { handle, guard, adapter: tools, ACTIONS };
}

module.exports = { create, validateParams, PREFIX };
