"""Tests for reading decision cards out of a grill-me review reply.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_questionnaire.py
Fixtures are synthetic replies in the review's shapes; no real transcript is used.
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "prototype"))
from build_questionnaire import list_entry, open_cards, parse_questionnaire, sent_answers  # noqa: E402

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
| A2 | "finance, but ask legal" | Finance signs off, legal is asked. | resolved |
| A3 | A question, not a keyed answer | You asked something. | open, answer below |

**A3: is the date fixed?** A short answer that has no choices of its own.

1. Some reasoning.

**A3 revised.** Do we name the date in the note?
- `name-it`: say the date. This is my recommendation.
- `say-soon`
- `no`

Reply with: `A3=...` (or your correction on A2).
"""

PLAIN = """Captain, I checked the code first. The facts below shape the questions.

## Review group 1

### Teaching frame
**What exists today.** `handoff-command` builds a copy-only line.

### Cards

| ID | Decision | Depends on | Recommended default | Answer |
| --- | --- | --- | --- | --- |
| A1 | How the doc path is found | - | Read the transcript, take the last `Write` call to a `handoff*.md` path. Refuse, never guess. | choice: transcript-Write / newest-file-by-mtime / screen-read / other |
| A2 | How the command waits | - | Gated wait: `wait-output` for the prompt, with a timeout. | choice: gated-wait / fixed sleep / three separate copy buttons |
| A3 | Command granularity | - | One command for all ticked sessions. | combined, per-session buttons |
| A4 | Anything else | - | Tell me in your own words. | Answer in a sentence, any length you like, about the layout |

Cards that wait on A1 and stay parked until you answer it:
- **A5:** the path safety rules.
- **A6:** what a row shows when no fresh doc is found.

Reply with keyed answers, for example `A1=transcript-Write; A2=gated-wait; A3=combined`. You can also write `A2=needs explanation`.
"""

SHAPES = """Some changes to the handoff.

| ID | Change | Recommended |
| --- | --- | --- |
| C1 | **Drop the token lists.** Screen 1 keeps its note. | accept |
| C2 | **Optional deeper cut:** also drop the fallback criteria. | keep them (they're what QA tests against) |

| ID | Decision | Recommended default | Answer |
| --- | --- | --- | --- |
| D1 | Who owns the new Mac? **a)** IT enrols it; **b)** already enrolled; **c)** not sure | Assume a). It decides who installs the agents. | short text |
| D2 | Transfer method? **a)** Migration Assistant; **b)** clean setup | **b).** It copies less cruft. | short text |

| Card | Your answer | What I'll do | State |
| --- | --- | --- | --- |
| G1 | Drop the window | Re-check at order creation | resolved |
| G2 | Needs explanation | See below | Open |

- **E1:** how checkout treats a targeted discount the customer saw. I recommend `recheck-reshow`, or `honour-window`.
- **F1:** whether dates show in GMT+8 too.

Reply with keyed answers, for example `C1=accept; C2=leave; D1=a; D2=b; E1=recheck-reshow`. Use `needs explanation` for any card.
"""

EXPLAINED = """I recorded G1; G2 is explained below.

| Card | Your answer | What I'll do | State |
| --- | --- | --- | --- |
| G1 | Drop the window | Re-check at order creation | resolved |
| G2 | Needs explanation | See below | Open |

## G2 explained: which moment fixes the discount

Some background.

| Option | That customer gets | What it means |
| --- | --- | --- |
| `order-creation` (recommended) | 15% | How every campaign works today. |
| `completion` (the other team's pick) | 8% | A silent downgrade. |

Reply with keyed answers, for example `G1=recheck-reshow; G2=order-creation`. G1 only needs a reply if my reading is wrong.
"""

LETTERED = """Captain, the first draft is ready for review. There are 2 cards in one batch.

### Cards

| ID | Decision | Recommended default | Other options |
|---|---|---|---|
| A1 | What it covers | **a)** Both: rows in the details (limits, renewal rule) | b) After purchase only; purchase disclosure becomes its own item |
| A2 | Reset time format | **a)** Clock time: "Resets today at 9:40 PM" | b) Countdown: "Resets in 5h 20m"; c) Both |

Reply with keyed answers, for example: `A1=a; A2=b`. You can also answer `defer` or `explain` for any card.
"""


