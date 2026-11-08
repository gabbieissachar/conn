"""Tests for the typed ask records the reader shows (prototype/typed_asks.py, typed_lines.py, and the sheet and count code that uses them).

Run from the repo root: python3 -m unittest setup/transcript-reader/test_typed_asks.py
Everything is invented text in temporary folders: the records, events and backlogs are written the way Firstmate's bin/fm-captain-ask.sh and
bin/fm-captain-hold.sh write them (TestCase.real_writer checks that against the real scripts when they are on this machine), the turns are
parsed by the builder's own parser. No real record, backlog or session log is read.
"""

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from reader import builder  # noqa: E402

import build_questionnaire as sheets  # noqa: E402
import typed_asks  # noqa: E402
import typed_lines  # noqa: E402

NOW = 1_800_000_000.0  # 2027-01-15T08:00:00Z: well after every time below
WRITER = "11111111-2222-4333-8444-555555555555"
CLEARED = "99999999-8888-4777-8666-555555555555"


def iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def sha12_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def card(key, question, options=(), recommended=None, gate=None):
    """A card as bin/fm-captain-ask.sh stores it. options are (value, note, recommended)."""
    opts = [{"value": v, "note": n, "recommended": bool(r)} for v, n, r in options]
    rec = next((o["value"] for o in opts if o["recommended"]), None)
    return {"key": key, "question": question, "options": opts, "recommended": rec if recommended is None else recommended, "gate": gate}


def gate(task, identity="2027-01-10T01:00:00Z#0", mode="done"):
    return {"task": task, "mode": mode, "identity": identity}


def write_record(home, ask_id, cards, title="Sample ask", writer=WRITER, role="leader", created="2027-01-10T02:00:00Z", expires=None,
           revises=(), schema="fm-ask.v1", events=(), label="leader-sample", origin=None):
    body = {"schema": schema, "id": ask_id, "created_at": created, "home": {"path": str(home), "label": label, "role": "leader"},
            "writer": {"session_id": writer, "harness": "claude", "role": role, "captain_driven": False, "task_id": "t-1"},
            "title": title, "kind": "decision", "cards": cards, "revises": [{"id": i, "key": k} for i, k in revises], "expires_at": expires}
    if origin:
        body["origin"] = origin
    folder = Path(home) / "state" / "ask-records"
    folder.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(body, separators=(",", ":")) + "\n").encode()
    (folder / f"{ask_id}.json").write_bytes(data)
    sha = sha12_of(data)
    lines = [{"at": created, "event": "opened", "sha": sha}, *events]
    (folder / f"{ask_id}.events").write_text("".join(json.dumps(e, separators=(",", ":")) + "\n" for e in lines), encoding="utf-8")
    return sha


class World:
    """Homes in a temporary folder: records, events and backlogs written as Firstmate writes them."""

    def __init__(self, test):
        self.root = Path(tempfile.mkdtemp(prefix="typed-asks-"))
        test.addCleanup(shutil.rmtree, self.root, True)
        self.home = self.make_home("leader")
        self.mate = self.make_home("mate")

    def make_home(self, name):
        home = self.root / name
        (home / "state").mkdir(parents=True)
        (home / "data").mkdir()
        (home / ".tasks.toml").write_text('backend = "markdown"\n\n[markdown]\npath = "data/backlog.md"\n', encoding="utf-8")
        self.backlog(home, [])
        return home

    def backlog(self, home, rows):
        """rows: (task, state, reason, hold_set, resolutions) with state 'held', 'plain' or 'done'."""
        lines = ["## In flight", "", "## Queued"]
        done = []
        for task, state, reason, hold_set, resolutions in rows:
            hold = f" (hold: fm-hold-v1:{base64.b64encode(reason.encode()).decode().rstrip('=')}) (hold-kind: captain)" if state != "plain" else ""
            box = "x" if state == "done" else " "
            row = [f"- [{box}] {task} - Title of {task} (repo: sample) (kind: captain){hold}"]
            if state != "plain":
                row.append(f"  Captain hold set: {hold_set}")
            row += ["  Resolution recorded by fm-captain-hold.", "  Resolution mode: answered"] * resolutions
            row += ["", "  Created: 2027-01-10T01:00:01Z"]
            (done if state == "done" else lines).extend(row)
        lines += ["## Done"] + done
        (home / "data" / "backlog.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def record(self, home, ask_id, cards, **kwargs):
        return write_record(home, ask_id, cards, **kwargs)

    def event(self, home, ask_id, **fields):
        with open(home / "state" / "ask-records" / f"{ask_id}.events", "a", encoding="utf-8") as handle:
            handle.write(json.dumps(fields, separators=(",", ":")) + "\n")


def ts(n):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(1_799_990_000 + n))


def turn(n, text, reply, tools=(), wake=False):
    """The log records of one turn: an input (the captain's, or a wake-up), tool calls (command, output) and the reply."""
    out = [{"type": "user", "timestamp": ts(n), "message": {"role": "user", "content": (
        "<task-notification>\nfirstmate watcher wake\nsignal: /home/state/x.status\n</task-notification>" if wake else text)}}]
    for i, (command, output) in enumerate(tools):
        call = f"toolu_{n}_{i}"
        out.append({"type": "assistant", "timestamp": ts(n + 1), "cwd": "/repo", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": call, "name": "Bash", "input": {"command": command}}]}})
        out.append({"type": "user", "timestamp": ts(n + 2), "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": call, "content": output}]}})
    if reply:
        out.append({"type": "assistant", "timestamp": ts(n + 3), "cwd": "/repo", "message": {"role": "assistant", "content": [{"type": "text", "text": reply}]}})
    return out


def exchanges_of(*turns):
    return builder.session_exchanges([record for t in turns for record in t])


def line_of(ask_id, sha, cards="Z1,Z2", gates=2, home="leader-sample"):
    return f"fm-captain-ask: recorded 2 cards ({gates} gated). Put the id from the last line in your reply footer as `ask: {ask_id}`.\nASK_RECORD v1 {ask_id} cards={cards} gates={gates} sha={sha} home={home}"


ASK = "ask-20270110T020000Z-aaaa"
ASK2 = "ask-20270111T020000Z-bbbb"
REPLY = (f"Two calls for you.\n\n| ID | Decision | Recommended | Answer |\n| --- | --- | --- | --- |\n| Z1 | Which mapping? | `a` | `a` or `b` |\n"
         f"| Z2 | Who closes it? | `leader` | `leader` or `hook` |\n\nReply with keyed answers: `Z1=...; Z2=...`\n\nask: {ASK}")


