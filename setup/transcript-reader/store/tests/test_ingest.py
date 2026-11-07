"""The ingest: adapter fixtures for each harness, incremental ingest equal to a from-scratch one, file changes, scope, counters, forget.

Run from the repo root:
  python3 -m unittest discover -s setup/transcript-reader/store/tests -p 'test_*.py'
"""

from __future__ import annotations

import json
import os
import random
import unittest
from pathlib import Path

from base import StoreCase, dump
import synth
from rstore import builder, db, forget, parity, schema


class AdapterFixtures(StoreCase):
    """Each harness's log, ingested, matches the builder's own reading of it on the stated projection."""

    def parity(self):
        run = parity.run(self.conn, trigger="manual")
        return self.rows("SELECT * FROM parity_runs WHERE run_id = ?", run)[0], self.rows("SELECT * FROM parity_mismatches WHERE run_id = ?", run)

    def test_claude(self):
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), synth.claude_conversation())
        self.ing.scan()
        run, mismatches = self.parity()
        self.assertEqual(mismatches, [])
        self.assertEqual(run["sessions"], 1)
        self.assertEqual(run["unexplained"], 0)
        turns = self.rows("SELECT * FROM turns ORDER BY idx")
        self.assertEqual([t["source"] for t in turns][:2], ["captain", "captain"])
        self.assertTrue(any(t["absorbed"] for t in turns), "a message that arrived while the agent worked is an absorbed turn")
        self.assertTrue(any(t["source"] == "wake" for t in turns))
        self.assertTrue(any(t["verdict"] == "needs-you" for t in turns), "the ask flag is kept")
        session = self.rows("SELECT * FROM sessions")[0]
        self.assertEqual((session["title"], session["cwd"], session["org_uuid"], session["scope"]), ("Synthetic alpha work", "/work/alpha", "org-aaaa", "default"))

    def test_codex(self):
        synth.write_jsonl(synth.codex_path(self.home, synth.sid(2)), synth.codex_conversation(synth.sid(2)))
        self.ing.scan()
        run, mismatches = self.parity()
        self.assertEqual(mismatches, [])
        self.assertEqual(run["sessions"], 1)
        self.assertEqual(self.one("SELECT COUNT(*) FROM turns"), 2)
        self.assertEqual(self.one("SELECT scope FROM sessions"), "codex")

    def test_codex_not_read_by_the_builder_is_skipped_in_parity_not_failed(self):
        records = synth.codex_conversation(synth.sid(2))
        records[0]["payload"]["source"] = "exec"
        synth.write_jsonl(synth.codex_path(self.home, synth.sid(2)), records)
        self.ing.scan()
        run, mismatches = self.parity()
        self.assertEqual((run["sessions"], run["skipped"], mismatches), (0, 1, []))
        self.assertEqual(self.one("SELECT COUNT(*) FROM turns"), 2, "the store still holds it: W2 is everything")

    def test_copilot_with_a_compaction_divider(self):
        synth.write_jsonl(synth.copilot_path(self.home, synth.sid(3)), synth.copilot_conversation(synth.sid(3)))
        self.ing.scan()
        run, mismatches = self.parity()
        self.assertEqual(mismatches, [])
        self.assertEqual(run["sessions"], 1)
        self.assertEqual(self.one("SELECT COUNT(*) FROM turns WHERE source = 'session' AND kind = 'compacted'"), 1)
        self.assertEqual(self.one("SELECT COUNT(*) FROM turns WHERE uid IS NULL"), 1, "a divider has no record id of its own")

    def test_pi(self):
        synth.write_jsonl(synth.pi_path(self.home, synth.sid(4)), synth.pi_conversation(synth.sid(4)))
        self.ing.scan()
        turns = self.rows("SELECT * FROM turns ORDER BY idx")
        self.assertEqual([t["input"] for t in turns], ["Pi question 0", "Pi question 1"])
        self.assertEqual([t["reply"] for t in turns], ["Pi answer 0.", "Pi answer 1."])
        self.assertEqual([t["tools"] for t in turns], [1, 1])
        self.assertEqual(self.one("SELECT harness FROM sessions"), "pi")
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'ignored_record' AND key = 'pi:model_change'"), 1)

    def test_only_pi_session_files_are_read_not_other_jsonl_under_dot_pi(self):
        synth.write_jsonl(synth.pi_path(self.home, synth.sid(4)), synth.pi_conversation(synth.sid(4)))
        synth.write_jsonl(self.home / ".pi" / "agent" / "git" / "x" / "trials.jsonl", [{"fixtureId": 1}])
        self.ing.scan()
        self.assertEqual(self.one("SELECT COUNT(*) FROM sources"), 1)

    def test_subagent_file_is_a_session_with_a_parent_link(self):
        parent = synth.sid(1)
        synth.write_jsonl(synth.claude_path(self.home, parent), synth.claude_conversation(n_turns=1))
        sub = self.home / ".claude" / "projects" / "-work-alpha" / parent / "subagents" / "agent-abc123.jsonl"
        synth.write_jsonl(sub, synth.claude_conversation(n_turns=1, with_tools=False))
        self.ing.scan()
        row = self.rows("SELECT session_id, kind, parent_session_id FROM sessions WHERE kind = 'subagent'")[0]
        self.assertEqual((row["session_id"], row["parent_session_id"]), ("agent-abc123", parent))
        self.assertEqual(self.rows("SELECT from_session, to_session, kind, basis FROM links"),
                         [{"from_session": parent, "to_session": "agent-abc123", "kind": "subagent", "basis": "path"}])

    def test_other_claude_account_folders_are_indexed_and_labelled(self):
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(5), folder=".claude-personal"), synth.claude_conversation(n_turns=1, org="org-pers"))
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(6), project="-x"), synth.claude_conversation(n_turns=1))
        self.ing.scan()
        scopes = {r["session_id"]: r["scope"] for r in self.rows("SELECT session_id, scope FROM sessions")}
        self.assertEqual(scopes, {synth.sid(5): "personal", synth.sid(6): "default"})


