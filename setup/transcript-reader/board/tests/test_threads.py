"""Slices 4 (reader half) and 5: the transcript reading, the shared tagger, the threads, the marks and the worker boards."""

from __future__ import annotations

import json
import sqlite3
import time
import unittest
from pathlib import Path

from base import NOW, FakeCollector, HomeCase, held, record, snapshot, task_row  # noqa: F401  (base also puts the package on sys.path)
from labstore import ROOT, T0, Lab

from board import homes, marks, tagger, threads, transcripts, workers
from board.build import build_board

CWD = "/lab/homes/esim"
PROPOSED_VIEW = ROOT / "store" / "PROPOSED-v1-turn-tools.sql"


def reply(text, at, key=None, signal=None, trigger="", tools=""):
    key = key or f"s{int(at):07d}:u{int(at):07d}:reply"
    return {"e": at, "text": text, "sid": key.split(":")[0], "uid": key.split(":")[1], "key": key, "signal": signal, "trigger": trigger, "tools": tools}


def human(text, at, key=None, **extra):
    key = key or f"s{int(at):07d}:u{int(at):07d}:in"
    return {"e": at, "text": text, "sid": key.split(":")[0], "uid": key.split(":")[1], "key": key, "hm": None, "quote": None, "part": None, **extra}


def item(ref, title="A task", **over):
    base = {"ref": ref, "title": title, "branch": None, "pr": None, "calls": [], "started_at": None}
    base.update(over)
    return base


class SplitHuman(unittest.TestCase):
    def test_an_answer_sheet_is_one_item_per_comment_with_its_reply_time_quote_and_part(self):
        raw = ('2 comments:\n\n1. Re your reply at 23:28 ("Nathan, three things."), the part "3. #working-group": can defer this.\n\n'
               '2. how is the task board going ?')
        parts = transcripts.split_human(raw)
        self.assertEqual(len(parts), 2)
        self.assertEqual((parts[0]["hm"], parts[0]["quote"], parts[0]["part"], parts[0]["text"]), ("23:28", "Nathan, three things.", "3. #working-group", "can defer this."))
        self.assertEqual(parts[1]["text"], "how is the task board going ?")

    def test_plain_text_is_one_item_and_a_pasted_wrapper_is_opened(self):
        self.assertEqual([p["text"] for p in transcripts.split_human("land it")], ["land it"])
        wrapped = '<pasted_content id="x">1 comment:\n\n1. Re your reply at 10:00 ("Nathan, a"): yes</pasted_content id="x">'
        self.assertEqual([p["text"] for p in transcripts.split_human(wrapped)], ["yes"])
        self.assertEqual(transcripts.split_human("   "), [])

    def test_an_attached_image_line_is_not_part_of_the_words(self):
        self.assertEqual(transcripts.split_human("look\n\nAttached image: /tmp/x.png")[0]["text"], "look")


class Anchor(unittest.TestCase):
    def setUp(self):
        self.replies = [reply("Nathan, first reply about R2: a / b", NOW - 7200, key="a:a:reply"), reply("Nathan, second reply with no key", NOW - 3600, key="b:b:reply")]

    def test_the_sheets_own_time_and_quote_pick_the_reply(self):
        hm = time.strftime("%H:%M", time.localtime(self.replies[0]["e"]))
        found = transcripts.anchor({"e": NOW, "text": "yes", "hm": hm, "quote": "Nathan, first reply"}, self.replies)
        self.assertEqual(found, (0, "sheet"))

    def test_a_call_key_it_uses_picks_the_latest_reply_that_has_it(self):
        self.assertEqual(transcripts.anchor({"e": NOW, "text": "R2=a", "hm": None}, self.replies), (0, "key R2"))

    def test_the_next_message_after_a_reply_is_adjacent_only_within_six_hours(self):
        self.assertEqual(transcripts.anchor({"e": NOW, "text": "ok", "hm": None}, self.replies), (1, "adjacent"))
        self.assertEqual(transcripts.anchor({"e": NOW + 7 * 3600, "text": "ok", "hm": None}, self.replies), (None, "none"))


