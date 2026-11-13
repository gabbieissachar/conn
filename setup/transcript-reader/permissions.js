'use strict';

// Claude Code's permission asks, answered from the reader page (DESIGN.md, "Claude permission asks in the reader").
//
// How an ask reaches the reader. A Claude Code run calls its PermissionRequest hook when it is about to show a permission dialog, passing the
// session id, the tool and the whole tool input on stdin (hooks/permission-hook.py, a command hook set up in the Claude config folder's
// settings.json by `permission-hook.py install`). The hook posts that to this module's route and WAITS for the answer, then prints Claude Code's
// own allow or deny JSON. So the ask arrives whole and structured, bound to one session by id, and the answer goes back to the one tool call
// that asked: no key is typed into any pane.
//
// What is kept and what is refused (the same rules as the Campus permission ask):
//   - What is asked is shown whole. An input too big to show whole (MAX_SHOWN_BYTES) is never taken: the hook is told "no answer from here" and the
//     dialog in the pane is the only way, as it was.
//   - The answers are Allow once and Deny. No standing grant is ever returned (the hook never sends updatedPermissions; the dialog's "don't ask
//     again" stays in the pane). A Deny stops the turn as Esc does (interrupt) unless a switch says otherwise.
//   - An answer names the ask by its id and by a digest of what the page showed. A card that shows something else than the live ask is refused.
//   - The ask must still be the one on screen. Claude Code shows its own dialog and runs the hook beside it, and does not end the hook when the dialog
//     is answered in the pane (read from the installed binary, DESIGN.md), so three things are checked: the hook call is still waiting, Herdr still
//     reports the pane at a prompt (`blocked`), and the session log has no result for that exact tool call yet (permlog.js; the hook's input has no
//     tool id, so the call is found by its tool and input). Any one missing refuses the answer and says the agent moved on. While an ask is open the
//     same checks run every SWEEP_MS, so a dialog answered in the pane turns its card into "Answered in the pane" within about two seconds.
//   - An ask is taken only while a reader page is open (someone is looking) and only for a listed session. Otherwise the hook returns at once and
//     the dialog in the pane works as before. The hook also fails open on any error (no output, exit 0 = no decision).
//   - Answers are written from the laptop's own page only (loopback); a phone sees the ask and the record, with no buttons.
//
// Records of the asks (open and answered) are kept in one owner-only file, outside the repo, so the conversation shows "Answered: ..." where the
// ask was, after a restart too. It holds what was asked (the tool and its input) because the record is for reading it again; it is capped
// (MAX_RECORDS, MAX_FILE_BYTES) and a record older than KEEP_DAYS is dropped.
//
// The route, the guard and the page are in api.js and the page template; this file is the broker and has no HTTP in it.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FOLDER = 'pmos-transcript-reader';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SHOWN_BYTES = 200 * 1024;       // the largest tool input shown whole
const MAX_RECORDS = 100;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const KEEP_DAYS = 14;
const DEFAULT_WAIT_MS = 10 * 60 * 1000;   // how long a hook call is held for an answer before it is told "no answer from here"
const MAX_SUGGESTIONS = 8;
const SWEEP_MS = 1500;                    // how often an open ask is checked against Herdr and the session log
const SEEN_GRACE_MS = 8 * 1000;           // how long Herdr has to show the pane at a prompt before the ask is let go (the pane's own dialog is then the way)
const PRESENCE_MS = 30 * 1000;            // a reader page that asked for the asks this recently, or is waiting on them now, is open and looking
const DECISIONS = new Set(['allow', 'deny']);

