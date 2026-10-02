"""Fixture tests for the read-only Herdr identity verifier."""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
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
    def test_claude_native_id_is_valid_only_when_store_exists_and_cwd_matches(self):
        with tempfile.TemporaryDirectory() as temporary:
            stores = stores_for(temporary, client="claude", ids=(SESSION_A,))
            valid = pane("claude", SESSION_A)
            self.assertEqual(VERIFIER.verify_pane(valid, stores=stores, adapter=Adapter())["status"], "native_verified")
            invalid = pane("claude", SESSION_B)
            self.assertEqual(VERIFIER.verify_pane(invalid, stores=stores, adapter=Adapter())["status"], "unresolved")

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
