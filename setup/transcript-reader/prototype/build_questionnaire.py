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


# "choice: transcript-Write / newest-file-by-mtime / other" - a labelled list of short choices.
CHOICE_LABEL = re.compile(r"^\s*(?:\*\*)?(?:choices?|options?|pick(?: one)?|one of)\s*:?(?:\*\*)?\s*:?\s*", re.I)
CHOICE_SPLIT = re.compile(r"\s+/\s+|\s*,\s*(?:or\s+)?|\s+or\s+")


def plain_choices(cell: str) -> list[str]:
    """Short choices written without backticks: `a / b / c`, `a, b, or c`. Each is at most
    five words, so a sentence is never cut into choices."""
    labelled = CHOICE_LABEL.match(cell)
    text = cell[labelled.end():] if labelled else cell
    parts = [strip_md(part).strip(" .;") for part in CHOICE_SPLIT.split(text.strip())]
    parts = [part for part in parts if part]
    if len(parts) < 2 or any(len(part.split()) > 5 or len(part) > 40 for part in parts):
        return []
    if not labelled and " / " not in text:
        return []  # bare commas are prose more often than choices
    return parts


def cell_choices(cell: str) -> list[dict]:
    """The choices one table cell offers, by the first rule that finds two or more:
    backtick values, lettered a) b), then a plain short list (labelled `choice:` or split by /)."""
    ticked = BACKTICK.findall(cell)
    if ticked:
        return [{"value": value, "note": "", "recommended": False} for value in ticked]
    letters = lettered(cell)
    if letters:
        return [{"value": letter, "note": text, "recommended": False} for letter, text in letters]
    return [{"value": value, "note": "", "recommended": False} for value in plain_choices(cell)]


def recommended_choices(cell: str) -> list[dict]:
    """A recommended-default cell that is itself a choice: lettered (`**a)** Both: ...`), or
    backtick values with at most a few words around them. Prose (a sentence that merely
    quotes code) is shown as the recommendation instead."""
    letters = lettered(cell)
    if letters:
        return [{"value": letter, "note": text, "recommended": True} for letter, text in letters]
    ticked = BACKTICK.findall(cell)
    if ticked and len(BACKTICK.sub("", cell).split()) <= 3:
        return [{"value": value, "note": "", "recommended": True} for value in ticked]
    return []


# Answers a reply offers for any card: "You can also write `needs explanation`", "answer `defer` or `explain`".
EXTRA_LINE = re.compile(r"\b(?:you can also|also (?:write|answer|reply)|use|write|answer)\b[^\n]*`", re.I)
PLACEHOLDER = re.compile(r"\.\.\.|…|<[^>]*>")


def option(value: str, note: str = "", recommended: bool = False) -> dict:
    return {"value": value, "note": note, "recommended": recommended}


def reply_examples(lines: list[str], reply_line: str) -> tuple[dict[str, str], list[str]]:
    """What the reply shows as answers: each key's example value (`A1=accept`) and the
    extra answers it allows for any card (`needs explanation`, `defer`). Placeholders
    such as `A1=...` or `change <how>` are not answers."""
    examples: dict[str, str] = {}
    extras: list[str] = []
    for key, value in re.findall(rf"\b({KEY})\s*=\s*([^;`\n]*)", reply_line):
        value = value.strip().rstrip(".")
        if not value or PLACEHOLDER.search(value):
            continue
        if key not in examples:
            examples[key] = value
        elif value not in extras:
            extras.append(value)  # "You can also write `A2=needs explanation`": an answer for any card
    tail = [line for line in lines[-6:] if line == reply_line or EXTRA_LINE.search(line)]
    for line in tail:
        for value in BACKTICK.findall(line):
            value = value.strip()
            if "=" not in value and value and not PLACEHOLDER.search(value) and value not in extras:
                extras.append(value)
    return examples, extras


def mark_recommended(card: dict) -> None:
    """Mark the choice the card's recommendation names, by fixed rules: a recommendation
    that opens with a choice's value, or names a lettered choice (`Assume a)`, `**b).**`).
    Nothing else is guessed."""
    if any(o["recommended"] for o in card["options"]):
        return
    text = strip_md(BACKTICK.sub(lambda m: m.group(1), card["recommended"]))
    for opt in card["options"]:
        if re.match(rf"{re.escape(opt['value'].lower())}(?![\w-])", text.lower()):
            opt["recommended"] = True
            return
    letter = re.search(r"(?:^|\s)([a-h])\)", text)
    for opt in card["options"]:
        if letter and opt["value"] == letter.group(1):
            opt["recommended"] = True
            return