class LinesTest(unittest.TestCase):
    def test_record_answered_and_ack_lines_are_found_in_a_tool_output(self):
        text = (f"fm-captain-ask: recorded 2 cards\nASK_RECORD v1 {ASK} cards=Z1,Z2 gates=2 sha=0123456789ab home=big-boss\n"
                f"card Z1=a\nASK_ANSWERED v1 {ASK} state=partial answered=Z1 open=Z2 closed=gate-a,gate-b sha=0123456789ab\n"
                "WAKE_ACK: nothing-new through=1834\n")
        found = typed_lines.scan_outputs([text], ["bin/fm-wake-drain.sh --ack-through 1834 --recovery-generation 3"], f"Done.\n\nask: `{ASK}`")
        self.assertEqual(found["records"], [{"id": ASK, "sha": "0123456789ab", "cards": ["Z1", "Z2"], "home": "big-boss"}])
        self.assertEqual(found["answered"], [{"id": ASK, "state": "partial", "sha": "0123456789ab", "closed": ["gate-a", "gate-b"]}])
        self.assertEqual(found["ack"], {"verdict": "nothing-new", "through": 1834})
        self.assertEqual(found["acks"], 1)
        self.assertEqual(found["footer"], [ASK])

    def test_a_line_inside_another_line_or_with_the_wrong_shape_is_not_a_record(self):
        text = (f"grep hit: ASK_RECORD v1 {ASK} cards=Z1 gates=0 sha=0123456789ab home=x\n"
                f"ASK_RECORD v2 {ASK} cards=Z1 gates=0 sha=0123456789ab home=x\n"
                "ASK_RECORD v1 ask-bogus cards=Z1 gates=0 sha=0123456789ab home=x\n"
                "WAKE_ACK_REQUIRED: after handling run bin/fm-wake-drain.sh --ack-through 5\n"
                "WAKE_ACK: soon through=5\n")
        self.assertIsNone(typed_lines.scan_outputs([text], [], "no footer here"))

    def test_a_bad_sha_is_kept_empty_so_the_link_check_fails(self):
        found = typed_lines.scan_outputs([f"ASK_RECORD v1 {ASK} cards=Z1 gates=0 sha=zz home=x"], [], "")
        self.assertEqual(found["records"][0]["sha"], "")

    def test_the_footer_in_a_reply_and_nothing_else_is_none(self):
        self.assertEqual(typed_lines.scan_outputs([], [], f"Text\n\n- ask: {ASK}\n")["footer"], [ASK])
        self.assertIsNone(typed_lines.scan_outputs(["plain output"], ["ls"], "I asked about ask: nothing"))

    def test_a_turn_is_scanned_when_it_is_finished_and_kept_with_the_parsed_turn(self):
        exchange = exchanges_of(turn(0, "Ask him", REPLY, [("bin/fm-captain-ask.sh open --title T", line_of(ASK, "0123456789ab"))]))[0]
        self.assertEqual(exchange["typed_lines"]["records"][0]["id"], ASK)
        self.assertEqual(exchange["typed_lines"]["footer"], [ASK])
        plain = exchanges_of(turn(0, "Hello", "Hi."))[0]
        self.assertNotIn("records", plain.get("typed_lines", {}))  # only the parser's own keep-open mark, no ask lines


class StateTest(unittest.TestCase):
    def setUp(self):
        self.world = World(self)
        typed_asks._FILES.clear()

    def view(self, ask_id=ASK, facts=None, now=NOW, home=None):
        home = home or self.world.home
        return typed_asks.derive(typed_asks.load_record(home, ask_id), typed_asks.revised_pairs(home), facts, now)

    def test_an_unanswered_record_is_open_and_an_answered_one_partial_then_answered(self):
        cards = [card("Z1", "One?", [("a", "", True), ("b", "", False)], gate=gate("g1")), card("Z2", "Two?", gate=gate("g1"))]
        self.world.record(self.world.home, ASK, cards)
        self.assertEqual(self.view()["state"], "open")
        self.world.event(self.world.home, ASK, at=ts(5), event="card_answered", key="Z1", value="a")
        view = self.view()
        self.assertEqual((view["state"], view["open"], view["answered"]), ("partial", ["Z2"], ["Z1"]))
        self.world.event(self.world.home, ASK, at=ts(6), event="card_answered", key="Z2", value="free text")
        self.assertEqual(self.view()["state"], "answered")

    def test_the_later_answer_of_a_card_wins(self):
        self.world.record(self.world.home, ASK, [card("Z1", "One?")])
        self.world.event(self.world.home, ASK, at=ts(5), event="card_answered", key="Z1", value="a")
        self.world.event(self.world.home, ASK, at=ts(6), event="card_answered", key="Z1", value="b")
        self.assertEqual(self.view()["cards"][0]["value"], "b")

    def test_withdrawn_superseded_and_expired_cards(self):
        self.world.record(self.world.home, ASK, [card("Z1", "One?", gate=gate("g1")), card("Z2", "Two?", gate=gate("g1"))],
                          events=[{"at": ts(5), "event": "withdrawn", "reason": "no longer needed"}])
        view = self.view()
        self.assertEqual((view["state"], {c["state"] for c in view["cards"]}, view["withdrawn_reason"]), ("withdrawn", {"withdrawn"}, "no longer needed"))
        self.world.record(self.world.home, ASK2, [card("Z1", "One again?")], revises=[(ASK, "Z1")], created="2027-01-11T02:00:00Z")
        self.assertEqual(self.view()["cards"][0]["state"], "superseded")  # superseded is checked before withdrawn
        self.world.record(self.world.home, "ask-20270101T020000Z-cccc", [card("Z7", "Old?", gate=gate("g1"))], expires="2027-01-05T00:00:00Z")
        self.assertEqual(self.view("ask-20270101T020000Z-cccc")["state"], "expired")
        self.assertEqual(self.view("ask-20270101T020000Z-cccc", now=NOW - 86400 * 20)["state"], "open")

    def test_a_card_a_later_record_revises_is_superseded(self):
        self.world.record(self.world.home, ASK, [card("Z1", "One?"), card("Z2", "Two?")])
        self.world.record(self.world.home, ASK2, [card("Z1", "One, differently?")], revises=[(ASK, "Z1")], created="2027-01-11T02:00:00Z")
        view = self.view()
        self.assertEqual([(c["key"], c["state"]) for c in view["cards"]], [("Z1", "superseded"), ("Z2", "open")])
        self.assertEqual(view["state"], "open")

    def test_a_card_with_no_gate_expires_after_fourteen_days_and_a_gated_one_does_not(self):
        self.world.record(self.world.home, ASK, [card("Z1", "Chat only?"), card("Z2", "Gated?", gate=gate("g1"))], created="2027-01-01T00:00:00Z")
        view = self.view(now=NOW)  # 2027-01-15T08:00Z, fourteen days and eight hours later
        self.assertEqual([(c["key"], c["state"]) for c in view["cards"]], [("Z1", "expired"), ("Z2", "open")])
        view = self.view(now=NOW - 86400)
        self.assertEqual(view["cards"][0]["state"], "open")

    def test_a_gate_closed_elsewhere_or_held_again_changes_the_card(self):
        self.world.record(self.world.home, ASK, [card("Z1", "One?", gate=gate("g1")), card("Z2", "Two?", gate=gate("g2")), card("Z3", "Three?", gate=gate("g3"))])
        facts = {"g1": {"open": False, "identity": "", "reason": ""}, "g2": {"open": True, "identity": "2027-01-12T00:00:00Z#0", "reason": ""},
                 "g3": {"open": True, "identity": "2027-01-10T01:00:00Z#0", "reason": "why"}}
        view = self.view(facts=facts)
        self.assertEqual([(c["key"], c["state"]) for c in view["cards"]], [("Z1", "closed-elsewhere"), ("Z2", "stale"), ("Z3", "open")])
        self.assertEqual(view["state"], "open")
        facts["g3"] = {"open": None, "identity": "", "reason": ""}  # cannot tell: the card does not change
        self.assertEqual(self.view(facts=facts)["cards"][2]["state"], "open")
        self.assertEqual(self.view()["cards"][0]["state"], "open")  # the backlog was not consulted

    def test_an_answered_card_stays_answered_whatever_its_gate_does(self):
        self.world.record(self.world.home, ASK, [card("Z1", "One?", gate=gate("g1"))], events=[{"at": ts(5), "event": "card_answered", "key": "Z1", "value": "a"},
                                                                                           {"at": ts(6), "event": "gate_closed", "task": "g1"}])
        view = self.view(facts={"g1": {"open": False, "identity": "", "reason": ""}})
        self.assertEqual((view["state"], view["cards"][0]["gate_closed"]), ("answered", True))

    def test_an_unsupported_schema_and_a_broken_file_are_not_records(self):
        self.world.record(self.world.home, ASK, [card("Z1", "One?")], schema="fm-ask.v2")
        loaded = typed_asks.load_record(self.world.home, ASK)
        self.assertFalse(loaded["supported"])
        self.assertIsNone(typed_asks.derive(loaded, set(), None, NOW))
        (self.world.home / "state" / "ask-records" / f"{ASK2}.json").write_text("{not json", encoding="utf-8")
        self.assertIsNone(typed_asks.load_record(self.world.home, ASK2)["record"])
        self.assertIsNone(typed_asks.load_record(self.world.home, "ask-20270101T000000Z-dddd"))
        self.assertIsNone(typed_asks.load_record(self.world.home, "../etc/passwd"))

    def test_events_that_do_not_parse_are_skipped(self):
        self.world.record(self.world.home, ASK, [card("Z1", "One?")])
        with open(self.world.home / "state" / "ask-records" / f"{ASK}.events", "a", encoding="utf-8") as handle:
            handle.write("not json\n[1,2]\n{\"event\": 5}\n")
        self.world.event(self.world.home, ASK, at=ts(5), event="card_answered", key="Z1", value="a")
        self.assertEqual(self.view()["state"], "answered")


