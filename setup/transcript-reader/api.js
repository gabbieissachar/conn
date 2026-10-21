'use strict';

// HTTP surface for the transcript reader. serve.sh requires this module and hands
// it every request before its shared CORS handling.
//
//   GET  /setup/transcript-reader/out/<page>.html  the built pages, same-origin only
//   GET  /api/transcript-reader/token               same-origin only; the per-start token
//   GET  /api/transcript-reader/state[?follow=1]    page build stamps, the session Herdr
//                                                   has focused, the listed sessions' live panes
//   POST /api/transcript-reader/send                { session_id, text }: the text goes to the
//                                                   one live Herdr pane running that session
//
// The pages embed private transcripts, so they are served here rather than by the
// shared static handler, which sends Access-Control-Allow-Origin: *. Every route
// uses the Herdr organizer's guard (exact Host and Origin, Fetch-Metadata, token)
// and never sends an Access-Control-Allow-* header.
//
// Writes: reader.py rebuilds the pages when a listed session log changes, and adds
// the session Herdr has focused to the reading list while a page follows focus.
// A prompt reaches a pane only through send, which the page calls on a click.
// Nothing here starts, stops or closes a Herdr session, tab or pane.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGuard } = require('../herdr-organizer/guard');
const { childEnv, defaultRunner, SESSION_NAME_RE } = require('../herdr-organizer/adapter');

const API = '/api/transcript-reader/';
const PAGES = new Set(['prototype.html', 'questionnaire.html']);
const TOKEN_HEADER = 'x-transcript-reader-token';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PANE_ID_RE = /^w[A-Za-z0-9]{1,10}:p[A-Za-z0-9]{1,10}$/;
// Newline and tab are the only control characters a message may carry, so no escape
// sequence (such as the end of a bracketed paste) can reach the terminal.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const MAX_TEXT = 4000;
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
  herdrBin = 'herdr', pythonBin = 'python3', projectsDir = path.join(os.homedir(), '.claude', 'projects'),
  outDir = path.join(root, 'setup', 'transcript-reader', 'out'), token,
} = {}) {
  const guard = createGuard({ port, token, tokenHeader: TOKEN_HEADER });
  const readerScript = path.join(root, 'setup', 'transcript-reader', 'reader.py');
  const runEnv = () => childEnv(env);
  const logPaths = new Map();
  let scanned = null;
  let scanning = null;
  const focusSeen = new Map();
  const focus = { seq: 0, herdr: null };
  const build = { running: null, lastEnd: 0, failedAt: 0, error: null, failedAdds: new Map() };
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
        if (snapshot) sessions.push(readSnapshot(entry.name, snapshot));
      }
      scanned = { at: now(), sessions };
      return sessions;
    })().finally(() => { scanning = null; });
    return scanning;
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
    build.running = { args: args[0], adding };
    const started = runner(pythonBin, ['-I', readerScript, ...args], { env: runEnv(), cwd: root, timeoutMs: 60000, maxBytes: 64 * 1024 });
    started.then((result) => {
      if (result.code === 0) { build.error = null; build.failedAt = 0; }
      else {
        build.failedAt = now();
        const lines = (result.stderr || result.stdout || '').trim().split('\n');
        build.error = result.timedOut ? 'The rebuild took over a minute and was stopped.' : (lines[lines.length - 1] || 'The rebuild failed.').slice(0, 200);
        if (adding) build.failedAdds.set(adding, now());
      }
    }).finally(() => { build.running = null; build.lastEnd = now(); });
  }

  // Rebuild when a listed session's log is newer than the page, or add the focused session.
  function maybeRebuild(ids, focused, follow) {
    if (build.running || now() - build.lastEnd < REBUILD_GAP_MS) return;
    if (follow && focused && focused.session_id && !ids.includes(focused.session_id) && logPath(focused.session_id)) {
      const failed = build.failedAdds.get(focused.session_id);
      if (!failed || now() - failed > RETRY_AFTER_FAILURE_MS) { runReader(['follow', focused.session_id], focused.session_id); return; }
    }
    if (build.failedAt && now() - build.failedAt < RETRY_AFTER_FAILURE_MS) return;
    const built = stamp('prototype.stamp');
    const newest = Math.max(0, ...ids.map((id) => { const file = logPath(id); return file ? mtimeMs(file) : 0; }));
    if (ids.length && (built === null || newest > built * 1000)) runReader(['rebuild']);
  }

  async function state(follow) {
    const ids = listed();
    const sessions = await scan();
    const focused = trackFocus(sessions);
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

  // -------------------------------------------------------------------- send

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
    if (sending) throw new RequestError('Another message is still being sent.', 409, 'busy');
    sending = true;
    try {
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
    const verdict = guard.check(req, { requireToken: false });
    if (!verdict.ok) { res.writeHead(verdict.status, { 'Content-Type': 'text/plain' }); res.end(verdict.message); return; }
    if (req.method !== 'GET') { res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('GET only'); return; }
    if (!PAGES.has(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    fs.readFile(path.join(outDir, name), (error, data) => {
      if (error) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not built yet: run python3 setup/transcript-reader/reader.py'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(data);
    });
  }

  async function dispatch(req, res, pathname, query) {
    if (pathname === API + 'token' && req.method === 'GET') {
      const verdict = guard.check(req, { requireToken: false });
      if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
      send(res, 200, { status: 'ok', token: guard.token, header: guard.tokenHeader });
      return;
    }
    const verdict = guard.check(req);
    if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
    if (pathname === API + 'state' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...(await state(query.get('follow') === '1')) });
      return;
    }
    if (pathname === API + 'send' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...(await sendPrompt(await readJsonBody(req))) });
      return;
    }
    fail(res, 404, 'not_found', 'Not found.');
  }

  // Any path that resolves into out/ belongs here, however it is spelled (encoded
  // slashes, doubled slashes, another letter case), so the shared static handler
  // never serves a page or the reading list with its wildcard CORS header.
  function insideOut(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return { inside: true, name: '' }; }
    const full = path.join(root, decoded);
    const base = outDir.toLowerCase();
    const lower = full.toLowerCase();
    if (lower !== base && !lower.startsWith(base + path.sep)) return { inside: false };
    return { inside: true, name: path.relative(outDir, full) };
  }

  // Returns true when the request belongs to this module (and is handled here).
  function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    const page = insideOut(url.pathname);
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

module.exports = { create, checkText, API, TOKEN_HEADER };
