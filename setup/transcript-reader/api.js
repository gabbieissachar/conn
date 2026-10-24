'use strict';

// HTTP surface for the transcript reader. serve.sh requires this module and hands
// it every request before its shared CORS handling.
//
//   GET  /setup/transcript-reader/out/<page>.html  the built pages, opened in a browser tab
//                                                   only; each carries the per-start token
//   GET  /api/transcript-reader/page?name=<page>    the built page again, for a page's own refresh
//   GET  /api/transcript-reader/state[?follow=1]    page build stamps, the session Herdr
//                                                   has focused, the listed sessions' live panes
//   POST /api/transcript-reader/send                { session_id, text }: empties the input box
//                                                   of the one live Herdr pane running that
//                                                   session, then sends the text there
//   POST /api/transcript-reader/reopen              { session_id }: lists a session whose pane
//                                                   has closed, to read again, and rebuilds
//   POST /api/transcript-reader/close               { session_id }: takes a session off the
//                                                   reading list and rebuilds
//
// The pages embed private transcripts, so they are served here rather than by the
// shared static handler, which sends Access-Control-Allow-Origin: *. Every route
// uses the Herdr organizer's guard (exact Host and Origin, Fetch-Metadata, token)
// and never sends an Access-Control-Allow-* header.
//
// Other apps share this origin, so the token is never handed out by an endpoint.
// It is written into a page only when the browser opens that page as a top-level
// document (Fetch-Metadata navigate/document), and the page refuses framing and
// cuts off its opener. A script on another page of this origin therefore cannot
// fetch, frame or open a page to read the token, the transcripts or send a prompt.
//
// Writes: reader.py rebuilds the pages when a listed session log changes or a listed
// session's pane closes (dropping it from the reading list), and adds the session
// Herdr has focused to the reading list while a page follows focus. reopen and close
// change the reading list only on a click in the page.
// A prompt reaches a pane only through send, which the page calls on a click.
// Nothing here starts, stops or closes a Herdr session, tab or pane.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGuard } = require('../herdr-organizer/guard');
const { childEnv, defaultRunner, SESSION_NAME_RE } = require('../herdr-organizer/adapter');

const API = '/api/transcript-reader/';
const PAGES = new Set(['prototype.html', 'questionnaire.html']);
const TOKEN_HEADER = 'x-transcript-reader-token';
// Names the copy of the repo whose pages this server serves, so reader.py can tell its own
// copy's server from another copy's on the same port (reader.py's copy_id computes the same).
const COPY_HEADER = 'x-transcript-reader-copy';
const copyId = (root) => crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16);
// The templates carry this tag; the server fills it in at serve time, so the built
// file never holds a token and the build-time script hash stays valid. The page's
// payload escapes every "<", so the tag cannot occur in transcript text.
const TOKEN_SLOT = '__READER_TOKEN__';
const TOKEN_META = '<meta name="reader-token" content="' + TOKEN_SLOT + '">';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PANE_ID_RE = /^w[A-Za-z0-9]{1,10}:p[A-Za-z0-9]{1,10}$/;
// Newline and tab are the only control characters a message may carry, so no escape
// sequence (such as the end of a bracketed paste) can reach the terminal.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const MAX_TEXT = 4000;
const SENDABLE = new Set(['idle', 'working', 'done']);
// Text left unsent in the pane's input box would join the front of a message, so send
// empties the box first. Ctrl+K and Ctrl+U delete to the end and the start of one screen
// line, and at a line's end or start remove the line break, so pairs of them empty the box
// from wherever the cursor is, and neither interrupts a working agent the way Ctrl+C or
// Esc would. Claude Code ignored a burst of 32 pairs in one write (25 went through), so the
// keys go a few pairs per call with a pause between. 25 calls clear 100 screen lines.
const CLEAR_KEYS = ['ctrl+k', 'ctrl+u', 'ctrl+k', 'ctrl+u', 'ctrl+k', 'ctrl+u', 'ctrl+k', 'ctrl+u'];
const CLEAR_CALLS = 25;
const CLEAR_PAUSE_MS = 40;
const MAX_BODY_BYTES = 16 * 1024;
const SCAN_TTL_MS = 700;
const REBUILD_GAP_MS = 3000;
const RETRY_AFTER_FAILURE_MS = 30000;

