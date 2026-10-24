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
import fcntl
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "template.html"
LIVE_SCRIPT = HERE / "live.js"
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
# Firstmate's current doorbell names the inbox only, shell-quoted: list "$FM_TASK_INBOX"/*.msg
# in your '<task>.inbox' steering inbox. It lives in the state/ folder of the home that steers.
# Task instructions arrive as a pointer to one operational-input file.
OPERATIONAL = re.compile(r"operational input waiting: read '(/[^']+?\.msg)'")
OP_PREFIX = re.compile(r"^[\s\u2063]*FIRSTMATE_OP:\s*v\d+\s+[\w-]+:\s*")
INBOX_NAME = re.compile(r"in your '((?:[^']|'\\'')+)' steering inbox")
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


# The supervision host's own wake-ups, by the words their line starts with.
SUPERVISION_LABELS = {
    "cycle boundary": "Monitoring cycle restarted",
    "branch-outcome": "Supervision recorded outcomes to pass on",
}
CHECK_SCRIPT = re.compile(r"^/\S+\.check\.sh:\s*")


def wake_label(text: str) -> tuple[str, str]:
    """(kind, one-line label) for a background wake-up."""
    kind, label = raw_wake_label(text)
    return kind, html.unescape(label)  # a task notification's summary is escaped XML


def raw_wake_label(text: str) -> tuple[str, str]:
    match = WAKE_LINE.search(text)
    if match:
        kind, detail = match.group(1), (match.group(2) or "").strip()
        if kind == "signal":
            return "status", f"New status from {signal_task(text) or 'a worker'}"
        if kind == "stale":
            return "quiet", "A worker has been quiet a while"
        if kind == "check":
            # A home's own check script names itself first: say what it found.
            detail = CHECK_SCRIPT.sub("", detail)
            return "check", f"Check: {detail}" if detail else "Check result"
        if kind == "heartbeat":
            return "heartbeat", "Routine fleet check"
        if kind == "supervision-host":
            head = re.split(r":| - ", detail, maxsplit=1)[0].strip()
            return "supervision", SUPERVISION_LABELS.get(head, f"Supervision: {head}" if head else "Supervision wake-up")
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
    """(source, kind, label). source is captain, firstmate, wake or session; peer_input adds peer."""
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


def peer_input(origin: dict) -> tuple[str, str, str] | None:
    """(source, kind, label) for a message from another agent session, else None.

    Claude Code marks these isMeta, so without this they read as command output.
    A hand-back is a background agent reporting its finished task, folded like a
    wake-up; anything else is a message another session sent this one.
    """
    if origin.get("kind") != "peer":
        return None
    name = str(origin.get("name") or origin.get("from") or "another session").strip()
    if origin.get("handback"):
        return "wake", "handback", f"Hand-back from {name}"
    return "peer", "message", f"From {name}"


