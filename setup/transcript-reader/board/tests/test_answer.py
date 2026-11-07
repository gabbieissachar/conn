"""Slice 6's write: answering a call on its card. Fake commands prove the exact argv, stdin and refusals; the real Firstmate scripts are run only against a
scratch home made for the test, never a real one."""

from __future__ import annotations

import json
import subprocess
import unittest

from base import HomeCase

from board import answer, cli, homes


class Done:
    def __init__(self, out="", code=0, err=""):
        self.returncode, self.stdout, self.stderr = code, out, err


def card_list(key="Z1", task="alpha", options=("yes", "no"), ask_id="ask-20261107T000000Z-abcd", state="open"):
    return json.dumps([{"schema": "fm-ask.v1", "id": ask_id, "cards": [{"key": key, "state": state, "gate": {"task": task, "mode": "done"},
                                                                      "options": [{"value": v} for v in options]}]}])


class Fake:
    """Records every command; `script` maps a script name to what it answers."""

    def __init__(self, **answers):
        self.calls, self.answers = [], answers

    def __call__(self, argv, env, timeout, stdin=None):
        name = argv[0].rsplit("/", 1)[-1]
        self.calls.append({"name": name, "args": argv[1:], "env": env, "stdin": stdin, "timeout": timeout})
        got = self.answers.get(name, Done())
        return got(argv, stdin) if callable(got) else got


class AnswerBase(HomeCase):
    def setUp(self):
        super().setUp()
        self.root = self.tmp / "fm"
        (self.root / "bin").mkdir(parents=True)
        for name in ("fm-captain-ask.sh", "fm-captain-hold.sh", "fm-send.sh"):
            (self.root / "bin" / name).write_text("#!/bin/sh\n")

    def go(self, payload, fake):
        return answer.answer(self.session, self.root, payload, runner=fake)


class Typed(AnswerBase):
    def test_an_option_is_recorded_with_the_records_own_words_not_the_pages(self):
        fake = Fake(**{"fm-captain-ask.sh": lambda argv, stdin: Done(card_list()) if argv[1] == "list" else Done("card Z1=yes\ngate alpha: closed\n")})
        done = self.go({"task": "alpha", "call": "Z1", "src": "ask", "option": "a", "text": "ignored page words"}, fake)
        self.assertEqual((done["value"], done["ask"], done["via"]), ("yes", "ask-20261107T000000Z-abcd", "fm-captain-ask.sh answered"))
        self.assertEqual(fake.calls[0]["args"], ["list", "--open", "--resolve", "--json"])
        self.assertEqual((fake.calls[1]["args"], fake.calls[1]["stdin"]), (["answered", "ask-20261107T000000Z-abcd"], "Z1=yes\n"))
        self.assertEqual(fake.calls[1]["env"]["FM_HOME"], str(self.home), "run with the session's own home")
        self.assertNotIn("FM_ROOT", fake.calls[1]["env"])

    def test_free_text_later_and_the_characters_the_reply_grammar_would_misread(self):
        fake = Fake(**{"fm-captain-ask.sh": lambda argv, stdin: Done(card_list()) if argv[1] == "list" else Done("ok")})
        self.go({"task": "alpha", "call": "Z1", "src": "ask", "text": "yes; and Z2=no\nplease | now"}, fake)
        self.assertEqual(fake.calls[-1]["stdin"], "Z1=yes, and Z2:no, please, now\n")
        self.go({"task": "alpha", "call": "Z1", "src": "ask", "later": True}, fake)
        self.assertEqual(fake.calls[-1]["stdin"], "Z1=later\n")

    def test_a_card_that_is_not_open_for_this_task_is_refused_and_nothing_is_recorded(self):
        for listing in (card_list(state="answered"), card_list(task="beta"), card_list(key="Z2"), "[]", "not json"):
            fake = Fake(**{"fm-captain-ask.sh": Done(listing)})
            with self.assertRaises(answer.AnswerError) as caught:
                self.go({"task": "alpha", "call": "Z1", "src": "ask", "option": "a"}, fake)
            self.assertIn(caught.exception.status, (409, 502))
            self.assertEqual([c["args"][0] for c in fake.calls], ["list"], "never an answered call")

    def test_an_option_the_card_does_not_have_and_an_empty_answer_are_refused(self):
        fake = Fake(**{"fm-captain-ask.sh": Done(card_list())})
        for payload in ({"option": "c"}, {"text": "  "}, {}):
            with self.assertRaises(answer.AnswerError):
                self.go({"task": "alpha", "call": "Z1", "src": "ask", **payload}, fake)
        self.assertEqual([c["args"][0] for c in fake.calls if c["args"][0] == "answered"], [])

    def test_the_commands_own_refusal_is_the_sentence_the_page_shows(self):
        def refuse(argv, stdin):
            return Done(card_list()) if argv[1] == "list" else Done("", 1, "fm-captain-ask: a key that matches cards in two records is refused\n")
        with self.assertRaises(answer.AnswerError) as caught:
            self.go({"task": "alpha", "call": "Z1", "src": "ask", "option": "a"}, Fake(**{"fm-captain-ask.sh": refuse}))
        self.assertEqual(caught.exception.status, 409)
        self.assertIn("two records", str(caught.exception))

    def test_a_card_key_that_is_not_a_card_key_never_runs_anything(self):
        fake = Fake()
        with self.assertRaises(answer.AnswerError):
            self.go({"task": "alpha", "call": "bad key", "src": "ask", "option": "a"}, fake)
        with self.assertRaises(answer.AnswerError):
            self.go({"task": "alpha", "call": "zz", "src": "ask", "option": "a"}, fake)
        self.assertEqual(fake.calls, [])


