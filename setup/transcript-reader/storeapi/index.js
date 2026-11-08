'use strict';

// The store-backed API (S2, pmos half): routes that read the shadow store (store.js) and Herdr's own event stream (herdr-watch.js), behind
// a flag that is off by default (api.js: `storeApi`, set by PMOS_READER_STORE_API=1 in server.js). The old routes and the current pages are
// untouched; with the flag off none of these paths exists (api.js answers 404 as it did).
//
//   GET /api/transcript-reader/sessions[?limit=&offset=&live=1&starred=1&harness=]   the sessions, newest activity first
//   GET /api/transcript-reader/sessions/<id>/turns[?after=<idx>|before=<idx>&limit=] a window of one session's turns, oldest first
//   GET /api/transcript-reader/asks                                                 the open asks of the live panes (the open-asks shape)
//   GET /api/transcript-reader/glance                                               the glance feed (version 1) as a store query
//   GET /api/transcript-reader/search?q=&limit=                                      full-text search, one row per session
//   GET /api/transcript-reader/stream[?sessions=<id>,<id>]                           Server-Sent Events: sessions, turns, live, asks
//   GET /api/transcript-reader/store-status                                         what the API itself reads: store, watch
//   GET /setup/transcript-reader/windowed/index.html                                 the windowed lite page (page.js), served like any page
//   POST /api/transcript-reader/send                                                 unchanged (api.js): the guarded send, not touched here
//
// W3 (curated-only): a request that came in on a tailnet listener (the phone) reaches only the starred conversations and the ones a Herdr
// pane has open, enforced here, in every route and in the stream, not in the page: a session outside that set answers 404 as if it did not
// exist, a search is limited to the set (never the full index), a list shows the set only.
//
// Nothing here writes the store, sends to a pane, or changes the reading list. The guard (Host, Origin, Fetch-Metadata, token and, on the
// tailnet, sign-in) is api.js's and has already run when a handler is called.

const path = require('path');
const { StoreReader, StoreUnavailable } = require('./store');
const { createHub } = require('./stream');
const compat = require('./compat');

const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const MAX_LIMIT = 200;
const DEFAULT_TURNS = 40;
const OLDER_THAN_MS = 24 * 60 * 60 * 1000;
const ASK_LINE = 200;
const ASK_LINES = 3;
const ANSWER_WORDS = 15;  // build_prototype.ANSWER_WORDS

// The first words of an ask line as one line: the markup that only shapes it dropped, clipped (build_prototype.gist).
function gist(text, limit = ASK_LINE) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.replace(/^[\s#>*\-\d.)|]+/, '').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim());
  const joined = lines.filter(Boolean).join(' ');
  return joined.length <= limit ? joined : joined.slice(0, limit - 1).trimEnd() + '…';
}

const iso = (seconds) => (Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null);
const integer = (value, fallback, min, max) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : NaN;
};

