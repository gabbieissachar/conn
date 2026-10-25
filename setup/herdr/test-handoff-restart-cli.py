#!/usr/bin/env python3
"""End-to-end check of `workspace-organizer.py handoff-restart` through the real command line.

Runs a scratch copy of workspace-organizer.py (so no real run record or registry state is touched) against a fake
`herdr` binary. Only Herdr, the Claude transcript and the context gauge are faked: argument parsing, subprocesses,
locking, interruption handling, the screen classifier, the document checks and every file write are the real code paths.
Every wait of the command is shrunk by HERDR_ORGANIZER_HANDOFF_TIMESCALE so the whole file runs in about a minute.

The fake models what the real-Herdr probes saw (data/herdr-restart-probes/report.md): /clear changes the pane's session
id once, after a short `working` state; the slash menu is open while /clear is typed; the HANDOFF_DOC line is indented and
hard-wrapped on screen but exact in the session transcript; a permission dialog has `❯ 1. Yes` as its last `❯` line.

Run: python3 test-handoff-restart-cli.py
Nothing is deleted: the scratch folder is left in place and its path is printed first.
"""
import importlib.util, json, os, signal, stat, subprocess, sys, tempfile, time
from pathlib import Path

FAKE_HERDR = r'''#!/usr/bin/env python3
import fcntl, json, os, subprocess, sys, time
path = os.environ["FAKE_STATE"]
args = sys.argv[1:]
if args[:1] == ["--session"]: args = args[2:]
lock = open(path + ".lock", "w"); fcntl.flock(lock, fcntl.LOCK_EX)
s = json.load(open(path))
def save(): json.dump(s, open(path, "w"))
now = time.time()
RULE = "─" * 119
HEADER = [" ▐▛███▛█   Claude Code v2.1.310", "▝▜██████▀  Opus 5.5 with high effort · Claude Team", " ▝▝   ▝▝   /tmp/x"]

def render(p):
    mode = p.get("mode", "normal")
    if mode == "dialog":
        return "\n".join(HEADER + ["", " Do you want to create probe.txt?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Tab to amend"]) + "\n"
    if mode == "unknown":
        return "\n".join(HEADER + ["no composer here"]) + "\n"
    if mode == "fresh":
        body = HEADER + ["▎ Message from [Team 2] Shopback:", "▎ notice text", "  1 more notice hidden", "❯ /clear"]
    else:
        body = HEADER + p.get("history", ["❯ earlier prompt", "", "⏺ earlier reply", "", "✻ Crunched for 4s · done 1:19 AM"])
    composer = p.get("composer", "")
    menu = []
    if composer.startswith("/"):
        menu = ["  ❯ /clear                                         Start a new session with empty context", "    /wayfinder                                     Plan a huge chunk of work"]
    if mode == "spinner":
        body = body + ["✳ Seasoning… (running UserPromptSubmit hook · 2s)"]
    parts = composer.split("\n")
    comp = ["❯ " + parts[0]] + ["  " + x for x in parts[1:]]
    return "\n".join(body + menu + [RULE] + comp + [RULE, "  Opus 5.5 | ctx: 6% used", "  ⏵⏵ auto mode on (shift+tab to cycle)"]) + "\n"

def refresh():
    for pid, i in s["internal"].items():
        at = i.get("clear_at")
        if at and now >= at:
            pane = s["panes"][pid]
            if i.get("clear_mode", "changes") == "changes":
                pane["agent_session"]["value"] = i["new_sid"]
                i["mode"] = "fresh"
            elif i["clear_mode"] == "never_proof":
                i["mode"] = "fresh"
            else:
                pass  # never_noproof: Herdr's id and the screen both stay as they were
            i["composer"] = ""
            pane["agent_status"] = "idle"
            i["clear_at"] = None
        elif at:
            s["panes"][pid]["agent_status"] = "working"

def public(p): return dict(p)

def fail(code):
    print(json.dumps({"id": "cli", "error": {"code": code, "message": code}})); save(); sys.exit(1)

def write_handoff(pid):
    i = s["internal"][pid]; h = i["handoff"]; pane = s["panes"][pid]
    sid = pane["agent_session"]["value"]
    doc = h["doc_path"]
    if h.get("write_doc", True):
        target = h.get("symlink_target") or doc
        os.makedirs(os.path.dirname(target), exist_ok=True)
        open(target, "w").write(h["doc_text"] if not h.get("large") else "x" * 1_100_000)
        if h.get("mtime_offset"): os.utime(target, (now + h["mtime_offset"],) * 2)
        if h.get("symlink_target"): os.symlink(target, doc)
    marker = h.get("marker", f"HANDOFF_DOC: {doc}")
    for proj in h.get("projects", ["proj-a"]):
        d = os.path.join(os.environ["FAKE_CLAUDE_DIR"], "projects", proj); os.makedirs(d, exist_ok=True)
        log = os.path.join(d, sid + ".jsonl")
        entries = [
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "earlier\nHANDOFF_DOC: /old/stale.md"}]}},
            {"type": "user", "message": {"role": "user", "content": "<command-name>/handoff</command-name>\n<command-args>" + s["last_request"] + "</command-args>"}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Write", "input": {}}]}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}},
        ]
        open(log, "w").write("".join(json.dumps(e) + "\n" for e in entries))
        if h.get("write_marker", True):
            line = json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "All saved.\n\n" + marker}]}}) + "\n"
            delay = h.get("marker_delay", 0)
            if delay:
                subprocess.Popen([sys.executable, "-c", "import sys,time; time.sleep(float(sys.argv[1])); open(sys.argv[2],'a').write(sys.argv[3])", str(delay), log, line], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                open(log, "a").write(line)
    for key, value in h.get("after", {}).items():
        if key == "new_session": pane["agent_session"]["value"] = value
        elif key == "focused": pane["focused"] = value
        elif key == "composer": i["composer"] = value
        elif key == "status": pane["agent_status"] = value

refresh()
s["log"].append(args)
if args[:2] == ["api", "snapshot"]:
    print(json.dumps({"result": {"snapshot": {"workspaces": s["workspaces"], "tabs": s["tabs"], "panes": [public(p) for p in s["panes"].values()], "focused_pane_id": None}}}))
elif args[:2] == ["pane", "list"]:
    print(json.dumps({"result": {"type": "pane_list", "panes": [public(p) for p in s["panes"].values()]}}))
elif args[:2] == ["agent", "read"]:
    pid = args[2]
    if pid not in s["panes"]: fail("pane_not_found")
    sys.stdout.write(render(s["internal"][pid]))
elif args[:2] == ["agent", "prompt"]:
    pid, text = args[2], args[3]
    if pid not in s["panes"]: fail("pane_not_found")
    pane, i = s["panes"][pid], s["internal"][pid]
    if pane["agent_status"] == "blocked": fail("agent_blocked")
    if text.startswith("/handoff"):
        s["last_request"] = text
        if i.get("prompt_mode") == "stall": fail("agent_prompt_stalled")
        pane["agent_status"] = "working"; save()
        fcntl.flock(lock, fcntl.LOCK_UN)
        time.sleep(i["handoff"].get("elapsed", 0.1))
        fcntl.flock(lock, fcntl.LOCK_EX)
        s2 = json.load(open(path)); s.clear(); s.update(s2)
        pane, i = s["panes"][pid], s["internal"][pid]
        pane["agent_status"] = i["handoff"].get("end_status", "done")
        write_handoff(pid)
    else:
        s.setdefault("resumes", []).append({"pane": pid, "text": text})
    print(json.dumps({"result": {}}))
elif args[:2] == ["pane", "send-text"]:
    pid, text = args[2], args[3]
    if pid not in s["panes"]: fail("pane_not_found")
    s["internal"][pid]["composer"] = s["internal"][pid].get("composer", "") + text
    print(json.dumps({"result": {}}))
elif args[:2] == ["pane", "send-keys"]:
    pid, key = args[2], args[3]
    if pid not in s["panes"]: fail("pane_not_found")
    i = s["internal"][pid]
    if key == "Enter" and i.get("composer") == "/clear":
        if i.get("ignore_first_enter") and not i.get("enter_ignored"):
            i["enter_ignored"] = True
        else:
            i["composer"] = ""  # Claude empties the input box at once; Herdr's new id comes a moment later
            i["clear_at"] = now + i.get("clear_delay", 0.3)
            if i.get("clear_delay", 0.3) == 0: i["clear_at"] = now
            s["panes"][pid]["agent_status"] = "working" if i["clear_at"] > now else s["panes"][pid]["agent_status"]
    print(json.dumps({"result": {}}))
elif args[:2] == ["session", "list"]:
    print(json.dumps({"sessions": [{"name": "e2e", "running": True, "default": False}]}))
else:
    sys.stderr.write("fake herdr: unsupported " + " ".join(args) + "\n"); save(); sys.exit(1)
save()
'''

