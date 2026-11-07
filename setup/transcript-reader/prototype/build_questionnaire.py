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
import copy
import hashlib
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
    return [(m.group(1), strip_md(cell[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(cell)]).rstrip(" ;/"))
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


# "`a` yes, do it now; `b` wait for the build" - choices lettered in backticks, each followed by its words, inside one cell.
INLINE_MARK = re.compile(r"`([a-h])`")


def inline_options(cell: str) -> tuple[str, list[dict]]:
    """A cell that holds its question and its lettered choices together (`Fix it now: `a` yes; `b` wait`): the question before the first
    choice, and each choice with its words. Only backticked letters that run on from `a` (a, b, c, in order) are choices, so code the
    question quotes (`ok=false`, `main`) is never cut. (cell, []) when the cell has fewer than two."""
    run, want = [], "a"
    for mark in INLINE_MARK.finditer(cell):
        if mark.group(1) == want:
            run.append(mark)
            want = chr(ord(want) + 1)
    if len(run) < 2:
        return cell, []
    options = []
    for index, mark in enumerate(run):
        end = run[index + 1].start() if index + 1 < len(run) else len(cell)
        options.append(option(mark.group(1), strip_md(cell[mark.end(): end]).strip(" ;.,")))
    return strip_md(cell[: run[0].start()]).strip(" :;"), options


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
    """Mark the choice the card's recommendation names, by fixed rules, the first that finds one:
    a recommendation that opens with a choice's value, one that names a lettered choice
    (`Assume a)`, `**b).**`), and one that names exactly one of the card's choices anywhere in
    its text ("The **export** date", "Replace them with a dash"). When it names two or more
    choices, none is marked: the page must not guess between them. Nothing else is guessed."""
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
    # A one-character value is a letter (`a`), which a sentence uses as a word, so it is only ever matched as `a)` above.
    named = [opt for opt in card["options"] if len(opt["value"]) > 1
             and re.search(rf"(?<![\w-]){re.escape(opt['value'].lower())}(?![\w-])", text.lower())]
    if len(named) == 1:
        named[0]["recommended"] = True


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
    question_cell = get(column(header, "decision", "question", "change", "call"))
    question = strip_md(question_cell)
    options = recommended_choices(get(rec_col))
    # The question cell may hold the choices too (`...: `a` yes; `b` no`): they come with their words, and the recommended cell only marks one.
    inline_question, inline = inline_options(question_cell)
    if inline:
        question = inline_question
        marked_values = {o["value"] for o in options}
        options = [{**o, "recommended": o["recommended"] or o["value"] in marked_values} for o in inline]
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


# A table with a key column is a table of cards only if it asks something: a decision or question to answer, a recommendation, answers or
# options to pick from, or what a card depends on. "Key | In plain words" (a glossary of calls from an earlier reply) and "Key | Piece | State"
# (a status list) name keys and ask nothing.
CARD_COLUMNS = ("decision", "question", "change", "call", "recommend", "answer", "option", "choice", "depends", "submitted")


def _parse_questionnaire(reply: str) -> dict | None:
    """The cards a reply asks to be answered, or None when it asks for no keyed answers.

    Cards come from keyed table rows, bold question leads with choice bullets, and keyed
    bullets the reply line asks about; a keyed bullet the reply does not ask about yet is
    a card that opens later. Every card also offers its example answer from the reply
    line and the extra answers the reply allows (`needs explanation`).

    One sheet is one review group. The keys the reply line asks for name the group (their letters: `X1=...; X2=...` is group X), so a
    keyed table row of another group that the reply mentions (a recap of earlier calls) is left out (`left_out`), and so is the section
    of the text above the sheet that holds nothing but such a recap or a glossary of keys.
    """
    lines = reply.splitlines()
    reply_line = next((line for line in reversed(lines) if re.search(r"\breply (?:with|like)\b", line, re.I) and re.search(rf"{KEY}\s*=", line)), "")
    asked = set(re.findall(rf"\b({KEY})\s*=", reply_line))
    cards, resolved, locked, used = [], [], [], set()
    first_block = len(lines)
    blocks: dict[str, int] = {}  # a card's (or an answered card's, as "=" and its key) first line
    spans: list[tuple[set[str], int, int]] = []  # each table of keyed rows or run of a card's lines: its keys and its lines
    glossaries: list[tuple[int, int]] = []  # keyed tables that ask nothing (a glossary of earlier calls, a status list)
    # "## G2 explained: which moment fixes the cashback" names the card the text below explains.
    explained: dict[str, tuple[int, str]] = {}
    for n, line in enumerate(lines):
        heading = re.match(rf"^\s*#{{1,6}}\s+(.*\b({KEY})\b.*)$", line)
        if heading:
            explained.setdefault(heading.group(2), (n, strip_md(heading.group(1).split(":", 1)[-1])))
    option_tables: dict[str, list[dict]] = {}

    for start, end, header, rows in tables(lines):
        key_col = column(header, "id", "card", "key")
        if key_col is not None and not any(column(header, name) is not None for name in CARD_COLUMNS):
            # A glossary or a status list: it names keys and asks nothing. (A table whose "id" column holds no key at all, such as a
            # Slide | Who sees it | Taps table, is only a table in the text.)
            if any(key_col < len(row) and re.fullmatch(KEY, strip_md(row[key_col])) for row in rows):
                glossaries.append((start, end))
            continue
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
                blocks[key] = start
            elif given_col is not None:
                resolved.append({"key": key, "submitted": get(given_col), "decision": get(column(header, "inferred", "decision", "what i'll do")),
                                 "state": strip_md(get(state_col))})
                blocks["=" + key] = start
            else:
                cards.append(table_card(key, get, header))
                blocks[key] = start
            first_block = min(first_block, start)
            used.update(range(start, end))
        spans.append(({strip_md(row[key_col]) for row in rows if key_col < len(row)}, start, end))

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
        blocks[key] = n
        first_block = min(first_block, n)
        used.update(range(n, m))
        spans.append(({key}, n, m))

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
            blocks[key] = n
            first_block = min(first_block, n)
        else:
            locked.append({"key": key, "text": text})

    for card in cards:
        for opt in option_tables.get(card["key"], []):
            if opt["value"] not in {o["value"] for o in card["options"]}:
                card["options"].append(opt)
        if not card["recommended"]:
            card["recommended"] = next((o["note"] for o in card["options"] if o["recommended"] and o["note"]), "")
    # One review group: the keys the reply line asks for name it by their letters. Cards of other letters (a recap of earlier calls) are left
    # out, unless none of the cards is of the group, when the reply line is the sloppy part and every card stays.
    groups = {key[0] for key in asked}
    left_out: list[str] = []
    if groups and any(card["key"][0] in groups for card in cards):
        left_out = [card["key"] for card in cards if card["key"][0] not in groups]
        cards = [card for card in cards if card["key"][0] in groups]
    recaps = list(glossaries)
    if left_out:
        starts = [blocks[card["key"]] for card in cards if card["key"] in blocks] + [at for name, at in blocks.items() if name.startswith("=")]
        first_block = min(starts, default=len(lines))
        recaps += [(start, end) for keys, start, end in spans if keys and keys <= set(left_out)]
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
    # The text above the sheet is the reply's own, without the sections that are only a recap of other groups' calls or a glossary of keys
    # (a table above first_block that was left out): the section from its heading to the next of its level, or just the table when the
    # section goes on to the cards.
    drop: set[int] = set()
    for start, end in recaps:
        if start >= first_block:
            continue
        drop.update(range(start, min(end, first_block)))
        above = next((n for n in range(start - 1, -1, -1) if re.match(r"^\s*#{1,6}\s+\S", lines[n])), None)
        if above is None:
            continue
        level = len(re.match(r"^\s*(#+)", lines[above]).group(1))
        below = next((n for n in range(end, len(lines)) if (m := re.match(r"^\s*(#+)\s+\S", lines[n])) and len(m.group(1)) <= level), len(lines))
        if below <= first_block:
            drop.update(range(above, below))
    intro = [line for n, line in enumerate(lines[:first_block]) if n not in drop]
    title = strip_md(lines[0].lstrip("#")) if lines else ""
    if drop:  # the reply's first line may have been a recap's heading: the sheet is named for what is left
        title = strip_md(next((line for line in intro if line.strip()), "").lstrip("#"))
    return {
        "title": title,
        "intro": re.sub(r"\n{3,}", "\n\n", "\n".join(intro)).strip(),
        "cards": cards, "resolved": resolved, "locked": locked, "corrections": corrections, "left_out": left_out,
        "reply_line": strip_md(reply_line),
    }


# A rebuild reads every reply again, and which cards a reply asks for depends on its text alone, so a process that builds more
# than once keeps the answer by a digest of the text (never the text itself) and hands out a copy of it.
_PARSED: dict[bytes, dict | None] = {}
PARSED_KEPT = 20000


def parse_questionnaire(reply: str) -> dict | None:
    """The cards a reply asks to be answered (see _parse_questionnaire), or None when it asks for no keyed answers."""
    key = hashlib.sha1(reply.encode("utf-8", "surrogatepass")).digest()
    if key not in _PARSED:
        if len(_PARSED) >= PARSED_KEPT:
            _PARSED.clear()
        _PARSED[key] = _parse_questionnaire(reply)
    found = _PARSED[key]
    return copy.deepcopy(found) if found else found


def sent_answers(text: str) -> dict[str, str]:
    """Keyed answers in a message the captain sent, such as `A1=accept;A2=inline`."""
    return {key: value.strip() for key, value in KEYED_ANSWER.findall(text)}


def member_questionnaires(member: Path, head: str, parsed: Path) -> list[dict]:
    """The questionnaires of one log of a pane's chain whose newest session is <head>, oldest first, each with the keyed answers you sent
    after it (new objects, which a caller may change)."""
    exchanges = builder.parsed_log(member, parsed)["exchanges"]
    if member.stem == head:
        builder.mark_compacted_away(exchanges)
    found = []
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


# A worker builds the sheet again after each change to a log, and nearly every log is as it was: what a log asked is kept, by the log's
# path and version, for the pane's newest session it is shown under (the sheet names it), and handed out as it is (the sheet only reads it).
_MEMBERS: dict[tuple[str, str], tuple[tuple, list[dict]]] = {}


def kept_questionnaires(member: Path, head: str, parsed: Path) -> list[dict]:
    """member_questionnaires, from what an earlier build of this process found while the log and the rules are the same. The objects are
    shared with that build: for a page that only writes them out."""
    version = (builder.file_version(member), builder.PARSE_RULES)
    known = _MEMBERS.get((str(member), head))
    if known and version[0] is not None and known[0] == version:
        return known[1]
    found = member_questionnaires(member, head, parsed)
    if version[0] is not None:
        if len(_MEMBERS) >= PARSED_KEPT:
            _MEMBERS.clear()
        _MEMBERS[(str(member), head)] = (version, found)
    return found


def chain_questionnaires(chain: list[Path], parsed: Path, seen: set | None = None, kept: bool = False) -> list[dict]:
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
        found += (kept_questionnaires if kept else member_questionnaires)(member, head, parsed)
    return found


def open_cards(questionnaire: dict) -> list[dict]:
    """The cards no keyed answer in the session covers yet. The page counts them the same way (questionnaire.html, openCards)."""
    sent = questionnaire.get("sent") or {}
    return [card for card in questionnaire["cards"] if card["key"] not in sent]


def list_entry(questionnaire: dict) -> dict:
    """One line of the hosted copy's picker: when it was asked, how many cards are still open (none: the session answered them
    all), and its title."""
    return {"at": questionnaire["at"], "open": len(open_cards(questionnaire)), "title": questionnaire["title"]}


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
            found += [{**q, "pane": cache.get(q["session"])} for q in chain_questionnaires(builder.session_chain(path), OUT / "parsed", seen, kept=True)]
    found.sort(key=lambda q: q["at"] or 0, reverse=True)
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--session", action="append", help="session id or path (default: the reader's list)")
    parser.add_argument("--out", default=str(OUT / "questionnaire.html"))
    args = parser.parse_args(argv)
    names = args.session
    if not names:
        try:
            names = [l.strip() for l in (OUT / "sessions.txt").read_text(encoding="utf-8").splitlines() if l.strip()]
        except OSError:
            names = []
    payload = {"generated": time.time(), "questionnaires": collect(names)}
    out = Path(args.out).expanduser()
    builder.write_page(TEMPLATE, payload, out, only_if_changed=True)
    print(f"Wrote {out}")
    for q in payload["questionnaires"]:
        print(f"  {q['session'][:8]} {len(open_cards(q))} open, {len(q['resolved'])} answered, {len(q['locked'])} locked: {q['title'][:70]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
