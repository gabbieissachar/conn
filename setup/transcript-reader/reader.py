#!/usr/bin/env python3
"""Keep a list of sessions to read and rebuild the transcript reader page from it.

Usage (from the repo root):
  python3 setup/transcript-reader/reader.py                  rebuild every listed session (picks up new turns)
  python3 setup/transcript-reader/reader.py add <session>... add sessions, then rebuild
  python3 setup/transcript-reader/reader.py remove <session>...
  python3 setup/transcript-reader/reader.py list             the listed sessions
  python3 setup/transcript-reader/reader.py panes            live Herdr panes, to pick from
  python3 setup/transcript-reader/reader.py rebuild          rebuild only (the server runs this when a log changes
                                                             or a listed session's pane closes)
  python3 setup/transcript-reader/reader.py follow <id>      add one full session id, then rebuild only
                                                             (the server runs this for the pane Herdr focuses)
  python3 setup/transcript-reader/reader.py reopen <id>      list one full session id whose pane has closed, kept
                                                             until closed, then rebuild only (the page's picker)
  python3 setup/transcript-reader/reader.py close <id>       take one full session id off the list, then rebuild only

<session> is a session id, its first 8 characters, a session log path, or a
Herdr pane label (exact, or a unique part of the label or the pane's title).

A pane cleared with /clear starts a new session log. A listed session is shown
together with the sessions the same pane ran before and after it (one conversation,
under the newest), and that newest session is added to the list.

Every rebuild drops a listed session whose Herdr pane has closed: one that ran in a
pane before, while neither it nor a later session of its pane runs in one now and
Herdr no longer lists the pane itself (a closed pane's id is never reused). A pane
Herdr still lists stays, agent or not: after a restart the panes come back before
their agents do. A session never seen in a Herdr pane stays, and nothing is dropped
while Herdr shows no pane at all or a Herdr session cannot be read. A dropped session
that runs in a pane again (`claude --resume` in a new pane, say) is listed again,
unless `remove` or `close` named it. `add` of a session whose pane has closed lists it as
reopened, so the rebuild after it does not drop it again. A session reopened to read again (`reopen`, or
"Closed panes" in the page's session picker) stays until it is closed (`close`, or
the page's "Close" button).

The list lives in out/sessions.txt, the reader in out/prototype.html and the
answer sheet (replies that ask for keyed answers) in out/questionnaire.html, all
gitignored because they name or embed private sessions. The pages are served by
setup/serve.sh, which also follows Herdr's focus and sends replies to a pane (see
README.md); set PMOS_SERVE_PORT when that port serves a different copy of the
repo. Only session logs and Herdr's pane list are read, and only out/ is written.
"""

from __future__ import annotations

import hashlib
import json
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
PANE_CACHE = OUT / "pane-labels.json"  # every pane a listed session was seen in; the builder writes it
REOPENED = OUT / "reopened.txt"  # sessions reopened by hand, which a closed pane does not drop
DROPPED = OUT / "dropped.txt"  # sessions a closed pane took off the list, listed again if they run in a pane again
REPO = HERE.parent.parent
UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
PREFIX = re.compile(r"^[0-9a-f]{6,}[0-9a-f-]*$")


def read_list() -> list[str]:
    """The listed session ids. `add` writes full ids only, so any other line (a path a
    website planted through the shared server, say) is never read as a session log."""
    try:
        lines = LIST.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    return [line.strip() for line in lines if UUID.match(line.strip())]


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


def write_ids(path: Path, ids: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(f"{i}\n" for i in ids), encoding="utf-8")


def forget_dropped(sids: set[str]) -> None:
    """Take sessions a person named (add, remove, close) out of the dropped record, so none is listed again unasked."""
    dropped = builder.read_ids(DROPPED)
    if sids & set(dropped):
        write_ids(DROPPED, [sid for sid in dropped if sid not in sids])


