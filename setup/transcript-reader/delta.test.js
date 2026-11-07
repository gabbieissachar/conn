'use strict';

// The update an open page takes in place of the whole built page: delta.js on the server (what changed between two builds),
// its route, and mergeDelta in prototype/template.html (the page's side). Run: node --test setup/transcript-reader/delta.test.js

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const vm = require('vm');
const zlib = require('zlib');
const delta = require('./delta');
const { start } = require('./server');

const turn = (n, words = 12) => ({ at: 1000 + n, prompt: `question ${n}`, reply: `answer ${n} `.repeat(words), reply_words: words, source: 'human' });
const session = (id, turns, extra = {}) => ({ home: 'main', id, ids: [id], file: `/logs/${id}.jsonl`, where: '', exchanges: Array.from({ length: turns }, (_, i) => turn(i)), pane: { label: id, live: true }, reopened: false, ...extra });
const event = (n, extra = {}) => ({ at: 2000 + n, kind: 'captain', text: `event ${n}`, ...extra });
const doc = (id, extra = {}) => ({ id, kind: 'html', path: `/tmp/${id}.html`, ...extra });

// A build as build_prototype.build leaves it (generated first), and the page text write_page makes from it.
const build = (generated, parts = {}) => ({ generated, since: 100, homes: ['main'], sessions: [session('a', 5), session('b', 3), session('c', 2)], fleet: [event(0), event(1), event(2)], summaries: [], chosen: true, documents: { d1: doc('d1') }, closed: [], ...parts });
const pageOf = (payload, template = 'tmpl1') => `<!doctype html><head><meta name="template" content="${template}"><meta name="reader-token" content="__READER_TOKEN__"></head><script id="payload" type="application/json">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>`;

