'use strict';

// Tests for the hosted shell's loader (prototype/hosted.js). Run from the repo root:
//   node --test setup/transcript-reader/hosted.test.js
// The file runs in a sandbox with a fake fetch, page and clock, as the shell's script would run it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'prototype', 'hosted.js'), 'utf8');
const TOKEN = 'a'.repeat(64);

// A sandboxed hosted.js. objects: path -> JSON value (or a status number); token: the page's meta tag.
function load({ objects = {}, token = TOKEN, hidden = false, posted = { status: 200, body: { status: 'ok' } } } = {}) {
  const calls = [];
  const posts = [];
  const timers = [];
  const listeners = {};
  const storage = new Map();
  let reloads = 0;
  const page = {
    hidden,
    querySelector: (selector) => (selector === 'meta[name="reader-token"]' ? { content: token } : null),
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
  };
  const fetch = async (url, options) => {
    if (options && options.method === 'POST') {
      posts.push({ url, options, body: JSON.parse(options.body) });
      return { ok: posted.status < 400, status: posted.status, json: async () => { if (posted.body === undefined) throw new Error('no body'); return posted.body; } };
    }
    calls.push({ url, options });
    const value = objects[url];
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof value === 'number') return { ok: value < 400, status: value, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(value)) };
  };
  const sandbox = {
    document: page, fetch, Date, JSON, Map, Promise, Object, Number, String, Error, crypto: globalThis.crypto, TextEncoder,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    location: { reload: () => { reloads += 1; } },
  };
  vm.createContext(sandbox);
  const hosted = vm.runInContext(SOURCE + '\nhosted;', sandbox);
  return { hosted, calls, posts, timers, listeners, page, reloads: () => reloads };
}

const INDEX = {
  as_of: 1000, since: 500, homes: ['main'], template: 'abc', summaries: [],
  conversations: [
    { id: 'a', ids: ['a'], home: 'main', object: 's/a.json', stamp: 's1', last: 900, needs: 1 },
    { id: 'b', ids: ['b'], home: 'main', object: 's/b.json', stamp: 's2', last: 800, needs: 0 },
  ],
  documents: { d1: { id: 'd1', name: 'notes.md', dir: '~/x', mtime: 1, object: 'd/d1.json', stamp: 'd1s' } },
  weeks: {
    '2026-W40': { object: 'f/2026-W40.json', stamp: 'w40', from: 100, to: 400, events: 1, open: 1 },
    '2026-W41': { object: 'f/2026-W41.json', stamp: 'w41', from: 410, to: 480, events: 1, open: 0 },
    '2026-W42': { object: 'f/2026-W42.json', stamp: 'w42', from: 490, to: 990, events: 2, open: 0 },
  },
};

const OBJECTS = {
  'index.json': INDEX,
  's/a.json': { id: 'a', exchanges: [{ at: 900, input: 'hi' }] },
  's/b.json': { id: 'b', exchanges: [] },
  'd/d1.json': { id: 'd1', text: '# Notes' },
  'f/2026-W40.json': { events: [{ at: 100, open: true }] },
  'f/2026-W41.json': { events: [{ at: 410 }] },
  'f/2026-W42.json': { events: [{ at: 490 }, { at: 990 }] },
};

test('the index and every object are fetched with the token the server wrote into the shell', async () => {
  const { hosted, calls } = load({ objects: OBJECTS });
  const data = hosted.data(await hosted.index(), null);
  await hosted.conversation(data.sessions[0]);
  assert.deepEqual(calls.map((c) => c.url), ['index.json', 's/a.json']);
  for (const call of calls) {
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.headers['x-transcript-reader-token'], TOKEN);
  }
});

test('a shell on a static host, with the token tag unfilled, sends no token', async () => {
  const { hosted, calls } = load({ objects: OBJECTS, token: '__READER_TOKEN__' });
  await hosted.index();
  assert.deepEqual(Object.keys(calls[0].options.headers), []);
});

test('an index built without the fleet timeline says so, and one that says nothing keeps it', async () => {
  const { hosted } = load({ objects: OBJECTS });
  assert.equal(hosted.data(INDEX, null).fleet_timeline, true);
  const off = hosted.data({ ...INDEX, weeks: {}, fleet_timeline: false }, null);
  assert.equal(off.fleet_timeline, false);
  assert.deepEqual(await hosted.fleet(off), []);
});

