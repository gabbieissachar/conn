"""The command line, end to end, against a synthetic home, a temporary store folder and the fake Herdr. No real log, pane or keychain is touched."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from base import StoreCase
from lab import Lab
import synth

STORE = Path(__file__).resolve().parent.parent
A, B = synth.sid(11), synth.sid(12)


class Cli(StoreCase):
    def setUp(self):
        super().setUp()
        self.conn.close()
        self.lab = Lab(self.home)
        self.addCleanup(self.lab.close)
        self.security_log = self.home / "security-calls.log"
        shim = self.home / "security"
        shim.write_text(f'#!/bin/sh\necho "$*" >> "{self.security_log}"\nexit 44\n')
        shim.chmod(0o755)
        self.env = {**os.environ, "PMOS_READER_STORE_DIR": str(self.root), "PMOS_READER_STORE_HOME": str(self.home), "HOME": str(self.home),
                    "PATH": f"{self.lab.dir}{os.pathsep}{os.environ['PATH']}", "FAKE_HERDR_WORLD": str(self.lab.world_file), "RSTORE_SECURITY": str(shim),
                    "GNUPGHOME": str(self.home / "gnupg")}
        (self.home / "gnupg").mkdir(mode=0o700)
        synth.write_jsonl(synth.claude_path(self.home, A), synth.claude_conversation(n_turns=2))
        synth.write_jsonl(synth.codex_path(self.home, synth.sid(2)), synth.codex_conversation(synth.sid(2)))

    def run_cli(self, *args, expect=0):
        done = subprocess.run([sys.executable, str(STORE / "reader_store.py"), *args], capture_output=True, text=True, env=self.env, timeout=120)
        self.assertEqual(done.returncode, expect, done.stdout + done.stderr)
        return done

    def test_init_scan_status_search(self):
        out = json.loads(self.run_cli("init").stdout)
        self.assertEqual(out["schema_version"], 1)
        self.assertTrue((self.root / "settings.json").exists())
        scan = json.loads(self.run_cli("scan").stdout)
        self.assertEqual((scan["files"], scan["changed"], scan["errors"]), (2, 2, 0))
        self.assertIn("cpu_s", scan)
        status = json.loads(self.run_cli("status").stdout)
        self.assertEqual(status["counts"]["sessions"], 2)
        self.assertEqual(status["heartbeat"]["status"], "stopped")
        self.assertEqual(status["sessions_by_harness"], {"claude": 1, "codex": 1})
        found = self.run_cli("search", "Codex", "question").stdout
        self.assertIn(synth.sid(2), found)
        self.assertIn("[Codex]", found)

    def test_forget_and_the_session_stays_gone(self):
        self.run_cli("scan")
        self.run_cli("backup", expect=2)  # no key: stops, says what to create
        report = json.loads(self.run_cli("forget", A, "--note", "test").stdout)
        self.assertEqual(report["forgotten"], [A])
        self.assertEqual(json.loads(self.run_cli("scan").stdout)["changed"], 0)
        self.assertNotIn(A, self.run_cli("search", "alpha").stdout)

    def test_the_machine_changing_commands_print_and_run_nothing(self):
        out = self.run_cli("launchd").stdout
        self.assertIn("LIVE WRITE - nothing below has been run.", out)
        self.assertIn("launchctl bootstrap gui/", out)
        self.assertIn("com.pmos.reader-store-nightly", out)
        self.assertIn("<key>KeepAlive</key><true/>", out)
        self.assertIn("mv ", out)
        self.assertNotIn("rm ", out.replace("rmdir", ""), "the undo moves files aside")
        self.assertFalse((self.home / "Library" / "LaunchAgents").exists(), "nothing was written under the home folder")
        key = self.run_cli("key-command").stdout
        self.assertIn("security add-generic-password", key)
        self.assertFalse(self.security_log.exists() and "add-generic-password" in self.security_log.read_text(), "the keychain was not written")

    def test_backup_without_a_key_stops_with_the_command_and_without_the_drive(self):
        self.run_cli("scan")
        done = self.run_cli("backup", "--upload", expect=2)
        self.assertIn("no backup key in the keychain", done.stderr)
        self.assertIn("security add-generic-password", done.stderr)
        self.assertEqual(list((self.root / "backup-staging").iterdir()), [] if (self.root / "backup-staging").exists() else [])
        settings = json.loads(self.run_cli("settings", "--set", "drive_folder=/nowhere/GoogleDrive-x@shopback.com/My Drive").stdout)
        self.assertEqual(settings["drive_folder"], "/nowhere/GoogleDrive-x@shopback.com/My Drive")

    def test_nightly_runs_parity_and_stops_at_the_missing_key_without_failing(self):
        self.run_cli("scan")
        out = json.loads(self.run_cli("nightly").stdout)
        self.assertEqual(out["parity"]["mismatches"], 0)
        self.assertIn("error", out["backup"])
        self.assertIn("no backup key", out["backup"]["error"])

    def test_identity_and_validation_commands(self):
        from rstore import identity
        sleeper = subprocess.Popen(["sleep", "60"])  # a real process: the CLI asks `ps` for its start time
        self.addCleanup(sleeper.wait)  # cleanups run last-in first-out: kill, then wait
        self.addCleanup(sleeper.kill)
        pid = sleeper.pid
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=A, pid=pid)
        self.lab.pid_record(pid, A, proc_start=identity.process_start(pid))
        self.run_cli("scan")
        rec = json.loads(self.run_cli("reconcile").stdout)
        self.assertEqual((rec["sessions"], rec["panes"]), (1, 1))
        audit = json.loads(self.run_cli("audit").stdout)
        self.assertEqual(audit, {"checked": 1, "agree": 1, "disagree": 0, "unscored": 0})
        sent = json.loads(self.run_cli("record-send", "--herdr-session", "esim", "--pane", "w1:p1", "--session", A, "--result", "ok", "--check-session", A).stdout)
        self.assertEqual((sent["agree"], sent["store_session"]), (1, A))
        ids = json.loads(self.run_cli("terminal-ids").stdout)
        self.assertEqual((ids["panes_with_terminal_id"], ids["terminal_ids_shared_by_several_panes"]), (1, 0))
        self.run_cli("coverage", "mark", "--row", "herdr_restart", "--status", "staged-in-lab", "--note", "lab")
        cov = self.run_cli("coverage", "--write").stdout
        self.assertIn("1 of 12 rows filled", cov)
        self.assertTrue((self.root / "reports" / "coverage.md").exists())
        card = self.run_cli("scorecard", "--write").stdout
        self.assertIn("S1 exit scorecard", card)
        self.assertTrue((self.root / "reports" / "scorecard.md").exists())
        self.run_cli("parity")
        self.assertIn("unexplained=0", self.run_cli("parity-report").stdout)
        self.run_cli("soak-start")
        self.assertIn("ingest", json.loads(self.run_cli("rusage").stdout)["components"])
        self.run_cli("disagree", "list")

    def test_known_answers_draft_and_check(self):
        self.run_cli("scan")
        queries = self.home / "queries.txt"
        queries.write_text("# draft\nCodex question\nalpha\n")
        table = self.run_cli("known-answers", "draft", str(queries)).stdout
        self.assertIn("<fill in>", table)
        filled = self.home / "answers.md"
        filled.write_text(table.replace("<fill in>", synth.sid(2)[:8], 1))
        done = self.run_cli("known-answers", "check", str(filled), expect=0)
        self.assertIn("pass", done.stdout)
        self.assertIn("undecided", done.stdout)

    def test_a_second_scan_while_one_runs_is_refused(self):
        from rstore import db
        with db.single_writer(self.root / "ingest.lock"):
            done = self.run_cli("scan", expect=2)
            self.assertIn("another ingest holds", done.stderr)


class LabRunParse(unittest.TestCase):
    """`lab-run` reads which tests passed from the unittest output; one stray line between a test's name and its verdict must not hide it."""

    def test_a_stray_line_between_the_name_and_the_verdict_does_not_hide_a_pass(self):
        from rstore import cli
        text = ("test_a_one (m.C.test_a_one) ... ok\n"
                "test_b_two (m.C.test_b_two) ... ResourceWarning: unclosed database\nok\n"
                "test_c_three (m.C.test_c_three) ... skipped 'no gpg'\n"
                "test_d_four (m.C.test_d_four) ... FAIL\n"
                "\n======\nFAIL: test_d_four (m.C.test_d_four)\n")
        self.assertEqual(cli.lab_ok_names(text, 0), {"test_a_one", "test_b_two"})
        self.assertEqual(cli.lab_ok_names(text, 1), set(), "a failed run proves nothing")


if __name__ == "__main__":
    unittest.main()
