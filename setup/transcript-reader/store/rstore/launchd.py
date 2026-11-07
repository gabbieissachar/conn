"""The LaunchAgents, as text. This module prints; it never installs, loads or starts anything.

Installing a LaunchAgent changes the machine outside git, so it follows the live-write rule: the exact commands and their targets are
shown, one `paused` line is appended, and nothing runs until the owner types `go` in the worker's tab. `plan()` returns the whole
change (files to write, commands to run, how to undo it) so it can be shown and approved as one.

Two agents:
  com.pmos.reader-store          the ingest daemon: RunAtLoad and KeepAlive, so it restarts after a crash and, because the daemon exits
                                 when a landing changes its own code (daemon.py, restart-on-landing), after a landing too
  com.pmos.reader-store-nightly  the nightly job at 03:30: the parity diff job, then a backup snapshot encrypted and staged, then the
                                 upload step (which stops with `drive_not_configured` until Google Drive for desktop is signed in)
The agents run the checkout this module is in. Land the branch on the checkout the agents should follow before installing, or the agents
follow a worktree that will be recycled.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
STORE = HERE.parent
REPO = STORE.parent.parent.parent
DAEMON_LABEL = "com.pmos.reader-store"
NIGHTLY_LABEL = "com.pmos.reader-store-nightly"


def agent_path(label: str) -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"


def tool_dirs() -> str:
    found = [str(Path(shutil.which(tool)).resolve().parent) for tool in ("herdr", "gpg", "age", "python3", "node") if shutil.which(tool)]
    return ":".join(dict.fromkeys([*found, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]))


def plist(label: str, arguments: list[str], log: Path, *, keep_alive: bool, calendar: tuple[int, int] | None = None, store_dir: Path | None = None) -> str:
    program = "".join(f"\n    <string>{escape(a)}</string>" for a in arguments)
    when = f"\n  <key>StartCalendarInterval</key>\n  <dict><key>Hour</key><integer>{calendar[0]}</integer><key>Minute</key><integer>{calendar[1]}</integer></dict>" if calendar else ""
    alive = "\n  <key>KeepAlive</key><true/>\n  <key>RunAtLoad</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>" if keep_alive else ""
    extra = f"\n    <key>PMOS_READER_STORE_DIR</key><string>{escape(str(store_dir))}</string>" if store_dir else ""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>{program}
  </array>
  <key>WorkingDirectory</key><string>{escape(str(REPO))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{escape(tool_dirs())}</string>{extra}
  </dict>{alive}{when}
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>{escape(str(log))}</string>
  <key>StandardErrorPath</key><string>{escape(str(log))}</string>
</dict>
</plist>
"""


def plan(store_dir: Path, python: str | None = None) -> dict:
    python = python or sys.executable
    script = str(STORE / "reader_store.py")
    logs = store_dir / "logs"
    uid = os.getuid()
    files = {
        agent_path(DAEMON_LABEL): plist(DAEMON_LABEL, [python, script, "run"], logs / "daemon.log", keep_alive=True),
        agent_path(NIGHTLY_LABEL): plist(NIGHTLY_LABEL, [python, script, "nightly"], logs / "nightly.log", keep_alive=False, calendar=(3, 30)),
    }
    commands = []
    for path in files:
        commands.append(f'launchctl bootstrap gui/{uid} "{path}"')
    undo = [f'launchctl bootout gui/{uid}/{DAEMON_LABEL}', f'launchctl bootout gui/{uid}/{NIGHTLY_LABEL}',
            *(f'mv "{path}" "{path}.disabled"' for path in files)]
    return {"files": files, "commands": commands, "undo": undo, "logs": str(logs), "checkout": str(REPO)}


def describe(store_dir: Path) -> str:
    data = plan(store_dir)
    lines = ["LIVE WRITE - nothing below has been run.", f"Checkout the agents will run: {data['checkout']}", "", "1. Write these files:"]
    for path, text in data["files"].items():
        lines += [f"   {path}", "   ---", *("   " + row for row in text.splitlines()), "   ---"]
    lines += ["", "2. Then run:", *("   " + c for c in data["commands"]), "", "To undo (moves the files aside, never deletes):", *("   " + u for u in data["undo"])]
    return "\n".join(lines) + "\n"
