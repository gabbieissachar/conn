#!/usr/bin/env python3
"""Build the hosted copy of the transcript reader, and seal it into a local bucket folder.

Ships 1 and 2 of the hosted reader plan, on this laptop only. Nothing is hosted and nothing
is uploaded anywhere: the sync agent's one target is a local folder (the sealed copy).

Usage (from the repo root):
  python3 setup/transcript-reader/sync.py --build-only                 every fleet session (see Scope)
  python3 setup/transcript-reader/sync.py --build-only --reading-list  the local reader's list, to set the two pages side by side
  python3 setup/transcript-reader/sync.py --build-only --session ID    exactly these sessions (repeatable; id, 8-char prefix or log path)
  python3 setup/transcript-reader/sync.py --seal [FOLDER]              build, then redact, encrypt and write the bucket (default out/bucket/);
                                                                       --new-passphrase seals it all again under another passphrase
  python3 setup/transcript-reader/sync.py --wipe [FOLDER]              empty that bucket folder of what --seal wrote (receipts and waiting sends too)
  python3 setup/transcript-reader/sync.py --launch-agent [FOLDER]      print a LaunchAgent that runs --seal every minute
  python3 setup/transcript-reader/sync.py --preview                    list what a build would include, named by Herdr label, and count what it leaves out;
                                                                       writes nothing, needs no passphrase (--show-left-out lists those too)
  Scope: --panes all (default: every conversation in scope, closed panes too) or --panes open (only those in a live Herdr pane,
  plus those you reopened; a conversation dropped by narrowing is pruned from the build and the bucket); with --build-only,
  --seal, --launch-agent (the printed plist carries it) and --preview.
  Options: --full (rebuild every object), --since-hours N (fleet window), --out DIR, --main-home PATH

--seal takes the passphrase from HOSTED_READER_PASSPHRASE; with no terminal (the LaunchAgent, or the reader's server answering the
page's Sync) from the login keychain item pmos-hosted-reader; else it asks for it in a terminal;
it is never written or printed. Each run builds incrementally (below), then, for the
conversations active in the last 90 days, the documents they name and the fleet weeks of the
last 90 days: redacts every text (redact.py; the counts go to out/hosted/redactions.json, never
the text), gzips and seals each changed object with AES-256-GCM under a key derived from the
passphrase (upload.js, prototype/seal.js), deletes what fell out of the 90 days, and seals the
index at least every 5 minutes, so the shell's "As of" stays fresh while the laptop is awake.
The bucket holds index.html and sheet.html (the shells, no transcript), k/params.json (the
salt, no secret), and index.json.enc, s/*.enc, d/*.enc, f/*.enc, a/*.enc, t/*.enc. A passphrase that does not open the bucket stops
the run, unless --new-passphrase says to seal everything again under it.

Scope: by default every Claude Code session log whose working directory lies inside a
fleet home (the main home ~/fm-homes/pmos and each second mate its registry lists), workers'
copies included, and every one whose working directory lies under ~/workspace (the owner's own
working sessions, listed under their own heading in the picker; --workspace DIR names another
folder, --no-workspace leaves them out), with a fleet timeline of the last 14 days when
PMOS_READER_FLEET_TIMELINE is on (off unless set: no fleet records are collected, no f/ week is
written and the page hides the tab; README, "The fleet timeline is off for now"). With
--reading-list or --session the timeline starts at the earliest of those sessions, as on the
local page. Every text goes through the same redaction as the rest.

Output, in out/hosted/ (gitignored with the rest of out/; it embeds private transcripts):
  index.html           the shell: the reader page with no transcript in it, which loads the rest
  sheet.html           the answer sheet's shell, the same way (the local answer sheet's page)
  sw.js, manifest.webmanifest, icon-180.png, icon-512.png
                       the offline copy's service worker, web app manifest and icons (no transcript): a phone opens
                       the sealed copy from the laptop's HTTPS address and keeps it (README, "Read it with the laptop
                       shut")
  index.json           when it was built (as_of), the conversations (home, ids, the Herdr pane and
                       its state as of this build, last activity, asks waiting on you since your
                       last message, object, stamp), the documents and the fleet weeks
  s/<id>.json          one conversation (a pane's sessions across /clear) under its newest id,
                       exactly as the local page's payload holds it
  d/<id>.json          one markdown, HTML or image document a message or reply names, as on disk at the build (an HTML
                       file carries its own text with the pictures, styles and scripts beside it folded in; an image
                       carries its bytes in base64 as its text, within IMAGE_COPY_BYTES each and IMAGE_COPY_TOTAL in all)
  a/<id>.json          the questionnaires of one conversation (replies asking for keyed answers),
                       as the local answer sheet reads them; only for a conversation that has one
  t/<id>.json          the tool output of one conversation, { outputs: { "<turn id>:<n>": text } } (prototype/tool_steps.py:
                       each step's output up to 1,500 characters; never the text of a file the agent read, and none for a step that
                       touched a dotfile or a credential path). The conversation's own object keeps the steps without it, so the page
                       fetches this one when a step opens: the sealed copy keeps it on the device for a conversation active in the last
                       7 days (index.json's steps_from, computed at each build) and on request for an older one. Only for a conversation that has output.
  f/<yyyy>-W<ww>.json  one week (UTC) of fleet records: status lines, steering messages, your
                       messages and the replies to you, linked to the turns that handled them
  manifest.json        what each object was built from (never served)
  pane-labels.json     every Herdr pane a session was seen in, seeded from the local reader's

A run builds a conversation again when one of its logs has a new (mtime, size), when the
rules that build it changed (build_prototype.py, build_questionnaire.py or this file), or when a
steering inbox its doorbells name or a task-instruction file it quotes changed; a document is
read again when its file changed,
and the fleet weeks are put together again from the fleet records every run. An object is
written only when its content changed, and its stamp in index.json changes with it, so the
shell (which polls index.json every 30 seconds while it is visible) reloads only that.
--full builds every conversation and document again. Parsing is build_prototype.py's, with
its cache of parsed logs (parsed/ beside the output folder: out/parsed, the local reader's),
so the shell shows what the local page shows and a log either build parsed is not parsed again.
It takes its own lock, not the local page's rebuild lock, so a long first build never holds
up the local page's refresh.

Send (plan section 8): the page writes a request to q/<uuid>.json (plain copy) or q/<uuid>.json.enc
(sealed bucket), and every run, before it builds, sends what waits there (drain.js: the local
reader's own send, with all its pane checks) and writes a receipt to r/<uuid>.json(.enc) for the page.
--build-only drains out/hosted/; --seal drains it and the bucket. Herdr is the one on PATH,
or HOSTED_READER_HERDR's. Nothing is started when q/ is empty.

The reader's own server serves it beside the local page, at
http://localhost:<port>/setup/transcript-reader/out/hosted/index.html (start it with
bash setup/transcript-reader/serve.sh; PMOS_READER_PORT, default 8768). Only session logs,
the fleet homes' records, the files replies name and Herdr's pane list are read, and only
the output folder and the parsed-log cache are written.
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "prototype"))
import build_prototype as builder  # noqa: E402
import inline_html  # noqa: E402

sys.path.insert(0, str(HERE))
import build_questionnaire as questionnaires  # noqa: E402
import reader  # noqa: E402
import redact  # noqa: E402

OUT = HERE / "out" / "hosted"
BUCKET = HERE / "out" / "bucket"
WORKSPACE = Path.home() / "workspace"  # the owner's own working sessions: logs whose working directory is under it are in scope
WORKSPACE_ID = "workspace"  # the picker's group for them (the page names it "Your own sessions")
LOCAL_PANES = HERE / "out" / "pane-labels.json"
REOPENED = HERE / "out" / "reopened.txt"
VERSION = 1
STEP_DAYS = 7  # the sealed copy's phone keeps a conversation's tool output on the device without being asked for this many days
FLEET_DAYS = 14
RETENTION_DAYS = 90  # plan B3: the bucket keeps 90 days; the laptop keeps everything
HEARTBEAT = 300  # seconds: the index is sealed again at least this often (the shell calls 10 minutes asleep)
# What sits beside the shell pages and is not transcript: the offline copy's service worker (prototype/sw.js), the web app
# manifest and its two icons (drawn here, no image file in the repo). The phone opens the shell, installs the worker and adds
# the page to its Home Screen from these.
STATIC_FILES = ("sw.js", "manifest.webmanifest", "icon-180.png", "icon-512.png")
# An image a reply names is carried in the copy as it is on disk (base64, in its own object), so the copy keeps a limit for each and for
# all of them, which the local viewer (api.js, 10 MB each) does not need. One over the first, or past the second (the newest files
# first), is listed in the index as left out, with why, and the page says so where it would have shown the picture.
IMAGE_COPY_BYTES = 2 * 1024 * 1024
IMAGE_COPY_TOTAL = 12 * 1024 * 1024
PASSPHRASE_ENV = "HOSTED_READER_PASSPHRASE"
KEYCHAIN_SERVICE = "pmos-hosted-reader"
SECURITY_ENV = "HOSTED_READER_SECURITY"  # the `security` program that reads the keychain (a test names a fake; default macOS's own)



# ------------------------------------------------------------------ small parts

def version(path: Path) -> list[int] | None:
    found = builder.file_version(path)
    return list(found) if found else None


def encode(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def stamp_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def replace(path: Path, data: bytes) -> None:
    """Write <path> in one rename, so a reader never sees half an object. It carries the same text
    as Claude's logs, so the file is the owner's alone (0600 in 0700 folders), as the reader's own."""
    builder.private_folder(path.parent)
    partial = path.with_name(f".{path.name}.{os.getpid()}.partial")
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    os.replace(partial, path)


