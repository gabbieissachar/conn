#!/usr/bin/env python3
"""A small, local organizer for Herdr workspaces.

It deliberately captures layouts and resumable agent identities only. Terminal
processes and scrollback are not preserved. Archiving closes the source
workspace; restoring creates a fresh workspace and rebuilds its tab layouts.
"""

from __future__ import annotations

import argparse
import copy
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
BATCH_DIR = STATE_DIR / "batches"
RECOVERY_DIR = STATE_DIR / "restart-recovery"
RECOVERY_BUNDLE_DIR = RECOVERY_DIR / "bundles"
RECOVERY_JOURNAL_DIR = RECOVERY_DIR / "journals"
LIVE_SNAPSHOT_PATH = STATE_DIR / "live-snapshot.json"
AGENT_MANIFEST_PATH = ROOT / "state" / "herdr-agent-sessions.json"
CODEX_HOME = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
CODEX_SESSION_INDEX_PATH = CODEX_HOME / "session_index.jsonl"
CODEX_SESSIONS_DIR = CODEX_HOME / "sessions"
VERIFIER_RESTORE_SOURCES = {
    "verifier_native",
    "verifier_argv",
    "verifier_handle",
    "verifier_pid_record",
}
MAX_LAYOUT_PANES = 24
ACTIVE_AGENT_STATUSES = {"working", "blocked"}
# A resume record is not enough to establish that an agent is quiescent.  Herdr
# Herdr reports idle and done agents as ready for input. Working and blocked
# remain busy; every other status is unresolved until reviewed.
SAFE_RESUMABLE_AGENT_STATUSES = {"idle", "done"}
SHELL_PROCESS_NAMES = {"bash", "fish", "sh", "starship", "zsh"}
CODEX_INTERACTIVE_PROMPT_COUNT = 2
CODEX_INTERACTIVE_PROMPT_MINIMUM_LENGTH = 24
RECOVERY_SCHEMA_VERSION = 2
RECOVERY_MAX_CAPTURE_ATTEMPTS = 3


class OrganizerError(RuntimeError):
    """An expected error that should be shown without a stack trace."""

    def __init__(self, message: str, *, suppress_message: bool = False):
        super().__init__(message)
        self.suppress_message = suppress_message


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
    identity = {
        "herdr_session": session,
        "workspace_id": workspace_id,
        "tab_id": tab_id,
        "pane_id": pane_id,
    }
    reject_recovery_identity_delimiters(identity)
    return identity


def reject_recovery_identity_delimiters(identity: dict[str, Any]) -> None:
    """Keep pipe-delimited acknowledgement identities reversible."""
    for name in ("herdr_session", "workspace_id", "tab_id", "pane_id"):
        value = identity.get(name)
        if isinstance(value, str) and "|" in value:
            raise OrganizerError(
                f"Restart recovery identity component {name!r} cannot contain '|'; "
                "--allow-volatile-pane uses pipe-delimited identities."
            )


def recovery_identity_key(identity: dict[str, Any]) -> str:
    reject_recovery_identity_delimiters(identity)
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


def layout_topology(root: dict[str, Any] | None) -> Any:
    """The shape of a layout tree: nesting and split directions only, with no pane ids, sizes or directories."""
    if not root:
        return None
    node_type = root.get("type")
    if node_type == "pane":
        return "pane"
    if node_type == "split":
        return ["split", str(root.get("direction")), layout_topology(root.get("first")), layout_topology(root.get("second"))]
    raise OrganizerError(f"Unknown layout node type: {node_type!r}")


def leaf_pane_ids(root: dict[str, Any] | None) -> list[str]:
    return [str(pane.get("pane_id")) for pane in leaf_panes(root)]


def workspace_by_id(snapshot: dict[str, Any], workspace_id: str) -> dict[str, Any]:
    for workspace in snapshot.get("workspaces", []):
        if workspace.get("workspace_id") == workspace_id:
            return workspace
    raise OrganizerError(f"Workspace {workspace_id!r} does not exist in this Herdr session.")


# The leader convention: every firstmate and secondmate session lives in one workspace, one tab each, and a label is
# an identity, so it exists at most once. A restore never creates a second `leader-space`, never puts a leader tab
# anywhere else, never recreates a leader tab that is already open, and never resumes an agent session that is already
# running in some pane. These checks read the live snapshot, so they hold however the tabs were closed or restored.
LEADER_WORKSPACE_LABEL = "leader-space"
LEADER_PRIMARY_TAB_LABEL = "big-boss"
LEADER_TAB_PREFIX = "leader-"


def is_leader_tab_label(label: Any) -> bool:
    text = str(label or "")
    return text == LEADER_PRIMARY_TAB_LABEL or (text.startswith(LEADER_TAB_PREFIX) and len(text) > len(LEADER_TAB_PREFIX))


def live_agent_sessions(snapshot: dict[str, Any]) -> dict[str, str]:
    """Agent session id -> the pane it is running in, for every pane the live snapshot shows with an agent session."""
    sessions: dict[str, str] = {}
    for pane in snapshot.get("panes", []):
        session = pane.get("agent_session")
        value = session.get("value") if isinstance(session, dict) else None
        if isinstance(value, str) and value:
            sessions.setdefault(value, str(pane.get("pane_id")))
    return sessions


SELECTED_TABS_SUFFIX = re.compile(r"(\s*\(selected tabs\))+$")


def base_workspace_label(label: Any) -> str | None:
    """A workspace label without the "(selected tabs)" marks an archive of part of that workspace adds."""
    if label is None:
        return None
    return SELECTED_TABS_SUFFIX.sub("", str(label))


def leader_destination_problems(workspace_label: str | None, tabs: list[dict[str, Any]]) -> list[str]:
    """Why these tabs cannot go into a workspace with this label: a leader tab goes only into `leader-space`."""
    leader_labels = [str(tab.get("label")) for tab in tabs if is_leader_tab_label(tab.get("label"))]
    if not leader_labels:
        return []
    if workspace_label != LEADER_WORKSPACE_LABEL:
        return [
            f"tab {label!r} is a leader tab and can only go into {LEADER_WORKSPACE_LABEL!r}, not {workspace_label!r}"
            for label in leader_labels
        ]
    return []


def leader_archive_workspace_label(capture: dict[str, Any]) -> str | None:
    """The workspace label an archive restores under.

    An archive of only some tabs of a workspace is labelled "<workspace> (selected tabs)". Restored as a whole, its
    leader tabs belong in `leader-space` itself, never in a workspace carrying that marked name.
    """
    label = capture.get("workspace", {}).get("label")
    base = base_workspace_label(label)
    tabs = capture.get("tabs", [])
    if base == LEADER_WORKSPACE_LABEL and tabs and all(is_leader_tab_label(tab.get("label")) for tab in tabs):
        return LEADER_WORKSPACE_LABEL
    return None if label is None else str(label)


def leader_restore_problems(
    snapshot: dict[str, Any], workspace_label: str | None, tabs: list[dict[str, Any]], destination_exists: bool
) -> list[str]:
    """Why restoring these tabs into a workspace with this label would break the leader convention (empty when fine)."""
    problems: list[str] = []
    workspaces = snapshot.get("workspaces", [])
    if not destination_exists and workspace_label == LEADER_WORKSPACE_LABEL:
        open_ids = [str(item.get("workspace_id")) for item in workspaces if item.get("label") == LEADER_WORKSPACE_LABEL]
        if open_ids:
            problems.append(
                f"workspace {LEADER_WORKSPACE_LABEL!r} is already open ({', '.join(open_ids)}); restore the missing tabs into it instead of creating another"
            )
    live_tabs: dict[str, list[str]] = {}
    for item in snapshot.get("tabs", []):
        if is_leader_tab_label(item.get("label")):
            live_tabs.setdefault(str(item.get("label")), []).append(str(item.get("tab_id")))
    problems.extend(leader_destination_problems(workspace_label, tabs))
    for tab in tabs:
        label = tab.get("label")
        if not is_leader_tab_label(label):
            continue
        if live_tabs.get(str(label)):
            problems.append(f"tab {label!r} is already open ({', '.join(live_tabs[str(label)])}), so a second one would duplicate it")
    return problems


def require_leader_restore_ok(
    snapshot: dict[str, Any], workspace_label: str | None, tabs: list[dict[str, Any]], destination_exists: bool
) -> None:
    problems = leader_restore_problems(snapshot, workspace_label, tabs, destination_exists)
    if problems:
        raise OrganizerError("Nothing was restored. " + "; ".join(problems) + ".")


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
        native_codex = native_codex_session(pane)
        native = native_codex
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
        if detected:
            restore_source = "process"
        elif native_codex:
            restore_source = "native_codex"
        elif interactive:
            restore_source = "local_rollout"
        elif registered_valid and registered.get("restore_source") in VERIFIER_RESTORE_SOURCES:
            restore_source = registered.get("restore_source")
        elif registered_valid:
            restore_source = "manifest"
        else:
            restore_source = "unavailable"
        restores.append(
            {
                "source_pane_id": pane_id,
                "client": client,
                "session_id": agent_session_id,
                "resume_command": command if resumable else None,
                "restore_status": "resumable" if resumable else "shell_only",
                "restore_source": restore_source,
            }
        )
    return restores


def is_trusted_restore(restore: dict[str, Any]) -> bool:
    return (
        restore.get("restore_status") == "resumable"
        and restore.get("restore_source") in {
            "manifest", "process", "native_codex", "local_rollout", *VERIFIER_RESTORE_SOURCES
        }
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
    kept_reason = None
    close_workspace = False
    if eligible and len(eligible) == len(tabs_for_workspace(snapshot, args.workspace)):
        # Every tab is an empty shell, so the workspace itself is empty and closes with its last tab. Two cases keep
        # one tab so the command cannot pull the ground out from under itself or empty the whole session.
        if current_workspace_id(snapshot, args.session) == args.workspace:
            kept_reason = "running_inside"
        elif len(snapshot.get("workspaces", [])) <= 1:
            kept_reason = "only_workspace"
        else:
            close_workspace = True
        if kept_reason:
            kept_tab_id = eligible[-1]["tab_id"]
            eligible = eligible[:-1]
    preview = {
        "workspace_id": args.workspace,
        "tabs_to_close": eligible,
        "protected_tabs": protected,
        "kept_tab_id": kept_tab_id,
        "kept_reason": kept_reason,
        "close_workspace": close_workspace,
    }
    if not args.execute:
        print(json.dumps(preview, indent=2))
        print(
            f"Preview only. Re-run with --execute --confirm {args.workspace!r} to close {len(eligible)} empty shell tab(s)"
            + (" and the workspace itself, which has nothing else in it." if close_workspace else ".")
        )
        return
    require_execute_confirmation(args.execute, args.confirm, args.workspace, "Clean up empty tabs")
    # The preview is older than this call. Look again right before closing, because a user may have opened a tab or
    # started a process since, and a close cannot be undone.
    fresh = session_snapshot(args.session)
    if not any(item.get("workspace_id") == args.workspace for item in fresh.get("workspaces", [])):
        raise OrganizerError(f"Workspace {args.workspace} no longer exists. Nothing was closed.")
    still_empty, _ = empty_tab_cleanup_candidates(fresh, args.workspace, args.session)
    still_empty_ids = {str(tab["tab_id"]) for tab in still_empty}
    if close_workspace:
        live_ids = {str(tab.get("tab_id")) for tab in tabs_for_workspace(fresh, args.workspace)}
        planned_ids = {str(tab["tab_id"]) for tab in eligible}
        if live_ids != planned_ids or not live_ids <= still_empty_ids:
            raise OrganizerError(
                f"Workspace {args.workspace} changed since the preview: its tabs are no longer all empty shells. "
                "Nothing was closed. Run the preview again."
            )
        run_json(["workspace", "close", args.workspace], args.session)
        print(f"Closed workspace {args.workspace}: every tab was an empty shell, so it closed with its last tab.")
        return
    closing = [tab for tab in eligible if str(tab["tab_id"]) in still_empty_ids]
    for tab in closing:
        run_json(["tab", "close", str(tab["tab_id"])], args.session)
    print(f"Closed {len(closing)} empty shell tab(s) in workspace {args.workspace}.")
    if len(closing) != len(eligible):
        print(f"Left {len(eligible) - len(closing)} tab(s) open because they changed since the preview.")
    if kept_tab_id:
        reason = (
            "this command runs inside the workspace" if kept_reason == "running_inside" else "it is the only workspace in the session"
        )
        print(f"Kept {kept_tab_id} because {reason}.")


def archive_summary(archive: dict[str, Any]) -> dict[str, Any]:
    tabs = archive.get("capture", {}).get("tabs", [])
    restores = [restore for tab in tabs for restore in tab.get("agent_restores", [])]
    workspace = archive.get("capture", {}).get("workspace", {})
    return {
        "archive_id": archive.get("archive_id"),
        "batch_id": archive.get("batch_id"),
        "status": archive.get("status"),
        "created_at": archive.get("created_at"),
        "archived_at": archive.get("archived_at"),
        "restored_at": archive.get("restored_at"),
        "workspace_label": workspace.get("label"),
        "source_workspace_id": workspace.get("source_workspace_id"),
        "restored_workspace_id": archive.get("restore", {}).get("workspace_id"),
        "layout_workspace_id": (archive.get("layout_restore") or {}).get("workspace_id"),
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


CLAUDE_PROJECTS_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))).expanduser() / "projects"
AGENT_LOG_TAIL_BYTES = 4_000_000
AGENT_RECENT_PATHS = 400
ABSOLUTE_PATH_IN_COMMAND = re.compile(r"(?<![\w.])/(?:Users|home|Volumes|opt|private)/[^\s'\"`;|&()<>\\]+")
SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
# Tools that change a file, and shell commands that most likely do. A command that only reads or lists is not a write.
AGENT_WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
GIT_WRITE_SUBCOMMANDS = {"add", "commit", "mv", "rm", "checkout", "switch", "restore", "stash", "apply", "merge", "rebase", "cherry-pick"}
# Commands that change every path they are given, and commands that only change the last path (the destination).
SHELL_WRITE_ALL = {"mv", "rm", "mkdir", "touch", "tee", "patch", "truncate"}
SHELL_WRITE_DESTINATION = {"cp", "install", "ln", "rsync"}
SHELL_WRAPPERS = {"sudo", "env", "command", "time", "nohup", "exec"}
SHELL_INTERPRETERS = {"bash", "sh", "zsh", "dash", "ksh"}
# Package managers change the folder they run in (or the one given with --prefix, -C or --cwd) when they install.
PACKAGE_MANAGERS = {"npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv"}
PACKAGE_WRITE_SUBCOMMANDS = {"install", "i", "ci", "add", "remove", "uninstall", "update", "upgrade", "sync"}
MAX_SHELL_NESTING = 3
SHELL_SEPARATORS = {";", "&&", "||", "|", "&", "|&"}
# Git options that take a value, so the value is not mistaken for the subcommand.
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}


def split_unquoted_newlines(command: str) -> str:
    """Turn each newline outside quotes into a `;`, so shlex sees one command per line."""
    out: list[str] = []
    quote = ""
    escaped = False
    for char in command:
        if escaped:
            escaped = False
        elif char == "\\" and quote != "'":
            escaped = True
        elif quote:
            quote = "" if char == quote else quote
        elif char in "'\"":
            quote = char
        elif char == "\n":
            char = " ; "
        out.append(char)
    return "".join(out)