class PaneView:
    """What Herdr and the pane cache say now, to tell a session whose pane has closed from one that has not."""

    def __init__(self) -> None:
        self.live, self.listed = builder.herdr_inventory()
        self.empty = not self.live and not self.listed  # Herdr is not running, or shows no pane at all
        if self.empty:
            return
        builder.pane_labels([], PANE_CACHE, self.live)  # records the panes live sessions run in, for session_chain
        try:
            self.seen = json.loads(PANE_CACHE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self.seen = {}
        self.reopened = set(builder.read_ids(REOPENED))

    def members(self, sid: str) -> list[str]:
        path = builder.find_session_file(sid)
        return [member.stem for member in builder.session_chain(path)] if path else [sid]

    def pane_closed(self, member: str) -> bool:
        """Whether the pane this session was last seen in is gone from Herdr. A pane whose agent
        has not come back (a Herdr restart brings agents back one at a time) is still listed."""
        entry = self.seen[member]
        return self.listed is not None and (entry.get("herdr"), entry.get("pane")) not in self.listed

    def closed(self, sid: str) -> bool:
        """Whether <sid> ran in a pane before and neither it nor a later session of its pane runs in one that Herdr still lists."""
        if self.empty:
            return False
        pane = self.members(sid)
        if any(member in self.live or member in self.reopened for member in pane):
            return False
        seen = [member for member in pane if member in self.seen]
        return bool(seen) and all(self.pane_closed(member) for member in seen)


def drop_closed(ids: list[str]) -> list[str]:
    """The list without the sessions whose Herdr pane has closed (see the module help), and with
    a session that was dropped before back on it when it runs in a pane again."""
    view = PaneView()
    if view.empty:
        return ids
    kept, gone = [], []
    for sid in ids:
        if view.closed(sid):
            gone.append(sid)
            print(f"Dropping {sid[:8]}: its Herdr pane has closed")
        else:
            kept.append(sid)
    # A session dropped before that runs in a pane again (Herdr's agents came back after the pane
    # list shrank, or `claude --resume` in a new pane) is listed again.
    dropped = builder.read_ids(DROPPED)
    back = [sid for sid in dropped if sid not in kept and builder.find_session_file(sid) and any(member in view.live for member in view.members(sid))]
    for sid in back:
        print(f"Listing {sid[:8]} again: it runs in a Herdr pane again")
    still = [sid for sid in dict.fromkeys([*dropped, *gone]) if sid not in kept and sid not in back and builder.find_session_file(sid)]
    if still != dropped:
        write_ids(DROPPED, still)
    return kept + back


def rebuild(ids: list[str], focus: str | None = None, serve_page: bool = True) -> int:
    kept = drop_closed(ids)
    if kept != ids:
        ids = kept
        write_list(ids)
        if not ids:
            print("Every listed session's pane has closed; the page keeps its last build")
            return 1
    if not ids:
        print("No sessions listed yet. Add one: reader.py add <session id or Herdr pane label>")
        return 1
    present = [i for i in ids if builder.find_session_file(i)]
    for missing in sorted(set(ids) - set(present)):
        print(f"Skipping {missing}: its session log is gone")
    if not present:
        return 1
    # A listed session that was cleared reads on in the pane's newer session, which the
    # page shows as the same conversation; list that one too so its pane can be answered.
    newest = [builder.session_chain(builder.find_session_file(i))[-1].stem for i in present]
    added = [sid for sid in dict.fromkeys(newest) if sid not in ids]
    if added:
        ids += added
        present += added
        write_list(ids)
    argv = ["--out", str(PAGE)] + [arg for sid in present for arg in ("--session", sid)]
    sys.stdout.flush()  # keep this script's lines ahead of the builders' in a pipe
    if subprocess.run([sys.executable, "-I", str(HERE / "prototype" / "build_prototype.py"), *argv]).returncode:
        return 1
    # The answer-sheet prototype reads the same list: replies that ask for keyed answers.
    questions = [arg for sid in present for arg in ("--session", sid)]
    if subprocess.run([sys.executable, "-I", str(HERE / "prototype" / "build_questionnaire.py"), *questions]).returncode:
        return 1
    if serve_page:
        serve(focus)
    return 0


def copy_id(root: Path) -> str:
    """The name api.js gives the copy of the repo it serves (its x-transcript-reader-copy header)."""
    return hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16]