def short_value(cell: str) -> str:
    """A recommendation that is itself an answer (`accept`, `keep them (they're tested)`):
    at most three words before any bracket or full stop."""
    head = re.split(r"[(.:;]", strip_md(BACKTICK.sub(lambda m: m.group(1), cell)), maxsplit=1)[0].strip()
    return head if head and len(head.split()) <= 3 else ""


def table_card(key: str, get, header: list[str]) -> dict:
    """One keyed table row as a card. Its choices come, in order, from the recommended cell
    when that is a choice, the answer or options cell, or lettered choices inside the
    question itself; a card with none of these is answered by writing one."""
    rec_col = column(header, "recommend")
    answer_col = next((i for i, name in enumerate(header) if "answer" in name), None)
    question = strip_md(get(column(header, "decision", "question", "change")))
    options = recommended_choices(get(rec_col))
    for col in dict.fromkeys(c for c in (answer_col, column(header, "other", "option", "choice")) if c is not None and c != rec_col):
        found = cell_choices(get(col))
        if found:
            options += [o for o in found if o["value"] not in {k["value"] for k in options}]
            break
    if not options and lettered(question):
        marks = list(LETTER.finditer(question))
        options = [option(letter, text) for letter, text in lettered(question)]
        question = question[: marks[0].start()].strip()
    recommended = get(rec_col)
    marked = [o for o in options if o["recommended"]]
    if len(marked) == 1 and marked[0]["note"]:
        recommended = marked[0]["note"]
    card = {"key": key, "question": question, "depends": strip_md(get(column(header, "depends"))), "recommended": recommended, "options": options}
    mark_recommended(card)
    if not options and short_value(recommended):
        card["options"] = [option(short_value(recommended), recommended=True)]
    return card


def parse_questionnaire(reply: str) -> dict | None:
    """The cards a reply asks to be answered, or None when it asks for no keyed answers.

    Cards come from keyed table rows, bold question leads with choice bullets, and keyed
    bullets the reply line asks about; a keyed bullet the reply does not ask about yet is
    a card that opens later. Every card also offers its example answer from the reply
    line and the extra answers the reply allows (`needs explanation`).
    """
    lines = reply.splitlines()
    reply_line = next((line for line in reversed(lines) if re.search(r"\breply with\b", line, re.I) and re.search(rf"{KEY}\s*=", line)), "")
    asked = set(re.findall(rf"\b({KEY})\s*=", reply_line))
    cards, resolved, locked, used = [], [], [], set()
    first_block = len(lines)
    # "## G2 explained: which moment fixes the cashback" names the card the text below explains.
    explained: dict[str, tuple[int, str]] = {}
    for n, line in enumerate(lines):
        heading = re.match(rf"^\s*#{{1,6}}\s+(.*\b({KEY})\b.*)$", line)
        if heading:
            explained.setdefault(heading.group(2), (n, strip_md(heading.group(1).split(":", 1)[-1])))
    option_tables: dict[str, list[dict]] = {}

    for start, end, header, rows in tables(lines):
        key_col = column(header, "id", "card")
        if key_col is None:
            # An "Option" table under a card's explaining heading lists that card's choices.
            owner = max(((at, key) for key, (at, _) in explained.items() if at < start), default=None)
            if owner and header and "option" in header[0]:
                for row in rows:
                    value = BACKTICK.search(row[0]) if row else None
                    if value:
                        option_tables.setdefault(owner[1], []).append(option(value.group(1), " · ".join(strip_md(c) for c in row[1:] if c),
                                                                             bool(re.search(r"recommend", row[0], re.I))))
            continue
        # A checkpoint table records answers already given ("Submitted answer", "Your answer").
        given_col = column(header, "submitted", "your answer")
        state_col = column(header, "state")
        for row in rows:
            get = lambda col: row[col] if col is not None and col < len(row) else ""
            key = strip_md(get(key_col))
            if not re.fullmatch(KEY, key):
                continue
            state = strip_md(get(state_col))
            if given_col is not None and key in asked and re.search(r"\b(?:open|explain|pending|waiting)", state, re.I):
                # Answered with a question ("Needs explanation") and asked again: still open.
                cards.append({"key": key, "question": explained.get(key, (0, ""))[1], "depends": "", "recommended": "", "options": []})
            elif given_col is not None:
                resolved.append({"key": key, "submitted": get(given_col), "decision": get(column(header, "inferred", "decision", "what i'll do")),
                                 "state": strip_md(get(state_col))})
            else:
                cards.append(table_card(key, get, header))
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
                options.append(option(bullet.group(1), bullet.group(2).strip(), bool(re.search(r"\brecommend", bullet.group(2), re.I))))
            m += 1
        key = lead.group(2)
        if not options and (key not in asked or key in {card["key"] for card in cards}):
            continue
        cards = [card for card in cards if card["key"] != key]  # a revised card replaces the earlier one
        resolved = [item for item in resolved if item["key"] != key]
        cards.append({"key": key, "question": strip_md(lead.group(3)) or strip_md(lead.group(1)), "depends": "",
                      "recommended": next((o["note"] for o in options if o["recommended"]), ""), "options": options})
        first_block = min(first_block, n)
        used.update(range(n, m))

    # A keyed bullet the reply line asks about is an open card ("- **A1:** which moment
    # fixes it. I recommend `order-creation`."); any other one opens later.
    known = {card["key"] for card in cards} | {item["key"] for item in resolved}
    for n, line in enumerate(lines):
        bullet = KEYED_BULLET.match(line)
        if not bullet or n in used or bullet.group(1) in known:
            continue
        key, text = bullet.group(1), bullet.group(2).strip()
        known.add(key)
        if key in asked:
            recommends = re.search(r"\brecommend\w*\b[^`]*`([^`]+)`", text, re.I)
            options = [option(value, recommended=bool(recommends and value == recommends.group(1))) for value in dict.fromkeys(BACKTICK.findall(text))]
            cards.append({"key": key, "question": strip_md(text), "depends": "", "recommended": "", "options": options})
            first_block = min(first_block, n)
        else:
            locked.append({"key": key, "text": text})

    for card in cards:
        for opt in option_tables.get(card["key"], []):
            if opt["value"] not in {o["value"] for o in card["options"]}:
                card["options"].append(opt)
        if not card["recommended"]:
            card["recommended"] = next((o["note"] for o in card["options"] if o["recommended"] and o["note"]), "")
    if not reply_line:
        # With no reply line asking for answers, only cards offering choices of their own
        # ask anything; a table of decisions already taken does not.
        cards = [card for card in cards if card["options"]]
    if not cards or not (reply_line or len(cards) > 1):
        return None
    examples, extras = reply_examples(lines, reply_line)
    for card in cards:
        values = {o["value"].lower() for o in card["options"]}
        for value in ([examples[card["key"]]] if card["key"] in examples else []) + extras:
            if value.lower() not in values:
                card["options"].append(option(value))
                values.add(value.lower())
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