def peer_text(origin: dict, text: str) -> str:
    """The message itself: the origin's body, without the wrapper the log adds around it."""
    body = origin.get("body")
    return body if isinstance(body, str) and body.strip() else text


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
            origin = record.get("origin") or {}
            peer = peer_input(origin)
            source, sub, label = peer or classify_input(text, origin.get("kind"), bool(record.get("isMeta")))
            if source == "session" and sub == "command-output":
                continue
            text = peer_text(origin, text) if peer else text
            current = new_exchange(source, sub, label, clean_input(text), record.get("timestamp"))
            current["signal_task"] = signal_task(text) if source == "wake" else None
            exchanges.append(current)
        elif kind == "attachment" and (record.get("attachment") or {}).get("type") == "queued_command":
            attachment = record["attachment"]
            prompt = attachment.get("prompt")
            text = prompt if isinstance(prompt, str) else block_text(prompt)
            origin = attachment.get("origin") or {}
            peer = peer_input(origin)
            source, sub, label = peer or classify_input(text, origin.get("kind"), False)
            text = peer_text(origin, text) if peer else text
            if source == "wake" or current is None:
                if current is not None:
                    current["notices"].append({"label": label, "signal_task": signal_task(text) if source == "wake" else None})
                continue
            current = new_exchange(source, sub, label, clean_input(text), record.get("timestamp"), absorbed=True)
            current["signal_task"] = None
            exchanges.append(current)
        elif kind == "assistant" and current is not None:
            if record.get("cwd"):
                current["cwd"] = record["cwd"]  # where relative file names in the reply start from
            for block in (record.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and (block.get("text") or "").strip():
                    current["events"].append(("text", block["text"], iso_to_epoch(record.get("timestamp"))))
                elif block.get("type") == "tool_use":
                    current["events"].append(("tool", block.get("name") or "tool", None))
                    current["tools"] += 1
                    current.setdefault("touched", []).extend(tool_documents(block.get("input"), record.get("cwd") or ""))
    for exchange in exchanges:
        finish_exchange(exchange)
    # A message sent while the agent was busy takes the rest of the turn, which usually
    # answers the message before it too: that one is answered below, not unanswered.
    for i, exchange in enumerate(exchanges):
        later = exchanges[i + 1:]
        run = next((n for n, e in enumerate(later) if not e["absorbed"]), len(later))
        exchange["answered_below"] = not exchange["reply"] and any(e["reply"] for e in later[:run])
    # The newest turn with no reply yet is still running, or ended without a word, and the
    # newest reply is where the session stands (a worker often reports its finished task in
    # a wake-up's turn): both stay open so the reader shows what the session is doing now.
    if exchanges and exchanges[-1]["folded"] and not exchanges[-1]["reply"]:
        exchanges[-1]["folded"] = False
    latest = next((e for e in reversed(exchanges) if e["reply"]), None)
    if latest:
        latest["folded"] = False
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
    matches = [path for path in all_logs() if path.stem == session]
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


def doorbell_inbox(text: str, homes: list[Path]) -> Path | None:
    """The steering inbox a doorbell names: by absolute path, or by name in the state/
    folder of the first of <homes> that has it (the session's home, then its parent's)."""
    match = INBOX_PATH.search(text)
    if match:
        path = Path(match.group(1))
        directory = path if path.suffix == ".inbox" else path.parent
        return directory.parent if directory.name == "handled" else directory
    match = INBOX_NAME.search(text)
    if match:
        name = match.group(1).replace("'\\''", "'")
        if "/" not in name and name not in (".", ".."):
            found = [home / "state" / name for home in homes if (home / "state" / name).is_dir()]
            return found[0] if found else Path("/nonexistent") / name
    return None


def attach_operational_input(exchange: dict) -> None:
    """Show the task instructions an operational-input pointer names, in its place."""
    match = OPERATIONAL.search(exchange["input"])
    if not match:
        return  # the instructions came inline
    path = Path(match.group(1))
    try:
        text = path.read_text(encoding="utf-8", errors="replace") if path.stat().st_size <= MAX_DOCUMENT_BYTES else ""
    except OSError:
        text = ""
    text = OP_PREFIX.sub("", text).strip()
    # A worker's brief opens with the standing role contract; the task is what is new.
    task = text.find("\n# Task\n")
    text = text[task + 1:] if task >= 0 else text
    exchange["delivered"] = [text] if text else []
    exchange["undelivered"] = not text


def attach_inbox_bodies(exchanges: list[dict], homes: list[Path]) -> None:
    """A doorbell only names an inbox. Show the messages it delivered, and say so when
    none is found, rather than leave the pointer line looking like the instruction."""
    seen: set[tuple[str, str]] = set()
    cache: dict[str, list[dict]] = {}
    for exchange in exchanges:
        if exchange["source"] == "firstmate" and exchange["kind"] == "brief":
            attach_operational_input(exchange)
        if exchange["source"] != "firstmate" or exchange["kind"] != "steer":
            continue
        directory = doorbell_inbox(exchange["input"], homes)
        if directory is None:
            continue
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
        # Firstmate rings again while a message waits unread; those rings deliver nothing new.
        exchange["repeat"] = not delivered and exchange["at"] is not None and any(
            (str(directory), m["file"]) in seen and m["at"] is not None and m["at"] <= exchange["at"] + 60
            for m in cache[str(directory)])
        exchange["undelivered"] = not delivered and not exchange["repeat"]


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
        # A reply to another agent session is not addressed to the captain.
        if exchange["reply"] and exchange["source"] != "peer" and (exchange["source"] == "captain" or exchange["verdict"] == "needs-you"):
            lines = exchange["reply"].splitlines()
            events.append({"kind": "reply", "state": exchange["verdict"], "from": home["id"], "to": "captain", "home": home["id"],
                           "at": exchange["reply_at"] or exchange["at"], "text": exchange["reply"], "ref": index,
                           "asks": [lines[n].strip() for n in exchange["ask_lines"] if n < len(lines)][:3],
                           "wake": exchange["source"] == "wake"})
    return events


# ----------------------------------------------------------------- page build

def build(args) -> dict:
    # The build time is taken before any log is read, so a turn written while this build runs
    # leaves its log newer than the stamp and the server rebuilds again.
    started = time.time()
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

    # A pane cleared with /clear, or with Claude restarted in it, goes on in a new session
    # log: read the sessions it ran as one conversation, newest last, under the newest id.
    # The pane each session ran in comes from Herdr now and the pane-label cache before.
    out_dir = Path(args.out).expanduser().parent
    live = herdr_panes()
    pane_labels([], out_dir / "pane-labels.json", live)
    threads: list[tuple[dict, list[Path], dict[Path, list[dict]]]] = []
    for home, path, records in chosen:
        if any(path in chain for _, chain, _ in threads):
            continue
        chain = session_chain(path)
        loaded = {member: (records if member == path else read_jsonl(member)) for member in chain}
        threads.append((home, chain, loaded))

    sessions = []
    fleet = collect_fleet(homes, since)
    for home, chain, loaded in threads:
        path = chain[-1]
        records = loaded[path]
        exchanges = []
        for member in chain:
            part = session_exchanges(loaded[member])
            if len(chain) > 1:
                ended = member != path
                after = chain[chain.index(member) + 1] if ended else None
                how = "cleared later" if after and cleared_at(head_records(after)) is not None else "until Claude restarted"
                label = f"Session {member.stem[:8]}" + (f", {how}; replies go to the newest" if ended else ", the newest in this pane")
                divider = new_exchange("session", "cleared" if ended else "current", label, "", None)
                divider["at"] = first_time(loaded[member])
                finish_exchange(divider)
                part.insert(0, divider)
                if ended:
                    for exchange in part[1:]:
                        exchange["from_session"] = member.stem
            exchanges += part
        attach_inbox_bodies(exchanges, [h for h in (home["home"], parent_of.get(home["id"])) if h])
        session_id = path.stem
        cwd = next((r["cwd"] for r in records if r.get("cwd")), "")
        where = Path(cwd).relative_to(home["home"]).as_posix() if cwd.startswith(str(home["home"]) + "/") else ""
        if where.startswith("state/.treehouse/"):
            where = "worker copy"  # a worker's isolated copy, not the home's own clone
        sessions.append({"home": home["id"], "id": session_id, "ids": [member.stem for member in chain], "file": str(path), "where": where,
                         "exchanges": exchanges})
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
    documents = attach_documents(sessions)
    labels = pane_labels([s["id"] for s in sessions], out_dir / "pane-labels.json", live)
    reopened = set(read_ids(out_dir / "reopened.txt"))
    for session in sessions:
        session["pane"] = labels.get(session["id"])
        session["reopened"] = bool(reopened & set(session["ids"]))
    closed = closed_panes(out_dir / "pane-labels.json", live, {sid for s in sessions for sid in s["ids"]}) if args.session else []
    if args.session:
        # Chosen sessions read newest activity first; the page opens on the first one.
        sessions.sort(key=lambda s: max((e["reply_at"] or e["at"] or 0) for e in s["exchanges"]) if s["exchanges"] else 0, reverse=True)
    summaries = [summary for summary in (home_summary(home) for home in homes) if summary]
    return {"generated": started, "since": since, "homes": [h["id"] for h in homes], "sessions": sessions, "fleet": fleet,
            "summaries": summaries, "chosen": bool(args.session), "documents": documents, "closed": closed}


CLAUDE_SESSIONS = Path.home() / ".claude" / "sessions"


def running_claude_sessions() -> dict[int, str]:
    """pid -> session id of every running Claude Code process, from the record each keeps
    in ~/.claude/sessions (it follows /clear and --resume)."""
    found = {}
    for record in sorted(CLAUDE_SESSIONS.glob("*.json")):
        try:
            data = json.loads(record.read_text(encoding="utf-8"))
            pid, session = int(data["pid"]), str(data["sessionId"])
            os.kill(pid, 0)
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            continue
        found[pid] = session
    return found


def pane_session(claimed: str | None, process_info: dict | None, running: dict[int, str]) -> str | None:
    """The Claude session a pane really runs. Herdr keeps the id it was first told even when
    Claude is restarted in the same pane (Firstmate swaps a worker's model that way), so an id
    no running Claude process holds is checked against the pane's foreground process."""
    if not running or claimed in running.values() or process_info is None:
        return claimed
    processes = process_info.get("foreground_processes") or []
    for process in processes:
        if process.get("pid") in running:
            return running[process["pid"]]
    if any(process.get("argv0") == "claude" for process in processes):
        return claimed  # a Claude process without its record: nothing better to go on
    return None  # Claude has exited; the pane holds a shell


def herdr_panes() -> dict[str, dict]:
    """Session id -> the Herdr pane running it, from every running Herdr session.

    Read-only: `herdr session list`, `pane list`, `tab list`, and `pane process-info` for a
    Claude pane whose session id no running Claude holds. No Herdr, no labels.
    """
    def call(*argv):
        try:
            done = subprocess.run(["herdr", *argv], capture_output=True, text=True, timeout=10)
            return json.loads(done.stdout) if done.returncode == 0 else None
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            return None

    listing = call("session", "list", "--json") or {}
    running = running_claude_sessions()
    panes = {}
    for herdr_session in listing.get("sessions") or []:
        name = herdr_session.get("name") or ""
        if not herdr_session.get("running") or name.startswith("-"):
            continue
        panes_result = (call("--session", name, "pane", "list") or {}).get("result") or {}
        tabs_result = (call("--session", name, "tab", "list") or {}).get("result") or {}
        found = panes_result.get("panes") or []
        for pane in found:
            claimed = (pane.get("agent_session") or {}).get("value")
            if pane.get("agent") == "claude" and running and claimed not in running.values() and pane.get("pane_id"):
                info = ((call("--session", name, "pane", "process-info", "--pane", pane["pane_id"]) or {}).get("result") or {}).get("process_info")
                actual = pane_session(claimed, info, running)
                pane["agent_session"] = {**(pane.get("agent_session") or {}), "value": actual}
        panes.update(pane_index(name, found, tabs_result.get("tabs") or []))
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
        found[session] = {"label": label, "title": title, "herdr": herdr_session, "pane": pane.get("pane_id") or ""}
    return found


def pane_labels(session_ids: list[str], cache_path: Path, live: dict[str, dict] | None = None) -> dict[str, dict]:
    """Live pane labels for these sessions, falling back to the last label seen when a pane has closed."""
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cache = {}
    if live is None:
        live = herdr_panes()
    cache.update(live)
    _PANE_HISTORY.clear()
    _PANE_HISTORY.update(cache)  # session_chain joins a pane's sessions across a restart with it
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=1, sort_keys=True), encoding="utf-8")
    except OSError:
        pass
    return {sid: {**cache[sid], "live": sid in live} for sid in session_ids if sid in cache}


