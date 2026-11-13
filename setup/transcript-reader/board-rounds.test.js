'use strict';

// The review rounds of the Tasks board (board-rounds.js): a small file of the reader's own, never a Firstmate home.
//   node --test setup/transcript-reader/board-rounds.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rounds = require('./board-rounds');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-rounds-'));
  let clock = 1700000000000;
  const file = path.join(dir, 'sub', 'board-rounds.json');
  return { file, tick: (s) => { clock += s * 1000; }, s: rounds.create({ file, now: () => clock }) };
}

test('rounds: no round before the first mark, and the first mark starts one', () => {
  const t = store();
  assert.equal(t.s.get('leader-a'), null);
  const got = t.s.mark('leader-a', 'alpha', 'seen');
  assert.equal(got.id, '1700000000');
  assert.deepEqual(got.reviewed, { alpha: { at: 1700000000, outcome: 'seen' } });
  t.tick(60);
  assert.deepEqual(t.s.mark('leader-a', 'beta', 'done').reviewed.beta, { at: 1700000060, outcome: 'done' });
  assert.equal(t.s.get('leader-a').id, '1700000000', 'a mark does not start another round');
  assert.equal(t.s.get('leader-b'), null, 'a round belongs to one board');
});

test('rounds: a new round forgets the marks, and a mark can be taken off', () => {
  const t = store();
  t.s.mark('leader-a', 'alpha', 'seen'); t.s.mark('leader-a', 'beta', 'queue');
  assert.deepEqual(Object.keys(t.s.unmark('leader-a', 'alpha').reviewed), ['beta']);
  t.tick(3600);
  const next = t.s.start('leader-a');
  assert.deepEqual(next, { id: '1700003600', started: 1700003600, reviewed: {} });
  assert.equal(t.s.unmark('leader-a', 'nothing-there').id, '1700003600');
  assert.equal(t.s.unmark('leader-z', 'alpha'), null);
});

test('rounds: only known outcomes and plain task references are kept, and a damaged file reads as no round', () => {
  const t = store();
  assert.equal(t.s.mark('leader-a', '../x', 'seen'), null);
  assert.equal(t.s.mark('leader-a', 'alpha', 'deleted'), null);
  assert.equal(t.s.get('leader-a'), null, 'a refused mark starts nothing');
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  fs.writeFileSync(t.file, '{ not json');
  assert.equal(t.s.get('leader-a'), null);
  fs.writeFileSync(t.file, JSON.stringify({ rounds: { 'leader-a': { id: '5', started: 5, reviewed: { good: { at: 6, outcome: 'seen' }, '../bad': { at: 6, outcome: 'seen' }, odd: { at: 'x', outcome: 'seen' }, worse: { at: 7, outcome: 'nope' } } } } }));
  assert.deepEqual(t.s.get('leader-a').reviewed, { good: { at: 6, outcome: 'seen' } });
});

test('rounds: the file is private to its owner and a task called "constructor" is an ordinary task', () => {
  const t = store();
  t.s.mark('leader-a', 'constructor', 'seen');
  assert.equal((fs.statSync(t.file).mode & 0o777), 0o600);
  assert.equal(t.s.get('leader-a').reviewed.constructor.outcome, 'seen');
  assert.equal(Object.keys(t.s.unmark('leader-a', 'constructor').reviewed).length, 0);
});

test('rounds: the file sits beside the board config unless PMOS_READER_BOARD_ROUNDS moves it', () => {
  assert.equal(rounds.roundsFile({ PMOS_READER_BOARD_ROUNDS: '/x/r.json' }), '/x/r.json');
  assert.equal(rounds.roundsFile({ PMOS_READER_BOARD_CONFIG: '/lab/conf/board.json' }), '/lab/conf/board-rounds.json');
});
