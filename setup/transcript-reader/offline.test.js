'use strict';

// Tests for the sealed copy kept on a phone (prototype/hosted.js and prototype/sw.js): what is fetched and stored by stamp, reading
// from the device with the laptop away, "Download everything now", "Forget this device", sends held while the laptop is away, and the
// HTML viewer's worker. Run from the repo root: node --test setup/transcript-reader/offline.test.js
// The page code runs in a Node sandbox over phonefake.js (a small IndexedDB, Cache storage, a service worker and a laptop that can be
// shut); the objects are really sealed with the page's own seal.js. The passphrase is a made-up one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const phone = require('./phonefake');

const SW_SOURCE = fs.readFileSync(path.join(__dirname, 'prototype', 'sw.js'), 'utf8');
const PASS = phone.PASSPHRASE;
const SESSION = '11111111-1111-4111-8111-111111111111';
// Values made inside the page's sandbox have its own Array and Object, which deepStrictEqual tells apart from ours.
const plain = (value) => JSON.parse(JSON.stringify(value));

// A page load that has the copy open: the passphrase typed once and the key remembered, as a first visit does.
async function opened(laptop, device, options = {}) {
  const p = phone.page({ laptop, device, ...options });
  const state = await p.hosted.prepare();
  if (state === 'locked') assert.equal(await p.hosted.unlock(PASS, true), true);
  return p;
}
const objectRequests = (laptop) => laptop.fetchesOf(/\.enc$/).filter((url) => url !== 'index.json.enc');
const storedPaths = (device) => [...(device.indexedDB.dump('hosted-reader').get('objects') || new Map()).keys()].sort();

test('Download everything now fetches each object once, and the next one fetches only what changed, by stamp', async () => {
  const laptop = await phone.laptop({ conversations: 3, documents: 1, weeks: 1 });
  const device = phone.device();
  const first = await opened(laptop, device);
  const index = await first.hosted.index();
  const seen = [];
  const result = await first.hosted.download(index, (progress) => seen.push(progress));
  assert.equal(result.fetched, 5, '3 conversations, 1 document, 1 week');
  assert.equal(result.kept, 0);
  assert.deepEqual(plain(result.failed), []);
  assert.deepEqual(objectRequests(laptop).sort(), [...laptop.plain.keys()].map((rel) => rel + '.enc').sort());
  assert.equal(seen[0].total, 5);
  assert.deepEqual(plain(seen[seen.length - 1]), { done: 5, total: 5, bytes: result.bytes });
  assert.ok(result.bytes > 0);
  assert.deepEqual(storedPaths(device), [...laptop.plain.keys()].sort());
  const stored = await first.hosted.stored(index);
  assert.deepEqual([stored.total, stored.have, stored.all], [5, 5, true]);
  assert.ok(stored.bytes >= result.bytes);

  // A second download with nothing changed asks for nothing but the index it was given.
  laptop.requests.length = 0;
  const again = await first.hosted.download(index);
  assert.equal(again.fetched, 0);
  assert.equal(again.kept, 5);
  assert.deepEqual(objectRequests(laptop), []);

  // One conversation changes on the laptop (new bytes, new stamp in the next index): that one object alone comes down.
  const changed = laptop.index.conversations[1];
  await laptop.set(changed.object, { id: changed.id, exchanges: [{ at: 5000, source: 'captain', input: 'Changed', reply: 'Yes' }] }, 'newer-stamp');
  changed.stamp = 'newer-stamp';
  await laptop.publish({ as_of: Date.now() / 1000 });
  laptop.requests.length = 0;
  const next = await first.hosted.index();
  const third = await first.hosted.download(next);
  assert.deepEqual(objectRequests(laptop), [changed.object + '.enc']);
  assert.equal(third.fetched, 1);
  assert.equal(third.kept, 4);
  // And reading it afterwards fetches nothing: the device has that stamp.
  laptop.requests.length = 0;
  const data = first.hosted.data(next, null);
  const session = data.sessions.find((s) => s.id === changed.id);
  await first.hosted.conversation(session);
  assert.equal(session.exchanges[0].input, 'Changed');
  assert.deepEqual(laptop.requests, []);
});