def first_record(path: Path, value):
    """The first non-empty value(record) in a log, reading only as far as it."""
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                found = value(record) if isinstance(record, dict) else None
                if found:
                    return found
    except OSError:
        pass
    return None


# What build_prototype.parsed_log records as a log's first time and working directory, read
# from the log's first lines only: deciding the scope reads every log, parsed or not.
def first_time(path: Path) -> float | None:
    return first_record(path, lambda record: builder.iso_to_epoch(record.get("timestamp")))


def first_cwd(path: Path) -> str:
    return first_record(path, lambda record: record.get("cwd")) or ""


def icon_png(size: int) -> bytes:
    """The app icon: a blue square with a white speech bubble and three lines in it, as a PNG (written with zlib alone)."""
    import struct
    import zlib

    blue, white = (31, 95, 209), (255, 255, 255)

    def inside_round_rect(x: float, y: float, left: float, top: float, right: float, bottom: float, radius: float) -> bool:
        if not (left <= x <= right and top <= y <= bottom):
            return False
        cx = min(max(x, left + radius), right - radius)
        cy = min(max(y, top + radius), bottom - radius)
        return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2

    rows = []
    for row in range(size):
        y = row / size
        line = bytearray([0])
        for column in range(size):
            x = column / size
            color = blue
            bubble = inside_round_rect(x, y, 0.18, 0.22, 0.82, 0.66, 0.08)
            tail = 0.26 <= x <= 0.42 and 0.62 <= y <= 0.62 + (0.42 - x) * 0.9 and y <= 0.80
            if bubble or tail:
                color = white
                for top in (0.33, 0.43, 0.53):
                    if 0.28 <= x <= (0.72 if top < 0.5 else 0.56) and top <= y <= top + 0.045:
                        color = blue
            line += bytes(color)
        rows.append(bytes(line))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


def static_file(name: str) -> bytes:
    if name.startswith("icon-"):
        return icon_png(int(name[len("icon-"):-len(".png")].split("x")[0]))
    return (HERE / "prototype" / name).read_bytes()


def week_of(at: float) -> str:
    year, week, _ = datetime.fromtimestamp(at, timezone.utc).isocalendar()
    return f"{year}-W{week:02d}"


def rules() -> str:
    """The version of every rule that decides a conversation object: the builder's parsing and
    threading (build_prototype.PARSE_RULES), the answer-sheet finder's and this file's. A
    record built under other rules is not fresh, so a fix to either reaches every object."""
    parts = [builder.PARSE_RULES] + [hashlib.sha256(path.read_bytes()).hexdigest()[:16]
                                     for path in (HERE / "prototype" / "build_questionnaire.py", HERE / "prototype" / "inline_html.py", Path(__file__).resolve())]
    return stamp_of("|".join(parts).encode("utf-8"))


def sources(exchanges: list[dict], homes: list[Path], leader: Path | None = None) -> dict:
    """What a conversation reads besides its logs: the steering inboxes its doorbells name, whose
    messages it shows in their place (attach_inbox_bodies), the task-instruction files its
    pointers name (attach_operational_input), and, for a leader's conversation (<leader> is its
    home), the home's backlog and archive, whose rows give the Documents view its task titles."""
    doorbells, briefs = set(), set()
    for exchange in exchanges:
        if exchange["source"] != "firstmate":
            continue
        brief = builder.OPERATIONAL.search(exchange["input"]) if exchange["kind"] == "brief" else None
        if brief:
            briefs.add(brief.group(1))
        elif exchange["kind"] == "steer" and builder.doorbell_inbox(exchange["input"], homes) is not None:
            doorbells.add(exchange["input"])
    return {"homes": [str(home) for home in homes], "doorbells": sorted(doorbells), "briefs": sorted(briefs), "leader": str(leader) if leader else ""}


def inputs_stamp(found: dict) -> str:
    """A stamp of those files as they are now: each inbox a doorbell resolves to (as the builder
    resolves it) with its messages' versions, and each instruction file's version."""
    homes = [Path(home) for home in found["homes"]]
    parts = []
    for text in found["doorbells"]:
        directory = builder.doorbell_inbox(text, homes)
        messages = sorted(directory.glob("*.msg")) + sorted((directory / "handled").glob("*.msg")) if directory.is_dir() else []
        parts.append([str(directory), [[str(path.relative_to(directory)), version(path)] for path in messages]])
    parts += [[path, version(Path(path))] for path in found["briefs"]]
    if found.get("leader"):
        parts += [[name, version(Path(found["leader"]) / "data" / name)] for name in ("backlog.md", "done-archive.md")]
    return stamp_of(encode(parts))


