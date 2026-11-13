'use strict';

// Tests for the unsent-message store (prototype/draftstore.js). Run from the repo root:
//   node --test setup/transcript-reader/draftstore.test.js
// The file runs in a bare sandbox with a stand-in for localStorage, so no page, browser or server is needed. What it holds is the words in
// the message box and the comments waiting to go together, one entry per conversation, so that a web view let go of (Conn's Watch off)
// hands them back when it is made again.

const test = require('node:test');
const assert = require('node:assert/strict');
const same = (actual, expected, message = 'values differ') => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);   // values from the sandbox have its own prototypes
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const makeDraftStore = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'draftstore.js'), 'utf8') + '\nmakeDraftStore', {});

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

const DRAFT = { text: 'unsent words about the next step', sid: 'aaaa1111', target: { title: 'Reply', passage: 'the quoted line', pointer: 'Re your reply: ', bare: 'Re: ' }, editing: null };
const ITEMS = [{ sid: 'aaaa1111', title: 'Reply', passage: 'p', typed: 'first comment', pointer: 'Re: p ', bare: 'Re: ' }];

test('a draft comes back with its pointer and Edit position, and only for its own conversation', () => {
  const store = makeDraftStore({ storage: storage() });
  store.putDraft('aaaa1111', { ...DRAFT, editing: 2 });
  const back = store.draft('aaaa1111');
  assert.equal(back.text, DRAFT.text);
  same(back.target, DRAFT.target);
  assert.equal(back.editing, 2);
  assert.equal(back.sid, 'aaaa1111');
  assert.equal(store.draft('bbbb2222'), null, 'another conversation has an empty box');
});

test('a draft is one entry per conversation under its own key', () => {
  const s = storage();
  const store = makeDraftStore({ storage: s });
  store.putDraft('aaaa1111', DRAFT);
  store.putDraft('bbbb2222', { ...DRAFT, text: 'other' });
  store.putBatch('aaaa1111', ITEMS);
  same([...s.map.keys()].sort(), ['tr-batch:aaaa1111', 'tr-draft:aaaa1111', 'tr-draft:bbbb2222']);
});

test('a new page on the same storage finds the draft and the batch (the Watch column made again)', () => {
  const s = storage();
  const first = makeDraftStore({ storage: s });
  first.putDraft('aaaa1111', DRAFT);
  first.putBatch('aaaa1111', ITEMS);
  const second = makeDraftStore({ storage: s });   // the web view is new; the stored data is the same
  assert.equal(second.draft('aaaa1111').text, DRAFT.text);
  same(second.batch('aaaa1111'), ITEMS);
  same(second.batch('bbbb2222'), []);
});

test('a read is fresh: words another page wrote, sent or removed are what this page sees', () => {
  const s = storage();
  const one = makeDraftStore({ storage: s }), two = makeDraftStore({ storage: s });
  one.putDraft('aaaa1111', DRAFT);
  assert.equal(two.draft('aaaa1111').text, DRAFT.text);
  two.putDraft('aaaa1111', { ...DRAFT, text: 'newer words' });
  assert.equal(one.draft('aaaa1111').text, 'newer words');
  two.dropDraft('aaaa1111');   // sent from the second page
  assert.equal(one.draft('aaaa1111'), null, 'a sent message does not come back in the first page');
  one.putBatch('aaaa1111', ITEMS); two.putBatch('aaaa1111', []);
  same(one.batch('aaaa1111'), []);
});

test('an emptied box and an emptied batch leave nothing behind', () => {
  const s = storage();
  const store = makeDraftStore({ storage: s });
  store.putDraft('aaaa1111', DRAFT); store.putBatch('aaaa1111', ITEMS);
  store.dropDraft('aaaa1111'); store.putBatch('aaaa1111', []);
  assert.equal(s.map.size, 0);
  assert.equal(store.draft('aaaa1111'), null);
  same(store.batch('aaaa1111'), []);
});

