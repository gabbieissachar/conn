#!/usr/bin/env python3
"""Read-only recovery identity verification for live Herdr agent panes.

This module deliberately deals only in client metadata.  It never reads
conversation text and it keeps the real session id in the private candidate
object rather than in the normal report representation.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol


SESSION_ID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
SUPPORTED_CLIENTS = {"claude", "codex"}
SAFE_STATUSES = {"idle", "done"}


def observed_at() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_cwd(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return str(Path(value).expanduser().resolve())
    except OSError:
        return str(Path(value).expanduser())


def valid_session_id(value: object) -> bool:
    return isinstance(value, str) and bool(SESSION_ID_RE.fullmatch(value))


def redacted_id(value: object) -> str:
    if not isinstance(value, str) or len(value) < 8:
        return "[redacted]"
    return f"{value[:4]}...{value[-4:]}"


@dataclass(frozen=True)
class IdentityCandidate:
    client: str
    session_id: str
    evidence: tuple[str, ...]
    pid: int | None
    process_start: str | None
    cwd: str | None
    store_shape: str
    candidate_count: int
    observed_at: str

    def report(self) -> dict[str, Any]:
        """Return the safe, console-facing form of a candidate."""
        return {
            "client": self.client,
            "evidence": list(self.evidence),
            "pid": "[redacted]" if self.pid is not None else None,
            "process_start": bool(self.process_start),
            "cwd": bool(self.cwd),
            "store_shape": self.store_shape,
            "candidate_count": self.candidate_count,
            "observed_at": self.observed_at,
        }


@dataclass(frozen=True)
class StoreRecord:
    client: str
    session_id: str
    cwd: str | None
    path: Path
    shape: str
    process_start: str | None = None


@dataclass(frozen=True)
class OpenHandle:
    path: Path
    owner_pid: int | None
    helper_owned: bool = False


class HandleAdapter(Protocol):
    def handles(self, pid: int) -> list[OpenHandle]: ...

    def process_start(self, pid: int) -> str | None: ...


def _json_objects(path: Path) -> Iterable[dict[str, Any]]:
    try:
        with path.open(errors="replace") as stream:
            for line in stream:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    yield value
    except OSError:
        return


class ClaudeStore:
    def __init__(self, home: Path | None = None):
        self.home = (home or Path.home() / ".claude").expanduser()

    @property
    def sessions_dir(self) -> Path:
        return self.home / "sessions"

    @property
    def projects_dir(self) -> Path:
        return self.home / "projects"

    def records(self) -> list[StoreRecord]:
        found: dict[str, StoreRecord] = {}
        if not self.projects_dir.exists():
            return []
        for path in self.projects_dir.rglob("*.jsonl"):
            candidate_id = path.stem
            if not valid_session_id(candidate_id):
                continue
            session_cwd: str | None = None
            session_id: str | None = None
            # Claude may put a queue or other event first.  Inspect only
            # structural fields until the session identity is established.
            for row in _json_objects(path):
                row_id = row.get("sessionId") or row.get("session_id")
                row_cwd = row.get("cwd")
                if isinstance(row_id, str) and valid_session_id(row_id):
                    session_id = row_id
                if isinstance(row_cwd, str) and row_cwd:
                    session_cwd = normalize_cwd(row_cwd)
                if session_id and session_cwd:
                    break
            session_id = session_id or candidate_id
            if session_id != candidate_id or not valid_session_id(session_id):
                continue
            found[session_id] = StoreRecord("claude", session_id, session_cwd, path, "project_jsonl")
        return list(found.values())

    def find(self, session_id: object) -> StoreRecord | None:
        if not valid_session_id(session_id):
            return None
        for record in self.records():
            if record.session_id == session_id:
                return record
        return None

    def pid_record(self, pid: int) -> dict[str, Any] | None:
        path = self.sessions_dir / f"{pid}.json"
        try:
            value = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None


class CodexStore:
    def __init__(self, home: Path | None = None):
        self.home = (home or Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))).expanduser()

    @property
    def index_path(self) -> Path:
        return self.home / "session_index.jsonl"

    @property
    def sessions_dir(self) -> Path:
        return self.home / "sessions"

    def records(self) -> list[StoreRecord]:
        found: dict[str, StoreRecord] = {}
        if self.index_path.exists():
            for row in _json_objects(self.index_path):
                session_id = row.get("id") or row.get("session_id")
                if valid_session_id(session_id):
                    found[session_id] = StoreRecord("codex", session_id, normalize_cwd(row.get("cwd")), self.index_path, "session_index")
        if self.sessions_dir.exists():
            for path in self.sessions_dir.rglob("rollout-*.jsonl"):
                for row in _json_objects(path):
                    if row.get("type") != "session_meta" or not isinstance(row.get("payload"), dict):
                        continue
                    payload = row["payload"]
                    session_id = payload.get("session_id") or payload.get("id")
                    if valid_session_id(session_id):
                        found[session_id] = StoreRecord("codex", session_id, normalize_cwd(payload.get("cwd")), path, "rollout_session_meta")
                    break
        return list(found.values())

    def find(self, session_id: object) -> StoreRecord | None:
        if not valid_session_id(session_id):
            return None
        for record in self.records():
            if record.session_id == session_id:
                return record
        return None


class NativeHandleAdapter:
    """Small macOS/Linux adapter.  Tests can inject a deterministic adapter."""

    def handles(self, pid: int) -> list[OpenHandle]:
        if sys.platform.startswith("linux"):
            fd_root = Path(f"/proc/{pid}/fd")
            handles: list[OpenHandle] = []
            try:
                for fd in fd_root.iterdir():
                    try:
                        target = Path(os.readlink(fd))
                    except OSError:
                        continue
                    if target.is_absolute() and target.exists():
                        handles.append(OpenHandle(target, pid))
            except OSError:
                pass
            return handles
        if sys.platform == "darwin":
            try:
                result = subprocess.run(["lsof", "-Fn", "-p", str(pid)], capture_output=True, text=True, check=False, timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                return []
            return [OpenHandle(Path(line[1:]), pid) for line in result.stdout.splitlines() if line.startswith("n") and line[1:]]
        return []

    def process_start(self, pid: int) -> str | None:
        if sys.platform.startswith("linux"):
            try:
                fields = Path(f"/proc/{pid}/stat").read_text().split()
                return fields[21] if len(fields) > 21 else None
            except OSError:
                return None
        try:
            result = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, check=False, timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            return None
        value = result.stdout.strip()
        return value or None


def _store(client: str, stores: dict[str, Any] | None = None) -> Any:
    if stores and client in stores:
        return stores[client]
    return ClaudeStore() if client == "claude" else CodexStore()


def _pane_cwd(pane: dict[str, Any]) -> str | None:
    return normalize_cwd(pane.get("foreground_cwd") or pane.get("cwd"))


def _process_start(process: dict[str, Any]) -> str | None:
    for key in ("process_start", "processStart", "start_marker", "startMarker", "procStart", "proc_start", "start_time", "startTime"):
        value = process.get(key)
        if isinstance(value, (str, int, float)) and str(value):
            return str(value)
    return None


def _processes(pane: dict[str, Any]) -> list[dict[str, Any]]:
    value = pane.get("foreground_processes") or pane.get("processes") or []
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _is_foreground_process(process: dict[str, Any]) -> bool:
    for key in ("foreground", "is_foreground", "current", "is_current"):
        if process.get(key) is True:
            return True
    return False


def _selected_client_process(pane: dict[str, Any]) -> dict[str, Any] | None:
    """Select exactly one current process for the pane's detected client."""
    client = pane.get("agent")
    if client not in SUPPORTED_CLIENTS:
        return None
    matches = [
        process
        for process in _processes(pane)
        if _argv(process) and Path(_argv(process)[0]).name == client and isinstance(process.get("pid"), int)
    ]
    explicit_pid = pane.get("foreground_pid")
    if isinstance(explicit_pid, int):
        matches = [process for process in matches if process.get("pid") == explicit_pid]
    else:
        flagged = [process for process in matches if _is_foreground_process(process)]
        if flagged:
            matches = flagged
    return matches[0] if len(matches) == 1 else None


