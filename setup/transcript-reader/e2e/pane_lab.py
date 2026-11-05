#!/usr/bin/env python3
"""Builds a lab copy of the reader with a Herdr that runs several agent panes, for the browser checks of picking a session and of a /clear
(session-pick-check.js and clear-reconnect-check.js run this).

  python3 setup/transcript-reader/e2e/pane_lab.py <folder>

Under <folder> it makes a home folder (HOME for everything run there) holding made-up session logs, a copy of this reader's code with its own
out/ (so the owner's pages, servers and reading list are never touched), a fake Herdr (fake-herdr-world.js, whose world is <folder>/world.json),
and the page built from the logs by that copy's reader.py. No real session log, Herdr, port or pane is read, written or sent to.

The world is the shape that went wrong on the owner's machine: panes of three kinds of agent in one Herdr session, several of them
reported by Herdr WITHOUT a session id, two of those in one working folder.

  tab "cp-ontology-learning"        a Copilot CLI pane          (no Herdr session id; the process log names the session)
  tab "cp-ontology-search"          Claude under another config folder (~/.claude-personal; no id), and a shell pane beside it
  tab "cp-whatapps-tool"            Claude under ~/.claude, the same working folder as the one above (no id); its latest reply is a
                                    keyed-answer reply with a Key | Call | Recommended table (answer-sheet-fixtures/)
  tab "fm-adjoe-wrong-trip-split-fix"  a Codex pane             (no id; mapped by its working folder)
  tabs "crew-1" .. "crew-8"         Claude panes whose session id Herdr does know

Every agent process is a `sleep` the lab starts (its pid goes in the records the reader reads, so it counts as alive); the driver stops them.
Replies are timed so the four panes above sit in the middle of the picker, and crew-8 is the oldest, last in the list.

LAB_FILLERS=<n> adds n more listed conversations without a pane, and LAB_BIG_EXCHANGES=<n> makes each crew conversation n exchanges long, so a
check can run at the size of the owner's reading list (about 90 conversations, the biggest about 900 exchanges).

Prints one JSON line: what the driver needs.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
READER = HERE.parent
NOW = time.time()

COPILOT = "c0c0c0c0-0001-4000-8000-000000000001"
SEARCH = "5ea5c500-0002-4000-8000-000000000002"   # Claude under ~/.claude-personal
TOOL = "700100aa-0003-4000-8000-000000000003"      # Claude under ~/.claude, same folder as SEARCH
CODEX = "c0de0000-0004-4000-8000-000000000004"
CREW = [f"c4e70000-{n:04d}-4000-8000-{n:012d}" for n in range(1, 9)]

KEYED_REPLY = READER / "answer-sheet-fixtures" / "key-call-recommended-table.md"
WORK = "/lab/personal-work"
SPLIT = "/lab/split-fix"


def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat().replace("+00:00", "Z")


def claude_log(path, name, minutes_ago, cwd, latest=None, exchanges=2):
    """A Claude Code session log with `exchanges` exchanges (two by default) whose last reply is `minutes_ago` old (`latest` is that reply's text, when given)."""
    at = NOW - minutes_ago * 60
    earlier = []
    for n in range(exchanges - 2):
        base = at - 3600 - (exchanges - n) * 30
        earlier += [
            {"type": "user", "uuid": f"u-{name}-e{n}", "timestamp": iso(base), "cwd": cwd, "message": {"role": "user", "content": f"Earlier question {n} in {name}"}},
            {"type": "assistant", "timestamp": iso(base + 10), "cwd": cwd, "message": {"role": "assistant", "content": [{"type": "text", "text": f"Earlier answer {n} in {name}. " + "A sentence of the answer. " * 20}]}},
        ]
    records = earlier + [
        {"type": "user", "uuid": f"u-{name}-1", "timestamp": iso(at - 20), "cwd": cwd, "message": {"role": "user", "content": f"First question in {name}"}},
        {"type": "assistant", "timestamp": iso(at - 15), "cwd": cwd, "message": {"role": "assistant", "content": [{"type": "text", "text": f"First answer in {name}."}]}},
        {"type": "user", "uuid": f"u-{name}-2", "timestamp": iso(at - 10), "cwd": cwd, "message": {"role": "user", "content": f"Second question in {name}"}},
        {"type": "assistant", "timestamp": iso(at), "cwd": cwd, "message": {"role": "assistant", "content": [{"type": "text", "text": latest or f"Latest answer in {name}."}]}},
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    os.utime(path, (at, at))


def copilot_session(home, sid, minutes_ago, cwd):
    at = NOW - minutes_ago * 60
    stamp = lambda s: iso(at + s)
    records = [
        {"type": "session.start", "id": "e1", "parentId": None, "timestamp": stamp(-20), "data": {"sessionId": sid, "version": 1, "producer": "copilot-agent", "context": {"cwd": cwd}}},
        {"type": "user.message", "id": "e2", "parentId": None, "timestamp": stamp(-10), "data": {"content": "Question in the copilot pane", "transformedContent": "x\n\nQuestion in the copilot pane", "messageId": "00000010-0000-4000-8000-000000000000", "delivery": "idle", "attachments": []}},
        {"type": "assistant.message", "id": "e3", "parentId": None, "timestamp": stamp(0), "data": {"messageId": "a-1", "model": "m", "content": "Answer in the copilot pane.", "toolRequests": [], "turnId": "0", "phase": "final_answer"}},
    ]
    folder = home / ".copilot" / "session-state" / sid
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "events.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    os.utime(folder / "events.jsonl", (at, at))


def codex_rollout(home, sid, minutes_ago, cwd):
    at = NOW - minutes_ago * 60
    message = lambda role, kind, text, s: {"type": "response_item", "timestamp": iso(at + s), "payload": {"type": "message", "role": role, "content": [{"type": kind, "text": text}]}}
    records = [
        {"type": "session_meta", "timestamp": iso(at - 20), "payload": {"id": sid, "session_id": sid, "cwd": cwd, "source": "cli"}},
        message("user", "input_text", "Question in the codex pane", -10),
        message("assistant", "output_text", "Answer in the codex pane.", 0),
    ]
    folder = home / ".codex" / "sessions" / "2026" / "11" / "05"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"rollout-2026-11-05T10-00-00-{sid}.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    os.utime(path, (at, at))


def sleeper():
    """A process the reader can see is alive; the driver stops it."""
    return subprocess.Popen(["sleep", "6000"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True).pid


def main(folder: Path) -> None:
    home = folder / "home"
    # The working folders need not exist: the reader reads the cwd a log records.
    primary, personal = home / ".claude", home / ".claude-personal"
    pids = {}

    def record(config, pid, sid):
        folder_ = config / "sessions"
        folder_.mkdir(parents=True, exist_ok=True)
        (folder_ / f"{pid}.json").write_text(json.dumps({"pid": pid, "sessionId": sid, "cwd": "/lab", "startedAt": int(NOW * 1000)}), encoding="utf-8")

    # The four sessions the owner was picking between, in the middle of the list.
    claude_log(personal / "projects" / "-lab-personal-work" / f"{SEARCH}.jsonl", "search", 30, WORK)
    pids["search"] = sleeper(); record(personal, pids["search"], SEARCH)
    # The tool pane's latest reply is a keyed-answer reply in the shape an owner flagged (invented text, kept as a parser fixture too).
    claude_log(primary / "projects" / "-lab-personal-work" / f"{TOOL}.jsonl", "tool", 40, WORK, latest=KEYED_REPLY.read_text(encoding="utf-8"))
    pids["tool"] = sleeper(); record(primary, pids["tool"], TOOL)
    copilot_session(home, COPILOT, 20, WORK)
    pids["copilot"] = sleeper()
    started = int(NOW * 1000) - 60000
    logs = home / ".copilot" / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    (logs / f"process-{started}-{pids['copilot']}.log").write_text(f"{iso(NOW - 3000)} [INFO] Registering foreground session: {COPILOT}\n", encoding="utf-8")
    codex_rollout(home, CODEX, 25, SPLIT)
    pids["codex"] = sleeper()
    # The crew: three newer than the four above, five older.
    ages = [5, 10, 15, 60, 70, 80, 90, 100]
    big = int(os.environ.get("LAB_BIG_EXCHANGES", "2"))  # exchanges in each crew conversation (a real leader's runs to about 900)
    for n, sid in enumerate(CREW):
        cwd = f"/lab/crew-{n + 1}"
        claude_log(primary / "projects" / f"-lab-crew-{n + 1}" / f"{sid}.jsonl", f"crew-{n + 1}", ages[n], cwd, exchanges=big)
        pids[f"crew-{n + 1}"] = sleeper(); record(primary, pids[f"crew-{n + 1}"], sid)

    tabs = [{"tab_id": "w1:t1", "label": "cp-ontology-learning"}, {"tab_id": "w1:t2", "label": "cp-ontology-search"}, {"tab_id": "w1:t3", "label": "cp-whatapps-tool"},
            {"tab_id": "w1:t4", "label": "fm-adjoe-wrong-trip-split-fix"}] + [{"tab_id": f"w1:t{n + 4}", "label": f"crew-{n}"} for n in range(1, 9)]
    panes = [
        {"pane_id": "w1:p1", "tab_id": "w1:t1", "agent": "copilot", "agent_status": "idle", "agent_session": None, "title": "Teach me the concepts", "cwd": WORK,
         "process": [{"pid": pids["copilot"], "argv0": "copilot", "cwd": WORK}]},
        {"pane_id": "w1:p2", "tab_id": "w1:t2", "agent": "claude", "agent_status": "idle", "agent_session": None, "title": "Ontology lesson materials", "cwd": WORK,
         "process": [{"pid": pids["search"], "argv0": "claude", "cwd": WORK}]},
        {"pane_id": "w1:p3", "tab_id": "w1:t2", "agent": None, "title": None, "cwd": "/lab/skills", "process": [{"pid": 1, "argv0": "zsh"}]},
        {"pane_id": "w1:p4", "tab_id": "w1:t3", "agent": "claude", "agent_status": "idle", "agent_session": None, "title": "WhatsApp group content manager", "cwd": WORK,
         "process": [{"pid": pids["tool"], "argv0": "claude", "cwd": WORK}]},
        {"pane_id": "w2:p2", "tab_id": "w1:t4", "agent": "codex", "agent_status": "idle", "agent_session": None, "title": "Handle Firstmate operational input", "cwd": SPLIT,
         "process": [{"pid": pids["codex"], "argv0": "codex", "cwd": SPLIT}]},
    ]
    for n, sid in enumerate(CREW, start=1):
        panes.append({"pane_id": f"w3:p{n}", "tab_id": f"w1:t{n + 4}", "agent": "claude", "agent_status": "idle", "agent_session": sid, "title": f"Crew {n} work", "cwd": f"/lab/crew-{n}",
                      "process": [{"pid": pids[f"crew-{n}"], "argv0": "claude", "cwd": f"/lab/crew-{n}"}]})
    world = {"sessions": [{"name": "esim", "focused": "w1:p1", "tabs": tabs, "panes": panes}]}
    (folder / "world.json").write_text(json.dumps(world, indent=1), encoding="utf-8")

    # The code under test, copied (its out/ is its own), and the Herdr that shows the world above.
    code = folder / "repo" / "setup" / "transcript-reader"
    code.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["rsync", "-a", "--exclude", "out", "--exclude", "__pycache__", "--exclude", "e2e", f"{READER}/", f"{code}/"], check=True)
    subprocess.run(["rsync", "-a", "--exclude", "test", "--exclude", "__pycache__", f"{READER.parent / 'herdr-organizer'}/", f"{code.parent / 'herdr-organizer'}/"], check=True)
    (code / "out").mkdir(exist_ok=True)
    # LAB_FILLERS other listed conversations with no pane, as the owner's reading list has dozens: each its own project folder and log.
    fillers = []
    for n in range(int(os.environ.get("LAB_FILLERS", "0"))):
        sid = f"f111e700-{n:04d}-4000-8000-{n:012d}"
        claude_log(primary / "projects" / f"-lab-filler-{n}" / f"{sid}.jsonl", f"filler-{n}", 200 + n, f"/lab/filler-{n}", exchanges=max(2, big // 4))
        fillers.append(sid)
    listed = [COPILOT, SEARCH, TOOL, CODEX, *CREW, *fillers]
    (code / "out" / "sessions.txt").write_text("".join(f"{sid}\n" for sid in listed), encoding="utf-8")
    (folder / "bin").mkdir(exist_ok=True)
    herdr = folder / "bin" / "herdr"
    herdr.write_text(f"#!/bin/sh\nFAKE_HERDR_WORLD={folder / 'world.json'} FAKE_HERDR_LOG={folder / 'herdr.log'} FAKE_HERDR_DIR={folder} exec node {HERE / 'fake-herdr-world.js'} \"$@\"\n", encoding="utf-8")
    herdr.chmod(herdr.stat().st_mode | stat.S_IEXEC)

    env = {**os.environ, "HOME": str(home), "PATH": f"{folder / 'bin'}{os.pathsep}{os.environ['PATH']}"}
    env.pop("PMOS_READER_PROJECTS", None)
    done = subprocess.run([sys.executable, str(code / "reader.py"), "rebuild"], capture_output=True, text=True, env=env, cwd=str(folder / "repo"))
    if done.returncode or not (code / "out" / "prototype.html").is_file():
        sys.stderr.write(done.stdout + done.stderr)
        raise SystemExit(done.returncode or 1)
    print(json.dumps({"home": str(home), "repo": str(folder / "repo"), "bin": str(folder / "bin"), "world": str(folder / "world.json"), "log": str(folder / "herdr.log"),
                      "pids": pids, "copilot": COPILOT, "search": SEARCH, "tool": TOOL, "codex": CODEX, "crew": CREW, "work": WORK}))


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
