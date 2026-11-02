"""Tests for build_cache.py: the conversations a worker keeps between builds, and the page it writes from them.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_cache.py
The page a build from kept conversations makes must be, byte for byte, the page build_prototype.build + write_page make from nothing,
after anything that can change one conversation, a file it names, or what the page says about all of them; and what did not change
must not be built again. Fixtures are synthetic (test_sync's lab).
"""

import argparse
import os
import random
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "prototype"))
import build_cache  # noqa: E402
import build_questionnaire  # noqa: E402
import tool_steps  # noqa: E402
import test_resident  # noqa: E402
from test_resident import drop_caches  # noqa: E402
from test_sync import A, M, W, Lab, append_log, say, user, write_log  # noqa: E402
from test_sync import T0 as LAB_T0, iso as lab_iso  # noqa: E402
from test_reader import CLEAR  # noqa: E402
from reader import builder  # noqa: E402


class Case(unittest.TestCase):
    """A lab, and builds of it made both ways."""

    def setUp(self):
        self.lab = Lab(self)
        patch = mock.patch.dict(os.environ, {builder.FLEET_TIMELINE_ENV: ""})  # the lab switches the timeline on; the reader's page leaves it off, and so does a build kept
        patch.start()
        self.addCleanup(patch.stop)
        self.main = str(self.lab.main)
        self.sessions = [A, W, M]
        self.addCleanup(drop_caches)
        drop_caches()
        self.derived = []
        real = build_cache.derive

        def derive(home, chain, parent, cache, key):
            self.derived.append(chain[-1].stem)
            return real(home, chain, parent, cache, key)
        patch = mock.patch.object(build_cache, "derive", derive)
        patch.start()
        self.addCleanup(patch.stop)

    def args(self, sessions=None, out=None):
        return argparse.Namespace(main_home=self.main, home=None, session=sessions or self.sessions, since_hours=None, listed=True, stats=False,
                                  out=str(out or self.lab.root / "out" / "prototype.html"))

    def both(self, sessions=None):
        """(the page payload build_prototype.build makes, the one build_cache.build makes, the Built), at one moment."""
        stamp = time.time()
        args = self.args(sessions)
        with mock.patch("time.time", lambda: stamp), builder.chains_frozen():
            payload = builder.build(args)
            for session in payload["sessions"]:
                tool_steps.take_outputs(session["exchanges"])  # write_page moves the tool output aside before it writes the page
            expected = builder.payload_json(payload).encode("utf-8")
            built = build_cache.build(args)
        return expected, b"".join(built.payload), built

    def same(self, sessions=None, derived=None):
        """The two builds agree; and, with <derived>, exactly these conversations were built anew by the build from kept ones."""
        self.derived.clear()
        builder._LOG_INDEX.clear()  # what the worker does at the start of each request
        expected, got, built = self.both(sessions)
        self.assertEqual(got, expected)
        if derived is not None:
            self.assertEqual(sorted(self.derived), sorted(derived))
        return built

    def newer(self, *paths):
        """A moment later than anything written so far, for a file written again to differ from its record."""
        time.sleep(0.01)
        for path in paths:
            os.utime(path, None)