test('an object read before any download is kept, and is fetched once per stamp across page loads', async () => {
  const laptop = await phone.laptop({ conversations: 2, documents: 0, weeks: 0 });
  const device = phone.device();
  const one = await opened(laptop, device);
  const data = one.hosted.data(await one.hosted.index(), null);
  await one.hosted.conversation(data.sessions[0]);
  assert.equal(objectRequests(laptop).length, 1);
  const two = await opened(laptop, device);  // the page is opened again: nothing asked for what it holds
  laptop.requests.length = 0;
  const again = two.hosted.data(await two.hosted.index(), null);
  await two.hosted.conversation(again.sessions[0]);
  assert.deepEqual(objectRequests(laptop), []);
  assert.equal(again.sessions[0].exchanges[0].reply, 'Reply 0');
});

test('with the laptop away the page opens from the device: key, index, conversation, document and week, and says how old it is', async () => {
  const laptop = await phone.laptop({ conversations: 2, documents: 1, weeks: 1 });
  const device = phone.device();
  const first = await opened(laptop, device);
  const index = await first.hosted.index();
  await first.hosted.download(index);
  assert.equal(first.hosted.offline().fromDevice, false);

  laptop.down = true;  // the laptop is shut: no request is answered
  laptop.requests.length = 0;
  const later = phone.page({ laptop, device });
  assert.equal(await later.hosted.prepare(), 'open', 'the stored params and the remembered key open the copy with no passphrase typed');
  const offlineIndex = await later.hosted.index();
  const state = later.hosted.offline();
  assert.equal(state.fromDevice, true);
  assert.match(state.why, /not reachable/);
  assert.equal(offlineIndex.as_of, index.as_of, 'the index is the one the device took');
  assert.ok(state.at > 0, 'and says when the device took it');
  const data = later.hosted.data(offlineIndex, null);
  assert.deepEqual(data.sessions.map((s) => s.id), laptop.index.conversations.map((c) => c.id));
  for (const session of data.sessions) await later.hosted.conversation(session);
  assert.equal(data.sessions[1].exchanges[0].input, 'Message 1');
  await later.hosted.documentText(data.documents.doc0);
  assert.equal(data.documents.doc0.text, '# Notes 0');
  assert.equal((await later.hosted.fleet(data)).length, 1);
  assert.ok(laptop.requests.every((request) => ['k/params.json', 'index.json.enc'].includes(request.url)), 'only the probes went out: ' + laptop.requests.map((r) => r.url));
});

