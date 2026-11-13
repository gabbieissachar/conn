"""The shared tagger (report section 5 R3 = a): which replies of a session are about which task.

Pure functions, no files and no store: replies and tasks go in, a level and the reasons come out per (reply, task). The board's thread builder
uses it today; the reader's task menu reads the same rules (one tagger, many clients). The captain's marks (`marks.py`) override its answer for
a turn after it has run, so every mark improves the rules' users equally.

Signals, strongest first (the task-tagging A2 rules, as the prototype ran them over real replies):

  mention   the reply names the task id (or its id stem of 14+ characters) as a whole word
  signal    the turn was a wake-up the reader tied to this task (`signal_task` of the store's turn)
  wake      the wake-up that started the turn names the task by id (up to three tasks; a longer list is a roundup)
  pointer   data/<id>, fm/<id>, the task's branch or PR, or exactly one review-board link that is the task's own
  keyed     a call key (R2, Z3) the task carries and no other task does (weak)
  id words  three or more rare words of the task id (possible)
  title     rare title words (weak)

A reply that names more than three tasks by id in a sweep is weak for each. `command` (a task id in the reply turn's own tool calls: `fm-send.sh <id>`)
needs tool text, which the store's version 1 views do not carry; it is used when the store offers the optional `v1_turn_tools` view
(`transcripts._turn_tools`) and is absent otherwise. That gap is why a board without it links fewer replies than the prototype's hand-built one.
"""

from __future__ import annotations

import re
from collections import Counter

STOP = set("""the a an and or of to in on for with from by is are be this that it as at not no new fix add next step first fixes also main line onto
personal group answer sheet run use make build work task tasks session sessions home leader worker workers crew review report scout ship draft
check read write update decision decisions call calls item items plan prototype data file files tool tools""".split())
LAVISH = re.compile(r"127\.0\.0\.1:\d+/session/\w+")
CALL_LABEL = re.compile(r"^[A-Z]{1,2}\d{1,2}$")
MIN_REPLY_CHARS = 55  # "shipshape." and other one-liners carry nothing for a card


def id_stem(task_id: str) -> str:
    return re.sub(r"^\d{4}-\d{2}-\d{2}-", "", task_id)


def tokens(text: str) -> list[str]:
    text = re.sub(r"\b([A-Za-z]{1,4})-(\d+)\b", r"\1\2", (text or "").lower())
    return [w for w in re.findall(r"[a-z][a-z0-9]{3,}", text) if w not in STOP]


def _whole(needle: str) -> re.Pattern:
    return re.compile(r"(?<![\w-])" + re.escape(needle) + r"(?![\w-])")


def describe(task: dict) -> dict:
    """What the rules know about one task: a dict with `id`, `title`, and optional `branch`, `pr`, `links` (review-board paths), `labels` (call keys)."""
    task_id = task["id"]
    stem = id_stem(task_id)
    stem_words = set(tokens(stem.replace("-", " ")))
    return {
        "id": task_id, "stem": stem, "stem_words": stem_words, "words": stem_words | set(tokens(task.get("title") or "")),
        "branch": task.get("branch"), "pr": task.get("pr"), "links": set(task.get("links") or ()),
        "labels": {k for k in (task.get("labels") or ()) if CALL_LABEL.match(k or "")},
    }


