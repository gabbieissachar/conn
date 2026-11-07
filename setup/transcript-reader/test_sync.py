"""Tests for sync.py: --build-only, the hosted copy's incremental build (its objects, its
manifest: what a run builds again and what it leaves, and that the objects hold what the
local page's payload holds), and --seal, the sync agent sealing a local bucket folder.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_sync.py
Fixtures are synthetic logs and fleet records in a temporary folder; Herdr is faked. The
sealing needs Node (upload.js); the passphrase is made up.
"""

import argparse
import base64
import gc
import io
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync  # noqa: E402
from sync import builder  # noqa: E402

A = "aaaaaaaa-1111-4111-8111-111111111111"  # the main home's session, which names a document
W = "bbbbbbbb-2222-4222-8222-222222222222"  # a worker in its own copy inside the main home
M = "cccccccc-3333-4333-8333-333333333333"  # the second mate's session
X = "dddddddd-4444-4444-8444-444444444444"  # outside every fleet home
N = "eeeeeeee-5555-4555-8555-555555555555"  # A's pane after a /clear
PASS = "a made-up lab passphrase"

NOW = time.time()
T0 = float(int(NOW - 2 * 86400))  # whole seconds, so times read back from the logs compare equal
CLEAR = "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def user(text, at, cwd, **extra):
    return {"type": "user", "timestamp": iso(at), "cwd": cwd, "message": {"role": "user", "content": text}, **extra}


def say(text, at, cwd):
    return {"type": "assistant", "timestamp": iso(at), "cwd": cwd, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def tool(at, cwd, tool_input=None):
    return {"type": "assistant", "timestamp": iso(at), "cwd": cwd,
            "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Bash", "input": tool_input or {"command": "ls"}}]}}


def wake(task, at, cwd):
    text = f"<task-notification>\nfirstmate watcher wake\nsignal: /home/state/{task}.status\n</task-notification>"
    return user(text, at, cwd, origin={"kind": "task-notification"})


def write_log(path, records, written=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    if written:
        os.utime(path, (written, written))


def append_log(path, records):
    with path.open("a", encoding="utf-8") as handle:
        handle.write("".join(json.dumps(r) + "\n" for r in records))


class Lab:
    """A main home with a second mate, their session logs and fleet records, in a temporary folder."""

    def __init__(self, test):
        self.tmp = tempfile.TemporaryDirectory()
        test.addCleanup(self.tmp.cleanup)
        # The fleet timeline is off unless switched on; the lab builds with it on, and a test of the switch sets it as it needs.
        env = mock.patch.dict(os.environ, {builder.FLEET_TIMELINE_ENV: "on"})
        env.start()
        test.addCleanup(env.stop)
        root = Path(self.tmp.name).resolve()
        self.root, self.projects, self.out = root, root / "projects", root / "out" / "hosted"
        self.main, self.mate = root / "homes" / "main", root / "homes" / "mate" / "firstmate"
        self.stars = root / "config" / "pmos-transcript-reader" / "stars.json"
        self.worker = self.main / "state" / ".treehouse" / "proj-1" / "1" / "repo"
        for folder in (self.main / "state", self.mate / "state", self.main / "data", self.worker, root / "elsewhere"):
            folder.mkdir(parents=True, exist_ok=True)
        (self.main / "data" / "secondmates.md").write_text(f"- secondmate-mate - a mate (home: {self.mate}; projects: x)\n", encoding="utf-8")
        (self.main / "notes.md").write_text("# Notes\n\nThe plan.\n", encoding="utf-8")
        self.brief = self.main / "state" / "operational-inbox" / "1-fix.msg"
        self.brief.parent.mkdir(parents=True)
        self.brief.write_text("\u2063FIRSTMATE_OP: v1 launch-brief: # Role\nYou are a worker.\n# Task\nFix the login page.\n", encoding="utf-8")
        inbox = self.main / "state" / "fix-login.inbox" / "handled"
        inbox.mkdir(parents=True)
        (inbox / "1.msg").write_text(f"at={iso(T0 + 290)}\n--\n[fm-from-firstmate] Rebase onto main first.", encoding="utf-8")
        (self.main / "state" / "fix-login.status").write_text(
            f"working [at={int(T0 + 100)}]: started\nneeds-decision [key=layout] [at={int(T0 + 600)}]: pick a layout\n", encoding="utf-8")
        (self.main / "state" / "home-summary.json").write_text(json.dumps(
            {"valid": True, "generated": "x", "decisions_open": [{"id": "d1", "summary": "Pick a layout", "hold_age_days": 1}]}), encoding="utf-8")
        main, mate = str(self.main), str(self.mate)
        self.logs = {
            A: self.projects / "main" / f"{A}.jsonl", W: self.projects / "worker" / f"{W}.jsonl",
            M: self.projects / "mate" / f"{M}.jsonl", X: self.projects / "elsewhere" / f"{X}.jsonl",
        }
        write_log(self.logs[A], [
            user("Plan the login fix.", T0, main), tool(T0 + 10, main), say("Wrote the plan to `notes.md`. Should I start?", T0 + 20, main),
            user(": Firstmate instruction waiting: list \"$FM_TASK_INBOX\"/*.msg in your 'fix-login.inbox' steering inbox, read it.", T0 + 300, main),
            say("Rebased as asked.", T0 + 310, main),
            wake("fix-login", T0 + 660, main), say("The worker needs a layout. Which one do you want?", T0 + 670, main),
        ], T0 + 700)
        pointer = f": Firstmate operational input waiting: read '{self.brief}' and handle its contents as Firstmate operational input."
        write_log(self.logs[W], [user(pointer, T0 + 50, str(self.worker)), say("Done: the page logs in.", T0 + 90, str(self.worker))], T0 + 100)
        sheet = ("Two choices for the notes:\n\n| ID | Question | Answer |\n| --- | --- | --- |\n| A1 | Keep the intro? | `keep` / `drop` |\n"
                 "| A2 | Length | `short` / `long` |\n\nReply with: A1=...; A2=...")
        write_log(self.logs[M], [user("Check the release notes.", T0 + 30, mate), say("They read well. No action needed.", T0 + 40, mate),
                                 user("Any choices for me?", T0 + 42, mate), say(sheet, T0 + 44, mate)], T0 + 50)
        write_log(self.logs[X], [user("Unrelated work.", T0 + 5, str(root / "elsewhere")), say("Fine.", T0 + 6, str(root / "elsewhere"))], T0 + 10)
        self.panes = {A: {"label": "alpha", "title": "Alpha work", "herdr": "lab", "pane": "w1:p1", "status": "working"}}
        for patch in (mock.patch.object(builder, "PROJECTS", self.projects), mock.patch.object(builder, "herdr_panes", lambda: dict(self.panes)),
                      mock.patch.object(sync, "LOCAL_PANES", root / "out" / "pane-labels.json"), mock.patch.object(sync, "REOPENED", root / "out" / "reopened.txt"),
                      mock.patch.object(sync.reader, "LIST", root / "out" / "sessions.txt"),
                      mock.patch.dict(os.environ, {"PMOS_READER_STARS": str(self.stars)})):
            patch.start()
            test.addCleanup(patch.stop)

    def build(self, *extra):
        # Most tests exercise the full object/sealing contract. Keep that fixture explicit now that
        # a normal offline build defaults to the live-plus-starred scope.
        return self.build_only_args("--build-only", "--panes", "all", *extra)

    def build_only_args(self, *args):
        if "--panes" not in args:
            args = (*args, "--panes", "all")
        with mock.patch("sys.stdout"):
            return sync.main([*args, "--out", str(self.out), "--main-home", str(self.main)])

    def index(self):
        return json.loads((self.out / "index.json").read_text(encoding="utf-8"))

    def manifest(self):
        return json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))

    def object(self, rel):
        return json.loads((self.out / rel).read_text(encoding="utf-8"))

    def mtimes(self):
        return {str(p.relative_to(self.out)): p.stat().st_mtime_ns for folder in ("s", "d", "f") for p in (self.out / folder).glob("*.json")} | \
            {"index.html": (self.out / "index.html").stat().st_mtime_ns}

    def local_payload(self, sessions):
        """What the local page embeds for these sessions (build_prototype.build, as reader.py runs it)."""
        args = argparse.Namespace(main_home=str(self.main), home=None, session=sessions, since_hours=None,
                                  out=str(self.root / "out" / "prototype.html"), stats=False)
        return builder.build(args)


def wait_a_tick():
    time.sleep(0.01)  # so a file written again gets a newer mtime_ns than the one recorded


