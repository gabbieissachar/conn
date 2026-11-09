'use strict';

// Tests for opening the reader from the phone over Tailscale (tailnet.js, server.js, passcode.js).
// Run from the repo root: node --test setup/transcript-reader/tailnet.test.js
// The tailnet listener is bound to 127.0.0.1 on a second free port, so a test needs no Tailscale;
// the one test that binds the real Tailscale address skips itself when `tailscale ip -4` does not
// answer. Passcodes here are test values in temporary files, never the owner's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { start, isTailnetAddress } = require('./server');
const tailnet = require('./tailnet');
const { TOKEN_HEADER, TOKEN_META } = require('./api');
const { createGuard } = require('../herdr-organizer/guard');

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const PASSCODE = 'correct horse battery';
const PAGE = '/setup/transcript-reader/out/prototype.html';
const NAVIGATE = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// A fake Herdr with one idle Claude pane running session A.
function fakeHerdr() {
  const herdr = { calls: [] };
  const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });
  herdr.runner = async (file, args) => {
    herdr.calls.push({ file, args: args.slice() });
    if (file === 'herdr' && args[0] === 'session') return ok(JSON.stringify({ sessions: [{ name: 'work', default: false, running: true }] }));
    if (file === 'herdr' && args[2] === 'api' && args[3] === 'snapshot') {
      return ok(JSON.stringify({ result: { snapshot: { focused_pane_id: 'w1:p1', tabs: [], panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', label: 'alpha', agent_status: 'idle', agent_session: { value: A } }] } } }));
    }
    if (file === 'herdr' && args[2] === 'pane' && args[3] === 'process-info') return ok(JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 1001, argv0: 'claude' }] } } }));
    if (file === 'herdr' && args[2] === 'agent') return ok('{}');
    if (file === 'python3') return ok('');
    return { code: 1, stdout: '', stderr: 'unexpected command', timedOut: false, truncated: false };
  };
  herdr.prompts = () => herdr.calls.filter((call) => call.args[2] === 'agent' && call.args[3] === 'prompt');
  return herdr;
}

// A reader server with its loopback listeners and, unless withTailnet is false, a tailnet listener.
// sharedPasscodeFile: another boot's passcode file, so this server shares its passcode and sessions (a restart, or a second server).
async function boot({ passcode = PASSCODE, withTailnet = true, sharedPasscodeFile = null, secure = null, board = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-tailnet-'));
  const root = path.join(base, 'repo');
  const outDir = path.join(root, 'setup', 'transcript-reader', 'out');
  const projectsDir = path.join(base, 'projects');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(projectsDir, '-Users-someone-home'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'prototype.html'), `<!doctype html><head>${TOKEN_META}<title>reader</title></head>page body`);
  fs.writeFileSync(path.join(outDir, 'sessions.txt'), A + '\n');
  fs.writeFileSync(path.join(outDir, 'prototype.stamp'), String(Date.now() / 1000 + 3600));
  const log = path.join(projectsDir, '-Users-someone-home', A + '.jsonl');
  fs.writeFileSync(log, '{}\n');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(log, old, old);
  const passcodeFile = sharedPasscodeFile || path.join(base, 'config', 'passcode.json');
  if (passcode && !sharedPasscodeFile) await tailnet.writePasscodeFile(passcodeFile, passcode);
  const herdr = fakeHerdr();
  const lines = [];
  let clock = Date.now();
  const port = await freePort();
  const tailnetPort = await freePort();
  const httpsPort = await freePort();
  // secure: { host, certFile, keyFile, recheckMs } turns the TLS listener on (certificate files made by makeCertificate).
  const server = await start({
    root, port, tailnet: withTailnet ? { ip: '127.0.0.1', port: tailnetPort, passcodeFile, ...(secure ? { https: { port: httpsPort, ...secure } } : {}) } : null,
    ...(board ? { board } : {}), log: (line) => lines.push(line), runner: herdr.runner, env: {}, projectsDir, claudeSessionsDir: path.join(base, 'sessions'), pinsFile: path.join(base, 'config', 'pins.json'), now: () => clock, pause: async () => {},
  });

  const request = (target, { method = 'GET', path: urlPath, headers = {}, body }) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: target, method, path: urlPath, headers: { ...headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, raw, json }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  const loopback = { host: 'localhost:' + port, origin: 'http://localhost:' + port };
  const phone = { host: '127.0.0.1:' + tailnetPort, origin: 'http://127.0.0.1:' + tailnetPort };
  // Requests as the browser makes them, on the loopback listener and on the tailnet one.
  const onLoopback = (options) => request(port, { ...options, headers: { Host: loopback.host, ...options.headers } });
  const onTailnet = (options) => request(tailnetPort, { ...options, headers: { Host: phone.host, ...options.headers } });
  // Requests as a phone makes them to the TLS listener: the machine's name in Host, the scratch certificate trusted.
  const onHttps = (options) => new Promise((resolve, reject) => {
    const host = HOST;
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = https.request({ host: '127.0.0.1', port: httpsPort, servername: host, rejectUnauthorized: false, agent: false, method: options.method || 'GET', path: options.path,
      headers: { Host: `${host}:${httpsPort}`, ...options.headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let raw = '';
      const cert = res.socket.getPeerCertificate();  // the scratch certificate is self-signed, so it is read, not verified
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, raw, json, cert }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  const signIn = (passcodeText, extra = {}) => onTailnet({ method: 'POST', path: '/transcript-reader/signin', headers: { Origin: phone.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...extra }, body: { passcode: passcodeText, next: PAGE } });
  const cookieFrom = (response) => String(response.headers['set-cookie'] || '').split(';')[0];
  const signedIn = async () => { const response = await signIn(PASSCODE); assert.equal(response.status, 200); return cookieFrom(response); };
  return {
    base, server, herdr, lines, passcodeFile, port, tailnetPort, httpsPort, loopback, phone, onLoopback, onTailnet, onHttps, signIn, cookieFrom, signedIn, request,
    tick: (ms) => { clock += ms; },
    close: () => { server.close(); },
  };
}

// A scratch self-signed certificate for <host> in <dir> (openssl), never a real one; null when openssl cannot make it.
function makeCertificate(dir, host, days = 2) {
  fs.mkdirSync(dir, { recursive: true });
  const certFile = path.join(dir, host + '.crt');
  const keyFile = path.join(dir, host + '.key');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', String(days), '-subj', '/CN=' + host, '-addext', 'subjectAltName=DNS:' + host], { stdio: 'ignore', timeout: 30000 });
  } catch { return null; }
  return { host, certFile, keyFile };
}

const tokenIn = (html) => (html.match(/<meta name="reader-token" content="([^"]*)">/) || [])[1];

// ---------------------------------------------------------------- loopback unchanged

test('loopback requests behave as before: no sign-in, the page carries the token, the API takes it, tailnet routes do not exist', async (t) => {
  const s = await boot();
  t.after(s.close);
  const page = await s.onLoopback({ path: PAGE, headers: NAVIGATE });
  assert.equal(page.status, 200);
  const token = tokenIn(page.raw);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(page.headers['set-cookie'], undefined);
  const state = await s.onLoopback({ path: '/api/transcript-reader/state', headers: { [TOKEN_HEADER]: token } });
  assert.equal(state.status, 200);
  assert.equal((await s.onLoopback({ path: '/api/transcript-reader/state' })).status, 403, 'no token, no state');
  assert.equal((await s.onLoopback({ path: '/' })).status, 404, 'the root is still nothing on loopback');
  for (const route of ['/transcript-reader/signin', '/transcript-reader/signout']) assert.equal((await s.onLoopback({ path: route })).status, 404, route);
  // The tailnet address is not an allowed Host on a loopback listener, and a passcode is no use there.
  assert.equal((await s.request(s.port, { path: PAGE, headers: { Host: s.phone.host, ...NAVIGATE } })).status, 403);
  assert.equal((await s.request(s.port, { path: PAGE, headers: { Host: 'evil.example:' + s.port, ...NAVIGATE } })).status, 403);
});

test('a loopback server started without the tailnet switch has no tailnet routes at all', async (t) => {
  const s = await boot({ withTailnet: false });
  t.after(s.close);
  assert.equal(s.server.tailnet, null);
  assert.equal(s.server.tailnetError, null);
  assert.equal((await s.onLoopback({ path: PAGE, headers: NAVIGATE })).status, 200);
});

// ------------------------------------------------------------- no session, no access

test('on the tailnet listener a request without a session gets the passcode page or 401, never the reader or its token', async (t) => {
  const s = await boot();
  t.after(s.close);
  for (const target of ['/', PAGE]) {
    const response = await s.onTailnet({ path: target, headers: NAVIGATE });
    assert.equal(response.status, 401, target);
    assert.match(response.headers['content-type'], /text\/html/);
    assert.match(response.raw, /type="password"/);
    assert.match(response.raw, /name="viewport"/);
    assert.ok(!response.raw.includes('page body'));
    assert.ok(!/reader-token/.test(response.raw));
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  for (const target of ['/api/transcript-reader/state', '/api/transcript-reader/pins', '/setup/transcript-reader/out/hosted/index.json', '/nothing/here']) {
    const response = await s.onTailnet({ path: target });
    assert.equal(response.status, 401, target);
    assert.equal(response.json.code, 'sign_in_required');
  }
  const sent = await s.onTailnet({ method: 'POST', path: '/api/transcript-reader/send', headers: { Origin: s.phone.origin, 'Content-Type': 'application/json' }, body: { session_id: A, text: 'hello' } });
  assert.equal(sent.status, 401);
  assert.equal(s.herdr.prompts().length, 0);
  const pinned = await s.onTailnet({ method: 'POST', path: '/api/transcript-reader/pins', headers: { Origin: s.phone.origin, 'Content-Type': 'application/json' }, body: {} });
  assert.equal(pinned.status, 401);
});

test('a made-up or stale session cookie is no session', async (t) => {
  const s = await boot();
  t.after(s.close);
  for (const cookie of ['pmos_session=nope', 'pmos_session=', 'other=1', 'pmos_session=' + 'a'.repeat(43)]) {
    assert.equal((await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } })).status, 401, cookie);
  }
});

test('the passcode page is phone-sized and carries no inline code the page\'s own policy does not allow', async (t) => {
  const s = await boot();
  t.after(s.close);
  const response = await s.onTailnet({ path: '/transcript-reader/signin', headers: NAVIGATE });
  assert.equal(response.status, 200);
  const csp = response.headers['content-security-policy'];
  const hash = (text) => `'sha256-${require('crypto').createHash('sha256').update(text).digest('base64')}'`;
  assert.ok(csp.includes(`script-src ${hash(response.raw.match(/<script>([\s\S]*?)<\/script>/)[1])}`), 'the script is allowed by its hash alone');
  assert.ok(csp.includes(`style-src ${hash(response.raw.match(/<style>([\s\S]*?)<\/style>/)[1])}`), 'the style is allowed by its hash alone');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(response.raw, /font-size:16px/, '16px inputs keep iOS from zooming in');
});

// The passcode page's own script, run against a fake page. answer(url, init) says what the server
// returns for each request the script makes (a { status, body } where an object body is JSON, a function
// to throw or never answer); the helper hands back what the person sees and what the script did.
const reply = (status, body) => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function openPage(page, { location = { pathname: '/', search: '', hash: '' }, answer }) {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const moves = [];
  const requests = [];
  const timers = [];
  const elements = {};
  let submit;
  const element = (id) => elements[id] || (elements[id] = {
    id, value: 'correct horse battery', textContent: id === 'b' ? 'Open the reader' : '', disabled: false, removed: false,
    focus() { this.focused = true; }, remove() { this.removed = true; },
    addEventListener(name, fn) { if (name === 'submit') submit = fn; },
  });
  class FakeAbortController { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } }
  const sandbox = {
    document: { getElementById: element },
    location: { ...location, replace: (to) => moves.push(['replace', to]), reload: () => moves.push(['reload']) },
    fetch: (url, init) => {
      requests.push({ url, init });
      return Promise.resolve(answer(url, init)).then((result) => {
        if (result instanceof Error) throw result;
        return { ok: result.status >= 200 && result.status < 300, status: result.status, text: async () => result.body };
      });
    },
    AbortController: FakeAbortController,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
  };
  require('vm').runInNewContext(script, sandbox);
  const page_ = {
    moves, requests, timers, element,
    submit: async () => { submit({ preventDefault() {} }); await settle(); },
    message: () => element('m').textContent,
    // The timer that gives up on a request (10 s) or on a page that does not open (8 s) is the one still running.
    fire: async (ms) => { timers.filter((timer) => timer.ms === ms && !timer.cleared).forEach((timer) => timer.fn()); await settle(); },
  };
  return page_;
}