// The page's own merge, taken from the template and run on its own, as the page would.
const source = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const mergeSource = source.slice(source.indexOf('function mergeDelta'), source.indexOf('async function refreshData'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const pageMerge = vm.runInNewContext(`(${mergeSource.trim().replace(/^function mergeDelta/, 'function')})`, { Map, Object });
// The page runs in its own realm; its answer is read back through JSON so it compares with this realm's objects.
const mergeDelta = (base, d) => { const merged = pageMerge(base, d); return merged && clone(merged); };

// Make the delta from build `a` to build `b` the way the server does, then merge it into a copy of `a` as the page does.
function update(a, b, { template = 'tmpl1' } = {}) {
  const store = delta.create();
  store.note(pageOf(a));
  const d = store.since(pageOf(b, template), a.generated);
  return { d, merged: d.delta ? mergeDelta(clone(a), clone(d)) : null, wire: JSON.stringify(d) };
}

test('a new reply in one session sends that session\'s new turns, the new fleet event, and nothing else', () => {
  const a = build(10);
  const b = build(11);
  b.sessions[1].exchanges.push(turn(3));
  b.fleet.push(event(3));
  const { d, merged, wire } = update(a, b);
  assert.strictEqual(d.delta, true);
  assert.deepStrictEqual(Object.keys(d.sessions.changed), ['b']);
  assert.strictEqual(d.sessions.changed.b.from, 3);
  assert.strictEqual(d.sessions.changed.b.exchanges.length, 1);
  assert.deepStrictEqual(d.fleet, { count: 4, from: 3, items: [event(3)] });
  assert.strictEqual(d.documents, undefined);
  assert.deepStrictEqual(d.sessions.order, ['a', 'b', 'c']);
  assert.deepStrictEqual(merged, b, 'the page ends up with exactly the build the server holds');
  assert.ok(wire.length < JSON.stringify(b).length / 3, `${wire.length} of ${JSON.stringify(b).length} bytes`);
});

test('a reply being written (the last turn grew) resends that turn, not the turns before it', () => {
  const a = build(10);
  const b = build(11);
  b.sessions[0].exchanges[4] = { ...b.sessions[0].exchanges[4], reply: 'a longer answer', reply_words: 3 };
  const { d, merged } = update(a, b);
  assert.strictEqual(d.sessions.changed.a.from, 4);
  assert.deepStrictEqual(d.sessions.changed.a.exchanges.length, 1);
  assert.deepStrictEqual(merged, b);
});

test('a session that changed only in its pane (live or ended) is sent without its turns being repeated', () => {
  const a = build(10);
  const b = build(11);
  b.sessions[2].pane = { label: 'c', live: false };
  const { d, merged } = update(a, b);
  assert.deepStrictEqual(Object.keys(d.sessions.changed), ['c']);
  assert.strictEqual(d.sessions.changed.c.from, 2);
  assert.deepStrictEqual(d.sessions.changed.c.exchanges, []);
  assert.deepStrictEqual(merged, b);
});

test('a session added between builds arrives whole, and one closed leaves the order; the others are untouched', () => {
  const a = build(10);
  const b = build(11, { sessions: [session('n', 2), session('a', 5), session('c', 2)] });
  const { d, merged } = update(a, b);
  assert.deepStrictEqual(d.sessions.order, ['n', 'a', 'c']);
  assert.deepStrictEqual(Object.keys(d.sessions.changed), ['n']);
  assert.strictEqual(d.sessions.changed.n.from, 0);
  assert.deepStrictEqual(merged, b);
  assert.strictEqual(merged.sessions.find((s) => s.id === 'b'), undefined, 'b is gone');
});

test('a /clear gives the conversation a newer id: it arrives as a new session and the old id leaves', () => {
  const a = build(10);
  const b = build(11, { sessions: [session('a2', 6, { ids: ['a', 'a2'] }), session('b', 3), session('c', 2)] });
  const { d, merged } = update(a, b);
  assert.deepStrictEqual(Object.keys(d.sessions.changed), ['a2']);
  assert.deepStrictEqual(merged, b);
});

test('the order of sessions, documents added and dropped, and the small values follow the build', () => {
  const a = build(10);
  const b = build(11, { sessions: [a.sessions[2], a.sessions[0], a.sessions[1]], documents: { d2: doc('d2') }, closed: [{ id: 'x', label: 'x' }], since: 105 });
  const { d, merged } = update(a, b);
  assert.deepStrictEqual(d.sessions.changed, {}, 'moving a session sends no turns');
  assert.deepStrictEqual(d.sessions.order, ['c', 'a', 'b']);
  assert.deepStrictEqual(d.documents, { set: { d2: doc('d2') }, drop: ['d1'] });
  assert.deepStrictEqual(d.whole, { since: 105, closed: [{ id: 'x', label: 'x' }] });
  assert.deepStrictEqual(merged, b);
});

test('the page\'s own copy of a conversation kept after its pane closed is not taken for one on the build', () => {
  const a = build(10);
  const kept = { ...a.sessions[1], kept: 9, pane: { label: 'b', live: false } };
  const onScreen = { ...clone(a), sessions: [clone(a.sessions[0]), kept, clone(a.sessions[2])] };
  const b = build(11, { sessions: [a.sessions[0], a.sessions[2]] });
  const store = delta.create();
  store.note(pageOf(a));
  const merged = mergeDelta(onScreen, clone(store.since(pageOf(b), a.generated)));
  assert.deepStrictEqual(merged, b, 'the page re-adds the kept copy itself (applyPayload)');
});

test('an unchanged page, a build the server never saw, and a newer base than the build all fall back to the full page', () => {
  const store = delta.create();
  store.note(pageOf(build(10)));
  assert.deepStrictEqual(store.since(pageOf(build(10)), 10), { delta: false, unchanged: true, generated: 10 });
  assert.deepStrictEqual(store.since(pageOf(build(11)), 5), { delta: false }, 'no digest of build 5');
  assert.deepStrictEqual(store.since(pageOf(build(11)), 12), { delta: false });
  assert.deepStrictEqual(store.since('not a page', 10), { delta: false });
  assert.deepStrictEqual(store.since(pageOf(build(11)).replace('"generated":11', '"generated":"x"'), 10), { delta: false });
});

test('a changed template is named, so the page reloads instead of merging into code that no longer matches', () => {
  const { d } = update(build(10), build(11), { template: 'tmpl2' });
  assert.strictEqual(d.template, 'tmpl2');
});

test('the server keeps only the last few builds, and a page older than that gets the full page', () => {
  const store = delta.create();
  for (let g = 10; g < 20; g += 1) store.note(pageOf(build(g)));
  assert.strictEqual(store.known(10), false);
  assert.strictEqual(store.known(19), true);
  assert.deepStrictEqual(store.since(pageOf(build(20)), 10), { delta: false });
  assert.strictEqual(store.since(pageOf(build(20)), 19).delta, true);
});

test('the page refuses a delta that does not fit what it holds, rather than showing a half-merged build', () => {
  const a = build(10);
  const b = build(11);
  b.sessions[1].exchanges.push(turn(3));
  const store = delta.create();
  store.note(pageOf(a));
  const d = clone(store.since(pageOf(b), 10));
  assert.ok(mergeDelta(clone(a), clone(d)));
  const shorter = clone(a);
  shorter.sessions[1].exchanges.pop();
  assert.strictEqual(mergeDelta(shorter, clone(d)), null, 'it holds fewer turns than the delta builds on');
  const unknown = clone(d);
  unknown.sessions.order.push('zz');
  assert.strictEqual(mergeDelta(clone(a), unknown), null, 'a session it has never had, sent as unchanged');
  const miscount = clone(d);
  miscount.sessions.changed.b.count = 9;
  assert.strictEqual(mergeDelta(clone(a), miscount), null);
  const fleet = clone(store.since(pageOf(build(12, { fleet: [event(0), event(1), event(2), event(3)] })), 10));
  fleet.fleet.count = 7;
  assert.strictEqual(mergeDelta(clone(a), fleet), null);
});

// ------------------------------------------------------------------ through the server

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const get = (port, urlPath, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: urlPath, headers: { Host: 'localhost:' + port, ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const sent = Buffer.concat(chunks);
      const body = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(sent) : sent;
      resolve({ status: res.statusCode, headers: res.headers, sent: sent.length, text: body.toString('utf8') });
    });
  }).on('error', reject);
});
const OPEN = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

