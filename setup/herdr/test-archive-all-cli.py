#!/usr/bin/env python3
"""End-to-end check of archive-all and restore-batch through the real command line.

Runs a scratch copy of workspace-organizer.py (so no real archive, batch or registry state is touched) against a
fake `herdr` binary and a fake Herdr socket. Only Herdr itself is faked: argument parsing, subprocesses, the
socket calls, locking, interruption handling and every file write are the real code paths.

Run: python3 test-archive-all-cli.py
"""
import json, os, shutil, signal, socket, subprocess, sys, tempfile, threading, time
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
    print(json.dumps({"result": {"snapshot": s["snapshot"]}}))
elif args[:2] == ["workspace", "close"]:
    if os.environ.get("FAKE_SLOW_CLOSE") == args[2]: time.sleep(8)
    snap = s["snapshot"]
    snap["workspaces"] = [w for w in snap["workspaces"] if w["workspace_id"] != args[2]]
    snap["tabs"] = [t for t in snap["tabs"] if t["workspace_id"] != args[2]]
    snap["panes"] = [p for p in snap["panes"] if not p["pane_id"].startswith(args[2] + ":")]
    s["closed"].append(args[2]); save(s); print(json.dumps({"result": {}}))
elif args[:2] == ["workspace", "create"]:
    label = args[args.index("--label") + 1]
    s["next"] += 1; wid = f"w{s['next']}"
    snap = s["snapshot"]
    snap["workspaces"].append({"workspace_id": wid, "label": label, "focused": False})
    snap["tabs"].append({"workspace_id": wid, "tab_id": f"{wid}:t1", "label": "main"})
    snap["panes"].append({"tab_id": f"{wid}:t1", "pane_id": f"{wid}:p1", "agent_status": "idle"})
    s["created"].append(wid); save(s)
    print(json.dumps({"result": {"workspace_id": wid, "tab_id": f"{wid}:t1"}}))
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
    state_path.write_text(json.dumps({"snapshot": snap, "closed": [], "created": [], "next": 10}))
fresh()
# fake Herdr socket
sock_path = sock_dir / "herdr.sock"
server = socket.socket(socket.AF_UNIX); server.bind(str(sock_path)); server.listen(8)
def serve():
    while True:
        try: conn, _ = server.accept()
        except OSError: return
        with conn, conn.makefile("rwb") as f:
            req = json.loads(f.readline())
            p = req["params"]
            if req["method"] == "layout.export":
                wid = p["tab_id"].split(":")[0]
                res = {"layout": {"tab_id": p["tab_id"], "root": {"type": "pane", "pane_id": f"{wid}:p1", "cwd": "/tmp"}}}
            elif req["method"] == "layout.apply":
                tab = p.get("tab_id") or f"{p['workspace_id']}:t9"
                wid = tab.split(":")[0]
                res = {"layout": {"tab_id": tab, "root": {"type": "pane", "pane_id": f"{wid}:p1", "cwd": "/tmp"}}}
            else:
                res = {}
            f.write((json.dumps({"id": req["id"], "result": res}) + "\n").encode()); f.flush()
threading.Thread(target=serve, daemon=True).start()
env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_STATE": str(state_path), "XDG_CONFIG_HOME": str(config)}
for k in [k for k in env if k.startswith("HERDR_")]: del env[k]
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
r = run("restore-batch", "--batch", bid, "--execute", "--confirm", bid, check=0); print(r.stdout.strip())
assert len(state()["created"]) == 2; ok("restore created 2 workspaces")
b = json.loads(run("list-batches", check=0).stdout)[0]; assert b["counts"]["restored"] == 2 and b["counts"]["archived"] == 0; ok("members now restored")
r = run("restore-batch", "--batch", bid, "--execute", "--confirm", bid, check=0); assert "Nothing to restore" in r.stdout and len(state()["created"]) == 2; ok("second restore-batch restores nothing (no duplicates)")
# interruption
fresh()
p = subprocess.Popen([sys.executable, str(tool / "workspace-organizer.py"), "--session", "e2e", "archive-all", "--execute", "--confirm", "e2e"], env={**env, "FAKE_SLOW_CLOSE": "w2"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
for _ in range(100):
    if "w1" in state()["closed"]: break
    time.sleep(0.1)
time.sleep(0.5); p.send_signal(signal.SIGINT); out, err = p.communicate(timeout=20)
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
server.close(); shutil.rmtree(root)
print("ALL REAL-CLI CHECKS PASSED")