def first_line(text: str) -> str:
    """A timeline row shows only the first line of your message or a reply (the whole turn
    opens from its conversation), so the weekly objects keep only that much of them."""
    lines = text.split("\n")
    for number, line in enumerate(lines):
        if line.strip().replace("﻿", "").strip():
            return "\n".join(lines[: number + 1])
    return text


# ------------------------------------------------------------------- the build

class Build:
    def __init__(self, args) -> None:
        self.args = args
        self.out = Path(args.out).expanduser()
        self.parsed = self.out.parent / "parsed"
        self.started = time.time()  # before any log is read: a turn written during the build is newer
        # The builder reuses its list of every log for a second; a run starts from the logs as they are now.
        builder._LOG_INDEX.clear()
        self.homes, self.parent_of = builder.fleet_homes(args.main_home)
        try:
            old = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            old = {}
        self.old = old if old.get("version") == VERSION else {}
        self.rules = rules()
        # The fleet timeline is built only when the owner switched it on, as for the local page (build_prototype.fleet_timeline_on).
        self.timeline = builder.fleet_timeline_on()
        # The owner's own sessions are a pseudo-home with no records of its own: the conversations get their group and
        # their folder under it, and nothing is read from it for the fleet timeline.
        self.workspace = {"id": WORKSPACE_ID, "home": Path(args.workspace).expanduser()} if getattr(args, "workspace", "") else None
        self.wrote: list[str] = []
        self.rebuilt: list[str] = []
        self.live: dict[str, dict] = {}  # Herdr's live panes, set by run() before any conversation is chosen
        self.reopened: set[str] = set(builder.read_ids(REOPENED))

    def wanted(self, cid: str, ids: list[str]) -> bool:
        """Whether the scope takes this conversation: all of them, or (--panes open) those running in a live Herdr pane
        and those the owner reopened. Decided before a conversation is parsed, so one left out costs nothing each run."""
        return getattr(self.args, "panes", "all") == "all" or cid in self.live or bool(self.reopened & set(ids))

    # Every object goes through here: written only when its bytes changed since the last build.
    def put(self, rel: str, value, before: str | None) -> str:
        data = encode(value)
        stamp = stamp_of(data)
        if stamp != before or not (self.out / rel).is_file():
            replace(self.out / rel, data)
            self.wrote.append(rel)
        return stamp

    def seeds(self) -> list[Path]:
        """The logs the copy is built from, in order; each brings the conversation it belongs to."""
        args = self.args
        if args.session:
            found = []
            for name in args.session:
                try:
                    path = builder.find_session_file(reader.resolve(name, {}, builder.PROJECTS))
                except ValueError as error:
                    raise SystemExit(str(error)) from None
                if not path:
                    raise SystemExit(f"session not found: {name}")
                found.append(path)
            return found
        if args.reading_list:
            ids = reader.read_list()
            if not ids:
                raise SystemExit(f"the local reader's list ({reader.LIST}) is empty")
            return [path for path in (builder.find_session_file(sid) for sid in ids) if path]
        roots = [str(home["home"]) for home in self.homes + ([self.workspace] if self.workspace else [])]
        inside = lambda cwd: any(cwd == root or cwd.startswith(root + "/") for root in roots)  # noqa: E731
        logs = [path for path in builder.all_logs() if inside(first_cwd(path))]
        return sorted(logs, key=lambda path: (version(path) or [0])[0], reverse=True)

    def since(self, seeds: list[Path]) -> float:
        """Where the fleet timeline starts, as build_prototype.build() decides it."""
        args = self.args
        if args.since_hours is not None:
            return self.started - args.since_hours * 3600
        if args.session or args.reading_list:
            starts = [t for t in (first_time(path) for path in seeds) if t is not None]
            return min(starts) if starts else self.started - 72 * 3600
        return self.started - FLEET_DAYS * 86400

    def panes(self) -> dict[str, dict]:
        """Herdr's live panes, with every pane a session was seen in recorded for session_chain.
        The local reader's record is read too (never written), so a new copy knows its history."""
        live = builder.herdr_panes()
        cache = self.out / "pane-labels.json"
        merged = {}
        for path in (LOCAL_PANES, cache):
            try:
                merged.update(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        builder.write_private(cache, json.dumps(merged, indent=1, sort_keys=True))
        builder.pane_labels([], cache, live)
        return live

    def conversations(self, seeds: list[Path]) -> list[tuple[str, dict]]:
        """(id, manifest record) for every conversation the seeds bring, in seed order. A
        conversation whose logs, rules and other inputs are unchanged keeps its record; the rest
        are built again."""
        seed_names = [str(path) for path in seeds]
        in_scope = set(seed_names)
        kept: dict[str, dict] = {}
        if not self.args.full:
            for cid, record in (self.old.get("conversations") or {}).items():
                fresh = record.get("rules") == self.rules and record.get("timeline", True) == self.timeline and all(version(Path(member)) == record["versions"].get(member) for member in record["members"]) \
                    and record.get("inputs") == inputs_stamp(record["sources"])
                if fresh and in_scope & set(record["members"]) and (self.out / record["object"]).is_file() \
                        and (not record.get("steps") or (self.out / record["steps"]["object"]).is_file()) \
                        and self.wanted(cid, record["entry"]["ids"]):
                    kept[cid] = record
        covered = {member for record in kept.values() for member in record["members"]}
        chains: dict[str, tuple[dict, list[Path]]] = {}
        todo = list(seed_names)
        while todo:
            seed = todo.pop(0)
            if seed in covered:
                continue
            chain = builder.session_chain(Path(seed))
            names = [str(member) for member in chain]
            # A chain that grew (a /clear, or Claude restarted in the pane) takes in a kept
            # conversation; the seeds of that one that the new chain does not hold are walked again.
            for cid in [cid for cid, record in kept.items() if set(names) & set(record["members"])]:
                for member in kept.pop(cid)["members"]:
                    covered.discard(member)
                    if member in in_scope and member not in names:
                        todo.append(member)
            covered.update(names)
            home = builder.session_home(self.homes + ([self.workspace] if self.workspace else []), first_cwd(Path(seed)))
            if self.wanted(chain[-1].stem, [member.stem for member in chain]):
                chains[chain[-1].stem] = (home, chain)
        for cid, (home, chain) in chains.items():
            kept[cid] = self.parse(cid, home, chain)
            self.rebuilt.append(cid)
        builder.prune_parsed(self.parsed)
        # In seed order, as build_prototype.build() reads its sessions.
        first_seed = {}
        for cid, record in kept.items():
            first_seed[cid] = min((seed_names.index(member) for member in record["members"] if member in in_scope), default=len(seed_names))
        return sorted(kept.items(), key=lambda item: first_seed[item[0]])

    def parse(self, cid: str, home: dict, chain: list[Path]) -> dict:
        """Parse one conversation and write its object; returns its manifest record."""
        versions = {str(member): version(member) for member in chain}  # before reading: a write during it shows next run
        loaded = {member: builder.parsed_log(member, self.parsed) for member in chain}
        # The inboxes and instruction files too are stamped before thread_session reads them.
        found = sources([e for member in chain for e in loaded[member]["exchanges"]], [h for h in (home["home"], self.parent_of.get(home["id"])) if h],
                        builder.leader_home(loaded[chain[-1]]["cwd"]))
        inputs = inputs_stamp(found)
        session = builder.thread_session(home, chain, loaded, self.parent_of.get(home["id"]))
        exchanges = session["exchanges"]
        # The fleet timeline's own rows from this conversation: your messages and the replies to
        # you, kept with every turn's time and wake-up tasks so later builds can link and window
        # them without parsing the logs again.
        events = []
        for event in builder.captain_events(home, exchanges, 0) if self.timeline else []:
            event["session"] = cid
            event["text"] = first_line(event["text"])
            events.append(event)
        turns = [[e["at"], e["source"], [e.get("signal_task")] + [notice["signal_task"] for notice in e["notices"]]] for e in exchanges]
        builder.mark_sheets([session])
        # The answer sheet's questionnaires, as the local sheet collects them (it re-reads the parsed logs).
        found_sheets = questionnaires.chain_questionnaires(chain, self.parsed)
        sheet = None
        if found_sheets:
            sheet_rel = f"a/{cid}.json"
            before_sheet = (((self.old.get("conversations") or {}).get(cid) or {}).get("sheet") or {}).get("stamp")
            sheet = {"object": sheet_rel, "stamp": self.put(sheet_rel, {"questionnaires": found_sheets}, before_sheet),
                     "list": [questionnaires.list_entry(q) for q in found_sheets]}
        documents = builder.attach_documents([session], html=True, images=True)  # HTML files too (each folded into one text, inline_html.py) and images
        # The tool output goes in an object of its own (the steps stay in the turns, which are the conversation's object).
        outputs = builder.tool_steps.take_outputs(exchanges)
        steps = None
        if outputs:
            steps_rel = f"t/{cid}.json"
            before_steps = (((self.old.get("conversations") or {}).get(cid) or {}).get("steps") or {}).get("stamp")
            steps = {"object": steps_rel, "stamp": self.put(steps_rel, {"outputs": outputs}, before_steps)}
        rel = f"s/{cid}.json"
        before = ((self.old.get("conversations") or {}).get(cid) or {}).get("stamp")
        stamp = self.put(rel, session, before)
        # The asks still open wait on you: the replies that need you with nothing from you after them.
        entry = {key: session[key] for key in ("home", "id", "ids", "file", "where")}
        entry.update(
            last=max((max(e["reply_at"] or 0, e["at"] or 0) for e in exchanges), default=0),
            order=max(((e["reply_at"] or e["at"] or 0) for e in exchanges), default=0),
            turns=len(exchanges),
            needs=sum(1 for e in exchanges if e.get("ask_state") == "open"),
        )
        return {"members": list(versions), "versions": versions, "rules": self.rules, "sources": found, "inputs": inputs,
                "object": rel, "stamp": stamp, "entry": entry, "sheet": sheet, "steps": steps,
                "timeline": self.timeline, "events": events, "turns": turns, "documents": sorted(documents), "found": documents}

    def documents(self, conversations: list[tuple[str, dict]]) -> dict[str, dict]:
        """Every document a conversation names: written again when its file changed (or a
        conversation that names it was parsed again). One that is gone or too big leaves the
        index, as the local page's next build drops it, and comes back when its file does."""
        old = self.old.get("documents") or {}
        found = {}
        for _, record in conversations:
            for doc_id, doc in record.pop("found", {}).items():
                found.setdefault(doc_id, doc)  # the first conversation's spelling, as one local build keeps it
        records = {}
        wanted = []
        for doc_id in sorted({doc_id for _, record in conversations for doc_id in record["documents"]}):
            prior, doc = old.get(doc_id), found.get(doc_id)
            if doc is None and prior is None:
                continue
            # The spelling first seen stays, so parsing another conversation never rewrites the document.
            base = {key: (prior or doc)[key] if key == "mention" else (doc or prior)[key] for key in ("id", "name", "path", "dir", "mention")}
            kind = (doc or prior).get("kind")
            if kind:
                base["kind"] = kind
            wanted.append((doc_id, prior, doc, base, kind))
        left_out = self.images_left_out([(doc_id, Path(base["path"])) for doc_id, _, _, base, kind in wanted if kind == "image"])
        for doc_id, prior, doc, base, kind in wanted:
            is_html = kind == "html"
            path = Path(base["path"])
            now = version(path)
            limit = builder.MAX_HTML_BYTES if is_html else builder.MAX_IMAGE_BYTES if kind == "image" else builder.MAX_DOCUMENT_BYTES
            if now is None or now[1] > limit:
                records[doc_id] = {**base, "gone": True}
                continue
            if doc_id in left_out:
                records[doc_id] = {**base, "version": now, "mtime": now[0] / 1e9, "size": now[1], "left_out": left_out[doc_id]}
                continue
            # An HTML file folds in what it loads from beside itself, so a change to one of those files is a change to it.
            beside = {name: version(Path(name)) for name in (prior or {}).get("assets", {})} if is_html else {}
            if doc is None and not self.args.full and not prior.get("gone") and prior.get("version") == now and prior.get("object") and (self.out / prior["object"]).is_file() \
                    and (not is_html or (prior.get("rules") == self.rules and beside == prior.get("assets"))):
                records[doc_id] = prior
                continue
            rel = f"d/{doc_id}.json"
            try:
                mtime = path.stat().st_mtime
                if is_html:
                    folded = inline_html.fold(path, [Path.home(), *builder.TEMP_ROOTS])
                    value = {**base, "mtime": mtime, "size": now[1], "text": folded["text"], "inlined": folded["inlined"], "skipped": folded["skipped"]}
                    extra = {"size": now[1], "assets": folded["assets"], "rules": self.rules}
                elif kind == "image":
                    mime = builder.IMAGE_TYPES.get(path.suffix.lower(), "application/octet-stream")
                    value = {**base, "mtime": mtime, "size": now[1], "mime": mime, "text": base64.b64encode(path.read_bytes()).decode("ascii")}
                    extra = {"size": now[1], "mime": mime}
                else:
                    value, extra = {**base, "mtime": mtime, "text": path.read_text(encoding="utf-8", errors="replace")}, {}
            except OSError:
                records[doc_id] = {**base, "gone": True}
                continue
            stamp = self.put(rel, value, (prior or {}).get("stamp"))
            records[doc_id] = {**base, "version": now, "mtime": mtime, "object": rel, "stamp": stamp, **extra}
        return records

    def images_left_out(self, images: list[tuple[str, Path]]) -> dict[str, str]:
        """doc id -> why, for each image the copy does not carry: one over IMAGE_COPY_BYTES, or past IMAGE_COPY_TOTAL (the newest
        files are carried first). A file that is gone is not counted: the build marks it so."""
        sized = []
        for doc_id, path in images:
            found = version(path)
            if found and found[1] <= builder.MAX_IMAGE_BYTES:
                sized.append((doc_id, found))
        mb = lambda n: f"{n // (1024 * 1024)} MB"  # noqa: E731
        left_out, used = {}, 0
        for doc_id, (mtime, size) in sorted(sized, key=lambda item: (-item[1][0], item[0])):
            if size > IMAGE_COPY_BYTES:
                left_out[doc_id] = f"over the {mb(IMAGE_COPY_BYTES)} the copy carries for one image"
            elif used + size > IMAGE_COPY_TOTAL:
                left_out[doc_id] = f"past the {mb(IMAGE_COPY_TOTAL)} the copy carries for all its images"
            else:
                used += size
        return left_out

    def fleet(self, conversations: list[tuple[str, dict]], since: float) -> dict[str, dict]:
        """The fleet records of the window (and older items never settled), with your messages and
        the replies to you, linked to the turns that handled them, one object per week. With the
        timeline switched off, none is collected and no week is written."""
        if not self.timeline:
            return {}
        fleet = builder.collect_fleet(self.homes, since)
        sessions = []
        for cid, record in conversations:
            turns = record["turns"]
            # As build_prototype.captain_events windows them: by the turn's own start.
            fleet += [dict(event) for event in record["events"] if (turns[event["ref"]][0] or 0) >= since]
            sessions.append({"home": record["entry"]["home"], "id": cid, "exchanges": [
                {"at": at, "source": source, "signal_task": None, "notices": [{"signal_task": task} for task in tasks]}
                for at, source, tasks in turns]})
        builder.link_turns(fleet, sessions)
        fleet.sort(key=lambda event: event["at"])
        weeks: dict[str, list[dict]] = {}
        for event in fleet:
            weeks.setdefault(week_of(event["at"]), []).append(event)
        old = self.old.get("weeks") or {}
        records = {}
        for key, events in weeks.items():
            rel = f"f/{key}.json"
            stamp = self.put(rel, {"week": key, "events": events}, (old.get(key) or {}).get("stamp"))
            records[key] = {"object": rel, "stamp": stamp, "events": len(events), "open": sum(1 for e in events if e.get("open")),
                            "from": events[0]["at"], "to": events[-1]["at"]}
        return records

    def run(self) -> int:
        builder.private_folder(self.out)
        live = self.live = self.panes()
        if getattr(self.args, "panes", "all") == "open" and not live:
            # Herdr is not running (or lists no pane): this scope would leave nothing, and the prune would empty the copy and the bucket.
            print("Herdr lists no live pane, so --panes open would build nothing; this run stops and leaves the copy as it is.")
            return 1
        seeds = self.seeds()
        since = self.since(seeds)
        conversations = self.conversations(seeds)
        documents = self.documents(conversations)
        weeks = self.fleet(conversations, since)
        page, template = builder.fill_template(builder.TEMPLATE, "null", "hosted")
        shell_stamp = self.put_page(page, self.old.get("shell"))
        sheet_page, sheet_template = builder.fill_template(questionnaires.TEMPLATE, "null", "hosted")
        sheet_stamp = self.put_page(sheet_page, self.old.get("sheet_shell"), "sheet.html")
        for name in STATIC_FILES:
            self.put_static(name)
        ids = [cid for cid, _ in conversations]
        labels = builder.pane_labels(ids, self.out / "pane-labels.json", live)
        reopened = self.reopened
        entries = []
        for cid, record in conversations:
            entry = {**record["entry"], "pane": labels.get(cid), "reopened": bool(reopened & set(record["entry"]["ids"])),
                     "object": record["object"], "stamp": record["stamp"], **({"steps": record["steps"]} if record.get("steps") else {})}
            entries.append(entry)
        # Newest activity first, as the local page lists its chosen sessions.
        entries.sort(key=lambda entry: entry["order"], reverse=True)
        index = {
            "version": VERSION, "as_of": self.started, "since": since, "steps_from": self.started - STEP_DAYS * 86400, "template": template, "sheet_template": sheet_template,
            "homes": [home["id"] for home in self.homes] + ([WORKSPACE_ID] if any(entry["home"] == WORKSPACE_ID for entry in entries) else []),
            "summaries": [summary for summary in (builder.home_summary(home) for home in self.homes) if summary],
            "conversations": entries,
            "documents": {doc_id: {key: record[key] for key in ("id", "name", "dir", "mtime", "object", "stamp", "kind", "size", "mime", "left_out") if key in record}
                          for doc_id, record in documents.items() if not record.get("gone")},
            "weeks": weeks,
            **({} if self.timeline else {"fleet_timeline": False}),
            "sheets": {cid: record["sheet"] for cid, record in conversations if record.get("sheet")},
        }
        replace(self.out / "index.json", encode(index))
        kept = {record["object"] for _, record in conversations} | {record["object"] for record in weeks.values()} \
            | {record["sheet"]["object"] for _, record in conversations if record.get("sheet")} \
            | {record["steps"]["object"] for _, record in conversations if record.get("steps")} \
            | {record["object"] for record in documents.values() if record.get("object")}
        removed = self.sweep(kept)
        manifest = {"version": VERSION, "built": self.started, "shell": shell_stamp, "sheet_shell": sheet_stamp,
                    "conversations": dict(conversations), "documents": documents, "weeks": weeks}
        replace(self.out / "manifest.json", encode(manifest))
        print(f"Built {len(conversations)} conversations ({len(self.rebuilt)} parsed again), {len(documents)} documents, "
              f"{len(weeks)} fleet weeks in {time.time() - self.started:.1f}s; wrote {len(self.wrote)} objects, removed {removed}")
        return 0

    def put_page(self, page: str, before: str | None, name: str = "index.html") -> str:
        data = page.encode("utf-8")
        stamp = stamp_of(data)
        if stamp != before or not (self.out / name).is_file():
            replace(self.out / name, data)
            self.wrote.append(name)
        return stamp

    def put_static(self, name: str) -> None:
        data = static_file(name)
        if not (self.out / name).is_file() or (self.out / name).read_bytes() != data:
            replace(self.out / name, data)
            self.wrote.append(name)

    def sweep(self, kept: set[str]) -> int:
        """Delete objects no conversation, document or week uses any more, and what a stopped build left half written."""
        removed = 0
        for folder in ("s", "d", "f", "a", "t"):
            for path in (self.out / folder).glob("*"):
                if f"{folder}/{path.name}" not in kept and path.is_file():
                    path.unlink()
                    removed += not path.name.endswith(".partial")
        for path in self.out.glob(".*.partial"):
            path.unlink()
        return removed


# ------------------------------------------------------- the sealed copy (ship 2)

class Seal:
    """The sync agent, writing to a local bucket folder only: redact, seal, prune, heartbeat.

    What it sealed is recorded in out/hosted/upload.json (each object's build stamp, its
    redaction counts, the bucket it went to), so a run seals only what changed."""

    def __init__(self, out: Path, target: Path, passphrase: str, new_key: bool = False) -> None:
        self.out, self.target, self.passphrase, self.new_key = out, target, passphrase, new_key
        self.state_file = out / "upload.json"
        try:
            state = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            state = {}
        self.state = state if state.get("target") == str(target.resolve()) else {}

    def retained(self, index: dict, manifest: dict) -> tuple[dict, dict[str, str]]:
        """The index the bucket gets (90 days of conversations, their documents, 90 days of weeks),
        and every object it names, by path, with its build stamp."""
        cutoff = time.time() - RETENTION_DAYS * 86400
        conversations = [entry for entry in index["conversations"] if entry["last"] >= cutoff]
        named = {doc for entry in conversations for doc in (manifest["conversations"].get(entry["id"]) or {}).get("documents", [])}
        documents = {doc_id: meta for doc_id, meta in index["documents"].items() if doc_id in named}
        weeks = {key: meta for key, meta in index["weeks"].items() if meta["to"] >= cutoff}
        sheets = {cid: meta for cid, meta in (index.get("sheets") or {}).items() if any(entry["id"] == cid for entry in conversations)}
        steps = [entry["steps"] for entry in conversations if entry.get("steps")]
        objects = {item["object"]: item["stamp"] for item in [*conversations, *documents.values(), *weeks.values(), *sheets.values(), *steps] if item.get("object")}
        return {**index, "conversations": conversations, "documents": documents, "weeks": weeks, "sheets": sheets}, objects

    def run(self) -> int:
        index = json.loads((self.out / "index.json").read_text(encoding="utf-8"))
        manifest = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        bucket_index, objects = self.retained(index, manifest)
        sealed = self.state.get("objects") or {}
        todo = [rel for rel, stamp in objects.items() if (sealed.get(rel) or {}).get("stamp") != stamp or not (self.target / f"{rel}.enc").is_file()]
        # The index's content without the build's time and the fleet window's start (both move every
        # run): sealed again when the rest changes, and for the heartbeat.
        index_counts: dict[str, int] = {}
        index_text = json.dumps(redact.redact(bucket_index, index_counts), ensure_ascii=False, separators=(",", ":"))
        content = stamp_of(encode({**bucket_index, "as_of": 0, "since": 0, "steps_from": 0}))
        # A shell page that changed (new page code) goes to the bucket now, with the index sealed again, not at the next heartbeat.
        shell_moved = any(not (self.target / name).is_file() or (self.target / name).read_bytes() != (self.out / name).read_bytes() for name in ("index.html", "sheet.html", *STATIC_FILES))
        heartbeat = bool(todo) or self.new_key or self.state.get("index") != content or shell_moved \
            or time.time() - (self.state.get("index_at") or 0) >= HEARTBEAT or not (self.target / "index.json.enc").is_file()
        if not heartbeat:
            removed = self.prune(set(objects))
            print(f"Sealed copy in {self.target}: nothing changed, the index was sealed under {HEARTBEAT // 60} minutes ago; removed {removed}")
            return 0
        child = subprocess.Popen(["node", str(HERE / "upload.js"), str(self.target), *(["--new-key"] if self.new_key else [])],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, PASSPHRASE_ENV: self.passphrase})
        ready = json.loads(child.stdout.readline() or "{}")
        if not ready.get("ready"):
            child.stdin.close()
            child.wait()
            child.stdout.close()
            if ready.get("error") == "wrong-passphrase":
                raise SystemExit("That passphrase does not open this bucket; nothing was sealed. To seal everything under it, add --new-passphrase.")
            raise SystemExit("upload.js did not start; nothing was sealed")
        if ready["rekeyed"]:
            todo, sealed = list(objects), {}  # a new passphrase or a new bucket: every object again
        counts: dict[str, dict] = {}
        try:
            for rel in todo:
                found: dict[str, int] = {}
                value = redact.redact(json.loads((self.out / rel).read_text(encoding="utf-8")), found)
                counts[rel] = found
                child.stdin.write(json.dumps({"path": rel, "text": json.dumps(value, ensure_ascii=False, separators=(",", ":"))}, ensure_ascii=False) + "\n")
            if heartbeat:
                child.stdin.write(json.dumps({"path": "index.json", "text": index_text}, ensure_ascii=False) + "\n")
            child.stdin.close()
        except BrokenPipeError:
            pass
        done = json.loads(child.stdout.readline() or "{}")
        code = child.wait()
        child.stdout.close()
        if code or "written" not in done:
            raise SystemExit("upload.js stopped before sealing every object; the bucket keeps what it had")
        for rel in todo:
            sealed[rel] = {"stamp": objects[rel], "redacted": counts[rel]}
        removed = self.prune(set(objects))
        self.copy_shell()
        now = time.time()
        self.state = {"target": str(self.target.resolve()), "objects": {rel: sealed[rel] for rel in objects if rel in sealed},
                      "index": content if heartbeat else self.state.get("index"), "index_at": now if heartbeat else self.state.get("index_at"),
                      "index_redacted": index_counts}
        replace(self.state_file, encode(self.state))
        self.log_redactions()
        print(f"Sealed copy in {self.target}: sealed {len(todo)} objects{' and the index' if heartbeat else ''}, removed {removed}; "
              f"{len(objects)} objects for {len(bucket_index['conversations'])} conversations of the last {RETENTION_DAYS} days"
              f"{'; a new passphrase or bucket, so every object was sealed again' if ready['rekeyed'] else ''}")
        return 0

    def prune(self, kept: set[str]) -> int:
        """Delete sealed objects the bucket no longer names, and what a stopped run left half written."""
        removed = 0
        for folder in ("s", "d", "f", "a", "t"):
            for path in (self.target / folder).glob("*"):
                rel = f"{folder}/{path.name}"
                if path.is_file() and (rel.endswith(".partial") or (rel.endswith(".json.enc") and rel[:-4] not in kept)):
                    path.unlink()
                    removed += rel.endswith(".enc")
        return removed

    def copy_shell(self) -> None:
        for name in ("index.html", "sheet.html", *STATIC_FILES):
            page = (self.out / name).read_bytes()
            shell = self.target / name
            if not shell.is_file() or shell.read_bytes() != page:
                replace(shell, page)

    def log_redactions(self) -> None:
        """What the redaction took out of the objects now in the bucket: counts by kind, never the text."""
        totals: dict[str, int] = {}
        per_object = {rel: found for rel, item in self.state["objects"].items() if (found := item.get("redacted"))}
        for found in [*per_object.values(), self.state.get("index_redacted") or {}]:
            for kind, count in found.items():
                totals[kind] = totals.get(kind, 0) + count
        replace(self.out / "redactions.json", encode({"totals": totals, "objects": per_object, "index": self.state.get("index_redacted") or {}}))