class FirstBuildTest(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(self)
        self.assertEqual(self.lab.build(), 0)
        self.index = self.lab.index()

    def test_every_fleet_session_gets_one_object_and_an_index_entry(self):
        ids = [entry["id"] for entry in self.index["conversations"]]
        self.assertEqual(sorted(ids), sorted([A, W, M]))  # X works outside every fleet home
        for entry in self.index["conversations"]:
            self.assertEqual(entry["object"], f"s/{entry['id']}.json")
            self.assertTrue((self.lab.out / entry["object"]).is_file())
        self.assertEqual(ids[0], A, "newest activity first")
        worker = next(entry for entry in self.index["conversations"] if entry["id"] == W)
        self.assertEqual((worker["home"], worker["where"]), ("main", "worker copy"))
        mate = next(entry for entry in self.index["conversations"] if entry["id"] == M)
        self.assertEqual(mate["home"], "secondmate-mate")

    def test_the_index_carries_the_pane_as_of_the_build_and_what_waits_on_you(self):
        alpha = self.index["conversations"][0]
        self.assertEqual((alpha["pane"]["label"], alpha["pane"]["status"], alpha["pane"]["live"]), ("alpha", "working", True))
        self.assertEqual(alpha["needs"], 2, "two asks since your last message")
        self.assertEqual(alpha["last"], T0 + 670)
        self.assertLessEqual(self.index["as_of"], time.time())
        self.assertEqual(self.index["homes"], ["main", "secondmate-mate"])
        self.assertEqual(self.index["summaries"][0]["decisions_open"][0]["id"], "d1")

    def test_a_named_document_is_its_own_object(self):
        [(doc_id, meta)] = self.index["documents"].items()
        self.assertEqual((meta["name"], meta["object"]), ("notes.md", f"d/{doc_id}.json"))
        self.assertEqual(self.lab.object(meta["object"])["text"], "# Notes\n\nThe plan.\n")
        turns = self.lab.object(f"s/{A}.json")["exchanges"]
        self.assertEqual(turns[0]["documents"], [doc_id])

    def test_fleet_records_go_to_week_objects_linked_to_the_turn_that_handled_them(self):
        events = [e for meta in self.index["weeks"].values() for e in self.lab.object(meta["object"])["events"]]
        status = [e for e in events if e["kind"] == "status"]
        self.assertEqual([e["state"] for e in status], ["working", "needs-decision"])
        decision = status[1]
        self.assertTrue(decision["open"])
        self.assertEqual((decision["session"], decision["ref"]), (A, 2))  # the wake-up turn that read it
        self.assertEqual(sum(meta["open"] for meta in self.index["weeks"].values()), 1)
        inbox = [e for e in events if e["kind"] == "inbox"]
        self.assertEqual(inbox[0]["text"], "Rebase onto main first.")
        replies = [e for e in events if e["kind"] == "reply"]
        self.assertTrue(all("\n" not in e["text"] for e in replies))

    def test_the_shell_is_the_reader_page_with_no_transcript_in_it(self):
        page = (self.lab.out / "index.html").read_text(encoding="utf-8")
        # The hosted shell is both lazy (one conversation at a time) and without a laptop (its send queues): the page's two flags.
        for line in ('const MODE = "hosted";', 'const LAZY = MODE === "hosted" || MODE === "live";', 'const HOSTED = MODE === "hosted";'):
            self.assertIn(line, page)
        self.assertIn('<script id="payload" type="application/json">null</script>', page)
        self.assertIn(f'<meta name="template" content="{self.index["template"]}">', page)
        self.assertNotIn("Plan the login fix", page)

    def test_the_manifest_records_each_log_version(self):
        record = self.lab.manifest()["conversations"][A]
        self.assertEqual(record["members"], [str(self.lab.logs[A])])
        self.assertEqual(record["versions"][str(self.lab.logs[A])], sync.version(self.lab.logs[A]))
        self.assertNotIn("found", record)


class CodexRolloutEntryTest(unittest.TestCase):
    """A Herdr Codex pane can report its rollout filename instead of its native id."""

    def test_rollout_name_is_normalized_and_one_unreadable_session_does_not_stop_the_rest(self):
        lab = Lab(self)
        native = "01a1a025-b884-78a0-a670-94ebc603c956"
        rollout_name = "rollout-2026-11-03T13-43-09-" + native
        missing = "rollout-2026-11-03T13-44-09-ffffffff-3333-4333-8333-333333333333"
        codex = lab.root / "codex-sessions" / "2026" / "11" / "03"
        codex.mkdir(parents=True)
        rollout = codex / (rollout_name + ".jsonl")
        records = [
            {"type": "session_meta", "timestamp": "2026-11-03T13:43:09Z",
             "payload": {"id": native, "session_id": native, "cwd": str(lab.main), "source": "cli"}},
            {"type": "response_item", "timestamp": "2026-11-03T13:43:10Z",
             "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "codex ask"}]}},
            {"type": "response_item", "timestamp": "2026-11-03T13:43:11Z",
             "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "codex reply"}]}},
        ]
        write_log(rollout, records, NOW)
        lab.panes[rollout_name] = {"label": "codex-rollout", "title": "Codex work", "herdr": "lab", "pane": "w1:p2", "status": "working"}
        with mock.patch.object(sync.builder, "CODEX_SESSIONS", codex):
            result = lab.build_only_args("--build-only", "--session", missing, "--session", rollout_name, "--session", A)
        self.assertEqual(result, 0)
        index = lab.index()
        self.assertEqual(sorted(entry["id"] for entry in index["conversations"]), sorted([native, A]))
        self.assertEqual(sync.builder.find_session_file(native).stem, rollout_name)
        self.assertEqual(sync.builder.find_session_file(A).stem, A)
        self.assertEqual(lab.object(f"s/{native}.json")["exchanges"][-1]["reply"], "codex reply")
        self.assertEqual(lab.object(f"s/{A}.json")["exchanges"][-1]["reply"], "The worker needs a layout. Which one do you want?")


class ParityTest(unittest.TestCase):
    """The objects hold what the local page's payload holds for the same sessions."""

    def test_conversations_documents_and_fleet_match_the_local_payload(self):
        # The local page leaves the fleet timeline out unless it is switched on; the hosted copy's weeks are compared with it on.
        patcher = mock.patch.dict(os.environ, {builder.FLEET_TIMELINE_ENV: "on"})
        patcher.start()
        self.addCleanup(patcher.stop)
        lab = Lab(self)
        (lab.root / "out").mkdir(exist_ok=True)
        (lab.root / "out" / "sessions.txt").write_text(f"{A}\n{W}\n{M}\n", encoding="utf-8")
        lab.build("--reading-list")
        index = lab.index()
        payload = lab.local_payload([A, W, M])
        self.assertEqual([s["id"] for s in payload["sessions"]], [entry["id"] for entry in index["conversations"]])
        for session, entry in zip(payload["sessions"], index["conversations"]):
            local = {key: value for key, value in session.items() if key not in ("pane", "reopened")}
            self.assertEqual(lab.object(entry["object"]), json.loads(json.dumps(local)), session["id"])
            self.assertEqual(entry["pane"], session["pane"])
        for doc_id, doc in payload["documents"].items():
            self.assertEqual(lab.object(index["documents"][doc_id]["object"]), doc)
        self.assertEqual(index["since"], payload["since"])
        fleet = [e for key in sorted(index["weeks"]) for e in lab.object(index["weeks"][key]["object"])["events"]]
        trimmed = [{**e, "text": sync.first_line(e["text"])} if e["kind"] in ("captain", "reply") else e for e in payload["fleet"]]
        self.assertEqual(fleet, json.loads(json.dumps(trimmed)))
        self.assertEqual(index["summaries"], payload["summaries"])


class FleetTimelineSwitchTest(unittest.TestCase):
    """PMOS_READER_FLEET_TIMELINE decides whether the local build collects the fleet timeline; nothing else about the payload moves."""

    def lab(self):
        lab = Lab(self)
        (lab.root / "out").mkdir(exist_ok=True)
        (lab.root / "out" / "sessions.txt").write_text(f"{A}\n{W}\n{M}\n", encoding="utf-8")
        return lab

    def payload(self, lab, value):
        with mock.patch.dict(os.environ):
            os.environ.pop(builder.FLEET_TIMELINE_ENV, None)
            if value is not None:
                os.environ[builder.FLEET_TIMELINE_ENV] = value
            return lab.local_payload([A, W, M])

    def test_off_by_default_the_build_collects_no_fleet_records_and_says_so(self):
        lab = self.lab()
        for value in (None, "", "off", "0", "no"):
            off = self.payload(lab, value)
            self.assertEqual(off["fleet"], [], value)
            self.assertIs(off["fleet_timeline"], False, value)

    def test_on_restores_the_timeline_exactly_and_the_rest_of_the_payload_is_the_same(self):
        lab = self.lab()
        off = self.payload(lab, None)
        for value in ("1", "on", "ON", "true", "yes"):
            on = self.payload(lab, value)
            self.assertTrue(on["fleet"], value)
            self.assertIs(on["fleet_timeline"], True, value)
            self.assertEqual({k: v for k, v in on.items() if k not in ("fleet", "fleet_timeline", "generated")},
                             {k: v for k, v in off.items() if k not in ("fleet", "fleet_timeline", "generated")}, value)


class OfflineFleetTimelineSwitchTest(unittest.TestCase):
    """PMOS_READER_FLEET_TIMELINE decides whether the offline copy carries the fleet timeline: on is the copy as it was, off leaves it out."""

    def build(self, lab, value, *extra):
        with mock.patch.dict(os.environ):
            os.environ.pop(builder.FLEET_TIMELINE_ENV, None)
            if value is not None:
                os.environ[builder.FLEET_TIMELINE_ENV] = value
            return lab.build(*extra)

    def weeks_on_disk(self, lab):
        return sorted(path.name for path in (lab.out / "f").glob("*"))

    def test_off_by_default_nothing_of_the_timeline_is_collected_written_or_listed(self):
        for value in (None, "", "off", "0", "no"):
            lab = Lab(self)
            with mock.patch.object(builder, "collect_fleet", wraps=builder.collect_fleet) as collect:
                self.assertEqual(self.build(lab, value), 0)
            self.assertEqual(collect.call_count, 0, value)
            index, manifest = lab.index(), lab.manifest()
            self.assertEqual((index["weeks"], manifest["weeks"], self.weeks_on_disk(lab)), ({}, {}, []), value)
            self.assertIs(index["fleet_timeline"], False, value)
            self.assertTrue(all(not record["events"] for record in manifest["conversations"].values()), value)
            self.assertEqual(sorted(entry["id"] for entry in index["conversations"]), sorted([A, W, M]), value)

    def test_on_is_the_copy_it_was_and_says_nothing_extra_in_the_index(self):
        for value in ("1", "on", "ON", "true", "yes"):
            lab = Lab(self)
            self.assertEqual(self.build(lab, value), 0)
            index = lab.index()
            self.assertNotIn("fleet_timeline", index, value)
            self.assertTrue(index["weeks"] and self.weeks_on_disk(lab), value)

    def test_off_changes_nothing_but_the_weeks_and_the_flag(self):
        lab = Lab(self)
        on_out, off_out = lab.out, lab.root / "out" / "hosted-off"
        self.build(lab, "on")
        lab.out = off_out  # one lab, two output folders: the patches of a second lab would replace the first's
        self.build(lab, None)
        keep = lambda index: {k: v for k, v in index.items() if k not in ("weeks", "fleet_timeline", "as_of", "since", "steps_from")}  # noqa: E731
        lab.out = on_out
        on = lab.index()
        lab.out = off_out
        self.assertEqual(keep(on), keep(lab.index()))
        for entry in on["conversations"]:
            lab.out = on_out
            was = lab.object(entry["object"])
            lab.out = off_out
            self.assertEqual(was, lab.object(entry["object"]))

    def test_switching_on_again_restores_the_weeks_exactly_and_off_removes_them(self):
        lab = Lab(self)
        home = lab.out
        lab.out = lab.root / "out" / "hosted-fresh"  # the same lab, built once straight with the timeline on
        self.build(lab, "on")
        weeks_fresh, index_fresh = self.weeks_on_disk(lab), lab.index()["weeks"]
        fresh_objects = {name: lab.object(f"f/{name}") for name in weeks_fresh}
        lab.out = home
        self.assertEqual(self.build(lab, None), 0)
        self.assertEqual(self.weeks_on_disk(lab), [])
        self.assertEqual(self.build(lab, "on"), 0)  # a build that kept the conversations parsed with the switch off would lose their events
        self.assertEqual(self.weeks_on_disk(lab), weeks_fresh)
        self.assertTrue(weeks_fresh)
        self.assertEqual(lab.index()["weeks"], index_fresh)
        self.assertNotIn("fleet_timeline", lab.index())
        for name in weeks_fresh:
            self.assertEqual(lab.object(f"f/{name}"), fresh_objects[name])
        self.assertEqual(self.build(lab, None), 0)
        self.assertEqual((self.weeks_on_disk(lab), lab.index()["weeks"]), ([], {}))

    def test_the_sealed_copy_of_an_off_build_holds_no_week(self):
        lab = Lab(self)
        self.build(lab, None)
        index, manifest = lab.index(), lab.manifest()
        bucket_index, objects = sync.Seal(lab.out, lab.root / "bucket", PASS).retained(index, manifest)
        self.assertEqual(bucket_index["weeks"], {})
        self.assertFalse([rel for rel in objects if rel.startswith("f/")])
        self.assertIs(bucket_index["fleet_timeline"], False)

    def test_the_printed_launch_agent_carries_the_switch_when_it_is_on(self):
        env = lambda plist: plist.split("<key>EnvironmentVariables</key>")[1].split("</dict>")[0]  # noqa: E731
        for value in ("on", "1", "TRUE", "yes"):
            with mock.patch.dict(os.environ, {builder.FLEET_TIMELINE_ENV: value}):
                plist = sync.launch_agent(Path("/tmp/x"))
            self.assertIn(f"<key>{builder.FLEET_TIMELINE_ENV}</key><string>on</string>", env(plist), value)
            self.assertIn("<key>PATH</key>", env(plist))
        for value in (None, "", "off", "0"):
            with mock.patch.dict(os.environ):
                os.environ.pop(builder.FLEET_TIMELINE_ENV, None)
                if value is not None:
                    os.environ[builder.FLEET_TIMELINE_ENV] = value
                plist = sync.launch_agent(Path("/tmp/x"))
            self.assertNotIn(builder.FLEET_TIMELINE_ENV, plist, value)


class PanesScopeTest(unittest.TestCase):
    """--panes: open (live Herdr panes plus starred sessions) or all (every session in scope)."""

    def lab(self):
        lab = Lab(self)
        (lab.root / "out").mkdir(exist_ok=True)
        return lab

    def ids(self, lab):
        return sorted(entry["id"] for entry in lab.index()["conversations"])

    def objects(self, lab):
        return sorted(str(p.relative_to(lab.out)) for folder in ("s", "d", "a", "f") for p in (lab.out / folder).glob("*"))

    def test_live_sessions_are_the_default_and_all_remains_an_explicit_scope(self):
        lab = self.lab()
        self.assertEqual(lab.build_only_args("--build-only", "--panes", "open"), 0)  # only A has a live pane
        self.assertEqual(self.ids(lab), [A])
        self.assertEqual(lab.build("--panes", "all"), 0)
        self.assertEqual(self.ids(lab), sorted([A, W, M]))

    def test_open_keeps_live_panes_and_parses_nothing_else(self):
        lab = self.lab()
        with mock.patch.object(builder, "parsed_log", wraps=builder.parsed_log) as parsed:
            self.assertEqual(lab.build("--panes", "open"), 0)
        self.assertEqual(self.ids(lab), [A])
        self.assertEqual({call.args[0] for call in parsed.call_args_list}, {lab.logs[A]})
        (lab.root / "out" / "reopened.txt").write_text(f"{M}\n", encoding="utf-8")
        self.assertEqual(lab.build("--panes", "open"), 0)
        self.assertEqual(self.ids(lab), [A], "an unstarred reopened session is not part of the offline live-plus-starred copy")

    def test_the_build_carries_live_and_starred_conversations(self):
        lab = self.lab()
        lab.stars.parent.mkdir(parents=True, exist_ok=True)
        lab.stars.write_text(json.dumps({"version": 1, "rev": 2, "stars": [
            {"conv": M, "starred": 2}, {"conv": A, "starred": 1},
        ]}), encoding="utf-8")
        self.assertEqual(lab.build_only_args("--build-only", "--panes", "open"), 0)
        self.assertEqual([entry["id"] for entry in lab.index()["conversations"]], [A, M])
        self.assertEqual(lab.index()["stars"], [{"conv": M, "starred": 2}, {"conv": A, "starred": 1}])

    def test_narrowing_prunes_the_dropped_objects_documents_and_sheets_and_widening_brings_them_back(self):
        lab = self.lab()
        lab.build()
        everything = self.objects(lab)
        self.assertTrue(any(rel.startswith("a/") for rel in everything) and any(rel.startswith("d/") for rel in everything))
        lab.panes = {M: {"label": "mate", "title": "Mate work", "herdr": "lab", "pane": "w1:p2", "status": "working"}}
        self.assertEqual(lab.build("--panes", "open"), 0)
        self.assertEqual(self.ids(lab), [M])
        self.assertEqual(self.objects(lab), [rel for rel in self.objects(lab) if rel in everything])
        self.assertEqual([rel for rel in self.objects(lab) if rel[0] in "sda"], [f"a/{M}.json", f"s/{M}.json"], "A's conversation and its document are gone")
        index, manifest = lab.index(), lab.manifest()
        self.assertEqual((sorted(manifest["conversations"]), index["documents"]), ([M], {}))
        bucket_index, objects = sync.Seal(lab.out, lab.root / "bucket", PASS).retained(index, manifest)
        self.assertEqual({rel for rel in objects if rel[0] in "sda"}, {f"a/{M}.json", f"s/{M}.json"})
        self.assertEqual([entry["id"] for entry in bucket_index["conversations"]], [M])
        self.assertEqual(lab.build("--panes", "all"), 0)
        self.assertEqual(self.objects(lab), everything)

    def test_open_with_no_live_pane_stops_and_leaves_the_copy_as_it_is(self):
        lab = self.lab()
        lab.build()
        before = {rel: (lab.out / rel).read_bytes() for rel in self.objects(lab)}
        lab.panes = {}
        self.assertEqual(lab.build("--panes", "open"), 1)
        self.assertEqual(self.ids(lab), sorted([A, W, M]))
        self.assertEqual({rel: (lab.out / rel).read_bytes() for rel in self.objects(lab)}, before)

    def test_open_with_no_live_pane_still_builds_a_starred_conversation(self):
        lab = self.lab()
        lab.stars.parent.mkdir(parents=True, exist_ok=True)
        lab.stars.write_text(json.dumps({"stars": [{"conv": M, "starred": 1}]}), encoding="utf-8")
        lab.panes = {}
        self.assertEqual(lab.build("--panes", "open"), 0)
        self.assertEqual(self.ids(lab), [M])

    def test_the_printed_launch_agent_carries_the_scope(self):
        self.assertIn("--seal", sync.launch_agent(Path("/tmp/x")))
        self.assertNotIn("--panes", sync.launch_agent(Path("/tmp/x")))
        self.assertIn(f'--seal "{Path("/tmp/x").resolve()}" --panes open', sync.launch_agent(Path("/tmp/x"), "open"))
        with mock.patch("sys.stdout", new_callable=io.StringIO) as printed:
            sync.main(["--launch-agent", "/tmp/x", "--panes", "open"])
        self.assertIn("--panes open", printed.getvalue())

    def run_preview(self, lab, *extra):
        with mock.patch("sys.stdout", new_callable=io.StringIO) as printed, mock.patch("getpass.getpass", side_effect=AssertionError("asked for a passphrase")):
            code = sync.main(["--preview", *extra, "--out", str(lab.out), "--main-home", str(lab.main)])
        return code, printed.getvalue()

    def test_the_preview_lists_what_is_in_and_out_and_writes_nothing(self):
        lab = self.lab()
        lab.build()
        (lab.root / "out" / "reopened.txt").write_text(f"{W}\n", encoding="utf-8")

        def snapshot():
            return {str(p.relative_to(lab.root)): (p.stat().st_mtime_ns, p.stat().st_size) for p in lab.root.rglob("*") if p.is_file()}
        before = snapshot()
        code, text = self.run_preview(lab, "--panes", "open")
        self.assertEqual(code, 0)
        self.assertEqual(snapshot(), before, "nothing is written, not even a cache")
        included = text.split("Included (")[1].split("Left out: ")[0]
        self.assertIn("Would build 1 of 3 conversations (1 with a live pane, 0 reopened, 0 closed)", text)
        self.assertIn("alpha", included)
        self.assertNotIn("Alpha work", text, "named by the Herdr label, not the picker title")
        self.assertIn("open", included)
        self.assertNotIn("reopened", included)
        self.assertIn("Left out: 2", text)
        self.assertNotIn("secondmate-mate", text, "the left-out list is opt-in")
        self.assertIn("--show-left-out", text)
        code, text = self.run_preview(lab, "--panes", "open", "--show-left-out")
        left = text.split("Left out (")[1]
        self.assertIn("secondmate-mate", left)
        self.assertIn("closed", left)
        self.assertIn("Estimated size", text)
        self.assertIn("Would remove 2 conversations", text)
        code, text = self.run_preview(lab)
        self.assertIn("Would build 1 of 3 conversations", text)
        self.assertIn("Left out: 2", text)

    def test_the_preview_names_a_closed_pane_by_its_cached_label_and_does_not_cut_it(self):
        lab = self.lab()
        label = "fm-2026-10-27-esim-flag-test-dogfood-runbook"
        lab.panes = {A: {**lab.panes[A], "label": label}}
        code, text = self.run_preview(lab, "--panes", "all")
        self.assertIn(label, text)
        lab.panes = {}
        (lab.root / "out").mkdir(exist_ok=True)
        (lab.root / "out" / "pane-labels.json").write_text(json.dumps({A: {"label": label, "title": "x", "herdr": "lab", "pane": "w1:p1"}}), encoding="utf-8")
        code, text = self.run_preview(lab, "--panes", "all")
        self.assertIn(label, text)
        self.assertIn("closed", text)

    def test_the_preview_with_no_live_pane_says_why_it_stops(self):
        lab = self.lab()
        lab.panes = {}
        code, text = self.run_preview(lab, "--panes", "open")
        self.assertEqual(code, 1)
        self.assertIn("no live pane", text)


class AnswerSheetTest(unittest.TestCase):
    """The hosted copy's answer sheet holds what the local answer sheet holds for the same sessions."""

    def test_the_questionnaires_match_the_local_sheet(self):
        lab = Lab(self)
        lab.build()
        index = lab.index()
        self.assertEqual(list(index["sheets"]), [M])
        sheet = index["sheets"][M]
        self.assertEqual(sheet["object"], f"a/{M}.json")
        self.assertEqual([(item["open"], item["title"]) for item in sheet["list"]], [(2, "Two choices for the notes:")])
        with mock.patch.object(sync.questionnaires, "OUT", lab.root / "out"):
            local = sync.questionnaires.collect([A, W, M])
        self.assertEqual(lab.object(sheet["object"])["questionnaires"], json.loads(json.dumps([{k: v for k, v in q.items() if k != "pane"} for q in local])))
        self.assertEqual([c["key"] for c in local[0]["cards"]], ["A1", "A2"])
        page = (lab.out / "sheet.html").read_text(encoding="utf-8")
        self.assertIn('const MODE = "hosted";', page)
        self.assertIn('const HOSTED = MODE === "hosted";', page)
        self.assertIn(f'<meta name="template" content="{index["sheet_template"]}">', page)
        reply = next(t for t in lab.object(f"s/{M}.json")["exchanges"] if t.get("sheet"))
        self.assertEqual(reply["sheet"], f"{M[:8]}:{round(sheet['list'][0]['at'])}", "the conversation's button opens this questionnaire")


class IncrementalTest(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(self)
        self.lab.build()
        self.before = self.lab.mtimes()
        wait_a_tick()

    def changed(self):
        after = self.lab.mtimes()
        return sorted(rel for rel in set(after) | set(self.before) if after.get(rel) != self.before.get(rel))

    def test_nothing_changed_writes_nothing(self):
        stamps = {entry["id"]: entry["stamp"] for entry in self.lab.index()["conversations"]}
        self.lab.build()
        self.assertEqual(self.changed(), [])
        self.assertEqual({entry["id"]: entry["stamp"] for entry in self.lab.index()["conversations"]}, stamps)

    def test_a_new_turn_parses_and_writes_only_its_conversation(self):
        stamp = next(e for e in self.lab.index()["conversations"] if e["id"] == A)["stamp"]
        append_log(self.lab.logs[M], [user("And the changelog?", T0 + 900, str(self.lab.mate)), say("Updated.", T0 + 910, str(self.lab.mate))])
        with mock.patch.object(builder, "parsed_log", wraps=builder.parsed_log) as builds, \
                mock.patch.object(builder, "iter_jsonl", wraps=builder.iter_jsonl) as parses:
            self.lab.build()
        self.assertEqual({call.args[0] for call in builds.call_args_list}, {self.lab.logs[M]})
        self.assertEqual([call.args[0] for call in parses.call_args_list], [self.lab.logs[M]])
        self.assertIn(f"s/{M}.json", self.changed())
        self.assertNotIn(f"s/{A}.json", self.changed())
        conversations = self.lab.index()["conversations"]
        entry = next(e for e in conversations if e["id"] == M)
        self.assertEqual((entry["turns"], entry["last"], conversations[0]["id"]), (3, T0 + 910, M))
        self.assertEqual(next(e for e in conversations if e["id"] == A)["stamp"], stamp)

    def test_a_clear_moves_the_conversation_to_the_panes_newest_session(self):
        main = str(self.lab.main)
        os.utime(self.lab.logs[A], (T0 + 1000, T0 + 1000))  # the clear writes the old log's last records
        write_log(self.lab.projects / "main" / f"{N}.jsonl", [user(CLEAR, T0 + 1000.5, main), user("Next task.", T0 + 1100, main),
                                                           say("Starting it.", T0 + 1110, main)], T0 + 1110)
        self.lab.build()
        index = self.lab.index()
        conversation = next(e for e in index["conversations"] if N in e["ids"])
        self.assertEqual((conversation["id"], conversation["ids"]), (N, [A, N]))
        self.assertFalse((self.lab.out / f"s/{A}.json").exists())
        self.assertEqual(len(index["conversations"]), 3)
        turns = self.lab.object(f"s/{N}.json")["exchanges"]
        self.assertEqual([t["kind"] for t in turns if t["kind"] in ("cleared", "current")], ["cleared", "current"])

    def test_a_session_leaving_the_scope_takes_its_object_away(self):
        self.lab.build("--session", A, "--session", M)
        self.assertEqual(sorted(e["id"] for e in self.lab.index()["conversations"]), sorted([A, M]))
        self.assertFalse((self.lab.out / f"s/{W}.json").exists())
        self.assertIn(f"s/{A}.json", self.lab.mtimes())

    def test_a_changed_document_is_written_again_without_its_conversation(self):
        notes = self.lab.main / "notes.md"
        notes.write_text("# Notes\n\nThe plan, revised.\n", encoding="utf-8")
        self.lab.build()
        [doc_id] = self.lab.index()["documents"]
        self.assertEqual(self.changed(), [f"d/{doc_id}.json"])
        self.assertEqual(self.lab.object(f"d/{doc_id}.json")["text"], "# Notes\n\nThe plan, revised.\n")

    def test_a_document_that_is_gone_leaves_the_index_and_comes_back_with_its_file(self):
        notes = self.lab.main / "notes.md"
        text = notes.read_text(encoding="utf-8")
        notes.unlink()
        self.lab.build()
        self.assertEqual(self.lab.index()["documents"], {})
        notes.write_text(text, encoding="utf-8")
        self.lab.build()
        self.assertEqual([meta["name"] for meta in self.lab.index()["documents"].values()], ["notes.md"])

    def test_a_new_status_line_writes_only_its_week(self):
        status = self.lab.main / "state" / "fix-login.status"
        status.write_text(status.read_text(encoding="utf-8") + f"resolved [key=layout] [at={int(T0 + 800)}]: picked\n", encoding="utf-8")
        self.lab.build()
        changed = self.changed()
        self.assertTrue(changed and all(rel.startswith("f/") for rel in changed), changed)
        self.assertEqual(sum(meta["open"] for meta in self.lab.index()["weeks"].values()), 0)

    def test_full_builds_everything_again_but_writes_only_what_changed(self):
        with mock.patch.object(builder, "parsed_log", wraps=builder.parsed_log) as builds, \
                mock.patch.object(builder, "iter_jsonl", wraps=builder.iter_jsonl) as parses:
            self.lab.build("--full")
        self.assertEqual({call.args[0] for call in builds.call_args_list}, set(self.lab.logs.values()) - {self.lab.logs[X]})
        self.assertEqual(parses.call_count, 0, "unchanged logs come from the parsed-log cache")
        self.assertEqual(self.changed(), [])

    def test_a_log_either_build_parsed_is_not_parsed_again(self):
        self.assertTrue((self.lab.root / "out" / "parsed" / f"{A}.json").is_file())
        with mock.patch.object(builder, "iter_jsonl", wraps=builder.iter_jsonl) as parses:
            self.lab.local_payload([A, W, M])
        self.assertEqual(parses.call_count, 0)

    def test_a_rules_change_reaches_every_object_without_full(self):
        # The reviewer's repro: change a label rule; the local page follows, so must the hosted copy.
        original = builder.wake_label

        def relabel(text):
            kind, label = original(text)
            return kind, label + "!"
        with mock.patch.object(builder, "PARSE_RULES", "another-version"), mock.patch.object(builder, "wake_label", relabel):
            self.lab.build()
        labels = [t["label"] for t in self.lab.object(f"s/{A}.json")["exchanges"] if t["source"] == "wake"]
        self.assertEqual(labels, ["New status from fix-login!"])
        self.assertIn(f"s/{A}.json", self.changed())

    def test_a_new_steering_message_reaches_its_conversation_alone(self):
        inbox = self.lab.main / "state" / "fix-login.inbox"
        (inbox / "2.msg").write_text(f"at={iso(T0 + 295)}\n--\n[fm-from-firstmate] Then run the tests.", encoding="utf-8")
        with mock.patch.object(builder, "parsed_log", wraps=builder.parsed_log) as builds:
            self.lab.build()
        self.assertEqual({call.args[0] for call in builds.call_args_list}, {self.lab.logs[A]})
        steer = next(t for t in self.lab.object(f"s/{A}.json")["exchanges"] if t["kind"] == "steer")
        self.assertEqual(steer["delivered"], ["Then run the tests.", "Rebase onto main first."])
        # Moved to handled/ once read: built again, in the order the local page now shows (handled ones by name).
        (inbox / "2.msg").rename(inbox / "handled" / "2.msg")
        with mock.patch.object(builder, "parsed_log", wraps=builder.parsed_log) as builds:
            self.lab.build()
        self.assertEqual({call.args[0] for call in builds.call_args_list}, {self.lab.logs[A]})
        steer = next(t for t in self.lab.object(f"s/{A}.json")["exchanges"] if t["kind"] == "steer")
        self.assertEqual(steer["delivered"], ["Rebase onto main first.", "Then run the tests."])
        self.assertEqual(json.loads(json.dumps(self.lab.local_payload([A])["sessions"][0]["exchanges"])), self.lab.object(f"s/{A}.json")["exchanges"])

    def test_edited_task_instructions_reach_the_worker_alone(self):
        self.lab.brief.write_text("\u2063FIRSTMATE_OP: v1 launch-brief: # Role\nYou are a worker.\n# Task\nFix the login page and its test.\n", encoding="utf-8")
        self.lab.build()
        brief = self.lab.object(f"s/{W}.json")["exchanges"][0]
        self.assertEqual((brief["kind"], brief["delivered"]), ("brief", ["# Task\nFix the login page and its test."]))
        self.assertEqual(self.changed(), [f"s/{W}.json"])

    def test_a_deleted_object_is_written_again(self):
        (self.lab.out / f"s/{W}.json").unlink()
        self.lab.build()
        self.assertTrue((self.lab.out / f"s/{W}.json").is_file())

    def test_a_manifest_of_another_version_rebuilds_from_scratch(self):
        manifest = self.lab.manifest()
        manifest["version"] = 0
        (self.lab.out / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        with mock.patch.object(builder, "parsed_log", wraps=builder.parsed_log) as builds:
            self.lab.build()
        self.assertEqual(len({call.args[0] for call in builds.call_args_list}), 3)


class PrivateTest(unittest.TestCase):
    """The copy carries the logs' text, so every folder and file of it is the owner's alone, whatever the umask."""

    def test_the_build_and_the_sealed_bucket_are_owner_only(self):
        lab = Lab(self)
        target = lab.root / "out" / "bucket"
        before = os.umask(0o022)
        self.addCleanup(os.umask, before)
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS}):
            self.assertEqual(lab.build_only_args("--seal", str(target)), 0)
        seen = 0
        for top in (lab.out, target):
            for path in [top, *top.rglob("*")]:
                mode = path.stat().st_mode & 0o777
                self.assertEqual(mode, 0o700 if path.is_dir() else 0o600, f"{path.relative_to(lab.root)} is {oct(mode)}")
                seen += 1
        self.assertGreater(seen, 20)


class HerdrEnvTest(unittest.TestCase):
    def test_the_herdr_calls_of_a_build_do_not_carry_the_sync_passphrase(self):
        seen = []

        def fake(argv, **options):
            seen.append((argv, options.get("env")))
            return subprocess.CompletedProcess(argv, 1, "", "")  # no Herdr running: nothing is read

        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS, "KEEP_ME": "1"}), mock.patch.object(builder.subprocess, "run", fake):
            builder.herdr_panes()
        self.assertTrue(seen)
        for argv, env in seen:
            self.assertEqual(argv[0], "herdr")
            self.assertNotIn(sync.PASSPHRASE_ENV, env)
            self.assertEqual(env["KEEP_ME"], "1")


class CommandTest(unittest.TestCase):
    def test_build_only_is_the_only_mode(self):
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit) as stop:
            sync.main([])
        self.assertEqual(stop.exception.code, 2)

    def test_an_unknown_session_is_refused(self):
        lab = Lab(self)
        with self.assertRaises(SystemExit):
            lab.build("--session", "ffffffff-0000-4000-8000-000000000000")


