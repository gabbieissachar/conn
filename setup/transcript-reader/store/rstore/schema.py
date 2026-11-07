"""The store's tables, views and versioning.

`PRAGMA user_version` is the schema version. Python (this code), Node (S2's API) and Swift (Conn, later) all read it: a reader refuses a
file whose version it does not know, and the only thing another repo may depend on is the versioned read-only views (`v1_*`), never a
raw table (plan S8). A change to a table that a view hides is not a version change; a change to a view's columns is, and adds `v2_*`.

Migrations are plain functions of (connection), one per version step, run in one transaction each. There is one so far.
"""

from __future__ import annotations

import sqlite3

SCHEMA_VERSION = 1

TABLES_V1 = """
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per log file generation. A file that is truncated or replaced starts a new generation; the old rows stay (archive, W1).
CREATE TABLE sources (
  source_id         INTEGER PRIMARY KEY,
  harness           TEXT NOT NULL,                 -- claude | codex | copilot | pi
  home              TEXT NOT NULL DEFAULT '',      -- the config folder the log came from (~/.claude-personal ...), or ''
  path              TEXT NOT NULL,
  generation        INTEGER NOT NULL DEFAULT 1,
  session_id        TEXT NOT NULL,
  parent_session_id TEXT,                          -- a sub-agent file's parent session
  kind              TEXT NOT NULL DEFAULT 'session', -- session | subagent
  state             TEXT NOT NULL DEFAULT 'active', -- active | log_gone | replaced | skipped
  skip_reason       TEXT,
  dev               INTEGER,
  inode             INTEGER,
  size              INTEGER,
  mtime_ns          INTEGER,
  cursor_offset     INTEGER NOT NULL DEFAULT 0,    -- bytes consumed, through the end of the last complete line
  head_hash         TEXT,                          -- sha1 of the first bytes: a different head at the same path is a different file
  tail_hash         TEXT,                          -- sha1 of the bytes just before the cursor: a rewrite in place changes it
  turn_start_offset INTEGER NOT NULL DEFAULT 0,    -- where the derivation window of the open turn starts
  turn_start_idx    INTEGER NOT NULL DEFAULT 0,    -- the index of the turn that window starts with
  carry             TEXT NOT NULL DEFAULT '{}',    -- derivation state that must cross passes (Copilot's working folder)
  rules             TEXT,                          -- the derivation rules this file's turns were derived under
  first_seen        REAL NOT NULL,
  last_ingested     REAL,
  last_change       REAL,
  gone_at           REAL
);
CREATE UNIQUE INDEX sources_path_generation ON sources (path, generation);
CREATE INDEX sources_session ON sources (session_id);
CREATE INDEX sources_state ON sources (state);

CREATE TABLE sessions (
  session_id        TEXT PRIMARY KEY,
  harness           TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'session',
  home              TEXT NOT NULL DEFAULT '',
  account_uuid      TEXT,
  org_uuid          TEXT,
  scope             TEXT NOT NULL DEFAULT 'default', -- the home's label, or personal-work (a label, not a filter: W2 = everything)
  cwd               TEXT,
  title             TEXT,
  parent_session_id TEXT,
  current_source_id INTEGER,
  first_at          REAL,
  last_at           REAL,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  event_count       INTEGER NOT NULL DEFAULT 0,
  log_state         TEXT NOT NULL DEFAULT 'present', -- present | gone (the log was deleted; the store is the only copy)
  gone_at           REAL,
  created_at        REAL NOT NULL,
  updated_at        REAL NOT NULL
);
CREATE INDEX sessions_last ON sessions (last_at);
CREATE INDEX sessions_cwd ON sessions (cwd);

-- One row per log record the store keeps. The identity fields are raw; the rest of the record is `meta`. User and assistant text is an
-- excerpt here (the whole text is in `turns`); a tool result is the reader's own bounded step output, nothing for a credential path.
CREATE TABLE events (
  event_id    INTEGER PRIMARY KEY,
  source_id   INTEGER NOT NULL,
  session_id  TEXT NOT NULL,
  offset      INTEGER NOT NULL,                   -- the record's byte offset in its file (unique within the source)
  kind        TEXT NOT NULL,                      -- the log's record type (user, assistant, attachment, system, response_item ...)
  uuid        TEXT,
  parent_uuid TEXT,
  origin      TEXT,                               -- origin.kind (peer, task-notification ...)
  is_meta     INTEGER NOT NULL DEFAULT 0,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  tool_use_id TEXT,
  tool_name   TEXT,
  absorbed    INTEGER NOT NULL DEFAULT 0,         -- this record started a turn that arrived while the agent was busy
  starts_turn INTEGER NOT NULL DEFAULT 0,         -- this record started a turn (turns.start_offset names it back)
  at          REAL,
  role        TEXT,
  text        TEXT,
  text_len    INTEGER NOT NULL DEFAULT 0,
  meta        TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX events_source_offset ON events (source_id, offset);
CREATE INDEX events_session_at ON events (session_id, at);
CREATE INDEX events_uuid ON events (uuid) WHERE uuid IS NOT NULL;
CREATE INDEX events_tool_use ON events (session_id, tool_use_id) WHERE tool_use_id IS NOT NULL;

-- The step each tool call made (tool_steps.make_step), kept so a result that arrives in a later pass is bounded and hidden by the
-- same rule: a step that touched a credential path stays hidden whenever its output turns up.
CREATE TABLE tool_calls (
  source_id   INTEGER NOT NULL,
  tool_use_id TEXT NOT NULL,
  step        TEXT NOT NULL,
  PRIMARY KEY (source_id, tool_use_id)
) WITHOUT ROWID;

-- The reader's exchanges (one input and the replies that answer it), derived by the reader's own rules. Neighbour-dependent flags
-- (folded, answered_below) are not stored: they are a function of the turns around, computed when read (parity exclusions, README).
CREATE TABLE turns (
  turn_id         INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL,
  source_id       INTEGER NOT NULL,
  idx             INTEGER NOT NULL,
  uid             TEXT,                           -- the log's own record id; a divider (compaction) has none
  start_offset    INTEGER,
  source          TEXT NOT NULL,                  -- captain | firstmate | wake | session | peer
  kind            TEXT NOT NULL,
  label           TEXT,
  input           TEXT NOT NULL DEFAULT '',
  at              REAL,
  absorbed        INTEGER NOT NULL DEFAULT 0,
  reply           TEXT NOT NULL DEFAULT '',
  reply_at        REAL,
  reply_words     INTEGER NOT NULL DEFAULT 0,
  narration_words INTEGER NOT NULL DEFAULT 0,
  narration       TEXT NOT NULL DEFAULT '[]',
  tools           INTEGER NOT NULL DEFAULT 0,
  verdict         TEXT,                           -- needs-you | no-action | none
  rule            TEXT,
  asks            TEXT NOT NULL DEFAULT '[]',
  ask_lines       TEXT NOT NULL DEFAULT '[]',
  reminder_lines  TEXT NOT NULL DEFAULT '[]',
  signal_task     TEXT,
  cwd             TEXT,
  notices         TEXT NOT NULL DEFAULT '[]',
  rules           TEXT
);
CREATE UNIQUE INDEX turns_source_idx ON turns (source_id, idx);
CREATE INDEX turns_session ON turns (session_id, at);
CREATE INDEX turns_uid ON turns (uid) WHERE uid IS NOT NULL;

-- One row per turn (rowid = turns.turn_id): the turn's input, working notes and reply. Never an `api-request-blob` or a tool output.
CREATE VIRTUAL TABLE search USING fts5 (
  text,
  session_id UNINDEXED,
  source_id  UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE links (
  link_id      INTEGER PRIMARY KEY,
  from_session TEXT NOT NULL,
  to_session   TEXT NOT NULL,
  kind         TEXT NOT NULL,                    -- subagent | clear | pane_successor (resume, compact, fork stay inferred: README)
  basis        TEXT NOT NULL,                    -- path | inferred
  evidence     TEXT NOT NULL DEFAULT '{}',
  at           REAL NOT NULL
);
CREATE UNIQUE INDEX links_pair ON links (from_session, to_session, kind);

-- Skip and unknown-record counters: the numbers that say nothing is silently dropped. name: ignored_record | unknown_record |
-- skipped_source | file_event.
CREATE TABLE counters (
  name       TEXT NOT NULL,
  key        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL,
  PRIMARY KEY (name, key)
);

-- Sessions the owner asked to forget: ingest never takes them again.
CREATE TABLE forgotten (
  session_id TEXT PRIMARY KEY,
  at         REAL NOT NULL,
  note       TEXT
);

CREATE TABLE file_events (
  file_event_id INTEGER PRIMARY KEY,
  at        REAL NOT NULL,
  source_id INTEGER,
  kind      TEXT NOT NULL,                       -- truncated | replaced | gone | back | rules_changed | unreadable | crash_recovered
  detail    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE ingest_heartbeat (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  at        REAL NOT NULL,
  pid       INTEGER,
  scan_ms   REAL,
  files     INTEGER,
  changed   INTEGER,
  lag_s     REAL,
  status    TEXT NOT NULL DEFAULT 'ok',
  detail    TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE ingest_lag (
  at    REAL NOT NULL,
  lag_s REAL NOT NULL
);
CREATE INDEX ingest_lag_at ON ingest_lag (at);

-- ---------------------------------------------------------------------------------------------------------------- identity (B1)
CREATE TABLE herdr_lives (
  herdr_session TEXT NOT NULL,
  life          TEXT NOT NULL,                   -- the session folder's inode: a deleted and recreated session has a new life
  first_seen    REAL NOT NULL,
  last_seen     REAL NOT NULL,
  session_dir   TEXT,
  socket_path   TEXT,
  ended_at      REAL,
  PRIMARY KEY (herdr_session, life)
);

CREATE TABLE panes (
  herdr_session TEXT NOT NULL,
  life          TEXT NOT NULL,
  pane_id       TEXT NOT NULL,
  terminal_id   TEXT,
  tab_id        TEXT,
  workspace_id  TEXT,
  label         TEXT,
  title         TEXT,
  cwd           TEXT,
  agent         TEXT,
  agent_status  TEXT,
  herdr_value   TEXT,                            -- agent_session.value as Herdr last reported it
  herdr_value_source TEXT,
  fg_pid        INTEGER,                         -- the harness process in the pane's foreground, if one is
  fg_proc_start TEXT,
  fg_harness    TEXT,
  fg_cwd        TEXT,
  first_seen    REAL NOT NULL,
  last_seen     REAL NOT NULL,
  closed_at     REAL,
  close_reason  TEXT,
  PRIMARY KEY (herdr_session, life, pane_id)
);
CREATE INDEX panes_terminal ON panes (terminal_id);
CREATE INDEX panes_fg_pid ON panes (fg_pid) WHERE closed_at IS NULL;

-- A fact is one claim about what a pane runs, valid only while the process it was observed with is still the pane's harness process.
CREATE TABLE facts (
  fact_id       INTEGER PRIMARY KEY,
  herdr_session TEXT NOT NULL,
  life          TEXT NOT NULL,
  pane_id       TEXT NOT NULL,
  source        TEXT NOT NULL,                   -- pid_record | herdr_report | cwd_inference
  session_id    TEXT NOT NULL,
  harness       TEXT,
  pid           INTEGER,
  proc_start    TEXT,
  observed_at   REAL NOT NULL,
  valid_from    REAL NOT NULL,
  valid_to      REAL,
  expired_reason TEXT,                           -- pane_exited | pane_closed | new_pid_record | foreground_changed | life_change | superseded
  evidence      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX facts_open ON facts (herdr_session, life, pane_id) WHERE valid_to IS NULL;

-- The answer for a pane over time: the highest-ranked live fact. One open row per pane.
CREATE TABLE bindings (
  binding_id    INTEGER PRIMARY KEY,
  herdr_session TEXT NOT NULL,
  life          TEXT NOT NULL,
  pane_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  harness       TEXT,
  source        TEXT NOT NULL,                   -- the winning fact's source
  fact_id       INTEGER,
  conflict      INTEGER NOT NULL DEFAULT 0,      -- another live fact of the same rank names another session
  valid_from    REAL NOT NULL,
  valid_to      REAL,
  end_reason    TEXT
);
CREATE UNIQUE INDEX bindings_open ON bindings (herdr_session, life, pane_id) WHERE valid_to IS NULL;
CREATE INDEX bindings_session ON bindings (session_id);

-- Everything that changed a pane's identity, with before and after: the evidence rows of the coverage checklist.
CREATE TABLE identity_events (
  event_id      INTEGER PRIMARY KEY,
  at            REAL NOT NULL,
  kind          TEXT NOT NULL,                   -- bind | rebind | unbind | pane_created | pane_closed | pane_exited | life_change |
                                                 -- foreground_changed | process_restart | fact_expired | events_lost | reconcile
  herdr_session TEXT,
  life          TEXT,
  pane_id       TEXT,
  before_session TEXT,
  after_session  TEXT,
  source        TEXT,
  reason        TEXT,
  harness       TEXT,
  detail        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX identity_events_at ON identity_events (at);
CREATE INDEX identity_events_kind ON identity_events (kind);

-- ----------------------------------------------------------------------------------------------------------------- validation
-- The builder's pane-to-session mapping, sampled by the diff job (the builder is read, never changed), and the rows where it and
-- the store's live binding differ. Each row is adjudicated by hand: store-right, builder-right or both-wrong.
CREATE TABLE builder_samples (
  sample_id INTEGER PRIMARY KEY,
  at        REAL NOT NULL,
  note      TEXT
);
CREATE TABLE builder_pane_map (
  sample_id     INTEGER NOT NULL,
  herdr_session TEXT NOT NULL,
  pane_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  PRIMARY KEY (sample_id, herdr_session, pane_id)
);
CREATE TABLE disagreement_rows (
  row_id          INTEGER PRIMARY KEY,
  herdr_session   TEXT NOT NULL,
  life            TEXT,
  pane_id         TEXT NOT NULL,
  store_session   TEXT,
  store_source    TEXT,
  builder_session TEXT,
  kind            TEXT NOT NULL,                 -- differs | store_only | builder_only
  first_seen      REAL NOT NULL,
  last_seen       REAL NOT NULL,
  samples         INTEGER NOT NULL DEFAULT 1,
  closed_at       REAL,                          -- the two agreed again (or the pane is gone)
  verdict         TEXT CHECK (verdict IN ('store-right', 'builder-right', 'both-wrong')),
  verdict_note    TEXT,
  verdict_at      REAL
);
CREATE INDEX disagreement_rows_open ON disagreement_rows (herdr_session, pane_id) WHERE closed_at IS NULL;

CREATE TABLE send_checks (
  check_id        INTEGER PRIMARY KEY,
  at              REAL NOT NULL,
  trigger         TEXT NOT NULL,                 -- send | audit
  herdr_session   TEXT,
  pane_id         TEXT,
  session_id      TEXT NOT NULL,                 -- the session the Send (or audit) named
  store_session   TEXT,                          -- the store's live binding for that pane at that moment
  store_source    TEXT,
  check_result    TEXT NOT NULL,                 -- ok | other_session | agent_not_foreground | no_pane | herdr_failed ...
  check_session   TEXT,                          -- what the send check says the pane runs
  detail          TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX send_checks_at ON send_checks (at);

CREATE TABLE parity_runs (
  run_id       INTEGER PRIMARY KEY,
  at           REAL NOT NULL,
  trigger      TEXT NOT NULL,                    -- change | nightly | manual
  sessions     INTEGER NOT NULL DEFAULT 0,
  turns        INTEGER NOT NULL DEFAULT 0,
  mismatches   INTEGER NOT NULL DEFAULT 0,
  unexplained  INTEGER NOT NULL DEFAULT 0,
  skipped      INTEGER NOT NULL DEFAULT 0,
  cpu_s        REAL,
  wall_s       REAL,
  detail       TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE parity_mismatches (
  mismatch_id  INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL,
  session_id   TEXT NOT NULL,
  source_id    INTEGER,
  turn_uid     TEXT,
  field        TEXT NOT NULL,
  store_value  TEXT,
  builder_value TEXT,
  status       TEXT NOT NULL DEFAULT 'unexplained',  -- unexplained | explained | fixed
  explanation  TEXT
);
CREATE INDEX parity_mismatches_run ON parity_mismatches (run_id);

CREATE TABLE rusage_samples (
  at        REAL NOT NULL,
  component TEXT NOT NULL,                       -- ingest | parity | backup | scan ...
  user_s    REAL,
  sys_s     REAL,
  wall_s    REAL,
  maxrss_kb INTEGER,
  note      TEXT
);

CREATE TABLE coverage_marks (
  row_key   TEXT PRIMARY KEY,                    -- the checklist row (coverage.py)
  status    TEXT NOT NULL,                       -- observed | staged-in-lab | waived
  at        REAL NOT NULL,
  evidence  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE backups (
  backup_id  INTEGER PRIMARY KEY,
  at         REAL NOT NULL,
  snapshot   TEXT NOT NULL,                      -- the staged file's name
  bytes      INTEGER,
  sha256     TEXT,
  tool       TEXT,
  uploaded_at REAL,
  upload_to  TEXT
);
"""

