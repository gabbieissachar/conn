"""Tests for reader.py session resolution, the Herdr pane naming it relies on, the
documents a reply names, and the sessions a pane ran across /clear.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_reader.py
Fixtures are synthetic; no real session log or Herdr call is used.
"""

import base64
import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
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
            {"pane_id": "w1:p2", "tab_id": "w1:t2", "label": None, "terminal_title_stripped": "X12 spec", "agent_session": {"value": B},
             "agent_status": "working"},
            {"pane_id": "w1:p3", "tab_id": "w1:t9", "terminal_title_stripped": "Review", "agent_session": {"value": C}},
            {"pane_id": "w1:p4", "tab_id": "w1:t1", "terminal_title_stripped": "a shell, no agent session"},
        ]
        tabs = [{"tab_id": "w1:t1", "label": "leader-alpha"}, {"tab_id": "w1:t2", "label": "fm-x12-final-spec"}]
        index = builder.pane_index("work", panes, tabs)
        self.assertEqual(index[A]["label"], "leader-alpha")
        self.assertEqual(index[B], {"label": "fm-x12-final-spec", "title": "X12 spec", "herdr": "work", "pane": "w1:p2", "status": "working"})
        self.assertEqual(index[C]["label"], "Review")
        self.assertEqual(index[C]["status"], "")  # Herdr said nothing about the agent's state
        self.assertEqual(len(index), 3)

    def test_rollout_filename_is_indexed_by_native_session_id(self):
        native = "01a1a025-b884-78a0-a670-94ebc603c956"
        rollout = "rollout-2026-11-03T13-43-09-" + native
        panes = [{"pane_id": "w1:p1", "tab_id": "w1:t1", "label": "codex", "agent": "codex",
                  "agent_session": {"value": rollout}}]
        index = builder.pane_index("work", panes, [])
        self.assertEqual(list(index), [native])


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

    def test_each_running_herdr_session_carries_when_its_server_started(self):
        with tempfile.TemporaryDirectory() as folder:
            socket = Path(folder) / "herdr.sock"
            socket.write_text("", encoding="utf-8")
            os.utime(socket, (T0, T0))
            panes = [{"pane_id": "w1:p1", "tab_id": "w1:t1", "agent": "claude", "agent_session": {"value": A}}]
            replies = {("session", "list"): {"sessions": [{"name": "work", "running": True, "socket_path": str(socket)},
                                                           {"name": "bare", "running": True, "socket_path": str(Path(folder) / "none.sock")}]},
                       ("pane", "list"): {"result": {"panes": panes}}, ("tab", "list"): {"result": {"tabs": []}}}
            self.run_with(replies)
            self.assertEqual(builder.HERDR_STARTS, {"work": T0}, "a session whose socket cannot be read has no start, so its idle panes are kept")

    def test_a_herdr_session_that_cannot_be_read_leaves_the_list_unknown(self):
        replies = {("session", "list"): {"sessions": [{"name": "work", "running": True}]}}
        self.assertEqual(self.run_with(replies), ({}, None))

    def test_no_running_herdr_session_lists_no_pane(self):
        self.assertEqual(self.run_with({}), ({}, set()))


class EndedAgentTest(unittest.TestCase):
    """The reported bug: a pane whose Claude has exited keeps the session id in Herdr, and that id alone made the session look live.

    The panes are the shapes seen on the owner's Herdr: a Claude that runs (agent named, a running Claude holds the id), two panes
    back at the shell that still hold the id they had (no agent named, state unknown), and one back at the shell that holds none.
    """

    RUNNING, GONE_A, GONE_B = A, B, C

    def inventory(self, foreground, running=None):
        panes = [
            {"pane_id": "w1:p1", "tab_id": "w1:t1", "agent": "claude", "agent_status": "idle", "agent_session": {"value": self.RUNNING}},
            {"pane_id": "w1:p2", "tab_id": "w1:t2", "agent_status": "unknown", "agent_session": {"agent": "claude", "kind": "id", "value": self.GONE_A}},
            {"pane_id": "w1:p3", "tab_id": "w1:t3", "agent_status": "unknown", "agent_session": {"agent": "claude", "kind": "id", "value": self.GONE_B}},
            {"pane_id": "w1:p4", "tab_id": "w1:t4", "agent_status": "unknown"},
        ]
        asked = []

        def fake(argv, **kwargs):
            rest = argv[3:] if argv[1] == "--session" else argv[1:]
            if rest[:2] == ["pane", "process-info"]:
                asked.append(rest[3])
                reply = {"result": {"process_info": {"foreground_processes": foreground.get(rest[3], [])}}}
            else:
                reply = {("session", "list"): {"sessions": [{"name": "work", "running": True}]},
                         ("pane", "list"): {"result": {"panes": panes}}, ("tab", "list"): {"result": {"tabs": []}}}[tuple(rest[:2])]
            return mock.Mock(returncode=0, stdout=json.dumps(reply))

        records = {101: self.RUNNING} if running is None else running
        with mock.patch.object(builder.subprocess, "run", fake), mock.patch.object(builder, "running_claude_sessions", lambda: records):
            return (*builder.herdr_inventory(), asked)

    def test_a_pane_back_at_its_shell_runs_no_session_even_though_herdr_kept_its_id(self):
        shell = lambda pid: [{"pid": pid, "argv0": "zsh"}]
        sessions, listed, asked = self.inventory({"w1:p2": shell(202), "w1:p3": shell(303)})
        self.assertEqual(list(sessions), [self.RUNNING], "only the Claude that runs shows as running")
        self.assertEqual(listed, {("work", f"w1:p{n}") for n in (1, 2, 3, 4)}, "every pane is still listed, so none of its sessions leaves the reading list")
        self.assertEqual(asked, ["w1:p2", "w1:p3"], "a pane whose id a running Claude holds, and one with no id, are not asked about")

    def test_a_kept_id_stays_while_a_claude_runs_in_the_foreground(self):
        # Herdr has not named the agent again yet (after its own restart, say), but Claude is in front.
        sessions, _, _ = self.inventory({"w1:p2": [{"pid": 202, "argv0": "claude"}], "w1:p3": [{"pid": 303, "argv0": "zsh"}]})
        self.assertEqual(sorted(sessions), sorted([self.RUNNING, self.GONE_A]))

    def test_a_kept_id_gives_way_to_the_session_of_the_claude_in_front(self):
        sessions, _, _ = self.inventory({"w1:p2": [{"pid": 202, "argv0": "claude"}], "w1:p3": [{"pid": 303, "argv0": "zsh"}]},
                                        running={101: self.RUNNING, 202: "dddddddd-4444-4444-8444-444444444444"})
        self.assertEqual(sorted(sessions), sorted([self.RUNNING, "dddddddd-4444-4444-8444-444444444444"]))

    def test_without_process_records_herdr_is_taken_at_its_word(self):
        sessions, _, asked = self.inventory({"w1:p2": [{"pid": 202, "argv0": "zsh"}]}, running={})
        self.assertEqual(sorted(sessions), sorted([self.RUNNING, self.GONE_A, self.GONE_B]))
        self.assertEqual(asked, [])


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

    def test_codex_rollout_name_resolves_to_its_native_session_id(self):
        native = "01a1a025-b884-78a0-a670-94ebc603c956"
        rollout = "rollout-2026-11-03T13-43-09-" + native
        codex = self.projects / "codex" / "2026" / "11" / "03"
        codex.mkdir(parents=True)
        (codex / f"{rollout}.jsonl").write_text(json.dumps({
            "type": "session_meta", "payload": {"id": native, "cwd": "/nowhere", "source": "cli"}
        }) + "\n", encoding="utf-8")
        with mock.patch.object(builder, "CODEX_SESSIONS", self.projects / "codex"):
            self.assertEqual(reader.resolve(rollout, PANES, self.projects), native)

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

    def test_the_list_normalizes_a_codex_rollout_name_and_deduplicates_it(self):
        native = "01a1a025-b884-78a0-a670-94ebc603c956"
        rollout = "rollout-2026-11-03T13-43-09-" + native
        reader.OUT.mkdir(parents=True)
        reader.LIST.write_text(f"{rollout}\n{native}\n", encoding="utf-8")
        self.assertEqual(reader.read_list(), [native])

    def test_refuses_anything_but_one_full_id_with_a_log(self):
        for names in (["aaaaaaaa"], [C], ["leader-alpha"], [A, A], []):
            self.assertEqual(reader.main(["follow", *names]), 2, names)
        self.assertEqual(reader.read_list(), [])
        self.assertEqual(self.rebuilds, [])


class TabTest(unittest.TestCase):
    """`tab` is what the page's picker runs for a live Herdr tab the reader lacks: list it and rebuild quickly, answering when the page is built."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        folder = root / "projects" / "-Users-someone-home"
        folder.mkdir(parents=True)
        for sid in (A, B):  # C has no log
            (folder / f"{sid}.jsonl").write_text("{}\n", encoding="utf-8")
        self.saved = (builder.PROJECTS, reader.OUT, reader.LIST, reader.rebuild)
        builder.PROJECTS, reader.OUT = root / "projects", root / "out"
        reader.LIST = reader.OUT / "sessions.txt"
        reader.OUT.mkdir()
        self.rebuilds = []
        reader.rebuild = lambda ids, focus=None, serve_page=True, quick=False: self.rebuilds.append((list(ids), serve_page, quick)) or 0

    def tearDown(self):
        builder.PROJECTS, reader.OUT, reader.LIST, reader.rebuild = self.saved
        self.tmp.cleanup()

    def test_lists_the_one_session_and_asks_for_a_quick_rebuild_that_does_not_serve(self):
        reader.write_list([A])
        self.assertEqual(reader.main(["tab", B]), 0)
        self.assertEqual(reader.read_list(), [A, B])
        self.assertEqual(self.rebuilds, [([A, B], False, True)])
        self.assertEqual(reader.main(["tab", B]), 0)
        self.assertEqual(reader.read_list(), [A, B], "listed once")

    def test_a_close_by_hand_does_not_hold_against_picking_the_tab(self):
        reader.write_list([A])
        reader.mark_closed({B})
        self.assertEqual(builder.read_ids(reader.closed_file()), [B])
        self.assertEqual(reader.main(["tab", B]), 0)
        self.assertEqual(builder.read_ids(reader.closed_file()), [], "picking it is a new yes")
        self.assertEqual(reader.read_list(), [A, B])

    def test_refuses_anything_but_one_full_id_with_a_log(self):
        for names in (["aaaaaaaa"], [C], ["leader-alpha"], [A, B], []):
            self.assertEqual(reader.main(["tab", *names]), 2, names)
        self.assertEqual(reader.read_list(), [])
        self.assertEqual(self.rebuilds, [])

    def test_the_worker_takes_it(self):
        self.assertEqual(reader.worker_request('{"id": 4, "args": ["tab", "%s"]}' % B), (4, ["tab", B]))
        for line in ('{"id": 4, "args": ["tab"]}', '{"id": 4, "args": ["tab", "a", "b"]}'):
            with self.assertRaises(ValueError):
                reader.worker_request(line)


class QuickRebuildTest(unittest.TestCase):
    """A quick rebuild leaves the sweep for closed panes to the next ordinary one, and an ordinary one still does it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        folder = root / "projects" / "-Users-someone-home"
        folder.mkdir(parents=True)
        for sid in (A, B):
            (folder / f"{sid}.jsonl").write_text("{}\n", encoding="utf-8")
        self.saved = (builder.PROJECTS, builder.session_chain, reader.OUT, reader.LIST, reader.PAGE, reader.BUILDERS, reader.drop_closed)
        builder.PROJECTS, reader.OUT = root / "projects", root / "out"
        reader.LIST, reader.PAGE = reader.OUT / "sessions.txt", reader.OUT / "prototype.html"
        reader.OUT.mkdir()
        builder.session_chain = lambda path: [path]
        self.swept = []
        self.built = []
        reader.drop_closed = lambda ids: self.swept.append(list(ids)) or ids
        reader.BUILDERS = lambda page, sheet: self.built.append(page) or 0

    def tearDown(self):
        (builder.PROJECTS, builder.session_chain, reader.OUT, reader.LIST, reader.PAGE, reader.BUILDERS, reader.drop_closed) = self.saved
        self.tmp.cleanup()

    def test_only_the_ordinary_rebuild_sweeps_for_closed_panes(self):
        self.assertEqual(reader.rebuild([A, B], serve_page=False), 0)
        self.assertEqual(self.swept, [[A, B]])
        self.assertEqual(reader.rebuild([A, B], serve_page=False, quick=True), 0)
        self.assertEqual(self.swept, [[A, B]], "the quick one did not")
        self.assertEqual(len(self.built), 2, "but it built the page, with both sessions")
        self.assertEqual(self.built[1].count("--session"), 2)


