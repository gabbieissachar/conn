'use strict';

// Tests for the page's link to the reader's server (prototype/live.js), as the phone meets it on the
// Mac's Tailscale address. Run from the repo root: node --test setup/transcript-reader/live.test.js
// The file runs in a sandbox with a fake location, document and fetch, as the page's script would.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'prototype', 'live.js'), 'utf8');
const TOKEN = 'ab'.repeat(32);

// token: what the server wrote into the page's reader-token tag ('' for a copy with none).
function load({ protocol = 'http:', hostname = 'localhost', token = TOKEN, answer = null, activeTag = 'BODY', script = null, hidden = false } = {}) {
  const fetched = [];
  const listeners = {};
  const delays = [];
  const doc = { hidden };
  const reloads = [];
  const store = new Map();
  const sandbox = {
    location: { protocol, hostname, reload: () => reloads.push(1) },
    document: Object.assign(doc, {
      querySelector: (selector) => (selector === 'meta[name="reader-token"]' ? { content: token } : null),
      activeElement: { tagName: activeTag },
      addEventListener: (type, handler) => { (listeners[type] = listeners[type] || []).push(handler); },
    }),
    sessionStorage: { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => { store.set(key, String(value)); } },
    fetch: async (url, options) => {
      fetched.push({ url, options });
      // A script gives each call its answer in turn: a { status, body }, or a function that returns one (a wait that the signal ends).
      const next = script ? script.shift() : answer;
      const given = typeof next === 'function' ? await next(options) : next;
      const { status = 200, body = { status: 'ok' } } = given || {};
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
    AbortController, URLSearchParams, setTimeout: (fn, ms) => { delays.push(ms); fn(); return 0 },
    Date, JSON, Math, Number, Error, Promise, Intl, RegExp, String, Array, Object, setInterval: () => 0,
  };
  vm.createContext(sandbox);
  const live = vm.runInContext(SOURCE + '\nlive;', sandbox);
  const fire = async (type) => { for (const handler of listeners[type] || []) await handler(); };
  return { live, fetched, reloads, doc, fire, delays };
}

test('a page on localhost, 127.0.0.1 or [::1] is served, as before', () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) assert.equal(load({ hostname }).live.served, true, hostname);
  assert.equal(load({ hostname: 'localhost', token: '' }).live.served, true, 'loopback needs nothing but the address');
});

test('a page on a Tailscale address that carries the server token is served: Send, Sync, Follow and pins work on the phone', () => {
  for (const hostname of ['100.64.0.1', '100.97.27.50', '100.100.100.100', '100.127.255.254']) assert.equal(load({ hostname }).live.served, true, hostname);
});

test('a Tailscale address alone is not enough: a page without the server token stays read-only', () => {
  assert.equal(load({ hostname: '100.97.27.50', token: '' }).live.served, false, 'no token, as in a file copy');
  assert.equal(load({ hostname: '100.97.27.50', token: '__READER_TOKEN__' }).live.served, false, 'the unfilled placeholder');
  assert.equal(load({ hostname: '100.97.27.50', token: 'ab'.repeat(31) }).live.served, false, 'a token of the wrong length');
});

test('the machine\'s Tailscale name is served over https with the server token, and over nothing else', () => {
  const name = 'some-machine.some-tailnet.ts.net';
  assert.equal(load({ protocol: 'https:', hostname: name }).live.served, true);
  assert.equal(load({ protocol: 'https:', hostname: name, token: '' }).live.served, false, 'no token');
  assert.equal(load({ protocol: 'http:', hostname: name }).live.served, false, 'the name is the TLS listener\'s, not the plain one\'s');
  for (const other of ['some-machine.ts.net.example.com', 'ts.net', 'evilts.net', 'some-machine.tsxnet']) assert.equal(load({ protocol: 'https:', hostname: other }).live.served, false, other);
});

test('any other address stays read-only, token or not', () => {
  for (const hostname of ['100.63.255.255', '100.128.0.1', '10.0.0.5', '192.168.1.20', '172.16.0.9', '100.97.27', '100.97.27.50.1', 'example.com', 'localhost.example.com', 'foo.100.97.27.50', '']) {
    assert.equal(load({ hostname }).live.served, false, hostname);
  }
  assert.equal(load({ protocol: 'https:', hostname: '100.97.27.50' }).live.served, false, 'https is not the reader\'s own server');
  assert.equal(load({ protocol: 'file:', hostname: '' }).live.served, false, 'a file copy');
});

test('on the tailnet address Send carries the token header and reaches the server', async () => {
  const { live, fetched } = load({ hostname: '100.97.27.50' });
  await live.send('aaaaaaaa-1111-4111-8111-111111111111', 'hello from the phone');
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, '/api/transcript-reader/send');
  assert.equal(fetched[0].options.method, 'POST');
  assert.equal(fetched[0].options.headers['x-transcript-reader-token'], TOKEN);
  assert.deepEqual(JSON.parse(fetched[0].options.body), { session_id: 'aaaaaaaa-1111-4111-8111-111111111111', text: 'hello from the phone' });
});

