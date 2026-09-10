#!/usr/bin/env python3
"""A small, local organizer for Herdr workspaces.

It deliberately captures layouts and resumable agent identities only. Terminal
processes and scrollback are not preserved. Archiving closes the source
workspace; restoring creates a fresh workspace and rebuilds its tab layouts.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / "state" / "workspace-organizer"
ARCHIVE_DIR = STATE_DIR / "archives"
LIVE_SNAPSHOT_PATH = STATE_DIR / "live-snapshot.json"
AGENT_MANIFEST_PATH = ROOT / "state" / "herdr-agent-sessions.json"
MAX_LAYOUT_PANES = 24
ACTIVE_AGENT_STATUSES = {"working", "blocked"}


class OrganizerError(RuntimeError):
    """An expected error that should be shown without a stack trace."""


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def read_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise OrganizerError(f"Could not parse {path}: {error}") from error


def herdr_prefix(session: str | None) -> list[str]:
    return ["herdr", "--session", session] if session else ["herdr"]


def resolve_session(requested_session: str | None) -> str | None:
    """Use the shell's session, an explicit session, or one unambiguous server."""
    if requested_session or os.environ.get("HERDR_SESSION"):
        return requested_session
    try:
        completed = subprocess.run(
            ["herdr", "session", "list", "--json"], check=False, text=True, capture_output=True
        )
    except FileNotFoundError as error:
        raise OrganizerError("Herdr is not installed or is not on PATH.") from error
    if completed.returncode != 0:
        raise OrganizerError("Could not inspect Herdr sessions. Start Herdr or pass --session <name>.")
    try:
        sessions = json.loads(completed.stdout).get("sessions", [])
    except json.JSONDecodeError as error:
        raise OrganizerError("Herdr returned invalid JSON while listing named sessions.") from error
    running = [str(item["name"]) for item in sessions if item.get("running") and item.get("name")]
    if len(running) == 1:
        return running[0]
    if not running:
        raise OrganizerError("No Herdr server is running. Start Herdr, then run this command again.")
    choices = ", ".join(running)
    raise OrganizerError(f"Multiple Herdr sessions are running ({choices}). Re-run with --session <name>.")


def run_json(arguments: list[str], session: str | None) -> dict[str, Any]:
    command = herdr_prefix(session) + arguments
    try:
        completed = subprocess.run(command, check=False, text=True, capture_output=True)
    except FileNotFoundError as error:
        raise OrganizerError("Herdr is not installed or is not on PATH.") from error

    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "unknown Herdr error"
        raise OrganizerError(f"{' '.join(command)} failed: {message}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise OrganizerError(
            f"Herdr returned invalid JSON for {' '.join(command)}: {completed.stdout.strip()}"
        ) from error


def result_of(response: dict[str, Any]) -> dict[str, Any]:
    result = response.get("result")
    if not isinstance(result, dict):
        raise OrganizerError("Herdr response did not contain a result object.")
    return result


def configured_socket(session: str | None) -> Path:
    selected_session = session or os.environ.get("HERDR_SESSION")
    config_root = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "herdr"
    if selected_session:
        return config_root / "sessions" / selected_session / "herdr.sock"
    explicit = os.environ.get("HERDR_SOCKET_PATH")
    return Path(explicit) if explicit else config_root / "herdr.sock"


def socket_call(session: str | None, method: str, params: dict[str, Any]) -> dict[str, Any]:
    socket_path = configured_socket(session)
    request = {
        "id": f"pmos-workspace-organizer-{uuid.uuid4().hex}",
        "method": method,
        "params": params,
    }
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(10)
            connection.connect(str(socket_path))
            connection.sendall((json.dumps(request) + "\n").encode())
            with connection.makefile("rb") as stream:
                raw_response = stream.readline()
    except OSError as error:
        raise OrganizerError(f"Could not reach Herdr socket {socket_path}: {error}") from error

    if not raw_response:
        raise OrganizerError(f"Herdr socket {socket_path} closed without a response.")
    try:
        response = json.loads(raw_response)
    except json.JSONDecodeError as error:
        raise OrganizerError("Herdr socket returned invalid JSON.") from error
    if "error" in response:
        details = response["error"]
        message = details.get("message", details) if isinstance(details, dict) else details
        raise OrganizerError(f"Herdr {method} failed: {message}")
    return result_of(response)


