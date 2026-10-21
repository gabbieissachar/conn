#!/usr/bin/env python3
"""Build the phase 1 transcript-reader prototype page.

Throwaway prototype for the design checkpoint in ../DESIGN.md. It only reads:
Claude Code session logs under ~/.claude/projects, the Firstmate fleet
records under each home's state/ folder, and Herdr's live pane list (for the
pane labels). It writes only the page and, beside it, a cache of pane labels
so a closed pane keeps its name.

Usage (from the repo root):
  python3 setup/transcript-reader/prototype/build_prototype.py \
      [--home PATH ...] [--session ID_OR_PATH ...] [--since-hours N] \
      [--out setup/transcript-reader/out/prototype.html] [--stats]

With no --home, it reads the main home ~/fm-homes/pmos and every home listed
in its data/secondmates.md. With no --session, it shows each home's current
session (state/.lock-session) and the newest earlier session in the same folder.
With --session, it shows exactly those sessions, each under the home whose folder
holds the session's working directory, and the fleet timeline starts at the
earliest of them unless --since-hours is given.

The page embeds private transcript text, so the output folder is gitignored.
No model is called; every label comes from the rules in this file.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "template.html"
DEFAULT_OUT = HERE.parent / "out" / "prototype.html"
PROJECTS = Path.home() / ".claude" / "projects"
MAIN_HOME = Path.home() / "fm-homes" / "pmos"


# ---------------------------------------------------------------- input files

def read_jsonl(path: Path) -> list[dict]:
    """Every parseable line. A live log can end mid-line, so bad lines are skipped."""
    records = []
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                records.append(value)
    return records


def iso_to_epoch(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def block_text(content) -> str:
    """Text a person would read from a message's content: text blocks only."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text") or "")
    return "\n".join(part for part in parts if part)


def is_tool_result(record: dict) -> bool:
    content = (record.get("message") or {}).get("content")
    return isinstance(content, list) and any(
        isinstance(block, dict) and block.get("type") == "tool_result" for block in content
    )


# ------------------------------------------------------- who started the turn

DOORBELL = re.compile(
    r"^\s*:?\s*⁣?\s*(?:FIRSTMATE_OP:|Firstmate (?:instruction|operational input) waiting|"
    r"Firstmate:\s|\[fm-from-firstmate\])"
)
INBOX_PATH = re.compile(r"(?:list|read)\s+'?(/[^'\s]+?\.(?:inbox|msg))'?(?:/|\s|$)")
WAKE_LINE = re.compile(r"firstmate watcher wake[^\n]*\n\s*([a-z-]+)(?::\s*([^\n]*))?")
BACKGROUND = re.compile(r'Background (?:command|shell command) "([^"]*)"\s*(completed|failed|was stopped)?')
LOCAL_COMMAND = re.compile(r"<command-name>(/[\w:-]+)</command-name>")
COMMAND_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)
PASTED = re.compile(r"</?pasted_content[^>]*>")


def signal_task(text: str) -> str | None:
    """The task whose status line caused a signal wake-up, if this is one."""
    match = WAKE_LINE.search(text)
    if match and match.group(1) == "signal" and match.group(2):
        return Path(match.group(2).strip()).name.removesuffix(".status")
    return None


def wake_label(text: str) -> tuple[str, str]:
    """(kind, one-line label) for a background wake-up."""
    match = WAKE_LINE.search(text)
    if match:
        kind, detail = match.group(1), (match.group(2) or "").strip()
        if kind == "signal":
            return "status", f"New status from {signal_task(text) or 'a worker'}"
        if kind == "stale":
            return "quiet", "A worker has been quiet a while"
        if kind == "check":
            return "check", f"Check: {detail}" if detail else "Check result"
        if kind == "heartbeat":
            return "heartbeat", "Routine fleet check"
        return "other", f"Wake-up: {kind}"
    if "auto-arm FAILED" in text:
        return "monitor", "Monitoring failed to restart"
    match = BACKGROUND.search(text)
    if match:
        outcome = match.group(2) or "finished"
        return "background", f"Background task {outcome}: {match.group(1)}"
    if "Stop hook" in text:
        return "hook", "Turn-end check"
    return "other", "Background notice"


