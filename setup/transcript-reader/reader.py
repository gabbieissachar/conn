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
  python3 setup/transcript-reader/reader.py adopt <id>...    list full session ids (the live Claude, Codex or Copilot panes a Sync found
                                                             that are not listed), then rebuild only; one a person
                                                             closed or removed is skipped
  python3 setup/transcript-reader/reader.py worker           stay running and take rebuild, follow, adopt, reopen and
                                                             close from the reader's server on standard input, one JSON
                                                             line each (the server starts this); what one build learns
                                                             about the logs, the next uses

<session> is a session id, its first 8 characters, a session log path, or a
Herdr pane label (exact, or a unique part of the label or the pane's title).

A pane cleared with /clear starts a new session log. A listed session is shown
together with the sessions the same pane ran before and after it (one conversation,
under the newest), and that newest session is added to the list.

Every rebuild drops a listed session whose Herdr pane has closed: one that ran in a
pane before, while neither it nor a later session of its pane runs in one now and
Herdr no longer lists the pane itself (a closed pane's id is never reused while its Herdr
session lives; one deleted and made again under the same name has new panes). A pane
Herdr still lists stays, agent or not: after a restart the panes come back before
their agents do. A session never seen in a Herdr pane stays, and nothing is dropped
while Herdr shows no pane at all or a Herdr session cannot be read. A dropped session
that runs in a pane again (`claude --resume` in a new pane, say) within two weeks of its
last turn is listed again, unless `remove` or `close` named it. The same two commands keep a session out of
`adopt` (out/closed.txt) until `add`, `reopen` or `follow` names it. `add` of a session whose pane has closed lists it as
reopened, so the rebuild after it does not drop it again. A session reopened to read again (`reopen`, or
"Closed panes" in the page's session picker) stays until it is closed (`close`, or
the page's "Close" button).

The list lives in out/sessions.txt, the reader in out/prototype.html and the
answer sheet (replies that ask for keyed answers) in out/questionnaire.html, all
gitignored because they name or embed private sessions. The pages are served by the
reader's own server, setup/transcript-reader/serve.sh (port 8768, or PMOS_READER_PORT),
which also follows Herdr's focus and sends replies to a pane (see README.md); a
port that serves another copy of the repo is reported with where that copy is. Only
session logs and Herdr's pane list are read, and only out/ is written.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import io
import itertools
import json
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.error
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
CLOSED_NAME = "closed.txt"  # sessions a person took off the list (remove, close), which a Sync does not list again
HERDR_GRACE = 900  # seconds after a Herdr session's server starts during which a pane without an agent may still get its agent back
DROPPED_KEEP_DAYS = 14  # a dropped session whose log has not changed for this long is forgotten (as Closed panes does)
REPO = HERE.parent.parent
UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
DEFAULT_PORT = "8768"  # the reader's own server (serve.sh in this folder); 8765 and 8766 are other pages
PREFIX = re.compile(r"^[0-9a-f]{6,}[0-9a-f-]*$")


def read_list() -> list[str]:
    """The listed native session ids, including Codex rollouts written by older readers."""
    try:
        lines = LIST.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    ids = []
    for line in lines:
        name = line.strip()
        sid = builder.canonical_session_id(name) if name else None
        if sid and sid not in ids:
            ids.append(sid)
    return ids


def write_list(ids: list[str]) -> None:
    normalized = []
    for value in ids:
        sid = builder.canonical_session_id(value) if isinstance(value, str) else None
        if sid and sid not in normalized:
            normalized.append(sid)
    builder.write_private(LIST, "".join(f"{i}\n" for i in normalized))


def session_files(projects: Path, prefix: str) -> list[Path]:
    """The logs whose session id starts with <prefix>: Claude's under <projects> (and, when that is the usual folder, under every other
    Claude config folder's), Codex's and Copilot's."""
    roots = builder.project_roots() if projects == builder.PROJECTS else [projects]
    claude = [log for root in roots for log in root.glob(f"*/{prefix}*.jsonl")]
    codex = builder.codex_session_files(prefix)
    copilot = builder.copilot_session_files(prefix)
    return sorted({*claude, *codex, *copilot})


def resolve(name: str, panes: dict[str, dict], projects: Path = builder.PROJECTS) -> str:
    """The session id that <name> means. Raises ValueError with a readable reason."""
    path = Path(name).expanduser()
    if path.suffix == ".jsonl" and path.is_file():
        return builder.log_session_id(path)
    canonical = builder.canonical_session_id(name)
    if canonical and canonical != name:
        if session_files(projects, canonical):
            return canonical
        raise ValueError(f"no session log found for {name}")
    if PREFIX.match(name):
        ids = sorted({builder.log_session_id(p) for p in session_files(projects, name)})
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
    builder.write_private(path, "".join(f"{i}\n" for i in ids))


def forget_dropped(sids: set[str]) -> None:
    """Take sessions a person named (add, remove, close) out of the dropped record, so none is listed again unasked."""
    dropped = builder.read_ids(DROPPED)
    if sids & set(dropped):
        write_ids(DROPPED, [sid for sid in dropped if sid not in sids])


def closed_file() -> Path:
    return OUT / CLOSED_NAME


def mark_closed(sids: set[str]) -> None:
    """Remember sessions a person took off the list, so a Sync never lists them again. A session whose log is gone is forgotten."""
    marked = [sid for sid in builder.read_ids(closed_file()) if builder.find_session_file(sid)]
    more = [sid for sid in sorted(sids) if sid not in marked and builder.find_session_file(sid)]
    if more or len(marked) != len(builder.read_ids(closed_file())):
        write_ids(closed_file(), marked + more)


def forget_closed(sids: set[str]) -> None:
    """A session a person names again (add, reopen, follow) may be adopted again."""
    marked = builder.read_ids(closed_file())
    if sids & set(marked):
        write_ids(closed_file(), [sid for sid in marked if sid not in sids])


def chain_members(sid: str) -> set[str]:
    """The session and every session its pane ran across /clear, as `close` takes them off together."""
    path = builder.find_session_file(sid)
    return {sid} | ({builder.log_session_id(member) for member in builder.session_chain(path)} if path else set())


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
        self.occupant = {(info.get("herdr"), info.get("pane")): sid for sid, info in self.live.items()}  # (Herdr session, pane id) -> the session running there

    def members(self, sid: str) -> list[str]:
        path = builder.find_session_file(sid)
        return [builder.log_session_id(member) for member in builder.session_chain(path)] if path else [sid]

    def pane_left(self, member: str) -> str | None:
        """Why the pane this session was last seen in no longer runs it, or None while it may. A pane
        Herdr still lists without an agent is given HERDR_GRACE after its server starts (a Herdr restart
        brings agents back one at a time); beyond it the pane is a shell, and a pane whose agent is
        another session has moved on, however many panes of that name Herdr lists."""
        entry = self.seen[member]
        if self.listed is None:
            return None
        key = (entry.get("herdr"), entry.get("pane"))
        # A session made again under the same name reuses pane ids for new panes (see HERDR_LIVES).
        if key not in self.listed or not builder.same_life(entry, builder.HERDR_LIVES.get(entry.get("herdr"))):
            return "its Herdr pane has closed"
        if key in self.occupant:  # closed() has seen that none of this conversation's sessions is it
            return "its pane runs another session now"
        started = builder.HERDR_STARTS.get(entry.get("herdr"))
        if started is not None and time.time() - started > HERDR_GRACE:
            return "its pane runs no agent"
        return None

    def pane_closed(self, member: str) -> bool:
        return self.pane_left(member) is not None

    def why_closed(self, sid: str) -> str | None:
        """Why <sid> no longer runs in a pane (see pane_left), when it ran in one before and neither it nor
        a later session of its pane runs now; None while it does, or never ran in one."""
        if self.empty:
            return None
        pane = self.members(sid)
        if any(member in self.live or member in self.reopened for member in pane):
            return None
        seen = [member for member in pane if member in self.seen]
        reasons = [self.pane_left(member) for member in seen]
        return reasons[-1] if seen and all(reasons) else None

    def closed(self, sid: str) -> bool:
        """Whether <sid> ran in a pane before and neither it nor a later session of its pane runs in one that Herdr still lists as its own."""
        return self.why_closed(sid) is not None


def drop_closed(ids: list[str]) -> list[str]:
    """The list without the sessions whose Herdr pane has closed (see the module help), and with
    a session that was dropped before back on it when it runs in a pane again."""
    view = PaneView()
    if view.empty:
        return ids
    kept, gone = [], []
    for sid in ids:
        why = view.why_closed(sid)
        if why:
            gone.append(sid)
            print(f"Dropping {sid[:8]}: {why}")
        else:
            kept.append(sid)
    # A session dropped before that runs in a pane again (Herdr's agents came back after the pane
    # list shrank, or `claude --resume` in a new pane) is listed again.
    # The few live sessions' chains are walked, not every dropped one's: a chain is the same from
    # any of its sessions, and the record only grows.
    dropped = builder.read_ids(DROPPED)
    running = {member for sid in view.live for member in view.members(sid)} if dropped else set()
    back = [sid for sid in dropped if sid not in kept and sid in running and builder.find_session_file(sid)]
    for sid in back:
        print(f"Listing {sid[:8]} again: it runs in a Herdr pane again")
    since = time.time() - DROPPED_KEEP_DAYS * 86400

    def recent(sid: str) -> bool:
        path = builder.find_session_file(sid)
        return bool(path) and (builder.log_mtime(path) or 0) >= since

    still = [sid for sid in dict.fromkeys([*dropped, *gone]) if sid not in kept and sid not in back and recent(sid)]
    if still != dropped:
        write_ids(DROPPED, still)
    return kept + back


def run_builders(page: list[str], sheet: list[str]) -> int:
    """The two builders, each in its own interpreter (a command typed by hand, or the server without a worker)."""
    if subprocess.run([sys.executable, "-I", str(HERE / "prototype" / "build_prototype.py"), *page]).returncode:
        return 1
    if subprocess.run([sys.executable, "-I", str(HERE / "prototype" / "build_questionnaire.py"), *sheet]).returncode:
        return 1
    return 0


def run_in_process(page: list[str], sheet: list[str]) -> int:
    """The two builders in this interpreter, which a worker keeps: the logs it has listed and read stay known to the next build."""
    import build_questionnaire as questionnaire  # it imports the builder, so only here
    for build, argv in ((builder.main, page), (questionnaire.main, sheet)):
        try:
            if build(argv):
                return 1
        except SystemExit as stop:  # a builder's way of saying why it cannot build
            if stop.code not in (None, 0):
                print(stop.code if isinstance(stop.code, str) else f"The build stopped ({stop.code})")
                return 1
    return 0


BUILDERS = run_builders  # a worker sets run_in_process


def rebuild(ids: list[str], focus: str | None = None, serve_page: bool = True) -> int:
    with builder.chains_frozen():
        return rebuild_frozen(ids, focus, serve_page)


def rebuild_frozen(ids: list[str], focus: str | None, serve_page: bool) -> int:
    original = list(ids)
    ids = [sid for sid in (builder.canonical_session_id(value) for value in ids) if sid]
    ids = list(dict.fromkeys(ids))
    if ids != original:
        write_list(ids)
    kept = drop_closed(ids)
    if kept != ids:
        if ids and not kept:
            print("Every listed session's pane has closed")
        ids = kept
        write_list(ids)
    # An empty list is a page with no conversation on it, not a failed build: the page then
    # shows the one on screen as a closed pane, and the picker offers it under "Closed panes".
    if not ids:
        print("No sessions listed. Add one: reader.py add <session id or Herdr pane label>")
    present = [i for i in ids if builder.find_session_file(i)]
    missing = sorted(set(ids) - set(present))
    for sid in missing:
        print(f"Skipping {sid}: its session log is gone")
    if missing:
        ids = present
        write_list(ids)
        if not present:
            return 1
    # A listed session that was cleared reads on in the pane's newer session, which the
    # page shows as the same conversation; list that one too so its pane can be answered.
    newest = []
    for sid in present:
        chain = builder.session_chain(builder.find_session_file(sid))
        newest.append(builder.log_session_id(chain[-1]))
    added = [sid for sid in dict.fromkeys(newest) if sid not in ids]
    if added:
        ids += added
        present += added
        write_list(ids)
    argv = ["--out", str(PAGE), "--listed"] + [arg for sid in present for arg in ("--session", sid)]
    # The answer-sheet prototype reads the same list: replies that ask for keyed answers.
    questions = [arg for sid in present for arg in ("--session", sid)]
    sys.stdout.flush()  # keep this script's lines ahead of the builders' in a pipe
    # A rebuild started by hand while the server runs its own waits for it, so two builds
    # never share the machine; the later one reads what the earlier one parsed.
    builder.private_folder(OUT)
    builder.make_private(OUT)  # out/ holds private transcript text: owner-only, like the harness logs
    with builder.private_open(OUT / ".rebuild.lock", truncate=False) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if BUILDERS(argv, questions):
            return 1
    if serve_page:
        serve(focus)
    return 0


def copy_id(root: Path) -> str:
    """The name api.js gives the copy of the repo it serves (its x-transcript-reader-copy header)."""
    return hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16]


def serving(port: str) -> tuple[bool, str]:
    """Whether this copy's reader server answers on <port>, and in words, what does."""
    try:
        # Any 200 is not enough: another copy of the repo may serve its own pages on this port.
        with urllib.request.urlopen(f"http://localhost:{port}/", timeout=3):
            copy = ""
    except urllib.error.HTTPError as error:  # the reader server answers / with a 404 that names its copy
        copy = error.headers.get("x-transcript-reader-copy") or ""
        error.close()
    except OSError:
        return False, f"Nothing answers on port {port}."
    if copy == copy_id(REPO):
        return True, f"Port {port} serves this copy of the repo."
    pid = subprocess.run(["lsof", f"-tiTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True).stdout.split()
    where = ""
    if pid and copy:
        found = subprocess.run(["lsof", "-a", "-d", "cwd", "-p", pid[0], "-Fn"], capture_output=True, text=True).stdout
        where = next((line[1:] for line in found.splitlines() if line.startswith("n")), "")
    if copy:
        return False, f"Port {port} serves another copy of the repo{f' ({where})' if where else ''}."
    return False, f"Port {port} is used by another server, not a transcript reader."


def serve(focus: str | None) -> None:
    """Start this copy's reader server (setup/transcript-reader/serve.sh) if needed and print the page address."""
    port = os.environ.get("PMOS_READER_PORT", DEFAULT_PORT)
    subprocess.run(["bash", str(HERE / "serve.sh"), "start", "--port", port], cwd=REPO, stdout=subprocess.DEVNULL)
    url = f"http://localhost:{port}/{PAGE.relative_to(REPO).as_posix()}"
    sheet = f"http://localhost:{port}/{(OUT / 'questionnaire.html').relative_to(REPO).as_posix()}"
    ok, said = serving(port)
    anchor = f"#s={focus[:8]}" if focus else ""
    if ok:
        # Served, the pages refresh themselves, follow Herdr's focus and can send replies.
        print(f"Reader:       {url}{anchor}")
        print(f"Answer sheet: {sheet}")
    else:
        print(f"{said} Set PMOS_READER_PORT to a free port, or run `bash setup/transcript-reader/serve.sh status`. These read-only file links cannot send or follow:")
        print(f"Reader:       {PAGE.as_uri()}{anchor}")
        print(f"Answer sheet: {(OUT / 'questionnaire.html').as_uri()}")


def follow(ids: list[str], names: list[str]) -> int:
    """Add one full session id that has a log, then rebuild without starting the server."""
    if len(names) != 1 or not UUID.match(names[0]) or not session_files(builder.PROJECTS, names[0]):
        print("follow takes one full session id that has a session log")
        return 2
    forget_closed({names[0]})
    if names[0] not in ids:
        ids.append(names[0])
        write_list(ids)
    return rebuild(ids, serve_page=False)


def adopt(ids: list[str], names: list[str]) -> int:
    """List full session ids with a log (the live Claude panes a Sync found that are not listed), skipping any a
    person closed or removed, then rebuild without serving. The ids are listed as `follow` lists one."""
    if not names or not all(UUID.match(name) for name in names):
        print("adopt takes full session ids")
        return 2
    closed = set(builder.read_ids(closed_file()))
    added = [sid for sid in dict.fromkeys(names) if sid not in ids and sid not in closed and session_files(builder.PROJECTS, sid)]
    for sid in added:
        print(f"Listing {sid[:8]}: it runs in a Herdr pane")
    if added:
        ids += added
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
    forget_closed({sid})
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
    pane = chain_members(names[0])
    marked = builder.read_ids(REOPENED)
    if pane & set(marked):
        write_ids(REOPENED, [i for i in marked if i not in pane])
    dropped = bool(pane & set(builder.read_ids(DROPPED)))
    forget_dropped(pane)  # closed by hand, it is not listed again when it next runs in a pane
    mark_closed(pane)  # nor adopted by a Sync
    if not pane & set(ids):
        if dropped:
            print(f"{names[0][:8]} was dropped when its pane closed; it will not be listed again when it runs")
            return 0
        print(f"{names[0][:8]} is not on the reading list")
        return 1
    ids = [i for i in ids if i not in pane]
    write_list(ids)
    return rebuild(ids, serve_page=False)


def show(ids: list[str]) -> None:
    labels = builder.pane_labels(ids, OUT / "pane-labels.json")
    for sid in ids:
        pane = labels.get(sid)
        where = f"{pane['herdr']} › {pane['label']}" + ("" if pane["live"] else " (pane closed)") if pane else "no Herdr pane"
        print(f"{sid[:8]}  {where}")


# What the server may ask of a worker, with how many names each takes after it (None: one or more).
WORKER_COMMANDS = {"rebuild": 0, "follow": 1, "adopt": None, "reopen": 1, "close": 1}
SOURCES = (HERE / "reader.py", HERE / "prototype" / "build_prototype.py", HERE / "prototype" / "build_questionnaire.py", HERE / "prototype" / "build_cache.py")


def worker_request(line: str) -> tuple[object, list[str]]:
    """The id and arguments of one request line, or ValueError when it is not one the worker takes."""
    try:
        request = json.loads(line)
        args, ident = request["args"], request["id"]
    except (ValueError, KeyError, TypeError):
        raise ValueError("Not a request the worker takes.")
    if not isinstance(args, list) or not args or not all(isinstance(arg, str) for arg in args) or args[0] not in WORKER_COMMANDS:
        raise ValueError("Not a command the worker takes.")
    count = WORKER_COMMANDS[args[0]]
    if (len(args) < 2 if count is None else len(args) - 1 != count):
        raise ValueError(f"{args[0]} does not take {len(args) - 1} names.")
    return ident, args


def worker(replay: str | None = None) -> int:
    """Answer the server's requests on standard input, one JSON line each: {"id": n, "args": ["rebuild"]}, and on standard
    output {"id": n, "code": 0, "output": "..."} each. It runs what the same command does by hand, in this one interpreter, so
    that the session logs, folders and file heads one build has read are not read again by the next. Only the commands the
    server runs for a page are taken; anything else is refused. When this program's own files change (an update of the repo)
    it starts again from the new ones before it answers the next request, so no build runs half on old code."""
    global BUILDERS
    BUILDERS = run_in_process
    reply = sys.stdout
    version = tuple(builder.file_version(path) for path in SOURCES)
    for line in itertools.chain([replay] if replay else [], sys.stdin):
        if tuple(builder.file_version(path) for path in SOURCES) != version:
            reply.flush()
            os.execv(sys.executable, [sys.executable, "-I", str(HERE / "reader.py"), "worker", "--replay", line.rstrip("\n")])
        try:
            ident, args = worker_request(line)
        except ValueError as refusal:
            reply.write(json.dumps({"id": None, "code": 2, "output": str(refusal)}) + "\n")
            reply.flush()
            continue
        output = io.StringIO()
        builder._LOG_INDEX.clear()  # a log written since the last build is on the list
        builder._OTHER_HOMES.clear()  # and so is the folder of a Claude account set up since
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            try:
                code = main(args)
            except Exception:  # a build that fails says so, and the next request runs as usual
                traceback.print_exc()
                code = 1
        reply.write(json.dumps({"id": ident, "code": code, "output": output.getvalue()[-8192:]}) + "\n")
        reply.flush()
    return 0


def main(argv: list[str]) -> int:
    command, names = (argv[0], argv[1:]) if argv else ("refresh", [])
    if command in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    if command == "worker" and (not names or (len(names) == 2 and names[0] == "--replay")):
        return worker(names[1] if names else None)
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
    if command == "adopt":
        return adopt(ids, names)
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
        forget_closed(set(chosen))
    else:
        ids = [sid for sid in ids if sid not in chosen]
        mark_closed(set().union(*(chain_members(sid) for sid in chosen)))
    write_list(ids)
    forget_dropped(set(chosen))
    return rebuild(ids, chosen[-1] if command == "add" else None)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
