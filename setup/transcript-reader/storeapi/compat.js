'use strict';

// Compatibility writers: the two files an out-of-process reader (Conn) reads today, kept current from the store and the pane watch while the
// builder's own writes are no longer what refreshes them. A failed parse silently empties Conn's starred bar and rows, so each file is
// replaced whole through a rename (a read never sees half of it), only when its content changed, owner-only (0600).
//
//   out/pane-labels.json  every session seen in a Herdr pane -> { herdr, label, life, pane, status, title }: the builder's own file and format
//                         (build_prototype.pane_labels). It keeps what it had (a session whose pane closed keeps its last label, which the
//                         page's "closed panes" offer), and is updated for each session a live pane runs now: the store's live binding says
//                         which session, Herdr's event stream says the label and state. Not written while Herdr is not answering.
//   out/glance.json       the glance feed (version 1) from the store's query, when asked for (a client that has not moved to the API yet).
//
// stars.json is not written here: stars are still kept by the stars route (pinstore.js, the owner's file outside the repo), which writes it
// on every star and unstar, so it is already current. It becomes a writer here when stars move into the store's `marks` (S2's helm half).

const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 150;

function writeIfChanged(file, text) {
  try { if (fs.readFileSync(file, 'utf8') === text) return false; } catch { /* not there yet */ }
  const partial = file + '.' + process.pid + '.partial';
  const fd = fs.openSync(partial, 'w', 0o600);
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
  fs.renameSync(partial, file);
  return true;
}

function create({ outDir, watch, glance = null, now = () => Date.now(), log = () => {}, livePanes, hub = null }) {
  const labelsFile = path.join(outDir, 'pane-labels.json');
  const glanceFile = path.join(outDir, 'glance.json');
  let cache = null;
  let timer = null;
  let unwatch = null;
  let unsubscribe = null;
  let lastGlance = null;
  const stats = { labels_writes: 0, glance_writes: 0, bytes: 0 };

  function readCache() {
    try { const value = JSON.parse(fs.readFileSync(labelsFile, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  }

  function writeLabels() {
    if (!watch || !watch.sessions().length) return false;  // Herdr not answering (or no session running) says nothing about panes
    if (!cache) cache = readCache();
    const panes = new Map();
    const lives = new Map();
    for (const session of watch.sessions()) { lives.set(session.name, session.life); for (const pane of session.panes) panes.set(session.name + '|' + pane.pane_id, pane); }
    for (const [id, live] of livePanes()) {
      const pane = panes.get(live.herdr + '|' + live.pane);
      cache[id] = { herdr: live.herdr, label: live.label, life: lives.get(live.herdr) || '', pane: live.pane, status: live.status, title: (pane && pane.title) || '' };
    }
    // The builder writes sorted keys, indent 1: the same bytes for the same content, so an unchanged file is not rewritten.
    const sorted = {};
    for (const key of Object.keys(cache).sort()) sorted[key] = Object.fromEntries(Object.entries(cache[key]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const out = JSON.stringify(sorted, null, 1);
    const wrote = writeIfChanged(labelsFile, out);
    if (wrote) { stats.labels_writes += 1; stats.bytes += Buffer.byteLength(out); }
    return wrote;
  }

  function writeGlance() {
    if (!glance) return false;
    const feed = glance();
    // The feed changes only when an ask, a conversation's last turn or its pane comes, goes or changes (as the builder's does), not with the build time.
    const content = JSON.stringify(feed.conversations);
    if (content === lastGlance) return false;
    lastGlance = content;
    const out = JSON.stringify({ as_of: feed.as_of, version: feed.version, conversations: feed.conversations }, null, 1);
    const wrote = writeIfChanged(glanceFile, out);
    if (wrote) { stats.glance_writes += 1; stats.bytes += Buffer.byteLength(out); }
    return wrote;
  }

  function writeNow() {
    let any = false;
    try { any = writeLabels() || any; } catch (error) { log('pane-labels.json not written: ' + (error && error.message)); }
    try { any = writeGlance() || any; } catch (error) { log('glance.json not written: ' + (error && error.message)); }
    return any;
  }

  const soon = () => { if (timer) return; timer = setTimeout(() => { timer = null; writeNow(); }, DEBOUNCE_MS); if (timer.unref) timer.unref(); };

  return {
    start() { if (watch) unwatch = watch.onChange(soon); if (hub) unsubscribe = hub.subscribe(soon); soon(); },
    stop() { if (unwatch) unwatch(); if (unsubscribe) unsubscribe(); clearTimeout(timer); timer = null; },
    writeNow, stats: () => ({ ...stats }),
  };
}

module.exports = { create, writeIfChanged };