test('what the device never stored says so, in words, rather than failing with a status', async () => {
  const laptop = await phone.laptop({ conversations: 2, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  const data = first.hosted.data(await first.hosted.index(), null);
  await first.hosted.conversation(data.sessions[0]);  // only this one is kept
  laptop.down = true;
  const later = phone.page({ laptop, device });
  await later.hosted.prepare();
  const offline = later.hosted.data(await later.hosted.index(), null);
  await later.hosted.conversation(offline.sessions[0]);
  await assert.rejects(later.hosted.conversation(offline.sessions[1]), /not stored on this device yet, and the laptop is not reachable/);
});

test('an older stored copy is read when the laptop is away and the index it kept names a newer one', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  const old = first.hosted.data(await first.hosted.index(), null);
  await first.hosted.conversation(old.sessions[0]);
  // The laptop builds again; the phone takes the new index but never the object; then the laptop goes away.
  const entry = laptop.index.conversations[0];
  await laptop.set(entry.object, { id: entry.id, exchanges: [{ at: 9, source: 'captain', input: 'Newer', reply: 'x' }] }, 'v2');
  entry.stamp = 'v2';
  await laptop.publish({ as_of: Date.now() / 1000 });
  await first.hosted.index();
  laptop.down = true;
  const later = phone.page({ laptop, device });
  await later.hosted.prepare();
  const data = later.hosted.data(await later.hosted.index(), null);
  await later.hosted.conversation(data.sessions[0]);
  assert.equal(data.sessions[0].exchanges[0].input, 'Message 0', 'the older copy, better than none');
});

test('the passphrase is never stored: the device holds a key that cannot be exported, and sealed bytes, never the passphrase or any text', async () => {
  const laptop = await phone.laptop({ conversations: 2, documents: 1, weeks: 1 });
  const device = phone.device();
  const first = await opened(laptop, device);
  await first.hosted.download(await first.hosted.index());
  const keys = [...device.indexedDB.dump('hosted-reader').get('keys').values()];
  assert.equal(keys.length, 1);
  assert.equal(keys[0].type, 'secret');
  assert.equal(keys[0].extractable, false, 'a key that cannot be read out of the browser');
  let everything = '';
  for (const [store, records] of device.indexedDB.dump('hosted-reader')) {
    for (const [key, value] of records) {
      if (store === 'keys') continue;
      const bytes = value && value.bytes ? value.bytes : value;
      everything += `${store} ${key} ` + (bytes instanceof ArrayBuffer ? Buffer.from(bytes).toString('latin1') : JSON.stringify(value)) + '\n';
    }
  }
  assert.ok(!everything.includes(PASS), 'no passphrase anywhere');
  for (const word of ['Message 0', 'Reply 1', 'Notes 0']) assert.ok(!everything.includes(word), 'no transcript text at rest: ' + word);
  // The shell caches hold pages and icons only.
  for (const [, entries] of device.cacheEntries) for (const url of entries.keys()) assert.match(url, /index\.html|sheet\.html|manifest\.webmanifest|icon-/);
});

test('"Forget this device" clears the key, every stored object, the held sends, the shell cache and the worker', async () => {
  const laptop = await phone.laptop({ conversations: 2, documents: 1, weeks: 1 });
  const device = phone.device();
  const first = await opened(laptop, device);
  await first.hosted.download(await first.hosted.index());
  laptop.down = true;
  await first.hosted.enqueue(SESSION, 'held message');
  assert.equal((await first.hosted.heldIds()).size, 1);
  laptop.down = false;
  assert.ok(device.cacheEntries.size > 0 && device.registrations.length > 0);
  await first.hosted.forget();
  for (const [store, records] of device.indexedDB.dump('hosted-reader')) assert.equal(records.size, 0, store + ' is empty');
  assert.equal(device.cacheEntries.size, 0);
  assert.deepEqual(device.registrations, []);
  const again = phone.page({ laptop, device });
  assert.equal(await again.hosted.prepare(), 'locked', 'the passphrase is asked again');
});

test('a new passphrase (another salt) drops what was stored under the old one', async () => {
  const laptop = await phone.laptop({ conversations: 2, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  await first.hosted.download(await first.hosted.index());
  assert.equal(storedPaths(device).length, 2);
  const other = await phone.laptop({ conversations: 2, documents: 0, weeks: 0, passphrase: 'another made-up passphrase' });
  const later = phone.page({ laptop: other, device });
  assert.equal(await later.hosted.prepare(), 'locked', 'the remembered key is for the old bucket');
  assert.deepEqual(storedPaths(device), [], 'nothing sealed under the old key is kept');
});

test('a download the laptop stops answering part way keeps what came down and says it stopped', async () => {
  const laptop = await phone.laptop({ conversations: 6, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  const index = await first.hosted.index();
  let served = 0;
  const respond = laptop.respond;
  laptop.respond = async (url, options) => { if (url.endsWith('.enc') && url !== 'index.json.enc' && (served += 1) > 2) laptop.down = true; return respond(url, options); };
  const result = await first.hosted.download(index);
  assert.equal(result.stopped, true);
  assert.ok(result.fetched >= 1 && result.fetched < 6);
  assert.equal(storedPaths(device).length, result.fetched);
  laptop.respond = respond;
  laptop.down = false;
  const finished = await (await opened(laptop, device)).hosted.download(index);
  assert.equal(finished.stopped, false);
  assert.equal(storedPaths(device).length, 6);
});

test('an object the index no longer names is dropped from the device', async () => {
  const laptop = await phone.laptop({ conversations: 3, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  await first.hosted.download(await first.hosted.index());
  const gone = laptop.index.conversations.pop();
  await laptop.publish({ as_of: Date.now() / 1000 });
  await first.hosted.download(await first.hosted.index());
  assert.ok(!storedPaths(device).includes(gone.object));
  assert.equal(storedPaths(device).length, 2);
});

test('after one download, every newer index brings down only what changed, quietly; before it, nothing but the shell is kept', async () => {
  const laptop = await phone.laptop({ conversations: 2, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  const index = await first.hosted.index();
  assert.equal(await first.hosted.keepFresh(index), null, 'not asked for yet');
  assert.deepEqual(objectRequests(laptop), []);
  await first.hosted.download(index);
  const entry = laptop.index.conversations[0];
  await laptop.set(entry.object, { id: entry.id, exchanges: [] }, 'v9');
  entry.stamp = 'v9';
  await laptop.publish({ as_of: Date.now() / 1000 });
  laptop.requests.length = 0;
  const result = await first.hosted.keepFresh(await first.hosted.index());
  assert.equal(result.fetched, 1);
  assert.deepEqual(objectRequests(laptop), [entry.object + '.enc']);
});

test('the shell pages, manifest and icons are kept for the worker once per page code, asked for with the token', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  const index = await first.hosted.index();
  await first.hosted.keepFresh(index);
  const shellRequests = laptop.requests.filter((request) => /index\.html$|sheet\.html$/.test(request.url));
  assert.equal(shellRequests.length, 2);
  for (const request of shellRequests) assert.equal(request.headers['x-transcript-reader-token'], phone.TOKEN);
  const kept = [...device.cacheEntries.get('reader-shell-v1').keys()].map((url) => url.split('/').pop()).sort();
  assert.deepEqual(kept, ['icon-180.png', 'icon-512.png', 'index.html', 'manifest.webmanifest', 'sheet.html']);
  laptop.requests.length = 0;
  await first.hosted.keepFresh(index);
  assert.deepEqual(laptop.requests, [], 'the same page code is not fetched again');
  await first.hosted.keepFresh({ ...index, template: 'page-code-2' });
  assert.equal(laptop.requests.filter((request) => /index\.html$/.test(request.url)).length, 1, 'new page code is');
});

test('a plain copy keeps nothing on the device, and a page on an address with no worker says it cannot', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const answering = Object.create(laptop);
  answering.respond = async (url, options) => (url === 'k/params.json' ? { ok: false, status: 404, json: async () => ({}) } : laptop.respond(url, options));
  const plain = phone.page({ laptop: answering, device: phone.device() });
  assert.equal(await plain.hosted.prepare(), 'plain');
  assert.equal(plain.hosted.offline().capable, false);
  const insecure = phone.page({ laptop, device: phone.device(), secure: false });
  await insecure.hosted.prepare();
  await insecure.hosted.unlock(PASS, true);
  assert.equal(insecure.hosted.offline().capable, false, 'no service worker on plain http: the copy still reads, it just is not kept for offline');
  await assert.rejects(insecure.hosted.download(await insecure.hosted.index()), /cannot keep the copy for offline use/);
});

test('the laptop gets 8 seconds to answer; a request never answered is "not reachable", and the copy on the device is read instead', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  await first.hosted.download(await first.hosted.index());
  const later = phone.page({ laptop, device });
  await later.hosted.prepare();
  laptop.respond = () => new Promise(() => {});  // a shut Mac: no answer, ever
  const reading = later.hosted.index();
  await new Promise((resolve) => setImmediate(resolve));
  const timeout = [...later.timers].reverse().find((timer) => timer.ms === 8000);
  assert.ok(timeout, 'an 8 second timer is armed for the answer');
  timeout.fn();  // the browser gives up: the request is aborted
  const index = await reading;
  assert.equal(later.hosted.offline().fromDevice, true);
  assert.equal(index.conversations.length, 1);
  const data = later.hosted.data(index, null);
  await later.hosted.conversation(data.sessions[0]);
});

// ------------------------------------------------------------------ Send while away

test('a Send with the laptop away is held on the device as sealed bytes, and goes to the queue once, under its own id, when the laptop answers', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  laptop.down = true;
  const held = await first.hosted.enqueue(SESSION, 'A1=accept; from the train');
  assert.equal(held.held, true);
  assert.match(held.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([...(await first.hosted.heldIds())], [held.id]);
  const dump = JSON.stringify([...device.indexedDB.dump('hosted-reader').get('outbox').values()]);
  assert.ok(!dump.includes('from the train') && !dump.includes('A1=accept'), 'only sealed bytes at rest');
  assert.equal(laptop.queued.length, 0);
  // Still away: nothing goes, nothing is lost, and the same message is not held twice.
  assert.deepEqual(plain(await first.hosted.flush()), []);
  assert.deepEqual([...(await first.hosted.heldIds())], [held.id]);
  // The laptop is back: one post, with the id it was given, and the outbox is empty.
  laptop.down = false;
  const settled = await first.hosted.flush();
  assert.deepEqual(plain(settled), [{ id: held.id, state: 'queued' }]);
  assert.equal(laptop.queued.length, 1);
  assert.equal(laptop.queued[0].id, held.id);
  assert.equal(laptop.queued[0].copy, 'bucket');
  assert.equal((await first.hosted.heldIds()).size, 0);
  assert.deepEqual(plain(await first.hosted.flush()), []);
  assert.equal(laptop.queued.length, 1, 'never twice');
  // What it posted is a sealed request the laptop's drain can open with its own path as the additional data.
  const sealedRequest = Buffer.from(laptop.queued[0].data, 'base64');
  const request = JSON.parse(new TextDecoder().decode(await laptop.seal.gunzip(await laptop.seal.open(laptop.key, `q/${held.id}.json`, sealedRequest))));
  assert.deepEqual([request.id, request.session_id, request.text], [held.id, SESSION, 'A1=accept; from the train']);
  assert.ok(Math.abs(request.at - held.at) < 1, 'its own time is the time of the Send, which the 12 hour rule goes by');
});

test('a held send survives the page being closed and opened again, and a send the laptop already has is not sent again', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  laptop.down = true;
  const held = await first.hosted.enqueue(SESSION, 'once');
  laptop.down = false;
  // The post got through but the answer was lost, so the page held it too: the laptop says it is already queued.
  laptop.queued.push({ copy: 'bucket', id: held.id });
  const later = await opened(laptop, device);
  assert.deepEqual(plain(await later.hosted.flush()), [{ id: held.id, state: 'queued' }]);
  assert.equal(laptop.queued.length, 1, 'still the one');
  assert.equal((await later.hosted.heldIds()).size, 0);
});

test('a held send older than the laptop would accept (12 hours) is dropped and said, never posted', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const device = phone.device();
  let clock = Date.now();
  const first = await opened(laptop, device, { now: () => clock });
  laptop.down = true;
  const held = await first.hosted.enqueue(SESSION, 'too late');
  laptop.down = false;
  clock += 12 * 3600 * 1000 + 60000;
  assert.deepEqual(plain(await first.hosted.flush()), [{ id: held.id, state: 'expired' }]);
  assert.equal(laptop.queued.length, 0);
  assert.equal((await first.hosted.heldIds()).size, 0);
});

test('the laptop\'s answers to a flush: refused outright is dropped with its reason; full, signed out or failing keeps it held', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  laptop.down = true;
  const a = await first.hosted.enqueue(SESSION, 'a');
  laptop.down = false;
  for (const status of [429, 401, 500]) {
    laptop.queueAnswer = { status, body: { status: 'error', code: 'x', message: `status ${status}` } };
    assert.deepEqual(plain(await first.hosted.flush()), [], 'held on ' + status);
    assert.deepEqual([...(await first.hosted.heldIds())], [a.id]);
  }
  laptop.queueAnswer = { status: 400, body: { status: 'error', code: 'bad', message: 'That is not a sealed request.' } };
  assert.deepEqual(plain(await first.hosted.flush()), [{ id: a.id, state: 'refused', reason: 'That is not a sealed request.' }]);
  assert.equal((await first.hosted.heldIds()).size, 0);
});

test('with the laptop reachable a Send is queued at once and nothing is held; a refusal while reachable is an error, as before', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const device = phone.device();
  const first = await opened(laptop, device);
  const sent = await first.hosted.enqueue(SESSION, 'now');
  assert.equal(sent.held, undefined);
  assert.equal(laptop.queued.length, 1);
  assert.equal((await first.hosted.heldIds()).size, 0);
  laptop.queueAnswer = { status: 429, body: { status: 'error', code: 'queue_full', message: 'Too many messages are waiting for the laptop. Wait for them to be sent.' } };
  await assert.rejects(first.hosted.enqueue(SESSION, 'more'), /Too many messages/);
  assert.equal((await first.hosted.heldIds()).size, 0, 'an answer from the laptop is not "away"');
});

// ------------------------------------------------------------------ the HTML viewer's worker

test('the page hands an HTML document\'s text to the worker under a random key, and answers only for keys it holds', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const device = phone.device();
  const p = await opened(laptop, device);
  const doc = { name: 'my sketch.html', text: '<h1>sketch</h1>', size: 15, mtime: 5 };
  const info = await p.hosted.htmlOpen(doc);
  assert.match(info.url, /^https:\/\/phone\.example\.ts\.net:8443\/setup\/transcript-reader\/out\/bucket\/view\/[0-9a-f]{32}\/my%20sketch\.html$/);
  assert.deepEqual([info.name, info.size, info.mtime], ['my sketch.html', 15, 5]);
  const key = info.url.match(/view\/([0-9a-f]{32})\//)[1];
  const ask = (k) => new Promise((resolve) => { p.workerMessages.find((m) => m.name === 'message').fn({ data: { kind: 'view', key: k }, ports: [{ postMessage: resolve }] }); });
  assert.deepEqual(plain(await ask(key)), { html: '<h1>sketch</h1>' });
  assert.deepEqual(plain(await ask('0'.repeat(32))), { html: null }, 'a key it does not hold');
  const other = await p.hosted.htmlOpen({ ...doc, text: 'two' });
  assert.notEqual(other.url, info.url, 'a key of its own each time');
  await assert.rejects(p.hosted.htmlOpen({ name: 'x.html', text: null }), /not loaded yet/);
});

test('with no secure address there is no viewer, and it says why', async () => {
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  const p = phone.page({ laptop, device: phone.device(), secure: false });
  await assert.rejects(p.hosted.htmlOpen({ name: 'x.html', text: 'x' }), /needs a secure address/);
});

// A message channel whose ports are closed after the one answer, so a test run can end (an open port keeps Node alive).
class OneAnswerChannel {
  constructor() {
    const channel = new MessageChannel();
    this.port2 = channel.port2;
    this.port1 = { set onmessage(fn) { channel.port1.onmessage = (event) => { fn(event); channel.port1.close(); channel.port2.close(); }; } };
  }
}

// The worker file in a sandbox of its own: fake self, caches, clients and fetch, and a clock the test runs by hand.
function worker({ stored = {}, network = null, windows = [] } = {}) {
  const handlers = {};
  const preloadOn = [];
  const cache = new Map(Object.entries(stored));
  const waits = [];
  const timers = [];
  const sandbox = {
    self: {
      registration: { scope: 'https://phone.example.ts.net:8443/setup/transcript-reader/out/bucket/', navigationPreload: { enable: async () => { preloadOn.push(1); } } },
      addEventListener: (name, fn) => { handlers[name] = fn; },
      skipWaiting: async () => {}, clients: { claim: async () => {}, matchAll: async () => windows },
    },
    caches: { open: async () => ({ match: async (url) => (cache.has(url) ? cache.get(url).clone() : undefined), put: async (url, response) => { cache.set(url, response); } }) },
    fetch: (request) => (network ? network(request) : Promise.reject(new TypeError('offline'))),
    Response, URL, Promise, Set, RegExp, MessageChannel: OneAnswerChannel, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox);
  // The fetch event: the answer the worker gave (a promise), or undefined when it left the request to the network.
  const run = (url, { mode = 'navigate', method = 'GET', preload } = {}) => {
    let answer;
    handlers.fetch({ request: { url, mode, method }, preloadResponse: preload, respondWith: (promise) => { answer = promise; }, waitUntil: (promise) => waits.push(promise) });
    return answer;
  };
  return { run, cache, waits, timers, preloadOn, handlers };
}
const BASE = 'https://phone.example.ts.net:8443/setup/transcript-reader/out/bucket/';
const htmlResponse = (body, status = 200, type = 'text/html; charset=utf-8') => new Response(body, { status, headers: { 'Content-Type': type } });

test('the worker answers the viewer\'s navigation with the file under a policy that sandboxes it, from the window that holds the key', async () => {
  const key = 'ab'.repeat(16);
  const windowThatKnows = { postMessage: (message, ports) => { assert.deepEqual(plain(message), { kind: 'view', key }); ports[0].postMessage({ html: '<p>hello</p>' }); } };
  const windowThatDoesNot = { postMessage: (message, ports) => ports[0].postMessage({ html: null }) };
  const w = worker({ windows: [windowThatDoesNot, windowThatKnows] });
  const response = await w.run(`${BASE}view/${key}/sketch.html`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<p>hello</p>');
  const csp = response.headers.get('Content-Security-Policy');
  assert.match(csp, /^sandbox allow-scripts;/, 'the policy sandboxes the document itself');
  assert.doesNotMatch(csp, /allow-same-origin/, 'it never gets an origin of its own to read the reader\'s');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/, 'no network from the file');
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(csp, /https?:|\*/, 'no outside address is allowed to load anything');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('the policy limits the file as the laptop\'s own viewer does: the same sandbox, and nothing allowed to leave', () => {
  const api = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const directives = (source) => {
    const list = source.match(/const VIEW_CSP = (\[[\s\S]*?\])\.join/)[1];
    return new Map(vm.runInNewContext(list).map((item) => { const [name, ...rest] = item.split(' '); return [name, rest.join(' ')]; }));
  };
  const server = directives(api);
  const copy = directives(SW_SOURCE);
  for (const name of ['sandbox', 'default-src', 'connect-src', 'frame-src', 'object-src', 'form-action', 'frame-ancestors']) assert.equal(copy.get(name), server.get(name), name);
  for (const name of ['script-src', 'style-src']) assert.match(copy.get(name), /'unsafe-inline'/, name + ' runs the file\'s own code and styles');
  for (const [name, value] of copy) assert.ok(server.has(name), `${name} is one the server's policy has too`);
  assert.ok(!/allow-same-origin/.test(copy.get('sandbox')) && !/allow-same-origin/.test(server.get('sandbox')));
});

test('a view nobody holds, or a bad key, is a 404 and never a page', async () => {
  const w = worker({ windows: [{ postMessage: (message, ports) => ports[0].postMessage({ html: null }) }] });
  assert.equal((await w.run(`${BASE}view/${'cd'.repeat(16)}/x.html`)).status, 404);
  for (const bad of ['view/short/x.html', 'view/' + 'AB'.repeat(16) + '/x.html', 'view//x.html']) assert.equal((await w.run(BASE + bad)).status, 404, bad);
  assert.equal((await worker().run(`${BASE}view/${'cd'.repeat(16)}/x.html`)).status, 404, 'no window open at all');
});

test('the worker only answers a navigation inside its folder: a fetch, a POST or another path is left to the network', () => {
  const w = worker({ windows: [{ postMessage: (message, ports) => ports[0].postMessage({ html: 'x' }) }] });
  const key = 'ab'.repeat(16);
  assert.equal(w.run(`${BASE}view/${key}/x.html`, { mode: 'cors' }), undefined, 'a script\'s fetch');
  assert.equal(w.run(`${BASE}view/${key}/x.html`, { method: 'POST' }), undefined);
  assert.equal(w.run('https://phone.example.ts.net:8443/setup/transcript-reader/out/prototype.html'), undefined, 'the local page is not the worker\'s');
  assert.equal(w.run('https://other.example/setup/transcript-reader/out/bucket/index.html'), undefined);
  assert.equal(w.run(`${BASE}s/abc.json.enc`), undefined, 'the objects are the page\'s own business');
  assert.equal(w.run(`${BASE}k/params.json`), undefined);
});

test('the shell page: the laptop\'s answer when there is one, kept; the stored page when there is none', async () => {
  const shell = `${BASE}index.html`;
  const online = worker({ stored: { [shell]: htmlResponse('old page') }, network: async () => htmlResponse('fresh page') });
  assert.equal(await (await online.run(shell + '?x=1')).text(), 'fresh page');
  assert.equal(await online.cache.get(shell).clone().text(), 'fresh page', 'kept for next time, under the page\'s address without its query');
  const away = worker({ stored: { [shell]: htmlResponse('stored page') } });  // fetch rejects: the laptop is shut
  assert.equal(await (await away.run(shell)).text(), 'stored page');
  await assert.rejects(worker().run(shell), /offline/, 'nothing stored and no laptop: the browser\'s own error, not an invented page');
});

test('a sign-in page is shown as it is; a refusal or an error opens the stored page instead; none of them is kept as the shell', async () => {
  const shell = `${BASE}index.html`;
  const cases = [[401, 'text/html; charset=utf-8', 'not the shell'], [403, 'text/plain', 'stored page'], [502, 'text/html', 'stored page'], [200, 'application/json', 'not the shell']];
  for (const [status, type, shown] of cases) {
    const w = worker({ stored: { [shell]: htmlResponse('stored page') }, network: async () => htmlResponse('not the shell', status, type) });
    assert.equal(await (await w.run(shell)).text(), shown, String(status));
    assert.equal(await w.cache.get(shell).clone().text(), 'stored page', 'the stored page stays: ' + status);
  }
  // With no stored page there is nothing to open instead: the answer is shown.
  const bare = worker({ network: async () => htmlResponse('refused', 403, 'text/plain') });
  assert.equal(await (await bare.run(shell)).text(), 'refused');
});

test('the worker takes the browser\'s own navigation answer (navigation preload) over a fetch of its own, which the server would refuse', async () => {
  const shell = `${BASE}index.html`;
  const w = worker({ stored: { [shell]: htmlResponse('old page') }, network: async () => { throw new Error('a fetch of its own was made'); } });
  await w.handlers.activate({ waitUntil: (promise) => promise });
  assert.equal(w.preloadOn.length, 1, 'navigation preload is turned on when the worker activates');
  const answer = await w.run(shell, { preload: Promise.resolve(htmlResponse('preloaded page')) });
  assert.equal(await answer.text(), 'preloaded page');
  assert.equal(await w.cache.get(shell).clone().text(), 'preloaded page');
  // A browser without preload hands over nothing, and the worker asks for itself.
  const without = worker({ network: async () => htmlResponse('own fetch') });
  assert.equal(await (await without.run(shell, { preload: Promise.resolve(undefined) })).text(), 'own fetch');
});

test('a laptop slow to answer lets the stored page open after 4 seconds, and its late answer still refreshes the stored page', async () => {
  const shell = `${BASE}sheet.html`;
  let late;
  const w = worker({ stored: { [shell]: htmlResponse('stored sheet') }, network: () => new Promise((resolve) => { late = resolve; }) });
  const answering = w.run(shell);
  await new Promise((resolve) => setImmediate(resolve));
  const wait = w.timers.find((timer) => timer.ms === 4000);
  assert.ok(wait, 'the worker waits 4 seconds for the laptop when it has a page to open instead');
  wait.fn();
  assert.equal(await (await answering).text(), 'stored sheet');
  late(htmlResponse('late sheet'));
  await Promise.all(w.waits);
  assert.equal(await w.cache.get(shell).clone().text(), 'late sheet');
});