class Tagger(unittest.TestCase):
    def match(self, text, tasks, **extra):
        return tagger.match_replies([{"text": text, **extra}], [{"id": t, "title": t.replace("-", " ")} if isinstance(t, str) else t for t in tasks])[0]

    def test_a_task_id_in_the_reply_is_a_sure_mention(self):
        found = self.match("Nathan, reader-fix-batch is ready to land.", ["reader-fix-batch", "conn-fix-queue"])
        self.assertEqual(found["reader-fix-batch"], {"lvl": "sure", "why": ["mention"]})
        self.assertNotIn("conn-fix-queue", found)

    def test_an_id_inside_a_longer_word_is_not_a_mention(self):
        found = self.match("Nathan, see my-reader-fix-batch-2 for that.", ["reader-fix-batch"])
        self.assertNotIn("sure", {v["lvl"] for v in found.values()})
        self.assertNotIn("mention", [w for v in found.values() for w in v["why"]])

    def test_the_id_stem_without_its_date_counts_when_long_enough(self):
        found = self.match("Nathan, the esim-dashboard-tab4-refresh is done.", ["2026-11-03-esim-dashboard-tab4-refresh"])
        self.assertEqual(list(found.values())[0]["why"], ["mention"])

    def test_a_pointer_a_wake_signal_and_a_command_are_sure(self):
        self.assertIn("pointer", self.match("Nathan, see data/alpha-task/report.md", ["alpha-task"])["alpha-task"]["why"])
        self.assertEqual(self.match("Nathan, all quiet.", ["alpha-task"], signal="alpha-task.turn-ended")["alpha-task"]["why"], ["signal"])
        self.assertEqual(self.match("Nathan, sent it.", ["alpha-task"], tools="bin/fm-send.sh alpha-task go")["alpha-task"]["why"], ["command"])
        self.assertEqual(self.match("Nathan, ok.", ["alpha-task"], trigger="FIRSTMATE SUPERVISION WAKE: signal: /h/state/alpha-task.status")["alpha-task"]["why"], ["wake"])
        many = ["t%d-alpha-task" % i for i in range(4)]
        self.assertEqual(self.match("Nathan, ok.", many, trigger=" ".join(many)), {}, "a wake-up listing many tasks is a roundup")

    def test_a_branch_a_pr_and_exactly_one_own_board_link_are_pointers(self):
        tasks = [{"id": "t1", "title": "x", "branch": "fm/t1-branch"}, {"id": "t2", "title": "y", "pr": "https://x/pull/9"}, {"id": "t3", "title": "z", "links": ["127.0.0.1:4387/session/abc"]}]
        found = self.match("Nathan, branch fm/t1-branch and https://x/pull/9 and http://127.0.0.1:4387/session/abc here", tasks)
        self.assertEqual({k: v["why"] for k, v in found.items()}, {"t1": ["pointer"], "t2": ["pointer"], "t3": ["pointer"]})
        roundup = self.match("Nathan, boards: 127.0.0.1:4387/session/abc 127.0.0.1:4387/session/def", tasks)
        self.assertNotIn("t3", roundup, "two board links make a roundup, which is not about each board's task")

    def test_a_sweep_of_more_than_three_tasks_is_weak_for_each(self):
        ids = ["task-one", "task-two", "task-three", "task-four"]
        found = self.match("Nathan, " + " ".join(ids) + " are all fine.", ids)
        self.assertEqual({v["lvl"] for v in found.values()}, {"weak"})

    def test_a_call_key_only_one_task_carries_is_weak_and_a_shared_key_is_nothing(self):
        tasks = [{"id": "alpha", "title": "q", "labels": ["R2", "R3"]}, {"id": "beta", "title": "w", "labels": ["R3"]}]
        found = self.match("Nathan, R2 is answered and R3 too.", tasks)
        self.assertEqual(found["alpha"], {"lvl": "weak", "why": ["keyed R2"]})
        self.assertNotIn("beta", found)

    def test_three_rare_id_words_make_a_possible_match_and_common_title_words_are_only_weak(self):
        found = self.match("Nathan, the shadow ledger prune finished.", [{"id": "shadow-ledger-prune-job", "title": "x"}, {"id": "other", "title": "ledger"}])
        self.assertEqual(found["shadow-ledger-prune-job"]["lvl"], "possible")
        self.assertEqual(found["other"]["lvl"], "weak", "one shared title word is weak")

    def test_best_level_sure_count_and_upkeep(self):
        self.assertEqual(tagger.best_level({}), "none")
        self.assertEqual(tagger.best_level({"a": {"lvl": "weak"}, "b": {"lvl": "possible"}}), "possible")
        self.assertEqual(tagger.sure_count({"a": {"lvl": "sure"}, "b": {"lvl": "weak"}}), 1)
        self.assertTrue(tagger.is_upkeep("Nathan, shipshape."))
        self.assertTrue(tagger.is_upkeep("Nathan, the wake-up came and I acknowledged it. " + "x" * 200))
        self.assertFalse(tagger.is_upkeep("Nathan, " + "the board needs your call on the layout. " * 6))


