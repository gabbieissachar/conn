"""Tests for the parser behind the conversation view: who started each turn, how a
session splits into turns, which reply is a turn's answer, and the Needs you /
No action rules.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_parser.py
Fixtures are synthetic records shaped like Claude Code's session logs.
"""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reader import builder  # noqa: E402

classify_input = builder.classify_input
classify_reply = builder.classify_reply


def stamp(second):
    return f"2026-10-23T10:00:{second:02d}Z"


def user(text, second, **extra):
    return {"type": "user", "timestamp": stamp(second), "message": {"role": "user", "content": text}, **extra}


def tool_result(second):
    return {"type": "user", "timestamp": stamp(second),
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "ok"}]}}


def say(text, second):
    return {"type": "assistant", "timestamp": stamp(second), "cwd": "/repo",
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def tool(second, name="Bash"):
    return {"type": "assistant", "timestamp": stamp(second), "cwd": "/repo",
            "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": name, "input": {"command": "ls"}}]}}


def queued(prompt, second, origin=None):
    attachment = {"type": "queued_command", "prompt": prompt}
    if origin:
        attachment["origin"] = origin
    return {"type": "attachment", "timestamp": stamp(second), "attachment": attachment}


PEER = {"kind": "peer", "from": "session-123", "name": "release-mate", "fromMode": "send", "msg_id": "m1",
        "body": "Is the fix on the branch yet?"}
HANDBACK = {"kind": "peer", "from": "task-9", "name": "doc-checker", "senderTaskId": "t9", "handback": True,
            "body": "All four links resolve."}
WAKE = "<task-notification>\nfirstmate watcher wake\nsignal: /home/state/fix-login.status\n</task-notification>"


class ClassifyInputTest(unittest.TestCase):
    def test_each_input_shape_gets_its_source(self):
        cases = [
            (WAKE, "task-notification", False, ("wake", "status", "New status from fix-login")),
            ("This session is being continued from a previous conversation that ran out", None, False,
             ("session", "compacted", "Earlier context was summarised")),
            ("[Request interrupted by user for tool use]", None, False, ("session", "interrupted", "You interrupted the turn")),
            ("<command-name>/clear</command-name><command-args></command-args>", None, False, ("session", "command", "You ran /clear")),
            ("<local-command-stdout>done</local-command-stdout>", None, False, ("session", "command-output", "Command output")),
            ("Base directory for this skill: /x", None, True, ("session", "command-output", "Command output")),
            ("⁣FIRSTMATE_OP: v1 launch-brief: # Task", None, False, ("firstmate", "brief", "Firstmate: task instructions")),
            ("Firstmate instruction waiting: read '/h/state/x.inbox'", None, False, ("firstmate", "steer", "Firstmate: instruction")),
            ("<command-name>/review</command-name><command-args>42</command-args>", "human", False, ("captain", "command", "/review 42")),
            ("Can you check the login page?", None, False, ("captain", "message", "You")),
        ]
        for text, origin, meta, expected in cases:
            with self.subTest(text=text[:30]):
                self.assertEqual(classify_input(text, origin, meta), expected)

    def test_wake_labels(self):
        self.assertEqual(builder.wake_label("firstmate watcher wake\nheartbeat"), ("heartbeat", "Routine fleet check"))
        self.assertEqual(builder.wake_label("firstmate watcher wake\nstale: x"), ("quiet", "A worker has been quiet a while"))
        self.assertEqual(builder.wake_label("firstmate watcher wake\ncheck: merged PRs"), ("check", "Check: merged PRs"))
        self.assertEqual(builder.wake_label('Background command "npm test" completed (exit 0)'),
                         ("background", "Background task completed: npm test"))
        self.assertEqual(builder.wake_label("Stop hook feedback: run the tests"), ("hook", "Turn-end check"))

    def test_wake_labels_say_what_happened_in_words(self):
        wake = "firstmate watcher wake - one supervision event needs a handling turn now.\n"
        self.assertEqual(builder.wake_label(wake + "supervision-host: cycle boundary - the host ended its park"),
                         ("supervision", "Monitoring cycle restarted"))
        self.assertEqual(builder.wake_label(wake + "supervision-host: branch-outcome: the session handled this wake"),
                         ("supervision", "Supervision recorded outcomes to pass on"))
        self.assertEqual(builder.wake_label(wake + "supervision-host: new-thing - details"), ("supervision", "Supervision: new-thing"))
        self.assertEqual(builder.wake_label(wake + "check: /h/state/fleet-sweep.check.sh: fleet sweep due: last swept 120m ago"),
                         ("check", "Check: fleet sweep due: last swept 120m ago"))
        self.assertEqual(builder.wake_label('<summary>Background command "a &gt;/dev/null 2&gt;&amp;1" completed</summary>'),
                         ("background", "Background task completed: a >/dev/null 2>&1"))

    def test_peer_origins(self):
        self.assertEqual(builder.peer_input(PEER), ("peer", "message", "From release-mate"))
        self.assertEqual(builder.peer_input(HANDBACK), ("wake", "handback", "Hand-back from doc-checker"))
        self.assertIsNone(builder.peer_input({"kind": "task-notification"}))
        self.assertEqual(builder.peer_text(PEER, "<cross-session-message>wrapped</cross-session-message>"), PEER["body"])
        self.assertEqual(builder.peer_text({"kind": "peer"}, "plain words"), "plain words")


