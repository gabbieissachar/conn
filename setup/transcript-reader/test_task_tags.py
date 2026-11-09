"""Tests for which turns of a leader's conversation are about which fleet task (prototype/task_tags.py: the task-tagging A2 rules, T-slice 1).

Run from the repo root: python3 -m unittest setup/transcript-reader/test_task_tags.py
Fixtures are synthetic records shaped like Claude Code's session logs, in a scratch Firstmate home; the Tasks board's own tagger (board/tagger.py) and reply marks
(board/marks.py) do the matching, so the last tests hold the conversation's tags to the board's answer.
"""

import json
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reader import builder  # noqa: E402

from board import tagger  # noqa: E402

task_tags = builder.task_tags

BASE = 1_795_000_000  # a fixed day; every record is a few minutes after it
SID = "5e550000-aaaa-4000-8000-000000000001"

BACKLOG = """# Backlog

## In flight
- [ ] bc-39-specs-task - Write the BC-39 specs (repo: pmos) (kind: task)
- [ ] 2026-11-03-esim-annual-global-l3-requirements - BC-49 annual global requirements (repo: pmos)

## Queued
- [ ] lv-50-finish-flow - Finish the LV-50 flow (repo: pmos)
- [ ] reader-task-tags-build - Task tags in the reader (repo: pmos)
"""