class Holds(AnswerBase):
    def test_the_only_call_of_a_hold_is_answered_through_the_keyed_intake_and_closes_it(self):
        fake = Fake(**{"fm-captain-hold.sh": Done("closed: alpha\nanswers: closed=1 skipped=0\n")})
        done = self.go({"task": "alpha", "call": "call", "src": "hold", "text": "call -> a (yes)", "calls": 1}, fake)
        self.assertEqual(done["mode"], "done")
        self.assertEqual(fake.calls[0]["args"], ["answers", "--any-origin", "--source", "reader-board"])
        self.assertEqual(fake.calls[0]["stdin"], "alpha\tcall -> a (yes)\tboard card\tdone\n")

    def test_a_go_releases_the_hold_instead_of_closing_it(self):
        fake = Fake(**{"fm-captain-hold.sh": Done("closed: alpha\n")})
        self.assertEqual(self.go({"task": "alpha", "call": "call", "src": "hold", "text": "go", "release": True, "calls": 1}, fake)["mode"], "release")
        self.assertTrue(fake.calls[0]["stdin"].endswith("\tboard card\trelease\n"))

    def test_tabs_and_newlines_in_your_words_cannot_add_a_field_or_a_line_to_the_keyed_intake(self):
        fake = Fake(**{"fm-captain-hold.sh": Done("closed: alpha\n")})
        self.go({"task": "alpha", "call": "call", "src": "hold", "text": "yes\tdone\nbeta\tgo\tx\trelease", "calls": 1}, fake)
        line = fake.calls[0]["stdin"]
        self.assertEqual((line.count("\n"), line.count("\t")), (1, 3))

    def test_a_hold_with_several_calls_is_refused_because_firstmate_can_only_close_it_whole(self):
        fake = Fake()
        with self.assertRaises(answer.AnswerError) as caught:
            self.go({"task": "alpha", "call": "R1", "src": "hold", "text": "a", "calls": 3}, fake)
        self.assertEqual(caught.exception.status, 409)
        self.assertIn("several calls", str(caught.exception))
        self.assertEqual(fake.calls, [])

    def test_a_skipped_or_refused_line_is_a_failure_even_when_the_command_exits_clean(self):
        for out in ("skipped: alpha is not held for the captain\n", "refused: release while away\n"):
            with self.assertRaises(answer.AnswerError):
                self.go({"task": "alpha", "call": "call", "src": "hold", "text": "go", "release": True, "calls": 1}, Fake(**{"fm-captain-hold.sh": Done(out)}))


