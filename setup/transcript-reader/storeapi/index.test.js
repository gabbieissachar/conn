'use strict';

// The store-backed API end to end: api.js with the flag on, over a lab store (storeapi/lab_store.py: synthetic logs ingested by the store's own
// code into a store of its own) and a fake Herdr with an event socket. Run from the repo root:
//   node --test setup/transcript-reader/storeapi/index.test.js
// Nothing real is read: not the owner's store, logs, Herdr or panes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { create, TOKEN_HEADER, TOKEN_META } = require('../api');
const { FakeHerdrSockets } = require('../e2e/fake-herdr-socket');

const LAB = path.join(__dirname, 'lab_store.py');
const lab = (...args) => JSON.parse(execFileSync('python3', [LAB, ...args], { encoding: 'utf8', timeout: 60000 }).trim().split('\n').pop());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what, ms = 4000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await check(); if (last) return last; await sleep(15); } assert.fail('timed out waiting for ' + what); };
const tokenIn = (html) => (html.match(/<meta name="reader-token" content="([^"]*)">/) || [])[1];

async function start({ options = {}, noStore = false, panes = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'store-api-'));
  const made = noStore ? null : lab('make', base);
  const root = path.join(base, 'repo');
  const outDir = path.join(root, 'setup', 'transcript-reader', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  // The page build reads the reader's own template and scripts from <root>/setup/transcript-reader: link this checkout's.
  for (const name of ['prototype', 'storeapi']) fs.symlinkSync(path.join(__dirname, '..', name), path.join(root, 'setup', 'transcript-reader', name));
  fs.writeFileSync(path.join(outDir, 'sessions.txt'), '');
  const sockets = new FakeHerdrSockets(path.join(base, 'sockets'));
  const socketPath = await sockets.start('work');
  const ids = made ? made.ids : {};
  const world = {
    focused: 'w1:p1', calls: [],
    panes: [
      { pane_id: 'w1:p1', tab_id: 'w1:t1', label: 'alpha-pane', agent: 'claude', agent_status: 'idle', agent_session: { value: ids.alpha || 'a1fa0001-0000-4000-8000-000000000001' } },
      { pane_id: 'w1:p2', tab_id: 'w1:t2', label: 'gamma-pane', agent: 'claude', agent_status: 'working', agent_session: { value: ids.gamma || '9a33a003-0000-4000-8000-000000000003' } },
    ],
  };
  if (!panes) world.panes = [];
  const runner = async (file, args) => {
    world.calls.push(args.join(' '));
    const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false });
    if (file === 'herdr' && args[0] === 'session') return ok({ sessions: [{ name: 'work', default: false, running: true, session_dir: base, socket_path: socketPath }] });
    if (file === 'herdr' && args[2] === 'api' && args[3] === 'snapshot') return ok({ result: { snapshot: { focused_pane_id: world.focused, panes: world.panes, tabs: [] } } });
    if (file === 'herdr' && args[2] === 'pane' && args[3] === 'process-info') return ok({ result: { process_info: { foreground_processes: [] } } });
    return { code: 1, stdout: '', stderr: 'unexpected', timedOut: false, truncated: false };
  };
  let api;
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) { res.writeHead(404); res.end('not found'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const config = path.join(base, 'config');
  api = create({
    root, outDir, port, runner, env: { PMOS_READER_STORE_DIR: path.join(base, 'store') },
    projectsDir: path.join(base, 'projects'), claudeSessionsDir: path.join(base, 'sessions'), codexSessionsDir: path.join(base, 'codex'), copilotHomeDir: path.join(base, 'copilot'),
    pinsFile: path.join(config, 'pins.json'), starsFile: path.join(config, 'stars.json'), sheetFlagsFile: path.join(config, 'flags.json'), hiddenFile: path.join(config, 'hidden.json'),
    pause: async () => {}, ...options, storeApi: { ...(options.storeApi || {}) },
  });
  const host = 'localhost:' + port;
  const request = ({ method = 'GET', path: urlPath, headers = {}, body }) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { Host: host, ...headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, raw, json }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  const open = (urlPath, headers = {}) => request({ path: urlPath, headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', ...headers } });
  const token = tokenIn((await open('/setup/transcript-reader/out/prototype.html').catch(() => ({ raw: '' }))).raw) || api.guard.token;
  const get = (command, headers = {}) => request({ path: '/api/transcript-reader/' + command, headers: { [TOKEN_HEADER]: token, ...headers } });
  // The stream: events as they arrive.
  const listen = (query = '') => new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/api/transcript-reader/stream' + query, headers: { Host: host, [TOKEN_HEADER]: token } }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          const lines = block.split('\n');
          const name = (lines.find((l) => l.startsWith('event: ')) || '').slice(7);
          const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
          if (name && data) events.push({ name, data: JSON.parse(data), at: Date.now() });
        }
      });
      resolve({ status: res.statusCode, headers: res.headers, events, close: () => req.destroy(), waitFor: (check, what, ms) => until(() => events.find(check), what, ms) });
    });
    req.on('error', reject);
    req.end();
  });
  return {
    base, ids, world, sockets, api, request, open, get, listen, token, host, port, lab: (...args) => lab(args[0], base, ...args.slice(1)),
    close: async () => { api.close(); await new Promise((resolve) => server.close(resolve)); await sockets.stop(); },
  };
}