SRC = Path(__file__).resolve().parent / "workspace-organizer.py"
root = Path(tempfile.mkdtemp(prefix="handoff-e2e-"))
print(f"scratch folder (left in place): {root}")
tool = root / "tool"; tool.mkdir(); (tool / "workspace-organizer.py").write_text(SRC.read_text())
bin_dir = root / "bin"; bin_dir.mkdir(); (bin_dir / "herdr").write_text(FAKE_HERDR); (bin_dir / "herdr").chmod(0o755)
home = root / "home"; home.mkdir()
fm = home / "fm-homes" / "h1"; (fm / "state").mkdir(parents=True); (fm / "data" / "handoffs").mkdir(parents=True); (fm / "bin").mkdir()
claude = root / "claude"; (claude / "handoffs").mkdir(parents=True); (claude / "projects").mkdir()
work = root / "work"; work.mkdir()
state_path = root / "state.json"
GOOD = "# Handoff\n\n## Restart list\n- not needed: nothing running\n"
env = {k: v for k, v in os.environ.items() if not k.startswith(("HERDR_", "FM_", "FAKE_"))}
env.update({
    "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_STATE": str(state_path), "FAKE_CLAUDE_DIR": str(claude),
    "HOME": str(home), "CLAUDE_CONFIG_DIR": str(claude), "HERDR_ORGANIZER_OWNER_STATE_DIRS": str(fm / "state"),
    "HERDR_ORGANIZER_HANDOFF_TIMESCALE": "0.05", "XDG_CONFIG_HOME": str(root / "config"),
})
CLI = [sys.executable, str(tool / "workspace-organizer.py"), "--session", "e2e"]
ok = lambda m: print("PASS", m)

def run(*args, check=None, extra_env=None):
    r = subprocess.run([*CLI, *args], env={**env, **(extra_env or {})}, capture_output=True, text=True)
    if check is not None: assert r.returncode == check, (args, r.returncode, r.stdout, r.stderr)
    return r

def state(): return json.loads(state_path.read_text())
def save(s): state_path.write_text(json.dumps(s))
def calls(prefix):
    return [c for c in state()["log"] if c[:len(prefix)] == prefix]
def sid_for(n): return f"{n:08x}-aaaa-4bbb-8ccc-{n:012d}"

