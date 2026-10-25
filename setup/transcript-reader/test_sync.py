"""Tests for sync.py --build-only, the hosted copy's incremental build: its objects, its
manifest (what a run builds again and what it leaves), and that the objects hold what
the local page's payload holds.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_sync.py
Fixtures are synthetic logs and fleet records in a temporary folder; Herdr is faked.
"""

import argparse
import json
import os
import random
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

NOW = time.time()
T0 = NOW - 2 * 86400
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
        write_log(self.logs[W], [user("Fix the login page.", T0 + 50, str(self.worker)), say("Done: the page logs in.", T0 + 90, str(self.worker))], T0 + 100)
        write_log(self.logs[M], [user("Check the release notes.", T0 + 30, mate), say("They read well. No action needed.", T0 + 40, mate)], T0 + 50)
        write_log(self.logs[X], [user("Unrelated work.", T0 + 5, str(root / "elsewhere")), say("Fine.", T0 + 6, str(root / "elsewhere"))], T0 + 10)
        self.panes = {A: {"label": "alpha", "title": "Alpha work", "herdr": "lab", "pane": "w1:p1", "status": "working"}}
        for patch in (mock.patch.object(builder, "PROJECTS", self.projects), mock.patch.object(builder, "herdr_panes", lambda: dict(self.panes)),
                      mock.patch.object(sync, "LOCAL_PANES", root / "out" / "pane-labels.json"), mock.patch.object(sync, "REOPENED", root / "out" / "reopened.txt"),
                      mock.patch.object(sync.reader, "LIST", root / "out" / "sessions.txt")):
            patch.start()
            test.addCleanup(patch.stop)

    def build(self, *extra):
        args = ["--build-only", "--out", str(self.out), "--main-home", str(self.main), *extra]
        with mock.patch("sys.stdout"):
            return sync.main(args)

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
        self.assertEqual([call.args[0] for call in builds.call_args_list], [self.lab.logs[M]])
        self.assertEqual([call.args[0] for call in parses.call_args_list], [self.lab.logs[M]])
        self.assertIn(f"s/{M}.json", self.changed())
        self.assertNotIn(f"s/{A}.json", self.changed())
        conversations = self.lab.index()["conversations"]
        entry = next(e for e in conversations if e["id"] == M)
        self.assertEqual((entry["turns"], entry["last"], conversations[0]["id"]), (2, T0 + 910, M))
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
        self.assertEqual(builds.call_count, 3)
        self.assertEqual(parses.call_count, 0, "unchanged logs come from the parsed-log cache")
        self.assertEqual(self.changed(), [])

    def test_a_log_either_build_parsed_is_not_parsed_again(self):
        self.assertTrue((self.lab.root / "out" / "parsed" / f"{A}.json").is_file())
        with mock.patch.object(builder, "iter_jsonl", wraps=builder.iter_jsonl) as parses:
            self.lab.local_payload([A, W, M])
        self.assertEqual(parses.call_count, 0)

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
        self.assertEqual(builds.call_count, 3)


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
