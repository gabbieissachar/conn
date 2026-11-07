"""Check 5 and part of 6, in the lab: a kill in the middle of a write, the daemon's loop, restart-on-landing, and /clear to relink under two seconds."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from base import StoreCase, dump
from lab import Lab
import synth
from rstore import config, daemon, db, ingest

STORE = Path(__file__).resolve().parent.parent


class KilledIngest(StoreCase):
    def logs(self):
        for n in (1, 2, 3):
            synth.write_jsonl(synth.claude_path(self.home, synth.sid(n)), synth.claude_conversation(n_turns=4))
            os.utime(synth.claude_path(self.home, synth.sid(n)), (synth.T0 + n * 100, synth.T0 + n * 100))
        synth.write_jsonl(synth.codex_path(self.home, synth.sid(4)), synth.codex_conversation(synth.sid(4), n=3))

    def run_ingest(self, kill_after: int | None):
        code = (f"import sys; sys.path.insert(0, {str(STORE)!r})\n"
                "from pathlib import Path\nfrom rstore import config, db, ingest\n"
                f"conn = db.connect(Path({str(config.paths(self.root).db)!r}))\n"
                f"ing = ingest.Ingester(conn, config.Settings(), Path({str(self.home)!r}))\n"
                "ing.scan()\n")
        env = {**os.environ}
        env.pop("RSTORE_TEST_KILL_AFTER_ROWS", None)
        if kill_after:
            env["RSTORE_TEST_KILL_AFTER_ROWS"] = str(kill_after)
        return subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=120)

    def test_a_killed_ingest_leaves_no_duplicate_or_missing_events(self):
        for kill_after in (1, 7, 19, 33):
            with self.subTest(kill_after=kill_after):
                self.setUp()
                self.logs()
                self.conn.close()
                killed = self.run_ingest(kill_after)
                self.assertEqual(killed.returncode, -signal.SIGKILL, killed.stderr)
                # what is on disk after the kill is whole: every file in it is complete or absent, never half
                self.conn = db.connect(config.paths(self.root).db)
                self.assertEqual(self.conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                for row in self.rows("SELECT source_id, cursor_offset, size FROM sources"):
                    self.assertEqual(row["cursor_offset"], row["size"], "a source row is only ever committed with its rows and a cursor at the end of what it read")
                    self.assertTrue(self.one("SELECT COUNT(*) FROM events WHERE source_id = ?", row["source_id"]))
                self.assertEqual(self.one("SELECT COUNT(*) FROM events WHERE source_id NOT IN (SELECT source_id FROM sources)"), 0)
                self.conn.close()
                done = self.run_ingest(None)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.conn = db.connect(config.paths(self.root).db)
                scratch_root = Path(tempfile.mkdtemp(prefix="rstore-scratch-"))
                scratch = db.connect(scratch_root / "s.sqlite")
                ingest.Ingester(scratch, config.Settings(), self.home).scan()
                self.assertEqual(dump(self.conn), dump(scratch), "a re-ingest after the kill equals one from nothing")
                for table in ("events", "turns", "sessions", "sources", "tool_calls"):
                    self.assertEqual(self.one(f"SELECT COUNT(*) FROM {table}"), scratch.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], table)
                dup = self.one("SELECT COUNT(*) FROM (SELECT source_id, offset FROM events GROUP BY source_id, offset HAVING COUNT(*) > 1)")
                self.assertEqual(dup, 0)
                scratch.close()
                self.conn.close()
                self.conn = db.connect(config.paths(self.root).db)

    def test_a_killed_ingest_of_a_growing_log_resumes_from_its_cursor(self):
        path = synth.claude_path(self.home, synth.sid(1))
        records = synth.claude_conversation(n_turns=5)
        synth.write_jsonl(path, records[:12])
        self.ing.scan()
        synth.append_jsonl(path, records[12:])
        os.utime(path, None)
        self.conn.close()
        killed = self.run_ingest(3)
        self.assertEqual(killed.returncode, -signal.SIGKILL)
        self.conn = db.connect(config.paths(self.root).db)
        self.assertEqual(self.one("SELECT cursor_offset FROM sources"), self.one("SELECT cursor_offset FROM sources"))
        self.assertLess(self.one("SELECT cursor_offset FROM sources"), path.stat().st_size, "the cursor stayed where the committed work ended")
        self.conn.close()
        self.assertEqual(self.run_ingest(None).returncode, 0)
        self.conn = db.connect(config.paths(self.root).db)
        scratch = db.connect(Path(tempfile.mkdtemp(prefix="rstore-scratch-")) / "s.sqlite")
        ingest.Ingester(scratch, config.Settings(), self.home).scan()
        self.assertEqual(dump(self.conn), dump(scratch))
        scratch.close()


class DaemonLoop(StoreCase):
    def build(self, **kwargs):
        self.lab = Lab(self.home)
        self.addCleanup(self.lab.close)
        where = config.paths(self.root)
        settings = config.Settings(scan_seconds=0.1, reconcile_seconds=0.3, **kwargs)
        self.conn.close()
        d = daemon.Daemon(where, settings, self.home, client=self.lab.client(), proc_start=self.lab.proc_start, alive=self.lab.alive, subscribe=False,
                          change_parity_seconds=0.0, audit_seconds=0.0)
        self.addCleanup(lambda: None)
        self.daemon = d
        self.conn = db.connect(where.db)
        return d

    def test_one_tick_does_the_whole_loop(self):
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), synth.claude_conversation(n_turns=2))
        d = self.build()
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=synth.sid(1), pid=1001)
        self.lab.pid_record(1001, synth.sid(1))
        d.start()
        stats = d.tick()
        self.assertEqual(stats["changed"], 1)
        self.assertEqual(stats["reconcile"]["panes"], 1)
        self.assertEqual(stats["audit"]["agree"], 1)
        self.assertIn("parity_run", stats)
        self.assertEqual(self.one("SELECT mismatches FROM parity_runs"), 0)
        self.assertEqual(self.one("SELECT session_id FROM v1_live_bindings"), synth.sid(1))
        beat = self.rows("SELECT * FROM ingest_heartbeat")[0]
        self.assertEqual(beat["status"], "ok")
        self.assertEqual(self.rows("SELECT value FROM meta WHERE key = 'daemon_code_stamp'")[0]["value"], d.stamp)
        d.conn.close()

    def test_clear_relinks_within_two_seconds(self):
        d = self.build()
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=synth.sid(1), pid=1001)
        self.lab.pid_record(1001, synth.sid(1))
        runner = threading.Thread(target=d.run, daemon=True)
        runner.start()
        deadline = time.time() + 10
        while time.time() < deadline and self.one("SELECT session_id FROM v1_live_bindings") != synth.sid(1):
            time.sleep(0.02)
        self.assertEqual(self.one("SELECT session_id FROM v1_live_bindings"), synth.sid(1))
        started = time.time()
        self.lab.pid_record(1001, synth.sid(2))  # /clear
        while time.time() - started < 5 and self.one("SELECT session_id FROM v1_live_bindings") != synth.sid(2):
            time.sleep(0.01)
        latency = time.time() - started
        d.stop()
        runner.join(10)
        self.assertEqual(self.one("SELECT session_id FROM v1_live_bindings"), synth.sid(2))
        self.assertLessEqual(latency, 2.0, f"relink took {latency:.2f} s")
        out = os.environ.get("RSTORE_LAB_OUT")
        if out:
            Path(out).write_text(json.dumps({"clear_relink_s": round(latency, 3)}), encoding="utf-8")
        self.assertEqual(self.rows("SELECT status FROM ingest_heartbeat")[0]["status"], "stopped")

    def test_the_daemon_exits_when_a_landing_changes_its_code(self):
        d = self.build()
        d.start()
        self.assertFalse(d.code_changed())
        d.stamp = "an-older-stamp"  # what a landing does to the files on disk
        self.assertTrue(d.code_changed())
        d.ticks = 29
        runner = threading.Thread(target=d.run, daemon=True)
        runner.start()
        runner.join(10)
        self.assertFalse(runner.is_alive(), "the loop ended on its own so KeepAlive can start the new code")
        self.assertEqual(self.rows("SELECT status FROM ingest_heartbeat")[0]["status"], "stopped")

    def test_a_crashed_daemon_is_recorded_on_the_next_start(self):
        d = self.build()
        d.conn.execute("INSERT INTO ingest_heartbeat(id, at, pid, status) VALUES (1, 1, 99999999, 'ok')")
        d.start()
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'file_event' AND key = 'crash_recovered'"), 1)
        d.conn.close()


class CodeStamp(unittest.TestCase):
    def test_the_stamp_covers_the_store_and_the_builders_rules(self):
        names = {p.name for p in daemon.HERE.glob("*.py")}
        self.assertTrue({"ingest.py", "identity.py", "daemon.py"} <= names)
        self.assertEqual(len(daemon.code_stamp()), 16)


if __name__ == "__main__":
    unittest.main()
