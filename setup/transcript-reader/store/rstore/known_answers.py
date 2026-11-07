"""Check 7, the owner's usefulness check: about ten searches whose answer is known, written down BEFORE the soak.

The file is a markdown table the owner corrects by hand; each row is a query and the session it should find:

  | # | query | expected session (id or its first 8 characters) | note |
  | 1 | herdr events subscribe | 5c4c926e | the session where the P0 hook was installed |

`check` runs every row against the store and reports whether the expected session is among the first <top> results (default 5).
A row with no expected session is "undecided", not a failure: that is how a draft reads before the owner fills it. The file holds
session ids and so lives with the soak's private records, never in the repository (the repository has the format and this checker).
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from . import search as search_mod

ROW = re.compile(r"^\|\s*(\d+)\s*\|(.+?)\|(.*?)\|(.*?)\|\s*$")


def parse(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        match = ROW.match(line.strip())
        if match:
            rows.append({"n": int(match.group(1)), "query": match.group(2).strip(), "expected": match.group(3).strip().strip("`"), "note": match.group(4).strip()})
    return rows


def check(conn: sqlite3.Connection, rows: list[dict], top: int = 5) -> list[dict]:
    results = []
    for row in rows:
        found = search_mod.search(conn, row["query"], limit=max(top, 10))
        ids = [item["session_id"] for item in found]
        expected = row["expected"]
        if not expected or expected.startswith("<"):
            status, position = "undecided", None
        else:
            hits = [i for i, sid in enumerate(ids) if sid == expected or sid.startswith(expected)]
            position = hits[0] + 1 if hits else None
            status = "pass" if position is not None and position <= top else "fail"
        results.append({**row, "status": status, "position": position, "results": len(ids), "top": [{"session_id": s["session_id"], "title": s["title"], "scope": s["scope"]} for s in found[:top]]})
    return results


def candidates_table(conn: sqlite3.Connection, queries: list[str], top: int = 3) -> str:
    """A draft for the owner to correct: each query with the store's top sessions by id, harness, scope, folder name and date, and no text of
    any message. The expected column is left blank on purpose; the owner fills it in from what they know."""
    lines = ["| # | query | expected session (id or its first 8 characters) | note |", "| --- | --- | --- | --- |"]
    for n, query in enumerate(queries, 1):
        found = search_mod.search(conn, query, limit=top)
        note = "; ".join(f"{s['session_id'][:8]} {s['harness']}/{s['scope']} {Path(s['cwd'] or '').name or '-'}" for s in found) or "no session matched"
        lines.append(f"| {n} | {query} | <fill in> | candidates: {note} |")
    return "\n".join(lines) + "\n"
