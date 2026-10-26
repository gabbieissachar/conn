'use strict';

// Opt-in access to the reader from another device on the owner's tailnet (their phone).
// server.js adds a listener on the Mac's Tailscale IPv4 address, next to the loopback
// ones, only when serve.sh was started with --tailnet, Tailscale answered with an
// address and a passcode is set. Everything arriving on that listener goes through
// intercept() first:
//
//   - the guard checks (Host and Origin must be the tailnet address and port, Fetch-Metadata)
//   - no valid session: a passcode page for a page request, 401 JSON for anything else
//   - a correct passcode on POST /transcript-reader/signin sets the session cookie
//   - GET /transcript-reader/signout ends the session
//
// A session that passes goes on to api.js, whose routes check Host, Origin, Fetch-Metadata
// and the per-start token again, so a phone needs both the cookie and the token the page
// carries. Requests on the loopback listeners never come here.
//
// The passcode is stored only as a salted scrypt hash in one owner-only file (set with
// `serve.sh passcode`, which reads it from the terminal without echo). Sessions live in
// memory: a restart signs the phone out, and so does a new passcode or a removed file.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createGuard } = require('../herdr-organizer/guard');

const SIGNIN = '/transcript-reader/signin';
const SIGNOUT = '/transcript-reader/signout';
const HOME = '/setup/transcript-reader/out/prototype.html';
const COOKIE = 'reader_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;  // idle: every request from the phone renews it
const MAX_SESSIONS = 20;
const MAX_BODY_BYTES = 2048;
const MIN_PASSCODE = 8;
const MAX_PASSCODE = 256;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
const MAX_VERIFYING = 4;  // scrypt runs at once: more than this is refused, so a burst cannot pin the CPU
// Wrong passcodes from one address: the third in a row locks it for 30 s, each one after
// that doubles the lock up to 15 min, and a quiet hour forgets them.
const FREE_TRIES = 2;
const LOCK_BASE_MS = 30 * 1000;
const LOCK_MAX_MS = 15 * 60 * 1000;
const FORGET_MS = 60 * 60 * 1000;
const MAX_TRACKED = 500;

// ---------------------------------------------------------------- the passcode file

const scryptAsync = (passcode, salt, { N, r, p, keylen }) => new Promise((resolve, reject) => {
  crypto.scrypt(passcode, salt, keylen, { N, r, p, maxmem: 256 * N * r }, (error, key) => (error ? reject(error) : resolve(key)));
});

function passcodeProblem(passcode) {
  if (typeof passcode !== 'string' || passcode.length < MIN_PASSCODE) return `The passcode needs at least ${MIN_PASSCODE} characters.`;
  if (passcode.length > MAX_PASSCODE) return `The passcode can have at most ${MAX_PASSCODE} characters.`;
  return null;
}

