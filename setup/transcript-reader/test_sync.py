"""Tests for sync.py: --build-only, the hosted copy's incremental build (its objects, its
manifest: what a run builds again and what it leaves, and that the objects hold what the
local page's payload holds), and --dry-run, the sync agent sealing a local bucket folder.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_sync.py
Fixtures are synthetic logs and fleet records in a temporary folder; Herdr is faked. The
dry run needs Node (upload.js); the passphrase is made up.
"""

import argparse
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
        root = Path(self.tmp.name).resolve()
        self.root, self.projects, self.out = root, root / "projects", root / "out" / "hosted"
        self.main, self.mate = root / "homes" / "main", root / "homes" / "mate" / "firstmate"
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
                      mock.patch.object(sync.reader, "LIST", root / "out" / "sessions.txt")):
            patch.start()
            test.addCleanup(patch.stop)

    def build(self, *extra):
        return self.build_only_args("--build-only", *extra)

    def build_only_args(self, *args):
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
        self.assertIn('const HOSTED = "hosted" === "hosted";', page)
        self.assertIn('<script id="payload" type="application/json">null</script>', page)
        self.assertIn(f'<meta name="template" content="{self.index["template"]}">', page)
        self.assertNotIn("Plan the login fix", page)

    def test_the_manifest_records_each_log_version(self):
        record = self.lab.manifest()["conversations"][A]
        self.assertEqual(record["members"], [str(self.lab.logs[A])])
        self.assertEqual(record["versions"][str(self.lab.logs[A])], sync.version(self.lab.logs[A]))
        self.assertNotIn("found", record)


class ParityTest(unittest.TestCase):
    """The objects hold what the local page's payload holds for the same sessions."""

    def test_conversations_documents_and_fleet_match_the_local_payload(self):
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
        self.assertIn('const HOSTED = "hosted" === "hosted";', page)
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
            self.assertEqual(lab.build_only_args("--dry-run", str(target)), 0)
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


