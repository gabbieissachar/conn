'use strict';

// Tests for the page's pin and star stores (prototype/pins.js). Run from the repo root:
//   node --test setup/transcript-reader/pins.test.js
// The file runs in a sandbox with a fake server, storage and window, as the page's script would run it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'prototype', 'pins.js'), 'utf8');
const K1 = 'abcdef12-3456-4789-8abc-def012345678:in';
const K2 = 'abcdef12-3456-4789-8abc-def012345678:reply';
const CONV = 'cccccccc-3333-4333-8333-333333333333';

// server: null for a page that cannot reach one, else { pins, rev, fail } the fake server keeps.
function load({ hosted = false, served = true, server = null, starServer = null, storage = new Map(), storageBroken = false } = {}) {
  const calls = [];
  const listeners = {};
  const live = {
    pinsList: async () => {
      calls.push(['list']);
      if (!server || server.down) { const e = new Error('The server answered 404.'); e.status = 404; throw e; }
      return { status: 'ok', rev: server.rev, pins: server.pins.map((p) => ({ ...p })) };
    },
    pinsChange: async (change) => {
      calls.push(['change', JSON.parse(JSON.stringify(change))]);
      if (server.fail) throw new Error(server.fail);
      if (change.op === 'pin' && !server.pins.some((p) => p.key === change.key)) server.pins.push({ key: change.key, conv: change.conv, at: change.at, pinned: 99 });
      if (change.op === 'unpin') server.pins = server.pins.filter((p) => p.key !== change.key);
      server.rev += 1;
      return { status: 'ok', rev: server.rev, pins: server.pins.map((p) => ({ ...p })) };
    },
    starsList: async () => {
      calls.push(['stars']);
      if (!starServer || starServer.down) { const e = new Error('The server answered 404.'); e.status = 404; throw e; }
      return { status: 'ok', rev: starServer.rev, stars: starServer.stars.map((p) => ({ ...p })) };
    },
    starsChange: async (change) => {
      calls.push(['stars-change', JSON.parse(JSON.stringify(change))]);
      if (starServer.fail) throw new Error(starServer.fail);
      if (change.op === 'star' && !starServer.stars.some((p) => p.conv === change.conv)) starServer.stars.push({ conv: change.conv, starred: 99 });
      if (change.op === 'unstar') starServer.stars = starServer.stars.filter((p) => p.conv !== change.conv);
      starServer.rev += 1;
      return { status: 'ok', rev: starServer.rev, stars: starServer.stars.map((p) => ({ ...p })) };
    },
  };
  const sandbox = {
    HOSTED: hosted, canLive: served && !hosted && Boolean(server || starServer), live, Date, JSON, Math, Number, Array, Promise, Error, Set,
    window: { addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); } },
    localStorage: {
      getItem: (key) => { if (storageBroken) throw new Error('blocked'); return storage.has(key) ? storage.get(key) : null; },
      setItem: (key, value) => { if (storageBroken) throw new Error('blocked'); storage.set(key, String(value)); },
    },
  };
  vm.createContext(sandbox);
  const { pins, stars } = vm.runInContext(SOURCE + '\n({ pins, stars });', sandbox);
  return { pins, stars, calls, storage, listeners };
}

const serverWith = (pins = [], rev = 0) => ({ pins, rev, fail: '', down: false });
const pin = (key, extra = {}) => ({ key, conv: CONV, at: 5, pinned: 9, ...extra });

test('a page with no server keeps pins in this browser, and a new load of the page finds them', async () => {
  const storage = new Map();
  const first = load({ served: false, storage });
  await first.pins.load();
  assert.equal(first.pins.where(), 'browser');
  await first.pins.toggle(K1, CONV, 5);
  assert.equal(first.pins.has(K1), true);
  const again = load({ served: false, storage });
  await again.pins.load();
  assert.deepEqual(again.pins.all().map((p) => [p.key, p.conv, p.at]), [[K1, CONV, 5]]);
  await again.pins.toggle(K1, CONV, 5);
  assert.deepEqual(JSON.parse(storage.get('tr-pins')), []);
});

test('the hosted copy keeps its own pins, apart from the local page\'s, and never calls a server', async () => {
  const storage = new Map([['tr-pins', JSON.stringify([pin(K2)])]]);
  const t = load({ hosted: true, server: serverWith(), storage });
  await t.pins.load();
  assert.deepEqual(t.pins.all(), [], 'the local page\'s pins are not the hosted copy\'s');
  await t.pins.toggle(K1, CONV, 5);
  assert.deepEqual(JSON.parse(storage.get('tr-hosted-pins')).map((p) => p.key), [K1]);
  assert.deepEqual(t.calls, [], 'no request at all');
});