class BacklogTest(unittest.TestCase):
    def setUp(self):
        self.world = World(self)
        typed_asks._FILES.clear()
        typed_asks._BACKLOGS.clear()

    def test_a_held_task_is_an_open_call_with_its_reason_and_lifecycle_identity(self):
        self.world.backlog(self.world.home, [("g1", "held", "Pick a mapping for the cards", "2027-01-10T01:00:00Z", 0), ("g2", "plain", "", "", 0),
                                             ("g3", "done", "Old call", "2027-01-01T00:00:00Z", 1)])
        facts = typed_asks.gate_facts(self.world.home, ["g1", "g2", "g3", "gone"])
        self.assertEqual(facts["g1"], {"open": True, "identity": "2027-01-10T01:00:00Z#0", "reason": "Pick a mapping for the cards"})
        self.assertFalse(facts["g2"]["open"])  # a task held for no one
        self.assertFalse(facts["g3"]["open"])
        self.assertEqual(facts["g3"]["reason"], "Old call")  # a closed call still shows what it was
        self.assertEqual(facts["gone"], {"open": False, "identity": "", "reason": ""})

    def test_resolutions_are_counted_in_the_identity(self):
        self.world.backlog(self.world.home, [("g1", "held", "again", "2027-01-12T00:00:00Z", 1)])
        self.assertEqual(typed_asks.gate_facts(self.world.home, ["g1"])["g1"]["identity"], "2027-01-12T00:00:00Z#1")

    def test_a_backlog_the_reader_cannot_read_leaves_the_gate_unknown(self):
        (self.world.home / ".tasks.toml").write_text('backend = "sqlite"\n', encoding="utf-8")
        self.assertEqual(typed_asks.gate_facts(self.world.home, ["g1"])["g1"]["open"], None)
        (self.world.home / ".tasks.toml").write_text('backend = "markdown"\n', encoding="utf-8")
        (self.world.home / "data" / "backlog.md").unlink()
        self.assertEqual(typed_asks.gate_facts(self.world.home, ["g1"])["g1"]["open"], False)  # no backlog file: no captain calls

    def test_the_hold_reason_is_clipped(self):
        self.world.backlog(self.world.home, [("g1", "held", "word " * 200, "2027-01-10T01:00:00Z", 0)])
        reason = typed_asks.gate_facts(self.world.home, ["g1"])["g1"]["reason"]
        self.assertLessEqual(len(reason), typed_asks.HOLD_REASON_CHARS)
        self.assertTrue(reason.endswith("…"))

    def test_the_markdown_path_comes_from_tasks_toml(self):
        (self.world.home / ".tasks.toml").write_text('backend = "markdown"\n\n[markdown]\npath = "data/other.md"\n', encoding="utf-8")
        path, readable = typed_asks.backlog_path(self.world.home)
        self.assertEqual((path, readable), (self.world.home / "data" / "other.md", True))


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.world = World(self)
        typed_asks._FILES.clear()

    def check(self, printed_sha=None, chain=(WRITER,), tamper=False):
        sha = self.world.record(self.world.home, ASK, [card("Z1", "One?")])
        if tamper:
            path = self.world.home / "state" / "ask-records" / f"{ASK}.json"
            path.write_text(path.read_text(encoding="utf-8").replace("One?", "Two?"), encoding="utf-8")
            typed_asks._FILES.clear()
        loaded = typed_asks.load_record(self.world.home, ASK)
        printed = {"id": ASK, "sha": sha if printed_sha is None else printed_sha, "cards": ["Z1"], "home": "x"}
        return typed_asks.check_record(loaded, printed, chain)

    def test_a_record_the_turn_printed_by_a_chain_session_passes(self):
        checks = self.check()
        self.assertEqual(checks, {"linked": True, "unmodified": True, "writer": True})
        self.assertTrue(typed_asks.checks_ok(checks))

    def test_a_file_edited_after_it_was_printed_is_modified(self):
        checks = self.check(tamper=True)
        self.assertFalse(checks["unmodified"])
        self.assertFalse(typed_asks.checks_ok(checks))

    def test_a_printed_sha_that_is_not_the_files_is_modified_and_a_missing_one_is_not_linked_to_a_sha(self):
        self.assertFalse(self.check(printed_sha="ffffffffffff")["unmodified"])
        self.assertFalse(self.check(printed_sha="")["unmodified"])

    def test_a_writer_outside_the_conversation_fails(self):
        self.assertFalse(self.check(chain=(CLEARED,))["writer"])
        self.assertTrue(self.check(chain=(CLEARED, WRITER))["writer"])  # a /clear changed the id: the chain counts

    def test_an_events_file_whose_opened_sha_differs_fails(self):
        sha = self.world.record(self.world.home, ASK, [card("Z1", "One?")])
        events = self.world.home / "state" / "ask-records" / f"{ASK}.events"
        events.write_text(json.dumps({"at": ts(0), "event": "opened", "sha": "000000000000"}) + "\n", encoding="utf-8")
        typed_asks._FILES.clear()
        loaded = typed_asks.load_record(self.world.home, ASK)
        self.assertFalse(typed_asks.check_record(loaded, {"id": ASK, "sha": sha}, [WRITER])["unmodified"])


