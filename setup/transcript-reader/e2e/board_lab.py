"""The Tasks board's browser lab (board-check.js): a scratch Firstmate home with held tasks, a typed ask and a status question, a lab store with supervisor
replies about them (the S1 ingest over synthetic logs), and the reader's board config pointing at both. Everything is made in the folder given as argv[1]
(use a fresh one); nothing real is read or written. Prints one JSON line: the home, the config file and the folders the server needs in its environment.
Needs a Firstmate checkout with typed ask records (FM_ROOT, or the installed fm-ask link); exits 3 when there is none."""
import json, os, stat, subprocess, sys, time
from pathlib import Path
R = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, R + "/board/tests"); sys.path.insert(0, R)
from board import homes
from labstore import Lab
tmp = Path(sys.argv[1]); home = tmp / "home"
FM = homes.find_fm_root()
if FM is None or not (FM / "bin" / "fm-captain-ask.sh").is_file():
    print("no Firstmate checkout with typed ask records", file=sys.stderr); sys.exit(3)
for sub in ("data", "state", "projects", "config"):
    (home / sub).mkdir(parents=True)
(home / "data" / "backlog.md").write_text(
    "## In flight\n"
    "- [ ] alpha-route - Pick the route for the alpha work (repo: proj) (kind: ship) (since 2026-11-06)\n"
    "- [ ] epsilon-figma - Figma access for the teaching files (repo: proj) (kind: scout) (since 2026-11-05)\n"
    "- [ ] zeta-lesson - Lesson six draft (repo: proj) (kind: scout) (since 2026-11-04)\n\n"
    "## Queued\n"
    "- [ ] gamma-later - Run the later job (repo: proj) (kind: scout) (since 2026-11-05)\n"
    "- [ ] delta-two-calls - Two prose calls in one hold (repo: proj) (kind: ship) (since 2026-11-05)\n\n## Done\n")
(home / "state" / "epsilon-figma.status").write_text("working [at=%d]: reading the files\nneeds-decision [key=figma-access] [at=%d]: standing by for a Figma access decision, share the file or skip it\n" % (time.time() - 7200, time.time() - 3600))
(home / "state" / "zeta-lesson.status").write_text("working [at=%d]: drafting\ndone [at=%d]: lesson six draft ready in data/zeta-lesson/report.md\n" % (time.time() - 90000, time.time() - 80000))
(home / "data" / "zeta-lesson").mkdir()
(home / "data" / "zeta-lesson" / "report.md").write_text("# Lesson six\n\n## Short answer\n\nLesson six is drafted and reads in about ten minutes.\n")
from board.collect import script_env
env = script_env(home)
def fm(name, *args, stdin=None):
    r = subprocess.run([str(FM / "bin" / name), *args], env=env, input=stdin, capture_output=True, text=True, timeout=120)
    if r.returncode: print("FM FAIL", name, args, r.stderr); sys.exit(1)
    return r.stdout
fm("fm-captain-hold.sh", "hold", "alpha-route", "--reason", "Pick the route")
fm("fm-captain-ask.sh", "open", "--title", "Route for alpha", "--gate", "Z1=alpha-route", stdin="Z1 | Which route should alpha take? | the shared plugin* -- recommended | a fresh repo | skip it\n")
fm("fm-captain-hold.sh", "hold", "gamma-later", "--reason", "Dispatch only on Nathan's word")
fm("fm-captain-hold.sh", "hold", "delta-two-calls", "--reason", "R1 pick the first thing: a yes (recommended) / b no. R2 pick the second thing: a left / b right (recommended)")
hold_at = time.time()
lab = Lab()
cwd = "/lab/homes/esim"
base = hold_at - 600
big = " That is a longer reply so it counts for the card and shows in the thread."
# a long reply in markdown: headings, a list, a table, a code box, a link, and markup that must show as text (the reader's renderer escapes it)
rich = ("Nathan, alpha-route needs your pick before it can start. I opened a card Z1 for it.\n\n## The routes\n\n- **the shared plugin** (recommended): `bin/fm-send.sh alpha-route hello`\n- a fresh repo\n- skip it\n\n"
        "| route | cost | risk |\n|---|---|---|\n| plugin | low | low |\n| repo | high | medium |\n\n```sh\nbin/fm-send.sh alpha-route go\n```\n\n"
        "See [the notes](https://example.test/notes) and <script>window.__pwned = 1</script> and <img src=x onerror=\"window.__pwned = 2\"> too.\n\n"
        + "\n\n".join("Paragraph %d of the longer reply, with enough words in it to push the whole text well past the point where the card clips it." % n for n in range(1, 9)))
