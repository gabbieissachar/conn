"""Reads of files the reader was only told about, bounded in time.

A markdown file a reply names is opened to show its text on the page. Where that file is, the system may not answer: macOS holds Downloads and
Desktop behind a permission dialog for the app a process runs under, and while nobody has answered it every open there waits, for good; a cloud
folder whose app is not running does the same. One such open stopped every rebuild of the reader (the page stayed as it was for hours, and the
server ended each attempt after a minute and tried the same read again). So the read is made by a helper thread that is given a few seconds. A
read that does not answer in time is given up as an unreadable file (the document is left out, as for any file that cannot be read), and the folder
is not asked again for a while, so the build goes on at its own pace instead of waiting once for each file in it. The helper thread stays where it
is, ends by itself if the open ever comes back, and a new one serves the next read.

`held()` names the folders being left alone now. A kept conversation (build_cache.py) is derived again when that changes, so a file left out is read
again once its folder has had its time, and the page never keeps a document out for good.
"""

import os
import queue
import threading
import time
from pathlib import Path

DEADLINE_S = 3.0      # how long one read may take before it is given up
HOLD_S = 300.0        # how long a folder is left alone after a read in it did not answer
# macOS asks for each of these folders on its own (a permission dialog per folder and app), so one that does not answer holds all that is under it.
PROTECTED = ("Desktop", "Documents", "Downloads")

clock = time.monotonic   # a test sets its own
_lock = threading.Lock()
_held: dict[str, float] = {}   # folder -> when a read in it did not answer
_helper: "_Helper | None" = None


class _Helper:
    """One thread that reads the files it is asked for, one at a time."""

    def __init__(self) -> None:
        self.jobs: queue.SimpleQueue = queue.SimpleQueue()
        threading.Thread(target=self._run, name="bounded-read", daemon=True).start()

    def _run(self) -> None:
        while True:
            job = self.jobs.get()
            if job is None:
                return
            path, answer, done = job
            try:
                answer.append((True, path.read_text(encoding="utf-8", errors="replace")))
            except BaseException as error:  # handed to the caller, which raises it
                answer.append((False, error))
            done.set()

    def read(self, path: Path, deadline: float) -> str | None:
        """The file's text, or None when it did not answer within <deadline>; the file's own error is raised."""
        answer: list = []
        done = threading.Event()
        self.jobs.put((path, answer, done))
        if not done.wait(deadline):
            return None
        ok, value = answer[0]
        if ok:
            return value
        raise value

    def retire(self) -> None:
        self.jobs.put(None)  # it ends when (if) its read comes back


def _folder_for(path: Path) -> str:
    """The folder a file that did not answer holds: the protected folder of the home it is under, else the folder it is in."""
    try:
        home = Path.home()
        parts = path.relative_to(home).parts
        if len(parts) > 1 and parts[0] in PROTECTED:
            return str(home / parts[0])
    except ValueError:
        pass
    return str(path.parent)


def _prune(now: float) -> None:
    for folder in [folder for folder, since in _held.items() if now - since >= HOLD_S]:
        del _held[folder]


def held() -> tuple[str, ...]:
    """The folders left alone now, sorted. It changes when one is taken up or its time is over (a kept conversation is built again then)."""
    with _lock:
        _prune(clock())
        return tuple(sorted(_held))


def _is_held(path: Path) -> bool:
    name = str(path)
    return any(name == folder or name.startswith(folder + os.sep) for folder in _held)


def read_text(path: Path, deadline: float | None = None) -> str:
    """The text of <path> (UTF-8, undecodable bytes replaced), as Path.read_text gives it; its OSError is raised as it is.

    Raises TimeoutError (an OSError, so a caller that leaves out a file it cannot read leaves this one out too) when the read did not
    answer within <deadline> seconds (DEADLINE_S), or at once when a read in the same folder did not answer lately (HOLD_S).
    """
    global _helper
    wait = DEADLINE_S if deadline is None else deadline
    with _lock:
        _prune(clock())
        if _is_held(path):
            raise TimeoutError(f"{path}: the folder did not answer lately")
        helper = _helper = _helper or _Helper()
    text = helper.read(path, wait)
    if text is not None:
        return text
    with _lock:
        _held[_folder_for(path)] = clock()
        if _helper is helper:
            _helper = None
        helper.retire()
    raise TimeoutError(f"{path}: no answer within {wait:g} s")
