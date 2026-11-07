"""Check 6: cost and lag, with numbers.

CPU is measured with `getrusage` (user plus system seconds, wall time and peak memory), never guessed:
  * the ingest daemon writes one `rusage_samples` row every window (default 5 minutes) with the CPU it used in that window;
  * the parity job writes its own row each run (parity.py);
  * `Meter` wraps any one-off run (the cold ingest, a backup) and records it.

The budget (the numbers the soak is held to) is in BUDGET and in the README with the measurements that set it. Ingest lag is the
`ingest_lag` table (the time between a log's last write and the store having it, one sample per ingested file); p95 comes from it.
"""

from __future__ import annotations

import contextlib
import os
import resource
import sqlite3
import time

# CPU seconds per wall-clock hour while idle-ish (the daemon scanning every 2 s, a few live sessions growing), the cold-ingest ceiling
# per gigabyte of raw log, the diff job's per-run ceiling, and the lag p95. Set from measurements (README, "Cost and lag").
BUDGET = {
    "ingest_cpu_s_per_hour": 120.0,
    "parity_cpu_s_per_run": 120.0,
    "lag_p95_s": 5.0,
    "clear_relink_s": 2.0,
}


def maxrss_kb() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value // 1024 if os.uname().sysname == "Darwin" else value


@contextlib.contextmanager
def meter(conn: sqlite3.Connection | None, component: str, note: str | None = None, clock=time.time):
    """Record the CPU and wall time of the block as one `rusage_samples` row (when <conn> is given) and hand back the numbers."""
    start_wall, start = clock(), resource.getrusage(resource.RUSAGE_SELF)
    result: dict = {}
    try:
        yield result
    finally:
        end = resource.getrusage(resource.RUSAGE_SELF)
        result.update(user_s=end.ru_utime - start.ru_utime, sys_s=end.ru_stime - start.ru_stime, wall_s=clock() - start_wall, maxrss_kb=maxrss_kb())
        if conn is not None:
            conn.execute("INSERT INTO rusage_samples(at, component, user_s, sys_s, wall_s, maxrss_kb, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (start_wall, component, result["user_s"], result["sys_s"], result["wall_s"], result["maxrss_kb"], note))


class Window:
    """The daemon's own CPU, sampled every <seconds>."""

    def __init__(self, conn: sqlite3.Connection, component: str = "ingest", seconds: float = 300.0, clock=time.time):
        self.conn, self.component, self.seconds, self.clock = conn, component, seconds, clock
        self.reset()

    def reset(self) -> None:
        self.wall0, self.use0 = self.clock(), resource.getrusage(resource.RUSAGE_SELF)

    def tick(self) -> bool:
        now = self.clock()
        if now - self.wall0 < self.seconds:
            return False
        use = resource.getrusage(resource.RUSAGE_SELF)
        self.conn.execute("INSERT INTO rusage_samples(at, component, user_s, sys_s, wall_s, maxrss_kb, note) VALUES (?, ?, ?, ?, ?, ?, 'window')",
                          (self.wall0, self.component, use.ru_utime - self.use0.ru_utime, use.ru_stime - self.use0.ru_stime, now - self.wall0, maxrss_kb()))
        self.reset()
        return True


def p95(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))]


def report(conn: sqlite3.Connection, since: float = 0.0) -> dict:
    """The numbers the scorecard quotes."""
    out: dict = {"components": {}}
    for row in conn.execute("SELECT component, COUNT(*) n, SUM(user_s + sys_s) cpu, SUM(wall_s) wall, MAX(maxrss_kb) rss, MAX(user_s + sys_s) worst "
                            "FROM rusage_samples WHERE at >= ? GROUP BY component", (since,)):
        out["components"][row["component"]] = {"samples": row["n"], "cpu_s": row["cpu"] or 0.0, "wall_s": row["wall"] or 0.0, "peak_rss_kb": row["rss"],
                                                "worst_sample_cpu_s": row["worst"] or 0.0,
                                                "cpu_s_per_hour": (row["cpu"] or 0.0) / (row["wall"] / 3600.0) if row["wall"] else None}
    lags = [r[0] for r in conn.execute("SELECT lag_s FROM ingest_lag WHERE at >= ?", (since,))]
    out["lag"] = {"samples": len(lags), "p95_s": p95(lags), "max_s": max(lags) if lags else None}
    out["budget"] = dict(BUDGET)
    return out
