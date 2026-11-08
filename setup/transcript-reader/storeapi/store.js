'use strict';

// The Node API's read-only window on the shadow store (setup/transcript-reader/store/, S1). One read-only SQLite connection
// (node:sqlite, SQLITE_OPEN_READONLY): nothing here writes the store, changes its schema, signals its daemon or holds a read
// transaction open, so the ingest and the nightly backup are never in its way.
//
// What it reads:
//   - the versioned views the store publishes (v1_sessions, v1_turns, v1_live_bindings, v1_ingest_status), for everything they carry;
//   - two things no v1 view carries, read from the tables themselves because they are this repo's own and a view cannot hold them:
//     the columns of `turns` that v1_turns leaves out (ask_lines, reminder_lines, narration, notices: what the page's cards draw), and
//     the `search` FTS5 table (a virtual table cannot be exposed through a view). A schema bump that moved either would be a store
//     change; this module refuses a store whose user_version it does not know, so a bump can never be misread.
//
// A store this module cannot open (no file yet, the wrong version) is `unavailable`, with the reason; routes answer 503 for it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const DEFAULT_DIR = path.join(os.homedir(), '.config', 'pmos-transcript-reader', 'store');
const DB_NAME = 'reader-store.sqlite';

// The store's folder: PMOS_READER_STORE_DIR (a lab, a test), else the owner's default.
const storeDir = (env = process.env) => (env.PMOS_READER_STORE_DIR ? path.resolve(env.PMOS_READER_STORE_DIR) : DEFAULT_DIR);

class StoreUnavailable extends Error {
  constructor(message) { super(message); this.code = 'store_unavailable'; this.status = 503; }
}

const WORD = /[\p{L}\p{N}_][\p{L}\p{N}_\-./:]*/gu;

