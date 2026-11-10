'use strict';

// The Tasks board's server side (data layer): one session's board as JSON, from board_cli.py, kept briefly in memory.
//
//   GET /api/transcript-reader/board?session=<id>[&fresh=1]   { status, board, cached_at, stale } for one session's board (board/README.md)
//   GET /api/transcript-reader/board-sessions                 { status, sessions: [...] }: the sessions that have a board (and the workers you drive, each on or off)
//   POST /api/transcript-reader/board-worker                  { leader, task, enabled }: turn one worker's board on or off (the reader's own small file; never a Firstmate home)
//   POST /api/transcript-reader/board-mark                    { session, task, turn, mark: in|out|clear[, source: reader|card] }: file a reply mark on the task's record (the conversation's turn menu says reader; PMOS_READER_BOARD_MARKS=1)
//   POST /api/transcript-reader/board-answer                  { session, task, call, src, option|text|later }: record an answer to a call            (PMOS_READER_BOARD_ANSWER=1)
//   POST /api/transcript-reader/board-review                  { session, task, action: done|queue|delay|needs|followup, note, until, title, due }: record what you decided on the task's
//                                                             real record, through the home's own commands (fm-tasks-axi.sh, fm-captain-hold.sh)    (PMOS_READER_BOARD_REVIEW=1)
//   POST /api/transcript-reader/board-round                   { session, op: start|mark|unmark, task }: the review round (board-rounds.js): a new round, a task marked reviewed,
//                                                             or the mark taken off; the reader's own small file, never a Firstmate home           (PMOS_READER_BOARD_REVIEW=1)
//   GET  /api/transcript-reader/board-reply?session=<id>&sid=<session>&uid=<turn>   the whole text of one reply, read only (for "Show full reply")
//   POST /api/transcript-reader/board-send                    { session, session_id, text }: send a message to a supervisor's Herdr pane, through the
//                                                             reader's own guarded Send (api.js sendPrompt)                                           (PMOS_READER_BOARD_SEND=1)
//   GET  /setup/transcript-reader/board/                      the Tasks page (board/page/): opened in a browser tab, loopback only (and the TLS address with PMOS_READER_BOARD_TAILNET=1)
//   the reader's state route also says { board: { page, boards } } where the board is served, so the reader page can show its Tasks link (api.js)
//
// Off unless the reader is started with PMOS_READER_BOARD=1 (or create({ board: true })); off, both routes answer 404 as if they did not
// exist. Read only: the board is built from Firstmate's snapshot, its typed ask records, status files and git refs, and nothing is written
// to a Firstmate home.
//
// Why a board takes a while, and what keeps the page from waiting on it: the whole snapshot asks every worker for its live state, which takes ten to
// forty seconds for a home on a busy machine (a home's backlog, cards and replies together take two or three more). So
//   - a board is kept in memory for TTL_MS; an older one is sent at once with `stale: true` while a new one is built behind it;
//   - the last whole board of each session is also kept on disk (persistDir), so the first read after a restart is answered at once, too;
//   - when the reader runs for real (warm), every session's board is read once at start, one session at a time (four snapshots at once, on a busy
//     machine, is what makes each of them time out); a board someone asks for does not wait behind them;
//   - when there is nothing to show yet, or an answer is a couple of minutes old, or the page asks for a fresh read, a quick board is built first (the
//     backlog and the replies, without asking the workers: a second or two, `quick: true` in the board) and sent at once, and the whole board follows
//     behind it. A quick board can show a decision a worker has since moved past; the page says so while it is the one on view;
//   - a read that fails never replaces a good board: the good one stays, with a line saying the latest read failed.
// `fresh=1` asks for the newest board there is: quick if the whole one is still on its way.
//
// The writes are separate flags, each off by default and each a no-op 404 while off: a mark is one line on a task's own record, an answer
// closes a call and a review outcome moves a task (done, queued, delayed to a date, back to needs-you) or adds a follow-up, all through that home's own Firstmate command (board/marks.py, board/answer.py), never by this module touching a home. A send
// is the reader's own Send (the same checks of the pane, the foreground session and Herdr's state as in the conversation view); this module only
// decides whether the board may use it (the flag, and a session id that is one of the board's own supervisors). The page learns which writes are on
// from `write` in every board answer and hides or disables the controls of the others.