def read_ids(path: Path) -> list[str]:
    try:
        return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except OSError:
        return []


def closed_panes(cache_path: Path, live: dict[str, dict], shown: set[str], days: float = 14, limit: int = 40) -> list[dict]:
    """Sessions whose Herdr pane has closed and that the page does not show, newest first.

    They come from the pane-label cache (every session seen in a pane), so the page can offer
    to reopen one for reading. Only those whose log changed in the last <days> are offered.
    """
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not live:
        return []  # with no live pane at all, Herdr is not running and nothing can be told closed
    since = time.time() - days * 86400
    found = []
    for sid, pane in cache.items():
        if sid in live or sid in shown:
            continue
        path = find_session_file(sid)
        try:
            at = path.stat().st_mtime if path else 0
        except OSError:
            continue
        if at >= since:
            found.append({"id": sid, "label": pane.get("label") or sid[:8], "title": pane.get("title") or "", "herdr": pane.get("herdr") or "", "at": at,
                          "path": path})
    found.sort(key=lambda item: item["at"], reverse=True)
    # A pane cleared with /clear left several sessions, which read as one conversation under the
    # newest. Only sessions sharing a pane label can be one pane, so only those chains are walked.
    offered, joined = [], set()
    for item in found:
        if item["id"] in joined:
            continue
        if sum(other["herdr"] == item["herdr"] and other["label"] == item["label"] for other in found) > 1:
            joined.update(member.stem for member in session_chain(item["path"]))
        offered.append({k: v for k, v in item.items() if k != "path"})
    return offered[:limit]


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