class Workers(AnswerBase):
    def test_a_workers_keyed_question_is_answered_with_a_resolving_steer(self):
        fake = Fake(**{"fm-send.sh": Done("sent\n")})
        self.go({"task": "alpha", "call": "figma-access", "src": "status", "text": "use the shared file"}, fake)
        self.assertEqual(fake.calls[0]["args"], ["alpha", "--resolve-key", "figma-access", "use the shared file"])
        self.assertEqual(fake.calls[0]["env"]["FM_HOME"], str(self.home))

    def test_a_worker_that_waits_gets_a_plain_steer(self):
        fake = Fake(**{"fm-send.sh": Done("sent\n")})
        self.go({"task": "alpha", "call": "wait", "src": "wait", "text": "go ahead"}, fake)
        self.assertEqual(fake.calls[0]["args"], ["alpha", "go ahead"])

    def test_a_steer_the_command_refuses_is_not_recorded(self):
        with self.assertRaises(answer.AnswerError) as caught:
            self.go({"task": "alpha", "call": "k", "src": "status", "text": "x"}, Fake(**{"fm-send.sh": Done("", 1, "error: no open decision with that key; nothing was sent\n")}))
        self.assertIn("nothing was sent", str(caught.exception))


class Guards(AnswerBase):
    def test_a_review_board_call_and_an_unknown_kind_are_answered_elsewhere(self):
        fake = Fake()
        for src in ("board", "elsewhere", None):
            with self.assertRaises(answer.AnswerError) as caught:
                self.go({"task": "alpha", "call": "k", "src": src, "text": "x"}, fake)
            self.assertEqual(caught.exception.status, 409)
        self.assertEqual(fake.calls, [])

    def test_task_call_option_and_size_are_checked_before_anything_runs(self):
        fake = Fake()
        bad = [{"task": "../x", "call": "k", "src": "status", "text": "x"}, {"task": "a", "call": "k k", "src": "status", "text": "x"},
               {"task": "a", "call": "k", "src": "status", "option": "z", "text": "x"}, {"task": "a", "call": "k", "src": "status", "text": "x" * 9000},
               {"task": 5, "call": "k", "src": "status", "text": "x"}]
        for payload in bad:
            with self.assertRaises(answer.AnswerError):
                self.go(payload, fake)
        self.assertEqual(fake.calls, [])

    def test_control_characters_in_the_words_are_replaced_before_they_reach_a_command(self):
        fake = Fake(**{"fm-send.sh": Done("sent\n")})
        self.go({"task": "alpha", "call": "k", "src": "status", "text": "ok\x1b[31m\x00 now"}, fake)
        self.assertNotRegex(fake.calls[0]["args"][-1], r"[\x00-\x08\x1b]")

    def test_a_checkout_without_the_command_says_so_and_sends_nothing(self):
        (self.root / "bin" / "fm-send.sh").unlink()
        with self.assertRaises(answer.AnswerError) as caught:
            self.go({"task": "alpha", "call": "k", "src": "status", "text": "x"}, Fake())
        self.assertEqual(caught.exception.status, 501)

    def test_a_command_that_times_out_says_nothing_is_known_to_be_recorded(self):
        def slow(argv, env, timeout, stdin=None):
            raise subprocess.TimeoutExpired("x", 1)
        with self.assertRaises(answer.AnswerError) as caught:
            self.go({"task": "alpha", "call": "k", "src": "status", "text": "x"}, slow)
        self.assertEqual(caught.exception.status, 504)
        self.assertIn("nothing is known to be recorded", str(caught.exception))