class LinkTurnsTest(unittest.TestCase):
    """The indexed link_turns gives what the plain search over every turn gave."""

    @staticmethod
    def plain(fleet, sessions, window=1800):
        for event in fleet:
            if event["kind"] not in ("status", "inbox") or "session" in event:
                continue
            home = event["home"] if event["kind"] == "status" else event["to"]
            best = None
            for session in sessions:
                if session["home"] != home:
                    continue
                for index, exchange in enumerate(session["exchanges"]):
                    if exchange["at"] is None or not 0 <= exchange["at"] - event["at"] <= window:
                        continue
                    if event["kind"] == "status":
                        matches = event["task"] in [exchange.get("signal_task")] + [n["signal_task"] for n in exchange["notices"]]
                    else:
                        matches = exchange["source"] == "firstmate"
                    if matches and (best is None or exchange["at"] < best[0]):
                        best = (exchange["at"], session["id"], index)
            if best:
                event["session"], event["ref"] = best[1], best[2]

    def test_random_fleets(self):
        rng = random.Random(7)
        for _ in range(200):
            sessions = [{"home": rng.choice("ab"), "id": f"s{n}", "exchanges": [
                {"at": rng.choice([None, rng.randrange(0, 4000, 50)]), "source": rng.choice(["firstmate", "wake", "captain"]),
                 "signal_task": rng.choice([None, "t1", "t2"]), "notices": [{"signal_task": rng.choice(["t1", "t2"])}] * rng.randrange(2)}
                for _ in range(rng.randrange(6))]} for n in range(rng.randrange(1, 4))]
            fleet = [{"kind": rng.choice(["status", "inbox", "reply"]), "home": rng.choice("ab"), "to": rng.choice("ab"),
                      "task": rng.choice(["t1", "t2"]), "at": rng.randrange(0, 4000, 25)} for _ in range(8)]
            mine, theirs = json.loads(json.dumps(fleet)), json.loads(json.dumps(fleet))
            builder.link_turns(mine, sessions)
            self.plain(theirs, sessions)
            self.assertEqual(mine, theirs)


