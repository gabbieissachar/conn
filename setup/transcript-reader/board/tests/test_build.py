import json
import unittest

from base import NOW, HomeCase, held, record, snapshot, task_row
from board import homes

AT = int(NOW) - 3600  # an hour before "now"


def line(state, text, at=AT, extra=""):
    return f"{state} {extra}[at={at}]: {text}"


class Stages(HomeCase):
    def test_a_live_captain_hold_is_needs_you_with_its_calls_split(self):
        b = self.board(snapshot([held("call-a", "Head line. R1 pick the layout: a grid (recommended) / b list. R2 name the file and say why it matters.")]))
        item = self.item(b, "call-a")
        self.assertEqual((item["col"], item["stage"], item["held"]), ("needs", "needs", True))
        self.assertEqual([c["id"] for c in item["calls"]], ["R1", "R2"])
        self.assertEqual(item["calls"][0]["opts"][0], {"k": "a", "t": "grid", "rec": True})
        self.assertEqual(item["head"], "Head line.")
        self.assertEqual(item["calls"][0]["src"], "hold")

    def test_a_dated_hold_is_parked_with_its_date(self):
        b = self.board(snapshot([held("later", "Revisit this.", bucket="dated", hold_until="2026-11-20")]))
        item = self.item(b, "later")
        self.assertEqual((item["col"], item["until"], item["held"]), ("parked", "2026-11-20", False))

    def test_a_blocked_hold_waits_in_queued_with_its_blockers(self):
        b = self.board(snapshot([held("wait", "Ask later.", bucket="blocked", unresolved_blocker_ids=["other-task"])]))
        item = self.item(b, "wait")
        self.assertEqual((item["col"], item["blocked_by"], item["flags"]), ("queued", ["other-task"], ["blocked"]))
        self.assertEqual(item["calls"], [])

    def test_an_old_hold_still_needs_you_and_says_it_is_old(self):
        b = self.board(snapshot([held("old", "An old question that nobody answered, so it keeps waiting here.", bucket="aged")]))
        item = self.item(b, "old")
        self.assertEqual((item["col"], item["flags"]), ("needs", ["aged_hold"]))

    def test_a_go_gate_waits_in_queued_labelled(self):
        b = self.board(snapshot([held("gate", "Dispatch on Nathan's word.")]))
        item = self.item(b, "gate")
        self.assertEqual((item["col"], item["stage"], item["flags"], item["calls"][0]["type"]), ("queued", "needs", ["go_gate"], "go"))

    def test_queued_and_running_and_done(self):
        recs = [record("q", state="queued"), record("r"), record("d1", state="done", done="2026-11-06"), record("d2", state="done", done="2026-10-01")]
        b = self.board(snapshot(recs))
        self.assertEqual({i["ref"]: i["col"] for i in b["items"]}, {"q": "queued", "r": "running", "d1": "done"})
        self.assertEqual(self.item(b, "d1")["done_date"], "2026-11-06")

    def test_optional_columns_show_only_while_they_hold_a_card(self):
        b = self.board(snapshot([record("r")]))
        self.assertEqual([c["id"] for c in b["columns"]], ["needs", "ready", "running", "queued", "done"])
        b = self.board(snapshot([held("later", "Revisit this.", bucket="dated", hold_until="2026-11-20")]))
        self.assertIn("parked", [c["id"] for c in b["columns"]])
        self.assertEqual({c["id"]: c["count"] for c in b["columns"]}["parked"], 1)

    def test_a_record_the_snapshot_could_not_structure_is_left_out(self):
        b = self.board(snapshot([record("ok"), record("raw", structured=False), record("../bad")]))
        self.assertEqual([i["ref"] for i in b["items"]], ["ok"])


