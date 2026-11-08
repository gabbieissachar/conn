#!/usr/bin/env python3
"""Freeze the answer sheets of the reading list: every reply that asks for keyed answers, with the sheet the parser makes of it now.

The plan's S3 changes what the reading list is, so the corpus of "every reply of the reading list" would dissolve. This writes it down
once. For each reply that makes a sheet it saves

  frozen/<digest>.md           the reply, as the model wrote it (private text)
  frozen/<digest>.expect.json  the sheet the parser makes of it (`parse`), the ask box's cards (`sheet_cards`), the keys no keyed
                               answer covers yet (`open_keys`), and the captain's next message with the keyed answers read from it
                               (`answer_input`, `sent`)
  frozen-manifest.json         one row per reply with digests and counts only: nothing private, so it is tracked

<digest> is the first 12 hex characters of the sha-256 of the reply text. The same text in two sessions is one entry.

`frozen/` holds private text and is gitignored (answer-sheet-fixtures/.gitignore); test_frozen_sheets.py checks it when it is there and
checks the manifest alone when it is not. The tracked fixtures beside it are invented text and need none of this.

Usage (from the repo root):
  python3 setup/transcript-reader/freeze_sheets.py [--sessions FILE] [--parsed DIR] [--out DIR]

--sessions is a reading-list file (default out/sessions.txt); --parsed a folder of parsed logs, which the run fills when it parses (default a
temporary one, so the live reader's out/ is never written). Nothing is deleted: an entry already there with other content stops the run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "prototype"))
import build_prototype as builder  # noqa: E402
import build_questionnaire as questionnaires  # noqa: E402

FIXTURES = HERE / "answer-sheet-fixtures"
FROZEN = FIXTURES / "frozen"
MANIFEST = FIXTURES / "frozen-manifest.json"
MANIFEST_VERSION = 1


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def expectation(reply: str, answer_input: str) -> dict:
    """What the sheet of <reply> is now, and what the captain's next message answered of it."""
    parsed = questionnaires.parse_questionnaire(reply)
    if parsed is None:
        raise ValueError("the reply makes no sheet")
    sent = questionnaires.sent_answers(answer_input) if answer_input else {}
    return {
        "parse": parsed,
        "sheet_cards": builder.sheet_cards(parsed),
        "open_keys": [card["key"] for card in questionnaires.open_cards({**parsed, "sent": sent})],
        "answer_input": answer_input,
        "sent": sent,
    }


def manifest_row(reply: str, expect: dict) -> dict:
    """The row that stands for one frozen reply in the tracked manifest: digests and counts, no text."""
    parsed = expect["parse"]
    return {
        "id": digest(reply)[:12],
        "reply_sha256": digest(reply),
        "expect_sha256": digest(canonical(expect)),
        "cards": len(parsed["cards"]),
        "keys": [card["key"] for card in parsed["cards"]],
        "resolved": len(parsed["resolved"]),
        "locked": len(parsed["locked"]),
        "sent_keys": sorted(expect["sent"]),
    }


def collect(names: list[str], parsed_cache: Path) -> list[dict]:
    """Every reply of the listed conversations that makes a sheet, with the next captain message after it, oldest first per chain."""
    found, seen = [], set()
    for name in names:
        path = builder.find_session_file(name)
        if not path:
            continue
        for member in builder.session_chain(path):
            if member in seen:
                continue
            seen.add(member)
            exchanges = builder.parsed_log(member, parsed_cache)["exchanges"]
            for index, exchange in enumerate(exchanges):
                if not exchange["reply"] or not questionnaires.parse_questionnaire(exchange["reply"]):
                    continue
                later = next((e for e in exchanges[index + 1:] if e["source"] == "captain"), None)
                found.append({"reply": exchange["reply"], "answer_input": later["input"] if later else ""})
    return found


def write_new(path: Path, text: str) -> bool:
    """Write <path> unless it holds exactly <text> already; stop on other content. True when it was written."""
    if path.exists():
        if path.read_text(encoding="utf-8") == text:
            return False
        raise SystemExit(f"{path} already holds other content; refusing to overwrite it")
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sessions", default=str(HERE / "out" / "sessions.txt"))
    parser.add_argument("--parsed", help="folder of parsed logs (default: a temporary one)")
    parser.add_argument("--out", default=str(FROZEN))
    parser.add_argument("--manifest", default=str(MANIFEST))
    args = parser.parse_args(argv)
    names = [line.strip() for line in Path(args.sessions).expanduser().read_text(encoding="utf-8").splitlines() if line.strip()]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    out.chmod(0o700)
    with tempfile.TemporaryDirectory() as scratch:
        cache = Path(args.parsed) if args.parsed else Path(scratch)
        cache.mkdir(parents=True, exist_ok=True)
        replies = collect(names, cache)
    rows, written, seen = [], 0, set()
    for item in replies:
        key = digest(item["reply"])[:12]
        if key in seen:
            continue
        seen.add(key)
        expect = expectation(item["reply"], item["answer_input"])
        written += write_new(out / f"{key}.md", item["reply"])
        written += write_new(out / f"{key}.expect.json", json.dumps(expect, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
        rows.append(manifest_row(item["reply"], expect))
    rows.sort(key=lambda row: row["id"])
    manifest = {"version": MANIFEST_VERSION, "replies": len(replies), "unique": len(rows), "entries": rows}
    Path(args.manifest).write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(replies)} replies make a sheet, {len(rows)} distinct; {written} file(s) written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
