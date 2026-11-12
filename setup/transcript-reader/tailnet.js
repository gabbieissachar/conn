'use strict';

// Opt-in access to the reader from another device on the owner's tailnet (their phone).
// server.js adds a listener on the Mac's Tailscale IPv4 address, next to the loopback
// ones, only when serve.sh was started with --tailnet, Tailscale answered with an
// address and a passcode is set. Everything arriving on that listener goes through
// intercept() first:
//
//   - the guard checks (Host and Origin must be the tailnet address and port, Fetch-Metadata)
//   - no valid session: a passcode page for a page request, 401 JSON for anything else
//   - a correct passcode on POST /transcript-reader/signin sets the session cookie, and
//     GET /transcript-reader/signin?check=1 tells the page whether that cookie came back
//   - GET /transcript-reader/signout ends the session
//   - one exception to the session: a GET for the HTML viewer (api.js), which a sandboxed page
//     without its own origin loads for itself and so cannot send the SameSite cookie with. Its
//     address holds a random key that only a signed-in page was given, and api.js checks it.
//
// A session that passes goes on to api.js, whose routes check Host, Origin, Fetch-Metadata
// and the per-start token again, so a phone needs both the cookie and the token the page
// carries. Requests on the loopback listeners never come here.
//
// The Herdr organizer's phone listener (setup/herdr-organizer/phone.js) uses this same module with its
// own site (paths, wording), the same passcode file and the same cookie, so one sign-in opens both; the
// reader's site is the default.
//
// Every sign-in attempt, refused ones included, is one line in the server log with the
// client address and the outcome (never the passcode), so a phone that cannot get in can be
// read from the Mac. The passcode page shows each way a sign-in can fail in words.
// So is every request the guard refuses, on any route: one line with the method, the path (no query, a
// viewer's key left out), the listener, the Host, Origin and Fetch-Metadata headers it carried, and never a
// token, cookie or passcode (refusalLog). A refused page load (a tab opening an address, which the browser
// would show as bare text) gets a short page that says why and links to the reader's own address
// (refusedPage); a fetch, a frame or a POST keeps the plain answer.
//
// The passcode is stored only as a salted scrypt hash in one owner-only file (set with
// `serve.sh passcode`, which reads it from the terminal without echo). Sessions are files in a
// folder beside it, so the reader and the organizer share one sign-in: a new passcode signs every device
// out of both, and so does a removed passcode file; a restart does not.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createGuard } = require('../herdr-organizer/guard');

const SIGNIN = '/transcript-reader/signin';
const SIGNOUT = '/transcript-reader/signout';
const HOME = '/setup/transcript-reader/out/prototype.html';
// One cookie name for every site that shares the passcode: browsers scope a cookie to the address, not the port, so
// the one sign-in reaches the reader (port 8768) and the organizer (port 8765) alike.
const COOKIE = 'pmos_session';
// What differs between the pages that use this module: where the sign-in lives, where a signed-in phone
// lands, and the words (the passcode, the cookie and the sessions are shared). prefix is the folder the sign-in routes sit under; landing is
// where a page with nothing better to go back to ends up. rootRedirect: whether "/" is the reader's
// front door (a site that serves an explicit list of paths has no "/").
const READER_SITE = {
  noun: 'reader', title: 'Transcript reader', openLabel: 'Open the reader', passcodeCommand: 'serve.sh passcode',
  prefix: '/transcript-reader/', signin: SIGNIN, signout: SIGNOUT, home: HOME, landing: '/', rootRedirect: true,
};
const TAILNET_RANGE = [100 * 2 ** 24 + 64 * 2 ** 16, 100 * 2 ** 24 + 128 * 2 ** 16];  // 100.64.0.0/10, Tailscale's addresses
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;  // idle: every request from the phone renews it
const RENEW_AFTER_MS = 60 * 60 * 1000;
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

// The passcode file every phone listener uses unless told otherwise: PMOS_READER_PASSCODE_FILE, else the reader's
// out/passcode.json in this copy of the repo (gitignored). One file, one passcode command (reader serve.sh passcode).
function defaultPasscodeFile(root, env = process.env) {
  return env.PMOS_READER_PASSCODE_FILE || path.join(root, 'setup', 'transcript-reader', 'out', 'passcode.json');
}

