"""Shared test scaffolding: a store and an ingester over a synthetic home."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import synth  # noqa: E402
from rstore import config, db, ingest  # noqa: E402


class StoreCase(unittest.TestCase):
    """A fresh synthetic home folder and an empty store for each test."""

    policy: dict = {}

    def setUp(self) -> None:
        self.home = synth.make_home()
        self.root = Path(tempfile.mkdtemp(prefix="rstore-db-"))
        self.settings = config.Settings(**self.policy)
        self.conn = db.connect(config.paths(self.root).db)
        self.ing = ingest.Ingester(self.conn, self.settings, self.home)
        self.addCleanup(self.conn.close)

    def fresh(self):
        """A second, empty store over the same home (what a from-scratch ingest of the same logs gives)."""
        root = Path(tempfile.mkdtemp(prefix="rstore-db-"))
        conn = db.connect(root / "store.sqlite")
        self.addCleanup(conn.close)
        return conn, ingest.Ingester(conn, self.settings, self.home)

    def one(self, sql, *args):
        row = self.conn.execute(sql, args).fetchone()
        return row[0] if row else None

    def rows(self, sql, *args):
        return [dict(r) for r in self.conn.execute(sql, args)]


EVENT_COLUMNS = "kind, uuid, parent_uuid, origin, is_meta, is_sidechain, tool_use_id, tool_name, absorbed, starts_turn, at, role, text, text_len, meta"
TURN_COLUMNS = ("idx, uid, source, kind, label, input, at, absorbed, reply, reply_at, reply_words, narration_words, narration, tools, verdict, rule, "
                "asks, ask_lines, reminder_lines, signal_task, cwd, notices")


def dump(conn) -> dict:
    """The content of a store without its ids: what two stores built different ways must agree on."""
    out = {}
    for session in conn.execute("SELECT session_id FROM sessions ORDER BY session_id").fetchall():
        sid = session[0]
        source = conn.execute("SELECT current_source_id FROM sessions WHERE session_id = ?", (sid,)).fetchone()[0]
        out[sid] = {
            "events": [dict(r) for r in conn.execute(f"SELECT {EVENT_COLUMNS} FROM events WHERE source_id = ? ORDER BY offset", (source,))],
            "turns": [dict(r) for r in conn.execute(f"SELECT {TURN_COLUMNS} FROM turns WHERE source_id = ? ORDER BY idx", (source,))],
            "session": dict(conn.execute("SELECT harness, kind, scope, cwd, title, first_at, last_at, turn_count, event_count, log_state FROM sessions WHERE session_id = ?", (sid,)).fetchone()),
        }
    out["__counters__"] = {f"{r['name']}/{r['key']}": r["count"] for r in conn.execute("SELECT name, key, count FROM counters WHERE name IN ('ignored_record', 'unknown_record')")}
    return out
