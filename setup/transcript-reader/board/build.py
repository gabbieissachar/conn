"""One session's board: the snapshot, the typed asks and the lifecycle, assembled into the JSON the Tasks view reads.

`build_board(session, collector, ...)` never raises for a data problem: a snapshot that cannot be taken gives a board with no items and the
reason in `source.errors`, an ask listing that cannot be read leaves the prose calls in place and says so, a task whose card cannot be built
is counted in `source.skipped`. The page shows those notes, so a quiet board is never mistaken for an empty fleet.
"""

from __future__ import annotations

import time
from collections import Counter

from . import lifecycles
from .collect import CollectError, Collector
from .items import build_item, local_date

SCHEMA = "task-board.v1"


def build_board(session, collector: Collector, now: float | None = None) -> dict:
    now = collector.now() if now is None and hasattr(collector, "now") else (now or time.time())
    today = local_date(now)
    lifecycle, config = lifecycles.resolve_lifecycle(session.lifecycle, session.home)
    errors, skipped = [], 0
    board = {
        "schema": SCHEMA, "session": session.public(), "generated_at": int(now), "today": today,
        "lifecycle": {"id": lifecycle["id"], "name": lifecycle["name"], "blurb": lifecycle["blurb"]},
        "config": config, "columns": [], "items": [], "projects": [], "counts": {},
        "source": {"errors": errors, "asks": None, "skipped": 0, "snapshot_at": None},
    }
    started = time.monotonic()
    try:
        snapshot = collector.snapshot(session)
    except CollectError as error:
        errors.append(str(error))
        board["columns"] = _columns(lifecycle, Counter())
        return board
    board["source"]["snapshot_at"] = snapshot.get("generated")
    board["source"]["snapshot_ms"] = int((time.monotonic() - started) * 1000)
    try:
        asks = collector.asks(session)
        board["source"]["asks"] = {"records": len(asks)}
    except CollectError as error:
        asks = []
        board["source"]["asks"] = {"error": str(error)}
    tasks = {t.get("id"): t for t in snapshot.get("tasks") or [] if isinstance(t, dict)}
    items = []
    for rec in (snapshot.get("backlog") or {}).get("records") or []:
        if not isinstance(rec, dict):
            continue
        try:
            item = build_item(session, lifecycle, rec, tasks.get(rec.get("id")), asks, collector, now, today)
        except Exception as error:  # one card must not take the board down
            skipped += 1
            errors.append(f"card {rec.get('id')!r} could not be built ({error.__class__.__name__})")
            continue
        if item:
            items.append(item)
    items.sort(key=lambda i: (-(i["activity"] or 0), i["ref"]))
    counts = Counter(i["col"] for i in items)
    board["items"], board["counts"] = items, dict(counts)
    board["columns"] = _columns(lifecycle, counts)
    board["projects"] = [{"repo": repo, "count": n} for repo, n in sorted(Counter(i["repo"] for i in items).items(), key=lambda kv: (-kv[1], kv[0]))]
    board["source"]["skipped"] = skipped
    return board


def _columns(lifecycle: dict, counts: Counter) -> list[dict]:
    """The lifecycle's columns in order; an optional column appears only while it holds a card."""
    out = []
    for column in lifecycle["columns"]:
        if column.get("optional") and not counts.get(column["id"]):
            continue
        out.append({**column, "count": counts.get(column["id"], 0)})
    return out