def ctx(world, chain=(WRITER,), home_id="leader", off=(), render=True, homes=None):
    return typed_asks.Context(homes or [world.home], chain, home_id, NOW, typed_asks.Settings(render, frozenset(off)))


def typed_conversation(world, cards=None, events=(), answers=(), extra_turns=(), gates=("g1",)):
    """A conversation whose first turn opened the ask ASK and replied with its prose cards; <answers> are the captain's later messages."""
    cards = cards or [card("Z1", "Which mapping?", [("a", "one", True), ("b", "two", False)], gate=gate("g1")),
                      card("Z2", "Who closes it?", [("leader", "", True), ("hook", "", False)], gate=gate("g1"))]
    sha = world.record(world.home, ASK, cards, events=events)
    world.backlog(world.home, [("g1", "held", "Pick the mapping and the closer", "2027-01-10T01:00:00Z", 0)])
    turns = [turn(0, "Please ask me", REPLY, [("bin/fm-captain-ask.sh open --title T", line_of(ASK, sha))])]
    for n, text in enumerate(answers):
        turns.append(turn(20 + n * 10, text, "Noted."))
    turns += list(extra_turns)
    return exchanges_of(*turns)


class AnnotateTest(unittest.TestCase):
    def setUp(self):
        self.world = World(self)
        typed_asks._FILES.clear()
        typed_asks._BACKLOGS.clear()

    def test_with_the_flag_off_nothing_changes(self):
        exchanges = typed_conversation(self.world)
        before = json.dumps(exchanges, sort_keys=True)
        self.assertEqual(typed_asks.annotate_exchanges(exchanges, ctx(self.world, render=False)), [])
        self.assertEqual(json.dumps(exchanges, sort_keys=True), before)
        self.assertNotIn("typed", exchanges[0])

    def test_the_flag_is_off_by_default_and_read_from_the_environment(self):
        self.assertFalse(typed_asks.settings({}).render)
        self.assertTrue(typed_asks.settings({"PMOS_READER_TYPED_ASKS": "on"}).render)
        self.assertFalse(typed_asks.settings({"PMOS_READER_TYPED_ASKS": "0"}).render)
        self.assertEqual(typed_asks.settings({"PMOS_READER_TYPED_PROSE_OFF": "a, b,,c"}).prose_off, frozenset({"a", "b", "c"}))
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PMOS_READER_TYPED_ASKS", None)
            self.assertFalse(typed_asks.settings().render)

    def test_a_linked_record_makes_the_turn_a_typed_open_ask(self):
        exchanges = typed_conversation(self.world)
        entries = typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        self.assertEqual(len(entries), 1)
        typed = exchanges[0]["typed"]
        self.assertTrue(typed["ok"])
        self.assertEqual((typed["id"], typed["state"], typed["open"], typed["answered"]), (ASK, "open", ["Z1", "Z2"], []))
        self.assertEqual(typed["checks"], {"linked": True, "unmodified": True, "writer": True})
        self.assertEqual((exchanges[0]["verdict"], exchanges[0]["ask_state"]), ("needs-you", "open"))
        first = typed["cards"][0]
        self.assertEqual(first["gate"], {"task": "g1", "mode": "done", "state": "open", "reason": "Pick the mapping and the closer", "closed": False})
        self.assertEqual(typed["writer"], {"role": "leader", "session": WRITER[:8], "task": "t-1", "captain_driven": False})

    def test_a_typed_ask_the_prose_finder_missed_becomes_a_needs_you_turn(self):
        exchanges = typed_conversation(self.world)
        exchanges[0].update(verdict="no-action", rule="no ask found")
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        self.assertEqual((exchanges[0]["verdict"], exchanges[0]["rule"], exchanges[0]["typed_upgrade"]), ("needs-you", "typed ask record", True))

    def test_a_record_that_fails_a_check_is_prose_only(self):
        for label, chain in (("writer", (CLEARED,)),):
            exchanges = typed_conversation(self.world)
            typed_asks.annotate_exchanges(exchanges, ctx(self.world, chain=chain))
            self.assertNotIn("typed", exchanges[0], label)
        exchanges = typed_conversation(self.world)
        path = self.world.home / "state" / "ask-records" / f"{ASK}.json"
        path.write_text(path.read_text(encoding="utf-8").replace("Which mapping?", "Another?"), encoding="utf-8")
        typed_asks._FILES.clear()
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        self.assertNotIn("typed", exchanges[0])

    def test_a_record_no_home_holds_is_missing_and_never_typed(self):
        exchanges = typed_conversation(self.world)
        entries = typed_asks.annotate_exchanges(exchanges, ctx(self.world, homes=[self.world.mate]))
        self.assertNotIn("typed", exchanges[0])
        self.assertIsNone(entries[0]["loaded"])

    def test_the_record_can_be_in_the_other_home(self):
        exchanges = typed_conversation(self.world)
        shutil.copytree(self.world.home / "state" / "ask-records", self.world.mate / "state" / "ask-records")
        typed_asks.annotate_exchanges(exchanges, ctx(self.world, homes=[self.world.mate, self.world.home]))
        self.assertTrue(exchanges[0]["typed"]["ok"])

    def test_the_record_answering_every_card_settles_the_turn(self):
        events = [{"at": iso(NOW - 5000), "event": "card_answered", "key": "Z1", "value": "a"}, {"at": iso(NOW - 4000), "event": "card_answered", "key": "Z2", "value": "leader"}]
        exchanges = typed_conversation(self.world, events=events)
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        self.assertEqual((exchanges[0]["ask_state"], exchanges[0]["settled_by"]), ("settled", "record"))
        self.assertEqual(exchanges[0]["answered_at"], typed_asks.iso_epoch(iso(NOW - 4000)))
        self.assertEqual(exchanges[0]["typed"]["state"], "answered")

    def test_the_captains_keyed_chat_answer_counts_before_the_record_is_told(self):
        exchanges = typed_conversation(self.world, answers=["Z1=a; Z2=leader"])
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        typed = exchanges[0]["typed"]
        self.assertEqual((exchanges[0]["ask_state"], exchanges[0]["settled_by"]), ("settled", "chat"))
        self.assertEqual((typed["open"], typed["answered"], typed["chat"]), ([], ["Z1", "Z2"], ["Z1", "Z2"]))
        self.assertEqual(typed["cards"][0]["chat"]["value"], "a")
        self.assertEqual(typed["state"], "open")  # the record itself was not told: it says so, and the lag is counted
        self.assertEqual(typed["lag"], ["Z1", "Z2"])  # answered in chat long ago (the clock is far ahead), record still open

    def test_a_chat_answer_that_is_recent_is_not_lag_yet(self):
        exchanges = typed_conversation(self.world, answers=["Z1=a"])
        recent = typed_asks.Context([self.world.home], [WRITER], "leader", exchanges[1]["at"] + 600, typed_asks.Settings(True))
        typed_asks.annotate_exchanges(exchanges, recent)
        typed = exchanges[0]["typed"]
        self.assertEqual((typed["chat"], typed["lag"], typed["open"]), (["Z1"], [], ["Z2"]))
        self.assertEqual(exchanges[0]["ask_state"], "open")

    def test_a_placeholder_or_empty_chat_value_answers_nothing(self):
        exchanges = typed_conversation(self.world, answers=["Z1=...; Z2="])
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        self.assertEqual(exchanges[0]["typed"]["open"], ["Z1", "Z2"])

    def test_a_later_ask_that_reuses_a_key_takes_the_key_from_then_on(self):
        sha2 = self.world.record(self.world.home, ASK2, [card("Z1", "Same letter, new round?", gate=gate("g1"))], created="2027-01-11T02:00:00Z")
        second = turn(30, "ok", f"Next.\n\nask: {ASK2}", [("bin/fm-captain-ask.sh open --title T2", line_of(ASK2, sha2, cards="Z1", gates=1))])
        exchanges = typed_conversation(self.world, extra_turns=[second], answers=[])
        exchanges += exchanges_of(turn(60, "Z1=b", "Noted."))
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        first, later = exchanges[0]["typed"], next(e for e in exchanges if e.get("typed", {}).get("id") == ASK2)["typed"]
        self.assertEqual(first["chat"], [])  # the late answer belongs to the new round
        self.assertEqual(later["chat"], ["Z1"])
        self.assertEqual(first["open"], ["Z1", "Z2"])

    def test_a_card_whose_gate_was_closed_elsewhere_is_no_longer_asked(self):
        exchanges = typed_conversation(self.world)
        self.world.backlog(self.world.home, [("g1", "done", "Pick the mapping and the closer", "2027-01-10T01:00:00Z", 1)])
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        typed = exchanges[0]["typed"]
        self.assertEqual((typed["state"], typed["open"]), ("closed-elsewhere", []))
        self.assertEqual({c["key"]: c["state"] for c in typed["closed"] and [{"key": x["key"], "state": x["state"]} for x in typed["closed"]]}, {"Z1": "closed-elsewhere", "Z2": "closed-elsewhere"})
        self.assertEqual(exchanges[0]["ask_state"], "quiet")
        self.assertEqual(exchanges[0]["quiet_by"], "closed-elsewhere")

    def test_a_task_held_again_since_makes_its_cards_stale(self):
        exchanges = typed_conversation(self.world)
        self.world.backlog(self.world.home, [("g1", "held", "A different call now", "2027-01-13T00:00:00Z", 1)])
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        self.assertEqual(exchanges[0]["typed"]["state"], "stale")
        self.assertEqual(exchanges[0]["typed"]["cards"][0]["gate"]["state"], "stale")
        self.assertEqual(exchanges[0]["typed"]["cards"][0]["gate"]["reason"], "A different call now")

    def test_prose_only_asks_stay_counted_unless_the_homes_flag_is_on(self):
        prose = turn(40, "Next?", "Which one do you want, the old filter or the new one?")
        exchanges = typed_conversation(self.world, extra_turns=[prose])
        builder.mark_asks(exchanges)
        prose_exchange = exchanges[-1]
        self.assertEqual((prose_exchange["verdict"], prose_exchange["ask_state"]), ("needs-you", "open"))
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        self.assertEqual(prose_exchange["ask_state"], "open")  # counted: the typed ask beside it does not replace it
        typed_asks.annotate_exchanges(exchanges, ctx(self.world, off=["other-home"]))
        self.assertEqual(prose_exchange["ask_state"], "open")
        typed_asks.annotate_exchanges(exchanges, ctx(self.world, off=["leader"]))
        self.assertEqual((prose_exchange["ask_state"], prose_exchange["quiet_by"]), ("quiet", "typed-only home"))
        self.assertEqual(exchanges[0]["ask_state"], "open")  # the typed ask still counts

    def test_the_homes_flag_does_nothing_while_typed_rendering_is_off(self):
        prose = turn(40, "Next?", "Which one do you want, the old filter or the new one?")
        exchanges = typed_conversation(self.world, extra_turns=[prose])
        builder.mark_asks(exchanges)
        typed_asks.annotate_exchanges(exchanges, ctx(self.world, off=["leader"], render=False))
        self.assertEqual(exchanges[-1]["ask_state"], "open")

    def test_a_typed_record_replaces_its_own_prose_ask_in_the_count(self):
        exchanges = typed_conversation(self.world)
        exchanges[0].update(verdict="needs-you", ask_state="open")
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        self.assertEqual(sum(1 for e in exchanges if e.get("verdict") == "needs-you" and e.get("ask_state") == "open"), 1)