const SIGNED = reply(200, { status: 'ok', signed_in: true });
const signingIn = (next, check = SIGNED) => (url) => (url === '/transcript-reader/signin' ? reply(200, { status: 'ok', next }) : check);
const passcodePage = async (s) => (await s.onTailnet({ path: '/transcript-reader/signin', headers: NAVIGATE })).raw;

test('signing in on the very address that asked for it loads that page again, a fragment included', async (t) => {
  const s = await boot();
  t.after(s.close);
  const page = await passcodePage(s);
  // A reader page opened with #s=..., or the reload after a sign-out: replacing the location with itself
  // would only move within the page, so the phone would sit on the passcode page after a correct passcode.
  const from = async (location, next) => { const opened = openPage(page, { location, answer: signingIn(next) }); await opened.submit(); return opened.moves; };
  assert.deepEqual(await from({ pathname: PAGE, search: '', hash: '#s=aaaaaaaa' }, PAGE + '#s=aaaaaaaa'), [['reload']]);
  assert.deepEqual(await from({ pathname: '/', search: '', hash: '' }, '/'), [['reload']]);
  // From the sign-in page itself, the server's answer is "/", a different address, so it moves there.
  assert.deepEqual(await from({ pathname: '/transcript-reader/signin', search: '', hash: '' }, '/'), [['replace', '/']]);
});

test('the passcode page sends the passcode and, once accepted, asks whether the cookie came back before it moves on', async (t) => {
  const s = await boot();
  t.after(s.close);
  const opened = openPage(await passcodePage(s), { answer: signingIn('/') });
  await opened.submit();
  assert.equal(opened.requests.length, 2);
  const [signin, check] = opened.requests;
  assert.equal(signin.url, '/transcript-reader/signin');
  assert.equal(signin.init.method, 'POST');
  assert.equal(signin.init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(signin.init.body), { passcode: 'correct horse battery', next: '/' });
  assert.equal(check.url, '/transcript-reader/signin?check=1');
  assert.equal(check.init.credentials, 'same-origin');
  assert.equal(check.init.cache, 'no-store');
  assert.deepEqual(opened.moves, [['reload']]);
  assert.equal(opened.message(), '');
});

test('the button says it is checking while the reader answers, and a second tap meanwhile sends nothing', async (t) => {
  const s = await boot();
  t.after(s.close);
  let release;
  const opened = openPage(await passcodePage(s), { answer: (url) => (url === '/transcript-reader/signin' ? new Promise((resolve) => { release = () => resolve(reply(401, { status: 'error', code: 'wrong_passcode', retry_after: 0 })); }) : SIGNED) });
  await opened.submit();
  assert.equal(opened.element('b').disabled, true);
  assert.equal(opened.element('b').textContent, 'Checking...');
  await opened.submit();
  assert.equal(opened.requests.length, 1, 'the second submit while it checks is ignored');
  release();
  await settle();
  assert.equal(opened.element('b').disabled, false);
  assert.equal(opened.element('b').textContent, 'Open the reader', 'the label comes back');
});

// What the person reads for each answer the server, the guard or something in between can give.
const ANSWERS = [
  ['a wrong passcode', reply(401, { status: 'error', code: 'wrong_passcode', retry_after: 0 }), /^Wrong passcode\.$/, true],
  ['a wrong passcode that locks the address', reply(401, { status: 'error', code: 'wrong_passcode', retry_after: 30 }), /^Wrong passcode\..*locked for 30 seconds/, true],
  ['a try during a lock', reply(429, { status: 'error', code: 'throttled', retry_after: 12 }), /^Too many wrong passcodes\. Try again in 12 seconds\.$/, false],
  ['too many passcodes being checked at once', reply(429, { status: 'error', code: 'busy', retry_after: 2 }), /busy.*Try again in a moment/, false],
  ['no passcode set on the laptop', reply(503, { status: 'error', code: 'no_passcode' }), /^No passcode is set on the laptop\./, false],
  ['a request the reader could not read', reply(400, { status: 'error', code: 'bad_request' }), /could not read the request \(HTTP 400\)/, false],
  ['an unexpected error in the reader', reply(500, { status: 'error', code: 'internal' }), /unexpected error/, false],
  ['a Host the guard refuses', reply(403, 'Host not allowed for this endpoint'), /^The reader refused the request \(HTTP 403: Host not allowed for this endpoint\)\. Open this page at the exact address/, false],
  ['an Origin the guard refuses', reply(403, 'Origin not allowed for this endpoint'), /HTTP 403: Origin not allowed for this endpoint/, false],
  ['a missing Origin', reply(403, 'Origin header required'), /HTTP 403: Origin header required/, false],
  ['a cross-site request', reply(403, 'Cross-site request refused'), /HTTP 403: Cross-site request refused/, false],
  ['a body that is not JSON', reply(415, 'JSON body required'), /HTTP 415: JSON body required/, false],
  ['a method the guard refuses', reply(405, 'Method not allowed'), /HTTP 405: Method not allowed/, false],
  ['an error page from something in between', reply(502, '<html><body>Bad gateway</body></html>'), /^The reader gave an answer this page cannot read \(HTTP 502\)\./, false],
  ['a login page from a proxy that answers 200', reply(200, '<html>Sign in to the network</html>'), /cannot read \(HTTP 200\)/, false],
  ['a refusal that is a page, not text', reply(403, '<html>Blocked</html>'), /^The reader refused the request \(HTTP 403\)\./, false],
  ['an empty answer', reply(500, ''), /cannot read \(HTTP 500\)/, false],
  ['JSON that is not the reader\'s', reply(200, { hello: 'world' }), /cannot read \(HTTP 200\)/, false],
];

for (const [name, answer, expected, clears] of ANSWERS) {
  test(`the passcode page says what happened for ${name}`, async (t) => {
    const s = await boot();
    t.after(s.close);
    const opened = openPage(await passcodePage(s), { answer: () => answer });
    await opened.submit();
    assert.match(opened.message(), expected);
    assert.doesNotMatch(opened.message(), /</, 'a body from the network is never shown as markup');
    assert.deepEqual(opened.moves, [], 'it stays on the page');
    assert.equal(opened.element('b').disabled, false, 'the button works again');
    assert.equal(opened.element('b').textContent, 'Open the reader');
    assert.equal(opened.element('p').value, clears ? '' : 'correct horse battery', clears ? 'a wrong passcode is cleared' : 'anything else keeps what was typed, to try again');
    assert.equal(opened.requests.length, 1, 'no cookie check without a correct passcode');
  });
}