class AdoptTest(unittest.TestCase):
    """`adopt` is what a Sync runs for the live Claude panes the list lacks; a session a person took off the list stays off."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        folder = root / "projects" / "-Users-someone-home"
        folder.mkdir(parents=True)
        for sid in (A, B):  # C has no log
            (folder / f"{sid}.jsonl").write_text("{}\n", encoding="utf-8")
        self.saved = (builder.PROJECTS, builder.herdr_panes, builder.session_chain, reader.OUT, reader.LIST, reader.REOPENED, reader.DROPPED, reader.rebuild)
        builder.PROJECTS, reader.OUT = root / "projects", root / "out"
        reader.LIST, reader.REOPENED, reader.DROPPED = reader.OUT / "sessions.txt", reader.OUT / "reopened.txt", reader.OUT / "dropped.txt"
        reader.OUT.mkdir()
        builder.herdr_panes = lambda: {}
        builder.session_chain = lambda path: [path]
        self.rebuilds = []
        reader.rebuild = lambda ids, focus=None, serve_page=True: self.rebuilds.append((list(ids), serve_page)) or 0

    def tearDown(self):
        (builder.PROJECTS, builder.herdr_panes, builder.session_chain, reader.OUT, reader.LIST, reader.REOPENED, reader.DROPPED, reader.rebuild) = self.saved
        self.tmp.cleanup()

    def test_lists_the_unlisted_ids_with_a_log_and_rebuilds_once_without_serving(self):
        reader.write_list([A])
        self.assertEqual(reader.main(["adopt", A, B, C, B]), 0)
        self.assertEqual(reader.read_list(), [A, B], "A was listed already, C has no log")
        self.assertEqual(self.rebuilds, [([A, B], False)])

    def test_a_session_a_person_closed_or_removed_is_not_listed_again(self):
        reader.write_list([A, B])
        with mock.patch.object(reader, "resolve", lambda name, panes: name):
            self.assertEqual(reader.main(["remove", A]), 0)
        self.assertEqual(reader.main(["close", B]), 0)
        self.assertEqual(reader.read_list(), [])
        self.assertEqual(sorted(builder.read_ids(reader.closed_file())), sorted([A, B]))
        self.assertEqual(reader.main(["adopt", A, B]), 0)
        self.assertEqual(reader.read_list(), [], "neither comes back with the Sync")

    def test_naming_a_closed_session_again_lets_a_sync_list_it(self):
        reader.write_list([A, B])
        with mock.patch.object(reader, "resolve", lambda name, panes: name):
            reader.main(["remove", A, B])
            self.assertEqual(reader.main(["add", A]), 0)
        self.assertEqual(builder.read_ids(reader.closed_file()), [B])
        self.assertEqual(reader.main(["follow", B]), 0)
        self.assertEqual(builder.read_ids(reader.closed_file()), [])
        reader.main(["close", B])
        self.assertEqual(builder.read_ids(reader.closed_file()), [B])
        self.assertEqual(reader.main(["reopen", B]), 0)
        self.assertEqual(builder.read_ids(reader.closed_file()), [])

    def test_closing_takes_the_whole_pane_so_a_cleared_session_is_not_adopted_either(self):
        reader.write_list([B])
        folder = builder.PROJECTS / "-Users-someone-home"
        builder.session_chain = lambda path: [folder / f"{A}.jsonl", folder / f"{B}.jsonl"]
        self.assertEqual(reader.main(["close", B]), 0)
        self.assertEqual(sorted(builder.read_ids(reader.closed_file())), sorted([A, B]))

    def test_a_closed_session_whose_log_is_gone_is_forgotten(self):
        reader.write_ids(reader.closed_file(), [C, A])  # C has no log
        reader.mark_closed({B})
        self.assertEqual(builder.read_ids(reader.closed_file()), [A, B])

    def test_refuses_anything_but_full_ids(self):
        for names in ([], ["aaaaaaaa"], [A, "leader-alpha"]):
            self.assertEqual(reader.main(["adopt", *names]), 2, names)
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

    def test_a_pane_that_runs_another_session_now_no_longer_runs_this_one(self):
        # A ran in w1:p1 and its log was never joined to B's, which runs there now: A is not running, though its pane is listed.
        self.seen(A)
        self.live = {B: {**PANES[B], "pane": "w1:p1"}}
        self.listed = {("work", "w1:p1")}
        view = reader.PaneView()
        self.assertEqual(view.why_closed(A), "its pane runs another session now")
        self.assertEqual(reader.drop_closed([A]), [])
        self.assertEqual(builder.read_ids(reader.DROPPED), [A], "and it is offered under Closed panes, listed again if it runs again")

    def test_a_pane_that_runs_a_session_with_no_log_yet_has_not_left_its_session(self):
        # A /clear: the pane runs a new session before that session's log exists. Dropping A now would take the conversation off the list at
        # the moment it is about to continue, and nothing would list the new session when its log appears.
        self.seen(A)
        fresh = "dddddddd-4444-4444-8444-444444444444"  # no log under projects/
        self.live = {fresh: {**PANES[B], "pane": "w1:p1"}}
        self.listed = {("work", "w1:p1")}
        view = reader.PaneView()
        self.assertIsNone(view.why_closed(A), "its pane runs a session the reader cannot read yet")
        self.assertEqual(reader.drop_closed([A]), [A])
        self.assertFalse(reader.DROPPED.exists())
        # Once that session has a log that is not A's conversation, the pane has moved on, as it always did.
        (builder.PROJECTS / "-Users-someone-home" / f"{fresh}.jsonl").write_text("{}\n", encoding="utf-8")
        builder._LOG_INDEX.clear()  # the worker forgets which logs exist before every request
        self.assertEqual(reader.PaneView().why_closed(A), "its pane runs another session now")

    def test_a_cleared_session_stays_while_a_later_session_of_its_conversation_runs_in_the_pane(self):
        folder = builder.PROJECTS / "-Users-someone-home"
        self.chains = {A: [folder / f"{A}.jsonl", folder / f"{B}.jsonl"]}
        self.seen(A)
        self.live = {B: {**PANES[B], "pane": "w1:p1"}}
        self.listed = {("work", "w1:p1")}
        self.assertEqual(reader.drop_closed([A]), [A], "B is A's own conversation")

    def test_a_pane_without_an_agent_keeps_its_session_for_the_grace_after_its_herdr_server_starts_and_not_beyond(self):
        self.seen(A)
        self.live = {B: PANES[B]}
        self.listed = {("work", "w1:p1"), ("work", "w1:p2")}  # A's pane is listed and runs nothing
        for started, kept in ((time.time() - 60, [A]), (time.time() - reader.HERDR_GRACE - 60, []), (None, [A])):
            with mock.patch.dict(builder.HERDR_STARTS, {} if started is None else {"work": started}, clear=True):
                self.assertEqual(reader.PaneView().why_closed(A), None if kept else "its pane runs no agent", started)
                self.assertEqual(reader.drop_closed([A]), kept, started)

    def test_a_pane_that_runs_its_session_is_never_taken_for_stopped_however_old_its_server(self):
        self.seen(A)
        self.live = {A: PANES[A]}
        with mock.patch.dict(builder.HERDR_STARTS, {"work": time.time() - 10 * reader.HERDR_GRACE}, clear=True):
            self.assertEqual(reader.drop_closed([A]), [A])

    def test_a_session_reopened_by_hand_stays_listed_whatever_its_pane_runs(self):
        self.seen(A)
        self.live = {B: {**PANES[B], "pane": "w1:p1"}}
        self.listed = {("work", "w1:p1")}
        reader.write_ids(reader.REOPENED, [A])
        self.assertEqual(reader.drop_closed([A]), [A])

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

    def test_closing_a_dropped_session_keeps_it_from_being_listed_again(self):
        self.seen(A, B)
        self.live = {B: PANES[B]}
        self.assertEqual(reader.drop_closed([A, B]), [B])
        self.assertEqual(builder.read_ids(reader.DROPPED), [A])
        reader.write_list([B])
        self.assertEqual(reader.main(["close", A]), 0)
        self.assertEqual(builder.read_ids(reader.DROPPED), [])
        self.live = {A: {**PANES[A], "pane": "w1:p9"}, B: PANES[B]}  # A resumed in a new pane
        self.assertEqual(reader.drop_closed([B]), [B])

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

    def test_the_dropped_record_walks_only_live_chains_and_forgets_old_logs(self):
        self.seen(A, B, C)
        self.live = {C: PANES[C]}
        self.assertEqual(reader.drop_closed([A, B, C]), [C])
        self.assertEqual(builder.read_ids(reader.DROPPED), [A, B])
        walked = []
        chain = builder.session_chain
        builder.session_chain = lambda path: walked.append(path.stem) or chain(path)
        old = time.time() - (reader.DROPPED_KEEP_DAYS + 1) * 86400
        os.utime(builder.find_session_file(A), (old, old))
        with mock.patch.object(builder, "LOG_LIST_REUSE", 0):
            self.assertEqual(reader.drop_closed([C]), [C])
        self.assertEqual(set(walked), {C}, "the live session's chain (also the listed one), not each dropped one's")
        self.assertEqual(builder.read_ids(reader.DROPPED), [B], "A's log is older than the record keeps")

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
        self.assertEqual(rebuilds, [([A], False), ([], False)], "closing the last one builds a page with none")
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

    def test_when_every_pane_has_closed_the_page_is_built_with_none_and_that_is_no_failure(self):
        # The page then keeps the conversation on screen as a closed pane, and offers it under Closed panes.
        self.seen(A)
        self.live = {C: PANES[C]}
        reader.write_list([A])
        with mock.patch.object(reader.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
            self.assertEqual(reader.rebuild(reader.read_list(), serve_page=False), 0)
            self.assertEqual(reader.read_list(), [])
            self.assertEqual(run.call_args_list[0].args[0][-3:], ["--out", str(reader.PAGE), "--listed"])
            self.assertEqual(reader.rebuild([], serve_page=False), 0, "nor is a list that was empty already")


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


class HtmlFilesTest(unittest.TestCase):
    """An HTML file a reply names resolves like a markdown file, by the same rules, but is listed and never read."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name).resolve()
        self.sketches = self.home / "scratch" / "sketches"
        self.sketches.mkdir(parents=True)
        (self.sketches / "region.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
        (self.sketches / "old.htm").write_text("<p>old</p>", encoding="utf-8")
        (self.sketches / "notes.md").write_text("# Notes\n", encoding="utf-8")
        patcher = mock.patch.dict(os.environ, {"HOME": str(self.home)})  # Path.home() and ~ both read it
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def names(self, reply, cwd="", touched=()):
        return [(token, path.relative_to(self.home).as_posix()) for _, token, path in builder.named_html(reply, str(cwd), list(touched))]

    def test_a_path_a_short_name_and_a_file_url_resolve_as_a_markdown_file_does(self):
        reply = f"Open {self.sketches}/region.html, then\ncd {self.sketches}\n`old.htm` or file://{self.sketches}/region.html and ~/scratch/sketches/old.htm."
        self.assertEqual(self.names(reply), [(f"{self.sketches}/region.html", "scratch/sketches/region.html"), ("old.htm", "scratch/sketches/old.htm")])
        self.assertEqual(self.names("`region.html`", self.sketches), [("region.html", "scratch/sketches/region.html")])
        self.assertEqual(self.names("`region.html`", "/elsewhere", [f"{self.sketches}/region.html"]), [("region.html", "scratch/sketches/region.html")])
        self.assertEqual(self.names("`sketches/region.html`", self.home / "scratch" / "deeper"), [("sketches/region.html", "scratch/sketches/region.html")], "found from a parent of the working directory")

    def test_urls_missing_files_other_types_and_markdown_are_left_out(self):
        reply = "https://example.com/x/region.html, `gone.html`, `region.txt`, `notes.md`, `region.html5`"
        self.assertEqual(self.names(reply, self.sketches), [])

    def test_a_file_outside_the_home_and_temp_folders_is_left_out_even_through_a_link(self):
        outside = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, outside)
        (outside / "secret.html").write_text("x", encoding="utf-8")
        (self.sketches / "link.html").symlink_to(outside / "secret.html")
        reply = f"See {outside}/secret.html and `link.html`."
        with mock.patch.object(builder, "TEMP_ROOTS", ()):
            self.assertEqual(builder.named_html(reply, str(self.sketches)), [])
        self.assertEqual(len(builder.named_html(reply, str(self.sketches))), 1, "a temp folder is allowed; the link resolves into it")

    def test_the_size_limit_is_the_html_one_not_the_markdown_one(self):
        (self.sketches / "big.html").write_text("x" * (builder.MAX_DOCUMENT_BYTES + 1), encoding="utf-8")
        self.assertEqual(self.names("`big.html`", self.sketches), [("big.html", "scratch/sketches/big.html")])
        with mock.patch.object(builder, "MAX_HTML_BYTES", 100):
            self.assertEqual(self.names("`big.html`, `region.html`", self.sketches), [("region.html", "scratch/sketches/region.html")])

    def test_attach_lists_html_files_as_text_less_documents_only_when_asked_in_the_order_named(self):
        reply = f"First `notes.md`, then {self.sketches}/region.html, and `old.htm`."
        sessions = lambda: [{"exchanges": [{"reply": reply, "cwd": str(self.sketches)}]}]
        plain = sessions()
        self.assertEqual([doc["name"] for doc in builder.attach_documents(plain).values()], ["notes.md"], "the hosted copy's build is unchanged")
        both = sessions()
        documents = builder.attach_documents(both, html=True)
        ids = both[0]["exchanges"][0]["documents"]
        self.assertEqual([documents[i]["name"] for i in ids], ["notes.md", "region.html", "old.htm"])
        region = documents[ids[1]]
        self.assertEqual((region["kind"], region["size"], region["path"], region["dir"]), ("html", len("<!doctype html><title>x</title>"), str(self.sketches / "region.html"), "~/scratch/sketches"))
        self.assertNotIn("text", region)
        self.assertNotIn("kind", documents[ids[0]])
        self.assertEqual(documents[ids[0]]["text"], "# Notes\n")

    def test_a_message_naming_an_html_file_gets_it_too(self):
        records = [prompt(f"Look at {self.sketches}/region.html please", iso(T0)), reply("Looking.", T0 + 1)]
        sessions = [{"exchanges": builder.session_exchanges(records)}]
        documents = builder.attach_documents(sessions, html=True)
        self.assertEqual([documents[i]["name"] for i in sessions[0]["exchanges"][0]["input_documents"]], ["region.html"])

    def test_tool_calls_name_html_files_by_path_field_or_from_a_shell_command(self):
        self.assertEqual(builder.tool_documents({"file_path": f"{self.sketches}/region.html"}, ""), [f"{self.sketches}/region.html"])
        self.assertEqual(builder.tool_documents({"command": f"cd {self.sketches} && open region.html && cat notes.md"}, ""),
                         [f"{self.sketches}/notes.md", f"{self.sketches}/region.html"])
        self.assertEqual(builder.tool_documents({"file_path": "/a/b.py"}, ""), [])

    def test_a_turn_matches_an_html_file_its_own_tool_call_wrote(self):
        far = self.home / "worktree" / "sketch.html"
        far.parent.mkdir(parents=True)
        far.write_text("<p>x</p>", encoding="utf-8")
        records = [prompt("draw", iso(T0)), tool_use("Write", {"file_path": str(far)}, T0 + 1), reply("Wrote `sketch.html`.", T0 + 2)]
        sessions = [{"exchanges": builder.session_exchanges(records)}]
        documents = builder.attach_documents(sessions, html=True)
        self.assertEqual([documents[i]["path"] for i in sessions[0]["exchanges"][0]["documents"]], [str(far)])


