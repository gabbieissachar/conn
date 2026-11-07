"""Where the board's facts come from, read-only.

`Collector` is the one place that touches the outside: Firstmate's own scripts (`bin/fm-fleet-snapshot.sh --json`, `bin/fm-captain-ask.sh list`),
the home's status files, a project clone's git refs and a report's first paragraph. Tests use a subclass that serves fixtures for the two
script calls and keeps the file and git reading, which they point at a temporary folder.

Nothing here writes to a Firstmate home or a project. The snapshot's one side effect (it refreshes a cached copy of other homes' summaries
under its own state folder) is pointed at the reader's own cache folder with FM_SNAPSHOT_CACHE_DIR. Scripts run with a small environment of
their own (no inherited FM_* of the caller, so a script never resolves to the wrong home) and a timeout.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$")
BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$")
STATUS_STATES = ("working", "needs-decision", "blocked", "paused", "done", "failed", "resolved", "note")
STATUS_LINE = re.compile(r"^([a-z-]+)\s*((?:\[[^\]]*\]\s*)*):?\s*((?:\[[^\]]*\]\s*)*):?\s*(.*)$")
SNAPSHOT_TIMEOUT = 90
ASK_TIMEOUT = 45
GIT_TIMEOUT = 15
TAIL_BYTES = 65536
REPORT_SECTION = re.compile(r"^##+\s*(?:Short answer|The answer|Answer first|Answer|Summary|Short summary)[^\n]*\n+(.*?)(?=\n##|\Z)", re.S | re.M | re.I)


class CollectError(RuntimeError):
    """A script could not be run or answered something unusable; the message is one plain sentence for the board's source notes."""


def cache_dir() -> Path:
    explicit = os.environ.get("PMOS_READER_BOARD_CACHE")
    return Path(explicit).expanduser() if explicit else Path.home() / ".config" / "pmos-transcript-reader" / "board-cache"