sup1 = lab.session(cwd, [
    ("what is open on alpha", rich + big, "bin/fm-send.sh alpha-route hello"),
    ("go on with the lesson", "Nathan, the lesson six draft is ready for you to read at data/zeta-lesson/report.md." + big),
    ('Re your reply at %s ("Nathan, alpha-route needs your pick"): looking now' % time.strftime("%H:%M", time.localtime(base + 50)), "Nathan, noted; I will wait on the alpha-route card." + big),
    ("status?", "Nathan, shipshape."),
    ("what about the two calls", "Nathan, delta-two-calls holds R1 and R2 for you; gamma-later waits only for your word." + big),
    ("anything else", "Nathan, the colour of the footer is still undecided and it needs your view when you have a minute, please read the options on the board." + big),
], base=base)
# the asking reply of the holds: a reply right after the hold time
sup2 = lab.session(cwd, [
    ("hold time", "Nathan, here are the calls: R1 and R2 on delta-two-calls need you." + big, "bin/fm-captain-hold.sh hold delta-two-calls --reason x"),
    ("again", "Nathan, shipshape."), ("and", "Nathan, shipshape again.")], base=hold_at + 20)
lab.ingest()
# the reader's own Send, against a fake Herdr that types nothing anywhere: one idle Claude pane runs the newest supervisor conversation
(tmp / "out").mkdir(); (tmp / "bin").mkdir()
(tmp / "out" / "sessions.txt").write_text(sup1 + "\n" + sup2 + "\n")
(tmp / "world.json").write_text(json.dumps({"sessions": [{"name": "lab", "focused": "w1:p1", "tabs": [{"tab_id": "w1:t1", "label": "supervisor"}], "panes": [
    {"pane_id": "w1:p1", "tab_id": "w1:t1", "label": "lab-supervisor", "agent": "claude", "agent_status": "idle", "agent_session": sup2, "title": "Supervisor", "cwd": cwd,
     "process": [{"pid": 1001, "argv0": "claude", "cwd": cwd}]}]}]}))
herdr = tmp / "bin" / "herdr"
herdr.write_text(f"#!/bin/sh\nFAKE_HERDR_WORLD={tmp / 'world.json'} FAKE_HERDR_LOG={tmp / 'herdr.log'} FAKE_HERDR_DIR={tmp} exec node {Path(__file__).resolve().parent / 'fake-herdr-world.js'} \"$@\"\n")
herdr.chmod(herdr.stat().st_mode | stat.S_IEXEC)
(tmp / "board.json").write_text(json.dumps({"fm_root": str(FM), "store": str(lab.root), "sessions": [{"id": "leader-lab", "label": "Lab", "home": str(home), "lifecycle": "software", "cwds": [cwd]}]}))
(tmp / "cache").mkdir(); (tmp / "conf").mkdir()
print(json.dumps({"home": str(home), "config": str(tmp / "board.json"), "cache": str(tmp / "cache"), "conf": str(tmp / "conf"), "out": str(tmp / "out"), "herdr": str(herdr),
                  "log": str(tmp / "herdr.log"), "hidden": str(tmp / "hidden.json"), "sup": sup2, "sup_old": sup1}))