def drain(folder: Path, sealed: bool, state: Path, secret: str = "") -> None:
    """Send what the page queued in <folder>/q (drain.js, which checks each pane again and writes the
    receipts). Nothing starts when nothing waits. A drain that fails never stops the sync: it says so
    and the requests wait for the next run."""
    if not any(not path.name.startswith(".") for path in (folder / "q").glob("*")):
        return
    try:
        # The ledger of handled ids goes in the output folder's parent (out/), not beside the folder drained.
        done = subprocess.run(["node", str(HERE / "drain.js"), str(folder), "--sealed" if sealed else "--plain", "--state", str(state.resolve())],
                              capture_output=True, text=True,
                              env={**os.environ, **({PASSPHRASE_ENV: secret} if secret else {})}, timeout=600)
    except subprocess.TimeoutExpired:
        print(f"Drain of {folder} took over 10 minutes and was stopped; the requests wait for the next run.")
        return
    print((done.stdout.strip() or done.stderr.strip() or f"Drain of {folder} stopped.").splitlines()[-1])


def wipe(target: Path, out: Path) -> int:
    """Empty <target> of what --seal writes there (and forget what was sealed); nothing else is touched."""
    removed = 0
    for pattern in ("index.html", "sheet.html", *STATIC_FILES, "index.json.enc", "k/params.json", "s/*.json.enc", "d/*.json.enc", "f/*.json.enc", "a/*.json.enc", "t/*.json.enc",
                    "r/*.json.enc", "q/*.json.enc", "q/*.json.enc.claimed", "q/.cancelled-*", "q/.drain.lock", "*/.*.partial", ".*.partial"):
        for path in target.glob(pattern):
            if path.is_file():
                path.unlink()
                removed += 1
    for state in (out / "upload.json", out / "redactions.json"):
        if state.is_file():
            state.unlink()
    print(f"Wiped {target}: {removed} files removed")
    return 0


