'use strict';

// Tests for the page's tool-step rules (prototype/steps.js). Run from the repo root:
//   node --test setup/transcript-reader/steps.test.js
// The file runs in a bare sandbox: its functions take a turn's steps and say what the page draws. Every step is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const steps = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'steps.js'), 'utf8') + '\nstepsView', { Set, Array, Math, Number, String });
const plain = (value) => JSON.parse(JSON.stringify(value));

const step = (extra) => ({ k: 'ran', n: 'Bash', s: 'List the repo', at: 1000, o: 0, ...extra });
const turn = (list, narration = []) => ({ uid: 'u1', steps: list, narration });

test('the summary row counts the steps, the files edited or written once each, and the failures', () => {
  const ex = turn([step(), step({ k: 'read', p: '/r/a.md' }), step({ k: 'edited', p: '/r/a.py' }), step({ k: 'edited', p: '/r/a.py' }), step({ k: 'wrote', p: '/r/b.py' }), step({ f: 1 })]);
  const s = steps.summary(ex);
  assert.equal(s.text, '6 steps · edited 2 files · 1 failed');
  assert.deepEqual(plain(s.parts), ['6 steps', 'edited 2 files']);
  assert.equal(s.failedText, '1 failed');
  assert.equal(steps.summary(turn([step()])).text, '1 step');
  assert.equal(steps.summary(turn([step({ k: 'edited', p: '/r/a' })])).text, '1 step · edited 1 file');
  assert.equal(steps.summary({ uid: 'x' }).text, '0 steps', 'a turn from an older copy has no steps to count');
});

test('steps group by runs of consecutive calls, with the working notes between the runs', () => {
  const ex = turn([step({ o: 1 }), step({ o: 1 }), step({ o: 2 }), step({ o: 2 }), step({ o: 2 }), step({ o: 3 })], ['first note', 'second note', 'third note']);
  assert.deepEqual(plain(steps.plan(ex)), [
    { type: 'note', text: 'first note', at: 0 }, { type: 'group', steps: [0, 1] },
    { type: 'note', text: 'second note', at: 1 }, { type: 'group', steps: [2, 3, 4] },
    { type: 'note', text: 'third note', at: 2 }, { type: 'group', steps: [5] },
  ]);
  // Two notes in a row come before the same run; a step with no `o` (an older object) sits in the first run.
  assert.deepEqual(plain(steps.plan(turn([step({ o: 2 }), step({ o: undefined })], ['a', 'b']))), [
    { type: 'note', text: 'a', at: 0 }, { type: 'note', text: 'b', at: 1 }, { type: 'group', steps: [0, 1] },
  ]);
  // A note left over after the last step still comes out, at the end.
  assert.deepEqual(plain(steps.plan(turn([step({ o: 0 })], ['late']))).map((b) => b.type), ['group', 'note']);
  assert.deepEqual(plain(steps.plan({ uid: 'u', narration: [] })), []);
});

test('a turn shows its first 10 steps, then "N more", with the notes only where a step they lead to is shown', () => {
  const many = Array.from({ length: 76 }, (_, i) => step({ o: i < 4 ? 1 : i < 12 ? 2 : 3 }));
  const blocks = steps.plan(turn(many, ['n1', 'n2', 'n3']));
  const shown = steps.visible(blocks);
  assert.equal(shown.shown, 10);
  assert.equal(shown.hidden, 66);
  assert.deepEqual(plain(shown.blocks.map((b) => b.type === 'note' ? b.text : b.steps.length)), ['n1', 4, 'n2', 6], 'the third note leads to hidden steps, so it waits');
  const all = steps.visible(blocks, Infinity);
  assert.equal(all.hidden, 0);
  assert.equal(all.blocks.length, blocks.length);
  assert.equal(steps.visible(steps.plan(turn([step(), step()]))).hidden, 0);
  assert.equal(steps.visible([]).shown, 0);
});

test('a diff reads as rows: added, removed, kept and a gap', () => {
  const rows = steps.diffRows('~\n line 3\n-old\n+new\n+newer\n~');
  assert.deepEqual(plain(rows), [
    { type: 'gap', text: '' }, { type: 'ctx', text: 'line 3' }, { type: 'del', text: 'old' }, { type: 'add', text: 'new' }, { type: 'add', text: 'newer' }, { type: 'gap', text: '' },
  ]);
  const long = steps.clipRows(Array.from({ length: 30 }, () => ({ type: 'add', text: 'x' })));
  assert.equal(long.rows.length, 12);
  assert.equal(long.hidden, 18);
  assert.equal(steps.clipRows(rows).hidden, 0);
  assert.equal(steps.counts({ a: 3, r: 1 }), '+3 −1');
  assert.equal(steps.counts({ a: 2 }), '+2 −0');
  assert.equal(steps.counts({}), '');
});

test('an output shows its last lines, and says how many there are', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n\n';
  const t = steps.tail(text);
  assert.equal(t.total, 40);
  assert.equal(t.hidden, 28);
  assert.equal(t.text.split('\n')[0], 'line 29');
  assert.equal(t.text.split('\n').pop(), 'line 40');
  assert.deepEqual(plain(steps.tail('one\ntwo')), { text: 'one\ntwo', total: 2, hidden: 0 });
  assert.deepEqual(plain(steps.tail('')), { text: '', total: 1, hidden: 0 });
});

