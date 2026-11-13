"""Tests for reading GitHub Copilot CLI sessions: the parser for a session's events.jsonl, finding a session by its folder, and
mapping a Herdr pane to the session its Copilot process shows.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_copilot.py
Fixtures are invented text in the shape of Copilot's own files (session-state/<id>/events.jsonl and logs/process-<start>-<pid>.log):
no real conversation is copied into them.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reader  # noqa: E402
from reader import builder  # noqa: E402

SID = "aaaaaaaa-1111-4222-8333-444444444444"
OTHER = "bbbbbbbb-1111-4222-8333-444444444444"
THIRD = "cccccccc-1111-4222-8333-444444444444"
CWD = "/work/demo"
START = 1793858520238  # the process start in ms, as the log file name carries it


def stamp(second):
    return f"2026-11-05T05:{second // 60:02d}:{second % 60:02d}.000Z"


def event(kind, second, **data):
    return {"type": kind, "data": data, "id": f"e-{kind}-{second}", "timestamp": stamp(second), "parentId": None}


def start_event(sid=SID, cwd=CWD):
    return event("session.start", 0, sessionId=sid, version=1, producer="copilot-agent", context={"cwd": cwd, "gitRoot": cwd, "branch": "main"})


def message_id(second):
    return f"{second:08d}-0000-4000-8000-000000000000"


def typed(text, second, delivery="idle", **extra):
    # content is what was typed; transformedContent is what the model got (the date and any skill text around it).
    return event("user.message", second, content=text, transformedContent="<current_datetime>x</current_datetime>\n\n" + text,
                 messageId=message_id(second), delivery=delivery, attachments=[], **extra)


def reply(second, content="", tools=(), thought="", phase=None):
    data = {"messageId": f"a-{second}", "model": "m", "content": content, "toolRequests": list(tools), "reasoningOpaque": "OPAQUE-SECRET",
            "encryptedContent": "ENCRYPTED-SECRET", "turnId": "0"}
    if thought:
        data["reasoningText"] = thought
    if phase:
        data["phase"] = phase
    return event("assistant.message", second, **data)


def request(call_id, name, arguments):
    return {"toolCallId": call_id, "name": name, "arguments": arguments, "type": "function"}


def done(call_id, second, content="ok", **extra):
    return event("tool.execution_complete", second, toolCallId=call_id, success=True, result={"content": content}, **extra)


def write_session(home, sid, records, cwd=CWD):
    folder = Path(home) / "session-state" / sid
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "events.jsonl"
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
    return path


def exchanges_of(records):
    return builder.copilot_session_exchanges(iter(records))


class CopilotParserTest(unittest.TestCase):
    def test_a_turn_is_the_typed_message_its_steps_and_its_final_answer(self):
        records = [
            start_event(),
            typed("Please check the build", 5),
            reply(6, tools=[request("c1", "bash", {"command": "make test", "description": "Run the tests"})]),
            event("tool.execution_start", 7, toolCallId="c1", toolName="bash", arguments={"command": "make test"}),
            done("c1", 8, "3 passed", shellExecution={"exitCode": 0}),
            reply(9, tools=[request("c2", "view", {"path": "/work/demo/notes.md", "view_range": [1, 5]})]),
            done("c2", 10, "1. line"),
            reply(11, "The build is green.\n\nAll three tests pass.", phase="final_answer"),
        ]
        (turn,) = exchanges_of(records)
        self.assertEqual((turn["source"], turn["kind"], turn["label"]), ("captain", "message", "You"))
        self.assertEqual(turn["input"], "Please check the build")  # not transformedContent
        self.assertEqual(turn["reply"], "The build is green.\n\nAll three tests pass.")
        self.assertEqual(turn["uid"], message_id(5))  # the session log's own message id, which never changes
        self.assertEqual(turn["cwd"], CWD)
        steps = turn["steps"]
        self.assertEqual([(s["k"], s["n"], s["s"]) for s in steps], [("ran", "bash", "Run the tests"), ("read", "view", "/work/demo/notes.md")])
        self.assertEqual(steps[0]["c"], "make test")
        self.assertEqual(steps[0]["out"], "3 passed")
        self.assertNotIn("f", steps[0])
        self.assertEqual(turn["touched"], ["/work/demo/notes.md"])

    def test_steps_use_the_tools_of_copilot_in_their_own_words(self):
        records = [start_event(), typed("go", 1), reply(2, tools=[
            request("a", "rg", {"pattern": "TODO", "paths": ["/work/demo/src"], "output_mode": "content"}),
            request("b", "glob", {"pattern": "**/*.md", "paths": ["/work/demo"]}),
            request("c", "web_fetch", {"url": "https://example.com/x", "max_length": 6000}),
            request("d", "tool_search_tool", {"query": "open a browser page"}),
            request("e", "skill", {"skill": "teach"}),
            request("f", "task", {"description": "Find the opener", "agent_type": "explore", "name": "scout", "prompt": "Look for it"}),
            request("g", "ask_user", {"message": "Which market first?", "requestedSchema": {"properties": {}}}),
            request("h", "read_bash", {"shellId": "3", "delay": 0}),
            request("i", "runPlaywrightCode", {"pageId": "p", "code": "await page.title()"}),
        ])]
        (turn,) = exchanges_of(records)
        shown = [(s["k"], s["n"], s["s"]) for s in turn["steps"]]
        self.assertEqual(shown, [
            ("searched", "rg", "TODO in /work/demo/src"),
            ("searched", "glob", "**/*.md in /work/demo"),
            ("searched", "web_fetch", "https://example.com/x"),
            ("searched", "tool_search_tool", "open a browser page"),
            ("skill", "skill", "teach"),
            ("agent", "task", "Find the opener"),
            ("asked", "ask_user", "Which market first?"),
            ("ran", "read_bash", "Check a background command"),
            ("other", "runPlaywrightCode", "runPlaywrightCode"),
        ])

    def test_a_failed_call_and_a_nonzero_exit_are_failed_steps(self):
        records = [start_event(), typed("run both", 1), reply(2, tools=[
            request("a", "bash", {"command": "false"}), request("b", "skill", {"skill": "missing"})]),
            done("a", 3, "", shellExecution={"exitCode": 1}),
            event("tool.execution_complete", 3, toolCallId="b", success=False, error={"message": "Skill not found: missing", "code": "failure"}),
            reply(4, "Both failed.")]
        (turn,) = exchanges_of(records)
        self.assertEqual([s.get("f") for s in turn["steps"]], [1, 1])
        self.assertEqual(turn["steps"][1]["t"], "Skill not found: missing")

    def test_a_call_with_no_request_still_makes_a_step_from_its_start(self):
        records = [start_event(), typed("remember this", 1), event("tool.execution_start", 2, toolCallId="m1", toolName="copilot_memory"),
                   done("m1", 3, "saved"), reply(4, "Noted.")]
        (turn,) = exchanges_of(records)
        self.assertEqual([(s["k"], s["n"]) for s in turn["steps"]], [("other", "copilot_memory")])

    def test_a_patch_makes_a_step_for_each_file_with_the_diff_a_claude_edit_has(self):
        patch = "\n".join([
            "*** Begin Patch",
            "*** Add File: docs/new.md",
            "+# New",
            "+",
            "+text",
            "*** Update File: src/app.py",
            "@@",
            " keep",
            "-old = 1",
            "+old = 2",
            "@@ def later():",
            "-x",
            "+y",
            "*** Delete File: old.txt",
            "*** End Patch",
        ])
        records = [start_event(), typed("edit", 1), reply(2, tools=[request("p", "apply_patch", patch)]),
                   done("p", 3, "Added 1 file(s), updated 1"), reply(4, "Edited.")]
        (turn,) = exchanges_of(records)
        added, updated, deleted = turn["steps"]
        self.assertEqual((added["k"], added["p"], added["a"]), ("wrote", "/work/demo/docs/new.md", 3))
        self.assertEqual((updated["k"], updated["p"], updated["a"], updated["r"]), ("edited", "/work/demo/src/app.py", 2, 2))
        self.assertEqual(updated["d"], " keep\n-old = 1\n+old = 2\n~\n-x\n+y")
        self.assertEqual((deleted["k"], deleted["s"]), ("other", "Delete /work/demo/old.txt"))
        self.assertEqual({s["n"] for s in turn["steps"]}, {"apply_patch"})
        self.assertIn("/work/demo/docs/new.md", turn["touched"])
        # A patch that failed fails every file it names.
        records[3] = event("tool.execution_complete", 3, toolCallId="p", success=False, error={"message": "Patch does not apply", "code": "failure"})
        (turn,) = exchanges_of(records)
        self.assertEqual([s.get("f") for s in turn["steps"]], [1, 1, 1])

    def test_a_secret_path_in_a_patch_keeps_no_text(self):
        patch = "*** Begin Patch\n*** Add File: .env\n+TOKEN=made-up-value\n*** End Patch"
        records = [start_event(), typed("x", 1), reply(2, tools=[request("p", "apply_patch", patch)]), done("p", 3), reply(4, "Done.")]
        (turn,) = exchanges_of(records)
        self.assertEqual(turn["steps"][0].get("h"), 1)
        self.assertNotIn("made-up-value", json.dumps(turn))

    def test_a_patch_that_moves_a_file_to_or_from_a_secret_path_keeps_no_text(self):
        for source, target in (("notes/a.md", ".env"), (".npmrc", "notes/b.md")):
            patch = f"*** Begin Patch\n*** Update File: {source}\n*** Move to: {target}\n@@\n-old made-up-value\n+new made-up-value\n*** End Patch"
            records = [start_event(), typed("x", 1), reply(2, tools=[request("p", "apply_patch", patch)]), done("p", 3, "made-up-value"), reply(4, "Done.")]
            (turn,) = exchanges_of(records)
            with self.subTest(source=source, target=target):
                self.assertEqual(turn["steps"][0].get("h"), 1)
                self.assertNotIn("made-up-value", json.dumps(turn))
        blocks = builder.tool_steps.patch_blocks("*** Begin Patch\n*** Update File: a.py\n*** Move to: b.py\n-x\n+y\n*** End Patch", "/w")
        self.assertEqual(blocks[0]["input"]["move_to"], "/w/b.py")

    def test_a_search_naming_a_secret_place_among_several_keeps_no_output(self):
        for args in ({"pattern": "KEY", "paths": ["/work/demo/src", "/home/me/.ssh"]}, {"pattern": "KEY", "paths": ["/work/demo/src"], "glob": "**/.env"}):
            records = [start_event(), typed("x", 1), reply(2, tools=[request("a", "rg", args)]), done("a", 3, "id_rsa: made-up-secret"), reply(4, "Done.")]
            (turn,) = exchanges_of(records)
            with self.subTest(args=args):
                self.assertEqual(turn["steps"][0].get("h"), 1)
                self.assertNotIn("made-up-secret", json.dumps(turn))
        (turn,) = exchanges_of([start_event(), typed("x", 1), reply(2, tools=[request("a", "rg", {"pattern": "k", "paths": ["/w/a", "/w/b"]})]), done("a", 3, "hit"), reply(4, "ok")])
        self.assertEqual((turn["steps"][0].get("h"), turn["steps"][0]["out"]), (None, "hit"))

    def test_reasoning_before_a_step_is_a_working_note_and_the_one_before_the_answer_is_not_part_of_the_reply(self):
        records = [
            start_event(), typed("explain", 1),
            reply(2, thought="**Planning the check**\n\nI will look at the file first.", tools=[request("a", "view", {"path": "/work/demo/a.md"})]),
            done("a", 3, "text"),
            reply(4, content="Looking at what it says.", tools=[request("b", "view", {"path": "/work/demo/b.md"})], phase="commentary"),
            done("b", 5, "text"),
            reply(6, thought="**Writing it up**\n\nNow the answer.", content="Here is the answer.", phase="final_answer"),
        ]
        (turn,) = exchanges_of(records)
        self.assertEqual(turn["narration"], ["Planning the check\n\nI will look at the file first.", "Looking at what it says."])
        self.assertEqual(turn["reply"], "Here is the answer.")
        self.assertEqual([s["o"] for s in turn["steps"]], [1, 2])  # notes before each step, which the page draws between the runs

    def test_encrypted_reasoning_and_the_system_prompt_are_never_read(self):
        records = [start_event(), event("system.message", 0, role="system", content="SYSTEM-PROMPT-TEXT"),
                   event("hook.start", 1, hookType="sessionStart", input={"initialPrompt": "HOOK-TEXT"}),
                   typed("hello", 2), reply(3, "Hi."), event("session.usage_record", 4, usage={"model": "m"})]
        found = json.dumps(exchanges_of(records))
        for secret in ("OPAQUE-SECRET", "ENCRYPTED-SECRET", "SYSTEM-PROMPT-TEXT", "HOOK-TEXT"):
            self.assertNotIn(secret, found)

    def test_a_message_sent_while_the_agent_was_busy_starts_an_absorbed_turn(self):
        records = [start_event(), typed("start the long job", 1), reply(2, tools=[request("a", "bash", {"command": "sleep 1"})]),
                   typed("also mention the date", 3, delivery="steering"), done("a", 4), reply(5, "Done, dated Nov 5.")]
        first, second = exchanges_of(records)
        self.assertEqual((first["absorbed"], second["absorbed"]), (False, True))
        self.assertTrue(first["answered_below"])
        self.assertEqual(second["reply"], "Done, dated Nov 5.")

    def test_a_helper_agents_own_events_stay_out_of_the_conversation(self):
        helper = {"agentId": "h1"}
        records = [start_event(), typed("find it", 1),
                   reply(2, tools=[request("t", "task", {"description": "Find it", "agent_type": "explore", "prompt": "Look"})]),
                   {**typed("Look", 3, source=f"agent-{SID}"), **helper},
                   {**reply(4, "HELPER-ANSWER"), **helper},
                   done("t", 5, "Found it."), reply(6, "It is in src/.")]
        (turn,) = exchanges_of(records)
        self.assertEqual(turn["reply"], "It is in src/.")
        self.assertEqual([s["k"] for s in turn["steps"]], ["agent"])
        self.assertNotIn("HELPER-ANSWER", json.dumps(turn))

    def test_a_compaction_leaves_a_divider_and_the_running_turn_goes_on(self):
        records = [start_event(), typed("big job", 1), reply(2, tools=[request("a", "bash", {"command": "ls"})]),
                   event("session.compaction_complete", 3, success=True, summaryContent="SUMMARY"),
                   done("a", 4, "files"), reply(5, "Finished the big job.")]
        turn, divider = exchanges_of(records)
        self.assertEqual((divider["source"], divider["kind"], divider["label"]), ("session", "compacted", "Earlier context was summarised"))
        self.assertEqual(turn["reply"], "Finished the big job.")
        self.assertNotIn("SUMMARY", json.dumps(divider))
        records[3] = event("session.compaction_complete", 3, success=False)
        self.assertEqual(len(exchanges_of(records)), 1)

    def test_the_newest_turn_without_a_reply_stays_open_and_a_wakeup_like_message_is_classified_as_any_other(self):
        (turn,) = exchanges_of([start_event(), typed("still going", 1), reply(2, tools=[request("a", "bash", {"command": "ls"})])])
        self.assertFalse(turn["folded"])
        self.assertEqual(turn["reply"], "")
        doorbell = typed("Firstmate instruction waiting: read '/h/state/x.inbox'", 1)
        self.assertEqual(exchanges_of([start_event(), doorbell, reply(2, "On it.")])[0]["label"], "Firstmate: instruction")


class CopilotFilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.patches = [mock.patch.object(builder, "COPILOT_HOME", self.home), mock.patch.object(builder, "_COPILOT_INDEX", None)]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.temp.cleanup()

    def test_a_session_is_found_by_the_folder_that_holds_its_events(self):
        path = write_session(self.home, SID, [start_event(), typed("hello", 1), reply(2, "Hi.")])
        write_session(self.home, OTHER, [typed("no start record", 1)])  # not a session the reader accepts
        (self.home / "session-state" / THIRD).mkdir()  # a session that has no events yet
        self.assertEqual(builder.copilot_metadata(path), {"session": SID, "cwd": CWD, "timestamp": stamp(0)})
        self.assertTrue(builder.is_copilot_log(path))
        self.assertFalse(builder.is_copilot_log(self.home / "session-state" / OTHER / "events.jsonl"))
        self.assertEqual(builder.find_session_file(SID), path)
        self.assertEqual(builder.find_session_file(str(path)), path)
        self.assertIsNone(builder.find_session_file(THIRD))
        self.assertEqual(builder.copilot_session_files("aaaa"), [path])
        self.assertEqual(builder.copilot_session_files("zzzz"), [])

    def test_the_session_id_is_the_folder_not_the_file_name(self):
        path = write_session(self.home, SID, [start_event()])
        self.assertEqual(builder.log_key(path), SID)
        self.assertEqual(builder.log_session_id(path), SID)
        self.assertEqual(builder.canonical_session_id(str(path)), SID)
        claude = Path("/home/.claude/projects/-x/" + SID + ".jsonl")
        self.assertEqual((builder.log_key(claude), builder.log_session_id(claude)), (SID, SID))
        # A file named events.jsonl in some other folder is not a session.
        self.assertEqual(builder.log_key(Path("/tmp/x/events.jsonl")), "events")
        self.assertIsNone(builder.canonical_session_id("/tmp/x/events.jsonl"))

    def test_a_session_log_parses_to_turns_with_its_folder_for_the_cache_and_its_cwd(self):
        path = write_session(self.home, SID, [start_event(), typed("hello", 1), reply(2, "Hi there.")])
        cache = self.home / "parsed"
        cache.mkdir()
        parsed = builder.parsed_log(path, cache)
        self.assertEqual((parsed["cwd"], parsed["exchanges"][0]["reply"]), (CWD, "Hi there."))
        self.assertTrue((cache / f"{SID}.json").is_file(), "cached under the session id, not under `events`")
        self.assertEqual(builder.parsed_log(path, cache)["exchanges"][0]["reply"], "Hi there.")
        self.assertEqual(builder.session_chain(path), [path])

    def test_the_conversation_is_marked_as_a_copilot_session_and_a_claude_one_is_not(self):
        path = write_session(self.home, SID, [start_event(), typed("hello", 1), reply(2, "Hi.")])
        home = {"id": "main", "home": Path("/nonexistent/home")}
        loaded = {path: builder.parsed_log(path, None)}
        session = builder.thread_session(home, [path], loaded, None)
        self.assertEqual((session["id"], session["ids"], session["agent"]), (SID, [SID], "copilot"))
        claude = Path(self.temp.name) / f"{OTHER}.jsonl"
        claude.write_text(json.dumps({"type": "user", "timestamp": stamp(1), "cwd": CWD, "message": {"role": "user", "content": "hi"}}) + "\n")
        self.assertNotIn("agent", builder.thread_session(home, [claude], {claude: builder.parsed_log(claude, None)}, None))


class CopilotPaneTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        (self.home / "logs").mkdir()
        self.store = self.home / "out" / "copilot-panes.json"
        self.patches = [mock.patch.object(builder, "COPILOT_HOME", self.home), mock.patch.object(builder, "_COPILOT_INDEX", None),
                        mock.patch.object(builder, "COPILOT_PANES_FILE", self.store), mock.patch.dict(builder._COPILOT_LOG_SCAN, clear=True),
                        mock.patch.dict(builder._COPILOT_SEEN, clear=True)]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.temp.cleanup()

    def log(self, pid, lines, name=None, start=START):
        path = self.home / "logs" / (name or f"process-{start}-{pid}.log")
        path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        return path

    @staticmethod
    def registering(sid, second):
        return f"{stamp(second)[:-1]}Z [INFO] Registering foreground session: {sid}"

    def session(self, sid, with_events=True):
        write_session(self.home, sid, [start_event(sid)]) if with_events else (self.home / "session-state" / sid).mkdir(parents=True)

    def pane(self, pid, argv0="copilot"):
        return {"foreground_processes": [{"pid": 11, "argv0": "security", "cwd": "/bin"}, {"pid": pid, "argv0": argv0, "cwd": CWD}]}

    def test_only_a_process_named_copilot_counts(self):
        self.assertTrue(builder.copilot_process({"argv0": "copilot"}))
        self.assertTrue(builder.copilot_process({"argv0": "/usr/local/bin/copilot"}))
        self.assertTrue(builder.copilot_process({"cmdline": "/home/me/.local/bin/copilot --resume"}))
        self.assertFalse(builder.copilot_process({"argv0": "gh", "cmdline": "gh auth token"}))
        self.assertFalse(builder.copilot_process({"argv0": "copilot-language-server"}))
        self.assertFalse(builder.copilot_process({}))

    def test_the_newest_session_the_process_log_registered_is_the_pane_session(self):
        self.session(SID)
        self.session(OTHER)
        self.log(500, [self.registering(SID, 1), "other noise", self.registering(OTHER, 20), "Unregistering foreground session: x"])
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), OTHER)

    def test_the_line_in_the_rotated_log_still_counts_when_the_current_log_has_none(self):
        self.session(SID)
        self.log(500, ["only noise in the file after the rotation"])
        self.log(500, [self.registering(SID, 1)], name=f"process-{START}-500.1.log")
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), SID)

    def test_the_newest_line_wins_by_its_time_not_by_which_file_holds_it(self):
        self.session(SID)
        self.session(OTHER)
        self.log(500, [self.registering(OTHER, 30)])
        self.log(500, [self.registering(SID, 5)], name=f"process-{START}-500.1.log")
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), OTHER)

    def test_only_the_latest_process_to_have_had_the_pid_is_read(self):
        self.session(SID)
        self.session(OTHER)
        self.log(500, [self.registering(SID, 1)], start=START - 99999)
        self.log(500, [self.registering(OTHER, 2)])
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), OTHER)

    def test_a_look_reads_only_what_the_log_gained_and_keeps_a_session_after_the_log_is_rotated_away(self):
        self.session(SID)
        self.session(OTHER)
        path = self.log(500, [self.registering(SID, 1)])
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), SID)
        with path.open("a", encoding="utf-8") as handle:  # a /resume
            handle.write(self.registering(OTHER, 40) + "\n")
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), OTHER)
        self.assertEqual(builder._COPILOT_LOG_SCAN[path][1], path.stat().st_size)
        self.log(500, ["a fresh log after the rotation, with no id in it"])  # the file is replaced by a shorter one
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), OTHER, "what an earlier look saw stands until a newer line says otherwise")

    def test_a_log_rotated_and_grown_past_its_old_size_is_read_from_its_start(self):
        self.session(SID)
        self.session(OTHER)
        path = self.log(500, [self.registering(SID, 1)])
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), SID)
        fresh = path.with_name("fresh.tmp")  # the rotation: another file at the name, already bigger than the one looked at
        fresh.write_text(self.registering(OTHER, 50) + "\n" + "noise\n" * 500, encoding="utf-8")
        os.replace(fresh, path)
        self.assertGreater(path.stat().st_size, 0)
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), OTHER)

    def test_a_later_look_in_another_process_reads_what_an_earlier_one_wrote_down(self):
        self.session(SID)
        path = self.log(500, [self.registering(SID, 1)])
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), SID)
        self.assertEqual(json.loads(self.store.read_text()), {f"{START}-500": {"at": stamp(1)[:-1] + "Z", "session": SID}})
        builder._COPILOT_LOG_SCAN.clear()
        builder._COPILOT_SEEN.clear()
        self.log(500, ["the log after two rotations says nothing"])
        self.assertTrue(path.is_file())
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), SID)

    def test_the_lock_names_the_session_only_when_nothing_else_does_and_only_with_a_conversation(self):
        self.session(SID)
        (self.home / "session-state" / SID / "inuse.500.lock").write_text("500")
        self.session(OTHER, with_events=False)  # started, never typed in: no conversation to read
        (self.home / "session-state" / OTHER / "inuse.501.lock").write_text("501")
        self.assertEqual(builder.copilot_pane_session(self.pane(500)), SID)
        self.assertIsNone(builder.copilot_pane_session(self.pane(501)))
        self.assertIsNone(builder.copilot_pane_session(self.pane(502)), "no log and no lock: never guessed")

    def test_a_registered_session_whose_folder_is_gone_falls_back_instead_of_naming_it(self):
        self.log(500, [self.registering(SID, 1)])
        self.assertIsNone(builder.copilot_pane_session(self.pane(500)))

    def test_a_pane_whose_foreground_is_not_copilot_maps_to_nothing(self):
        self.session(SID)
        self.log(500, [self.registering(SID, 1)])
        self.assertIsNone(builder.copilot_pane_session(self.pane(500, argv0="zsh")))
        self.assertIsNone(builder.copilot_pane_session(None))

    def test_herdr_inventory_gives_a_copilot_pane_the_session_its_process_shows(self):
        self.session(SID)
        self.log(500, [self.registering(SID, 1)])
        panes = [{"pane_id": "w1:p1", "tab_id": "w1:t1", "agent": "copilot", "agent_status": "idle", "label": "cp-learning",
                  "terminal_title_stripped": "Learning the proposal"}]
        replies = {("session", "list"): {"sessions": [{"name": "work", "running": True}]},
                   ("pane", "list"): {"result": {"panes": panes}}, ("tab", "list"): {"result": {"tabs": []}},
                   ("pane", "process-info"): {"result": {"process_info": self.pane(500)}}}
        asked = []

        def fake(argv, **kwargs):
            asked.append(argv[1:])
            key = tuple(argv[3:5] if argv[1] == "--session" else argv[1:3])
            reply_ = replies.get(key)
            return mock.Mock(returncode=0 if reply_ is not None else 1, stdout=json.dumps(reply_) if reply_ is not None else "")

        with mock.patch.object(builder.subprocess, "run", fake), mock.patch.object(builder, "running_claude_sessions", lambda: {}):
            found, listed = builder.herdr_inventory()
        self.assertEqual(list(found), [SID])
        self.assertEqual((found[SID]["label"], found[SID]["status"], found[SID]["pane"]), ("cp-learning", "idle", "w1:p1"))
        self.assertEqual(listed, {("work", "w1:p1")})
        # Reading only: Herdr was asked to list sessions, panes and tabs and to describe the pane, nothing else.
        commands = [tuple(call[2:4] if call[0] == "--session" else call[:2]) for call in asked]
        self.assertEqual(commands, [("session", "list"), ("pane", "list"), ("tab", "list"), ("pane", "process-info")])


class CopilotReadingListTest(unittest.TestCase):
    """The reading list and `reader.py add` take a Copilot session by id, prefix or events.jsonl path, like any other."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.projects = self.home / "claude-projects"
        self.projects.mkdir()
        self.path = write_session(self.home, SID, [start_event(), typed("hello", 1), reply(2, "Hi.")])
        self.patches = [mock.patch.object(builder, "COPILOT_HOME", self.home), mock.patch.object(builder, "_COPILOT_INDEX", None)]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.temp.cleanup()

    def test_a_session_resolves_by_id_by_prefix_and_by_path(self):
        for name in (SID, SID[:8], str(self.path)):
            with self.subTest(name=name):
                self.assertEqual(reader.resolve(name, {}, self.projects), SID)
        with self.assertRaisesRegex(ValueError, "no session log found"):
            reader.resolve(OTHER, {}, self.projects)

    def test_the_list_keeps_a_copilot_session_by_its_id(self):
        out = self.home / "sessions.txt"
        with mock.patch.object(reader, "LIST", out):
            reader.write_list([SID, str(self.path), SID])
            self.assertEqual(out.read_text(), SID + "\n")
            self.assertEqual(reader.read_list(), [SID])
        self.assertEqual(reader.chain_members(SID), {SID})


if __name__ == "__main__":
    unittest.main()