// What goes in the file: the scrypt parameters, the salt and the hash, never the passcode.
async function makeRecord(passcode) {
  const problem = passcodeProblem(passcode);
  if (problem) throw new Error(problem);
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(passcode, salt, SCRYPT);
  return { v: 1, alg: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function parseRecord(text) {
  let record;
  try { record = JSON.parse(text); } catch { return null; }
  if (!record || record.v !== 1 || record.alg !== 'scrypt') return null;
  const { N, r, p, keylen } = record;
  const sane = Number.isInteger(N) && N >= 2 ** 14 && N <= 2 ** 20 && (N & (N - 1)) === 0
    && Number.isInteger(r) && r >= 1 && r <= 16 && Number.isInteger(p) && p >= 1 && p <= 4 && Number.isInteger(keylen) && keylen >= 16 && keylen <= 64;
  if (!sane || typeof record.salt !== 'string' || typeof record.hash !== 'string') return null;
  if (Buffer.from(record.hash, 'base64').length !== keylen) return null;
  return record;
}

async function passcodeMatches(record, candidate) {
  const key = await scryptAsync(candidate, Buffer.from(record.salt, 'base64'), record);
  return crypto.timingSafeEqual(key, Buffer.from(record.hash, 'base64'));
}

// Writes the hash file owner-only, replacing any earlier one in a single rename.
async function writePasscodeFile(file, passcode) {
  const record = await makeRecord(passcode);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

// The file's current hash, or null when it is missing or unreadable. Re-read when it changes,
// so a new passcode takes effect without a restart.
function recordSource(file) {
  let seen = { stamp: null, record: null };
  return () => {
    let stat;
    try { stat = fs.statSync(file); } catch { seen = { stamp: null, record: null }; return null; }
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (stamp !== seen.stamp) {
      let record = null;
      try { record = parseRecord(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: no passcode */ }
      seen = { stamp, record };
    }
    return seen.record;
  };
}

// ----------------------------------------------------------- sessions and throttling

// Sessions are kept under the hash of their token, so looking one up never compares the
// token itself, and what a memory dump holds cannot be replayed as a cookie.
function createSessions(now) {
  const sessions = new Map();
  const key = (token) => crypto.createHash('sha256').update(token).digest('hex');
  return {
    open(generation) {
      for (const [id, session] of sessions) if (session.expires <= now()) sessions.delete(id);
      while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(key(token), { expires: now() + SESSION_MS, generation });
      return token;
    },
    // A session made under an earlier passcode is no longer valid.
    valid(token, generation) {
      if (typeof token !== 'string' || !token) return false;
      const id = key(token);
      const session = sessions.get(id);
      if (!session) return false;
      if (session.expires <= now() || session.generation !== generation) { sessions.delete(id); return false; }
      session.expires = now() + SESSION_MS;
      return true;
    },
    close(token) { if (typeof token === 'string' && token) sessions.delete(key(token)); },
  };
}

function createThrottle(now) {
  const byAddress = new Map();
  return {
    // Counts the try before it is checked, so tries sent together cannot all beat the lock.
    // Returns the ms the address must still wait, or 0 when this try may go ahead.
    attempt(address) {
      const t = now();
      let entry = byAddress.get(address);
      if (entry && entry.lockedUntil > t) return entry.lockedUntil - t;
      if (!entry || t - entry.last > FORGET_MS) entry = { fails: 0, last: t, lockedUntil: 0 };
      entry.fails += 1;
      entry.last = t;
      if (entry.fails > FREE_TRIES) entry.lockedUntil = t + Math.min(LOCK_BASE_MS * 2 ** (entry.fails - FREE_TRIES - 1), LOCK_MAX_MS);
      byAddress.delete(address);
      byAddress.set(address, entry);
      while (byAddress.size > MAX_TRACKED) byAddress.delete(byAddress.keys().next().value);
      return 0;
    },
    passed(address) { byAddress.delete(address); },
    // The wait the next try would meet, for the answer to a wrong passcode.
    waiting(address) { const entry = byAddress.get(address); return entry && entry.lockedUntil > now() ? entry.lockedUntil - now() : 0; },
  };
}

// ---------------------------------------------------------------------- the pages

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1c1c1a;--muted:#6a6a64;--card:#fff;--line:#d9d9d3;--accent:#1f6f4a;--accent-fg:#fff;--bad:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecece8;--muted:#9a9a92;--card:#201f1d;--line:#3a3a36;--accent:#4fb388;--accent-fg:#10231a;--bad:#f2867e}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{margin:0 0 4px;font-size:20px}
p{margin:0 0 16px;color:var(--muted)}
label{display:block;margin-bottom:6px;font-size:14px;color:var(--muted)}
input{width:100%;height:48px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font-size:16px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button,a.button{display:flex;align-items:center;justify-content:center;width:100%;height:48px;margin-top:14px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-fg);font-size:16px;font-weight:600;text-decoration:none}
button:disabled{opacity:.6}
a.quiet{display:block;margin-top:16px;text-align:center;color:var(--muted);font-size:14px}
#m{min-height:20px;margin:10px 0 0;color:var(--bad);font-size:14px}
`.trim();

// Signing in at the very address that asked for it (a reader page opened with #s=..., or the reload after a
// sign-out) must load it again: replacing the location with itself only moves within the page when it has a fragment.
const SCRIPT = `
var f=document.getElementById('f'),p=document.getElementById('p'),m=document.getElementById('m'),b=document.getElementById('b');
var next=location.pathname.indexOf('/transcript-reader/')===0?'/':location.pathname+location.search+location.hash;
f.addEventListener('submit',function(e){
e.preventDefault();b.disabled=true;m.textContent='';
fetch('/transcript-reader/signin',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({passcode:p.value,next:next})})
.then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{r:r,j:j}})})
.then(function(x){
if(x.r.ok&&x.j.next){if(x.j.next===location.pathname+location.search+location.hash)location.reload();else location.replace(x.j.next);return}
p.value='';b.disabled=false;
m.textContent=x.r.status===429?'Too many tries. Try again in '+(x.j.retry_after||30)+' seconds.':x.r.status===503?'No passcode is set on the laptop.':'That passcode did not work.';
p.focus()})
.catch(function(){b.disabled=false;m.textContent='Could not reach the reader.'})});
`.trim();

const sourceHash = (text) => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': `default-src 'none'; style-src ${sourceHash(STYLE)}; script-src ${sourceHash(SCRIPT)}; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
};

const shell = (body, withScript) => '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">'
  + `<title>Transcript reader</title><style>${STYLE}</style></head><body><main>${body}</main>${withScript ? `<script>${SCRIPT}</script>` : ''}</body></html>`;

const PASSCODE_PAGE = shell('<h1>Transcript reader</h1><p>Enter the passcode set on the laptop.</p>'
  + '<form id="f" autocomplete="on"><label for="p">Passcode</label>'
  + '<input id="p" type="password" name="passcode" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>'
  + '<p id="m" role="alert" aria-live="polite"></p><button id="b" type="submit">Open the reader</button></form>', true);

const SIGNED_IN_PAGE = shell(`<h1>Signed in</h1><p>This device can open the reader.</p><a class="button" href="${HOME}">Open the reader</a>`
  + `<a class="quiet" href="${SIGNOUT}">Sign out</a>`, false);