def iso(minutes, seconds=0):
    return datetime.fromtimestamp(BASE + minutes * 60 + seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def hm(minutes):
    return time.strftime("%H:%M", time.localtime(BASE + minutes * 60))


def wrote(text, minutes, uid=None):
    record = {"type": "user", "timestamp": iso(minutes), "message": {"role": "user", "content": text}}
    if uid:
        record["uuid"] = uid
    return record


def wake(task, minutes, uid=None):
    text = f"<task-notification>\nfirstmate watcher wake\nsignal: /home/state/{task}.status\n</task-notification>"
    record = {"type": "user", "timestamp": iso(minutes), "origin": {"kind": "task-notification"}, "message": {"role": "user", "content": text}}
    if uid:
        record["uuid"] = uid
    return record


def background(minutes, label="cycle boundary: the watcher restarted"):
    text = f"<task-notification>\nfirstmate watcher wake\nsupervision-host: {label}\n</task-notification>"
    return {"type": "user", "timestamp": iso(minutes), "origin": {"kind": "task-notification"}, "message": {"role": "user", "content": text}}


def said(text, minutes, seconds=10):
    return {"type": "assistant", "timestamp": iso(minutes, seconds), "cwd": "/repo", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def ran(command, minutes, seconds=5):
    block = {"type": "tool_use", "id": f"t{minutes}", "name": "Bash", "input": {"command": command, "description": "Run it"}}
    return {"type": "assistant", "timestamp": iso(minutes, seconds), "cwd": "/repo", "message": {"role": "assistant", "content": [block]}}


class Lab(unittest.TestCase):
    """A scratch Firstmate home with the backlog above, and a helper that tags a list of records as the page does."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.fm = Path(self._tmp.name) / "firstmate"
        for name in ("data", "state", "projects"):
            (self.fm / name).mkdir(parents=True)
        (self.fm / "data" / "backlog.md").write_text(BACKLOG, encoding="utf-8")
        task_tags._KEPT.clear()

    def tagged(self, records, sid=SID):
        exchanges = builder.session_exchanges(records)
        chain = [Path(f"/x/{sid}.jsonl")]
        builder.attach_task_tags(exchanges, chain, {chain[0]: {"exchanges": exchanges}}, self.fm, builder.leader_tasks(self.fm))
        return exchanges

    def mark(self, task, turn, mark):
        folder = self.fm / "data" / task
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / "reply-marks.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"turn": turn, "mark": mark, "at": BASE, "by": "card"}) + "\n")

    @staticmethod
    def ids(exchange):
        return [task for task, _ in exchange.get("tags", [])]


class RuleTest(Lab):
    """One test for each of the four A2 rules, on synthetic logs, and for the rows of the turns no rule reaches."""

    def test_a_mention_the_reply_names_the_task_by_its_id(self):
        [turn] = self.tagged([wrote("How is it going?", 0, "u1"), said("Nathan, bc-39-specs-task is waiting on your review of the second draft, nothing else changed.", 0)])
        self.assertEqual(turn["tags"], [["bc-39-specs-task", "mention"]])
        self.assertNotIn("tag_row", turn)

    def test_a_mention_by_the_id_stem_of_fourteen_characters_or_more(self):
        [turn] = self.tagged([wrote("And the other one?", 0), said("Nathan, esim-annual-global-l3-requirements has its draft ready for you to read tonight.", 0)])
        self.assertEqual(self.ids(turn), ["2026-11-03-esim-annual-global-l3-requirements"])

    def test_a_record_the_wake_up_the_reader_tied_to_the_task(self):
        [turn] = self.tagged([wake("lv-50-finish-flow", 0), said("Nathan, all quiet.", 0)])
        self.assertEqual(turn["tags"], [["lv-50-finish-flow", "signal"]])

    def test_a_record_with_no_reply_at_all_still_carries_the_task_of_its_signal(self):
        [turn] = self.tagged([wake("lv-50-finish-flow", 0)])
        self.assertEqual(self.ids(turn), ["lv-50-finish-flow"])

    def test_a_command_the_task_id_in_the_turns_own_tool_calls(self):
        records = [wrote("Tell the worker to continue", 0), ran("fm-send.sh reader-task-tags-build 'carry on'", 0), said("Nathan, I told the worker to carry on with its slice.", 0, 20)]
        [turn] = self.tagged(records)
        self.assertEqual(turn["tags"], [["reader-task-tags-build", "command"]])

    def test_a_command_the_step_of_a_credential_file_is_never_read(self):
        records = [wrote("Look", 0), ran("cat ~/.ssh/id_rsa reader-task-tags-build", 0), said("Nathan, done.", 0, 20)]
        [turn] = self.tagged(records)
        self.assertNotIn("tags", turn)

    def test_a_pointer_your_message_takes_the_tasks_of_the_reply_it_points_at(self):
        records = [wrote("Status?", 0, "u1"), said("Nathan, a second draft waits on you for bc-39-specs-task; shall I start the third round?", 1),
                   wrote(f'Re your reply at {hm(1)} ("Nathan, a second draft waits on you for"): yes, go', 5, "u2"),
                   said("Nathan, started.", 5)]
        first, second = self.tagged(records)
        self.assertEqual(self.ids(first), ["bc-39-specs-task"])
        self.assertEqual(second["tags"], [["bc-39-specs-task", "pointer"]])

    def test_a_pointer_that_names_no_reply_or_two_tags_nothing(self):
        records = [wrote("Status?", 0), said("Nathan, bc-39-specs-task is waiting for you to read the draft.", 1),
                   wrote(f"Re your reply at {hm(40)}: yes", 5), said("Nathan, ok.", 5)]
        self.assertNotIn("tags", self.tagged(records)[1])

    def test_your_own_message_naming_a_task_is_tagged_by_what_it_says(self):
        records = [wrote("Please look at lv-50-finish-flow again", 0), said("Nathan, I will.", 0)]
        [turn] = self.tagged(records)
        self.assertEqual(turn["tags"], [["lv-50-finish-flow", "mention"]])

    def test_a_turn_that_touches_several_tasks_keeps_each_of_them_strongest_first(self):
        records = [wake("lv-50-finish-flow", 0), said("Nathan, lv-50-finish-flow is done and bc-39-specs-task is next.", 0)]
        [turn] = self.tagged(records)
        self.assertEqual(turn["tags"], [["lv-50-finish-flow", "signal+mention"], ["bc-39-specs-task", "mention"]])

    def test_a_roundup_that_names_four_tasks_is_about_none_of_them(self):
        text = "Nathan, status: bc-39-specs-task, lv-50-finish-flow, reader-task-tags-build and esim-annual-global-l3-requirements all moved today, and the details are below."
        [turn] = self.tagged([wrote("Roundup?", 0), said(text, 0)])
        self.assertNotIn("tags", turn)
        self.assertEqual(turn["tag_row"], "none")

    def test_a_heartbeat_and_a_short_reply_are_fleet_upkeep(self):
        records = [background(0), said("Nathan, shipshape.", 0), wake("not-a-task-in-the-backlog", 5), said("Nathan, nothing changed since the last check.", 5)]
        first, second = self.tagged(records)
        self.assertEqual((first.get("tag_row"), second.get("tag_row")), ("upkeep", "upkeep"))

    def test_your_message_with_no_task_and_a_substantive_reply_is_no_task(self):
        records = [wrote("What do you think of the weather in the report?", 0), said("Nathan, " + "a long reply about nothing in the fleet's tasks. " * 6, 0)]
        [turn] = self.tagged(records)
        self.assertEqual(turn["tag_row"], "none")

    def test_a_session_divider_is_never_tagged_and_every_other_turn_is(self):
        exchanges = builder.session_exchanges([wrote("Hello", 0), said("Nathan, hi, bc-39-specs-task is fine and waits for your review.", 0)])
        divider = builder.new_exchange("session", "current", "Session abc", "", None)
        builder.finish_exchange(divider)
        exchanges.insert(0, divider)
        chain = [Path(f"/x/{SID}.jsonl")]
        builder.attach_task_tags(exchanges, chain, {chain[0]: {"exchanges": exchanges}}, self.fm, builder.leader_tasks(self.fm))
        self.assertNotIn("tags", exchanges[0])
        self.assertNotIn("tag_row", exchanges[0])
        self.assertEqual(self.ids(exchanges[1]), ["bc-39-specs-task"])

    def test_the_tags_are_taken_off_again_when_the_task_list_is_empty(self):
        exchanges = builder.session_exchanges([wrote("Hello", 0), said("Nathan, bc-39-specs-task is fine and waits for your review.", 0)])
        exchanges[0]["tags"] = [["x", "mention"]]
        task_tags.tag_exchanges(exchanges, [SID], {}, self.fm)
        self.assertNotIn("tags", exchanges[0])
        self.assertNotIn("tag_row", exchanges[0])

    def test_a_turn_keeps_at_most_its_strongest_eight_tags(self):
        ids = [f"task-{n:02d}-alpha" for n in range(12)]
        text = "Nathan, " + ", ".join(ids[:3]) + " are on it."
        tasks = {task: {"title": task, "state": "In flight"} for task in ids}
        exchanges = builder.session_exchanges([wrote("go", 0), said(text, 0)])
        task_tags.tag_exchanges(exchanges, [SID], tasks, self.fm)
        self.assertEqual(sorted(self.ids(exchanges[0])), ids[:3])
        self.assertLessEqual(len(exchanges[0]["tags"]), task_tags.MAX_TAGS)


class MarksTest(Lab):
    """Your corrections are the board's reply marks (data/<task>/reply-marks.jsonl): the conversation reads the same file."""

    def records(self):
        return [wrote("Status?", 0, "uu111111aaaa"), said("Nathan, bc-39-specs-task is waiting on your review of the second draft.", 0),
                wrote("And the rest?", 5, "uu222222bbbb"), said("Nathan, the rest is fine and nothing needs you today, so you can carry on with other work.", 5)]

    def test_an_out_mark_takes_the_task_off_the_reply_and_it_falls_to_a_row(self):
        self.mark("bc-39-specs-task", f"{SID[:8]}:uu111111:reply", "out")
        [turn, _] = self.tagged(self.records())
        self.assertNotIn("tags", turn)
        self.assertEqual(turn["tag_row"], "none")

    def test_an_in_mark_puts_a_task_on_a_reply_no_rule_reached(self):
        self.mark("lv-50-finish-flow", f"{SID[:8]}:uu222222:reply", "in")
        [_, turn] = self.tagged(self.records())
        self.assertEqual(turn["tags"], [["lv-50-finish-flow", "marked"]])

    def test_a_mark_on_your_message_works_the_same_way(self):
        self.mark("lv-50-finish-flow", f"{SID[:8]}:uu222222:in", "in")
        [_, turn] = self.tagged(self.records())
        self.assertEqual(self.ids(turn), ["lv-50-finish-flow"])

    def test_the_last_line_for_a_turn_wins_and_clear_removes_it(self):
        self.mark("bc-39-specs-task", f"{SID[:8]}:uu111111:reply", "out")
        self.mark("bc-39-specs-task", f"{SID[:8]}:uu111111:reply", "clear")
        [turn, _] = self.tagged(self.records())
        self.assertEqual(self.ids(turn), ["bc-39-specs-task"])

    def test_a_mark_for_another_session_changes_nothing(self):
        self.mark("bc-39-specs-task", "99999999:uu111111:reply", "out")
        [turn, _] = self.tagged(self.records())
        self.assertEqual(self.ids(turn), ["bc-39-specs-task"])


class BoardAgreementTest(Lab):
    """One source of truth: every reply the board's tagger and marks put on a task, from the turn's own words alone, is tagged with that task here."""

    def test_a_reply_the_board_ties_to_a_task_is_tagged_with_it_in_the_conversation(self):
        records = []
        replies = [
            "Nathan, bc-39-specs-task is waiting on your review of the second draft, and nothing else needs you.",
            "Nathan, see data/lv-50-finish-flow/report.md for the finished flow; the details are in the report there.",
            "Nathan, the worker on fm/reader-task-tags-build pushed its slice and its branch is ready to land when you are.",
            "Nathan, nothing in this reply names a task at all, it is a long note about the weather and the day ahead.",
        ]
        for n, text in enumerate(replies):
            records += [wrote(f"Question {n}", n * 10, f"u{n}000000aaaa"), said(text, n * 10)]
        exchanges = self.tagged(records)
        described = [{"id": task, "title": record["title"]} for task, record in sorted(builder.leader_tasks(self.fm).items())]
        board = tagger.match_replies([{"text": e["reply"], "signal": "", "tools": "", "trigger": ""} for e in exchanges], described)
        agreed = 0
        for exchange, found in zip(exchanges, board):
            on_board = {task for task, m in found.items() if m["lvl"] in ("sure", "possible")}
            self.assertEqual(set(self.ids(exchange)), on_board)
            agreed += len(on_board)
        self.assertEqual(agreed, 3, "the three replies that name a task are on the board and here; the fourth is on neither")

    def test_the_same_turn_gets_the_same_tags_from_the_memory_as_from_the_rules(self):
        records = [wrote("go", 0), said("Nathan, bc-39-specs-task is waiting on your review of the second draft.", 0)]
        first = self.tagged(records)[0]["tags"]
        self.assertTrue(task_tags._KEPT)
        self.assertEqual(self.tagged(records)[0]["tags"], first)

    def test_a_new_task_in_the_backlog_is_found_in_turns_already_kept(self):
        records = [wrote("go", 0), said("Nathan, brand-new-task-id is what I am looking at, and it waits for you.", 0)]
        self.assertNotIn("tags", self.tagged(records)[0])
        with open(self.fm / "data" / "backlog.md", "a", encoding="utf-8") as handle:
            handle.write("- [ ] brand-new-task-id - A task added later (repo: pmos)\n")
        self.assertEqual(self.ids(self.tagged(records)[0]), ["brand-new-task-id"])


class ThreadTest(Lab):
    """A leader's conversation carries tags, a worker's and a plain folder's do not, and the tags are plain JSON."""

    def thread(self, cwd):
        records = [wrote("go", 0, "u1"), said("Nathan, bc-39-specs-task is waiting on your review of the second draft.", 0)]
        log = Path(self._tmp.name) / f"{SID}.jsonl"
        log.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        loaded = {log: {"exchanges": builder.session_exchanges(records), "cwd": cwd, "first_time": BASE}}
        return builder.thread_session({"id": "main", "home": self.fm}, [log], loaded, None)

    def test_a_leaders_conversation_carries_tags(self):
        session = self.thread(str(self.fm))
        self.assertEqual(session["exchanges"][0]["tags"], [["bc-39-specs-task", "mention"]])
        json.dumps(session["exchanges"])

    def test_a_workers_conversation_carries_none(self):
        session = self.thread(str(self.fm / "projects"))
        self.assertNotIn("tags", session["exchanges"][0])
        self.assertNotIn("tag_row", session["exchanges"][0])


if __name__ == "__main__":
    unittest.main()
