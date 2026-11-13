'use strict';

// Tests for the organizer page on the phone over Tailscale (phone.js, api.js with a tailnet option,
// organizer-serve.sh --tailnet). The tailnet listener is bound to 127.0.0.1 on a second free port, so a test needs
// no Tailscale; the organizer-serve.sh test at the end uses the real Tailscale address and skips itself when
// `tailscale ip -4` does not answer. Passcodes here are test values in scratch files, never the owner's.
// Run from the repo root: node --test setup/herdr-organizer/test/phone.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const { tempTree, fakeRunner, request } = require('./helpers');
const { create, PAGE_PATH } = require('../api');
const { createAdapter } = require('../adapter');
const phone = require('../phone');
const tailnetLane = require('../../transcript-reader/tailnet');
const { start: startReader } = require('../../transcript-reader/server');

const REPO = path.join(__dirname, '..', '..', '..');
const PASSCODE = 'correct horse battery';
const NAVIGATE = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
const SIGNIN = '/herdr-organizer/signin';
const SIGNOUT = '/herdr-organizer/signout';
const SNAPSHOT = '/api/herdr-workspace-organizer/snapshot';
const PAGE_BODY = '<!doctype html><title>organizer page</title>';

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// A stand-in for the shared app server's repo: the organizer page, another app, and files that must never be served.
function repoTree(tree) {
  tree.write('repo/apps/wip-herdr-workspace-organizer.html', PAGE_BODY);
  tree.write('repo/apps/task-control-plane.html', 'ANOTHER APP');
  tree.write('repo/README.md', 'REPO FILE');
  tree.write('repo/setup/organizer-serve.sh', 'SCRIPT');
  tree.write('repo/personal/notes.md', 'PRIVATE NOTES');
  tree.write('repo/setup/transcript-reader/out/prototype.html', 'PRIVATE TRANSCRIPTS');
  tree.write('repo/.git/config', 'GIT CONFIG');
  return tree.abs('repo');
}