// An FTS5 query from what a person typed: every word quoted (so no word is read as syntax), joined with AND, or with OR for the second try.
function ftsQuery(text, mode = 'and') {
  const words = (String(text).match(WORD) || []).map((word) => word.replace(/^[\-./:]+|[\-./:]+$/g, '')).filter(Boolean);
  return words.map((word) => '"' + word.replace(/"/g, '""') + '"').join(mode === 'and' ? ' AND ' : ' OR ');
}

const json = (text, fallback) => { try { const value = JSON.parse(text); return value === null || value === undefined ? fallback : value; } catch { return fallback; } };

// The turn as the API sends it: the columns of v1_turns, plus what the cards draw from the table (ask lines, reminders, notes, notices).
function turnOut(row) {
  return {
    idx: row.idx, uid: row.uid, source: row.source, kind: row.kind, label: row.label, input: row.input, at: row.at, absorbed: Boolean(row.absorbed),
    reply: row.reply, reply_at: row.reply_at, reply_words: row.reply_words, tools: row.tools, verdict: row.verdict, rule: row.rule,
    asks: json(row.asks, []), ask_lines: json(row.ask_lines, []), reminder_lines: json(row.reminder_lines, []), narration: json(row.narration, []),
    notices: json(row.notices, []), signal_task: row.signal_task, cwd: row.cwd,
  };
}

// The columns of one turn read for a window. v1_turns is the contract; the extra columns come from the same row of `turns` (the view's own join).
const TURN_SQL = `SELECT v.idx, v.uid, v.source, v.kind, v.label, v.input, v.at, v.absorbed, v.reply, v.reply_at, v.reply_words, v.tools, v.verdict, v.rule, v.asks,
  v.signal_task, v.cwd, t.ask_lines, t.reminder_lines, t.narration, t.notices
  FROM v1_turns v JOIN sessions s ON s.session_id = v.session_id JOIN turns t ON t.session_id = v.session_id AND t.source_id = s.current_source_id AND t.idx = v.idx`;

class StoreReader {
  constructor({ file, dir, env = process.env, now = () => Date.now() } = {}) {
    this.file = file || path.join(dir || storeDir(env), DB_NAME);
    this.now = now;
    this.db = null;
    this.error = null;
    this.stmts = new Map();
  }

  // The read-only connection, opened on first use and again after a failure (the store may not exist yet). Throws StoreUnavailable.
  open() {
    if (this.db) return this.db;
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch { throw new StoreUnavailable('This Node has no node:sqlite.'); }
    if (!fs.existsSync(this.file)) throw new StoreUnavailable('There is no store at ' + this.file + ' yet.');
    let db;
    try {
      db = new DatabaseSync(this.file, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version !== SCHEMA_VERSION) { db.close(); throw new StoreUnavailable(`The store is schema version ${version}; this API reads version ${SCHEMA_VERSION}.`); }
    } catch (error) {
      if (error instanceof StoreUnavailable) throw error;
      throw new StoreUnavailable('The store cannot be opened read-only (' + (error && error.code || error.message) + ').');
    }
    this.db = db;
    return db;
  }

  available() { try { this.open(); return true; } catch (error) { this.error = error.message; return false; } }

  close() { this.stmts.clear(); if (this.db) { try { this.db.close(); } catch { /* closing a failed connection */ } this.db = null; } }

  stmt(sql) {
    let prepared = this.stmts.get(sql);
    if (!prepared) { prepared = this.open().prepare(sql); this.stmts.set(sql, prepared); }
    return prepared;
  }

  all(sql, ...params) { return this.stmt(sql).all(...params); }
  get(sql, ...params) { return this.stmt(sql).get(...params); }

  // SQLite's change counter: it moves whenever another connection commits, so "has the store changed" is one cheap read.
  dataVersion() { return this.open().prepare('PRAGMA data_version').get().data_version; }

  status() {
    const row = this.get('SELECT * FROM v1_ingest_status');
    if (!row) return { heartbeat_at: null, lag_s: null, status: 'none', sessions: 0 };
    return { heartbeat_at: row.heartbeat_at, lag_s: row.lag_s, status: row.status, sessions: row.sessions, sessions_log_gone: row.sessions_log_gone };
  }

  // Every session the API lists (a sub-agent file is listed only when asked): newest activity first.
  sessions({ limit = 100, offset = 0, harness = null, ids = null, subagents = false } = {}) {
    const where = [];
    const params = [];
    if (!subagents) where.push("kind = 'session'");
    if (harness) { where.push('harness = ?'); params.push(harness); }
    if (ids) {
      if (!ids.length) return [];
      where.push(`session_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    return this.all(`SELECT session_id, harness, kind, home, scope, cwd, title, parent_session_id, first_at, last_at, turn_count, log_state FROM v1_sessions
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  }

  session(id) {
    return this.get('SELECT session_id, harness, kind, home, scope, cwd, title, parent_session_id, first_at, last_at, turn_count, log_state FROM v1_sessions WHERE session_id = ?', id) || null;
  }

  // The newest few sessions' counters, for noticing what changed without reading any text.
  counters() { return this.all('SELECT session_id, turn_count, event_count, last_at, title, log_state FROM v1_sessions'); }

  // A window of one session's turns. after: the turns past that index; before: the turns before it (older, for scrolling up); neither: the
  // newest `limit`. The answer is oldest first. `previous` is the turn before the window (the fold rule needs its neighbour).
  turns(id, { after = null, before = null, limit = 40 } = {}) {
    let rows;
    if (after !== null) rows = this.all(`${TURN_SQL} WHERE v.session_id = ? AND v.idx > ? ORDER BY v.idx ASC LIMIT ?`, id, after, limit);
    else if (before !== null) rows = this.all(`${TURN_SQL} WHERE v.session_id = ? AND v.idx < ? ORDER BY v.idx DESC LIMIT ?`, id, before, limit).reverse();
    else rows = this.all(`${TURN_SQL} WHERE v.session_id = ? ORDER BY v.idx DESC LIMIT ?`, id, limit).reverse();
    return rows.map(turnOut);
  }

  // One turn by index (the neighbour of a window), or null.
  turnAt(id, idx) {
    const row = this.get(`${TURN_SQL} WHERE v.session_id = ? AND v.idx = ?`, id, idx);
    return row ? turnOut(row) : null;
  }

  // The indexes the neighbour-dependent flags need: the newest turn, the newest turn from the captain, the newest turn with a reply (a
  // hook turn's reply is never where the session stands, so the newest non-hook reply first).
  marks(id) {
    return this.get(`SELECT MAX(idx) AS last_idx, MIN(idx) AS first_idx, COUNT(*) AS total,
      MAX(CASE WHEN source = 'captain' THEN idx END) AS last_captain,
      MAX(CASE WHEN reply <> '' AND kind <> 'hook' THEN idx END) AS last_reply,
      MAX(CASE WHEN reply <> '' THEN idx END) AS last_reply_any FROM v1_turns WHERE session_id = ?`, id);
  }

  // The open asks of a session: replies that need the captain with no message from the captain in a LATER turn (build_prototype.mark_asks:
  // "open" is exactly that; a later message of yours makes it quiet, and settled only changes a quiet one, never an open one). A turn is an
  // exchange, a message of yours and the reply to it, so the reply to your newest message is after it and stays open.
  openAsks(id) {
    const marks = this.marks(id);
    if (!marks || marks.total === 0) return [];
    const floor = marks.last_captain === null ? -1 : marks.last_captain;
    return this.all(`SELECT v.idx, v.uid, v.at, v.reply_at, v.asks, v.verdict FROM v1_turns v WHERE v.session_id = ? AND v.verdict = 'needs-you' AND v.idx >= ? ORDER BY v.idx ASC`, id, floor)
      .map((row) => ({ idx: row.idx, uid: row.uid, at: row.reply_at || row.at, asks: json(row.asks, []) }));
  }

  // Sessions with a needs-you reply at all (a cheap filter before the per-session open-ask check).
  askCandidates(ids) {
    if (!ids.length) return [];
    return this.all(`SELECT DISTINCT session_id FROM v1_turns WHERE verdict = 'needs-you' AND session_id IN (${ids.map(() => '?').join(',')})`, ...ids).map((row) => row.session_id);
  }

  liveBindings() {
    return this.all('SELECT herdr_session, life, pane_id, terminal_id, session_id, harness, source, conflict, valid_from, label FROM v1_live_bindings');
  }

  // Full-text search: one row per session, its best turn first. Every word must match; a query that finds nothing so is tried again with any
  // word. ids (when not null) limits the search to those sessions (the phone's scope, W3): the limit is pushed into the index as a rowid
  // constraint, so a narrow scope does not rank the whole index. The ranking runs on the bare index first and the snippets are made only
  // for the rows that are answered (snippet() on every candidate is the slow part).
  search(text, { limit = 20, ids = null } = {}) {
    if (ids && !ids.length) return [];
    for (const mode of ['and', 'or']) {
      const query = ftsQuery(text, mode);
      if (!query) return [];
      const params = [query];
      let extra = '';
      if (ids) { extra = ` AND search.rowid IN (SELECT turn_id FROM turns WHERE session_id IN (${ids.map(() => '?').join(',')}))`; params.push(...ids); }
      const ranked = this.all(`SELECT search.rowid AS turn_id, bm25(search) AS rank FROM search WHERE search MATCH ?${extra} ORDER BY rank LIMIT 400`, ...params);
      const best = new Map();
      for (const hit of ranked) {
        const row = this.get(`SELECT s.session_id, s.harness, s.title, s.cwd, s.scope, s.last_at, s.log_state, t.idx AS turn_idx, t.uid AS turn_uid, t.at AS turn_at
          FROM turns t JOIN sessions s ON s.session_id = t.session_id AND s.current_source_id = t.source_id WHERE t.turn_id = ? AND s.kind = 'session'`, hit.turn_id);
        if (row && !best.has(row.session_id)) best.set(row.session_id, { ...row, rank: hit.rank, turn_id: hit.turn_id });
        if (best.size >= limit) break;
      }
      if (best.size) {
        return [...best.values()].map((row) => {
          const found = this.get('SELECT snippet(search, 0, ?, ?, ?, 14) AS snippet FROM search WHERE search MATCH ? AND search.rowid = ?', '[[', ']]', ' … ', query, row.turn_id);
          const { turn_id: _turn, ...rest } = row;
          return { ...rest, snippet: found ? found.snippet : '' };
        });
      }
    }
    return [];
  }
}

module.exports = { StoreReader, StoreUnavailable, SCHEMA_VERSION, storeDir, ftsQuery, turnOut };