// Whether text is a Tailscale IPv4 address, the only kind a tailnet listener may bind.
function isTailnetAddress(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return false;
  const value = parts.reduce((sum, part) => sum * 256 + Number(part), 0);
  return value >= TAILNET_RANGE[0] && value < TAILNET_RANGE[1];
}

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

// Sessions are one small file each in a folder beside the passcode file, named by the SHA-256 of
// their token, so looking one up never compares the token itself, and what the folder holds cannot be
// replayed as a cookie. They are on disk so that every server using this passcode file (the reader's and
// the Herdr organizer's, on the same Tailscale address) accepts the same sign-in, and a sign-out in one
// ends the session in both. A file holds the expiry and a digest of the passcode hash that was current at
// sign-in, so a new passcode ends every session. Each session is its own file, so two servers never
// rewrite one shared file. A restart keeps sessions; a lookup renews one at most once an hour (the
// cookie itself is renewed on every request).
function createSessions(now, dir) {
  const fileOf = (token) => path.join(dir, crypto.createHash('sha256').update(token).digest('hex'));
  const digest = (generation) => crypto.createHash('sha256').update(String(generation)).digest('hex');
  const read = (file) => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value.exp === 'number' && typeof value.gen === 'string' ? value : null;
    } catch { return null; }
  };
  const write = (file, value) => {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  const drop = (file) => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
  return {
    open(generation) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const live = [];
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (/^[0-9a-f]{64}$/.test(name)) {
          const value = read(file);
          if (!value || value.exp <= now()) drop(file); else live.push({ file, exp: value.exp });
        } else if (name.endsWith('.tmp')) {
          try { if (Date.now() - fs.statSync(file).mtimeMs > 60 * 1000) drop(file); } catch { /* gone */ }
        }
      }
      live.sort((a, b) => a.exp - b.exp);
      while (live.length >= MAX_SESSIONS) drop(live.shift().file);
      const token = crypto.randomBytes(32).toString('base64url');
      write(fileOf(token), { exp: now() + SESSION_MS, gen: digest(generation) });
      return token;
    },
    // A session made under an earlier passcode is no longer valid.
    valid(token, generation) {
      if (typeof token !== 'string' || !token || token.length > 200) return false;
      const file = fileOf(token);
      const value = read(file);
      if (!value) return false;
      if (value.exp <= now() || value.gen !== digest(generation)) { drop(file); return false; }
      if (value.exp - now() < SESSION_MS - RENEW_AFTER_MS) write(file, { exp: now() + SESSION_MS, gen: value.gen });
      return true;
    },
    close(token) { if (typeof token === 'string' && token) drop(fileOf(token)); },
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
#w{margin:14px 0 0;color:var(--bad);font-size:14px}
`.trim();

// The page's one script, written for one site. Every way a sign-in can end shows in #m; nothing ends silently:
// a wrong passcode, a lock with its wait, a refusal by the guard (plain text), a network error, no
// answer in 10 seconds, an answer that is not the server's, a right passcode whose cookie did not come
// back, and a page that did not open. #w is a message the script removes as its first act, so a page
// whose script cannot run (turned off or blocked) says so instead of sitting there.
// Signing in at the very address that asked for it (a page opened with #s=..., or the reload after a
// sign-out) must load it again: replacing the location with itself only moves within the page when it has a fragment.
const scriptFor = (site) => `
var f=document.getElementById('f'),p=document.getElementById('p'),m=document.getElementById('m'),b=document.getElementById('b');
document.getElementById('w').remove();
var label=b.textContent,here=location.pathname+location.search+location.hash;
var next=location.pathname.indexOf('${site.prefix}')===0?'${site.landing}':here;
function stop(text,clear){if(clear)p.value='';b.disabled=false;b.textContent=label;m.textContent=text;p.focus()}
function parse(t){try{var j=JSON.parse(t);return j&&typeof j==='object'?j:null}catch(e){return null}}
function ask(url,init){return new Promise(function(resolve,reject){
var c=typeof AbortController==='function'?new AbortController():null,done=false;
var t=setTimeout(function(){done=true;if(c)c.abort();reject('timeout')},10000);
if(c)init.signal=c.signal;
fetch(url,init).then(function(r){return r.text().then(function(s){return{r:r,t:s,j:parse(s)}})}).then(function(x){if(done)return;done=true;clearTimeout(t);resolve(x)},function(){if(done)return;done=true;clearTimeout(t);reject('network')})})}
function why(x){
var s=x.r.status,j=x.j||{},n=Number(j.retry_after)||0,t=x.j?'':x.t.trim().slice(0,100);
if(j.code==='wrong_passcode')return'Wrong passcode.'+(n?' Too many wrong tries in a row: sign-in is locked for '+n+' seconds.':'');
if(j.code==='throttled')return'Too many wrong passcodes. Try again in '+n+' seconds.';
if(j.code==='busy')return'The laptop is busy checking other tries. Try again in a moment.';
if(j.code==='no_passcode')return'No passcode is set on the laptop. Set one there with ${site.passcodeCommand}.';
if(j.code==='bad_request')return'The ${site.noun} could not read the request (HTTP '+s+'). Reload this page and try again.';
if(j.code==='internal')return'The ${site.noun} hit an unexpected error. Its log on the laptop says why.';
if(s===403||s===405||s===415)return'The ${site.noun} refused the request (HTTP '+s+(t&&t.indexOf('<')<0?': '+t:'')+'). Open this page at the exact address the laptop shows, with no proxy, VPN or other name in between.';
return'The ${site.noun} gave an answer this page cannot read (HTTP '+s+'). Something between the phone and the laptop may have answered instead.'}
function open(to){b.textContent='Opening...';if(to===here)location.reload();else location.replace(to);
setTimeout(function(){stop('You are signed in, but the ${site.noun} did not open. Reload this page.',false)},8000)}
f.addEventListener('submit',function(e){
e.preventDefault();if(b.disabled)return;b.disabled=true;b.textContent='Checking...';m.textContent='';
ask('${site.signin}',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({passcode:p.value,next:next})})
.then(function(x){
if(!(x.r.ok&&x.j&&x.j.status==='ok'&&x.j.next)){stop(why(x),x.j&&x.j.code==='wrong_passcode');return}
return ask('${site.signin}?check=1',{credentials:'same-origin',cache:'no-store'}).then(function(y){
if(!(y.r.ok&&y.j))stop(why(y),false);
else if(y.j.signed_in)open(x.j.next);
else stop('The passcode was right, but this browser did not keep the sign-in cookie, so the ${site.noun} would only ask again. Allow cookies for this address (and leave Private Browsing), then try again.',false)})})
.catch(function(e){stop(e==='timeout'?'The ${site.noun} did not answer within 10 seconds. Check that the laptop is awake and on the tailnet, then try again.'
:e==='network'?'Could not reach the ${site.noun}. Check that this phone is on the tailnet and the laptop is awake, then try again.'
:'Something went wrong on this page: '+(e&&e.message||e),false)})});
`.trim();

const sourceHash = (text) => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;

// The two pages of a site, built once: the passcode page (with its content policy, whose hashes name
// exactly this style and script) and the signed-in page.
const pageSets = new Map();
function pagesFor(site) {
  let pages = pageSets.get(site);
  if (pages) return pages;
  const script = scriptFor(site);
  const headers = {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'none'; style-src ${sourceHash(STYLE)}; script-src ${sourceHash(script)}; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
  };
  const shell = (body, withScript) => '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">'
    + `<title>${site.title}</title><style>${STYLE}</style></head><body><main>${body}</main>${withScript ? `<script>${script}</script>` : ''}</body></html>`;
  pages = {
    headers,
    passcode: shell(`<h1>${site.title}</h1><p>Enter the passcode set on the laptop.</p>`
      + '<form id="f" autocomplete="on"><label for="p">Passcode</label>'
      + '<input id="p" type="password" name="passcode" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>'
      + `<p id="m" role="alert" aria-live="polite"></p><button id="b" type="submit">${site.openLabel}</button></form>`
      + '<p id="w" role="alert">The passcode check did not start: JavaScript is turned off for this page or the browser blocked its script. Turn JavaScript on, reload this page and try again.</p>', true),
    signedIn: shell(`<h1>Signed in</h1><p>This device can open the ${site.noun}.</p><a class="button" href="${site.home}">${site.openLabel}</a>`
      + `<a class="quiet" href="${site.signout}">Sign out</a>`, false),
  };
  pageSets.set(site, pages);
  return pages;
}

// ----------------------------------------------------------- refused requests

// A header value or path as one safe token for a log line: printable ASCII only (anything else is "?"), cut at max, "-" when absent.
const shown = (value, max = 120) => (value === undefined || value === null || value === '' ? '-' : String(value).replace(/[^\x21-\x7e]/g, '?').slice(0, max));
// The path of a request without its query or fragment, and without the key of an HTML viewer address (api/.../html/<key>/...), which is that
// address's own credential.
const loggedPath = (url) => shown(String(url || '').split(/[?#]/)[0].replace(/(\/html\/)[^/]+/, '$1<key>'), 200);

const REFUSALS_PER_MINUTE = 60;
// What a guard's onRefuse does: one log line per refusal naming the request. At most REFUSALS_PER_MINUTE a minute, so a page that fires
// at the address in a loop cannot fill the log; the first refusal of the next minute says how many were left out.
function refusalLog({ listener, log = (line) => process.stderr.write(line + '\n'), now = () => Date.now() }) {
  let since = -Infinity;
  let written = 0;
  let left = 0;
  return (req, verdict) => {
    const t = now();
    if (t - since >= 60 * 1000) {
      if (left) log(`${new Date(t).toISOString()} Guard: ${left} more refusals on ${listener} in the minute before were not logged`);
      since = t;
      written = 0;
      left = 0;
    }
    if (written >= REFUSALS_PER_MINUTE) { left += 1; return; }
    written += 1;
    const header = (name) => shown(req.headers && req.headers[name]);
    log(`${new Date(t).toISOString()} Guard: refused ${shown(req.method, 12)} ${loggedPath(req.url)} on ${listener} (${verdict.status} ${verdict.message}) from=${shown(req.socket && req.socket.remoteAddress)}`
      + ` host=${header('host')} origin=${header('origin')} sec-fetch-site=${header('sec-fetch-site')} sec-fetch-mode=${header('sec-fetch-mode')} sec-fetch-dest=${header('sec-fetch-dest')}`);
  };
}

// A tab opening an address: a GET whose Fetch-Metadata says navigate and document (a fetch, a frame, a POST are not).
const isNavigation = (req) => String(req.method || '').toUpperCase() === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const REFUSED_STYLE = STYLE + '\n' + `
.go{display:flex;align-items:center;min-height:48px;margin-top:14px;padding:10px 12px;border:1px solid var(--accent);border-radius:10px;color:var(--accent);font-weight:600;font-size:15px;line-height:1.3;text-decoration:none;overflow-wrap:anywhere}
.fine{margin:16px 0 0;font-size:13px}
`.trim();
const REFUSED_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': `default-src 'none'; style-src ${sourceHash(REFUSED_STYLE)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
};

