'use strict';

// W3 through the real listeners: the store API reached from the phone's tailnet listener (signed in with a passcode, as the phone does) reaches only
// the starred conversations and the ones a Herdr pane has open, while the same server's loopback listener (the laptop) reaches them all.
//   node --test setup/transcript-reader/storeapi/tailnet.test.js
// The tailnet listener is bound to 127.0.0.1 on a second free port, so no Tailscale is needed; the passcode is a test value in a temporary file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { start } = require('../server');
const tailnet = require('../tailnet');
const { TOKEN_HEADER } = require('../api');

const LAB = path.join(__dirname, 'lab_store.py');
const lab = (...args) => JSON.parse(execFileSync('python3', [LAB, ...args], { encoding: 'utf8', timeout: 60000 }).trim().split('\n').pop());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const got = await check(); if (got) return got; await sleep(15); } assert.fail('timed out waiting for ' + what); };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const PASSCODE = 'correct horse battery';
const NAVIGATE = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
const PAGE = '/setup/transcript-reader/windowed/index.html';
const tokenIn = (html) => (html.match(/<meta name="reader-token" content="([^"]*)">/) || [])[1];

async function boot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'store-api-tailnet-'));
  const made = lab('make', base);
  const ids = made.ids;
  lab('bind', base, 'work', 'w1:p1', ids.alpha);
  const root = path.join(base, 'repo');
  const outDir = path.join(root, 'setup', 'transcript-reader', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ['prototype', 'storeapi']) fs.symlinkSync(path.join(__dirname, '..', name), path.join(root, 'setup', 'transcript-reader', name));
  fs.writeFileSync(path.join(outDir, 'sessions.txt'), '');
  const config = path.join(base, 'config');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'stars.json'), JSON.stringify({ version: 1, rev: 1, stars: [{ conv: ids.beta, starred: Date.now() / 1000 }] }));
  const passcodeFile = path.join(config, 'passcode.json');
  await tailnet.writePasscodeFile(passcodeFile, PASSCODE);
  const world = { panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', label: 'alpha-pane', agent: 'claude', agent_status: 'idle', agent_session: { value: ids.alpha } }] };
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
  const runner = async (file, args) => {
    if (args[0] === 'session') return ok({ sessions: [{ name: 'work', default: false, running: true, session_dir: base }] });
    if (args[2] === 'api' && args[3] === 'snapshot') return ok({ result: { snapshot: { focused_pane_id: 'w1:p1', panes: world.panes, tabs: [] } } });
    return { code: 1, stdout: '', stderr: 'no' };
  };
  const port = await freePort();
  const tailnetPort = await freePort();
  const server = await start({
    root, port, tailnet: { ip: '127.0.0.1', port: tailnetPort, passcodeFile }, runner, env: { PMOS_READER_STORE_DIR: path.join(base, 'store') },
    projectsDir: path.join(base, 'projects'), claudeSessionsDir: path.join(base, 'sessions'), codexSessionsDir: path.join(base, 'codex'), copilotHomeDir: path.join(base, 'copilot'),
    pinsFile: path.join(config, 'pins.json'), starsFile: path.join(config, 'stars.json'), sheetFlagsFile: path.join(config, 'flags.json'), hiddenFile: path.join(config, 'hidden.json'),
    pause: async () => {}, storeApi: { pollMs: 40 }, worker: false, watch: false,
  });
  const request = (target, host, { method = 'GET', path: urlPath, headers = {}, body }) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: target, method, path: urlPath, headers: { Host: host, ...headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, raw, json }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  const onLoopback = (o) => request(port, 'localhost:' + port, o);
  const phoneHost = '127.0.0.1:' + tailnetPort;
  const onPhone = (o) => request(tailnetPort, phoneHost, o);
  // The phone signs in, opens the windowed page in a tab (which gives it the token) and then calls the API with the cookie and the token.
  const signIn = await onPhone({ method: 'POST', path: '/transcript-reader/signin', headers: { Origin: 'http://' + phoneHost, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: { passcode: PASSCODE, next: PAGE } });
  assert.equal(signIn.status, 200);
  const cookie = String(signIn.headers['set-cookie'][0]).split(';')[0];
  const page = await onPhone({ path: PAGE, headers: { ...NAVIGATE, Cookie: cookie } });
  assert.equal(page.status, 200, 'the windowed page opens on the phone once signed in');
  const phoneToken = tokenIn(page.raw);
  const loopPage = await onLoopback({ path: PAGE, headers: NAVIGATE });
  const loopToken = tokenIn(loopPage.raw);
  const phone = (route) => onPhone({ path: '/api/transcript-reader/' + route, headers: { Cookie: cookie, [TOKEN_HEADER]: phoneToken } });
  const laptop = (route) => onLoopback({ path: '/api/transcript-reader/' + route, headers: { [TOKEN_HEADER]: loopToken } });
  const phoneStream = () => new Promise((resolve) => {
    const events = [];
    const req = http.request({ host: '127.0.0.1', port: tailnetPort, path: `/api/transcript-reader/stream?sessions=${ids.alpha},${ids.gamma}`, headers: { Host: phoneHost, Cookie: cookie, [TOKEN_HEADER]: phoneToken } }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          const name = (/^event: (.*)$/m.exec(block) || [])[1];
          const data = (/^data: (.*)$/m.exec(block) || [])[1];
          if (name && data) events.push({ name, data: JSON.parse(data) });
        }
      });
      resolve({ status: res.statusCode, events, close: () => req.destroy() });
    });
    req.end();
  });
  return { base, ids, phone, laptop, phoneStream, onPhone, close: () => { server.close(); } };
}