def classify_input(text: str, origin_kind: str | None, is_meta: bool) -> tuple[str, str, str]:
    """(source, kind, label). source is captain, firstmate, wake or session."""
    stripped = text.strip()
    if origin_kind == "task-notification" or stripped.startswith("<task-notification>"):
        kind, label = wake_label(text)
        return "wake", kind, label
    if stripped.startswith("This session is being continued from a previous conversation"):
        return "session", "compacted", "Earlier context was summarised"
    if stripped.startswith("[Request interrupted by user"):
        return "session", "interrupted", "You interrupted the turn"
    command = LOCAL_COMMAND.search(stripped)
    if command and origin_kind is None:
        return "session", "command", f"You ran {command.group(1)}"
    if stripped.startswith("<local-command-stdout>") or is_meta:
        return "session", "command-output", "Command output"
    if DOORBELL.search(stripped):
        if "launch-brief" in stripped[:200] or "operational input" in stripped[:80]:
            return "firstmate", "brief", "Firstmate: task instructions"
        return "firstmate", "steer", "Firstmate: instruction"
    if command:
        args = COMMAND_ARGS.search(stripped)
        tail = f" {args.group(1).strip()}" if args and args.group(1).strip() else ""
        return "captain", "command", f"{command.group(1)}{tail}"
    return "captain", "message", "You"


def clean_input(text: str) -> str:
    text = PASTED.sub("", text)
    command = LOCAL_COMMAND.search(text)
    if command:
        args = COMMAND_ARGS.search(text)
        return f"{command.group(1)} {args.group(1).strip() if args else ''}".strip()
    return text.strip()


# ------------------------------------------------- Needs you / No action rules

INLINE_CODE = re.compile(r"`[^`\n]*`")
URL = re.compile(r"https?://\S+")
SENTENCE = re.compile(r"[^.!?\n]+(?:[.!?]+|$)", re.M)

EXPLICIT_NEEDS = re.compile(r"^\s*(?:\*\*)?(?:Needs you|Decide|Review|Unblock|Blocked)\s*(?:\*\*)?\s*[:·-]", re.I)
EXPLICIT_NONE = re.compile(r"^\s*(?:\*\*)?(?:No action|Done|Found|FYI)\s*(?:\*\*)?\s*[:·-]", re.I)
SHIPSHAPE = re.compile(r"^\s*Captain,\s*shipshape\.?\s*$", re.I)
ASK = re.compile(
    r"\b(?:should I|shall I|do you want|want me to|would you like|your call|your (?:\w+ )?decision|decisions? (?:for|from) you|"
    r"your (?:go|word|approval|ok|okay|sign-off|answer|pick|choice)|(?:approve|merge|land|ship) (?:it|this|them|the \w+)\?|ready to merge|"
    r"ready for (?:your )?review|needs? your|need you to|you (?:need|have) to|decide|decision (?:is )?needed|pick (?:one|a|an|between|which)|choose|"
    r"confirm (?:whether|that|if|which)|which (?:option|one|do you|would you)|let me know|say the word|reply with|tell me (?:which|whether|if)|"
    r"when you(?:'re ready| have a moment)|please (?:approve|confirm|review|merge|decide|pick|choose|reply|run|log ?in|sign in))\b"
    r"|^(?:say|tell me|reply|answer|run)\b(?![^:]{0,25}:)",
    re.I,
)
NO_ASK = re.compile(
    r"\b(?:no action (?:is )?(?:needed|required|for you)|nothing (?:else |new )?(?:needs|is waiting on|for) you(?:r attention)?|"
    r"nothing (?:needs|is) waiting on you|no decision (?:is )?(?:needed|waiting)|nothing to decide|nothing for you to do|"
    r"no reply (?:is )?(?:needed|expected)|your part: none)\b",
    re.I,
)
# A reminder restates something already asked ("still waiting on your answers").
REMINDER = re.compile(
    r"\b(?:still|remains?|are) (?:waiting|waits?|pending|open|holding)\b|\bstill (?:need|needs)\b|\bwaits? on (?:you|your)\b|"
    r"\b(?:awaiting|waiting (?:on|for)) (?:you|your)\b",
    re.I,
)
# A promise about later ("I'll bring you the findings and wait for your go") is not an ask now.
PROMISE = re.compile(r"^(?:I'll|I will|I'm going to|It will|They will|The \w+ will)\b", re.I)
OPTIONS = re.compile(r"(?im)^\s*(?:[-*]\s*)?(?:\*\*)?(?:option\s*[1-9A-C]\b|\(?[A-C]\)\s)|\b(?:the options|pick one|options are)\b")


