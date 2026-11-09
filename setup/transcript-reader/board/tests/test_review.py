"""Reviewing a task on its card: each outcome goes to the one Firstmate command that owns it, a task that must not be moved is refused with its reason, and
the real scripts against a scratch home make the change the card promised. Fake commands prove argv, stdin and refusals; no test touches a real home."""

from __future__ import annotations

import subprocess
import time
import unittest

from base import HomeCase

from board import homes, review


class Done:
    def __init__(self, out="", code=0, err=""):
        self.returncode, self.stdout, self.stderr = code, out, err


def shown(state="queued", held="no", kind="", until=""):
    return Done(f"task:\n  id: alpha\n  title: Do alpha\n  state: {state}\n  blocked: no\n  held: {held}\n  hold_reason: \"{'a reason' if held == 'yes' else '-'}\"\n"
                f"  hold_kind: \"{kind or '-'}\"\n  hold_until: \"{until or '-'}\"\n  kind: ship\n")


def days(n):
    return time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))


class Fake:
    """Records every command; `current` is what `show` answers, `ran` what each other command answers."""

    def __init__(self, current=None, **answers):
        self.calls, self.current, self.answers = [], current or shown(), answers

    def __call__(self, argv, env, timeout, stdin=None):
        name = argv[0].rsplit("/", 1)[-1]
        self.calls.append({"name": name, "args": argv[1:], "env": env, "stdin": stdin})
        if name == "fm-tasks-axi.sh" and argv[1] == "show":
            return self.current
        got = self.answers.get(name + ":" + argv[1]) or self.answers.get(name)
        return (got(argv, stdin) if callable(got) else got) if got else Done("ok: done\n")

    def ran(self):
        return [c for c in self.calls if not (c["name"] == "fm-tasks-axi.sh" and c["args"][0] == "show")]


class ReviewBase(HomeCase):
    def setUp(self):
        super().setUp()
        self.root = self.tmp / "fm"
        (self.root / "bin").mkdir(parents=True)
        for name in ("fm-tasks-axi.sh", "fm-captain-hold.sh"):
            (self.root / "bin" / name).write_text("#!/bin/sh\n")

    def go(self, payload, fake):
        return review.act(self.session, self.root, payload, runner=fake)

    def refused(self, payload, fake, status=409):
        with self.assertRaises(review.ReviewError) as caught:
            self.go(payload, fake)
        self.assertEqual(caught.exception.status, status)
        self.assertEqual(fake.ran(), [], "a refused review runs no command that changes anything")
        return str(caught.exception)


