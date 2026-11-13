#!/usr/bin/env python3
"""Builds what the embed page's browser check (embed-check.js) opens: the embed page itself, and a reference page made by the reader.

  python3 setup/transcript-reader/e2e/embed_lab.py <folder>

Under <folder> it writes
  page/embed.html           the embed page, as a build writes it to out/live/embed.html (no transcript, no token)
  ref/out/prototype.html    the reader's own page for a made-up Claude conversation that says what embed-fixtures/campus-conversation.json
                            says (the same messages, the same markdown, the same tool calls and their output), built from a scratch HOME
and prints one JSON line with both paths and the conversation's id. The reference is how the check holds the embed page to "looks exactly like a
Claude session": the same words go through the reader's own parser and page, and the two pages' styles are compared element by element.
Nothing real is read: HOME and the projects folder are scratch, and there is no Herdr.
"""

import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
READER = HERE.parent
sys.path.insert(0, str(READER / "prototype"))

FIXTURE = READER / "embed-fixtures" / "campus-conversation.json"
SESSION = "aaaa1111-2222-4333-8444-555566667777"
CWD = "/lab/ref"
# The tool names a Claude log uses for the tools the fixture's Campus names stand for.
CLAUDE_TOOL = {"read": "Read", "bash": "Bash", "grep": "Grep", "edit": "Edit", "write": "Write"}


def iso(at: float) -> str:
    return datetime.fromtimestamp(at, timezone.utc).isoformat().replace("+00:00", "Z")


def tool_input(name: str, argument: str) -> dict:
    return {"Read": {"file_path": argument}, "Bash": {"command": argument}, "Grep": {"pattern": argument},
            "Edit": {"file_path": argument, "old_string": "a", "new_string": "b"}, "Write": {"file_path": argument, "content": "x"}}[name]


def claude_records(blocks: list[dict]) -> list[dict]:
    """The fixture's blocks as the records Claude Code writes: your message, then the agent's tool calls and their results, then its text."""
    records, calls = [], 0
    base = {"cwd": CWD, "sessionId": SESSION}
    for block in blocks:
        if block["kind"] == "user":
            records.append({"type": "user", "uuid": str(uuid.uuid4()), "timestamp": iso(block["at"]), **base, "message": {"role": "user", "content": block["text"]}})
            continue
        made = []
        for tool in block.get("tools", []):
            calls += 1
            name = CLAUDE_TOOL[tool["tool"]]
            made.append((f"toolu_{calls:04d}", name, tool))
        if made:
            records.append({"type": "assistant", "uuid": str(uuid.uuid4()), "timestamp": iso(block["at"] - 5), **base, "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": call, "name": name, "input": tool_input(name, tool["argument"])} for call, name, tool in made]}})
            records.append({"type": "user", "uuid": str(uuid.uuid4()), "timestamp": iso(block["at"] - 4), **base, "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": call, "content": tool["output"] or "ok", "is_error": tool["status"] == "failed"} for call, name, tool in made]}})
        records.append({"type": "assistant", "uuid": str(uuid.uuid4()), "timestamp": iso(block["at"]), **base, "message": {"role": "assistant", "content": [{"type": "text", "text": "\n\n".join(block["texts"])}]}})
    return records


def main(folder: Path) -> None:
    import build_prototype as builder

    page = folder / "page"
    page.mkdir(parents=True, exist_ok=True)
    embed, _ = builder.embed_shell()
    (page / "embed.html").write_text(embed, encoding="utf-8")

    home = folder / "ref" / "home"
    projects = home / ".claude" / "projects" / "-lab-ref"
    projects.mkdir(parents=True, exist_ok=True)
    log = projects / f"{SESSION}.jsonl"
    log.write_text("".join(json.dumps(record) + "\n" for record in claude_records(json.loads(FIXTURE.read_text(encoding="utf-8"))["blocks"])), encoding="utf-8")
    out = folder / "ref" / "out"
    out.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "HOME": str(home), "PMOS_READER_PROJECTS": str(home / ".claude" / "projects")}
    subprocess.run([sys.executable, str(READER / "prototype" / "build_prototype.py"), "--session", str(log), "--listed", "--main-home", str(folder / "ref" / "no-home"),
                    "--out", str(out / "prototype.html")], env=env, check=True, capture_output=True, timeout=180)
    print(json.dumps({"embed": str(page / "embed.html"), "reference": str(out / "prototype.html"), "session": SESSION}))


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