test('the passcode page says so when the reader cannot be reached, or does not answer within 10 seconds', async (t) => {
  const s = await boot();
  t.after(s.close);
  const page = await passcodePage(s);
  const down = openPage(page, { answer: () => new Error('Load failed') });
  await down.submit();
  assert.match(down.message(), /^Could not reach the reader\. Check that this phone is on the tailnet/);
  assert.equal(down.element('b').disabled, false);
  assert.equal(down.element('p').value, 'correct horse battery');

  // No answer at all: the request is given up after 10 s (and told to stop), the page does not sit "checking".
  const silent = openPage(page, { answer: () => new Promise(() => {}) });
  await silent.submit();
  assert.equal(silent.element('b').textContent, 'Checking...');
  assert.equal(silent.timers.filter((timer) => timer.ms === 10000).length, 1);
  assert.equal(silent.requests[0].init.signal.aborted, false);
  await silent.fire(10000);
  assert.match(silent.message(), /^The reader did not answer within 10 seconds\./);
  assert.equal(silent.requests[0].init.signal.aborted, true);
  assert.equal(silent.element('b').disabled, false);
  assert.equal(silent.element('b').textContent, 'Open the reader');

  // The check after a correct passcode is covered the same way.
  const checking = openPage(page, { answer: (url) => (url === '/transcript-reader/signin' ? reply(200, { status: 'ok', next: '/' }) : new Promise(() => {})) });
  await checking.submit();
  await checking.fire(10000);
  assert.match(checking.message(), /did not answer within 10 seconds/);
  assert.deepEqual(checking.moves, []);

  // A late answer after giving up changes nothing.
  let late;
  const slow = openPage(page, { answer: () => new Promise((resolve) => { late = () => resolve(reply(200, { status: 'ok', next: '/' })); }) });
  await slow.submit();
  await slow.fire(10000);
  late();
  await settle();
  assert.deepEqual(slow.moves, []);
  assert.equal(slow.requests.length, 1);
});

test('a correct passcode whose cookie did not come back is said plainly, not left as a page that asks again', async (t) => {
  const s = await boot();
  t.after(s.close);
  const page = await passcodePage(s);
  const notKept = openPage(page, { answer: signingIn('/', reply(200, { status: 'ok', signed_in: false })) });
  await notKept.submit();
  assert.match(notKept.message(), /^The passcode was right, but this browser did not keep the sign-in cookie/);
  assert.deepEqual(notKept.moves, []);
  assert.equal(notKept.element('b').disabled, false);
  // A check that is refused or unreadable says that instead.
  const refused = openPage(page, { answer: signingIn('/', reply(403, 'Host not allowed for this endpoint')) });
  await refused.submit();
  assert.match(refused.message(), /HTTP 403: Host not allowed for this endpoint/);
  assert.deepEqual(refused.moves, []);
});

test('after a correct passcode a page that does not open is said, and the button is back', async (t) => {
  const s = await boot();
  t.after(s.close);
  const opened = openPage(await passcodePage(s), { answer: signingIn('/') });
  await opened.submit();
  assert.deepEqual(opened.moves, [['reload']]);
  assert.equal(opened.element('b').textContent, 'Opening...');
  assert.equal(opened.message(), '');
  await opened.fire(8000);
  assert.match(opened.message(), /^You are signed in, but the reader did not open\. Reload this page\./);
  assert.equal(opened.element('b').disabled, false);
});

test('a page whose script cannot run says so, and the script takes that message away as its first act', async (t) => {
  const s = await boot();
  t.after(s.close);
  const page = await passcodePage(s);
  const fallback = page.match(/<p id="w"[^>]*>([^<]*)<\/p>/);
  assert.ok(fallback, 'a plain message sits in the page without any script');
  assert.match(fallback[1], /did not start.*JavaScript is turned off.*blocked its script.*reload/);
  assert.ok(page.indexOf('id="w"') < page.indexOf('<script>'), 'it is in the markup the browser shows before and without the script');
  const opened = openPage(page, { answer: () => reply(401, { status: 'error', code: 'wrong_passcode', retry_after: 0 }) });
  assert.equal(opened.element('w').removed, true, 'once the script runs the message is gone');
  const signedInPage = (await s.onTailnet({ path: '/transcript-reader/signin', headers: { ...NAVIGATE, Cookie: await s.signedIn() } })).raw;
  assert.doesNotMatch(signedInPage, /id="w"/, 'the signed-in page has no script and no passcode form');
});

test('GET /transcript-reader/signin?check=1 says whether the request carries a session, and the guard still applies', async (t) => {
  const s = await boot();
  t.after(s.close);
  const check = (headers = {}) => s.onTailnet({ path: '/transcript-reader/signin?check=1', headers: { 'Sec-Fetch-Site': 'same-origin', ...headers } });
  const none = await check();
  assert.equal(none.status, 200);
  assert.deepEqual(none.json, { status: 'ok', signed_in: false });
  assert.match(none.headers['content-type'], /application\/json/);
  assert.equal((await check({ Cookie: 'pmos_session=nope' })).json.signed_in, false);
  const cookie = await s.signedIn();
  assert.deepEqual((await check({ Cookie: cookie })).json, { status: 'ok', signed_in: true });
  assert.equal((await check({ Host: 'evil.example:' + s.tailnetPort, Cookie: cookie })).status, 403);
  assert.equal((await check({ 'Sec-Fetch-Site': 'cross-site', Cookie: cookie })).status, 403);
  // Without ?check the same address is still the page.
  assert.match((await s.onTailnet({ path: '/transcript-reader/signin', headers: NAVIGATE })).raw, /<form id="f"/);
});

// ------------------------------------------------------------------- the sign-in record