def prose_lines(text: str):
    """(line number, readable text) for each prose line: code fences and quotes skipped,
    inline code and URLs blanked, so their ? and words do not count."""
    in_fence = False
    for number, line in enumerate(text.splitlines()):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or line.lstrip().startswith(">"):
            continue
        yield number, URL.sub(" link ", INLINE_CODE.sub(" code ", line))


def sentence_kind(sentence: str) -> str | None:
    """ask, reminder or None for one sentence of a reply."""
    # A bold or # heading that is itself a question ("**Do the tabs matter?**") introduces an answer.
    lead = sentence.lstrip("-0-9. ")
    heading = lead.startswith("#") or (lead.startswith("**") and "**" not in lead[2:])
    bare = sentence.lstrip("-*0-9.# ").replace("**", "").strip()
    if len(bare) < 4 or NO_ASK.search(bare) or (heading and bare.endswith("?")):
        return None
    if bare.endswith("?"):
        return "ask"
    if REMINDER.search(bare):
        return "reminder"
    if ASK.search(bare) and not PROMISE.search(bare):
        return "ask"
    return None


def classify_reply(reply: str) -> dict:
    """Needs you or No action, the rule that decided it, and the reply lines that ask or remind."""
    result = {"verdict": "no-action", "rule": "no ask found", "asks": [], "ask_lines": [], "reminder_lines": []}
    if not reply.strip():
        return {**result, "verdict": "none", "rule": "no reply"}
    first = reply.strip().splitlines()[0]
    if EXPLICIT_NEEDS.search(first):
        return {**result, "verdict": "needs-you", "rule": "first line says so", "asks": [first.strip()], "ask_lines": [0]}
    if EXPLICIT_NONE.search(first) or SHIPSHAPE.search(reply):
        return {**result, "rule": "first line says so"}
    asks, ask_lines, reminder_lines = [], [], []
    for number, line in prose_lines(reply):
        kinds = [(sentence_kind(m.group(0).strip()), m.group(0).strip()) for m in SENTENCE.finditer(line)]
        if any(kind == "ask" for kind, _ in kinds):
            ask_lines.append(number)
            asks += [sentence for kind, sentence in kinds if kind == "ask"]
        elif any(kind == "reminder" for kind, _ in kinds):
            reminder_lines.append(number)
    result.update(asks=asks[:6], ask_lines=ask_lines, reminder_lines=reminder_lines)
    if ask_lines:
        rule = "question" if any(s.endswith("?") for s in asks) else "ask wording"
        return {**result, "verdict": "needs-you", "rule": rule}
    if reminder_lines and OPTIONS.search(reply):
        return {**result, "verdict": "needs-you", "rule": "pending choice with options", "ask_lines": reminder_lines, "reminder_lines": []}
    if reminder_lines:
        return {**result, "rule": "reminder only"}
    return result


# ------------------------------------------------------------ exchanges (View A)

