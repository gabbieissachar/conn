"""Tests for Claude Code runs under another config folder (CLAUDE_CONFIG_DIR, for example ~/.claude-personal): finding the folders,
the logs and the running processes' records under them, and the pane that runs such a Claude.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_claude_homes.py
Fixtures are scratch folders standing in for the home folder (HOME is pointed at one), with invented one-line logs; nothing under
the real ~/.claude* is read, and Herdr is faked.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import message_link  # noqa: E402
import reader  # noqa: E402
from reader import builder  # noqa: E402

FIRST = "d1d1d1d1-0000-4000-8000-000000000001"  # a session of ~/.claude
SECOND = "d2d2d2d2-0000-4000-8000-000000000002"  # a session of the second config folder
THIRD = "d3d3d3d3-0000-4000-8000-000000000003"  # a session of a third one
FOLDER = "-Users-someone-work"


def user_line(text):
    return json.dumps({"type": "user", "uuid": "u1", "timestamp": "2026-11-05T01:00:00.000Z", "sessionId": SECOND, "cwd": "/Users/someone/work",
                       "message": {"role": "user", "content": text}}) + "\n"


class ClaudeHomesTest(unittest.TestCase):
    """HOME is a scratch folder, the module's usual folders are the ones under it, and so every ~/.claude* folder is a fixture."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        patches = [
            mock.patch.dict(os.environ, {"HOME": str(self.home), "CLAUDE_CONFIG_DIR": "", "PMOS_READER_CLAUDE_HOMES": ""}),
            mock.patch.object(builder, "PROJECTS", self.home / ".claude" / "projects"),
            mock.patch.object(builder, "DEFAULT_PROJECTS", self.home / ".claude" / "projects"),
            mock.patch.object(builder, "CLAUDE_SESSIONS", self.home / ".claude" / "sessions"),
            mock.patch.object(builder, "DEFAULT_CLAUDE_SESSIONS", self.home / ".claude" / "sessions"),
            mock.patch.object(builder, "_OTHER_HOMES", {}),
            mock.patch.object(builder, "_LOG_INDEX", {}),
            mock.patch.object(builder, "_LISTINGS", {}),
            mock.patch.object(builder, "_COPILOT_INDEX", None),
            mock.patch.object(builder, "COPILOT_HOME", self.home / ".copilot"),
            mock.patch.object(builder, "CODEX_SESSIONS", self.home / ".codex" / "sessions"),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self.temp.cleanup)

    def config(self, name, session=None, pid=None, text="hello"):
        """A Claude config folder <name> under the home, with a session's log and, given a pid, the record of its process."""
        folder = self.home / name
        (folder / "projects" / FOLDER).mkdir(parents=True, exist_ok=True)
        (folder / "sessions").mkdir(exist_ok=True)
        if session:
            (folder / "projects" / FOLDER / f"{session}.jsonl").write_text(user_line(text), encoding="utf-8")
        if pid is not None:
            (folder / "sessions" / f"{pid}.json").write_text(json.dumps({"pid": pid, "sessionId": session, "cwd": "/Users/someone/work"}), encoding="utf-8")
        return folder

    # ---------------------------------------------------------------- which folders

    def test_every_dot_claude_folder_with_projects_or_sessions_is_found_and_nothing_else(self):
        self.config(".claude")
        self.config(".claude-personal")
        (self.home / ".claude-org2" / "projects").mkdir(parents=True)
        (self.home / ".claudework" / "sessions").mkdir(parents=True)
        (self.home / ".claude-mem" / "chroma").mkdir(parents=True)  # another tool's folder
        (self.home / ".claude-empty").mkdir()
        (self.home / ".claude.json").write_text("{}")  # a file
        (self.home / "claude-visible" / "projects").mkdir(parents=True)  # not named .claude*
        self.assertEqual([found.name for found in builder.other_claude_homes()], [".claude-org2", ".claude-personal", ".claudework"])

    def test_the_folder_this_process_runs_under_and_the_named_places_count_too(self):
        elsewhere = self.home / "elsewhere" / "claude"
        (elsewhere / "projects").mkdir(parents=True)
        named = self.home / "named"
        (named / "sessions").mkdir(parents=True)
        env = {"CLAUDE_CONFIG_DIR": str(elsewhere), "PMOS_READER_CLAUDE_HOMES": os.pathsep.join([str(named), "relative/path", str(self.home / "missing"), str(elsewhere)])}
        with mock.patch.dict(os.environ, env):
            builder._OTHER_HOMES.clear()
            self.assertEqual(builder.other_claude_homes(), [elsewhere, named], "each once; a relative or missing path is ignored")

    def test_a_folder_made_after_the_last_look_is_found_by_the_next_one(self):
        self.assertEqual(builder.other_claude_homes(), [])
        self.config(".claude-new", FIRST)
        builder._OTHER_HOMES.clear()  # the start of each build, as reader.py and sync.py do
        self.assertEqual([found.name for found in builder.other_claude_homes()], [".claude-new"])

    # -------------------------------------------------------------------- the logs

    def test_a_log_under_another_folder_is_listed_found_and_resolved(self):
        self.config(".claude", FIRST)
        self.config(".claude-personal", SECOND)
        second_log = self.home / ".claude-personal" / "projects" / FOLDER / f"{SECOND}.jsonl"
        self.assertEqual(sorted(log.name for log in builder.all_logs()), sorted([f"{FIRST}.jsonl", f"{SECOND}.jsonl"]))
        self.assertEqual(builder.find_session_file(SECOND), second_log)
        self.assertEqual(builder.find_session_file(FIRST), self.home / ".claude" / "projects" / FOLDER / f"{FIRST}.jsonl")
        self.assertEqual(reader.resolve(SECOND, {}, builder.PROJECTS), SECOND)
        self.assertEqual(reader.resolve(SECOND[:8], {}, builder.PROJECTS), SECOND, "by prefix")
        self.assertEqual(message_link.session_log(SECOND[:8]), second_log)
        with self.assertRaisesRegex(ValueError, "no session log found"):
            reader.resolve(THIRD, {}, builder.PROJECTS)

    def test_a_copy_of_a_log_under_another_folder_never_shadows_the_usual_one(self):
        self.config(".claude", FIRST, text="original")
        self.config(".claude-personal", FIRST, text="copy")
        usual = self.home / ".claude" / "projects" / FOLDER / f"{FIRST}.jsonl"
        self.assertEqual(builder.find_session_file(FIRST), usual)
        self.assertEqual(message_link.session_log(FIRST[:8]), usual)

    def test_the_reading_list_takes_such_a_session_for_follow_and_add(self):
        self.config(".claude-personal", SECOND)
        out = self.home / "out"
        out.mkdir()
        with mock.patch.object(reader, "LIST", out / "sessions.txt"), mock.patch.object(reader, "OUT", out):
            reader.write_list([SECOND])
            self.assertEqual(reader.read_list(), [SECOND])
        self.assertEqual(reader.session_files(builder.PROJECTS, SECOND), [self.home / ".claude-personal" / "projects" / FOLDER / f"{SECOND}.jsonl"])

    def test_a_projects_folder_that_something_else_names_is_read_alone(self):
        self.config(".claude-personal", SECOND)
        lab = self.home / "lab-projects"
        (lab / FOLDER).mkdir(parents=True)
        (lab / FOLDER / f"{FIRST}.jsonl").write_text(user_line("lab"), encoding="utf-8")
        with mock.patch.object(builder, "PROJECTS", lab):
            self.assertEqual(builder.project_roots(), [lab])
            self.assertEqual([log.name for log in builder.all_logs()], [f"{FIRST}.jsonl"])
            self.assertIsNone(builder.find_session_file(SECOND))
            self.assertEqual(reader.session_files(lab, SECOND), [])
        self.assertEqual(reader.session_files(builder.PROJECTS, SECOND)[0].name, f"{SECOND}.jsonl")

    def test_a_home_s_own_sessions_are_found_under_every_folder_its_path_is_named_in(self):
        folder = "-" + "-".join(["Users", "someone", "fleet"])
        for name, session in ((".claude", FIRST), (".claude-personal", SECOND)):
            (self.home / name / "projects" / folder).mkdir(parents=True, exist_ok=True)
            (self.home / name / "projects" / folder / f"{session}.jsonl").write_text(user_line("x"), encoding="utf-8")
            (self.home / name / "sessions").mkdir(exist_ok=True)
        found = builder.home_sessions(Path("/Users/someone/fleet"), since=0)
        self.assertEqual({path.stem for path in found}, {FIRST, SECOND})

    # ------------------------------------------------------- running processes and panes

    def test_the_records_of_running_processes_are_read_from_every_folder(self):
        self.config(".claude", FIRST, pid=os.getpid())
        self.config(".claude-personal", SECOND, pid=os.getppid())
        self.config(".claude-org2", THIRD, pid=999999999)  # its process has ended
        self.assertEqual(builder.running_claude_sessions(), {os.getpid(): FIRST, os.getppid(): SECOND})

    def herdr(self, panes, process):
        replies = {("session", "list"): {"sessions": [{"name": "work", "running": True}]},
                   ("pane", "list"): {"result": {"panes": panes}}, ("tab", "list"): {"result": {"tabs": []}},
                   ("pane", "process-info"): {"result": {"process_info": process}}}
        asked = []

        def fake(argv, **kwargs):
            asked.append(argv[1:])
            key = tuple(argv[3:5] if argv[1] == "--session" else argv[1:3])
            answer = replies.get(key)
            return mock.Mock(returncode=0 if answer is not None else 1, stdout=json.dumps(answer) if answer is not None else "")

        return fake, asked

    def test_a_claude_pane_herdr_gave_no_session_runs_the_session_of_its_process_under_another_folder(self):
        self.config(".claude-personal", SECOND, pid=os.getpid())
        pane = {"pane_id": "w1:p2", "tab_id": "w1:t2", "agent": "claude", "agent_status": "done", "label": "cp-search"}  # no agent_session
        process = {"foreground_processes": [{"pid": os.getpid(), "argv0": "claude", "cwd": "/Users/someone/work"}]}
        fake, asked = self.herdr([pane], process)
        with mock.patch.object(builder.subprocess, "run", fake):
            found, listed = builder.herdr_inventory()
        self.assertEqual(list(found), [SECOND])
        self.assertEqual((found[SECOND]["label"], found[SECOND]["status"], found[SECOND]["pane"]), ("cp-search", "done", "w1:p2"))
        self.assertEqual(listed, {("work", "w1:p2")})
        commands = [tuple(call[2:4] if call[0] == "--session" else call[:2]) for call in asked]
        self.assertEqual(commands, [("session", "list"), ("pane", "list"), ("tab", "list"), ("pane", "process-info")], "Herdr was only read")

    def test_a_claude_pane_whose_process_has_no_record_in_any_folder_stays_without_a_session(self):
        self.config(".claude-personal", SECOND, pid=os.getpid())
        pane = {"pane_id": "w1:p2", "tab_id": "w1:t2", "agent": "claude", "agent_status": "idle", "label": "cp-search"}
        process = {"foreground_processes": [{"pid": 999999998, "argv0": "claude"}]}
        fake, _ = self.herdr([pane], process)
        with mock.patch.object(builder.subprocess, "run", fake):
            found, _ = builder.herdr_inventory()
        self.assertEqual(found, {}, "never guessed from a label or a folder")


if __name__ == "__main__":
    unittest.main()
