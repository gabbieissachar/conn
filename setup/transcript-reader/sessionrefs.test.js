'use strict';

// Tests for how the reader page finds another session in a reply (prototype/sessionrefs.js). Run from the repo root:
//   node --test setup/transcript-reader/sessionrefs.test.js
// The file runs in a bare sandbox: the functions take a list of conversations and a text and answer plain values.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const refs = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'sessionrefs.js'), 'utf8') + '\nsessionRefs', { String, Array, Map, Set, JSON, RegExp });

const id = (n) => `${String(n).repeat(8).slice(0, 8)}-aaaa-4aaa-8aaa-${String(n).repeat(12).slice(0, 12)}`;
const session = (n, label, extra = {}) => ({ id: id(n), ids: [id(n)], pane: label === null ? null : { label }, ...extra });
const SESSIONS = [
  session(1, 'fm-2026-11-06-esim-listing-output-sync-run'),
  session(2, 'leader-esim'),
  session(3, 'big-boss'),
  session(4, '1'),
  session(5, 'Claude Code'),
  session(6, 'personal'),
  session(7, null),
  session(8, 'fm-reader-fix-batch'),
];
const found = (text, sessions = SESSIONS, options = {}) => Array.from(refs.scan(text, refs.index(sessions, options))).map((f) => [text.slice(f.start, f.end), f.session.id]);

test('a tab label in a reply links to the conversation that pane runs, as the sentence reads on', () => {
  const text = 'TW China restore: this is the time-limited item. The worker is waiting in its tab, fm-2026-11-06-esim-listing-output-sync-run.';
  assert.deepEqual(found(text), [['fm-2026-11-06-esim-listing-output-sync-run', id(1)]]);
});

test('a role name is a tab label too, and several references in one text each link', () => {
  assert.deepEqual(found('Ask leader-esim, then tell big-boss and leader-esim again'), [['leader-esim', id(2)], ['big-boss', id(3)], ['leader-esim', id(2)]]);
});

test('text the reader does not list is left alone: no link that goes nowhere', () => {
  assert.deepEqual(found('The tab fm-no-such-tab-anywhere and leader-nip are not on the reader'), []);
  assert.deepEqual(found('nothing here at all'), []);
});

test('a label is a whole word: a longer name that holds it, or one it starts, is not a match', () => {
  assert.deepEqual(found('leader-esim-two and my-leader-esim and leader-esim_x'), []);
  assert.deepEqual(found('(leader-esim), "leader-esim"; leader-esim: leader-esim?'), [['leader-esim', id(2)], ['leader-esim', id(2)], ['leader-esim', id(2)], ['leader-esim', id(2)]]);
});

test('a path, a file name, an address or a handle that holds a label is not a reference', () => {
  assert.deepEqual(found('see /Users/x/leader-esim/notes.md and leader-esim/data'), []);
  assert.deepEqual(found('open leader-esim.md or leader-esim.log'), []);
  assert.deepEqual(found('mail a@leader-esim and #leader-esim and key=leader-esim'), []);
  assert.deepEqual(found('The tab is leader-esim. Next sentence.'), [['leader-esim', id(2)]]);
});

test('a label that reads like ordinary words is never linked: short ones, one word, one with a space', () => {
  assert.equal(refs.eligible('1'), false);
  assert.equal(refs.eligible('personal'), false);
  assert.equal(refs.eligible('Claude Code'), false);
  assert.equal(refs.eligible('a-b'), false);
  assert.equal(refs.eligible('big-boss'), true);
  assert.equal(refs.eligible('crew_1x'), true);
  assert.deepEqual(found('the personal tab, tab 1, and Claude Code'), []);
});

test('two conversations with one label: the one a pane runs now, then the one with the newest turn', () => {
  const two = [session(1, 'leader-esim'), session(2, 'leader-esim'), session(3, 'leader-esim')];
  const last = { [id(1)]: 100, [id(2)]: 300, [id(3)]: 200 };
  assert.deepEqual(found('leader-esim', two, { rank: (s) => [0, last[s.id]] }), [['leader-esim', id(2)]]);
  assert.deepEqual(found('leader-esim', two, { rank: (s) => [s.id === id(3) ? 1 : 0, last[s.id]] }), [['leader-esim', id(3)]]);
});

test('a reply that names its own conversation does not link to it', () => {
  assert.deepEqual(found('I am leader-esim and the other is big-boss', SESSIONS, { skip: [id(2)] }), [['big-boss', id(3)]]);
  const chain = [{ id: id(2), ids: [id(1), id(2)], pane: { label: 'leader-esim' } }];
  assert.deepEqual(found('leader-esim', chain, { skip: [id(1)] }), []);
});

