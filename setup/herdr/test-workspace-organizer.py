#!/usr/bin/env python3
"""Unit tests for workspace-organizer.py that do not require a Herdr server."""

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("workspace-organizer.py")
SPEC = importlib.util.spec_from_file_location("workspace_organizer", MODULE_PATH)
assert SPEC and SPEC.loader
ORGANIZER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ORGANIZER)


class WorkspaceOrganizerTests(unittest.TestCase):
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

    def test_active_agents_uses_herdr_tab_id_field(self):
        snapshot = {
            "tabs": [{"workspace_id": "w1", "tab_id": "w1:t1"}],
            "panes": [
                {"tab_id": "w1:t1", "agent_status": "working"},
                {"tab_id": "w1:t2", "agent_status": "working"},
            ],
        }
        self.assertEqual(len(ORGANIZER.active_agents(snapshot, "w1")), 1)

    def test_native_agent_metadata_is_not_treated_as_a_cli_resume_id(self):
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
        self.assertEqual(outcomes, [{"source_pane_id": "old-pane", "pane_id": "new-pane", "status": "sent"}])
        run_command.assert_called_once_with(["pane", "run", "new-pane", "resume-command"], "test")


if __name__ == "__main__":
    unittest.main()
