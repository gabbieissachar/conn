"""Check 2: identity at the moment it matters.

Each time a Send runs through the guarded path, two answers are recorded side by side: the store's live binding for the pane the send
chose, and the send check's own result. The send check is ground truth because it reads the foreground process (api.js
`checkForeground`, from c1edebc). Pass: zero disagreements across the soak.

Agreement (the `send_agreement` view): an `ok` check names the store's session; a refusal (`other_session`, `agent_not_foreground`)
leaves the store without that session for the pane. A check that says nothing about identity (`no_pane`, `herdr_failed`) is not scored.

How rows get in:
  * trigger `send`: `record` is what the guarded Send path calls with its own check result. The hook is in api.js (`recordSendCheck`; store/README.md,
    "The Send hook") and is off until PMOS_READER_STORE_RECORDER names this tool in the reader's environment. Until the live reader
    runs with it, no `send` rows exist, and the scorecard says so.
  * trigger `audit`: `audit` re-derives the send check in Python (`ground_truth`, a port of checkForeground's decisions) for every
    pane the store has a live binding for, and records it. It runs every few minutes in the daemon, so the store is compared with
    the foreground process all through the soak, Send or no Send. An audit row is evidence, not a Send: the pass criterion counts
    both and the scorecard reports them apart.

Nothing here sends anything to a pane.
"""

from __future__ import annotations

import json
import sqlite3
import time

from . import builder, db, identity

SENDABLE = ("claude", "codex")


def current_life(conn: sqlite3.Connection, herdr_session: str) -> str | None:
    row = conn.execute("SELECT life FROM herdr_lives WHERE herdr_session = ? ORDER BY first_seen DESC LIMIT 1", (herdr_session,)).fetchone()
    return row[0] if row else None


def store_binding(conn: sqlite3.Connection, herdr_session: str, pane_id: str) -> sqlite3.Row | None:
    """The store's live binding for the pane, in the current life of that Herdr session."""
    life = current_life(conn, herdr_session)
    if life is None:
        return None
    return conn.execute("SELECT * FROM bindings WHERE herdr_session = ? AND life = ? AND pane_id = ? AND valid_to IS NULL", (herdr_session, life, pane_id)).fetchone()


def record(conn: sqlite3.Connection, *, trigger: str, herdr_session: str | None, pane_id: str | None, session_id: str, check_result: str,
           check_session: str | None = None, detail: dict | None = None, clock=time.time) -> int:
    """One row: the store's live binding for the pane, beside the send check's result. Call it right after the check, before the keys go."""
    binding = store_binding(conn, herdr_session, pane_id) if herdr_session and pane_id else None
    with db.transaction(conn):
        return conn.execute(
            "INSERT INTO send_checks(at, trigger, herdr_session, pane_id, session_id, store_session, store_source, check_result, check_session, detail) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (clock(), trigger, herdr_session, pane_id, session_id, binding["session_id"] if binding else None, binding["source"] if binding else None,
             check_result, check_session, json.dumps(detail or {}, sort_keys=True))).lastrowid


def ground_truth(info: dict | None, agent: str | None, session_id: str, pid_records: dict[int, dict], codex_resolver=None) -> tuple[str, str | None]:
    """The send check's decision for a pane (a port of api.js checkForeground): (result, the session the pane runs)."""
    if info is None:
        return "herdr_failed", None
    if agent == "codex":
        resolver = codex_resolver or builder.bp.codex_pane_session
        actual = resolver(session_id, info)
        if actual == session_id:
            return "ok", actual
        return ("other_session", actual) if actual else ("agent_not_foreground", None)
    processes = [p for p in info.get("foreground_processes") or [] if isinstance(p, dict)]
    held = [pid_records[p["pid"]]["session_id"] for p in processes if p.get("pid") in pid_records]
    if session_id in held:
        return "ok", session_id
    if held:
        return "other_session", held[0]
    if any(p.get("argv0") == "claude" for p in processes):
        return "ok", session_id  # a Claude process with no record of its own: the check lets it through
    return "agent_not_foreground", None


def audit(conn: sqlite3.Connection, client, ident: identity.Identity, codex_resolver=None, clock=time.time) -> dict:
    """Record the send check's decision beside the store's binding for every pane that has a live binding of a sendable harness."""
    ident.pid_records.poll()
    counts = {"checked": 0, "agree": 0, "disagree": 0, "unscored": 0}
    for row in conn.execute("SELECT b.*, p.agent FROM bindings b JOIN panes p ON p.herdr_session = b.herdr_session AND p.life = b.life AND p.pane_id = b.pane_id "
                            "WHERE b.valid_to IS NULL AND b.harness IN ('claude', 'codex') AND p.closed_at IS NULL").fetchall():
        info = client.process_info(row["herdr_session"], row["pane_id"])
        result, actual = ground_truth(info, row["agent"] or row["harness"], row["session_id"], ident.pid_records.records, codex_resolver)
        check_id = record(conn, trigger="audit", herdr_session=row["herdr_session"], pane_id=row["pane_id"], session_id=row["session_id"],
                          check_result=result, check_session=actual, clock=clock)
        agree = conn.execute("SELECT agree FROM send_agreement WHERE check_id = ?", (check_id,)).fetchone()[0]
        counts["checked"] += 1
        counts["unscored" if agree is None else "agree" if agree else "disagree"] += 1
    return counts