class ClassifyReplyTest(unittest.TestCase):
    def verdict(self, reply):
        result = classify_reply(reply)
        return result["verdict"], result["rule"]

    def test_first_line_labels_win(self):
        self.assertEqual(self.verdict("Needs you: pick a name.\nDetails follow."), ("needs-you", "first line says so"))
        self.assertEqual(self.verdict("No action: merged.\nShould I tidy up later?"), ("no-action", "first line says so"))
        self.assertEqual(self.verdict("Captain, shipshape."), ("no-action", "first line says so"))

    def test_questions_and_ask_wording(self):
        self.assertEqual(self.verdict("The build passed. Shall we land it?"), ("needs-you", "question"))
        self.assertEqual(self.verdict("The PR is ready for review."), ("needs-you", "ask wording"))
        self.assertEqual(self.verdict("Reply with the account name and I'll continue."), ("needs-you", "ask wording"))

    def test_questions_inside_code_quotes_links_and_headings_do_not_count(self):
        reply = "\n".join([
            "Fixed the parser.",
            "```",
            "is it done?",
            "```",
            "> did it work?",
            "The flag is `--dry-run?` and the page is https://example.com/a?b=1",
            "**Why did it fail?**",
            "The path was wrong.",
        ])
        self.assertEqual(self.verdict(reply), ("no-action", "no ask found"))

    def test_saying_nothing_is_needed_is_not_an_ask(self):
        self.assertEqual(self.verdict("No action needed. The fix landed."), ("no-action", "no ask found"))
        self.assertEqual(self.verdict("I'll bring the findings and wait for your approval."), ("no-action", "no ask found"))

    def test_reminders(self):
        self.assertEqual(self.verdict("Still waiting on your answer about the name."), ("no-action", "reminder only"))
        reply = "Still waiting on your pick.\n\n- Option 1: ship now\n- Option 2: wait"
        self.assertEqual(self.verdict(reply), ("needs-you", "pending choice with options"))

    def test_ask_lines_point_at_the_asking_line(self):
        result = classify_reply("Done with the fix.\nDo you want me to merge it?\nTests pass.")
        self.assertEqual(result["ask_lines"], [1])
        self.assertEqual(result["asks"], ["Do you want me to merge it?"])

    def test_empty_reply(self):
        self.assertEqual(self.verdict("  "), ("none", "no reply"))