def _argv(process: dict[str, Any]) -> list[str]:
    value = process.get("argv")
    if isinstance(value, list):
        return [str(item) for item in value]
    command = process.get("cmdline")
    if isinstance(command, str):
        # Process metadata is expected to provide argv.  shlex is only a
        # compatibility fallback for older Herdr versions.
        try:
            import shlex
            return shlex.split(command)
        except ValueError:
            return []
    return []


def _argv_session(client: str, argv: list[str]) -> str | None:
    if not argv or Path(argv[0]).name != client:
        return None
    for index, value in enumerate(argv[1:], 1):
        if client == "codex" and value == "resume" and index + 1 < len(argv):
            return argv[index + 1] if valid_session_id(argv[index + 1]) else None
        if client == "claude" and value in {"--resume", "resume", "--session-id"} and index + 1 < len(argv):
            return argv[index + 1] if valid_session_id(argv[index + 1]) else None
        if client == "claude" and value.startswith(("--resume=", "--session-id=")):
            candidate = value.split("=", 1)[1]
            return candidate if valid_session_id(candidate) else None
    return None


def _native_candidate(pane: dict[str, Any], stores: dict[str, Any] | None, stamp: str) -> IdentityCandidate | None:
    native = pane.get("agent_session")
    client = pane.get("agent")
    if client not in SUPPORTED_CLIENTS or not isinstance(native, dict):
        return None
    if native.get("agent") != client or _selected_client_process(pane) is None:
        return None
    session_id = native.get("value")
    source = native.get("source")
    if not valid_session_id(session_id):
        return None
    record = _store(client, stores).find(session_id)
    cwd = _pane_cwd(pane)
    if not record or not record.cwd or not cwd or record.cwd != cwd:
        return None
    evidence = "native_claude" if client == "claude" else "native_codex"
    return IdentityCandidate(client, session_id, (evidence, "store_header"), _foreground_pid(pane), _foreground_marker(pane), cwd, record.shape, 1, stamp)


