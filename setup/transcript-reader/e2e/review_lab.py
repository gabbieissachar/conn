#!/usr/bin/env python3
"""The review browser lab (review-check.js): one scratch Firstmate home whose tasks are each in a state a review action must treat differently, and the
board config over it. Everything is made in the folder given as argv[1] (use a fresh one); nothing real is read or written: no real home, store, pane or
session. Prints one JSON line. Needs a Firstmate checkout with the backlog and ask commands (FM_ROOT, or the installed fm-ask link); exits 3 without.

  rv-queued     queued, nobody on it, no hold        -> every action works except Queued ("already queued")
  rv-held       held for you with one prose call     -> done and queue go through the keyed answer intake
  rv-card       held for you with a typed card (Z1)  -> every move is refused until the card is answered
  rv-live       in flight with a worker record       -> done, delay and needs-you are refused (a worker has it)
  rv-ready      in flight, its branch ready, not landed (a real clone with a commit main lacks) -> done is refused
  rv-draft      in flight, no worker record (a PM draft)  -> done works
  rv-finished   done a day ago                       -> Queued (reopen) works, Done is "already done"
"""
import json, subprocess, sys, time
from pathlib import Path
R = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, R)
from board import homes
from board.collect import script_env

tmp = Path(sys.argv[1]); home = tmp / "home"
FM = homes.find_fm_root()
if FM is None or not all((FM / "bin" / n).is_file() for n in ("fm-captain-ask.sh", "fm-captain-hold.sh", "fm-tasks-axi.sh")):
    print("no Firstmate checkout with the backlog and ask commands", file=sys.stderr); sys.exit(3)
for sub in ("data", "state", "projects", "config"):
    (home / sub).mkdir(parents=True)
today = time.strftime("%Y-%m-%d"); yesterday = time.strftime("%Y-%m-%d", time.localtime(time.time() - 86400))
(home / "data" / "backlog.md").write_text(
    "## In flight\n"
    f"- [ ] rv-live - A worker is on this (repo: proj) (kind: ship) (since {yesterday})\n"
    f"- [ ] rv-ready - Branch ready, not landed (repo: proj) (kind: ship) (since {yesterday})\n"
    f"- [ ] rv-draft - A draft nobody is working on (repo: proj) (kind: scout) (since {yesterday})\n\n"
    "## Queued\n"
    f"- [ ] rv-queued - A plain queued job (repo: proj) (kind: scout) (since {yesterday})\n"
    f"- [ ] rv-held - Pick the venue (repo: proj) (kind: scout) (since {yesterday})\n"
    f"- [ ] rv-card - Pick the route (repo: proj) (kind: scout) (since {yesterday})\n\n"
    f"## Done\n- [x] rv-finished - Finished yesterday (repo: proj) (kind: scout) (since {yesterday}) (done {yesterday})\n")
now = int(time.time())
(home / "state" / "rv-live.status").write_text("working [at=%d]: building\n" % (now - 600))
(home / "state" / "rv-live.meta").write_text("kind=ship\nproject=%s\nbranch=fm/rv-live\nspawn_gen=s%d.1.1\n" % (home / "projects" / "proj", now - 3000))
(home / "state" / "rv-ready.status").write_text("working [at=%d]: building\ndone [at=%d]: ready in branch fm/rv-ready\n" % (now - 3000, now - 900))
(home / "state" / "rv-ready.meta").write_text("kind=ship\nproject=%s\nbranch=fm/rv-ready\nspawn_gen=s%d.1.1\n" % (home / "projects" / "proj", now - 5000))
(home / "state" / "rv-draft.status").write_text("working [at=%d]: drafting\n" % (now - 4000))
repo = home / "projects" / "proj"; repo.mkdir()
git = lambda *a: subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", *a], check=True, capture_output=True)
git("init", "-q", "-b", "main"); (repo / "f.txt").write_text("1\n"); git("add", "."); git("commit", "-q", "-m", "base")
git("checkout", "-q", "-b", "fm/rv-ready"); (repo / "f.txt").write_text("2\n"); git("commit", "-q", "-am", "work"); git("checkout", "-q", "main")
env = script_env(home)
def fm(name, *args, stdin=None):
    r = subprocess.run([str(FM / "bin" / name), *args], env=env, input=stdin, capture_output=True, text=True, timeout=120)
    if r.returncode: print("FM FAIL", name, args, r.stderr, file=sys.stderr); sys.exit(1)
    return r.stdout
fm("fm-captain-hold.sh", "hold", "rv-held", "--reason", "Pick the venue: a the office / b the cafe")
fm("fm-captain-hold.sh", "hold", "rv-card", "--reason", "Pick the route")
fm("fm-captain-ask.sh", "open", "--title", "Route", "--gate", "Z1=rv-card", stdin="Z1 | Which route?* | the shared plugin | a fresh repo\n")
(tmp / "store").mkdir(); (tmp / "cache").mkdir(); (tmp / "conf").mkdir(); (tmp / "out").mkdir()
(tmp / "board.json").write_text(json.dumps({"fm_root": str(FM), "store": str(tmp / "store"), "sessions": [{"id": "leader-lab", "label": "Lab", "home": str(home), "lifecycle": "software", "cwds": ["/lab/none"]}]}))
print(json.dumps({"home": str(home), "config": str(tmp / "board.json"), "cache": str(tmp / "cache"), "conf": str(tmp / "conf"), "out": str(tmp / "out"), "hidden": str(tmp / "hidden.json"), "backlog": str(home / "data" / "backlog.md"), "fm": str(FM)}))