class ImageFilesTest(unittest.TestCase):
    """An image file a reply names resolves like a markdown or HTML file, by the same name and location rules, with its own size limit."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name).resolve()
        self.shots = self.home / "scratch" / "shots"
        self.shots.mkdir(parents=True)
        for name in ("home.png", "photo.JPG", "pic.jpeg", "anim.gif", "wide.webp", "mark.svg", "old.bmp", "notes.txt"):
            (self.shots / name).write_bytes(b"x" * 10)
        (self.shots / "notes.md").write_text("# Notes\n", encoding="utf-8")
        patcher = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def names(self, reply, cwd="", touched=()):
        return [(token, path.relative_to(self.home).as_posix()) for _, token, path in builder.named_images(reply, str(cwd), list(touched))]

    def test_the_six_types_resolve_in_any_case_by_path_short_name_cd_and_file_url(self):
        reply = f"Shots: {self.shots}/home.png, then\ncd {self.shots}\n`photo.JPG` `pic.jpeg` file://{self.shots}/anim.gif ~/scratch/shots/wide.webp and mark.svg."
        self.assertEqual([path for _, path in self.names(reply)], [f"scratch/shots/{n}" for n in ("home.png", "photo.JPG", "pic.jpeg", "anim.gif", "wide.webp", "mark.svg")])
        self.assertEqual(self.names("`home.png`", self.shots), [("home.png", "scratch/shots/home.png")])
        self.assertEqual(self.names("`home.png`", "/elsewhere", [f"{self.shots}/home.png"]), [("home.png", "scratch/shots/home.png")], "by a path the session's tool calls named")
        self.assertEqual(self.names("`shots/home.png`", self.home / "scratch" / "deeper"), [("shots/home.png", "scratch/shots/home.png")], "from a parent of the working directory")

    def test_urls_missing_files_other_types_and_other_documents_are_left_out(self):
        reply = "https://example.com/x/home.png, `gone.png`, `old.bmp`, `notes.txt`, `notes.md`, `home.png5`, `home.pngx`"
        self.assertEqual(self.names(reply, self.shots), [])

    def test_a_file_outside_the_home_and_temp_folders_is_left_out_even_through_a_link(self):
        outside = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, outside)
        (outside / "secret.png").write_bytes(b"x")
        (self.shots / "link.png").symlink_to(outside / "secret.png")
        reply = f"See {outside}/secret.png and `link.png`."
        with mock.patch.object(builder, "TEMP_ROOTS", ()):
            self.assertEqual(builder.named_images(reply, str(self.shots)), [])
        self.assertEqual(len(builder.named_images(reply, str(self.shots))), 1, "a temp folder is allowed; the link resolves into it")

    def test_the_size_limit_is_the_image_one(self):
        self.assertEqual(builder.MAX_IMAGE_BYTES, 10 * 1024 * 1024)
        (self.shots / "big.png").write_bytes(b"x" * (builder.MAX_HTML_BYTES + 1))
        self.assertEqual(self.names("`big.png`", self.shots), [("big.png", "scratch/shots/big.png")], "over the HTML limit, under the image one")
        with mock.patch.object(builder, "MAX_IMAGE_BYTES", 100):
            self.assertEqual(self.names("`big.png`, `home.png`", self.shots), [("home.png", "scratch/shots/home.png")])
        (self.shots / "huge.png").write_bytes(b"x" * (builder.MAX_IMAGE_BYTES + 1))
        self.assertEqual(self.names("`huge.png`", self.shots), [])

    def test_attach_lists_images_as_text_less_documents_only_when_asked_in_the_order_named(self):
        reply = f"First `notes.md`, then {self.shots}/home.png, and `mark.svg`."
        sessions = lambda: [{"exchanges": [{"reply": reply, "cwd": str(self.shots)}]}]
        plain = sessions()
        self.assertEqual([doc["name"] for doc in builder.attach_documents(plain, html=True).values()], ["notes.md"], "off unless asked")
        both = sessions()
        documents = builder.attach_documents(both, html=True, images=True)
        ids = both[0]["exchanges"][0]["documents"]
        self.assertEqual([documents[i]["name"] for i in ids], ["notes.md", "home.png", "mark.svg"])
        home = documents[ids[1]]
        self.assertEqual((home["kind"], home["size"], home["path"], home["dir"]), ("image", 10, str(self.shots / "home.png"), "~/scratch/shots"))
        self.assertNotIn("text", home)
        self.assertNotIn("kind", documents[ids[0]])

    def test_a_message_naming_an_image_gets_it_too(self):
        records = [prompt(f"Look at {self.shots}/home.png please", iso(T0)), reply("Looking.", T0 + 1)]
        sessions = [{"exchanges": builder.session_exchanges(records)}]
        documents = builder.attach_documents(sessions, images=True)
        self.assertEqual([documents[i]["name"] for i in sessions[0]["exchanges"][0]["input_documents"]], ["home.png"])

    def test_tool_calls_name_images_by_path_field_or_from_a_shell_command(self):
        self.assertEqual(builder.tool_documents({"file_path": f"{self.shots}/home.png"}, ""), [f"{self.shots}/home.png"])
        self.assertEqual(builder.tool_documents({"command": f"cd {self.shots} && chrome-devtools-axi screenshot home.png --full && cat notes.md"}, ""),
                         [f"{self.shots}/notes.md", f"{self.shots}/home.png"])
        self.assertEqual(builder.tool_documents({"file_path": "/a/b.py"}, ""), [])

    def test_a_turn_matches_an_image_its_own_tool_call_wrote(self):
        far = self.home / "worktree" / "after.png"
        far.parent.mkdir(parents=True)
        far.write_bytes(b"x")
        records = [prompt("check", iso(T0)), tool_use("Bash", {"command": f"chrome-devtools-axi screenshot {far}"}, T0 + 1), reply("Saved `after.png`.", T0 + 2)]
        sessions = [{"exchanges": builder.session_exchanges(records)}]
        documents = builder.attach_documents(sessions, images=True)
        self.assertEqual([documents[i]["path"] for i in sessions[0]["exchanges"][0]["documents"]], [str(far)])


class EmbeddedImagesTest(unittest.TestCase):
    """A markdown document that shows a picture (`![](path)` or `<img src>`, from its own folder) lists it in Documents, though no reply names the file."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name).resolve()
        self.prd = self.home / "prds" / "bc49"
        (self.prd / "screens").mkdir(parents=True)
        for name in ("l2.png", "l3.png", "my esim.PNG", "flow.svg", "old.bmp"):
            (self.prd / "screens" / name).write_bytes(b"x" * 10)
        (self.home / "banner.jpg").write_bytes(b"x" * 10)
        self.doc = self.prd / "release-1.md"
        self.write_doc("# R1\n\n<table><tr><td><img src=\"screens/l2.png\" width=\"280\" alt=\"L2\"></td></tr></table>\n\n![L3](screens/l3.png)\n")
        patcher = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def write_doc(self, text):
        self.doc.write_text(text, encoding="utf-8")

    def listed(self, reply="Updated `release-1.md`.", cwd=None, images=True):
        sessions = [{"exchanges": [{"reply": reply, "cwd": str(cwd or self.home)}]}]
        documents = builder.attach_documents(sessions, html=True, images=images)
        return [(documents[i]["name"], documents[i].get("kind", "")) for i in sessions[0]["exchanges"][0].get("documents", [])], documents

    def test_the_pictures_follow_the_document_in_the_order_it_shows_them(self):
        listed, documents = self.listed(cwd=self.prd)
        self.assertEqual(listed, [("release-1.md", ""), ("l2.png", "image"), ("l3.png", "image")])
        l2 = next(d for d in documents.values() if d["name"] == "l2.png")
        self.assertEqual((l2["kind"], l2["size"], l2["path"], l2["dir"], l2["mention"]), ("image", 10, str(self.prd / "screens" / "l2.png"), "~/prds/bc49/screens", "screens/l2.png"))
        self.assertNotIn("text", l2)

    def test_the_path_starts_at_the_documents_folder_not_the_turns_working_directory(self):
        self.assertEqual(self.listed(f"Updated {self.doc}.", cwd="/elsewhere")[0], [("release-1.md", ""), ("l2.png", "image"), ("l3.png", "image")])

    def test_off_unless_images_are_asked_for(self):
        self.assertEqual(self.listed(cwd=self.prd, images=False)[0], [("release-1.md", "")])

    def test_only_files_that_exist_under_the_home_or_temp_folders_and_are_images_count(self):
        outside = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, outside)
        (outside / "secret.png").write_bytes(b"x")
        self.write_doc("\n".join([
            "![a](https://example.com/a.png) ![b](//example.com/b.png) ![c](data:image/png;base64,AAAA)",
            "![gone](screens/gone.png) ![bmp](screens/old.bmp) ![doc](release-1.md) [link](screens/l2.png)",
            f"![out]({outside}/secret.png) <img src=\"/no/such/dir/x.png\"> <img alt=\"no source\">",
        ]))
        with mock.patch.object(builder, "TEMP_ROOTS", ()):
            self.assertEqual(self.listed(cwd=self.prd)[0], [("release-1.md", "")], "a plain link is not a picture")
        self.assertEqual(self.listed(cwd=self.prd)[0], [("release-1.md", ""), ("secret.png", "image")], "a temp folder is allowed")

    def test_absolute_and_home_paths_parent_folders_spaces_queries_and_titles_resolve(self):
        self.write_doc("\n".join([
            f"![a]({self.prd}/screens/l2.png)", "![b](~/banner.jpg)", "![c](../../banner.jpg)", "![d](screens/my%20esim.PNG)",
            "![e](<screens/my esim.PNG>)", "![f](screens/flow.svg?v=2#top \"a title\")", "<img SRC='screens/l3.png'>",
        ]))
        self.assertEqual([name for name, _ in self.listed(cwd=self.prd)[0]], ["release-1.md", "l2.png", "banner.jpg", "my esim.PNG", "flow.svg", "l3.png"], "each file once")

    def test_the_size_limit_is_the_image_one(self):
        (self.prd / "screens" / "big.png").write_bytes(b"x" * (builder.MAX_HTML_BYTES + 1))
        self.write_doc("![big](screens/big.png) ![l2](screens/l2.png)")
        self.assertEqual([name for name, _ in self.listed(cwd=self.prd)[0]], ["release-1.md", "big.png", "l2.png"])
        with mock.patch.object(builder, "MAX_IMAGE_BYTES", 100):
            (self.prd / "screens" / "big.png").write_bytes(b"x" * 101)
            self.assertEqual([name for name, _ in self.listed(cwd=self.prd)[0]], ["release-1.md", "l2.png"])

    def test_a_picture_the_reply_also_names_is_listed_once_and_later_turns_get_the_pictures_too(self):
        sessions = [{"exchanges": [{"reply": f"See {self.doc} and screens/l3.png.", "cwd": str(self.prd)}, {"reply": "Again `release-1.md`.", "cwd": str(self.prd)}]}]
        documents = builder.attach_documents(sessions, images=True)
        first, second = (exchange["documents"] for exchange in sessions[0]["exchanges"])
        self.assertEqual([documents[i]["name"] for i in first], ["release-1.md", "l2.png", "l3.png"], "the document's pictures follow it, the one the reply also names included")
        self.assertEqual([documents[i]["name"] for i in second], ["release-1.md", "l2.png", "l3.png"])

    def test_a_message_naming_the_document_gets_its_pictures_too(self):
        records = [prompt(f"Check {self.doc} please", iso(T0)), reply("Looking.", T0 + 1)]
        sessions = [{"exchanges": builder.session_exchanges(records)}]
        documents = builder.attach_documents(sessions, images=True)
        self.assertEqual([documents[i]["name"] for i in sessions[0]["exchanges"][0]["input_documents"]], ["release-1.md", "l2.png", "l3.png"])

    def test_a_document_with_thousands_of_pictures_names_is_quick(self):
        import time
        self.write_doc("![x](" + "a" * 200_000 + ".png) " + "<img " * 20_000 + "![](screens/l2.png)")
        started = time.monotonic()
        self.assertEqual([name for name, _ in self.listed(cwd=self.prd)[0]], ["release-1.md", "l2.png"])
        self.assertLess(time.monotonic() - started, 2.0)


