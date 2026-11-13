"""Where Claude keeps a session, and how a pane's session is resumed under the account it was started with.

Claude keeps one account's session logs, pid records and settings in one config folder: `~/.claude` by default, and
whatever `CLAUDE_CONFIG_DIR` names for another account (a second account such as `~/.claude-personal`). Herdr does not say
which folder a pane's Claude uses, so every lookup of a session, from the identity verifier, the agent session registry
and the workspace organizer, goes through this one module. It finds the folders, the folder a session lives in, the folder
a running process wrote its pid record to, and the command that resumes a session under the right folder.

Nothing here reads conversation text: it looks only at file names and at the session id, cwd and start marker that a pid
record carries.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

SESSION_ID_FILE = re.compile(r"^[0-9a-fA-F-]{36}$")


def default_config_dir() -> Path:
    """The folder Claude uses when `CLAUDE_CONFIG_DIR` is not set."""
    return Path.home() / ".claude"


def own_config_dir() -> Path:
    """The folder this process's own `CLAUDE_CONFIG_DIR` names, or the default one."""
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or str(default_config_dir())).expanduser()


def claude_config_dirs(own: Path | None = None) -> list[Path]:
    """Every Claude config folder, in the order a lookup tries them: `own` (this process's own folder, `own_config_dir()`
    by default), then ~/.claude, then each other ~/.claude<anything> folder by name, then the folder CLAUDE_CONFIG_DIR names.
    Only a folder that holds a projects/ folder counts, so a plain file such as ~/.claude.json and a tool's own
    ~/.claude-xyz folder are left out; no account name is known here, so a new account is found by the next lookup. This is
    the transcript reader's rule (pmos setup/transcript-reader: otherClaudeHomes)."""
    home = Path.home()
    candidates = [own if own is not None else own_config_dir(), home / ".claude"]
    try:
        candidates += sorted((entry for entry in home.iterdir() if entry.name.startswith(".claude")), key=lambda entry: entry.name)
    except OSError:
        pass
    named = os.environ.get("CLAUDE_CONFIG_DIR", "")
    if named:
        candidates.append(Path(named).expanduser())
    found: list[Path] = []
    seen: set[Path] = set()
    for folder in candidates:
        projects = folder / "projects"
        if not folder.is_absolute() or not projects.is_dir():
            continue
        real = Path(os.path.realpath(projects))
        if real not in seen:
            seen.add(real)
            found.append(folder)
    return found


def claude_projects_dirs(own: Path | None = None) -> list[Path]:
    """The projects/ folder of every config folder `claude_config_dirs` finds."""
    return [folder / "projects" for folder in claude_config_dirs(own)]


def is_default_config_dir(folder: object) -> bool:
    """Whether `folder` is the folder Claude uses with no `CLAUDE_CONFIG_DIR` (the same folder through a link counts)."""
    if not isinstance(folder, (str, Path)) or not str(folder):
        return False
    return os.path.realpath(Path(folder).expanduser()) == os.path.realpath(default_config_dir())


def config_dir_field(folder: object) -> str | None:
    """What a registry record or an archive stores for a config folder: its absolute path, and nothing for the default
    folder, so a record of the default account is written exactly as it always was."""
    if not isinstance(folder, (str, Path)) or not str(folder).strip():
        return None
    path = Path(folder).expanduser()
    if not path.is_absolute() or is_default_config_dir(path):
        return None
    return str(path)


def claude_resume_command(session_id: str, config_dir: object = None) -> str:
    """The command that resumes a Claude session under the config folder it was started with. The default folder needs
    nothing; another one is named with the same `CLAUDE_CONFIG_DIR` the session was started with, because a resume under
    another account would start there and not find the session."""
    command = f"claude --resume {shlex.quote(session_id)}"
    field = config_dir_field(config_dir)
    return f"CLAUDE_CONFIG_DIR={shlex.quote(field)} {command}" if field else command


def session_config_dirs(session_id: object, own: Path | None = None) -> list[Path]:
    """Every config folder that holds a log for this Claude session, in lookup order."""
    if not isinstance(session_id, str) or not SESSION_ID_FILE.match(session_id):
        return []
    found: list[Path] = []
    for folder in claude_config_dirs(own):
        projects = folder / "projects"
        if any(projects.rglob(f"{session_id}.jsonl")):
            found.append(folder)
    return found


def session_config_dir(session_id: object, prefer: object = None, own: Path | None = None) -> Path | None:
    """The config folder a Claude session lives in: `prefer` when it holds the session (the folder a process's own pid
    record was found in), otherwise the first folder in lookup order, so a copy of a log in a later folder never shadows
    the usual one."""
    homes = session_config_dirs(session_id, own)
    if prefer is not None:
        wanted = os.path.realpath(Path(str(prefer)).expanduser())
        for folder in homes:
            if os.path.realpath(folder) == wanted:
                return folder
    return homes[0] if homes else None


def claude_session_exists(session_id: object, own: Path | None = None) -> bool:
    return bool(session_config_dirs(session_id, own))


def process_start_utc(pid: int) -> str | None:
    """The start of a process as Claude writes it in a pid record's `procStart`: `ps -o lstart=` in UTC, whatever the time
    zone of this machine (a record written on a UTC+7 machine says 07:09 for a process `ps` lists at 14:09)."""
    if sys.platform.startswith("linux"):
        return None
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, check=False, timeout=5,
            env={**os.environ, "TZ": "UTC"},
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = result.stdout.strip()
    return value or None


def pid_session_records(pid: int, own: Path | None = None) -> list[tuple[Path, dict[str, Any]]]:
    """(config folder, pid record) for each config folder with a `sessions/<pid>.json` that describes this live process.
    A pid is only unique among running processes, so an old record left under another folder by an earlier process with
    the same pid is dropped when it carries the start marker of a different process."""
    found: list[tuple[Path, dict[str, Any]]] = []
    live_start: str | None | bool = False  # False: not asked yet
    for folder in claude_config_dirs(own):
        try:
            record = json.loads((folder / "sessions" / f"{pid}.json").read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(record, dict):
            continue
        if isinstance(record.get("pid"), int) and record["pid"] != pid:
            continue
        marker = record.get("procStart")
        if isinstance(marker, str) and marker:
            if live_start is False:
                live_start = process_start_utc(pid)
            if live_start and marker != live_start:
                continue
        found.append((folder, record))
    return found
