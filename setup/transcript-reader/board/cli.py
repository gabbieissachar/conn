"""`board_cli.py` commands: print one session's board as JSON (the Node route runs this), list the sessions, check a home's config."""

from __future__ import annotations

import argparse
import json
import sys

from . import homes, lifecycles
from .build import build_board
from .collect import Collector


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="board_cli.py", description="The Tasks board's data layer (read-only).")
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("board", help="print one session's board as JSON")
    build.add_argument("--session", required=True)
    sub.add_parser("sessions", help="list the sessions that have a board")
    check = sub.add_parser("check-config", help="validate a home's config/task-board.json")
    check.add_argument("--session", required=True)
    args = parser.parse_args(argv)
    registry = homes.load()
    if args.command == "sessions":
        json.dump({"sessions": [s.public() for s in registry.sessions], "source": registry.source, "error": registry.error}, sys.stdout)
        sys.stdout.write("\n")
        return 0
    session = registry.get(args.session)
    if session is None:
        sys.stderr.write(f"no board for session {args.session!r}\n")
        return 2
    if args.command == "check-config":
        _, source = lifecycles.resolve_lifecycle(session.lifecycle, session.home)
        json.dump(source, sys.stdout)
        sys.stdout.write("\n")
        return 1 if source["error"] else 0
    collector = Collector(registry.fm_root)
    board = build_board(session, collector)
    if registry.error:
        board["source"]["errors"].append(registry.error)
    json.dump(board, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
