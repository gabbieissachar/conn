'use strict';

// The Tasks board's server side (data layer): one session's board as JSON, from board_cli.py, kept briefly in memory.
//
//   GET /api/transcript-reader/board?session=<id>[&fresh=1]   { status, board, cached_at, stale } for one session's board (board/README.md)
//   GET /api/transcript-reader/board-sessions                 { status, sessions: [...] }: the sessions that have a board (and the workers you drive, each on or off)
//   POST /api/transcript-reader/board-worker                  { leader, task, enabled }: turn one worker's board on or off (the reader's own small file; never a Firstmate home)
//   POST /api/transcript-reader/board-mark                    { session, task, turn, mark: in|out|clear }: file a reply mark on the task's record     (PMOS_READER_BOARD_MARKS=1)
//   POST /api/transcript-reader/board-answer                  { session, task, call, src, option|text|later }: record an answer to a call            (PMOS_READER_BOARD_ANSWER=1)
//   GET  /api/transcript-reader/board-reply?session=<id>&sid=<session>&uid=<turn>   the whole text of one reply, read only (for "Show full reply")
//   POST /api/transcript-reader/board-send                    { session, session_id, text }: send a message to a supervisor's Herdr pane, through the
//                                                             reader's own guarded Send (api.js sendPrompt)                                           (PMOS_READER_BOARD_SEND=1)
//   GET  /setup/transcript-reader/board/                      the Tasks page (board/page/): opened in a browser tab, loopback only
//
// Off unless the reader is started with PMOS_READER_BOARD=1 (or create({ board: true })); off, both routes answer 404 as if they did not
// exist. Read only: the board is built from Firstmate's snapshot, its typed ask records, status files and git refs, and nothing is written
// to a Firstmate home. The snapshot takes seconds (it asks every worker), so an answer is kept for TTL_MS and a stale one is sent at once
// while a fresh one is built behind it (`stale: true`); `fresh=1` waits for a new build. One build per session at a time.
//
// The three writes are separate flags, each off by default and each a no-op 404 while off: a mark is one line on a task's own record and an answer
// closes a call, both through that home's own Firstmate command (board/marks.py, board/answer.py), never by this module touching a home. A send
// is the reader's own Send (the same checks of the pane, the foreground session and Herdr's state as in the conversation view); this module only
// decides whether the board may use it (the flag, and a session id that is one of the board's own supervisors). The page learns which writes are on
// from `write` in every board answer and hides or disables the controls of the others.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const TTL_MS = 20 * 1000;
const BUILD_TIMEOUT_MS = 150 * 1000;
const WRITE_TIMEOUT_MS = 130 * 1000;  // an answer lists the open cards first, which asks the backlog once per gate
const MAX_BUFFER = 64 * 1024 * 1024;
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;

function defaultRun(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); return; }
      resolve(stdout);
    });
  });
}