test('every sign-in attempt is one log line with the client address and what came of it, and never the passcode', async (t) => {
  const s = await boot();
  t.after(s.close);
  const post = (body, headers = {}) => s.onTailnet({ method: 'POST', path: '/transcript-reader/signin', headers: { Origin: s.phone.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers }, body });
  const last = () => s.lines[s.lines.length - 1];
  const shape = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z Tailnet: sign-in from (127\.0\.0\.1|::ffff:127\.0\.0\.1): (.+)$/;
  const outcome = () => { const match = last().match(shape); assert.ok(match, last()); return match[2]; };

  assert.equal((await s.signIn(PASSCODE)).status, 200);
  assert.equal(outcome(), 'ok');
  assert.equal((await s.signIn('wrong one 1')).status, 401);
  assert.equal(outcome(), 'wrong passcode');
  await s.signIn('wrong one 2');
  await s.signIn('wrong one 3');
  assert.equal(outcome(), 'wrong passcode, now locked for 30 s');
  assert.equal((await s.signIn(PASSCODE)).status, 429);
  assert.match(outcome(), /^refused, locked for (29|30) more s$/);
  s.tick(31 * 1000);
  assert.equal((await s.signIn(PASSCODE)).status, 200);
  assert.equal(outcome(), 'ok');

  await post('not json');
  assert.equal(outcome(), 'bad request (400)');
  await post({ passcode: 12345678 });
  assert.equal(outcome(), 'bad request (400, no passcode in it)');
  await post('x'.repeat(5000));
  assert.equal(outcome(), 'bad request (413)');

  // What the guard refuses is a sign-in attempt too: the phone's side of "nothing happens".
  assert.equal((await post({ passcode: PASSCODE }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal(outcome(), 'refused by the guard (403 Origin not allowed for this endpoint)');
  assert.equal((await s.onTailnet({ method: 'POST', path: '/transcript-reader/signin', headers: { 'Content-Type': 'application/json' }, body: { passcode: PASSCODE } })).status, 403);
  assert.equal(outcome(), 'refused by the guard (403 Origin header required)');
  assert.equal((await post({ passcode: PASSCODE }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(outcome(), 'refused by the guard (403 Cross-site request refused)');
  assert.equal((await post({ passcode: PASSCODE }, { Host: 'evil.example:' + s.tailnetPort })).status, 403);
  assert.equal(outcome(), 'refused by the guard (403 Host not allowed for this endpoint)');

  fs.renameSync(s.passcodeFile, s.passcodeFile + '.gone');
  assert.equal((await s.signIn(PASSCODE)).status, 503);
  assert.equal(outcome(), 'no passcode is set');

  assert.ok(s.lines.every((line) => shape.test(line)), 'one line per attempt, all alike');
  assert.equal(s.lines.length, 14);
  const record = s.lines.join('\n');
  for (const secret of [PASSCODE, 'wrong one', 'xxxx']) assert.ok(!record.includes(secret), 'the record never holds a passcode: ' + secret);
});

test('a page request, a signed-in request and the cookie check add no sign-in line, except a check that finds no cookie', async (t) => {
  const s = await boot();
  t.after(s.close);
  const cookie = await s.signedIn();
  assert.equal(s.lines.length, 1);
  await s.onTailnet({ path: '/transcript-reader/signin', headers: NAVIGATE });
  await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } });
  await s.onTailnet({ path: '/transcript-reader/signin?check=1', headers: { 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
  assert.equal(s.lines.length, 1);
  // A phone that was told "ok" and then comes back without the cookie: the one thing the Mac's log could not show before.
  await s.onTailnet({ path: '/transcript-reader/signin?check=1', headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(s.lines.length, 2);
  assert.match(s.lines[1], /Tailnet: sign-in from \S+: cookie check failed: the browser sent no valid session cookie right after a correct passcode$/);
});

// ------------------------------------------------------------ Host, Origin, Fetch-Metadata

test('the tailnet listener still refuses a wrong Host, Origin or Fetch-Metadata, signed in or not', async (t) => {
  const s = await boot();
  t.after(s.close);
  const cookie = await s.signedIn();
  for (const headers of [{ Host: 'evil.example:' + s.tailnetPort }, { Host: s.loopback.host }, { Host: '127.0.0.1:1' }]) {
    for (const withCookie of [false, true]) {
      const response = await s.request(s.tailnetPort, { path: PAGE, headers: { ...NAVIGATE, ...headers, ...(withCookie ? { Cookie: cookie } : {}) } });
      assert.equal(response.status, 403, JSON.stringify(headers));
    }
  }
  const post = (headers) => s.onTailnet({ method: 'POST', path: '/transcript-reader/signin', headers: { 'Content-Type': 'application/json', ...headers }, body: { passcode: PASSCODE } });
  assert.equal((await post({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ Origin: s.loopback.origin })).status, 403, 'the loopback origin is not the tailnet listener\'s');
  assert.equal((await post({})).status, 403, 'a POST needs its Origin');
  assert.equal((await post({ Origin: s.phone.origin, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await s.onTailnet({ path: '/api/transcript-reader/state', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await s.onTailnet({ method: 'OPTIONS', path: '/api/transcript-reader/state', headers: { Cookie: cookie } })).status, 403);
  // Signed in, an API call with a wrong Origin on a POST is still refused.
  const token = tokenIn((await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } })).raw);
  const badOrigin = await s.onTailnet({ method: 'POST', path: '/api/transcript-reader/send', headers: { Cookie: cookie, Origin: s.loopback.origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: token }, body: { session_id: A, text: 'hello' } });
  assert.equal(badOrigin.status, 403);
  assert.equal(s.herdr.prompts().length, 0);
  assert.equal((await post({ Origin: s.phone.origin })).status, 200, 'and the right ones are accepted');
});

// ------------------------------------------------------------------------- passcode

test('a correct passcode sets an HttpOnly, SameSite=Strict session cookie and the page, the API and Send then work', async (t) => {
  const s = await boot();
  t.after(s.close);
  const signIn = await s.signIn(PASSCODE);
  assert.equal(signIn.status, 200);
  assert.equal(signIn.json.next, PAGE);
  const setCookie = signIn.headers['set-cookie'][0];
  assert.match(setCookie, /^pmos_session=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; Max-Age=2592000/);
  assert.ok(!signIn.raw.includes(PASSCODE));
  const cookie = s.cookieFrom(signIn);

  const root = await s.onTailnet({ path: '/', headers: { ...NAVIGATE, Cookie: cookie } });
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, PAGE);
  const page = await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.raw, /page body/);
  const token = tokenIn(page.raw);
  assert.match(token, /^[0-9a-f]{64}$/);

  const state = await s.onTailnet({ path: '/api/transcript-reader/state', headers: { Cookie: cookie, [TOKEN_HEADER]: token } });
  assert.equal(state.status, 200);
  // Send reaches the pane through the same checks as on loopback.
  const sent = await s.onTailnet({ method: 'POST', path: '/api/transcript-reader/send', headers: { Cookie: cookie, Origin: s.phone.origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: token, 'Sec-Fetch-Site': 'same-origin' }, body: { session_id: A, text: 'from the phone' } });
  assert.equal(sent.status, 200, sent.raw);
  assert.deepEqual(s.herdr.prompts().map((call) => call.args[5]), ['from the phone']);
  const pin = await s.onTailnet({ path: '/api/transcript-reader/pins', headers: { Cookie: cookie, [TOKEN_HEADER]: token } });
  assert.equal(pin.status, 200);
});

// A photo for a message goes through the same lane as Send: the phone's passcode sign-in, then Host, Origin, Fetch-Metadata and the page's token.
test('photos over the tailnet: the upload needs the sign-in and then the token, and with both a photo is saved and Send names it', async (t) => {
  const s = await boot();
  t.after(s.close);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]), Buffer.alloc(16)]);
  const body = { name: 'from-the-phone.png', data: png.toString('base64') };
  const uploads = path.join(s.base, 'repo', 'setup', 'transcript-reader', 'out', 'uploads');
  const post = (command, extra, payload) => s.onTailnet({ method: 'POST', path: '/api/transcript-reader/' + command, headers: { Origin: s.phone.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...extra }, body: payload });

  const unsigned = await post('upload', {}, body);
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.json.code, 'sign_in_required');
  assert.equal(fs.existsSync(uploads), false, 'nothing was saved for a phone that is not signed in');

  const cookie = await s.signedIn();
  const page = await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } });
  const token = tokenIn(page.raw);
  const noToken = await post('upload', { Cookie: cookie }, body);
  assert.equal(noToken.status, 403, 'a session is not enough on its own');
  assert.equal(fs.existsSync(uploads), false);
  const badOrigin = await post('upload', { Cookie: cookie, [TOKEN_HEADER]: token, Origin: s.loopback.origin }, body);
  assert.equal(badOrigin.status, 403, 'the loopback address is not the phone\'s origin');
  assert.equal(fs.existsSync(uploads), false);

  const saved = await post('upload', { Cookie: cookie, [TOKEN_HEADER]: token }, body);
  assert.equal(saved.status, 200, saved.raw);
  assert.match(saved.json.id, /^[0-9a-f]{32}\.png$/);
  assert.equal(fs.statSync(path.join(uploads, saved.json.id)).mode & 0o777, 0o600);
  const sent = await post('send', { Cookie: cookie, [TOKEN_HEADER]: token }, { session_id: A, text: 'from the phone', images: [saved.json.id] });
  assert.equal(sent.status, 200, sent.raw);
  const typed = `from the phone\n\nAttached image: ${fs.realpathSync(uploads)}/${saved.json.id}`;
  assert.equal(sent.json.text, typed);
  assert.deepEqual(s.herdr.prompts().map((call) => call.args[5]), [typed]);
  // The photo is not on the tailnet's address as a file either, with the sign-in and the token or without.
  for (const headers of [{ Cookie: cookie, [TOKEN_HEADER]: token }, { Cookie: cookie }, {}]) {
    const direct = await s.onTailnet({ path: '/setup/transcript-reader/out/uploads/' + saved.json.id, headers: { ...NAVIGATE, ...headers } });
    assert.notEqual(direct.status, 200);
    assert.equal(direct.raw.includes('IHDR'), false);
  }
});

test('a session is not enough on its own: the API still needs the token, and the token is not enough without a session', async (t) => {
  const s = await boot();
  t.after(s.close);
  const cookie = await s.signedIn();
  const token = tokenIn((await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } })).raw);
  assert.equal((await s.onTailnet({ path: '/api/transcript-reader/state', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await s.onTailnet({ path: '/api/transcript-reader/state', headers: { Cookie: cookie, [TOKEN_HEADER]: 'f'.repeat(64) } })).status, 403);
  assert.equal((await s.onTailnet({ path: '/api/transcript-reader/state', headers: { [TOKEN_HEADER]: token } })).status, 401);
  // Another browser tab opening a page as a script (not a navigation) gets no token, as on loopback.
  assert.equal((await s.onTailnet({ path: PAGE, headers: { Cookie: cookie, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } })).status, 403);
});

