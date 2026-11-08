"""Typed ask records, read for the reader (S3, the pmos half of the plan in data/reader-architecture-plan/plan.md).

A leader writes one record per keyed ask with bin/fm-captain-ask.sh (Firstmate's half; its header owns the grammar, the schema `fm-ask.v1`
and the lifecycle, and docs/captain-asks.md the overview). The record sits in the writing home's state/ask-records/, two files per ask:
<id>.json (immutable, a sha-256 prefix of its bytes is printed in-band) and <id>.events (append-only: opened, replied, card_answered,
gate_closed, gate_later, withdrawn). This module reads them. It never writes anything of Firstmate's.

What lives here, with no page code in it (the builders, the pages and the CLI call it):

  loading     find_record, load_record: a record and its events from the homes that can hold it, with the sha of the file as it is
  state       derive: the record's cards and the record itself as the lifecycle derives them (the port of bin/fm-captain-ask.jq: superseded,
              withdrawn, answered, stale, closed-elsewhere, expired, open; open, partial, then the terminal states)
  checks      check_record: linked (the id and sha are in the turn's tool output), unmodified (the file is what was printed) and
              writer-chain (the claimed writer session is one of the conversation's sessions). A record that fails one is shown as prose only.
  gates       read_backlog, gate_view: a card's gate is a held task in its home's backlog; the card shows the backlog's own hold reason and
              is `stale` or `closed-elsewhere` when the task is no longer the call it was asked against
  sheets      sheet_from_summary: the record as a questionnaire, in the dict build_questionnaire.parse_questionnaire makes, so the sheet
              page needs no new card shape; the provenance, the gate and the chat answers ride beside it under `typed`
  annotation  annotate_exchanges: for the turns of one conversation, link, check and attach `typed`; give each linked ask its ask_state;
              merge typed and prose-only asks into "needs you" (settings: the per-home flag that stops counting prose-only asks);
              derive `answered in chat` and the record lag; fold wake-up turns by Firstmate's WAKE_ACK marker

Everything typed the reader shows sits behind a flag that is off by default (PMOS_READER_TYPED_ASKS); with it off the pages, the counts and
the folds are what they were. Prose asks stay counted in "needs you" until a home's own switch-over flag says otherwise
(PMOS_READER_TYPED_PROSE_OFF), which only the coverage table's gate and the captain's word turn on.

Every file this module reads goes through plain open/stat/listdir calls, so build_cache's recording sees them and a conversation whose
record, events or backlog changed is built again. Nothing here is kept between builds without asking the file's stat first.
"""

from __future__ import annotations

import base64
import calendar
import hashlib
import json
import os
import re
import time
from pathlib import Path

import typed_lines

SCHEMA = "fm-ask.v1"
ID_RE = re.compile(rf"^{typed_lines.ID}$")
RENDER_ENV = "PMOS_READER_TYPED_ASKS"
PROSE_OFF_ENV = "PMOS_READER_TYPED_PROSE_OFF"
ON = {"1", "on", "true", "yes"}
KEY = r"[A-Z][0-9]{1,2}"
# The captain's keyed answer, as build_prototype.KEY_ANSWER and Firstmate's fm-captain-ask.jq read it. typed-ask-fixtures/keyed-replies.json holds
# the replies both readers must read alike (test_typed_asks.py and tests/ in the reader's folder run them).
KEY_ANSWER = re.compile(rf"\b({KEY})\s*=\s*([^;\n]*)")
LAG_SECONDS = 3600  # a card answered in chat and still open in its record after this long is the record's lag
HOLD_REASON_CHARS = 240
API_ERROR = re.compile(r"^\s*API Error\b")


# ------------------------------------------------------------------------------------------------------------------------ settings

class Settings:
    """What the reader's environment switches on: `render` (typed sheets, asks, counts and folds; off by default) and `prose_off`, the ids of
    the homes whose prose-only asks no longer count in "needs you" (empty by default, and only used while `render` is on)."""

    __slots__ = ("render", "prose_off")

    def __init__(self, render: bool = False, prose_off: frozenset[str] = frozenset()) -> None:
        self.render, self.prose_off = render, prose_off


