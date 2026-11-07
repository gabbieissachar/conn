"""Check 4: the event coverage checklist. Each event observed at least once, with its evidence row.

The soak ends when every row below is filled and at least seven days have passed, not after a fixed week. A row is filled by:

  observed        the store's own records show it (identity_events, links, turns), with the evidence row: timestamp, pane, the binding
                  before and after. Detected automatically from the real system's events.
  staged-in-lab   the event was staged in the lab (a fake Herdr, e2e/pane_lab.py) and marked by hand (`coverage mark`). Events that
                  happen rarely are staged; the few that need the real system (a Herdr restart) are staged with the owner or waited for.
  waived          the owner waived the row, with a note.

`evaluate` reads the store; `render` writes the checklist file; `mark` records a hand-marked row. Detection is deliberately plain:
where an event cannot be told from another by the records (a resume and a model-swap restart both restart the process), the rule
says what it looks at, and the owner can mark or waive the row.
"""

from __future__ import annotations

import json
import sqlite3
import time

from . import db

ROWS = [
    ("clear_claude", "/clear in Claude", "a Claude pane's pid record changes session inside one process"),
    ("clear_codex", "/clear in Codex", "a Codex pane is rebound to another session without a new process"),
    ("resume", "resume", "a pane restarts its harness and lands on a session that already existed (older than 10 minutes)"),
    ("compact", "compact", "a compaction divider in a session that has a live binding"),
    ("model_swap_restart", "a model-swap restart", "the harness restarts in a pane and the pane is bound to the same session as before"),
    ("herdr_restart", "a Herdr restart", "a Herdr session stops and runs again"),
    ("pane_close", "pane close", "a pane that had a binding closes"),
    ("ctrl_z", "Ctrl+Z", "the harness leaves the foreground for a shell and the same process returns"),
    ("codex_worker", "a Codex worker", "a Codex pane is bound"),
    ("second_herdr_session", "a pane in a second Herdr session", "bindings exist in two different Herdr sessions"),
    ("personal_account_pane", "a personal-account pane", "a pane is bound to a session from a non-default Claude account folder"),
    ("pi_pane", "a Pi pane", "a Pi pane is bound"),
]


def _evidence(row, note: str = "") -> dict:
    return {"at": row["at"], "herdr_session": row["herdr_session"], "pane": row["pane_id"], "before": row["before_session"], "after": row["after_session"],
            "kind": row["kind"], "reason": row["reason"], "note": note}


def _events(conn: sqlite3.Connection, where: str, *params) -> list[sqlite3.Row]:
    return conn.execute(f"SELECT * FROM identity_events WHERE {where} ORDER BY at", params).fetchall()