class RequestError extends Error {
  constructor(message, status = 400, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message) {
  send(res, status, { status: 'error', code, message });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { done = true; reject(new RequestError('Message too long.', 413)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        resolve(value);
      } catch { reject(new RequestError('Invalid JSON body.')); }
    });
    req.on('error', () => { if (!done) { done = true; reject(new RequestError('Request failed.')); } });
  });
}

// The message exactly as the page showed it, or a RequestError saying why not.
function checkText(value) {
  if (typeof value !== 'string') throw new RequestError('Write a message first.');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new RequestError('Write a message first.');
  if (text.length > MAX_TEXT) throw new RequestError('The message is over ' + MAX_TEXT + ' characters.', 413, 'too_long');
  if (CONTROL_RE.test(text)) throw new RequestError('The message contains control characters.');
  // Herdr would read a leading dash as an option.
  if (text.startsWith('-')) throw new RequestError('The message cannot start with a dash.');
  return text;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function create({
  root, port, runner = defaultRunner, env = process.env, now = () => Date.now(),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  herdrBin = 'herdr', pythonBin = 'python3', projectsDir = path.join(os.homedir(), '.claude', 'projects'),
  claudeSessionsDir = path.join(os.homedir(), '.claude', 'sessions'),
  outDir = path.join(root, 'setup', 'transcript-reader', 'out'), token,
} = {}) {
  const guard = createGuard({ port, token, tokenHeader: TOKEN_HEADER });
  const readerScript = path.join(root, 'setup', 'transcript-reader', 'reader.py');
  const copy = copyId(root);
  const runEnv = () => childEnv(env);
  const logPaths = new Map();
  let scanned = null;
  let scanning = null;
  const focusSeen = new Map();
  const focus = { seq: 0, herdr: null };
  const build = { running: null, lastEnd: 0, failedAt: 0, error: null, failedAdds: new Map(), paneClosed: false };
  // Listed sessions seen running in a pane. One that leaves while Herdr still answers had
  // its pane closed or cleared, so a rebuild runs and reader.py drops it from the list.
  const seenLive = new Set();
  let sending = false;

  // ------------------------------------------------------------- local records

  function listed() {
    let text = '';
    try { text = fs.readFileSync(path.join(outDir, 'sessions.txt'), 'utf8'); } catch { return []; }
    return text.split('\n').map((line) => line.trim()).filter((line) => SESSION_ID_RE.test(line));
  }

  function stamp(name) {
    try {
      const value = Number(fs.readFileSync(path.join(outDir, name), 'utf8').trim());
      return Number.isFinite(value) ? value : null;
    } catch { return null; }
  }

  // The session's log under ~/.claude/projects/<folder>/<id>.jsonl, or null.
  function logPath(sessionId) {
    const known = logPaths.get(sessionId);
    if (known && fs.existsSync(known)) return known;
    let folders = [];
    try { folders = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return null; }
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const candidate = path.join(projectsDir, folder.name, sessionId + '.jsonl');
      if (fs.existsSync(candidate)) { logPaths.set(sessionId, candidate); return candidate; }
    }
    return null;
  }

  function mtimeMs(file) {
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
  }

  // ------------------------------------------------------------------- Herdr

  // Every running named Herdr session with its focused pane and agent panes.
  // Read-only: `herdr session list --json` and `herdr --session <name> api snapshot`.
  async function scan({ fresh = false } = {}) {
    if (!fresh && scanned && now() - scanned.at < SCAN_TTL_MS) return scanned.sessions;
    if (scanning) return scanning;
    scanning = (async () => {
      const listing = await runner(herdrBin, ['session', 'list', '--json'], { env: runEnv(), timeoutMs: 5000 });
      const names = ((listing.code === 0 && parseJson(listing.stdout)) || {}).sessions || [];
      const sessions = [];
      for (const entry of names) {
        // The default session is never addressed, as in the organizer; a name must never read as an option.
        if (!entry || !entry.running || entry.default || typeof entry.name !== 'string' || !SESSION_NAME_RE.test(entry.name)) continue;
        const result = await runner(herdrBin, ['--session', entry.name, 'api', 'snapshot'], { env: runEnv(), timeoutMs: 5000 });
        const snapshot = (((result.code === 0 && parseJson(result.stdout)) || {}).result || {}).snapshot;
        if (snapshot) sessions.push(await checkSessions(readSnapshot(entry.name, snapshot)));
      }
      scanned = { at: now(), sessions };
      return sessions;
    })().finally(() => { scanning = null; });
    return scanning;
  }

  // pid -> session id of every running Claude Code process, from the record each keeps in
  // ~/.claude/sessions (it follows /clear and --resume).
  function runningClaude() {
    const found = new Map();
    let names = [];
    try { names = fs.readdirSync(claudeSessionsDir).filter((name) => name.endsWith('.json')); } catch { return found; }
    for (const name of names) {
      const record = parseJson(fs.readFileSync(path.join(claudeSessionsDir, name), 'utf8')) || {};
      if (!Number.isInteger(record.pid) || typeof record.sessionId !== 'string' || !SESSION_ID_RE.test(record.sessionId)) continue;
      try { process.kill(record.pid, 0); } catch { continue; }
      found.set(record.pid, record.sessionId);
    }
    return found;
  }

  // Herdr keeps the session id it was first told even when Claude is restarted in the same
  // pane (Firstmate swaps a worker's model that way). A Claude pane whose id no running Claude
  // holds takes the session of its foreground Claude process, or none when the pane is back
  // at its shell. Read-only: `herdr pane process-info`, asked only for such panes.
  async function checkSessions(session) {
    const running = runningClaude();
    if (!running.size) return session;
    const held = new Set(running.values());
    for (const pane of session.panes) {
      if (pane.agent !== 'claude' || held.has(pane.session_id)) continue;
      const result = await runner(herdrBin, ['--session', session.name, 'pane', 'process-info', '--pane', pane.pane_id], { env: runEnv(), timeoutMs: 5000 });
      const info = ((((result.code === 0 && parseJson(result.stdout)) || {}).result) || {}).process_info;
      if (!info) continue;
      const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
      const actual = processes.map((process) => running.get(process.pid)).find(Boolean);
      if (actual) pane.session_id = actual;
      else if (!processes.some((process) => process.argv0 === 'claude')) pane.session_id = null;
    }
    return session;
  }

  // A pane's name as Herdr shows it: its own label, else its tab's label, else the terminal title.
  function readSnapshot(name, snapshot) {
    const tabLabels = new Map((snapshot.tabs || []).map((tab) => [tab.tab_id, tab.label || '']));
    const panes = [];
    for (const pane of snapshot.panes || []) {
      const sessionId = (pane.agent_session || {}).value;
      if (typeof pane.pane_id !== 'string' || !PANE_ID_RE.test(pane.pane_id)) continue;
      panes.push({
        pane_id: pane.pane_id,
        session_id: typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? sessionId : null,
        agent: typeof pane.agent === 'string' ? pane.agent : null,
        status: typeof pane.agent_status === 'string' ? pane.agent_status : 'unknown',
        label: String(pane.label || tabLabels.get(pane.tab_id) || pane.terminal_title_stripped || pane.pane_id).slice(0, 120),
      });
    }
    return { name, focused: typeof snapshot.focused_pane_id === 'string' ? snapshot.focused_pane_id : null, panes };
  }

  // The pane Herdr focused most recently. focus.seq moves whenever the focused pane,
  // or the agent session running in it, changes in any Herdr session. Before any
  // change is seen, the only running Herdr session's focus is taken.
  function trackFocus(sessions) {
    for (const session of sessions) {
      const pane = session.panes.find((p) => p.pane_id === session.focused);
      const key = session.focused + '|' + (pane ? pane.session_id : '');
      const before = focusSeen.get(session.name);
      focusSeen.set(session.name, key);
      if (before !== undefined && before !== key) { focus.herdr = session.name; focus.seq += 1; }
    }
    if (focus.herdr === null && sessions.length === 1) { focus.herdr = sessions[0].name; focus.seq += 1; }
    const session = sessions.find((s) => s.name === focus.herdr);
    const pane = session && session.panes.find((p) => p.pane_id === session.focused);
    if (!pane) return null;
    return { seq: focus.seq, herdr: session.name, label: pane.label, session_id: pane.session_id };
  }

  // ----------------------------------------------------------------- rebuilds

  function runReader(args, adding = null) {
    const done = runner(pythonBin, ['-I', readerScript, ...args], { env: runEnv(), cwd: root, timeoutMs: 60000, maxBytes: 64 * 1024 }).then((result) => {
      if (result.code === 0) { build.error = null; build.failedAt = 0; }
      else {
        build.failedAt = now();
        const lines = (result.stderr || result.stdout || '').trim().split('\n');
        build.error = result.timedOut ? 'The rebuild took over a minute and was stopped.' : (lines[lines.length - 1] || 'The rebuild failed.').slice(0, 200);
        if (adding) build.failedAdds.set(adding, now());
      }
      return result;
    }).finally(() => { build.running = null; build.lastEnd = now(); });
    build.running = { args: args[0], adding, done };
    return done;
  }

  // Rebuild when a listed session's log is newer than the page or its pane closed, or add the focused session.
  function maybeRebuild(ids, focused, follow) {
    if (build.running || now() - build.lastEnd < REBUILD_GAP_MS) return;
    if (follow && focused && focused.session_id && !ids.includes(focused.session_id) && logPath(focused.session_id)) {
      const failed = build.failedAdds.get(focused.session_id);
      if (!failed || now() - failed > RETRY_AFTER_FAILURE_MS) { runReader(['follow', focused.session_id], focused.session_id); return; }
    }
    if (build.failedAt && now() - build.failedAt < RETRY_AFTER_FAILURE_MS) return;
    const built = stamp('prototype.stamp');
    const newest = Math.max(0, ...ids.map((id) => { const file = logPath(id); return file ? mtimeMs(file) : 0; }));
    if (ids.length && (build.paneClosed || built === null || newest > built * 1000)) { build.paneClosed = false; runReader(['rebuild']); }
  }

  function notePaneChanges(ids, sessions) {
    if (!sessions.length) return;  // Herdr not answering says nothing about panes
    const live = new Set(sessions.flatMap((session) => session.panes.map((pane) => pane.session_id)));
    for (const id of seenLive) {
      if (live.has(id)) continue;
      seenLive.delete(id);
      if (ids.includes(id)) build.paneClosed = true;
    }
    for (const id of ids) if (live.has(id)) seenLive.add(id);
  }

  async function state(follow) {
    const ids = listed();
    const sessions = await scan();
    const focused = trackFocus(sessions);
    notePaneChanges(ids, sessions);
    maybeRebuild(ids, focused, follow);
    const panes = {};
    for (const session of sessions) {
      for (const pane of session.panes) {
        if (pane.session_id && ids.includes(pane.session_id)) panes[pane.session_id] = { label: pane.label, status: pane.status, herdr: session.name };
      }
    }
    return {
      stamps: { reader: stamp('prototype.stamp'), sheet: stamp('questionnaire.stamp') },
      focus: focused && {
        ...focused,
        listed: focused.session_id ? ids.includes(focused.session_id) : false,
        readable: focused.session_id ? Boolean(logPath(focused.session_id)) : false,
      },
      panes,
      build: { running: Boolean(build.running), adding: build.running ? build.running.adding : null, error: build.error },
    };
  }

  // ------------------------------------------------------------ reopen, close

  // Reopen lists a session to read again, even though its pane has closed; close takes one
  // off the list. Each waits for a running rebuild, runs its own, and answers when the page is built.
  async function changeList(command, body) {
    for (const key of Object.keys(body)) if (key !== 'session_id') throw new RequestError('Unknown field.');
    const sessionId = body.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new RequestError('Invalid session id.');
    if (command === 'reopen' && !logPath(sessionId)) throw new RequestError('That session has no log to read.', 404, 'no_log');
    if (command === 'close' && !listed().includes(sessionId)) throw new RequestError('That session is not on the reading list.', 409, 'not_listed');
    while (build.running) await build.running.done;
    const result = await runReader([command, sessionId]);
    if (result.code !== 0) throw new RequestError(build.error || 'The rebuild failed.', 502, 'rebuild_failed');
    return { stamp: stamp('prototype.stamp') };
  }

  // -------------------------------------------------------------------- send

  // Herdr's guide: a retained agent identity (even idle or done) does not mean the agent is in
  // the foreground; after Ctrl+Z a shell is, and each line sent would run as a command. So the
  // pane's foreground must hold Claude running this very session (by its ~/.claude/sessions
  // record), or a Claude without a record. Read-only: `herdr pane process-info`.
  async function checkForeground(pane, sessionId) {
    const result = await runner(herdrBin, ['--session', pane.herdr, 'pane', 'process-info', '--pane', pane.pane_id], { env: runEnv(), timeoutMs: 5000 });
    const info = ((((result.code === 0 && parseJson(result.stdout)) || {}).result) || {}).process_info;
    if (!info) throw new RequestError('Herdr could not say what runs in the pane, so nothing was sent. Check the pane first.', 502, 'herdr_failed');
    const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
    const running = runningClaude();
    const held = processes.map((process) => running.get(process.pid)).filter(Boolean);
    if (held.includes(sessionId)) return;
    if (held.length) throw new RequestError('The pane now runs another Claude session, so nothing was sent. Reload the page.', 409, 'other_session');
    if (processes.some((process) => process.argv0 === 'claude')) return;
    throw new RequestError('The agent is not in the foreground of its pane (it may be suspended to a shell), so nothing was sent. Check the pane first.', 409, 'agent_not_foreground');
  }

  async function sendPrompt(body) {
    for (const key of Object.keys(body)) if (key !== 'session_id' && key !== 'text') throw new RequestError('Unknown field.');
    const sessionId = body.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new RequestError('Invalid session id.');
    const text = checkText(body.text);
    if (!listed().includes(sessionId)) throw new RequestError('That session is not on the reading list.', 409, 'not_listed');
    const sessions = await scan({ fresh: true });
    const matches = sessions.flatMap((session) => session.panes.filter((p) => p.session_id === sessionId).map((p) => ({ ...p, herdr: session.name })));
    if (!matches.length) throw new RequestError('No live Herdr pane is running that session, so nothing was sent.', 409, 'no_pane');
    if (matches.length > 1) throw new RequestError('Several Herdr panes show that session, so nothing was sent.', 409, 'several_panes');
    const pane = matches[0];
    if (pane.status === 'blocked') throw new RequestError('The agent is waiting at a permission prompt or question, so nothing was sent. Answer it in Herdr first.', 409, 'agent_blocked');
    // Herdr's own guide: `unknown` (or any other state) does not show the agent is in the
    // foreground, so the text could land in a shell. A working agent queues the message.
    if (!SENDABLE.has(pane.status)) throw new RequestError('Herdr cannot tell what the agent is doing (it may be suspended to a shell), so nothing was sent. Check the pane first.', 409, 'agent_unknown');
    await checkForeground(pane, sessionId);
    if (sending) throw new RequestError('Another message is still being sent.', 409, 'busy');
    sending = true;
    try {
      for (let i = 0; i < CLEAR_CALLS; i += 1) {
        if (i) await pause(CLEAR_PAUSE_MS);
        const cleared = await runner(herdrBin, ['--session', pane.herdr, 'agent', 'send-keys', pane.pane_id, ...CLEAR_KEYS], { env: runEnv(), timeoutMs: 5000 });
        if (cleared.code !== 0) throw new RequestError('Herdr could not empty the pane\'s input box, so nothing was sent. Check the pane before sending again.', 502, 'herdr_failed');
      }
      const result = await runner(herdrBin, ['--session', pane.herdr, 'agent', 'prompt', pane.pane_id, text], { env: runEnv(), timeoutMs: 15000 });
      if (result.code !== 0) {
        if (/agent_blocked/.test(result.stdout + result.stderr)) throw new RequestError('The agent is waiting at a permission prompt or question, so nothing was sent. Answer it in Herdr first.', 409, 'agent_blocked');
        throw new RequestError(result.timedOut ? 'Herdr did not answer in time; check the pane before sending again.' : 'Herdr did not accept the message.', 502, 'herdr_failed');
      }
    } finally { sending = false; }
    return { label: pane.label, herdr: pane.herdr, status: pane.status };
  }

  // ------------------------------------------------------------------- routes

  function servePage(req, res, name) {
    const text = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
    const verdict = guard.check(req, { requireToken: false });
    if (!verdict.ok) { text(verdict.status, verdict.message); return; }
    if (req.method !== 'GET') { text(405, 'GET only'); return; }
    // Only a browser tab opening the page gets it (and so the token), never a script's
    // fetch, a frame or an embed. Like the guard, a request without Fetch-Metadata
    // (curl, an old browser) is let through.
    const mode = req.headers['sec-fetch-mode'];
    const dest = req.headers['sec-fetch-dest'];
    if ((mode !== undefined && mode !== 'navigate') || (dest !== undefined && dest !== 'document')) {
      text(403, 'Open this page in its own browser tab.');
      return;
    }
    if (!PAGES.has(name)) { text(404, 'Not found'); return; }
    fs.readFile(path.join(outDir, name), 'utf8', (error, html) => {
      if (error) { text(404, 'Not built yet: run python3 setup/transcript-reader/reader.py'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
        [COPY_HEADER]: copy,
      });
      res.end(html.replace(TOKEN_META, () => TOKEN_META.replace(TOKEN_SLOT, guard.token)));
    });
  }

  async function dispatch(req, res, pathname, query) {
    const verdict = guard.check(req);
    if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
    if (pathname === API + 'page' && req.method === 'GET') {
      const name = query.get('name');
      if (!PAGES.has(name)) { fail(res, 404, 'not_found', 'Not found.'); return; }
      let html;
      try { html = fs.readFileSync(path.join(outDir, name), 'utf8'); } catch { fail(res, 404, 'not_built', 'Not built yet.'); return; }
      send(res, 200, { status: 'ok', html });
      return;
    }
    if (pathname === API + 'state' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...(await state(query.get('follow') === '1')) });
      return;
    }
    if (pathname === API + 'send' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...(await sendPrompt(await readJsonBody(req))) });
      return;
    }
    for (const command of ['reopen', 'close']) {
      if (pathname === API + command && req.method === 'POST') {
        send(res, 200, { status: 'ok', ...(await changeList(command, await readJsonBody(req))) });
        return;
      }
    }
    fail(res, 404, 'not_found', 'Not found.');
  }

  // Where a path really is, as the file system resolves it: the nearest existing
  // part goes through realpath (symlinks, and macOS's own case and Unicode folding),
  // and the missing rest is appended as spelled.
  function realLocation(full) {
    const rest = [];
    let head = full;
    for (;;) {
      try { return path.join(fs.realpathSync.native(head), ...rest); } catch { /* not there: try its parent */ }
      const parent = path.dirname(head);
      if (parent === head) return full;
      rest.unshift(path.basename(head));
      head = parent;
    }
  }

  // Any request whose path lands in out/ belongs here, however it is spelled (encoded
  // slashes, doubled slashes, another letter case or Unicode form, a symlink), so the
  // shared static handler never serves a page or the reading list with its wildcard
  // CORS header. Both spellings are checked: the parsed URL, and the raw one that
  // serve.sh's static handler decodes.
  function insideOut(req, url) {
    const realOut = realLocation(outDir);
    for (const spelling of [url.pathname, req.url.split('?')[0]]) {
      let decoded;
      try { decoded = decodeURIComponent(spelling); } catch { return { inside: true, name: '' }; }
      const real = realLocation(path.join(root, decoded));
      if (real === realOut || real.startsWith(realOut + path.sep)) return { inside: true, name: path.relative(realOut, real) };
    }
    return { inside: false };
  }

  // Returns true when the request belongs to this module (and is handled here).
  function handle(req, res) {
    let url;
    // A request URL nothing can parse may still name out/, so it is refused here rather
    // than passed on to the shared static handler.
    try { url = new URL(req.url, 'http://localhost'); } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Bad request');
      return true;
    }
    const page = insideOut(req, url);
    if (page.inside) { servePage(req, res, page.name); return true; }
    if (!url.pathname.startsWith(API)) return false;
    dispatch(req, res, url.pathname, url.searchParams).catch((error) => {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof RequestError) fail(res, error.status, error.code, error.message);
      else fail(res, 500, 'internal', 'Unexpected error.');
    });
    return true;
  }

  return { handle, guard, scan };
}

module.exports = { create, checkText, API, TOKEN_HEADER, TOKEN_META, COPY_HEADER };