if __name__ == "__main__":
    unittest.main()


SEAL = Path(__file__).resolve().parent / "prototype" / "seal.js"
# Opens sealed objects of a bucket with the passphrase in the environment, as the shell does.
OPEN_JS = r"""
const fs = require('fs'), path = require('path');
const seal = require(process.argv[1]);
(async () => {
  const [folder, ...names] = process.argv.slice(2);
  const key = await seal.unlock(process.env.HOSTED_READER_PASSPHRASE, JSON.parse(fs.readFileSync(path.join(folder, 'k/params.json'))));
  const out = {};
  for (const name of names) out[name] = key && await seal.openJson(key, name, fs.readFileSync(path.join(folder, name + '.enc')));
  console.log(JSON.stringify(out));
})();
"""


PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63640000000600055a7ba4c70000000049454e44ae426082")


class LeaderTasksTest(unittest.TestCase):
    """A leader's conversation (run in a home with data, state and projects folders) carries its home's tasks into the copy; only the files its
    conversations name are in the copy, as before."""

    def setUp(self):
        self.lab = Lab(self)
        (self.lab.main / "projects").mkdir()
        self.backlog = self.lab.main / "data" / "backlog.md"
        self.backlog.write_text("# Backlog\n\n## In flight\n- [ ] fix-login - Fix the login page (repo: x)\n", encoding="utf-8")
        task = self.lab.main / "data" / "fix-login"
        task.mkdir()
        (task / "report.md").write_text("# Report\n", encoding="utf-8")
        self.lab.build()

    def leader(self):
        return self.lab.object(f"s/{A}.json")["leader"]

    def test_the_conversation_object_carries_the_homes_tasks_and_a_worker_carries_none(self):
        self.assertEqual(self.leader()["tasks"]["fix-login"], {"title": "Fix the login page", "state": "In flight"})
        self.assertNotIn("leader", self.lab.object(f"s/{W}.json"))
        self.assertNotIn("leader", self.lab.object(f"s/{M}.json"), "the mate's home has no projects folder here")

    def test_a_task_file_no_conversation_named_is_not_in_the_copy(self):
        self.assertEqual([meta["name"] for meta in self.lab.index()["documents"].values()], ["notes.md"])

    def test_a_changed_backlog_writes_the_leaders_conversation_again_and_no_other(self):
        before = self.lab.mtimes()
        wait_a_tick()
        self.backlog.write_text(self.backlog.read_text(encoding="utf-8").replace("## In flight\n- [ ]", "## Done\n- [x]"), encoding="utf-8")
        self.lab.build()
        self.assertEqual(self.leader()["tasks"]["fix-login"]["state"], "Done")
        after = self.lab.mtimes()
        self.assertIn(f"s/{A}.json", [rel for rel in after if after[rel] != before.get(rel)])
        self.assertEqual([rel for rel in after if after[rel] != before.get(rel) and rel.startswith("s/")], [f"s/{A}.json"])


