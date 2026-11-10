'use strict';

// Tests for copy-on-select's decision and clipboard paths. The browser wiring stays in
// template.html, while this small module is shared by the local and hosted/offline pages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'prototype', 'selectcopy.js'), 'utf8');
const api = vm.runInNewContext(`${source}\nreaderSelectCopy`, {});
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

test('decision: empty and whitespace-only selections are ignored', () => {
  same(api.decide({ text: '', eligible: true }), { copy: false, reason: 'empty' });
  same(api.decide({ text: ' \n\t', eligible: true }), { copy: false, reason: 'empty' });
  same(api.decide({ text: 'words', collapsed: true, eligible: true }), { copy: false, reason: 'empty' });
});

test('decision: editable fields and areas outside the reader are ignored', () => {
  same(api.decide({ text: 'draft', editable: true, eligible: true }), { copy: false, reason: 'editable' });
  same(api.decide({ text: 'header', eligible: false }), { copy: false, reason: 'outside' });
});

test('DOM boundaries: editable fields are skipped and reader areas are eligible', () => {
  const textarea = { nodeType: 1, closest: selector => selector.includes('textarea') ? textarea : null };
  const reply = { nodeType: 1, closest: selector => selector.includes('#main .reply') ? reply : null };
  assert.equal(api.isEditableTarget(textarea), true);
  assert.equal(api.copyArea(reply), reply);
});

test('decision: the same unchanged selection is copied once', () => {
  const first = api.decide({ text: 'same words', eligible: true, signature: 'node-a:1-node-a:11' });
  same(first, { copy: true, text: 'same words', signature: 'node-a:1-node-a:11' });
  same(api.decide({ text: 'same words', eligible: true, signature: first.signature }, first.signature), { copy: false, reason: 'repeat' });
  same(api.decide({ text: 'same words', eligible: true, signature: 'node-b:1-node-b:11' }, first.signature), { copy: true, text: 'same words', signature: 'node-b:1-node-b:11' });
});

test('clipboard: secure contexts use navigator.clipboard without the fallback', async () => {
  const calls = [];
  const result = await api.copy('line 1\nline 2', {
    isSecureContext: true,
    navigator: { clipboard: { writeText: text => { calls.push(text); return Promise.resolve(); } } },
    document: { execCommand: () => { throw new Error('fallback should not run'); } },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, ['line 1\nline 2']);
});

test('clipboard: plain HTTP uses the hidden textarea fallback synchronously', async () => {
  const calls = [];
  const parent = {
    children: [],
    appendChild(node) { this.children.push(node); },
    removeChild(node) { this.children = this.children.filter(child => child !== node); },
  };
  const document = {
    body: parent,
    createElement(tag) {
      assert.equal(tag, 'textarea');
      return {
        style: {},
        setAttribute(name, value) { this[name] = value; },
        select() { calls.push(['select', this.value]); },
        remove() { parent.removeChild(this); },
      };
    },
    execCommand(command) { calls.push(['execCommand', command]); return true; },
  };
  const result = await api.copy('keep\nline breaks', { isSecureContext: false, navigator: {}, document });
  assert.equal(result, true);
  assert.deepEqual(calls, [['select', 'keep\nline breaks'], ['execCommand', 'copy']]);
  assert.deepEqual(parent.children, []);
});

// ---- the delayed copy: a manual clock stands in for the timers
function clockLab({ delay, grace } = {}) {
  let time = 0, next = 1;
  const timers = new Map();
  const ran = [];
  const lab = api.deferred(job => ran.push(job), {
    delay, grace,
    now: () => time,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { at: time + ms, fn }); return id; },
    clearTimer: id => { timers.delete(id); },
  });
  const advance = ms => {
    const end = time + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    time = end;
  };
  return { lab, advance, ran, timers };
}

