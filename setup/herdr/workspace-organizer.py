#!/usr/bin/env python3
"""A small, local organizer for Herdr workspaces.

It deliberately captures layouts and resumable agent identities only. Terminal
processes and scrollback are not preserved. Archiving closes the source
workspace; restoring creates a fresh workspace and rebuilds its tab layouts.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / "state" / "workspace-organizer"
ARCHIVE_DIR = STATE_DIR / "archives"
MOVE_DIR = STATE_DIR / "moves"
RECOVERY_DIR = STATE_DIR / "restart-recovery"
RECOVERY_BUNDLE_DIR = RECOVERY_DIR / "bundles"
RECOVERY_JOURNAL_DIR = RECOVERY_DIR / "journals"
LIVE_SNAPSHOT_PATH = STATE_DIR / "live-snapshot.json"
AGENT_MANIFEST_PATH = ROOT / "state" / "herdr-agent-sessions.json"
CODEX_SESSION_INDEX_PATH = Path.home() / ".codex" / "session_index.jsonl"
CODEX_SESSIONS_DIR = Path.home() / ".codex" / "sessions"
MAX_LAYOUT_PANES = 24
ACTIVE_AGENT_STATUSES = {"working", "blocked"}
# A resume record is not enough to establish that an agent is quiescent.  Herdr
# currently reports an explicitly idle agent with this value; all other values
# must be treated as unresolved until they have a reviewed recovery policy.
SAFE_RESUMABLE_AGENT_STATUSES = {"idle"}
SHELL_PROCESS_NAMES = {"bash", "fish", "sh", "starship", "zsh"}
CODEX_INTERACTIVE_PROMPT_COUNT = 2
CODEX_INTERACTIVE_PROMPT_MINIMUM_LENGTH = 24
RECOVERY_SCHEMA_VERSION = 2
RECOVERY_MAX_CAPTURE_ATTEMPTS = 3


class OrganizerError(RuntimeError):
    """An expected error that should be shown without a stack trace."""


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def ensure_private_directory(path: Path) -> None:
    """Create a recovery directory that only its owner can read."""
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError as error:
        raise OrganizerError(f"Could not restrict permissions on {path}: {error}") from error


def write_private_json(path: Path, value: Any) -> None:
    """Atomically write sensitive recovery state with mode 0600."""
    ensure_private_directory(path.parent)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    payload = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = None
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o600)
        temporary.replace(path)
        path.chmod(0o600)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise OrganizerError(f"Could not write private recovery state {path}: {error}") from error


def private_json_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def recovery_identity(session: str, workspace_id: str | None = None, tab_id: str | None = None,
                      pane_id: str | None = None) -> dict[str, str | None]:
    """Use one explicit namespace shape for every captured recovery object."""
    return {
        "herdr_session": session,
        "workspace_id": workspace_id,
        "tab_id": tab_id,
        "pane_id": pane_id,
    }


def recovery_identity_key(identity: dict[str, Any]) -> str:
    values = [identity.get(name) for name in ("herdr_session", "workspace_id", "tab_id", "pane_id")]
    if not isinstance(values[0], str) or not values[0]:
        raise OrganizerError("Recovery object does not have a named Herdr session.")
    return "|".join("" if value is None else str(value) for value in values)


def layout_fingerprint(layout: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(layout, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def read_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise OrganizerError(f"Could not parse {path}: {error}") from error


def herdr_prefix(session: str | None) -> list[str]:
    lab_helper = os.environ.get("HERDR_LAB_HELPER")
    if lab_helper:
        if not session:
            raise OrganizerError("HERDR_LAB_HELPER requires an explicit named Herdr session.")
        return [lab_helper, "run", session]
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


def archive_tabs_command(args: argparse.Namespace) -> None:
    """Append selected live tabs to an existing archive, then close those tabs."""
    archive_path, archive = archive_by_id(args.into_archive)
    if archive.get("status") not in {"archived", "restored", "resumed", "restore_partial"}:
        raise OrganizerError(
            f"Archive {args.into_archive!r} is in {archive.get('status')!r} state and cannot accept tabs."
        )
    snapshot = session_snapshot(args.session)
    captured_tabs = capture_selected_tabs(snapshot, args.tab, args.session)
    selected_by_workspace: dict[str, int] = {}
    for tab in captured_tabs:
        workspace_id = str(tab.get("source_workspace_id"))
        selected_by_workspace[workspace_id] = selected_by_workspace.get(workspace_id, 0) + 1
    emptied_workspaces = [
        workspace_id
        for workspace_id, selected_count in selected_by_workspace.items()
        if selected_count >= len(tabs_for_workspace(snapshot, workspace_id))
    ]
    if emptied_workspaces:
        raise OrganizerError(
            "Archiving these tabs would leave workspace(s) with no tabs: "
            f"{', '.join(emptied_workspaces)}. Keep at least one tab in each live workspace."
        )
    selected_ids = {str(tab["source_tab_id"]) for tab in captured_tabs}
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
            f"The selected tabs have {len(unavailable)} agent pane(s) without a verified resumable session: {pane_ids}. "
            "Do not archive them. Resume or register the sessions first, or explicitly use --allow-unresumable-agents."
        )
    archived_ids = {
        str(tab.get("source_tab_id")) for tab in archive.get("capture", {}).get("tabs", []) if isinstance(tab, dict)
    }
    duplicates = sorted(selected_ids & archived_ids)
    if duplicates:
        raise OrganizerError(
            f"Archive {args.into_archive!r} already contains tab(s): {', '.join(duplicates)}."
        )
    preview = {
        "archive_id": args.into_archive,
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
        "unresumable_agent_panes": len(unavailable),
        "processes_preserved": False,
    }
    if not args.execute:
        print(json.dumps(preview, indent=2))
        print(
            "Preview only. Execution appends the selected tabs to the archive, then closes their live tabs. "
            f"Re-run with --execute --confirm {args.into_archive!r}."
        )
        return
    require_execute_confirmation(args.execute, args.confirm, args.into_archive, "Archive selected tabs")
    operation = {
        "operation_id": f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-archive-tabs-into-{args.into_archive}",
        "source_tabs": [tab["source_tab_id"] for tab in captured_tabs],
        "started_at": now(),
        "status": "prepared",
        "close_outcomes": [],
    }
    archive.setdefault("capture", {}).setdefault("tabs", []).extend(captured_tabs)
    archive.setdefault("tab_archives", []).append(operation)
    archive["updated_at"] = now()
    write_json(archive_path, archive)
    try:
        for tab in captured_tabs:
            tab_id = str(tab["source_tab_id"])
            run_json(["tab", "close", tab_id], args.session)
            operation["close_outcomes"].append({"source_tab_id": tab_id, "status": "closed"})
            write_json(archive_path, archive)
    except OrganizerError as error:
        operation["status"] = "close_partial"
        operation["error"] = str(error)
        operation["failed_at"] = now()
        write_json(archive_path, archive)
        raise OrganizerError(
            "The archive capture was retained, but one or more source tabs could not be closed. "
            "Review the operation record before retrying."
        ) from error
    operation["status"] = "completed"
    operation["completed_at"] = now()
    write_json(archive_path, archive)
    print(f"Archived {len(captured_tabs)} tab(s) into {args.into_archive}.")
    print("The source tabs were closed and their processes stopped.")


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


# Restart recovery bundles deliberately do not use archive/restore.  Archives
# close their source workspace; restart preparation must never do that.
def require_recovery_session(session: str | None) -> str:
    if not isinstance(session, str) or not session.strip():
        raise OrganizerError("Restart recovery requires an explicit named --session.")
    return session.strip()


def running_recovery_sessions() -> list[str]:
    """Discover only currently running named sessions for the implicit scope."""
    try:
        completed = subprocess.run(
            ["herdr", "session", "list", "--json"], check=False, text=True, capture_output=True
        )
    except FileNotFoundError as error:
        raise OrganizerError("Herdr is not installed or is not on PATH.") from error
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "unknown Herdr error"
        raise OrganizerError(f"Could not list running Herdr sessions: {message}")
    try:
        raw = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise OrganizerError("Herdr returned invalid JSON while listing named sessions.") from error
    sessions = raw.get("sessions", []) if isinstance(raw, dict) else []
    named = [
        str(row["name"])
        for row in sessions
        if isinstance(row, dict) and row.get("running") and row.get("name") and not row.get("default")
    ]
    if any(isinstance(row, dict) and row.get("running") and row.get("default") for row in sessions):
        raise OrganizerError(
            "The running default Herdr session cannot be selected implicitly for restart recovery. "
            "Pass each non-default named session explicitly with --session."
        )
    return named


def recovery_sessions(args: argparse.Namespace) -> list[str]:
    requested = list(getattr(args, "recovery_sessions", []) or [])
    selected = requested or running_recovery_sessions()
    if not selected:
        raise OrganizerError("No named Herdr sessions are running. Pass one or more --session values after attaching them.")
    normalized = [require_recovery_session(session) for session in selected]
    if "default" in normalized:
        raise OrganizerError(
            "The default Herdr session is unsupported for restart recovery. Select a non-default named session."
        )
    if len(set(normalized)) != len(normalized):
        raise OrganizerError("Each restart-recovery --session must be unique.")
    return normalized


def recovery_process_info(session: str, pane_id: str) -> dict[str, Any]:
    selected = require_recovery_session(session)
    response = result_of(run_json(["pane", "process-info", "--pane", pane_id], selected))
    process_info = response.get("process_info")
    if not isinstance(process_info, dict):
        raise OrganizerError(f"Herdr did not return foreground process metadata for pane {pane_id}.")
    return process_info


def recovery_layouts(snapshot: dict[str, Any], session: str) -> dict[str, dict[str, Any]]:
    selected = require_recovery_session(session)
    layouts: dict[str, dict[str, Any]] = {}
    for tab in snapshot.get("tabs", []):
        if not isinstance(tab, dict) or not isinstance(tab.get("tab_id"), str):
            raise OrganizerError("Herdr snapshot contains a tab without an ID.")
        tab_id = str(tab["tab_id"])
        exported = socket_call(selected, "layout.export", {"tab_id": tab_id}).get("layout")
        if not isinstance(exported, dict):
            raise OrganizerError(f"Herdr did not return a layout for tab {tab_id}.")
        if len(leaf_panes(exported.get("root"))) > MAX_LAYOUT_PANES:
            raise OrganizerError(f"Tab {tab_id} exceeds the {MAX_LAYOUT_PANES}-pane recovery limit.")
        layouts[tab_id] = exported
    return layouts


def recovery_structure(snapshot: dict[str, Any]) -> dict[str, list[tuple[str, ...]]]:
    """IDs and memberships that must not change while capture is being sealed."""
    workspaces = sorted(
        str(item.get("workspace_id")) for item in snapshot.get("workspaces", [])
        if isinstance(item, dict) and item.get("workspace_id")
    )
    tabs = sorted(
        (str(item.get("workspace_id")), str(item.get("tab_id"))) for item in snapshot.get("tabs", [])
        if isinstance(item, dict) and item.get("workspace_id") and item.get("tab_id")
    )
    panes = sorted(
        (str(item.get("tab_id")), str(item.get("pane_id"))) for item in snapshot.get("panes", [])
        if isinstance(item, dict) and item.get("tab_id") and item.get("pane_id")
    )
    return {"workspaces": [(item,) for item in workspaces], "tabs": tabs, "panes": panes}


def recovery_layout_fingerprints(layouts: dict[str, dict[str, Any]]) -> dict[str, str]:
    return {tab_id: layout_fingerprint(layout) for tab_id, layout in sorted(layouts.items())}


def layout_shape(value: Any) -> Any:
    """Layout shape is stable even when Herdr gives a rebuilt pane a new ID."""
    if isinstance(value, list):
        return [layout_shape(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {key: layout_shape(item) for key, item in sorted(value.items()) if key not in {"pane_id", "tab_id"}}


def layout_shape_fingerprint(layout: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(layout_shape(layout), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def recovery_acknowledgements(values: Iterable[str] | None) -> set[str]:
    acknowledgements: set[str] = set()
    for value in values or []:
        fields = value.split("|")
        if len(fields) != 4 or any(not field for field in fields):
            raise OrganizerError(
                "--allow-volatile-pane must be the exact named identity session|workspace|tab|pane."
            )
        acknowledgements.add("|".join(fields))
    return acknowledgements


def recovery_path_issue(value: Any, kind: str, identity: dict[str, str | None]) -> dict[str, Any] | None:
    if not isinstance(value, str) or not value.strip():
        return {"kind": kind, "identity": identity, "path": None}
    path = Path(value.strip()).expanduser()
    if path.is_dir():
        return None
    return {"kind": kind, "identity": identity, "path": str(path)}


def recovery_pane_classification(
    pane: dict[str, Any], restore: dict[str, Any], session: str, acknowledgements: set[str]
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    pane_id = pane.get("pane_id")
    workspace_id = pane.get("workspace_id")
    tab_id = pane.get("tab_id")
    if not all(isinstance(value, str) and value for value in (pane_id, workspace_id, tab_id)):
        raise OrganizerError("Herdr snapshot contains a pane without a fully namespaced identity.")
    identity = recovery_identity(session, workspace_id, tab_id, pane_id)
    agent = pane.get("agent") if pane.get("agent") in {"codex", "claude"} else None
    status = str(pane.get("agent_status") or "unknown")
    if agent and status in ACTIVE_AGENT_STATUSES:
        return {"identity": identity, "classification": "busy_agent", "agent": agent, "agent_status": status}, {
            "kind": "busy_agent", "identity": identity
        }
    if agent and not is_trusted_restore(restore):
        return {"identity": identity, "classification": "unresolved_supported_agent", "agent": agent, "agent_status": status}, {
            "kind": "unresolved_supported_agent", "identity": identity
        }
    if agent and status not in SAFE_RESUMABLE_AGENT_STATUSES:
        return {
            "identity": identity,
            "classification": "unresolved_supported_agent",
            "agent": agent,
            "agent_status": status,
        }, {"kind": "unresolved_supported_agent", "identity": identity}
    try:
        process_info = recovery_process_info(session, pane_id)
    except OrganizerError:
        return {"identity": identity, "classification": "unknown_process_state", "agent": agent, "agent_status": status}, {
            "kind": "unknown_process_state", "identity": identity
        }
    processes = process_info.get("foreground_processes")
    shell_pid = process_info.get("shell_pid")
    if not isinstance(processes, list) or not processes:
        return {"identity": identity, "classification": "unknown_process_state", "agent": agent, "agent_status": status}, {
            "kind": "unknown_process_state", "identity": identity
        }
    names: set[str] = set()
    includes_shell = False
    for process in processes:
        if not isinstance(process, dict):
            return {"identity": identity, "classification": "unknown_process_state", "agent": agent, "agent_status": status}, {
                "kind": "unknown_process_state", "identity": identity
            }
        names.add(str(process.get("name") or process.get("argv0") or "").lstrip("-").lower())
        includes_shell = includes_shell or process.get("pid") == shell_pid
    if agent and is_trusted_restore(restore):
        return {
            "identity": identity,
            "classification": "verified_resumable_supported_agent",
            "agent": agent,
            "agent_status": status,
        }, None
    if includes_shell and names and names <= SHELL_PROCESS_NAMES:
        return {"identity": identity, "classification": "disposable_shell", "agent_status": status}, None
    key = recovery_identity_key(identity)
    if key in acknowledgements:
        return {"identity": identity, "classification": "intentionally_volatile", "agent_status": status}, None
    return {"identity": identity, "classification": "blocker", "agent_status": status}, {
        "kind": "blocker", "identity": identity
    }


def recovery_preflight_snapshot(
    session: str, snapshot: dict[str, Any], layouts: dict[str, dict[str, Any]], acknowledgements: set[str]
) -> dict[str, Any]:
    """Read-only strict checks against one already-captured live snapshot."""
    selected = require_recovery_session(session)
    records = manifest_records()
    records_by_pane = {
        str(record.get("pane_id")): record
        for record in records
        if record.get("herdr_session") == selected and record.get("pane_id")
    }
    restores = {
        str(item.get("source_pane_id")): item
        for item in agent_restore_records(snapshot.get("panes", []), selected, records)
        if item.get("source_pane_id")
    }
    classifications: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    workspaces = snapshot.get("workspaces", [])
    focused_workspaces = [
        workspace
        for workspace in workspaces
        if isinstance(workspace, dict) and workspace.get("focused") and workspace.get("workspace_id")
    ]
    if not focused_workspaces:
        failures.append(
            {"kind": "no_focused_workspace", "identity": recovery_identity(selected), "focused_workspace_count": 0}
        )
    elif len(focused_workspaces) != 1:
        failures.append(
            {
                "kind": "multiple_focused_workspaces",
                "identity": recovery_identity(selected),
                "focused_workspace_count": len(focused_workspaces),
            }
        )
    for workspace in workspaces:
        if not isinstance(workspace, dict) or not workspace.get("workspace_id"):
            raise OrganizerError("Herdr snapshot contains a workspace without an ID.")
        identity = recovery_identity(selected, str(workspace["workspace_id"]))
        issue = recovery_path_issue(workspace.get("cwd"), "missing_workspace_cwd", identity)
        if issue:
            failures.append(issue)
    for pane in snapshot.get("panes", []):
        if not isinstance(pane, dict):
            raise OrganizerError("Herdr snapshot contains an invalid pane.")
        pane_id = str(pane.get("pane_id") or "")
        workspace_id = str(pane.get("workspace_id") or "")
        tab_id = str(pane.get("tab_id") or "")
        identity = recovery_identity(selected, workspace_id or None, tab_id or None, pane_id or None)
        issue = recovery_path_issue(pane.get("foreground_cwd") or pane.get("cwd"), "missing_pane_cwd", identity)
        if issue:
            failures.append(issue)
        registered = records_by_pane.get(pane_id, {})
        if "worktree" in registered:
            issue = recovery_path_issue(registered.get("worktree"), "missing_registered_worktree", identity)
            if issue:
                failures.append(issue)
        classification, failure = recovery_pane_classification(
            pane, restores.get(pane_id, {}), selected, acknowledgements
        )
        classifications.append(classification)
        if failure:
            failures.append(failure)
    return {
        "session": selected,
        "snapshot": snapshot,
        "layouts": layouts,
        "layout_fingerprints": recovery_layout_fingerprints(layouts),
        "classifications": classifications,
        "failures": failures,
    }


def recovery_preflight_session(session: str, acknowledgements: set[str]) -> dict[str, Any]:
    """Read-only checks. This function never sends a pane command or closes anything."""
    selected = require_recovery_session(session)
    try:
        snapshot = session_snapshot(selected)
    except OrganizerError as error:
        raise OrganizerError(f"Recovery session {selected!r} is not attached: {error}") from error
    layouts = recovery_layouts(snapshot, selected)
    return recovery_preflight_snapshot(selected, snapshot, layouts, acknowledgements)


RECOVERY_MARKER_PATTERN = re.compile(r" \[rrb:([a-z0-9]{24})\]$")


def recovery_operation_marker(bundle_id: str, identity: dict[str, Any], kind: str) -> str:
    material = f"{bundle_id}|{kind}|{recovery_identity_key(identity)}"
    return hashlib.sha256(material.encode()).hexdigest()[:24]


def recovery_marked_label(label: Any, marker: str) -> str:
    base = str(label or "Recovered")
    return f"{base} [rrb:{marker}]"


def normalized_recovery_label(label: Any) -> Any:
    if not isinstance(label, str):
        return label
    return RECOVERY_MARKER_PATTERN.sub("", label)


def recovery_workspace_fingerprint(workspace: dict[str, Any]) -> str:
    material = {
        "label": normalized_recovery_label(workspace.get("label")),
        "cwd": workspace.get("cwd"),
        "focused": bool(workspace.get("focused")),
        "tabs": [
            {
                "label": normalized_recovery_label(tab.get("label")),
                "index": tab.get("index"),
                "focused": bool(tab.get("focused")),
                "layout_shape": tab.get("layout_shape_fingerprint"),
            }
            for tab in workspace.get("tabs", [])
        ],
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def recovery_capture_from_snapshot(
    session: str, snapshot: dict[str, Any], layouts: dict[str, dict[str, Any]], preflight: dict[str, Any]
) -> dict[str, Any]:
    selected = require_recovery_session(session)
    classifications = {
        recovery_identity_key(item["identity"]): item
        for item in preflight["classifications"]
        if isinstance(item, dict) and isinstance(item.get("identity"), dict)
    }
    records = manifest_records()
    restores = {
        str(item.get("source_pane_id")): item
        for item in agent_restore_records(snapshot.get("panes", []), selected, records)
        if item.get("source_pane_id")
    }
    workspaces: list[dict[str, Any]] = []
    for workspace in snapshot.get("workspaces", []):
        if not isinstance(workspace, dict) or not isinstance(workspace.get("workspace_id"), str):
            raise OrganizerError("Herdr snapshot contains a workspace without an ID.")
        workspace_id = str(workspace["workspace_id"])
        captured_tabs: list[dict[str, Any]] = []
        for index, tab in enumerate(tabs_for_workspace(snapshot, workspace_id)):
            tab_id = str(tab.get("tab_id") or "")
            layout = layouts.get(tab_id)
            if not layout:
                raise OrganizerError(f"No captured layout exists for tab {tab_id}.")
            captured_panes: list[dict[str, Any]] = []
            for pane in panes_for_tab(snapshot, tab_id):
                pane_id = str(pane.get("pane_id") or "")
                identity = recovery_identity(selected, workspace_id, tab_id, pane_id)
                captured_panes.append(
                    {
                        "identity": identity,
                        "cwd": pane.get("foreground_cwd") or pane.get("cwd"),
                        "classification": classifications.get(recovery_identity_key(identity), {}).get("classification"),
                        "agent_restore": restores.get(pane_id, {"source_pane_id": pane_id, "restore_status": "shell_only"}),
                    }
                )
            captured_tabs.append(
                {
                    "identity": recovery_identity(selected, workspace_id, tab_id),
                    "label": tab.get("label") or tab_id,
                    "index": index,
                    "focused": bool(tab.get("focused")),
                    "layout": layout,
                    "layout_fingerprint": layout_fingerprint(layout),
                    "layout_shape_fingerprint": layout_shape_fingerprint(layout),
                    "panes": captured_panes,
                }
            )
        captured_workspace = {
            "identity": recovery_identity(selected, workspace_id),
            "label": workspace.get("label") or workspace_id,
            "cwd": workspace.get("cwd"),
            "focused": bool(workspace.get("focused")),
            "tabs": captured_tabs,
        }
        captured_workspace["fingerprint"] = recovery_workspace_fingerprint(captured_workspace)
        workspaces.append(captured_workspace)
    return {
        "version": RECOVERY_SCHEMA_VERSION,
        "session": selected,
        "captured_at": now(),
        "structure": recovery_structure(snapshot),
        "layout_fingerprints": recovery_layout_fingerprints(layouts),
        "workspaces": workspaces,
        "preflight": {
            "classifications": preflight["classifications"],
            "failures": preflight["failures"],
        },
    }


def preflight_classification_map(preflight: dict[str, Any]) -> dict[str, str]:
    return {
        recovery_identity_key(item["identity"]): str(item.get("classification"))
        for item in preflight.get("classifications", [])
        if isinstance(item, dict) and isinstance(item.get("identity"), dict)
    }


def stable_recovery_capture(session: str, acknowledgements: set[str], attempts: int) -> dict[str, Any]:
    selected = require_recovery_session(session)
    if attempts < 1:
        raise OrganizerError("--capture-attempts must be at least 1.")
    for attempt in range(1, attempts + 1):
        first = session_snapshot(selected)
        first_layouts = recovery_layouts(first, selected)
        second = session_snapshot(selected)
        second_layouts = recovery_layouts(second, selected)
        if (
            recovery_structure(first) == recovery_structure(second)
            and recovery_layout_fingerprints(first_layouts) == recovery_layout_fingerprints(second_layouts)
        ):
            first_preflight = recovery_preflight_snapshot(selected, first, first_layouts, acknowledgements)
            second_preflight = recovery_preflight_snapshot(selected, second, second_layouts, acknowledgements)
            if first_preflight["failures"] or second_preflight["failures"]:
                raise OrganizerError(
                    f"Recovery capture for session {selected!r} failed final quiesce preflight. Resolve the named failures and retry."
                )
            if preflight_classification_map(first_preflight) != preflight_classification_map(second_preflight):
                continue
            capture = recovery_capture_from_snapshot(selected, second, second_layouts, second_preflight)
            capture["capture_attempt"] = attempt
            return capture
    raise OrganizerError(
        f"Recovery capture for session {selected!r} changed during {attempts} quiesce check attempt(s). "
        "Quiesce tab changes and retry."
    )


def recovery_bundle_id() -> str:
    return f"recovery-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:10]}"


def recovery_bundle_path(bundle_id: str) -> Path:
    if not re.fullmatch(r"recovery-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{10}", bundle_id):
        raise OrganizerError("Recovery bundle ID is invalid.")
    return RECOVERY_BUNDLE_DIR / bundle_id


def validate_recovery_bundle(path: Path, *, require_ready: bool = True) -> dict[str, Any]:
    manifest_path = path / "manifest.json"
    if not manifest_path.is_file():
        raise OrganizerError(f"Recovery bundle is missing its manifest: {path}")
    manifest = read_json(manifest_path, {})
    if manifest.get("schema_version") != RECOVERY_SCHEMA_VERSION or not manifest.get("bundle_id"):
        raise OrganizerError("Recovery bundle has an unsupported manifest schema.")
    if (path.stat().st_mode & 0o777) != 0o700:
        raise OrganizerError(f"Recovery bundle directory does not have mode 0700: {path}")
    checksums = manifest.get("checksums")
    if not isinstance(checksums, dict) or not checksums:
        raise OrganizerError("Recovery bundle has no per-session checksums.")
    for relative, expected in checksums.items():
        candidate = path / str(relative)
        if candidate.parent != path / "sessions" or not candidate.is_file():
            raise OrganizerError("Recovery bundle references an invalid session file.")
        if (candidate.stat().st_mode & 0o777) != 0o600:
            raise OrganizerError(f"Recovery bundle file does not have mode 0600: {candidate}")
        if private_json_digest(candidate) != expected:
            raise OrganizerError(f"Recovery bundle checksum failed for {relative}.")
    if (manifest_path.stat().st_mode & 0o777) != 0o600:
        raise OrganizerError("Recovery manifest does not have mode 0600.")
    ready_path = path / "ready"
    if require_ready:
        if not ready_path.is_file() or (ready_path.stat().st_mode & 0o777) != 0o600:
            raise OrganizerError("Recovery bundle is not ready. Do not restart yet.")
        ready = read_json(ready_path, {})
        if ready.get("bundle_id") != manifest.get("bundle_id") or ready.get("manifest_sha256") != private_json_digest(manifest_path):
            raise OrganizerError("Recovery ready marker does not validate the manifest.")
    return manifest


def write_recovery_bundle(captures: list[dict[str, Any]]) -> str:
    ensure_private_directory(RECOVERY_BUNDLE_DIR)
    bundle_id = recovery_bundle_id()
    target = recovery_bundle_path(bundle_id)
    stage = RECOVERY_BUNDLE_DIR / f".{bundle_id}.{uuid.uuid4().hex}.staging"
    stage.mkdir(mode=0o700)
    stage.chmod(0o700)
    session_dir = stage / "sessions"
    ensure_private_directory(session_dir)
    checksums: dict[str, str] = {}
    session_files: list[dict[str, Any]] = []
    try:
        for capture in captures:
            session = require_recovery_session(capture.get("session"))
            filename = f"{hashlib.sha256(session.encode()).hexdigest()[:20]}.json"
            relative = f"sessions/{filename}"
            path = stage / relative
            write_private_json(path, capture)
            checksums[relative] = private_json_digest(path)
            session_files.append({"identity": recovery_identity(session), "file": relative})
        manifest = {
            "schema_version": RECOVERY_SCHEMA_VERSION,
            "bundle_id": bundle_id,
            "created_at": now(),
            "sessions": session_files,
            "checksums": checksums,
            "state": "sealed",
        }
        write_private_json(stage / "manifest.json", manifest)
        validate_recovery_bundle(stage, require_ready=False)
        stage.replace(target)
        ready = {"bundle_id": bundle_id, "manifest_sha256": private_json_digest(target / "manifest.json"), "published_at": now()}
        write_private_json(target / "ready", ready)
        validate_recovery_bundle(target)
        return bundle_id
    except Exception:
        if stage.exists():
            for child in sorted(stage.rglob("*"), reverse=True):
                if child.is_file():
                    child.unlink(missing_ok=True)
                elif child.is_dir():
                    child.rmdir()
            stage.rmdir()
        raise


def load_recovery_bundle(bundle_id: str) -> tuple[Path, dict[str, Any], list[dict[str, Any]]]:
    path = recovery_bundle_path(bundle_id)
    if not path.is_dir():
        raise OrganizerError(f"Recovery bundle {bundle_id!r} was not found.")
    manifest = validate_recovery_bundle(path)
    captures: list[dict[str, Any]] = []
    for descriptor in manifest.get("sessions", []):
        if not isinstance(descriptor, dict) or not isinstance(descriptor.get("file"), str):
            raise OrganizerError("Recovery bundle session descriptor is invalid.")
        capture = read_json(path / descriptor["file"], {})
        session = descriptor.get("identity", {}).get("herdr_session") if isinstance(descriptor.get("identity"), dict) else None
        if capture.get("session") != session:
            raise OrganizerError("Recovery bundle session file does not match its manifest identity.")
        captures.append(capture)
    return path, manifest, captures


def redacted_preflight_summary(preflights: Iterable[dict[str, Any]]) -> dict[str, Any]:
    sessions = []
    for preflight in preflights:
        classes: dict[str, int] = {}
        for item in preflight["classifications"]:
            name = str(item.get("classification"))
            classes[name] = classes.get(name, 0) + 1
        sessions.append({"session": preflight["session"], "process_classes": classes, "failure_count": len(preflight["failures"])})
    return {"sessions": sessions, "ready_to_seal": not any(item["failures"] for item in preflights)}


def prepare_restart_recovery_command(args: argparse.Namespace) -> None:
    selected = recovery_sessions(args)
    acknowledgements = recovery_acknowledgements(args.allow_volatile_pane)
    preflights = [recovery_preflight_session(session, acknowledgements) for session in selected]
    summary = redacted_preflight_summary(preflights)
    if any(item["failures"] for item in preflights):
        print(json.dumps(summary, indent=2))
        raise OrganizerError("Restart recovery preflight failed. Resolve each named failure or acknowledge only the intended volatile pane.")
    if args.preflight_only:
        print(json.dumps(summary, indent=2))
        print("Preflight passed. No recovery bundle was written.")
        return
    captures = [stable_recovery_capture(session, acknowledgements, args.capture_attempts) for session in selected]
    bundle_id = write_recovery_bundle(captures)
    print(json.dumps({"bundle_id": bundle_id, "session_count": len(captures), "ready": True}, indent=2))
    print("Recovery bundle sealed. Restart only after retaining this ready bundle locally.")


def native_recovery_workspace(snapshot: dict[str, Any], workspace: dict[str, Any], session: str) -> dict[str, Any]:
    workspace_id = str(workspace.get("workspace_id") or "")
    tabs: list[dict[str, Any]] = []
    for index, tab in enumerate(tabs_for_workspace(snapshot, workspace_id)):
        tab_id = str(tab.get("tab_id") or "")
        layout = recovery_layouts({"tabs": [tab]}, session).get(tab_id)
        if not layout:
            raise OrganizerError(f"Could not inspect native tab {tab_id}.")
        tabs.append(
            {
                "identity": recovery_identity(session, workspace_id, tab_id),
                "label": tab.get("label") or tab_id,
                "index": index,
                "focused": bool(tab.get("focused")),
                "layout": layout,
                "layout_shape_fingerprint": layout_shape_fingerprint(layout),
                "panes": panes_for_tab(snapshot, tab_id),
            }
        )
    native = {
        "identity": recovery_identity(session, workspace_id),
        "label": workspace.get("label") or workspace_id,
        "cwd": workspace.get("cwd"),
        "focused": bool(workspace.get("focused")),
        "tabs": tabs,
    }
    native["fingerprint"] = recovery_workspace_fingerprint(native)
    return native


def native_recovery_workspaces(snapshot: dict[str, Any], session: str) -> list[dict[str, Any]]:
    return [native_recovery_workspace(snapshot, workspace, session) for workspace in snapshot.get("workspaces", []) if isinstance(workspace, dict)]


def plan_recovery_session(capture: dict[str, Any]) -> dict[str, Any]:
    session = require_recovery_session(capture.get("session"))
    try:
        snapshot = session_snapshot(session)
    except OrganizerError as error:
        raise OrganizerError(f"Recovery session {session!r} is not attached. Attach it interactively before reconciling: {error}") from error
    native = native_recovery_workspaces(snapshot, session)
    plans: list[dict[str, Any]] = []
    claimed_native_ids: set[str] = set()
    for source in capture.get("workspaces", []):
        if not isinstance(source, dict) or not isinstance(source.get("identity"), dict):
            raise OrganizerError("Recovery bundle contains an invalid workspace capture.")
        source_id = source["identity"].get("workspace_id")
        same_id = [item for item in native if item["identity"].get("workspace_id") == source_id]
        exact = [
            item for item in native
            if item.get("fingerprint") == source.get("fingerprint")
            and item["identity"].get("workspace_id") not in claimed_native_ids
        ]
        if len(same_id) == 1 and same_id[0].get("fingerprint") == source.get("fingerprint"):
            native_id = str(same_id[0]["identity"]["workspace_id"])
            claimed_native_ids.add(native_id)
            plans.append({"source": source, "action": "adopt", "native_workspace_id": native_id})
            continue
        if not same_id and len(exact) == 1:
            native_id = str(exact[0]["identity"]["workspace_id"])
            claimed_native_ids.add(native_id)
            plans.append({"source": source, "action": "adopt", "native_workspace_id": native_id})
            continue
        related = [
            item for item in native
            if item["identity"].get("workspace_id") == source_id or item.get("label") == source.get("label")
        ]
        if same_id or len(exact) > 1 or related:
            plans.append({"source": source, "action": "ambiguous", "candidate_workspace_ids": [item["identity"]["workspace_id"] for item in exact or related]})
            continue
        plans.append({"source": source, "action": "rebuild"})
    return {"session": session, "native_snapshot": snapshot, "workspaces": plans}


def recovery_plan_summary(plans: Iterable[dict[str, Any]]) -> dict[str, Any]:
    sessions: list[dict[str, Any]] = []
    for session_plan in plans:
        counts: dict[str, int] = {}
        for workspace in session_plan["workspaces"]:
            action = str(workspace["action"])
            counts[action] = counts.get(action, 0) + 1
        sessions.append({"session": session_plan["session"], "workspaces": counts})
    return {"sessions": sessions}


def recovery_resume_plans(captures: list[dict[str, Any]], journal: dict[str, Any]) -> list[dict[str, Any]]:
    """Resume the sealed journal rather than reclassifying its marked partial mutations."""
    plans: list[dict[str, Any]] = []
    for capture in captures:
        session = require_recovery_session(capture.get("session"))
        states = journal["sessions"][session]["workspaces"]
        workspaces: list[dict[str, Any]] = []
        for source in capture.get("workspaces", []):
            state = states[recovery_workspace_plan_key(source)]
            workspaces.append(
                {
                    "source": source,
                    "action": state["planned_action"],
                    "native_workspace_id": state.get("native_workspace_id"),
                    "candidate_workspace_ids": state.get("candidate_workspace_ids", []),
                }
            )
        plans.append({"session": session, "workspaces": workspaces})
    return plans


def recovery_journal_path(bundle_id: str) -> Path:
    recovery_bundle_path(bundle_id)
    return RECOVERY_JOURNAL_DIR / f"{bundle_id}.json"


def recovery_lock_path(bundle_id: str) -> Path:
    recovery_bundle_path(bundle_id)
    return RECOVERY_JOURNAL_DIR / f"{bundle_id}.lock"


@contextmanager
def recovery_bundle_lock(bundle_id: str) -> Iterable[None]:
    """Serialize every reconciliation and rollback for one recovery bundle."""
    ensure_private_directory(RECOVERY_JOURNAL_DIR)
    path = recovery_lock_path(bundle_id)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise OrganizerError("Another reconciliation or rollback is already running for this bundle.") from error
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def write_recovery_journal(path: Path, journal: dict[str, Any]) -> None:
    write_private_json(path, journal)


def recovery_failure_injection(stage: str) -> None:
    """A test seam for proving every persisted journal stage can resume."""
    del stage


def record_recovery_stage(path: Path, journal: dict[str, Any], stage: str) -> None:
    journal["last_stage"] = stage
    journal["updated_at"] = now()
    write_recovery_journal(path, journal)
    recovery_failure_injection(stage)


def recovery_workspace_plan_key(source: dict[str, Any]) -> str:
    identity = source.get("identity")
    if not isinstance(identity, dict):
        raise OrganizerError("Recovery workspace is missing its identity.")
    return recovery_identity_key(identity)


def recovery_workspace_marker(bundle_id: str, source: dict[str, Any]) -> str:
    return recovery_operation_marker(bundle_id, source["identity"], "workspace")


def recovery_tab_marker(bundle_id: str, source_tab: dict[str, Any]) -> str:
    return recovery_operation_marker(bundle_id, source_tab["identity"], "tab")


def new_recovery_tab_state(bundle_id: str, source_tab: dict[str, Any]) -> dict[str, Any]:
    marker = recovery_tab_marker(bundle_id, source_tab)
    return {
        "source_identity": source_tab["identity"],
        "operation_marker": marker,
        "expected_label": recovery_marked_label(source_tab.get("label"), marker),
        "expected_layout_shape": source_tab.get("layout_shape_fingerprint"),
        "status": "planned",
    }


def new_recovery_journal(bundle_id: str, plans: list[dict[str, Any]]) -> dict[str, Any]:
    sessions: dict[str, Any] = {}
    for session_plan in plans:
        workspace_states: dict[str, Any] = {}
        for plan in session_plan["workspaces"]:
            source = plan["source"]
            key = recovery_workspace_plan_key(source)
            marker = recovery_workspace_marker(bundle_id, source)
            workspace_states[key] = {
                "source_identity": source["identity"],
                "planned_action": plan["action"],
                "native_workspace_id": plan.get("native_workspace_id"),
                "candidate_workspace_ids": plan.get("candidate_workspace_ids", []),
                "operation_marker": marker,
                "expected_label": recovery_marked_label(source.get("label"), marker),
                "expected_cwd": source.get("cwd"),
                "status": "planned",
                "tabs": {
                    source_tab_key(source_tab): new_recovery_tab_state(bundle_id, source_tab)
                    for source_tab in source.get("tabs", [])
                    if isinstance(source_tab, dict)
                },
                "agent_outcomes": [],
            }
        sessions[session_plan["session"]] = {"workspaces": workspace_states, "verification": None}
    return {
        "schema_version": RECOVERY_SCHEMA_VERSION,
        "bundle_id": bundle_id,
        "created_at": now(),
        "updated_at": now(),
        "status": "prepared",
        "sessions": sessions,
    }


def validate_recovery_journal(path: Path, bundle_id: str, captures: list[dict[str, Any]]) -> dict[str, Any]:
    if path.parent != RECOVERY_JOURNAL_DIR or not path.is_file():
        raise OrganizerError("Recovery journal path is invalid.")
    if (RECOVERY_JOURNAL_DIR.stat().st_mode & 0o777) != 0o700 or (path.stat().st_mode & 0o777) != 0o600:
        raise OrganizerError("Recovery journal permissions are not private.")
    journal = read_json(path, {})
    if not isinstance(journal, dict) or journal.get("schema_version") != RECOVERY_SCHEMA_VERSION or journal.get("bundle_id") != bundle_id:
        raise OrganizerError("Existing recovery journal does not match this bundle schema.")
    if not isinstance(journal.get("status"), str) or not isinstance(journal.get("created_at"), str) or not isinstance(journal.get("updated_at"), str):
        raise OrganizerError("Recovery journal has an invalid root schema.")
    sessions = journal.get("sessions")
    expected_sessions = {require_recovery_session(capture.get("session")) for capture in captures}
    if not isinstance(sessions, dict) or set(sessions) != expected_sessions:
        raise OrganizerError("Recovery journal session scope does not match the sealed bundle.")
    for capture in captures:
        session = require_recovery_session(capture.get("session"))
        session_state = sessions.get(session)
        if not isinstance(session_state, dict) or not isinstance(session_state.get("workspaces"), dict):
            raise OrganizerError("Recovery journal has an invalid session state.")
        if session_state.get("verification") is not None and not isinstance(session_state.get("verification"), dict):
            raise OrganizerError("Recovery journal has an invalid verification state.")
        workspace_focus = session_state.get("workspace_focus")
        if workspace_focus is not None and (
            not isinstance(workspace_focus, dict)
            or workspace_focus.get("source_identity") not in [source.get("identity") for source in capture.get("workspaces", [])]
            or not isinstance(workspace_focus.get("workspace_id"), str)
            or workspace_focus.get("status") not in {"focus_intent", "focused", "already_focused"}
        ):
            raise OrganizerError("Recovery journal workspace-focus state is invalid.")
        states = session_state["workspaces"]
        expected_workspace_keys = {recovery_workspace_plan_key(source) for source in capture.get("workspaces", [])}
        if set(states) != expected_workspace_keys:
            raise OrganizerError("Recovery journal workspace scope does not match the sealed bundle.")
        for source in capture.get("workspaces", []):
            state = states.get(recovery_workspace_plan_key(source))
            if not isinstance(state, dict) or state.get("source_identity") != source.get("identity"):
                raise OrganizerError("Recovery journal workspace ownership binding is invalid.")
            marker = recovery_workspace_marker(bundle_id, source)
            if state.get("operation_marker") != marker or state.get("expected_label") != recovery_marked_label(source.get("label"), marker):
                raise OrganizerError("Recovery journal workspace marker binding is invalid.")
            if state.get("expected_cwd") != source.get("cwd") or state.get("planned_action") not in {"adopt", "rebuild", "ambiguous"}:
                raise OrganizerError("Recovery journal workspace state is invalid.")
            if not isinstance(state.get("status"), str) or not isinstance(state.get("agent_outcomes"), list):
                raise OrganizerError("Recovery journal workspace progress state is invalid.")
            for field in ("created_workspace_id", "initial_tab_id", "native_workspace_id"):
                if state.get(field) is not None and not isinstance(state.get(field), str):
                    raise OrganizerError("Recovery journal workspace ID state is invalid.")
            rollback = state.get("rollback")
            if rollback is not None and (
                not isinstance(rollback, dict)
                or rollback.get("status") not in {"close_intent", "closed", "closed_recovered"}
                or rollback.get("workspace_id") != state.get("created_workspace_id")
            ):
                raise OrganizerError("Recovery journal rollback state is invalid.")
            tabs = state.get("tabs")
            if not isinstance(tabs, dict):
                raise OrganizerError("Recovery journal tab state is invalid.")
            expected_tab_keys = {source_tab_key(tab) for tab in source.get("tabs", [])}
            if set(tabs) != expected_tab_keys:
                raise OrganizerError("Recovery journal tab scope does not match the sealed bundle.")
            for source_tab in source.get("tabs", []):
                tab = tabs.get(source_tab_key(source_tab))
                marker = recovery_tab_marker(bundle_id, source_tab)
                if (
                    not isinstance(tab, dict)
                    or tab.get("source_identity") != source_tab.get("identity")
                    or tab.get("operation_marker") != marker
                    or tab.get("expected_label") != recovery_marked_label(source_tab.get("label"), marker)
                    or tab.get("expected_layout_shape") != source_tab.get("layout_shape_fingerprint")
                    or not isinstance(tab.get("status"), str)
                    or (tab.get("destination_tab_id") is not None and not isinstance(tab.get("destination_tab_id"), str))
                ):
                    raise OrganizerError("Recovery journal tab marker binding is invalid.")
    return journal


def load_existing_recovery_journal(bundle_id: str, captures: list[dict[str, Any]]) -> tuple[Path, dict[str, Any]] | None:
    path = recovery_journal_path(bundle_id)
    if not path.exists():
        return None
    return path, validate_recovery_journal(path, bundle_id, captures)


def load_or_create_recovery_journal(
    bundle_id: str, captures: list[dict[str, Any]], plans: list[dict[str, Any]]
) -> tuple[Path, dict[str, Any]]:
    ensure_private_directory(RECOVERY_JOURNAL_DIR)
    path = recovery_journal_path(bundle_id)
    if path.exists():
        return path, validate_recovery_journal(path, bundle_id, captures)
    journal = new_recovery_journal(bundle_id, plans)
    write_recovery_journal(path, journal)
    return path, journal


def source_tab_key(tab: dict[str, Any]) -> str:
    identity = tab.get("identity")
    if not isinstance(identity, dict):
        raise OrganizerError("Recovery tab is missing its identity.")
    return recovery_identity_key(identity)


def snapshot_tab_ids(snapshot: dict[str, Any], workspace_id: str) -> set[str]:
    return {str(item["tab_id"]) for item in tabs_for_workspace(snapshot, workspace_id) if item.get("tab_id")}


def verified_marked_workspace(snapshot: dict[str, Any], state: dict[str, Any]) -> dict[str, Any] | None:
    candidates = marked_recovery_workspaces(snapshot, state)
    workspace_id = state.get("created_workspace_id")
    if workspace_id:
        candidates = [item for item in candidates if item.get("workspace_id") == workspace_id]
    return candidates[0] if candidates else None


def marked_recovery_workspaces(snapshot: dict[str, Any], state: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = [
        item
        for item in snapshot.get("workspaces", [])
        if isinstance(item, dict)
        and item.get("label") == state.get("expected_label")
        and item.get("cwd") == state.get("expected_cwd")
    ]
    if len(candidates) > 1:
        raise OrganizerError("Multiple workspaces carry this recovery operation marker. Manual repair is required.")
    return candidates


def snapshot_workspace_with_id(snapshot: dict[str, Any], workspace_id: str) -> dict[str, Any] | None:
    for workspace in snapshot.get("workspaces", []):
        if isinstance(workspace, dict) and workspace.get("workspace_id") == workspace_id:
            return workspace
    return None


def verify_created_workspace(snapshot: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    workspace = verified_marked_workspace(snapshot, state)
    if not workspace or not isinstance(workspace.get("workspace_id"), str):
        raise OrganizerError(
            "Herdr did not retain the recovery workspace operation marker. Stop for manual repair; do not retry."
        )
    state["created_workspace_id"] = str(workspace["workspace_id"])
    return workspace


def journal_recover_created_workspace(session: str, state: dict[str, Any], snapshot: dict[str, Any]) -> bool:
    del session
    if not isinstance(state.get("workspace_create_intent"), dict):
        return False
    workspace = verified_marked_workspace(snapshot, state)
    if not workspace:
        return False
    state["created_workspace_id"] = str(workspace["workspace_id"])
    tabs = snapshot_tab_ids(snapshot, state["created_workspace_id"])
    if len(tabs) != 1:
        raise OrganizerError(
            "A marked recovery workspace has an unexpected initial-tab set. Stop for manual repair."
        )
    state["initial_tab_id"] = next(iter(tabs))
    state["status"] = "workspace_created_recovered"
    return True


def verified_marked_tab(
    session: str, source_tab: dict[str, Any], tab_state: dict[str, Any], workspace_id: str, snapshot: dict[str, Any]
) -> tuple[str, dict[str, Any]] | None:
    candidates = [
        tab for tab in tabs_for_workspace(snapshot, workspace_id)
        if tab.get("label") == tab_state.get("expected_label")
        and (not tab_state.get("destination_tab_id") or tab.get("tab_id") == tab_state.get("destination_tab_id"))
    ]
    if len(candidates) > 1:
        raise OrganizerError("Multiple tabs carry this recovery operation marker. Manual repair is required.")
    if not candidates:
        return None
    tab_id = str(candidates[0].get("tab_id") or "")
    layout = socket_call(session, "layout.export", {"tab_id": tab_id}).get("layout")
    if not isinstance(layout, dict) or layout_shape_fingerprint(layout) != tab_state.get("expected_layout_shape"):
        raise OrganizerError("A marked recovery tab has the wrong layout shape. Stop for manual repair.")
    return tab_id, layout


def journal_recover_created_tab(
    session: str, source_tab: dict[str, Any], tab_state: dict[str, Any], workspace_id: str
) -> bool:
    intent = tab_state.get("layout_apply_intent")
    if not isinstance(intent, dict):
        return False
    snapshot = session_snapshot(session)
    recovered = verified_marked_tab(session, source_tab, tab_state, workspace_id, snapshot)
    if not recovered:
        return False
    tab_id, layout = recovered
    tab_state.update(
        {
            "destination_tab_id": tab_id,
            "pane_map": matching_pane_map(source_tab["layout"].get("root"), layout.get("root")),
            "status": "layout_created_recovered",
        }
    )
    return True


def rebuild_recovery_workspace(
    journal_path: Path, journal: dict[str, Any], session: str, source: dict[str, Any], state: dict[str, Any]
) -> None:
    session_state = journal["sessions"][session]
    snapshot = session_snapshot(session)
    created_workspace_id = state.get("created_workspace_id")
    if isinstance(created_workspace_id, str):
        if not verified_marked_workspace(snapshot, state):
            raise OrganizerError(
                "A journal-created workspace no longer verifies its recovery marker. Stop for manual repair."
            )
    else:
        if journal_recover_created_workspace(session, state, snapshot):
            record_recovery_stage(journal_path, journal, "workspace_created_recovered")
        if not state.get("created_workspace_id"):
            state["workspace_create_intent"] = {
                "operation_marker": state["operation_marker"],
                "expected_label": state["expected_label"],
                "expected_cwd": state["expected_cwd"],
            }
            state["status"] = "workspace_create_intent"
            record_recovery_stage(journal_path, journal, "workspace_create_intent")
            command = ["workspace", "create", "--label", state["expected_label"]]
            if isinstance(source.get("cwd"), str) and source["cwd"]:
                command.extend(["--cwd", source["cwd"]])
            created = result_of(run_json(command, session))
            state["created_workspace_id"] = extract_workspace_id(created)
            state["initial_tab_id"] = extract_tab_id(created)
            current = session_snapshot(session)
            owned = verify_created_workspace(current, state)
            if state["initial_tab_id"] not in snapshot_tab_ids(current, str(owned["workspace_id"])):
                raise OrganizerError("Herdr returned an initial tab outside the marked recovery workspace. Manual repair is required.")
            state["status"] = "workspace_created"
            record_recovery_stage(journal_path, journal, "workspace_created")
    workspace_id = str(state["created_workspace_id"])
    captured_tabs = source.get("tabs", [])
    for position, source_tab in enumerate(captured_tabs):
        if not isinstance(source_tab, dict):
            raise OrganizerError("Recovery bundle contains an invalid tab.")
        tab_key = source_tab_key(source_tab)
        tab_state = state["tabs"].get(tab_key)
        if not isinstance(tab_state, dict):
            raise OrganizerError("Recovery journal is missing a tab operation marker.")
        if tab_state.get("destination_tab_id"):
            if not verified_marked_tab(session, source_tab, tab_state, workspace_id, session_snapshot(session)):
                raise OrganizerError("A journal-created tab no longer verifies its recovery marker. Stop for manual repair.")
            continue
        if journal_recover_created_tab(session, source_tab, tab_state, workspace_id):
            record_recovery_stage(journal_path, journal, "layout_created_recovered")
            continue
        current = session_snapshot(session)
        reuse_initial = position == 0
        if reuse_initial:
            initial_tab_id = state.get("initial_tab_id")
            if not isinstance(initial_tab_id, str):
                choices = snapshot_tab_ids(current, workspace_id)
                if len(choices) != 1:
                    raise OrganizerError("Could not identify the initial tab for a recovery-created workspace.")
                initial_tab_id = next(iter(choices))
                state["initial_tab_id"] = initial_tab_id
            params = {"tab_id": initial_tab_id, "tab_label": source_tab.get("label"), "focus": False, "root": source_tab["layout"].get("root")}
        else:
            params = {"workspace_id": workspace_id, "tab_label": source_tab.get("label"), "focus": False, "root": source_tab["layout"].get("root")}
        tab_state["layout_apply_intent"] = {"operation_marker": tab_state["operation_marker"], "reuse_initial_tab": reuse_initial}
        tab_state["status"] = "layout_apply_intent"
        record_recovery_stage(journal_path, journal, "layout_apply_intent")
        params["tab_label"] = tab_state["expected_label"]
        params["focus"] = bool(source_tab.get("focused"))
        applied = socket_call(session, "layout.apply", params)
        layout = applied.get("layout")
        if not isinstance(layout, dict) or not layout.get("tab_id"):
            raise OrganizerError("Herdr did not return a rebuilt layout after recovery mutation.")
        tab_state["destination_tab_id"] = str(layout["tab_id"])
        verified = verified_marked_tab(session, source_tab, tab_state, workspace_id, session_snapshot(session))
        if not verified:
            raise OrganizerError("Herdr did not retain the recovery tab operation marker. Stop for manual repair; do not retry.")
        _tab_id, verified_layout = verified
        tab_state.update(
            {
                "pane_map": matching_pane_map(source_tab["layout"].get("root"), verified_layout.get("root")),
                "status": "layout_created",
            }
        )
        record_recovery_stage(journal_path, journal, "layout_created")
    state["status"] = "layouts_rebuilt"
    session_state["last_workspace"] = state["source_identity"]
    record_recovery_stage(journal_path, journal, "layouts_rebuilt")


def snapshot_has_exclusive_workspace_focus(snapshot: dict[str, Any], workspace_id: str) -> bool:
    focused = [
        str(workspace.get("workspace_id"))
        for workspace in snapshot.get("workspaces", [])
        if isinstance(workspace, dict) and workspace.get("focused") and workspace.get("workspace_id")
    ]
    return focused == [workspace_id]


def restore_recovery_session_focus(
    journal_path: Path, journal: dict[str, Any], session: str, capture: dict[str, Any]
) -> None:
    """Restore the source's active workspace after all rebuilt layouts exist."""
    session_state = journal["sessions"][session]
    workspace_states = session_state["workspaces"]
    sources = [source for source in capture.get("workspaces", []) if isinstance(source, dict)]
    if not any(
        workspace_states.get(recovery_workspace_plan_key(source), {}).get("planned_action") == "rebuild"
        for source in sources
    ):
        return
    focused_sources = [source for source in sources if source.get("focused")]
    if not focused_sources:
        return
    if len(focused_sources) != 1:
        raise OrganizerError("Recovery bundle does not identify exactly one focused workspace for this session.")
    source = focused_sources[0]
    state = workspace_states[recovery_workspace_plan_key(source)]
    target_id = state.get("native_workspace_id") if state.get("planned_action") == "adopt" else state.get("created_workspace_id")
    if not isinstance(target_id, str) or not target_id:
        raise OrganizerError("Recovery journal has no target workspace for the focused source workspace.")
    focus_state = session_state.setdefault("workspace_focus", {})
    if not isinstance(focus_state, dict):
        raise OrganizerError("Recovery journal workspace-focus state is invalid.")
    focus_state.update(
        {
            "source_identity": source["identity"],
            "workspace_id": target_id,
            "status": "focus_intent",
        }
    )
    current = session_snapshot(session)
    if snapshot_has_exclusive_workspace_focus(current, target_id):
        focus_state["status"] = "already_focused"
        record_recovery_stage(journal_path, journal, "workspace_focus_verified")
        return
    record_recovery_stage(journal_path, journal, "workspace_focus_intent")
    run_json(["workspace", "focus", target_id], session)
    if not snapshot_has_exclusive_workspace_focus(session_snapshot(session), target_id):
        raise OrganizerError("Herdr did not restore the expected recovery workspace focus. Stop for manual repair.")
    focus_state["status"] = "focused"
    record_recovery_stage(journal_path, journal, "workspace_focused")


