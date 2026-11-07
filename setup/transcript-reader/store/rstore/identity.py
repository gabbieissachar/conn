"""Live pane identity (plan S1, "Identity (B1)"): which session does this pane run, right now, and how do we know.

Four rules, all from the review:

 1. The key is (Herdr session, session life, pane id). A pane id repeats across the lives of a Herdr session, and two Herdr sessions
    run at once. Herdr's `terminal_id` is stored beside it so the validation can test it for uniqueness before it is ever the key.
 2. A fact is live only while the process it was observed with is still the pane's harness process: its pid and start time
    (`ps -o lstart`, the same string Claude writes as `procStart` in its pid record). The pane's foreground changing, a process
    restarting, the process dying, the pane closing or exiting, the Herdr session's life changing or Herdr stopping each expire it.
 3. Among live facts the rank is: the harness's pid record naming the foreground pid (Claude's ~/.claude*/sessions/<pid>.json,
    which follows /clear and --resume), then Herdr's own report, then the working-folder inference (the newest session of that
    harness in that folder). Draft 1 ranked Herdr first, and 3 of 32 Herdr ids were stale while a live Claude in the same folder ran
    another session.
 4. Herdr keeps the id it was first told. A Herdr value that has not changed since before the foreground process changed is stale, and
    is not made a fact again; only a value Herdr reports anew is (the Codex reporter and the Claude hook both report anew).

Everything that changes a pane's answer is written to `identity_events` with before and after, which is the evidence for the
coverage checklist. Nothing here sends anything to a pane.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import time
from pathlib import Path

from . import db, herdr as herdr_mod, sources

RANK = {"pid_record": 3, "herdr_report": 2, "cwd_inference": 1}
SHELLS = {"bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "login"}
INFERRED_HARNESSES = ("codex", "copilot", "pi")


def _base(value) -> str:
    return os.path.basename(str(value or "")).strip()


def harness_of(process: dict) -> str | None:
    """Which harness a foreground process is, from its argv0, its name or the first word of its command line."""
    first = (str(process.get("cmdline") or "").split(None, 1) or [""])[0]
    names = {_base(process.get("argv0")), _base(process.get("name")), _base(first)}
    for harness in ("claude", "codex", "copilot", "pi"):
        if harness in names:
            return harness
    if "pi-coding-agent" in str(process.get("cmdline") or ""):
        return "pi"
    return None


def foreground_harness(info: dict | None, agent: str | None) -> dict | None:
    """The harness process in a pane's foreground ({pid, harness, cwd, argv0}), or None when a shell (or nothing) holds it. When no process
    is recognised but Herdr names an agent, the foreground group leader stands in for it unless it is a shell."""
    if not info:
        return None
    processes = [p for p in info.get("foreground_processes") or [] if isinstance(p, dict) and isinstance(p.get("pid"), int)]
    for process in processes:
        harness = harness_of(process)
        if harness:
            return {"pid": process["pid"], "harness": harness, "cwd": process.get("cwd") or info.get("cwd"), "argv0": process.get("argv0")}
    if agent in ("claude", "codex", "copilot", "pi"):
        leader = info.get("foreground_process_group_id")
        for process in processes:
            if process["pid"] == leader and _base(process.get("argv0") or process.get("name")) not in SHELLS:
                return {"pid": process["pid"], "harness": agent, "cwd": process.get("cwd") or info.get("cwd"), "argv0": process.get("argv0")}
    return None


def process_start(pid: int) -> str | None:
    """The start time of <pid> as `ps` prints it (the form Claude records as procStart), or None when there is no such process."""
    try:
        done = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5,
                              env={**os.environ, "LC_ALL": "C"})
    except (OSError, subprocess.SubprocessError):
        return None
    text = " ".join(done.stdout.split())
    return text or None


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def same_start(a: str | None, b: str | None) -> bool:
    return bool(a) and bool(b) and " ".join(str(a).split()) == " ".join(str(b).split())


class PidRecords:
    """The running Claude processes' own records, ~/.claude*/sessions/<pid>.json, read again only when a file changes. Only files named
    <digits>.json are opened (the folder also holds key files, which are never read)."""

    NAME = re.compile(r"^(\d+)\.json$")

    def __init__(self, home_dir: Path, env: dict | None = None, alive=pid_alive):
        self.home_dir, self.env, self.alive = Path(home_dir), env, alive
        self.cache: dict[str, tuple[tuple[int, int], dict | None]] = {}
        self.records: dict[int, dict] = {}

    def folders(self) -> list[Path]:
        return [home / "sessions" for home in sources.claude_homes(self.home_dir, self.env)]

    def poll(self) -> tuple[dict[int, dict], set[int]]:
        """(pid -> record of every live process, the pids whose record appeared, changed or went away since the last poll)."""
        found: dict[int, dict] = {}
        seen = set()
        for folder in self.folders():
            try:
                entries = list(os.scandir(folder))
            except OSError:
                continue
            for entry in entries:
                match = self.NAME.match(entry.name)
                if not match:
                    continue
                path = entry.path
                seen.add(path)
                try:
                    info = entry.stat()
                except OSError:
                    continue
                stamp = (info.st_mtime_ns, info.st_size)
                cached = self.cache.get(path)
                if cached and cached[0] == stamp:
                    record = cached[1]
                else:
                    try:
                        value = json.loads(Path(path).read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        value = None
                    record = value if isinstance(value, dict) else None
                    self.cache[path] = (stamp, record)
                if record and isinstance(record.get("pid"), int) and isinstance(record.get("sessionId"), str) and self.alive(record["pid"]):
                    found[record["pid"]] = {"session_id": record["sessionId"], "proc_start": record.get("procStart"),
                                            "cwd": record.get("cwd"), "path": path}
        for path in list(self.cache):
            if path not in seen:
                del self.cache[path]
        changed = {pid for pid, rec in found.items() if self.records.get(pid) != rec} | {pid for pid in self.records if pid not in found}
        self.records = found
        return found, changed


class Identity:
    def __init__(self, conn: sqlite3.Connection, client, home_dir: Path, *, clock=time.time, proc_start=process_start, alive=pid_alive,
                 env: dict | None = None):
        self.conn = conn
        self.client = client
        self.home_dir = Path(home_dir)
        self.clock = clock
        self.proc_start = proc_start
        self.alive = alive
        self.pid_records = PidRecords(home_dir, env, alive)
        self.dirty: set[tuple[str, str]] = set()
        self.created: set[tuple[str, str, str]] = set()
        self.start_cache: dict[int, tuple[float, str | None]] = {}
        self.records_at = 0.0

    # ------------------------------------------------------------------------------------------------------------- helpers

    def ensure_records(self, max_age: float = 1.0) -> None:
        """Read the pid records again unless they were read within <max_age> seconds."""
        now = self.clock()
        if now - self.records_at >= max_age:
            self.pid_records.poll()
            self.records_at = now

    def process_is(self, pid: int, start: str | None) -> bool:
        """Whether <pid> is still the process that started at <start> (a reused pid has another start time)."""
        if not self.alive(pid):
            return False
        return True if not start else same_start(self.start_of(pid), start)

    def start_of(self, pid: int) -> str | None:
        now = self.clock()
        cached = self.start_cache.get(pid)
        if cached and now - cached[0] < 5:
            return cached[1]
        value = self.proc_start(pid)
        self.start_cache[pid] = (now, value)
        return value

    def event(self, kind: str, *, herdr_session=None, life=None, pane_id=None, before=None, after=None, source=None, reason=None,
              harness=None, detail=None, at=None) -> None:
        self.conn.execute(
            "INSERT INTO identity_events(at, kind, herdr_session, life, pane_id, before_session, after_session, source, reason, harness, detail) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (at if at is not None else self.clock(), kind, herdr_session, life, pane_id, before, after, source, reason, harness,
             json.dumps(detail or {}, sort_keys=True)))

    def open_facts(self, key) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM facts WHERE herdr_session = ? AND life = ? AND pane_id = ? AND valid_to IS NULL ORDER BY fact_id", key).fetchall()

    def close_fact(self, fact_id: int, reason: str, now: float) -> None:
        self.conn.execute("UPDATE facts SET valid_to = ?, expired_reason = ? WHERE fact_id = ? AND valid_to IS NULL", (now, reason, fact_id))

    def open_fact(self, key, source: str, session_id: str, harness: str | None, pid: int | None, start: str | None, evidence: dict, now: float) -> int:
        return self.conn.execute(
            "INSERT INTO facts(herdr_session, life, pane_id, source, session_id, harness, pid, proc_start, observed_at, valid_from, evidence) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (*key, source, session_id, harness, pid, start, now, now, json.dumps(evidence, sort_keys=True))).lastrowid

    def binding(self, key) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM bindings WHERE herdr_session = ? AND life = ? AND pane_id = ? AND valid_to IS NULL", key).fetchone()

    # --------------------------------------------------------------------------------------------------------- resolution

    def resolve(self, key, now: float, reason: str, harness: str | None = None, detail: dict | None = None) -> None:
        """Set the pane's binding to the highest-ranked live fact, and write an identity event when the answer changed."""
        facts = self.open_facts(key)
        current = self.binding(key)
        winner, conflict = None, 0
        if facts:
            top = max(RANK[f["source"]] for f in facts)
            tops = [f for f in facts if RANK[f["source"]] == top]
            winner = tops[-1]
            conflict = int(len({f["session_id"] for f in tops}) > 1)
        if winner is None:
            if current:
                self.conn.execute("UPDATE bindings SET valid_to = ?, end_reason = ? WHERE binding_id = ?", (now, reason, current["binding_id"]))
                self.event("unbind", herdr_session=key[0], life=key[1], pane_id=key[2], before=current["session_id"], after=None,
                           source=current["source"], reason=reason, harness=current["harness"], detail=detail, at=now)
            return
        if current is None:
            self.conn.execute("INSERT INTO bindings(herdr_session, life, pane_id, session_id, harness, source, fact_id, conflict, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                              (*key, winner["session_id"], winner["harness"], winner["source"], winner["fact_id"], conflict, now))
            self.event("bind", herdr_session=key[0], life=key[1], pane_id=key[2], before=None, after=winner["session_id"], source=winner["source"],
                       reason=reason, harness=winner["harness"], detail=detail, at=now)
        elif current["session_id"] != winner["session_id"]:
            self.conn.execute("UPDATE bindings SET valid_to = ?, end_reason = 'rebind' WHERE binding_id = ?", (now, current["binding_id"]))
            self.conn.execute("INSERT INTO bindings(herdr_session, life, pane_id, session_id, harness, source, fact_id, conflict, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                              (*key, winner["session_id"], winner["harness"], winner["source"], winner["fact_id"], conflict, now))
            self.event("rebind", herdr_session=key[0], life=key[1], pane_id=key[2], before=current["session_id"], after=winner["session_id"],
                       source=winner["source"], reason=reason, harness=winner["harness"], detail=detail, at=now)
        elif (current["source"], current["fact_id"], current["conflict"]) != (winner["source"], winner["fact_id"], conflict):
            self.conn.execute("UPDATE bindings SET source = ?, fact_id = ?, conflict = ? WHERE binding_id = ?", (winner["source"], winner["fact_id"], conflict, current["binding_id"]))

    def expire_all(self, key, reason: str, now: float, *, keep_identity: tuple | None = None) -> int:
        count = 0
        for fact in self.open_facts(key):
            if keep_identity is not None and (fact["pid"], fact["proc_start"]) == keep_identity:
                continue
            self.close_fact(fact["fact_id"], reason, now)
            count += 1
        return count

    # ---------------------------------------------------------------------------------------------------- one pane observed

    def cwd_candidate(self, harness: str, cwd: str | None) -> str | None:
        if not cwd:
            return None
        names = {cwd, os.path.realpath(cwd)}
        marks = ",".join("?" * len(names))
        row = self.conn.execute(
            f"SELECT session_id FROM sessions WHERE harness = ? AND kind = 'session' AND cwd IN ({marks}) ORDER BY COALESCE(last_at, 0) DESC LIMIT 1",
            (harness, *names)).fetchone()
        return row[0] if row else None

    def observe_pane(self, name: str, life: str, pane: dict, info: dict | None, tabs: dict | None = None, *, created: bool = False,
                     now: float | None = None, read_info: bool = True) -> None:
        """Take one pane as it is now: its row, the foreground harness process, its facts and its binding. One transaction.

        <info> is `herdr pane process-info`'s answer. When Herdr was asked and did not answer (<read_info> False), what the pane's
        foreground is stays unknown: the pane's own fields are updated and no fact is expired, so a failed read never unbinds a pane."""
        now = self.clock() if now is None else now
        key = (name, life, pane["pane_id"])
        agent_session = pane.get("agent_session") if isinstance(pane.get("agent_session"), dict) else {}
        herdr_value = agent_session.get("value") if isinstance(agent_session.get("value"), str) and agent_session.get("value") else None
        fg = foreground_harness(info, pane.get("agent")) if read_info else None
        fg_start = self.start_of(fg["pid"]) if fg else None
        if fg and fg_start is None:
            fg = None  # the process is gone already
        new_identity = (fg["pid"], fg_start) if fg else (None, None)
        with db.transaction(self.conn):
            row = self.conn.execute("SELECT * FROM panes WHERE herdr_session = ? AND life = ? AND pane_id = ?", key).fetchone()
            if not read_info and row is not None:
                new_identity, fg = (row["fg_pid"], row["fg_proc_start"]), None  # unknown, so unchanged
                self.conn.execute("UPDATE panes SET tab_id = ?, label = COALESCE(?, label), title = ?, cwd = ?, agent = ?, agent_status = ?, last_seen = ? "
                                  "WHERE herdr_session = ? AND life = ? AND pane_id = ?",
                                  (pane.get("tab_id"), pane.get("label"), pane.get("terminal_title_stripped"), pane.get("cwd"), pane.get("agent"), pane.get("agent_status"), now, *key))
                return
            label = pane.get("label") or (tabs or {}).get(pane.get("tab_id")) or pane.get("terminal_title_stripped")
            if row is None:
                self.conn.execute(
                    "INSERT INTO panes(herdr_session, life, pane_id, terminal_id, tab_id, workspace_id, label, title, cwd, agent, agent_status, herdr_value, "
                    "herdr_value_source, fg_pid, fg_proc_start, fg_harness, fg_cwd, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (*key, pane.get("terminal_id"), pane.get("tab_id"), pane.get("workspace_id"), label, pane.get("terminal_title_stripped"), pane.get("cwd"),
                     pane.get("agent"), pane.get("agent_status"), herdr_value, agent_session.get("source"), new_identity[0], new_identity[1],
                     fg["harness"] if fg else None, fg["cwd"] if fg else None, now, now))
                self.event("pane_created" if created else "pane_seen", herdr_session=name, life=life, pane_id=pane["pane_id"], harness=pane.get("agent"),
                           detail={"terminal_id": pane.get("terminal_id")}, at=now)
                prev_identity, prev_harness, prev_value = (None, None), None, None
            else:
                prev_identity, prev_harness, prev_value = (row["fg_pid"], row["fg_proc_start"]), row["fg_harness"], row["herdr_value"]
                if row["closed_at"] is not None:
                    self.conn.execute("UPDATE panes SET closed_at = NULL, close_reason = NULL WHERE herdr_session = ? AND life = ? AND pane_id = ?", key)
                self.conn.execute(
                    "UPDATE panes SET terminal_id = COALESCE(?, terminal_id), tab_id = ?, workspace_id = ?, label = ?, title = ?, cwd = ?, agent = ?, agent_status = ?, "
                    "herdr_value = ?, herdr_value_source = ?, fg_pid = ?, fg_proc_start = ?, fg_harness = ?, fg_cwd = ?, last_seen = ? "
                    "WHERE herdr_session = ? AND life = ? AND pane_id = ?",
                    (pane.get("terminal_id"), pane.get("tab_id"), pane.get("workspace_id"), label, pane.get("terminal_title_stripped"), pane.get("cwd"), pane.get("agent"),
                     pane.get("agent_status"), herdr_value, agent_session.get("source"), new_identity[0], new_identity[1], fg["harness"] if fg else None,
                     fg["cwd"] if fg else None, now, *key))
            fg_changed = prev_identity != new_identity
            reason = "observed"
            detail: dict = {}
            if fg_changed:
                expired = self.expire_all(key, "foreground_changed", now, keep_identity=new_identity if fg else None)
                if prev_harness and not fg:
                    self.event("foreground_changed", herdr_session=name, life=life, pane_id=pane["pane_id"], reason="harness_left_foreground", harness=prev_harness,
                               detail={"to": "shell", "was_pid": prev_identity[0]}, at=now)
                    reason = "harness_left_foreground"
                elif fg and not prev_harness:
                    self.event("foreground_changed", herdr_session=name, life=life, pane_id=pane["pane_id"], reason="harness_entered_foreground", harness=fg["harness"],
                               detail={"pid": fg["pid"]}, at=now)
                    reason = "harness_entered_foreground"
                elif fg and prev_harness:
                    self.event("process_restart", herdr_session=name, life=life, pane_id=pane["pane_id"], reason="harness_pid_changed", harness=fg["harness"],
                               detail={"was_pid": prev_identity[0], "pid": fg["pid"], "was_harness": prev_harness}, at=now)
                    reason = "new_process"
                detail = {"expired_facts": expired}
            if fg:
                self.refresh_facts(key, pane, fg, fg_start, herdr_value, prev_value, fg_changed and row is not None, now)
            self.resolve(key, now, reason, fg["harness"] if fg else prev_harness, detail)

    def refresh_facts(self, key, pane: dict, fg: dict, fg_start: str | None, herdr_value: str | None, prev_value: str | None, process_changed: bool, now: float) -> None:
        identity = (fg["pid"], fg_start)
        open_facts = self.open_facts(key)
        # 1. the harness's own pid record
        self.ensure_records()
        record = self.pid_records.records.get(fg["pid"]) if fg["harness"] == "claude" else None
        current = next((f for f in open_facts if f["source"] == "pid_record"), None)
        usable = record is not None and (not record.get("proc_start") or same_start(record.get("proc_start"), fg_start))
        if current and (not usable or current["session_id"] != record["session_id"] or (current["pid"], current["proc_start"]) != identity):
            self.close_fact(current["fact_id"], "new_pid_record" if usable else "record_gone", now)
            current = None
        if usable and current is None:
            self.open_fact(key, "pid_record", record["session_id"], "claude", fg["pid"], fg_start, {"record": record.get("path"), "cwd": record.get("cwd")}, now)
        # 2. Herdr's report, bound to this process
        report = next((f for f in open_facts if f["source"] == "herdr_report" and f["valid_to"] is None), None)
        if report and (report["session_id"] != herdr_value or (report["pid"], report["proc_start"]) != identity):
            self.close_fact(report["fact_id"], "superseded" if herdr_value else "report_gone", now)
            report = None
        if herdr_value and report is None:
            stale = process_changed and herdr_value == prev_value  # Herdr kept the id across a process change: not reported anew
            if not stale:
                self.open_fact(key, "herdr_report", herdr_value, fg["harness"], fg["pid"], fg_start, {"source": (pane.get("agent_session") or {}).get("source")}, now)
            else:
                self.event("fact_expired", herdr_session=key[0], life=key[1], pane_id=key[2], after=herdr_value, source="herdr_report", reason="stale_report_ignored",
                           harness=fg["harness"], detail={"pid": fg["pid"]}, at=now)
        # 3. the working-folder inference, for harnesses with no record of their own
        inferred = next((f for f in open_facts if f["source"] == "cwd_inference"), None)
        want = self.cwd_candidate(fg["harness"], fg.get("cwd")) if fg["harness"] in INFERRED_HARNESSES else None
        if inferred and (want != inferred["session_id"] or (inferred["pid"], inferred["proc_start"]) != identity):
            self.close_fact(inferred["fact_id"], "superseded", now)
            inferred = None
        if want and inferred is None:
            self.open_fact(key, "cwd_inference", want, fg["harness"], fg["pid"], fg_start, {"cwd": fg.get("cwd")}, now)

    # ---------------------------------------------------------------------------------------------------- closing and life

    def close_pane(self, key, reason: str, now: float) -> None:
        with db.transaction(self.conn):
            row = self.conn.execute("SELECT * FROM panes WHERE herdr_session = ? AND life = ? AND pane_id = ?", key).fetchone()
            if row is None or row["closed_at"] is not None:
                return
            self.expire_all(key, reason, now)
            self.conn.execute("UPDATE panes SET closed_at = ?, close_reason = ?, fg_pid = NULL, fg_proc_start = NULL WHERE herdr_session = ? AND life = ? AND pane_id = ?", (now, reason, *key))
            self.resolve(key, now, reason, row["fg_harness"])
            self.event("pane_closed", herdr_session=key[0], life=key[1], pane_id=key[2], reason=reason, harness=row["fg_harness"], at=now)

    def exit_pane(self, key, now: float) -> None:
        with db.transaction(self.conn):
            row = self.conn.execute("SELECT * FROM panes WHERE herdr_session = ? AND life = ? AND pane_id = ?", key).fetchone()
            if row is None:
                return
            self.expire_all(key, "pane_exited", now)
            self.conn.execute("UPDATE panes SET fg_pid = NULL, fg_proc_start = NULL, fg_harness = NULL WHERE herdr_session = ? AND life = ? AND pane_id = ?", key)
            self.event("pane_exited", herdr_session=key[0], life=key[1], pane_id=key[2], reason="pane_exited", harness=row["fg_harness"], at=now)
            self.resolve(key, now, "pane_exited", row["fg_harness"])

    def end_life(self, name: str, life: str, reason: str, now: float) -> None:
        """A Herdr session life that is over (the session was deleted and made again, or stopped): every fact of its panes expires."""
        with db.transaction(self.conn):
            panes = self.conn.execute("SELECT * FROM panes WHERE herdr_session = ? AND life = ? AND closed_at IS NULL", (name, life)).fetchall()
            for pane in panes:
                key = (name, life, pane["pane_id"])
                self.expire_all(key, reason, now)
                self.resolve(key, now, reason, pane["fg_harness"])
                if reason == "life_change":
                    self.conn.execute("UPDATE panes SET closed_at = ?, close_reason = ?, fg_pid = NULL, fg_proc_start = NULL WHERE herdr_session = ? AND life = ? AND pane_id = ?", (now, reason, *key))
                else:
                    self.conn.execute("UPDATE panes SET fg_pid = NULL, fg_proc_start = NULL, fg_harness = NULL WHERE herdr_session = ? AND life = ? AND pane_id = ?", key)
            self.conn.execute("UPDATE herdr_lives SET ended_at = ? WHERE herdr_session = ? AND life = ? AND ended_at IS NULL", (now, name, life))
            self.event("life_change" if reason == "life_change" else "herdr_stopped", herdr_session=name, life=life, reason=reason, detail={"panes": len(panes)}, at=now)

    # ---------------------------------------------------------------------------------------------------------- reconcile

    def reconcile(self, only: str | None = None) -> dict:
        """Read the whole Herdr inventory and bring the store to it. Safe to run any time; every change it makes is an event."""
        now = self.clock()
        stats = {"sessions": 0, "panes": 0, "closed": 0, "unreadable": 0}
        listing = self.client.sessions()
        if listing is None:
            with db.transaction(self.conn):
                self.event("reconcile", reason="herdr_unreachable", at=now)
            return {**stats, "unreachable": True}
        running = {s["name"]: s for s in listing}
        for name, item in running.items():
            if only and name != only:
                continue
            life = item["life"]
            lives = self.conn.execute("SELECT * FROM herdr_lives WHERE herdr_session = ? ORDER BY first_seen DESC", (name,)).fetchall()
            latest = lives[0] if lives else None
            if latest and latest["life"] != life and latest["ended_at"] is None:
                self.end_life(name, latest["life"], "life_change", now)
            if latest is None or latest["life"] != life:
                with db.transaction(self.conn):
                    self.conn.execute("INSERT OR IGNORE INTO herdr_lives(herdr_session, life, first_seen, last_seen, session_dir, socket_path) VALUES (?, ?, ?, ?, ?, ?)",
                                      (name, life, now, now, item.get("session_dir"), item.get("socket_path")))
            elif latest["ended_at"] is not None:
                with db.transaction(self.conn):
                    self.conn.execute("UPDATE herdr_lives SET ended_at = NULL, last_seen = ? WHERE herdr_session = ? AND life = ?", (now, name, life))
                    self.event("herdr_started", herdr_session=name, life=life, reason="session_running_again", at=now)
            else:
                self.conn.execute("UPDATE herdr_lives SET last_seen = ? WHERE herdr_session = ? AND life = ?", (now, name, life))
            panes = self.client.panes(name)
            if panes is None:
                stats["unreadable"] += 1
                continue
            stats["sessions"] += 1
            tab_labels = {tab.get("tab_id"): tab.get("label") or "" for tab in self.client.tabs(name)}
            present = set()
            self.pid_records.poll()
            self.records_at = self.clock()
            for pane in panes:
                if not pane.get("pane_id"):
                    continue
                present.add(pane["pane_id"])
                known = self.conn.execute("SELECT fg_pid FROM panes WHERE herdr_session = ? AND life = ? AND pane_id = ?", (name, life, pane["pane_id"])).fetchone()
                needs_info = bool(pane.get("agent") or (pane.get("agent_session") or {}).get("value") or (known and known["fg_pid"]))
                info = self.client.process_info(name, pane["pane_id"]) if needs_info else None
                self.observe_pane(name, life, pane, info, tab_labels, now=self.clock(), read_info=info is not None or not needs_info)
                stats["panes"] += 1
            for row in self.conn.execute("SELECT pane_id FROM panes WHERE herdr_session = ? AND life = ? AND closed_at IS NULL", (name, life)).fetchall():
                if row["pane_id"] not in present:
                    self.close_pane((name, life, row["pane_id"]), "pane_closed", self.clock())
                    stats["closed"] += 1
        for life_row in self.conn.execute("SELECT * FROM herdr_lives WHERE ended_at IS NULL").fetchall():
            if (only is None or life_row["herdr_session"] == only) and life_row["herdr_session"] not in running:
                self.end_life(life_row["herdr_session"], life_row["life"], "herdr_stopped", now)
        return stats

    # -------------------------------------------------------------------------------------------------------------- events

    def on_item(self, item: tuple) -> None:
        """One item from the subscription queue."""
        tag, name, life = item[0], item[1], item[2]
        now = self.clock()
        if tag == "lost":
            with db.transaction(self.conn):
                self.event("events_lost", herdr_session=name, life=life, reason=str(item[3]), at=now)
            self.reconcile(only=name)
            return
        if tag == "started":
            return
        if tag != "event":
            return
        kind, data = item[3], item[4] if isinstance(item[4], dict) else {}
        pane = data.get("pane") if isinstance(data.get("pane"), dict) else {}
        pane_id = data.get("pane_id") or pane.get("pane_id")
        if not pane_id:
            return
        key = (name, life, pane_id)
        if kind == "pane.closed":
            self.close_pane(key, "pane_closed", now)
        elif kind == "pane.exited":
            self.exit_pane(key, now)
            self.dirty.add((name, pane_id))
        elif kind in ("pane.created", "pane.updated", "pane.agent_detected", "pane.moved"):
            self.dirty.add((name, pane_id))
            if kind == "pane.created":
                self.created.add(key)

    def process_dirty(self) -> int:
        """Read again every pane an event named (one `pane list` per Herdr session, one `process-info` per pane)."""
        if not self.dirty:
            return 0
        dirty, self.dirty = self.dirty, set()
        by_session: dict[str, set[str]] = {}
        for name, pane_id in dirty:
            by_session.setdefault(name, set()).add(pane_id)
        count = 0
        listing = {s["name"]: s for s in (self.client.sessions() or [])}
        for name, pane_ids in by_session.items():
            if name not in listing:
                continue
            life = listing[name]["life"]
            panes = self.client.panes(name)
            if panes is None:
                self.dirty |= {(name, pid) for pid in pane_ids}
                continue
            by_id = {p.get("pane_id"): p for p in panes}
            tab_labels = {tab.get("tab_id"): tab.get("label") or "" for tab in self.client.tabs(name)}
            self.pid_records.poll()
            for pane_id in pane_ids:
                pane = by_id.get(pane_id)
                if pane is None:
                    self.close_pane((name, life, pane_id), "pane_closed", self.clock())
                    continue
                info = self.client.process_info(name, pane_id)
                created = (name, life, pane_id) in self.created
                self.created.discard((name, life, pane_id))
                self.observe_pane(name, life, pane, info, tab_labels, created=created, read_info=info is not None)
                count += 1
        return count

    # ------------------------------------------------------------------------------------------------------ pid record watch

    def poll_pid_records(self) -> int:
        """The identity event source that needs no Herdr call: a pid record that appeared, changed (a /clear) or went away re-resolves the
        panes whose harness process it names; a process that is no longer alive expires its facts."""
        now = self.clock()
        _, changed = self.pid_records.poll()
        self.records_at = now
        count = 0
        panes = self.conn.execute("SELECT * FROM panes WHERE closed_at IS NULL AND fg_pid IS NOT NULL").fetchall()
        for row in panes:
            key = (row["herdr_session"], row["life"], row["pane_id"])
            if not self.process_is(row["fg_pid"], row["fg_proc_start"]):
                with db.transaction(self.conn):
                    self.expire_all(key, "process_exited", now)
                    self.conn.execute("UPDATE panes SET fg_pid = NULL, fg_proc_start = NULL, fg_harness = NULL WHERE herdr_session = ? AND life = ? AND pane_id = ?", key)
                    self.event("foreground_changed", herdr_session=key[0], life=key[1], pane_id=key[2], reason="process_exited", harness=row["fg_harness"],
                               detail={"was_pid": row["fg_pid"]}, at=now)
                    self.resolve(key, now, "process_exited", row["fg_harness"])
                count += 1
                continue
            if row["fg_pid"] in changed and row["fg_harness"] == "claude":
                fg = {"pid": row["fg_pid"], "harness": "claude", "cwd": row["fg_cwd"]}
                pane = {"agent_session": {"value": row["herdr_value"], "source": row["herdr_value_source"]}}
                with db.transaction(self.conn):
                    self.refresh_facts(key, pane, fg, row["fg_proc_start"], row["herdr_value"], row["herdr_value"], False, now)
                    self.resolve(key, now, "new_pid_record", "claude", {"pid": row["fg_pid"]})
                count += 1
        return count

    # --------------------------------------------------------------------------------------------------------------- links

    def infer_links(self) -> int:
        """Links between the sessions one pane ran in turn: a rebind inside one process is a /clear when the new session opens with the
        /clear command, otherwise a pane_successor; a process restart that lands on a known session is a pane_successor too.
        Inferred, and labelled so (resume, compact and fork stay unknown unless a hook says: README)."""
        now = self.clock()
        made = 0
        rows = self.conn.execute(
            "SELECT * FROM identity_events WHERE kind IN ('rebind', 'bind') AND before_session IS NOT NULL AND after_session IS NOT NULL").fetchall()
        for row in rows:
            before, after = row["before_session"], row["after_session"]
            if before == after:
                continue
            exists = self.conn.execute("SELECT 1 FROM sessions WHERE session_id = ?", (after,)).fetchone()
            if not exists:
                continue
            cleared = self.conn.execute(
                "SELECT 1 FROM events WHERE session_id = ? AND role = 'user' AND text LIKE '%<command-name>/clear</command-name>%' ORDER BY offset LIMIT 1", (after,)).fetchone()
            kind = "clear" if cleared else "pane_successor"
            cursor = self.conn.execute("INSERT OR IGNORE INTO links(from_session, to_session, kind, basis, evidence, at) VALUES (?, ?, ?, 'inferred', ?, ?)",
                                       (before, after, kind, json.dumps({"pane": row["pane_id"], "herdr": row["herdr_session"], "event": row["event_id"]}), now))
            made += cursor.rowcount
        return made