def session_snapshot(session: str | None) -> dict[str, Any]:
    return result_of(run_json(["api", "snapshot"], session)).get("snapshot", {})


def leaf_panes(root: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not root:
        return []
    node_type = root.get("type")
    if node_type == "pane":
        return [root]
    if node_type == "split":
        return leaf_panes(root.get("first")) + leaf_panes(root.get("second"))
    raise OrganizerError(f"Unknown layout node type: {node_type!r}")


def workspace_by_id(snapshot: dict[str, Any], workspace_id: str) -> dict[str, Any]:
    for workspace in snapshot.get("workspaces", []):
        if workspace.get("workspace_id") == workspace_id:
            return workspace
    raise OrganizerError(f"Workspace {workspace_id!r} does not exist in this Herdr session.")


def tabs_for_workspace(snapshot: dict[str, Any], workspace_id: str) -> list[dict[str, Any]]:
    # Herdr's snapshot emits tabs in display order. Its `number` field is a
    # user-facing label and does not reliably track a later tab.move operation.
    return [tab for tab in snapshot.get("tabs", []) if tab.get("workspace_id") == workspace_id]


def panes_for_tab(snapshot: dict[str, Any], tab_id: str) -> list[dict[str, Any]]:
    return [pane for pane in snapshot.get("panes", []) if pane.get("tab_id") == tab_id]


def manifest_records() -> list[dict[str, Any]]:
    manifest = read_json(AGENT_MANIFEST_PATH, {"sessions": []})
    sessions = manifest.get("sessions", []) if isinstance(manifest, dict) else []
    return [record for record in sessions if isinstance(record, dict)]


def default_resume_command(client: str, session_id: str) -> str | None:
    shortcuts = ROOT / "agent-session-shortcuts.zsh"
    codex_shortcuts = ROOT.parent / "codex-shortcuts.zsh"
    if client == "codex":
        return f"source {codex_shortcuts} && source {shortcuts} && codex-r {session_id}"
    if client == "claude":
        return f"source {shortcuts} && claude-r {session_id}"
    return None


def agent_restore_records(
    panes: Iterable[dict[str, Any]], session: str | None, records: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    by_pane = {
        record.get("pane_id"): record
        for record in records
        if record.get("pane_id") and record.get("herdr_session") == (session or os.environ.get("HERDR_SESSION"))
    }
    restores: list[dict[str, Any]] = []
    for pane in panes:
        pane_id = pane.get("pane_id")
        agent = pane.get("agent_session") if isinstance(pane.get("agent_session"), dict) else {}
        if not agent and isinstance(pane.get("agent"), dict):
            agent = pane["agent"]
        registered = by_pane.get(pane_id, {})
        client = registered.get("client") or agent.get("client")
        agent_session_id = registered.get("session_id") or agent.get("session_id") or agent.get("value")
        command = registered.get("resume_command")
        if not command and client and agent_session_id:
            command = default_resume_command(str(client), str(agent_session_id))
        resumable = bool(command and client in {"codex", "claude"})
        restores.append(
            {
                "source_pane_id": pane_id,
                "client": client,
                "session_id": agent_session_id,
                "resume_command": command if resumable else None,
                "restore_status": "resumable" if resumable else "shell_only",
            }
        )
    return restores


def capture_workspace(snapshot: dict[str, Any], workspace_id: str, session: str | None) -> dict[str, Any]:
    workspace = workspace_by_id(snapshot, workspace_id)
    records = manifest_records()
    captured_tabs: list[dict[str, Any]] = []
    for position, tab in enumerate(tabs_for_workspace(snapshot, workspace_id)):
        tab_id = str(tab["tab_id"])
        layout_result = socket_call(session, "layout.export", {"tab_id": tab_id})
        layout = layout_result.get("layout")
        if not isinstance(layout, dict):
            raise OrganizerError(f"Herdr did not return a layout for tab {tab_id}.")
        leaves = leaf_panes(layout.get("root"))
        if len(leaves) > MAX_LAYOUT_PANES:
            raise OrganizerError(
                f"Tab {tab_id} has {len(leaves)} panes. Herdr restore accepts at most {MAX_LAYOUT_PANES}."
            )
        panes = panes_for_tab(snapshot, tab_id)
        captured_tabs.append(
            {
                "source_tab_id": tab_id,
                "label": tab.get("label") or tab_id,
                "index": position,
                "focused": bool(tab.get("focused")),
                "layout": layout,
                "agent_restores": agent_restore_records(panes, session, records),
            }
        )
    return {
        "workspace": {
            "source_workspace_id": workspace_id,
            "label": workspace.get("label") or workspace_id,
            "focused": bool(workspace.get("focused")),
            "cwd": workspace.get("cwd"),
        },
        "tabs": captured_tabs,
    }


def capture_selected_tabs(snapshot: dict[str, Any], tab_ids: list[str], session: str | None) -> list[dict[str, Any]]:
    selected_ids = set(tab_ids)
    if len(selected_ids) != len(tab_ids):
        raise OrganizerError("Each --tab value must be unique.")
    known_tabs = {str(tab.get("tab_id")): tab for tab in snapshot.get("tabs", [])}
    missing = [tab_id for tab_id in tab_ids if tab_id not in known_tabs]
    if missing:
        raise OrganizerError(f"Selected tab(s) do not exist: {', '.join(missing)}.")
    records = manifest_records()
    captured: list[dict[str, Any]] = []
    # Preserve display order within each source workspace rather than click order.
    for position, tab in enumerate(snapshot.get("tabs", [])):
        tab_id = str(tab.get("tab_id"))
        if tab_id not in selected_ids:
            continue
        layout_result = socket_call(session, "layout.export", {"tab_id": tab_id})
        layout = layout_result.get("layout")
        if not isinstance(layout, dict):
            raise OrganizerError(f"Herdr did not return a layout for tab {tab_id}.")
        leaves = leaf_panes(layout.get("root"))
        if len(leaves) > MAX_LAYOUT_PANES:
            raise OrganizerError(
                f"Tab {tab_id} has {len(leaves)} panes. Herdr restore accepts at most {MAX_LAYOUT_PANES}."
            )
        captured.append(
            {
                "source_tab_id": tab_id,
                "source_workspace_id": tab.get("workspace_id"),
                "label": tab.get("label") or tab_id,
                "index": position,
                "layout": layout,
                "agent_restores": agent_restore_records(panes_for_tab(snapshot, tab_id), session, records),
            }
        )
    return captured


def active_agents(snapshot: dict[str, Any], workspace_id: str) -> list[dict[str, Any]]:
    tab_ids = {tab.get("tab_id") for tab in tabs_for_workspace(snapshot, workspace_id)}
    return [
        pane
        for pane in snapshot.get("panes", [])
        if pane.get("tab_id") in tab_ids and pane.get("agent_status") in ACTIVE_AGENT_STATUSES
    ]


def archive_summary(archive: dict[str, Any]) -> dict[str, Any]:
    tabs = archive.get("capture", {}).get("tabs", [])
    restores = [restore for tab in tabs for restore in tab.get("agent_restores", [])]
    workspace = archive.get("capture", {}).get("workspace", {})
    return {
        "archive_id": archive.get("archive_id"),
        "status": archive.get("status"),
        "created_at": archive.get("created_at"),
        "archived_at": archive.get("archived_at"),
        "restored_at": archive.get("restored_at"),
        "workspace_label": workspace.get("label"),
        "source_workspace_id": workspace.get("source_workspace_id"),
        "restored_workspace_id": archive.get("restore", {}).get("workspace_id"),
        "tab_count": len(tabs),
        "pane_count": sum(len(leaf_panes(tab.get("layout", {}).get("root"))) for tab in tabs),
        "resumable_pane_count": sum(item.get("restore_status") == "resumable" for item in restores),
        "shell_only_pane_count": sum(item.get("restore_status") != "resumable" for item in restores),
    }


def load_archives() -> list[dict[str, Any]]:
    if not ARCHIVE_DIR.exists():
        return []
    archives = [read_json(path, {}) for path in ARCHIVE_DIR.glob("*.json")]
    return sorted(archives, key=lambda archive: str(archive.get("created_at", "")), reverse=True)


def public_workspace(snapshot: dict[str, Any], workspace: dict[str, Any]) -> dict[str, Any]:
    workspace_id = str(workspace["workspace_id"])
    tabs: list[dict[str, Any]] = []
    for position, tab in enumerate(tabs_for_workspace(snapshot, workspace_id)):
        panes = panes_for_tab(snapshot, str(tab["tab_id"]))
        statuses: dict[str, int] = {}
        for pane in panes:
            status = str(pane.get("agent_status") or "idle")
            statuses[status] = statuses.get(status, 0) + 1
        tabs.append(
            {
                "id": tab.get("tab_id"),
                "label": tab.get("label") or tab.get("tab_id"),
                "index": position,
                "focused": bool(tab.get("focused")),
                "pane_count": len(panes),
                "agent_statuses": statuses,
            }
        )
    return {
        "id": workspace_id,
        "label": workspace.get("label") or workspace_id,
        "focused": bool(workspace.get("focused")),
        "tab_count": len(tabs),
        "pane_count": sum(tab["pane_count"] for tab in tabs),
        "tabs": tabs,
    }


def snapshot_command(args: argparse.Namespace) -> None:
    snapshot = session_snapshot(args.session)
    document = {
        "version": 1,
        "generated_at": now(),
        "herdr_session": args.session or os.environ.get("HERDR_SESSION"),
        "workspaces": [public_workspace(snapshot, workspace) for workspace in snapshot.get("workspaces", [])],
        "archives": [archive_summary(archive) for archive in load_archives()],
    }
    write_json(LIVE_SNAPSHOT_PATH, document)
    print(f"Wrote {LIVE_SNAPSHOT_PATH}")
    print(f"{len(document['workspaces'])} workspaces and {len(document['archives'])} archives available to the organizer.")


def archive_id_for(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "workspace"
    base = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{slug}"
    candidate = base
    sequence = 2
    while (ARCHIVE_DIR / f"{candidate}.json").exists():
        candidate = f"{base}-{sequence}"
        sequence += 1
    return candidate


def require_execute_confirmation(execute: bool, confirmation: str | None, expected: str, action: str) -> None:
    if not execute:
        raise OrganizerError(f"{action} is a preview. Add --execute --confirm {expected!r} to make the change.")
    if confirmation != expected:
        raise OrganizerError(f"{action} requires --confirm {expected!r}.")


def archive_command(args: argparse.Namespace) -> None:
    snapshot = session_snapshot(args.session)
    workspace = workspace_by_id(snapshot, args.workspace)
    active = active_agents(snapshot, args.workspace)
    capture = capture_workspace(snapshot, args.workspace, args.session)
    if active and not args.allow_active:
        raise OrganizerError(
            f"Workspace {args.workspace} has {len(active)} working or blocked agent pane(s). "
            "Resolve them first, or explicitly use --allow-active."
        )
    archive_id = archive_id_for(str(workspace.get("label") or args.workspace))
    summary = {
        "archive_id": archive_id,
        "workspace": capture["workspace"],
        "tab_count": len(capture["tabs"]),
        "pane_count": sum(len(leaf_panes(tab["layout"].get("root"))) for tab in capture["tabs"]),
        "active_agent_panes": len(active),
    }
    if not args.execute:
        print(json.dumps(summary, indent=2))
        print(f"Preview only. Re-run with --execute --confirm {args.workspace!r} to archive this workspace.")
        return

    require_execute_confirmation(args.execute, args.confirm, args.workspace, "Archive")
    archive = {
        "version": 1,
        "archive_id": archive_id,
        "status": "prepared",
        "created_at": now(),
        "herdr_session": args.session or os.environ.get("HERDR_SESSION"),
        "capture": capture,
        "restore": {},
    }
    archive_path = ARCHIVE_DIR / f"{archive_id}.json"
    write_json(archive_path, archive)
    try:
        run_json(["workspace", "close", args.workspace], args.session)
    except OrganizerError as error:
        archive["status"] = "close_failed"
        archive["error"] = str(error)
        write_json(archive_path, archive)
        raise
    archive["status"] = "archived"
    archive["archived_at"] = now()
    write_json(archive_path, archive)
    print(f"Archived workspace {args.workspace} as {archive_id}.")
    print("The original processes were stopped. Restore will create fresh shells and can resume supported agents.")


def archive_by_id(archive_id: str) -> tuple[Path, dict[str, Any]]:
    path = ARCHIVE_DIR / f"{archive_id}.json"
    if not path.exists():
        raise OrganizerError(f"Archive {archive_id!r} was not found.")
    return path, read_json(path, {})


def extract_workspace_id(result: dict[str, Any]) -> str:
    candidates: list[Any] = [result.get("workspace_id")]
    workspace = result.get("workspace")
    if isinstance(workspace, dict):
        candidates.append(workspace.get("id"))
        candidates.append(workspace.get("workspace_id"))
    for candidate in candidates:
        if candidate:
            return str(candidate)
    raise OrganizerError("Herdr did not return the created workspace ID.")


def extract_tab_id(result: dict[str, Any]) -> str:
    candidates: list[Any] = [result.get("tab_id")]
    tab = result.get("tab")
    if isinstance(tab, dict):
        candidates.extend([tab.get("id"), tab.get("tab_id")])
    root_pane = result.get("root_pane")
    if isinstance(root_pane, dict):
        candidates.append(root_pane.get("tab_id"))
    for candidate in candidates:
        if candidate:
            return str(candidate)
    raise OrganizerError("Herdr did not return the initial tab ID for the created workspace.")


def matching_pane_map(source_root: dict[str, Any] | None, target_root: dict[str, Any] | None) -> dict[str, str]:
    source = leaf_panes(source_root)
    target = leaf_panes(target_root)
    if len(source) != len(target):
        raise OrganizerError("Herdr restored a different number of panes than the archive contains.")
    result: dict[str, str] = {}
    for old, new in zip(source, target, strict=True):
        old_id = old.get("pane_id")
        new_id = new.get("pane_id")
        if old_id and new_id:
            result[str(old_id)] = str(new_id)
    return result


def first_cwd(capture: dict[str, Any]) -> str | None:
    for tab in capture.get("tabs", []):
        for pane in leaf_panes(tab.get("layout", {}).get("root")):
            if pane.get("cwd"):
                return str(pane["cwd"])
    return capture.get("workspace", {}).get("cwd")


def resume_agents(
    archive: dict[str, Any], pane_map: dict[str, str], session: str | None
) -> list[dict[str, Any]]:
    return resume_captured_tabs(archive.get("capture", {}).get("tabs", []), pane_map, session)


def resume_captured_tabs(
    captured_tabs: list[dict[str, Any]], pane_map: dict[str, str], session: str | None
) -> list[dict[str, Any]]:
    outcomes: list[dict[str, Any]] = []
    for tab in captured_tabs:
        for restore in tab.get("agent_restores", []):
            old_pane_id = restore.get("source_pane_id")
            new_pane_id = pane_map.get(str(old_pane_id))
            command = restore.get("resume_command")
            if restore.get("restore_status") != "resumable" or not command or not new_pane_id:
                outcomes.append({"source_pane_id": old_pane_id, "status": "skipped"})
                continue
            try:
                run_json(["pane", "send-text", new_pane_id, str(command)], session)
                run_json(["pane", "send-keys", new_pane_id, "Enter"], session)
                outcomes.append({"source_pane_id": old_pane_id, "pane_id": new_pane_id, "status": "sent"})
            except OrganizerError as error:
                outcomes.append(
                    {"source_pane_id": old_pane_id, "pane_id": new_pane_id, "status": "failed", "error": str(error)}
                )
    return outcomes


def move_tabs_command(args: argparse.Namespace) -> None:
    snapshot = session_snapshot(args.session)
    destination = workspace_by_id(snapshot, args.to_workspace)
    captured_tabs = capture_selected_tabs(snapshot, args.tab, args.session)
    same_workspace = [tab["source_tab_id"] for tab in captured_tabs if tab["source_workspace_id"] == args.to_workspace]
    if same_workspace:
        raise OrganizerError(
            f"The destination {args.to_workspace} already contains selected tab(s): {', '.join(same_workspace)}. "
            "Use reorder-tab for tabs that stay in the same workspace."
        )
    selected_ids = {tab["source_tab_id"] for tab in captured_tabs}
    active = [
        pane
        for pane in snapshot.get("panes", [])
        if pane.get("tab_id") in selected_ids and pane.get("agent_status") in ACTIVE_AGENT_STATUSES
    ]
    if active and not args.allow_active:
        raise OrganizerError(
            f"The selected tabs contain {len(active)} working or blocked agent pane(s). "
            "Resolve them first, or explicitly use --allow-active."
        )
    preview = {
        "destination_workspace_id": args.to_workspace,
        "destination_label": destination.get("label") or args.to_workspace,
        "tabs": [
            {
                "tab_id": tab["source_tab_id"],
                "label": tab["label"],
                "source_workspace_id": tab["source_workspace_id"],
                "pane_count": len(leaf_panes(tab["layout"].get("root"))),
            }
            for tab in captured_tabs
        ],
        "active_agent_panes": len(active),
        "processes_preserved": False,
    }
    if not args.execute:
        print(json.dumps(preview, indent=2))
        print(
            "Preview only. Execution rebuilds the selected tabs in the destination, then closes the originals. "
            f"Re-run with --execute --confirm {args.to_workspace!r}."
        )
        return

    require_execute_confirmation(args.execute, args.confirm, args.to_workspace, "Move selected tabs")
    created_tabs: list[dict[str, Any]] = []
    pane_map: dict[str, str] = {}
    try:
        for tab in captured_tabs:
            applied = socket_call(
                args.session,
                "layout.apply",
                {
                    "workspace_id": args.to_workspace,
                    "tab_label": tab["label"],
                    "focus": False,
                    "root": tab["layout"].get("root"),
                },
            )
            new_layout = applied.get("layout")
            if not isinstance(new_layout, dict):
                raise OrganizerError(f"Herdr did not return the rebuilt layout for {tab['label']!r}.")
            pane_map.update(matching_pane_map(tab["layout"].get("root"), new_layout.get("root")))
            created_tabs.append({"source_tab_id": tab["source_tab_id"], "tab_id": new_layout.get("tab_id")})
    except OrganizerError as error:
        created = ", ".join(str(tab.get("tab_id")) for tab in created_tabs) or "none"
        raise OrganizerError(
            f"Move stopped before closing any source tabs. Rebuilt destination tab(s): {created}. {error}"
        ) from error

    closed: list[str] = []
    try:
        for tab in captured_tabs:
            run_json(["tab", "close", tab["source_tab_id"]], args.session)
            closed.append(tab["source_tab_id"])
    except OrganizerError as error:
        raise OrganizerError(
            f"Destination tabs were rebuilt, but only these source tabs were closed: {', '.join(closed) or 'none'}. "
            f"Do not retry blindly. {error}"
        ) from error
    if args.resume_agents:
        outcomes = resume_captured_tabs(captured_tabs, pane_map, args.session)
        failed = [outcome for outcome in outcomes if outcome.get("status") == "failed"]
        if failed:
            raise OrganizerError("Tabs moved, but one or more requested agent resume commands failed.")
    print(f"Moved {len(captured_tabs)} tab(s) into workspace {args.to_workspace}.")
    print("The original tabs were closed and their processes stopped. The destination contains fresh panes.")


def restore_command(args: argparse.Namespace) -> None:
    archive_path, archive = archive_by_id(args.archive)
    status = archive.get("status")
    if status not in {"archived", "restored", "resumed", "restore_partial"}:
        raise OrganizerError(f"Archive {args.archive!r} is in {status!r} state and cannot be restored.")
    if status in {"restored", "resumed"} and not args.force:
        raise OrganizerError("This archive was already restored. Use --force only if you intentionally want another copy.")
    capture = archive.get("capture", {})
    workspace = capture.get("workspace", {})
    if not args.execute:
        print(json.dumps(archive_summary(archive), indent=2))
        print(f"Preview only. Re-run with --execute --confirm {args.archive!r} to restore a new workspace.")
        return

    require_execute_confirmation(args.execute, args.confirm, args.archive, "Restore")
    cwd = first_cwd(capture)
    command = ["workspace", "create", "--label", str(workspace.get("label") or "Restored workspace")]
    if cwd:
        command.extend(["--cwd", cwd])
    created = result_of(run_json(command, args.session))
    workspace_id = extract_workspace_id(created)
    initial_tab_id = extract_tab_id(created)
    restore = {"workspace_id": workspace_id, "started_at": now(), "tabs": [], "agent_resume": []}
    archive["status"] = "restore_partial"
    archive["restore"] = restore
    write_json(archive_path, archive)

    pane_map: dict[str, str] = {}
    try:
        for position, tab in enumerate(capture.get("tabs", [])):
            layout = tab.get("layout", {})
            params = {"tab_label": tab.get("label"), "focus": False, "root": layout.get("root")}
            if position == 0:
                params["tab_id"] = initial_tab_id
            else:
                params["workspace_id"] = workspace_id
            applied = socket_call(
                args.session,
                "layout.apply",
                params,
            )
            new_layout = applied.get("layout")
            if not isinstance(new_layout, dict):
                raise OrganizerError(f"Herdr did not return the rebuilt layout for {tab.get('label')!r}.")
            pane_map.update(matching_pane_map(layout.get("root"), new_layout.get("root")))
            restore["tabs"].append({"source_tab_id": tab.get("source_tab_id"), "tab_id": new_layout.get("tab_id")})
            write_json(archive_path, archive)
        if workspace.get("focused"):
            run_json(["workspace", "focus", workspace_id], args.session)
        if args.resume_agents:
            restore["agent_resume"] = resume_agents(archive, pane_map, args.session)
            failures = [outcome for outcome in restore["agent_resume"] if outcome.get("status") == "failed"]
            archive["status"] = "restore_partial" if failures else "resumed"
        else:
            archive["status"] = "restored"
        restore["completed_at"] = now()
        write_json(archive_path, archive)
    except OrganizerError as error:
        restore["error"] = str(error)
        restore["failed_at"] = now()
        write_json(archive_path, archive)
        raise
    print(f"Restored archive {args.archive} into workspace {workspace_id}.")
    if args.resume_agents:
        print("Supported agent resume commands were sent to the rebuilt panes.")
    else:
        print("Layouts are restored as fresh shells. Re-run with --resume-agents to send supported resume commands.")


def reorder_command(args: argparse.Namespace) -> None:
    snapshot = session_snapshot(args.session)
    tab = next((tab for tab in snapshot.get("tabs", []) if tab.get("tab_id") == args.tab), None)
    if not tab:
        raise OrganizerError(f"Tab {args.tab!r} does not exist in this Herdr session.")
    workspace_id = str(tab.get("workspace_id"))
    tabs = tabs_for_workspace(snapshot, workspace_id)
    if args.index < 0 or args.index >= len(tabs):
        raise OrganizerError(f"--index must be between 0 and {len(tabs) - 1} for workspace {workspace_id}.")
    if not args.execute:
        print(f"Preview: move tab {args.tab} to zero-based index {args.index} in workspace {workspace_id}.")
        print("Re-run with --execute to reorder it. This keeps the tab's processes running.")
        return
    socket_call(args.session, "tab.move", {"tab_id": args.tab, "insert_index": args.index})
    print(f"Moved tab {args.tab} to index {args.index} in workspace {workspace_id}.")


def list_archives_command(_: argparse.Namespace) -> None:
    print(json.dumps([archive_summary(archive) for archive in load_archives()], indent=2))


def parser() -> argparse.ArgumentParser:
    program = argparse.ArgumentParser(description=__doc__)
    program.add_argument("--session", help="Herdr named session. Defaults to HERDR_SESSION.")
    commands = program.add_subparsers(dest="command", required=True)

    commands.add_parser("snapshot", help="Write the live viewer snapshot.").set_defaults(func=snapshot_command)

    archive = commands.add_parser("archive", help="Capture and close one workspace.")
    archive.add_argument("--workspace", required=True)
    archive.add_argument("--allow-active", action="store_true", help="Allow working or blocked agent panes.")
    archive.add_argument("--execute", action="store_true")
    archive.add_argument("--confirm")
    archive.set_defaults(func=archive_command)

    restore = commands.add_parser("restore", help="Create a workspace from an archive.")
    restore.add_argument("--archive", required=True)
    restore.add_argument("--resume-agents", action="store_true")
    restore.add_argument("--force", action="store_true", help="Allow an additional restore of an already restored archive.")
    restore.add_argument("--execute", action="store_true")
    restore.add_argument("--confirm")
    restore.set_defaults(func=restore_command)

    move = commands.add_parser("move-tabs", help="Recreate selected tabs in another workspace, then close originals.")
    move.add_argument("--tab", action="append", required=True, help="Selected tab ID. Repeat for each tab.")
    move.add_argument("--to-workspace", required=True, help="Destination workspace ID.")
    move.add_argument("--allow-active", action="store_true", help="Allow working or blocked agent panes.")
    move.add_argument("--resume-agents", action="store_true", help="Send supported agent resume commands after close.")
    move.add_argument("--execute", action="store_true")
    move.add_argument("--confirm")
    move.set_defaults(func=move_tabs_command)

    reorder = commands.add_parser("reorder-tab", help="Reorder a tab within its current workspace.")
    reorder.add_argument("--tab", required=True)
    reorder.add_argument("--index", required=True, type=int, help="Zero-based destination index.")
    reorder.add_argument("--execute", action="store_true")
    reorder.set_defaults(func=reorder_command)

    commands.add_parser("list-archives", help="Print archive summaries.").set_defaults(func=list_archives_command)
    return program


def main() -> int:
    arguments = parser().parse_args()
    try:
        if arguments.command != "list-archives":
            arguments.session = resolve_session(arguments.session)
        arguments.func(arguments)
        return 0
    except OrganizerError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
