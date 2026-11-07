"""The long-running ingest: one process, one writer, the loop every other piece hangs on.

Each tick (default every 2 seconds):
  1. scan the logs and ingest what changed (ingest.Ingester.scan), and write the heartbeat row (so a reader can say "as of");
  2. watch ~/.claude*/sessions/ for pid records (identity.poll_pid_records), an identity event source that needs no Herdr call;
  3. take the Herdr subscription's events and read the panes they name (identity.on_item / process_dirty);
  4. every `reconcile_seconds` (default 60), read the whole Herdr inventory again (a reconcile read: events are hints, never the truth)
     and infer links; every few minutes, audit the store's bindings against the send check (sendrec.audit);
  5. after changes, a rate-limited parity pass over the sessions that changed (parity.run, trigger `change`).

Restart-on-landing: the process notes a stamp of its own code and the builder's rules at start. When a landing changes either, it
finishes the tick, writes `stopped`, and exits 0; launchd's KeepAlive starts the new code. Restart-on-crash is the same KeepAlive.
A killed process is safe: a file is one transaction (ingest.py), and the next start records `crash_recovered`.

Never sends anything to a pane. Never writes outside the store's folder.
"""

from __future__ import annotations

import hashlib
import os
import signal
import threading
import time
from pathlib import Path

from . import builder, config, db, herdr, identity, ingest, parity, rusage, sendrec

HERE = Path(__file__).resolve().parent


def code_stamp() -> str:
    """A fingerprint of the code this process runs: the store's modules and the builder files whose rules decide a turn."""
    digest = hashlib.sha1()
    for path in sorted([*HERE.glob("*.py"), builder.PROTOTYPE / "build_prototype.py", builder.PROTOTYPE / "tool_steps.py"]):
        try:
            info = path.stat()
        except OSError:
            continue
        digest.update(f"{path.name}:{info.st_size}:{info.st_mtime_ns}".encode())
    return digest.hexdigest()[:16]


class Daemon:
    def __init__(self, where: config.Paths, settings: config.Settings, home_dir: Path, *, client=None, clock=time.time, sleep=time.sleep,
                 proc_start=identity.process_start, alive=identity.pid_alive, codex_resolver=None, subscribe: bool = True,
                 change_parity_seconds: float = 600.0, audit_seconds: float = 300.0):
        self.where, self.settings, self.home_dir, self.clock, self.sleep = where, settings, Path(home_dir), clock, sleep
        self.conn = db.connect(where.db)
        self.client = client or herdr.HerdrClient()
        self.ing = ingest.Ingester(self.conn, settings, home_dir, clock=clock)
        self.ident = identity.Identity(self.conn, self.client, home_dir, clock=clock, proc_start=proc_start, alive=alive)
        self.feed = herdr.Feed(self.client) if subscribe else None
        self.codex_resolver = codex_resolver
        self.window = rusage.Window(self.conn, "ingest", 300.0, clock)
        self.stamp = code_stamp()
        self.last_reconcile = 0.0
        self.last_audit = 0.0
        self.last_parity = 0.0
        self.change_parity_seconds, self.audit_seconds = change_parity_seconds, audit_seconds
        self.changed_sessions: set[str] = set()
        self.stop_flag = threading.Event()
        self.ticks = 0

    # ---------------------------------------------------------------------------------------------------------------- tick

    def tick(self) -> dict:
        now = self.clock()
        result = self.ing.scan()
        for row in self.conn.execute("SELECT DISTINCT session_id FROM sources WHERE last_ingested >= ? AND state = 'active'", (result.started,)):
            self.changed_sessions.add(row[0])
        self.ing.heartbeat(result)
        stats = {"files": result.files, "changed": result.changed, "errors": len(result.errors)}
        stats["pid_records"] = self.ident.poll_pid_records()
        if self.feed is not None:
            for item in self.feed.drain():
                self.ident.on_item(item)
        stats["dirty"] = self.ident.process_dirty()
        if now - self.last_reconcile >= self.settings.reconcile_seconds:
            sessions = self.client.sessions()
            if sessions is not None and self.feed is not None:
                self.feed.sync(sessions)
            stats["reconcile"] = self.ident.reconcile()
            self.ident.infer_links()
            self.last_reconcile = now
        if now - self.last_audit >= self.audit_seconds:
            stats["audit"] = sendrec.audit(self.conn, self.client, self.ident, self.codex_resolver, self.clock)
            self.last_audit = now
        if self.changed_sessions and now - self.last_parity >= self.change_parity_seconds:
            ids = sorted(self.changed_sessions)[:25]
            self.changed_sessions -= set(ids)
            stats["parity_run"] = parity.run(self.conn, trigger="change", session_ids=ids, clock=self.clock)
            self.last_parity = now
        self.window.tick()
        self.ticks += 1
        return stats

    # ------------------------------------------------------------------------------------------------------------------ run

    def start(self) -> None:
        self.ing.recover_after_crash()
        self.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('daemon_code_stamp', ?)", (self.stamp,))
        self.ing.heartbeat(None, status="starting")

    def stop(self) -> None:
        self.stop_flag.set()

    def code_changed(self) -> bool:
        return code_stamp() != self.stamp

    def run(self) -> int:
        """Tick until stopped or the code changes. Returns 0: launchd's KeepAlive starts it again either way."""
        self.start()
        for name in (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(name, lambda *_: self.stop())
            except ValueError:
                pass  # not the main thread (a test)
        try:
            while not self.stop_flag.is_set():
                self.tick()
                if self.ticks % 30 == 0 and self.code_changed():
                    break
                self.stop_flag.wait(self.settings.scan_seconds)
        finally:
            if self.feed is not None:
                self.feed.stop()
            self.ing.heartbeat(None, status="stopped")
            self.conn.close()
        return 0
