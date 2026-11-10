"""Which turns of a leader's conversation are about which fleet task (the task-tagging A2 rules, T-slice 1 of the task-tags plan).

One tagger, many clients: the rules are the Tasks board's own (`board/tagger.py`, "Which reply is about which task") and your corrections are the board's
reply marks (`data/<task>/reply-marks.jsonl`, `board/marks.py`), so a reply the board puts on a task's card is tagged with that task in the conversation too.
This module only feeds them the conversation's turns and folds the answers into one list of tags for each turn:

  records   a wake-up the reader tied to a task (`signal_task` of the turn, and of the wake-ups the turn absorbed), or whose text names it (the tagger's
            `signal` and `wake`)
  commands  a task id in the turn's own tool calls (`fm-send.sh <id>`): the step summaries and commands the page already keeps (the tagger's `command`)
  mentions  the reply's or your message's own words name the task (the tagger's `mention`; a turn naming four or more is a roundup and counts for none)
  pointers  your message points at a reply ("Re your reply at 09:04") and takes that reply's tasks (a rule of this module: the board anchors your messages
            to replies the same way, `transcripts.anchor`)
  marks     `in` adds a task, `out` takes it off, on the reply (`<session8>:<turn8>:reply`) or your message (`<session8>:<turn8>:in`), as on the board

A turn with a tag carries `tags`: `[[task id, "mention+signal"], ...]`, strongest first. A turn with none carries `tag_row`: "upkeep" (routine: a heartbeat, a
check, a short or routine reply, the board's `is_upkeep`) or "none" (talk with no task). The page's task menu lists the tasks, then those two rows.

What the page needs to change a tag from the conversation (the turn menu, "Add to a task"): every turn of the conversation carries `mk`, the first eight characters of
the session id of the log that holds it (the board's mark names a turn `<mk>:<first eight of uid>:reply|in`), and a turn whose tags do not all sit on its reply carries
`tag_sides`, one string per tag in the same order: "r" the reply side, "m" your message's side, "rm" both. A mark is written on the side a tag sits on, so taking a tag
off a turn whose tag comes from your message's words acts on the message and not on the reply. (`tag_sides` is left out when every tag is "r".)

Only the sure and possible levels of the tagger count, as on the board (weak ones, one shared key or a title word, are never shown). A session divider has no tag.
What the board has that this does not: a task's branch, PR, review-board links and call keys (they come from the board's live read, which a page build does not
make), so a reply the board ties to a task by one of those only is not tagged here; the board's thread and this tagging agree on every reply the shared rules
reach from the turns alone.

The result of the rules for one turn depends only on the turn's own text and the task list, so it is kept in memory (`_KEPT`) under a hash of both, and a
build that adds a reply tags that reply alone.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # setup/transcript-reader: where the board package is

try:  # a copy of the reader without the board package has no tags, never a failed build
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from board import homes as homes_lib  # noqa: E402
    from board import marks as marks_lib  # noqa: E402
    from board import tagger  # noqa: E402
except ImportError:  # pragma: no cover - the board package ships with the reader
    homes_lib = marks_lib = tagger = None

TRIGGER_CHARS = 6000   # a wake-up's own text names the worker or task that woke the supervisor (the board reads the same amount)
INPUT_CHARS = 6000     # a message of yours is read up to this much
TOOLS_CHARS = 20000    # the commands and summaries of a turn's tool steps
MAX_TAGS = 8           # a turn keeps its strongest tags
KEPT_LIMIT = 30000     # the turns whose tags are kept in memory
WAKE_SOURCES = ("wake", "firstmate")
# Why a task was tagged, strongest first: the order a turn's tags are listed in, and the one a tag's reasons are written in.
REASON_ORDER = ("marked", "signal", "mention", "command", "wake", "pointer", "words")
KEEP_LEVELS = ("sure", "possible")
UPKEEP_KINDS = ("heartbeat", "supervision", "monitor", "hook", "quiet", "check", "background")

BOARD_MEMO_SECONDS = 20  # the board registry is read at most this often while a build asks for it once per leader

_KEPT: dict[tuple[str, str], dict] = {}
_BOARDS: dict = {"at": 0.0, "sessions": []}


def available() -> bool:
    return tagger is not None and marks_lib is not None


def board_session(home: Path | None) -> str:
    """The id of the Tasks board that owns a leader's home ("" when none does): the session the board's mark route needs to file a mark. It is the board registry's
    own answer (`board/homes.py`: the config file, else the main home and its registered secondmates), so the conversation and the board never disagree about which
    home a mark goes to. A worker's board is not one (a worker has no tasks of its own to mark)."""
    if homes_lib is None or home is None:
        return ""
    now = time.monotonic()
    if now - _BOARDS["at"] > BOARD_MEMO_SECONDS or not _BOARDS["at"]:
        try:
            _BOARDS["sessions"] = [(s.id, s.kind, Path(s.home).resolve()) for s in homes_lib.load().sessions]
        except Exception:  # an unreadable config is no board: the conversation simply has no mark control
            _BOARDS["sessions"] = []
        _BOARDS["at"] = now
    try:
        target = Path(home).resolve()
    except (OSError, RuntimeError):
        return ""
    return next((sid for sid, kind, where in _BOARDS["sessions"] if kind != "worker" and where == target), "")


