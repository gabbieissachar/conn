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
  for (const bad of ['', null, '../x', 'a b', 'x'.repeat(129), 'a;b']) {
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

// ---- the writes (marks, answers), the workers' switch and the page's own source

function writeFixture({ marks = false, answer = false, reply = { ok: true, mark: { turn: 't' } } } = {}) {
  const runs = [];
  const inputs = [];
  const run = async (file, args) => { runs.push(args.slice(1)); return JSON.stringify(args.includes('worker-switch') ? { ok: true, leader: 'leader-esim', task: 'w', enabled: true } : { schema: 'task-board.v1', built: runs.length }); };
  const runInput = async (file, args, options, input) => { inputs.push({ args: args.slice(1), input, env: options.env, timeout: options.timeout }); return JSON.stringify(reply); };
  const b = boardLib.create({ root: ROOT, env: { PMOS_READER_BOARD: '1' }, run, runInput, now: () => 1000, ttlMs: 1000, marks, answer });
  return { b, runs, inputs };
}

test('writes: both are off unless their own flag is on, and off they run nothing', async () => {
  assert.deepEqual(boardLib.create({ root: ROOT, env: {} }).write, { marks: false, answer: false });
  assert.deepEqual(boardLib.create({ root: ROOT, env: { PMOS_READER_BOARD_MARKS: '1' } }).write, { marks: true, answer: false });
  assert.deepEqual(boardLib.create({ root: ROOT, env: { PMOS_READER_BOARD_ANSWER: '1' } }).write, { marks: false, answer: true });
  const t = writeFixture();
  await assert.rejects(() => t.b.mark('leader-esim', { task: 'a', turn: 't', mark: 'in' }), (e) => e.status === 404 && e.code === 'not_found');
  await assert.rejects(() => t.b.answer('leader-esim', { task: 'a', call: 'Z1', src: 'ask' }), (e) => e.status === 404);
  assert.equal(t.inputs.length, 0);
});

test('writes: the body goes to board_cli.py on stdin (never an argument), and the home\'s boards are marked stale after', async () => {
  const t = writeFixture({ marks: true });
  await t.b.board('leader-esim');
  t.runs.length = 0;
  const done = await t.b.mark('leader-esim', { task: 'alpha', turn: 'abcd1234:ef567890:reply', mark: 'out', source: 'card' });
  assert.equal(done.ok, true);
  assert.deepEqual(t.inputs[0].args.slice(0, 4), [t.inputs[0].args[0], 'mark', '--session', 'leader-esim']);
  assert.deepEqual(JSON.parse(t.inputs[0].input), { task: 'alpha', turn: 'abcd1234:ef567890:reply', mark: 'out', source: 'card' });
  assert.equal(t.inputs[0].args.join(' ').includes('abcd1234'), false, 'the turn is not in the process list');
  assert.ok(t.inputs[0].timeout > 0);
  const after = await t.b.board('leader-esim');
  assert.equal(after.stale, true, 'the next read sends the old board and builds a new one behind it');
});

test('writes: Firstmate\'s own refusal reaches the page as its status and sentence, and a bad session never runs', async () => {
  const t = writeFixture({ answer: true, reply: { ok: false, status: 409, message: 'That card is no longer open for this task.' } });
  await assert.rejects(() => t.b.answer('leader-esim', { task: 'a', call: 'Z1', src: 'ask', option: 'a' }), (e) => e.status === 409 && e.code === 'refused' && /no longer open/.test(e.message));
  await assert.rejects(() => t.b.answer('../x', {}), (e) => e.status === 400);
  assert.equal(t.inputs.length, 1);
});

test('workers: the switch runs worker-switch with the leader, the task and the state', async () => {
  const t = writeFixture();
  const done = await t.b.workerSwitch({ leader: 'leader-esim', task: 'w', enabled: true });
  assert.equal(done.ok, true);
  assert.deepEqual(t.runs[0].slice(1), ['worker-switch', '--leader', 'leader-esim', '--task', 'w', '--state', 'on']);
  await assert.rejects(() => t.b.workerSwitch({ leader: 'leader-esim', task: 'w', enabled: 'yes' }), (e) => e.status === 400);
  await assert.rejects(() => t.b.workerSwitch({ leader: '../x', task: 'w', enabled: true }), (e) => e.status === 400);
});

test('page: the three source files make one document with the token tag and no slot left', () => {
  const real = path.resolve(__dirname, '..', '..');
  const html = boardLib.create({ root: real, env: {} }).page();
  assert.ok(html.includes('<meta name="reader-token" content="__READER_TOKEN__">'));
  assert.equal(/__CSS__|__JS__/.test(html), false);
  assert.ok(html.includes('--paper') && html.includes('window.__board'));
  assert.equal(html.includes('</script><script'), false);
});
