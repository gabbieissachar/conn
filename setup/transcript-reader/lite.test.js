'use strict';

// Tests for the lite page: the reader page's code in mode "live" (out/live/index.html), which loads one conversation at a time from the objects
// each build writes beside it, and is served and live like the local page. Run from the repo root:
//   node --test setup/transcript-reader/lite.test.js
// Two parts. The server's routes for it (api.js) run on temporary files, with Herdr faked and no page of the 34 MB kind at all. The page's own
// rules (the two flags that replaced HOSTED, Follow, what a lazy page loads) are read from template.html as text and run on stand-ins, as
// layout.test.js and copy.test.js read the page. The build's side is test_live.py; hosted.js's is hosted.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { create, TOKEN_HEADER, TOKEN_META } = require('./api');

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const PAGE = '/setup/transcript-reader/out/live/index.html';
const OBJECTS = '/setup/transcript-reader/out/live/';
const FETCH = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
const NAVIGATE = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

const shell = (title) => `<!doctype html><head>${TOKEN_META}<title>${title}</title></head><script id="payload" type="application/json">null</script>`;
const tokenIn = (html) => (html.match(/<meta name="reader-token" content="([^"]*)">/) || [])[1];

// A server over a temporary out/ folder holding what a build leaves for the lite page. There is no prototype.html and no prototype.stamp
// until a test writes them: the lite page needs neither. Herdr is not running (the fake answers that it is not).
async function start({ withPage = false, watch = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-lite-')));
  const root = path.join(base, 'repo');
  const outDir = path.join(root, 'setup', 'transcript-reader', 'out');
  const home = path.join(base, 'home');
  const temp = path.join(base, 'temp');
  for (const dir of [path.join(outDir, 'live', 's'), home, temp]) fs.mkdirSync(dir, { recursive: true });
  const notes = path.join(home, 'notes.md');
  fs.writeFileSync(notes, '# Notes\n\nThe plan.\n');
  fs.writeFileSync(path.join(home, 'secret.txt'), 'not markdown');
  const live = path.join(outDir, 'live');
  fs.writeFileSync(path.join(live, 'index.html'), shell('lite page'));
  fs.writeFileSync(path.join(live, 'index.json'), JSON.stringify({ as_of: 5, conversations: [{ id: A, object: `s/${A}.json`, stamp: 'x' }] }));
  fs.writeFileSync(path.join(live, 's', `${A}.json`), JSON.stringify({ id: A, exchanges: [{ at: 1, input: 'hello' }], documents: {} }));
  fs.writeFileSync(path.join(live, 'md-files.json'), JSON.stringify({ aaaaaaaaaa: notes, bbbbbbbbbb: path.join(home, 'secret.txt') }));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ secret: true }));
  fs.writeFileSync(path.join(outDir, 'sessions.txt'), `${A}\n`);
  if (withPage) {
    fs.writeFileSync(path.join(outDir, 'prototype.html'), shell('reader'));
    fs.writeFileSync(path.join(outDir, 'prototype.stamp'), '5');
  }
  const runner = async () => ({ code: 1, stdout: '', stderr: 'herdr is not running', timedOut: false, truncated: false });
  let api;
  const server = http.createServer((req, res) => {
    if (api.handle(req, res)) return;
    fs.readFile(path.join(root, decodeURIComponent(req.url.split('?')[0])), (error, data) => {
      if (error) { res.writeHead(404, { 'X-Static': '1' }); res.end('static: not found'); return; }
      res.writeHead(200, { 'X-Static': '1' }); res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  api = create({ root, outDir, port, runner, homeDir: home, tempRoots: [temp], claudeSessionsDir: path.join(base, 'sessions'), projectsDir: path.join(base, 'projects'), codexSessionsDir: path.join(base, 'codex'), pinsFile: path.join(base, 'pins.json'), starsFile: path.join(base, 'stars.json'), watch, sweepMs: 20 });
  const host = 'localhost:' + port;
  const request = ({ method = 'GET', path: urlPath, headers = {}, body }) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ agent: false, host: '127.0.0.1', port, method, path: urlPath, headers: { Host: host, ...headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, raw, json }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  const open = (urlPath = PAGE, headers = {}) => request({ path: urlPath, headers: { ...NAVIGATE, ...headers } });
  const token = tokenIn((await open()).raw);
  const asPage = (urlPath, extra = {}) => request({ path: urlPath, headers: { ...FETCH, [TOKEN_HEADER]: token, ...extra } });
  const openMd = (id) => request({ method: 'POST', path: '/api/transcript-reader/md-open', headers: { Origin: 'http://' + host, 'Content-Type': 'application/json', [TOKEN_HEADER]: token }, body: { id } });
  return { base, home, temp, outDir, live, request, open, asPage, openMd, token, api, close: () => new Promise((resolve) => { api.close(); server.close(() => { fs.rmSync(base, { recursive: true, force: true }); resolve(); }); }) };
}

// ------------------------------------------------------------------------------------------------------------------------ the server

test('lite: the page opens in a tab like any page, with the token in its tag, and never in a frame or a script\'s fetch', async () => {
  const t = await start();
  try {
    const page = await t.open();
    assert.equal(page.status, 200);
    assert.equal(tokenIn(page.raw), t.token);
    assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'");
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(Object.keys(page.headers).some((name) => name.startsWith('access-control')), false);
    assert.match(fs.readFileSync(path.join(t.live, 'index.html'), 'utf8'), /content="__READER_TOKEN__">/, 'the built file never holds a token');
    assert.equal((await t.request({ path: PAGE, headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' } })).status, 403, 'framed');
    assert.equal((await t.request({ path: PAGE, headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } })).status, 403, 'a script\'s fetch gets no page, so no token');
    assert.equal((await t.request({ path: PAGE, headers: { ...NAVIGATE, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await t.request({ path: PAGE, headers: { ...NAVIGATE, Host: 'evil.example:80' } })).status, 403);
  } finally { await t.close(); }
});

test('lite: a page that is not built yet says to run reader.py, not the hosted copy\'s sync', async () => {
  const t = await start();
  try {
    fs.unlinkSync(path.join(t.live, 'index.html'));
    const missing = await t.open();
    assert.equal(missing.status, 404);
    assert.match(missing.raw, /reader\.py/);
    assert.doesNotMatch(missing.raw, /sync\.py/);
  } finally { await t.close(); }
});

test('lite: the index and one conversation\'s object go to the page\'s own token-bearing fetch, and to nothing else', async () => {
  const t = await start();
  try {
    for (const name of ['index.json', `s/${A}.json`]) {
      const got = await t.asPage(OBJECTS + name);
      assert.equal(got.status, 200, name);
      assert.equal(got.raw, fs.readFileSync(path.join(t.live, name), 'utf8'), name);
      assert.equal(got.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(got.headers['cache-control'], 'no-store');
      assert.equal(Object.keys(got.headers).some((header) => header.startsWith('access-control')), false);
      for (const headers of [FETCH, { ...FETCH, [TOKEN_HEADER]: 'b'.repeat(64) }, NAVIGATE, { 'Sec-Fetch-Site': 'cross-site', [TOKEN_HEADER]: t.token }, { Origin: 'http://evil.example', [TOKEN_HEADER]: t.token }]) {
        const refused = await t.request({ path: OBJECTS + name, headers });
        assert.equal(refused.status, 403, name + ' ' + JSON.stringify(headers));
        assert.doesNotMatch(refused.raw, /hello|as_of/);
      }
    }
    assert.equal((await t.asPage(OBJECTS + `s/${B}.json`)).status, 404, 'a conversation with no object');
  } finally { await t.close(); }
});

test('lite: its markdown listing, the manifest and any other name or spelling are never served, nor handed to the static handler', async () => {
  const t = await start();
  try {
    for (const name of ['md-files.json', 'manifest.json', 's/', `s/${A}.jsonl`, `s/../../manifest.json`, 'x/a.json', 'index.json.partial', 's/sub/a.json', `d/${A}.json`, `t/${A}.json`, 'f/2026-W43.json']) {
      const response = await t.asPage(OBJECTS + name);
      assert.equal(response.headers['x-static'], undefined, name);
      assert.notEqual(response.status, 200, name);
      assert.doesNotMatch(response.raw, /aaaaaaaaaa|secret|hello/, name);
    }
    const plain = await t.request({ path: OBJECTS + 'md-files.json' });
    assert.equal(plain.headers['x-static'], undefined);
    assert.doesNotMatch(plain.raw, /notes/);
    const outer = await t.request({ path: '/setup/transcript-reader/out/manifest.json' });
    assert.equal(outer.headers['x-static'], undefined, 'out/ is the reader\'s whole');
  } finally { await t.close(); }
});

test('lite: the page, its objects, the state and the wait for builds are answered with no 34 MB page at all (nothing parses it)', async () => {
  const t = await start({ withPage: false, watch: true });
  try {
    assert.equal(fs.existsSync(path.join(t.outDir, 'prototype.html')), false);
    assert.equal((await t.open()).status, 200);
    assert.equal((await t.asPage(OBJECTS + 'index.json')).status, 200);
    assert.equal((await t.asPage(OBJECTS + `s/${A}.json`)).status, 200);
    const state = await t.asPage('/api/transcript-reader/state');
    assert.equal(state.status, 200);
    assert.equal(state.json.stamps.reader, null, 'no page, so no stamp: the lite page waits on the stamp the build writes after its objects');
    // The wait is answered the moment a stamp newer than the page's is written, which is what every build ends with.
    const waiting = t.asPage('/api/transcript-reader/events?reader=5&wait=20000');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const written = Date.now();
    fs.writeFileSync(path.join(t.outDir, 'prototype.stamp'), '6');
    const answered = await waiting;
    assert.equal(answered.status, 200);
    assert.equal(answered.json.stamps.reader, 6);
    assert.ok(Date.now() - written < 2000, 'answered when the stamp was written, not when the wait ran out');
    assert.equal(fs.existsSync(path.join(t.outDir, 'prototype.html')), false, 'and still no page was read or made');
  } finally { await t.close(); }
});

test('lite: a markdown file a conversation names is opened as it is on disk now, through the same checks as every md-open', async () => {
  const t = await start();
  try {
    const opened = await t.openMd('aaaaaaaaaa');
    assert.equal(opened.status, 200, opened.raw);
    assert.equal(opened.json.text, '# Notes\n\nThe plan.\n');
    assert.equal(opened.json.name, 'notes.md');
    fs.writeFileSync(path.join(t.home, 'notes.md'), '# Notes\n\nRevised.\n');
    assert.equal((await t.openMd('aaaaaaaaaa')).json.text, '# Notes\n\nRevised.\n', 'as it is now, not as of the build');
    assert.equal((await t.openMd('bbbbbbbbbb')).status, 404, 'a listed file that is not markdown');
    assert.equal((await t.openMd('cccccccccc')).status, 404, 'an id no listing names');
    // The page's own listing is looked in first, and an id only the lite listing names is still found.
    fs.writeFileSync(path.join(t.outDir, 'md-files.json'), JSON.stringify({ dddddddddd: path.join(t.home, 'notes.md') }));
    assert.equal((await t.openMd('dddddddddd')).status, 200);
    assert.equal((await t.openMd('aaaaaaaaaa')).status, 200);
    // A file outside the home and temp folders is refused whoever lists it.
    const outside = path.join(t.base, 'outside.md');
    fs.writeFileSync(outside, 'secret');
    fs.writeFileSync(path.join(t.live, 'md-files.json'), JSON.stringify({ eeeeeeeeee: outside }));
    assert.equal((await t.openMd('eeeeeeeeee')).status, 403);
  } finally { await t.close(); }
});

// --------------------------------------------------------------------------------------------------------------------- the page

const PAGE_SOURCE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const lines = (re) => PAGE_SOURCE.split('\n').filter((line) => re.test(line));
const fnSource = (name) => PAGE_SOURCE.slice(PAGE_SOURCE.indexOf(`function ${name}(`), PAGE_SOURCE.indexOf('\n  }\n', PAGE_SOURCE.indexOf(`function ${name}(`)) + 5);
const filled = (mode) => {
  const done = spawnSync('python3', ['-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import build_prototype as b; sys.stdout.write(b.fill_template(b.TEMPLATE, "null", sys.argv[2])[0])', path.join(__dirname, 'prototype'), mode], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(done.status, 0, done.stderr);
  return done.stdout;
};

test('flags: one page, three modes, and two questions: does it load one conversation at a time (LAZY), and is there a laptop to ask (HOSTED)', () => {
  assert.ok(PAGE_SOURCE.includes('const MODE = "__MODE__";'));
  assert.ok(PAGE_SOURCE.includes('const LAZY = MODE !== "local";'));
  assert.ok(PAGE_SOURCE.includes('const HOSTED = MODE === "hosted";'));
  for (const [mode, lazy, hosted] of [['local', false, false], ['hosted', true, true], ['live', true, false]]) {
    const page = filled(mode);
    assert.ok(page.includes(`const MODE = "${mode}";`), mode);
    const flags = vm.runInNewContext(`const MODE = "${mode}"; const LAZY = MODE !== "local"; const HOSTED = MODE === "hosted"; [LAZY, HOSTED, LAZY && !HOSTED]`);
    assert.deepEqual([flags[0], flags[1]], [lazy, hosted], mode);
    assert.equal(page.includes('const hosted = (() => {'), lazy, mode + ': the loader is in every lazy page');
    assert.equal(page.includes('const hosted = null;'), !lazy, mode);
    assert.equal(page.includes('/*__'), false, mode + ': no slot left');
  }
});

test('flags: what loads lazily is asked of LAZY and what needs no laptop of HOSTED, never the other way round', () => {
  // The loader's calls that load an object: a line that makes one must not be reserved for the hosted copy alone.
  for (const line of lines(/hosted\.(conversation|index|data|fleet)\(/)) {
    if (/\bHOSTED\b/.test(line)) assert.match(line, /LAZY|\? hosted\.(prepare|index)/, 'a loader call under HOSTED alone would leave the lite page without its conversation: ' + line.trim());
  }
  assert.ok(PAGE_SOURCE.includes('const canLive = live.served && !HOSTED;'), 'the lite page is served: it can send, follow and sync');
  assert.ok(PAGE_SOURCE.includes('if (!HOSTED) live.poll(async () => {'));
  assert.ok(PAGE_SOURCE.includes('if (!HOSTED) live.waitForBuilds('));
  assert.ok(PAGE_SOURCE.includes('const queued = HOSTED ? await hosted.enqueue(sid, text) : null;'), 'a send is queued only for the hosted copy');
  assert.ok(PAGE_SOURCE.includes('await attach.deliver(sentPhotos'), 'and goes straight to the pane (live.send) otherwise, whatever loads lazily');
  assert.ok(PAGE_SOURCE.includes('const SEND_HANDOFF_KEY = HOSTED ?'));
  assert.ok(PAGE_SOURCE.includes('const READ_KEY = HOSTED ?'));
});

test('lite: a build is taken by reading the index and the one conversation on screen, never the page and never a delta of it', () => {
  const take = fnSource('takeBuild');
  assert.ok(take.includes('if (LAZY && !HOSTED) { await refreshLazy(now); return; }'));
  assert.ok(take.indexOf('refreshLazy(now)') < take.indexOf('live.delta('), 'the lazy page returns before the page\'s own delta and full page below it');
  const lazy = fnSource('refreshLazy');
  assert.match(lazy, /hosted\.index\(\)/);
  assert.match(lazy, /hosted\.conversation\(reading\)/);
  assert.doesNotMatch(lazy, /live\.(page|delta)\(/);
  assert.doesNotMatch(lazy, /DOMParser|JSON\.parse/);
});

test('lite: the page opens and polls without the hosted copy\'s sealed-copy steps, and its poll waits for its first index', () => {
  const boot = PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('if (!LAZY) openReading(chooseOpening());'), PAGE_SOURCE.indexOf('async function reopenLost'));
  assert.ok(boot.includes('(HOSTED ? hosted.prepare().then(state => state === "locked" ? hosted.askPassphrase() : null) : Promise.resolve()).then(() => hosted.index())'), 'no passphrase, no worker, no stored copy');
  assert.ok(boot.includes('document.querySelector(".to-sheet").href = SHEET_PAGE;'));
  assert.ok(boot.includes('started = true;'));
  assert.ok(boot.includes('if (!HOSTED) return;'), 'the lite page has the live poll and the wait for builds already, not the hosted copy\'s 30 seconds');
  assert.ok(PAGE_SOURCE.includes('let started = !LAZY;'));
  assert.ok(PAGE_SOURCE.includes('if (!started) return;'), 'the poll takes the state and nothing of the data before the index is in');
  assert.ok(PAGE_SOURCE.includes('stamps => started ? refreshData(false, stamps.reader) : undefined'));
  assert.ok(PAGE_SOURCE.includes('const SHEET_PAGE = HOSTED ? "sheet.html" : MODE === "live" ? "../questionnaire.html" : "questionnaire.html";'), 'the lite page is in out/live/: the local answer sheet is a folder up');
});

test('lite: a document has an object to load only in the hosted copy; a markdown file of the lite page is read through the server when opened', () => {
  const source = `const LAZY = true; ${PAGE_SOURCE.match(/const hasObject = .*;/)[0]} ${fnSource('missing')}`;
  const make = (documents, extra = {}) => vm.runInNewContext(`${source}\nmissing`, {
    state: { view: 'doc', session: 0, doc: 'd', ...extra }, data: { sessions: [{ exchanges: [] }], documents, fleet: null },
    fleetOn: () => false, onFilePage: () => true, pickDoc: () => 'd',
  });
  assert.equal(make({ d: { text: null, object: 'd/d.json' } })(), true, 'the hosted copy\'s document: its text is an object to load');
  assert.equal(make({ d: { lazy: true } })(), false, 'a lite page\'s markdown file: opened through md-open, nothing to load');
  assert.equal(make({ d: { kind: 'image', size: 3 } })(), false, 'a picture or a page: shown through image-open or html-open');
  assert.equal(make({ d: { text: '# loaded', object: 'd/d.json' } })(), false);
  assert.equal(vm.runInNewContext(`${source}\nmissing`, { state: { view: 'reader', session: 0 }, data: { sessions: [{ exchanges: null }], documents: {} }, fleetOn: () => false, onFilePage: () => false, pickDoc: () => null })(), true, 'a conversation not loaded yet');
});

// Follow. The local page follows Herdr unless it was turned off; the lite page is opened on one conversation and stays there until Follow is turned on for it.
function followStartup({ mode, saved }) {
  const from = PAGE_SOURCE.indexOf('const FOLLOW_KEY =');
  const to = PAGE_SOURCE.indexOf('\n', PAGE_SOURCE.indexOf('state.follow = MODE === "live"', from));
  const keys = [];
  const localStorage = { getItem: (key) => { keys.push(key); return saved === undefined ? null : saved; } };
  const state = { follow: true };
  vm.runInNewContext(PAGE_SOURCE.slice(from, to), { MODE: mode, state, localStorage });
  return { follow: state.follow, key: keys[0] };
}

test('follow: the local page follows unless it was turned off; the lite page does not until it is turned on, in a setting of its own', () => {
  assert.deepEqual(followStartup({ mode: 'local' }), { follow: true, key: 'tr-follow' });
  assert.equal(followStartup({ mode: 'local', saved: '0' }).follow, false);
  assert.equal(followStartup({ mode: 'hosted' }).follow, true);
  assert.deepEqual(followStartup({ mode: 'live' }), { follow: false, key: 'tr-live-follow' });
  assert.equal(followStartup({ mode: 'live', saved: '1' }).follow, true);
  assert.equal(followStartup({ mode: 'live', saved: '0' }).follow, false);
  assert.ok(PAGE_SOURCE.includes('localStorage.setItem(FOLLOW_KEY, state.follow ? "1" : "0")'), 'turning it on or off is kept under the same key it is read from');
});

function focusWorld({ follow, first = true, keepOpening = true, loaded = true }) {
  const calls = [];
  const sessions = [{ id: 'a', ids: ['a'], exchanges: loaded ? [] : null }, { id: 'b', ids: ['b'], exchanges: loaded ? [] : null }];
  const world = {
    link: { focus: null, first, keepOpening, seenSeq: undefined, want: null, held: null }, state: { follow, session: 0, view: 'reader' },
    data: { sessions }, writing: () => false, look: { open: false }, renderDock: () => calls.push('dock'), setAddress: () => calls.push('address'),
    whenReady: (show) => { calls.push('whenReady'); show(); }, render: () => calls.push('render'), showLatest: () => calls.push('latest'),
  };
  const apply = vm.runInNewContext(`${fnSource('applyFocus')}\napplyFocus`, world);
  return { world, apply, calls };
}

test('follow: the first focus a page sees is its own opening, even with Follow off, so turning Follow on goes where Herdr is now', () => {
  const { world, apply, calls } = focusWorld({ follow: false });
  world.link.focus = { seq: 1, session_id: 'b', label: 'beta' };
  apply();
  assert.equal(world.link.first, false, 'seen, though not followed');
  assert.equal(world.state.session, 0, 'Follow is off: it stays');
  world.state.follow = true;
  world.link.seenSeq = null;  // toggleFollow
  apply();
  assert.equal(world.state.session, 1, 'and Follow on switches to the pane Herdr has focused');
  assert.deepEqual(calls.slice(-4), ['address', 'whenReady', 'render', 'latest']);
});

test('follow: a page opened on a conversation by its address keeps it for the first focus when Follow is on, and follows the next', () => {
  const { world, apply } = focusWorld({ follow: true });
  world.link.focus = { seq: 1, session_id: 'b', label: 'beta' };
  apply();
  assert.equal(world.state.session, 0, 'the address wins over the first focus');
  world.link.focus = { seq: 2, session_id: 'b', label: 'beta' };
  apply();
  assert.equal(world.state.session, 1);
});

test('follow: a conversation not loaded yet is loaded before it is drawn and scrolled to its newest turn', () => {
  const order = [];
  const { world, apply } = focusWorld({ follow: true, first: false, loaded: false });
  world.whenReady = (show) => { order.push('load'); Promise.resolve().then(show); };
  world.render = () => order.push('render');
  world.showLatest = () => order.push('latest');
  world.link.focus = { seq: 3, session_id: 'b', label: 'beta' };
  apply();
  assert.deepEqual(order, ['load'], 'nothing is drawn or scrolled until the load is done');
  return Promise.resolve().then(() => assert.deepEqual(order, ['load', 'render', 'latest']));
});
