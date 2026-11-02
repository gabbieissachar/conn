#!/usr/bin/env python3
"""Builds a lab copy of the reader for the message-address browser check (message-link-check.js runs this).

  python3 setup/transcript-reader/e2e/message_lab.py <folder>

Under <folder> it makes: a home folder (HOME for everything run there) holding made-up session logs, a copy of this reader's code under
repo/setup/transcript-reader and the organizer module its server requires (its own out/, so the owner's pages and servers are never touched), a Herdr that reports nothing, and the
page built from the logs by that copy's reader.py. No real session log, Herdr, port or pin is read or written.

The world: one conversation that was cleared once (an old session and a new one) whose old part holds a long reply that asks L17, a run
of folded wake-ups with a reply to find inside it, and many later turns; and a second, unrelated conversation. A markdown file the
second names gives the Documents view something to open.

Prints one JSON line: the ids the driver needs.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
READER = HERE.parent
BASE = datetime(2026, 11, 2, 8, 0, 0, tzinfo=timezone.utc).timestamp()

OLD = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
NEW = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
OTHER = "33333333-cccc-4ccc-8ccc-cccccccccccc"

ASK_UID = "a0000010-0000-4000-8000-000000000010"       # the long reply that asks L17, in the old session
FOLDED_UID = "a0000023-0000-4000-8000-000000000023"    # a wake-up's reply inside a folded run, in the old session
LATE_UID = "b0000050-0000-4000-8000-000000000050"      # a reply in the new session
OTHER_UID = "c0000002-0000-4000-8000-000000000002"     # a reply in the other conversation


def iso(second):
    return datetime.fromtimestamp(BASE + second, timezone.utc).isoformat().replace("+00:00", "Z")


def user(uid, text, second, cwd):
    return {"type": "user", "uuid": uid, "timestamp": iso(second), "cwd": cwd, "message": {"role": "user", "content": text}}


def say(text, second, cwd):
    return {"type": "assistant", "timestamp": iso(second), "cwd": cwd, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def wake(uid, second, cwd):
    return user(uid, f"<task-notification>\nsignal: build {second} finished\n</task-notification>", second, cwd)


def uid(prefix, n):
    return f"{prefix}{n:07d}-0000-4000-8000-{n:012d}"


def write_log(path, records, written):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    os.utime(path, (BASE + written, BASE + written))


def main(folder: Path) -> None:
    home = folder / "home"
    cwd = str(home / "fm-homes" / "lab")
    (home / "fm-homes" / "lab").mkdir(parents=True, exist_ok=True)
    (home / "notes").mkdir(parents=True, exist_ok=True)
    (home / "notes" / "plan.md").write_text("# Plan\n\n- ship the lab\n- check the links\n", encoding="utf-8")
    projects = home / ".claude" / "projects" / "lab"

    long_ask = "Captain, a call is needed on the pool-full help.\n\n" + " ".join(f"Context sentence {i} about the pool-full help." for i in range(1, 41)) + "\n\nL17= land the pool-full help? (a) yes (b) hold"
    old = [user(uid("a", 1), "Kick off the lab", 0, cwd), say("Started. Nothing to ask yet.", 1, cwd)]
    for n in range(2, 9):
        old += [user(uid("a", n), f"Question {n} about the lab", n * 10, cwd), say(f"Answer {n}: fine.", n * 10 + 1, cwd)]
    old += [user(ASK_UID, "What needs me?", 100, cwd), say(long_ask, 101, cwd)]
    old += [user(uid("a", 11), "ok, noted", 110, cwd), say("Noted. See `~/notes/plan.md` for the plan.", 111, cwd)]
    # A run of folded wake-ups (a wake-up folds when its reply asks nothing); the reply to find is the fourth of five.
    for n in range(20, 25):
        reply = f"Build {n} finished, nothing to do. Folded wake reply number {n}."
        old += [wake(uid("a", n), 200 + n, cwd), say(reply, 200 + n + 1, cwd)]
    folded = old[-4]["uuid"]  # the fourth wake-up of the five
    assert folded == uid("a", 23), folded
    new = [user("b0000001-0000-4000-8000-000000000001", "<command-name>/clear</command-name>\n<command-message>clear</command-message>", 400, cwd)]
    for n in range(2, 18):
        new += [user(uid("b", n), f"After the clear {n}", 400 + n * 10, cwd), say(f"Reply after the clear {n}: " + " ".join(["words"] * 30), 400 + n * 10 + 1, cwd)]
    new += [user(LATE_UID, "what is waiting?", 700, cwd), say("Reminder: L17= is still open: land the pool-full help.", 701, cwd)]
    other = [user(uid("c", 1), "A different conversation", 0, cwd), say("Hello from the other conversation.", 1, cwd),
             user(OTHER_UID, "anything else?", 10, cwd), say("The plan is in `~/notes/plan.md`.", 11, cwd)]
    write_log(projects / f"{OLD}.jsonl", old, 399 - 30)
    write_log(projects / f"{NEW}.jsonl", new, 800)
    write_log(projects / f"{OTHER}.jsonl", other, 900)

    # The code under test, copied (its out/ is its own), and the herdr that sees nothing.
    code = folder / "repo" / "setup" / "transcript-reader"
    code.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["rsync", "-a", "--exclude", "out", "--exclude", "__pycache__", "--exclude", "e2e", f"{READER}/", f"{code}/"], check=True)
    subprocess.run(["rsync", "-a", "--exclude", "test", "--exclude", "__pycache__", f"{READER.parent / 'herdr-organizer'}/", f"{code.parent / 'herdr-organizer'}/"], check=True)  # the server requires it
    (code / "out").mkdir(exist_ok=True)
    (code / "out" / "sessions.txt").write_text(f"{NEW}\n{OTHER}\n", encoding="utf-8")
    (folder / "bin").mkdir(exist_ok=True)
    herdr = folder / "bin" / "herdr"
    herdr.write_text("#!/bin/sh\necho '{\"sessions\": []}'\n", encoding="utf-8")
    herdr.chmod(herdr.stat().st_mode | stat.S_IEXEC)

    env = {**os.environ, "HOME": str(home), "PMOS_READER_PROJECTS": str(home / ".claude" / "projects"), "PATH": f"{folder / 'bin'}{os.pathsep}{os.environ['PATH']}"}
    done = subprocess.run([sys.executable, str(code / "reader.py"), "rebuild"], capture_output=True, text=True, env=env, cwd=str(folder / "repo"))
    if done.returncode or not (code / "out" / "prototype.html").is_file():
        sys.stderr.write(done.stdout + done.stderr)
        raise SystemExit(done.returncode or 1)
    print(json.dumps({"home": str(home), "repo": str(folder / "repo"), "bin": str(folder / "bin"), "old": OLD, "new": NEW, "other": OTHER,
                      "ask": ASK_UID, "folded": FOLDED_UID, "late": LATE_UID, "other_reply": OTHER_UID}))


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