class Outcomes(ReviewBase):
    def test_done_on_an_ordinary_task_goes_through_the_backlog_command_with_the_note(self):
        fake = Fake(shown("in_flight"))
        done = self.go({"task": "alpha", "action": "done", "note": "read it (twice)\nall fine"}, fake)
        self.assertEqual(fake.ran()[0]["args"], ["done", "alpha", "--note", "Closed from the board review: read it - twice all fine"])
        self.assertEqual(fake.ran()[0]["env"]["FM_HOME"], str(self.home), "run with the session's own home")
        self.assertEqual((done["recorded"], done["via"], done["after"]["state"]), (True, "fm-tasks-axi.sh done", "in_flight"))

    def test_done_on_a_task_held_for_you_closes_the_hold_with_your_words_through_the_keyed_answer_intake(self):
        fake = Fake(shown("queued", "yes", "captain"))
        done = self.go({"task": "alpha", "action": "done"}, fake)
        call = fake.ran()[0]
        self.assertEqual((call["name"], call["args"]), ("fm-captain-hold.sh", ["answers", "--any-origin", "--source", "reader-board"]))
        self.assertEqual(call["stdin"], "alpha\tClosed from the board review\tboard review\tdone\n")
        self.assertEqual(done["via"], "fm-captain-hold.sh answers (done)")

    def test_a_refused_keyed_answer_is_a_refusal_and_not_a_success(self):
        fake = Fake(shown("queued", "yes", "captain"), **{"fm-captain-hold.sh": Done("skipped: alpha not held\n")})
        with self.assertRaises(review.ReviewError) as caught:
            self.go({"task": "alpha", "action": "done"}, fake)
        self.assertEqual(caught.exception.status, 409)

    def test_queue_picks_the_command_that_matches_how_the_task_is_held(self):
        held_for_you = Fake(shown("queued", "yes", "captain"))
        self.go({"task": "alpha", "action": "queue", "note": "after the launch"}, held_for_you)
        self.assertEqual(held_for_you.ran()[0]["stdin"], "alpha\tMoved to Queued from the board review: after the launch\tboard review\trelease\n")
        held_other = Fake(shown("queued", "yes", "parked", "2026-12-01"))
        self.go({"task": "alpha", "action": "queue"}, held_other)
        self.assertEqual(held_other.ran()[0]["args"], ["unhold", "alpha"])
        for state in ("in_flight", "done"):
            reopened = Fake(shown(state))
            self.go({"task": "alpha", "action": "queue"}, reopened)
            self.assertEqual(reopened.ran()[0]["args"], ["reopen", "alpha"], state)

    def test_delay_holds_the_task_until_the_date_through_the_captain_hold_command(self):
        fake = Fake(shown("queued"))
        until = days(10)
        done = self.go({"task": "alpha", "action": "delay", "until": until, "note": "after the launch"}, fake)
        self.assertEqual((fake.ran()[0]["name"], fake.ran()[0]["args"]), ("fm-captain-hold.sh", ["hold", "alpha", "--reason", f"Delayed from the board review until {until}: after the launch", "--until", until]))
        self.assertEqual(done["via"], "fm-captain-hold.sh hold --until")

    def test_needs_you_holds_the_task_for_you(self):
        fake = Fake(shown("queued"))
        self.go({"task": "alpha", "action": "needs"}, fake)
        self.assertEqual(fake.ran()[0]["args"], ["hold", "alpha", "--reason", "Put back in Needs you from the board review"])

    def test_a_follow_up_is_a_new_queued_task_with_its_due_date_and_the_projects_repo(self):
        fake = Fake(**{"fm-tasks-axi.sh:add": Done("ok: added check-the-notes-ab (task, repo proj) -> Queued\n")})
        due = days(5)
        done = self.go({"task": "alpha", "action": "followup", "title": "Check the (migration) notes", "due": due, "note": "ask Sam", "facts": {"repo": "proj"}}, fake)
        args = fake.ran()[0]["args"]
        self.assertEqual(args[:7], ["add", "--repo", "proj", "--mint", "Check the - migration notes", "--kind", "task"])
        self.assertIn("--queue", args)
        body = args[args.index("--body") + 1].splitlines()
        self.assertTrue(body[0].startswith("Created: 20") and body[0].endswith("Z"))
        self.assertEqual(body[1:], ["Follow-up of: alpha", f"Due by: {due}", "Note: ask Sam"])
        self.assertEqual((done["followup"], done["due"]), ("check-the-notes-ab", due))

    def test_a_follow_up_without_a_due_date_or_repo_carries_neither(self):
        fake = Fake(**{"fm-tasks-axi.sh:add": Done("ok: added x-aa (task) -> Queued\n")})
        self.go({"task": "alpha", "action": "followup", "title": "Look again", "facts": {"repo": "no project"}}, fake)
        args = fake.ran()[0]["args"]
        self.assertNotIn("--repo", args)
        self.assertNotIn("Due by", args[args.index("--body") + 1])


class Refusals(ReviewBase):
    def test_a_task_with_a_live_worker_is_never_marked_done_or_held_even_when_the_page_did_not_know(self):
        (self.home / "state").mkdir(exist_ok=True)
        (self.home / "state" / "alpha.meta").write_text("kind=ship\nbranch=fm/alpha\n")
        for action in ("done", "delay", "needs"):
            why = self.refused({"task": "alpha", "action": action, "until": days(3)}, Fake(shown("in_flight")))
            self.assertIn("worker", why, action)
        self.assertIn("running", self.refused({"task": "alpha", "action": "queue"}, Fake(shown("in_flight"))))

    def test_a_branch_or_pr_that_has_not_landed_blocks_done(self):
        for facts in ({"ready": True}, {"branch_state": "ahead"}, {"pr": "https://git.example.test/o/r/pull/1", "merged": False}):
            self.assertIn("landed", self.refused({"task": "alpha", "action": "done", "facts": facts}, Fake(shown("queued"))))
        self.go({"task": "alpha", "action": "done", "facts": {"branch_state": "merged", "pr": "https://git.example.test/o/r/pull/1", "merged": True}}, Fake(shown("queued")))

    def test_an_open_typed_card_blocks_every_move_of_its_task(self):
        for action in ("done", "queue", "delay", "needs"):
            self.assertIn("open card", self.refused({"task": "alpha", "action": action, "until": days(3), "facts": {"ask_open": True}}, Fake(shown("queued", "yes", "captain"))), action)

    def test_states_the_action_would_not_change(self):
        self.assertIn("already done", self.refused({"task": "alpha", "action": "done"}, Fake(shown("done"))))
        self.assertIn("already queued", self.refused({"task": "alpha", "action": "queue"}, Fake(shown("queued"))))
        self.assertIn("already waiting", self.refused({"task": "alpha", "action": "needs"}, Fake(shown("queued", "yes", "captain"))))
        self.assertIn("already done", self.refused({"task": "alpha", "action": "delay", "until": days(3)}, Fake(shown("done"))))

    def test_a_date_must_be_real_in_the_future_and_within_a_year(self):
        for until, word in ((None, "date"), ("tomorrow", "date"), ("2026-02-30", "real"), (days(0), "after today"), (days(-3), "after today"), (days(900), "year")):
            fake = Fake(shown("queued"))
            with self.assertRaises(review.ReviewError, msg=str(until)) as caught:
                self.go({"task": "alpha", "action": "delay", "until": until}, fake)
            self.assertIn(word, str(caught.exception))
            self.assertEqual(fake.ran(), [])

    def test_a_bad_reference_action_or_title_runs_nothing(self):
        for payload in ({"task": "../x", "action": "done"}, {"task": "alpha", "action": "delete"}, {"task": "alpha", "action": "followup", "title": "x"}, {"task": "alpha", "action": "followup", "title": "Fine title", "due": "soon"}):
            fake = Fake()
            with self.assertRaises(review.ReviewError):
                self.go(payload, fake)
            self.assertEqual(fake.ran(), [])

    def test_a_task_the_backlog_does_not_have_is_a_404_and_a_missing_command_is_a_501(self):
        fake = Fake(Done("", 1, "no such task"))
        self.assertEqual(self.refused({"task": "alpha", "action": "done"}, fake, 404).count("Refresh"), 1)
        with self.assertRaises(review.ReviewError) as caught:
            review.act(self.session, self.tmp / "no-checkout", {"task": "alpha", "action": "done"}, runner=Fake())
        self.assertEqual(caught.exception.status, 501)

    def test_a_command_that_refuses_shows_its_own_last_line_and_changes_nothing_else(self):
        fake = Fake(shown("queued", "yes", "captain"), **{"fm-captain-hold.sh": Done("", 2, "fm-captain-hold: release is attended-only while away\n")})
        with self.assertRaises(review.ReviewError) as caught:
            self.go({"task": "alpha", "action": "queue"}, fake)
        self.assertIn("attended-only", str(caught.exception))
        self.assertEqual(caught.exception.status, 409)


