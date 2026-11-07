"""Live pane identity: liveness before rank, the wide key, expiry on every kind of change, and the Herdr event stream.

Everything runs against the fake Herdr of fake_herdr.py (CLI shim and event socket) and fake processes; nothing real is read or sent.
"""

from __future__ import annotations

import time
import unittest

from base import StoreCase
from lab import Lab
import synth
from rstore import herdr as herdr_mod, identity

A, B, C, D = synth.sid(11), synth.sid(12), synth.sid(13), synth.sid(14)


class IdentityCase(StoreCase):
    def setUp(self):
        super().setUp()
        self.lab = Lab(self.home)
        self.addCleanup(self.lab.close)
        self.ident = identity.Identity(self.conn, self.lab.client(), self.home, proc_start=self.lab.proc_start, alive=self.lab.alive)

    def reconcile(self):
        return self.ident.reconcile()

    def binding(self, session="esim", pane="w1:p1"):
        rows = self.rows("SELECT * FROM bindings WHERE herdr_session = ? AND pane_id = ? AND valid_to IS NULL", session, pane)
        return rows[0] if rows else None

    def events(self, *kinds):
        marks = ",".join("?" * len(kinds))
        return self.rows(f"SELECT * FROM identity_events WHERE kind IN ({marks}) ORDER BY event_id", *kinds)


class Ranking(IdentityCase):
    def test_a_pid_record_beats_a_stale_herdr_report(self):
        """The review's finding: Herdr said B, a live Claude in the pane runs A. The pid record is the answer."""
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=B, pid=1001)
        self.lab.pid_record(1001, A)
        self.reconcile()
        binding = self.binding()
        self.assertEqual((binding["session_id"], binding["source"]), (A, "pid_record"))
        facts = {f["source"]: f["session_id"] for f in self.rows("SELECT * FROM facts WHERE valid_to IS NULL")}
        self.assertEqual(facts, {"pid_record": A, "herdr_report": B}, "the lower-ranked fact is kept, and is live")
        self.assertEqual(self.rows("SELECT session_id, source FROM v1_live_bindings"), [{"session_id": A, "source": "pid_record"}])

    def test_herdr_report_is_used_when_there_is_no_record(self):
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="codex", agent_session=C, pid=2001, harness="codex")
        self.reconcile()
        self.assertEqual((self.binding()["session_id"], self.binding()["source"]), (C, "herdr_report"))

    def test_cwd_inference_is_the_last_resort_and_never_beats_a_report(self):
        synth.write_jsonl(synth.codex_path(self.home, C), synth.codex_conversation(C, cwd="/work/codex"))
        synth.write_jsonl(synth.codex_path(self.home, D, day="2026/11/07"), synth.codex_conversation(D, cwd="/work/codex", base=synth.T0 + 5000))
        self.ing.scan()
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="codex", agent_session=None, pid=2001, harness="codex", cwd="/work/codex")
        self.reconcile()
        self.assertEqual((self.binding()["session_id"], self.binding()["source"]), (D, "cwd_inference"), "the newest session in that folder")
        self.lab.find("esim", "w1:p1")["agent_session"] = C  # Herdr now reports C anew
        self.lab.save()
        self.reconcile()
        self.assertEqual((self.binding()["session_id"], self.binding()["source"]), (C, "herdr_report"))

    def test_a_pid_record_for_another_process_with_the_same_pid_number_is_not_live(self):
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=B, pid=1001)
        self.lab.pid_record(1001, A, proc_start="Mon Jan  1 00:00:00 2024")  # a record left by an earlier process that had this pid
        self.reconcile()
        self.assertEqual((self.binding()["session_id"], self.binding()["source"]), (B, "herdr_report"))

    def test_the_binding_is_keyed_by_herdr_session_life_and_pane(self):
        """Two Herdr sessions with the same pane id, each with its own answer."""
        for name, session_id, pid in (("esim", A, 1001), ("w2A", B, 1002)):
            self.lab.session(name)
            self.lab.pane(name, "w1:p1", agent="claude", agent_session=session_id, pid=pid)
            self.lab.pid_record(pid, session_id)
        self.reconcile()
        self.assertEqual(sorted((r["herdr_session"], r["session_id"]) for r in self.rows("SELECT * FROM v1_live_bindings")), [("esim", A), ("w2A", B)])
        self.assertEqual(self.one("SELECT COUNT(DISTINCT terminal_id) FROM panes"), 2)


