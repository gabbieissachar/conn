'use strict';

// HTTP surface for the transcript reader. server.js (the reader's own server) hands
// every request to this module.
//
//   GET  /setup/transcript-reader/out/<page>.html  the built pages, opened in a browser tab
//                                                   only; each carries the per-start token
//   GET  /setup/transcript-reader/out/hosted/index.html
//                                                   the hosted copy's shell (sync.py), the same way
//   GET  /setup/transcript-reader/out/{hosted,bucket}/{sw.js,manifest.webmanifest,icon-*.png}
//                                                   the offline copy's service worker, web app manifest and icons
//                                                   (no transcript), for the shell that installs them
//   GET  /setup/transcript-reader/out/hosted/{index.json,s/*,d/*,f/*,a/*,r/*}
//                                                   the objects that shell loads (r/ holds the receipts of
//                                                   its queued sends), to its own token-bearing fetches only
//   GET  /setup/transcript-reader/out/bucket/...    the sealed copy (sync.py --seal):
//                                                   its shell, k/params.json and the
//                                                   *.enc objects, the same ways
//   GET  /api/transcript-reader/page?name=<page>    the built page again, for a page's own refresh
//   GET  /api/transcript-reader/state[?follow=1]    page build stamps, the session Herdr
//                                                   has focused, the listed sessions' live panes
//   GET  /api/transcript-reader/events?reader=<stamp>&sheet=<stamp>&wait=<ms>
//                                                   answers with the build stamps as soon as a page build is newer than the
//                                                   stamp(s) given, or after the wait (at most 30 s) with the same stamps: how an
//                                                   open page learns of a new build at once instead of at its next poll
//   POST /api/transcript-reader/sync                the Sync button: reads Herdr again at once, lists every live
//                                                   Claude pane's session that is not listed (unless a person closed
//                                                   or removed it) and rebuilds the pages from the session logs and
//                                                   the fleet records, then answers as state does, with the time
//                                                   it finished
//   GET  /api/transcript-reader/pins                the pinned messages (pinstore.js: a small owner-only file
//                                                   outside the repo) and their revision
//   POST /api/transcript-reader/pins                { op: "pin", key, conv, at } or { op: "unpin", key }
//   GET  /api/transcript-reader/stars               the starred sessions of the picker (the same store, in a file
//                                                   beside the pins) and their revision
//   POST /api/transcript-reader/stars               { op: "star", conv } or { op: "unstar", conv }
//   POST /api/transcript-reader/send                { session_id, text }: empties the input box
//                                                   of the one live Herdr pane running that
//                                                   session, then sends the text there
//   POST /api/transcript-reader/queue               a hosted copy's Send: { copy: "hosted", id, object:
//                                                   { session_id, text, at } } writes out/hosted/q/<id>.json;
//                                                   { copy: "bucket", id, data } writes the sealed bytes the
//                                                   page made (base64) to out/bucket/q/<id>.json.enc, so the
//                                                   server never sees the text. Nothing is sent to Herdr:
//                                                   drain.js (run by the sync agent) delivers it later.
//   POST /api/transcript-reader/html-open           { id }: an HTML file the page offers (listed beside it in
//                                                   out/html-files.json) is checked now (still there, under the
//                                                   home or a temp folder, not over the size limit) and given an
//                                                   address: { url, name, size, mtime }
//   POST /api/transcript-reader/image-open          { id }: the same for an image file the page offers (listed in
//                                                   out/image-files.json): { url, name, size, mtime }
//   GET  /api/transcript-reader/html/<key>/<file>   that file, and the files beside it and below it that it names, as
//                                                   they are on disk now, for the page to show in a sandboxed frame
//                                                   (see "HTML files" below); the key in the address is the credential.
//                                                   An image's address serves that image and nothing else.
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
// HTML files. A reply that names an HTML file (a throwaway sketch, a report) gets a button; the page
// asks html-open for an address and shows it in an iframe with sandbox="allow-scripts" and no
// allow-same-origin, so the file's scripts run but cannot reach the reader's origin, cookies, token
// or API. That frame, and the files it loads, send no token, and a sandboxed frame is cross-site
// to everything (Fetch-Metadata, SameSite), so the address itself is the credential: a random key
// minted by html-open (token-guarded), held in memory for an hour of disuse and handed to no one
// else. Every answer carries a Content-Security-Policy that sandboxes the response itself and lets
// the file load only what sits beside it (no network, no frames, no forms, no fetch), and the
// guard still checks Host (so DNS rebinding cannot reach it) and Origin. Only files under the home
// and temp folders are served, only those the page offers, and beside one only files below its own
// folder (never a dot file or folder, never a link out of it, and only the types in ASSET_TYPES);
// an HTML file directly in the home or a temp folder gets its own folder's files and no deeper.
//
// Image files (.png .jpg .jpeg .gif .webp .svg) a reply names are offered the same way (image-open, the same kind of address,
// the same folder and link rules), but the page shows one in an <img> of its own, not a frame, so an SVG's scripts never run
// (an image document runs none), and the address serves that one file and nothing beside it. The response is sandboxed by its own
// policy too, so an SVG opened alone in a tab runs no script either.
//
// A request that came in on the Tailscale listener (server.js, opt-in) first goes through
// tailnet.js: a passcode and a session cookie on top of all of this, with that listener's own
// Host and Origin. Loopback requests do not.
//
// The reader has its own server, but the token is still never handed out by an endpoint.
// It is written into a page only when the browser opens that page as a top-level
// document (Fetch-Metadata navigate/document), and the page refuses framing and
// cuts off its opener. A script on another page of this origin therefore cannot
// fetch, frame or open a page to read the token, the transcripts or send a prompt.
//
// Writes: reader.py rebuilds the pages when a listed session log changes or a listed
// session's pane closes (dropping it from the reading list), and adds the session
// Herdr has focused to the reading list while a page follows focus. While a page is open (it polls, or waits on events) the
// server itself watches the folders of the listed logs and starts the rebuild when one changes, rather than at the page's
// next poll; with no page open it watches nothing and rebuilds nothing. The rebuilds run in one reader.py that stays running
// (worker.js), which falls back to a fresh reader.py for a request it cannot take. reopen and close
// change the reading list only on a click in the page, and so does sync, which also lists
// every live Claude pane's session not yet listed, except one a person closed or removed. The pins and stars files are the only things written outside out/, and only on a pin, an unpin, a star or an unstar.
// A prompt reaches a pane only through send, which the page calls on a click, or through
// the hosted copy's queue: queue writes the request to a folder and drain.js sends it later
// through this module's own sendPrompt, so both routes check the pane the same way.
// Nothing here starts, stops or closes a Herdr session, tab or pane.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGuard } = require('../herdr-organizer/guard');
const tailnetLane = require('./tailnet');
const deltaStore = require('./delta');
const pinstore = require('./pinstore');
const workerLib = require('./worker');
const { childEnv, defaultRunner, SESSION_NAME_RE } = require('../herdr-organizer/adapter');

