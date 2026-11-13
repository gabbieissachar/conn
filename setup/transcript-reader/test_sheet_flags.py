"""Tests for the replies marked from the reader page as "should be an answer sheet" / "this sheet is wrong" (prototype/sheet_flags.py):
reading the marks, listing them with what the sheet finder makes of each now, and the masked shape that a parser fixture starts from.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_sheet_flags.py
Everything is invented text and temporary files; no real reply, session log or marks file is read.
"""

import io
import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent / "prototype"))
import sheet_flags  # noqa: E402

FIXTURE = (Path(__file__).resolve().parent / "answer-sheet-fixtures" / "key-call-recommended-table.md").read_text(encoding="utf-8")
TURN = "t52c0a60fd3697281cd4ebd17"


def marks_file(folder, flags):
    path = Path(folder) / "sheet-flags.json"
    path.write_text(json.dumps({"version": 1, "rev": len(flags), "flags": flags}), encoding="utf-8")
    return path


def flag(kind="missing", turn=TURN, flagged=1793866000, at=1793865300):
    return {"key": f"{turn}:reply", "conv": "1f5b7c82-cbf4-4781-b2bb-4a98cc4489f1", "at": at, "kind": kind, "flagged": flagged}


class MaskTest(unittest.TestCase):
    def test_no_word_of_the_reply_survives_but_its_structure_does(self):
        reply = ("Zebra quartz saw the **Harbour** budget.\n\n| Key | Call | Recommended |\n|---|---|---|\n"
                 "| **R1** | Mango tariff `ok=false` or `Pelican9`: `a` tangerine now; `b` wait | `a`, since walrus |\n\n"
                 "Reply like `R1=a; R2=a; ...`. Contact 0bcf2757 at https://example.invalid/walrus?id=77.\n- **G1** kettle ([here](http://localhost/x#s=1))")
        shown = sheet_flags.mask(reply)
        for word in ("Zebra", "quartz", "Harbour", "budget", "Mango", "tariff", "Pelican9", "tangerine", "walrus", "0bcf2757", "kettle", "example", "invalid", "localhost"):
            self.assertNotIn(word.lower(), shown.lower())
        self.assertIn("| Key | Call | Recommended |", shown)
        self.assertIn("|---|---|---|", shown)
        self.assertIn("| **R1** |", shown)
        self.assertIn(": `a` x x; `b` x |", shown, "each lettered choice keeps its letter and as many words as it had")
        self.assertIn("`R1=a; R2=a; ...`", shown, "the keyed answer line is kept: it is the structure the finder reads")
        self.assertIn("Reply like", shown)
        self.assertIn("- **G1**", shown)
        self.assertIn("`x`", shown, "code other than a lettered choice is masked")
        self.assertEqual(len(shown.splitlines()), len(reply.splitlines()), "line for line")

    def test_the_shape_of_the_fixture_still_makes_the_same_sheet_when_filled_with_other_words(self):
        # The masked shape keeps what the finder reads, so a fixture written from it behaves like the reply it came from.
        import build_questionnaire as sheets
        shown = sheet_flags.mask(FIXTURE)
        self.assertEqual([c["key"] for c in sheets.parse_questionnaire(shown)["cards"]], [c["key"] for c in sheets.parse_questionnaire(FIXTURE)["cards"]])
        self.assertEqual([[o["value"] for o in c["options"]] for c in sheets.parse_questionnaire(shown)["cards"]],
                         [[o["value"] for o in c["options"]] for c in sheets.parse_questionnaire(FIXTURE)["cards"]])


class FlagsTest(unittest.TestCase):
    def test_marks_are_read_oldest_first_and_a_missing_or_broken_file_is_none(self):
        with tempfile.TemporaryDirectory() as folder:
            path = marks_file(folder, [flag(turn="tb" * 6 + "ee", flagged=30), flag(flagged=10)])
            self.assertEqual([f["flagged"] for f in sheet_flags.read_flags(path)], [10, 30])
            self.assertEqual(sheet_flags.read_flags(Path(folder) / "none.json"), [])
            (Path(folder) / "bad.json").write_text("{not json", encoding="utf-8")
            self.assertEqual(sheet_flags.read_flags(Path(folder) / "bad.json"), [])

    def test_the_file_is_the_one_the_environment_names(self):
        with mock.patch.dict(os.environ, {"PMOS_READER_SHEET_FLAGS": "/tmp/somewhere/flags.json"}):
            self.assertEqual(sheet_flags.flags_file(), Path("/tmp/somewhere/flags.json"))

    def test_the_list_says_what_the_finder_makes_of_each_marked_reply_now(self):
        found = {TURN: (FIXTURE, 1793865300.0), "t00000000000000000000000a": ("Done. Nothing to ask.", 1793865301.0)}
        with mock.patch.object(sheet_flags, "find_reply", side_effect=lambda turn, conv: found.get(turn)):
            lines = sheet_flags.listing([flag("missing"), flag("wrong", turn="t00000000000000000000000a"), flag("missing", turn="tffffffffffffffffffffffff")])
        text = "\n".join(lines)
        self.assertIn("now an answer sheet with 9 questions", lines[0])
        self.assertIn("should be an answer sheet", lines[0])
        self.assertIn("now no answer sheet", lines[1])
        self.assertIn("its sheet is wrong", lines[1])
        self.assertIn("reply not found in its log any more", lines[2])
        self.assertIn("--shape", text)
        self.assertNotIn("Restore the strict", text, "no text of a reply is printed")

    def test_with_no_marks_it_says_how_to_make_one(self):
        self.assertIn("Sheet", sheet_flags.listing([])[0])

    def test_shape_prints_one_marked_replys_masked_text_by_a_prefix_of_its_turn_id(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ, {"PMOS_READER_SHEET_FLAGS": str(marks_file(folder, [flag()]))}), \
                mock.patch.object(sheet_flags, "find_reply", return_value=(FIXTURE, 1.0)):
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(sheet_flags.main(["--shape", TURN[:6]]), 0)
            self.assertIn("| **R1** |", out.getvalue())
            self.assertNotIn("Restore", out.getvalue())
            with self.assertRaises(SystemExit):
                sheet_flags.main(["--shape", "zzz"])

    def test_an_unknown_argument_prints_the_help(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(sheet_flags.main(["--nonsense"]), 2)
        self.assertIn("sheet-flags", out.getvalue())


if __name__ == "__main__":
    unittest.main()