class SessionExchangesTest(unittest.TestCase):
    def exchanges(self, records):
        return builder.session_exchanges(records)

    def test_the_reply_is_the_text_after_the_last_tool_call(self):
        [turn] = self.exchanges([
            user("Fix the login page", 0), say("Looking at it.", 1), tool(2), tool_result(3), say("Fixed. Want me to merge?", 4),
        ])
        self.assertEqual((turn["source"], turn["input"]), ("captain", "Fix the login page"))
        self.assertEqual(turn["reply"], "Fixed. Want me to merge?")
        self.assertEqual(turn["narration"], ["Looking at it."])
        self.assertEqual((turn["tools"], turn["verdict"]), (1, "needs-you"))

    def test_a_message_sent_while_busy_starts_its_own_turn(self):
        first, second = self.exchanges([
            user("Fix the login page", 0), tool(1), queued("Also check signup", 2), tool(3), say("Both fixed.", 4),
        ])
        self.assertEqual(first["reply"], "")
        self.assertEqual((second["input"], second["absorbed"], second["reply"]), ("Also check signup", True, "Both fixed."))

    def test_a_queued_wake_up_becomes_a_notice_on_the_running_turn(self):
        [turn] = self.exchanges([user("Fix it", 0), tool(1), queued(WAKE, 2, {"kind": "task-notification"}), say("Done.", 3)])
        self.assertEqual(turn["notices"], [{"label": "New status from fix-login", "signal_task": "fix-login"}])
        self.assertEqual(turn["reply"], "Done.")

    def test_command_output_does_not_start_a_turn(self):
        [turn] = self.exchanges([
            user("<command-name>/review</command-name><command-args>42</command-args>", 0, origin={"kind": "human"}),
            user("Review instructions...", 1, isMeta=True), say("Reviewed: two issues.", 2),
        ])
        self.assertEqual((turn["label"], turn["reply"]), ("/review 42", "Reviewed: two issues."))

    def test_wake_ups_fold_unless_their_reply_asks(self):
        quiet, asking = self.exchanges([
            user(WAKE, 0, origin={"kind": "task-notification"}), say("Nothing new.", 1),
            user(WAKE, 2, origin={"kind": "task-notification"}), say("The fix is ready. Merge it?", 3),
        ])
        self.assertEqual((quiet["source"], quiet["folded"], quiet["signal_task"]), ("wake", True, "fix-login"))
        self.assertEqual((asking["folded"], asking["verdict"]), (False, "needs-you"))

    def test_the_newest_wake_up_stays_open_until_it_has_a_reply(self):
        done, running = self.exchanges([
            user(WAKE, 0, origin={"kind": "task-notification"}), say("Nothing new.", 1),
            user(WAKE, 2, origin={"kind": "task-notification"}), tool(3),
        ])
        self.assertEqual((done["folded"], running["folded"]), (False, False), "the newest reply and the running turn")
        [finished, divider] = self.exchanges([user(WAKE, 0, origin={"kind": "task-notification"}), tool(1), say("Nothing new.", 2),
                                              user("This session is being continued from a previous conversation", 3)])
        self.assertFalse(finished["folded"], "the newest reply stays open, even before a later divider")

    def test_the_newest_reply_stays_open_even_in_a_wake_up(self):
        mine, quiet, report = self.exchanges([
            user("Fix it", 0), say("Started.", 1),
            user(WAKE, 2, origin={"kind": "task-notification"}), say("Still waiting.", 3),
            user(WAKE, 4, origin={"kind": "task-notification"}), tool(5), say("Committed the fix on fm/login.", 6),
        ])
        self.assertEqual((quiet["folded"], report["folded"]), (True, False))

    def test_session_events_are_dividers(self):
        compacted, interrupted = self.exchanges([
            user("This session is being continued from a previous conversation", 0),
            user("[Request interrupted by user]", 1),
        ])
        self.assertEqual((compacted["source"], compacted["kind"]), ("session", "compacted"))
        self.assertEqual((interrupted["source"], interrupted["kind"]), ("session", "interrupted"))

    def test_replies_before_the_last_compaction_are_marked_as_no_longer_held(self):
        exchanges = self.exchanges([
            user("Fix it", 0), say("Which branch?", 1),
            user("This session is being continued from a previous conversation", 2), say("Resumed.", 3),
            user("Use main", 4), say("Done on main.", 5),
        ])
        builder.mark_compacted_away(exchanges)
        self.assertEqual([e.get("compacted_away", False) for e in exchanges], [True, False, False])
        unchanged = self.exchanges([user("Fix it", 0), say("Which branch?", 1), user("Use main", 2), say("Done on main.", 3)])
        builder.mark_compacted_away(unchanged)
        self.assertEqual([e.get("compacted_away", False) for e in unchanged], [False, False], "no compaction, nothing marked")

    def test_a_peer_message_starts_its_own_turn_and_keeps_the_previous_reply(self):
        mine, theirs = self.exchanges([
            user("Fix the login page", 0), tool(1), say("Fixed.", 2),
            user("<cross-session-message>Is the fix on the branch yet?</cross-session-message>", 3, isMeta=True, origin=PEER),
            say("Yes, on fm/login.", 4),
        ])
        self.assertEqual(mine["reply"], "Fixed.")
        self.assertEqual((theirs["source"], theirs["label"], theirs["input"]), ("peer", "From release-mate", PEER["body"]))
        self.assertEqual(theirs["reply"], "Yes, on fm/login.")

    def test_a_message_answered_after_one_sent_while_busy_is_answered_below(self):
        first, second, third = self.exchanges([
            user("Fix the login page", 0), tool(1), queued("Also the footer", 2), say("Both fixed.", 3),
            user("Thanks", 4), tool(5),
        ])
        self.assertEqual((first["reply"], first["answered_below"]), ("", True))
        self.assertEqual((second["reply"], second["answered_below"]), ("Both fixed.", False))
        self.assertFalse(third["answered_below"])

    def test_a_peer_message_sent_while_busy_is_not_shown_as_the_captains(self):
        _, theirs = self.exchanges([user("Fix it", 0), tool(1), queued("<agent-message>wrapped</agent-message>", 2, PEER), say("Yes.", 3)])
        self.assertEqual((theirs["source"], theirs["label"], theirs["absorbed"]), ("peer", "From release-mate", True))

    def test_a_hand_back_folds_like_a_wake_up(self):
        mine, handback = self.exchanges([
            user("Check the docs", 0), say("Started a checker.", 1),
            user("<agent-message>All four links resolve.</agent-message>", 2, isMeta=True, origin=HANDBACK),
            say("The checker found no broken links.", 3), user("Thanks", 4), say("Welcome.", 5),
        ])[:2]
        self.assertEqual(mine["reply"], "Started a checker.")
        self.assertEqual((handback["source"], handback["label"], handback["folded"]), ("wake", "Hand-back from doc-checker", True))
        [queued_handback] = self.exchanges([user("Check", 0), tool(1), queued("report", 2, HANDBACK), say("Done.", 3)])
        self.assertEqual(queued_handback["notices"], [{"label": "Hand-back from doc-checker", "signal_task": None}])


