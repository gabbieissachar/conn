'use strict';

// Tests for the reader.py that stays running (worker.js). Run: node --test setup/transcript-reader/worker.test.js
// The program on the other end is a small script of this test's own that speaks the same lines, so no reader.py or log is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('./worker');

// Answers each request line { id, args } with { id, code, output }. args[0] says what it does:
//   pid        answers with its process id        slow <ms>  answers after that long         exit  dies without answering
//   garbage    answers with a line that is not JSON      wrong  answers with another id      fail  answers with exit code 1
function fakeProgram() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
  const script = path.join(dir, 'program.js');
  fs.writeFileSync(script, `
    let buffer = '';
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
        const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        const [what, arg] = request.args;
        const reply = (extra) => process.stdout.write(JSON.stringify({ id: request.id, code: 0, output: '', ...extra }) + '\\n');
        if (what === 'pid') reply({ output: String(process.pid) });
        else if (what === 'slow') setTimeout(() => reply({ output: 'slow ' + arg }), Number(arg));
        else if (what === 'exit') { process.stderr.write('the program fell over\\n'); process.exit(3); }
        else if (what === 'garbage') process.stdout.write('not json\\n');
        else if (what === 'wrong') process.stdout.write(JSON.stringify({ id: request.id + 100, code: 0, output: '' }) + '\\n');
        else if (what === 'fail') reply({ code: 1, output: 'Traceback\\nValueError: broken\\n' });
        else reply({ output: what });
      }
    });
    process.stdin.on('end', () => process.exit(0));`);
  return { dir, command: process.execPath, args: [script] };
}

function make(options = {}) {
  const program = fakeProgram();
  const worker = create({ command: program.command, args: program.args, cwd: program.dir, env: process.env, ...options });
  return worker;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A process ends some time after the worker lets go of it, and how long depends on how busy the machine is (the whole suite
// runs many files at once). So a test waits for the condition itself, up to a limit it can only reach when something is wrong,
// rather than sleeping for a fixed time and looking once.
async function until(condition, what, limitMs = 10000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > limitMs) assert.fail('still not true after ' + limitMs + ' ms: ' + what);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a request is answered with the exit code and the output, as a one-shot run would give them', async () => {
  const worker = make();
  try {
    assert.deepEqual(await worker.run(['hello']), { code: 0, stdout: 'hello', stderr: '', timedOut: false });
    const failed = await worker.run(['fail']);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, 'Traceback\nValueError: broken\n');
    assert.equal(failed.crashed, undefined, 'a build that fails is not a worker that failed');
    assert.equal(worker.running(), true);
  } finally { worker.stop(); }
});

test('one process serves every request, one at a time and in the order they came', async () => {
  const worker = make();
  try {
    const pids = new Set();
    const answers = await Promise.all([worker.run(['slow', '60']), worker.run(['pid']), worker.run(['slow', '10']), worker.run(['pid'])]);
    assert.deepEqual(answers.map((a) => a.stdout).filter((text) => text.startsWith('slow')), ['slow 60', 'slow 10']);
    for (const answer of answers) if (/^\d+$/.test(answer.stdout)) pids.add(answer.stdout);
    assert.equal(pids.size, 1, 'the same process');
  } finally { worker.stop(); }
});

test('a request that takes longer than allowed ends the worker, and the next request starts a new one', async () => {
  const worker = make({ timeoutMs: 20000 });
  try {
    const first = Number((await worker.run(['pid'])).stdout);
    const slow = await worker.run(['slow', '5000'], { timeoutMs: 100 });
    assert.equal(slow.timedOut, true);
    assert.equal(slow.crashed, undefined, 'a timeout is the build\'s, reported as the one-shot run reports it');
    await until(() => !alive(first), 'the stuck process is gone');
    const second = Number((await worker.run(['pid'])).stdout);
    assert.notEqual(second, first);
  } finally { worker.stop(); }
});

test('a worker that dies, answers with something that is not a reply, or cannot start is reported as crashed, and left alone for a while', async () => {
  let clock = 1000;
  for (const [what, message] of [['exit', /fell over/], ['garbage', /something other than its reply/], ['wrong', /something other than its reply/]]) {
    const worker = make({ brokenMs: 5000, now: () => clock });
    try {
      const crashed = await worker.run([what]);
      assert.equal(crashed.crashed, true, what);
      assert.equal(crashed.code, -1);
      assert.match(crashed.stderr, message);
      const held = await worker.run(['pid']);
      assert.equal(held.crashed, true, 'not started again within the time it is left alone');
      assert.match(held.stderr, /not running/);
      clock += 6000;
      const again = await worker.run(['pid']);
      assert.equal(again.crashed, undefined, 'tried again once that time is over');
      assert.match(again.stdout, /^\d+$/);
    } finally { worker.stop(); }
  }
  const missing = create({ command: path.join(os.tmpdir(), 'no-such-program-' + process.pid), args: [], env: process.env, brokenMs: 5000, now: () => clock });
  const answer = await missing.run(['hello']);
  assert.equal(answer.crashed, true);
  missing.stop();
});

test('an idle worker is ended, and the next request starts another', async () => {
  const worker = make({ idleMs: 60 });
  try {
    const first = Number((await worker.run(['pid'])).stdout);
    assert.equal(worker.running(), true);
    await until(() => !worker.running(), 'the idle worker is let go');
    await until(() => !alive(first), 'the idle process is gone');
    assert.notEqual(Number((await worker.run(['pid'])).stdout), first);
  } finally { worker.stop(); }
});

test('an idle worker is kept while a page is open (keepWarm), and ended once none is', async () => {
  let page = true;
  const worker = make({ idleMs: 40, keepWarm: () => page });
  try {
    const first = Number((await worker.run(['pid'])).stdout);
    await new Promise((resolve) => setTimeout(resolve, 250));  // several idle periods
    assert.equal(worker.running(), true, 'a page is open: the warm worker stays');
    assert.equal(Number((await worker.run(['pid'])).stdout), first, 'and answers the next request itself');
    page = false;
    await until(() => !worker.running(), 'the worker is let go once no page is open');
    await until(() => !alive(first), 'its process is gone');
  } finally { worker.stop(); }
});

test('a worker that has served many requests is replaced, so what it holds in memory stays small', async () => {
  const worker = make({ maxRequests: 3 });
  try {
    const pids = [];
    for (let i = 0; i < 7; i += 1) pids.push((await worker.run(['pid'])).stdout);
    assert.deepEqual([...new Set(pids)].length, 3, 'a new process after each three');
    assert.equal(pids[0], pids[2]);
    assert.notEqual(pids[2], pids[3]);
  } finally { worker.stop(); }
});

test('stopping ends the process, answers what waits, and takes no more', async () => {
  const worker = make();
  const pid = Number((await worker.run(['pid'])).stdout);
  const waiting = worker.run(['slow', '5000']);
  await new Promise((resolve) => setTimeout(resolve, 50));
  worker.stop();
  const answer = await waiting;
  assert.equal(answer.crashed, true);
  await until(() => !alive(pid), 'the stopped process is gone');
  assert.equal((await worker.run(['pid'])).crashed, true);
});
