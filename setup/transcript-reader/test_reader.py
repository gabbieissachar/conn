"""Tests for reader.py session resolution and the Herdr pane naming it relies on.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_reader.py
Fixtures are synthetic; no real session log or Herdr call is used.
"""

import sys
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