# ------------------------------------------------- files a reply names (documents)

# A markdown file name or path as written in a message: `requirements.md`, 02-Projects/x/work-log.md,
# /abs/path.md, ~/notes.md. A web URL is left out (it reads as //host/... once its scheme is cut
# off); a file:// URL is read as the path it names.
MD_MENTION = re.compile(r"[\w.~/@+-]*[\w-]\.md(?![\w/-])")
FILE_URL = re.compile(r"\bfile://(?=/)")
CD_LINE = re.compile(r"^\s*cd\s+(\"[^\"\n]+\"|'[^'\n]+'|[^\s;&|]+)", re.M)
MAX_DOCUMENT_BYTES = 512 * 1024


def tool_documents(tool_input, cwd: str) -> list[str]:
    """Markdown files a tool call names, as absolute paths that may not exist.

    A path field (Read, Edit and Write give `file_path`) is taken whole. A shell
    command's file names start from its latest `cd` before them, else from the
    working directory, so `cd ~/copy && cat prds/x/requirements.md` counts.
    """
    if not isinstance(tool_input, dict):
        return []
    found = []
    for key, value in tool_input.items():
        if not isinstance(value, str):
            continue
        if key.endswith("path") and MD_MENTION.fullmatch(value):
            tokens, cds = [(0, value)], []
        elif key == "command":
            tokens = [(m.start(), m.group(0)) for m in MD_MENTION.finditer(value) if not m.group(0).startswith("//")]
            cds = [(m.start(), os.path.expanduser(m.group(1).strip("\"'"))) for m in CD_LINE.finditer(value)]
        else:
            continue
        for at, token in tokens:
            base = next((d for start, d in reversed(cds) if start < at and os.path.isabs(d)), cwd)
            path = os.path.join(base, os.path.expanduser(token))
            if os.path.isabs(path):
                found.append(os.path.normpath(path))
    return found


