"""Tests for what keeps a rebuild quick: the search for a log's chain by time, the chains kept for the length of one
rebuild, the work kept between builds, and the worker that runs rebuilds in one interpreter.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_resident.py
A rebuild that reuses what an earlier build learned must give the page that a build from nothing gives, whatever changed in
between (a new turn, a new session, a /clear, a closed pane, a file that was not there). Fixtures are synthetic.
"""

import io
import json
import os
import random
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reader  # noqa: E402
from reader import builder  # noqa: E402
import build_questionnaire  # noqa: E402
import test_sync  # noqa: E402
from test_reader import CLEAR, T0, iso, log, prompt  # noqa: E402
from test_sync import A, M, Lab, append_log, say, user, write_log  # noqa: E402
from test_sync import T0 as LAB_T0, iso as lab_iso  # noqa: E402  (the lab's logs are of two days ago)


def drop_caches():
    """What a build from nothing starts with: every list and every log's head, tail and link unread, no chain kept."""
    for cache in (builder._LOG_INDEX, builder._LISTINGS, builder._HEADS, builder._TAILS, builder._BRIDGES, builder._CLEARED, builder._MENTIONS,
                  build_questionnaire._PARSED):
        cache.clear()
    builder._TIMELINE.update(written=None, times=[], logs=[])


# ------------------------------------------------------------- the chain search, against the scan it replaced

def ref_cleared_from(path, clear_time):
    """cleared_from as it was written before the search by time: every log asked in turn."""
    def nearest(candidates, late, keep=lambda other: True):
        best = None
        for other in candidates:
            if other == path:
                continue
            at = builder.log_mtime(other)
            if at is None:
                continue
            gap = clear_time - at
            if -late <= gap <= 120 and (best is None or abs(gap) < best[0]) and keep(other):
                best = (abs(gap), other)
        return best[1] if best else None
    bridge = builder.bridge_id(builder.head_records(path))
    linked = nearest(builder.all_logs(), 30, lambda other: builder.names_bridge(other, bridge)) if bridge else None
    linked = linked or (builder.late_linked(path, clear_time, bridge) if bridge else None)
    return linked or builder.pane_cleared_from(path, clear_time) or nearest(builder.logs_in(path.parent), 5)


def ref_cleared_into(chain):
    written = builder.written_at(chain[-1])
    if not written:
        return None
    recorded = builder.last_record_time(chain[-1])
    recent = (other for other in {*builder.logs_in(chain[-1].parent), *builder.all_logs()} if (builder.log_mtime(other) or 0) >= min(written) - 5)
    for other in sorted(recent):
        if other in chain:
            continue
        at = builder.cleared_at(builder.head_records(other))
        near = any(-30 <= at - when <= 120 for when in written) if at is not None else False
        if at is not None and (near or (recorded is not None and -30 <= at - recorded <= builder.LATE_LINK_WINDOW)) and ref_cleared_from(other, at) == chain[-1]:
            return other
    return None


def ref_chain(path, limit=20):
    chain = [path]
    while len(chain) < limit:
        at = builder.cleared_at(builder.head_records(chain[0]))
        before = ref_cleared_from(chain[0], at) if at else builder.restarted_from(chain[0])
        if not before or before in chain:
            break
        chain.insert(0, before)
    while len(chain) < limit:
        after = ref_cleared_into(chain) or builder.restarted_into(chain)
        if not after:
            break
        chain.append(after)
    return chain


class ChainSearchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patch = mock.patch.object(builder, "PROJECTS", Path(self.tmp.name))
        patch.start()
        self.addCleanup(patch.stop)
        drop_caches()
        self.addCleanup(drop_caches)

    def corpus(self, seed, count=40):
        """Logs in a few folders, some cleared from another, some naming a remote-control link, written at times that cluster, so that
        several logs are candidates for one clear and ties between them happen."""
        rng = random.Random(seed)
        links = ["cse_01A", "cse_01B", "cse_01C"]
        for number in range(count):
            folder = Path(self.tmp.name) / f"folder{rng.randrange(3)}"
            folder.mkdir(exist_ok=True)
            start = T0 + rng.choice([0, 100, 200, 300, 301, 302, 1000, 5000, 90000]) + rng.choice([0, 0, 0.5, 1, 7])
            end = start + rng.choice([0, 1, 60, 100, 119, 120, 121])
            records = []
            if rng.random() < 0.6:
                records.append({"type": "bridge-session", "bridgeSessionId": rng.choice(links), "timestamp": iso(start)})
            if rng.random() < 0.5:
                records.append(prompt(CLEAR, iso(start)))
            records.append(prompt("work", iso(start + 1)))
            if rng.random() < 0.3:
                records.append({"type": "bridge-session", "bridgeSessionId": rng.choice(links), "timestamp": iso(end)})
            written = end + rng.choice([0, 0, 0.5, 5, 29, 31, 4000])
            log(folder / f"log{number:03}.jsonl", records, written)

    def test_the_search_by_time_finds_the_chain_the_scan_of_every_log_found(self):
        compared = joined = 0
        for seed in range(25):
            for stale in Path(self.tmp.name).glob("*/*.jsonl"):
                stale.unlink()
            self.corpus(seed)
            drop_caches()
            for path in builder.all_logs():
                expected = ref_chain(path)
                self.assertEqual(builder.chain_of(path, 20), expected, f"seed {seed}, {path.name}")
                compared += 1
                joined += len(expected) > 1
        self.assertGreater(joined, 100, "the corpus must hold chains to find, or this proves nothing")
        self.assertEqual(compared, 25 * 40)

    def test_a_chain_is_worked_out_once_inside_chains_frozen_and_again_outside_it(self):
        folder = Path(self.tmp.name) / "project"
        folder.mkdir()
        log(folder / "first.jsonl", [prompt("hello", iso(T0))], T0 + 100)
        log(folder / "second.jsonl", [prompt(CLEAR, iso(T0 + 100.5)), prompt("next", iso(T0 + 200))], T0 + 500)
        self.assertEqual([p.stem for p in builder.session_chain(folder / "first.jsonl")], ["first", "second"])
        with builder.chains_frozen():
            self.assertEqual([p.stem for p in builder.session_chain(folder / "second.jsonl")], ["first", "second"])
            log(folder / "third.jsonl", [prompt(CLEAR, iso(T0 + 500.2)), prompt("go on", iso(T0 + 600))], T0 + 700)
            builder._LOG_INDEX.clear()
            self.assertEqual([p.stem for p in builder.session_chain(folder / "second.jsonl")], ["first", "second"], "the same chain for the whole rebuild")
            handed = builder.session_chain(folder / "second.jsonl")
            handed.append(folder / "x.jsonl")
            self.assertEqual(len(builder.session_chain(folder / "second.jsonl")), 2, "a caller changing its chain does not change the kept one")
            with builder.chains_frozen():
                self.assertEqual(len(builder.session_chain(folder / "second.jsonl")), 2, "a block inside one shares it")
        self.assertEqual([p.stem for p in builder.session_chain(folder / "second.jsonl")], ["first", "second", "third"])


# --------------------------------------------------------- a build that reuses what an earlier one learned

def normal(payload):
    """A payload without its build time, which is the one thing that differs between two builds of the same logs."""
    return json.loads(json.dumps({key: value for key, value in payload.items() if key != "generated"}))