class HtmlDocumentsTest(unittest.TestCase):
    """An HTML file a reply names is in the copy with the same name, location and size rules as the local viewer, folded into
    one text that the page shows in its sandboxed viewer (inline_html.py holds the rules; the page's viewer is tested in hosted.test.js)."""

    def setUp(self):
        self.lab = Lab(self)
        main = self.lab.main
        (main / "img").mkdir()
        (main / "img" / "dot.png").write_bytes(PNG)
        (main / ".private").mkdir()
        (main / ".private" / "secret.png").write_bytes(PNG)
        (main / "site.css").write_text("body { background: url(img/dot.png); } h1 { color: #123456; }", encoding="utf-8")
        (main / "app.js").write_text("document.title = 'sketch ran';", encoding="utf-8")
        (main / "sketch.html").write_text(
            '<!doctype html><html><head><link rel="stylesheet" href="site.css"><script src="app.js"></script></head><body><h1>Sketch</h1>'
            '<img src="img/dot.png"><img src=".private/secret.png"><img src="https://cdn.example/x.png"><img src="../escape.png"></body></html>', encoding="utf-8")
        (main / "escape.png").write_bytes(PNG)
        append_log(self.lab.logs[A], [user("Show me.", T0 + 800, str(main)), say("The sketch is `sketch.html`, and the notes are `notes.md`.", T0 + 810, str(main))])
        self.assertEqual(self.lab.build(), 0)

    def doc(self):
        index = self.lab.index()
        meta = next(m for m in index["documents"].values() if m["name"] == "sketch.html")
        return meta, self.lab.object(meta["object"])

    def test_the_html_file_is_a_document_of_kind_html_with_its_text_folded_into_one_file(self):
        meta, doc = self.doc()
        self.assertEqual((meta["kind"], meta["name"]), ("html", "sketch.html"))
        self.assertEqual(meta["size"], (self.lab.main / "sketch.html").stat().st_size)
        self.assertEqual(doc["kind"], "html")
        text = doc["text"]
        self.assertIn("sketch ran", text)  # the script, inline
        self.assertIn("#123456", text)  # the stylesheet, inline
        self.assertNotIn("<link", text)
        self.assertNotIn('src="app.js"', text)
        self.assertEqual(text.count("data:image/png;base64,"), 2, "the picture in the page and the one the stylesheet names")
        self.assertEqual(doc["inlined"], 3 + 0, "the stylesheet, the script and the picture, once each")
        # The markdown document beside it is unchanged.
        notes = next(m for m in self.lab.index()["documents"].values() if m["name"] == "notes.md")
        self.assertNotIn("kind", notes)

    def test_what_the_viewer_would_not_serve_is_left_out(self):
        _, doc = self.doc()
        text = doc["text"]
        self.assertIn('src=".private/secret.png"', text, "a dot folder is left as written, and so loads nothing")
        self.assertIn('src="../escape.png"', text, "a path out of the file's folder too")
        self.assertIn('src="https://cdn.example/x.png"', text, "and an address outside is left for the frame's own no-network rule")
        reasons = {item["ref"]: item["why"] for item in doc["skipped"]}
        self.assertEqual(reasons[".private/secret.png"], "a hidden file or folder")
        self.assertEqual(reasons["../escape.png"], "outside the file's folder")
        self.assertNotIn("https://cdn.example/x.png", reasons, "an absolute address is not a refusal, it is just not folded")

    def test_the_object_is_the_same_document_the_local_page_lists(self):
        local = self.lab.local_payload([str(self.lab.logs[A])])
        local_html = [d for d in local["documents"].values() if d.get("kind") == "html"]
        meta, _ = self.doc()
        self.assertEqual([(d["id"], d["name"], d["dir"]) for d in local_html], [(meta["id"], meta["name"], meta["dir"])])
        conversation = self.lab.object(f"s/{A}.json")
        named = [doc_id for e in conversation["exchanges"] for doc_id in e.get("documents", [])]
        self.assertIn(meta["id"], named)

    def test_a_change_to_a_file_beside_it_writes_the_document_again_and_nothing_else(self):
        before = self.lab.mtimes()
        wait_a_tick()
        self.assertEqual(self.lab.build(), 0)
        self.assertEqual(self.lab.mtimes(), before, "nothing changed, nothing written")
        meta, _ = self.doc()
        wait_a_tick()
        (self.lab.main / "site.css").write_text("h1 { color: #abcdef; }", encoding="utf-8")
        self.assertEqual(self.lab.build(), 0)
        changed = self.lab.mtimes()
        self.assertEqual([key for key in changed if changed[key] != before.get(key)], [meta["object"]])
        self.assertIn("#abcdef", self.lab.object(meta["object"])["text"])
        self.assertNotEqual(self.doc()[0]["stamp"], meta["stamp"])

    def test_a_file_over_the_viewers_limit_or_gone_leaves_the_index(self):
        (self.lab.main / "sketch.html").write_text("<p>" + "x" * (builder.MAX_HTML_BYTES + 1), encoding="utf-8")
        self.assertEqual(self.lab.build(), 0)
        self.assertNotIn("sketch.html", [m["name"] for m in self.lab.index()["documents"].values()])

    def test_a_file_directly_in_a_temp_folder_gets_only_its_own_folder(self):
        folder = Path(tempfile.mkdtemp(dir=tempfile.gettempdir()))
        self.addCleanup(lambda: shutil.rmtree(folder, ignore_errors=True))
        (folder / "deep").mkdir()
        (folder / "deep" / "x.png").write_bytes(PNG)
        (folder / "near.png").write_bytes(PNG)
        # A real temp root is flat: patch the roots so this folder is one.
        (folder / "flat.html").write_text('<img src="near.png"><img src="deep/x.png">', encoding="utf-8")
        with mock.patch.object(builder, "TEMP_ROOTS", (folder,)):
            folded = sync.inline_html.fold(folder / "flat.html", [folder])
        self.assertEqual(folded["text"].count("data:image/png"), 1)
        self.assertEqual([item["ref"] for item in folded["skipped"]], ["deep/x.png"])

    def test_a_sealed_copy_carries_the_html_document_redacted_and_the_laptop_keeps_the_original(self):
        secret = "ghp_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
        (self.lab.main / "app.js").write_text(f"var key = '{secret}'; document.title = 'sketch ran';", encoding="utf-8")
        target = self.lab.root / "out" / "bucket"
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS}):
            self.assertEqual(self.lab.build_only_args("--seal", str(target)), 0)
            meta, _ = self.doc()
            done = subprocess.run(["node", "-e", OPEN_JS, str(SEAL), str(target), meta["object"]], capture_output=True, text=True, env={**os.environ, sync.PASSPHRASE_ENV: PASS}, check=True)
        sealed = json.loads(done.stdout)[meta["object"]]
        self.assertEqual(sealed["kind"], "html")
        self.assertIn("[redacted:github-token]", sealed["text"])
        self.assertNotIn(secret, sealed["text"])
        self.assertIn(secret, self.lab.object(meta["object"])["text"])

    def test_a_large_picture_goes_through_redaction_in_good_time(self):
        picture = bytes(range(256)) * (3 * 1024 * 1024 // 256)  # 3 MB of bytes that are not a picture, as base64 a long unbroken line
        (self.lab.main / "img" / "big.png").write_bytes(picture)
        (self.lab.main / "sketch.html").write_text('<img src="img/big.png">', encoding="utf-8")
        target = self.lab.root / "out" / "bucket"
        started = time.time()
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS}):
            self.assertEqual(self.lab.build_only_args("--seal", str(target)), 0)
        self.assertLess(time.time() - started, 60)
        meta, _ = self.doc()
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS}):
            done = subprocess.run(["node", "-e", OPEN_JS, str(SEAL), str(target), meta["object"]], capture_output=True, text=True, env={**os.environ, sync.PASSPHRASE_ENV: PASS}, check=True)
        text = json.loads(done.stdout)[meta["object"]]["text"]
        self.assertIn(base64.b64encode(picture).decode("ascii"), text, "the picture itself comes through redaction whole")


class ImageDocumentsTest(unittest.TestCase):
    """An image a reply names is in the copy as its bytes in base64 (a document of kind image), within a limit for each image and for all
    of them; one the copy leaves out is listed with why and has no object, so the page can say so."""

    def setUp(self):
        self.lab = Lab(self)
        main = self.lab.main
        (main / "shot.png").write_bytes(PNG)
        (main / "mark.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>', encoding="utf-8")
        (main / "big.png").write_bytes(PNG + b"\0" * 4096)
        (main / "huge.jpg").write_bytes(b"\0" * 4096)
        os.utime(main / "huge.jpg", (T0, T0))  # the oldest
        append_log(self.lab.logs[A], [user("Show me.", T0 + 800, str(main)), say("See `shot.png`, `mark.svg`, `big.png` and `huge.jpg`.", T0 + 810, str(main))])

    def metas(self):
        return {m["name"]: m for m in self.lab.index()["documents"].values() if m.get("kind") == "image"}

    def test_an_image_is_a_document_whose_text_is_its_bytes_in_base64(self):
        self.assertEqual(self.lab.build(), 0)
        metas = self.metas()
        self.assertEqual(sorted(metas), ["big.png", "huge.jpg", "mark.svg", "shot.png"])
        shot = metas["shot.png"]
        self.assertEqual((shot["mime"], shot["size"]), ("image/png", len(PNG)))
        doc = self.lab.object(shot["object"])
        self.assertEqual(base64.b64decode(doc["text"]), PNG)
        self.assertEqual((doc["kind"], doc["mime"]), ("image", "image/png"))
        self.assertEqual(metas["mark.svg"]["mime"], "image/svg+xml", "an SVG is carried as bytes, and shown only in an <img> (the page)")
        self.assertEqual(self.lab.object(metas["mark.svg"]["object"])["text"], base64.b64encode((self.lab.main / "mark.svg").read_bytes()).decode("ascii"))

    def test_one_over_the_copys_limit_is_listed_as_left_out_with_no_object(self):
        with mock.patch.object(sync, "IMAGE_COPY_BYTES", 4000):
            self.assertEqual(self.lab.build(), 0)
        metas = self.metas()
        for name in ("big.png", "huge.jpg"):
            self.assertIn("one image", metas[name]["left_out"], name)
            self.assertNotIn("object", metas[name], name)
            self.assertFalse((self.lab.out / "d" / f"{metas[name]['id']}.json").exists(), name)
        self.assertNotIn("left_out", metas["shot.png"])
        # It comes back when the limit allows it, and the page's other objects are untouched.
        self.assertEqual(self.lab.build(), 0)
        self.assertIn("object", self.metas()["big.png"])

    def test_past_the_total_the_newest_files_are_carried_first(self):
        total = len(PNG) + (self.lab.main / "mark.svg").stat().st_size + (self.lab.main / "big.png").stat().st_size
        with mock.patch.object(sync, "IMAGE_COPY_TOTAL", total):
            self.assertEqual(self.lab.build(), 0)
        metas = self.metas()
        self.assertEqual(sorted(name for name, m in metas.items() if m.get("left_out")), ["huge.jpg"], "the oldest file is the one that does not fit")
        self.assertIn("all its images", metas["huge.jpg"]["left_out"])

    def test_a_sealed_copy_keeps_a_left_out_image_in_its_index_and_seals_no_object_for_it(self):
        target = self.lab.root / "out" / "bucket"
        with mock.patch.object(sync, "IMAGE_COPY_BYTES", 4000), mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS}):
            self.assertEqual(self.lab.build_only_args("--seal", str(target)), 0)
            done = subprocess.run(["node", "-e", OPEN_JS, str(SEAL), str(target), "index.json"], capture_output=True, text=True, env={**os.environ, sync.PASSPHRASE_ENV: PASS}, check=True)
        index = json.loads(done.stdout)["index.json"]
        left = [m for m in index["documents"].values() if m.get("left_out")]
        self.assertEqual(sorted(m["name"] for m in left), ["big.png", "huge.jpg"])
        self.assertEqual([m for m in left if "object" in m], [])
        self.assertTrue(list(target.glob("d/*.enc")), "the other documents are sealed")

    def test_the_local_page_lists_the_same_images_without_text(self):
        local = self.lab.local_payload([str(self.lab.logs[A])])
        found = {d["name"]: d for d in local["documents"].values() if d.get("kind") == "image"}
        self.assertEqual(sorted(found), ["big.png", "huge.jpg", "mark.svg", "shot.png"])
        self.assertNotIn("text", found["shot.png"])


S = "ffffffff-6666-4666-8666-666666666666"  # the owner's own session, in a folder under the workspace
S2 = "99999999-7777-4777-8777-777777777777"  # another of theirs, in a deeper folder