class Records(StoreCase):
    def test_known_ignored_records_are_counted_and_never_stored_as_text(self):
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), synth.claude_conversation(n_turns=1))
        self.ing.scan()
        counters = {r["key"]: r["count"] for r in self.rows("SELECT key, count FROM counters WHERE name = 'ignored_record'")}
        self.assertEqual(counters["claude:api-request-blob"], 1)
        self.assertEqual(counters["claude:api-request"], 1)
        for table, columns in (("events", "text, meta"), ("turns", "input, reply"), ("search", "text")):
            for row in self.conn.execute(f"SELECT {columns} FROM {table}"):
                for value in row:
                    self.assertNotIn("SECRET-BLOB-TEXT", value or "", f"{table} must not hold an api-request-blob")

    def test_an_unknown_record_type_is_counted_and_kept_as_a_bare_row(self):
        records = synth.claude_conversation(n_turns=1)
        records.insert(3, {"type": "brand-new-kind", "uuid": "n-1", "timestamp": synth.iso(synth.T0), "payload": "should not be kept as text"})
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), records)
        self.ing.scan()
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'unknown_record' AND key = 'claude:brand-new-kind'"), 1)
        row = self.rows("SELECT kind, text, meta FROM events WHERE kind = 'brand-new-kind'")[0]
        self.assertIsNone(row["text"])
        self.assertNotIn("should not be kept", row["meta"])
        self.assertIn("payload", json.loads(row["meta"])["keys"])

    def test_unknown_attachment_type_is_counted(self):
        records = synth.claude_conversation(n_turns=1)
        records.insert(3, {"type": "attachment", "uuid": "z1", "timestamp": synth.iso(synth.T0), "attachment": {"type": "a_new_reminder"}})
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), records)
        self.ing.scan()
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'unknown_record' AND key = 'claude:attachment/a_new_reminder'"), 1)

    def test_a_credential_path_tool_result_keeps_no_text_even_when_it_arrives_in_a_later_pass(self):
        path = synth.claude_path(self.home, synth.sid(1))
        base = [synth.c_user("read my env", synth.T0), synth.c_tool("Read", {"file_path": "/home/x/.env"}, synth.T0 + 1, "call-secret")]
        synth.write_jsonl(path, base)
        self.ing.scan()
        synth.append_jsonl(path, [synth.c_result("call-secret", "API_KEY=supersecret123", synth.T0 + 2), synth.c_say("done", synth.T0 + 3)])
        os.utime(path, (synth.T0 + 10, synth.T0 + 10))
        self.ing.scan()
        for row in self.conn.execute("SELECT text, meta FROM events"):
            self.assertNotIn("supersecret123", (row["text"] or "") + row["meta"])
        result = self.rows("SELECT * FROM events WHERE role = 'tool_result'")[0]
        self.assertFalse(result["text"])
        self.assertIn('"h":1', result["meta"])

    def test_copilot_pi_and_codex_tool_results_follow_the_same_credential_rule(self):
        sid = synth.sid(3)
        copilot = [{"type": "session.start", "id": "e0", "timestamp": synth.iso(synth.T0), "data": {"sessionId": sid, "context": {"cwd": "/work/c"}}},
                   {"type": "user.message", "id": "u0", "timestamp": synth.iso(synth.T0 + 1), "data": {"content": "show env", "messageId": "m0", "delivery": "idle"}},
                   {"type": "assistant.message", "id": "a0", "timestamp": synth.iso(synth.T0 + 2), "data": {"content": "", "toolRequests": [
                       {"toolCallId": "k1", "name": "bash", "arguments": {"command": "cat ~/.env"}}]}},
                   {"type": "tool.execution_complete", "id": "x0", "timestamp": synth.iso(synth.T0 + 3), "data": {"toolCallId": "k1", "result": {"content": "COPILOT-SECRET-VALUE"}}},
                   {"type": "tool.execution_complete", "id": "x1", "timestamp": synth.iso(synth.T0 + 4), "data": {"toolCallId": "never-seen", "result": {"content": "ORPHAN-OUTPUT"}}}]
        synth.write_jsonl(synth.copilot_path(self.home, sid), copilot)
        psid = synth.sid(4)
        pi = synth.pi_conversation(psid, n=1)
        pi[-2]["message"]["content"] = [{"type": "text", "text": "PI-TOOL-RESULT-SECRET"}]
        synth.write_jsonl(synth.pi_path(self.home, psid), pi)
        csid = synth.sid(2)
        codex = synth.codex_conversation(csid, n=1)
        codex.insert(2, {"type": "response_item", "timestamp": synth.iso(synth.T0 + 3), "payload": {"type": "function_call", "name": "exec", "call_id": "f1", "arguments": json.dumps({"command": "cat ~/.env"})}})
        codex.insert(3, {"type": "response_item", "timestamp": synth.iso(synth.T0 + 4), "payload": {"type": "function_call_output", "call_id": "f1", "output": "CODEX-SECRET-VALUE"}})
        synth.write_jsonl(synth.codex_path(self.home, csid), codex)
        self.ing.scan()
        blob = "".join((r["text"] or "") + r["meta"] for r in self.rows("SELECT text, meta FROM events"))
        for secret in ("COPILOT-SECRET-VALUE", "ORPHAN-OUTPUT", "PI-TOOL-RESULT-SECRET", "CODEX-SECRET-VALUE"):
            self.assertNotIn(secret, blob)
        self.assertIn('"h":1', self.one("SELECT meta FROM events WHERE tool_use_id = 'k1' AND role = 'tool_result'"))
        self.assertIn('"no_step":1', self.one("SELECT meta FROM events WHERE tool_use_id = 'never-seen'"))

    def test_a_tool_output_is_bounded_and_a_read_keeps_no_file_text(self):
        records = [synth.c_user("go", synth.T0), synth.c_tool("Bash", {"command": "yes"}, synth.T0 + 1, "c1"),
                   synth.c_result("c1", "x" * 20000, synth.T0 + 2), synth.c_tool("Read", {"file_path": "/work/alpha/a.txt"}, synth.T0 + 3, "c2"),
                   synth.c_result("c2", "FILE-BODY " * 50, synth.T0 + 4), synth.c_say("ok", synth.T0 + 5)]
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), records)
        self.ing.scan()
        results = self.rows("SELECT text, text_len FROM events WHERE role = 'tool_result' ORDER BY offset")
        self.assertLessEqual(len(results[0]["text"]), 1500)
        self.assertFalse(results[1]["text"], "the text of a file the agent read never travels")

    def test_a_corrupt_line_is_counted_and_skipped(self):
        path = synth.claude_path(self.home, synth.sid(1))
        synth.write_jsonl(path, [*synth.lines(synth.claude_conversation(n_turns=1)[:6]), "{not json\n", *synth.lines([synth.c_say("after", synth.T0 + 500)])])
        self.ing.scan()
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'file_event' AND key = 'corrupt_line'"), 1)
        self.assertTrue(self.one("SELECT COUNT(*) FROM events WHERE text = 'after'"))


