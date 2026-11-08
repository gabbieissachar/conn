#!/usr/bin/env python3
"""A lab store for the API's tests: synthetic logs in a made-up home, ingested into a store of its own, driven from the command line.

The Node tests (storeapi/*.test.js) run this to get a real store file, in the shape the S1 ingest makes it, without touching the owner's store,
logs or Herdr. It uses the store's own code and its synthetic-log helpers as libraries and changes none of them. Every command prints one JSON line.

  lab_store.py make <dir>                         <dir>/home (made-up logs) and <dir>/store (the store, ingested): the ids of the sessions
  lab_store.py scan <dir>                         one ingest pass over the logs (what the daemon does every few seconds)
  lab_store.py append <dir> <id> user|say <text>  one record at the end of a Claude session's log, stamped now, then one ingest pass
  lab_store.py bind <dir> <herdr> <pane> <id>     a live binding for a pane (a row the identity engine would write), for a lab only
  lab_store.py unbind <dir> <herdr> <pane>
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STORE = HERE.parent / "store"
sys.path.insert(0, str(STORE))
sys.path.insert(0, str(STORE / "tests"))

import synth  # noqa: E402
from rstore import config, db, ingest  # noqa: E402

IDS = {
    "alpha": "a1fa0001-0000-4000-8000-000000000001",   # asks twice; the second ask is still open
    "beta": "b0ba0002-0000-4000-8000-000000000002",    # asks once and was answered
    "gamma": "9a33a003-0000-4000-8000-000000000003",   # has wake-up turns (folded)
    "codex": "c0de0004-0000-4000-8000-000000000004",
    "quiet": "0de70005-0000-4000-8000-000000000005",   # nothing open, never starred, no pane
}


def now() -> float:
    return time.time()


def paths(folder: Path):
    return folder / "home", config.paths(folder / "store")


def connect(folder: Path):
    home, where = paths(folder)
    return home, where, db.connect(where.db)


def write_logs(home: Path) -> None:
    t = now() - 3600
    cwd = "/work/alpha"
    alpha = [synth.c_owner(), synth.c_user("Please look at the reader.", t, cwd=cwd), synth.c_say("Looked. Should I merge it?", t + 10, cwd=cwd),
             synth.c_user("Not yet, check the tests first.", t + 60, cwd=cwd), synth.c_say("Tests pass.\n\nWhich of the two options do you want?\n\n- one\n- two", t + 90, cwd=cwd)]
    synth.write_jsonl(synth.claude_path(home, IDS["alpha"]), alpha)
    beta = [synth.c_owner(), synth.c_user("Start the build.", t + 5, cwd="/work/beta"), synth.c_say("Built. Do you approve the release?", t + 20, cwd="/work/beta"),
            synth.c_user("Yes, go ahead.", t + 70, cwd="/work/beta"), synth.c_say("Released.", t + 80, cwd="/work/beta")]
    synth.write_jsonl(synth.claude_path(home, IDS["beta"], project="-work-beta"), beta)
    gamma = synth.claude_conversation(base=t + 100, n_turns=4, cwd="/work/gamma")
    synth.write_jsonl(synth.claude_path(home, IDS["gamma"], project="-work-gamma"), gamma)
    synth.write_jsonl(synth.codex_path(home, IDS["codex"]), synth.codex_conversation(IDS["codex"], base=t + 200))
    quiet = [synth.c_owner(), synth.c_user("Say hello.", t + 300, cwd="/work/quiet"), synth.c_say("Hello.", t + 305, cwd="/work/quiet")]
    synth.write_jsonl(synth.claude_path(home, IDS["quiet"], project="-work-quiet"), quiet)


def scan(folder: Path) -> dict:
    home, where, conn = connect(folder)
    try:
        ing = ingest.Ingester(conn, config.load_settings(where), home)
        result = ing.scan()
        ing.heartbeat(result)
        return {"files": result.files, "changed": result.changed}
    finally:
        conn.close()


def find_log(home: Path, session: str) -> Path:
    for path in home.rglob(f"{session}.jsonl"):
        return path
    raise SystemExit(f"no log for {session}")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    command, folder = argv[0], Path(argv[1]).resolve()
    if command == "make":
        home = folder / "home"
        home.mkdir(parents=True, exist_ok=True)
        write_logs(home)
        result = scan(folder)
        print(json.dumps({"home": str(home), "store": str(folder / "store"), "ids": IDS, **result}))
    elif command == "scan":
        print(json.dumps(scan(folder)))
    elif command == "append":
        session, kind, text = argv[2], argv[3], " ".join(argv[4:])
        home, _where, _conn = connect(folder)
        _conn.close()
        path = find_log(home, session)
        at = now()
        record = synth.c_user(text, at, cwd="/work/alpha") if kind == "user" else synth.c_say(text, at, cwd="/work/alpha")
        synth.append_jsonl(path, [record])
        print(json.dumps({"appended": kind, "at": at, **scan(folder)}))
    elif command in ("bind", "unbind"):
        herdr, pane = argv[2], argv[3]
        _home, _where, conn = connect(folder)
        try:
            at = now()
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("UPDATE bindings SET valid_to = ?, end_reason = 'lab' WHERE herdr_session = ? AND pane_id = ? AND valid_to IS NULL", (at, herdr, pane))
            if command == "bind":
                session = argv[4]
                conn.execute("INSERT OR IGNORE INTO herdr_lives(herdr_session, life, first_seen, last_seen) VALUES (?, '1', ?, ?)", (herdr, at, at))
                conn.execute("INSERT OR REPLACE INTO panes(herdr_session, life, pane_id, terminal_id, label, agent, agent_status, first_seen, last_seen) VALUES (?, '1', ?, ?, ?, 'claude', 'idle', ?, ?)",
                             (herdr, pane, "term_" + pane, "lab " + pane, at, at))
                conn.execute("INSERT INTO bindings(herdr_session, life, pane_id, session_id, harness, source, valid_from) VALUES (?, '1', ?, ?, 'claude', 'pid_record', ?)", (herdr, pane, session, at))
            conn.execute("COMMIT")
        finally:
            conn.close()
        print(json.dumps({command: pane}))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
