'use strict';

// Read-only view of firstmate's context-rollover switches for the homes the operator registered.
// Nothing here writes: it reads a home's config folder, its watcher lock and its task records,
// and reports what firstmate's own roller will do at its next pass. See DESIGN.md "Rollover switches".
//
// The browser never names a path. The registry below is the only place paths enter; a home is
// reached by the id this module derives from its registered realpath.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SWITCHES = ['rollover-live', 'rollover-crew-live', 'rollover-off', 'rollover-primary-live', 'rollover-primary-off'];
const LIVE_SWITCHES = new Set(['rollover-live', 'rollover-crew-live', 'rollover-primary-live']);
const LABEL_RE = /^[A-Za-z0-9._/ -]{1,40}$/;
const ID_RE = /^[A-Za-z0-9._-]+$/;
const BEAT_GRACE_SECONDS = 300; // firstmate's default FM_GUARD_GRACE
const LOCK_FILE_MAX = 1024;
const ROLLER_MAX = 2 * 1024 * 1024;
const META_MAX = 64 * 1024;
const SWITCH_MAX = 64 * 1024;
const MAX_IDS = 200;

class RolloverConfigError extends Error {}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch { return null; }
}

function statOrNull(target) {
  try { return fs.statSync(target); } catch { return null; }
}

