import json
import os
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace

from base import HomeCase, held, record, snapshot
from board import homes
from board.build import build_board
from board.collect import CollectError, Collector, parse_status_line, script_env


def done(out="", code=0):
    return SimpleNamespace(stdout=out, returncode=code, stderr="")


class StatusLines(unittest.TestCase):
    def test_grammar(self):
        self.assertEqual(parse_status_line("paused [on=partner] [at=1794000000]: waiting for keys"),
                         {"state": "paused", "key": None, "at": 1794000000, "on": "partner", "text": "waiting for keys"})
        self.assertEqual(parse_status_line("needs-decision [key=k1] [at=5]: Pick?")["key"], "k1")
        self.assertEqual(parse_status_line("done [at=7]: ready in branch fm/x")["text"], "ready in branch fm/x")
        self.assertIsNone(parse_status_line("chatter without a state"))
        self.assertIsNone(parse_status_line(""))


class Environment(unittest.TestCase):
    def test_a_script_gets_its_own_home_and_nothing_the_caller_set(self):
        os.environ["FM_TASK_ID"] = "leak"
        os.environ["FM_STATE_OVERRIDE"] = "/elsewhere"
        os.environ["SECRET_TOKEN"] = "nope"
        self.addCleanup(lambda: [os.environ.pop(k, None) for k in ("FM_TASK_ID", "FM_STATE_OVERRIDE", "SECRET_TOKEN")])
        env = script_env(Path("/some/home"))
        self.assertEqual(env["FM_HOME"], "/some/home")
        self.assertNotIn("FM_TASK_ID", env)
        self.assertNotIn("FM_STATE_OVERRIDE", env)
        self.assertNotIn("SECRET_TOKEN", env)
        self.assertNotIn("FM_HOME", script_env(None))


class Scripts(HomeCase):
    def collector(self, runner, root="/fm"):
        c = Collector(Path(root), runner=runner)
        self.fake_root = self.tmp / "fm"
        (self.fake_root / "bin").mkdir(parents=True, exist_ok=True)
        for name in ("fm-fleet-snapshot.sh", "fm-captain-ask.sh"):
            (self.fake_root / "bin" / name).write_text("#!/bin/sh\n")
        c.fm_root = self.fake_root
        return c

    def test_the_snapshot_runs_for_the_sessions_home_with_the_readers_own_cache(self):
        seen = {}

        def run(argv, env, timeout):
            seen.update(argv=argv, env=env, timeout=timeout)
            return done(json.dumps(snapshot([record("a")])))

        data = self.collector(run).snapshot(self.session)
        self.assertEqual(data["backlog"]["records"][0]["id"], "a")
        self.assertEqual(seen["argv"], [str(self.fake_root / "bin" / "fm-fleet-snapshot.sh"), "--json"])
        self.assertEqual(seen["env"]["FM_HOME"], str(self.home))
        self.assertEqual(seen["env"]["FM_SNAPSHOT_CACHE_DIR"], str(self.tmp / "cache" / "snapshot" / "leader-test"))

    def test_every_way_a_snapshot_can_fail_is_one_plain_sentence(self):
        def raising(exc):
            def run(argv, env, timeout):
                raise exc
            return run

        cases = [
            (raising(subprocess.TimeoutExpired("x", 1)), "took longer"),
            (raising(PermissionError(13, "Permission denied")), "could not start"),
            (lambda a, e, t: done("", 3), "failed (exit 3)"),
            (lambda a, e, t: done("not json"), "was not JSON"),
            (lambda a, e, t: done(json.dumps({"schema": "other"})), "unknown schema"),
            (lambda a, e, t: done(json.dumps([1])), "unknown schema"),
        ]
        for run, why in cases:
            with self.assertRaises(CollectError, msg=why) as ctx:
                self.collector(run).snapshot(self.session)
            self.assertIn(why, str(ctx.exception))

    def test_no_checkout_or_no_script_is_said(self):
        with self.assertRaises(CollectError) as ctx:
            Collector(None).snapshot(self.session)
        self.assertIn("no Firstmate checkout", str(ctx.exception))
        empty = self.tmp / "empty"
        (empty / "bin").mkdir(parents=True)
        with self.assertRaises(CollectError) as ctx:
            Collector(empty).snapshot(self.session)
        self.assertIn("fm-fleet-snapshot.sh is not in", str(ctx.exception))

    def test_a_session_root_wins_over_the_shared_one(self):
        own = self.tmp / "own"
        (own / "bin").mkdir(parents=True)
        (own / "bin" / "fm-fleet-snapshot.sh").write_text("#!/bin/sh\n")
        session = homes.Session("s", "S", self.home, "software", root=own)
        seen = []
        c = Collector(self.tmp / "shared", runner=lambda a, e, t: (seen.append(a), done(json.dumps(snapshot([]))))[1])
        c.snapshot(session)
        self.assertEqual(seen[0][0], str(own / "bin" / "fm-fleet-snapshot.sh"))

    def test_asks_keep_only_typed_records_and_fail_plainly(self):
        good = {"schema": "fm-ask.v1", "id": "a", "cards": []}
        c = self.collector(lambda a, e, t: done(json.dumps([good, {"schema": "other"}, "x", {"id": "unsupported", "state": "unsupported"}])))
        self.assertEqual(c.asks(self.session), [good])
        argv_seen = []
        self.collector(lambda a, e, t: (argv_seen.append(a), done("[]"))[1]).asks(self.session)
        self.assertEqual(argv_seen[0][1:], ["list", "--open", "--resolve", "--json"])
        for run, why in [(lambda a, e, t: done("", 1), "failed (exit 1)"), (lambda a, e, t: done("nope"), "not JSON")]:
            with self.assertRaises(CollectError) as ctx:
                self.collector(run).asks(self.session)
            self.assertIn(why, str(ctx.exception))
        self.assertEqual(self.collector(lambda a, e, t: done(json.dumps({"a": 1}))).asks(self.session), [])

    def test_an_old_checkout_without_ask_records_leaves_the_board_on_prose(self):
        (self.tmp / "fm2" / "bin").mkdir(parents=True)
        (self.tmp / "fm2" / "bin" / "fm-fleet-snapshot.sh").write_text("#!/bin/sh\n")
        c = Collector(self.tmp / "fm2", runner=lambda a, e, t: done(json.dumps(snapshot([held("h", "A hold reason that is one plain question.")]))))
        board = build_board(self.session, c, now=1794000000)
        self.assertEqual(board["items"][0]["calls"][0]["src"], "hold")
        self.assertIn("fm-captain-ask.sh is not in", board["source"]["asks"]["error"])