class PermissionError extends Error {
  constructor(message, status = 400, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const defaultFile = (env = process.env) => env.PMOS_READER_PERMISSIONS_FILE || path.join(os.homedir(), '.config', FOLDER, 'permission-asks.json');
// Where the running server tells the hook its port and key (owner-only). The key is for the hook's route only; it opens nothing else.
const defaultHookFile = (env = process.env) => env.PMOS_READER_HOOK_FILE || path.join(os.homedir(), '.config', FOLDER, 'permission-hook.json');

// A stable text for a tool input, so the digest of what a page showed matches the digest of the live ask however the keys were ordered.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}
const digestOf = (tool, input) => crypto.createHash('sha256').update(tool + '\n' + canonical(input)).digest('hex').slice(0, 24);

function create({
  now = () => Date.now(), file = defaultFile(), hookFile = defaultHookFile(), enabled = false,
  // () -> the session ids on the reading list; async (sessionId, { fresh }) -> Herdr's status for the one pane that runs it now, or null (fresh: a new reading, for an answer)
  listed = () => [], paneStatus = async () => null,
  // async (record) -> 'done' | 'pending' | 'unknown': whether the session log has a result for the tool call yet (permlog.js)
  logState = async () => 'unknown',
  sweepMs = SWEEP_MS,
  // Whether a page must be open and looking for an ask to be taken (on; a unit test of the broker alone turns it off).
  needPage = true,
  // Whether the Herdr check is made at all (on by default; a lab with no Herdr to ask turns it off, never the live reader).
  herdrCheck = true,
  waitMs = DEFAULT_WAIT_MS, denyInterrupts = true,
  random = (bytes) => crypto.randomBytes(bytes),
} = {}) {
  const key = random(32).toString('hex');
  let rev = 0;
  let records = [];        // newest first
  const calls = new Map(); // id -> { resolve, timer } while a hook call is held
  const waiters = new Set();
  let lastTouch = 0;
  let sweeper = null;
  // A page is open and looking while it waits on the asks (every visible reader page does), or asked for them a moment ago.
  const looking = () => !needPage || waiters.size > 0 || now() - lastTouch < PRESENCE_MS;

  const changed = () => {
    rev += 1;
    for (const waiter of [...waiters]) finishWaiter(waiter);
  };
  function finishWaiter(waiter) {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.done();
  }

  // ------------------------------------------------------------------ the file
  function load() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }
    if (!(parsed && parsed.version === 1 && Array.isArray(parsed.records))) return;
    const cutoff = now() / 1000 - KEEP_DAYS * 86400;
    // An ask that was open when the server stopped has no hook call waiting now: it is over, and says so.
    records = parsed.records.filter(valid).filter((record) => record.at >= cutoff)
      .map((record) => (record.state === 'open' ? { ...record, state: 'gone', ended_at: Math.floor(now() / 1000) } : record)).slice(0, MAX_RECORDS);
  }
  function valid(record) {
    return Boolean(record) && typeof record === 'object' && typeof record.id === 'string' && SESSION_ID_RE.test(record.session_id || '')
      && typeof record.tool === 'string' && Number.isFinite(record.at) && typeof record.state === 'string' && record.input && typeof record.input === 'object';
  }
  function save() {
    if (!enabled) return;
    let list = records;
    let text = JSON.stringify({ version: 1, rev, records: list });
    while (Buffer.byteLength(text) > MAX_FILE_BYTES && list.length > 1) { list = list.slice(0, Math.ceil(list.length * 0.8)); text = JSON.stringify({ version: 1, rev, records: list }); }
    records = list;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(temp, text, { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch { /* the records stay in memory; a file that cannot be written is not a reason to refuse an answer */ }
  }
  function publishHook(port) {
    if (!enabled || !hookFile) return;
    try {
      fs.mkdirSync(path.dirname(hookFile), { recursive: true, mode: 0o700 });
      const temp = hookFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({ version: 1, port, key, pid: process.pid, started: Math.floor(now() / 1000) }), { mode: 0o600 });
      fs.renameSync(temp, hookFile);
    } catch { /* the hook then finds no server and leaves the dialog alone */ }
  }
  function unpublishHook() {
    if (!enabled || !hookFile) return;
    try {
      const current = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
      if (current && current.key === key) fs.writeFileSync(hookFile, JSON.stringify({ version: 1, port: 0, key: '', pid: 0, started: 0 }), { mode: 0o600 });
    } catch { /* nothing of this server's is there */ }
  }

  // ----------------------------------------------------------- what the hook sends
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

  // The hook's route. `payload` is what Claude Code gave the hook on stdin. `signal` is { onClose(fn) }: the call's connection ending
  // (the hook process died, or the dialog was answered in the pane and Claude Code ended the hook). Resolves { decision: 'allow' | 'deny' | 'none', message? }.
  function ask(payload, connection) {
    const none = (why) => Promise.resolve({ decision: 'none', why });
    if (!enabled) return none('off');
    if (!payload || typeof payload !== 'object' || payload.hook_event_name !== 'PermissionRequest') return none('not a permission request');
    const session = payload.session_id;
    const tool = text(payload.tool_name, 200);
    const input = payload.tool_input;
    if (typeof session !== 'string' || !SESSION_ID_RE.test(session) || !tool || !input || typeof input !== 'object' || Array.isArray(input)) return none('unreadable');
    if (!listed().includes(session)) return none('not listed');
    if (!looking()) return none('nobody is looking');
    if (Buffer.byteLength(canonical(input)) > MAX_SHOWN_BYTES) return none('too big to show whole');
    const at = Math.floor(now() / 1000);
    const record = {
      id: 'p' + random(6).toString('hex'), session_id: session, tool, input, at, state: 'open', digest: digestOf(tool, input),
      cwd: text(payload.cwd, 1024), mode: text(payload.permission_mode, 40), tool_use_id: text(payload.tool_use_id, 80) || null,
      // What Claude Code also offers in its dialog and this route never grants, so the card can say "answer it in the pane for that".
      suggestions: Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions.slice(0, MAX_SUGGESTIONS).map(describeSuggestion).filter(Boolean) : [],
    };
    records.unshift(record);
    if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
    changed();
    save();
    startSweeping();
    return new Promise((resolve) => {
      const hold = { resolve, timer: null };
      calls.set(record.id, hold);
      const end = (state, result) => {
        if (calls.get(record.id) !== hold) return;
        calls.delete(record.id);
        clearTimeout(hold.timer);
        if (record.state === 'open') { record.state = state; record.ended_at = Math.floor(now() / 1000); changed(); save(); }
        resolve(result);
      };
      hold.end = end;
      hold.timer = setTimeout(() => end('expired', { decision: 'none', why: 'no answer in time' }), waitMs);
      if (hold.timer.unref) hold.timer.unref();
      // The hook ended before an answer: the dialog was answered in the pane (or the run was stopped). The record says so, and no answer is taken for it.
      if (connection && typeof connection.onClose === 'function') connection.onClose(() => end('elsewhere', { decision: 'none', why: 'ended' }));
    });
  }

  function describeSuggestion(suggestion) {
    if (!suggestion || typeof suggestion !== 'object') return null;
    const rules = Array.isArray(suggestion.rules) ? suggestion.rules.map((rule) => text(rule && (rule.ruleContent || rule.toolName), 200)).filter(Boolean).join(', ') : '';
    const kind = text(suggestion.type, 40);
    return (kind + (rules ? ': ' + rules : '')).slice(0, 300) || null;
  }

  // ------------------------------------------------------------------ keeping asks true
  // Each open ask is checked against what is on screen. Claude Code does not end the hook when its dialog is answered in the pane, so without this a card
  // would stay open (and its buttons would answer nothing) until the hook's own limit. A pane seen at a prompt that no longer is, or a tool call the log
  // now has a result for, ends the ask as answered in the pane; a pane never seen at a prompt within SEEN_GRACE_MS ends it as expired. Either way the hook is
  // told "no answer from here", which leaves the pane's own dialog as it is.
  async function sweep() {
    for (const record of records.filter((entry) => entry.state === 'open')) {
      const hold = calls.get(record.id);
      if (!hold || !hold.end) continue;
      let status = null;
      try { status = herdrCheck ? await paneStatus(record.session_id, { fresh: false }) : 'blocked'; } catch { status = null; }
      if (record.state !== 'open' || calls.get(record.id) !== hold) continue;
      if (status === 'blocked') record.seen = true;
      else if (record.seen) { hold.end('elsewhere', { decision: 'none', why: 'the pane moved on' }); continue; }
      else if (now() - record.at * 1000 > SEEN_GRACE_MS) { hold.end('expired', { decision: 'none', why: 'the pane was never seen at a prompt' }); continue; }
      let done = 'unknown';
      try { done = await logState(record); } catch { done = 'unknown'; }
      if (record.state === 'open' && calls.get(record.id) === hold && done === 'done') hold.end('elsewhere', { decision: 'none', why: 'answered in the pane' });
    }
    if (!records.some((entry) => entry.state === 'open')) stopSweeping();
  }
  function startSweeping() {
    if (sweeper || !(sweepMs > 0)) return;
    sweeper = setInterval(() => { sweep().catch(() => {}); }, sweepMs);
    if (sweeper.unref) sweeper.unref();
  }
  function stopSweeping() {
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
  }

  // ------------------------------------------------------------- the page's side
  // `shown` is the digest the page drew the card from. Answers only for an ask that is open, is what was shown, is still waiting, and whose
  // pane Herdr still reports at a prompt.
  async function answer({ id, shown, decision }) {
    if (!enabled) throw new PermissionError('Answering from the reader is off.', 409, 'off');
    if (typeof id !== 'string' || !/^p[0-9a-f]{12}$/.test(id)) throw new PermissionError('Invalid ask.');
    if (!DECISIONS.has(decision)) throw new PermissionError('Choose Allow once or Deny.');
    const record = records.find((entry) => entry.id === id);
    if (!record) throw new PermissionError('That ask is not here any more.', 409, 'gone');
    if (record.state !== 'open') throw new PermissionError(describeOver(record), 409, 'over');
    if (typeof shown !== 'string' || shown !== record.digest) throw new PermissionError('What the agent asks is not what the card showed. Read it again.', 409, 'changed');
    const hold = calls.get(id);
    if (!hold) throw new PermissionError('That ask is over: the agent is not waiting for it any more.', 409, 'over');
    if (herdrCheck) {
      const status = await paneStatus(record.session_id, { fresh: true });
      // Herdr was asked a moment ago (a fresh read); the ask may have ended while it answered.
      if (record.state !== 'open' || calls.get(id) !== hold) throw new PermissionError(describeOver(record), 409, 'over');
      if (status !== 'blocked') {
        throw new PermissionError(status === null ? 'Herdr does not show one pane for that session, so nothing was answered. Check the pane.' : 'The agent is not at a permission prompt now (it moved on), so nothing was answered.', 409, status === null ? 'no_pane' : 'moved_on');
      }
      // The log may already hold the call's result (answered in the pane while another ask keeps the pane at a prompt): that ask is over.
      if (await logState(record) === 'done') {
        if (record.state === 'open' && calls.get(id) === hold) hold.end('elsewhere', { decision: 'none', why: 'answered in the pane' });
        throw new PermissionError(describeOver(record), 409, 'over');
      }
      if (record.state !== 'open' || calls.get(id) !== hold) throw new PermissionError(describeOver(record), 409, 'over');
    }
    record.state = decision === 'allow' ? 'allowed' : 'denied';
    record.answered_at = Math.floor(now() / 1000);
    record.by = 'reader';
    changed();
    save();
    hold.end(record.state, decision === 'allow' ? { decision: 'allow' } : { decision: 'deny', message: 'The person denied this from the transcript reader.', interrupt: denyInterrupts });
    return view(record);
  }
  function describeOver(record) {
    if (record.state === 'allowed' || record.state === 'denied') return 'That ask was already answered.';
    if (record.state === 'elsewhere') return 'That ask was answered in the pane (or the run moved on), so nothing was sent from here.';
    return 'That ask is over, so nothing was sent.';
  }

  // The page's view of one record: all of what was asked, and how it ended.
  function view(record) {
    return {
      id: record.id, session: record.session_id, tool: record.tool, input: record.input, cwd: record.cwd, mode: record.mode, at: record.at,
      state: record.state, digest: record.digest, answered_at: record.answered_at || null, ended_at: record.ended_at || null, suggestions: record.suggestions || [],
    };
  }

  // What the page asks for one session: the open ask(s) and the newest records, with the revision the page waits past.
  function list(session, { touch = true } = {}) {
    if (touch) lastTouch = now();
    const mine = typeof session === 'string' ? records.filter((record) => record.session_id === session) : records;
    return { rev, enabled, asks: mine.slice(0, 50).map(view) };
  }
  // For the state poll: only which sessions have an open ask, so the picker can mark them.
  function open() {
    const out = {};
    for (const record of records) if (record.state === 'open') out[record.session_id] = (out[record.session_id] || 0) + 1;
    return out;
  }
  // Answers when something changed after `have` (at once if it already did), or after ms.
  function wait(have, ms) {
    return new Promise((resolve) => {
      if (!Number.isFinite(have) || rev > have || ms <= 0) { resolve(); return; }
      const waiter = { timer: null, done: resolve };
      waiter.timer = setTimeout(() => finishWaiter(waiter), ms);
      if (waiter.timer.unref) waiter.timer.unref();
      waiters.add(waiter);
    });
  }
  const hookKeyMatches = (candidate) => {
    if (typeof candidate !== 'string' || candidate.length !== key.length) return false;
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(key));
  };
  // The server stopped: the hooks still waiting are told to leave the dialog alone.
  function close() {
    stopSweeping();
    for (const [id, hold] of [...calls]) { if (hold.end) hold.end('gone', { decision: 'none', why: 'server stopped' }); calls.delete(id); }
    for (const waiter of [...waiters]) finishWaiter(waiter);
    unpublishHook();
  }

  load();
  return { enabled, ask, answer, sweep, list, open, wait, view, close, publishHook, hookKeyMatches, digestOf, rev: () => rev };
}

module.exports = { create, PermissionError, canonical, digestOf, defaultFile, defaultHookFile, MAX_SHOWN_BYTES, MAX_RECORDS, KEEP_DAYS, SESSION_ID_RE, SEEN_GRACE_MS, SWEEP_MS };