def resolve_mention(token: str, cd_dirs: list[Path], cwd: str, touched: list[str] = ()) -> Path | None:
    """The existing markdown file a reply means by <token>, or None.

    An absolute or ~ path is taken as written. A relative one is tried, in order,
    under each directory an earlier `cd` line in the reply named (latest first),
    then as the end of a path the session's own tool calls named so far (latest
    first, since agents name a file they just edited by its short name), then
    under the turn's working directory and each of its parents below the home
    folder, since agents often name files from their repository's root.
    """
    raw = Path(os.path.expanduser(token))
    if raw.is_absolute():
        candidates = [raw]
    else:
        candidates = [base / raw for base in cd_dirs]
        candidates += [Path(path) for path in reversed(touched) if Path(path).parts[-len(raw.parts):] == raw.parts]
        if cwd:
            here = Path(cwd)
            candidates += [base / raw for base in [here] + [parent for parent in here.parents if Path.home() in parent.parents]]
    for candidate in candidates:
        try:
            if candidate.is_file() and candidate.stat().st_size <= MAX_DOCUMENT_BYTES:
                return candidate.resolve()
        except OSError:
            continue
    return None


def named_documents(text: str, cwd: str, touched: list[str] = ()) -> list[tuple[str, Path]]:
    """(as written, file) for each existing markdown file a message names, in order, once each."""
    text = FILE_URL.sub("", text)
    cds = [(m.start(), Path(os.path.expanduser(m.group(1).strip("\"'")))) for m in CD_LINE.finditer(text)]
    found: list[tuple[str, Path]] = []
    for match in MD_MENTION.finditer(text):
        token = match.group(0)
        if token.startswith("//"):
            continue
        cd_dirs = [d for at, d in reversed(cds) if at < match.start() and d.is_absolute()]
        path = resolve_mention(token, cd_dirs, cwd, touched)
        if path and all(path != known for _, known in found):
            found.append((token, path))
    return found


