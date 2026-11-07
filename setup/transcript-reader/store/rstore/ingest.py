"""The ingest: logs in, one transaction per file, a cursor that can only advance with its rows.

One pass (`Ingester.scan`) lists every log, compares each with what the store holds, and ingests what changed:

  new file        a source row at generation 1, ingested from byte 0
  grown file      the same source, from where it left off; only the tail turn is derived again
  deleted file    the source goes `log_gone` and its session `gone`; every row stays (W1 = archive: the store is now the only copy)
  truncated, or replaced by another file at the same path
                  a new generation of the source; the old generation's rows stay, and the session reads from the new one
  changed rules   (the builder's turn rules changed with the checkout) a log that is still there is derived again from its start

A file is ingested in ONE transaction that writes its rows, its turns and its cursor together. A process killed at any point leaves
the store as it was before that file began, so the next pass does the file again from its old cursor, and counts match a store built
from nothing (validation check 5). Records are never taken twice: an event's (source, byte offset) is unique.

The tail turn is derived again, not the whole log: a file's `turn_start_offset` is where its newest turn's first record is, and a pass
reads from there (builder.derive stamps each exchange with the record that began it). Everything before that point is final.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import adapters, builder, db, sources
from .config import Settings

HEAD_BYTES = 4096
BATCH = 500
SYNTHETIC = object()


def head_hash(path: Path, consumed: int) -> str:
    """sha1 of the first min(4096, <consumed>) bytes of a file: the part of its head the store has already read, so a file that only
    grew keeps its hash and a different file at the same path does not."""
    length = min(HEAD_BYTES, consumed)
    if length <= 0:
        return ""
    try:
        with open(path, "rb") as handle:
            data = handle.read(length)
    except OSError:
        return ""
    return hashlib.sha1(data).hexdigest()


def tail_hash(path: Path, cursor: int) -> str:
    """sha1 of up to 256 bytes ending at <cursor>: a file rewritten in place (same inode, same head, longer than before) changes it."""
    if cursor <= 0:
        return ""
    try:
        with open(path, "rb") as handle:
            start = max(0, cursor - 256)
            handle.seek(start)
            return hashlib.sha1(handle.read(cursor - start)).hexdigest()
    except OSError:
        return ""


def jdump(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class StepLookup(dict):
    """The tool steps of a pass, found in memory first and then in `tool_calls`: a result that arrives in a later pass than its call
    is bounded and hidden by the same step, so a credential path stays hidden whenever its output turns up."""

    def __init__(self, conn: sqlite3.Connection, source_id: int):
        super().__init__()
        self.conn, self.source_id = conn, source_id
        self.new: dict[str, dict] = {}

    def get(self, key, default=None):
        if key in self:
            return self[key]
        if isinstance(key, str):
            row = self.conn.execute("SELECT step FROM tool_calls WHERE source_id = ? AND tool_use_id = ?", (self.source_id, key)).fetchone()
            if row:
                value = json.loads(row["step"])
                super().__setitem__(key, value)
                return value
        return default

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        if isinstance(key, str):
            self.new[key] = value


@dataclass
class ScanResult:
    started: float
    finished: float = 0.0
    files: int = 0
    changed: int = 0
    new: int = 0
    replaced: int = 0
    gone: int = 0
    skipped: int = 0
    errors: list = field(default_factory=list)
    lag: list = field(default_factory=list)


class Ingester:
    def __init__(self, conn: sqlite3.Connection, settings: Settings, home_dir: Path, *, clock=time.time, env: dict | None = None):
        self.conn = conn
        self.settings = settings
        self.home_dir = Path(home_dir)
        self.clock = clock
        self.env = env
        self.kill_after_rows = int(os.environ.get("RSTORE_TEST_KILL_AFTER_ROWS", "0") or 0)  # lab only: a crash in the middle of a file
        self._rows_this_run = 0

    # ----------------------------------------------------------------------------------------------------------- scanning

    def scan(self) -> ScanResult:
        now = self.clock()
        result = ScanResult(started=now)
        descs = sources.discover(self.home_dir, self.env)
        result.files = len(descs)
        known = {row["path"]: row for row in self.conn.execute(
            "SELECT s.* FROM sources s JOIN (SELECT path, MAX(generation) g FROM sources GROUP BY path) m ON m.path = s.path AND m.g = s.generation")}
        forgotten = {row[0] for row in self.conn.execute("SELECT session_id FROM forgotten")}
        policy_stamp = self.policy_stamp()
        policy_changed = self.meta("scope_policy_stamp") != policy_stamp
        seen: set[str] = set()
        todo: list[tuple[float, sources.SourceDesc, sqlite3.Row | None, os.stat_result]] = []
        for desc in descs:
            path = str(desc.path)
            seen.add(path)
            try:
                stat = os.stat(desc.path)
            except OSError:
                continue
            row = known.get(path)
            if desc.session_id in forgotten or (desc.parent_session_id in forgotten if desc.parent_session_id else False):
                if row is None:
                    with db.transaction(self.conn):
                        self.note_skip(desc, stat, "forgotten", now)
                    result.skipped += 1
                continue
            if row is None:
                todo.append((stat.st_mtime, desc, None, stat))
            elif row["state"] == "skipped":
                if (row["mtime_ns"], row["size"]) != (stat.st_mtime_ns, stat.st_size) or (policy_changed and row["skip_reason"] != "forgotten"):
                    todo.append((stat.st_mtime, desc, row, stat))
            elif (row["mtime_ns"], row["size"], row["inode"], row["state"]) != (stat.st_mtime_ns, stat.st_size, stat.st_ino, "active") \
                    or row["rules"] != builder.RULES:
                todo.append((stat.st_mtime, desc, row, stat))
        # Newest first: a live session is current before an old archive is read.
        for _, desc, row, stat in sorted(todo, key=lambda item: -item[0]):
            try:
                outcome = self.ingest(desc, row, stat)
            except (OSError, sqlite3.Error, ValueError) as error:  # one unreadable file never stops the pass
                result.errors.append((str(desc.path), type(error).__name__))
                with db.transaction(self.conn):
                    db.bump(self.conn, "file_event", "unreadable", now=self.clock())
                continue
            result.changed += 1
            result.new += outcome == "new"
            result.replaced += outcome == "replaced"
            result.skipped += outcome == "skipped"
            result.lag.append(max(0.0, self.clock() - stat.st_mtime))
        for path, row in known.items():
            if path not in seen and row["state"] == "active":
                self.mark_gone(row)
                result.gone += 1
        if policy_changed:
            with db.transaction(self.conn):
                self.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('scope_policy_stamp', ?)", (policy_stamp,))
        result.finished = self.clock()
        return result

    def meta(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def policy_stamp(self) -> str:
        s = self.settings
        return hashlib.sha1(jdump([s.scope_policy, sorted(s.shopback_org_uuids), sorted(s.personal_cwd_prefixes)]).encode()).hexdigest()[:12]

    # --------------------------------------------------------------------------------------------------------------- files

    def note_skip(self, desc: sources.SourceDesc, stat: os.stat_result, reason: str, now: float, row: sqlite3.Row | None = None) -> None:
        if row is None:
            self.conn.execute(
                "INSERT INTO sources(harness, home, path, generation, session_id, parent_session_id, kind, state, skip_reason, dev, inode, size, mtime_ns, first_seen) "
                "VALUES (?, ?, ?, 1, ?, ?, ?, 'skipped', ?, ?, ?, ?, ?, ?)",
                (desc.harness, desc.home, str(desc.path), desc.session_id, desc.parent_session_id, desc.kind, reason, stat.st_dev, stat.st_ino,
                 stat.st_size, stat.st_mtime_ns, now))
            db.bump(self.conn, "skipped_source", f"{desc.harness}:{reason}", now=now)
        else:
            self.conn.execute("UPDATE sources SET state = 'skipped', skip_reason = ?, size = ?, mtime_ns = ?, inode = ?, dev = ? WHERE source_id = ?",
                              (reason, stat.st_size, stat.st_mtime_ns, stat.st_ino, stat.st_dev, row["source_id"]))
            if row["skip_reason"] != reason:
                db.bump(self.conn, "skipped_source", f"{desc.harness}:{reason}", now=now)

    def head_facts(self, desc: sources.SourceDesc) -> adapters.Facts:
        """The owner and folder of a session, from the start of its log: what a scope rule needs before anything is ingested."""
        facts = adapters.Facts()
        steps: dict = {}
        rowfn = adapters.ROW_FUNCTIONS[desc.harness]
        try:
            for count, line in enumerate(adapters.read_lines(desc.path, 0)):
                if line.record is not None:
                    rowfn(line.record, line.offset, facts, steps)
                if count >= 400 or (facts.cwd and (facts.org_uuid or desc.harness != "claude") and count >= 3):
                    break
        except OSError:
            pass
        return facts

    def ingest(self, desc: sources.SourceDesc, row: sqlite3.Row | None, stat: os.stat_result) -> str:
        """Bring one file up to date. Returns new | grown | replaced | skipped | back | rederived."""
        now = self.clock()
        outcome = "new" if row is None else "grown"
        generation = 1
        old_id: int | None = None
        start_offset = 0
        start_idx = 0
        cursor = 0
        carry: dict = {}
        if row is not None:
            generation = row["generation"]
            old_id = row["source_id"]
            if row["state"] == "skipped":
                outcome = "new"  # a skipped file is taken now (the scope rule changed, or the file did): from its start, on its own row
            else:
                fresh_head = head_hash(desc.path, row["cursor_offset"])
                grew = stat.st_size >= row["cursor_offset"]
                same_content = bool(row["head_hash"]) and row["head_hash"] == fresh_head and grew and \
                    (row["tail_hash"] or "") == tail_hash(desc.path, row["cursor_offset"])
                if not same_content:
                    outcome = "replaced"
                    generation = row["generation"] + 1
                    kind = "truncated" if not grew else "replaced"
                    db.file_event(self.conn, kind, row["source_id"], {"was": row["size"], "now": stat.st_size}, now=now)
                else:
                    if row["state"] == "log_gone":
                        outcome = "back"
                    if row["rules"] != builder.RULES:
                        outcome = "rederived"
                        start_offset, start_idx = 0, 0
                        cursor = row["cursor_offset"]
                        db.file_event(self.conn, "rules_changed", row["source_id"], {"from": row["rules"], "to": builder.RULES}, now=now)
                    else:
                        start_offset, start_idx, cursor = row["turn_start_offset"], row["turn_start_idx"], row["cursor_offset"]
                        carry = json.loads(row["carry"] or "{}")
        # A Codex sub-thread names its parent only inside the log: a forgotten parent's child is never taken either.
        if desc.harness == "codex" and (row is None or row["state"] == "skipped"):
            parent = self.head_facts(desc).parent_thread
            if parent and self.conn.execute("SELECT 1 FROM forgotten WHERE session_id = ?", (parent,)).fetchone():
                with db.transaction(self.conn):
                    self.note_skip(desc, stat, "forgotten", now, row if row is not None else None)
                return "skipped"
        # Scope: only a stricter-than-everything policy needs the head read before a file is taken.
        facts_head = None
        if self.settings.scope_policy != "everything":
            facts_head = self.head_facts(desc)
            _, reason = sources.scope_of(self.settings, self.home_dir, desc.home_label, facts_head.cwd, facts_head.org_uuid)
            if reason:
                with db.transaction(self.conn):
                    self.note_skip(desc, stat, reason, now, row if row is not None and row["state"] == "skipped" else None)
                return "skipped"
        with db.transaction(self.conn):
            if outcome == "replaced" and old_id is not None:
                self.conn.execute("UPDATE sources SET state = 'replaced' WHERE source_id = ?", (old_id,))
            if row is not None and row["state"] == "skipped":
                source_id = row["source_id"]
                self.conn.execute("UPDATE sources SET state = 'active', skip_reason = NULL WHERE source_id = ?", (source_id,))
            elif outcome == "new" or outcome == "replaced":
                source_id = self.conn.execute(
                    "INSERT INTO sources(harness, home, path, generation, session_id, parent_session_id, kind, state, dev, inode, size, mtime_ns, first_seen) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
                    (desc.harness, desc.home, str(desc.path), generation, desc.session_id, desc.parent_session_id, desc.kind, stat.st_dev,
                     stat.st_ino, stat.st_size, stat.st_mtime_ns, now)).lastrowid
            else:
                source_id = old_id
                if outcome == "back":
                    self.conn.execute("UPDATE sources SET state = 'active', gone_at = NULL WHERE source_id = ?", (source_id,))
                    db.file_event(self.conn, "back", source_id, {}, now=now)
            self.pass_over(desc, source_id, stat, start_offset, start_idx, cursor, carry, outcome, now)
        return outcome

    def pass_over(self, desc, source_id: int, stat: os.stat_result, start_offset: int, start_idx: int, cursor: int, carry: dict,
                  outcome: str, now: float) -> None:
        """One file's rows, turns and cursor. Runs inside the caller's transaction."""
        harness = desc.harness
        rowfn = adapters.ROW_FUNCTIONS[harness]
        facts = adapters.Facts()
        steps = StepLookup(self.conn, source_id)
        offsets: list[int | None] = []
        rows: list[dict] = []
        end_holder = {"end": start_offset}
        carry_cwd = carry.get("cwd")
        corrupt = 0

        def flush() -> None:
            if not rows:
                return
            self.conn.executemany(
                "INSERT OR IGNORE INTO events(source_id, session_id, offset, kind, uuid, parent_uuid, origin, is_meta, is_sidechain, tool_use_id, "
                "tool_name, absorbed, starts_turn, at, role, text, text_len, meta) "
                "VALUES (:source_id, :session_id, :offset, :kind, :uuid, :parent_uuid, :origin, :is_meta, :is_sidechain, :tool_use_id, "
                ":tool_name, :absorbed, :starts_turn, :at, :role, :text, :text_len, :meta)", rows)
            self._rows_this_run += len(rows)
            rows.clear()
            if self.kill_after_rows and self._rows_this_run >= self.kill_after_rows:
                os.kill(os.getpid(), signal.SIGKILL)  # the lab's crash: the transaction is open, nothing is committed

        def records():
            nonlocal corrupt, carry_cwd
            if harness == "copilot" and start_offset > 0 and carry_cwd:
                offsets.append(None)
                yield {"type": "session.resume", "data": {"context": {"cwd": carry_cwd}}}
            gen = adapters.read_lines(desc.path, start_offset)
            while True:
                try:
                    line = next(gen)
                except StopIteration as done:
                    end_holder["end"] = done.value if done.value is not None else end_holder["end"]
                    break
                end_holder["end"] = line.end
                if line.record is None:
                    if line.offset >= cursor and line.raw_len > 1:
                        corrupt += 1
                    continue
                record = line.record
                if harness == "copilot" and record.get("type") in ("session.start", "session.resume"):
                    context = (record.get("data") or {}).get("context")
                    if isinstance(context, dict) and isinstance(context.get("cwd"), str) and context["cwd"]:
                        carry_cwd = context["cwd"]
                offsets.append(line.offset)
                if line.offset >= cursor:
                    row = rowfn(record, line.offset, facts, steps)
                    if row is not None:
                        row["source_id"] = source_id
                        row["session_id"] = desc.session_id
                        rows.append(row)
                        if len(rows) >= BATCH:
                            flush()
                yield record

        exchanges = builder.derive(harness, records())
        flush()
        end = end_holder["end"]
        if outcome == "rederived":
            self.conn.execute("UPDATE events SET starts_turn = 0, absorbed = 0 WHERE source_id = ?", (source_id,))
        # Turns: replace from the window's first index on.
        old = [r[0] for r in self.conn.execute("SELECT turn_id FROM turns WHERE source_id = ? AND idx >= ?", (source_id, start_idx))]
        if old:
            marks = ",".join("?" * len(old))
            self.conn.execute(f"DELETE FROM search WHERE rowid IN ({marks})", old)
            self.conn.execute(f"DELETE FROM turns WHERE turn_id IN ({marks})", old)
        last_real = None
        for position, exchange in enumerate(exchanges):
            rec = exchange.get("_rec")
            offset = offsets[rec] if rec is not None and 0 <= rec < len(offsets) else None
            turn_id = self.conn.execute(
                "INSERT INTO turns(session_id, source_id, idx, uid, start_offset, source, kind, label, input, at, absorbed, reply, reply_at, "
                "reply_words, narration_words, narration, tools, verdict, rule, asks, ask_lines, reminder_lines, signal_task, cwd, notices, rules) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (desc.session_id, source_id, start_idx + position, exchange.get("uid"), offset, exchange["source"], exchange["kind"],
                 exchange.get("label"), exchange.get("input") or "", exchange.get("at"), int(bool(exchange.get("absorbed"))), exchange.get("reply") or "",
                 exchange.get("reply_at"), exchange.get("reply_words") or 0, exchange.get("narration_words") or 0, jdump(exchange.get("narration") or []),
                 exchange.get("tools") or 0, exchange.get("verdict"), exchange.get("rule"), jdump(exchange.get("asks") or []),
                 jdump(exchange.get("ask_lines") or []), jdump(exchange.get("reminder_lines") or []), exchange.get("signal_task"),
                 exchange.get("cwd"), jdump(exchange.get("notices") or []), builder.RULES)).lastrowid
            text = "\n".join(part for part in [exchange.get("input") or "", *(exchange.get("narration") or []), exchange.get("reply") or ""] if part)
            if text:
                self.conn.execute("INSERT INTO search(rowid, text, session_id, source_id) VALUES (?, ?, ?, ?)", (turn_id, text, desc.session_id, source_id))
            if offset is not None:
                self.conn.execute("UPDATE events SET starts_turn = 1, absorbed = ? WHERE source_id = ? AND offset = ?",
                                  (int(bool(exchange.get("absorbed"))), source_id, offset))
            if not builder.divider(exchange) and not exchange.get("absorbed"):
                last_real = (position, offset)  # the window starts at a turn that stands alone: an absorbed one needs the turn before it
        # The next pass starts at the newest real turn's first record; with no turn yet it starts where this pass ended.
        if last_real is not None and last_real[1] is not None:
            next_idx, next_offset = start_idx + last_real[0], last_real[1]
        else:
            next_idx = start_idx + len(exchanges)
            next_offset = end if not exchanges else start_offset
        self.conn.execute(
            "UPDATE sources SET cursor_offset = ?, turn_start_offset = ?, turn_start_idx = ?, carry = ?, rules = ?, size = ?, mtime_ns = ?, inode = ?, "
            "dev = ?, head_hash = ?, tail_hash = ?, last_ingested = ?, last_change = ? WHERE source_id = ?",
            (end, next_offset, next_idx, jdump({"cwd": carry_cwd} if carry_cwd else {}), builder.RULES, stat.st_size, stat.st_mtime_ns, stat.st_ino,
             stat.st_dev, head_hash(desc.path, end), tail_hash(desc.path, end), now, stat.st_mtime, source_id))
        if steps.new:
            self.conn.executemany("INSERT OR REPLACE INTO tool_calls(source_id, tool_use_id, step) VALUES (?, ?, ?)",
                                  [(source_id, key, jdump(value)) for key, value in steps.new.items()])
        for key, count in facts.ignored.items():
            db.bump(self.conn, "ignored_record", key, count, now)
        for key, count in facts.unknown.items():
            db.bump(self.conn, "unknown_record", key, count, now)
        if corrupt:
            db.bump(self.conn, "file_event", "corrupt_line", corrupt, now)
        self.upsert_session(desc, source_id, facts, now)

    def upsert_session(self, desc: sources.SourceDesc, source_id: int, facts: adapters.Facts, now: float) -> None:
        sid = desc.session_id
        turn_count = self.conn.execute("SELECT COUNT(*) FROM turns WHERE source_id = ?", (source_id,)).fetchone()[0]
        event_count = self.conn.execute("SELECT COUNT(*) FROM events WHERE source_id = ?", (source_id,)).fetchone()[0]
        existing = self.conn.execute("SELECT * FROM sessions WHERE session_id = ?", (sid,)).fetchone()
        cwd = (existing["cwd"] if existing and existing["cwd"] else None) or facts.cwd
        org = (existing["org_uuid"] if existing and existing["org_uuid"] else None) or facts.org_uuid
        account = (existing["account_uuid"] if existing and existing["account_uuid"] else None) or facts.account_uuid
        title = facts.title or (existing["title"] if existing else None)
        first = min([t for t in (facts.first_at, existing["first_at"] if existing else None) if t is not None], default=None)
        last = max([t for t in (facts.last_at, existing["last_at"] if existing else None) if t is not None], default=None)
        scope, _ = sources.scope_of(self.settings, self.home_dir, desc.home_label, cwd, org)
        if existing is None:
            self.conn.execute(
                "INSERT INTO sessions(session_id, harness, kind, home, account_uuid, org_uuid, scope, cwd, title, parent_session_id, current_source_id, "
                "first_at, last_at, turn_count, event_count, log_state, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'present', ?, ?)",
                (sid, desc.harness, desc.kind, desc.home, account, org, scope, cwd, title, desc.parent_session_id, source_id, first, last,
                 turn_count, event_count, now, now))
        else:
            self.conn.execute(
                "UPDATE sessions SET account_uuid = ?, org_uuid = ?, scope = ?, cwd = ?, title = ?, current_source_id = ?, first_at = ?, last_at = ?, "
                "turn_count = ?, event_count = ?, log_state = 'present', gone_at = NULL, updated_at = ? WHERE session_id = ?",
                (account, org, scope, cwd, title, source_id, first, last, turn_count, event_count, now, sid))
        if desc.parent_session_id:
            self.conn.execute("INSERT OR IGNORE INTO links(from_session, to_session, kind, basis, evidence, at) VALUES (?, ?, 'subagent', 'path', '{}', ?)",
                              (desc.parent_session_id, sid, now))
        if desc.harness == "codex" and facts.parent_thread and facts.parent_thread != sid:
            self.conn.execute("INSERT OR IGNORE INTO links(from_session, to_session, kind, basis, evidence, at) VALUES (?, ?, 'subagent', 'path', '{\"codex\":1}', ?)",
                              (facts.parent_thread, sid, now))

    def mark_gone(self, row: sqlite3.Row) -> None:
        now = self.clock()
        with db.transaction(self.conn):
            self.conn.execute("UPDATE sources SET state = 'log_gone', gone_at = ? WHERE source_id = ?", (now, row["source_id"]))
            self.conn.execute("UPDATE sessions SET log_state = 'gone', gone_at = ? WHERE session_id = ? AND current_source_id = ?",
                              (now, row["session_id"], row["source_id"]))
            db.file_event(self.conn, "gone", row["source_id"], {"cursor": row["cursor_offset"]}, now=now)

    # ----------------------------------------------------------------------------------------------------------- heartbeat

    def heartbeat(self, result: ScanResult | None, status: str = "ok", detail: dict | None = None) -> None:
        now = self.clock()
        lag = max(result.lag) if result and result.lag else 0.0
        with db.transaction(self.conn):
            self.conn.execute(
                "INSERT INTO ingest_heartbeat(id, at, pid, scan_ms, files, changed, lag_s, status, detail) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET at = excluded.at, pid = excluded.pid, scan_ms = excluded.scan_ms, files = excluded.files, "
                "changed = excluded.changed, lag_s = excluded.lag_s, status = excluded.status, detail = excluded.detail",
                (now, os.getpid(), (result.finished - result.started) * 1000 if result else None, result.files if result else None,
                 result.changed if result else None, lag, status, jdump(detail or {})))
            if result and result.lag:
                self.conn.executemany("INSERT INTO ingest_lag(at, lag_s) VALUES (?, ?)", [(now, value) for value in result.lag])
                self.conn.execute("DELETE FROM ingest_lag WHERE at < ?", (now - 14 * 86400,))

    def recover_after_crash(self) -> bool:
        """At start: a heartbeat that never said `stopped`, from a process that is gone, was a crash. The store is already whole (a file
        is one transaction); this records that the pass is being redone."""
        row = self.conn.execute("SELECT * FROM ingest_heartbeat WHERE id = 1").fetchone()
        if not row or row["status"] == "stopped":
            return False
        pid = row["pid"]
        alive = False
        if pid and pid != os.getpid():
            try:
                os.kill(pid, 0)
                alive = True
            except OSError:
                alive = False
        if alive or not pid:
            return False
        with db.transaction(self.conn):
            db.file_event(self.conn, "crash_recovered", None, {"pid": pid, "last_heartbeat": row["at"]}, now=self.clock())
        return True
