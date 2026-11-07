"""The validation tooling: search and known answers, the Send-time record, disagreements, the coverage checklist, rusage and the scorecard."""

from __future__ import annotations

import time
import unittest

from base import StoreCase
from lab import Lab
import synth
from rstore import coverage, disagree, identity, known_answers, rusage, scorecard, search, sendrec

A, B, C, D = synth.sid(11), synth.sid(12), synth.sid(13), synth.sid(14)


class Search(StoreCase):
    def setUp(self):
        super().setUp()
        base = synth.claude_conversation(n_turns=1)
        base[5]["message"]["content"] = "How do I rotate the hosted reader passphrase in the keychain?"
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), base)
        other = synth.claude_conversation(n_turns=1, cwd="/work/beta")
        other[5]["message"]["content"] = "Plan the migration of the ledger tables"
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(2), project="-work-beta"), other)
        synth.write_jsonl(synth.codex_path(self.home, synth.sid(3)), synth.codex_conversation(synth.sid(3)))
        self.ing.scan()

    def test_finds_the_session_with_the_words_across_harnesses(self):
        hits = search.search(self.conn, "hosted reader passphrase keychain")
        self.assertEqual(hits[0]["session_id"], synth.sid(1))
        self.assertIn("[", hits[0]["snippet"])
        self.assertEqual(search.search(self.conn, "Codex question")[0]["session_id"], synth.sid(3))

    def test_one_row_per_session_and_a_second_try_with_any_word(self):
        hits = search.search(self.conn, "question about alpha")
        self.assertEqual(len({h["session_id"] for h in hits}), len(hits))
        hits = search.search(self.conn, "ledger zzzzunknownword")
        self.assertEqual(hits[0]["session_id"], synth.sid(2), "no session has both words, so any word will do")

    def test_punctuation_in_a_query_never_breaks_it(self):
        for query in ('c++ "quoted" AND OR NOT', "foo-bar", "a:b", "(((", "*", ""):
            search.search(self.conn, query)

    def test_scope_filter_and_a_session_whose_log_is_gone_is_still_found(self):
        self.assertEqual({h["scope"] for h in search.search(self.conn, "answer", scope="codex")}, {"codex"})
        synth.claude_path(self.home, synth.sid(2), project="-work-beta").unlink()
        self.ing.scan()
        hit = search.search(self.conn, "ledger migration")[0]
        self.assertEqual((hit["session_id"], hit["log_state"]), (synth.sid(2), "gone"))


class KnownAnswers(StoreCase):
    def setUp(self):
        super().setUp()
        records = synth.claude_conversation(n_turns=1)
        records[5]["message"]["content"] = "Where do the unique zebrafish reports live?"
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), records)
        self.ing.scan()

    TABLE = ("| # | query | expected session (id or its first 8 characters) | note |\n| --- | --- | --- | --- |\n"
             "| 1 | zebrafish reports | 5e551001 | passes |\n| 2 | zebrafish reports | 5e5510ff | wrong session |\n| 3 | zebrafish | <fill in> | candidates: x |\n")

    def test_parse_and_check(self):
        rows = known_answers.parse(self.TABLE)
        self.assertEqual([r["n"] for r in rows], [1, 2, 3])
        results = known_answers.check(self.conn, rows)
        self.assertEqual([r["status"] for r in results], ["pass", "fail", "undecided"])
        self.assertEqual(results[0]["position"], 1)

    def test_the_draft_names_candidates_by_id_and_folder_and_quotes_no_message(self):
        text = known_answers.candidates_table(self.conn, ["zebrafish reports"])
        self.assertIn("5e551001", text)
        self.assertIn("<fill in>", text)
        self.assertNotIn("unique zebrafish reports live", text)


