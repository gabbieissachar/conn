#!/usr/bin/env python3
"""Build the hosted copy of the transcript reader, and seal it into a local bucket folder.

Ships 1 and 2 of the hosted reader plan, on this laptop only. Nothing is hosted and nothing
is uploaded anywhere: the sync agent's one target is a local folder (a dry run).

Usage (from the repo root):
  python3 setup/transcript-reader/sync.py --build-only                 every fleet session (see Scope)
  python3 setup/transcript-reader/sync.py --build-only --reading-list  the local reader's list, to set the two pages side by side
  python3 setup/transcript-reader/sync.py --build-only --session ID    exactly these sessions (repeatable; id, 8-char prefix or log path)
  python3 setup/transcript-reader/sync.py --dry-run [FOLDER]           build, then redact, encrypt and write the bucket (default out/bucket/);
                                                                       --new-passphrase seals it all again under another passphrase
  python3 setup/transcript-reader/sync.py --wipe [FOLDER]              empty that bucket folder of what the dry run wrote
  python3 setup/transcript-reader/sync.py --launch-agent [FOLDER]      print a LaunchAgent that runs the dry run every minute
  Options: --full (rebuild every object), --since-hours N (fleet window), --out DIR, --main-home PATH

The dry run takes the passphrase from HOSTED_READER_PASSPHRASE, or asks for it in a terminal;
it is never written or printed. Each run builds incrementally (below), then, for the
conversations active in the last 90 days, the documents they name and the fleet weeks of the
last 90 days: redacts every text (redact.py; the counts go to out/hosted/redactions.json, never
the text), gzips and seals each changed object with AES-256-GCM under a key derived from the
passphrase (upload.js, prototype/seal.js), deletes what fell out of the 90 days, and seals the
index at least every 5 minutes, so the shell's "As of" stays fresh while the laptop is awake.
The bucket holds index.html and sheet.html (the shells, no transcript), k/params.json (the
salt, no secret), and index.json.enc, s/*.enc, d/*.enc, f/*.enc, a/*.enc. A passphrase that does not open the bucket stops
the run, unless --new-passphrase says to seal everything again under it.

Scope: by default every Claude Code session log whose working directory lies inside a
fleet home (the main home ~/fm-homes/pmos and each second mate its registry lists), workers'
copies included, with a fleet timeline of the last 14 days. With --reading-list or --session
the timeline starts at the earliest of those sessions, as on the local page.

Output, in out/hosted/ (gitignored with the rest of out/; it embeds private transcripts):
  index.html           the shell: the reader page with no transcript in it, which loads the rest
  sheet.html           the answer sheet's shell, the same way (the local answer sheet's page)
  index.json           when it was built (as_of), the conversations (home, ids, the Herdr pane and
                       its state as of this build, last activity, asks waiting on you since your
                       last message, object, stamp), the documents and the fleet weeks
  s/<id>.json          one conversation (a pane's sessions across /clear) under its newest id,
                       exactly as the local page's payload holds it
  d/<id>.json          one markdown document a message or reply names, as on disk at the build
  a/<id>.json          the questionnaires of one conversation (replies asking for keyed answers),
                       as the local answer sheet reads them; only for a conversation that has one
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

The reader's own server serves it beside the local page, at
http://localhost:<port>/setup/transcript-reader/out/hosted/index.html (start it with
bash setup/transcript-reader/serve.sh; PMOS_READER_PORT, default 8768). Only session logs,
the fleet homes' records, the files replies name and Herdr's pane list are read, and only
the output folder and the parsed-log cache are written.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "prototype"))
import build_prototype as builder  # noqa: E402

sys.path.insert(0, str(HERE))
import build_questionnaire as questionnaires  # noqa: E402
import reader  # noqa: E402
import redact  # noqa: E402

OUT = HERE / "out" / "hosted"
BUCKET = HERE / "out" / "bucket"
LOCAL_PANES = HERE / "out" / "pane-labels.json"
REOPENED = HERE / "out" / "reopened.txt"
VERSION = 1
FLEET_DAYS = 14
RETENTION_DAYS = 90  # plan B3: the bucket keeps 90 days; the laptop keeps everything
HEARTBEAT = 300  # seconds: the index is sealed again at least this often (the shell calls 10 minutes asleep)
PASSPHRASE_ENV = "HOSTED_READER_PASSPHRASE"
KEYCHAIN_SERVICE = "pmos-hosted-reader"



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


def week_of(at: float) -> str:
    year, week, _ = datetime.fromtimestamp(at, timezone.utc).isocalendar()
    return f"{year}-W{week:02d}"


def rules() -> str:
    """The version of every rule that decides a conversation object: the builder's parsing and
    threading (build_prototype.PARSE_RULES), the answer-sheet finder's and this file's. A
    record built under other rules is not fresh, so a fix to either reaches every object."""
    parts = [builder.PARSE_RULES] + [hashlib.sha256(path.read_bytes()).hexdigest()[:16]
                                     for path in (HERE / "prototype" / "build_questionnaire.py", Path(__file__).resolve())]
    return stamp_of("|".join(parts).encode("utf-8"))


def sources(exchanges: list[dict], homes: list[Path]) -> dict:
    """What a conversation reads besides its logs: the steering inboxes its doorbells name, whose
    messages it shows in their place (attach_inbox_bodies), and the task-instruction files its
    pointers name (attach_operational_input)."""
    doorbells, briefs = set(), set()
    for exchange in exchanges:
        if exchange["source"] != "firstmate":
            continue
        brief = builder.OPERATIONAL.search(exchange["input"]) if exchange["kind"] == "brief" else None
        if brief:
            briefs.add(brief.group(1))
        elif exchange["kind"] == "steer" and builder.doorbell_inbox(exchange["input"], homes) is not None:
            doorbells.add(exchange["input"])
    return {"homes": [str(home) for home in homes], "doorbells": sorted(doorbells), "briefs": sorted(briefs)}


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
        self.wrote: list[str] = []
        self.rebuilt: list[str] = []

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
        roots = [str(home["home"]) for home in self.homes]
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
                fresh = record.get("rules") == self.rules and all(version(Path(member)) == record["versions"].get(member) for member in record["members"]) \
                    and record.get("inputs") == inputs_stamp(record["sources"])
                if fresh and in_scope & set(record["members"]) and (self.out / record["object"]).is_file():
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
            home = builder.session_home(self.homes, first_cwd(Path(seed)))
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
        found = sources([e for member in chain for e in loaded[member]["exchanges"]], [h for h in (home["home"], self.parent_of.get(home["id"])) if h])
        inputs = inputs_stamp(found)
        session = builder.thread_session(home, chain, loaded, self.parent_of.get(home["id"]))
        exchanges = session["exchanges"]
        # The fleet timeline's own rows from this conversation: your messages and the replies to
        # you, kept with every turn's time and wake-up tasks so later builds can link and window
        # them without parsing the logs again.
        events = []
        for event in builder.captain_events(home, exchanges, 0):
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
                     "list": [{"at": q["at"], "open": len(q["cards"]), "title": q["title"]} for q in found_sheets]}
        documents = builder.attach_documents([session])
        rel = f"s/{cid}.json"
        before = ((self.old.get("conversations") or {}).get(cid) or {}).get("stamp")
        stamp = self.put(rel, session, before)
        # The replies that need you from your last message on (its own reply included) wait on you.
        mine = max((i for i, e in enumerate(exchanges) if e["source"] == "captain"), default=0)
        entry = {key: session[key] for key in ("home", "id", "ids", "file", "where")}
        entry.update(
            last=max((max(e["reply_at"] or 0, e["at"] or 0) for e in exchanges), default=0),
            order=max(((e["reply_at"] or e["at"] or 0) for e in exchanges), default=0),
            turns=len(exchanges),
            needs=sum(1 for e in exchanges[mine:] if e["verdict"] == "needs-you"),
        )
        return {"members": list(versions), "versions": versions, "rules": self.rules, "sources": found, "inputs": inputs,
                "object": rel, "stamp": stamp, "entry": entry, "sheet": sheet,
                "events": events, "turns": turns, "documents": sorted(documents), "found": documents}

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
        for doc_id in sorted({doc_id for _, record in conversations for doc_id in record["documents"]}):
            prior, doc = old.get(doc_id), found.get(doc_id)
            if doc is None and prior is None:
                continue
            # The spelling first seen stays, so parsing another conversation never rewrites the document.
            base = {key: (prior or doc)[key] if key == "mention" else (doc or prior)[key] for key in ("id", "name", "path", "dir", "mention")}
            path = Path(base["path"])
            now = version(path)
            if now is None or now[1] > builder.MAX_DOCUMENT_BYTES:
                records[doc_id] = {**base, "gone": True}
                continue
            if doc is None and not self.args.full and not prior.get("gone") and prior.get("version") == now and (self.out / prior["object"]).is_file():
                records[doc_id] = prior
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
                mtime = path.stat().st_mtime
            except OSError:
                records[doc_id] = {**base, "gone": True}
                continue
            rel = f"d/{doc_id}.json"
            stamp = self.put(rel, {**base, "mtime": mtime, "text": text}, (prior or {}).get("stamp"))
            records[doc_id] = {**base, "version": now, "mtime": mtime, "object": rel, "stamp": stamp}
        return records

    def fleet(self, conversations: list[tuple[str, dict]], since: float) -> dict[str, dict]:
        """The fleet records of the window (and older items never settled), with your messages and
        the replies to you, linked to the turns that handled them, one object per week."""
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
        live = self.panes()
        seeds = self.seeds()
        since = self.since(seeds)
        conversations = self.conversations(seeds)
        documents = self.documents(conversations)
        weeks = self.fleet(conversations, since)
        page, template = builder.fill_template(builder.TEMPLATE, "null", "hosted")
        shell_stamp = self.put_page(page, self.old.get("shell"))
        sheet_page, sheet_template = builder.fill_template(questionnaires.TEMPLATE, "null", "hosted")
        sheet_stamp = self.put_page(sheet_page, self.old.get("sheet_shell"), "sheet.html")
        ids = [cid for cid, _ in conversations]
        labels = builder.pane_labels(ids, self.out / "pane-labels.json", live)
        reopened = set(builder.read_ids(REOPENED))
        entries = []
        for cid, record in conversations:
            entry = {**record["entry"], "pane": labels.get(cid), "reopened": bool(reopened & set(record["entry"]["ids"])),
                     "object": record["object"], "stamp": record["stamp"]}
            entries.append(entry)
        # Newest activity first, as the local page lists its chosen sessions.
        entries.sort(key=lambda entry: entry["order"], reverse=True)
        index = {
            "version": VERSION, "as_of": self.started, "since": since, "template": template, "sheet_template": sheet_template,
            "homes": [home["id"] for home in self.homes],
            "summaries": [summary for summary in (builder.home_summary(home) for home in self.homes) if summary],
            "conversations": entries,
            "documents": {doc_id: {key: record[key] for key in ("id", "name", "dir", "mtime", "object", "stamp")}
                          for doc_id, record in documents.items() if not record.get("gone")},
            "weeks": weeks,
            "sheets": {cid: record["sheet"] for cid, record in conversations if record.get("sheet")},
        }
        replace(self.out / "index.json", encode(index))
        kept = {record["object"] for _, record in conversations} | {record["object"] for record in weeks.values()} \
            | {record["sheet"]["object"] for _, record in conversations if record.get("sheet")} \
            | {record["object"] for record in documents.values() if not record.get("gone")}
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

    def sweep(self, kept: set[str]) -> int:
        """Delete objects no conversation, document or week uses any more, and what a stopped build left half written."""
        removed = 0
        for folder in ("s", "d", "f", "a"):
            for path in (self.out / folder).glob("*"):
                if f"{folder}/{path.name}" not in kept and path.is_file():
                    path.unlink()
                    removed += not path.name.endswith(".partial")
        for path in self.out.glob(".*.partial"):
            path.unlink()
        return removed


# ------------------------------------------------------- the dry run (ship 2)

class DryRun:
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
        objects = {item["object"]: item["stamp"] for item in [*conversations, *documents.values(), *weeks.values(), *sheets.values()]}
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
        content = stamp_of(encode({**bucket_index, "as_of": 0, "since": 0}))
        heartbeat = bool(todo) or self.new_key or self.state.get("index") != content \
            or time.time() - (self.state.get("index_at") or 0) >= HEARTBEAT or not (self.target / "index.json.enc").is_file()
        if not heartbeat:
            removed = self.prune(set(objects))
            print(f"Dry run into {self.target}: nothing changed, the index was sealed under {HEARTBEAT // 60} minutes ago; removed {removed}")
            return 0
        child = subprocess.Popen(["node", str(HERE / "upload.js"), str(self.target), *(["--new-key"] if self.new_key else [])],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, PASSPHRASE_ENV: self.passphrase})
        ready = json.loads(child.stdout.readline() or "{}")
        if not ready.get("ready"):
            child.stdin.close()
            child.wait()
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
        if child.wait() or "written" not in done:
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
        print(f"Dry run into {self.target}: sealed {len(todo)} objects{' and the index' if heartbeat else ''}, removed {removed}; "
              f"{len(objects)} objects for {len(bucket_index['conversations'])} conversations of the last {RETENTION_DAYS} days"
              f"{'; a new passphrase or bucket, so every object was sealed again' if ready['rekeyed'] else ''}")
        return 0

    def prune(self, kept: set[str]) -> int:
        """Delete sealed objects the bucket no longer names, and what a stopped run left half written."""
        removed = 0
        for folder in ("s", "d", "f", "a"):
            for path in (self.target / folder).glob("*"):
                rel = f"{folder}/{path.name}"
                if path.is_file() and (rel.endswith(".partial") or (rel.endswith(".json.enc") and rel[:-4] not in kept)):
                    path.unlink()
                    removed += rel.endswith(".enc")
        return removed

    def copy_shell(self) -> None:
        for name in ("index.html", "sheet.html"):
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


def wipe(target: Path, out: Path) -> int:
    """Empty <target> of what the dry run writes there (and forget what was sealed); nothing else is touched."""
    removed = 0
    for pattern in ("index.html", "sheet.html", "index.json.enc", "k/params.json", "s/*.json.enc", "d/*.json.enc", "f/*.json.enc", "a/*.json.enc",
                    "*/.*.partial", ".*.partial"):
        for path in target.glob(pattern):
            if path.is_file():
                path.unlink()
                removed += 1
    for state in (out / "upload.json", out / "redactions.json"):
        if state.is_file():
            state.unlink()
    print(f"Wiped {target}: {removed} files removed")
    return 0


def passphrase(target: Path) -> str:
    """The passphrase: from the environment, else asked in the terminal (twice for a new bucket)."""
    found = os.environ.get(PASSPHRASE_ENV, "")
    if found:
        return found
    if not sys.stdin.isatty():
        raise SystemExit(f"Set {PASSPHRASE_ENV}, or run this in a terminal to be asked for the passphrase.")
    import getpass
    first = getpass.getpass("Passphrase for the hosted copy: ")
    if not (target / "k" / "params.json").is_file() and getpass.getpass("Again, to be sure: ") != first:
        raise SystemExit("The two passphrases differ; nothing was sealed.")
    if not first:
        raise SystemExit("An empty passphrase seals nothing.")
    return first


def launch_agent(target: Path) -> str:
    """A LaunchAgent (plan 4.2) that runs the dry run every minute while the Mac is awake. It is only
    printed: install it yourself. The passphrase comes from the login keychain at each run."""
    command = (f'{PASSPHRASE_ENV}="$(/usr/bin/security find-generic-password -w -s {KEYCHAIN_SERVICE})" '
               f'exec /usr/bin/env python3 "{Path(__file__).resolve()}" --dry-run "{target.resolve()}"')
    log = HERE / "out" / "sync-agent.log"
    from xml.sax.saxutils import escape
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pmos.transcript-reader-sync</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>{escape(command)}</string></array>
  <key>WorkingDirectory</key><string>{escape(str(reader.REPO.resolve()))}</string>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>{escape(str(log))}</string>
  <key>StandardErrorPath</key><string>{escape(str(log))}</string>
</dict>
</plist>
"""


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
    mode.add_argument("--dry-run", nargs="?", const=str(BUCKET), metavar="FOLDER", help="build, then redact, seal and write the local bucket (default out/bucket/)")
    mode.add_argument("--wipe", nargs="?", const=str(BUCKET), metavar="FOLDER", help="empty the local bucket of what the dry run wrote")
    mode.add_argument("--launch-agent", nargs="?", const=str(BUCKET), metavar="FOLDER", help="print a LaunchAgent that runs the dry run every minute")
    parser.add_argument("--new-passphrase", action="store_true", help="with --dry-run: seal everything again under a passphrase the bucket does not know yet")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--reading-list", action="store_true", help="build the local reader's list (out/sessions.txt)")
    scope.add_argument("--session", action="append", help="session id, 8-char prefix or log path (repeatable)")
    parser.add_argument("--full", action="store_true", help="parse every conversation and document again")
    parser.add_argument("--since-hours", type=float, help="fleet timeline window (default 14 days, or from the earliest listed session)")
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--main-home", default=str(builder.MAIN_HOME))
    args = parser.parse_args(argv)
    if not (args.build_only or args.dry_run or args.wipe or args.launch_agent):
        parser.error("say what to do: --build-only, --dry-run, --wipe or --launch-agent (nothing is ever uploaded: ship 3 is not built)")
    out = Path(args.out).expanduser()
    if args.launch_agent:
        print(launch_agent(Path(args.launch_agent).expanduser()), end="")
        return 0
    target = Path(args.dry_run or args.wipe or BUCKET).expanduser()
    secret = passphrase(target) if args.dry_run else ""
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
        code = Build(args).run()
        if args.dry_run and not code:
            code = DryRun(out, target, secret, args.new_passphrase).run()
    print(f"Hosted shell: {shell_link(out)}")
    if args.dry_run:
        print(f"Sealed copy:  {shell_link(target, BUCKET)}")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