class DryRunTest(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(self)
        self.target = self.lab.root / "out" / "bucket"
        env = mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: PASS})
        env.start()
        self.addCleanup(env.stop)

    def dry_run(self, *extra):
        return self.lab.build_only_args("--dry-run", str(self.target), *extra)

    def opened(self, *names, passphrase=PASS):
        done = subprocess.run(["node", "-e", OPEN_JS, str(SEAL), str(self.target), *names], capture_output=True, text=True,
                              env={**os.environ, sync.PASSPHRASE_ENV: passphrase}, check=True)
        return json.loads(done.stdout)

    def sealed_times(self):
        return {str(p.relative_to(self.target)): p.stat().st_mtime_ns for p in self.target.rglob("*") if p.is_file()}

    def test_every_object_is_sealed_into_the_folder_with_the_shell_and_the_params(self):
        self.assertEqual(self.dry_run(), 0)
        index = self.lab.index()
        names = ["index.json"] + [e["object"] for e in index["conversations"]] + [m["object"] for m in index["documents"].values()] \
            + [m["object"] for m in index["weeks"].values()] + [m["object"] for m in index["sheets"].values()]
        self.assertEqual(sorted(self.sealed_times()), sorted(["index.html", "sheet.html", "k/params.json"] + [n + ".enc" for n in names]))
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
        self.dry_run()
        sealed = json.dumps(self.opened(f"s/{M}.json", "index.json"))
        self.assertIn("It is [redacted:github-token] for now.", sealed)
        self.assertNotIn(secret, sealed)
        self.assertIn(secret, json.dumps(self.lab.object(f"s/{M}.json")), "the laptop keeps the original")
        log = json.loads((self.lab.out / "redactions.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(log["totals"]["github-token"], 2)  # the reply, and its first line in the fleet week
        self.assertEqual(log["objects"][f"s/{M}.json"], {"github-token": 1})
        self.assertNotIn(secret, (self.lab.out / "redactions.json").read_text(encoding="utf-8"))

    def test_a_run_with_nothing_new_seals_nothing_and_starts_no_node(self):
        self.dry_run()
        before = self.sealed_times()
        with mock.patch.object(sync.subprocess, "Popen", wraps=sync.subprocess.Popen) as started:
            self.dry_run()
        self.assertEqual(started.call_count, 0)
        self.assertEqual(self.sealed_times(), before)

    def test_a_changed_shell_page_reaches_the_bucket_at_once(self):
        self.dry_run()
        page = self.lab.out / "index.html"
        page.write_bytes(page.read_bytes() + b"<!-- new page code -->")
        self.dry_run()
        self.assertEqual((self.target / "index.html").read_bytes(), page.read_bytes())

    def test_a_change_seals_its_object_and_the_index_alone(self):
        self.dry_run()
        before = self.sealed_times()
        wait_a_tick()
        append_log(self.lab.logs[M], [user("And the changelog?", T0 + 900, str(self.lab.mate)), say("Updated.", T0 + 910, str(self.lab.mate))])
        self.dry_run()
        after = self.sealed_times()
        changed = sorted(name for name in after if after[name] != before.get(name))
        week = [m["object"] + ".enc" for m in self.lab.index()["weeks"].values()]
        self.assertEqual(changed, sorted([f"s/{M}.json.enc", "index.json.enc", *week]))

    def test_the_index_is_sealed_again_for_the_heartbeat(self):
        self.dry_run()
        state = json.loads((self.lab.out / "upload.json").read_text(encoding="utf-8"))
        state["index_at"] -= sync.HEARTBEAT + 1
        (self.lab.out / "upload.json").write_text(json.dumps(state), encoding="utf-8")
        before = self.sealed_times()
        wait_a_tick()
        self.dry_run()
        after = self.sealed_times()
        self.assertEqual(sorted(name for name in after if after[name] != before[name]), ["index.json.enc"])

    def test_the_bucket_keeps_90_days_and_the_laptop_keeps_everything(self):
        old, main = "ffffffff-6666-4666-8666-666666666666", str(self.lab.main)
        (self.lab.main / "old-plan.md").write_text("# Old plan\n", encoding="utf-8")
        long_ago = NOW - 100 * 86400
        write_log(self.lab.projects / "main" / f"{old}.jsonl", [user("An old task.", long_ago, main), say("See `old-plan.md`.", long_ago + 5, main)], long_ago + 10)
        self.dry_run()
        local = self.lab.index()
        self.assertIn(old, [e["id"] for e in local["conversations"]])
        sealed = self.opened("index.json")["index.json"]
        self.assertNotIn(old, [e["id"] for e in sealed["conversations"]])
        self.assertNotIn("old-plan.md", [m["name"] for m in sealed["documents"].values()])
        self.assertIn("old-plan.md", [m["name"] for m in local["documents"].values()])
        self.assertFalse((self.target / f"s/{old}.json.enc").exists())

    def test_a_conversation_that_ages_out_is_deleted_from_the_bucket(self):
        self.dry_run()
        self.assertTrue((self.target / f"s/{W}.json.enc").is_file())
        with mock.patch.object(sync, "RETENTION_DAYS", 0.0001):
            self.dry_run()
        self.assertFalse((self.target / f"s/{W}.json.enc").exists())
        self.assertEqual(self.opened("index.json")["index.json"]["conversations"], [])

    def test_a_wrong_passphrase_stops_and_a_new_one_seals_everything_again(self):
        self.dry_run()
        before = self.sealed_times()
        append_log(self.lab.logs[M], [user("More?", T0 + 900, str(self.lab.mate))])
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: "not it"}), self.assertRaises(SystemExit) as stop:
            self.dry_run()
        self.assertIn("does not open this bucket", str(stop.exception))
        self.assertEqual(self.sealed_times(), before)
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: "a new one"}):
            self.dry_run("--new-passphrase")
        self.assertEqual(self.opened("index.json")["index.json"], None)
        self.assertEqual(len(self.opened("index.json", passphrase="a new one")["index.json"]["conversations"]), 3)

    def test_wipe_empties_what_the_dry_run_wrote_and_nothing_else(self):
        self.dry_run()
        (self.target / "notes.txt").write_text("not the dry run's", encoding="utf-8")
        self.lab.build_only_args("--wipe", str(self.target))
        self.assertEqual([str(p.relative_to(self.target)) for p in self.target.rglob("*") if p.is_file()], ["notes.txt"])
        self.assertFalse((self.lab.out / "upload.json").exists())
        self.assertTrue((self.lab.out / "index.json").is_file(), "the laptop's copy stays")

    def test_without_a_passphrase_or_a_terminal_it_stops_before_building(self):
        with mock.patch.dict(os.environ, {sync.PASSPHRASE_ENV: ""}), mock.patch.object(sys.stdin, "isatty", lambda: False), \
                self.assertRaises(SystemExit) as stop:
            self.dry_run()
        self.assertIn(sync.PASSPHRASE_ENV, str(stop.exception))
        self.assertFalse(self.lab.out.exists())

    def test_the_launch_agent_reads_the_passphrase_from_the_keychain_and_is_only_printed(self):
        with mock.patch("sys.stdout", new_callable=io.StringIO) as printed:
            self.assertEqual(sync.main(["--launch-agent", str(self.target)]), 0)
        plist = printed.getvalue()
        self.assertIn("<key>StartInterval</key><integer>60</integer>", plist)
        self.assertIn(f"security find-generic-password -w -s {sync.KEYCHAIN_SERVICE}", plist)
        self.assertIn(f'--dry-run "{self.target.resolve()}"', plist)
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

    def test_a_dry_run_sends_what_the_sealed_page_queued_and_seals_the_receipt(self):
        self.assertEqual(self.lab.build_only_args("--dry-run", str(self.target)), 0)
        request = json.dumps({"id": Q2, "session_id": A, "text": "A1=keep", "at": time.time()})
        subprocess.run(["node", "-e", SEAL_REQUEST_JS, str(SEAL), str(self.target), Q2, request], check=True, env=os.environ)
        self.assertEqual(self.lab.build_only_args("--dry-run", str(self.target)), 0)
        self.assertEqual(self.prompts(), ["A1=keep"])
        done = subprocess.run(["node", "-e", OPEN_JS, str(SEAL), str(self.target), f"r/{Q2}.json"], capture_output=True, text=True, check=True, env=os.environ)
        self.assertEqual(json.loads(done.stdout)[f"r/{Q2}.json"]["state"], "sent")
        self.assertEqual(list((self.target / "q").iterdir()), [])
        # The replay ledger is in out/, apart from the bucket and from the folder that holds it.
        self.assertEqual(len([p for p in (self.lab.root / "out").iterdir() if p.name.startswith(".drain-handled")]), 1)
        self.assertEqual([p.name for p in self.target.iterdir() if p.name.startswith(".drain-handled")], [])
        # The receipt and the queue are not objects of the bucket: the next run neither prunes nor reseals them.
        self.assertEqual(self.lab.build_only_args("--dry-run", str(self.target)), 0)
        self.assertTrue((self.target / "r" / f"{Q2}.json.enc").is_file())
        self.assertEqual(self.prompts(), ["A1=keep"])

    def test_a_run_with_nothing_queued_starts_no_node_and_asks_no_herdr(self):
        self.assertEqual(self.lab.build_only_args("--dry-run", str(self.target)), 0)
        before = len(self.calls())
        with mock.patch.object(sync.subprocess, "run", wraps=sync.subprocess.run) as ran:
            self.assertEqual(self.lab.build_only_args("--dry-run", str(self.target)), 0)
        self.assertEqual(ran.call_count, 0)
        self.assertEqual(len(self.calls()), before)

    def test_wipe_takes_the_sealed_queue_and_receipts_with_the_rest(self):
        self.assertEqual(self.lab.build_only_args("--dry-run", str(self.target)), 0)
        for folder, name in (("q", f"{Q1}.json.enc"), ("r", f"{Q2}.json.enc")):
            (self.target / folder).mkdir(exist_ok=True)
            (self.target / folder / name).write_bytes(b"HRC1" + b"x" * 40)
        with mock.patch("sys.stdout"):
            self.assertEqual(sync.main(["--wipe", str(self.target), "--out", str(self.lab.out)]), 0)
        self.assertEqual([p for p in self.target.rglob("*") if p.is_file()], [])
