'use strict';

// Tests for the Tasks board's server side (board.js): caching, stale-while-revalidate, one build at a time and plain failures.
// board_cli.py is faked here; its own behaviour is tested in board/tests (python3 -I -m unittest discover -s setup/transcript-reader/board/tests).
//   node --test setup/transcript-reader/board.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
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

test('writes: all three are off unless their own flag is on, and off they run nothing', async () => {
  assert.deepEqual(boardLib.create({ root: ROOT, env: {} }).write, { marks: false, answer: false, send: false });
  assert.deepEqual(boardLib.create({ root: ROOT, env: { PMOS_READER_BOARD_MARKS: '1' } }).write, { marks: true, answer: false, send: false });
  assert.deepEqual(boardLib.create({ root: ROOT, env: { PMOS_READER_BOARD_ANSWER: '1' } }).write, { marks: false, answer: true, send: false });
  assert.deepEqual(boardLib.create({ root: ROOT, env: { PMOS_READER_BOARD_SEND: '1' } }).write, { marks: false, answer: false, send: true });
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
  assert.equal(/__[A-Z_]+__\*\//.test(html.replace('__READER_TOKEN__', '')), false, 'no slot is left');
  assert.ok(html.includes('--paper') && html.includes('window.__board'));
  assert.equal(html.includes('</script><script'), false);
});

// ---- round 4: the page carries the reader's own pieces

const REAL = path.resolve(__dirname, '..', '..');
const pageHtml = () => boardLib.create({ root: REAL, env: {} }).page();
const pageScript = () => pageHtml().match(/<script>([\s\S]*)<\/script>/)[1];

test('page: the reader\'s live link, markdown renderer, Undo window and comment key are pasted in whole, and the script still parses', () => {
  const html = pageHtml();
  for (const [name, file] of [['live.js', 'live.js'], ['markdown.js', 'markdown.js'], ['undosend.js', 'undosend.js'], ['commentkey.js', 'commentkey.js'], ['markdown-it', path.join('vendor', 'markdown-it.min.js')]]) {
    assert.ok(html.includes(fs.readFileSync(path.join(__dirname, 'prototype', file), 'utf8')), `${name} is in the page exactly as the reader has it`);
  }
  for (const own of ['replyview.js', 'composer.js']) assert.ok(html.includes(fs.readFileSync(path.join(__dirname, 'board', 'page', own), 'utf8')), own);
  assert.doesNotThrow(() => new vm.Script(pageScript()), 'one script that parses');
  assert.equal((html.match(/<\/script/gi) || []).length, 1, 'nothing in a pasted file closes the script early');
});

test('page: every rule of markdown.css is a line of the reader\'s own template, so the two cannot drift apart', () => {
  const template = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const rules = fs.readFileSync(path.join(__dirname, 'board', 'page', 'markdown.css'), 'utf8').split('\n').filter((line) => line.startsWith('.rmd .') && line.includes(' {'));
  assert.ok(rules.length >= 40, 'the rules are there: ' + rules.length);
  const unscoped = (line) => line.replace(/^\.rmd /, '').replace(/, \.rmd /g, ', ');
  const missing = rules.map(unscoped).filter((rule) => !template.includes(rule));
  assert.deepEqual(missing, [], 'rules that no longer match the reader\'s');
});

test('page: a reply is drawn by markdown.js into the reader\'s own shape, and markup in it stays text', () => {
  const sandbox = { document: { querySelector: () => null } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'prototype', 'vendor', 'markdown-it.min.js'), 'utf8'), sandbox);
  const view = vm.runInContext(fs.readFileSync(path.join(__dirname, 'prototype', 'markdown.js'), 'utf8') + '\nmarkdownView;', sandbox);
  const drawn = view.render('## Heading\n\n- one\n- **two**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sh\necho hi\n```\n\n<script>alert(1)</script> <img src=x onerror=alert(2)> [a](https://example.test) [b](javascript:alert(3))', { ask: [], reminder: [], doc: false }).html;
  assert.match(drawn, /<h4/);
  assert.match(drawn, /<div class="table-wrap"><table>/);
  assert.match(drawn, /<div class="codebox">/);
  assert.match(drawn, /<a href="https:\/\/example.test" target="_blank" rel="noopener noreferrer">a<\/a>/);
  assert.equal(/<script|<img|href="javascript/i.test(drawn), false, 'raw tags and script links are never markup');
  assert.match(drawn, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('reply text: the route checks its ids, and the send route needs its own flag and a session the board reads', async () => {
  const inputs = [];
  const b = boardLib.create({ root: ROOT, env: { PMOS_READER_BOARD: '1' }, run: async (f, a) => JSON.stringify({ items: [], threads: { status: 'ok', session_list: [{ id: 'abcdefgh-1' }] } }), runInput: async (f, a, o, input) => { inputs.push([a, input]); return JSON.stringify({ ok: true, md: 'whole', words: 1 }); } });
  assert.equal(b.write.send, false);
  await assert.rejects(() => b.reply('leader-esim', '../x', 'abcdefgh'), (e) => e.status === 400);
  await assert.rejects(() => b.reply('../x', 'abcdefgh', 'abcdefgh'), (e) => e.status === 400);
  assert.equal(inputs.length, 0);
  assert.deepEqual(await b.reply('leader-esim', 'abcdefgh-1', 'ijklmnop-2'), { md: 'whole', words: 1 });
  assert.deepEqual(inputs[0][0].slice(2), ['reply', '--session', 'leader-esim']);
  assert.throws(() => b.sendCheck('leader-esim', 'abcdefgh-1'), (e) => e.status === 404, 'flag off');
  const on = boardLib.create({ root: ROOT, env: { PMOS_READER_BOARD: '1', PMOS_READER_BOARD_SEND: '1' }, run: async () => JSON.stringify({ items: [], threads: { status: 'ok', session_list: [{ id: 'abcdefgh-1' }] } }) });
  assert.equal(on.write.send, true);
  assert.throws(() => on.sendCheck('leader-esim', 'abcdefgh-1'), (e) => e.status === 409 && e.code === 'not_a_board_session', 'before the board is read it names no supervisor');
  await on.board('leader-esim');
  assert.doesNotThrow(() => on.sendCheck('leader-esim', 'abcdefgh-1'));
  assert.throws(() => on.sendCheck('leader-esim', 'zzzzzzzz-9'), (e) => e.code === 'not_a_board_session');
  assert.throws(() => on.sendCheck('../x', 'abcdefgh-1'), (e) => e.status === 400);
});