def chain_questionnaires(chain: list[Path], parsed: Path, seen: set | None = None) -> list[dict]:
    """The questionnaires of one pane's sessions (a /clear chain), oldest log first, each with the
    keyed answers you sent after it. A pane cleared with /clear answers in its newest session, as in
    the reader. The hosted copy (sync.py) builds each conversation's sheet with this too."""
    seen = set() if seen is None else seen
    head = chain[-1].stem
    found = []
    for member in chain:
        if member in seen:
            continue
        seen.add(member)
        exchanges = builder.parsed_log(member, parsed)["exchanges"]
        if member.stem == head:
            builder.mark_compacted_away(exchanges)
        for index, exchange in enumerate(exchanges):
            questionnaire = parse_questionnaire(exchange["reply"]) if exchange["reply"] else None
            if not questionnaire:
                continue
            answer = next((later for later in exchanges[index + 1:] if later["source"] == "captain"), None)
            sent = sent_answers(answer["input"]) if answer else {}
            found.append({
                **questionnaire, "session": head, "at": exchange["reply_at"] or exchange["at"],
                "reply": exchange["reply"], "sent": sent, "sent_at": answer["at"] if answer and sent else None,
                **({"from_session": member.stem, "log": str(member)} if member.stem != head else {}),
                **({"compacted_away": True, "log": str(member)} if exchange.get("compacted_away") else {}),
            })
    return found


def collect(session_names: list[str]) -> list[dict]:
    labels = builder.pane_labels([], OUT / "pane-labels.json")  # refreshes the cache; read below
    try:
        cache = json.loads((OUT / "pane-labels.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cache = labels
    found, seen = [], set()
    for name in session_names:
        path = builder.find_session_file(name)
        if path:
            found += [{**q, "pane": cache.get(q["session"])} for q in chain_questionnaires(builder.session_chain(path), OUT / "parsed", seen)]
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