test('the list comes from the index with no turns, which load one conversation at a time', async () => {
  const { hosted, calls } = load({ objects: OBJECTS });
  const data = hosted.data(INDEX, null);
  assert.equal(data.generated, 1000);
  assert.equal(data.since, 500);
  assert.deepEqual(data.sessions.map((s) => [s.id, s.exchanges]), [['a', null], ['b', null]]);
  assert.equal(data.documents.d1.text, null);
  assert.equal(data.fleet, null);
  const session = await hosted.conversation(data.sessions[1]);
  assert.deepEqual(session.exchanges, []);
  assert.equal(data.sessions[0].exchanges, null);
  assert.deepEqual(calls.map((c) => c.url), ['s/b.json']);
});

test('an object is fetched once per stamp, even when asked for twice at once', async () => {
  const { hosted, calls } = load({ objects: OBJECTS });
  const one = hosted.data(INDEX, null), two = hosted.data(INDEX, null);
  await Promise.all([hosted.conversation(one.sessions[0]), hosted.conversation(two.sessions[0])]);
  assert.equal(calls.filter((c) => c.url === 's/a.json').length, 1);
  assert.deepEqual(two.sessions[0].exchanges, [{ at: 900, input: 'hi' }]);
});

test('a newer index keeps what is loaded while its stamp is the same, and drops what changed', async () => {
  const { hosted, calls } = load({ objects: OBJECTS });
  const first = hosted.data(INDEX, null);
  await hosted.conversation(first.sessions[0]);
  await hosted.conversation(first.sessions[1]);
  await hosted.documentText(first.documents.d1);
  await hosted.fleet(first);
  const newer = { ...INDEX, as_of: 1060, conversations: [{ ...INDEX.conversations[0], stamp: 's1b' }, INDEX.conversations[1]] };
  const next = hosted.data(newer, first);
  assert.equal(next.sessions[0].exchanges, null, 'its stamp changed');
  assert.deepEqual(next.sessions[1].exchanges, []);
  assert.equal(next.documents.d1.text, '# Notes');
  assert.equal(next.fleet, first.fleet, 'no week changed');
  calls.length = 0;
  await hosted.conversation(next.sessions[0]);
  assert.deepEqual(calls.map((c) => c.url), ['s/a.json']);
  const weekChanged = hosted.data({ ...newer, weeks: { ...INDEX.weeks, '2026-W42': { ...INDEX.weeks['2026-W42'], stamp: 'w42b' } } }, next);
  assert.equal(weekChanged.fleet, null);
});

test('the timeline loads the weeks reaching into its window and older weeks with open items, in order', async () => {
  const { hosted, calls } = load({ objects: OBJECTS });
  const data = hosted.data(INDEX, null);
  assert.deepEqual(hosted.weeks(data), ['2026-W40', '2026-W42']);
  const events = await hosted.fleet(data);
  assert.deepEqual(events.map((e) => e.at), [100, 490, 990]);
  assert.deepEqual(calls.map((c) => c.url).sort(), ['f/2026-W40.json', 'f/2026-W42.json']);
  await hosted.fleet(data);
  assert.equal(calls.length, 2, 'loaded once');
});

test('a document loads its text on demand', async () => {
  const { hosted } = load({ objects: OBJECTS });
  const data = hosted.data(INDEX, null);
  await hosted.documentText(data.documents.d1);
  assert.equal(data.documents.d1.text, '# Notes');
});

test('an image document loads its bytes on demand as its text, and one the copy left out has no object to load', async () => {
  const index = { ...INDEX, documents: {
    ...INDEX.documents,
    i1: { id: 'i1', name: 'shot.png', dir: '~/x', mtime: 1, kind: 'image', mime: 'image/png', size: 3, object: 'd/i1.json', stamp: 'i1s' },
    i2: { id: 'i2', name: 'big.png', dir: '~/x', mtime: 1, kind: 'image', mime: 'image/png', size: 3000000, left_out: 'over the 2 MB the copy carries for one image' },
  } };
  const { hosted, calls } = load({ objects: { ...OBJECTS, 'd/i1.json': { id: 'i1', kind: 'image', mime: 'image/png', text: 'AAEC' } } });
  const data = hosted.data(index, null);
  assert.equal(data.documents.i1.text, null, 'not loaded until the picture is opened');
  assert.equal(data.documents.i2.text, '', 'nothing to load: the page says why it is not shown');
  await hosted.documentText(data.documents.i1);
  assert.equal(data.documents.i1.text, 'AAEC');
  assert.equal(data.documents.i1.mime, 'image/png');
  assert.deepEqual(calls.map((c) => c.url), ['d/i1.json']);
  assert.equal(data.documents.i2.left_out, 'over the 2 MB the copy carries for one image');
});