const API = '/api/transcript-reader/';
const PAGES = new Set(['prototype.html', 'questionnaire.html', 'hosted/index.html', 'hosted/sheet.html', 'bucket/index.html', 'bucket/sheet.html']);
// The hosted copy's objects by their path under out/hosted/ (sync.py names them), and the sealed
// copy's under out/bucket/. The manifest, the pane cache and the upload records are never served.
const OBJECTS = {
  hosted: { re: /^(?:index|[sdfar]\/[A-Za-z0-9_-]{1,64})\.json$/, type: 'application/json; charset=utf-8' },
  bucket: { re: /^(?:(?:index|[sdfar]\/[A-Za-z0-9_-]{1,64})\.json\.enc|k\/params\.json)$/, type: 'application/octet-stream' },
};
// The shell pages of a copy: opened in a tab (and so given the token), or, for the offline copy's cache, fetched by the page itself
// with the token it already holds (see servePage).
const SHELL_PAGES = new Set(['hosted/index.html', 'hosted/sheet.html', 'bucket/index.html', 'bucket/sheet.html']);
// What sits beside a copy's shell pages and holds no transcript: the offline copy's service worker, its manifest and icons (sync.py).
const STATIC_TYPES = {
  'sw.js': 'text/javascript; charset=utf-8', 'manifest.webmanifest': 'application/manifest+json; charset=utf-8',
  'icon-180.png': 'image/png', 'icon-512.png': 'image/png',
};
const TOKEN_HEADER = 'x-transcript-reader-token';
const HTML_ROUTE = API + 'html/';
const HTML_FILES = 'html-files.json';  // beside the page: id -> path (build_prototype.write_page)
const IMAGE_FILES = 'image-files.json';  // the same for the images the page offers
const HTML_ID_RE = /^[0-9a-f]{10}$/;
const HTML_PAGE_RE = /\.html?$/i;
const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
// build_prototype.MAX_HTML_BYTES and MAX_IMAGE_BYTES: what the page offers. A file beside an HTML page may be larger (a picture).
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const VIEW_IDLE_MS = 60 * 60 * 1000;
const MAX_VIEWS = 64;
const TEXT_UTF8 = (type) => type + '; charset=utf-8';
// What a shown file may load from its folder: its pages, styles, scripts and pictures. Fonts, media and
// anything else are not served (a font or a module script is a CORS fetch, which this server never answers).
const ASSET_TYPES = {
  '.html': TEXT_UTF8('text/html'), '.htm': TEXT_UTF8('text/html'), '.css': TEXT_UTF8('text/css'), '.js': TEXT_UTF8('text/javascript'),
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};
// The file's own scripts and styles run (inline, or from beside it) and nothing leaves: no network, no frames, no forms.
// "sandbox allow-scripts" makes the response itself a sandboxed page whatever frames it, or opens it alone in a tab.
const VIEW_CSP = ["sandbox allow-scripts", "default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' data: blob:", "connect-src 'none'", "frame-src 'none'",
  "object-src 'none'", "form-action 'none'", "base-uri 'self'", "frame-ancestors 'self'"].join('; ');
const ASSET_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'";
// Names the copy of the repo whose pages this server serves, so reader.py and serve.sh can tell
// their own copy's server from another copy's on the same port (reader.py's copy_id computes the same).
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
// A queued send carries up to MAX_TEXT characters, sealed and in base64, so its route takes a larger body.
const MAX_QUEUE_BODY_BYTES = 64 * 1024;
const MAX_QUEUED = 50;
const QUEUE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEALED_MAGIC = Buffer.from('HRC1');
const SCAN_TTL_MS = 700;
// Between two rebuilds, a short pause: a log changed during a rebuild is picked up by the next one at once, and a writer that
// writes without a pause does not start rebuilds faster than a build can finish.
const REBUILD_GAP_MS = 250;
// While a page is open, the logs are looked at this often besides the file system's own notice (which can be missed), and a
// page seen this recently keeps the server watching.
const SWEEP_MS = 500;
const PRESENCE_MS = 20000;
const MAX_WAIT_MS = 30000;
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

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { done = true; reject(new RequestError('Message too long.', 413)); return; }
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