class Incremental(StoreCase):
    """A log that grows is ingested in pieces; the store must equal one ingested from nothing, however the pieces fall."""

    def grow(self, path, records, cuts, mid_line=False):
        text = "".join(json.dumps(r) + "\n" for r in records)
        points = sorted(set(cuts))
        start = 0
        for point in points + [len(text)]:
            if point <= start:
                continue
            with open(path, "ab") as handle:
                handle.write(text[start:point].encode())
            os.utime(path, None)
            self.ing.scan()
            start = point

    def equal_to_scratch(self):
        conn2, ing2 = self.fresh()
        ing2.scan()
        self.assertEqual(dump(self.conn), dump(conn2))
        self.assertEqual(self.one("SELECT COUNT(*) FROM events"), conn2.execute("SELECT COUNT(*) FROM events").fetchone()[0])

    def run_chunks(self, writer, records, seeds=range(6), per=3):
        text = "".join(json.dumps(r) + "\n" for r in records)
        boundaries = [i + 1 for i, ch in enumerate(text) if ch == "\n"]
        for seed in seeds:
            rng = random.Random(seed)
            self.setUp()
            path = writer(self.home)
            path.parent.mkdir(parents=True, exist_ok=True)
            cuts = [rng.choice(boundaries) for _ in range(per)] + [rng.randrange(1, len(text)) for _ in range(2)]  # some cuts fall mid-line
            self.grow(path, records, cuts)
            self.equal_to_scratch()
            run = parity.run(self.conn)
            self.assertEqual(self.one("SELECT mismatches FROM parity_runs WHERE run_id = ?", run), 0, f"seed {seed}")

    def test_claude_in_pieces_equals_whole(self):
        records = synth.claude_conversation(n_turns=5)
        self.run_chunks(lambda home: synth.claude_path(home, synth.sid(1)), records)

    def test_claude_window_starting_at_an_absorbed_turn_boundary(self):
        # The newest turn is a message that arrived while the agent was busy: the window must start at the turn before it.
        records = [synth.c_user("first", synth.T0), synth.c_say("a1", synth.T0 + 1), synth.c_user("second", synth.T0 + 10),
                   synth.c_tool("Bash", {"command": "sleep 1"}, synth.T0 + 11, "cc"), synth.c_queued("while busy", synth.T0 + 12),
                   synth.c_say("both answered", synth.T0 + 20)]
        for cut_after in range(1, len(records)):
            self.setUp()
            path = synth.claude_path(self.home, synth.sid(1))
            synth.write_jsonl(path, records[:cut_after])
            self.ing.scan()
            synth.append_jsonl(path, records[cut_after:])
            os.utime(path, None)
            self.ing.scan()
            self.equal_to_scratch()
            self.assertEqual(self.one("SELECT mismatches FROM parity_runs WHERE run_id = ?", parity.run(self.conn)), 0, f"cut after {cut_after}")

    def test_codex_in_pieces_equals_whole(self):
        records = synth.codex_conversation(synth.sid(2), n=4)
        self.run_chunks(lambda home: synth.codex_path(home, synth.sid(2)), records)

    def test_copilot_in_pieces_equals_whole_across_a_divider(self):
        records = synth.copilot_conversation(synth.sid(3), n=4)
        self.run_chunks(lambda home: synth.copilot_path(home, synth.sid(3)), records)

    def test_pi_in_pieces_equals_whole(self):
        records = synth.pi_conversation(synth.sid(4), n=4)
        self.run_chunks(lambda home: synth.pi_path(home, synth.sid(4)), records)

    def test_only_the_tail_turn_is_derived_again(self):
        path = synth.claude_path(self.home, synth.sid(1))
        synth.write_jsonl(path, synth.claude_conversation(n_turns=4))
        self.ing.scan()
        ids = self.rows("SELECT turn_id, idx FROM turns ORDER BY idx")
        start_idx = self.one("SELECT turn_start_idx FROM sources")
        synth.append_jsonl(path, [synth.c_user("one more", synth.T0 + 9000), synth.c_say("yes", synth.T0 + 9001)])
        os.utime(path, None)
        self.ing.scan()
        after = {r["idx"]: r["turn_id"] for r in self.rows("SELECT turn_id, idx FROM turns")}
        untouched = [r for r in ids if r["idx"] < start_idx]
        self.assertTrue(untouched)
        for row in untouched:
            self.assertEqual(after[row["idx"]], row["turn_id"], "turns before the window are never rewritten")

    def test_a_partial_last_line_waits_for_its_newline(self):
        path = synth.claude_path(self.home, synth.sid(1))
        records = synth.claude_conversation(n_turns=1)
        text = "".join(json.dumps(r) + "\n" for r in records)
        half = len(text) - 20
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text[:half])
        self.ing.scan()
        partial_events = self.one("SELECT COUNT(*) FROM events")
        self.assertLess(partial_events, len(records))
        with open(path, "a") as handle:
            handle.write(text[half:])
        os.utime(path, None)
        self.ing.scan()
        self.equal_to_scratch()

    def test_a_final_complete_object_without_a_newline_is_taken(self):
        path = synth.claude_path(self.home, synth.sid(1))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(synth.c_user("q", synth.T0)) + "\n" + json.dumps(synth.c_say("a", synth.T0 + 1)))
        self.ing.scan()
        self.assertEqual(self.one("SELECT reply FROM turns"), "a")
        self.assertEqual(self.one("SELECT mismatches FROM parity_runs WHERE run_id = ?", parity.run(self.conn)), 0)