test('an object that is not built says so, and is tried again next time', async () => {
  const objects = { ...OBJECTS };
  delete objects['s/b.json'];
  const { hosted, calls } = load({ objects });
  const data = hosted.data(INDEX, null);
  await assert.rejects(hosted.conversation(data.sessions[1]), /s\/b\.json is not built yet/);
  await assert.rejects(hosted.conversation(data.sessions[1]));
  assert.equal(calls.filter((c) => c.url === 's/b.json').length, 2);
});

test('a refused token reloads the shell once, at most once a minute', async () => {
  const { hosted, reloads } = load({ objects: { 'index.json': 403 } });
  await assert.rejects(hosted.index(), /Reconnecting/);
  await assert.rejects(hosted.index(), /reload the page/);
  assert.equal(reloads(), 1);
});

test('an index older than the heartbeat is stale', () => {
  const { hosted } = load();
  assert.equal(hosted.HEARTBEAT, 600);
  assert.equal(hosted.stale(1000, 1000 + 600), false);
  assert.equal(hosted.stale(1000, 1000 + 601), true);
});

test('the poll runs every 30 seconds while the page is visible, and when it is shown again', async () => {
  const { hosted, timers, listeners, page } = load();
  let runs = 0;
  hosted.poll(async () => { runs += 1; });
  assert.equal(runs, 0, 'not at once: the shell has just loaded the index');
  assert.equal(timers[0].ms, 30000);
  await timers[0].fn();
  assert.equal(runs, 1);
  page.hidden = true;
  await timers[0].fn();
  assert.equal(runs, 1, 'not while hidden');
  page.hidden = false;
  await listeners.visibilitychange[0]();
  assert.equal(runs, 2);
});

test('a tick still running holds back the next one', async () => {
  const { hosted, timers } = load();
  let release;
  let runs = 0;
  hosted.poll(() => { runs += 1; return runs === 1 ? new Promise((resolve) => { release = resolve; }) : null; });
  const first = timers[0].fn();
  await timers[0].fn();
  assert.equal(runs, 1);
  release();
  await first;
  await timers[0].fn();
  assert.equal(runs, 2);
});

test('the list counts asks only for a live pane, and names its count apart from "need you"', () => {
  const { hosted } = load();
  const live = { needs: 2, pane: { live: true, status: 'working' } };
  const closed = { needs: 1, pane: { live: false, label: 'echo-old' } };  // the reviewer's closed-pane session E
  const unseen = { needs: 3, pane: null };  // never seen in a Herdr pane
  assert.equal(hosted.asks(live), '2 since your last message');
  assert.equal(hosted.asks({ ...live, needs: 0 }), '');
  assert.equal(hosted.waiting(closed), 0);
  assert.equal(hosted.asks(closed), '');
  assert.equal(hosted.asks(unseen), '');
  assert.equal(hosted.closedPane(closed), true);
  assert.equal(hosted.closedPane(live), false);
  assert.equal(hosted.closedPane(unseen), false, 'no pane seen is not a closed pane');
  assert.doesNotMatch(hosted.asks(live), /need/i);
});

test('a plain page queues a send with the token, as plain JSON, under an id of its own', async () => {
  const { hosted, posts } = load();
  const first = await hosted.enqueue('aaaaaaaa-1111-4111-8111-111111111111', 'A1=accept;A2=inline');
  const second = await hosted.enqueue('aaaaaaaa-1111-4111-8111-111111111111', 'again');
  assert.notEqual(first.id, second.id);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].url, '/api/transcript-reader/queue');
  assert.equal(posts[0].options.headers['x-transcript-reader-token'], TOKEN);
  assert.equal(posts[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(posts[0].body, { copy: 'hosted', id: first.id, object: { session_id: 'aaaaaaaa-1111-4111-8111-111111111111', text: 'A1=accept;A2=inline', at: first.at } });
  assert.ok(Math.abs(first.at - Date.now() / 1000) < 5);
});