class TurnIdTest(unittest.TestCase):
    """A pin names its message by the turn's id, so the id must be the log's own record id, and must not move when turns are added before it."""

    def test_a_turn_takes_the_id_of_the_record_that_started_it(self):
        records = [user("First", 0, uuid="11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1"), say("One.", 1),
                   user("Second", 2, uuid="22222222-bbbb-4bbb-8bbb-bbbbbbbbbbb2"), tool(3), say("Two.", 4)]
        first, second = builder.session_exchanges(records)
        self.assertEqual((first["uid"], second["uid"]), ("11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbb2"))

    def test_a_message_sent_while_busy_has_the_id_of_its_own_record(self):
        attachment = queued("while busy", 3)
        attachment["uuid"] = "33333333-cccc-4ccc-8ccc-ccccccccccc3"
        _, absorbed = builder.session_exchanges([user("Start", 0, uuid="11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1"), tool(1), attachment, say("Done.", 4)])
        self.assertEqual(absorbed["uid"], "33333333-cccc-4ccc-8ccc-ccccccccccc3")

    def test_an_id_does_not_depend_on_what_came_before_the_turn(self):
        later = [user("Second", 2, uuid="22222222-bbbb-4bbb-8bbb-bbbbbbbbbbb2"), say("Two.", 3)]
        alone = builder.session_exchanges(later)
        after = builder.session_exchanges([user("Zeroth", 0, uuid="00000000-aaaa-4aaa-8aaa-aaaaaaaaaaa0"), say("Zero.", 1), *later])
        self.assertEqual(alone[0]["uid"], after[1]["uid"])

    def test_a_record_without_a_usable_id_gets_one_made_from_its_time_and_words_that_holds_on_a_rebuild(self):
        [turn] = builder.session_exchanges([user("Plain words", 5), say("Reply.", 6)])
        [again] = builder.session_exchanges([user("Plain words", 5), say("Reply.", 6)])
        [other] = builder.session_exchanges([user("Other words", 5), say("Reply.", 6)])
        self.assertEqual(turn["uid"], again["uid"])
        self.assertNotEqual(turn["uid"], other["uid"])
        self.assertRegex(turn["uid"], r"^[0-9A-Za-z_-]{8,80}$")
        [odd] = builder.session_exchanges([user("Plain words", 5, uuid="has spaces/and:colons"), say("Reply.", 6)])
        self.assertEqual(odd["uid"], turn["uid"], "an id that could not be a pin's key is not used")

    def test_ids_are_unique_within_a_conversation_and_session_dividers_have_none(self):
        records = [user(f"Message {n}", n, uuid=f"{n:08d}-aaaa-4aaa-8aaa-aaaaaaaaaaaa") for n in range(5)]
        uids = [e["uid"] for e in builder.session_exchanges(records)]
        self.assertEqual(len(set(uids)), 5)
        self.assertIsNone(builder.new_exchange("session", "cleared", "Session abc", "", None)["uid"])