class FileChanges(StoreCase):
    def test_deleted_log_leaves_the_session_marked_log_gone(self):
        path = synth.claude_path(self.home, synth.sid(1))
        synth.write_jsonl(path, synth.claude_conversation(n_turns=2))
        self.ing.scan()
        before = dump(self.conn)
        path.unlink()
        result = self.ing.scan()
        self.assertEqual(result.gone, 1)
        session = self.rows("SELECT log_state, gone_at, turn_count FROM sessions")[0]
        self.assertEqual(session["log_state"], "gone")
        self.assertIsNotNone(session["gone_at"])
        after = dump(self.conn)
        for sid in before:
            if sid.startswith("__"):
                continue
            self.assertEqual(after[sid]["turns"], before[sid]["turns"], "W1 = archive: the turns stay after the log is gone")
            self.assertEqual(after[sid]["events"], before[sid]["events"])
        self.assertEqual(self.one("SELECT state FROM sources"), "log_gone")
        self.assertEqual(self.one("SELECT COUNT(*) FROM search"), self.one("SELECT COUNT(*) FROM turns WHERE input <> '' OR reply <> ''"))
        self.assertEqual(self.ing.scan().gone, 0, "a gone log is noticed once")

    def test_a_deleted_log_that_comes_back_continues(self):
        path = synth.claude_path(self.home, synth.sid(1))
        records = synth.claude_conversation(n_turns=2)
        synth.write_jsonl(path, records)
        self.ing.scan()
        saved = path.read_bytes()
        path.unlink()
        self.ing.scan()
        path.write_bytes(saved + (json.dumps(synth.c_say("late", synth.T0 + 9999)) + "\n").encode())
        self.ing.scan()
        self.assertEqual(self.one("SELECT log_state FROM sessions"), "present")
        self.assertEqual(self.one("SELECT COUNT(*) FROM sources"), 1)
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'file_event' AND key = 'back'"), 1)

    def test_truncation_starts_a_new_generation_and_keeps_the_old_rows(self):
        path = synth.claude_path(self.home, synth.sid(1))
        synth.write_jsonl(path, synth.claude_conversation(n_turns=3))
        self.ing.scan()
        old_turns = self.one("SELECT COUNT(*) FROM turns")
        short = [synth.c_user("fresh start", synth.T0 + 100000), synth.c_say("new log", synth.T0 + 100001)]
        synth.write_jsonl(path, short)
        os.utime(path, None)
        self.ing.scan()
        self.assertEqual(self.rows("SELECT generation, state FROM sources ORDER BY generation"), [{"generation": 1, "state": "replaced"}, {"generation": 2, "state": "active"}])
        self.assertEqual(self.one("SELECT COUNT(*) FROM turns"), old_turns + 1, "the first generation's turns stay")
        self.assertEqual([r["input"] for r in self.rows("SELECT input FROM v1_turns")], ["fresh start"], "the view reads the current generation")
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'file_event' AND key = 'truncated'"), 1)

    def test_a_replaced_file_at_the_same_path_is_a_new_generation(self):
        path = synth.claude_path(self.home, synth.sid(1))
        synth.write_jsonl(path, synth.claude_conversation(n_turns=1))
        self.ing.scan()
        other = synth.claude_conversation(n_turns=3, cwd="/work/beta")
        next(r for r in other if r["type"] == "user")["message"]["content"] = "A completely different first question"
        path.unlink()
        synth.write_jsonl(path, other)
        self.ing.scan()
        self.assertEqual(self.one("SELECT MAX(generation) FROM sources"), 2)
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'file_event' AND key = 'replaced'"), 1)

    def test_a_rewrite_in_place_longer_than_before_is_detected_by_the_tail_check(self):
        path = synth.claude_path(self.home, synth.sid(1))
        records = synth.claude_conversation(n_turns=2)
        synth.write_jsonl(path, records)
        self.ing.scan()
        size = path.stat().st_size
        records[-1]["message"]["content"][0]["text"] = "Rewritten answer, same head, same inode, but different bytes before the cursor."
        records.append(synth.c_say("and more", synth.T0 + 99999))
        text = "".join(json.dumps(r) + "\n" for r in records)
        with open(path, "r+b") as handle:  # same inode, same head
            handle.write(text.encode())
        self.assertGreater(path.stat().st_size, size)
        self.ing.scan()
        self.assertEqual(self.one("SELECT MAX(generation) FROM sources"), 2)

    def test_rules_change_rederives_a_present_log_and_leaves_a_gone_log_alone(self):
        live = synth.claude_path(self.home, synth.sid(1))
        gone = synth.claude_path(self.home, synth.sid(2))
        synth.write_jsonl(live, synth.claude_conversation(n_turns=2))
        synth.write_jsonl(gone, synth.claude_conversation(n_turns=2))
        self.ing.scan()
        gone.unlink()
        self.ing.scan()
        self.conn.execute("UPDATE sources SET rules = 'old'")
        self.conn.execute("UPDATE turns SET rules = 'old'")
        self.ing.scan()
        self.assertEqual(self.one("SELECT rules FROM sources WHERE session_id = ?", synth.sid(1)), builder.RULES)
        self.assertEqual(self.one("SELECT rules FROM sources WHERE session_id = ?", synth.sid(2)), "old")
        conn2, ing2 = self.fresh()
        gone_saved = synth.claude_path(self.home, synth.sid(1))
        ing2.scan()
        a = dump(self.conn)[synth.sid(1)]
        b = dump(conn2)[synth.sid(1)]
        self.assertEqual(a["turns"], b["turns"])
        self.assertEqual(a["events"], b["events"], "a re-derivation changes turns and flags, never duplicates events")

    def test_unreadable_file_does_not_stop_the_pass(self):
        good = synth.claude_path(self.home, synth.sid(1))
        bad = synth.claude_path(self.home, synth.sid(2))
        synth.write_jsonl(good, synth.claude_conversation(n_turns=1))
        synth.write_jsonl(bad, synth.claude_conversation(n_turns=1))
        os.chmod(bad, 0o000)
        try:
            result = self.ing.scan()
        finally:
            os.chmod(bad, 0o600)
        self.assertEqual(len(result.errors), 1)
        self.assertEqual(self.one("SELECT COUNT(*) FROM sessions"), 1)
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'file_event' AND key = 'unreadable'"), 1)


