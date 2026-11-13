'use strict';

// Tests for the reply queue (prototype/replyqueue.js). Run from the repo root:
//   node --test setup/transcript-reader/replyqueue.test.js
// The file runs in a bare sandbox with a stand-in for localStorage, so no page, browser or server is needed. What it holds is the replies the
// owner set aside to go through later: one list for each conversation, in the page's localStorage, so a reload, a Watch view that comes back
// and the Reader column all read the same one.

const test = require('node:test');
const assert = require('node:assert/strict');
const same = (actual, expected, message = 'values differ') => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);   // values from the sandbox have its own prototypes
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const makeReplyQueue = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'replyqueue.js'), 'utf8') + '\nmakeReplyQueue', {});

const DAY = 864e5;

// localStorage as a browser has it: strings only, key(i) and length, and the failures a browser can raise.
function storage({ refuse = false, broken = false } = {}) {
  const map = new Map();
  return {
    map,
    get length() { if (broken) throw new Error('denied'); return map.size; },
    key(i) { if (broken) throw new Error('denied'); return [...map.keys()][i] ?? null; },
    getItem(k) { if (broken) throw new Error('denied'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (broken || refuse) throw new Error('QuotaExceededError'); map.set(k, String(v)); },
    removeItem(k) { if (broken) throw new Error('denied'); map.delete(k); },
  };
}
// A clock the test moves.
function clock(start = 1.7e12) { const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; }

const A = 'aaaa1111-0000-4000-8000-000000000001';
const B = 'bbbb2222-0000-4000-8000-000000000002';
const reply = (n, at = 1000 + n * 10) => ({ key: `turn-${n}:reply`, at });
const keys = (list) => list.map((item) => item.key);

test('a reply is queued once, and the queue lists it', () => {
  const q = makeReplyQueue({ storage: storage() });
  assert.equal(q.add(A, [A], reply(1)), true);
  assert.equal(q.add(A, [A], reply(1)), false, 'the same reply again changes nothing');
  assert.equal(q.count([A]), 1);
  assert.equal(q.has([A], 'turn-1:reply'), true);
  assert.equal(q.has([A], 'turn-2:reply'), false);
  const [item] = q.items([A]);
  assert.equal(item.key, 'turn-1:reply');
  assert.equal(item.at, 1010);
  assert.ok(Number.isFinite(item.queued));
});

test('the queue is oldest reply first, whatever the order they were queued in', () => {
  const q = makeReplyQueue({ storage: storage() });
  for (const n of [5, 2, 9, 1, 7]) q.add(A, [A], reply(n));
  same(keys(q.items([A])), ['turn-1:reply', 'turn-2:reply', 'turn-5:reply', 'turn-7:reply', 'turn-9:reply']);
});

test('two replies of one moment keep the order they were queued in', () => {
  const c = clock();
  const q = makeReplyQueue({ storage: storage(), now: c.now });
  q.add(A, [A], { key: 'z:reply', at: 500 }); c.advance(10);
  q.add(A, [A], { key: 'a:reply', at: 500 });
  same(keys(q.items([A])), ['z:reply', 'a:reply']);
});

test('a conversation has its own queue: another conversation sees nothing of it', () => {
  const s = storage();
  const q = makeReplyQueue({ storage: s });
  q.add(A, [A], reply(1)); q.add(B, [B], reply(2));
  same(keys(q.items([A])), ['turn-1:reply']);
  same(keys(q.items([B])), ['turn-2:reply']);
  same([...s.map.keys()].sort(), [`tr-queue:${A}`, `tr-queue:${B}`], 'one entry for each conversation, under its own key');
});

test('taking a reply off (Done) gives the item back, and the last one leaves no entry behind', () => {
  const s = storage();
  const q = makeReplyQueue({ storage: s });
  q.add(A, [A], reply(1)); q.add(A, [A], reply(2));
  const gone = q.remove(A, [A], 'turn-1:reply');
  assert.equal(gone.key, 'turn-1:reply');
  assert.equal(q.remove(A, [A], 'turn-1:reply'), null, 'already off');
  same(keys(q.items([A])), ['turn-2:reply']);
  q.remove(A, [A], 'turn-2:reply');
  assert.equal(s.map.size, 0, 'an empty queue leaves nothing in the storage');
});

test('Undo puts the reply back where it was: its own time, its own queued time', () => {
  const c = clock();
  const q = makeReplyQueue({ storage: storage(), now: c.now });
  q.add(A, [A], reply(1)); c.advance(5000); q.add(A, [A], reply(2));
  const before = q.items([A]);
  const gone = q.remove(A, [A], 'turn-1:reply');
  c.advance(60000);
  assert.equal(q.add(A, [A], gone), true);
  same(q.items([A]), before);
});

test('clear takes every reply off and restore puts them back', () => {
  const s = storage();
  const q = makeReplyQueue({ storage: s });
  for (const n of [1, 2, 3]) q.add(A, [A], reply(n));
  const was = q.items([A]);
  same(q.clear(A, [A]), was);
  assert.equal(q.count([A]), 0);
  assert.equal(s.map.size, 0);
  assert.equal(q.restore(A, [A], was), 3);
  same(q.items([A]), was);
  assert.equal(q.restore(A, [A], was), 0, 'what is there already is not added twice');
});

test('a new page on the same storage finds the queue (the Watch column made again)', () => {
  const s = storage();
  makeReplyQueue({ storage: s }).add(A, [A], reply(1));
  const second = makeReplyQueue({ storage: s });
  same(keys(second.items([A])), ['turn-1:reply']);
});

test('a read is fresh: what another page queued or took off is what this page sees', () => {
  const s = storage();
  const one = makeReplyQueue({ storage: s }), two = makeReplyQueue({ storage: s });
  one.add(A, [A], reply(1));
  assert.equal(two.signature([A]), 'turn-1:reply');
  two.add(A, [A], reply(2));
  assert.equal(one.signature([A]), 'turn-1:reply|turn-2:reply');
  two.remove(A, [A], 'turn-1:reply');
  assert.equal(one.signature([A]), 'turn-2:reply');
  assert.equal(one.has([A], 'turn-1:reply'), false);
});

test('a queued reply is kept 14 days, then it is not listed and a page start removes it', () => {
  const c = clock();
  const s = storage();
  const q = makeReplyQueue({ storage: s, now: c.now });
  q.add(A, [A], reply(1)); c.advance(10 * DAY); q.add(A, [A], reply(2));
  c.advance(5 * DAY);   // 15 days since the first, 5 since the second
  same(keys(q.items([A])), ['turn-2:reply']);
  assert.equal(s.map.size, 1, 'the entry is still there until a page start');
  q.prune();
  same(keys(q.items([A])), ['turn-2:reply']);
  c.advance(10 * DAY);
  q.prune();
  assert.equal(s.map.size, 0, 'everything old enough is gone');
});

test('at most 200 replies in a queue: the 201st is refused with the reason, and the queue is as it was', () => {
  const q = makeReplyQueue({ storage: storage() });
  for (let n = 0; n < 200; n++) q.add(A, [A], reply(n));
  assert.throws(() => q.add(A, [A], reply(300)), /holds 200 replies already: mark some Done first/);
  assert.equal(q.count([A]), 200);
  q.remove(A, [A], 'turn-0:reply');
  assert.equal(q.add(A, [A], reply(300)), true);
});

test('at most 100 conversations keep a queue: page start drops the one written longest ago', () => {
  const c = clock();
  const s = storage();
  const q = makeReplyQueue({ storage: s, now: c.now, conversations: 3 });
  for (const id of ['c1', 'c2', 'c3', 'c4']) { q.add(id, [id], reply(1)); c.advance(1000); }
  q.prune();
  same([...s.map.keys()].sort(), ['tr-queue:c2', 'tr-queue:c3', 'tr-queue:c4']);
});

test('where the browser refuses storage, the queue is held in the page', () => {
  const s = storage({ refuse: true });
  const q = makeReplyQueue({ storage: s });
  q.add(A, [A], reply(1));
  assert.equal(s.map.size, 0, 'nothing reached the storage');
  same(keys(q.items([A])), ['turn-1:reply'], 'but the page has it');
  q.add(A, [A], reply(2));
  q.remove(A, [A], 'turn-1:reply');
  same(keys(q.items([A])), ['turn-2:reply']);
});

test('no storage at all (the browser denies it) still works in the page', () => {
  const q = makeReplyQueue({ storage: storage({ broken: true }) });
  q.add(A, [A], reply(1));
  same(keys(q.items([A])), ['turn-1:reply']);
  q.prune();   // does not throw
  assert.equal(makeReplyQueue({}).count([A]), 0, 'with no storage object either');
});

test('the hosted copy keeps its own queue, apart from the local page\'s', () => {
  const s = storage();
  const local = makeReplyQueue({ storage: s }), hosted = makeReplyQueue({ storage: s, hosted: true });
  local.add(A, [A], reply(1)); hosted.add(A, [A], reply(2));
  same(keys(local.items([A])), ['turn-1:reply']);
  same(keys(hosted.items([A])), ['turn-2:reply']);
  same([...s.map.keys()].sort(), [`tr-hosted-queue:${A}`, `tr-queue:${A}`]);
  hosted.prune(); local.prune();
  assert.equal(s.map.size, 2, 'neither prunes the other\'s');
});

test('page start removes what is unreadable or the wrong shape, and leaves other keys alone', () => {
  const s = storage();
  s.map.set('tr-queue:bad1', '{not json');
  s.map.set('tr-queue:bad2', JSON.stringify({ items: 'no' }));
  s.map.set('tr-queue:bad3', JSON.stringify({ items: [{ key: 7, at: 'x', queued: null }] }));
  s.map.set('tr-draft:keep', JSON.stringify({ text: 'x', at: 1 }));
  s.map.set('tr-pins', '[]');
  const q = makeReplyQueue({ storage: s });
  q.add(A, [A], reply(1));
  q.prune();
  same([...s.map.keys()].sort(), ['tr-draft:keep', 'tr-pins', `tr-queue:${A}`]);
});

test('an item of the wrong shape in a good entry is not listed', () => {
  const s = storage();
  s.map.set(`tr-queue:${A}`, JSON.stringify({ items: [{ key: 'ok:reply', at: 5, queued: 1.7e12 }, { key: '', at: 5, queued: 1.7e12 }, { key: 'x:reply', at: 'late', queued: 1.7e12 }, null, 3], at: 1.7e12 }));
  const q = makeReplyQueue({ storage: s, now: () => 1.7e12 + 1000 });
  same(keys(q.items([A])), ['ok:reply']);
});

test('after a /clear the queue written under an earlier id is read under the newest, and the next write moves it there', () => {
  const s = storage();
  const q = makeReplyQueue({ storage: s });
  const OLD = 'old00000-0000-4000-8000-000000000000';
  q.add(OLD, [OLD], reply(1));
  const ids = [OLD, A];   // the conversation now has two ids; A is the newest
  same(keys(q.items(ids)), ['turn-1:reply'], 'read under both ids');
  q.add(A, ids, reply(2));
  same(keys(q.items(ids)), ['turn-1:reply', 'turn-2:reply']);
  same([...s.map.keys()], [`tr-queue:${A}`], 'the earlier entry is gone');
});

test('a reply queued under the earlier id and again under the newest is one item, the earlier queued time kept', () => {
  const c = clock();
  const s = storage();
  const q = makeReplyQueue({ storage: s, now: c.now });
  const OLD = 'old00000-0000-4000-8000-000000000000';
  q.add(OLD, [OLD], reply(1)); const first = q.items([OLD])[0].queued;
  c.advance(1000);
  s.map.set(`tr-queue:${A}`, JSON.stringify({ items: [{ key: 'turn-1:reply', at: 1010, queued: c.now() }], at: c.now() }));
  const list = q.items([OLD, A]);
  assert.equal(list.length, 1);
  assert.equal(list[0].queued, first);
});

test('removing a reply under the newest id also takes it off the earlier ones', () => {
  const s = storage();
  const q = makeReplyQueue({ storage: s });
  const OLD = 'old00000-0000-4000-8000-000000000000';
  q.add(OLD, [OLD], reply(1)); q.add(OLD, [OLD], reply(2));
  q.remove(A, [OLD, A], 'turn-1:reply');
  same(keys(q.items([OLD, A])), ['turn-2:reply']);
  same([...s.map.keys()], [`tr-queue:${A}`]);
});

test('the queue holds no message text', () => {
  const s = storage();
  const q = makeReplyQueue({ storage: s });
  q.add(A, [A], { key: 'turn-1:reply', at: 10, text: 'a secret sentence', title: 'also secret' });
  const stored = s.map.get(`tr-queue:${A}`);
  assert.ok(!/secret/.test(stored), stored);
  same(Object.keys(JSON.parse(stored).items[0]).sort(), ['at', 'key', 'queued']);
});

// ---- the queue as the conversation on screen shows it

const turns = [
  { uid: 't1', reply: 'First reply', at: 100 },
  { uid: 't2', reply: 'Second reply', at: 200 },
  { uid: 't3', reply: '', at: 300 },
  { uid: 't4', reply: 'Fourth reply', at: 400 },
];
const item = (key, at) => ({ key, at, queued: 1.7e12 });

test('rows: each queued reply on the page is "here", in the queue\'s order', () => {
  const q = makeReplyQueue({ storage: storage() });
  const rows = q.rows([item('t1:reply', 100), item('t4:reply', 400)], turns);
  same(rows.map((r) => [r.item.key, r.state, r.index]), [['t1:reply', 'here', 0], ['t4:reply', 'here', 3]]);
  assert.equal(rows[0].ex.reply, 'First reply');
});

test('rows: a reply that is no longer in the conversation is "gone" and goes last, so the ones that can be gone to come first', () => {
  const q = makeReplyQueue({ storage: storage() });
  const rows = q.rows([item('old:reply', 50), item('t1:reply', 100), item('t2:reply', 200)], turns);
  same(rows.map((r) => [r.item.key, r.state]), [['t1:reply', 'here'], ['t2:reply', 'here'], ['old:reply', 'gone']]);
  assert.equal(q.next(rows).item.key, 't1:reply', 'Next skips a gone one');
});

test('rows: a turn without a reply is not a reply to go to', () => {
  const q = makeReplyQueue({ storage: storage() });
  same(q.rows([item('t3:reply', 300)], turns).map((r) => r.state), ['gone']);
});

test('rows: a hidden reply is "hidden", and Next still goes to it', () => {
  const q = makeReplyQueue({ storage: storage() });
  const rows = q.rows([item('t1:reply', 100), item('t2:reply', 200)], turns, (ex) => ex.uid === 't1');
  same(rows.map((r) => r.state), ['hidden', 'here']);
  assert.equal(q.next(rows).item.key, 't1:reply');
});

test('rows: a conversation that is not loaded yet says nothing about any reply (none is "gone")', () => {
  const q = makeReplyQueue({ storage: storage() });
  const rows = q.rows([item('t1:reply', 100)], undefined);
  same(rows.map((r) => r.state), ['unloaded']);
  assert.equal(q.next(rows), null);
});

test('next: nothing to go to when every row is gone or the queue is empty', () => {
  const q = makeReplyQueue({ storage: storage() });
  assert.equal(q.next([]), null);
  assert.equal(q.next(q.rows([item('x:reply', 1)], turns)), null);
});

test('snippet: the first two lines of words without the marks of markdown, cut at 160 characters', () => {
  const q = makeReplyQueue({ storage: storage() });
  assert.equal(q.snippet('## Heading\n\n- **Bold** point `code`\n- third line'), 'Heading · Bold point code');
  assert.equal(q.snippet(''), '(no text)');
  assert.equal(q.snippet('   \n\n'), '(no text)');
  const long = q.snippet('word '.repeat(100));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
});

test('the page\'s own flow: queue three, go through them oldest first, Done each, the queue is empty and leaves nothing', () => {
  const s = storage();
  const q = makeReplyQueue({ storage: s });
  for (const [key, at] of [['t4:reply', 400], ['t1:reply', 100], ['t2:reply', 200]]) q.add(A, [A], { key, at });
  const seen = [];
  for (let guard = 0; guard < 10; guard++) {
    const row = q.next(q.rows(q.items([A]), turns));
    if (!row) break;
    seen.push(row.item.key);
    q.remove(A, [A], row.item.key);
  }
  same(seen, ['t1:reply', 't2:reply', 't4:reply']);
  assert.equal(s.map.size, 0);
});