class Expiry(IdentityCase):
    def setUp(self):
        super().setUp()
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=A, pid=1001)
        self.lab.pid_record(1001, A)
        self.reconcile()
        self.assertEqual(self.binding()["session_id"], A)

    def test_clear_rebinds_within_one_process_and_the_old_fact_expires(self):
        self.lab.pid_record(1001, B)  # /clear: the same process, a new session
        self.ident.poll_pid_records()
        self.assertEqual(self.binding()["session_id"], B)
        rebind = self.events("rebind")[-1]
        self.assertEqual((rebind["before_session"], rebind["after_session"], rebind["reason"], rebind["source"]), (A, B, "new_pid_record", "pid_record"))
        old = self.rows("SELECT * FROM facts WHERE session_id = ? AND source = 'pid_record'", A)[0]
        self.assertEqual(old["expired_reason"], "new_pid_record")
        self.assertEqual(self.rows("SELECT end_reason FROM bindings WHERE session_id = ?", A), [{"end_reason": "rebind"}])

    def test_the_old_pid_record_stops_counting_when_its_process_dies(self):
        self.lab.stop(1001)
        self.ident.poll_pid_records()
        self.assertIsNone(self.binding())
        self.assertEqual({f["expired_reason"] for f in self.rows("SELECT * FROM facts")}, {"process_exited"})
        self.assertEqual(self.events("unbind")[-1]["reason"], "process_exited")

    def test_ctrl_z_leaves_a_shell_in_the_foreground_and_unbinds(self):
        self.lab.set_foreground("esim", "w1:p1", 3001, harness="shell")
        self.reconcile()
        self.assertIsNone(self.binding(), "Herdr still names the agent, but a shell holds the foreground")
        event = self.events("foreground_changed")[-1]
        self.assertEqual((event["reason"], event["harness"]), ("harness_left_foreground", "claude"))
        self.lab.set_foreground("esim", "w1:p1", 1001)  # fg again
        self.reconcile()
        self.assertEqual(self.binding()["session_id"], A)
        self.assertEqual(self.events("foreground_changed")[-1]["reason"], "harness_entered_foreground")

    def test_a_restart_in_the_same_pane_expires_the_old_facts_and_ignores_a_report_that_did_not_change(self):
        """Firstmate swaps a worker's model by restarting Claude in its pane. Herdr keeps the first id."""
        self.lab.stop(1001)
        self.lab.set_foreground("esim", "w1:p1", 1002)
        self.reconcile()
        self.assertIsNone(self.binding(), "no record for the new process, and Herdr's value is the one from before the restart")
        self.assertEqual(self.events("process_restart")[-1]["detail"], '{"pid": 1002, "was_harness": "claude", "was_pid": 1001}')
        self.assertTrue(self.events("fact_expired"))
        self.lab.pid_record(1002, A)  # the restarted Claude resumed the same session
        self.ident.poll_pid_records()
        self.reconcile()
        self.assertEqual((self.binding()["session_id"], self.binding()["source"]), (A, "pid_record"))

    def test_a_report_that_changes_is_taken_after_a_restart(self):
        self.lab.stop(1001)
        self.lab.set_foreground("esim", "w1:p1", 1002, harness="codex")
        self.lab.find("esim", "w1:p1").update(agent="codex", agent_session=C)
        self.lab.save()
        self.reconcile()
        self.assertEqual((self.binding()["session_id"], self.binding()["source"]), (C, "herdr_report"))

    def test_a_pane_that_is_gone_from_the_listing_is_closed(self):
        self.lab.remove_pane("esim", "w1:p1")
        stats = self.reconcile()
        self.assertEqual(stats["closed"], 1)
        self.assertIsNone(self.binding())
        pane = self.rows("SELECT * FROM panes")[0]
        self.assertEqual(pane["close_reason"], "pane_closed")
        self.assertEqual({f["expired_reason"] for f in self.rows("SELECT * FROM facts")}, {"pane_closed"})
        self.assertEqual(self.events("pane_closed")[-1]["pane_id"], "w1:p1")

    def test_a_herdr_that_cannot_say_what_runs_in_a_pane_unbinds_nothing(self):
        self.lab.get("esim")["fail"] = "process-info"
        self.lab.save()
        self.reconcile()
        self.assertEqual(self.binding()["session_id"], A, "a failed read is not evidence")

    def test_a_session_deleted_and_made_again_is_a_new_life_with_its_own_panes(self):
        """The same pane id, a different Herdr life: the old binding ends, the new one is separate."""
        self.lab.get("esim")["dir"] = str(self.lab.dir / "esim-again")
        (self.lab.dir / "esim-again").mkdir()
        self.lab.pane("esim", "w1:p2", agent="claude", agent_session=B, pid=1005)
        self.lab.pid_record(1005, B)
        self.lab.save()
        self.reconcile()
        lives = self.rows("SELECT life, ended_at FROM herdr_lives WHERE herdr_session = 'esim' ORDER BY first_seen")
        self.assertEqual(len(lives), 2)
        self.assertIsNotNone(lives[0]["ended_at"])
        self.assertEqual(self.events("life_change")[-1]["herdr_session"], "esim")
        panes = self.rows("SELECT life, pane_id, closed_at, close_reason FROM panes WHERE pane_id = 'w1:p1' ORDER BY first_seen")
        self.assertEqual(len(panes), 2, "the same pane id is two panes: one per life")
        self.assertEqual(panes[0]["close_reason"], "life_change")
        self.assertIsNone(panes[1]["closed_at"])
        self.assertEqual(self.rows("SELECT end_reason FROM bindings WHERE session_id = ? ORDER BY binding_id", A)[0]["end_reason"], "life_change")

    def test_herdr_stopping_and_coming_back(self):
        self.lab.get("esim")["running"] = False
        self.lab.save()
        self.reconcile()
        self.assertIsNone(self.binding())
        self.assertEqual(self.events("herdr_stopped")[-1]["herdr_session"], "esim")
        self.assertEqual(self.rows("SELECT closed_at FROM panes")[0]["closed_at"], None, "the panes come back with their ids after a restart")
        self.lab.get("esim")["running"] = True
        self.lab.stop(1001)
        self.lab.set_foreground("esim", "w1:p1", 1007)
        self.lab.pid_record(1007, A)
        self.reconcile()
        self.assertEqual(self.events("herdr_started")[-1]["herdr_session"], "esim")
        self.assertEqual(self.binding()["session_id"], A)

    def test_a_pane_that_exits_expires_its_facts_at_once(self):
        key = ("esim", self.one("SELECT life FROM panes"), "w1:p1")
        self.ident.exit_pane(key, time.time())
        self.assertIsNone(self.binding())
        self.assertEqual(self.events("pane_exited")[-1]["pane_id"], "w1:p1")

    def test_every_change_leaves_an_event_with_before_and_after(self):
        self.lab.pid_record(1001, B)
        self.ident.poll_pid_records()
        self.lab.set_foreground("esim", "w1:p1", 3001, harness="shell")
        self.reconcile()
        kinds = [(e["kind"], e["before_session"], e["after_session"]) for e in self.events("bind", "rebind", "unbind")]
        self.assertEqual(kinds, [("bind", None, A), ("rebind", A, B), ("unbind", B, None)])