class Marks(HomeCase):
    def test_the_last_line_per_turn_wins_clear_removes_and_bad_lines_are_skipped(self):
        self.write("data/alpha/reply-marks.jsonl", "\n".join([
            json.dumps({"turn": "a:b:reply", "mark": "in", "at": 1, "by": "card"}), "not json",
            json.dumps({"turn": "a:b:reply", "mark": "out", "at": 2, "by": "card"}),
            json.dumps({"turn": "c:d:in", "mark": "in", "at": 3, "by": "reader"}),
            json.dumps({"turn": "c:d:in", "mark": "clear", "at": 4, "by": "reader"}),
            json.dumps({"turn": "bad turn!", "mark": "in", "at": 5}), json.dumps({"turn": "e:f:reply", "mark": "maybe"}), json.dumps([1])]) + "\n")
        self.assertEqual(marks.read(self.home, "alpha"), {"a:b:reply": "out"})

    def test_a_missing_file_or_an_odd_task_id_is_no_marks(self):
        self.assertEqual(marks.read(self.home, "alpha"), {})
        self.assertEqual(marks.read(self.home, "../alpha"), {})

    def test_write_runs_the_home_s_own_command_with_that_home_and_parses_its_line(self):
        root = self.tmp / "fm"
        (root / "bin").mkdir(parents=True)
        (root / "bin" / "fm-reply-mark.sh").write_text("#!/bin/sh\n")
        seen = {}

        def runner(argv, env, timeout):
            seen.update(argv=argv, env=env)
            return type("R", (), {"returncode": 0, "stdout": '{"turn":"a:b:reply","mark":"in","at":5,"by":"card"}\n', "stderr": ""})()

        line = marks.write(root, self.home, "alpha", "a:b:reply", "in", "card", runner=runner)
        self.assertEqual(line["mark"], "in")
        self.assertEqual(seen["argv"][1:], ["alpha", "in", "a:b:reply", "--source", "card"])
        self.assertEqual(seen["env"]["FM_HOME"], str(self.home))
        self.assertNotIn("FM_ROOT", seen["env"])

    def test_write_refuses_bad_input_before_running_and_reports_the_commands_own_refusal(self):
        root = self.tmp / "fm"
        (root / "bin").mkdir(parents=True)
        (root / "bin" / "fm-reply-mark.sh").write_text("#!/bin/sh\n")
        boom = lambda *a: self.fail("must not run")  # noqa: E731
        for task, turn, mark in (("../x", "a:b:reply", "in"), ("alpha", "has space", "in"), ("alpha", "a:b:reply", "maybe")):
            with self.assertRaises(marks.MarkError):
                marks.write(root, self.home, task, turn, mark, runner=boom)
        refuse = lambda a, e, t: type("R", (), {"returncode": 1, "stdout": "", "stderr": "fm-reply-mark: no task alpha in this home's backlog\n"})()  # noqa: E731
        with self.assertRaises(marks.MarkError) as caught:
            marks.write(root, self.home, "alpha", "a:b:reply", "in", runner=refuse)
        self.assertEqual(caught.exception.status, 409)
        self.assertIn("no task alpha", str(caught.exception))
        with self.assertRaises(marks.MarkError) as missing:
            marks.write(self.tmp / "nowhere", self.home, "alpha", "a:b:reply", "in", runner=refuse)
        self.assertEqual(missing.exception.status, 501)

    def test_the_real_command_files_one_line_in_a_scratch_home(self):
        root = homes.find_fm_root()
        if root is None or not (root / "bin" / "fm-reply-mark.sh").is_file():
            self.skipTest("no Firstmate checkout with fm-reply-mark.sh is installed")
        self.write("data/backlog.md", "## In flight\n- [ ] alpha - Do alpha (repo: proj) (kind: ship) (since 2026-11-06)\n\n## Done\n")
        line = marks.write(root, self.home, "alpha", "abcd1234:ef567890:reply", "out", "card")
        self.assertEqual((line["turn"], line["mark"], line["by"]), ("abcd1234:ef567890:reply", "out", "card"))
        self.assertEqual(marks.read(self.home, "alpha"), {"abcd1234:ef567890:reply": "out"})
        with self.assertRaises(marks.MarkError):
            marks.write(root, self.home, "no-such-task", "abcd1234:ef567890:reply", "in", "card")