class WorkspaceTest(unittest.TestCase):
    """The owner's own working sessions (a working directory under ~/workspace) are in the default scope beside the
    fleet homes, grouped under their own heading, and everything still goes through redaction."""

    def setUp(self):
        self.lab = Lab(self)
        self.workspace = self.lab.root / "workspace"
        project = self.workspace / "pmos"
        deeper = self.workspace / "pmos" / "setup" / "tools"
        deeper.mkdir(parents=True)
        self.secret = "ghp_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
        write_log(self.lab.projects / "ws" / f"{S}.jsonl", [
            user("Draft the release note.", T0 + 400, str(project)), say(f"Drafted. The token {self.secret} was in your notes.", T0 + 410, str(project))], T0 + 420)
        write_log(self.lab.projects / "ws2" / f"{S2}.jsonl", [user("Check the tools.", T0 + 500, str(deeper)), say("Looks fine.", T0 + 510, str(deeper))], T0 + 520)
        # A folder that only starts with the same letters is not under the workspace.
        sibling = self.lab.root / "workspace-old"
        sibling.mkdir()
        write_log(self.lab.projects / "old" / f"{N}.jsonl", [user("Old things.", T0 + 600, str(sibling)), say("Done.", T0 + 610, str(sibling))], T0 + 620)

    def build(self, *extra):
        return self.lab.build("--workspace", str(self.workspace), *extra)

    def test_sessions_under_the_workspace_join_the_fleet_ones_under_their_own_group(self):
        self.assertEqual(self.build(), 0)
        index = self.lab.index()
        by_id = {e["id"]: e for e in index["conversations"]}
        self.assertEqual(sorted(by_id), sorted([A, W, M, S, S2]))
        self.assertEqual((by_id[S]["home"], by_id[S]["where"]), ("workspace", "pmos"))
        self.assertEqual((by_id[S2]["home"], by_id[S2]["where"]), ("workspace", "pmos/setup/tools"))
        self.assertEqual(by_id[A]["home"], "main", "a fleet session keeps its home")
        self.assertEqual(index["homes"][-1], "workspace")
        self.assertNotIn(X, by_id, "a session outside both is still out")
        self.assertNotIn(N, by_id, "so is a folder that merely starts with the workspace's name")
        session = self.lab.object(f"s/{S}.json")
        self.assertEqual(session["home"], "workspace")
        self.assertEqual([e["input"] for e in session["exchanges"]][:1], ["Draft the release note."])

    def test_a_workspace_session_shows_in_the_fleet_timeline_as_you_and_its_group(self):
        self.build()
        events = [e for f in self.lab.index()["weeks"].values() for e in self.lab.object(f["object"])["events"]]
        mine = [e for e in events if e.get("session") == S]
        self.assertTrue(any(e["kind"] == "captain" and e["to"] == "workspace" for e in mine), mine)

    def test_without_the_workspace_only_the_fleet_is_read(self):
        self.assertEqual(self.lab.build("--workspace", str(self.workspace), "--no-workspace"), 0)
        index = self.lab.index()
        self.assertEqual(sorted(e["id"] for e in index["conversations"]), sorted([A, W, M]))
        self.assertNotIn("workspace", index["homes"])

    def test_the_default_scope_is_the_workspace_folder_in_the_home_folder(self):
        self.assertEqual(sync.WORKSPACE, Path.home() / "workspace")
        with mock.patch.object(sync, "WORKSPACE", self.workspace):  # main() reads the default when it runs
            self.assertEqual(self.lab.build(), 0)
        self.assertIn(S, [e["id"] for e in self.lab.index()["conversations"]])

    def test_everything_from_the_workspace_is_redacted_before_it_is_sealed(self):
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS}):
            target = self.lab.root / "out" / "bucket"
            self.assertEqual(self.lab.build_only_args("--seal", str(target), "--workspace", str(self.workspace)), 0)
            done = subprocess.run(["node", "-e", OPEN_JS, str(SEAL), str(target), f"s/{S}.json", "index.json"], capture_output=True, text=True,
                                  env={**os.environ, sync.PASSPHRASE_ENV: PASS}, check=True)
        sealed = json.loads(done.stdout)
        text = json.dumps(sealed)
        self.assertIn("[redacted:github-token]", text)
        self.assertNotIn(self.secret, text)
        self.assertIn(self.secret, json.dumps(self.lab.object(f"s/{S}.json")), "the laptop keeps the original")
        self.assertIn(S, [e["id"] for e in sealed["index.json"]["conversations"]])


class StaticFilesTest(unittest.TestCase):
    """The offline copy's worker, manifest and icons sit beside the shell pages in the hosted copy and in the sealed bucket."""

    def setUp(self):
        self.lab = Lab(self)
        self.target = self.lab.root / "out" / "bucket"
        env = mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS})
        env.start()
        self.addCleanup(env.stop)

    def test_the_hosted_copy_has_the_worker_the_manifest_and_two_icons_and_a_sealed_run_copies_them(self):
        self.assertEqual(self.lab.build_only_args("--seal", str(self.target)), 0)
        for folder in (self.lab.out, self.target):
            self.assertEqual((folder / "sw.js").read_bytes(), (Path(sync.__file__).parent / "prototype" / "sw.js").read_bytes())
            manifest = json.loads((folder / "manifest.webmanifest").read_text(encoding="utf-8"))
            self.assertEqual((manifest["display"], manifest["start_url"], manifest["scope"]), ("standalone", "index.html", "./"))
            for name, size in (("icon-180.png", 180), ("icon-512.png", 512)):
                data = (folder / name).read_bytes()
                self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n", name)
                self.assertEqual(int.from_bytes(data[16:20], "big"), size, name)
            self.assertEqual({icon["src"] for icon in manifest["icons"]}, {"icon-180.png", "icon-512.png"})

    def test_a_changed_worker_reaches_the_bucket_at_once_and_wipe_takes_these_files_too(self):
        self.lab.build_only_args("--seal", str(self.target))
        (self.target / "sw.js").write_text("// an older worker", encoding="utf-8")
        self.lab.build_only_args("--seal", str(self.target))
        self.assertEqual((self.target / "sw.js").read_bytes(), (self.lab.out / "sw.js").read_bytes())
        self.lab.build_only_args("--wipe", str(self.target))
        self.assertEqual([path.name for path in self.target.iterdir() if path.is_file()], [])

    def test_the_shell_pages_allow_the_worker_and_the_manifest_in_their_policy_and_the_local_page_does_not(self):
        self.assertEqual(self.lab.build(), 0)
        hosted = (self.lab.out / "index.html").read_text(encoding="utf-8")
        self.assertIn("worker-src 'self'", hosted)
        self.assertIn('<link rel="manifest" href="manifest.webmanifest">', hosted)
        self.assertIn("worker-src 'self'", (self.lab.out / "sheet.html").read_text(encoding="utf-8"))
        local, _ = builder.fill_template(builder.TEMPLATE, "{}", "local")
        self.assertNotIn("worker-src", local)
        self.assertNotIn("manifest", local.split("</head>")[0])


def call(at, cwd, name, tool_input, call_id):
    return {"type": "assistant", "timestamp": iso(at), "cwd": cwd,
            "message": {"role": "assistant", "content": [{"type": "tool_use", "id": call_id, "name": name, "input": tool_input}]}}


def result(at, cwd, call_id, text, error=False, copy=None):
    record = {"type": "user", "timestamp": iso(at), "cwd": cwd,
              "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call_id, "content": text, **({"is_error": True} if error else {})}]}}
    if copy is not None:
        record["toolUseResult"] = copy
    return record


READ_TEXT = "TEXT-OF-A-FILE-THE-AGENT-READ"
COPY_TEXT = "SECOND-COPY-OF-AN-OUTPUT"
# Made up, and written in two pieces so no secret scanner takes it for a real credential.
FAKE_TOKEN = "abcdefghijklmnop" + "1234567890"
BEARER = "Bearer " + FAKE_TOKEN


class ToolStepsObjectsTest(unittest.TestCase):
    """Slice 7: a conversation's steps stay in its own object, its output text goes in an object of its own (t/<id>.json),
    and nothing the plan rules out ever reaches either."""

    def setUp(self):
        self.lab = Lab(self)
        main = str(self.lab.main)
        write_log(self.lab.logs[A], [
            user("Run the checks.", T0, main),
            call(T0 + 1, main, "Bash", {"command": "make check", "description": "Run the checks"}, "c1"),
            call(T0 + 2, main, "Read", {"file_path": "/work/app/settings.toml"}, "c2"),
            call(T0 + 3, main, "Bash", {"command": "curl -H 'Authorization: " + BEARER + "' https://api.example.test/"}, "c3"),
            result(T0 + 4, main, "c1", "checking\nall good\n", copy={"stdout": COPY_TEXT}),
            result(T0 + 5, main, "c2", READ_TEXT, copy={"file": {"content": READ_TEXT}}),
            result(T0 + 6, main, "c3", "failed with " + BEARER, error=True),
            say("Two of three ran.", T0 + 20, main),
        ], T0 + 700)
        self.assertEqual(self.lab.build(), 0)
        self.index = self.lab.index()
        self.entry = next(e for e in self.index["conversations"] if e["id"] == A)

    def objects(self):
        return sorted(str(p.relative_to(self.lab.out)) for folder in ("s", "t") for p in (self.lab.out / folder).glob("*.json"))

    def test_the_turns_keep_the_steps_and_the_output_text_is_in_its_own_object(self):
        turn = self.lab.object(f"s/{A}.json")["exchanges"][0]
        self.assertEqual([step["k"] for step in turn["steps"]], ["ran", "read", "ran"])
        self.assertTrue(all("out" not in step for step in turn["steps"]), "the turns carry no output text")
        self.assertEqual(self.entry["steps"]["object"], f"t/{A}.json")
        outputs = self.lab.object(f"t/{A}.json")["outputs"]
        self.assertEqual(outputs, {f"{turn['uid']}:0": "checking\nall good", f"{turn['uid']}:2": "failed with " + BEARER})
        self.assertEqual(turn["steps"][2]["f"], 1)
        self.assertTrue(turn["steps"][2]["t"].endswith(BEARER), "a failed step's tail travels with the turn")

    def test_nothing_the_plan_rules_out_is_in_any_object_of_the_copy(self):
        for path in self.lab.out.rglob("*"):
            if path.is_file() and path.suffix in (".json", ".html"):
                text = path.read_text(encoding="utf-8", errors="replace")
                self.assertNotIn(READ_TEXT, text, path)
                self.assertNotIn(COPY_TEXT, text, path)

    def test_the_index_names_the_window_the_build_computed_and_the_conversations_object(self):
        self.assertAlmostEqual(self.index["steps_from"], self.index["as_of"] - 7 * 86400, delta=1)
        self.assertEqual(self.entry["steps"]["stamp"], self.lab.manifest()["conversations"][A]["steps"]["stamp"])
        other = next(e for e in self.index["conversations"] if e["id"] == M)
        self.assertNotIn("steps", other, "a conversation with no tool output has no steps object")
        self.assertFalse((self.lab.out / "t" / f"{M}.json").exists())

    def test_an_unchanged_run_writes_the_object_again_never_and_a_conversation_without_output_loses_it(self):
        before = (self.lab.out / "t" / f"{A}.json").stat().st_mtime_ns
        wait_a_tick()
        self.assertEqual(self.lab.build(), 0)
        self.assertEqual((self.lab.out / "t" / f"{A}.json").stat().st_mtime_ns, before)
        # The log is rewritten with no output in it: its object is swept, and the index stops naming it.
        write_log(self.lab.logs[A], [user("Run the checks.", T0, str(self.lab.main)), say("Nothing ran.", T0 + 20, str(self.lab.main))], T0 + 800)
        self.assertEqual(self.lab.build(), 0)
        self.assertFalse((self.lab.out / "t" / f"{A}.json").exists())
        self.assertNotIn("steps", next(e for e in self.lab.index()["conversations"] if e["id"] == A))

    def test_a_missing_steps_object_builds_the_conversation_again(self):
        (self.lab.out / "t" / f"{A}.json").unlink()
        self.assertEqual(self.lab.build(), 0)
        self.assertTrue((self.lab.out / "t" / f"{A}.json").is_file())

    def test_the_local_page_gets_the_same_output_apart_from_its_page(self):
        payload = self.lab.local_payload([A])
        out = self.lab.root / "out" / "prototype.html"
        builder.write_page(builder.TEMPLATE, payload, out)
        page = out.read_text(encoding="utf-8")
        self.assertNotIn("all good", page, "the page holds no output text")
        self.assertNotIn(READ_TEXT, page)
        kept = json.loads((out.parent / "steps" / f"{A}.json").read_text(encoding="utf-8"))["outputs"]
        self.assertEqual(kept, self.lab.object(f"t/{A}.json")["outputs"])
        self.assertEqual(oct((out.parent / "steps" / f"{A}.json").stat().st_mode & 0o777), "0o600")


class ToolStepsSealTest(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(self)
        main = str(self.lab.main)
        write_log(self.lab.logs[A], [
            user("Run the checks.", T0, main), call(T0 + 1, main, "Bash", {"command": "make check"}, "c1"),
            result(T0 + 2, main, "c1", "calling with " + BEARER + " ok"), say("Done.", T0 + 20, main)], T0 + 700)
        self.target = self.lab.root / "out" / "bucket"
        env = mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS})
        env.start()
        self.addCleanup(env.stop)

    def seal(self):
        return self.lab.build_only_args("--seal", str(self.target))

    def opened(self, *names):
        done = subprocess.run(["node", "-e", OPEN_JS, str(SEAL), str(self.target), *names], capture_output=True, text=True,
                              env={**os.environ, sync.PASSPHRASE_ENV: PASS}, check=True)
        return json.loads(done.stdout)

    def test_the_steps_object_is_sealed_redacted_and_pruned_with_its_conversation(self):
        self.assertEqual(self.seal(), 0)
        self.assertTrue((self.target / "t" / f"{A}.json.enc").is_file())
        sealed = self.opened(f"t/{A}.json")[f"t/{A}.json"]
        text = json.dumps(sealed)
        self.assertIn("calling with Bearer [redacted:bearer] ok", text)
        self.assertNotIn(FAKE_TOKEN, text)
        log = json.loads((self.lab.out / "redactions.json").read_text(encoding="utf-8"))
        self.assertEqual(log["objects"][f"t/{A}.json"], {"bearer": 1})
        # The conversation leaves the bucket (nothing ran in it any more): so does its object.
        write_log(self.lab.logs[A], [user("Run the checks.", T0, str(self.lab.main)), say("Nothing ran.", T0 + 20, str(self.lab.main))], T0 + 800)
        self.seal()
        self.assertFalse((self.target / "t" / f"{A}.json.enc").exists())

    def test_the_window_moving_with_each_build_does_not_seal_the_index_again(self):
        self.seal()
        before = {str(p.relative_to(self.target)): p.stat().st_mtime_ns for p in self.target.rglob("*") if p.is_file()}
        wait_a_tick()
        with mock.patch.object(sync.subprocess, "Popen", wraps=sync.subprocess.Popen) as started:
            self.seal()
        self.assertEqual(started.call_count, 0, "steps_from moves every run; the index is sealed when the rest of it changes")
        self.assertEqual({str(p.relative_to(self.target)): p.stat().st_mtime_ns for p in self.target.rglob("*") if p.is_file()}, before)

    def test_wipe_takes_the_steps_objects_too(self):
        self.seal()
        self.lab.build_only_args("--wipe", str(self.target))
        self.assertEqual([p for p in (self.target / "t").glob("*") if p.is_file()], [])