test('a refused or unreachable queue says why, and a restarted server reloads the page once', async () => {
  const refused = load({ posted: { status: 429, body: { status: 'error', code: 'queue_full', message: 'Too many messages are waiting for the laptop.' } } });
  await assert.rejects(refused.hosted.enqueue('aaaaaaaa-1111-4111-8111-111111111111', 'x'), /Too many messages/);
  const stat = load({ posted: { status: 404, body: undefined } });
  await assert.rejects(stat.hosted.enqueue('aaaaaaaa-1111-4111-8111-111111111111', 'x'), /cannot take a message yet/);
  const restarted = load({ posted: { status: 403, body: { status: 'error', message: 'Missing or invalid token' } } });
  await assert.rejects(restarted.hosted.enqueue('aaaaaaaa-1111-4111-8111-111111111111', 'x'), /Reconnecting/);
  assert.equal(restarted.reloads(), 1);
});

test('a receipt is read from r/, and is none while the laptop has not written it', async () => {
  const id = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const { hosted, calls } = load({ objects: { [`r/${id}.json`]: { id, state: 'sent', label: 'alpha', at: 5 } } });
  assert.deepEqual(await hosted.receipt(id), { id, state: 'sent', label: 'alpha', at: 5 });
  assert.equal(await hosted.receipt('22222222-aaaa-4aaa-8aaa-aaaaaaaaaaa2'), null);
  assert.equal(calls[0].options.headers['x-transcript-reader-token'], TOKEN);
});

test('new page code reloads the page once per stamp, and an older deployed shell is said so rather than reloaded every minute', () => {
  const { hosted, reloads } = load();
  assert.equal(hosted.outdated(), '');
  hosted.pageChanged('stamp-a');             // the index names newer page code: load the page again
  assert.equal(reloads(), 1);
  assert.equal(hosted.outdated(), '');
  hosted.pageChanged('stamp-a');             // the reloaded page still differs: the host's shell is older
  assert.equal(reloads(), 1, 'no second reload');
  assert.match(hosted.outdated(), /older than the laptop's: deploy the new shell pages/);
  const again = load();
  again.hosted.pageChanged('stamp-a');
  again.hosted.pageChanged('stamp-b');       // a still newer stamp is a new reason to reload
  assert.equal(again.reloads(), 2);
  assert.equal(again.hosted.outdated(), '');
});

test('a leader\'s tasks come with its conversation, and stay while its stamp is the same (the By task grouping reads them)', async () => {
  const leader = { dir: '~/fm/firstmate', tasks: { x: { title: 'Task X', state: 'Done' } } };
  const objects = { ...OBJECTS, 's/a.json': { id: 'a', exchanges: [{ at: 900 }], leader } };
  const { hosted } = load({ objects });
  const first = hosted.data(INDEX, null);
  await hosted.conversation(first.sessions[0]);
  await hosted.conversation(first.sessions[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(first.sessions[0].leader)), leader);
  assert.equal(first.sessions[1].leader, undefined, 'a conversation that is not a leader\'s has none');
  const next = hosted.data({ ...INDEX, as_of: 2000 }, first);
  assert.deepEqual(JSON.parse(JSON.stringify(next.sessions[0].leader)), leader, 'a newer index with the same stamp keeps it with the turns');
  const changed = hosted.data({ ...INDEX, as_of: 2000, conversations: [{ ...INDEX.conversations[0], stamp: 's9' }, INDEX.conversations[1]] }, first);
  assert.equal(changed.sessions[0].leader, undefined, 'a changed conversation is loaded again, with its own');
});

test('a conversation\'s tool output is its own object, asked for once per stamp and never for a conversation that has none', async () => {
  const steps = { object: 't/a.json', stamp: 't1' };
  const index = { ...INDEX, steps_from: 400, conversations: [{ ...INDEX.conversations[0], steps }, INDEX.conversations[1]] };
  const { hosted, calls } = load({ objects: { ...OBJECTS, 't/a.json': { outputs: { 'turn:0': 'all good' } } } });
  const data = hosted.data(index, null);
  assert.equal(data.steps_from, 400, 'the window the build computed, which the page measures a step against');
  assert.deepEqual(data.sessions[0].steps, steps);
  assert.equal(data.sessions[1].steps, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(await hosted.steps(data.sessions[0]))), { outputs: { 'turn:0': 'all good' } });
  await hosted.steps(data.sessions[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(await hosted.steps(data.sessions[1]))), { outputs: {} });
  assert.deepEqual(calls.map((c) => c.url), ['t/a.json'], 'one ask, for the conversation that has output');
  assert.equal(await hosted.stepsHeld(data.sessions[0]), false, 'a plain copy keeps nothing on the device');
  assert.equal(hosted.data({ ...INDEX }, null).steps_from, 0, 'an index from before the window has none');
});