# Who wrote a turn's input, for the inputs whose named files open as documents. A wake-up's
# notice is the fleet's own record and folds away, and a session event has no author.
DOCUMENT_INPUTS = ("captain", "firstmate", "peer")


def attach_documents(sessions: list[dict]) -> dict[str, dict]:
    """Give each exchange the ids of the documents its reply names (`documents`) and its message
    names (`input_documents`, for a message from you, Firstmate or another session); return
    the documents.

    Each file is read once, as it is now on disk (the page says when it last changed).
    A short name can match a file the session's tool calls named in this turn or an earlier one.
    """
    documents: dict[str, dict] = {}

    def ids_for(text: str, cwd: str, touched: list[str]) -> list[str]:
        ids = []
        for token, path in named_documents(text, cwd, touched):
            key = hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:10]
            if key not in documents:
                try:
                    body = path.read_text(encoding="utf-8", errors="replace")
                    mtime = path.stat().st_mtime
                except OSError:
                    continue
                home = Path.home()
                shown_dir = "~/" + path.parent.relative_to(home).as_posix() if home in path.parents else str(path.parent)
                documents[key] = {"id": key, "name": path.name, "path": str(path), "dir": shown_dir, "mention": token,
                                  "mtime": mtime, "text": body}
            ids.append(key)
        return ids

    for session in sessions:
        touched: list[str] = []
        for exchange in session["exchanges"]:
            cwd = exchange.pop("cwd", "")
            touched += exchange.pop("touched", [])
            if exchange.get("source") in DOCUMENT_INPUTS:
                # A doorbell names only an inbox; the messages it delivered are what was said.
                said = "\n\n".join([exchange.get("input") or ""] + list(exchange.get("delivered") or []))
                ids = ids_for(said, cwd, touched)
                if ids:
                    exchange["input_documents"] = ids
            ids = ids_for(exchange.get("reply") or "", cwd, touched)
            if ids:
                exchange["documents"] = ids
    return documents


# ----------------------------------------------- sessions continued after /clear

CLEAR_COMMAND = "<command-name>/clear</command-name>"
HEAD_RECORDS = 80

# Walking one chain looks at every log in every project folder, several times over, and a
# build walks one chain per listed session. So a build lists each folder and reads each
# log's head once, and again only after the folder or the log changes.
_LISTINGS: dict[Path, tuple[int, list[Path]]] = {}
_HEADS: dict[Path, tuple[tuple[int, int], list[dict]]] = {}
_BRIDGES: dict[tuple[Path, str], tuple[tuple[int, int], bool]] = {}