def wake_turn(n, ack, reply="Waiting on the build.", extra=""):
    tools = [("bin/fm-wake-drain.sh --ack-through 5 --recovery-generation 2", (extra + ack) if ack else extra)] if (ack or extra) else []
    return turn(n, "", reply, tools, wake=True)


class WakeMarkerTest(unittest.TestCase):
    def setUp(self):
        self.world = World(self)
        typed_asks._FILES.clear()

    def run_fold(self, *turns, off=False):
        exchanges = exchanges_of(*turns)
        builder.mark_asks(exchanges)
        typed_asks.annotate_exchanges(exchanges, ctx(self.world, render=not off))
        return exchanges

    def test_nothing_new_folds_a_wake_turn_even_when_the_finder_saw_an_ask_in_it(self):
        exchanges = self.run_fold(turn(0, "go", "Started."), wake_turn(10, "WAKE_ACK: nothing-new through=5\n", "Still waiting: do you want me to merge?"),
                                  wake_turn(20, "WAKE_ACK: nothing-new through=6\n"), wake_turn(30, "WAKE_ACK: nothing-new through=7\n"))
        wake = exchanges[1]
        self.assertEqual(wake["verdict"], "needs-you")  # the finder's reading is kept
        self.assertTrue(wake["folded"])
        self.assertEqual((wake["ask_state"], wake["quiet_by"]), ("quiet", "wake-repeat"))  # a restated wait does not count again
        self.assertTrue(exchanges[2]["folded"])

    def test_news_keeps_a_wake_turn_open(self):
        exchanges = self.run_fold(turn(0, "go", "Started."), wake_turn(10, "WAKE_ACK: news through=5\n"), turn(30, "hm", "Back."))
        self.assertFalse(exchanges[1]["folded"])

    def test_a_wake_turn_with_no_marker_keeps_the_rule_it_had(self):
        legacy = self.run_fold(turn(0, "go", "Started."), wake_turn(10, "", "Done with that."), wake_turn(20, "", "Do you want me to merge it now?"), turn(30, "hm", "Back."))
        self.assertTrue(legacy[1]["folded"])  # not an ask: folded before the marker existed
        self.assertFalse(legacy[2]["folded"])  # an ask: open, as ever
        silent = self.run_fold(turn(0, "go", "Started."), wake_turn(10, "", "Done with that.", extra="some other output\n"), turn(30, "hm", "Back."))
        self.assertTrue(silent[1]["folded"])

    def test_a_marker_never_folds_a_turn_that_opened_an_ask_or_failed(self):
        sha = self.world.record(self.world.home, ASK, [card("Z1", "One?")])
        opened = f"{line_of(ASK, sha, cards='Z1', gates=0)}\nWAKE_ACK: nothing-new through=5\n"
        exchanges = self.run_fold(turn(0, "go", "Started."), wake_turn(10, opened, f"One call.\n\nask: {ASK}"), turn(30, "hm", "Back."))
        self.assertFalse(exchanges[1]["folded"])
        failed = self.run_fold(turn(0, "go", "Started."), wake_turn(10, "WAKE_ACK: nothing-new through=5\n", "API Error: 529 overloaded"), turn(30, "hm", "Back."))
        self.assertFalse(failed[1]["folded"])

    def test_the_turns_the_parser_kept_open_stay_open(self):
        exchanges = self.run_fold(turn(0, "go", "Started."), wake_turn(10, "WAKE_ACK: nothing-new through=5\n"))
        self.assertFalse(exchanges[-1]["folded"])  # the newest turn is where the session stands

    def test_with_the_flag_off_the_marker_changes_nothing(self):
        exchanges = self.run_fold(turn(0, "go", "Started."), wake_turn(10, "WAKE_ACK: news through=5\n", "Done with that."), turn(30, "hm", "Back."), off=True)
        self.assertTrue(exchanges[1]["folded"])