class ImageNamesTest(unittest.TestCase):
    """image_mentions finds what the IMAGE_MENTION regex finds, without the regex's backtracking, and the md and html ones are as they were."""

    def test_the_same_names_as_the_regex(self):
        import random
        rng = random.Random(7)
        for _ in range(5000):
            text = "".join(rng.choice("ab.pngjegwsvIPG-_/~@+ \n:\u00e9`1") for _ in range(rng.randrange(0, 40)))
            self.assertEqual(list(builder.image_mentions(text)), [(m.start(), m.group(0)) for m in builder.IMAGE_MENTION.finditer(text)], repr(text))

    def test_a_long_run_of_name_characters_is_quick(self):
        import time
        started = time.monotonic()
        found = list(builder.image_mentions("a" * 200_000 + ".png" * 20_000 + " see page.svg"))
        self.assertEqual(found[-1], (len("a" * 200_000 + ".png" * 20_000) + 5, "page.svg"))
        self.assertLess(time.monotonic() - started, 2.0)

    def test_the_markdown_and_html_names_are_unchanged_by_it(self):
        self.assertEqual(list(builder.md_mentions("a.md b.png")), [(0, "a.md")])
        self.assertEqual(list(builder.html_mentions("a.html b.png c.htm")), [(0, "a.html"), (13, "c.htm")])


class HtmlNamesTest(unittest.TestCase):
    """html_mentions finds what the HTML_MENTION regex finds, without the regex's backtracking."""

    def test_the_same_names_as_the_regex(self):
        import random
        rng = random.Random(5)
        for _ in range(5000):
            text = "".join(rng.choice("ab.htmlx-_/~@+ \n:\u00e9`1") for _ in range(rng.randrange(0, 40)))
            self.assertEqual(list(builder.html_mentions(text)), [(m.start(), m.group(0)) for m in builder.HTML_MENTION.finditer(text)], repr(text))

    def test_a_long_run_of_name_characters_is_quick(self):
        import time
        started = time.monotonic()
        found = list(builder.html_mentions("a" * 200_000 + ".htm" * 20_000 + " see page.html"))
        self.assertEqual(found[-1], (len("a" * 200_000 + ".htm" * 20_000) + 5, "page.html"))
        self.assertLess(time.monotonic() - started, 2.0)