class Cli(AnswerBase):
    def test_the_cli_turns_a_refusal_into_json_and_never_a_traceback(self):
        import io
        from contextlib import redirect_stdout
        from unittest import mock
        registry = homes.Registry(self.root, [self.session])
        out = io.StringIO()
        with mock.patch.object(homes, "load", return_value=registry), mock.patch("sys.stdin", io.StringIO(json.dumps({"task": "alpha", "call": "k k", "src": "status", "text": "x"}))), redirect_stdout(out):
            code = cli.main(["answer", "--session", "leader-test"])
        self.assertEqual(code, 0)
        result = json.loads(out.getvalue())
        self.assertEqual((result["ok"], result["status"]), (False, 400))


class RealScripts(HomeCase):
    """The real Firstmate commands against a scratch home made here: a typed card closes its gate, a single-call hold is released, a refused call changes nothing."""

    def setUp(self):
        super().setUp()
        self.root = homes.find_fm_root()
        if self.root is None or not all((self.root / "bin" / n).is_file() for n in ("fm-captain-ask.sh", "fm-captain-hold.sh")):
            self.skipTest("no Firstmate checkout with typed ask records is installed")
        self.write("data/backlog.md", "## In flight\n- [ ] alpha - Do alpha (repo: proj) (kind: ship) (since 2026-11-06)\n\n## Queued\n- [ ] gamma - later (repo: proj) (kind: scout) (since 2026-11-05)\n\n## Done\n")
        from board.collect import script_env
        self.env = script_env(self.home)

    def fm(self, name, *args, stdin=None):
        return subprocess.run([str(self.root / "bin" / name), *args], env=self.env, input=stdin, capture_output=True, text=True, timeout=120, check=False)

    def test_a_typed_card_is_answered_and_its_task_is_closed(self):
        self.assertEqual(self.fm("fm-captain-hold.sh", "hold", "alpha", "--reason", "pick a route").returncode, 0)
        opened = self.fm("fm-captain-ask.sh", "open", "--title", "Route", "--gate", "Z1=alpha", stdin="Z1 | Which route? | yes* | no -- not now\n")
        self.assertEqual(opened.returncode, 0, opened.stderr)
        with self.assertRaises(answer.AnswerError):
            answer.answer(self.session, self.root, {"task": "alpha", "call": "Z1", "src": "ask", "option": "z"})
        done = answer.answer(self.session, self.root, {"task": "alpha", "call": "Z1", "src": "ask", "option": "a"})
        self.assertEqual((done["recorded"], done["value"]), (True, "yes"))
        self.assertIn("(done 20", (self.home / "data" / "backlog.md").read_text())
        with self.assertRaises(answer.AnswerError) as again:
            answer.answer(self.session, self.root, {"task": "alpha", "call": "Z1", "src": "ask", "option": "a"})
        self.assertEqual(again.exception.status, 409)

    def test_a_single_call_hold_is_released_by_a_go_and_a_wrong_task_changes_nothing(self):
        self.assertEqual(self.fm("fm-captain-hold.sh", "hold", "gamma", "--reason", "Dispatch only on Nathan's word").returncode, 0)
        with self.assertRaises(answer.AnswerError):
            answer.answer(self.session, self.root, {"task": "no-such-task", "call": "call", "src": "hold", "text": "go", "release": True, "calls": 1})
        done = answer.answer(self.session, self.root, {"task": "gamma", "call": "call", "src": "hold", "text": "go", "release": True, "calls": 1})
        self.assertEqual(done["mode"], "release")
        self.assertIn("closed: gamma", done["output"])
        self.assertIn("- [ ] gamma", (self.home / "data" / "backlog.md").read_text(), "released work stays queued")


if __name__ == "__main__":
    unittest.main()