class Calls(HomeCase):
    def card(self, **over):
        card = {"key": "Z1", "question": "Keep it or drop it?", "options": [{"value": "keep", "note": "", "recommended": True}, {"value": "drop", "note": "cheaper", "recommended": False}],
                "recommended": "keep", "gate": {"task": "gated", "mode": "done", "identity": "x"}, "state": "open"}
        card.update(over)
        return card

    def ask(self, *cards):
        return {"schema": "fm-ask.v1", "id": "ask-20261107T050000Z-ab12", "created_at": "2026-11-07T05:00:00Z", "title": "A group", "kind": "decision", "state": "open",
                "cards": list(cards), "origin": {"task": "gated", "report": "data/gated/report.md"}}

    def test_a_typed_card_gated_on_the_task_replaces_its_hold_prose(self):
        b = self.board(snapshot([held("gated", "R1 the prose version of a question that is long enough. R2 and a second one that is also long enough.")]), asks=[self.ask(self.card())])
        calls = self.item(b, "gated")["calls"]
        self.assertEqual(len(calls), 1)
        self.assertEqual((calls[0]["src"], calls[0]["id"], calls[0]["type"], calls[0]["recommended"]), ("ask", "Z1", "q", "keep"))
        self.assertEqual(calls[0]["opts"][1], {"k": "b", "t": "drop", "rec": False, "note": "cheaper"})
        self.assertEqual(calls[0]["ask"]["report"], "data/gated/report.md")
        self.assertEqual(calls[0]["ask"]["id"], "ask-20261107T050000Z-ab12")

    def test_a_card_without_choices_is_free_text(self):
        b = self.board(snapshot([held("gated", "x")]), asks=[self.ask(self.card(options=[], recommended=None))])
        self.assertEqual(self.item(b, "gated")["calls"][0]["type"], "text")

    def test_answered_stale_and_other_task_cards_are_not_calls(self):
        asks = [self.ask(self.card(state="answered"), self.card(key="Z2", state="stale"), self.card(key="Z3", gate={"task": "other", "mode": "done"}), self.card(key="Z4", gate=None))]
        b = self.board(snapshot([held("gated", "A plain hold reason with only one question in it.")]), asks=asks)
        call = self.item(b, "gated")["calls"][0]
        self.assertEqual(call["src"], "hold")  # no typed card is open, so the prose stands

    def test_open_decisions_of_a_worker_are_calls(self):
        row = task_row("worker", hints={"open_decisions": [{"key": "k1", "verb": "needs-decision", "summary": "Pick a or b?"}, {"key": "k2", "verb": "blocked", "summary": "Need a login."}]})
        b = self.board(snapshot([record("worker")], [row]))
        item = self.item(b, "worker")
        self.assertEqual((item["col"], [(c["id"], c["type"], c["src"]) for c in item["calls"]]), ("needs", [("k1", "q", "status"), ("k2", "block", "status")]))

    def test_a_review_board_link_is_a_board_call(self):
        row = task_row("worker", hints={"open_decisions": [{"key": "board-review", "verb": "needs-decision", "summary": "Review it http://127.0.0.1:4387/session/abc123 (local only)"}]})
        call = self.item(self.board(snapshot([record("worker")], [row])), "worker")["calls"][0]
        self.assertEqual((call["type"], call["link"], call["q"]), ("board", "http://127.0.0.1:4387/session/abc123", "Review it"))

    def test_without_a_worker_the_status_file_is_folded_for_open_decisions(self):
        self.status("nometa", line("needs-decision", "First?", extra="[key=a] "), line("needs-decision", "Second?", extra="[key=b] "), line("resolved", "answered", extra="[key=a] "))
        item = self.item(self.board(snapshot([record("nometa")])), "nometa")
        self.assertEqual([c["id"] for c in item["calls"]], ["b"])

    def test_a_paused_line_waiting_for_the_owner_is_a_wait_call(self):
        row = task_row("w")
        self.status("w", line("paused", "waiting for Nathan to pick a date"))
        item = self.item(self.board(snapshot([record("w")], [row])), "w")
        self.assertEqual((item["col"], item["calls"][0]["src"], item["calls"][0]["type"]), ("needs", "wait", "wait"))


class Lines(HomeCase):
    def test_latest_line_report_and_idle_days(self):
        self.write("data/rep/report.md", "# Title\n\n## Short answer\n\nThe **answer** is `yes`, and here is why.\n\n## Detail\n\nmore\n")
        self.status("rep", line("working", "going", at=AT - 3 * 86400), line("paused", "report ready", at=AT - 2 * 86400))
        item = self.item(self.board(snapshot([record("rep")], [task_row("rep")])), "rep")
        self.assertEqual((item["latest"]["state"], item["idle_days"], item["report"]), ("paused", 2, "data/rep/report.md"))
        self.assertEqual(item["summary"], "The answer is yes, and here is why.")

    def test_a_report_another_file_names_counts_when_it_exists(self):
        self.write("data/other/report.md", "First paragraph here.\n")
        b = self.board(snapshot([held("call", "Question about it, see data/other/report.md for the report. And more text for the question to be long.")]))
        self.assertEqual(self.item(b, "call")["report"], "data/other/report.md")
        b = self.board(snapshot([held("call", "See data/missing/report.md for it. And more text for the question to be long.")]))
        self.assertIsNone(self.item(b, "call")["report"])

    def test_creation_time_and_start_time(self):
        rec = record("fresh", body_lines=["Created: 2026-11-07T04:00:00Z", "A note line."])
        item = self.item(self.board(snapshot([rec])), "fresh")
        self.assertEqual(item["created_at"], 1794024000)
        self.assertEqual(item["started_at"], 1794024000)
        self.assertEqual(item["note"], "A note line.")
        spawned = self.item(self.board(snapshot([record("sp")], [task_row("sp", spawn_gen="s1794030000.1.1")])), "sp")
        self.assertEqual(spawned["started_at"], 1794030000)
        self.assertIsNone(self.item(self.board(snapshot([record("none")])), "none")["created_at"])

    def test_captain_answer_text_is_kept_on_a_done_card(self):
        rec = record("closed", state="done", done="2026-11-07", body_lines=["Captain decision:", "Nathan: yes, do it"])
        self.assertEqual(self.item(self.board(snapshot([rec])), "closed")["answer"], "Nathan: yes, do it")

    def test_a_driven_worker(self):
        item = self.item(self.board(snapshot([record("d")], [task_row("d", driver={"since": 1, "by": "captain", "typed_at": None})])), "d")
        self.assertTrue(item["driven"])

    def test_projects_are_counted(self):
        b = self.board(snapshot([record("a", repo="x"), record("b", repo="x"), record("c", repo="y"), record("d", repo=None)]))
        self.assertEqual(b["projects"], [{"repo": "x", "count": 2}, {"repo": "no project", "count": 1}, {"repo": "y", "count": 1}])


