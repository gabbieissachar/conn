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

// ------------------------------------------------------------------------------------------------------ by task (a leader's conversation)

const HOME = '~/.treehouse/h/2/firstmate';
const leader = (tasks = {}) => ({ dir: HOME, tasks });
const session = (extra = {}) => ({ exchanges: [], ...extra });

test('mode: by task only for a leader, by folder for every other conversation whatever was chosen', () => {
  assert.equal(docfiles.mode(session({ leader: leader() }), null), 'task', 'a leader opens by task before anything is chosen');
  assert.equal(docfiles.mode(session({ leader: leader() }), 'task'), 'task');
  assert.equal(docfiles.mode(session({ leader: leader() }), 'folder'), 'folder', 'the choice is kept');
  assert.equal(docfiles.mode(session({ leader: leader() }), 'junk'), 'task', 'a value nobody wrote is no choice');
  assert.equal(docfiles.mode(session(), 'task'), 'folder', 'a worker has no tasks');
  assert.equal(docfiles.mode(session({ leader: {} }), 'task'), 'folder', 'a leader record with no home names nothing');
  assert.equal(docfiles.mode(null, 'task'), 'folder');
  assert.equal(docfiles.isLeader(session({ leader: leader() })), true);
  assert.equal(docfiles.isLeader(session()), false);
  assert.equal(docfiles.pref('folder'), 'folder');
  assert.equal(docfiles.pref(undefined), 'task');
});

test('taskOf and inside: the first folder under the home data folder is the task, and the folders below it are where the file is', () => {
  const l = leader();
  assert.equal(docfiles.taskOf(`${HOME}/data/reader-x`, l), 'reader-x');
  assert.equal(docfiles.taskOf(`${HOME}/data/reader-x/ship/img`, l), 'reader-x');
  assert.equal(docfiles.taskOf(`${HOME}/data`, l), null, 'a file directly in data/ is in no task');
  assert.equal(docfiles.taskOf(`${HOME}/projects/pmos`, l), null);
  assert.equal(docfiles.taskOf(`${HOME}/database/x`, l), null, 'a folder whose name only begins with data');
  assert.equal(docfiles.taskOf('~/.treehouse/h/3/firstmate/data/reader-x', l), null, 'another home is not this leader\'s');
  assert.equal(docfiles.taskOf(`${HOME}/data/reader-x`, null), null);
  assert.equal(docfiles.inside(`${HOME}/data/reader-x`, l), '');
  assert.equal(docfiles.inside(`${HOME}/data/reader-x/ship/img`, l), 'ship/img');
  assert.equal(docfiles.inside(`${HOME}/projects/pmos`, l), '');
});

test('task: the backlog row gives the title and state, and a folder with no row shows by its id', () => {
  const l = leader({ a: { title: 'Task A', state: 'In flight' }, b: { more: 3 } });
  assert.deepEqual(plain(docfiles.task('a', l)), { id: 'a', title: 'Task A', state: 'In flight', known: true, more: 0 });
  assert.deepEqual(plain(docfiles.task('b', l)), { id: 'b', title: 'b', state: '', known: false, more: 3 }, 'a record that only says it was cut is not a backlog row');
  assert.deepEqual(plain(docfiles.task('c', l)), { id: 'c', title: 'c', state: '', known: false, more: 0 });
  assert.deepEqual(plain(docfiles.task('d', leader())), { id: 'd', title: 'd', state: '', known: false, more: 0 });
});