test('the phone reaches only the starred and the open-pane conversations: the list, the turns, the search; the laptop reaches them all', async () => {
  const t = await boot();
  try {
    const laptop = await t.laptop('sessions');
    assert.equal(laptop.status, 200);
    assert.equal(laptop.json.sessions.length, 5);
    const phone = await t.phone('sessions');
    assert.equal(phone.status, 200);
    assert.deepEqual(phone.json.sessions.map((s) => s.id).sort(), [t.ids.alpha, t.ids.beta].sort(), 'the open pane and the starred one, nothing else');
    assert.equal((await t.phone(`sessions/${t.ids.alpha}/turns`)).status, 200);
    assert.equal((await t.phone(`sessions/${t.ids.beta}/turns`)).status, 200);
    for (const id of [t.ids.gamma, t.ids.quiet, t.ids.codex]) {
      assert.equal((await t.phone(`sessions/${id}/turns`)).status, 404, 'a conversation outside the set is not there');
      assert.equal((await t.laptop(`sessions/${id}/turns`)).status, 200);
    }
    assert.equal((await t.phone('sessions?limit=500')).json.sessions.length, 2, 'asking for more does not widen it');
    // A word only an outside conversation holds is found on the laptop and never on the phone.
    const own = 'Synthetic alpha work';  // the title of gamma's log
    assert.equal((await t.laptop('search?q=' + encodeURIComponent(own))).json.results.some((r) => r.id === t.ids.gamma), true);
    const found = (await t.phone('search?q=' + encodeURIComponent(own))).json;
    assert.equal(found.scope, 'curated');
    assert.equal(found.results.some((r) => r.id === t.ids.gamma), false);
    assert.equal((await t.phone('search?q=' + encodeURIComponent('Should I merge it'))).json.results.length >= 1, true, 'a conversation inside the set is found');
  } finally { t.close(); }
});

test('the phone without a sign-in or a token gets nothing; the stream carries only the phone\'s conversations', async () => {
  const t = await boot();
  try {
    assert.equal((await t.onPhone({ path: '/api/transcript-reader/sessions' })).status, 401);
    const stream = await t.phoneStream();
    assert.equal(stream.status, 200);
    await until(() => stream.events.some((e) => e.name === 'hello'), 'hello');
    assert.deepEqual(Object.keys(stream.events.find((e) => e.name === 'hello').data.sessions), [t.ids.alpha], 'gamma was asked for and is not held open');
    lab('append', t.base, t.ids.gamma, 'user', 'an outside conversation grows');
    lab('append', t.base, t.ids.alpha, 'user', 'a conversation the phone holds grows');
    await until(() => stream.events.some((e) => e.name === 'turns' && e.data.id === t.ids.alpha), 'the held conversation');
    await sleep(300);
    assert.equal(stream.events.some((e) => e.data && e.data.id === t.ids.gamma), false, 'nothing of the outside conversation reached the phone');
    assert.equal(stream.events.some((e) => e.name === 'live' && e.data.changes.some((c) => c.id === t.ids.gamma)), false);
    stream.close();
  } finally { t.close(); }
});
