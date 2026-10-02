#!/usr/bin/env python3
"""Record herdr pane -> coding-agent resume metadata."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shlex
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from agent_session_state import PRIVATE_FILE_MODE, ensure_private_file
from agent_identity_verifier import IdentityCandidate, result_report, verify_pane


SCRIPT_DIR = Path(__file__).resolve().parent
PMOS_REPO = SCRIPT_DIR.parents[3]
DEFAULT_STATE_DIR = SCRIPT_DIR / "state"
DEFAULT_MANIFEST = DEFAULT_STATE_DIR / "herdr-agent-sessions.json"
DEFAULT_MISSING_JSON = DEFAULT_STATE_DIR / "herdr-agent-missing-sessions.json"
DEFAULT_STATUS_LOG = DEFAULT_STATE_DIR / "herdr-agent-status-capture.jsonl"
CODEX_SESSION_INDEX_PATH = Path.home() / ".codex" / "session_index.jsonl"
CODEX_SESSIONS_DIR = Path.home() / ".codex" / "sessions"
SHELL_SOURCE = "source"
SESSION_TOKEN = r"([A-Za-z0-9][A-Za-z0-9._:-]{5,})"
MANIFEST_FIELD_ORDER = (
    "herdr_session",
    "workspace_label",
    "workspace_id",
    "tab_label",
    "tab_id",
    "pane_label",
    "pane_id",
    "session_id",
)


@dataclass
class PaneInfo:
    herdr_session: str | None
    pane_id: str
    workspace_id: str
    tab_id: str
    cwd: str | None
    foreground_cwd: str | None
    agent: str | None = None
    agent_status: str | None = None
    label: str | None = None
    workspace_label: str | None = None
    tab_label: str | None = None
    agent_session: dict[str, Any] | None = None


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def current_herdr_session() -> str | None:
    value = os.environ.get("HERDR_SESSION")
    return value.strip() if value and value.strip() else None


def run_json(cmd: list[str]) -> dict[str, Any] | None:
    try:
        result = subprocess.run(cmd, text=True, capture_output=True, timeout=10, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data


def manifest_path(args: argparse.Namespace) -> Path:
    return Path(
        args.manifest
        or os.environ.get("PMOS_HERDR_AGENT_MANIFEST")
        or DEFAULT_MANIFEST
    ).expanduser()


def missing_json_path(args: argparse.Namespace) -> Path:
    return Path(
        args.missing_json
        or os.environ.get("PMOS_HERDR_AGENT_MISSING_JSON")
        or DEFAULT_MISSING_JSON
    ).expanduser()


def status_log_path() -> Path:
    return Path(
        os.environ.get("PMOS_HERDR_AGENT_STATUS_LOG") or DEFAULT_STATUS_LOG
    ).expanduser()


def atomic_write_private(path: Path, contents: str) -> None:
    ensure_private_file(path, default_state_dir=DEFAULT_STATE_DIR)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, PRIVATE_FILE_MODE)
        with os.fdopen(descriptor, "w") as handle:
            descriptor = None
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(PRIVATE_FILE_MODE)
        temporary.replace(path)
        path.chmod(PRIVATE_FILE_MODE)
    except OSError as exc:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except OSError:
            pass
        raise SystemExit(f"could not atomically write private Herdr agent state file {path}: {exc}") from exc


@contextmanager
def private_file_lock(path: Path):
    lock_path = path.with_suffix(path.suffix + ".lock")
    ensure_private_file(lock_path, default_state_dir=DEFAULT_STATE_DIR)
    descriptor = None
    try:
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, PRIVATE_FILE_MODE)
        os.fchmod(descriptor, PRIVATE_FILE_MODE)
        with os.fdopen(descriptor, "r+") as lock_file:
            descriptor = None
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)
    except OSError as exc:
        if descriptor is not None:
            os.close(descriptor)
        raise SystemExit(f"private Herdr agent state lock is not secure: {lock_path}: {exc}") from exc


def log_status_event(pane: PaneInfo, event: str, **fields: Any) -> None:
    payload = {
        "timestamp": now_iso(),
        "event": event,
        "pane_id": pane.pane_id,
        "workspace_id": pane.workspace_id,
        "tab_id": pane.tab_id,
        "client": pane.agent,
        **fields,
    }
    path = status_log_path()
    ensure_private_file(path, default_state_dir=DEFAULT_STATE_DIR)
    with private_file_lock(path):
        existing = path.read_text() if path.exists() else ""
        atomic_write_private(path, existing + json.dumps(payload) + "\n")


def read_manifest(path: Path) -> dict[str, Any]:
    ensure_private_file(path, default_state_dir=DEFAULT_STATE_DIR)
    if not path.exists():
        return {"version": 1, "updated_at": now_iso(), "panes": []}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"manifest is not valid JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"manifest root must be an object: {path}")
    data.setdefault("version", 1)
    data.setdefault("panes", [])
    if not isinstance(data["panes"], list):
        raise SystemExit(f"manifest panes must be a list: {path}")
    return data


def existing_records_by_pane(
    path: Path, *, herdr_session: str | None
) -> dict[tuple[str | None, str], dict[str, Any]]:
    data = read_manifest(path)
    records: dict[str, dict[str, Any]] = {}
    for item in data["panes"]:
        if not isinstance(item, dict):
            continue
        pane_id = item.get("pane_id")
        if isinstance(pane_id, str) and pane_id:
            record_session = item.get("herdr_session") or herdr_session
            records[(record_session, pane_id)] = item
    return records


def write_manifest(path: Path, data: dict[str, Any]) -> None:
    ensure_private_file(path, default_state_dir=DEFAULT_STATE_DIR)
    ordered_panes: list[dict[str, Any]] = []
    for item in data.get("panes", []):
        if not isinstance(item, dict):
            continue
        ordered: dict[str, Any] = {}
        for field in MANIFEST_FIELD_ORDER:
            if field in item:
                ordered[field] = item[field]
        for field, value in item.items():
            if field not in ordered:
                ordered[field] = value
        ordered_panes.append(ordered)
    data["panes"] = ordered_panes
    data["updated_at"] = now_iso()
    atomic_write_private(path, json.dumps(data, indent=2) + "\n")


@contextmanager
def manifest_lock(path: Path):
    with private_file_lock(path):
        yield


def normalize_path(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(Path(value).expanduser().resolve())
    except OSError:
        return str(Path(value).expanduser())


def current_pane_info() -> PaneInfo | None:
    data = run_json(["herdr", "pane", "current", "--current"])
    if not data:
        return None
    result = data.get("result")
    if not isinstance(result, dict):
        return None
    pane = result.get("pane")
    if not isinstance(pane, dict):
        return None
    pane_id = pane.get("pane_id")
    workspace_id = pane.get("workspace_id")
    tab_id = pane.get("tab_id")
    if not all(isinstance(item, str) and item for item in [pane_id, workspace_id, tab_id]):
        return None
    current = PaneInfo(
        herdr_session=current_herdr_session(),
        pane_id=pane_id,
        workspace_id=workspace_id,
        tab_id=tab_id,
        cwd=normalize_path(pane.get("cwd") if isinstance(pane.get("cwd"), str) else None),
        foreground_cwd=normalize_path(
            pane.get("foreground_cwd") if isinstance(pane.get("foreground_cwd"), str) else None
        ),
        agent=pane.get("agent") if isinstance(pane.get("agent"), str) else None,
        agent_status=pane.get("agent_status") if isinstance(pane.get("agent_status"), str) else None,
        label=pane.get("label") if isinstance(pane.get("label"), str) else None,
        agent_session=pane.get("agent_session") if isinstance(pane.get("agent_session"), dict) else None,
    )
    for snapshot_pane in snapshot_panes():
        if snapshot_pane.pane_id == current.pane_id:
            current.workspace_label = snapshot_pane.workspace_label
            current.tab_label = snapshot_pane.tab_label
            if snapshot_pane.label:
                current.label = snapshot_pane.label
            break
    return current


def snapshot_panes() -> list[PaneInfo]:
    data = run_json(["herdr", "api", "snapshot"])
    if not data:
        return []
    result = data.get("result")
    if not isinstance(result, dict):
        return []
    snapshot = result.get("snapshot")
    if not isinstance(snapshot, dict):
        return []
    panes = snapshot.get("panes")
    if not isinstance(panes, list):
        return []
    tabs = snapshot.get("tabs")
    workspaces = snapshot.get("workspaces")

    tab_labels: dict[str, str] = {}
    if isinstance(tabs, list):
        for tab in tabs:
            if not isinstance(tab, dict):
                continue
            tab_id = tab.get("tab_id")
            label = tab.get("label")
            if isinstance(tab_id, str) and tab_id and isinstance(label, str) and label:
                tab_labels[tab_id] = label

    workspace_labels: dict[str, str] = {}
    if isinstance(workspaces, list):
        for workspace in workspaces:
            if not isinstance(workspace, dict):
                continue
            workspace_id = workspace.get("workspace_id")
            label = workspace.get("label")
            if isinstance(workspace_id, str) and workspace_id and isinstance(label, str) and label:
                workspace_labels[workspace_id] = label

    found: list[PaneInfo] = []
    for pane in panes:
        if not isinstance(pane, dict):
            continue
        pane_id = pane.get("pane_id")
        workspace_id = pane.get("workspace_id")
        tab_id = pane.get("tab_id")
        if not all(isinstance(item, str) and item for item in [pane_id, workspace_id, tab_id]):
            continue
        found.append(
            PaneInfo(
                herdr_session=current_herdr_session(),
                pane_id=pane_id,
                workspace_id=workspace_id,
                tab_id=tab_id,
                cwd=normalize_path(pane.get("cwd") if isinstance(pane.get("cwd"), str) else None),
                foreground_cwd=normalize_path(
                    pane.get("foreground_cwd") if isinstance(pane.get("foreground_cwd"), str) else None
                ),
                agent=pane.get("agent") if isinstance(pane.get("agent"), str) else None,
                agent_status=pane.get("agent_status") if isinstance(pane.get("agent_status"), str) else None,
                label=pane.get("label") if isinstance(pane.get("label"), str) else None,
                workspace_label=workspace_labels.get(workspace_id),
                tab_label=tab_labels.get(tab_id),
                agent_session=pane.get("agent_session") if isinstance(pane.get("agent_session"), dict) else None,
            )
        )
    return found


def pane_read_text(pane_id: str, *, lines: int, source: str) -> str | None:
    try:
        result = subprocess.run(
            ["herdr", "pane", "read", pane_id, "--source", source, "--lines", str(lines)],
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def pane_send_status(pane_id: str) -> bool:
    text_result = subprocess.run(
        ["herdr", "pane", "send-text", pane_id, "/status"],
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    if text_result.returncode != 0:
        return False
    key_result = subprocess.run(
        ["herdr", "pane", "send-keys", pane_id, "Enter"],
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    if key_result.returncode != 0:
        return False
    time.sleep(0.25)
    return True


def pane_process_entries(pane_id: str) -> list[tuple[int | None, str]]:
    data = run_json(["herdr", "pane", "process-info", "--pane", pane_id])
    if not data:
        return []
    result = data.get("result")
    if not isinstance(result, dict):
        return []
    process_info = result.get("process_info")
    if not isinstance(process_info, dict):
        return []
    processes = process_info.get("foreground_processes")
    if not isinstance(processes, list):
        return []
    entries: list[tuple[int | None, str]] = []
    for process in processes:
        if not isinstance(process, dict):
            continue
        cmdline = process.get("cmdline")
        if isinstance(cmdline, str) and cmdline:
            pid = process.get("pid")
            entries.append((pid if isinstance(pid, int) else None, cmdline))
    return entries


def detect_from_native(pane: PaneInfo) -> tuple[str, str] | None:
    client = pane.agent if pane.agent in {"codex", "claude"} else None
    if not client:
        return None
    data = run_json(["herdr", "pane", "get", pane.pane_id])
    if not data:
        return None
    result = data.get("result")
    if not isinstance(result, dict):
        return None
    pane_data = result.get("pane")
    if not isinstance(pane_data, dict):
        return None
    agent_session = pane_data.get("agent_session")
    if not isinstance(agent_session, dict):
        return None
    source = agent_session.get("source")
    if isinstance(source, str) and source.startswith("herdr:") and client != "codex":
        # Herdr assigns these IDs for display and lifecycle reporting. They
        # are not IDs accepted by the Codex or Claude resume commands.
        return None
    reported_agent = agent_session.get("agent")
    session_id = agent_session.get("value")
    if reported_agent not in (None, client) or not isinstance(session_id, str):
        return None
    session_id = clean_session_id(session_id)
    if client == "codex" and session_id and not codex_session_exists(session_id):
        return None
    return (client, session_id) if session_id else None


def git_context(cwd: str) -> tuple[str | None, str | None]:
    def run_text(cmd: list[str]) -> str | None:
        try:
            result = subprocess.run(cmd, text=True, capture_output=True, timeout=5, check=False)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None
        if result.returncode != 0:
            return None
        return result.stdout.strip() or None

    root = run_text(["git", "-C", cwd, "rev-parse", "--show-toplevel"])
    branch = run_text(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])
    if branch == "HEAD":
        branch = run_text(["git", "-C", cwd, "rev-parse", "--short", "HEAD"])
    return normalize_path(root), branch


def validate_session_id(session_id: str) -> None:
    if not session_id or any(ch.isspace() for ch in session_id):
        raise SystemExit("session id must be non-empty and must not contain whitespace")


def claude_session_exists(session_id: str) -> bool:
    if not re.fullmatch(r"[0-9a-f-]{36}", session_id):
        return False
    project_root = Path.home() / ".claude" / "projects"
    return any(project_root.rglob(f"{session_id}.jsonl")) if project_root.exists() else False


@lru_cache(maxsize=2048)
def codex_session_exists(session_id: str) -> bool:
    if not re.fullmatch(r"[0-9a-f-]{36}", session_id):
        return False
    try:
        with CODEX_SESSION_INDEX_PATH.open() as index:
            for line in index:
                if line.strip() and json.loads(line).get("id") == session_id:
                    return True
    except (OSError, json.JSONDecodeError):
        pass
    if not CODEX_SESSIONS_DIR.exists():
        return False
    for rollout in CODEX_SESSIONS_DIR.rglob("*.jsonl"):
        try:
            with rollout.open() as handle:
                metadata = json.loads(handle.readline()).get("payload", {})
        except (OSError, json.JSONDecodeError):
            continue
        if metadata.get("session_id") == session_id or metadata.get("id") == session_id:
            return True
    return False


def clean_session_id(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip().strip("'\"`;,)")
    if not cleaned or cleaned.startswith("-") or any(ch.isspace() for ch in cleaned):
        return None
    return cleaned


def default_resume_command(client: str, session_id: str) -> str:
    quoted_session = shlex.quote(session_id)
    if client == "codex":
        return f"codex resume {quoted_session}"
    if client == "claude":
        return f"claude --resume {quoted_session}"
    raise SystemExit(f"unsupported client: {client}")


def pane_id_matches(item: dict[str, Any], pane_id: str) -> bool:
    return item.get("pane_id") == pane_id


def pane_identity_matches(item: dict[str, Any], pane: PaneInfo) -> bool:
    return (
        item.get("pane_id") == pane.pane_id
        and (item.get("herdr_session") or pane.herdr_session) == pane.herdr_session
    )


def existing_registration_matches(pane: PaneInfo, record: dict[str, Any] | None) -> bool:
    if not record:
        return False
    if record.get("status") not in (None, "active", "restorable"):
        return False
    if not clean_session_id(str(record.get("session_id") or "")):
        return False
    if pane.agent and record.get("client") != pane.agent:
        return False
    record_cwd = normalize_path(record.get("cwd") if isinstance(record.get("cwd"), str) else None)
    pane_cwd = pane.foreground_cwd or pane.cwd
    return record_cwd == pane_cwd


def build_record(
    pane: PaneInfo,
    client: str,
    session_id: str,
    *,
    cwd: str,
    branch: str | None,
    worktree: str | None,
    resume_command: str,
    status: str,
    restore_policy: str,
    restore_source: str = "manifest",
    process_pid: int | None = None,
    process_start: str | None = None,
    evidence: list[str] | None = None,
    observed_at: str | None = None,
) -> dict[str, Any]:
    record = {
        "herdr_session": pane.herdr_session,
        "workspace_label": pane.workspace_label or pane.workspace_id,
        "workspace_id": pane.workspace_id,
        "tab_label": pane.tab_label or pane.tab_id,
        "tab_id": pane.tab_id,
        "pane_label": pane.label or pane.pane_id,
        "pane_id": pane.pane_id,
        "session_id": session_id,
        "agent_status": pane.agent_status,
        "branch": branch,
        "client": client,
        "cwd": cwd,
        "foreground_cwd": pane.foreground_cwd,
        "label": pane.label,
        "restore_policy": restore_policy,
        "resume_command": resume_command,
        "status": status,
        "updated_at": now_iso(),
        "worktree": worktree,
    }
    if restore_source != "manifest":
        record.update(
            {
                "restore_source": restore_source,
                "process_pid": process_pid,
                "process_start": process_start,
                "evidence": list(evidence or []),
                "observed_at": observed_at or now_iso(),
            }
        )
    return record


def register(args: argparse.Namespace) -> int:
    validate_session_id(args.session_id)
    if args.client == "claude" and not claude_session_exists(args.session_id):
        print("Claude session ID is not present in the local session store", file=sys.stderr)
        return 2
    pane = current_pane_info()
    if not pane and not args.allow_no_herdr:
        print("not inside a reachable herdr pane; use --allow-no-herdr with explicit ids", file=sys.stderr)
        return 2
    if not pane:
        if not (args.pane_id and args.workspace_id and args.tab_id):
            print(
                "explicit --pane-id, --workspace-id, and --tab-id are required with --allow-no-herdr",
                file=sys.stderr,
            )
            return 2
        pane = PaneInfo(
            herdr_session=args.herdr_session or current_herdr_session(),
            pane_id=args.pane_id,
            workspace_id=args.workspace_id,
            tab_id=args.tab_id,
            cwd=normalize_path(args.cwd),
            foreground_cwd=normalize_path(args.cwd),
        )

    cwd = normalize_path(args.cwd) or pane.foreground_cwd or pane.cwd or normalize_path(os.getcwd())
    if not cwd:
        raise SystemExit("unable to determine cwd")
    worktree, branch = git_context(cwd)
    path = manifest_path(args)
    with manifest_lock(path):
        data = read_manifest(path)
        record = build_record(
            pane,
            args.client,
            args.session_id,
            cwd=cwd,
            branch=args.branch or branch,
            worktree=args.worktree or worktree,
            resume_command=args.resume_command or default_resume_command(args.client, args.session_id),
            status=args.status,
            restore_policy=args.restore_policy,
        )
        panes = [item for item in data["panes"] if not pane_identity_matches(item, pane)]
        panes.append(record)
        data["panes"] = sorted(panes, key=lambda item: str(item.get("pane_id", "")))
        write_manifest(path, data)
    print(f"registered {args.client} -> {pane.pane_id}")
    print(f"manifest: {path}")
    return 0


def list_records(args: argparse.Namespace) -> int:
    path = manifest_path(args)
    data = read_manifest(path)
    print(f"manifest: {path}")
    if getattr(args, "show_session_ids", False):
        print("session IDs shown because --show-session-ids was explicitly requested")
    else:
        print("session IDs redacted; pass --show-session-ids for manual repair")
    if not data["panes"]:
        print("no registered herdr agent panes")
        return 0
    for item in data["panes"]:
        if args.client and item.get("client") != args.client:
            continue
        if args.status and item.get("status") != args.status:
            continue
        if args.workspace_id and item.get("workspace_id") != args.workspace_id:
            continue
        print(
            "\t".join(
                [
                    str(item.get("herdr_session") or ""),
                    str(item.get("pane_id", "")),
                    str(item.get("workspace_id", "")),
                    str(item.get("tab_id", "")),
                    str(item.get("client", "")),
                    str(item.get("status", "")),
                    str(item.get("session_id", "") if getattr(args, "show_session_ids", False) else "[redacted]"),
                    str(item.get("cwd", "")),
                ]
            )
        )
    return 0


def remove_record(args: argparse.Namespace) -> int:
    herdr_session = args.herdr_session or current_herdr_session()
    if not herdr_session:
        print("--herdr-session or HERDR_SESSION is required to remove a pane safely", file=sys.stderr)
        return 2
    path = manifest_path(args)
    with manifest_lock(path):
        data = read_manifest(path)
        before = len(data["panes"])
        data["panes"] = [
            item
            for item in data["panes"]
            if not (
                item.get("pane_id") == args.pane_id
                and (item.get("herdr_session") or herdr_session) == herdr_session
            )
        ]
        if len(data["panes"]) == before:
            print(f"pane not found: {args.pane_id}", file=sys.stderr)
            return 1
        write_manifest(path, data)
    print(f"removed {args.pane_id}")
    return 0


def capture_missing(args: argparse.Namespace) -> int:
    pane = current_pane_info()
    if not pane and not args.allow_no_herdr:
        print("not inside a reachable herdr pane; use --allow-no-herdr with explicit ids", file=sys.stderr)
        return 2
    if not pane:
        if not (args.pane_id and args.workspace_id and args.tab_id):
            print(
                "explicit --pane-id, --workspace-id, and --tab-id are required with --allow-no-herdr",
                file=sys.stderr,
            )
            return 2
        pane = PaneInfo(
            herdr_session=args.herdr_session or current_herdr_session(),
            pane_id=args.pane_id,
            workspace_id=args.workspace_id,
            tab_id=args.tab_id,
            cwd=normalize_path(args.cwd),
            foreground_cwd=normalize_path(args.cwd),
        )

    cwd = normalize_path(args.cwd) or pane.foreground_cwd or pane.cwd or normalize_path(os.getcwd())
    if not cwd:
        raise SystemExit("unable to determine cwd")
    worktree, branch = git_context(cwd)
    item = {
        "herdr_session": pane.herdr_session,
        "workspace_label": pane.workspace_label or pane.workspace_id,
        "workspace_id": pane.workspace_id,
        "tab_label": pane.tab_label or pane.tab_id,
        "tab_id": pane.tab_id,
        "pane_label": pane.label or pane.pane_id,
        "pane_id": pane.pane_id,
        "session_id": "",
        "branch": args.branch or branch,
        "client": args.client,
        "cwd": cwd,
        "label": pane.label,
        "reason": args.reason or "session_id unknown; fill it and apply later",
        "register": True,
        "restore_policy": args.restore_policy,
        "status": args.status,
        "updated_at": now_iso(),
        "worktree": args.worktree or worktree,
    }
    path = missing_json_path(args)
    write_missing_json(path, [item])
    print(f"missing-session JSON: {path}")
    return 0


def capture_patterns(client: str) -> list[str]:
    if client == "codex":
        return [
            rf"\bcodex-r\s+{SESSION_TOKEN}",
            rf"\bcodex\s+resume\s+{SESSION_TOKEN}",
        ]
    if client == "claude":
        return [
            rf"\bclaude-r\s+{SESSION_TOKEN}",
            rf"\bclaude(?:\s+code)?\s+resume\s+{SESSION_TOKEN}",
            rf"\bclaude(?:\s+code)?\s+--resume\s+{SESSION_TOKEN}",
            rf"\bclaude(?:\s+code)?\s+--session-id\s+{SESSION_TOKEN}",
        ]
    return []


def detect_from_capture(pane: PaneInfo, *, lines: int, source: str) -> tuple[str, str] | None:
    client = pane.agent if pane.agent in {"codex", "claude"} else None
    if not client:
        return None
    text = pane_read_text(pane.pane_id, lines=lines, source=source)
    if not text:
        return None
    for pattern in capture_patterns(client):
        matches = list(re.finditer(pattern, text))
        if matches:
            session_id = clean_session_id(matches[-1].group(1))
            if session_id:
                return client, session_id
    return None


def detect_from_process(pane: PaneInfo) -> tuple[str, str] | None:
    client = pane.agent if pane.agent in {"codex", "claude"} else None
    if not client:
        return None
    if client == "codex":
        pattern = rf"(?:^|/)(?:codex)(?:\s+[^\s]+)?\s+resume\s+{SESSION_TOKEN}"
    else:
        pattern = rf"(?:^|/)(?:claude)(?:\s+code)?\s+(?:resume|--resume|--session-id)\s+{SESSION_TOKEN}"
    for pid, command in pane_process_entries(pane.pane_id):
        match = re.search(pattern, command)
        if match:
            session_id = clean_session_id(match.group(1))
            if session_id:
                return client, session_id
        if client == "claude" and pid is not None and command.strip() == "claude":
            session_path = Path.home() / ".claude" / "sessions" / f"{pid}.json"
            try:
                session_data = json.loads(session_path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            session_id = session_data.get("sessionId") if isinstance(session_data, dict) else None
            session_cwd = session_data.get("cwd") if isinstance(session_data, dict) else None
            pane_cwd = pane.foreground_cwd or pane.cwd
            if (
                isinstance(session_id, str)
                and isinstance(session_cwd, str)
                and normalize_path(session_cwd) == normalize_path(pane_cwd)
            ):
                return client, session_id
    return None


def detect_from_status(pane: PaneInfo, *, lines: int) -> tuple[str, str] | None:
    if pane.agent not in {"codex", "claude"} or pane.agent_status not in {"idle", "done"}:
        log_status_event(pane, "skipped", reason="pane_not_ready_or_not_supported")
        return None
    if not pane_send_status(pane.pane_id):
        log_status_event(pane, "send_failed", command="/status")
        return None
    log_status_event(pane, "sent", command="/status")
    for attempt in range(1, 7):
        text = pane_read_text(pane.pane_id, lines=lines, source="recent-unwrapped")
        if text:
            match = re.search(r"\bSession(?:\s+ID)?\s*:\s*([A-Za-z0-9][A-Za-z0-9._:-]{5,})", text)
            if match:
                session_id = clean_session_id(match.group(1))
                if session_id:
                    log_status_event(pane, "found", session_id=session_id, poll_attempt=attempt)
                    return pane.agent, session_id
        time.sleep(0.4)
    log_status_event(pane, "not_found", poll_attempts=6)
    return None


def write_missing_json(path: Path, items: list[dict[str, Any]]) -> None:
    payload = {
        "version": 1,
        "updated_at": now_iso(),
        "instructions": [
            "Fill session_id for rows you want to register, keep register=true,",
            "then run: herdr-agent-apply-missing",
        ],
        "items": items,
    }
    atomic_write_private(path, json.dumps(payload, indent=2) + "\n")


def running_named_session_sockets() -> list[tuple[str, str]]:
    """Return running session names and socket paths from the global session list."""
    data = run_json(["herdr", "session", "list", "--json"])
    if not data:
        return []
    result = data.get("result")
    sessions = data.get("sessions")
    if isinstance(result, dict):
        sessions = result.get("sessions", sessions)
    if not isinstance(sessions, list):
        return []
    found: list[tuple[str, str]] = []
    for session in sessions:
        if not isinstance(session, dict):
            continue
        name = session.get("name")
        if name == "default" or session.get("default") is True or session.get("is_default") is True:
            continue
        running = (
            session.get("running") is True
            or session.get("status") == "running"
            or session.get("state") == "running"
        )
        socket_path = session.get("socket_path")
        if not isinstance(socket_path, str) or not socket_path:
            session_dir = session.get("session_dir")
            socket_path = str(Path(session_dir) / "herdr.sock") if isinstance(session_dir, str) and session_dir else None
        if isinstance(name, str) and name and running and isinstance(socket_path, str) and socket_path:
            found.append((name, socket_path))
    return sorted(set(found))


def print_no_panes_guidance() -> None:
    """Explain how a plain shell can target one attached named Herdr session."""
    print("no herdr panes found; is a herdr session running?", file=sys.stderr)
    print("This scan only sees the Herdr session this shell is attached to.", file=sys.stderr)
    print("Find running named sessions and socket paths with: herdr session list --json", file=sys.stderr)
    sessions = running_named_session_sockets()
    if sessions:
        print("Running named sessions:", file=sys.stderr)
        for name, socket_path in sessions:
            print(f"  {name} {socket_path}", file=sys.stderr)
            print(
                "  "
                f"HERDR_SESSION={shlex.quote(name)} "
                f"HERDR_SOCKET_PATH={shlex.quote(socket_path)} "
                "herdr-agent-capture-history",
                file=sys.stderr,
            )
    print("The default Herdr session is not supported for recovery.", file=sys.stderr)
    print("Or run herdr-agent-capture-history inside an existing pane of that session.", file=sys.stderr)


def print_verifier_guidance(*, diagnostic: bool = False) -> None:
    """Give verifier-safe session guidance without exposing socket paths."""
    print("The verifier requires one explicitly named, running, non-default Herdr session.", file=sys.stderr)
    print("Use --herdr-session <name>, or attach to the named session before retrying.", file=sys.stderr)
    sessions = running_named_session_sockets()
    if not sessions:
        print("List running session names with: herdr session list --json", file=sys.stderr)
        return
    print("Running named sessions:", file=sys.stderr)
    for name, socket_path in sessions:
        print(f"  {name}", file=sys.stderr)
        if diagnostic:
            print(f"    socket: {socket_path}", file=sys.stderr)
            print(
                f"    HERDR_SESSION={shlex.quote(name)} HERDR_SOCKET_PATH={shlex.quote(socket_path)} "
                "herdr-agent-verify-identity",
                file=sys.stderr,
            )


def verifier_panes(herdr_session: str | None) -> list[dict[str, Any]]:
    """Return one structural pane snapshot enriched with process metadata."""
    panes = snapshot_panes()
    enriched: list[dict[str, Any]] = []
    for pane in panes:
        if herdr_session and pane.herdr_session and pane.herdr_session != herdr_session:
            continue
        value = {
            "pane_id": pane.pane_id,
            "workspace_id": pane.workspace_id,
            "workspace_label": pane.workspace_label,
            "tab_id": pane.tab_id,
            "tab_label": pane.tab_label,
            "label": pane.label,
            "agent": pane.agent,
            "agent_status": pane.agent_status,
            "cwd": pane.cwd,
            "foreground_cwd": pane.foreground_cwd,
            "agent_session": pane.agent_session,
        }
        process_data = run_json(["herdr", "pane", "process-info", "--pane", pane.pane_id])
        if process_data:
            result = process_data.get("result")
            process_info = result.get("process_info") if isinstance(result, dict) else None
            if isinstance(process_info, dict) and isinstance(process_info.get("foreground_processes"), list):
                value["foreground_processes"] = process_info["foreground_processes"]
        enriched.append(value)
    return enriched


def _verifier_source(status: str) -> str:
    return {
        "native_verified": "verifier_native",
        "argv_verified": "verifier_argv",
        "handle_verified": "verifier_handle",
        "pid_record_verified": "verifier_pid_record",
    }.get(status, "unavailable")


def _verified_record(pane: dict[str, Any], result: dict[str, Any]) -> dict[str, Any] | None:
    candidate = result.get("candidate")
    if not isinstance(candidate, IdentityCandidate):
        return None
    cwd = candidate.cwd or normalize_path(pane.get("foreground_cwd") or pane.get("cwd"))
    if not cwd:
        return None
    worktree, branch = git_context(cwd)
    pane_info = PaneInfo(
        herdr_session=pane.get("herdr_session") if isinstance(pane.get("herdr_session"), str) else current_herdr_session(),
        pane_id=str(pane.get("pane_id", "")),
        workspace_id=str(pane.get("workspace_id", "")),
        tab_id=str(pane.get("tab_id", "")),
        cwd=normalize_path(pane.get("cwd")),
        foreground_cwd=cwd,
        agent=pane.get("agent") if isinstance(pane.get("agent"), str) else None,
        agent_status=pane.get("agent_status") if isinstance(pane.get("agent_status"), str) else None,
        label=pane.get("label") if isinstance(pane.get("label"), str) else None,
        workspace_label=pane.get("workspace_label") if isinstance(pane.get("workspace_label"), str) else None,
        tab_label=pane.get("tab_label") if isinstance(pane.get("tab_label"), str) else None,
    )
    return build_record(
        pane_info,
        candidate.client,
        candidate.session_id,
        cwd=cwd,
        branch=branch,
        worktree=worktree,
        resume_command=default_resume_command(candidate.client, candidate.session_id),
        status="active",
        restore_policy="verified",
        restore_source=_verifier_source(str(result.get("status"))),
        process_pid=candidate.pid,
        process_start=candidate.process_start,
        evidence=list(candidate.evidence),
        observed_at=candidate.observed_at,
    )


def _pane_matches_snapshot(original: dict[str, Any], current: dict[str, Any]) -> bool:
    for key in ("pane_id", "agent", "foreground_cwd", "cwd"):
        if key in original and key in current:
            old = normalize_path(original.get(key)) if key in {"cwd", "foreground_cwd"} else original.get(key)
            new = normalize_path(current.get(key)) if key in {"cwd", "foreground_cwd"} else current.get(key)
            if old != new:
                return False
    def process_identity(pane: dict[str, Any]) -> tuple[object, object]:
        client = pane.get("agent")
        processes = pane.get("foreground_processes") or []
        matches = []
        if isinstance(processes, list):
            for item in processes:
                if not isinstance(item, dict) or not isinstance(item.get("pid"), int):
                    continue
                argv = item.get("argv")
                if not isinstance(argv, list) and isinstance(item.get("cmdline"), str):
                    try:
                        argv = shlex.split(item["cmdline"])
                    except ValueError:
                        argv = []
                executable = Path(str(argv[0])).name if isinstance(argv, list) and argv else ""
                if executable == client:
                    matches.append(item)
        if len(matches) != 1:
            return None, None
        item = matches[0]
        marker = next(
            (str(item[key]) for key in ("process_start", "processStart", "start_marker", "startMarker", "procStart", "proc_start", "start_time", "startTime") if item.get(key) is not None),
            None,
        )
        return item.get("pid"), marker

    old_pid, old_marker = process_identity(original)
    new_pid, new_marker = process_identity(current)
    if old_pid is None or new_pid is None or old_pid != new_pid:
        return False
    return old_marker == new_marker


def _candidate_observation_matches(expected: object, actual: object) -> bool:
    if not isinstance(expected, IdentityCandidate) or not isinstance(actual, IdentityCandidate):
        return False
    if (expected.client, expected.session_id, expected.pid) != (actual.client, actual.session_id, actual.pid):
        return False
    if expected.process_start or actual.process_start:
        return expected.process_start == actual.process_start
    return True


def verify_identity(args: argparse.Namespace) -> int:
    herdr_session = args.herdr_session or current_herdr_session()
    if not herdr_session or herdr_session == "default":
        print("HERDR_SESSION or --herdr-session is required; attach a named non-default Herdr session first", file=sys.stderr)
        print_verifier_guidance(diagnostic=getattr(args, "diagnostic_session_paths", False))
        return 2
    # Herdr's CLI resolves the named socket from this environment variable.
    # The command is short-lived, so setting it here does not alter the caller.
    os.environ["HERDR_SESSION"] = herdr_session
    panes = verifier_panes(herdr_session)
    if not panes:
        print(f"No panes found in named Herdr session {herdr_session!r}.", file=sys.stderr)
        print_verifier_guidance(diagnostic=getattr(args, "diagnostic_session_paths", False))
        return 1
    results: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for pane in panes:
        if pane.get("agent") not in {"codex", "claude"}:
            continue
        if args.client and pane.get("agent") != args.client:
            continue
        result = verify_pane(pane)
        results.append((pane, result))
        workspace = pane.get("workspace_label") or "[workspace]"
        tab = pane.get("tab_label") or "[tab]"
        label = pane.get("label") or "[pane]"
        evidence = ",".join(result.get("evidence") or []) or "none"
        pane_id = pane.get("pane_id") or "[pane-id]"
        line = f"{result.get('status', 'unresolved')} workspace={workspace!r} tab={tab!r} pane={label!r} pane_id={pane_id} candidates={result.get('candidate_count', 0)} evidence={evidence}"
        if args.show_session_ids and isinstance(result.get("candidate"), IdentityCandidate):
            line += f" session_id={result['candidate'].session_id}"
        print(line)
        if result.get("status") not in {"native_verified", "argv_verified", "handle_verified", "pid_record_verified"}:
            print(f"  hint: {result.get('hint', 'manual confirmation required')}")

    verified = [(pane, result) for pane, result in results if result.get("status", "").endswith("_verified")]
    if args.apply and verified:
        manifest = manifest_path(args)
        initially_checked: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for original, result in verified:
            current = next((pane for pane in verifier_panes(herdr_session) if pane.get("pane_id") == original.get("pane_id")), None)
            if not current or not _pane_matches_snapshot(original, current):
                print("  hint: skipped one candidate because the live pane changed before apply")
                continue
            current_result = verify_pane(current)
            if (
                current_result.get("status") != result.get("status")
                or not _pane_matches_snapshot(original, current)
                or not _candidate_observation_matches(result.get("candidate"), current_result.get("candidate"))
            ):
                print("  hint: skipped one candidate because the live identity changed before apply")
                continue
            initially_checked.append((original, result))

        # This is the final Herdr read.  Build every record from this one
        # snapshot and perform no further Herdr reads before the manifest write.
        final_snapshot = verifier_panes(herdr_session) if initially_checked else []
        final_by_pane = {pane.get("pane_id"): pane for pane in final_snapshot}
        records: list[dict[str, Any]] = []
        for original, result in initially_checked:
            current = final_by_pane.get(original.get("pane_id"))
            if not current or not _pane_matches_snapshot(original, current):
                print("  hint: discarded one candidate because the final live pane changed")
                continue
            final_result = verify_pane(current)
            if (
                final_result.get("status") != result.get("status")
                or not _candidate_observation_matches(result.get("candidate"), final_result.get("candidate"))
            ):
                print("  hint: discarded one candidate because the final live identity changed")
                continue
            record = _verified_record(current, final_result)
            if record:
                records.append(record)
        if records:
            with manifest_lock(manifest):
                data = read_manifest(manifest)
                identities = {(record.get("herdr_session"), record.get("pane_id")) for record in records}
                data["panes"] = [item for item in data["panes"] if (item.get("herdr_session") or herdr_session, item.get("pane_id")) not in identities]
                data["panes"].extend(records)
                data["panes"].sort(key=lambda item: (str(item.get("herdr_session", "")), str(item.get("pane_id", ""))))
                write_manifest(manifest, data)
            print(f"applied verified registrations: {len(records)}")
        else:
            print("applied verified registrations: 0")
    elif not args.apply:
        print(f"report-only: {len(verified)} verified pane(s); no registry writes")
    return 0


def scan(args: argparse.Namespace) -> int:
    panes = snapshot_panes()
    if not panes:
        print_no_panes_guidance()
        return 1

    herdr_session = current_herdr_session()
    if not herdr_session:
        print("HERDR_SESSION is not set; attach a named Herdr session first", file=sys.stderr)
        return 2
    manifest_by_pane = existing_records_by_pane(manifest_path(args), herdr_session=herdr_session)
    records: list[dict[str, Any]] = []
    missing_items: list[dict[str, Any]] = []
    already_registered = 0
    skipped = 0

    for pane in panes:
        client = pane.agent if pane.agent in {"codex", "claude"} else None
        if args.client and client != args.client:
            continue
        if not client:
            skipped += 1
            if args.verbose:
                print(f"SKIP {pane.pane_id} no codex/claude agent")
            continue

        existing_record = manifest_by_pane.get((herdr_session, pane.pane_id))
        if existing_registration_matches(pane, existing_record):
            already_registered += 1
            print(f"KEEP {pane.pane_id} {client} existing registration kept")
            continue

        detection = detect_from_native(pane)
        detection_source = "native"
        if not detection:
            detection = detect_from_process(pane)
            detection_source = "process"
        if not detection and args.status:
            detection = detect_from_status(pane, lines=max(args.lines, 120))
            detection_source = "status"
        if not detection:
            detection = detect_from_capture(
                pane,
                lines=args.lines,
                source=args.source,
            )
            detection_source = "capture"
        pane_cwd = pane.foreground_cwd or pane.cwd or normalize_path(os.getcwd())
        if detection and pane_cwd:
            _client, session_id = detection
            worktree, branch = git_context(pane_cwd)
            record = build_record(
                pane,
                client,
                session_id,
                cwd=pane_cwd,
                branch=branch,
                worktree=worktree,
                resume_command=default_resume_command(client, session_id),
                status="active",
                restore_policy="manual_confirm",
            )
            records.append(record)
            print(f"FOUND {pane.pane_id} {client} source={detection_source}")
            continue

        missing_items.append(
            {
                "herdr_session": pane.herdr_session,
                "workspace_label": pane.workspace_label or pane.workspace_id,
                "workspace_id": pane.workspace_id,
                "tab_label": pane.tab_label or pane.tab_id,
                "tab_id": pane.tab_id,
                "pane_label": pane.label or pane.pane_id,
                "pane_id": pane.pane_id,
                "session_id": "",
                "branch": git_context(pane_cwd)[1] if pane_cwd else None,
                "client": client,
                "cwd": pane_cwd,
                "label": pane.label,
                "reason": (
                    "no session id found in foreground process metadata, /status response, or pane scrollback"
                    if args.status
                    else "resume session id not visible in pane scrollback or foreground process metadata"
                ),
                "register": True,
                "restore_policy": "manual_confirm",
                "status": "active",
                "updated_at": now_iso(),
                "worktree": git_context(pane_cwd)[0] if pane_cwd else None,
            }
        )
        workspace_label = pane.workspace_label or pane.workspace_id
        tab_label = pane.tab_label or pane.tab_id
        pane_label = pane.label or pane.pane_id
        print(
            f"NEEDS-ID {pane.pane_id} {client} "
            f"workspace={workspace_label!r} tab={tab_label!r} pane={pane_label!r} "
            f"cwd={pane_cwd or ''}"
        )

    path = manifest_path(args)
    if args.execute and records:
        with manifest_lock(path):
            data = read_manifest(path)
            # Pane IDs are scoped to a named Herdr session. Replacing by pane
            # ID alone can erase another session's w1:p1 registration.
            identities = {(record.get("herdr_session"), record["pane_id"]) for record in records}
            panes_out = [
                item
                for item in data["panes"]
                if (item.get("herdr_session") or herdr_session, item.get("pane_id")) not in identities
            ]
            panes_out.extend(records)
            data["panes"] = sorted(
                panes_out, key=lambda item: (str(item.get("herdr_session", "")), str(item.get("pane_id", "")))
            )
            write_manifest(path, data)
        print(f"registered {len(records)} pane(s)")
    elif not args.execute:
        print(f"dry-run: {len(records)} pane(s) would be registered")

    if missing_items:
        print(f"unresolved panes needing manual session id: {len(missing_items)}")
        if not args.no_missing_json:
            missing_path = missing_json_path(args)
            write_missing_json(missing_path, missing_items)
            print(f"missing-session JSON: {missing_path}")
            print("fill session_id values, then run: herdr-agent-apply-missing")
    if already_registered:
        print(f"already registered panes kept: {already_registered}")
    if skipped:
        print(f"skipped panes: {skipped}")
    if args.execute:
        print(f"manifest: {path}")
    else:
        print("write manifest: herdr-agent-autoregister")
    return 0


def apply_missing(args: argparse.Namespace) -> int:
    source_path = missing_json_path(args)
    ensure_private_file(source_path, default_state_dir=DEFAULT_STATE_DIR)
    if not source_path.exists():
        print(f"missing-session JSON not found: {source_path}", file=sys.stderr)
        return 1
    try:
        payload = json.loads(source_path.read_text())
    except json.JSONDecodeError as exc:
        print(f"missing-session JSON is not valid: {source_path}: {exc}", file=sys.stderr)
        return 1
    items = payload.get("items")
    if not isinstance(items, list):
        print(f"missing-session JSON must contain an items list: {source_path}", file=sys.stderr)
        return 1

    path = manifest_path(args)
    records: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if not item.get("register", True):
            continue
        client = item.get("client")
        session_id = item.get("session_id")
        pane_id = item.get("pane_id")
        workspace_id = item.get("workspace_id")
        tab_id = item.get("tab_id")
        cwd = normalize_path(item.get("cwd") if isinstance(item.get("cwd"), str) else None)
        if client not in {"codex", "claude"} or not isinstance(session_id, str) or not session_id.strip():
            continue
        if not all(isinstance(v, str) and v for v in [pane_id, workspace_id, tab_id]):
            continue
        validate_session_id(session_id)
        pane = PaneInfo(
            herdr_session=item.get("herdr_session") if isinstance(item.get("herdr_session"), str) else current_herdr_session(),
            pane_id=pane_id,
            workspace_id=workspace_id,
            tab_id=tab_id,
            cwd=cwd,
            foreground_cwd=cwd,
            label=(
                item.get("pane_label")
                if isinstance(item.get("pane_label"), str)
                else item.get("label") if isinstance(item.get("label"), str) else None
            ),
            workspace_label=item.get("workspace_label") if isinstance(item.get("workspace_label"), str) else None,
            tab_label=item.get("tab_label") if isinstance(item.get("tab_label"), str) else None,
        )
        records.append(
            build_record(
                pane,
                client,
                session_id,
                cwd=cwd or normalize_path(os.getcwd()) or os.getcwd(),
                branch=item.get("branch") if isinstance(item.get("branch"), str) else None,
                worktree=item.get("worktree") if isinstance(item.get("worktree"), str) else None,
                resume_command=(
                    item.get("resume_command")
                    if isinstance(item.get("resume_command"), str) and item.get("resume_command")
                    else default_resume_command(client, session_id)
                ),
                status=item.get("status") if isinstance(item.get("status"), str) else "active",
                restore_policy=(
                    item.get("restore_policy")
                    if isinstance(item.get("restore_policy"), str) and item.get("restore_policy")
                    else "manual_confirm"
                ),
            )
        )

    if not records:
        print(f"no rows with filled session_id found in {source_path}")
        return 0

    with manifest_lock(path):
        data = read_manifest(path)
        identities = {(record.get("herdr_session"), record["pane_id"]) for record in records}
        panes = [
            item
            for item in data["panes"]
            if (item.get("herdr_session") or current_herdr_session(), item.get("pane_id"))
            not in identities
        ]
        panes.extend(records)
        data["panes"] = sorted(panes, key=lambda item: str(item.get("pane_id", "")))
        if args.execute:
            write_manifest(path, data)
            print(f"registered {len(records)} pane(s) from {source_path}")
            try:
                source_path.unlink()
                print(f"removed missing-session JSON: {source_path}")
            except OSError as exc:
                print(f"warning: could not remove missing-session JSON {source_path}: {exc}", file=sys.stderr)
        else:
            print(f"dry-run: {len(records)} pane(s) would be registered from {source_path}")
    print(f"manifest: {path}")
    return 0


def print_path(args: argparse.Namespace) -> int:
    print(manifest_path(args))
    return 0


def normalize_manifest(args: argparse.Namespace) -> int:
    path = manifest_path(args)
    herdr_session = args.herdr_session or current_herdr_session()
    with manifest_lock(path):
        data = read_manifest(path)
        if herdr_session:
            for item in data["panes"]:
                if isinstance(item, dict) and not item.get("herdr_session"):
                    item["herdr_session"] = herdr_session
        write_manifest(path, data)
    print(f"normalized manifest: {path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", help="override manifest path")
    parser.add_argument("--missing-json", help="override missing-session JSON path")
    sub = parser.add_subparsers(dest="command", required=True)

    register_parser = sub.add_parser("register", help="register current herdr pane")
    register_parser.add_argument("--client", required=True, choices=["codex", "claude"])
    register_parser.add_argument("--session-id", required=True)
    register_parser.add_argument("--cwd")
    register_parser.add_argument("--worktree")
    register_parser.add_argument("--branch")
    register_parser.add_argument("--resume-command")
    register_parser.add_argument("--status", default="active")
    register_parser.add_argument("--restore-policy", default="manual_confirm")
    register_parser.add_argument("--allow-no-herdr", action="store_true")
    register_parser.add_argument("--pane-id")
    register_parser.add_argument("--workspace-id")
    register_parser.add_argument("--tab-id")
    register_parser.add_argument("--herdr-session")

    list_parser = sub.add_parser("list", help="list registered panes")
    list_parser.add_argument("--client", choices=["codex", "claude"])
    list_parser.add_argument("--status")
    list_parser.add_argument("--workspace-id")
    list_parser.add_argument(
        "--show-session-ids", action="store_true", help="Explicitly show private session IDs for manual repair."
    )

    remove_parser = sub.add_parser("remove", help="remove one pane registration")
    remove_parser.add_argument("pane_id")
    remove_parser.add_argument("--herdr-session")

    path_parser = sub.add_parser("path", help="print manifest path")
    path_parser.set_defaults(func=print_path)

    normalize_parser = sub.add_parser("normalize", help="rewrite manifest fields in canonical order")
    normalize_parser.add_argument("--herdr-session")
    normalize_parser.set_defaults(func=normalize_manifest)

    capture_missing_parser = sub.add_parser("capture-missing", help="write one editable missing-session row")
    capture_missing_parser.add_argument("--client", required=True, choices=["codex", "claude"])
    capture_missing_parser.add_argument("--cwd")
    capture_missing_parser.add_argument("--worktree")
    capture_missing_parser.add_argument("--branch")
    capture_missing_parser.add_argument("--status", default="active")
    capture_missing_parser.add_argument("--restore-policy", default="manual_confirm")
    capture_missing_parser.add_argument("--reason")
    capture_missing_parser.add_argument("--allow-no-herdr", action="store_true")
    capture_missing_parser.add_argument("--pane-id")
    capture_missing_parser.add_argument("--workspace-id")
    capture_missing_parser.add_argument("--tab-id")
    capture_missing_parser.add_argument("--herdr-session")

    apply_missing_parser = sub.add_parser("apply-missing", help="import filled missing-session JSON")
    apply_missing_parser.add_argument("--execute", action="store_true", help="write manifest and remove JSON")

    scan_parser = sub.add_parser("scan", help="scan live herdr panes and register detectable sessions")
    scan_parser.add_argument("--execute", action="store_true", help="write detected panes")
    scan_parser.add_argument("--client", choices=["codex", "claude"])
    scan_parser.add_argument("--lines", type=int, default=400)
    scan_parser.add_argument("--source", default="recent-unwrapped", choices=["visible", "recent", "recent-unwrapped"])
    scan_parser.add_argument("--status", action="store_true", help="query unresolved idle or done panes with /status")
    scan_parser.add_argument("--no-missing-json", action="store_true")
    scan_parser.add_argument("--verbose", action="store_true")

    verify_parser = sub.add_parser(
        "verify-identity",
        help="report or apply independently verified identities for supported panes",
    )
    verify_parser.add_argument("--herdr-session", help="explicit named non-default Herdr session")
    verify_parser.add_argument("--client", choices=["codex", "claude"])
    verify_parser.add_argument("--apply", "--execute", dest="apply", action="store_true", help="write only verified rows after a live re-check")
    verify_parser.add_argument("--show-session-ids", action="store_true", help="explicitly show verified private session ids")
    verify_parser.add_argument("--diagnostic-session-paths", action="store_true", help="explicitly show local Herdr socket paths in guidance")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "register":
        return register(args)
    if args.command == "list":
        return list_records(args)
    if args.command == "remove":
        return remove_record(args)
    if args.command == "capture-missing":
        return capture_missing(args)
    if args.command == "apply-missing":
        return apply_missing(args)
    if args.command == "scan":
        return scan(args)
    if args.command == "verify-identity":
        return verify_identity(args)
    if args.command == "path":
        return print_path(args)
    if args.command == "normalize":
        return normalize_manifest(args)
    parser.error(f"unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
