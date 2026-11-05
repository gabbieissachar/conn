#!/usr/bin/env python3
"""The replies marked from the reader page as "this should be an answer sheet" or "this sheet is wrong".

The page's "Sheet" control on a reply (served page only) keeps a mark in an owner-only file outside the repo
(~/.config/pmos-transcript-reader/sheet-flags.json, or PMOS_READER_SHEET_FLAGS): the reply's turn id, its conversation, its time and the
kind of mark, never its text. This reads that file, finds each marked reply in its session log, says what the sheet finder makes of it now,
and prints the reply's SHAPE, its words masked, to write a parser fixture from:

  python3 setup/transcript-reader/reader.py sheet-flags                    the marked replies and what the finder makes of each now
  python3 setup/transcript-reader/reader.py sheet-flags --shape <turn id>  one reply's shape, words masked (a turn id, or its first characters)

A fixture is two files in setup/transcript-reader/answer-sheet-fixtures/: <name>.md, the shape filled with INVENTED words (never the
private reply), and <name>.expect.json, the sheet it must give. test_questionnaire.py (FlaggedFixturesTest) runs every pair.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_prototype as builder  # noqa: E402
import build_questionnaire as sheets  # noqa: E402

KINDS = {"missing": "should be an answer sheet", "wrong": "its sheet is wrong"}
# Words that carry the structure the finder reads (table headings, "Reply like", "recommend"): the shape keeps them and masks every other word.
STRUCTURE = {
    "reply", "with", "like", "key", "card", "id", "call", "decision", "question", "change", "depends", "on", "recommended", "recommend",
    "default", "answer", "submitted", "your", "inferred", "state", "option", "options", "choice", "choices", "pick", "one", "of", "you",
    "can", "also", "write", "use", "revised", "explained", "open", "resolved", "pending", "waiting", "explain", "locked", "until",
    "checkpoint", "group", "other", "what", "i'll", "do",
}
# Inside backticks only a lettered choice and a keyed answer line stay (`a`, `R1=a; R2=a; ...`); any other code is masked.
KEEP_TICKED = re.compile(rf"^(?:[a-h]|(?:{sheets.KEY}\s*=\s*[^;`\s]*;?\s*|\.\.\.\s*)+)$")
WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'_-]*")


def flags_file() -> Path:
    return Path(os.environ.get("PMOS_READER_SHEET_FLAGS") or Path.home() / ".config" / "pmos-transcript-reader" / "sheet-flags.json")


def read_flags(path: Path | None = None) -> list[dict]:
    """The marks, oldest first. An unreadable or absent file is none."""
    try:
        saved = json.loads((path or flags_file()).read_text(encoding="utf-8"))
        flags = [flag for flag in saved["flags"] if isinstance(flag, dict) and isinstance(flag.get("key"), str)]
    except (OSError, ValueError, KeyError, TypeError):
        return []
    return sorted(flags, key=lambda flag: flag.get("flagged") or 0)


def mask(text: str) -> str:
    """The reply with its words masked as `x`, leaving its structure: table pipes and headings, keys (R1), lettered choices in backticks, the
    words of STRUCTURE, bold and list marks, and where the words fall. Nothing of what the reply says is left."""
    def word(match: re.Match) -> str:
        found = match.group(0)
        return found if re.fullmatch(sheets.KEY, found) or found.lower() in STRUCTURE else "x"

    def ticked(match: re.Match) -> str:
        return match.group(0) if KEEP_TICKED.match(match.group(1)) else "`x`"

    out = []
    for line in text.splitlines():
        parts = re.split(r"(`[^`]*`)", line)
        out.append("".join(ticked(re.match(r"`([^`]*)`", part)) if part.startswith("`") and part.endswith("`") and len(part) > 1 else WORD.sub(word, part) for part in parts))
    return "\n".join(out)


def find_reply(turn: str, conv: str) -> tuple[str, float] | None:
    """The text and time of the reply of turn <turn> in conversation <conv> (the newest session of a pane, whose chain is read), or None."""
    path = builder.find_session_file(conv)
    if not path:
        return None
    cache = HERE.parent / "out" / "parsed"
    for member in builder.session_chain(path):
        for exchange in builder.parsed_log(member, cache)["exchanges"]:
            if exchange.get("uid") == turn and exchange.get("reply"):
                return exchange["reply"], exchange.get("reply_at") or exchange.get("at") or 0
    return None


def when(epoch: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(epoch)) if epoch else "?"


def listing(flags: list[dict]) -> list[str]:
    if not flags:
        return ["No replies are marked. Use the Sheet control on a reply in the served page."]
    lines = []
    for flag in flags:
        turn = flag["key"].split(":")[0]
        found = find_reply(turn, flag.get("conv", ""))
        if not found:
            now = "reply not found in its log any more"
        else:
            sheet = sheets.parse_questionnaire(found[0])
            now = f"now an answer sheet with {len(sheet['cards'])} question{'' if len(sheet['cards']) == 1 else 's'}" if sheet else "now no answer sheet"
        lines.append(f"{flag.get('kind', '?'):7}  marked {when(flag.get('flagged') or 0)}  reply {when(flag.get('at') or 0)}  turn {turn}  ({KINDS.get(flag.get('kind'), '?')}; {now})")
    lines.append("")
    lines.append("To keep one as a parser test: reader.py sheet-flags --shape <turn id>, fill the shape with invented words, and add it to answer-sheet-fixtures/ with its .expect.json.")
    return lines


def shape_of(prefix: str, flags: list[dict]) -> str:
    chosen = [flag for flag in flags if flag["key"].split(":")[0].startswith(prefix)]
    if len(chosen) != 1:
        raise SystemExit(f"{len(chosen)} marked replies start with {prefix!r}; give more of the turn id." if chosen else f"no marked reply starts with {prefix!r}")
    flag = chosen[0]
    found = find_reply(flag["key"].split(":")[0], flag.get("conv", ""))
    if not found:
        raise SystemExit("that reply is not in its session log any more")
    return mask(found[0])


def main(argv: list[str]) -> int:
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    flags = read_flags()
    if argv[:1] == ["--shape"] and len(argv) == 2:
        print(shape_of(argv[1], flags))
        return 0
    if argv:
        print(__doc__.strip())
        return 2
    print("\n".join(listing(flags)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
