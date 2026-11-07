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
    path: str
    session_id: str
    home: str = ""
    kind: str = "session"
    parent_session_id: str | None = None
    home_label: str = "default"


class DirCache:
    """Directory listings kept until the directory's own modification time changes, so a scan of a thousand folders costs one `stat` each
    instead of a listing each. A directory's time changes when a file is created, removed or renamed in it (not when one grows), so a new
    log is found at the next scan, and a growing one is found by its own `stat` in `Ingester.scan`."""

    def __init__(self):
        self.cache: dict[str, tuple[int, list[str], list[str]]] = {}

    def listing(self, path: str) -> tuple[list[str], list[str]]:
        """(file names, folder names) of <path>."""
        try:
            stamp = os.stat(path).st_mtime_ns
        except OSError:
            self.cache.pop(path, None)
            return [], []
        hit = self.cache.get(path)
        if hit and hit[0] == stamp:
            return hit[1], hit[2]
        files: list[str] = []
        folders: list[str] = []
        try:
            with os.scandir(path) as handle:
                for entry in handle:
                    if entry.is_dir(follow_symlinks=False):
                        folders.append(entry.name)
                    elif entry.is_file(follow_symlinks=False):
                        files.append(entry.name)
        except OSError:
            return [], []
        self.cache[path] = (stamp, files, folders)
        return files, folders


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


def discover_claude(home_dir: Path, env: dict | None, dirs: DirCache):
    for folder in claude_homes(home_dir, env):
        label = home_label(folder, home_dir)
        projects = os.path.join(folder, "projects")
        for project in dirs.listing(projects)[1]:
            project_path = os.path.join(projects, project)
            files, folders = dirs.listing(project_path)
            for name in files:
                if name.endswith(".jsonl"):
                    yield SourceDesc("claude", os.path.join(project_path, name), name[:-6], str(folder), "session", None, label)
            for name in folders:
                if UUID_RE.match(name):
                    session_dir = os.path.join(project_path, name)
                    if "subagents" in dirs.listing(session_dir)[1]:
                        sub_dir = os.path.join(session_dir, "subagents")
                        for sub in dirs.listing(sub_dir)[0]:
                            if sub.endswith(".jsonl"):
                                yield SourceDesc("claude", os.path.join(sub_dir, sub), sub[:-6], str(folder), "subagent", name, label)


def discover_codex(home_dir: Path, dirs: DirCache):
    stack = [os.path.join(home_dir, ".codex", "sessions")]
    while stack:
        folder = stack.pop()
        files, folders = dirs.listing(folder)
        stack.extend(os.path.join(folder, name) for name in folders)
        for name in files:
            match = CODEX_ROLLOUT.match(name)
            if match:
                yield SourceDesc("codex", os.path.join(folder, name), match.group(1), str(home_dir / ".codex"), "session", None, "codex")


def discover_copilot(home_dir: Path, dirs: DirCache):
    root = os.path.join(home_dir, ".copilot", "session-state")
    for name in dirs.listing(root)[1]:
        if UUID_RE.match(name):
            log = os.path.join(root, name, "events.jsonl")
            if "events.jsonl" in dirs.listing(os.path.join(root, name))[0]:
                yield SourceDesc("copilot", log, name, str(home_dir / ".copilot"), "session", None, "copilot")


def discover_pi(home_dir: Path, dirs: DirCache):
    root = os.path.join(home_dir, ".pi", "agent", "sessions")
    for project in dirs.listing(root)[1]:
        project_path = os.path.join(root, project)
        for name in dirs.listing(project_path)[0]:
            match = PI_FILE.match(name)
            if match:
                yield SourceDesc("pi", os.path.join(project_path, name), match.group(1), str(home_dir / ".pi"), "session", None, "pi")


def discover(home_dir: Path, env: dict | None = None, dirs: DirCache | None = None) -> list[SourceDesc]:
    """Every log on this machine, in a stable order. Pass the same DirCache each time to keep scans cheap."""
    dirs = dirs if dirs is not None else DirCache()
    found = [*discover_claude(home_dir, env, dirs), *discover_codex(home_dir, dirs), *discover_copilot(home_dir, dirs), *discover_pi(home_dir, dirs)]
    return sorted(found, key=lambda item: item.path)


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