class WarmBuildTest(unittest.TestCase):
    """The worker builds again and again in one interpreter. Each of these changes the logs between two builds there, and checks the
    second build against one made from nothing."""

    def setUp(self):
        self.lab = Lab(self)
        self.main = str(self.lab.main)
        self.sessions = [A, M]
        self.addCleanup(drop_caches)
        drop_caches()
        self.warm = normal(self.lab.local_payload(self.sessions))  # the first build, which warms every cache

    def assert_warm_equals_cold(self, sessions=None):
        sessions = sessions or self.sessions
        builder._LOG_INDEX.clear()  # what the worker does at the start of each request
        warm = normal(self.lab.local_payload(sessions))
        drop_caches()
        cold = normal(self.lab.local_payload(sessions))
        self.assertEqual(warm, cold)
        return cold

    def bump(self, session):
        os.utime(self.lab.logs[session], None)

    def test_a_new_turn_in_a_listed_session_shows_and_nothing_else_changes(self):
        before = self.warm["sessions"]
        append_log(self.lab.logs[A], [user("Go ahead.", LAB_T0 + 800, self.main), say("Starting now.", LAB_T0 + 810, self.main)])
        self.bump(A)
        cold = self.assert_warm_equals_cold()
        mine = next(s for s in cold["sessions"] if s["id"] == A)
        self.assertEqual(mine["exchanges"][-1]["reply"], "Starting now.")
        other = next(s for s in cold["sessions"] if s["id"] == M)
        self.assertEqual(other, next(s for s in before if s["id"] == M), "the session that did not change is as it was")

    def test_a_new_session_joins_the_list(self):
        new = "dddddddd-4444-4444-8444-444444444444"
        write_log(self.lab.projects / "main" / f"{new}.jsonl", [user("A new task.", LAB_T0 + 900, self.main), say("On it.", LAB_T0 + 910, self.main)], LAB_T0 + 920)
        cold = self.assert_warm_equals_cold([A, M, new])
        self.assertIn(new, [s["id"] for s in cold["sessions"]])

    def test_a_clear_joins_the_new_log_to_its_conversation(self):
        before = self.assert_warm_equals_cold()
        new = "eeeeeeee-5555-4555-8555-555555555555"
        clear = {"type": "user", "timestamp": lab_iso(LAB_T0 + 701), "cwd": self.main, "message": {"role": "user", "content": CLEAR}}
        write_log(self.lab.projects / "main" / f"{new}.jsonl", [clear, user("Carry on.", LAB_T0 + 720, self.main), say("Carrying on.", LAB_T0 + 730, self.main)], LAB_T0 + 740)
        cold = self.assert_warm_equals_cold()
        mine = next(s for s in cold["sessions"] if A in s["ids"])
        self.assertEqual(mine["id"], new, "the conversation is under its newest session")
        self.assertEqual(mine["ids"], [A, new])
        self.assertNotEqual(cold, before)

    def test_a_session_taken_off_the_list_leaves_the_page(self):
        cold = self.assert_warm_equals_cold([A])
        self.assertEqual([s["id"] for s in cold["sessions"]], [A])

    def test_a_file_a_reply_names_shows_once_it_exists_though_the_reply_did_not_change(self):
        # The replies' mentions are kept between builds; whether the file is there is not.
        plan = self.lab.main / "later.md"
        append_log(self.lab.logs[A], [user("Write it down.", LAB_T0 + 800, self.main), say("It is in `later.md`.", LAB_T0 + 810, self.main)])
        self.bump(A)
        first = self.assert_warm_equals_cold()
        self.assertEqual(first["documents"].keys() & {d["id"] for d in first["documents"].values() if d["name"] == "later.md"}, set())
        plan.write_text("# Later\n", encoding="utf-8")
        second = self.assert_warm_equals_cold()
        self.assertIn("later.md", [d["name"] for d in second["documents"].values()])
        plan.write_text("# Later, again\n", encoding="utf-8")
        third = self.assert_warm_equals_cold()
        self.assertIn("# Later, again\n", [d.get("text") for d in third["documents"].values()], "a file read again as it is now")

    def test_an_answer_sheet_is_found_again_without_parsing_the_reply_twice(self):
        sheet = next(e for s in self.warm["sessions"] if s["id"] == M for e in s["exchanges"] if e.get("sheet"))
        with mock.patch.object(build_questionnaire, "_parse_questionnaire", side_effect=AssertionError("parsed again")):
            self.assertTrue(build_questionnaire.parse_questionnaire(sheet["reply"]))
        found = build_questionnaire.parse_questionnaire(sheet["reply"])
        found["cards"].clear()
        self.assertTrue(build_questionnaire.parse_questionnaire(sheet["reply"])["cards"], "a caller changing its copy does not change the kept one")


