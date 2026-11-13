"""How much of what a leader asks arrives as a typed record: the coverage job and its per-home table (S3, the pmos half).

Prose asks stay counted in "needs you" until a home's own gate passes (data/typed-ask-format-scout/report.md, 2.8). This is the measure the
gate reads. It looks at the conversations on the reading list, turn by turn, and for each home counts, over a 14-day window:

  typed          reply turns that carry a record that passed its checks (typed_asks.check_record)
  prose-only     reply turns whose reply makes a keyed answer sheet (the prose finder) and carry no passing record
  coverage       typed / (typed + prose-only)
  agreement      of the turns that have both, the share whose card keys are the same; each other one is a disagreement, to adjudicate
  detector-miss  typed turns the prose finder did not make a sheet of (what the finder misses, measured directly)
  unlinked       records a home holds that no turn on the list names (a record nobody linked, or one written in a conversation not on the list)
  record-lag     records whose cards the captain answered in chat and the record was never told (an hour or more)
  marker         ack calls whose output carried a WAKE_ACK line, over all the ack calls of wake-up turns

The gate (per home) is `eligible` only when, for each of the last 14 days, the 14-day window up to that day held at least MIN_ASKS asks and
coverage of at least COVERAGE_TARGET, with every disagreement adjudicated and no record unlinked. It never turns anything on: the captain
sees this table once and decides (PMOS_READER_TYPED_PROSE_OFF is the switch, in the environment that runs the reader).

  python3 setup/transcript-reader/reader.py typed-coverage                       the per-home table; writes out/typed-ask-coverage.json
  python3 setup/transcript-reader/reader.py typed-coverage --json                the same as JSON
  python3 setup/transcript-reader/reader.py typed-coverage adjudicate <record id> <leader-miss|detector-miss|false-positive>
                                                                                 mark a disagreement, in ~/.config/pmos-transcript-reader/
                                                                                 typed-adjudications.json (or PMOS_READER_TYPED_ADJUDICATIONS)

It reads the session logs, the records and the backlog, and writes only out/typed-ask-coverage.json (and the adjudication file when asked).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import typed_asks  # noqa: E402

WINDOW_DAYS = 14
COVERAGE_TARGET = 0.8
MIN_ASKS = 10
ADJUDICATIONS_ENV = "PMOS_READER_TYPED_ADJUDICATIONS"
VERDICTS = ("leader-miss", "detector-miss", "false-positive")


def adjudications_file() -> Path:
    return Path(os.environ.get(ADJUDICATIONS_ENV) or Path.home() / ".config" / "pmos-transcript-reader" / "typed-adjudications.json")


def read_adjudications(path: Path | None = None) -> dict[str, dict]:
    """The disagreements that were adjudicated: record id -> {verdict, at}. An unreadable or absent file is none."""
    try:
        saved = json.loads((path or adjudications_file()).read_text(encoding="utf-8"))
        return {key: value for key, value in saved["adjudications"].items() if isinstance(value, dict) and value.get("verdict") in VERDICTS}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {}


def adjudicate(ask_id: str, verdict: str, path: Path | None = None, now: float | None = None) -> None:
    if verdict not in VERDICTS:
        raise ValueError(f"the verdict is one of {', '.join(VERDICTS)}")
    if not typed_asks.ID_RE.match(ask_id):
        raise ValueError(f"not a typed-ask id: {ask_id}")
    target = path or adjudications_file()
    saved = read_adjudications(target)
    saved[ask_id] = {"verdict": verdict, "at": round(time.time() if now is None else now)}
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f".{target.name}.{os.getpid()}.partial")
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps({"version": 1, "adjudications": saved}, indent=1, sort_keys=True) + "\n")
    os.replace(partial, target)


# ------------------------------------------------------------------------------------------------------------------------ the turns

def conversation_turns(exchanges: list[dict], ctx: typed_asks.Context, home_id: str, prose_keys) -> tuple[list[dict], set[str], list[dict]]:
    """The reply turns of one conversation that count, as (turns, ids of the records its turns name, the records' entries). <prose_keys> reads a
    reply's keyed cards (build_questionnaire.parse_questionnaire's keys; None when it makes no sheet)."""
    entries = typed_asks.describe(exchanges, ctx)
    by_index = {entry["index"]: entry for entry in entries}
    turns = []
    for index, exchange in enumerate(exchanges):
        if not exchange.get("reply") or exchange.get("source") == "session":
            continue
        entry = by_index.get(index)
        prose = prose_keys(exchange["reply"])
        at = exchange.get("reply_at") or exchange.get("at") or 0
        if entry and entry["ok"] and entry["view"]:
            keys = [c["key"] for c in entry["view"]["cards"]]
            turn = {"home": home_id, "at": at, "uid": exchange.get("uid"), "kind": "typed", "ask": entry["view"]["id"], "keys": keys, "miss": prose is None}
            if prose is not None:
                turn["agree"] = set(prose) == set(keys)
            turns.append(turn)
        elif prose is not None:
            turns.append({"home": home_id, "at": at, "uid": exchange.get("uid"), "kind": "prose-only", "ask": entry["printed"]["id"] if entry else None, "keys": sorted(prose),
                          "failed": bool(entry)})  # a record that failed a check does not make the turn typed
    return turns, {entry["printed"]["id"] for entry in entries}, entries


def marker_counts(exchanges: list[dict]) -> list[dict]:
    """For each wake-up turn that called the drain's acknowledgement: when, how many calls it made, and whether any printed a marker."""
    found = []
    for exchange in exchanges:
        lines = exchange.get("typed_lines") or {}
        if exchange.get("source") == "wake" and lines.get("acks"):
            found.append({"at": exchange.get("reply_at") or exchange.get("at") or 0, "uid": exchange.get("uid"), "acks": lines["acks"], "visible": min(lines["acks"], 1) if lines.get("ack") else 0})
    return found