class SealTest(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(self)
        self.target = self.lab.root / "out" / "bucket"
        env = mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS})
        env.start()
        self.addCleanup(env.stop)

    def seal(self, *extra):
        return self.lab.build_only_args("--seal", str(self.target), *extra)

    def opened(self, *names, passphrase=PASS):
        done = subprocess.run(["node", "-e", OPEN_JS, str(SEAL), str(self.target), *names], capture_output=True, text=True,
                              env={**os.environ, sync.PASSPHRASE_ENV: passphrase}, check=True)
        return json.loads(done.stdout)

    def sealed_times(self):
        return {str(p.relative_to(self.target)): p.stat().st_mtime_ns for p in self.target.rglob("*") if p.is_file()}

    def test_every_object_is_sealed_into_the_folder_with_the_shell_and_the_params(self):
        self.assertEqual(self.seal(), 0)
        index = self.lab.index()
        names = ["index.json"] + [e["object"] for e in index["conversations"]] + [m["object"] for m in index["documents"].values()] \
            + [m["object"] for m in index["weeks"].values()] + [m["object"] for m in index["sheets"].values()]
        self.assertEqual(sorted(self.sealed_times()), sorted(["index.html", "sheet.html", *sync.STATIC_FILES, "k/params.json"] + [n + ".enc" for n in names]))
        self.assertIn(f"a/{M}.json", names)
        opened = self.opened(*names)
        self.assertEqual([e["id"] for e in opened["index.json"]["conversations"]], [e["id"] for e in index["conversations"]])
        for name in names[1:]:
            self.assertEqual(opened[name], self.lab.object(name), name)
        self.assertEqual((self.target / "index.html").read_bytes(), (self.lab.out / "index.html").read_bytes())
        self.assertEqual(self.opened("index.json", passphrase="not it"), {"index.json": None})
        # Nothing is written outside the bucket and out/, and the passphrase nowhere at all.
        self.assertEqual(sorted(p.name for p in self.lab.root.iterdir()), ["elsewhere", "homes", "out", "projects"])
        for path in (self.lab.root / "out").rglob("*"):
            if path.is_file():
                self.assertNotIn(PASS.encode(), path.read_bytes(), path)

    def test_a_secret_is_redacted_before_it_is_sealed_and_only_counted(self):
        secret = "ghp_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
        append_log(self.lab.logs[M], [user("The deploy key?", T0 + 900, str(self.lab.mate)), say(f"It is {secret} for now.", T0 + 910, str(self.lab.mate))])
        self.seal()
        sealed = json.dumps(self.opened(f"s/{M}.json", "index.json"))
        self.assertIn("It is [redacted:github-token] for now.", sealed)
        self.assertNotIn(secret, sealed)
        self.assertIn(secret, json.dumps(self.lab.object(f"s/{M}.json")), "the laptop keeps the original")
        log = json.loads((self.lab.out / "redactions.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(log["totals"]["github-token"], 2)  # the reply, and its first line in the fleet week
        self.assertEqual(log["objects"][f"s/{M}.json"], {"github-token": 1})
        self.assertNotIn(secret, (self.lab.out / "redactions.json").read_text(encoding="utf-8"))

    def test_a_conversation_that_holds_a_line_or_paragraph_separator_is_sealed_whole(self):
        # JSON allows U+2028 and U+2029 raw in a string and the object is written that way. The sealing step used to end a line at them, cut the
        # object in half ("Unterminated string in JSON") and stop, so every seal failed from the first conversation that quoted one (a pasted
        # text, or a script that handles them): 2 of 795 on the owner's laptop, and each time the whole copy stayed as old as before.
        text = "A pasted line\u2028and another\u2029and a third; " + "x" * 120000 + "\u2028end"
        append_log(self.lab.logs[M], [user("Paste this.", T0 + 900, str(self.lab.mate)), say(text, T0 + 910, str(self.lab.mate))])
        self.assertEqual(self.seal(), 0)
        sealed = self.opened(f"s/{M}.json")[f"s/{M}.json"]
        self.assertIn(text, json.dumps(sealed, ensure_ascii=False), "the sealed conversation has the text as it was")
        self.assertEqual(sealed, self.lab.object(f"s/{M}.json"))
        self.assertTrue((self.target / "index.json.enc").is_file())
        self.assertTrue((self.lab.out / "upload.json").is_file(), "the run is recorded, so the next one seals only what changed")

    def stub_upload(self, script):
        """Run the sealing step as this node script instead of upload.js (the one program --seal starts besides the build)."""
        real = subprocess.Popen
        self.started = []

        def popen(command, **kwargs):
            if not str(command[1]).endswith("upload.js"):
                return real(command, **kwargs)
            self.started.append(real(["node", "-e", script], **kwargs))
            return self.started[-1]
        return mock.patch.object(sync.subprocess, "Popen", popen)

    def test_a_seal_that_stops_says_why_in_one_sentence_with_no_python_traceback(self):
        # The page's Sync shows the last line a build printed ("The laptop could not build a new copy: ..."): the reason, in words, not a
        # bare "upload.js stopped", and not what Python says when the pipe to a stopped program is dropped with data still waiting.
        # It stops on the first bytes it is sent (as upload.js did on a line it could not read), with the rest of the objects still to write.
        stopped = ("process.stdout.write('{\"ready\":true,\"rekeyed\":true}\\n'); "
                   "process.stdin.once('data', () => { process.stderr.write('ENOSPC: no space left on device, write\\n'); process.exit(1); })")
        # Objects bigger than the pipe's buffer, so the program is written to after it has stopped (as the owner's 780 conversations are).
        append_log(self.lab.logs[M], [user("A long one.", T0 + 900, str(self.lab.mate)), say("y" * 300000, T0 + 910, str(self.lab.mate))])
        with self.stub_upload(stopped), mock.patch("sys.stderr", new_callable=io.StringIO) as noise:
            with self.assertRaises(SystemExit) as caught:
                self.seal()
            gc.collect()
        self.assertEqual(str(caught.exception), "Sealing stopped (ENOSPC: no space left on device, write); the sealed copy keeps what it had.")
        self.assertEqual(len(self.started), 1)
        self.assertTrue(self.started[0].stdin.closed, "the run closes the pipe itself, so Python has nothing to report when the stopped program's end is dropped")
        self.assertNotIn("Exception ignored", noise.getvalue())
        self.assertNotIn("BrokenPipe", noise.getvalue())
        self.assertFalse((self.lab.out / "upload.json").exists(), "nothing is recorded as sealed, so the next run seals it all again")

    def test_a_sealing_step_that_says_nothing_or_does_not_start_is_still_named(self):
        silent = "process.stdout.write('{\"ready\":true,\"rekeyed\":true}\\n'); process.kill(process.pid, 'SIGKILL')"
        with self.stub_upload(silent), self.assertRaises(SystemExit) as caught:
            self.seal()
        self.assertEqual(str(caught.exception), "Sealing stopped (it was stopped by signal 9); the sealed copy keeps what it had.")
        broken = "process.stderr.write('Cannot find module\\nsecond line\\n'); process.exit(3)"
        with self.stub_upload(broken), self.assertRaises(SystemExit) as caught:
            self.seal()
        self.assertEqual(str(caught.exception), "Sealing did not start (Cannot find module second line); the sealed copy keeps what it had.")
        denied = "process.stdout.write('{\"ready\":true,\"rekeyed\":true}\\n'); process.stderr.write(\"EACCES: permission denied, open '/a/long/path/to/s/x.partial'\\n\"); process.exit(1)"
        with self.stub_upload(denied), self.assertRaises(SystemExit) as caught:
            self.seal()
        self.assertEqual(str(caught.exception), "Sealing stopped (EACCES: permission denied, open); the sealed copy keeps what it had.", "a system error's file path is left off")

    def test_a_run_with_nothing_new_seals_nothing_and_starts_no_node(self):
        self.seal()
        before = self.sealed_times()
        with mock.patch.object(sync.subprocess, "Popen", wraps=sync.subprocess.Popen) as started:
            self.seal()
        self.assertEqual(started.call_count, 0)
        self.assertEqual(self.sealed_times(), before)

    def test_a_changed_shell_page_reaches_the_bucket_at_once(self):
        self.seal()
        page = self.lab.out / "index.html"
        page.write_bytes(page.read_bytes() + b"<!-- new page code -->")
        self.seal()
        self.assertEqual((self.target / "index.html").read_bytes(), page.read_bytes())

    def test_a_change_seals_its_object_and_the_index_alone(self):
        self.seal()
        before = self.sealed_times()
        wait_a_tick()
        append_log(self.lab.logs[M], [user("And the changelog?", T0 + 900, str(self.lab.mate)), say("Updated.", T0 + 910, str(self.lab.mate))])
        self.seal()
        after = self.sealed_times()
        changed = sorted(name for name in after if after[name] != before.get(name))
        week = [m["object"] + ".enc" for m in self.lab.index()["weeks"].values()]
        self.assertEqual(changed, sorted([f"s/{M}.json.enc", "index.json.enc", *week]))

    def test_the_index_is_sealed_again_for_the_heartbeat(self):
        self.seal()
        state = json.loads((self.lab.out / "upload.json").read_text(encoding="utf-8"))
        state["index_at"] -= sync.HEARTBEAT + 1
        (self.lab.out / "upload.json").write_text(json.dumps(state), encoding="utf-8")
        before = self.sealed_times()
        wait_a_tick()
        self.seal()
        after = self.sealed_times()
        self.assertEqual(sorted(name for name in after if after[name] != before[name]), ["index.json.enc"])

    def test_the_bucket_keeps_90_days_and_the_laptop_keeps_everything(self):
        old, main = "ffffffff-6666-4666-8666-666666666666", str(self.lab.main)
        (self.lab.main / "old-plan.md").write_text("# Old plan\n", encoding="utf-8")
        long_ago = NOW - 100 * 86400
        write_log(self.lab.projects / "main" / f"{old}.jsonl", [user("An old task.", long_ago, main), say("See `old-plan.md`.", long_ago + 5, main)], long_ago + 10)
        self.seal()
        local = self.lab.index()
        self.assertIn(old, [e["id"] for e in local["conversations"]])
        sealed = self.opened("index.json")["index.json"]
        self.assertNotIn(old, [e["id"] for e in sealed["conversations"]])
        self.assertNotIn("old-plan.md", [m["name"] for m in sealed["documents"].values()])
        self.assertIn("old-plan.md", [m["name"] for m in local["documents"].values()])
        self.assertFalse((self.target / f"s/{old}.json.enc").exists())

    def test_a_conversation_that_ages_out_is_deleted_from_the_bucket(self):
        self.seal()
        self.assertTrue((self.target / f"s/{W}.json.enc").is_file())
        with mock.patch.object(sync, "RETENTION_DAYS", 0.0001):
            self.seal()
        self.assertFalse((self.target / f"s/{W}.json.enc").exists())
        self.assertEqual(self.opened("index.json")["index.json"]["conversations"], [])

    def test_a_wrong_passphrase_stops_and_a_new_one_seals_everything_again(self):
        self.seal()
        before = self.sealed_times()
        append_log(self.lab.logs[M], [user("More?", T0 + 900, str(self.lab.mate))])
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: "not it"}), self.assertRaises(SystemExit) as stop:
            self.seal()
        self.assertIn("does not open this bucket", str(stop.exception))
        self.assertEqual(self.sealed_times(), before)
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: "a new one"}):
            self.seal("--new-passphrase")
        self.assertEqual(self.opened("index.json")["index.json"], None)
        self.assertEqual(len(self.opened("index.json", passphrase="a new one")["index.json"]["conversations"]), 3)

    def test_wipe_empties_what_the_seal_wrote_and_nothing_else(self):
        self.seal()
        (self.target / "notes.txt").write_text("not the seal's", encoding="utf-8")
        self.lab.build_only_args("--wipe", str(self.target))
        self.assertEqual([str(p.relative_to(self.target)) for p in self.target.rglob("*") if p.is_file()], ["notes.txt"])
        self.assertFalse((self.lab.out / "upload.json").exists())
        self.assertTrue((self.lab.out / "index.json").is_file(), "the laptop's copy stays")

    def keychain(self, answer):
        """A `security` that answers as the login keychain does for the item the README stores (answer None: no such item)."""
        fake = self.lab.root / "security"
        text = f'#!/bin/sh\n[ "$1 $2 $3 $4" = "find-generic-password -w -s {sync.KEYCHAIN_SERVICE}" ] || exit 2\n'
        fake.write_text(text + (f'echo "{answer}"\n' if answer is not None else "exit 44\n"), encoding="utf-8")
        fake.chmod(0o755)
        return fake

    def test_without_a_passphrase_or_a_terminal_it_stops_before_building(self):
        # No terminal and no variable: the login keychain is the last place (never this Mac's own, which a test must not read).
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: "", sync.SECURITY_ENV: str(self.keychain(None))}), mock.patch.object(sys.stdin, "isatty", lambda: False), \
                self.assertRaises(SystemExit) as stop:
            self.seal()
        self.assertIn(sync.PASSPHRASE_ENV, str(stop.exception))
        self.assertIn("keychain", str(stop.exception))
        self.assertFalse(self.lab.out.exists())

    def test_without_a_terminal_the_passphrase_comes_from_the_login_keychain_and_is_never_printed(self):
        # What the reader's server runs when the phone's Sync asks for a new copy: no terminal, no variable, the keychain item
        # the LaunchAgent's README stores. The passphrase is read inside this run, so no other process is handed it.
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: "", sync.SECURITY_ENV: str(self.keychain(PASS))}), mock.patch.object(sys.stdin, "isatty", lambda: False), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as printed:
            self.assertEqual(sync.main(["--seal", str(self.target), "--panes", "all", "--out", str(self.lab.out), "--main-home", str(self.lab.main)]), 0)
        self.assertNotIn(PASS, printed.getvalue())
        self.assertEqual(len(self.opened("index.json")["index.json"]["conversations"]), 3)

    def test_the_variable_wins_over_the_keychain_and_a_terminal_over_both(self):
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: "from the variable", sync.SECURITY_ENV: str(self.keychain("from the keychain"))}), \
                mock.patch.object(sys.stdin, "isatty", lambda: False):
            self.assertEqual(sync.passphrase(self.target), "from the variable")
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: "", sync.SECURITY_ENV: str(self.keychain("from the keychain"))}), \
                mock.patch.object(sys.stdin, "isatty", lambda: True), mock.patch("getpass.getpass", return_value="typed"):
            (self.target / "k").mkdir(parents=True)
            (self.target / "k" / "params.json").write_text("{}", encoding="utf-8")
            self.assertEqual(sync.passphrase(self.target), "typed")

    def test_the_launch_agent_reads_the_passphrase_from_the_keychain_and_is_only_printed(self):
        with mock.patch("sys.stdout", new_callable=io.StringIO) as printed:
            self.assertEqual(sync.main(["--launch-agent", str(self.target)]), 0)
        plist = printed.getvalue()
        self.assertIn("<key>StartInterval</key><integer>60</integer>", plist)
        self.assertIn(f"security find-generic-password -w -s {sync.KEYCHAIN_SERVICE}", plist)
        self.assertIn(f'--seal "{self.target.resolve()}"', plist)
        # launchd's own PATH holds none of the tools a run uses, so the agent carries the folders of node and python3.
        self.assertIn("<key>EnvironmentVariables</key>", plist)
        path = plist.split("<key>PATH</key><string>")[1].split("</string>")[0].split(":")
        for tool in ("node", "python3"):
            self.assertIn(str(Path(shutil.which(tool)).resolve().parent), path)
        self.assertNotIn(PASS, plist)
        self.assertFalse(self.target.exists())


