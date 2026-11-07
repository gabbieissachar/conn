"""Check 8: the exit scorecard, one page, each check's result and where its evidence is.

`render(conn)` fills the page from the store's own records, so the numbers on it are the ones in the file, not retyped. A check that
has not been run yet reads OPEN (never PASS by default). The page is a template in the sense that the soak fills it: S1 ships it and the
first render, every row OPEN or partly filled; the soak, and the owner's review, make it a verdict. Firstmate verifies the numbers against
the raw logs and brings the owner a pass or fail with the gaps named; S2 and S3 start only on the owner's go.
"""

from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timezone

from . import coverage, disagree, known_answers, rusage

DAY = 86400.0


def _iso(at: float | None) -> str:
    return datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%d %H:%MZ") if at else "-"


def check1(conn, now: float) -> tuple[str, str]:
    runs = conn.execute("SELECT * FROM parity_runs WHERE at >= ? ORDER BY at", (now - 3 * DAY,)).fetchall()
    days = {int(r["at"] // DAY) for r in runs}
    unexplained = sum(r["unexplained"] for r in runs)
    compared = sum(r["sessions"] for r in runs)
    detail = f"{len(runs)} runs over {len(days)} distinct days in the last 3 days, {compared} session comparisons, {unexplained} unexplained mismatches"
    if not runs:
        return "OPEN", "no parity run yet. " + detail
    if unexplained:
        return "FAIL", detail
    return ("PASS" if len(days) >= 3 else "OPEN"), detail + ("" if len(days) >= 3 else " (the last three days are not all covered yet)")


def check2(conn, now: float) -> tuple[str, str]:
    rows = conn.execute("SELECT trigger, COUNT(*) n, SUM(agree = 1) ok, SUM(agree = 0) bad, SUM(agree IS NULL) unscored FROM send_agreement GROUP BY trigger").fetchall()
    by = {r["trigger"]: r for r in rows}
    sends, audits = by.get("send"), by.get("audit")
    parts = []
    for name, row in (("Send", sends), ("audit", audits)):
        parts.append(f"{name}: {row['n']} checks, {row['bad'] or 0} disagree, {row['unscored'] or 0} unscored" if row else f"{name}: none")
    bad = ((sends["bad"] or 0) if sends else 0) + ((audits["bad"] or 0) if audits else 0)
    if bad:
        return "FAIL", "; ".join(parts)
    if not sends:
        return "OPEN", "; ".join(parts) + ". No Send row until the Send hook is applied (README, \"The Send hook\"); audit rows are the same comparison without a Send."
    return "PASS", "; ".join(parts)


def check3(conn, now: float) -> tuple[str, str]:
    summary = disagree.summary(conn)
    samples = conn.execute("SELECT COUNT(*) FROM builder_samples").fetchone()[0]
    detail = f"{samples} builder samples; {summary['total']} rows: {summary['unadjudicated']} unadjudicated, {summary['store_right']} store-right, {summary['builder_right']} builder-right ({summary['open_builder_right']} open), {summary['both_wrong']} both-wrong"
    if not samples:
        return "OPEN", "the builder's mapping has not been sampled yet. " + detail
    if summary["unadjudicated"] or summary["open_builder_right"]:
        return "OPEN", detail
    return "PASS", detail


def check4(conn, now: float, soak_started: float | None) -> tuple[str, str]:
    rows = coverage.evaluate(conn)
    open_rows = [r["title"] for r in rows if r["status"] == "open"]
    days = (now - soak_started) / DAY if soak_started else 0.0
    detail = f"{len(rows) - len(open_rows)} of {len(rows)} rows filled; soak day {days:.1f} of at least 7"
    if open_rows:
        return "OPEN", detail + "; open: " + ", ".join(open_rows)
    return ("PASS" if days >= 7 else "OPEN"), detail


def check5(conn, now: float) -> tuple[str, str]:
    row = conn.execute("SELECT value FROM meta WHERE key = 'lab_run'").fetchone()
    if not row:
        return "OPEN", "the lab tests have not been run through `reader_store.py lab-run` yet"
    run = json.loads(row[0])
    detail = f"{run['tests']} lab tests at {_iso(run['at'])}: {run['failures']} failures, {run['errors']} errors; crash and file-change tests included: {', '.join(run.get('required_present', [])) or 'none found'}"
    return ("PASS" if run["failures"] == 0 and run["errors"] == 0 and run.get("required_ok") else "FAIL"), detail


def check6(conn, now: float, soak_started: float | None) -> tuple[str, str]:
    data = rusage.report(conn, soak_started or 0.0)
    ingest = data["components"].get("ingest")
    parity_run = data["components"].get("parity")
    lag = data["lag"]
    budget = data["budget"]
    parts = []
    ok = True
    if ingest and ingest["cpu_s_per_hour"] is not None:
        parts.append(f"ingest {ingest['cpu_s_per_hour']:.1f} CPU-s/hour over {ingest['samples']} windows (budget {budget['ingest_cpu_s_per_hour']:.0f})")
        ok &= ingest["cpu_s_per_hour"] <= budget["ingest_cpu_s_per_hour"]
    else:
        parts.append("ingest: no sample yet")
        ok = False
    if parity_run:
        parts.append(f"diff job worst run {parity_run['worst_sample_cpu_s']:.1f} CPU-s over {parity_run['samples']} runs (budget {budget['parity_cpu_s_per_run']:.0f})")
        ok &= parity_run["worst_sample_cpu_s"] <= budget["parity_cpu_s_per_run"]
    else:
        parts.append("diff job: no run yet")
        ok = False
    if lag["p95_s"] is not None:
        parts.append(f"ingest lag p95 {lag['p95_s']:.2f} s over {lag['samples']} samples (budget {budget['lag_p95_s']:.0f})")
        ok &= lag["p95_s"] <= budget["lag_p95_s"]
    else:
        parts.append("lag: no sample yet")
        ok = False
    relink = conn.execute("SELECT value FROM meta WHERE key = 'clear_relink_s'").fetchone()
    if relink:
        parts.append(f"/clear to relink {float(relink[0]):.2f} s in the lab (budget {budget['clear_relink_s']:.0f})")
        ok &= float(relink[0]) <= budget["clear_relink_s"]
    else:
        parts.append("/clear-to-relink: not measured yet")
        ok = False
    return ("PASS" if ok else "OPEN"), "; ".join(parts)


def check7(conn, now: float, answers_text: str | None) -> tuple[str, str]:
    if not answers_text:
        return "OPEN", "no known-answer file given"
    rows = known_answers.parse(answers_text)
    results = known_answers.check(conn, rows)
    passed = sum(1 for r in results if r["status"] == "pass")
    undecided = sum(1 for r in results if r["status"] == "undecided")
    failed = [r["n"] for r in results if r["status"] == "fail"]
    detail = f"{passed} of {len(results)} found their session in the top results; {undecided} undecided; failing: {failed or 'none'}"
    if failed:
        return "FAIL", detail
    return ("PASS" if results and not undecided else "OPEN"), detail


def render(conn: sqlite3.Connection, *, now: float | None = None, soak_started: float | None = None, answers_text: str | None = None) -> str:
    now = time.time() if now is None else now
    if soak_started is None:
        row = conn.execute("SELECT value FROM meta WHERE key = 'soak_started_at'").fetchone()
        soak_started = float(row[0]) if row else None
    checks = [
        ("1. Turn parity, automated", "zero unexplained mismatches over the last three days of the soak", check1(conn, now)),
        ("2. Identity at the moment it matters", "zero mismatches between the store's live binding and the send check, across the soak", check2(conn, now)),
        ("3. Disagreement adjudication", "zero unadjudicated rows, no open `builder-right` row", check3(conn, now)),
        ("4. Event coverage checklist", "every row filled, and at least seven days have passed", check4(conn, now, soak_started)),
        ("5. Crash and file-change tests, in the lab", "no duplicate or missing events after a mid-write kill; a deleted log stays, marked log gone; `forget` removes everywhere", check5(conn, now)),
        ("6. Cost and lag", "`rusage` CPU within budget, lag p95 within budget, `/clear` to relink at or below 2 s in the lab", check6(conn, now, soak_started)),
        ("7. Usefulness check by the owner", "each expected session is in the top results of its known-answer search", check7(conn, now, answers_text)),
    ]
    out = [f"# S1 exit scorecard", "", f"Rendered {_iso(now)} from the store. Soak started: {_iso(soak_started) if soak_started else 'not started'}.", "",
           "A row reads OPEN until its check has run and passed; nothing is PASS by default.", "",
           "| Check | Pass means | Result | Evidence |", "| --- | --- | --- | --- |"]
    for title, passes, (status, detail) in checks:
        out.append(f"| {title} | {passes} | **{status}** | {detail} |")
    overall = "PASS" if all(status == "PASS" for _, _, (status, _) in checks) else "OPEN" if not any(status == "FAIL" for _, _, (status, _) in checks) else "FAIL"
    out += ["", f"Overall (checks 1 to 7): **{overall}**.", "",
            "## 8. Verdict", "",
            "- Firstmate verified the numbers against the raw logs: ______ (date, who)",
            "- Gaps named: ______",
            "- Owner's go for S2 and S3: ______",
            "",
            "## Evidence files", "",
            "- Parity mismatches: `parity_mismatches` (both values per row); `reader_store.py parity-report`",
            "- Send checks: `send_checks` and the `send_agreement` view",
            "- Disagreements: the `disagreements` view; `reader_store.py disagree list`",
            "- Coverage: `reader_store.py coverage show` (writes the checklist file)",
            "- Cost: `reader_store.py rusage`; lag: `ingest_lag`",
            "- Known answers: `reader_store.py known-answers check <file>`"]
    return "\n".join(out) + "\n"
