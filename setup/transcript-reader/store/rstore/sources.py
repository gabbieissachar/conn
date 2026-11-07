"""Finding the logs: every harness's session files on this machine, and the scope rules that label or skip them.

W2 = everything: the default policy indexes every session, including the personal Claude account and personal-work, plus Pi. The
policy is a setting so the answer can change; a skip is always counted, never silent (counters: skipped_source).

Log locations (each relative to the home folder, which a test replaces):
  Claude   <config folder>/projects/<project>/<session>.jsonl, and .../<session>/subagents/agent-<id>.jsonl, for ~/.claude and every
           other ~/.claude* folder that holds a projects/ or sessions/ folder (the reader's rule, claude-homes.js)
  Codex    ~/.codex/sessions/<y>/<m>/<d>/rollout-<time>-<id>.jsonl
  Copilot  ~/.copilot/session-state/<id>/events.jsonl
  Pi       ~/.pi/agent/sessions/<project>/<time>_<id>.jsonl   (only that folder: ~/.pi also holds extensions' own benchmark files)
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from .config import Settings

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
UUID_RE = re.compile(f"^{UUID}$")
CODEX_ROLLOUT = re.compile(rf"^rollout-.*-({UUID})\.jsonl$")
PI_FILE = re.compile(r"^[^_]+_([0-9A-Za-z-]+)\.jsonl$")
HARNESSES = ("claude", "codex", "copilot", "pi")


@dataclass(frozen=True)
class SourceDesc:
    harness: str
    path: Path
    session_id: str
    home: str = ""
    kind: str = "session"
    parent_session_id: str | None = None
    home_label: str = "default"


def claude_homes(home_dir: Path, env: dict | None = None) -> list[Path]:
    """~/.claude first, then every other Claude config folder (claude-homes.js otherClaudeHomes: a ~/.claude<anything> folder counts
    when it holds a projects/ or sessions/ folder; CLAUDE_CONFIG_DIR and PMOS_READER_CLAUDE_HOMES add more)."""
    env = os.environ if env is None else env
    primary = home_dir / ".claude"
    found = [primary] if primary.is_dir() else []

    def add(folder: Path) -> None:
        if folder.is_absolute() and folder != primary and folder not in found and ((folder / "projects").is_dir() or (folder / "sessions").is_dir()):
            found.append(folder)

    try:
        for entry in sorted(os.scandir(home_dir), key=lambda item: item.name):
            if entry.name.startswith(".claude") and entry.is_dir(follow_symlinks=False):
                add(Path(entry.path))
    except OSError:
        pass
    named = env.get("CLAUDE_CONFIG_DIR", "")
    for item in (named, *env.get("PMOS_READER_CLAUDE_HOMES", "").split(os.pathsep)):
        if item:
            add(Path(item))
    return found


def home_label(folder: Path, home_dir: Path) -> str:
    """The label a Claude config folder gets as a session's scope: default for ~/.claude, personal for ~/.claude-personal ..."""
    name = folder.name
    if folder == home_dir / ".claude" or name == ".claude":
        return "default"
    return name[len(".claude"):].lstrip("-_.") or "default"


def _scandir(path: Path):
    try:
        with os.scandir(path) as handle:
            return list(handle)
    except OSError:
        return []


def discover_claude(home_dir: Path, env: dict | None = None):
    for folder in claude_homes(home_dir, env):
        label = home_label(folder, home_dir)
        for project in _scandir(folder / "projects"):
            if not project.is_dir(follow_symlinks=False):
                continue
            for entry in _scandir(Path(project.path)):
                if entry.is_file(follow_symlinks=False) and entry.name.endswith(".jsonl"):
                    yield SourceDesc("claude", Path(entry.path), entry.name[:-6], str(folder), "session", None, label)
                elif entry.is_dir(follow_symlinks=False) and UUID_RE.match(entry.name):
                    for sub in _scandir(Path(entry.path) / "subagents"):
                        if sub.is_file(follow_symlinks=False) and sub.name.endswith(".jsonl"):
                            yield SourceDesc("claude", Path(sub.path), sub.name[:-6], str(folder), "subagent", entry.name, label)


def discover_codex(home_dir: Path):
    root = home_dir / ".codex" / "sessions"
    stack = [root]
    while stack:
        folder = stack.pop()
        for entry in _scandir(folder):
            if entry.is_dir(follow_symlinks=False):
                stack.append(Path(entry.path))
            elif entry.is_file(follow_symlinks=False):
                match = CODEX_ROLLOUT.match(entry.name)
                if match:
                    yield SourceDesc("codex", Path(entry.path), match.group(1), str(home_dir / ".codex"), "session", None, "codex")


def discover_copilot(home_dir: Path):
    for entry in _scandir(home_dir / ".copilot" / "session-state"):
        if entry.is_dir(follow_symlinks=False) and UUID_RE.match(entry.name):
            log = Path(entry.path) / "events.jsonl"
            if log.is_file():
                yield SourceDesc("copilot", log, entry.name, str(home_dir / ".copilot"), "session", None, "copilot")


def discover_pi(home_dir: Path):
    for project in _scandir(home_dir / ".pi" / "agent" / "sessions"):
        if not project.is_dir(follow_symlinks=False):
            continue
        for entry in _scandir(Path(project.path)):
            match = PI_FILE.match(entry.name) if entry.is_file(follow_symlinks=False) else None
            if match:
                yield SourceDesc("pi", Path(entry.path), match.group(1), str(home_dir / ".pi"), "session", None, "pi")


def discover(home_dir: Path, env: dict | None = None) -> list[SourceDesc]:
    """Every log on this machine, in a stable order."""
    found = [*discover_claude(home_dir, env), *discover_codex(home_dir), *discover_copilot(home_dir), *discover_pi(home_dir)]
    return sorted(found, key=lambda item: str(item.path))


# ------------------------------------------------------------------------------------------------------------------ scope rules

def expand(prefix: str, home_dir: Path) -> str:
    return str(home_dir / prefix[2:]) if prefix.startswith("~/") else prefix


def scope_of(settings: Settings, home_dir: Path, label: str, cwd: str | None, org_uuid: str | None) -> tuple[str, str | None]:
    """(scope label, skip reason or None) for a session. The label is informational under "everything"; a reason is given only under
    "shopback-only", for a session whose owner organisation is not a listed ShopBack one or whose folder is personal."""
    personal_cwd = bool(cwd) and any((cwd == p or cwd.startswith(p.rstrip("/") + "/")) for p in (expand(x, home_dir) for x in settings.personal_cwd_prefixes))
    scope = "personal-work" if personal_cwd else label
    if settings.scope_policy == "everything":
        return scope, None
    if personal_cwd:
        return scope, "personal_cwd"
    if org_uuid and org_uuid not in settings.shopback_org_uuids:
        return scope, "other_organisation"
    if not org_uuid and label not in ("default",):
        return scope, "unknown_owner"
    return scope, None
