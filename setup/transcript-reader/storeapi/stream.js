'use strict';

// The Server-Sent Events hub behind GET /stream. One hub for all clients, and nothing runs while there is no client: no timer, no watch, no query.
//
// What wakes it: the store's write-ahead log changing (fs.watch on the -wal file: a kqueue event, no polling) and a slow fallback tick that
// checks SQLite's change counter (PRAGMA data_version) anyway, for the moments the file watch misses; and Herdr's own events (herdr-watch.js).
// A change of the store is compared with the last look at the sessions' counters (turn count, event count, last time, title): only what
// differs is sent. A page that holds a session open names it (?sessions=) and is sent that session's changed turns themselves, so a reply is
// one O(1) update on the page, not a request.
//
// Events (each `id: <n>`, `event: <name>`, `data: <json>`):
//   hello     { as_of, sessions: { <id>: { last_idx, total } } }     first, so a page can fetch what it missed between its GET and this connection
//   live      { changes: [{ id, live: {herdr, pane, label, status} | null }] }    a snapshot first, then changes; Herdr's state and the store's bindings
//   session   { id, turns, last_at, title, log_state }               a session's counters changed (a list row updates)
//   turns     { id, turns: [...], marks }                            the turns of a named session that are new or changed (the tail turn grows in place)
//   resync    { id }                                                 too much changed to send: fetch the window again
//   asks      { asks: [...] }                                        the open asks of the live panes, whenever they change
// A comment line (`: ping`) every 20 s keeps a quiet connection open through a relay.

const fs = require('fs');

const PING_MS = 20 * 1000;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const TURN_BATCH = 200;

const sigOf = (turn) => [turn.idx, turn.reply_at, turn.reply.length, turn.input.length, turn.tools, turn.verdict, turn.ask_lines.length].join(':');
const liveSig = (live) => (live ? [live.herdr, live.pane, live.label, live.status].join('|') : '');

