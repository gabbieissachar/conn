"""Check 1: turn parity. The store's derived turns against today's builder, on a stated projection.

The builder is the baseline (build_prototype.parsed_log, called with no cache, so nothing it owns is written). For every session the
store holds a current log for, the job parses the same file with the builder and compares the two lists of turns field by field. Each
difference is stored in `parity_mismatches` with both values. The soak passes with zero unexplained mismatches over its last three days.

The projection (PROJECTED) is every turn field the store keeps. The exclusions are listed here and in the README, and nothing else is:
  folded, answered_below   neighbour-dependent: a function of the turns around, computed when read, never stored
  steps, touched           tool detail and mentioned documents: not turns (the event rows hold tool calls; documents are a later slice)
  events                   the builder's internal work list, gone once a turn is finished
Sessions the builder does not read are skipped and counted, not compared: a Codex rollout whose session_meta source is not `cli`
(is_codex_log), a Copilot log that is not a session (is_copilot_log), and every Pi log (the builder has no Pi parser; the store's
adapter is compared with itself only by the unit tests).

A file that grows while it is compared is skipped (`moving`) and compared on the next run, so the job never reports the store's lag
as a mismatch.
"""

from __future__ import annotations

import json
import os
import resource
import time
from pathlib import Path

from . import builder, db

bp = builder.bp

PROJECTED = ("uid", "source", "kind", "label", "input", "at", "absorbed", "reply", "reply_at", "reply_words", "narration_words", "narration",
             "tools", "verdict", "rule", "asks", "ask_lines", "reminder_lines", "signal_task", "cwd", "notices")
EXCLUDED = ("folded", "answered_below", "steps", "touched", "events")
CORE = ("uid", "source", "kind", "input", "reply", "verdict", "at")  # turn boundaries, speaker, text, ask flag: the plan's own words


def canon(value):
    """JSON round trip, so tuples and lists, ints and floats compare the way a stored value reads back."""
    return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True))


def builder_projection(exchange: dict) -> dict:
    out = {}
    for key in PROJECTED:
        value = exchange.get(key)
        if key == "absorbed":
            value = int(bool(value))
        if key in ("narration", "asks", "ask_lines", "reminder_lines", "notices") and value is None:
            value = []
        if key in ("input", "reply") and value is None:
            value = ""
        if key in ("reply_words", "narration_words", "tools") and value is None:
            value = 0
        out[key] = canon(value)
    return out


def store_projection(row) -> dict:
    out = {}
    for key in PROJECTED:
        value = row[key]
        if key in ("narration", "asks", "ask_lines", "reminder_lines", "notices"):
            value = json.loads(value or "[]")
        out[key] = canon(value)
    return out


def builder_turns(harness: str, path: Path) -> list[dict] | None:
    """The builder's exchanges for <path>, or None when the builder does not read this log (a documented exclusion)."""
    if harness == "claude":
        return bp.parsed_log(path, None)["exchanges"]
    if harness == "codex":
        return bp.parsed_log(path, None)["exchanges"] if bp.is_codex_log(path) else None
    if harness == "copilot":
        return bp.parsed_log(path, None)["exchanges"] if bp.is_copilot_log(path) else None
    return None


def compare_lists(store_rows: list, builder_list: list[dict]) -> list[dict]:
    """The differences between a session's stored turns and the builder's, each with both values."""
    found = []
    mine = [store_projection(r) for r in store_rows]
    theirs = [builder_projection(e) for e in builder_list]
    if len(mine) != len(theirs):
        found.append({"field": "turn_count", "turn_uid": None, "store": len(mine), "builder": len(theirs)})
    for index, (a, b) in enumerate(zip(mine, theirs)):
        for key in PROJECTED:
            if a[key] != b[key]:
                found.append({"field": key, "turn_uid": a.get("uid") or b.get("uid") or f"#{index}", "turn_index": index, "store": a[key], "builder": b[key]})
    return found


def clip(value, limit: int = 600):
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    return text if len(text) <= limit else text[:limit] + f"...[{len(text)} chars]"


