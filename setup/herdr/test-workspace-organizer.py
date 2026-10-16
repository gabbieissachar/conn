#!/usr/bin/env python3
"""Unit tests for workspace-organizer.py that do not require a Herdr server."""

import argparse
import atexit
import copy
import io
import importlib.util
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("workspace-organizer.py")
SPEC = importlib.util.spec_from_file_location("workspace_organizer", MODULE_PATH)
assert SPEC and SPEC.loader
ORGANIZER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ORGANIZER)

# No test may read or write the captain's real archives, groups or snapshot. Every state folder points at a scratch
# folder for the whole run, so a test that forgets to patch one still cannot reach the real files.
_SCRATCH_STATE = tempfile.mkdtemp(prefix="organizer-test-state-")
atexit.register(shutil.rmtree, _SCRATCH_STATE, ignore_errors=True)
for _name, _value in (
    ("STATE_DIR", Path(_SCRATCH_STATE)),
    ("ARCHIVE_DIR", Path(_SCRATCH_STATE) / "archives"),
    ("MOVE_DIR", Path(_SCRATCH_STATE) / "moves"),
    ("BATCH_DIR", Path(_SCRATCH_STATE) / "batches"),
    ("LIVE_SNAPSHOT_PATH", Path(_SCRATCH_STATE) / "live-snapshot.json"),
):
    setattr(ORGANIZER, _name, _value)

REGISTRY_PATH = Path(__file__).with_name("agent-session-registry.py")
REGISTRY_SPEC = importlib.util.spec_from_file_location("agent_session_registry", REGISTRY_PATH)
assert REGISTRY_SPEC and REGISTRY_SPEC.loader
REGISTRY = importlib.util.module_from_spec(REGISTRY_SPEC)
sys.modules[REGISTRY_SPEC.name] = REGISTRY
REGISTRY_SPEC.loader.exec_module(REGISTRY)

RESTORE_PATH = Path(__file__).with_name("agent-session-restore.py")
RESTORE_SPEC = importlib.util.spec_from_file_location("agent_session_restore", RESTORE_PATH)
assert RESTORE_SPEC and RESTORE_SPEC.loader
RESTORE = importlib.util.module_from_spec(RESTORE_SPEC)
RESTORE_SPEC.loader.exec_module(RESTORE)