test('deferred: the copy runs once, 800 ms after the selection and not before', () => {
  const { lab, advance, ran } = clockLab();
  lab.arm({ text: 'a' });
  advance(799);
  assert.deepEqual(ran, []);
  assert.equal(lab.pending(), true);
  advance(1);
  assert.deepEqual(ran, [{ text: 'a' }]);
  assert.equal(lab.pending(), false);
  advance(5000);
  assert.equal(ran.length, 1);
});

test('deferred: a comment begun inside the wait drops the copy; nothing runs later', () => {
  const { lab, advance, ran, timers } = clockLab();
  lab.arm({ text: 'a' });
  advance(300);
  assert.equal(lab.cancel(), true);
  advance(5000);
  assert.deepEqual(ran, []);
  assert.equal(timers.size, 0);
  assert.equal(lab.cancel(), false);
});

test('deferred: a new selection replaces the one waiting and restarts the clock', () => {
  const { lab, advance, ran } = clockLab();
  lab.arm({ text: 'first' });
  advance(500);
  lab.arm({ text: 'second' });
  advance(500);
  assert.deepEqual(ran, []);
  advance(300);
  assert.deepEqual(ran, [{ text: 'second' }]);
});

test('deferred: the pointer on the button holds the copy, leaving restarts the whole wait, a click drops it', () => {
  const { lab, advance, ran } = clockLab();
  lab.arm({ text: 'a' });
  advance(400);
  assert.equal(lab.hold(), true);
  advance(10000);
  assert.deepEqual(ran, []);
  assert.equal(lab.release(), true);
  advance(799);
  assert.deepEqual(ran, []);
  advance(1);
  assert.deepEqual(ran, [{ text: 'a' }]);

  lab.arm({ text: 'b' });
  lab.hold();
  assert.equal(lab.cancel(), true);
  assert.equal(lab.release(), false);
  advance(10000);
  assert.equal(ran.length, 1);
});

test('deferred: soon() shortens the wait to a quarter second, never lengthens it, and not while held', () => {
  const { lab, advance, ran } = clockLab();
  lab.arm({ text: 'a' });
  advance(100);
  lab.soon();
  advance(249);
  assert.deepEqual(ran, []);
  advance(1);
  assert.deepEqual(ran, [{ text: 'a' }]);

  lab.arm({ text: 'b' });
  advance(700);          // 100 ms left: already under the grace
  lab.soon();
  advance(100);
  assert.deepEqual(ran, [{ text: 'a' }, { text: 'b' }]);

  lab.arm({ text: 'c' });
  lab.hold();
  assert.equal(lab.soon(), false);
  advance(10000);
  assert.equal(ran.length, 2);
  assert.equal(lab.soon(), false);
});

test('deferred: flush() copies at once and leaves nothing pending', () => {
  const { lab, advance, ran, timers } = clockLab();
  lab.arm({ text: 'a' });
  assert.equal(lab.flush(), true);
  assert.deepEqual(ran, [{ text: 'a' }]);
  assert.equal(timers.size, 0);
  advance(5000);
  assert.equal(ran.length, 1);
  assert.equal(lab.flush(), false);
});

test('deferred: with no job nothing happens', () => {
  const { lab, ran } = clockLab();
  assert.equal(lab.hold(), false);
  assert.equal(lab.release(), false);
  assert.equal(lab.soon(), false);
  assert.equal(lab.flush(), false);
  assert.deepEqual(ran, []);
});

test('deferred: the delay and grace can be set, and default to the real timers when none are given', async () => {
  const quick = clockLab({ delay: 50, grace: 10 });
  quick.lab.arm({ text: 'x' });
  quick.advance(49);
  assert.deepEqual(quick.ran, []);
  quick.advance(1);
  assert.equal(quick.ran.length, 1);

  const ran = [];
  const withTimers = vm.runInNewContext(`${source}\nreaderSelectCopy`, { setTimeout, clearTimeout, Date });
  const real = withTimers.deferred(job => ran.push(job), { delay: 20 });
  real.arm('real');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(ran, ['real']);
});
