'use strict';

// Tests for the page's session picker rules (prototype/picker.js). Run from the repo root:
//   node --test setup/transcript-reader/picker.test.js
// The file runs in a bare sandbox: its functions take the list and say which sessions run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const picker = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'picker.js'), 'utf8') + '\npicker', { Boolean });

const session = (id, label, extra = {}) => ({ id, pane: label === null ? null : { label, title: 'a title for ' + id }, ...extra });
const titled = (s) => `${s.pane ? s.pane.label : 'no pane'} · ${s.pane ? s.pane.title : s.id}`;
const ids = (entries) => entries.map(([s]) => s.id);

test('sections: a session no pane runs leaves the running part, keeping its index and the list order', () => {
  const list = [session('a', 'alpha'), session('b', 'beta'), session('c', 'gamma'), session('d', null)];
  const running = new Set(['a', 'c']);
  const { running: up, idle } = picker.sections(list, (s) => running.has(s.id));
  assert.deepEqual(ids(up), ['a', 'c']);
  assert.deepEqual(up.map(([, i]) => i), [0, 2]);
  assert.deepEqual(ids(idle), ['b', 'd']);
  assert.deepEqual(idle.map(([, i]) => i), [1, 3], 'a session never seen in a pane runs nowhere');
  assert.equal(JSON.stringify(picker.sections([], () => true)), '{"running":[],"idle":[]}');
});

test('label: a running session shows its Herdr label alone, whatever closed sessions share the label', () => {
  // leader-workspaceos runs as 6b2d; an older session of the same label stays listed, closed.
  const list = [session('6b2d', 'leader-workspaceos'), session('95b4', 'leader-workspaceos', { reopened: true }), session('x', 'other')];
  const live = (s) => s.id !== '95b4';
  const name = (s) => picker.label(s, list, live, titled);
  assert.equal(name(list[0]), 'leader-workspaceos');
  assert.equal(name(list[1]), 'leader-workspaceos', 'nor does the closed one need its title: it has no twin in its own part');
  assert.equal(name(list[2]), 'other');
});

test('label: two sessions of the same part with one label tell themselves apart by their titles', () => {
  const list = [session('a', 'esim-BC-49-PRD'), session('b', 'esim-BC-49-PRD'), session('c', 'esim-BC-49-PRD'), session('d', 'solo')];
  const live = (s) => s.id !== 'c';
  assert.equal(picker.label(list[0], list, live, titled), 'esim-BC-49-PRD · a title for a');
  assert.equal(picker.label(list[1], list, live, titled), 'esim-BC-49-PRD · a title for b');
  assert.equal(picker.label(list[2], list, live, titled), 'esim-BC-49-PRD', 'the one closed session has no twin among the closed');
  assert.equal(picker.label(list[3], list, live, titled), 'solo');
});

test('label: a session with no known pane has only its own name to go by', () => {
  const list = [session('a', null), session('b', 'beta')];
  assert.equal(picker.label(list[0], list, () => true, titled), 'no pane · a');
  assert.equal(picker.label(list[1], list, () => true, titled), 'beta');
});

test('pageTitle: the open conversation leads the tab title, with the name the picker shows', () => {
  const list = [session('a', 'leader-workspaceos'), session('b', 'dup'), session('c', 'dup')];
  const name = (s) => picker.label(s, list, () => true, titled);
  assert.equal(picker.pageTitle('reader', name(list[0])), 'leader-workspaceos · Reader');
  assert.equal(picker.pageTitle('reader', name(list[1])), 'dup · a title for b · Reader', 'twins keep the title the picker adds');
  assert.equal(picker.pageTitle('doc', name(list[0])), 'leader-workspaceos · Documents');
  assert.equal(picker.pageTitle('fleet', name(list[0])), 'Fleet timeline · Reader');
  assert.equal(picker.pageTitle('reader', null), 'Transcript reader', 'no conversation open');
  assert.equal(picker.pageTitle('doc', null), 'Transcript reader');
});

test('page: the template repaints the tab title where the picker names change', () => {
  const page = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const body = (fn) => page.slice(page.indexOf('function ' + fn + '('), page.indexOf('\n  }\n', page.indexOf('function ' + fn + '(')));
  assert.match(body('paintBar'), /paintTitle\(\)/, 'a switch, Follow Herdr or a view change draws the bar');
  assert.match(body('labelSessions'), /paintTitle\(\)/, 'a poll, a rebuild or a Sync relabels the sessions');
  assert.match(body('paintTitle'), /picker\.pageTitle\(state\.view, session \? pickerName\(session\) : null\)/);
});
