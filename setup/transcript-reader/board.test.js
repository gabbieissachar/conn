'use strict';

// Tests for the Tasks board's server side (board.js): caching, stale-while-revalidate, one build at a time and plain failures.
// board_cli.py is faked here; its own behaviour is tested in board/tests (python3 -I -m unittest discover -s setup/transcript-reader/board/tests).
//   node --test setup/transcript-reader/board.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const boardLib = require('./board');

const ROOT = '/repo';
const SCRIPT = path.join(ROOT, 'setup', 'transcript-reader', 'board_cli.py');

function fixture({ ttlMs = 1000, fail = null } = {}) {
  let clock = 1000;
  const state = { fail };
  const calls = [];
  const gates = [];
  const run = (file, args, options) => {
    calls.push({ file, args, env: options.env, timeout: options.timeout });
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (state.fail) { const error = new Error('exit'); error.code = state.fail; reject(error); return; }
        resolve(JSON.stringify({ schema: 'task-board.v1', session: { id: args[args.length - 1] }, built: calls.length }));
      };
      if (gates.hold) gates.push(finish); else finish();
    });
  };
  const b = boardLib.create({ root: ROOT, env: { PMOS_READER_BOARD: '1', KEEP: 'yes' }, run, now: () => clock, ttlMs });
  return { b, calls, gates, state, tick: (ms) => { clock += ms; }, release: () => gates.splice(0).forEach((f) => f()) };
}

test('the flag: off unless PMOS_READER_BOARD=1 or enabled is passed', () => {
  assert.equal(boardLib.create({ root: ROOT, env: {} }).enabled, false);
  assert.equal(boardLib.create({ root: ROOT, env: { PMOS_READER_BOARD: '1' } }).enabled, true);
  assert.equal(boardLib.create({ root: ROOT, env: {}, enabled: true }).enabled, true);
});

test('a board is built by board_cli.py in isolated mode and kept for the ttl', async () => {
  const t = fixture();
  const first = await t.b.board('leader-esim');
  assert.deepEqual(t.calls[0].args, ['-I', SCRIPT, 'board', '--session', 'leader-esim']);
  assert.equal(t.calls[0].file, 'python3');
  assert.equal(t.calls[0].env.KEEP, 'yes');
  assert.ok(t.calls[0].timeout > 0);
  assert.equal(first.stale, false);
  assert.equal(first.board.built, 1);
  t.tick(500);
  const again = await t.b.board('leader-esim');
  assert.equal(t.calls.length, 1, 'served from memory');
  assert.equal(again.board.built, 1);
  assert.equal(again.stale, false);
});

test('an expired answer is sent at once as stale while a new one builds behind it', async () => {
  const t = fixture();
  await t.b.board('big-boss');
  t.tick(2000);
  const stale = await t.b.board('big-boss');
  assert.equal(stale.stale, true);
  assert.equal(stale.board.built, 1);
  assert.equal(t.calls.length, 2, 'the rebuild started');
  await new Promise((resolve) => setImmediate(resolve));
  const fresh = await t.b.board('big-boss');
  assert.equal(fresh.board.built, 2);
  assert.equal(fresh.stale, false);
});

test('fresh waits for a new build, and two requests share one build', async () => {
  const t = fixture();
  await t.b.board('leader-nip');
  t.gates.hold = true;
  const one = t.b.board('leader-nip', { fresh: true });
  const two = t.b.board('leader-nip', { fresh: true });
  assert.equal(t.calls.length, 2, 'one build for both');
  t.release();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.board.built, 2);
  assert.equal(b.board.built, 2);
});

test('sessions are cached apart', async () => {
  const t = fixture();
  await t.b.board('a');
  await t.b.board('b');
  assert.equal(t.calls.length, 2);
});

test('a session id that is not a plain slug is refused before anything runs', async () => {
  const t = fixture();
  for (const bad of ['', null, '../x', 'a b', 'x'.repeat(65), 'a;b']) {
    await assert.rejects(() => t.b.board(bad), (error) => error.status === 400 && error.code === 'bad_request');
  }
  assert.equal(t.calls.length, 0);
});

test('exit code 2 is "no board for that session" and any other failure is a plain 502 that is not cached', async () => {
  let t = fixture({ fail: 2 });
  await assert.rejects(() => t.b.board('nope'), (error) => error.status === 404 && error.code === 'not_found');
  t = fixture({ fail: 1 });
  await assert.rejects(() => t.b.board('x'), (error) => error.status === 502 && error.code === 'board_failed');
  await assert.rejects(() => t.b.board('x'), (error) => error.status === 502);
  assert.equal(t.calls.length, 2, 'a failure is tried again');
});

test('a background rebuild that fails leaves the stale answer and raises nothing', async () => {
  const t = fixture();
  await t.b.board('s');
  t.tick(5000);
  t.state.fail = 1;
  const stale = await t.b.board('s');
  assert.equal(stale.stale, true);
  assert.equal(stale.board.built, 1);
  await new Promise((resolve) => setImmediate(resolve));
  const again = await t.b.board('s');  // the failed build left the old answer in place and is tried again
  assert.equal(again.stale, true);
  assert.equal(t.calls.length, 3);
});

test('sessions come from board_cli.py sessions', async () => {
  const t = fixture();
  const out = await t.b.sessions();
  assert.deepEqual(t.calls[0].args, ['-I', SCRIPT, 'sessions']);
  assert.equal(out.schema, 'task-board.v1');
});
