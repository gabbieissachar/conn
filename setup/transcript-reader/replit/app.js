'use strict';

// The hosted transcript reader's web app: one request handler, no framework.
//
// Who can do what (README.md has the same table for the owner):
//   nobody signed in     the login page (also at "/"), the sign-in routes; every other route answers 401
//   the owner's session  read the shell and every sealed object; write a queued message (q/<uuid>.json.enc)
//   the laptop's key     list names; write the shell, the key parameters, sealed objects and receipts;
//                        delete objects; read and delete queued messages (a bearer key, /api/objects)
// The app never decrypts anything: it stores and serves the sealed bytes it is given.

const { classify, checkBody, maxBytes, contentType } = require('./names');
const keys = require('./keys');
const session = require('./session');

const BEARER = /^Bearer (\S+)$/i;
const FAILURE_LIMIT = 10;       // wrong keys per address per minute before a wrong key is answered 429
const LOGIN_SECONDS = 600;

// The shell page carries a stricter policy of its own (a meta tag: its script by hash); this adds the
// framing ban a meta tag cannot, and the same limits, so a changed shell cannot widen them here.
const SHELL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const MESSAGES = {
  denied: 'This account is not allowed to open this site.',
  failed: 'Sign-in did not complete. Try again.',
  expired: 'That sign-in took too long, or was not started on this device. Try again.',
};

