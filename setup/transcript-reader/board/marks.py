"""Reply marks: your correction of which replies belong to a task (T1 = b).

A mark is one line of `data/<task-id>/reply-marks.jsonl` in the home that owns the task, written by Firstmate's `bin/fm-reply-mark.sh` (the
reader never writes the file itself). A line is `{"turn": "<session8>:<uid8>:reply|in", "mark": "in|out|clear", "at": <epoch>, "by": "reader|card"}`;
it holds no reply text, and the last line for a turn wins. `read` folds the file; `write` runs the script for one mark, behind a flag that is off by
default (`PMOS_READER_BOARD_MARKS=1`), so a plain reader never changes a Firstmate home.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .collect import TASK_ID, script_env

MAX_BYTES = 256 * 1024
TURN = re.compile(r"^[A-Za-z0-9:._-]{1,80}$")
MARKS = ("in", "out", "clear")
SOURCES = ("reader", "card")
WRITE_TIMEOUT = 30


class MarkError(RuntimeError):
    """A mark could not be written; the message is one plain sentence the page shows."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def marks_path(home: Path, task_id: str) -> Path | None:
    return Path(home) / "data" / task_id / "reply-marks.jsonl" if TASK_ID.match(task_id or "") else None


def read(home: Path, task_id: str) -> dict[str, str]:
    """{turn id: "in" | "out"} after folding the task's mark file (the last line per turn wins; `clear` removes the turn; bad lines are skipped)."""
    path = marks_path(home, task_id)
    if path is None:
        return {}
    try:
        with open(path, "rb") as handle:
            size = handle.seek(0, 2)
            handle.seek(max(0, size - MAX_BYTES))
            lines = handle.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return {}
    folded: dict[str, str] = {}
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        turn, mark = (entry.get("turn"), entry.get("mark")) if isinstance(entry, dict) else (None, None)
        if not isinstance(turn, str) or not TURN.match(turn) or mark not in MARKS:
            continue
        if mark == "clear":
            folded.pop(turn, None)
        else:
            folded[turn] = mark
    return folded


def write(root: Path | None, home: Path, task_id: str, turn: str, mark: str, source: str = "card", runner=None) -> dict:
    """File one mark on a task's record through `bin/fm-reply-mark.sh` with that home's FM_HOME. Returns the line the script printed (parsed)."""
    if not TASK_ID.match(task_id or ""):
        raise MarkError("That is not a task reference.")
    if not TURN.match(turn or ""):
        raise MarkError("That is not a reply reference.")
    if mark not in MARKS or source not in SOURCES:
        raise MarkError("A mark is in, out or clear.")
    script = Path(root) / "bin" / "fm-reply-mark.sh" if root else None
    if script is None or not script.is_file():
        raise MarkError("This Firstmate checkout has no reply-mark command, so nothing was written.", 501)
    run = runner or (lambda argv, env, timeout: subprocess.run(argv, env=env, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL, check=False))
    try:
        done = run([str(script), task_id, mark, turn, "--source", source], script_env(home), WRITE_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise MarkError("Filing the mark took too long; nothing is known to be written.", 504) from None
    except OSError:
        raise MarkError("The mark command could not start.", 502) from None
    if done.returncode != 0:
        reason = (done.stderr or "").strip().splitlines()[-1:] or ["the command refused"]
        raise MarkError("Firstmate did not file the mark: " + reason[0].replace("fm-reply-mark: ", "")[:200], 409)
    try:
        return json.loads((done.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise MarkError("The mark was filed but the command's answer was not readable.", 502) from None