class Scope(unittest.TestCase):
    def make(self, **policy):
        from base import StoreCase as S
        case = S()
        case.policy = policy
        case.setUp()
        self.addCleanup(case.conn.close)
        return case

    def test_everything_is_the_default_and_labels_personal_work(self):
        case = self.make()
        synth.write_jsonl(synth.claude_path(case.home, synth.sid(1)), synth.claude_conversation(n_turns=1, cwd=str(case.home / "workspace/pmos/personal-work/x")))
        case.ing.scan()
        self.assertEqual(case.one("SELECT scope FROM sessions"), "personal-work")
        self.assertEqual(case.one("SELECT COUNT(*) FROM sources WHERE state = 'skipped'"), 0)

    def test_shopback_only_skips_and_counts_other_orgs_and_personal_folders(self):
        case = self.make(scope_policy="shopback-only", shopback_org_uuids=["org-aaaa"])
        synth.write_jsonl(synth.claude_path(case.home, synth.sid(1)), synth.claude_conversation(n_turns=1, org="org-aaaa"))
        synth.write_jsonl(synth.claude_path(case.home, synth.sid(2)), synth.claude_conversation(n_turns=1, org="org-other"))
        synth.write_jsonl(synth.claude_path(case.home, synth.sid(3)), synth.claude_conversation(n_turns=1, org="org-aaaa", cwd=str(case.home / "workspace/pmos/personal-work/y")))
        case.ing.scan()
        self.assertEqual([r["session_id"] for r in case.rows("SELECT session_id FROM sessions")], [synth.sid(1)])
        skipped = {r["key"]: r["count"] for r in case.rows("SELECT key, count FROM counters WHERE name = 'skipped_source'")}
        self.assertEqual(skipped, {"claude:other_organisation": 1, "claude:personal_cwd": 1})
        self.assertEqual(case.ing.scan().changed, 0, "a skipped file is not looked at again until it changes")

    def test_changing_the_policy_takes_a_skipped_file(self):
        case = self.make(scope_policy="shopback-only", shopback_org_uuids=["org-aaaa"])
        synth.write_jsonl(synth.claude_path(case.home, synth.sid(2)), synth.claude_conversation(n_turns=1, org="org-other"))
        case.ing.scan()
        self.assertEqual(case.one("SELECT COUNT(*) FROM sessions"), 0)
        case.ing.settings.scope_policy = "everything"
        case.ing.scan()
        self.assertEqual(case.one("SELECT COUNT(*) FROM sessions"), 1)
        self.assertEqual(case.one("SELECT COUNT(*) FROM sources"), 1, "the same source row, now active")


