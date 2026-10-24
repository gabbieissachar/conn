#!/usr/bin/env python3
"""End-to-end check of archive-all and restore-batch through the real command line.

Runs a scratch copy of workspace-organizer.py (so no real archive, batch or registry state is touched) against a
fake `herdr` binary and a fake Herdr socket. Only Herdr itself is faked: argument parsing, subprocesses, the
socket calls, locking, interruption handling and every file write are the real code paths.

Run: python3 test-archive-all-cli.py
"""
import json, os, re, shutil, signal, socket, subprocess, sys, tempfile, threading, time
from pathlib import Path

FAKE_HERDR = r'''#!/usr/bin/env python3
import json, os, sys, time
state_path = os.environ["FAKE_STATE"]
def load(): return json.load(open(state_path))
def save(s): json.dump(s, open(state_path, "w"))
args = sys.argv[1:]
if args[:1] == ["--session"]: args = args[2:]
s = load()
if args[:2] == ["api", "snapshot"]:
    grow = os.environ.get("FAKE_GROW_AFTER_EXPORT")
    if grow:
        # The first snapshot of the run is the organizer's own look at the worker records, the second is the export and
        # the third is the re-read right before a close: a tab appears in the workspace by then.
        s["snaps"] = s.get("snaps", 0) + 1
        if s["snaps"] == 3:
            s["snapshot"]["tabs"].append({"workspace_id": grow, "tab_id": f"{grow}:t9", "label": "new"})
            s["snapshot"]["panes"].append({"tab_id": f"{grow}:t9", "pane_id": f"{grow}:p9", "agent_status": "unknown"})
        save(s)
    print(json.dumps({"result": {"snapshot": s["snapshot"]}}))
elif args[:2] == ["workspace", "close"]:
    if os.environ.get("FAKE_SLOW_CLOSE") == args[2]:
        open(state_path + ".closing-" + args[2], "w").write("1")  # tells the test the run is now inside its slow close
        time.sleep(8)
    snap = s["snapshot"]
    snap["workspaces"] = [w for w in snap["workspaces"] if w["workspace_id"] != args[2]]
    snap["tabs"] = [t for t in snap["tabs"] if t["workspace_id"] != args[2]]
    snap["panes"] = [p for p in snap["panes"] if not p["pane_id"].startswith(args[2] + ":")]
    s["closed"].append(args[2]); save(s); print(json.dumps({"result": {}}))
elif args[:2] == ["tab", "close"]:
    snap = s["snapshot"]; wid = args[2].split(":")[0]
    snap["tabs"] = [t for t in snap["tabs"] if t["tab_id"] != args[2]]
    snap["panes"] = [p for p in snap["panes"] if p["tab_id"] != args[2]]
    if not any(t["workspace_id"] == wid for t in snap["tabs"]):
        snap["workspaces"] = [w for w in snap["workspaces"] if w["workspace_id"] != wid]
    s.setdefault("tabs_closed", []).append(args[2]); save(s); print(json.dumps({"result": {}}))
elif args[:2] == ["workspace", "create"]:
    label = args[args.index("--label") + 1]
    s["next"] += 1; wid = f"w{s['next']}"
    snap = s["snapshot"]
    snap["workspaces"].append({"workspace_id": wid, "label": label, "focused": False})
    snap["tabs"].append({"workspace_id": wid, "tab_id": f"{wid}:t1", "label": "main"})
    snap["panes"].append({"tab_id": f"{wid}:t1", "pane_id": f"{wid}:p1", "agent_status": "unknown"})
    s["created"].append(wid); save(s)
    print(json.dumps({"result": {"workspace_id": wid, "tab_id": f"{wid}:t1"}}))
elif args[:2] == ["pane", "run"]:
    s.setdefault("sent", []).append(args[2]); save(s); print(json.dumps({"result": {}}))
elif args[:2] == ["pane", "process-info"]:
    # A plain shell prompt, unless the test says a program runs in the pane.
    program = s.get("programs", {}).get(args[3])
    running = [{"pid": 1, "name": "zsh"}] + ([{"pid": 2, "name": program}] if program else [])
    print(json.dumps({"result": {"process_info": {"shell_pid": 1, "foreground_processes": running}}}))
elif args[:2] == ["workspace", "focus"]:
    print(json.dumps({"result": {}}))
elif args[:2] == ["session", "list"]:
    print(json.dumps({"sessions": [{"name": "e2e", "running": True, "default": False}]}))
else:
    sys.stderr.write("fake herdr: unsupported " + " ".join(args) + "\n"); sys.exit(1)
'''
SRC = Path(__file__).resolve().parent / "workspace-organizer.py"
root = Path(tempfile.mkdtemp(prefix="real-e2e-"))
tool = root / "tool"; tool.mkdir(); shutil.copy(SRC, tool / "workspace-organizer.py")
bin_dir = root / "bin"; bin_dir.mkdir(); (bin_dir / "herdr").write_text(FAKE_HERDR); (bin_dir / "herdr").chmod(0o755)
config = root / "config"; sock_dir = config / "herdr" / "sessions" / "e2e"; sock_dir.mkdir(parents=True)
state_path = root / "state.json"
def fresh():
    snap = {"workspaces": [], "tabs": [], "panes": []}
    for wid, label, status in (("w1", "Alpha", "idle"), ("w2", "Beta", "idle"), ("w3", "Busy", "working")):
        snap["workspaces"].append({"workspace_id": wid, "label": label, "focused": wid == "w1"})
        snap["tabs"].append({"workspace_id": wid, "tab_id": f"{wid}:t1", "label": "main"})
        snap["panes"].append({"tab_id": f"{wid}:t1", "pane_id": f"{wid}:p1", "agent_status": status, **({"agent": "claude"} if status == "working" else {})})
    state_path.write_text(json.dumps({"snapshot": snap, "closed": [], "created": [], "sent": [], "next": 10}))
