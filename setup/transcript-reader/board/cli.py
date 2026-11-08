"""`board_cli.py` commands (the Node routes run these): print one session's board as JSON, list the sessions, check a home's config, and the two
flagged writes: file a reply mark, record an answer. Reads are read only; a write prints `{"ok": true|false, ...}` and changes a Firstmate home only
through that home's own Firstmate command (marks.py, answer.py)."""

from __future__ import annotations

import argparse
import json
import re
import sys

from . import answer as answer_lib
from . import homes, lifecycles, threads, transcripts, workers
from . import marks as marks_lib
from .build import build_board
from .collect import Collector


SAFE_ID = re.compile(r"[0-9A-Za-z_-]{8,80}")


def thread_source(registry):
    """The reply-thread builder for build_board: reads the store's views read only, and says so plainly when the store is not there."""
    store = registry.store / transcripts.STORE_FILE if registry.store else None

    def build(session, items, now):
        conn = transcripts.open_store(store)
        try:
            worker = session.kind == "worker"
            transcript = transcripts.load(conn, session.transcript_cwds(), now=now, addressed_only=not worker)
        finally:
            conn.close()
        return threads.build(session, items, transcript, now, own_ref=session.task if worker else None)

    return build


def session_for(registry, session_id):
    """A leader or big-boss session, or a worker board (on or off: the page asks for a board it just switched on)."""
    found = registry.get(session_id)
    if found is not None:
        return found
    return next((s for s, _ in workers.worker_sessions(registry, include_off=True) if s.id == session_id), None)


def listing(registry) -> dict:
    sessions = [{**s.public(), "enabled": True} for s in registry.sessions]
    sessions += [{**s.public(), "enabled": on} for s, on in workers.worker_sessions(registry, include_off=True)]
    return {"sessions": sessions, "source": registry.source, "error": registry.error}


def emit(payload: dict) -> int:
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    return 0


def read_stdin() -> dict:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="board_cli.py", description="The Tasks board's data layer. Reads are read only; mark and answer are flagged writes.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (("board", "print one session's board as JSON"), ("check-config", "validate a home's config/task-board.json"),
                            ("mark", "file one reply mark on a task's record (json on stdin: task, turn, mark, source)"),
                            ("answer", "record one answer to a call (json on stdin: task, call, src, option|text|later)"),
                            ("reply", "print the whole text of one reply, read only (json on stdin: sid, uid)")):
        sub.add_parser(name, help=help_text).add_argument("--session", required=True)
    sub.add_parser("sessions", help="list the sessions that have a board, with the workers you drive and whether each is on")
    switch = sub.add_parser("worker-switch", help="turn one worker's board on or off")
    switch.add_argument("--leader", required=True)
    switch.add_argument("--task", required=True)
    switch.add_argument("--state", choices=("on", "off"), required=True)
    args = parser.parse_args(argv)
    registry = homes.load()
    if args.command == "sessions":
        return emit(listing(registry))
    if args.command == "worker-switch":
        try:
            return emit({"ok": True, **workers.set_switch(registry, args.leader, args.task, args.state == "on")})
        except ValueError as error:
            return emit({"ok": False, "status": 404, "message": str(error)})
    session = session_for(registry, args.session)
    if session is None:
        sys.stderr.write(f"no board for session {args.session!r}\n")
        return 2
    if args.command == "check-config":
        _, source = lifecycles.resolve_lifecycle(session.lifecycle, session.home)
        emit(source)
        return 1 if source["error"] else 0
    if args.command == "reply":
        body = read_stdin()
        sid, uid = str(body.get("sid") or ""), str(body.get("uid") or "")
        if not (SAFE_ID.fullmatch(sid) and SAFE_ID.fullmatch(uid)):
            return emit({"ok": False, "status": 400, "message": "Invalid reply."})
        store = registry.store / transcripts.STORE_FILE if registry.store else None
        try:
            conn = transcripts.open_store(store)
            try:
                text = transcripts.fetch_reply(conn, session.transcript_cwds(), sid, uid)
            finally:
                conn.close()
        except transcripts.StoreUnavailable as error:
            return emit({"ok": False, "status": 503, "message": str(error)})
        if text is None:
            return emit({"ok": False, "status": 404, "message": "That reply is not in the conversations this board reads."})
        return emit({"ok": True, "md": text, "words": threads.word_count(text)})
    if args.command in ("mark", "answer"):
        body = read_stdin()
        root = session.root or registry.fm_root
        try:
            if args.command == "mark":
                done = marks_lib.write(root, session.home, body.get("task"), body.get("turn"), body.get("mark"), body.get("source") or "card")
                return emit({"ok": True, "mark": done})
            return emit({"ok": True, "answer": answer_lib.answer(session, root, body)})
        except (marks_lib.MarkError, answer_lib.AnswerError) as error:
            return emit({"ok": False, "status": error.status, "message": str(error)})
    collector = Collector(registry.fm_root)
    board = build_board(session, collector, threads=thread_source(registry))
    if registry.error:
        board["source"]["errors"].append(registry.error)
    return emit(board)


if __name__ == "__main__":
    sys.exit(main())