def keychain_passphrase() -> str:
    """The passphrase kept in the login keychain (the item the LaunchAgent reads: `security add-generic-password -s pmos-hosted-reader
    -a "$USER" -w`), or "" when there is none or the keychain cannot be read. It is read here, inside this run, so no other process is
    handed it, and it is never printed."""
    try:
        done = subprocess.run([os.environ.get(SECURITY_ENV) or "/usr/bin/security", "find-generic-password", "-w", "-s", KEYCHAIN_SERVICE],
                              capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.rstrip("\n") if done.returncode == 0 else ""


def passphrase(target: Path) -> str:
    """The passphrase: from the environment, else (with no terminal: the LaunchAgent, or the reader's server answering the page's Sync)
    from the login keychain, else asked in the terminal (twice for a new bucket)."""
    found = os.environ.get(PASSPHRASE_ENV, "")
    if found:
        return found
    if not sys.stdin.isatty():
        kept = keychain_passphrase()
        if kept:
            return kept
        raise SystemExit(f"Set {PASSPHRASE_ENV}, keep the passphrase in the login keychain (security add-generic-password -s {KEYCHAIN_SERVICE} "
                         f"-a \"$USER\" -w), or run this in a terminal to be asked for the passphrase.")
    import getpass
    first = getpass.getpass("Passphrase for the hosted copy: ")
    if not (target / "k" / "params.json").is_file() and getpass.getpass("Again, to be sure: ") != first:
        raise SystemExit("The two passphrases differ; nothing was sealed.")
    if not first:
        raise SystemExit("An empty passphrase seals nothing.")
    return first


def launch_agent(target: Path, panes: str = "all") -> str:
    """A LaunchAgent (plan 4.2) that runs --seal every minute while the Mac is awake. It is only
    printed: install it yourself. The passphrase comes from the login keychain at each run."""
    command = (f'{PASSPHRASE_ENV}="$(/usr/bin/security find-generic-password -w -s {KEYCHAIN_SERVICE})" '
               f'exec /usr/bin/env python3 "{Path(__file__).resolve()}" --seal "{target.resolve()}"'
               + (" --panes open" if panes == "open" else ""))
    log = HERE / "out" / "sync-agent.log"
    from xml.sax.saxutils import escape
    # launchd's own PATH holds none of the tools a run uses (node seals and sends, python3 builds,
    # herdr is the pane a send reaches), so the agent gets the folders they are in now.
    found = [str(Path(shutil.which(tool)).resolve().parent) for tool in ("node", "python3", "herdr") if shutil.which(tool)]
    path = ":".join(dict.fromkeys([*found, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]))
    # launchd starts the run with none of this shell's environment: the fleet timeline's switch goes along when it is on now,
    # so the agent builds what a build run by hand here would.
    switch = f"\n    <key>{builder.FLEET_TIMELINE_ENV}</key><string>on</string>" if builder.fleet_timeline_on() else ""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pmos.transcript-reader-sync</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>{escape(command)}</string></array>
  <key>WorkingDirectory</key><string>{escape(str(reader.REPO.resolve()))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{escape(path)}</string>{switch}
  </dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>{escape(str(log))}</string>
  <key>StandardErrorPath</key><string>{escape(str(log))}</string>
</dict>
</plist>
"""


def preview(args) -> int:
    """What a build with these options would include, built, sealed and written nowhere: needs no passphrase, takes no lock and
    touches no file (Herdr and the logs are only read). The estimate scales the logs' size by what this machine's last build
    wrote for the conversations it has already built (their total), or by a rough default."""
    build = Build(args)
    live = builder.herdr_panes()
    cache: dict[str, dict] = {}
    for path in (LOCAL_PANES, build.out / "pane-labels.json"):
        try:
            cache.update(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    cache.update(live)
    builder._PANE_HISTORY.clear()
    builder._PANE_HISTORY.update(cache)  # session_chain joins a pane's sessions across a restart with it
    build.live = live
    if args.panes == "open" and not live:
        print("Herdr lists no live pane, so --panes open would build nothing: a real run stops and leaves the copy as it is.")
        return 1
    found: dict[str, dict] = {}
    covered: set[str] = set()
    for seed in build.seeds():
        if str(seed) in covered:
            continue
        chain = builder.session_chain(seed)
        covered.update(str(member) for member in chain)
        cid, ids = chain[-1].stem, [member.stem for member in chain]
        home = builder.session_home(build.homes + ([build.workspace] if build.workspace else []), first_cwd(seed))
        pane = cache.get(cid) or {}
        sizes = [member.stat().st_size for member in chain if member.is_file()]
        last = max((member.stat().st_mtime for member in chain if member.is_file()), default=0)
        found[cid] = {"id": cid, "name": pane.get("label") or pane.get("title") or cid[:8], "home": home["id"], "open": cid in live,
                      "reopened": bool(build.reopened & set(ids)), "last": last, "log": sum(sizes), "in": build.wanted(cid, ids)}
    built = {}
    for cid, record in (build.old.get("conversations") or {}).items():
        try:
            built[cid] = (build.out / record["object"]).stat().st_size
        except OSError:
            continue
    known = [(built[cid], item["log"]) for cid, item in found.items() if cid in built and item["log"]]
    # Logs are mostly tool output the copy drops: on one real fleet the conversations came to about 2% of their logs' size.
    ratio, basis = (sum(o for o, _ in known) / sum(l for _, l in known), f"from {len(known)} conversations already built") if known else (0.02, "a rough default: nothing built here yet")
    included = [item for item in found.values() if item["in"]]
    left = [item for item in found.values() if not item["in"]]
    guess = lambda item: built.get(item["id"], item["log"] * ratio)  # noqa: E731
    recent = [item for item in included if item["last"] >= time.time() - RETENTION_DAYS * 86400]

    width = max([len("conversation")] + [len(item["name"]) for item in included + (left if args.show_left_out else [])])

    def row(item):
        pane = "open" if item["open"] else "reopened" if item["reopened"] else "closed"
        when = datetime.fromtimestamp(item["last"]).strftime("%Y-%m-%d %H:%M") if item["last"] else "-"
        return f"  {item['name']:<{width}}  {item['home'][:24]:<24}  {pane:<8}  {when}"

    mb = lambda n: f"{n / 1e6:.1f} MB"  # noqa: E731
    print(f"Preview (nothing is built, sealed or written). Scope: --panes {args.panes}.")
    print(f"Would build {len(included)} of {len(found)} conversations ({sum(item['open'] for item in included)} with a live pane, "
          f"{sum(item['reopened'] and not item['open'] for item in included)} reopened, {sum(not (item['open'] or item['reopened']) for item in included)} closed); "
          f"{len(recent)} were active in the last {RETENTION_DAYS} days, which is all the sealed copy keeps.")
    print(f"Estimated size of the conversations: {mb(sum(guess(item) for item in included))} built, {mb(sum(guess(item) for item in recent))} sealed "
          f"(estimate {basis}; documents, answer sheets, fleet weeks and the page itself are extra).")
    gone = [cid for cid in built if cid in found and not found[cid]["in"]]
    if gone:
        print(f"Would remove {len(gone)} conversations a build here already wrote ({mb(sum(built[cid] for cid in gone))}), with their documents and answer sheets.")
    heading = f"  {'conversation':<{width}}  {'home':<24}  {'pane':<8}  last activity"
    print(f"\nIncluded ({len(included)}):\n{heading}")
    for item in sorted(included, key=lambda item: -item["last"]):
        print(row(item))
    if args.show_left_out:
        print(f"\nLeft out ({len(left)}):" + (f"\n{heading}" if left else " none"))
        for item in sorted(left, key=lambda item: -item["last"]):
            print(row(item))
    else:
        print(f"\nLeft out: {len(left)}" + (" (add --show-left-out to list them)" if left else ""))
    return 0


def shell_link(out: Path, default: Path = OUT) -> str:
    """The shell's address on the reader's own server, and what to do when that port does not serve this copy."""
    port = os.environ.get("PMOS_READER_PORT", reader.DEFAULT_PORT)
    if out.resolve() != default.resolve():
        return f"{(out / 'index.html').as_uri()} (the reader's server serves only out/hosted/ and out/bucket/)"
    url = f"http://localhost:{port}/{default.relative_to(reader.REPO).as_posix()}/index.html"
    ok, said = reader.serving(port)
    return url if ok else f"{url} ({said} Start it: bash setup/transcript-reader/serve.sh start --port {port})"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--build-only", action="store_true", help="build the hosted copy in the output folder")
    mode.add_argument("--seal", nargs="?", const=str(BUCKET), metavar="FOLDER", help="build, then redact, seal and write the local bucket (default out/bucket/)")
    mode.add_argument("--wipe", nargs="?", const=str(BUCKET), metavar="FOLDER", help="empty the local bucket of what --seal wrote")
    mode.add_argument("--launch-agent", nargs="?", const=str(BUCKET), metavar="FOLDER", help="print a LaunchAgent that runs --seal every minute")
    mode.add_argument("--preview", action="store_true", help="list the conversations the options would include and leave out, with counts and a size estimate; builds, seals and writes nothing")
    parser.add_argument("--panes", choices=("all", "open"), default="all",
                        help="which conversations: all (default; every one in scope, closed panes too) or open (only those in a live Herdr pane, plus those you reopened)")
    parser.add_argument("--show-left-out", action="store_true", help="with --preview: also list the conversations left out (by default only their count is printed)")
    parser.add_argument("--new-passphrase", action="store_true", help="with --seal: seal everything again under a passphrase the bucket does not know yet")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--reading-list", action="store_true", help="build the local reader's list (out/sessions.txt)")
    scope.add_argument("--session", action="append", help="session id, 8-char prefix or log path (repeatable)")
    parser.add_argument("--full", action="store_true", help="parse every conversation and document again")
    parser.add_argument("--since-hours", type=float, help="fleet timeline window (default 14 days, or from the earliest listed session)")
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--main-home", default=str(builder.MAIN_HOME))
    parser.add_argument("--workspace", default=str(WORKSPACE), help="the owner's own sessions: logs whose working directory is under this folder (default ~/workspace)")
    parser.add_argument("--no-workspace", action="store_true", help="leave the owner's own sessions out")
    args = parser.parse_args(argv)
    if args.no_workspace:
        args.workspace = ""
    if not (args.build_only or args.seal or args.wipe or args.launch_agent or args.preview):
        parser.error("say what to do: --build-only, --seal, --wipe, --launch-agent or --preview (nothing is ever uploaded: ship 3 is not built)")
    out = Path(args.out).expanduser()
    if args.preview:
        return preview(args)
    if args.launch_agent:
        print(launch_agent(Path(args.launch_agent).expanduser(), args.panes), end="")
        return 0
    target = Path(args.seal or args.wipe or BUCKET).expanduser()
    secret = passphrase(target) if args.seal else ""
    builder.private_folder(out)
    with builder.private_open(out / ".lock", truncate=False) as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("Another build of this copy is running; this one stops.")
            return 1
        # What an earlier run left with the default modes, in the reader's own out/ folder only
        # (never a folder the caller named elsewhere: it may hold other things).
        own = (HERE / "out").resolve()
        for folder in (out, target):
            if folder.is_dir() and own in [folder.resolve(), *folder.resolve().parents]:
                builder.make_private(folder)
        if args.wipe:
            return wipe(target, out)
        drain(out, False, out.parent)
        if args.seal:
            drain(target, True, out.parent, secret)
        code = Build(args).run()
        if args.seal and not code:
            code = Seal(out, target, secret, args.new_passphrase).run()
    print(f"Hosted shell: {shell_link(out)}")
    if args.seal:
        print(f"Sealed copy:  {shell_link(target, BUCKET)}")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
