"""The board's sessions: which Firstmate homes have a board, where each home is, and where the Firstmate scripts are.

A board belongs to one session (ledger X6, revised): big-boss and each leader. The defaults come from the machine, never from a path
written in this repository: big-boss is the main home (`FM_MAIN_HOME`, else ~/fm-homes/pmos), a leader's home is the `(home: ...)` its
registry line in the main home's data/secondmates.md names (the same registry the reader's page build uses), and the Firstmate scripts are
found from the installed `fm-ask` link (or `FM_ROOT`). `~/.config/pmos-transcript-reader/board.json` (`PMOS_READER_BOARD_CONFIG` moves it)
overrides any of it:

    {"fm_root": "<a Firstmate checkout>",
     "sessions": [{"id": "leader-esim", "label": "eSIM", "home": "<path>", "lifecycle": "pm", "root": "<optional scripts root>"}]}

`sessions` replaces the defaults whole. Worker boards (slice 7) add `workers` entries the same way; see workers.py.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_NAME = "board.json"

# Registry name -> (session id, label, default lifecycle). A secondmate not listed here gets no board unless the config adds it.
KNOWN_LEADERS = {
    "secondmate-workspaceos-firstmate": ("leader-workspaceos", "workspaceOS", "software"),
    "secondmate-esim": ("leader-esim", "eSIM", "pm"),
    "secondmate-nip": ("leader-nip", "NIP", "integration"),
}
BIG_BOSS = ("big-boss", "big-boss", "fleet")


@dataclass
class Session:
    id: str
    label: str
    home: Path
    lifecycle: str = "software"
    root: Path | None = None  # the Firstmate checkout whose bin/ is run for this home; None = the shared one
    kind: str = "leader"  # big-boss | leader | worker
    parent: str | None = None  # a worker's leader
    task: str | None = None  # a worker's task id

    def public(self) -> dict:
        return {"id": self.id, "label": self.label, "lifecycle": self.lifecycle, "kind": self.kind, "parent": self.parent, "task": self.task}


@dataclass
class Registry:
    fm_root: Path | None
    sessions: list[Session] = field(default_factory=list)
    source: str = "defaults"
    error: str | None = None

    def get(self, session_id: str) -> Session | None:
        return next((s for s in self.sessions if s.id == session_id), None)


def config_path() -> Path:
    explicit = os.environ.get("PMOS_READER_BOARD_CONFIG")
    return Path(explicit).expanduser() if explicit else Path.home() / ".config" / "pmos-transcript-reader" / CONFIG_NAME


def main_home() -> Path:
    return Path(os.environ.get("FM_MAIN_HOME") or (Path.home() / "fm-homes" / "pmos")).expanduser()


def find_fm_root() -> Path | None:
    """The Firstmate checkout whose scripts the board runs: FM_ROOT, else where the installed fm-ask link points."""
    explicit = os.environ.get("FM_ROOT")
    candidates = [Path(explicit).expanduser()] if explicit else []
    link = shutil.which("fm-ask")
    if link:
        candidates.append(Path(os.path.realpath(link)).parent.parent)
    for root in candidates:
        if (root / "bin" / "fm-fleet-snapshot.sh").is_file():
            return root
    return None


def registered_secondmates(home: Path) -> list[tuple[str, Path]]:
    registry = home / "data" / "secondmates.md"
    try:
        lines = registry.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        name = re.match(r"^- (\S+) - ", line)
        path = re.search(r"\(home: ([^;)]+)", line)
        if name and path:
            out.append((name.group(1), Path(path.group(1).strip()).expanduser()))
    return out


def default_sessions() -> list[Session]:
    main = main_home()
    sessions = [Session(BIG_BOSS[0], BIG_BOSS[1], main, BIG_BOSS[2], kind="big-boss")]
    for name, home in registered_secondmates(main):
        if name in KNOWN_LEADERS:
            sid, label, lifecycle = KNOWN_LEADERS[name]
            sessions.append(Session(sid, label, home, lifecycle))
    return sessions


def load(path: Path | None = None) -> Registry:
    path = path or config_path()
    registry = Registry(fm_root=find_fm_root(), sessions=default_sessions())
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return registry
    except OSError as error:
        registry.error = f"board config unreadable ({error.strerror or error.__class__.__name__})"
        return registry
    try:
        config = json.loads(raw)
        if not isinstance(config, dict):
            raise ValueError("not an object")
        root = config.get("fm_root")
        if root is not None:
            if not isinstance(root, str) or not (Path(root).expanduser() / "bin" / "fm-fleet-snapshot.sh").is_file():
                raise ValueError("fm_root has no bin/fm-fleet-snapshot.sh")
            registry.fm_root = Path(root).expanduser()
        listed = config.get("sessions")
        if listed is not None:
            if not isinstance(listed, list) or not listed:
                raise ValueError("sessions must be a non-empty list")
            sessions, seen = [], set()
            for entry in listed:
                sid, home = entry.get("id"), entry.get("home")
                if not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", sid) or sid in seen or not isinstance(home, str):
                    raise ValueError("each session needs a unique id and a home")
                seen.add(sid)
                own_root = entry.get("root")
                sessions.append(Session(sid, str(entry.get("label") or sid)[:60], Path(home).expanduser(), str(entry.get("lifecycle") or "software"),
                                        Path(own_root).expanduser() if isinstance(own_root, str) else None, kind=str(entry.get("kind") or "leader")))
            registry.sessions = sessions
        registry.source = str(path)
    except (ValueError, AttributeError, TypeError) as error:
        registry.error = f"board config ignored: {error}"
    return registry