fresh()
# fake Herdr socket
sock_path = sock_dir / "herdr.sock"
server = socket.socket(socket.AF_UNIX); server.bind(str(sock_path)); server.listen(8)
handler_errors = []
def handle(conn):
    try:
        with conn, conn.makefile("rwb") as f:
            line = f.readline()
            if not line:
                return  # the client hung up before sending anything
            req = json.loads(line)
            p = req["params"]
            if req["method"] == "layout.export":
                wid = p["tab_id"].split(":")[0]
                folders = json.loads((root / "cwd-override.json").read_text()) if (root / "cwd-override.json").exists() else {}
                res = {"layout": {"tab_id": p["tab_id"], "root": {"type": "pane", "pane_id": f"{wid}:p1", "cwd": folders.get(f"{wid}:p1", "/tmp")}}}
            elif req["method"] == "layout.apply":
                if (root / "slow-apply").exists(): time.sleep(8)
                tab = p.get("tab_id") or f"{p['workspace_id']}:t9"
                wid = tab.split(":")[0]
                if str(p.get("tab_label") or "").startswith("fm-acc-"):
                    # A worker tab: Herdr names the rebuilt tab and keeps it in the session, as the real one does.
                    snap_state = json.loads((root / "state.json").read_text())
                    for existing in snap_state["snapshot"]["tabs"]:
                        if existing["tab_id"] == tab: existing["label"] = p["tab_label"]; break
                    else: snap_state["snapshot"]["tabs"].append({"workspace_id": wid, "tab_id": tab, "label": p["tab_label"]})
                    (root / "state.json").write_text(json.dumps(snap_state))
                res = {"layout": {"tab_id": tab, "root": {"type": "pane", "pane_id": f"{wid}:p1", "cwd": "/tmp"}}}
            else:
                res = {}
            f.write((json.dumps({"id": req["id"], "result": res}) + "\n").encode()); f.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass  # expected: the client was interrupted (Ctrl-C checks) while this call slept
    except Exception as error:  # anything else is a fake-server bug and fails the test at the end
        handler_errors.append(repr(error))
def serve():
    while True:
        try: conn, _ = server.accept()
        except OSError: return
        threading.Thread(target=handle, args=(conn,), daemon=True).start()
threading.Thread(target=serve, daemon=True).start()
env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_STATE": str(state_path), "XDG_CONFIG_HOME": str(config), "HERDR_ORGANIZER_OWNER_STATE_DIRS": ""}
for k in [k for k in env if k.startswith("HERDR_")]: del env[k]
env["HERDR_ORGANIZER_OWNER_STATE_DIRS"] = ""  # no real firstmate home is read or written by this test
def run(*args, check=None, extra_env=None):
    r = subprocess.run([sys.executable, str(tool / "workspace-organizer.py"), "--session", "e2e", *args], env={**env, **(extra_env or {})}, capture_output=True, text=True)
    if check is not None: assert r.returncode == check, (args, r.returncode, r.stdout, r.stderr)
    return r
def state(): return json.loads(state_path.read_text())
ok = lambda m: print("PASS", m)

