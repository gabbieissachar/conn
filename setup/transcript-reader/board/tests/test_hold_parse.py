import unittest

from base import HERE  # noqa: F401
from board import hold_parse


class SplitHold(unittest.TestCase):
    def test_numbered_calls_split_with_a_head(self):
        head, parts = hold_parse.split_hold("Three calls on the spec. R1 pick the layout: a grid (recommended) / b list. R2 name the file and why it matters here.")
        self.assertEqual(head, "Three calls on the spec.")
        self.assertEqual([k for k, _ in parts], ["R1", "R2"])

    def test_one_call_stays_whole(self):
        head, parts = hold_parse.split_hold("Should we ship the thing this week or wait for the review?")
        self.assertEqual(parts, [("", "Should we ship the thing this week or wait for the review?")])

    def test_short_bodies_are_not_calls(self):
        _, parts = hold_parse.split_hold("A1 yes. A2 no. Longer text that is the real question here and goes on.")
        self.assertEqual(len(parts), 1)


class Options(unittest.TestCase):
    def test_slash_separated_letters(self):
        stem, options = hold_parse.parse_options("Where does it live: a inside the reader (recommended) / b in Conn / c nowhere")
        self.assertEqual(stem, "Where does it live")
        self.assertEqual([(o["k"], o["rec"]) for o in options], [("a", True), ("b", False), ("c", False)])
        self.assertEqual(options[0]["t"], "inside the reader")

    def test_needs_a_and_b(self):
        self.assertEqual(hold_parse.parse_options("just a sentence with a slash / in it")[1], [])

    def test_go_gate_is_a_call_without_choices(self):
        self.assertEqual(hold_parse.call_type("Dispatch on Nathan's word.", []), "go")
        self.assertEqual(hold_parse.call_type("dispatch on his word: a yes / b no", [{"k": "a"}]), "q")


class Clean(unittest.TestCase):
    def test_a_report_pointer_is_dropped_and_the_first_word_capitalised(self):
        self.assertEqual(hold_parse.clean_question("Report data/x/report.md section 3: should we go ahead with it?"), "Should we go ahead with it?")

    def test_a_path_first_word_is_left_alone(self):
        self.assertEqual(hold_parse.clean_question("data/x.md is the file to read first"), "data/x.md is the file to read first")


if __name__ == "__main__":
    unittest.main()