class SheetTest(unittest.TestCase):
    def setUp(self):
        self.world = World(self)
        typed_asks._FILES.clear()
        typed_asks._BACKLOGS.clear()

    def annotated(self, **kw):
        exchanges = typed_conversation(self.world, **kw)
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        return exchanges

    def test_the_record_becomes_a_questionnaire_in_the_existing_card_shape(self):
        exchange = self.annotated()[0]
        prose = sheets.parse_questionnaire(exchange["reply"])
        found = sheets.reply_questionnaire(exchange)
        self.assertEqual(set(found) - {"typed"}, {"title", "intro", "cards", "resolved", "locked", "corrections", "left_out", "reply_line"})
        self.assertEqual([c["key"] for c in found["cards"]], ["Z1", "Z2"])
        first = found["cards"][0]
        self.assertEqual({k: first[k] for k in ("key", "question", "depends", "recommended", "options")},
                         {"key": "Z1", "question": "Which mapping?", "depends": "", "recommended": "a (one)",
                          "options": [{"value": "a", "note": "one", "recommended": True}, {"value": "b", "note": "two", "recommended": False}]})
        self.assertEqual(found["reply_line"], "Reply with keyed answers: Z1=...; Z2=...")
        self.assertEqual(found["title"], prose["title"])  # the reply's own words lend the title and the text above the cards
        self.assertEqual(found["typed"]["id"], ASK)
        self.assertEqual(found["cards"][0]["typed"]["gate"]["reason"], "Pick the mapping and the closer")

    def test_without_a_typed_annotation_the_questionnaire_is_the_prose_one(self):
        exchange = typed_conversation(self.world)[0]
        self.assertEqual(sheets.reply_questionnaire(exchange), sheets.parse_questionnaire(exchange["reply"]))
        self.assertIsNone(sheets.reply_questionnaire({"reply": "Plain words."}))
        self.assertIsNone(sheets.reply_questionnaire({"reply": ""}))

    def test_a_typed_ask_the_prose_cannot_read_still_gets_a_sheet_with_the_records_title(self):
        exchanges = typed_conversation(self.world)
        exchanges[0]["reply"] = f"Please look at the three choices I put in the doc.\n\nask: {ASK}"
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        found = sheets.reply_questionnaire(exchanges[0])
        self.assertEqual([c["key"] for c in found["cards"]], ["Z1", "Z2"])
        self.assertTrue(found["intro"])

    def test_the_sheets_cards_are_the_records_not_the_prose_even_when_they_disagree(self):
        exchanges = typed_conversation(self.world)
        exchanges[0]["reply"] = "| ID | Decision | Recommended |\n| --- | --- | --- |\n| Q9 | A prose-only card | `x` |\n\nReply with keyed answers: `Q9=...`"
        typed_asks.annotate_exchanges(exchanges, ctx(self.world))
        self.assertEqual([c["key"] for c in sheets.reply_questionnaire(exchanges[0])["cards"]], ["Z1", "Z2"])

    def test_cards_no_longer_asked_are_left_off_the_sheet_and_listed_as_closed(self):
        exchanges = self.annotated(cards=[card("Z1", "One?", [("a", "", True)], gate=gate("g1")), card("Z2", "Two?", gate=gate("g1"))],
                                   events=[{"at": ts(5), "event": "withdrawn", "reason": "x"}])
        found = sheets.reply_questionnaire(exchanges[0])
        self.assertEqual(found["cards"], [])
        self.assertEqual(found["typed"]["closed"], [{"key": "Z1", "state": "withdrawn"}, {"key": "Z2", "state": "withdrawn"}])

    def test_sent_is_what_the_record_and_the_chat_hold(self):
        exchanges = self.annotated(events=[{"at": ts(5), "event": "card_answered", "key": "Z1", "value": "a"}], answers=["Z2=hook"])
        summary = exchanges[0]["typed"]
        self.assertEqual(typed_asks.sent_of(summary), {"Z1": "a", "Z2": "hook"})
        questionnaire = sheets.typed_questionnaire(None, exchanges[0], "head", {})
        self.assertEqual(questionnaire["sent"], {"Z1": "a", "Z2": "hook"})
        self.assertEqual(sheets.open_cards(questionnaire), [])
        self.assertEqual(sheets.list_entry(questionnaire)["open"], 0)

    def test_overlay_replaces_the_prose_questionnaire_of_the_same_reply_and_adds_the_typed_only_ones(self):
        exchanges = self.annotated()
        at = exchanges[0]["reply_at"]
        prose = {**sheets.parse_questionnaire(exchanges[0]["reply"]), "session": "head", "at": at, "reply": exchanges[0]["reply"], "sent": {}, "sent_at": None}
        other = {**prose, "at": at - 100, "title": "an earlier one"}
        merged = sheets.overlay_typed([other, prose], exchanges, "head")
        self.assertEqual([q["at"] for q in merged], [at - 100, at])
        self.assertEqual(merged[0], other)  # untouched, and not changed in place
        self.assertEqual(merged[1]["typed"]["id"], ASK)
        self.assertNotIn("typed", prose)
        alone = sheets.overlay_typed([], exchanges, "head")
        self.assertEqual([(q["session"], q["at"]) for q in alone], [("head", at)])
        self.assertEqual(sheets.overlay_typed([prose], [], "head"), [prose])

    def test_the_ask_box_lists_the_open_cards_and_counts_them(self):
        exchanges = self.annotated(events=[{"at": ts(5), "event": "card_answered", "key": "Z1", "value": "a"}])
        session = {"id": "11111111-2222", "exchanges": exchanges}
        builder.mark_sheets([session])
        self.assertEqual([c["key"] for c in exchanges[0]["sheet_cards"]], ["Z2"])
        self.assertEqual(exchanges[0]["sheet_count"], 1)
        self.assertTrue(exchanges[0]["sheet"].startswith("11111111:"))

    def test_a_conversation_summary_counts_a_typed_ask_and_lists_its_open_cards(self):
        exchanges = self.annotated()
        session = {"home": "leader", "id": "11111111-2222", "ids": ["11111111-2222"], "file": "/x.jsonl", "where": "", "exchanges": exchanges}
        builder.mark_sheets([session])
        entry, glance = builder.conversation_summary(session)
        self.assertEqual(entry["needs"], 1)
        self.assertEqual(glance["open_asks"], 1)
        self.assertEqual(glance["ask"]["lines"], ["Which mapping?", "Who closes it?"])
        self.assertEqual(glance["ask"]["tags"], ["Answer sheet · 2 questions"])

    def test_session_sheet_takes_the_typed_sheets_from_the_build_when_the_flag_is_on(self):
        exchanges = typed_conversation(self.world)
        session = {"exchanges": exchanges}
        log = self.world.root / "head.jsonl"
        log.write_text("", encoding="utf-8")
        with mock.patch.dict(os.environ, {"PMOS_READER_TYPED_ASKS": "1"}):
            typed_asks.annotate_exchanges(exchanges, ctx(self.world))
            with mock.patch.object(sheets, "chain_questionnaires", return_value=[]):
                sheet = builder.session_sheet([log], None, session)
        self.assertEqual(len(sheet.list), 1)
        self.assertEqual(sheet.list[0]["open"], 2)
        self.assertIn(b'"typed"', sheet.piece)
        with mock.patch.dict(os.environ, {"PMOS_READER_TYPED_ASKS": "0"}):
            with mock.patch.object(sheets, "chain_questionnaires", return_value=[]):
                self.assertIsNone(builder.session_sheet([log], None, session))