class SameAsFromNothing(Case):
    def test_the_first_build_and_a_second_with_nothing_changed(self):
        self.same(derived=[A, W, M])
        built = self.same(derived=[])
        self.assertIn(b'"id":"' + A.encode() + b'"', b"".join(built.payload))

    def test_a_new_turn_builds_that_conversation_again_and_no_other(self):
        self.same()
        append_log(self.lab.logs[A], [user("Go ahead.", LAB_T0 + 800, self.main), say("Starting now.", LAB_T0 + 810, self.main)])
        self.newer(self.lab.logs[A])
        built = self.same(derived=[A])
        self.assertIn(b"Starting now.", b"".join(built.payload))
        self.same(derived=[])

    def test_a_file_a_reply_names_changes_the_page_though_no_log_did(self):
        notes = self.lab.main / "notes.md"
        self.same()
        notes.write_text("# Notes\n\nThe plan, revised.\n", encoding="utf-8")
        built = self.same(derived=[A])
        self.assertIn(b"The plan, revised.", b"".join(built.payload))
        notes.unlink()
        built = self.same(derived=[A])
        self.assertNotIn(b"The plan, revised.", b"".join(built.payload))
        notes.write_text("# Notes\n\nBack.\n", encoding="utf-8")
        self.same(derived=[A])

    def test_a_file_a_reply_names_that_was_not_there_shows_once_it_is(self):
        append_log(self.lab.logs[A], [user("Write it down.", LAB_T0 + 800, self.main), say("It is in `later.md`.", LAB_T0 + 810, self.main)])
        self.newer(self.lab.logs[A])
        self.same(derived=[A, W, M])
        later = self.lab.main / "later.md"
        self.same(derived=[])
        later.write_text("# Later\n", encoding="utf-8")
        built = self.same(derived=[A])
        self.assertIn(b"# Later", b"".join(built.payload))

    def test_a_file_written_beside_the_ones_a_conversation_looked_at_changes_nothing_for_it(self):
        self.same()
        (self.lab.main / "unrelated.txt").write_text("x", encoding="utf-8")
        (self.lab.main / "state" / "another.status").write_text("working: x\n", encoding="utf-8")
        (self.lab.root / "elsewhere" / "more.txt").write_text("x", encoding="utf-8")
        self.same(derived=[])

    def test_a_message_that_arrives_in_an_inbox_a_steer_named_is_shown(self):
        self.same()
        inbox = self.lab.main / "state" / "fix-login.inbox"
        (inbox / "2.msg").write_text(f"at={lab_iso(LAB_T0 + 299)}\n--\n[fm-from-firstmate] And run the tests.", encoding="utf-8")
        built = self.same(derived=[A])
        self.assertIn(b"And run the tests.", b"".join(built.payload))
        (inbox / "handled").mkdir(exist_ok=True)
        os.replace(inbox / "2.msg", inbox / "handled" / "2.msg")
        self.same(derived=[A])

    def test_the_instructions_a_pointer_names_are_read_again_when_that_file_changes(self):
        self.same()
        self.lab.brief.write_text("⁣FIRSTMATE_OP: v1 launch-brief: # Role\nYou are a worker.\n# Task\nFix the logout page.\n", encoding="utf-8")
        built = self.same(derived=[W])
        self.assertIn(b"Fix the logout page.", b"".join(built.payload))

    def test_a_session_joining_the_list_or_leaving_it(self):
        self.same()
        self.same([A, M], derived=[])
        self.same([A, W, M], derived=[W])  # a conversation that left the list is not kept
        new = "ffffffff-6666-4666-8666-666666666666"
        write_log(self.lab.projects / "main" / f"{new}.jsonl", [user("A new task.", LAB_T0 + 900, self.main), say("On it.", LAB_T0 + 910, self.main)], LAB_T0 + 920)
        self.same([A, W, M, new], derived=[new])

    def test_a_clear_joins_the_new_log_to_the_conversation_and_builds_it_again(self):
        self.same()
        new = "eeeeeeee-5555-4555-8555-555555555555"
        clear = {"type": "user", "timestamp": lab_iso(LAB_T0 + 701), "cwd": self.main, "message": {"role": "user", "content": CLEAR}}
        write_log(self.lab.projects / "main" / f"{new}.jsonl", [clear, user("Carry on.", LAB_T0 + 720, self.main), say("Carrying on.", LAB_T0 + 730, self.main)], LAB_T0 + 740)
        built = self.same(derived=[new])
        self.assertIn(b'"ids":["' + A.encode() + b'","' + new.encode() + b'"]', b"".join(built.payload))

    def test_what_herdr_says_changes_the_page_without_building_any_conversation_again(self):
        self.same()
        self.lab.panes[A] = {"label": "renamed", "title": "Alpha work", "herdr": "lab", "pane": "w1:p1", "status": "idle"}
        built = self.same(derived=[])
        self.assertIn(b'"label":"renamed"', b"".join(built.payload))
        self.lab.panes.clear()
        self.same(derived=[])
        (self.lab.root / "out" / "reopened.txt").write_text(f"{A}\n", encoding="utf-8")
        built = self.same(derived=[])
        self.assertIn(b'"reopened":true', b"".join(built.payload))

    def test_the_order_is_newest_activity_first_and_a_tie_keeps_the_lists_order(self):
        built = self.same()
        ids = [session["id"] for session in builder.build(self.args())["sessions"]]
        text = b"".join(built.payload)
        self.assertEqual(sorted(ids, key=lambda sid: text.index(sid.encode())), ids)
        append_log(self.lab.logs[M], [user("Anything else?", LAB_T0 + 2000, str(self.lab.mate)), say("No.", LAB_T0 + 2010, str(self.lab.mate))])
        self.newer(self.lab.logs[M])
        built = self.same(derived=[M])
        self.assertLess(b"".join(built.payload).index(M.encode()), b"".join(built.payload).index(A.encode()))

    def test_the_statistics_a_hand_run_prints_are_the_plain_builds(self):
        built = self.same()
        payload = builder.build(self.args())
        self.assertEqual(built.stats, builder.stats(payload))