VIEWS_V1 = """
-- The versioned read-only contract (plan S8). Other repos read these, never the tables.
CREATE VIEW v1_sessions AS
  SELECT session_id, harness, kind, home, scope, cwd, title, parent_session_id, first_at, last_at, turn_count, event_count,
         log_state, gone_at, account_uuid, org_uuid
  FROM sessions;

CREATE VIEW v1_turns AS
  SELECT t.session_id, t.idx, t.uid, t.source, t.kind, t.label, t.input, t.at, t.absorbed, t.reply, t.reply_at, t.reply_words,
         t.tools, t.verdict, t.rule, t.asks, t.signal_task, t.cwd
  FROM turns t JOIN sessions s ON s.session_id = t.session_id AND s.current_source_id = t.source_id;

CREATE VIEW v1_live_bindings AS
  SELECT b.herdr_session, b.life, b.pane_id, p.terminal_id, b.session_id, b.harness, b.source, b.conflict, b.valid_from, p.label
  FROM bindings b LEFT JOIN panes p ON p.herdr_session = b.herdr_session AND p.life = b.life AND p.pane_id = b.pane_id
  WHERE b.valid_to IS NULL;

CREATE VIEW v1_ingest_status AS
  SELECT h.at AS heartbeat_at, h.pid, h.lag_s, h.status, h.files, h.changed,
         (SELECT COUNT(*) FROM sessions) AS sessions,
         (SELECT COUNT(*) FROM sessions WHERE log_state = 'gone') AS sessions_log_gone,
         (SELECT COUNT(*) FROM sources WHERE state = 'skipped') AS sources_skipped
  FROM ingest_heartbeat h;

-- The rows that need a person: a pane whose live binding the builder reads differently (store versus builder pane-to-session mapping).
CREATE VIEW disagreements AS
  SELECT row_id, herdr_session, pane_id, kind, store_session, store_source, builder_session, first_seen, last_seen, samples,
         closed_at, COALESCE(verdict, 'unadjudicated') AS status, verdict_note
  FROM disagreement_rows;

-- Per Send (or audit) attempt: did the store's live binding agree with the send check, which reads the foreground process?
-- Agreement: an ok check names the store's session; a refusal leaves the store without that session for the pane.
CREATE VIEW send_agreement AS
  SELECT check_id, at, trigger, herdr_session, pane_id, session_id, store_session, store_source, check_result, check_session,
         CASE
           WHEN check_result = 'ok' THEN (store_session IS NOT NULL AND store_session = session_id)
           WHEN check_result IN ('other_session', 'agent_not_foreground') THEN (store_session IS NULL OR store_session <> session_id)
           ELSE NULL                                  -- no_pane, herdr_failed ... say nothing about the store
         END AS agree
  FROM send_checks;
"""


