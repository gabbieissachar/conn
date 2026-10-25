'use strict';

// The write side of the rollover switches: create or remove one firstmate switch file in one registered home.
// The file is the only thing written to a home. The restarts are done later by firstmate's own roller.
// Every create, removal and Stop goes through one procedure (DESIGN.md "Rollover switches"):
//   1. one in-process mutex, 2. a folder lock shared by every server on this tool root,
//   3. re-validate the home, 4. exclusive create with no link followed, parent re-checked after,
//   5. ledger inside the lock, then an audit line. Refusals are audited too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { AdapterError } = require('./adapter');
const { readRegular, PAGE_HEADER, ID_RE } = require('./rollover');
const { psIdentity } = require('./rollover');

const LIVE_FILE = { 'second-mates': 'rollover-live', crew: 'rollover-crew-live' };
const OFF_FILE = 'rollover-off';
const UNDO_FILES = new Set(['rollover-live', 'rollover-crew-live', 'rollover-off']);
const MAX_IDS = 64;
const LOCK_WAIT_MS = 3000;
const LOCK_STEP_MS = 50;
const STEAL_STALE_MS = 5000;
const HOLDERLESS_STALE_MS = 60 * 1000;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const hex = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

function refuse(status, code, message) {
  return new AdapterError(message, status, code);
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch { return null; }
}

function removeFolder(dir) {
  try {
    for (const name of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, name)); } catch { /* gone */ } }
    fs.rmdirSync(dir);
  } catch { /* gone or not empty: left for the stale rule */ }
}