// The organizer API with a loopback listener (as organizer-serve.sh has it) and the phone listener, on two ports.
async function boot({ passcode = PASSCODE, withTailnet = true, refresh } = {}) {
  const tree = tempTree('herdr-phone-');
  const root = repoTree(tree);
  const passcodeFile = tree.abs('config/passcode.json');
  tree.mkdir('config');
  if (passcode) await tailnetLane.writePasscodeFile(passcodeFile, passcode);
  const lines = [];
  const fake = fakeRunner();
  const loopbackServer = http.createServer((req, res) => {
    if (api.handle(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });  // stands in for the shared handler, which serves the whole repo
    res.end('SHARED SERVER ANSWER');
  });
  await new Promise((resolve) => loopbackServer.listen(0, '127.0.0.1', resolve));
  const port = loopbackServer.address().port;
  const tailnetPort = await freePort();
  const scratchTools = tree.abs('tools');
  const adapter = createAdapter({ toolRoot: scratchTools, runner: fake.runner, env: {}, fmHome: tree.abs('fm-home'), gaugeScript: tree.abs('gauge.sh') });
  const api = create({
    root, port, adapter, env: {}, toolRoot: scratchTools, log: (line) => lines.push(line),
    rollover: { state: async () => ({ homes: [] }) }, switches: {}, preview: {},
    ...(withTailnet ? { tailnet: { ip: '127.0.0.1', port: tailnetPort, passcodeFile } } : {}),
  });
  const refreshCalls = [];
  const refreshImpl = refresh || (async (where) => { refreshCalls.push(where); return { status: 200, body: { status: 'ok', output: 'refreshed' } }; });
  const listening = await phone.listen({ root, api, tailnet: withTailnet ? { ip: '127.0.0.1', port: tailnetPort } : null, port, refresh: refreshImpl });
  const raw = (target, options) => request({ port: target, ...options });
  const loopbackHost = { host: 'localhost:' + port, origin: 'http://localhost:' + port };
  const phoneHost = { host: '127.0.0.1:' + tailnetPort, origin: 'http://127.0.0.1:' + tailnetPort };
  const onLoopback = (options) => raw(port, { ...options, headers: { Host: loopbackHost.host, ...options.headers } });
  const onPhone = (options) => raw(tailnetPort, { ...options, headers: { Host: phoneHost.host, ...options.headers } });
  const signIn = (text = PASSCODE) => onPhone({ method: 'POST', path: SIGNIN, headers: { Origin: phoneHost.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: { passcode: text, next: PAGE_PATH } });
  const cookieFrom = (response) => String(response.headers['set-cookie'] || '').split(';')[0];
  const signedIn = async () => { const response = await signIn(); assert.equal(response.status, 200); return cookieFrom(response); };
  // What the page does once signed in: fetch the token, then call the API with it.
  const apiAs = async (cookie) => {
    const base = { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' };
    const tokenResponse = await onPhone({ path: '/api/herdr-organizer/token', headers: base });
    const token = tokenResponse.json && tokenResponse.json.token;
    const post = (route, body, extra = {}) => onPhone({ method: 'POST', path: route, headers: { ...base, Origin: phoneHost.origin, 'Content-Type': 'application/json', 'X-Herdr-Organizer-Token': token, ...extra }, body });
    return { token, tokenResponse, post, base };
  };
  return {
    tree, root, api, port, tailnetPort, passcodeFile, lines, listening, refreshCalls, fake, loopbackHost, phoneHost, onLoopback, onPhone, signIn, cookieFrom, signedIn, apiAs, raw,
    close: () => new Promise((resolve) => {
      if (listening.close) listening.close();
      loopbackServer.close(() => {
        tree.sweep('config');
        tree.sweep('config/passcode.json.sessions');
        for (const rel of ['config/passcode.json.sessions', 'config', 'tools', 'fm-home']) tree.trackDir(rel);
        tree.cleanup();
        resolve();
      });
    }),
  };
}

// ---------------------------------------------------------------- off by default

test('the phone listener is off unless asked for: no environment switch, no listener, no route', async (t) => {
  assert.equal(phone.tailnetFromEnv({}, REPO), null);
  assert.equal(phone.tailnetFromEnv({ PMOS_SERVE_TAILNET_IP: '' }, REPO), null);
  assert.throws(() => phone.tailnetFromEnv({ PMOS_SERVE_TAILNET_IP: '0.0.0.0' }, REPO), /not a Tailscale address/);
  assert.throws(() => phone.tailnetFromEnv({ PMOS_SERVE_TAILNET_IP: '192.168.1.20' }, REPO), /not a Tailscale address/);
  assert.throws(() => phone.tailnetFromEnv({ PMOS_SERVE_TAILNET_IP: '8.8.8.8' }, REPO), /not a Tailscale address/);
  assert.deepEqual(phone.tailnetFromEnv({ PMOS_SERVE_TAILNET_IP: '100.97.27.50', PMOS_READER_PASSCODE_FILE: '/scratch/p.json' }, REPO), { ip: '100.97.27.50', passcodeFile: '/scratch/p.json' });

  const s = await boot({ withTailnet: false });
  t.after(s.close);
  assert.equal(s.api.tailnet, null, 'no sign-in lane without the option');
  assert.deepEqual(s.listening, { error: 'it was not asked for' });
  // The API itself refuses a request that claims to come from the phone listener when none was configured.
  const refused = await new Promise((resolve) => {
    const res = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body }); } };
    s.api.handle({ method: 'GET', url: '/api/herdr-organizer/token', headers: {} }, res, 'tailnet');
  });
  assert.equal(refused.status, 403);
  // Loopback is exactly as before.
  const token = await s.onLoopback({ path: '/api/herdr-organizer/token' });
  assert.equal(token.status, 200);
});

test('a phone listener without a passcode, or without an address, does not start and says why', async (t) => {
  const s = await boot({ passcode: null });
  t.after(s.close);
  assert.deepEqual(s.listening, { error: 'no passcode is set' });
  const other = await phone.listen({ root: s.root, api: s.api, tailnet: { ip: '0.0.0.0' }, port: s.port });
  assert.deepEqual(other, { error: 'it needs one Tailscale IPv4 address' });
});

test('the default passcode file is the reader\'s, and a path in the environment replaces it', () => {
  assert.equal(tailnetLane.defaultPasscodeFile('/repo', {}), path.join('/repo', 'setup', 'transcript-reader', 'out', 'passcode.json'));
  assert.equal(tailnetLane.defaultPasscodeFile('/repo', { PMOS_READER_PASSCODE_FILE: '/scratch/p.json' }), '/scratch/p.json');
});

// ---------------------------------------------------------------- the allow-list