def recovery_pane_map(state: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for tab in state.get("tabs", {}).values():
        if not isinstance(tab, dict):
            continue
        mapping = tab.get("pane_map")
        if not isinstance(mapping, dict):
            continue
        for source_pane, target_pane in mapping.items():
            if source_pane in result or not isinstance(target_pane, str):
                raise OrganizerError("Recovery journal has a duplicate or invalid pane map.")
            result[str(source_pane)] = target_pane
    return result


def native_agent_already_recovered(pane: dict[str, Any], restore: dict[str, Any]) -> bool:
    expected = restore.get("session_id")
    native = pane.get("agent_session")
    if isinstance(native, dict) and native.get("value") == expected:
        return True
    return pane.get("agent") == restore.get("client") and pane.get("agent_status") in {"working", "blocked"}


def dispatch_recovery_agents(
    journal_path: Path, journal: dict[str, Any], session: str, source: dict[str, Any], state: dict[str, Any], enabled: bool
) -> None:
    if state.get("planned_action") == "adopt":
        state["agent_outcomes"] = [{"status": "adopted_native", "dispatch": "not_needed"}]
        return
    pane_map = recovery_pane_map(state)
    live = {str(pane.get("pane_id")): pane for pane in session_snapshot(session).get("panes", []) if isinstance(pane, dict)}
    outcomes = state.setdefault("agent_outcomes", [])
    known = {str(item.get("source_pane_id")): item for item in outcomes if isinstance(item, dict) and item.get("source_pane_id")}
    for tab in source.get("tabs", []):
        for pane in tab.get("panes", []):
            restore = pane.get("agent_restore", {}) if isinstance(pane, dict) else {}
            if not is_trusted_restore(restore):
                continue
            source_pane = str(restore.get("source_pane_id") or pane.get("identity", {}).get("pane_id") or "")
            if not source_pane or source_pane in known:
                continue
            target_pane = pane_map.get(source_pane)
            if not target_pane:
                outcomes.append({"source_pane_id": source_pane, "status": "unmapped", "dispatch": "not_sent"})
                continue
            target = live.get(target_pane, {})
            if native_agent_already_recovered(target, restore):
                outcomes.append({"source_pane_id": source_pane, "pane_id": target_pane, "status": "native_recovered", "dispatch": "not_sent"})
                continue
            if not enabled:
                outcomes.append({"source_pane_id": source_pane, "pane_id": target_pane, "status": "resume_not_requested", "dispatch": "not_sent"})
                continue
            command = restore.get("resume_command")
            if not isinstance(command, str) or not command:
                outcomes.append({"source_pane_id": source_pane, "pane_id": target_pane, "status": "unavailable", "dispatch": "not_sent"})
                continue
            outcomes.append({"source_pane_id": source_pane, "pane_id": target_pane, "status": "resume_intent", "dispatch": "pending"})
            record_recovery_stage(journal_path, journal, "resume_intent")
            run_command(["pane", "run", target_pane, command], session)
            outcomes[-1].update({"status": "resume_dispatched", "dispatch": "sent", "dispatched_at": now()})
            record_recovery_stage(journal_path, journal, "resume_dispatched")


def recovery_duplicate_fingerprint(workspace: dict[str, Any]) -> str:
    material = {
        "label": normalized_recovery_label(workspace.get("label")),
        "cwd": workspace.get("cwd"),
        "tabs": [
            {
                "label": normalized_recovery_label(tab.get("label")),
                "index": tab.get("index"),
                "layout_shape": tab.get("layout_shape_fingerprint"),
            }
            for tab in workspace.get("tabs", [])
        ],
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def expected_target_label(source: dict[str, Any], state: dict[str, Any]) -> Any:
    return source.get("label") if state.get("planned_action") == "adopt" else state.get("expected_label")


def verify_recovery_session(
    session: str, capture: dict[str, Any], journal: dict[str, Any]
) -> dict[str, Any]:
    snapshot = session_snapshot(session)
    workspace_states = journal["sessions"][session]["workspaces"]
    expected_counts = {"workspaces": len(capture.get("workspaces", [])), "tabs": 0, "panes": 0}
    actual_counts = {"workspaces": 0, "tabs": 0, "panes": 0}
    failures: list[str] = []
    native_workspaces = native_recovery_workspaces(snapshot, session)
    native_by_id = {str(item["identity"].get("workspace_id")): item for item in native_workspaces}
    target_ids: set[str] = set()
    for source in capture.get("workspaces", []):
        expected_counts["tabs"] += len(source.get("tabs", []))
        expected_counts["panes"] += sum(len(tab.get("panes", [])) for tab in source.get("tabs", []))
        state = workspace_states.get(recovery_workspace_plan_key(source), {})
        target_id = state.get("native_workspace_id") if state.get("planned_action") == "adopt" else state.get("created_workspace_id")
        target = native_by_id.get(str(target_id))
        if not target:
            failures.append("expected_workspace_missing")
            continue
        target_ids.add(str(target_id))
        actual_counts["workspaces"] += 1
        target_tabs = target.get("tabs", [])
        actual_counts["tabs"] += len(target_tabs)
        actual_counts["panes"] += sum(len(tab.get("panes", [])) for tab in target_tabs)
        if target.get("cwd") != source.get("cwd") or recovery_path_issue(
            target.get("cwd"), "missing_workspace_cwd", recovery_identity(session, str(target_id))
        ):
            failures.append("workspace_cwd_mismatch")
        if target.get("label") != expected_target_label(source, state):
            failures.append("workspace_label_mismatch")
        if bool(target.get("focused")) != bool(source.get("focused")):
            failures.append("workspace_focus_mismatch")
        if len(target_tabs) != len(source.get("tabs", [])):
            failures.append("tab_count_mismatch")
        for index, source_tab in enumerate(source.get("tabs", [])):
            if index >= len(target_tabs):
                break
            target_tab = target_tabs[index]
            tab_state = state.get("tabs", {}).get(source_tab_key(source_tab), {})
            if target_tab.get("index") != source_tab.get("index"):
                failures.append("tab_order_mismatch")
            expected_tab_label = source_tab.get("label") if state.get("planned_action") == "adopt" else tab_state.get("expected_label")
            if target_tab.get("label") != expected_tab_label:
                failures.append("tab_label_mismatch")
            if target_tab.get("layout_shape_fingerprint") != source_tab.get("layout_shape_fingerprint"):
                failures.append("layout_shape_mismatch")
            if bool(target_tab.get("focused")) != bool(source_tab.get("focused")):
                failures.append("tab_focus_mismatch")
            for pane in target_tab.get("panes", []):
                if recovery_path_issue(
                    pane.get("foreground_cwd") or pane.get("cwd"), "missing_pane_cwd",
                    recovery_identity(session, str(target_id), str(target_tab["identity"].get("tab_id")), str(pane.get("pane_id") or "")),
                ):
                    failures.append("pane_cwd_missing")
        maps = recovery_pane_map(state) if state.get("planned_action") != "adopt" else {}
        if len(set(maps.values())) != len(maps):
            failures.append("duplicate_pane_map")
        live = {str(item.get("pane_id")): item for item in snapshot.get("panes", []) if isinstance(item, dict)}
        for outcome in state.get("agent_outcomes", []):
            if outcome.get("dispatch") == "sent":
                target_pane = live.get(str(outcome.get("pane_id")), {})
                outcome["observed"] = bool(target_pane.get("agent"))
                outcome["recovery_observation"] = "observed_agent" if outcome["observed"] else "not_observed_yet"
    if expected_counts != actual_counts:
        failures.append("count_mismatch")
    expected_duplicates: dict[str, int] = {}
    for source in capture.get("workspaces", []):
        fingerprint = recovery_duplicate_fingerprint(source)
        expected_duplicates[fingerprint] = expected_duplicates.get(fingerprint, 0) + 1
    actual_duplicates: dict[str, int] = {}
    for workspace in native_workspaces:
        fingerprint = recovery_duplicate_fingerprint(workspace)
        if fingerprint in expected_duplicates:
            actual_duplicates[fingerprint] = actual_duplicates.get(fingerprint, 0) + 1
    if actual_duplicates != expected_duplicates:
        failures.append("duplicate_bundle_fingerprint")
    return {"verified_at": now(), "expected_counts": expected_counts, "actual_counts": actual_counts, "failures": sorted(set(failures)), "post_boot_snapshot": snapshot}


def execute_recovery_reconciliation(
    bundle_id: str,
    captures: list[dict[str, Any]],
    plans: list[dict[str, Any]],
    resume_agents: bool,
    existing_journal: tuple[Path, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    journal_path, journal = existing_journal or load_or_create_recovery_journal(bundle_id, captures, plans)
    for capture in captures:
        session = require_recovery_session(capture.get("session"))
        states = journal["sessions"].get(session, {}).get("workspaces", {})
        for plan in next(item for item in plans if item["session"] == session)["workspaces"]:
            source = plan["source"]
            state = states.get(recovery_workspace_plan_key(source))
            if not state:
                raise OrganizerError("Recovery journal is missing a planned workspace.")
            if state.get("planned_action") == "ambiguous":
                raise OrganizerError("Recovery journal contains an ambiguous workspace. It cannot rebuild automatically.")
            if state.get("planned_action") == "adopt":
                state["status"] = "adopted"
                record_recovery_stage(journal_path, journal, "workspace_adopted")
            else:
                rebuild_recovery_workspace(journal_path, journal, session, source, state)
            dispatch_recovery_agents(journal_path, journal, session, source, state, resume_agents)
        restore_recovery_session_focus(journal_path, journal, session, capture)
        verification = verify_recovery_session(session, capture, journal)
        journal["sessions"][session]["verification"] = verification
        record_recovery_stage(journal_path, journal, "session_verified")
    journal["status"] = "completed" if not any(
        session.get("verification", {}).get("failures") for session in journal["sessions"].values()
    ) else "verification_failed"
    record_recovery_stage(journal_path, journal, "reconciliation_completed")
    return journal


def recovery_reconciliation_plans(
    captures: list[dict[str, Any]], existing_journal: tuple[Path, dict[str, Any]] | None
) -> list[dict[str, Any]]:
    if not existing_journal:
        return [plan_recovery_session(capture) for capture in captures]
    for capture in captures:
        session = require_recovery_session(capture.get("session"))
        try:
            session_snapshot(session)
        except OrganizerError as error:
            raise OrganizerError(
                f"Recovery session {session!r} is not attached. Attach it interactively before reconciling: {error}"
            ) from error
    return recovery_resume_plans(captures, existing_journal[1])


def reconcile_all_command(args: argparse.Namespace) -> None:
    _path, _manifest, captures = load_recovery_bundle(args.bundle)
    existing_journal = load_existing_recovery_journal(args.bundle, captures)
    if not args.confirm:
        plans = recovery_reconciliation_plans(captures, existing_journal)
        summary = recovery_plan_summary(plans)
        print(json.dumps(summary, indent=2))
        print(f"Preview only. Re-run with --confirm {args.bundle!r} after attaching every bundled named session.")
        return
    if args.confirm != args.bundle:
        raise OrganizerError(f"Reconcile requires --confirm {args.bundle!r}.")
    with recovery_bundle_lock(args.bundle):
        # Reload under the mutation lock so a concurrent confirmed command
        # cannot change the persisted plan between preview and execution.
        existing_journal = load_existing_recovery_journal(args.bundle, captures)
        plans = recovery_reconciliation_plans(captures, existing_journal)
        summary = recovery_plan_summary(plans)
        ambiguous = [plan for session in plans for plan in session["workspaces"] if plan["action"] == "ambiguous"]
        if ambiguous:
            if not args.copy_ambiguous:
                print(json.dumps(summary, indent=2))
                raise OrganizerError("Ambiguous native workspaces were not rebuilt. Review them or choose a deliberate extra copy.")
            if existing_journal:
                raise OrganizerError("A persisted ambiguous recovery journal requires manual repair; it cannot be converted into a copy.")
            if args.confirm_extra != f"copy:{args.bundle}":
                raise OrganizerError(f"A deliberate extra copy requires --confirm-extra {'copy:' + args.bundle!r}.")
            for plan in ambiguous:
                plan["action"] = "rebuild"
        journal = execute_recovery_reconciliation(
            args.bundle, captures, plans, args.resume_agents, existing_journal=existing_journal
        )
    output = {"bundle_id": args.bundle, "status": journal["status"], "sessions": []}
    for session, state in journal["sessions"].items():
        verification = state.get("verification") or {}
        output["sessions"].append({"session": session, "verification_failures": verification.get("failures", []), "agent_dispatches": sum(1 for workspace in state["workspaces"].values() for outcome in workspace.get("agent_outcomes", []) if outcome.get("dispatch") == "sent")})
    print(json.dumps(output, indent=2))
    print("Agent dispatch and observed recovery are recorded separately in the private reconciliation journal.")


def recovery_rollback_workspaces(
    captures: list[dict[str, Any]], journal: dict[str, Any]
) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
    created: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    for capture in captures:
        session = require_recovery_session(capture.get("session"))
        states = journal["sessions"][session]["workspaces"]
        for source in capture.get("workspaces", []):
            state = states[recovery_workspace_plan_key(source)]
            if state.get("planned_action") == "rebuild" and isinstance(state.get("created_workspace_id"), str):
                created.append((session, source, state))
    return created


def rollback_recovery_workspaces(
    journal_path: Path, journal: dict[str, Any], captures: list[dict[str, Any]]
) -> int:
    created = recovery_rollback_workspaces(captures, journal)
    for session, source, state in created:
        snapshot = session_snapshot(session)  # Refuse unattached sessions before any mutation.
        rollback = state.get("rollback")
        created_workspace_id = state["created_workspace_id"]
        if isinstance(rollback, dict) and rollback.get("status") == "close_intent":
            live_created = snapshot_workspace_with_id(snapshot, created_workspace_id)
            if not live_created:
                state["rollback"] = {
                    "status": "closed_recovered",
                    "workspace_id": created_workspace_id,
                    "closed_at": now(),
                }
                record_recovery_stage(journal_path, journal, "rollback_workspace_closed_recovered")
                continue
            if not verified_marked_workspace(snapshot, state):
                raise OrganizerError(
                    "A close-intent recovery workspace still exists but no longer verifies its operation marker. "
                    "Stop for manual repair."
                )
        marked = marked_recovery_workspaces(snapshot, state)
        if isinstance(rollback, dict) and rollback.get("status") in {"closed", "closed_recovered"}:
            if marked:
                raise OrganizerError(
                    "A workspace recorded as closed still carries this recovery marker. Stop for manual repair."
                )
            continue
        workspace = verify_created_workspace(snapshot, state)
        workspace_id = str(workspace["workspace_id"])
        for source_tab in source.get("tabs", []):
            tab_state = state["tabs"][source_tab_key(source_tab)]
            if not verified_marked_tab(session, source_tab, tab_state, workspace_id, snapshot):
                raise OrganizerError("Recovery tab ownership marker is missing. Rollback refused; manual repair is required.")
        state["rollback"] = {
            "status": "close_intent",
            "workspace_id": workspace_id,
            "started_at": now(),
        }
        record_recovery_stage(journal_path, journal, "rollback_workspace_close_intent")
        run_json(["workspace", "close", workspace_id], session)
        if marked_recovery_workspaces(session_snapshot(session), state):
            raise OrganizerError("Herdr did not close the marked recovery workspace. Stop for manual repair.")
        state["rollback"] = {
            "status": "closed",
            "workspace_id": workspace_id,
            "closed_at": now(),
        }
        record_recovery_stage(journal_path, journal, "rollback_workspace_closed")
    journal["status"] = "rolled_back"
    journal["rolled_back_at"] = now()
    record_recovery_stage(journal_path, journal, "rollback_completed")
    return len(created)


def rollback_reconcile_command(args: argparse.Namespace) -> None:
    _path, _manifest, captures = load_recovery_bundle(args.bundle)
    existing = load_existing_recovery_journal(args.bundle, captures)
    if not existing:
        raise OrganizerError("No reconciliation journal exists for this bundle.")
    if not args.confirm:
        created = recovery_rollback_workspaces(captures, existing[1])
        print(json.dumps({"bundle_id": args.bundle, "created_workspace_count": len(created)}, indent=2))
        print(f"Preview only. Re-run with --confirm {args.bundle!r} to close only workspaces created by this journal.")
        return
    if args.confirm != args.bundle:
        raise OrganizerError(f"Rollback requires --confirm {args.bundle!r}.")
    with recovery_bundle_lock(args.bundle):
        existing = load_existing_recovery_journal(args.bundle, captures)
        if not existing:
            raise OrganizerError("No reconciliation journal exists for this bundle.")
        journal_path, journal = existing
        created_count = rollback_recovery_workspaces(journal_path, journal, captures)
    print(f"Rolled back {created_count} workspace(s) created by this recovery journal. Adopted native workspaces were not touched.")


def parser() -> argparse.ArgumentParser:
    program = argparse.ArgumentParser(description=__doc__)
    program.add_argument("--session", help="Herdr named session. Defaults to HERDR_SESSION.")
    commands = program.add_subparsers(dest="command", required=True)

    commands.add_parser("snapshot", help="Write the live viewer snapshot.").set_defaults(func=snapshot_command)

    for name, help_text in (
        ("prepare-restart-recovery", "Seal a non-destructive, private restart-recovery bundle."),
        ("backup-all", "Alias for prepare-restart-recovery."),
    ):
        prepare = commands.add_parser(name, help=help_text)
        prepare.add_argument(
            "--session", dest="recovery_sessions", action="append",
            help="Named running Herdr session. Repeat to select the exact recovery scope.",
        )
        prepare.add_argument(
            "--allow-volatile-pane", action="append", default=[],
            help="Acknowledge one non-agent process as session|workspace|tab|pane. Repeat as needed.",
        )
        prepare.add_argument("--capture-attempts", type=int, default=RECOVERY_MAX_CAPTURE_ATTEMPTS)
        prepare.add_argument("--preflight-only", action="store_true")
        prepare.set_defaults(func=prepare_restart_recovery_command)

    reconcile = commands.add_parser(
        "reconcile-all", help="Preview or reconcile one sealed restart-recovery bundle after interactive attach."
    )
    reconcile.add_argument("--bundle", required=True)
    reconcile.add_argument("--confirm", help="Must exactly equal the bundle ID to mutate.")
    reconcile.add_argument("--resume-agents", action="store_true", help="Dispatch verified agent resume commands after layout reconciliation.")
    reconcile.add_argument("--copy-ambiguous", action="store_true", help="Deliberately rebuild an ambiguous workspace as an extra copy.")
    reconcile.add_argument("--confirm-extra", help="Required second confirmation: copy:<bundle-id>.")
    reconcile.set_defaults(func=reconcile_all_command)

    rollback = commands.add_parser(
        "rollback-reconcile", help="Preview or close only workspaces created by a reconciliation journal."
    )
    rollback.add_argument("--bundle", required=True)
    rollback.add_argument("--confirm", help="Must exactly equal the bundle ID to close journal-created workspaces.")
    rollback.set_defaults(func=rollback_reconcile_command)

    archive = commands.add_parser("archive", help="Capture and close one workspace.")
    archive.add_argument("--workspace", required=True)
    archive.add_argument("--allow-active", action="store_true", help="Allow working or blocked agent panes.")
    archive.add_argument("--allow-unresumable-agents", action="store_true", help="Allow agent panes without a verified resumable session.")
    archive.add_argument("--execute", action="store_true")
    archive.add_argument("--confirm")
    archive.set_defaults(func=archive_command)

    archive_tabs = commands.add_parser(
        "archive-tabs", help="Append selected live tabs to an existing archive, then close their source tabs."
    )
    archive_tabs.add_argument("--tab", action="append", required=True, help="Selected live tab ID. Repeat for each tab.")
    archive_tabs.add_argument("--into-archive", required=True)
    archive_tabs.add_argument("--allow-active", action="store_true", help="Allow working or blocked agent panes.")
    archive_tabs.add_argument(
        "--allow-unresumable-agents",
        action="store_true",
        help="Archive agent panes without verified resumable sessions.",
    )
    archive_tabs.add_argument("--execute", action="store_true")
    archive_tabs.add_argument("--confirm")
    archive_tabs.set_defaults(func=archive_tabs_command)

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
        if arguments.command not in {
            "list-archives", "delete-archive", "delete-archived-tab", "prepare-restart-recovery", "backup-all",
            "reconcile-all", "rollback-reconcile",
        }:
            arguments.session = resolve_session(arguments.session)
        arguments.func(arguments)
        return 0
    except OrganizerError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
