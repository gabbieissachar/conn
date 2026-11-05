#!/usr/bin/env python3
"""Build the phase 1 transcript-reader prototype page.

Throwaway prototype for the design checkpoint in ../DESIGN.md. It only reads:
Claude Code session logs under ~/.claude/projects (and under the projects/ of each other Claude config folder), Codex rollout logs under
~/.codex/sessions, GitHub Copilot CLI session logs under ~/.copilot/session-state, the Firstmate fleet
records under each home's state/ folder, and Herdr's live pane list (for the
pane labels). It writes only the page and, beside it, a cache of pane labels
so a closed pane keeps its name and a cache of each log's parsed turns (parsed/)
so a rebuild parses only the logs that changed. Like Claude's own logs, everything it
writes is readable by the owner alone.

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
import bisect
import contextlib
import fcntl
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))  # python -I leaves the script's folder off the path
import tool_steps  # noqa: E402

TEMPLATE = HERE / "template.html"
LIVE_SCRIPT = HERE / "live.js"
HOSTED_SCRIPT = HERE / "hosted.js"
PINS_SCRIPT = HERE / "pins.js"
PICKER_SCRIPT = HERE / "picker.js"
SENDONCE_SCRIPT = HERE / "sendonce.js"
UNDOSEND_SCRIPT = HERE / "undosend.js"
ATTACH_SCRIPT = HERE / "attach.js"
COMMENTKEY_SCRIPT = HERE / "commentkey.js"
SELECTCOPY_SCRIPT = HERE / "selectcopy.js"
ASKS_SCRIPT = HERE / "asks.js"
FIND_SCRIPT = HERE / "find.js"
STEPS_SCRIPT = HERE / "steps.js"
DOCFILES_SCRIPT = HERE / "docfiles.js"
ADDRESS_SCRIPT = HERE / "address.js"
MARKDOWN_SCRIPT = HERE / "markdown.js"
MARKDOWN_IT_SCRIPT = HERE / "vendor" / "markdown-it.min.js"  # vendored, see vendor/README.md
SEAL_SCRIPT = HERE / "seal.js"
DEFAULT_OUT = HERE.parent / "out" / "prototype.html"
HTML_FILES = "html-files.json"  # beside the page: id -> path of each HTML file it offers to open (api.js reads it)
IMAGE_FILES = "image-files.json"  # the same for each image file it offers to show (api.js reads it)
MD_FILES = "md-files.json"  # the same for each markdown file it lists without its text, which the page asks for when it opens one (api.js reads it)
STEP_OUTPUTS = "steps"  # beside the page: one <conversation id>.json of each conversation's tool output, which the page asks the server for when a step opens (api.js reads it)
# Where Claude keeps its session logs. PMOS_READER_PROJECTS names another folder laid out the same way, for a test or a measurement
# that must not touch the real logs.
PROJECTS = Path(os.environ["PMOS_READER_PROJECTS"]) if os.environ.get("PMOS_READER_PROJECTS") else Path.home() / ".claude" / "projects"
DEFAULT_PROJECTS = Path.home() / ".claude" / "projects"
# Codex stores one rollout JSONL per session. The optional override keeps parser tests and isolated labs away from a real home.
CODEX_SESSIONS = Path(os.environ["PMOS_READER_CODEX_SESSIONS"]) if os.environ.get("PMOS_READER_CODEX_SESSIONS") else Path.home() / ".codex" / "sessions"
# The Copilot CLI keeps one folder per session under <home>/session-state/<session id>/, whose events.jsonl is the conversation. The
# optional override keeps parser tests and isolated labs away from a real home.
COPILOT_HOME = Path(os.environ["PMOS_READER_COPILOT_HOME"]) if os.environ.get("PMOS_READER_COPILOT_HOME") else Path.home() / ".copilot"
COPILOT_EVENTS = "events.jsonl"
MAIN_HOME = Path.home() / "fm-homes" / "pmos"
SESSION_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CODEX_ROLLOUT_RE = re.compile(r"^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$")


# ---------------------------------------------------------------- input files

def read_jsonl(path: Path) -> list[dict]:
    """Every parseable line. A live log can end mid-line, so bad lines are skipped."""
    return list(iter_jsonl(path))


def iter_jsonl(path: Path):
    """The records of read_jsonl, one at a time, so a large log is never held whole."""
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
                yield value


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
        elif isinstance(block, dict) and block.get("type") in ("text", "input_text", "output_text"):
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

def turn_id(record: dict, text: str) -> str:
    """The id of the turn a record starts: the session log's own record id, which never changes, so a
    pin on the turn's message holds however the page is rebuilt or the turns move. A record without a
    usable one (none seen) gets a hash of its time and opening words instead."""
    uid = record.get("uuid")
    if isinstance(uid, str) and re.fullmatch(r"[0-9A-Za-z_-]{8,64}", uid):
        return uid
    return "t" + hashlib.sha1(f"{record.get('timestamp')}|{text[:200]}".encode("utf-8")).hexdigest()[:24]


def new_exchange(source, kind, label, text, timestamp, absorbed=False, uid=None):
    return {
        "source": source, "kind": kind, "label": label, "input": text,
        "at": iso_to_epoch(timestamp), "absorbed": absorbed, "uid": uid,
        "events": [], "tools": 0, "texts": 0, "notices": [],
    }


def session_exchanges(records: list[dict]) -> list[dict]:
    """Split a session into exchanges: one input and the replies that answer it.

    A captain or firstmate message that arrives while the agent is busy is
    recorded as a queued_command attachment inside the running turn. It starts a
    new exchange at that point, so the reply after it reads as its answer.
    """
    exchanges: list[dict] = []
    current = None
    calls: dict[str, dict] = {}  # tool_use id -> its step, so a result finds it even once a message has started another turn
    for record in records:
        kind = record.get("type")
        if kind == "user" and is_tool_result(record):
            for block in (record.get("message") or {}).get("content") or []:
                step = calls.get(block.get("tool_use_id")) if isinstance(block, dict) and block.get("type") == "tool_result" else None
                if step is not None:
                    tool_steps.apply_result(step, block)  # message.content only; the record's toolUseResult is never read
        elif kind == "user":
            text = block_text((record.get("message") or {}).get("content"))
            if not text.strip():
                continue
            origin = record.get("origin") or {}
            peer = peer_input(origin)
            source, sub, label = peer or classify_input(text, origin.get("kind"), bool(record.get("isMeta")))
            if source == "session" and sub == "command-output":
                continue
            text = peer_text(origin, text) if peer else text
            current = new_exchange(source, sub, label, clean_input(text), record.get("timestamp"), uid=turn_id(record, text))
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
            current = new_exchange(source, sub, label, clean_input(text), record.get("timestamp"), absorbed=True, uid=turn_id(record, text))
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
                    current["texts"] += 1
                elif block.get("type") == "tool_use":
                    current["events"].append(("tool", block.get("name") or "tool", None))
                    current["tools"] += 1
                    step = tool_steps.make_step(block, iso_to_epoch(record.get("timestamp")), current["texts"])
                    current.setdefault("steps", []).append(step)
                    if isinstance(block.get("id"), str):
                        calls[block["id"]] = step
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


def codex_record_text(content) -> str:
    """Text from a Codex response item, without reasoning ciphertext or tool payloads."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") in ("input_text", "output_text", "text"):
            parts.append(str(block.get("text") or ""))
    return "\n".join(part for part in parts if part)


def codex_summary_text(summary) -> str:
    """Plain working-note text in a Codex reasoning summary, if a rollout has one."""
    if isinstance(summary, str):
        return summary
    if not isinstance(summary, list):
        return ""
    parts = []
    for item in summary:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            parts.append(str(item.get("text") or item.get("summary_text") or ""))
    return "\n".join(part for part in parts if part)