def create(conn: sqlite3.Connection) -> None:
    """A new store at the current version."""
    conn.executescript(TABLES_V1)
    conn.executescript(VIEWS_V1)
    conn.execute("INSERT INTO search(search, rank) VALUES ('secure-delete', 1)")  # `forget` removes text from the index file too
    conn.execute("INSERT INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


# version -> function(conn) that brings a store from version-1 to version. Version 1 is `create`.
MIGRATIONS: dict[int, callable] = {}


def version_of(conn: sqlite3.Connection) -> int:
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def migrate(conn: sqlite3.Connection) -> None:
    """Bring an existing store to SCHEMA_VERSION, one transaction per step. A store newer than this code is refused."""
    found = version_of(conn)
    if found > SCHEMA_VERSION:
        raise RuntimeError(f"the store is schema version {found}; this code knows {SCHEMA_VERSION}. Upgrade the code, never the file.")
    while found < SCHEMA_VERSION:
        step = found + 1
        migrate_step = MIGRATIONS.get(step)
        if migrate_step is None:
            raise RuntimeError(f"no migration to schema version {step}")
        conn.execute("BEGIN IMMEDIATE")
        try:
            migrate_step(conn)
            conn.execute(f"PRAGMA user_version = {step}")
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", (str(step),))
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        found = step