class SendRecord(StoreCase):
    def setUp(self):
        super().setUp()
        self.lab = Lab(self.home)
        self.addCleanup(self.lab.close)
        self.ident = identity.Identity(self.conn, self.lab.client(), self.home, proc_start=self.lab.proc_start, alive=self.lab.alive)
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=A, pid=1001)
        self.lab.pid_record(1001, A)
        self.ident.reconcile()

    def agree(self, check_id):
        return self.one("SELECT agree FROM send_agreement WHERE check_id = ?", check_id)

    def test_agreement_view(self):
        ok = sendrec.record(self.conn, trigger="send", herdr_session="esim", pane_id="w1:p1", session_id=A, check_result="ok", check_session=A)
        wrong_ok = sendrec.record(self.conn, trigger="send", herdr_session="esim", pane_id="w1:p1", session_id=B, check_result="ok", check_session=B)
        refused_right = sendrec.record(self.conn, trigger="send", herdr_session="esim", pane_id="w1:p1", session_id=B, check_result="other_session", check_session=A)
        refused_wrong = sendrec.record(self.conn, trigger="send", herdr_session="esim", pane_id="w1:p1", session_id=A, check_result="other_session", check_session=B)
        no_pane = sendrec.record(self.conn, trigger="send", herdr_session="esim", pane_id="w9:p9", session_id=A, check_result="no_pane")
        self.assertEqual([self.agree(i) for i in (ok, wrong_ok, refused_right, refused_wrong, no_pane)], [1, 0, 1, 0, None])
        row = self.rows("SELECT * FROM send_checks WHERE check_id = ?", ok)[0]
        self.assertEqual((row["store_session"], row["store_source"]), (A, "pid_record"))

    def test_ground_truth_is_the_send_checks_decision(self):
        info = lambda *procs: {"foreground_processes": [{"pid": p, "argv0": a} for p, a in procs]}
        records = {1001: {"session_id": A}, 1002: {"session_id": B}}
        self.assertEqual(sendrec.ground_truth(info((1001, "claude")), "claude", A, records), ("ok", A))
        self.assertEqual(sendrec.ground_truth(info((1002, "claude")), "claude", A, records), ("other_session", B))
        self.assertEqual(sendrec.ground_truth(info((1009, "claude")), "claude", A, records), ("ok", A), "a Claude with no record is let through")
        self.assertEqual(sendrec.ground_truth(info((3001, "zsh")), "claude", A, records), ("agent_not_foreground", None))
        self.assertEqual(sendrec.ground_truth(None, "claude", A, records), ("herdr_failed", None))
        self.assertEqual(sendrec.ground_truth(info((2001, "codex")), "codex", C, {}, lambda claimed, i: C), ("ok", C))
        self.assertEqual(sendrec.ground_truth(info((2001, "codex")), "codex", C, {}, lambda claimed, i: D), ("other_session", D))
        self.assertEqual(sendrec.ground_truth(info((2001, "codex")), "codex", C, {}, lambda claimed, i: None), ("agent_not_foreground", None))

    def test_audit_compares_every_live_binding_with_the_foreground(self):
        counts = sendrec.audit(self.conn, self.lab.client(), self.ident)
        self.assertEqual(counts, {"checked": 1, "agree": 1, "disagree": 0, "unscored": 0})
        self.assertEqual(self.one("SELECT trigger FROM send_checks"), "audit")
        self.lab.pid_record(1001, B)  # /clear: the record moved on and the store has not looked yet
        counts = sendrec.audit(self.conn, self.lab.client(), self.ident)
        self.assertEqual(counts["disagree"], 1, "the store is stale for a moment, and the audit says so")
        self.ident.poll_pid_records()
        self.assertEqual(sendrec.audit(self.conn, self.lab.client(), self.ident)["disagree"], 0)

    def test_the_binding_is_read_from_the_current_life_only(self):
        self.assertEqual(sendrec.store_binding(self.conn, "esim", "w1:p1")["session_id"], A)
        self.assertIsNone(sendrec.store_binding(self.conn, "esim", "w9:p9"))
        self.assertIsNone(sendrec.store_binding(self.conn, "no-such-session", "w1:p1"))