class MentionsTest(unittest.TestCase):
    def test_kept_mentions_are_what_the_scan_finds_and_are_kept_by_digest(self):
        drop_caches()
        self.addCleanup(drop_caches)
        text = "See notes.md and plan.md, or ~/a/b/c.md; also index.html."
        self.assertEqual(list(builder.md_mentions(text)), list(builder.file_mentions(text, ".md", builder.NAME_END)))
        self.assertEqual(list(builder.html_mentions(text)), list(builder.file_mentions(text, ".htm", builder.HTML_NAME_END)))
        self.assertEqual(len(builder._MENTIONS), 2)
        self.assertTrue(all(isinstance(key[0], bytes) and len(key[0]) == 20 for key in builder._MENTIONS), "the text itself is never kept")
        with mock.patch.object(builder, "file_mentions", side_effect=AssertionError("scanned again")):
            self.assertEqual(list(builder.md_mentions(text)), [(4, "notes.md"), (17, "plan.md"), (29, "~/a/b/c.md")])

    def test_a_text_with_a_lone_surrogate_is_still_scanned(self):
        drop_caches()
        self.addCleanup(drop_caches)
        text = "bad \ud800 text and notes.md"
        self.assertEqual(list(builder.md_mentions(text)), list(builder.file_mentions(text, ".md", builder.NAME_END)))
        self.assertEqual(list(builder.md_mentions(text)), [(15, "notes.md")])

    def test_the_names_a_session_touched_are_found_by_their_last_name_in_the_order_a_scan_found_them(self):
        paths = ["/x/a/plan.md", "/y/b/plan.md", "/z/c/other.md", "/w/a/plan.md"]
        touched = builder.Touched()
        touched.extend(paths[:2])
        touched.extend(paths[2:])
        self.assertEqual(list(touched), paths)
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            with mock.patch.dict(os.environ, {"HOME": str(home)}):
                for name in ("x/a", "y/b", "w/a"):
                    (home / name).mkdir(parents=True)
                    (home / name / "plan.md").write_text("p", encoding="utf-8")
                real = [str(home / name / "plan.md") for name in ("x/a", "y/b", "w/a")]
                scan = builder.resolve_mention("a/plan.md", [], "", real)
                by_name = builder.Touched()
                by_name.extend(real)
                self.assertEqual(builder.resolve_mention("a/plan.md", [], "", by_name), scan)
                self.assertEqual(scan, home / "w" / "a" / "plan.md", "the latest touched first")
                self.assertEqual(builder.resolve_mention("plan.md", [], "", by_name), builder.resolve_mention("plan.md", [], "", real))


# --------------------------------------------------------------------------------------------- the worker