test('an entry is kept 7 days from its last write, then it is not shown and a page start removes it', () => {
  const s = storage(), c = clock();
  const store = makeDraftStore({ storage: s, now: c.now });
  store.putDraft('aaaa1111', DRAFT); store.putBatch('aaaa1111', ITEMS);
  c.advance(6.9 * DAY);
  assert.equal(store.draft('aaaa1111').text, DRAFT.text);
  assert.equal(store.batch('aaaa1111').length, 1);
  c.advance(0.2 * DAY);   // 7.1 days
  assert.equal(store.draft('aaaa1111'), null);
  same(store.batch('aaaa1111'), []);
  assert.equal(s.map.size, 2, 'reading does not remove');
  store.prune();
  assert.equal(s.map.size, 0);
});

test('writing again starts the 7 days again', () => {
  const s = storage(), c = clock();
  const store = makeDraftStore({ storage: s, now: c.now });
  store.putDraft('aaaa1111', DRAFT);
  c.advance(5 * DAY);
  store.putDraft('aaaa1111', { ...DRAFT, text: 'still typing' });
  c.advance(5 * DAY);
  assert.equal(store.draft('aaaa1111').text, 'still typing');
});

test('at most 50 entries are kept: the oldest go first, when an entry is added and at page start', () => {
  const s = storage(), c = clock();
  const store = makeDraftStore({ storage: s, now: c.now });
  for (let i = 0; i < 60; i++) { store.putDraft('s' + i, { ...DRAFT, text: 'words ' + i }); c.advance(1000); }
  assert.equal(s.map.size, 50);
  assert.equal(store.draft('s0'), null);
  assert.equal(store.draft('s9'), null);
  assert.equal(store.draft('s10').text, 'words 10');
  assert.equal(store.draft('s59').text, 'words 59');
  // a store started over a fuller storage (an older page wrote more) cuts it back
  for (let i = 0; i < 20; i++) s.map.set('tr-draft:extra' + i, JSON.stringify({ text: 'x', at: c.now() - 1e6 + i }));
  assert.equal(s.map.size, 70);
  makeDraftStore({ storage: s, now: c.now }).prune();
  assert.equal(s.map.size, 50);
  assert.equal(store.draft('s59').text, 'words 59', 'the newest stay');
});

test('words over 20,000 characters are not stored; they stay in the page, and an older stored copy is not shown in their place', () => {
  const s = storage();
  const store = makeDraftStore({ storage: s });
  store.putDraft('aaaa1111', { ...DRAFT, text: 'short first' });
  assert.equal(s.map.size, 1);
  const long = 'x'.repeat(20001);
  store.putDraft('aaaa1111', { ...DRAFT, text: long });
  assert.equal(s.map.size, 0, 'the older, shorter copy is gone, not left to come back');
  assert.equal(store.draft('aaaa1111').text, long, 'the page still has its words');
  store.putDraft('aaaa1111', { ...DRAFT, text: 'x'.repeat(20000) });
  assert.equal(s.map.size, 1, '20,000 characters are kept');
  assert.equal(makeDraftStore({ storage: s }).draft('aaaa1111').text.length, 20000);
});

test('a batch over 60,000 characters stays in the page only', () => {
  const s = storage();
  const store = makeDraftStore({ storage: s });
  const big = [{ ...ITEMS[0], typed: 'y'.repeat(70000) }];
  store.putBatch('aaaa1111', big);
  assert.equal(s.map.size, 0);
  assert.equal(store.batch('aaaa1111')[0].typed.length, 70000);
});

test('where the browser refuses storage, the words are held in the page', () => {
  for (const options of [{ refuse: true }, { broken: true }]) {
    const store = makeDraftStore({ storage: storage(options) });
    store.putDraft('aaaa1111', DRAFT);
    store.putBatch('aaaa1111', ITEMS);
    assert.equal(store.draft('aaaa1111').text, DRAFT.text, JSON.stringify(options));
    assert.equal(store.batch('aaaa1111').length, 1, JSON.stringify(options));
    store.dropDraft('aaaa1111'); store.putBatch('aaaa1111', []);
    assert.equal(store.draft('aaaa1111'), null, JSON.stringify(options));
    same(store.batch('aaaa1111'), [], JSON.stringify(options));
    store.prune();   // nothing to look through, and nothing thrown
  }
});