def settings(environ: dict | None = None) -> Settings:
    env = os.environ if environ is None else environ
    render = str(env.get(RENDER_ENV, "")).strip().lower() in ON
    off = frozenset(part.strip() for part in str(env.get(PROSE_OFF_ENV, "")).split(",") if part.strip())
    return Settings(render, off)


# --------------------------------------------------------------------------------------------------------------------- small helpers

def iso_epoch(value) -> float | None:
    """A UTC ISO 8601 time as written by Firstmate (YYYY-MM-DDTHH:MM:SSZ), as an epoch; None when it is not one."""
    if not isinstance(value, str):
        return None
    try:
        return float(calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")))
    except ValueError:
        return None


def sha12(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def clip(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


_FILES: dict[str, tuple[tuple, object]] = {}
FILES_KEPT = 4000


def read_bytes(path: Path) -> bytes | None:
    """A file's bytes, or None when it is not there. The file is asked about first, by its stat, so what was read before is used while the
    file is the same (and the stat is what a recording notes as this file's dependency)."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    key = str(path)
    signature = (info.st_mtime_ns, info.st_size, info.st_ino)
    known = _FILES.get(key)
    if known and known[0] == signature:
        return known[1]  # type: ignore[return-value]
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError:
        return None
    if len(_FILES) >= FILES_KEPT:
        _FILES.clear()
    _FILES[key] = (signature, data)
    return data


def read_json(path: Path):
    data = read_bytes(path)
    if data is None:
        return None
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


HOMES_ENV = "PMOS_READER_TYPED_HOMES"


def record_homes(home: Path | None, parent: Path | None = None) -> list[Path]:
    """The homes that can hold a record a conversation's turns name: its own, the home that dispatched it (a secondmate's parent), then any
    that PMOS_READER_TYPED_HOMES adds (colon-separated, for a lab)."""
    extra = [Path(part).expanduser() for part in os.environ.get(HOMES_ENV, "").split(":") if part.strip()]
    return [Path(h) for h in (home, parent, *extra) if h]


# ------------------------------------------------------------------------------------------------------------------------- loading

def records_dir(home: Path) -> Path:
    return Path(home) / "state" / "ask-records"


def load_record(home: Path, ask_id: str) -> dict | None:
    """One record of <home> by id, as the home holds it, or None when the home has none. `record` is the parsed file (None when it is not
    readable JSON), `sha` the first 12 hex of the sha-256 of the file's bytes, `events` its events file's lines that parse."""
    if not ID_RE.match(ask_id or ""):
        return None
    folder = records_dir(home)
    raw = read_bytes(folder / f"{ask_id}.json")
    if raw is None:
        return None
    try:
        record = json.loads(raw.decode("utf-8"))
        if not isinstance(record, dict):
            record = None
    except (UnicodeDecodeError, ValueError):
        record = None
    events = []
    raw_events = read_bytes(folder / f"{ask_id}.events")
    for line in (raw_events or b"").decode("utf-8", "replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and isinstance(event.get("event"), str):
            events.append(event)
    schema = record.get("schema") if record else None
    return {"id": ask_id, "home": Path(home), "sha": sha12(raw), "record": record, "schema": schema, "events": events,
            "supported": schema == SCHEMA and isinstance(record.get("cards") if record else None, list)}


def find_record(homes: list[Path], ask_id: str) -> dict | None:
    """The record <ask_id> from the first of <homes> that holds it."""
    for home in homes:
        found = load_record(home, ask_id)
        if found:
            return found
    return None


def list_record_ids(home: Path) -> list[str]:
    """Every record id the home holds, oldest first (the id starts with its time)."""
    try:
        names = os.listdir(records_dir(home))
    except OSError:
        return []
    return sorted(name[: -len(".json")] for name in names if name.endswith(".json") and ID_RE.match(name[: -len(".json")]))


def revised_pairs(home: Path) -> set[tuple[str, str]]:
    """The (record id, card key) pairs a later record of the home replaces (its `revises`): those cards are superseded."""
    pairs: set[tuple[str, str]] = set()
    for ask_id in list_record_ids(home):
        record = read_json(records_dir(home) / f"{ask_id}.json")
        if isinstance(record, dict) and record.get("schema") == SCHEMA:
            for item in record.get("revises") or []:
                if isinstance(item, dict) and isinstance(item.get("id"), str) and isinstance(item.get("key"), str):
                    pairs.add((item["id"], item["key"]))
    return pairs


# ---------------------------------------------------------------------------------------------------------------------- the backlog

def backlog_path(home: Path) -> tuple[Path | None, bool]:
    """(the home's backlog file, whether it is the markdown one this module can read). A home whose .tasks.toml names another backend has a
    backlog the reader does not read: its gates stay unknown."""
    home = Path(home)
    data = read_bytes(home / ".tasks.toml")
    backend, path = "markdown", "data/backlog.md"
    if data is not None:
        text = data.decode("utf-8", "replace")
        match = re.search(r'(?m)^\s*backend\s*=\s*"([^"]+)"', text)
        if match:
            backend = match.group(1)
        match = re.search(r'(?ms)^\[markdown\][^\[]*?^\s*path\s*=\s*"([^"]+)"', text)
        if match:
            path = match.group(1)
    return home / path, backend == "markdown"


ROW = re.compile(r"^- \[([ xX])\] (\S+) - (.*)$")
HOLD = re.compile(r"\(hold: fm-hold-v1:([A-Za-z0-9+/=_-]*)\)")
HOLD_KIND = re.compile(r"\(hold-kind: ([a-z-]+)\)")
HOLD_SET = re.compile(r"^Captain hold set: (\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?)$")
RESOLUTION = re.compile(r"^Resolution recorded by fm-(?:captain|decision)-hold\.$")
_BACKLOGS: dict[str, tuple[tuple, dict]] = {}


def decode_hold(value: str) -> str:
    try:
        padded = value + "=" * (-len(value) % 4)
        return base64.urlsafe_b64decode(padded.replace("+", "-").replace("/", "_")).decode("utf-8", "replace")
    except (ValueError, TypeError):
        return ""


def parse_backlog(text: str) -> dict[str, dict]:
    """The rows of a markdown backlog, by task id: whether it is done, whether it is held for the captain, the hold's reason, and its lifecycle
    identity as `fm-captain-hold.sh open --identity` prints it (the hold-set stamp and the number of recorded resolutions)."""
    rows: dict[str, dict] = {}
    current: dict | None = None
    section = ""
    for line in text.splitlines():
        if line.startswith("## "):
            section, current = line[3:].strip().lower(), None
            continue
        match = ROW.match(line)
        if match:
            done = match.group(1) in "xX" or section == "done"
            rest = match.group(3)
            hold, kind = HOLD.search(rest), HOLD_KIND.search(rest)
            current = {"done": done, "captain": bool(kind and kind.group(1) == "captain"), "reason": decode_hold(hold.group(1)) if hold else "",
                       "hold_set": "", "resolutions": 0, "_first": True}
            rows[match.group(2)] = current
            continue
        if current is not None and line.startswith("  "):
            body = line.strip()
            if current["_first"] and body:
                stamp = HOLD_SET.match(body)
                if stamp:
                    current["hold_set"] = stamp.group(1)
                current["_first"] = False
            if RESOLUTION.match(body):
                current["resolutions"] += 1
        elif current is not None and line.strip():
            current = None
    for row in rows.values():
        row.pop("_first", None)
    return rows


def read_backlog(home: Path) -> dict | None:
    """The home's backlog rows by task id; {} when the home has no backlog file (it records no captain calls); None when the backlog is not
    one the reader reads, or cannot be read."""
    path, readable = backlog_path(home)
    if not readable:
        return None
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return {}
    except OSError:
        return None
    signature = (info.st_mtime_ns, info.st_size, info.st_ino)
    known = _BACKLOGS.get(str(path))
    if known and known[0] == signature:
        return known[1]
    data = read_bytes(path)
    if data is None:
        return None
    rows = parse_backlog(data.decode("utf-8", "replace"))
    if len(_BACKLOGS) >= 64:
        _BACKLOGS.clear()
    _BACKLOGS[str(path)] = (signature, rows)
    return rows


def gate_facts(home: Path, tasks) -> dict[str, dict]:
    """For each task a card gates: {open, identity, reason}. `open` is True when the task is a captain call still held, False when it is not
    (done, held for nothing, or no longer in the backlog), None when that cannot be told; `identity` is "" when it cannot be established."""
    rows = read_backlog(home)
    facts = {}
    for task in tasks:
        if rows is None:
            facts[task] = {"open": None, "identity": "", "reason": ""}
            continue
        row = rows.get(task)
        if row is None:
            facts[task] = {"open": False, "identity": "", "reason": ""}
            continue
        is_open = bool(row["captain"] and not row["done"])
        identity = f"{row['hold_set']}#{row['resolutions']}" if row["hold_set"] else ""
        facts[task] = {"open": is_open, "identity": identity if is_open else "", "reason": clip(row["reason"], HOLD_REASON_CHARS)}
    return facts


def gate_state(card: dict, fact: dict | None) -> str:
    """How a card's gate stands against the backlog: open (the call it was asked against), stale (held again since, so a different call),
    closed (no longer a captain call), unknown (no way to tell; never changes the card)."""
    gate = card.get("gate")
    if not gate or not fact or fact.get("open") is None:
        return "unknown" if gate else "none"
    if fact["open"] is False:
        return "closed"
    stored, now = (gate.get("identity") or ""), fact.get("identity") or ""
    return "stale" if now and stored and now != stored else "open"


# ------------------------------------------------------------------------------------------------------------------------- state

def derive(loaded: dict, revised: set, facts: dict | None, now: float) -> dict | None:
    """The record as fm-captain-ask.jq derives it. Per card the first that matches: superseded (a record of the home revises it), withdrawn,
    answered, stale (its gate is open again as another call), closed-elsewhere (its gate is no longer a captain call and nothing was
    recorded), expired, open. <facts> is gate_facts, or None when the backlog was not consulted (then stale and closed-elsewhere cannot
    occur). None when the record is not a supported one."""
    if not loaded or not loaded["supported"]:
        return None
    record, events = loaded["record"], loaded["events"]
    withdrawn = any(e.get("event") == "withdrawn" for e in events)
    cards = []
    for card in record["cards"]:
        if not isinstance(card, dict) or not isinstance(card.get("key"), str):
            continue
        answers = [e for e in events if e.get("event") == "card_answered" and e.get("key") == card["key"]]
        gate = card.get("gate") if isinstance(card.get("gate"), dict) else None
        fact = (facts or {}).get(gate["task"]) if gate and isinstance(gate.get("task"), str) else None
        gstate = gate_state({**card, "gate": gate}, fact) if gate else "none"
        expires = iso_epoch(record.get("expires_at"))
        if expires is None and not gate:
            created = iso_epoch(record.get("created_at"))
            expires = created + 14 * 86400 if created is not None else None
        if (loaded["id"], card["key"]) in revised:
            state = "superseded"
        elif withdrawn:
            state = "withdrawn"
        elif answers:
            state = "answered"
        elif gstate == "stale":
            state = "stale"
        elif gstate == "closed":
            state = "closed-elsewhere"
        elif expires is not None and expires < now:
            state = "expired"
        else:
            state = "open"
        closed = bool(gate and any(e.get("event") == "gate_closed" and e.get("task") == gate.get("task") for e in events))
        cards.append({**card, "state": state, "value": answers[-1].get("value") if answers else None,
                      "answered_at": iso_epoch(answers[-1].get("at")) if answers else None, "gate_closed": closed,
                      "gate_state": gstate, "gate_fact": fact})
    open_keys = [c["key"] for c in cards if c["state"] == "open"]
    answered = [c["key"] for c in cards if c["state"] == "answered"]
    if open_keys:
        state = "partial" if answered else "open"
    elif answered:
        state = "answered"
    else:
        seen = {c["state"] for c in cards}
        state = next((s for s in ("superseded", "withdrawn", "stale", "closed-elsewhere", "expired") if s in seen), "open")
    opened = next((e.get("sha") for e in events if e.get("event") == "opened"), None)
    return {"id": loaded["id"], "record": record, "sha": loaded["sha"], "opened_sha": opened if isinstance(opened, str) else None,
            "state": state, "cards": cards, "open": open_keys, "answered": answered,
            "replies": [e.get("text") for e in events if e.get("event") == "replied" and isinstance(e.get("text"), str)],
            "withdrawn_reason": next((e.get("reason") for e in events if e.get("event") == "withdrawn"), None)}


# ------------------------------------------------------------------------------------------------------------------------- checks

def check_record(loaded: dict, printed: dict | None, chain_ids) -> dict:
    """The checks that decide whether a record may stand as a sheet (firstmate's scout report, 2.6):

    linked      the id and sha were printed in a tool result of one of this conversation's turns (`printed`, the ASK_RECORD line)
    unmodified  the file's sha is the one printed and the one its `opened` event holds
    writer      the writer session the record claims is one of the conversation's sessions (a /clear changes the id, so the chain counts)

    A record that fails one of them is shown as prose only, never counted as typed."""
    record = loaded["record"] or {}
    opened = next((e.get("sha") for e in loaded["events"] if e.get("event") == "opened"), None)
    printed_sha = (printed or {}).get("sha") or ""
    linked = bool(printed)
    unmodified = bool(linked and printed_sha and loaded["sha"] == printed_sha and (opened is None or opened == loaded["sha"]))
    writer = (record.get("writer") or {}).get("session_id") if isinstance(record.get("writer"), dict) else None
    chain = set(chain_ids or ())
    return {"linked": linked, "unmodified": unmodified, "writer": bool(writer and writer in chain)}


def checks_ok(checks: dict) -> bool:
    return bool(checks["linked"] and checks["unmodified"] and checks["writer"])


# --------------------------------------------------------------------------------------------------------------- linking one conversation

class Context:
    """What annotating one conversation needs: the homes that can hold its records (the conversation's own first), the ids of its sessions
    (a /clear chain), the id of its home (the per-home switch-over flag is by it), the time, and the settings."""

    __slots__ = ("homes", "chain_ids", "home_id", "now", "settings")

    def __init__(self, homes, chain_ids, home_id: str | None = None, now: float | None = None, settings_: Settings | None = None) -> None:
        self.homes = [Path(h) for h in dict.fromkeys(str(h) for h in homes if h)]
        self.chain_ids = set(chain_ids or ())
        self.home_id = home_id
        self.now = time.time() if now is None else now
        self.settings = settings_ if settings_ is not None else settings()


def keyed_answers(text: str) -> dict[str, str]:
    """The keyed answers in a message of the captain's (`Z1=a; Z2=b`): each key with its value, stripped. A key with no value, or with only the
    format's own placeholder (`Z1=...`), answers nothing; a later answer to the same key wins. This is the reader's reading of what
    Firstmate's bin/fm-captain-ask.jq reads with the same pattern; typed-ask-fixtures/keyed-replies.json holds the replies both must read alike, and
    where they differ on purpose."""
    found: dict[str, str] = {}
    for key, value in KEY_ANSWER.findall(text or ""):
        value = value.strip()
        if value.strip(".…"):
            found[key] = value
    return found


def chat_answers(exchanges: list[dict], index: int, ask_id: str, keys) -> dict[str, dict]:
    """The keyed answers the captain typed in chat to the ask a turn opened: for each of its card keys, the first later message of the captain
    that answers it (`Z1=value`; a key with no value, or a placeholder such as `Z1=...`, answers nothing). A later turn that opens another ask
    with the same key takes the key from then on, so an old answer never settles a new round."""
    waiting = set(keys)
    found: dict[str, dict] = {}
    for later in exchanges[index + 1:]:
        if not waiting:
            break
        if later.get("source") == "captain":
            for key, value in keyed_answers(later.get("input") or "").items():
                if key in waiting and key not in found:
                    found[key] = {"value": value, "at": later.get("at")}
        for record in (later.get("typed_lines") or {}).get("records", []):
            if record.get("id") != ask_id:
                waiting -= set(record.get("cards") or [])
    return found


def describe(exchanges: list[dict], ctx: Context) -> list[dict]:
    """The typed asks of one conversation: for each ASK_RECORD line in its turns (the first of an id), the record found in the homes, its
    state against the backlog, its checks and the captain's answers in chat. Nothing is written and no flag is read here: the coverage job
    uses it as the pages do."""
    entries, seen = [], set()
    revised: dict[str, set] = {}
    for index, exchange in enumerate(exchanges):
        for printed in (exchange.get("typed_lines") or {}).get("records", []):
            if printed["id"] in seen:
                continue
            seen.add(printed["id"])
            loaded = find_record(ctx.homes, printed["id"])
            entry = {"index": index, "printed": printed, "loaded": loaded, "view": None, "checks": None, "ok": False, "chat": {}, "lag": []}
            if loaded:
                home = loaded["home"]
                entry["checks"] = check_record(loaded, printed, ctx.chain_ids)
                entry["ok"] = loaded["supported"] and checks_ok(entry["checks"])
                if loaded["supported"]:
                    if str(home) not in revised:
                        revised[str(home)] = revised_pairs(home)
                    tasks = sorted({c["gate"]["task"] for c in loaded["record"]["cards"]
                                    if isinstance(c, dict) and isinstance(c.get("gate"), dict) and isinstance(c["gate"].get("task"), str)})
                    entry["view"] = derive(loaded, revised[str(home)], gate_facts(home, tasks) if tasks else {}, ctx.now)
                    entry["chat"] = chat_answers(exchanges, index, printed["id"], [c["key"] for c in entry["view"]["cards"] if c["state"] == "open"])
                    entry["lag"] = [c["key"] for c in entry["view"]["cards"]
                                    if c["state"] == "open" and c["key"] in entry["chat"]
                                    and ctx.now - (entry["chat"][c["key"]]["at"] or ctx.now) > LAG_SECONDS]
            entries.append(entry)
    return entries


# ---------------------------------------------------------------------------------------------------------------------- the summary

def card_summary(card: dict, chat: dict | None) -> dict:
    """One card as the pages hold it: the card, its state in the record, what the record or the chat answered, and its gate beside the
    backlog's own hold reason."""
    gate = card.get("gate") if isinstance(card.get("gate"), dict) else None
    fact = card.get("gate_fact") or {}
    out = {
        "key": card["key"], "question": str(card.get("question") or ""),
        "options": [{"value": str(o.get("value", "")), "note": str(o.get("note") or ""), "recommended": bool(o.get("recommended"))}
                    for o in card.get("options") or [] if isinstance(o, dict)],
        "recommended": str(card.get("recommended") or ""), "state": card["state"], "value": card.get("value"),
    }
    if card.get("answered_at"):
        out["answered_at"] = card["answered_at"]
    if chat:
        out["chat"] = {"value": chat["value"], "at": chat.get("at")}
    if gate:
        out["gate"] = {"task": str(gate.get("task") or ""), "mode": str(gate.get("mode") or "done"), "state": card.get("gate_state") or "unknown",
                       "reason": fact.get("reason") or "", "closed": bool(card.get("gate_closed"))}
    return out


def summarize(entry: dict) -> dict:
    """What a conversation's turn holds of its typed ask (exchange["typed"]): who wrote it and the checks, then each card as card_summary,
    and the sets the counts use: `open` (cards still to answer), `answered` (by the record or in chat) and `lag` (answered in chat, the
    record not told after an hour)."""
    view, loaded, chat = entry["view"], entry["loaded"], entry["chat"]
    record = view["record"]
    writer = record.get("writer") if isinstance(record.get("writer"), dict) else {}
    home = record.get("home") if isinstance(record.get("home"), dict) else {}
    cards = [card_summary(card, chat.get(card["key"]) if card["state"] == "open" else None) for card in view["cards"]]
    open_keys = [c["key"] for c in cards if c["state"] == "open" and "chat" not in c]
    answered = [c["key"] for c in cards if c["state"] == "answered" or (c["state"] == "open" and "chat" in c)]
    answered_by_chat = [c["key"] for c in cards if c["state"] == "open" and "chat" in c]
    return {
        "id": view["id"], "state": view["state"], "title": str(record.get("title") or ""), "kind": str(record.get("kind") or "decision"),
        "sha": loaded["sha"], "created_at": iso_epoch(record.get("created_at")), "ok": entry["ok"], "checks": entry["checks"],
        "home": str(home.get("label") or ""), "writer": {"role": str(writer.get("role") or ""), "session": str(writer.get("session_id") or "")[:8],
                                                          "task": str(writer.get("task_id") or ""), "captain_driven": bool(writer.get("captain_driven"))},
        "origin": record.get("origin") if isinstance(record.get("origin"), dict) else None,
        "cards": cards, "open": open_keys, "answered": answered, "chat": answered_by_chat, "lag": entry["lag"],
        "closed": [{"key": c["key"], "state": c["state"]} for c in cards if c["state"] in ("superseded", "withdrawn", "stale", "closed-elsewhere", "expired")],
        "reason": view.get("withdrawn_reason") or "",
    }


def sent_of(summary: dict) -> dict[str, str]:
    """The keyed answers the sheet shows as already sent: the record's, then the chat's for cards the record has not heard of."""
    sent = {}
    for card in summary["cards"]:
        if card["state"] == "answered" and card.get("value") is not None:
            sent[card["key"]] = str(card["value"])
        elif card["state"] == "open" and "chat" in card:
            sent[card["key"]] = str(card["chat"]["value"])
    return sent


# ------------------------------------------------------------------------------------------------------------------------ the sheet

def reply_line(cards: list[dict]) -> str:
    return "Reply with keyed answers: " + "; ".join(f"{c['key']}=..." for c in cards) if cards else ""


def sheet_from_summary(summary: dict, prose: dict | None = None) -> dict:
    """The record as a questionnaire, in the dict build_questionnaire.parse_questionnaire makes (title, intro, cards of key, question, depends,
    recommended and options, resolved, locked, corrections, left_out, reply_line), so the sheet page takes it as it takes any other. The cards
    are the record's, whatever the reply's prose says: the record is what the leader said it asked. The prose parse, when there is one, only
    lends its title and its intro (the reply's own words above the cards). `typed` carries what the record adds: where it came from, its
    checks, and each card's state and gate."""
    cards = []
    for card in summary["cards"]:
        if card["state"] not in ("open", "answered"):
            continue
        recommended = card["recommended"]
        marked = next((o for o in card["options"] if o["recommended"]), None)
        if marked:  # the choice and what its note says: the sheet shows it above the choices
            recommended = f"{marked['value']} ({marked['note']})" if marked["note"] else marked["value"]
        cards.append({"key": card["key"], "question": card["question"], "depends": "", "recommended": recommended, "options": card["options"],
                      "typed": {key: card[key] for key in ("state", "gate", "chat") if key in card}})
    title = (prose or {}).get("title") or summary["title"]
    intro = (prose or {}).get("intro") or summary["title"]
    return {"title": title, "intro": intro, "cards": cards, "resolved": [], "locked": [], "corrections": [], "left_out": [],
            "reply_line": reply_line(cards),
            "typed": {key: summary[key] for key in ("id", "state", "title", "kind", "sha", "created_at", "checks", "home", "writer", "origin",
                                                  "open", "answered", "chat", "lag", "closed", "reason")}}


# ------------------------------------------------------------------------------------------------------------------------- annotation

def annotate_exchanges(exchanges: list[dict], ctx: Context) -> list[dict]:
    """Link, check and attach the typed asks of one conversation's turns, and merge them into the counts the pages make. Does nothing unless
    the reader's flag is on (settings().render). Returns the entries it found (describe).

    On a turn whose reply carries an ask record that passes its checks (typed_asks.check_record):
      exchange["typed"]   the summary (summarize)
      ask_state           open while a card is still to answer (the record, or the chat when the record was not told), settled once every
                          card is answered (settled_by says by the record or in chat), quiet when what is left will not be asked
                          (withdrawn, superseded, expired, stale, closed elsewhere)
      verdict             needs-you, when a card is open and the prose finder missed it
    Every other turn that needs you is a prose-only ask, counted as ever unless this home's switch-over flag says otherwise, in which case it
    is quiet. A wake-up turn that Firstmate's own marker calls "nothing new" folds, one it calls "news" does not; a turn with no marker keeps
    the rule it had."""
    live = ctx.settings.render
    if not live:
        return []
    entries = describe(exchanges, ctx)
    typed_at = set()
    for entry in entries:
        if not (entry["ok"] and entry["view"]):
            continue
        exchange = exchanges[entry["index"]]
        if "typed" in exchange:  # annotated before (a caller may run this twice over the same turns)
            typed_at.add(entry["index"])
            continue
        if not exchange.get("reply"):
            continue
        summary = summarize(entry)
        exchange["typed"] = summary
        typed_at.add(entry["index"])
        if summary["open"]:
            exchange["ask_state"] = "open"
            if exchange.get("verdict") != "needs-you":
                exchange.update(verdict="needs-you", rule="typed ask record", typed_upgrade=True)
        elif summary["answered"]:
            # Answered: a sheet that is answered still reads "Answered" on the reply, so the turn stays a needs-you one that is settled.
            by_chat = set(summary["chat"]) == set(summary["answered"])
            exchange.update(verdict="needs-you", ask_state="settled", settled_by="chat" if by_chat else "record")
            stamps = [c["chat"]["at"] for c in summary["cards"] if "chat" in c and c["chat"].get("at")]
            stamps += [c["answered_at"] for c in view_cards(entry) if c.get("answered_at")]
            if stamps:
                exchange["answered_at"] = max(stamps)
        elif exchange.get("verdict") == "needs-you":
            exchange.update(ask_state="quiet", quiet_by=summary["state"])
    if ctx.home_id and ctx.home_id in ctx.settings.prose_off:
        for index, exchange in enumerate(exchanges):
            if index not in typed_at and exchange.get("verdict") == "needs-you" and exchange.get("ask_state") in ("open", "quiet"):
                exchange.update(ask_state="quiet", quiet_by="typed-only home")
    apply_marker_fold(exchanges)
    return entries


def view_cards(entry: dict) -> list[dict]:
    return (entry.get("view") or {}).get("cards") or []


def apply_marker_fold(exchanges: list[dict]) -> None:
    """Fold wake-up turns by Firstmate's WAKE_ACK marker (bin/fm-wake-drain.sh --ack-through). `nothing-new` folds the turn when it opened or
    answered no ask and did not fail; `news` keeps it open. Its prose ask, if the finder saw one, was made in an earlier turn: this one only
    restates it, so it stops counting (quiet). A turn that made no ack call, or whose ack printed no marker (an older Firstmate, a drain that
    could not say), keeps the rule it had. The turns the parser kept open on purpose (the newest, the answer to your own message) stay open."""
    for exchange in exchanges:
        lines = exchange.get("typed_lines") or {}
        ack = lines.get("ack")
        if exchange.get("source") != "wake" or not ack or lines.get("keep_open"):
            continue
        folds = (ack["verdict"] == "nothing-new" and not lines.get("records") and not lines.get("answered")
                 and not API_ERROR.match(exchange.get("reply") or ""))
        exchange["folded"] = folds
        if folds and exchange.get("verdict") == "needs-you" and exchange.get("ask_state") == "open" and "typed" not in exchange:
            exchange.update(ask_state="quiet", quiet_by="wake-repeat")