const boardRounds = require('./board-rounds');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const TTL_MS = 20 * 1000;
const QUICK_AFTER_MS = 2 * 60 * 1000;  // a board this old is answered at once and a quick one is read behind it, so the page is current within seconds
const RETRY_MS = 30 * 1000;            // after a read that failed, the next background read waits this long
const WARM_DELAY_MS = 1500;
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

// Where the board keeps what it remembers: the same folder board/collect.py uses (PMOS_READER_BOARD_CACHE moves both).
function boardCacheDir(env = process.env) {
  return env.PMOS_READER_BOARD_CACHE || path.join(os.homedir(), '.config', 'pmos-transcript-reader', 'board-cache');
}

function create({ root, env = process.env, run = defaultRun, runInput = defaultRunInput, now = () => Date.now(), pythonBin = 'python3', ttlMs = TTL_MS,
  enabled = env.PMOS_READER_BOARD === '1', marks = env.PMOS_READER_BOARD_MARKS === '1', answer = env.PMOS_READER_BOARD_ANSWER === '1',
  send = env.PMOS_READER_BOARD_SEND === '1', review = env.PMOS_READER_BOARD_REVIEW === '1', quickRead = true, persistDir = null, warm = false,
  roundStore = boardRounds.create({ file: boardRounds.roundsFile(env), now }) } = {}) {
  const script = path.join(root, 'setup', 'transcript-reader', 'board_cli.py');
  const cache = new Map();  // session -> { value, at, fullAt, building, quickBuilding, retryAt, failure }
  const runEnv = () => ({ ...env });

  async function cli(args) {
    const out = await run(pythonBin, ['-I', script, ...args], { env: runEnv(), timeout: BUILD_TIMEOUT_MS });
    return JSON.parse(out);
  }

  // ---- what is remembered on disk: the last whole board of a session (private card text: owner-only, in the board's own cache folder)
  const persistPath = (session) => (persistDir ? path.join(persistDir, 'boards', session + '.json') : null);
  function loadPersisted(session) {
    const file = persistPath(session);
    if (!file) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.session === session && data.board && data.board.schema === 'task-board.v1' && Number.isFinite(data.at)) return data;
    } catch { /* nothing remembered, or unreadable: read it again */ }
    return null;
  }
  function persist(session, value, at) {
    const file = persistPath(session);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ session, at, board: value }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* a board that cannot be remembered is only slower to come back */ }
  }

  function entryFor(session) {
    let entry = cache.get(session);
    if (!entry) {
      entry = { value: null, at: 0, fullAt: 0, building: null, quickBuilding: null, retryAt: 0, failure: null };
      const remembered = loadPersisted(session);
      if (remembered) { entry.value = remembered.board; entry.at = entry.fullAt = remembered.at; }
      cache.set(session, entry);
    }
    return entry;
  }

  // A board the snapshot could not be read for (no items, no snapshot time) is not a board to show over a good one.
  const usable = (value) => Boolean(value && value.source && value.source.snapshot_at);
  const failureText = (value) => ((value && value.source && value.source.errors && value.source.errors[0]) || 'the fleet could not be read');

  // The boards read at start (warm) are read one at a time: each snapshot spawns a probe per worker, and four at once on a busy machine make every one of them
  // slow enough to time out. A board someone is waiting for does not queue behind them.
  let warmTail = Promise.resolve();
  function whole(session, { force = false, queued = false } = {}) {
    const entry = entryFor(session);
    if (entry.building) return entry.building;
    if (!force && entry.retryAt > now()) return Promise.resolve(null);
    const job = () => cli(['board', '--session', session]);
    const running = queued ? warmTail.then(job, job) : job();
    if (queued) warmTail = running.catch(() => {});
    entry.building = running.then((value) => {
      if (usable(value)) { entry.value = value; entry.at = entry.fullAt = now(); entry.failure = null; entry.retryAt = 0; persist(session, value, entry.at); return value; }
      if (entry.value) { entry.failure = failureText(value); entry.retryAt = now() + RETRY_MS; return null; }  // the good board stays
      entry.value = value; entry.at = now(); return value;  // nothing better to show: the board with its reasons
    }, (error) => {
      if (entry.value) { entry.failure = error && error.code === 2 ? 'no such board' : 'the board could not be read'; entry.retryAt = now() + RETRY_MS; return null; }
      throw error;
    }).finally(() => { entry.building = null; });
    entry.building.catch(() => {});  // a background read's failure is seen by whoever waits on it; not an unhandled rejection
    return entry.building;
  }

  // A quick board: the backlog and the replies, without asking the workers. It is kept when it is newer than the whole board there is.
  function quick(session) {
    const entry = entryFor(session);
    if (!entry.quickBuilding) {
      const started = now();
      entry.quickBuilding = cli(['board', '--session', session, '--quick']).then((value) => {
        if (usable(value) && entry.fullAt <= started) { entry.value = value; entry.at = now(); }
        return value;
      }).finally(() => { entry.quickBuilding = null; });
      entry.quickBuilding.catch(() => {});
    }
    return entry.quickBuilding;
  }

  // What the page is given: the board, when it was read, whether a newer one is on its way, and a line when the latest read failed.
  function answerFor(entry) {
    let value = entry.value;
    if (entry.failure && value && value.source) value = { ...value, source: { ...value.source, errors: [...(value.source.errors || []), 'The latest read of the fleet failed (' + entry.failure + '), so this is the board from ' + new Date(entry.at).toISOString().slice(11, 16) + ' UTC.'] } };
    return { board: value, cached_at: entry.at, stale: Boolean(entry.building) || Boolean(value && value.quick) || (now() - entry.at >= ttlMs) };
  }
  function failed(error) {
    const failure = new Error(error && error.code === 2 ? 'No board for that session.' : 'The board could not be built.');
    failure.status = error && error.code === 2 ? 404 : 502;
    failure.code = error && error.code === 2 ? 'not_found' : 'board_failed';
    return failure;
  }

  // The board of one session: { board, cached_at, stale, round }. `round` is the review round of the board (null before the first): which tasks are already reviewed.
  async function board(session, options) {
    const answer = await boardOnly(session, options);
    return { ...answer, round: roundStore.get(session) };
  }
  async function boardOnly(session, { fresh = false } = {}) {
    if (!SESSION_RE.test(session || '')) { const error = new Error('Invalid session.'); error.status = 400; error.code = 'bad_request'; throw error; }
    const entry = entryFor(session);
    const age = entry.value ? now() - entry.at : Infinity;
    if (!fresh && entry.value && !entry.value.quick && age < ttlMs) return answerFor(entry);
    if (!fresh && entry.value) {
      whole(session);  // behind the answer
      if (quickRead && age >= QUICK_AFTER_MS && !entry.value.quick) quick(session);
      return answerFor(entry);
    }
    try {
      if (quickRead) {
        // The quick read first and alone (the whole read's probes, started beside it, slow it down on a busy machine), the whole board right behind it.
        let quickFailed = false;
        try { await quick(session); } catch { quickFailed = true; }
        const behind = whole(session);
        if (quickFailed || !entry.value) await behind;  // a quick read that could not run or found nothing to show: the whole board, or its reasons
      } else {
        await whole(session, { force: true });
      }
    } catch (error) {
      throw failed(error);
    }
    if (!entry.value) throw failed(null);
    return answerFor(entry);
  }

  // At start, read every session's board once, one at a time, unless a board remembered from disk is still young. Never delays a request.
  function warmUp() {
    const timer = setTimeout(async () => {
      let list = [];
      try { list = ((await cli(['sessions'])).sessions || []).filter((x) => x && x.enabled !== false && x.kind !== 'worker' && SESSION_RE.test(x.id || '')); } catch { return; }
      for (const x of list) { const entry = entryFor(x.id); if (!entry.value || now() - entry.at >= ttlMs) { await whole(x.id, { queued: true }).catch(() => {}); } }
    }, WARM_DELAY_MS);
    if (timer.unref) timer.unref();
  }
  if (warm && enabled) warmUp();

  async function sessions() {
    return cli(['sessions']);
  }

  const write = { marks: Boolean(marks), answer: Boolean(answer), send: Boolean(send), review: Boolean(review) };

  // Which board each conversation of the reader belongs to, for the reader page's Tasks link: { <conversation id>: <board session id> }, from the boards
  // already read (their threads name the supervisor conversations each one reads), so it never builds or reads anything. A conversation two boards read goes
  // to the first board read; a board not read yet names none, and the link then opens the board page on its own first board.
  function readerBoards() {
    const found = {};
    for (const [id, entry] of cache) {
      const list = entry && entry.value && entry.value.threads && Array.isArray(entry.value.threads.session_list) ? entry.value.threads.session_list : [];
      for (const conversation of list) if (conversation && typeof conversation.id === 'string' && !(conversation.id in found)) found[conversation.id] = id;
    }
    return found;
  }

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

  // A review outcome is judged against the board's own last read of the task (a worker still on it, a branch or PR not landed, an open typed card): the facts come
  // from this side, never from the page, and the Python side checks the worker record again. A task the board has not read is refused (refresh first).
  const ASK_SRC = 'ask';
  function reviewFacts(session, task) {
    const entry = cache.get(session);
    const item = entry && entry.value && Array.isArray(entry.value.items) ? entry.value.items.find((x) => x && x.ref === task) : null;
    if (!item) return null;
    return { live: Boolean(item.live), ready: Boolean(item.ready), branch_state: item.branch_state || null, pr: item.pr || null, merged: Boolean(item.merged), repo: item.repo || null,
      ask_open: Array.isArray(item.calls) && item.calls.some((c) => c && c.src === ASK_SRC) };
  }
  async function reviewTask(session, body) {
    if (!write.review) throw invalid('Not found.', 404, 'not_found');
    if (!SESSION_RE.test(session || '')) throw invalid('Invalid session.');
    const task = body && body.task;
    if (typeof task !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(task)) throw invalid('That is not a task reference.');
    const facts = reviewFacts(session, task);
    if (!facts) throw invalid('The board has not read that task, so nothing was changed. Refresh the board first.', 409, 'not_read');
    const done = await writeVia('review', write.review, session, { task, action: body.action, note: body.note, until: body.until, title: body.title, due: body.due, facts });
    try { roundStore.mark(session, task, body.action); } catch { /* the outcome is recorded; only the reviewed mark could not be kept */ }
    return { ...done, round: roundStore.get(session) };
  }
  // The review round: start a new one (forgets the marks), mark a task reviewed without changing it, or take the mark off. The reader's own file; the flag is the review one.
  async function roundWrite(session, body) {
    if (!write.review) throw invalid('Not found.', 404, 'not_found');
    if (!SESSION_RE.test(session || '')) throw invalid('Invalid session.');
    const op = body && body.op;
    if (op === 'start') return { round: roundStore.start(session) };
    const task = body && body.task;
    if (typeof task !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(task)) throw invalid('That is not a task reference.');
    if (!reviewFacts(session, task)) throw invalid('The board has not read that task. Refresh the board first.', 409, 'not_read');
    if (op === 'mark') return { round: roundStore.mark(session, task, 'seen') };
    if (op === 'unmark') return { round: roundStore.unmark(session, task) };
    throw invalid('That is not a round action.');
  }

  async function workerSwitch({ leader, task, enabled: on }) {
    if (typeof on !== 'boolean' || !SESSION_RE.test(leader || '') || typeof task !== 'string' || !SESSION_RE.test(task)) throw invalid('Invalid worker.');
    const out = await run(pythonBin, ['-I', script, 'worker-switch', '--leader', leader, '--task', task, '--state', on ? 'on' : 'off'], { env: runEnv(), timeout: 30000 });
    const result = JSON.parse(out);
    if (!result.ok) throw invalid(result.message || 'Refused.', result.status || 404, 'not_found');
    return result;
  }

  return { enabled, write, board, sessions, mark, answer: answerCall, review: reviewTask, round: roundWrite, workerSwitch, reply, sendCheck, readerBoards, page, ttlMs };
}

module.exports = { create, boardCacheDir, SESSION_RE, TTL_MS };