test('an HTML file opens on the phone: the signed-in page gets the address, the sandboxed frame loads it with no cookie, and no one else gets in', async (t) => {
  const s = await boot();
  t.after(s.close);
  const sketch = path.join(s.base, 'sketch');
  fs.mkdirSync(sketch);
  fs.writeFileSync(path.join(sketch, 'region.html'), '<p>sketch</p><link rel="stylesheet" href="style.css">');
  fs.writeFileSync(path.join(sketch, 'style.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(s.base, 'repo', 'setup', 'transcript-reader', 'out', 'html-files.json'), JSON.stringify({ aaaaaaaaaa: path.join(fs.realpathSync(sketch), 'region.html') }));
  const cookie = await s.signedIn();
  const token = tokenIn((await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } })).raw);
  const open = (headers) => s.onTailnet({ method: 'POST', path: '/api/transcript-reader/html-open', headers: { Origin: s.phone.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers }, body: { id: 'aaaaaaaaaa' } });
  assert.equal((await open({ [TOKEN_HEADER]: token })).status, 401, 'opening a file needs the session');
  assert.equal((await open({ Cookie: cookie })).status, 403, 'and the token');
  const opened = await open({ Cookie: cookie, [TOKEN_HEADER]: token });
  assert.equal(opened.status, 200, opened.raw);
  // What the sandboxed frame sends: the navigation from the page carries the cookie, but the files it loads are cross-site and carry none.
  const frame = (urlPath, headers = {}) => s.onTailnet({ path: urlPath, headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script', ...headers } });
  const shown = await frame(opened.json.url);
  assert.equal(shown.status, 200);
  assert.match(shown.raw, /sketch/);
  assert.match(shown.headers['content-security-policy'], /^sandbox allow-scripts;/);
  assert.equal(shown.headers['set-cookie'], undefined, 'the viewer does not renew or set a session');
  assert.equal((await frame(opened.json.url.replace('region.html', 'style.css'))).status, 200);
  // The exception is for the viewer's address alone, and the Host check still holds.
  assert.equal((await frame('/api/transcript-reader/state', { [TOKEN_HEADER]: token })).status, 403, 'the API, cross-site and without a session');
  assert.equal((await frame(PAGE)).status, 403);
  assert.equal((await frame(opened.json.url, { Host: s.loopback.host })).status, 403, 'another host');
  assert.equal((await frame(opened.json.url, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await frame(opened.json.url.replace(/html\/[^/]+\//, 'html/' + 'x'.repeat(22) + '/'))).status, 404, 'a key that was never given');
  assert.equal((await s.onTailnet({ method: 'POST', path: opened.json.url, headers: { Origin: s.phone.origin, 'Content-Type': 'application/json' }, body: {} })).status, 401, 'a POST to it needs the session like any other');
  // Another device on the tailnet without the key gets the passcode page or nothing, never the file.
  assert.equal((await s.onTailnet({ path: '/api/transcript-reader/html/', headers: NAVIGATE })).status, 404);
});

test('wrong passcodes are throttled per client address with a growing lock, and a lock holds even for the right passcode', async (t) => {
  const s = await boot();
  t.after(s.close);
  assert.equal((await s.signIn('wrong one 1')).status, 401);
  assert.equal((await s.signIn('wrong one 2')).status, 401);
  const third = await s.signIn('wrong one 3');
  assert.equal(third.status, 401);
  assert.equal(third.json.retry_after, 30, 'the third wrong try locks the address for 30 s');
  const locked = await s.signIn(PASSCODE);
  assert.equal(locked.status, 429);
  assert.equal(locked.json.code, 'throttled');
  assert.ok(Number(locked.headers['retry-after']) > 0 && Number(locked.headers['retry-after']) <= 30);
  assert.equal(locked.headers['set-cookie'], undefined);
  s.tick(31 * 1000);
  const fourth = await s.signIn('wrong one 4');
  assert.equal(fourth.status, 401);
  assert.equal(fourth.json.retry_after, 60, 'the next lock is twice as long');
  s.tick(61 * 1000);
  const ok = await s.signIn(PASSCODE);
  assert.equal(ok.status, 200, 'the right passcode works once the lock is over');
  // And the count starts again after a success.
  assert.equal((await s.signIn('wrong again 1')).status, 401);
  assert.equal((await s.signIn('wrong again 2')).status, 401);
});

test('wrong passcodes sent all at once cannot beat the lock', async (t) => {
  const s = await boot();
  t.after(s.close);
  const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => s.signIn('wrong burst ' + i)));
  const statuses = answers.map((answer) => answer.status);
  assert.ok(statuses.filter((status) => status === 401).length <= 3, statuses.join());
  assert.ok(statuses.every((status) => status === 401 || status === 429), statuses.join());
  assert.equal((await s.signIn(PASSCODE)).status, 429);
});

test('a malformed sign-in is refused without a session', async (t) => {
  const s = await boot();
  t.after(s.close);
  const post = (body, headers = {}) => s.onTailnet({ method: 'POST', path: '/transcript-reader/signin', headers: { Origin: s.phone.origin, 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post({ passcode: 12345678 })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post('x'.repeat(5000))).status, 413);
  assert.equal((await s.onTailnet({ method: 'POST', path: '/transcript-reader/signin', headers: { Origin: s.phone.origin, 'Content-Type': 'text/plain' }, body: 'passcode=x' })).status, 415);
  assert.equal((await post({ passcode: '' })).status, 401);
  assert.equal((await post({ passcode: 'x'.repeat(300) })).status, 401);
});

test('the page after sign-in goes only to a path on the same origin', () => {
  assert.equal(tailnet.safeNext(PAGE), PAGE);
  assert.equal(tailnet.safeNext(PAGE + '?a=1#b'), PAGE + '?a=1#b');
  for (const bad of ['//evil.example/x', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '', undefined, 5, '/a b', '/transcript-reader/signin', '/transcript-reader/signout', '/' + 'a'.repeat(3000)]) {
    assert.equal(tailnet.safeNext(bad), '/', String(bad));
  }
});

// ------------------------------------------------------------------------ sessions

test('sign-out ends the session, and a restart, a new passcode or a removed passcode file signs the phone out', async (t) => {
  const s = await boot();
  t.after(s.close);
  const cookie = await s.signedIn();
  const open = () => s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } });
  assert.equal((await open()).status, 200);
  const signedInPage = await s.onTailnet({ path: '/transcript-reader/signin', headers: { ...NAVIGATE, Cookie: cookie } });
  assert.match(signedInPage.raw, /Sign out/);

  // A new passcode ends every session made under the old one.
  await tailnet.writePasscodeFile(s.passcodeFile, 'a brand new passcode');
  assert.equal((await open()).status, 401);
  assert.equal((await s.signIn(PASSCODE)).status, 401, 'the old passcode no longer works');
  const second = await s.signIn('a brand new passcode');
  assert.equal(second.status, 200);
  const fresh = s.cookieFrom(second);
  const openFresh = () => s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: fresh } });
  assert.equal((await openFresh()).status, 200);

  const out = await s.onTailnet({ path: '/transcript-reader/signout', headers: { ...NAVIGATE, Cookie: fresh } });
  assert.equal(out.status, 303);
  assert.equal(out.headers.location, '/transcript-reader/signin');
  assert.match(out.headers['set-cookie'][0], /^pmos_session=;.*Max-Age=0/);
  assert.equal((await openFresh()).status, 401);

  // Removing the file shuts the address off for everyone, signed in or not.
  const third = await s.signIn('a brand new passcode');
  assert.equal(third.status, 200);
  fs.renameSync(s.passcodeFile, s.passcodeFile + '.gone');
  assert.equal((await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: s.cookieFrom(third) } })).status, 401);
  assert.equal((await s.signIn('a brand new passcode')).status, 503);
});

test('a session lasts 30 days from its last use, survives a restart, and is known only to servers sharing the passcode file', async (t) => {
  const s = await boot();
  t.after(s.close);
  const cookie = await s.signedIn();
  const open = (c = cookie) => s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: c } });
  const day = 24 * 3600 * 1000;
  s.tick(20 * day);
  assert.equal((await open()).status, 200);
  s.tick(20 * day);
  const renewed = await open();
  assert.equal(renewed.status, 200, 'used within 30 days of the last use');
  assert.match(renewed.headers['set-cookie'][0], /Max-Age=2592000/, 'and its cookie is renewed with it');
  s.tick(31 * day);
  assert.equal((await open()).status, 401, 'idle for more than 30 days');

  // A restart (a new server over the same passcode file) keeps the phone signed in...
  const fresh = await s.signedIn();
  const restarted = await boot({ sharedPasscodeFile: s.passcodeFile });
  t.after(restarted.close);
  assert.equal((await restarted.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: fresh } })).status, 200, 'a restart keeps the session');
  // ...and so does a second server on the same file, while a server with another passcode file never heard of it.
  const other = await boot();
  t.after(other.close);
  assert.equal((await other.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: fresh } })).status, 401, 'a cookie from a server with another passcode file is no session');
  // A sign-out on one server ends the session on the other.
  await s.onTailnet({ path: '/transcript-reader/signout', headers: { ...NAVIGATE, Cookie: fresh } });
  assert.equal((await restarted.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: fresh } })).status, 401, 'signed out everywhere that shares the file');
});

test('sessions are one owner-only file each beside the passcode file, named by a hash, holding no token or passcode', async (t) => {
  const s = await boot();
  t.after(s.close);
  const cookie = await s.signedIn();
  const token = cookie.split('=')[1];
  const dir = s.passcodeFile + '.sessions';
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const names = fs.readdirSync(dir);
  assert.equal(names.length, 1);
  assert.match(names[0], /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(dir, names[0])).mode & 0o777, 0o600);
  const text = fs.readFileSync(path.join(dir, names[0]), 'utf8');
  assert.equal(text.includes(token), false, 'the token itself is not stored');
  assert.equal(names[0].includes(token), false);
  const record = fs.readFileSync(s.passcodeFile, 'utf8');
  assert.equal(text.includes(JSON.parse(record).hash), false, 'nor the passcode hash');
  // no more than 20 live sessions: the oldest goes first
  for (let i = 0; i < 25; i += 1) { s.tick(1000); await s.signIn(PASSCODE); }
  assert.ok(fs.readdirSync(dir).length <= 20);
});

// ----------------------------------------------------------- the listener itself

test('no passcode set means no tailnet listener, and the reason is reported', async (t) => {
  const s = await boot({ passcode: null });
  t.after(s.close);
  assert.equal(s.server.tailnet, null);
  assert.match(s.server.tailnetError, /no passcode is set/);
  await assert.rejects(s.request(s.tailnetPort, { path: PAGE, headers: { Host: s.phone.host } }), { code: 'ECONNREFUSED' });
  assert.equal((await s.onLoopback({ path: PAGE, headers: NAVIGATE })).status, 200, 'loopback serves as usual');
});

test('an address that cannot be bound leaves loopback serving and says so', async (t) => {
  const taken = await freePort();
  const holder = net.createServer().listen(taken, '127.0.0.1');
  await new Promise((resolve) => holder.once('listening', resolve));
  t.after(() => holder.close());
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-tailnet-'));
  const passcodeFile = path.join(base, 'passcode.json');
  await tailnet.writePasscodeFile(passcodeFile, PASSCODE);
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, 'setup', 'transcript-reader', 'out'), { recursive: true });
  const server = await start({ root, port: await freePort(), tailnet: { ip: '127.0.0.1', port: taken, passcodeFile }, env: {}, pinsFile: path.join(base, 'pins.json') });
  t.after(() => server.close());
  assert.equal(server.tailnet, null);
  assert.match(server.tailnetError, /could not be bound \(EADDRINUSE\)/);
});

test('the tailnet listener binds one given IPv4 address, never every interface', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-tailnet-'));
  for (const ip of ['0.0.0.0', '::', '', '::1', 'localhost', undefined]) {
    assert.throws(() => start({ root: base, port: 1, tailnet: { ip, passcodeFile: path.join(base, 'p') } }), /one IPv4 address/, String(ip));
  }
  assert.equal(isTailnetAddress('100.97.27.50'), true);
  for (const ip of ['0.0.0.0', '127.0.0.1', '192.168.1.5', '100.63.255.255', '100.128.0.0', '100.97.27', '100.97.27.256', '100.097.27.50', '::1', '']) assert.equal(isTailnetAddress(ip), false, ip);
  const real = (() => { try { return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim(); } catch { return ''; } })();
  if (real) assert.equal(isTailnetAddress(real), true, 'tailscale ip -4 answers inside 100.64.0.0/10');
});

