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
async function boot({ passcode = PASSCODE, withTailnet = true } = {}) {
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
  const passcodeFile = path.join(base, 'config', 'passcode.json');
  if (passcode) await tailnet.writePasscodeFile(passcodeFile, passcode);
  const herdr = fakeHerdr();
  let clock = Date.now();
  const port = await freePort();
  const tailnetPort = await freePort();
  const server = await start({
    root, port, tailnet: withTailnet ? { ip: '127.0.0.1', port: tailnetPort, passcodeFile } : null,
    runner: herdr.runner, env: {}, projectsDir, claudeSessionsDir: path.join(base, 'sessions'), pinsFile: path.join(base, 'config', 'pins.json'), now: () => clock, pause: async () => {},
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
    base, server, herdr, passcodeFile, port, tailnetPort, loopback, phone, onLoopback, onTailnet, signIn, cookieFrom, signedIn, request,
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
  for (const cookie of ['reader_session=nope', 'reader_session=', 'other=1', 'reader_session=' + 'a'.repeat(43)]) {
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

// The passcode page's own script, run against a fake page: what it does once the server accepts the passcode.
async function signInFrom(page, location, next) {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const moves = [];
  let submit;
  const element = (extra = {}) => ({ value: 'correct horse battery', textContent: '', disabled: false, focus() {}, addEventListener(name, fn) { if (name === 'submit') submit = fn; }, ...extra });
  const sandbox = {
    document: { getElementById: () => element() },
    location: { ...location, replace: (to) => moves.push(['replace', to]), reload: () => moves.push(['reload']) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', next }) }),
    JSON, Promise,
  };
  require('vm').runInNewContext(script, sandbox);
  submit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return moves;
}

test('signing in on the very address that asked for it loads that page again, a fragment included', async (t) => {
  const s = await boot();
  t.after(s.close);
  const page = (await s.onTailnet({ path: '/transcript-reader/signin', headers: NAVIGATE })).raw;
  // A reader page opened with #s=..., or the reload after a sign-out: replacing the location with itself
  // would only move within the page, so the phone would sit on the passcode page after a correct passcode.
  const deep = { pathname: PAGE, search: '', hash: '#s=aaaaaaaa' };
  assert.deepEqual(await signInFrom(page, deep, PAGE + '#s=aaaaaaaa'), [['reload']]);
  assert.deepEqual(await signInFrom(page, { pathname: '/', search: '', hash: '' }, '/'), [['reload']]);
  // From the sign-in page itself, the server's answer is "/", a different address, so it moves there.
  assert.deepEqual(await signInFrom(page, { pathname: '/transcript-reader/signin', search: '', hash: '' }, '/'), [['replace', '/']]);
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
  assert.match(setCookie, /^reader_session=[A-Za-z0-9_-]{43};/);
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
  assert.match(out.headers['set-cookie'][0], /^reader_session=;.*Max-Age=0/);
  assert.equal((await openFresh()).status, 401);

  // Removing the file shuts the address off for everyone, signed in or not.
  const third = await s.signIn('a brand new passcode');
  assert.equal(third.status, 200);
  fs.renameSync(s.passcodeFile, s.passcodeFile + '.gone');
  assert.equal((await s.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: s.cookieFrom(third) } })).status, 401);
  assert.equal((await s.signIn('a brand new passcode')).status, 503);
});

test('a session lasts 30 days from its last use, and a restart forgets every session', async (t) => {
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

  const other = await boot();
  t.after(other.close);
  assert.equal((await other.onTailnet({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } })).status, 401, 'a cookie from another server start is no session');
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
  const server = await start({ root, port, tailnet: { ip, passcodeFile }, env: {}, pinsFile: path.join(base, 'pins.json') });
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