# What the page does for a sealed bucket: gzip the request and seal it under the passphrase's key.
SEAL_REQUEST_JS = r"""
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const seal = require(process.argv[1]);
(async () => {
  const [folder, id, json] = process.argv.slice(2);
  const key = await seal.unlock(process.env.HOSTED_READER_PASSPHRASE, JSON.parse(fs.readFileSync(path.join(folder, 'k/params.json'))));
  fs.mkdirSync(path.join(folder, 'q'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'q', id + '.json.enc'), await seal.close(key, 'q/' + id + '.json', zlib.gzipSync(Buffer.from(json))));
})();
"""
# A Herdr that is not Herdr: it answers the reads a send makes for one pane running session A, logs every call
# to STUB_LOG and changes nothing.
STUB_HERDR = f'''#!{sys.executable}
import json, os, sys
args = sys.argv[1:]
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
pane = {{"pane_id": "w1:p1", "tab_id": "w1:t1", "label": "alpha", "agent": "claude", "agent_status": os.environ.get("STUB_STATUS", "idle"), "agent_session": {{"value": "{A}"}}}}
if args[:3] == ["session", "list", "--json"]:
    print(json.dumps({{"sessions": [{{"name": "lab", "running": True, "default": False}}]}}))
elif args[2:4] == ["api", "snapshot"]:
    print(json.dumps({{"result": {{"snapshot": {{"focused_pane_id": "w1:p1", "tabs": [], "panes": [pane]}}}}}}))
elif args[2:4] == ["pane", "process-info"]:
    print(json.dumps({{"result": {{"process_info": {{"foreground_processes": [{{"pid": 1, "argv0": "claude"}}]}}}}}}))
elif args[2:4] in (["agent", "send-keys"], ["agent", "prompt"]):
    print("{{}}")
else:
    sys.exit(1)
'''
Q1 = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
Q2 = "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaa2"


class SendTest(unittest.TestCase):
    """Every run sends what the page queued, before it builds, through the fake Herdr above."""

    def setUp(self):
        self.lab = Lab(self)
        self.target = self.lab.root / "out" / "bucket"
        stub = self.lab.root / "stub" / "herdr"
        stub.parent.mkdir()
        stub.write_text(STUB_HERDR, encoding="utf-8")
        stub.chmod(0o755)
        self.log = self.lab.root / "stub" / "calls.log"
        home = self.lab.root / "stub" / "home"
        home.mkdir()
        env = mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS, "HOSTED_READER_HERDR": str(stub), "STUB_LOG": str(self.log), "HOME": str(home)})
        env.start()
        self.addCleanup(env.stop)
        self.assertEqual(self.lab.build(), 0)  # the index the requests are checked against

    def calls(self):
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()] if self.log.exists() else []

    def prompts(self):
        return [call[5] for call in self.calls() if call[2:4] == ["agent", "prompt"]]

    def test_a_queued_request_is_sent_before_the_build_and_its_receipt_is_written(self):
        queue = self.lab.out / "q"
        queue.mkdir()
        (queue / f"{Q1}.json").write_text(json.dumps({"id": Q1, "session_id": A, "text": "A1=keep;A2=short", "at": time.time()}), encoding="utf-8")
        with mock.patch("sys.stdout", new_callable=io.StringIO) as printed:
            self.assertEqual(sync.main(["--build-only", "--out", str(self.lab.out), "--main-home", str(self.lab.main)]), 0)
        self.assertIn("Drain: 1 sent, 0 refused", printed.getvalue())
        self.assertEqual(self.prompts(), ["A1=keep;A2=short"])
        receipt = json.loads((self.lab.out / "r" / f"{Q1}.json").read_text(encoding="utf-8"))
        self.assertEqual((receipt["state"], receipt["label"], receipt["session_id"]), ("sent", "alpha", A))
        self.assertEqual(list(queue.iterdir()), [])
        self.assertEqual(self.lab.build(), 0)
        self.assertEqual(self.prompts(), ["A1=keep;A2=short"], "the next run sends nothing again")

    def test_a_pane_that_is_not_ready_refuses_with_a_reason_and_the_build_goes_on(self):
        queue = self.lab.out / "q"
        queue.mkdir()
        (queue / f"{Q1}.json").write_text(json.dumps({"id": Q1, "session_id": A, "text": "hello", "at": time.time()}), encoding="utf-8")
        with mock.patch.dict(os.environ, {"STUB_STATUS": "blocked"}):
            self.assertEqual(self.lab.build(), 0)
        receipt = json.loads((self.lab.out / "r" / f"{Q1}.json").read_text(encoding="utf-8"))
        self.assertEqual((receipt["state"], receipt["code"]), ("refused", "agent_blocked"))
        self.assertEqual(self.prompts(), [])

    def test_a_seal_sends_what_the_sealed_page_queued_and_seals_the_receipt(self):
        self.assertEqual(self.lab.build_only_args("--seal", str(self.target)), 0)
        request = json.dumps({"id": Q2, "session_id": A, "text": "A1=keep", "at": time.time()})
        subprocess.run(["node", "-e", SEAL_REQUEST_JS, str(SEAL), str(self.target), Q2, request], check=True, env=os.environ)
        self.assertEqual(self.lab.build_only_args("--seal", str(self.target)), 0)
        self.assertEqual(self.prompts(), ["A1=keep"])
        done = subprocess.run(["node", "-e", OPEN_JS, str(SEAL), str(self.target), f"r/{Q2}.json"], capture_output=True, text=True, check=True, env=os.environ)
        self.assertEqual(json.loads(done.stdout)[f"r/{Q2}.json"]["state"], "sent")
        self.assertEqual(list((self.target / "q").iterdir()), [])
        # The replay ledger is in out/, apart from the bucket and from the folder that holds it.
        self.assertEqual(len([p for p in (self.lab.root / "out").iterdir() if p.name.startswith(".drain-handled")]), 1)
        self.assertEqual([p.name for p in self.target.iterdir() if p.name.startswith(".drain-handled")], [])
        # The receipt and the queue are not objects of the bucket: the next run neither prunes nor reseals them.
        self.assertEqual(self.lab.build_only_args("--seal", str(self.target)), 0)
        self.assertTrue((self.target / "r" / f"{Q2}.json.enc").is_file())
        self.assertEqual(self.prompts(), ["A1=keep"])

    def test_a_run_with_nothing_queued_starts_no_node_and_asks_no_herdr(self):
        self.assertEqual(self.lab.build_only_args("--seal", str(self.target)), 0)
        before = len(self.calls())
        with mock.patch.object(sync.subprocess, "run", wraps=sync.subprocess.run) as ran:
            self.assertEqual(self.lab.build_only_args("--seal", str(self.target)), 0)
        self.assertEqual(ran.call_count, 0)
        self.assertEqual(len(self.calls()), before)

    def test_wipe_takes_the_sealed_queue_and_receipts_with_the_rest(self):
        self.assertEqual(self.lab.build_only_args("--seal", str(self.target)), 0)
        for folder, name in (("q", f"{Q1}.json.enc"), ("r", f"{Q2}.json.enc")):
            (self.target / folder).mkdir(exist_ok=True)
            (self.target / folder / name).write_bytes(b"HRC1" + b"x" * 40)
        with mock.patch("sys.stdout"):
            self.assertEqual(sync.main(["--wipe", str(self.target), "--out", str(self.lab.out)]), 0)
        self.assertEqual([p for p in self.target.rglob("*") if p.is_file()], [])