class DoorbellTest(unittest.TestCase):
    """A steering doorbell shows the inbox messages it delivered, in either format."""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.home, self.parent = Path(self.tmp.name) / "mate", Path(self.tmp.name) / "main"
        inbox = self.parent / "state" / "fix-login.inbox"
        (inbox / "handled").mkdir(parents=True)
        (inbox / "handled" / "1.msg").write_text("at=2026-10-23T10:00:05Z\n--\n[fm-from-firstmate] Rebase onto main first.", encoding="utf-8")
        self.addCleanup(self.tmp.cleanup)

    def steer(self, text):
        [turn] = builder.session_exchanges([user(text, 0), say("Rebased.", 9)])
        builder.attach_inbox_bodies([turn], [self.home, self.parent])
        return turn

    def test_current_format_names_the_inbox_in_the_steering_homes_state(self):
        turn = self.steer(": Firstmate instruction waiting: list \"$FM_TASK_INBOX\"/*.msg in your 'fix-login.inbox' "
                          "steering inbox, read and act on each in numeric order, then mv each into its handled/.")
        self.assertEqual((turn["kind"], turn["delivered"], turn["undelivered"]), ("steer", ["Rebase onto main first."], False))

    def test_a_second_ring_for_the_same_message_is_a_repeat(self):
        ring = ": Firstmate instruction waiting: list \"$FM_TASK_INBOX\"/*.msg in your 'fix-login.inbox' steering inbox, read it."
        first, again = builder.session_exchanges([user(ring, 6), tool(7), queued(ring, 8), say("Rebased.", 9)])
        builder.attach_inbox_bodies([first, again], [self.home, self.parent])
        self.assertEqual((first["delivered"], first["repeat"]), (["Rebase onto main first."], False))
        self.assertEqual((again["delivered"], again["repeat"], again["undelivered"]), ([], True, False))

    def test_task_instructions_show_in_place_of_their_pointer(self):
        brief = self.parent / "state" / "operational-inbox" / "1-abc.msg"
        brief.parent.mkdir(parents=True)
        brief.write_text("\u2063FIRSTMATE_OP: v1 launch-brief: # Role\nYou are a worker.\n# Task\nFix the login page.", encoding="utf-8")
        pointer = f": Firstmate operational input waiting: read '{brief}' and handle its contents as Firstmate operational input."
        [turn] = builder.session_exchanges([user(pointer, 0), say("On it.", 1)])
        builder.attach_inbox_bodies([turn], [self.home])
        self.assertEqual((turn["kind"], turn["delivered"], turn["undelivered"]), ("brief", ["# Task\nFix the login page."], False))
        brief.unlink()
        builder.attach_inbox_bodies([turn], [self.home])
        self.assertEqual((turn["delivered"], turn["undelivered"]), ([], True))

    def test_absolute_path_format(self):
        turn = self.steer(f"Firstmate instruction waiting: read '{self.parent}/state/fix-login.inbox'")
        self.assertEqual(turn["delivered"], ["Rebase onto main first."])

    def test_an_inbox_that_cannot_be_found_is_said_so(self):
        turn = self.steer(": Firstmate instruction waiting: list \"$FM_TASK_INBOX\"/*.msg in your 'gone.inbox' steering inbox, read it.")
        self.assertEqual((turn["delivered"], turn["undelivered"]), ([], True))
        self.assertEqual(builder.doorbell_inbox("in your '../x' steering inbox", [self.home]), None)


class CaptainEventsTest(unittest.TestCase):
    def test_replies_to_another_session_stay_off_the_captains_timeline(self):
        exchanges = builder.session_exchanges([
            user("Ship it?", 0), say("Which branch should I use?", 1),
            user("x", 2, isMeta=True, origin=PEER), say("Which branch do you mean?", 3),
        ])
        events = builder.captain_events({"id": "main"}, exchanges, 0)
        self.assertEqual([(e["kind"], e["ref"]) for e in events], [("captain", 0), ("reply", 0)])


