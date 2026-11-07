"""Search across every session (validation check 7: the usefulness check by the owner).

One FTS5 row per turn (input, working notes and reply). A query is split into words and every word must match (AND); a query that
finds nothing that way is tried again with any word (OR). Results are one row per session, its best-ranked turn first, so a
known-answer search asks "is the session I expect in the top results", which is what check 7 asks.

Search is read-only and reads only the store.
"""

from __future__ import annotations

import re
import sqlite3

WORD = re.compile(r"[\w][\w\-./:]*", re.UNICODE)


def fts_query(text: str, mode: str = "and") -> str:
    words = [w.strip("-./:") for w in WORD.findall(text)]
    words = [w for w in words if w]
    quoted = ['"' + w.replace('"', '""') + '"' for w in words]
    return (" AND " if mode == "and" else " OR ").join(quoted)


def search(conn: sqlite3.Connection, text: str, limit: int = 10, *, scope: str | None = None, include_subagents: bool = False) -> list[dict]:
    """The sessions that best match <text>: [{session_id, harness, title, cwd, scope, last_at, log_state, rank, snippet, turn_idx}]."""
    for mode in ("and", "or"):
        query = fts_query(text, mode)
        if not query:
            return []
        extra, params = "", [query]
        if scope:
            extra += " AND s.scope = ?"
            params.append(scope)
        if not include_subagents:
            extra += " AND s.kind = 'session'"
        rows = conn.execute(
            "SELECT s.session_id, s.harness, s.title, s.cwd, s.scope, s.last_at, s.log_state, bm25(search) AS rank, "
            "snippet(search, 0, '[', ']', ' ... ', 12) AS snippet, t.idx AS turn_idx "
            "FROM search JOIN turns t ON t.turn_id = search.rowid JOIN sessions s ON s.session_id = t.session_id "
            f"WHERE search MATCH ? {extra} ORDER BY rank LIMIT 400", params).fetchall()
        best: dict[str, dict] = {}
        for row in rows:
            if row["session_id"] not in best:
                best[row["session_id"]] = dict(row)
        if best:
            return list(best.values())[:limit]
    return []
