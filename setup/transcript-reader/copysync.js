'use strict';

// Builds the offline copy when the page asks for it: what the hosted and sealed copies' Sync button asks of the laptop (api.js,
// POST /api/transcript-reader/copy-sync).
//
// The copy a phone reads is written by sync.py and by nothing else: --build-only for the plain copy (out/hosted/), --seal for the sealed
// one (out/bucket/, which also builds out/hosted/). The page cannot make the laptop build, so before this its Sync button read the copy
// again, found the same one, and said it had synced. The reader's server is the one thing that is awake whenever a phone can reach the
// copy, so it runs the same build, the same way the LaunchAgent would, on the page's request:
//   - one build per copy at a time (a request while one runs joins it), as a process of its own (sync.py takes its own lock, so a build
//     started by hand or by the LaunchAgent at the same moment stops it with a message instead of two builds writing together);
//   - the passphrase is read by sync.py itself from the login keychain (sync.py, keychain_passphrase), never here: this module and the
//     server never hold it, and nothing it runs is handed it in an argument or the environment;
//   - what the build says on failure (its last line) is kept for the page to show, so a missing keychain item or a second build running
//     reads as that and not as a copy that "did not change".
// Which conversations the copy holds is sync.py's default scope; PMOS_READER_COPY_ARGS (read by api.js, split on spaces) adds options to
// the build (--panes open, --no-workspace) the way they would be given to a build run by hand.

const path = require('path');

const COPIES = ['bucket', 'hosted'];
// The first build of a big fleet's copy takes minutes; one that takes longer than this is stopped.
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_MESSAGE = 240;

function create({ root, outDir, runner, env, pythonBin = 'python3', now = () => Date.now(), args = [], timeoutMs = TIMEOUT_MS }) {
  const script = path.join(root, 'setup', 'transcript-reader', 'sync.py');
  const records = new Map();

  // The sealed copy's run builds out/hosted/ first and seals it into out/bucket/; the plain copy's stops after the build.
  const command = (copy) => ['-I', script, ...(copy === 'bucket' ? ['--seal', path.join(outDir, 'bucket')] : ['--build-only']),
    '--out', path.join(outDir, 'hosted'), ...args];

  function check(copy) {
    if (!COPIES.includes(copy)) throw new RangeError('Name the copy: bucket or hosted.');
    return copy;
  }

  const view = (copy) => {
    const record = records.get(copy);
    if (!record) return { copy, state: 'idle' };
    return { copy, state: record.state, startedAt: record.startedAt, ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}), ...(record.message ? { message: record.message } : {}) };
  };

  // What a failed build said: its own last line (on stderr, else on stdout), else a sentence for how it ended.
  const lastLine = (text) => String(text || '').trim().split('\n').pop().trim();
  function failure(result) {
    if (result.timedOut) return `The build took over ${Math.round(timeoutMs / 60000)} minutes and was stopped.`;
    return (lastLine(result.stderr) || lastLine(result.stdout) || `The build stopped (exit ${result.code}).`).slice(0, MAX_MESSAGE);
  }

  // Starts a build of the copy now, or joins the one running; answers its state at once (running), for the page to ask again.
  function start(copy) {
    check(copy);
    const running = records.get(copy);
    if (running && running.state === 'running') return view(copy);
    const record = { state: 'running', startedAt: now() };
    records.set(copy, record);
    const finish = (state, message) => { record.state = state; record.finishedAt = now(); if (message) record.message = message; };
    let ran;
    try { ran = Promise.resolve(runner(pythonBin, command(copy), { env, cwd: root, timeoutMs, maxBytes: 64 * 1024 })); } catch (error) { ran = Promise.reject(error); }
    ran.then(
      (result) => { if (result.code === 0) finish('done'); else finish('failed', failure(result)); },
      (error) => finish('failed', String((error && error.message) || 'The build could not start.').slice(0, MAX_MESSAGE)),
    );
    return view(copy);
  }

  const status = (copy) => view(check(copy));

  return { start, status, command };
}

module.exports = { create, COPIES, TIMEOUT_MS };