class ThreadTest(unittest.TestCase):
    """thread_session on a real log file, with the flag on and off: the build's own path."""

    def setUp(self):
        self.world = World(self)
        typed_asks._FILES.clear()
        typed_asks._BACKLOGS.clear()

    def build(self, flag):
        sha = self.world.record(self.world.home, ASK, [card("Z1", "Which mapping?", [("a", "", True)], gate=gate("g1"))], writer=WRITER)
        self.world.backlog(self.world.home, [("g1", "held", "Pick it", "2027-01-10T01:00:00Z", 0)])
        records = turn(0, "Please ask me", REPLY, [("bin/fm-captain-ask.sh open --title T", line_of(ASK, sha, cards="Z1", gates=1))])
        log = self.world.root / f"{WRITER}.jsonl"
        log.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        loaded = {log: builder.parsed_log(log, None)}
        with mock.patch.dict(os.environ, {"PMOS_READER_TYPED_ASKS": flag}):
            return builder.thread_session({"id": "leader", "home": self.world.home}, [log], loaded, None)

    def test_the_typed_lines_never_reach_the_page_and_the_flag_decides_the_typed_part(self):
        for flag in ("0", "1"):
            session = self.build(flag)
            self.assertFalse(any("typed_lines" in e for e in session["exchanges"]), flag)
        off = self.build("0")["exchanges"][0]
        on = self.build("1")["exchanges"][0]
        self.assertNotIn("typed", off)
        self.assertEqual(on["typed"]["id"], ASK)
        self.assertEqual((on["verdict"], on["ask_state"]), ("needs-you", "open"))


class CacheTest(unittest.TestCase):
    """build_cache keeps a conversation while every file its build looked at is as it was: the typed records, their events and the backlog are
    looked at inside the build, so a change to any of them builds the conversation again (never a stale ask)."""

    def setUp(self):
        self.world = World(self)
        typed_asks._FILES.clear()
        typed_asks._BACKLOGS.clear()
        sys.path.insert(0, str(HERE / "prototype"))
        import build_cache
        self.cache_module = build_cache

    def derive(self):
        sha = self.world.record(self.world.home, ASK, [card("Z1", "Which mapping?", [("a", "", True)], gate=gate("g1"))], writer=WRITER)
        self.world.backlog(self.world.home, [("g1", "held", "Pick it", "2027-01-10T01:00:00Z", 0)])
        records = turn(0, "Please ask me", REPLY, [("bin/fm-captain-ask.sh open --title T", line_of(ASK, sha, cards="Z1", gates=1))])
        log = self.world.root / f"{WRITER}.jsonl"
        log.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        cache = self.world.root / "parsed"
        cache.mkdir(exist_ok=True)
        with mock.patch.dict(os.environ, {"PMOS_READER_TYPED_ASKS": "1"}):
            thread, _ = self.cache_module.derive({"id": "leader", "home": self.world.home}, [log], None, cache, ("key",))
        return thread

    def test_a_kept_conversation_is_built_again_when_its_record_its_events_or_its_backlog_change(self):
        thread = self.derive()
        self.assertTrue(thread.reads.hold({}))
        self.assertIn(b'"typed"', thread.turns)
        self.assertIn(b'"Pick it"', thread.turns)
        for what in ("events", "backlog", "record"):
            thread = self.derive()
            self.assertTrue(thread.reads.hold({}), what)
            if what == "events":
                self.world.event(self.world.home, ASK, at=ts(9), event="card_answered", key="Z1", value="a")
            elif what == "backlog":
                self.world.backlog(self.world.home, [("g1", "done", "Pick it", "2027-01-10T01:00:00Z", 1)])
            else:
                path = self.world.home / "state" / "ask-records" / f"{ASK}.json"
                path.write_text(path.read_text(encoding="utf-8").replace("Which mapping?", "Which mapping??"), encoding="utf-8")
            self.assertFalse(thread.reads.hold({}), what)

    def test_with_the_flag_off_the_conversation_does_not_look_at_the_records_at_all(self):
        sha = self.world.record(self.world.home, ASK, [card("Z1", "Which mapping?", gate=gate("g1"))], writer=WRITER)
        records = turn(0, "Please ask me", REPLY, [("bin/fm-captain-ask.sh open --title T", line_of(ASK, sha, cards="Z1", gates=1))])
        log = self.world.root / f"{WRITER}.jsonl"
        log.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        cache = self.world.root / "parsed"
        cache.mkdir()
        thread, _ = self.cache_module.derive({"id": "leader", "home": self.world.home}, [log], None, cache, ("key",))
        looked = [path for kind in thread.reads.seen.values() for path in kind]
        self.assertFalse([path for path in looked if "ask-records" in path or path.endswith("backlog.md")], looked)
        self.assertNotIn(b'"typed"', thread.turns)