class ThreadBuild(HomeCase):
    """threads.build over transcripts made by hand (the store-backed ones are below)."""

    def transcript(self, replies, humans=()):
        return transcripts.Transcript(replies=sorted(replies, key=lambda r: r["e"]), humans=list(humans), sessions=[{"id": "s", "replies": len(replies)}], asof=NOW)

    def build(self, items, tr, **kw):
        return threads.build(self.session, items, tr, NOW, **kw)

    LONG = " This reply is long enough to count as more than a one-liner for the card."

    def test_a_reply_that_names_the_task_is_on_its_card_with_your_answer_attached(self):
        r1 = reply("Nathan, reader-fix-batch is ready." + self.LONG, NOW - 5000, key="s:r1:reply")
        answer = human("land it", NOW - 4000, key="s:h1:in")
        data = self.build([item("reader-fix-batch"), item("other-task")], self.transcript([r1], [answer]))
        card = data["tasks"]["reader-fix-batch"]
        self.assertEqual([(e["k"], e["key"]) for e in card["thread"]], [("reply", "s:r1:reply"), ("nathan", "s:h1:in")])
        self.assertEqual((card["thread_n"], card["thread_you"]), (1, 1))
        self.assertEqual(data["tasks"]["other-task"]["thread"], [])
        self.assertEqual(card["thread"][0]["link"], {"s": "s", "m": "r1"})

    def test_a_one_liner_never_reaches_a_card_and_lands_in_fleet_upkeep(self):
        data = self.build([item("alpha")], self.transcript([reply("Nathan, alpha: shipshape.", NOW - 100)]))
        self.assertEqual(data["tasks"]["alpha"]["thread"], [])
        self.assertEqual((data["upkeep"]["n"], data["notask"]["n"]), (1, 0))

    def test_a_reply_about_nothing_is_a_no_task_row_and_the_rows_list_the_newest_first(self):
        text = "Nathan, the question of colour is open for you. " * 6
        data = self.build([item("alpha")], self.transcript([reply(text, NOW - 300, key="s:a:reply"), reply(text + "again", NOW - 100, key="s:b:reply")]))
        self.assertEqual(data["notask"]["n"], 2)
        self.assertEqual([i["key"] for i in data["notask"]["items"]], ["s:b:reply", "s:a:reply"])

    def test_your_in_mark_puts_a_reply_on_a_card_and_removes_it_from_no_task(self):
        text = "Nathan, the question of colour is open for you. " * 6
        self.write("data/alpha/reply-marks.jsonl", json.dumps({"turn": "s:a:reply", "mark": "in", "at": 1, "by": "card"}) + "\n")
        data = self.build([item("alpha")], self.transcript([reply(text, NOW - 300, key="s:a:reply")]))
        entry = data["tasks"]["alpha"]["thread"][0]
        self.assertEqual((entry["lvl"], entry["why"]), ("marked", ["you marked it"]))
        self.assertEqual(data["notask"]["n"], 0)

    def test_your_out_mark_takes_a_matched_reply_off_but_keeps_it_struck_through_so_it_can_be_put_back(self):
        r = reply("Nathan, reader-fix-batch is ready." + self.LONG, NOW - 300, key="s:a:reply")
        self.write("data/reader-fix-batch/reply-marks.jsonl", json.dumps({"turn": "s:a:reply", "mark": "out", "at": 1, "by": "card"}) + "\n")
        data = self.build([item("reader-fix-batch")], self.transcript([r]))
        card = data["tasks"]["reader-fix-batch"]
        self.assertEqual([e["lvl"] for e in card["thread"]], ["out"])
        self.assertEqual(card["thread_n"], 0, "an out reply is not counted")
        self.assertEqual(data["upkeep"]["n"] + data["notask"]["n"], 1, "and it reaches no card, so it is in one of the two rows")
        self.assertEqual(data["tasks"]["reader-fix-batch"]["marks"], {"s:a:reply": "out"})

    def test_a_marked_message_of_yours_joins_the_card_and_an_out_one_leaves(self):
        r = reply("Nathan, reader-fix-batch is ready." + self.LONG, NOW - 900, key="s:a:reply")
        stray = human("this is about the batch", NOW - 5 * 86400, key="s:h:in")
        out = human("yes", NOW - 800, key="s:o:in")
        self.write("data/reader-fix-batch/reply-marks.jsonl", "\n".join(json.dumps({"turn": t, "mark": m, "at": 1, "by": "card"}) for t, m in (("s:h:in", "in"), ("s:o:in", "out"))) + "\n")
        data = self.build([item("reader-fix-batch")], self.transcript([r], [stray, out]))
        keys = [e["key"] for e in data["tasks"]["reader-fix-batch"]["thread"]]
        self.assertIn("s:h:in", keys)
        self.assertNotIn("s:o:in", keys)

    def test_a_request_with_no_reply_above_it_links_to_the_task_that_started_just_after(self):
        req = human("please extract the requirements for the dashboard", NOW - 3000, key="s:q:in")
        items = [item("started-after", started_at=NOW - 3000 + 600), item("started-long-before", started_at=NOW - 90000)]
        data = self.build(items, self.transcript([], [req]))
        entry = data["tasks"]["started-after"]["thread"][0]
        self.assertEqual((entry["req"], entry["mins"], entry["how"]), (True, 10, "request, linked by time"))
        self.assertEqual(data["tasks"]["started-long-before"]["thread"], [])
        self.assertEqual(data["stats"]["requests"], {"total": 1, "linked": 1})

    def test_a_short_message_is_not_a_request(self):
        data = self.build([item("a", started_at=NOW - 1000)], self.transcript([], [human("ok", NOW - 1100)]))
        self.assertEqual(data["stats"]["requests"]["total"], 0)

    def test_a_card_keeps_its_newest_items_and_says_how_many_replies_it_cut(self):
        replies = [reply(f"Nathan, reader-fix-batch step {i}." + self.LONG, NOW - 100000 + i * 100, key=f"s:{i}:reply") for i in range(threads.THREAD_KEEP + 6)]
        card = self.build([item("reader-fix-batch")], self.transcript(replies))["tasks"]["reader-fix-batch"]
        self.assertEqual(card["thread_n"], threads.THREAD_KEEP + 6)
        self.assertEqual(len(card["thread"]), threads.THREAD_KEEP)
        self.assertEqual(card["thread_cut"], 6)
        self.assertEqual(card["thread"][-1]["key"], f"s:{threads.THREAD_KEEP + 5}:reply")

    def test_a_roundup_reply_carries_how_many_tasks_it_names(self):
        ids = ["task-one", "task-two", "task-three"]
        data = self.build([item(i) for i in ids], self.transcript([reply("Nathan, " + ", ".join(ids) + " all have news." + self.LONG, NOW - 50)]))
        self.assertEqual({data["tasks"][i]["thread"][0]["n"] for i in ids}, {3})
        self.assertEqual(data["stats"]["roundups"], 1)

    def test_a_worker_boards_own_session_puts_every_reply_on_its_own_card(self):
        r = reply("Nathan, here is lesson one for you to read, no id named." + self.LONG, NOW - 50, key="s:a:reply")
        data = self.build([item("ai-buddy-teaching"), item("other")], self.transcript([r]), own_ref="ai-buddy-teaching")
        self.assertEqual(data["tasks"]["ai-buddy-teaching"]["thread"][0]["why"], ["this worker's own session"])
        self.assertEqual(data["tasks"]["other"]["thread"], [])