// What a refused page load says. verdict is the guard's; origin is the address the reader serves on (guard.origin), the link's target
// with site.home. A page from another site (cross-site) and one from the same site (another port on this machine, another machine of
// the tailnet) are named as what they are; a Host the reader does not answer on and any other refusal say that instead.
function refusedPage(verdict, origin, site = READER_SITE) {
  const address = origin + site.home;
  const from = verdict.fetchSite === 'same-site' ? 'a link on a page of the same site, such as another port on this machine or another machine on your tailnet'
    : verdict.fetchSite ? 'a link on a page of another site' : '';
  const body = from
    ? `<h1>Opened from another page</h1><p>This address was opened from ${from}. The ${site.noun} does not open that way.</p><p>Open it from its own address:</p>`
    : /^Host /.test(verdict.message) ? `<h1>Not the ${site.noun}'s address</h1><p>The ${site.noun} does not answer at the address you used.</p><p>Open it from its own address:</p>`
    : `<h1>The ${site.noun} refused this request</h1><p>${escapeHtml(verdict.message)}.</p><p>Open it from its own address:</p>`;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">'
    + `<title>${escapeHtml(site.title)}</title><style>${REFUSED_STYLE}</style></head><body><main>${body}`
    + `<a class="go" href="${escapeHtml(address)}" aria-label="${escapeHtml(address)}">${escapeHtml(address).replace(/\//g, '/<wbr>')}</a>`
    + `<p class="fine">The ${site.noun}'s log on the laptop has this refusal.</p></main></body></html>`;
}

