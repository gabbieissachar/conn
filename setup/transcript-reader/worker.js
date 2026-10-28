'use strict';

// A reader.py that stays running (`reader.py worker`), so that the rebuild a changed log starts does not begin by reading every
// folder and log head on the machine again. The server sends it the same arguments it would give reader.py by hand, one JSON
// line each, and reads one JSON line back: { id, code, output }. One request at a time, in the order they came.
//
// It never makes a rebuild fail that would not have failed alone: a worker that cannot start, dies, or answers with something
// other than its reply is reported as `crashed`, and the caller runs reader.py once, the way it always did. A request that takes
// longer than the caller allows ends the worker (timedOut, like the one-shot run), and the next request starts a new one. An
// idle worker is ended, and a busy one is replaced after a number of requests, so what it holds in memory stays small.

const { spawn } = require('child_process');

const IDLE_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 500;
const BROKEN_MS = 60 * 1000;

function create({ command, args, cwd, env, timeoutMs = 60000, idleMs = IDLE_MS, maxRequests = MAX_REQUESTS, brokenMs = BROKEN_MS, spawnProcess = spawn, now = () => Date.now() }) {
  let child = null;       // { proc, buffer, pending, served }
  let queue = Promise.resolve();
  let idleTimer = null;
  let brokenAt = 0;
  let nextId = 1;
  let stopped = false;

  const crashed = (message) => ({ code: -1, stdout: '', stderr: message, timedOut: false, crashed: true });

  function retire(current, kill = false) {
    if (child === current) child = null;
    try { current.proc.stdin.end(); } catch { /* already gone */ }
    if (kill) { try { current.proc.kill('SIGKILL'); } catch { /* gone */ } }
  }

  function settle(current, result) {
    const pending = current.pending;
    if (!pending) return;
    current.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  function start() {
    let proc;
    try { proc = spawnProcess(command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (error) { return null; }
    const current = { proc, buffer: '', pending: null, served: 0, stderr: '' };
    proc.stdout.on('data', (chunk) => {
      current.buffer += chunk.toString('utf8');
      for (let at = current.buffer.indexOf('\n'); at >= 0; at = current.buffer.indexOf('\n')) {
        const line = current.buffer.slice(0, at);
        current.buffer = current.buffer.slice(at + 1);
        let reply = null;
        try { reply = JSON.parse(line); } catch { reply = null; }
        if (!reply || !current.pending || reply.id !== current.pending.id) {
          settle(current, crashed('The worker answered with something other than its reply.'));
          retire(current, true);
          return;
        }
        settle(current, { code: Number.isInteger(reply.code) ? reply.code : 1, stdout: String(reply.output || ''), stderr: '', timedOut: false });
      }
    });
    proc.stderr.on('data', (chunk) => { if (current.stderr.length < 4096) current.stderr += chunk.toString('utf8'); });
    proc.stdin.on('error', () => {});
    const gone = (why) => {
      settle(current, crashed(current.stderr.trim().split('\n').pop() || why));
      if (child === current) child = null;
    };
    proc.on('error', (error) => gone(error.message));
    proc.on('exit', () => gone('The worker stopped.'));
    return current;
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (child && !child.pending) retire(child); }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  function one(argv, allowed) {
    if (stopped) return Promise.resolve(crashed('The worker is stopped.'));
    if (brokenAt && now() - brokenAt < brokenMs) return Promise.resolve(crashed('The worker is not running.'));
    if (!child) child = start();
    if (!child) { brokenAt = now(); return Promise.resolve(crashed('The worker could not start.')); }
    const current = child;
    clearTimeout(idleTimer);
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        settle(current, { code: -1, stdout: '', stderr: '', timedOut: true });
        try { current.proc.kill('SIGKILL'); } catch { /* gone */ }
        if (child === current) child = null;
      }, allowed);
      current.pending = { id, resolve, timer };
      current.served += 1;
      try { current.proc.stdin.write(JSON.stringify({ id, args: argv }) + '\n'); } catch {
        settle(current, crashed('The worker could not be written to.'));
      }
    }).then((result) => {
      if (result.crashed) brokenAt = now(); else brokenAt = 0;
      if (child === current && current.served >= maxRequests) retire(current);
      else if (child) armIdle();
      return result;
    });
  }

  return {
    // Runs `reader.py <argv>` in the worker: { code, stdout, stderr, timedOut } like a one-shot run, and `crashed: true` when
    // the worker, not the build, failed.
    run: (argv, { timeoutMs: allowed = timeoutMs } = {}) => { const done = queue.then(() => one(argv, allowed)); queue = done.catch(() => {}); return done; },
    // Ends the worker (the server stopping, or a test).
    stop: () => { stopped = true; clearTimeout(idleTimer); if (child) { const current = child; settle(current, crashed('The worker is stopped.')); retire(current); } },
    running: () => Boolean(child),
  };
}

module.exports = { create };