class ReplyText(HomeCase):
    """The text a card draws a reply from: a preview of whole blocks (the reader's own renderer draws it), the full text on request."""

    def test_a_short_reply_is_shown_whole_and_a_long_one_stops_at_a_block_after_90_words(self):
        short = "Nathan, a short reply.\n\n- one\n- two"
        self.assertEqual(threads.preview(short), (short, False))
        para = lambda n: " ".join(f"w{n}x{i}" for i in range(40))  # noqa: E731
        long = "\n\n".join(para(n) for n in range(6))
        md, more = threads.preview(long)
        self.assertTrue(more)
        self.assertEqual(md, "\n\n".join(para(n) for n in range(3)))  # 40 + 40 + 40 words: the block that crosses 90 is the last one shown
        self.assertEqual(threads.word_count(long), 240)

    def test_a_fenced_code_box_is_never_cut_in_half_and_a_cut_one_is_closed(self):
        code = "```sh\n" + "\n".join(f"echo {i}" for i in range(400)) + "\n```"
        md, more = threads.preview("Intro " + "word " * 100 + "\n\n" + code)
        self.assertTrue(more)
        self.assertEqual(md.count("```") % 2, 0)
        self.assertLessEqual(len(md), threads.PREVIEW_CHARS + 8)
        text = "Start of a reply " + "word " * 100 + "\n\n```\n" + "x\n" * 2000 + "```"
        cut, _ = threads.preview(text)
        self.assertEqual(cut.count("```") % 2, 0)

    def test_the_board_carries_each_shown_reply_once_with_its_words_and_whether_more_follows(self):
        long = "Nathan, reader-fix-batch is ready.\n\n" + "\n\n".join(" ".join(["more"] * 50) for _ in range(5))
        r1 = reply(long, NOW - 5000, key="s:r1:reply")
        tr = transcripts.Transcript(replies=[r1], humans=[], sessions=[{"id": "s", "replies": 1, "last": NOW - 5000}], asof=NOW)
        data = threads.build(self.session, [item("reader-fix-batch"), item("other-task")], tr, NOW)
        self.assertEqual(list(data["texts"]), ["s:r1:reply"])
        got = data["texts"]["s:r1:reply"]
        self.assertEqual((got["more"], got["words"] > 90), (True, True))
        self.assertTrue(got["md"].startswith("Nathan, reader-fix-batch is ready."))
        self.assertEqual(data["session_list"], [{"id": "s", "replies": 1, "last": NOW - 5000}])


class AskedReply(HomeCase):
    LONG = " That reply is long enough to count as a real one."

    def setUp(self):
        super().setUp()
        self.replies = [reply("Nathan, an unrelated update." + self.LONG, NOW - 9000, key="s:old:reply"),
                        reply("Nathan, here are three calls for alpha-task: R1 to R3." + self.LONG, NOW - 3000, key="s:ask:reply"),
                        reply("Nathan, an unrelated update afterwards." + self.LONG, NOW - 2900, key="s:late:reply")]
        self.matches = tagger.match_replies(self.replies, [{"id": "alpha-task", "title": "x"}])
        self.member = lambda i, ref: self.matches[i].get(ref)

    def asked(self, call):
        return threads.asked_reply(self.replies, self.matches, "alpha-task", call, self.member)

    def test_a_hold_is_linked_to_the_task_matched_reply_in_the_same_turn(self):
        found = self.asked({"id": "R1", "src": "hold", "at": NOW - 3000 + 30})
        self.assertEqual((found["key"], found["how"]), ("s:ask:reply", "task"))

    def test_with_no_task_matched_reply_the_nearest_one_in_the_window_is_used_and_says_so(self):
        found = threads.asked_reply(self.replies, self.matches, "alpha-task", {"id": "R1", "src": "hold", "at": NOW - 2900 - 60}, lambda i, ref: None)
        self.assertEqual(found["how"], "nearest")

    def test_a_typed_ask_is_found_by_its_id_in_the_reply_that_announced_it(self):
        self.replies[2]["text"] += " ask: ask-20261107T000000Z-abcd"
        found = self.asked({"id": "Z1", "src": "ask", "at": NOW - 90000, "ask": {"id": "ask-20261107T000000Z-abcd"}})
        self.assertEqual((found["key"], found["how"]), ("s:late:reply", "exact"))

    def test_a_workers_own_question_links_only_to_a_task_matched_reply_within_six_hours(self):
        self.assertEqual(self.asked({"id": "k", "src": "status", "at": NOW - 3500})["key"], "s:ask:reply")
        self.assertIsNone(self.asked({"id": "k", "src": "status", "at": NOW - 3600 * 9}))
        self.assertIsNone(threads.asked_reply(self.replies, self.matches, "alpha-task", {"id": "k", "src": "status", "at": NOW - 3500}, lambda i, ref: None))

    def test_a_call_with_no_time_has_no_asking_reply(self):
        self.assertIsNone(self.asked({"id": "R1", "src": "hold", "at": None}))


