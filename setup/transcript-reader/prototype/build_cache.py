"""What the reader's page build keeps between builds, so that a rebuild costs what changed and not what exists.

The reader's worker (reader.py worker) builds the page again each time a listed log changes. A build from nothing reads every
listed log, finds every file each reply names, works out every conversation and writes all of it as one 30 MB page: about two
seconds of CPU, and with one busy session the worker spent most of every second on it. Almost none of that differs between two
builds, because one conversation grew by a turn. This module keeps each conversation's finished result and builds from them.

A conversation (a pane's sessions across /clear, under its newest id) is kept as its JSON, the documents it names, and the little the
page needs to place it. It is used again while

  * the logs of its sessions, its home and the chain they make are what they were, and
  * every file system answer its build was given still holds. Each file or folder it looked at (a document a reply names, a steering
    message, a backlog, a path that was not there) is recorded when it is first asked for (Reads), with what it was, and looked at
    again before the result is used. A file that appeared, went or changed makes every conversation that asked about it be built again.

Whatever a conversation does not decide is worked out for every build, from small records: Herdr's panes, the order of the
conversations, the task folders' files of each leader, the pieces of the page between conversations.

The page this makes is the page build_prototype.build + write_page make, byte for byte. build_prototype.build stays the plain way to
make it, and the tests hold this to it, after any change a conversation can be given (test_cache.py).
"""

from __future__ import annotations

import argparse
import builtins
import contextlib
import copy
import fcntl
import io
import json
import os
import stat
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import build_prototype as builder  # noqa: E402
import tool_steps  # noqa: E402

# ------------------------------------------------------------------------------------------ what a piece of work read


def signature(info: os.stat_result) -> tuple[int, int, int, int]:
    """What a path is, for telling it has changed: its kind and permissions, size, modification time and identity. A folder is only
    asked what it is (it is the way to a file, or a place a file is not): its entries coming and going is a change to its listing
    (see folder_signature), not to the folder, or every conversation would change with each file written under a folder it passed through."""
    if stat.S_ISDIR(info.st_mode):
        return info.st_mode, 0, 0, info.st_ino
    return info.st_mode, info.st_size, info.st_mtime_ns, info.st_ino


def folder_signature(info: os.stat_result) -> tuple[int, int, int, int]:
    """A folder as its listing sees it: an entry added, removed or renamed changes its modification time and size."""
    return info.st_mode, info.st_size, info.st_mtime_ns, info.st_ino


class Reads:
    """The file system answers a piece of work was given, each with what it was then.

    Four kinds, each by path: `stat` (os.stat, which follows links), `lstat`, `dir` (a folder's entries were listed: an entry added,
    removed or renamed changes the folder's modification time; each entry is recorded as it is asked for) and `file` (opened to
    read). The answer is None for a path that was not there. A path is recorded the first time it is asked for, so a file that
    changes while the work runs differs from its record, and the work is done again, never kept past it.
    """

    __slots__ = ("seen",)
    KINDS = ("stat", "lstat", "dir", "file")

    def __init__(self) -> None:
        self.seen: dict[str, dict[str, tuple | None]] = {kind: {} for kind in self.KINDS}

    def note(self, kind: str, path, answer: tuple | None) -> None:
        name = os.fspath(path) if isinstance(path, (str, os.PathLike)) else None
        if isinstance(name, str):
            self.seen[kind].setdefault(sys.intern(name), answer)

    def count(self) -> int:
        return sum(len(answers) for answers in self.seen.values())

    def hold(self, now: dict) -> bool:
        """Whether every answer is still what it was. <now> keeps what this build has already looked at, by kind and path."""
        for kind, answers in self.seen.items():
            looked = now.setdefault(kind, {})
            for path, was in answers.items():
                if path in looked:
                    is_now = looked[path]
                else:
                    is_now = looked[path] = look(kind, path)
                if is_now != was:
                    return False
        return True