// The answer to a refused request: the page above for a page load (same status as the guard gave), otherwise plain(), the answer the route
// had before. origin: guard.origin.
function refuse(req, res, verdict, origin, plain, site = READER_SITE) {
  if (!isNavigation(req)) { plain(); return; }
  res.writeHead(verdict.status, REFUSED_HEADERS);
  res.end(refusedPage(verdict, origin, site));
}

// ------------------------------------------------------------------ the listener

const text = (res, status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
};
const html = (res, status, headers, page) => { res.writeHead(status, headers); res.end(page); };

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

function cookieOfName(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

// Only a same-origin path: a leading slash, and not "//host" or "/\host".
const safeNext = (value, site = READER_SITE) => (typeof value === 'string' && value.length <= 2048 && /^\/(?![/\\])[^\s\\]*$/.test(value) && !value.startsWith(site.signin) && !value.startsWith(site.signout) ? value : site.landing);

// ip and port are where the listener is bound (host, the name the browser types, is the ip unless the listener is
// the TLS one: scheme "https" and the machine's Tailscale name, whose cookie then carries Secure); passcodeFile holds the hash; token is the
// server's per-start token, shared with the loopback guard so pages carry one token. log takes
// one line of text, the sign-in record (the server's own log by default). site: see READER_SITE. sessionsDir: where
// sessions are kept; every server given the same passcode file shares it (see createSessions).
function create({ ip, host = ip, scheme = 'http', port, token, tokenHeader, passcodeFile, sessionsDir = `${passcodeFile}.sessions`, site = READER_SITE, now = () => Date.now(), log = (line) => process.stderr.write(line + '\n') }) {
  const guard = createGuard({ port, token, tokenHeader, hosts: [host], scheme, onRefuse: refusalLog({ listener: scheme === 'https' ? 'tailnet-https' : 'tailnet', log, now }) });
  const pages = pagesFor(site);
  const cookieOf = (req) => cookieOfName(req, COOKIE);
  const currentRecord = recordSource(passcodeFile);
  const sessions = createSessions(now, sessionsDir);
  const throttle = createThrottle(now);
  let verifying = 0;

  const setCookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${scheme === 'https' ? '; Secure' : ''}`;
  const signedIn = (req) => { const record = currentRecord(); return Boolean(record) && sessions.valid(cookieOf(req), record.hash); };
  // One line per sign-in attempt: when, which address, what came of it. Never the passcode.
  const note = (req, outcome) => log(`${new Date(now()).toISOString()} Tailnet: sign-in from ${req.socket.remoteAddress || 'unknown address'}: ${outcome}`);

  async function signIn(req, res) {
    const record = currentRecord();
    if (!record) { note(req, 'no passcode is set'); json(res, 503, { status: 'error', code: 'no_passcode', message: 'No passcode is set.' }); return; }
    let body;
    try { body = await readBody(req); } catch (error) { note(req, `bad request (${error.status || 400})`); json(res, error.status || 400, { status: 'error', code: 'bad_request', message: 'Bad request.' }); return; }
    const candidate = body && body.passcode;
    if (typeof candidate !== 'string') { note(req, 'bad request (400, no passcode in it)'); json(res, 400, { status: 'error', code: 'bad_request', message: 'Bad request.' }); return; }
    const address = req.socket.remoteAddress || '';
    const wait = throttle.attempt(address);
    if (wait) {
      const seconds = Math.ceil(wait / 1000);
      note(req, `refused, locked for ${seconds} more s`);
      json(res, 429, { status: 'error', code: 'throttled', message: 'Too many wrong passcodes.', retry_after: seconds }, { 'Retry-After': String(seconds) });
      return;
    }
    if (verifying >= MAX_VERIFYING) { note(req, 'refused, too many passcodes being checked at once'); json(res, 429, { status: 'error', code: 'busy', message: 'Try again in a moment.', retry_after: 2 }, { 'Retry-After': '2' }); return; }
    let ok = false;
    if (!passcodeProblem(candidate)) {
      verifying += 1;
      try { ok = await passcodeMatches(record, candidate); } catch { ok = false; } finally { verifying -= 1; }
    }
    // The file may have changed while this one was checked: only the passcode it held then counts.
    if (!ok || currentRecord() !== record) {
      const seconds = Math.ceil(throttle.waiting(address) / 1000);
      note(req, seconds ? `wrong passcode, now locked for ${seconds} s` : 'wrong passcode');
      json(res, 401, { status: 'error', code: 'wrong_passcode', message: 'Wrong passcode.', retry_after: seconds });
      return;
    }
    throttle.passed(address);
    note(req, 'ok');
    json(res, 200, { status: 'ok', next: safeNext(body.next, site) }, { 'Set-Cookie': setCookie(sessions.open(record.hash), SESSION_MS / 1000) });
  }

  // Returns true when this module answered. false: the request is signed in and api.js goes on.
  // isPage: whether the path names one of the reader's built pages. isViewer: whether it names
  // the HTML viewer's address (api.js), which needs the guard's Host check but no session.
  function intercept(req, res, url, isPage, isViewer = false) {
    const verdict = guard.check(req, { requireToken: false, crossSite: isViewer });
    const method = String(req.method).toUpperCase();
    const pathname = url.pathname;
    if (!verdict.ok) {
      refuse(req, res, verdict, guard.origin, () => text(res, verdict.status, verdict.message), site);
      return true;
    }
    if (pathname === site.signin) {
      if (method === 'POST') signIn(req, res).catch((error) => { note(req, `error (${(error && error.message) || error})`); if (!res.headersSent) json(res, 500, { status: 'error', code: 'internal', message: 'Unexpected error.' }); else res.end(); });
      else if (url.searchParams.get('check') === '1') {
        // The passcode page asks this right after a correct passcode: did the cookie come back?
        const signed = signedIn(req);
        if (!signed) note(req, 'cookie check failed: the browser sent no valid session cookie right after a correct passcode');
        json(res, 200, { status: 'ok', signed_in: signed });
      } else html(res, 200, pages.headers, signedIn(req) ? pages.signedIn : pages.passcode);
      return true;
    }
    if (pathname === site.signout) {
      sessions.close(cookieOf(req));
      res.writeHead(303, { Location: site.signin, 'Set-Cookie': setCookie('', 0), 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (isViewer && method === 'GET') return false;
    if (!signedIn(req)) {
      if (method === 'GET' && ((site.rootRedirect && pathname === '/') || isPage)) html(res, 401, pages.headers, pages.passcode);
      else json(res, 401, { status: 'error', code: 'sign_in_required', message: 'Sign in first.' });
      return true;
    }
    // Every request from a signed-in device renews its session (and its cookie).
    res.setHeader('Set-Cookie', setCookie(cookieOf(req), SESSION_MS / 1000));
    if (site.rootRedirect && pathname === '/' && method === 'GET') {
      res.writeHead(302, { Location: site.home, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    return false;
  }

  return { intercept, guard, hasPasscode: () => Boolean(currentRecord()) };
}

module.exports = { create, refusalLog, refusedPage, refuse, isNavigation, isTailnetAddress, defaultPasscodeFile, READER_SITE, writePasscodeFile, makeRecord, parseRecord, passcodeMatches, passcodeProblem, recordSource, createThrottle, createSessions, safeNext, SIGNIN, SIGNOUT, HOME, COOKIE, MIN_PASSCODE };