def pane(pid, n, ws="w1", tab="w1:t1", status="idle", cwd=None, **internal):
    handoff = {"doc_path": str(fm / "data" / "handoffs" / f"doc-{pid.replace(':', '-')}.md"), "doc_text": GOOD}
    handoff.update(internal.pop("handoff", {}))
    pane_entry = {"pane_id": pid, "workspace_id": ws, "tab_id": tab, "agent": internal.pop("agent", "claude"), "agent_status": status,
                  "cwd": cwd or str(work / pid.replace(":", "-")), "foreground_cwd": cwd or str(work / pid.replace(":", "-")),
                  "focused": internal.pop("focused", False), "terminal_id": "term-" + pid,
                  "agent_session": {"agent": "claude", "kind": "id", "source": "herdr:claude", "value": sid_for(n)}}
    internal.setdefault("new_sid", sid_for(n + 5000))
    return pane_entry, {"handoff": handoff, **internal}

def world(*panes, workspaces=None, tabs=None):
    s = {"panes": {}, "internal": {}, "log": [], "last_request": "",
         "workspaces": workspaces or [{"workspace_id": "w1", "label": "Ordinary"}],
         "tabs": tabs or [{"workspace_id": "w1", "tab_id": "w1:t1", "label": "work"}]}
    for p, i in panes:
        s["panes"][p["pane_id"]] = p; s["internal"][p["pane_id"]] = i
    save(s)

def id8(n): return sid_for(n)[:8]
def ref(pid, n): return f"{pid}:{id8(n)}"
def preview(*refs, extra=(), extra_env=None):
    args = ["handoff-restart", "--json", *[x for r in refs for x in ("--pane", r)], *extra]
    r = run(*args, check=0, extra_env=extra_env); return json.loads(r.stdout)
def execute(refs, confirm=None, extra=(), check=None, extra_env=None):
    p = preview(*refs, extra=extra, extra_env=extra_env)
    args = ["handoff-restart", "--json", *[x for r in refs for x in ("--pane", r)], "--execute", "--confirm", confirm or p["confirm"], *extra]
    r = run(*args, check=check, extra_env=extra_env)
    try: out = json.loads(r.stdout)
    except ValueError: out = None
    return r, out
def pane_record(out, pid): return next(x for x in out["panes"] if x["pane_id"] == pid)
def typed(): return [c[3] for c in calls(["pane", "send-text"])]
def make_gauge(script_dir, body, mode=0o755):
    script_dir.mkdir(parents=True, exist_ok=True)
    path = script_dir / "fm-ctx-gauge.sh"; path.write_text("#!/bin/sh\n" + body); path.chmod(mode); return path
def no_gauge_home():
    # the one fixture home has no gauge script unless a test makes one
    g = fm / "bin" / "fm-ctx-gauge.sh"
    if g.exists() or g.is_symlink(): g.write_text("#!/bin/sh\nexit 0\n"); g.chmod(0o755)

# ---------------------------------------------------------------- classifier and screen proof, unit level (case 15, 17)
spec = importlib.util.spec_from_file_location("workspace_organizer", str(SRC)); wo = importlib.util.module_from_spec(spec); spec.loader.exec_module(wo)
RULE = "─" * 119
def screen(body_lines, composer="", extra_above=()):
    parts = composer.split("\n")
    return "\n".join(list(body_lines) + list(extra_above) + [RULE, "❯ " + parts[0]] + ["  " + x for x in parts[1:]] + [RULE, "  Opus 5.5 | ctx: 6% used"]) + "\n"
HEAD = [" ▐▛███▛█   Claude Code v2.1.310", "▝▜██████▀  Opus 5.5", " ▝▝   ▝▝   /tmp/x"]
MENU = ["  ❯ /clear                                         Start a new session with empty context", "    /wayfinder                                     Plan a huge chunk"]
cases = {
    "empty": (screen(HEAD), ("empty", "")),
    "empty with Ctrl+Y hint": (screen(HEAD, extra_above=["  Ctrl+Y to paste deleted text"]), ("empty", "")),
    "empty while a turn runs": (screen(HEAD + ["✳ Seasoning… (running UserPromptSubmit hook · 2s)"]), ("empty", "")),
    "typed single line": (screen(HEAD, "typed text probe"), ("typed", "typed text probe")),
    "typed wrapped": (screen(HEAD, "word " * 20 + "\nwrapped tail"), ("typed", ("word " * 20 + "\nwrapped tail").strip())),
    "typed two lines": (screen(HEAD, "line1\nline2"), ("typed", "line1\nline2")),
    "menu with /clear": (screen(HEAD, "/clear", MENU), ("menu", "/clear")),
    "menu with /cl": (screen(HEAD, "/cl", MENU), ("menu", "/cl")),
    "folder trust dialog": ("\n".join([" Quick safety check: Is this a project you trust?", " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"]) + "\n", ("dialog", None)),
    "permission dialog": ("\n".join([RULE, " Create file", " probe.txt", " Do you want to create probe.txt?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Tab to amend"]) + "\n", ("dialog", None)),
    "fewer than two rules": ("\n".join(HEAD + [RULE, "❯"]) + "\n", ("unknown", None)),
    "echo line far above the composer": (screen(HEAD + ["❯ an old prompt echo"] + [""] * 20), ("empty", "")),
}
for name, (text, want) in cases.items():
    assert wo.handoff_classify(text) == want, (name, wo.handoff_classify(text), want)