test('flag off: none of the new routes or the page exists (as before the store API)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'store-api-off-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, 'setup', 'transcript-reader', 'out'), { recursive: true });
  let api;
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) { res.writeHead(404, { 'X-Unclaimed': '1' }); res.end('nope'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  api = create({ root, port, runner: async () => ({ code: 1, stdout: '', stderr: '' }), env: {}, claudeSessionsDir: path.join(base, 's'), projectsDir: path.join(base, 'p'), codexSessionsDir: path.join(base, 'c'), copilotHomeDir: path.join(base, 'h'), pinsFile: path.join(base, 'pins.json'), starsFile: path.join(base, 'stars.json'), sheetFlagsFile: path.join(base, 'f.json'), hiddenFile: path.join(base, 'h.json') });
  const get = (p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: p, headers: { Host: 'localhost:' + port, [TOKEN_HEADER]: api.guard.token } }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw })); }));
  try {
    for (const p of ['/api/transcript-reader/sessions', '/api/transcript-reader/asks', '/api/transcript-reader/search?q=x', '/api/transcript-reader/stream', '/api/transcript-reader/glance', '/api/transcript-reader/store-status']) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.equal(JSON.parse(r.raw).code, 'not_found', p);
    }
    assert.equal((await get('/setup/transcript-reader/windowed/index.html')).headers['x-unclaimed'], '1', 'the page is not claimed');
    assert.equal(api.storeApi, null);
  } finally { api.close(); server.close(); }
});

test('sessions: the list joins the store, Herdr\'s pane state and the stars; a session with a live pane and an open ask says so', async () => {
  const t = await start();
  try {
    t.lab('bind', 'work', 'w1:p1', t.ids.alpha);
    t.lab('bind', 'work', 'w1:p2', t.ids.gamma);
    fs.mkdirSync(path.join(t.base, 'config'), { recursive: true });
    await t.request({ method: 'POST', path: '/api/transcript-reader/stars', headers: { Origin: 'http://' + t.host, 'Content-Type': 'application/json', [TOKEN_HEADER]: t.token }, body: { op: 'star', conv: t.ids.beta } });
    const answer = await t.get('sessions');
    assert.equal(answer.status, 200);
    assert.equal(answer.json.status, 'ok');
    const byId = new Map(answer.json.sessions.map((s) => [s.id, s]));
    assert.equal(byId.size, 5);
    const alpha = byId.get(t.ids.alpha);
    assert.deepEqual([alpha.live.herdr, alpha.live.pane, alpha.live.label, alpha.live.status], ['work', 'w1:p1', 'alpha-pane', 'idle']);
    assert.equal(alpha.open_asks, 1);
    assert.equal(byId.get(t.ids.gamma).live.status, 'working');
    assert.equal(byId.get(t.ids.beta).starred, true);
    assert.equal(byId.get(t.ids.beta).live, null);
    assert.equal(byId.get(t.ids.beta).open_asks, 0, 'the ask was answered by a later message');
    assert.equal(answer.json.sessions[0].last_at >= answer.json.sessions.at(-1).last_at, true, 'newest first');
    const live = (await t.get('sessions?live=1')).json.sessions.map((s) => s.id).sort();
    assert.deepEqual(live, [t.ids.alpha, t.ids.gamma].sort());
    assert.deepEqual((await t.get('sessions?starred=1')).json.sessions.map((s) => s.id), [t.ids.beta]);
    assert.equal((await t.get('sessions?limit=2')).json.sessions.length, 2);
    assert.equal((await t.get('sessions?limit=2')).json.next, 2);
    assert.equal((await t.get('sessions?limit=x')).status, 400);
  } finally { await t.close(); }
});

