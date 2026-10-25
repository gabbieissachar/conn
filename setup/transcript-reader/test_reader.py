"""Tests for reader.py session resolution, the Herdr pane naming it relies on, the
documents a reply names, and the sessions a pane ran across /clear.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_reader.py
Fixtures are synthetic; no real session log or Herdr call is used.
"""

import fcntl
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reader  # noqa: E402
from reader import builder  # noqa: E402

A = "aaaaaaaa-1111-4111-8111-111111111111"
B = "aaaaaabb-2222-4222-8222-222222222222"
C = "cccccccc-3333-4333-8333-333333333333"

PANES = {
    A: {"label": "leader-alpha", "title": "Secondmate alpha session handoff", "herdr": "work", "pane": "w1:p1"},
    B: {"label": "fm-2026-10-05-alpha-x12-final-spec", "title": "X12 spec handoff rule 3", "herdr": "work", "pane": "w1:p2"},
    C: {"label": "fm-2026-10-05-alpha-x12-spec-review", "title": "Alpha X12 spec review handoff", "herdr": "work", "pane": "w1:p3"},
}


class PaneIndexTest(unittest.TestCase):
    def test_pane_label_then_tab_label_then_title(self):
        panes = [
            {"pane_id": "w1:p1", "tab_id": "w1:t1", "label": "leader-alpha", "terminal_title_stripped": "Handoff", "agent_session": {"value": A}},
            {"pane_id": "w1:p2", "tab_id": "w1:t2", "label": None, "terminal_title_stripped": "X12 spec", "agent_session": {"value": B}},
            {"pane_id": "w1:p3", "tab_id": "w1:t9", "terminal_title_stripped": "Review", "agent_session": {"value": C}},
            {"pane_id": "w1:p4", "tab_id": "w1:t1", "terminal_title_stripped": "a shell, no agent session"},
        ]
        tabs = [{"tab_id": "w1:t1", "label": "leader-alpha"}, {"tab_id": "w1:t2", "label": "fm-x12-final-spec"}]
        index = builder.pane_index("work", panes, tabs)
        self.assertEqual(index[A]["label"], "leader-alpha")
        self.assertEqual(index[B], {"label": "fm-x12-final-spec", "title": "X12 spec", "herdr": "work", "pane": "w1:p2"})
        self.assertEqual(index[C]["label"], "Review")
        self.assertEqual(len(index), 3)


class HerdrInventoryTest(unittest.TestCase):
    """Every pane Herdr lists is known, with or without an agent in it, and a list that could not be read is not mistaken for a short one."""

    def run_with(self, replies):
        def fake(argv, **kwargs):
            key = tuple(argv[3:5] if argv[1] == "--session" else argv[1:3])
            reply = replies.get(key)
            return mock.Mock(returncode=0 if reply is not None else 1, stdout=json.dumps(reply) if reply is not None else "")
        with mock.patch.object(builder.subprocess, "run", fake), mock.patch.object(builder, "running_claude_sessions", lambda: {}):
            return builder.herdr_inventory()

    def test_a_pane_without_an_agent_is_listed(self):
        panes = [{"pane_id": "w1:p1", "tab_id": "w1:t1", "agent": "claude", "agent_session": {"value": A}},
                 {"pane_id": "w1:p2", "tab_id": "w1:t2", "terminal_title_stripped": "a shell"}]
        replies = {("session", "list"): {"sessions": [{"name": "work", "running": True}, {"name": "-old", "running": True}, {"name": "idle", "running": False}]},
                   ("pane", "list"): {"result": {"panes": panes}}, ("tab", "list"): {"result": {"tabs": []}}}
        sessions, listed = self.run_with(replies)
        self.assertEqual(list(sessions), [A])
        self.assertEqual(listed, {("work", "w1:p1"), ("work", "w1:p2")})

    def test_each_pane_carries_the_life_of_its_herdr_session(self):
        with tempfile.TemporaryDirectory() as folder:
            panes = [{"pane_id": "w1:p1", "tab_id": "w1:t1", "agent": "claude", "agent_session": {"value": A}}]
            replies = {("session", "list"): {"sessions": [{"name": "work", "running": True, "session_dir": folder}]},
                       ("pane", "list"): {"result": {"panes": panes}}, ("tab", "list"): {"result": {"tabs": []}}}
            sessions, _ = self.run_with(replies)
            life = str(os.stat(folder).st_ino)
            self.assertEqual((sessions[A]["life"], builder.HERDR_LIVES), (life, {"work": life}))

    def test_a_herdr_session_that_cannot_be_read_leaves_the_list_unknown(self):
        replies = {("session", "list"): {"sessions": [{"name": "work", "running": True}]}}
        self.assertEqual(self.run_with(replies), ({}, None))

    def test_no_running_herdr_session_lists_no_pane(self):
        self.assertEqual(self.run_with({}), ({}, set()))