ok("classifier: " + ", ".join(cases))
assert [wo.handoff_composer_reason(c) for c in ("empty", "unknown", "dialog", "typed", "menu")] == [None, "composer_unknown", "dialog_open", "composer_not_empty", "composer_not_empty"]
ok("classifier classes map to the refusal codes")
FRESH = HEAD + ["▎ notice", "  1 more notice hidden", "❯ /clear"]
assert wo.handoff_screen_proof(screen(FRESH)); ok("screen proof: a fresh screen with one `❯ /clear` echo line holds")
assert wo.handoff_screen_proof(screen(HEAD + ["❯ /clear"])); ok("screen proof: no notice, the header ends at the folder line")
for bad, why in ((FRESH + ["⏺ a reply"], "a ⏺ line"), (FRESH + ["✻ Crunched for 4s"], "a ✻ line"), (FRESH + ["asks: " + wo.HANDOFF_REQUEST_ANCHOR], "the request text"),
                 (FRESH + ["HANDOFF_DOC: /x/y.md"], "a HANDOFF_DOC line"), (HEAD + ["❯ earlier", "❯ /clear"], "two lines"), (HEAD, "no echo line")):
    assert not wo.handoff_screen_proof(screen(bad)), why
ok("screen proof: refused with a ⏺ line, a ✻ line, the request text, HANDOFF_DOC, two lines or no echo line")
assert not wo.handoff_screen_proof(screen(FRESH, "typed")); ok("screen proof needs an empty composer")
assert wo.handoff_screen_proof(screen(FRESH).replace("Opus 5.5 | ctx: 6% used", "Opus 5.5 | ctx: 55% used")); ok("a footer ctx: text is ignored")

# ---------------------------------------------------------------- preview, confirm, refusals
no_gauge_home()
world(pane("w1:p1", 1), pane("w1:p2", 2))
r = run("handoff-restart", "--pane", ref("w1:p1", 1), check=0)
assert "Preview only. Re-run with --execute --confirm" in r.stdout and f"handoff-restart:e2e:{id8(1)}" in r.stdout, r.stdout
assert "HANDOFF_DOC" in r.stdout and calls(["pane", "send-text"]) == [] and calls(["agent", "prompt"]) == []; ok("preview prints the confirm string and the fixed texts, and sends nothing")
p = preview(ref("w1:p2", 2), ref("w1:p1", 1))
assert p["confirm"] == f"handoff-restart:e2e:{id8(1)},{id8(2)}" and [x["pane_id"] for x in p["to_restart"]] == ["w1:p2", "w1:p1"], p
ok("the confirm lists the ids sorted whatever the order of --pane")
for bad in ("wrong", f"handoff-restart:e2e:{id8(1)}", f"handoff-restart:e2e:{id8(2)},{id8(1)}", ""):
    r = run("handoff-restart", "--json", "--pane", ref("w1:p1", 1), "--pane", ref("w1:p2", 2), "--execute", *(["--confirm", bad] if bad else []), check=1)
assert calls(["pane", "send-text"]) == [] and calls(["agent", "prompt"]) == [] and not (tool / "state").exists(); ok("a confirm that does not name exactly the panes is refused; nothing sent, no record")
r = run("handoff-restart", "--pane", "w1:p1", check=1); assert "must look like" in r.stderr; ok("a pane reference without the 8 character id is refused")
r = run("handoff-restart", "--pane", "w1:p1:0123456", check=1); assert "must look like" in r.stderr
r = run("handoff-restart", "--pane=-x:01234567", check=1); assert "must look like" in r.stderr; ok("malformed references never reach Herdr")

# fleet fixtures: one pane per refusal reason, plus one ordinary pane
(fm / "state" / "owner-task.meta").write_text("backend=herdr\nherdr_session=e2e\nwindow=e2e:w1:p10\nherdr_workspace_id=w1\nherdr_tab_id=w1:t1\nherdr_pane_id=w1:p10\nkind=scout\n")
(fm / "state" / ".primary-control").write_text("pane=w1:p11\n")
make_gauge(fm / "bin", f'echo \'{{"session_id": "{sid_for(16)}", "kind": "scout", "map": "x"}}\'\necho \'{{"session_id": "{sid_for(99)}", "kind": "unmapped"}}\'\n')
panes = [
    pane("w1:p1", 1),                                                  # ordinary, accepted
    pane("w1:p10", 10), pane("w1:p11", 11),                           # owner record, primary control
    pane("w1:p12", 12, cwd=str(fm / "state" / ".treehouse" / "wt")),  # under a home root
    pane("w2:p13", 13, ws="w2", tab="w2:t1"),                          # leader-space workspace
    pane("w3:p14", 14, ws="w3", tab="w3:t1"),                          # fm- tab label
    pane("w1:p16", 16),                                                # only the gauge knows it (R3-3)
    pane("w4:p17", 17, ws="w4", tab="w4:t1"),                          # task workspace label form
    pane("w1:p20", 20, status="working"), pane("w1:p21", 21, status="blocked"), pane("w1:p22", 22, focused=True),
    pane("w1:p23", 23, composer="typed"), pane("w1:p24", 24, mode="dialog"), pane("w1:p25", 25, mode="unknown"),
    pane("w1:p26", 26, agent="codex"), pane("w1:p27", 27, status="unknown"), pane("w1:p28", 28, mode="spinner"),
]
world(*panes, workspaces=[{"workspace_id": "w1", "label": "Ordinary"}, {"workspace_id": "w2", "label": "leader-space"}, {"workspace_id": "w3", "label": "Other"},
                          {"workspace_id": "w4", "label": "└ fix the thing · p:abcDEFghi123"}],
      tabs=[{"workspace_id": "w1", "tab_id": "w1:t1", "label": "work"}, {"workspace_id": "w2", "tab_id": "w2:t1", "label": "main"},
            {"workspace_id": "w3", "tab_id": "w3:t1", "label": "fm-some-task"}, {"workspace_id": "w4", "tab_id": "w4:t1", "label": "plain"}])