class MarkdownNamesTest(unittest.TestCase):
    """md_mentions finds what the MD_MENTION regex finds, without the regex's backtracking."""

    def test_the_same_names_as_the_regex(self):
        import random
        rng = random.Random(3)
        for _ in range(5000):
            text = "".join(rng.choice("ab.md-_/~@+ \n:\u00e9`x1") for _ in range(rng.randrange(0, 40)))
            self.assertEqual(list(builder.md_mentions(text)), [(m.start(), m.group(0)) for m in builder.MD_MENTION.finditer(text)], repr(text))

    def test_a_long_run_of_name_characters_is_quick(self):
        import time
        started = time.monotonic()
        found = list(builder.md_mentions("a" * 200_000 + " see notes.md"))
        self.assertEqual(found, [(200_005, "notes.md")])
        self.assertLess(time.monotonic() - started, 1.0)


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


    def test_the_html_files_a_page_offers_are_listed_beside_it_for_the_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "prototype.html"
            template = Path(tmp) / "t.html"
            template.write_text("<script>x</script>__PAYLOAD__", encoding="utf-8")
            documents = {"a1": {"id": "a1", "path": "/p/a.md", "text": "t"}, "b2": {"id": "b2", "path": "/p/b.html", "kind": "html"}}
            builder.write_page(template, {"generated": 20.0, "documents": documents}, out)
            listing = Path(tmp) / builder.HTML_FILES
            self.assertEqual(json.loads(listing.read_text(encoding="utf-8")), {"b2": "/p/b.html"}, "markdown is embedded, so only HTML is listed")
            self.assertEqual(listing.stat().st_mode & 0o777, 0o600)
            builder.write_page(template, {"generated": 10.0, "documents": {}}, out)
            self.assertEqual(json.loads(listing.read_text(encoding="utf-8")), {"b2": "/p/b.html"}, "a build older than the page leaves its list")
            builder.write_page(template, {"generated": 30.0, "documents": {}}, out)
            self.assertEqual(json.loads(listing.read_text(encoding="utf-8")), {})
            builder.write_page(template, {"generated": 40.0}, out)  # the answer sheet has no documents and leaves the list alone
            self.assertEqual(json.loads(listing.read_text(encoding="utf-8")), {})

    def test_the_image_files_a_page_offers_are_listed_beside_it_in_their_own_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "prototype.html"
            template = Path(tmp) / "t.html"
            template.write_text("<script>x</script>__PAYLOAD__", encoding="utf-8")
            documents = {"a1": {"id": "a1", "path": "/p/a.md", "text": "t"}, "b2": {"id": "b2", "path": "/p/b.html", "kind": "html"}, "c3": {"id": "c3", "path": "/p/c.png", "kind": "image"}}
            builder.write_page(template, {"generated": 20.0, "documents": documents}, out)
            self.assertEqual(json.loads((Path(tmp) / builder.IMAGE_FILES).read_text(encoding="utf-8")), {"c3": "/p/c.png"})
            self.assertEqual(json.loads((Path(tmp) / builder.HTML_FILES).read_text(encoding="utf-8")), {"b2": "/p/b.html"}, "an image never opens as an HTML file")
            self.assertEqual((Path(tmp) / builder.IMAGE_FILES).stat().st_mode & 0o777, 0o600)

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