def codex_tool_input(value) -> dict:
    """Make Codex's JSON-string tool input look like the existing tool-step input."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = None
        return parsed if isinstance(parsed, dict) else {"command": value}
    return {}


def codex_output_text(value) -> str:
    """Extract visible custom-tool output while ignoring structured metadata."""
    if isinstance(value, dict):
        return codex_record_text(value.get("content")) or codex_record_text(value.get("output"))
    return codex_record_text(value)


def codex_session_exchanges(records) -> list[dict]:
    """Split a Codex rollout into the reader's existing exchange model.

    Only plaintext response items are read. Event-message duplicates and encrypted
    reasoning content are deliberately ignored.
    """
    exchanges: list[dict] = []
    current = None
    calls: dict[str, dict] = {}
    for record in records:
        if record.get("type") != "response_item":
            continue
        payload = record.get("payload") or {}
        kind = payload.get("type")
        timestamp = record.get("timestamp") or payload.get("timestamp")
        if kind == "message":
            role = payload.get("role")
            text = codex_record_text(payload.get("content"))
            if not text.strip():
                continue
            if role == "user":
                source, sub, label = classify_input(text, None, False)
                current = new_exchange(source, sub, label, clean_input(text), timestamp,
                                       uid=turn_id({"uuid": payload.get("id")}, text))
                current["signal_task"] = signal_task(text) if source == "wake" else None
                exchanges.append(current)
            elif role == "assistant" and current is not None:
                current["events"].append(("text", text, iso_to_epoch(timestamp)))
                current["texts"] += 1
        elif kind == "reasoning" and current is not None:
            text = codex_summary_text(payload.get("summary"))
            if text.strip():
                current["events"].append(("text", text, iso_to_epoch(timestamp)))
                current["texts"] += 1
        elif kind == "custom_tool_call" and current is not None:
            call_id = payload.get("call_id") or payload.get("id")
            block = {"name": "Bash" if payload.get("name") == "exec" else payload.get("name") or "tool",
                     "input": codex_tool_input(payload.get("input")), "id": call_id}
            current["events"].append(("tool", block["name"], None))
            current["tools"] += 1
            step = tool_steps.make_step(block, iso_to_epoch(timestamp), current["texts"])
            current.setdefault("steps", []).append(step)
            if isinstance(call_id, str):
                calls[call_id] = step
        elif kind == "custom_tool_call_output":
            step = calls.get(payload.get("call_id"))
            if step is not None:
                tool_steps.apply_result(step, {"content": codex_output_text(payload.get("output")),
                                                "is_error": payload.get("status") == "failed"})
    for exchange in exchanges:
        finish_exchange(exchange)
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


# Copilot's tool names, in the words of the Claude tool each one is drawn as (tool_steps.KINDS).
COPILOT_TOOLS = {"bash": "Bash", "read_bash": "BashOutput", "stop_bash": "KillShell", "view": "Read", "rg": "Grep", "glob": "Glob",
                 "web_fetch": "WebFetch", "tool_search_tool": "ToolSearch", "skill": "Skill", "task": "Agent", "ask_user": "AskUserQuestion"}
COPILOT_HEADING = re.compile(r"^\*\*(.+?)\*\*[ \t]*$", re.M)


def copilot_thought_text(value) -> str:
    """A Copilot reasoning summary as a plain working note: its bold heading lines lose their asterisks (a note is drawn as plain text)."""
    return COPILOT_HEADING.sub(r"\1", value).strip() if isinstance(value, str) else ""


def copilot_tool_blocks(name, arguments, cwd: str = "") -> list[dict]:
    """The tool_use blocks (name and input in a Claude call's words) of one Copilot tool call, so tool_steps draws them as it does a
    Claude step. A patch is one call that touches several files, so it makes one block for each."""
    name = str(name or "tool")
    if name == "apply_patch":
        return tool_steps.patch_blocks(arguments if isinstance(arguments, str) else "", cwd) or [{"name": name, "input": {}}]
    args = arguments if isinstance(arguments, dict) else {}

    def text(key: str) -> str:
        value = args.get(key)
        return str(value) if isinstance(value, (str, int, float)) and not isinstance(value, bool) else ""

    paths = [path for path in (args.get("paths") if isinstance(args.get("paths"), list) else []) if isinstance(path, str) and path]
    # A search may name several places and a glob; the step shows one. If any of them is a dotfile or a credential path, that one is
    # shown, so make_step hides the step's output as it does for Claude's search of such a path.
    where = next((path for path in [*paths, text("glob")] if path and tool_steps.sensitive_path(path)), paths[0] if paths else "")
    mapped = COPILOT_TOOLS.get(name)
    if mapped == "Bash":
        tool_input = {"command": text("command"), "description": text("description")}
    elif mapped == "BashOutput":
        tool_input = {"bash_id": text("shellId")}
    elif mapped == "KillShell":
        tool_input = {"shell_id": text("shellId")}
    elif mapped == "Read":
        tool_input = {"file_path": text("path")}
    elif mapped in ("Grep", "Glob"):
        tool_input = {"pattern": text("pattern"), **({"path": where} if where else {})}
    elif mapped == "WebFetch":
        tool_input = {"url": text("url")}
    elif mapped == "ToolSearch":
        tool_input = {"query": text("query")}
    elif mapped == "Skill":
        tool_input = {"skill": text("skill")}
    elif mapped == "Agent":
        tool_input = {"description": text("description") or text("name"), "subagent_type": text("agent_type"), "prompt": text("prompt")}
    elif mapped == "AskUserQuestion":
        tool_input = {"questions": [{"question": text("message")}]}
    else:
        return [{"name": name, "input": args}]
    return [{"name": mapped, "input": tool_input}]


def copilot_session_exchanges(records) -> list[dict]:
    """Split a Copilot CLI session (its events.jsonl) into the reader's existing exchange model.

    What is read: `user.message` (the typed text, never `transformedContent`, which wraps it in the date and any skill's text),
    `assistant.message` (its content, its plaintext `reasoningText` and its `toolRequests`), `tool.execution_start` and
    `tool.execution_complete` (a call the message did not request, and every call's result) and `session.compaction_complete`.
    Everything else (hooks, usage, the system prompt, permission records, `reasoningOpaque` and `encryptedContent`) is never
    looked at. A helper agent's own events carry an `agentId`, and its prompt and replies stay out: the conversation holds
    the `task` call that ran it and that call's result.

    A message sent while the agent was busy has `delivery: "steering"` and starts an absorbed exchange. A reasoning summary is a
    working note only when a tool call follows it in the turn; the one that comes before the final answer is not part of it.
    """
    exchanges: list[dict] = []
    current = None
    calls: dict[str, list[dict]] = {}  # tool call id -> its steps (a patch has one for each file), so a result finds them
    cwd = ""

    def add_call(call_id, name, arguments, at, turn) -> None:
        if turn is None or not isinstance(call_id, str) or call_id in calls:
            return
        steps = []
        for block in copilot_tool_blocks(name, arguments, turn.get("cwd") or cwd):
            turn["events"].append(("tool", block["name"], None))
            turn["tools"] += 1
            step = tool_steps.make_step(block, at, turn["texts"])
            step["n"] = str(name or "tool")  # the step sheet names the tool as Copilot's log has it
            turn.setdefault("steps", []).append(step)
            steps.append(step)
            turn.setdefault("touched", []).extend(tool_documents(block.get("input"), turn.get("cwd") or cwd))
        calls[call_id] = steps

    for record in records:
        data = record.get("data")
        if record.get("agentId") or not isinstance(data, dict) or data.get("parentToolCallId"):
            continue
        kind = record.get("type")
        timestamp = record.get("timestamp")
        at = iso_to_epoch(timestamp)
        if kind in ("session.start", "session.resume"):
            where = (data.get("context") or {}).get("cwd") if isinstance(data.get("context"), dict) else None
            if isinstance(where, str) and where:
                cwd = where
        elif kind == "user.message":
            text = data.get("content")
            if not isinstance(text, str) or not text.strip():
                continue
            source, sub, label = classify_input(text, None, False)
            current = new_exchange(source, sub, label, clean_input(text), timestamp, absorbed=data.get("delivery") == "steering" and current is not None,
                                   uid=turn_id({"uuid": data.get("messageId")}, text))
            current["signal_task"] = signal_task(text) if source == "wake" else None
            if cwd:
                current["cwd"] = cwd
            exchanges.append(current)
        elif kind == "assistant.message" and current is not None:
            thought = copilot_thought_text(data.get("reasoningText"))
            if thought:
                current["events"].append(("thought", thought, at))
                current["texts"] += 1
            content = data.get("content")
            if isinstance(content, str) and content.strip():
                current["events"].append(("text", content, at))
                current["texts"] += 1
            for request in data.get("toolRequests") or []:
                if isinstance(request, dict):
                    add_call(request.get("toolCallId"), request.get("name"), request.get("arguments"), at, current)
        elif kind == "tool.execution_start":
            add_call(data.get("toolCallId"), data.get("toolName"), data.get("arguments"), at, current)
        elif kind == "tool.execution_complete":
            steps = calls.get(data.get("toolCallId"))
            if not steps:
                continue
            result = data.get("result") if isinstance(data.get("result"), dict) else {}
            error = data.get("error") if isinstance(data.get("error"), dict) else {}
            shell = data.get("shellExecution") if isinstance(data.get("shellExecution"), dict) else {}
            exit_code = shell.get("exitCode")
            failed = data.get("success") is False or (isinstance(exit_code, int) and exit_code != 0)
            output = result.get("content") if isinstance(result.get("content"), str) else ""
            for step in steps:
                tool_steps.apply_result(step, {"content": output or str(error.get("message") or ""), "is_error": failed})
        elif kind == "session.compaction_complete" and data.get("success") is not False:
            divider = new_exchange("session", "compacted", "Earlier context was summarised", "", timestamp)
            exchanges.append(divider)  # the turn that was running goes on after it, so it stays the current one
    for exchange in exchanges:
        # A reasoning summary that no tool call follows led to the final answer, not to a step.
        events = exchange["events"]
        last_tool = max((i for i, event in enumerate(events) if event[0] == "tool"), default=-1)
        exchange["events"] = [("text", *event[1:]) if event[0] == "thought" else event
                              for i, event in enumerate(events) if event[0] != "thought" or i < last_tool]
        finish_exchange(exchange)
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


def finish_exchange(exchange: dict) -> None:
    events = exchange.pop("events")
    exchange.pop("texts", None)
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


_OTHER_HOMES: dict[tuple, tuple[float, list[Path]]] = {}


def other_claude_homes() -> list[Path]:
    """The folders Claude Code keeps its sessions in besides ~/.claude: one per CLAUDE_CONFIG_DIR a person runs it under (a second
    account is often ~/.claude-personal or ~/.claude-work). A folder named ~/.claude<anything> counts when it holds a projects/ or
    sessions/ folder, which only a Claude config folder does (a plain file such as ~/.claude.json, or a tool's own ~/.claude-xyz
    folder, has neither); so does the folder CLAUDE_CONFIG_DIR names for this process, and each of PMOS_READER_CLAUDE_HOMES (absolute
    paths separated like PATH) for a place outside the home folder. No folder's name is known here: a new account is found by the
    next look. api.js's otherClaudeHomes finds the same ones. The answer is reused for LOG_LIST_REUSE seconds, as the list of logs is
    (a build asks for the logs' folders thousands of times)."""
    home = Path.home()
    asked = (home, os.environ.get("CLAUDE_CONFIG_DIR", ""), os.environ.get("PMOS_READER_CLAUDE_HOMES", ""))
    memo = _OTHER_HOMES.get(asked)
    if memo and time.monotonic() - memo[0] < LOG_LIST_REUSE:
        return memo[1]
    primary = home / ".claude"
    found: list[Path] = []

    def add(folder: Path) -> None:
        if folder.is_absolute() and folder != primary and folder not in found and ((folder / "projects").is_dir() or (folder / "sessions").is_dir()):
            found.append(folder)

    try:
        for entry in sorted(home.iterdir(), key=lambda item: item.name):
            if entry.name.startswith(".claude"):
                add(entry)
    except OSError:
        pass
    for named in (os.environ.get("CLAUDE_CONFIG_DIR", ""), *os.environ.get("PMOS_READER_CLAUDE_HOMES", "").split(os.pathsep)):
        if named:
            add(Path(named))
    _OTHER_HOMES.clear()
    _OTHER_HOMES[asked] = (time.monotonic(), found)
    return found


def project_roots() -> list[Path]:
    """Every folder of Claude session logs: PROJECTS, then the projects/ of each other Claude config folder. A PROJECTS that
    something else points at (PMOS_READER_PROJECTS, a test) is read alone, as it always was."""
    if PROJECTS != DEFAULT_PROJECTS:
        return [PROJECTS]
    return [PROJECTS, *(home / "projects" for home in other_claude_homes())]


def project_folder(home: Path) -> list[Path]:
    """The folders (one per Claude config folder) that hold the logs of sessions run in <home>."""
    return [root / re.sub(r"[^A-Za-z0-9]", "-", str(home)) for root in project_roots()]


def canonical_session_id(value: str) -> str | None:
    """Return a native session id, including when Codex reported its rollout filename or a Copilot events.jsonl was named."""
    if SESSION_ID_RE.fullmatch(value):
        return value
    named = Path(value)
    if named.name == COPILOT_EVENTS and SESSION_ID_RE.fullmatch(named.parent.name):
        return named.parent.name
    match = CODEX_ROLLOUT_RE.fullmatch(named.name)
    return match.group(1) if match else None


def log_key(path: Path) -> str:
    """What a session log is called: its file name without the suffix, except that every Copilot conversation is an events.jsonl
    inside a folder named for the session, so that folder's name is the key."""
    return path.parent.name if path.name == COPILOT_EVENTS and SESSION_ID_RE.fullmatch(path.parent.name) else path.stem


def log_session_id(path: Path) -> str:
    """The native session id of a log: a Claude log's own name, a Codex rollout's id, a Copilot session's folder name."""
    key = log_key(path)
    return canonical_session_id(key) or key


_CODEX_INDEX: tuple[float, Path, list[Path], dict[str, Path], dict[str, Path]] | None = None


def codex_metadata(path: Path) -> dict | None:
    """The first-line identity of a native Codex rollout, without reading its transcript."""
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            record = json.loads(handle.readline())
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict):
        return None
    payload = record.get("payload") or {}
    if not isinstance(payload, dict):
        return None
    if record.get("type") != "session_meta" or payload.get("source") != "cli":
        return None
    session = payload.get("id") or payload.get("session_id")
    cwd = payload.get("cwd")
    if not isinstance(session, str) or not SESSION_ID_RE.fullmatch(session) or not isinstance(cwd, str) or not cwd:
        return None
    return {"session": session, "cwd": os.path.realpath(cwd), "timestamp": record.get("timestamp") or ""}


def codex_log_index() -> tuple[list[Path], dict[str, Path], dict[str, Path]]:
    """Native Codex rollouts by session id and working directory, newest first."""
    global _CODEX_INDEX
    now = time.monotonic()
    if _CODEX_INDEX and _CODEX_INDEX[1] == CODEX_SESSIONS and now - _CODEX_INDEX[0] < LOG_LIST_REUSE:
        return _CODEX_INDEX[2:]
    logs, by_id, by_cwd = [], {}, {}
    try:
        candidates = sorted(CODEX_SESSIONS.rglob("rollout-*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
    except OSError:
        candidates = []
    for path in candidates:
        metadata = codex_metadata(path)
        if not metadata:
            continue
        logs.append(path)
        by_id.setdefault(metadata["session"], path)
        by_cwd.setdefault(metadata["cwd"], path)
    _CODEX_INDEX = (now, CODEX_SESSIONS, logs, by_id, by_cwd)
    return logs, by_id, by_cwd


def codex_session_files(prefix: str = "") -> list[Path]:
    """Codex rollout files whose native session id starts with <prefix>."""
    return sorted(path for session, path in codex_log_index()[1].items() if session.startswith(prefix))


def is_codex_log(path: Path) -> bool:
    """Whether <path> is a native Codex rollout accepted by the reader."""
    return codex_metadata(path) is not None


_COPILOT_INDEX: tuple[float, Path, list[Path], dict[str, Path]] | None = None


def copilot_metadata(path: Path) -> dict | None:
    """The identity of a Copilot session's events.jsonl, from its first record (session.start) and without reading the conversation."""
    if path.name != COPILOT_EVENTS or not SESSION_ID_RE.fullmatch(path.parent.name):
        return None
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            record = json.loads(handle.readline())
    except (OSError, json.JSONDecodeError):
        return None
    data = record.get("data") if isinstance(record, dict) else None
    if not isinstance(data, dict) or record.get("type") != "session.start" or data.get("sessionId") != path.parent.name:
        return None
    context = data.get("context") if isinstance(data.get("context"), dict) else {}
    cwd = context.get("cwd")
    return {"session": path.parent.name, "cwd": os.path.realpath(cwd) if isinstance(cwd, str) and cwd else "", "timestamp": record.get("timestamp") or ""}


def is_copilot_log(path: Path) -> bool:
    """Whether <path> is the events.jsonl of a Copilot CLI session the reader accepts."""
    return copilot_metadata(path) is not None


def copilot_log_index() -> tuple[list[Path], dict[str, Path]]:
    """Copilot sessions' events.jsonl files and each one by its session id, newest first."""
    global _COPILOT_INDEX
    now = time.monotonic()
    state = COPILOT_HOME / "session-state"
    if _COPILOT_INDEX and _COPILOT_INDEX[1] == state and now - _COPILOT_INDEX[0] < LOG_LIST_REUSE:
        return _COPILOT_INDEX[2:]
    logs, by_id = [], {}
    try:
        candidates = sorted(state.glob(f"*/{COPILOT_EVENTS}"), key=lambda path: path.stat().st_mtime, reverse=True)
    except OSError:
        candidates = []
    for path in candidates:
        metadata = copilot_metadata(path)
        if metadata:
            logs.append(path)
            by_id.setdefault(metadata["session"], path)
    _COPILOT_INDEX = (now, state, logs, by_id)
    return logs, by_id


def copilot_session_files(prefix: str = "") -> list[Path]:
    """Copilot events.jsonl files whose session id starts with <prefix>."""
    return sorted(path for session, path in copilot_log_index()[1].items() if session.startswith(prefix))


def find_session_file(session: str) -> Path | None:
    candidate = Path(session).expanduser()
    if candidate.is_file():
        return candidate
    canonical = canonical_session_id(session) or session
    return log_index()[1].get(canonical) or codex_log_index()[1].get(canonical) or copilot_log_index()[1].get(canonical)


def home_sessions(home: Path, since: float, limit: int = 4) -> list[Path]:
    """The home's current session (from its lock), then earlier ones in its own folder
    written to inside the window, newest first."""
    found: list[Path] = []
    lock = home / "state" / ".lock-session"
    if lock.is_file():
        current = find_session_file(lock.read_text().strip())
        if current:
            found.append(current)
    own = [path for folder in project_folder(home) if folder.is_dir() for path in folder.glob("*.jsonl")]
    for path in sorted(own, key=lambda p: p.stat().st_mtime, reverse=True):
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


# The fleet timeline is built and shown only when this is set to on (1, on, true or yes) in the environment that runs the build;
# unset, the build skips collecting the fleet records and the page hides the tab. Everything the timeline is made of stays in place.
FLEET_TIMELINE_ENV = "PMOS_READER_FLEET_TIMELINE"


def fleet_timeline_on() -> bool:
    return os.environ.get(FLEET_TIMELINE_ENV, "").strip().lower() in {"1", "on", "true", "yes"}


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

def chain_exchanges(chain: list[Path], loaded: dict[Path, dict]) -> list[dict]:
    """The turns of a pane's sessions (each a parsed_log), oldest first, with a divider at
    each session change.

    The pane's newest session no longer holds a reply from an earlier session (marked
    from_session) or from before its own last compaction (marked compacted_away), so a
    message about such a reply has to say what it read.
    """
    path = chain[-1]
    exchanges = []
    for member in chain:
        part = loaded[member]["exchanges"]
        if len(chain) > 1:
            ended = member != path
            after = chain[chain.index(member) + 1] if ended else None
            how = "cleared later" if after and cleared_at(head_records(after)) is not None else "until Claude restarted"
            label = f"Session {log_key(member)[:8]}" + (f", {how}; replies go to the newest" if ended else ", the newest in this pane")
            divider = new_exchange("session", "cleared" if ended else "current", label, "", None)
            divider["at"] = loaded[member]["first_time"]
            finish_exchange(divider)
            part.insert(0, divider)
            if ended:
                for exchange in part[1:]:
                    exchange["from_session"] = log_key(member)
        if member == path:
            mark_compacted_away(part)
        exchanges += part
    return exchanges


def mark_compacted_away(exchanges: list[dict]) -> None:
    """Mark the replies before a session's last compaction: it holds only a summary of them."""
    last = max((i for i, exchange in enumerate(exchanges) if exchange["kind"] == "compacted"), default=0)
    for exchange in exchanges[:last]:
        if exchange["reply"]:
            exchange["compacted_away"] = True


def fleet_homes(main_home: str | Path, extra: list[str] | None = None) -> tuple[list[dict], dict[str, Path]]:
    """The homes to read: the main home, then <extra> or every second mate its registry lists;
    and each second mate's parent home, whose state folder may hold the inbox a doorbell names."""
    homes = [{"id": "main", "home": Path(main_home).expanduser()}]
    if extra:
        homes += [{"id": Path(h).expanduser().name if Path(h).name != "firstmate" else Path(h).parent.name, "home": Path(h).expanduser()} for h in extra]
    else:
        homes += registered_secondmates(homes[0]["home"])
    return homes, {mate["id"]: homes[0]["home"] for mate in homes[1:]}


def thread_session(home: dict, chain: list[Path], loaded: dict[Path, dict], parent: Path | None) -> dict:
    """One conversation as the page shows it: the turns of a pane's sessions (each a parsed_log,
    oldest first), with the steering messages and task instructions they delivered, under the
    newest session's id."""
    path = chain[-1]
    exchanges = chain_exchanges(chain, loaded)
    attach_inbox_bodies(exchanges, [h for h in (home["home"], parent) if h])
    cwd = loaded[path]["cwd"]
    where = Path(cwd).relative_to(home["home"]).as_posix() if cwd.startswith(str(home["home"]) + "/") else ""
    if where.startswith("state/.treehouse/"):
        where = "worker copy"  # a worker's isolated copy, not the home's own clone
    session_id = log_session_id(path)
    ids = [log_session_id(member) for member in chain]
    session = {"home": home["id"], "id": session_id, "ids": ids, "file": str(path), "where": where,
               "exchanges": exchanges}
    if is_copilot_log(path):
        session["agent"] = "copilot"  # the page turns Send off for it: only Claude and Codex panes can be sent to
    leader = leader_info(cwd)
    if leader:
        session["leader"] = leader
    mark_asks(exchanges)
    return session


# ------------------------------------------------- which asks still wait on you
#
# A reply that asks is open only while nothing from you came after it. Once you wrote anything later
# the ask goes quiet (still drawn, no longer yellow); once you answered it, by a Reply pointer or a
# keyed line (the answer sheet types one), it is settled. A later message that points at nothing and
# answers no key leaves the ask quiet, never settled: quiet is a safe error, a wrong "settled" is not.

# "Re your reply at 09:04", "Re your reply at Mon 3 Nov 09:04" (live.js pointer()), then ` ("opening words"`.
POINTER = re.compile(
    r"Re your reply at (?:(?P<weekday>[A-Z][a-z]{2,3}),? (?P<day>\d{1,2}) (?P<month>[A-Z][a-z]{2,3}) )?(?P<hour>\d{2}):(?P<minute>\d{2})"
    r"(?: \(\"(?P<opening>.*?)\"\))?"
)
KEY_ANSWER = re.compile(r"\b([A-Z][0-9]{1,2})\s*=\s*([^;\n]*)")
KEY_ASKED = re.compile(r"\b([A-Z][0-9]{1,2})\s*=")


def reply_opening(reply: str, limit: int = 60) -> str:
    """The words a Reply pointer quotes for a reply: its first line with markup stripped, clipped (live.js pointer())."""
    first = next((re.sub(r"[*`_]", "", re.sub(r"^[\s#>*\-\d.)|]+", "", line)).strip() for line in reply.splitlines()
                  if re.sub(r"^[\s#>*\-\d.)|]+", "", line).strip()), "")
    first = re.sub(r"\s+", " ", re.sub(r"[`$\\]", "", first)).strip()
    return first if len(first) <= limit else first[: limit - 1].rstrip() + "…"


def pointer_matches(exchange: dict, pointer: re.Match, sent_at: float | None, local: dict | None = None) -> bool:
    """Whether a Reply pointer names this exchange's reply: the same minute (and day, when the pointer says one;
    otherwise the day the message was sent), and the quoted opening words when it quotes any. <local> keeps the local time of each
    reply asked about, for a caller that asks about every reply once for each pointer."""
    at = exchange["reply_at"] or exchange["at"]
    if not exchange["reply"] or not at:
        return False
    if local is None:
        when = time.localtime(at)
    else:
        when = local.get(at)
        if when is None:
            when = local[at] = time.localtime(at)
    if (when.tm_hour, when.tm_min) != (int(pointer["hour"]), int(pointer["minute"])):
        return False
    if pointer["day"]:
        if (when.tm_mday, time.strftime("%b", when)) != (int(pointer["day"]), pointer["month"][:3]):
            return False
    elif sent_at is not None and time.localtime(sent_at)[:3] != when[:3]:
        return False  # no day means the reply was from the day it was sent
    quoted = pointer["opening"]
    return quoted is None or reply_opening(exchange["reply"]).startswith(quoted.rstrip("…").strip()[:40])


def pointed_at(exchanges: list[dict], index: int, pointer: re.Match, local: dict | None = None) -> dict | None:
    """The one earlier reply a pointer names, or None when it names none or cannot tell two apart."""
    sent_at = exchanges[index]["at"]
    found = [e for e in exchanges[:index] if pointer_matches(e, pointer, sent_at, local)]
    return found[0] if len(found) == 1 else None


def asked_keys(reply: str) -> set[str]:
    """The answer keys a reply asks for: its open cards (the answer sheet's) and the keys on its "reply with" line."""
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))  # python -I leaves the script's folder off the path
    from build_questionnaire import parse_questionnaire  # it imports this module, so only here
    keys: set[str] = set()
    questionnaire = parse_questionnaire(reply)
    if questionnaire:
        keys |= {card["key"] for card in questionnaire["cards"]}
        keys |= set(KEY_ASKED.findall(questionnaire["reply_line"]))
    else:
        for line in reply.splitlines():
            if re.search(r"\breply with\b", line, re.I):
                keys |= set(KEY_ASKED.findall(line))
    return keys


def answered_keys(text: str) -> set[str]:
    """The keys a message of yours answers (`A1=accept;A2=inline`). A key with no value, or the format's own
    placeholder (`A1=...`), answers nothing."""
    return {key for key, value in KEY_ANSWER.findall(text) if value.strip().strip(".…")}


def settle(exchange: dict, how: str, answer: dict) -> None:
    if exchange.get("ask_state") == "quiet":
        exchange.update(ask_state="settled", settled_by=how, answered_at=answer["at"])


def mark_asks(exchanges: list[dict]) -> None:
    """Give each reply that needs you an ask_state: open (nothing from you after it), quiet (you wrote
    something later that did not answer it) or settled (you answered it; settled_by says how). Replies that
    do not need you get none. Recomputed from the turns each time, never cached with the parsed log."""
    mine = [i for i, e in enumerate(exchanges) if e["source"] == "captain"]
    local: dict = {}  # the local time of each reply, which every pointer of every later message is checked against
    for index, exchange in enumerate(exchanges):
        for field in ("ask_state", "settled_by", "answered_at"):
            exchange.pop(field, None)
        if exchange["verdict"] == "needs-you":
            exchange["ask_state"] = "quiet" if any(m > index for m in mine) else "open"
    for later in mine:
        answer = exchanges[later]
        for pointer in POINTER.finditer(answer["input"]):
            target = pointed_at(exchanges, later, pointer, local)
            if target:
                settle(target, "reply", answer)
        remaining = answered_keys(answer["input"])
        asked: dict[int, set[str]] = {}
        # Each key answers the nearest earlier reply that asked it, so a later round that asks the same
        # key again takes the answer and an earlier round is settled only by keys it alone asked.
        for earlier in range(later - 1, -1, -1):
            if not remaining:
                break
            reply = exchanges[earlier]["reply"]
            if not reply or not any(key in reply for key in remaining):
                continue
            keys = asked.setdefault(earlier, asked_keys(reply)) & remaining
            if keys:
                settle(exchanges[earlier], "keyed", answer)
                remaining -= keys


def clip_words(text: str, limit: int) -> str:
    """One line of at most <limit> characters, markdown emphasis dropped; code spans stay (the page draws them) unless the cut left one open."""
    text = re.sub(r"\s+", " ", text.replace("**", "")).strip()
    if len(text) > limit:
        cut = text[: limit - 1]
        text = (cut.rsplit(" ", 1)[0] if " " in cut[limit // 2:] else cut).rstrip(" ,;:-") + "…"
    return text.replace("`", "") if text.count("`") % 2 else text


def sheet_cards(questionnaire: dict) -> list[dict]:
    """The open cards of a reply's answer sheet, as the reply's ask box lists them: key, question, and the
    recommended default when the card names one."""
    cards = []
    for card in questionnaire["cards"][:8]:
        recommended = next((o["value"] for o in card["options"] if o["recommended"]), "") or card["recommended"]
        cards.append({"key": card["key"], "q": clip_words(card["question"], 140),
                      **({"rec": clip_words(recommended, 80)} if recommended.strip() else {})})
    return cards


def mark_sheets(sessions: list[dict]) -> None:
    """A reply that asks for keyed answers links to the answer sheet, which opens on it."""
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))  # python -I leaves the script's folder off the path
    from build_questionnaire import parse_questionnaire  # it imports this module, so only here
    for session in sessions:
        for exchange in session["exchanges"]:
            questionnaire = parse_questionnaire(exchange["reply"]) if exchange["reply"] else None
            if questionnaire:
                exchange["sheet"] = f"{session['id'][:8]}:{round(exchange['reply_at'] or exchange['at'] or 0)}"
                exchange["sheet_cards"] = sheet_cards(questionnaire)


def build(args) -> dict:
    # The build time is taken before any log is read, so a turn written while this build runs
    # leaves its log newer than the stamp and the server rebuilds again.
    started = time.time()
    homes, parent_of = fleet_homes(args.main_home, args.home)

    # (home, session file, parsed log) for every session to show.
    out_dir = Path(args.out).expanduser().parent
    cache = out_dir / "parsed"
    chosen = []
    listed = bool(args.session or args.listed)
    if listed:
        for name in args.session or []:
            path = find_session_file(name)
            if not path:
                raise SystemExit(f"session not found: {name}")
            log = parsed_log(path, cache)
            chosen.append((session_home(homes, log["cwd"]), path, log))
        starts = [log["first_time"] for _, _, log in chosen if log["first_time"] is not None]
        since = min(starts) if args.since_hours is None and starts else time.time() - (args.since_hours or 72) * 3600
    else:
        since = time.time() - (args.since_hours or 72) * 3600
        chosen = [(home, path, parsed_log(path, cache)) for home in homes for path in home_sessions(home["home"], since)]

    # A pane cleared with /clear, or with Claude restarted in it, goes on in a new session
    # log: read the sessions it ran as one conversation, newest last, under the newest id.
    # The pane each session ran in comes from Herdr now and the pane-label cache before.
    live = herdr_panes()
    pane_labels([], out_dir / "pane-labels.json", live)
    threads: list[tuple[dict, list[Path], dict[Path, dict]]] = []
    for home, path, log in chosen:
        if any(path in chain for _, chain, _ in threads):
            continue
        chain = session_chain(path)
        loaded = {member: (log if member == path else parsed_log(member, cache)) for member in chain}
        threads.append((home, chain, loaded))
    prune_parsed(cache)

    sessions = []
    timeline = fleet_timeline_on()
    fleet = collect_fleet(homes, since) if timeline else []
    for home, chain, loaded in threads:
        session = thread_session(home, chain, loaded, parent_of.get(home["id"]))
        sessions.append(session)
        for event in captain_events(home, session["exchanges"], since) if timeline else []:
            event["session"] = session["id"]
            fleet.append(event)
    link_turns(fleet, sessions)
    fleet.sort(key=lambda event: event["at"])
    mark_sheets(sessions)
    documents = attach_documents(sessions, html=True, images=True)
    attach_task_files(sessions, documents)
    labels = pane_labels([s["id"] for s in sessions], out_dir / "pane-labels.json", live)
    reopened = set(read_ids(out_dir / "reopened.txt"))
    for session in sessions:
        session["pane"] = labels.get(session["id"])
        session["reopened"] = bool(reopened & set(session["ids"]))
    closed = closed_panes(out_dir / "pane-labels.json", live, {sid for s in sessions for sid in s["ids"]}) if listed else []
    if listed:
        # Chosen sessions read newest activity first; the page opens on the first one.
        sessions.sort(key=lambda s: max((e["reply_at"] or e["at"] or 0) for e in s["exchanges"]) if s["exchanges"] else 0, reverse=True)
    summaries = [summary for summary in (home_summary(home) for home in homes) if summary]
    return {"generated": started, "since": since, "homes": [h["id"] for h in homes], "sessions": sessions, "fleet": fleet,
            "summaries": summaries, "chosen": listed, "documents": documents, "closed": closed, "fleet_timeline": timeline}


CLAUDE_SESSIONS = Path.home() / ".claude" / "sessions"
DEFAULT_CLAUDE_SESSIONS = CLAUDE_SESSIONS


def claude_session_dirs() -> list[Path]:
    """The folders of running Claude Code processes' records: ~/.claude/sessions and each other Claude config folder's. A
    CLAUDE_SESSIONS that something else points at (a test) is read alone."""
    if CLAUDE_SESSIONS != DEFAULT_CLAUDE_SESSIONS:
        return [CLAUDE_SESSIONS]
    return [CLAUDE_SESSIONS, *(home / "sessions" for home in other_claude_homes())]


def running_claude_sessions() -> dict[int, str]:
    """pid -> session id of every running Claude Code process, from the record each keeps
    in <its config folder>/sessions (it follows /clear and --resume): ~/.claude's and every other config folder's."""
    found = {}
    for folder in claude_session_dirs():
        for record in sorted(folder.glob("*.json")):
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


def codex_process(process: dict) -> bool:
    """Whether a foreground process is the native Codex CLI."""
    argv0 = str(process.get("argv0") or "")
    command = str(process.get("command") or process.get("cmdline") or "")
    return Path(argv0).name == "codex" or bool(re.search(r"(?:^|[/\\s])codex(?:$|[/\\s])", command))


def codex_pane_session(claimed: str | None, process_info: dict | None) -> str | None:
    """Map a live Codex pane to its native root rollout by foreground cwd."""
    if not process_info:
        return None
    processes = process_info.get("foreground_processes") or []
    for process in processes:
        if not isinstance(process, dict) or not codex_process(process):
            continue
        cwd = process.get("cwd") or process_info.get("cwd")
        if not isinstance(cwd, str) or not cwd:
            continue
        candidates = codex_log_index()[2].get(os.path.realpath(cwd))
        if candidates:
            metadata = codex_metadata(candidates)
            if metadata:
                return metadata["session"]
    return None


def copilot_process(process: dict) -> bool:
    """Whether a foreground process is the Copilot CLI (a process named copilot)."""
    command = str(process.get("command") or process.get("cmdline") or "").split(None, 1)
    return Path(str(process.get("argv0") or "")).name == "copilot" or bool(command and Path(command[0]).name == "copilot")


# A Copilot process writes `<time> [INFO] Registering foreground session: <id>` to its own log when it starts on a session and again at
# each /resume and /new, so the newest such line names the session its pane shows. That log is rotated at 10 MB into
# process-<start>-<pid>.1.log (and fills thousands of lines a minute in a fault of some builds), so the line can end up in the rotated file
# or be gone. The reader therefore reads every file of the process, keeps the newest line any look saw, and writes it to
# COPILOT_PANES_FILE (a process's key is its start time and pid), which the next look, here or in api.js, reads when the logs no longer say.
COPILOT_PROCESS_LOG = re.compile(r"process-(\d+)-(\d+)(?:\.\d+)?\.log")
COPILOT_REGISTERED = re.compile(rb"(\d{4}-\d\d-\d\dT[\d:.]+Z) \[[A-Z]+\] Registering foreground session: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")
COPILOT_LOG_READ_MAX = 64 * 1024 * 1024  # a process log is read up to this much of its end, at the first look
COPILOT_PANES_FILE = DEFAULT_OUT.parent / "copilot-panes.json"
COPILOT_PANES_KEEP_DAYS = 14
_COPILOT_LOG_SCAN: dict[Path, tuple[int, int, tuple[str, str] | None]] = {}  # a process log -> (its inode, bytes read so far, its newest marker)
_COPILOT_SEEN: dict[str, tuple[str, str]] = {}  # "<start>-<pid>" -> the newest (time, session) marker any look saw


def copilot_log_marker(log: Path) -> tuple[str, str] | None:
    """(time, session id) of the newest registering line in one process log. Each look reads only what the log gained since
    the last one (and a line the last look ended in the middle of, whole)."""
    try:
        info = log.stat()
    except OSError:
        return None
    size = info.st_size
    inode, done, found = _COPILOT_LOG_SCAN.get(log, (info.st_ino, 0, None))
    if inode != info.st_ino or size < done:
        done, found = 0, None  # a rotation put another file at this name: read it from its start
    if size > done:
        start = max(0, done - 160, size - COPILOT_LOG_READ_MAX)
        try:
            with log.open("rb") as handle:
                handle.seek(start)
                data = handle.read(size - start)
        except OSError:
            return found
        for match in COPILOT_REGISTERED.finditer(data):
            marker = (match.group(1).decode(), match.group(2).decode())
            if found is None or marker >= found:
                found = marker
        _COPILOT_LOG_SCAN[log] = (info.st_ino, size, found)
    return found


def copilot_panes_read() -> dict:
    try:
        value = json.loads(COPILOT_PANES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def copilot_panes_remember(key: str, marker: tuple[str, str]) -> None:
    """Keep a process's newest marker, dropping the processes of the last COPILOT_PANES_KEEP_DAYS' older neighbours."""
    stored = copilot_panes_read()
    cutoff = (time.time() - COPILOT_PANES_KEEP_DAYS * 86400) * 1000
    stored = {k: v for k, v in stored.items() if isinstance(v, dict) and k.split("-", 1)[0].isdigit() and int(k.split("-", 1)[0]) >= cutoff}
    stored[key] = {"at": marker[0], "session": marker[1]}
    try:
        private_folder(COPILOT_PANES_FILE.parent)
        write_private(COPILOT_PANES_FILE, json.dumps(stored, indent=1, sort_keys=True))
    except OSError:
        pass


def copilot_pid_session(pid: int) -> str | None:
    """The session the Copilot process <pid> shows: the newest session its logs or an earlier look registered for it, else the session
    folder holding its inuse.<pid>.lock when that has a conversation (the lock names only the session the process started on, so a
    /resume leaves it behind). None when neither says: never guessed from a label or a folder."""
    state = COPILOT_HOME / "session-state"
    files = []
    try:
        for log in (COPILOT_HOME / "logs").iterdir():
            match = COPILOT_PROCESS_LOG.fullmatch(log.name)
            if match and int(match.group(2)) == pid:
                files.append((int(match.group(1)), log))
    except OSError:
        pass
    if files:  # the process that runs now is the latest one to have had this pid
        started = max(start for start, _ in files)
        key = f"{started}-{pid}"
        known = _COPILOT_SEEN.get(key)
        if known is None:
            stored = copilot_panes_read().get(key)
            if isinstance(stored, dict) and isinstance(stored.get("at"), str) and isinstance(stored.get("session"), str):
                known = (stored["at"], stored["session"])
        best = known
        for start, log in files:
            marker = copilot_log_marker(log) if start == started else None
            if marker and (best is None or marker > best):
                best = marker
        if best and best != known:
            copilot_panes_remember(key, best)
        if best:
            _COPILOT_SEEN[key] = best
            if SESSION_ID_RE.fullmatch(best[1]) and (state / best[1]).is_dir():
                return best[1]
    locks = []
    try:
        for lock in state.glob(f"*/inuse.{pid}.lock"):
            if SESSION_ID_RE.fullmatch(lock.parent.name) and (lock.parent / COPILOT_EVENTS).is_file():
                locks.append((lock.stat().st_mtime, lock.parent.name))
    except OSError:
        pass
    return max(locks)[1] if locks else None


def copilot_pane_session(process_info: dict | None) -> str | None:
    """Map a live Copilot pane to the session its foreground Copilot process shows, or None (never guessed from a label or a folder)."""
    if not process_info:
        return None
    for process in process_info.get("foreground_processes") or []:
        if isinstance(process, dict) and copilot_process(process) and isinstance(process.get("pid"), int):
            found = copilot_pid_session(process["pid"])
            if found:
                return found
    return None


def herdr_panes() -> dict[str, dict]:
    """Session id -> the Herdr pane running it, from every running Herdr session (see herdr_inventory)."""
    return herdr_inventory()[0]


# A pane id ("w1:p2") names one pane only within one life of a Herdr session: a session
# deleted and made again under the same name hands out the same low ids to new panes. A
# restart keeps the session's folder, and with it the panes and their ids, so the folder's
# identity marks the life. Name -> life, for every running session the last inventory read.
HERDR_LIVES: dict[str, str] = {}
# Name -> when each running Herdr session's server started (its socket's creation time), for the same sessions. A
# pane back from a Herdr restart shows no agent until Claude is started in it, so panes without one are only
# taken for stopped while the server is older than reader.HERDR_GRACE.
HERDR_STARTS: dict[str, float] = {}


def herdr_life(herdr_session: dict) -> str:
    try:
        return str(os.stat(herdr_session.get("session_dir") or "").st_ino)
    except (OSError, ValueError):
        return ""


def herdr_inventory() -> tuple[dict[str, dict], set[tuple[str, str]] | None]:
    """Session id -> the Herdr pane running it, and every pane Herdr lists, from every running Herdr session.

    The second value holds (Herdr session, pane id) of every pane, with or without an agent
    in it, so a caller can tell a pane that has closed (its id is gone: Herdr never reuses
    one within a session's life, see HERDR_LIVES) from a pane whose agent has not come back yet. It is None when a running Herdr
    session could not be read, since a pane missing from a partial list has not closed.

    Read-only: `herdr session list`, `pane list`, `tab list`, and `pane process-info` for
    Claude, Codex or Copilot panes when their identity needs checking. No Herdr, no labels.
    """
    if _FROZEN is not None and _FROZEN_PANES:
        panes, pane_ids = _FROZEN_PANES[0]
        return dict(panes), None if pane_ids is None else set(pane_ids)
    panes, pane_ids = read_herdr()
    if _FROZEN is not None:
        _FROZEN_PANES[:] = [(dict(panes), None if pane_ids is None else set(pane_ids))]
    return panes, pane_ids


def read_herdr() -> tuple[dict[str, dict], set[tuple[str, str]] | None]:
    """herdr_inventory's reading of Herdr: its commands, asked now."""
    def call(*argv):
        try:
            # The sync's passphrase (sync.py --seal) is for sealing only; a Herdr that starts its server from
            # this call must not hand it to every pane's shell.
            env = {name: value for name, value in os.environ.items() if name != "HOSTED_READER_PASSPHRASE"}
            done = subprocess.run(["herdr", *argv], capture_output=True, text=True, timeout=10, env=env)
            return json.loads(done.stdout) if done.returncode == 0 else None
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            return None

    listing = call("session", "list", "--json") or {}
    running = running_claude_sessions()
    panes = {}
    pane_ids: set[tuple[str, str]] | None = set()
    HERDR_LIVES.clear()
    HERDR_STARTS.clear()
    for herdr_session in listing.get("sessions") or []:
        name = herdr_session.get("name") or ""
        if not herdr_session.get("running") or name.startswith("-"):
            continue
        HERDR_LIVES[name] = life = herdr_life(herdr_session)
        try:
            HERDR_STARTS[name] = os.stat(herdr_session.get("socket_path") or "").st_mtime
        except (OSError, ValueError):
            pass  # unknown: its panes without an agent are kept
        panes_reply = call("--session", name, "pane", "list")
        if panes_reply is None:
            pane_ids = None
            continue
        panes_result = panes_reply.get("result") or {}
        tabs_result = (call("--session", name, "tab", "list") or {}).get("result") or {}
        found = panes_result.get("panes") or []
        if pane_ids is not None:
            pane_ids.update((name, pane["pane_id"]) for pane in found if pane.get("pane_id"))
        for pane in found:
            claimed = (pane.get("agent_session") or {}).get("value")
            if pane.get("agent") == "codex" and pane.get("pane_id"):
                info = ((call("--session", name, "pane", "process-info", "--pane", pane["pane_id"]) or {}).get("result") or {}).get("process_info")
                actual = codex_pane_session(claimed, info)
                pane["agent_session"] = {**(pane.get("agent_session") or {}), "value": actual}
            if pane.get("agent") == "copilot" and pane.get("pane_id"):  # Herdr names no session for a Copilot pane
                info = ((call("--session", name, "pane", "process-info", "--pane", pane["pane_id"]) or {}).get("result") or {}).get("process_info")
                pane["agent_session"] = {**(pane.get("agent_session") or {}), "value": copilot_pane_session(info)}
            # Herdr also keeps the session id of an agent that has exited: the pane then names no agent at all
            # and its state is unknown, while its shell runs in the foreground. So a session id no running
            # Claude holds is checked against the pane's foreground whether or not Herdr still names Claude.
            retained = bool(claimed) and not pane.get("agent")
            if (pane.get("agent") == "claude" or retained) and running and claimed not in running.values() and pane.get("pane_id"):
                info = ((call("--session", name, "pane", "process-info", "--pane", pane["pane_id"]) or {}).get("result") or {}).get("process_info")
                actual = pane_session(claimed, info, running)
                pane["agent_session"] = {**(pane.get("agent_session") or {}), "value": actual}
        panes.update(pane_index(name, found, tabs_result.get("tabs") or [], life))
    return panes, pane_ids


def pane_index(herdr_session: str, panes: list[dict], tabs: list[dict], life: str = "") -> dict[str, dict]:
    """Session id -> {label, title, herdr, pane, life, status} for the agent panes of one Herdr session.

    label is the name Herdr shows for the pane: its own label, else its tab's
    label. title is the terminal title the agent set ("Bc36 spec handoff rule 3").
    status is the agent's state as Herdr reported it then (the hosted copy shows it as of
    its build; the served local page asks Herdr again every few seconds).
    """
    tab_labels = {tab.get("tab_id"): tab.get("label") or "" for tab in tabs}
    found = {}
    for pane in panes:
        raw_session = (pane.get("agent_session") or {}).get("value")
        session = canonical_session_id(raw_session) if isinstance(raw_session, str) else None
        session = session or raw_session
        if not session:
            continue
        title = pane.get("terminal_title_stripped") or ""
        label = pane.get("label") or tab_labels.get(pane.get("tab_id")) or title
        found[session] = {"label": label, "title": title, "herdr": herdr_session, "pane": pane.get("pane_id") or "",
                          "status": pane.get("agent_status") or ""}
        if life:
            found[session]["life"] = life
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
        write_private(cache_path, json.dumps(cache, indent=1, sort_keys=True))
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
            joined.update(log_key(member) for member in session_chain(item["path"]))
        offered.append({k: v for k, v in item.items() if k != "path"})
    return offered[:limit]


def session_home(homes: list[dict], cwd: str) -> dict:
    """The home whose folder holds the session's working directory (longest match), else main."""
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
    The earliest matching turn within <window> seconds after the event wins (on a tie, the first
    session, then the first turn). Turns are indexed by home and start time, so each event looks
    only at its home's turns inside the window: the hosted copy links every fleet session at once.
    """
    turns: dict[str, list[tuple]] = {}
    for order, session in enumerate(sessions):
        for index, exchange in enumerate(session["exchanges"]):
            if exchange["at"] is None:
                continue
            tasks = [exchange.get("signal_task")] + [notice["signal_task"] for notice in exchange["notices"]]
            turns.setdefault(session["home"], []).append((exchange["at"], order, index, session["id"], tasks, exchange["source"] == "firstmate"))
    for found in turns.values():
        found.sort(key=lambda turn: turn[:3])
    starts = {home: [turn[0] for turn in found] for home, found in turns.items()}
    for event in fleet:
        if event["kind"] not in ("status", "inbox") or "session" in event:
            continue
        home = event["home"] if event["kind"] == "status" else event["to"]
        found = turns.get(home, [])
        for at, _, index, session_id, tasks, firstmate in found[bisect.bisect_left(starts.get(home, []), event["at"]):]:
            if at - event["at"] > window:
                break
            if (event["task"] in tasks) if event["kind"] == "status" else firstmate:
                event["session"], event["ref"] = session_id, index
                break


# ------------------------------------------------- files a reply names (documents)

# A markdown file name or path as written in a message: `requirements.md`, 02-Projects/x/work-log.md,
# /abs/path.md, ~/notes.md. A web URL is left out (it reads as //host/... once its scheme is cut
# off); a file:// URL is read as the path it names. HTML files (.html, .htm) are named the same way.
MD_MENTION = re.compile(r"[\w.~/@+-]*[\w-]\.md(?![\w/-])")
HTML_MENTION = re.compile(r"[\w.~/@+-]*[\w-]\.html?(?![\w/-])")
# Image files are named the same way, in any case (a camera's IMG_1.JPG): the types a browser shows in an <img>.
IMAGE_MENTION = re.compile(r"[\w.~/@+-]*[\w-]\.(?:png|jpe?g|gif|webp|svg)(?![\w/-])", re.I)
NAME_RUN = re.compile(r"[\w.~/@+-]+")  # the characters the mention regexes' names are made of
NAME_END = re.compile(r"[\w-]\.md(?![\w/-])")
HTML_NAME_END = re.compile(r"[\w-]\.html?(?![\w/-])")
IMAGE_SUFFIX = re.compile(r"\.(?:png|jpe?g|gif|webp|svg)", re.I)
IMAGE_NAME_END = re.compile(r"[\w-]\.(?:png|jpe?g|gif|webp|svg)(?![\w/-])", re.I)
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}


def file_mentions(text: str, suffix, name_end: re.Pattern):
    """(start, name) for each match the mention regex (MD_MENTION for ".md", HTML_MENTION for ".htm", IMAGE_MENTION for IMAGE_SUFFIX) gives, in the same order, in linear time.

    A match cannot leave a run of name characters, and within one it runs from the run's
    start to its last place where a name can end, so each run holds one match at most. The
    regex itself backtracks over a long run with no .md in it, and a pasted log or blob
    made one turn take minutes. <suffix> is the text every name ends in, or a pattern for
    the several endings of one kind of file.
    """
    for run in NAME_RUN.finditer(text):
        start, end = run.span()
        if isinstance(suffix, str):
            at = text.rfind(suffix, start, end)
            while at > start:
                found = name_end.match(text, at - 1)
                if found:
                    yield start, text[start:found.end()]
                    break
                at = text.rfind(suffix, start, at + len(suffix) - 1)
        else:
            for at in reversed([m.start() for m in suffix.finditer(text, start, end)]):
                found = name_end.match(text, at - 1) if at > start else None
                if found:
                    yield start, text[start:found.end()]
                    break


# A rebuild scans every reply and message again for the file names it mentions, though almost none changed since the last one.
# What a text mentions depends on the text alone, so it is kept by a digest of the text (never the text itself) for a process
# that builds more than once.
_MENTIONS: dict[tuple[bytes, str], tuple] = {}
MENTIONS_KEPT = 20000


def kept_mentions(text: str, suffix, name_end: re.Pattern):
    key = (hashlib.sha1(text.encode("utf-8", "surrogatepass")).digest(), suffix)
    found = _MENTIONS.get(key)
    if found is None:
        if len(_MENTIONS) >= MENTIONS_KEPT:
            _MENTIONS.clear()
        found = _MENTIONS[key] = tuple(file_mentions(text, suffix, name_end))
    return iter(found)


def md_mentions(text: str):
    return kept_mentions(text, ".md", NAME_END)


def html_mentions(text: str):
    return kept_mentions(text, ".htm", HTML_NAME_END)


def image_mentions(text: str):
    return kept_mentions(text, IMAGE_SUFFIX, IMAGE_NAME_END)


FILE_URL = re.compile(r"\bfile://(?=/)")
CD_LINE = re.compile(r"^\s*cd\s+(\"[^\"\n]+\"|'[^'\n]+'|[^\s;&|]+)", re.M)
MAX_DOCUMENT_BYTES = 512 * 1024
# An HTML file is not embedded, only served on request (api.js), so its limit is about what a browser takes comfortably.
MAX_HTML_BYTES = 8 * 1024 * 1024
# An image is served the same way (api.js), and a full-page screenshot of a long page or a Retina display is several MB of PNG.
MAX_IMAGE_BYTES = 10 * 1024 * 1024
# Besides the home folder, the temp folders agents write reports and scratch notes to. Agents
# quote paths from untrusted material, so a named file anywhere else is never embedded.
TEMP_ROOTS = (Path("/tmp"), Path(tempfile.gettempdir()))


def tool_documents(tool_input, cwd: str) -> list[str]:
    """Markdown, HTML and image files a tool call names, as absolute paths that may not exist.

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
        if key.endswith("path") and (MD_MENTION.fullmatch(value) or HTML_MENTION.fullmatch(value) or IMAGE_MENTION.fullmatch(value)):
            tokens, cds = [(0, value)], []
        elif key == "command":
            tokens = [(at, token) for at, token in [*md_mentions(value), *html_mentions(value), *image_mentions(value)] if not token.startswith("//")]
            cds = [(m.start(), os.path.expanduser(m.group(1).strip("\"'"))) for m in CD_LINE.finditer(value)]
        else:
            continue
        for at, token in tokens:
            base = next((d for start, d in reversed(cds) if start < at and os.path.isabs(d)), cwd)
            path = os.path.join(base, os.path.expanduser(token))
            if os.path.isabs(path):
                found.append(os.path.normpath(path))
    return found


class Touched:
    """The paths a session's tool calls named so far, oldest first, found again by their last name: a reply that names
    `requirements.md` asks which of thousands of touched paths end that way, once per mention."""

    def __init__(self) -> None:
        self.paths: list[str] = []
        self.by_name: dict[str, list[str]] = {}

    def extend(self, paths) -> None:
        for path in paths:
            self.paths.append(path)
            self.by_name.setdefault(os.path.basename(path), []).append(path)

    def __iter__(self):
        return iter(self.paths)

    def __reversed__(self):
        return reversed(self.paths)

    def __len__(self) -> int:
        return len(self.paths)

    def __bool__(self) -> bool:
        return bool(self.paths)


_ROOTS: dict[tuple, list[Path]] = {}


def mention_roots() -> list[Path]:
    """The home folder and the temp folders, as the file system resolves them (kept: this is asked once per mention)."""
    key = (str(Path.home()), *map(str, TEMP_ROOTS))
    roots = _ROOTS.get(key)
    if roots is None:
        roots = _ROOTS[key] = [root.resolve() for root in (Path.home(), *TEMP_ROOTS)]
    return roots


def resolve_mention(token: str, cd_dirs: list[Path], cwd: str, touched: list[str] = (), limit: int = MAX_DOCUMENT_BYTES) -> Path | None:
    """The existing file (at most <limit> bytes) a reply means by <token>, or None.

    An absolute or ~ path is taken as written. A relative one is tried, in order,
    under each directory an earlier `cd` line in the reply named (latest first),
    then as the end of a path the session's own tool calls named so far (latest
    first, since agents name a file they just edited by its short name), then
    under the turn's working directory and each of its parents below the home
    folder, since agents often name files from their repository's root. The file
    found must lie, once links are followed, under the home folder or a temp folder.
    """
    roots = mention_roots()
    raw = Path(os.path.expanduser(token))
    if raw.is_absolute():
        candidates = [raw]
    else:
        candidates = [base / raw for base in cd_dirs]
        wanted = raw.parts
        if isinstance(touched, Touched):
            named = touched.by_name.get(wanted[-1], ()) if wanted else ()
            candidates += [Path(path) for path in reversed(named) if Path(path).parts[-len(wanted):] == wanted]
        else:
            candidates += [Path(path) for path in reversed(touched) if Path(path).parts[-len(wanted):] == wanted]
        if cwd:
            here = Path(cwd)
            home = Path.home()
            candidates += [base / raw for base in [here] + [parent for parent in here.parents if home in parent.parents]]
    for candidate in candidates:
        try:
            if candidate.is_file() and candidate.stat().st_size <= limit:
                found = candidate.resolve()
                if any(found.is_relative_to(root) for root in roots):
                    return found
        except OSError:
            continue
    return None


def cd_lines(text: str) -> tuple[str, list[tuple[int, Path]]]:
    """A message without its file:// prefixes, and where each `cd` line in it starts and the folder it names: what named_files starts
    from, once for the markdown, HTML and image files a message can name (<prepared> of named_files)."""
    text = FILE_URL.sub("", text)
    return text, [(m.start(), Path(os.path.expanduser(m.group(1).strip("\"'")))) for m in CD_LINE.finditer(text)]


def named_files(text: str, cwd: str, touched: list[str] = (), mentions=md_mentions, limit: int = MAX_DOCUMENT_BYTES,
                prepared: tuple[str, list[tuple[int, Path]]] | None = None) -> list[tuple[int, str, Path]]:
    """(where in the text, as written, file) for each existing file a message names by <mentions>, in order, once each."""
    text, cds = prepared or cd_lines(text)
    found: list[tuple[int, str, Path]] = []
    for start, token in mentions(text):
        if token.startswith("//"):
            continue
        cd_dirs = [d for at, d in reversed(cds) if at < start and d.is_absolute()]
        path = resolve_mention(token, cd_dirs, cwd, touched, limit)
        if path and all(path != known for _, _, known in found):
            found.append((start, token, path))
    return found


def named_documents(text: str, cwd: str, touched: list[str] = ()) -> list[tuple[str, Path]]:
    """(as written, file) for each existing markdown file a message names, in order, once each."""
    return [(token, path) for _, token, path in named_files(text, cwd, touched)]


def named_html(text: str, cwd: str, touched: list[str] = (), prepared=None) -> list[tuple[int, str, Path]]:
    """(where in the text, as written, file) for each existing HTML file a message names, in order, once each."""
    return named_files(text, cwd, touched, html_mentions, MAX_HTML_BYTES, prepared)


def named_images(text: str, cwd: str, touched: list[str] = (), prepared=None) -> list[tuple[int, str, Path]]:
    """(where in the text, as written, file) for each existing image file a message names, in order, once each."""
    return named_files(text, cwd, touched, image_mentions, MAX_IMAGE_BYTES, prepared)


# A markdown document that shows a picture says so with `![alt](path)` or `<img src="path">`, the path from the document's own folder
# (a PRD's `release-1-screens/l2.png`). No reply need name that file, so the document's own text is where it is found.
EMBEDDED_IMAGE = re.compile(r"!\[[^\]\n]*\]\(\s*<?([^)\s>]+)|<img\b[^<>]*?\bsrc\s*=\s*[\"']([^\"']+)", re.I)


def embedded_images(text: str, folder: Path) -> list[tuple[str, Path]]:
    """(as written, file) for each existing image a markdown text shows, in order, once each.

    Addresses (`https:`, `data:`) are not files. A relative path starts at <folder>, the document's own; the file
    must be under the home folder or a temp folder, and within MAX_IMAGE_BYTES, as for any image a reply names.
    """
    found: list[tuple[str, Path]] = []
    for match in EMBEDDED_IMAGE.finditer(text):
        token = urllib.parse.unquote((match.group(1) or match.group(2)).split("#")[0].split("?")[0])
        if token.startswith("//") or re.match(r"[a-z][a-z0-9+.-]*:", token, re.I) or not re.search(r"\.(?:png|jpe?g|gif|webp|svg)$", token, re.I):
            continue
        path = resolve_mention(token, [folder], "", (), MAX_IMAGE_BYTES)
        if path and all(path != known for _, known in found):
            found.append((token, path))
    return found


def doc_key(path: Path) -> str:
    """The id of the document at <path>: the same for every conversation that names it, and for a task folder's listing of it."""
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:10]


def shown_dir(path: Path) -> str:
    """The folder a document is in as the page shows it: under the home folder from ~/, else as it is."""
    home, parent = str(Path.home()), str(path.parent)
    if home == "/":
        return "~/" + path.parent.relative_to(home).as_posix() if Path(home) in path.parents else parent
    if parent == home:
        return "~/."
    return "~/" + parent[len(home) + 1:] if parent.startswith(home + "/") else parent


# Who wrote a turn's input, for the inputs whose named files open as documents. A wake-up's
# notice is the fleet's own record and folds away, and a session event has no author.
DOCUMENT_INPUTS = ("captain", "firstmate", "peer")


def attach_documents(sessions: list[dict], html: bool = False, images: bool = False) -> dict[str, dict]:
    """Give each exchange the ids of the documents its reply names (`documents`) and its message
    names (`input_documents`, for a message from you, Firstmate or another session); return
    the documents.

    Each markdown file is read once, as it is now on disk (the page says when it last changed).
    A short name can match a file the session's tool calls named in this turn or an earlier one.
    With <html>, the HTML files they name are listed too, in the order named, as documents of
    kind "html" with no text: the page shows one from the server (api.js), as the file is when
    opened. With <images>, so are the image files, as documents of kind "image" with no text, shown
    the same way. The hosted copy (sync.py) carries both in its own way.
    """
    documents: dict[str, dict] = {}
    shown: dict[str, list[tuple[str, Path]]] = {}  # markdown id -> the images its text shows, found once per document

    def add(path: Path, token: str, kind: str) -> str | None:
        key = doc_key(path)
        if key not in documents:
            try:
                stat = path.stat()
                body = path.read_text(encoding="utf-8", errors="replace") if not kind else None
            except OSError:
                return None
            documents[key] = {"id": key, "name": path.name, "path": str(path), "dir": shown_dir(path), "mention": token, "mtime": stat.st_mtime}
            if kind:
                documents[key].update(kind=kind, size=stat.st_size)
            else:
                documents[key]["text"] = body
                shown[key] = embedded_images(body, path.parent) if images else []
        return key

    def ids_for(text: str, cwd: str, touched: Touched) -> list[str]:
        prepared = cd_lines(text)
        found = [(start, token, path, "") for start, token, path in named_files(text, cwd, touched, prepared=prepared)]
        if html:
            found += [(start, token, path, "html") for start, token, path in named_html(text, cwd, touched, prepared)]
        if images:
            found += [(start, token, path, "image") for start, token, path in named_images(text, cwd, touched, prepared)]
        ids = []
        for _, token, path, kind in sorted(found, key=lambda item: item[0]):
            key = add(path, token, kind)
            if key is None or key in ids:
                continue
            ids.append(key)
            # A document's own pictures follow it, as if the reply had named them (a PRD's mock screens).
            for shown_token, shown_path in shown.get(key, ()):
                picture = add(shown_path, shown_token, "image")
                if picture is not None and picture not in ids:
                    ids.append(picture)
        return ids

    for session in sessions:
        touched = Touched()
        for exchange in session["exchanges"]:
            cwd = exchange.pop("cwd", "")
            touched.extend(exchange.pop("touched", []))
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


# ------------------------------------------------- a leader's tasks (the Documents view's "By task" grouping)

# A leader is a conversation whose own working folder is a Firstmate home: the folder that holds the home's private `data/`, `state/`
# and `projects/`. A worker's copy of a project, or of Firstmate's code, has none of them (they are never committed), and a home's
# subfolder is not the home, so the test reads the working folder itself and never a session's name.
LEADER_FOLDERS = ("data", "state", "projects")
MAX_BACKLOG_BYTES = 2 * 1024 * 1024
MAX_TASK_FILES = 400  # one task's listed files, the shallowest first (the largest task folder on the owner's machine holds 328)
MAX_TASK_DEPTH = 10
TASK_SKIP = {"node_modules"}
# A backlog row: `- [ ] <id> - <title> (repo: x) (kind: scout) (since 2026-10-26)`, then notes indented below it.
BACKLOG_ROW = re.compile(r"^- \[([ xX])\] (\S+) - (.*)$")
ROW_TAG = re.compile(r"\s*\((?:repo|kind|since|done|reported|hold|hold-kind|hold-until|mode|yolo|until)\b[^()]*\)\s*$")
ROW_REPORT = re.compile(r"\s+data/\S+$")
TITLE_LIMIT = 200
TASK_STATES = {"in flight": "In flight", "queued": "Queued", "done": "Done"}


def leader_home(cwd: str) -> Path | None:
    """The Firstmate home a conversation's working folder is, or None (the conversation is not a leader's)."""
    if not cwd:
        return None
    try:
        home = Path(cwd).resolve()
        return home if all((home / name).is_dir() for name in LEADER_FOLDERS) else None
    except (OSError, RuntimeError):
        return None


def backlog_tasks(text: str, default: str = "") -> dict[str, dict]:
    """id -> { title, state } for each row of a backlog (or its archive) in the markdown format `tasks-axi` writes.

    The state is the section the row is in (In flight, Queued, Done), or Done for a checked row, or <default>. The title is the row's
    words without the trailing (repo: ...) (kind: ...) (since ...) tags and report path; the first row of an id wins.
    """
    tasks: dict[str, dict] = {}
    section = default
    for line in text.splitlines():
        if line.startswith("## "):
            heading = line[3:].strip().lower()
            section = TASK_STATES.get(heading, "Done" if heading.startswith("archived") else default)
            continue
        row = BACKLOG_ROW.match(line)
        if not row:
            continue
        title = row.group(3).strip()
        while True:
            trimmed = ROW_TAG.sub("", title)
            if trimmed == title:
                break
            title = trimmed
        title = ROW_REPORT.sub("", title).strip()
        if len(title) > TITLE_LIMIT:
            title = title[:TITLE_LIMIT - 1].rstrip() + "…"
        tasks.setdefault(row.group(2), {"title": title, "state": "Done" if row.group(1) in "xX" else section})
    return tasks


def read_small(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace") if path.stat().st_size <= MAX_BACKLOG_BYTES else ""
    except OSError:
        return ""


def leader_tasks(home: Path) -> dict[str, dict]:
    """The tasks the home's backlog knows, then those only its archive of finished work knows (the backlog keeps a few recent Done rows)."""
    tasks = backlog_tasks(read_small(home / "data" / "backlog.md"))
    for task, record in backlog_tasks(read_small(home / "data" / "done-archive.md"), "Done").items():
        tasks.setdefault(task, record)
    return tasks


def leader_info(cwd: str) -> dict | None:
    """What a leader's conversation carries for the By task view: the home's folder as the page shows a document's (so a document's folder
    says which task it is in) and the tasks' titles and states. None for a conversation that is not a leader's."""
    home = leader_home(cwd)
    return {"dir": shown_dir(home / "data"), "tasks": leader_tasks(home)} if home else None


def home_from_shown(shown: str) -> Path:
    return Path.home() / shown[2:] if shown.startswith("~/") else Path(shown)


def task_folders(home: Path) -> list[Path]:
    """The home's task folders: each folder directly in data/, never a hidden one and never a link (a link could lead anywhere)."""
    data = home / "data"
    try:
        names = sorted(os.listdir(data))
    except OSError:
        return []
    return [data / name for name in names if not name.startswith(".") and (data / name).is_dir() and not (data / name).is_symlink()]


def task_files(folder: Path) -> tuple[list[tuple[Path, str]], int]:
    """(file, kind) for the markdown, HTML and image files in a task folder, the shallowest first, with how many more there were than
    MAX_TASK_FILES. A file counts only as the same kinds, sizes and places a conversation's named file does, and only when it still
    lies inside the folder once links are followed (a link out of it is left out). Hidden files and folders are never read."""
    roots = mention_roots()
    base = folder.resolve()
    found: list[tuple[int, str, Path, str]] = []
    for top, folders, names in os.walk(folder):
        depth = len(Path(top).relative_to(folder).parts)
        folders[:] = sorted(name for name in folders if not name.startswith(".") and name not in TASK_SKIP) if depth < MAX_TASK_DEPTH else []
        for name in names:
            if name.startswith("."):
                continue
            suffix = Path(name).suffix.lower()
            kind, limit = ("", MAX_DOCUMENT_BYTES) if suffix == ".md" else ("html", MAX_HTML_BYTES) if suffix in (".html", ".htm") \
                else ("image", MAX_IMAGE_BYTES) if IMAGE_SUFFIX.fullmatch(suffix) else (None, 0)
            if kind is None:
                continue
            try:
                real = (Path(top) / name).resolve()
                if real.is_file() and real.is_relative_to(base) and any(real.is_relative_to(root) for root in roots) and real.stat().st_size <= limit:
                    found.append((depth, str(real), real, kind))
            except (OSError, RuntimeError):
                continue
    found.sort(key=lambda item: (item[0], item[1]))
    return [(path, kind) for _, _, path, kind in found[:MAX_TASK_FILES]], max(0, len(found) - MAX_TASK_FILES)


def attach_task_files(sessions: list[dict], documents: dict[str, dict]) -> None:
    """List, as documents, every file in the task folders of each leader's home (the local page only): the page's By task view shows
    the files a conversation never named beside the ones it did.

    A markdown file is listed without its text (`lazy`): a home's task folders hold megabytes of notes, and the page asks the server
    for the one it opens (md-open, api.js), as it does for an HTML file or a picture. A document some conversation names keeps the text
    it already has. A task folder cut at MAX_TASK_FILES says how many files it left out (`more`, on the task's record in the session).
    """
    homes: dict[str, dict[str, int]] = {}
    for session in sessions:
        leader = session.get("leader")
        if not leader:
            continue
        shown = leader["dir"]
        if shown not in homes:
            homes[shown] = more = {}
            for folder in task_folders(home_from_shown(shown)):
                files, left = task_files(folder)
                if left:
                    more[folder.name] = left
                for path, kind in files:
                    key = doc_key(path)
                    if key in documents:
                        continue
                    try:
                        stat = path.stat()
                    except OSError:
                        continue
                    documents[key] = {"id": key, "name": path.name, "path": str(path), "dir": shown_dir(path), "mention": "", "mtime": stat.st_mtime}
                    if kind:
                        documents[key].update(kind=kind, size=stat.st_size)
                    else:
                        documents[key]["lazy"] = True
        for task, left in homes[shown].items():
            leader["tasks"].setdefault(task, {})["more"] = left


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


# Claude keeps its logs for the owner alone (0600 files in 0700 folders), and the reader's
# files carry the same text, so they get the same modes whatever the umask.
def private_folder(folder: Path) -> None:
    """Create <folder>, and any missing parent, readable by the owner alone."""
    if not folder.is_dir():
        private_folder(folder.parent)
        folder.mkdir(mode=0o700, exist_ok=True)
        os.chmod(folder, 0o700)


def private_open(path: Path, truncate: bool = True):
    """<path> opened for writing as a file only the owner can read, created so (never
    readable by others for a moment) and narrowed to that if it already existed."""
    private_folder(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if truncate else 0), 0o600)
    os.fchmod(fd, 0o600)
    return os.fdopen(fd, "w", encoding="utf-8")


def write_private(path: Path, text: str) -> None:
    with private_open(path) as handle:
        handle.write(text)


def make_private(folder: Path) -> None:
    """Narrow the reader's own <folder> (out/) and everything in it to the owner, for the
    files earlier builds wrote with the default modes."""
    for top, folders, files in os.walk(folder):
        for name, mode in ([(top, 0o700)] + [(os.path.join(top, f), 0o600) for f in files]):
            try:
                info = os.lstat(name)
                if not os.path.islink(name) and info.st_mode & 0o7777 != mode:
                    os.chmod(name, mode)
            except OSError:
                pass


# A rebuild reads every listed log, but between two rebuilds most logs have not changed.
# Each log's turns are kept parsed on disk, under the version of the log and of this file
# (its rules decide the turns), and a log is parsed again only once either changes.
PARSE_RULES = hashlib.sha256(Path(__file__).read_bytes() + Path(tool_steps.__file__).read_bytes()).hexdigest()[:16]
PARSED_KEEP_DAYS = 7  # a parsed log no build has used for this long is removed


def parsed_log(path: Path, cache: Path | None) -> dict:
    """A log's turns (session_exchanges), first timestamp and first working directory.

    With <cache>, a folder, the result is read from <cache>/<log name>.json while the log and
    the rules are unchanged, and saved there after a parse. Each call returns new objects, so
    a caller may change the turns it gets.
    """
    version = file_version(path)
    saved = cache / f"{log_key(path)}.json" if cache else None
    if saved and version:
        try:
            entry = json.loads(saved.read_text(encoding="utf-8"))
            # A copy of a log in another folder has the same name, so the path must match too.
            if (entry.get("rules"), entry.get("path"), entry.get("version")) == (PARSE_RULES, str(path), list(version)):
                os.utime(saved)  # used by this build, so kept (see prune_parsed)
                return entry["log"]
        except (OSError, json.JSONDecodeError, AttributeError, KeyError):
            pass
    seen = {"first_time": None, "cwd": ""}
    codex = is_codex_log(path)
    copilot = is_copilot_log(path)

    def records():
        for record in iter_jsonl(path):
            if seen["first_time"] is None:
                seen["first_time"] = iso_to_epoch(record.get("timestamp"))
            if not seen["cwd"] and record.get("cwd"):
                seen["cwd"] = record["cwd"]
            if not seen["cwd"] and codex:
                payload = record.get("payload") or {}
                if isinstance(payload, dict) and isinstance(payload.get("cwd"), str):
                    seen["cwd"] = payload["cwd"]
            if not seen["cwd"] and copilot:
                context = (record.get("data") or {}).get("context")
                if isinstance(context, dict) and isinstance(context.get("cwd"), str):
                    seen["cwd"] = context["cwd"]
            yield record

    try:
        parser = copilot_session_exchanges if copilot else codex_session_exchanges if codex else session_exchanges
        log = {"exchanges": parser(records()), **seen}
    except OSError:
        log = {"exchanges": [], "first_time": None, "cwd": ""}
    # The version was taken before the read: a log that grew meanwhile is parsed again next time.
    if saved and version:
        text = json.dumps({"rules": PARSE_RULES, "path": str(path), "version": list(version), "log": log}, ensure_ascii=False, separators=(",", ":"))
        partial = saved.with_name(f".{saved.name}.{os.getpid()}.partial")
        write_private(partial, text)
        os.replace(partial, saved)  # whole or not at all, even with two builds at once
        log = json.loads(text)["log"]  # as a saved parse reads back (lists, not tuples)
    return log


def prune_parsed(cache: Path, days: float = PARSED_KEEP_DAYS) -> None:
    """Remove the parsed logs no build has used for <days>, and partial files a crash left."""
    now = time.time()
    for pattern, age in (("*.json", days * 86400), (".*.partial", 3600)):
        for entry in cache.glob(pattern):
            try:
                if entry.stat().st_mtime < now - age:
                    entry.unlink()
            except OSError:
                pass


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
    return log_index()[0]


# A build walks the chains of every listed session, asking for every log thousands of times
# within a few seconds; even unchanged, listing the folders again each time took seconds.
LOG_LIST_REUSE = 1.0  # seconds a list of every log is reused for
_LOG_INDEX: dict[tuple[Path, ...], tuple[float, list[Path], dict[str, Path], dict[Path, float], dict[Path, tuple[int, int]], tuple]] = {}


def log_index() -> tuple[list[Path], dict[str, Path], dict[Path, float]]:
    """Every session log, each by its session id (the first one, if a copy exists), and
    each one's last write."""
    roots = tuple(project_roots())
    cached = _LOG_INDEX.get(roots)
    if cached and time.monotonic() - cached[0] < LOG_LIST_REUSE:
        return cached[5]  # the tuple kept with the list: a build asks a hundred thousand times, and slicing a new one each time cost a quarter second
    logs = [log for root in roots for folder in listing(root, "*") for log in logs_in(folder)]
    by_id: dict[str, Path] = {}
    written: dict[Path, float] = {}
    versions: dict[Path, tuple[int, int]] = {}
    for log in logs:
        by_id.setdefault(log.stem, log)
        try:
            stat = log.stat()
        except OSError:
            continue
        written[log] = stat.st_mtime
        versions[log] = (stat.st_mtime_ns, stat.st_size)
    _LOG_INDEX[roots] = cached = (time.monotonic(), logs, by_id, written, versions, (logs, by_id, written))
    return cached[5]


def listed_version(path: Path) -> tuple[int, int] | None:
    """A log's (modification time, size) as the list of every log found it, while that list is reused: what the caches of a
    log's head, tail and link are checked against, once for every candidate of every chain."""
    log_index()
    known = _LOG_INDEX[tuple(project_roots())][4].get(path)
    return known if known is not None else file_version(path)


def log_mtime(path: Path) -> float | None:
    """When a log was last written, from the list of every log while it is reused."""
    known = log_index()[2].get(path)
    if known is not None:
        return known
    try:
        return path.stat().st_mtime
    except OSError:
        return None


# Every log by the time it was written, to find the few written near a moment (a /clear) without asking all of them.
_TIMELINE: dict[str, object] = {"written": None, "times": [], "logs": []}


def log_timeline() -> tuple[list[float], list[tuple[int, Path]]]:
    """The times logs were last written, ascending, and beside each (its place in the list of every log, the log)."""
    logs, _, written = log_index()
    if _TIMELINE["written"] is not written:
        places = {log: place for place, log in enumerate(logs)}
        ordered = sorted((written[log], places[log], log) for log in written if log in places)
        _TIMELINE.update(written=written, times=[at for at, _, _ in ordered], logs=[(place, log) for _, place, log in ordered])
    return _TIMELINE["times"], _TIMELINE["logs"]


# The logs that began with /clear, by the time of that clear: a chain asks which of them a clear left behind, and only the few
# whose clear came near a write of the chain's last log can be it, so they are found by time instead of asking every log written since.
_CLEARS: dict[str, object] = {"written": None, "times": [], "logs": []}


def clear_timeline() -> tuple[list[float], list[Path]]:
    """The times logs began with /clear, ascending, and beside each the log (every log in the list of every log)."""
    logs, _, written = log_index()
    if _CLEARS["written"] is not written:
        cleared = [(at, log) for log in logs if (at := head_cleared_at(log)) is not None]
        cleared.sort(key=lambda item: item[0])
        _CLEARS.update(written=written, times=[at for at, _ in cleared], logs=[log for _, log in cleared])
    return _CLEARS["times"], _CLEARS["logs"]


TAIL_BYTES = 256 * 1024
_TAILS: dict[Path, tuple[tuple[int, int], float | None]] = {}


def last_record_time(path: Path) -> float | None:
    """When the log's newest dated record was written, from the end of the file.

    A log is appended to long after its last turn: the records that carry the session's remote-control link, cost
    and monitors have no time and come when the process is touched again (a Herdr restart rewrites every one).
    Its modification time then names that late write, not the turn that ended the session.
    """
    version = listed_version(path)
    cached = _TAILS.get(path)
    if version and cached and cached[0] == version:
        return cached[1]
    found = None
    try:
        with path.open("rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, size - TAIL_BYTES))
            lines = handle.read().splitlines()
        for line in reversed(lines):  # the first line may be cut: it fails to parse and is skipped
            try:
                record = json.loads(line)
            except ValueError:
                continue
            at = iso_to_epoch(record.get("timestamp")) if isinstance(record, dict) and isinstance(record.get("timestamp"), str) else None
            if at is not None:
                found = at
                break
    except OSError:
        pass
    if version:
        _TAILS[path] = (version, found)
    return found


def written_at(path: Path) -> list[float]:
    """The times a log can be said to have been last written: its modification time, and when its last dated record is."""
    return [at for at in dict.fromkeys((log_mtime(path), last_record_time(path))) if at is not None]


def head_records(path: Path, limit: int = HEAD_RECORDS) -> list[dict]:
    """The first parseable records of a log, without reading the whole file, cut down to
    what cleared_at, bridge_id and first_time read (see head_fields)."""
    version = listed_version(path) if limit == HEAD_RECORDS else None
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
                    records.append(head_fields(value))
                if len(records) >= limit:
                    break
    except OSError:
        pass
    return records


def head_fields(record: dict) -> dict:
    """A record without its bulk (tool output, replies, snapshots). A build keeps the head of
    every log in every project folder, which held whole would take hundreds of megabytes."""
    kept = {key: record[key] for key in ("type", "timestamp", "isMeta", "bridgeSessionId") if key in record}
    if record.get("type") == "user":
        content = (record.get("message") or {}).get("content")
        if isinstance(content, list):
            content = [{"type": "tool_result"} if isinstance(block, dict) and block.get("type") == "tool_result" else block
                       for block in content if not isinstance(block, dict) or block.get("type") in ("text", "tool_result")]
        kept["message"] = {"content": content}
    return kept


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


_CLEARED: dict[Path, tuple[tuple[int, int], float | None]] = {}


def head_cleared_at(path: Path) -> float | None:
    """cleared_at of a log's head, kept while the log is as the list of every log found it (a chain asks of every log written since)."""
    version = listed_version(path)
    cached = _CLEARED.get(path)
    if version and cached and cached[0] == version:
        return cached[1]
    at = cleared_at(head_records(path))
    if version:
        _CLEARED[path] = (version, at)
    return at


def bridge_id(records: list[dict]) -> str:
    """The remote-control link a log names first, or "". A /clear keeps the process's link."""
    for record in records:
        if record.get("type") == "bridge-session" and record.get("bridgeSessionId"):
            return record["bridgeSessionId"]
    return ""


def names_bridge(path: Path, bridge: str) -> bool:
    """Whether a log's own bridge-session records name this remote-control link. A turn that
    merely quotes the id (a search, a tool result) does not count."""
    version = listed_version(path)
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


LATE_LINK_WINDOW = 86400  # a log that names the clear's link ended up to this long before it, as people clear when they return


def late_linked(path: Path, clear_time: float, bridge: str) -> Path | None:
    """The log naming <bridge> whose last dated record is nearest before <clear_time>, within LATE_LINK_WINDOW.

    Only the process that wrote the link writes it, so the log it named last before the clear is the one the clear left.
    That log's modification time is no guide when later records without a time touched it (see last_record_time), nor is
    the two minutes cleared_from allows: the clear may come long after the last turn.
    """
    found = []
    written = log_index()[2]
    # The logs written since the window began, by time (a clear that early has no log to be found before it, and the list is then the whole index).
    floor = clear_time - LATE_LINK_WINDOW
    if floor > 0:
        times, logs = log_timeline()
        candidates = (log for _, log in logs[bisect.bisect_left(times, floor):])
    else:
        candidates = all_logs()
    for other in candidates:
        if other == path or (written.get(other) or 0) < floor:
            continue
        at = last_record_time(other)
        if at is not None and -30 <= clear_time - at <= LATE_LINK_WINDOW:
            found.append((abs(clear_time - at), other))
    return next((other for _, other in sorted(found) if names_bridge(other, bridge)), None)


def cleared_from(path: Path, clear_time: float) -> Path | None:
    """cleared_from_log, once for each log and clear inside chains_frozen: every chain asks it of the same few clears (a Herdr restart
    writes to many logs at once, so many chains have the same logs written near their last), and a rebuild asked it a thousand times."""
    if _FROZEN is None:
        return cleared_from_log(path, clear_time)
    key = (path, clear_time)
    if key not in _FROZEN_CLEARED:
        _FROZEN_CLEARED[key] = cleared_from_log(path, clear_time)
    return _FROZEN_CLEARED[key]


def cleared_from_log(path: Path, clear_time: float) -> Path | None:
    """The log a /clear at <clear_time> left behind, last written by the clear itself, so
    within two minutes before it (nearest wins).

    It is the log that names the same remote-control link, in any project folder: a session
    resumed from another directory keeps its old folder, but its /clear starts the new log
    under the current one. Only that process writes the link, so its old log may also get
    its last records up to 30 seconds after the clear. Without a link to match, it is the
    nearest log in the same folder, written at most 5 seconds after the clear, unless the pane's own log is known
    (pane_cleared_from). A linked log's last dated record counts too, when later records without a time moved its
    modification time past the clear.
    """
    def nearest(candidates, late, keep=lambda other: True):
        best = None
        for other in candidates:
            if other == path:
                continue
            at = log_mtime(other)
            if at is None:
                continue
            gap = clear_time - at
            if -late <= gap <= 120 and (best is None or abs(gap) < best[0]) and keep(other):
                best = (abs(gap), other)
        return best[1] if best else None

    def nearest_anywhere(late, keep):
        # The same choice over every log, from the logs written in the window alone (nearest first, the earlier in the list on a tie).
        times, logs = log_timeline()
        low, high = bisect.bisect_left(times, clear_time - 120 - 1e-3), bisect.bisect_right(times, clear_time + late + 1e-3)
        near = sorted((abs(clear_time - times[i]), logs[i][0], logs[i][1]) for i in range(low, high) if -late <= clear_time - times[i] <= 120)
        for _, _, other in near:
            if other != path and keep(other):
                return other
        return None

    bridge = bridge_id(head_records(path))
    names = lambda other: names_bridge(other, bridge)
    linked = nearest_anywhere(30, names) if bridge else None
    # A linked log whose process was touched again long after the clear (see last_record_time) still ended with the clear.
    # It is asked before the nearest log in the folder, which may be another session's that merely ended nearby.
    linked = linked or (late_linked(path, clear_time, bridge) if bridge else None)
    return linked or pane_cleared_from(path, clear_time) or nearest(logs_in(path.parent), 5)


_FROZEN: dict[tuple[Path, int], list[Path]] | None = None
_FROZEN_PANES: list = []  # inside chains_frozen: what Herdr said the first time it was asked (see herdr_inventory)
_FROZEN_CLEARED: dict[tuple[Path, float], Path | None] = {}  # inside chains_frozen: the log each clear left (see cleared_from)


@contextlib.contextmanager
def chains_frozen():
    """Within the block, each log's chain is worked out once, and Herdr is asked once. A rebuild asks for the same chains several
    times (which panes closed, which session is newest, the page, the answer sheet), each of which must see the same sessions, and
    each of which took about as long as the whole rest of the build; it asked Herdr the same three times (nine commands), and a pane
    that changed between two of them made the page and the sheet disagree."""
    global _FROZEN
    outer = _FROZEN
    _FROZEN = {} if outer is None else outer
    if outer is None:
        _FROZEN_PANES.clear()
        _FROZEN_CLEARED.clear()
    try:
        yield
    finally:
        _FROZEN = outer
        if outer is None:
            _FROZEN_PANES.clear()
            _FROZEN_CLEARED.clear()


def session_chain(path: Path, limit: int = 20) -> list[Path]:
    """The sessions one Claude Code pane ran across /clear, or across Claude restarted in the
    same pane, oldest first, including <path>."""
    if is_codex_log(path) or is_copilot_log(path):
        return [path]
    if _FROZEN is not None:
        if (path, limit) not in _FROZEN:
            _FROZEN[(path, limit)] = chain_of(path, limit)
        return list(_FROZEN[(path, limit)])
    return chain_of(path, limit)


def chain_of(path: Path, limit: int) -> list[Path]:
    chain = [path]
    while len(chain) < limit:
        at = head_cleared_at(chain[0])
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
def same_life(entry: dict, life: str | None) -> bool:
    """Whether a pane entry belongs to the Herdr session life <life>; unknown on either side
    (an entry cached before lives were recorded, a folder that cannot be read) counts as the same."""
    return not entry.get("life") or not life or entry["life"] == life


RESTART_WINDOW = 600  # seconds from the old session's last write to the new one's first


def same_pane(a: dict, b: dict) -> bool:
    if a.get("herdr") != b.get("herdr") or not same_life(a, b.get("life")):
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
    ended = written_at(before)
    return cleared_at(head) is None and start is not None and any(-30 <= start - when <= RESTART_WINDOW for when in ended)


def pane_neighbours(path: Path) -> list[Path]:
    """Logs of the other sessions seen in the same pane as <path>."""
    mine = _PANE_HISTORY.get(path.stem)
    if not mine:
        return []
    found = (find_session_file(sid) for sid, entry in _PANE_HISTORY.items() if sid != path.stem and same_pane(mine, entry))
    return [log for log in found if log and not is_copilot_log(log)]  # a Copilot session never joins a Claude chain


def pane_cleared_from(path: Path, clear_time: float) -> Path | None:
    """The log the same Herdr pane ran before a /clear at <clear_time>: of the pane's other logs, the one whose last dated
    record is nearest before the clear, within LATE_LINK_WINDOW, and which was written at the clear or after it.

    Exiting Claude after a /clear (the way to resume the new session) writes records without a time into the old log well past
    the clear, and a session cleared and resumed has no link to name it, so neither the 5 seconds a log of the folder may be
    written after the clear nor a link finds the log. Which pane ran it does, and its last dated record says which of the
    pane's logs the clear came after. A log last written long before the clear is not the one the clear left.
    """
    found = []
    for other in pane_neighbours(path):
        at = last_record_time(other)
        written = log_mtime(other)
        if at is not None and written is not None and -30 <= clear_time - at <= LATE_LINK_WINDOW and written >= clear_time - 30:
            found.append((abs(clear_time - at), other.parts, other))
    return min(found)[2] if found else None


def restarted_from(path: Path) -> Path | None:
    return next((other for other in pane_neighbours(path) if restarted(other, path)), None)


def restarted_into(chain: list[Path]) -> Path | None:
    return next((other for other in pane_neighbours(chain[-1]) if other not in chain and restarted(chain[-1], other)), None)


def cleared_into(chain: list[Path]) -> Path | None:
    """The log a /clear in the pane started after the chain's last log, if any."""
    written = written_at(chain[-1])
    if not written:
        return None
    recorded = last_record_time(chain[-1])
    # The next log may sit in another project folder (see cleared_from), and was written
    # to since; only those few are sorted and read.
    since = min(written) - 5
    # Only a log written since then, whose own clear came within the windows below, can be the one; the clears are found by time,
    # then taken in the order of their paths, as every log written since was.
    times, cleared = clear_timeline()
    windows = [(when - 30, when + 120) for when in written]
    if recorded is not None:
        windows.append((recorded - 30, recorded + LATE_LINK_WINDOW))
    written_at_all = log_index()[2]
    picked = set()
    for low, high in windows:
        for place in range(bisect.bisect_left(times, low - 1e-3), bisect.bisect_right(times, high + 1e-3)):
            if (written_at_all.get(cleared[place]) or 0) >= since:
                picked.add(cleared[place])
    for other in sorted(picked, key=lambda log: log.parts):
        if other in chain:
            continue
        at = head_cleared_at(other)
        near = any(-30 <= at - when <= 120 for when in written) if at is not None else False
        # cleared_from decides which log a clear left; this only skips the clears no log of the chain could be before.
        if at is not None and (near or (recorded is not None and -30 <= at - recorded <= LATE_LINK_WINDOW)) and cleared_from(other, at) == chain[-1]:
            return other
    return None


def payload_json(payload) -> str:
    """The payload as JSON that cannot close the script element it sits in."""
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return data.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


HOSTED_HEAD = ('<link rel="manifest" href="manifest.webmanifest">\n<link rel="apple-touch-icon" href="icon-180.png">\n'
               '<meta name="theme-color" content="#1f5fd1">\n<meta name="mobile-web-app-capable" content="yes">\n'
               '<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="Transcripts">')


def fill_template(template: Path, data: str, mode: str = "local") -> tuple[str, str]:
    """The page <template> makes with <data> (payload JSON) in its payload slot, and its template hash.

    The shared live.js goes into the page's script, and pins.js, picker.js, undosend.js, attach.js, commentkey.js, the vendored markdown-it with markdown.js,
    steps.js, find.js, docfiles.js and address.js into the reader page's (the answer sheet has no slot for them, and gets sendonce.js); mode "hosted" (the hosted copy's shell, sync.py) also pastes seal.js and hosted.js
    there, and the script reads the mode from __MODE__.
    """
    page = template.read_text(encoding="utf-8").replace("/*__LIVE__*/", LIVE_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__PINS__*/", PINS_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__PICKER__*/", PICKER_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__ASKS__*/", ASKS_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__SENDONCE__*/", SENDONCE_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__UNDOSEND__*/", UNDOSEND_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__ATTACH__*/", ATTACH_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__COMMENTKEY__*/", COMMENTKEY_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__SELECTCOPY__*/", SELECTCOPY_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__MARKDOWN_IT__*/", MARKDOWN_IT_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__MARKDOWN__*/", MARKDOWN_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__STEPS__*/", STEPS_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__FIND__*/", FIND_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__DOCFILES__*/", DOCFILES_SCRIPT.read_text(encoding="utf-8"))
    page = page.replace("/*__ADDRESS__*/", ADDRESS_SCRIPT.read_text(encoding="utf-8"))
    hosted = SEAL_SCRIPT.read_text(encoding="utf-8") + HOSTED_SCRIPT.read_text(encoding="utf-8")
    page = page.replace("/*__HOSTED__*/", hosted if mode == "hosted" else "const hosted = null;")
    page = page.replace("__MODE__", mode)
    # The hosted shell is also installed on a phone (a worker keeps it, a manifest and icon add it to the Home Screen), which its content
    # policy must allow. The reader page also shows an image a reply names in an <img>: from its own server, or in the copy from the image's
    # bytes in the document (a data: address, which loads nothing and runs nothing); the answer sheet shows none.
    reader_page = template.name == TEMPLATE.name
    csp = "worker-src 'self'; manifest-src 'self'; img-src 'self'" + (" data:" if reader_page else "") + "; " if mode == "hosted" else "img-src 'self'; " if reader_page else ""
    page = page.replace("__CSP_HOSTED__", csp)
    page = page.replace("__HEAD_HOSTED__", HOSTED_HEAD if mode == "hosted" else "")
    if page.count("__PAYLOAD__") != 1:
        # A second mention (a comment, say) would carry the whole payload into the page again.
        raise ValueError(f"{template.name} must name __PAYLOAD__ exactly once, in its payload slot")
    # The policy allows only the page's own script, by hash, so injected markup cannot run code.
    script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
    digest = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii")
    # The template hash lets a served page tell a new build (swap the data) from new code (reload).
    template_hash = hashlib.sha256(page.encode("utf-8")).hexdigest()[:16]
    page = page.replace("__SCRIPT_HASH__", f"sha256-{digest}").replace("__TEMPLATE_HASH__", template_hash).replace("__PAYLOAD__", data)
    return page, template_hash


def write_step_outputs(sessions: list[dict], folder: Path) -> None:
    """Move each conversation's tool output out of its turns (the page never holds it) into <folder>/<conversation id>.json, and
    drop the files of conversations the page no longer lists. The page asks the server for one when a step opens (api.js)."""
    private_folder(folder)
    listed = set()
    for session in sessions:
        outputs = tool_steps.take_outputs(session["exchanges"])
        if outputs:
            listed.add(f"{session['id']}.json")
            write_private(folder / f".{session['id']}.json.{os.getpid()}.partial", json.dumps({"outputs": outputs}, ensure_ascii=False, separators=(",", ":")))
            os.replace(folder / f".{session['id']}.json.{os.getpid()}.partial", folder / f"{session['id']}.json")
    for old in folder.glob("*.json"):
        if old.name not in listed:
            old.unlink(missing_ok=True)


# A page written by this process, and what it was made of apart from its build time (write_page, only_if_changed).
_UNCHANGED: dict[Path, tuple] = {}


def write_page(template: Path, payload: dict, out: Path, only_if_changed: bool = False) -> None:
    """Fill a template with the payload and the shared live.js, then write the page and its stamp.

    The page is replaced in one rename, so the server never serves half a page. The
    stamp beside it (<page>.stamp) holds the payload's build time; the served page
    compares it with its own to know a newer build exists. With <only_if_changed>, a page this
    process wrote last time that the new payload would only differ from in its build time is left
    as it is, stamp and all: an open page is told of a new build by the stamp, and nothing it shows has changed.
    """
    private_folder(out.parent)
    stamp = out.with_suffix(".stamp")
    # A rebuild started by hand can overlap the server's own. Each writes its own file, and the
    # page and its stamp are replaced together under a lock, never by a build older than the
    # one already there, so the stamp always describes the page beside it.
    with private_open(out.with_name(f".{out.name}.lock"), truncate=False) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if float(stamp.read_text(encoding="utf-8")) > payload["generated"]:
                return
        except (OSError, ValueError):
            pass
        if "sessions" in payload:
            write_step_outputs(payload["sessions"], out.with_name(STEP_OUTPUTS))  # before the page: no page is served whose outputs are not there
        data = payload_json(payload)  # after the tool output is moved aside: the page never holds it
        same = None
        if only_if_changed:
            # What the page is made of: its payload but for the build time (the first value), and the files that go into the template.
            same = (tuple(file_version(path) for path in (template, MARKDOWN_IT_SCRIPT, *sorted(HERE.glob("*.js")))), data[data.index(","):])
            if _UNCHANGED.get(out) == same and out.is_file() and stamp.is_file():
                return
        # The HTML and image files the page offers to open, which the server reads to find a file by the id the page asks for
        # (api.js), written first so no page is served whose files the server does not know. The sheet has no documents.
        listed = lambda kind: json.dumps({doc["id"]: doc["path"] for doc in payload["documents"].values() if doc.get("kind") == kind})
        lazy = json.dumps({doc["id"]: doc["path"] for doc in payload["documents"].values() if doc.get("lazy")}) if "documents" in payload else ""
        files = [(out.with_name(HTML_FILES), listed("html")), (out.with_name(IMAGE_FILES), listed("image")), (out.with_name(MD_FILES), lazy)] if "documents" in payload else []
        page, _ = fill_template(template, data)
        for target, text in (*files, (out, page), (stamp, repr(payload["generated"]))):
            partial = target.with_name(f".{target.name}.{os.getpid()}.partial")
            write_private(partial, text)
            os.replace(partial, target)
        if same is not None:
            _UNCHANGED[out] = same


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--main-home", default=str(MAIN_HOME))
    parser.add_argument("--home", action="append", help="secondmate home to include (default: the main home's registry)")
    parser.add_argument("--session", action="append", help="session id or path to show (repeatable); only these are read")
    parser.add_argument("--listed", action="store_true", help="show exactly the --session ones, even none (the reader's list)")
    parser.add_argument("--since-hours", type=float, help="fleet window (default 72, or from the earliest --session)")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--stats", action="store_true", help="print counts only; write no page")
    args = parser.parse_args(argv)

    # The worker builds again and again in one interpreter, and keeps what each conversation made (build_cache.py); a build run by hand
    # is made once, from nothing, and a run as a script has no second build to keep anything for.
    if not args.stats and __name__ != "__main__":
        if str(HERE) not in sys.path:
            sys.path.insert(0, str(HERE))  # python -I leaves the script's folder off the path
        import build_cache
        if build_cache.usable(args):
            built = build_cache.build(args)
            out = Path(args.out).expanduser()
            build_cache.write(built, out)
            print(f"Wrote {out}")
            print(built.stats)
            return 0
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
