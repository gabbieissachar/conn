#!/usr/bin/env python3
"""Keep a list of sessions to read and rebuild the transcript reader page from it.

Usage (from the repo root):
  python3 setup/transcript-reader/reader.py                  rebuild every listed session (picks up new turns)
  python3 setup/transcript-reader/reader.py add <session>... add sessions, then rebuild
  python3 setup/transcript-reader/reader.py remove <session>...
  python3 setup/transcript-reader/reader.py list             the listed sessions
  python3 setup/transcript-reader/reader.py panes            live Herdr panes, to pick from
  python3 setup/transcript-reader/reader.py rebuild          rebuild only (the server runs this when a log changes)
  python3 setup/transcript-reader/reader.py follow <id>      add one full session id, then rebuild only
                                                             (the server runs this for the pane Herdr focuses)

<session> is a session id, its first 8 characters, a session log path, or a
Herdr pane label (exact, or a unique part of the label or the pane's title).

The list lives in out/sessions.txt, the reader in out/prototype.html and the
answer sheet (replies that ask for keyed answers) in out/questionnaire.html, all
gitignored because they name or embed private sessions. The pages are served by
setup/serve.sh, which also follows Herdr's focus and sends replies to a pane (see
README.md); set PMOS_SERVE_PORT when that port serves a different copy of the
repo. Only session logs and Herdr's pane list are read, and only out/ is written.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "prototype"))
import build_prototype as builder  # noqa: E402

OUT = HERE / "out"
LIST = OUT / "sessions.txt"
PAGE = OUT / "prototype.html"
REPO = HERE.parent.parent
UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
PREFIX = re.compile(r"^[0-9a-f]{6,}[0-9a-f-]*$")


def read_list() -> list[str]:
    try:
        lines = LIST.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    return [line.strip() for line in lines if line.strip() and not line.startswith("#")]


def write_list(ids: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    LIST.write_text("".join(f"{i}\n" for i in ids), encoding="utf-8")


def session_files(projects: Path, prefix: str) -> list[Path]:
    return sorted(projects.glob(f"*/{prefix}*.jsonl"))


def resolve(name: str, panes: dict[str, dict], projects: Path = builder.PROJECTS) -> str:
    """The session id that <name> means. Raises ValueError with a readable reason."""
    path = Path(name).expanduser()
    if path.suffix == ".jsonl" and path.is_file():
        return path.stem
    if PREFIX.match(name):
        ids = sorted({p.stem for p in session_files(projects, name)})
        if len(ids) == 1:
            return ids[0]
        if len(ids) > 1:
            raise ValueError(f"{name} matches {len(ids)} sessions; give more characters")
        if UUID.match(name):
            raise ValueError(f"no session log found for {name}")
    wanted = name.casefold()
    exact = [sid for sid, pane in panes.items() if pane["label"].casefold() == wanted]
    partial = [sid for sid, pane in panes.items() if wanted in pane["label"].casefold() or wanted in pane["title"].casefold()]
    for found in (exact, partial):
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            names = ", ".join(sorted(f"{panes[s]['herdr']} › {panes[s]['label']}" for s in found))
            raise ValueError(f"{name!r} matches several panes ({names}); be more specific")
    raise ValueError(f"no session or Herdr pane matches {name!r}; run `panes` to see the live ones")


def rebuild(ids: list[str], focus: str | None = None, serve_page: bool = True) -> int:
    if not ids:
        print("No sessions listed yet. Add one: reader.py add <session id or Herdr pane label>")
        return 1
    present = [i for i in ids if builder.find_session_file(i)]
    for missing in sorted(set(ids) - set(present)):
        print(f"Skipping {missing}: its session log is gone")
    if not present:
        return 1
    argv = ["--out", str(PAGE)] + [arg for sid in present for arg in ("--session", sid)]
    if subprocess.run([sys.executable, "-I", str(HERE / "prototype" / "build_prototype.py"), *argv]).returncode:
        return 1
    # The answer-sheet prototype reads the same list: replies that ask for keyed answers.
    questions = [arg for sid in present for arg in ("--session", sid)]
    if subprocess.run([sys.executable, "-I", str(HERE / "prototype" / "build_questionnaire.py"), *questions]).returncode:
        return 1
    if serve_page:
        serve(focus)
    return 0


def serve(focus: str | None) -> None:
    """Start setup/serve.sh if needed and print the page address."""
    port = os.environ.get("PMOS_SERVE_PORT", "8765")
    subprocess.run(["bash", str(REPO / "setup" / "serve.sh"), "--port", port], cwd=REPO, stdout=subprocess.DEVNULL)
    url = f"http://localhost:{port}/{PAGE.relative_to(REPO).as_posix()}"
    sheet = f"http://localhost:{port}/{(OUT / 'questionnaire.html').relative_to(REPO).as_posix()}"
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            ok = response.status == 200
    except OSError:
        ok = False
    anchor = f"#s={focus[:8]}" if focus else ""
    if ok:
        # Served, the pages refresh themselves, follow Herdr's focus and can send replies.
        print(f"Reader:       {url}{anchor}")
        print(f"Answer sheet: {sheet}")
    else:
        print(f"Port {port} does not serve this copy of the repo, so these read-only file links cannot send or follow:")
        print(f"Reader:       {PAGE.as_uri()}{anchor}")
        print(f"Answer sheet: {(OUT / 'questionnaire.html').as_uri()}")


def follow(ids: list[str], names: list[str]) -> int:
    """Add one full session id that has a log, then rebuild without starting the server."""
    if len(names) != 1 or not UUID.match(names[0]) or not session_files(builder.PROJECTS, names[0]):
        print("follow takes one full session id that has a session log")
        return 2
    if names[0] not in ids:
        ids.append(names[0])
        write_list(ids)
    return rebuild(ids, serve_page=False)


def show(ids: list[str]) -> None:
    labels = builder.pane_labels(ids, OUT / "pane-labels.json")
    for sid in ids:
        pane = labels.get(sid)
        where = f"{pane['herdr']} › {pane['label']}" + ("" if pane["live"] else " (pane closed)") if pane else "no Herdr pane"
        print(f"{sid[:8]}  {where}")


def main(argv: list[str]) -> int:
    command, names = (argv[0], argv[1:]) if argv else ("refresh", [])
    if command in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    ids = read_list()
    if command == "refresh":
        return rebuild(ids)
    if command == "rebuild":
        return rebuild(ids, serve_page=False)
    if command == "follow":
        return follow(ids, names)
    if command == "list":
        show(ids)
        return 0
    panes = builder.herdr_panes()
    if command == "panes":
        for sid, pane in sorted(panes.items(), key=lambda item: (item[1]["herdr"], item[1]["label"])):
            mark = "*" if sid in ids else " "
            print(f"{mark} {sid[:8]}  {pane['herdr']} › {pane['label']}  ·  {pane['title']}")
        print("* = already listed")
        return 0
    if command not in ("add", "remove") or not names:
        print(__doc__.strip())
        return 2
    try:
        chosen = [resolve(name, panes) for name in names]
    except ValueError as error:
        print(error)
        return 1
    if command == "add":
        ids += [sid for sid in dict.fromkeys(chosen) if sid not in ids]
    else:
        ids = [sid for sid in ids if sid not in chosen]
    write_list(ids)
    return rebuild(ids, chosen[-1] if command == "add" else None)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