class Disagreements(StoreCase):
    def setUp(self):
        super().setUp()
        self.lab = Lab(self.home)
        self.addCleanup(self.lab.close)
        self.ident = identity.Identity(self.conn, self.lab.client(), self.home, proc_start=self.lab.proc_start, alive=self.lab.alive)
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=A, pid=1001)
        self.lab.pid_record(1001, A)
        self.lab.pane("esim", "w1:p2", agent="claude", agent_session=B, pid=1002)
        self.lab.pid_record(1002, B)
        self.ident.reconcile()

    def test_rows_open_persist_close_and_keep_their_verdict(self):
        agree = {("esim", "w1:p1"): {A}, ("esim", "w1:p2"): {B}}
        self.assertEqual(disagree.sample(self.conn, agree)["opened"], 0)
        # the builder maps pane 2 to another session, and a pane the store does not know
        theirs = {("esim", "w1:p1"): {A}, ("esim", "w1:p2"): {C}, ("esim", "w1:p7"): {D}}
        stats = disagree.sample(self.conn, theirs)
        self.assertEqual(stats["opened"], 2)
        rows = {r["kind"]: r for r in self.rows("SELECT * FROM disagreements")}
        self.assertEqual((rows["differs"]["store_session"], rows["differs"]["builder_session"], rows["differs"]["status"]), (B, C, "unadjudicated"))
        self.assertEqual(rows["builder_only"]["builder_session"], D)
        self.assertEqual(disagree.sample(self.conn, theirs)["seen_again"], 2)
        self.assertEqual(self.one("SELECT samples FROM disagreement_rows WHERE kind = 'differs'"), 2)
        disagree.adjudicate(self.conn, rows["differs"]["row_id"], "store-right", "Herdr kept the first id")
        summary = disagree.summary(self.conn)
        self.assertEqual((summary["total"], summary["unadjudicated"], summary["store_right"], summary["open_builder_right"]), (2, 1, 1, 0))
        stats = disagree.sample(self.conn, agree)  # they agree again
        self.assertEqual(stats["closed"], 2)
        self.assertEqual(self.one("SELECT COUNT(*) FROM disagreement_rows WHERE closed_at IS NULL"), 0)
        self.assertEqual(self.one("SELECT verdict FROM disagreement_rows WHERE kind = 'differs'"), "store-right", "a row keeps its verdict")

    def test_a_store_only_row_and_the_verdicts_are_checked(self):
        disagree.sample(self.conn, {("esim", "w1:p1"): {A}})
        self.assertEqual([r["kind"] for r in self.rows("SELECT kind FROM disagreement_rows")], ["store_only"])
        row_id = self.one("SELECT row_id FROM disagreement_rows")
        with self.assertRaises(ValueError):
            disagree.adjudicate(self.conn, row_id, "i-guess")
        with self.assertRaises(KeyError):
            disagree.adjudicate(self.conn, 999, "store-right")
        disagree.adjudicate(self.conn, row_id, "builder-right")
        self.assertEqual(disagree.summary(self.conn)["open_builder_right"], 1)

    def test_the_builder_map_is_made_from_the_builders_own_inventory(self):
        inventory = lambda: {A: {"herdr": "esim", "pane": "w1:p1"}, B: {"herdr": "esim", "pane": "w1:p1"}, C: {"herdr": "", "pane": ""}}
        self.assertEqual(disagree.builder_map(inventory), {("esim", "w1:p1"): {A, B}})