test('no storage at all (the browser denies the object itself) still works in the page', () => {
  const store = makeDraftStore({ storage: null });
  store.putDraft('aaaa1111', DRAFT);
  assert.equal(store.draft('aaaa1111').text, DRAFT.text);
  store.prune(); store.migrate(null);
});

test('the hosted copy keeps its own entries, apart from the local page\'s', () => {
  const s = storage();
  const local = makeDraftStore({ storage: s }), hosted = makeDraftStore({ storage: s, hosted: true });
  local.putDraft('aaaa1111', { ...DRAFT, text: 'typed on the laptop page' });
  assert.equal(hosted.draft('aaaa1111'), null);
  hosted.putDraft('aaaa1111', { ...DRAFT, text: 'typed in the hosted copy' });
  hosted.putBatch('aaaa1111', ITEMS);
  assert.equal(local.draft('aaaa1111').text, 'typed on the laptop page');
  same(local.batch('aaaa1111'), []);
  assert.ok(s.map.has('tr-hosted-draft:aaaa1111') && s.map.has('tr-hosted-batch:aaaa1111'));
});

test('page start removes what is unreadable or the wrong shape, and leaves other keys alone', () => {
  const s = storage(), c = clock();
  s.map.set('tr-draft:bad', '{not json');
  s.map.set('tr-draft:noat', JSON.stringify({ text: 'x' }));
  s.map.set('tr-draft:notext', JSON.stringify({ at: c.now() }));
  s.map.set('tr-batch:noitems', JSON.stringify({ at: c.now(), items: 'nope' }));
  s.map.set('tr-read', '{"a":1}');
  s.map.set('tr-pins', '[]');
  s.map.set('tr-hosted-draft:other', JSON.stringify({ text: 'hosted', at: c.now() }));
  const store = makeDraftStore({ storage: s, now: c.now });
  assert.equal(store.draft('bad'), null);
  assert.equal(store.draft('notext'), null);
  same(store.batch('noitems'), []);
  store.prune();
  same([...s.map.keys()].sort(), ['tr-hosted-draft:other', 'tr-pins', 'tr-read']);
});

test('what an older page left in the tab\'s sessionStorage moves once, and does not overwrite a newer entry', () => {
  const s = storage(), from = storage();
  from.map.set('tr-drafts', JSON.stringify({ aaaa1111: DRAFT, bbbb2222: 'a draft the first version kept as a string', cccc3333: { ...DRAFT, text: 'older than the stored one' } }));
  from.map.set('tr-batches', JSON.stringify({ aaaa1111: ITEMS, dddd4444: [] }));
  const store = makeDraftStore({ storage: s });
  store.putDraft('cccc3333', { ...DRAFT, text: 'the stored one is newer' });
  store.migrate(from);
  assert.equal(store.draft('aaaa1111').text, DRAFT.text);
  same(store.draft('aaaa1111').target, DRAFT.target);
  assert.equal(store.draft('bbbb2222').text, 'a draft the first version kept as a string');
  assert.equal(store.draft('bbbb2222').sid, 'bbbb2222');
  assert.equal(store.draft('cccc3333').text, 'the stored one is newer');
  same(store.batch('aaaa1111'), ITEMS);
  same(store.batch('dddd4444'), []);
  assert.equal(from.map.size, 0, 'the old keys are gone, so it happens once');
  store.migrate(from);   // nothing left; nothing changes
  assert.equal(store.draft('aaaa1111').text, DRAFT.text);
});

test('migrating a damaged sessionStorage value drops it and does not throw', () => {
  const from = storage();
  from.map.set('tr-drafts', '{oops'); from.map.set('tr-batches', '[1,2]');
  const store = makeDraftStore({ storage: storage() });
  store.migrate(from);
  assert.equal(from.map.size, 0);
  assert.equal(store.draft('1'), null);
});