def match_replies(replies: list[dict], tasks: list[dict]) -> list[dict]:
    """For each reply (`text`, optional `signal` task id) a dict {task id: {"lvl": sure|possible|weak, "why": [...]}}, in the replies' order."""
    described = [describe(t) for t in tasks]
    df: Counter = Counter()
    for d in described:
        for word in d["words"]:
            df[word] += 1
    by_label: dict[str, set] = {}
    for d in described:
        for label in d["labels"]:
            by_label.setdefault(label, set()).add(d["id"])
    reply_words = [set(tokens(r["text"])) for r in replies]
    reply_df = Counter(w for words in reply_words for w in words)
    reply_df_max = max(3, int(0.04 * len(replies)))
    whole = {d["id"]: (_whole(d["id"]), _whole(d["stem"]) if len(d["stem"]) >= 14 else None) for d in described}
    labels_re = {label: _whole(label) for d in described for label in d["labels"]}

    def names(d: dict, text: str) -> bool:
        """Whether `text` names the task as a whole word (by id, or by an id stem of 14+ characters). A plain substring test goes first: the whole-word
        pattern can only match where the needle appears at all, and most replies name none of the sixty tasks, so this is the same answer in far less time."""
        if not text:
            return False
        w_id, w_stem = whole[d["id"]]
        return bool((d["id"] in text and w_id.search(text)) or (w_stem is not None and d["stem"] in text and w_stem.search(text)))

    out = []
    for index, reply in enumerate(replies):
        text = reply["text"]
        named = {d["id"] for d in described if names(d, text)}
        sweep = len(named) > 3
        tools = reply.get("tools") or ""
        called = {d["id"] for d in described if names(d, tools)}
        if len(called) > 3:
            called = set()  # a sweep of many tasks in one turn is weak for each, as a roundup reply is
        trigger = reply.get("trigger") or ""
        woken = {d["id"] for d in described if names(d, trigger)}
        if len(woken) > 3:
            woken = set()  # a wake-up that lists many tasks is a roundup, not about each
        link_set = set(LAVISH.findall(text))
        found: dict[str, dict] = {}
        for d in described:
            tid, stem = d["id"], d["stem"]
            why = []
            if tid in named and not sweep:
                why.append("mention")
            signal = reply.get("signal") or ""
            if signal == tid or signal.startswith(tid + "."):  # the store names a wake's task `<id>.turn-ended`
                why.append("signal")
            if tid in called:
                why.append("command")
            if tid in woken and "signal" not in why:
                why.append("wake")
            if ("data/" + tid) in text or ("fm/" + tid) in text or ("data/" + stem) in text or (d["branch"] and d["branch"] in text) or (d["pr"] and d["pr"] in text):
                why.append("pointer")
            elif len(link_set) == 1 and link_set & d["links"]:
                why.append("pointer")  # a reply listing 3+ board links is a roundup, not about each board's task
            if why:
                found[tid] = {"lvl": "sure", "why": why}
                continue
            keyed = next((label for label in d["labels"] if len(by_label.get(label, ())) == 1 and label in text and labels_re[label].search(text)), None)
            hit_stem = [w for w in d["stem_words"] if df[w] <= 2 and w in reply_words[index]]
            hits = sorted(set(hit_stem + [w for w in d["words"] if df[w] <= 2 and w in reply_words[index] and reply_df[w] <= reply_df_max]))
            if tid in named and sweep:
                found[tid] = {"lvl": "weak", "why": [f"named in a sweep of {len(named)} tasks"]}
            elif tools and tid in tools and whole[tid][0].search(tools):
                found[tid] = {"lvl": "weak", "why": ["named in a sweep of tool calls"]}
            elif len(hit_stem) >= 3:
                found[tid] = {"lvl": "possible", "why": ["id words: " + ", ".join(sorted(hit_stem)[:4])]}
            elif keyed:
                found[tid] = {"lvl": "weak", "why": ["keyed " + keyed]}
            elif hits:
                found[tid] = {"lvl": "weak", "why": ["title words: " + ", ".join(hits[:3])]}
        out.append(found)
    return out


def best_level(matches: dict) -> str:
    levels = {m["lvl"] for m in matches.values()}
    return "sure" if "sure" in levels else "possible" if "possible" in levels else "weak" if "weak" in levels else "none"


def sure_count(matches: dict) -> int:
    return sum(1 for m in matches.values() if m["lvl"] == "sure")


ROUTINE = re.compile(
    r"(acknowledg|no action|nothing (new|to do|needs|changed)|shipshape|all quiet|still (waiting|running|working)|wake|heartbeat|supervision|monitor|"
    r"watcher|degraded|session (start|open)|digest|recovered|rolled over|handoff)", re.I)


def is_upkeep(text: str) -> bool:
    """A reply that reaches no card and is routine: short, or routine wording early on. Everything else that reaches no card is `No task found`."""
    return len(text) < 140 or bool(ROUTINE.search(text[:300]))