test('where a step\'s output comes from: the laptop\'s page always asks, the sealed copy only inside its 7 days', () => {
  const from = steps.windowFrom(1_000_000);
  assert.equal(from, 1_000_000 - 7 * 86400);
  const recent = step({ l: 5, at: from + 10 }), old = step({ l: 5, at: from - 10 });
  assert.equal(steps.outputPlan(recent, { sealed: true, from }).kind, 'fetch');
  assert.equal(steps.outputPlan(old, { sealed: true, from }).kind, 'offer');
  assert.match(steps.outputPlan(old, { sealed: true, from }).note, /last 7 days/);
  assert.equal(steps.outputPlan(old, { sealed: false, from }).kind, 'fetch', 'the laptop\'s own page has every output');
  assert.equal(steps.outputPlan(old, { sealed: true, from, loaded: true }).kind, 'show', 'downloaded: read it');
  assert.equal(steps.outputPlan(step({ at: 5 }), { sealed: true, from }).kind, 'none', 'a step with no output recorded has nothing to fetch');
  const kept = steps.outputPlan(step({ k: 'read', l: 120 }), { sealed: false });
  assert.equal(kept.kind, 'kept');
  assert.match(kept.note, /120 lines read/);
  assert.match(steps.outputPlan(step({ h: 1, l: 3 }), { sealed: false }).note, /dotfile or a credential path/);
  assert.equal(steps.outputPlan(step({ l: 3, at: 5 }), { sealed: true, from: 0 }).kind, 'fetch', 'no window known: ask');
});

test('failed steps are listed, and a search reads a step\'s summary, file and the start of its command', () => {
  const ex = turn([step(), step({ f: 1 }), step(), step({ f: 1 })]);
  assert.deepEqual(plain(steps.failedAt(ex)), [1, 3]);
  const s = step({ s: 'Run the tests', p: '/repo/tests/a.py', c: 'pytest ' + 'x'.repeat(200) });
  const text = steps.searchText(s);
  assert.ok(text.startsWith('Run the tests /repo/tests/a.py pytest '));
  assert.equal(text.length, 'Run the tests /repo/tests/a.py '.length + 100);
  assert.equal(steps.searchText(step({ s: 'Only a summary' })), 'Only a summary');
});

test('a step is named by its turn and place, which is how its output is found', () => {
  assert.equal(steps.key({ uid: 'abc' }, 3), 'abc:3');
  assert.equal(steps.plural(1, 'file'), '1 file');
  assert.equal(steps.plural(0, 'file'), '0 files');
});

// The page's own markup, read as text as picker.test.js does: the rows a finger taps are 44 px where the screen is a phone's or a touch one.
const PAGE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');

test('page: step rows, the "N more" button and the summary row are 44 px on a phone width and on a touch screen', () => {
  const rule = (PAGE.match(/@media \(max-width: 440px\), \(pointer: coarse\) \{ \.steps-row, \.steps-more \{ min-height: 44px; \} \.step \{ min-height: 44px; \} \}/) || [])[0];
  assert.ok(rule, 'the 44 px rule for the rows');
  assert.match(PAGE, /\.step-head button, \.step-foot button, \.step-sheet \.step-copy, \.step-sec \.btn \{ min-height: 44px; min-width: 44px; \}/, 'and for the sheet\'s buttons');
});

test('page: a failed step is marked in words as well as colour, and the row says "failed" in its own part of the summary', () => {
  assert.match(PAGE, /if \(step\.f\) row\.append\(\$\("span", "bad", "failed"\)\)/);
  assert.match(PAGE, /if \(sum\.failed\) what\.append\(document\.createTextNode\(" \\u00b7 "\), \$\("span", "steps-failed", sum\.failedText\)\)/);
});

test('page: the sheet\'s copy button does not use the class of the code blocks\' copy button, which sits over the corner of its box', () => {
  assert.match(PAGE, /\$\("button", "step-copy", "Copy"\)/);
  assert.doesNotMatch(PAGE, /\$\("button", "copy", "Copy"\)/);
});

test('page: a search marks the step rows that hold its words, since a command or file is not drawn on the row, and clears them when it closes', () => {
  assert.match(PAGE, /function markFoundSteps\(\)/);
  assert.match(PAGE, /function clearHighlights\(\) \{\s*markFoundSteps\(\);/, 'closing the search clears the marks (look.open is false by then)');
  assert.match(PAGE, /look\.ranges = now;\s*markFoundSteps\(\);/, 'and every repaint of the highlights marks them');
  assert.match(PAGE, /\.step\.found \{/);
});

test('page: a failed ask for output is asked again the next time a sheet opens, and a failed download says so with a way to try again', () => {
  assert.match(PAGE, /if \(asked && asked\.state === "failed"\) asked\.state = "idle";/);
  assert.match(PAGE, /else if \(entry\.state === "failed"\) outBox\.push\(\$\("p", "step-note", failureText\(entry\)\), downloadButton\(session, "Try again"\)\);/);
  assert.match(PAGE, /hosted\.steps\(session, asked \? \{ probe: true \} : undefined\)/, 'the person\'s own download tries the laptop at once');
});