// Run with a JSON body on stdin (an answer's words stay out of the process list).
function defaultRunInput(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, options.timeout || BUILD_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; if (out.length > MAX_BUFFER) child.kill('SIGKILL'); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { const error = new Error('exit ' + code); error.code = code; error.stderr = err; reject(error); return; }
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function create({ root, env = process.env, run = defaultRun, runInput = defaultRunInput, now = () => Date.now(), pythonBin = 'python3', ttlMs = TTL_MS,
  enabled = env.PMOS_READER_BOARD === '1', marks = env.PMOS_READER_BOARD_MARKS === '1', answer = env.PMOS_READER_BOARD_ANSWER === '1',
  send = env.PMOS_READER_BOARD_SEND === '1' } = {}) {
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

  const write = { marks: Boolean(marks), answer: Boolean(answer), send: Boolean(send) };

  // The whole text of one reply, read only, from the store (board_cli.py reply): the card shows a preview and asks for the rest on "Show full reply".
  const ID_RE = /^[0-9A-Za-z_-]{8,80}$/;
  async function reply(session, sid, uid) {
    if (!SESSION_RE.test(session || '')) throw invalid('Invalid session.');
    if (!ID_RE.test(sid || '') || !ID_RE.test(uid || '')) throw invalid('Invalid reply.');
    let out;
    try {
      out = await runInput(pythonBin, ['-I', script, 'reply', '--session', session], { env: runEnv(), timeout: 30000 }, JSON.stringify({ sid, uid }));
    } catch (error) {
      throw invalid(error && error.code === 2 ? 'No board for that session.' : 'The reply could not be read.', error && error.code === 2 ? 404 : 502, error && error.code === 2 ? 'not_found' : 'read_failed');
    }
    let result;
    try { result = JSON.parse(out); } catch { throw invalid('The reply came back unreadable.', 502, 'read_failed'); }
    if (!result.ok) throw invalid(result.message || 'Not found.', result.status || 404, 'not_found');
    return { md: result.md, words: result.words };
  }

  // A send from the board goes only to a session this board's own transcripts name as a supervisor (its last build says which), and only with the flag on;
  // the reader's own Send then makes every check about the pane (api.js). `check` runs after the flag and before anything is sent.
  function sendCheck(session, sessionId) {
    if (!write.send) throw invalid('Not found.', 404, 'not_found');
    if (!SESSION_RE.test(session || '')) throw invalid('Invalid session.');
    const entry = cache.get(session);
    const known = entry && entry.value && entry.value.threads && Array.isArray(entry.value.threads.session_list) ? entry.value.threads.session_list : [];
    if (!known.some((s) => s && s.id === sessionId)) throw invalid('That conversation is not one this board reads, so nothing was sent.', 409, 'not_a_board_session');
  }

  // The page's own source: three files beside this one, put into one document at serve time (the reader's page carries its script inline, too).
  const pageDir = path.join(root, 'setup', 'transcript-reader', 'board', 'page');
  // It also carries the reader's own pieces, pasted in from where the reader keeps them: its live link (live.js), the markdown renderer (the vendored
  // markdown-it and markdown.js: the one every reply, status line and document of the conversation view goes through) and the Undo window and the faded
  // message's wording (undosend.js). Two board files sit between them and the page: the reply drawing and the composer.
  const readerDir = path.join(root, 'setup', 'transcript-reader', 'prototype');
  const PIECES = [
    ['/*__LIVE__*/', path.join(readerDir, 'live.js')], ['/*__MARKDOWN_IT__*/', path.join(readerDir, 'vendor', 'markdown-it.min.js')],
    ['/*__MARKDOWN__*/', path.join(readerDir, 'markdown.js')], ['/*__UNDOSEND__*/', path.join(readerDir, 'undosend.js')],
    ['/*__COMMENTKEY__*/', path.join(readerDir, 'commentkey.js')], ['/*__REPLYVIEW__*/', path.join(pageDir, 'replyview.js')],
    ['/*__COMPOSER__*/', path.join(pageDir, 'composer.js')],
  ];
  function page() {
    const read = (name) => fs.readFileSync(path.join(pageDir, name), 'utf8');
    let html = read('index.html').replace('/*__CSS__*/', () => read('board.css') + '\n' + read('markdown.css'));
    for (const [slot, file] of PIECES) html = html.replace(slot, () => fs.readFileSync(file, 'utf8'));
    return html.replace('/*__JS__*/', () => read('board.js'));
  }

  function invalid(message, status = 400, code = 'bad_request') { const error = new Error(message); error.status = status; error.code = code; return error; }

  // A flagged write: the body goes to board_cli.py on stdin, the answer comes back as { ok, ... }. A refusal is the Firstmate command's own sentence.
  async function writeVia(command, flag, session, body) {
    if (!flag) throw invalid('Not found.', 404, 'not_found');
    if (!SESSION_RE.test(session || '')) throw invalid('Invalid session.');
    let out;
    try {
      out = await runInput(pythonBin, ['-I', script, command, '--session', session], { env: runEnv(), timeout: WRITE_TIMEOUT_MS }, JSON.stringify(body || {}));
    } catch (error) {
      throw invalid(error && error.code === 2 ? 'No board for that session.' : 'The write could not run.', error && error.code === 2 ? 404 : 502, error && error.code === 2 ? 'not_found' : 'write_failed');
    }
    let result;
    try { result = JSON.parse(out); } catch { throw invalid('The write answered something unreadable.', 502, 'write_failed'); }
    if (!result.ok) throw invalid(result.message || 'Refused.', result.status || 409, 'refused');
    for (const entry of cache.values()) entry.at = 0;  // the home changed: every board of it is stale, so the next read sends the old one and builds a new one behind it
    return result;
  }
  const mark = (session, body) => writeVia('mark', write.marks, session, body);
  const answerCall = (session, body) => writeVia('answer', write.answer, session, body);

  async function workerSwitch({ leader, task, enabled: on }) {
    if (typeof on !== 'boolean' || !SESSION_RE.test(leader || '') || typeof task !== 'string' || !SESSION_RE.test(task)) throw invalid('Invalid worker.');
    const out = await run(pythonBin, ['-I', script, 'worker-switch', '--leader', leader, '--task', task, '--state', on ? 'on' : 'off'], { env: runEnv(), timeout: 30000 });
    const result = JSON.parse(out);
    if (!result.ok) throw invalid(result.message || 'Refused.', result.status || 404, 'not_found');
    return result;
  }

  return { enabled, write, board, sessions, mark, answer: answerCall, workerSwitch, reply, sendCheck, page, ttlMs };
}

module.exports = { create, SESSION_RE, TTL_MS };
