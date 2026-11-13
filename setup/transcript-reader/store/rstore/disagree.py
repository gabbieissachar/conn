"""Check 3: disagreement adjudication. The store's live pane-to-session binding against the builder's, row by row.

The builder's mapping (build_prototype.herdr_panes: session id to the pane that runs it, from Herdr's own reports checked against
the pid records) is sampled and kept in `builder_pane_map`; the store's live bindings are compared with it, and every pane where they
differ is a row of `disagreement_rows` (the `disagreements` view). Kinds:

  differs        both name a session for the pane and they are not the same one
  store_only     the store has a live binding the builder does not
  builder_only   the builder maps a session to a pane the store has no live binding for

Each row is adjudicated by hand, daily: `store-right`, `builder-right` or `both-wrong`.
  builder-right rows are store bugs to fix.
  store-right rows are the inventory of today's identity bugs: proof the store fixes what it should.
Pass: zero unadjudicated rows, and no open builder-right row. A row closes by itself when the two agree again, and keeps its verdict.
"""

from __future__ import annotations

import sqlite3
import time

from . import builder, db


def builder_map(inventory=None) -> dict[tuple[str, str], set[str]]:
    """(Herdr session, pane id) -> the sessions the builder says run there. <inventory> stands in for builder.herdr_panes() in a test."""
    panes = inventory() if inventory else builder.bp.herdr_panes()
    found: dict[tuple[str, str], set[str]] = {}
    for session_id, info in (panes or {}).items():
        if info.get("herdr") and info.get("pane"):
            found.setdefault((info["herdr"], info["pane"]), set()).add(session_id)
    return found


def store_map(conn: sqlite3.Connection) -> dict[tuple[str, str], sqlite3.Row]:
    """(Herdr session, pane id) -> the live binding, for the current life of each Herdr session."""
    found = {}
    for row in conn.execute("SELECT b.* FROM bindings b JOIN herdr_lives l ON l.herdr_session = b.herdr_session AND l.life = b.life AND l.ended_at IS NULL WHERE b.valid_to IS NULL"):
        found[(row["herdr_session"], row["pane_id"])] = row
    return found


def sample(conn: sqlite3.Connection, builder_panes: dict[tuple[str, str], set[str]], clock=time.time, note: str | None = None) -> dict:
    """Keep this builder mapping, and bring the disagreement rows up to date with it."""
    now = clock()
    store = store_map(conn)
    stats = {"opened": 0, "seen_again": 0, "closed": 0, "agreeing": 0}
    with db.transaction(conn):
        sample_id = conn.execute("INSERT INTO builder_samples(at, note) VALUES (?, ?)", (now, note)).lastrowid
        for (herdr, pane), sessions in builder_panes.items():
            for session_id in sessions:
                conn.execute("INSERT OR IGNORE INTO builder_pane_map(sample_id, herdr_session, pane_id, session_id) VALUES (?, ?, ?, ?)", (sample_id, herdr, pane, session_id))
        current: dict[tuple[str, str], tuple[str, str | None, str | None, str | None]] = {}
        for key in set(store) | set(builder_panes):
            binding, theirs = store.get(key), builder_panes.get(key) or set()
            mine = binding["session_id"] if binding else None
            if mine and mine in theirs and len(theirs) == 1:
                stats["agreeing"] += 1
                continue
            if mine and not theirs:
                current[key] = ("store_only", mine, binding["source"], None)
            elif theirs and not mine:
                current[key] = ("builder_only", None, None, sorted(theirs)[0] if len(theirs) == 1 else ",".join(sorted(theirs)))
            elif mine in theirs:
                current[key] = ("differs", mine, binding["source"], ",".join(sorted(theirs)))  # the builder also names another session for the pane
            else:
                current[key] = ("differs", mine, binding["source"], ",".join(sorted(theirs)))
        opened = conn.execute("SELECT * FROM disagreement_rows WHERE closed_at IS NULL").fetchall()
        kept = set()
        for row in opened:
            key = (row["herdr_session"], row["pane_id"])
            now_row = current.get(key)
            if now_row and (now_row[0], now_row[1], now_row[3]) == (row["kind"], row["store_session"], row["builder_session"]):
                conn.execute("UPDATE disagreement_rows SET last_seen = ?, samples = samples + 1 WHERE row_id = ?", (now, row["row_id"]))
                kept.add(key)
                stats["seen_again"] += 1
            else:
                conn.execute("UPDATE disagreement_rows SET closed_at = ? WHERE row_id = ?", (now, row["row_id"]))
                stats["closed"] += 1
        for key, (kind, mine, source, theirs) in current.items():
            if key in kept:
                continue
            binding = store.get(key)
            conn.execute("INSERT INTO disagreement_rows(herdr_session, life, pane_id, store_session, store_source, builder_session, kind, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                         (key[0], binding["life"] if binding else None, key[1], mine, source, theirs, kind, now, now))
            stats["opened"] += 1
    return stats


def adjudicate(conn: sqlite3.Connection, row_id: int, verdict: str, note: str | None = None, clock=time.time) -> None:
    if verdict not in ("store-right", "builder-right", "both-wrong"):
        raise ValueError("verdict must be store-right, builder-right or both-wrong")
    with db.transaction(conn):
        changed = conn.execute("UPDATE disagreement_rows SET verdict = ?, verdict_note = ?, verdict_at = ? WHERE row_id = ?", (verdict, note, clock(), row_id)).rowcount
    if not changed:
        raise KeyError(f"no disagreement row {row_id}")


def summary(conn: sqlite3.Connection) -> dict:
    row = conn.execute(
        "SELECT COUNT(*) AS total, SUM(verdict IS NULL) AS unadjudicated, SUM(verdict = 'builder-right') AS builder_right, "
        "SUM(verdict = 'builder-right' AND closed_at IS NULL) AS open_builder_right, SUM(verdict = 'store-right') AS store_right, "
        "SUM(verdict = 'both-wrong') AS both_wrong FROM disagreement_rows").fetchone()
    return {key: row[key] or 0 for key in row.keys()}
