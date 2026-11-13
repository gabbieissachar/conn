"""Reading a captain hold's prose into calls.

A hold written before typed ask records exists as one free-text reason. The board still shows such a call, so this module splits a reason
into numbered calls (R1 R2 ..., Q1 ..., 1) 2) ...) and pulls lettered options out of one (`stem: a text (recommended) / b text / c text`).
It is the prototype's rule set (data/task-board-prototype, report section 5, R1b), kept as text rules because old calls stay prose; a call
that has a typed record never goes through here. Nothing is masked: the board is the owner's own page on their own machine.
"""

from __future__ import annotations

import re
from collections import Counter

LABEL = re.compile(r"(?:(?<=[.;] )|(?<=\) )|^)((?:[A-Z]{1,2}\d{1,2})|\d{1,2}\)|Decision \d{1,2}:?|\(\d{1,2}\))(?=[\s:=.,)])(?![-/])")
GO = re.compile(r"(dispatch on (his|nathan'?s?) word|wait for more|start only on nathan|not scheduled|on his word|dispatch on)", re.I)
LEAD = re.compile(r"^(?:[\w' ]{0,40}?)(?:[Rr]eport|[Pp]roposal|[Dd]raft)\s*(?:at )?data/\S+?\.md(?:\s+(?:section|'s)?\s?[^.:;]{0,50}?)?[.:;,]\s*")


def clip(text: str | None, limit: int) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def clean_question(text: str) -> str:
    """Drop a leading 'Report data/x.md section 3:' pointer and capitalise the first word (unless it is a path or an identifier)."""
    text = text.strip()
    for _ in range(2):
        shorter = LEAD.sub("", text, count=1)
        if shorter != text and len(shorter) > 15:
            text = shorter
    first = text.split(" ")[0] if text else ""
    if not text or re.search(r"[-_./]", first):
        return text
    return text[:1].upper() + text[1:]


def parse_options(text: str) -> tuple[str, list[dict]]:
    """'stem: a text (recommended) / b text / c text' or 'a) ... / b) ...' -> (stem, options). Needs a and b; otherwise (text, [])."""
    if not re.search(r"\sa\)?(?:\s|$).*\s/\s+b\)?(?:\s|$)", text, re.S):
        return text, []
    candidates = []
    for found in re.finditer(r"(?::\s+|\s)a\)?(?=\s|$)", text):
        if re.search(r"\s/\s+b\)?(?:\s|$)", text[found.end():]):
            candidates.append(found)
    colon = [c for c in candidates if c.group(0).startswith(":")]
    best = colon[-1] if colon else (candidates[0] if candidates else None)
    if not best:
        return text, []
    stem = text[: best.start()].strip(" :")
    rest = text[best.end():].strip()
    segments = re.split(r"\s+/\s+(?=[b-e]\)?(?:\s|$))", rest)
    if len(segments) < 2:
        return text, []
    options = []
    for index, segment in enumerate(segments):
        letter = "abcde"[index] if index < 5 else str(index)
        if index:
            segment = re.sub(r"^[b-e]\)?\s*", "", segment)
        recommended = bool(re.search(r"recommend", segment, re.I))
        segment = re.sub(r"\s*\(\s*recommended[^)]*\)", "", segment)
        segment = re.sub(r"\s*\(recommended\)?", "", segment).strip(" .;")
        # A trailing sentence that starts the next question is not part of the option.
        segment = re.split(r"\.\s+(?=[A-Z]{1,2}\d|Report\b|Context\b)", segment)[0].strip(" .;")
        options.append({"k": letter, "t": clip(segment, 110) or ("the recommended answer" if recommended else ""), "rec": recommended})
    return stem, options


def split_hold(reason: str) -> tuple[str, list[tuple[str, str]]]:
    """A hold reason -> (head, [(key, body)]). One call comes back as ('', ...) with the whole text and an empty key."""
    text = reason.strip()
    hits = [(m.start(1), m.group(1)) for m in LABEL.finditer(text)]
    if not hits:
        return text, [("", text)]

    def prefix(label: str) -> str:
        return re.sub(r"\d+|[():]", "", label).strip() or "#"

    commonest = Counter(prefix(label) for _, label in hits).most_common(1)[0][0]
    hits = [(pos, label) for pos, label in hits if prefix(label) == commonest]
    seen, unique = set(), []
    for pos, label in hits:
        key = label.strip("():")
        if key in seen:
            continue
        seen.add(key)
        unique.append((pos, label, key))
    if len(unique) < 2:
        return text, [("", text)]
    head = text[: unique[0][0]].strip()
    parts = []
    for index, (pos, label, key) in enumerate(unique):
        end = unique[index + 1][0] if index + 1 < len(unique) else len(text)
        body = text[pos + len(label): end].strip(" :.;,")
        parts.append((key.rstrip(")"), body))
    parts = [(key, body) for key, body in parts if len(body) >= 14]
    if len(parts) < 2:
        return text, [("", text)]
    return head, parts


def call_type(body: str, options: list) -> str:
    """'go' when the call only waits for the owner's word (no choices), else 'q'."""
    return "go" if (GO.search(body) and not options) else "q"