test('a read-only page refuses to call the server at all', async () => {
  const { live, fetched } = load({ hostname: '192.168.1.20' });
  await assert.rejects(() => live.send('aaaaaaaa-1111-4111-8111-111111111111', 'x'), /Open the served page/);
  assert.equal(fetched.length, 0);
});

test('a phone the server signed out (a restart, a new passcode) reloads once to the sign-in page, and says so when it cannot', async () => {
  const signedOut = { status: 401, body: { status: 'error', code: 'sign_in_required', message: 'Sign in first.' } };
  const first = load({ hostname: '100.97.27.50', answer: signedOut });
  await assert.rejects(() => first.live.state(false), /Signed out: opening the sign-in page/);
  assert.equal(first.reloads.length, 1, 'one reload brings the passcode page');
  // Not twice within a minute, so a page that cannot sign in does not reload in a loop.
  await assert.rejects(() => first.live.state(false), /Signed out: reload the page to sign in again/);
  assert.equal(first.reloads.length, 1);
  // Never while a message is being written; the box keeps it.
  const typing = load({ hostname: '100.97.27.50', answer: signedOut, activeTag: 'TEXTAREA' });
  await assert.rejects(() => typing.live.send('aaaaaaaa-1111-4111-8111-111111111111', 'x'), /Signed out: reload the page to sign in again/);
  assert.equal(typing.reloads.length, 0);
});

test('other refusals keep their own words', async () => {
  const { live } = load({ hostname: '100.97.27.50', answer: { status: 409, body: { status: 'error', message: 'No live Herdr pane runs this session.' } } });
  await assert.rejects(() => live.send('aaaaaaaa-1111-4111-8111-111111111111', 'x'), /No live Herdr pane runs this session\./);
});

test('on a touch screen the box, Send and Add, the links under it and the Pin and Reply pills are finger-sized', () => {
  const template = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const block = (template.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n  \}/) || [])[1] || '';
  assert.match(block, /\.dock-row button \{[^}]*min-height: 44px/);
  assert.match(block, /\.dock textarea \{[^}]*min-height: 44px/);
  assert.match(block, /\.dock-acts button/);
  assert.match(block, /\.pin, \.reply-to/);
});


// ---------------------------------------------------------------- waiting for a build

const settle = () => new Promise((resolve) => setImmediate(resolve));
// A wait the server holds until a build is published: it ends with the answer given, or with an abort.
const held = () => { let release; const wait = (options) => new Promise((resolve, reject) => {
  release = (body) => resolve({ body });
  options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
}); wait.release = (body) => release(body); return wait; };

test('a page waits on the server for a newer build, takes it when the server says so, and waits again', async () => {
  const first = held();
  const { live, fetched } = load({ script: [first, held()] });
  let mine = 100;
  const taken = [];
  live.waitForBuilds(() => ({ reader: mine }), async (stamps) => { taken.push(stamps); mine = stamps.reader; });
  await settle();
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, '/api/transcript-reader/events?reader=100&wait=25000');
  assert.equal(fetched[0].options.headers['x-transcript-reader-token'], TOKEN, 'the same token and guard as every call');
  first.release({ status: 'ok', stamps: { reader: 130, sheet: 5 } });
  await settle(); await settle();
  assert.deepEqual(taken, [{ reader: 130, sheet: 5 }]);
  assert.equal(fetched.length, 2);
  assert.equal(fetched[1].url, '/api/transcript-reader/events?reader=130&wait=25000', 'now asking about the build it took');
});

test('an answer with nothing newer (the wait ran out) takes nothing and asks again', async () => {
  const { live, fetched } = load({ script: [{ body: { status: 'ok', stamps: { reader: 100, sheet: 5 } } }, held()] });
  const taken = [];
  live.waitForBuilds(() => ({ reader: 100 }), async (stamps) => taken.push(stamps));
  await settle(); await settle();
  assert.deepEqual(taken, []);
  assert.equal(fetched.length, 2);
});

test('the answer sheet waits on its own stamp, and a page waits only on the stamps it has', async () => {
  const { live, fetched } = load({ script: [held()] });
  live.waitForBuilds(() => ({ sheet: 7 }), async () => {});
  await settle();
  assert.equal(fetched[0].url, '/api/transcript-reader/events?sheet=7&wait=25000');
});

test('a build the page did not take is not asked about again at once', async () => {
  const { live, fetched, delays } = load({ script: [{ body: { status: 'ok', stamps: { reader: 130 } } }, held()] });
  live.waitForBuilds(() => ({ reader: 100 }), async () => {});  // a passage is being picked: nothing taken
  await settle(); await settle();
  assert.deepEqual(delays, [1000], 'a pause before the next wait, so the server is not asked in a loop');
  assert.equal(fetched.length, 2);
});

