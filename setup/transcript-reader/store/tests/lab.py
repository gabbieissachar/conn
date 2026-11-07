"""A Herdr lab for the identity tests: a fake Herdr world, fake processes, and pid records, all under temporary folders."""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from fake_herdr import FakeHerdrServer  # noqa: E402
from rstore import herdr as herdr_mod  # noqa: E402


class Lab:
    """Panes and processes the test controls. `start`/`stop` stand for processes (the store asks `alive` and `proc_start`)."""

    def __init__(self, home: Path):
        self.home = Path(home)
        self.dir = Path(tempfile.mkdtemp(prefix="rs"))
        self.world_file = self.dir / "world.json"
        self.world: dict = {"sessions": []}
        self.starts: dict[int, str] = {}
        self.server = FakeHerdrServer()
        shim = self.dir / "herdr"
        shim.write_text(f"#!/bin/sh\nexec {sys.executable} {HERE / 'fake_herdr.py'} \"$@\"\n", encoding="utf-8")
        shim.chmod(shim.stat().st_mode | stat.S_IXUSR)
        self.shim = shim
        self.save()

    # -------------------------------------------------------------------------------------------------------- the world

    def client(self) -> herdr_mod.HerdrClient:
        return herdr_mod.HerdrClient(bin=str(self.shim), env={**os.environ, "FAKE_HERDR_WORLD": str(self.world_file)})

    def save(self) -> None:
        partial = self.world_file.with_suffix(".partial")
        partial.write_text(json.dumps(self.world), encoding="utf-8")
        os.replace(partial, self.world_file)

    def session(self, name: str, serve: bool = False) -> dict:
        folder = self.dir / name
        folder.mkdir(exist_ok=True)
        entry = {"name": name, "dir": str(folder), "socket": str(folder / "h.sock"), "running": True, "tabs": [], "panes": []}
        self.world["sessions"].append(entry)
        if serve:
            self.server.start(name, entry["socket"])
        self.save()
        return entry

    def get(self, name: str) -> dict:
        return next(s for s in self.world["sessions"] if s["name"] == name)

    def pane(self, session: str, pane_id: str, *, agent=None, agent_session=None, cwd="/work", pid=None, harness="claude", terminal_id=None,
             label=None, status="idle") -> dict:
        entry = {"pane_id": pane_id, "tab_id": "w1:t1", "terminal_id": terminal_id or f"term_{session}_{pane_id}", "label": label, "agent": agent,
                 "agent_status": status, "agent_session": agent_session, "title": label or pane_id, "cwd": cwd, "fgpg": pid, "process": []}
        if pid is not None:
            entry["process"] = [self.process(pid, harness, cwd)]
        self.get(session)["panes"].append(entry)
        self.save()
        return entry

    def process(self, pid: int, harness: str, cwd: str = "/work") -> dict:
        self.start(pid)
        names = {"claude": ("claude", "2.1.0"), "codex": ("codex", "codex"), "copilot": ("copilot", "copilot"), "pi": ("pi", "pi"), "shell": ("zsh", "zsh")}
        argv0, name = names[harness]
        return {"pid": pid, "argv0": argv0, "name": name, "cwd": cwd, "cmdline": argv0}

    def find(self, session: str, pane_id: str) -> dict:
        return next(p for p in self.get(session)["panes"] if p["pane_id"] == pane_id)

    def set_foreground(self, session: str, pane_id: str, pid: int | None, harness: str = "claude", cwd: str = "/work") -> None:
        pane = self.find(session, pane_id)
        pane["fgpg"] = pid
        pane["process"] = [self.process(pid, harness, cwd)] if pid is not None else []
        self.save()

    def remove_pane(self, session: str, pane_id: str) -> None:
        self.get(session)["panes"] = [p for p in self.get(session)["panes"] if p["pane_id"] != pane_id]
        self.save()

    # ---------------------------------------------------------------------------------------------------- processes

    def start(self, pid: int) -> str:
        self.starts.setdefault(pid, f"Sat Nov  7 10:{pid % 60:02d}:00 2026")
        return self.starts[pid]

    def stop(self, pid: int) -> None:
        self.starts.pop(pid, None)

    def restart(self, pid: int) -> None:
        """A new process with the same pid number: another start time."""
        self.starts[pid] = self.starts.get(pid, "") + "'"

    def alive(self, pid: int) -> bool:
        return pid in self.starts

    def proc_start(self, pid: int) -> str | None:
        return self.starts.get(pid)

    # ------------------------------------------------------------------------------------------------------ pid records

    def pid_record(self, pid: int, session_id: str, folder: str = ".claude", cwd: str = "/work", proc_start: str | None = None) -> Path:
        path = self.home / folder / "sessions" / f"{pid}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {"pid": pid, "sessionId": session_id, "cwd": cwd, "procStart": proc_start if proc_start is not None else self.start(pid), "kind": "interactive"}
        path.write_text(json.dumps(record), encoding="utf-8")
        os.utime(path, (os.stat(path).st_atime, os.stat(path).st_mtime + 1))  # a change shows even within one clock tick
        return path

    def clear_pid_record(self, pid: int, folder: str = ".claude") -> None:
        path = self.home / folder / "sessions" / f"{pid}.json"
        os.replace(path, path.with_name(f"moved-{pid}.txt"))

    def close(self) -> None:
        self.server.stop()
