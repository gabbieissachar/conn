'use strict';

// Tests for how the Documents tab lists a conversation's files (prototype/docfiles.js). Run from the repo root:
//   node --test setup/transcript-reader/docfiles.test.js
// The file runs in a bare sandbox: its functions take the entries (as sessionDocuments gives them) and data.documents.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const docfiles = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'docfiles.js'), 'utf8') + '\ndocfiles', { String, Map, Set, Math });

// Entries come oldest-named first; each document has a name, a folder and a kind (markdown has none).
const world = (specs) => {
  const docs = {};
  const entries = specs.map(([name, dir, at, kind], i) => {
    const id = `d${i}`;
    docs[id] = { id, name, dir, ...(kind ? { kind } : {}) };
    return { id, at, index: i };
  });
  return { docs, entries };
};
// What the sandbox builds has the sandbox's own Object and Array, which deepEqual tells from this file's.
const plain = (value) => JSON.parse(JSON.stringify(value));
const names = (list, docs) => Array.from(list, (e) => docs[e.id].name);
const ids = (list) => Array.from(list, (e) => e.id);

test('title: a folder is named by its own last part, and a bland one keeps its parent', () => {
  assert.equal(docfiles.title('~/workspace/pmos/handoffs'), 'pmos/handoffs');
  assert.equal(docfiles.title('~/workspace/pmos/release-1-screens'), 'release-1-screens');
  assert.equal(docfiles.title('~/context'), 'context', 'nothing above it to add');
  assert.equal(docfiles.title('~'), '~');
  assert.equal(docfiles.title('~/.'), '~', 'a file directly in the home folder is shown as ~/.');
  assert.equal(docfiles.title('/tmp/sketches'), 'sketches');
  assert.equal(docfiles.title('/'), '/');
});

test('above and tail: the part of the path that is not the title, clipped from the left', () => {
  assert.equal(docfiles.above('~/workspace/pmos/handoffs', 40), '~/workspace');
  assert.equal(docfiles.above('~/workspace/pmos/release-1-screens', 40), '~/workspace/pmos');
  assert.equal(docfiles.above('/tmp/a/b', 40), '/tmp/a');
  assert.equal(docfiles.above('~/aaaa/bbbb/cccc/dddd/eeee', 12), '…b/cccc/dddd', 'the end is kept, with an ellipsis where it was cut');
  assert.equal(docfiles.above('~/.treehouse/firstmate-8bf1b0/2/firstmate/data/x', 60), '~/…/firstmate/data', 'a worktree prefix is shortened');
  assert.equal(docfiles.tail('~/.treehouse/firstmate-8bf1b0/2/firstmate/data/x', 60), '~/…/firstmate/data/x');
  assert.equal(docfiles.tail('~/a/b', 44), '~/a/b');
  assert.equal(docfiles.tail('~/aaaa/bbbb/cccc', 8).length, 8);
  assert.ok(docfiles.tail('~/aaaa/bbbb/cccc', 8).startsWith('…'));
});

test('groups: a folder with two files is a group, newest first; lone files share one last group', () => {
  const { docs, entries } = world([
    ['a.md', '~/x/alpha', 10],
    ['b.md', '~/x/beta', 20],
    ['c.md', '~/x/alpha', 30],
    ['d.md', '~/x/gamma', 40],
    ['e.md', '~/x/beta', 50],
    ['f.md', '~/x/beta', 15],
  ]);
  const groups = docfiles.groups(entries, docs);
  assert.deepEqual(Array.from(groups, (g) => g.key), ['~/x/beta', '~/x/alpha', docfiles.SINGLE], 'newest group first, the single files last');
  assert.deepEqual(names(groups[0].files, docs), ['e.md', 'b.md', 'f.md'], 'each group newest named first');
  assert.deepEqual(names(groups[1].files, docs), ['c.md', 'a.md']);
  assert.deepEqual(names(groups[2].files, docs), ['d.md']);
  assert.equal(groups[0].at, 50);
  assert.equal(groups[2].single, true);
  assert.equal(groups[0].single, false);
  assert.equal(groups[2].dir, null);
});

test('groups: every file appears once, and a conversation of lone files is one group', () => {
  const { docs, entries } = world([['a.md', '~/p'], ['b.md', '~/q'], ['c.md', '~/r']].map((x, i) => [...x, i]));
  const groups = docfiles.groups(entries, docs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].single, true);
  assert.deepEqual(names(groups[0].files, docs), ['c.md', 'b.md', 'a.md']);
  assert.deepEqual(plain(docfiles.groups([], {})), []);
});