class Landing(HomeCase):
    def test_a_ready_branch_is_ready_to_land_until_a_line_says_it_landed(self):
        self.status("t1", line("working", "start"), line("done", "ready in branch fm/t1 head abcdef1", at=AT))
        b = self.board(snapshot([record("t1")], [task_row("t1", branch="fm/t1")]))
        item = self.item(b, "t1")
        self.assertEqual((item["col"], item["ready"], item["head_sha"]), ("ready", True, None))
        self.status("t1", line("working", "start"), line("done", "ready in branch fm/t1"), line("note", "merged into main"))
        item = self.item(self.board(snapshot([record("t1")], [task_row("t1", branch="fm/t1")])), "t1")
        self.assertEqual((item["col"], item["merged"], item["flags"]), ("running", True, ["stale_merged"]))

    def test_a_new_working_line_withdraws_an_old_ready(self):
        self.status("t2", line("done", "ready in branch fm/t2"), line("working", "more changes"))
        self.assertFalse(self.item(self.board(snapshot([record("t2")], [task_row("t2", branch="fm/t2")])), "t2")["ready"])

    def test_the_branch_is_found_in_the_status_when_the_worker_record_has_none(self):
        self.status("t3", line("done", "ready in branch fm/t3 head 1234567"))
        item = self.item(self.board(snapshot([record("t3")])), "t3")
        self.assertEqual((item["branch"], item["head_sha"], item["col"]), ("fm/t3", "1234567", "ready"))

    def test_a_branch_already_in_main_does_not_show_as_a_draft(self):
        self.git_project(branches={"fm/merged": 0, "fm/open": 2})
        self.status("merged", line("paused", "draft ready for you"))
        self.status("open", line("paused", "draft ready for you"))
        pm = homes.Session("leader-pm", "PM", self.home, "pm")
        b = self.board(snapshot([record("merged", kind="scout"), record("open", kind="scout")], [task_row("merged", branch="fm/merged"), task_row("open", branch="fm/open")]), session=pm)
        merged, opened = self.item(b, "merged"), self.item(b, "open")
        self.assertEqual((merged["branch_state"], merged["col"], merged["legacy"], merged["flags"]), ("merged", "running", False, ["stale_merged", "branch_in_main"]))
        self.assertEqual((opened["branch_state"], opened["branch_ahead"], opened["col"], opened["legacy"], opened["flags"]), ("ahead", 2, "legacy", True, ["legacy_branch"]))
        self.assertEqual(opened["base_branch"], "main")

    def test_a_fresh_workers_empty_branch_is_not_a_merged_record(self):
        self.git_project(branches={"fm/fresh": 0})
        self.status("fresh", line("working", "starting"))
        item = self.item(self.board(snapshot([record("fresh")], [task_row("fresh", branch="fm/fresh")])), "fresh")
        self.assertEqual((item["branch_state"], item["merged"], item["flags"]), ("merged", False, ["branch_in_main"]))

    def test_a_branch_that_is_gone_is_missing_not_legacy(self):
        self.git_project(branches={})
        self.status("gone", line("paused", "draft ready"))
        pm = homes.Session("leader-pm", "PM", self.home, "pm")
        item = self.item(self.board(snapshot([record("gone")], [task_row("gone", branch="fm/gone")]), session=pm), "gone")
        self.assertEqual((item["branch_state"], item["legacy"]), ("missing", False))

    def test_no_clone_means_unknown(self):
        item = self.item(self.board(snapshot([record("x", repo="absent")], [task_row("x", branch="fm/x")])), "x")
        self.assertEqual(item["branch_state"], "unknown")

    def test_an_open_pr_goes_to_in_review_in_an_integration_home(self):
        self.status("p", line("done", "PR open https://git.example.test/g/r/-/merge_requests/7"))
        integ = homes.Session("leader-int", "Int", self.home, "integration")
        item = self.item(self.board(snapshot([record("p")], [task_row("p")]), session=integ), "p")
        self.assertEqual((item["col"], item["pr"]), ("pr", "https://git.example.test/g/r/-/merge_requests/7"))

    def test_standing_crew_in_an_integration_home(self):
        self.status("s", line("paused", "standing by, idle until the next request"))
        integ = homes.Session("leader-int", "Int", self.home, "integration")
        self.assertEqual(self.item(self.board(snapshot([record("s")], [task_row("s")]), session=integ), "s")["col"], "standing")

    def test_a_report_ready_goes_to_draft_ready_in_a_pm_home_and_only_with_the_file(self):
        self.write("data/draft/report.md", "x")
        self.status("draft", line("done", "report ready"))
        self.status("nofile", line("done", "report ready"))
        pm = homes.Session("leader-pm", "PM", self.home, "pm")
        b = self.board(snapshot([record("draft", kind="scout"), record("nofile", kind="scout")], [task_row("draft"), task_row("nofile")]), session=pm)
        self.assertEqual((self.item(b, "draft")["col"], self.item(b, "nofile")["col"]), ("review", "running"))

    def test_waiting_needs_the_on_tag_not_the_words(self):
        pm = homes.Session("leader-pm", "PM", self.home, "pm")
        self.status("tagged", line("paused", "waiting for the vendor", extra="[on=partner] "))
        self.status("words", line("paused", "waiting for the vendor"))
        b = self.board(snapshot([record("tagged"), record("words")], [task_row("tagged"), task_row("words")]), session=pm)
        self.assertEqual((self.item(b, "tagged")["col"], self.item(b, "tagged")["wait_on"]), ("waiting", "partner"))
        self.assertEqual((self.item(b, "words")["col"], self.item(b, "words")["wait_on"]), ("running", None))

    def test_a_quiet_running_record_is_flagged(self):
        self.status("quiet", line("paused", "parked", at=AT - 20 * 86400))
        item = self.item(self.board(snapshot([record("quiet")], [task_row("quiet")])), "quiet")
        self.assertEqual((item["idle_days"], item["flags"]), (20, ["quiet_14d"]))