test('turns: the newest window, older turns before an index, newer after one; the marks the page needs for the fold and open-ask rules', async () => {
  const t = await start();
  try {
    const tail = (await t.get(`sessions/${t.ids.gamma}/turns?limit=3`)).json;
    assert.equal(tail.turns.length, 3);
    assert.equal(tail.turns.at(-1).idx, tail.marks.last_idx);
    assert.equal(tail.more_before, true);
    assert.equal(tail.more_after, false);
    assert.deepEqual(tail.turns.map((turn) => turn.idx), [4, 5, 6].slice(-3).map((n, i, all) => tail.marks.last_idx - (all.length - 1 - i)));
    const older = (await t.get(`sessions/${t.ids.gamma}/turns?before=${tail.turns[0].idx}&limit=2`)).json;
    assert.deepEqual(older.turns.map((turn) => turn.idx), [tail.turns[0].idx - 2, tail.turns[0].idx - 1]);
    assert.equal(older.previous.idx, older.turns[0].idx - 1);
    const newer = (await t.get(`sessions/${t.ids.gamma}/turns?after=${tail.turns[0].idx}&limit=50`)).json;
    assert.deepEqual(newer.turns.map((turn) => turn.idx), tail.turns.slice(1).map((turn) => turn.idx));
    const whole = (await t.get(`sessions/${t.ids.gamma}/turns?limit=100`)).json;
    assert.equal(whole.turns.length, whole.marks.total);
    assert.equal(whole.more_before, false);
    assert.equal(whole.previous, null);
    // The turn carries what the cards draw.
    const turn = whole.turns.find((entry) => entry.source === 'wake');
    assert.ok(turn, 'a wake-up turn');
    for (const key of ['idx', 'uid', 'source', 'kind', 'label', 'input', 'at', 'reply', 'reply_at', 'reply_words', 'tools', 'verdict', 'asks', 'ask_lines', 'reminder_lines', 'narration', 'notices']) assert.ok(key in turn, key);
    assert.equal((await t.get(`sessions/${t.ids.gamma}/turns?after=1&before=2`)).status, 400);
    assert.equal((await t.get('sessions/nope-nope/turns')).status, 404);
    assert.equal((await t.get('sessions/..%2f..%2fetc/turns')).status, 400);
  } finally { await t.close(); }
});

