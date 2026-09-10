#!/usr/bin/env python3
"""Unit tests for workspace-organizer.py that do not require a Herdr server."""

import importlib.util
import json
import tempfile
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


if __name__ == "__main__":
    unittest.main()