def look(kind: str, path: str) -> tuple | None:
    """What <path> is now, in the terms Reads records it."""
    try:
        if kind == "dir":
            return folder_signature(os.stat(path))
        return signature(os.lstat(path) if kind == "lstat" else os.stat(path))
    except (OSError, ValueError):
        return None


_RECORDING: list[Reads] = []


@contextlib.contextmanager
def recording():
    """While the block runs, every file system call the build code makes by path (stat, lstat, scandir, listdir, open for reading) is
    recorded in the Reads this gives. The calls do what they did. Nothing may write inside the block, and it cannot be nested."""
    if _RECORDING:
        raise RuntimeError("a recording cannot be nested")
    reads = Reads()
    real = {"stat": os.stat, "lstat": os.lstat, "scandir": os.scandir, "listdir": os.listdir, "io.open": io.open, "open": builtins.open}

    def stat(path, *args, **kwargs):
        kind = "lstat" if kwargs.get("follow_symlinks", True) is False else "stat"
        noted = "dir_fd" not in kwargs
        try:
            info = real["stat"](path, *args, **kwargs)
        except OSError:
            if noted:
                reads.note(kind, path, None)
            raise
        if noted:
            reads.note(kind, path, signature(info))
        return info

    def lstat(path, *args, **kwargs):
        noted = "dir_fd" not in kwargs
        try:
            info = real["lstat"](path, *args, **kwargs)
        except OSError:
            if noted:
                reads.note("lstat", path, None)
            raise
        if noted:
            reads.note("lstat", path, signature(info))
        return info

    def lister(call):
        def listing(path=".", *args, **kwargs):
            # The folder is looked at before its entries are read, so an entry added meanwhile leaves the record older than the list.
            if isinstance(path, (str, os.PathLike)):
                try:
                    reads.note("dir", path, folder_signature(real["stat"](path)))
                except OSError:
                    reads.note("dir", path, None)
            return call(path, *args, **kwargs)
        return listing

    def opener(call):
        def opened(file, mode="r", *args, **kwargs):
            if isinstance(file, (str, os.PathLike)) and not any(flag in str(mode) for flag in "wax+"):
                try:
                    reads.note("file", file, signature(real["stat"](file)))
                except OSError:
                    reads.note("file", file, None)
            return call(file, mode, *args, **kwargs)
        return opened

    os.stat, os.lstat, os.scandir, os.listdir = stat, lstat, lister(real["scandir"]), lister(real["listdir"])
    io.open, builtins.open = opener(real["io.open"]), opener(real["open"])
    _RECORDING.append(reads)
    try:
        yield reads
    finally:
        _RECORDING.pop()
        os.stat, os.lstat, os.scandir, os.listdir = real["stat"], real["lstat"], real["scandir"], real["listdir"]
        io.open, builtins.open = real["io.open"], real["open"]


_WORKS: list[bool] = []


def recording_works() -> bool:
    """Whether a recording sees what pathlib, os.walk and open ask of the file system on this Python. It does where they call os.stat,
    os.scandir and io.open as modules do (3.11 and later); a Python whose pathlib took its own copy of them when it was imported would let a
    conversation be kept past a file it had read, which no check would show, so a build that cannot be recorded is not kept at all."""
    if not _WORKS:
        probe = Path(__file__).resolve()
        try:
            with recording() as reads:
                probe.stat()
                probe.is_file()
                probe.resolve()
                probe.read_text(encoding="utf-8")
                list(probe.parent.glob("build_cache.py"))
                list(os.walk(probe.parent))
                (probe.parent / "no such file").exists()
            seen = reads.seen
            _WORKS.append(all((str(probe) in seen["stat"], str(probe) in seen["lstat"], str(probe) in seen["file"], str(probe.parent) in seen["dir"],
                              str(probe.parent / "no such file") in seen["stat"])))
        except Exception:  # noqa: BLE001  (whatever it was, a recording that fails is one that cannot be relied on)
            _WORKS.append(False)
    return _WORKS[0]


