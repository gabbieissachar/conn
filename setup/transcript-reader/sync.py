#!/usr/bin/env python3
"""Build the hosted copy of the transcript reader: one small object per conversation.

Ship 1 of the hosted reader plan. It builds on this laptop only: nothing is redacted,
encrypted or uploaded yet (ship 2), so --build-only is the one mode there is.

Usage (from the repo root):
  python3 setup/transcript-reader/sync.py --build-only                 every fleet session (see Scope)
  python3 setup/transcript-reader/sync.py --build-only --reading-list  the local reader's list, to set the two pages side by side
  python3 setup/transcript-reader/sync.py --build-only --session ID    exactly these sessions (repeatable; id, 8-char prefix or log path)
  Options: --full (rebuild every object), --since-hours N (fleet window), --out DIR, --main-home PATH

Scope: by default every Claude Code session log whose working directory lies inside a
fleet home (the main home ~/fm-homes/pmos and each second mate its registry lists), workers'
copies included, with a fleet timeline of the last 14 days. With --reading-list or --session
the timeline starts at the earliest of those sessions, as on the local page.

Output, in out/hosted/ (gitignored with the rest of out/; it embeds private transcripts):
  index.html           the shell: the reader page with no transcript in it, which loads the rest
  index.json           when it was built (as_of), the conversations (home, ids, the Herdr pane and
                       its state as of this build, last activity, asks waiting on you since your
                       last message, object, stamp), the documents and the fleet weeks
  s/<id>.json          one conversation (a pane's sessions across /clear) under its newest id,
                       exactly as the local page's payload holds it
  d/<id>.json          one markdown document a message or reply names, as on disk at the build
  f/<yyyy>-W<ww>.json  one week (UTC) of fleet records: status lines, steering messages, your
                       messages and the replies to you, linked to the turns that handled them
  manifest.json        what each object was built from (never served)
  pane-labels.json     every Herdr pane a session was seen in, seeded from the local reader's

A run compares each log's (mtime, size) with the manifest and builds again only the
conversations with a new or changed log; a document is read again when its file changed,
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
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "prototype"))
import build_prototype as builder  # noqa: E402

sys.path.insert(0, str(HERE))
import reader  # noqa: E402

OUT = HERE / "out" / "hosted"
LOCAL_PANES = HERE / "out" / "pane-labels.json"
REOPENED = HERE / "out" / "reopened.txt"
VERSION = 1
FLEET_DAYS = 14


# ------------------------------------------------------------------ small parts

def version(path: Path) -> list[int] | None:
    found = builder.file_version(path)
    return list(found) if found else None


def encode(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def stamp_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def replace(path: Path, data: bytes) -> None:
    """Write <path> in one rename, so a reader never sees half an object."""
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f".{path.name}.{os.getpid()}.partial")
    partial.write_bytes(data)
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
        self.home_by_id = {home["id"]: home for home in self.homes}
        try:
            old = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            old = {}
        self.old = old if old.get("version") == VERSION else {}
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
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(merged, indent=1, sort_keys=True), encoding="utf-8")
        builder.pane_labels([], cache, live)
        return live

    def conversations(self, seeds: list[Path]) -> list[tuple[str, dict]]:
        """(id, manifest record) for every conversation the seeds bring, in seed order. A
        conversation whose logs are unchanged keeps its record; the rest are parsed again."""
        seed_names = [str(path) for path in seeds]
        in_scope = set(seed_names)
        kept: dict[str, dict] = {}
        if not self.args.full:
            for cid, record in (self.old.get("conversations") or {}).items():
                fresh = all(version(Path(member)) == record["versions"].get(member) for member in record["members"])
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
        return {"members": list(versions), "versions": versions, "object": rel, "stamp": stamp, "entry": entry,
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
        self.out.mkdir(parents=True, exist_ok=True)
        live = self.panes()
        seeds = self.seeds()
        since = self.since(seeds)
        conversations = self.conversations(seeds)
        documents = self.documents(conversations)
        weeks = self.fleet(conversations, since)
        page, template = builder.fill_template(builder.TEMPLATE, "null", "hosted")
        shell_stamp = self.put_page(page, self.old.get("shell"))
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
            "version": VERSION, "as_of": self.started, "since": since, "template": template,
            "homes": [home["id"] for home in self.homes],
            "summaries": [summary for summary in (builder.home_summary(home) for home in self.homes) if summary],
            "conversations": entries,
            "documents": {doc_id: {key: record[key] for key in ("id", "name", "dir", "mtime", "object", "stamp")}
                          for doc_id, record in documents.items() if not record.get("gone")},
            "weeks": weeks,
        }
        replace(self.out / "index.json", encode(index))
        kept = {record["object"] for _, record in conversations} | {record["object"] for record in weeks.values()} \
            | {record["object"] for record in documents.values() if not record.get("gone")}
        removed = self.sweep(kept)
        manifest = {"version": VERSION, "built": self.started, "shell": shell_stamp,
                    "conversations": dict(conversations), "documents": documents, "weeks": weeks}
        replace(self.out / "manifest.json", encode(manifest))
        print(f"Built {len(conversations)} conversations ({len(self.rebuilt)} parsed again), {len(documents)} documents, "
              f"{len(weeks)} fleet weeks in {time.time() - self.started:.1f}s; wrote {len(self.wrote)} objects, removed {removed}")
        return 0

    def put_page(self, page: str, before: str | None) -> str:
        data = page.encode("utf-8")
        stamp = stamp_of(data)
        if stamp != before or not (self.out / "index.html").is_file():
            replace(self.out / "index.html", data)
            self.wrote.append("index.html")
        return stamp

    def sweep(self, kept: set[str]) -> int:
        """Delete objects no conversation, document or week uses any more, and what a stopped build left half written."""
        removed = 0
        for folder in ("s", "d", "f"):
            for path in (self.out / folder).glob("*"):
                if f"{folder}/{path.name}" not in kept and path.is_file():
                    path.unlink()
                    removed += not path.name.endswith(".partial")
        for path in self.out.glob(".*.partial"):
            path.unlink()
        return removed


def shell_link(out: Path) -> str:
    """The shell's address on the reader's own server, and what to do when that port does not serve this copy."""
    port = os.environ.get("PMOS_READER_PORT", reader.DEFAULT_PORT)
    if out.resolve() != OUT.resolve():
        return f"{(out / 'index.html').as_uri()} (the reader's server serves only out/hosted/)"
    url = f"http://localhost:{port}/{OUT.relative_to(reader.REPO).as_posix()}/index.html"
    ok, said = reader.serving(port)
    return url if ok else f"{url} ({said} Start it: bash setup/transcript-reader/serve.sh start --port {port})"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--build-only", action="store_true", help="build the hosted copy in the output folder (the only mode in ship 1)")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--reading-list", action="store_true", help="build the local reader's list (out/sessions.txt)")
    scope.add_argument("--session", action="append", help="session id, 8-char prefix or log path (repeatable)")
    parser.add_argument("--full", action="store_true", help="parse every conversation and document again")
    parser.add_argument("--since-hours", type=float, help="fleet timeline window (default 14 days, or from the earliest listed session)")
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--main-home", default=str(builder.MAIN_HOME))
    args = parser.parse_args(argv)
    if not args.build_only:
        parser.error("only --build-only exists yet: redaction, encryption and the upload come with ship 2")
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    with open(out / ".lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("Another build of this copy is running; this one stops.")
            return 1
        code = Build(args).run()
    print(f"Hosted shell: {shell_link(out)}")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
