"""The supervisor's replies and your own messages, read from the shadow store's versioned views (plan S1/S8: one store, one API, many clients).

The board does not parse a session log. It opens `reader-store.sqlite` read only (`mode=ro`) and reads `v1_sessions` and `v1_turns`, the contract
other repos may depend on; a store with a schema version this code does not know is refused. When the store is missing, too new or locked, the
board still builds and says so (`StoreUnavailable` carries the plain sentence); no thread is guessed from anywhere else.

Which sessions count as a session's supervisor: those whose working folder is one of the session's `cwds` (a leader's home; for big-boss the main
home and the pmos checkout), that are main sessions (not a sub-agent), that did not start as a worker brief, and that have at least three replies
addressed to you in the window. A reply is the turn's reply text when it starts with your name, the way every supervisor reply does.
"""

from __future__ import annotations

import os
import re
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

KNOWN_SCHEMA = 1
TRIGGER_CHARS = 6000  # a wake-up's own text names the worker or task that woke the supervisor; only wake-ups are kept, never your messages
WAKE_INPUTS = ("FIRSTMATE SUPERVISION WAKE", "FIRSTMATE WAKE", "<task-notification", ": Firstmate")
STORE_FILE = "reader-store.sqlite"
PROPOSED_VIEW = Path(__file__).resolve().parents[1] / "store" / "PROPOSED-v1-turn-tools.sql"
DEFAULT_DAYS = 30
SKIP_FIRST = ("MAIN DIALOG MIRROR", "FIRSTMATE_OP", "\u2063FIRSTMATE_OP", "You previously flagged", "Review this change", "Reply with exactly")
NOT_HUMAN = ("<task-notification", "<system-reminder", "Base directory for this skill", "Stop hook feedback", "<command-name", "<local-command",
             "FIRSTMATE", ": Firstmate", "This session is being continued", "[Request interrupted", "<bash-", "Caveat:", "<user-prompt-submit-hook",
             "MAIN DIALOG MIRROR", "[From session", "[From before", "/handoff")
HANDOFF_PATH = re.compile(r"^/Users/\S+/handoffs/\S+\.md\s*$")
COMMENT = re.compile(
    r'^(?:\d+\.\s+)?(?:\[[^\]]*\]\s*)?(?:Re your reply at (\d\d:\d\d) \(["\u201c](.*?)["\u201d]\)(?:, which asked: ["\u201c](.*?)["\u201d])?(?:, the part ["\u201c](.*?)["\u201d])?:\s*)?(.*)$', re.S)
KEY = re.compile(r"\b([A-Z]{1,3}\d{1,2})\b\s*[=:]")
ATTACHED_IMAGE = re.compile(r"\n\nAttached image: \S+")


class StoreUnavailable(RuntimeError):
    """The store cannot be read; the message is one plain sentence for the board's notes."""


def store_dir() -> Path:
    explicit = os.environ.get("PMOS_READER_STORE_DIR")
    return Path(explicit).expanduser() if explicit else Path.home() / ".config" / "pmos-transcript-reader" / "store"


def open_store(path: Path | None = None) -> sqlite3.Connection:
    path = Path(path) if path else store_dir() / STORE_FILE
    if not path.is_file():
        raise StoreUnavailable("the reader store is not there yet, so cards have no reply threads")
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version != KNOWN_SCHEMA:
            conn.close()
            raise StoreUnavailable(f"the reader store is schema version {version}; this board reads version {KNOWN_SCHEMA}")
        conn.execute("SELECT 1 FROM v1_turns LIMIT 1")
    except sqlite3.Error as error:
        raise StoreUnavailable(f"the reader store could not be read ({error.__class__.__name__})") from None
    return conn


@dataclass
class Transcript:
    replies: list[dict] = field(default_factory=list)   # the supervisor's replies to you, oldest first
    humans: list[dict] = field(default_factory=list)    # your own messages (answer-sheet comments split one per comment), oldest first
    sessions: list[dict] = field(default_factory=list)  # the supervisor sessions read: id, replies
    asof: float | None = None                           # the store's last ingest heartbeat


def epoch_hm(epoch: float) -> str:
    return time.strftime("%H:%M", time.localtime(epoch))


def clean_signal(value: str | None) -> str | None:
    return value or None


