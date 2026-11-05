"""CLI tests for how register and capture-missing choose the pane they act on.

The real script runs as a subprocess against a stand-in `herdr` on PATH that always answers
`pane current --current` with a pane that is not the one the caller asked for (what Herdr does
outside a pane: the focused pane of the default session). Manifest, missing-session file and
status log live in a private temporary folder; nothing real is read or written.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent
SCRIPT = ROOT / "agent-session-registry.py"

# Stand-in herdr: logs every call, names a different "current" pane, fails every other read.
FAKE_HERDR = """#!/bin/sh
echo "$*" >> "$FAKE_HERDR_LOG"
if [ "$1 $2 $3" = "pane current --current" ]; then
cat <<'JSON'
{"result": {"pane": {"pane_id": "w9:p9", "workspace_id": "w9", "tab_id": "w9:t9", "cwd": "/somewhere/else"}}}
JSON
exit 0
fi
exit 1
"""

SESSION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
EXPLICIT = ["--pane-id", "w2:p1", "--workspace-id", "w2", "--tab-id", "w2:t1"]


class RegistryTargetPaneTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.state.chmod(0o700)
        self.work = self.root / "work"
        self.work.mkdir()
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        herdr = bin_dir / "herdr"
        herdr.write_text(FAKE_HERDR)
        herdr.chmod(herdr.stat().st_mode | stat.S_IXUSR)
        self.log = self.root / "herdr-calls.log"
        self.manifest = self.state / "manifest.json"
        self.missing = self.state / "missing.json"
        self.env = {
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(self.root / "home"),
            "FAKE_HERDR_LOG": str(self.log),
            "PMOS_HERDR_AGENT_MANIFEST": str(self.manifest),
            "PMOS_HERDR_AGENT_MISSING_JSON": str(self.missing),
            "PMOS_HERDR_AGENT_STATUS_LOG": str(self.state / "status.jsonl"),
        }

    def run_registry(self, *args, extra_env=None):
        env = dict(self.env)
        env.update(extra_env or {})
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            text=True,
            capture_output=True,
            env=env,
            cwd=self.work,
            timeout=60,
            check=False,
        )

    def register(self, *args, extra_env=None):
        return self.run_registry(
            "register", "--client", "codex", "--session-id", SESSION_ID, "--cwd", str(self.work), *args,
            extra_env=extra_env,
        )

    def capture_missing(self, *args, extra_env=None):
        return self.run_registry(
            "capture-missing", "--client", "codex", "--cwd", str(self.work), *args, extra_env=extra_env
        )

    def herdr_calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def records(self):
        return json.loads(self.manifest.read_text())["panes"] if self.manifest.exists() else []

    def missing_items(self):
        return json.loads(self.missing.read_text())["items"] if self.missing.exists() else None

    def test_register_with_explicit_ids_ignores_the_current_pane(self):
        result = self.register(*EXPLICIT, "--herdr-session", "lab", "--allow-no-herdr")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("registered codex -> w2:p1\n", result.stdout)
        (record,) = self.records()
        self.assertEqual(
            (record["pane_id"], record["workspace_id"], record["tab_id"], record["herdr_session"]),
            ("w2:p1", "w2", "w2:t1", "lab"),
        )
        self.assertEqual(record["session_id"], SESSION_ID)
        self.assertEqual(self.herdr_calls(), [], "explicit ids must not ask herdr for the current pane")

    def test_register_with_explicit_ids_does_not_need_the_allow_flag(self):
        result = self.register(*EXPLICIT, "--herdr-session", "lab")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("registered codex -> w2:p1\n", result.stdout)
        (record,) = self.records()
        self.assertEqual((record["pane_id"], record["herdr_session"]), ("w2:p1", "lab"))
        self.assertEqual(self.herdr_calls(), [])

    def test_register_explicit_ids_without_session_flag_use_the_environment_session_only(self):
        result = self.register(*EXPLICIT, extra_env={"HERDR_SESSION": "from-env"})
        self.assertEqual(result.returncode, 0, result.stderr)
        (record,) = self.records()
        self.assertEqual((record["pane_id"], record["herdr_session"]), ("w2:p1", "from-env"))

    def test_register_resaving_the_same_pane_replaces_the_record(self):
        for _ in range(2):
            result = self.register(*EXPLICIT, "--herdr-session", "lab", "--allow-no-herdr")
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.records()), 1)

    def test_register_partial_ids_is_an_error_and_writes_nothing(self):
        partials = (
            ["--pane-id", "w2:p1"],
            ["--pane-id", "w2:p1", "--workspace-id", "w2"],
            ["--workspace-id", "w2", "--tab-id", "w2:t1"],
            ["--tab-id", "w2:t1"],
        )
        for partial in partials:
            for flags in ([], ["--allow-no-herdr"]):
                with self.subTest(partial=partial, flags=flags):
                    result = self.register(*partial, *flags, "--herdr-session", "lab")
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("must be given together", result.stderr)
                    self.assertNotIn("registered", result.stdout)
                    self.assertFalse(self.manifest.exists())
                    self.assertEqual(self.herdr_calls(), [], "a partial set must not fall back to the current pane")

    def test_register_without_ids_still_uses_the_current_pane(self):
        result = self.register()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("registered codex -> w9:p9\n", result.stdout)
        (record,) = self.records()
        self.assertEqual((record["pane_id"], record["workspace_id"], record["tab_id"]), ("w9:p9", "w9", "w9:t9"))
        self.assertEqual(record["herdr_session"], None)
        self.assertEqual(self.herdr_calls()[0], "pane current --current")

    def test_register_without_ids_and_without_a_reachable_herdr_keeps_its_errors(self):
        no_herdr = {"PATH": "/usr/bin:/bin"}
        result = self.register(extra_env=no_herdr)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not inside a reachable herdr pane; use --allow-no-herdr with explicit ids", result.stderr)
        result = self.register("--allow-no-herdr", extra_env=no_herdr)
        self.assertEqual(result.returncode, 2)
        self.assertIn("explicit --pane-id, --workspace-id, and --tab-id are required", result.stderr)
        self.assertFalse(self.manifest.exists())

    def test_capture_missing_with_explicit_ids_ignores_the_current_pane(self):
        result = self.capture_missing(*EXPLICIT, "--herdr-session", "lab", "--allow-no-herdr")
        self.assertEqual(result.returncode, 0, result.stderr)
        items = self.missing_items()
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(
            (item["pane_id"], item["workspace_id"], item["tab_id"], item["herdr_session"]),
            ("w2:p1", "w2", "w2:t1", "lab"),
        )
        self.assertEqual(self.herdr_calls(), [])

    def test_capture_missing_with_explicit_ids_does_not_need_the_allow_flag(self):
        result = self.capture_missing(*EXPLICIT, "--herdr-session", "lab")
        self.assertEqual(result.returncode, 0, result.stderr)
        (item,) = self.missing_items()
        self.assertEqual((item["pane_id"], item["herdr_session"]), ("w2:p1", "lab"))
        self.assertEqual(self.herdr_calls(), [])

    def test_capture_missing_partial_ids_is_an_error(self):
        result = self.capture_missing("--pane-id", "w2:p1", "--allow-no-herdr", "--herdr-session", "lab")
        self.assertEqual(result.returncode, 2)
        self.assertIn("must be given together", result.stderr)
        self.assertIsNone(self.missing_items())
        self.assertEqual(self.herdr_calls(), [])

    def test_capture_missing_without_ids_still_uses_the_current_pane(self):
        result = self.capture_missing()
        self.assertEqual(result.returncode, 0, result.stderr)
        (item,) = self.missing_items()
        self.assertEqual((item["pane_id"], item["workspace_id"], item["tab_id"]), ("w9:p9", "w9", "w9:t9"))
        self.assertEqual(self.herdr_calls()[0], "pane current --current")


if __name__ == "__main__":
    unittest.main()
