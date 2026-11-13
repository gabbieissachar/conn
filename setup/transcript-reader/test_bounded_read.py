"""Tests for prototype/bounded_read.py: a read of a file that never answers (macOS waiting on an unanswered permission dialog for Downloads or
Desktop, a cloud folder whose app is not running) must not stop a build.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_bounded_read.py
The hang is made the way it looks from the reader: the open of one named path does not return. Fixtures are synthetic.
"""

import os
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "prototype"))
import bounded_read  # noqa: E402
import build_cache  # noqa: E402
from reader import builder  # noqa: E402


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(__import__("shutil").rmtree, self.dir)
        self.release = threading.Event()
        self.addCleanup(self.release.set)   # a read that "hangs" ends with the test, so no thread outlives it
        self.hung = []       # the paths whose read was started and is held
        self.started = []    # every path the read was started for
        self.stuck_names = set()
        real = pathlib.Path.read_text

        def read_text(path, *args, **kwargs):
            self.started.append(str(path))
            if path.name in self.stuck_names:
                self.hung.append(str(path))
                self.release.wait(30)
            return real(path, *args, **kwargs)
        patch = mock.patch.object(pathlib.Path, "read_text", read_text)
        patch.start()
        self.addCleanup(patch.stop)
        self.now = 1000.0
        for target, value in ((bounded_read, "clock"), (bounded_read, "DEADLINE_S")):
            patch = mock.patch.object(target, value, (lambda: self.now) if value == "clock" else 0.3)
            patch.start()
            self.addCleanup(patch.stop)
        bounded_read._held.clear()
        bounded_read._helper = None
        self.addCleanup(bounded_read._held.clear)

    def write(self, folder, name, text="text"):
        (self.dir / folder).mkdir(parents=True, exist_ok=True)
        path = self.dir / folder / name
        path.write_text(text, encoding="utf-8")
        return path


class ReadTest(Case):
    def test_a_file_that_answers_is_read_as_path_read_text_reads_it(self):
        path = self.write("a", "plain.md", "héllo\n")
        self.assertEqual(bounded_read.read_text(path), "héllo\n")
        path.write_bytes(b"ok \xff\xfe bytes")
        self.assertEqual(bounded_read.read_text(path), "ok �� bytes", "undecodable bytes are replaced, as the build always did")
        self.assertEqual(bounded_read.read_text(self.write("a", "empty.md", "")), "")
        self.assertEqual(bounded_read.held(), ())

    def test_a_file_that_is_not_there_raises_its_own_error(self):
        with self.assertRaises(FileNotFoundError):
            bounded_read.read_text(self.dir / "a" / "gone.md")
        self.assertEqual(bounded_read.held(), (), "an error is not a hang")

    def test_a_read_that_does_not_answer_is_given_up_within_the_deadline(self):
        path = self.write("a", "stuck.md")
        self.stuck_names.add("stuck.md")
        began = time.monotonic()
        with self.assertRaises(TimeoutError) as caught:
            bounded_read.read_text(path)
        self.assertLess(time.monotonic() - began, 2.0)
        self.assertIsInstance(caught.exception, OSError, "a caller that leaves out a file it cannot read leaves this one out")
        self.assertEqual(self.hung, [str(path)])

    def test_the_folder_is_left_alone_for_a_while_and_other_folders_are_read(self):
        stuck = self.write("a", "stuck.md")
        other = self.write("a", "other.md", "same folder")
        elsewhere = self.write("b", "fine.md", "another folder")
        self.stuck_names.add("stuck.md")
        with self.assertRaises(TimeoutError):
            bounded_read.read_text(stuck)
        self.assertEqual(bounded_read.held(), (str(self.dir / "a"),))
        began, count = time.monotonic(), len(self.started)
        with self.assertRaises(TimeoutError):
            bounded_read.read_text(other)
        self.assertLess(time.monotonic() - began, 0.1, "a held folder is not waited for again")
        self.assertEqual(len(self.started), count, "and not asked")
        self.assertEqual(bounded_read.read_text(elsewhere), "another folder", "a helper that is stuck does not stop the next read")

    def test_the_folder_is_asked_again_once_its_time_is_over(self):
        stuck = self.write("a", "stuck.md")
        other = self.write("a", "other.md", "back")
        self.stuck_names.add("stuck.md")
        with self.assertRaises(TimeoutError):
            bounded_read.read_text(stuck)
        self.now += bounded_read.HOLD_S - 1
        self.assertEqual(len(bounded_read.held()), 1)
        self.now += 2
        self.assertEqual(bounded_read.held(), ())
        self.assertEqual(bounded_read.read_text(other), "back")
        self.stuck_names.clear()
        self.release.set()
        self.assertEqual(bounded_read.read_text(stuck), "text")

    def test_a_protected_folder_of_the_home_is_held_whole(self):
        home = self.dir / "home"
        stuck = self.write("home/Downloads/plans", "stuck.md")
        sibling = self.write("home/Downloads/other", "b.md")
        outside = self.write("home/workspace/project", "c.md", "fine")
        self.stuck_names.add("stuck.md")
        with mock.patch.object(Path, "home", return_value=home):
            with self.assertRaises(TimeoutError):
                bounded_read.read_text(stuck)
            self.assertEqual(bounded_read.held(), (str(home / "Downloads"),))
            with self.assertRaises(TimeoutError):
                bounded_read.read_text(sibling)
            self.assertEqual(bounded_read.read_text(outside), "fine", "an ordinary folder under the home stays readable")

    def test_a_helper_whose_read_comes_back_ends(self):
        before = {t for t in threading.enumerate() if t.name == "bounded-read"}
        stuck = self.write("a", "stuck.md")
        self.stuck_names.add("stuck.md")
        with self.assertRaises(TimeoutError):
            bounded_read.read_text(stuck)
        mine = {t for t in threading.enumerate() if t.name == "bounded-read"} - before
        self.assertEqual(len(mine), 1)
        self.release.set()
        for thread in mine:
            thread.join(5)
            self.assertFalse(thread.is_alive())