test('with Tailscale up, the real Tailscale address serves the sign-in and the page, and only that address', async (t) => {
  let ip = '';
  try { ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim(); } catch { /* not installed or not running */ }
  if (!isTailnetAddress(ip)) { t.skip('Tailscale does not answer on this machine'); return; }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-tailnet-'));
  const passcodeFile = path.join(base, 'passcode.json');
  await tailnet.writePasscodeFile(passcodeFile, PASSCODE);
  const root = path.join(base, 'repo');
  const outDir = path.join(root, 'setup', 'transcript-reader', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'prototype.html'), `<!doctype html><head>${TOKEN_META}</head>page body`);
  const port = await freePort();
  const lines = [];
  const server = await start({ root, port, tailnet: { ip, passcodeFile }, env: {}, pinsFile: path.join(base, 'pins.json'), log: (line) => lines.push(line) });
  t.after(() => server.close());
  assert.deepEqual(server.tailnet, { ip, port });
  const request = (options) => new Promise((resolve, reject) => {
    const payload = options.body && JSON.stringify(options.body);
    const req = http.request({ host: ip, port, method: options.method || 'GET', path: options.path, headers: { Host: `${ip}:${port}`, ...options.headers, ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  assert.equal((await request({ path: PAGE, headers: NAVIGATE })).status, 401);
  const signIn = await request({ method: 'POST', path: '/transcript-reader/signin', headers: { Origin: `http://${ip}:${port}`, 'Content-Type': 'application/json' }, body: { passcode: PASSCODE, next: PAGE } });
  assert.equal(signIn.status, 200);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`Tailnet: sign-in from (::ffff:)?${ip.replace(/\./g, '\\.')}: ok$`), 'the record names the address the request came from');
  const page = await request({ path: PAGE, headers: { ...NAVIGATE, Cookie: signIn.headers['set-cookie'][0].split(';')[0] } });
  assert.equal(page.status, 200);
  assert.match(page.raw, /page body/);
  // The listeners are exactly loopback and that one address.
  const listening = execFileSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }).split('\n').filter((line) => line.startsWith('n')).sort();
  const allowed = [`n${ip}:${port}`, `n127.0.0.1:${port}`, `n[::1]:${port}`];
  assert.ok(listening.every((line) => allowed.includes(line)), listening.join());
  assert.ok(listening.includes(`n${ip}:${port}`) && listening.includes(`n127.0.0.1:${port}`), listening.join());
});

// ---------------------------------------------------------------- the passcode file

test('the passcode file holds only a salted scrypt hash, owner-only, with no default passcode', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-passcode-'));
  const file = path.join(base, 'out', 'passcode.json');
  const umask = process.umask(0o022);
  try {
    await tailnet.writePasscodeFile(file, PASSCODE);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(PASSCODE));
    const record = tailnet.parseRecord(raw);
    assert.equal(record.alg, 'scrypt');
    assert.ok(record.N >= 2 ** 14);
    assert.equal(Buffer.from(record.salt, 'base64').length, 16);
    assert.equal(await tailnet.passcodeMatches(record, PASSCODE), true);
    assert.equal(await tailnet.passcodeMatches(record, PASSCODE + ' '), false);
    // The same passcode hashed again gets another salt, so the two files differ.
    await tailnet.writePasscodeFile(file + '.2', PASSCODE);
    assert.notEqual(fs.readFileSync(file + '.2', 'utf8'), raw);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['passcode.json', 'passcode.json.2'], 'no temporary file is left behind');
  } finally { process.umask(umask); }
  await assert.rejects(tailnet.writePasscodeFile(path.join(base, 'short.json'), 'short'), /at least 8/);
  assert.ok(!fs.existsSync(path.join(base, 'short.json')));
  for (const bad of ['', 'not json', '{}', JSON.stringify({ v: 1, alg: 'scrypt', N: 3, r: 8, p: 1, keylen: 32, salt: 'AA==', hash: 'AA==' }), JSON.stringify({ v: 2 })]) assert.equal(tailnet.parseRecord(bad), null, bad);
});

test('passcode.js refuses to take the passcode from anything but a terminal, and writes nothing', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-passcode-'));
  const file = path.join(base, 'passcode.json');
  const { spawnSync } = require('child_process');
  const result = spawnSync('node', [path.join(__dirname, 'passcode.js'), file], { input: PASSCODE + '\n' + PASSCODE + '\n', encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /terminal/);
  assert.ok(!fs.existsSync(file));
  assert.ok(!(result.stdout + result.stderr).includes(PASSCODE));
});

// ------------------------------------------------------------------- the shared guard

test('the shared guard accepts only the hosts it is given, and loopback when none are given', () => {
  const request = (host, origin) => ({ method: 'GET', headers: { host, ...(origin ? { origin } : {}) } });
  const dflt = createGuard({ port: 9000 });
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(dflt.check(request(host + ':9000', 'http://' + host + ':9000'), { requireToken: false }).ok, true, host);
  assert.equal(dflt.check(request('100.97.27.50:9000'), { requireToken: false }).ok, false);
  const phone = createGuard({ port: 9000, hosts: ['100.97.27.50'] });
  assert.equal(phone.check(request('100.97.27.50:9000', 'http://100.97.27.50:9000'), { requireToken: false }).ok, true);
  for (const host of ['localhost:9000', '127.0.0.1:9000', '100.97.27.50:9001', '100.97.27.51:9000']) assert.equal(phone.check(request(host), { requireToken: false }).ok, false, host);
  assert.equal(phone.check(request('100.97.27.50:9000', 'http://localhost:9000'), { requireToken: false }).ok, false);
  assert.throws(() => createGuard({ port: 9000, hosts: [] }), /at least one host/);
});

test('the shared guard lets a cross-site GET through only when asked, and still checks Host and Origin', () => {
  const guard = createGuard({ port: 9000 });
  const get = (headers) => ({ method: 'GET', headers: { host: 'localhost:9000', ...headers } });
  const loose = { requireToken: false, crossSite: true };
  assert.equal(guard.check(get({ 'sec-fetch-site': 'cross-site' }), { requireToken: false }).ok, false, 'refused by default');
  assert.equal(guard.check(get({ 'sec-fetch-site': 'cross-site' }), loose).ok, true);
  assert.equal(guard.check(get({ 'sec-fetch-site': 'same-site' }), loose).ok, true);
  assert.equal(guard.check(get({ 'sec-fetch-site': 'cross-site', host: 'evil.example:9000' }), loose).ok, false);
  assert.equal(guard.check(get({ 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' }), loose).ok, false);
  assert.equal(guard.check(get({ 'sec-fetch-site': 'cross-site', origin: 'null' }), loose).ok, false);
  assert.equal(guard.check({ method: 'POST', headers: { host: 'localhost:9000', origin: 'http://localhost:9000', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }, loose).ok, false, 'never for a POST');
  assert.equal(guard.check(get({ 'sec-fetch-site': 'cross-site' }), { crossSite: true }).ok, false, 'the token is still required unless waived');
});

// ---------------------------------------------------------------- HTTPS on the tailnet address

const HOST = 'reader-test.example.ts.net';
async function bootSecure(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-cert-'));
  const cert = makeCertificate(dir, HOST);
  if (!cert) { t.skip('openssl cannot make a scratch certificate here'); return null; }
  const s = await boot({ secure: { ...cert, ...extra } });
  t.after(s.close);
  return { ...s, cert, dir };
}
const SECURE_ORIGIN = (s) => `https://${HOST}:${s.httpsPort}`;
const signInSecure = (s, passcode = PASSCODE, headers = {}) => s.onHttps({ method: 'POST', path: '/transcript-reader/signin', headers: { Origin: SECURE_ORIGIN(s), 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers }, body: { passcode, next: PAGE } });

test('the TLS listener serves the Tailscale name with the certificate it was given, beside the plain listener', async (t) => {
  const s = await bootSecure(t);
  if (!s) return;
  assert.deepEqual(s.server.tailnet.https.host, HOST);
  assert.equal(s.server.tailnet.https.port, s.httpsPort);
  assert.equal(s.server.httpsError, null);
  assert.ok(s.server.tailnet.https.expires > Date.now() / 1000);
  const page = await s.onHttps({ path: PAGE, headers: NAVIGATE });
  assert.equal(page.status, 401, 'the passcode page, over TLS');
  assert.match(page.raw, /Passcode/);
  assert.equal(page.cert.subject.CN, HOST);
  // The plain tailnet listener keeps working until the owner switches.
  assert.equal((await s.onTailnet({ path: PAGE, headers: NAVIGATE })).status, 401);
  const plainCookie = await s.signedIn();
  assert.equal((await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: plainCookie } })).status, 200);
});

test('the passcode gate holds on the TLS listener: no session, no page, no API, no probing', async (t) => {
  const s = await bootSecure(t);
  if (!s) return;
  for (const [urlPath, headers] of [[PAGE, NAVIGATE], ['/', NAVIGATE], ['/setup/transcript-reader/out/hosted/index.html', NAVIGATE], ['/setup/transcript-reader/out/bucket/index.json.enc', {}],
    ['/api/transcript-reader/state', {}], ['/api/transcript-reader/queue', {}], ['/api/transcript-reader/pins', {}], ['/api/transcript-reader/html-open', {}], ['/anything/else', {}]]) {
    const response = await s.onHttps({ path: urlPath, headers });
    assert.equal(response.status, 401, urlPath);
    assert.ok(!/reader-token|content="[0-9a-f]{64}"/.test(response.raw), 'no token to anyone signed out: ' + urlPath);
  }
  for (const stale of ['pmos_session=AAAA', 'pmos_session=' + 'A'.repeat(43)]) {
    assert.equal((await s.onHttps({ path: PAGE, headers: { ...NAVIGATE, Cookie: stale } })).status, 401);
  }
  assert.equal(s.herdr.prompts().length, 0);
  // A wrong passcode is refused and counted like on the plain listener.
  const wrong = await signInSecure(s, 'wrong passcode here');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.code, 'wrong_passcode');
  assert.ok(!(wrong.headers['set-cookie'] || []).length);
});

test('a correct passcode over TLS sets a Secure session cookie, and the page, the API and Send then work', async (t) => {
  const s = await bootSecure(t);
  if (!s) return;
  const signIn = await signInSecure(s);
  assert.equal(signIn.status, 200, signIn.raw);
  const setCookie = signIn.headers['set-cookie'][0];
  assert.match(setCookie, /^pmos_session=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  assert.match(setCookie, /; Secure/);
  const cookie = setCookie.split(';')[0];
  const page = await s.onHttps({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } });
  assert.equal(page.status, 200);
  const token = tokenIn(page.raw);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((await s.onHttps({ path: '/api/transcript-reader/state', headers: { Cookie: cookie, [TOKEN_HEADER]: token } })).status, 200);
  assert.equal((await s.onHttps({ path: '/api/transcript-reader/state', headers: { Cookie: cookie } })).status, 403, 'the session alone is not enough');
  const sent = await s.onHttps({ method: 'POST', path: '/api/transcript-reader/send', headers: { Cookie: cookie, Origin: SECURE_ORIGIN(s), 'Content-Type': 'application/json', [TOKEN_HEADER]: token, 'Sec-Fetch-Site': 'same-origin' }, body: { session_id: A, text: 'over TLS' } });
  assert.equal(sent.status, 200, sent.raw);
  assert.deepEqual(s.herdr.prompts().map((call) => call.args[5]), ['over TLS']);
  // The plain listener's cookie has no Secure flag, as before.
  assert.ok(!/Secure/.test((await signIn_plain(s)).headers['set-cookie'][0]));
});
const signIn_plain = (s) => s.signIn(PASSCODE);

test('the TLS listener refuses another Host, a plain-http Origin and Fetch-Metadata cross-site, signed in or not', async (t) => {
  const s = await bootSecure(t);
  if (!s) return;
  const cookie = (await signInSecure(s)).headers['set-cookie'][0].split(';')[0];
  for (const headers of [{ Host: `127.0.0.1:${s.httpsPort}` }, { Host: `evil.example:${s.httpsPort}` }, { Host: HOST }, { Host: s.phone.host }, { Host: s.loopback.host }]) {
    for (const withCookie of [false, true]) {
      assert.equal((await s.onHttps({ path: PAGE, headers: { ...NAVIGATE, ...headers, ...(withCookie ? { Cookie: cookie } : {}) } })).status, 403, JSON.stringify(headers));
    }
  }
  const post = (headers) => s.onHttps({ method: 'POST', path: '/transcript-reader/signin', headers: { 'Content-Type': 'application/json', ...headers }, body: { passcode: PASSCODE } });
  assert.equal((await post({ Origin: `http://${HOST}:${s.httpsPort}` })).status, 403, 'an http origin is not the TLS listener\'s');
  assert.equal((await post({ Origin: s.phone.origin })).status, 403, 'the plain listener\'s origin is not the TLS listener\'s');
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ Origin: SECURE_ORIGIN(s), 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ Origin: SECURE_ORIGIN(s) })).status, 200);
  // And the plain listener does not take the TLS name.
  assert.equal((await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Host: `${HOST}:${s.tailnetPort}` } })).status, 403);
});