function createHub({ store, livePanes, scopeOf, asksNow, watch, now = () => Date.now(), log = () => {}, pollMs = 1000 }) {
  const clients = new Set();
  const listeners = new Set();  // in-process watchers of the same looks (the compatibility writers): they keep the hub awake like a client
  let counters = new Map();
  let version = null;
  let liveSigs = new Map();
  let asksSig = null;
  let fileWatch = null;
  let tick = null;
  let pinger = null;
  let unwatch = null;
  let queued = false;
  let counter = 0;
  const stats = { clients: 0, changes: 0, events: 0, turn_events: 0, dropped: 0, processing_ms: 0, last_ms: 0 };

  const write = (client, name, data) => {
    if (client.closed) return;
    counter += 1;
    stats.events += 1;
    const chunk = `id: ${counter}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    try { client.res.write(chunk); } catch { drop(client); return; }
    if (client.res.writableLength > MAX_QUEUED_BYTES) { stats.dropped += 1; drop(client); }
  };

  function drop(client) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    stats.clients = clients.size;
    try { client.res.end(); } catch { /* the connection is gone */ }
    if (!clients.size && !listeners.size) sleep();
  }

  const allowed = (client, id) => !client.scope || client.scope.has(id);
  const scopeFor = (client) => { client.scope = scopeOf(client.remote); };

  // ------------------------------------------------------------------------------------------------------------------ waking

  function wake() {
    if (fileWatch || tick) return;
    try { counters = new Map(store.counters().map((row) => [row.session_id, row])); version = store.dataVersion(); } catch { counters = new Map(); }
    const live = livePanes();
    liveSigs = new Map([...live].map(([id, value]) => [id, liveSig(value)]));
    try { asksSig = JSON.stringify(asksNow(false).asks); } catch { asksSig = null; }
    const arm = () => {
      try {
        fileWatch = fs.watch(store.file + '-wal', { persistent: false }, (event) => {
          if (event === 'rename') { try { fileWatch.close(); } catch { /* already closed */ } fileWatch = null; setTimeout(() => { if ((clients.size || listeners.size) && !fileWatch) arm(); }, 200); }
          later();
        });
        fileWatch.on('error', () => { try { fileWatch.close(); } catch { /* closed */ } fileWatch = null; });
      } catch { fileWatch = null; }
    };
    arm();
    tick = setInterval(() => { if (!fileWatch && (clients.size || listeners.size)) arm(); later(); }, pollMs);
    pinger = setInterval(() => { for (const client of [...clients]) { try { client.res.write(': ping\n\n'); } catch { drop(client); } } }, PING_MS);
    for (const timer of [tick, pinger]) if (timer.unref) timer.unref();
    if (watch) unwatch = watch.onChange(() => later('watch'));
  }

  function sleep() {
    if (fileWatch) { try { fileWatch.close(); } catch { /* closed */ } fileWatch = null; }
    clearInterval(tick); clearInterval(pinger); tick = pinger = null;
    if (unwatch) { unwatch(); unwatch = null; }
  }

  // Coalesces a burst of notices (a commit often touches the log twice) into one look, on the next turn of the event loop.
  function later(source) {
    if (queued) return;
    queued = true;
    setImmediate(() => { queued = false; try { look(source); } catch (error) { log('stream look failed: ' + (error && error.message)); } });
  }

  // -------------------------------------------------------------------------------------------------------------------- looking

  function look(source) {
    if (!clients.size && !listeners.size) return;
    const started = process.hrtime.bigint();
    let changedIds = [];
    let storeChanged = false;
    try {
      const next = store.dataVersion();
      if (next !== version) {
        version = next;
        storeChanged = true;
        const rows = store.counters();
        const seen = new Map();
        for (const row of rows) {
          seen.set(row.session_id, row);
          const before = counters.get(row.session_id);
          if (!before || before.turn_count !== row.turn_count || before.event_count !== row.event_count || before.last_at !== row.last_at || before.title !== row.title || before.log_state !== row.log_state) changedIds.push(row.session_id);
        }
        counters = seen;
      }
    } catch (error) { log('stream read failed: ' + (error && error.message)); return; }
    stats.changes += 1;
    const live = livePanes();
    for (const client of clients) if (client.remote) scopeFor(client);  // the phone's scope follows the stars and the panes

    if (changedIds.length) {
      for (const client of [...clients]) {
        for (const id of changedIds) {
          if (!allowed(client, id)) continue;
          const row = counters.get(id);
          write(client, 'session', { id, turns: row.turn_count, last_at: row.last_at, title: row.title, log_state: row.log_state });
          if (client.cursors.has(id)) sendTurns(client, id);
        }
      }
    }

    // What panes the sessions run in, and the asks: only when something that can change them did.
    const sigs = new Map([...live].map(([id, value]) => [id, liveSig(value)]));
    const changes = [];
    for (const [id, sig] of sigs) if (liveSigs.get(id) !== sig) changes.push({ id, live: live.get(id) });
    for (const id of liveSigs.keys()) if (!sigs.has(id)) changes.push({ id, live: null });
    liveSigs = sigs;
    if (changes.length) {
      for (const client of [...clients]) {
        const mine = changes.filter((change) => allowed(client, change.id));
        if (mine.length) write(client, 'live', { changes: mine });
      }
    }
    if (changes.length || (storeChanged && changedIds.some((id) => sigs.has(id)))) {
      const asks = asksNow(false).asks;
      const sig = JSON.stringify(asks);
      if (sig !== asksSig) { asksSig = sig; for (const client of [...clients]) write(client, 'asks', { asks }); }
    }
    for (const listener of [...listeners]) { try { listener({ source, storeChanged, changedIds, changes }); } catch (error) { log('stream listener failed: ' + (error && error.message)); } }
    const took = Number(process.hrtime.bigint() - started) / 1e6;
    stats.last_ms = took; stats.processing_ms += took;
  }

  // The new and changed turns of a session a client holds open. The tail turn grows in place (its reply is rewritten as the agent writes), so the
  // window starts at the client's last known turn; a turn is sent when it is new or its signature moved.
  function sendTurns(client, id) {
    const cursor = client.cursors.get(id);
    const turns = store.turns(id, { after: Math.max(-1, cursor.idx - 1), limit: TURN_BATCH });
    const changed = [];
    for (const turn of turns) {
      const sig = sigOf(turn);
      if (cursor.sigs.get(turn.idx) !== sig) { changed.push(turn); cursor.sigs.set(turn.idx, sig); }
    }
    if (!changed.length) return;
    const marks = store.marks(id);
    if (turns.length >= TURN_BATCH && turns[turns.length - 1].idx < marks.last_idx) {
      cursor.idx = marks.last_idx;
      write(client, 'resync', { id });
      return;
    }
    cursor.idx = turns.length ? turns[turns.length - 1].idx : cursor.idx;
    stats.turn_events += 1;
    write(client, 'turns', { id, turns: changed, marks: { first_idx: marks.first_idx, last_idx: marks.last_idx, total: marks.total, last_captain: marks.last_captain, last_reply: marks.last_reply, last_reply_any: marks.last_reply_any } });
  }

  // -------------------------------------------------------------------------------------------------------------------------- clients

  function add(req, res, { remote, sessions }) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'Content-Encoding': 'identity', 'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const client = { res, remote, cursors: new Map(), closed: false, scope: null };
    scopeFor(client);
    clients.add(client);
    stats.clients = clients.size;
    res.on('close', () => drop(client));
    wake();
    const have = {};
    for (const id of sessions) {
      if (!allowed(client, id) || !store.session(id)) continue;
      const marks = store.marks(id);
      have[id] = { last_idx: marks.last_idx, total: marks.total };
      // The cursor starts at the newest turn: what the page fetched before connecting is its own; `hello` says where the store is now.
      const tail = marks.last_idx === null ? [] : store.turns(id, { limit: 1 });
      client.cursors.set(id, { idx: marks.last_idx === null ? -1 : marks.last_idx, sigs: new Map(tail.map((turn) => [turn.idx, sigOf(turn)])) });
    }
    const status = store.status();
    write(client, 'hello', { as_of: status.heartbeat_at ? new Date(status.heartbeat_at * 1000).toISOString() : null, sessions: have });
    const live = livePanes();
    write(client, 'live', { changes: [...live].filter(([id]) => allowed(client, id)).map(([id, value]) => ({ id, live: value })), snapshot: true });
    write(client, 'asks', { asks: asksNow(false).asks });
  }

  // An in-process listener of every look (changed ids, live changes). Wakes the hub, so it sees changes with no client connected.
  function subscribe(listener) { listeners.add(listener); wake(); return () => { listeners.delete(listener); if (!clients.size && !listeners.size) sleep(); }; }

  function close() { listeners.clear(); for (const client of [...clients]) drop(client); sleep(); }

  return { add, subscribe, close, poke: () => later('poke'), stats: () => ({ ...stats, clients: clients.size, watching: Boolean(fileWatch) }) };
}

module.exports = { createHub, sigOf };