def file_version(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_mtime_ns, stat.st_size


def listing(folder: Path, pattern: str) -> list[Path]:
    """The entries of <folder> matching <pattern>, listed again only once the folder changes."""
    try:
        stamp = folder.stat().st_mtime_ns
    except OSError:
        return []
    cached = _LISTINGS.get(folder / pattern)
    if cached and cached[0] == stamp:
        return cached[1]
    found = sorted(folder.glob(pattern))
    _LISTINGS[folder / pattern] = (stamp, found)
    return found


def logs_in(folder: Path) -> list[Path]:
    return listing(folder, "*.jsonl")


def all_logs() -> list[Path]:
    """Every session log, in every project folder."""
    return [log for folder in listing(PROJECTS, "*") for log in logs_in(folder)]


def head_records(path: Path, limit: int = HEAD_RECORDS) -> list[dict]:
    """The first parseable records of a log, without reading the whole file."""
    version = file_version(path) if limit == HEAD_RECORDS else None
    cached = _HEADS.get(path)
    if version and cached and cached[0] == version:
        return cached[1]
    records = read_head(path, limit)
    if version:
        _HEADS[path] = (version, records)
    return records


def read_head(path: Path, limit: int) -> list[dict]:
    records = []
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    records.append(value)
                if len(records) >= limit:
                    break
    except OSError:
        pass
    return records


def cleared_at(records: list[dict]) -> float | None:
    """When the session began with /clear, else None.

    /clear starts a new session log in the same folder; its first prompt is the
    /clear command (after a hook or caveat note). Any other first prompt means a
    fresh session.
    """
    for record in records[:HEAD_RECORDS]:
        if record.get("type") != "user" or is_tool_result(record):
            continue
        text = block_text((record.get("message") or {}).get("content")).strip()
        if CLEAR_COMMAND in text:
            return iso_to_epoch(record.get("timestamp"))
        if text and not record.get("isMeta") and not text.startswith("<local-command"):
            return None
    return None


def bridge_id(records: list[dict]) -> str:
    """The remote-control link a log names first, or "". A /clear keeps the process's link."""
    for record in records:
        if record.get("type") == "bridge-session" and record.get("bridgeSessionId"):
            return record["bridgeSessionId"]
    return ""


def names_bridge(path: Path, bridge: str) -> bool:
    """Whether a log's own bridge-session records name this remote-control link. A turn that
    merely quotes the id (a search, a tool result) does not count."""
    version = file_version(path)
    cached = _BRIDGES.get((path, bridge))
    if version and cached and cached[0] == version:
        return cached[1]
    found = reads_bridge(path, bridge)
    if version:
        _BRIDGES[(path, bridge)] = (version, found)
    return found


def reads_bridge(path: Path, bridge: str) -> bool:
    needle = f'"{bridge}"'
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if needle not in line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict) and record.get("type") == "bridge-session" and record.get("bridgeSessionId") == bridge:
                    return True
    except OSError:
        pass
    return False


def cleared_from(path: Path, clear_time: float) -> Path | None:
    """The log a /clear at <clear_time> left behind, last written by the clear itself, so
    within two minutes before it (nearest wins).

    It is the log that names the same remote-control link, in any project folder: a session
    resumed from another directory keeps its old folder, but its /clear starts the new log
    under the current one. Only that process writes the link, so its old log may also get
    its last records up to 30 seconds after the clear. Without a link to match, it is the
    nearest log in the same folder, written at most 5 seconds after the clear.
    """
    def nearest(candidates, late, keep=lambda other: True):
        best = None
        for other in candidates:
            if other == path:
                continue
            try:
                gap = clear_time - other.stat().st_mtime
            except OSError:
                continue
            if -late <= gap <= 120 and (best is None or abs(gap) < best[0]) and keep(other):
                best = (abs(gap), other)
        return best[1] if best else None
    bridge = bridge_id(head_records(path))
    linked = nearest(all_logs(), 30, lambda other: names_bridge(other, bridge)) if bridge else None
    return linked or nearest(logs_in(path.parent), 5)


def session_chain(path: Path, limit: int = 20) -> list[Path]:
    """The sessions one Claude Code pane ran across /clear, or across Claude restarted in the
    same pane, oldest first, including <path>."""
    chain = [path]
    while len(chain) < limit:
        at = cleared_at(head_records(chain[0]))
        before = cleared_from(chain[0], at) if at else restarted_from(chain[0])
        if not before or before in chain:
            break
        chain.insert(0, before)
    while len(chain) < limit:
        after = cleared_into(chain) or restarted_into(chain)
        if not after:
            break
        chain.append(after)
    return chain