def new_exchange(source, kind, label, text, timestamp, absorbed=False):
    return {
        "source": source, "kind": kind, "label": label, "input": text,
        "at": iso_to_epoch(timestamp), "absorbed": absorbed,
        "events": [], "tools": 0, "notices": [],
    }


def session_exchanges(records: list[dict]) -> list[dict]:
    """Split a session into exchanges: one input and the replies that answer it.

    A captain or firstmate message that arrives while the agent is busy is
    recorded as a queued_command attachment inside the running turn. It starts a
    new exchange at that point, so the reply after it reads as its answer.
    """
    exchanges: list[dict] = []
    current = None
    for record in records:
        kind = record.get("type")
        if kind == "user" and not is_tool_result(record):
            text = block_text((record.get("message") or {}).get("content"))
            if not text.strip():
                continue
            origin = (record.get("origin") or {}).get("kind")
            source, sub, label = classify_input(text, origin, bool(record.get("isMeta")))
            if source == "session" and sub == "command-output":
                continue
            current = new_exchange(source, sub, label, clean_input(text), record.get("timestamp"))
            current["signal_task"] = signal_task(text) if source == "wake" else None
            exchanges.append(current)
        elif kind == "attachment" and (record.get("attachment") or {}).get("type") == "queued_command":
            attachment = record["attachment"]
            prompt = attachment.get("prompt")
            text = prompt if isinstance(prompt, str) else block_text(prompt)
            origin = (attachment.get("origin") or {}).get("kind")
            source, sub, label = classify_input(text, origin, False)
            if source == "wake" or current is None:
                if current is not None:
                    current["notices"].append({"label": label, "signal_task": signal_task(text) if source == "wake" else None})
                continue
            current = new_exchange(source, sub, label, clean_input(text), record.get("timestamp"), absorbed=True)
            current["signal_task"] = None
            exchanges.append(current)
        elif kind == "assistant" and current is not None:
            for block in (record.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and (block.get("text") or "").strip():
                    current["events"].append(("text", block["text"], iso_to_epoch(record.get("timestamp"))))
                elif block.get("type") == "tool_use":
                    current["events"].append(("tool", block.get("name") or "tool", None))
                    current["tools"] += 1
    for exchange in exchanges:
        finish_exchange(exchange)
    return exchanges


def finish_exchange(exchange: dict) -> None:
    events = exchange.pop("events")
    last_tool = max((i for i, event in enumerate(events) if event[0] == "tool"), default=-1)
    tail = [event for event in events[last_tool + 1:] if event[0] == "text"]
    narration = [event[1] for event in events[: last_tool + 1] if event[0] == "text"]
    exchange["reply"] = "\n\n".join(event[1] for event in tail).strip()
    exchange["reply_at"] = tail[-1][2] if tail else None
    exchange["narration"] = narration
    exchange["reply_words"] = len(exchange["reply"].split())
    exchange["narration_words"] = sum(len(text.split()) for text in narration)
    exchange.update(classify_reply(exchange["reply"]))
    # Wake-ups fold unless their reply asks something; session events are dividers.
    exchange["folded"] = exchange["source"] == "wake" and exchange["verdict"] != "needs-you"


# ------------------------------------------------------- fleet records (View B)

STATUS_LINE = re.compile(r"^([a-z-]+)((?:\s*\[[^\]]*\])*)\s*:\s?(.*)$")
TAG = re.compile(r"\[([a-z_]+)=([^\]]*)\]")


def parse_status_file(path: Path) -> list[dict]:
    """One event per status line; a line that is not a status line continues the one before it."""
    events = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = STATUS_LINE.match(line.strip())
        if not match:
            if events and line.strip():
                events[-1]["text"] += "\n" + line.rstrip()
            continue
        tags = dict(TAG.findall(match.group(2)))
        at = tags.get("at")
        events.append({
            "state": match.group(1), "key": tags.get("key"), "corr": tags.get("corr"),
            "at": float(at) if at and at.isdigit() else None, "text": match.group(3).strip(),
        })
    return events


def parse_inbox_message(path: Path) -> dict | None:
    raw = path.read_text(encoding="utf-8", errors="replace")
    head, sep, body = raw.partition("\n--\n")
    if not sep:
        return None
    fields = dict(line.split("=", 1) for line in head.splitlines() if "=" in line)
    body = body.replace("[fm-from-firstmate]", "").lstrip("⁣ ")
    corr = re.match(r"(?:corr|delivery)=([0-9a-f]+)\s*", body)
    if corr:
        body = body[corr.end():]
    return {
        "at": iso_to_epoch(fields.get("at")), "delivery": fields.get("delivery"),
        "corr": corr.group(1) if corr else None, "text": body.strip(),
        "handled": path.parent.name == "handled", "file": path.name,
    }


def read_inbox(directory: Path) -> list[dict]:
    messages = []
    for path in sorted(directory.glob("*.msg")) + sorted((directory / "handled").glob("*.msg")):
        message = parse_inbox_message(path)
        if message:
            messages.append(message)
    return messages


def registered_secondmates(home: Path) -> list[dict]:
    registry = home / "data" / "secondmates.md"
    if not registry.is_file():
        return []
    mates = []
    for line in registry.read_text(encoding="utf-8", errors="replace").splitlines():
        name = re.match(r"^- (\S+) - ", line)
        path = re.search(r"\(home: ([^;)]+)", line)
        if name and path:
            mates.append({"id": name.group(1), "home": Path(path.group(1).strip())})
    return mates


def project_folder(home: Path) -> Path:
    return PROJECTS / re.sub(r"[^A-Za-z0-9]", "-", str(home))


def find_session_file(session: str) -> Path | None:
    candidate = Path(session).expanduser()
    if candidate.is_file():
        return candidate
    matches = sorted(PROJECTS.glob(f"*/{session}.jsonl"))
    return matches[0] if matches else None


def home_sessions(home: Path, since: float, limit: int = 4) -> list[Path]:
    """The home's current session (from its lock), then earlier ones in its own folder
    written to inside the window, newest first."""
    found: list[Path] = []
    lock = home / "state" / ".lock-session"
    if lock.is_file():
        current = find_session_file(lock.read_text().strip())
        if current:
            found.append(current)
    folder = project_folder(home)
    if folder.is_dir():
        for path in sorted(folder.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
            if len(found) >= limit or path.stat().st_mtime < since:
                break
            if path not in found:
                found.append(path)
    return found[:limit]


def attach_inbox_bodies(exchanges: list[dict], parent_home: Path | None) -> None:
    """A doorbell only names an inbox. Show the messages it delivered."""
    seen: set[tuple[str, str]] = set()
    cache: dict[str, list[dict]] = {}
    for exchange in exchanges:
        if exchange["source"] != "firstmate" or exchange["kind"] != "steer":
            continue
        match = INBOX_PATH.search(exchange["input"])
        if not match:
            continue
        path = Path(match.group(1))
        directory = path if path.suffix == ".inbox" else path.parent
        if directory.name == "handled":
            directory = directory.parent
        if str(directory) not in cache:
            cache[str(directory)] = read_inbox(directory) if directory.is_dir() else []
        delivered = []
        for message in cache[str(directory)]:
            ident = (str(directory), message["file"])
            if ident in seen or message["at"] is None or exchange["at"] is None:
                continue
            if message["at"] <= exchange["at"] + 60:
                delivered.append(message)
                seen.add(ident)
        exchange["delivered"] = [m["text"] for m in delivered]


def collect_fleet(homes: list[dict], since: float) -> list[dict]:
    """Structured spine: status lines (child to parent) and inbox messages (parent to child)."""
    events = []
    for home in homes:
        state = home["home"] / "state"
        if not state.is_dir():
            continue
        for status in sorted(state.glob("*.status")):
            task = status.name.removesuffix(".status")
            child = task if task.startswith("secondmate-") else f"{home['id']} · {task}"
            for event in parse_status_file(status):
                if event["at"] is not None:
                    events.append({**event, "kind": "status", "from": child, "to": home["id"], "home": home["id"], "task": task})
        for inbox in sorted(state.glob("*.inbox")):
            task = inbox.name.removesuffix(".inbox")
            child = task if task.startswith("secondmate-") else f"{home['id']} · {task}"
            for message in read_inbox(inbox):
                if message["at"] is None or message["at"] < since:
                    continue
                events.append({
                    "kind": "inbox", "state": "message", "from": home["id"], "to": child, "home": home["id"], "task": task,
                    "at": message["at"], "text": message["text"], "corr": message["corr"], "handled": message["handled"],
                    "delivery": message["delivery"],
                })
    events.sort(key=lambda event: event["at"])
    open_keys: dict[str, dict] = {}
    for event in events:
        if event["kind"] != "status" or not event.get("key"):
            continue
        ident = f"{event['home']}/{event['task']}/{event['key']}"
        if event["state"] == "resolved":
            open_keys.pop(ident, None)
        elif event["state"] in ("needs-decision", "blocked", "paused"):
            open_keys[ident] = event
    for event in open_keys.values():
        event["open"] = True
    # Open items stay on the timeline however old they are; everything else keeps to the window.
    return [event for event in events if event["at"] >= since or event.get("open")]


def captain_events(home: dict, exchanges: list[dict], since: float) -> list[dict]:
    """The captain's own messages to a home and that home's replies: only the transcript has them."""
    events = []
    for index, exchange in enumerate(exchanges):
        if exchange["at"] is None or exchange["at"] < since:
            continue
        if exchange["source"] == "captain":
            events.append({"kind": "captain", "state": "message", "from": "captain", "to": home["id"], "home": home["id"],
                           "at": exchange["at"], "text": exchange["input"], "ref": index})
        if exchange["reply"] and (exchange["source"] == "captain" or exchange["verdict"] == "needs-you"):
            lines = exchange["reply"].splitlines()
            events.append({"kind": "reply", "state": exchange["verdict"], "from": home["id"], "to": "captain", "home": home["id"],
                           "at": exchange["reply_at"] or exchange["at"], "text": exchange["reply"], "ref": index,
                           "asks": [lines[n].strip() for n in exchange["ask_lines"] if n < len(lines)][:3],
                           "wake": exchange["source"] == "wake"})
    return events


# ----------------------------------------------------------------- page build

def build(args) -> dict:
    homes = [{"id": "main", "home": Path(args.main_home).expanduser()}]
    if args.home:
        homes += [{"id": Path(h).expanduser().name if Path(h).name != "firstmate" else Path(h).parent.name, "home": Path(h).expanduser()} for h in args.home]
    else:
        homes += registered_secondmates(homes[0]["home"])
    parent_of = {mate["id"]: homes[0]["home"] for mate in homes[1:]}

    # (home, session file, records) for every session to show.
    chosen = []
    if args.session:
        for name in args.session:
            path = find_session_file(name)
            if not path:
                raise SystemExit(f"session not found: {name}")
            records = read_jsonl(path)
            chosen.append((session_home(homes, records), path, records))
        starts = [t for _, _, records in chosen for t in [first_time(records)] if t is not None]
        since = min(starts) if args.since_hours is None and starts else time.time() - (args.since_hours or 72) * 3600
    else:
        since = time.time() - (args.since_hours or 72) * 3600
        chosen = [(home, path, read_jsonl(path)) for home in homes for path in home_sessions(home["home"], since)]

    sessions = []
    fleet = collect_fleet(homes, since)
    for home, path, records in chosen:
        exchanges = session_exchanges(records)
        attach_inbox_bodies(exchanges, parent_of.get(home["id"]))
        session_id = path.stem
        cwd = next((r["cwd"] for r in records if r.get("cwd")), "")
        where = Path(cwd).relative_to(home["home"]).as_posix() if cwd.startswith(str(home["home"]) + "/") else ""
        if where.startswith("state/.treehouse/"):
            where = "worker copy"  # a worker's isolated copy, not the home's own clone
        sessions.append({"home": home["id"], "id": session_id, "file": str(path), "where": where, "exchanges": exchanges})
        for event in captain_events(home, exchanges, since):
            event["session"] = session_id
            fleet.append(event)
    link_turns(fleet, sessions)
    fleet.sort(key=lambda event: event["at"])
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))  # python -I leaves the script's folder off the path
    from build_questionnaire import parse_questionnaire  # it imports this module, so only here
    for session in sessions:
        for exchange in session["exchanges"]:
            # A reply that asks for keyed answers links to the answer sheet, which opens on it.
            if exchange["reply"] and parse_questionnaire(exchange["reply"]):
                exchange["sheet"] = f"{session['id'][:8]}:{round(exchange['reply_at'] or exchange['at'] or 0)}"
    labels = pane_labels([s["id"] for s in sessions], Path(args.out).expanduser().parent / "pane-labels.json")
    for session in sessions:
        session["pane"] = labels.get(session["id"])
    if args.session:
        # Chosen sessions read newest activity first; the page opens on the first one.
        sessions.sort(key=lambda s: max((e["reply_at"] or e["at"] or 0) for e in s["exchanges"]) if s["exchanges"] else 0, reverse=True)
    summaries = [summary for summary in (home_summary(home) for home in homes) if summary]
    return {"generated": time.time(), "since": since, "homes": [h["id"] for h in homes], "sessions": sessions, "fleet": fleet,
            "summaries": summaries, "chosen": bool(args.session)}