test('a full session id links, and its first characters link only when the text says "session" or is the whole code span', () => {
  assert.deepEqual(found(`the log of ${id(8)} is open`), [[id(8), id(8)]]);
  assert.deepEqual(found('see session 88888888 for it'), [['88888888', id(8)]]);
  assert.deepEqual(found('see 88888888 for it'), []);
  assert.deepEqual(found('see session 99999999 for it'), []);
  const index = refs.index(SESSIONS);
  assert.equal(refs.whole('88888888', index).id, id(8));
  assert.equal(refs.whole('  leader-esim ', index).id, id(2));
  assert.equal(refs.whole('fm-reader-fix-batch --force', index), null);
  assert.equal(refs.whole('', index), null);
});

test('an id that two conversations share the start of is never guessed', () => {
  const two = [{ id: '12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ids: ['12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }, { id: '12345678-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ids: ['12345678-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] }];
  assert.equal(refs.whole('12345678', refs.index(two)), null);
  assert.equal(refs.whole('12345678-aaaa', refs.index(two)).id, two[0].id);
});

test('an older session of a conversation names that conversation', () => {
  const chain = [{ id: id(2), ids: [id(1), id(2)], pane: { label: 'leader-esim' } }];
  assert.deepEqual(found(`from ${id(1)}`, chain), [[id(1), id(2)]]);
});

test('an empty list, odd input and a page with no panes link nothing and do not throw', () => {
  assert.equal(refs.scan('leader-esim', refs.index([])).length, 0);
  assert.equal(refs.scan(null, refs.index(SESSIONS)).length, 0);
  assert.equal(refs.scan('leader-esim', null).length, 0);
  assert.equal(refs.index(undefined).any, false);
  assert.deepEqual(found('leader-esim', [session(7, null)]), []);
});

test('the signature changes when a label, an id or the conversation on screen changes, and not otherwise', () => {
  const a = refs.signature(refs.index(SESSIONS, { skip: [id(2)] }));
  assert.equal(a, refs.signature(refs.index(SESSIONS.slice(), { skip: [id(2)] })));
  assert.notEqual(a, refs.signature(refs.index(SESSIONS, { skip: [id(3)] })));
  assert.notEqual(a, refs.signature(refs.index([...SESSIONS, session(9, 'fm-brand-new-tab')], { skip: [id(2)] })));
  assert.notEqual(a, refs.signature(refs.index(SESSIONS.map((s) => (s.id === id(2) ? { ...s, pane: { label: 'leader-nip' } } : s)), { skip: [id(2)] })));
});

test('what a drawing reads is the references the replies make: a tab nobody names can be renamed or added without drawing anything again', () => {
  const replies = ['The worker waits in fm-2026-11-06-esim-listing-output-sync-run.', 'Nothing to link here.', 'Ask `big-boss`, or see session ' + id(8).slice(0, 8) + '.'];
  const read = (sessions) => refs.used(replies, refs.index(sessions, { skip: [id(2)] }));
  const a = read(SESSIONS);
  assert.deepEqual(JSON.parse(a).map((pair) => pair.split('>')[0]).sort(), [id(8).slice(0, 8), 'big-boss', 'fm-2026-11-06-esim-listing-output-sync-run']);
  assert.equal(a, read(SESSIONS.slice()), 'the same list reads the same');
  assert.equal(a, read(SESSIONS.map((s) => (s.id === id(6) ? { ...s, pane: { label: 'a-tab-named-later' } } : s))), 'a tab nobody names, renamed');
  assert.equal(a, read([...SESSIONS, session(9, 'fm-brand-new-tab')]), 'or added');
  assert.notEqual(a, read(SESSIONS.map((s) => (s.id === id(3) ? { ...s, pane: { label: 'leader-nip' } } : s))), 'the tab a reply names, renamed: the link is gone');
  assert.notEqual(a, read(SESSIONS.filter((s) => s.id !== id(1))), 'or closed');
  assert.equal(a, read([...SESSIONS, session(9, 'fm-2026-11-06-esim-listing-output-sync-run')]), 'a second tab with a name a reply uses, ranked no better, takes no link');
  assert.equal(refs.used(replies, refs.index([], {})), '[]', 'no list, no references');
  assert.equal(refs.used(undefined, refs.index(SESSIONS)), '[]');
});

test('the page reads the same context when it keeps the turns as when it draws them: both name the conversation, so its own name is never a link to itself', () => {
  const page = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const calls = page.match(/turnsContext\([^)]*\)/g).filter((call) => !call.startsWith('turnsContext(exs, documents'));
  assert.ok(calls.length >= 3, 'the kept-turns branch of renderReader, the drawing and turnsUnchanged');
  for (const call of calls) assert.ok(/, (?:session\.id|sid)\)$/.test(call), `${call} names the conversation (a context made without it differs from the one made with it, and the next build draws the conversation again)`);
  assert.ok(page.includes('const refsSignature = (sid, exs) => sessionRefs.used((exs || []).map(e => e.reply), refIndex(sid));'));
  assert.ok(page.includes('refsSignature(sid, exs)]);'), 'the context holds the references the replies make');
});