class WorkspaceOrganizerTests(unittest.TestCase):
    def test_codex_home_controls_session_lookup_paths(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"CODEX_HOME": temporary}):
            spec = importlib.util.spec_from_file_location("workspace_organizer_isolated_codex", MODULE_PATH)
            assert spec and spec.loader
            isolated = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(isolated)
        self.assertEqual(isolated.CODEX_SESSION_INDEX_PATH, Path(temporary) / "session_index.jsonl")
        self.assertEqual(isolated.CODEX_SESSIONS_DIR, Path(temporary) / "sessions")

    def test_leaf_panes_keep_layout_order(self):
        root = {
            "type": "split",
            "first": {"type": "pane", "pane_id": "one"},
            "second": {
                "type": "split",
                "first": {"type": "pane", "pane_id": "two"},
                "second": {"type": "pane", "pane_id": "three"},
            },
        }
        self.assertEqual([pane["pane_id"] for pane in ORGANIZER.leaf_panes(root)], ["one", "two", "three"])

    def test_matching_pane_map_pairs_layout_leaves(self):
        source = {
            "type": "split",
            "first": {"type": "pane", "pane_id": "old-1"},
            "second": {"type": "pane", "pane_id": "old-2"},
        }
        target = {
            "type": "split",
            "first": {"type": "pane", "pane_id": "new-1"},
            "second": {"type": "pane", "pane_id": "new-2"},
        }
        self.assertEqual(
            ORGANIZER.matching_pane_map(source, target), {"old-1": "new-1", "old-2": "new-2"}
        )

    def test_layout_shape_ignores_live_rebuild_identifiers(self):
        source = {
            "workspace_id": "w1",
            "tab_id": "w1:t2",
            "focused_pane_id": "w1:p3",
            "root": {
                "type": "split",
                "direction": "horizontal",
                "first": {"type": "pane", "pane_id": "w1:p1", "cwd": tempfile.gettempdir()},
                "second": {
                    "type": "split",
                    "direction": "vertical",
                    "first": {"type": "pane", "pane_id": "w1:p2", "cwd": tempfile.gettempdir()},
                    "second": {"type": "pane", "pane_id": "w1:p3", "cwd": tempfile.gettempdir()},
                },
            },
        }
        rebuilt = copy.deepcopy(source)
        rebuilt.update({"workspace_id": "w9", "tab_id": "w9:t1", "focused_pane_id": "w9:p3"})
        rebuilt["root"]["first"]["pane_id"] = "w9:p1"
        rebuilt["root"]["second"]["first"]["pane_id"] = "w9:p2"
        rebuilt["root"]["second"]["second"]["pane_id"] = "w9:p3"
        self.assertEqual(ORGANIZER.layout_shape_fingerprint(source), ORGANIZER.layout_shape_fingerprint(rebuilt))

    def test_archive_summary_counts_resumable_agents(self):
        archive = {
            "archive_id": "example",
            "status": "archived",
            "capture": {
                "workspace": {"label": "Example", "source_workspace_id": "w1"},
                "tabs": [
                    {
                        "layout": {"root": {"type": "pane", "pane_id": "p1"}},
                        "agent_restores": [{"restore_status": "resumable", "restore_source": "manifest"}],
                    },
                    {
                        "layout": {"root": {"type": "pane", "pane_id": "p2"}},
                        "agent_restores": [{"restore_status": "shell_only"}],
                    },
                ],
            },
        }
        summary = ORGANIZER.archive_summary(archive)
        self.assertEqual(summary["tab_count"], 2)
        self.assertEqual(summary["pane_count"], 2)
        self.assertEqual(summary["resumable_pane_count"], 1)
        self.assertEqual(summary["shell_only_pane_count"], 1)

    def test_restore_tabs_preview_includes_every_selected_tab(self):
        archive = {
            "archive_id": "example",
            "status": "archived",
            "capture": {
                "tabs": [
                    {"source_tab_id": "w1:t1", "label": "First", "layout": {"root": {"type": "pane", "pane_id": "p1"}}},
                    {"source_tab_id": "w1:t2", "label": "Second", "layout": {"root": {"type": "pane", "pane_id": "p2"}}},
                ]
            },
        }
        args = argparse.Namespace(
            archive="example",
            tab=["w1:t1", "w1:t2"],
            to_workspace="w9",
            session="esim",
            execute=False,
            confirm=None,
            allow_unresumable_agents=False,
            resume_agents=True,
        )
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            ORGANIZER, "archive_by_id", return_value=(Path(temporary) / "example.json", archive)
        ), patch.object(ORGANIZER, "session_snapshot", return_value={}), patch.object(
            ORGANIZER, "workspace_by_id", return_value={"workspace_id": "w9", "label": "Destination"}
        ):
            ORGANIZER.restore_tabs_command(args)
        self.assertEqual(args.tab, ["w1:t1", "w1:t2"])

    def test_restore_tabs_rejects_duplicate_tab_selection(self):
        archive = {"archive_id": "example", "status": "archived", "capture": {"tabs": []}}
        args = argparse.Namespace(
            archive="example",
            tab=["w1:t1", "w1:t1"],
            to_workspace="w9",
            session="esim",
            execute=False,
            confirm=None,
            allow_unresumable_agents=False,
            resume_agents=True,
        )
        with patch.object(ORGANIZER, "archive_by_id", return_value=(Path("/tmp/example.json"), archive)), patch.object(
            ORGANIZER, "session_snapshot", return_value={}
        ), patch.object(ORGANIZER, "workspace_by_id", return_value={"workspace_id": "w9"}):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "must be unique"):
                ORGANIZER.restore_tabs_command(args)

    def test_restore_tabs_rebuilds_each_selected_tab_and_keeps_recovery_records(self):
        archive = {
            "archive_id": "example",
            "status": "archived",
            "capture": {
                "tabs": [
                    {"source_tab_id": "w1:t1", "label": "First", "layout": {"root": {"type": "pane", "pane_id": "p1"}}},
                    {"source_tab_id": "w1:t2", "label": "Second", "layout": {"root": {"type": "pane", "pane_id": "p2"}}},
                ]
            },
        }
        args = argparse.Namespace(
            archive="example",
            tab=["w1:t1", "w1:t2"],
            to_workspace="w9",
            session="esim",
            execute=True,
            confirm="example",
            allow_unresumable_agents=False,
            resume_agents=True,
        )
        layouts = [
            {"layout": {"tab_id": "w9:t1", "root": {"type": "pane", "pane_id": "new-p1"}}},
            {"layout": {"tab_id": "w9:t2", "root": {"type": "pane", "pane_id": "new-p2"}}},
        ]
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "example.json"
            with patch.object(ORGANIZER, "archive_by_id", return_value=(archive_path, archive)), patch.object(
                ORGANIZER, "session_snapshot", return_value={}
            ), patch.object(
                ORGANIZER, "workspace_by_id", return_value={"workspace_id": "w9", "label": "Destination"}
            ), patch.object(ORGANIZER, "socket_call", side_effect=layouts) as socket_call, patch.object(
                ORGANIZER, "resume_captured_tabs", return_value=[]
            ):
                ORGANIZER.restore_tabs_command(args)
            self.assertEqual(socket_call.call_count, 2)
            saved = json.loads(archive_path.read_text())
        self.assertEqual([item["status"] for item in saved["tab_restores"]], ["completed", "completed"])
        self.assertEqual([item["destination_tab_id"] for item in saved["tab_restores"]], ["w9:t1", "w9:t2"])

    def test_archive_tabs_appends_to_existing_archive_and_closes_only_selected_tabs(self):
        archive = {
            "archive_id": "example",
            "status": "archived",
            "capture": {
                "tabs": [{"source_tab_id": "old:t1", "layout": {"root": {"type": "pane", "pane_id": "old:p1"}}}]
            },
        }
        snapshot = {
            "tabs": [
                {"workspace_id": "w1", "tab_id": "w1:t1"},
                {"workspace_id": "w1", "tab_id": "w1:t2"},
            ],
            "panes": [],
        }
        captured = [
            {
                "source_tab_id": "w1:t1",
                "source_workspace_id": "w1",
                "label": "First",
                "layout": {"root": {"type": "pane", "pane_id": "w1:p1"}},
                "agent_restores": [],
            }
        ]
        args = argparse.Namespace(
            into_archive="example",
            tab=["w1:t1"],
            session="esim",
            execute=True,
            confirm="example",
            allow_active=False,
            allow_unresumable_agents=False,
        )
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "example.json"
            with patch.object(ORGANIZER, "archive_by_id", return_value=(archive_path, archive)), patch.object(
                ORGANIZER, "session_snapshot", return_value=snapshot
            ), patch.object(ORGANIZER, "capture_selected_tabs", return_value=captured), patch.object(
                ORGANIZER, "run_json", return_value={}
            ) as run_json:
                ORGANIZER.archive_tabs_command(args)
            saved = json.loads(archive_path.read_text())
        self.assertEqual(run_json.call_args_list[0].args, (["tab", "close", "w1:t1"], "esim"))
        self.assertEqual([tab["source_tab_id"] for tab in saved["capture"]["tabs"]], ["old:t1", "w1:t1"])
        self.assertEqual(saved["tab_archives"][0]["status"], "completed")

    def test_archive_tabs_keeps_one_live_tab_in_each_workspace(self):
        archive = {"archive_id": "example", "status": "archived", "capture": {"tabs": []}}
        snapshot = {"tabs": [{"workspace_id": "w1", "tab_id": "w1:t1"}], "panes": []}
        captured = [
            {
                "source_tab_id": "w1:t1",
                "source_workspace_id": "w1",
                "label": "Only tab",
                "layout": {"root": {"type": "pane", "pane_id": "w1:p1"}},
                "agent_restores": [],
            }
        ]
        args = argparse.Namespace(
            into_archive="example",
            tab=["w1:t1"],
            session="esim",
            execute=False,
            confirm=None,
            allow_active=False,
            allow_unresumable_agents=False,
        )
        with patch.object(ORGANIZER, "archive_by_id", return_value=(Path("/tmp/example.json"), archive)), patch.object(
            ORGANIZER, "session_snapshot", return_value=snapshot
        ), patch.object(ORGANIZER, "capture_selected_tabs", return_value=captured):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "Keep at least one tab"):
                ORGANIZER.archive_tabs_command(args)

    def test_active_agents_uses_herdr_tab_id_field(self):
        snapshot = {
            "tabs": [{"workspace_id": "w1", "tab_id": "w1:t1"}],
            "panes": [
                {"tab_id": "w1:t1", "agent_status": "working"},
                {"tab_id": "w1:t2", "agent_status": "working"},
            ],
        }
        self.assertEqual(len(ORGANIZER.active_agents(snapshot, "w1")), 1)

    def test_empty_tab_cleanup_keeps_agent_and_non_shell_tabs(self):
        snapshot = {
            "tabs": [
                {"workspace_id": "w1", "tab_id": "w1:t1"},
                {"workspace_id": "w1", "tab_id": "w1:t2"},
                {"workspace_id": "w1", "tab_id": "w1:t3"},
            ],
            "panes": [
                {"tab_id": "w1:t1", "pane_id": "w1:p1", "agent": "codex"},
                {"tab_id": "w1:t2", "pane_id": "w1:p2"},
                {"tab_id": "w1:t3", "pane_id": "w1:p3"},
            ],
        }
        with patch.object(ORGANIZER, "pane_is_shell_prompt", side_effect=lambda pane_id, session: pane_id == "w1:p2"):
            eligible, protected = ORGANIZER.empty_tab_cleanup_candidates(snapshot, "w1", "esim")
        self.assertEqual([tab["tab_id"] for tab in eligible], ["w1:t2"])
        self.assertEqual(
            protected,
            [
                {"tab_id": "w1:t1", "reason": "agent_detected", "pane_ids": ["w1:p1"]},
                {"tab_id": "w1:t3", "reason": "non_shell_process", "pane_ids": ["w1:p3"]},
            ],
        )

    def test_empty_tab_cleanup_keeps_shell_tab_with_a_resumable_session(self):
        snapshot = {
            "tabs": [{"workspace_id": "w1", "tab_id": "w1:t1"}],
            "panes": [{"tab_id": "w1:t1", "pane_id": "w1:p1", "agent_status": "unknown"}],
        }
        restores = [
            {
                "source_pane_id": "w1:p1",
                "client": "codex",
                "restore_status": "resumable",
                "restore_source": "manifest",
            }
        ]
        with patch.object(ORGANIZER, "agent_restore_records", return_value=restores), patch.object(
            ORGANIZER, "pane_is_shell_prompt", return_value=True
        ):
            eligible, protected = ORGANIZER.empty_tab_cleanup_candidates(snapshot, "w1", "esim")
        self.assertEqual(eligible, [])
        self.assertEqual(
            protected,
            [{"tab_id": "w1:t1", "reason": "resumable_session", "pane_ids": ["w1:p1"]}],
        )

    def test_public_workspace_exposes_agent_resume_state_without_session_id(self):
        snapshot = {
            "tabs": [{"workspace_id": "w1", "tab_id": "w1:t1", "label": "Example"}],
            "panes": [{"tab_id": "w1:t1", "pane_id": "w1:p1", "agent": "codex", "agent_status": "idle"}],
        }
        restores = [
            {
                "source_pane_id": "w1:p1",
                "client": "codex",
                "restore_status": "shell_only",
                "restore_source": "unavailable",
            }
        ]
        with patch.object(ORGANIZER, "agent_restore_records", return_value=restores):
            workspace = ORGANIZER.public_workspace(snapshot, {"workspace_id": "w1", "label": "Workspace"}, "esim", [])
        self.assertEqual(
            workspace["tabs"][0]["agent_resume"],
            [{"pane_id": "w1:p1", "client": "codex", "status": "needs_registration", "source": "unavailable"}],
        )

    def test_a_tab_lists_the_verified_session_id_of_each_agent_and_nothing_else(self):
        good = "11111111-2222-4333-8444-555555555555"
        other = "66666666-7777-4888-8999-aaaaaaaaaaaa"
        snapshot = {
            "tabs": [{"workspace_id": "w1", "tab_id": "w1:t1", "label": "Example"}],
            "panes": [{"tab_id": "w1:t1", "pane_id": f"w1:p{n}", "agent": "claude", "agent_status": "idle"} for n in range(1, 6)],
        }

        def restore(pane, client, session_id, status, source):
            return {"source_pane_id": pane, "client": client, "session_id": session_id, "restore_status": status, "restore_source": source}

        restores = [
            restore("w1:p1", "claude", good, "resumable", "process"),
            restore("w1:p2", "codex", other, "resumable", "native_codex"),
            restore("w1:p3", "claude", other, "shell_only", "unavailable"),  # not verified
            restore("w1:p4", "claude", "not-a-session-id", "resumable", "process"),  # malformed
            restore("w1:p5", "claude", None, "resumable", "process"),  # no id
        ]
        with patch.object(ORGANIZER, "agent_restore_records", return_value=restores):
            workspace = ORGANIZER.public_workspace(snapshot, {"workspace_id": "w1", "label": "W"}, "esim", [])
        tab = workspace["tabs"][0]
        self.assertEqual(
            tab["agent_sessions"],
            [
                {"pane_id": "w1:p1", "client": "claude", "session_id": good},
                {"pane_id": "w1:p2", "client": "codex", "session_id": other},
            ],
        )
        # The id lives only in agent_sessions, never in the resume state the page already shows.
        self.assertNotIn(good, json.dumps(tab["agent_resume"]))

    def test_a_tab_reports_each_working_folder_once_with_its_panes(self):
        root = "/Users/someone/.treehouse/firstmate-8bf1b0/3/firstmate/state/.treehouse/personal-1ab7cc/5/personal"
        snapshot = {
            "tabs": [{"workspace_id": "w9Z", "tab_id": "w9Z:t2", "label": "Work"}],
            "panes": [
                # the folder the foreground process runs in wins over the folder the pane started in
                {"tab_id": "w9Z:t2", "pane_id": "w9Z:p1", "cwd": "/Users/someone", "foreground_cwd": root},
                {"tab_id": "w9Z:t2", "pane_id": "w9Z:p2", "cwd": root},
                {"tab_id": "w9Z:t2", "pane_id": "w9Z:p3", "cwd": "/Users/someone/other"},
                {"tab_id": "w9Z:t2", "pane_id": "w9Z:p4", "cwd": "relative"},
                {"tab_id": "w9Z:t2", "pane_id": "w9Z:p5", "cwd": "/tmp/two\nlines"},
                {"tab_id": "w9Z:t2", "pane_id": "w9Z:p6"},
            ],
        }
        workspace = ORGANIZER.public_workspace(snapshot, {"workspace_id": "w9Z", "label": "W"}, "esim", [])
        self.assertEqual(
            workspace["tabs"][0]["working_folders"],
            [
                {"path": root, "source": "pane", "pane_ids": ["w9Z:p1", "w9Z:p2"]},
                {"path": "/Users/someone/other", "source": "pane", "pane_ids": ["w9Z:p3"]},
            ],
        )

    def git(self, folder, *arguments):
        subprocess.run(
            ["git", "-C", str(folder), "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false",
             "-c", "core.hooksPath=/dev/null", *arguments],
            check=True, capture_output=True,
            env={**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_TEMPLATE_DIR": ""},
        )

    def agent_world(self):
        """A project checkout, a task worktree of it, an unrelated repository, and a place for Claude session logs."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve()
        main, task, other = base / "projects" / "app", base / "task" / "app", base / "other"
        for repository in (main, other):
            repository.mkdir(parents=True)
            self.git(repository, "init", "-q")
            (repository / "a.txt").write_text("a")
            self.git(repository, "add", ".")
            self.git(repository, "commit", "-q", "-m", "first")
        self.git(main, "worktree", "add", "-q", "-b", "task", str(task))
        logs = base / "claude" / "projects" / "-encoded"
        logs.mkdir(parents=True)
        patcher = patch.object(ORGANIZER, "CLAUDE_PROJECTS_DIR", base / "claude" / "projects")
        patcher.start()
        self.addCleanup(patcher.stop)
        return main, task, other, logs

    def write_log(self, logs, session_id, paths=(), commands=(), edits=()):
        lines = []
        for path in edits:
            lines.append({"message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": str(path)}}]}})
        for path in paths:
            lines.append({"message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": str(path)}}]}})
        for command in commands:
            lines.append({"message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": command}}]}})
        (logs / f"{session_id}.jsonl").write_text("\n".join(json.dumps(line) for line in lines) + "\n")

    def agent_pane(self, main, session_id="11111111-aaaa-bbbb-cccc-222222222222"):
        return {
            "tab_id": "w1:t1", "pane_id": "w1:p1", "agent": "claude", "cwd": str(main), "foreground_cwd": str(main),
            "agent_session": {"agent": "claude", "kind": "id", "value": session_id},
        }

    def test_an_agent_that_works_in_a_task_worktree_of_its_project_reports_that_clone(self):
        main, task, other, logs = self.agent_world()
        sid = "11111111-aaaa-bbbb-cccc-222222222222"
        self.write_log(logs, sid, paths=[task / "a.txt", task / "missing" / "new.txt", other / "a.txt"], commands=[f"ls {task}/ && echo {main}/a.txt"])
        self.assertEqual(ORGANIZER.inferred_agent_folder(self.agent_pane(main, sid)), str(task))
        folders = ORGANIZER.pane_working_folders([self.agent_pane(main, sid)])
        self.assertEqual(
            folders,
            [{"path": str(task), "source": "agent_files", "pane_ids": ["w1:p1"]}, {"path": str(main), "source": "pane", "pane_ids": ["w1:p1"]}],
        )

    def test_the_most_touched_worktree_wins_and_only_the_recent_calls_count(self):
        main, task, other, logs = self.agent_world()
        second = main.parent.parent / "task" / "app2"
        self.git(main, "worktree", "add", "-q", "-b", "task2", str(second))
        sid = "11111111-aaaa-bbbb-cccc-222222222222"
        old = [task / "a.txt"] * (ORGANIZER.AGENT_RECENT_PATHS + 50)
        self.write_log(logs, sid, paths=old + [second / "a.txt"] * ORGANIZER.AGENT_RECENT_PATHS)
        self.assertEqual(ORGANIZER.inferred_agent_folder(self.agent_pane(main, sid)), str(second))

    def test_writes_decide_the_clone_and_reads_only_break_a_tie_when_nothing_was_written(self):
        main, task, other, logs = self.agent_world()
        second = main.parent.parent / "task" / "app2"
        self.git(main, "worktree", "add", "-q", "-b", "task2", str(second))
        sid = "11111111-aaaa-bbbb-cccc-222222222222"
        pane = self.agent_pane(main, sid)
        # Many reads of one clone, a few edits in the other: the edited one is where the agent works.
        self.write_log(logs, sid, paths=[task / "a.txt"] * 30, edits=[second / "a.txt"] * 2)
        self.assertEqual(ORGANIZER.inferred_agent_folder(pane), str(second))
        # A shell command that changes files counts as a write. A read-only one does not.
        self.write_log(logs, sid, paths=[task / "a.txt"] * 5, commands=[f"git -C {second} commit -m x", f"cat {task}/a.txt", f"ls {task}", f"echo hi > {second}/out.txt"])
        self.assertEqual(ORGANIZER.inferred_agent_folder(pane), str(second))
        self.write_log(logs, sid, commands=[f"grep -r foo {task}", f"cat {task}/a.txt && ls {second}"])
        self.assertEqual(ORGANIZER.inferred_agent_folder(pane), str(task), "no writes: the most read clone decides")
        # A write to the shell's own checkout is not a clone, so the reads still decide.
        self.write_log(logs, sid, paths=[task / "a.txt"] * 3, edits=[main / "a.txt"] * 9)
        self.assertEqual(ORGANIZER.inferred_agent_folder(pane), str(task))

    def test_shell_commands_count_as_writes_only_when_they_change_files(self):
        a, b = "/Users/x/app", "/Users/x/other"
        written = lambda command: [path for path, was_written in ORGANIZER.shell_command_paths(command) if was_written]
        # Reads, including ones that redirect to /dev/null or merge stderr, write nothing.
        for command in (
            f"ls {a} 2>/dev/null", f"grep -r 'a > b' {a}", f"cat {a}/f 2>&1", f"git -C {a} status", f"git -C {a} diff | head",
            f"ls {a} &> /dev/null", f"cat {a}/f > /dev/null", f"sed -n 1p {a}/f", f"cd {a} && git log --oneline",
        ):
            self.assertEqual(written(command), [], command)
        # Real changes write the path they change.
        self.assertEqual(written(f"echo hi > {a}/out.txt"), [f"{a}/out.txt"])
        self.assertEqual(written(f"echo hi >> {a}/out.txt 2>/dev/null"), [f"{a}/out.txt"])
        self.assertEqual(written(f"git -C {a} commit -m 'x > y'"), [a])
        self.assertEqual(written(f"git -c core.x=1 -C {a} add -A"), [a])
        self.assertEqual(written(f"sed -i '' s/a/b/ {a}/f"), [f"{a}/f"])
        self.assertEqual(written(f"FOO=1 rm {a}/x"), [f"{a}/x"])
        # A relative change writes the folder the command ran in.
        self.assertEqual(written(f"cd {a} && git add -A && git commit -m x"), [a, a])
        # Only the destination of a copy is written; a move changes both ends.
        self.assertEqual(written(f"cp {a}/a {b}/b"), [f"{b}/b"])
        self.assertEqual(written(f"mv {a}/a {b}/b"), [f"{a}/a", f"{b}/b"])
        # One command per line, and an unquoted newline ends a command.
        self.assertEqual(written(f"ls {a}\ngit -C {b} add ."), [b])
        # A wrapped command is read as its own command line; the working folder carries in.
        self.assertEqual(written(f"bash -c 'echo hi > {a}/out.txt'"), [f"{a}/out.txt"])
        self.assertEqual(written(f"bash -lc \"cd {a} && git commit -m x\""), [a])
        self.assertEqual(written(f"cd {a} && sh -c 'touch f'"), [a])
        self.assertEqual(written(f"bash -c 'ls {a} 2>/dev/null'"), [])
        self.assertEqual(written(f"find {a} -name '*.tmp' -delete"), [a])
        self.assertEqual(written(f"find {a} -name '*.tmp' -exec rm {{}} +"), [a])
        self.assertEqual(written(f"find {a} -name '*.py'"), [])
        self.assertEqual(written(f"npm install --prefix {a}"), [a])
        self.assertEqual(written(f"cd {a} && pnpm add left-pad"), [a])
        self.assertEqual(written(f"npm run build --prefix {a}"), [])
        # Code run by an interpreter is not understood, so it reads as a read.
        self.assertEqual(written(f"python3 -c \"open('{a}/x', 'w')\""), [])
        # A command that cannot be parsed is read, never a guessed write.
        self.assertEqual(written(f"echo 'unbalanced > {a}/x"), [])

    def test_reads_that_discard_errors_do_not_outweigh_real_edits(self):
        main, task, other, logs = self.agent_world()
        second = main.parent.parent / "task" / "app2"
        self.git(main, "worktree", "add", "-q", "-b", "task2", str(second))
        sid = "11111111-aaaa-bbbb-cccc-222222222222"
        reads = [f"ls {task} 2>/dev/null", f"grep -r foo {task} 2>&1", f"cat {task}/a.txt 2>/dev/null"] * 4
        self.write_log(logs, sid, commands=reads, edits=[second / "a.txt"])
        self.assertEqual(ORGANIZER.inferred_agent_folder(self.agent_pane(main, sid)), str(second))

    def test_repository_lookup_matches_git_without_starting_it(self):
        main, task, other, _ = self.agent_world()
        (task / "deep" / "er").mkdir(parents=True)
        outside = main.parent.parent / "plain"
        outside.mkdir()
        folders = [main, task, task / "deep" / "er", other, outside, main / "missing" / "file.txt"]
        expected = {}
        ORGANIZER.git_root_and_common_dir.cache_clear()
        for folder in folders:
            expected[str(folder)] = ORGANIZER.git_root_and_common_dir(str(folder))
        ORGANIZER.git_root_and_common_dir.cache_clear()
        with patch.object(ORGANIZER.subprocess, "run", side_effect=AssertionError("git was started")):
            for folder in folders:
                self.assertEqual(ORGANIZER.git_root_and_common_dir(str(folder)), expected[str(folder)], str(folder))
        # A worktree and its main clone share one git directory; an unrelated repository and a plain folder do not.
        self.assertEqual(expected[str(main)][1], expected[str(task)][1])
        self.assertEqual(expected[str(task / "deep" / "er")][0], str(task))
        self.assertNotEqual(expected[str(other)][1], expected[str(main)][1])
        self.assertIsNone(expected[str(outside)])
        self.assertEqual(expected[str(main / "missing" / "file.txt")][0], str(main), "a path that is gone resolves through its nearest folder")

    def test_repository_lookup_asks_git_when_a_marker_is_unreadable(self):
        main, _, _, _ = self.agent_world()
        broken = main.parent.parent / "broken"
        broken.mkdir()
        (broken / ".git").write_text("not a git marker\n")
        ORGANIZER.git_root_and_common_dir.cache_clear()
        calls = []
        real = ORGANIZER.subprocess.run
        def spy(*args, **kwargs):
            calls.append(args[0])
            return real(*args, **kwargs)
        with patch.object(ORGANIZER.subprocess, "run", side_effect=spy):
            self.assertIsNone(ORGANIZER.git_root_and_common_dir(str(broken)))
            self.assertEqual(len(calls), 1)
            self.assertIsNotNone(ORGANIZER.git_root_and_common_dir(str(main)))
            self.assertEqual(len(calls), 1, "a normal clone is answered without git")

    def test_nothing_is_inferred_without_a_clone_other_than_the_shells_own(self):
        main, task, other, logs = self.agent_world()
        sid = "11111111-aaaa-bbbb-cccc-222222222222"
        self.write_log(logs, sid, paths=[main / "a.txt", other / "a.txt", "/etc/hosts"])
        self.assertIsNone(ORGANIZER.inferred_agent_folder(self.agent_pane(main, sid)), "another repository is not a clone of this project")
        self.assertEqual([f["source"] for f in ORGANIZER.pane_working_folders([self.agent_pane(main, sid)])], ["pane"])
        self.assertIsNone(ORGANIZER.inferred_agent_folder(self.agent_pane(main, "99999999-0000-0000-0000-000000000000")), "no log")
        pane = self.agent_pane(main, sid)
        pane["agent"] = "codex"
        self.assertIsNone(ORGANIZER.inferred_agent_folder(pane), "only Claude session logs are read")
        pane = self.agent_pane(other.parent, sid)
        self.assertIsNone(ORGANIZER.inferred_agent_folder(pane), "a shell outside any repository has no project to match")

    def test_a_session_id_cannot_point_the_log_search_elsewhere(self):
        self.agent_world()
        for bad in ("../x", "a/b", "", "*", "short"):
            self.assertIsNone(ORGANIZER.claude_session_log(bad), bad)

    def test_a_tab_without_a_reported_folder_has_an_empty_list(self):
        snapshot = {"tabs": [{"workspace_id": "w1", "tab_id": "w1:t1"}], "panes": [{"tab_id": "w1:t1", "pane_id": "w1:p1"}]}
        workspace = ORGANIZER.public_workspace(snapshot, {"workspace_id": "w1", "label": "W"}, "esim", [])
        self.assertEqual(workspace["tabs"][0]["working_folders"], [])

    def test_delete_archived_tab_removes_its_recovery_metadata(self):
        archive = {
            "archive_id": "example",
            "capture": {
                "tabs": [
                    {"source_tab_id": "w1:t1", "layout": {"root": {"type": "pane", "pane_id": "p1"}}},
                    {"source_tab_id": "w1:t2", "layout": {"root": {"type": "pane", "pane_id": "p2"}}},
                ]
            },
            "tab_restores": [
                {"source_tab_id": "w1:t1", "pane_map": {"p1": "new-p1"}},
                {"source_tab_id": "w1:t2", "pane_map": {"p2": "new-p2"}},
            ],
            "restore": {
                "tabs": [{"source_tab_id": "w1:t1"}, {"source_tab_id": "w1:t2"}],
                "agent_resume": [{"source_pane_id": "p1"}, {"source_pane_id": "p2"}],
                "pane_map": {"p1": "new-p1", "p2": "new-p2"},
            },
        }
        ORGANIZER.delete_archived_tab(archive, "w1:t1")
        self.assertEqual([tab["source_tab_id"] for tab in archive["capture"]["tabs"]], ["w1:t2"])
        self.assertEqual([item["source_tab_id"] for item in archive["tab_restores"]], ["w1:t2"])
        self.assertEqual([item["source_tab_id"] for item in archive["restore"]["tabs"]], ["w1:t2"])
        self.assertEqual(archive["restore"]["agent_resume"], [{"source_pane_id": "p2"}])
        self.assertEqual(archive["restore"]["pane_map"], {"p2": "new-p2"})

    def test_delete_archived_tab_rejects_the_last_tab(self):
        archive = {
            "archive_id": "example",
            "capture": {"tabs": [{"source_tab_id": "w1:t1", "layout": {"root": {"type": "pane", "pane_id": "p1"}}}]},
        }
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "last tab"):
            ORGANIZER.delete_archived_tab(archive, "w1:t1")

    def test_unverified_native_codex_metadata_is_not_resumable(self):
        panes = [
            {
                "pane_id": "w1:p1",
                "agent_session": {"agent": "codex", "kind": "id", "value": "session-123"},
                "agent": "codex",
            }
        ]
        with patch.object(ORGANIZER, "agent_session_from_process", return_value=None):
            restore = ORGANIZER.agent_restore_records(panes, "esim", [])
        self.assertEqual(restore[0]["restore_status"], "shell_only")
        self.assertEqual(restore[0]["restore_source"], "unavailable")
        self.assertIsNone(restore[0]["resume_command"])

    def test_codex_rollout_file_verifies_a_native_session(self):
        session_id = "01a013cd-9bc3-74a3-bb56-a0b806e74f9c"
        with tempfile.TemporaryDirectory() as temporary:
            sessions = Path(temporary) / "sessions" / "2026" / "09" / "10"
            sessions.mkdir(parents=True)
            (sessions / f"rollout-{session_id}.jsonl").write_text(
                json.dumps({"type": "session_meta", "payload": {"session_id": session_id}}) + "\n"
            )
            ORGANIZER.cached_codex_session_exists.cache_clear()
            with patch.object(ORGANIZER, "CODEX_SESSION_INDEX_PATH", Path(temporary) / "missing.jsonl"), patch.object(
                ORGANIZER, "CODEX_SESSIONS_DIR", Path(temporary) / "sessions"
            ):
                self.assertTrue(ORGANIZER.codex_session_exists(session_id))
            ORGANIZER.cached_codex_session_exists.cache_clear()

    def test_interactive_codex_match_requires_two_visible_prompts_and_matching_cwd(self):
        session_id = "01a013cd-9bc3-74a3-bb56-a0b806e74f9c"
        with tempfile.TemporaryDirectory() as temporary:
            sessions = Path(temporary) / "sessions" / "2026" / "09" / "10"
            sessions.mkdir(parents=True)
            rollout = sessions / f"rollout-{session_id}.jsonl"
            rollout.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "session_meta",
                                "payload": {"session_id": session_id, "cwd": "/workspace/project"},
                            }
                        ),
                        json.dumps(
                            {
                                "type": "response_item",
                                "payload": {
                                    "type": "message",
                                    "role": "user",
                                    "content": [
                                        {"type": "input_text", "text": "Please investigate the first release failure."}
                                    ],
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "response_item",
                                "payload": {
                                    "type": "message",
                                    "role": "user",
                                    "content": [
                                        {"type": "input_text", "text": "Then update the release notes for me."}
                                    ],
                                },
                            }
                        ),
                    ]
                )
                + "\n"
            )
            prompts = (
                "please investigate the first release failure.",
                "then update the release notes for me.",
            )
            with patch.object(ORGANIZER, "CODEX_SESSIONS_DIR", Path(temporary) / "sessions"):
                self.assertEqual(
                    ORGANIZER.matching_codex_rollout_sessions(prompts, "/workspace/project", set()),
                    {session_id},
                )
                self.assertEqual(
                    ORGANIZER.matching_codex_rollout_sessions(prompts, "/wrong/project", set()), set()
                )
                self.assertEqual(
                    ORGANIZER.matching_codex_rollout_sessions(prompts, "/workspace/project", {session_id}), set()
                )
                self.assertEqual(
                    ORGANIZER.matching_codex_rollout_sessions(prompts[:1], "/workspace/project", set()), set()
                )

    def test_interactive_codex_match_becomes_a_resumable_record(self):
        panes = [{"pane_id": "w1:p1", "agent": "codex"}]
        with patch.object(ORGANIZER, "agent_session_from_process", return_value=None), patch.object(
            ORGANIZER, "native_codex_session", return_value=None
        ), patch.object(
            ORGANIZER, "codex_interactive_resume_session", return_value=("codex", "session-123")
        ):
            restore = ORGANIZER.agent_restore_records(panes, "esim", [])
        self.assertEqual(restore[0]["restore_status"], "resumable")
        self.assertEqual(restore[0]["restore_source"], "local_rollout")
        self.assertEqual(restore[0]["resume_command"], "codex resume session-123")

    def test_process_session_becomes_a_resumable_record(self):
        panes = [{"pane_id": "w1:p1", "agent": "claude"}]
        with patch.object(ORGANIZER, "agent_session_from_process", return_value=("claude", "session-123")):
            restore = ORGANIZER.agent_restore_records(panes, "esim", [])
        self.assertEqual(restore[0]["restore_status"], "resumable")
        self.assertEqual(restore[0]["resume_command"], "claude --resume session-123")
        self.assertEqual(restore[0]["restore_source"], "process")

    def test_invalid_claude_manifest_session_is_not_resumable(self):
        panes = [{"pane_id": "w1:p1", "agent": "claude"}]
        manifest = [{"pane_id": "w1:p1", "herdr_session": "esim", "client": "claude", "session_id": "invalid"}]
        with patch.object(ORGANIZER, "agent_session_from_process", return_value=None), patch.object(
            ORGANIZER, "claude_session_exists", return_value=False
        ):
            restore = ORGANIZER.agent_restore_records(panes, "esim", manifest)
        self.assertEqual(restore[0]["restore_status"], "shell_only")
        self.assertEqual(restore[0]["restore_source"], "unavailable")
        self.assertIsNone(restore[0]["resume_command"])

    def test_verified_native_codex_session_is_resumable(self):
        panes = [
            {
                "pane_id": "w1:p1",
                "agent": "codex",
                "agent_session": {"agent": "codex", "source": "herdr:codex", "value": "session-123"},
            }
        ]
        with patch.object(ORGANIZER, "agent_session_from_process", return_value=None), patch.object(
            ORGANIZER, "codex_session_exists", return_value=True
        ):
            restore = ORGANIZER.agent_restore_records(panes, "esim", [])
        self.assertEqual(restore[0]["restore_status"], "resumable")
        self.assertEqual(restore[0]["restore_source"], "native_codex")
        self.assertEqual(restore[0]["resume_command"], "codex resume session-123")

    def test_resume_captured_tabs_uses_atomic_pane_run(self):
        tabs = [
            {
                "agent_restores": [
                    {
                        "source_pane_id": "old-pane",
                        "restore_status": "resumable",
                        "resume_command": "resume-command",
                        "restore_source": "process",
                    }
                ]
            }
        ]
        with patch.object(ORGANIZER, "run_command") as run_command:
            outcomes = ORGANIZER.resume_captured_tabs(tabs, {"old-pane": "new-pane"}, "test")
        self.assertEqual(
            outcomes,
            [{"source_pane_id": "old-pane", "pane_id": "new-pane", "status": "sent", "action": "resumed"}],
        )
        run_command.assert_called_once_with(["pane", "run", "new-pane", "resume-command"], "test")


class RestartRecoveryTests(unittest.TestCase):
    def snapshot(self, *, pane_agent=None, pane_status=None, cwd=None, focused=True):
        path = cwd or tempfile.gettempdir()
        pane = {
            "workspace_id": "w1",
            "tab_id": "w1:t1",
            "pane_id": "w1:p1",
            "cwd": path,
            "foreground_cwd": path,
        }
        if pane_agent:
            pane["agent"] = pane_agent
            pane["agent_status"] = pane_status or "idle"
        return {
            "workspaces": [{"workspace_id": "w1", "label": "One", "cwd": path, "focused": focused}],
            "tabs": [{"workspace_id": "w1", "tab_id": "w1:t1", "label": "One tab"}],
            "panes": [pane],
        }

    @staticmethod
    def layout(tab_id="w1:t1", pane_id="w1:p1"):
        return {"tab_id": tab_id, "root": {"type": "pane", "pane_id": pane_id}}

    def source_workspace(
        self, session="lab", workspace_id="w1", *, agent_restore=None, label="One", focused=False
    ):
        agent_restore = agent_restore or {"source_pane_id": "w1:p1", "restore_status": "shell_only"}
        layout = self.layout(f"{workspace_id}:t1", f"{workspace_id}:p1")
        tab = {
            "identity": ORGANIZER.recovery_identity(session, workspace_id, f"{workspace_id}:t1"),
            "label": "One tab",
            "index": 0,
            "focused": False,
            "layout": layout,
            "layout_shape_fingerprint": ORGANIZER.layout_shape_fingerprint(layout),
            "panes": [
                {
                    "identity": ORGANIZER.recovery_identity(session, workspace_id, f"{workspace_id}:t1", f"{workspace_id}:p1"),
                    "cwd": tempfile.gettempdir(),
                    "agent_restore": agent_restore,
                }
            ],
        }
        source = {
            "identity": ORGANIZER.recovery_identity(session, workspace_id),
            "label": label,
            "cwd": tempfile.gettempdir(),
            "focused": focused,
            "tabs": [tab],
        }
        source["fingerprint"] = ORGANIZER.recovery_workspace_fingerprint(source)
        return source

    def mixed_snapshot(self, *, missing_second_cwd=False):
        first_cwd = tempfile.gettempdir()
        second_cwd = None if missing_second_cwd else os.getcwd()
        snapshot = self.snapshot(cwd=first_cwd)
        snapshot["workspaces"][0]["cwd"] = None
        snapshot["panes"].append(
            {
                "workspace_id": "w1",
                "tab_id": "w1:t1",
                "pane_id": "w1:p2",
                "cwd": second_cwd,
                "foreground_cwd": second_cwd,
            }
        )
        layout = {
            "tab_id": "w1:t1",
            "root": {
                "type": "split",
                "first": {"type": "pane", "pane_id": "w1:p1"},
                "second": {"type": "pane", "pane_id": "w1:p2"},
            },
        }
        return snapshot, {"w1:t1": layout}, first_cwd

    def test_compound_identity_preserves_all_namespace_fields(self):
        first = ORGANIZER.recovery_identity("esim", "w1", "w1:t1", "w1:p1")
        second = ORGANIZER.recovery_identity("Misc", "w1", "w1:t1", "w1:p1")
        self.assertEqual(set(first), {"herdr_session", "workspace_id", "tab_id", "pane_id"})
        self.assertNotEqual(ORGANIZER.recovery_identity_key(first), ORGANIZER.recovery_identity_key(second))

    def test_registry_scan_replaces_only_same_session_and_pane(self):
        session_id = "01a013cd-9bc3-74a3-bb56-a0b806e74f9c"
        pane = REGISTRY.PaneInfo("esim", "w1:p1", "w1", "w1:t1", tempfile.gettempdir(), tempfile.gettempdir(), "codex", "idle")
        with tempfile.TemporaryDirectory() as temporary:
            manifest = Path(temporary) / "manifest.json"
            REGISTRY.write_manifest(
                manifest,
                {"panes": [{"herdr_session": "Misc", "pane_id": "w1:p1", "session_id": "kept", "client": "codex"}]},
            )
            args = argparse.Namespace(
                manifest=str(manifest), missing_json=str(Path(temporary) / "missing.json"), client=None,
                execute=True, status=False, lines=20, source="recent", no_missing_json=True, verbose=False,
            )
            with patch.object(REGISTRY, "snapshot_panes", return_value=[pane]), patch.object(
                REGISTRY, "current_herdr_session", return_value="esim"
            ), patch.object(REGISTRY, "detect_from_native", return_value=("codex", session_id)), patch.object(
                REGISTRY, "git_context", return_value=(tempfile.gettempdir(), "main")
            ), patch.object(REGISTRY, "run_json") as run_json:
                self.assertEqual(REGISTRY.scan(args), 0)
            run_json.assert_not_called()
            records = REGISTRY.read_manifest(manifest)["panes"]
        self.assertEqual({(row["herdr_session"], row["pane_id"]) for row in records}, {("Misc", "w1:p1"), ("esim", "w1:p1")})

    def test_registry_status_capture_accepts_done_agent(self):
        pane = REGISTRY.PaneInfo(
            "esim", "w1:p1", "w1", "w1:t1", tempfile.gettempdir(), tempfile.gettempdir(), "codex", "done"
        )
        with patch.object(REGISTRY, "pane_send_status", return_value=True), patch.object(
            REGISTRY, "pane_read_text", return_value="Session ID: verified-done-session"
        ), patch.object(REGISTRY, "log_status_event"), patch.object(REGISTRY.time, "sleep"):
            self.assertEqual(REGISTRY.detect_from_status(pane, lines=20), ("codex", "verified-done-session"))

    @staticmethod
    def registry_scan_args(manifest: Path, *, status=False):
        return argparse.Namespace(
            manifest=str(manifest),
            missing_json=str(manifest.with_name("missing.json")),
            client=None,
            execute=False,
            status=status,
            lines=20,
            source="recent",
            no_missing_json=True,
            verbose=False,
        )

    def test_registry_scan_redacts_done_status_recovery_id(self):
        private_id = "done-status-private-id"
        pane = REGISTRY.PaneInfo(
            "esim", "w1:p1", "w1", "w1:t1", tempfile.gettempdir(), tempfile.gettempdir(), "codex", "done"
        )
        with tempfile.TemporaryDirectory() as temporary:
            output = io.StringIO()
            errors = io.StringIO()
            with patch.object(REGISTRY, "snapshot_panes", return_value=[pane]), patch.object(
                REGISTRY, "current_herdr_session", return_value="esim"
            ), patch.object(REGISTRY, "detect_from_native", return_value=None), patch.object(
                REGISTRY, "detect_from_process", return_value=None
            ), patch.object(REGISTRY, "detect_from_status", return_value=("codex", private_id)), patch.object(
                REGISTRY, "git_context", return_value=(tempfile.gettempdir(), "main")
            ), redirect_stdout(output), redirect_stderr(errors):
                self.assertEqual(REGISTRY.scan(self.registry_scan_args(Path(temporary) / "manifest.json", status=True)), 0)
        self.assertNotIn(private_id, output.getvalue())
        self.assertNotIn(private_id, errors.getvalue())
        self.assertIn("source=status", output.getvalue())

    def test_registry_scan_redacts_process_recovery_id(self):
        private_id = "process-private-id"
        pane = REGISTRY.PaneInfo(
            "esim", "w1:p1", "w1", "w1:t1", tempfile.gettempdir(), tempfile.gettempdir(), "codex", "idle"
        )
        with tempfile.TemporaryDirectory() as temporary:
            output = io.StringIO()
            errors = io.StringIO()
            with patch.object(REGISTRY, "snapshot_panes", return_value=[pane]), patch.object(
                REGISTRY, "current_herdr_session", return_value="esim"
            ), patch.object(REGISTRY, "detect_from_native", return_value=None), patch.object(
                REGISTRY, "detect_from_process", return_value=("codex", private_id)
            ), patch.object(REGISTRY, "git_context", return_value=(tempfile.gettempdir(), "main")), redirect_stdout(
                output
            ), redirect_stderr(errors):
                self.assertEqual(REGISTRY.scan(self.registry_scan_args(Path(temporary) / "manifest.json")), 0)
        self.assertNotIn(private_id, output.getvalue())
        self.assertNotIn(private_id, errors.getvalue())
        self.assertIn("source=process", output.getvalue())

    def test_registry_scan_redacts_keep_registration_id(self):
        private_id = "keep-private-id"
        pane = REGISTRY.PaneInfo(
            "esim", "w1:p1", "w1", "w1:t1", tempfile.gettempdir(), tempfile.gettempdir(), "codex", "idle"
        )
        output = io.StringIO()
        errors = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(REGISTRY, "snapshot_panes", return_value=[pane]), patch.object(
                REGISTRY, "current_herdr_session", return_value="esim"
            ), patch.object(
                REGISTRY,
                "existing_records_by_pane",
                return_value={("esim", "w1:p1"): {"session_id": private_id}},
            ), patch.object(REGISTRY, "existing_registration_matches", return_value=True), redirect_stdout(
                output
            ), redirect_stderr(errors):
                self.assertEqual(REGISTRY.scan(self.registry_scan_args(Path(temporary) / "manifest.json")), 0)
        self.assertNotIn(private_id, output.getvalue())
        self.assertNotIn(private_id, errors.getvalue())
        self.assertIn("existing registration kept", output.getvalue())

    def test_registry_list_redacts_ids_unless_explicitly_requested(self):
        private_id = "list-private-id"
        with tempfile.TemporaryDirectory() as temporary:
            manifest = Path(temporary) / "manifest.json"
            REGISTRY.write_manifest(
                manifest,
                {"panes": [{"herdr_session": "esim", "pane_id": "w1:p1", "client": "codex", "status": "active", "session_id": private_id, "cwd": tempfile.gettempdir()}]},
            )
            args = argparse.Namespace(
                manifest=str(manifest), client=None, status=None, workspace_id=None, show_session_ids=False
            )
            output = io.StringIO()
            with redirect_stdout(output):
                REGISTRY.list_records(args)
            self.assertNotIn(private_id, output.getvalue())
            self.assertIn("session IDs redacted", output.getvalue())
            args.show_session_ids = True
            output = io.StringIO()
            with redirect_stdout(output):
                REGISTRY.list_records(args)
            self.assertIn(private_id, output.getvalue())
            self.assertIn("explicitly requested", output.getvalue())

    def test_registry_state_files_and_locks_are_private_when_created(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            state.mkdir(mode=0o700)
            manifest = state / "manifest.json"
            missing = state / "missing.json"
            status = state / "status.jsonl"
            REGISTRY.write_manifest(manifest, {"panes": []})
            REGISTRY.write_missing_json(missing, [])
            pane = REGISTRY.PaneInfo("esim", "w1:p1", "w1", "w1:t1", tempfile.gettempdir(), tempfile.gettempdir())
            with patch.dict(os.environ, {"PMOS_HERDR_AGENT_STATUS_LOG": str(status)}):
                REGISTRY.log_status_event(pane, "sent", command="/status")
            with REGISTRY.manifest_lock(manifest):
                pass
            self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
            for path in [manifest, missing, status, manifest.with_suffix(manifest.suffix + ".lock"), status.with_suffix(status.suffix + ".lock")]:
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path)

    def test_registry_state_files_and_locks_tighten_permissive_existing_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            state.mkdir(mode=0o700)
            manifest = state / "manifest.json"
            missing = state / "missing.json"
            status = state / "status.jsonl"
            manifest.write_text(json.dumps({"panes": []}))
            missing.write_text(json.dumps({"items": []}))
            status.write_text("")
            manifest_lock = manifest.with_suffix(manifest.suffix + ".lock")
            status_lock = status.with_suffix(status.suffix + ".lock")
            manifest_lock.write_text("")
            status_lock.write_text("")
            for path in [manifest, missing, status, manifest_lock, status_lock]:
                path.chmod(0o644)
            REGISTRY.read_manifest(manifest)
            REGISTRY.write_missing_json(missing, [])
            pane = REGISTRY.PaneInfo("esim", "w1:p1", "w1", "w1:t1", tempfile.gettempdir(), tempfile.gettempdir())
            with patch.dict(os.environ, {"PMOS_HERDR_AGENT_STATUS_LOG": str(status)}):
                REGISTRY.log_status_event(pane, "sent", command="/status")
            with REGISTRY.manifest_lock(manifest):
                pass
            self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
            for path in [manifest, missing, status, manifest_lock, status_lock]:
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path)

    def test_registry_override_sources_reject_untrusted_parents_without_chmod(self):
        pane = REGISTRY.PaneInfo("esim", "w1:p1", "w1", "w1:t1", tempfile.gettempdir(), tempfile.gettempdir())

        def assert_rejected(path, action):
            before = stat.S_IMODE(path.parent.stat().st_mode)
            with self.assertRaisesRegex(SystemExit, "private Herdr agent state parent is not secure"):
                action()
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), before, path.parent)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_flag = root / "manifest-flag" / "manifest.json"
            manifest_env = root / "manifest-env" / "manifest.json"
            missing_flag = root / "missing-flag" / "missing.json"
            missing_env = root / "missing-env" / "missing.json"
            status_env = root / "status-env" / "status.jsonl"
            paths = [manifest_flag, manifest_env, missing_flag, missing_env, status_env]
            for path in paths:
                path.parent.mkdir(mode=0o755)

            manifest_args = argparse.Namespace(manifest=str(manifest_flag))
            assert_rejected(manifest_flag, lambda: REGISTRY.read_manifest(REGISTRY.manifest_path(manifest_args)))
            with patch.dict(os.environ, {"PMOS_HERDR_AGENT_MANIFEST": str(manifest_env)}):
                assert_rejected(
                    manifest_env,
                    lambda: REGISTRY.read_manifest(REGISTRY.manifest_path(argparse.Namespace(manifest=None))),
                )

            missing_args = argparse.Namespace(missing_json=str(missing_flag))
            assert_rejected(
                missing_flag,
                lambda: REGISTRY.write_missing_json(REGISTRY.missing_json_path(missing_args), []),
            )
            with patch.dict(os.environ, {"PMOS_HERDR_AGENT_MISSING_JSON": str(missing_env)}):
                assert_rejected(
                    missing_env,
                    lambda: REGISTRY.write_missing_json(
                        REGISTRY.missing_json_path(argparse.Namespace(missing_json=None)), []
                    ),
                )

            with patch.dict(os.environ, {"PMOS_HERDR_AGENT_STATUS_LOG": str(status_env)}):
                assert_rejected(status_env, lambda: REGISTRY.log_status_event(pane, "sent", command="/status"))

    def test_registry_override_sources_work_with_private_parents(self):
        pane = REGISTRY.PaneInfo("esim", "w1:p1", "w1", "w1:t1", tempfile.gettempdir(), tempfile.gettempdir())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_flag = root / "manifest-flag" / "manifest.json"
            manifest_env = root / "manifest-env" / "manifest.json"
            missing_flag = root / "missing-flag" / "missing.json"
            missing_env = root / "missing-env" / "missing.json"
            status_env = root / "status-env" / "status.jsonl"
            for path in [manifest_flag, manifest_env, missing_flag, missing_env, status_env]:
                path.parent.mkdir(mode=0o700)

            REGISTRY.write_manifest(manifest_flag, {"panes": []})
            with patch.dict(os.environ, {"PMOS_HERDR_AGENT_MANIFEST": str(manifest_env)}):
                REGISTRY.write_manifest(REGISTRY.manifest_path(argparse.Namespace(manifest=None)), {"panes": []})
            REGISTRY.write_missing_json(missing_flag, [])
            with patch.dict(os.environ, {"PMOS_HERDR_AGENT_MISSING_JSON": str(missing_env)}):
                REGISTRY.write_missing_json(
                    REGISTRY.missing_json_path(argparse.Namespace(missing_json=None)), []
                )
            with patch.dict(os.environ, {"PMOS_HERDR_AGENT_STATUS_LOG": str(status_env)}):
                REGISTRY.log_status_event(pane, "sent", command="/status")

            for path in [manifest_flag, manifest_env, missing_flag, missing_env, status_env]:
                self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700, path.parent)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path)

    def test_restore_redacts_resume_command_unless_explicitly_requested(self):
        private_id = "restore-private-id"
        item = {
            "herdr_session": "esim",
            "pane_id": "w1:p1",
            "workspace_id": "w1",
            "tab_id": "w1:t1",
            "client": "codex",
            "session_id": private_id,
            "resume_command": f"codex resume {private_id}",
            "cwd": tempfile.gettempdir(),
            "status": "active",
        }
        args = argparse.Namespace(
            manifest="unused",
            execute=False,
            force=False,
            all=False,
            pane_id=None,
            client=None,
            session_id=None,
            workspace_id=None,
            tab_id=None,
            herdr_session="esim",
            show_resume_commands=False,
        )
        live = {"w1:p1": {"workspace_id": "w1", "tab_id": "w1:t1", "cwd": tempfile.gettempdir()}}
        with patch.object(RESTORE, "read_manifest", return_value={"panes": [item]}), patch.object(
            RESTORE, "pane_list", return_value=live
        ), patch.object(RESTORE, "target_ready", return_value=(True, None)):
            output = io.StringIO()
            with redirect_stdout(output):
                RESTORE.restore(args)
        self.assertNotIn(private_id, output.getvalue())
        self.assertIn("redacted", output.getvalue())
        args.show_resume_commands = True
        with patch.object(RESTORE, "read_manifest", return_value={"panes": [item]}), patch.object(
            RESTORE, "pane_list", return_value=live
        ), patch.object(RESTORE, "target_ready", return_value=(True, None)):
            output = io.StringIO()
            with redirect_stdout(output):
                RESTORE.restore(args)
        self.assertIn(private_id, output.getvalue())
        self.assertIn("explicitly requested", output.getvalue())

    def test_restore_execute_send_error_does_not_echo_resume_command(self):
        private_id = "execute-private-id"
        item = {
            "herdr_session": "esim",
            "pane_id": "w1:p1",
            "workspace_id": "w1",
            "tab_id": "w1:t1",
            "client": "codex",
            "session_id": private_id,
            "resume_command": f"codex resume {private_id}",
            "cwd": tempfile.gettempdir(),
            "status": "active",
        }
        args = argparse.Namespace(
            manifest="unused",
            execute=True,
            force=False,
            all=False,
            pane_id=None,
            client=None,
            session_id=None,
            workspace_id=None,
            tab_id=None,
            herdr_session="esim",
            show_resume_commands=False,
        )
        live = {"w1:p1": {"workspace_id": "w1", "tab_id": "w1:t1", "cwd": tempfile.gettempdir()}}
        failed = RESTORE.subprocess.CompletedProcess(
            ["herdr", "pane", "send-text"],
            17,
            stdout=f"submitted codex resume {private_id}",
            stderr=f"send failed after codex resume {private_id}",
        )
        output = io.StringIO()
        errors = io.StringIO()
        with patch.object(RESTORE, "read_manifest", return_value={"panes": [item]}), patch.object(
            RESTORE, "pane_list", return_value=live
        ), patch.object(RESTORE, "target_ready", return_value=(True, None)), patch.object(
            RESTORE.subprocess, "run", return_value=failed
        ), redirect_stdout(output), redirect_stderr(errors):
            with self.assertRaises(SystemExit) as raised:
                RESTORE.restore(args)
        self.assertNotIn(private_id, output.getvalue())
        self.assertNotIn(private_id, errors.getvalue())
        self.assertNotIn(private_id, str(raised.exception))
        self.assertIn("w1:p1", str(raised.exception))
        self.assertIn("exit code 17", str(raised.exception))

    @staticmethod
    def restore_args(manifest=None):
        return argparse.Namespace(
            manifest=manifest,
            execute=False,
            force=False,
            all=False,
            pane_id=None,
            client=None,
            session_id=None,
            workspace_id=None,
            tab_id=None,
            herdr_session="esim",
            show_resume_commands=False,
        )

    def test_restore_tightens_permissive_manifest_with_private_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary) / "state"
            parent.mkdir(mode=0o700)
            manifest = parent / "manifest.json"
            manifest.write_text(json.dumps({"panes": []}))
            manifest.chmod(0o644)
            self.assertEqual(RESTORE.restore(self.restore_args(str(manifest))), 0)
            self.assertEqual(stat.S_IMODE(manifest.stat().st_mode), 0o600)

    def test_restore_rejects_unsafe_override_parent_without_chmod(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary) / "state"
            parent.mkdir(mode=0o755)
            manifest = parent / "manifest.json"
            manifest.write_text(json.dumps({"panes": []}))
            before = stat.S_IMODE(parent.stat().st_mode)
            with self.assertRaisesRegex(SystemExit, "private Herdr agent state parent is not secure"):
                RESTORE.restore(self.restore_args(str(manifest)))
            self.assertEqual(stat.S_IMODE(parent.stat().st_mode), before)

    def test_restore_rejects_unsafe_manifest_environment_parent_without_chmod(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary) / "state"
            parent.mkdir(mode=0o755)
            manifest = parent / "manifest.json"
            manifest.write_text(json.dumps({"panes": []}))
            before = stat.S_IMODE(parent.stat().st_mode)
            with patch.dict(os.environ, {"PMOS_HERDR_AGENT_MANIFEST": str(manifest)}):
                with self.assertRaisesRegex(SystemExit, "private Herdr agent state parent is not secure"):
                    RESTORE.restore(self.restore_args())
            self.assertEqual(stat.S_IMODE(parent.stat().st_mode), before)

    def test_empty_registry_scan_prints_named_session_socket_guidance(self):
        session_list = {
            "sessions": [
                {"name": "default", "default": True, "status": "running", "session_dir": "/private/herdr/default"},
                {"name": "esim", "status": "running", "session_dir": "/private/herdr/esim"},
                {"name": "Misc", "running": True, "socket_path": "/private/herdr/Misc/custom.sock"},
            ]
        }
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary:
            args = argparse.Namespace(
                manifest=str(Path(temporary) / "unused-manifest.json"),
                missing_json=str(Path(temporary) / "unused-missing.json"),
                client=None,
                execute=False,
                status=False,
                lines=20,
                source="recent",
                no_missing_json=True,
                verbose=False,
            )
            with patch.object(REGISTRY, "snapshot_panes", return_value=[]), patch.object(
                REGISTRY, "run_json", return_value=session_list
            ) as run_json, redirect_stderr(output):
                self.assertEqual(REGISTRY.scan(args), 1)
        self.assertEqual(run_json.call_args.args[0], ["herdr", "session", "list", "--json"])
        details = output.getvalue()
        self.assertIn("This scan only sees the Herdr session this shell is attached to.", details)
        self.assertIn("herdr session list --json", details)
        self.assertIn("esim /private/herdr/esim/herdr.sock", details)
        self.assertIn("Misc /private/herdr/Misc/custom.sock", details)
        self.assertNotIn("  default /private/herdr/default", details)
        self.assertIn(
            "HERDR_SESSION=Misc HERDR_SOCKET_PATH=/private/herdr/Misc/custom.sock herdr-agent-capture-history",
            details,
        )
        self.assertIn(
            "HERDR_SESSION=esim HERDR_SOCKET_PATH=/private/herdr/esim/herdr.sock herdr-agent-capture-history",
            details,
        )
        self.assertIn("inside an existing pane of that session", details)

    def test_recovery_commands_use_named_session_and_reject_unattached(self):
        snapshot = self.snapshot()
        with patch.object(ORGANIZER, "socket_call", return_value={"layout": self.layout()}) as socket_call:
            ORGANIZER.recovery_layouts(snapshot, "lab")
        self.assertEqual(socket_call.call_args.args[0], "lab")
        capture = {"session": "lab", "workspaces": []}
        with patch.object(ORGANIZER, "session_snapshot", side_effect=ORGANIZER.OrganizerError("socket absent")):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "not attached"):
                ORGANIZER.plan_recovery_session(capture)

    def test_bundle_checksums_permissions_and_preview_have_no_side_effects(self):
        capture = {"session": "lab", "workspaces": [], "structure": {}, "layout_fingerprints": {}, "preflight": {}}
        with tempfile.TemporaryDirectory() as temporary, patch.object(ORGANIZER, "RECOVERY_BUNDLE_DIR", Path(temporary) / "bundles"), patch.object(
            ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"
        ):
            bundle_id = ORGANIZER.write_recovery_bundle([capture])
            bundle_path, manifest, loaded = ORGANIZER.load_recovery_bundle(bundle_id)
            self.assertEqual(loaded, [capture])
            self.assertEqual(manifest["schema_version"], ORGANIZER.RECOVERY_SCHEMA_VERSION)
            self.assertEqual(os.stat(bundle_path).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(bundle_path / "manifest.json").st_mode & 0o777, 0o600)
            session_path = bundle_path / next(iter(manifest["checksums"]))
            self.assertEqual(os.stat(session_path).st_mode & 0o777, 0o600)
            args = argparse.Namespace(bundle=bundle_id, confirm=None, copy_ambiguous=False, confirm_extra=None, resume_agents=False)
            with patch.object(ORGANIZER, "plan_recovery_session", return_value={"session": "lab", "workspaces": []}):
                ORGANIZER.reconcile_all_command(args)
            self.assertFalse((Path(temporary) / "journals").exists())
            (session_path).write_text("tampered")
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "checksum"):
                ORGANIZER.load_recovery_bundle(bundle_id)

    def test_stable_capture_refuses_changed_structure(self):
        first = self.snapshot()
        second = copy.deepcopy(first)
        second["tabs"].append({"workspace_id": "w1", "tab_id": "w1:t2"})
        preflight = {"classifications": [], "failures": []}
        with patch.object(ORGANIZER, "session_snapshot", side_effect=[first, second]), patch.object(
            ORGANIZER, "recovery_layouts", side_effect=[{"w1:t1": self.layout()}, {"w1:t1": self.layout()}]
        ):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "changed during"):
                ORGANIZER.stable_recovery_capture("lab", preflight, 1)

    def test_preflight_classifies_every_blocking_and_acknowledged_case(self):
        identity = ORGANIZER.recovery_identity("lab", "w1", "w1:t1", "w1:p1")
        trusted_restore = {
            "source_pane_id": "w1:p1",
            "client": "codex",
            "session_id": "verified-id",
            "resume_command": "codex resume verified-id",
            "restore_status": "resumable",
            "restore_source": "manifest",
        }
        busy, failure = ORGANIZER.recovery_pane_classification(
            {"workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1", "agent": "codex", "agent_status": "working"}, {}, "lab", set()
        )
        unresolved, unresolved_failure = ORGANIZER.recovery_pane_classification(
            {"workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1", "agent": "codex", "agent_status": "idle"}, {}, "lab", set()
        )
        with patch.object(
            ORGANIZER,
            "recovery_process_info",
            return_value={"shell_pid": 1, "foreground_processes": [{"pid": 1, "name": "zsh"}]},
        ):
            done_trusted, done_trusted_failure = ORGANIZER.recovery_pane_classification(
                {"workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1", "agent": "codex", "agent_status": "done"},
                trusted_restore,
                "lab",
                set(),
            )
        done_unverified, done_unverified_failure = ORGANIZER.recovery_pane_classification(
            {"workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1", "agent": "codex", "agent_status": "done"},
            {},
            "lab",
            set(),
        )
        with patch.object(ORGANIZER, "recovery_process_info", return_value={"shell_pid": 1, "foreground_processes": [{"pid": 2, "name": "node"}]}):
            blocker, blocker_failure = ORGANIZER.recovery_pane_classification(
                {"workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1"}, {}, "lab", set()
            )
            volatile, volatile_failure = ORGANIZER.recovery_pane_classification(
                {"workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1"}, {}, "lab", {ORGANIZER.recovery_identity_key(identity)}
            )
        with patch.object(ORGANIZER, "recovery_process_info", side_effect=ORGANIZER.OrganizerError("unknown")):
            unknown, unknown_failure = ORGANIZER.recovery_pane_classification(
                {"workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1"}, {}, "lab", set()
            )
        self.assertEqual((busy["classification"], failure["kind"]), ("busy_agent", "busy_agent"))
        self.assertEqual(
            (unresolved["classification"], unresolved_failure["kind"]),
            ("unverified_recovery_identity", "unverified_recovery_identity"),
        )
        self.assertFalse(unresolved["trusted_restore"])
        self.assertEqual((done_trusted["classification"], done_trusted_failure), ("verified_resumable_supported_agent", None))
        self.assertEqual(
            (done_unverified["classification"], done_unverified_failure["kind"]),
            ("unverified_recovery_identity", "unverified_recovery_identity"),
        )
        self.assertEqual((blocker["classification"], blocker_failure["kind"]), ("blocker", "blocker"))
        self.assertEqual((volatile["classification"], volatile_failure), ("intentionally_volatile", None))
        self.assertEqual((unknown["classification"], unknown_failure["kind"]), ("unknown_process_state", "unknown_process_state"))

    def test_preflight_reports_missing_cwd_and_registered_worktree(self):
        snapshot = self.snapshot(cwd="/definitely/missing/recovery-cwd")
        with patch.object(ORGANIZER, "session_snapshot", return_value=snapshot), patch.object(
            ORGANIZER, "recovery_layouts", return_value={"w1:t1": self.layout()}
        ), patch.object(ORGANIZER, "manifest_records", return_value=[{"herdr_session": "lab", "pane_id": "w1:p1", "worktree": "/missing/worktree"}]), patch.object(
            ORGANIZER, "agent_restore_records", return_value=[]
        ), patch.object(ORGANIZER, "recovery_process_info", return_value={"shell_pid": 1, "foreground_processes": [{"pid": 1, "name": "zsh"}]}
        ):
            preflight = ORGANIZER.recovery_preflight_session("lab", set())
        self.assertEqual({item["kind"] for item in preflight["failures"]}, {"missing_workspace_cwd", "missing_pane_cwd", "missing_registered_worktree"})

    def test_recovery_derives_omitted_workspace_cwd_from_consistent_panes(self):
        snapshot = self.snapshot()
        snapshot["workspaces"][0]["cwd"] = None
        with patch.object(ORGANIZER, "manifest_records", return_value=[]), patch.object(
            ORGANIZER, "agent_restore_records", return_value=[]
        ), patch.object(
            ORGANIZER, "recovery_process_info", return_value={"shell_pid": 1, "foreground_processes": [{"pid": 1, "name": "zsh"}]}
        ):
            preflight = ORGANIZER.recovery_preflight_snapshot("lab", snapshot, {"w1:t1": self.layout()}, set())
        self.assertNotIn("missing_workspace_cwd", {item["kind"] for item in preflight["failures"]})
        capture = ORGANIZER.recovery_capture_from_snapshot("lab", snapshot, {"w1:t1": self.layout()}, preflight)
        self.assertEqual(capture["workspaces"][0]["cwd"], tempfile.gettempdir())
        with patch.object(ORGANIZER, "recovery_layouts", return_value={"w1:t1": self.layout()}):
            native = ORGANIZER.native_recovery_workspace(snapshot, snapshot["workspaces"][0], "lab")
        self.assertEqual(native["cwd"], tempfile.gettempdir())
        state = {"expected_label": "One [rrb:0123456789abcdef01234567]", "expected_cwd": tempfile.gettempdir()}
        snapshot["workspaces"][0]["label"] = state["expected_label"]
        self.assertEqual(ORGANIZER.marked_recovery_workspaces(snapshot, state), [snapshot["workspaces"][0]])

    def test_mixed_pane_cwds_without_workspace_cwd_remain_unsupported(self):
        snapshot = self.snapshot()
        snapshot["workspaces"][0]["cwd"] = None
        snapshot["panes"].append(
            {
                "workspace_id": "w1",
                "tab_id": "w1:t1",
                "pane_id": "w1:p2",
                "cwd": os.getcwd(),
                "foreground_cwd": os.getcwd(),
            }
        )
        self.assertIsNone(ORGANIZER.recovery_workspace_cwd(snapshot, snapshot["workspaces"][0]))
        with patch.object(ORGANIZER, "manifest_records", return_value=[]), patch.object(
            ORGANIZER, "agent_restore_records", return_value=[]
        ), patch.object(
            ORGANIZER, "recovery_process_info", return_value={"shell_pid": 1, "foreground_processes": [{"pid": 1, "name": "zsh"}]}
        ):
            preflight = ORGANIZER.recovery_preflight_snapshot("lab", snapshot, {"w1:t1": self.layout()}, set())
        self.assertIn("mixed_workspace_cwd", {item["kind"] for item in preflight["failures"]})

    def test_mixed_cwd_acknowledgement_round_trips_and_preflight_passes(self):
        snapshot, layouts, first_cwd = self.mixed_snapshot()
        with patch.object(ORGANIZER, "manifest_records", return_value=[]), patch.object(
            ORGANIZER, "agent_restore_records", return_value=[]
        ), patch.object(
            ORGANIZER,
            "recovery_process_info",
            return_value={"shell_pid": 1, "foreground_processes": [{"pid": 1, "name": "zsh"}]},
        ):
            default = ORGANIZER.recovery_preflight_snapshot("lab", snapshot, layouts, set())
            acknowledgement = ORGANIZER.recovery_workspace_acknowledgements(["lab|w1"])
            acknowledged = ORGANIZER.recovery_preflight_snapshot("lab", snapshot, layouts, set(), acknowledgement)
        self.assertIn("mixed_workspace_cwd", {item["kind"] for item in default["failures"]})
        self.assertEqual(acknowledged["failures"], [])
        self.assertEqual(
            ORGANIZER.recovery_workspace_cwd(
                snapshot,
                snapshot["workspaces"][0],
                session="lab",
                acknowledgements=acknowledgement,
                layouts=layouts,
            ),
            first_cwd,
        )
        with patch.object(ORGANIZER, "recovery_layouts", return_value=layouts):
            native = ORGANIZER.native_recovery_workspace(
                snapshot, snapshot["workspaces"][0], "lab", acknowledgement
            )
        self.assertEqual(native["cwd"], first_cwd)
        with patch.object(ORGANIZER, "manifest_records", return_value=[]), patch.object(
            ORGANIZER, "agent_restore_records", return_value=[]
        ):
            capture = ORGANIZER.recovery_capture_from_snapshot("lab", snapshot, layouts, acknowledged)
        with patch.object(ORGANIZER, "session_snapshot", return_value=snapshot), patch.object(
            ORGANIZER, "recovery_layouts", return_value=layouts
        ):
            plan = ORGANIZER.plan_recovery_session(capture)
        self.assertEqual(plan["workspaces"][0]["action"], "adopt")
        details = ORGANIZER.preflight_failure_details([default])
        line = next(line.strip() for line in details.splitlines() if line.strip().startswith("--allow-mixed-cwd-workspace"))
        self.assertEqual(shlex.split(line), ["--allow-mixed-cwd-workspace", "lab|w1"])
        self.assertEqual(ORGANIZER.recovery_workspace_acknowledgements([shlex.split(line)[1]]), {"lab|w1"})
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "allow-mixed-cwd-workspace"):
            ORGANIZER.recovery_workspace_acknowledgements(["lab|w1|unsafe"])

    def test_mixed_cwd_acknowledgement_does_not_bypass_missing_pane_cwd(self):
        snapshot, layouts, _first_cwd = self.mixed_snapshot(missing_second_cwd=True)
        acknowledgement = ORGANIZER.recovery_workspace_acknowledgements(["lab|w1"])
        with patch.object(ORGANIZER, "manifest_records", return_value=[]), patch.object(
            ORGANIZER, "agent_restore_records", return_value=[]
        ), patch.object(
            ORGANIZER,
            "recovery_process_info",
            return_value={"shell_pid": 1, "foreground_processes": [{"pid": 1, "name": "zsh"}]},
        ):
            preflight = ORGANIZER.recovery_preflight_snapshot("lab", snapshot, layouts, set(), acknowledgement)
        self.assertIn("missing_pane_cwd", {item["kind"] for item in preflight["failures"]})

    def test_mixed_cwd_acknowledgement_and_rebuild_cwd_are_in_bundle_manifest(self):
        snapshot, layouts, first_cwd = self.mixed_snapshot()
        acknowledgement = ORGANIZER.recovery_workspace_acknowledgements(["lab|w1"])
        with patch.object(ORGANIZER, "manifest_records", return_value=[]), patch.object(
            ORGANIZER, "agent_restore_records", return_value=[]
        ), patch.object(
            ORGANIZER,
            "recovery_process_info",
            return_value={"shell_pid": 1, "foreground_processes": [{"pid": 1, "name": "zsh"}]},
        ):
            preflight = ORGANIZER.recovery_preflight_snapshot("lab", snapshot, layouts, set(), acknowledgement)
            capture = ORGANIZER.recovery_capture_from_snapshot("lab", snapshot, layouts, preflight)
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            ORGANIZER, "RECOVERY_BUNDLE_DIR", Path(temporary) / "bundles"
        ):
            bundle_id = ORGANIZER.write_recovery_bundle([capture])
            _path, manifest, _captures = ORGANIZER.load_recovery_bundle(bundle_id)
        self.assertEqual(
            manifest["mixed_cwd_acknowledgements"],
            [{"identity": ORGANIZER.recovery_identity("lab", "w1"), "rebuild_cwd": first_cwd}],
        )

    def test_acknowledged_mixed_cwd_rebuild_uses_first_layout_pane_and_reports_note(self):
        first_cwd = tempfile.gettempdir()
        source = self.source_workspace()
        source["cwd"] = first_cwd
        source["mixed_cwd_acknowledged"] = True
        source["fingerprint"] = ORGANIZER.recovery_workspace_fingerprint(source)
        capture = {
            "session": "lab",
            "workspaces": [source],
            "preflight": {"mixed_cwd_acknowledgements": ["lab|w1"]},
        }
        plans = [{"session": "lab", "workspaces": [{"source": source, "action": "rebuild"}]}]
        model = {"workspaces": [], "tabs": [], "panes": []}
        creates = []

        def snapshot(_session):
            return copy.deepcopy(model)

        def run_json(command, session):
            self.assertEqual(session, "lab")
            self.assertEqual(command[:2], ["workspace", "create"])
            creates.append(command)
            model["workspaces"] = [{"workspace_id": "new-w", "label": command[3], "cwd": command[-1], "focused": False}]
            model["tabs"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "label": "initial", "focused": False}]
            return {"result": {"workspace_id": "new-w", "tab_id": "new-w:t1"}}

        def socket_call(session, method, params):
            self.assertEqual(session, "lab")
            self.assertEqual(method, "layout.apply" if params.get("root") else "layout.export")
            if method == "layout.apply":
                model["tabs"][0].update({"label": params["tab_label"], "focused": bool(params["focus"])})
                model["panes"] = [{
                    "workspace_id": "new-w",
                    "tab_id": "new-w:t1",
                    "pane_id": "new-w:p1",
                    "cwd": first_cwd,
                    "foreground_cwd": first_cwd,
                }]
                return {"layout": {"tab_id": "new-w:t1", "root": {"type": "pane", "pane_id": "new-w:p1"}}}
            return {"layout": {"tab_id": "new-w:t1", "root": {"type": "pane", "pane_id": "new-w:p1"}}}

        with tempfile.TemporaryDirectory() as temporary, patch.object(
            ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"
        ), patch.object(ORGANIZER, "session_snapshot", side_effect=snapshot), patch.object(
            ORGANIZER, "run_json", side_effect=run_json
        ), patch.object(ORGANIZER, "socket_call", side_effect=socket_call):
            journal = ORGANIZER.execute_recovery_reconciliation(
                "recovery-20261002T000000Z-fffffffff0", [capture], plans, False
            )
        self.assertEqual(creates[0][-2:], ["--cwd", first_cwd])
        self.assertEqual(journal["status"], "completed")
        self.assertEqual(
            journal["sessions"]["lab"]["verification"]["notes"][0]["kind"],
            "mixed_cwd_panes_not_restored",
        )

    def test_preflight_rejects_unknown_trusted_agent_status(self):
        restore = {
            "source_pane_id": "w1:p1",
            "client": "codex",
            "session_id": "verified-id",
            "resume_command": "codex resume verified-id",
            "restore_status": "resumable",
            "restore_source": "manifest",
        }
        classified, failure = ORGANIZER.recovery_pane_classification(
            {
                "workspace_id": "w1",
                "tab_id": "w1:t1",
                "pane_id": "w1:p1",
                "agent": "codex",
                "agent_status": "unknown",
            },
            restore,
            "lab",
            set(),
        )
        self.assertEqual(classified["classification"], "agent_status_not_idle")
        self.assertEqual(failure["kind"], "agent_status_not_idle")
        self.assertTrue(classified["trusted_restore"])

    def test_preflight_failure_details_name_failures_without_private_data(self):
        blocker_identity = ORGANIZER.recovery_identity("project-a", "w1", "w1:t1", "w1:p1")
        unresolved_identity = ORGANIZER.recovery_identity("project-a", "w2", "w2:t1", "w2:p1")
        cwd_identity = ORGANIZER.recovery_identity("project-a", "w3", "w3:t1", "w3:p1")
        preflight = {
            "classifications": [
                {"identity": blocker_identity, "classification": "blocker", "agent_status": "unknown"},
                {
                    "identity": unresolved_identity,
                    "classification": "unverified_recovery_identity",
                    "agent": "codex",
                    "agent_status": "idle",
                    "trusted_restore": False,
                },
            ],
            "failures": [
                {"kind": "blocker", "identity": blocker_identity, "process": "/private/secret-command"},
                {
                    "kind": "unverified_recovery_identity",
                    "identity": unresolved_identity,
                    "resume_command": "codex resume secret-agent-session",
                },
                {"kind": "missing_pane_cwd", "identity": cwd_identity, "path": "/private/secret-cwd"},
            ],
            "snapshot": {
                "workspaces": [
                    {"workspace_id": "w1", "label": "Checkout", "cwd": tempfile.gettempdir()},
                    {"workspace_id": "w2", "label": "Release", "cwd": tempfile.gettempdir()},
                    {"workspace_id": "w3", "label": "Operations", "cwd": tempfile.gettempdir()},
                ],
                "tabs": [
                    {"workspace_id": "w1", "tab_id": "w1:t1", "label": "Deploy"},
                    {"workspace_id": "w2", "tab_id": "w2:t1", "label": "Monitor"},
                    {"workspace_id": "w3", "tab_id": "w3:t1", "label": "Shell"},
                ],
            },
        }
        details = ORGANIZER.preflight_failure_details([preflight])
        blocker = ORGANIZER.recovery_identity_key(blocker_identity)
        self.assertIn("blocker (1)", details)
        self.assertIn(blocker, details)
        self.assertIn(f"--allow-volatile-pane '{blocker}'", details)
        self.assertIn("workspace 'Checkout', tab 'Deploy'", details)
        self.assertIn("workspace 'Release', tab 'Monitor'", details)
        self.assertIn("reason=unverified_recovery_identity agent=codex status=idle trusted_restore=false", details)
        self.assertIn("Run herdr-agent-capture-history", details)
        self.assertNotIn("secret-command", details)
        self.assertNotIn("secret-agent-session", details)
        self.assertNotIn("secret-cwd", details)

    def test_preflight_details_distinguish_non_idle_agent_status(self):
        identity = ORGANIZER.recovery_identity("project-a", "w1", "w1:t1", "w1:p1")
        preflight = {
            "classifications": [
                {
                    "identity": identity,
                    "classification": "agent_status_not_idle",
                    "agent": "codex",
                    "agent_status": "working",
                    "trusted_restore": True,
                }
            ],
            "failures": [{"kind": "agent_status_not_idle", "identity": identity}],
        }
        details = ORGANIZER.preflight_failure_details([preflight])
        self.assertIn("The supported-agent status is not idle or done", details)
        self.assertIn("reason=agent_status_not_idle agent=codex status=working trusted_restore=true", details)

    def test_failed_preflight_prints_usable_blocker_acknowledgement(self):
        identity = ORGANIZER.recovery_identity("project's-a", "w1", "w1:t1", "w1:p1")
        preflight = {
            "session": "project-a",
            "classifications": [{"identity": identity, "classification": "blocker", "agent_status": "unknown"}],
            "failures": [{"kind": "blocker", "identity": identity}],
        }
        args = argparse.Namespace(recovery_sessions=["project-a"], allow_volatile_pane=[], preflight_only=True)
        output = io.StringIO()
        with patch.object(ORGANIZER, "recovery_sessions", return_value=["project-a"]), patch.object(
            ORGANIZER, "recovery_preflight_session", return_value=preflight
        ), redirect_stdout(output):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "preflight failed"):
                ORGANIZER.prepare_restart_recovery_command(args)
        acknowledgement = ORGANIZER.recovery_identity_key(identity)
        acknowledgement_line = next(
            line.strip() for line in output.getvalue().splitlines() if line.strip().startswith("--allow-volatile-pane")
        )
        self.assertEqual(shlex.split(acknowledgement_line), ["--allow-volatile-pane", acknowledgement])
        self.assertEqual(
            ORGANIZER.recovery_acknowledgements([shlex.split(acknowledgement_line)[1]]), {acknowledgement}
        )

    def test_preflight_console_summary_counts_priority_failure_kinds_and_redacts(self):
        identity = ORGANIZER.recovery_identity("project-a", "w1", "w1:t1", "w1:p1")
        preflight = {
            "failures": [
                {"kind": "busy_agent", "identity": identity},
                {"kind": "agent_status_not_idle", "identity": identity},
                {"kind": "blocker", "identity": identity, "resume_command": "codex resume secret"},
                {"kind": "mixed_workspace_cwd", "identity": identity, "path": "/private/secret"},
                {"kind": "unverified_recovery_identity", "identity": identity},
                {"kind": "missing_pane_cwd", "identity": identity},
            ]
        }
        summary = ORGANIZER.preflight_console_summary([preflight])
        self.assertLessEqual(len(summary.splitlines()), 8)
        self.assertIn("ready_to_seal no", summary)
        self.assertIn(
            "busy agents 2; blockers 1; mixed-cwd workspaces 1; unverified recovery identity 1; other 1",
            summary,
        )
        self.assertIn("let working or blocked agents finish", summary)
        self.assertIn("review the foreground process", summary)
        self.assertIn("resolve the mixed-CWD workspace", summary)
        self.assertNotIn("secret", summary)
        self.assertNotIn("/private", summary)

    def test_preflight_summary_only_prints_only_redacted_summary(self):
        identity = ORGANIZER.recovery_identity("project-a", "w1", "w1:t1", "w1:p1")
        preflight = {
            "session": "project-a",
            "classifications": [],
            "failures": [{"kind": "unverified_recovery_identity", "identity": identity, "resume_command": "codex resume secret"}],
            "snapshot": {},
        }
        args = argparse.Namespace(
            recovery_sessions=["project-a"], allow_volatile_pane=[],
            allow_mixed_cwd_workspace=[], preflight_only=True, summary_only=True,
        )
        output = io.StringIO()
        with patch.object(ORGANIZER, "recovery_sessions", return_value=["project-a"]), patch.object(
            ORGANIZER, "recovery_preflight_session", return_value=preflight
        ), redirect_stdout(output):
            with self.assertRaises(ORGANIZER.OrganizerError) as raised:
                ORGANIZER.prepare_restart_recovery_command(args)
        rendered = output.getvalue()
        self.assertTrue(rendered.startswith("Summary:\n"))
        self.assertTrue(raised.exception.suppress_message)
        self.assertNotIn("Preflight failures", rendered)
        self.assertNotIn("project-a|w1|w1:t1|w1:p1", rendered)
        self.assertNotIn("secret", rendered)
        self.assertNotIn("resume", rendered)

    def test_recovery_identity_rejects_pipe_delimited_components(self):
        for field in ("session", "workspace", "tab", "pane"):
            with self.subTest(field=field):
                values = {"session": "project-a", "workspace": "w1", "tab": "w1:t1", "pane": "w1:p1"}
                values[field] += "|unsafe"
                with self.assertRaisesRegex(ORGANIZER.OrganizerError, "cannot contain '\\|'"):
                    ORGANIZER.recovery_identity(values["session"], values["workspace"], values["tab"], values["pane"])
                if field == "session":
                    with self.assertRaisesRegex(ORGANIZER.OrganizerError, "cannot contain '\\|'"):
                        ORGANIZER.require_recovery_session(values["session"])

    def test_preflight_rejects_null_and_empty_workspace_and_pane_cwds(self):
        for location, value in (
            ("workspace", None),
            ("workspace", ""),
            ("pane", None),
            ("pane", ""),
        ):
            with self.subTest(location=location, value=value):
                snapshot = self.snapshot()
                if location == "workspace":
                    snapshot["workspaces"][0]["cwd"] = value
                    snapshot["panes"][0]["cwd"] = value
                    snapshot["panes"][0]["foreground_cwd"] = value
                else:
                    snapshot["panes"][0]["cwd"] = value
                    snapshot["panes"][0]["foreground_cwd"] = value
                with patch.object(ORGANIZER, "manifest_records", return_value=[]), patch.object(
                    ORGANIZER, "agent_restore_records", return_value=[]
                ), patch.object(
                    ORGANIZER, "recovery_process_info", return_value={"shell_pid": 1, "foreground_processes": [{"pid": 1, "name": "zsh"}]}
                ):
                    preflight = ORGANIZER.recovery_preflight_snapshot("lab", snapshot, {"w1:t1": self.layout()}, set())
                expected = "missing_workspace_cwd" if location == "workspace" else "missing_pane_cwd"
                self.assertIn(expected, {item["kind"] for item in preflight["failures"]})

    def test_preflight_rejects_session_without_a_focused_workspace(self):
        snapshot = self.snapshot(focused=False)
        with patch.object(ORGANIZER, "manifest_records", return_value=[]), patch.object(
            ORGANIZER, "agent_restore_records", return_value=[]
        ), patch.object(
            ORGANIZER, "recovery_process_info", return_value={"shell_pid": 1, "foreground_processes": [{"pid": 1, "name": "zsh"}]}
        ):
            preflight = ORGANIZER.recovery_preflight_snapshot("lab", snapshot, {"w1:t1": self.layout()}, set())
        self.assertIn("no_focused_workspace", {item["kind"] for item in preflight["failures"]})

    def test_preflight_rejects_session_with_multiple_focused_workspaces(self):
        snapshot = self.snapshot()
        snapshot["workspaces"].append(
            {"workspace_id": "w2", "label": "Two", "cwd": tempfile.gettempdir(), "focused": True}
        )
        with patch.object(ORGANIZER, "manifest_records", return_value=[]), patch.object(
            ORGANIZER, "agent_restore_records", return_value=[]
        ), patch.object(
            ORGANIZER, "recovery_process_info", return_value={"shell_pid": 1, "foreground_processes": [{"pid": 1, "name": "zsh"}]}
        ):
            preflight = ORGANIZER.recovery_preflight_snapshot("lab", snapshot, {"w1:t1": self.layout()}, set())
        self.assertIn("multiple_focused_workspaces", {item["kind"] for item in preflight["failures"]})

    def test_native_partial_restore_adopts_rebuilds_and_refuses_ambiguous(self):
        adopted = self.source_workspace("lab", "w1")
        missing = self.source_workspace("lab", "w2", label="Two")
        ambiguous = self.source_workspace("lab", "w3", label="Three")
        capture = {"session": "lab", "workspaces": [adopted, missing, ambiguous]}
        native_adopted = copy.deepcopy(adopted)
        native_adopted["identity"] = ORGANIZER.recovery_identity("lab", "w1")
        related = copy.deepcopy(ambiguous)
        related["identity"] = ORGANIZER.recovery_identity("lab", "new-w3")
        related["fingerprint"] = "different"
        with patch.object(ORGANIZER, "session_snapshot", return_value={}), patch.object(
            ORGANIZER, "native_recovery_workspaces", return_value=[native_adopted, related]
        ):
            plan = ORGANIZER.plan_recovery_session(capture)
        self.assertEqual([item["action"] for item in plan["workspaces"]], ["adopt", "rebuild", "ambiguous"])

    def test_native_agent_recovery_is_never_resumed_twice(self):
        restore = {"source_pane_id": "w1:p1", "client": "codex", "session_id": "safe-id", "resume_command": "codex resume safe-id", "restore_status": "resumable", "restore_source": "manifest"}
        source = self.source_workspace(agent_restore=restore)
        state = {"planned_action": "rebuild", "tabs": {ORGANIZER.source_tab_key(source["tabs"][0]): {"pane_map": {"w1:p1": "new:p1"}}}, "agent_outcomes": []}
        journal = {"sessions": {"lab": {"workspaces": {}}}}
        with patch.object(ORGANIZER, "session_snapshot", return_value={"panes": [{"pane_id": "new:p1", "agent": "codex", "agent_status": "working", "agent_session": {"value": "safe-id"}}]}), patch.object(
            ORGANIZER, "run_command"
        ) as run_command:
            ORGANIZER.dispatch_recovery_agents(Path(tempfile.gettempdir()) / "journal.json", journal, "lab", source, state, True)
        run_command.assert_not_called()
        self.assertEqual(state["agent_outcomes"][0]["status"], "native_recovered")

    def test_recovery_reruns_after_each_mutation_journal_stage_without_duplicates(self):
        source = self.source_workspace()
        capture = {"session": "lab", "workspaces": [source]}
        plans = [{"session": "lab", "workspaces": [{"source": source, "action": "rebuild"}]}]
        stages = ["workspace_create_intent", "workspace_created", "layout_apply_intent", "layout_created", "layouts_rebuilt", "session_verified", "reconciliation_completed"]
        for stage in stages:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as temporary, patch.object(
                ORGANIZER, "RECOVERY_BUNDLE_DIR", Path(temporary) / "bundles"
            ), patch.object(
                ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"
            ):
                bundle_id = ORGANIZER.write_recovery_bundle([capture])
                args = argparse.Namespace(bundle=bundle_id, confirm=bundle_id, copy_ambiguous=False, confirm_extra=None, resume_agents=False)
                model = {"workspaces": [], "tabs": [], "panes": []}
                creates = []
                def snapshot(_session):
                    return copy.deepcopy(model)
                def run_json(command, session):
                    self.assertEqual(session, "lab")
                    if command[:2] == ["workspace", "create"]:
                        creates.append(command)
                        model["workspaces"] = [{"workspace_id": "new-w", "label": command[3], "cwd": tempfile.gettempdir()}]
                        model["tabs"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "label": "One tab"}]
                        return {"result": {"workspace_id": "new-w", "tab_id": "new-w:t1"}}
                    raise AssertionError(command)
                def socket_call(session, method, params):
                    self.assertEqual(session, "lab")
                    if method == "layout.export":
                        return {"layout": {"tab_id": "new-w:t1", "root": {"type": "pane", "pane_id": "new-w:p1"}}}
                    self.assertEqual(method, "layout.apply")
                    model["tabs"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "label": params["tab_label"]}]
                    model["panes"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "pane_id": "new-w:p1", "cwd": tempfile.gettempdir(), "foreground_cwd": tempfile.gettempdir()}]
                    return {"layout": {"tab_id": "new-w:t1", "root": {"type": "pane", "pane_id": "new-w:p1"}}}
                tripped = {"value": False}
                def inject(current):
                    if current == stage and not tripped["value"]:
                        tripped["value"] = True
                        raise ORGANIZER.OrganizerError("injected")
                with patch.object(ORGANIZER, "session_snapshot", side_effect=snapshot), patch.object(
                    ORGANIZER, "run_json", side_effect=run_json
                ), patch.object(ORGANIZER, "socket_call", side_effect=socket_call), patch.object(
                    ORGANIZER, "recovery_failure_injection", side_effect=inject
                ), patch.object(
                    ORGANIZER, "plan_recovery_session", return_value=plans[0]
                ):
                    with self.assertRaisesRegex(ORGANIZER.OrganizerError, "injected"):
                        ORGANIZER.reconcile_all_command(args)
                with patch.object(ORGANIZER, "session_snapshot", side_effect=snapshot), patch.object(
                    ORGANIZER, "run_json", side_effect=run_json
                ), patch.object(ORGANIZER, "socket_call", side_effect=socket_call), patch.object(
                    ORGANIZER, "plan_recovery_session", side_effect=AssertionError("public rerun must resume journal")
                ):
                    ORGANIZER.reconcile_all_command(args)
                journal = ORGANIZER.validate_recovery_journal(ORGANIZER.recovery_journal_path(bundle_id), bundle_id, [capture])
                self.assertEqual(len(creates), 1)
                self.assertEqual(journal["status"], "completed")

    def test_rebuild_restores_non_last_source_workspace_focus(self):
        first = self.source_workspace("lab", "w1", label="First", focused=True)
        second = self.source_workspace("lab", "w2", label="Second", focused=False)
        capture = {"session": "lab", "workspaces": [first, second]}
        plans = [{"session": "lab", "workspaces": [{"source": first, "action": "rebuild"}, {"source": second, "action": "rebuild"}]}]
        model = {"workspaces": [], "tabs": [], "panes": []}
        calls = []

        def snapshot(_session):
            return copy.deepcopy(model)

        def run_json(command, session):
            self.assertEqual(session, "lab")
            calls.append(command)
            if command[:2] == ["workspace", "create"]:
                workspace_id = f"new-{len(model['workspaces']) + 1}"
                for workspace in model["workspaces"]:
                    workspace["focused"] = False
                model["workspaces"].append(
                    {"workspace_id": workspace_id, "label": command[3], "cwd": command[-1], "focused": True}
                )
                tab_id = f"{workspace_id}:t1"
                model["tabs"].append({"workspace_id": workspace_id, "tab_id": tab_id, "label": "initial", "focused": False})
                return {"result": {"workspace_id": workspace_id, "tab_id": tab_id}}
            if command[:2] == ["workspace", "focus"]:
                for workspace in model["workspaces"]:
                    workspace["focused"] = workspace["workspace_id"] == command[2]
                return {"result": {"workspace_id": command[2]}}
            raise AssertionError(command)

        def socket_call(session, method, params):
            self.assertEqual(session, "lab")
            if method == "layout.export":
                tab = next(tab for tab in model["tabs"] if tab["tab_id"] == params["tab_id"])
                return {"layout": {"tab_id": tab["tab_id"], "root": {"type": "pane", "pane_id": f"{tab['workspace_id']}:p1"}}}
            self.assertEqual(method, "layout.apply")
            tab_id = params.get("tab_id")
            if tab_id:
                tab = next(tab for tab in model["tabs"] if tab["tab_id"] == tab_id)
            else:
                tab = next(tab for tab in model["tabs"] if tab["workspace_id"] == params["workspace_id"])
            tab["label"] = params["tab_label"]
            tab["focused"] = bool(params["focus"])
            model["panes"] = [pane for pane in model["panes"] if pane["workspace_id"] != tab["workspace_id"]]
            model["panes"].append(
                {
                    "workspace_id": tab["workspace_id"],
                    "tab_id": tab["tab_id"],
                    "pane_id": f"{tab['workspace_id']}:p1",
                    "cwd": tempfile.gettempdir(),
                    "foreground_cwd": tempfile.gettempdir(),
                }
            )
            return {"layout": {"tab_id": tab["tab_id"], "root": {"type": "pane", "pane_id": f"{tab['workspace_id']}:p1"}}}

        with tempfile.TemporaryDirectory() as temporary, patch.object(
            ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"
        ), patch.object(ORGANIZER, "session_snapshot", side_effect=snapshot), patch.object(
            ORGANIZER, "run_json", side_effect=run_json
        ), patch.object(ORGANIZER, "socket_call", side_effect=socket_call):
            journal = ORGANIZER.execute_recovery_reconciliation(
                "recovery-20261002T000000Z-fffffffff0", [capture], plans, False
            )
        self.assertEqual(journal["status"], "completed")
        self.assertIn(["workspace", "focus", "new-1"], calls)
        self.assertEqual(
            [workspace["workspace_id"] for workspace in model["workspaces"] if workspace["focused"]], ["new-1"]
        )

    def test_implicit_recovery_scope_rejects_running_default(self):
        response = argparse.Namespace(
            returncode=0,
            stdout=json.dumps({"sessions": [
                {"name": "default", "default": True, "running": True},
                {"name": "lab", "default": False, "running": True},
            ]}),
            stderr="",
        )
        with patch.object(ORGANIZER.subprocess, "run", return_value=response):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "default Herdr session"):
                ORGANIZER.running_recovery_sessions()
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "default Herdr session"):
            ORGANIZER.recovery_sessions(argparse.Namespace(recovery_sessions=["default"]))

    def test_stable_capture_rechecks_process_classification_on_final_snapshot(self):
        snapshot = self.snapshot()
        preflight_shell = {"classifications": [{"identity": ORGANIZER.recovery_identity("lab", "w1", "w1:t1", "w1:p1"), "classification": "disposable_shell"}], "failures": []}
        preflight_blocker = {"classifications": [{"identity": ORGANIZER.recovery_identity("lab", "w1", "w1:t1", "w1:p1"), "classification": "blocker"}], "failures": [{"kind": "blocker"}]}
        with patch.object(ORGANIZER, "session_snapshot", side_effect=[snapshot, snapshot]), patch.object(
            ORGANIZER, "recovery_layouts", return_value={"w1:t1": self.layout()}
        ), patch.object(ORGANIZER, "recovery_preflight_snapshot", side_effect=[preflight_shell, preflight_blocker]):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "final quiesce preflight"):
                ORGANIZER.stable_recovery_capture("lab", set(), 1)

    def test_marked_workspace_response_loss_resumes_through_public_command(self):
        source = self.source_workspace()
        capture = {"session": "lab", "workspaces": [source]}
        plan = {"session": "lab", "workspaces": [{"source": source, "action": "rebuild"}]}
        model = {"workspaces": [], "tabs": [], "panes": []}
        def snapshot(_session):
            return copy.deepcopy(model)
        def first_run_json(command, _session):
            self.assertEqual(command[:2], ["workspace", "create"])
            model["workspaces"] = [{"workspace_id": "new-w", "label": command[3], "cwd": tempfile.gettempdir()}]
            model["tabs"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "label": "initial"}]
            raise ORGANIZER.OrganizerError("lost response")
        def socket_call(session, method, params):
            self.assertEqual(session, "lab")
            if method == "layout.export":
                return {"layout": {"tab_id": "new-w:t1", "root": {"type": "pane", "pane_id": "new-w:p1"}}}
            self.assertEqual(method, "layout.apply")
            model["tabs"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "label": params["tab_label"]}]
            model["panes"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "pane_id": "new-w:p1", "cwd": tempfile.gettempdir(), "foreground_cwd": tempfile.gettempdir()}]
            return {"layout": {"tab_id": "new-w:t1", "root": {"type": "pane", "pane_id": "new-w:p1"}}}
        with tempfile.TemporaryDirectory() as temporary, patch.object(ORGANIZER, "RECOVERY_BUNDLE_DIR", Path(temporary) / "bundles"), patch.object(
            ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"
        ):
            bundle_id = ORGANIZER.write_recovery_bundle([capture])
            args = argparse.Namespace(bundle=bundle_id, confirm=bundle_id, copy_ambiguous=False, confirm_extra=None, resume_agents=False)
            with patch.object(ORGANIZER, "plan_recovery_session", return_value=plan), patch.object(
                ORGANIZER, "session_snapshot", side_effect=snapshot
            ), patch.object(ORGANIZER, "run_json", side_effect=first_run_json):
                with self.assertRaisesRegex(ORGANIZER.OrganizerError, "lost response"):
                    ORGANIZER.reconcile_all_command(args)
            journal_path = ORGANIZER.recovery_journal_path(bundle_id)
            journal = ORGANIZER.validate_recovery_journal(journal_path, bundle_id, [capture])
            state = next(iter(journal["sessions"]["lab"]["workspaces"].values()))
            self.assertIn("rrb:", state["expected_label"])
            with patch.object(ORGANIZER, "plan_recovery_session", side_effect=AssertionError("must resume journal, not replan")), patch.object(
                ORGANIZER, "session_snapshot", side_effect=snapshot
            ), patch.object(ORGANIZER, "run_json", side_effect=AssertionError("workspace must not be created twice")), patch.object(
                ORGANIZER, "socket_call", side_effect=socket_call):
                ORGANIZER.reconcile_all_command(args)
            self.assertEqual(model["workspaces"][0]["label"], state["expected_label"])

    def test_marked_tab_response_loss_is_recovered_without_id_set_inference(self):
        source = self.source_workspace()
        capture = {"session": "lab", "workspaces": [source]}
        plan = [{"session": "lab", "workspaces": [{"source": source, "action": "rebuild"}]}]
        bundle_id = "recovery-20261002T000000Z-bbbbbbbbbb"
        journal = ORGANIZER.new_recovery_journal(bundle_id, plan)
        state = next(iter(journal["sessions"]["lab"]["workspaces"].values()))
        state.update({"workspace_create_intent": {}, "created_workspace_id": "new-w", "initial_tab_id": "new-w:t1"})
        model = {
            "workspaces": [{"workspace_id": "new-w", "label": state["expected_label"], "cwd": tempfile.gettempdir()}],
            "tabs": [{"workspace_id": "new-w", "tab_id": "new-w:t1", "label": "initial"}],
            "panes": [],
        }
        def snapshot(_session):
            return copy.deepcopy(model)
        lost = {"value": False}
        def socket_call(session, method, params):
            self.assertEqual(session, "lab")
            if method == "layout.export":
                return {"layout": {"tab_id": "new-w:t1", "root": {"type": "pane", "pane_id": "new-w:p1"}}}
            model["tabs"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "label": params["tab_label"]}]
            model["panes"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "pane_id": "new-w:p1", "cwd": tempfile.gettempdir(), "foreground_cwd": tempfile.gettempdir()}]
            if not lost["value"]:
                lost["value"] = True
                raise ORGANIZER.OrganizerError("lost tab response")
            return {"layout": {"tab_id": "new-w:t1", "root": {"type": "pane", "pane_id": "new-w:p1"}}}
        with tempfile.TemporaryDirectory() as temporary, patch.object(ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"):
            ORGANIZER.ensure_private_directory(ORGANIZER.RECOVERY_JOURNAL_DIR)
            journal_path = ORGANIZER.recovery_journal_path(bundle_id)
            ORGANIZER.write_recovery_journal(journal_path, journal)
            with patch.object(ORGANIZER, "session_snapshot", side_effect=snapshot), patch.object(ORGANIZER, "socket_call", side_effect=socket_call):
                with self.assertRaisesRegex(ORGANIZER.OrganizerError, "lost tab response"):
                    ORGANIZER.execute_recovery_reconciliation(bundle_id, [capture], plan, False)
                completed = ORGANIZER.execute_recovery_reconciliation(bundle_id, [capture], plan, False)
            self.assertEqual(completed["status"], "completed")
            self.assertEqual(len(model["tabs"]), 1)

    def test_marker_mismatch_is_never_claimed_or_rolled_back(self):
        source = self.source_workspace()
        bundle_id = "recovery-20261002T000000Z-cccccccccc"
        plan = [{"session": "lab", "workspaces": [{"source": source, "action": "rebuild"}]}]
        journal = ORGANIZER.new_recovery_journal(bundle_id, plan)
        state = next(iter(journal["sessions"]["lab"]["workspaces"].values()))
        state.update({"workspace_create_intent": {}, "created_workspace_id": "unrelated"})
        unrelated = {"workspaces": [{"workspace_id": "unrelated", "label": "One", "cwd": tempfile.gettempdir()}], "tabs": [], "panes": []}
        self.assertFalse(ORGANIZER.journal_recover_created_workspace("lab", state, unrelated))
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "operation marker"):
            ORGANIZER.verify_created_workspace(unrelated, state)

    def test_rollback_command_refuses_unverified_marker_before_close(self):
        source = self.source_workspace()
        capture = {"session": "lab", "workspaces": [source]}
        plan = [{"session": "lab", "workspaces": [{"source": source, "action": "rebuild"}]}]
        unrelated = {"workspaces": [{"workspace_id": "unrelated", "label": "One", "cwd": tempfile.gettempdir()}], "tabs": [], "panes": []}
        with tempfile.TemporaryDirectory() as temporary, patch.object(ORGANIZER, "RECOVERY_BUNDLE_DIR", Path(temporary) / "bundles"), patch.object(
            ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"
        ):
            bundle_id = ORGANIZER.write_recovery_bundle([capture])
            journal = ORGANIZER.new_recovery_journal(bundle_id, plan)
            state = next(iter(journal["sessions"]["lab"]["workspaces"].values()))
            state.update({"workspace_create_intent": {}, "created_workspace_id": "unrelated"})
            ORGANIZER.ensure_private_directory(ORGANIZER.RECOVERY_JOURNAL_DIR)
            ORGANIZER.write_recovery_journal(ORGANIZER.recovery_journal_path(bundle_id), journal)
            args = argparse.Namespace(bundle=bundle_id, confirm=bundle_id)
            with patch.object(ORGANIZER, "session_snapshot", return_value=unrelated), patch.object(ORGANIZER, "run_json") as run_json:
                with self.assertRaisesRegex(ORGANIZER.OrganizerError, "operation marker"):
                    ORGANIZER.rollback_reconcile_command(args)
            run_json.assert_not_called()

    def test_rollback_resumes_after_second_workspace_close_fails(self):
        first = self.source_workspace("lab", "w1", label="First")
        second = self.source_workspace("lab", "w2", label="Second")
        capture = {"session": "lab", "workspaces": [first, second]}
        plans = [{"session": "lab", "workspaces": [{"source": first, "action": "rebuild"}, {"source": second, "action": "rebuild"}]}]
        model = {"workspaces": [], "tabs": [], "panes": []}

        def snapshot(_session):
            return copy.deepcopy(model)

        def socket_call(session, method, params):
            self.assertEqual(session, "lab")
            self.assertEqual(method, "layout.export")
            tab = next(tab for tab in model["tabs"] if tab["tab_id"] == params["tab_id"])
            return {"layout": {"tab_id": tab["tab_id"], "root": {"type": "pane", "pane_id": f"{tab['workspace_id']}:p1"}}}

        failed = {"value": False}

        def first_run_json(command, session):
            self.assertEqual(session, "lab")
            self.assertEqual(command[:2], ["workspace", "close"])
            workspace_id = command[2]
            if workspace_id == "new-w2" and not failed["value"]:
                failed["value"] = True
                raise ORGANIZER.OrganizerError("second close failed")
            model["workspaces"] = [item for item in model["workspaces"] if item["workspace_id"] != workspace_id]
            model["tabs"] = [item for item in model["tabs"] if item["workspace_id"] != workspace_id]
            model["panes"] = [item for item in model["panes"] if item["workspace_id"] != workspace_id]
            return {"result": {"workspace_id": workspace_id}}

        retried = []

        def retry_run_json(command, session):
            self.assertEqual(session, "lab")
            self.assertEqual(command[:2], ["workspace", "close"])
            retried.append(command[2])
            workspace_id = command[2]
            model["workspaces"] = [item for item in model["workspaces"] if item["workspace_id"] != workspace_id]
            model["tabs"] = [item for item in model["tabs"] if item["workspace_id"] != workspace_id]
            model["panes"] = [item for item in model["panes"] if item["workspace_id"] != workspace_id]
            return {"result": {"workspace_id": workspace_id}}

        with tempfile.TemporaryDirectory() as temporary, patch.object(
            ORGANIZER, "RECOVERY_BUNDLE_DIR", Path(temporary) / "bundles"
        ), patch.object(ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"):
            bundle_id = ORGANIZER.write_recovery_bundle([capture])
            journal = ORGANIZER.new_recovery_journal(bundle_id, plans)
            states = journal["sessions"]["lab"]["workspaces"]
            for source, workspace_id in ((first, "new-w1"), (second, "new-w2")):
                state = states[ORGANIZER.recovery_workspace_plan_key(source)]
                tab = source["tabs"][0]
                state.update({"created_workspace_id": workspace_id, "initial_tab_id": f"{workspace_id}:t1"})
                state["tabs"][ORGANIZER.source_tab_key(tab)]["destination_tab_id"] = f"{workspace_id}:t1"
                model["workspaces"].append(
                    {"workspace_id": workspace_id, "label": state["expected_label"], "cwd": tempfile.gettempdir()}
                )
                model["tabs"].append(
                    {"workspace_id": workspace_id, "tab_id": f"{workspace_id}:t1", "label": state["tabs"][ORGANIZER.source_tab_key(tab)]["expected_label"]}
                )
                model["panes"].append(
                    {"workspace_id": workspace_id, "tab_id": f"{workspace_id}:t1", "pane_id": f"{workspace_id}:p1"}
                )
            ORGANIZER.ensure_private_directory(ORGANIZER.RECOVERY_JOURNAL_DIR)
            ORGANIZER.write_recovery_journal(ORGANIZER.recovery_journal_path(bundle_id), journal)
            args = argparse.Namespace(bundle=bundle_id, confirm=bundle_id)
            with patch.object(ORGANIZER, "session_snapshot", side_effect=snapshot), patch.object(
                ORGANIZER, "socket_call", side_effect=socket_call
            ), patch.object(ORGANIZER, "run_json", side_effect=first_run_json):
                with self.assertRaisesRegex(ORGANIZER.OrganizerError, "second close failed"):
                    ORGANIZER.rollback_reconcile_command(args)
            interrupted = ORGANIZER.validate_recovery_journal(ORGANIZER.recovery_journal_path(bundle_id), bundle_id, [capture])
            interrupted_states = interrupted["sessions"]["lab"]["workspaces"]
            self.assertEqual(interrupted_states[ORGANIZER.recovery_workspace_plan_key(first)]["rollback"]["status"], "closed")
            self.assertEqual(interrupted_states[ORGANIZER.recovery_workspace_plan_key(second)]["rollback"]["status"], "close_intent")
            with patch.object(ORGANIZER, "session_snapshot", side_effect=snapshot), patch.object(
                ORGANIZER, "socket_call", side_effect=socket_call
            ), patch.object(ORGANIZER, "run_json", side_effect=retry_run_json):
                ORGANIZER.rollback_reconcile_command(args)
            completed = ORGANIZER.validate_recovery_journal(ORGANIZER.recovery_journal_path(bundle_id), bundle_id, [capture])
        self.assertEqual(retried, ["new-w2"])
        self.assertEqual(completed["status"], "rolled_back")

    def test_rollback_close_intent_refuses_a_live_workspace_with_changed_marker(self):
        for changed_field, changed_value in (("label", "Renamed"), ("cwd", "/changed/worktree")):
            with self.subTest(changed_field=changed_field):
                source = self.source_workspace()
                capture = {"session": "lab", "workspaces": [source]}
                plans = [{"session": "lab", "workspaces": [{"source": source, "action": "rebuild"}]}]
                with tempfile.TemporaryDirectory() as temporary, patch.object(
                    ORGANIZER, "RECOVERY_BUNDLE_DIR", Path(temporary) / "bundles"
                ), patch.object(ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"):
                    bundle_id = ORGANIZER.write_recovery_bundle([capture])
                    journal = ORGANIZER.new_recovery_journal(bundle_id, plans)
                    state = next(iter(journal["sessions"]["lab"]["workspaces"].values()))
                    state.update(
                        {
                            "created_workspace_id": "new-w",
                            "initial_tab_id": "new-w:t1",
                            "rollback": {"status": "close_intent", "workspace_id": "new-w", "started_at": "now"},
                        }
                    )
                    live_workspace = {
                        "workspace_id": "new-w",
                        "label": state["expected_label"],
                        "cwd": state["expected_cwd"],
                    }
                    live_workspace[changed_field] = changed_value
                    ORGANIZER.ensure_private_directory(ORGANIZER.RECOVERY_JOURNAL_DIR)
                    journal_path = ORGANIZER.recovery_journal_path(bundle_id)
                    ORGANIZER.write_recovery_journal(journal_path, journal)
                    args = argparse.Namespace(bundle=bundle_id, confirm=bundle_id)
                    with patch.object(
                        ORGANIZER, "session_snapshot", return_value={"workspaces": [live_workspace], "tabs": [], "panes": []}
                    ), patch.object(ORGANIZER, "run_json") as run_json:
                        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "close-intent recovery workspace still exists"):
                            ORGANIZER.rollback_reconcile_command(args)
                    run_json.assert_not_called()
                    saved = ORGANIZER.validate_recovery_journal(journal_path, bundle_id, [capture])
                saved_state = next(iter(saved["sessions"]["lab"]["workspaces"].values()))
                self.assertEqual(saved["status"], "prepared")
                self.assertEqual(saved_state["rollback"]["status"], "close_intent")

    def test_rollback_post_close_confirmation_requires_created_workspace_id_absent(self):
        for changed_field, changed_value in (("label", "Renamed"), ("cwd", "/changed/worktree")):
            with self.subTest(changed_field=changed_field):
                source = self.source_workspace()
                capture = {"session": "lab", "workspaces": [source]}
                plans = [{"session": "lab", "workspaces": [{"source": source, "action": "rebuild"}]}]
                model = {"workspaces": [], "tabs": [], "panes": []}

                def snapshot(_session):
                    return copy.deepcopy(model)

                def socket_call(session, method, params):
                    self.assertEqual(session, "lab")
                    self.assertEqual(method, "layout.export")
                    return {
                        "layout": {
                            "tab_id": params["tab_id"],
                            "root": {"type": "pane", "pane_id": "new-w:p1"},
                        }
                    }

                close_calls = []

                def run_json(command, session):
                    self.assertEqual(session, "lab")
                    self.assertEqual(command, ["workspace", "close", "new-w"])
                    close_calls.append(command)
                    model["workspaces"][0][changed_field] = changed_value
                    return {"result": {"workspace_id": "new-w"}}

                with tempfile.TemporaryDirectory() as temporary, patch.object(
                    ORGANIZER, "RECOVERY_BUNDLE_DIR", Path(temporary) / "bundles"
                ), patch.object(ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"):
                    bundle_id = ORGANIZER.write_recovery_bundle([capture])
                    journal = ORGANIZER.new_recovery_journal(bundle_id, plans)
                    state = next(iter(journal["sessions"]["lab"]["workspaces"].values()))
                    source_tab = source["tabs"][0]
                    tab_state = state["tabs"][ORGANIZER.source_tab_key(source_tab)]
                    state.update({"created_workspace_id": "new-w", "initial_tab_id": "new-w:t1"})
                    tab_state["destination_tab_id"] = "new-w:t1"
                    model["workspaces"] = [
                        {"workspace_id": "new-w", "label": state["expected_label"], "cwd": state["expected_cwd"]}
                    ]
                    model["tabs"] = [
                        {"workspace_id": "new-w", "tab_id": "new-w:t1", "label": tab_state["expected_label"]}
                    ]
                    ORGANIZER.ensure_private_directory(ORGANIZER.RECOVERY_JOURNAL_DIR)
                    journal_path = ORGANIZER.recovery_journal_path(bundle_id)
                    ORGANIZER.write_recovery_journal(journal_path, journal)
                    args = argparse.Namespace(bundle=bundle_id, confirm=bundle_id)
                    with patch.object(ORGANIZER, "session_snapshot", side_effect=snapshot), patch.object(
                        ORGANIZER, "socket_call", side_effect=socket_call
                    ), patch.object(ORGANIZER, "run_json", side_effect=run_json):
                        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "did not close the recovery workspace ID"):
                            ORGANIZER.rollback_reconcile_command(args)
                    saved = ORGANIZER.validate_recovery_journal(journal_path, bundle_id, [capture])
                saved_state = next(iter(saved["sessions"]["lab"]["workspaces"].values()))
                self.assertEqual(close_calls, [["workspace", "close", "new-w"]])
                self.assertEqual(saved["status"], "prepared")
                self.assertEqual(saved_state["rollback"]["status"], "close_intent")

    def test_verification_reexports_layout_and_checks_focus_and_duplicates(self):
        source = self.source_workspace()
        capture = {"session": "lab", "workspaces": [source]}
        plan = [{"session": "lab", "workspaces": [{"source": source, "action": "adopt", "native_workspace_id": "native-w"}]}]
        journal = ORGANIZER.new_recovery_journal("recovery-20261002T000000Z-dddddddddd", plan)
        target = {
            "identity": ORGANIZER.recovery_identity("lab", "native-w"), "label": "One", "cwd": tempfile.gettempdir(), "focused": True,
            "tabs": [{"identity": ORGANIZER.recovery_identity("lab", "native-w", "native-w:t1"), "label": "One tab", "index": 0, "focused": True, "layout_shape_fingerprint": "wrong", "panes": []}],
        }
        with patch.object(ORGANIZER, "session_snapshot", return_value={"workspaces": [], "tabs": [], "panes": []}), patch.object(
            ORGANIZER, "native_recovery_workspaces", return_value=[target]
        ):
            verification = ORGANIZER.verify_recovery_session("lab", capture, journal)
        self.assertTrue({"layout_shape_mismatch", "workspace_focus_mismatch", "tab_focus_mismatch"}.issubset(verification["failures"]))

    def test_private_journal_and_lock_are_required_before_mutation(self):
        bundle_id = "recovery-20261002T000000Z-eeeeeeeeee"
        capture = {"session": "lab", "workspaces": []}
        with tempfile.TemporaryDirectory() as temporary, patch.object(ORGANIZER, "RECOVERY_JOURNAL_DIR", Path(temporary) / "journals"):
            ORGANIZER.ensure_private_directory(ORGANIZER.RECOVERY_JOURNAL_DIR)
            path = ORGANIZER.recovery_journal_path(bundle_id)
            ORGANIZER.write_recovery_journal(path, ORGANIZER.new_recovery_journal(bundle_id, [{"session": "lab", "workspaces": []}]))
            path.chmod(0o644)
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "permissions"):
                ORGANIZER.load_existing_recovery_journal(bundle_id, [capture])
            path.chmod(0o600)
            def lock_error(_descriptor, operation):
                if operation & ORGANIZER.fcntl.LOCK_NB:
                    raise BlockingIOError
            with patch.object(ORGANIZER.fcntl, "flock", side_effect=lock_error):
                with self.assertRaisesRegex(ORGANIZER.OrganizerError, "already running"):
                    with ORGANIZER.recovery_bundle_lock(bundle_id):
                        pass


RESUMABLE = {"restore_status": "resumable", "restore_source": "manifest", "client": "codex"}
UNVERIFIED = {"restore_status": "shell_only", "restore_source": "unavailable", "client": "codex"}


class FakeHerdr:
    """A live session that archive-all can close workspaces in, with nothing real behind it."""

    def __init__(self, workspaces, restores=None, working=(), close_fails=()):
        self.workspaces = [{"workspace_id": wid, "label": label} for wid, label in workspaces]
        self.restores = restores or {}
        self.working = set(working)
        self.close_fails = set(close_fails)
        self.closed = []

    def snapshot(self, _session=None):
        tabs = [{"workspace_id": w["workspace_id"], "tab_id": f"{w['workspace_id']}:t1"} for w in self.workspaces]
        panes = [
            {
                "tab_id": f"{w['workspace_id']}:t1",
                "pane_id": f"{w['workspace_id']}:p1",
                "agent_status": "working" if w["workspace_id"] in self.working else "idle",
            }
            for w in self.workspaces
        ]
        return {"workspaces": [dict(w) for w in self.workspaces], "tabs": tabs, "panes": panes}

    def capture(self, snapshot, workspace_id, _session):
        workspace = ORGANIZER.workspace_by_id(snapshot, workspace_id)
        return {
            "workspace": {"source_workspace_id": workspace_id, "label": workspace["label"], "focused": False},
            "tabs": [
                {
                    "source_tab_id": f"{workspace_id}:t1",
                    "label": "main",
                    "layout": {"root": {"type": "pane", "pane_id": f"{workspace_id}:p1"}},
                    "agent_restores": [dict(item, source_pane_id=f"{workspace_id}:p1") for item in self.restores.get(workspace_id, [])],
                }
            ],
        }

    def run_json(self, arguments, _session):
        if arguments[:2] == ["workspace", "close"]:
            if arguments[2] in self.close_fails:
                raise ORGANIZER.OrganizerError("close refused")
            self.closed.append(arguments[2])
            self.workspaces = [w for w in self.workspaces if w["workspace_id"] != arguments[2]]
        return {}


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.archives = root / "archives"
        self.batches = root / "batches"
        for target, value in (("ARCHIVE_DIR", self.archives), ("BATCH_DIR", self.batches)):
            patcher = patch.object(ORGANIZER, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {}, clear=False)
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("HERDR_SESSION", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID"):
            os.environ.pop(name, None)

    def attach(self, herdr):
        for name, value in (
            ("session_snapshot", herdr.snapshot),
            ("capture_workspace", herdr.capture),
            ("run_json", herdr.run_json),
        ):
            patcher = patch.object(ORGANIZER, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def archive_args(self, **overrides):
        values = dict(session="esim", execute=True, confirm="esim")
        values.update(overrides)
        return argparse.Namespace(**values)

    def run_quietly(self, function, args):
        output = io.StringIO()
        with redirect_stdout(output):
            function(args)
        return output.getvalue()

    def world(self, **overrides):
        base = dict(
            workspaces=[("w1", "Clean"), ("w2", "Agent ok"), ("w3", "Busy"), ("w4", "Unverified")],
            restores={"w2": [RESUMABLE], "w4": [UNVERIFIED]},
            working={"w3"},
        )
        base.update(overrides)
        herdr = FakeHerdr(**base)
        self.attach(herdr)
        return herdr

    def manifests(self):
        return [json.loads(path.read_text()) for path in sorted(self.batches.glob("*.json"))]

    def test_preview_sorts_workspaces_and_changes_nothing(self):
        herdr = self.world()
        output = self.run_quietly(ORGANIZER.archive_all_command, self.archive_args(execute=False, confirm=None))
        preview = json.loads(output[: output.rindex("}") + 1])
        self.assertEqual([item["workspace_id"] for item in preview["to_archive"]], ["w1", "w2"])
        skipped = {item["workspace_id"]: item for item in preview["skipped"]}
        self.assertEqual(skipped["w3"]["reasons"], ["active_agent"])
        self.assertEqual(skipped["w3"]["active_pane_ids"], ["w3:p1"])
        self.assertEqual(skipped["w4"]["reasons"], ["unverified_agent_session"])
        self.assertEqual(skipped["w4"]["unverified_panes"], [{"pane_id": "w4:p1", "client": "codex"}])
        self.assertIn("Preview only", output)
        self.assertEqual(herdr.closed, [])
        self.assertFalse(self.batches.exists() or self.archives.exists())

    def test_execute_stamps_one_batch_on_every_archive_and_skips_the_rest(self):
        herdr = self.world()
        self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        self.assertEqual(herdr.closed, ["w1", "w2"])
        (manifest,) = self.manifests()
        self.assertRegex(manifest["batch_id"], ORGANIZER.BATCH_ID_PATTERN)
        self.assertEqual(manifest["status"], "completed")
        self.assertEqual([m["workspace_id"] for m in manifest["members"]], ["w1", "w2"])
        self.assertEqual({item["workspace_id"] for item in manifest["skipped"]}, {"w3", "w4"})
        for member in manifest["members"]:
            archive = json.loads((self.archives / f"{member['archive_id']}.json").read_text())
            self.assertEqual(archive["batch_id"], manifest["batch_id"])
            self.assertEqual(archive["status"], "archived")
        text = json.dumps(manifest)
        self.assertNotIn("session_id", text)
        self.assertNotIn("resume_command", text)

    def test_a_second_run_adds_the_leftovers_to_the_same_group(self):
        herdr = self.world()
        self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        (first,) = self.manifests()
        herdr.working.clear()
        herdr.restores["w4"] = [RESUMABLE]
        with patch.object(ORGANIZER, "batch_id_for", return_value="batch-20990101-000000"):
            self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        (group,) = self.manifests()
        self.assertEqual(group["batch_id"], first["batch_id"], "the session keeps its one group")
        self.assertEqual(group["created_at"], first["created_at"])
        self.assertEqual([m["workspace_id"] for m in group["members"]], ["w1", "w2", "w3", "w4"])
        self.assertEqual(group["skipped"], [], "the skipped list is the one of the latest run")
        for member in group["members"]:
            self.assertEqual(json.loads((self.archives / f"{member['archive_id']}.json").read_text())["batch_id"], group["batch_id"])

    def test_each_session_has_its_own_group(self):
        self.world(workspaces=[("w1", "Clean")], restores={}, working=())
        self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        self.world(workspaces=[("w1", "Other clean")], restores={}, working=())
        with patch.object(ORGANIZER, "batch_id_for", return_value="batch-20990101-000000"):
            self.run_quietly(ORGANIZER.archive_all_command, self.archive_args(session="other", confirm="other"))
        groups = sorted(self.manifests(), key=lambda m: m["herdr_session"])
        self.assertEqual([(g["herdr_session"], len(g["members"])) for g in groups], [("esim", 1), ("other", 1)])
        self.assertNotEqual(groups[0]["batch_id"], groups[1]["batch_id"])

    def test_a_workspace_archived_again_after_a_restore_is_one_new_entry(self):
        herdr = self.world(workspaces=[("w1", "Clean")], restores={}, working=())
        self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        (group,) = self.manifests()
        first = group["members"][0]["archive_id"]
        # The restore marks the archive restored. The workspace it made is then archived again.
        archive = json.loads((self.archives / f"{first}.json").read_text())
        archive.update(status="restored", restore={"workspace_id": "w1"})
        (self.archives / f"{first}.json").write_text(json.dumps(archive))
        herdr = self.world(workspaces=[("w1", "Clean")], restores={}, working=())
        with patch.object(ORGANIZER, "archive_id_for", return_value="20990101-000000-clean"):
            self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        (group,) = self.manifests()
        self.assertEqual([m["archive_id"] for m in group["members"]], ["20990101-000000-clean"], "the restored one left the group")
        self.assertTrue((self.archives / f"{first}.json").exists(), "its archive file stays as a single archive")
        self.assertEqual(herdr.closed, ["w1"])

    def layout_copy_member(self, status="archived", **archive_extra):
        """A group member whose layout-only restore left workspace w1 open."""
        archive_id = "20261007-101500-01-ws1"
        archive = {
            "archive_id": archive_id,
            "status": status,
            "batch_id": "batch-20261007-101500",
            "capture": {"workspace": {"source_workspace_id": "w77", "label": "Clean"}, "tabs": []},
            "layout_restore": {"workspace_id": "w1", "tabs": []},
        }
        archive.update(archive_extra)
        ORGANIZER.write_json(ORGANIZER.ARCHIVE_DIR / f"{archive_id}.json", archive)
        ORGANIZER.write_json(
            ORGANIZER.BATCH_DIR / "batch-20261007-101500.json",
            {
                "version": 1, "batch_id": "batch-20261007-101500", "status": "completed", "created_at": "2026-10-07T10:15:00+00:00",
                "herdr_session": "esim", "skipped": [],
                "members": [{"archive_id": archive_id, "workspace_id": "w77", "workspace_label": "Clean"}],
            },
        )
        return archive_id

    def test_archiving_a_workspace_that_is_a_members_layout_copy_replaces_that_member(self):
        old = self.layout_copy_member()
        herdr = self.world(workspaces=[("w1", "Clean"), ("w2", "Two")], restores={}, working=())
        with patch.object(ORGANIZER, "archive_id_for", side_effect=["20990101-000000-clean", "20990101-000000-two"]):
            output = self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        (group,) = self.manifests()
        self.assertEqual([m["archive_id"] for m in group["members"]], ["20990101-000000-clean", "20990101-000000-two"])
        left = json.loads((self.archives / f"{old}.json").read_text())
        self.assertEqual(left["left_group"]["by"], "20990101-000000-clean")
        self.assertEqual(left["status"], "archived", "its archive is kept as a single archive")
        self.assertIn(f"replaces {old}", output)
        self.assertEqual(herdr.closed, ["w1", "w2"])

    def test_a_matching_original_workspace_id_alone_never_replaces_a_member(self):
        old = self.layout_copy_member()
        archive = json.loads((self.archives / f"{old}.json").read_text())
        archive.pop("layout_restore")
        archive["capture"]["workspace"]["source_workspace_id"] = "w1"
        (self.archives / f"{old}.json").write_text(json.dumps(archive))
        self.world(workspaces=[("w1", "Clean")], restores={}, working=())
        self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        (group,) = self.manifests()
        self.assertEqual(len(group["members"]), 2, "ids get reused, so only a workspace a restore built counts")
        self.assertNotIn("left_group", json.loads((self.archives / f"{old}.json").read_text()))

    def test_two_layout_copies_of_one_workspace_skip_it_instead_of_guessing(self):
        first = self.layout_copy_member()
        second = "20261007-101500-02-ws2"
        archive = json.loads((self.archives / f"{first}.json").read_text())
        archive["archive_id"] = second
        ORGANIZER.write_json(ORGANIZER.ARCHIVE_DIR / f"{second}.json", archive)
        manifest = json.loads((self.batches / "batch-20261007-101500.json").read_text())
        manifest["members"].append({"archive_id": second, "workspace_id": "w78", "workspace_label": "Clean 2"})
        ORGANIZER.write_json(self.batches / "batch-20261007-101500.json", manifest)
        herdr = self.world(workspaces=[("w1", "Clean")], restores={}, working=())
        self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        (group,) = self.manifests()
        self.assertEqual(herdr.closed, [])
        self.assertEqual([item["reasons"] for item in group["skipped"]], [["group_member_conflict"]])
        self.assertEqual(len(group["members"]), 2)

    def test_the_groups_listing_holds_only_workspaces_that_are_still_archived(self):
        self.make_batch(["archived", "restored", "resumed", "restore_partial", "deleted", "close_failed"])
        (group,) = ORGANIZER.load_batches()
        self.assertEqual([m["archive_id"][-3:] for m in group["members"]], ["ws1", "ws4", "ws6"])
        summary = ORGANIZER.batch_summary(group)
        self.assertEqual(summary["counts"], {"archived": 1, "restored": 0, "restore_partial": 1, "deleted": 0, "other": 1, "skipped": 1})
        self.assertEqual(len(json.loads((self.batches / "batch-20261007-101500.json").read_text())["members"]), 6, "listing writes nothing")

    def test_a_restore_takes_the_member_out_of_its_group_and_keeps_its_archive(self):
        self.make_batch(["archived", "archived"])
        first = "20261007-101500-01-ws1"

        def restore(args):
            path = ORGANIZER.ARCHIVE_DIR / f"{args.archive}.json"
            archive = json.loads(path.read_text())
            archive["status"] = "resumed"
            path.write_text(json.dumps(archive))
            return "created"

        args = argparse.Namespace(archive=first, execute=True, confirm=first, force=False, resume_agents=True, allow_unresumable_agents=False, session="esim")
        with patch.object(ORGANIZER, "restore_archive", side_effect=restore):
            self.assertEqual(ORGANIZER.restore_command(args), "created")
        (group,) = self.manifests()
        self.assertEqual([m["archive_id"] for m in group["members"]], ["20261007-101500-02-ws2"])
        self.assertTrue((self.archives / f"{first}.json").exists())

    def test_a_restore_that_stops_part_way_leaves_the_member_in_the_group_flagged(self):
        self.make_batch(["archived"])
        first = "20261007-101500-01-ws1"

        def restore(args):
            path = ORGANIZER.ARCHIVE_DIR / f"{args.archive}.json"
            path.write_text(json.dumps({"archive_id": args.archive, "status": "restore_partial", "batch_id": "batch-20261007-101500"}))
            raise ORGANIZER.OrganizerError("stopped")

        args = argparse.Namespace(archive=first, execute=True, confirm=first, force=False, resume_agents=True, allow_unresumable_agents=False, session="esim")
        with patch.object(ORGANIZER, "restore_archive", side_effect=restore), self.assertRaises(ORGANIZER.OrganizerError):
            ORGANIZER.restore_command(args)
        (group,) = self.manifests()
        self.assertEqual(len(group["members"]), 1)

    def test_a_layout_only_restore_keeps_the_member_in_the_group(self):
        self.make_batch(["archived"])
        first = "20261007-101500-01-ws1"
        args = argparse.Namespace(archive=first, execute=True, confirm=first, force=False, resume_agents=False, allow_unresumable_agents=False, session="esim")
        with patch.object(ORGANIZER, "restore_archive", return_value="laid_out"):
            ORGANIZER.restore_command(args)
        (group,) = self.manifests()
        self.assertEqual(len(group["members"]), 1)

    def test_deleting_an_archive_takes_it_out_of_its_group(self):
        self.make_batch(["archived", "archived"])
        first = "20261007-101500-01-ws1"
        self.run_quietly(ORGANIZER.delete_archive_command, argparse.Namespace(archive=first, execute=True, confirm=first))
        (group,) = self.manifests()
        self.assertEqual([m["archive_id"] for m in group["members"]], ["20261007-101500-02-ws2"])

    def old_style_groups(self):
        """Two groups of one session, as separate Archive all runs used to leave them, one member in both."""
        self.make_batch(["archived", "archived"])
        later = self.make_batch(["archived"], batch_id="batch-20261008-090000")
        later["created_at"] = "2026-10-08T09:00:00+00:00"
        later["skipped"] = [{"workspace_id": "w60", "label": "Later skip", "reasons": ["capture_failed"]}]
        later["members"].append({"archive_id": "20261007-101500-02-ws2", "workspace_id": "w2", "workspace_label": "Ws 2"})
        ORGANIZER.write_json(self.batches / "batch-20261008-090000.json", later)
        self.make_batch(["archived"], batch_id="batch-20261009-090000", session="other")

    def test_older_groups_of_one_session_show_as_one_group_without_writing(self):
        self.old_style_groups()
        groups = {g["herdr_session"]: g for g in ORGANIZER.load_batches()}
        self.assertEqual(sorted(groups), ["esim", "other"])
        esim = groups["esim"]
        self.assertEqual(esim["batch_id"], "batch-20261007-101500", "the oldest group is the one that stays")
        self.assertEqual(sorted(m["archive_id"] for m in esim["members"]), ["20261007-101500-01-ws1", "20261007-101500-02-ws2", "20261008-090000-01-ws1"])
        self.assertEqual([item["workspace_id"] for item in esim["skipped"]], ["w60"])
        self.assertEqual(len(list(self.batches.glob("*.json"))), 3, "a read changes no file")
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "now part of the one archive group.*batch-20261007-101500"):
            ORGANIZER.batch_by_id("batch-20261008-090000")

    def test_settling_merges_older_groups_on_disk_once(self):
        self.old_style_groups()
        ORGANIZER.settle_groups()
        files = sorted(path.stem for path in self.batches.glob("*.json"))
        self.assertEqual(files, ["batch-20261007-101500", "batch-20261009-090000"])
        group = json.loads((self.batches / "batch-20261007-101500.json").read_text())
        self.assertNotIn("merged_from", group)
        self.assertEqual(len(group["members"]), 3)
        for member in group["members"]:
            self.assertEqual(json.loads((self.archives / f"{member['archive_id']}.json").read_text())["batch_id"], "batch-20261007-101500")
        before = {path.name: path.read_text() for path in self.batches.glob("*.json")}
        ORGANIZER.settle_groups()
        self.assertEqual({path.name: path.read_text() for path in self.batches.glob("*.json")}, before, "a second settle changes nothing")

    def test_settling_takes_restored_members_out_and_the_delete_still_finds_every_archive(self):
        self.old_style_groups()
        path = ORGANIZER.ARCHIVE_DIR / "20261008-090000-01-ws1.json"
        archive = json.loads(path.read_text())
        archive["status"] = "restored"
        path.write_text(json.dumps(archive))
        ORGANIZER.settle_groups()
        group = json.loads((self.batches / "batch-20261007-101500.json").read_text())
        self.assertEqual(len(group["members"]), 2)
        output = self.run_quietly(
            ORGANIZER.delete_batch_command,
            argparse.Namespace(batch="batch-20261007-101500", execute=False, confirm=None, archives=True),
        )
        self.assertEqual(len(json.loads(output[: output.rindex("}") + 1])["archives_to_delete"]), 2)

    def test_no_batch_argument_means_the_one_group_of_the_session(self):
        self.old_style_groups()
        args = argparse.Namespace(batch=None, session="esim")
        self.assertEqual(ORGANIZER.resolve_group_argument(args), "batch-20261007-101500")
        self.assertEqual(ORGANIZER.resolve_group_argument(argparse.Namespace(batch="batch-20261009-090000", session="esim")), "batch-20261009-090000")
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "no archive group yet"):
            ORGANIZER.resolve_group_argument(argparse.Namespace(batch=None, session="nobody"))
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "Pass --batch, or --session"):
            ORGANIZER.resolve_group_argument(argparse.Namespace(batch=None, session=None))

    def test_restore_batch_through_the_command_line_settles_and_needs_no_batch_id(self):
        self.old_style_groups()
        parsed = ORGANIZER.parser().parse_args(["--session", "esim", "restore-batch", "--execute", "--confirm", "batch-20261007-101500"])
        calls = []
        with patch.object(ORGANIZER, "restore_command", side_effect=lambda args: calls.append(args.archive)), patch.object(ORGANIZER, "STATE_DIR", Path(self.temporary.name)):
            self.run_quietly(parsed.func, parsed)
        self.assertEqual(sorted(calls), ["20261007-101500-01-ws1", "20261007-101500-02-ws2", "20261008-090000-01-ws1"])
        self.assertEqual(sorted(path.stem for path in self.batches.glob("*.json")), ["batch-20261007-101500", "batch-20261009-090000"])

    def test_wrong_confirmation_closes_and_writes_nothing(self):
        herdr = self.world()
        for confirm in (None, "other", "w1"):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "requires --confirm"):
                self.run_quietly(ORGANIZER.archive_all_command, self.archive_args(confirm=confirm))
        self.assertEqual(herdr.closed, [])
        self.assertFalse(self.batches.exists() or self.archives.exists())

    def test_running_inside_a_workspace_on_the_list_stops_before_closing_anything(self):
        herdr = self.world()
        os.environ.update({"HERDR_SESSION": "esim", "HERDR_PANE_ID": "w2:p1"})
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, r"inside workspace w2 \(Agent ok\)"):
            self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        self.assertEqual(herdr.closed, [])
        self.assertFalse(self.batches.exists() or self.archives.exists())

    def test_running_inside_a_skipped_workspace_or_another_session_is_fine(self):
        herdr = self.world()
        os.environ.update({"HERDR_SESSION": "esim", "HERDR_PANE_ID": "w3:p1"})
        self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        self.assertEqual(herdr.closed, ["w1", "w2"])
        herdr2 = self.world(workspaces=[("w1", "Clean")], restores={}, working=())
        os.environ.update({"HERDR_SESSION": "other", "HERDR_PANE_ID": "w1:p1"})
        self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        self.assertEqual(herdr2.closed, ["w1"])

    def test_workspace_that_changed_since_the_preview_is_skipped_not_closed(self):
        herdr = self.world(workspaces=[("w1", "Clean"), ("w2", "Agent ok")], restores={"w2": [RESUMABLE]}, working=())
        real_run = herdr.run_json

        def close_then_turn_busy(arguments, session):
            result = real_run(arguments, session)
            herdr.working.add("w2")
            return result

        with patch.object(ORGANIZER, "run_json", close_then_turn_busy):
            output = self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        self.assertEqual(herdr.closed, ["w1"])
        (manifest,) = self.manifests()
        self.assertEqual([m["workspace_id"] for m in manifest["members"]], ["w1"])
        self.assertIn("w2", [item["workspace_id"] for item in manifest["skipped"]])
        self.assertIn("working or blocked", output)

    def test_renamed_or_vanished_workspace_is_skipped(self):
        herdr = self.world(workspaces=[("w1", "Clean"), ("w2", "Two"), ("w3", "Three")], restores={}, working=())
        real_run = herdr.run_json

        def disturb(arguments, session):
            result = real_run(arguments, session)
            herdr.workspaces = [w for w in herdr.workspaces if w["workspace_id"] != "w3"]
            for w in herdr.workspaces:
                if w["workspace_id"] == "w2":
                    w["label"] = "Renamed"
            return result

        with patch.object(ORGANIZER, "run_json", disturb):
            self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        self.assertEqual(herdr.closed, ["w1"])
        (manifest,) = self.manifests()
        reasons = {item["workspace_id"]: item["reasons"] for item in manifest["skipped"]}
        self.assertEqual(reasons, {"w2": ["workspace_changed"], "w3": ["workspace_gone"]})

    def test_close_failure_keeps_the_member_marks_it_and_continues(self):
        herdr = self.world(workspaces=[("w1", "One"), ("w2", "Two")], restores={}, working=(), close_fails={"w1"})
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "could not be closed"):
            self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        self.assertEqual(herdr.closed, ["w2"])
        (manifest,) = self.manifests()
        self.assertEqual(manifest["status"], "completed_with_failures")
        summary = ORGANIZER.batch_summary(manifest)
        self.assertEqual(summary["counts"]["archived"], 1)
        self.assertEqual(summary["counts"]["other"], 1)

    def test_ctrl_c_or_an_unexpected_error_closes_out_the_record(self):
        for failure in (KeyboardInterrupt(), RuntimeError("disk full")):
            with self.subTest(failure=type(failure).__name__):
                herdr = self.world(workspaces=[("w1", "One"), ("w2", "Two")], restores={}, working=())
                real_run = herdr.run_json

                def interrupted(arguments, session, failure=failure):
                    if arguments[:2] == ["workspace", "close"] and arguments[2] == "w2":
                        raise failure
                    return real_run(arguments, session)

                with patch.object(ORGANIZER, "run_json", interrupted), patch.object(
                    ORGANIZER, "batch_id_for", return_value=f"batch-20990101-0000{len(self.manifests()):02d}"
                ):
                    with self.assertRaises(type(failure)):
                        self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
                manifest = self.manifests()[-1]
                self.assertEqual(manifest["status"], "interrupted")
                self.assertIn("completed_at", manifest)
                statuses = {m["workspace_id"]: ORGANIZER.batch_member_view(m)["status"] for m in manifest["members"]}
                self.assertEqual(statuses, {"w1": "archived", "w2": "close_failed"})
                archive = json.loads((self.archives / f"{manifest['members'][1]['archive_id']}.json").read_text())
                self.assertIn("Check whether the workspace is still open", archive["error"])
                for name in os.listdir(self.archives):
                    (self.archives / name).unlink()

    def test_a_second_run_is_refused_while_one_holds_the_lock(self):
        herdr = self.world()
        self.make_batch(["archived"])
        with ORGANIZER.batch_run_lock("test"):
            with patch.object(ORGANIZER, "STATE_DIR", ORGANIZER.STATE_DIR):
                for function, args in (
                    (ORGANIZER.archive_all_command, self.archive_args()),
                    (ORGANIZER.parser().parse_args(["--session", "esim", "restore-batch", "--execute", "--confirm", "batch-20261007-101500"]).func, self.restore_args()),
                ):
                    child = os.fork()
                    if child == 0:
                        code = 1
                        try:
                            with redirect_stdout(io.StringIO()):
                                function(args)
                        except ORGANIZER.OrganizerError as error:
                            code = 0 if "already in progress" in str(error) else 2
                        os._exit(code)
                    _, status = os.waitpid(child, 0)
                    self.assertEqual(os.WEXITSTATUS(status), 0, function.__name__)
        self.assertEqual(herdr.closed, [])

    def test_restore_batch_skips_a_member_that_was_restored_after_the_preview(self):
        self.make_batch(["archived", "archived"])
        seen = []

        def restore(args):
            seen.append(args.archive)
            ORGANIZER.write_json(ORGANIZER.ARCHIVE_DIR / f"{args.archive}.json", {"archive_id": args.archive, "status": "restored"})
            # a concurrent run restores the other member while this one works
            other = "20261007-101500-02-ws2"
            ORGANIZER.write_json(ORGANIZER.ARCHIVE_DIR / f"{other}.json", {"archive_id": other, "status": "restored"})

        with patch.object(ORGANIZER, "restore_command", side_effect=restore):
            output = self.run_quietly(ORGANIZER.restore_batch_command, self.restore_args())
        self.assertEqual(seen, ["20261007-101500-01-ws1"])
        self.assertIn("no longer archived", output)

    def test_interrupt_after_the_workspace_closed_is_labelled_archived(self):
        herdr = self.world(workspaces=[("w1", "One"), ("w2", "Two")], restores={}, working=())
        real_run = herdr.run_json

        def closes_then_interrupted(arguments, session):
            result = real_run(arguments, session)
            if arguments[:2] == ["workspace", "close"] and arguments[2] == "w2":
                raise KeyboardInterrupt()
            return result

        with patch.object(ORGANIZER, "run_json", closes_then_interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        (manifest,) = self.manifests()
        self.assertEqual(manifest["status"], "interrupted")
        statuses = {m["workspace_id"]: ORGANIZER.batch_member_view(m)["status"] for m in manifest["members"]}
        self.assertEqual(statuses, {"w1": "archived", "w2": "archived"}, "w2 was closed before the interrupt")
        archive = json.loads((self.archives / f"{manifest['members'][1]['archive_id']}.json").read_text())
        self.assertIn("Confirmed against the live workspace list", archive["note"])

    def test_interrupt_with_an_unreadable_live_list_never_claims_the_workspace_closed(self):
        herdr = self.world(workspaces=[("w1", "One")], restores={}, working=())
        calls = {"snapshots": 0}
        real_snapshot = herdr.snapshot

        def snapshot(session=None):
            calls["snapshots"] += 1
            if calls["snapshots"] > 2:  # planning and the pre-close re-check work; the post-interrupt read fails
                raise ORGANIZER.OrganizerError("herdr unreachable")
            return real_snapshot(session)

        def interrupted(arguments, session):
            if arguments[:2] == ["workspace", "close"]:
                raise KeyboardInterrupt()
            return {}

        with patch.object(ORGANIZER, "session_snapshot", snapshot), patch.object(ORGANIZER, "run_json", interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        (manifest,) = self.manifests()
        self.assertEqual(ORGANIZER.batch_member_view(manifest["members"][0])["status"], "close_failed")

    def test_single_archive_restore_and_delete_take_the_batch_lock_when_they_execute(self):
        self.world()
        self.make_batch(["archived"])
        parsed = [
            ORGANIZER.parser().parse_args(["--session", "esim", "restore", "--archive", "20261007-101500-01-ws1", "--execute", "--confirm", "20261007-101500-01-ws1"]),
            ORGANIZER.parser().parse_args(["--session", "esim", "archive", "--workspace", "w1", "--execute", "--confirm", "w1"]),
            ORGANIZER.parser().parse_args(["delete-archive", "--archive", "20261007-101500-01-ws1", "--execute", "--confirm", "20261007-101500-01-ws1"]),
        ]
        parsed += [
            ORGANIZER.parser().parse_args(argv)
            for argv in (
                ["--session", "esim", "archive-tabs", "--tab", "w1:t1", "--into-archive", "x", "--execute", "--confirm", "x"],
                ["--session", "esim", "restore-tab", "--archive", "x", "--tab", "w1:t1", "--to-workspace", "w2", "--execute", "--confirm", "x"],
                ["--session", "esim", "restore-tabs", "--archive", "x", "--tab", "w1:t1", "--to-workspace", "w2", "--execute", "--confirm", "x"],
                ["delete-archived-tab", "--archive", "x", "--tab", "w1:t1", "--execute", "--confirm", "x:w1:t1"],
                ["--session", "esim", "move-tabs", "--tab", "w1:t1", "--to-workspace", "w2", "--execute", "--confirm", "w2"],
                ["--session", "esim", "resume-move", "--move", "m", "--execute", "--confirm", "m"],
                ["--session", "esim", "cleanup-empty-tabs", "--workspace", "w1", "--execute", "--confirm", "w1"],
            )
        ]
        with ORGANIZER.batch_run_lock("test"):
            for args in parsed:
                child = os.fork()
                if child == 0:
                    code = 1
                    try:
                        with redirect_stdout(io.StringIO()):
                            args.func(args)
                    except ORGANIZER.OrganizerError as error:
                        code = 0 if "already in progress" in str(error) else 2
                    os._exit(code)
                _, status = os.waitpid(child, 0)
                self.assertEqual(os.WEXITSTATUS(status), 0, args.command)
        self.assertEqual(len(list(self.archives.glob("*.json"))), 1, "nothing was deleted or created")

    def test_previews_of_single_commands_do_not_take_the_lock(self):
        self.make_batch(["archived"])
        with ORGANIZER.batch_run_lock("test"):
            args = ORGANIZER.parser().parse_args(["--session", "esim", "restore", "--archive", "20261007-101500-01-ws1"])
            self.assertEqual(self.run_quietly(args.func, args).count("Preview only"), 1)

    def test_renamed_workspace_still_open_after_an_interrupt_is_not_called_gone(self):
        herdr = self.world(workspaces=[("w1", "One")], restores={}, working=())

        def renamed_then_interrupted(arguments, session):
            if arguments[:2] == ["workspace", "close"]:
                for workspace in herdr.workspaces:
                    workspace["label"] = "Renamed meanwhile"
                raise KeyboardInterrupt()
            return {}

        with patch.object(ORGANIZER, "run_json", renamed_then_interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        (manifest,) = self.manifests()
        self.assertEqual(ORGANIZER.batch_member_view(manifest["members"][0])["status"], "close_failed")

    def test_no_eligible_workspace_writes_no_batch(self):
        herdr = self.world(workspaces=[("w3", "Busy")], restores={}, working={"w3"})
        output = self.run_quietly(ORGANIZER.archive_all_command, self.archive_args())
        self.assertIn("Nothing to archive", output)
        self.assertEqual(herdr.closed, [])
        self.assertFalse(self.batches.exists())

    def test_archive_all_has_no_allow_flags(self):
        parsed = ORGANIZER.parser().parse_args(["--session", "esim", "archive-all"])
        self.assertFalse(hasattr(parsed, "allow_active"))
        self.assertFalse(hasattr(parsed, "allow_unresumable_agents"))
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            ORGANIZER.parser().parse_args(["archive-all", "--allow-active"])

    def make_batch(self, statuses, batch_id="batch-20261007-101500", session="esim"):
        members = []
        for index, status in enumerate(statuses, start=1):
            archive_id = f"{batch_id[6:]}-{index:02d}-ws{index}"
            members.append({"archive_id": archive_id, "workspace_id": f"w{index}", "workspace_label": f"Ws {index}"})
            if status != "deleted":
                ORGANIZER.write_json(
                    ORGANIZER.ARCHIVE_DIR / f"{archive_id}.json",
                    {"archive_id": archive_id, "status": status, "batch_id": batch_id, "restore": {"workspace_id": "w99"} if status in {"restored", "resumed"} else {}},
                )
        manifest = {"version": 1, "batch_id": batch_id, "status": "completed", "created_at": "2026-10-07T10:15:00+00:00", "herdr_session": session, "members": members, "skipped": [{"workspace_id": "w50", "label": "Skipped", "reasons": ["active_agent"]}]}
        ORGANIZER.write_json(ORGANIZER.BATCH_DIR / f"{batch_id}.json", manifest)
        return manifest

    def test_batch_summary_counts_each_status_and_marks_an_all_gone_group_empty(self):
        manifest = self.make_batch(["archived", "restored", "resumed", "restore_partial", "deleted", "close_failed"])
        summary = ORGANIZER.batch_summary(manifest)
        self.assertEqual(summary["counts"], {"archived": 1, "restored": 2, "restore_partial": 1, "deleted": 1, "other": 1, "skipped": 1})
        self.assertFalse(summary["empty"])
        gone = ORGANIZER.batch_summary(self.make_batch(["deleted", "deleted"], batch_id="batch-20261007-111500"))
        self.assertTrue(gone["empty"])
        self.assertEqual(gone["counts"]["deleted"], 2)

    def test_a_group_member_lists_the_tabs_its_archive_holds(self):
        manifest = self.make_batch(["archived"])
        path = ORGANIZER.ARCHIVE_DIR / f"{manifest['members'][0]['archive_id']}.json"
        archive = json.loads(path.read_text())
        leaf = lambda pane: {"type": "pane", "pane_id": pane}
        archive["capture"] = {"workspace": {"label": "Ws 1"}, "tabs": [
            {"source_tab_id": "w1:t1", "label": "leader-esim", "layout": {"root": leaf("w1:p1")}},
            {"source_tab_id": "w1:t2", "agent_restores": [{"client": "claude", "source_pane_id": "w1:p2"}],
             "layout": {"root": {"type": "split", "children": [leaf("w1:p2"), leaf("w1:p3")]}}},
        ]}
        ORGANIZER.write_json(path, archive)
        [member] = ORGANIZER.batch_summary(manifest)["members"]
        self.assertEqual([(t["id"], t["label"]) for t in member["tabs"]], [("w1:t1", "leader-esim"), ("w1:t2", "w1:t2")])
        self.assertEqual(member["tabs"][0]["pane_count"], 1)
        # The page offers to resume one tab only when none of its agents is unverified.
        self.assertEqual([(t["resumable_agent_count"], t["unresumable_agent_count"]) for t in member["tabs"]], [(0, 0), (0, 1)])
        # A deleted or unreadable archive has no tabs to show.
        gone = ORGANIZER.batch_summary(self.make_batch(["deleted"], batch_id="batch-20261007-111500"))["members"][0]
        self.assertEqual(gone["tabs"], [])

    def test_member_with_a_path_like_archive_id_is_treated_as_deleted(self):
        manifest = self.make_batch(["archived"])
        manifest["members"][0]["archive_id"] = "../../etc/passwd"
        self.assertEqual(ORGANIZER.batch_summary(manifest)["members"][0]["status"], "deleted")

    def test_snapshot_lists_batches_and_archives_carry_the_batch_id(self):
        self.make_batch(["archived"])
        self.assertEqual(ORGANIZER.archive_summary(json.loads(next(self.archives.glob("*.json")).read_text()))["batch_id"], "batch-20261007-101500")
        self.assertEqual([b["batch_id"] for b in map(ORGANIZER.batch_summary, ORGANIZER.load_batches())], ["batch-20261007-101500"])

    def test_malformed_or_foreign_manifest_files_are_ignored(self):
        self.make_batch(["archived"])
        (self.batches / "broken.json").write_text("{not json")
        ORGANIZER.write_json(self.batches / "other.json", {"batch_id": "../x", "members": []})
        self.assertEqual(len(ORGANIZER.load_batches()), 1)

    def restore_args(self, **overrides):
        values = dict(batch="batch-20261007-101500", session="esim", resume_agents=True, execute=True, confirm="batch-20261007-101500")
        values.update(overrides)
        return argparse.Namespace(**values)

    def test_restore_batch_acts_only_on_archived_members_and_never_forces(self):
        self.make_batch(["archived", "restored", "restore_partial", "deleted", "archived"])
        calls = []
        with patch.object(ORGANIZER, "restore_command", side_effect=lambda args: calls.append(args)):
            output = self.run_quietly(ORGANIZER.restore_batch_command, self.restore_args())
        self.assertEqual([c.archive for c in calls], ["20261007-101500-01-ws1", "20261007-101500-05-ws5"])
        for call in calls:
            self.assertFalse(call.force)
            self.assertFalse(call.allow_unresumable_agents)
            self.assertTrue(call.resume_agents)
            self.assertEqual((call.confirm, call.execute, call.session), (call.archive, True, "esim"))
        self.assertNotIn("ws2", output, "a restored member is not in the group any more")
        self.assertNotIn("ws4", output, "a deleted member is not in the group any more")
        self.assertIn("Left 20261007-101500-03-ws3 alone: restore_partial", output)

    def test_restore_batch_layout_only_does_not_resume_agents(self):
        self.make_batch(["archived"])
        calls = []
        with patch.object(ORGANIZER, "restore_command", side_effect=lambda args: calls.append(args)):
            self.run_quietly(ORGANIZER.restore_batch_command, self.restore_args(resume_agents=False))
        self.assertFalse(calls[0].resume_agents)

    def test_restore_batch_continues_after_a_failure_and_reports_it(self):
        self.make_batch(["archived", "archived"])
        seen = []

        def restore(args):
            seen.append(args.archive)
            if args.archive.endswith("ws1"):
                raise ORGANIZER.OrganizerError("no verified session")

        with patch.object(ORGANIZER, "restore_command", side_effect=restore):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "ws1: no verified session"):
                self.run_quietly(ORGANIZER.restore_batch_command, self.restore_args())
        self.assertEqual(len(seen), 2)

    def test_restore_batch_preview_and_bad_confirmation_restore_nothing(self):
        self.make_batch(["archived", "restore_partial"])
        with patch.object(ORGANIZER, "restore_command") as restore:
            output = self.run_quietly(ORGANIZER.restore_batch_command, self.restore_args(execute=False, confirm=None))
            preview = json.loads(output[: output.rindex("}") + 1])
            self.assertEqual(len(preview["to_restore"]), 1)
            self.assertEqual(preview["not_restored"][0]["status"], "restore_partial")
            for confirm in (None, "other"):
                with self.assertRaisesRegex(ORGANIZER.OrganizerError, "requires --confirm"):
                    self.run_quietly(ORGANIZER.restore_batch_command, self.restore_args(confirm=confirm))
        restore.assert_not_called()

    def test_restore_batch_refuses_a_different_session_and_a_bad_batch_id(self):
        self.make_batch(["archived"])
        with patch.object(ORGANIZER, "restore_command") as restore:
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "captured from session 'esim'"):
                self.run_quietly(ORGANIZER.restore_batch_command, self.restore_args(session="other"))
            for bad in ("../x", "batch-1", "batch-20261007-101500/../x"):
                with self.assertRaisesRegex(ORGANIZER.OrganizerError, "Batch ID"):
                    self.run_quietly(ORGANIZER.restore_batch_command, self.restore_args(batch=bad, confirm=bad))
        restore.assert_not_called()

    def test_restore_batch_with_nothing_archived_does_nothing(self):
        self.make_batch(["restore_partial", "close_failed"])
        with patch.object(ORGANIZER, "restore_command") as restore:
            output = self.run_quietly(ORGANIZER.restore_batch_command, self.restore_args())
        restore.assert_not_called()
        self.assertIn("Nothing to restore", output)

    def test_delete_batch_with_archives_removes_members_and_the_record_only(self):
        manifest = self.make_batch(["archived", "restored", "deleted"])
        ORGANIZER.write_json(ORGANIZER.ARCHIVE_DIR / "unrelated.json", {"archive_id": "unrelated", "status": "archived"})
        ORGANIZER.write_json(ORGANIZER.ARCHIVE_DIR / "other-batch.json", {"archive_id": "other-batch", "status": "archived", "batch_id": "batch-20990101-000000"})
        manifest["members"].append({"archive_id": "other-batch", "workspace_id": "w8", "workspace_label": "Foreign"})
        ORGANIZER.write_json(ORGANIZER.BATCH_DIR / f"{manifest['batch_id']}.json", manifest)
        args = argparse.Namespace(batch=manifest["batch_id"], execute=False, confirm=None, archives=True)
        output = self.run_quietly(ORGANIZER.delete_batch_command, args)
        preview = json.loads(output[: output.rindex("}") + 1])
        self.assertEqual(len(preview["archives_to_delete"]), 1, "a restored or deleted member is no longer in the group")
        self.assertEqual(preview["archives_left_alone"], ["other-batch"])
        self.assertIn("still archived", output)
        self.assertIn("delete-archives:batch-20261007-101500", output)
        self.assertEqual(len(list(self.archives.glob("*.json"))), 4, "preview deletes nothing")
        # the record-only confirmation (the batch id) must not authorize a permanent delete of archives
        for confirm in (None, "other", manifest["batch_id"]):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "requires --confirm 'delete-archives:"):
                self.run_quietly(ORGANIZER.delete_batch_command, argparse.Namespace(batch=manifest["batch_id"], execute=True, confirm=confirm, archives=True))
        self.assertEqual(len(list(self.archives.glob("*.json"))), 4)
        output = self.run_quietly(ORGANIZER.delete_batch_command, argparse.Namespace(batch=manifest["batch_id"], execute=True, confirm="delete-archives:" + manifest["batch_id"], archives=True))
        self.assertIn("Left other-batch alone", output)
        self.assertEqual(sorted(path.stem for path in self.archives.glob("*.json")), ["20261007-101500-02-ws2", "other-batch", "unrelated"])
        self.assertEqual(list(self.batches.glob("*.json")), [])

    def test_delete_batch_with_archives_keeps_the_record_when_an_archive_cannot_be_deleted(self):
        manifest = self.make_batch(["archived", "archived"])
        real_unlink = Path.unlink

        def flaky(path, *a, **k):
            if path.name.endswith("ws2.json"):
                raise PermissionError("denied")
            return real_unlink(path, *a, **k)

        with patch.object(Path, "unlink", flaky):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "group record was kept"):
                self.run_quietly(ORGANIZER.delete_batch_command, argparse.Namespace(batch=manifest["batch_id"], execute=True, confirm="delete-archives:" + manifest["batch_id"], archives=True))
        self.assertEqual(len(list(self.batches.glob("*.json"))), 1)
        self.assertEqual([path.stem for path in self.archives.glob("*.json")], ["20261007-101500-02-ws2"])

    def test_delete_batch_removes_only_the_group_record(self):
        manifest = self.make_batch(["archived"])
        args = argparse.Namespace(batch=manifest["batch_id"], execute=True, confirm=manifest["batch_id"])
        self.run_quietly(ORGANIZER.delete_batch_command, argparse.Namespace(batch=manifest["batch_id"], execute=True, confirm=manifest["batch_id"]))
        self.assertEqual(list(self.batches.glob("*.json")), [])
        self.assertEqual(len(list(self.archives.glob("*.json"))), 1)
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "not found"):
            self.run_quietly(ORGANIZER.delete_batch_command, args)


class LayoutHerdr:
    """A Herdr that can create workspaces, rebuild layouts and take resume commands, with nothing real behind it."""

    def __init__(self):
        self.data = {"workspaces": [], "tabs": [], "panes": []}
        self.created = []
        self.sent = []

    def snapshot(self, _session=None):
        return json.loads(json.dumps(self.data))

    def add_workspace(self, wid, label, status="unknown", agent=None):
        self.data["workspaces"].append({"workspace_id": wid, "label": label})
        self.data["tabs"].append({"workspace_id": wid, "tab_id": f"{wid}:t1"})
        pane = {"tab_id": f"{wid}:t1", "pane_id": f"{wid}:p1", "agent_status": status}
        if agent:
            pane["agent"] = agent
        self.data["panes"].append(pane)

    def run_json(self, arguments, _session):
        if arguments[:2] == ["workspace", "create"]:
            wid = f"w{20 + len(self.created)}"
            self.created.append(wid)
            self.add_workspace(wid, arguments[3])
            return {"result": {"workspace_id": wid, "tab_id": f"{wid}:t1"}}
        return {"result": {}}

    def socket_call(self, _session, method, params):
        if method == "layout.export":
            wid = params["tab_id"].split(":")[0]
            return {"layout": {"tab_id": params["tab_id"], "root": {"type": "pane", "pane_id": f"{wid}:p1"}}}
        tab = params.get("tab_id") or f"{params['workspace_id']}:t9"
        wid = tab.split(":")[0]
        return {"layout": {"tab_id": tab, "root": {"type": "pane", "pane_id": f"{wid}:p1"}}}

    def run_command(self, arguments, _session):
        if arguments[:2] == ["pane", "run"]:
            self.sent.append(arguments[2])


class LayoutRestoreTests(unittest.TestCase):
    """A layout-only restore never counts as a restore. Only a restore that resumes agents marks the archive restored."""

    ARCHIVE_ID = "20261010-100000-alpha"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.archives = Path(self.temporary.name) / "archives"
        patcher = patch.object(ORGANIZER, "ARCHIVE_DIR", self.archives)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.herdr = LayoutHerdr()
        for name, value in (
            ("session_snapshot", self.herdr.snapshot),
            ("run_json", self.herdr.run_json),
            ("socket_call", self.herdr.socket_call),
            ("run_command", self.herdr.run_command),
        ):
            patcher = patch.object(ORGANIZER, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        agent = {"client": "codex", "restore_status": "resumable", "restore_source": "manifest", "source_pane_id": "w1:p1", "resume_command": "codex resume x"}
        ORGANIZER.write_json(
            self.archives / f"{self.ARCHIVE_ID}.json",
            {
                "archive_id": self.ARCHIVE_ID,
                "status": "archived",
                "restore": {},
                "capture": {
                    "workspace": {"label": "Alpha", "focused": False},
                    "tabs": [{"source_tab_id": "w1:t1", "label": "main", "layout": {"root": {"type": "pane", "pane_id": "w1:p1"}}, "agent_restores": [agent]}],
                },
            },
        )

    def args(self, **overrides):
        values = dict(archive=self.ARCHIVE_ID, resume_agents=False, allow_unresumable_agents=False, force=False, execute=True, confirm=self.ARCHIVE_ID, session="esim")
        values.update(overrides)
        return argparse.Namespace(**values)

    def run_restore(self, **overrides):
        with redirect_stdout(io.StringIO()):
            return ORGANIZER.restore_command(self.args(**overrides))

    def archive(self):
        return json.loads((self.archives / f"{self.ARCHIVE_ID}.json").read_text())

    def test_layout_only_restore_keeps_the_archive_archived_and_records_the_copy(self):
        self.assertEqual(self.run_restore(), "laid_out")
        archive = self.archive()
        self.assertEqual(archive["status"], "archived")
        self.assertEqual(archive["restore"], {})
        self.assertEqual(archive["layout_restore"]["workspace_id"], "w20")
        self.assertEqual(ORGANIZER.batch_member_view({"archive_id": self.ARCHIVE_ID})["layout_workspace_id"], "w20")
        self.assertEqual(self.herdr.sent, [])

    def test_a_second_layout_only_restore_finds_the_open_copy_and_makes_no_workspace(self):
        self.run_restore()
        self.assertEqual(self.run_restore(), "already_laid_out")
        self.assertEqual(self.herdr.created, ["w20"])
        self.assertEqual(self.run_restore(force=True), "laid_out")
        self.assertEqual(self.herdr.created, ["w20", "w21"], "--force is the only way to a second copy")

    def test_resume_adopts_the_open_copy_and_only_then_marks_the_archive_restored(self):
        self.run_restore()
        self.assertEqual(self.run_restore(resume_agents=True), "adopted")
        self.assertEqual(self.herdr.created, ["w20"], "no new workspace")
        self.assertEqual(self.herdr.sent, ["w20:p1"])
        archive = self.archive()
        self.assertEqual(archive["status"], "resumed")
        self.assertEqual(archive["restore"]["workspace_id"], "w20")
        self.assertTrue(archive["restore"]["adopted_layout_copy"])
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "already restored"):
            self.run_restore(resume_agents=True)

    def test_resume_without_a_layout_copy_makes_a_new_workspace(self):
        self.assertEqual(self.run_restore(resume_agents=True), "created")
        self.assertEqual(self.herdr.created, ["w20"])
        self.assertEqual(self.herdr.sent, ["w20:p1"])
        self.assertEqual(self.archive()["status"], "resumed")
        self.assertNotIn("layout_restore", self.archive())

    def test_a_closed_copy_is_not_adopted(self):
        self.run_restore()
        self.herdr.data = {"workspaces": [], "tabs": [], "panes": []}
        self.assertEqual(self.run_restore(resume_agents=True), "created")
        self.assertEqual(self.herdr.created, ["w20", "w21"])

    def test_a_copy_whose_panes_no_longer_match_is_not_adopted(self):
        self.run_restore()
        self.herdr.data["panes"].append({"tab_id": "w20:t1", "pane_id": "w20:p2", "agent_status": "unknown"})
        real_export = self.herdr.socket_call

        def two_panes(session, method, params):
            if method == "layout.export":
                return {"layout": {"tab_id": params["tab_id"], "root": {"type": "split", "first": {"type": "pane", "pane_id": "w20:p1"}, "second": {"type": "pane", "pane_id": "w20:p2"}}}}
            return real_export(session, method, params)

        with patch.object(ORGANIZER, "socket_call", two_panes):
            self.assertIsNone(ORGANIZER.layout_copy_of(self.archive(), "esim"))

    def test_the_restore_record_keeps_the_pane_ids_and_layout_shape_it_built(self):
        self.run_restore()
        [tab] = self.archive()["layout_restore"]["tabs"]
        self.assertEqual((tab["tab_id"], tab["pane_ids"], tab["topology"]), ("w20:t1", ["w20:p1"], "pane"))

    def adoption_with(self, record_tabs, live_root, capture_root=None):
        """layout_copy_of for a copy whose live layout is live_root, after a restore recorded record_tabs."""
        archive = self.archive()
        if capture_root is not None:
            archive["capture"]["tabs"][0]["layout"] = {"root": capture_root}
        archive["layout_restore"] = {"workspace_id": "w20", "tabs": record_tabs}
        self.herdr.add_workspace("w20", "Alpha")

        def export(_session, method, params):
            self.assertEqual(method, "layout.export")
            return {"layout": {"tab_id": params["tab_id"], "root": live_root}}

        with patch.object(ORGANIZER, "socket_call", export):
            return ORGANIZER.layout_copy_of(archive, "esim")

    @staticmethod
    def split(direction, first, second):
        return {"type": "split", "direction": direction, "ratio": 0.5, "first": {"type": "pane", "pane_id": first}, "second": {"type": "pane", "pane_id": second}}

    def recorded(self, **overrides):
        record = {"source_tab_id": "w1:t1", "tab_id": "w20:t1", "pane_ids": ["w20:p1", "w20:p2"], "topology": ["split", "right", "pane", "pane"]}
        record.update(overrides)
        return [record]

    def test_a_copy_that_is_exactly_what_the_restore_built_is_adopted(self):
        captured = self.split("right", "w1:p1", "w1:p2")
        copy = self.adoption_with(self.recorded(), self.split("right", "w20:p1", "w20:p2"), captured)
        self.assertEqual(copy["pane_map"], {"w1:p1": "w20:p1", "w1:p2": "w20:p2"})

    def test_a_replaced_pane_with_the_same_counts_is_not_adopted(self):
        captured = self.split("right", "w1:p1", "w1:p2")
        replaced = self.split("right", "w20:p1", "w20:p9")
        self.assertIsNone(self.adoption_with(self.recorded(), replaced, captured))

    def test_swapped_panes_with_the_same_counts_are_not_adopted(self):
        captured = self.split("right", "w1:p1", "w1:p2")
        self.assertIsNone(self.adoption_with(self.recorded(), self.split("right", "w20:p2", "w20:p1"), captured))

    def test_a_rearranged_split_with_the_same_counts_is_not_adopted(self):
        captured = self.split("right", "w1:p1", "w1:p2")
        self.assertIsNone(self.adoption_with(self.recorded(), self.split("down", "w20:p1", "w20:p2"), captured))

    def test_a_recorded_shape_that_no_longer_matches_is_not_adopted(self):
        captured = self.split("right", "w1:p1", "w1:p2")
        record = self.recorded(topology=["split", "down", "pane", "pane"], pane_ids=["w20:p1", "w20:p2"])
        self.assertIsNone(self.adoption_with(record, self.split("right", "w20:p1", "w20:p2"), captured))

    def test_a_tab_the_record_does_not_name_is_not_adopted_by_position(self):
        captured = self.split("right", "w1:p1", "w1:p2")
        record = self.recorded(source_tab_id="w1:other")
        self.assertIsNone(self.adoption_with(record, self.split("right", "w20:p1", "w20:p2"), captured))

    def test_an_older_record_without_pane_ids_adopts_on_the_layout_shape_alone(self):
        captured = self.split("right", "w1:p1", "w1:p2")
        record = [{"source_tab_id": "w1:t1", "tab_id": "w20:t1"}]
        self.assertIsNotNone(self.adoption_with(record, self.split("right", "w20:p7", "w20:p8"), captured))
        self.assertIsNone(self.adoption_with(record, self.split("down", "w20:p7", "w20:p8"), captured))

    def test_resume_into_a_replaced_pane_creates_a_new_workspace_instead(self):
        self.run_restore()
        real_export = self.herdr.socket_call

        def replaced(session, method, params):
            if method == "layout.export" and params["tab_id"] == "w20:t1":
                return {"layout": {"tab_id": "w20:t1", "root": {"type": "pane", "pane_id": "w20:p9"}}}
            return real_export(session, method, params)

        with patch.object(ORGANIZER, "socket_call", replaced):
            self.assertEqual(self.run_restore(resume_agents=True), "created")
        self.assertEqual(self.herdr.created, ["w20", "w21"])
        self.assertEqual(self.herdr.sent, ["w21:p1"], "the resume command went to the fresh workspace, not the replaced shell")

    def test_a_pane_that_already_runs_an_agent_gets_no_resume_command(self):
        self.run_restore()
        self.herdr.data["panes"][0].update({"agent": "codex", "agent_status": "idle"})
        self.assertEqual(self.run_restore(resume_agents=True), "adopted")
        self.assertEqual(self.herdr.sent, [])
        self.assertEqual(self.archive()["restore"]["agent_resume"][0]["reason"], "agent_running")
        self.assertEqual(self.archive()["status"], "restored", "nothing needed resuming, nothing failed")

    def test_a_failed_resume_send_keeps_the_archive_restore_partial_and_can_be_retried(self):
        self.run_restore()
        calls = {"n": 0}

        def flaky(arguments, session):
            calls["n"] += 1
            if calls["n"] == 1:
                raise ORGANIZER.OrganizerError("pane busy")
            self.herdr.run_command(arguments, session)

        with patch.object(ORGANIZER, "run_command", flaky):
            self.assertEqual(self.run_restore(resume_agents=True), "adopted")
        self.assertEqual(self.archive()["status"], "restore_partial")
        with patch.object(ORGANIZER, "run_command", flaky):
            self.assertEqual(self.run_restore(resume_agents=True), "adopted")
        self.assertEqual(self.archive()["status"], "resumed")

    def test_an_interrupted_layout_only_restore_leaves_the_archive_archived(self):
        def interrupted(_session, method, params):
            if method == "layout.apply":
                raise KeyboardInterrupt()
            return self.herdr.socket_call(_session, method, params)

        with patch.object(ORGANIZER, "socket_call", interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.run_restore()
        archive = self.archive()
        self.assertEqual(archive["status"], "archived")
        self.assertIn("Interrupted", archive["layout_restore"]["error"])

    def test_restore_batch_layout_only_reports_that_nothing_is_restored(self):
        manifest = {"version": 1, "batch_id": "batch-20261010-100000", "status": "completed", "created_at": "2026-10-10T10:00:00+00:00", "herdr_session": "esim", "members": [{"archive_id": self.ARCHIVE_ID, "workspace_id": "w1", "workspace_label": "Alpha"}], "skipped": []}
        with patch.object(ORGANIZER, "BATCH_DIR", Path(self.temporary.name) / "batches"):
            ORGANIZER.write_json(ORGANIZER.BATCH_DIR / "batch-20261010-100000.json", manifest)
            args = argparse.Namespace(batch="batch-20261010-100000", session="esim", resume_agents=False, execute=True, confirm="batch-20261010-100000")
            with redirect_stdout(io.StringIO()) as first:
                ORGANIZER.restore_batch_command(args)
            self.assertIn("laid out 1 of 1", first.getvalue())
            self.assertIn("Nothing is marked restored", first.getvalue())
            self.assertEqual(self.archive()["status"], "archived")
            with redirect_stdout(io.StringIO()) as second:
                ORGANIZER.restore_batch_command(args)
            self.assertIn("1 already had their layout open", second.getvalue())
            self.assertEqual(self.herdr.created, ["w20"])
            args.resume_agents = True
            with redirect_stdout(io.StringIO()) as third:
                ORGANIZER.restore_batch_command(args)
            self.assertIn("1 in an open layout copy", third.getvalue())
            self.assertEqual(self.archive()["status"], "resumed")


class CleanupEmptyWorkspaceTests(unittest.TestCase):
    """A workspace whose every tab is an empty shell closes entirely instead of keeping its last tab."""

    def setUp(self):
        self.calls = []
        environment = patch.dict(os.environ, {}, clear=False)
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("HERDR_SESSION", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID"):
            os.environ.pop(name, None)

    def snapshot(self, workspaces=("w1", "w2")):
        return {
            "workspaces": [{"workspace_id": wid, "label": wid} for wid in workspaces],
            "tabs": [{"workspace_id": wid, "tab_id": f"{wid}:t{n}", "label": f"tab {n}"} for wid in workspaces for n in (1, 2)],
            "panes": [{"tab_id": f"{wid}:t{n}", "pane_id": f"{wid}:p{n}"} for wid in workspaces for n in (1, 2)],
        }

    def tab(self, wid, n):
        return {"tab_id": f"{wid}:t{n}", "label": f"tab {n}", "pane_ids": [f"{wid}:p{n}"]}

    def run_cleanup(self, snapshot, eligible, protected=(), execute=False, workspace="w1"):
        def run_json(arguments, _session):
            self.calls.append(arguments)
            return {"result": {}}

        args = argparse.Namespace(workspace=workspace, execute=execute, confirm=workspace if execute else None, session="esim")
        output = io.StringIO()
        with patch.object(ORGANIZER, "session_snapshot", lambda _s=None: snapshot), patch.object(
            ORGANIZER, "empty_tab_cleanup_candidates", lambda *_a: (list(eligible), list(protected))
        ), patch.object(ORGANIZER, "run_json", run_json), redirect_stdout(output):
            ORGANIZER.cleanup_empty_tabs_command(args)
        return output.getvalue()

    def preview_of(self, text):
        return json.loads(text[: text.rindex("}") + 1])

    def test_a_workspace_of_only_empty_tabs_closes_with_its_last_tab(self):
        eligible = [self.tab("w1", 1), self.tab("w1", 2)]
        text = self.run_cleanup(self.snapshot(), eligible)
        preview = self.preview_of(text)
        self.assertTrue(preview["close_workspace"])
        self.assertEqual([tab["tab_id"] for tab in preview["tabs_to_close"]], ["w1:t1", "w1:t2"])
        self.assertIsNone(preview["kept_tab_id"])
        self.assertIn("and the workspace itself", text)
        self.assertEqual(self.calls, [], "a preview closes nothing")
        text = self.run_cleanup(self.snapshot(), eligible, execute=True)
        self.assertEqual(self.calls, [["workspace", "close", "w1"]])
        self.assertIn("closed with its last tab", text)

    def test_the_workspace_the_command_runs_in_keeps_its_last_tab(self):
        os.environ.update({"HERDR_SESSION": "esim", "HERDR_PANE_ID": "w1:p1"})
        eligible = [self.tab("w1", 1), self.tab("w1", 2)]
        text = self.run_cleanup(self.snapshot(), eligible, execute=True)
        self.assertEqual(self.calls, [["tab", "close", "w1:t1"]])
        self.assertIn("runs inside the workspace", text)
        self.calls.clear()
        preview = self.preview_of(self.run_cleanup(self.snapshot(), eligible))
        self.assertEqual((preview["close_workspace"], preview["kept_reason"], preview["kept_tab_id"]), (False, "running_inside", "w1:t2"))

    def test_the_only_workspace_in_the_session_keeps_its_last_tab(self):
        eligible = [self.tab("w1", 1), self.tab("w1", 2)]
        preview = self.preview_of(self.run_cleanup(self.snapshot(workspaces=("w1",)), eligible))
        self.assertEqual((preview["close_workspace"], preview["kept_reason"], preview["kept_tab_id"]), (False, "only_workspace", "w1:t2"))
        self.run_cleanup(self.snapshot(workspaces=("w1",)), eligible, execute=True)
        self.assertEqual(self.calls, [["tab", "close", "w1:t1"]])

    def test_a_workspace_with_a_protected_tab_only_loses_its_empty_tabs(self):
        eligible = [self.tab("w1", 2)]
        protected = [{"tab_id": "w1:t1", "reason": "agent_detected", "pane_ids": ["w1:p1"]}]
        preview = self.preview_of(self.run_cleanup(self.snapshot(), eligible, protected))
        self.assertFalse(preview["close_workspace"])
        self.assertIsNone(preview["kept_reason"])
        self.run_cleanup(self.snapshot(), eligible, protected, execute=True)
        self.assertEqual(self.calls, [["tab", "close", "w1:t2"]])

    def run_racing_cleanup(self, snapshots, candidates, execute=True):
        """Run cleanup against a session that changes after the preview: each call gets the next snapshot and answer."""
        sources = iter(snapshots)
        answers = iter(candidates)

        def run_json(arguments, _session):
            self.calls.append(arguments)
            return {"result": {}}

        args = argparse.Namespace(workspace="w1", execute=execute, confirm="w1" if execute else None, session="esim")
        output = io.StringIO()
        with patch.object(ORGANIZER, "session_snapshot", lambda _s=None: next(sources)), patch.object(
            ORGANIZER, "empty_tab_cleanup_candidates", lambda *_a: next(answers)
        ), patch.object(ORGANIZER, "run_json", run_json), redirect_stdout(output):
            ORGANIZER.cleanup_empty_tabs_command(args)
        return output.getvalue()

    def test_a_tab_opened_after_the_preview_stops_the_workspace_close(self):
        both = [self.tab("w1", 1), self.tab("w1", 2)]
        grown = self.snapshot()
        grown["tabs"].append({"workspace_id": "w1", "tab_id": "w1:t3", "label": "tab 3"})
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "changed since the preview"):
            self.run_racing_cleanup([self.snapshot(), grown], [(both, []), (both + [self.tab("w1", 3)], [])])
        self.assertEqual(self.calls, [], "no workspace close was sent")

    def test_a_process_started_after_the_preview_stops_the_workspace_close(self):
        both = [self.tab("w1", 1), self.tab("w1", 2)]
        protected = [{"tab_id": "w1:t2", "reason": "non_shell_process", "pane_ids": ["w1:p2"]}]
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "no longer all empty shells"):
            self.run_racing_cleanup([self.snapshot(), self.snapshot()], [(both, []), ([self.tab("w1", 1)], protected)])
        self.assertEqual(self.calls, [])

    def test_a_workspace_that_vanished_after_the_preview_closes_nothing(self):
        both = [self.tab("w1", 1), self.tab("w1", 2)]
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "no longer exists"):
            self.run_racing_cleanup([self.snapshot(), self.snapshot(workspaces=("w2",))], [(both, [])])
        self.assertEqual(self.calls, [])

    def test_a_tab_that_stopped_being_empty_is_left_open_when_only_tabs_close(self):
        eligible = [self.tab("w1", 2)]
        busy = [{"tab_id": "w1:t2", "reason": "agent_detected", "pane_ids": ["w1:p2"]}]
        protected = [{"tab_id": "w1:t1", "reason": "agent_detected", "pane_ids": ["w1:p1"]}]
        text = self.run_racing_cleanup([self.snapshot(), self.snapshot()], [(eligible, protected), ([], busy + protected)])
        self.assertEqual(self.calls, [])
        self.assertIn("Left 1 tab(s) open because they changed", text)

    def test_nothing_empty_closes_nothing(self):
        self.run_cleanup(self.snapshot(), [], [{"tab_id": "w1:t1", "reason": "agent_detected", "pane_ids": []}], execute=True)
        self.assertEqual(self.calls, [])

    def test_the_wrong_confirmation_does_not_close_the_workspace(self):
        args = argparse.Namespace(workspace="w1", execute=True, confirm="w2", session="esim")
        with patch.object(ORGANIZER, "session_snapshot", lambda _s=None: self.snapshot()), patch.object(
            ORGANIZER, "empty_tab_cleanup_candidates", lambda *_a: ([self.tab("w1", 1), self.tab("w1", 2)], [])
        ), patch.object(ORGANIZER, "run_json", lambda a, s: self.calls.append(a)), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "requires --confirm"):
                ORGANIZER.cleanup_empty_tabs_command(args)
        self.assertEqual(self.calls, [])


class AddTabsHerdr:
    """A live session with several tabs per workspace, where tabs and workspaces can be closed."""

    def __init__(self, layout=None, close_fails=()):
        self.layout = layout or {"w1": 3, "w2": 2}
        self.close_fails = set(close_fails)
        self.calls = []
        self.status = {}
        self.restores = {}
        self.closed = set()
        self.pane_override = {}
        self.snapshots = 0
        self.mutate_at = None
        self.mutation = None

    def snapshot(self, _session=None):
        self.snapshots += 1
        if self.mutate_at == self.snapshots and self.mutation:
            self.mutation()
        workspaces = [{"workspace_id": wid, "label": f"Label {wid}"} for wid in self.layout]
        tabs = [
            {"workspace_id": wid, "tab_id": f"{wid}:t{n}", "label": f"tab {n}"}
            for wid, count in self.layout.items()
            for n in range(1, count + 1)
            if f"{wid}:t{n}" not in self.closed
        ]
        panes = [
            {
                "tab_id": tab["tab_id"],
                "pane_id": tab["tab_id"].replace(":t", ":p"),
                "agent_status": self.status.get(tab["tab_id"], "unknown"),
            }
            for tab in tabs
        ]
        return {"workspaces": workspaces, "tabs": tabs, "panes": panes}

    def run_json(self, arguments, _session):
        self.calls.append(arguments)
        if arguments[:2] == ["tab", "close"]:
            if arguments[2] in self.close_fails:
                raise ORGANIZER.OrganizerError("close refused")
            wid = arguments[2].split(":")[0]
            self.closed.add(arguments[2])
            if not any(f"{wid}:t{n}" not in self.closed for n in range(1, self.layout[wid] + 1)):
                del self.layout[wid]
        elif arguments[:2] == ["workspace", "close"]:
            if arguments[2] in self.close_fails:
                raise ORGANIZER.OrganizerError("close refused")
            self.layout.pop(arguments[2], None)
        return {}

    def socket_call(self, _session, method, params):
        tab = params["tab_id"]
        return {"layout": {"tab_id": tab, "root": {"type": "pane", "pane_id": self.pane_override.get(tab, tab.replace(":t", ":p"))}}}

    def agent_restores(self, panes, _session, _records):
        return [dict(item, source_pane_id=pane["pane_id"]) for pane in panes for item in self.restores.get(pane["tab_id"], [])]


class AddTabsToBatchTests(unittest.TestCase):
    """Selected live tabs join a finished batch. Tabs of a workspace that already has a member merge into it."""

    BATCH = "batch-20261012-100000"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.archives = root / "archives"
        self.batches = root / "batches"
        self.archives.mkdir()
        self.batches.mkdir()
        for target, value in (("ARCHIVE_DIR", self.archives), ("BATCH_DIR", self.batches)):
            patcher = patch.object(ORGANIZER, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {}, clear=False)
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("HERDR_SESSION", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID"):
            os.environ.pop(name, None)
        self.herdr = AddTabsHerdr()
        for name, value in (
            ("session_snapshot", self.herdr.snapshot),
            ("run_json", self.herdr.run_json),
            ("socket_call", self.herdr.socket_call),
            ("agent_restore_records", self.herdr.agent_restores),
            ("manifest_records", lambda: {}),
        ):
            patcher = patch.object(ORGANIZER, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_batch(self, members=(), status="completed", session="esim"):
        manifest = {
            "version": 1,
            "batch_id": self.BATCH,
            "status": status,
            "created_at": "2026-10-12T10:00:00+00:00",
            "herdr_session": session,
            "members": [
                {"archive_id": archive_id, "workspace_id": workspace_id, "workspace_label": label}
                for archive_id, workspace_id, label in members
            ],
            "skipped": [],
        }
        (self.batches / f"{self.BATCH}.json").write_text(json.dumps(manifest))

    def write_member(self, archive_id, workspace_id, status="archived", tabs=("old:t1",), **extra):
        archive = {
            "archive_id": archive_id,
            "batch_id": self.BATCH,
            "status": status,
            "capture": {
                "workspace": {"source_workspace_id": workspace_id, "label": f"Label {workspace_id}"},
                "tabs": [
                    {
                        "source_tab_id": tab,
                        "label": tab,
                        "layout": {"root": {"type": "pane", "pane_id": f"{tab}p"}},
                        "agent_restores": [],
                    }
                    for tab in tabs
                ],
            },
            "restore": {},
        }
        archive.update(extra)
        (self.archives / f"{archive_id}.json").write_text(json.dumps(archive))

    def run_add(self, tabs, execute=True, confirm=None, session="esim", batch=None):
        batch = batch or self.BATCH
        args = argparse.Namespace(
            batch=batch, tab=list(tabs), session=session, execute=execute, confirm=(confirm or batch) if execute else None
        )
        output = io.StringIO()
        with redirect_stdout(output):
            ORGANIZER.add_tabs_to_batch_command(args)
        return output.getvalue()

    def archive(self, archive_id):
        return json.loads((self.archives / f"{archive_id}.json").read_text())

    def manifest(self):
        return json.loads((self.batches / f"{self.BATCH}.json").read_text())

    def test_a_partial_selection_becomes_a_new_member_and_only_those_tabs_close(self):
        self.write_batch()
        text = self.run_add(["w1:t1", "w1:t2"])
        self.assertEqual(self.herdr.calls, [["tab", "close", "w1:t1"], ["tab", "close", "w1:t2"]])
        [member] = self.manifest()["members"]
        archive = self.archive(member["archive_id"])
        self.assertEqual((archive["status"], archive["batch_id"], archive["from_tabs"]), ("archived", self.BATCH, True))
        self.assertEqual(member["workspace_label"], "Label w1 (selected tabs)")
        self.assertEqual(archive["capture"]["workspace"]["source_workspace_id"], "w1")
        self.assertEqual([tab["source_tab_id"] for tab in archive["capture"]["tabs"]], ["w1:t1", "w1:t2"])
        self.assertEqual(archive["tab_archives"][0]["status"], "completed")
        self.assertIn("as a new member", text)

    def test_a_preview_changes_nothing(self):
        self.write_batch()
        text = self.run_add(["w1:t1"], execute=False)
        preview = json.loads(text[: text.rindex("}") + 1])
        self.assertEqual(preview["additions"][0]["action"], "new_member")
        self.assertEqual(self.herdr.calls, [])
        self.assertEqual(self.manifest()["members"], [])
        self.assertEqual(list(self.archives.iterdir()), [])

    def test_every_tab_of_a_workspace_closes_the_workspace(self):
        self.write_batch()
        self.run_add(["w2:t1", "w2:t2"])
        self.assertEqual(self.herdr.calls, [["workspace", "close", "w2"]])
        [member] = self.manifest()["members"]
        self.assertEqual(self.archive(member["archive_id"])["status"], "archived")

    def test_the_only_workspace_keeps_its_last_tab(self):
        self.herdr.layout = {"w1": 2}
        self.write_batch()
        text = self.run_add(["w1:t1", "w1:t2"])
        self.assertEqual(self.herdr.calls, [["tab", "close", "w1:t1"]])
        self.assertIn("Kept w1:t2 open because it is the only workspace", text)

    def test_the_workspace_the_command_runs_in_keeps_the_tab_it_runs_in(self):
        os.environ.update({"HERDR_SESSION": "esim", "HERDR_PANE_ID": "w2:p2"})
        self.write_batch()
        text = self.run_add(["w2:t1", "w2:t2"])
        self.assertEqual(self.herdr.calls, [["tab", "close", "w2:t1"]])
        self.assertIn("this command runs inside the workspace", text)

    def test_a_selected_tab_the_command_runs_in_is_refused(self):
        os.environ.update({"HERDR_SESSION": "esim", "HERDR_PANE_ID": "w1:p1"})
        self.write_batch()
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "running inside selected tab"):
            self.run_add(["w1:t1"])
        self.assertEqual(self.herdr.calls, [])

    def test_tabs_merge_into_the_member_of_their_half_restored_workspace_and_reset_it_to_archived(self):
        self.write_member(
            "m1",
            "gone",
            status="restore_partial",
            tabs=("old:t1", "old:t2"),
            restore={"workspace_id": "w1", "tabs": [{"source_tab_id": "old:t1", "tab_id": "w1:t1"}]},
            restored_at="2026-10-12T09:00:00+00:00",
        )
        self.write_batch(members=[("m1", "gone", "Label gone")])
        text = self.run_add(["w1:t1", "w1:t3"])
        archive = self.archive("m1")
        self.assertEqual(archive["status"], "archived")
        self.assertEqual(archive["restore"], {})
        self.assertNotIn("layout_restore", archive)
        self.assertNotIn("restored_at", archive)
        self.assertEqual(archive["restore_history"][0]["restore"]["workspace_id"], "w1")
        self.assertEqual(archive["restore_history"][0]["status_before"], "restore_partial")
        # The rebuilt tab replaces its captured original in place. The other tab is added at the end.
        self.assertEqual([tab["source_tab_id"] for tab in archive["capture"]["tabs"]], ["w1:t1", "old:t2", "w1:t3"])
        self.assertEqual(len(self.manifest()["members"]), 1)
        self.assertIn("merged into its earlier member", text)
        self.assertIn("Warning:", text)

    def test_replacing_every_captured_tab_raises_no_duplicate_warning(self):
        self.write_member(
            "m1",
            "gone",
            status="restore_partial",
            tabs=("old:t1",),
            restore={"workspace_id": "w1", "tabs": [{"source_tab_id": "old:t1", "tab_id": "w1:t1"}]},
        )
        self.write_batch(members=[("m1", "gone", "Label gone")])
        text = self.run_add(["w1:t1"], execute=False)
        self.assertEqual(json.loads(text[: text.rindex("}") + 1])["warnings"], [])
        self.assertNotIn("Warning:", self.run_add(["w1:t1"]))
        self.assertEqual([tab["source_tab_id"] for tab in self.archive("m1")["capture"]["tabs"]], ["w1:t1"])

    def test_a_layout_only_workspace_merges_back_and_clears_the_open_layout_record(self):
        self.write_member("m1", "gone", status="archived", layout_restore={"workspace_id": "w1", "tabs": []})
        self.write_batch(members=[("m1", "gone", "Label gone")])
        self.run_add(["w1:t1"])
        archive = self.archive("m1")
        self.assertEqual(archive["status"], "archived")
        self.assertNotIn("layout_restore", archive)
        self.assertEqual(archive["restore_history"][0]["layout_restore"]["workspace_id"], "w1")

    def test_a_member_is_matched_by_original_workspace_id_but_never_by_label(self):
        self.write_member("m1", "w1", tabs=("w1:old",))
        self.write_member("m2", "other")
        self.write_batch(members=[("m1", "w1", "Label w1"), ("m2", "other", "Label w2")])
        self.run_add(["w1:t1"])
        self.assertEqual([tab["source_tab_id"] for tab in self.archive("m1")["capture"]["tabs"]], ["w1:old", "w1:t1"])
        # m2 is named like workspace w2 but has another id, so w2 gets its own new member.
        self.run_add(["w2:t1"])
        self.assertEqual(len(self.archive("m2")["capture"]["tabs"]), 1)
        self.assertEqual(len(self.manifest()["members"]), 3)

    def test_two_members_for_one_workspace_stop_the_run(self):
        self.write_member("m1", "gone", restore={"workspace_id": "w1"}, status="restore_partial")
        self.write_member("m2", "gone2", restore={"workspace_id": "w1"}, status="restore_partial")
        self.write_batch(members=[("m1", "gone", "a"), ("m2", "gone2", "b")])
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "matches more than one member"):
            self.run_add(["w1:t1"])
        self.assertEqual(self.herdr.calls, [])

    def test_a_restored_workspace_is_not_in_the_group_so_its_tabs_make_a_new_member(self):
        self.write_member(
            "m1", "gone", status="resumed", tabs=("old:t1",),
            restore={"workspace_id": "w1", "tabs": [{"source_tab_id": "old:t1", "tab_id": "w1:t1"}]},
        )
        self.write_batch(members=[("m1", "gone", "Label gone")])
        before = self.archive("m1")
        text = self.run_add(["w1:t1"])
        self.assertEqual(self.archive("m1"), before, "the restored archive is not touched")
        [member] = self.manifest()["members"]
        self.assertNotEqual(member["archive_id"], "m1")
        self.assertIn("as a new member", text)
        self.assertNotIn("Warning:", text)

    def test_no_batch_argument_adds_to_the_one_group_of_the_session(self):
        self.write_batch()
        args = ORGANIZER.parser().parse_args(["--session", "esim", "add-tabs-to-batch", "--tab", "w1:t1", "--execute", "--confirm", self.BATCH])
        with redirect_stdout(io.StringIO()), patch.object(ORGANIZER, "STATE_DIR", Path(self.temporary.name)):
            args.func(args)
        [member] = self.manifest()["members"]
        self.assertEqual(self.archive(member["archive_id"])["batch_id"], self.BATCH)

    def run_add_new_group(self, tabs, execute=True, confirm="esim"):
        args = argparse.Namespace(batch=None, tab=list(tabs), session="esim", execute=execute, confirm=confirm if execute else None)
        output = io.StringIO()
        with redirect_stdout(output):
            ORGANIZER.add_tabs_to_batch_command(args)
        return output.getvalue()

    def test_a_session_without_a_group_gets_one_when_tabs_are_added(self):
        text = self.run_add_new_group(["w1:t1"], execute=False)
        preview = json.loads(text[: text.rindex("}") + 1])
        self.assertEqual((preview["creates_group"], preview["batch_id"]), (True, None))
        self.assertIn("a new archive group for session 'esim'", text)
        self.assertEqual(list(self.batches.iterdir()) + list(self.archives.iterdir()), [], "a preview writes nothing")
        for confirm in (None, "other", "batch-20261012-100000"):
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "requires --confirm 'esim'"):
                self.run_add_new_group(["w1:t1"], confirm=confirm)
        self.assertEqual(self.herdr.calls, [])
        text = self.run_add_new_group(["w1:t1"])
        self.assertIn("Created the archive group", text)
        [path] = list(self.batches.iterdir())
        group = json.loads(path.read_text())
        self.assertEqual((group["herdr_session"], group["status"]), ("esim", "completed"))
        [member] = group["members"]
        archive = self.archive(member["archive_id"])
        self.assertEqual((archive["status"], archive["batch_id"]), ("archived", group["batch_id"]))
        # The next run finds that group instead of making another.
        self.run_add_new_group(["w2:t1", "w2:t2"], confirm=group["batch_id"])
        self.assertEqual(len(list(self.batches.iterdir())), 1)

    def test_a_first_add_that_changed_after_capture_leaves_no_empty_group_behind(self):
        self.herdr.mutate_at = 2
        self.herdr.mutation = lambda: self.herdr.status.update({"w1:t1": "working"})
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "now has a working or blocked agent"):
            self.run_add_new_group(["w1:t1"])
        self.assertEqual(list(self.batches.iterdir()) + list(self.archives.iterdir()), [])
        self.assertEqual(self.herdr.calls, [])

    def test_an_interrupt_before_any_tab_closes_puts_the_group_and_archive_back(self):
        self.write_member("m1", "w1", tabs=("w1:t1",))
        self.write_batch(members=[("m1", "w1", "Label w1")])
        files = lambda: {path.name: json.loads(path.read_text()) for path in sorted([*self.batches.iterdir(), *self.archives.iterdir()])}
        before = files()

        def interrupt():
            raise KeyboardInterrupt

        self.herdr.mutate_at = 2
        self.herdr.mutation = interrupt
        with self.assertRaises(KeyboardInterrupt):
            self.run_add(["w1:t2"])
        self.assertEqual(files(), before, "no prepared archive is left behind for a command nobody would finish")
        self.assertEqual(self.herdr.calls, [])

    def test_naming_a_missing_group_is_still_an_error(self):
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "was not found"):
            self.run_add(["w1:t1"], batch="batch-20990101-000000")

    def test_a_member_from_another_batch_is_never_merged(self):
        self.write_member("m1", "w1", batch_id="batch-20260101-000000")
        self.write_batch(members=[("m1", "w1", "Label w1")])
        self.run_add(["w1:t1"])
        self.assertEqual(len(self.manifest()["members"]), 2)
        self.assertEqual(len(self.archive("m1")["capture"]["tabs"]), 1)

    def test_an_unfinished_batch_or_another_session_is_refused(self):
        for status in ("in_progress", "interrupted"):
            self.write_batch(status=status)
            with self.assertRaisesRegex(ORGANIZER.OrganizerError, "finished batch"):
                self.run_add(["w1:t1"])
        self.write_batch(session="other")
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "captured from session"):
            self.run_add(["w1:t1"])
        self.assertEqual(self.herdr.calls, [])

    def test_working_agents_and_unverified_sessions_are_refused_without_an_override(self):
        self.write_batch()
        self.herdr.status["w1:t1"] = "working"
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "working or blocked"):
            self.run_add(["w1:t1"])
        self.herdr.status.clear()
        self.herdr.restores["w1:t2"] = [dict(UNVERIFIED)]
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "verified resumable session"):
            self.run_add(["w1:t2"])
        self.assertEqual(self.herdr.calls, [])

    def test_a_tab_the_archive_already_holds_is_refused(self):
        self.write_member("m1", "w1", tabs=("w1:t1",))
        self.write_batch(members=[("m1", "w1", "Label w1")])
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "already contains"):
            self.run_add(["w1:t1"])

    def test_the_wrong_confirmation_changes_nothing(self):
        self.write_batch()
        args = argparse.Namespace(batch=self.BATCH, tab=["w1:t1"], session="esim", execute=True, confirm="batch-20260101-000000")
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "requires --confirm"):
            ORGANIZER.add_tabs_to_batch_command(args)
        self.assertEqual(self.herdr.calls, [])

    def test_a_close_that_fails_leaves_the_archive_close_failed_and_names_the_open_tab(self):
        self.herdr.close_fails = {"w1:t2"}
        self.write_batch()
        with self.assertRaises(ORGANIZER.OrganizerError):
            self.run_add(["w1:t1", "w1:t2"])
        [member] = self.manifest()["members"]
        archive = self.archive(member["archive_id"])
        self.assertEqual(archive["status"], "close_failed")
        self.assertIn("w1:t2", archive["error"])
        self.assertEqual(archive["tab_archives"][0]["status"], "close_partial")

    def test_an_interrupt_after_every_tab_closed_still_settles_as_archived(self):
        self.write_batch()
        original = self.herdr.run_json

        def run_json(arguments, session):
            original(arguments, session)
            raise KeyboardInterrupt

        with patch.object(ORGANIZER, "run_json", run_json), self.assertRaises(KeyboardInterrupt):
            self.run_add(["w1:t1"])
        [member] = self.manifest()["members"]
        self.assertEqual(self.archive(member["archive_id"])["status"], "archived")

    def test_the_executing_command_waits_for_the_shared_run_lock_and_a_preview_does_not(self):
        self.write_batch()
        with patch.object(ORGANIZER, "STATE_DIR", Path(self.temporary.name)):
            args = ORGANIZER.parser().parse_args(["--session", "esim", "add-tabs-to-batch", "--batch", self.BATCH, "--tab", "w1:t1"])
            with ORGANIZER.batch_run_lock("archive-all"):
                with redirect_stdout(io.StringIO()):
                    args.func(args)
                self.assertEqual(self.herdr.calls, [], "a preview takes no lock and closes nothing")
                args = ORGANIZER.parser().parse_args(
                    ["--session", "esim", "add-tabs-to-batch", "--batch", self.BATCH, "--tab", "w1:t1", "--execute", "--confirm", self.BATCH]
                )
                with self.assertRaisesRegex(ORGANIZER.OrganizerError, "already in progress"):
                    args.func(args)
        self.assertEqual(self.herdr.calls, [])

    def tree_before(self):
        """Every file in the archive and batch folders, so a refused run can be shown to have changed none of them."""
        return {path.name: json.loads(path.read_text()) for folder in (self.archives, self.batches) for path in sorted(folder.iterdir())}

    def test_a_tab_added_to_the_workspace_after_planning_stops_the_workspace_close(self):
        self.write_batch()
        before = self.tree_before()
        self.herdr.mutate_at = 2  # the re-read right before the close
        self.herdr.mutation = lambda: self.herdr.layout.update({"w2": 3})
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, r"changed after it was captured.*w2:t3.*Nothing was closed"):
            self.run_add(["w2:t1", "w2:t2"])
        self.assertEqual([call for call in self.herdr.calls if call[1] == "close"], [])
        self.assertEqual(self.tree_before(), before, "the new archive and the manifest entry are undone")
        # The live workspace is untouched, so the same command works once the extra tab is dealt with.
        self.herdr.mutation = None
        self.herdr.layout["w2"] = 2
        self.run_add(["w2:t1", "w2:t2"])
        self.assertEqual(self.herdr.calls, [["workspace", "close", "w2"]])

    def test_a_pane_replaced_after_the_capture_undoes_a_merge_exactly(self):
        self.write_member("m1", "w1", status="restore_partial", tabs=("w1:old",), restore={"workspace_id": "w1", "tabs": []})
        self.write_batch(members=[("m1", "w1", "Label w1")])
        before = self.tree_before()
        self.herdr.mutate_at = 2
        self.herdr.mutation = lambda: self.herdr.pane_override.update({"w1:t1": "w1:p77"})
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "w1:t1 has a different layout"):
            self.run_add(["w1:t1"])
        self.assertEqual(self.herdr.calls, [])
        self.assertEqual(self.tree_before(), before, "the member keeps its old status, restore record and tabs")

    def test_an_agent_that_started_after_the_capture_stops_the_close(self):
        self.write_batch()
        self.herdr.mutate_at = 2
        self.herdr.mutation = lambda: self.herdr.status.update({"w1:t1": "working"})
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "now has a working or blocked agent"):
            self.run_add(["w1:t1"])
        self.assertEqual(self.herdr.calls, [])
        self.assertEqual(list(self.archives.iterdir()), [])

    def test_a_tab_that_closed_by_itself_is_not_closed_again(self):
        self.write_batch()
        self.herdr.mutate_at = 2
        self.herdr.mutation = lambda: self.herdr.closed.add("w1:t2")
        self.run_add(["w1:t1", "w1:t2"])
        self.assertEqual(self.herdr.calls, [["tab", "close", "w1:t1"]])
        [member] = self.manifest()["members"]
        self.assertEqual(self.archive(member["archive_id"])["status"], "archived")

    def finish(self, archive_id, execute=True, confirm=None, session="esim"):
        args = argparse.Namespace(archive=archive_id, session=session, execute=execute, confirm=(confirm or archive_id) if execute else None)
        output = io.StringIO()
        with redirect_stdout(output):
            ORGANIZER.finish_tab_add_command(args)
        return output.getvalue()

    def stranded(self):
        """A run whose second tab refused to close, leaving a close_failed archive with the first tab already closed."""
        self.herdr.close_fails = {"w1:t2"}
        self.write_batch()
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "finish-tab-add --archive"):
            self.run_add(["w1:t1", "w1:t2"])
        [member] = self.manifest()["members"]
        self.assertEqual(self.archive(member["archive_id"])["status"], "close_failed")
        self.herdr.close_fails = set()
        return member["archive_id"]

    def restore_args(self, archive_id):
        return argparse.Namespace(archive=archive_id, execute=False, confirm=None, force=False, resume_agents=False, allow_unresumable_agents=False, session="esim")

    def test_a_partial_close_records_each_outcome_and_names_the_recovery_command(self):
        archive_id = self.stranded()
        archive = self.archive(archive_id)
        operation = archive["tab_archives"][0]
        self.assertEqual(operation["close_outcomes"], [{"source_tab_id": "w1:t1", "status": "closed"}])
        self.assertEqual(operation["still_open"], ["w1:t2"])
        self.assertIn(f"finish-tab-add --archive {archive_id}", archive["error"])
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "cannot be restored"), redirect_stdout(io.StringIO()):
            ORGANIZER.restore_command(self.restore_args(archive_id))

    def test_finish_tab_add_closes_only_the_still_open_tab_and_makes_the_archive_restorable(self):
        archive_id = self.stranded()
        self.herdr.calls.clear()
        text = self.finish(archive_id, execute=False)
        preview = json.loads(text[: text.rindex("}") + 1])
        self.assertEqual((preview["tabs_still_open"], preview["tabs_already_closed"], preview["problems"]), (["w1:t2"], ["w1:t1"], []))
        self.assertEqual(self.herdr.calls, [], "the preview closes nothing")
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "requires --confirm"):
            self.finish(archive_id, confirm="other")
        self.assertEqual(self.herdr.calls, [])
        self.finish(archive_id)
        self.assertEqual(self.herdr.calls, [["tab", "close", "w1:t2"]], "the tab that already closed is not closed again")
        archive = self.archive(archive_id)
        self.assertEqual(archive["status"], "archived")
        self.assertNotIn("error", archive)
        self.assertEqual(archive["tab_archives"][0]["status"], "completed")
        with redirect_stdout(io.StringIO()):
            self.assertEqual(ORGANIZER.restore_command(self.restore_args(archive_id)), "preview")
        self.assertEqual(ORGANIZER.batch_summary(self.manifest())["counts"]["archived"], 1)

    def test_finish_tab_add_refuses_a_still_open_tab_that_changed_since_the_capture(self):
        archive_id = self.stranded()
        self.herdr.pane_override["w1:t2"] = "w1:p55"
        self.herdr.calls.clear()
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "w1:t2 has a different layout.*Nothing was closed"):
            self.finish(archive_id)
        self.assertEqual(self.herdr.calls, [])
        self.assertEqual(self.archive(archive_id)["status"], "close_failed")

    def test_finish_tab_add_settles_an_archive_whose_tabs_were_all_closed_by_hand(self):
        archive_id = self.stranded()
        self.herdr.closed.add("w1:t2")
        self.herdr.calls.clear()
        self.finish(archive_id)
        self.assertEqual(self.herdr.calls, [])
        self.assertEqual(self.archive(archive_id)["status"], "archived")

    def test_finish_tab_add_retries_a_workspace_close_that_failed(self):
        self.herdr.close_fails = {"w2"}
        self.write_batch()
        with self.assertRaises(ORGANIZER.OrganizerError):
            self.run_add(["w2:t1", "w2:t2"])
        [member] = self.manifest()["members"]
        self.assertEqual(self.archive(member["archive_id"])["status"], "close_failed")
        self.herdr.close_fails = set()
        self.herdr.calls.clear()
        self.finish(member["archive_id"])
        self.assertEqual(self.herdr.calls, [["workspace", "close", "w2"]])
        self.assertEqual(self.archive(member["archive_id"])["status"], "archived")

    def test_finish_tab_add_refuses_a_workspace_that_gained_a_tab(self):
        self.herdr.close_fails = {"w2"}
        self.write_batch()
        with self.assertRaises(ORGANIZER.OrganizerError):
            self.run_add(["w2:t1", "w2:t2"])
        [member] = self.manifest()["members"]
        self.herdr.close_fails = set()
        self.herdr.layout["w2"] = 3
        self.herdr.calls.clear()
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "now has other tab"):
            self.finish(member["archive_id"])
        self.assertEqual(self.herdr.calls, [])

    def test_finish_tab_add_refuses_an_archive_with_nothing_to_finish(self):
        self.write_member("m1", "w1")
        with self.assertRaisesRegex(ORGANIZER.OrganizerError, "no unfinished tab add"):
            self.finish("m1", execute=False)

    def test_a_new_member_counts_as_archived_in_the_batch_summary(self):
        self.write_batch()
        self.run_add(["w1:t1"])
        self.assertEqual(ORGANIZER.batch_summary(self.manifest())["counts"]["archived"], 1)


if __name__ == "__main__":
    unittest.main()