class WorkerTest(unittest.TestCase):
    def ask(self, *requests, main=None):
        lines = "".join((r if isinstance(r, str) else json.dumps(r)) + "\n" for r in requests)
        out = io.StringIO()
        saved = reader.BUILDERS
        self.addCleanup(setattr, reader, "BUILDERS", saved)
        with mock.patch("sys.stdin", io.StringIO(lines)), mock.patch("sys.stdout", out), mock.patch.object(reader, "main", main or (lambda args: 0)):
            self.assertEqual(reader.worker(), 0)
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def test_it_answers_each_request_with_its_id_the_exit_code_and_what_the_command_printed(self):
        def main(args):
            print("ran", *args)
            return 3 if args[0] == "close" else 0
        answers = self.ask({"id": 7, "args": ["rebuild"]}, {"id": 8, "args": ["close", "x"]}, main=main)
        self.assertEqual(answers, [{"id": 7, "code": 0, "output": "ran rebuild\n"}, {"id": 8, "code": 3, "output": "ran close x\n"}])

    def test_it_takes_only_the_commands_the_server_runs_for_a_page(self):
        calls = []
        refused = [{"id": 1, "args": ["add", "x"]}, {"id": 2, "args": ["list"]}, {"id": 3, "args": ["rebuild", "extra"]}, {"id": 4, "args": ["follow"]},
                   {"id": 5, "args": ["adopt"]}, {"id": 6, "args": []}, {"id": 7, "args": "rebuild"}, {"id": 8, "args": ["rebuild", 1]}, {"args": ["rebuild"]},
                   "not json", "[1]", {"id": 9}]
        answers = self.ask(*refused, {"id": 10, "args": ["adopt", "a", "b"]}, main=lambda args: calls.append(args) or 0)
        self.assertEqual([a["code"] for a in answers], [2] * len(refused) + [0])
        self.assertEqual(calls, [["adopt", "a", "b"]], "nothing else reached a command")

    def test_a_build_that_raises_answers_with_its_traceback_and_the_next_request_runs(self):
        def main(args):
            if args[0] == "rebuild":
                raise RuntimeError("the log changed under the build")
            return 0
        answers = self.ask({"id": 1, "args": ["rebuild"]}, {"id": 2, "args": ["close", "x"]}, main=main)
        self.assertEqual(answers[0]["code"], 1)
        self.assertIn("RuntimeError: the log changed under the build", answers[0]["output"])
        self.assertEqual(answers[1], {"id": 2, "code": 0, "output": ""})

    def test_every_request_sees_the_logs_written_since_the_last_one(self):
        builder._LOG_INDEX["kept"] = (0, [], {}, {}, {})
        self.addCleanup(builder._LOG_INDEX.pop, "kept", None)
        seen = []
        self.ask({"id": 1, "args": ["rebuild"]}, main=lambda args: seen.append("kept" in builder._LOG_INDEX) or 0)
        self.assertEqual(seen, [False])

    def test_it_builds_in_its_own_interpreter_and_a_builder_that_stops_says_why(self):
        self.ask()
        self.assertIs(reader.BUILDERS, reader.run_in_process)
        with mock.patch.object(builder, "main", side_effect=SystemExit("session not found: x")), mock.patch("builtins.print") as shown:
            self.assertEqual(reader.run_in_process(["--out", "x"], []), 1)
        self.assertEqual(shown.call_args.args[0], "session not found: x")
        with mock.patch.object(builder, "main", return_value=0), mock.patch.object(build_questionnaire, "main", return_value=1):
            self.assertEqual(reader.run_in_process([], []), 1, "the sheet failing fails the rebuild, as it did")
        with mock.patch.object(builder, "main", return_value=0), mock.patch.object(build_questionnaire, "main", return_value=0) as sheet:
            self.assertEqual(reader.run_in_process(["a"], ["b"]), 0)
        sheet.assert_called_once_with(["b"])

    def test_it_starts_again_from_the_new_files_before_it_answers_when_its_own_files_change(self):
        out = io.StringIO()
        saved = reader.BUILDERS
        self.addCleanup(setattr, reader, "BUILDERS", saved)
        versions = iter([(1, 1)] * 3 + [(2, 2)] * 3)
        with mock.patch("sys.stdin", io.StringIO(json.dumps({"id": 1, "args": ["rebuild"]}) + "\n")), mock.patch("sys.stdout", out), \
                mock.patch.object(reader, "main", return_value=0), mock.patch.object(builder, "file_version", lambda path: next(versions)), \
                mock.patch.object(reader.os, "execv", side_effect=SystemExit) as execv:
            with self.assertRaises(SystemExit):
                reader.worker()
        argv = execv.call_args.args[1]
        self.assertEqual(argv[1:3], ["-I", str(reader.HERE / "reader.py")])
        self.assertEqual(argv[3:5], ["worker", "--replay"])
        self.assertEqual(json.loads(argv[5]), {"id": 1, "args": ["rebuild"]}, "the request it was about to answer goes to the new process")
        self.assertEqual(out.getvalue(), "", "and is not answered by the old code")

    def test_a_replayed_request_is_answered_first_and_the_command_line_hands_it_over(self):
        saved = reader.BUILDERS
        self.addCleanup(setattr, reader, "BUILDERS", saved)
        out = io.StringIO()
        request = json.dumps({"id": 4, "args": ["rebuild"]})
        with mock.patch("sys.stdin", io.StringIO("")), mock.patch("sys.stdout", out), mock.patch.object(reader, "main", return_value=0):
            self.assertEqual(reader.worker(request), 0)
        self.assertEqual(json.loads(out.getvalue()), {"id": 4, "code": 0, "output": ""})
        with mock.patch.object(reader, "worker", return_value=0) as run:
            self.assertEqual(reader.main(["worker", "--replay", request]), 0)
            self.assertEqual(reader.main(["worker"]), 0)
        self.assertEqual([call.args for call in run.call_args_list], [(request,), (None,)])
        with mock.patch.object(reader, "worker", return_value=0) as run, mock.patch("builtins.print"):
            reader.main(["worker", "--replay"])
            reader.main(["worker", "extra"])
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