function loginPage(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcript reader</title>
<style>
:root { --bg: #fff; --fg: #1b1f24; --muted: #5b6570; --accent: #0b5cd5; --on-accent: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #14171a; --fg: #e8eaed; --muted: #9aa4af; --accent: #6ea8ff; --on-accent: #0a1220; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 22rem; margin: 0 auto; padding: 4rem 16px; }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
p { color: var(--muted); margin: 0 0 1.5rem; }
a.button { display: block; text-align: center; padding: .75rem 1rem; border-radius: .5rem; background: var(--accent); color: var(--on-accent); text-decoration: none; font-weight: 600; }
</style></head><body><main>
<h1>Transcript reader</h1>
<p>${message || 'A private page. Sign in with your ShopBack account.'}</p>
<a class="button" href="/auth/start">Sign in</a>
</main></body></html>`;
}

class Refused extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createHandler({ config, store, oidc, now = Date.now, log = () => {} }) {
  const sessionName = config.secureCookies ? '__Host-hr_session' : 'hr_session';
  const loginName = config.secureCookies ? '__Host-hr_login' : 'hr_login';
  const failures = new Map();  // address -> times of recent wrong keys
  const origin = new URL(config.appUrl).origin;

  const baseHeaders = () => ({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    ...(config.secureCookies ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  });

  function send(res, status, body, headers = {}) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, { ...baseHeaders(), 'content-length': bytes.length, ...headers });
    res.end(bytes);
  }
  const json = (res, status, value, headers = {}) => send(res, status, JSON.stringify(value), { 'content-type': 'application/json', ...headers });
  const html = (res, status, body, headers = {}) => send(res, status, body, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP, ...headers });
  const redirect = (res, to, headers = {}) => send(res, 302, '', { location: to, ...headers });
  const showLogin = (res, code, status = 200, headers = {}) => html(res, status, loginPage(MESSAGES[code]), headers);

  const clearCookie = (name) => session.cookie(name, '', { seconds: 0, secure: config.secureCookies });
  const owner = (req) => {
    const data = session.verify(config.sessionSecret, 'session', session.parseCookies(req.headers.cookie)[sessionName], now());
    return data && config.allowedEmails.has(data.e) ? data.e : null;  // the allow-list is read on every request
  };

  // A browser write must come from this site's own page: a custom header (a cross-site page cannot
  // send one without a preflight this app never answers) and, when the browser says, our own origin.
  const sameSite = (req) => req.headers['x-requested-with'] === 'transcript-reader'
    && (req.headers.origin === undefined || req.headers.origin === origin);

  // The path as sent, decoded once; null for anything that could climb out ("..", a backslash, an
  // empty segment, a NUL) before names.classify gets to see it.
  function nameOf(raw) {
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch { return null; }
    if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('//') || /^\/|\/$/.test(decoded)) return null;
    return decoded;
  }

  async function readBody(req, limit) {
    if (Number(req.headers['content-length']) > limit) throw new Refused(413, 'too large');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Refused(413, 'too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  const address = (req) => {
    if (config.trustProxy) { const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim(); if (forwarded) return forwarded; }
    return req.socket.remoteAddress || '';
  };

  // The live upload key's id, or null after answering 401 (or 429 for an address that keeps sending
  // wrong keys). A live key is never turned away for other callers' wrong guesses: behind Replit's
  // proxy every caller can share one address.
  async function bearer(req, res) {
    const match = BEARER.exec(req.headers.authorization || '');
    const id = match ? await keys.verify(store, match[1]) : null;
    if (id) return id;
    const from = address(req);
    const recent = (failures.get(from) || []).filter((at) => now() - at < 60000);
    if (match) recent.push(now());
    if (failures.size > 1000) failures.clear();
    failures.set(from, recent);
    if (recent.length > FAILURE_LIMIT) json(res, 429, { error: 'too many wrong keys; wait a minute' }, { 'retry-after': '60' });
    else json(res, 401, { error: 'a valid upload key is required' }, { 'www-authenticate': 'Bearer' });
    return null;
  }

  // ----------------------------------------------------------------- the laptop's routes

  const WRITES = new Set(['shell', 'params', 'index', 'object', 'receipt']);
  const DELETES = new Set(['object', 'queue', 'receipt']);

  async function api(req, res, method, rawPath, url) {
    if (!(await bearer(req, res))) return;
    if (rawPath === '/api/objects') {
      if (method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      const prefix = url.searchParams.get('prefix') || '';
      if (!['', 's/', 'd/', 'f/', 'k/', 'q/', 'r/'].includes(prefix)) return json(res, 400, { error: 'unknown prefix' });
      const objects = (await store.list(prefix)).filter(({ name }) => classify(name));
      return json(res, 200, { objects });
    }
    const name = nameOf(rawPath.slice('/api/objects/'.length));
    const kind = name && classify(name);
    if (!kind) return json(res, 400, { error: 'not an object name' });
    if (method === 'GET') {
      if (kind !== 'queue') return json(res, 403, { error: 'the upload key reads only queued messages' });
      const bytes = await store.get(name);
      return bytes ? send(res, 200, bytes, { 'content-type': contentType(kind) }) : json(res, 404, { error: 'not found' });
    }
    if (method === 'PUT') {
      if (!WRITES.has(kind)) return json(res, 403, { error: 'the upload key does not write that name' });
      const bytes = await readBody(req, maxBytes(kind));
      if (!checkBody(kind, bytes)) return json(res, 422, { error: 'not a sealed object of that name' });
      await store.put(name, bytes);
      return json(res, 201, { name, size: bytes.length });
    }
    if (method === 'DELETE') {
      if (!DELETES.has(kind)) return json(res, 403, { error: 'the upload key does not delete that name' });
      return json(res, 200, { deleted: await store.delete(name) });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  // ----------------------------------------------------------------- sign-in

  async function signInStart(res) {
    try {
      const { url, login } = await oidc.start();
      const token = session.sign(config.sessionSecret, 'login', { s: login.state, n: login.nonce, v: login.verifier }, LOGIN_SECONDS, now());
      redirect(res, url, { 'set-cookie': session.cookie(loginName, token, { seconds: LOGIN_SECONDS, secure: config.secureCookies }) });
    } catch (error) {
      log('sign-in could not start: ' + error.message);
      showLogin(res, 'failed', 502);
    }
  }

  async function signInCallback(req, res, url) {
    const cookies = session.parseCookies(req.headers.cookie);
    const login = session.verify(config.sessionSecret, 'login', cookies[loginName], now());
    const code = url.searchParams.get('code');
    const gone = { 'set-cookie': clearCookie(loginName) };
    if (url.searchParams.get('error')) return showLogin(res, 'failed', 400, gone);
    if (!login || !code || url.searchParams.get('state') !== login.s) return showLogin(res, 'expired', 400, gone);
    let claims;
    try {
      claims = await oidc.finish(code, { verifier: login.v, nonce: login.n });
    } catch (error) {
      log('sign-in failed: ' + error.message);
      return showLogin(res, 'failed', 502, gone);
    }
    const email = String(claims.email || '').trim().toLowerCase();
    // The provider must say the address is verified. A provider that never sends the claim (a
    // company directory where addresses are assigned, not claimed) needs OIDC_EMAIL_VERIFIED_OPTIONAL=1;
    // an explicit "not verified" is always refused.
    const verified = claims.email_verified === true || claims.email_verified === 'true'
      || (config.emailVerifiedOptional && claims.email_verified === undefined);
    if (!email || !verified || !config.allowedEmails.has(email)) {
      log(email && !verified && config.allowedEmails.has(email)
        ? 'sign-in refused: the provider did not say the email is verified (see OIDC_EMAIL_VERIFIED_OPTIONAL)'
        : 'sign-in refused: not on the allow-list');
      return showLogin(res, 'denied', 403, gone);
    }
    const token = session.sign(config.sessionSecret, 'session', { e: email }, config.sessionSeconds, now());
    redirect(res, '/', { 'set-cookie': [clearCookie(loginName), session.cookie(sessionName, token, { seconds: config.sessionSeconds, secure: config.secureCookies })] });
  }

  // ----------------------------------------------------------------- the owner's routes

  async function viewer(req, res, method, rawPath) {
    const name = rawPath === '/' ? 'index.html' : nameOf(rawPath.slice(1));
    const kind = name && classify(name);
    if (!kind) return json(res, 404, { error: 'not found' });
    if (method === 'GET') {
      const bytes = await store.get(name);
      if (!bytes) return kind === 'shell' ? html(res, 404, '<!doctype html><meta charset="utf-8"><title>Transcript reader</title><p>Nothing has been uploaded yet. Run the sync agent from the laptop.</p>') : json(res, 404, { error: 'not found' });
      return send(res, 200, bytes, { 'content-type': contentType(kind), ...(kind === 'shell' ? { 'content-security-policy': SHELL_CSP } : {}) });
    }
    if (method === 'PUT' && kind === 'queue') {
      if (!sameSite(req)) return json(res, 403, { error: 'not from this site' });
      if ((await store.list('q/')).length >= config.queueLimit) return json(res, 429, { error: 'too many messages are waiting for the laptop' });
      if (await store.get(name)) return json(res, 409, { error: 'already queued' });
      const bytes = await readBody(req, maxBytes(kind));
      if (!checkBody(kind, bytes)) return json(res, 422, { error: 'not a sealed message' });
      await store.put(name, bytes);
      return json(res, 201, { name });
    }
    return json(res, method === 'PUT' ? 403 : 405, { error: 'not allowed' });
  }

  // ----------------------------------------------------------------- routing

  async function route(req, res) {
    const rawPath = String(req.url || '/').split('?')[0];
    const url = new URL(req.url || '/', 'http://app.local');
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (rawPath === '/login' && method === 'GET') return showLogin(res, url.searchParams.get('e'));
    if (rawPath === '/auth/start' && method === 'GET') return signInStart(res);
    if (rawPath === '/auth/callback' && method === 'GET') return signInCallback(req, res, url);
    if (rawPath === '/logout' && method === 'POST') {
      if (!sameSite(req)) return json(res, 403, { error: 'not from this site' });
      return redirect(res, '/', { 'set-cookie': clearCookie(sessionName) });
    }
    if (rawPath === '/api/objects' || rawPath.startsWith('/api/objects/')) return api(req, res, method, rawPath, url);
    if (rawPath.startsWith('/api/')) return (await bearer(req, res)) && json(res, 404, { error: 'not found' });
    if (!owner(req)) {
      if (method === 'GET' && (rawPath === '/' || rawPath === '/index.html')) return showLogin(res, undefined);
      return json(res, 401, { error: 'sign in first' });
    }
    return viewer(req, res, method, rawPath);
  }

  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof Refused) return json(res, error.status, { error: error.message }, { connection: 'close' });
      log('request failed: ' + error.message);
      json(res, 500, { error: 'server error' });
    }
  };
}

module.exports = { createHandler, loginPage };