function createStoreApi({
  store: storeOptions = {}, env = process.env, now = () => Date.now(), outDir, watch = null, stars = null, send, fail, RequestError, log = () => {},
  compatWrite = false, pageSource = null, pollMs = 1000,
} = {}) {
  const store = storeOptions instanceof StoreReader ? storeOptions : new StoreReader({ env, now, ...storeOptions });
  let hub = null;
  let compatWriter = null;

  // ---------------------------------------------------------------------------------------------------------------- what is live

  const starredSet = () => new Set(stars ? stars.read().stars.map((entry) => entry.conv) : []);

  // The pane each session runs in now: the store's live binding is the identity (S1: a liveness-checked fact), Herdr's own stream gives the
  // pane's state and label. A binding the watch does not know (Herdr not answering) is still listed, its state unknown.
  function livePanes() {
    const byPane = new Map();
    const lives = new Map();
    if (watch) for (const session of watch.sessions()) { lives.set(session.name, session.life); for (const pane of session.panes) byPane.set(session.name + '|' + pane.pane_id, pane); }
    const live = new Map();
    let bindings = [];
    try { bindings = store.liveBindings(); } catch { bindings = []; }
    for (const binding of bindings) {
      const pane = byPane.get(binding.herdr_session + '|' + binding.pane_id);
      const life = lives.get(binding.herdr_session);
      if (life && binding.life && life !== binding.life) continue;  // the store's fact is from another life of that Herdr session
      if (!live.has(binding.session_id)) live.set(binding.session_id, { herdr: binding.herdr_session, pane: binding.pane_id, label: (pane && pane.label) || binding.label || binding.pane_id, status: pane ? pane.status : 'unknown', source: binding.source });
    }
    // A pane Herdr reports that the store has no binding for still counts as open (the phone's scope and the list): by Herdr's own id.
    if (watch) {
      for (const session of watch.sessions()) {
        for (const pane of session.panes) if (pane.session_id && !live.has(pane.session_id)) live.set(pane.session_id, { herdr: session.name, pane: pane.pane_id, label: pane.label, status: pane.status, source: 'herdr' });
      }
    }
    return live;
  }

  // The ids a request may reach: null for the laptop (everything), the starred and open-pane sessions for a tailnet request (W3).
  function scopeOf(remote, live = livePanes()) {
    if (!remote) return null;
    const ids = starredSet();
    for (const id of live.keys()) ids.add(id);
    return ids;
  }

  const sessionOut = (row, live, starred, asks) => ({
    id: row.session_id, harness: row.harness, kind: row.kind, home: row.home, scope: row.scope, cwd: row.cwd, title: row.title,
    label: live.get(row.session_id) ? live.get(row.session_id).label : row.title, first_at: row.first_at, last_at: row.last_at, turns: row.turn_count,
    log_state: row.log_state, live: live.get(row.session_id) || null, starred: starred.has(row.session_id), open_asks: asks.get(row.session_id) || 0,
  });

  function openAskCounts(ids) {
    const counts = new Map();
    for (const id of store.askCandidates(ids)) { const open = store.openAsks(id); if (open.length) counts.set(id, open.length); }
    return counts;
  }

  // -------------------------------------------------------------------------------------------------------------------- routes

  function listSessions(query, remote) {
    const live = livePanes();
    const scope = scopeOf(remote, live);
    const limit = integer(query.get('limit'), 50, 1, MAX_LIMIT);
    const offset = integer(query.get('offset'), 0, 0, 1e9);
    if (Number.isNaN(limit) || Number.isNaN(offset)) throw new RequestError('Invalid limit or offset.', 400, 'bad_request');
    const starred = starredSet();
    let ids = null;
    if (query.get('live') === '1' || query.get('starred') === '1') {
      const want = new Set();
      if (query.get('live') === '1') for (const id of live.keys()) want.add(id);
      if (query.get('starred') === '1') for (const id of starred) want.add(id);
      ids = [...want].filter((id) => !scope || scope.has(id));
    } else if (scope) ids = [...scope];
    const harness = query.get('harness');
    if (harness !== null && !/^[a-z]{2,16}$/.test(harness)) throw new RequestError('Invalid harness.', 400, 'bad_request');
    const rows = store.sessions({ limit: limit + 1, offset, harness, ids });
    const page = rows.slice(0, limit);
    const asks = openAskCounts(page.map((row) => row.session_id));
    const status = store.status();
    return { status: 'ok', as_of: iso(status.heartbeat_at), lag_s: status.lag_s, sessions: page.map((row) => sessionOut(row, live, starred, asks)), next: rows.length > limit ? offset + limit : null };
  }

  function turnsOf(id, query, remote) {
    if (!ID_RE.test(id)) throw new RequestError('Invalid session id.', 400, 'bad_request');
    const live = livePanes();
    const scope = scopeOf(remote, live);
    const row = store.session(id);
    if (!row || (scope && !scope.has(id))) throw new RequestError('Not found.', 404, 'not_found');
    const limit = integer(query.get('limit'), DEFAULT_TURNS, 1, MAX_LIMIT);
    const after = integer(query.get('after'), null, -1, 1e9);
    const before = integer(query.get('before'), null, 0, 1e9);
    if (Number.isNaN(limit) || Number.isNaN(after) || Number.isNaN(before) || (after !== null && before !== null)) throw new RequestError('Invalid window.', 400, 'bad_request');
    const turns = store.turns(id, { after, before, limit });
    const marks = store.marks(id);
    const first = turns.length ? turns[0].idx : null;
    const previous = first !== null && first > 0 ? store.turnAt(id, first - 1) : null;
    const status = store.status();
    return {
      status: 'ok', session: sessionOut(row, live, starredSet(), new Map()), turns,
      marks: { first_idx: marks.first_idx, last_idx: marks.last_idx, total: marks.total, last_captain: marks.last_captain, last_reply: marks.last_reply, last_reply_any: marks.last_reply_any },
      previous: previous && { idx: previous.idx, source: previous.source, kind: previous.kind, has_reply: Boolean(previous.reply) },
      more_before: first !== null && marks.first_idx !== null && first > marks.first_idx, more_after: turns.length ? turns[turns.length - 1].idx < marks.last_idx : false,
      answer_words: ANSWER_WORDS, as_of: iso(status.heartbeat_at),
    };
  }

  // One entry for each live pane whose session has an open ask, newest first, one for each pane: the open-asks route's shape (api.js), as a store query.
  function asksNow(remote) {
    const live = livePanes();
    const scope = scopeOf(remote, live);
    const at = now();
    const entries = [];
    for (const id of store.askCandidates([...live.keys()])) {
      if (scope && !scope.has(id)) continue;
      const open = store.openAsks(id);
      if (!open.length) continue;
      const newest = open[open.length - 1];
      const pane = live.get(id);
      const lines = newest.asks.map((line) => gist(line)).filter(Boolean).slice(0, ASK_LINES);
      entries.push({
        pane_id: pane.pane, herdr: pane.herdr, session: id, message: typeof newest.uid === 'string' && newest.uid ? newest.uid : null, lines,
        at: iso(newest.at), tags: open.length > 1 ? [`+${open.length - 1} earlier`] : [], older: at - newest.at * 1000 > OLDER_THAN_MS, _t: newest.at,
      });
    }
    entries.sort((a, b) => b._t - a._t);
    const taken = new Set();
    const one = entries.filter((entry) => { const key = entry.herdr + '|' + entry.pane_id; if (taken.has(key)) return false; taken.add(key); return true; }).map(({ _t, ...entry }) => entry);
    const status = store.status();
    return { status: 'ok', generated_at: new Date(at).toISOString(), as_of: iso(status.heartbeat_at), asks: one };
  }

  // The glance feed (README, "The glance feed"), version 1, from the store: one record for each conversation a live pane runs or the owner starred.
  // `home` and `where` are the store's own labels (the config folder's scope and the working folder), not the fleet's home names.
  function glanceNow() {
    const live = livePanes();
    const starred = starredSet();
    const ids = [...new Set([...live.keys(), ...starred])];
    const rows = ids.length ? store.sessions({ limit: 500, ids }) : [];
    const candidates = new Set(store.askCandidates(rows.map((row) => row.session_id)));
    const status = store.status();
    const conversations = rows.map((row) => {
      const open = candidates.has(row.session_id) ? store.openAsks(row.session_id) : [];
      const newest = open[open.length - 1];
      const pane = live.get(row.session_id);
      return {
        id: row.session_id, ids: [row.session_id], home: row.scope, where: '', last: row.last_at || 0, open_asks: open.length,
        ask: newest ? { at: newest.at, uid: typeof newest.uid === 'string' ? newest.uid : null, lines: newest.asks.map((line) => gist(line)).filter(Boolean).slice(0, ASK_LINES), tags: open.length > 1 ? [`+${open.length - 1} earlier`] : [] } : null,
        pane: pane ? { label: pane.label, herdr: pane.herdr, live: true } : null,
      };
    });
    conversations.sort((a, b) => b.last - a.last);
    return { as_of: status.heartbeat_at || 0, version: 1, conversations };
  }

  function searchNow(query, remote) {
    const text = (query.get('q') || '').slice(0, 200);
    if (!text.trim()) throw new RequestError('Nothing to search for.', 400, 'bad_request');
    const limit = integer(query.get('limit'), 20, 1, 50);
    if (Number.isNaN(limit)) throw new RequestError('Invalid limit.', 400, 'bad_request');
    const scope = scopeOf(remote);
    const hits = store.search(text, { limit, ids: scope ? [...scope] : null });
    const status = store.status();
    return {
      status: 'ok', q: text, scope: scope ? 'curated' : 'all', as_of: iso(status.heartbeat_at),
      results: hits.map((hit) => ({ id: hit.session_id, harness: hit.harness, title: hit.title, cwd: hit.cwd, scope: hit.scope, last_at: hit.last_at, log_state: hit.log_state, turn_idx: hit.turn_idx, turn_uid: hit.turn_uid, at: hit.turn_at, snippet: hit.snippet })),
    };
  }

  function storeStatus() {
    const up = store.available();
    return {
      status: 'ok', store: up ? { available: true, file: path.basename(store.file), ...store.status() } : { available: false, reason: store.error }, watch: watch ? { running: watch.running, ...watch.stats() } : null,
      stream: hub ? hub.stats() : null,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------------- the API

  const claims = (pathname, api) => {
    const rest = pathname.startsWith(api) ? pathname.slice(api.length) : null;
    return rest !== null && (/^(sessions|asks|glance|search|stream|store-status)$/.test(rest) || /^sessions\/[^/]+\/turns$/.test(rest));
  };

  // A request already past the guard. `api` is the API prefix; `remote` is true for a tailnet listener.
  function handle(req, res, pathname, query, { api, remote = false } = {}) {
    if (req.method !== 'GET') { fail(res, 405, 'not_allowed', 'GET only.'); return; }
    const rest = pathname.slice(api.length);
    try {
      if (rest === 'store-status') { send(res, 200, storeStatus()); return; }
      if (rest === 'stream') { stream(req, res, query, remote); return; }
      if (rest === 'sessions') { send(res, 200, listSessions(query, remote)); return; }
      const turns = /^sessions\/([^/]+)\/turns$/.exec(rest);
      if (turns) { send(res, 200, turnsOf(decodeURIComponent(turns[1]), query, remote)); return; }
      if (rest === 'asks') { send(res, 200, asksNow(remote)); return; }
      if (rest === 'glance') { send(res, 200, glanceNow()); return; }
      if (rest === 'search') { send(res, 200, searchNow(query, remote)); return; }
    } catch (error) {
      if (error instanceof StoreUnavailable) { fail(res, 503, 'store_unavailable', error.message); return; }
      throw error;
    }
    fail(res, 404, 'not_found', 'Not found.');
  }

  const ensureHub = () => (hub || (hub = createHub({ store, livePanes, scopeOf, asksNow, watch, now, log, pollMs })));

  function stream(req, res, query, remote) {
    if (!store.available()) { fail(res, 503, 'store_unavailable', store.error || 'The store is not available.'); return; }
    const wanted = (query.get('sessions') || '').split(',').filter((id) => ID_RE.test(id)).slice(0, 8);
    ensureHub().add(req, res, { remote, sessions: wanted });
  }

  // The compatibility writers keep what Conn reads as files current from the store and the pane watch, while a client has not moved to the
  // API: out/pane-labels.json always (the builder is no longer what refreshes it once the poll is gone), and out/glance.json when asked.
  function startCompat({ writeGlance = false } = {}) {
    if (compatWriter || !outDir) return;
    compatWriter = compat.create({ outDir, watch, glance: writeGlance ? glanceNow : null, now, log, livePanes, hub: ensureHub() });
    compatWriter.start();
  }

  function pageHtml() { return pageSource ? pageSource() : null; }

  function close() { if (hub) hub.close(); if (compatWriter) compatWriter.stop(); store.close(); }

  if (compatWrite) startCompat(typeof compatWrite === 'object' ? compatWrite : {});

  return { handle, claims, close, store, startCompat, pageHtml, livePanes, scopeOf, asksNow, glanceNow, get hub() { return hub; } };
}

module.exports = { createStoreApi, gist, ANSWER_WORDS };