class Files(HomeCase):
    def test_status_tail_reads_the_end_of_a_large_file_and_skips_the_cut_line(self):
        lines = [f"working [at={1794000000 + i}]: step {i}" for i in range(6000)]
        self.status("big", *lines)
        tail = Collector(None).status_tail(self.session, "big", 5)
        self.assertEqual([e["text"] for e in tail], [f"step {i}" for i in range(5995, 6000)])

    def test_status_tail_of_nothing_and_of_a_bad_id(self):
        c = Collector(None)
        self.assertEqual(c.status_tail(self.session, "absent"), [])
        self.assertEqual(c.status_tail(self.session, "../x"), [])
        self.assertIsNone(Collector.status_path(self.session, "a/b"))

    def test_report_summary_falls_back_to_the_first_prose_paragraph(self):
        self.write("data/r/report.md", "# Title\n\n| a | b |\n|---|---|\n\nThe first real paragraph.\n\nSecond.\n")
        c = Collector(None)
        self.assertEqual(c.report_summary(self.session, "data/r/report.md"), "The first real paragraph.")
        self.assertIsNone(c.report_summary(self.session, "data/absent.md"))
        self.assertIsNone(c.report_summary(self.session, "../escape.md"))
        self.assertIsNone(c.report_summary(self.session, None))

    def test_report_mentions_cannot_escape_the_home(self):
        c = Collector(None)
        (self.tmp / "outside.md").write_text("x")
        self.assertEqual(c.report_for(self.session, "t", "see data/../../outside.md"), (None, False))

    def test_branch_names_that_could_be_options_are_refused(self):
        self.git_project()
        c = Collector(None)
        project = self.home / "projects" / "proj"
        for name in ("-x", "--upload-pack=x", "a b", "a;b", ""):
            self.assertEqual(c.branch_state(project, name)["state"], "unknown" if name else "none", name)

    def test_branch_state_is_cached_within_a_collector(self):
        self.git_project(branches={"fm/a": 1})
        calls = []
        c = Collector(None, runner=lambda argv, env, timeout: (calls.append(argv), Collector._subprocess(argv, env, timeout))[1])
        project = self.home / "projects" / "proj"
        self.assertEqual(c.branch_state(project, "fm/a")["ahead"], 1)
        n = len(calls)
        c.branch_state(project, "fm/a")
        self.assertEqual(len(calls), n)

    def test_a_git_that_times_out_is_unknown(self):
        self.git_project(branches={"fm/a": 1})
        c = Collector(None, runner=lambda a, e, t: (_ for _ in ()).throw(subprocess.TimeoutExpired("git", 1)))
        self.assertEqual(c.branch_state(self.home / "projects" / "proj", "fm/a")["state"], "unknown")

    def test_the_two_call_shortcut_gives_what_asking_branch_by_branch_gives(self):
        repo = self.git_project(branches={"fm/a": 2, "fm/b": 0})
        fast, slow = Collector(None), Collector(None)
        slow._project_refs = lambda project: None  # an older git: branch by branch
        for branch in ("fm/a", "fm/b", "fm/none"):
            self.assertEqual(fast.branch_state(repo, branch), slow.branch_state(repo, branch), branch)
        calls = []
        counting = Collector(None, runner=lambda argv, env, timeout: (calls.append(argv), Collector._subprocess(argv, env, timeout))[1])
        for branch in ("fm/a", "fm/b", "fm/none"):
            counting.branch_state(repo, branch)
        self.assertEqual(len(calls), 2, "two git calls for the whole project, however many branches")

    def test_master_is_the_base_when_there_is_no_main(self):
        repo = self.git_project(branches={"fm/a": 1})
        subprocess.run(["git", "-C", str(repo), "branch", "-m", "main", "master"], check=True, capture_output=True)
        self.assertEqual(Collector(None).branch_state(repo, "fm/a"), {"state": "ahead", "ahead": 1, "base": "master"})


