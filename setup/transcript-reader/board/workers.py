"""Worker boards (slice 7, W1 = a): a worker you drive directly gets a board of its own, with an on/off switch.

A worker is one a leader marked captain-driven (the snapshot's task row has a `driver`). Its board is the leader's own data narrowed to what that
worker raised: its task, the calls held for you whose origin is that task, and tasks it blocks. It inherits the leader's lifecycle and Firstmate
home (the scripts and the backlog are the leader's), and its transcript is the worker's own session folder (the task's worktree), where every
reply is to you, so each reply is on the worker's card by construction.

Two small files of the reader's own (never a Firstmate home's):
  board-cache/drivers/<leader>.json   which tasks each leader's last board build saw as captain-driven (where the page finds a worker to offer)
  board-workers.json                  your switches: {"on": {"<leader>/<task>": true|false}}; a driven worker is on until you switch it off
(`PMOS_READER_BOARD_WORKERS` moves the second).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

from . import collect, homes

FILE = "board-workers.json"
TASK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$")
LEADER = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
SESSION_PREFIX = "worker-"


def switches_path() -> Path:
    explicit = os.environ.get("PMOS_READER_BOARD_WORKERS")
    return Path(explicit).expanduser() if explicit else homes.config_path().parent / FILE


def drivers_path(leader: str) -> Path:
    return collect.cache_dir() / "drivers" / f"{leader}.json"


def read_switches() -> dict:
    try:
        data = json.loads(switches_path().read_text(encoding="utf-8"))
        on = data.get("on")
        return {k: v for k, v in on.items() if isinstance(k, str) and isinstance(v, bool)} if isinstance(on, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def note_drivers(leader: str, snapshot: dict) -> None:
    """Remember which of a leader's tasks are captain-driven, for the page's list of worker boards. Best effort: a cache that cannot be written is skipped."""
    found = []
    for task in (snapshot or {}).get("tasks") or []:
        if not isinstance(task, dict) or not task.get("driver") or not TASK.match(task.get("id") or ""):
            continue
        worktree = (((task.get("paths") or {}).get("worktree")) or {}).get("path")
        found.append({"task": task["id"], "kind": task.get("kind"), "worktree": worktree if isinstance(worktree, str) else None,
                      "since": (task.get("driver") or {}).get("since")})
    path = drivers_path(leader)
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".drivers-")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"leader": leader, "drivers": found}, handle)
        os.replace(tmp, path)
    except OSError:
        pass


def known_drivers(leader: str) -> list[dict]:
    try:
        data = json.loads(drivers_path(leader).read_text(encoding="utf-8"))
        return [d for d in data.get("drivers") or [] if isinstance(d, dict) and TASK.match(d.get("task") or "")]
    except (OSError, ValueError, AttributeError):
        return []


def worker_sessions(registry: homes.Registry, include_off: bool = False) -> list[tuple[homes.Session, bool]]:
    """(session, enabled) for each captain-driven worker the leaders' last builds saw; off ones only when asked for (the page's switch list)."""
    switches = read_switches()
    out = []
    for leader in registry.sessions:
        if leader.kind == "worker":
            continue
        for driver in known_drivers(leader.id):
            enabled = switches.get(f"{leader.id}/{driver['task']}", True)
            if not enabled and not include_off:
                continue
            cwds = [driver["worktree"]] if driver.get("worktree") else []
            out.append((homes.Session(SESSION_PREFIX + driver["task"], driver["task"], leader.home, leader.lifecycle, leader.root, kind="worker", parent=leader.id,
                                      task=driver["task"], cwds=cwds), enabled))
    return out


def set_switch(registry: homes.Registry, leader: str, task: str, enabled: bool) -> dict:
    """Turn one worker's board on or off. Only a captain-driven worker some leader's build has seen can be switched."""
    if not LEADER.match(leader or "") or not TASK.match(task or "") or registry.get(leader) is None:
        raise ValueError("unknown session")
    if not any(d["task"] == task for d in known_drivers(leader)):
        raise ValueError("that worker is not one you drive")
    switches = read_switches()
    switches[f"{leader}/{task}"] = bool(enabled)
    path = switches_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".workers-")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump({"on": switches}, handle, sort_keys=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return {"leader": leader, "task": task, "enabled": bool(enabled)}


def related(item: dict, task: str) -> bool:
    """Whether a card is something this worker raised: its own task, a call whose origin is it, or a task it blocks."""
    return item["ref"] == task or item.get("origin") == task or task in (item.get("blocked_by") or [])