# Every pane a session was seen in (the pane-label cache), set by pane_labels.
_PANE_HISTORY: dict[str, dict] = {}
RESTART_WINDOW = 600  # seconds from the old session's last write to the new one's first


def same_pane(a: dict, b: dict) -> bool:
    if a.get("herdr") != b.get("herdr"):
        return False
    if a.get("pane") and b.get("pane"):
        return a["pane"] == b["pane"]
    return bool(a.get("label")) and a.get("label") == b.get("label")  # entries cached before panes were


def restarted(before: Path, after: Path) -> bool:
    """Whether <after> is Claude started afresh in the pane <before> ran in, right after it."""
    a, b = _PANE_HISTORY.get(before.stem), _PANE_HISTORY.get(after.stem)
    if not a or not b or before == after or not same_pane(a, b):
        return False
    head = head_records(after)
    start = first_time(head)
    try:
        ended = before.stat().st_mtime
    except OSError:
        return False
    return cleared_at(head) is None and start is not None and -30 <= start - ended <= RESTART_WINDOW


def pane_neighbours(path: Path) -> list[Path]:
    """Logs of the other sessions seen in the same pane as <path>."""
    mine = _PANE_HISTORY.get(path.stem)
    if not mine:
        return []
    found = (find_session_file(sid) for sid, entry in _PANE_HISTORY.items() if sid != path.stem and same_pane(mine, entry))
    return [log for log in found if log]


def restarted_from(path: Path) -> Path | None:
    return next((other for other in pane_neighbours(path) if restarted(other, path)), None)


def restarted_into(chain: list[Path]) -> Path | None:
    return next((other for other in pane_neighbours(chain[-1]) if other not in chain and restarted(chain[-1], other)), None)


def cleared_into(chain: list[Path]) -> Path | None:
    """The log a /clear in the pane started after the chain's last log, if any."""
    try:
        written = chain[-1].stat().st_mtime
    except OSError:
        return None
    # The next log may sit in another project folder (see cleared_from).
    for other in sorted({*logs_in(chain[-1].parent), *all_logs()}):
        if other in chain:
            continue
        try:
            recent = other.stat().st_mtime >= written - 5
        except OSError:
            continue
        at = cleared_at(head_records(other)) if recent else None
        if at is not None and -30 <= at - written <= 120 and cleared_from(other, at) == chain[-1]:
            return other
    return None


def write_page(template: Path, payload: dict, out: Path) -> None:
    """Fill a template with the payload and the shared live.js, then write the page and its stamp.

    The page is replaced in one rename, so the server never serves half a page. The
    stamp beside it (<page>.stamp) holds the payload's build time; the served page
    compares it with its own to know a newer build exists.
    """
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    data = data.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    page = template.read_text(encoding="utf-8").replace("/*__LIVE__*/", LIVE_SCRIPT.read_text(encoding="utf-8"))
    # The policy allows only the page's own script, by hash, so injected markup cannot run code.
    script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
    digest = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii")
    # The template hash lets a served page tell a new build (swap the data) from new code (reload).
    template_hash = hashlib.sha256(page.encode("utf-8")).hexdigest()[:16]
    page = page.replace("__SCRIPT_HASH__", f"sha256-{digest}").replace("__TEMPLATE_HASH__", template_hash).replace("__PAYLOAD__", data)
    out.parent.mkdir(parents=True, exist_ok=True)
    stamp = out.with_suffix(".stamp")
    # A rebuild started by hand can overlap the server's own. Each writes its own file, and the
    # page and its stamp are replaced together under a lock, never by a build older than the
    # one already there, so the stamp always describes the page beside it.
    with open(out.with_name(f".{out.name}.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if float(stamp.read_text(encoding="utf-8")) > payload["generated"]:
                return
        except (OSError, ValueError):
            pass
        for target, text in ((out, page), (stamp, repr(payload["generated"]))):
            partial = target.with_name(f".{target.name}.{os.getpid()}.partial")
            partial.write_text(text, encoding="utf-8")
            os.replace(partial, target)


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
    out = Path(args.out).expanduser()
    write_page(TEMPLATE, payload, out)
    print(f"Wrote {out}")
    print(stats(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