class Coverage(StoreCase):
    """A lab world that stages every row: the checker finds each one from the store's own records."""

    def test_every_row_is_found_in_a_staged_lab(self):
        lab = Lab(self.home)
        self.addCleanup(lab.close)
        ident = identity.Identity(self.conn, lab.client(), self.home, proc_start=lab.proc_start, alive=lab.alive)
        old = synth.sid(31)
        synth.write_jsonl(synth.claude_path(self.home, old), synth.claude_conversation(base=synth.T0 - 86400, n_turns=1))
        comp = synth.sid(32)
        compaction = [synth.c_user("start", synth.T0), synth.c_say("ok", synth.T0 + 1),
                      synth.c_user("This session is being continued from a previous conversation that ran out of context.", synth.T0 + 2), synth.c_say("continuing", synth.T0 + 3)]
        synth.write_jsonl(synth.claude_path(self.home, comp), compaction)
        self.ing.scan()
        lab.session("esim")
        lab.session("w2A")
        # Claude pane, with a /clear, then a restart onto the same session (model swap), then onto an old session (resume), Ctrl+Z, close
        lab.pane("esim", "w1:p1", agent="claude", agent_session=A, pid=1001)
        lab.pid_record(1001, A)
        ident.reconcile()
        lab.pid_record(1001, B)
        ident.poll_pid_records()
        lab.stop(1001)
        lab.set_foreground("esim", "w1:p1", 1002)
        lab.pid_record(1002, B)
        ident.pid_records.poll()
        ident.reconcile()
        lab.stop(1002)
        lab.set_foreground("esim", "w1:p1", 1003)
        lab.pid_record(1003, old)
        ident.pid_records.poll()
        ident.reconcile()
        lab.set_foreground("esim", "w1:p1", 3003, harness="shell")
        ident.reconcile()
        lab.set_foreground("esim", "w1:p1", 1003)  # the same process returns
        ident.reconcile()
        # compaction in a bound session
        lab.pane("esim", "w1:p5", agent="claude", agent_session=comp, pid=1005)
        lab.pid_record(1005, comp)
        ident.reconcile()
        for turn in self.rows("SELECT at FROM turns WHERE kind = 'compacted'"):
            self.conn.execute("UPDATE bindings SET valid_from = ? WHERE session_id = ?", (turn["at"] - 5, comp))
        # a Codex worker, a Pi pane, a personal-account pane, a pane in a second Herdr session
        lab.pane("esim", "w1:p2", agent="codex", agent_session=C, pid=2001, harness="codex")
        ident.reconcile()
        lab.find("esim", "w1:p2")["agent_session"] = synth.sid(36)  # Codex /clear: the same process, a new session id reported
        lab.save()
        ident.reconcile()
        lab.pane("esim", "w1:p3", agent="pi", agent_session=D, pid=4001, harness="pi")
        personal = synth.sid(33)
        synth.write_jsonl(synth.claude_path(self.home, personal, folder=".claude-personal"), synth.claude_conversation(n_turns=1, org="org-p"))
        self.ing.scan()
        lab.pane("esim", "w1:p4", agent="claude", agent_session=personal, pid=1004)
        lab.pid_record(1004, personal, folder=".claude-personal")
        lab.pane("w2A", "w1:p1", agent="claude", agent_session=synth.sid(34), pid=1006)
        lab.pid_record(1006, synth.sid(34))
        ident.reconcile()
        lab.remove_pane("esim", "w1:p2")  # a pane that had a binding closes
        ident.reconcile()
        # Herdr restart
        lab.get("w2A")["running"] = False
        lab.save()
        ident.reconcile()
        lab.get("w2A")["running"] = True
        lab.save()
        ident.reconcile()
        rows = {r["key"]: r for r in coverage.evaluate(self.conn)}
        missing = [k for k, r in rows.items() if r["status"] != "observed"]
        self.assertEqual(missing, [], "rows the lab did not fill: " + ", ".join(missing))
        self.assertTrue(coverage.complete(list(rows.values())))
        text = coverage.render(list(rows.values()))
        self.assertIn("12 of 12 rows filled", text)
        evidence = rows["clear_claude"]["evidence"][0]
        self.assertEqual((evidence["before"], evidence["after"], evidence["pane"]), (A, B, "w1:p1"))

    def test_an_empty_store_has_every_row_open_and_marks_fill_them(self):
        rows = coverage.evaluate(self.conn)
        self.assertEqual({r["status"] for r in rows}, {"open"})
        self.assertFalse(coverage.complete(rows))
        coverage.mark(self.conn, "herdr_restart", "staged-in-lab", "restarted the lab's Herdr")
        coverage.mark(self.conn, "pi_pane", "waived", "no Pi pane this week")
        by = {r["key"]: r["status"] for r in coverage.evaluate(self.conn)}
        self.assertEqual((by["herdr_restart"], by["pi_pane"], by["ctrl_z"]), ("staged-in-lab", "waived", "open"))
        with self.assertRaises(ValueError):
            coverage.mark(self.conn, "ctrl_z", "observed", "x")
        with self.assertRaises(KeyError):
            coverage.mark(self.conn, "no-row", "waived", "x")
        self.assertIn("waiting:", coverage.render(coverage.evaluate(self.conn)))


