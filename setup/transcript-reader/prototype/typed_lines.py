"""The in-band lines Firstmate prints for typed asks, found in one turn's tool output and reply (S3, the pmos reader's half).

bin/fm-captain-ask.sh and bin/fm-wake-drain.sh end their output with one self-describing last line, so a reader links an ask record to the
turn that wrote it by content, never by time (firstmate docs/captain-asks.md):

  ASK_RECORD v1 <id> cards=Z1,Z2 gates=2 sha=<12 hex> home=<label>                         `open`
  ASK_ANSWERED v1 <id> state=partial answered=Z1 open=Z2 closed=<tasks|-> sha=<12 hex>     `answered`
  WAKE_ACK: nothing-new through=<N>   |   WAKE_ACK: news through=<N>                        `fm-wake-drain.sh --ack-through`
  ask: <id>                                                                                 the leader's own reply footer

This module only finds them. It is the one piece of the typed-ask code the parsed-log cache depends on (build_prototype.PARSE_RULES hashes
it), so it holds nothing else: records, checks and sheets are typed_asks.py's, read fresh on every build.

scan(exchange) is called when a turn is finished (build_prototype.finish_exchange). It reads each `ran` step's output (the last
OUTPUT_CHARS of it, so a last line survives) and the reply, and returns None when the turn holds none of the lines, else

  {"records":  [{"id", "sha", "cards", "home"}],   ASK_RECORD lines, in order, each id once
   "answered": [{"id", "state", "sha", "closed"}], ASK_ANSWERED lines
   "ack":      {"verdict", "through"} | absent,    the last WAKE_ACK line
   "acks":     n,                                  ack calls (a `--ack-through` command) the turn made
   "footer":   [ids]}                              `ask: <id>` footers of the reply
"""

from __future__ import annotations

import re

ID = r"ask-\d{8}T\d{6}Z-[0-9a-f]{4}"
# One line, anchored: a worker that prints the text inside a longer line (a quoted log, a grep hit) does not make a record.
ASK_LINE = re.compile(rf"^(ASK_RECORD|ASK_ANSWERED) v1 ({ID})((?: [A-Za-z_]+=[^\s]*)*)[ \t]*$", re.M)
WAKE_LINE = re.compile(r"^WAKE_ACK: (nothing-new|news) through=(\d+)[ \t]*$", re.M)
FOOTER = re.compile(rf"^[ \t>*_-]*ask:[ \t]*`?({ID})`?[ \t*_]*$", re.M)
ACK_COMMAND = "--ack-through"
SHA = re.compile(r"^[0-9a-f]{12}$")


def tail_fields(text: str) -> dict[str, str]:
    """The `key=value` words after an id."""
    return dict(word.split("=", 1) for word in text.split())


def scan_outputs(outputs: list[str], commands: list[str], reply: str = "") -> dict | None:
    """The typed-ask lines of one turn: <outputs> the output text of its `ran` steps, <commands> their commands (to count ack calls), <reply>
    its reply text."""
    records: dict[str, dict] = {}
    answered: list[dict] = []
    ack = None
    for text in outputs:
        for match in ASK_LINE.finditer(text):
            kind, ask_id, rest = match.groups()
            fields = tail_fields(rest)
            sha = fields.get("sha", "")
            if kind == "ASK_RECORD":
                records.setdefault(ask_id, {"id": ask_id, "sha": sha if SHA.match(sha) else "", "cards": [k for k in fields.get("cards", "").split(",") if k],
                                            "home": fields.get("home", "")})
            else:
                answered.append({"id": ask_id, "state": fields.get("state", ""), "sha": sha if SHA.match(sha) else "",
                                 "closed": [t for t in fields.get("closed", "-").split(",") if t and t != "-"]})
        for match in WAKE_LINE.finditer(text):
            ack = {"verdict": match.group(1), "through": int(match.group(2))}
    acks = sum(1 for command in commands if ACK_COMMAND in command)
    footer = list(dict.fromkeys(FOOTER.findall(reply))) if reply else []
    if not (records or answered or ack or acks or footer):
        return None
    found: dict = {}
    if records:
        found["records"] = list(records.values())
    if answered:
        found["answered"] = answered
    if ack:
        found["ack"] = ack
    if acks:
        found["acks"] = acks
    if footer:
        found["footer"] = footer
    return found


def scan(exchange: dict) -> dict | None:
    """scan_outputs of a finished turn: its steps' output and commands, and its reply."""
    steps = exchange.get("steps") or []
    outputs = [step["out"] for step in steps if step.get("k") == "ran" and isinstance(step.get("out"), str)]
    commands = [f"{step.get('c') or ''} {step.get('s') or ''}" for step in steps if step.get("k") == "ran"]
    return scan_outputs(outputs, commands, exchange.get("reply") or "")
