#!/usr/bin/env python3
"""Replay registered coding-agent sessions into herdr panes."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_STATE_DIR = SCRIPT_DIR / "state"
DEFAULT_MANIFEST = DEFAULT_STATE_DIR / "herdr-agent-sessions.json"


def manifest_path(args: argparse.Namespace) -> Path:
    return Path(
        args.manifest
        or os.environ.get("PMOS_HERDR_AGENT_MANIFEST")
        or DEFAULT_MANIFEST
    ).expanduser()


def read_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"manifest not found: {path}")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"manifest is not valid JSON: {path}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("panes"), list):
        raise SystemExit(f"manifest must contain a panes list: {path}")
    return data


def run_json(cmd: list[str]) -> dict[str, Any] | None:
    try:
        result = subprocess.run(cmd, text=True, capture_output=True, timeout=15, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def pane_list() -> dict[str, dict[str, Any]]:
    data = run_json(["herdr", "pane", "list"])
    if not data:
        return {}
    result = data.get("result")
    if not isinstance(result, dict):
        return {}
    panes = result.get("panes")
    if not isinstance(panes, list):
        return {}
    mapped: dict[str, dict[str, Any]] = {}
    for item in panes:
        if not isinstance(item, dict):
            continue
        pane_id = item.get("pane_id")
        if isinstance(pane_id, str) and pane_id:
            mapped[pane_id] = item
    return mapped


def filtered_records(args: argparse.Namespace, data: dict[str, Any]) -> list[dict[str, Any]]:
    herdr_session = args.herdr_session or os.environ.get("HERDR_SESSION")
    records: list[dict[str, Any]] = []
    for item in data["panes"]:
        record_session = item.get("herdr_session") or herdr_session
        if herdr_session and record_session != herdr_session:
            continue
        if args.pane_id and item.get("pane_id") != args.pane_id:
            continue
        if args.client and item.get("client") != args.client:
            continue
        if args.session_id and item.get("session_id") != args.session_id:
            continue
        if args.workspace_id and item.get("workspace_id") != args.workspace_id:
            continue
        if args.tab_id and item.get("tab_id") != args.tab_id:
            continue
        if item.get("status") not in {"active", "restorable"}:
            continue
        records.append(item)
    return records


def restore_line(item: dict[str, Any]) -> str:
    cwd = shlex.quote(str(item["cwd"]))
    return f"cd {cwd} && {item['resume_command']}"


def has_active_agent(pane: dict[str, Any]) -> bool:
    agent = pane.get("agent")
    if not isinstance(agent, str) or not agent:
        return False
    status = pane.get("agent_status")
    if status in {"done", "unknown", None}:
        return False
    return True


def target_ready(item: dict[str, Any], live: dict[str, Any], force: bool) -> tuple[bool, str | None]:
    if live.get("workspace_id") != item.get("workspace_id") or live.get("tab_id") != item.get("tab_id"):
        if not force:
            return False, "pane identity drifted; use --force to ignore workspace/tab mismatch"
    if has_active_agent(live):
        return False, f"pane already has active agent {live.get('agent')} ({live.get('agent_status')})"
    return True, None


def send_command(pane_id: str, command: str) -> None:
    run = subprocess.run(["herdr", "pane", "send-text", pane_id, command], text=True, capture_output=True, check=False)
    if run.returncode != 0:
        detail = (run.stderr or run.stdout or "").strip()
        raise SystemExit(f"failed to send text to {pane_id}: {detail}")
    enter = subprocess.run(["herdr", "pane", "send-keys", pane_id, "Enter"], text=True, capture_output=True, check=False)
    if enter.returncode != 0:
        detail = (enter.stderr or enter.stdout or "").strip()
        raise SystemExit(f"failed to send Enter to {pane_id}: {detail}")


def restore(args: argparse.Namespace) -> int:
    data = read_manifest(manifest_path(args))
    records = filtered_records(args, data)
    if not records:
        print("no matching active/restorable herdr agent registrations")
        return 0

    live = pane_list()
    executed = 0
    for item in records:
        pane_id = str(item.get("pane_id", ""))
        pane = live.get(pane_id)
        if not pane:
            print(f"SKIP {pane_id}: pane not found in live herdr session")
            continue
        ready, reason = target_ready(item, pane, args.force)
        if not ready:
            print(f"SKIP {pane_id}: {reason}")
            continue
        command = restore_line(item)
        label = str(item.get("label") or "")
        target = f"{item.get('herdr_session') or os.environ.get('HERDR_SESSION') or '?'}:{pane_id} {item.get('client')} {item.get('session_id')}"
        if label:
            target = f"{target} [{label}]"
        print(target)
        print(f"  target cwd: {pane.get('foreground_cwd') or pane.get('cwd') or ''}")
        print(f"  replay: {command}")
        if args.execute:
            send_command(pane_id, command)
            executed += 1
            if not args.all:
                break
    if args.execute:
        print(f"executed restore for {executed} pane(s)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", help="override manifest path")
    parser.add_argument("--execute", action="store_true", help="send restore commands")
    parser.add_argument("--force", action="store_true", help="ignore workspace/tab drift checks")
    parser.add_argument("--all", action="store_true", help="replay all eligible panes")
    parser.add_argument("--pane-id", help="restore one pane id, e.g. w3:p1")
    parser.add_argument("--client", choices=["codex", "claude"])
    parser.add_argument("--session-id")
    parser.add_argument("--workspace-id")
    parser.add_argument("--tab-id")
    parser.add_argument("--herdr-session", help="named Herdr session to restore")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return restore(args)


if __name__ == "__main__":
    sys.exit(main())
