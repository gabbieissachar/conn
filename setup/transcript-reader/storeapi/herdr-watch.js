'use strict';

// Herdr's panes as the Node API keeps them: one `events.subscribe` stream for each running named Herdr session, so nothing polls. A
// pane's state is read from Herdr when an event says something about it, and in full by a reconcile read every minute (events are hints,
// never the truth: Herdr's schema, protocol 22, names no "events lost" message, so a connection that ends or fails is treated as one).
//
// Wire shape (the same as the store's own subscriber, store/rstore/herdr.py, probed read-only against the real Herdr): a request is one JSON
// line {"id", "method": "events.subscribe", "params": {"subscriptions": [{"type": "pane.closed"}, ...]}} on the session's unix socket
// (`socket_path` in `herdr session list --json`); the first reply is {"result": {"type": "subscription_started"}}; events follow as
// {"event": "<kind>", "data": {"type": "<kind>", ...}} lines. A quiet stream is pinged now and then, and a failed ping is a lost stream.
//
// What it does with an event:
//   pane.agent_status_changed  the pane's state is in the event: applied at once, no Herdr call.
//   pane.focused               the focused pane is in the event: applied at once.
//   anything else about panes or tabs (created, closed, updated, exited, agent_detected, moved, tab renamed ...): that one session's
//                              snapshot is read again (`api snapshot`), a few tens of milliseconds later so a burst is one read.
//   connection ended / failed  a reconcile read of every session, then a new subscription (to the socket Herdr lists now: a Herdr session
//                              that was restarted has a new one), after a backoff that doubles up to 30 s.
// It only reads: no key, no prompt, no start, no stop, no close ever goes to Herdr from here.

const fs = require('fs');
const net = require('net');

const KINDS = ['pane.created', 'pane.closed', 'pane.updated', 'pane.focused', 'pane.moved', 'pane.exited', 'pane.agent_detected', 'pane.agent_status_changed',
  'tab.created', 'tab.closed', 'tab.renamed', 'tab.focused', 'workspace.closed'];
const IDLE_PING_MS = 120 * 1000;
const READ_SETTLE_MS = 30;
const MAX_BACKOFF_MS = 30 * 1000;
const SESSION_LINE_MAX = 1024 * 1024;

const defaultLifeOf = (dir) => { try { return String(fs.statSync(dir).ino); } catch { return ''; } };