def tools_text(exchange: dict) -> str:
    """What a turn's own tool calls say, as the board's tool text does: each step's command, else its one-line summary and the file it named. A step that touched
    a credential path (`h`) keeps no text, and the output of a step is never read."""
    parts = []
    for step in exchange.get("steps") or ():
        if not isinstance(step, dict) or step.get("h"):
            continue
        parts.append(" ".join(str(step[key]) for key in (("c", "p") if step.get("c") else ("s", "p")) if step.get(key)))
    return "\n".join(part for part in parts if part)[:TOOLS_CHARS]


def reply_unit(exchange: dict) -> dict:
    """The tagger's reply record for a turn: the reply, the wake-up's task, the tool text and, for a wake-up or a Firstmate message, the text that started the turn."""
    trigger = ""
    if exchange.get("source") in WAKE_SOURCES:
        trigger = (exchange.get("input") or "")[:TRIGGER_CHARS]
    notices = [n.get("signal_task") for n in exchange.get("notices") or () if isinstance(n, dict) and n.get("signal_task")]
    if notices:
        trigger = (trigger + "\n" + " ".join(notices))[:TRIGGER_CHARS + 400]
    return {"text": exchange.get("reply") or "", "signal": exchange.get("signal_task") or "", "tools": tools_text(exchange), "trigger": trigger}


def input_unit(exchange: dict) -> dict | None:
    """The tagger's record for your own message (or another session's): its words alone, as a reply's are. None for a turn that has no such message."""
    if exchange.get("source") not in ("captain", "peer"):
        return None
    text = (exchange.get("input") or "")[:INPUT_CHARS]
    return {"text": text, "signal": "", "tools": "", "trigger": ""} if text.strip() else None


def fingerprint(unit: dict) -> str:
    return hashlib.sha1("\x00".join((unit["text"], unit["signal"], unit["tools"], unit["trigger"])).encode("utf-8", "replace")).hexdigest()


def registry_digest(tasks: list[dict]) -> str:
    return hashlib.sha1(json.dumps([[t["id"], t.get("title") or ""] for t in tasks], ensure_ascii=False).encode("utf-8")).hexdigest()


def match(units: list[dict], tasks: list[dict], digest: str) -> list[dict]:
    """For each unit {task id: (level, [reasons])} at the sure and possible levels, from the board's rules; a unit already answered for this task list is not
    asked again."""
    answers: list[dict | None] = []
    missing: list[tuple[int, str]] = []
    for index, unit in enumerate(units):
        key = (fingerprint(unit), digest)
        kept = _KEPT.get(key)
        answers.append(kept)
        if kept is None:
            missing.append((index, key))
    if missing:
        found = tagger.match_replies([units[i] for i, _ in missing], tasks)
        if len(_KEPT) > KEPT_LIMIT:
            _KEPT.clear()
        for (index, key), matches in zip(missing, found):
            answer = {task: (m["lvl"], list(m["why"])) for task, m in matches.items() if m["lvl"] in KEEP_LEVELS}
            _KEPT[key] = answers[index] = answer
    return [a or {} for a in answers]


def short_reason(level: str, why: list[str]) -> list[str]:
    """The reasons a tag carries: the sure ones by their rule name, a possible one as `words` (three rare words of the task's id)."""
    if level != "sure":
        return ["words"]
    return [reason for reason in why if reason in REASON_ORDER]


def order_key(reasons: list[str], task: str) -> tuple:
    return (min((REASON_ORDER.index(r) for r in reasons if r in REASON_ORDER), default=len(REASON_ORDER)), task)


