#!/usr/bin/env python3
"""Read-only identity check for the manual identity form.

Usage: store_check.py <herdr tool root>

Reads one JSON object on stdin (never argv, so the id is not visible in `ps`):
  {"client": "claude"|"codex", "session_id": "...", "pane_cwd": "...",
   "herdr_session": "...", "pane_id": "..."}

Prints one JSON object with booleans and one enum, never the id, a path or a cwd:
  {"valid_format": bool, "exists": bool,
   "store_folder": "match"|"differs"|"unknown",
   "registered_elsewhere": bool, "already_registered_here": bool,
   "pane_registered_other": bool}

`pane_registered_other` is true when the pane already has a registry record for a
different session, so saving would replace it.

It reuses the verifier's own ClaudeStore and CodexStore classes from the tool
root so the store layouts are not re-implemented here. The registry manifest is
read only to see whether the id is already claimed by another pane.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def load_manifest(root: Path) -> list[dict]:
    path = Path(os.environ.get("PMOS_HERDR_AGENT_MANIFEST") or root / "state" / "herdr-agent-sessions.json").expanduser()
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    panes = data.get("panes") if isinstance(data, dict) else None
    return [item for item in panes if isinstance(item, dict)] if isinstance(panes, list) else []


def check(root: Path, request: dict) -> dict:
    sys.path.insert(0, str(root))
    import agent_identity_verifier as verifier  # noqa: E402

    client = request.get("client")
    session_id = request.get("session_id")
    herdr_session = str(request.get("herdr_session") or "")
    pane_id = str(request.get("pane_id") or "")
    result = {
        "valid_format": False,
        "exists": False,
        "store_folder": "unknown",
        "registered_elsewhere": False,
        "already_registered_here": False,
        "pane_registered_other": False,
    }
    if client not in verifier.SUPPORTED_CLIENTS or not verifier.valid_session_id(session_id):
        return result
    result["valid_format"] = True
    session_id = session_id.lower()

    if client == "claude":
        home = os.environ.get("PMOS_ORGANIZER_CLAUDE_HOME")
        store = verifier.ClaudeStore(Path(home) if home else None)
    else:
        store = verifier.CodexStore()
    record = store.find(session_id)
    if record is None:
        return result
    result["exists"] = True
    pane_cwd = verifier.normalize_cwd(request.get("pane_cwd"))
    if record.cwd and pane_cwd:
        result["store_folder"] = "match" if record.cwd == pane_cwd else "differs"

    for item in load_manifest(root):
        item_session = str(item.get("herdr_session") or herdr_session)
        here = (item_session, str(item.get("pane_id") or "")) == (herdr_session, pane_id)
        if item.get("client") != client or str(item.get("session_id") or "").lower() != session_id:
            if here:
                result["pane_registered_other"] = True
            continue
        if here:
            result["already_registered_here"] = True
        else:
            result["registered_elsewhere"] = True
    return result


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage"}))
        return 2
    try:
        request = json.loads(sys.stdin.read() or "{}")
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        print(json.dumps(check(Path(sys.argv[1]).resolve(), request)))
    except Exception:  # noqa: BLE001 - the caller only needs to know the check failed
        print(json.dumps({"error": "check_failed"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