class Leaders(Case):
    """A conversation whose working folder is a Firstmate home lists that home's backlog and task folders."""

    def setUp(self):
        super().setUp()
        (self.lab.main / "projects").mkdir()
        (self.lab.main / "data" / "backlog.md").write_text("## In flight\n- [ ] fix-login - Fix the login page (repo: x)\n", encoding="utf-8")
        self.task = self.lab.main / "data" / "fix-login"
        self.task.mkdir()
        (self.task / "report.md").write_text("# Report\n", encoding="utf-8")
        (self.task / "shot.png").write_bytes(b"\x89PNG")

    def test_the_task_folders_files_and_the_backlog(self):
        built = self.same(derived=[A, W, M])
        text = b"".join(built.payload)
        self.assertIn(b'"leader":{"dir":', text)
        self.assertIn(b"Fix the login page", text)
        self.assertIn(b'"lazy":true', text)
        self.same(derived=[])

    def test_a_file_in_a_task_folder_changes_the_page_and_builds_no_conversation_again(self):
        self.same()
        (self.task / "taskfile.md").write_text("# Notes\n", encoding="utf-8")
        built = self.same(derived=[])
        self.assertIn(b'"name":"taskfile.md"', b"".join(built.payload))
        (self.task / "taskfile.md").unlink()
        built = self.same(derived=[])
        self.assertNotIn(b'"name":"taskfile.md"', b"".join(built.payload))
        (self.task / "deeper").mkdir()
        (self.task / "deeper" / "plan.html").write_text("<p>plan</p>", encoding="utf-8")
        built = self.same(derived=[])
        self.assertIn(b'"kind":"html"', b"".join(built.payload))
        self.same(derived=[])

    def test_the_backlog_changing_builds_the_leader_again(self):
        self.same()
        (self.lab.main / "data" / "backlog.md").write_text("## Done\n- [x] fix-login - Fix the login page\n", encoding="utf-8")
        built = self.same(derived=[A])
        self.assertIn(b'"state":"Done"', b"".join(built.payload))

    def test_a_task_folder_cut_short_says_how_many_files_it_left_out(self):
        for number in range(5):
            (self.task / f"extra-{number}.md").write_text("x", encoding="utf-8")
        with mock.patch.object(builder, "MAX_TASK_FILES", 2):
            built = self.same()
            self.assertIn(b'"more":5', b"".join(built.payload))
            for number in range(3):
                (self.task / f"extra-{number}.md").unlink()
            built = self.same(derived=[])
            self.assertIn(b'"more":2', b"".join(built.payload))
            for number in range(3, 5):
                (self.task / f"extra-{number}.md").unlink()
            built = self.same(derived=[])
            self.assertNotIn(b'"more"', b"".join(built.payload))

    def test_a_leader_list_that_loses_its_leader_drops_the_homes_files(self):
        self.same()
        self.same([W, M], derived=[])
        self.assertEqual(build_cache._TASKS, {})