const NOT_ON_THE_LIST = [
  '/', '/index.html', '/README.md', '/apps/task-control-plane.html', '/apps/', '/apps', '/apps/index.html', '/setup/organizer-serve.sh', '/personal/notes.md', '/.git/config',
  '/setup/transcript-reader/out/prototype.html', '/api/pmos-health', '/api/git-state', '/api/captain-holds', '/api/packet-tree?base=apps', '/api/write-file',
  '/api/control-plane-outbox', '/api/refetch-flow-packet', '/api/frame-catalogs', '/api/refresh/anything', '/api/transcript-reader/state', '/transcript-reader/signin',
  '/herdr-organizer', '/herdr-organizer/', '/herdr-organizer/other', '/api/herdr-workspace-organizer', '/api/herdr-workspace-organizer/', '/api/herdr-workspace-organizer/snapshot/x',
  '/apps/wip-herdr-workspace-organizer.html/', '/apps/wip-herdr-workspace-organizer.html/x', '/APPS/wip-herdr-workspace-organizer.html', '/apps/WIP-herdr-workspace-organizer.html',
  '/apps/wip-herdr-workspace-organizer%2ehtml', '/apps/wip%2dherdr-workspace-organizer.html', '/apps%2Fwip-herdr-workspace-organizer.html', '//apps/wip-herdr-workspace-organizer.html',
  '/apps/./wip-herdr-workspace-organizer.html/../../README.md', '/apps/..%2fREADME.md', '/apps/wip-herdr-workspace-organizer.html%00.md', '/api/herdr-organizerX/token', '/api/herdr-organizer',
];

test('every path off the list is a 404 on the phone listener, signed in or not, and nothing of the repo leaks', async (t) => {
  const s = await boot();
  t.after(s.close);
  const cookie = await s.signedIn();
  for (const target of NOT_ON_THE_LIST) {
    for (const headers of [NAVIGATE, { ...NAVIGATE, Cookie: cookie }]) {
      for (const method of ['GET', 'POST']) {
        const response = await s.onPhone({ method, path: target, headers: method === 'POST' ? { ...headers, Origin: s.phoneHost.origin, 'Content-Type': 'application/json' } : headers, body: method === 'POST' ? {} : undefined });
        // /api/herdr-organizer and its sub-paths under the prefix answer from the API's own 404 (after the session and the guard)
        assert.equal(response.status, 404, `${method} ${target} ${headers.Cookie ? 'signed in' : 'signed out'}`);
        for (const secret of ['REPO FILE', 'ANOTHER APP', 'SCRIPT', 'PRIVATE', 'GIT CONFIG', 'SHARED SERVER ANSWER']) assert.equal(response.raw.includes(secret), false, target);
      }
    }
  }
  assert.equal(fs.existsSync(path.join(s.root, 'personal', 'control-plane-outbox.md')), false);
  // Methods other than GET and POST never reach anything.
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const response = await s.onPhone({ method, path: PAGE_PATH, headers: { ...NAVIGATE, Cookie: cookie } });
    assert.ok([404, 405, 403].includes(response.status), method);
    assert.equal(response.raw.includes('organizer page'), false);
  }
});

