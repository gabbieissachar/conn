'use strict';

// Read only: the run records `workspace-organizer.py handoff-restart` leaves in
// `<tool root>/state/workspace-organizer/handoff-runs/`. The page uses one fact from them: a pane that had `/clear`
// typed into it and that Herdr still reports under the session id it had before, which the page marks. A record is
// private (it names a handoff document and its own path), so only the run id, the time and the three keys that name
// the pane's session leave this module. Nothing is written, and a folder or file that is a link is not read.

const fsp = require('node:fs/promises');
const path = require('node:path');

const RUN_FILE_RE = /^(handoff-\d{8}-\d{6}-[a-z0-9]{6})\.json$/;
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PANE_ID_RE = /^(w[A-Za-z0-9]{1,10}):p[A-Za-z0-9]{1,10}$/;
const ID8_RE = /^[A-Za-z0-9-]{8}$/;
const MAX_RECORDS = 100;
const MAX_BYTES = 1048576;

async function plainKind(file) {
  try {
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink()) return 'unsafe';
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'unsafe';
  } catch { return 'missing'; }
}

// Map of `<herdr session>|<pane id>|<id8 before>` to `{ run, at }`, the newest `/clear` typed for that pane's session.
async function readClearMarks(toolRoot) {
  const marks = new Map();
  let dir = path.join(toolRoot, 'state');
  for (const part of ['', 'workspace-organizer', 'handoff-runs']) {
    dir = part ? path.join(dir, part) : dir;
    if ((await plainKind(dir)) !== 'dir') return marks;
  }
  let names;
  try { names = await fsp.readdir(dir); } catch { return marks; }
  for (const name of names.filter((item) => RUN_FILE_RE.test(item)).sort().slice(-MAX_RECORDS)) {
    const file = path.join(dir, name);
    let record;
    try {
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      record = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch { continue; }
    const run = RUN_FILE_RE.exec(name)[1];
    if (!record || typeof record !== 'object' || record.run_id !== run || typeof record.session !== 'string' || !SESSION_NAME_RE.test(record.session)) continue;
    if (!record.panes || typeof record.panes !== 'object') continue;
    for (const pane of Object.values(record.panes)) {
      if (!pane || typeof pane !== 'object' || typeof pane.pane_id !== 'string' || !PANE_ID_RE.test(pane.pane_id)) continue;
      if (typeof pane.id8_before !== 'string' || !ID8_RE.test(pane.id8_before)) continue;
      const at = typeof pane.clear_typed_at === 'string' ? Date.parse(pane.clear_typed_at) : NaN;
      if (!Number.isFinite(at)) continue;
      const key = `${record.session}|${pane.pane_id}|${pane.id8_before}`;
      if (!marks.has(key) || marks.get(key).at < at) marks.set(key, { run, at });
    }
  }
  return marks;
}

module.exports = { readClearMarks };