test('groups: files named at the same time keep the later-named first, and a missing time counts as the oldest', () => {
  const { docs, entries } = world([['a.md', '~/x', 5], ['b.md', '~/x', 5], ['c.md', '~/x', undefined]]);
  const [g] = docfiles.groups(entries, docs);
  assert.deepEqual(names(g.files, docs), ['b.md', 'a.md', 'c.md']);
});

test('opened: the newest folder on a wide screen, none on a phone, and always the folder of a file just opened', () => {
  const { docs, entries } = world([['a.md', '~/x/alpha', 10], ['b.md', '~/x/alpha', 20], ['c.md', '~/x/beta', 30], ['d.md', '~/x/beta', 40], ['e.md', '~/x/gamma', 5]]);
  const groups = docfiles.groups(entries, docs);
  assert.deepEqual([...docfiles.opened(groups, null, true)], ['~/x/beta']);
  assert.deepEqual([...docfiles.opened(groups, null, false)], [], 'a phone starts folded, so the first screen is the whole set');
  assert.deepEqual([...docfiles.opened(groups, 'd1', false)], ['~/x/alpha']);
  assert.deepEqual([...docfiles.opened(groups, 'd4', true)].sort(), ['~/x/beta', docfiles.SINGLE].sort(), 'a lone file opens the group of lone files');
  assert.deepEqual([...docfiles.opened(groups, 'nope', true)], ['~/x/beta'], 'a file the list does not hold opens nothing more');
  assert.deepEqual([...docfiles.opened([], null, true)], []);
});

test('narrowing: a word or a type, not an empty query or All', () => {
  assert.equal(docfiles.narrowing('', 'all'), false);
  assert.equal(docfiles.narrowing('   ', 'all'), false);
  assert.equal(docfiles.narrowing(undefined, undefined), false);
  assert.equal(docfiles.narrowing('prd', 'all'), true);
  assert.equal(docfiles.narrowing('', 'image'), true);
});

test('counts and kindOf: markdown unless the document says html or image', () => {
  const { docs, entries } = world([['a.md', '~/x', 1], ['b.html', '~/x', 2, 'html'], ['c.png', '~/x', 3, 'image'], ['d.png', '~/x', 4, 'image'], ['e.md', '~/x', 5, 'md']]);
  assert.deepEqual(plain(docfiles.counts(entries, docs)), { all: 5, md: 2, html: 1, image: 2 });
  assert.equal(docfiles.kindOf(docs.d0), 'md');
  assert.equal(docfiles.kindOf(docs.d1), 'html');
  assert.deepEqual(plain(docfiles.counts([], {})), { all: 0, md: 0, html: 0, image: 0 });
});

test('find: every word in the name or the folder, any order, any case, newest first; a type narrows it', () => {
  const { docs, entries } = world([
    ['report.md', '~/esim/context', 10],
    ['report.md', '~/esim/reviews', 20],
    ['mock.png', '~/esim/screens', 30, 'image'],
    ['PRD.md', '~/esim/context', 40],
    ['index.html', '~/esim/screens', 50, 'html'],
  ]);
  assert.deepEqual(ids(docfiles.find(entries, docs, 'report', 'all')), ['d1', 'd0'], 'newest first');
  assert.deepEqual(ids(docfiles.find(entries, docs, 'context prd', 'all')), ['d3'], 'a word may be in the folder, in any order');
  assert.deepEqual(ids(docfiles.find(entries, docs, 'SCREENS', 'all')), ['d4', 'd2']);
  assert.deepEqual(ids(docfiles.find(entries, docs, '', 'image')), ['d2'], 'a type alone lists its files');
  assert.deepEqual(ids(docfiles.find(entries, docs, 'screens', 'html')), ['d4']);
  assert.deepEqual(plain(docfiles.find(entries, docs, 'report zzz', 'all')), []);
  assert.equal(docfiles.find(entries, docs, '', 'all').length, 5, 'no words and no type is everything');
});

test('marks: where the words are, merged, in order, over the original letters', () => {
  assert.deepEqual(plain(docfiles.marks('Release-1 PRD.md', 'prd')), [[10, 13]]);
  assert.deepEqual(plain(docfiles.marks('abcabc', 'abc')), [[0, 6]], 'touching hits are one mark');
  assert.deepEqual(plain(docfiles.marks('release notes', 'notes release')), [[0, 7], [8, 13]]);
  assert.deepEqual(plain(docfiles.marks('aaaa', 'aa aaa')), [[0, 4]], 'overlapping hits are one mark');
  assert.deepEqual(plain(docfiles.marks('nothing here', 'zzz')), []);
  assert.deepEqual(plain(docfiles.marks('anything', '')), []);
  assert.deepEqual(plain(docfiles.marks('İstanbul.md', 'md')), [], 'a letter that lowers to two characters moves the offsets: no marks rather than wrong ones');
});