def split_human(raw: str) -> list[dict]:
    """One message of yours -> its items: the plain text, or one item per numbered answer-sheet comment ("Re your reply at 23:28 (...)")."""
    body = raw.strip()
    wrapped = re.search(r"<pasted_content[^>]*>\s*(.*?)\s*</pasted_content[^>]*>", body, re.S)
    if wrapped:
        body = wrapped.group(1)
    sheet = bool(wrapped) or bool(re.match(r"^\d+ comments?:", body))
    body = re.sub(r"^\d+ comments?:\s*", "", body)
    parts = re.split(r"\n\n(?=\d+\.\s)", body) if sheet else [body]
    out = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        found = COMMENT.match(part)
        if not found:
            continue
        at, quote, ask, ref, rest = found.groups()
        rest = ATTACHED_IMAGE.sub("", rest or "").strip()
        if not rest and not ref:
            continue
        out.append({"text": rest, "hm": at, "quote": quote, "ask": ask, "part": ref, "sheet": sheet})
    return out


def _in_clause(values: list[str]) -> str:
    return "(" + ",".join("?" * len(values)) + ")"


def load(conn: sqlite3.Connection, cwds: list[str], days: int = DEFAULT_DAYS, now: float | None = None, addressed_only: bool = True) -> Transcript:
    """The replies and your messages of the supervisor sessions working in `cwds`, from the last `days` days. A worker you drive (addressed_only=False)
    speaks only to you, so every reply counts and a short session is kept."""
    now = now or time.time()
    cut = now - days * 86400
    cwds = [str(c).rstrip("/") for c in cwds if c]
    transcript = Transcript()
    try:
        beat = conn.execute("SELECT heartbeat_at FROM v1_ingest_status").fetchone()
        transcript.asof = beat[0] if beat else None
        if not cwds:
            return transcript
        rows = conn.execute(
            "SELECT t.session_id, t.idx, t.uid, t.source, t.input, t.at, t.reply, t.reply_at, t.signal_task "
            "FROM v1_turns t JOIN v1_sessions s ON s.session_id = t.session_id "
            f"WHERE s.cwd IN {_in_clause(cwds)} AND s.parent_session_id IS NULL AND COALESCE(t.reply_at, t.at) >= ? ORDER BY t.session_id, t.idx",
            [*cwds, cut]).fetchall()
        firsts = {}
        for sid in {r["session_id"] for r in rows}:
            first = conn.execute("SELECT substr(input, 1, 160) FROM v1_turns WHERE session_id = ? ORDER BY idx LIMIT 1", (sid,)).fetchone()
            firsts[sid] = (first[0] if first else "") or ""
    except sqlite3.Error as error:
        raise StoreUnavailable(f"the reader store could not be read ({error.__class__.__name__})") from None
    tools = _turn_tools(conn, {r["session_id"] for r in rows}, cut)
    by_session: dict[str, list] = {}
    for row in rows:
        by_session.setdefault(row["session_id"], []).append(row)
    replies, humans = [], []
    for sid, turns in by_session.items():
        first = firsts.get(sid, "").lstrip()
        if first.startswith(SKIP_FIRST):
            continue
        mine = [t for t in turns if (t["reply"] or "").lstrip().startswith("Nathan")] if addressed_only else [t for t in turns if (t["reply"] or "").strip()]
        if addressed_only and len(mine) < 3 and not HANDOFF_PATH.match(first.split("\n")[0].strip()):
            continue
        transcript.sessions.append({"id": sid, "replies": len(mine), "last": max((t["reply_at"] or t["at"] or 0) for t in turns) or None})
        for t in mine:
            if not t["uid"]:
                continue
            replies.append({"e": t["reply_at"] or t["at"] or 0, "text": t["reply"], "sid": sid, "uid": t["uid"],
                            "key": f"{sid[:8]}:{t['uid'][:8]}:reply", "signal": clean_signal(t["signal_task"]), "tools": tools.get((sid, t["idx"]), ""),
                            "trigger": (t["input"] or "")[:TRIGGER_CHARS] if t["source"] in ("wake", "firstmate") or (t["input"] or "").lstrip().startswith(WAKE_INPUTS) else ""})
        for t in turns:
            raw = t["input"] or ""
            lead = raw.lstrip()
            if t["source"] != "captain" or not lead or lead.startswith(NOT_HUMAN) or HANDOFF_PATH.match(lead) or not t["uid"] or not t["at"]:
                continue
            humans.append({"e": t["at"], "raw": raw, "sid": sid, "uid": t["uid"]})
    replies.sort(key=lambda r: r["e"])
    seen, unique = set(), []
    for r in replies:
        k = (int(r["e"]), r["text"][:80])
        if k not in seen:
            seen.add(k)
            unique.append(r)
    transcript.replies = unique
    seen_h, items = set(), []
    for h in sorted(humans, key=lambda x: x["e"]):
        k = (int(h["e"]), h["raw"][:80])
        if k in seen_h:
            continue
        seen_h.add(k)
        for part in split_human(h["raw"]):
            items.append({**part, "e": h["e"], "sid": h["sid"], "uid": h["uid"], "key": f"{h['sid'][:8]}:{h['uid'][:8]}:in"})
    transcript.humans = items
    return transcript