# ---------------------------------------------------------------------------------------------------------------------- the report

def window(turns: list[dict], end: float, days: int = WINDOW_DAYS) -> list[dict]:
    return [turn for turn in turns if end - days * 86400 < turn["at"] <= end]


def measure(turns: list[dict], adjudicated: dict[str, dict]) -> dict:
    """The numbers of one window of one home's turns."""
    typed = [t for t in turns if t["kind"] == "typed"]
    prose = [t for t in turns if t["kind"] == "prose-only"]
    both = [t for t in typed if "agree" in t]
    disagreements = [t for t in both if not t["agree"]]
    asks = len(typed) + len(prose)
    return {"asks": asks, "typed": len(typed), "prose_only": len(prose), "coverage": round(len(typed) / asks, 4) if asks else None,
            "both": len(both), "agreement": round((len(both) - len(disagreements)) / len(both), 4) if both else None,
            "detector_miss": sum(1 for t in typed if t["miss"]),
            "disagreements": [t["ask"] for t in disagreements],
            "unadjudicated": [t["ask"] for t in disagreements if t["ask"] not in adjudicated]}


def home_report(home_id: str, label: str, turns: list[dict], acks: list[dict], unlinked: list[str], lag: list[str], adjudicated: dict, now: float) -> dict:
    current = measure(window(turns, now), adjudicated)
    daily = [measure(window(turns, now - day * 86400), adjudicated) for day in range(WINDOW_DAYS)]
    passing = sum(1 for d in daily if d["asks"] >= MIN_ASKS and d["coverage"] is not None and d["coverage"] >= COVERAGE_TARGET)
    sampled = sum(1 for d in daily if d["asks"] >= MIN_ASKS)
    recent_acks = [a for a in acks if now - WINDOW_DAYS * 86400 < a["at"] <= now]
    clean = not current["unadjudicated"] and not unlinked
    if sampled < WINDOW_DAYS:
        verdict = "insufficient-data"  # a window below the minimum keeps prose counted
    elif passing == WINDOW_DAYS and clean:
        verdict = "eligible"
    else:
        verdict = "not-yet"
    return {"home": home_id, "label": label, **current, "unlinked": unlinked, "record_lag": lag,
            "marker": {"acks": sum(a["acks"] for a in recent_acks), "visible": sum(a["visible"] for a in recent_acks)},
            "days_passing": passing, "days_sampled": sampled, "verdict": verdict}