def shell_command_paths(command: str, directory: str | None = None, depth: int = 0) -> list[tuple[str, bool]]:
    """(absolute path, was it written) for each absolute path in a shell command.

    A path is written when it is a redirect target (other than /dev/null), an argument of a command that changes files
    (a write command's destination for cp, mv, install and the like), or the folder a file-changing command runs in.
    Reading, listing, `2>/dev/null` and `2>&1` do not count, and neither does the source side of a copy. A command
    wrapped in `bash -c '...'` is read again as its own command line, `find ... -delete` and package installs count,
    and code run by an interpreter (`python -c`) is not understood, so it reads as a read.
    """
    try:
        lexer = shlex.shlex(split_unquoted_newlines(command), posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        return [(path, False) for path in ABSOLUTE_PATH_IN_COMMAND.findall(command)]
    found: list[tuple[str, bool]] = []
    segment: list[str] = []

    def paths_in(token: str) -> list[str]:
        return ABSOLUTE_PATH_IN_COMMAND.findall(token)

    def flush() -> None:
        nonlocal directory, segment
        words = list(segment)
        segment = []
        while words and (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0]) or words[0] in SHELL_WRAPPERS):
            words.pop(0)
        if not words:
            return
        name = Path(words[0]).name
        args = words[1:]
        if name in SHELL_INTERPRETERS:
            inner = next((args[i + 1] for i, arg in enumerate(args[:-1]) if re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", arg)), None)
            if inner is not None and depth < MAX_SHELL_NESTING:
                found.extend(shell_command_paths(inner, directory, depth + 1))
                return
        if name in {"cd", "pushd"}:
            target = next((path for arg in args for path in paths_in(arg)), None)
            if target:
                directory = target
            found.extend((path, False) for arg in args for path in paths_in(arg))
            return
        written: set[int] = set()  # indexes into args that are written
        changes_files = False
        if name == "git":
            index, folder = 0, None
            while index < len(args) and args[index].startswith("-"):
                if args[index] == "-C" and index + 1 < len(args):
                    folder = args[index + 1]
                index += 2 if args[index] in GIT_VALUE_OPTIONS else 1
            subcommand = args[index] if index < len(args) else ""
            if subcommand in GIT_WRITE_SUBCOMMANDS:
                changes_files = True
                written.update(i for i, arg in enumerate(args) if paths_in(arg))
                if folder and paths_in(folder):
                    directory = paths_in(folder)[0]
        elif name in SHELL_WRITE_ALL or (name == "sed" and any(re.fullmatch(r"-[A-Za-z]*i\S*|--in-place\S*", arg) for arg in args)):
            changes_files = True
            written.update(i for i, arg in enumerate(args) if paths_in(arg))
        elif name == "find" and (
            "-delete" in args
            or any(arg in {"-exec", "-execdir", "-ok", "-okdir"} and args[i + 1 : i + 2] and Path(args[i + 1]).name in SHELL_WRITE_ALL | SHELL_WRITE_DESTINATION for i, arg in enumerate(args))
        ):
            changes_files = True
            written.update(i for i, arg in enumerate(args) if paths_in(arg))
        elif name in PACKAGE_MANAGERS and any(arg in PACKAGE_WRITE_SUBCOMMANDS for arg in args[:3]):
            changes_files = True
            written.update(i for i, arg in enumerate(args) if paths_in(arg))
        elif name in SHELL_WRITE_DESTINATION:
            changes_files = True
            operands = [i for i, arg in enumerate(args) if not arg.startswith("-")]
            if operands and paths_in(args[operands[-1]]):
                written.add(operands[-1])
        wrote_a_path = False
        for i, arg in enumerate(args):
            for path in paths_in(arg):
                found.append((path, i in written))
                wrote_a_path = wrote_a_path or i in written
        if changes_files and not wrote_a_path and directory:
            found.append((directory, True))  # a relative path, so the folder the command runs in is what changed

    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in SHELL_SEPARATORS or set(token) <= set("();&|") and token:
            flush()
        elif (token.startswith(">") and not token.startswith(">&")) or token in {"&>", "&>>"}:
            target = tokens[index + 1] if index + 1 < len(tokens) else ""
            index += 1
            if target and not target.startswith("/dev/") and not target.startswith("&"):
                target_paths = paths_in(target)
                if target_paths:
                    found.extend((path, True) for path in target_paths)
                elif directory:
                    found.append((directory, True))
        elif token.startswith("<"):
            index += 1  # a redirected input is a read, handled as an ordinary argument below
            if index < len(tokens):
                found.extend((path, False) for path in paths_in(tokens[index]))
        else:
            segment.append(token)
        index += 1
    flush()
    return found


def clean_folder(value: object) -> str | None:
    if isinstance(value, str) and value.startswith("/") and not any(ord(char) < 32 or ord(char) == 127 for char in value):
        return value
    return None


def read_git_marker(root: str) -> str | None:
    """The shared git directory a repository root's `.git` entry points at, read without starting git.

    A normal clone has a `.git` folder, which is the shared directory. A linked worktree has a `.git` file reading
    `gitdir: <worktree git dir>`, and that directory's `commondir` file names the shared directory. Anything unusual
    (an unreadable or malformed marker, a missing target) returns None so the caller asks git instead.
    """
    marker = os.path.join(root, ".git")
    if os.path.isdir(marker):
        return os.path.realpath(marker)
    try:
        with open(marker, encoding="utf-8") as handle:
            first = handle.readline(4096).strip()
    except OSError:
        return None
    if not first.startswith("gitdir:"):
        return None
    git_dir = Path(first[len("gitdir:"):].strip())
    if not git_dir.is_absolute():
        git_dir = Path(root) / git_dir
    if not git_dir.is_dir():
        return None
    try:
        common = (git_dir / "commondir").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return str(git_dir.resolve())
    except OSError:
        return None
    return str((git_dir / common).resolve()) if common else None


def git_root_and_common_dir_from_files(folder: str) -> tuple[str, str] | None | bool:
    """Find a folder's repository by walking up to the nearest `.git` entry.

    Returns the (root, shared git directory) pair, None when no folder above has a `.git` entry (not in a repository),
    or False when an entry exists but cannot be read safely, so the caller should ask git.
    """
    current = os.path.realpath(folder)
    while True:
        if os.path.lexists(os.path.join(current, ".git")):
            common = read_git_marker(current)
            return (current, common) if common else False
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


@lru_cache(maxsize=4096)
def git_root_and_common_dir(path: str) -> tuple[str, str] | None:
    """The repository root a path is in and the shared git directory every worktree of that repository points at.

    Reads the `.git` markers directly, which is what dominated the live snapshot's time when it asked git once per
    touched folder. It asks git only when the markers are not enough: GIT_DIR or GIT_WORK_TREE is set, or a `.git`
    entry has an unusual shape.
    """
    folder = path
    while folder and not os.path.isdir(folder):
        parent = os.path.dirname(folder)
        if parent == folder:
            return None
        folder = parent
    if not os.environ.get("GIT_DIR") and not os.environ.get("GIT_WORK_TREE"):
        found = git_root_and_common_dir_from_files(folder)
        if found is not False:
            return found
    try:
        completed = subprocess.run(
            ["git", "-C", folder, "rev-parse", "--show-toplevel", "--git-common-dir"],
            check=False, text=True, capture_output=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    lines = completed.stdout.splitlines()
    if completed.returncode != 0 or len(lines) != 2:
        return None
    common = Path(lines[1]) if Path(lines[1]).is_absolute() else Path(folder) / lines[1]
    return lines[0], str(common.resolve())


def claude_session_log(session_id: str) -> Path | None:
    if not SAFE_SESSION_ID.match(session_id) or not CLAUDE_PROJECTS_DIR.is_dir():
        return None
    return next(iter(sorted(CLAUDE_PROJECTS_DIR.glob(f"*/{session_id}.jsonl"))), None)


def recent_claude_paths(log: Path) -> list[tuple[str, bool]]:
    """(absolute path, was it written) for the tool calls at the end of a Claude session log, oldest first."""
    try:
        with log.open("rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, size - AGENT_LOG_TAIL_BYTES))
            if size > AGENT_LOG_TAIL_BYTES:
                handle.readline()
            lines = handle.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return []
    found: list[tuple[str, bool]] = []
    for line in lines:
        if '"tool_use"' not in line:
            continue
        try:
            message = json.loads(line).get("message") or {}
        except (ValueError, AttributeError):
            continue
        content = message.get("content") if isinstance(message, dict) else None
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict) or block.get("type") != "tool_use" or not isinstance(block.get("input"), dict):
                continue
            tool_input = block["input"]
            writes = block.get("name") in AGENT_WRITE_TOOLS
            found.extend(
                (value, writes) for key in ("file_path", "path", "notebook_path")
                if isinstance((value := tool_input.get(key)), str) and value.startswith("/")
            )
            if isinstance(tool_input.get("command"), str):
                found.extend(shell_command_paths(tool_input["command"]))
    return found[-AGENT_RECENT_PATHS:]


def inferred_agent_folder(pane: dict[str, Any]) -> str | None:
    """The clone a Claude agent really works in, when that differs from the folder its shell started in.

    Herdr reports the shell's folder. An agent often starts in a project's main checkout and edits in a separate
    worktree of the same project, using absolute paths, so the shell folder says nothing about where the work is. The
    session log lists the files the agent touched. Among the worktrees of the shell folder's own repository (same shared
    git directory), the one the agent wrote to most in its recent tool calls is its working clone: edits, writes and
    shell commands that change files count, and reads or listings do not. Only when the agent wrote to none of them does
    the one it read most decide. Nothing is inferred when the shell is not in a repository, the log is missing, or the
    agent only touched the shell's own checkout.
    """
    shell = clean_folder(pane.get("foreground_cwd") or pane.get("cwd"))
    session = pane.get("agent_session")
    if pane.get("agent") != "claude" or not shell or not isinstance(session, dict) or not isinstance(session.get("value"), str):
        return None
    log = claude_session_log(session["value"])
    shell_repo = git_root_and_common_dir(shell)
    if log is None or shell_repo is None:
        return None
    shell_root, common = shell_repo
    repos: dict[str, tuple[str, str] | None] = {}
    written: dict[str, int] = {}
    read: dict[str, int] = {}
    for path, was_written in recent_claude_paths(log):
        # A touched file belongs to the nearest folder that is a repository root; cache by folder to keep git calls few.
        folder = path if os.path.isdir(path) else os.path.dirname(path)
        if folder not in repos:
            repos[folder] = git_root_and_common_dir(folder)
        repo = repos[folder]
        if repo and repo[1] == common and repo[0] != shell_root:
            bucket = written if was_written else read
            bucket[repo[0]] = bucket.get(repo[0], 0) + 1
    counts = written or read
    if not counts:
        return None
    return clean_folder(max(counts, key=lambda root: counts[root]))


def pane_working_folders(panes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The distinct folders a tab's panes work in, each with the panes that are in it, so the page can offer a cd.

    An agent's inferred working clone (source `agent_files`) comes first. The folder a pane's foreground process runs
    in wins over the folder the pane started in (source `pane`). Only an absolute single-line path is kept; anything
    else cannot be turned into a safe command.
    """
    folders: dict[tuple[str, str], list[str]] = {}
    for pane in panes:
        pane_id = str(pane.get("pane_id"))
        agent_folder = inferred_agent_folder(pane)
        if agent_folder:
            folders.setdefault((agent_folder, "agent_files"), []).append(pane_id)
        folder = clean_folder(pane.get("foreground_cwd") or pane.get("cwd"))
        if folder:
            folders.setdefault((folder, "pane"), []).append(pane_id)
    ordered = sorted(folders.items(), key=lambda item: item[0][1] != "agent_files")
    return [{"path": path, "source": source, "pane_ids": pane_ids} for (path, source), pane_ids in ordered]


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
        restores = [
            restore for restore in agent_restore_records(panes, session, records) if restore.get("client") in {"codex", "claude"}
        ]
        agent_resume = [
            {
                "pane_id": restore.get("source_pane_id"),
                "client": restore.get("client"),
                "status": "resumable" if is_trusted_restore(restore) else "needs_registration",
                "source": restore.get("restore_source"),
            }
            for restore in restores
        ]
        # The verified client session id of each agent pane, so the page can offer a copy button. Only a trusted,
        # well-formed id is kept; the page treats this field as the one place a session id may appear.
        agent_sessions = [
            {"pane_id": str(restore.get("source_pane_id")), "client": restore.get("client"), "session_id": restore.get("session_id")}
            for restore in restores
            if is_trusted_restore(restore)
            and isinstance(restore.get("session_id"), str)
            and re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", restore["session_id"])
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
                "agent_sessions": agent_sessions,
                "working_folders": pane_working_folders(panes),
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
        "batches": [batch_summary(batch) for batch in load_batches()],
    }
    write_json(LIVE_SNAPSHOT_PATH, document)
    print(f"Wrote {LIVE_SNAPSHOT_PATH}")
    print(
        f"{len(document['workspaces'])} workspaces, {len(document['archives'])} archives and "
        f"{len(document['batches'])} batches available to the organizer."
    )


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


def prepare_archive(
    archive_id: str, capture: dict[str, Any], session: str | None, batch_id: str | None = None
) -> tuple[Path, dict[str, Any]]:
    """Write the archive file in the prepared state, before anything is closed."""
    archive = {
        "version": 1,
        "archive_id": archive_id,
        "status": "prepared",
        "created_at": now(),
        "herdr_session": session or os.environ.get("HERDR_SESSION"),
        "capture": capture,
        "restore": {},
    }
    if batch_id:
        archive["batch_id"] = batch_id
    archive_path = ARCHIVE_DIR / f"{archive_id}.json"
    write_json(archive_path, archive)
    return archive_path, archive


def close_archived_workspace(
    archive_path: Path, archive: dict[str, Any], workspace_id: str, session: str | None
) -> None:
    try:
        run_json(["workspace", "close", workspace_id], session)
    except OrganizerError as error:
        archive["status"] = "close_failed"
        archive["error"] = str(error)
        write_json(archive_path, archive)
        raise
    archive["status"] = "archived"
    archive["archived_at"] = now()
    write_json(archive_path, archive)


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
    archive_path, archive = prepare_archive(archive_id, capture, args.session)
    close_archived_workspace(archive_path, archive, args.workspace, args.session)
    print(f"Archived workspace {args.workspace} as {archive_id}.")
    print("The original processes were stopped. Restore will create fresh shells and can resume supported agents.")


# ---- Batches: archive every safe workspace at once, restore a whole group ----
#
# A batch is one `archive-all` run. Its manifest names the archives that run
# created and the workspaces it skipped. The manifest never holds session ids or
# resume commands; those stay in the archive files. A member's status is always
# read from its archive file, so a deleted archive shows as deleted.

BATCH_ID_PATTERN = re.compile(r"^batch-[0-9]{8}-[0-9]{6}(-[0-9]+)?$")
RESTORABLE_MEMBER_STATUS = "archived"
RESTORED_STATUSES = {"restored", "resumed"}


@contextmanager
def batch_run_lock(action: str) -> Iterable[None]:
    """Only one archive-all or restore-batch run at a time, so two runs cannot duplicate work."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    path = STATE_DIR / "batch-run.lock"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise OrganizerError(
                f"Another archive, restore or delete run is already in progress. Wait for it to finish, then run {action} again."
            ) from error
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def with_batch_lock(action: str, function):
    """Make a command that creates, restores or deletes archives take the same lock as archive-all and restore-batch.

    Only the executing form locks; a preview changes nothing. Without this, a single restore could run beside a
    group restore and create a duplicate workspace.
    """

    def locked(args: argparse.Namespace) -> None:
        if getattr(args, "execute", False):
            with batch_run_lock(action):
                function(args)
        else:
            function(args)

    return locked


def batch_id_for() -> str:
    base = f"batch-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    candidate = base
    sequence = 2
    while (BATCH_DIR / f"{candidate}.json").exists():
        candidate = f"{base}-{sequence}"
        sequence += 1
    return candidate


# ---- One archive group per Herdr session ----
#
# A session has one group for its whole life. Archive all and add-tabs-to-batch add to it. A member leaves the group
# when its archive is restored (or deleted), so the group holds only workspaces that are still archived. A workspace
# that is archived again after a restore becomes a new member, and a member whose workspace is archived again while
# its layout copy is still open is replaced, so one workspace never has two entries. Groups made before this rule
# (one per Archive all run) are merged into the session's oldest group the first time a locked command runs.

GROUP_LEAVING_STATUSES = RESTORED_STATUSES | {"deleted"}


def group_session_key(manifest: dict[str, Any]) -> str:
    return str(manifest.get("herdr_session") or "")


def group_batch_ids(manifest: dict[str, Any]) -> set[str]:
    """The batch ids an archive may carry and still belong to this group (its own and the ones merged into it)."""
    return {str(manifest.get("batch_id")), *(str(item) for item in manifest.get("merged_from", []) or [])}


def prune_group_members(manifest: dict[str, Any]) -> list[str]:
    """Drop members that were restored or whose archive is gone. Returns the archive ids dropped."""
    kept: list[dict[str, Any]] = []
    dropped: list[str] = []
    for member in manifest.get("members", []):
        if isinstance(member, dict) and batch_member_view(member)["status"] not in GROUP_LEAVING_STATUSES:
            kept.append(member)
        else:
            dropped.append(str(member.get("archive_id")) if isinstance(member, dict) else "")
    if dropped:
        manifest["members"] = kept
    return dropped


def read_group_manifests() -> list[tuple[Path, dict[str, Any]]]:
    if not BATCH_DIR.exists():
        return []
    found: list[tuple[Path, dict[str, Any]]] = []
    for path in BATCH_DIR.glob("*.json"):
        try:
            manifest = read_json(path, {})
        except OrganizerError:
            continue
        if isinstance(manifest, dict) and isinstance(manifest.get("batch_id"), str) and BATCH_ID_PATTERN.match(manifest["batch_id"]):
            found.append((path, manifest))
    return sorted(found, key=lambda item: (str(item[1].get("created_at", "")), str(item[1]["batch_id"])))


def merge_group_manifests(manifests: list[dict[str, Any]]) -> dict[str, Any]:
    """One group out of several manifests of the same session: the oldest one, holding every member once."""
    ordered = sorted(manifests, key=lambda item: (str(item.get("created_at", "")), str(item.get("batch_id"))))
    merged = copy.deepcopy(ordered[0])
    if len(ordered) == 1:
        return merged
    seen = {str(member.get("archive_id")) for member in merged.get("members", []) if isinstance(member, dict)}
    for other in ordered[1:]:
        for member in other.get("members", []):
            if isinstance(member, dict) and str(member.get("archive_id")) not in seen:
                seen.add(str(member.get("archive_id")))
                merged.setdefault("members", []).append(copy.deepcopy(member))
    newest = ordered[-1]
    merged["skipped"] = copy.deepcopy(newest.get("skipped", []))
    for key in ("status", "completed_at", "updated_at"):
        if key in newest:
            merged[key] = newest[key]
    merged["merged_from"] = sorted({*(merged.get("merged_from") or []), *(str(item["batch_id"]) for item in ordered[1:])})
    return merged


def load_groups() -> list[tuple[Path, dict[str, Any]]]:
    """Every session's group as it would look after the merge and the prune, without writing anything."""
    by_session: dict[str, list[dict[str, Any]]] = {}
    for _, manifest in read_group_manifests():
        by_session.setdefault(group_session_key(manifest), []).append(manifest)
    groups: list[tuple[Path, dict[str, Any]]] = []
    for manifests in by_session.values():
        merged = merge_group_manifests(manifests)
        prune_group_members(merged)
        groups.append((BATCH_DIR / f"{merged['batch_id']}.json", merged))
    return sorted(groups, key=lambda item: str(item[1].get("created_at", "")), reverse=True)


def group_for_session(session: str | None) -> tuple[Path, dict[str, Any]] | None:
    return next((item for item in load_groups() if group_session_key(item[1]) == str(session or "")), None)


def settle_groups() -> None:
    """Write the merge and the prune to disk. Callers hold the run lock.

    The canonical manifest is written first, then the archives it took over are re-pointed, and the manifests it replaced
    are removed last, so an interruption leaves a state that the next call finishes.
    """
    by_session: dict[str, list[tuple[Path, dict[str, Any]]]] = {}
    for path, manifest in read_group_manifests():
        by_session.setdefault(group_session_key(manifest), []).append((path, manifest))
    for items in by_session.values():
        merged = merge_group_manifests([manifest for _, manifest in items])
        prune_group_members(merged)
        canonical_path = BATCH_DIR / f"{merged['batch_id']}.json"
        replaced = [path for path, manifest in items if manifest["batch_id"] != merged["batch_id"]]
        if not replaced and merged == dict(items[0][1]):
            continue
        merged.pop("merged_from", None)
        merged["updated_at"] = now()
        write_json(canonical_path, merged)
        for member in merged.get("members", []):
            archive_id = str(member.get("archive_id") or "")
            if not archive_id or Path(archive_id).name != archive_id:
                continue
            archive_path = ARCHIVE_DIR / f"{archive_id}.json"
            try:
                archive = read_json(archive_path, None)
            except OrganizerError:
                continue
            if isinstance(archive, dict) and archive.get("batch_id") != merged["batch_id"]:
                archive["batch_id"] = merged["batch_id"]
                write_json(archive_path, archive)
        for path in replaced:
            path.unlink(missing_ok=True)


def prune_group_files() -> None:
    """After a restore or a delete, take the members that left out of their group. Callers hold the run lock."""
    for path, manifest in read_group_manifests():
        if prune_group_members(manifest):
            manifest["updated_at"] = now()
            write_json(path, manifest)


def batch_by_id(batch_id: str) -> tuple[Path, dict[str, Any]]:
    if not isinstance(batch_id, str) or not BATCH_ID_PATTERN.match(batch_id):
        raise OrganizerError("Batch ID must look like batch-YYYYMMDD-HHMMSS.")
    groups = load_groups()
    found = next((item for item in groups if item[1].get("batch_id") == batch_id), None)
    if found:
        return found
    merged_into = next((item[1]["batch_id"] for item in groups if batch_id in (item[1].get("merged_from") or [])), None)
    if merged_into:
        raise OrganizerError(
            f"Batch {batch_id!r} is now part of the one archive group for its session: {merged_into!r}. Use that ID."
        )
    raise OrganizerError(f"Batch {batch_id!r} was not found.")


def resolve_group_argument(args: argparse.Namespace) -> str:
    """The group a command names, or the one group of the session when it names none."""
    if getattr(args, "batch", None):
        return args.batch
    session = args.session or os.environ.get("HERDR_SESSION")
    if not session:
        raise OrganizerError("Pass --batch, or --session to use that session's archive group.")
    found = group_for_session(session)
    if found is None:
        raise OrganizerError(
            f"Session {session!r} has no archive group yet. Run archive-all first, then add to or restore from it."
        )
    return str(found[1]["batch_id"])


def with_group_lock(action: str, function):
    """Run a group command under the shared run lock after settling the groups. Only the executing form locks."""

    def locked(args: argparse.Namespace) -> None:
        if getattr(args, "execute", False):
            with batch_run_lock(action):
                settle_groups()
                function(args)
        else:
            function(args)

    return locked


def assess_workspace_for_archive(
    snapshot: dict[str, Any], workspace: dict[str, Any], session: str | None
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Return (capture, entry). The capture is None when the workspace must be skipped.

    The same guards as the single `archive` command apply, and neither allow flag
    is ever passed on the caller's behalf.
    """
    workspace_id = str(workspace["workspace_id"])
    entry: dict[str, Any] = {"workspace_id": workspace_id, "label": str(workspace.get("label") or workspace_id)}
    reasons: list[str] = []
    active = active_agents(snapshot, workspace_id)
    if active:
        reasons.append("active_agent")
        entry["active_pane_ids"] = [str(pane.get("pane_id")) for pane in active]
    try:
        capture = capture_workspace(snapshot, workspace_id, session)
    except OrganizerError as error:
        reasons.append("capture_failed")
        entry["error"] = str(error)
        entry["reasons"] = reasons
        return None, entry
    unavailable = unavailable_agent_restores(capture["tabs"])
    if unavailable:
        reasons.append("unverified_agent_session")
        entry["unverified_panes"] = [
            {"pane_id": str(item.get("source_pane_id")), "client": str(item.get("client"))} for item in unavailable
        ]
    if reasons:
        entry["reasons"] = reasons
        return None, entry
    entry["tab_count"] = len(capture["tabs"])
    entry["pane_count"] = sum(len(leaf_panes(tab["layout"].get("root"))) for tab in capture["tabs"])
    entry["resumable_agent_panes"] = sum(
        is_trusted_restore(item) for tab in capture["tabs"] for item in tab.get("agent_restores", [])
    )
    return capture, entry


def current_workspace_id(snapshot: dict[str, Any], session: str | None) -> str | None:
    """The workspace this process runs in, when it runs inside the target session."""
    env_session = os.environ.get("HERDR_SESSION")
    if env_session and session and env_session != session:
        return None
    pane_id = os.environ.get("HERDR_PANE_ID")
    if pane_id:
        pane = next((item for item in snapshot.get("panes", []) if item.get("pane_id") == pane_id), None)
        if pane:
            tab = next((item for item in snapshot.get("tabs", []) if item.get("tab_id") == pane.get("tab_id")), None)
            if tab and tab.get("workspace_id"):
                return str(tab["workspace_id"])
    workspace_id = os.environ.get("HERDR_WORKSPACE_ID")
    if workspace_id and any(item.get("workspace_id") == workspace_id for item in snapshot.get("workspaces", [])):
        return workspace_id
    return None


SKIP_REASON_TEXT = {
    "active_agent": "has a working or blocked agent",
    "unverified_agent_session": "has an agent without a verified resumable session",
    "capture_failed": "could not be captured",
    "workspace_gone": "no longer exists",
    "workspace_changed": "changed since the preview",
    "group_member_conflict": "matches more than one entry of the archive group",
}


def describe_skip(entry: dict[str, Any]) -> str:
    reasons = ", ".join(SKIP_REASON_TEXT.get(reason, reason) for reason in entry.get("reasons", []))
    detail = f": {entry['error']}" if entry.get("error") else ""
    return f"{entry['workspace_id']} ({entry['label']}) {reasons}{detail}"


def archive_all_command(args: argparse.Namespace) -> None:
    session = args.session or os.environ.get("HERDR_SESSION")
    if not session:
        raise OrganizerError("archive-all needs a named Herdr session. Pass --session <name>.")
    snapshot = session_snapshot(args.session)
    planned: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for workspace in snapshot.get("workspaces", []):
        capture, entry = assess_workspace_for_archive(snapshot, workspace, args.session)
        (planned if capture is not None else skipped).append(entry)
    inside_id = current_workspace_id(snapshot, session)
    inside = next((entry for entry in planned if entry["workspace_id"] == inside_id), None)
    preview = {
        "session": session,
        "workspace_total": len(snapshot.get("workspaces", [])),
        "to_archive": planned,
        "skipped": skipped,
        "running_inside": {"workspace_id": inside["workspace_id"], "label": inside["label"]} if inside else None,
    }
    if not args.execute:
        print(json.dumps(preview, indent=2))
        print(
            f"Preview only. Re-run with --execute --confirm {session!r} to archive {len(planned)} workspace(s) "
            f"and skip {len(skipped)}."
        )
        return

    require_execute_confirmation(args.execute, args.confirm, session, "Archive all")
    if inside:
        raise OrganizerError(
            f"This command is running inside workspace {inside['workspace_id']} ({inside['label']}), which is on the "
            "list to archive. Nothing was closed. Run it from a terminal outside Herdr."
        )
    if not planned:
        print("Nothing to archive: no workspace passed the safety checks.")
        for entry in skipped:
            print(f"Skipped {describe_skip(entry)}")
        return

    with batch_run_lock("archive-all"):
        settle_groups()
        run_archive_batch(args, session, planned, skipped)


def settle_interrupted_archive(
    current: tuple[Path, dict[str, Any]], workspace: dict[str, str] | None, session: str | None
) -> None:
    """Label the archive whose close was interrupted from what Herdr says now, not from a guess.

    An interrupt can land after the workspace closed but before the status was written. If the live list no longer has
    the workspace id, the archive is complete. If it still has it (whatever its label now is), or the list cannot be
    read, the archive says the close was not confirmed.
    """
    archive_path, archive = current
    gone = False
    try:
        live = session_snapshot(session).get("workspaces", [])
        # The id alone decides. A workspace renamed during the interrupted close is still open, so a label comparison
        # would wrongly call it gone and a later group restore would duplicate it.
        gone = bool(workspace) and not any(item.get("workspace_id") == workspace["workspace_id"] for item in live)
    except BaseException:  # the live list is unreadable, so nothing is assumed
        gone = False
    if gone:
        archive["status"] = "archived"
        archive["archived_at"] = now()
        archive["note"] = "The run was interrupted after the workspace closed. Confirmed against the live workspace list."
    else:
        archive["status"] = "close_failed"
        archive["error"] = "Interrupted before the close was confirmed. Check whether the workspace is still open."
    write_json(archive_path, archive)


def run_archive_batch(
    args: argparse.Namespace, session: str, planned: list[dict[str, Any]], skipped: list[dict[str, Any]]
) -> None:
    """Add every planned workspace to the session's one archive group, creating the group the first time."""
    existing = group_for_session(session)
    if existing:
        batch_path, manifest = existing
        batch_id = str(manifest["batch_id"])
    else:
        batch_id = batch_id_for()
        batch_path = BATCH_DIR / f"{batch_id}.json"
        manifest = {"version": 1, "batch_id": batch_id, "created_at": now(), "herdr_session": session, "members": []}
    manifest.update({"status": "in_progress", "updated_at": now(), "skipped": list(skipped)})
    manifest.pop("completed_at", None)
    write_json(batch_path, manifest)
    added = 0
    failures: list[str] = []
    current: tuple[Path, dict[str, Any]] | None = None
    current_workspace: dict[str, str] | None = None
    finished = False
    try:
        for item in planned:
            workspace_id = item["workspace_id"]
            # Re-check each workspace against a fresh snapshot right before it is closed.
            fresh = session_snapshot(args.session)
            workspace = next((w for w in fresh.get("workspaces", []) if w.get("workspace_id") == workspace_id), None)
            if workspace is None:
                capture, entry = None, {"workspace_id": workspace_id, "label": item["label"], "reasons": ["workspace_gone"]}
            elif str(workspace.get("label") or workspace_id) != item["label"]:
                capture, entry = None, {"workspace_id": workspace_id, "label": item["label"], "reasons": ["workspace_changed"]}
            else:
                capture, entry = assess_workspace_for_archive(fresh, workspace, args.session)
            # A workspace whose layout copy is still an archived member of the group replaces that member, so the group
            # never holds the same workspace twice. Only a workspace a restore built counts, never a matching id alone.
            earlier = None
            if capture is not None:
                try:
                    earlier = find_batch_member(manifest, batch_id, workspace_id, match_origin=False)
                except OrganizerError as error:
                    capture, entry = None, {
                        "workspace_id": workspace_id,
                        "label": item["label"],
                        "reasons": ["group_member_conflict"],
                        "error": str(error),
                    }
            if capture is None:
                manifest["skipped"].append(entry)
                write_json(batch_path, manifest)
                print(f"Skipped {describe_skip(entry)}")
                continue
            archive_id = archive_id_for(item["label"])
            current = prepare_archive(archive_id, capture, args.session, batch_id)
            current_workspace = {"workspace_id": workspace_id, "label": item["label"]}
            manifest["members"].append(
                {"archive_id": archive_id, "workspace_id": workspace_id, "workspace_label": item["label"]}
            )
            if earlier:
                manifest["members"] = [m for m in manifest["members"] if m.get("archive_id") != earlier["archive_id"]]
                earlier["archive"]["left_group"] = {"reason": "replaced", "by": archive_id, "at": now()}
                write_json(earlier["path"], earlier["archive"])
            write_json(batch_path, manifest)
            try:
                close_archived_workspace(current[0], current[1], workspace_id, args.session)
            except OrganizerError as error:
                failures.append(f"{workspace_id} ({item['label']}): {error}")
                print(f"Could not close {workspace_id}; archive {archive_id} is marked close_failed.")
                current = None
                continue
            current = None
            added += 1
            print(f"Archived {workspace_id} ({item['label']}) as {archive_id}.")
            if earlier:
                print(f"It replaces {earlier['archive_id']} in the archive group; that archive stays as a single archive.")
        finished = True
    finally:
        # Any other error or Ctrl-C must not leave the record stuck. The workspace being closed at that moment may
        # or may not be gone, so its archive says so and nothing is assumed.
        if current is not None and current[1].get("status") == "prepared":
            settle_interrupted_archive(current, current_workspace, args.session)
        manifest["status"] = ("completed_with_failures" if failures else "completed") if finished else "interrupted"
        manifest["completed_at"] = now()
        manifest["updated_at"] = now()
        write_json(batch_path, manifest)
    print(
        f"Archive group {batch_id}: added {added}, skipped {len(manifest['skipped'])}. "
        f"It now holds {len(manifest['members'])} archived workspace(s)."
    )
    print("The original processes were stopped. Restore the group with restore-batch, or each archive on its own.")
    if failures:
        raise OrganizerError("Some workspaces could not be closed: " + "; ".join(failures))


def batch_member_view(member: dict[str, Any]) -> dict[str, Any]:
    archive_id = str(member.get("archive_id") or "")
    view = {
        "archive_id": archive_id,
        "workspace_id": member.get("workspace_id"),
        "workspace_label": member.get("workspace_label"),
        "status": "deleted",
        "restored_workspace_id": None,
        "layout_workspace_id": None,
        "tabs": [],
    }
    if not archive_id or Path(archive_id).name != archive_id:
        return view
    path = ARCHIVE_DIR / f"{archive_id}.json"
    try:
        archive = read_json(path, None)
    except OrganizerError:
        archive = None
    if isinstance(archive, dict):
        view["status"] = str(archive.get("status") or "unknown")
        restore = archive.get("restore")
        if isinstance(restore, dict):
            view["restored_workspace_id"] = restore.get("workspace_id")
        layout = archive.get("layout_restore")
        if isinstance(layout, dict) and isinstance(layout.get("workspace_id"), str):
            view["layout_workspace_id"] = layout["workspace_id"]
        # What the archived workspace holds, so the group can show its tabs by name.
        capture = archive.get("capture")
        for tab in (capture.get("tabs") if isinstance(capture, dict) else None) or []:
            if isinstance(tab, dict):
                view["tabs"].append(
                    {
                        "id": tab.get("source_tab_id"),
                        "label": tab.get("label") or tab.get("source_tab_id"),
                        "pane_count": len(leaf_panes((tab.get("layout") or {}).get("root"))),
                        "resumable_agent_count": sum(is_trusted_restore(item) for item in tab.get("agent_restores", [])),
                        "unresumable_agent_count": sum(not is_trusted_restore(item) for item in tab.get("agent_restores", [])),
                    }
                )
    return view


def batch_summary(manifest: dict[str, Any]) -> dict[str, Any]:
    members = [batch_member_view(member) for member in manifest.get("members", []) if isinstance(member, dict)]
    # Only fixed fields reach the snapshot. A free-text error stays in the private manifest and the terminal output.
    skipped = [
        {key: item[key] for key in ("workspace_id", "label", "reasons", "active_pane_ids", "unverified_panes") if key in item}
        for item in manifest.get("skipped", [])
        if isinstance(item, dict)
    ]
    counts = {"archived": 0, "restored": 0, "restore_partial": 0, "deleted": 0, "other": 0}
    for member in members:
        status = member["status"]
        if status == RESTORABLE_MEMBER_STATUS:
            counts["archived"] += 1
        elif status in RESTORED_STATUSES:
            counts["restored"] += 1
        elif status in {"restore_partial", "deleted"}:
            counts[status] += 1
        else:
            counts["other"] += 1
    counts["skipped"] = len(skipped)
    return {
        "batch_id": manifest.get("batch_id"),
        "status": manifest.get("status"),
        "created_at": manifest.get("created_at"),
        "updated_at": manifest.get("updated_at"),
        "completed_at": manifest.get("completed_at"),
        "herdr_session": manifest.get("herdr_session"),
        "members": members,
        "skipped": skipped,
        "counts": counts,
        "member_count": len(members),
        "empty": not any(member["status"] != "deleted" for member in members),
    }


def load_batches() -> list[dict[str, Any]]:
    """The archive groups, one per session, holding only members that are still archived."""
    return [manifest for _, manifest in load_groups()]


def list_batches_command(_: argparse.Namespace) -> None:
    print(json.dumps([batch_summary(batch) for batch in load_batches()], indent=2))


def restore_batch_command(args: argparse.Namespace) -> None:
    args.batch = resolve_group_argument(args)
    _, manifest = batch_by_id(args.batch)
    summary = batch_summary(manifest)
    captured_session = manifest.get("herdr_session")
    session = args.session or os.environ.get("HERDR_SESSION")
    if captured_session and session and captured_session != session:
        raise OrganizerError(
            f"Batch {args.batch!r} was captured from session {captured_session!r}, not {session!r}. "
            f"Re-run with --session {captured_session}."
        )
    targets = [member for member in summary["members"] if member["status"] == RESTORABLE_MEMBER_STATUS]
    left_alone = [member for member in summary["members"] if member["status"] != RESTORABLE_MEMBER_STATUS]
    preview = {
        "batch_id": args.batch,
        "to_restore": [
            {"archive_id": m["archive_id"], "workspace_label": m["workspace_label"], "layout_workspace_id": m["layout_workspace_id"]}
            for m in targets
        ],
        "not_restored": [
            {"archive_id": m["archive_id"], "workspace_label": m["workspace_label"], "status": m["status"]}
            for m in left_alone
        ],
        "resume_agents": bool(args.resume_agents),
    }
    if not args.execute:
        print(json.dumps(preview, indent=2))
        print(f"Preview only. Re-run with --execute --confirm {args.batch!r} to restore {len(targets)} workspace(s).")
        return

    require_execute_confirmation(args.execute, args.confirm, args.batch, "Restore batch")
    for member in left_alone:
        print(f"Left {member['archive_id']} alone: {member['status']}.")
    if not targets:
        print("Nothing to restore: no member of this batch is still archived.")
        return
    failures: list[str] = []
    outcomes: dict[str, int] = {}
    # The run lock is already held by with_group_lock.
    for member in targets:
        archive_id = member["archive_id"]
        # Another run may have restored this member since the preview above.
        if batch_member_view(member)["status"] != RESTORABLE_MEMBER_STATUS:
            print(f"Left {archive_id} alone: no longer archived.")
            continue
        print(f"== {archive_id}")
        member_args = argparse.Namespace(
            archive=archive_id,
            resume_agents=bool(args.resume_agents),
            allow_unresumable_agents=False,
            force=False,
            execute=True,
            confirm=archive_id,
            session=args.session,
        )
        try:
            outcome = restore_command(member_args) or "created"
        except OrganizerError as error:
            failures.append(f"{archive_id}: {error}")
            print(f"Could not restore {archive_id}: {error}")
            continue
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
    if args.resume_agents:
        done = outcomes.get("created", 0) + outcomes.get("adopted", 0)
        print(
            f"Batch {args.batch}: restored {done} of {len(targets)} "
            f"({outcomes.get('adopted', 0)} in an open layout copy, {outcomes.get('created', 0)} in a new workspace)."
        )
    else:
        print(
            f"Batch {args.batch}: laid out {outcomes.get('laid_out', 0)} of {len(targets)}, "
            f"{outcomes.get('already_laid_out', 0)} already had their layout open. Nothing is marked restored; "
            "run restore-batch --resume-agents to resume the agents in these workspaces."
        )
    if failures:
        raise OrganizerError("Some archives were not restored: " + "; ".join(failures))


def batch_archive_paths(manifest: dict[str, Any], batch_id: str) -> tuple[list[tuple[str, Path]], list[str]]:
    """The member archive files that exist and really belong to this batch, and the ids left alone.

    An archive is only listed when its own `batch_id` matches, so a hand-edited manifest cannot point a delete at
    some other archive.
    """
    owned: list[tuple[str, Path]] = []
    left_alone: list[str] = []
    for member in manifest.get("members", []):
        archive_id = str(member.get("archive_id") or "") if isinstance(member, dict) else ""
        if not archive_id or Path(archive_id).name != archive_id:
            continue
        path = ARCHIVE_DIR / f"{archive_id}.json"
        if not path.exists():
            continue
        try:
            archive = read_json(path, {})
        except OrganizerError:
            archive = {}
        if isinstance(archive, dict) and archive.get("batch_id") in group_batch_ids(manifest) | {batch_id}:
            owned.append((archive_id, path))
        else:
            left_alone.append(archive_id)
    return owned, left_alone


def delete_batch_command(args: argparse.Namespace) -> None:
    batch_path, manifest = batch_by_id(args.batch)
    with_archives = bool(getattr(args, "archives", False))
    owned, left_alone = batch_archive_paths(manifest, args.batch) if with_archives else ([], [])
    if not args.execute:
        summary = batch_summary(manifest)
        if with_archives:
            summary["archives_to_delete"] = [archive_id for archive_id, _ in owned]
            summary["archives_left_alone"] = left_alone
        print(json.dumps(summary, indent=2))
        if with_archives:
            still_archived = summary["counts"]["archived"]
            print(
                f"Preview only. Re-run with --execute --confirm {'delete-archives:' + args.batch!r} to permanently delete "
                f"this group record and {len(owned)} archive(s)."
                + (f" {still_archived} of them are still archived, so their saved layouts and agent identities would be lost." if still_archived else "")
                + " No live or restored workspace is changed."
            )
        else:
            print(
                f"Preview only. Re-run with --execute --confirm {args.batch!r} to delete this group record. "
                "The archives stay as single archives."
            )
        return
    require_execute_confirmation(
        args.execute, args.confirm, f"delete-archives:{args.batch}" if with_archives else args.batch,
        "Delete batch and its archives" if with_archives else "Delete batch",
    )
    if not with_archives:
        batch_path.unlink()
        print(f"Deleted batch {args.batch}. No archive, restored workspace or live workspace was changed.")
        return
    failures: list[str] = []
    # The run lock is already held by with_group_lock.
    for archive_id, path in owned:
        try:
            path.unlink()
        except OSError as error:
            failures.append(f"{archive_id}: {error}")
            continue
        print(f"Deleted archive {archive_id}.")
    for archive_id in left_alone:
        print(f"Left {archive_id} alone: it does not belong to this batch.")
    # The group record goes last, and only when every archive is gone, so a failure leaves a record to retry from.
    if failures:
        raise OrganizerError("Some archives could not be deleted, so the group record was kept: " + "; ".join(failures))
    batch_path.unlink()
    print(f"Deleted batch {args.batch} and {len(owned)} archive(s). No active or restored workspace was changed.")


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


# ---- Add selected live tabs to a finished batch ----
#
# Selected tabs join the batch as archives, one per source workspace. A tab whose live workspace is already tied to a
# member (by its restored workspace, its open layout workspace or its original workspace id, never by label) is merged
# into that member instead. A member that had been restored goes back to archived, because it now holds more than
# the restore covered. Its old restore record is kept as history so nothing adopts it later.

BATCH_FINISHED_STATUSES = {"completed", "completed_with_failures"}
MEMBER_MERGEABLE_STATUSES = {"archived", "restored", "resumed", "restore_partial"}


def current_tab_id(snapshot: dict[str, Any], session: str | None) -> str | None:
    """The tab this process runs in, when it runs inside the target session."""
    env_session = os.environ.get("HERDR_SESSION")
    if env_session and session and env_session != session:
        return None
    pane_id = os.environ.get("HERDR_PANE_ID")
    pane = next((item for item in snapshot.get("panes", []) if item.get("pane_id") == pane_id), None) if pane_id else None
    return str(pane["tab_id"]) if pane and pane.get("tab_id") else None


def origin_workspace_still_open(archive: dict[str, Any]) -> bool:
    """Whether the workspace an archive was captured from can still be open under its recorded id.

    Herdr hands a closed workspace's id, and its tab ids, out again to an unrelated workspace. Only a selected-tabs
    archive that never closed its workspace left that workspace standing, so only it can be matched on its origin id.
    """
    if not archive.get("from_tabs"):
        return False
    return not any(
        isinstance(item, dict) and item.get("closes_workspace") and item.get("status") == "completed"
        for item in archive.get("tab_archives", [])
    )


def find_batch_member(
    manifest: dict[str, Any], batch_id: str, workspace_id: str, match_origin: bool = True
) -> dict[str, Any] | None:
    """The batch member tied to this live workspace, matched on exact recorded workspace ids only.

    With match_origin off only a workspace a restore or a layout-only restore built counts, not one that merely has the
    id the member's workspace had when it was captured.
    """
    by_restore: list[dict[str, Any]] = []
    by_origin: list[dict[str, Any]] = []
    for member in manifest.get("members", []):
        archive_id = str(member.get("archive_id") or "") if isinstance(member, dict) else ""
        if not archive_id or Path(archive_id).name != archive_id:
            continue
        path = ARCHIVE_DIR / f"{archive_id}.json"
        try:
            archive = read_json(path, None)
        except OrganizerError:
            continue
        if not isinstance(archive, dict) or archive.get("batch_id") not in group_batch_ids(manifest) | {batch_id}:
            continue
        if archive.get("status") not in MEMBER_MERGEABLE_STATUSES:
            continue
        linked = {
            (archive.get(key) or {}).get("workspace_id") for key in ("restore", "layout_restore")
        }
        origin = archive.get("capture", {}).get("workspace", {}).get("source_workspace_id") or member.get("workspace_id")
        found = {"archive_id": archive_id, "path": path, "archive": archive}
        if workspace_id in linked:
            by_restore.append(found)
        elif match_origin and workspace_id == origin and origin_workspace_still_open(archive):
            by_origin.append(found)
    candidates = by_restore or by_origin
    if len(candidates) > 1:
        raise OrganizerError(
            f"Workspace {workspace_id} matches more than one member of batch {batch_id!r}: "
            + ", ".join(item["archive_id"] for item in candidates)
            + ". Nothing was changed."
        )
    return candidates[0] if candidates else None


def restored_tab_sources(archive: dict[str, Any]) -> dict[str, str]:
    """Live tab id -> the captured tab it was rebuilt from, from the restore and layout-restore records."""
    sources: dict[str, str] = {}
    for key in ("restore", "layout_restore"):
        record = archive.get(key)
        for item in record.get("tabs", []) if isinstance(record, dict) else []:
            if isinstance(item, dict) and item.get("tab_id") and item.get("source_tab_id"):
                sources[str(item["tab_id"])] = str(item["source_tab_id"])
    return sources


def plan_batch_tab_additions(
    snapshot: dict[str, Any], captured: list[dict[str, Any]], session: str | None
) -> list[dict[str, Any]]:
    """Split the selection by source workspace and decide what each workspace gives up.

    Selecting every tab of a workspace archives the workspace whole and closes it. Two cases keep one tab live so the
    command cannot close its own terminal or empty the session: it runs inside the workspace, or it is the only one.
    """
    inside_workspace = current_workspace_id(snapshot, session)
    inside_tab = current_tab_id(snapshot, session)
    plans: list[dict[str, Any]] = []
    for workspace_id in dict.fromkeys(str(tab.get("source_workspace_id")) for tab in captured):
        group = [tab for tab in captured if str(tab.get("source_workspace_id")) == workspace_id]
        group_ids = [str(tab["source_tab_id"]) for tab in group]
        live_tabs = tabs_for_workspace(snapshot, workspace_id)
        workspace = workspace_by_id(snapshot, workspace_id)
        kept_tab_id = None
        kept_reason = None
        close_workspace = False
        if len(group) >= len(live_tabs):
            if inside_workspace == workspace_id:
                kept_reason = "running_inside"
                kept_tab_id = inside_tab if inside_tab in group_ids else group_ids[-1]
            elif len(snapshot.get("workspaces", [])) <= 1:
                kept_reason = "only_workspace"
                kept_tab_id = group_ids[-1]
            else:
                close_workspace = True
        elif inside_tab in group_ids:
            raise OrganizerError(
                f"This command is running inside selected tab {inside_tab}. Nothing was closed. "
                "Run it from a terminal outside Herdr, or leave that tab out of the selection."
            )
        tabs = [tab for tab in group if str(tab["source_tab_id"]) != kept_tab_id]
        plans.append(
            {
                "workspace_id": workspace_id,
                "label": str(workspace.get("label") or workspace_id),
                "cwd": workspace.get("cwd"),
                "tabs": tabs,
                "kept_tab_id": kept_tab_id,
                "kept_reason": kept_reason,
                "close_workspace": close_workspace,
            }
        )
    return [plan for plan in plans if plan["tabs"]]


def tabs_changed_since_capture(
    session: str | None, captured_tabs: list[dict[str, Any]], whole_workspace_id: str | None
) -> list[str]:
    """Re-read the live session and name every way the tabs differ from what was captured.

    The tabs are checked right before they are closed, because the capture was made earlier and a user or Herdr may have
    added a pane, started an agent or opened another tab since. An empty result means closing them loses nothing the
    archive does not hold. A tab that is already gone is fine: its captured copy is the only copy.
    """
    fresh = session_snapshot(session)
    live = {str(tab.get("tab_id")) for tab in fresh.get("tabs", [])}
    problems: list[str] = []
    for tab in captured_tabs:
        tab_id = str(tab["source_tab_id"])
        if tab_id not in live:
            continue
        if any(
            pane.get("tab_id") == tab_id and pane.get("agent_status") in ACTIVE_AGENT_STATUSES
            for pane in fresh.get("panes", [])
        ):
            problems.append(f"{tab_id} now has a working or blocked agent")
            continue
        try:
            exported = socket_call(session, "layout.export", {"tab_id": tab_id}).get("layout")
            live_root = exported.get("root") if isinstance(exported, dict) else None
            captured_root = tab.get("layout", {}).get("root")
            if layout_topology(live_root) != layout_topology(captured_root) or leaf_pane_ids(live_root) != leaf_pane_ids(captured_root):
                problems.append(f"{tab_id} has a different layout")
        except OrganizerError:
            problems.append(f"{tab_id} could not be read again")
    if whole_workspace_id:
        planned = {str(tab["source_tab_id"]) for tab in captured_tabs}
        now_in_workspace = {str(tab.get("tab_id")) for tab in tabs_for_workspace(fresh, whole_workspace_id)} if any(
            item.get("workspace_id") == whole_workspace_id for item in fresh.get("workspaces", [])
        ) else set()
        extra = sorted(now_in_workspace - planned)
        if extra:
            problems.append(f"workspace {whole_workspace_id} now has other tab(s): {', '.join(extra)}")
    return problems


def settle_tab_addition(
    archive_path: Path, archive: dict[str, Any], operation: dict[str, Any], tab_ids: list[str], session: str | None
) -> None:
    """Label the archive from what Herdr lists now, after a close failed or was interrupted. Nothing is assumed."""
    remaining: list[str] | None
    try:
        live = {str(tab.get("tab_id")) for tab in session_snapshot(session).get("tabs", [])}
        remaining = [tab_id for tab_id in tab_ids if tab_id in live]
    except BaseException:  # the live list is unreadable
        remaining = None
    if remaining == []:
        archive["status"] = "archived"
        archive["archived_at"] = now()
        archive.pop("error", None)
        operation["status"] = "completed"
        operation["completed_at"] = now()
        operation.pop("still_open", None)
    else:
        archive["status"] = "close_failed"
        archive["error"] = (
            "Some captured tabs were not confirmed closed"
            + (f": {', '.join(remaining)}" if remaining else "")
            + f". Run finish-tab-add --archive {archive.get('archive_id')} to check and finish."
        )
        operation["status"] = "close_partial"
        operation["failed_at"] = now()
        operation["still_open"] = remaining
    write_json(archive_path, archive)


def close_captured_tabs(
    archive_path: Path,
    archive: dict[str, Any],
    operation: dict[str, Any],
    tab_ids: list[str],
    workspace_id: str | None,
    session: str | None,
) -> None:
    """Close the live tabs an archive holds, record each outcome, and settle the archive from the live list on failure."""
    outcomes = operation.setdefault("close_outcomes", [])
    try:
        if workspace_id:
            run_json(["workspace", "close", workspace_id], session)
            outcomes.extend({"source_tab_id": tab_id, "status": "closed"} for tab_id in tab_ids)
        else:
            for tab_id in tab_ids:
                run_json(["tab", "close", tab_id], session)
                outcomes.append({"source_tab_id": tab_id, "status": "closed"})
                write_json(archive_path, archive)
    except BaseException:
        settle_tab_addition(archive_path, archive, operation, list(operation.get("source_tabs", tab_ids)), session)
        raise
    archive["status"] = "archived"
    archive["archived_at"] = now()
    archive.pop("error", None)
    operation["status"] = "completed"
    operation["completed_at"] = now()
    operation.pop("still_open", None)
    write_json(archive_path, archive)


def apply_tab_addition(
    batch_path: Path,
    manifest: dict[str, Any],
    batch_id: str,
    plan: dict[str, Any],
    member: dict[str, Any] | None,
    session: str,
) -> str:
    tabs = plan["tabs"]
    tab_ids = [str(tab["source_tab_id"]) for tab in tabs]
    operation: dict[str, Any] = {
        "operation_id": f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-add-tabs-to-{batch_id}",
        "source_tabs": tab_ids,
        "workspace_id": plan["workspace_id"],
        "started_at": now(),
        "status": "prepared",
        "closes_workspace": bool(plan["close_workspace"]),
        "close_outcomes": [],
    }
    before = copy.deepcopy(member["archive"]) if member else None
    manifest_before = copy.deepcopy(manifest)
    if member:
        archive_path, archive = member["path"], member["archive"]
        previous = {key: archive.pop(key) for key in ("restore", "layout_restore", "restored_at") if archive.get(key)}
        if previous:
            previous["status_before"] = archive.get("status")
            previous["replaced_at"] = now()
            archive.setdefault("restore_history", []).append(previous)
        archive["restore"] = {}
        captured_tabs = archive.setdefault("capture", {}).setdefault("tabs", [])
        for tab in tabs:
            # A tab rebuilt by an earlier restore is a newer copy of a captured tab, so it replaces that tab in place.
            replaced = plan["replaces"].get(str(tab["source_tab_id"]))
            position = next(
                (index for index, old in enumerate(captured_tabs) if str(old.get("source_tab_id")) == replaced), None
            )
            if position is None:
                captured_tabs.append(tab)
            else:
                captured_tabs[position] = tab
        archive_id = member["archive_id"]
        outcome = "merged"
    else:
        label = f"{plan['label']} (selected tabs)"
        archive_id = archive_id_for(label)
        capture = {
            "workspace": {
                "source_workspace_id": plan["workspace_id"],
                "label": label,
                "focused": False,
                "cwd": plan["cwd"],
            },
            "tabs": tabs,
        }
        archive_path, archive = prepare_archive(archive_id, capture, session, batch_id)
        archive["from_tabs"] = True
        manifest.setdefault("members", []).append(
            {"archive_id": archive_id, "workspace_id": plan["workspace_id"], "workspace_label": label}
        )
        outcome = "new"
    # While the live tabs are being closed the archive is prepared, so a group restore leaves it alone.
    archive["status"] = "prepared"
    archive.setdefault("tab_archives", []).append(operation)
    archive["updated_at"] = now()
    write_json(archive_path, archive)
    manifest["updated_at"] = now()
    write_json(batch_path, manifest)
    # Look again right before anything closes. If the tabs changed since the capture, undo the whole addition: nothing
    # has been closed yet, so the live tabs and the earlier archive state are exactly as they were.
    def undo_addition() -> None:
        if before is not None:
            write_json(archive_path, before)
        else:
            archive_path.unlink(missing_ok=True)
        manifest.clear()
        manifest.update(manifest_before)
        write_json(batch_path, manifest)

    try:
        problems = tabs_changed_since_capture(session, tabs, plan["workspace_id"] if plan["close_workspace"] else None)
        live = {str(tab.get("tab_id")) for tab in session_snapshot(session).get("tabs", [])}
    except BaseException:
        # An interrupt or a failed read before anything closed: the archive is still "prepared" and nothing has been
        # closed, so put everything back rather than leave a prepared archive that no command would pick up.
        undo_addition()
        raise
    if problems:
        undo_addition()
        raise OrganizerError(
            f"Workspace {plan['workspace_id']} changed after it was captured: {'; '.join(problems)}. "
            "Nothing was closed and nothing was added. Run the command again."
        )
    try:
        close_captured_tabs(
            archive_path,
            archive,
            operation,
            [tab_id for tab_id in tab_ids if tab_id in live],
            plan["workspace_id"] if plan["close_workspace"] else None,
            session,
        )
    except OrganizerError as error:
        raise OrganizerError(
            f"{error} Archive {archive_id} is close_failed. Run finish-tab-add --archive {archive_id} to check and finish."
        ) from error
    return outcome


def finish_tab_add_command(args: argparse.Namespace) -> None:
    """Finish closing the tabs of an add-tabs-to-batch run that stopped part-way, after checking them again."""
    archive_path, archive = archive_by_id(args.archive)
    operation = next(
        (
            item
            for item in reversed(archive.get("tab_archives", []))
            if isinstance(item, dict) and item.get("status") in {"close_partial", "prepared"}
        ),
        None,
    )
    if archive.get("status") != "close_failed" or operation is None:
        raise OrganizerError(f"Archive {args.archive!r} has no unfinished tab add to finish.")
    captured_session = archive.get("herdr_session")
    session = args.session or os.environ.get("HERDR_SESSION")
    if captured_session and session != captured_session:
        raise OrganizerError(
            f"Archive {args.archive!r} was captured from session {captured_session!r}, not {session!r}. "
            f"Re-run with --session {captured_session}."
        )
    source_tabs = [str(tab_id) for tab_id in operation.get("source_tabs", [])]
    live = {str(tab.get("tab_id")) for tab in session_snapshot(args.session).get("tabs", [])}
    still_open = [tab_id for tab_id in source_tabs if tab_id in live]
    held = {str(tab.get("source_tab_id")): tab for tab in archive.get("capture", {}).get("tabs", [])}
    missing = [tab_id for tab_id in still_open if tab_id not in held]
    if missing:
        raise OrganizerError(f"Archive {args.archive!r} does not hold tab(s) still open: {', '.join(missing)}.")
    workspace_id = str(operation.get("workspace_id")) if operation.get("closes_workspace") else None
    problems = tabs_changed_since_capture(args.session, [held[tab_id] for tab_id in still_open], workspace_id) if still_open else []
    preview = {
        "archive_id": args.archive,
        "tabs_already_closed": [tab_id for tab_id in source_tabs if tab_id not in live],
        "tabs_still_open": still_open,
        "closes_workspace": bool(workspace_id and still_open),
        "problems": problems,
    }
    if not args.execute:
        print(json.dumps(preview, indent=2))
        print(
            "Preview only. Execution closes the tabs listed as still open and marks the archive archived. "
            f"Re-run with --execute --confirm {args.archive!r}."
        )
        return
    require_execute_confirmation(args.execute, args.confirm, args.archive, "Finish tab add")
    if problems:
        raise OrganizerError(
            f"The still-open tab(s) changed after they were captured: {'; '.join(problems)}. Nothing was closed. "
            "Check them, then archive them again with add-tabs-to-batch."
        )
    close_captured_tabs(archive_path, archive, operation, still_open, workspace_id if still_open else None, args.session)
    print(f"Archive {args.archive} is archived. Closed {len(still_open)} tab(s); {len(preview['tabs_already_closed'])} were already closed.")


def add_tabs_to_batch_command(args: argparse.Namespace) -> None:
    session = args.session or os.environ.get("HERDR_SESSION")
    creating = False
    if getattr(args, "batch", None):
        batch_path, manifest = batch_by_id(args.batch)
    else:
        if not session:
            raise OrganizerError("Pass --batch, or --session to use that session's archive group.")
        found = group_for_session(session)
        if found:
            batch_path, manifest = found
            args.batch = str(manifest["batch_id"])
        else:
            # The session has no archive group yet, so adding tabs starts it. Nothing is written before the run executes.
            creating = True
            args.batch = batch_id_for()
            batch_path = BATCH_DIR / f"{args.batch}.json"
            manifest = {
                "version": 1, "batch_id": args.batch, "status": "completed", "created_at": now(),
                "herdr_session": session, "members": [], "skipped": [],
            }
    if manifest.get("status") not in BATCH_FINISHED_STATUSES:
        raise OrganizerError(
            f"Batch {args.batch!r} is {manifest.get('status')!r}. Tabs can only be added to a finished batch."
        )
    captured_session = manifest.get("herdr_session")
    if captured_session and session != captured_session:
        raise OrganizerError(
            f"Batch {args.batch!r} was captured from session {captured_session!r}, not {session!r}. "
            f"Re-run with --session {captured_session}."
        )
    snapshot = session_snapshot(args.session)
    captured = capture_selected_tabs(snapshot, args.tab, args.session)
    selected_ids = {str(tab["source_tab_id"]) for tab in captured}
    active = [
        pane
        for pane in snapshot.get("panes", [])
        if pane.get("tab_id") in selected_ids and pane.get("agent_status") in ACTIVE_AGENT_STATUSES
    ]
    if active:
        raise OrganizerError(
            f"The selected tabs contain {len(active)} working or blocked agent pane(s). Resolve them first. Nothing was changed."
        )
    unavailable = unavailable_agent_restores(captured)
    if unavailable:
        pane_ids = ", ".join(str(item.get("source_pane_id")) for item in unavailable)
        raise OrganizerError(
            f"The selected tabs have {len(unavailable)} agent pane(s) without a verified resumable session: {pane_ids}. "
            "Resume or register the sessions first. Nothing was changed."
        )
    plans = plan_batch_tab_additions(snapshot, captured, args.session)
    if not plans:
        raise OrganizerError("Nothing to add: the only selected tab(s) have to stay open. Nothing was changed.")
    members = {plan["workspace_id"]: find_batch_member(manifest, args.batch, plan["workspace_id"]) for plan in plans}
    for plan in plans:
        member = members[plan["workspace_id"]]
        sources = restored_tab_sources(member["archive"]) if member else {}
        captured_ids = {str(tab.get("source_tab_id")) for tab in member["archive"].get("capture", {}).get("tabs", [])} if member else set()
        plan["replaces"] = {
            str(tab["source_tab_id"]): sources[str(tab["source_tab_id"])]
            for tab in plan["tabs"]
            if sources.get(str(tab["source_tab_id"])) in captured_ids
        }
    already = sorted(
        {
            str(tab.get("source_tab_id"))
            for member in members.values()
            if member
            for tab in member["archive"].get("capture", {}).get("tabs", [])
        }
        & selected_ids
    )
    if already:
        raise OrganizerError(f"The matching archive already contains tab(s): {', '.join(already)}. Nothing was changed.")
    warnings: list[str] = []
    for plan in plans:
        member = members[plan["workspace_id"]]
        archive = member["archive"] if member else {}
        reopened = archive.get("status") in {"restored", "resumed", "restore_partial"} or archive.get("layout_restore")
        replaced = set(plan["replaces"].values())
        leftover = [
            tab for tab in archive.get("capture", {}).get("tabs", []) if str(tab.get("source_tab_id")) not in replaced
        ]
        # Nothing is duplicated when every captured tab is replaced by its rebuilt copy.
        if reopened and leftover:
            warnings.append(
                f"{member['archive_id']} was restored or laid out. Merging resets it to archived. A selected tab that the "
                "earlier restore rebuilt replaces its captured original, and the other tabs are added. Captured tabs you "
                "did not select stay in the archive, so the next restore rebuilds them even if they are still open in the "
                "earlier workspace, and agents already resumed there resume again."
            )
    # A new group is confirmed with the session name, because its id is only chosen when the run executes.
    confirmation = session if creating else args.batch
    preview = {
        "batch_id": None if creating else args.batch,
        "creates_group": creating,
        "session": captured_session,
        "additions": [
            {
                "workspace_id": plan["workspace_id"],
                "workspace_label": plan["label"],
                "tabs": [
                    {
                        "tab_id": tab["source_tab_id"],
                        "label": tab["label"],
                        "pane_count": len(leaf_panes(tab["layout"].get("root"))),
                        "replaces_captured_tab": plan["replaces"].get(str(tab["source_tab_id"])),
                    }
                    for tab in plan["tabs"]
                ],
                "member_archive_id": members[plan["workspace_id"]]["archive_id"] if members[plan["workspace_id"]] else None,
                "action": "merge" if members[plan["workspace_id"]] else "new_member",
                "close_workspace": plan["close_workspace"],
                "kept_tab_id": plan["kept_tab_id"],
                "kept_reason": plan["kept_reason"],
            }
            for plan in plans
        ],
        "warnings": warnings,
        "processes_preserved": False,
    }
    if not args.execute:
        print(json.dumps(preview, indent=2))
        print(
            "Preview only. Execution captures these tab(s) into "
            + (f"a new archive group for session {session!r}" if creating else f"batch {args.batch}")
            + f", then closes them and stops their processes. Re-run with --execute --confirm {confirmation!r}."
        )
        for warning in warnings:
            print(f"Warning: {warning}")
        return
    require_execute_confirmation(args.execute, args.confirm, confirmation, "Add tabs to batch")
    if creating and group_for_session(session) is not None:
        raise OrganizerError(f"Session {session!r} got an archive group since the preview. Nothing was changed. Run the command again.")
    try:
        for plan in plans:
            outcome = apply_tab_addition(batch_path, manifest, args.batch, plan, members[plan["workspace_id"]], session)
            where = "merged into its earlier member" if outcome == "merged" else "as a new member"
            print(f"Added {len(plan['tabs'])} tab(s) from {plan['workspace_id']} ({plan['label']}) {where}.")
            if plan["kept_tab_id"]:
                reason = (
                    "this command runs inside the workspace" if plan["kept_reason"] == "running_inside" else "it is the only workspace"
                )
                print(f"Kept {plan['kept_tab_id']} open because {reason}.")
    except BaseException:
        # A run that stopped before adding anything must not leave an empty group it created behind.
        if creating and batch_path.exists() and not read_json(batch_path, {}).get("members"):
            batch_path.unlink(missing_ok=True)
        raise
    if creating:
        print(f"Created the archive group {args.batch} for session {session}.")
    print("The original processes were stopped. Restore the batch with restore-batch, or each archive on its own.")
    for warning in warnings:
        print(f"Warning: {warning}")


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
    prune_group_files()
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
    archive: dict[str, Any],
    pane_map: dict[str, str],
    session: str | None,
    live_sessions: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    return resume_captured_tabs(archive.get("capture", {}).get("tabs", []), pane_map, session, live_sessions)


def resume_captured_tabs(
    captured_tabs: list[dict[str, Any]],
    pane_map: dict[str, str],
    session: str | None,
    live_sessions: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """`live_sessions` (restore paths only) maps agent session ids already running to their pane, so a restore never
    resumes a session a second time; a move rebuilds tabs whose originals are still running and passes nothing."""
    outcomes: list[dict[str, Any]] = []
    for tab in captured_tabs:
        for restore in tab.get("agent_restores", []):
            old_pane_id = restore.get("source_pane_id")
            new_pane_id = pane_map.get(str(old_pane_id))
            command = restore.get("resume_command")
            live_pane = (live_sessions or {}).get(str(restore.get("session_id")))
            if live_pane and is_trusted_restore(restore):
                outcomes.append(
                    {"source_pane_id": old_pane_id, "status": "skipped", "action": "already_live", "live_pane_id": live_pane}
                )
                continue
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
    problems = leader_destination_problems(destination.get("label"), captured_tabs)
    if problems:
        raise OrganizerError("Nothing was moved. " + "; ".join(problems) + ".")
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
    """Restore archived tabs into a live workspace. A restored tab leaves the archive, and an archive that has no tab left leaves its group."""
    try:
        restore_archived_tabs(args)
    finally:
        if args.execute:
            try:
                prune_group_files()
            except (OrganizerError, OSError) as error:
                print(f"Note: the archive group was not updated: {error}")


def restore_archived_tabs(args: argparse.Namespace) -> None:
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
    require_leader_restore_ok(snapshot, destination.get("label"), selected_tabs, True)
    live_sessions = live_agent_sessions(snapshot)
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
            outcomes = resume_captured_tabs([tab], pane_map, args.session, live_sessions) if args.resume_agents else []
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
            if not failures:
                # The tab is live now, so it is no longer an archived session. Nothing about it is kept that could
                # make a later archive of it merge back into this archive: that archive starts fresh.
                operation["tab_label"] = tab.get("label")
                archive["capture"]["tabs"] = [
                    item for item in archive["capture"].get("tabs", []) if item.get("source_tab_id") != operation["source_tab_id"]
                ]
                archive["updated_at"] = now()
        except OrganizerError as error:
            operation["status"] = "failed"
            operation["error"] = str(error)
            operation["failed_at"] = now()
            write_json(archive_path, archive)
            raise OrganizerError(
                f"Some archived tabs may already have been restored. The recovery records were retained: {error}"
            ) from error
        write_json(archive_path, archive)
    if not archive.get("capture", {}).get("tabs"):
        # Every tab went back to a live workspace. The archive is spent and leaves its group. It records no workspace
        # link, so archiving one of those tabs again makes a new archive instead of reopening this one.
        if archive.get("status") not in RESTORED_STATUSES:
            archive["status"] = "restored"
            archive["restored_at"] = now()
            archive["restore"] = {"tab_by_tab": True}
        write_json(archive_path, archive)
    if any(outcome.get("status") == "failed" for outcome in all_outcomes):
        raise OrganizerError("Archived tabs were restored, but one or more agent resumes failed. The recovery records were retained.")
    resumed = sum(outcome.get("action") == "resumed" for outcome in all_outcomes)
    print(f"Restored {len(selected_tabs)} archived tab(s) into workspace {args.to_workspace}.")
    print("They left the archive. Archiving one of them again starts a new archive." + (" The archive has no tab left, so it left its group." if not archive.get("capture", {}).get("tabs") else ""))
    print(f"Resumed {resumed} verified agent session(s).")


def restore_tab_command(args: argparse.Namespace) -> None:
    args.tab = [args.tab]
    restore_tabs_command(args)


def live_agent_running(pane: dict[str, Any]) -> bool:
    """A pane that already shows an agent must never get a resume command typed into it."""
    return bool(pane.get("agent")) or pane.get("agent_status") not in (None, "", "unknown")


def layout_copy_of(archive: dict[str, Any], session: str | None) -> dict[str, Any] | None:
    """The open workspace from an earlier layout-only restore of this archive, with its pane map.

    A copy counts only when Herdr still lists the recorded workspace and it is exactly what the restore built: the same
    tabs, the same layout shape as the capture and, when the restore recorded them, the same pane ids. Nothing is
    trusted from the record alone, so a closed, rebuilt, rearranged or partly replaced workspace is never adopted and a
    resume command is never typed into a shell that is not the captured one.
    """
    layout = archive.get("layout_restore")
    workspace_id = layout.get("workspace_id") if isinstance(layout, dict) else None
    if not workspace_id:
        return None
    captured_tabs = archive.get("capture", {}).get("tabs", [])
    try:
        snapshot = session_snapshot(session)
        if not any(item.get("workspace_id") == workspace_id for item in snapshot.get("workspaces", [])):
            return None
        live_tabs = tabs_for_workspace(snapshot, workspace_id)
        if not captured_tabs or len(live_tabs) != len(captured_tabs):
            return None
        recorded = {
            str(item.get("source_tab_id")): item for item in layout.get("tabs", []) if isinstance(item, dict)
        }
        live_ids = {str(tab.get("tab_id")) for tab in live_tabs}
        pane_map: dict[str, str] = {}
        tab_ids: list[str] = []
        for captured in captured_tabs:
            record = recorded.get(str(captured.get("source_tab_id")))
            tab_id = str(record.get("tab_id")) if record else ""
            if tab_id not in live_ids or tab_id in tab_ids:
                return None
            exported = socket_call(session, "layout.export", {"tab_id": tab_id}).get("layout")
            if not isinstance(exported, dict):
                return None
            captured_root = captured.get("layout", {}).get("root")
            live_root = exported.get("root")
            if layout_topology(live_root) != layout_topology(captured_root):
                return None
            if record.get("topology") is not None and record["topology"] != layout_topology(live_root):
                return None
            # Records made before pane ids were kept have nothing more to compare, so they adopt on the shape alone.
            if record.get("pane_ids") is not None and record["pane_ids"] != leaf_pane_ids(live_root):
                return None
            pane_map.update(matching_pane_map(captured_root, live_root))
            tab_ids.append(tab_id)
        busy = {
            str(pane.get("pane_id"))
            for pane in snapshot.get("panes", [])
            if pane.get("tab_id") in tab_ids and live_agent_running(pane)
        }
    except OrganizerError:
        return None
    return {"workspace_id": str(workspace_id), "tab_ids": tab_ids, "pane_map": pane_map, "busy": busy}


def restore_outcome_counts(outcomes: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    failures = [outcome for outcome in outcomes if outcome.get("status") == "failed"]
    return failures, sum(outcome.get("status") == "sent" for outcome in outcomes)


def restore_into_layout_copy(
    archive_path: Path,
    archive: dict[str, Any],
    copy: dict[str, Any],
    args: argparse.Namespace,
    live_sessions: dict[str, str] | None = None,
) -> str:
    """Resume agents inside the workspace an earlier layout-only restore left open, instead of making another one."""
    record: dict[str, Any] = {
        "workspace_id": copy["workspace_id"],
        "started_at": now(),
        "tabs": [{"tab_id": tab_id} for tab_id in copy["tab_ids"]],
        "agent_resume": [],
        "adopted_layout_copy": True,
    }
    archive["status"] = "restore_partial"
    archive["restore"] = record
    write_json(archive_path, archive)
    busy_sources = {old for old, new in copy["pane_map"].items() if new in copy["busy"]}
    pane_map = {old: new for old, new in copy["pane_map"].items() if old not in busy_sources}
    try:
        outcomes = resume_agents(archive, pane_map, args.session, live_sessions)
        for outcome in outcomes:
            if outcome.get("status") == "skipped" and outcome.get("source_pane_id") in busy_sources:
                outcome["reason"] = "agent_running"
        record["agent_resume"] = outcomes
        failures, sent = restore_outcome_counts(outcomes)
        archive["status"] = "restore_partial" if failures else "resumed" if sent else "restored"
        record["completed_at"] = now()
        write_json(archive_path, archive)
    except BaseException as error:
        record["error"] = str(error) if isinstance(error, OrganizerError) else "Interrupted before the resume finished."
        record["failed_at"] = now()
        write_json(archive_path, archive)
        raise
    print(f"Restored archive {args.archive} by resuming its agents in the open workspace {copy['workspace_id']}. No new workspace was made.")
    print(f"Resumed {sum(outcome.get('action') == 'resumed' for outcome in outcomes)} verified agent session(s).")
    skipped_running = sum(outcome.get("reason") == "agent_running" for outcome in outcomes)
    if skipped_running:
        print(f"Left {skipped_running} pane(s) alone because an agent is already running there.")
    if failures:
        print(f"{len(failures)} resume command(s) failed. The archive stays restore_partial. Run the command again to retry them.")
    return "adopted"


def restore_into_new_workspace(
    archive_path: Path, archive: dict[str, Any], args: argparse.Namespace, live_sessions: dict[str, str] | None = None
) -> str:
    """Create a workspace from the archive. Only a restore that also resumes agents marks the archive restored."""
    capture = archive.get("capture", {})
    workspace = capture.get("workspace", {})
    resuming = bool(args.resume_agents)
    cwd = first_cwd(capture)
    command = ["workspace", "create", "--label", str(leader_archive_workspace_label(capture) or "Restored workspace")]
    if cwd:
        command.extend(["--cwd", cwd])
    created = result_of(run_json(command, args.session))
    workspace_id = extract_workspace_id(created)
    initial_tab_id = extract_tab_id(created)
    record: dict[str, Any] = {"workspace_id": workspace_id, "started_at": now(), "tabs": [], "agent_resume": []}
    if resuming:
        archive["status"] = "restore_partial"
        archive["restore"] = record
    else:
        # A layout-only restore never counts as a restore: the archive stays archived and keeps its restore commands.
        archive["layout_restore"] = record
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
            record["tabs"].append(
                {
                    "source_tab_id": tab.get("source_tab_id"),
                    "tab_id": new_layout.get("tab_id"),
                    "pane_ids": leaf_pane_ids(new_layout.get("root")),
                    "topology": layout_topology(new_layout.get("root")),
                }
            )
            write_json(archive_path, archive)
        if workspace.get("focused"):
            run_json(["workspace", "focus", workspace_id], args.session)
        if resuming:
            record["agent_resume"] = resume_agents(archive, pane_map, args.session, live_sessions)
            failures, sent = restore_outcome_counts(record["agent_resume"])
            archive["status"] = "restore_partial" if failures else "resumed" if sent else "restored"
        elif archive.get("status") == "restore_partial":
            archive["status"] = "archived"
        record["completed_at"] = now()
        write_json(archive_path, archive)
    except BaseException as error:
        record["error"] = str(error) if isinstance(error, OrganizerError) else "Interrupted before the restore finished."
        record["failed_at"] = now()
        write_json(archive_path, archive)
        raise
    if resuming:
        print(f"Restored archive {args.archive} into workspace {workspace_id}.")
        resumed = sum(outcome.get("action") == "resumed" for outcome in record["agent_resume"])
        print(f"Resumed {resumed} verified agent session(s).")
        return "created"
    print(f"Laid out archive {args.archive} as workspace {workspace_id} with fresh shells.")
    print(
        "The archive stays archived, so its restore commands are kept. Run restore --resume-agents to resume the agents "
        "in this workspace."
    )
    return "laid_out"


def restore_command(args: argparse.Namespace) -> str:
    """Restore one archive. Once it is restored it leaves its archive group, whatever the outcome of the rest of the run."""
    try:
        return restore_archive(args)
    finally:
        if args.execute:
            try:
                prune_group_files()
            except (OrganizerError, OSError) as error:
                print(f"Note: the archive group was not updated: {error}")


def restore_archive(args: argparse.Namespace) -> str:
    archive_path, archive = archive_by_id(args.archive)
    status = archive.get("status")
    if status not in {"archived", "restored", "resumed", "restore_partial"}:
        raise OrganizerError(f"Archive {args.archive!r} is in {status!r} state and cannot be restored.")
    if status in {"restored", "resumed"} and not args.force:
        raise OrganizerError("This archive was already restored. Use --force only if you intentionally want another copy.")
    capture = archive.get("capture", {})
    unavailable = unavailable_agent_restores(capture.get("tabs", []))
    live_snapshot = session_snapshot(args.session)
    leader_problems = leader_restore_problems(
        live_snapshot, leader_archive_workspace_label(capture), capture.get("tabs", []), False
    )
    if not args.execute:
        print(json.dumps(archive_summary(archive), indent=2))
        if leader_problems and not (not args.force and layout_copy_of(archive, args.session)):
            print("Blocked by the leader convention: " + "; ".join(leader_problems) + ".")
        print(
            f"Preview only. Re-run with --execute --confirm {args.archive!r} to restore. "
            "Without --resume-agents only the layout is rebuilt and the archive stays archived. With --resume-agents "
            "the agents are resumed in the workspace an earlier layout-only restore left open, or in a new workspace."
        )
        return "preview"

    require_execute_confirmation(args.execute, args.confirm, args.archive, "Restore")
    if args.resume_agents and unavailable and not args.allow_unresumable_agents:
        pane_ids = ", ".join(str(item.get("source_pane_id")) for item in unavailable)
        raise OrganizerError(
            f"Archive {args.archive!r} has {len(unavailable)} agent pane(s) without a verified resumable session: {pane_ids}. "
            "It was not restored. Use --allow-unresumable-agents only if restoring the layout without its agent sessions is acceptable."
        )
    copy = None if args.force else layout_copy_of(archive, args.session)
    if not copy:
        require_leader_restore_ok(live_snapshot, leader_archive_workspace_label(capture), capture.get("tabs", []), False)
    if copy and not args.resume_agents:
        print(
            f"Archive {args.archive} already has its layout open as workspace {copy['workspace_id']}. Nothing was created. "
            "Run restore --resume-agents to resume the agents there, or add --force for another copy."
        )
        return "already_laid_out"
    if copy:
        return restore_into_layout_copy(archive_path, archive, copy, args, live_agent_sessions(live_snapshot))
    earlier = archive.get("layout_restore")
    if isinstance(earlier, dict) and earlier.get("workspace_id") and not args.force:
        print(
            f"Note: workspace {earlier['workspace_id']} from an earlier layout-only restore of this archive is not reused"
            + (" because that restore was interrupted" if earlier.get("error") else " because it is closed or no longer matches")
            + ". Close it if it is still open and unwanted."
        )
    return restore_into_new_workspace(archive_path, archive, args, live_agent_sessions(live_snapshot))


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
    selected = session.strip()
    reject_recovery_identity_delimiters({"herdr_session": selected})
    return selected


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


LAYOUT_REBUILD_IDENTIFIER_FIELDS = {"focused_pane_id", "pane_id", "tab_id", "workspace_id"}


def layout_shape(value: Any) -> Any:
    """Keep only layout topology, excluding identifiers assigned on rebuild."""
    if isinstance(value, list):
        return [layout_shape(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        key: layout_shape(item)
        for key, item in sorted(value.items())
        if key not in LAYOUT_REBUILD_IDENTIFIER_FIELDS
    }


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


def recovery_workspace_acknowledgement_key(session: str, workspace_id: str) -> str:
    identity = recovery_identity(session, workspace_id)
    return f"{identity['herdr_session']}|{identity['workspace_id']}"


def recovery_workspace_acknowledgements(values: Iterable[str] | None) -> set[str]:
    acknowledgements: set[str] = set()
    for value in values or []:
        fields = value.split("|")
        if len(fields) != 2 or any(not field for field in fields):
            raise OrganizerError(
                "--allow-mixed-cwd-workspace must be the exact named identity session|workspace."
            )
        acknowledgements.add(recovery_workspace_acknowledgement_key(fields[0], fields[1]))
    return acknowledgements


def recovery_workspace_panes(
    snapshot: dict[str, Any], workspace_id: str, layouts: dict[str, dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    panes = [
        pane for pane in snapshot.get("panes", [])
        if isinstance(pane, dict) and pane.get("workspace_id") == workspace_id
    ]
    panes_by_id = {str(pane.get("pane_id")): pane for pane in panes if pane.get("pane_id")}
    ordered_ids: list[str] = []
    for tab in tabs_for_workspace(snapshot, workspace_id):
        tab_id = str(tab.get("tab_id") or "")
        layout = layouts.get(tab_id) if layouts else None
        if isinstance(layout, dict):
            for pane in leaf_panes(layout.get("root")):
                pane_id = pane.get("pane_id")
                if isinstance(pane_id, str) and pane_id in panes_by_id and pane_id not in ordered_ids:
                    ordered_ids.append(pane_id)
    ordered_ids.extend(
        str(pane.get("pane_id")) for pane in panes
        if pane.get("pane_id") and str(pane.get("pane_id")) not in ordered_ids
    )
    return [panes_by_id[pane_id] for pane_id in ordered_ids]


def recovery_workspace_pane_cwds(
    snapshot: dict[str, Any], workspace: dict[str, Any], layouts: dict[str, dict[str, Any]] | None = None
) -> list[str | None]:
    workspace_id = workspace.get("workspace_id")
    if not isinstance(workspace_id, str) or not workspace_id:
        return []
    return [
        value.strip() if isinstance(value, str) and value.strip() else None
        for pane in recovery_workspace_panes(snapshot, workspace_id, layouts)
        for value in [pane.get("foreground_cwd") or pane.get("cwd")]
    ]


def recovery_workspace_is_mixed_cwd(
    snapshot: dict[str, Any], workspace: dict[str, Any], layouts: dict[str, dict[str, Any]] | None = None
) -> bool:
    workspace_cwd = workspace.get("cwd")
    if isinstance(workspace_cwd, str) and workspace_cwd.strip():
        return False
    pane_cwds = [cwd for cwd in recovery_workspace_pane_cwds(snapshot, workspace, layouts) if cwd]
    return len(set(pane_cwds)) > 1


def recovery_path_issue(value: Any, kind: str, identity: dict[str, str | None]) -> dict[str, Any] | None:
    if not isinstance(value, str) or not value.strip():
        return {"kind": kind, "identity": identity, "path": None}
    path = Path(value.strip()).expanduser()
    if path.is_dir():
        return None
    return {"kind": kind, "identity": identity, "path": str(path)}


def recovery_workspace_cwd(
    snapshot: dict[str, Any],
    workspace: dict[str, Any],
    *,
    session: str | None = None,
    acknowledgements: set[str] | None = None,
    layouts: dict[str, dict[str, Any]] | None = None,
) -> Any:
    """Use Herdr's workspace cwd, or a consistent pane cwd when it omits one.

    Herdr 0.7.3 can omit ``workspace.cwd`` for a newly created workspace while
    still supplying the cwd for every pane. Treating that omission as a failed
    recovery preflight would reject an otherwise safe shell-only session. A
    mixed pane-cwd workspace remains unresolved because it has no unambiguous
    workspace-level cwd to recreate.
    """
    workspace_cwd = workspace.get("cwd")
    if isinstance(workspace_cwd, str) and workspace_cwd.strip():
        return workspace_cwd
    workspace_id = workspace.get("workspace_id")
    if not isinstance(workspace_id, str) or not workspace_id:
        return workspace_cwd
    pane_cwds = recovery_workspace_pane_cwds(snapshot, workspace, layouts)
    valid_cwds = [cwd for cwd in pane_cwds if cwd]
    if len(set(valid_cwds)) == 1:
        return valid_cwds[0]
    if (
        session
        and acknowledgements
        and recovery_workspace_acknowledgement_key(session, workspace_id) in acknowledgements
    ):
        return pane_cwds[0] if pane_cwds else workspace_cwd
    return workspace_cwd


def recovery_identity_labels(snapshot: dict[str, Any], identity: dict[str, Any]) -> str:
    """Render local, human-readable workspace and tab labels for one failure."""
    workspace_id = identity.get("workspace_id")
    tab_id = identity.get("tab_id")
    labels: list[str] = []
    if isinstance(workspace_id, str) and workspace_id:
        for workspace in snapshot.get("workspaces", []):
            if not isinstance(workspace, dict) or workspace.get("workspace_id") != workspace_id:
                continue
            label = workspace.get("label")
            if isinstance(label, str) and label:
                labels.append(f"workspace {label!r}")
            break
    if isinstance(tab_id, str) and tab_id:
        for tab in snapshot.get("tabs", []):
            if (
                not isinstance(tab, dict)
                or tab.get("tab_id") != tab_id
                or (isinstance(workspace_id, str) and tab.get("workspace_id") != workspace_id)
            ):
                continue
            label = tab.get("label")
            if isinstance(label, str) and label:
                labels.append(f"tab {label!r}")
            break
    return ", ".join(labels)


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
    trusted_restore = is_trusted_restore(restore)
    agent_details = {"agent": agent, "agent_status": status, "trusted_restore": trusted_restore}
    if agent and status in ACTIVE_AGENT_STATUSES:
        return {"identity": identity, "classification": "busy_agent", **agent_details}, {
            "kind": "busy_agent", "identity": identity
        }
    if agent and status not in SAFE_RESUMABLE_AGENT_STATUSES:
        return {
            "identity": identity,
            "classification": "agent_status_not_idle",
            **agent_details,
        }, {"kind": "agent_status_not_idle", "identity": identity}
    if agent and not trusted_restore:
        return {
            "identity": identity,
            "classification": "unverified_recovery_identity",
            **agent_details,
        }, {"kind": "unverified_recovery_identity", "identity": identity}
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
    if agent and trusted_restore:
        return {
            "identity": identity,
            "classification": "verified_resumable_supported_agent",
            **agent_details,
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
    session: str,
    snapshot: dict[str, Any],
    layouts: dict[str, dict[str, Any]],
    acknowledgements: set[str],
    mixed_cwd_acknowledgements: set[str] | None = None,
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
    mixed_cwd_acknowledgements = mixed_cwd_acknowledgements or set()
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
        workspace_id = str(workspace["workspace_id"])
        identity = recovery_identity(selected, workspace_id)
        workspace_acknowledgement = recovery_workspace_acknowledgement_key(selected, workspace_id)
        is_mixed = recovery_workspace_is_mixed_cwd(snapshot, workspace, layouts)
        if is_mixed and workspace_acknowledgement not in mixed_cwd_acknowledgements:
            failures.append({"kind": "mixed_workspace_cwd", "identity": identity})
            issue = None
        else:
            issue = recovery_path_issue(
                recovery_workspace_cwd(
                    snapshot,
                    workspace,
                    session=selected,
                    acknowledgements=mixed_cwd_acknowledgements,
                    layouts=layouts,
                ),
                "missing_workspace_cwd",
                identity,
            )
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
        "mixed_cwd_acknowledgements": sorted(mixed_cwd_acknowledgements),
    }


def recovery_preflight_session(
    session: str, acknowledgements: set[str], mixed_cwd_acknowledgements: set[str] | None = None
) -> dict[str, Any]:
    """Read-only checks. This function never sends a pane command or closes anything."""
    selected = require_recovery_session(session)
    try:
        snapshot = session_snapshot(selected)
    except OrganizerError as error:
        raise OrganizerError(f"Recovery session {selected!r} is not attached: {error}") from error
    layouts = recovery_layouts(snapshot, selected)
    return recovery_preflight_snapshot(
        selected, snapshot, layouts, acknowledgements, mixed_cwd_acknowledgements
    )


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
    mixed_cwd_acknowledgements = set(preflight.get("mixed_cwd_acknowledgements", []))
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
            "cwd": recovery_workspace_cwd(
                snapshot,
                workspace,
                session=selected,
                acknowledgements=mixed_cwd_acknowledgements,
                layouts=layouts,
            ),
            "focused": bool(workspace.get("focused")),
            "tabs": captured_tabs,
        }
        captured_workspace["mixed_cwd_acknowledged"] = (
            recovery_workspace_is_mixed_cwd(snapshot, workspace, layouts)
            and recovery_workspace_acknowledgement_key(selected, workspace_id) in mixed_cwd_acknowledgements
        )
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
            "mixed_cwd_acknowledgements": sorted(mixed_cwd_acknowledgements),
        },
    }


def preflight_classification_map(preflight: dict[str, Any]) -> dict[str, str]:
    return {
        recovery_identity_key(item["identity"]): str(item.get("classification"))
        for item in preflight.get("classifications", [])
        if isinstance(item, dict) and isinstance(item.get("identity"), dict)
    }


def stable_recovery_capture(
    session: str,
    acknowledgements: set[str],
    attempts: int,
    mixed_cwd_acknowledgements: set[str] | None = None,
) -> dict[str, Any]:
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
            first_preflight = recovery_preflight_snapshot(
                selected, first, first_layouts, acknowledgements, mixed_cwd_acknowledgements
            )
            second_preflight = recovery_preflight_snapshot(
                selected, second, second_layouts, acknowledgements, mixed_cwd_acknowledgements
            )
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
    mixed_cwd_acknowledgements = manifest.get("mixed_cwd_acknowledgements", [])
    if not isinstance(mixed_cwd_acknowledgements, list):
        raise OrganizerError("Recovery bundle has invalid mixed-CWD acknowledgements.")
    for item in mixed_cwd_acknowledgements:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("identity"), dict)
            or not isinstance(item["identity"].get("herdr_session"), str)
            or not isinstance(item["identity"].get("workspace_id"), str)
            or not isinstance(item.get("rebuild_cwd"), str)
        ):
            raise OrganizerError("Recovery bundle has an invalid mixed-CWD acknowledgement.")
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
    mixed_cwd_manifest: list[dict[str, Any]] = []
    try:
        for capture in captures:
            session = require_recovery_session(capture.get("session"))
            filename = f"{hashlib.sha256(session.encode()).hexdigest()[:20]}.json"
            relative = f"sessions/{filename}"
            path = stage / relative
            write_private_json(path, capture)
            checksums[relative] = private_json_digest(path)
            session_files.append({"identity": recovery_identity(session), "file": relative})
            for workspace in capture.get("workspaces", []):
                if not isinstance(workspace, dict) or not workspace.get("mixed_cwd_acknowledged"):
                    continue
                mixed_cwd_manifest.append(
                    {
                        "identity": workspace.get("identity"),
                        "rebuild_cwd": workspace.get("cwd"),
                    }
                )
        manifest = {
            "schema_version": RECOVERY_SCHEMA_VERSION,
            "bundle_id": bundle_id,
            "created_at": now(),
            "sessions": session_files,
            "checksums": checksums,
            "mixed_cwd_acknowledgements": mixed_cwd_manifest,
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


PREFLIGHT_FAILURE_HINTS = {
    "agent_status_not_idle": "The supported-agent status is not idle or done. Let it finish, then retry preflight.",
    "blocker": "Review the foreground process. A deliberately volatile process may use the exact acknowledgement below.",
    "busy_agent": "Let the agent finish before retrying preflight.",
    "missing_pane_cwd": "Restore or create the pane working directory, then retry.",
    "missing_registered_worktree": "Restore or create the registered worktree, then retry.",
    "missing_workspace_cwd": "Restore or create the workspace working directory, then retry.",
    "mixed_workspace_cwd": "This workspace has mixed pane CWDs without a workspace CWD. A rebuild uses the first pane's CWD; acknowledge only if that is acceptable.",
    "multiple_focused_workspaces": "Focus exactly one workspace in this named session, then retry.",
    "no_focused_workspace": "Focus one workspace in this named session, then retry.",
    "unknown_process_state": "Wait for Herdr process metadata to become available, then retry. Do not acknowledge it.",
    "unverified_recovery_identity": "Recovery identity is not verified. Run herdr-agent-capture-history in this named session, or herdr-agent-capture-status for an idle or done pane, then retry.",
}


def preflight_failure_details(preflights: Iterable[dict[str, Any]]) -> str:
    """Render actionable failures without exposing terminal or agent-session data."""
    grouped: dict[str, list[tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any]]]] = {}
    for preflight in preflights:
        classifications = {
            recovery_identity_key(item["identity"]): item
            for item in preflight.get("classifications", [])
            if isinstance(item, dict) and isinstance(item.get("identity"), dict)
        }
        for failure in preflight.get("failures", []):
            if not isinstance(failure, dict) or not isinstance(failure.get("identity"), dict):
                continue
            identity = failure["identity"]
            kind = str(failure.get("kind") or "unknown_failure")
            snapshot = preflight.get("snapshot")
            grouped.setdefault(kind, []).append(
                (identity, classifications.get(recovery_identity_key(identity)), snapshot if isinstance(snapshot, dict) else {})
            )

    lines = ["Preflight failures:"]
    for kind in sorted(grouped):
        entries = sorted(grouped[kind], key=lambda item: recovery_identity_key(item[0]))
        hint = PREFLIGHT_FAILURE_HINTS.get(kind, "Resolve the named condition, then retry preflight.")
        lines.append(f"- {kind} ({len(entries)}): {hint}")
        for identity, classification, snapshot in entries:
            rendered_identity = recovery_identity_key(identity)
            labels = recovery_identity_labels(snapshot, identity)
            label_detail = f" {labels}" if labels else ""
            detail = ""
            if classification and classification.get("classification") in {
                "agent_status_not_idle", "blocker", "busy_agent", "unknown_process_state", "unverified_recovery_identity"
            }:
                detail = f" reason={classification['classification']}"
                agent = classification.get("agent")
                status = classification.get("agent_status")
                if isinstance(agent, str) and agent:
                    detail += f" agent={agent}"
                if isinstance(status, str) and status:
                    detail += f" status={status}"
                if isinstance(classification.get("trusted_restore"), bool):
                    detail += f" trusted_restore={str(classification['trusted_restore']).lower()}"
            lines.append(f"  {rendered_identity}{label_detail}{detail}")
            if kind == "blocker" and classification and classification.get("classification") == "blocker":
                lines.append(f"    --allow-volatile-pane {shlex.quote(rendered_identity)}")
            if kind == "mixed_workspace_cwd":
                workspace_identity = recovery_workspace_acknowledgement_key(
                    str(identity.get("herdr_session") or ""), str(identity.get("workspace_id") or "")
                )
                lines.append(f"    --allow-mixed-cwd-workspace {shlex.quote(workspace_identity)}")
    return "\n".join(lines)


def preflight_console_summary(preflights: Iterable[dict[str, Any]]) -> str:
    """Render a bounded, redacted summary for the restart preflight report."""
    items = list(preflights)
    counts = {
        "busy agents": 0,
        "blockers": 0,
        "mixed-cwd workspaces": 0,
        "unverified recovery identity": 0,
        "other": 0,
    }
    for preflight in items:
        for failure in preflight.get("failures", []):
            kind = str(failure.get("kind") or "other") if isinstance(failure, dict) else "other"
            if kind in {"busy_agent", "agent_status_not_idle"}:
                counts["busy agents"] += 1
            elif kind == "blocker":
                counts["blockers"] += 1
            elif kind == "mixed_workspace_cwd":
                counts["mixed-cwd workspaces"] += 1
            elif kind == "unverified_recovery_identity":
                counts["unverified recovery identity"] += 1
            else:
                counts["other"] += 1
    ready = not any(preflight.get("failures") for preflight in items)
    lines = [
        "Summary:",
        f"ready_to_seal {'yes' if ready else 'no'}",
        "failure counts: "
        f"busy agents {counts['busy agents']}; blockers {counts['blockers']}; "
        f"mixed-cwd workspaces {counts['mixed-cwd workspaces']}; "
        f"unverified recovery identity {counts['unverified recovery identity']}; other {counts['other']}",
    ]
    actions = []
    if counts["busy agents"]:
        actions.append("Next: let working or blocked agents finish, then retry preflight.")
    if counts["blockers"]:
        actions.append("Next: review the foreground process and acknowledge only an intended volatile pane.")
    if counts["mixed-cwd workspaces"]:
        actions.append("Next: resolve the mixed-CWD workspace or use its explicit acknowledgement.")
    if counts["unverified recovery identity"]:
        actions.append("Next: run herdr-agent-verify-identity or herdr-agent-capture-status for idle or done panes, then retry.")
    if counts["other"]:
        actions.append("Next: follow the listed failure hints, then retry preflight.")
    if not actions:
        actions.append("Next: retain the ready bundle locally, then restart when ready.")
    lines.extend(actions[:3])
    return "\n".join(lines)


def prepare_restart_recovery_command(args: argparse.Namespace) -> None:
    selected = recovery_sessions(args)
    acknowledgements = recovery_acknowledgements(args.allow_volatile_pane)
    mixed_cwd_acknowledgements = recovery_workspace_acknowledgements(
        getattr(args, "allow_mixed_cwd_workspace", [])
    )
    preflights = [
        recovery_preflight_session(session, acknowledgements, mixed_cwd_acknowledgements)
        for session in selected
    ]
    summary = redacted_preflight_summary(preflights)
    summary_only = getattr(args, "summary_only", False)
    if any(item["failures"] for item in preflights):
        if summary_only:
            print(preflight_console_summary(preflights))
            raise OrganizerError(
                "Restart recovery preflight failed.", suppress_message=True
            )
        print(json.dumps(summary, indent=2))
        print(preflight_failure_details(preflights))
        print(preflight_console_summary(preflights))
        raise OrganizerError("Restart recovery preflight failed. Resolve each named failure or acknowledge only the intended volatile pane.")
    if args.preflight_only:
        if not summary_only:
            print(json.dumps(summary, indent=2))
            print("Preflight passed. No recovery bundle was written.")
        print(preflight_console_summary(preflights))
        return
    captures = [
        stable_recovery_capture(
            session, acknowledgements, args.capture_attempts, mixed_cwd_acknowledgements
        )
        for session in selected
    ]
    bundle_id = write_recovery_bundle(captures)
    if not summary_only:
        print(json.dumps({"bundle_id": bundle_id, "session_count": len(captures), "ready": True}, indent=2))
        print("Recovery bundle sealed. Restart only after retaining this ready bundle locally.")
    print(preflight_console_summary(preflights))


def native_recovery_workspace(
    snapshot: dict[str, Any],
    workspace: dict[str, Any],
    session: str,
    mixed_cwd_acknowledgements: set[str] | None = None,
) -> dict[str, Any]:
    workspace_id = str(workspace.get("workspace_id") or "")
    tabs: list[dict[str, Any]] = []
    layouts: dict[str, dict[str, Any]] = {}
    for index, tab in enumerate(tabs_for_workspace(snapshot, workspace_id)):
        tab_id = str(tab.get("tab_id") or "")
        layout = recovery_layouts({"tabs": [tab]}, session).get(tab_id)
        if not layout:
            raise OrganizerError(f"Could not inspect native tab {tab_id}.")
        layouts[tab_id] = layout
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
        "cwd": recovery_workspace_cwd(
            snapshot,
            workspace,
            session=session,
            acknowledgements=mixed_cwd_acknowledgements,
            layouts=layouts,
        ),
        "focused": bool(workspace.get("focused")),
        "tabs": tabs,
    }
    native["fingerprint"] = recovery_workspace_fingerprint(native)
    return native


def native_recovery_workspaces(
    snapshot: dict[str, Any], session: str, mixed_cwd_acknowledgements: set[str] | None = None
) -> list[dict[str, Any]]:
    return [
        native_recovery_workspace(snapshot, workspace, session, mixed_cwd_acknowledgements)
        for workspace in snapshot.get("workspaces", [])
        if isinstance(workspace, dict)
    ]


def plan_recovery_session(capture: dict[str, Any]) -> dict[str, Any]:
    session = require_recovery_session(capture.get("session"))
    try:
        snapshot = session_snapshot(session)
    except OrganizerError as error:
        raise OrganizerError(f"Recovery session {session!r} is not attached. Attach it interactively before reconciling: {error}") from error
    mixed_cwd_acknowledgements = {
        str(item)
        for item in capture.get("preflight", {}).get("mixed_cwd_acknowledgements", [])
        if isinstance(item, str)
    }
    native = native_recovery_workspaces(snapshot, session, mixed_cwd_acknowledgements)
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
        and recovery_workspace_cwd(snapshot, item) == state.get("expected_cwd")
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
    notes: list[dict[str, Any]] = []
    mixed_cwd_acknowledgements = {
        str(item)
        for item in capture.get("preflight", {}).get("mixed_cwd_acknowledgements", [])
        if isinstance(item, str)
    }
    native_workspaces = native_recovery_workspaces(snapshot, session, mixed_cwd_acknowledgements)
    native_by_id = {str(item["identity"].get("workspace_id")): item for item in native_workspaces}
    target_ids: set[str] = set()
    for source in capture.get("workspaces", []):
        expected_counts["tabs"] += len(source.get("tabs", []))
        expected_counts["panes"] += sum(len(tab.get("panes", [])) for tab in source.get("tabs", []))
        state = workspace_states.get(recovery_workspace_plan_key(source), {})
        target_id = state.get("native_workspace_id") if state.get("planned_action") == "adopt" else state.get("created_workspace_id")
        if source.get("mixed_cwd_acknowledged") and state.get("planned_action") == "rebuild":
            notes.append(
                {
                    "kind": "mixed_cwd_panes_not_restored",
                    "identity": source.get("identity"),
                    "message": "Per-pane CWDs were not restored because layout.apply has no per-pane CWD support.",
                }
            )
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
    return {
        "verified_at": now(),
        "expected_counts": expected_counts,
        "actual_counts": actual_counts,
        "failures": sorted(set(failures)),
        "notes": notes,
        "post_boot_snapshot": snapshot,
    }


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
        output["sessions"].append(
            {
                "session": session,
                "verification_failures": verification.get("failures", []),
                "verification_notes": verification.get("notes", []),
                "agent_dispatches": sum(
                    1
                    for workspace in state["workspaces"].values()
                    for outcome in workspace.get("agent_outcomes", [])
                    if outcome.get("dispatch") == "sent"
                ),
            }
        )
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
                if marked_recovery_workspaces(snapshot, state):
                    raise OrganizerError(
                        "A close-intent recovery operation marker remains after its created workspace ID disappeared. "
                        "Stop for manual repair."
                    )
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
            if snapshot_workspace_with_id(snapshot, created_workspace_id):
                raise OrganizerError(
                    "A recovery workspace recorded as closed still exists. Stop for manual repair."
                )
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
        confirmed = session_snapshot(session)
        if snapshot_workspace_with_id(confirmed, workspace_id):
            raise OrganizerError("Herdr did not close the recovery workspace ID. Stop for manual repair.")
        if marked_recovery_workspaces(confirmed, state):
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
        prepare.add_argument(
            "--allow-mixed-cwd-workspace", action="append", default=[],
            help="Acknowledge one mixed-CWD workspace as session|workspace. Repeat as needed.",
        )
        prepare.add_argument("--capture-attempts", type=int, default=RECOVERY_MAX_CAPTURE_ATTEMPTS)
        prepare.add_argument("--preflight-only", action="store_true")
        prepare.add_argument("--summary-only", action="store_true", help="print only the redacted summary block")
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
    archive.set_defaults(func=with_batch_lock("archive", archive_command))

    archive_all = commands.add_parser(
        "archive-all",
        help="Archive every live workspace that passes the safety checks as one batch. Skips the rest and reports why.",
    )
    archive_all.add_argument("--execute", action="store_true")
    archive_all.add_argument("--confirm", help="Must exactly equal the session name.")
    archive_all.set_defaults(func=archive_all_command)

    restore_batch = commands.add_parser(
        "restore-batch", help="Restore every member of a batch that is still archived, one workspace each."
    )
    restore_batch.add_argument("--batch", help="The session's archive group. Defaults to the one group of --session.")
    restore_batch.add_argument("--resume-agents", action="store_true")
    restore_batch.add_argument("--execute", action="store_true")
    restore_batch.add_argument("--confirm", help="Must exactly equal the batch ID.")
    restore_batch.set_defaults(func=with_group_lock("restore-batch", restore_batch_command))

    delete_batch = commands.add_parser(
        "delete-batch", help="Delete one batch record. Its archives are kept unless --archives is given."
    )
    delete_batch.add_argument("--batch", required=True)
    delete_batch.add_argument(
        "--archives", action="store_true", help="Also permanently delete every archive that belongs to the batch."
    )
    delete_batch.add_argument("--execute", action="store_true")
    delete_batch.add_argument("--confirm")
    delete_batch.set_defaults(func=with_group_lock("delete-batch", delete_batch_command))

    commands.add_parser("list-batches", help="Print batch summaries.").set_defaults(func=list_batches_command)

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
    archive_tabs.set_defaults(func=with_batch_lock("archive-tabs", archive_tabs_command))

    add_tabs_to_batch = commands.add_parser(
        "add-tabs-to-batch",
        help="Capture selected live tabs into a finished batch, then close them. Tabs of a workspace that already has a member merge into it.",
    )
    add_tabs_to_batch.add_argument("--batch", help="The session's archive group. Defaults to the one group of --session.")
    add_tabs_to_batch.add_argument("--tab", action="append", required=True, help="Selected live tab ID. Repeat for each tab.")
    add_tabs_to_batch.add_argument("--execute", action="store_true")
    add_tabs_to_batch.add_argument("--confirm", help="Must exactly equal the batch ID.")
    add_tabs_to_batch.set_defaults(func=with_group_lock("add-tabs-to-batch", add_tabs_to_batch_command))

    finish_tab_add = commands.add_parser(
        "finish-tab-add",
        help="Finish closing the tabs of an add-tabs-to-batch run that stopped part-way, after checking them again.",
    )
    finish_tab_add.add_argument("--archive", required=True)
    finish_tab_add.add_argument("--execute", action="store_true")
    finish_tab_add.add_argument("--confirm", help="Must exactly equal the archive ID.")
    finish_tab_add.set_defaults(func=with_batch_lock("finish-tab-add", finish_tab_add_command))

    cleanup_empty = commands.add_parser(
        "cleanup-empty-tabs", help="Close shell-only tabs without agents or preserved sessions."
    )
    cleanup_empty.add_argument("--workspace", required=True)
    cleanup_empty.add_argument("--execute", action="store_true")
    cleanup_empty.add_argument("--confirm")
    cleanup_empty.set_defaults(func=with_batch_lock("cleanup-empty-tabs", cleanup_empty_tabs_command))

    restore = commands.add_parser("restore", help="Create a workspace from an archive.")
    restore.add_argument("--archive", required=True)
    restore.add_argument("--resume-agents", action="store_true")
    restore.add_argument("--allow-unresumable-agents", action="store_true", help="Restore fresh shells for agents without a verified session.")
    restore.add_argument("--force", action="store_true", help="Allow an additional restore of an already restored archive.")
    restore.add_argument("--execute", action="store_true")
    restore.add_argument("--confirm")
    restore.set_defaults(func=with_batch_lock("restore", restore_command))

    restore_tab = commands.add_parser("restore-tab", help="Restore one archived tab into an active workspace.")
    restore_tab.add_argument("--archive", required=True)
    restore_tab.add_argument("--tab", required=True, help="Archived source tab ID, e.g. w1:t2.")
    restore_tab.add_argument("--to-workspace", required=True)
    restore_tab.add_argument("--allow-unresumable-agents", action="store_true", help="Restore fresh shells for agents without a verified session.")
    restore_tab.add_argument("--no-resume-agents", dest="resume_agents", action="store_false")
    restore_tab.add_argument("--execute", action="store_true")
    restore_tab.add_argument("--confirm")
    restore_tab.set_defaults(func=with_batch_lock("restore-tab", restore_tab_command), resume_agents=True)

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
    restore_tabs.set_defaults(func=with_batch_lock("restore-tabs", restore_tabs_command), resume_agents=True)

    delete_archive = commands.add_parser("delete-archive", help="Permanently delete one saved archive.")
    delete_archive.add_argument("--archive", required=True)
    delete_archive.add_argument("--execute", action="store_true")
    delete_archive.add_argument("--confirm")
    delete_archive.set_defaults(func=with_batch_lock("delete-archive", delete_archive_command))

    delete_archived_tab = commands.add_parser("delete-archived-tab", help="Permanently delete one tab from a saved archive.")
    delete_archived_tab.add_argument("--archive", required=True)
    delete_archived_tab.add_argument("--tab", required=True, help="Archived source tab ID, e.g. w1:t2.")
    delete_archived_tab.add_argument("--execute", action="store_true")
    delete_archived_tab.add_argument("--confirm")
    delete_archived_tab.set_defaults(func=with_batch_lock("delete-archived-tab", delete_archived_tab_command))

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
    move.set_defaults(func=with_batch_lock("move-tabs", move_tabs_command), resume_agents=True)

    resume_move = commands.add_parser("resume-move", help="Retry supported agent resumes for a completed tab move.")
    resume_move.add_argument("--move", required=True, help="Move recovery record ID.")
    resume_move.add_argument("--execute", action="store_true")
    resume_move.add_argument("--confirm")
    resume_move.set_defaults(func=with_batch_lock("resume-move", resume_move_command))

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
            "reconcile-all", "rollback-reconcile", "list-batches", "delete-batch",
        }:
            arguments.session = resolve_session(arguments.session)
        arguments.func(arguments)
        return 0
    except OrganizerError as error:
        if not error.suppress_message:
            print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
