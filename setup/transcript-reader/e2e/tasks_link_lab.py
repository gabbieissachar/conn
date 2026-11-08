#!/usr/bin/env python3
"""The Tasks link's browser lab (tasks-link-check.js): boards over the conversations of a pane lab (pane_lab.py).

  python3 setup/transcript-reader/e2e/tasks_link_lab.py <folder> <pane lab home>

Reads the made-up session logs of the pane lab's home into a lab store (the S1 ingest, in <folder>/store), makes two scratch Firstmate homes with a
little backlog each, and writes a board config (<folder>/board.json) of two boards over those conversations: "leader-lab" reads /lab/crew-1 and
/lab/crew-2, "leader-other" reads /lab/crew-3. Nothing real is read or written: no real log, store, home or pane. Prints one JSON line.
Needs a Firstmate checkout (FM_ROOT, or the installed fm-ask link); exits 3 when there is none."""
import json, os, sys, time
from datetime import datetime, timezone
from pathlib import Path
R = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, R); sys.path.insert(0, R + "/store")
from board import homes
from rstore import config, db, ingest

folder = Path(sys.argv[1]); pane_home = Path(sys.argv[2])
fm = homes.find_fm_root()
if fm is None:
    print("no Firstmate checkout", file=sys.stderr); sys.exit(3)
folder.mkdir(parents=True, exist_ok=True)
# A board reads a supervisor's conversation once it has three replies that start with your name: give crew-1 and crew-3 of the pane lab three each (the
# reader page, built before this, is not told: only the board's reading of the store is what the Tasks link asks about).
def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat().replace("+00:00", "Z")
for n in (1, 3):
    log = next((pane_home / ".claude" / "projects").glob(f"-lab-crew-{n}/*.jsonl"))
    cwd = f"/lab/crew-{n}"
    records = []
    for i in range(3):
        at = time.time() - 3600 + i * 600
        records.append({"type": "user", "uuid": f"u-board-{n}-{i}", "timestamp": iso(at), "cwd": cwd, "message": {"role": "user", "content": f"What is open, round {i}?"}})
        records.append({"type": "assistant", "timestamp": iso(at + 20), "cwd": cwd, "message": {"role": "assistant", "content": [{"type": "text", "text": f"Nathan, the board has nothing for you in round {i}, shipshape."}]}})
    with log.open("a", encoding="utf-8") as out:
        for record in records:
            out.write(json.dumps(record) + "\n")
store = folder / "store"
conn = db.connect(config.paths(store).db)
ingest.Ingester(conn, config.Settings(), pane_home).scan()
conn.close()
sessions = []
for sid, label, cwds in (("leader-lab", "Lab", ["/lab/crew-1", "/lab/crew-2"]), ("leader-other", "Other", ["/lab/crew-3"])):
    home = folder / ("home-" + sid)
    for sub in ("data", "state", "projects", "config"):
        (home / sub).mkdir(parents=True, exist_ok=True)
    (home / "data" / "backlog.md").write_text(
        "## In flight\n- [ ] %s-task - A task of the %s board (repo: proj) (kind: ship) (since %s)\n\n## Queued\n\n## Done\n" % (sid, label, time.strftime("%Y-%m-%d")))
    sessions.append({"id": sid, "label": label, "home": str(home), "lifecycle": "software", "cwds": cwds})
(folder / "board.json").write_text(json.dumps({"fm_root": str(fm), "store": str(store), "sessions": sessions}))
(folder / "cache").mkdir(exist_ok=True); (folder / "conf").mkdir(exist_ok=True)
print(json.dumps({"config": str(folder / "board.json"), "cache": str(folder / "cache"), "conf": str(folder / "conf"), "store": str(store)}))
