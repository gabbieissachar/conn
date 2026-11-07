"""`forget <session>`: a session removed from the store everywhere, and never taken again.

W1 made the store an archive, so a person needs a way to take something out of it. Forgetting a session removes, in one transaction,
its sources, events, turns, search rows, tool steps, links, every identity fact and binding that names it, its Send checks, the Herdr id a pane last reported for it, and its
parity rows, and its sub-agents with it. It writes a tombstone (`forgotten`), so the next scan does not read the still-present log
again (it is counted as skipped: forgotten). Then the file is rewritten (`secure_delete` is on, the WAL is truncated and the file is
vacuumed) so the text is out of the file, not only out of the index.

"Backups from that point on" (plan S1 check 5): the next snapshot is taken from this file, so it holds nothing of the session. Earlier
snapshots already staged or uploaded still do; this code lists them (`older_snapshots`) and never deletes a file. Removing those is a
decision for the person (move them aside; never rm).
"""

from __future__ import annotations

import sqlite3
import time

from . import db


def family(conn: sqlite3.Connection, session_id: str) -> list[str]:
    """The session and its sub-agents: any session whose parent column, source or sub-agent link points at it, however deep."""
    found = [session_id]
    frontier = [session_id]
    while frontier:
        marks = ",".join("?" * len(frontier))
        children = [r[0] for r in conn.execute(f"SELECT session_id FROM sessions WHERE parent_session_id IN ({marks})", frontier)]
        children += [r[0] for r in conn.execute(f"SELECT DISTINCT session_id FROM sources WHERE parent_session_id IN ({marks})", frontier)]
        children += [r[0] for r in conn.execute(f"SELECT to_session FROM links WHERE kind = 'subagent' AND from_session IN ({marks})", frontier)]
        frontier = [c for c in dict.fromkeys(children) if c not in found]
        found += frontier
    return found


def forget(conn: sqlite3.Connection, session_id: str, note: str | None = None, clock=time.time, vacuum: bool = True) -> dict:
    now = clock()
    ids = family(conn, session_id)
    marks = ",".join("?" * len(ids))
    removed = {"sessions": 0, "turns": 0, "events": 0}
    with db.transaction(conn):
        source_ids = [r[0] for r in conn.execute(f"SELECT source_id FROM sources WHERE session_id IN ({marks})", ids)]
        removed["sessions"] = conn.execute(f"SELECT COUNT(*) FROM sessions WHERE session_id IN ({marks})", ids).fetchone()[0]
        removed["turns"] = conn.execute(f"SELECT COUNT(*) FROM turns WHERE session_id IN ({marks})", ids).fetchone()[0]
        removed["events"] = conn.execute(f"SELECT COUNT(*) FROM events WHERE session_id IN ({marks})", ids).fetchone()[0]
        conn.execute(f"DELETE FROM search WHERE rowid IN (SELECT turn_id FROM turns WHERE session_id IN ({marks}))", ids)
        for table in ("turns", "events"):
            conn.execute(f"DELETE FROM {table} WHERE session_id IN ({marks})", ids)
        if source_ids:
            src_marks = ",".join("?" * len(source_ids))
            conn.execute(f"DELETE FROM tool_calls WHERE source_id IN ({src_marks})", source_ids)
        conn.execute(f"DELETE FROM sources WHERE session_id IN ({marks})", ids)
        conn.execute(f"DELETE FROM sessions WHERE session_id IN ({marks})", ids)
        conn.execute(f"DELETE FROM links WHERE from_session IN ({marks}) OR to_session IN ({marks})", ids + ids)
        for table, column in (("facts", "session_id"), ("bindings", "session_id"), ("send_checks", "session_id"), ("send_checks", "store_session"),
                              ("parity_mismatches", "session_id"), ("disagreement_rows", "store_session"), ("disagreement_rows", "builder_session"),
                              ("builder_pane_map", "session_id")):
            conn.execute(f"DELETE FROM {table} WHERE {column} IN ({marks})", ids)
        conn.execute(f"UPDATE panes SET herdr_value = NULL WHERE herdr_value IN ({marks})", ids)
        conn.execute(f"UPDATE identity_events SET before_session = NULL WHERE before_session IN ({marks})", ids)
        conn.execute(f"UPDATE identity_events SET after_session = NULL WHERE after_session IN ({marks})", ids)
        for forgotten_id in ids:
            conn.execute("INSERT OR REPLACE INTO forgotten(session_id, at, note) VALUES (?, ?, ?)", (forgotten_id, now, note))
        older = [r[0] for r in conn.execute("SELECT snapshot FROM backups WHERE at <= ? ORDER BY at", (now,))]
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    if vacuum:
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return {**removed, "forgotten": ids, "older_snapshots": older}