class QuickRead(HomeCase):
    """The quick read (Collector.light_snapshot): the backlog from the script's --contribution-input, the task rows from the home's own meta files."""

    def collector(self, runner):
        c = Collector(None, runner=runner, quick=True)
        root = self.tmp / "fm"
        (root / "bin").mkdir(parents=True, exist_ok=True)
        (root / "bin" / "fm-fleet-snapshot.sh").write_text("#!/bin/sh\n")
        c.fm_root = root
        return c

    def test_it_asks_for_the_backlog_only_and_builds_a_task_row_from_each_meta_file(self):
        seen = {}

        def run(argv, env, timeout):
            seen.update(argv=argv)
            return done(json.dumps({"backlog": {"records": [record("a")]}, "tasks": []}))

        (self.home / "state" / "a.meta").write_text("kind=scout\nproject=/p/proj\nbranch=fm/a\nspawn_gen=s1794000000.1.1\npr=https://x/pull/1\nbranch=fm/a2\ndriver=captain\ndriver_since=1794000100\ndriver_by=captain\n")
        (self.home / "state" / "b.meta").write_text("window=x\n")
        (self.home / "state" / "..bad.meta").write_text("kind=ship\n")
        data = self.collector(run).snapshot(self.session)
        self.assertEqual(seen["argv"][1:], ["--contribution-input"])
        self.assertEqual(data["backlog"]["records"][0]["id"], "a")
        rows = {r["id"]: r for r in data["tasks"]}
        self.assertEqual(sorted(rows), ["a", "b"])
        self.assertEqual((rows["a"]["kind"], rows["a"]["project"], rows["a"]["branch"], rows["a"]["pr"]["url"]), ("scout", "/p/proj", "fm/a2", "https://x/pull/1"), "the last of a repeated key wins")
        self.assertEqual(rows["a"]["driver"], {"since": 1794000100, "by": "captain", "typed_at": None})
        self.assertEqual((rows["b"]["kind"], rows["b"]["driver"], rows["b"]["branch"]), ("ship", None, None))

    def test_a_board_built_quick_says_so_and_a_whole_one_does_not(self):
        run = lambda argv, env, timeout: done(json.dumps({"backlog": {"records": [record("a")]}, "tasks": []}))
        self.assertTrue(build_board(self.session, self.collector(run))["quick"])

    def test_it_fails_in_one_plain_sentence(self):
        for result, text in ((done("", 3), "failed"), (done("nope"), "not JSON"), (done(json.dumps({"x": 1})), "unknown shape")):
            with self.assertRaises(CollectError) as caught:
                self.collector(lambda a, e, t, r=result: r).snapshot(self.session)
            self.assertIn(text, str(caught.exception))


class RealScripts(HomeCase):
    """The whole chain against the real Firstmate scripts and a scratch home, when a checkout is installed (skipped otherwise)."""

    def setUp(self):
        super().setUp()
        self.root = homes.find_fm_root()
        if self.root is None or not (self.root / "bin" / "fm-captain-ask.sh").is_file():
            self.skipTest("no Firstmate checkout with typed ask records is installed")

    def test_a_scratch_home_through_the_real_snapshot(self):
        self.write("data/backlog.md", "## In flight\n- [ ] alpha - Do alpha (repo: proj) (kind: ship) (since 2026-11-06)\n\n## Queued\n- [ ] gamma - later (repo: proj) (kind: scout) (since 2026-11-05)\n\n## Done\n")
        self.status("alpha", "working [at=1794000000]: building")
        board = build_board(self.session, Collector(self.root), now=1794000100)
        self.assertEqual(board["source"]["errors"], [])
        self.assertEqual({i["ref"]: i["col"] for i in board["items"]}, {"alpha": "running", "gamma": "queued"})
        self.assertEqual(board["source"]["asks"], {"records": 0})
        self.assertFalse((self.home / "state" / "secondmate-summary-cache").exists())


if __name__ == "__main__":
    unittest.main()
