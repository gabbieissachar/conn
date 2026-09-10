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
import shlex
import socket
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / "state" / "workspace-organizer"
ARCHIVE_DIR = STATE_DIR / "archives"
MOVE_DIR = STATE_DIR / "moves"
LIVE_SNAPSHOT_PATH = STATE_DIR / "live-snapshot.json"
AGENT_MANIFEST_PATH = ROOT / "state" / "herdr-agent-sessions.json"
CODEX_SESSION_INDEX_PATH = Path.home() / ".codex" / "session_index.jsonl"
CODEX_SESSIONS_DIR = Path.home() / ".codex" / "sessions"
MAX_LAYOUT_PANES = 24
ACTIVE_AGENT_STATUSES = {"working", "blocked"}
SHELL_PROCESS_NAMES = {"bash", "fish", "sh", "starship", "zsh"}
CODEX_INTERACTIVE_PROMPT_COUNT = 2
CODEX_INTERACTIVE_PROMPT_MINIMUM_LENGTH = 24


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


def run_command(arguments: list[str], session: str | None) -> str:
    command = herdr_prefix(session) + arguments
    try:
        completed = subprocess.run(command, check=False, text=True, capture_output=True)
    except FileNotFoundError as error:
        raise OrganizerError("Herdr is not installed or is not on PATH.") from error

    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "unknown Herdr error"
        raise OrganizerError(f"{' '.join(command)} failed: {message}")
    return completed.stdout


