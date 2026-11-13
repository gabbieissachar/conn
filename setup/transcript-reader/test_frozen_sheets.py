"""Check the frozen answer sheets: every reply of the reading list that made a sheet when it was frozen (freeze_sheets.py) must still make
the same sheet, the same ask-box cards and the same open keys.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_frozen_sheets.py

The replies are private text, so they live in answer-sheet-fixtures/frozen/, which git ignores; this test reads them when they are there and
skips that part on a checkout without them. The tracked frozen-manifest.json (digests and counts only) is always checked, and it is what
says which files the frozen folder must hold.
"""

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "prototype"))
import freeze_sheets  # noqa: E402

FIXTURES = HERE / "answer-sheet-fixtures"
FROZEN = FIXTURES / "frozen"
MANIFEST = json.loads((FIXTURES / "frozen-manifest.json").read_text(encoding="utf-8"))


def roundtrip(value):
    """A parse as a saved file reads it back (lists, not tuples)."""
    return json.loads(json.dumps(value, ensure_ascii=False))


class ManifestTest(unittest.TestCase):
    def test_manifest_lists_each_distinct_reply_once(self):
        entries = MANIFEST["entries"]
        self.assertEqual(MANIFEST["version"], freeze_sheets.MANIFEST_VERSION)
        self.assertEqual(MANIFEST["unique"], len(entries))
        self.assertGreaterEqual(MANIFEST["replies"], MANIFEST["unique"])
        self.assertGreater(len(entries), 0)
        self.assertEqual(len({entry["id"] for entry in entries}), len(entries))
        for entry in entries:
            self.assertEqual(entry["reply_sha256"][:12], entry["id"])
            self.assertEqual(len(entry["expect_sha256"]), 64)
            self.assertEqual(entry["cards"], len(entry["keys"]))

    def test_manifest_holds_no_reply_text(self):
        # Digests, counts and card keys only: the keys are A1, Z3 and the like, never a title, a question or an answer.
        allowed = {"id", "reply_sha256", "expect_sha256", "cards", "keys", "resolved", "locked", "sent_keys"}
        for entry in MANIFEST["entries"]:
            self.assertEqual(set(entry), allowed)
            for key in entry["keys"] + entry["sent_keys"]:
                self.assertRegex(key, r"^[A-Z][0-9]{1,2}$")

    def test_the_private_folder_is_ignored_by_git(self):
        self.assertIn("frozen/", (FIXTURES / ".gitignore").read_text(encoding="utf-8").splitlines())


@unittest.skipUnless(FROZEN.is_dir(), "answer-sheet-fixtures/frozen/ (private replies, gitignored) is not on this checkout")
class FrozenSheetsTest(unittest.TestCase):
    def test_the_folder_holds_exactly_the_manifest_entries(self):
        want = {name for entry in MANIFEST["entries"] for name in (entry["id"] + ".md", entry["id"] + ".expect.json")}
        self.assertEqual({path.name for path in FROZEN.iterdir()}, want)

    def test_each_frozen_reply_still_gives_its_sheet(self):
        for entry in MANIFEST["entries"]:
            with self.subTest(reply=entry["id"]):
                reply = (FROZEN / f"{entry['id']}.md").read_text(encoding="utf-8")
                stored = json.loads((FROZEN / f"{entry['id']}.expect.json").read_text(encoding="utf-8"))
                self.assertEqual(freeze_sheets.digest(reply), entry["reply_sha256"], "the reply text changed after it was frozen")
                self.assertEqual(freeze_sheets.digest(freeze_sheets.canonical(stored)), entry["expect_sha256"],
                                 "the expectation changed after it was frozen")
                now = freeze_sheets.expectation(reply, stored["answer_input"])
                self.assertEqual(roundtrip(now["parse"]), stored["parse"], "the sheet's cards, text or groups changed")
                self.assertEqual(roundtrip(now["sheet_cards"]), stored["sheet_cards"], "the ask box's cards changed")
                self.assertEqual(now["open_keys"], stored["open_keys"])
                self.assertEqual(now["sent"], stored["sent"])
                self.assertEqual(freeze_sheets.manifest_row(reply, roundtrip(now)), entry)


if __name__ == "__main__":
    unittest.main()
