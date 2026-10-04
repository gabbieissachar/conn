#!/usr/bin/env python3
"""Tests for store_check.py against synthetic Claude and Codex stores.

Run: python3 -m unittest setup/herdr-organizer/test/test_store_check.py
(or: python3 setup/herdr-organizer/test/test_store_check.py)

The Herdr tool root is the user's real tool directory, imported read-only for
the verifier's store classes; set HERDR_ORGANIZER_TOOL_ROOT to point elsewhere.
All stores and manifests here are temporary directories with made-up ids.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "store_check.py"
TOOL_ROOT = Path(os.environ.get("HERDR_ORGANIZER_TOOL_ROOT") or HERE.parents[2] / "personal" / "01-System" / "setup" / "herdr")

CLAUDE_ID = "aaaaaaaa-1111-4222-8333-444444444444"
CODEX_ID = "bbbbbbbb-1111-4222-8333-444444444444"
OTHER_ID = "cccccccc-1111-4222-8333-444444444444"


@unittest.skipUnless((TOOL_ROOT / "agent_identity_verifier.py").exists(), "Herdr tool root not available")
class StoreCheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.work = (base / "work" / "alpha").resolve()
        self.work.mkdir(parents=True)
        self.elsewhere = (base / "work" / "beta").resolve()
        self.elsewhere.mkdir(parents=True)
        self.claude_home = base / "claude"
        project = self.claude_home / "projects" / "-work-alpha"
        project.mkdir(parents=True)
        (project / f"{CLAUDE_ID}.jsonl").write_text(json.dumps({"sessionId": CLAUDE_ID, "cwd": str(self.work)}) + "\n")
        self.codex_home = base / "codex"
        self.codex_home.mkdir()
        (self.codex_home / "session_index.jsonl").write_text(json.dumps({"id": CODEX_ID, "cwd": str(self.work)}) + "\n")
        self.manifest = base / "manifest.json"
        self.env = {
            **os.environ,
            "PMOS_ORGANIZER_CLAUDE_HOME": str(self.claude_home),
            "CODEX_HOME": str(self.codex_home),
            "PMOS_HERDR_AGENT_MANIFEST": str(self.manifest),
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_check(self, **request) -> dict:
        base = {"client": "claude", "session_id": CLAUDE_ID, "pane_cwd": str(self.work), "herdr_session": "project-a", "pane_id": "w1:p1"}
        base.update(request)
        done = subprocess.run([sys.executable, str(SCRIPT), str(TOOL_ROOT)], input=json.dumps(base), capture_output=True, text=True, env=self.env, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_existing_claude_session_in_the_same_folder(self) -> None:
        result = self.run_check()
        self.assertEqual(result, {"valid_format": True, "exists": True, "store_folder": "match", "registered_elsewhere": False, "already_registered_here": False})

    def test_existing_codex_session_in_the_same_folder(self) -> None:
        self.assertEqual(self.run_check(client="codex", session_id=CODEX_ID)["store_folder"], "match")

    def test_unknown_id_does_not_exist(self) -> None:
        result = self.run_check(session_id=OTHER_ID)
        self.assertTrue(result["valid_format"])
        self.assertFalse(result["exists"])

    def test_bad_format_is_rejected_without_touching_the_store(self) -> None:
        for bad in ["not-a-uuid", "", "../../etc/passwd", CLAUDE_ID + "x", None]:
            result = self.run_check(session_id=bad)
            self.assertFalse(result["valid_format"], bad)
            self.assertFalse(result["exists"], bad)

    def test_client_must_match_the_store(self) -> None:
        self.assertFalse(self.run_check(client="codex", session_id=CLAUDE_ID)["exists"])
        self.assertFalse(self.run_check(client="claude", session_id=CODEX_ID)["exists"])
        self.assertFalse(self.run_check(client="gemini")["valid_format"])

    def test_folder_mismatch_and_unknown(self) -> None:
        self.assertEqual(self.run_check(pane_cwd=str(self.elsewhere))["store_folder"], "differs")
        self.assertEqual(self.run_check(pane_cwd=None)["store_folder"], "unknown")
        self.assertEqual(self.run_check(pane_cwd="")["store_folder"], "unknown")

    def test_registered_elsewhere_and_here(self) -> None:
        self.manifest.write_text(json.dumps({"panes": [
            {"client": "claude", "session_id": CLAUDE_ID, "herdr_session": "project-a", "pane_id": "w9:p9"},
        ]}))
        result = self.run_check()
        self.assertTrue(result["registered_elsewhere"])
        self.assertFalse(result["already_registered_here"])
        self.manifest.write_text(json.dumps({"panes": [
            {"client": "claude", "session_id": CLAUDE_ID, "herdr_session": "project-a", "pane_id": "w1:p1"},
        ]}))
        result = self.run_check()
        self.assertFalse(result["registered_elsewhere"])
        self.assertTrue(result["already_registered_here"])
        # The same pane id in a different Herdr session is a different pane.
        self.manifest.write_text(json.dumps({"panes": [
            {"client": "claude", "session_id": CLAUDE_ID, "herdr_session": "project-b", "pane_id": "w1:p1"},
        ]}))
        self.assertTrue(self.run_check()["registered_elsewhere"])

    def test_output_never_contains_the_id_or_a_path(self) -> None:
        done = subprocess.run([sys.executable, str(SCRIPT), str(TOOL_ROOT)], input=json.dumps({"client": "claude", "session_id": CLAUDE_ID, "pane_cwd": str(self.work), "herdr_session": "s", "pane_id": "w1:p1"}), capture_output=True, text=True, env=self.env, check=False)
        self.assertNotIn(CLAUDE_ID, done.stdout + done.stderr)
        self.assertNotIn(str(self.work), done.stdout + done.stderr)

    def test_garbage_input_fails_without_leaking(self) -> None:
        done = subprocess.run([sys.executable, str(SCRIPT), str(TOOL_ROOT)], input="not json " + CLAUDE_ID, capture_output=True, text=True, env=self.env, check=False)
        self.assertEqual(done.returncode, 1)
        self.assertNotIn(CLAUDE_ID, done.stdout + done.stderr)


if __name__ == "__main__":
    unittest.main()