class LeaderTasksTest(unittest.TestCase):
    """A leader (a conversation run in a Firstmate home) lists its home's task folders as documents, with titles from the home's backlog."""

    BACKLOG = (
        "# Backlog\n\n## In flight\n"
        "- [ ] reader-docs - Reader: task view (repo: pmos) (kind: ship) (since 2026-11-01)\n  a note under the row\n"
        "- [ ] with-report - Look at things (popular) data/with-report/report.md (repo: personal) (kind: scout) (reported 2026-10-27)\n"
        "\n## Queued\n- [ ] later-one - Do it later (repo: pmos)\n"
        "\n## Done\n- [x] old-one - Finished long ago (repo: pmos) (done 2026-10-19)\n"
        "- [x] checked-in-flight - Checked row (repo: pmos)\n")
    ARCHIVE = "# Archive\n\n## Archived 2026-09-28\n- [x] archived-one - Archived work (repo: firstmate) (kind: scout) (reported 2026-09-18)\n- [x] old-one - Archive copy of a task the backlog has\n"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name).resolve()
        self.fm = self.home / "firstmate"
        for name in ("data", "state", "projects"):
            (self.fm / name).mkdir(parents=True)
        (self.fm / "data" / "backlog.md").write_text(self.BACKLOG, encoding="utf-8")
        (self.fm / "data" / "done-archive.md").write_text(self.ARCHIVE, encoding="utf-8")
        patcher = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def put(self, relative, text="x"):
        path = self.fm / "data" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def leader(self):
        return {"leader": builder.leader_info(str(self.fm))}

    def test_a_leader_is_a_conversation_whose_own_working_folder_is_a_home(self):
        self.assertEqual(builder.leader_home(str(self.fm)), self.fm)
        self.assertIsNone(builder.leader_home(str(self.fm / "projects")), "a folder inside the home is not the home")
        self.assertIsNone(builder.leader_home(str(self.fm / "data" / "reader-docs")))
        worker = self.home / "worker-copy"
        (worker / "data").mkdir(parents=True)
        self.assertIsNone(builder.leader_home(str(worker)), "a folder with a data folder but no state or projects is a project")
        self.assertIsNone(builder.leader_home(""))
        self.assertIsNone(builder.leader_home(str(self.home / "nowhere")))

    def test_a_leader_is_found_through_a_link_and_never_by_name(self):
        link = self.home / "leader-workspaceos"
        link.symlink_to(self.fm)
        self.assertEqual(builder.leader_home(str(link)), self.fm)
        plain = self.home / "leader-lookalike"
        plain.mkdir()
        self.assertIsNone(builder.leader_home(str(plain)))

    def test_backlog_rows_give_the_title_without_its_tags_and_the_state_of_their_section(self):
        tasks = builder.leader_tasks(self.fm)
        self.assertEqual(tasks["reader-docs"], {"title": "Reader: task view", "state": "In flight"})
        self.assertEqual(tasks["with-report"], {"title": "Look at things (popular)", "state": "In flight"}, "the tags and the report path are cut, a parenthesis in the title stays")
        self.assertEqual(tasks["later-one"]["state"], "Queued")
        self.assertEqual(tasks["old-one"], {"title": "Finished long ago", "state": "Done"}, "the backlog's row wins over the archive's")
        self.assertEqual(tasks["checked-in-flight"]["state"], "Done", "a checked row is done")
        self.assertEqual(tasks["archived-one"], {"title": "Archived work", "state": "Done"}, "a task only the archive knows")

    def test_a_home_with_no_backlog_has_no_titles_and_a_long_title_is_cut(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(builder.leader_tasks(Path(tmp)), {})
        title = builder.backlog_tasks(f"## Queued\n- [ ] x - {'w' * 500} (repo: a)\n")["x"]["title"]
        self.assertEqual(len(title), builder.TITLE_LIMIT)
        self.assertTrue(title.endswith("…"))

    def test_the_files_of_every_task_folder_are_listed_with_the_kinds_a_conversation_names(self):
        self.put("reader-docs/brief.md", "# Brief\n")
        self.put("reader-docs/page.html", "<p>x</p>")
        self.put("reader-docs/ship/shot.PNG", "png")
        self.put("reader-docs/notes.txt", "not listed")
        self.put("no-row/report.md")
        self.put("loose.md")
        self.put("reader-docs/.hidden/secret.md")
        self.put("reader-docs/node_modules/x/readme.md")
        self.put("reader-docs/.dot.md")
        sessions = [self.leader()]
        documents = {}
        builder.attach_task_files(sessions, documents)
        found = {(doc["dir"].split("/data/")[1] if "/data/" in doc["dir"] else doc["dir"], doc["name"]): doc for doc in documents.values()}
        self.assertEqual(sorted(found), [("no-row", "report.md"), ("reader-docs", "brief.md"), ("reader-docs", "page.html"), ("reader-docs/ship", "shot.PNG")],
                         "a file directly in data/ is in no task, and hidden files, node_modules and other types are never listed")
        brief = found[("reader-docs", "brief.md")]
        self.assertTrue(brief["lazy"], "markdown is listed without its text")
        self.assertNotIn("text", brief)
        self.assertEqual((found[("reader-docs", "page.html")]["kind"], found[("reader-docs/ship", "shot.PNG")]["kind"]), ("html", "image"))
        self.assertEqual(brief["dir"], "~/firstmate/data/reader-docs")
        self.assertEqual(sessions[0]["leader"]["dir"], "~/firstmate", "the home as a document's folder is shown, so a folder says which task it is in")

    def test_a_file_a_conversation_named_keeps_its_text_and_is_listed_once(self):
        path = self.put("reader-docs/brief.md", "# Brief\n")
        sessions = [{"exchanges": [{"reply": f"`{path}`", "cwd": ""}], **self.leader()}]
        documents = builder.attach_documents(sessions)
        builder.attach_task_files(sessions, documents)
        self.assertEqual(len(documents), 1)
        doc = next(iter(documents.values()))
        self.assertEqual(doc["text"], "# Brief\n")
        self.assertNotIn("lazy", doc)

    def test_a_conversation_that_is_not_a_leaders_lists_no_task_files(self):
        self.put("reader-docs/brief.md")
        documents = {}
        builder.attach_task_files([{"exchanges": []}], documents)
        self.assertEqual(documents, {})

    def test_a_link_out_of_a_task_folder_a_link_folder_and_files_over_the_limits_are_left_out(self):
        outside = self.home / "elsewhere"
        outside.mkdir()
        (outside / "secret.md").write_text("x", encoding="utf-8")
        (outside / "inside.md").write_text("x", encoding="utf-8")
        self.put("reader-docs/ok.md")
        (self.fm / "data" / "reader-docs" / "link.md").symlink_to(outside / "secret.md")
        (self.fm / "data" / "linked-task").symlink_to(outside)
        self.put("reader-docs/big.md", "x" * (builder.MAX_DOCUMENT_BYTES + 1))
        documents = {}
        builder.attach_task_files([self.leader()], documents)
        self.assertEqual(sorted(doc["name"] for doc in documents.values()), ["ok.md"])

    def test_a_task_folder_is_cut_at_its_limit_shallowest_first_and_says_how_many_it_left_out(self):
        for n in range(5):
            self.put(f"big/f{n}.md")
        self.put("big/deep/er/deepest.md")
        sessions = [self.leader()]
        documents = {}
        with mock.patch.object(builder, "MAX_TASK_FILES", 4):
            builder.attach_task_files(sessions, documents)
        self.assertEqual(sorted(doc["name"] for doc in documents.values()), ["f0.md", "f1.md", "f2.md", "f3.md"])
        self.assertEqual(sessions[0]["leader"]["tasks"]["big"], {"more": 2}, "a task with no backlog row still says what it left out")

    def test_two_conversations_of_one_home_share_its_files(self):
        self.put("reader-docs/brief.md")
        sessions = [self.leader(), self.leader()]
        documents = {}
        builder.attach_task_files(sessions, documents)
        self.assertEqual(len(documents), 1)

    def test_the_conversation_carries_its_leader_and_a_worker_does_not(self):
        chain = [Path("/x/aaaa.jsonl")]
        for cwd, expected in ((str(self.fm), True), (str(self.fm / "projects"), False)):
            loaded = {chain[0]: {"exchanges": [], "cwd": cwd, "first_time": 0}}
            session = builder.thread_session({"id": "main", "home": self.fm}, chain, loaded, None)
            self.assertEqual("leader" in session, expected)
        self.assertEqual(session.get("leader"), None)
        loaded = {chain[0]: {"exchanges": [], "cwd": str(self.fm), "first_time": 0}}
        leader = builder.thread_session({"id": "main", "home": self.fm}, chain, loaded, None)["leader"]
        self.assertEqual(leader["tasks"]["reader-docs"]["title"], "Reader: task view")

    def test_the_markdown_files_listed_without_text_are_listed_beside_the_page_for_the_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "prototype.html"
            template = Path(tmp) / "t.html"
            template.write_text("<script>x</script>__PAYLOAD__", encoding="utf-8")
            documents = {"a1": {"id": "a1", "path": "/p/a.md", "text": "t"}, "b2": {"id": "b2", "path": "/p/b.md", "lazy": True}, "c3": {"id": "c3", "path": "/p/c.html", "kind": "html"}}
            builder.write_page(template, {"generated": 20.0, "documents": documents}, out)
            listing = Path(tmp) / builder.MD_FILES
            self.assertEqual(json.loads(listing.read_text(encoding="utf-8")), {"b2": "/p/b.md"}, "a document with its text is not listed, nor is a page")
            self.assertEqual(listing.stat().st_mode & 0o777, 0o600)


class PageShellTest(unittest.TestCase):
    """What the page's header and script hold, checked on the filled-in page (there is no browser in the suite)."""

    def pages(self):
        for mode in ("local", "hosted", "live"):
            page, _ = builder.fill_template(builder.TEMPLATE, "null", mode)
            yield mode, page

    def test_the_script_of_each_copy_is_valid_javascript(self):
        for mode, page in self.pages():
            script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "page.js"
                path.write_text(script, encoding="utf-8")
                done = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, f"{mode}: {done.stderr}")
            self.assertNotIn("/*__", script, f"{mode}: a slot was left unfilled")

    def test_send_goes_through_the_undo_window_and_only_the_delivery_reaches_the_server_or_the_queue(self):
        for mode, page in self.pages():
            # The click holds the message (sendHold.begin) and deliverDock is the one thing the window's end runs. A resumed hold uses the same path.
            self.assertEqual(page.count("sendHold.begin("), 2, mode)
            self.assertEqual(page.count("deliverDock("), 3, "its definition and the two ways the window can end: " + mode)
            self.assertIn("const begun = sendHold.begin(() => { clearSendHandoff(hold.id); endHold(); deliverDock({ sid, text, sentItems, sentBox, pointed, sentPhotos }); }, UNDO_SECONDS, hold);", page, mode)
            send = re.search(r"  function sendDock\(\) \{.*?\n  \}\n", page, re.S).group(0)
            self.assertNotIn("live.send(", send, mode)
            self.assertNotIn("hosted.enqueue(", send, mode)
            # Nothing but the delivery asks the server (local) or the queue (hosted) to send.
            self.assertEqual(page.count("live.send("), 1, mode)
            self.assertEqual(page.count("hosted.enqueue("), 1, mode)
            delivery = re.search(r"  async function deliverDock\(.*?\n  \}\n", page, re.S).group(0)
            # With photos the upload comes first and the send names what it saved (attach.deliver); the call is still the one place that sends.
            self.assertIn("send: ids => live.send(sid, text, ids)", delivery, mode)
            self.assertLess(delivery.index("attach.deliver("), delivery.index("live.send("), mode)
            self.assertIn("hosted.enqueue(sid, text)", delivery, mode)
            # The Undo window locks the box, Send turns into Undo and Esc takes the message back.
            self.assertIn('dock("text").readOnly = held;', page, mode)
            self.assertIn("`Undo ${sendHold.left()}`", page, mode)
            self.assertIn('if (e.key === "Escape") { e.preventDefault(); undoHold(); }', page, mode)
            # Undo on a message waiting in the queue asks the laptop, and only "cancelled" gives the text back.
            self.assertIn("await hosted.cancel(id)", page, mode)
            self.assertIn('if (answer.state === "cancelled") takeBack(p, "Undone: it was never sent.");', page, mode)
            # A full navigation records text in this tab, resumes only on another session, and clears the record before delivery.
            self.assertIn("sessionStorage.setItem(SEND_HANDOFF_KEY", page, mode)
            self.assertIn("resumeSendHandoff(saved, current && current.id", page, mode)
            self.assertIn('if (decision.action === "discard")', page, mode)
            self.assertIn("clearSendHandoff(hold.id); endHold();", page, mode)
        local, hosted, lite = (page for _, page in self.pages())
        self.assertIn('const hosted = null;', local)
        self.assertNotIn("function cancel(id)", local, "the local page has no queue to take a message back from")
        self.assertIn("async function cancel(id)", hosted)
        # The lite page loads like the hosted shell, so it carries the loader (and the queue's code with it), but it is not the hosted copy:
        # its message bar sends straight to the pane, through the server's own checks (live.send), never through the queue (HOSTED is false).
        self.assertIn("async function cancel(id)", lite)
        self.assertIn('const HOSTED = MODE === "hosted";', lite)
        self.assertIn("const queued = HOSTED ? await hosted.enqueue(sid, text) : null;", lite)

    def test_a_session_switched_to_during_another_sessions_undo_window_cannot_send_and_says_why(self):
        for mode, page in self.pages():
            # One message is in its window at a time, so the other session's Send is off with a reason on screen (never a dead click),
            # decided before the button's state is set from it; Add is off too. On the held session Add becomes Now.
            self.assertIn("const elsewhere = Boolean(link.hold && link.hold.sid !== session.id);", page, mode)
            self.assertLess(page.index("if (!reason && elsewhere) reason ="), page.index('dock("send").disabled = held ? false : Boolean(reason)'), mode)
            self.assertIn('add.disabled = held || asking ? false : link.sending || elsewhere ||', page, mode)
            self.assertIn('add.textContent = held ? "Now" : asking ? "Keep" : "Add";', page, mode)
            self.assertIn('add.title = held ? "Send this message now (Enter; Cmd+Enter or Ctrl+Enter)"', page, mode)
            self.assertIn('add.setAttribute("aria-label", held ? "Send this message now" : asking ? "Do not send the command" : "Add to the batch and write the next comment");', page, mode)
            # Esc, Enter and the Undo click belong to the session whose message is held: not to a box switched to meanwhile.
            self.assertIn('if (heldHere()) {', page, mode)
            self.assertIn('if (e.key === "Escape") { e.preventDefault(); undoHold(); }', page, mode)
            self.assertIn('if (e.isComposing) return;', page, mode)
            self.assertIn('else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendNow(); }', page, mode)
            self.assertIn('else if (e.key === "Enter") e.preventDefault();', page, mode)
            self.assertIn("if (heldHere()) undoHold(); else sendDock();", page, mode)
            self.assertIn('if (heldHere()) sendNow(); else if (askingHere()) keepCommand(); else { addToBatch(); dock("text").focus(); }', page, mode)

    def test_follow_herdr_is_in_the_folded_header_and_is_the_same_switch_as_the_one_in_the_controls(self):
        for mode, page in self.pages():
            title = re.search(r'<div class="title">(.*?)</div>', page, re.S).group(1)
            # In the one-line header, beside the chevron that unfolds it (the search button may sit between), not in the controls the fold hides.
            self.assertRegex(title, r'<button class="follow-quick" id="follow-quick" type="button" hidden>Follow</button>(?:<button class="search-toggle".*?</button>)?<button class="bar-toggle"', mode)
            self.assertNotIn("follow-quick", re.search(r'<div id="bar-more">.*?<div id="controls">', page, re.S).group(0), mode)
            # Shown only when the bar is folded; unfolded, the controls' own button is there.
            self.assertIn(".bar.collapsed .follow-quick:not([hidden]) { display: block; }", page)
            self.assertIn("  .follow-quick { display: none;", page)
            # One function flips the state, keeps it in this browser and paints again; both buttons call it.
            self.assertEqual(page.count("function toggleFollow()"), 1)
            self.assertIn('follow.addEventListener("click", toggleFollow);', page)
            self.assertIn('document.getElementById("follow-quick").addEventListener("click", toggleFollow);', page)
            self.assertIn('quick.setAttribute("aria-pressed", String(state.follow));', page)
            self.assertIn('quick.hidden = !canLive || state.view !== "reader";', page)

    def test_the_folded_header_has_icons_for_conversation_documents_and_the_answer_sheet_in_every_copy(self):
        for mode, page in self.pages():
            title = re.search(r'<div class="title">(.*?)</div>', page, re.S).group(1)
            # Conversation (hidden on its own view), Documents, Files and the answer sheet, in that order, ahead of Follow.
            order = [title.index(mark) for mark in ('id="view-conv"', 'id="view-doc"', 'id="view-tasks"', 'id="files-quick"', 'class="to-sheet"', 'id="follow-quick"')]
            self.assertEqual(order, sorted(order), mode)
            self.assertRegex(title, r'<button class="view-btn" id="view-conv" type="button" aria-label="Conversation" title="Conversation" hidden>', mode)
            self.assertRegex(title, r'<button class="view-btn" id="view-doc" type="button" aria-label="Documents" title="Documents" aria-pressed="false">', mode)
            self.assertRegex(title, r'<button class="view-btn" id="files-quick" type="button" aria-label="Files" title="Files" hidden>', mode)
            # The answer sheet stays one link (the hosted copy aims it at sheet.html by its class); folded it shows as an icon, with a name.
            self.assertRegex(title, r'<a class="to-sheet" href="questionnaire.html" title="Answer sheet" aria-label="Answer sheet"><span class="txt">.*?</span><svg class="sheet-ico"', mode)
            self.assertIn('document.querySelector(".to-sheet").href = "sheet.html"', page)
            # The unfolded header keeps its tabs: the icons are not among the controls the fold hides.
            controls = re.search(r'<div id="bar-more">.*?<div id="controls">', page, re.S).group(0)
            self.assertNotIn("view-btn", controls, mode)
            self.assertIn('<button class="tab" role="tab" id="tab-doc" aria-selected="false">Documents</button>', controls, mode)
            # The Tasks link is in every copy's markup, hidden; only a served page that the server says serves the board shows it (link.board).
            self.assertRegex(controls, r'<a class="tab tab-link" id="tab-tasks" href="/setup/transcript-reader/board/"[^>]* hidden>Tasks</a>', mode)
            self.assertRegex(title, r'<a class="view-btn" id="view-tasks" href="/setup/transcript-reader/board/" aria-label="Tasks"[^>]* hidden>', mode)
            self.assertIn(".bar.collapsed .view-btn:not([hidden]) { display: grid; }", page)
            self.assertIn("  .view-btn, .to-sheet .sheet-ico { display: none; }", page)
            self.assertIn('document.getElementById("files-quick").addEventListener("click", () => { if (slideOver()) setSideOpen(!docSideOpen); else showDocList(); });', page)
            self.assertIn('files.hidden = !((fileOpen && !wideDoc() && !expandedNow() && entries.length > 1) || (slideOver() && onFile));', page)
            self.assertIn('document.getElementById("expand-quick").addEventListener("click", () => setDocExpanded(!docExpanded));', page)

    def test_the_documents_view_has_the_conversations_header_with_a_document_picker_in_place_of_the_session_picker(self):
        for mode, page in self.pages():
            self.assertEqual(page.count("function pickerRow("), 1, mode)
            self.assertEqual(page.count("} = pickerRow(controls, session);"), 2, "the Conversation and the Documents view draw it the same way")
            self.assertIn('const pick = state.view === "reader" && data.sessions.length > 1;', page, "the session picker is the Conversation's")
            self.assertIn('const docPick = state.view === "doc" && Boolean(session);', page, "the Documents view's is the document picker")
            doc = page[page.index("function renderDocView("):page.index("// The heading above the selection")]
            self.assertNotIn("controls.replaceChildren()", doc, "the picker is kept, never taken out of the page")
            self.assertIn("controls.append(meta);", doc)

    def test_an_image_is_shown_in_an_img_never_a_frame_and_only_the_reader_page_may_load_images(self):
        policies = {}
        for mode, page in self.pages():
            policies[mode] = re.search(r'<meta http-equiv="Content-Security-Policy" content="(.*?)">', page).group(1)
            self.assertEqual(policies[mode].count("img-src"), 1, mode)
            self.assertIn('document.createElement("img")', page, mode)
            self.assertEqual(page.count('document.createElement("iframe")'), 1, "the one frame is the HTML file's: an image never gets one")
            self.assertIn('live.imageOpen(d.id)', page, mode)
        self.assertIn("img-src 'self';", policies["local"])
        self.assertNotIn("data:", policies["local"])
        self.assertIn("img-src 'self' data:;", policies["hosted"], "the copy shows an image from its own bytes")
        sheet = builder.fill_template(builder.HERE / "questionnaire.html", "null")[0]
        self.assertNotIn("img-src", re.search(r'<meta http-equiv="Content-Security-Policy" content="(.*?)">', sheet).group(1), "the answer sheet shows no image")

    def test_an_html_file_is_shown_in_a_sandboxed_frame_that_never_shares_the_pages_origin(self):
        for mode, page in self.pages():
            policy = re.search(r'<meta http-equiv="Content-Security-Policy" content="(.*?)">', page).group(1)
            self.assertIn("frame-src 'self'", policy, mode)
            self.assertIn("default-src 'none'", policy, mode)
            self.assertIn('f.setAttribute("sandbox", "allow-scripts");', page, mode)
            self.assertEqual(len(re.findall(r'"sandbox"', page)), 1, "the one frame the page makes")
            self.assertNotRegex(page, r'"sandbox", "[^"]*allow-same-origin', mode)
            self.assertEqual(page.count("document.createElement(\"iframe\")"), 1, mode)
            # The sandbox is set before the address, so the file never loads unsandboxed.
            self.assertLess(page.index('f.setAttribute("sandbox"'), page.index("f.src = info.url;"), mode)
            self.assertIn("htmlOpen", page, mode)

    def test_both_copies_carry_pins_and_sync(self):
        for mode, page in self.pages():
            self.assertIn("const kept = ({", page, mode)
            self.assertIn("const pins = {", page, mode)
            self.assertIn("const stars = kept({", page, mode)
            self.assertIn('id="sync"', page, mode)
            self.assertIn("async function syncNow()", page, mode)

    def test_pins_carry_editable_short_descriptions_and_default_old_pins(self):
        for mode, page in self.pages():
            self.assertIn("const pinDefaultDescription =", page, mode)
            self.assertIn("const pinDescription =", page, mode)
            self.assertIn('describe: (key, description) => pinStore.update(key, { description: normalizedPinDescription(description) })', page, mode)
            self.assertIn('state.pinsOpen = true;', page, mode)
            self.assertIn('state.pinEditing = key;', page, mode)
            self.assertIn('input.maxLength = 80;', page, mode)
            self.assertIn('await pins.describe(key, description);', page, mode)
            self.assertIn('const line = pinDescription(pin, text);', page, mode)
            self.assertIn('p.description || ""', page, mode)
            self.assertIn('It holds pinned message ids and your short descriptions, not message text.', page, mode)

    def test_the_reader_pages_carry_the_picker_rules_that_picker_test_js_runs(self):
        for mode, page in self.pages():
            self.assertIn("const picker = (() => {", page, mode)
            self.assertNotIn("/*__PICKER__*/", page, mode)
            self.assertIn("picker.label(s, data.sessions, pickerSection, sessionName)", page, mode)
            self.assertIn("picker.sections(data.sessions, paneLive, starred, picker.starRanker(stars.all()))", page, mode)

    def test_the_reader_pages_carry_the_comment_shortcut_that_commentkey_test_js_runs(self):
        for mode, page in self.pages():
            self.assertIn("const commentKey = (() => {", page, mode)
            self.assertNotIn("/*__COMMENTKEY__*/", page, mode)
            self.assertIn("if (!commentKey.pressed(e)) return;", page, mode)
            self.assertIn("commentKey.label(navigator.platform)", page, mode)

    def test_the_reader_pages_carry_the_address_rules_that_address_test_js_runs(self):
        for mode, page in self.pages():
            self.assertIn("const address = (() => {", page, mode)
            self.assertNotIn("/*__ADDRESS__*/", page, mode)
            # The page reads its address, and writes it, through the one module; a message address and a changed address are followed in place.
            self.assertIn("const asked = address.parse(location.hash) || {};", page, mode)
            self.assertIn("address.build({ session: session.id,", page, mode)
            self.assertIn('window.addEventListener("hashchange", followAddress);', page, mode)
            self.assertNotIn("location.reload", page.split("async function followAddress()")[1].split('window.addEventListener("hashchange"')[0], mode)
            # Any address the page is handed while open (another conversation, a file, a message) is followed in place; its own writes fire no hashchange.
            self.assertIn("let addressLive = false;", page, mode)
            self.assertIn("addressLive = true;", page, mode)
            self.assertNotIn("location.hash =", page, mode)

    def test_the_reader_pages_carry_the_photo_rules_that_attach_test_js_runs(self):
        for mode, page in self.pages():
            self.assertIn("const attach = (() => {", page, mode)
            self.assertNotIn("/*__ATTACH__*/", page, mode)
            self.assertIn("const photos = attach.makeStore();", page, mode)
            self.assertIn('id="dock-photo"', page, mode)
            self.assertIn('id="dock-file" accept="image/*" multiple hidden', page, mode)
            self.assertIn("upload: (file, name) => live.upload(file, name),", page, mode)
            self.assertIn("const upload = async (file, name = file.name) => call(\"upload\"", page, mode)
            # The thumbnails are painted into a canvas from the picked file, so the page's content policy gains no image address for them.
            policy = re.search(r'http-equiv="Content-Security-Policy" content="([^"]*)"', page).group(1)
            self.assertNotIn("blob:", policy, mode)
            self.assertNotIn("data:", policy.split("img-src")[1].split(";")[0] if mode == "local" else "", mode)

    def test_the_reader_pages_carry_the_ask_rules_that_asks_test_js_runs(self):
        for mode, page in self.pages():
            self.assertIn("const askRules = (() => {", page, mode)
            self.assertNotIn("/*__ASKS__*/", page, mode)
            # The header counts the same open set that the cards and the jump use.
            self.assertIn('[askRules.count(exs), "need you"]', page, mode)
            self.assertIn("isOpen(e) && !e.folded", page, mode)
            self.assertNotIn('count(e => e.verdict === "needs-you")', page, mode)

    def test_the_answer_sheet_carries_the_send_once_rules_that_sendonce_test_js_runs(self):
        sheet, _ = builder.fill_template(builder.HERE / "questionnaire.html", "null")
        hosted_sheet, _ = builder.fill_template(builder.HERE / "questionnaire.html", "null", "hosted")
        for mode, page in (("local", sheet), ("hosted", hosted_sheet)):
            self.assertEqual(page.count("const makeSendOnce = () => {"), 1, mode)
            self.assertNotIn("/*__SENDONCE__*/", page, mode)
            self.assertIn("if (!sendOnce.begin(key, text)) return;", page, mode)
            self.assertNotIn("link.sending", page, mode)
        for mode, page in self.pages():
            self.assertNotIn("makeSendOnce", page, mode)

    def test_both_copies_carry_find_once_inside_the_hashed_script_and_the_answer_sheet_does_not(self):
        for mode, page in self.pages():
            self.assertEqual(page.count("const finder = (() => {"), 1, mode)
            self.assertNotIn("/*__FIND__*/", page, mode)
            # Inside the script the content policy hashes, so no policy change lets it run.
            script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
            self.assertIn("const finder = (() => {", script, mode)
            digest = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii")
            self.assertIn(f"script-src 'sha256-{digest}'", page, mode)
            # The page adds no way out of the browser: no request, no model.
            self.assertNotRegex(re.search(r"const finder = \(\(\) => \{.*?\n  \}\)\(\);", script, re.S).group(0), r"fetch\(|XMLHttpRequest|WebSocket|sendBeacon|import\(", mode)
        sheet, _ = builder.fill_template(builder.HERE / "questionnaire.html", "null")
        self.assertNotIn("const finder", sheet)

    def test_both_copies_list_documents_by_folder_with_a_find_box_and_the_answer_sheet_does_not(self):
        for mode, page in self.pages():
            script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
            # The rules docfiles.test.js runs are in the hashed script, once, before the page code that calls them.
            self.assertEqual(script.count("const docfiles = (() => {"), 1, mode)
            self.assertNotIn("/*__DOCFILES__*/", page, mode)
            self.assertLess(script.index("const docfiles = (() => {"), script.index("docfiles.groups(entries, data.documents)"), mode)
            self.assertNotRegex(re.search(r"const docfiles = \(\(\) => \{.*?\n  \}\)\(\);", script, re.S).group(0), r"fetch\(|XMLHttpRequest|WebSocket|sendBeacon|import\(|document\.|window\.", mode)
            # The list, its find box and type filter, and the one-page-at-a-time phone layout replace the Document dropdown.
            for needle in ('"Find a file, folder or task" : "Find a file or folder"', 'shell.node.className = "docshell "', "const onFilePage = session =>"):
                self.assertIn(needle, script, mode)
            self.assertNotIn('select.setAttribute("aria-label", "Document")', script, mode)
            # The header's picker is the document picker on that view (grouped by folder), the folded line's too, and neither switches session there.
            for needle in ("fillDocuments(pick.docs)", "fillDocuments(document.getElementById(\"crumb-doc\"))", "docs.addEventListener(\"change\", () => chooseDocument(docs.value))"):
                self.assertIn(needle, script, mode)
            self.assertIn('id="crumb-doc"', page, mode)
            self.assertNotIn("if (docs) state.docPage", script, mode)
        sheet, _ = builder.fill_template(builder.HERE / "questionnaire.html", "null")
        self.assertNotIn("const docfiles", sheet)

    def test_both_copies_group_a_leaders_documents_by_task_with_a_switch_kept_in_the_browser_and_read_task_files_from_the_server(self):
        for mode, page in self.pages():
            script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
            for needle in ('localStorage.getItem("tr-docgroup")', 'localStorage.setItem("tr-docgroup", mode)', 'b.dataset.mode = key', "docfiles.taskGroups(entries, data.documents, session.leader)",
                           "const byTask = session => docfiles.mode(session, docGroup) === \"task\"", "live.mdOpen(d.id)"):
                self.assertIn(needle, script, mode)
        sheet, _ = builder.fill_template(builder.HERE / "questionnaire.html", "null")
        self.assertNotIn("tr-docgroup", sheet)

    def test_both_copies_keep_the_contents_list_open_through_redraws_and_have_an_expanded_view_dialog_with_a_panel_of_files_or_contents(self):
        for mode, page in self.pages():
            script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
            for needle in ("const tocKeep = docfiles.tocKeeper();", "toc.open = tocKeep.opened(key, sideToc.matches);", 'toc.addEventListener("toggle"',
                           'sessionStorage.getItem("tr-docdialog")', 'sessionStorage.setItem("tr-docdialog", docExpanded ? "1" : "0")', 'localStorage.setItem("tr-docside", docSide)',
                           'shell.node.setAttribute("role", "dialog")', 'close.addEventListener("click", () => setDocExpanded(false))', 'document.getElementById("bar").inert = state.view === "doc" && expandedNow();', "docfiles.sideShows(docSide, Boolean(shell.toc))",
                           "const expandedNow = () => docExpanded && canExpand();", "const canExpand = () => !phoneDevice.matches;", 'const phoneDevice = matchMedia("(hover: none) and (pointer: coarse)");', 'document.body.classList.toggle("docwide"'):
                self.assertIn(needle, script, mode)
            self.assertNotIn("toc.open = sideToc.matches;  // folded above", script, "a redraw must not fold the list again (" + mode + ")")
        sheet, _ = builder.fill_template(builder.HERE / "questionnaire.html", "null")
        self.assertNotIn("tr-docwide", sheet)
        self.assertNotIn("tr-docdialog", sheet)

    def test_both_copies_empty_the_message_box_when_a_send_starts_and_put_it_back_only_when_the_send_fails(self):
        for mode, page in self.pages():
            script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
            body = re.search(r"async function deliverDock\(.*?\n  \}\n", script, re.S).group(0)
            # The box, the pointer and the batch go before anything is awaited (Send now, or the end of the Undo window), not when the pane answers.
            self.assertIn("const putBack = takeSentFromComposer({ sid, sentItems, sentBox });", body, mode)
            self.assertLess(body.index("takeSentFromComposer("), body.index("await "), mode)
            self.assertIn("putBack(); redrawPending(true);", body, mode)
            self.assertNotIn('dock("text").value = ""', body, mode + ": the success path no longer empties the box")
            self.assertNotIn("saveBatch(sid, withoutSentItems", body, mode + ": nor the batch")
            # The Undo window itself still keeps the words in a locked box.
            self.assertIn("dock(\"text\").readOnly = held;", script, mode)

    def test_both_copies_draw_markdown_through_the_vendored_parser_and_the_answer_sheet_keeps_its_own(self):
        for mode, page in self.pages():
            script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
            self.assertEqual(script.count("const markdownView = (() => {"), 1, mode)
            for slot in ("/*__MARKDOWN_IT__*/", "/*__MARKDOWN__*/"):
                self.assertNotIn(slot, page, mode)
            # The parser is in the hashed script, so the page needs no network to draw a reply, and it comes before what reads it.
            self.assertEqual(script.count("/*! markdown-it "), 1, mode)
            self.assertLess(script.index("/*! markdown-it "), script.index("const markdownView"), mode)
            self.assertLess(script.index("const markdownView"), script.index("const finder"), mode)
            self.assertIn("markdownView.render(text,", script, mode)
            # The hand-written pass that missed bold around code is gone, and so is the second reading of a reply in find.js.
            self.assertNotIn(r"replace(/\*\*([^*]+)\*\*/g", script, mode)
            self.assertIn("markdownView.plain(text)", script, mode)
        # The answer sheet draws its own cards and its "What this is about" text by hand; only its "Original reply" panel (2026-11-08) uses the reader's
        # parser, the same one in the same order, so a table and a code box read in it as they do in the conversation.
        sheet, _ = builder.fill_template(builder.HERE / "questionnaire.html", "null")
        script = re.search(r"<script>(.*?)</script>", sheet, re.S).group(1)
        self.assertEqual(script.count("const markdownView = (() => {"), 1)
        self.assertEqual(script.count("/*! markdown-it "), 1)
        self.assertLess(script.index("/*! markdown-it "), script.index("const markdownView"))
        self.assertLess(script.index("const markdownView"), script.index("function paintReply()"))
        self.assertEqual(script.count("markdownView.render("), 1, "the panel is the only thing that reads through it")


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