class StoreBacked(HomeCase):
    """The transcript read from a real (lab) store through the versioned views, and a board built on it."""

    BIG = " Here is more than enough text to count as a real reply for a card."

    def setUp(self):
        super().setUp()
        self.lab = Lab()
        self.addCleanup(self.lab.close)

    def read(self, cwds=(CWD,), **kw):
        conn = transcripts.open_store(self.lab.db_path)
        self.addCleanup(conn.close)
        return transcripts.load(conn, list(cwds), days=3650, now=T0 + 10 * 86400, **kw)

    def supervisor(self, cwd=CWD, extra_turns=()):
        return self.lab.session(cwd, [
            ("go on with the plan", "Nathan, the alpha-report scout is finished and ready for you to read." + self.BIG, "bin/fm-send.sh alpha-report hello"),
            ("status?", "Nathan, shipshape."),
            ('Re your reply at 10:00 ("Nathan, the alpha-report"): a', "Nathan, recorded; beta-build goes ahead." + self.BIG), *extra_turns])

    def test_a_missing_store_and_an_unknown_schema_are_plain_sentences(self):
        with self.assertRaises(transcripts.StoreUnavailable) as caught:
            transcripts.open_store(self.tmp / "nowhere.sqlite")
        self.assertIn("not there yet", str(caught.exception))
        odd = self.tmp / "odd.sqlite"
        conn = sqlite3.connect(odd)
        conn.execute("PRAGMA user_version = 9")
        conn.close()
        with self.assertRaises(transcripts.StoreUnavailable) as caught:
            transcripts.open_store(odd)
        self.assertIn("schema version 9", str(caught.exception))

    def test_the_store_is_opened_read_only(self):
        self.supervisor()
        self.lab.ingest()
        conn = transcripts.open_store(self.lab.db_path)
        self.addCleanup(conn.close)
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("CREATE TABLE intruder (x)")
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("DELETE FROM sessions")

    def test_the_supervisor_session_is_found_by_its_working_folder_and_nothing_else_is(self):
        sid = self.supervisor()
        self.lab.session(CWD, [("FIRSTMATE_OP v1 launch-brief: do the thing", "Nathan, working on it" + self.BIG)] * 3)  # a worker's brief in the same folder
        self.lab.session("/lab/homes/other", [("hi", "Nathan, hello" + self.BIG)] * 4)  # another folder
        self.lab.ingest()
        tr = self.read()
        self.assertEqual([s["id"] for s in tr.sessions], [sid])
        self.assertEqual(len(tr.replies), 3)
        self.assertTrue(all(r["key"].startswith(sid[:8] + ":") and r["key"].endswith(":reply") for r in tr.replies))
        self.assertIsNone(tr.asof, "a lab store has no ingest heartbeat, which is not an error")

    def test_the_whole_text_of_one_reply_comes_from_the_store_only_for_the_boards_own_folders(self):
        self.supervisor()
        self.lab.ingest()
        tr = self.read()
        first = tr.replies[0]
        conn = transcripts.open_store(self.lab.db_path)
        self.addCleanup(conn.close)
        self.assertIn("alpha-report scout is finished", transcripts.fetch_reply(conn, [CWD], first["sid"], first["uid"]))
        self.assertIsNone(transcripts.fetch_reply(conn, ["/somewhere/else"], first["sid"], first["uid"]))
        self.assertIsNone(transcripts.fetch_reply(conn, [CWD], first["sid"], "no-such-turn"))
        self.assertIsNone(transcripts.fetch_reply(conn, [], first["sid"], first["uid"]))
        self.assertTrue(all(s["last"] for s in tr.sessions))

    def test_a_short_session_is_not_a_supervisor_but_a_worker_you_drive_is_read_whole(self):
        self.lab.session(CWD, [("hi", "Nathan, one" + self.BIG), ("hi", "Nathan, two" + self.BIG)])
        self.lab.ingest()
        self.assertEqual(self.read().replies, [])
        both = self.read(addressed_only=False)
        self.assertEqual(len(both.replies), 2)

    def test_your_messages_are_split_anchored_and_never_include_wake_ups(self):
        self.supervisor(extra_turns=[("<task-notification>\nfirstmate watcher wake\n</task-notification>", "Nathan, noted." + self.BIG)])
        self.lab.ingest()
        tr = self.read()
        texts = [h["text"] for h in tr.humans]
        self.assertIn("go on with the plan", texts)
        self.assertIn("a", texts)
        self.assertFalse(any("watcher wake" in t for t in texts))
        self.assertTrue(all(h["key"].endswith(":in") for h in tr.humans))

    def test_tool_text_comes_from_a_temp_view_that_writes_nothing_to_the_store(self):
        self.supervisor()
        self.lab.ingest()
        self.lab.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        before = self.lab.db_path.read_bytes()
        tr = self.read()
        first = next(r for r in tr.replies if "alpha-report" in r["text"])
        self.assertIn("fm-send.sh alpha-report", first["tools"])
        found = tagger.match_replies([first], [{"id": "alpha-report", "title": "x"}])[0]
        self.assertIn("command", found["alpha-report"]["why"])
        self.lab.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.assertEqual(self.lab.db_path.read_bytes(), before, "the store file is byte for byte as it was")
        fresh = sqlite3.connect(self.lab.db_path)
        self.addCleanup(fresh.close)
        self.assertIsNone(fresh.execute("SELECT name FROM sqlite_master WHERE name = 'v1_turn_tools'").fetchone(), "the view was never made in the store")

    def test_tool_text_can_be_turned_off_and_a_store_view_wins_when_it_has_one(self):
        self.supervisor()
        self.lab.ingest()
        import os
        os.environ["PMOS_READER_BOARD_TOOL_TEXT"] = "0"
        self.addCleanup(os.environ.pop, "PMOS_READER_BOARD_TOOL_TEXT", None)
        self.assertEqual({r["tools"] for r in self.read().replies}, {""}, "off: no tool text, and no error")
        self.lab.conn.executescript("CREATE VIEW v1_turn_tools AS SELECT session_id, idx, 'from the store: alpha-report' AS text FROM turns;")
        self.assertEqual({r["tools"] for r in self.read().replies}, {"from the store: alpha-report"}, "a view the store offers is used as it is, even with the temp one off")

    def test_a_store_whose_tables_differ_loses_the_signal_and_nothing_else(self):
        self.supervisor()
        self.lab.ingest()
        self.lab.conn.execute("ALTER TABLE tool_calls RENAME TO tool_calls_v2")
        tr = self.read()
        self.assertEqual({r["tools"] for r in tr.replies}, {""})
        self.assertEqual(len(tr.replies), 3)

    def test_a_board_built_on_the_store_has_threads_and_a_missing_store_leaves_the_cards(self):
        self.supervisor()
        self.lab.ingest()
        snap = snapshot([record("alpha-report", title="Alpha report", kind="scout"), record("beta-build", title="Beta build")])

        def source(session, items, now):
            conn = transcripts.open_store(self.lab.db_path)
            try:
                return threads.build(session, items, transcripts.load(conn, [CWD], days=3650, now=T0 + 10 * 86400), now)
            finally:
                conn.close()

        self.session.cwds = [CWD]
        board = build_board(self.session, FakeCollector(snap), now=T0 + 10 * 86400, threads=source)
        self.assertEqual(board["threads"]["status"], "ok")
        alpha = next(i for i in board["items"] if i["ref"] == "alpha-report")
        self.assertEqual(alpha["thread_n"], 1)
        self.assertIn("mention", alpha["thread"][0]["why"])
        beta = next(i for i in board["items"] if i["ref"] == "beta-build")
        self.assertEqual(beta["thread_n"], 1)

        def gone(session, items, now):
            raise transcripts.StoreUnavailable("the reader store is not there yet, so cards have no reply threads")

        quiet = build_board(self.session, FakeCollector(snap), now=NOW, threads=gone)
        self.assertEqual((quiet["threads"]["status"], len(quiet["items"])), ("unavailable", 2))
        self.assertEqual(quiet["items"][0]["thread"], [])
        self.assertEqual(quiet["source"]["errors"], [])

        def broken(session, items, now):
            raise ValueError("x")

        bad = build_board(self.session, FakeCollector(snap), now=NOW, threads=broken)
        self.assertEqual(bad["threads"]["status"], "error")
        self.assertEqual(len(bad["items"]), 2)
        self.assertEqual(len(bad["source"]["errors"]), 1)
        off = build_board(self.session, FakeCollector(snap), now=NOW)
        self.assertEqual(off["threads"]["status"], "off")