class HostedTest(unittest.TestCase):
    """The hosted copy and the offline phone copy build their conversations with typed=False: no record, no hold reason, no typed count."""

    def test_a_build_for_the_hosted_copy_has_no_typed_ask_whatever_the_flag_says(self):
        world = World(self)
        typed_asks._FILES.clear()
        typed_asks._BACKLOGS.clear()
        sha = world.record(world.home, ASK, [card("Z1", "Which mapping?", gate=gate("g1"))], writer=WRITER)
        world.backlog(world.home, [("g1", "held", "A private hold reason", "2027-01-10T01:00:00Z", 0)])
        records = turn(0, "Please ask me", REPLY, [("bin/fm-captain-ask.sh open --title T", line_of(ASK, sha, cards="Z1", gates=1))])
        log = world.root / f"{WRITER}.jsonl"
        log.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        loaded = {log: builder.parsed_log(log, None)}
        with mock.patch.dict(os.environ, {"PMOS_READER_TYPED_ASKS": "1"}):
            session = builder.thread_session({"id": "leader", "home": world.home}, [log], loaded, None, typed=False)
            builder.mark_sheets([session])
        text = json.dumps(session)
        self.assertNotIn("A private hold reason", text)
        self.assertNotIn('"typed"', text)
        self.assertNotIn("typed_lines", text)
        self.assertEqual(session["exchanges"][0]["sheet_count"], 2)  # the prose sheet it always had


class RealWriterTest(unittest.TestCase):
    """The records the reader loads are the ones bin/fm-captain-ask.sh writes: run the real script in a scratch home (skipped when Firstmate, jq or
    tasks-axi is not on this machine, or when the script refuses)."""

    FIRSTMATE = Path(os.environ.get("PMOS_READER_FIRSTMATE") or Path.home() / "workspace" / "firstmate")

    def setUp(self):
        script = self.FIRSTMATE / "bin" / "fm-captain-ask.sh"
        if not script.is_file() or not all(shutil.which(tool) for tool in ("jq", "tasks-axi")):
            self.skipTest("Firstmate's bin/fm-captain-ask.sh, jq or tasks-axi is not on this machine")
        self.script, self.hold = script, self.FIRSTMATE / "bin" / "fm-captain-hold.sh"
        self.home = Path(tempfile.mkdtemp(prefix="real-writer-"))
        self.addCleanup(shutil.rmtree, self.home, True)
        for name in ("data", "state", "config", "projects"):
            (self.home / name).mkdir()
        (self.home / ".tasks.toml").write_text('backend = "markdown"\n\n[markdown]\npath = "data/backlog.md"\narchive = "data/done-archive.md"\ndone_keep = 10\n', encoding="utf-8")
        (self.home / "data" / "backlog.md").write_text("## In flight\n\n## Queued\n\n## Done\n", encoding="utf-8")
        self.env = {key: value for key, value in os.environ.items() if key not in ("FM_TASK_ID", "FM_TASK_INBOX", "FM_HOME", "FM_STATE_OVERRIDE", "FM_DATA_OVERRIDE", "FM_CONFIG_OVERRIDE", "FM_ROOT_OVERRIDE")}
        self.env.update(FM_HOME=str(self.home), FM_STATE_OVERRIDE=str(self.home / "state"), FM_DATA_OVERRIDE=str(self.home / "data"),
                        FM_CONFIG_OVERRIDE=str(self.home / "config"), CLAUDE_CODE_SESSION_ID=WRITER, FM_CAPTAIN_ASK_NOW="2027-01-10T02:00:00Z")

    def run_script(self, script, args, stdin=""):
        done = subprocess.run([str(script), *args], input=stdin, capture_output=True, text=True, env=self.env, timeout=120)
        return done

    def test_open_answered_and_the_derived_state_match_what_the_script_wrote(self):
        held = self.run_script(self.hold, ["hold", "gate-a", "--title", "Gate a", "--reason", "the captain must decide gate-a", "--repo", "sample"])
        if held.returncode != 0:
            self.skipTest(f"fm-captain-hold.sh refused in the scratch home: {held.stderr.strip()[:200]}")
        cards = "Z1 | Which mapping? | record-owns-cards* -- one task per gate | one-task-per-card\nZ2 | Who closes it? | leader-call* | hook\n"
        opened = self.run_script(self.script, ["open", "--title", "Sample ask", "--gate", "Z1=gate-a", "--gate", "Z2=gate-a"], cards)
        if opened.returncode != 0:
            self.skipTest(f"fm-captain-ask.sh refused in the scratch home: {opened.stderr.strip()[:200]}")
        last = opened.stdout.strip().splitlines()[-1]
        found = typed_lines.scan_outputs([opened.stdout], [], "")
        self.assertEqual(len(found["records"]), 1, last)
        ask_id, printed = found["records"][0]["id"], found["records"][0]
        typed_asks._FILES.clear()
        loaded = typed_asks.load_record(self.home, ask_id)
        self.assertEqual(loaded["sha"], printed["sha"])
        self.assertTrue(loaded["supported"])
        self.assertEqual(typed_asks.check_record(loaded, printed, [WRITER]), {"linked": True, "unmodified": True, "writer": True})
        facts = typed_asks.gate_facts(self.home, ["gate-a"])
        self.assertTrue(facts["gate-a"]["open"])
        self.assertEqual(facts["gate-a"]["reason"], "the captain must decide gate-a")
        view = typed_asks.derive(loaded, typed_asks.revised_pairs(self.home), facts, NOW - 86400 * 400 + 86400 * 399)
        self.assertEqual((view["state"], [c["state"] for c in view["cards"]]), ("open", ["open", "open"]), "the gate identity the script stored must read back as open")
        answered = self.run_script(self.script, ["answered"], "Z1=record-owns-cards; Z2=leader-call\n")
        self.assertEqual(answered.returncode, 0, answered.stderr)
        again = typed_lines.scan_outputs([answered.stdout], [], "")
        self.assertEqual(again["answered"][0]["state"], "answered")
        typed_asks._FILES.clear()
        typed_asks._BACKLOGS.clear()
        loaded = typed_asks.load_record(self.home, ask_id)
        self.assertEqual(typed_asks.check_record(loaded, printed, [WRITER])["unmodified"], True)
        view = typed_asks.derive(loaded, set(), typed_asks.gate_facts(self.home, ["gate-a"]), NOW)
        self.assertEqual((view["state"], view["answered"]), ("answered", ["Z1", "Z2"]))
        self.assertTrue(view["cards"][0]["gate_closed"])
        self.assertEqual(view["replies"], ["Z1=record-owns-cards; Z2=leader-call"])
        self.assertFalse(typed_asks.gate_facts(self.home, ["gate-a"])["gate-a"]["open"])


if __name__ == "__main__":
    unittest.main()