class Fuzz(Leaders):
    """Whatever mix of changes comes, the build from kept conversations is the build from nothing."""

    NAMES = ["notes.md", "later.md", "sketch.html", "shot.png", "taskfile.md", "report.md", "missing.md"]

    def step(self, rng, number):
        main, task = self.lab.main, self.task
        kind = rng.choice(["turn", "turn", "file", "file", "unlink", "inbox", "panes", "unrelated", "backlog", "taskfile", "taskdir", "reopen", "order"])
        if kind == "turn":
            session = rng.choice([A, W, M])
            cwd = self.main if session != M else str(self.lab.mate)
            named = " and ".join(f"`{name}`" for name in rng.sample(self.NAMES, rng.randint(0, 3)))
            reply = f"Step {number}: see {named}." if named else f"Step {number}: nothing to name."
            append_log(self.lab.logs[session], [user(f"Turn {number}.", LAB_T0 + 1000 + number * 10, cwd), say(reply, LAB_T0 + 1005 + number * 10, cwd)])
            self.newer(self.lab.logs[session])
        elif kind == "file":
            name = rng.choice(self.NAMES)
            folder = rng.choice([main, task, main / "state"])
            (folder / name).write_bytes(b"\x89PNG" + bytes([number]) if name.endswith(".png") else f"# {name} {number}\n".encode())
        elif kind == "unlink":
            for folder in (main, task):
                target = folder / rng.choice(self.NAMES)
                if target.exists():
                    target.unlink()
                    break
        elif kind == "inbox":
            inbox = main / "state" / "fix-login.inbox"
            (inbox / f"{number + 10}.msg").write_text(f"at={lab_iso(LAB_T0 + 280 + number)}\n--\n[fm-from-firstmate] Message {number}.", encoding="utf-8")
        elif kind == "panes":
            self.lab.panes.clear()
            if rng.random() < 0.7:
                self.lab.panes[rng.choice([A, W, M])] = {"label": f"pane {number}", "title": "t", "herdr": "lab", "pane": f"w1:p{number}", "status": "idle"}
        elif kind == "unrelated":
            (rng.choice([main, task, main / "data", self.lab.root / "elsewhere"]) / f"unrelated-{number}.txt").write_text("x", encoding="utf-8")
        elif kind == "backlog":
            (main / "data" / "backlog.md").write_text(f"## In flight\n- [ ] fix-login - Step {number}\n- [x] other-{number} - Done thing\n", encoding="utf-8")
        elif kind == "taskfile":
            (task / f"extra-{rng.randint(0, 4)}.md").write_text(f"x{number}", encoding="utf-8")
        elif kind == "taskdir":
            folder = main / "data" / f"task-{rng.randint(0, 2)}"
            folder.mkdir(exist_ok=True)
            (folder / "one.md").write_text(f"y{number}", encoding="utf-8")
        elif kind == "reopen":
            (self.lab.root / "out" / "reopened.txt").write_text(rng.choice([f"{A}\n", "", f"{M}\n"]), encoding="utf-8")
        else:
            self.sessions = rng.sample([A, W, M], rng.randint(1, 3))
        time.sleep(0.002)
        return kind

    def run_seed(self, seed):
        rng = random.Random(seed)
        (self.lab.main / "state" / "fix-login.inbox").mkdir(exist_ok=True)
        with mock.patch.object(builder, "MAX_TASK_FILES", 3):
            self.same()
            for number in range(30):
                kind = self.step(rng, number)
                self.same(self.sessions)
                self.assertTrue(True, kind)
            self.same(self.sessions, derived=[])


for seed in range(8):
    setattr(Fuzz, f"test_a_random_run_of_changes_seed_{seed}", lambda self, seed=seed: self.run_seed(seed))