def _foreground_pid(pane: dict[str, Any]) -> int | None:
    process = _selected_client_process(pane)
    pid = process.get("pid") if process else None
    return pid if isinstance(pid, int) and pid > 0 else None


def _foreground_marker(pane: dict[str, Any]) -> str | None:
    process = _selected_client_process(pane)
    if process:
        marker = _process_start(process)
        if marker:
            return marker
    return pane.get("process_start") if isinstance(pane.get("process_start"), str) else None


def _candidate_from_argv(pane: dict[str, Any], process: dict[str, Any], stores: dict[str, Any] | None, stamp: str) -> IdentityCandidate | None:
    client = pane.get("agent")
    selected = _selected_client_process(pane)
    if selected is None or process is not selected:
        return None
    session_id = _argv_session(client, _argv(process)) if client in SUPPORTED_CLIENTS else None
    if not session_id:
        return None
    record = _store(client, stores).find(session_id)
    cwd = _pane_cwd(pane)
    if not record or not record.cwd or not cwd or record.cwd != cwd:
        return None
    return IdentityCandidate(client, session_id, ("argv_exact", "store_header"), process.get("pid") if isinstance(process.get("pid"), int) else None, _process_start(process), cwd, record.shape, 1, stamp)


def _candidate_from_handle(pane: dict[str, Any], stores: dict[str, Any] | None, adapter: HandleAdapter, stamp: str) -> IdentityCandidate | None:
    client = pane.get("agent")
    pid = _foreground_pid(pane)
    cwd = _pane_cwd(pane)
    if client not in SUPPORTED_CLIENTS or pid is None or cwd is None:
        return None
    all_handles = adapter.handles(pid)
    if any(handle.helper_owned or handle.owner_pid not in {None, pid} for handle in all_handles):
        return None
    handles = all_handles
    matches: list[StoreRecord] = []
    for record in _store(client, stores).records():
        matching_handles = [handle for handle in handles if handle.path == record.path]
        if len(matching_handles) == 1:
            matches.append(record)
    if len(matches) != 1 or not matches[0].cwd or matches[0].cwd != cwd:
        return None
    record = matches[0]
    return IdentityCandidate(client, record.session_id, ("open_handle", "store_header"), pid, _foreground_marker(pane) or adapter.process_start(pid), cwd, record.shape, 1, stamp)


def _candidate_from_pid_record(pane: dict[str, Any], stores: dict[str, Any] | None, adapter: HandleAdapter, stamp: str) -> IdentityCandidate | None:
    if pane.get("agent") != "claude":
        return None
    pid = _foreground_pid(pane)
    cwd = _pane_cwd(pane)
    if pid is None or cwd is None:
        return None
    record = _store("claude", stores).pid_record(pid)
    if not record or not valid_session_id(record.get("sessionId")):
        return None
    record_cwd = normalize_cwd(record.get("cwd"))
    marker = record.get("procStart") or record.get("startedAt")
    current_marker = _foreground_marker(pane) or adapter.process_start(pid)
    if not record_cwd or record_cwd != cwd or not marker or not current_marker or str(marker) != str(current_marker):
        return None
    session = _store("claude", stores).find(record["sessionId"])
    if not session or session.cwd != cwd:
        return None
    return IdentityCandidate("claude", record["sessionId"], ("pid_record", "process_start", "store_header"), pid, str(current_marker), cwd, session.shape, 1, stamp)