refs = [ref(x["pane_id"], int(x["pane_id"].split("p")[1])) for x, _ in panes] + ["w1:p29:deadbeef", ref("w1:p1", 1)]
p = preview(*refs)
reasons = {x["pane_id"]: (x["reason"], x.get("fleet_rule")) for x in p["refused"]}
expect = {"w1:p10": ("fleet_pane", "owner_record"), "w1:p11": ("fleet_pane", "primary_control"), "w1:p12": ("fleet_pane", "under_home_root"),
          "w2:p13": ("fleet_pane", "leader_workspace"), "w3:p14": ("fleet_pane", "tab_label"), "w1:p16": ("fleet_pane", "gauge"),
          "w4:p17": ("fleet_pane", "task_workspace"), "w1:p20": ("working", None), "w1:p21": ("blocked", None), "w1:p22": ("focused", None),
          "w1:p23": ("composer_not_empty", None), "w1:p24": ("dialog_open", None), "w1:p25": ("composer_unknown", None), "w1:p26": ("not_claude", None),
          "w1:p27": ("not_idle", None), "w1:p28": ("empty", None), "w1:p29": ("session_moved", None)}
expect.pop("w1:p28")  # a running turn reads status working here, but the fake keeps it idle: it is accepted by the screen alone
assert [x["pane_id"] for x in p["to_restart"]] == ["w1:p1", "w1:p28"], p["to_restart"]
reasons_dup = [x for x in p["refused"] if x["reason"] == "duplicate"]
assert reasons_dup and reasons_dup[0]["pane_id"] == "w1:p1", p["refused"]
for k, v in expect.items(): assert reasons.get(k) == v, (k, reasons.get(k), v)
ok("every refusal reason and every fleet sub-reason is named, an ordinary pane is accepted, a repeated pane is a duplicate")
assert p["fleet_gauge"] == [{"home": 1, "rule6": "applied_no_watcher"}] and str(fm) not in json.dumps(p), p["fleet_gauge"]
ok("rule 6 ran with no flag and no environment (R4-8): the gauge refused the pane nothing else could see; home named by number, no path")
(fm / "state" / "owner-task.meta").write_text(""); (fm / "state" / ".primary-control").write_text("")

# ---------------------------------------------------------------- the happy path (case 1, 2, 16)
SID1 = sid_for(1)
def sid_free(out_text, extra=()):
    assert SID1 not in out_text and not any(x in out_text for x in extra)
for working_seen, delay in ((True, 0.5), (False, 0.0)):
    world(pane("w1:p1", 1, clear_delay=delay))
    r, out = execute([ref("w1:p1", 1)], check=0)
    rec = pane_record(out, "w1:p1")
    assert rec["state"] == "sent" and rec["id8_before"] == id8(1) and rec["id8_after"] == id8(5001) and rec["clear_proof"] == "session_id_changed", rec
    assert typed() == ["/clear"], typed()
    assert len(calls(["pane", "send-keys"])) == 1 and calls(["pane", "send-keys"])[0][3] == "Enter", (calls(["pane", "send-keys"]), out["panes"])
    prompts = [c[3] for c in calls(["agent", "prompt"])]
    assert len(prompts) == 2 and prompts[0] == wo.HANDOFF_REQUEST and prompts[1].startswith("Read " + str(fm / "data" / "handoffs" / "doc-w1-p1.md") + " and continue."), prompts
    assert state()["resumes"][0]["pane"] == "w1:p1"
    assert rec["document"] == str(fm / "data" / "handoffs" / "doc-w1-p1.md")
    record_text = Path(out["record"]).read_text()
    sid_free(record_text + r.stdout + r.stderr, [sid_for(5001)])
    assert stat.S_IMODE(os.stat(out["record"]).st_mode) == 0o600
    assert rec["clear_typed_at"] and rec["ask_started_at"]
    ok(f"happy path ({'working state seen' if working_seen else 'id changes at once'}): ask, document, clear typed once, one new id, resume sent; record 0600; no full session id anywhere")
all_state_text = "".join(p.read_text() for p in (tool / "state").rglob("*.json"))
sid_free(all_state_text, [sid_for(5001)]); ok("the full session id is in no file of the tool's state folder")

# ---------------------------------------------------------------- /clear that never changes the id (case 3, 14, 17)
world(pane("w1:p1", 1, clear_mode="never_proof"))
r, out = execute([ref("w1:p1", 1)], check=0); rec = pane_record(out, "w1:p1")
assert rec["state"] == "sent" and rec["clear_proof"] == "screen" and rec["session_value_unchanged"] and rec["id8_after"] == id8(1), rec
assert typed() == ["/clear"] and len(state()["resumes"]) == 1; ok("id never changes but the screen proves the clear: cleared_by_screen path, resume sent, session_value_unchanged recorded")
world(pane("w1:p1", 1, clear_mode="never_noproof"))
r, out = execute([ref("w1:p1", 1)], check=1); rec = pane_record(out, "w1:p1")
doc = str(fm / "data" / "handoffs" / "doc-w1-p1.md")
assert rec["state"] == "typed_unconfirmed" and typed() == ["/clear"] and not state().get("resumes"), rec
assert out["resume_lines"] == [f"w1:p1: /clear was typed and may have run. Resume it by hand with: Read {doc} and continue. First start every entry under \"## Restart list\" again."], out["resume_lines"]
ok("id never changes and the screen proof fails: typed_unconfirmed, no step 5, no second /clear, the exact resume line printed")
r = run("handoff-restart", *[x for rr in [ref("w1:p1", 1)] for x in ("--pane", rr)], "--execute", "--confirm", f"handoff-restart:e2e:{id8(1)}", check=1)
assert "Resume it by hand with: Read " in r.stdout; ok("the plain output prints the same resume line")

