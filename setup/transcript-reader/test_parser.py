"""Tests for the parser behind the conversation view: who started each turn, how a
session splits into turns, which reply is a turn's answer, and the Needs you /
No action rules.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_parser.py
Fixtures are synthetic records shaped like Claude Code's session logs.
"""

import sys
import unittest
from pathlib import Path

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
        self.assertEqual((done["folded"], running["folded"]), (True, False))
        [finished] = self.exchanges([user(WAKE, 0, origin={"kind": "task-notification"}), tool(1), say("Nothing new.", 2)])
        self.assertTrue(finished["folded"])

    def test_session_events_are_dividers(self):
        compacted, interrupted = self.exchanges([
            user("This session is being continued from a previous conversation", 0),
            user("[Request interrupted by user]", 1),
        ])
        self.assertEqual((compacted["source"], compacted["kind"]), ("session", "compacted"))
        self.assertEqual((interrupted["source"], interrupted["kind"]), ("session", "interrupted"))

    def test_a_peer_message_starts_its_own_turn_and_keeps_the_previous_reply(self):
        mine, theirs = self.exchanges([
            user("Fix the login page", 0), tool(1), say("Fixed.", 2),
            user("<cross-session-message>Is the fix on the branch yet?</cross-session-message>", 3, isMeta=True, origin=PEER),
            say("Yes, on fm/login.", 4),
        ])
        self.assertEqual(mine["reply"], "Fixed.")
        self.assertEqual((theirs["source"], theirs["label"], theirs["input"]), ("peer", "From release-mate", PEER["body"]))
        self.assertEqual(theirs["reply"], "Yes, on fm/login.")

    def test_a_peer_message_sent_while_busy_is_not_shown_as_the_captains(self):
        _, theirs = self.exchanges([user("Fix it", 0), tool(1), queued("<agent-message>wrapped</agent-message>", 2, PEER), say("Yes.", 3)])
        self.assertEqual((theirs["source"], theirs["label"], theirs["absorbed"]), ("peer", "From release-mate", True))

    def test_a_hand_back_folds_like_a_wake_up(self):
        mine, handback = self.exchanges([
            user("Check the docs", 0), say("Started a checker.", 1),
            user("<agent-message>All four links resolve.</agent-message>", 2, isMeta=True, origin=HANDBACK),
            say("The checker found no broken links.", 3),
        ])
        self.assertEqual(mine["reply"], "Started a checker.")
        self.assertEqual((handback["source"], handback["label"], handback["folded"]), ("wake", "Hand-back from doc-checker", True))
        [queued_handback] = self.exchanges([user("Check", 0), tool(1), queued("report", 2, HANDBACK), say("Done.", 3)])
        self.assertEqual(queued_handback["notices"], [{"label": "Hand-back from doc-checker", "signal_task": None}])


class CaptainEventsTest(unittest.TestCase):
    def test_replies_to_another_session_stay_off_the_captains_timeline(self):
        exchanges = builder.session_exchanges([
            user("Ship it?", 0), say("Which branch should I use?", 1),
            user("x", 2, isMeta=True, origin=PEER), say("Which branch do you mean?", 3),
        ])
        events = builder.captain_events({"id": "main"}, exchanges, 0)
        self.assertEqual([(e["kind"], e["ref"]) for e in events], [("captain", 0), ("reply", 0)])


if __name__ == "__main__":
    unittest.main()
