'use strict';

// Tests for which search shows on which conversation (prototype/template.html: owns, followSearchSession). Run from the repo root:
//   node --test setup/transcript-reader/searchscope.test.js
// The page's own lines run on stand-ins for the browser. A search of "this conversation" belongs to that conversation; a search of "all
// conversations" crosses them and gives way to a conversation's own search. The browser run is e2e/search-scope-check.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const fnBody = (fn) => PAGE.slice(PAGE.indexOf('  function ' + fn + '('), PAGE.indexOf('\n  }\n', PAGE.indexOf('  function ' + fn + '(')) + 5);
const OWNS = PAGE.slice(PAGE.indexOf('  const owns = '), PAGE.indexOf('\n', PAGE.indexOf('  const owns = ')));

function world() {
  const calls = { cleared: 0, saved: 0 };
  const sessions = [{ id: 'a1', ids: ['a0', 'a1'] }, { id: 'b1' }, { id: 'c1' }];
  const context = {
    look: { open: false, q: '', scope: 'here', conv: null, own: new Map(), say: '', who: 'any', list: false, current: null, hits: [], terms: [], opened: [], timer: 0 },
    state: { view: 'reader', session: 0 },
    data: { sessions },
    clearHighlights: () => { calls.cleared += 1; },
    saveSearch: () => { calls.saved += 1; },
    clearTimeout: () => {}, Boolean, Object, Map,
  };
  vm.runInNewContext(OWNS + '\n' + fnBody('followSearchSession') + '\nthis.owns = owns; this.follow = followSearchSession;', context);
  const own = (conv, q, extra = {}) => Object.assign(context.look, { open: true, scope: 'here', conv, q, ...extra });
  const showing = (index) => { context.state.session = index; context.follow(); };
  return { context, look: context.look, calls, own, showing };
}

test('the page holds the lines under test', () => {
  assert.match(OWNS, /owns = \(conv, session\)/);
  assert.match(fnBody('followSearchSession'), /look\.own\.set\(look\.conv/);
});

test('a conversation answers to every id it has had, so a /clear keeps its search', () => {
  const w = world();
  assert.equal(w.context.owns('a0', w.context.data.sessions[0]), true);
  assert.equal(w.context.owns('a1', w.context.data.sessions[0]), true);
  assert.equal(w.context.owns('a1', w.context.data.sessions[1]), false);
  assert.equal(w.context.owns(null, w.context.data.sessions[1]), false);
});

test('a search of this conversation does not follow a switch to another conversation, and is there again when its own is shown', () => {
  const w = world();
  w.own('a1', 'refund', { current: 'u1:reply', list: true });
  w.showing(1);
  assert.equal(w.look.open, false, 'nothing of it on screen in another conversation');
  assert.equal(w.look.conv, null);
  assert.equal(w.calls.cleared, 1, 'its marks are taken off the page');
  assert.deepEqual([...w.look.own.keys()], ['a1'], 'it waits in its own conversation');
  w.showing(0);
  assert.equal(w.look.open, true);
  assert.equal(w.look.scope, 'here');
  assert.equal(w.look.conv, 'a1');
  assert.equal(w.look.q, 'refund');
  assert.equal(w.look.current, 'u1:reply');
  assert.equal(w.look.own.size, 0);
});

test('each conversation keeps a search of its own', () => {
  const w = world();
  w.own('a1', 'first');
  w.showing(1);
  w.own('b1', 'second');
  w.showing(2);
  assert.equal(w.look.open, false);
  assert.deepEqual([...w.look.own.keys()].sort(), ['a1', 'b1']);
  w.showing(0);
  assert.equal(w.look.q, 'first');
  w.showing(1);
  assert.equal(w.look.q, 'second');
});

test('a search of all conversations crosses a switch to a conversation with none, and gives way to one that has its own', () => {
  const w = world();
  w.own('a1', 'own of a');
  w.showing(1);
  Object.assign(w.look, { open: true, scope: 'all', conv: null, q: 'everywhere', list: true });
  w.showing(2);
  assert.equal(w.look.open && w.look.scope, 'all', 'it stays on for a conversation without a search of its own');
  assert.equal(w.look.q, 'everywhere');
  w.showing(0);
  assert.equal(w.look.scope, 'here', 'the conversation with its own search takes the screen');
  assert.equal(w.look.q, 'own of a');
  assert.equal(w.look.conv, 'a1');
  assert.equal(w.look.own.size, 0);
});

test('only the reader view shows a search: another view leaves every one where it is', () => {
  const w = world();
  w.own('a1', 'refund');
  w.context.state.view = 'doc';
  w.showing(1);
  assert.equal(w.look.q, 'refund');
  assert.equal(w.look.conv, 'a1');
});

test('the all-conversations chip is off, and says why, while this conversation has a search of its own (the page)', () => {
  assert.match(PAGE, /allChip\.setAttribute\("aria-disabled", String\(look\.scope === "here"\)\)/);
  assert.match(PAGE, /if \(scope === "all" && look\.open && look\.scope === "here"\) \{ sayAllOff\(\); return; \}/);
  assert.match(PAGE, /if \(b\.dataset\.scope === "all"\) \{ sayAllOff\(\); return; \}/);
  assert.match(PAGE, /Close it first to search all conversations\./);
});
