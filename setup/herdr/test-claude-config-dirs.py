"""Tests for claude_config_dirs.py: where Claude keeps a session, and the command that resumes it under the right account.

Every test runs against a scratch HOME, so no real ~/.claude* folder is read.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import claude_config_dirs as DIRS


SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


class ClaudeConfigDirsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name).resolve() / "home"
        self.home.mkdir()
        environment = patch.dict(os.environ, {"HOME": str(self.home)})
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("CLAUDE_CONFIG_DIR", None)

    def folder(self, name, *, sessions=(), pid_records=()):
        folder = self.home / name
        project = folder / "projects" / "encoded"
        project.mkdir(parents=True)
        for session_id in sessions:
            (project / f"{session_id}.jsonl").write_text('{"type":"summary"}\n')
        (folder / "sessions").mkdir()
        for pid, record in pid_records:
            (folder / "sessions" / f"{pid}.json").write_text(json.dumps(record))
        return folder

    def test_every_config_folder_is_found_by_the_one_rule_without_knowing_its_name(self):
        default = self.folder(".claude")
        personal = self.folder(".claude-personal")
        self.folder(".claude-org2")
        (self.home / ".claude.json").write_text("{}")  # a file, not a config folder
        (self.home / ".claude-mem").mkdir()  # another tool's folder: no projects/
        (self.home / "elsewhere" / "projects").mkdir(parents=True)  # not named .claude*, and nothing names it
        self.assertEqual(
            DIRS.claude_config_dirs(), [default, self.home / ".claude-org2", personal], "~/.claude first, then the others by name"
        )
        self.assertEqual(DIRS.claude_projects_dirs()[0], default / "projects")

    def test_the_process_own_folder_comes_first_and_the_folder_claude_config_dir_names_counts(self):
        default = self.folder(".claude")
        personal = self.folder(".claude-personal")
        outside = self.home.parent / "outside-config"
        (outside / "projects").mkdir(parents=True)
        with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(personal)}):
            self.assertEqual(DIRS.own_config_dir(), personal)
            self.assertEqual(DIRS.claude_config_dirs(), [personal, default])
        with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(outside)}):
            self.assertEqual(DIRS.claude_config_dirs(), [outside, default, personal])
        self.assertEqual(DIRS.claude_config_dirs(personal), [personal, default])

    def test_an_account_set_up_later_is_found_by_the_next_lookup(self):
        self.folder(".claude")
        self.assertEqual(len(DIRS.claude_config_dirs()), 1)
        late = self.folder(".claude-late")
        self.assertIn(late, DIRS.claude_config_dirs())

    def test_a_link_to_the_same_folder_is_not_a_second_folder(self):
        default = self.folder(".claude")
        (self.home / ".claude-alias").symlink_to(default)
        self.assertEqual(DIRS.claude_config_dirs(), [default])

    def test_the_default_folder_is_stored_as_nothing_and_another_one_as_its_path(self):
        default = self.folder(".claude")
        personal = self.folder(".claude-personal")
        (self.home / ".claude-alias").symlink_to(default)
        self.assertIsNone(DIRS.config_dir_field(default))
        self.assertIsNone(DIRS.config_dir_field(str(self.home / ".claude-alias")), "the default folder through a link is still the default")
        self.assertIsNone(DIRS.config_dir_field(None))
        self.assertIsNone(DIRS.config_dir_field(""))
        self.assertIsNone(DIRS.config_dir_field("relative/.claude-personal"), "a relative path says no folder")
        self.assertEqual(DIRS.config_dir_field(personal), str(personal))
        self.assertTrue(DIRS.is_default_config_dir(default))
        self.assertFalse(DIRS.is_default_config_dir(personal))

    def test_the_resume_command_names_a_second_account_folder_and_quotes_it(self):
        spaced = self.home / "my claude"
        self.assertEqual(DIRS.claude_resume_command(SESSION_A), f"claude --resume {SESSION_A}")
        self.assertEqual(DIRS.claude_resume_command(SESSION_A, self.home / ".claude"), f"claude --resume {SESSION_A}")
        self.assertEqual(
            DIRS.claude_resume_command(SESSION_A, self.home / ".claude-personal"),
            f"CLAUDE_CONFIG_DIR={self.home}/.claude-personal claude --resume {SESSION_A}",
        )
        self.assertEqual(
            DIRS.claude_resume_command(SESSION_A, spaced), f"CLAUDE_CONFIG_DIR='{spaced}' claude --resume {SESSION_A}"
        )

    def test_a_session_is_found_in_the_folder_that_holds_it_and_a_copy_never_shadows_the_usual_one(self):
        default = self.folder(".claude", sessions=(SESSION_A,))
        personal = self.folder(".claude-personal", sessions=(SESSION_A, SESSION_B))
        self.assertEqual(DIRS.session_config_dirs(SESSION_A), [default, personal])
        self.assertEqual(DIRS.session_config_dir(SESSION_A), default)
        self.assertEqual(DIRS.session_config_dir(SESSION_A, prefer=personal), personal, "the folder a pid record sits in settles it")
        self.assertEqual(DIRS.session_config_dir(SESSION_B), personal)
        self.assertEqual(DIRS.session_config_dir(SESSION_B, prefer=default), personal, "a preferred folder without the session is ignored")
        self.assertTrue(DIRS.claude_session_exists(SESSION_B))
        self.assertIsNone(DIRS.session_config_dir("cccccccc-cccc-4ccc-8ccc-cccccccccccc"))
        for bad in ("", "../x", "short", None, 5):
            self.assertEqual(DIRS.session_config_dirs(bad), [], bad)
            self.assertFalse(DIRS.claude_session_exists(bad), bad)

    def test_a_pid_record_is_found_in_the_folder_the_process_runs_under_and_a_stale_one_is_dropped(self):
        start = "Thu Nov  5 07:09:29 2026"
        record = {"pid": 41, "sessionId": SESSION_A, "cwd": "/w", "procStart": start}
        stale = {"pid": 41, "sessionId": SESSION_B, "cwd": "/w", "procStart": "Mon Oct 12 01:02:03 2026"}
        personal = self.folder(".claude-personal", pid_records=((41, record),))
        self.folder(".claude", pid_records=((41, stale),))
        with patch.object(DIRS, "process_start_utc", return_value=start):
            self.assertEqual(DIRS.pid_session_records(41), [(personal, record)])
        with patch.object(DIRS, "process_start_utc", return_value=None):
            self.assertEqual(len(DIRS.pid_session_records(41)), 2, "with no live start to compare, a record is kept")
        with patch.object(DIRS, "process_start_utc", return_value=start):
            self.assertEqual(DIRS.pid_session_records(42), [])

    def test_a_pid_record_for_another_pid_or_that_is_not_json_is_ignored(self):
        self.folder(".claude", pid_records=((41, {"pid": 99, "sessionId": SESSION_A}),))
        folder = self.folder(".claude-personal")
        (folder / "sessions" / "41.json").write_text("not json")
        with patch.object(DIRS, "process_start_utc", return_value=None):
            self.assertEqual(DIRS.pid_session_records(41), [])

    def test_the_process_start_is_asked_for_in_utc(self):
        seen = {}

        def fake_run(command, **kwargs):
            seen["command"], seen["env"] = command, kwargs.get("env") or {}
            return SimpleNamespace(stdout="Thu Nov  5 07:09:29 2026\n")

        with patch.object(DIRS.sys, "platform", "darwin"), patch.object(DIRS.subprocess, "run", fake_run):
            self.assertEqual(DIRS.process_start_utc(41), "Thu Nov  5 07:09:29 2026")
        self.assertEqual(seen["command"][:3], ["ps", "-o", "lstart="])
        self.assertEqual(seen["env"].get("TZ"), "UTC")


if __name__ == "__main__":
    unittest.main()
