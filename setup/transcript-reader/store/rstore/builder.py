"""The reader's own turn rules, borrowed rather than copied.

The store derives its `turns` with the same functions today's builder uses (build_prototype.session_exchanges and its Codex and
Copilot siblings), so a mismatch the parity job finds is a bug in the ingest, never a difference of opinion about what a turn is.
build_prototype is only imported: nothing in it is changed and nothing it writes is touched.

Two things the builder does not give, and this module adds without editing it:
  * where each exchange started: the builder returns exchanges, not the records that began them. `derive` runs the builder over a
    generator that notes which record it is handing over, and a wrapper of `new_exchange` stamps each exchange with that index.
    The ingest needs it to re-derive only the tail of a log that grew (the window starts at the last exchange's first record).
  * a Pi adapter: the builder has no Pi parser. `pi_session_exchanges` builds the same exchange shape with the builder's own
    classification, so a Pi turn is a turn like any other.
"""

from __future__ import annotations

import contextlib
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROTOTYPE = HERE.parent.parent / "prototype"
if str(PROTOTYPE) not in sys.path:
    sys.path.insert(0, str(PROTOTYPE))

import build_prototype as bp  # noqa: E402  (the reader's builder: imported, not changed)
import tool_steps  # noqa: E402

RULES = bp.PARSE_RULES  # a hash of the builder and tool_steps sources: what a turn is, as of this checkout
SESSION_ID_RE = bp.SESSION_ID_RE

_LOCK = threading.Lock()
_STATE = {"i": -1}


def pi_session_exchanges(records) -> list[dict]:
    """A Pi session (~/.pi/agent/sessions/<folder>/<time>_<id>.jsonl) as the reader's exchanges.

    Pi writes a `session` header and `message` records: a user message starts an exchange, an assistant message's text blocks are
    its reply and working notes, a `toolCall` block is a tool step (counted; the tool result record is not read). Thinking blocks,
    model and thinking-level changes, and anything unknown are left out and counted by the caller as ignored or unknown.
    """
    exchanges: list[dict] = []
    current = None
    for record in records:
        if record.get("type") != "message":
            continue
        message = record.get("message") if isinstance(record.get("message"), dict) else {}
        role = message.get("role")
        timestamp = record.get("timestamp")
        content = message.get("content")
        if role == "user":
            text = bp.block_text(content)
            if not text.strip():
                continue
            source, sub, label = bp.classify_input(text, None, False)
            current = bp.new_exchange(source, sub, label, bp.clean_input(text), timestamp,
                                      uid=bp.turn_id({"uuid": record.get("id")}, text))
            current["signal_task"] = bp.signal_task(text) if source == "wake" else None
            exchanges.append(current)
        elif role == "assistant" and current is not None and isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and (block.get("text") or "").strip():
                    current["events"].append(("text", block["text"], bp.iso_to_epoch(timestamp)))
                    current["texts"] += 1
                elif block.get("type") in ("toolCall", "tool_use"):
                    current["events"].append(("tool", block.get("name") or "tool", None))
                    current["tools"] += 1
    for exchange in exchanges:
        bp.finish_exchange(exchange)
    for i, exchange in enumerate(exchanges):
        later = exchanges[i + 1:]
        run = next((n for n, item in enumerate(later) if not item["absorbed"]), len(later))
        exchange["answered_below"] = not exchange["reply"] and any(item["reply"] for item in later[:run])
    if exchanges and exchanges[-1]["folded"] and not exchanges[-1]["reply"]:
        exchanges[-1]["folded"] = False
    latest = next((item for item in reversed(exchanges) if item["reply"]), None)
    if latest:
        latest["folded"] = False
    return exchanges


PARSERS = {
    "claude": bp.session_exchanges,
    "codex": bp.codex_session_exchanges,
    "copilot": bp.copilot_session_exchanges,
    "pi": pi_session_exchanges,
}


def divider(exchange: dict) -> bool:
    """A compaction divider (Copilot's session.compaction_complete): an exchange that has no turn of its own to re-derive from."""
    return exchange.get("source") == "session" and exchange.get("kind") == "compacted" and exchange.get("uid") is None


@contextlib.contextmanager
def _stamping():
    """While active, every exchange the builder makes carries `_rec`: the index of the record the builder was handed when it made it."""
    original = bp.new_exchange

    def stamped(*args, **kwargs):
        exchange = original(*args, **kwargs)
        exchange["_rec"] = _STATE["i"]
        return exchange

    with _LOCK:
        bp.new_exchange = stamped
        try:
            yield
        finally:
            bp.new_exchange = original


def derive(harness: str, records) -> list[dict]:
    """The exchanges of <records> (an iterable of record dicts, in log order) under the reader's rules. Each carries `_rec`, the
    index in <records> of the record that started it (a divider has the record it was made at)."""
    parser = PARSERS[harness]

    def counted():
        for i, record in enumerate(records):
            _STATE["i"] = i
            yield record

    with _stamping():
        return parser(counted())