# ------------------------------------------------------------------------------------------------- one conversation

# The page's JSON must not close the script element it sits in (build_prototype.payload_json). What is kept is UTF-8 bytes, which take
# a quarter of the memory of the same text as a string once it holds one character outside the first 65,536.
ESCAPES = (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"))


def plain(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def encode(value) -> bytes:
    """One piece of the page's payload: <value> as the JSON build_prototype.payload_json makes of it, as UTF-8 bytes."""
    text = plain(value)
    for unsafe, escaped in ESCAPES:
        text = text.replace(unsafe, escaped)
    return text.encode("utf-8", "replace")


class Document:
    """A document the page offers: its JSON, and what the page's three lists of files are made from."""

    __slots__ = ("key", "json", "kind", "lazy", "path")

    def __init__(self, record: dict) -> None:
        self.key, self.json = record["id"], encode(record)
        self.kind, self.lazy, self.path = record.get("kind"), bool(record.get("lazy")), record["path"]


class Thread:
    """One conversation as the page shows it, kept (see the module's text)."""

    __slots__ = ("key", "reads", "head", "turns", "leader", "documents", "activity", "ids", "newest", "has_outputs", "stats")

    def __init__(self, key: tuple, reads: Reads, session: dict, documents: dict[str, dict], has_outputs: bool) -> None:
        exchanges = session["exchanges"]
        self.key, self.reads = key, reads
        # The start of its JSON, up to where its turns begin; the pane, the leader's task files and the rest follow them (build).
        self.head = encode({name: session[name] for name in ("home", "id", "ids", "file", "where")})[:-1] + b',"exchanges":'
        self.turns = encode(exchanges)
        self.leader = session.get("leader")
        self.documents = [Document(record) for record in documents.values()]
        self.activity = max((e["reply_at"] or e["at"] or 0) for e in exchanges) if exchanges else 0
        self.ids, self.newest, self.has_outputs = session["ids"], session["id"], has_outputs
        count = lambda test: sum(1 for e in exchanges if test(e))
        self.stats = (
            f"{session['home']:<34} {session['id'][:8]} exchanges={len(exchanges)} captain={count(lambda e: e['source'] == 'captain')} "
            f"absorbed={count(lambda e: e['absorbed'] and e['source'] == 'captain')} firstmate={count(lambda e: e['source'] == 'firstmate')} "
            f"wake={count(lambda e: e['source'] == 'wake')} folded={count(lambda e: e['folded'])} "
            f"needs={count(lambda e: e['verdict'] == 'needs-you')} wake_needs={count(lambda e: e['source'] == 'wake' and e['verdict'] == 'needs-you')}")


def thread_key(home: dict, parent: Path | None, chain: list[Path]) -> tuple:
    """What a conversation's result is for: its home, the home that holds its inbox, the sessions of its chain as they are written now,
    and the rules that read them."""
    return (home["id"], str(home["home"]), str(parent) if parent else None, builder.PARSE_RULES,
            tuple((str(member), builder.listed_version(member)) for member in chain))


def derive(home: dict, chain: list[Path], parent: Path | None, cache: Path, key: tuple) -> tuple[Thread, bytes | None]:
    """A conversation from its logs, as build_prototype.build makes it, with what it read; and the tool output its steps held, as the
    JSON file the page's server reads it from (None when no step had any)."""
    loaded = {member: builder.parsed_log(member, cache) for member in chain}  # the reader's own cache files: not what the page is made of
    with recording() as reads:
        session = builder.thread_session(home, chain, loaded, parent)
        builder.mark_sheets([session])
        documents = builder.attach_documents([session], html=True, images=True)
    outputs = tool_steps.take_outputs(session["exchanges"])
    return (Thread(key, reads, session, documents, bool(outputs)),
            plain({"outputs": outputs}).encode("utf-8", "replace") if outputs else None)


_THREADS: dict[Path, Thread] = {}   # the newest log of a conversation's chain -> the conversation as last built

# ------------------------------------------------------------------------------------------------ a leader's task folders


class Tasks:
    """The documents in the task folders of one leader's home (build_prototype.attach_task_files), kept the same way."""

    __slots__ = ("reads", "documents", "more")

    def __init__(self, shown: str) -> None:
        self.documents: list[Document] = []
        self.more: dict[str, int] = {}
        with recording() as self.reads:
            for folder in builder.task_folders(builder.home_from_shown(shown)):
                files, left = builder.task_files(folder)
                if left:
                    self.more[folder.name] = left
                for path, kind in files:
                    try:
                        info = path.stat()
                    except OSError:
                        continue
                    record = {"id": builder.doc_key(path), "name": path.name, "path": str(path), "dir": builder.shown_dir(path), "mention": "",
                              "mtime": info.st_mtime}
                    if kind:
                        record.update(kind=kind, size=info.st_size)
                    else:
                        record["lazy"] = True
                    self.documents.append(Document(record))


_TASKS: dict[str, Tasks] = {}   # a leader's folder as the page shows it -> its task folders' documents as last built

# ---------------------------------------------------------------------------------------------------------- the build

SLOT = "\x00payload\x00"
_FRAME: dict[str, object] = {"versions": None, "head": b"", "tail": b""}


def frame() -> tuple[bytes, bytes]:
    """The reader page around its payload (build_prototype.fill_template), kept until the template or a script that goes into it changes."""
    watched = [builder.TEMPLATE, builder.MARKDOWN_IT_SCRIPT, *sorted(builder.HERE.glob("*.js"))]
    versions = tuple(builder.file_version(path) for path in watched)
    if _FRAME["versions"] != versions:
        page, _ = builder.fill_template(builder.TEMPLATE, SLOT)
        head, _, tail = page.partition(SLOT)
        _FRAME.update(versions=versions, head=head.encode("utf-8"), tail=tail.encode("utf-8"))
    return _FRAME["head"], _FRAME["tail"]


class Built:
    """A build's result, ready to write: the page's payload as the pieces it is made of, and the files that go beside it."""

    __slots__ = ("generated", "payload", "files", "outputs", "output_ids", "stats")

    def __init__(self, generated: float) -> None:
        self.generated = generated
        self.payload: list[bytes] = []
        self.files: list[tuple[str, str]] = []
        self.outputs: dict[str, bytes] = {}     # the tool output of the conversations built anew: conversation id -> its file
        self.output_ids: set[str] = set()       # every conversation that has tool output now
        self.stats = ""


_HEADS: dict[Path, tuple[tuple[int, int], str, float | None]] = {}


def log_head(path: Path) -> tuple[str, float | None]:
    """A log's first working directory and the time of its first dated record, as build_prototype.parsed_log finds them, kept for as long
    as the log is as it was."""
    version = builder.file_version(path)
    known = _HEADS.get(path)
    if known and version is not None and known[0] == version:
        return known[1], known[2]
    cwd, first = "", None
    try:
        for record in builder.iter_jsonl(path):
            if first is None:
                first = builder.iso_to_epoch(record.get("timestamp"))
            if not cwd and record.get("cwd"):
                cwd = record["cwd"]
            if first is not None and cwd:
                break
    except OSError:
        cwd, first = "", None
    if version is not None:
        _HEADS[path] = (version, cwd, first)
    return cwd, first


def usable(args: argparse.Namespace) -> bool:
    """Whether a build can be made from kept conversations: the reader's list, without the fleet timeline (which links the fleet's records to
    the turns of every conversation, so that no conversation is its own), on a Python whose file system calls can be recorded."""
    return bool(args.session or getattr(args, "listed", False)) and not builder.fleet_timeline_on() and recording_works()


def build(args: argparse.Namespace) -> Built:
    """What build_prototype.build + write_page make of the reader's list, from the conversations kept since the last build."""
    started = time.time()  # before any log is read: a turn written while this build runs leaves its log newer than the stamp
    homes, parent_of = builder.fleet_homes(args.main_home, args.home)
    out_dir = Path(args.out).expanduser().parent
    cache = out_dir / "parsed"
    logs = []
    for name in args.session or []:
        path = builder.find_session_file(name)
        if not path:
            raise SystemExit(f"session not found: {name}")
        logs.append((path, *log_head(path)))
    for gone in set(_HEADS) - {path for path, _, _ in logs}:
        del _HEADS[gone]  # a log no longer listed is not kept
    starts = [first for _, _, first in logs if first is not None]
    since = min(starts) if args.since_hours is None and starts else time.time() - (args.since_hours or 72) * 3600

    # A pane cleared with /clear, or with Claude restarted in it, goes on in a new session log: the sessions it ran are one conversation.
    live = builder.herdr_panes()
    builder.pane_labels([], out_dir / "pane-labels.json", live)
    threads: list[tuple[dict, list[Path]]] = []
    for path, cwd, _ in logs:
        if any(path in chain for _, chain in threads):
            continue
        threads.append((builder.session_home(homes, cwd), builder.session_chain(path)))
    builder.prune_parsed(cache)

    built = Built(started)
    now: dict = {}
    steps = out_dir / builder.STEP_OUTPUTS
    kept = []
    for home, chain in threads:
        parent = parent_of.get(home["id"])
        key = thread_key(home, parent, chain)
        thread = _THREADS.get(chain[-1])
        if thread is not None and thread.has_outputs and not (steps / f"{thread.newest}.json").is_file():
            thread = None  # its tool output was taken away: it is built again, and writes it again
        if thread is None or thread.key != key or not thread.reads.hold(now):
            thread, outputs = derive(home, chain, parent, cache, key)
            if outputs is not None:
                built.outputs[thread.newest] = outputs
        kept.append(thread)
    _THREADS.clear()
    _THREADS.update({chain[-1]: thread for (_, chain), thread in zip(threads, kept)})

    # The documents, in the order a build from nothing meets them: each conversation's, then each leader's task folders'.
    documents: dict[str, Document] = {}
    for thread in kept:
        for document in thread.documents:
            documents.setdefault(document.key, document)
    leaders, more_by_home = [], {}
    for thread in kept:
        leader = copy.deepcopy(thread.leader) if thread.leader else None
        leaders.append(leader)
        if not leader:
            continue
        shown = leader["dir"]
        if shown not in more_by_home:
            tasks = _TASKS.get(shown)
            if tasks is None or not tasks.reads.hold(now):
                tasks = _TASKS[shown] = Tasks(shown)
            more_by_home[shown] = tasks.more
            for document in tasks.documents:
                documents.setdefault(document.key, document)
        for task, left in more_by_home[shown].items():
            leader["tasks"].setdefault(task, {})["more"] = left
    for shown in set(_TASKS) - set(more_by_home):
        del _TASKS[shown]

    labels = builder.pane_labels([thread.newest for thread in kept], out_dir / "pane-labels.json", live)
    reopened = set(builder.read_ids(out_dir / "reopened.txt"))
    closed = builder.closed_panes(out_dir / "pane-labels.json", live, {sid for thread in kept for sid in thread.ids})
    summaries = [summary for summary in (builder.home_summary(home) for home in homes) if summary]

    # Chosen sessions read newest activity first; a tie keeps the list's order.
    order = sorted(range(len(kept)), key=lambda number: kept[number].activity, reverse=True)
    sessions: list[bytes] = []
    for number in order:
        thread = kept[number]
        sessions += [b"," if sessions else b"", thread.head, thread.turns,
                     (b',"leader":' + encode(leaders[number]) if leaders[number] else b"") + b',"pane":' + encode(labels.get(thread.newest))
                     + b',"reopened":' + (b"true" if reopened & set(thread.ids) else b"false") + b"}"]
    built.payload = [
        b'{"generated":', encode(started), b',"since":' + encode(since) + b',"homes":' + encode([home["id"] for home in homes]) + b',"sessions":[',
        *sessions,
        b'],"fleet":[],"summaries":' + encode(summaries) + b',"chosen":true,"documents":{',
        *(piece for number, document in enumerate(documents.values()) for piece in (b"," if number else b"", encode(document.key), b":", document.json)),
        b'},"closed":' + encode(closed) + b',"fleet_timeline":false}',
    ]
    built.files = [(builder.HTML_FILES, json.dumps({d.key: d.path for d in documents.values() if d.kind == "html"})),
                   (builder.IMAGE_FILES, json.dumps({d.key: d.path for d in documents.values() if d.kind == "image"})),
                   (builder.MD_FILES, json.dumps({d.key: d.path for d in documents.values() if d.lazy}))]
    built.output_ids = {thread.newest for thread in kept if thread.has_outputs}
    built.stats = "\n".join([*(kept[number].stats for number in order), "fleet events since window start: {}; open items: 0"])
    return built


# ----------------------------------------------------------------------------------------------------- writing the page

_WRITTEN: dict[Path, list] = {}   # a page file this process wrote -> what its payload (but for its build time) and frame were


def write(built: Built, out: Path) -> bool:
    """Write the page, the files beside it and its stamp as build_prototype.write_page does (the page is replaced in one rename, so the
    server never serves half a page; the stamp holds the build time). False when a build made later is already there, and nothing is
    written. A build whose page would be the one already written writes nothing, and the stamp stays: nothing a page shows has changed."""
    builder.private_folder(out.parent)
    stamp = out.with_suffix(".stamp")
    head, tail = frame()
    same = [head, *built.payload[2:], tail]  # the payload's first two pieces name the build time
    # Each build's output goes through the lock build_prototype.write_page takes: a rebuild started by hand can overlap the server's.
    with builder.private_open(out.with_name(f".{out.name}.lock"), truncate=False) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if float(stamp.read_text(encoding="utf-8")) > built.generated:
                _THREADS.clear()
                return False
        except (OSError, ValueError):
            pass
        # (A conversation built anew has its tool output to write, though its page may be as it was: its file had been taken away.)
        if not built.outputs and _WRITTEN.get(out) == same and out.is_file() and stamp.is_file():
            return True
        try:
            write_outputs(built, out.with_name(builder.STEP_OUTPUTS))
            for name, text in built.files:
                replace(out.with_name(name), [text.encode("utf-8")])
            replace(out, [head, *built.payload, tail])
            replace(stamp, [repr(built.generated).encode("utf-8")])
        except BaseException:
            _THREADS.clear()  # what was kept may be ahead of what was written
            _WRITTEN.pop(out, None)
            raise
        _WRITTEN[out] = same
    return True


def write_outputs(built: Built, folder: Path) -> None:
    """The tool output of the conversations built anew goes beside the page, and the files of conversations that have none left go."""
    builder.private_folder(folder)
    for newest, data in built.outputs.items():
        replace(folder / f"{newest}.json", [data])
    wanted = {f"{newest}.json" for newest in built.output_ids}
    for old in folder.glob("*.json"):
        if old.name not in wanted:
            old.unlink(missing_ok=True)


def replace(target: Path, pieces: list[bytes]) -> None:
    """<target> as the owner-only file of these pieces, in one rename."""
    partial = target.with_name(f".{target.name}.{os.getpid()}.partial")
    builder.private_folder(partial.parent)
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.writelines(pieces)
    os.replace(partial, target)