test('what is on the list works once signed in: the page, its API and its snapshot route', async (t) => {
  const s = await boot();
  t.after(s.close);
  const cookie = await s.signedIn();
  const page = await s.onPhone({ path: PAGE_PATH, headers: { ...NAVIGATE, Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.raw, PAGE_BODY);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(Object.keys(page.headers).filter((name) => name.startsWith('access-control-')).length, 0, 'no CORS header');
  const { post, tokenResponse } = await s.apiAs(cookie);
  assert.equal(tokenResponse.status, 200);
  const sessions = await post('/api/herdr-organizer/run', { action: 'sessions' });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.json.status, 'ok');
  const refreshed = await post(SNAPSHOT, {});
  assert.equal(refreshed.status, 200);
  assert.deepEqual(refreshed.json, { status: 'ok', output: 'refreshed' });
  assert.deepEqual(s.refreshCalls, [s.root]);
});

test('the sign-in routes are the only other paths, and the page itself is the sign-in\'s landing', async (t) => {
  const s = await boot();
  t.after(s.close);
  const form = await s.onPhone({ path: SIGNIN, headers: NAVIGATE });
  assert.equal(form.status, 200);
  assert.match(form.raw, /Herdr organizer/);
  assert.match(form.raw, /Open the organizer/);
  assert.match(form.raw, /'\/herdr-organizer\/signin'/);
  assert.equal(form.raw.includes('/transcript-reader/signin'), false, 'the reader\'s sign-in route is not named on the organizer\'s page');
  const out = await s.onPhone({ path: SIGNOUT, headers: NAVIGATE });
  assert.equal(out.status, 303);
  assert.equal(out.headers.location, SIGNIN);
  const ok = await s.signIn();
  assert.equal(ok.status, 200);
  assert.equal(ok.json.next, PAGE_PATH);
  assert.match(String(ok.headers['set-cookie']), /^pmos_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  // a sign-in aimed at another site, or at the sign-in itself, lands on the organizer page
  const bad = await s.onPhone({ method: 'POST', path: SIGNIN, headers: { Origin: s.phoneHost.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: { passcode: PASSCODE, next: '//evil.example/x' } });
  assert.equal(bad.json.next, PAGE_PATH);
  const loop = await s.onPhone({ method: 'POST', path: SIGNIN, headers: { Origin: s.phoneHost.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: { passcode: PASSCODE, next: SIGNIN } });
  assert.equal(loop.json.next, PAGE_PATH);
  // the wrong passcode is refused in words the page can show
  const wrong = await s.signIn('not the passcode');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.code, 'wrong_passcode');
});

// ---------------------------------------------------------------- sign-in before any organizer route

test('no organizer route answers before a sign-in: the page is the passcode page, the API and the snapshot route are 401, and no token is given', async (t) => {
  const s = await boot();
  t.after(s.close);
  const page = await s.onPhone({ path: PAGE_PATH, headers: NAVIGATE });
  assert.equal(page.status, 401);
  assert.match(page.raw, /<form id="f"/);
  assert.equal(page.raw.includes('organizer page'), false, 'not the page');
  const token = await s.onPhone({ path: '/api/herdr-organizer/token', headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(token.status, 401);
  assert.equal(token.json.code, 'sign_in_required');
  assert.equal(token.raw.includes('"token"'), false);
  const anyApi = ['/api/herdr-organizer/run', '/api/herdr-organizer/nothing'];
  for (const route of anyApi) {
    const response = await s.onPhone({ method: 'POST', path: route, headers: { Origin: s.phoneHost.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: { action: 'sessions' } });
    assert.equal(response.status, 401, route);
  }
  const snapshot = await s.onPhone({ method: 'POST', path: SNAPSHOT, headers: { Origin: s.phoneHost.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: {} });
  assert.equal(snapshot.status, 401);
  assert.deepEqual(s.refreshCalls, [], 'nothing ran');
  assert.equal(s.fake.calls.length, 0, 'no tool was spawned');
  // a made-up cookie, a cookie under another name and an empty one are no session
  for (const cookie of ['pmos_session=nope', 'pmos_session=', 'organizer_session=x', 'pmos_session=' + 'a'.repeat(43)]) {
    assert.equal((await s.onPhone({ path: PAGE_PATH, headers: { ...NAVIGATE, Cookie: cookie } })).status, 401, cookie);
    assert.equal((await s.onPhone({ path: '/api/herdr-organizer/token', headers: { Cookie: cookie } })).status, 401, cookie);
  }
});

test('a session is not enough on its own: the token, the Origin and JSON are still needed, and the token is not enough without a session', async (t) => {
  const s = await boot();
  t.after(s.close);
  const cookie = await s.signedIn();
  const { post, token, base } = await s.apiAs(cookie);
  const run = (headers, body = { action: 'sessions' }) => s.onPhone({ method: 'POST', path: '/api/herdr-organizer/run', headers, body });
  const full = { ...base, Origin: s.phoneHost.origin, 'Content-Type': 'application/json', 'X-Herdr-Organizer-Token': token };
  assert.equal((await run(full)).status, 200);
  assert.equal((await run({ ...full, 'X-Herdr-Organizer-Token': 'nope' })).status, 403, 'wrong token');
  const { 'X-Herdr-Organizer-Token': dropped, ...noToken } = full;
  assert.equal((await run(noToken)).status, 403, 'no token');
  const { Origin: droppedOrigin, ...noOrigin } = full;
  assert.equal((await run(noOrigin)).status, 403, 'no Origin on a POST');
  assert.equal((await run({ ...full, 'Content-Type': 'text/plain' })).status, 415, 'not JSON');
  assert.equal((await run({ ...full, 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'cross-site');
  assert.equal((await run({ ...full, 'Sec-Fetch-Site': 'same-site' })).status, 403, 'same-site is not same-origin');
  // the token without the cookie
  const { Cookie: ignoredCookie, ...noCookie } = full;
  assert.equal((await run(noCookie)).status, 401, 'token without a session');
  // the snapshot route takes the same: a token and a JSON body
  const refresh = (headers) => s.onPhone({ method: 'POST', path: SNAPSHOT, headers, body: {} });
  assert.equal((await refresh(noToken)).status, 403);
  assert.equal((await refresh({ ...full, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await s.onPhone({ path: SNAPSHOT, headers: { ...base } })).status, 405, 'GET');
  assert.deepEqual(s.refreshCalls, []);
  assert.equal((await refresh(full)).status, 200);
  assert.equal(post.length >= 2, true);
});

test('a second tap on Refresh snapshot while one runs shares its answer instead of starting another', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const s = await boot({ refresh: async (where) => { calls.push(where); await gate; return { status: 500, body: { status: 'error', code: 1, message: 'tool said no' } }; } });
  t.after(s.close);
  const { post } = await s.apiAs(await s.signedIn());
  const first = post(SNAPSHOT, {});
  const second = post(SNAPSHOT, {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(a.status, 500);
  assert.equal(b.status, 500);
  assert.equal(a.json.message, 'tool said no');
  assert.equal((await post(SNAPSHOT, {})).status, 500);
  assert.equal(calls.length, 2, 'a later tap runs again');
});

// ---------------------------------------------------------------- the guard, per listener

test('the tailnet origin is accepted only on the phone listener, and loopback behaves as before', async (t) => {
  const s = await boot();
  t.after(s.close);
  const cookie = await s.signedIn();
  const { token } = await s.apiAs(cookie);

  // Loopback: no sign-in, its own Host and Origin, and the same token works there as it always did.
  const loopbackToken = await s.onLoopback({ path: '/api/herdr-organizer/token' });
  assert.equal(loopbackToken.status, 200);
  assert.equal(loopbackToken.json.token, token, 'one token for both listeners');
  const loopbackRun = (headers) => s.onLoopback({ method: 'POST', path: '/api/herdr-organizer/run', headers: { 'Content-Type': 'application/json', 'X-Herdr-Organizer-Token': token, ...headers }, body: { action: 'sessions' } });
  assert.equal((await loopbackRun({ Origin: s.loopbackHost.origin })).status, 200);
  assert.equal((await loopbackRun({ Origin: s.phoneHost.origin })).status, 403, 'the tailnet origin means nothing on loopback');
  assert.equal((await s.raw(s.port, { path: '/api/herdr-organizer/token', headers: { Host: s.phoneHost.host } })).status, 403, 'nor does the tailnet Host');
  assert.equal((await s.raw(s.port, { path: '/api/herdr-organizer/token', headers: { Host: 'localhost:' + s.tailnetPort } })).status, 403, 'nor the other listener\'s port');
  assert.equal((await s.onLoopback({ path: '/api/herdr-organizer/token', headers: { Origin: 'https://evil.example' } })).status, 403);
  // a loopback request is not signed in, and sends no cookie
  assert.equal(loopbackToken.headers['set-cookie'], undefined);
  // the loopback server has no phone routes: the sign-in is the shared handler's answer, not ours
  assert.equal((await s.onLoopback({ path: SIGNIN })).raw, 'SHARED SERVER ANSWER');

  // The phone listener: exactly its own address and port.
  const onPhone = (headers, route = '/api/herdr-organizer/token') => s.onPhone({ path: route, headers: { Cookie: cookie, ...headers } });
  assert.equal((await onPhone({ 'Sec-Fetch-Site': 'same-origin', Origin: s.phoneHost.origin })).status, 200);
  assert.equal((await onPhone({ Origin: s.loopbackHost.origin })).status, 403, 'a loopback Origin is refused on the phone listener');
  assert.equal((await onPhone({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await onPhone({ Origin: 'null' })).status, 403);
  assert.equal((await onPhone({ Origin: 'http://127.0.0.1:' + s.port })).status, 403, 'right address, other port');
  assert.equal((await onPhone({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const host of ['localhost:' + s.tailnetPort, 'localhost:' + s.port, '[::1]:' + s.tailnetPort, 'evil.example:' + s.tailnetPort, '127.0.0.1', '127.0.0.1:1']) {
    const response = await s.raw(s.tailnetPort, { path: '/api/herdr-organizer/token', headers: { Host: host, Cookie: cookie } });
    assert.equal(response.status, 403, host);
    assert.equal(response.raw.includes('"token"'), false, host);
  }
  // a preflight is never answered with permission
  const preflight = await s.onPhone({ method: 'OPTIONS', path: '/api/herdr-organizer/run', headers: { Origin: s.phoneHost.origin, 'Access-Control-Request-Method': 'POST', Cookie: cookie } });
  assert.ok([403, 405].includes(preflight.status));
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
});

test('one change at a time still holds across both listeners', async (t) => {
  const s = await boot();
  t.after(s.close);
  // a tier 1 action holds the shared lock; the same lock refuses a second one from the other listener
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = s.api.ACTIONS['verify-apply'].run;
  s.api.ACTIONS['verify-apply'].run = async () => { await gate; return {}; };
  t.after(() => { s.api.ACTIONS['verify-apply'].run = original; });
  const { post, token } = await s.apiAs(await s.signedIn());
  const params = { action: 'verify-apply', params: { session: 'project-a', confirm: 'x' } };
  const first = post('/api/herdr-organizer/run', params);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const viaLoopback = await s.onLoopback({ method: 'POST', path: '/api/herdr-organizer/run', headers: { Origin: s.loopbackHost.origin, 'Content-Type': 'application/json', 'X-Herdr-Organizer-Token': token }, body: params });
  assert.equal(viaLoopback.status, 409);
  release();
  assert.equal((await first).status, 200);
});

// ---------------------------------------------------------------- one sign-in for both apps

test('a sign-in on the organizer is accepted by the reader and the other way round, and a sign-out ends both', async (t) => {
  const s = await boot();
  t.after(s.close);
  // The reader's own server (its real code), on a second address and port, with the same passcode file.
  const readerTree = tempTree('herdr-phone-reader-');
  const readerRoot = readerTree.abs('repo');
  readerTree.write('repo/setup/transcript-reader/out/prototype.html', '<!doctype html><head><meta name="reader-token" content="__READER_TOKEN__"></head>READER PAGE');
  readerTree.write('repo/setup/transcript-reader/out/sessions.txt', '');
  const readerPort = await freePort();
  const reader = await startReader({
    root: readerRoot, port: await freePort(), tailnet: { ip: '127.0.0.1', port: readerPort, passcodeFile: s.passcodeFile }, log: () => {},
    runner: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, truncated: false }), env: {}, projectsDir: readerTree.abs('projects'), claudeSessionsDir: readerTree.abs('sessions'), pinsFile: readerTree.abs('pins.json'),
  });
  t.after(() => { reader.close(); readerTree.sweep('repo/setup/transcript-reader/out'); readerTree.trackDir('repo/setup/transcript-reader/out'); readerTree.cleanup(); });
  assert.ok(reader.tailnet, 'the reader listens for the phone too');
  const readerPage = (cookie) => request({ port: readerPort, path: '/setup/transcript-reader/out/prototype.html', headers: { Host: '127.0.0.1:' + readerPort, ...NAVIGATE, ...(cookie ? { Cookie: cookie } : {}) } });
  const organizerPage = (cookie) => s.onPhone({ path: PAGE_PATH, headers: { ...NAVIGATE, ...(cookie ? { Cookie: cookie } : {}) } });

  assert.equal((await readerPage()).status, 401);
  assert.equal((await organizerPage()).status, 401);
  // signed in on the organizer: the reader knows the cookie. Browsers send one cookie to every port of an address.
  const cookie = await s.signedIn();
  assert.equal((await organizerPage(cookie)).status, 200);
  const onReader = await readerPage(cookie);
  assert.equal(onReader.status, 200);
  assert.match(onReader.raw, /READER PAGE/);
  // signed in on the reader: the organizer knows that cookie too
  const readerSignIn = await request({ port: readerPort, method: 'POST', path: '/transcript-reader/signin', headers: { Host: '127.0.0.1:' + readerPort, Origin: 'http://127.0.0.1:' + readerPort, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: { passcode: PASSCODE, next: '/' } });
  assert.equal(readerSignIn.status, 200);
  const readerCookie = s.cookieFrom(readerSignIn);
  assert.equal((await organizerPage(readerCookie)).status, 200);
  // each server keeps its own page token: the organizer's token is not the reader's
  const organizerToken = (await s.apiAs(cookie)).token;
  assert.equal(onReader.raw.includes(organizerToken), false);
  assert.notEqual((onReader.raw.match(/name="reader-token" content="([^"]*)"/) || [])[1], organizerToken);
  // a sign-out on the reader ends the organizer's session, and the other way round
  const out = await request({ port: readerPort, path: '/transcript-reader/signout', headers: { Host: '127.0.0.1:' + readerPort, ...NAVIGATE, Cookie: cookie } });
  assert.equal(out.status, 303);
  assert.equal((await organizerPage(cookie)).status, 401);
  assert.equal((await readerPage(cookie)).status, 401);
  assert.equal((await organizerPage(readerCookie)).status, 200, 'another phone\'s session is untouched');
  await s.onPhone({ path: SIGNOUT, headers: { ...NAVIGATE, Cookie: readerCookie } });
  assert.equal((await readerPage(readerCookie)).status, 401);
  // a new passcode ends every session in both
  const again = await s.signedIn();
  assert.equal((await readerPage(again)).status, 200);
  await tailnetLane.writePasscodeFile(s.passcodeFile, 'a brand new passcode');
  assert.equal((await readerPage(again)).status, 401);
  assert.equal((await organizerPage(again)).status, 401);
  assert.equal((await s.signIn(PASSCODE)).status, 401, 'the old passcode no longer works');
});

// ---------------------------------------------------------------- the page itself

const pageHtml = fs.readFileSync(path.join(REPO, 'apps', 'wip-herdr-workspace-organizer.html'), 'utf8');

test('everything the page asks this server for is on the phone listener\'s list, and it names no local file that is not', () => {
  const fetched = [...pageHtml.matchAll(/fetch\(\s*(['"`])([^'"`]*)\1/g)].map((match) => match[2]);
  assert.ok(fetched.length >= 3);
  for (const target of fetched) assert.ok(phone.classify(target, require('../api').ORGANIZER_SITE), `${target} is on the list`);
  // links, scripts, images, styles: only other sites, the page itself or data
  const references = [...pageHtml.matchAll(/(?<![-\w])(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]).filter((value) => !/^(https:\/\/|#|data:|mailto:)/.test(value) && !value.includes('${'));
  const listed = new Set([...phone.ASSETS.keys()]);
  for (const reference of references) assert.ok(listed.has(reference), `the page names ${reference}, which the phone listener does not serve`);
  assert.equal(/url\(\s*['"]?\/(?!\/)/.test(pageHtml), false, 'no CSS url() to a local path');
});

test('on a touch screen every control is at least 44px tall and long commands wrap', () => {
  const block = pageHtml.slice(pageHtml.indexOf('@media (pointer: coarse)'));
  assert.ok(block.startsWith('@media (pointer: coarse)'));
  const rules = block.slice(0, block.indexOf('</style>'));
  assert.match(rules, /button, select, \.search, input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\) \{ min-height: 44px; \}/);
  assert.match(rules, /overflow-wrap: anywhere/);
  assert.match(pageHtml, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

test('the page\'s Refresh snapshot sends the token and a JSON body, as the phone listener needs', () => {
  const at = pageHtml.indexOf("fetch('/api/herdr-workspace-organizer/snapshot'");
  assert.ok(at > 0);
  const call = pageHtml.slice(at, at + 260);
  assert.match(call, /method: 'POST'/);
  assert.match(call, /'Content-Type': 'application\/json'/);
  assert.match(call, /\[api\.header\]: token/);
});

// ---------------------------------------------------------------- organizer-serve.sh --tailnet, end to end on the real address

function tailscaleAddress() {
  for (const bin of ['tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const ip = execFileSync(bin, ['ip', '-4'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
      if (/^100\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch { /* not installed, or not running */ }
  }
  return null;
}

const listenerPids = (port) => { try { return execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };
const refuses = (ip, port) => new Promise((resolve) => { const socket = net.connect({ host: ip, port, timeout: 1500 }); socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', () => resolve(true)); socket.once('timeout', () => { socket.destroy(); resolve(true); }); });

test('organizer-serve.sh: the Tailscale address is off by default, needs a passcode, then serves the organizer page and nothing else', { skip: tailscaleAddress() ? false : 'Tailscale is not running here' }, async (t) => {
  const ip = tailscaleAddress();
  const tree = tempTree('herdr-phone-serve-');
  const passcodeFile = tree.abs('config/passcode.json');
  const scratchHome = tree.mkdir('home');
  tree.mkdir('tools/state/workspace-organizer');
  tree.mkdir('fm-home');
  const env = {
    PATH: process.env.PATH, HOME: scratchHome, PMOS_READER_PASSCODE_FILE: passcodeFile, HERDR_ORGANIZER_TOOL_ROOT: tree.abs('tools'), HERDR_ORGANIZER_FM_HOME: tree.abs('fm-home'),
    HERDR_ORGANIZER_ROLLOVER_HOMES: 'scratch=' + tree.abs('fm-home'), HERDR_ORGANIZER_GAUGE_SCRIPT: tree.abs('gauge.sh'),
  };
  const ports = [];
  const serve = (port, ...args) => execFileSync('bash', [path.join(REPO, 'setup', 'organizer-serve.sh'), '--port', String(port), ...args], { cwd: REPO, env, encoding: 'utf8', timeout: 30000 });
  const stop = (port) => { for (const pid of listenerPids(port)) { try { process.kill(pid); } catch { /* gone */ } } };
  t.after(async () => {
    for (const port of ports) stop(port);
    await new Promise((resolve) => setTimeout(resolve, 300));
    tree.sweep('config'); tree.sweep('config/passcode.json.sessions');
    for (const rel of ['config/passcode.json.sessions', 'config', 'tools/state/workspace-organizer', 'tools/state', 'tools', 'home', 'fm-home']) tree.trackDir(rel);
    tree.cleanup();
  });
  const getFrom = (host, port, target, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host, port, method, path: target, headers: { Host: host + ':' + port, ...headers, ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  // 1. Off by default: the shared server starts on loopback only.
  const plainPort = await freePort(); ports.push(plainPort);
  const plain = serve(plainPort);
  assert.match(plain, /Organizer server started/);
  assert.doesNotMatch(plain, /Tailnet/);
  assert.equal(await refuses(ip, plainPort), true, 'nothing listens on the Tailscale address without --tailnet');
  assert.match(execFileSync('bash', [path.join(REPO, 'setup', 'organizer-serve.sh'), '--port', String(plainPort), 'status'], { cwd: REPO, env, encoding: 'utf8' }), /Tailnet address not served/);
  assert.equal((await getFrom('127.0.0.1', plainPort, '/README.md', {})).status, 404, 'loopback serves only the organizer');
  stop(plainPort);
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 2. Asked for but no passcode: loopback only, and the reason in plain words.
  const noPasscodePort = await freePort(); ports.push(noPasscodePort);
  const noPasscode = serve(noPasscodePort, '--tailnet');
  assert.match(noPasscode, /Tailnet address not served: no passcode is set\. Set one with: bash setup\/transcript-reader\/serve\.sh passcode/);
  assert.equal(await refuses(ip, noPasscodePort), true);
  stop(noPasscodePort);
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 3. With a passcode: the organizer page and its routes on the real address, and a 404 for everything else.
  await tailnetLane.writePasscodeFile(passcodeFile, PASSCODE);
  const port = await freePort(); ports.push(port);
  const started = serve(port, '--tailnet');
  assert.match(started, new RegExp(`Tailnet address served: http://${ip.replace(/\./g, '\\.')}:${port}/apps/wip-herdr-workspace-organizer\\.html`));
  assert.match(execFileSync('bash', [path.join(REPO, 'setup', 'organizer-serve.sh'), '--port', String(port), 'status'], { cwd: REPO, env, encoding: 'utf8' }), /Tailnet address served/);
  const origin = `http://${ip}:${port}`;
  const unsigned = await getFrom(ip, port, PAGE_PATH, NAVIGATE);
  assert.equal(unsigned.status, 401);
  assert.match(unsigned.raw, /<form id="f"/);
  assert.equal(unsigned.raw.includes('Workspace organizer'), false);
  for (const target of ['/README.md', '/apps/index.html', '/apps/task-control-plane.html', '/setup/organizer-serve.sh', '/api/pmos-health', '/api/git-state', '/', '/setup/transcript-reader/out/prototype.html']) {
    assert.equal((await getFrom(ip, port, target, NAVIGATE)).status, 404, 'signed out: ' + target);
  }
  const signed = await getFrom(ip, port, SIGNIN, { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, 'POST', { passcode: PASSCODE, next: PAGE_PATH });
  assert.equal(signed.status, 200);
  const cookie = String(signed.headers['set-cookie']).split(';')[0];
  const page = await getFrom(ip, port, PAGE_PATH, { ...NAVIGATE, Cookie: cookie });
  assert.equal(page.status, 200);
  assert.match(page.raw, /Workspace organizer/);
  assert.equal(page.raw, fs.readFileSync(path.join(REPO, 'apps', 'wip-herdr-workspace-organizer.html'), 'utf8'));
  for (const target of ['/README.md', '/apps/index.html', '/apps/task-control-plane.html', '/setup/organizer-serve.sh', '/api/pmos-health', '/api/git-state', '/api/captain-holds', '/', '/setup/transcript-reader/out/prototype.html', '/personal/x']) {
    const response = await getFrom(ip, port, target, { ...NAVIGATE, Cookie: cookie });
    assert.equal(response.status, 404, 'signed in: ' + target);
    assert.equal(response.raw, 'Not found');
  }
  const token = JSON.parse((await getFrom(ip, port, '/api/herdr-organizer/token', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' })).raw).token;
  assert.match(token, /^[0-9a-f]{64}$/);
  const writeFile = await getFrom(ip, port, '/api/write-file', { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, 'POST', { path: 'notes.md', content: 'x' });
  assert.equal(writeFile.status, 404, 'the shared server\'s write route is not on the tailnet');
  // the same token is refused where the Host is not the tailnet address
  assert.equal((await getFrom('127.0.0.1', port, '/api/herdr-organizer/token', { Host: `${ip}:${port}` })).status, 403, 'the tailnet Host is not accepted on loopback');
  // loopback is separate from the phone lane: no sign-in, only organizer routes
  assert.equal((await getFrom('127.0.0.1', port, PAGE_PATH, {})).status, 200);
  assert.equal((await getFrom('127.0.0.1', port, '/api/herdr-organizer/token', {})).status, 200);
});
