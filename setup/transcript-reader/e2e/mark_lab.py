#!/usr/bin/env python3
"""The turn menu's browser lab (task-mark-check.js): a board config over the pane lab's leader home (pane_lab.py with LAB_LEADER=1) and a stand-in for Firstmate's
`bin/fm-reply-mark.sh`, so a mark made from the conversation reaches a real file the check can read. Nothing real is read or written: the home is the lab's made-up one.

  python3 setup/transcript-reader/e2e/mark_lab.py <folder> <pane lab home>      prints one JSON line: the board config, its cache, the stand-in's folder

The stand-in has the real command's arguments, its refusals and its one line (`{"turn", "mark", "at", "by"}` appended to data/<task>/reply-marks.jsonl): the task must be in
the home's backlog (else it exits 1 with the real command's sentence), the supervision branch is not modelled. A number of seconds in bin/delay makes it as slow as the real one (1.4 to
1.8 s measured), and bin/calls.log records each call, so the check can count them (the command's environment is the board's small one, so neither is a variable).
"""
import json
import stat
import sys
from pathlib import Path

folder = Path(sys.argv[1]); home = Path(sys.argv[2]) / "fm-leader"
fm = folder / "fm"; (fm / "bin").mkdir(parents=True, exist_ok=True)
(fm / "bin" / "fm-fleet-snapshot.sh").write_text("#!/bin/sh\necho '{}'\n", encoding="utf-8")
mark = fm / "bin" / "fm-reply-mark.sh"
mark.write_text(r'''#!/usr/bin/env bash
# A stand-in for Firstmate's fm-reply-mark.sh (the lab's): same arguments and the same line.
set -u
[ "$#" -eq 5 ] || { echo "usage: fm-reply-mark.sh <task-id> in|out|clear <turn> --source reader|card" >&2; exit 2; }
ID=$1 MARK=$2 TURN=$3 BY=$5
DATA="${FM_HOME:?}/data"
HERE=$(cd "$(dirname "$0")" && pwd)
printf '%s %s %s %s\n' "$ID" "$MARK" "$TURN" "$BY" >> "$HERE/calls.log"
[ -f "$HERE/delay" ] && sleep "$(cat "$HERE/delay")"
grep -q -- "^- \[.\] ${ID} - " "$DATA/backlog.md" || { echo "fm-reply-mark: task '${ID}' is not in this home's backlog" >&2; exit 1; }
mkdir -p "$DATA/$ID"
LINE=$(printf '{"turn":"%s","mark":"%s","at":%s,"by":"%s"}' "$TURN" "$MARK" "$(date +%s)" "$BY")
printf '%s\n' "$LINE" >> "$DATA/$ID/reply-marks.jsonl"
printf '%s\n' "$LINE"
''', encoding="utf-8")
mark.chmod(mark.stat().st_mode | stat.S_IEXEC)
(fm / "bin" / "fm-fleet-snapshot.sh").chmod(0o755)
(folder / "cache").mkdir(exist_ok=True); (folder / "conf").mkdir(exist_ok=True); (folder / "store").mkdir(exist_ok=True)
(folder / "board.json").write_text(json.dumps({"fm_root": str(fm), "store": str(folder / "store"), "sessions": [
    {"id": "leader-lab", "label": "Lab", "home": str(home), "lifecycle": "software", "cwds": [str(home)]}]}))
print(json.dumps({"config": str(folder / "board.json"), "cache": str(folder / "cache"), "conf": str(folder / "conf"), "fm": str(fm), "home": str(home)}))