# an Enter that Claude ignores is retried, the text is never typed again
world(pane("w1:p1", 1, ignore_first_enter=True))
r, out = execute([ref("w1:p1", 1)], check=0)
assert pane_record(out, "w1:p1")["state"] == "sent" and typed() == ["/clear"] and len(calls(["pane", "send-keys"])) == 2; ok("Enter alone is retried once when the composer still shows /clear; the text is typed once")

# ---------------------------------------------------------------- gates (case 4, 5, 6, 10, 11)
world(pane("w1:p1", 1, handoff={"doc_text": "# Handoff\n\nno list here\n"}))
r, out = execute([ref("w1:p1", 1)], check=1); rec = pane_record(out, "w1:p1")
assert rec["state"] == "needs_you" and rec["reason"] == "document_invalid" and rec["detail"] == "no_restart_list" and typed() == []; ok("missing ## Restart list: needs_you, nothing cleared")
world(pane("w1:p1", 1, handoff={"doc_text": "# Handoff\n\n## Restart list\n\n\n## Next\n- x\n"}))
r, out = execute([ref("w1:p1", 1)], check=1); assert pane_record(out, "w1:p1")["detail"] == "no_restart_list" and typed() == []; ok("an empty ## Restart list: needs_you, nothing cleared")
world(pane("w1:p1", 1, status="idle", prompt_mode="stall"))
r, out = execute([ref("w1:p1", 1)], check=1); rec = pane_record(out, "w1:p1")
assert rec["reason"] == "prompt_unconfirmed" and typed() == [] and len([c for c in calls(["agent", "prompt"])]) == 1; ok("a stalled /handoff prompt is needs_you and is never retried")
world(pane("w1:p1", 1, handoff={"end_status": "blocked"}))
r, out = execute([ref("w1:p1", 1)], check=1); assert pane_record(out, "w1:p1")["reason"] == "blocked" and typed() == []; ok("blocked after the request: needs_you, nothing typed")
world(pane("w1:p1", 1, handoff={"after": {"new_session": sid_for(777)}}))
r, out = execute([ref("w1:p1", 1)], check=1); assert pane_record(out, "w1:p1")["reason"] == "session_moved" and typed() == []; ok("the pane id reused by another session between steps: session_moved, nothing sent")
world(pane("w1:p1", 1, handoff={"after": {"focused": True}}))
r, out = execute([ref("w1:p1", 1)], check=1); assert pane_record(out, "w1:p1")["reason"] == "focused" and typed() == []; ok("focus taken mid-run: needs_you at the quiet gate, nothing typed")
world(pane("w1:p1", 1, handoff={"after": {"composer": "half a sentence"}}))
r, out = execute([ref("w1:p1", 1)], check=1); assert pane_record(out, "w1:p1")["reason"] == "composer_not_empty" and typed() == []; ok("text typed into the pane mid-run: needs_you, nothing typed")
world(pane("w1:p1", 1), pane("w1:p2", 2, handoff={"end_status": "blocked"}))
r, out = execute([ref("w1:p1", 1), ref("w1:p2", 2)], check=1)
assert pane_record(out, "w1:p1")["state"] == "sent" and pane_record(out, "w1:p2")["state"] == "needs_you" and typed() == ["/clear"]; ok("two panes where one fails: the other still finishes, exit 1")
world(pane("w1:p1", 1, status="working"))
r = run("handoff-restart", "--json", "--pane", ref("w1:p1", 1), "--execute", "--confirm", f"handoff-restart:e2e:{id8(1)}", check=1)
out = json.loads(r.stdout); assert out["refused"][0]["reason"] == "working" and out["panes"] == [] and calls(["agent", "prompt"]) == []; ok("a working pane is refused at execute before anything is sent")

# ---------------------------------------------------------------- the document checks (case 9, 16)
other = root / "elsewhere"; other.mkdir()
(home / "fm-homes" / "h9" / "data" / "handoffs").mkdir(parents=True)
doc_counter = [0]
def doc_case(label, handoff, want_reason, want_detail=None, n=1):
    doc_counter[0] += 1
    handoff = dict(handoff)
    handoff.setdefault("doc_path", str(fm / "data" / "handoffs" / f"case-{doc_counter[0]}.md"))
    if "marker" in handoff: handoff["marker"] = handoff["marker"].replace("{doc}", handoff["doc_path"])
    if "symlink_target" in handoff: handoff["symlink_target"] = str(fm / "data" / "handoffs" / f"real-target-{doc_counter[0]}.md")
    world(pane("w1:p1", n, handoff=handoff))
    r, out = execute([ref("w1:p1", n)], check=1); rec = pane_record(out, "w1:p1")
    assert rec["reason"] == want_reason and rec.get("detail") == want_detail and typed() == [], (label, rec)
    ok("document check: " + label)