class Failures(HomeCase):
    def test_a_snapshot_that_cannot_be_taken_gives_an_empty_board_that_says_why(self):
        b = self.board(None, snapshot_error="the fleet snapshot of leader-test failed (exit 1)")
        self.assertEqual((b["items"], b["source"]["errors"]), ([], ["the fleet snapshot of leader-test failed (exit 1)"]))
        self.assertEqual([c["id"] for c in b["columns"]], ["needs", "ready", "running", "queued", "done"])

    def test_ask_records_that_cannot_be_read_leave_the_prose_and_say_so(self):
        b = self.board(snapshot([held("call", "A plain hold reason with a single question in it.")]), asks_error="fm-captain-ask.sh is not in /x/bin")
        self.assertEqual(self.item(b, "call")["calls"][0]["src"], "hold")
        self.assertEqual(b["source"]["asks"], {"error": "fm-captain-ask.sh is not in /x/bin"})

    def test_one_bad_card_does_not_take_the_board_down(self):
        bad = record("bad")
        bad["body_lines"] = 5  # not a list
        b = self.board(snapshot([bad, record("good")]))
        self.assertEqual([i["ref"] for i in b["items"]], ["good"])
        self.assertEqual(b["source"]["skipped"], 1)

    def test_the_board_is_json_and_leaves_the_home_untouched(self):
        before = sorted(p.relative_to(self.home).as_posix() for p in self.home.rglob("*"))
        b = self.board(snapshot([held("a", "x"), record("b")]))
        json.dumps(b)
        self.assertEqual(sorted(p.relative_to(self.home).as_posix() for p in self.home.rglob("*")), before)

    def test_a_home_config_with_an_error_is_reported_on_the_board(self):
        self.write("config/task-board.json", "{oops")
        b = self.board(snapshot([record("r")]))
        self.assertIn("not valid JSON", b["config"]["error"])
        self.assertEqual(b["lifecycle"]["id"], "software")

    def test_a_home_config_changes_the_columns(self):
        self.write("config/task-board.json", json.dumps({"schema": "task-board.v1", "lifecycle": "pm"}))
        b = self.board(snapshot([record("r")]))
        self.assertEqual((b["lifecycle"]["id"], b["config"]["from"]), ("pm", "home-config"))
        self.assertEqual(self.item(b, "r")["col"], "running")


if __name__ == "__main__":
    unittest.main()
