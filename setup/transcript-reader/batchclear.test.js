'use strict';

// Tests for the message bar's "Clear all" on a batch of comments (prototype/template.html). Run from the repo root:
//   node --test setup/transcript-reader/batchclear.test.js
// The page's own lines run on stand-ins for the browser. Nothing is served or drawn here.
//
// The button used to ask with a native confirm(). A browser that does not show native dialogs (the Integrated Browser of VS Code answers
// them "no" at once) made the button do nothing at all, so the page now asks for itself: a first press arms it, a second removes the batch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const from = PAGE.indexOf('  // Clear all asks in the page');
const to = PAGE.indexOf('dock("batch-keep").addEventListener("click", disarmClear);', from);
const SOURCE = PAGE.slice(from, PAGE.indexOf('\n', to));

// The lines that make the button work, with stand-ins: a clock the test moves, the buttons' handlers, the batch store and the redraws.
function world({ held = false } = {}) {
  const timers = [];
  const handlers = {};
  const batches = { s1: ['one', 'two', 'three'], s2: ['four'] };
  const calls = { render: 0, draft: 0, confirm: 0 };
  const state = { session: { id: 's1' } };
  const context = {
    link: { clearing: null, hold: held ? { id: 'h' } : null, editing: { sid: 's1', index: 1 } },
    dock: (name) => ({ addEventListener: (event, fn) => { handlers[name] = fn; } }),
    dockSession: () => state.session,
    batchOf: (sid) => batches[sid] || [],
    saveBatch: (sid, items) => { if (items.length) batches[sid] = items; else delete batches[sid]; },
    saveDraft: () => { calls.draft += 1; },
    renderDock: () => { calls.render += 1; },
    confirm: () => { calls.confirm += 1; return false; },  // a browser that shows no dialog: the answer is no
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].live = false; },
  };
  vm.runInNewContext(SOURCE + '\nthis.clearArmed = clearArmed;', context);
  return {
    context, handlers, batches, calls, state, timers,
    press: () => handlers['batch-clear'](),
    keep: () => handlers['batch-keep'](),
    fire: () => { for (const timer of timers.filter((t) => t.live)) { timer.live = false; timer.fn(); } },
  };
}

test('the page asks for itself: no confirm() stands between the button and the batch', () => {
  assert.ok(SOURCE.length > 200, 'the lines were found');
  assert.doesNotMatch(SOURCE.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n'), /confirm\(/);
  // The page still shows the two buttons the lines above drive.
  assert.match(PAGE, /<button id="dock-batch-clear" type="button"[^>]*>Clear all<\/button><button id="dock-batch-keep" type="button"[^>]*hidden>Keep<\/button>/);
});

test('a first press only arms the button, and a second press removes the batch even where confirm() answers no', () => {
  const w = world();
  w.press();
  assert.deepEqual(w.batches.s1, ['one', 'two', 'three'], 'nothing is removed by one press');
  assert.equal(w.context.clearArmed('s1', 3), true);
  assert.equal(w.timers.length, 1);
  assert.ok(w.timers[0].ms >= 4000 && w.timers[0].ms <= 10000, 'the question stays up long enough to answer and does not linger');
  w.press();
  assert.equal(w.batches.s1, undefined, 'the second press removes every comment');
  assert.deepEqual(w.batches.s2, ['four'], 'another session\'s batch stays');
  assert.equal(w.context.link.editing, null);
  assert.equal(w.context.link.clearing, null);
  assert.equal(w.calls.draft, 1);
  assert.equal(w.calls.confirm, 0, 'no native dialog is asked for');
  assert.equal(w.timers[0].live, false, 'the question\'s timer is stopped');
});

test('Keep, and the question running out, put the button back with the batch as it was', () => {
  const w = world();
  w.press(); w.keep();
  assert.equal(w.context.clearArmed('s1', 3), false);
  assert.deepEqual(w.batches.s1, ['one', 'two', 'three']);
  w.press(); w.fire();
  assert.equal(w.context.clearArmed('s1', 3), false, 'unanswered, the question is withdrawn');
  w.press(); w.press();
  assert.equal(w.batches.s1, undefined, 'and a new first press asks again');
});

test('the question is about the batch it was asked of: a changed batch or another session is not removed by it', () => {
  const w = world();
  w.press();
  w.batches.s1 = ['one', 'two', 'three', 'four'];  // a comment was added while the question was up
  assert.equal(w.context.clearArmed('s1', 4), false);
  w.press();
  assert.deepEqual(w.batches.s1, ['one', 'two', 'three', 'four'], 'that press asks again about all four');
  w.press();
  assert.equal(w.batches.s1, undefined);
  const x = world();
  x.press();
  x.state.session = { id: 's2' };  // another conversation opened
  x.press();
  assert.deepEqual(x.batches.s2, ['four'], 'its batch is asked about afresh, not removed');
  assert.deepEqual(x.batches.s1, ['one', 'two', 'three']);
});

test('nothing happens with an empty batch or while a message is on its way', () => {
  const idle = world();
  idle.state.session = { id: 'none' };
  idle.press();
  assert.equal(idle.timers.length, 0);
  const sending = world({ held: true });
  sending.press();
  assert.equal(sending.timers.length, 0, 'a message held for Undo keeps the batch');
  assert.deepEqual(sending.batches.s1, ['one', 'two', 'three']);
});