class ServingTest(unittest.TestCase):
    """reader.py says which copy of the repo answers on the reader's port."""

    def answer(self, headers=None, error=None, status=404):
        def urlopen(url, timeout=0):
            if error:
                raise error
            raise reader.urllib.error.HTTPError(url, status, "x", headers or {}, io.BytesIO())
        return mock.patch.object(reader.urllib.request, "urlopen", urlopen)

    def test_this_copys_server_is_recognised_by_its_copy_header(self):
        with self.answer({"x-transcript-reader-copy": reader.copy_id(reader.REPO)}):
            self.assertEqual(reader.serving("8768"), (True, "Port 8768 serves this copy of the repo."))

    def test_another_copys_server_is_named_with_where_it_runs(self):
        def run(argv, **kwargs):
            out = {"-tiTCP:8768": "4242\n"}.get(argv[1], "p4242\nfcwd\nn/work/other-copy\n")
            return mock.Mock(stdout=out)
        with self.answer({"x-transcript-reader-copy": "0123456789abcdef"}), mock.patch.object(reader.subprocess, "run", run):
            ok, said = reader.serving("8768")
        self.assertFalse(ok)
        self.assertEqual(said, "Port 8768 serves another copy of the repo (/work/other-copy).")

    def test_nothing_listening_and_a_server_that_is_not_the_reader_are_told_apart(self):
        with self.answer(error=ConnectionRefusedError()):
            self.assertEqual(reader.serving("8768"), (False, "Nothing answers on port 8768."))
        with self.answer({}), mock.patch.object(reader.subprocess, "run", lambda *a, **k: mock.Mock(stdout="")):
            self.assertEqual(reader.serving("8768"), (False, "Port 8768 is used by another server, not a transcript reader."))

    def test_the_default_port_is_the_readers_own(self):
        self.assertEqual(reader.DEFAULT_PORT, "8768")


class ResolveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.projects = Path(self.tmp.name)
        folder = self.projects / "-Users-someone-home"
        folder.mkdir()
        for sid in (A, B, C):
            (folder / f"{sid}.jsonl").write_text("{}\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def resolve(self, name):
        return reader.resolve(name, PANES, self.projects)

    def test_full_id_and_unique_prefix(self):
        self.assertEqual(self.resolve(A), A)
        self.assertEqual(self.resolve("cccccccc"), C)

    def test_ambiguous_prefix_is_refused(self):
        with self.assertRaisesRegex(ValueError, "matches 2 sessions"):
            self.resolve("aaaaaa")

    def test_unknown_full_id_is_refused(self):
        with self.assertRaisesRegex(ValueError, "no session log"):
            self.resolve("dddddddd-4444-4444-8444-444444444444")

    def test_log_path(self):
        self.assertEqual(self.resolve(str(self.projects / "-Users-someone-home" / f"{B}.jsonl")), B)

    def test_exact_label_wins_over_partial(self):
        self.assertEqual(self.resolve("LEADER-ALPHA"), A)

    def test_unique_part_of_label_or_title(self):
        self.assertEqual(self.resolve("final-spec"), B)
        self.assertEqual(self.resolve("review handoff"), C)

    def test_part_matching_several_panes_is_refused(self):
        with self.assertRaisesRegex(ValueError, "several panes"):
            self.resolve("x12")

    def test_no_match(self):
        with self.assertRaisesRegex(ValueError, "no session or Herdr pane"):
            self.resolve("nothing-like-this")


class FollowTest(unittest.TestCase):
    """`follow` is what the server runs for the pane Herdr focuses: a full id with a log, no server start."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "projects" / "-Users-someone-home").mkdir(parents=True)
        (root / "projects" / "-Users-someone-home" / f"{A}.jsonl").write_text("{}\n", encoding="utf-8")
        self.saved = (builder.PROJECTS, reader.OUT, reader.LIST, reader.rebuild)
        builder.PROJECTS, reader.OUT, reader.LIST = root / "projects", root / "out", root / "out" / "sessions.txt"
        self.rebuilds = []
        reader.rebuild = lambda ids, focus=None, serve_page=True: self.rebuilds.append((list(ids), serve_page)) or 0

    def tearDown(self):
        builder.PROJECTS, reader.OUT, reader.LIST, reader.rebuild = self.saved
        self.tmp.cleanup()

    def test_adds_once_and_rebuilds_without_serving(self):
        self.assertEqual(reader.main(["follow", A]), 0)
        self.assertEqual(reader.main(["follow", A]), 0)
        self.assertEqual(reader.read_list(), [A])
        self.assertEqual(self.rebuilds, [([A], False), ([A], False)])

    def test_the_list_reads_full_ids_only(self):
        reader.OUT.mkdir(parents=True)
        reader.LIST.write_text(f"# note\n{A}\n/Users/someone/.zsh_history\naaaaaaaa\n  {B}  \n", encoding="utf-8")
        self.assertEqual(reader.read_list(), [A, B])

    def test_refuses_anything_but_one_full_id_with_a_log(self):
        for names in (["aaaaaaaa"], [C], ["leader-alpha"], [A, A], []):
            self.assertEqual(reader.main(["follow", *names]), 2, names)
        self.assertEqual(reader.read_list(), [])
        self.assertEqual(self.rebuilds, [])


class ClosedPanesTest(unittest.TestCase):
    """A rebuild drops listed sessions whose Herdr pane has closed, and only those."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        folder = root / "projects" / "-Users-someone-home"
        folder.mkdir(parents=True)
        for sid in (A, B, C):
            (folder / f"{sid}.jsonl").write_text("{}\n", encoding="utf-8")
        self.saved = (builder.PROJECTS, builder.herdr_panes, builder.herdr_inventory, builder.session_chain, reader.OUT, reader.LIST, reader.PANE_CACHE,
                      reader.REOPENED, reader.DROPPED)
        builder.PROJECTS, reader.OUT = root / "projects", root / "out"
        reader.LIST, reader.PANE_CACHE, reader.REOPENED = reader.OUT / "sessions.txt", reader.OUT / "pane-labels.json", reader.OUT / "reopened.txt"
        reader.DROPPED = reader.OUT / "dropped.txt"
        reader.OUT.mkdir()
        self.live = {}
        self.listed = "live"  # the panes Herdr lists: those of the live sessions, a set of (Herdr session, pane id), or None (unreadable)
        builder.herdr_panes = lambda: self.live
        builder.herdr_inventory = lambda: (self.live, {(p["herdr"], p["pane"]) for p in self.live.values()} if self.listed == "live" else self.listed)
        self.chains = {}
        builder.session_chain = lambda path: self.chains.get(path.stem, [path])

    def tearDown(self):
        (builder.PROJECTS, builder.herdr_panes, builder.herdr_inventory, builder.session_chain, reader.OUT, reader.LIST, reader.PANE_CACHE,
         reader.REOPENED, reader.DROPPED) = self.saved
        self.tmp.cleanup()

    def seen(self, *ids):
        reader.PANE_CACHE.write_text(json.dumps({sid: PANES.get(sid, PANES[A]) for sid in ids}), encoding="utf-8")

    def test_a_session_seen_in_a_pane_that_no_longer_runs_is_dropped(self):
        self.seen(A, B)
        self.live = {A: PANES[A]}
        self.assertEqual(reader.drop_closed([A, B, C]), [A, C], "B closed; C never ran in a Herdr pane")

    def test_a_cleared_session_stays_while_its_pane_runs_a_later_one(self):
        self.seen(A, B)
        self.live = {C: PANES[C]}
        log = builder.find_session_file
        self.chains[B] = [log(B), log(C)]
        self.assertEqual(reader.drop_closed([A, B]), [B])

    def test_nothing_is_dropped_while_herdr_shows_no_pane(self):
        self.seen(A, B)
        self.assertEqual(reader.drop_closed([A, B]), [A, B])

    def test_a_pane_whose_agent_has_not_come_back_is_not_closed(self):
        # After a Herdr restart the panes are back before their agents: A's pane is at its shell.
        self.seen(A, B)
        self.live = {B: PANES[B]}
        self.listed = {("work", "w1:p1"), ("work", "w1:p2")}
        self.assertEqual(reader.drop_closed([A, B]), [A, B])
        self.assertFalse(reader.DROPPED.exists())
        self.live = {A: PANES[A], B: PANES[B]}
        self.listed = "live"
        self.assertEqual(reader.drop_closed([A, B]), [A, B])

    def test_nothing_is_dropped_while_a_herdr_session_cannot_be_read(self):
        self.seen(A, B)
        self.live = {A: PANES[A]}
        self.listed = None
        self.assertEqual(reader.drop_closed([A, B]), [A, B])

    def test_a_pane_listed_with_no_agent_and_no_live_session_still_keeps_its_sessions(self):
        self.seen(A, B)
        self.listed = {("work", "w1:p1"), ("work", "w1:p2")}
        self.assertEqual(reader.drop_closed([A, B]), [A, B], "Herdr is back with shells only")

    def test_a_pane_id_handed_out_again_by_a_herdr_session_made_anew_is_a_closed_pane(self):
        # "work" was deleted and made again: its new w1:p1 is not the pane A ran in.
        reader.PANE_CACHE.write_text(json.dumps({A: {**PANES[A], "life": "old"}, B: {**PANES[B], "life": "new"}}), encoding="utf-8")
        self.live = {B: {**PANES[B], "life": "new"}}
        self.listed = {("work", "w1:p1"), ("work", "w1:p2")}
        with mock.patch.dict(builder.HERDR_LIVES, {"work": "new"}, clear=True):
            self.assertEqual(reader.drop_closed([A, B]), [B])
        reader.write_list([])
        reader.PANE_CACHE.write_text(json.dumps({A: {**PANES[A], "life": "same"}, B: PANES[B]}), encoding="utf-8")
        with mock.patch.dict(builder.HERDR_LIVES, {"work": "same"}, clear=True):
            self.assertEqual(reader.drop_closed([A, B]), [A, B], "a restart keeps the session's life, and its panes")

    def test_a_cache_entry_without_a_pane_id_closes_with_its_session(self):
        reader.PANE_CACHE.write_text(json.dumps({A: {k: v for k, v in PANES[A].items() if k != "pane"}, B: PANES[B]}), encoding="utf-8")
        self.live = {B: PANES[B]}
        self.assertEqual(reader.drop_closed([A, B]), [B])

    def test_a_dropped_session_that_runs_in_a_pane_again_is_listed_again(self):
        self.seen(A, B)
        self.live = {B: PANES[B]}
        self.assertEqual(reader.drop_closed([A, B]), [B], "its pane id is gone")
        self.assertEqual(builder.read_ids(reader.DROPPED), [A])
        self.assertEqual(reader.drop_closed([B]), [B], "still closed: stays dropped")
        self.live = {B: PANES[B], A: {**PANES[A], "pane": "w1:p9"}}  # claude --resume in a new pane
        self.assertEqual(reader.drop_closed([B]), [B, A])
        self.assertEqual(builder.read_ids(reader.DROPPED), [])

    def test_naming_a_session_to_remove_or_close_it_keeps_it_from_coming_back(self):
        self.seen(A, B)
        self.live = {B: PANES[B]}
        self.assertEqual(reader.drop_closed([A, B]), [B])
        self.live = {B: PANES[B], A: {**PANES[A], "pane": "w1:p9"}}
        with mock.patch.object(reader, "rebuild", lambda ids, focus=None, serve_page=True: 0), mock.patch.object(reader, "resolve", lambda name, panes: name):
            self.assertEqual(reader.main(["remove", A]), 0)
        self.assertEqual(builder.read_ids(reader.DROPPED), [])
        self.assertEqual(reader.drop_closed([B]), [B])

    def test_adding_a_session_whose_pane_has_closed_lists_it_as_reopened_so_the_rebuild_keeps_it(self):
        self.seen(A, B)
        self.live = {A: PANES[A]}
        with mock.patch.object(reader, "rebuild", lambda ids, focus=None, serve_page=True: 0), mock.patch.object(reader, "resolve", lambda name, panes: name):
            self.assertEqual(reader.main(["add", A]), 0)
            self.assertEqual(builder.read_ids(reader.REOPENED), [], "A's pane is live: nothing to reopen")
            with mock.patch("builtins.print") as shown:
                self.assertEqual(reader.main(["add", B]), 0)
        self.assertEqual(reader.read_list(), [A, B])
        self.assertEqual(builder.read_ids(reader.REOPENED), [B])
        self.assertIn("pane has closed", " ".join(str(call.args[0]) for call in shown.call_args_list))
        self.assertEqual(reader.drop_closed([A, B]), [A, B], "the same run's rebuild no longer undoes the add")

    def test_a_rebuild_writes_the_shorter_list(self):
        self.seen(A, B)
        self.live = {A: PANES[A]}
        reader.write_list([A, B])
        with mock.patch.object(reader.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
            self.assertEqual(reader.rebuild(reader.read_list(), serve_page=False), 0)
        self.assertEqual(reader.read_list(), [A])
        self.assertEqual(run.call_args_list[0].args[0][-2:], ["--session", A])

    def test_the_builders_run_one_rebuild_at_a_time(self):
        self.live = {A: PANES[A]}
        held = []

        def build(argv, **kwargs):
            with open(reader.OUT / ".rebuild.lock", "w") as other:
                try:
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    held.append(False)
                except BlockingIOError:
                    held.append(True)  # another rebuild started now would wait here
            return mock.Mock(returncode=0)

        with mock.patch.object(reader.subprocess, "run", side_effect=build):
            self.assertEqual(reader.rebuild([A], serve_page=False), 0)
        self.assertEqual(held, [True, True], "the page and the answer sheet both build under the lock")

    def test_a_reopened_session_stays_until_it_is_closed_with_its_whole_pane(self):
        self.seen(A, B, C)
        self.live = {C: PANES[C]}
        log = builder.find_session_file
        self.chains[A] = self.chains[B] = [log(A), log(B)]
        rebuilds = []
        with mock.patch.object(reader, "rebuild", lambda ids, focus=None, serve_page=True: rebuilds.append((list(ids), serve_page)) or 0):
            self.assertEqual(reader.main(["reopen", A]), 0)
            self.assertEqual(reader.read_list(), [A])
            self.assertEqual(reader.drop_closed([A, B]), [A, B], "both sessions of the reopened pane stay")
            reader.write_list([A, B])
            self.assertEqual(reader.main(["close", B]), 0, "closing the newest session closes the conversation")
        self.assertEqual(reader.read_list(), [])
        self.assertEqual(builder.read_ids(reader.REOPENED), [])
        self.assertEqual(rebuilds, [([A], False)])
        self.assertEqual(reader.drop_closed([A]), [], "closed again, it is dropped like any closed pane")

    def test_reopen_and_close_take_one_full_id(self):
        for command in ("reopen", "close"):
            for names in (["aaaaaaaa"], [A, B], [], ["leader-alpha"]):
                self.assertEqual(reader.main([command, *names]), 2, (command, names))
        self.assertEqual(reader.main(["reopen", "dddddddd-4444-4444-8444-444444444444"]), 2, "no log")
        self.assertEqual(reader.main(["close", C]), 1, "not listed")
        self.assertEqual(reader.read_list(), [])

    def test_closed_panes_offers_recent_logs_of_panes_neither_live_nor_shown(self):
        self.seen(A, B, C)
        old = builder.find_session_file(C)
        os.utime(old, (T0 - 30 * 86400, T0 - 30 * 86400))
        with mock.patch.object(builder.time, "time", return_value=T0):
            for sid in (A, B):
                os.utime(builder.find_session_file(sid), (T0 - 60, T0 - 60))
            offered = builder.closed_panes(reader.PANE_CACHE, {A: PANES[A]}, set())
            self.assertEqual([item["id"] for item in offered], [B], "A is live; C's log is a month old")
            self.assertEqual(offered[0]["label"], PANES[B]["label"])
            self.assertEqual(builder.closed_panes(reader.PANE_CACHE, {A: PANES[A]}, {B}), [], "B is already shown")
            self.assertEqual(builder.closed_panes(reader.PANE_CACHE, {}, set()), [], "no live pane: Herdr is not running")
            # B was cleared into C in the same pane: one entry, the newest.
            os.utime(builder.find_session_file(C), (T0 - 30, T0 - 30))
            reader.PANE_CACHE.write_text(json.dumps({A: PANES[A], B: PANES[B], C: PANES[B]}), encoding="utf-8")
            log = builder.find_session_file
            self.chains[B] = self.chains[C] = [log(B), log(C)]
            self.assertEqual([item["id"] for item in builder.closed_panes(reader.PANE_CACHE, {A: PANES[A]}, set())], [C])

    def test_when_every_pane_has_closed_the_page_keeps_its_last_build(self):
        self.seen(A)
        self.live = {C: PANES[C]}
        reader.write_list([A])
        with mock.patch.object(reader.subprocess, "run") as run:
            self.assertEqual(reader.rebuild(reader.read_list(), serve_page=False), 1)
        self.assertEqual(reader.read_list(), [])
        run.assert_not_called()


class DocumentsTest(unittest.TestCase):
    """A reply's markdown file names resolve to files on disk, by fixed rules."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name).resolve()
        self.repo = self.home / "copy" / "personal"
        self.prd = self.repo / "02-Projects" / "alpha" / "prds" / "x49"
        self.prd.mkdir(parents=True)
        (self.prd / "requirements.md").write_text("# Requirements\n", encoding="utf-8")
        (self.repo / "notes.md").write_text("notes\n", encoding="utf-8")
        patcher = mock.patch.dict(os.environ, {"HOME": str(self.home)})  # Path.home() and ~ both read it
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def names(self, reply, cwd):
        return [(token, path.relative_to(self.home).as_posix()) for token, path in builder.named_documents(reply, str(cwd))]

    def test_a_path_from_the_repository_root_resolves_from_a_deeper_working_directory(self):
        reply = "**Draft:** `02-Projects/alpha/prds/x49/requirements.md` and again 02-Projects/alpha/prds/x49/requirements.md"
        self.assertEqual(self.names(reply, self.repo / "02-Projects" / "alpha"),
                         [("02-Projects/alpha/prds/x49/requirements.md", "copy/personal/02-Projects/alpha/prds/x49/requirements.md")])

    def test_a_bare_name_resolves_under_the_latest_cd_line_before_it(self):
        reply = f"```\ncd {self.home}/elsewhere\n```\n```\ncd {self.prd}\n```\n- `requirements.md`\n- `notes.md`"
        self.assertEqual(self.names(reply, self.repo), [("requirements.md", "copy/personal/02-Projects/alpha/prds/x49/requirements.md"),
                                                        ("notes.md", "copy/personal/notes.md")])

    def test_absolute_and_home_paths_are_taken_as_written(self):
        reply = f"See {self.prd}/requirements.md and ~/copy/personal/notes.md."
        self.assertEqual([path for _, path in self.names(reply, "")], ["copy/personal/02-Projects/alpha/prds/x49/requirements.md", "copy/personal/notes.md"])

    def test_urls_missing_files_other_types_and_folders_above_home_are_left_out(self):
        (self.home.parent / "outside.md").write_text("x", encoding="utf-8")
        self.addCleanup((self.home.parent / "outside.md").unlink)
        reply = "https://example.com/x/notes.md, `gone.md`, `requirements.txt`, `outside.md`, ../outside.md"
        self.assertEqual(self.names(reply, self.repo), [])

    def test_a_file_outside_the_home_and_temp_folders_is_left_out_even_through_a_link(self):
        outside = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, outside)
        (outside / "secret.md").write_text("x", encoding="utf-8")
        (self.repo / "link.md").symlink_to(outside / "secret.md")
        reply = f"See {outside}/secret.md and `link.md`."
        with mock.patch.object(builder, "TEMP_ROOTS", ()):
            self.assertEqual(self.names(reply, self.repo), [])
        self.assertEqual(len(builder.named_documents(reply, str(self.repo))), 1, "a temp folder is allowed; the link resolves into it")

    def test_a_file_over_the_size_cap_is_left_out(self):
        (self.repo / "big.md").write_text("x" * (builder.MAX_DOCUMENT_BYTES + 1), encoding="utf-8")
        self.assertEqual(self.names("`big.md`", self.repo), [])

    def test_attach_gives_turns_document_ids_and_reads_each_file_once(self):
        sessions = [{"exchanges": [{"reply": "`requirements.md`", "cwd": str(self.prd)}, {"reply": "no files", "cwd": str(self.prd)},
                                   {"reply": f"{self.prd}/requirements.md", "cwd": ""}]}]
        documents = builder.attach_documents(sessions)
        first, plain, again = sessions[0]["exchanges"]
        self.assertEqual(len(documents), 1)
        self.assertEqual(first["documents"], again["documents"])
        self.assertNotIn("documents", plain)
        self.assertNotIn("cwd", first)
        doc = documents[first["documents"][0]]
        self.assertEqual((doc["name"], doc["text"], doc["mention"]), ("requirements.md", "# Requirements\n", "requirements.md"))
        self.assertEqual(doc["dir"], "~/copy/personal/02-Projects/alpha/prds/x49")

    def test_tool_calls_name_files_by_path_field_or_from_a_shell_commands_cd(self):
        read = {"file_path": f"{self.prd}/requirements.md"}
        shell = {"command": f"cd {self.repo} && D=context; cat notes.md $D/baseline.md\ncd ~/copy\nsed -n 1p personal/a.md", "description": "x.md"}
        self.assertEqual(builder.tool_documents(read, ""), [f"{self.prd}/requirements.md"])
        # A shell variable is not expanded, so $D/baseline.md names a file that is not there and never matches.
        self.assertEqual(builder.tool_documents(shell, "/elsewhere"),
                         [f"{self.repo}/notes.md", f"{self.repo}/D/baseline.md", f"{self.home}/copy/personal/a.md"])
        self.assertEqual(builder.tool_documents({"command": "cat plan.md"}, "/work"), ["/work/plan.md"])
        self.assertEqual(builder.tool_documents({"command": "cat plan.md"}, ""), [])
        self.assertEqual(builder.tool_documents({"file_path": "/a/b.py"}, ""), [])

    def test_a_short_name_matches_the_latest_file_the_session_touched_before_the_working_directory(self):
        other = self.home / "worktree" / "context"
        other.mkdir(parents=True)
        (other / "notes.md").write_text("other notes\n", encoding="utf-8")
        touched = [f"{self.repo}/notes.md", f"{other}/notes.md", f"{self.home}/gone/requirements.md"]
        self.assertEqual([path.relative_to(self.home).as_posix() for _, path in builder.named_documents("`notes.md:12`, `context/notes.md`, `requirements.md`", str(self.prd), touched)],
                         ["worktree/context/notes.md", "copy/personal/02-Projects/alpha/prds/x49/requirements.md"])

    def test_a_turn_matches_files_touched_in_its_own_and_earlier_turns_only(self):
        far = self.home / "worktree" / "design-baseline.md"
        far.parent.mkdir(parents=True)
        far.write_text("# Baseline\n", encoding="utf-8")
        records = [prompt("first", iso(T0)), reply("`design-baseline.md` is next", T0 + 1),
                   prompt("second", iso(T0 + 10)), tool_use("Edit", {"file_path": str(far)}, T0 + 11), reply("Changed `design-baseline.md`.", T0 + 12),
                   prompt("third", iso(T0 + 20)), reply("Still `design-baseline.md`.", T0 + 21)]
        sessions = [{"exchanges": builder.session_exchanges(records)}]
        builder.attach_documents(sessions)
        before, during, after = sessions[0]["exchanges"]
        self.assertNotIn("documents", before)
        self.assertEqual(during["documents"], after["documents"])
        self.assertNotIn("touched", during)

    def test_a_message_naming_a_file_gets_the_document_too(self):
        # A pasted brief ends with the file's full path; the reply that read it never names it.
        handoff = self.home / "fm" / "data" / "handoffs" / "archive-restore.md"
        handoff.parent.mkdir(parents=True)
        handoff.write_text("# Handoff\n", encoding="utf-8")
        pasted = f'<pasted_content id="5d0f">\nFull description: {handoff}\n</pasted_content id="5d0f">\n'
        wake = f"<task-notification>\nfirstmate watcher wake\nsignal: {self.prd}/requirements.md\n</task-notification>"
        records = [prompt(pasted, iso(T0)), tool_use("Read", {"file_path": str(handoff)}, T0 + 1), reply("Read it. Starting now.", T0 + 2),
                   prompt(wake, iso(T0 + 10)), reply("Nothing new.", T0 + 11)]
        records[3]["origin"] = {"kind": "task-notification"}
        sessions = [{"exchanges": builder.session_exchanges(records)}]
        documents = builder.attach_documents(sessions)
        mine, woke = sessions[0]["exchanges"]
        self.assertEqual([documents[i]["path"] for i in mine["input_documents"]], [str(handoff)])
        self.assertNotIn("documents", mine)
        self.assertNotIn("input_documents", woke)

    def test_a_file_url_names_its_path(self):
        reply = f"Open file://{self.prd}/requirements.md or [notes](file://{self.repo}/notes.md)."
        self.assertEqual([path for _, path in self.names(reply, "")],
                         ["copy/personal/02-Projects/alpha/prds/x49/requirements.md", "copy/personal/notes.md"])


class WritePageTest(unittest.TestCase):
    """The page and its stamp are written together, and never by a build older than the one there."""

    def test_an_older_build_finishing_last_leaves_the_newer_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "prototype.html"
            template = Path(tmp) / "t.html"
            template.write_text("<script>x</script>__PAYLOAD__", encoding="utf-8")
            builder.write_page(template, {"generated": 20.0, "n": "new"}, out)
            builder.write_page(template, {"generated": 10.0, "n": "old"}, out)
            self.assertIn('"new"', out.read_text(encoding="utf-8"))
            self.assertEqual(float(out.with_suffix(".stamp").read_text(encoding="utf-8")), 20.0)
            builder.write_page(template, {"generated": 30.0, "n": "newer"}, out)
            self.assertIn('"newer"', out.read_text(encoding="utf-8"))
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir() if p.name.endswith(".partial")), [])


    def test_the_payload_is_in_the_page_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            for template in (builder.TEMPLATE, builder.HERE / "questionnaire.html"):
                out = Path(tmp) / f"{template.stem}.out.html"
                builder.write_page(template, {"generated": 1.0, "marker": "unique-payload-marker"}, out)
                self.assertEqual(out.read_text(encoding="utf-8").count("unique-payload-marker"), 1, template.name)

    def test_a_template_naming_the_payload_twice_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / "t.html"
            template.write_text("<!-- fills __PAYLOAD__ -->\n<script>x</script>__PAYLOAD__", encoding="utf-8")
            with self.assertRaises(ValueError):
                builder.write_page(template, {"generated": 1.0}, Path(tmp) / "out.html")
            self.assertFalse((Path(tmp) / "out.html").exists())


class PrivateFilesTest(unittest.TestCase):
    """The reader's files carry transcript text, so like Claude's logs they are the owner's alone."""

    def setUp(self):
        self.addCleanup(os.umask, os.umask(0o022))  # the usual default, which would leave them readable by all
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def mode(self, path):
        return os.lstat(path).st_mode & 0o7777

    def test_written_files_and_created_folders_are_owner_only(self):
        target = self.root / "out" / "parsed" / "x.json"
        builder.write_private(target, "private")
        self.assertEqual((self.mode(target), self.mode(target.parent), self.mode(target.parent.parent)), (0o600, 0o700, 0o700))
        older = self.root / "older.txt"
        older.write_text("from before", encoding="utf-8")
        os.chmod(older, 0o644)
        builder.write_private(older, "rewritten")
        self.assertEqual((self.mode(older), older.read_text(encoding="utf-8")), (0o600, "rewritten"))

    def test_the_page_its_stamp_and_a_parsed_log_are_owner_only(self):
        template = self.root / "t.html"
        template.write_text("<script>x</script>__PAYLOAD__", encoding="utf-8")
        out = self.root / "out" / "prototype.html"
        builder.write_page(template, {"generated": 1.0}, out)
        self.assertEqual([self.mode(p) for p in (out.parent, out, out.with_suffix(".stamp"))], [0o700, 0o600, 0o600])
        session = self.root / "s1.jsonl"
        session.write_text(json.dumps(prompt("hello", iso(T0))) + "\n", encoding="utf-8")
        builder.parsed_log(session, out.parent / "parsed")
        self.assertEqual([self.mode(p) for p in (out.parent / "parsed", out.parent / "parsed" / "s1.json")], [0o700, 0o600])

    def test_files_an_earlier_build_left_readable_are_narrowed(self):
        out = self.root / "out"
        (out / "parsed").mkdir(parents=True)
        for name in ("prototype.html", "sessions.txt", "parsed/s1.json"):
            (out / name).write_text("private", encoding="utf-8")
            os.chmod(out / name, 0o644)
        os.chmod(out / "parsed", 0o755)
        os.chmod(out, 0o755)
        elsewhere = self.root / "elsewhere.txt"
        elsewhere.write_text("not the reader's", encoding="utf-8")
        os.chmod(elsewhere, 0o644)
        (out / "link.txt").symlink_to(elsewhere)
        builder.make_private(out)
        self.assertEqual([self.mode(out / n) for n in ("", "parsed", "prototype.html", "sessions.txt", "parsed/s1.json")],
                         [0o700, 0o700, 0o600, 0o600, 0o600])
        self.assertEqual(self.mode(elsewhere), 0o644, "a link's target is not the reader's to change")

    def test_a_rebuild_narrows_out_before_the_builders_run(self):
        saved = (builder.PROJECTS, builder.herdr_inventory, reader.OUT, reader.LIST)
        self.addCleanup(lambda: setattr(builder, "PROJECTS", saved[0]) or setattr(builder, "herdr_inventory", saved[1])
                        or setattr(reader, "OUT", saved[2]) or setattr(reader, "LIST", saved[3]))
        folder = self.root / "projects" / "-Users-someone-home"
        folder.mkdir(parents=True)
        (folder / f"{A}.jsonl").write_text("{}\n", encoding="utf-8")
        builder.PROJECTS, reader.OUT, reader.LIST = self.root / "projects", self.root / "out", self.root / "out" / "sessions.txt"
        builder.herdr_inventory = lambda: ({}, set())
        reader.OUT.mkdir()
        os.chmod(reader.OUT, 0o755)
        old = reader.OUT / "prototype.html"
        old.write_text("private", encoding="utf-8")
        os.chmod(old, 0o644)
        modes = []
        with mock.patch.object(reader.subprocess, "run", side_effect=lambda *a, **k: modes.append((self.mode(reader.OUT), self.mode(old))) or mock.Mock(returncode=0)):
            self.assertEqual(reader.rebuild([A], serve_page=False), 0)
        self.assertEqual(modes, [(0o700, 0o600)] * 2)
        self.assertEqual(self.mode(reader.OUT / ".rebuild.lock"), 0o600)


def log(path, records, written):
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    os.utime(path, (written, written))


def prompt(text, at):
    return {"type": "user", "timestamp": at, "message": {"role": "user", "content": text}}


def reply(text, at, cwd="/nowhere"):
    return {"type": "assistant", "timestamp": iso(at), "cwd": cwd, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def tool_use(name, tool_input, at, cwd="/nowhere"):
    return {"type": "assistant", "timestamp": iso(at), "cwd": cwd,
            "message": {"role": "assistant", "content": [{"type": "tool_use", "name": name, "input": tool_input}]}}


CLEAR = "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"
T0 = 1792000000.0  # 2026-10-15T22:13:20Z


def iso(seconds):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


class ClearedSessionsTest(unittest.TestCase):
    """/clear starts a new log in the same folder; the reader joins them into one conversation."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        projects = mock.patch.object(builder, "PROJECTS", Path(self.tmp.name))
        projects.start()
        self.addCleanup(projects.stop)
        self.folder = Path(self.tmp.name) / "project"
        self.folder.mkdir()
        f = self.folder
        # first ... cleared at T0+100 into second ... cleared at T0+500 into third.
        log(f / "first.jsonl", [prompt("hello", iso(T0))], T0 + 100)
        log(f / "second.jsonl", [{"type": "attachment", "timestamp": iso(T0 + 100)}, prompt("<local-command-caveat>x</local-command-caveat>", iso(T0 + 100)),
                                 prompt(CLEAR, iso(T0 + 100.5)), prompt("next task", iso(T0 + 200))], T0 + 500)
        log(f / "third.jsonl", [prompt(CLEAR, iso(T0 + 500.2)), prompt("go on", iso(T0 + 600))], T0 + 700)
        # A session in the same folder that started fresh, and one written long before the clear.
        log(f / "fresh.jsonl", [prompt("a new task", iso(T0 + 510))], T0 + 900)
        log(f / "old.jsonl", [prompt("old", iso(T0 - 9000))], T0 - 8000)

    def stems(self, name):
        return [p.stem for p in builder.session_chain(self.folder / f"{name}.jsonl")]

    def test_cleared_at_reads_the_clear_command_only_before_the_first_real_prompt(self):
        self.assertEqual(builder.cleared_at(builder.head_records(self.folder / "second.jsonl")), T0 + 100.5)
        self.assertIsNone(builder.cleared_at(builder.head_records(self.folder / "first.jsonl")))
        self.assertIsNone(builder.cleared_at([prompt("hi", iso(T0)), prompt(CLEAR, iso(T0 + 1))]))

    def test_any_session_of_a_pane_gives_the_whole_chain_oldest_first(self):
        for name in ("first", "second", "third"):
            self.assertEqual(self.stems(name), ["first", "second", "third"], name)
        self.assertEqual(self.stems("fresh"), ["fresh"])
        self.assertEqual(self.stems("old"), ["old"])

    def test_no_log_written_near_the_clear_means_no_earlier_session(self):
        os.utime(self.folder / "first.jsonl", (T0 - 3600, T0 - 3600))  # resumed and written later elsewhere
        self.assertEqual(self.stems("third"), ["second", "third"])

    def test_a_clear_after_a_resume_from_another_folder_is_joined_by_its_remote_control_link(self):
        # Resumed from another directory, the session kept its old folder; the /clear started
        # the new log under the current one, so only the shared link ties them together.
        root = Path(self.tmp.name)
        (root / "resumed").mkdir()
        (root / "elsewhere").mkdir()
        bridge = lambda link, at: {"type": "bridge-session", "bridgeSessionId": link, "timestamp": iso(at)}
        log(root / "resumed" / "before.jsonl", [prompt("hello", iso(T0 + 1000)), bridge("cse_01Link", T0 + 1000), bridge("", T0 + 1100)], T0 + 1100)
        log(root / "elsewhere" / "other-link.jsonl", [prompt("another pane", iso(T0 + 1000)), bridge("cse_01Other", T0 + 1000)], T0 + 1100.2)
        log(self.folder / "after.jsonl", [bridge("cse_01Link", T0 + 1100.1), prompt(CLEAR, iso(T0 + 1100.3)), prompt("go on", iso(T0 + 1200))], T0 + 1300)
        log(self.folder / "same-folder.jsonl", [prompt("busy nearby", iso(T0 + 1050))], T0 + 1100.3)
        paths = lambda name: [p.stem for p in builder.session_chain(next(root.glob(f"*/{name}.jsonl")))]
        self.assertEqual(paths("after"), ["before", "after"])
        self.assertEqual(paths("before"), ["before", "after"])
        self.assertEqual(paths("same-folder"), ["same-folder"])

    def test_a_linked_log_may_be_written_up_to_30_seconds_after_the_clear(self):
        link = {"type": "bridge-session", "bridgeSessionId": "cse_01Link", "timestamp": iso(T0 + 2000)}
        log(self.folder / "late.jsonl", [prompt("hello", iso(T0 + 2000)), link], T0 + 2112)
        log(self.folder / "next.jsonl", [link, prompt(CLEAR, iso(T0 + 2100)), prompt("go on", iso(T0 + 2200))], T0 + 2300)
        log(self.folder / "quoted.jsonl", [prompt('the link was "cse_01Link"', iso(T0 + 2000))], T0 + 2101)
        self.assertEqual(self.stems("next"), ["late", "next"])
        self.assertEqual(self.stems("late"), ["late", "next"])
        self.assertEqual(self.stems("quoted"), ["quoted"])

    def test_claude_restarted_in_the_same_pane_joins_the_session_before_it(self):
        # Firstmate swaps a worker's model by starting Claude again in its pane: a fresh log, no /clear.
        f = self.folder
        log(f / "haiku.jsonl", [prompt("the brief", iso(T0 + 3000))], T0 + 3060)
        log(f / "sonnet.jsonl", [prompt("the brief again", iso(T0 + 3135))], T0 + 4000)
        log(f / "much-later.jsonl", [prompt("another task", iso(T0 + 4800))], T0 + 5000)
        log(f / "next-door.jsonl", [prompt("a neighbour", iso(T0 + 3100))], T0 + 3900)
        pane = {"herdr": "work", "pane": "w1:p2", "label": "fm-task"}
        history = {"haiku": {**pane, "pane": ""}, "sonnet": pane, "much-later": pane,
                   "next-door": {**pane, "pane": "w1:p3", "label": "fm-other"}}
        with mock.patch.dict(builder._PANE_HISTORY, history, clear=True):
            self.assertEqual(self.stems("sonnet"), ["haiku", "sonnet"])
            self.assertEqual(self.stems("haiku"), ["haiku", "sonnet"])
            self.assertEqual(self.stems("much-later"), ["much-later"])
            self.assertEqual(self.stems("next-door"), ["next-door"])
        self.assertEqual(self.stems("sonnet"), ["sonnet"], "no pane history, no join")
        # The same pane id in a Herdr session deleted and made again is another pane.
        history = {"haiku": {**pane, "life": "old"}, "sonnet": {**pane, "life": "new"}}
        with mock.patch.dict(builder._PANE_HISTORY, history, clear=True):
            self.assertEqual(self.stems("sonnet"), ["sonnet"])


class PaneSessionTest(unittest.TestCase):
    """Herdr can keep a pane's first session id after Claude restarts in it."""

    running = {101: A, 202: B}

    def info(self, *processes):
        return {"foreground_processes": [dict(zip(("pid", "argv0"), p)) for p in processes]}

    def test_an_id_a_running_claude_holds_is_kept_without_asking(self):
        self.assertEqual(builder.pane_session(A, None, self.running), A)

    def test_a_stale_id_gives_way_to_the_session_of_the_panes_foreground_claude(self):
        self.assertEqual(builder.pane_session(C, self.info((202, "claude")), self.running), B)

    def test_a_pane_back_at_its_shell_runs_no_session(self):
        self.assertIsNone(builder.pane_session(C, self.info((303, "zsh")), self.running))

    def test_without_process_records_herdr_is_taken_at_its_word(self):
        self.assertEqual(builder.pane_session(C, self.info((303, "claude")), self.running), C)
        self.assertEqual(builder.pane_session(C, self.info((202, "claude")), {}), C)


if __name__ == "__main__":
    unittest.main()