class Forgotten(IdentityCase):
    def test_a_pane_still_running_a_forgotten_session_leaves_no_trace_of_it(self):
        from rstore import forget
        synth.write_jsonl(synth.claude_path(self.home, A), synth.claude_conversation(n_turns=1))
        synth.write_jsonl(synth.claude_path(self.home, B), synth.claude_conversation(n_turns=1))
        self.ing.scan()
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=A, pid=1001)
        self.lab.pid_record(1001, A)
        self.reconcile()
        self.assertEqual(self.binding()["session_id"], A)
        forget.forget(self.conn, A)
        self.assertEqual(self.rows("SELECT herdr_value FROM panes"), [{"herdr_value": None}], "not even the id Herdr reported is kept")
        self.reconcile()
        self.ident.poll_pid_records()
        self.assertIsNone(self.binding(), "the pane still runs it, and the store says nothing")
        for table, column in (("facts", "session_id"), ("bindings", "session_id"), ("identity_events", "after_session"), ("identity_events", "before_session")):
            self.assertEqual(self.one(f"SELECT COUNT(*) FROM {table} WHERE {column} = ?", A), 0, f"{table}.{column}")
        self.assertEqual(self.rows("SELECT herdr_value FROM panes"), [{"herdr_value": None}])
        # a /clear from the forgotten session to another is not linked either, and the other session is bound as usual
        self.lab.pid_record(1001, B)
        self.ident.poll_pid_records()
        self.assertEqual(self.binding()["session_id"], B)
        self.assertEqual(self.ident.infer_links(), 0)
        self.assertEqual(self.one("SELECT COUNT(*) FROM links WHERE from_session = ? OR to_session = ?", A, A), 0)