function realpathOrNull(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

// Reads a regular file of at most `max` bytes without following a link at the last component.
// Returns null for anything else, including an unreadable file.
function readRegular(target, max) {
  const info = lstatOrNull(target);
  if (!info || !info.isFile() || info.size > max) return null;
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// What `fm_pid_identity` prints on a system without a Linux-style /proc: the ps start time and
// command, locale and width pinned, leading blanks removed. Null when the process is gone.
function psIdentity(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      env: { ...process.env, COLUMNS: '10000', LC_ALL: 'C' }, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const text = out.replace(/\n+$/, '');
    return text ? text.replace(/^\s+/, '') : null;
  } catch { return null; }
}

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function homeIdOf(realPath) {
  return 'h' + crypto.createHash('sha256').update(realPath).digest('hex').slice(0, 8);
}

// The shortest unique tail of each path, after dropping a trailing "firstmate" segment, with at least two segments.
function defaultLabels(paths) {
  const segments = paths.map((p) => { const parts = p.split('/').filter(Boolean); if (parts[parts.length - 1] === 'firstmate') parts.pop(); return parts; });
  return segments.map((parts, index) => {
    for (let take = Math.min(2, parts.length); take <= parts.length; take += 1) {
      const tail = parts.slice(-take).join('/');
      const clash = segments.some((other, otherIndex) => otherIndex !== index && other.slice(-take).join('/') === tail);
      if (!clash) return tail;
    }
    return parts.join('/');
  });
}

function parseRegistry(env, homedir) {
  const raw = env.HERDR_ORGANIZER_ROLLOVER_HOMES;
  const entries = [];
  if (raw && raw.trim()) {
    for (const piece of raw.split(path.delimiter).map((item) => item.trim()).filter(Boolean)) {
      const match = /^([^/=]+)=(\/.*)$/.exec(piece);
      const home = match ? match[2] : piece;
      if (!path.isAbsolute(home)) throw new RolloverConfigError('HERDR_ORGANIZER_ROLLOVER_HOMES: every home must be an absolute path.');
      entries.push({ label: match ? match[1] : '', home: path.resolve(home) });
    }
  } else {
    entries.push({ label: '', home: path.resolve(env.HERDR_ORGANIZER_FM_HOME || path.join(homedir, 'fm-homes', 'pmos')) });
  }
  const registered = entries.map((entry) => ({ ...entry, real: realpathOrNull(entry.home) || entry.home }));
  const fallbacks = defaultLabels(registered.map((entry) => entry.real));
  registered.forEach((entry, index) => {
    entry.label = entry.label || fallbacks[index];
    if (!LABEL_RE.test(entry.label)) throw new RolloverConfigError('HERDR_ORGANIZER_ROLLOVER_HOMES: a label is 1 to 40 characters from letters, digits, . _ / space and -.');
  });
  const seenLabels = new Set();
  const seenReal = new Set();
  for (const entry of registered) {
    if (seenLabels.has(entry.label)) throw new RolloverConfigError('HERDR_ORGANIZER_ROLLOVER_HOMES: two homes carry the label "' + entry.label + '".');
    if (seenReal.has(entry.real)) throw new RolloverConfigError('HERDR_ORGANIZER_ROLLOVER_HOMES: the same home is listed twice.');
    seenLabels.add(entry.label);
    seenReal.add(entry.real);
    entry.id = homeIdOf(entry.real);
  }
  return registered;
}

const PAGE_HEADER = '# created by the Herdr organizer page';

// The ledger the write side keeps (rollover-switches.js): which switch files this page created, by inode and content hash.
function readLedger(ledgerPath) {
  if (!ledgerPath) return { entries: [] };
  const text = readRegular(ledgerPath, 1024 * 1024);
  if (text === null) return { entries: [] };
  try {
    const value = JSON.parse(text);
    return value && Array.isArray(value.entries) ? value : { entries: [] };
  } catch { return { entries: [] }; }
}

function createRollover({ env = process.env, homedir = os.homedir(), now = () => new Date(), identityOf = psIdentity, pidAlive = pidIsAlive, platform = process.platform, ledgerPath = '' } = {}) {
  const homes = parseRegistry(env, homedir);

  function ageSeconds(info) {
    return Math.max(0, Math.round((now().getTime() - info.mtimeMs) / 1000));
  }

  // The home is the registered one, a real directory, with real state/ and data/ folders, and is a firstmate home.
  function homeStatus(home) {
    const info = lstatOrNull(home.home);
    if (!info) return 'missing';
    const real = realpathOrNull(home.home);
    if (real !== home.real) return 'swapped';
    if (!info.isDirectory() && !info.isSymbolicLink()) return 'not_directory';
    if (!statOrNull(home.real) || !statOrNull(home.real).isDirectory()) return 'not_directory';
    for (const name of ['state', 'data']) {
      const folder = lstatOrNull(path.join(home.real, name));
      if (!folder || !folder.isDirectory()) return 'unsafe';
    }
    const registered = lstatOrNull(path.join(home.real, 'state', '.lock-session')) || lstatOrNull(path.join(home.real, '.fm-secondmate-home'));
    return registered ? 'ok' : 'not_firstmate_home';
  }

  // The same checks fm_watcher_healthy makes, from the lock firstmate writes. Returns the state and, when it
  // names one, the code root the home's watcher runs.
  function watcherOf(home) {
    const state = path.join(home.real, 'state');
    const lock = path.join(state, '.watch.lock');
    const lockInfo = lstatOrNull(lock);
    if (!lockInfo) return { state: 'no_lock' };
    if (!lockInfo.isSymbolicLink()) return { state: 'unsafe_lock' };
    let target;
    try { target = fs.readlinkSync(lock); } catch { return { state: 'unsafe_lock' }; }
    const owner = path.resolve(state, target);
    const ownerInfo = lstatOrNull(owner);
    if (!ownerInfo || !ownerInfo.isDirectory() || path.dirname(owner) !== state || !path.basename(owner).startsWith('.watch.lock.owner.')) return { state: 'unsafe_lock' };
    const field = (name) => { const text = readRegular(path.join(owner, name), LOCK_FILE_MAX); return text === null ? null : text.replace(/\n+$/, ''); };
    const pidText = field('pid');
    const lockHome = field('fm-home');
    const watcherPath = field('watcher-path');
    const lockIdentity = field('pid-identity');
    if (pidText === null || lockHome === null || watcherPath === null || lockIdentity === null) return { state: 'unsafe_lock' };
    if (!/^[0-9]+$/.test(pidText)) return { state: 'unsafe_lock' };
    const pid = Number(pidText);
    const codeRoot = codeRootOf(watcherPath);
    if (!pidAlive(pid)) return { state: 'stale_pid', code_root: codeRoot };
    if (realpathOrNull(lockHome) !== home.real) return { state: 'other_home', code_root: codeRoot };
    if (!codeRoot) return { state: 'unsafe_lock' };
    if (platform !== 'darwin') return { state: 'identity_unverifiable', code_root: codeRoot };
    if (identityOf(pid) !== lockIdentity) return { state: 'identity_mismatch', code_root: codeRoot };
    const beat = lstatOrNull(path.join(state, '.last-watcher-beat'));
    if (!beat || !beat.isFile() || ageSeconds(beat) >= BEAT_GRACE_SECONDS) return { state: 'beat_old', code_root: codeRoot };
    return { state: 'running', code_root: codeRoot };
  }

  // <root>/bin/fm-watch.sh, a regular file, becomes <root>. Anything else names no code root.
  function codeRootOf(watcherPath) {
    if (!path.isAbsolute(watcherPath) || path.basename(watcherPath) !== 'fm-watch.sh') return null;
    const info = lstatOrNull(watcherPath);
    if (!info || !info.isFile()) return null;
    const real = realpathOrNull(watcherPath);
    if (!real || path.basename(path.dirname(real)) !== 'bin') return null;
    return path.dirname(path.dirname(real));
  }

  // Which switch names the home's own roller reads: a text check of the file the next pass runs.
  function capabilityOf(codeRoot) {
    const roller = path.join(codeRoot, 'bin', 'fm-rollover.sh');
    const text = readRegular(roller, ROLLER_MAX);
    const result = {};
    for (const name of SWITCHES) {
      if (text === null) { result[name] = 'unknown'; continue; }
      result[name] = text.split('\n').some((line) => !/^\s*#/.test(line) && line.includes(name)) ? 'read' : 'not_read';
    }
    return result;
  }

  // Who made a regular switch file: the page (the ledger names its inode and content hash), a file that carries the
  // page's header with no matching record, or someone else.
  function originOf(homeId, name, info, text) {
    const recorded = readLedger(ledgerPath).entries.find((item) => item.home === homeId && item.file === name);
    if (recorded && recorded.ino === info.ino && recorded.dev === info.dev && text !== null && recorded.sha256 === crypto.createHash('sha256').update(text).digest('hex')) return 'page';
    if (text !== null && text.startsWith(PAGE_HEADER)) return 'page_header_only';
    return 'other';
  }

  function switchState(configDir, name, homeId) {
    const file = path.join(configDir, name);
    const info = lstatOrNull(file);
    if (!info) return { name, state: 'absent' };
    if (info.isSymbolicLink()) return { name, state: 'symlink', age_seconds: ageSeconds(info) };
    if (!info.isFile()) return { name, state: 'not_regular' };
    const entry = { name, state: 'regular', age_seconds: ageSeconds(info) };
    entry.origin = originOf(homeId, name, info, readRegular(file, SWITCH_MAX));
    if (LIVE_SWITCHES.has(name) && name !== 'rollover-primary-live') {
      const text = readRegular(file, SWITCH_MAX);
      if (text === null) return { ...entry, state: 'unreadable' };
      // firstmate's live_for: whitespace removed, blank and comment lines skipped, one id per remaining line.
      entry.ids_count = text.split('\n').map((line) => line.replace(/\s+/g, '')).filter((line) => line && !line.startsWith('#')).length;
    }
    return entry;
  }

  const present = (entry) => entry.state !== 'absent';
  const liveFile = (entry) => entry.state === 'regular';

  // firstmate's own sentences (live_summary_for), reduced to what is safe to show: counts, never the ids.
  function effectiveOf(files, capability) {
    const by = Object.fromEntries(files.map((entry) => [entry.name, entry]));
    const readable = (name) => capability[name] === 'read';
    const off = present(by['rollover-off']) && readable('rollover-off');
    const kind = (name, noun) => {
      if (!readable(name)) return null;
      if (off) return noun + ': off: config/rollover-off is present, so no session is rolled';
      const entry = by[name];
      if (!liveFile(entry)) return noun + ': dry-run: config/' + name + ' is absent, so nothing is sent or restarted';
      if (entry.ids_count > 0) return noun + ': live for ' + entry.ids_count + ' listed; every other one is dry-run';
      return noun + ': live for every eligible one';
    };
    let primary = null;
    if (readable('rollover-primary-live')) {
      if (off || (present(by['rollover-primary-off']) && readable('rollover-primary-off'))) primary = 'the primary: off, it is not rolled';
      else if (liveFile(by['rollover-primary-live'])) primary = 'the primary: live once it has registered';
      else primary = 'the primary: dry-run, nothing is sent or typed';
    }
    return { second_mates: kind('rollover-live', 'second mates'), crew: kind('rollover-crew-live', 'crewmates and scouts'), primary };
  }

  function metaFields(file) {
    const text = readRegular(file, META_MAX);
    const fields = {};
    if (text === null) return fields;
    for (const line of text.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
    }
    return fields;
  }

  function isDirectory(target) {
    const info = target ? statOrNull(target) : null;
    return Boolean(info && info.isDirectory());
  }

  // The ids a switch could name, each with the reason the roller would not roll it now (`ok: true` when it would).
  function idsOf(home) {
    const state = path.join(home.real, 'state');
    let entries = [];
    try { entries = fs.readdirSync(state, { withFileTypes: true }); } catch { /* no state listing */ }
    const secondMates = [];
    const crew = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.meta')) continue;
      const id = entry.name.slice(0, -'.meta'.length);
      const verdict = (reason) => (reason ? { id, ok: false, reason } : { id, ok: true });
      if (!ID_RE.test(id)) continue;
      if (!entry.isFile()) { (crew).push(verdict('symlink')); continue; }
      const fields = metaFields(path.join(state, entry.name));
      const kind = fields.kind || 'ship';
      if (kind !== 'secondmate' && kind !== 'ship' && kind !== 'scout') continue;
      const target = kind === 'secondmate' ? secondMates : crew;
      let reason = '';
      if (id === 'primary') reason = 'reserved';
      else if (!/^claude/.test(fields.harness || '')) reason = 'harness';
      else if (fields.remote_host) reason = 'remote';
      else if (kind === 'secondmate') {
        const marker = isDirectory(fields.home) ? readRegular(path.join(fields.home, '.fm-secondmate-home'), LOCK_FILE_MAX) : null;
        if (marker === null || marker.replace(/\n+$/, '') !== id) reason = 'home_unseeded';
      } else if (!isDirectory(fields.worktree)) reason = 'no_worktree';
      else {
        const brief = lstatOrNull(path.join(home.real, 'data', id, 'brief.md'));
        if (!brief || !brief.isFile()) reason = 'no_brief';
      }
      target.push(verdict(reason));
    }
    const cap = (list) => ({ list: list.sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_IDS), truncated: list.length > MAX_IDS });
    return { second_mates: cap(secondMates), crew: cap(crew) };
  }

  function homeView(home) {
    const view = { id: home.id, label: home.label, status: homeStatus(home) };
    if (view.status !== 'ok') return view;
    const configInfo = lstatOrNull(path.join(home.real, 'config'));
    view.config = !configInfo ? 'missing' : (configInfo.isDirectory() ? 'ok' : 'unsafe');
    const watcher = watcherOf(home);
    view.watcher = watcher.state;
    view.is_secondmate_home = Boolean(lstatOrNull(path.join(home.real, '.fm-secondmate-home')));
    const primaryControl = lstatOrNull(path.join(home.real, 'state', '.primary-control'));
    view.primary_registered = Boolean(primaryControl && primaryControl.isFile());
    const roller = lstatOrNull(path.join(home.real, 'state', 'rollover', 'log'));
    if (roller && roller.isFile()) view.roller_log_age_seconds = ageSeconds(roller);
    const configDir = path.join(home.real, 'config');
    const capability = watcher.state === 'running' && watcher.code_root ? capabilityOf(watcher.code_root) : null;
    if (view.config === 'ok') {
      view.files = SWITCHES.map((name) => {
        const entry = switchState(configDir, name, home.id);
        if (capability) entry.capability = capability[name];
        return entry;
      });
      const handoff = lstatOrNull(path.join(configDir, 'rollover-primary-handoff-dir'));
      view.primary_handoff_dir = Boolean(handoff);
      view.effective = capability ? effectiveOf(view.files, capability) : null;
    }
    view.ids = idsOf(home);
    return view;
  }

  // Firstmate homes on this machine that are not registered here: a count, no names or paths.
  function unregisteredCount() {
    const found = new Set();
    const add = (candidate) => { const real = realpathOrNull(candidate); if (real && isDirectory(real)) found.add(real); };
    try {
      const treehouse = path.join(homedir, '.treehouse');
      for (const group of fs.readdirSync(treehouse)) {
        if (!group.startsWith('firstmate-')) continue;
        let slots = [];
        try { slots = fs.readdirSync(path.join(treehouse, group)); } catch { /* unreadable group */ }
        for (const slot of slots) add(path.join(treehouse, group, slot, 'firstmate'));
      }
    } catch { /* no treehouse */ }
    try { for (const name of fs.readdirSync(path.join(homedir, 'fm-homes'))) add(path.join(homedir, 'fm-homes', name)); } catch { /* no fm-homes */ }
    for (const entry of homes) found.delete(entry.real);
    return found.size;
  }

  // Everything a write needs to decide about one registered home, read fresh. Null for an id that is not registered.
  function inspect(homeId) {
    const home = homes.find((item) => item.id === homeId);
    if (!home) return null;
    const status = homeStatus(home);
    const result = { id: home.id, label: home.label, real: home.real, status };
    if (status !== 'ok') return result;
    const configInfo = lstatOrNull(path.join(home.real, 'config'));
    result.config = !configInfo ? 'missing' : (configInfo.isDirectory() ? 'ok' : 'unsafe');
    result.configDir = path.join(home.real, 'config');
    const watcher = watcherOf(home);
    result.watcher = watcher.state;
    result.capability = watcher.state === 'running' && watcher.code_root ? capabilityOf(watcher.code_root) : null;
    result.ids = idsOf(home);
    result.switches = result.config === 'ok' ? Object.fromEntries(SWITCHES.map((name) => [name, switchState(result.configDir, name, home.id)])) : {};
    return result;
  }

  function state() {
    return {
      read_only: true,
      platform_supported: platform === 'darwin',
      homes: homes.map(homeView),
      unregistered_homes: unregisteredCount(),
    };
  }

  return { state, inspect, unregisteredCount, homes: homes.map(({ id, label }) => ({ id, label })), SWITCHES };
}

module.exports = { createRollover, RolloverConfigError, psIdentity, defaultLabels, readRegular, SWITCHES, PAGE_HEADER, ID_RE };
