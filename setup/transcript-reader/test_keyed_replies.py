"""The keyed answers in the captain's replies, read by every reader of them (typed-ask-fixtures/keyed-replies.json).

Run from the repo root: python3 -m unittest setup/transcript-reader/test_keyed_replies.py
Three Python readers in this folder (typed_asks.keyed_answers, build_prototype.answered_keys and build_questionnaire.sent_answers) and Firstmate's
shell reader (the `reply` mode of bin/fm-captain-ask.jq, run when jq and the Firstmate checkout are on this machine) read the same replies, so the
`KEY=value` grammar cannot drift between them. Where the shell reader differs on purpose the fixture says so, and this test holds both sides.
"""

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from reader import builder  # noqa: E402

import build_questionnaire as sheets  # noqa: E402
import typed_asks  # noqa: E402

CASES = json.loads((HERE / "typed-ask-fixtures" / "keyed-replies.json").read_text(encoding="utf-8"))["cases"]
FIRSTMATE = Path(os.environ.get("PMOS_READER_FIRSTMATE") or Path.home() / "workspace" / "firstmate")
JQ_PROGRAM = FIRSTMATE / "bin" / "fm-captain-ask.jq"


class ReaderTest(unittest.TestCase):
    def test_every_python_reader_finds_the_same_answers(self):
        for case in CASES:
            with self.subTest(case=case["name"]):
                reply, want = case["reply"], case["answers"]
                self.assertEqual(typed_asks.keyed_answers(reply), want)
                self.assertEqual(builder.answered_keys(reply), set(want))
                listed = {key: value for key, value in sheets.sent_answers(reply).items() if value.strip(".…")}
                self.assertEqual(listed, want)

    def test_the_fixture_explains_each_difference_with_the_shell_reader(self):
        for case in CASES:
            if "shell" in case:
                self.assertTrue(case.get("why"), case["name"])
                self.assertNotEqual(case["shell"], case["answers"], case["name"])

    def test_the_reader_and_the_chat_answers_of_a_turn_agree(self):
        exchanges = [{"source": "captain", "input": "Z1=a; Z1=b; Z2=...", "at": 5.0}]
        found = typed_asks.chat_answers([{"typed_lines": {}}] + exchanges, 0, "ask-20270110T020000Z-aaaa", ["Z1", "Z2"])
        self.assertEqual({key: value["value"] for key, value in found.items()}, {"Z1": "b"})


@unittest.skipUnless(shutil.which("jq") and JQ_PROGRAM.is_file(), "jq or Firstmate's bin/fm-captain-ask.jq is not on this machine")
class ShellReaderTest(unittest.TestCase):
    def shell_pairs(self, reply):
        done = subprocess.run(["jq", "-R", "-s", "-c", "--arg", "mode", "reply", "-f", str(JQ_PROGRAM)], input=reply, capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return {pair["key"]: pair["value"] for pair in json.loads(done.stdout)["pairs"]}

    def test_firstmates_reply_reader_finds_what_the_fixture_says(self):
        for case in CASES:
            with self.subTest(case=case["name"]):
                self.assertEqual(self.shell_pairs(case["reply"]), case.get("shell", case["answers"]))


if __name__ == "__main__":
    unittest.main()
