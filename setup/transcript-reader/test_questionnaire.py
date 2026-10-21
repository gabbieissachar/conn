"""Tests for reading decision cards out of a grill-me review reply.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_questionnaire.py
Fixtures are synthetic replies in the review's shapes; no real transcript is used.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "prototype"))
from build_questionnaire import parse_questionnaire, sent_answers  # noqa: E402

CARDS = """Review group A (2 cards): two calls on the launch note.

### Teaching frame

Some background that is not a question.

| ID | Decision | Depends on | Recommended default | Answer |
| --- | --- | --- | --- | --- |
| A1 | Which date goes in the note | none | The **later** date. | `later`, `earlier`, or `needs explanation` |
| A2 | Who signs it off | A1 | Finance. | `finance` or `ops` |

### Locked until A2 is answered (cluster B, ordered)

- **B1:** Who sends it.
- **B2:** When it goes out.

Reply with keyed answers: `A1=...; A2=...`
"""

CHECKPOINT = """**Checkpoint for group A**

| Card | Submitted answer | Inferred decision | State |
| --- | --- | --- | --- |
| A1 | `later` | The note uses the later date. | resolved |
| A2 | "finance, but ask Sam" | Finance signs off, Sam is asked. | resolved |
| A3 | A question, not a keyed answer | You asked something. | open, answer below |

**A3: is the date fixed?** A short answer that has no choices of its own.

1. Some reasoning.

**A3 revised.** Do we name the date in the note?
- `name-it`: say the date. This is my recommendation.
- `say-soon`
- `no`

Reply with: `A3=...` (or your correction on A2).
"""

LETTERED = """Nathan, the first draft is ready for review. There are 2 cards in one batch.

### Cards

| ID | Decision | Recommended default | Other options |
|---|---|---|---|
| A1 | What it covers | **a)** Both: rows in the plan details (allowance, 24-hour rule) | b) After purchase only; purchase disclosure becomes its own item |
| A2 | Reset time format | **a)** Clock time: "Resets today at 9:40 PM" | b) Countdown: "Resets in 5h 20m"; c) Both |

Reply with keyed answers, for example: `A1=a; A2=b`. You can also answer `defer` or `explain` for any card.
"""


class LetteredTableTest(unittest.TestCase):
    """Choices written as a), b) in a recommended column and an other-options column."""

    def setUp(self):
        self.q = parse_questionnaire(LETTERED)

    def test_letters_become_choices_with_the_recommended_column_marked(self):
        a1, a2 = self.q["cards"]
        self.assertEqual([(o["value"], o["recommended"]) for o in a2["options"]], [("a", True), ("b", False), ("c", False)])
        self.assertEqual(a2["options"][2]["note"], "Both")
        self.assertEqual(a1["question"], "What it covers")
        self.assertEqual(a1["recommended"], "Both: rows in the plan details (allowance, 24-hour rule)")
        # A semicolon inside one choice's text does not split it.
        self.assertEqual(a1["options"][1]["note"], "After purchase only; purchase disclosure becomes its own item")


class CardsTableTest(unittest.TestCase):
    def setUp(self):
        self.q = parse_questionnaire(CARDS)

    def test_cards_and_choices(self):
        self.assertEqual([c["key"] for c in self.q["cards"]], ["A1", "A2"])
        self.assertEqual([o["value"] for o in self.q["cards"][0]["options"]], ["later", "earlier", "needs explanation"])
        self.assertEqual(self.q["cards"][1]["depends"], "A1")
        self.assertEqual(self.q["cards"][0]["recommended"], "The **later** date.")

    def test_no_choice_is_guessed_as_recommended(self):
        self.assertFalse(any(o["recommended"] for c in self.q["cards"] for o in c["options"]))

    def test_locked_cards_and_intro(self):
        self.assertEqual([l["key"] for l in self.q["locked"]], ["B1", "B2"])
        self.assertIn("Teaching frame", self.q["intro"])
        self.assertNotIn("| ID |", self.q["intro"])


class CheckpointTest(unittest.TestCase):
    def setUp(self):
        self.q = parse_questionnaire(CHECKPOINT)

    def test_revised_card_is_the_only_open_one(self):
        self.assertEqual([c["key"] for c in self.q["cards"]], ["A3"])
        card = self.q["cards"][0]
        self.assertEqual(card["question"], "Do we name the date in the note?")
        self.assertEqual([o["value"] for o in card["options"]], ["name-it", "say-soon", "no"])
        self.assertEqual([o["recommended"] for o in card["options"]], [True, False, False])

    def test_submitted_answers_are_not_choices(self):
        self.assertEqual([r["key"] for r in self.q["resolved"]], ["A1", "A2"])

    def test_reply_line_offers_a_correction(self):
        self.assertEqual(self.q["corrections"], ["A2"])


class NotAQuestionnaireTest(unittest.TestCase):
    def test_ordinary_reply(self):
        self.assertIsNone(parse_questionnaire("Done. The page is published.\n\n| Col | Answer |\n| --- | --- |\n| x | `y` |"))

    def test_sent_answers(self):
        self.assertEqual(sent_answers("A1=accept;A3=pricing stays with BD; A2=inline"),
                         {"A1": "accept", "A3": "pricing stays with BD", "A2": "inline"})


if __name__ == "__main__":
    unittest.main()