test('taskGroups: files named or not, a task with no backlog row, files in no task, newest group first and Other files last', () => {
  const l = leader({ a: { title: 'Task A', state: 'In flight' }, old: { title: 'Old', state: 'Done' } });
  const { docs, entries } = world([
    ['a1.md', `${HOME}/data/a`, 10],                  // named, then changed
    ['a2.png', `${HOME}/data/a/shots`, 50, 'image'],   // never named: listed by its change time
    ['o1.md', `${HOME}/data/old`, 90],
    ['n1.md', `${HOME}/data/no-row`, 70],
    ['x1.md', `${HOME}/projects/pmos`, 99],            // named, in no task: newest of all, still last
    ['loose.md', `${HOME}/data`, 5],
  ]);
  const groups = docfiles.taskGroups(entries, docs, l);
  assert.deepEqual(Array.from(groups, (g) => g.key), ['old', 'no-row', 'a', docfiles.OTHER], 'newest first whatever the state; Other files last');
  assert.deepEqual(Array.from(groups, (g) => g.at), [90, 70, 50, 99]);
  assert.deepEqual(names(groups[2].files, docs), ['a2.png', 'a1.md'], 'newest first inside a task');
  assert.equal(groups[0].task.state, 'Done');
  assert.equal(groups[1].task.known, false, 'a missing backlog row keeps its folder as a task, titled by its id');
  assert.equal(groups[1].task.title, 'no-row');
  assert.deepEqual([groups[3].other, groups[3].task, names(groups[3].files, docs)], [true, null, ['x1.md', 'loose.md']]);
  assert.equal(groups.every((g) => g.single === false), true);
});

test('taskGroups: a conversation with no file in a task has only Other files, and no entry means no group', () => {
  const l = leader();
  const { docs, entries } = world([['x.md', '~/elsewhere', 1]]);
  assert.deepEqual(Array.from(docfiles.taskGroups(entries, docs, l), (g) => g.key), [docfiles.OTHER]);
  assert.deepEqual(plain(docfiles.taskGroups([], {}, l)), []);
});

test('taskGroups: two tasks with the same newest time keep a steady order', () => {
  const l = leader();
  const { docs, entries } = world([['a.md', `${HOME}/data/zz`, 5], ['b.md', `${HOME}/data/aa`, 5]]);
  assert.deepEqual(Array.from(docfiles.taskGroups(entries, docs, l), (g) => g.key), ['aa', 'zz']);
});

test('find by task: the words also match the task id and its title, with the folder and the name', () => {
  const l = leader({ 'reader-task-tags-design': { title: 'Brainstorm task tags with the captain', state: 'In flight' } });
  const { docs, entries } = world([
    ['brief.md', `${HOME}/data/reader-task-tags-design`, 10],
    ['brief.md', `${HOME}/data/other-task`, 20],
    ['notes.md', `${HOME}/data`, 30],
  ]);
  const extra = (d) => docfiles.taskText(d, l);
  assert.deepEqual(ids(docfiles.find(entries, docs, 'brainstorm brief', 'all', extra)), ['d0'], 'a word of the title');
  assert.deepEqual(ids(docfiles.find(entries, docs, 'tags-design', 'all', extra)), ['d0'], 'a word of the id');
  assert.deepEqual(ids(docfiles.find(entries, docs, 'brainstorm', 'all')), [], 'by folder, the title is not searched');
  assert.deepEqual(ids(docfiles.find(entries, docs, 'brief', 'all', extra)), ['d1', 'd0'], 'newest first');
  assert.equal(docfiles.taskText(docs.d2, l), '', 'a file in no task adds no words');
  assert.equal(docfiles.taskText(docs.d0, l), 'reader-task-tags-design Brainstorm task tags with the captain');
});

test('where: a match shows its task and the folder inside it, or its own folder when it is in none', () => {
  const l = leader({ a: { title: 'Task A', state: 'Done' } });
  assert.equal(docfiles.where({ dir: `${HOME}/data/a` }, l), 'a · Task A');
  assert.equal(docfiles.where({ dir: `${HOME}/data/a/ship` }, l), 'a · Task A · ship');
  assert.equal(docfiles.where({ dir: `${HOME}/data/b` }, l), 'b', 'no title to add when there is no row');
  assert.equal(docfiles.where({ dir: '~/x/y' }, l), '~/x/y');
});

test('opened: the newest task opens on a wide screen, and the task holding the open file when one was chosen', () => {
  const l = leader();
  const { docs, entries } = world([['a.md', `${HOME}/data/a`, 5], ['b.md', `${HOME}/data/b`, 9], ['c.md', `${HOME}/data/c`, 1]]);
  const groups = docfiles.taskGroups(entries, docs, l);
  assert.deepEqual(Array.from(docfiles.opened(groups, null, true)), ['b']);
  assert.deepEqual(Array.from(docfiles.opened(groups, null, false)), [], 'a phone starts with every task folded');
  assert.deepEqual(Array.from(docfiles.opened(groups, 'd2', false)), ['c']);
});
