"""Tests for reader.py session resolution, the Herdr pane naming it relies on, the
documents a reply names, and the sessions a pane ran across /clear.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_reader.py
Fixtures are synthetic; no real session log or Herdr call is used.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reader  # noqa: E402
from reader import builder  # noqa: E402

A = "aaaaaaaa-1111-4111-8111-111111111111"
B = "aaaaaabb-2222-4222-8222-222222222222"
C = "cccccccc-3333-4333-8333-333333333333"

PANES = {
    A: {"label": "leader-esim", "title": "Secondmate eSIM session handoff", "herdr": "esim"},
    B: {"label": "fm-2026-10-05-esim-bc36-final-spec", "title": "Bc36 spec handoff rule 3", "herdr": "esim"},
    C: {"label": "fm-2026-10-05-esim-bc36-spec-review", "title": "ESIM BC36 spec review handoff", "herdr": "esim"},
}


class PaneIndexTest(unittest.TestCase):
    def test_pane_label_then_tab_label_then_title(self):
        panes = [
            {"pane_id": "w1:p1", "tab_id": "w1:t1", "label": "leader-esim", "terminal_title_stripped": "Handoff", "agent_session": {"value": A}},
            {"pane_id": "w1:p2", "tab_id": "w1:t2", "label": None, "terminal_title_stripped": "Bc36 spec", "agent_session": {"value": B}},
            {"pane_id": "w1:p3", "tab_id": "w1:t9", "terminal_title_stripped": "Review", "agent_session": {"value": C}},
            {"pane_id": "w1:p4", "tab_id": "w1:t1", "terminal_title_stripped": "a shell, no agent session"},
        ]
        tabs = [{"tab_id": "w1:t1", "label": "leader-esim"}, {"tab_id": "w1:t2", "label": "fm-bc36-final-spec"}]
        index = builder.pane_index("esim", panes, tabs)
        self.assertEqual(index[A]["label"], "leader-esim")
        self.assertEqual(index[B], {"label": "fm-bc36-final-spec", "title": "Bc36 spec", "herdr": "esim"})
        self.assertEqual(index[C]["label"], "Review")
        self.assertEqual(len(index), 3)


class ResolveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.projects = Path(self.tmp.name)
        folder = self.projects / "-Users-someone-home"
        folder.mkdir()
        for sid in (A, B, C):
            (folder / f"{sid}.jsonl").write_text("{}\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def resolve(self, name):
        return reader.resolve(name, PANES, self.projects)

    def test_full_id_and_unique_prefix(self):
        self.assertEqual(self.resolve(A), A)
        self.assertEqual(self.resolve("cccccccc"), C)

    def test_ambiguous_prefix_is_refused(self):
        with self.assertRaisesRegex(ValueError, "matches 2 sessions"):
            self.resolve("aaaaaa")

    def test_unknown_full_id_is_refused(self):
        with self.assertRaisesRegex(ValueError, "no session log"):
            self.resolve("dddddddd-4444-4444-8444-444444444444")

    def test_log_path(self):
        self.assertEqual(self.resolve(str(self.projects / "-Users-someone-home" / f"{B}.jsonl")), B)

    def test_exact_label_wins_over_partial(self):
        self.assertEqual(self.resolve("LEADER-ESIM"), A)

    def test_unique_part_of_label_or_title(self):
        self.assertEqual(self.resolve("final-spec"), B)
        self.assertEqual(self.resolve("review handoff"), C)

    def test_part_matching_several_panes_is_refused(self):
        with self.assertRaisesRegex(ValueError, "several panes"):
            self.resolve("bc36")

    def test_no_match(self):
        with self.assertRaisesRegex(ValueError, "no session or Herdr pane"):
            self.resolve("nothing-like-this")


class FollowTest(unittest.TestCase):
    """`follow` is what the server runs for the pane Herdr focuses: a full id with a log, no server start."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "projects" / "-Users-someone-home").mkdir(parents=True)
        (root / "projects" / "-Users-someone-home" / f"{A}.jsonl").write_text("{}\n", encoding="utf-8")
        self.saved = (builder.PROJECTS, reader.OUT, reader.LIST, reader.rebuild)
        builder.PROJECTS, reader.OUT, reader.LIST = root / "projects", root / "out", root / "out" / "sessions.txt"
        self.rebuilds = []
        reader.rebuild = lambda ids, focus=None, serve_page=True: self.rebuilds.append((list(ids), serve_page)) or 0

    def tearDown(self):
        builder.PROJECTS, reader.OUT, reader.LIST, reader.rebuild = self.saved
        self.tmp.cleanup()

    def test_adds_once_and_rebuilds_without_serving(self):
        self.assertEqual(reader.main(["follow", A]), 0)
        self.assertEqual(reader.main(["follow", A]), 0)
        self.assertEqual(reader.read_list(), [A])
        self.assertEqual(self.rebuilds, [([A], False), ([A], False)])

    def test_refuses_anything_but_one_full_id_with_a_log(self):
        for names in (["aaaaaaaa"], [C], ["leader-esim"], [A, A], []):
            self.assertEqual(reader.main(["follow", *names]), 2, names)
        self.assertEqual(reader.read_list(), [])
        self.assertEqual(self.rebuilds, [])