def fetch_reply(conn: sqlite3.Connection, cwds: list[str], sid: str, uid: str) -> str | None:
    """The whole text of one reply, when it is in a session working in one of `cwds` (the same sessions the board reads), else None."""
    cwds = [str(c).rstrip("/") for c in cwds if c]
    if not cwds:
        return None
    try:
        row = conn.execute("SELECT t.reply FROM v1_turns t JOIN v1_sessions s ON s.session_id = t.session_id "
                           f"WHERE t.session_id = ? AND t.uid = ? AND s.cwd IN {_in_clause(cwds)} LIMIT 1", [sid, uid, *cwds]).fetchone()
    except sqlite3.Error as error:
        raise StoreUnavailable(f"the reader store could not be read ({error.__class__.__name__})") from None
    return row[0] if row and row[0] else None


def _turn_tools(conn: sqlite3.Connection, sessions: set, cut: float) -> dict:
    """{(session, turn index): the text of that turn's tool calls}, or {} when it cannot be had.

    The store's version 1 views carry no tool text, and the strongest rule for linking a reply to a task is a task id in the turn's own tool calls
    (`fm-send.sh <id>`: 127 of about 220 exact links in the prototype's home). Two ways to it, in order, both read only:
      1. the store's own `v1_turn_tools` view (session_id, idx, text), when a store version offers it;
      2. else the same view as a per-connection TEMP view, made from `store/PROPOSED-v1-turn-tools.sql` over the schema-1 tables. A temp view lives
         in this connection only: nothing is written to the store file, and a store whose tables differ makes it fail, which is caught and leaves
         the board without that signal. This is the one place the board reads a table rather than a view; PMOS_READER_BOARD_TOOL_TEXT=0 turns it off.
    """
    def has_view() -> bool:
        try:
            conn.execute("SELECT session_id, idx, text FROM v1_turn_tools LIMIT 0")
            return True
        except sqlite3.Error:
            return False
    if not has_view():
        if os.environ.get("PMOS_READER_BOARD_TOOL_TEXT") == "0":
            return {}
        try:
            sql = "\n".join(line for line in PROPOSED_VIEW.read_text(encoding="utf-8").splitlines() if not line.startswith("--"))
            conn.execute(sql.replace("CREATE VIEW IF NOT EXISTS", "CREATE TEMP VIEW IF NOT EXISTS", 1))
        except (OSError, sqlite3.Error):
            return {}
        if not has_view():
            return {}
    out = {}
    try:
        for sid in sessions:
            for row in conn.execute("SELECT idx, text FROM v1_turn_tools WHERE session_id = ?", (sid,)):
                out[(sid, row["idx"])] = row["text"] or ""
    except sqlite3.Error:
        return {}
    return out


def anchor(item: dict, replies: list[dict]) -> tuple[int | None, str]:
    """Which reply one of your messages answers: the answer sheet's own time and quote, a call key it uses, or the reply just before it."""
    e = item["e"]
    prior = [i for i, r in enumerate(replies) if r["e"] <= e]
    if item.get("hm"):
        cand = [i for i in prior if epoch_hm(replies[i]["e"]) == item["hm"] and replies[i]["e"] > e - 3 * 86400]
        quote = (item.get("quote") or "").rstrip("\u2026. ")[:40]
        quoted = [i for i in cand if quote and replies[i]["text"].startswith(quote)] or [i for i in cand if quote and quote[:20] in replies[i]["text"]]
        if quoted:
            return quoted[-1], "sheet"
        if cand:
            return cand[-1], "sheet-time"
    for key in KEY.findall(item["text"]):
        keyed = [i for i in prior if re.search(r"(?<![\w-])" + key + r"(?![\w-])", replies[i]["text"])]
        if keyed:
            return keyed[-1], "key " + key
    if prior and e - replies[prior[-1]]["e"] < 6 * 3600:
        return prior[-1], "adjacent"
    return None, "none"