def serve(focus: str | None) -> None:
    """Start setup/serve.sh if needed and print the page address."""
    port = os.environ.get("PMOS_SERVE_PORT", "8765")
    subprocess.run(["bash", str(REPO / "setup" / "serve.sh"), "--port", port], cwd=REPO, stdout=subprocess.DEVNULL)
    url = f"http://localhost:{port}/{PAGE.relative_to(REPO).as_posix()}"
    sheet = f"http://localhost:{port}/{(OUT / 'questionnaire.html').relative_to(REPO).as_posix()}"
    try:
        # Any 200 is not enough: another copy of the repo may serve its own pages on this port.
        with urllib.request.urlopen(url, timeout=3) as response:
            ok = response.status == 200 and response.headers.get("x-transcript-reader-copy") == copy_id(REPO)
    except OSError:
        ok = False
    anchor = f"#s={focus[:8]}" if focus else ""
    if ok:
        # Served, the pages refresh themselves, follow Herdr's focus and can send replies.
        print(f"Reader:       {url}{anchor}")
        print(f"Answer sheet: {sheet}")
    else:
        print(f"Port {port} does not serve this copy of the repo (set PMOS_SERVE_PORT to a free port or this copy's), so these read-only file links cannot send or follow:")
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


def mark_reopened(sid: str) -> None:
    """Keep <sid> on the list while its pane stays closed, until `close`."""
    marked = builder.read_ids(REOPENED)
    if sid not in marked:
        write_ids(REOPENED, marked + [sid])


def reopen(ids: list[str], names: list[str]) -> int:
    """List one full session id with a log and keep it when its pane is closed, then rebuild without serving."""
    if len(names) != 1 or not UUID.match(names[0]) or not session_files(builder.PROJECTS, names[0]):
        print("reopen takes one full session id that has a session log")
        return 2
    sid = names[0]
    mark_reopened(sid)
    if sid not in ids:
        ids.append(sid)
        write_list(ids)
    return rebuild(ids, serve_page=False)


def close(ids: list[str], names: list[str]) -> int:
    """Take one full session id off the list (and the reopened list), then rebuild without serving."""
    if len(names) != 1 or not UUID.match(names[0]):
        print("close takes one full session id")
        return 2
    # The page shows a cleared pane's sessions as one conversation, so all of them go.
    path = builder.find_session_file(names[0])
    pane = {names[0]} | ({member.stem for member in builder.session_chain(path)} if path else set())
    marked = builder.read_ids(REOPENED)
    if pane & set(marked):
        REOPENED.write_text("".join(f"{i}\n" for i in marked if i not in pane), encoding="utf-8")
    if not pane & set(ids):
        print(f"{names[0][:8]} is not on the reading list")
        return 1
    ids = [i for i in ids if i not in pane]
    write_list(ids)
    forget_dropped(pane)
    if not ids:
        print("The reading list is empty now; the page keeps its last build")
        return 0
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
    if command == "reopen":
        return reopen(ids, names)
    if command == "close":
        return close(ids, names)
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
        view = PaneView()
        for sid in dict.fromkeys(chosen):
            if sid not in ids and view.closed(sid):
                # The rebuild would drop it at once, and still print a link to it.
                mark_reopened(sid)
                print(f"{sid[:8]}: its Herdr pane has closed, so it is listed as reopened and stays until `close`")
        ids += [sid for sid in dict.fromkeys(chosen) if sid not in ids]
    else:
        ids = [sid for sid in ids if sid not in chosen]
    write_list(ids)
    forget_dropped(set(chosen))
    return rebuild(ids, chosen[-1] if command == "add" else None)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