def run(conn, *, trigger: str = "manual", session_ids: list[str] | None = None, limit: int | None = None, clock=time.time) -> int:
    """One parity run over every current, active source (or the named sessions). Returns the run id."""
    started, cpu0 = clock(), resource.getrusage(resource.RUSAGE_SELF)
    where = "src.state = 'active' AND s.current_source_id = src.source_id AND src.kind = 'session'"
    params: list = []
    if session_ids:
        where += f" AND s.session_id IN ({','.join('?' * len(session_ids))})"
        params += session_ids
    sources = conn.execute(f"SELECT src.*, s.session_id AS sid FROM sources src JOIN sessions s ON s.session_id = src.session_id WHERE {where} "
                           f"ORDER BY src.last_change DESC", params).fetchall()
    if limit:
        sources = sources[:limit]
    compared = turns = mismatches = skipped = 0
    found_rows: list[tuple] = []
    for src in sources:
        path = Path(src["path"])
        try:
            before = os.stat(path)
        except OSError:
            skipped += 1
            continue
        if before.st_size != src["cursor_offset"] and not _ends_without_newline(path, src["cursor_offset"], before.st_size):
            skipped += 1  # the store has not caught up with this file yet (or the file is moving): next run
            continue
        theirs = builder_turns(src["harness"], path)
        if theirs is None:
            skipped += 1
            continue
        try:
            after = os.stat(path)
        except OSError:
            skipped += 1
            continue
        if (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
            skipped += 1
            continue
        rows = conn.execute("SELECT * FROM turns WHERE source_id = ? ORDER BY idx", (src["source_id"],)).fetchall()
        diffs = compare_lists(rows, theirs)
        compared += 1
        turns += len(rows)
        for diff in diffs:
            mismatches += 1
            found_rows.append((src["session_id"], src["source_id"], diff.get("turn_uid"), diff["field"], clip(diff["store"]), clip(diff["builder"])))
    cpu1 = resource.getrusage(resource.RUSAGE_SELF)
    cpu = (cpu1.ru_utime - cpu0.ru_utime) + (cpu1.ru_stime - cpu0.ru_stime)
    with db.transaction(conn):
        run_id = conn.execute(
            "INSERT INTO parity_runs(at, trigger, sessions, turns, mismatches, unexplained, skipped, cpu_s, wall_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (started, trigger, compared, turns, mismatches, mismatches, skipped, cpu, clock() - started)).lastrowid
        conn.executemany("INSERT INTO parity_mismatches(run_id, session_id, source_id, turn_uid, field, store_value, builder_value) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         [(run_id, *row) for row in found_rows])
        # A mismatch that an earlier run explained and this run sees again keeps its explanation.
        conn.execute(
            "UPDATE parity_mismatches SET status = 'explained', explanation = (SELECT p.explanation FROM parity_mismatches p WHERE p.run_id < parity_mismatches.run_id "
            "AND p.session_id = parity_mismatches.session_id AND p.field = parity_mismatches.field AND COALESCE(p.turn_uid, '') = COALESCE(parity_mismatches.turn_uid, '') "
            "AND p.status = 'explained' ORDER BY p.run_id DESC LIMIT 1) WHERE run_id = ? AND EXISTS (SELECT 1 FROM parity_mismatches p WHERE p.run_id < parity_mismatches.run_id "
            "AND p.session_id = parity_mismatches.session_id AND p.field = parity_mismatches.field AND COALESCE(p.turn_uid, '') = COALESCE(parity_mismatches.turn_uid, '') "
            "AND p.status = 'explained')", (run_id,))
        conn.execute("UPDATE parity_runs SET unexplained = (SELECT COUNT(*) FROM parity_mismatches WHERE run_id = ? AND status = 'unexplained') WHERE run_id = ?", (run_id, run_id))
        conn.execute("INSERT INTO rusage_samples(at, component, user_s, sys_s, wall_s, maxrss_kb, note) VALUES (?, 'parity', ?, ?, ?, ?, ?)",
                     (started, cpu1.ru_utime - cpu0.ru_utime, cpu1.ru_stime - cpu0.ru_stime, clock() - started, cpu1.ru_maxrss // 1024 if os.uname().sysname == "Darwin" else cpu1.ru_maxrss, trigger))
    return run_id


def _ends_without_newline(path: Path, cursor: int, size: int) -> bool:
    """A log whose last bytes are a partial line (the writer is mid-record) leaves the cursor short of the size: not a lag, not yet a record."""
    if size <= cursor:
        return False
    try:
        with open(path, "rb") as handle:
            handle.seek(cursor)
            tail = handle.read(size - cursor)
    except OSError:
        return False
    return b"\n" not in tail and bool(tail.strip())
