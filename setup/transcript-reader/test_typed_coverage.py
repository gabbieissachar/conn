"""Tests for the typed-ask coverage job and its per-home table (prototype/typed_coverage.py).

Run from the repo root: python3 -m unittest setup/transcript-reader/test_typed_coverage.py
Invented turns, records and logs in temporary folders; nothing real is read, and nothing outside the temporary folder is written.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from reader import builder  # noqa: E402

import build_questionnaire as sheets  # noqa: E402
import typed_asks  # noqa: E402
import typed_coverage as coverage  # noqa: E402
from test_typed_asks import (ASK, ASK2, NOW, REPLY, WRITER, World, card, ctx, exchanges_of, gate, line_of, turn)  # noqa: E402

DAY = 86400


def typed_turn(ask, at, agree=True, miss=False, keys=("Z1", "Z2")):
    found = {"home": "h", "at": at, "kind": "typed", "ask": ask, "keys": list(keys), "miss": miss}
    if not miss:
        found["agree"] = agree
    return found


def prose_turn(at, ask=None, failed=False):
    return {"home": "h", "at": at, "kind": "prose-only", "ask": ask, "keys": ["Z1"], "failed": failed}


class MeasureTest(unittest.TestCase):
    def test_coverage_agreement_and_detector_miss_over_a_window(self):
        turns = [typed_turn("ask-a", NOW - DAY), typed_turn("ask-b", NOW - DAY, agree=False), typed_turn("ask-c", NOW - DAY, miss=True),
                 prose_turn(NOW - DAY), typed_turn("ask-old", NOW - 20 * DAY)]
        found = coverage.measure(coverage.window(turns, NOW), {"ask-b": {"verdict": "leader-miss", "at": 1}})
        self.assertEqual((found["asks"], found["typed"], found["prose_only"], found["coverage"]), (4, 3, 1, 0.75))
        self.assertEqual((found["both"], found["agreement"], found["detector_miss"]), (2, 0.5, 1))
        self.assertEqual((found["disagreements"], found["unadjudicated"]), (["ask-b"], []))
        self.assertEqual(coverage.measure(coverage.window(turns, NOW), {})["unadjudicated"], ["ask-b"])

    def test_an_empty_window_has_no_coverage(self):
        found = coverage.measure([], {})
        self.assertEqual((found["asks"], found["coverage"], found["agreement"]), (0, None, None))

    def test_the_window_is_fourteen_days_ending_at_the_given_time(self):
        turns = [prose_turn(NOW - 13.9 * DAY), prose_turn(NOW - 14.1 * DAY), prose_turn(NOW + 10)]
        self.assertEqual(len(coverage.window(turns, NOW)), 1)


class GateTest(unittest.TestCase):
    def steady(self, prose_every=7):
        """One ask a day for 30 days: every <prose_every>th is prose-only."""
        return [prose_turn(NOW - d * DAY) if d % prose_every == 0 else typed_turn(f"ask-{d}", NOW - d * DAY) for d in range(30)]

    def report(self, turns, unlinked=(), acks=(), adjudicated=None, lag=()):
        return coverage.home_report("h", "label", turns, list(acks), list(unlinked), list(lag), adjudicated or {}, NOW)

    def test_a_home_with_too_few_asks_is_insufficient_data(self):
        found = self.report([typed_turn("ask-a", NOW - DAY)] * 3)
        self.assertEqual(found["verdict"], "insufficient-data")
        self.assertEqual(found["coverage"], 1.0)  # a high number on a few asks is not a pass

    def test_a_home_at_coverage_for_fourteen_days_with_nothing_open_is_eligible(self):
        found = self.report(self.steady())
        self.assertEqual((found["days_passing"], found["days_sampled"], found["verdict"]), (14, 14, "eligible"))

    def test_low_coverage_is_not_yet(self):
        found = self.report(self.steady(prose_every=2))
        self.assertEqual(found["verdict"], "not-yet")

    def test_an_unlinked_record_or_an_unadjudicated_disagreement_stops_the_gate(self):
        self.assertEqual(self.report(self.steady(), unlinked=["ask-lost"])["verdict"], "not-yet")
        turns = self.steady() + [typed_turn("ask-x", NOW - DAY, agree=False)]
        self.assertEqual(self.report(turns)["verdict"], "not-yet")
        self.assertEqual(self.report(turns, adjudicated={"ask-x": {"verdict": "detector-miss", "at": 1}})["verdict"], "eligible")

    def test_one_weak_day_in_the_last_fourteen_is_not_a_pass(self):
        turns = self.steady()
        # Prose-only turns piled onto day 3 drop that day's window under the target.
        turns += [prose_turn(NOW - 3 * DAY - 10)] * 12
        found = self.report(turns)
        self.assertEqual(found["verdict"], "not-yet")
        self.assertLess(found["days_passing"], 14)

    def test_the_marker_counts_only_the_last_window(self):
        acks = [{"at": NOW - DAY, "acks": 3, "visible": 1}, {"at": NOW - 2 * DAY, "acks": 2, "visible": 0}, {"at": NOW - 30 * DAY, "acks": 9, "visible": 9}]
        self.assertEqual(self.report(self.steady(), acks=acks)["marker"], {"acks": 5, "visible": 1})

    def test_the_table_has_a_row_for_each_home_and_names_what_to_adjudicate(self):
        turns = self.steady() + [typed_turn("ask-x", NOW - DAY, agree=False)]
        text = coverage.render([self.report(turns), {**self.report(self.steady()), "home": "other"}])
        lines = text.splitlines()
        self.assertTrue(lines[0].startswith("home"))
        for column in ("asks", "typed", "prose-only", "coverage", "agreement", "detector-miss", "unlinked", "record-lag", "marker", "gate"):
            self.assertIn(column, lines[0])
        self.assertTrue(lines[1].startswith("h "))
        self.assertIn("other", lines[2])
        self.assertIn("It switches nothing on", text)
        self.assertIn("h:ask-x", text)


class AdjudicationTest(unittest.TestCase):
    def test_a_verdict_is_kept_in_an_owner_only_file_and_read_back(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "deep" / "adj.json"
            coverage.adjudicate(ASK, "leader-miss", path, 100)
            coverage.adjudicate(ASK2, "false-positive", path, 200)
            coverage.adjudicate(ASK, "detector-miss", path, 300)  # a later call replaces
            self.assertEqual(coverage.read_adjudications(path), {ASK: {"verdict": "detector-miss", "at": 300}, ASK2: {"verdict": "false-positive", "at": 200}})
            self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")

    def test_a_bad_verdict_or_id_and_a_missing_or_broken_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "adj.json"
            with self.assertRaises(ValueError):
                coverage.adjudicate(ASK, "fine", path)
            with self.assertRaises(ValueError):
                coverage.adjudicate("ask-1", "leader-miss", path)
            self.assertEqual(coverage.read_adjudications(path), {})
            path.write_text("{broken", encoding="utf-8")
            self.assertEqual(coverage.read_adjudications(path), {})

    def test_the_file_comes_from_the_environment_when_it_is_set(self):
        with mock.patch.dict(os.environ, {coverage.ADJUDICATIONS_ENV: "/somewhere/else.json"}):
            self.assertEqual(coverage.adjudications_file(), Path("/somewhere/else.json"))


class TurnsTest(unittest.TestCase):
    def setUp(self):
        self.world = World(self)
        typed_asks._FILES.clear()
        typed_asks._BACKLOGS.clear()

    def conversation(self, reply=REPLY, cards=None, chain=(WRITER,), tamper=False):
        cards = cards or [card("Z1", "Which mapping?", [("a", "", True)], gate=gate("g1")), card("Z2", "Who closes it?", [("leader", "", True)], gate=gate("g1"))]
        sha = self.world.record(self.world.home, ASK, cards)
        self.world.backlog(self.world.home, [("g1", "held", "Pick it", "2027-01-10T01:00:00Z", 0)])
        if tamper:
            path = self.world.home / "state" / "ask-records" / f"{ASK}.json"
            path.write_text(path.read_text(encoding="utf-8").replace("Which mapping?", "Another one?"), encoding="utf-8")
            typed_asks._FILES.clear()
        exchanges = exchanges_of(turn(0, "Ask", reply, [("bin/fm-captain-ask.sh open --title T", line_of(ASK, sha))]), turn(30, "Z1=a", "Noted."))
        return coverage.conversation_turns(exchanges, ctx(self.world, chain=chain), "h", lambda text: (
            [c["key"] for c in sheets.parse_questionnaire(text)["cards"]] if sheets.parse_questionnaire(text) else None))

    def test_a_typed_turn_whose_prose_has_the_same_keys_agrees(self):
        turns, named, entries = self.conversation()
        self.assertEqual([(t["kind"], t["ask"], t.get("agree"), t["miss"]) for t in turns if t["kind"] == "typed"], [("typed", ASK, True, False)])
        self.assertEqual(named, {ASK})

    def test_a_typed_turn_whose_prose_has_other_keys_is_a_disagreement(self):
        reply = "| ID | Decision | Recommended |\n| --- | --- | --- |\n| Q9 | A different card | `x` |\n| Q8 | Another | `y` |\n\nReply with keyed answers: `Q9=...; Q8=...`"
        turns, _, _ = self.conversation(reply=reply)
        typed = [t for t in turns if t["kind"] == "typed"][0]
        self.assertFalse(typed["agree"])

    def test_a_typed_turn_the_prose_finder_cannot_read_is_a_detector_miss(self):
        turns, _, _ = self.conversation(reply=f"I put the choices in the doc, please look.\n\nask: {ASK}")
        typed = [t for t in turns if t["kind"] == "typed"][0]
        self.assertTrue(typed["miss"])
        self.assertNotIn("agree", typed)

    def test_a_record_that_fails_a_check_does_not_make_the_turn_typed(self):
        for kwargs in ({"chain": ("someone-else",)}, {"tamper": True}):
            turns, named, _ = self.conversation(**kwargs)
            self.assertEqual([t["kind"] for t in turns], ["prose-only"], kwargs)
            self.assertTrue(turns[0]["failed"])
            self.assertEqual(named, {ASK})  # linked in a transcript, so not "unlinked": it failed instead

    def test_a_prose_only_keyed_ask_counts_and_a_plain_reply_does_not(self):
        exchanges = exchanges_of(turn(0, "Ask", REPLY), turn(10, "ok", "Plain words, nothing to answer."))
        turns, named, _ = coverage.conversation_turns(exchanges, ctx(self.world), "h", lambda text: ["Z1", "Z2"] if "Z1" in text else None)
        self.assertEqual([(t["kind"], t["ask"]) for t in turns], [("prose-only", None)])
        self.assertEqual(named, set())

    def test_marker_counts_see_the_ack_calls_of_wake_turns_and_whether_a_marker_printed(self):
        exchanges = exchanges_of(
            turn(0, "", "Waiting.", [("bin/fm-wake-drain.sh --ack-through 5 --recovery-generation 2", "WAKE_ACK: nothing-new through=5")], wake=True),
            turn(20, "", "Waiting.", [("bin/fm-wake-drain.sh --ack-through 6 --recovery-generation 2", "")], wake=True),
            turn(40, "hello", "Hi.", [("bin/fm-wake-drain.sh --ack-through 6 --recovery-generation 2", "WAKE_ACK: news through=6")]))
        found = coverage.marker_counts(exchanges)
        self.assertEqual([(m["acks"], m["visible"]) for m in found], [(1, 1), (1, 0)])  # the captain's turn is not a wake turn


class CollectTest(unittest.TestCase):
    """The whole job on a log file: the reading list in, one row per home out."""

    def test_report_reads_a_listed_conversation_and_the_homes_records(self):
        world = World(self)
        typed_asks._FILES.clear()
        typed_asks._BACKLOGS.clear()
        sha = world.record(world.home, ASK, [card("Z1", "Which mapping?", [("a", "", True)], gate=gate("g1")), card("Z2", "Who closes it?", gate=gate("g1"))])
        world.record(world.home, ASK2, [card("Z5", "Never linked?")], created="2027-01-11T02:00:00Z")
        world.backlog(world.home, [("g1", "held", "Pick it", "2027-01-10T01:00:00Z", 0)])
        records = turn(0, "Ask", REPLY, [("bin/fm-captain-ask.sh open --title T", line_of(ASK, sha))]) + turn(30, "Z1=a", "Noted.")
        log = world.root / f"{WRITER}.jsonl"
        log.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        cache = world.root / "parsed"
        cache.mkdir()
        homes = [{"id": "main", "home": world.home}, {"id": "mate", "home": world.mate}]
        with mock.patch.object(builder, "find_session_file", return_value=log):
            per_home = coverage.collect([WRITER], cache, homes, {"mate": world.home}, NOW)
        self.assertEqual([t["kind"] for t in per_home["main"]["turns"]], ["typed"])
        self.assertEqual(per_home["main"]["named"], {ASK})
        self.assertEqual(per_home["mate"]["turns"], [])
        self.assertEqual(per_home["main"]["lag"], {ASK})  # Z1 answered in chat long ago, the record never told


if __name__ == "__main__":
    unittest.main()