class Reading(unittest.TestCase):
    """What a recording sees, and when what it saw still holds."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        (self.root / "sub").mkdir()
        (self.root / "sub" / "a.md").write_text("a", encoding="utf-8")

    def holds(self, reads):
        return reads.hold({})

    def test_what_pathlib_and_open_and_walk_ask_is_recorded_whether_the_path_is_there_or_not(self):
        with build_cache.recording() as reads:
            self.assertTrue((self.root / "sub" / "a.md").is_file())
            self.assertFalse((self.root / "sub" / "b.md").is_file())
            (self.root / "sub" / "a.md").resolve()
            (self.root / "sub" / "a.md").read_text(encoding="utf-8")
            with open(self.root / "sub" / "a.md", encoding="utf-8"):
                pass
            list(os.walk(self.root))
            sorted(os.listdir(self.root))
            (self.root / "sub" / "a.md").lstat()
        seen = reads.seen
        self.assertIn(str(self.root / "sub" / "a.md"), seen["stat"])
        self.assertIsNone(seen["stat"][str(self.root / "sub" / "b.md")])
        self.assertIn(str(self.root / "sub" / "a.md"), seen["lstat"])
        self.assertIn(str(self.root / "sub" / "a.md"), seen["file"])
        self.assertIn(str(self.root / "sub"), seen["dir"])
        self.assertIn(str(self.root), seen["dir"])
        self.assertTrue(self.holds(reads))

    def test_a_change_to_anything_it_saw_is_seen(self):
        target = self.root / "sub" / "a.md"
        for what, change in {
            "its text": lambda: target.write_text("longer", encoding="utf-8"),
            "its removal": lambda: target.unlink(),
            "its replacement": lambda: (target.with_name("new"), target.with_name("new").write_text("a", encoding="utf-8"), os.replace(target.with_name("new"), target))[-1],
        }.items():
            with self.subTest(what):
                target.write_text("a", encoding="utf-8")
                with build_cache.recording() as reads:
                    target.read_text(encoding="utf-8")
                    target.stat()
                self.assertTrue(self.holds(reads))
                time.sleep(0.01)
                change()
                self.assertFalse(self.holds(reads))

    def test_a_path_that_was_not_there_is_seen_arriving_and_a_listing_is_seen_changing(self):
        with build_cache.recording() as reads:
            (self.root / "sub" / "b.md").exists()
            os.listdir(self.root / "sub")
        self.assertTrue(self.holds(reads))
        (self.root / "sub" / "b.md").write_text("b", encoding="utf-8")
        self.assertFalse(self.holds(reads))
        with build_cache.recording() as listed:
            os.listdir(self.root / "sub")
        (self.root / "sub" / "b.md").unlink()
        self.assertFalse(self.holds(listed), "an entry removed from a listed folder")

    def test_a_link_is_seen_pointing_elsewhere(self):
        (self.root / "sub" / "b.md").write_text("b", encoding="utf-8")
        link = self.root / "link.md"
        link.symlink_to(self.root / "sub" / "a.md")
        with build_cache.recording() as reads:
            self.assertEqual(link.resolve(), self.root / "sub" / "a.md")
        self.assertTrue(self.holds(reads))
        link.unlink()
        link.symlink_to(self.root / "sub" / "b.md")
        self.assertFalse(self.holds(reads))

    def test_a_file_written_in_a_folder_the_path_passed_through_is_not_a_change(self):
        with build_cache.recording() as reads:
            (self.root / "sub" / "a.md").resolve()
            (self.root / "sub" / "a.md").stat()
        (self.root / "sub" / "unrelated.md").write_text("x", encoding="utf-8")
        (self.root / "top.md").write_text("x", encoding="utf-8")
        self.assertTrue(self.holds(reads), "only a listing is changed by an entry coming and going")

    def test_a_file_that_changes_while_the_work_runs_is_not_taken_for_what_it_became(self):
        target = self.root / "sub" / "a.md"
        with build_cache.recording() as reads:
            target.read_text(encoding="utf-8")
            time.sleep(0.01)
            target.write_text("changed meanwhile", encoding="utf-8")  # a write: not recorded, but the read was
            target.read_text(encoding="utf-8")
        self.assertFalse(self.holds(reads), "the first look is what is recorded")

    def test_writing_is_not_recorded_nothing_nests_and_the_calls_come_back_after_an_error(self):
        real = (os.stat, os.lstat, os.scandir, os.listdir)
        import builtins
        import io
        opened = (io.open, builtins.open)
        with build_cache.recording() as reads:
            (self.root / "written.txt").write_text("x", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                with build_cache.recording():
                    pass
        self.assertNotIn(str(self.root / "written.txt"), reads.seen["file"])
        with self.assertRaises(ValueError):
            with build_cache.recording():
                raise ValueError("inside")
        self.assertEqual((os.stat, os.lstat, os.scandir, os.listdir), real)
        self.assertEqual((io.open, builtins.open), opened)
        with build_cache.recording():
            pass  # no longer in one

    def test_the_answers_of_a_build_are_asked_once_for_every_conversation_that_asks(self):
        with build_cache.recording() as first:
            (self.root / "sub" / "a.md").stat()
        with build_cache.recording() as second:
            (self.root / "sub" / "a.md").stat()
        now = {}
        with mock.patch.object(build_cache, "look", wraps=build_cache.look) as look:
            self.assertTrue(first.hold(now))
            self.assertTrue(second.hold(now))
        self.assertEqual(look.call_count, 1)


class Writing(Case):
    """The files a build writes are the files the plain build writes."""

    def written(self, folder):
        """What a build left in its folder for the page and the server: not the parsed logs, which a kept conversation has no need to read."""
        return {str(path.relative_to(folder)): path.read_bytes() for path in sorted(folder.rglob("*"))
                if path.is_file() and not path.name.endswith(".lock") and "parsed" not in path.relative_to(folder).parts}

    def both_written(self, name=""):
        """The folder the plain build writes and the one build_cache writes, from one moment."""
        stamp = time.time()
        plain, cached = self.lab.root / f"plain{name}", self.lab.root / f"cached{name}"
        with mock.patch("time.time", lambda: stamp), builder.chains_frozen():
            builder.write_page(builder.TEMPLATE, builder.build(self.args(out=plain / "prototype.html")), plain / "prototype.html")
            built = build_cache.build(self.args(out=cached / "prototype.html"))
            build_cache.write(built, cached / "prototype.html")
        return plain, cached

    def test_the_page_its_stamp_the_lists_of_files_and_the_tool_output_are_the_same_bytes(self):
        for number in range(2):
            builder._LOG_INDEX.clear()
            plain, cached = self.both_written(f"-{number}")
            theirs, ours = self.written(plain), self.written(cached)
            self.assertEqual(sorted(ours), sorted(theirs), f"round {number}")
            for name in theirs:
                if name != "pane-labels.json":
                    self.assertEqual(ours[name], theirs[name], f"{name}, round {number}")
            self.assertIn("prototype.html", ours)
            self.assertIn("html-files.json", ours)

    def test_a_page_that_is_the_one_already_written_leaves_it_and_its_stamp_alone(self):
        out = self.lab.root / "out" / "prototype.html"
        built = self.same()
        self.assertTrue(build_cache.write(built, out))
        before = {name: (path.stat().st_mtime_ns, path.read_bytes()) for name, path in ((n, out.with_name(n)) for n in ("prototype.html", "prototype.stamp"))}
        time.sleep(0.02)
        builder._LOG_INDEX.clear()
        built = self.same(derived=[])
        self.assertTrue(build_cache.write(built, out))
        after = {name: (out.with_name(name).stat().st_mtime_ns, out.with_name(name).read_bytes()) for name in before}
        self.assertEqual(after, before, "nothing a page shows has changed")
        append_log(self.lab.logs[A], [user("Go ahead.", LAB_T0 + 800, self.main), say("Starting now.", LAB_T0 + 810, self.main)])
        self.newer(self.lab.logs[A])
        builder._LOG_INDEX.clear()
        time.sleep(0.02)
        build_cache.write(self.same(derived=[A]), out)
        self.assertGreater(float(out.with_suffix(".stamp").read_text()), float(before["prototype.stamp"][1]))
        self.assertIn(b"Starting now.", out.read_bytes())

    def test_a_page_written_by_another_process_is_not_taken_for_this_ones(self):
        out = self.lab.root / "out" / "prototype.html"
        build_cache.write(self.same(), out)
        out.write_text("another process's page", encoding="utf-8")
        builder._LOG_INDEX.clear()
        build_cache.write(self.same(derived=[]), out)
        self.assertEqual(out.read_text(encoding="utf-8") == "another process's page", True, "its (newer) page stays: nothing to say that this one is better")

    def test_a_template_that_changes_is_written_though_no_conversation_did(self):
        out = self.lab.root / "out" / "prototype.html"
        build_cache.write(self.same(), out)
        template = self.lab.root / "template.html"
        template.write_text(builder.TEMPLATE.read_text(encoding="utf-8").replace("<title>", "<title>(changed) ", 1), encoding="utf-8")
        with mock.patch.object(builder, "TEMPLATE", template):
            builder._LOG_INDEX.clear()
            time.sleep(0.02)
            built = self.same(derived=[])
            self.assertTrue(build_cache.write(built, out))
        self.assertIn(b"(changed) ", out.read_bytes())

    def test_the_tool_output_goes_beside_the_page_and_comes_back_when_it_is_taken_away(self):
        append_log(self.lab.logs[A], [user("Run it.", LAB_T0 + 800, self.main), {
            "type": "assistant", "timestamp": lab_iso(LAB_T0 + 801), "cwd": self.main,
            "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "echo hi"}}]}},
            {"type": "user", "timestamp": lab_iso(LAB_T0 + 802), "cwd": self.main,
             "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "hi there"}]}},
            say("Ran it.", LAB_T0 + 803, self.main)])
        self.newer(self.lab.logs[A])
        out = self.lab.root / "out" / "prototype.html"
        build_cache.write(self.same(), out)
        output = out.with_name("steps") / f"{A}.json"
        self.assertIn(b"hi there", output.read_bytes())
        self.assertNotIn(b"hi there", out.read_bytes(), "the page never holds it")
        stale = out.with_name("steps") / "gone.json"
        stale.write_text("{}", encoding="utf-8")
        output.unlink()
        builder._LOG_INDEX.clear()
        build_cache.write(self.same(derived=[A]), out)
        self.assertIn(b"hi there", output.read_bytes())
        self.assertFalse(stale.exists(), "a conversation with none left has no file")

    def test_a_build_made_later_than_this_one_is_not_overwritten_and_nothing_stale_is_kept(self):
        out = self.lab.root / "out" / "prototype.html"
        built = self.same()
        build_cache.write(built, out)
        out.with_suffix(".stamp").write_text(repr(time.time() + 1000), encoding="utf-8")
        builder._LOG_INDEX.clear()
        self.assertFalse(build_cache.write(self.same(derived=[]), out))
        self.assertEqual(build_cache._THREADS, {}, "what was kept may be ahead of what was written")

    def test_the_files_are_the_owners_alone(self):
        out = self.lab.root / "out" / "prototype.html"
        build_cache.write(self.same(), out)
        for path in out.parent.rglob("*"):
            if path.is_file() and not path.name.endswith(".lock"):
                self.assertEqual(path.stat().st_mode & 0o077, 0, path.name)


class RunByHand(Case):
    """builder.main is the plain build unless it is the worker's, and then the same page."""

    def test_a_worker_and_a_hand_run_write_the_same_page(self):
        argv = lambda out: ["--main-home", self.main, "--listed", *(a for sid in self.sessions for a in ("--session", sid)), "--out", str(out)]
        stamp = time.time()
        plain, cached = self.lab.root / "plain" / "prototype.html", self.lab.root / "cached" / "prototype.html"
        with mock.patch("time.time", lambda: stamp), mock.patch("builtins.print"), builder.chains_frozen():
            with mock.patch.object(builder, "__name__", "__main__"):
                self.assertEqual(builder.main(argv(plain)), 0)  # the plain build, as a script
            self.assertEqual(builder.main(argv(cached)), 0)
        self.assertEqual(self.derived and sorted(self.derived), sorted(self.sessions), "only the second made it from kept conversations")
        self.assertEqual(cached.read_bytes(), plain.read_bytes())
        self.assertEqual(cached.with_suffix(".stamp").read_bytes(), plain.with_suffix(".stamp").read_bytes())

    def test_the_fleet_timeline_and_the_statistics_are_the_plain_builds(self):
        with mock.patch.dict(os.environ, {builder.FLEET_TIMELINE_ENV: "on"}):
            self.assertFalse(build_cache.usable(self.args()))
        self.assertTrue(build_cache.usable(self.args()))
        self.assertFalse(build_cache.usable(argparse.Namespace(session=None, since_hours=None)))
        with mock.patch("builtins.print") as shown:
            builder.main(["--main-home", self.main, "--stats", "--session", A, "--out", str(self.lab.root / "x" / "p.html")])
        self.assertEqual(self.derived, [])
        self.assertTrue(shown.call_args.args[0].startswith("main"))