def herdr_panes() -> dict[str, dict]:
    """Session id -> the Herdr pane running it, from every running Herdr session.

    Read-only: `herdr session list`, `pane list` and `tab list`. No Herdr, no labels.
    """
    def call(*argv):
        try:
            done = subprocess.run(["herdr", *argv], capture_output=True, text=True, timeout=10)
            return json.loads(done.stdout) if done.returncode == 0 else None
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            return None

    listing = call("session", "list", "--json") or {}
    panes = {}
    for herdr_session in listing.get("sessions") or []:
        name = herdr_session.get("name") or ""
        if not herdr_session.get("running") or name.startswith("-"):
            continue
        panes_result = (call("--session", name, "pane", "list") or {}).get("result") or {}
        tabs_result = (call("--session", name, "tab", "list") or {}).get("result") or {}
        panes.update(pane_index(name, panes_result.get("panes") or [], tabs_result.get("tabs") or []))
    return panes


def pane_index(herdr_session: str, panes: list[dict], tabs: list[dict]) -> dict[str, dict]:
    """Session id -> {label, title, herdr} for the agent panes of one Herdr session.

    label is the name Herdr shows for the pane: its own label, else its tab's
    label. title is the terminal title the agent set ("Bc36 spec handoff rule 3").
    """
    tab_labels = {tab.get("tab_id"): tab.get("label") or "" for tab in tabs}
    found = {}
    for pane in panes:
        session = (pane.get("agent_session") or {}).get("value")
        if not session:
            continue
        title = pane.get("terminal_title_stripped") or ""
        label = pane.get("label") or tab_labels.get(pane.get("tab_id")) or title
        found[session] = {"label": label, "title": title, "herdr": herdr_session}
    return found