test('a sign-out over TLS ends the session, and a new passcode signs the TLS device out too', async (t) => {
  const s = await bootSecure(t);
  if (!s) return;
  const cookie = (await signInSecure(s)).headers['set-cookie'][0].split(';')[0];
  assert.equal((await s.onHttps({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } })).status, 200);
  const out = await s.onHttps({ path: '/transcript-reader/signout', headers: { ...NAVIGATE, Cookie: cookie } });
  assert.equal(out.status, 303);
  assert.match(out.headers['set-cookie'][0], /Max-Age=0.*Secure/);
  assert.equal((await s.onHttps({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } })).status, 401);
  const again = (await signInSecure(s)).headers['set-cookie'][0].split(';')[0];
  await tailnet.writePasscodeFile(s.passcodeFile, 'another passcode entirely');
  assert.equal((await s.onHttps({ path: PAGE, headers: { ...NAVIGATE, Cookie: again } })).status, 401);
});

test('a missing, mismatched, unreadable or expired certificate leaves the plain listener serving and gives one plain reason', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-cert-'));
  const good = makeCertificate(dir, HOST);
  const other = makeCertificate(path.join(dir, 'other'), 'someone-else.example.ts.net');
  if (!good || !other) { t.skip('openssl cannot make a scratch certificate here'); return; }
  const expired = makeCertificate(path.join(dir, 'expired'), HOST, 0);
  const cases = [
    ['missing', { host: HOST, certFile: path.join(dir, 'none.crt'), keyFile: path.join(dir, 'none.key') }, /certificate is not there/],
    ['another name', { host: HOST, certFile: other.certFile, keyFile: other.keyFile }, /not for reader-test\.example\.ts\.net/],
    ['key of another certificate', { host: HOST, certFile: good.certFile, keyFile: other.keyFile }, /cannot be read/],
    ['no machine name', { host: '', certFile: good.certFile, keyFile: good.keyFile }, /no Tailscale name/],
    ['an address, not a name', { host: '100.97.27.50', certFile: good.certFile, keyFile: good.keyFile }, /no Tailscale name/],
  ];
  if (expired) cases.push(['expired', { host: HOST, certFile: expired.certFile, keyFile: expired.keyFile }, /expired/]);
  for (const [name, secure, reason] of cases) {
    const s = await boot({ secure });
    t.after(s.close);
    assert.match(s.server.httpsError, reason, name);
    assert.equal(s.server.tailnet.https, undefined, name);
    assert.equal((await s.onTailnet({ path: PAGE, headers: NAVIGATE })).status, 401, name + ': the plain listener serves as before');
    await assert.rejects(s.onHttps({ path: PAGE, headers: NAVIGATE }), { code: 'ECONNREFUSED' }, name);
  }
});

test('a TLS port that cannot be bound is said, and the plain listener keeps serving', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-cert-'));
  const cert = makeCertificate(dir, HOST);
  if (!cert) { t.skip('openssl cannot make a scratch certificate here'); return; }
  const taken = await freePort();
  const holder = net.createServer().listen(taken, '127.0.0.1');
  await new Promise((resolve) => holder.once('listening', resolve));
  t.after(() => holder.close());
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-tailnet-'));
  const passcodeFile = path.join(base, 'passcode.json');
  await tailnet.writePasscodeFile(passcodeFile, PASSCODE);
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, 'setup', 'transcript-reader', 'out'), { recursive: true });
  const server = await start({ root, port: await freePort(), tailnet: { ip: '127.0.0.1', port: await freePort(), passcodeFile, https: { ...cert, port: taken } }, env: {}, pinsFile: path.join(base, 'pins.json') });
  t.after(() => server.close());
  assert.ok(server.tailnet, 'the plain listener is up');
  assert.equal(server.tailnet.https, undefined);
  assert.match(server.httpsError, /could not be bound \(EADDRINUSE\)/);
});

test('no passcode set means no TLS listener either, with the same reason', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-cert-'));
  const cert = makeCertificate(dir, HOST);
  if (!cert) { t.skip('openssl cannot make a scratch certificate here'); return; }
  const s = await boot({ passcode: null, secure: cert });
  t.after(s.close);
  assert.equal(s.server.tailnet, null);
  assert.match(s.server.httpsError, /no passcode is set/);
  await assert.rejects(s.onHttps({ path: PAGE, headers: NAVIGATE }), { code: 'ECONNREFUSED' });
});

test('a renewed certificate is served without a restart', async (t) => {
  const s = await bootSecure(t, { recheckMs: 50 });
  if (!s) return;
  const first = (await s.onHttps({ path: PAGE, headers: NAVIGATE })).cert.serialNumber;
  await new Promise((resolve) => setTimeout(resolve, 1200));  // file times have a coarse step on some systems
  const renewed = makeCertificate(s.dir, HOST, 3);
  fs.utimesSync(renewed.certFile, new Date(), new Date());
  fs.utimesSync(renewed.keyFile, new Date(), new Date());
  let second = first;
  for (let i = 0; i < 40 && second === first; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    second = (await s.onHttps({ path: PAGE, headers: NAVIGATE })).cert.serialNumber;
  }
  assert.notEqual(second, first, 'the listener took the new certificate');
});

// ---------------------------------------------------- the offline copy's files on the TLS address

test('the offline copy\'s worker, manifest and icons are served over TLS only to a signed-in phone, with their own types', async (t) => {
  const s = await bootSecure(t);
  if (!s) return;
  const outDir = path.join(s.base, 'repo', 'setup', 'transcript-reader', 'out');
  for (const folder of ['bucket', 'hosted']) {
    fs.mkdirSync(path.join(outDir, folder), { recursive: true });
    fs.writeFileSync(path.join(outDir, folder, 'sw.js'), '// worker');
    fs.writeFileSync(path.join(outDir, folder, 'manifest.webmanifest'), '{"name":"x"}');
    fs.writeFileSync(path.join(outDir, folder, 'icon-180.png'), 'png-bytes');
    fs.writeFileSync(path.join(outDir, folder, 'secret.txt'), 'not served');
  }
  const SAME = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'serviceworker' };
  const base = '/setup/transcript-reader/out/bucket/';
  assert.equal((await s.onHttps({ path: base + 'sw.js', headers: SAME })).status, 401, 'no session, no worker');
  const cookie = (await signInSecure(s)).headers['set-cookie'][0].split(';')[0];
  const worker = await s.onHttps({ path: base + 'sw.js', headers: { ...SAME, Cookie: cookie } });
  assert.equal(worker.status, 200);
  assert.match(worker.headers['content-type'], /^text\/javascript/);
  assert.equal(worker.raw, '// worker');
  assert.equal((await s.onHttps({ path: base + 'manifest.webmanifest', headers: { ...SAME, 'Sec-Fetch-Dest': 'manifest', Cookie: cookie } })).headers['content-type'].split(';')[0], 'application/manifest+json');
  assert.equal((await s.onHttps({ path: '/setup/transcript-reader/out/hosted/icon-180.png', headers: { ...SAME, 'Sec-Fetch-Dest': 'image', Cookie: cookie } })).headers['content-type'], 'image/png');
  const other = await s.onHttps({ path: base + 'secret.txt', headers: { ...SAME, Cookie: cookie } });
  assert.ok([403, 404].includes(other.status) && !other.raw.includes('not served'), 'only those files');
  assert.equal((await s.onHttps({ path: base + 'sw.js', headers: { ...SAME, 'Sec-Fetch-Site': 'cross-site', Cookie: cookie } })).status, 403);
  assert.equal((await s.onHttps({ path: base + 'sw.js', headers: { ...SAME, Host: `evil.example:${s.httpsPort}`, Cookie: cookie } })).status, 403);
});

