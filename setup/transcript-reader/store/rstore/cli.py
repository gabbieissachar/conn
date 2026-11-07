"""The command line of the store. `python3 setup/transcript-reader/store/reader_store.py <command>`; `--help` lists them.

Everything reads or writes only the store's own folder (PMOS_READER_STORE_DIR, default ~/.config/pmos-transcript-reader/store). Nothing
here touches the live reader's out/ folder, its port 8768, or any pane. Commands that would change the machine outside the store
(`launchd`, `key-command`) print and never run.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from . import backup, config, coverage, daemon, db, disagree, forget as forget_mod, herdr, identity, ingest, known_answers, launchd, parity, rusage, scorecard, search as search_mod, sendrec

STORE = Path(__file__).resolve().parent.parent
REQUIRED_LAB = ("test_a_killed_ingest_leaves_no_duplicate_or_missing_events", "test_deleted_log_leaves_the_session_marked_log_gone", "test_truncation_starts_a_new_generation_and_keeps_the_old_rows",
                "test_forget_removes_a_session_everywhere_and_it_is_never_taken_again", "test_clear_relinks_within_two_seconds")


def home_dir() -> Path:
    return Path(os.environ.get("PMOS_READER_STORE_HOME") or Path.home())


def say(value) -> None:
    print(json.dumps(value, indent=2, sort_keys=True, default=str) if not isinstance(value, str) else value)


class Ctx:
    def __init__(self):
        self.where = config.paths()
        self.settings = config.load_settings(self.where)
        self._conn = None

    @property
    def conn(self):
        if self._conn is None:
            self._conn = db.connect(self.where.db)
        return self._conn


# ----------------------------------------------------------------------------------------------------------------- commands

def cmd_init(ctx, args):
    ctx.conn
    if not ctx.where.settings.exists():
        config.save_settings(ctx.where, ctx.settings)
    say({"store": str(ctx.where.db), "settings": str(ctx.where.settings), "schema_version": 1})


def cmd_scan(ctx, args):
    with db.single_writer(ctx.where.lock):
        ing = ingest.Ingester(ctx.conn, ctx.settings, home_dir())
        with rusage.meter(ctx.conn, "ingest", "scan") as use:
            result = ing.scan()
        ing.heartbeat(result, status="stopped")
    say({"files": result.files, "changed": result.changed, "new": result.new, "replaced": result.replaced, "gone": result.gone, "skipped": result.skipped,
         "errors": len(result.errors), "cpu_s": round(use["user_s"] + use["sys_s"], 2), "wall_s": round(use["wall_s"], 2), "peak_rss_mb": round(use["maxrss_kb"] / 1024)})


def cmd_run(ctx, args):
    with db.single_writer(ctx.where.lock):
        return daemon.Daemon(ctx.where, ctx.settings, home_dir()).run()


def cmd_status(ctx, args):
    conn = ctx.conn
    heartbeat = conn.execute("SELECT * FROM ingest_heartbeat").fetchone()
    now = time.time()
    counts = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("sessions", "turns", "events", "sources", "panes", "facts", "bindings", "identity_events", "links")}
    say({"store": str(ctx.where.db), "bytes": ctx.where.db.stat().st_size, "schema_version": conn.execute("PRAGMA user_version").fetchone()[0],
         "heartbeat": ({"at": heartbeat["at"], "age_s": round(now - heartbeat["at"], 1), "status": heartbeat["status"], "pid": heartbeat["pid"], "lag_s": heartbeat["lag_s"]} if heartbeat else None),
         "counts": counts,
         "sessions_by_harness": {r[0]: r[1] for r in conn.execute("SELECT harness, COUNT(*) FROM sessions GROUP BY harness")},
         "sessions_log_gone": conn.execute("SELECT COUNT(*) FROM sessions WHERE log_state = 'gone'").fetchone()[0],
         "counters": {f"{r['name']}/{r['key']}": r["count"] for r in conn.execute("SELECT * FROM counters ORDER BY name, key")},
         "live_bindings": conn.execute("SELECT COUNT(*) FROM bindings WHERE valid_to IS NULL").fetchone()[0],
         "backups": [dict(r) for r in conn.execute("SELECT snapshot, bytes, uploaded_at FROM backups ORDER BY at DESC LIMIT 3")]})


def cmd_search(ctx, args):
    for hit in search_mod.search(ctx.conn, " ".join(args.query), args.limit, scope=args.scope):
        when = time.strftime("%Y-%m-%d", time.gmtime(hit["last_at"])) if hit["last_at"] else "-"
        print(f"{hit['session_id']}  {hit['harness']:<7} {hit['scope']:<13} {when}  {Path(hit['cwd'] or '').name or '-'}  {hit['title'] or ''}\n    {hit['snippet']}")


def cmd_forget(ctx, args):
    with db.single_writer(ctx.where.lock):
        report = forget_mod.forget(ctx.conn, args.session, note=args.note)
    say(report)
    if report["older_snapshots"]:
        print("\nThese earlier snapshots were taken before the session was forgotten and may still hold it. Move them aside (never rm):", file=sys.stderr)
        for name in report["older_snapshots"]:
            print(f"  {ctx.where.staging / name}", file=sys.stderr)


def cmd_parity(ctx, args):
    run = parity.run(ctx.conn, trigger=args.trigger, session_ids=args.session or None, limit=args.limit)
    row = ctx.conn.execute("SELECT * FROM parity_runs WHERE run_id = ?", (run,)).fetchone()
    say({k: row[k] for k in row.keys()})
    for m in ctx.conn.execute("SELECT * FROM parity_mismatches WHERE run_id = ? LIMIT 20", (run,)):
        print(f"  {m['session_id'][:8]} {m['turn_uid']} {m['field']}: store={m['store_value'][:80]!r} builder={m['builder_value'][:80]!r}")
    return 1 if row["unexplained"] else 0


def cmd_parity_report(ctx, args):
    for r in ctx.conn.execute("SELECT * FROM parity_runs ORDER BY at DESC LIMIT ?", (args.limit,)):
        print(f"{time.strftime('%Y-%m-%d %H:%M', time.gmtime(r['at']))}Z {r['trigger']:<8} sessions={r['sessions']} turns={r['turns']} mismatches={r['mismatches']} unexplained={r['unexplained']} skipped={r['skipped']} cpu={r['cpu_s']:.1f}s")


def cmd_backup(ctx, args):
    result = backup.stage(ctx.conn, ctx.where, ctx.settings)
    say(result)
    if args.upload:
        say(backup.upload(ctx.conn, ctx.where, ctx.settings, Path(result["path"])))
    older = backup.older_than(ctx.where, ctx.settings.keep_snapshots)
    if older:
        print(f"{len(older)} staged snapshots are older than the newest {ctx.settings.keep_snapshots}; move them aside when you want the space (never rm).", file=sys.stderr)


def cmd_backup_verify(ctx, args):
    target = Path(args.file) if args.file else max(ctx.where.staging.glob("reader-store-*.sqlite.*"), key=lambda p: p.name)
    scratch = Path(args.scratch) if args.scratch else ctx.where.root / "restore-check" / time.strftime("%Y%m%dT%H%M%S")
    say(backup.verify(target, ctx.settings, scratch))


def cmd_key_command(ctx, args):
    print("LIVE WRITE - this creates the backup key in your login keychain. Run it yourself, once, and type a long random passphrase when asked.")
    print("Keep a copy in your password manager: a lost key means the backups cannot be read.\n")
    print("  " + backup.init_key_command(ctx.settings))
    print("\nIf age is installed instead: age-keygen -o <file>, put the public key in settings.json as age_recipient, and keep the private key in the keychain.")


def cmd_nightly(ctx, args):
    """The nightly job: the diff job, the builder-map sample, a staged encrypted backup, and the upload step (which stops until Drive is set up)."""
    out: dict = {}
    run = parity.run(ctx.conn, trigger="nightly")
    row = ctx.conn.execute("SELECT * FROM parity_runs WHERE run_id = ?", (run,)).fetchone()
    out["parity"] = {k: row[k] for k in ("sessions", "turns", "mismatches", "unexplained", "skipped", "cpu_s")}
    try:
        out["disagreements"] = disagree.sample(ctx.conn, disagree.builder_map(), note="nightly")
    except Exception as error:  # the builder reads Herdr; a failure there must not stop the backup
        out["disagreements"] = {"error": type(error).__name__}
    try:
        staged = backup.stage(ctx.conn, ctx.where, ctx.settings)
        out["backup"] = {k: staged[k] for k in ("snapshot", "bytes", "tool")}
        out["upload"] = backup.upload(ctx.conn, ctx.where, ctx.settings, Path(staged["path"]))
    except backup.BackupError as error:
        out["backup"] = {"error": str(error)}
    say(out)
    return 0


def cmd_record_send(ctx, args):
    check_id = sendrec.record(ctx.conn, trigger="send", herdr_session=args.herdr_session, pane_id=args.pane, session_id=args.session, check_result=args.result,
                              check_session=args.check_session)
    row = ctx.conn.execute("SELECT * FROM send_agreement WHERE check_id = ?", (check_id,)).fetchone()
    say({k: row[k] for k in row.keys()})


def cmd_audit(ctx, args):
    ident = identity.Identity(ctx.conn, herdr.HerdrClient(), home_dir())
    say(sendrec.audit(ctx.conn, ident.client, ident))


def cmd_reconcile(ctx, args):
    ident = identity.Identity(ctx.conn, herdr.HerdrClient(), home_dir())
    with db.single_writer(ctx.where.lock):
        say(ident.reconcile())


def cmd_disagree(ctx, args):
    if args.action == "sample":
        say(disagree.sample(ctx.conn, disagree.builder_map(), note="manual"))
    elif args.action == "list":
        for r in ctx.conn.execute("SELECT * FROM disagreements ORDER BY row_id"):
            print(f"#{r['row_id']:<4} {r['status']:<14} {r['kind']:<13} {r['herdr_session']}/{r['pane_id']} store={str(r['store_session'])[:8]}({r['store_source']}) builder={str(r['builder_session'])[:17]} samples={r['samples']}" + ("" if r["closed_at"] is None else " (agree again)"))
        say(disagree.summary(ctx.conn))
    elif args.action == "adjudicate":
        disagree.adjudicate(ctx.conn, int(args.row), args.verdict, args.note)
        say("ok")


def cmd_coverage(ctx, args):
    if args.action == "mark":
        coverage.mark(ctx.conn, args.row, args.status, args.note or "")
        return
    rows = coverage.evaluate(ctx.conn)
    text = coverage.render(rows)
    if args.write:
        ctx.where.reports.mkdir(parents=True, exist_ok=True)
        (ctx.where.reports / "coverage.md").write_text(text, encoding="utf-8")
    print(text)


def cmd_scorecard(ctx, args):
    answers = Path(args.known_answers).read_text(encoding="utf-8") if args.known_answers else None
    text = scorecard.render(ctx.conn, answers_text=answers)
    if args.write:
        config.private_folder(ctx.where.reports)
        (ctx.where.reports / "scorecard.md").write_text(text, encoding="utf-8")
    print(text)


def cmd_known_answers(ctx, args):
    if args.action == "draft":
        queries = [line.strip() for line in Path(args.file).read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]
        print(known_answers.candidates_table(ctx.conn, queries))
        return
    results = known_answers.check(ctx.conn, known_answers.parse(Path(args.file).read_text(encoding="utf-8")), args.top)
    for r in results:
        print(f"{r['n']:>2} {r['status']:<9} {r['query']!r} expected={r['expected'] or '-'} position={r['position']} results={r['results']}")
    return 1 if any(r["status"] == "fail" for r in results) else 0


def cmd_rusage(ctx, args):
    say(rusage.report(ctx.conn))


def cmd_soak_start(ctx, args):
    with db.transaction(ctx.conn):
        ctx.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('soak_started_at', ?)", (str(time.time()),))
    say("soak started")


def cmd_terminal_ids(ctx, args):
    """Is Herdr's `terminal_id` unique? The check that decides whether it may become the binding key (plan S1, Identity). Two panes
    that share a terminal_id while both are open would make it unusable as a key; one that reappears in a later life is only history."""
    conn = ctx.conn
    shared = [r[0] for r in conn.execute("SELECT terminal_id FROM panes WHERE terminal_id IS NOT NULL GROUP BY terminal_id HAVING COUNT(*) > 1")]
    overlapping = set()
    for terminal in shared:
        panes = [dict(r) for r in conn.execute("SELECT * FROM panes WHERE terminal_id = ?", (terminal,))]
        for i, a in enumerate(panes):
            for b in panes[i + 1:]:
                if a["first_seen"] <= (b["closed_at"] or 1e18) and b["first_seen"] <= (a["closed_at"] or 1e18):
                    overlapping.add(terminal)
    say({"panes_with_terminal_id": conn.execute("SELECT COUNT(*) FROM panes WHERE terminal_id IS NOT NULL").fetchone()[0],
         "terminal_ids_shared_by_several_panes": len(shared), "shared_by_panes_open_at_the_same_time": len(overlapping)})


def cmd_lab_run(ctx, args):
    """Run the lab tests (crash, file-change, identity with the fake Herdr, backup with a fake keychain) and keep the result for the scorecard."""
    import tempfile
    lab_out = Path(tempfile.mkdtemp(prefix="rstore-lab-")) / "lab.json"
    done = subprocess.run([sys.executable, "-m", "unittest", "discover", "-v", "-s", str(STORE / "tests"), "-p", "test_*.py"], capture_output=True, text=True,
                          cwd=str(STORE.parent.parent.parent), env={**os.environ, "RSTORE_LAB_OUT": str(lab_out)})
    text = done.stderr + done.stdout
    ran = re.search(r"Ran (\d+) tests?", text)
    failures = re.search(r"failures=(\d+)", text)
    errors = re.search(r"errors=(\d+)", text)
    ok_names = set(re.findall(r"(test_\w+) \([^)]*\) \.\.\. ok", text))
    present = [name for name in REQUIRED_LAB if name in ok_names]
    result = {"at": time.time(), "tests": int(ran.group(1)) if ran else 0, "failures": int(failures.group(1)) if failures else 0, "errors": int(errors.group(1)) if errors else 0,
              "returncode": done.returncode, "required_present": present, "required_ok": len(present) == len(REQUIRED_LAB)}
    with db.transaction(ctx.conn):
        ctx.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('lab_run', ?)", (json.dumps(result),))
        if lab_out.exists():  # the lab's own measurement of /clear to relink (tests/test_crash.py)
            relink = json.loads(lab_out.read_text(encoding="utf-8")).get("clear_relink_s")
            if relink is not None:
                ctx.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('clear_relink_s', ?)", (str(relink),))
                result["clear_relink_s"] = relink
    say(result)
    return done.returncode


def cmd_launchd(ctx, args):
    print(launchd.describe(ctx.where.root))


def cmd_settings(ctx, args):
    if args.set:
        key, _, value = args.set.partition("=")
        if key in config.Settings.__dataclass_fields__ and key != "extra":
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                parsed = value
            setattr(ctx.settings, key, parsed)
        else:
            ctx.settings.extra[key] = json.loads(value)
        config.save_settings(ctx.where, ctx.settings)
    say({name: getattr(ctx.settings, name) for name in config.Settings.__dataclass_fields__ if name != "extra"} | ctx.settings.extra)


# -------------------------------------------------------------------------------------------------------------------- parser

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="reader_store.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name, fn, help_text):
        p = sub.add_parser(name, help=help_text)
        p.set_defaults(fn=fn)
        return p

    add("init", cmd_init, "create the store and a default settings.json")
    add("scan", cmd_scan, "one ingest pass over every log, with its CPU cost")
    add("run", cmd_run, "the long-running ingest (what the LaunchAgent runs)")
    add("status", cmd_status, "heartbeat, counts, counters, backups")
    p = add("search", cmd_search, "search every session")
    p.add_argument("query", nargs="+")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--scope")
    p = add("forget", cmd_forget, "remove a session (and its sub-agents) everywhere, and never take it again")
    p.add_argument("session")
    p.add_argument("--note")
    p = add("parity", cmd_parity, "compare the store's turns with the builder's, now")
    p.add_argument("--trigger", default="manual")
    p.add_argument("--session", action="append")
    p.add_argument("--limit", type=int)
    p = add("parity-report", cmd_parity_report, "recent parity runs")
    p.add_argument("--limit", type=int, default=10)
    p = add("backup", cmd_backup, "snapshot, encrypt and stage a backup")
    p.add_argument("--upload", action="store_true", help="then run the upload step (stops until Drive is set up)")
    p = add("backup-verify", cmd_backup_verify, "decrypt a staged backup into a scratch folder and check it")
    p.add_argument("--file")
    p.add_argument("--scratch")
    add("key-command", cmd_key_command, "print the command that creates the backup key (a live write: not run)")
    add("nightly", cmd_nightly, "the nightly job: diff job, builder sample, staged backup, upload step")
    p = add("record-send", cmd_record_send, "record one Send's store binding beside its send check (what the Send hook calls)")
    p.add_argument("--herdr-session", required=True)
    p.add_argument("--pane", required=True)
    p.add_argument("--session", required=True)
    p.add_argument("--result", required=True)
    p.add_argument("--check-session")
    add("audit", cmd_audit, "record the send check beside the store's binding for every live pane")
    add("reconcile", cmd_reconcile, "read the whole Herdr inventory into the store, once")
    p = add("disagree", cmd_disagree, "builder-versus-store pane mapping: sample, list, adjudicate")
    p.add_argument("action", choices=("sample", "list", "adjudicate"))
    p.add_argument("row", nargs="?")
    p.add_argument("verdict", nargs="?", choices=("store-right", "builder-right", "both-wrong"))
    p.add_argument("--note")
    p = add("coverage", cmd_coverage, "the event coverage checklist")
    p.add_argument("action", choices=("show", "mark"), nargs="?", default="show")
    p.add_argument("--row")
    p.add_argument("--status", choices=("staged-in-lab", "waived"))
    p.add_argument("--note")
    p.add_argument("--write", action="store_true")
    p = add("scorecard", cmd_scorecard, "render the exit scorecard from the store")
    p.add_argument("--known-answers")
    p.add_argument("--write", action="store_true")
    p = add("known-answers", cmd_known_answers, "draft a known-answer table from queries, or check a filled one")
    p.add_argument("action", choices=("draft", "check"))
    p.add_argument("file")
    p.add_argument("--top", type=int, default=5)
    add("rusage", cmd_rusage, "CPU, memory and lag numbers")
    add("soak-start", cmd_soak_start, "note that the soak starts now")
    add("terminal-ids", cmd_terminal_ids, "is Herdr's terminal_id unique across the panes seen?")
    add("lab-run", cmd_lab_run, "run the lab tests and keep the result for the scorecard")
    add("launchd", cmd_launchd, "print the LaunchAgents and the exact install commands (a live write: not run)")
    p = add("settings", cmd_settings, "show or set a setting (settings.json)")
    p.add_argument("--set", help='key=value, e.g. drive_folder=/path or scope_policy=everything')
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    ctx = Ctx()
    try:
        return int(args.fn(ctx, args) or 0)
    except (backup.BackupError, RuntimeError, ValueError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
