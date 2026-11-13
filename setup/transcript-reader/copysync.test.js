'use strict';

// Tests for copysync.js, the build of the offline copy on the page's request. Run from the repo root:
//   node --test setup/transcript-reader/copysync.test.js
// The build is a fake runner (nothing runs, nothing is written); api.test.js holds the route that asks for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const copysync = require('./copysync');

const ROOT = '/lab/repo';
const OUT = path.join(ROOT, 'setup', 'transcript-reader', 'out');
const SYNC = path.join(ROOT, 'setup', 'transcript-reader', 'sync.py');
const ok = { code: 0, stdout: 'Hosted shell: x\n', stderr: '', timedOut: false, truncated: false };

// A runner that holds each build until the test lets it end, so a test can look at the state in between.
function fakeRunner() {
  const run = { calls: [], ends: [] };
  run.runner = (file, args, options) => new Promise((resolve) => { run.calls.push({ file, args, options }); run.ends.push(resolve); });
  run.end = async (result = ok) => { run.ends.shift()(result); await new Promise((resolve) => setImmediate(resolve)); };
  return run;
}
const make = (run, extra = {}) => copysync.create({ root: ROOT, outDir: OUT, runner: run.runner, env: { HOME: '/lab/home' }, now: () => 1000, ...extra });

test('the sealed copy is built by sync.py --seal into out/bucket, which builds out/hosted first; the plain copy by --build-only', async () => {
  const run = fakeRunner();
  const builds = make(run);
  assert.deepEqual(builds.status('bucket'), { copy: 'bucket', state: 'idle' });
  assert.deepEqual(builds.start('bucket'), { copy: 'bucket', state: 'running', startedAt: 1000 });
  builds.start('hosted');
  assert.deepEqual(run.calls[0].args, ['-I', SYNC, '--seal', path.join(OUT, 'bucket'), '--out', path.join(OUT, 'hosted')]);
  assert.deepEqual(run.calls[1].args, ['-I', SYNC, '--build-only', '--out', path.join(OUT, 'hosted')]);
  for (const call of run.calls) {
    assert.equal(call.file, 'python3');
    assert.equal(call.options.cwd, ROOT);
    assert.deepEqual(call.options.env, { HOME: '/lab/home' }, 'the environment is the server\'s own: no passphrase is added, sync.py reads the keychain itself');
    assert.ok(!call.args.some((arg) => /pass/i.test(arg)), 'no passphrase on the command line');
  }
  await run.end();
  assert.deepEqual(builds.status('bucket'), { copy: 'bucket', state: 'done', startedAt: 1000, finishedAt: 1000 });
});

test('a request while a build of the same copy runs joins it: one process', async () => {
  const run = fakeRunner();
  const builds = make(run);
  builds.start('bucket');
  assert.equal(builds.start('bucket').state, 'running');
  assert.equal(builds.start('bucket').state, 'running');
  assert.equal(run.calls.length, 1);
  await run.end();
  assert.equal(builds.status('bucket').state, 'done');
  // Once it is over the next request is a new build.
  builds.start('bucket');
  assert.equal(run.calls.length, 2);
  assert.equal(builds.status('bucket').state, 'running');
  await run.end();
});

test('a build that fails keeps what it said last, for the page to show', async () => {
  const run = fakeRunner();
  const builds = make(run);
  builds.start('bucket');
  await run.end({ code: 1, stdout: '', stderr: 'Traceback...\nSet HOSTED_READER_PASSPHRASE, keep the passphrase in the login keychain (security add-generic-password -s pmos-hosted-reader -a "$USER" -w), or run this in a terminal.\n', timedOut: false, truncated: false });
  const failed = builds.status('bucket');
  assert.equal(failed.state, 'failed');
  assert.match(failed.message, /^Set HOSTED_READER_PASSPHRASE, keep the passphrase in the login keychain/);
  // sync.py says a second build is running on stdout and stops: that line is the message.
  builds.start('bucket');
  await run.end({ code: 1, stdout: 'Another build of this copy is running; this one stops.\n', stderr: '', timedOut: false, truncated: false });
  assert.equal(builds.status('bucket').message, 'Another build of this copy is running; this one stops.');
  // One that was stopped for taking too long, and one that could not start at all.
  builds.start('bucket');
  await run.end({ code: -1, stdout: '', stderr: '', timedOut: true, truncated: false });
  assert.equal(builds.status('bucket').message, 'The build took over 10 minutes and was stopped.');
  builds.start('bucket');
  await run.end({ code: 2, stdout: '', stderr: '', timedOut: false, truncated: false });
  assert.equal(builds.status('bucket').message, 'The build stopped (exit 2).');
  const refusing = make({ runner: () => Promise.reject(new Error('spawn python3 ENOENT')) });
  refusing.start('hosted');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([refusing.status('hosted').state, refusing.status('hosted').message], ['failed', 'spawn python3 ENOENT']);
});

test('the build options the owner gave the server go on the end of the command, and only those', async () => {
  const run = fakeRunner();
  make(run, { args: ['--panes', 'open', '--no-workspace'] }).start('bucket');
  assert.deepEqual(run.calls[0].args.slice(-3), ['--panes', 'open', '--no-workspace']);
  assert.deepEqual(run.calls[0].args.slice(0, 5), ['-I', SYNC, '--seal', path.join(OUT, 'bucket'), '--out']);
});

test('only the two copies can be named', () => {
  const builds = make(fakeRunner());
  for (const copy of ['', 'both', '../bucket', undefined, 7]) {
    assert.throws(() => builds.start(copy), RangeError, String(copy));
    assert.throws(() => builds.status(copy), RangeError, String(copy));
  }
});