// Any request whose path lands in out/ belongs to the reader, however it is spelled (encoded
// slashes, doubled slashes, another letter case or Unicode form, a symlink), so no static
// handler ever serves a page or the reading list with a wildcard CORS header. Both spellings
// are checked: the parsed URL, and the raw one that a static file handler would decode.
function requestsOut(root, outDir, req, url) {
  const realOut = realLocation(outDir);
  for (const spelling of [url.pathname, req.url.split('?')[0]]) {
    let decoded;
    try { decoded = decodeURIComponent(spelling); } catch { return { inside: true, name: '' }; }
    const real = realLocation(path.join(root, decoded));
    if (real === realOut || real.startsWith(realOut + path.sep)) return { inside: true, name: path.relative(realOut, real) };
  }
  return { inside: false };
}

// For a server that serves repo files for other apps (setup/serve.sh): whether the request
// names the reader's out/ folder, which that server must refuse.
function namesReaderOut(root, req) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return true; }
  return requestsOut(root, path.join(root, 'setup', 'transcript-reader', 'out'), req, url).inside;
}

function create({
  root, port, runner = defaultRunner, env = process.env, now = () => Date.now(),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  herdrBin = 'herdr', pythonBin = 'python3', projectsDir = path.join(os.homedir(), '.claude', 'projects'),
  claudeSessionsDir = path.join(os.homedir(), '.claude', 'sessions'),
  outDir = path.join(root, 'setup', 'transcript-reader', 'out'), token,
  pinsFile = pinstore.defaultFile(env),
  starsFile = pinstore.defaultStarsFile(env),
  // Where an HTML file may be shown from, as in build_prototype.resolve_mention: the home folder and the temp folders.
  homeDir = os.homedir(), tempRoots = ['/tmp', os.tmpdir()],
  // The session ids sendPrompt accepts, when not the reading list's: drain.js sends to the
  // conversations of the hosted copy it drains.
  sendable = null,
  // { ip, port, passcodeFile[, https: { host, port }] } when server.js also listens on the Mac's Tailscale address
  // (tailnet.js), and with https on a TLS listener there too under the machine's Tailscale name (host); handle()
  // then takes the listener a request came in on.
  tailnet = null,
  // Where the tailnet listener writes its sign-in record (a line of text each); the server's stderr when left out.
  log = undefined,
  // Rebuilds in one reader.py that stays running (worker.js) instead of a new one each time; server.js turns it on.
  worker = false,
  // Watching the listed logs while a page is open, and answering `events` as a build is published; server.js turns it on.
  watch = false, sweepMs = SWEEP_MS,
} = {}) {
  const guard = createGuard({ port, token, tokenHeader: TOKEN_HEADER });
  const laneOptions = tailnet && { token: guard.token, tokenHeader: TOKEN_HEADER, passcodeFile: tailnet.passcodeFile, now, ...(log ? { log } : {}) };
  const lane = tailnet && tailnetLane.create({ ...laneOptions, ip: tailnet.ip, port: tailnet.port || port });
  // The TLS listener's lane: the same passcode file, sessions and token, its own Host and Origin (https://<name>:<port>).
  const httpsLane = tailnet && tailnet.https && tailnetLane.create({ ...laneOptions, ip: tailnet.ip, host: tailnet.https.host, scheme: 'https', port: tailnet.https.port });
  // The guard that holds for a request: the loopback one, or the tailnet listener's (its own
  // Host and Origin, the same token). Set by handle().
  const guards = new WeakMap();
  const guardFor = (req) => guards.get(req) || guard;
  const readerScript = path.join(root, 'setup', 'transcript-reader', 'reader.py');
  const copy = copyId(root);
  const runEnv = () => childEnv(env);
  const logPaths = new Map();
  let scanned = null;
  let scanning = null;
  const focusSeen = new Map();
  const focus = { seq: 0, herdr: null };
  const build = { running: null, lastEnd: 0, failedAt: 0, error: null, failedAdds: new Map(), paneClosed: false, newest: 0, rebuiltFor: 0 };
  // Listed sessions seen running in a pane. One that leaves while Herdr still answers had
  // its pane closed or cleared, so a rebuild runs and reader.py drops it from the list.
  const seenLive = new Set();
  let sending = false;
  const pins = pinstore.create({ file: pinsFile, now });
  const stars = pinstore.createStars({ file: starsFile, now });
  // The recent builds of the reader page, for answering what changed since the one an open page holds (delta.js).
  const deltas = deltaStore.create();

  // ------------------------------------------------------------- local records

  function idsIn(name) {
    let text = '';
    try { text = fs.readFileSync(path.join(outDir, name), 'utf8'); } catch { return []; }
    return text.split('\n').map((line) => line.trim()).filter((line) => SESSION_ID_RE.test(line));
  }
  const listed = () => idsIn('sessions.txt');
  // Sessions reader.py dropped because their pane closed, and lists again if one runs in a pane.
  const dropped = () => idsIn('dropped.txt');
  // Sessions a person took off the list (reader.py close and remove), which a Sync does not list again.
  const closedByHand = () => idsIn('closed.txt');

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
  // pane (Firstmate swaps a worker's model that way), and it can keep the id of an agent that
  // has exited, the pane then naming no agent at all. A pane with such an id that no running
  // Claude holds takes the session of its foreground Claude process, or none when the pane is
  // back at its shell. Read-only: `herdr pane process-info`, asked only for such panes.
  async function checkSessions(session) {
    const running = runningClaude();
    if (!running.size) return session;
    const held = new Set(running.values());
    for (const pane of session.panes) {
      const retained = !pane.agent && pane.session_id;
      if ((pane.agent !== 'claude' && !retained) || held.has(pane.session_id)) continue;
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

  // The reader.py that stays running, started on its first request; one that cannot take a request leaves it to a fresh reader.py.
  const readerWorker = worker ? workerLib.create({ command: pythonBin, args: ['-I', readerScript, 'worker'], cwd: root, env: runEnv(), timeoutMs: 60000, now }) : null;

  async function execReader(args) {
    if (readerWorker) {
      const result = await readerWorker.run(args);
      if (!result.crashed) return result;
    }
    return runner(pythonBin, ['-I', readerScript, ...args], { env: runEnv(), cwd: root, timeoutMs: 60000, maxBytes: 64 * 1024 });
  }

  function runReader(args, adding = null) {
    const done = execReader(args).then((result) => {
      if (result.code === 0) { build.error = null; build.failedAt = 0; }
      else {
        build.failedAt = now();
        build.rebuiltFor = 0;  // a failed rebuild is tried again once its hold is over, whatever the logs do meanwhile
        const lines = (result.stderr || result.stdout || '').trim().split('\n');
        build.error = result.timedOut ? 'The rebuild took over a minute and was stopped.' : (lines[lines.length - 1] || 'The rebuild failed.').slice(0, 200);
        if (adding) build.failedAdds.set(adding, now());
      }
      return result;
    }).finally(() => { build.running = null; build.lastEnd = now(); afterBuild(); });
    build.running = { args: args[0], adding, done };
    return done;
  }

  // Whether a listed log was written after the page was built (the page's stamp is when its build began, so a turn written
  // while it ran counts), and after the write the last rebuild this started was for: a log dated in the future, or one that stays
  // newer than every build for another reason, is rebuilt for once, not in a loop.
  function logsNewer(ids) {
    const built = stamp('prototype.stamp');
    build.newest = Math.max(0, ...ids.map((id) => { const file = logPath(id); return file ? mtimeMs(file) : 0; }));
    return built === null || (build.newest > built * 1000 && build.newest > build.rebuiltFor);
  }

  // Rebuild when a listed session's log is newer than the page or its pane closed, or add the focused session.
  function maybeRebuild(ids, focused, follow) {
    if (build.running || now() - build.lastEnd < REBUILD_GAP_MS) return;
    if (follow && focused && focused.session_id && !ids.includes(focused.session_id) && logPath(focused.session_id)) {
      const failed = build.failedAdds.get(focused.session_id);
      if (!failed || now() - failed > RETRY_AFTER_FAILURE_MS) { runReader(['follow', focused.session_id], focused.session_id); return; }
    }
    if (build.failedAt && now() - build.failedAt < RETRY_AFTER_FAILURE_MS) return;
    if ((ids.length || build.paneClosed) && (build.paneClosed || logsNewer(ids))) { build.paneClosed = false; build.rebuiltFor = build.newest; runReader(['rebuild']); }
  }

  // ----------------------------------------------------------------- watching

  // While a page is open (it polled, or waits on `events`) the logs of the listed sessions are watched here, and a change
  // starts the rebuild at once. Nothing is watched, and nothing rebuilt, with no page open. The folders are watched for the
  // file system's notice of a write; the sweep is the check that does not depend on it, and what runs after each build.
  let lastSeen = 0;
  let sweepTimer = null;
  let afterTimer = null;
  let sweepQueued = false;
  const folders = new Map();
  const waiters = new Set();

  const buildInfo = () => ({ running: Boolean(build.running), adding: build.running ? build.running.adding : null, error: build.error });
  const stampsNow = () => ({ reader: stamp('prototype.stamp'), sheet: stamp('questionnaire.stamp') });
  const isNewer = (have, current) => (Number.isFinite(have.reader) && current.reader !== null && current.reader > have.reader)
    || (Number.isFinite(have.sheet) && current.sheet !== null && current.sheet > have.sheet);

  function sweepSoon() {
    if (sweepQueued) return;
    sweepQueued = true;
    setImmediate(() => { sweepQueued = false; sweep(); });
  }

  function syncFolders() {
    const want = new Set([outDir]);
    for (const id of listed()) { const file = logPath(id); if (file) want.add(path.dirname(file)); }
    for (const [dir, watcher] of folders) if (!want.has(dir)) { watcher.close(); folders.delete(dir); }
    for (const dir of want) {
      if (folders.has(dir)) continue;
      try {
        // In out/ only the stamps and the list say anything (a build writes many other files).
        const watcher = fs.watch(dir, { persistent: false }, (event, name) => { if (dir !== outDir || /stamp$|^sessions\.txt$/.test(name || '')) sweepSoon(); });
        watcher.on('error', () => { watcher.close(); if (folders.get(dir) === watcher) folders.delete(dir); });
        folders.set(dir, watcher);
      } catch { /* the sweep covers a folder that cannot be watched */ }
    }
  }

  function sweep() {
    if (!watch) return;
    if (now() - lastSeen > PRESENCE_MS && !waiters.size) { stopWatching(); return; }
    syncFolders();
    if (!build.running && now() - build.lastEnd >= REBUILD_GAP_MS && !(build.failedAt && now() - build.failedAt < RETRY_AFTER_FAILURE_MS)) {
      const ids = listed();
      if (ids.length && logsNewer(ids)) { build.rebuiltFor = build.newest; runReader(['rebuild']); }
    }
    answerWaiters();
  }

  function startWatching() {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweep, sweepMs);
    if (sweepTimer.unref) sweepTimer.unref();
    sweepSoon();
  }

  function stopWatching() {
    clearInterval(sweepTimer);
    clearTimeout(afterTimer);
    sweepTimer = afterTimer = null;
    for (const watcher of folders.values()) watcher.close();
    folders.clear();
  }

  // A page is there: it polled or it waits.
  function seen() {
    lastSeen = now();
    if (watch) startWatching();
  }

  // After a build: waiting pages learn of the stamp it left, and a log written meanwhile is looked at once the pause is over.
  function afterBuild() {
    answerWaiters();
    if (!sweepTimer) return;
    clearTimeout(afterTimer);
    afterTimer = setTimeout(sweep, REBUILD_GAP_MS);
    if (afterTimer.unref) afterTimer.unref();
  }

  function finishWaiter(waiter) {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    send(waiter.res, 200, { status: 'ok', stamps: stampsNow(), build: buildInfo() });
  }

  function answerWaiters() {
    if (!waiters.size) return;
    const current = stampsNow();
    for (const waiter of [...waiters]) if (isNewer(waiter.have, current)) finishWaiter(waiter);
  }

  // events: answers at once when a build newer than the page's is there, else when one is published, else after `wait`.
  function events(res, query) {
    const stampOf = (name) => (query.get(name) === null || query.get(name) === '' ? NaN : Number(query.get(name)));
    const have = { reader: stampOf('reader'), sheet: stampOf('sheet') };
    const wait = Math.min(Math.max(Number(query.get('wait')) || 0, 0), MAX_WAIT_MS);
    seen();
    if (!wait || isNewer(have, stampsNow())) { send(res, 200, { status: 'ok', stamps: stampsNow(), build: buildInfo() }); return; }
    const waiter = { have, res, timer: null };
    waiter.timer = setTimeout(() => finishWaiter(waiter), wait);
    waiters.add(waiter);
    res.on('close', () => { if (waiters.delete(waiter)) clearTimeout(waiter.timer); });
    if (watch) sweepSoon();
  }

  // Ends what runs for the server: the waiting pages, the watching and the worker.
  function close() {
    for (const waiter of [...waiters]) finishWaiter(waiter);
    stopWatching();
    if (readerWorker) readerWorker.stop();
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
    // A dropped session that runs in a pane again is listed again by the next rebuild.
    if (dropped().some((id) => live.has(id))) build.paneClosed = true;
  }

  async function state(follow) {
    seen();
    const ids = listed();
    const sessions = await scan();
    const focused = trackFocus(sessions);
    notePaneChanges(ids, sessions);
    // A page built after the last failed rebuild (by `reader.py add`, say) ends that failure:
    // its banner and its hold on rebuilds.
    const built = stamp('prototype.stamp');
    if (build.failedAt && built !== null && built * 1000 > build.failedAt) { build.error = null; build.failedAt = 0; }
    maybeRebuild(ids, focused, follow);
    const panes = {};
    for (const session of sessions) {
      for (const pane of session.panes) {
        if (pane.session_id && ids.includes(pane.session_id)) panes[pane.session_id] = { label: pane.label, status: pane.status, herdr: session.name };
      }
    }
    return {
      stamps: { reader: stamp('prototype.stamp'), sheet: stamp('questionnaire.stamp'), pins: pins.read().rev, stars: stars.read().rev },
      focus: focused && {
        ...focused,
        listed: focused.session_id ? ids.includes(focused.session_id) : false,
        readable: focused.session_id ? Boolean(logPath(focused.session_id)) : false,
      },
      panes,
      build: buildInfo(),
    };
  }

  // ------------------------------------------------------------------- sync

  // The sessions running in a Herdr pane with Claude that the reading list lacks and has a log to read, and that no
  // person took off the list. Only listing them changes the list; the panes are not touched.
  function unlistedLive(sessions) {
    const skip = new Set([...listed(), ...closedByHand()]);
    const found = [];
    for (const session of sessions) {
      for (const pane of session.panes) {
        const id = pane.session_id;
        if (pane.agent === 'claude' && id && !skip.has(id) && logPath(id)) { skip.add(id); found.push(id); }
      }
    }
    return found;
  }

  // What the Sync button asks for: Herdr is read again now (not from the last scan), every live Claude pane's session
  // not yet listed is listed (reader.py adopt, as follow lists the focused one, so /clear joins and labels work the
  // same), the pages are rebuilt from the session logs and the fleet records whether or not a log looks newer, and
  // the answer is state's, once it is done. That is the same read-only rebuild a changed log starts, so the reading
  // list, each session's live or ended state and every listed session's newest turns are all taken again; it waits
  // for one already running.
  async function sync(body) {
    for (const key of Object.keys(body)) if (key !== 'follow') throw new RequestError('Unknown field.');
    if (body.follow !== undefined && typeof body.follow !== 'boolean') throw new RequestError('Invalid follow.');
    while (build.running) await build.running.done;
    const sessions = await scan({ fresh: true });
    notePaneChanges(listed(), sessions);
    const adopt = unlistedLive(sessions);
    const result = await runReader(adopt.length ? ['adopt', ...adopt] : ['rebuild']);
    if (result.code !== 0) throw new RequestError(build.error || 'The rebuild failed.', 502, 'rebuild_failed');
    build.paneClosed = false;
    return { synced: now() / 1000, ...(await state(body.follow === true)) };
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
    if (!(sendable ? sendable() : listed()).includes(sessionId)) throw new RequestError('That session is not on the reading list.', 409, 'not_listed');
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

  // ------------------------------------------------------------------- queue

  // The hosted copy's Send, from a page served here: the request is written into the copy's
  // q/ folder, for drain.js to send when the sync agent next runs. Nothing is sent to Herdr, and
  // a request is written once (never replaced), owner-only like every file this reader writes.
  function queueWrite(body) {
    for (const key of Object.keys(body)) if (!['copy', 'id', 'object', 'data'].includes(key)) throw new RequestError('Unknown field.');
    const folder = body.copy;
    if (folder !== 'hosted' && folder !== 'bucket') throw new RequestError('Unknown copy.');
    if (typeof body.id !== 'string' || !QUEUE_ID_RE.test(body.id)) throw new RequestError('Invalid request id.');
    let bytes;
    let name;
    if (folder === 'hosted') {
      const object = body.object;
      if (body.data !== undefined || !object || typeof object !== 'object' || Array.isArray(object)) throw new RequestError('Invalid request.');
      for (const key of Object.keys(object)) if (!['session_id', 'text', 'at'].includes(key)) throw new RequestError('Unknown field.');
      if (typeof object.session_id !== 'string' || !SESSION_ID_RE.test(object.session_id)) throw new RequestError('Invalid session id.');
      if (!Number.isFinite(object.at)) throw new RequestError('Invalid time.');
      bytes = Buffer.from(JSON.stringify({ id: body.id, session_id: object.session_id, text: checkText(object.text), at: object.at }), 'utf8');
      name = body.id + '.json';
    } else {
      // Sealed by the page: only its envelope can be checked here (the bytes open with the passphrase's key, which this server never has).
      if (body.object !== undefined || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new RequestError('Invalid request.');
      bytes = Buffer.from(body.data, 'base64');
      if (bytes.length < 32 || bytes.length > MAX_QUEUE_BODY_BYTES || !bytes.subarray(0, 4).equals(SEALED_MAGIC)) throw new RequestError('That is not a sealed request.');
      name = body.id + '.json.enc';
    }
    const directory = path.join(outDir, folder, 'q');
    let waiting = 0;
    try { waiting = fs.readdirSync(directory).filter((entry) => !entry.startsWith('.')).length; } catch { waiting = 0; }
    if (waiting >= MAX_QUEUED) throw new RequestError('Too many messages are waiting for the laptop. Wait for them to be sent.', 429, 'queue_full');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600, flag: 'wx' }); } catch (error) {
      if (error.code === 'EEXIST') throw new RequestError('That request is already queued.', 409, 'exists');
      throw new RequestError('The request could not be queued.', 500, 'queue_failed');
    }
    return { id: body.id, queued: waiting + 1 };
  }

  // -------------------------------------------------------------- HTML files

  // key -> { dir, entry, flat, only, expires } for each file shown: the folder it is in, its name, whether that folder is
  // itself an allowed root (so only its own files may load, nothing below), whether the file is all the key opens (an image),
  // and when the key lapses from disuse.
  const views = new Map();

  const within = (real, base) => real === base || real.startsWith(base + path.sep);
  const roots = () => [homeDir, ...tempRoots].map(realLocation);

  function pruneViews() {
    for (const [key, view] of views) if (view.expires <= now()) views.delete(key);
    while (views.size > MAX_VIEWS) views.delete(views.keys().next().value);
  }

  // What the Open button of an HTML file or an image asks: the file as the last build listed it, checked now. The listing
  // comes from the page's own build (never from the request), so only a file a listed conversation named opens.
  const OPENABLE = {
    html: { listing: HTML_FILES, type: HTML_PAGE_RE, limit: MAX_HTML_BYTES, not: ['That is not an HTML file.', 'not_html'] },
    image: { listing: IMAGE_FILES, type: IMAGE_FILE_RE, limit: MAX_IMAGE_BYTES, not: ['That is not an image file.', 'not_image'] },
  };
  function fileOpen(body, kind) {
    const rules = OPENABLE[kind];
    for (const key of Object.keys(body)) if (key !== 'id') throw new RequestError('Unknown field.');
    if (typeof body.id !== 'string' || !HTML_ID_RE.test(body.id)) throw new RequestError('Invalid file id.');
    let listing = null;
    try { listing = parseJson(fs.readFileSync(path.join(outDir, rules.listing), 'utf8')); } catch { listing = null; }
    const named = listing && typeof listing === 'object' && Object.hasOwn(listing, body.id) ? listing[body.id] : null;
    if (typeof named !== 'string' || !path.isAbsolute(named)) throw new RequestError('That file is not on the page. Sync to rebuild it.', 404, 'not_listed');
    let real;
    let stat;
    try { real = fs.realpathSync.native(named); stat = fs.statSync(real); } catch { throw new RequestError('That file is gone.', 404, 'gone'); }
    if (!stat.isFile()) throw new RequestError('That file is gone.', 404, 'gone');
    if (!rules.type.test(real)) throw new RequestError(rules.not[0], 404, rules.not[1]);
    if (!roots().some((root) => within(real, root))) throw new RequestError('That file is outside the home and temp folders.', 403, 'outside');
    if (stat.size > rules.limit) throw new RequestError('That file is over ' + rules.limit / 1024 / 1024 + ' MB.', 413, 'too_big');
    const key = crypto.randomBytes(16).toString('base64url');
    const dir = path.dirname(real);
    views.set(key, { dir, entry: path.basename(real), flat: roots().includes(dir), only: kind === 'image', expires: now() + VIEW_IDLE_MS });
    pruneViews();
    return { url: HTML_ROUTE + key + '/' + encodeURIComponent(path.basename(real)), name: path.basename(real), size: stat.size, mtime: stat.mtimeMs / 1000 };
  }

  // The file named by the address, as it is on disk now.
  function serveView(req, res) {
    const text = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
    const verdict = guardFor(req).check(req, { requireToken: false, crossSite: true });
    if (!verdict.ok) { text(verdict.status, verdict.message); return; }
    if (req.method !== 'GET') { text(405, 'GET only'); return; }
    pruneViews();
    const [key, ...segments] = new URL(req.url, 'http://localhost').pathname.slice(HTML_ROUTE.length).split('/');
    const view = views.get(key);
    let parts;
    try { parts = segments.map(decodeURIComponent); } catch { parts = []; }
    // A name is one path segment: no empty or dot segment, no encoded slash or backslash, and nothing hidden (a dot
    // file or folder) other than the file itself.
    const valid = parts.length > 0 && parts.every((part) => part && part !== '.' && part !== '..' && !/[\\/\u0000]/.test(part));
    const entry = valid && parts.length === 1 && parts[0] === view?.entry;
    const type = valid && ASSET_TYPES[path.extname(parts[parts.length - 1]).toLowerCase()];
    if (!view || !valid || !type || (!entry && (view.only || parts.some((part) => part.startsWith('.')) || (view.flat && parts.length > 1)))) { text(404, 'Not found'); return; }
    let real;
    let stat;
    try { real = fs.realpathSync.native(path.join(view.dir, ...parts)); stat = fs.statSync(real); } catch { text(404, 'Not found'); return; }
    if (!stat.isFile() || !within(real, view.dir) || !roots().some((root) => within(real, root))) { text(404, 'Not found'); return; }
    if (stat.size > (view.only ? MAX_IMAGE_BYTES : HTML_PAGE_RE.test(real) ? MAX_HTML_BYTES : MAX_ASSET_BYTES)) { text(413, 'Too big'); return; }
    view.expires = now() + VIEW_IDLE_MS;
    const stream = fs.createReadStream(real);
    stream.on('error', () => { if (!res.headersSent) text(404, 'Not found'); else res.end(); });
    stream.on('open', () => {
      res.writeHead(200, {
        'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': type.startsWith('text/html') ? VIEW_CSP : ASSET_CSP, 'X-Frame-Options': 'SAMEORIGIN',
      });
      stream.pipe(res);
    });
  }

  // ------------------------------------------------------------------- routes

  function servePage(req, res, name) {
    const text = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
    const verdict = guardFor(req).check(req, { requireToken: false });
    if (!verdict.ok) { text(verdict.status, verdict.message); return; }
    if (req.method !== 'GET') { text(405, 'GET only'); return; }
    // Only a browser tab opening the page gets it (and so the token), never a script's
    // fetch, a frame or an embed. Like the guard, a request without Fetch-Metadata
    // (curl, an old browser) is let through.
    const mode = req.headers['sec-fetch-mode'];
    const dest = req.headers['sec-fetch-dest'];
    if ((mode !== undefined && mode !== 'navigate') || (dest !== undefined && dest !== 'document')) {
      // One exception, for the offline copy: its page keeps the shell pages in a cache for the service worker, and asks for them
      // with the token it holds. Whoever holds the token already has what the page would tell it, so nothing more is given away.
      const own = SHELL_PAGES.has(name) && guardFor(req).check(req).ok;
      if (!own) { text(403, 'Open this page in its own browser tab.'); return; }
    }
    if (!PAGES.has(name)) { text(404, 'Not found'); return; }
    fs.readFile(path.join(outDir, name), 'utf8', (error, html) => {
      if (error) { text(404, 'Not built yet: run python3 setup/transcript-reader/' + (name.startsWith('hosted/') ? 'sync.py --build-only' : name.startsWith('bucket/') ? 'sync.py --seal' : 'reader.py')); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
        [COPY_HEADER]: copy,
      });
      res.end(html.replace(TOKEN_META, () => TOKEN_META.replace(TOKEN_SLOT, guard.token)));
      // The build this page holds is what its first update is measured from.
      if (name === 'prototype.html') setImmediate(() => deltas.note(html));
    });
  }

  // The service worker, manifest and icons beside a copy's shell pages: not secret, but behind the same Host, Origin and (on the tailnet) sign-in checks.
  function serveStatic(req, res, folder, name) {
    const verdict = guardFor(req).check(req, { requireToken: false });
    if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
    if (req.method !== 'GET') { fail(res, 405, 'not_allowed', 'GET only.'); return; }
    fs.readFile(path.join(outDir, folder, name), (error, body) => {
      if (error) { fail(res, 404, 'not_built', 'Not built yet.'); return; }
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[name], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    });
  }

  // An object a hosted shell loads (plain under out/hosted/, sealed under out/bucket/). Like the API
  // it needs the token, which only the shell opened in a tab holds, so another page on this origin
  // cannot read the transcripts here either.
  function serveObject(req, res, folder, name) {
    const verdict = guardFor(req).check(req);
    if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
    if (req.method !== 'GET') { fail(res, 405, 'not_allowed', 'GET only.'); return; }
    const kind = OBJECTS[folder];
    if (!kind.re.test(name)) { fail(res, 404, 'not_found', 'Not found.'); return; }
    fs.readFile(path.join(outDir, folder, name), (error, body) => {
      if (error) { fail(res, 404, 'not_built', 'Not built yet.'); return; }
      res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json; charset=utf-8' : kind.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    });
  }

  async function dispatch(req, res, pathname, query) {
    const verdict = guardFor(req).check(req);
    if (!verdict.ok) { fail(res, verdict.status, 'refused', verdict.message); return; }
    if (pathname === API + 'page' && req.method === 'GET') {
      const name = query.get('name');
      if (!PAGES.has(name)) { fail(res, 404, 'not_found', 'Not found.'); return; }
      let html;
      try { html = fs.readFileSync(path.join(outDir, name), 'utf8'); } catch { fail(res, 404, 'not_built', 'Not built yet.'); return; }
      send(res, 200, { status: 'ok', html });
      if (name === 'prototype.html') setImmediate(() => deltas.note(html));
      return;
    }
    // What changed since the build the page holds (`have`, its generated time), in place of the whole page: only the reader
    // page has one. { delta: false } sends the page to the full text above.
    if (pathname === API + 'delta' && req.method === 'GET') {
      const have = Number(query.get('have'));
      if (query.get('name') !== 'prototype.html') { fail(res, 404, 'not_found', 'Not found.'); return; }
      if (!Number.isFinite(have)) { fail(res, 400, 'bad_request', 'Invalid build.'); return; }
      let html;
      try { html = fs.readFileSync(path.join(outDir, 'prototype.html'), 'utf8'); } catch { fail(res, 404, 'not_built', 'Not built yet.'); return; }
      send(res, 200, { status: 'ok', ...deltas.since(html, have) });
      return;
    }
    if (pathname === API + 'events' && req.method === 'GET') {
      events(res, query);
      return;
    }
    if (pathname === API + 'state' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...(await state(query.get('follow') === '1')) });
      return;
    }
    if (pathname === API + 'sync' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...(await sync(await readJsonBody(req))) });
      return;
    }
    if (pathname === API + 'pins' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...pins.read() });
      return;
    }
    if (pathname === API + 'pins' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...pins.change(await readJsonBody(req)) });
      return;
    }
    if (pathname === API + 'stars' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...stars.read() });
      return;
    }
    if (pathname === API + 'stars' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...stars.change(await readJsonBody(req)) });
      return;
    }
    if (pathname === API + 'send' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...(await sendPrompt(await readJsonBody(req))) });
      return;
    }
    for (const kind of ['html', 'image']) {
      if (pathname === API + kind + '-open' && req.method === 'POST') {
        send(res, 200, { status: 'ok', ...fileOpen(await readJsonBody(req), kind) });
        return;
      }
    }
    if (pathname === API + 'queue' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...queueWrite(await readJsonBody(req, MAX_QUEUE_BODY_BYTES)) });
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

  const insideOut = (req, url) => requestsOut(root, outDir, req, url);

  // Returns true when the request belongs to this module (and is handled here). listener is
  // 'tailnet' (plain HTTP) or 'tailnet-https' for a request that came in on the Tailscale address, which must be signed in
  // first (tailnet.js); anything else is a loopback request, handled as it always was.
  function handle(req, res, listener = 'loopback') {
    let url;
    // A request URL nothing can parse may still name out/, so it is refused here rather
    // than passed on to the shared static handler.
    try { url = new URL(req.url, 'http://localhost'); } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Bad request');
      return true;
    }
    const page = insideOut(req, url);
    const viewing = !page.inside && url.pathname.startsWith(HTML_ROUTE);
    if (listener === 'tailnet' || listener === 'tailnet-https') {
      const lanes = listener === 'tailnet' ? lane : httpsLane;
      if (!lanes) { res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Not served here'); return true; }
      if (lanes.intercept(req, res, url, page.inside && page.name.endsWith('.html'), viewing)) return true;
      guards.set(req, lanes.guard);
    }
    if (viewing) { serveView(req, res); return true; }
    if (page.inside) {
      const folder = Object.keys(OBJECTS).find((name) => page.name.startsWith(name + path.sep));
      if (folder && Object.hasOwn(STATIC_TYPES, page.name.slice(folder.length + 1))) serveStatic(req, res, folder, page.name.slice(folder.length + 1));
      else if (folder && !PAGES.has(page.name)) serveObject(req, res, folder, page.name.slice(folder.length + 1));
      else servePage(req, res, page.name);
      return true;
    }
    if (!url.pathname.startsWith(API)) return false;
    dispatch(req, res, url.pathname, url.searchParams).catch((error) => {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof RequestError || error instanceof pinstore.PinError) fail(res, error.status, error.code, error.message);
      else fail(res, 500, 'internal', 'Unexpected error.');
    });
    return true;
  }

  return { handle, guard, scan, sendPrompt, close, tailnet: lane, tailnetHttps: httpsLane };
}

module.exports = { create, checkText, copyId, namesReaderOut, RequestError, API, TOKEN_HEADER, TOKEN_META, COPY_HEADER };