function createSwitches({ rollover, toolRoot, now = () => new Date(), pidAlive, identityOf = psIdentity, platform = process.platform, lockWaitMs = LOCK_WAIT_MS, hooks = {} } = {}) {
  const dir = path.join(toolRoot, 'state', 'workspace-organizer', 'rollover-switches');
  const ledgerFile = path.join(dir, 'ledger.json');
  const auditFile = path.join(dir, 'audit.log');
  const isAlive = pidAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } });
  const myIdentity = () => (platform === 'darwin' ? identityOf(process.pid) : null);

  // ---- the private folder ----
  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = lstatOrNull(dir);
    if (!info || !info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw refuse(500, 'state_unsafe', 'The private folder for the rollover record is not usable. Nothing was written.');
    return dir;
  }

  // ---- audit: append-only, flushed before and after the file operation ----
  function audit(entry) {
    ensureDir();
    const fd = fs.openSync(auditFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NO_FOLLOW, 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ at: now().toISOString(), ...entry }) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }

  // ---- ledger: which files this page made ----
  function readLedger() {
    const text = readRegular(ledgerFile, 1024 * 1024);
    if (text === null) return { version: 1, entries: [] };
    try { const value = JSON.parse(text); return value && Array.isArray(value.entries) ? value : { version: 1, entries: [] }; } catch { return { version: 1, entries: [] }; }
  }

  function writeLedger(ledger) {
    ensureDir();
    const temp = path.join(dir, `ledger.json.tmp.${process.pid}.${hex(4)}`);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    try { fs.writeSync(fd, JSON.stringify(ledger)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, ledgerFile);
  }

  const ledgerEntry = (ledger, home, file) => ledger.entries.find((item) => item.home === home && item.file === file);

  // ---- the in-process mutex ----
  let chain = Promise.resolve();
  function withMutex(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  // ---- the folder lock shared by every server on this tool root ----
  const lockPath = path.join(dir, 'op.lock');
  const stealPath = path.join(dir, 'op.steal');

  function readHolder(target) {
    const text = readRegular(path.join(target, 'holder'), 1024);
    if (text === null) return null;
    try { const value = JSON.parse(text); return value && Number.isInteger(value.pid) && typeof value.nonce === 'string' ? value : null; } catch { return null; }
  }

  // Build the lock complete, then rename it into place: it never exists without its holder. Returns the nonce or null.
  function tryAcquire() {
    ensureDir();
    // A rename onto an existing non-empty folder fails, which is what makes two racing processes end with one holder. It would
    // succeed onto an empty folder, so a folder some other code made without a holder is looked for first and treated as held.
    if (lstatOrNull(lockPath)) return null;
    const nonce = hex(16);
    const prepared = path.join(dir, `op.new.${process.pid}.${hex(8)}`);
    fs.mkdirSync(prepared, { mode: 0o700 });
    try {
      fs.writeFileSync(path.join(prepared, 'holder'), JSON.stringify({ pid: process.pid, identity: myIdentity(), started: now().toISOString(), nonce }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(prepared, lockPath);
      return nonce;
    } catch (error) {
      removeFolder(prepared);
      if (['ENOTEMPTY', 'EEXIST', 'EISDIR', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    }
  }

  // The nonce of a lock that is stale (its holder is dead, no longer the process it names, or it has no holder and is old), else null.
  function staleNonce() {
    const info = lstatOrNull(lockPath);
    if (!info) return null;
    const holder = readHolder(lockPath);
    if (!holder) return now().getTime() - info.mtimeMs > HOLDERLESS_STALE_MS ? '' : null;
    if (!isAlive(holder.pid)) return holder.nonce;
    if (holder.identity && platform === 'darwin' && identityOf(holder.pid) !== holder.identity) return holder.nonce;
    return null;
  }

  // Two processes may judge the same dead holder stale; the second must not remove the first one's fresh lock.
  // So the reclaim takes a short steal mutex and removes the lock only if it still carries the nonce that was judged.
  async function reclaim(judged) {
    for (let tries = 0; tries < 2; tries += 1) {
      try { fs.mkdirSync(stealPath, { mode: 0o700 }); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = lstatOrNull(stealPath);
        if (!info || now().getTime() - info.mtimeMs <= STEAL_STALE_MS) return false;
        const aside = path.join(dir, `op.steal.old.${process.pid}.${hex(4)}`);
        try { fs.renameSync(stealPath, aside); removeFolder(aside); } catch { return false; }
        if (tries === 1) return false;
      }
    }
    try {
      const holder = readHolder(lockPath);
      const current = holder ? holder.nonce : (lstatOrNull(lockPath) ? '' : null);
      if (current === null || current !== judged) return false;
      if (!holder) {
        const info = lstatOrNull(lockPath);
        if (!info || now().getTime() - info.mtimeMs <= HOLDERLESS_STALE_MS) return false;
      }
      const aside = path.join(dir, `op.stale.${process.pid}.${hex(4)}`);
      fs.renameSync(lockPath, aside);
      removeFolder(aside);
      return true;
    } catch { return false; } finally { try { fs.rmdirSync(stealPath); } catch { /* released */ } }
  }

  // Resolves to a release function, or null when the lock stayed busy for the whole wait.
  async function takeFolderLock() {
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      const nonce = tryAcquire();
      if (nonce) return () => releaseFolderLock(nonce);
      const judged = staleNonce();
      if (judged !== null && await reclaim(judged)) continue;
      if (Date.now() >= deadline) return null;
      await sleep(LOCK_STEP_MS);
    }
  }

  function releaseFolderLock(nonce) {
    const holder = readHolder(lockPath);
    if (!holder || holder.nonce !== nonce) return;
    const aside = path.join(dir, `op.done.${process.pid}.${hex(4)}`);
    try { fs.renameSync(lockPath, aside); removeFolder(aside); } catch { /* left for the stale rule */ }
  }

  // ---- the home checks every operation repeats ----
  function homeFor(homeId) {
    const home = typeof homeId === 'string' ? rollover.inspect(homeId) : null;
    if (!home) throw refuse(404, 'unknown_home', 'That home is not registered with this page.');
    if (home.status !== 'ok') throw refuse(409, 'home_unavailable', 'That home cannot be used right now (' + home.status.replace(/_/g, ' ') + '). Nothing was written.');
    if (home.config === 'missing') throw refuse(409, 'no_config', 'That home has no config folder. Nothing was written.');
    if (home.config !== 'ok') throw refuse(409, 'unsafe', 'The config folder of that home is a link. Nothing was written.');
    return home;
  }

  // Exclusive create, no link followed, with the parent checked again after the file exists.
  function createSwitchFile(home, name, content) {
    const target = path.join(home.configDir, name);
    const before = lstatOrNull(home.configDir);
    if (!before || !before.isDirectory()) throw refuse(409, 'unsafe', 'The config folder of that home is not a plain folder. Nothing was written.');
    if (hooks.beforeCreate) hooks.beforeCreate(home, name);
    let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o644);
    } catch (error) {
      if (error.code === 'EEXIST') return null;
      if (error.code === 'ELOOP') return null;
      throw error;
    }
    let made;
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
      made = fs.fstatSync(fd);
    } finally { fs.closeSync(fd); }
    const after = lstatOrNull(home.configDir);
    let real = null;
    try { real = fs.realpathSync(home.configDir); } catch { /* gone */ }
    if (!after || after.dev !== before.dev || after.ino !== before.ino || real !== path.join(home.real, 'config')) {
      // The folder was swapped between the check and the create. Remove only the file this call made.
      const found = lstatOrNull(target);
      if (found && found.ino === made.ino && found.dev === made.dev) { try { fs.unlinkSync(target); } catch { /* left */ } }
      throw refuse(409, 'parent_changed', 'The config folder changed while the file was being created. The new file was removed.');
    }
    return { dev: made.dev, ino: made.ino, sha256: sha256(content) };
  }

  const record = (ledger, home, name, request, made) => {
    ledger.entries = ledger.entries.filter((item) => !(item.home === home.id && item.file === name));
    ledger.entries.push({ home: home.id, file: name, dev: made.dev, ino: made.ino, sha256: made.sha256, request, at: now().toISOString() });
    writeLedger(ledger);
  };

  // Runs one operation under the mutex and the folder lock, with an intent line before and a result line after.
  async function operate(base, body, { stop = false } = {}) {
    const request = 'r' + hex(6);
    return withMutex(async () => {
      audit({ phase: 'intent', request, ...base });
      let release = null;
      let lockBusy = false;
      try {
        release = await takeFolderLock();
        if (!release) {
          if (!stop) throw refuse(409, 'busy_other_process', 'Another page on this computer is changing rollover files. Try again in a moment.');
          lockBusy = true;
        }
        const outcome = await body({ request, lockBusy });
        audit({ phase: 'result', request, ...base, outcome: outcome.audit || 'ok', ...(outcome.extra || {}), ...(lockBusy ? { ledger: 'skipped (lock busy)' } : {}) });
        return outcome.value;
      } catch (error) {
        audit({ phase: 'result', request, ...base, outcome: error.code || 'error' });
        throw error;
      } finally { if (release) release(); }
    });
  }

  // ---- arm ----
  async function arm({ home: homeId, kind, ids, confirm }, ctx = {}) {
    if (!Object.prototype.hasOwnProperty.call(LIVE_FILE, kind)) throw refuse(400, 'bad_kind', 'The kind must be second-mates or crew.');
    if (!Array.isArray(ids) || !ids.length) throw refuse(400, 'ids_required', 'Name at least one id. Arming every eligible session is not offered.');
    if (ids.length > MAX_IDS || ids.some((id) => typeof id !== 'string' || !ID_RE.test(id))) throw refuse(400, 'bad_ids', 'Those ids are not valid.');
    const wanted = [...new Set(ids)].sort();
    if (confirm !== `rollover-arm:${homeId}:${kind}:${wanted.join(',')}`) throw refuse(400, 'confirm_required', 'This change needs an explicit confirmation.');
    const file = LIVE_FILE[kind];
    return operate({ action: 'rollover-arm', home: homeId, file, ids: wanted.length, origin: ctx.origin || '' }, async ({ request }) => {
      const home = homeFor(homeId);
      if (home.watcher !== 'running') throw refuse(409, 'no_watcher', 'No watcher is running in that home, so nothing would read the file. Nothing was written.');
      if (!home.capability || home.capability[file] !== 'read') throw refuse(409, 'unsupported', "That home's firstmate does not read " + file + '. Nothing was written.');
      if (home.switches[OFF_FILE] && home.switches[OFF_FILE].state !== 'absent') throw refuse(409, 'off_present', 'The off switch is present in that home, so a live file would do nothing. Remove the off file first. Nothing was written.');
      const group = kind === 'crew' ? home.ids.crew.list : home.ids.second_mates.list;
      const byId = new Map(group.map((item) => [item.id, item]));
      const problems = wanted.filter((id) => !byId.has(id) || !byId.get(id).ok);
      if (problems.length) {
        const error = refuse(409, 'not_rolled', problems.length + ' of those ids cannot roll now. Nothing was written.');
        error.reasons = problems.map((id) => ({ id, reason: byId.has(id) ? byId.get(id).reason : 'unknown' }));
        throw error;
      }
      const header = `${PAGE_HEADER}, request ${request}, ${now().toISOString()}\n`;
      const content = header + wanted.join('\n') + '\n';
      const made = createSwitchFile(home, file, content);
      if (!made) throw refuse(409, 'exists', file + ' already exists in that home. The page never changes an existing file. Nothing was written.');
      const ledger = readLedger();
      record(ledger, home, file, request, made);
      return { value: { home: home.id, label: home.label, file, created: true, ids: wanted.length }, audit: 'created', extra: { sha256: made.sha256 } };
    });
  }

  // ---- stop ----
  async function stop({ homes: requested } = {}, ctx = {}) {
    const all = rollover.homes.map((item) => item.id);
    const targets = requested === undefined ? all : requested;
    if (!Array.isArray(targets) || !targets.length || targets.some((id) => typeof id !== 'string' || !all.includes(id))) throw refuse(400, 'bad_homes', 'Those homes are not registered with this page.');
    const results = [];
    for (const homeId of [...new Set(targets)]) {
      const label = rollover.homes.find((item) => item.id === homeId).label;
      let result;
      try {
        result = await operate({ action: 'rollover-stop', home: homeId, file: OFF_FILE, origin: ctx.origin || '' }, async ({ request, lockBusy }) => {
          const home = rollover.inspect(homeId);
          if (home.status !== 'ok' || home.config === 'unsafe') return { value: 'unsafe', audit: 'unsafe' };
          if (home.config === 'missing') return { value: 'no_config', audit: 'no_config' };
          if (home.watcher === 'running' && (!home.capability || home.capability[OFF_FILE] !== 'read')) return { value: 'not_read', audit: 'not_read' };
          const present = home.switches[OFF_FILE].state !== 'absent';
          let outcome;
          let made = null;
          if (!present) {
            made = createSwitchFile(home, OFF_FILE, `${PAGE_HEADER}, request ${request}, ${now().toISOString()}\n`);
            outcome = made ? (home.watcher === 'running' ? 'created' : 'created_no_watcher') : 'present_other';
          } else outcome = null;
          const ledger = readLedger();
          if (made && !lockBusy) record(ledger, home, OFF_FILE, request, made);
          if (outcome === null) {
            const entry = ledgerEntry(ledger, home.id, OFF_FILE);
            const info = lstatOrNull(path.join(home.configDir, OFF_FILE));
            outcome = entry && info && info.isFile() && info.ino === entry.ino && info.dev === entry.dev ? 'present_by_page' : 'present_other';
          }
          // Close the Stop-then-Resume interleaving: look once more and put the file back if it vanished.
          if (outcome === 'created' || outcome === 'created_no_watcher' || outcome === 'present_by_page') {
            for (let again = 0; again < 2 && !lstatOrNull(path.join(home.configDir, OFF_FILE)); again += 1) {
              const redone = createSwitchFile(home, OFF_FILE, `${PAGE_HEADER}, request ${request}, ${now().toISOString()}\n`);
              if (redone && !lockBusy) record(readLedger(), home, OFF_FILE, request, redone);
            }
          }
          return { value: outcome, audit: outcome, extra: made ? { sha256: made.sha256 } : {} };
        }, { stop: true });
      } catch (error) {
        if (error.code === 'parent_changed') result = 'unsafe';
        else throw error;
      }
      results.push({ id: homeId, label, result });
    }
    return { homes: results, unregistered_homes: rollover.unregisteredCount() };
  }

  // ---- undo ----
  async function undo({ home: homeId, file, confirm }, ctx = {}) {
    if (!UNDO_FILES.has(file)) throw refuse(400, 'bad_file', 'That file cannot be removed from here.');
    if (file === OFF_FILE && confirm !== `rollover-resume:${homeId}`) throw refuse(400, 'confirm_required', 'Removing the off file turns every live switch in that home back on and needs an explicit confirmation.');
    return operate({ action: 'rollover-undo', home: homeId, file, origin: ctx.origin || '' }, async () => {
      const home = homeFor(homeId);
      const ledger = readLedger();
      const entry = ledgerEntry(ledger, home.id, file);
      if (!entry) throw refuse(409, 'not_created_by_page', 'This page did not create that file, so it is left alone.');
      const target = path.join(home.configDir, file);
      const info = lstatOrNull(target);
      if (!info) {
        ledger.entries = ledger.entries.filter((item) => item !== entry);
        writeLedger(ledger);
        throw refuse(409, 'gone', 'That file is already gone. The record of it was cleared.');
      }
      if (!info.isFile()) throw refuse(409, 'not_regular', 'That file is no longer a plain file, so it is left alone.');
      let fd;
      let text;
      try {
        fd = fs.openSync(target, fs.constants.O_RDONLY | NO_FOLLOW);
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev) throw refuse(409, 'changed_since_created', 'That file was replaced after the page created it, so it is left alone.');
        text = fs.readFileSync(fd, 'utf8');
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        throw refuse(409, 'changed_since_created', 'That file cannot be read as the page left it, so it is left alone.');
      } finally { if (fd !== undefined) fs.closeSync(fd); }
      if (sha256(text) !== entry.sha256) throw refuse(409, 'changed_since_created', 'That file was edited after the page created it. It is yours now and is left alone.');
      const last = lstatOrNull(target);
      if (!last || last.ino !== entry.ino || last.dev !== entry.dev) throw refuse(409, 'changed_since_created', 'That file was replaced after the page created it, so it is left alone.');
      fs.unlinkSync(target);
      ledger.entries = ledger.entries.filter((item) => item !== entry);
      writeLedger(ledger);
      return { value: { home: home.id, label: home.label, file, removed: true }, audit: 'removed' };
    });
  }

  return { arm, stop, undo, dir, internals: { tryAcquire, staleNonce, reclaim, releaseFolderLock, lockPath } };
}

module.exports = { createSwitches, LIVE_FILE, OFF_FILE };
