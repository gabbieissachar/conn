#!/usr/bin/env python3
"""Build the questionnaire prototype: decision cards from a reply, answered in the page.

Throwaway prototype. A reply written by an adaptive grill-me review asks for keyed
answers ("Reply with: A1=...; A2=..."). This finds those replies in the chosen
sessions, reads their cards with fixed rules (no model), and fills
questionnaire.html so the answers can be picked in the page and copied back as
one line such as `A1=accept;A2=inline`.

Usage (from the repo root):
  python3 setup/transcript-reader/prototype/build_questionnaire.py [--session ID ...]

With no --session it reads the reader's list (out/sessions.txt). The page embeds
private transcript text, so it is written to the gitignored out/ folder.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_prototype as builder  # noqa: E402

TEMPLATE = HERE / "questionnaire.html"
OUT = HERE.parent / "out"
KEY = r"[A-Z][0-9]{1,2}"
CELL_SPLIT = re.compile(r"(?<!\\)\|")
BACKTICK = re.compile(r"`([^`]+)`")
KEYED_ANSWER = re.compile(rf"\b({KEY})\s*=\s*([^;\n]*)")
# "**A2 revised.** Do we include ...?" - a bold lead naming one key, then the question.
QUESTION_LEAD = re.compile(rf"^\*\*([^*]*?\b({KEY})\b[^*]*)\*\*\s*(.*)$")
# "- `inline-with-caveat`: include it, plus ..." - one choice of the question above.
OPTION_BULLET = re.compile(r"^\s*[-*]\s+`([^`]+)`\s*[:\-–]?\s*(.*)$")
# "- **B1:** Who runs the monthly pull" - a card named but not open yet.
KEYED_BULLET = re.compile(rf"^\s*[-*]\s+\*\*({KEY}):?\*\*:?\s*(.*)$")
# "**a)** Both: rows in ...; b) After purchase only" - lettered choices inside one table cell.
LETTER = re.compile(r"(?:^|(?<=[\s;]))(?:\*\*)?([a-h])\)(?:\*\*)?\s+")


def cells(line: str) -> list[str]:
    return [cell.strip() for cell in CELL_SPLIT.split(line.strip().strip("|"))]


def tables(lines: list[str]):
    """(start line, header cells, row cell lists) for each markdown table."""
    n = 0
    while n < len(lines):
        if lines[n].lstrip().startswith("|") and n + 1 < len(lines) and re.match(r"^\s*\|?[\s:|-]+\|[\s:|-]*$", lines[n + 1]):
            header = [cell.lower() for cell in cells(lines[n])]
            rows, end = [], n + 2
            while end < len(lines) and lines[end].lstrip().startswith("|"):
                rows.append(cells(lines[end]))
                end += 1
            yield n, end, header, rows
            n = end
        else:
            n += 1


def column(header: list[str], *names: str) -> int | None:
    for index, name in enumerate(header):
        if any(want in name for want in names):
            return index
    return None


def strip_md(text: str) -> str:
    return text.replace("**", "").strip()


def lettered(cell: str) -> list[tuple[str, str]]:
    """(letter, text) for each `a)`, `b)` choice in a cell, in order."""
    marks = list(LETTER.finditer(cell))
    return [(m.group(1), strip_md(cell[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(cell)]).rstrip(" ;"))
            for i, m in enumerate(marks)]


def parse_questionnaire(reply: str) -> dict | None:
    """The cards a reply asks to be answered, or None when it asks for no keyed answers."""
    lines = reply.splitlines()
    reply_line = next((line for line in reversed(lines) if re.search(r"\breply with\b", line, re.I) and re.search(rf"{KEY}\s*=", line)), "")
    cards, resolved, locked, used = [], [], [], set()
    first_block = len(lines)

    for start, end, header, rows in tables(lines):
        key_col = column(header, "id", "card")
        # "Answer" lists the choices; a checkpoint's "Submitted answer" is what was already sent.
        answer_col = next((i for i, name in enumerate(header) if "answer" in name and "submitted" not in name), None)
        if key_col is None:
            continue
        submitted_col, state_col = column(header, "submitted"), column(header, "state")
        for row in rows:
            get = lambda col: row[col] if col is not None and col < len(row) else ""
            key = strip_md(get(key_col))
            if not re.fullmatch(KEY, key):
                continue
            if answer_col is not None and BACKTICK.search(get(answer_col)):
                cards.append({
                    "key": key, "question": strip_md(get(column(header, "decision", "question"))),
                    "depends": strip_md(get(column(header, "depends"))), "recommended": get(column(header, "recommend")),
                    "options": [{"value": value, "note": "", "recommended": False} for value in BACKTICK.findall(get(answer_col))],
                })
            elif lettered(get(column(header, "recommend"))):
                # Lettered choices: the recommended column holds one (the reply's own
                # recommendation), an "other options" column the rest.
                recommended = lettered(get(column(header, "recommend")))
                others = lettered(get(column(header, "other", "option")))
                cards.append({
                    "key": key, "question": strip_md(get(column(header, "decision", "question"))),
                    "depends": strip_md(get(column(header, "depends"))), "recommended": recommended[0][1] if len(recommended) == 1 else "",
                    "options": [{"value": letter, "note": text, "recommended": True} for letter, text in recommended]
                    + [{"value": letter, "note": text, "recommended": False} for letter, text in others],
                })
            elif submitted_col is not None:
                resolved.append({"key": key, "submitted": get(submitted_col), "decision": get(column(header, "inferred", "decision")),
                                 "state": strip_md(get(state_col))})
            first_block = min(first_block, start)
            used.update(range(start, end))

    for n, line in enumerate(lines):
        lead = QUESTION_LEAD.match(line.strip())
        if not lead or n in used:
            continue
        options, m = [], n + 1
        while m < len(lines) and (not lines[m].strip() or OPTION_BULLET.match(lines[m])):
            bullet = OPTION_BULLET.match(lines[m])
            if bullet:
                options.append({"value": bullet.group(1), "note": bullet.group(2).strip(),
                                "recommended": bool(re.search(r"\brecommend", bullet.group(2), re.I))})
            m += 1
        if not options:
            continue
        key = lead.group(2)
        cards = [card for card in cards if card["key"] != key]  # a revised card replaces the earlier one
        resolved = [item for item in resolved if item["key"] != key]
        cards.append({"key": key, "question": strip_md(lead.group(3)) or strip_md(lead.group(1)), "depends": "",
                      "recommended": next((o["note"] for o in options if o["recommended"]), ""), "options": options})
        first_block = min(first_block, n)
        used.update(range(n, m))

    lock_heading = False
    for n, line in enumerate(lines):
        if n in used:
            continue
        if re.match(r"^\s*(#+|\*\*)", line) and not KEYED_BULLET.match(line):
            lock_heading = bool(re.search(r"\block", line, re.I))
        bullet = KEYED_BULLET.match(line)
        if bullet and lock_heading and bullet.group(1) not in {card["key"] for card in cards}:
            locked.append({"key": bullet.group(1), "text": bullet.group(2).strip()})

    if not cards or not (reply_line or len(cards) > 1):
        return None
    open_keys = {card["key"] for card in cards}
    corrections = [k for k in dict.fromkeys(re.findall(rf"\b{KEY}\b", reply_line)) if k not in open_keys and k in {r["key"] for r in resolved}]
    return {
        "title": strip_md(lines[0].lstrip("#")) if lines else "",
        "intro": "\n".join(lines[:first_block]).strip(),
        "cards": cards, "resolved": resolved, "locked": locked, "corrections": corrections,
        "reply_line": strip_md(reply_line),
    }


def sent_answers(text: str) -> dict[str, str]:
    """Keyed answers in a message the captain sent, such as `A1=accept;A2=inline`."""
    return {key: value.strip() for key, value in KEYED_ANSWER.findall(text)}


def collect(session_names: list[str]) -> list[dict]:
    labels = builder.pane_labels([], OUT / "pane-labels.json")  # refreshes the cache; read below
    try:
        cache = json.loads((OUT / "pane-labels.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cache = labels
    found = []
    for name in session_names:
        path = builder.find_session_file(name)
        if not path:
            continue
        exchanges = builder.session_exchanges(builder.read_jsonl(path))
        for index, exchange in enumerate(exchanges):
            questionnaire = parse_questionnaire(exchange["reply"]) if exchange["reply"] else None
            if not questionnaire:
                continue
            answer = next((later for later in exchanges[index + 1:] if later["source"] == "captain"), None)
            sent = sent_answers(answer["input"]) if answer else {}
            found.append({
                **questionnaire, "session": path.stem, "pane": cache.get(path.stem), "at": exchange["reply_at"] or exchange["at"],
                "reply": exchange["reply"], "sent": sent, "sent_at": answer["at"] if answer and sent else None,
            })
    found.sort(key=lambda q: q["at"] or 0, reverse=True)
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--session", action="append", help="session id or path (default: the reader's list)")
    parser.add_argument("--out", default=str(OUT / "questionnaire.html"))
    args = parser.parse_args()
    names = args.session
    if not names:
        try:
            names = [l.strip() for l in (OUT / "sessions.txt").read_text(encoding="utf-8").splitlines() if l.strip()]
        except OSError:
            names = []
    payload = {"generated": time.time(), "questionnaires": collect(names)}
    out = Path(args.out).expanduser()
    builder.write_page(TEMPLATE, payload, out)
    print(f"Wrote {out}")
    for q in payload["questionnaires"]:
        print(f"  {q['session'][:8]} {len(q['cards'])} open, {len(q['resolved'])} answered, {len(q['locked'])} locked: {q['title'][:70]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