class RealScripts(HomeCase):
    """The real Firstmate commands against a scratch home made here: each outcome changes the backlog the way the card said."""

    def setUp(self):
        super().setUp()
        self.root = homes.find_fm_root()
        if self.root is None or not all((self.root / "bin" / n).is_file() for n in ("fm-tasks-axi.sh", "fm-captain-hold.sh")):
            self.skipTest("no Firstmate checkout with the backlog commands is installed")
        self.write("data/backlog.md", "## In flight\n- [ ] alpha - Do alpha (repo: proj) (kind: scout) (since 2026-11-06)\n\n## Queued\n- [ ] gamma - later (repo: proj) (kind: scout) (since 2026-11-05)\n"
                                      "- [ ] delta - held one (repo: proj) (kind: scout) (since 2026-11-05)\n\n## Done\n")
        from board.collect import script_env
        self.env = script_env(self.home)

    def fm(self, name, *args, stdin=None):
        return subprocess.run([str(self.root / "bin" / name), *args], env=self.env, input=stdin, capture_output=True, text=True, timeout=120, check=False)

    def act(self, **payload):
        return review.act(self.session, self.root, payload)

    def backlog(self):
        return (self.home / "data" / "backlog.md").read_text()

    def test_every_outcome_changes_the_backlog_as_promised(self):
        until = days(12)
        done = self.act(task="gamma", action="delay", until=until, note="after the launch")
        self.assertEqual((done["after"]["state"], done["after"]["held"], done["after"]["until"]), ("queued", True, until))
        back = self.act(task="gamma", action="queue", note="ready now")
        self.assertEqual((back["after"]["state"], back["after"]["held"]), ("queued", False))
        self.assertEqual(self.act(task="alpha", action="done", note="read it")["after"]["state"], "done")
        self.assertIn("- [x] alpha", self.backlog())
        self.assertEqual(self.act(task="alpha", action="queue")["after"]["state"], "queued", "a done task comes back to Queued")
        self.act(task="delta", action="needs", note="your call")
        self.assertEqual(self.act(task="delta", action="done")["after"]["state"], "done", "a task held for you is closed through the keyed answer intake")
        follow = self.act(task="gamma", action="followup", title="Check the launch notes", due=days(5), note="ask Sam", facts={"repo": "proj"})
        self.assertTrue(follow["followup"])
        text = self.backlog()
        self.assertIn(f"- [ ] {follow['followup']} - Check the launch notes (repo: proj) (kind: task)", text)
        self.assertIn("Follow-up of: gamma", text)
        self.assertIn(f"Due by: {days(5)}", text)

    def test_a_task_with_a_worker_record_is_left_alone(self):
        self.write("state/alpha.meta", "kind=ship\n")
        before = self.backlog()
        with self.assertRaises(review.ReviewError):
            self.act(task="alpha", action="done")
        self.assertEqual(self.backlog(), before)


if __name__ == "__main__":
    unittest.main()