doc_case("a symlink is refused", {"symlink_target": "set by doc_case"}, "document_invalid", "symlink")
doc_case("outside every allowlisted root", {"doc_path": str(other / "x.md")}, "document_invalid", "outside_allowlist")
doc_case("a home that is not listed", {"doc_path": str(home / "fm-homes" / "h9" / "data" / "handoffs" / "x.md")}, "document_invalid", "outside_allowlist")
doc_case("older than the request", {"mtime_offset": -3600}, "document_invalid", "stale")
doc_case("over 1 MB", {"large": True}, "document_invalid", "too_large")
doc_case("a path with a space never matches the marker", {"doc_path": str(fm / "data" / "handoffs" / "a b.md")}, "no_handoff_marker")
doc_case("a marker that is not the last line is not found", {"marker": "HANDOFF_DOC: /x/y.md\nnot the last"}, "no_handoff_marker")
doc_case("an indented marker is not accepted", {"marker": "  HANDOFF_DOC: {doc}"}, "no_handoff_marker")
doc_case("a document that was never written", {"write_doc": False}, "document_invalid", "missing")
doc_case("no marker at all", {"write_marker": False}, "no_handoff_marker")
doc_case("two transcripts for one id", {"projects": ["proj-a", "proj-b"]}, "transcript_unavailable", n=77)
world(pane("w1:p1", 1, handoff={"doc_path": str(claude / "handoffs" / "doc.md")}))
r, out = execute([ref("w1:p1", 1)], check=0); assert pane_record(out, "w1:p1")["state"] == "sent"; ok("a document under the user's own handoffs folder is accepted")
world(pane("w1:p1", 1, handoff={"marker_delay": 0.15}))
r, out = execute([ref("w1:p1", 1)], check=0); assert pane_record(out, "w1:p1")["state"] == "sent"; ok("a marker that lands a moment late is found by the one-second polling")
world(pane("w1:p1", 1, handoff={"marker_delay": 30}))
t0 = time.time(); r, out = execute([ref("w1:p1", 1)], check=1)
assert pane_record(out, "w1:p1")["reason"] == "no_handoff_marker" and typed() == []; ok("no marker within the wait: no_handoff_marker, nothing typed")
world(pane("w1:p1", 1, history=["❯ earlier", "", "  HANDOFF_DOC: " + str(fm / "data" / "handoffs" / "doc-w1-p1-") [:100], "  wrapped.md"], handoff={"write_marker": False}))
r, out = execute([ref("w1:p1", 1)], check=1); assert pane_record(out, "w1:p1")["reason"] == "no_handoff_marker"; ok("a marker only on screen, indented and hard-wrapped, is never used")
world(pane("w1:p1", 78, handoff={"projects": []})); r, out = execute([ref("w1:p1", 78)], check=1); assert pane_record(out, "w1:p1")["reason"] == "transcript_unavailable"; ok("no transcript file: transcript_unavailable")

# ---------------------------------------------------------------- the request's echo and an old marker never count
world(pane("w1:p1", 1)); r, out = execute([ref("w1:p1", 1)], check=0)
assert wo.handoff_transcript_marker(next((claude / "projects" / "proj-a").glob(f"{sid_for(1)}.jsonl"))) == str(fm / "data" / "handoffs" / "doc-w1-p1.md"); ok("the request's own echo and an earlier HANDOFF_DOC line are never taken for the marker")

# ---------------------------------------------------------------- rule 6 states (SPEC-6 test)
def lock_home(home_dir, pid, code_root, with_gauge, alive_identity=False, group_writable=False, link=False, fail=False):
    st = home_dir / "state"; st.mkdir(parents=True, exist_ok=True)
    owner = st / ".watch.lock.owner.TEST"; owner.mkdir(exist_ok=True)
    (code_root / "bin").mkdir(parents=True, exist_ok=True)
    (code_root / "bin" / "fm-watch.sh").write_text("#!/bin/sh\n")
    ident = ""
    if alive_identity:
        ident = subprocess.run(["ps", "-p", str(pid), "-o", "lstart=", "-o", "command="], env={**os.environ, "COLUMNS": "10000", "LC_ALL": "C"}, capture_output=True, text=True).stdout.strip("\n").lstrip()
    for name, value in (("pid", str(pid)), ("fm-home", str(home_dir) + "/"), ("watcher-path", str(code_root / "bin" / "fm-watch.sh")), ("pid-identity", ident)):
        (owner / name).write_text(value + "\n")
    lock = st / ".watch.lock"
    if not lock.is_symlink(): os.symlink(owner.name, lock)
    (st / ".last-watcher-beat").write_text("")
    if with_gauge:
        body = "exit 1\n" if fail else f'echo \'{{"session_id": "{sid_for(16)}", "kind": "scout"}}\'\n'
        if link:
            real = code_root / "real-gauge.sh"; real.write_text("#!/bin/sh\nexit 0\n"); real.chmod(0o755)
            os.symlink(real, code_root / "bin" / "fm-ctx-gauge.sh")
        else:
            make_gauge(code_root / "bin", body, 0o775 if group_writable else 0o755)
home2 = home / "fm-homes" / "h2"; code2 = root / "code2"
r3 = pane("w1:p16", 16)
def gauge_preview(label, want_states, owner_dirs, extra=(), extra_refs=None):
    world(pane("w1:p1", 1), r3)
    return preview(ref("w1:p1", 1), ref("w1:p16", 16), extra=extra, extra_env={"HERDR_ORGANIZER_OWNER_STATE_DIRS": os.pathsep.join(str(x) for x in owner_dirs)})