class Rusage(StoreCase):
    def test_meter_and_report(self):
        with rusage.meter(self.conn, "ingest", "test") as use:
            sum(i * i for i in range(200000))
        self.assertGreater(use["user_s"] + use["sys_s"], 0)
        self.assertGreater(use["maxrss_kb"], 1000)
        self.conn.execute("INSERT INTO ingest_lag(at, lag_s) VALUES (?, ?)", (time.time(), 1.0))
        for lag in (0.1, 0.2, 0.3, 9.0):
            self.conn.execute("INSERT INTO ingest_lag(at, lag_s) VALUES (?, ?)", (time.time(), lag))
        report = rusage.report(self.conn)
        self.assertEqual(report["components"]["ingest"]["samples"], 1)
        self.assertEqual(report["lag"]["samples"], 5)
        self.assertEqual(report["lag"]["max_s"], 9.0)
        self.assertIsNone(rusage.p95([]))
        self.assertEqual(rusage.p95(list(range(1, 101))), 95)

    def test_window_records_the_daemons_own_cpu(self):
        clock = [1000.0]
        window = rusage.Window(self.conn, "ingest", 300.0, lambda: clock[0])
        self.assertFalse(window.tick())
        clock[0] += 301
        sum(i * i for i in range(100000))
        self.assertTrue(window.tick())
        self.assertEqual(self.rows("SELECT component, note FROM rusage_samples"), [{"component": "ingest", "note": "window"}])


class Scorecard(StoreCase):
    def test_a_new_store_reads_open_everywhere_and_nothing_is_pass_by_default(self):
        text = scorecard.render(self.conn, now=1_790_000_000.0)
        self.assertNotIn("**PASS**", text)
        self.assertEqual(sum(1 for line in text.splitlines() if line.startswith("| ") and "**OPEN**" in line), 7)
        self.assertIn("Overall (checks 1 to 7): **OPEN**", text)
        self.assertIn("## 8. Verdict", text)

    def test_a_disagreement_or_a_parity_mismatch_is_a_fail_and_the_numbers_come_from_the_store(self):
        now = 1_790_000_000.0
        self.conn.execute("INSERT INTO parity_runs(at, trigger, sessions, turns, mismatches, unexplained) VALUES (?, 'nightly', 10, 100, 2, 2)", (now - 3600,))
        self.conn.execute("INSERT INTO send_checks(at, trigger, session_id, store_session, check_result) VALUES (?, 'send', ?, ?, 'ok')", (now, A, B))
        text = scorecard.render(self.conn, now=now)
        self.assertIn("2 unexplained mismatches", text)
        self.assertIn("Send: 1 checks, 1 disagree", text)
        self.assertEqual(sum(1 for line in text.splitlines() if line.startswith("| ") and "**FAIL**" in line), 2)
        self.assertIn("Overall (checks 1 to 7): **FAIL**", text)

    def test_checks_pass_when_their_evidence_is_in(self):
        now = 1_790_000_000.0
        for day in range(3):
            self.conn.execute("INSERT INTO parity_runs(at, trigger, sessions, turns, mismatches, unexplained) VALUES (?, 'nightly', 10, 100, 0, 0)", (now - day * 86400 - 600,))
        self.conn.execute("INSERT INTO send_checks(at, trigger, session_id, store_session, check_result) VALUES (?, 'send', ?, ?, 'ok')", (now, A, A))
        self.conn.execute("INSERT INTO builder_samples(at) VALUES (?)", (now,))
        text = scorecard.render(self.conn, now=now)
        rows = {line.split("|")[1].strip(): line for line in text.splitlines() if line.startswith("| ") and "**" in line}
        self.assertIn("**PASS**", rows["1. Turn parity, automated"])
        self.assertIn("**PASS**", rows["2. Identity at the moment it matters"])
        self.assertIn("**PASS**", rows["3. Disagreement adjudication"])


if __name__ == "__main__":
    unittest.main()