r = run("archive-all", check=0); assert "archive 2 workspace(s) and skip 1" in r.stdout, r.stdout; ok("preview: 2 to archive, 1 skipped")
assert state()["closed"] == []; ok("preview closed nothing")
r = run("archive-all", "--execute", "--confirm", "wrong", check=1); assert state()["closed"] == [] and not (tool/"state"/"workspace-organizer"/"batches").exists(); ok("wrong confirm: refused, nothing closed, no record")
r = run("archive-all", "--execute", "--confirm", "e2e", check=0); print(r.stdout.strip())
assert state()["closed"] == ["w1", "w2"]; ok("execute closed exactly w1,w2 (w3 working stays)")
batches = json.loads(run("list-batches", check=0).stdout); assert len(batches) == 1; b = batches[0]
assert b["counts"] == {"archived": 2, "restored": 0, "restore_partial": 0, "deleted": 0, "other": 0, "skipped": 1}, b["counts"]; ok("list-batches counts " + json.dumps(b["counts"]))
bid = b["batch_id"]
run("snapshot", check=0); snap = json.loads((tool/"state"/"workspace-organizer"/"live-snapshot.json").read_text()); assert snap["batches"][0]["batch_id"] == bid and all(a["batch_id"] == bid for a in snap["archives"]); ok("snapshot carries the batch and stamped archives")
r = run("restore-batch", "--batch", bid, check=0); assert "restore 2 workspace(s)" in r.stdout; ok("restore-batch preview")
r = run("restore-batch", "--batch", bid, "--execute", "--confirm", "wrong", check=1); ok("restore wrong confirm refused")
archives_dir = tool / "state" / "workspace-organizer" / "archives"
r = run("restore-batch", "--batch", bid, "--execute", "--confirm", bid, check=0); print(r.stdout.strip())
assert len(state()["created"]) == 2; ok("layout-only restore created 2 workspaces")
b = json.loads(run("list-batches", check=0).stdout)[0]
assert b["counts"]["archived"] == 2 and b["counts"]["restored"] == 0, b["counts"]
assert all(m["status"] == "archived" and m["layout_workspace_id"] for m in b["members"]), b["members"]
ok("a layout-only restore marks nothing restored and keeps both restore commands")
r = run("restore-batch", "--batch", bid, "--execute", "--confirm", bid, check=0)
assert len(state()["created"]) == 2 and "already had their layout open" in r.stdout, r.stdout; ok("second layout-only restore-batch makes no duplicate workspace")
for path in sorted(archives_dir.glob("*.json")):
    a = json.loads(path.read_text())
    if a["capture"]["workspace"]["label"] == "Alpha":
        a["capture"]["tabs"][0]["agent_restores"] = [{"client": "codex", "restore_status": "resumable", "restore_source": "manifest", "resume_command": "codex resume 00000000-0000-0000-0000-000000000000", "source_pane_id": "w1:p1"}]
        path.write_text(json.dumps(a))
