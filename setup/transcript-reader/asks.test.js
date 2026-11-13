'use strict';

// Tests for which asks wait on you (prototype/asks.js), the rule the yellow "Needs you" and the header's "N need you" both read.
// Run from the repo root: node --test setup/transcript-reader/asks.test.js
// The file runs in a bare sandbox. Every turn is a synthetic placeholder; build_prototype.mark_asks (test_parser.py) decides ask_state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'prototype', 'asks.js'), 'utf8');
const askRules = vm.runInNewContext(SOURCE + '\naskRules');
const ids = (turns) => turns.map((t) => t.id);

const turn = (id, verdict, ask_state) => ({ id, verdict, ...(ask_state ? { ask_state } : {}) });

test('only a reply that needs you has an ask state', () => {
  assert.equal(askRules.state(turn(1, 'no-action')), null);
  assert.equal(askRules.state(turn(2, 'none')), null);
  assert.equal(askRules.state(turn(3, 'needs-you', 'open')), 'open');
  assert.equal(askRules.state(turn(4, 'needs-you', 'quiet')), 'quiet');
  assert.equal(askRules.state(turn(5, 'needs-you', 'settled')), 'settled');
});

test('a copy built before ask_state existed reads every ask as open', () => {
  assert.equal(askRules.state(turn(1, 'needs-you')), 'open');
  assert.equal(askRules.isOpen(turn(1, 'needs-you')), true);
});

test('the header count is the open set and nothing else', () => {
  // The shape of a long leader conversation: many old asks, a few waiting, answered ones, replies that ask nothing.
  const turns = [];
  for (let i = 0; i < 143; i += 1) turns.push(turn(i, 'needs-you', i < 139 ? (i % 3 ? 'quiet' : 'settled') : 'open'));
  for (let i = 143; i < 200; i += 1) turns.push(turn(i, 'no-action'));
  assert.equal(askRules.count(turns), 4);
  assert.deepEqual(ids(askRules.open(turns)), [139, 140, 141, 142]);
  assert.equal(askRules.count(turns), turns.filter(askRules.isOpen).length, 'the count is the set the page marks yellow and the jump visits');
});

test('no asks, no count', () => {
  assert.equal(askRules.count([]), 0);
  assert.equal(askRules.count([turn(1, 'no-action'), turn(2, 'needs-you', 'quiet')]), 0);
});