test('a pin holds where the message is and when, never any text', async () => {
  const t = load({ served: false });
  await t.pins.load();
  await t.pins.toggle(K1, CONV, 5);
  assert.deepEqual(Object.keys(t.pins.all()[0]).sort(), ['at', 'conv', 'key', 'pinned']);
});

test('a browser that will not keep the pin says so and leaves the list as it was', async () => {
  const t = load({ served: false, storageBroken: true });
  await t.pins.load();
  let changes = 0;
  t.pins.onChange(() => { changes += 1; });
  await assert.rejects(() => t.pins.toggle(K1, CONV, 5), /would not keep/);
  assert.equal(t.pins.has(K1), false);
  assert.equal(changes, 2, 'it showed the pin at once and took it back');
});

test('with the local server, the pins come from its file and each change is sent as one pin or unpin', async () => {
  const server = serverWith([pin(K2)], 4);
  const t = load({ server });
  await t.pins.load();
  assert.equal(t.pins.where(), 'file');
  assert.deepEqual(t.pins.all().map((p) => p.key), [K2]);
  await t.pins.toggle(K1, CONV, 7);
  assert.deepEqual(t.calls.at(-1), ['change', { op: 'pin', key: K1, conv: CONV, at: 7 }]);
  assert.equal(t.pins.count(), 2);
  await t.pins.toggle(K2, CONV, 5);
  assert.deepEqual(t.calls.at(-1), ['change', { op: 'unpin', key: K2 }]);
  assert.deepEqual(t.pins.all().map((p) => p.key), [K1]);
  assert.deepEqual(server.pins.map((p) => p.key), [K1]);
});

test('a refused save puts the pin back as it was, and says why', async () => {
  const server = serverWith([pin(K2)], 1);
  const t = load({ server });
  await t.pins.load();
  server.fail = 'Too many pins: unpin some first.';
  await assert.rejects(() => t.pins.toggle(K1, CONV, 5), /Too many pins/);
  assert.deepEqual(t.pins.all().map((p) => p.key), [K2]);
  await assert.rejects(() => t.pins.toggle(K2, CONV, 5), /Too many pins/);
  assert.equal(t.pins.has(K2), true, 'an unpin that failed leaves the pin');
});

test('the poll\'s revision brings another tab\'s change in, and the same revision asks for nothing', async () => {
  const server = serverWith([], 1);
  const t = load({ server });
  await t.pins.load();
  let changes = 0;
  t.pins.onChange(() => { changes += 1; });
  const listed = () => t.calls.filter((c) => c[0] === 'list').length;
  const before = listed();
  await t.pins.refresh(1);
  await t.pins.refresh(undefined);
  assert.equal(listed(), before);
  server.pins.push(pin(K1));
  server.rev = 2;
  await t.pins.refresh(2);
  assert.deepEqual(t.pins.all().map((p) => p.key), [K1]);
  assert.equal(changes, 1);
});

test('a server too old to have the route leaves the page on browser pins, which move into the file once it can', async () => {
  const storage = new Map();
  const old = load({ server: { ...serverWith(), down: true }, storage });
  await old.pins.load();
  assert.equal(old.pins.where(), 'browser');
  await old.pins.toggle(K1, CONV, 5);
  assert.deepEqual(JSON.parse(storage.get('tr-pins')).map((p) => p.key), [K1]);
  // The server is restarted: the page loads again and finds the route.
  const server = serverWith([pin(K2)], 3);
  const now = load({ server, storage });
  await now.pins.load();
  assert.equal(now.pins.where(), 'file');
  assert.deepEqual(now.pins.all().map((p) => p.key).sort(), [K1, K2].sort());
  assert.deepEqual(server.pins.map((p) => p.key).sort(), [K1, K2].sort());
  assert.deepEqual(JSON.parse(storage.get('tr-pins')), [], 'the browser no longer holds them');
});

test('another tab\'s change to this browser\'s pins shows up', async () => {
  const storage = new Map();
  const t = load({ served: false, storage });
  await t.pins.load();
  let changes = 0;
  t.pins.onChange(() => { changes += 1; });
  storage.set('tr-pins', JSON.stringify([pin(K1)]));
  t.listeners.storage.forEach((fn) => fn({ key: 'tr-pins' }));
  assert.deepEqual(t.pins.all().map((p) => p.key), [K1]);
  assert.equal(changes, 1);
  t.listeners.storage.forEach((fn) => fn({ key: 'something-else' }));
  assert.equal(changes, 1);
});

// ---- stars: the same store, one list of conversations

