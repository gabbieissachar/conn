#!/usr/bin/env python3
"""Unit tests for workspace-organizer.py that do not require a Herdr server."""

import importlib.util
import unittest
from pathlib import Path


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
                        "agent_restores": [{"restore_status": "resumable"}],
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


if __name__ == "__main__":
    unittest.main()