def script_env(home: Path | None, extra: dict | None = None) -> dict:
    """A small, explicit environment: the target home (when there is one) and the tools' PATH, nothing the caller's own session set."""
    path = os.environ.get("PATH", "")
    prefix = [str(Path.home() / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin"]
    env = {"PATH": ":".join([*prefix, path]) if path else ":".join(prefix), "HOME": str(Path.home()), "LANG": os.environ.get("LANG", "en_US.UTF-8"),
           "GIT_OPTIONAL_LOCKS": "0"}
    if home is not None:
        env["FM_HOME"] = str(home)
    for key in ("USER", "LOGNAME", "TMPDIR"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    env.update(extra or {})
    return env


def parse_status_line(line: str) -> dict | None:
    match = STATUS_LINE.match(line.rstrip("\n"))
    if not match or match.group(1) not in STATUS_STATES:
        return None
    tags = match.group(2) + " " + match.group(3)
    key = re.search(r"\[key=([^\]]+)\]", tags)
    at = re.search(r"\[at=(\d+)\]", tags)
    on = re.search(r"\[on=([^\]]+)\]", tags)
    return {"state": match.group(1), "key": key.group(1) if key else None, "at": int(at.group(1)) if at else None,
            "on": on.group(1).strip() if on else None, "text": match.group(4).strip()}


class Collector:
    """The real collector. `fm_root` is the Firstmate checkout whose scripts run; a session's own `root` wins."""

    def __init__(self, fm_root: Path | None, runner=None, now=time.time):
        self.fm_root = fm_root
        self._run = runner or self._subprocess
        self.now = now
        self._git_cache: dict = {}

    # ------------------------------------------------------------------ scripts
    @staticmethod
    def _subprocess(argv, env, timeout):
        return subprocess.run(argv, env=env, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL, check=False)

    def _script(self, session, name: str) -> Path:
        root = session.root or self.fm_root
        if root is None:
            raise CollectError("no Firstmate checkout found: set FM_ROOT or fm_root in the board config")
        script = Path(root) / "bin" / name
        if not script.is_file():
            raise CollectError(f"{name} is not in {root}/bin")
        return script

    def snapshot(self, session) -> dict:
        script = self._script(session, "fm-fleet-snapshot.sh")
        env = script_env(session.home, {"FM_SNAPSHOT_CACHE_DIR": str(cache_dir() / "snapshot" / session.id), "FM_SNAPSHOT_SECONDMATES": "1"})
        try:
            done = self._run([str(script), "--json"], env, SNAPSHOT_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise CollectError(f"the fleet snapshot of {session.id} took longer than {SNAPSHOT_TIMEOUT} seconds") from None
        except OSError as error:
            raise CollectError(f"the fleet snapshot could not start ({error.strerror or error.__class__.__name__})") from None
        if done.returncode != 0:
            raise CollectError(f"the fleet snapshot of {session.id} failed (exit {done.returncode})")
        try:
            data = json.loads(done.stdout)
        except ValueError:
            raise CollectError(f"the fleet snapshot of {session.id} was not JSON") from None
        if not isinstance(data, dict) or not str(data.get("schema", "")).startswith("fm-fleet-snapshot."):
            raise CollectError(f"the fleet snapshot of {session.id} has an unknown schema")
        return data

    def asks(self, session) -> list[dict]:
        """The open and partly answered typed ask records of the home (fm-ask.v1, derived), or CollectError when this checkout has none."""
        script = self._script(session, "fm-captain-ask.sh")
        try:
            done = self._run([str(script), "list", "--open", "--resolve", "--json"], script_env(session.home), ASK_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise CollectError(f"listing the ask records of {session.id} took longer than {ASK_TIMEOUT} seconds") from None
        except OSError as error:
            raise CollectError(f"listing the ask records could not start ({error.strerror or error.__class__.__name__})") from None
        if done.returncode != 0:
            raise CollectError(f"listing the ask records of {session.id} failed (exit {done.returncode})")
        try:
            records = json.loads(done.stdout)
        except ValueError:
            raise CollectError(f"the ask records of {session.id} were not JSON") from None
        return [r for r in records if isinstance(r, dict) and r.get("schema") == "fm-ask.v1"] if isinstance(records, list) else []

    # -------------------------------------------------------------------- files
    @staticmethod
    def status_path(session, task_id: str) -> Path | None:
        return Path(session.home) / "state" / f"{task_id}.status" if TASK_ID.match(task_id or "") else None

    def status_tail(self, session, task_id: str, count: int = 40) -> list[dict]:
        path = self.status_path(session, task_id)
        if path is None:
            return []
        try:
            with open(path, "rb") as handle:
                size = handle.seek(0, os.SEEK_END)
                handle.seek(max(0, size - TAIL_BYTES))
                chunk = handle.read().decode("utf-8", errors="replace")
        except OSError:
            return []
        lines = chunk.splitlines()
        if size > TAIL_BYTES and lines:
            lines = lines[1:]  # the first line of a cut chunk is partial
        events = [e for e in (parse_status_line(line) for line in lines) if e]
        return events[-count:]

    def report_for(self, session, task_id: str, mentions: str) -> tuple[str | None, bool]:
        """(path relative to the home, exists): data/<id>/report.md when there, else the first data/*.md the task's own text names and that exists."""
        home = Path(session.home)
        own = f"data/{task_id}/report.md"
        if TASK_ID.match(task_id or "") and (home / own).is_file():
            return own, True
        for match in re.finditer(r"(data/[\w./-]+?\.md)", mentions or ""):
            rel = match.group(1)
            if ".." not in rel and (home / rel).is_file():
                return rel, True
        return None, False

    def report_summary(self, session, rel: str | None) -> str | None:
        """The Short answer paragraph of a report (else its first prose paragraph), as plain text up to 600 characters."""
        if not rel or ".." in rel:
            return None
        try:
            with open(Path(session.home) / rel, "rb") as handle:
                text = handle.read(96 * 1024).decode("utf-8", errors="replace")
        except OSError:
            return None
        found = REPORT_SECTION.search(text)
        body = found.group(1) if found else None
        if not body:
            paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip() and not p.lstrip().startswith(("#", "|", "```", "---", "<"))]
            body = paragraphs[0] if paragraphs else None
        if not body:
            return None
        body = re.sub(r"^\s*(?:\d+[.)]|[-*])\s*", "", body.strip())
        body = re.sub(r"\*\*|`", "", body)
        body = re.sub(r"\s+", " ", body).strip()
        return body[:600] or None

    def created_at(self, body_lines: list[str]) -> int | None:
        """The UTC `Created:` stamp bin/fm-task-created-lib.sh puts first in a new task's body, as epoch seconds."""
        for line in body_lines or []:
            found = re.fullmatch(r"Created: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)", line.strip())
            if found:
                import calendar
                return calendar.timegm(time.strptime(found.group(1), "%Y-%m-%dT%H:%M:%SZ"))
        return None

    # ---------------------------------------------------------------------- git
    def _git(self, project: Path, *args: str) -> subprocess.CompletedProcess | None:
        try:
            return self._run(["git", "-C", str(project), *args], script_env(None, {"GIT_TERMINAL_PROMPT": "0"}), GIT_TIMEOUT)
        except (subprocess.TimeoutExpired, OSError):
            return None

    def branch_state(self, project: Path | None, branch: str | None) -> dict:
        """Where a task's branch stands against main in its project clone (read-only refs):
        state none (no branch named) | missing (no such ref) | merged (nothing main lacks) | ahead (n commits main does not have) | unknown."""
        if not branch:
            return {"state": "none", "ahead": 0, "base": None}
        if not BRANCH.match(branch) or project is None or not (Path(project) / ".git").exists():
            return {"state": "unknown", "ahead": None, "base": None}
        cache_key = (str(project), branch)
        if cache_key in self._git_cache:
            return self._git_cache[cache_key]
        project = Path(project)
        result = {"state": "unknown", "ahead": None, "base": None}
        have = self._git(project, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}")
        if have is not None:
            base = None
            for candidate in ("main", "master"):
                ok = self._git(project, "rev-parse", "--verify", "--quiet", f"refs/heads/{candidate}")
                if ok is not None and ok.returncode == 0:
                    base = candidate
                    break
            if have.returncode != 0:
                result = {"state": "missing", "ahead": None, "base": base}
            elif base:
                count = self._git(project, "rev-list", "--count", f"{base}..{branch}")
                if count is not None and count.returncode == 0 and count.stdout.strip().isdigit():
                    ahead = int(count.stdout.strip())
                    result = {"state": "ahead" if ahead else "merged", "ahead": ahead, "base": base}
        self._git_cache[cache_key] = result
        return result