test('the page\'s own flow: type, switch away, come back in a new web view, send', () => {
  const s = storage();
  // a Watch column: words typed, then Watch ends and the web view goes
  const view1 = makeDraftStore({ storage: s });
  view1.putDraft('aaaa1111', { ...DRAFT, text: 'half a thought' });
  view1.putBatch('aaaa1111', ITEMS);
  // Watch comes back: a new web view
  const view2 = makeDraftStore({ storage: s });
  view2.prune();
  assert.equal(view2.draft('aaaa1111').text, 'half a thought');
  assert.equal(view2.batch('aaaa1111').length, 1);
  // the send starts: the box and the batch go
  view2.dropDraft('aaaa1111'); view2.putBatch('aaaa1111', []);
  // another web view: nothing comes back
  const view3 = makeDraftStore({ storage: s });
  assert.equal(view3.draft('aaaa1111'), null);
  same(view3.batch('aaaa1111'), []);
  assert.equal(s.map.size, 0);
});

// ---------------------------------------------------------------- the page's own use: what a /clear moves to the pane's newest session
// The lines of template.html that move a draft and a batch written under an earlier session id to the newest one, run on the real store.
const PAGE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const ADOPT_FROM = PAGE.indexOf('  const adopted = new Map();');
const ADOPT = PAGE.slice(ADOPT_FROM, PAGE.indexOf('  // Comments waiting to go together', ADOPT_FROM));

function adoptWorld(s = storage()) {
  const store = makeDraftStore({ storage: s });
  const moved = [];
  const context = { unsent: store, photos: { move: (from, to) => moved.push([from, to]) }, draftOf: (sid) => store.draft(sid), batchOf: (sid) => store.batch(sid), saveBatch: (sid, items) => store.putBatch(sid, items) };
  vm.runInNewContext(ADOPT + '\nthis.adopt = adopt;', context);
  return { store, adopt: context.adopt, moved, s };
}
const reads = (s) => { let n = 0; const get = s.getItem; s.getItem = (k) => { n += 1; return get.call(s, k); }; return () => n; };

test('after a /clear the draft and the batch written under an earlier id move to the newest, and the earlier entries are gone', () => {
  const { store, adopt, moved, s } = adoptWorld();
  store.putDraft('old1', { ...DRAFT, text: 'typed before the clear', sid: 'old1' });
  store.putBatch('old1', [{ title: 'Reply', passage: 'p', typed: 'first comment', pointer: 'Re: p ', bare: 'Re: ' }]);   // a comment batched before the clear: no session named yet
  store.putBatch('new1', [{ sid: 'new1', title: 'Message', passage: '', typed: 'after', pointer: '', bare: '' }]);
  adopt({ id: 'new1', ids: ['old1', 'new1'] });
  assert.equal(store.draft('new1').text, 'typed before the clear');
  assert.equal(store.draft('new1').sid, 'old1', 'the draft remembers the session it was written in, so its pointer can say so');
  assert.equal(store.draft('old1'), null);
  same(store.batch('old1'), []);
  same(store.batch('new1').map((item) => [item.sid, item.typed]), [['old1', 'first comment'], ['new1', 'after']]);
  same(moved, [['old1', 'new1']]);
  assert.deepEqual([...s.map.keys()].sort(), ['tr-batch:new1', 'tr-draft:new1']);
});

test('a draft already written under the newest id is kept, and the earlier one is dropped', () => {
  const { store, adopt } = adoptWorld();
  store.putDraft('old1', { ...DRAFT, text: 'older words', sid: 'old1' });
  store.putDraft('new1', { ...DRAFT, text: 'newer words', sid: 'new1' });
  adopt({ id: 'new1', ids: ['old1', 'new1'] });
  assert.equal(store.draft('new1').text, 'newer words');
  assert.equal(store.draft('old1'), null);
});

test('the earlier ids are looked up when the conversation comes up or its list of ids grows, not on every redraw', () => {
  const { store, adopt, s } = adoptWorld();
  const count = reads(s);
  adopt({ id: 'new1', ids: ['old1', 'new1'] });
  const first = count();
  assert.ok(first > 0);
  for (let i = 0; i < 50; i++) adopt({ id: 'new1', ids: ['old1', 'new1'] });
  assert.equal(count(), first, 'a redraw with the same ids reads nothing');
  store.putDraft('old2', { ...DRAFT, text: 'typed under a newer earlier id', sid: 'old2' });
  adopt({ id: 'new1', ids: ['old1', 'old2', 'new1'] });
  assert.equal(store.draft('new1').text, 'typed under a newer earlier id');
});