test('asks: the open-asks shape, one for each live pane, newest first; a pane with no ask, and a session with no pane, have none', async () => {
  const t = await start();
  try {
    // Herdr's own report fills in for a pane the store has no binding for yet, so the asks are there from the start.
    assert.equal((await t.get('asks')).json.asks.some((ask) => ask.session === t.ids.alpha), true);
    t.lab('bind', 'work', 'w1:p1', t.ids.alpha);
    t.lab('bind', 'work', 'w1:p2', t.ids.gamma);
    const asks = (await t.get('asks')).json;
    assert.equal(asks.status, 'ok');
    assert.equal(asks.asks.length >= 1, true);
    const alpha = asks.asks.find((ask) => ask.session === t.ids.alpha);
    assert.deepEqual([alpha.pane_id, alpha.herdr], ['w1:p1', 'work']);
    assert.deepEqual(alpha.lines, ['Which of the two options do you want?']);
    assert.equal(typeof alpha.message, 'string');
    assert.equal(alpha.older, false);
    assert.match(alpha.at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(Object.keys(alpha).sort(), ['at', 'herdr', 'lines', 'message', 'older', 'pane_id', 'session', 'tags']);
    const times = asks.asks.map((ask) => ask.at);
    assert.deepEqual(times, [...times].sort().reverse());
    // An ask answered by a later message is no longer open.
    t.lab('bind', 'work', 'w1:p3', t.ids.beta);
    assert.equal((await t.get('asks')).json.asks.some((ask) => ask.session === t.ids.beta), false);
    // The glance feed is the same asks as a store query, in the feed's own shape.
    const glance = (await t.get('glance')).json;
    assert.equal(glance.version, 1);
    const record = glance.conversations.find((c) => c.id === t.ids.alpha);
    assert.deepEqual([record.open_asks, record.ask.lines, record.pane], [1, ['Which of the two options do you want?'], { label: 'alpha-pane', herdr: 'work', live: true }]);
  } finally { await t.close(); }
});

test('search: one row for each session, best turn first, with the matched words marked; empty and odd queries are safe', async () => {
  const t = await start();
  try {
    const found = (await t.get('search?q=' + encodeURIComponent('tests pass'))).json;
    assert.equal(found.scope, 'all');
    assert.equal(found.results[0].id, t.ids.alpha);
    assert.match(found.results[0].snippet, /\[\[/);
    assert.equal(found.results.filter((r) => r.id === t.ids.alpha).length, 1);
    assert.equal((await t.get('search?q=' + encodeURIComponent('"; DROP TABLE turns; --'))).status, 200);
    assert.equal((await t.get('search?q=')).status, 400);
    assert.deepEqual((await t.get('search?q=zzzqqq')).json.results, []);
  } finally { await t.close(); }
});

test('the phone (W3): a tailnet request reaches only the starred and the open-pane conversations, in the list, the turns, the search and the stream', async () => {
  const t = await start();
  try {
    t.lab('bind', 'work', 'w1:p1', t.ids.alpha);
    await t.request({ method: 'POST', path: '/api/transcript-reader/stars', headers: { Origin: 'http://' + t.host, 'Content-Type': 'application/json', [TOKEN_HEADER]: t.token }, body: { op: 'star', conv: t.ids.beta } });
    const sApi = t.api.storeApi;
    const call = (route, remote, query = '') => new Promise((resolve) => {
      const res = { writeHead(status) { this.status = status; }, write() {}, end(body) { resolve({ status: this.status, json: body ? JSON.parse(body) : null }); }, on() {}, setHeader() {} };
      const url = new URL('http://x/api/transcript-reader/' + route + query);
      try { sApi.handle({ method: 'GET', headers: {} }, res, url.pathname, url.searchParams, { api: '/api/transcript-reader/', remote }); } catch (error) { resolve({ status: error.status, json: { code: error.code } }); }
    });
    const laptop = await call('sessions', false);
    assert.equal(laptop.json.sessions.length, 5);
    const phone = await call('sessions', true);
    assert.deepEqual(phone.json.sessions.map((s) => s.id).sort(), [t.ids.alpha, t.ids.beta].sort());
    assert.equal((await call(`sessions/${t.ids.alpha}/turns`, true)).status, 200);
    assert.equal((await call(`sessions/${t.ids.gamma}/turns`, true)).status, 404, 'a session outside the set is not there');
    assert.equal((await call(`sessions/${t.ids.gamma}/turns`, false)).status, 200);
    const text = '?q=' + encodeURIComponent('Synthetic alpha work');  // gamma's own words (its title): on the laptop it is found, on the phone it is not
    assert.equal((await call('search', false, text)).json.results.some((r) => r.id === t.ids.gamma), true);
    const onPhone = (await call('search', true, text)).json;
    assert.equal(onPhone.scope, 'curated');
    assert.equal(onPhone.results.some((r) => r.id === t.ids.gamma), false);
    assert.equal((await call('search', true, '?q=' + encodeURIComponent('Should I merge it'))).json.results.every((r) => [t.ids.alpha, t.ids.beta].includes(r.id)), true);
  } finally { await t.close(); }
});

test('stream: a turn appended to a log reaches a client that holds the session open, as one small event; others see the counters move', async () => {
  const t = await start({ options: { storeApi: { pollMs: 40 } } });
  try {
    t.lab('bind', 'work', 'w1:p1', t.ids.alpha);
    const stream = await t.listen(`?sessions=${t.ids.alpha}`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers['content-type'], /text\/event-stream/);
    assert.equal(stream.headers['content-encoding'], 'identity');
    const hello = await stream.waitFor((e) => e.name === 'hello', 'hello');
    assert.equal(hello.data.sessions[t.ids.alpha].last_idx, 1);
    await stream.waitFor((e) => e.name === 'live', 'the live snapshot');
    await stream.waitFor((e) => e.name === 'asks', 'the asks snapshot');
    const before = stream.events.length;
    t.lab('append', t.ids.alpha, 'user', 'LAB-MARK-1 and one more question?');
    const turns = await stream.waitFor((e) => e.name === 'turns' && e.data.turns.some((turn) => /LAB-MARK-1/.test(turn.input)), 'the new turn');
    assert.equal(turns.data.id, t.ids.alpha);
    assert.equal(turns.data.turns.length, 1, 'only the new turn, not the window');
    assert.equal(turns.data.turns[0].idx, 2);
    assert.equal(turns.data.marks.last_idx, 2);
    assert.ok(stream.events.length - before <= 4, 'a few events for one append');
    // The reply grows the same turn in place: the tail turn is sent again, changed.
    t.lab('append', t.ids.alpha, 'say', 'LAB-MARK-2 the answer, done.');
    const grown = await stream.waitFor((e) => e.name === 'turns' && e.data.turns.some((turn) => /LAB-MARK-2/.test(turn.reply)), 'the reply');
    assert.equal(grown.data.turns.length, 1);
    assert.equal(grown.data.turns[0].idx, 2);
    // The session row's counters moved too.
    assert.ok(stream.events.some((e) => e.name === 'session' && e.data.id === t.ids.alpha && e.data.turns === 3));
    // The new ask (the question is a reply that needs you) shows in the asks.
    t.lab('append', t.ids.alpha, 'say', 'LAB-MARK-3 Should I go on?');
    const asks = await stream.waitFor((e) => e.name === 'asks' && e.data.asks.some((a) => a.session === t.ids.alpha && a.lines.some((l) => /go on/.test(l))), 'the new ask');
    assert.equal(asks.data.asks.length >= 1, true);
    stream.close();
    await until(() => t.api.storeApi.hub.stats().clients === 0, 'the client to go');
  } finally { await t.close(); }
});

test('stream: a Herdr state change reaches a client as a live change; a pane that closes goes; nothing runs with no client', async () => {
  const t = await start({ options: { storeApi: { pollMs: 40 } } });
  try {
    t.lab('bind', 'work', 'w1:p1', t.ids.alpha);
    const stream = await t.listen();
    await stream.waitFor((e) => e.name === 'live' && e.data.snapshot, 'the live snapshot');
    await until(() => t.sockets.subscribers('work') === 1, 'the Herdr subscription');
    t.sockets.emit('work', 'pane.agent_status_changed', { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' });
    const change = await stream.waitFor((e) => e.name === 'live' && !e.data.snapshot && e.data.changes.some((c) => c.id === t.ids.alpha && c.live.status === 'working'), 'the status change');
    assert.equal(change.data.changes.length, 1);
    stream.close();
    await until(() => t.api.storeApi.hub.stats().clients === 0 && t.api.storeApi.hub.stats().watching === false, 'the hub to go quiet');
  } finally { await t.close(); }
});

test('the guard still holds: no token, no stream, no list; and the page is for a browser tab only', async () => {
  const t = await start();
  try {
    assert.equal((await t.request({ path: '/api/transcript-reader/sessions' })).status, 403);
    assert.equal((await t.request({ path: '/api/transcript-reader/stream' })).status, 403);
    assert.equal((await t.request({ path: '/api/transcript-reader/sessions', headers: { [TOKEN_HEADER]: t.token, Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await t.request({ method: 'POST', path: '/api/transcript-reader/sessions', headers: { Origin: 'http://' + t.host, 'Content-Type': 'application/json', [TOKEN_HEADER]: t.token }, body: {} })).status, 405);
    const page = await t.open('/setup/transcript-reader/windowed/index.html');
    assert.equal(page.status, 200);
    assert.equal(page.raw.split(t.token).length, 2, 'the token is in the page once, in its tag');
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(page.raw, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.equal((await t.request({ path: '/setup/transcript-reader/windowed/index.html', headers: { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } })).status, 403);
    assert.equal(tokenIn(page.raw), t.token);
    assert.doesNotMatch(page.raw, new RegExp(TOKEN_META.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('__READER_TOKEN__', '__READER_TOKEN__')));
  } finally { await t.close(); }
});

test('a store that is missing or that is another version answers 503 with the reason, and never crashes the server', async () => {
  const t = await start({ noStore: true });
  try {
    const answer = await t.get('sessions');
    assert.equal(answer.status, 503);
    assert.equal(answer.json.code, 'store_unavailable');
    assert.match(answer.json.message, /no store/i);
    const status = (await t.get('store-status')).json;
    assert.equal(status.store.available, false);
    assert.equal((await t.get('stream')).status, 503);
  } finally { await t.close(); }
  const other = await start();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const file = path.join(other.base, 'store', 'reader-store.sqlite');
    other.api.storeApi.store.close();
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 2');
    db.close();
    const answer = await other.get('sessions');
    assert.equal(answer.status, 503);
    assert.match(answer.json.message, /schema version 2/);
  } finally { await other.close(); }
});

test('Herdr is watched, not polled: state reads cost no Herdr call after the first, and a pane the store binds takes the store\'s session', async () => {
  const t = await start({ options: { storeApi: { pollMs: 40 } } });
  try {
    const token = { [TOKEN_HEADER]: t.token };
    const first = await t.request({ path: '/api/transcript-reader/state', headers: token });
    assert.equal(first.status, 200);
    await until(() => t.sockets.subscribers('work') === 1, 'the Herdr subscription');
    await sleep(150);  // the read that follows the subscription starting
    const calls = t.world.calls.length;
    for (let i = 0; i < 5; i += 1) await t.request({ path: '/api/transcript-reader/state', headers: token });
    assert.equal(t.world.calls.length, calls, 'five more polls, no Herdr call');
    // Herdr says w1:p1 runs gamma (a stale id); the store's live binding says alpha, and that is what the reader uses.
    t.world.panes[0].agent_session = { value: t.ids.gamma };
    t.lab('bind', 'work', 'w1:p1', t.ids.alpha);
    t.sockets.emit('work', 'pane.updated', { pane_id: 'w1:p1' });
    await until(async () => (await t.api.scan()).flatMap((s) => s.panes).find((p) => p.pane_id === 'w1:p1').session_id === t.ids.alpha, 'the store binding to win');
    const pane = (await t.api.scan()).flatMap((s) => s.panes).find((p) => p.pane_id === 'w1:p1');
    assert.equal(pane.session_id, t.ids.alpha);
    // A status event moves the state the poll reports, with no Herdr call.
    const before = t.world.calls.length;
    t.sockets.emit('work', 'pane.agent_status_changed', { pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'done' });
    await until(async () => (await t.api.scan()).flatMap((s) => s.panes).find((p) => p.pane_id === 'w1:p2').status === 'done', 'the status event');
    assert.equal(t.world.calls.length, before);
  } finally { await t.close(); }
});

test('compatibility writers: out/pane-labels.json keeps the builder\'s format and what it had; glance.json follows the store; neither is rewritten when nothing changed', async () => {
  const t = await start({ options: { storeApi: { pollMs: 40, compat: { writeGlance: true } } } });
  try {
    const out = path.join(t.base, 'repo', 'setup', 'transcript-reader', 'out');
    fs.writeFileSync(path.join(out, 'pane-labels.json'), JSON.stringify({ 'dead0000-0000-4000-8000-000000000000': { herdr: 'old', label: 'closed one', life: '1', pane: 'w9:p9', status: 'idle', title: 'x' } }, null, 1));
    t.lab('bind', 'work', 'w1:p1', t.ids.alpha);
    await t.get('state');
    const labels = await until(() => { try { const v = JSON.parse(fs.readFileSync(path.join(out, 'pane-labels.json'), 'utf8')); return v[t.ids.alpha] ? v : null; } catch { return null; } }, 'pane-labels.json');
    assert.deepEqual(Object.keys(labels[t.ids.alpha]).sort(), ['herdr', 'label', 'life', 'pane', 'status', 'title']);
    assert.equal(labels[t.ids.alpha].label, 'alpha-pane');
    assert.equal(labels['dead0000-0000-4000-8000-000000000000'].label, 'closed one', 'a closed pane keeps its last label');
    assert.equal((fs.statSync(path.join(out, 'pane-labels.json')).mode & 0o777), 0o600);
    const glance = await until(() => { try { const v = JSON.parse(fs.readFileSync(path.join(out, 'glance.json'), 'utf8')); return v.conversations.length ? v : null; } catch { return null; } }, 'glance.json');
    assert.equal(glance.version, 1);
    assert.equal(glance.conversations.find((c) => c.id === t.ids.alpha).open_asks, 1);
    const mtime = fs.statSync(path.join(out, 'pane-labels.json')).mtimeMs;
    const glanceTime = fs.statSync(path.join(out, 'glance.json')).mtimeMs;
    t.sockets.emit('work', 'pane.updated', { pane_id: 'w1:p1' });   // nothing in it changed
    await sleep(400);
    assert.equal(fs.statSync(path.join(out, 'pane-labels.json')).mtimeMs, mtime);
    assert.equal(fs.statSync(path.join(out, 'glance.json')).mtimeMs, glanceTime);
    // A status change rewrites the labels but not the glance (the feed holds no pane state).
    t.sockets.emit('work', 'pane.agent_status_changed', { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' });
    await until(() => JSON.parse(fs.readFileSync(path.join(out, 'pane-labels.json'), 'utf8'))[t.ids.alpha].status === 'working', 'the new status in the file');
    assert.equal(fs.statSync(path.join(out, 'glance.json')).mtimeMs, glanceTime);
  } finally { await t.close(); }
});