class Sheets(Case):
    """The answer sheet is built from the same logs, and is left alone when no sheet changed."""

    def collect(self):
        with mock.patch.object(build_questionnaire, "OUT", self.lab.root / "out"):
            return build_questionnaire.collect([A, W, M])

    def test_what_a_log_asked_is_kept_while_the_log_is_as_it_was_and_asked_again_when_it_is_not(self):
        build_questionnaire._MEMBERS.clear()
        self.addCleanup(build_questionnaire._MEMBERS.clear)
        first = self.collect()
        self.assertTrue(first)
        with mock.patch.object(build_questionnaire, "member_questionnaires", side_effect=AssertionError("asked again")):
            self.assertEqual(self.collect(), first)
        append_log(self.lab.logs[M], [user("Another?", LAB_T0 + 2000, str(self.lab.mate)), say("No.", LAB_T0 + 2010, str(self.lab.mate))])
        self.newer(self.lab.logs[M])
        self.assertEqual(self.collect(), first, "a turn without a sheet adds none")
        with mock.patch.object(build_questionnaire, "kept_questionnaires", wraps=build_questionnaire.kept_questionnaires):
            plain = [q for chain in ([self.lab.logs[M]],) for q in build_questionnaire.chain_questionnaires(chain, self.lab.root / "out" / "parsed")]
        self.assertEqual([q["title"] for q in plain], [q["title"] for q in first])

    def test_a_sheet_that_changes_nothing_a_page_shows_leaves_the_page_and_its_stamp(self):
        out = self.lab.root / "out" / "questionnaire.html"
        with mock.patch.object(build_questionnaire, "OUT", self.lab.root / "out"), mock.patch("builtins.print"):
            self.assertEqual(build_questionnaire.main(["--session", A, "--session", M, "--out", str(out)]), 0)
            first = (out.read_bytes(), out.with_suffix(".stamp").read_bytes(), out.stat().st_mtime_ns)
            time.sleep(0.02)
            self.assertEqual(build_questionnaire.main(["--session", A, "--session", M, "--out", str(out)]), 0)
            self.assertEqual((out.read_bytes(), out.with_suffix(".stamp").read_bytes(), out.stat().st_mtime_ns), first)
            append_log(self.lab.logs[M], [user("More?", LAB_T0 + 3000, str(self.lab.mate)), say("Two choices:\n\n| ID | Question | Answer |\n| --- | --- | --- |\n| B1 | Ship? | `yes` / `no` |\n\nReply with: B1=...", LAB_T0 + 3010, str(self.lab.mate))])
            self.newer(self.lab.logs[M])
            builder._LOG_INDEX.clear()
            self.assertEqual(build_questionnaire.main(["--session", A, "--session", M, "--out", str(out)]), 0)
        self.assertNotEqual(out.read_bytes(), first[0])
        self.assertIn(b"B1", out.read_bytes())
        self.assertGreater(float(out.with_suffix(".stamp").read_text()), float(first[1]))