class LateWritesTest(unittest.TestCase):
    """A log is touched long after its last turn (a restart rewrites the link and cost records, which have no time),
    so its modification time must not decide which session a /clear or a restart came from."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        projects = mock.patch.object(builder, "PROJECTS", Path(self.tmp.name))
        projects.start()
        self.addCleanup(projects.stop)
        self.folder = Path(self.tmp.name) / "project"
        self.folder.mkdir()

    def stems(self, name):
        return [p.stem for p in builder.session_chain(self.folder / f"{name}.jsonl")]

    @staticmethod
    def link(name):  # the records a process appends to its log, which carry no time
        return {"type": "bridge-session", "bridgeSessionId": name}

    def test_a_clear_is_joined_to_the_linked_log_even_though_that_log_was_touched_after_it(self):
        f = self.folder
        log(f / "before.jsonl", [prompt("hello", iso(T0 + 4000)), self.link("cse_01Late")], T0 + 9000)  # touched at T0+9000
        log(f / "after.jsonl", [self.link("cse_01Late"), prompt(CLEAR, iso(T0 + 4050)), prompt("go on", iso(T0 + 4100))], T0 + 4200)
        # Another session of the folder that ended right at the clear, and has no part in it.
        log(f / "decoy.jsonl", [prompt("busy nearby", iso(T0 + 4020))], T0 + 4052)
        self.assertEqual(self.stems("after"), ["before", "after"], "not the decoy")
        self.assertEqual(self.stems("before"), ["before", "after"], "the join reads the same from the older log")
        self.assertEqual(self.stems("decoy"), ["decoy"])

    def test_a_clear_made_long_after_the_last_turn_still_names_the_log_with_its_link(self):
        f = self.folder
        log(f / "idle.jsonl", [prompt("hello", iso(T0 + 5000)), self.link("cse_01Idle")], T0 + 5000)
        log(f / "back.jsonl", [self.link("cse_01Idle"), prompt(CLEAR, iso(T0 + 5300)), prompt("go on", iso(T0 + 5400))], T0 + 5500)
        log(f / "other-link.jsonl", [prompt("elsewhere", iso(T0 + 5290)), self.link("cse_01Other")], T0 + 5295)
        self.assertEqual(self.stems("back"), ["idle", "back"])
        self.assertEqual(self.stems("other-link"), ["other-link"])

    def test_the_log_before_a_clear_with_a_link_is_the_nearest_one_that_names_it(self):
        f = self.folder
        log(f / "one.jsonl", [prompt("first", iso(T0 + 6000)), self.link("cse_01Run")], T0 + 6000)
        log(f / "two.jsonl", [self.link("cse_01Run"), prompt(CLEAR, iso(T0 + 6100)), prompt("second", iso(T0 + 6200))], T0 + 8000)
        log(f / "three.jsonl", [self.link("cse_01Run"), prompt(CLEAR, iso(T0 + 7000)), prompt("third", iso(T0 + 7100))], T0 + 7200)
        for name in ("one", "two", "three"):
            self.assertEqual(self.stems(name), ["one", "two", "three"], name)

    def test_claude_started_again_in_the_pane_joins_a_log_touched_after_the_new_one_began(self):
        f = self.folder
        log(f / "haiku.jsonl", [prompt("the brief", iso(T0 + 6000))], T0 + 9500)
        log(f / "sonnet.jsonl", [prompt("the brief again", iso(T0 + 6135))], T0 + 6500)
        pane = {"herdr": "work", "pane": "w1:p2", "label": "fm-task"}
        with mock.patch.dict(builder._PANE_HISTORY, {"haiku": pane, "sonnet": pane}, clear=True):
            self.assertEqual(self.stems("sonnet"), ["haiku", "sonnet"])

    def test_a_clear_then_exit_and_resume_joins_the_log_the_pane_ran_before_it(self):
        # /clear, then Claude exited (which wrote undated records into the old log about 20 s later, past the 5 s a log of the
        # folder may be written after the clear), then `claude --resume <new id>`: no link names either log.
        f = self.folder
        log(f / "earlier.jsonl", [prompt("an earlier task", iso(T0 + 7000))], T0 + 7400)
        log(f / "before.jsonl", [prompt("the runbook", iso(T0 + 7500)), reply("done", T0 + 7549.3), {"type": "cost-state"}], T0 + 7584)
        log(f / "after.jsonl", [prompt(CLEAR, iso(T0 + 7561)), prompt("go on", iso(T0 + 7700))], T0 + 7800)
        # A log of the folder that ended right at the clear but ran in another pane, and one in no pane that ended within the 5 s
        # a log of the folder may be written after it (the pane's own log is asked before that guess).
        log(f / "decoy.jsonl", [prompt("busy nearby", iso(T0 + 7540)), reply("ok", T0 + 7559)], T0 + 7559)
        log(f / "bystander.jsonl", [prompt("nobody knows", iso(T0 + 7530)), reply("ok", T0 + 7560)], T0 + 7560)
        pane = {"herdr": "work", "pane": "w1:p2", "label": "fm-task", "life": "1"}
        history = {"earlier": pane, "before": pane, "after": pane, "decoy": {**pane, "pane": "w1:p3", "label": "fm-other"}}
        with mock.patch.dict(builder._PANE_HISTORY, history, clear=True):
            self.assertEqual(self.stems("after"), ["earlier", "before", "after"], "the pane's log nearest before the clear, not the decoy")
            self.assertEqual(self.stems("before"), ["earlier", "before", "after"])
            self.assertEqual(self.stems("decoy"), ["decoy"])
            self.assertEqual(self.stems("bystander"), ["bystander"])
        self.assertEqual(self.stems("after"), ["bystander", "after"], "no pane history, the nearest log of the folder")
        # Another pane, or a Herdr session made again, is not this pane; and a log of the pane last written long before the
        # clear ("earlier") is not the one it left.
        for other in ({**pane, "pane": "w1:p9"}, {**pane, "life": "2"}):
            with mock.patch.dict(builder._PANE_HISTORY, {**history, "before": other}, clear=True):
                self.assertEqual(self.stems("after"), ["bystander", "after"])

    def test_last_record_time_is_the_newest_dated_record_of_the_end_of_the_file(self):
        path = self.folder / "tail.jsonl"
        log(path, [prompt("a", iso(T0 + 10)), {"type": "assistant", "timestamp": iso(T0 + 20)}, {"type": "cost-state"}, self.link("cse_01X")], T0 + 99)
        self.assertEqual(builder.last_record_time(path), T0 + 20)
        # A window that starts mid-line skips that cut line, and a window with no dated record says so.
        with mock.patch.object(builder, "TAIL_BYTES", 40):
            builder._TAILS.clear()
            self.assertIsNone(builder.last_record_time(path))
        builder._TAILS.clear()
        log(path, [{"type": "cost-state"}], T0)
        self.assertIsNone(builder.last_record_time(path))
        self.assertIsNone(builder.last_record_time(self.folder / "missing.jsonl"))


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