test('the route answers a page that holds a build the server has seen with only what changed, and refuses the rest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-delta-'));
  const out = path.join(root, 'setup', 'transcript-reader', 'out');
  fs.mkdirSync(out, { recursive: true });
  const writeBuild = (payload) => { fs.writeFileSync(path.join(out, 'prototype.html'), pageOf(payload)); fs.writeFileSync(path.join(out, 'prototype.stamp'), String(payload.generated)); };
  const big = (generated) => build(generated, { sessions: Array.from({ length: 30 }, (_, i) => session('s' + i, 40)) });
  const a = big(10);
  writeBuild(a);
  fs.writeFileSync(path.join(out, 'sessions.txt'), '');
  const port = await freePort();
  const server = await start({ root, port });
  try {
    const page = await get(port, '/setup/transcript-reader/out/prototype.html', OPEN);
    const token = page.text.match(/content="([0-9a-f]{64})"/)[1];
    const headers = { 'x-transcript-reader-token': token, 'Accept-Encoding': 'gzip' };
    const route = (query, extra = headers) => get(port, '/api/transcript-reader/delta?' + query, extra);
    await new Promise((resolve) => setTimeout(resolve, 20));  // the server notes the page it served just after answering

    const same = await route('name=prototype.html&have=10');
    assert.deepStrictEqual(JSON.parse(same.text), { status: 'ok', delta: false, unchanged: true, generated: 10 });

    const b = big(11);
    b.sessions[7].exchanges.push(turn(40));
    writeBuild(b);
    const answer = await route('name=prototype.html&have=10');
    const d = JSON.parse(answer.text);
    assert.strictEqual(d.delta, true);
    assert.deepStrictEqual(Object.keys(d.sessions.changed), ['s7']);
    assert.deepStrictEqual(mergeDelta(clone(a), d), b);
    assert.strictEqual(answer.headers['content-encoding'], 'gzip');
    assert.ok(answer.text.length < fs.statSync(path.join(out, 'prototype.html')).size / 20, 'a few kilobytes against the whole page');

    assert.strictEqual(JSON.parse((await route('name=prototype.html&have=3')).text).delta, false, 'a build the server never saw');
    assert.strictEqual((await route('name=questionnaire.html&have=10')).status, 404, 'only the reader page has one');
    assert.strictEqual((await route('name=prototype.html&have=abc')).status, 400);
    assert.strictEqual((await route('name=prototype.html&have=10', {})).status, 403, 'the token is needed, as for the page');
    assert.strictEqual((await route('name=prototype.html&have=10', { 'x-transcript-reader-token': token, Host: 'evil.example:' + port })).status, 403);
  } finally { server.close(); }
});