class Workers(HomeCase):
    def setUp(self):
        super().setUp()
        self.conf = self.tmp / "conf"
        self.conf.mkdir()
        import os
        os.environ["PMOS_READER_BOARD_WORKERS"] = str(self.conf / "board-workers.json")
        self.addCleanup(os.environ.pop, "PMOS_READER_BOARD_WORKERS", None)
        self.registry = homes.Registry(None, [self.session])
        self.snap = snapshot([record("teaching", kind="scout"), held("teaching-decision-q1", "R1 pick: a yes / b no", body_lines=["Captain hold origin: teaching"]), record("other")],
                             [task_row("teaching", driver={"since": 1794000000, "by": "leader", "typed_at": None}, paths={"status_log": {"last_event": None}, "worktree": {"path": "/lab/wt/teaching"}}),
                              task_row("other")])

    def test_a_board_build_remembers_which_tasks_you_drive(self):
        build_board(self.session, FakeCollector(self.snap), now=NOW)
        self.assertEqual(workers.known_drivers("leader-test"), [{"task": "teaching", "kind": "ship", "worktree": "/lab/wt/teaching", "since": 1794000000}])

    def test_a_driven_worker_is_on_until_you_switch_it_off_and_its_session_reads_the_worktree(self):
        build_board(self.session, FakeCollector(self.snap), now=NOW)
        (found, on), = workers.worker_sessions(self.registry)
        self.assertTrue(on)
        self.assertEqual((found.id, found.kind, found.parent, found.task, found.transcript_cwds()), ("worker-teaching", "worker", "leader-test", "teaching", ["/lab/wt/teaching"]))
        self.assertEqual(found.home, self.session.home)
        workers.set_switch(self.registry, "leader-test", "teaching", False)
        self.assertEqual(workers.worker_sessions(self.registry), [])
        (off, flag), = workers.worker_sessions(self.registry, include_off=True)
        self.assertFalse(flag)
        workers.set_switch(self.registry, "leader-test", "teaching", True)
        self.assertEqual(len(workers.worker_sessions(self.registry)), 1)

    def test_only_a_worker_a_leader_saw_you_driving_can_be_switched(self):
        with self.assertRaises(ValueError):
            workers.set_switch(self.registry, "leader-test", "teaching", True)
        build_board(self.session, FakeCollector(self.snap), now=NOW)
        for leader, task in (("nobody", "teaching"), ("leader-test", "other"), ("../x", "teaching"), ("leader-test", "../x")):
            with self.assertRaises(ValueError):
                workers.set_switch(self.registry, leader, task, False)

    def test_a_worker_board_holds_what_that_worker_raised_and_inherits_the_leaders_lifecycle(self):
        build_board(self.session, FakeCollector(self.snap), now=NOW)
        worker = workers.worker_sessions(self.registry)[0][0]
        board = build_board(worker, FakeCollector(self.snap), now=NOW)
        self.assertEqual({i["ref"] for i in board["items"]}, {"teaching", "teaching-decision-q1"})
        self.assertEqual(board["lifecycle"]["id"], build_board(self.session, FakeCollector(self.snap), now=NOW)["lifecycle"]["id"])
        self.assertEqual(board["session"]["kind"], "worker")

    def test_related_takes_the_task_the_origin_and_what_it_blocks(self):
        self.assertTrue(workers.related({"ref": "w"}, "w"))
        self.assertTrue(workers.related({"ref": "x", "origin": "w"}, "w"))
        self.assertTrue(workers.related({"ref": "x", "blocked_by": ["w"]}, "w"))
        self.assertFalse(workers.related({"ref": "x", "origin": "z"}, "w"))

    def test_a_broken_switch_file_is_no_switches_and_a_failed_cache_write_is_not_an_error(self):
        (self.conf / "board-workers.json").write_text("{nope")
        self.assertEqual(workers.read_switches(), {})
        (self.conf / "board-workers.json").write_text(json.dumps({"on": {"a/b": "yes", "c/d": False}}))
        self.assertEqual(workers.read_switches(), {"c/d": False})