test('a hidden page does not wait, ends the wait it has when hidden, and waits again when shown', async () => {
  const hiddenPage = load({ hidden: true, script: [held()] });
  hiddenPage.live.waitForBuilds(() => ({ reader: 1 }), async () => {});
  await settle();
  assert.equal(hiddenPage.fetched.length, 0);
  hiddenPage.doc.hidden = false;
  await hiddenPage.fire('visibilitychange');
  await settle();
  assert.equal(hiddenPage.fetched.length, 1, 'shown: the wait starts');
  const aborted = [];
  hiddenPage.fetched[0].options.signal.addEventListener('abort', () => aborted.push(1));
  hiddenPage.doc.hidden = true;
  await hiddenPage.fire('visibilitychange');
  await settle();
  assert.deepEqual(aborted, [1], 'hidden: the wait ends');
  assert.equal(hiddenPage.fetched.length, 1, 'and none starts');
});

test('a server without the route leaves the page to its tick, and a file copy or a page the server does not serve asks for nothing', async () => {
  const old = load({ script: [{ status: 404, body: { status: 'error', code: 'not_found' } }] });
  old.live.waitForBuilds(() => ({ reader: 1 }), async () => { throw new Error('nothing to take'); });
  await settle(); await settle();
  assert.equal(old.fetched.length, 1);
  await old.fire('visibilitychange');
  await settle();
  assert.equal(old.fetched.length, 1, 'not asked again when shown');
  for (const options of [{ hostname: '192.168.1.20' }, { protocol: 'file:', hostname: '' }]) {
    const page = load(options);
    page.live.waitForBuilds(() => ({ reader: 1 }), async () => {});
    await settle();
    assert.equal(page.fetched.length, 0, JSON.stringify(options));
  }
});

test('a failed wait is tried again after a pause that grows, and a wait the page itself ended is not a failure', async () => {
  const down = { status: 500, body: { status: 'error', message: 'down' } };
  const { live, fetched, delays } = load({ script: [down, down, down, held()] });
  live.waitForBuilds(() => ({ reader: 1 }), async () => {});
  await settle(); await settle(); await settle(); await settle();
  assert.deepEqual(delays, [2000, 4000, 8000]);
  assert.equal(fetched.length, 4);
});

test('a phone the server signed out reloads once to the sign-in page from its wait, as from any call', async () => {
  const signedOut = { status: 401, body: { status: 'error', code: 'sign_in_required', message: 'Sign in first.' } };
  const { live, reloads } = load({ hostname: '100.97.27.50', script: [signedOut, held()] });
  live.waitForBuilds(() => ({ reader: 1 }), async () => {});
  await settle(); await settle();
  assert.equal(reloads.length, 1);
});

test('the state call names Follow and the page\'s first call (boot), and nothing else, in its query', async () => {
  const { live, fetched } = load();
  await live.state(false);
  await live.state(true);
  await live.state(false, true);
  await live.state(true, true);
  assert.deepEqual(fetched.map((f) => f.url), ['/api/transcript-reader/state', '/api/transcript-reader/state?follow=1', '/api/transcript-reader/state?boot=1', '/api/transcript-reader/state?follow=1&boot=1']);
});

test('the reader page asks with boot on its first poll only, and keeps asking that way until one answer has come', () => {
  const PAGE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const poll = PAGE.slice(PAGE.indexOf('let bootState = true;'), PAGE.indexOf('// A new build is taken the moment the server publishes it'));
  assert.ok(poll.includes('live.state(state.follow, bootState)'));
  assert.ok(poll.indexOf('bootState = false;') > poll.indexOf('live.state(state.follow, bootState)'), 'after the call');
  assert.ok(poll.indexOf('catch (e) { noteSyncFail(e); throw e; }') < poll.indexOf('bootState = false;'), 'and not when the call failed');
});

test('a turn\'s task change is one POST of the board\'s mark route with the token, and a refusal keeps its own sentence', async () => {
  const { live, fetched } = load({ answer: { body: { status: 'ok', mark: { mark: 'in' } } } });
  const body = { session: 'leader-lab', task: 'bc-39-specs-task', turn: '5e550000:abcdef12:reply', mark: 'in', source: 'reader' };
  await live.boardMark(body);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, '/api/transcript-reader/board-mark');
  assert.equal(fetched[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(fetched[0].options.body), body);
  assert.equal(fetched[0].options.headers['x-transcript-reader-token'], TOKEN);
  const refused = load({ answer: { status: 409, body: { status: 'error', code: 'refused', message: 'Firstmate did not file the mark: nothing' } } });
  await assert.rejects(refused.live.boardMark(body), /Firstmate did not file the mark: nothing/);
  await assert.rejects(load({ hostname: 'example.test' }).live.boardMark(body), /Open the served page/, 'a page no server serves writes nothing');
});
