#!/usr/bin/env python3
"""Unit tests for workspace-organizer.py that do not require a Herdr server."""

import argparse
import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("workspace-organizer.py")
SPEC = importlib.util.spec_from_file_location("workspace_organizer", MODULE_PATH)
assert SPEC and SPEC.loader
ORGANIZER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ORGANIZER)

REGISTRY_PATH = Path(__file__).with_name("agent-session-registry.py")
REGISTRY_SPEC = importlib.util.spec_from_file_location("agent_session_registry", REGISTRY_PATH)
assert REGISTRY_SPEC and REGISTRY_SPEC.loader
REGISTRY = importlib.util.module_from_spec(REGISTRY_SPEC)
sys.modules[REGISTRY_SPEC.name] = REGISTRY
REGISTRY_SPEC.loader.exec_module(REGISTRY)


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
    def snapshot(self, *, pane_agent=None, pane_status=None, cwd=None):
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
            "workspaces": [{"workspace_id": "w1", "label": "One", "cwd": path}],
            "tabs": [{"workspace_id": "w1", "tab_id": "w1:t1", "label": "One tab"}],
            "panes": [pane],
        }

    @staticmethod
    def layout(tab_id="w1:t1", pane_id="w1:p1"):
        return {"tab_id": tab_id, "root": {"type": "pane", "pane_id": pane_id}}

    def source_workspace(self, session="lab", workspace_id="w1", *, agent_restore=None, label="One"):
        agent_restore = agent_restore or {"source_pane_id": "w1:p1", "restore_status": "shell_only"}
        layout = self.layout(f"{workspace_id}:t1", f"{workspace_id}:p1")
        tab = {
            "identity": ORGANIZER.recovery_identity(session, workspace_id, f"{workspace_id}:t1"),
            "label": "One tab",
            "index": 0,
            "layout": layout,
            "layout_shape_fingerprint": ORGANIZER.layout_shape_fingerprint(layout),
            "panes": [
                {
                    "identity": ORGANIZER.recovery_identity(session, workspace_id, f"{workspace_id}:t1", f"{workspace_id}:p1"),
                    "agent_restore": agent_restore,
                }
            ],
        }
        source = {
            "identity": ORGANIZER.recovery_identity(session, workspace_id),
            "label": label,
            "cwd": tempfile.gettempdir(),
            "tabs": [tab],
        }
        source["fingerprint"] = ORGANIZER.recovery_workspace_fingerprint(source)
        return source

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
            ):
                self.assertEqual(REGISTRY.scan(args), 0)
            records = REGISTRY.read_manifest(manifest)["panes"]
        self.assertEqual({(row["herdr_session"], row["pane_id"]) for row in records}, {("Misc", "w1:p1"), ("esim", "w1:p1")})

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
            self.assertFalse((Path(temporary) / "journals" / f"{bundle_id}.json").exists())
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
        busy, failure = ORGANIZER.recovery_pane_classification(
            {"workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1", "agent": "codex", "agent_status": "working"}, {}, "lab", set()
        )
        unresolved, unresolved_failure = ORGANIZER.recovery_pane_classification(
            {"workspace_id": "w1", "tab_id": "w1:t1", "pane_id": "w1:p1", "agent": "codex", "agent_status": "idle"}, {}, "lab", set()
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
        self.assertEqual((unresolved["classification"], unresolved_failure["kind"]), ("unresolved_supported_agent", "unresolved_supported_agent"))
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
                    model["panes"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "pane_id": "new-w:p1"}]
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
            model["panes"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "pane_id": "new-w:p1"}]
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
            model["panes"] = [{"workspace_id": "new-w", "tab_id": "new-w:t1", "pane_id": "new-w:p1"}]
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


if __name__ == "__main__":
    unittest.main()