class Config(HomeCase):
    def test_sessions_can_name_their_transcript_folders_and_the_config_can_name_the_store(self):
        conf = self.tmp / "board.json"
        conf.write_text(json.dumps({"store": str(self.tmp / "store"), "sessions": [{"id": "leader-x", "home": str(self.home), "cwds": ["/a/b", "/c"]}, {"id": "leader-y", "home": str(self.home)}]}))
        registry = homes.load(conf)
        self.assertIsNone(registry.error)
        self.assertEqual(registry.store, self.tmp / "store")
        self.assertEqual(registry.get("leader-x").transcript_cwds(), ["/a/b", "/c"])
        self.assertEqual(registry.get("leader-y").transcript_cwds(), [str(self.home)])
        conf.write_text(json.dumps({"sessions": [{"id": "leader-x", "home": str(self.home), "cwds": "nope"}]}))
        self.assertIn("cwds", homes.load(conf).error)

    def test_the_default_big_boss_reads_the_main_home_and_the_pmos_checkout(self):
        big = homes.default_sessions()[0]
        self.assertEqual(big.id, "big-boss")
        self.assertEqual(big.transcript_cwds(), [str(homes.main_home()), str(Path.home() / "workspace" / "pmos")])


class LegacyChip(HomeCase):
    def test_a_legacy_draft_branch_exists_only_where_the_lifecycle_has_that_column(self):
        self.git_project(branches={"fm/old-draft": 2})
        snap = snapshot([record("old-draft", repo="proj")], [task_row("old-draft", branch="fm/old-draft", project=str(self.home / "projects" / "proj"))])
        software = self.board(snap)
        self.assertFalse(self.item(software, "old-draft")["legacy"], "software work: an unlanded branch is just a branch")
        self.assertNotIn("legacy_branch", self.item(software, "old-draft")["flags"])
        pm = self.board(snap, session=homes.Session("leader-pm", "PM", self.home, "pm"))
        self.assertTrue(self.item(pm, "old-draft")["legacy"])
        self.assertEqual(self.item(pm, "old-draft")["col"], "legacy")


if __name__ == "__main__":
    unittest.main()