test('a shell page opens in a tab as before, and the page itself may fetch it for its cache only with the token it holds', async (t) => {
  const s = await bootSecure(t);
  if (!s) return;
  const outDir = path.join(s.base, 'repo', 'setup', 'transcript-reader', 'out', 'bucket');
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ['index.html', 'sheet.html']) fs.writeFileSync(path.join(outDir, name), `<!doctype html><head>${TOKEN_META}</head>${name}`);
  const cookie = (await signInSecure(s)).headers['set-cookie'][0].split(';')[0];
  const shell = '/setup/transcript-reader/out/bucket/index.html';
  const tab = await s.onHttps({ path: shell, headers: { ...NAVIGATE, Cookie: cookie } });
  assert.equal(tab.status, 200);
  const token = tokenIn(tab.raw);
  const FETCH = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
  assert.equal((await s.onHttps({ path: shell, headers: { ...FETCH, Cookie: cookie } })).status, 403, 'a script\'s fetch with no token gets nothing');
  assert.equal((await s.onHttps({ path: shell, headers: { ...FETCH, Cookie: cookie, [TOKEN_HEADER]: 'f'.repeat(64) } })).status, 403, 'nor with a wrong one');
  const own = await s.onHttps({ path: '/setup/transcript-reader/out/bucket/sheet.html', headers: { ...FETCH, Cookie: cookie, [TOKEN_HEADER]: token } });
  assert.equal(own.status, 200);
  assert.equal(tokenIn(own.raw), token, 'the page gets the token it already held, nothing new');
  assert.equal((await s.onHttps({ path: shell, headers: { ...FETCH, [TOKEN_HEADER]: token } })).status, 401, 'and never without the sign-in');
  // The local reader page keeps the old rule: a script's fetch of it never gets it, even with the token.
  assert.equal((await s.onHttps({ path: PAGE, headers: { ...FETCH, Cookie: cookie, [TOKEN_HEADER]: token } })).status, 403);
});


// ---------------------------------------------------------------- the Tasks board on the phone's TLS address

const BOARD_PAGE = '/setup/transcript-reader/board/';
const BOARD_API = '/api/transcript-reader/';
const STATE_API = BOARD_API + 'state';
// The board's page is put together from files of this copy, so a scratch copy gets the real ones.
function boardCopy(root) {
  const here = __dirname;
  for (const [from, to] of [['board/page', 'board/page'], ['prototype/live.js', 'prototype/live.js'], ['prototype/vendor/markdown-it.min.js', 'prototype/vendor/markdown-it.min.js'],
    ['prototype/markdown.js', 'prototype/markdown.js'], ['prototype/undosend.js', 'prototype/undosend.js'], ['prototype/commentkey.js', 'prototype/commentkey.js']]) {
    const source = path.join(here, from);
    const target = path.join(root, 'setup', 'transcript-reader', to);
    const isFolder = fs.statSync(source).isDirectory();
    fs.mkdirSync(isFolder ? target : path.dirname(target), { recursive: true });
    if (isFolder) for (const name of fs.readdirSync(source)) fs.copyFileSync(path.join(source, name), path.join(target, name));
    else fs.copyFileSync(source, target);
  }
}
async function bootBoard(t, board) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-cert-'));
  const cert = makeCertificate(dir, HOST);
  if (!cert) { t.skip('openssl cannot make a scratch certificate here'); return null; }
  const calls = [];
  const run = async (file, args) => { calls.push(args); return JSON.stringify({ schema: 'task-board.v1', session: { id: args[args.length - 1] }, threads: { session_list: [] } }); };
  const s = await boot({ secure: cert, board: { enabled: true, run, ...board } });
  t.after(s.close);
  boardCopy(path.join(s.base, 'repo'));
  return { ...s, calls };
}

test('the board stays off the phone unless its own flag is on: not on the TLS address, not on the plain one, loopback as before', async (t) => {
  const s = await bootBoard(t, {});
  if (!s) return;
  const loopbackPage = await s.onLoopback({ path: BOARD_PAGE, headers: NAVIGATE });
  assert.equal(loopbackPage.status, 200);
  const token = tokenIn(loopbackPage.raw);  // the token is the server's, the same on every address: the flag is what keeps the board off the phone
  const cookie = (await signInSecure(s)).headers['set-cookie'][0].split(';')[0];
  const plain = await s.signedIn();
  for (const [urlPath, headers] of [[BOARD_PAGE, NAVIGATE], [BOARD_API + 'board-sessions', {}], [BOARD_API + 'board?session=big-boss', {}]]) {
    assert.equal((await s.onHttps({ path: urlPath, headers: { ...headers, Cookie: cookie, [TOKEN_HEADER]: token } })).status, 404, 'TLS ' + urlPath);
    assert.equal((await s.onTailnet({ path: urlPath, headers: { ...headers, Cookie: plain, [TOKEN_HEADER]: token } })).status, 404, 'plain ' + urlPath);
  }
  assert.equal(s.calls.length, 0, 'nothing was built for the phone');
  // The reader page's Tasks link follows the same line: its state says there is a board on loopback only, and nothing of one to the phone.
  const stateHeaders = (extra) => ({ ...extra, [TOKEN_HEADER]: token });
  assert.equal((await s.onLoopback({ path: STATE_API, headers: stateHeaders({}) })).json.board.page, BOARD_PAGE, 'loopback');
  assert.equal('board' in (await s.onHttps({ path: STATE_API, headers: stateHeaders({ Cookie: cookie }) })).json, false, 'TLS');
  assert.equal('board' in (await s.onTailnet({ path: STATE_API, headers: stateHeaders({ Cookie: plain }) })).json, false, 'plain');
});

test('with PMOS_READER_BOARD_TAILNET the board opens on the TLS address behind the passcode, reads only, and never on the plain tailnet address', async (t) => {
  const s = await bootBoard(t, { tailnet: true, marks: true, answer: true, send: true });
  if (!s) return;
  // Signed out: the passcode page for the board's page, a refusal for its routes. Nothing of the board, no token.
  const out = await s.onHttps({ path: BOARD_PAGE, headers: NAVIGATE });
  assert.equal(out.status, 401);
  assert.match(out.raw, /Passcode/);
  assert.ok(!/reader-token|content="[0-9a-f]{64}"/.test(out.raw));
  for (const urlPath of [BOARD_API + 'board-sessions', BOARD_API + 'board?session=big-boss', BOARD_API + 'board-reply?session=big-boss&sid=x&uid=y']) assert.equal((await s.onHttps({ path: urlPath })).status, 401, urlPath);
  assert.equal(s.calls.length, 0);
  // Signed in: the page carries the token, the reads work with it and not without it, and every flagged write is refused on the phone even when its flag is on.
  const cookie = (await signInSecure(s)).headers['set-cookie'][0].split(';')[0];
  const page = await s.onHttps({ path: BOARD_PAGE, headers: { ...NAVIGATE, Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  const token = tokenIn(page.raw);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((await s.onHttps({ path: BOARD_API + 'board-sessions', headers: { Cookie: cookie } })).status, 403, 'the session alone is not enough');
  const read = await s.onHttps({ path: BOARD_API + 'board?session=big-boss', headers: { Cookie: cookie, [TOKEN_HEADER]: token } });
  assert.equal(read.status, 200, read.raw);
  assert.deepEqual(read.json.write, { marks: false, answer: false, send: false, review: false }, 'the phone is told it cannot write');
  const own = await s.onLoopback({ path: BOARD_API + 'board?session=big-boss', headers: { [TOKEN_HEADER]: tokenIn((await s.onLoopback({ path: BOARD_PAGE, headers: NAVIGATE })).raw) } });
  assert.deepEqual(own.json.write, { marks: true, answer: true, send: true, review: false }, 'loopback keeps its flags');
  for (const name of ['board-mark', 'board-answer', 'board-worker', 'board-send']) {
    const refused = await s.onHttps({ method: 'POST', path: BOARD_API + name, headers: { Cookie: cookie, Origin: SECURE_ORIGIN(s), 'Content-Type': 'application/json', [TOKEN_HEADER]: token, 'Sec-Fetch-Site': 'same-origin' }, body: { session: 'big-boss', session_id: A, text: 'from the phone' } });
    assert.equal(refused.status, 403, name);
    assert.equal(refused.json.code, 'not_on_the_phone', name);
  }
  assert.equal(s.herdr.prompts().length, 0, 'nothing was typed into a pane');
  // The reader page's Tasks link: the TLS address says the board is served (the phone's link shows), loopback too, the plain tailnet address says nothing of it.
  const stateOf = async (reach, headers) => (await reach({ path: STATE_API, headers })).json;
  assert.equal((await stateOf(s.onHttps, { Cookie: cookie, [TOKEN_HEADER]: token })).board.page, BOARD_PAGE, 'TLS');
  assert.equal((await stateOf(s.onLoopback, { [TOKEN_HEADER]: token })).board.page, BOARD_PAGE, 'loopback');
  // The plain tailnet address, signed in, still has no board.
  const plain = await s.signedIn();
  assert.equal('board' in (await stateOf(s.onTailnet, { Cookie: plain, [TOKEN_HEADER]: token })), false, 'plain tailnet: no Tasks link');
  assert.equal((await s.onTailnet({ path: BOARD_PAGE, headers: { ...NAVIGATE, Cookie: plain } })).status, 404);
  assert.equal((await s.onTailnet({ path: BOARD_API + 'board-sessions', headers: { Cookie: plain, [TOKEN_HEADER]: token } })).status, 404);
});