class DocumentsTest(unittest.TestCase):
    """A reply's markdown file names resolve to files on disk, by fixed rules."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name).resolve()
        self.repo = self.home / "copy" / "personal"
        self.prd = self.repo / "02-Projects" / "esim" / "prds" / "bc49"
        self.prd.mkdir(parents=True)
        (self.prd / "requirements.md").write_text("# Requirements\n", encoding="utf-8")
        (self.repo / "notes.md").write_text("notes\n", encoding="utf-8")
        patcher = mock.patch.dict(os.environ, {"HOME": str(self.home)})  # Path.home() and ~ both read it
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def names(self, reply, cwd):
        return [(token, path.relative_to(self.home).as_posix()) for token, path in builder.reply_documents(reply, str(cwd))]

    def test_a_path_from_the_repository_root_resolves_from_a_deeper_working_directory(self):
        reply = "**Draft:** `02-Projects/esim/prds/bc49/requirements.md` and again 02-Projects/esim/prds/bc49/requirements.md"
        self.assertEqual(self.names(reply, self.repo / "02-Projects" / "esim"),
                         [("02-Projects/esim/prds/bc49/requirements.md", "copy/personal/02-Projects/esim/prds/bc49/requirements.md")])

    def test_a_bare_name_resolves_under_the_latest_cd_line_before_it(self):
        reply = f"```\ncd {self.home}/elsewhere\n```\n```\ncd {self.prd}\n```\n- `requirements.md`\n- `notes.md`"
        self.assertEqual(self.names(reply, self.repo), [("requirements.md", "copy/personal/02-Projects/esim/prds/bc49/requirements.md"),
                                                        ("notes.md", "copy/personal/notes.md")])

    def test_absolute_and_home_paths_are_taken_as_written(self):
        reply = f"See {self.prd}/requirements.md and ~/copy/personal/notes.md."
        self.assertEqual([path for _, path in self.names(reply, "")], ["copy/personal/02-Projects/esim/prds/bc49/requirements.md", "copy/personal/notes.md"])

    def test_urls_missing_files_other_types_and_folders_above_home_are_left_out(self):
        (self.home.parent / "outside.md").write_text("x", encoding="utf-8")
        self.addCleanup((self.home.parent / "outside.md").unlink)
        reply = "https://example.com/x/notes.md, `gone.md`, `requirements.txt`, `outside.md`, ../outside.md"
        self.assertEqual(self.names(reply, self.repo), [])

    def test_a_file_over_the_size_cap_is_left_out(self):
        (self.repo / "big.md").write_text("x" * (builder.MAX_DOCUMENT_BYTES + 1), encoding="utf-8")
        self.assertEqual(self.names("`big.md`", self.repo), [])

    def test_attach_gives_turns_document_ids_and_reads_each_file_once(self):
        sessions = [{"exchanges": [{"reply": "`requirements.md`", "cwd": str(self.prd)}, {"reply": "no files", "cwd": str(self.prd)},
                                   {"reply": f"{self.prd}/requirements.md", "cwd": ""}]}]
        documents = builder.attach_documents(sessions)
        first, plain, again = sessions[0]["exchanges"]
        self.assertEqual(len(documents), 1)
        self.assertEqual(first["documents"], again["documents"])
        self.assertNotIn("documents", plain)
        self.assertNotIn("cwd", first)
        doc = documents[first["documents"][0]]
        self.assertEqual((doc["name"], doc["text"], doc["mention"]), ("requirements.md", "# Requirements\n", "requirements.md"))
        self.assertEqual(doc["dir"], "~/copy/personal/02-Projects/esim/prds/bc49")


def log(path, records, written):
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    os.utime(path, (written, written))


def prompt(text, at):
    return {"type": "user", "timestamp": at, "message": {"role": "user", "content": text}}


CLEAR = "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"
T0 = 1792000000.0  # 2026-10-15T22:13:20Z


def iso(seconds):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


class ClearedSessionsTest(unittest.TestCase):
    """/clear starts a new log in the same folder; the reader joins them into one conversation."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        f = self.folder
        # first ... cleared at T0+100 into second ... cleared at T0+500 into third.
        log(f / "first.jsonl", [prompt("hello", iso(T0))], T0 + 100)
        log(f / "second.jsonl", [{"type": "attachment", "timestamp": iso(T0 + 100)}, prompt("<local-command-caveat>x</local-command-caveat>", iso(T0 + 100)),
                                 prompt(CLEAR, iso(T0 + 100.5)), prompt("next task", iso(T0 + 200))], T0 + 500)
        log(f / "third.jsonl", [prompt(CLEAR, iso(T0 + 500.2)), prompt("go on", iso(T0 + 600))], T0 + 700)
        # A session in the same folder that started fresh, and one written long before the clear.
        log(f / "fresh.jsonl", [prompt("a new task", iso(T0 + 510))], T0 + 900)
        log(f / "old.jsonl", [prompt("old", iso(T0 - 9000))], T0 - 8000)

    def stems(self, name):
        return [p.stem for p in builder.session_chain(self.folder / f"{name}.jsonl")]

    def test_cleared_at_reads_the_clear_command_only_before_the_first_real_prompt(self):
        self.assertEqual(builder.cleared_at(builder.head_records(self.folder / "second.jsonl")), T0 + 100.5)
        self.assertIsNone(builder.cleared_at(builder.head_records(self.folder / "first.jsonl")))
        self.assertIsNone(builder.cleared_at([prompt("hi", iso(T0)), prompt(CLEAR, iso(T0 + 1))]))

    def test_any_session_of_a_pane_gives_the_whole_chain_oldest_first(self):
        for name in ("first", "second", "third"):
            self.assertEqual(self.stems(name), ["first", "second", "third"], name)
        self.assertEqual(self.stems("fresh"), ["fresh"])
        self.assertEqual(self.stems("old"), ["old"])

    def test_no_log_written_near_the_clear_means_no_earlier_session(self):
        os.utime(self.folder / "first.jsonl", (T0 - 3600, T0 - 3600))  # resumed and written later elsewhere
        self.assertEqual(self.stems("third"), ["second", "third"])


if __name__ == "__main__":
    unittest.main()
