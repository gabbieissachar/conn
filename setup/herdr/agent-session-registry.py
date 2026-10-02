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
    try:
        path = status_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as handle:
            handle.write(json.dumps(payload) + "\n")
    except OSError:
        # Capture diagnostics must never prevent the registry scan from running.
        pass


def read_manifest(path: Path) -> dict[str, Any]:
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
    path.parent.mkdir(parents=True, exist_ok=True)
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
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(path)


@contextmanager
def manifest_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


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
) -> dict[str, Any]:
    return {
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
    print(f"registered {args.client} {args.session_id} -> {pane.pane_id}")
    print(f"manifest: {path}")
    return 0


def list_records(args: argparse.Namespace) -> int:
    path = manifest_path(args)
    data = read_manifest(path)
    print(f"manifest: {path}")
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
                    str(item.get("session_id", "")),
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
    payload = {
        "version": 1,
        "updated_at": now_iso(),
        "instructions": [
            "Fill session_id for rows you want to register, keep register=true,",
            "then run: herdr-agent-apply-missing",
        ],
        "items": [item],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")
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
    if pane.agent not in {"codex", "claude"} or pane.agent_status != "idle":
        log_status_event(pane, "skipped", reason="pane_not_idle_or_not_supported")
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
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "updated_at": now_iso(),
        "instructions": [
            "Fill session_id for rows you want to register, keep register=true,",
            "then run: herdr-agent-apply-missing",
        ],
        "items": items,
    }
    path.write_text(json.dumps(payload, indent=2) + "\n")


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
    print("For a listed session, run:", file=sys.stderr)
    print(
        "  HERDR_SESSION=<name> HERDR_SOCKET_PATH=<session_dir>/herdr.sock herdr-agent-capture-history",
        file=sys.stderr,
    )
    print("Or run herdr-agent-capture-history inside an existing pane of that session.", file=sys.stderr)


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
            print(f"KEEP {pane.pane_id} {client} {existing_record.get('session_id')} already registered")
            continue

        detection = detect_from_native(pane)
        detection_source = "native_agent_session"
        if not detection:
            detection = detect_from_process(pane)
            detection_source = "process_info"
        if not detection and args.status:
            detection = detect_from_status(pane, lines=max(args.lines, 120))
            detection_source = "status_command"
        if not detection:
            detection = detect_from_capture(
                pane,
                lines=args.lines,
                source=args.source,
            )
            detection_source = "pane_capture"
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
            print(f"FOUND {pane.pane_id} {client} {session_id} source={detection_source}")
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
    scan_parser.add_argument("--status", action="store_true", help="query unresolved idle panes with /status")
    scan_parser.add_argument("--no-missing-json", action="store_true")
    scan_parser.add_argument("--verbose", action="store_true")

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
    if args.command == "path":
        return print_path(args)
    if args.command == "normalize":
        return normalize_manifest(args)
    parser.error(f"unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