r = run("restore-batch", "--batch", bid, "--resume-agents", "--execute", "--confirm", bid, check=0); print(r.stdout.strip())
assert len(state()["created"]) == 2, "resume must use the open layout copies, not make new workspaces"
assert len(state()["sent"]) == 1 and state()["sent"][0] in ("w11:p1", "w12:p1"), state()["sent"]; ok("restore-batch --resume-agents adopts the open workspaces and sends one resume")
b = json.loads(run("list-batches", check=0).stdout)[0]
assert b["batch_id"] == bid and b["members"] == [] and b["empty"], b; ok("restored members left the group, and the group stays, empty")
assert sorted(json.loads(path.read_text())["status"] for path in archives_dir.glob("*.json")) == ["restored", "resumed"]; ok("their archives are kept as single archives, marked restored")
r = run("restore-batch", "--batch", bid, "--resume-agents", "--execute", "--confirm", bid, check=0); assert "Nothing to restore" in r.stdout and len(state()["sent"]) == 1 and len(state()["created"]) == 2; ok("second resume restores nothing (no duplicates, no second resume)")
# The two restored workspaces (w11, w12) are archived again: the same group takes them as new entries.
run("archive-all", "--execute", "--confirm", "e2e", check=0)
batches = json.loads(run("list-batches", check=0).stdout)
assert len(batches) == 1 and batches[0]["batch_id"] == bid and batches[0]["counts"]["archived"] == 2, batches; ok("archiving them again joins the same group as 2 new entries")
assert len(list(archives_dir.glob("*.json"))) == 4; ok("the two restored archives and the two new ones all exist")
r = run("delete-batch", "--batch", bid, "--archives", check=0); assert "2 archive(s)" in r.stdout and len(list(archives_dir.glob("*.json"))) == 4; ok("delete-batch --archives preview deletes nothing and counts only the group's members")
r = run("delete-batch", "--batch", bid, "--archives", "--execute", "--confirm", bid, check=1); assert len(list(archives_dir.glob("*.json"))) == 4; ok("delete-batch --archives refuses the record-only confirmation (the batch id)")
r = run("delete-batch", "--batch", bid, "--archives", "--execute", "--confirm", "delete-archives:" + bid, check=0); assert len(list(archives_dir.glob("*.json"))) == 2 and json.loads(run("list-batches", check=0).stdout) == []; ok("delete-batch --archives removed the group record and its 2 archives; the 2 restored archives stay")
# interruption
fresh()
archives_before = len(list(archives_dir.glob("*.json")))
p = subprocess.Popen([sys.executable, str(tool / "workspace-organizer.py"), "--session", "e2e", "archive-all", "--execute", "--confirm", "e2e"], env={**env, "FAKE_SLOW_CLOSE": "w2"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
for _ in range(100):
    if "w1" in state()["closed"]: break
    time.sleep(0.1)
for _ in range(300):  # interrupt only once w2's close has started, so the run is inside its slow close
    if Path(str(state_path) + ".closing-w2").exists(): break
    time.sleep(0.1)
else: raise AssertionError("w2's slow close never started")
time.sleep(0.3); p.send_signal(signal.SIGINT); out, err = p.communicate(timeout=20)
assert p.returncode != 0
bs = sorted(json.loads(run("list-batches", check=0).stdout), key=lambda x: x["created_at"])
latest = [x for x in bs if x["status"] == "interrupted"]; assert len(latest) == 1, [x["status"] for x in bs]
st = {m["workspace_id"]: m["status"] for m in latest[0]["members"]}; assert st == {"w1": "archived", "w2": "close_failed"}, st
ok("Ctrl-C mid-run: record 'interrupted', in-flight archive 'close_failed' " + json.dumps(st))
# lock: two at once
fresh()
slow = subprocess.Popen([sys.executable, str(tool / "workspace-organizer.py"), "--session", "e2e", "archive-all", "--execute", "--confirm", "e2e"], env={**env, "FAKE_SLOW_CLOSE": "w1"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
time.sleep(1.5)
r = run("archive-all", "--execute", "--confirm", "e2e"); assert r.returncode == 1 and "already in progress" in r.stderr, (r.stdout, r.stderr); ok("second concurrent archive-all refused")
slow.wait(timeout=30)
# Ctrl-C during a layout-only restore: the archive stays archived and keeps its restore command
b = json.loads(run("list-batches", check=0).stdout); member = next(m for batch in b for m in batch["members"] if m["workspace_label"] == "Alpha")
archive_id = member["archive_id"]; (root / "slow-apply").write_text("1")
before = len(state()["created"])
p = subprocess.Popen([sys.executable, str(tool / "workspace-organizer.py"), "--session", "e2e", "restore", "--archive", archive_id, "--execute", "--confirm", archive_id], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
for _ in range(100):
    if len(state()["created"]) > before: break
    time.sleep(0.1)
time.sleep(0.5); p.send_signal(signal.SIGINT); p.communicate(timeout=20); (root / "slow-apply").unlink()
assert p.returncode != 0
archive = json.loads((archives_dir / f"{archive_id}.json").read_text())
assert archive["status"] == "archived" and archive["layout_restore"]["workspace_id"] and "Interrupted" in archive["layout_restore"]["error"], archive["status"]
ok("Ctrl-C mid layout-only restore: archive stays 'archived', the record says it was interrupted")
r = run("restore", "--archive", archive_id, "--execute", "--confirm", archive_id, check=0); assert "was interrupted" in r.stdout and "Laid out archive" in r.stdout, r.stdout; ok("a layout copy from an interrupted restore is not trusted: the retained command lays out a fresh one and says so")
r = run("restore", "--archive", archive_id, "--execute", "--confirm", archive_id, check=0); assert "already has its layout open" in r.stdout, r.stdout; ok("the fresh layout copy is then found instead of making another")
r = run("restore", "--archive", archive_id, "--resume-agents", "--execute", "--confirm", archive_id, check=0); assert "No new workspace was made" in r.stdout; ok("restore + resume adopts the open copy")
r = run("restore", "--archive", archive_id, "--resume-agents", "--execute", "--confirm", archive_id, check=1); assert "already restored" in r.stderr; ok("a restored archive is refused without --force")
# ---- one group per session: a workspace archived again while its layout copy is open replaces its entry ----
def reset_organizer_state():
    for name in ("archives", "batches"): shutil.rmtree(tool / "state" / "workspace-organizer" / name, ignore_errors=True)
reset_organizer_state(); fresh()
run("archive-all", "--execute", "--confirm", "e2e", check=0)
first = json.loads(run("list-batches", check=0).stdout)[0]; first_ids = sorted(m["archive_id"] for m in first["members"]); assert len(first_ids) == 2
r = run("restore-batch", "--execute", "--confirm", first["batch_id"], check=0)  # no --batch: the session's one group
assert len(state()["created"]) == 2 and "laid out 2 of 2" in r.stdout, r.stdout; ok("restore-batch without --batch uses the session's one group")
r = run("archive-all", check=0); assert "archive 2 workspace(s)" in r.stdout; ok("the layout copies are on the archive-all list")
run("archive-all", "--execute", "--confirm", "e2e", check=0)
groups = json.loads(run("list-batches", check=0).stdout); assert len(groups) == 1 and groups[0]["batch_id"] == first["batch_id"]; ok("the session still has one group")
new_ids = sorted(m["archive_id"] for m in groups[0]["members"]); assert len(new_ids) == 2 and not set(new_ids) & set(first_ids), new_ids; ok("the two layout copies replaced the two earlier entries, so no workspace is listed twice")
for old in first_ids:
    left = json.loads((archives_dir / f"{old}.json").read_text()); assert left["status"] == "archived" and left["left_group"]["reason"] == "replaced" and left["left_group"]["by"] in new_ids, left
ok("each replaced archive is kept as a single archive and says which entry replaced it")
# ---- add selected live tabs to a finished batch ----
reset_organizer_state(); fresh()
def live_workspace(wid, label, tabs):
    st = state(); snap = st["snapshot"]
    snap["workspaces"].append({"workspace_id": wid, "label": label, "focused": False})
    for n in range(1, tabs + 1):
        snap["tabs"].append({"workspace_id": wid, "tab_id": f"{wid}:t{n}", "label": f"tab {n}"})
        snap["panes"].append({"tab_id": f"{wid}:t{n}", "pane_id": f"{wid}:p{n}", "agent_status": "unknown"})
    state_path.write_text(json.dumps(st))
def members_of(batch_id):
    return {m["workspace_label"]: m for x in json.loads(run("list-batches", check=0).stdout) if x["batch_id"] == batch_id for m in x["members"]}
fresh()
run("archive-all", "--execute", "--confirm", "e2e", check=0)
(only_group,) = json.loads(run("list-batches", check=0).stdout); bid = only_group["batch_id"]
alpha = members_of(bid)["Alpha"]
run("restore", "--archive", alpha["archive_id"], "--execute", "--confirm", alpha["archive_id"], check=0)
layout_ws = members_of(bid)["Alpha"]["layout_workspace_id"]; assert layout_ws, "the layout-only restore left a workspace open"
live_workspace("w20", "Gamma", 3)
tabs = ["--tab", "w20:t1", "--tab", "w20:t2", "--tab", f"{layout_ws}:t1"]
r = run("add-tabs-to-batch", "--batch", bid, *tabs, check=0)
preview = json.loads(r.stdout[: r.stdout.rindex("}") + 1])
actions = {a["workspace_id"]: a["action"] for a in preview["additions"]}
assert actions == {"w20": "new_member", layout_ws: "merge"}, actions
assert preview["warnings"] == [], preview["warnings"]  # the one captured tab is replaced by its rebuilt copy, so nothing duplicates
assert state().get("tabs_closed", []) == [] and state()["closed"] == ["w1", "w2"], state(); ok("add-tabs-to-batch preview: new member for Gamma, merge for the open layout, nothing closed")
r = run("add-tabs-to-batch", "--batch", bid, *tabs, "--execute", "--confirm", "wrong", check=1); assert state().get("tabs_closed", []) == []; ok("add-tabs-to-batch wrong confirm refused")
r = run("add-tabs-to-batch", "--batch", bid, *tabs, "--execute", "--confirm", bid, check=0); print(r.stdout.strip())
st = state(); assert st["tabs_closed"] == ["w20:t1", "w20:t2"] and layout_ws in st["closed"], (st["tabs_closed"], st["closed"])
assert {t["tab_id"] for t in st["snapshot"]["tabs"] if t["workspace_id"] == "w20"} == {"w20:t3"}; ok("only the selected Gamma tabs closed, and the fully selected layout workspace closed whole")
members = members_of(bid); assert set(members) == {"Alpha", "Beta", "Gamma (selected tabs)"}, set(members)
assert {k: m["status"] for k, m in members.items()} == {"Alpha": "archived", "Beta": "archived", "Gamma (selected tabs)": "archived"}; ok("the merged and the new member are archived")
assert members["Alpha"]["layout_workspace_id"] is None; ok("the merged member no longer points at the closed layout workspace")
alpha_archive = json.loads((archives_dir / f"{members['Alpha']['archive_id']}.json").read_text())
assert [t["source_tab_id"] for t in alpha_archive["capture"]["tabs"]] == [f"{layout_ws}:t1"], alpha_archive["capture"]["tabs"]
assert alpha_archive["restore_history"][0]["layout_restore"]["workspace_id"] == layout_ws and "layout_restore" not in alpha_archive; ok("the rebuilt tab replaced its captured original and the old layout record became history")
batch = next(x for x in json.loads(run("list-batches", check=0).stdout) if x["batch_id"] == bid); assert batch["counts"]["archived"] == 3, batch["counts"]; ok("the group now counts 3 archived members")
before = len(state()["created"]); r = run("restore-batch", "--batch", bid, "--execute", "--confirm", bid, check=0)
assert len(state()["created"]) - before == 3, r.stdout; ok("restore-batch lays out all 3 members, the added one included")
# Ctrl-C while the only remaining Gamma tab is closing: its workspace closes whole, and the merge target is found by its original id
live_gamma = members_of(bid)["Gamma (selected tabs)"]["archive_id"]
p = subprocess.Popen([sys.executable, str(tool / "workspace-organizer.py"), "--session", "e2e", "add-tabs-to-batch", "--batch", bid, "--tab", "w20:t3", "--execute", "--confirm", bid], env={**env, "FAKE_SLOW_CLOSE": "w20"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
for _ in range(300):  # interrupt only once the add is inside its slow close: the fake Herdr says the close has started
    if Path(str(state_path) + ".closing-w20").exists(): break
    time.sleep(0.1)
else: raise AssertionError("w20's slow close never started")
time.sleep(0.3); p.send_signal(signal.SIGINT); p.communicate(timeout=20); assert p.returncode != 0
settled = json.loads((archives_dir / f"{live_gamma}.json").read_text())
assert settled["status"] == "close_failed" and "w20:t3" in settled["error"] and settled["tab_archives"][-1]["status"] == "close_partial", settled["status"]
assert [t["source_tab_id"] for t in settled["capture"]["tabs"]] == ["w20:t1", "w20:t2", "w20:t3"]; ok("Ctrl-C mid add: merged by original workspace id, archive 'close_failed', the still-open tab is named")
# the Ctrl-C-interrupted add left a close_failed archive. finish-tab-add checks it again and finishes it.
settled_id = live_gamma
r = run("finish-tab-add", "--archive", settled_id, check=0); print(r.stdout.strip())
preview = json.loads(r.stdout[: r.stdout.rindex("}") + 1]); assert preview["problems"] == [], preview
r = run("finish-tab-add", "--archive", settled_id, "--execute", "--confirm", "wrong", check=1)
r = run("finish-tab-add", "--archive", settled_id, "--execute", "--confirm", settled_id, check=0); print(r.stdout.strip())
finished = json.loads((archives_dir / f"{settled_id}.json").read_text())
assert finished["status"] == "archived" and "error" not in finished and finished["tab_archives"][-1]["status"] == "completed", finished["status"]
assert "w20" not in {w["workspace_id"] for w in state()["snapshot"]["workspaces"]}; ok("finish-tab-add finished the interrupted add: workspace closed, archive archived again")
r = run("finish-tab-add", "--archive", settled_id, "--execute", "--confirm", settled_id, check=1); assert "no unfinished tab add" in r.stderr; ok("a second finish-tab-add has nothing left to do")
r = run("restore", "--archive", settled_id, check=0); assert "Preview only" in r.stdout; ok("the recovered archive is restorable again")
# A tab added to the workspace after the capture stops the whole-workspace close, and the run is undone.
live_workspace("w30", "Delta", 2)
before = {pth.name: pth.read_text() for pth in sorted(archives_dir.glob("*.json"))}
p = subprocess.Popen([sys.executable, str(tool / "workspace-organizer.py"), "--session", "e2e", "add-tabs-to-batch", "--batch", bid, "--tab", "w30:t1", "--tab", "w30:t2", "--execute", "--confirm", bid], env={**env, "FAKE_GROW_AFTER_EXPORT": "w30"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
out, err = p.communicate(timeout=20)
assert p.returncode != 0 and "changed after it was captured" in err and "Nothing was closed" in err, (out, err)
assert "w30" in {w["workspace_id"] for w in state()["snapshot"]["workspaces"]}, "the workspace was not closed"
assert {pth.name: pth.read_text() for pth in sorted(archives_dir.glob("*.json"))} == before; ok("a tab opened after the capture stops the workspace close and the add is undone")
# ---- restart snapshot: saved without closing, restored after a restart that Herdr partly undid by itself ----
reset_organizer_state(); fresh()
r = run("archive-all", "--snapshot", check=0); assert "snapshot (nothing is closed)" in r.stdout, r.stdout; ok("snapshot preview says nothing is closed")
r = run("archive-all", "--snapshot", "--execute", "--confirm", "e2e", check=0); print(r.stdout.strip())
assert state()["closed"] == [] and "Nothing was closed" in r.stdout; ok("snapshot --execute closed nothing")
(snap_group,) = json.loads(run("list-batches", check=0).stdout); snap_bid = snap_group["batch_id"]
assert sorted(m["workspace_label"] for m in snap_group["members"]) == ["Alpha", "Beta"] and all(m["status"] == "archived" and m["snapshot"] for m in snap_group["members"]), snap_group["members"]; ok("the group holds Alpha and Beta as archived snapshot members")
r = run("archive-all", "--snapshot", "--execute", "--confirm", "e2e", check=0)
(snap_group,) = json.loads(run("list-batches", check=0).stdout); assert len(snap_group["members"]) == 2 and "replaces" in r.stdout; ok("a second snapshot replaces the first, so no workspace is listed twice")
for path in sorted(archives_dir.glob("*.json")):
    a = json.loads(path.read_text())
    if a["capture"]["workspace"]["label"] == "Alpha" and a.get("status") == "archived" and "left_group" not in a:
        a["capture"]["tabs"][0]["agent_restores"] = [{"client": "codex", "restore_status": "resumable", "restore_source": "manifest", "resume_command": "codex resume 00000000-0000-0000-0000-000000000000", "source_pane_id": "w1:p1", "session_id": "00000000-0000-0000-0000-000000000000"}]
        path.write_text(json.dumps(a))
# The restart: Herdr comes back with Alpha under a new id and nothing else.
st = state(); st["snapshot"] = {"workspaces": [{"workspace_id": "w7", "label": "Alpha", "focused": True}], "tabs": [{"workspace_id": "w7", "tab_id": "w7:t1", "label": "main"}], "panes": [{"tab_id": "w7:t1", "pane_id": "w7:p1", "agent_status": "unknown"}]}
st["created"] = []; st["sent"] = []; state_path.write_text(json.dumps(st))
r = run("restore-batch", "--resume-agents", "--execute", "--confirm", snap_bid, check=0); print(r.stdout.strip())
st = state(); assert st["sent"] == ["w7:p1"], st["sent"]; assert len(st["created"]) == 1, st["created"]; ok("Alpha (back natively) got its resume in the open workspace; only Beta was built")
assert "already open, so nothing was rebuilt" in r.stdout; ok("the restore said it adopted what Herdr brought back")
(snap_group,) = json.loads(run("list-batches", check=0).stdout); assert snap_group["members"] == [], snap_group; ok("both restored members left the group")
r = run("restore-batch", "--resume-agents", "--execute", "--confirm", snap_bid, check=0); assert "Nothing to restore" in r.stdout and len(state()["sent"]) == 1; ok("a second restore changes nothing")
assert not handler_errors, handler_errors; ok("the fake Herdr socket saw no unexpected handler error")
# ---- a restart brings Alpha back, but its pane is in another folder or runs a program: nothing is typed into it ----
for why, folders, programs in (("another folder", {"w7:p1": "/elsewhere"}, {}), ("a running program", {}, {"w7:p1": "vim"})):
    reset_organizer_state(); fresh()
    run("archive-all", "--snapshot", "--execute", "--confirm", "e2e", check=0)
    (snap_group,) = json.loads(run("list-batches", check=0).stdout); snap_bid = snap_group["batch_id"]
    for path in sorted(archives_dir.glob("*.json")):
        a = json.loads(path.read_text())
        if a["capture"]["workspace"]["label"] == "Alpha":
            a["capture"]["tabs"][0]["agent_restores"] = [{"client": "codex", "restore_status": "resumable", "restore_source": "manifest", "resume_command": "codex resume 00000000-0000-0000-0000-000000000000", "source_pane_id": "w1:p1", "session_id": "00000000-0000-0000-0000-000000000000"}]
            path.write_text(json.dumps(a))
    st = state(); st["snapshot"] = {"workspaces": [{"workspace_id": "w7", "label": "Alpha", "focused": True}], "tabs": [{"workspace_id": "w7", "tab_id": "w7:t1", "label": "main"}], "panes": [{"tab_id": "w7:t1", "pane_id": "w7:p1", "agent_status": "unknown"}]}
    st["created"] = []; st["sent"] = []; st["programs"] = programs; state_path.write_text(json.dumps(st))
    (root / "cwd-override.json").write_text(json.dumps(folders))
    r = run("restore-batch", "--snapshot-only", "--resume-agents", "--execute", "--confirm", snap_bid, check=0); print(r.stdout.strip())
    st = state(); assert "w7:p1" not in st["sent"], (why, st["sent"])
    alpha = next(json.loads(path.read_text()) for path in archives_dir.glob("*.json") if json.loads(path.read_text())["capture"]["workspace"]["label"] == "Alpha")
    assert alpha["status"] == "archived", (why, alpha["status"])
    assert "was left alone" in r.stdout and "open, but" in r.stdout, (why, r.stdout); ok(f"Alpha back natively with {why}: no resume typed into it, the member stays archived")
    (root / "cwd-override.json").unlink()
    st = state(); st["programs"] = {}; state_path.write_text(json.dumps(st))
assert not handler_errors, handler_errors; ok("the fake Herdr socket saw no unexpected handler error")
# ---- a worker spawned by a firstmate home: archive it, restore it, and its home's record follows it ----
homes = root / "homes" / "state"; homes.mkdir(parents=True)
owned = {"HERDR_ORGANIZER_OWNER_STATE_DIRS": str(homes)}
st = state()
st["snapshot"] = {"workspaces": [{"workspace_id": "w40", "label": "Worker", "focused": False}], "tabs": [{"workspace_id": "w40", "tab_id": "w40:t1", "label": "fm-acc-task"}], "panes": [{"tab_id": "w40:t1", "pane_id": "w40:p1", "agent_status": "idle"}]}
st["created"] = []; st["sent"] = []; state_path.write_text(json.dumps(st))
meta = homes / "acc-task.meta"
meta.write_text("window=e2e:w40:p1\nendpoint_task_id=acc-task\nkind=scout\nbackend=herdr\nherdr_session=e2e\nherdr_workspace_id=w40\nherdr_tab_id=w40:t1\nherdr_pane_id=w40:p1\ndecision_keys=\n")
original_meta = meta.read_text()
r = run("archive", "--workspace", "w40", "--execute", "--confirm", "w40", check=0, extra_env=owned); print(r.stdout.strip())
worker_archive = re.search(r"as (\S+)\.", r.stdout).group(1)
assert "marked archived" in r.stdout and "acc-task" in r.stdout, r.stdout
marker = homes / "acc-task.herdr-archived"
assert marker.exists() and "pane_id=w40:p1" in marker.read_text() and meta.read_text() == original_meta; ok("archiving the worker marks its home's record archived and leaves the record itself alone")
r = run("restore", "--archive", worker_archive, "--execute", "--confirm", worker_archive, check=0, extra_env=owned); print(r.stdout.strip())
new_workspace = state()["created"][-1]
assert f"pane w40:p1 -> {new_workspace}:p1" in r.stdout, r.stdout
rewritten = dict(line.split("=", 1) for line in meta.read_text().splitlines())
assert rewritten["window"] == f"e2e:{new_workspace}:p1" and rewritten["herdr_workspace_id"] == new_workspace and rewritten["herdr_tab_id"] == f"{new_workspace}:t1" and rewritten["herdr_pane_id"] == f"{new_workspace}:p1", rewritten
assert rewritten["endpoint_task_id"] == "acc-task" and rewritten["kind"] == "scout" and not marker.exists(); ok("restoring it rewrites the record to the new ids, clears the marker and touches nothing else")
assert len(list(homes.glob("acc-task.meta.herdr-relink-*.bak"))) == 1 and original_meta in next(homes.glob("*.bak")).read_text(); ok("the old record is kept beside it")
r = run("relink-owner-records", check=0, extra_env=owned); assert "Every worker record of this session points at a live pane" in r.stdout, r.stdout; ok("a standalone check then finds nothing stale")
server.close(); shutil.rmtree(root)
print("ALL REAL-CLI CHECKS PASSED")