def read_marks(home: Path | None, task_ids: list[str]) -> dict[str, dict[str, str]]:
    """{turn key: {task id: "in" | "out"}} from each task's own mark file in the home that owns the tasks. A task with no marks has no entry."""
    by_turn: dict[str, dict[str, str]] = {}
    if home is None:
        return by_turn
    for task in task_ids:
        for turn, mark in marks_lib.read(home, task).items():
            by_turn.setdefault(turn, {})[task] = mark
    return by_turn


def row_of(exchange: dict) -> str:
    """Where a turn with no task goes: Fleet upkeep (a heartbeat, a check, a routine or short reply) or No task (talk with no task)."""
    source, reply = exchange.get("source"), exchange.get("reply") or ""
    if source in ("captain", "peer"):
        return "none"
    if source == "wake":
        return "upkeep" if exchange.get("kind") in UPKEEP_KINDS or not reply or tagger.is_upkeep(reply) else "none"
    return "upkeep" if not reply or tagger.is_upkeep(reply) else "none"


def tag_exchanges(exchanges: list[dict], sids: list[str | None], tasks: dict[str, dict], home: Path | None, pointers: dict[int, list[int]] | None = None) -> None:
    """Give each turn of a leader's conversation `tags` or `tag_row` (the module's text). <sids> is the session id of each turn's log (the board's marks name a turn by
    its session and turn id), <tasks> the home's tasks as `leader_tasks` gives them ({id: {title, state}}), <home> where the marks are, and <pointers> {the index of
    your message: the indexes of the replies its pointers name}."""
    for exchange in exchanges:
        for field in ("tags", "tag_row", "tag_sides", "mk"):
            exchange.pop(field, None)
    if not available() or not tasks:
        return
    registry = [{"id": task, "title": (record or {}).get("title") or ""} for task, record in sorted(tasks.items())]
    digest = registry_digest(registry)
    marks = read_marks(home, [t["id"] for t in registry])
    turns = [i for i, e in enumerate(exchanges) if e.get("source") != "session"]
    replies = match([reply_unit(exchanges[i]) for i in turns], registry, digest)
    inputs = {}
    wanted = [(i, input_unit(exchanges[i])) for i in turns]
    wanted = [(i, unit) for i, unit in wanted if unit is not None]
    for (i, _), answer in zip(wanted, match([unit for _, unit in wanted], registry, digest)):
        inputs[i] = answer

    def key(index: int, part: str) -> str | None:
        uid, sid = exchanges[index].get("uid"), sids[index] if index < len(sids) else None
        return f"{sid[:8]}:{str(uid)[:8]}:{part}" if sid and isinstance(uid, str) and uid else None

    def side(index: int, found: dict, part: str) -> dict[str, list[str]]:
        """One side of a turn (its reply, or your message) after your marks: {task: reasons}."""
        marked = marks.get(key(index, part) or "", {})
        out = {task: short_reason(*found[task]) for task in found if marked.get(task) != "out"}
        for task, mark in marked.items():
            if mark == "in":
                out[task] = ["marked"]
        return out

    reply_side = {i: side(i, replies[n], "reply") for n, i in enumerate(turns)}
    for i in turns:
        mine = side(i, inputs.get(i, {}), "in")
        for target in (pointers or {}).get(i, ()):
            for task in reply_side.get(target, {}):
                if marks.get(key(i, "in") or "", {}).get(task) != "out":
                    mine.setdefault(task, ["pointer"])
        merged: dict[str, list[str]] = {}
        sides: dict[str, str] = {}
        for part, found in (("r", reply_side[i]), ("m", mine)):
            for task, reasons in found.items():
                have = merged.setdefault(task, [])
                have.extend(r for r in reasons if r not in have)
                sides[task] = sides.get(task, "") + part
        exchange = exchanges[i]
        mark_sid = sids[i] if i < len(sids) else None
        if mark_sid and isinstance(exchange.get("uid"), str) and exchange["uid"]:
            exchange["mk"] = mark_sid[:8]
        if merged:
            ranked = sorted(merged.items(), key=lambda item: order_key(item[1], item[0]))[:MAX_TAGS]
            exchange["tags"] = [[task, "+".join(sorted(reasons, key=REASON_ORDER.index))] for task, reasons in ranked]
            if any(sides[task] != "r" for task, _ in ranked):
                exchange["tag_sides"] = [sides[task] for task, _ in ranked]
        else:
            exchange["tag_row"] = row_of(exchange)