# a dead pid lock whose recorded code root has a gauge: rule 6 runs from it and refuses the pane no other rule sees
(fm / "bin" / "fm-ctx-gauge.sh").write_text("#!/bin/sh\nexit 0\n"); (fm / "bin" / "fm-ctx-gauge.sh").chmod(0o755)
lock_home(home2, 999999, code2, True)
p = gauge_preview("dead pid", None, [home2 / "state"])
assert p["fleet_gauge"] == [{"home": 1, "rule6": "applied_no_watcher"}] and {x["pane_id"]: x.get("fleet_rule") for x in p["refused"]}.get("w1:p16") == "gauge", p
ok("a lock naming a dead pid, with a gauge under its recorded code root: rule 6 runs (applied_no_watcher) and refuses the gauge-only pane")
lock_home(home2, os.getpid(), code2, True, alive_identity=True)
p = gauge_preview("live", None, [home2 / "state"]); assert p["fleet_gauge"] == [{"home": 1, "rule6": "applied"}], p["fleet_gauge"]; ok("a running watcher (pid, identity, beat, home all match) reads as applied")
home3 = home / "fm-homes" / "h3"; (home3 / "state").mkdir(parents=True)
p = gauge_preview("no gauge", None, [home3 / "state"]); assert p["fleet_gauge"] == [{"home": 1, "rule6": "no_gauge"}] and not [x for x in p["refused"] if x["pane_id"] == "w1:p16"], p
ok("a home with no gauge anywhere is no_gauge and refuses nothing")
home4 = home / "fm-homes" / "h4"; code4 = root / "code4"; lock_home(home4, 999999, code4, True, link=True)
p = gauge_preview("link", None, [home4 / "state"]); assert p["fleet_gauge"] == [{"home": 1, "rule6": "failed"}], p; ok("a gauge that is a link is failed")
home5 = home / "fm-homes" / "h5"; code5 = root / "code5"; lock_home(home5, 999999, code5, True, group_writable=True)
p = gauge_preview("group writable", None, [home5 / "state"]); assert p["fleet_gauge"] == [{"home": 1, "rule6": "failed"}], p; ok("a gauge writable by the group is failed")
home6 = home / "fm-homes" / "h6"; code6 = root / "code6"; lock_home(home6, os.getpid(), code6, True, alive_identity=True, fail=True)
extra_env6 = {"HERDR_ORGANIZER_OWNER_STATE_DIRS": str(home6 / "state")}
world(pane("w1:p1", 1, handoff={"doc_path": str(claude / "handoffs" / "skip.md")}))
r = run("handoff-restart", "--json", "--pane", ref("w1:p1", 1), "--execute", "--confirm", f"handoff-restart:e2e:{id8(1)}", check=1, extra_env=extra_env6)
assert "fleet_gauge_incomplete" in r.stderr and calls(["agent", "prompt"]) == [] and calls(["pane", "send-text"]) == []; ok("a failed gauge makes --execute refuse with fleet_gauge_incomplete; nothing sent")
r, out = execute([ref("w1:p1", 1)], extra=["--skip-fleet-gauge"], check=0, extra_env=extra_env6)
rec_file = json.loads(Path(out["record"]).read_text()); assert rec_file["skip_fleet_gauge"] is True and rec_file["fleet_gauge"] == [{"home": 1, "rule6": "skipped_by_choice"}] and pane_record(out, "w1:p1")["state"] == "sent"
ok("--skip-fleet-gauge lets the run through and the record says rule 6 was skipped by choice")
home7 = home / "fm-homes" / "h7"; (home7 / "state").mkdir(parents=True)
p = preview(ref("w1:p1", 1), extra=["--fleet-home", str(home7)], extra_env=extra_env6 | {"HERDR_ORGANIZER_OWNER_STATE_DIRS": ""})
assert [x["rule6"] for x in p["fleet_gauge"]] == ["no_gauge"]; ok("--fleet-home adds a home the usual folders do not reach")

# ---------------------------------------------------------------- interruption and the run lock (case 12, 13)
world(pane("w1:p1", 1, handoff={"elapsed": 4}), pane("w1:p2", 2))
proc = subprocess.Popen([*CLI, "handoff-restart", "--json", "--pane", ref("w1:p1", 1), "--execute", "--confirm", f"handoff-restart:e2e:{id8(1)}"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
time.sleep(1.5)
r2 = run("handoff-restart", "--pane", ref("w1:p2", 2), "--execute", "--confirm", f"handoff-restart:e2e:{id8(2)}")
assert r2.returncode == 1 and "already in progress" in r2.stderr, (r2.stdout, r2.stderr); ok("a second run while one holds the lock is refused")
proc.send_signal(signal.SIGINT); out_text, err_text = proc.communicate(timeout=30)
assert proc.returncode == 1, (out_text, err_text); out = json.loads(out_text)
rec = pane_record(out, "w1:p1"); assert out["interrupted"] and rec["state"] == "interrupted" and typed() == [], rec
ok("Ctrl-C while the handoff is being written: the record says where it stopped, nothing was typed")
# Ctrl-C after /clear was typed: nothing is retyped and the resume line is printed
world(pane("w1:p1", 1, clear_mode="never_noproof", clear_delay=60))
proc = subprocess.Popen([*CLI, "handoff-restart", "--json", "--pane", ref("w1:p1", 1), "--execute", "--confirm", f"handoff-restart:e2e:{id8(1)}"], env={**env, "HERDR_ORGANIZER_HANDOFF_TIMESCALE": "0.5"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
for _ in range(300):
    if state().get("internal", {}).get("w1:p1", {}).get("clear_at"): break
    time.sleep(0.1)
else: raise AssertionError("the run never pressed Enter")
time.sleep(0.5); proc.send_signal(signal.SIGINT); out_text, err_text = proc.communicate(timeout=60)
out = json.loads(out_text); rec = pane_record(out, "w1:p1")
assert proc.returncode == 1 and rec["state"] == "interrupted" and typed() == ["/clear"] and len(calls(["pane", "send-keys"])) == 1, (rec, typed())
assert len(out["resume_lines"]) == 1 and "Resume it by hand with: Read " in out["resume_lines"][0] and not state().get("resumes"); ok("Ctrl-C after the Enter: nothing is retyped, the resume line is printed")
assert not (tool / "state" / "workspace-organizer" / "batches").exists(); ok("handoff-restart never writes batch or archive records")
print("ALL HANDOFF-RESTART CHECKS PASSED")