// ---- the page keeps the turns it drew when a build leaves them as they were (turnsUnchanged, template.html) ----

const keepFrom = source.indexOf('let turnsDrawn = null;');
const keepSource = source.slice(keepFrom, source.indexOf('\n  }\n', source.indexOf('function turnsUnchanged(')) + 5);
// The page's own lines, on a page whose `data` is the build under test. `draw` stands for renderReader leaving what it drew behind.
function keeper(data) {
  // refs stands for refsSignature(): the tab labels and ids a reply may link to (sessionrefs.js), as text.
  const context = { data, JSON, Array, Set, WeakMap, Boolean, refs: 'a', refsSignature: () => context.refs };
  vm.createContext(context);
  vm.runInContext(keepSource + `
    this.draw = (session) => { turnsDrawn = { sid: session.id, exchanges: session.exchanges, context: turnsContext(session.exchanges, data.documents, data.steps_from) }; };
    this.unchanged = (session) => turnsUnchanged(session);
    this.forget = () => { turnsDrawn = null; };`, context);
  return context;
}

test('a build that changes another conversation leaves the turns on screen as they were, whether it came as a delta or as the full page', () => {
  const a = build(10);
  const b = build(11);
  b.sessions[1].exchanges.push(turn(3));  // another conversation got a reply; the one on screen is 'a'
  const page = keeper(clone(a));
  const onScreen = page.data.sessions[0];
  page.draw(onScreen);
  const { d } = update(a, b);
  page.data = pageMerge(page.data, clone(d));  // not mergeDelta above: that one copies its answer, and these are about the objects
  assert.strictEqual(page.data.sessions[0].exchanges, onScreen.exchanges, 'a delta keeps the turns it did not change, the same objects');
  assert.strictEqual(page.unchanged(page.data.sessions[0]), true, 'a delta');
  page.data = clone(b);  // the full page: new objects with the same content
  assert.notStrictEqual(page.data.sessions[0].exchanges[0], onScreen.exchanges[0]);
  assert.strictEqual(page.unchanged(page.data.sessions[0]), true, 'the full page, by content');
});

test('the turns are drawn again when one of them, their number, the documents they name or the conversation changed, and the first time', () => {
  const withDocs = (generated) => { const x = build(generated); x.sessions[0].exchanges[1].documents = ['d1']; return x; };
  const a = withDocs(10);
  const page = keeper(clone(a));
  assert.strictEqual(page.unchanged(page.data.sessions[0]), false, 'nothing was drawn yet');
  page.draw(page.data.sessions[0]);
  const next = (change) => { const x = clone(a); x.generated = 11; change(x); page.data = x; return page.unchanged(x.sessions[0]); };
  assert.strictEqual(next(() => {}), true, 'nothing changed');
  assert.strictEqual(next((x) => x.sessions[0].exchanges.push(turn(5))), false, 'a new turn');
  assert.strictEqual(next((x) => x.sessions[0].exchanges.pop()), false, 'a turn fewer');
  assert.strictEqual(next((x) => { x.sessions[0].exchanges[4].reply += ' and more'; }), false, 'the last reply grew');
  assert.strictEqual(next((x) => { x.sessions[0].exchanges[0].verdict = 'needs-you'; }), false, 'an earlier turn changed in place');
  assert.strictEqual(next((x) => { x.documents.d1 = doc('d1', { name: 'moved.html', dir: '/elsewhere' }); }), false, 'a document a chip names moved');
  assert.strictEqual(next((x) => { x.documents.d9 = doc('d9'); }), true, 'a document no turn names does not matter');
  assert.strictEqual(next((x) => { x.steps_from = 7; }), false, 'where kept tool output starts');
  assert.strictEqual(next((x) => { x.sessions[0].id = 'a2'; }), false, 'a /clear gave the conversation a new session');
  page.refs = 'b';
  assert.strictEqual(next(() => {}), false, 'a tab got a name a reply may now link to');
  page.refs = 'a';
  page.forget();
  assert.strictEqual(page.unchanged(a.sessions[0]), false, 'what was on screen is gone (another view, a notice)');
});