class Rebuilds(unittest.TestCase):
    """The parts of a rebuild that ask the same thing of the same logs, Herdr and clears many times."""

    def test_herdr_is_asked_once_for_a_rebuild_and_again_for_the_next(self):
        reading = mock.Mock(side_effect=lambda: ({"s": {"label": "x"}}, {("lab", "w1:p1")}))
        with mock.patch.object(builder, "read_herdr", reading):
            with builder.chains_frozen():
                first = builder.herdr_inventory()
                first[0]["s"] = "changed by a caller"
                self.assertEqual(builder.herdr_inventory(), ({"s": {"label": "x"}}, {("lab", "w1:p1")}), "a caller changing what it was given changes no other")
                builder.herdr_panes()
                with builder.chains_frozen():
                    builder.herdr_inventory()
            self.assertEqual(reading.call_count, 1)
            builder.herdr_inventory()
            builder.herdr_inventory()
            self.assertEqual(reading.call_count, 3, "outside a rebuild every call asks")
            with builder.chains_frozen():
                builder.herdr_inventory()
            self.assertEqual(reading.call_count, 4)

    def test_a_herdr_that_could_not_be_read_stays_unread_for_the_rest_of_the_rebuild(self):
        with mock.patch.object(builder, "read_herdr", return_value=({}, None)) as reading:
            with builder.chains_frozen():
                self.assertEqual(builder.herdr_inventory(), ({}, None))
                self.assertEqual(builder.herdr_inventory(), ({}, None))
        self.assertEqual(reading.call_count, 1)

    def test_a_clear_is_looked_up_once_for_a_rebuild(self):
        path = Path("/x/log.jsonl")
        with mock.patch.object(builder, "cleared_from_log", return_value=None) as looked:
            with builder.chains_frozen():
                for _ in range(5):
                    builder.cleared_from(path, 100.0)
                builder.cleared_from(path, 200.0)
            self.assertEqual(looked.call_count, 2)
            builder.cleared_from(path, 100.0)
            builder.cleared_from(path, 100.0)
            self.assertEqual(looked.call_count, 4, "outside a rebuild every call looks")

    def test_what_a_path_is_asked_of_the_log_index_is_one_tuple(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(builder, "PROJECTS", Path(tmp)):
            drop_caches()
            self.addCleanup(drop_caches)
            self.assertIs(builder.log_index(), builder.log_index())

    def test_a_shown_folder_is_the_same_text_it_was_with_a_path_for_each_piece(self):
        home = Path(os.path.expanduser("~"))
        for path, shown in ((home / "a" / "b.md", "~/a"), (home / "b.md", "~/."), (Path("/tmp/x/b.md"), "/tmp/x"), (Path(str(home) + "x") / "b.md", str(home) + "x"),
                            (home / "a" / "b" / "c" / "d.md", "~/a/b/c")):
            self.assertEqual(builder.shown_dir(path), shown)


if __name__ == "__main__":
    unittest.main()