def pane_labels(session_ids: list[str], cache_path: Path) -> dict[str, dict]:
    """Live pane labels for these sessions, falling back to the last label seen when a pane has closed."""
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cache = {}
    live = herdr_panes()
    cache.update(live)
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=1, sort_keys=True), encoding="utf-8")
    except OSError:
        pass
    return {sid: {**cache[sid], "live": sid in live} for sid in session_ids if sid in cache}


def session_home(homes: list[dict], records: list[dict]) -> dict:
    """The home whose folder holds the session's working directory (longest match), else main."""
    cwd = next((r["cwd"] for r in records if r.get("cwd")), "")
    inside = [h for h in homes if cwd == str(h["home"]) or cwd.startswith(str(h["home"]) + "/")]
    return max(inside, key=lambda h: len(str(h["home"])), default=homes[0])


def first_time(records: list[dict]) -> float | None:
    return next((t for t in (iso_to_epoch(r.get("timestamp")) for r in records) if t is not None), None)


def home_summary(home: dict) -> dict | None:
    """What the home itself records as waiting on the captain (state/home-summary.json)."""
    path = home["home"] / "state" / "home-summary.json"
    try:
        summary = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    keep = ("id", "verb", "summary", "reason", "hold_age_days", "hold_until")
    return {"home": home["id"], "valid": bool(summary.get("valid")), "generated": summary.get("generated"),
            "decisions_open": [{k: d.get(k) for k in keep} for d in summary.get("decisions_open") or []]}