// ------------------------------------------------------------------ the listener

const text = (res, status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
};
const html = (res, status, page) => { res.writeHead(status, PAGE_HEADERS); res.end(page); };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { done = true; reject(Object.assign(new Error('too long'), { status: 413 })); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function cookieOf(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim();
  }
  return '';
}

// Only a same-origin path: a leading slash, and not "//host" or "/\host".
const safeNext = (value) => (typeof value === 'string' && value.length <= 2048 && /^\/(?![/\\])[^\s\\]*$/.test(value) && !value.startsWith(SIGNIN) && !value.startsWith(SIGNOUT) ? value : '/');

// ip and port are where the listener is bound; passcodeFile holds the hash; token is the
// reader's per-start token, shared with the loopback guard so pages carry one token.
function create({ ip, port, token, tokenHeader, passcodeFile, now = () => Date.now() }) {
  const guard = createGuard({ port, token, tokenHeader, hosts: [ip] });
  const currentRecord = recordSource(passcodeFile);
  const sessions = createSessions(now);
  const throttle = createThrottle(now);
  let verifying = 0;

  const setCookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  const signedIn = (req) => { const record = currentRecord(); return Boolean(record) && sessions.valid(cookieOf(req), record.hash); };

  async function signIn(req, res) {
    const record = currentRecord();
    if (!record) { json(res, 503, { status: 'error', code: 'no_passcode', message: 'No passcode is set.' }); return; }
    let body;
    try { body = await readBody(req); } catch (error) { json(res, error.status || 400, { status: 'error', code: 'bad_request', message: 'Bad request.' }); return; }
    const candidate = body && body.passcode;
    if (typeof candidate !== 'string') { json(res, 400, { status: 'error', code: 'bad_request', message: 'Bad request.' }); return; }
    const address = req.socket.remoteAddress || '';
    const wait = throttle.attempt(address);
    if (wait) {
      const seconds = Math.ceil(wait / 1000);
      json(res, 429, { status: 'error', code: 'throttled', message: 'Too many wrong passcodes.', retry_after: seconds }, { 'Retry-After': String(seconds) });
      return;
    }
    if (verifying >= MAX_VERIFYING) { json(res, 429, { status: 'error', code: 'busy', message: 'Try again in a moment.', retry_after: 2 }, { 'Retry-After': '2' }); return; }
    let ok = false;
    if (!passcodeProblem(candidate)) {
      verifying += 1;
      try { ok = await passcodeMatches(record, candidate); } catch { ok = false; } finally { verifying -= 1; }
    }
    // The file may have changed while this one was checked: only the passcode it held then counts.
    if (!ok || currentRecord() !== record) {
      const seconds = Math.ceil(throttle.waiting(address) / 1000);
      if (seconds) process.stderr.write(`Tailnet: wrong passcodes from ${address}, locked for ${seconds} s\n`);
      json(res, 401, { status: 'error', code: 'wrong_passcode', message: 'Wrong passcode.', retry_after: seconds });
      return;
    }
    throttle.passed(address);
    json(res, 200, { status: 'ok', next: safeNext(body.next) }, { 'Set-Cookie': setCookie(sessions.open(record.hash), SESSION_MS / 1000) });
  }

  // Returns true when this module answered. false: the request is signed in and api.js goes on.
  // isPage: whether the path names one of the reader's built pages.
  function intercept(req, res, url, isPage) {
    const verdict = guard.check(req, { requireToken: false });
    if (!verdict.ok) { text(res, verdict.status, verdict.message); return true; }
    const method = String(req.method).toUpperCase();
    const pathname = url.pathname;
    if (pathname === SIGNIN) {
      if (method === 'POST') signIn(req, res).catch(() => { if (!res.headersSent) json(res, 500, { status: 'error', code: 'internal', message: 'Unexpected error.' }); else res.end(); });
      else html(res, 200, signedIn(req) ? SIGNED_IN_PAGE : PASSCODE_PAGE);
      return true;
    }
    if (pathname === SIGNOUT) {
      sessions.close(cookieOf(req));
      res.writeHead(303, { Location: SIGNIN, 'Set-Cookie': setCookie('', 0), 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (!signedIn(req)) {
      if (method === 'GET' && (pathname === '/' || isPage)) html(res, 401, PASSCODE_PAGE);
      else json(res, 401, { status: 'error', code: 'sign_in_required', message: 'Sign in first.' });
      return true;
    }
    // Every request from a signed-in device renews its session (and its cookie).
    res.setHeader('Set-Cookie', setCookie(cookieOf(req), SESSION_MS / 1000));
    if (pathname === '/' && method === 'GET') {
      res.writeHead(302, { Location: HOME, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    return false;
  }

  return { intercept, guard, hasPasscode: () => Boolean(currentRecord()) };
}

module.exports = { create, writePasscodeFile, makeRecord, parseRecord, passcodeMatches, passcodeProblem, recordSource, createThrottle, createSessions, safeNext, SIGNIN, SIGNOUT, HOME, COOKIE, MIN_PASSCODE };
