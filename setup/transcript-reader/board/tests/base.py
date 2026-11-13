"""Shared scaffolding for the board tests: synthetic snapshots, a fake collector, scratch homes and real scratch git repos."""

from __future__ import annotations

import base64
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))  # setup/transcript-reader, so `import board` works

from board import homes  # noqa: E402
from board.collect import CollectError, Collector  # noqa: E402

NOW = time.mktime((2026, 11, 7, 12, 0, 0, 0, 0, -1))
EPOCH_UTC = lambda y, mo, d, h=0, mi=0: __import__("calendar").timegm((y, mo, d, h, mi, 0))  # noqa: E731


def record(task_id, **over):
    """A backlog record shaped like fm-fleet-snapshot.v1's, with every key the board reads."""
    rec = {
        "id": task_id, "title": f"Title of {task_id}", "state": "in_flight", "kind": "ship", "repo": "proj", "since": "2026-11-05", "structured": True,
        "done": None, "reported": None, "completion": {"date": None, "verb": None}, "hold_kind": None, "hold_reason": None, "hold_until": None,
        "hold_set": None, "hold_bucket": None, "hold_age_days": None, "captain_actionable": False, "blocked_by_ids": [], "unresolved_blocker_ids": [],
        "body_lines": [], "pr_url": None, "report_path": None, "local_note": None, "current_role": "worker",
    }
    rec.update(over)
    return rec


def held(task_id, reason, bucket="live", **over):
    base = dict(hold_kind="captain", hold_reason=reason, hold_bucket=bucket, hold_set="2026-11-06T10:00:00Z", state="queued", captain_actionable=bucket == "live")
    base.update(over)
    return record(task_id, **base)


def task_row(task_id, **over):
    row = {"id": task_id, "kind": "ship", "branch": None, "project": None, "pr": {"url": None, "head": None, "source": "absent"}, "driver": None,
           "spawn_gen": "s1794000000.1.1", "hints": {"open_decisions": [], "pending_decision": False, "blocked_event": False},
           "paths": {"status_log": {"last_event": None}}}
    row.update(over)
    return row


def snapshot(records, tasks=()):
    return {"schema": "fm-fleet-snapshot.v1", "generated": "2026-11-07T05:00:00Z", "backlog": {"records": list(records)}, "tasks": list(tasks)}


class FakeCollector(Collector):
    """Serves a canned snapshot and ask list; file and git reading stay real, against a scratch home."""

    def __init__(self, snap=None, asks=(), snapshot_error=None, asks_error=None):
        super().__init__(None, now=lambda: NOW)
        self.snap, self.ask_records, self.snapshot_error, self.asks_error = snap, list(asks), snapshot_error, asks_error

    def snapshot(self, session):
        if self.snapshot_error:
            raise CollectError(self.snapshot_error)
        return self.snap

    def asks(self, session):
        if self.asks_error:
            raise CollectError(self.asks_error)
        return self.ask_records


class HomeCase(unittest.TestCase):
    """A scratch Firstmate home (data/, state/, projects/) and a session pointing at it."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="board-test-"))
        self.home = self.tmp / "home"
        for sub in ("data", "state", "projects", "config"):
            (self.home / sub).mkdir(parents=True)
        os.environ["PMOS_READER_BOARD_CACHE"] = str(self.tmp / "cache")
        self.addCleanup(os.environ.pop, "PMOS_READER_BOARD_CACHE", None)
        self.session = homes.Session("leader-test", "Test", self.home, "software")

    def status(self, task_id, *lines):
        (self.home / "state" / f"{task_id}.status").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def write(self, rel, text):
        path = self.home / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def git_project(self, name="proj", branches=None):
        """projects/<name> as a real repo: main with one commit, and each branch {name: extra commits ahead of main}."""
        repo = self.home / "projects" / name
        repo.mkdir(parents=True)
        run = lambda *a: subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", *a], check=True, capture_output=True)  # noqa: E731
        run("init", "-q", "-b", "main")
        (repo / "f.txt").write_text("1\n")
        run("add", "."), run("commit", "-q", "-m", "base")
        for branch, ahead in (branches or {}).items():
            run("checkout", "-q", "-b", branch)
            for n in range(ahead):
                (repo / "f.txt").write_text(f"{branch}{n}\n")
                run("commit", "-q", "-am", f"c{n}")
            run("checkout", "-q", "main")
        return repo

    def board(self, snap, asks=(), session=None, **kw):
        from board.build import build_board
        return build_board(session or self.session, FakeCollector(snap, asks, **kw), now=NOW)

    def item(self, board, ref):
        return next(i for i in board["items"] if i["ref"] == ref)