def verify_pane(pane: dict[str, Any], *, stores: dict[str, Any] | None = None, adapter: HandleAdapter | None = None, stamp: str | None = None) -> dict[str, Any]:
    """Verify one pane and return a private result suitable for apply/report."""
    stamp = stamp or observed_at()
    client = pane.get("agent")
    base: dict[str, Any] = {"status": "unresolved", "client": client, "candidate_count": 0, "evidence": [], "candidate": None, "observed_at": stamp}
    if client not in SUPPORTED_CLIENTS or pane.get("agent_status") not in SAFE_STATUSES:
        base["hint"] = "supported agent must be idle or done"
        return base
    selected_process = _selected_client_process(pane)
    if selected_process is None:
        client_processes = [
            process for process in _processes(pane)
            if _argv(process) and Path(_argv(process)[0]).name == client
        ]
        base["status"] = "candidate_ambiguous" if client_processes else "unresolved"
        base["candidate_count"] = len(client_processes)
        base["hint"] = "foreground client process is not uniquely identified"
        return base
    if not _pane_cwd(pane):
        base["hint"] = "pane cwd and current foreground process are required"
        return base
    adapter = adapter or NativeHandleAdapter()
    candidates: dict[str, IdentityCandidate] = {}
    native = pane.get("agent_session")
    if isinstance(native, dict) and native.get("agent") != client:
        base["evidence"] = ["native_conflict"]
        base["hint"] = "native agent report conflicts with the pane client"
        return base
    native_id = native.get("value") if isinstance(native, dict) else None
    native_record = _store(client, stores).find(native_id) if client in SUPPORTED_CLIENTS and valid_session_id(native_id) else None
    for candidate in (
        _native_candidate(pane, stores, stamp),
        _candidate_from_argv(pane, selected_process, stores, stamp),
        _candidate_from_handle(pane, stores, adapter, stamp),
        _candidate_from_pid_record(pane, stores, adapter, stamp),
    ):
        if candidate:
            current_marker = adapter.process_start(candidate.pid) if candidate.pid is not None else None
            if current_marker and candidate.process_start and str(current_marker) != str(candidate.process_start):
                continue
            if current_marker and not candidate.process_start:
                candidate = IdentityCandidate(
                    candidate.client,
                    candidate.session_id,
                    candidate.evidence,
                    candidate.pid,
                    str(current_marker),
                    candidate.cwd,
                    candidate.store_shape,
                    candidate.candidate_count,
                    candidate.observed_at,
                )
            previous = candidates.get(candidate.session_id)
            if previous:
                candidates[candidate.session_id] = IdentityCandidate(candidate.client, candidate.session_id, tuple(sorted(set(previous.evidence + candidate.evidence))), candidate.pid, candidate.process_start, candidate.cwd, candidate.store_shape, 1, stamp)
            else:
                candidates[candidate.session_id] = candidate
    cwd = _pane_cwd(pane)
    store = _store(client, stores)
    cwd_candidates = {record.session_id for record in store.records() if record.cwd and record.cwd == cwd}
    ids = set(candidates) | cwd_candidates
    if native_record:
        ids.add(native_record.session_id)
    base["candidate_count"] = len(ids)
    base["evidence"] = sorted({evidence for candidate in candidates.values() for evidence in candidate.evidence} | ({"cwd_candidate"} if cwd_candidates else set()))
    if len(candidates) == 1 and len(ids) == 1 and (not native_record or native_record.session_id in candidates):
        candidate = next(iter(candidates.values()))
        source = next((evidence for evidence in ("native_claude", "native_codex", "argv_exact", "open_handle", "pid_record") if evidence in candidate.evidence), None)
        if source:
            base["status"] = {"native_claude": "native_verified", "native_codex": "native_verified", "argv_exact": "argv_verified", "open_handle": "handle_verified", "pid_record": "pid_record_verified"}[source]
            base["candidate"] = candidate
            base["hint"] = "verified"
            return base
    base["status"] = "candidate_ambiguous" if len(ids) > 1 else "unresolved"
    base["hint"] = "multiple client sessions share this cwd; confirm manually" if len(ids) > 1 else "no independent store, process, or native identity agreed"
    return base


def result_report(result: dict[str, Any]) -> dict[str, Any]:
    candidate = result.get("candidate")
    safe = dict(result)
    safe.pop("candidate", None)
    if isinstance(candidate, IdentityCandidate):
        safe["candidate"] = candidate.report()
    return safe