class PlainChoicesTest(unittest.TestCase):
    """Choices written without backticks, prose recommendations that quote code, and parked cards."""

    def setUp(self):
        self.q = parse_questionnaire(PLAIN)

    def test_every_keyed_row_is_a_card(self):
        self.assertEqual([c["key"] for c in self.q["cards"]], ["A1", "A2", "A3", "A4"])

    def test_labelled_slash_lists_are_choices(self):
        options = lambda i: [o["value"] for o in self.q["cards"][i]["options"]]
        self.assertEqual(options(0), ["transcript-Write", "newest-file-by-mtime", "screen-read", "other", "needs explanation"])
        self.assertEqual(options(1), ["gated-wait", "fixed sleep", "three separate copy buttons", "needs explanation"])

    def test_bare_commas_and_sentences_are_not_cut_into_choices(self):
        # A3 offers only the reply's example answer; A4's sentence offers nothing to pick.
        values = lambda i: [o["value"] for o in self.q["cards"][i]["options"]]
        self.assertEqual(values(2), ["combined", "needs explanation"])
        self.assertEqual(values(3), ["needs explanation"])

    def test_prose_recommendation_that_quotes_code_stays_prose(self):
        card = self.q["cards"][0]
        self.assertIn("handoff*.md", card["recommended"])
        self.assertFalse(any(o["recommended"] for o in card["options"]))
        self.assertEqual([o["value"] for o in self.q["cards"][1]["options"] if o["recommended"]], [])

    def test_parked_cards_outside_a_heading(self):
        self.assertEqual([l["key"] for l in self.q["locked"]], ["A5", "A6"])


class MoreShapesTest(unittest.TestCase):
    """Short recommended answers, choices inside the question, checkpoints and bullet cards."""

    def setUp(self):
        self.q = parse_questionnaire(SHAPES)
        self.card = {c["key"]: c for c in self.q["cards"]}

    def picks(self, key):
        return [(o["value"], o["recommended"]) for o in self.card[key]["options"]]

    def test_open_cards(self):
        self.assertEqual(list(self.card), ["C1", "C2", "D1", "D2", "E1"])

    def test_a_short_recommendation_is_the_recommended_answer(self):
        self.assertEqual(self.picks("C1"), [("accept", True), ("needs explanation", False)])
        self.assertEqual(self.picks("C2"), [("keep them", True), ("leave", False), ("needs explanation", False)])

    def test_lettered_choices_inside_the_question_and_the_letter_the_recommendation_names(self):
        self.assertEqual(self.card["D1"]["question"], "Who owns the new Mac?")
        self.assertEqual(self.picks("D1"), [("a", True), ("b", False), ("c", False), ("needs explanation", False)])
        self.assertEqual(self.picks("D2"), [("a", False), ("b", True), ("needs explanation", False)])

    def test_a_your_answer_table_is_answered_not_open(self):
        self.assertEqual([(r["key"], r["state"]) for r in self.q["resolved"]], [("G1", "resolved"), ("G2", "Open")])

    def test_a_bullet_the_reply_asks_about_is_a_card_and_the_rest_open_later(self):
        self.assertEqual(self.picks("E1"), [("recheck-reshow", True), ("honour-window", False), ("needs explanation", False)])
        self.assertEqual([l["key"] for l in self.q["locked"]], ["F1"])


class ExplainedCardTest(unittest.TestCase):
    """A card answered "needs explanation", explained under its own heading with an option table."""

    def test_the_explained_card_reopens_with_the_option_table_as_its_choices(self):
        q = parse_questionnaire(EXPLAINED)
        self.assertEqual([c["key"] for c in q["cards"]], ["G2"])
        card = q["cards"][0]
        self.assertEqual(card["question"], "which moment fixes the discount")
        self.assertEqual([(o["value"], o["recommended"]) for o in card["options"]], [("order-creation", True), ("completion", False)])
        self.assertEqual(card["recommended"], "15% · How every campaign works today.")
        self.assertEqual([r["key"] for r in q["resolved"]], ["G1"])


class LetteredTableTest(unittest.TestCase):
    """Choices written as a), b) in a recommended column and an other-options column."""

    def setUp(self):
        self.q = parse_questionnaire(LETTERED)

    def test_letters_become_choices_with_the_recommended_column_marked(self):
        a1, a2 = self.q["cards"]
        # The reply also allows `defer` and `explain` for any card.
        self.assertEqual([(o["value"], o["recommended"]) for o in a2["options"]], [("a", True), ("b", False), ("c", False), ("defer", False), ("explain", False)])
        self.assertEqual(a2["options"][2]["note"], "Both")
        self.assertEqual(a1["question"], "What it covers")
        self.assertEqual(a1["recommended"], "Both: rows in the details (limits, renewal rule)")
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

    def test_a_recommendation_that_names_one_choice_marks_it(self):
        # "Finance." opens with the choice `finance`; "The later date." names `later` further in, and it is the only choice it names.
        self.assertEqual([[o["value"] for o in c["options"] if o["recommended"]] for c in self.q["cards"]], [["later"], ["finance"]])

    def test_locked_cards_and_intro(self):
        self.assertEqual([l["key"] for l in self.q["locked"]], ["B1", "B2"])
        self.assertIn("Teaching frame", self.q["intro"])
        self.assertNotIn("| ID |", self.q["intro"])


def card_with(recommended: str, choices: str = "`export`, `shipped`, `dash`, `keep`") -> dict:
    reply = ("Review (1 card)\n\n| ID | Decision | Depends on | Recommended default | Answer |\n| --- | --- | --- | --- | --- |\n"
             f"| A1 | Which one | none | {recommended} | {choices} |\n\nReply with keyed answers: `A1=...`\n")
    return parse_questionnaire(reply)["cards"][0]