class Forget(StoreCase):
    def test_forget_removes_a_session_everywhere_and_it_is_never_taken_again(self):
        for n in (1, 2):
            synth.write_jsonl(synth.claude_path(self.home, synth.sid(n)), synth.claude_conversation(n_turns=2))
        parent = synth.sid(1)
        sub = self.home / ".claude" / "projects" / "-work-alpha" / parent / "subagents" / "agent-zz.jsonl"
        synth.write_jsonl(sub, synth.claude_conversation(n_turns=1))
        self.ing.scan()
        self.conn.execute("INSERT INTO send_checks(at, trigger, session_id, check_result) VALUES (1, 'send', ?, 'ok')", (parent,))
        self.conn.execute("INSERT INTO facts(herdr_session, life, pane_id, source, session_id, observed_at, valid_from) VALUES ('h', '1', 'w1:p1', 'pid_record', ?, 1, 1)", (parent,))
        needle = self.conn.execute("SELECT input FROM turns WHERE session_id = ? LIMIT 1", (parent,)).fetchone()[0]
        self.assertTrue(self.conn.execute("SELECT 1 FROM search WHERE search MATCH 'alpha' AND session_id = ?", (parent,)).fetchone())
        report = forget.forget(self.conn, parent, note="test")
        self.assertEqual(report["sessions"], 2, "a forgotten session takes its sub-agents with it")
        for table in ("sessions", "turns", "events", "sources", "tool_calls", "facts", "send_checks"):
            col = "session_id"
            n = self.one(f"SELECT COUNT(*) FROM {table} WHERE {col} IN (?, 'agent-zz')", parent) if table != "tool_calls" else 0
            self.assertEqual(n, 0, table)
        self.assertEqual(self.one("SELECT COUNT(*) FROM search WHERE session_id IN (?, 'agent-zz')", parent), 0)
        self.assertEqual(self.one("SELECT COUNT(*) FROM links WHERE from_session = ? OR to_session = ?", parent, parent), 0)
        self.assertEqual(self.one("SELECT COUNT(*) FROM sessions"), 1, "another session is untouched")
        self.assertTrue(self.one("SELECT 1 FROM forgotten WHERE session_id = ?", parent))
        # The text is out of the file, not only out of the index.
        raw = (self.root / "store.sqlite").read_bytes() + (self.root / "store.sqlite-wal").read_bytes() if (self.root / "store.sqlite-wal").exists() else (self.root / "store.sqlite").read_bytes()
        self.assertNotIn(needle.encode(), raw) if needle not in {r["input"] for r in self.rows("SELECT input FROM turns")} else None
        # Another scan does not bring it back, even though the log is still on disk.
        self.ing.scan()
        self.assertEqual(self.one("SELECT COUNT(*) FROM sessions WHERE session_id IN (?, 'agent-zz')", parent), 0)
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'skipped_source' AND key = 'claude:forgotten'"), 2)

    def test_forget_follows_sub_agent_links_a_codex_child_included(self):
        parent, child = synth.sid(2), synth.sid(7)
        synth.write_jsonl(synth.codex_path(self.home, parent), synth.codex_conversation(parent, n=1))
        records = synth.codex_conversation(child, n=1)
        records[0]["payload"]["parent_thread_id"] = parent
        synth.write_jsonl(synth.codex_path(self.home, child, day="2026/11/07"), records)
        self.ing.scan()
        self.assertEqual(self.one("SELECT COUNT(*) FROM links WHERE from_session = ?", parent), 1)
        report = forget.forget(self.conn, parent)
        self.assertEqual(sorted(report["forgotten"]), sorted([parent, child]))
        self.assertEqual(self.one("SELECT COUNT(*) FROM sessions"), 0)
        self.ing.scan()
        self.assertEqual(self.one("SELECT COUNT(*) FROM sessions"), 0)

    def test_a_codex_child_of_a_forgotten_parent_that_appears_later_is_not_taken(self):
        parent, child = synth.sid(2), synth.sid(7)
        forget.forget(self.conn, parent)
        records = synth.codex_conversation(child, n=1)
        records[0]["payload"]["parent_thread_id"] = parent
        synth.write_jsonl(synth.codex_path(self.home, child), records)
        self.ing.scan()
        self.assertEqual(self.one("SELECT COUNT(*) FROM sessions"), 0)
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'skipped_source' AND key = 'codex:forgotten'"), 1)

    def test_forget_names_the_snapshots_that_still_hold_the_session(self):
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), synth.claude_conversation(n_turns=1))
        self.ing.scan()
        self.conn.execute("INSERT INTO backups(at, snapshot, bytes) VALUES (1, 'old.sqlite.gpg', 10)")
        report = forget.forget(self.conn, synth.sid(1))
        self.assertEqual(report["older_snapshots"], ["old.sqlite.gpg"])

    def test_forgetting_an_unknown_session_still_blocks_it(self):
        report = forget.forget(self.conn, synth.sid(9))
        self.assertEqual(report["sessions"], 0)
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(9)), synth.claude_conversation(n_turns=1))
        self.ing.scan()
        self.assertEqual(self.one("SELECT COUNT(*) FROM sessions"), 0)


