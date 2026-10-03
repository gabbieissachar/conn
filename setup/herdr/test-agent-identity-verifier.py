"""Fixture tests for the read-only Herdr identity verifier."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("agent_identity_verifier", ROOT / "agent_identity_verifier.py")
assert SPEC and SPEC.loader
VERIFIER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = VERIFIER
SPEC.loader.exec_module(VERIFIER)

REGISTRY_SPEC = importlib.util.spec_from_file_location("agent_session_registry", ROOT / "agent-session-registry.py")
assert REGISTRY_SPEC and REGISTRY_SPEC.loader
REGISTRY = importlib.util.module_from_spec(REGISTRY_SPEC)
sys.modules[REGISTRY_SPEC.name] = REGISTRY
REGISTRY_SPEC.loader.exec_module(REGISTRY)


SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


class Adapter:
    def __init__(self, handles=(), start="start-1"):
        self._handles = list(handles)
        self._start = start

    def handles(self, pid):
        return list(self._handles)

    def process_start(self, pid):
        return self._start


def pane(client="codex", session_id=None, *, cwd="/workspace/project", status="idle", pid=41, start="start-1", argv=None):
    process = {"pid": pid, "argv": argv or [client], "process_start": start}
    value = {
        "herdr_session": "esim",
        "pane_id": "w1:p1",
        "workspace_id": "w1",
        "workspace_label": "Workspace",
        "tab_id": "w1:t1",
        "tab_label": "Tab",
        "label": "Agent",
        "agent": client,
        "agent_status": status,
        "foreground_cwd": cwd,
        "foreground_processes": [process],
    }
    if session_id:
        value["agent_session"] = {"agent": client, "source": "hook", "value": session_id}
    return value


def stores_for(temporary, *, client="codex", ids=(SESSION_A,), cwd="/workspace/project"):
    if client == "codex":
        home = Path(temporary) / "codex"
        rollout = home / "sessions" / "2026" / "10" / "01"
        rollout.mkdir(parents=True)
        for session_id in ids:
            (rollout / f"rollout-{session_id}.jsonl").write_text(
                json.dumps({"type": "session_meta", "payload": {"session_id": session_id, "cwd": cwd}}) + "\n"
            )
        return {"codex": VERIFIER.CodexStore(home)}
    home = Path(temporary) / "claude"
    project = home / "projects" / "encoded"
    project.mkdir(parents=True)
    for session_id in ids:
        (project / f"{session_id}.jsonl").write_text(
            json.dumps({"type": "queue-operation", "data": "ignored"}) + "\n"
            + json.dumps({"sessionId": session_id, "cwd": cwd, "type": "user"}) + "\n"
        )
    return {"claude": VERIFIER.ClaudeStore(home)}


class VerifierTests(unittest.TestCase):
    def test_argv_only_from_selected_foreground_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            value = pane(argv=["codex"])
            value["foreground_pid"] = 41
            value["foreground_processes"] = [
                {"pid": 41, "argv": ["codex"], "process_start": "start-1"},
                {"pid": 42, "argv": ["codex", "resume", SESSION_A], "process_start": "start-2"},
            ]
            result = VERIFIER.verify_pane(value, stores=stores, adapter=Adapter())
        self.assertNotEqual(result["status"], "argv_verified")

    def test_native_report_requires_matching_agent_and_current_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            value = pane("codex", SESSION_A, start="old")
            value["agent_session"]["agent"] = "claude"
            mismatched = VERIFIER.verify_pane(value, stores=stores, adapter=Adapter(start="old"))
            value["agent_session"]["agent"] = "codex"
            stale = VERIFIER.verify_pane(value, stores=stores, adapter=Adapter(start="new"))
        self.assertNotEqual(mismatched["status"], "native_verified")
        self.assertNotEqual(stale["status"], "native_verified")

    def test_stale_native_object_on_codex_pane_cannot_verify_claude(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            value = pane("codex", SESSION_A)
            value["agent_session"] = {"agent": "claude", "source": "hook", "value": SESSION_A}
            result = VERIFIER.verify_pane(value, stores=stores, adapter=Adapter())
        self.assertNotEqual(result["status"], "native_verified")

    def test_command_snapshot_carries_native_metadata_to_verifier(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            source = REGISTRY.PaneInfo(
                "esim", "w1:p1", "w1", "w1:t1", "/workspace/project", "/workspace/project",
                "codex", "idle", "Agent", "Workspace", "Tab", {"agent": "codex", "source": "hook", "value": SESSION_A},
            )
            process_info = {"result": {"process_info": {"foreground_processes": [{"pid": 41, "argv": ["codex"], "process_start": "start-1"}]}}}
            args = SimpleNamespace(herdr_session="esim", client="codex", apply=False, show_session_ids=False, manifest="", diagnostic_session_paths=False)
            output = io.StringIO()
            with redirect_stdout(output), patch.object(REGISTRY, "snapshot_panes", return_value=[source]), patch.object(
                REGISTRY, "run_json", return_value=process_info
            ), patch.object(REGISTRY, "verify_pane", side_effect=lambda value: VERIFIER.verify_pane(value, stores=stores, adapter=Adapter())):
                self.assertEqual(REGISTRY.verify_identity(args), 0)
        self.assertIn("native_verified", output.getvalue())
        self.assertIn("exact=1", output.getvalue())

    def test_claude_native_id_is_valid_only_when_store_exists_and_cwd_matches(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, client="claude", ids=(SESSION_A,))
            valid = pane("claude", SESSION_A)
            self.assertEqual(VERIFIER.verify_pane(valid, stores=stores, adapter=Adapter())["status"], "native_verified")
            invalid = pane("claude", SESSION_B)
            self.assertEqual(VERIFIER.verify_pane(invalid, stores=stores, adapter=Adapter())["status"], "unresolved")

    def test_claude_native_hook_source_is_usable_but_display_value_is_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, client="claude", ids=(SESSION_A,))
            valid = pane("claude", SESSION_A)
            valid["agent_session"]["source"] = "herdr:claude"
            display_only = pane("claude", "herdr:claude")
            self.assertEqual(VERIFIER.verify_pane(valid, stores=stores, adapter=Adapter())["status"], "native_verified")
            self.assertNotEqual(VERIFIER.verify_pane(display_only, stores=stores, adapter=Adapter())["status"], "native_verified")

    def test_codex_native_missing_from_store_is_unresolved(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            result = VERIFIER.verify_pane(pane("codex", SESSION_B), stores=stores, adapter=Adapter())
        self.assertEqual(result["status"], "unresolved")

    def test_codex_native_hook_value_is_store_verified(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            native = pane("codex", SESSION_A)
            native["agent_session"]["source"] = "herdr:codex"
            result = VERIFIER.verify_pane(native, stores=stores, adapter=Adapter())
        self.assertEqual(result["status"], "native_verified")

    def test_exact_argv_is_verified(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            result = VERIFIER.verify_pane(pane(argv=["codex", "resume", SESSION_A]), stores=stores, adapter=Adapter())
        self.assertEqual(result["status"], "argv_verified")
        self.assertEqual(result["candidate"].session_id, SESSION_A)

    def test_pid_reuse_start_marker_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, client="claude")
            claude_home = stores["claude"].home
            (claude_home / "sessions").mkdir()
            (claude_home / "sessions" / "41.json").write_text(
                json.dumps({"sessionId": SESSION_A, "cwd": "/workspace/project", "procStart": "old"})
            )
            result = VERIFIER.verify_pane(pane("claude", pid=41, start="new"), stores=stores, adapter=Adapter(start="new"))
        self.assertEqual(result["status"], "unresolved")

    def test_one_open_handle_is_verified(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            path = stores["codex"].records()[0].path
            result = VERIFIER.verify_pane(pane(), stores=stores, adapter=Adapter([VERIFIER.OpenHandle(path, 41)]))
        self.assertEqual(result["status"], "handle_verified")

    def test_multiple_open_handles_are_unresolved(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            path = stores["codex"].records()[0].path
            adapter = Adapter([VERIFIER.OpenHandle(path, 41), VERIFIER.OpenHandle(path, 41)])
            result = VERIFIER.verify_pane(pane(), stores=stores, adapter=adapter)
        self.assertEqual(result["status"], "unresolved")

    def test_helper_owned_handle_is_unresolved(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            path = stores["codex"].records()[0].path
            adapter = Adapter([VERIFIER.OpenHandle(path, 99, helper_owned=True)])
            result = VERIFIER.verify_pane(pane(), stores=stores, adapter=adapter)
        self.assertEqual(result["status"], "unresolved")

    def test_many_sessions_sharing_cwd_are_ambiguous(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, ids=(SESSION_A, SESSION_B))
            result = VERIFIER.verify_pane(pane(), stores=stores, adapter=Adapter())
        self.assertEqual(result["status"], "candidate_ambiguous")
        self.assertEqual(result["candidate_count"], 2)

    def test_exact_argv_and_native_agree_despite_cwd_siblings(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, ids=(SESSION_A, SESSION_B))
            value = pane("codex", SESSION_A, argv=["codex", "resume", SESSION_A])
            result = VERIFIER.verify_pane(value, stores=stores, adapter=Adapter())
        self.assertEqual(result["status"], "native_verified")
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(result["exact_count"], 1)

    def test_open_handle_verifies_despite_cwd_siblings(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, ids=(SESSION_A, SESSION_B))
            path = next(record.path for record in stores["codex"].records() if record.session_id == SESSION_A)
            result = VERIFIER.verify_pane(
                pane(), stores=stores, adapter=Adapter([VERIFIER.OpenHandle(path, 41)])
            )
        self.assertEqual(result["status"], "handle_verified")
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(result["exact_count"], 1)

    def test_native_verifies_alone_despite_cwd_siblings(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, ids=(SESSION_A, SESSION_B))
            result = VERIFIER.verify_pane(pane("codex", SESSION_A), stores=stores, adapter=Adapter())
        self.assertEqual(result["status"], "native_verified")
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(result["exact_count"], 1)

    def test_argv_and_native_disagree_are_ambiguous(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, ids=(SESSION_A, SESSION_B))
            value = pane("codex", SESSION_A, argv=["codex", "resume", SESSION_B])
            result = VERIFIER.verify_pane(value, stores=stores, adapter=Adapter())
        self.assertEqual(result["status"], "candidate_ambiguous")
        self.assertEqual(result["exact_count"], 2)

    def test_two_distinct_exact_sources_are_ambiguous(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, ids=(SESSION_A, SESSION_B))
            path = next(record.path for record in stores["codex"].records() if record.session_id == SESSION_A)
            value = pane("codex", argv=["codex", "resume", SESSION_B])
            result = VERIFIER.verify_pane(
                value, stores=stores, adapter=Adapter([VERIFIER.OpenHandle(path, 41)])
            )
        self.assertEqual(result["status"], "candidate_ambiguous")
        self.assertEqual(result["exact_count"], 2)

    def test_one_cwd_candidate_without_exact_evidence_stays_unresolved(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            result = VERIFIER.verify_pane(pane(), stores=stores, adapter=Adapter())
        self.assertEqual(result["status"], "unresolved")
        self.assertEqual(result["candidate_count"], 1)
        self.assertEqual(result["exact_count"], 0)

    def test_busy_pane_is_unresolved(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            result = VERIFIER.verify_pane(pane(status="working", argv=["codex", "resume", SESSION_A]), stores=stores, adapter=Adapter())
        self.assertEqual(result["status"], "unresolved")
        self.assertIn("idle or done", result["hint"])

    def test_report_has_no_ids_paths_commands_or_transcript(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary)
            result = VERIFIER.verify_pane(pane(argv=["codex", "resume", SESSION_A]), stores=stores, adapter=Adapter())
            output = json.dumps(VERIFIER.result_report(result))
        self.assertNotIn(SESSION_A, output)
        self.assertNotIn("resume", output)
        self.assertNotIn("/workspace/project", output)
        self.assertNotIn("ignored", output)

    def test_report_only_command_does_not_write_manifest(self):
        pane_value = pane(argv=["codex", "resume", SESSION_A])
        args = SimpleNamespace(herdr_session="esim", client=None, apply=False, show_session_ids=False, manifest="")
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary, redirect_stdout(output), patch.object(REGISTRY, "verifier_panes", return_value=[pane_value]), patch.object(
            REGISTRY, "verify_pane", return_value=VERIFIER.verify_pane(pane_value, stores=stores_for(temporary), adapter=Adapter())
        ), patch.object(REGISTRY, "manifest_path", return_value=Path(temporary) / "manifest.json"):
            self.assertEqual(REGISTRY.verify_identity(args), 0)
            self.assertFalse((Path(temporary) / "manifest.json").exists())
        self.assertIn("report-only", output.getvalue())
        self.assertNotIn(SESSION_A, output.getvalue())

    def test_verifier_summary_counts_classifications_and_redacts_private_data(self):
        results = [
            (pane(), {"status": "native_verified"}),
            (pane(), {"status": "argv_verified"}),
            (pane(), {"status": "handle_verified"}),
            (pane(), {"status": "pid_record_verified"}),
            (pane(), {"status": "candidate_ambiguous"}),
            (pane(), {"status": "unresolved", "candidate": VERIFIER.IdentityCandidate("codex", SESSION_A, ("argv_exact",), 41, "start-1", "/workspace/project", "fixture", 1, "now")}),
        ]
        output = REGISTRY.verifier_summary(results, "esim")
        self.assertLessEqual(len(output.splitlines()), 8)
        self.assertIn("total panes: 6", output)
        self.assertIn("native 1; argv 1; handle 1; pid record 1", output)
        self.assertIn("ambiguous: 1; unresolved: 1", output)
        self.assertIn("safe to apply with --apply: 4; manual: 2", output)
        self.assertIn("herdr-agent-verify-identity --herdr-session esim --apply", output)
        self.assertNotIn(SESSION_A, output)
        self.assertNotIn("/workspace/project", output)
        self.assertNotIn("resume", output)

    def test_verifier_summary_only_prints_only_summary(self):
        pane_value = pane(argv=["codex", "resume", SESSION_A])
        args = SimpleNamespace(
            herdr_session="esim", client=None, apply=False, show_session_ids=False,
            manifest="", diagnostic_session_paths=False, summary_only=True,
        )
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary, redirect_stdout(output), patch.object(
            REGISTRY, "verifier_panes", return_value=[pane_value]
        ), patch.object(
            REGISTRY, "verify_pane", return_value=VERIFIER.verify_pane(
                pane_value, stores=stores_for(temporary), adapter=Adapter()
            )
        ):
            self.assertEqual(REGISTRY.verify_identity(args), 0)
        rendered = output.getvalue()
        self.assertTrue(rendered.startswith("Summary:\n"))
        self.assertNotIn("report-only", rendered)
        self.assertNotIn(SESSION_A, rendered)
        self.assertNotIn("/workspace/project", rendered)
        self.assertNotIn("resume", rendered)

    def test_apply_final_snapshot_discards_first_pane_changed_while_later_pane_runs(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            state.mkdir(mode=0o700)
            state.chmod(0o700)
            manifest = state / "manifest.json"
            stores = stores_for(temporary, ids=(SESSION_A, SESSION_B), cwd="/workspace/project-1")
            second_rollout = next(path for path in stores["codex"].sessions_dir.rglob(f"*{SESSION_B}.jsonl"))
            second_rollout.write_text(json.dumps({"type": "session_meta", "payload": {"session_id": SESSION_B, "cwd": "/workspace/project-2"}}) + "\n")
            first = pane(argv=["codex", "resume", SESSION_A], cwd="/workspace/project-1")
            first["pane_id"] = "w1:p1"
            second = pane(argv=["codex", "resume", SESSION_B], cwd="/workspace/project-2", pid=42)
            second["pane_id"] = "w1:p2"
            changed_first = pane(argv=["codex", "resume", SESSION_A], cwd="/workspace/project-1", pid=99)
            changed_first["pane_id"] = "w1:p1"
            snapshots = [[first, second], [first, second], [first, second], [changed_first, second]]
            args = SimpleNamespace(herdr_session="esim", client=None, apply=True, show_session_ids=False, manifest=str(manifest), diagnostic_session_paths=False)
            output = io.StringIO()
            with patch.object(REGISTRY, "verifier_panes", side_effect=snapshots), patch.object(
                REGISTRY, "verify_pane", side_effect=lambda value: VERIFIER.verify_pane(value, stores=stores, adapter=Adapter(start="start-1"))
            ), redirect_stdout(output):
                self.assertEqual(REGISTRY.verify_identity(args), 0)
            saved = json.loads(manifest.read_text())
        self.assertEqual([item["pane_id"] for item in saved["panes"]], ["w1:p2"])
        self.assertIn("apply result: written 1; skipped 1; initially verified 2", output.getvalue())

    def test_duplicate_current_claims_are_ambiguous_and_never_written(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, ids=(SESSION_A,))
            first = pane("codex", SESSION_A, pid=41)
            second = pane("codex", SESSION_A, pid=42)
            second["pane_id"] = "w1:p2"
            second["tab_id"] = "w1:t2"
            second["agent_session"]["value"] = SESSION_A
            panes = [first, second]
            for apply in (False, True):
                manifest = Path(temporary) / ("manifest-apply.json" if apply else "manifest-report.json")
                args = SimpleNamespace(
                    herdr_session="esim", client=None, apply=apply, show_session_ids=False,
                    manifest=str(manifest), diagnostic_session_paths=False,
                )
                output = io.StringIO()
                with patch.object(REGISTRY, "verifier_panes", return_value=panes), patch.object(
                    REGISTRY, "verify_pane", side_effect=lambda value: VERIFIER.verify_pane(
                        value, stores=stores, adapter=Adapter()
                    )
                ), redirect_stdout(output):
                    self.assertEqual(REGISTRY.verify_identity(args), 0)
                rendered = output.getvalue()
                self.assertIn("candidate_ambiguous", rendered)
                self.assertIn("exact=1", rendered)
                self.assertIn("same session id is claimed by more than one pane; claimants=2", rendered)
                self.assertNotIn(SESSION_A, rendered)
                self.assertFalse(manifest.exists())

    def test_final_snapshot_duplicate_claims_are_skipped_without_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, ids=(SESSION_A, SESSION_B))
            first = pane("codex", SESSION_A, pid=41)
            second = pane("codex", SESSION_B, pid=42)
            second["pane_id"] = "w1:p2"
            second["tab_id"] = "w1:t2"
            converged = pane("codex", SESSION_A, pid=42)
            converged["pane_id"] = "w1:p2"
            converged["tab_id"] = "w1:t2"
            manifest = Path(temporary) / "manifest.json"
            args = SimpleNamespace(
                herdr_session="esim", client=None, apply=True, show_session_ids=False,
                manifest=str(manifest), diagnostic_session_paths=False,
            )
            output = io.StringIO()
            snapshots = [[first, second], [first, second], [first, second], [first, converged]]
            with patch.object(REGISTRY, "verifier_panes", side_effect=snapshots), patch.object(
                REGISTRY, "verify_pane", side_effect=lambda value: VERIFIER.verify_pane(
                    value, stores=stores, adapter=Adapter()
                )
            ), patch.object(REGISTRY, "_candidate_observation_matches", return_value=True), redirect_stdout(output):
                self.assertEqual(REGISTRY.verify_identity(args), 0)
        rendered = output.getvalue()
        self.assertIn("same session id is claimed by more than one pane; claimants=2; skipped before write", rendered)
        self.assertIn("apply result: written 0; skipped 2; initially verified 2", rendered)
        self.assertFalse(manifest.exists())
        self.assertNotIn(SESSION_A, rendered)

    def test_existing_registration_blocks_apply_but_report_only_stays_write_free(self):
        for apply in (False, True):
            with tempfile.TemporaryDirectory() as temporary:
                stores = stores_for(temporary, ids=(SESSION_A,))
                pane_value = pane("codex", SESSION_A)
                state = Path(temporary) / "state"
                state.mkdir(mode=0o700)
                manifest = state / "manifest.json"
                existing = {
                    "version": 1,
                    "panes": [{
                        "herdr_session": "esim", "workspace_id": "old-workspace",
                        "tab_id": "old-tab", "pane_id": "old-pane", "client": "codex",
                        "session_id": SESSION_A,
                    }],
                }
                original_text = json.dumps(existing, indent=2) + "\n"
                manifest.write_text(original_text)
                args = SimpleNamespace(
                    herdr_session="esim", client=None, apply=apply, show_session_ids=False,
                    manifest=str(manifest), diagnostic_session_paths=False,
                )
                output = io.StringIO()
                snapshots = [[pane_value], [pane_value], [pane_value]]
                with patch.object(REGISTRY, "verifier_panes", side_effect=snapshots if apply else [[pane_value]]), patch.object(
                    REGISTRY, "verify_pane", side_effect=lambda value: VERIFIER.verify_pane(
                        value, stores=stores, adapter=Adapter()
                    )
                ), redirect_stdout(output):
                    self.assertEqual(REGISTRY.verify_identity(args), 0)
                self.assertEqual(manifest.read_text(), original_text)
                if apply:
                    self.assertIn("stale registration assigns this client session to another pane", output.getvalue())
                    self.assertIn("apply result: written 0; skipped 1; initially verified 1", output.getvalue())
                else:
                    self.assertIn("report-only", output.getvalue())

    def test_verifier_error_guidance_redacts_socket_paths(self):
        private_socket = "/private/herdr/esim/herdr.sock"
        args = SimpleNamespace(herdr_session=None, client=None, apply=False, show_session_ids=False, manifest="", diagnostic_session_paths=False)
        with patch.dict(os.environ, {"HERDR_SESSION": ""}), patch.object(REGISTRY, "running_named_session_sockets", return_value=[("esim", private_socket)]), redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(REGISTRY.verify_identity(args), 2)
        self.assertNotIn(private_socket, stdout.getvalue() + stderr.getvalue())
        args.herdr_session = "esim"
        with patch.object(REGISTRY, "verifier_panes", return_value=[]), patch.object(
            REGISTRY, "running_named_session_sockets", return_value=[("esim", private_socket)]
        ), redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(REGISTRY.verify_identity(args), 1)
        self.assertNotIn(private_socket, stdout.getvalue() + stderr.getvalue())

    def test_named_session_binds_every_snapshot_and_process_read(self):
        requested = "requested"
        ambient = {"HERDR_SESSION": "ambient", "HERDR_SOCKET_PATH": "/private/ambient.sock"}
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, ambient), patch.object(REGISTRY.subprocess, "run") as run:
            home = Path(temporary) / "codex"
            rollout = home / "sessions" / "2026" / "10" / "02"
            rollout.mkdir(parents=True)
            (rollout / f"rollout-{SESSION_A}.jsonl").write_text(
                json.dumps({"type": "session_meta", "payload": {"session_id": SESSION_A, "cwd": "/workspace/project"}}) + "\n"
            )
            state = Path(temporary) / "state"
            state.mkdir(mode=0o700)
            state.chmod(0o700)
            manifest = state / "manifest.json"
            snapshot = {
                "result": {
                    "snapshot": {
                        "panes": [{
                            "pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "w1:t1",
                            "agent": "codex", "agent_status": "idle", "cwd": "/workspace/project",
                            "foreground_cwd": "/workspace/project", "label": "Agent",
                            "agent_session": {"agent": "codex", "source": "hook", "value": SESSION_A},
                        }], "tabs": [], "workspaces": [],
                    }
                }
            }
            process = {"result": {"process_info": {"foreground_processes": [{"pid": 41, "argv": ["codex"], "process_start": "start-1"}]}}}
            calls = []

            def fake_run(command, **kwargs):
                calls.append(command)
                if command[:3] == ["herdr", "--session", requested] and command[3:] == ["api", "snapshot"]:
                    return SimpleNamespace(returncode=0, stdout=json.dumps(snapshot), stderr="")
                if command[:3] == ["herdr", "--session", requested] and command[3:] == ["pane", "process-info", "--pane", "w1:p1"]:
                    return SimpleNamespace(returncode=0, stdout=json.dumps(process), stderr="")
                return SimpleNamespace(returncode=1, stdout="", stderr="")

            run.side_effect = fake_run

            args = SimpleNamespace(herdr_session=requested, client=None, apply=False, show_session_ids=False, manifest=str(manifest), diagnostic_session_paths=False)
            with patch.dict(os.environ, {"CODEX_HOME": str(home)}), redirect_stdout(io.StringIO()):
                self.assertEqual(REGISTRY.verify_identity(args), 0)
            report_herdr = [command for command in calls if command and command[0] == "herdr"]
            self.assertTrue(report_herdr)
            self.assertTrue(all(command[1:3] == ["--session", requested] for command in report_herdr))
            calls.clear()
            args.apply = True
            with patch.dict(os.environ, {"CODEX_HOME": str(home)}), redirect_stdout(io.StringIO()):
                self.assertEqual(REGISTRY.verify_identity(args), 0)
            apply_herdr = [command for command in calls if command and command[0] == "herdr"]
            self.assertGreaterEqual(len(apply_herdr), 3)
            self.assertTrue(all(command[1:3] == ["--session", requested] for command in apply_herdr))
            saved = json.loads(manifest.read_text())
        self.assertEqual(saved["panes"][0]["herdr_session"], requested)

    def test_default_and_unknown_named_sessions_are_refused(self):
        args = SimpleNamespace(herdr_session="default", client=None, apply=False, show_session_ids=False, manifest="", diagnostic_session_paths=False)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(REGISTRY.verify_identity(args), 2)
        args.herdr_session = "unknown"
        with patch.object(REGISTRY, "verifier_panes", return_value=[]), patch.object(REGISTRY, "running_named_session_sockets", return_value=[]), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(REGISTRY.verify_identity(args), 1)

    def test_shortcuts_expose_verifier_and_preserve_capture_history_scan(self):
        shortcuts = ROOT / "agent-session-shortcuts.zsh"
        script = f'''\npython3() {{ print -r -- "PY:$*" }}\nsource {shortcuts}\nherdr-agent-verify-identity --herdr-session esim\nherdr-agent-capture-history --execute --client codex --lines 10\n'''
        result = subprocess.run(["zsh", "-fc", script], text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0)
        self.assertIn("verify-identity", result.stdout)
        self.assertIn("scan", result.stdout)
        self.assertIn("--execute", result.stdout)
        fallback_script = f'''\ntypeset -g calls=0\npython3() {{ calls=$((calls + 1)); print -r -- "CALL:$*"; (( calls == 1 )) && return 2; return 0 }}\nunset HERDR_SESSION\nsource {shortcuts}\nherdr-agent-capture-history --client codex\n'''
        fallback = subprocess.run(["zsh", "-fc", fallback_script], text=True, capture_output=True, check=False)
        self.assertEqual(fallback.returncode, 0)
        self.assertEqual(fallback.stdout.count("CALL:"), 2)
        self.assertIn("scan", fallback.stdout)

    def test_apply_snapshot_rejects_changed_cwd_and_pid(self):
        original = pane(argv=["codex", "resume", SESSION_A])
        changed_cwd = pane(cwd="/workspace/other", argv=["codex", "resume", SESSION_A])
        changed_pid = pane(pid=99, argv=["codex", "resume", SESSION_A])
        self.assertFalse(REGISTRY._pane_matches_snapshot(original, changed_cwd))
        self.assertFalse(REGISTRY._pane_matches_snapshot(original, changed_pid))

    def test_status_capture_stays_idle_or_done_only(self):
        busy = REGISTRY.PaneInfo("esim", "w1:p1", "w1", "w1:t1", "/workspace/project", "/workspace/project", "codex", "working")
        with patch.object(REGISTRY, "pane_send_status") as send, patch.object(REGISTRY, "log_status_event"):
            self.assertIsNone(REGISTRY.detect_from_status(busy, lines=20))
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