def starred(card: dict) -> list[str]:
    return [o["value"] for o in card["options"] if o["recommended"]]


class NamedAnywhereTest(unittest.TestCase):
    """A choice is starred when the recommendation names exactly one of the card's choices anywhere in its text."""

    def test_one_choice_named_in_the_middle_is_starred(self):
        self.assertEqual(starred(card_with("The **export** date.")), ["export"])
        self.assertEqual(starred(card_with("Replace them with a dash.")), ["dash"])

    def test_two_choices_named_star_none(self):
        self.assertEqual(starred(card_with("Use the export date, not the shipped one.")), [])
        self.assertEqual(starred(card_with("Either dash or keep works.")), [])

    def test_a_choice_inside_a_longer_word_is_not_named(self):
        self.assertEqual(starred(card_with("Use the exported date.")), [])
        self.assertEqual(starred(card_with("Keep-alive is unrelated.", "`keep`, `drop`")), [])

    def test_a_one_letter_choice_is_never_matched_as_a_word(self):
        self.assertEqual(starred(card_with("Replace them with a dash.", "`a`, `b`")), [])

    def test_nothing_named_stars_nothing(self):
        self.assertEqual(starred(card_with("Whatever the team uses today.")), [])

    def test_the_opening_choice_still_wins_and_a_lettered_one_is_still_found(self):
        self.assertEqual(starred(card_with("Finance, then ops.", "`finance`, `ops`")), ["finance"])
        self.assertEqual(starred(card_with("Assume b) for now.", "`a`, `b`")), ["b"])


class AnsweredListTest(unittest.TestCase):
    def questionnaire(self, sent):
        q = parse_questionnaire(CARDS)
        return {**q, "at": 100.0, "sent": sent, "sent_at": 160.0}

    def test_cards_the_session_answered_are_not_open(self):
        self.assertEqual([c["key"] for c in open_cards(self.questionnaire({"A1": "later"}))], ["A2"])
        self.assertEqual(open_cards(self.questionnaire({"A1": "later", "A2": "finance"})), [])
        self.assertEqual(len(open_cards(self.questionnaire({}))), 2)

    def test_the_hosted_picker_line_counts_open_cards(self):
        self.assertEqual(list_entry(self.questionnaire({}))["open"], 2)
        self.assertEqual(list_entry(self.questionnaire({"A1": "later", "A2": "ops"}))["open"], 0)
        self.assertEqual(set(list_entry(self.questionnaire({}))), {"at", "open", "title"})


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

    def test_a_table_of_decisions_taken_is_not_a_questionnaire(self):
        record = "The review is finished.\n\n| Card | Decision |\n| --- | --- |\n| A1 | Tabs close after capture. |\n| A2 | Same session only. |\n\n**Decision for you:** build it directly?"
        self.assertIsNone(parse_questionnaire(record))

    def test_sent_answers(self):
        self.assertEqual(sent_answers("A1=accept;A3=pricing stays with BD; A2=inline"),
                         {"A1": "accept", "A3": "pricing stays with BD", "A2": "inline"})


# Replies the owner flagged from the reader page as "this should be an answer sheet" (or "this sheet is wrong"), kept as fixtures:
# answer-sheet-fixtures/<name>.md is invented text in the real shape (never the private reply), <name>.expect.json what the sheet must
# be. A new flagged case is two files; reader.py sheet-flags --shape prints the shape of a flagged reply with its words masked.
FIXTURES = Path(__file__).resolve().parent / "answer-sheet-fixtures"


def shown(card):
    return {"key": card["key"], "question": card["question"], "options": [[o["value"], o["note"], o["recommended"]] for o in card["options"]],
            "recommended": card["recommended"]}


class FlaggedFixturesTest(unittest.TestCase):
    def test_there_are_fixtures_and_each_has_its_expectation(self):
        names = sorted(path.stem for path in FIXTURES.glob("*.md"))
        self.assertTrue(names)
        self.assertEqual(names, sorted(path.name[: -len(".expect.json")] for path in FIXTURES.glob("*.expect.json")))

    def test_each_flagged_reply_gives_the_sheet_it_was_flagged_for(self):
        for path in sorted(FIXTURES.glob("*.md")):
            with self.subTest(fixture=path.stem):
                expect = json.loads(path.with_name(path.stem + ".expect.json").read_text(encoding="utf-8"))
                found = parse_questionnaire(path.read_text(encoding="utf-8"))
                if not expect["sheet"]:
                    self.assertIsNone(found, expect.get("why"))
                    continue
                self.assertIsNotNone(found, expect.get("why"))
                self.assertEqual([shown(card) for card in found["cards"]], expect["cards"])
                self.assertEqual([item["key"] for item in found["locked"]], expect.get("locked", []))
                self.assertEqual([item["key"] for item in found["resolved"]], expect.get("resolved", []))


if __name__ == "__main__":
    unittest.main()