class Links(IdentityCase):
    def test_a_clear_is_linked_when_the_new_session_opens_with_the_command(self):
        sid_a, sid_b = synth.sid(21), synth.sid(22)
        synth.write_jsonl(synth.claude_path(self.home, sid_a), synth.claude_conversation(n_turns=1))
        clear = synth.c_user("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>", synth.T0 + 100)
        synth.write_jsonl(synth.claude_path(self.home, sid_b), [clear, synth.c_user("fresh start", synth.T0 + 101), synth.c_say("ok", synth.T0 + 102)])
        self.ing.scan()
        self.lab.session("esim")
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=sid_a, pid=1001)
        self.lab.pid_record(1001, sid_a)
        self.reconcile()
        self.lab.pid_record(1001, sid_b)
        self.ident.poll_pid_records()
        self.assertEqual(self.ident.infer_links(), 1)
        self.assertEqual(self.rows("SELECT from_session, to_session, kind, basis FROM links"),
                         [{"from_session": sid_a, "to_session": sid_b, "kind": "clear", "basis": "inferred"}])
        self.assertEqual(self.ident.infer_links(), 0, "inferred once")


class Events(IdentityCase):
    """The subscription: a hint that something changed, always followed by a read."""

    def setUp(self):
        super().setUp()
        self.lab.session("esim", serve=True)
        self.feed = herdr_mod.Feed(self.lab.client())
        self.addCleanup(self.feed.stop)
        self.feed.sync(self.lab.client().sessions())

    def wait_subscribed(self):
        deadline = time.time() + 5
        while self.lab.server.subscribers("esim") < 1 and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(self.lab.server.subscribers("esim"), 1)
        request = next(r for r in self.lab.server.requests if r.get("method") == "events.subscribe")
        self.assertEqual(sorted(s["type"] for s in request["params"]["subscriptions"]),
                         sorted(["pane.created", "pane.closed", "pane.updated", "pane.exited", "pane.agent_detected", "pane.moved"]))

    def pump(self, wait=3.0, until=None):
        """Take items from the subscription until <until(item)> is true of one of them (or <wait> seconds pass), handle them as the
        daemon would, and read the panes they named."""
        seen = []
        deadline = time.time() + wait
        while time.time() < deadline:
            for item in self.feed.drain(0.1):
                seen.append(item)
                self.ident.on_item(item)
            if until is None:
                if any(i[0] == "event" for i in seen):
                    break
            elif any(until(i) for i in seen):
                break
        self.ident.process_dirty()
        return seen

    def test_a_created_pane_is_read_when_the_event_arrives(self):
        self.wait_subscribed()
        self.lab.pane("esim", "w1:p9", agent="claude", agent_session=A, pid=1009)
        self.lab.pid_record(1009, A)
        self.lab.server.emit("esim", "pane.created", pane={"pane_id": "w1:p9"}, workspace_id="w1")
        items = self.pump(until=lambda i: i[0] == "event" and i[3] == "pane.created")
        self.assertTrue(any(i[0] == "event" and i[3] == "pane.created" for i in items))
        self.assertEqual(self.binding(pane="w1:p9")["session_id"], A)
        self.assertEqual(self.events("pane_created")[-1]["pane_id"], "w1:p9")

    def test_the_schema_s_underscore_names_are_accepted_too(self):
        self.wait_subscribed()
        self.lab.pane("esim", "w1:p9", agent="claude", agent_session=A, pid=1009)
        self.lab.pid_record(1009, A)
        self.lab.server.emit("esim", "pane_updated", pane={"pane_id": "w1:p9"})
        self.pump(until=lambda i: i[0] == "event")
        self.assertEqual(self.binding(pane="w1:p9")["session_id"], A)

    def test_a_closed_pane_event_expires_the_binding_without_waiting_for_a_poll(self):
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=A, pid=1001)
        self.lab.pid_record(1001, A)
        self.reconcile()
        self.wait_subscribed()
        self.lab.server.emit("esim", "pane.closed", pane_id="w1:p1", workspace_id="w1")
        self.pump(until=lambda i: i[0] == "event")
        self.assertIsNone(self.binding())
        self.assertEqual(self.events("pane_closed")[-1]["reason"], "pane_closed")

    def test_events_lost_makes_a_full_reconcile(self):
        """The event that closed a pane was missed: an explicit events_lost line is enough to find it."""
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=A, pid=1001)
        self.lab.pid_record(1001, A)
        self.reconcile()
        self.wait_subscribed()
        self.lab.remove_pane("esim", "w1:p1")  # no event is sent for it
        self.lab.server.lose_events("esim")
        items = self.pump(until=lambda i: i[0] == "lost")
        self.assertTrue(any(i[0] == "lost" and i[3] == "events_lost" for i in items))
        self.assertIsNone(self.binding())
        self.assertEqual(self.events("events_lost")[-1]["reason"], "events_lost")
        self.assertEqual(self.events("pane_closed")[-1]["pane_id"], "w1:p1")

    def test_a_dropped_connection_is_a_loss_and_the_subscription_comes_back(self):
        self.wait_subscribed()
        self.lab.pane("esim", "w1:p1", agent="claude", agent_session=A, pid=1001)
        self.lab.pid_record(1001, A)
        self.lab.server.drop("esim")
        items = self.pump(5.0, until=lambda i: i[0] == "lost")
        self.assertTrue(any(i[0] == "lost" and i[3] == "disconnect" for i in items))
        self.assertEqual(self.binding()["session_id"], A, "the reconcile after the loss read the pane the stream never told us about")
        deadline = time.time() + 6
        while self.lab.server.subscribers("esim") < 1 and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.lab.server.subscribers("esim"), 1, "resubscribed")
        self.assertEqual(len([r for r in self.lab.server.requests if r.get("method") == "events.subscribe"]), 2)

    def test_the_feed_follows_the_running_sessions(self):
        self.lab.session("w2A", serve=True)
        self.feed.sync(self.lab.client().sessions())
        self.assertEqual(sorted(self.feed.subs), ["esim", "w2A"])
        self.lab.get("w2A")["running"] = False
        self.lab.save()
        self.feed.sync(self.lab.client().sessions())
        self.assertEqual(sorted(self.feed.subs), ["esim"])


class FakeHerdrSafety(unittest.TestCase):
    def test_the_fake_has_no_command_that_sends_anything(self):
        import subprocess, sys, os
        from pathlib import Path
        lab = Lab(Path(os.environ.get("TMPDIR", "/tmp")))
        self.addCleanup(lab.close)
        lab.session("esim")
        for argv in (["--session", "esim", "agent", "prompt", "w1:p1", "hello"], ["--session", "esim", "agent", "send-keys", "w1:p1", "Enter"]):
            done = subprocess.run([str(lab.shim), *argv], capture_output=True, text=True, env={**os.environ, "FAKE_HERDR_WORLD": str(lab.world_file)})
            self.assertNotEqual(done.returncode, 0)


if __name__ == "__main__":
    unittest.main()