class Heartbeat(StoreCase):
    def test_heartbeat_and_lag(self):
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), synth.claude_conversation(n_turns=1))
        result = self.ing.scan()
        self.ing.heartbeat(result)
        row = self.rows("SELECT * FROM ingest_heartbeat")[0]
        self.assertEqual((row["files"], row["changed"], row["status"]), (1, 1, "ok"))
        self.assertTrue(self.one("SELECT COUNT(*) FROM ingest_lag"))
        status = self.rows("SELECT * FROM v1_ingest_status")[0]
        self.assertEqual(status["sessions"], 1)

    def test_a_heartbeat_that_never_stopped_from_a_dead_process_is_a_crash(self):
        self.conn.execute("INSERT INTO ingest_heartbeat(id, at, pid, status) VALUES (1, 1, 99999999, 'ok')")
        self.assertTrue(self.ing.recover_after_crash())
        self.assertEqual(self.one("SELECT count FROM counters WHERE name = 'file_event' AND key = 'crash_recovered'"), 1)
        self.conn.execute("UPDATE ingest_heartbeat SET status = 'stopped'")
        self.assertFalse(self.ing.recover_after_crash())


class SchemaVersion(unittest.TestCase):
    def test_a_newer_store_is_refused_and_a_new_one_is_versioned(self):
        import sqlite3
        import tempfile
        root = Path(tempfile.mkdtemp())
        conn = db.connect(root / "s.sqlite")
        self.assertEqual(schema.version_of(conn), schema.SCHEMA_VERSION)
        self.assertEqual(conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()[0], str(schema.SCHEMA_VERSION))
        conn.execute(f"PRAGMA user_version = {schema.SCHEMA_VERSION + 1}")
        conn.close()
        with self.assertRaises(RuntimeError):
            db.connect(root / "s.sqlite")
        with self.assertRaises(RuntimeError):
            db.connect(root / "s.sqlite", readonly=True)

    def test_store_files_are_owner_only(self):
        import tempfile
        root = Path(tempfile.mkdtemp())
        conn = db.connect(root / "sub" / "s.sqlite")
        conn.execute("CREATE TABLE IF NOT EXISTS t(x)")
        self.assertEqual(os.stat(root / "sub").st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(root / "sub" / "s.sqlite").st_mode & 0o777, 0o600)

    def test_a_second_writer_is_refused(self):
        import tempfile
        root = Path(tempfile.mkdtemp())
        with db.single_writer(root / "lock"):
            with self.assertRaises(RuntimeError):
                with db.single_writer(root / "lock"):
                    pass


if __name__ == "__main__":
    unittest.main()
