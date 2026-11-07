'use strict';

// The Tasks board's server side (data layer): one session's board as JSON, from board_cli.py, kept briefly in memory.
//
//   GET /api/transcript-reader/board?session=<id>[&fresh=1]   { status, board, cached_at, stale } for one session's board (board/README.md)
//   GET /api/transcript-reader/board-sessions                 { status, sessions: [...] }: the sessions that have a board
//
// Off unless the reader is started with PMOS_READER_BOARD=1 (or create({ board: true })); off, both routes answer 404 as if they did not
// exist. Read only: the board is built from Firstmate's snapshot, its typed ask records, status files and git refs, and nothing is written
// to a Firstmate home. The snapshot takes seconds (it asks every worker), so an answer is kept for TTL_MS and a stale one is sent at once
// while a fresh one is built behind it (`stale: true`); `fresh=1` waits for a new build. One build per session at a time.

const path = require('path');
const { execFile } = require('child_process');

const TTL_MS = 20 * 1000;
const BUILD_TIMEOUT_MS = 150 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;
const SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/;

function defaultRun(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); return; }
      resolve(stdout);
    });
  });
}

function create({ root, env = process.env, run = defaultRun, now = () => Date.now(), pythonBin = 'python3', ttlMs = TTL_MS, enabled = env.PMOS_READER_BOARD === '1' } = {}) {
  const script = path.join(root, 'setup', 'transcript-reader', 'board_cli.py');
  const cache = new Map();  // session -> { value, at, building }
  const runEnv = () => ({ ...env });

  async function cli(args) {
    const out = await run(pythonBin, ['-I', script, ...args], { env: runEnv(), timeout: BUILD_TIMEOUT_MS });
    return JSON.parse(out);
  }

  function build(session) {
    const entry = cache.get(session) || { value: null, at: 0, building: null };
    cache.set(session, entry);
    if (!entry.building) {
      entry.building = cli(['board', '--session', session]).then((value) => {
        entry.value = value;
        entry.at = now();
        return value;
      }).finally(() => { entry.building = null; });
      entry.building.catch(() => {});  // a background build's failure is seen by whoever waits on it; not an unhandled rejection
    }
    return entry;
  }

  // The board of one session: { board, cached_at, stale }.
  async function board(session, { fresh = false } = {}) {
    if (!SESSION_RE.test(session || '')) { const error = new Error('Invalid session.'); error.status = 400; error.code = 'bad_request'; throw error; }
    let entry = cache.get(session);
    const age = entry && entry.value ? now() - entry.at : Infinity;
    if (!fresh && entry && entry.value && age < ttlMs) return { board: entry.value, cached_at: entry.at, stale: false };
    if (!fresh && entry && entry.value) {
      build(session);  // behind the answer
      return { board: entry.value, cached_at: entry.at, stale: true };
    }
    entry = build(session);
    try {
      await entry.building;
    } catch (error) {
      const failure = new Error(error && error.code === 2 ? 'No board for that session.' : 'The board could not be built.');
      failure.status = error && error.code === 2 ? 404 : 502;
      failure.code = error && error.code === 2 ? 'not_found' : 'board_failed';
      throw failure;
    }
    return { board: entry.value, cached_at: entry.at, stale: false };
  }

  async function sessions() {
    return cli(['sessions']);
  }

  return { enabled, board, sessions, ttlMs };
}

module.exports = { create, SESSION_RE, TTL_MS };