def render(reports: list[dict]) -> str:
    def pct(value) -> str:
        return "-" if value is None else f"{round(value * 100)}%"
    rows = [("home", "asks", "typed", "prose-only", "coverage", "agreement", "detector-miss", "unlinked", "record-lag", "marker", "days 80%+", "gate")]
    for r in reports:
        marker = r["marker"]
        rows.append((r["home"], str(r["asks"]), str(r["typed"]), str(r["prose_only"]), pct(r["coverage"]), pct(r["agreement"]), str(r["detector_miss"]),
                     str(len(r["unlinked"])), str(len(r["record_lag"])), f"{marker['visible']}/{marker['acks']}", f"{r['days_passing']}/{WINDOW_DAYS}", r["verdict"]))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    lines = ["  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip() for row in rows]
    lines.append("")
    lines.append(f"Window {WINDOW_DAYS} days. Eligible needs, for each of the last {WINDOW_DAYS} days, at least {MIN_ASKS} asks in the window and coverage of "
                 f"{round(COVERAGE_TARGET * 100)}% or more, every disagreement adjudicated and no record unlinked. It switches nothing on.")
    open_disagreements = [(r["home"], ask) for r in reports for ask in r["unadjudicated"]]
    if open_disagreements:
        lines.append("Disagreements to adjudicate (reader.py typed-coverage adjudicate <id> <leader-miss|detector-miss|false-positive>): "
                     + ", ".join(f"{home}:{ask}" for home, ask in open_disagreements))
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------------------------------------------- IO

def collect(names: list[str], parsed_cache: Path, homes: list[dict], parent_of: dict, now: float, settings: typed_asks.Settings | None = None) -> dict:
    """Read every listed conversation and gather each home's turns, ack calls and record ids. `homes` is builder.fleet_homes' list."""
    import build_prototype as builder  # imported here: the table's pure parts need nothing of the builder
    import build_questionnaire as questionnaires
    settings_ = settings or typed_asks.Settings(True)
    per_home: dict[str, dict] = {h["id"]: {"turns": [], "acks": [], "named": set(), "lag": set(), "path": h["home"]} for h in homes}
    seen: set[Path] = set()
    seen_uids: set[tuple] = set()

    def fresh(kind: str, items: list[dict]) -> list[dict]:
        kept = []
        for item in items:
            mark = (kind, item["uid"])
            if item["uid"] and mark in seen_uids:
                continue
            seen_uids.add(mark)
            kept.append(item)
        return kept

    def prose_keys(reply: str):
        parsed = questionnaires.parse_questionnaire(reply)
        return [card["key"] for card in parsed["cards"]] if parsed else None

    for name in names:
        path = builder.find_session_file(name)
        if not path:
            continue
        chain = builder.session_chain(path)
        if chain[-1] in seen:
            continue
        seen.add(chain[-1])
        loaded = {member: builder.parsed_log(member, parsed_cache) for member in chain}
        exchanges = builder.chain_exchanges(chain, loaded)
        home = builder.session_home(homes, loaded[chain[-1]]["cwd"])
        ids = [builder.log_session_id(member) for member in chain]
        ctx = typed_asks.Context(typed_asks.record_homes(home["home"], parent_of.get(home["id"])), ids, home["id"], now, settings_)
        turns, named, entries = conversation_turns(exchanges, ctx, home["id"], prose_keys)
        bucket = per_home[home["id"]]
        # Chains of the listed sessions overlap (each reaches up to 20 sessions back and on): a turn counts once, by its id.
        bucket["turns"] += fresh("turn", turns)
        bucket["acks"] += fresh("ack", marker_counts(exchanges))
        bucket["named"] |= named
        bucket["lag"] |= {entry["view"]["id"] for entry in entries if entry["lag"] and entry["view"]}
    return per_home


def report(names: list[str], parsed_cache: Path, main_home: Path, now: float | None = None, adjudicated: dict | None = None) -> list[dict]:
    import build_prototype as builder
    now = time.time() if now is None else now
    homes, parent_of = builder.fleet_homes(main_home)
    per_home = collect(names, parsed_cache, homes, parent_of, now)
    adjudicated = read_adjudications() if adjudicated is None else adjudicated
    reports = []
    for home in homes:
        bucket = per_home[home["id"]]
        held = typed_asks.list_record_ids(home["home"])
        unlinked = [ask_id for ask_id in held if ask_id not in bucket["named"]]
        reports.append(home_report(home["id"], home["home"].name if home["id"] != "main" else "main", bucket["turns"], bucket["acks"], unlinked,
                                   sorted(bucket["lag"]), adjudicated, now))
    return reports


def main(args: list[str], names: list[str], out: Path | None = None) -> int:
    import build_prototype as builder
    if args[:1] == ["adjudicate"]:
        if len(args) != 3:
            print("usage: typed-coverage adjudicate <record id> <leader-miss|detector-miss|false-positive>", file=sys.stderr)
            return 2
        try:
            adjudicate(args[1], args[2])
        except ValueError as problem:
            print(f"typed-coverage: {problem}", file=sys.stderr)
            return 2
        print(f"adjudicated {args[1]} as {args[2]}")
        return 0
    as_json = "--json" in args
    folder = out or HERE.parent / "out"
    reports = report(names, folder / "parsed", builder.MAIN_HOME)
    target = folder / "typed-ask-coverage.json"
    folder.mkdir(parents=True, exist_ok=True)
    builder.write_private(target, json.dumps({"generated": time.time(), "window_days": WINDOW_DAYS, "homes": reports}, indent=1, sort_keys=True) + "\n")
    print(json.dumps(reports, indent=1, sort_keys=True) if as_json else render(reports))
    return 0