def detect(conn: sqlite3.Connection) -> dict[str, list[dict]]:
    found: dict[str, list[dict]] = {key: [] for key, _, _ in ROWS}
    for row in _events(conn, "kind = 'rebind' AND harness = 'claude' AND reason = 'new_pid_record'"):
        linked = conn.execute("SELECT kind FROM links WHERE from_session = ? AND to_session = ?", (row["before_session"], row["after_session"])).fetchone()
        found["clear_claude"].append(_evidence(row, f"link: {linked[0]}" if linked else ""))
    for row in _events(conn, "kind = 'rebind' AND harness = 'codex'"):
        found["clear_codex"].append(_evidence(row))
    # a restart of the harness in a pane: the session it was bound to before and after says which kind it was
    for event in _events(conn, "kind = 'process_restart'"):
        after = event["after_session"]
        if after is None:  # nothing bound yet (Herdr's value was stale): the next binding of that pane is the answer
            later = conn.execute("SELECT * FROM identity_events WHERE herdr_session = ? AND life = ? AND pane_id = ? AND kind IN ('bind', 'rebind') AND at > ? AND at - ? < 900 "
                                 "ORDER BY at LIMIT 1", (event["herdr_session"], event["life"], event["pane_id"], event["at"], event["at"])).fetchone()
            after = later["after_session"] if later else None
        if after is None:
            continue
        first_at = conn.execute("SELECT first_at FROM sessions WHERE session_id = ?", (after,)).fetchone()
        if after == event["before_session"]:
            found["model_swap_restart"].append(_evidence({**dict(event), "after_session": after}, "the harness restarted; the pane is on the same session"))
        elif first_at and first_at[0] is not None and first_at[0] < event["at"] - 600:
            found["resume"].append(_evidence({**dict(event), "after_session": after}, "the harness restarted onto an earlier session"))
    for event in _events(conn, "kind = 'foreground_changed' AND reason = 'harness_left_foreground'"):
        was = json.loads(event["detail"] or "{}").get("was_pid")
        back = conn.execute("SELECT * FROM identity_events WHERE herdr_session = ? AND life = ? AND pane_id = ? AND kind = 'foreground_changed' AND reason = 'harness_entered_foreground' "
                            "AND at >= ? ORDER BY at", (event["herdr_session"], event["life"], event["pane_id"], event["at"])).fetchall()
        match = next((e for e in back if json.loads(e["detail"] or "{}").get("pid") == was), None)
        if match:
            found["ctrl_z"].append(_evidence(event, f"returned at {match['at']:.0f}, same process {was}"))
    for row in _events(conn, "kind = 'pane_closed' AND reason = 'pane_closed'"):
        had = conn.execute("SELECT 1 FROM bindings WHERE herdr_session = ? AND life = ? AND pane_id = ? AND valid_to IS NOT NULL", (row["herdr_session"], row["life"], row["pane_id"])).fetchone()
        if had:
            found["pane_close"].append(_evidence(row))
    stops = _events(conn, "kind = 'herdr_stopped'")
    for stop in stops:
        again = conn.execute("SELECT * FROM identity_events WHERE kind = 'herdr_started' AND herdr_session = ? AND at > ? ORDER BY at LIMIT 1", (stop["herdr_session"], stop["at"])).fetchone()
        if again:
            found["herdr_restart"].append(_evidence(again, f"stopped at {stop['at']:.0f}"))
    for row in _events(conn, "kind IN ('bind', 'rebind') AND harness = 'codex'"):
        found["codex_worker"].append(_evidence(row))
    for row in _events(conn, "kind IN ('bind', 'rebind') AND harness = 'pi'"):
        found["pi_pane"].append(_evidence(row))
    names = {r[0] for r in conn.execute("SELECT DISTINCT herdr_session FROM identity_events WHERE kind IN ('bind', 'rebind')")}
    if len(names) >= 2:
        for row in conn.execute("SELECT * FROM identity_events WHERE kind IN ('bind', 'rebind') ORDER BY at").fetchall():
            if row["herdr_session"] != sorted(names)[0]:
                found["second_herdr_session"].append(_evidence(row, f"sessions seen: {', '.join(sorted(names))}"))
                break
    for row in conn.execute("SELECT e.* FROM identity_events e JOIN sessions s ON s.session_id = e.after_session WHERE e.kind IN ('bind', 'rebind') "
                            "AND s.harness = 'claude' AND s.scope NOT IN ('default', 'personal-work') ORDER BY e.at").fetchall():
        found["personal_account_pane"].append(_evidence(row))
    for row in conn.execute(
            "SELECT t.at, b.herdr_session, b.pane_id, t.session_id FROM turns t JOIN sessions s ON s.session_id = t.session_id AND s.current_source_id = t.source_id "
            "JOIN bindings b ON b.session_id = t.session_id AND t.at >= b.valid_from AND (b.valid_to IS NULL OR t.at <= b.valid_to) "
            "WHERE t.source = 'session' AND t.kind = 'compacted' ORDER BY t.at").fetchall():
        found["compact"].append({"at": row["at"], "herdr_session": row["herdr_session"], "pane": row["pane_id"], "before": row["session_id"], "after": row["session_id"],
                                 "kind": "compacted", "reason": "compaction divider", "note": ""})
    return found


def evaluate(conn: sqlite3.Connection) -> list[dict]:
    found = detect(conn)
    marks = {r["row_key"]: r for r in conn.execute("SELECT * FROM coverage_marks")}
    result = []
    for key, title, rule in ROWS:
        mark = marks.get(key)
        if found[key]:
            status = "observed"
        elif mark:
            status = mark["status"]
        else:
            status = "open"
        result.append({"key": key, "title": title, "rule": rule, "status": status, "evidence": found[key], "mark": dict(mark) if mark else None})
    return result


def mark(conn: sqlite3.Connection, key: str, status: str, evidence: dict | str, clock=time.time) -> None:
    if key not in {k for k, _, _ in ROWS}:
        raise KeyError(f"no checklist row {key}")
    if status not in ("staged-in-lab", "waived"):
        raise ValueError("a hand mark is staged-in-lab or waived; observed rows come from the store's own records")
    with db.transaction(conn):
        conn.execute("INSERT OR REPLACE INTO coverage_marks(row_key, status, at, evidence) VALUES (?, ?, ?, ?)",
                     (key, status, clock(), json.dumps({"note": evidence} if isinstance(evidence, str) else evidence, sort_keys=True)))


def complete(rows: list[dict]) -> bool:
    return all(row["status"] != "open" for row in rows)


def render(rows: list[dict]) -> str:
    from datetime import datetime, timezone

    def when(at):
        return datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ") if at else "-"

    lines = ["# Event coverage checklist (S1, check 4)", "",
             f"{sum(1 for r in rows if r['status'] != 'open')} of {len(rows)} rows filled. The soak ends when every row is filled and at least seven days have passed.", "",
             "| Event | Status | First evidence (time, pane, before, after) |", "| --- | --- | --- |"]
    for row in rows:
        first = row["evidence"][0] if row["evidence"] else None
        if first:
            cell = f"{when(first['at'])}, {first['herdr_session']}/{first['pane']}, {(first['before'] or '-')[:8]} to {(first['after'] or '-')[:8]}" + (f" ({first['note']})" if first["note"] else "")
        elif row["mark"]:
            cell = json.loads(row["mark"]["evidence"]).get("note", "") or "marked by hand"
        else:
            cell = f"waiting: {row['rule']}"
        lines.append(f"| {row['title']} | {row['status']} | {cell} |")
    return "\n".join(lines) + "\n"
