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
async function boot({ passcode = PASSCODE, withTailnet = true, sharedPasscodeFile = null } = {}) {
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
  const server = await start({
    root, port, tailnet: withTailnet ? { ip: '127.0.0.1', port: tailnetPort, passcodeFile } : null,
    log: (line) => lines.push(line), runner: herdr.runner, env: {}, projectsDir, claudeSessionsDir: path.join(base, 'sessions'), pinsFile: path.join(base, 'config', 'pins.json'), now: () => clock, pause: async () => {},
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
  const signIn = (passcodeText, extra = {}) => onTailnet({ method: 'POST', path: '/transcript-reader/signin', headers: { Origin: phone.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...extra }, body: { passcode: passcodeText, next: PAGE } });
  const cookieFrom = (response) => String(response.headers['set-cookie'] || '').split(';')[0];
  const signedIn = async () => { const response = await signIn(PASSCODE); assert.equal(response.status, 200); return cookieFrom(response); };
  return {
    base, server, herdr, lines, passcodeFile, port, tailnetPort, loopback, phone, onLoopback, onTailnet, signIn, cookieFrom, signedIn, request,
    tick: (ms) => { clock += ms; },
    close: () => { server.close(); },
  };
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