def run_json(arguments: list[str], session: str | None) -> dict[str, Any]:
    command = herdr_prefix(session) + arguments
    stdout = run_command(arguments, session)
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as error:
        raise OrganizerError(
            f"Herdr returned invalid JSON for {' '.join(command)}: {stdout.strip()}"
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
    manifest = read_json(AGENT_MANIFEST_PATH, {"panes": []})
    records = manifest.get("panes", manifest.get("sessions", [])) if isinstance(manifest, dict) else []
    return [record for record in records if isinstance(record, dict)]


def default_resume_command(client: str, session_id: str) -> str | None:
    quoted_session = shlex.quote(session_id)
    if client == "codex":
        return f"codex resume {quoted_session}"
    if client == "claude":
        return f"claude --resume {quoted_session}"
    return None


def claude_session_exists(session_id: object) -> bool:
    if not isinstance(session_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", session_id):
        return False
    project_root = Path.home() / ".claude" / "projects"
    return any(project_root.rglob(f"{session_id}.jsonl")) if project_root.exists() else False


def codex_session_exists(session_id: object) -> bool:
    if not isinstance(session_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", session_id):
        return False
    return cached_codex_session_exists(session_id)


@lru_cache(maxsize=2048)
def cached_codex_session_exists(session_id: str) -> bool:
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


def native_codex_session(pane: dict[str, Any]) -> tuple[str, str] | None:
    agent_session = pane.get("agent_session")
    if not isinstance(agent_session, dict) or agent_session.get("agent") != "codex":
        return None
    session_id = agent_session.get("value")
    return ("codex", session_id) if codex_session_exists(session_id) else None


def normalized_text(value: object) -> str:
    """Make terminal and rollout text comparable without weakening word matching."""
    return re.sub(r"\s+", " ", str(value)).strip().casefold()


def codex_message_text(content: object) -> str:
    """Extract the user text from Codex's string or typed-content message shapes."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    text: list[str] = []
    for item in content:
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            text.append(item["text"])
    return "\n".join(text)


def codex_interactive_resume_process(pane: dict[str, Any], session: str | None) -> bool:
    """Return true only for Codex's ID-less interactive resume picker."""
    pane_id = pane.get("pane_id")
    if pane.get("agent") != "codex" or not isinstance(pane_id, str):
        return False
    try:
        process_info = result_of(run_json(["pane", "process-info", "--pane", pane_id], session)).get(
            "process_info", {}
        )
    except OrganizerError:
        return False
    processes = process_info.get("foreground_processes", []) if isinstance(process_info, dict) else []
    for process in processes:
        if not isinstance(process, dict):
            continue
        command = str(process.get("cmdline") or "").strip()
        # `codex resume <id>` is handled above from process metadata. This is
        # the picker form, whose selected ID is intentionally absent from argv.
        if re.search(r"(?:^|/)codex(?:\s+[^\s]+)*\s+resume\s*$", command):
            return True
    return False


def codex_visible_prompt_signatures(pane_id: str, session: str | None) -> tuple[str, ...]:
    """Get strong user-authored prompt signatures from an otherwise ID-less pane."""
    try:
        text = run_command(
            ["pane", "read", pane_id, "--source", "recent-unwrapped", "--lines", "160"], session
        )
    except OrganizerError:
        return ()
    prompts: list[str] = []
    for line in text.splitlines():
        match = re.match(r"^\s*›\s+(.+?)\s*$", line)
        if not match:
            continue
        prompt = normalized_text(match.group(1))
        if (
            len(prompt) >= CODEX_INTERACTIVE_PROMPT_MINIMUM_LENGTH
            and prompt != "ask codex to do anything"
            and prompt not in prompts
        ):
            prompts.append(prompt)
    return tuple(prompts[-CODEX_INTERACTIVE_PROMPT_COUNT:])


def known_native_codex_session_ids(session: str | None) -> set[str]:
    """Never infer a second pane's active native Codex session from copied text."""
    try:
        snapshot = session_snapshot(session)
    except OrganizerError:
        return set()
    known: set[str] = set()
    for pane in snapshot.get("panes", []):
        if not isinstance(pane, dict):
            continue
        agent_session = pane.get("agent_session")
        if not isinstance(agent_session, dict) or agent_session.get("agent") != "codex":
            continue
        session_id = agent_session.get("value")
        if isinstance(session_id, str):
            known.add(session_id)
    return known


def matching_codex_rollout_sessions(
    prompt_signatures: tuple[str, ...], pane_cwd: object, excluded_session_ids: set[str]
) -> set[str]:
    """Find local Codex rollouts containing every visible prompt signature.

    This deliberately requires two distinct prompts and a unique result at the
    call site. A terminal transcript alone is not enough evidence to guess a
    resumable session ID.
    """
    if len(prompt_signatures) < CODEX_INTERACTIVE_PROMPT_COUNT or not CODEX_SESSIONS_DIR.exists():
        return set()
    expected_cwd = normalized_text(pane_cwd) if isinstance(pane_cwd, str) and pane_cwd else ""
    matches: set[str] = set()
    for rollout in CODEX_SESSIONS_DIR.rglob("*.jsonl"):
        try:
            with rollout.open(errors="replace") as handle:
                metadata = json.loads(handle.readline()).get("payload", {})
                if not isinstance(metadata, dict):
                    continue
                session_id = metadata.get("session_id") or metadata.get("id")
                if (
                    not isinstance(session_id, str)
                    or not re.fullmatch(r"[0-9a-f-]{36}", session_id)
                    or session_id in excluded_session_ids
                ):
                    continue
                rollout_cwd = metadata.get("cwd")
                if expected_cwd and normalized_text(rollout_cwd) != expected_cwd:
                    continue
                messages: list[str] = []
                for line in handle:
                    row = json.loads(line)
                    payload = row.get("payload", {})
                    if (
                        row.get("type") == "response_item"
                        and isinstance(payload, dict)
                        and payload.get("type") == "message"
                        and payload.get("role") == "user"
                    ):
                        messages.append(normalized_text(codex_message_text(payload.get("content"))))
        except (OSError, json.JSONDecodeError):
            continue
        if all(any(signature in message for message in messages) for signature in prompt_signatures):
            matches.add(session_id)
    return matches


def codex_interactive_resume_session(pane: dict[str, Any], session: str | None) -> tuple[str, str] | None:
    """Recover a picker-selected Codex session only when local evidence is unique."""
    if not codex_interactive_resume_process(pane, session):
        return None
    pane_id = pane.get("pane_id")
    if not isinstance(pane_id, str):
        return None
    signatures = codex_visible_prompt_signatures(pane_id, session)
    pane_cwd = pane.get("foreground_cwd") or pane.get("cwd")
    matches = matching_codex_rollout_sessions(signatures, pane_cwd, known_native_codex_session_ids(session))
    return ("codex", next(iter(matches))) if len(matches) == 1 else None


def agent_session_from_process(pane: dict[str, Any], session: str | None) -> tuple[str, str] | None:
    """Return a real CLI session ID, never Herdr's display-only agent ID."""
    client = pane.get("agent")
    pane_id = pane.get("pane_id")
    if client not in {"codex", "claude"} or not isinstance(pane_id, str):
        return None
    try:
        process_info = result_of(run_json(["pane", "process-info", "--pane", pane_id], session)).get("process_info", {})
    except OrganizerError:
        return None
    processes = process_info.get("foreground_processes", []) if isinstance(process_info, dict) else []
    for process in processes:
        if not isinstance(process, dict):
            continue
        command = str(process.get("cmdline") or "")
        if client == "codex":
            match = re.search(r"(?:^|/)codex(?:\s+\S+)*\s+resume\s+([^\s]+)", command)
            if match and codex_session_exists(match.group(1)):
                return client, match.group(1)
        if client == "claude":
            argv = process.get("argv")
            executable = ""
            if isinstance(argv, list) and argv:
                executable = Path(str(argv[0])).name
            if executable != "claude":
                continue
            pid = process.get("pid")
            if not isinstance(pid, int):
                continue
            session_path = Path.home() / ".claude" / "sessions" / f"{pid}.json"
            session_data = read_json(session_path, {})
            session_id = session_data.get("sessionId") if isinstance(session_data, dict) else None
            if claude_session_exists(session_id):
                return client, session_id
            match = re.search(r"(?:^|/)claude(?:\s+code)?\s+(?:--resume|resume)\s+([^\s]+)", command)
            if match and claude_session_exists(match.group(1)):
                return client, match.group(1)
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
        registered = by_pane.get(pane_id, {})
        detected = agent_session_from_process(pane, session)
        native = native_codex_session(pane)
        interactive = codex_interactive_resume_session(pane, session) if not detected and not native else None
        registered_client = registered.get("client")
        registered_session_id = registered.get("session_id")
        registered_valid = bool(
            registered_client in {"codex", "claude"}
            and isinstance(registered_session_id, str)
            and (
                (registered_client == "claude" and claude_session_exists(registered_session_id))
                or (registered_client == "codex" and codex_session_exists(registered_session_id))
            )
        )
        client = (
            detected[0]
            if detected
            else native[0]
            if native
            else interactive[0]
            if interactive
            else registered_client
            if registered_valid
            else pane.get("agent")
        )
        agent_session_id = (
            detected[1]
            if detected
            else native[1]
            if native
            else interactive[1]
            if interactive
            else registered_session_id
            if registered_valid
            else None
        )
        command = default_resume_command(str(client), str(agent_session_id)) if client and agent_session_id else None
        resumable = bool(command and client in {"codex", "claude"})
        restores.append(
            {
                "source_pane_id": pane_id,
                "client": client,
                "session_id": agent_session_id,
                "resume_command": command if resumable else None,
                "restore_status": "resumable" if resumable else "shell_only",
                "restore_source": (
                    "process"
                    if detected
                    else "native_codex"
                    if native
                    else "local_rollout"
                    if interactive
                    else "manifest"
                    if registered_valid
                    else "unavailable"
                ),
            }
        )
    return restores


def is_trusted_restore(restore: dict[str, Any]) -> bool:
    return (
        restore.get("restore_status") == "resumable"
        and restore.get("restore_source") in {"manifest", "process", "native_codex", "local_rollout"}
    )


def unavailable_agent_restores(captured_tabs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        restore
        for tab in captured_tabs
        for restore in tab.get("agent_restores", [])
        if restore.get("client") in {"codex", "claude"} and not is_trusted_restore(restore)
    ]


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


def pane_is_shell_prompt(pane_id: str, session: str | None) -> bool:
    """Return true only when the foreground group is the shell and prompt helpers."""
    try:
        process_info = result_of(run_json(["pane", "process-info", "--pane", pane_id], session)).get("process_info", {})
    except OrganizerError:
        return False
    if not isinstance(process_info, dict):
        return False
    shell_pid = process_info.get("shell_pid")
    processes = process_info.get("foreground_processes")
    if not isinstance(shell_pid, int) or not isinstance(processes, list):
        return False
    process_names = set()
    includes_shell = False
    for process in processes:
        if not isinstance(process, dict):
            return False
        name = str(process.get("name") or process.get("argv0") or "")
        process_names.add(name.lstrip("-").lower())
        if process.get("pid") == shell_pid:
            includes_shell = True
    return includes_shell and bool(process_names) and process_names <= SHELL_PROCESS_NAMES


def empty_tab_cleanup_candidates(
    snapshot: dict[str, Any], workspace_id: str, session: str | None
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    eligible: list[dict[str, Any]] = []
    protected: list[dict[str, Any]] = []
    records = manifest_records()
    for tab in tabs_for_workspace(snapshot, workspace_id):
        tab_id = str(tab.get("tab_id"))
        panes = panes_for_tab(snapshot, tab_id)
        agent_panes = [pane.get("pane_id") for pane in panes if pane.get("agent")]
        if agent_panes:
            protected.append({"tab_id": tab_id, "reason": "agent_detected", "pane_ids": agent_panes})
            continue
        resumable_panes = [
            restore.get("source_pane_id")
            for restore in agent_restore_records(panes, session, records)
            if is_trusted_restore(restore)
        ]
        if resumable_panes:
            protected.append(
                {"tab_id": tab_id, "reason": "resumable_session", "pane_ids": resumable_panes}
            )
            continue
        non_shell_panes = [
            pane.get("pane_id")
            for pane in panes
            if not isinstance(pane.get("pane_id"), str) or not pane_is_shell_prompt(str(pane["pane_id"]), session)
        ]
        if non_shell_panes:
            protected.append({"tab_id": tab_id, "reason": "non_shell_process", "pane_ids": non_shell_panes})
            continue
        eligible.append(
            {"tab_id": tab_id, "label": tab.get("label") or tab_id, "pane_ids": [pane.get("pane_id") for pane in panes]}
        )
    return eligible, protected


def cleanup_empty_tabs_command(args: argparse.Namespace) -> None:
    snapshot = session_snapshot(args.session)
    workspace_by_id(snapshot, args.workspace)
    eligible, protected = empty_tab_cleanup_candidates(snapshot, args.workspace, args.session)
    kept_tab_id = None
    if len(eligible) == len(tabs_for_workspace(snapshot, args.workspace)) and eligible:
        kept_tab_id = eligible[-1]["tab_id"]
        eligible = eligible[:-1]
    preview = {
        "workspace_id": args.workspace,
        "tabs_to_close": eligible,
        "protected_tabs": protected,
        "kept_tab_id": kept_tab_id,
    }
    if not args.execute:
        print(json.dumps(preview, indent=2))
        print(
            f"Preview only. Re-run with --execute --confirm {args.workspace!r} to close {len(eligible)} empty shell tab(s)."
        )
        return
    require_execute_confirmation(args.execute, args.confirm, args.workspace, "Clean up empty tabs")
    for tab in eligible:
        run_json(["tab", "close", str(tab["tab_id"])], args.session)
    print(f"Closed {len(eligible)} empty shell tab(s) in workspace {args.workspace}.")
    if kept_tab_id:
        print(f"Kept {kept_tab_id} so the workspace remains available.")


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
        "resumable_pane_count": sum(is_trusted_restore(item) for item in restores),
        "shell_only_pane_count": sum(not is_trusted_restore(item) for item in restores),
        "tabs": [
            {
                "id": tab.get("source_tab_id"),
                "label": tab.get("label") or tab.get("source_tab_id"),
                "pane_count": len(leaf_panes(tab.get("layout", {}).get("root"))),
                "resumable_agent_count": sum(is_trusted_restore(item) for item in tab.get("agent_restores", [])),
                "unresumable_agent_count": sum(not is_trusted_restore(item) for item in tab.get("agent_restores", [])),
            }
            for tab in tabs
        ],
    }


def load_archives() -> list[dict[str, Any]]:
    if not ARCHIVE_DIR.exists():
        return []
    archives = [read_json(path, {}) for path in ARCHIVE_DIR.glob("*.json")]
    return sorted(archives, key=lambda archive: str(archive.get("created_at", "")), reverse=True)


def public_workspace(
    snapshot: dict[str, Any], workspace: dict[str, Any], session: str | None, records: list[dict[str, Any]]
) -> dict[str, Any]:
    workspace_id = str(workspace["workspace_id"])
    tabs: list[dict[str, Any]] = []
    for position, tab in enumerate(tabs_for_workspace(snapshot, workspace_id)):
        panes = panes_for_tab(snapshot, str(tab["tab_id"]))
        statuses: dict[str, int] = {}
        for pane in panes:
            status = str(pane.get("agent_status") or "idle")
            statuses[status] = statuses.get(status, 0) + 1
        agent_resume = [
            {
                "pane_id": restore.get("source_pane_id"),
                "client": restore.get("client"),
                "status": "resumable" if is_trusted_restore(restore) else "needs_registration",
                "source": restore.get("restore_source"),
            }
            for restore in agent_restore_records(panes, session, records)
            if restore.get("client") in {"codex", "claude"}
        ]
        tabs.append(
            {
                "id": tab.get("tab_id"),
                "label": tab.get("label") or tab.get("tab_id"),
                "index": position,
                "focused": bool(tab.get("focused")),
                "pane_count": len(panes),
                "agent_statuses": statuses,
                "agent_resume": agent_resume,
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
    records = manifest_records()
    document = {
        "version": 1,
        "generated_at": now(),
        "herdr_session": args.session or os.environ.get("HERDR_SESSION"),
        "workspaces": [
            public_workspace(snapshot, workspace, args.session, records) for workspace in snapshot.get("workspaces", [])
        ],
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


def move_id_for(destination_workspace_id: str) -> str:
    return f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-move-to-{destination_workspace_id}"


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
    unavailable = unavailable_agent_restores(capture["tabs"])
    if unavailable and not args.allow_unresumable_agents:
        pane_ids = ", ".join(str(item.get("source_pane_id")) for item in unavailable)
        raise OrganizerError(
            f"Workspace {args.workspace} has {len(unavailable)} agent pane(s) without a verified resumable session: {pane_ids}. "
            "Do not archive them. Resume or register the sessions first, or explicitly use --allow-unresumable-agents."
        )
    archive_id = archive_id_for(str(workspace.get("label") or args.workspace))
    summary = {
        "archive_id": archive_id,
        "workspace": capture["workspace"],
        "tab_count": len(capture["tabs"]),
        "pane_count": sum(len(leaf_panes(tab["layout"].get("root"))) for tab in capture["tabs"]),
        "active_agent_panes": len(active),
        "resumable_agent_panes": sum(
            is_trusted_restore(item) for tab in capture["tabs"] for item in tab.get("agent_restores", [])
        ),
        "unresumable_agent_panes": len(unavailable),
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
    if not archive_id or Path(archive_id).name != archive_id:
        raise OrganizerError("Archive ID must be a single archive name, not a path.")
    path = ARCHIVE_DIR / f"{archive_id}.json"
    if not path.exists():
        raise OrganizerError(f"Archive {archive_id!r} was not found.")
    return path, read_json(path, {})


def archived_tab_by_id(archive: dict[str, Any], tab_id: str) -> dict[str, Any]:
    tabs = archive.get("capture", {}).get("tabs", [])
    tab = next((item for item in tabs if item.get("source_tab_id") == tab_id), None)
    if not isinstance(tab, dict):
        raise OrganizerError(f"Archive {archive.get('archive_id')!r} does not contain tab {tab_id!r}.")
    return tab


def delete_archived_tab(archive: dict[str, Any], tab_id: str) -> dict[str, Any]:
    """Remove one tab and all archive metadata that identifies its old panes."""
    tab = archived_tab_by_id(archive, tab_id)
    capture = archive.get("capture", {})
    tabs = capture.get("tabs", [])
    if not isinstance(tabs, list) or len(tabs) <= 1:
        raise OrganizerError("This is the archive's last tab. Delete the whole archive instead.")
    source_pane_ids = {
        str(pane_id)
        for pane in leaf_panes(tab.get("layout", {}).get("root"))
        if (pane_id := pane.get("pane_id"))
    }
    capture["tabs"] = [item for item in tabs if item.get("source_tab_id") != tab_id]
    archive["tab_restores"] = [
        item
        for item in archive.get("tab_restores", [])
        if isinstance(item, dict) and item.get("source_tab_id") != tab_id
    ]
    restore = archive.get("restore")
    if isinstance(restore, dict):
        restore["tabs"] = [
            item
            for item in restore.get("tabs", [])
            if isinstance(item, dict) and item.get("source_tab_id") != tab_id
        ]
        restore["agent_resume"] = [
            item
            for item in restore.get("agent_resume", [])
            if isinstance(item, dict) and str(item.get("source_pane_id")) not in source_pane_ids
        ]
        pane_map = restore.get("pane_map")
        if isinstance(pane_map, dict):
            restore["pane_map"] = {
                old_pane_id: new_pane_id
                for old_pane_id, new_pane_id in pane_map.items()
                if str(old_pane_id) not in source_pane_ids
            }
    archive["updated_at"] = now()
    return tab


def delete_archive_command(args: argparse.Namespace) -> None:
    archive_path, archive = archive_by_id(args.archive)
    if not args.execute:
        print(json.dumps(archive_summary(archive), indent=2))
        print(
            f"Preview only. Re-run with --execute --confirm {args.archive!r} to permanently delete this archive. "
            "This does not change any restored or active workspace."
        )
        return
    require_execute_confirmation(args.execute, args.confirm, args.archive, "Delete archive")
    archive_path.unlink()
    print(f"Deleted archive {args.archive}. No active or restored workspace was changed.")


def delete_archived_tab_command(args: argparse.Namespace) -> None:
    archive_path, archive = archive_by_id(args.archive)
    tab = archived_tab_by_id(archive, args.tab)
    if len(archive.get("capture", {}).get("tabs", [])) <= 1:
        raise OrganizerError("This is the archive's last tab. Delete the whole archive instead.")
    confirmation = f"{args.archive}:{args.tab}"
    preview = {
        "archive_id": args.archive,
        "source_tab_id": args.tab,
        "tab_label": tab.get("label") or args.tab,
        "pane_count": len(leaf_panes(tab.get("layout", {}).get("root"))),
        "remaining_tab_count": len(archive.get("capture", {}).get("tabs", [])) - 1,
    }
    if not args.execute:
        print(json.dumps(preview, indent=2))
        print(
            f"Preview only. Re-run with --execute --confirm {confirmation!r} to permanently delete this archived tab. "
            "This does not change any restored or active workspace."
        )
        return
    require_execute_confirmation(args.execute, args.confirm, confirmation, "Delete archived tab")
    delete_archived_tab(archive, args.tab)
    write_json(archive_path, archive)
    print(f"Deleted archived tab {args.tab} from {args.archive}. No active or restored workspace was changed.")


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
            if not is_trusted_restore(restore) or not command or not new_pane_id:
                outcomes.append({"source_pane_id": old_pane_id, "status": "skipped"})
                continue
            try:
                run_command(["pane", "run", new_pane_id, str(command)], session)
                outcomes.append(
                    {
                        "source_pane_id": old_pane_id,
                        "pane_id": new_pane_id,
                        "status": "sent",
                        "action": "resumed",
                    }
                )
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
    unavailable = unavailable_agent_restores(captured_tabs)
    if unavailable and not args.allow_unresumable_agents:
        pane_ids = ", ".join(str(item.get("source_pane_id")) for item in unavailable)
        raise OrganizerError(
            f"The selected tabs contain {len(unavailable)} agent pane(s) without a verified resumable session: {pane_ids}. "
            "Do not move them. Resume or register the sessions first, or explicitly use --allow-unresumable-agents."
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
    operation_id = move_id_for(args.to_workspace)
    move_path = MOVE_DIR / f"{operation_id}.json"
    move_record = {
        "version": 1,
        "operation_id": operation_id,
        "status": "prepared",
        "created_at": now(),
        "herdr_session": args.session,
        "destination_workspace_id": args.to_workspace,
        "source_tabs": captured_tabs,
        "destination_tabs": [],
        "pane_map": {},
        "resume_outcomes": [],
    }
    write_json(move_path, move_record)
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
            move_record["destination_tabs"] = created_tabs
            move_record["pane_map"] = pane_map
            write_json(move_path, move_record)
    except OrganizerError as error:
        created = ", ".join(str(tab.get("tab_id")) for tab in created_tabs) or "none"
        move_record["status"] = "layout_partial"
        move_record["error"] = str(error)
        write_json(move_path, move_record)
        raise OrganizerError(
            f"Move stopped before closing any source tabs. Rebuilt destination tab(s): {created}. {error}"
        ) from error

    closed: list[str] = []
    try:
        for tab in captured_tabs:
            run_json(["tab", "close", tab["source_tab_id"]], args.session)
            closed.append(tab["source_tab_id"])
            move_record["closed_source_tabs"] = closed
            write_json(move_path, move_record)
    except OrganizerError as error:
        move_record["status"] = "close_partial"
        move_record["error"] = str(error)
        write_json(move_path, move_record)
        raise OrganizerError(
            f"Destination tabs were rebuilt, but only these source tabs were closed: {', '.join(closed) or 'none'}. "
            f"Do not retry blindly. {error}"
        ) from error
    move_record["status"] = "sources_closed"
    write_json(move_path, move_record)
    if args.resume_agents:
        outcomes = resume_captured_tabs(captured_tabs, pane_map, args.session)
        move_record["resume_outcomes"] = outcomes
        failed = [outcome for outcome in outcomes if outcome.get("status") == "failed"]
        move_record["status"] = "resume_partial" if failed else "completed"
        move_record["completed_at"] = now()
        write_json(move_path, move_record)
        if failed:
            raise OrganizerError(
                f"Tabs moved, but one or more agent resumes failed. Review and retry with resume-move --move {operation_id}."
            )
    else:
        move_record["status"] = "completed_without_resume"
        move_record["completed_at"] = now()
        write_json(move_path, move_record)
    print(f"Moved {len(captured_tabs)} tab(s) into workspace {args.to_workspace}.")
    print("The original tabs were closed and their processes stopped. The destination contains fresh panes.")
    if args.resume_agents:
        resumed = sum(outcome.get("action") == "resumed" for outcome in outcomes)
        print(f"Resumed {resumed} verified agent session(s). Recovery record: {operation_id}.")


def resume_move_command(args: argparse.Namespace) -> None:
    move_path = MOVE_DIR / f"{args.move}.json"
    if not move_path.exists():
        raise OrganizerError(f"Move recovery record {args.move!r} was not found.")
    move = read_json(move_path, {})
    if move.get("status") not in {"sources_closed", "resume_partial", "completed", "completed_without_resume"}:
        raise OrganizerError(f"Move {args.move!r} is in {move.get('status')!r} state and cannot resume agents yet.")
    source_tabs = move.get("source_tabs", [])
    resumable = sum(
        is_trusted_restore(item)
        for tab in source_tabs
        for item in tab.get("agent_restores", [])
    )
    if not args.execute:
        print(f"Move {args.move} has {resumable} supported agent session(s) available to resume.")
        print(f"Preview only. Re-run with --execute --confirm {args.move!r} to send resume commands.")
        return
    require_execute_confirmation(args.execute, args.confirm, args.move, "Resume moved agents")
    outcomes = resume_captured_tabs(source_tabs, move.get("pane_map", {}), args.session)
    move["resume_outcomes"] = outcomes
    failures = [outcome for outcome in outcomes if outcome.get("status") == "failed"]
    move["status"] = "resume_partial" if failures else "completed"
    move["resumed_at"] = now()
    write_json(move_path, move)
    if failures:
        raise OrganizerError("One or more moved-agent resume commands failed. The recovery record was retained.")
    print(f"Resumed {sum(outcome.get('status') == 'sent' for outcome in outcomes)} moved agent session(s).")


def restore_tabs_command(args: argparse.Namespace) -> None:
    archive_path, archive = archive_by_id(args.archive)
    status = archive.get("status")
    if status not in {"archived", "restored", "resumed", "restore_partial"}:
        raise OrganizerError(f"Archive {args.archive!r} is in {status!r} state and cannot restore tabs.")
    snapshot = session_snapshot(args.session)
    destination = workspace_by_id(snapshot, args.to_workspace)
    selected_ids = list(args.tab)
    if len(set(selected_ids)) != len(selected_ids):
        raise OrganizerError("Each --tab value must be unique.")
    selected_tabs = [archived_tab_by_id(archive, tab_id) for tab_id in selected_ids]
    unavailable = unavailable_agent_restores(selected_tabs)
    preview = {
        "archive_id": args.archive,
        "destination_workspace_id": args.to_workspace,
        "destination_label": destination.get("label") or args.to_workspace,
        "tabs": [
            {
                "source_tab_id": tab_id,
                "tab_label": tab.get("label"),
                "pane_count": len(leaf_panes(tab.get("layout", {}).get("root"))),
                "resumable_agent_count": sum(is_trusted_restore(item) for item in tab.get("agent_restores", [])),
            }
            for tab_id, tab in zip(selected_ids, selected_tabs, strict=True)
        ],
        "unresumable_agent_count": len(unavailable),
    }
    if not args.execute:
        print(json.dumps(preview, indent=2))
        print(
            f"Preview only. Re-run with --execute --confirm {args.archive!r} to restore {len(selected_tabs)} archived tab(s) into {args.to_workspace}."
        )
        return
    require_execute_confirmation(args.execute, args.confirm, args.archive, "Restore archived tabs")
    if unavailable and not args.allow_unresumable_agents:
        pane_ids = ", ".join(str(item.get("source_pane_id")) for item in unavailable)
        raise OrganizerError(
            f"The selected archived tabs have {len(unavailable)} agent pane(s) without a verified resumable session: {pane_ids}. "
            "Nothing was restored. Use --allow-unresumable-agents only if restoring the layouts without their agent sessions is acceptable."
        )
    operations = [
        {
            "operation_id": f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-restore-{tab_id}-to-{args.to_workspace}",
            "source_tab_id": tab_id,
            "destination_workspace_id": args.to_workspace,
            "started_at": now(),
            "status": "prepared",
        }
        for tab_id in selected_ids
    ]
    archive.setdefault("tab_restores", []).extend(operations)
    write_json(archive_path, archive)
    all_outcomes: list[dict[str, Any]] = []
    for tab, operation in zip(selected_tabs, operations, strict=True):
        try:
            applied = socket_call(
                args.session,
                "layout.apply",
                {
                    "workspace_id": args.to_workspace,
                    "tab_label": tab.get("label"),
                    "focus": False,
                    "root": tab.get("layout", {}).get("root"),
                },
            )
            layout = applied.get("layout")
            if not isinstance(layout, dict):
                raise OrganizerError(f"Herdr did not return the rebuilt layout for {tab.get('label')!r}.")
            pane_map = matching_pane_map(tab.get("layout", {}).get("root"), layout.get("root"))
            outcomes = resume_captured_tabs([tab], pane_map, args.session) if args.resume_agents else []
            failures = [outcome for outcome in outcomes if outcome.get("status") == "failed"]
            operation.update(
                {
                    "destination_tab_id": layout.get("tab_id"),
                    "pane_map": pane_map,
                    "agent_resume": outcomes,
                    "status": "resume_partial" if failures else "completed",
                    "completed_at": now(),
                }
            )
            all_outcomes.extend(outcomes)
        except OrganizerError as error:
            operation["status"] = "failed"
            operation["error"] = str(error)
            operation["failed_at"] = now()
            write_json(archive_path, archive)
            raise OrganizerError(
                f"Some archived tabs may already have been restored. The recovery records were retained: {error}"
            ) from error
        write_json(archive_path, archive)
    if any(outcome.get("status") == "failed" for outcome in all_outcomes):
        raise OrganizerError("Archived tabs were restored, but one or more agent resumes failed. The recovery records were retained.")
    resumed = sum(outcome.get("action") == "resumed" for outcome in all_outcomes)
    print(f"Restored {len(selected_tabs)} archived tab(s) into workspace {args.to_workspace}.")
    print(f"Resumed {resumed} verified agent session(s).")


def restore_tab_command(args: argparse.Namespace) -> None:
    args.tab = [args.tab]
    restore_tabs_command(args)


def restore_command(args: argparse.Namespace) -> None:
    archive_path, archive = archive_by_id(args.archive)
    status = archive.get("status")
    if status not in {"archived", "restored", "resumed", "restore_partial"}:
        raise OrganizerError(f"Archive {args.archive!r} is in {status!r} state and cannot be restored.")
    if status in {"restored", "resumed"} and not args.force:
        raise OrganizerError("This archive was already restored. Use --force only if you intentionally want another copy.")
    capture = archive.get("capture", {})
    workspace = capture.get("workspace", {})
    unavailable = unavailable_agent_restores(capture.get("tabs", []))
    if not args.execute:
        print(json.dumps(archive_summary(archive), indent=2))
        print(f"Preview only. Re-run with --execute --confirm {args.archive!r} to restore a new workspace.")
        return

    require_execute_confirmation(args.execute, args.confirm, args.archive, "Restore")
    if args.resume_agents and unavailable and not args.allow_unresumable_agents:
        pane_ids = ", ".join(str(item.get("source_pane_id")) for item in unavailable)
        raise OrganizerError(
            f"Archive {args.archive!r} has {len(unavailable)} agent pane(s) without a verified resumable session: {pane_ids}. "
            "It was not restored. Use --allow-unresumable-agents only if restoring the layout without its agent sessions is acceptable."
        )
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
            sent = sum(outcome.get("status") == "sent" for outcome in restore["agent_resume"])
            archive["status"] = "restore_partial" if failures else "resumed" if sent else "restored"
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
        resumed = sum(outcome.get("action") == "resumed" for outcome in restore["agent_resume"])
        print(f"Resumed {resumed} verified agent session(s).")
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
    archive.add_argument("--allow-unresumable-agents", action="store_true", help="Allow agent panes without a verified resumable session.")
    archive.add_argument("--execute", action="store_true")
    archive.add_argument("--confirm")
    archive.set_defaults(func=archive_command)

    cleanup_empty = commands.add_parser(
        "cleanup-empty-tabs", help="Close shell-only tabs without agents or preserved sessions."
    )
    cleanup_empty.add_argument("--workspace", required=True)
    cleanup_empty.add_argument("--execute", action="store_true")
    cleanup_empty.add_argument("--confirm")
    cleanup_empty.set_defaults(func=cleanup_empty_tabs_command)

    restore = commands.add_parser("restore", help="Create a workspace from an archive.")
    restore.add_argument("--archive", required=True)
    restore.add_argument("--resume-agents", action="store_true")
    restore.add_argument("--allow-unresumable-agents", action="store_true", help="Restore fresh shells for agents without a verified session.")
    restore.add_argument("--force", action="store_true", help="Allow an additional restore of an already restored archive.")
    restore.add_argument("--execute", action="store_true")
    restore.add_argument("--confirm")
    restore.set_defaults(func=restore_command)

    restore_tab = commands.add_parser("restore-tab", help="Restore one archived tab into an active workspace.")
    restore_tab.add_argument("--archive", required=True)
    restore_tab.add_argument("--tab", required=True, help="Archived source tab ID, e.g. w1:t2.")
    restore_tab.add_argument("--to-workspace", required=True)
    restore_tab.add_argument("--allow-unresumable-agents", action="store_true", help="Restore fresh shells for agents without a verified session.")
    restore_tab.add_argument("--no-resume-agents", dest="resume_agents", action="store_false")
    restore_tab.add_argument("--execute", action="store_true")
    restore_tab.add_argument("--confirm")
    restore_tab.set_defaults(func=restore_tab_command, resume_agents=True)

    restore_tabs = commands.add_parser(
        "restore-tabs", help="Restore selected archived tabs into an active workspace."
    )
    restore_tabs.add_argument("--archive", required=True)
    restore_tabs.add_argument("--tab", action="append", required=True, help="Archived source tab ID. Repeat for each tab.")
    restore_tabs.add_argument("--to-workspace", required=True)
    restore_tabs.add_argument(
        "--allow-unresumable-agents",
        action="store_true",
        help="Restore layouts for selected tabs whose agent sessions cannot be verified.",
    )
    restore_tabs.add_argument("--no-resume-agents", dest="resume_agents", action="store_false")
    restore_tabs.add_argument("--execute", action="store_true")
    restore_tabs.add_argument("--confirm")
    restore_tabs.set_defaults(func=restore_tabs_command, resume_agents=True)

    delete_archive = commands.add_parser("delete-archive", help="Permanently delete one saved archive.")
    delete_archive.add_argument("--archive", required=True)
    delete_archive.add_argument("--execute", action="store_true")
    delete_archive.add_argument("--confirm")
    delete_archive.set_defaults(func=delete_archive_command)

    delete_archived_tab = commands.add_parser("delete-archived-tab", help="Permanently delete one tab from a saved archive.")
    delete_archived_tab.add_argument("--archive", required=True)
    delete_archived_tab.add_argument("--tab", required=True, help="Archived source tab ID, e.g. w1:t2.")
    delete_archived_tab.add_argument("--execute", action="store_true")
    delete_archived_tab.add_argument("--confirm")
    delete_archived_tab.set_defaults(func=delete_archived_tab_command)

    move = commands.add_parser("move-tabs", help="Recreate selected tabs in another workspace, then close originals.")
    move.add_argument("--tab", action="append", required=True, help="Selected tab ID. Repeat for each tab.")
    move.add_argument("--to-workspace", required=True, help="Destination workspace ID.")
    move.add_argument("--allow-active", action="store_true", help="Allow working or blocked agent panes.")
    move.add_argument("--allow-unresumable-agents", action="store_true", help="Allow agent panes without a verified resumable session.")
    move.add_argument(
        "--no-resume-agents",
        dest="resume_agents",
        action="store_false",
        help="Do not resume supported agents after the source tabs are closed.",
    )
    move.add_argument("--execute", action="store_true")
    move.add_argument("--confirm")
    move.set_defaults(func=move_tabs_command, resume_agents=True)

    resume_move = commands.add_parser("resume-move", help="Retry supported agent resumes for a completed tab move.")
    resume_move.add_argument("--move", required=True, help="Move recovery record ID.")
    resume_move.add_argument("--execute", action="store_true")
    resume_move.add_argument("--confirm")
    resume_move.set_defaults(func=resume_move_command)

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
        if arguments.command not in {"list-archives", "delete-archive", "delete-archived-tab"}:
            arguments.session = resolve_session(arguments.session)
        arguments.func(arguments)
        return 0
    except OrganizerError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