class ParsedLogTest(unittest.TestCase):
    """A rebuild parses only the logs that changed; the rest come from out/parsed/."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.cache = Path(tmp.name) / "parsed"
        self.log = Path(tmp.name) / "s1.jsonl"
        self.write([user("Fix the login page", 0), say("Fixed. Want me to merge?", 4)])

    def write(self, records):
        self.log.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")

    def parse(self):
        real = builder.session_exchanges
        with mock.patch.object(builder, "session_exchanges", side_effect=real) as parsing:
            log = builder.parsed_log(self.log, self.cache)
        return log, parsing.call_count

    def test_an_unchanged_log_is_read_back_as_it_was_parsed(self):
        first, parsed = self.parse()
        self.assertEqual(parsed, 1)
        fresh = json.loads(json.dumps(builder.session_exchanges(builder.read_jsonl(self.log))))
        self.assertEqual(first, {"exchanges": fresh, "first_time": builder.iso_to_epoch(stamp(0)), "cwd": "/repo"})
        again, parsed = self.parse()
        self.assertEqual((again, parsed), (first, 0))

    def test_each_read_gives_new_turns_to_change(self):
        first, _ = self.parse()
        first["exchanges"][0]["from_session"] = "older"
        again, _ = self.parse()
        self.assertNotIn("from_session", again["exchanges"][0])

    def test_a_log_that_grew_is_parsed_again(self):
        self.parse()
        self.write([user("Fix the login page", 0), say("Fixed. Want me to merge?", 4), user("Yes", 5), say("Merged.", 6)])
        log, parsed = self.parse()
        self.assertEqual((parsed, [e["reply"] for e in log["exchanges"]]), (1, ["Fixed. Want me to merge?", "Merged."]))

    def test_new_parsing_rules_parse_every_log_again(self):
        self.parse()
        with mock.patch.object(builder, "PARSE_RULES", "changed"):
            self.assertEqual(self.parse()[1], 1)

    def test_parsed_logs_no_build_used_for_a_week_are_removed(self):
        self.parse()
        saved = self.cache / "s1.json"
        old = time.time() - 8 * 86400
        os.utime(saved, (old, old))
        self.parse()  # used again, so kept
        builder.prune_parsed(self.cache)
        self.assertTrue(saved.exists())
        os.utime(saved, (old, old))
        builder.prune_parsed(self.cache)
        self.assertFalse(saved.exists())


class HeadFieldsTest(unittest.TestCase):
    def test_a_cut_down_head_answers_as_the_whole_records_do(self):
        clear = "<command-name>/clear</command-name>"
        records = [{"type": "bridge-session", "bridgeSessionId": "b1", "timestamp": stamp(0)},
                   tool_result(1), user("<local-command-caveat>x</local-command-caveat>", 2, isMeta=True),
                   user([{"type": "text", "text": clear}, {"type": "image", "source": "x" * 1000}], 3), say("ok", 4)]
        slim = [builder.head_fields(r) for r in records]
        for read in (builder.cleared_at, builder.bridge_id, builder.first_time):
            self.assertEqual(read(slim), read(records), read.__name__)
        self.assertEqual(builder.cleared_at(slim), builder.iso_to_epoch(stamp(3)))
        self.assertNotIn("content", slim[1]["message"]["content"][0])
        self.assertNotIn("message", slim[4])


def at(minute, second=0):
    return f"2026-10-23T10:{minute:02d}:{second:02d}Z"


def said(text, minute, second=0):
    return {"type": "assistant", "timestamp": at(minute, second), "cwd": "/repo",
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def wrote(text, minute, second=0):
    return {"type": "user", "timestamp": at(minute, second), "message": {"role": "user", "content": text}}


def clock(exchange):
    """The time a Reply pointer writes for a turn's reply: its local hour and minute."""
    return time.strftime("%H:%M", time.localtime(exchange["reply_at"]))