def link_turns(fleet: list[dict], sessions: list[dict], window: float = 1800) -> None:
    """Give each structured event the raw turn that handled it, when one is in a loaded session.

    A status line wakes its parent home with a signal naming the status file; a
    steer reaches a secondmate as a firstmate doorbell shortly after it is written.
    """
    for event in fleet:
        if event["kind"] not in ("status", "inbox") or "session" in event:
            continue
        home = event["home"] if event["kind"] == "status" else event["to"]
        best = None
        for session in sessions:
            if session["home"] != home:
                continue
            for index, exchange in enumerate(session["exchanges"]):
                if exchange["at"] is None or not 0 <= exchange["at"] - event["at"] <= window:
                    continue
                if event["kind"] == "status":
                    tasks = [exchange.get("signal_task")] + [notice["signal_task"] for notice in exchange["notices"]]
                    matches = event["task"] in tasks
                else:
                    matches = exchange["source"] == "firstmate"
                if matches and (best is None or exchange["at"] < best[0]):
                    best = (exchange["at"], session["id"], index)
        if best:
            event["session"], event["ref"] = best[1], best[2]


def stats(payload: dict) -> str:
    lines = []
    for session in payload["sessions"]:
        ex = session["exchanges"]
        count = lambda pred: sum(1 for e in ex if pred(e))
        lines.append(
            f"{session['home']:<34} {session['id'][:8]} exchanges={len(ex)} captain={count(lambda e: e['source']=='captain')} "
            f"absorbed={count(lambda e: e['absorbed'] and e['source']=='captain')} firstmate={count(lambda e: e['source']=='firstmate')} "
            f"wake={count(lambda e: e['source']=='wake')} folded={count(lambda e: e['folded'])} "
            f"needs={count(lambda e: e['verdict']=='needs-you')} wake_needs={count(lambda e: e['source']=='wake' and e['verdict']=='needs-you')}"
        )
    fleet = payload["fleet"]
    kinds = {}
    for event in fleet:
        kinds[event["kind"]] = kinds.get(event["kind"], 0) + 1
    lines.append(f"fleet events since window start: {kinds}; open items: {sum(1 for e in fleet if e.get('open'))}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--main-home", default=str(MAIN_HOME))
    parser.add_argument("--home", action="append", help="secondmate home to include (default: the main home's registry)")
    parser.add_argument("--session", action="append", help="session id or path to show (repeatable); only these are read")
    parser.add_argument("--since-hours", type=float, help="fleet window (default 72, or from the earliest --session)")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--stats", action="store_true", help="print counts only; write no page")
    args = parser.parse_args()

    payload = build(args)
    if args.stats:
        print(stats(payload))
        return 0
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    data = data.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    page = TEMPLATE.read_text(encoding="utf-8")
    # The policy allows only the page's own script, by hash, so injected markup cannot run code.
    script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
    digest = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii")
    page = page.replace("__SCRIPT_HASH__", f"sha256-{digest}").replace("__PAYLOAD__", data)
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    print(f"Wrote {out}")
    print(stats(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