class BuildTest(Case):
    """The build that names the files."""

    def attach(self, reply, cwd):
        sessions = [{"exchanges": [{"reply": reply, "cwd": str(cwd)}]}]
        began = time.monotonic()
        documents = builder.attach_documents(sessions)
        return documents, sessions[0]["exchanges"][0], time.monotonic() - began

    def test_a_reply_naming_a_file_that_does_not_answer_still_shows_the_files_that_do(self):
        stuck = self.write("hung", "Plan.md", "never read")
        ok = self.write("fine", "notes.md", "# Notes\n")
        self.stuck_names.add("Plan.md")
        documents, exchange, took = self.attach(f"See `{stuck}` and `{ok}`.", self.dir)
        self.assertEqual([doc["name"] for doc in documents.values()], ["notes.md"])
        self.assertEqual(exchange["documents"], [builder.doc_key(ok.resolve())], "the turn lists the one that was read")
        self.assertLess(took, 3.0)

    def test_the_next_build_does_not_wait_for_the_folder_again(self):
        stuck = self.write("hung", "Plan.md")
        self.write("hung", "Second.md")
        self.stuck_names.add("Plan.md")
        self.attach(f"`{stuck}`", self.dir)
        documents, _, took = self.attach(f"`{stuck}` and `{self.dir / 'hung' / 'Second.md'}`", self.dir)
        self.assertEqual(documents, {})
        self.assertLess(took, 0.2)

    def test_a_file_that_comes_back_is_listed_by_the_next_build_after_its_time(self):
        stuck = self.write("hung", "Plan.md", "# Plan\n")
        self.stuck_names.add("Plan.md")
        self.attach(f"`{stuck}`", self.dir)
        self.stuck_names.clear()
        self.release.set()
        self.now += bounded_read.HOLD_S + 1
        documents, _, _ = self.attach(f"`{stuck}`", self.dir)
        self.assertEqual([doc["name"] for doc in documents.values()], ["Plan.md"])


class KeptConversationTest(Case):
    def test_a_conversation_is_built_again_when_a_folder_is_taken_up_or_let_go(self):
        home = {"id": "h", "home": self.dir}
        before = build_cache.thread_key(home, None, [])
        stuck = self.write("hung", "Plan.md")
        self.stuck_names.add("Plan.md")
        with self.assertRaises(TimeoutError):
            bounded_read.read_text(stuck)
        held = build_cache.thread_key(home, None, [])
        self.assertNotEqual(before, held, "a conversation kept before the folder stopped answering is built again (and leaves the file out at once)")
        self.assertEqual(held, build_cache.thread_key(home, None, []), "and kept while the folder stays held")
        self.now += bounded_read.HOLD_S + 1
        self.assertEqual(before, build_cache.thread_key(home, None, []), "built again once the folder has had its time, which reads the file again")


if __name__ == "__main__":
    unittest.main()