GRILL = """Review group A (2 cards): two calls on the launch note.

| ID | Decision | Depends on | Recommended default | Answer |
| --- | --- | --- | --- | --- |
| A1 | Which date goes in the note | none | The **later** date. | `later`, `earlier`, or `needs explanation` |
| A2 | Who signs it off | A1 | Finance. | `finance` or `ops` |

Reply with keyed answers: `A1=...; A2=...`
"""
GRILL_AGAIN = """Review group A again (1 card): the date changed.

| ID | Decision | Depends on | Recommended default | Answer |
| --- | --- | --- | --- | --- |
| A1 | Which date goes in the note now | none | The **later** date. | `later`, `earlier`, or `needs explanation` |

Reply with keyed answers: `A1=...`
"""
OTHER_GRILL = GRILL.replace("A1", "B1").replace("A2", "B2")


class AskStateTest(unittest.TestCase):
    """Which asks are open, quiet or settled (builder.mark_asks): the rule behind the yellow Needs you and the header count."""

    def marked(self, records):
        exchanges = builder.session_exchanges(records)
        builder.mark_asks(exchanges)
        return exchanges

    def states(self, records):
        return [(e.get("ask_state"), e.get("settled_by")) for e in self.marked(records)]

    def test_an_ask_is_open_while_you_have_written_nothing_after_it(self):
        self.assertEqual(self.states([wrote("Fix it", 0), said("Fixed. Shall I merge it?", 1)]), [("open", None)])

    def test_only_the_newest_ask_is_open_when_none_was_answered(self):
        states = self.states([wrote("Fix it", 0), said("Shall I merge it?", 1), wrote("Also fix signup", 2), said("Which account should I use?", 3)])
        self.assertEqual(states, [("quiet", None), ("open", None)])

    def test_a_later_message_that_answers_nothing_turns_the_ask_grey_not_settled(self):
        states = self.states([wrote("Fix it", 0), said("Fixed. Shall I merge it?", 1), wrote("Unrelated: check the docs", 2), said("Docs are fine.", 3)])
        self.assertEqual(states, [("quiet", None), (None, None)])

    def test_a_reply_that_asks_nothing_has_no_ask_state(self):
        self.assertEqual(self.states([wrote("Fix it", 0), said("Fixed.", 1)]), [(None, None)])

    def test_a_command_or_a_wake_up_after_the_ask_does_not_close_it(self):
        records = [wrote("Fix it", 0), said("Shall I merge it?", 1), wrote(WAKE, 2, ), said("Nothing new.", 3)]
        records[2]["origin"] = {"kind": "task-notification"}
        self.assertEqual([e["ask_state"] for e in self.marked(records)[:1]], ["open"])

    def test_a_reply_pointer_settles_the_reply_it_names_and_only_that_one(self):
        first_records = [wrote("Fix it", 0), said("Shall I merge it?", 1), wrote("And signup", 2), said("Which account should I use?", 5)]
        first, second = builder.session_exchanges(first_records)
        pointer = f"Re your reply at {clock(first)} (\"Shall I merge it?\"): yes"
        states = self.states(first_records + [wrote(pointer, 7), said("Merging.", 8)])
        self.assertEqual(states, [("settled", "reply"), ("quiet", None), (None, None)])

    def test_a_pointer_to_a_minute_no_reply_has_settles_nothing(self):
        states = self.states([wrote("Fix it", 0), said("Shall I merge it?", 1), wrote("Re your reply at 03:33 (\"Shall I merge it?\"): yes", 2), said("ok", 3)])
        self.assertEqual(states[0], ("quiet", None))

    def test_two_replies_in_one_minute_are_told_apart_by_the_words_the_pointer_quotes(self):
        records = [wrote("Fix it", 0), said("Shall I merge the login fix?", 1, 5), wrote("Also fix signup", 1, 10), said("Which account should the signup test use?", 1, 40)]
        first, second = builder.session_exchanges(records)
        self.assertEqual(clock(first), clock(second))
        pointer = f"Re your reply at {clock(second)} (\"Which account should the signup test use?\"): the shared one"
        self.assertEqual(self.states(records + [wrote(pointer, 3), said("ok", 4)]), [("quiet", None), ("settled", "reply"), (None, None)])
        # With no quoted words the pointer cannot say which one, so neither is settled.
        bare = f"Re your reply at {clock(second)}: the shared one"
        self.assertEqual(self.states(records + [wrote(bare, 3), said("ok", 4)]), [("quiet", None), ("quiet", None), (None, None)])

    def test_a_pointer_with_a_day_names_that_day_only(self):
        records = [wrote("Fix it", 0), said("Shall I merge it?", 1), wrote("later", 2), said("ok", 3)]
        [ask, _] = builder.session_exchanges(records)
        when = time.localtime(ask["reply_at"])
        wrong_day = f"Re your reply at {when.tm_mday % 28 + 1} {time.strftime('%b', when)} {clock(ask)}: yes"
        right_day = f"Re your reply at {time.strftime('%a', when)} {when.tm_mday} {time.strftime('%b', when)} {clock(ask)}: yes"
        self.assertEqual(self.states(records + [wrote(wrong_day, 4), said("ok", 5)])[0], ("quiet", None))
        self.assertEqual(self.states(records + [wrote(right_day, 4), said("ok", 5)])[0], ("settled", "reply"))

    def test_a_keyed_line_settles_the_round_that_asked_those_keys(self):
        records = [wrote("Review it", 0), said(GRILL, 1), wrote("A1=later;A2=finance", 2), said("Recorded.", 3)]
        self.assertEqual(self.states(records), [("settled", "keyed"), (None, None)])

    def test_a_keyed_line_does_not_settle_a_round_that_asked_other_keys(self):
        records = [wrote("Review it", 0), said(GRILL, 1), wrote("B1=x;B2=y", 2), said("Recorded.", 3)]
        self.assertEqual(self.states(records)[0], ("quiet", None))

    def test_a_placeholder_or_an_empty_key_answers_nothing(self):
        for text in ("A1=...; A2=...", "A1=; A2=", "A1=\u2026"):
            with self.subTest(text=text):
                self.assertEqual(self.states([wrote("Review it", 0), said(GRILL, 1), wrote(text, 2), said("?", 3)])[0], ("quiet", None))

    def test_a_key_asked_again_in_a_later_round_settles_the_later_round_not_the_earlier(self):
        records = [wrote("Review it", 0), said(GRILL, 1), wrote("Hold on, the date changed", 2), said(GRILL_AGAIN, 3), wrote("A1=earlier", 4), said("Recorded.", 5)]
        self.assertEqual(self.states(records), [("quiet", None), ("settled", "keyed"), (None, None)])

    def test_one_keyed_line_settles_every_round_whose_keys_it_answers(self):
        records = [wrote("Review it", 0), said(GRILL, 1), wrote("Also", 2), said(OTHER_GRILL, 3), wrote("A1=later;A2=ops;B1=later;B2=ops", 4), said("ok", 5)]
        self.assertEqual(self.states(records), [("settled", "keyed"), ("settled", "keyed"), (None, None)])

    def test_a_key_answered_before_a_round_asked_it_does_not_settle_it(self):
        records = [wrote("A1=later", 0), said("ok", 1), wrote("Review it", 2), said(GRILL, 3)]
        self.assertEqual(self.states(records), [(None, None), ("open", None)])

    def test_a_keyed_line_on_a_reply_that_asked_no_keys_settles_nothing(self):
        records = [wrote("Fix it", 0), said("Shall I merge it?", 1), wrote("A1=later", 2), said("ok", 3)]
        self.assertEqual(self.states(records)[0], ("quiet", None))

    def test_asks_are_marked_again_from_the_turns_each_time(self):
        exchanges = builder.session_exchanges([wrote("Fix it", 0), said("Shall I merge it?", 1)])
        builder.mark_asks(exchanges)
        self.assertEqual(exchanges[0]["ask_state"], "open")
        exchanges.append(builder.session_exchanges([wrote("later", 5), said("ok", 6)])[0])
        builder.mark_asks(exchanges)
        self.assertEqual(exchanges[0]["ask_state"], "quiet")

    def test_the_sheet_cards_list_the_questions_with_their_recommended_defaults(self):
        from build_questionnaire import parse_questionnaire
        cards = builder.sheet_cards(parse_questionnaire(GRILL))
        self.assertEqual([c["key"] for c in cards], ["A1", "A2"])
        self.assertEqual(cards[0]["q"], "Which date goes in the note")
        self.assertIn("later", cards[0]["rec"].lower())
        session = {"id": "abcdef12-0000", "exchanges": self.marked([wrote("Review it", 0), said(GRILL, 1)])}
        builder.mark_sheets([session])
        self.assertEqual([c["key"] for c in session["exchanges"][0]["sheet_cards"]], ["A1", "A2"])


if __name__ == "__main__":
    unittest.main()
