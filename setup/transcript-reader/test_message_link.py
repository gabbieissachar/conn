"""Tests for message_link.py: the reader's address of the first agent reply that holds some text.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_message_link.py
Fixtures are synthetic session logs under a scratch folder (PMOS_READER_PROJECTS); no real log, Herdr or Tailscale is read.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMMAND = HERE / "message_link.py"
ADDRESS_JS = HERE / "prototype" / "address.js"

OLD = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"  # the session /clear left
NEW = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"  # the session /clear started
BASE = datetime(2026, 10, 23, 10, 0, 0, tzinfo=timezone.utc).timestamp()
ASK = "Still need a call.\n\nL17= land the pool-full help? (a) yes (b) no"
REMIND = "Reminder.\n\nL17= is still open: land the pool-full help."
SECRET = "words that must never be printed"


def iso(second):
    return datetime.fromtimestamp(BASE + second, timezone.utc).isoformat().replace("+00:00", "Z")


def user(uid, text, second):
    return {"type": "user", "uuid": uid, "timestamp": iso(second), "message": {"role": "user", "content": text}}


def say(text, second):
    return {"type": "assistant", "timestamp": iso(second), "cwd": "/repo", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def wake(uid, second):
    return {"type": "user", "uuid": uid, "timestamp": iso(second), "message": {"role": "user", "content": "<task-notification>\nsignal: build done\n</task-notification>"}}


class Lab(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="message-link-"))
        self.projects = self.folder / "projects"
        (self.projects / "p1").mkdir(parents=True)
        self.bin = self.folder / "bin"
        self.bin.mkdir()

    def tearDown(self):
        shutil.rmtree(self.folder, ignore_errors=True)

    def log(self, sid, records, written=None):
        path = self.projects / "p1" / f"{sid}.jsonl"
        path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        if written is not None:
            os.utime(path, (BASE + written, BASE + written))
        return path

    def conversation(self):
        """A conversation that was cleared once: the question L17 is asked in the old session, and reminded of in the new one."""
        self.log(OLD, [
            user("a0000001-0000-4000-8000-000000000001", "What is open? I would answer L17= later", 0), say("Nothing yet.", 1),
            user("a0000002-0000-4000-8000-000000000002", "go on", 10), say(ASK, 11),
            user("a0000003-0000-4000-8000-000000000003", "L17=a", 20), say(f"Landing it. {SECRET}", 21),
        ], written=40)
        self.log(NEW, [
            user("b0000001-0000-4000-8000-000000000001", "<command-name>/clear</command-name>\n<command-message>clear</command-message>", 60),
            user("b0000002-0000-4000-8000-000000000002", "what is waiting?", 70), say(REMIND, 71),
        ], written=80)

    def tailscale(self, name="mac-mini.tail1234.ts.net."):
        script = self.bin / "tailscale"
        script.write_text("#!/bin/sh\nprintf '%s' '" + json.dumps({"Self": {"DNSName": name}}) + "'\n", encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        return script

    def run_command(self, *args, tailscale="ok", env=None):
        run_env = {**os.environ, "PMOS_READER_PROJECTS": str(self.projects), "HOME": str(self.folder)}
        for name in ("PMOS_READER_PORT", "PMOS_READER_HTTPS_PORT", "PMOS_READER_TAILSCALE"):
            run_env.pop(name, None)
        if tailscale == "ok":
            run_env["PMOS_READER_TAILSCALE"] = str(self.tailscale())
        elif tailscale == "none":
            run_env["PMOS_READER_TAILSCALE"] = str(self.folder / "no-such-tailscale")
        run_env.update(env or {})
        return subprocess.run([sys.executable, "-I", str(COMMAND), *args], capture_output=True, text=True, env=run_env, timeout=60)

    def lines(self, done):
        self.assertEqual(done.returncode, 0, done.stderr)
        found = dict(line.split(": ", 1) for line in done.stdout.splitlines())
        return {key: value.strip() for key, value in found.items()}


class FirstAgentReply(Lab):
    def test_the_first_reply_that_holds_the_text_is_the_one_addressed(self):
        self.conversation()
        done = self.run_command(NEW[:8], "L17=")
        found = self.lines(done)
        # The question in the old session, not the reminder in the new one.
        self.assertTrue(found["local"].endswith("#s=11111111&m=a0000002-000"), found["local"])
        self.assertIn("warning: 'L17=' appears in 2 agent replies", done.stderr)
        self.assertIn("session 11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa time 2026-10-23T10:00:11Z message a0000002-0000-4000-8000-000000000002", done.stderr)
        self.assertIn("session 22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb time 2026-10-23T10:01:11Z message b0000002-0000-4000-8000-000000000002", done.stderr)
        self.assertNotIn(SECRET, done.stderr)

    def test_a_from_session_scope_starts_at_that_session(self):
        self.conversation()
        done = self.run_command(NEW[:8], "--from-session", NEW[:8], "L17=")
        found = self.lines(done)
        self.assertTrue(found["local"].endswith("#s=22222222&m=b0000002-000"), found["local"])
        self.assertNotIn("warning:", done.stderr)

    def test_a_since_scope_starts_at_that_reply_time(self):
        self.conversation()
        done = self.run_command(NEW[:8], "--since", "2026-10-23T10:01:00Z", "L17=")
        found = self.lines(done)
        self.assertTrue(found["local"].endswith("#s=22222222&m=b0000002-000"), found["local"])
        self.assertNotIn("warning:", done.stderr)

    def test_a_scope_session_must_be_in_the_chain(self):
        self.conversation()
        done = self.run_command(NEW[:8], "--from-session", "33333333", "L17=")
        self.assertEqual((done.returncode, done.stdout), (1, ""))
        self.assertIn("no session in that conversation starts with 33333333", done.stderr)

    def test_an_invalid_since_value_is_a_command_line_error(self):
        self.conversation()
        done = self.run_command(NEW[:8], "--since", "not-a-date", "L17=")
        self.assertEqual((done.returncode, done.stdout), (2, ""))
        self.assertIn("invalid --since value", done.stderr)

    def test_a_scoped_address_keeps_the_message_id_unique_across_the_full_chain(self):
        first = "abcdefabcdef-1111-4000-8000-000000000001"
        second = "abcdefabcdef-2222-4000-8000-000000000002"
        self.log(OLD, [user(first, "go", 0), say("Q= old", 1)], written=40)
        self.log(NEW, [user(second, "<command-name>/clear</command-name>\n<command-message>clear</command-message>", 60), say("Q= new", 61)], written=80)
        done = self.run_command(NEW[:8], "--from-session", NEW[:8], "Q=")
        found = self.lines(done)
        self.assertTrue(found["local"].endswith("&m=abcdefabcdef-2"), found["local"])

    def test_only_the_agents_replies_are_looked_in(self):
        self.conversation()
        # The owner's own words hold "L17=" first (turn 1) and "L17=a" (turn 3); the agent's first mention is the question.
        found = self.lines(self.run_command(OLD[:8], "L17="))
        self.assertIn("m=a0000002", found["local"])
        # Text only the owner wrote matches no reply.
        done = self.run_command(OLD[:8], "I would answer")
        self.assertEqual((done.returncode, done.stdout), (1, ""))
        self.assertIn("no reply from the agent", done.stderr)

    def test_a_reply_inside_a_folded_wake_up_turn_is_found_like_any_other(self):
        self.log(OLD, [user("c0000001-0000-4000-8000-000000000001", "hello", 0), say("Hi.", 1), wake("c0000002-0000-4000-8000-000000000002", 10), say("Build done. R1= land the reader change?", 11)])
        found = self.lines(self.run_command(OLD[:8], "R1="))
        self.assertIn("m=c0000002", found["local"])

    def test_a_later_turn_is_found_when_the_text_is_only_there(self):
        self.conversation()
        found = self.lines(self.run_command(NEW[:8], "is still open"))
        self.assertTrue(found["local"].endswith("#s=22222222&m=b0000002-000"), found["local"])

    def test_the_match_is_exact_text(self):
        self.conversation()
        self.assertEqual(self.run_command(NEW[:8], "l17=").returncode, 1)  # case matters
        self.assertEqual(self.run_command(NEW[:8], "L17 =").returncode, 1)

    def test_a_turn_that_only_narrates_before_a_tool_is_not_a_reply(self):
        tool = {"type": "assistant", "timestamp": iso(2), "cwd": "/repo", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "Working on L17= now."}, {"type": "tool_use", "id": "t", "name": "Bash", "input": {"command": "ls"}}]}}
        self.log(OLD, [user("d0000001-0000-4000-8000-000000000001", "go", 0), tool, user("d0000002-0000-4000-8000-000000000002", "again", 5), say("Done. L17= is landed.", 6)])
        found = self.lines(self.run_command(OLD[:8], "L17="))
        self.assertIn("m=d0000002", found["local"])


class ChainSessions(Lab):
    def test_the_conversation_is_the_session_and_the_ones_the_pane_ran_before_and_after(self):
        self.conversation()
        from_new = self.lines(self.run_command(NEW[:8], "L17="))
        from_old = self.lines(self.run_command(OLD[:8], "L17="))
        self.assertEqual(from_new, from_old)
        self.assertIn("#s=11111111&", from_new["local"])  # the session that holds the message, which the page finds in the chain
        # A reply of the newer session, asked about from the older one.
        self.assertIn("#s=22222222&m=b0000002", self.lines(self.run_command(OLD[:8], "is still open"))["local"])

    def test_an_unrelated_session_is_not_searched(self):
        self.conversation()
        other = "33333333-cccc-4ccc-8ccc-cccccccccccc"
        self.log(other, [user("e0000001-0000-4000-8000-000000000001", "hi", 1000), say("Q9= something else", 1001)], written=1002)
        self.assertEqual(self.run_command(NEW[:8], "Q9=").returncode, 1)
        self.assertIn("#s=33333333&m=e0000001", self.lines(self.run_command(other[:8], "Q9="))["local"])


class NothingFound(Lab):
    def test_no_match_says_so_in_a_sentence_and_prints_no_address(self):
        self.conversation()
        done = self.run_command(NEW[:8], "Z99=")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(done.stdout, "")
        self.assertEqual(done.stderr.strip(), "no reply from the agent in that conversation contains 'Z99='")

    def test_an_unknown_session_and_an_ambiguous_one(self):
        self.conversation()
        done = self.run_command("99999999", "L17=")
        self.assertEqual((done.returncode, done.stdout), (1, ""))
        self.assertIn("no session log starts with 99999999", done.stderr)
        self.log("11111111-dddd-4ddd-8ddd-dddddddddddd", [user("f0000001-0000-4000-8000-000000000001", "x", 3000), say("y", 3001)], written=3002)
        done = self.run_command("11111111", "L17=")
        self.assertEqual(done.returncode, 1)
        self.assertIn("starts 2 sessions; give more characters", done.stderr)

    def test_a_session_that_is_not_an_id_is_refused_in_words(self):
        done = self.run_command("not-an-id", "L17=")
        self.assertEqual(done.returncode, 1)
        self.assertIn("is not a session id", done.stderr)

    def test_the_command_line_is_checked(self):
        for args in ([], ["abcdef12"], ["abcdef12", "a", "b"], ["abcdef12", "--message"], ["abcdef12", "  "], ["abcdef12", "--oops"]):
            done = self.run_command(*args)
            self.assertEqual(done.returncode, 2, args)
            self.assertEqual(done.stdout, "", args)
            self.assertIn("usage:", done.stderr, args)


class MessageById(Lab):
    def test_an_id_or_its_first_characters_names_the_message(self):
        self.conversation()
        full = self.lines(self.run_command(NEW[:8], "--message", "b0000002-0000-4000-8000-000000000002"))
        short = self.lines(self.run_command(NEW[:8], "--message", "b0000002"))
        self.assertEqual(full, short)
        self.assertTrue(full["local"].endswith("#s=22222222&m=b0000002-000"), full["local"])

    def test_an_id_the_conversation_does_not_have_is_refused(self):
        self.conversation()
        done = self.run_command(NEW[:8], "--message", "ffffff")
        self.assertEqual((done.returncode, done.stdout), (1, ""))
        self.assertIn("no message in that conversation has an id starting with ffffff", done.stderr)

    def test_a_cut_short_id_that_fits_two_messages_is_refused(self):
        self.conversation()
        self.log(NEW, [user("b0000001-0000-4000-8000-000000000001", "go", 60), say("a", 61), user("b0000001-1111-4000-8000-000000000002", "again", 70), say("b", 71)], written=80)
        done = self.run_command(NEW[:8], "--message", "b0000001")
        self.assertEqual(done.returncode, 1)
        self.assertIn("starts 2 messages", done.stderr)

    def test_a_malformed_id_is_refused(self):
        self.conversation()
        self.assertEqual(self.run_command(NEW[:8], "--message", "abc").returncode, 1)


class Addresses(Lab):
    def test_the_local_and_the_tailnet_address_name_the_same_message(self):
        self.conversation()
        found = self.lines(self.run_command(NEW[:8], "L17="))
        page = "/setup/transcript-reader/out/prototype.html#s=11111111&m=a0000002-000"
        self.assertEqual(found["local"], "http://localhost:8768" + page)
        # The name is what Tailscale said (minus the trailing dot); nothing in the command names a machine.
        self.assertEqual(found["tailnet"], "https://mac-mini.tail1234.ts.net:8443" + page)
        self.assertNotIn("mac-mini", COMMAND.read_text(encoding="utf-8"))

    def test_the_reader_ports_are_the_configured_ones(self):
        self.conversation()
        found = self.lines(self.run_command(NEW[:8], "L17=", env={"PMOS_READER_PORT": "9101", "PMOS_READER_HTTPS_PORT": "9443"}))
        self.assertTrue(found["local"].startswith("http://localhost:9101/setup/"), found["local"])
        self.assertTrue(found["tailnet"].startswith("https://mac-mini.tail1234.ts.net:9443/setup/"), found["tailnet"])

    def test_with_no_tailnet_name_the_local_address_is_still_printed_and_the_tailnet_line_says_why(self):
        self.conversation()
        for how in ("none",):
            done = self.run_command(NEW[:8], "L17=", tailscale=how)
            found = self.lines(done)
            self.assertTrue(found["local"].startswith("http://localhost:8768/"))
            self.assertTrue(found["tailnet"].startswith("not available"), found["tailnet"])
            self.assertIn("only the local address is printed", done.stderr)
        # A tailscale that answers nonsense, or a name that is not one, is no name either.
        script = self.tailscale(name="not a name")
        done = self.run_command(NEW[:8], "L17=", tailscale=None, env={"PMOS_READER_TAILSCALE": str(script)})
        self.assertTrue(self.lines(done)["tailnet"].startswith("not available"))

    def test_the_message_id_is_long_enough_to_tell_two_messages_apart(self):
        first, second = "abcdefabcdef-1111-4000-8000-000000000001", "abcdefabcdef-2222-4000-8000-000000000002"
        self.log(OLD, [user(first, "go", 0), say("Q1= first", 1), user(second, "go", 10), say("Q2= second", 11)])
        short = self.lines(self.run_command(OLD[:8], "Q1="))["local"].split("&m=")[1]
        self.assertTrue(first.startswith(short) and not second.startswith(short), short)
        self.assertEqual(short, "abcdefabcdef-1")

    def test_the_page_finds_the_message_the_address_names(self):
        """address.js (what the page runs) reads the address this command prints, and finds the turn: the two ends agree."""
        if not shutil.which("node"):
            self.skipTest("node is not installed")
        self.conversation()
        local = self.lines(self.run_command(NEW[:8], "L17="))["local"]
        uids = ["a0000001-0000-4000-8000-000000000001", "a0000002-0000-4000-8000-000000000002", "a0000003-0000-4000-8000-000000000003", "b0000002-0000-4000-8000-000000000002"]
        program = ("const vm = require('vm'), fs = require('fs');"
                   f"const address = vm.runInNewContext(fs.readFileSync({json.dumps(str(ADDRESS_JS))}, 'utf8') + '\\naddress', { '{ String, Array }' });"
                   f"const asked = address.parse({json.dumps('#' + local.split('#', 1)[1])});"
                   f"console.log(JSON.stringify([asked.session, address.find({json.dumps([{'uid': u} for u in uids])}, asked.message)]));")
        done = subprocess.run(["node", "-e", program], capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), ["11111111", 1])


class ReadOnly(Lab):
    def test_it_prints_addresses_and_never_the_words_of_a_message(self):
        self.conversation()
        for args in ((NEW[:8], "L17="), (NEW[:8], "--message", "a0000002"), (NEW[:8], "Landing it")):
            done = self.run_command(*args)
            for words in (SECRET, "land the pool-full help", "Still need a call", "what is waiting"):
                self.assertNotIn(words, done.stdout + done.stderr, args)

    def test_it_writes_nothing(self):
        self.conversation()
        before = sorted((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in self.folder.rglob("*") if p.is_file() and p.parent != self.bin)
        self.run_command(NEW[:8], "L17=")
        after = sorted((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in self.folder.rglob("*") if p.is_file() and p.parent != self.bin)
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