function createPaneWatch({
  runner, herdrBin = 'herdr', env = process.env, connect = (socketPath) => net.connect(socketPath), now = () => Date.now(),
  reconcileMs = 60 * 1000, backoffMs = 1000, idlePingMs = IDLE_PING_MS, readSnapshot, sessionNameOk = () => true, lifeOf = defaultLifeOf,
  runEnv = () => env, timers = { setTimeout, clearTimeout, setInterval, clearInterval },
} = {}) {
  if (typeof runner !== 'function' || typeof readSnapshot !== 'function') throw new Error('createPaneWatch needs a runner and readSnapshot');
  const sessions = new Map();  // name -> { name, life, dir, socket, focused, panes, sub }
  const listeners = new Set();
  const stats = { events: 0, reads: 0, reconciles: 0, lost: 0, subscribed: 0, ignored: 0, listCalls: 0 };
  let version = 0;
  let timer = null;
  let stopped = true;
  let reconciling = null;

  const emit = (change) => { version += 1; for (const listener of listeners) { try { listener({ ...change, version }); } catch { /* a listener never stops the watch */ } } };

  const call = async (args) => {
    const result = await runner(herdrBin, args, { env: runEnv(), timeoutMs: 5000 });
    if (!result || result.code !== 0) return null;
    try { return JSON.parse(result.stdout); } catch { return null; }
  };

  async function readSession(name) {
    const entry = sessions.get(name);
    if (!entry) return false;
    stats.reads += 1;
    const answer = await call(['--session', name, 'api', 'snapshot']);
    const snapshot = answer && answer.result && answer.result.snapshot;
    if (!snapshot) return false;
    const read = readSnapshot(name, snapshot);
    const titles = new Map((snapshot.panes || []).map((pane) => [pane.pane_id, typeof pane.terminal_title_stripped === 'string' ? pane.terminal_title_stripped : null]));
    for (const pane of read.panes) pane.title = titles.get(pane.pane_id) || null;
    const before = JSON.stringify([entry.focused, entry.panes]);
    entry.focused = read.focused;
    entry.panes = read.panes;
    if (JSON.stringify([entry.focused, entry.panes]) !== before) emit({ kind: 'panes', session: name });
    return true;
  }

  // The running named sessions as Herdr lists them now, each with its socket; a session that has gone is dropped, one that is new or has a
  // new life (deleted and made again) or a new socket is subscribed anew.
  async function reconcile() {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      stats.reconciles += 1;
      stats.listCalls += 1;
      const listing = await call(['session', 'list', '--json']);
      if (!listing || !Array.isArray(listing.sessions)) return false;  // Herdr not answering says nothing about panes: what is held stays
      const running = new Map();
      for (const item of listing.sessions) {
        if (!item || !item.running || item.default || typeof item.name !== 'string' || !sessionNameOk(item.name)) continue;
        running.set(item.name, item);
      }
      for (const [name, entry] of [...sessions]) {
        const item = running.get(name);
        if (!item || (item.session_dir && lifeOf(item.session_dir) !== entry.life) || (item.socket_path && item.socket_path !== entry.socket)) {
          dropSession(name);
          emit({ kind: 'session_gone', session: name });
        }
      }
      for (const [name, item] of running) {
        if (sessions.has(name)) continue;
        sessions.set(name, { name, life: item.session_dir ? lifeOf(item.session_dir) : '', dir: item.session_dir || '', socket: item.socket_path || '', focused: null, panes: [], sub: null });
        emit({ kind: 'session_new', session: name });
      }
      for (const name of sessions.keys()) {
        await readSession(name);
        subscribe(name);
      }
      return true;
    })().finally(() => { reconciling = null; });
    return reconciling;
  }

  function dropSession(name) {
    const entry = sessions.get(name);
    if (entry && entry.sub) entry.sub.stop();
    sessions.delete(name);
  }

  // ------------------------------------------------------------------------------------------------------------ a subscription

  function subscribe(name) {
    const entry = sessions.get(name);
    if (!entry || stopped || entry.sub || !entry.socket) return;
    const sub = { stopped: false, socket: null, pingTimer: null, retry: null, live: false, stop() {
      sub.stopped = true;
      timers.clearTimeout(sub.retry); timers.clearTimeout(sub.pingTimer);
      if (sub.socket) { try { sub.socket.destroy(); } catch { /* already closed */ } }
    } };
    entry.sub = sub;
    let settleTimer = null;
    const readSoon = () => {
      if (settleTimer) return;
      settleTimer = timers.setTimeout(() => { settleTimer = null; readSession(name).catch(() => {}); }, READ_SETTLE_MS);
    };
    const lose = (why) => {
      if (sub.stopped) return;
      sub.live = false;
      timers.clearTimeout(sub.pingTimer);
      if (sub.socket) { try { sub.socket.destroy(); } catch { /* gone */ } sub.socket = null; }
      stats.lost += 1;
      emit({ kind: 'events_lost', session: name, why });
      // The inventory is read again at once (nothing was heard while it was down), and the stream is asked for again after a backoff.
      readSession(name).catch(() => {});
      const wait = entry.delay || backoffMs;
      entry.delay = Math.min(MAX_BACKOFF_MS, wait * 2);
      sub.retry = timers.setTimeout(() => {
        if (sub.stopped || stopped) return;
        entry.sub = null;
        // A Herdr session that was restarted has a new socket: ask the list again before connecting.
        reconcile().then(() => subscribe(name)).catch(() => {});
      }, wait);
    };
    const armPing = () => {
      timers.clearTimeout(sub.pingTimer);
      sub.pingTimer = timers.setTimeout(() => {
        if (sub.stopped || !sub.socket) return;
        try { sub.socket.write(JSON.stringify({ id: 'ping', method: 'ping', params: {} }) + '\n'); } catch { lose('ping'); return; }
        // A quiet stream that answers nothing within the ping's own wait is lost (the answer arrives as a line and re-arms this).
        sub.pingTimer = timers.setTimeout(() => lose('no_pong'), Math.max(1000, Math.min(idlePingMs, 15000)));
      }, idlePingMs);
    };
    let socket;
    try { socket = connect(entry.socket); } catch { lose('connect'); return; }
    sub.socket = socket;
    let buffer = '';
    socket.setEncoding && socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: 'reader-' + process.pid, method: 'events.subscribe', params: { subscriptions: KINDS.map((type) => ({ type })) } }) + '\n');
      armPing();
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > SESSION_LINE_MAX && !buffer.includes('\n')) { lose('line_too_long'); return; }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        armPing();
        deliver(message);
      }
    });
    socket.on('error', () => lose('error'));
    socket.on('close', () => lose('closed'));

    function deliver(message) {
      const result = message.result;
      if (result && typeof result === 'object') {
        if (result.type === 'subscription_started') { sub.live = true; entry.delay = backoffMs; stats.subscribed += 1; emit({ kind: 'subscribed', session: name }); readSoon(); }
        return;  // a pong, or any other answer
      }
      const kind = message.event || (message.data && message.data.type) || message.type;
      if (typeof kind !== 'string') return;
      const data = message.data && typeof message.data === 'object' ? message.data : message;
      if (kind === 'events_lost') { lose('events_lost'); return; }
      const name_ = kind.includes('.') ? kind : kind.replace('_', '.');
      stats.events += 1;
      if (name_ === 'pane.agent_status_changed' && typeof data.pane_id === 'string' && typeof data.agent_status === 'string') {
        const pane = entry.panes.find((item) => item.pane_id === data.pane_id);
        if (pane) {
          if (pane.status !== data.agent_status) { pane.status = data.agent_status; emit({ kind: 'status', session: name, pane: pane.pane_id, status: pane.status }); }
          return;
        }
        readSoon();  // a pane this watch has not read yet
        return;
      }
      if (name_ === 'pane.focused' && typeof data.pane_id === 'string') {
        if (entry.focused !== data.pane_id) { entry.focused = data.pane_id; emit({ kind: 'focus', session: name, pane: data.pane_id }); }
        return;
      }
      if (KINDS.includes(name_)) readSoon();
      else stats.ignored += 1;
    }
  }

  // ------------------------------------------------------------------------------------------------------------------ the API

  const api = {
    // Reads Herdr once, subscribes, and keeps reconciling. Resolves when the first read is done.
    async start() {
      if (!stopped) return;
      stopped = false;
      await reconcile();
      timer = timers.setInterval(() => { reconcile().catch(() => {}); }, reconcileMs);
      if (timer && timer.unref) timer.unref();
    },
    stop() {
      stopped = true;
      timers.clearInterval(timer);
      for (const name of [...sessions.keys()]) dropSession(name);
    },
    reconcile,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    // The sessions in the shape scan() returns before the reader checks them: { name, life, focused, panes: [{ pane_id, session_id, agent, status, label }] }.
    sessions() {
      return [...sessions.values()].map((entry) => ({ name: entry.name, life: entry.life, focused: entry.focused, panes: entry.panes.map((pane) => ({ ...pane })) }));
    },
    get version() { return version; },
    get running() { return !stopped; },
    stats() {
      return { ...stats, sessions: [...sessions.values()].map((entry) => ({ name: entry.name, live: Boolean(entry.sub && entry.sub.live) })) };
    },
  };
  return api;
}

module.exports = { createPaneWatch, KINDS };