const starServerWith = (stars = [], rev = 0) => ({ stars, rev, fail: '', down: false });
const star = (conv, extra = {}) => ({ conv, starred: 9, ...extra });
const OTHER = 'dddddddd-4444-4444-8444-444444444444';

test('stars: kept in the server\'s file when it answers, and starring a second session keeps the first', async () => {
  const starServer = starServerWith();
  const t = load({ starServer });
  await t.stars.load();
  assert.equal(t.stars.where(), 'file');
  await t.stars.toggle(CONV);
  await t.stars.toggle(OTHER);
  assert.deepEqual(t.stars.all().map((s) => s.conv), [CONV, OTHER]);
  assert.deepEqual(starServer.stars.map((s) => s.conv), [CONV, OTHER]);
  assert.deepEqual(t.calls.filter((c) => c[0] === 'stars-change').map((c) => c[1]), [{ op: 'star', conv: CONV }, { op: 'star', conv: OTHER }]);
  await t.stars.toggle(CONV);
  assert.deepEqual(t.calls.at(-1), ['stars-change', { op: 'unstar', conv: CONV }]);
  assert.deepEqual(t.stars.all().map((s) => s.conv), [OTHER]);
  assert.equal(t.stars.has(CONV), false);
  assert.equal(t.stars.has(OTHER), true);
  assert.equal(t.pins.count(), 0, 'a star is not a pin');
});

test('stars: with no server they live in this browser under their own key, and a new load finds them', async () => {
  const storage = new Map();
  const first = load({ served: false, storage });
  await first.stars.load();
  assert.equal(first.stars.where(), 'browser');
  await first.stars.toggle(CONV);
  assert.deepEqual(Object.keys(Object.fromEntries(storage)), ['tr-stars']);
  const again = load({ served: false, storage });
  await again.stars.load();
  assert.deepEqual(again.stars.all().map((s) => s.conv), [CONV]);
  const hosted = load({ hosted: true, storage });
  await hosted.stars.load();
  assert.deepEqual(hosted.stars.all(), [], 'the hosted copy has its own key');
  await hosted.stars.toggle(OTHER);
  assert.ok(storage.has('tr-hosted-stars'));
});

test('stars: a server too old to have the route leaves them in the browser, and a later load moves them into the file', async () => {
  const storage = new Map([['tr-stars', JSON.stringify([star(CONV)])]]);
  const old = load({ server: serverWith(), storage });  // the pins route answers; the stars route does not
  await old.stars.load();
  assert.equal(old.stars.where(), 'browser');
  assert.deepEqual(old.stars.all().map((s) => s.conv), [CONV]);
  const starServer = starServerWith([star(OTHER)]);
  const now = load({ starServer, storage });
  await now.stars.load();
  assert.equal(now.stars.where(), 'file');
  assert.deepEqual(now.stars.all().map((s) => s.conv).sort(), [CONV, OTHER].sort());
  assert.deepEqual(JSON.parse(storage.get('tr-stars')), []);
  assert.deepEqual(now.calls.filter((c) => c[0] === 'stars-change').map((c) => c[1]), [{ op: 'star', conv: CONV }], 'only the time the server stamps stays out of the add');
});

test('stars: a refused save puts the list back and says why; the cap says to unstar', async () => {
  const starServer = starServerWith();
  const t = load({ starServer });
  await t.stars.load();
  starServer.fail = 'The server refused.';
  await assert.rejects(() => t.stars.toggle(CONV), /refused/);
  assert.deepEqual(t.stars.all(), []);
  const full = load({ starServer: starServerWith(Array.from({ length: 200 }, (_, i) => star('conv-' + i))) });
  await full.stars.load();
  await assert.rejects(() => full.stars.toggle(CONV), /200 stars already: unstar some first/);
  await full.stars.toggle('conv-0');
  assert.equal(full.stars.count(), 199, 'unstarring needs no room');
});

test('stars: another tab\'s change arrives through the revision the poll carries, and a listener hears of it', async () => {
  const starServer = starServerWith([], 4);
  const t = load({ starServer });
  await t.stars.load();
  let heard = 0;
  t.stars.onChange(() => { heard += 1; });
  starServer.stars.push(star(CONV)); starServer.rev = 5;
  await t.stars.refresh(4);  // the poll's stamp is the revision it already has: nothing to read
  assert.equal(heard, 0);
  await t.stars.refresh(5);
  assert.deepEqual(t.stars.all().map((s) => s.conv), [CONV]);
  assert.equal(heard, 1);
  await t.stars.refresh(undefined);  // a server that does not report stars
  assert.equal(heard, 1);
});
