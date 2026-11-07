"""The board's reply threads (slices 4 reader half and 5): for each card the supervisor's replies about it with your messages attached, in time order,
the reply that asked each call, the request that started a task, and the two rows of replies that reach no card.

Input is the board's items (built from Firstmate's records) and the session's transcript (`transcripts.py`, from the store's views). The rules that
decide which reply is about which task are `tagger.py`; your marks (`marks.py`, from each task's own record) override them per turn after they ran:
`in` puts a reply on the card even if no rule found it, `out` takes it off. Nothing here writes anything.
"""

from __future__ import annotations

import re
import time

from . import marks as marks_lib
from . import tagger, transcripts
from .transcripts import Transcript

THREAD_KEEP = 24          # items kept per card (replies and yours); a request that started the task is always kept
REPLY_CLIP = 700
ASKED_CLIP = 220
YOURS_CLIP = 520
ROW_KEEP = 40             # rows kept in each of the two upkeep rows
REQUEST_MIN_CHARS = 25
REQUEST_BEFORE_START = 60       # a request counts when the task started up to 45 minutes after it, or a minute before (clock noise)
REQUEST_AFTER_START = 2700
HOLD_REPLY_BEFORE = 90          # a hold is set in the same turn as the reply that announces it
HOLD_REPLY_AFTER = 2400
WORKER_REPLY_AFTER = 6 * 3600   # a worker's own question is relayed later: only a task-matched reply within 6 hours counts


def plain(text: str) -> str:
    text = re.sub(r"\*\*|__", "", text or "")
    text = re.sub(r"^#+\s*", "", text, flags=re.M)
    text = re.sub(r"^\s*Nathan,\s*", "", text)
    return text


def clip(text: str, limit: int) -> str:
    text = re.sub(r"[ \t]+\n", "\n", plain(text)).strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def day(epoch: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(epoch))


def hm(epoch: float) -> str:
    return time.strftime("%H:%M", time.localtime(epoch))


def describe_items(items: list[dict]) -> list[dict]:
    out = []
    for item in items:
        calls = item.get("calls") or []
        out.append({
            "id": item["ref"], "title": item.get("title"), "branch": item.get("branch"), "pr": item.get("pr"),
            "links": [m.group(0) for c in calls if c.get("link") for m in [tagger.LAVISH.search(c["link"])] if m],
            "labels": [c["id"] for c in calls if c.get("id")],
        })
    return out


def reply_view(r: dict) -> dict:
    return {"key": r["key"], "e": r["e"], "d": day(r["e"]), "hm": hm(r["e"]), "link": {"s": r["sid"], "m": r["uid"]}}


def build(session, items: list[dict], transcript: Transcript, now: float | None = None, own_ref: str | None = None) -> dict:
    """`own_ref`: a worker board's own task. Every reply in a worker's own session is about its task, so each is put on that card as exact."""
    now = now or time.time()
    replies = transcript.replies
    tasks = describe_items(items)
    matches = tagger.match_replies(replies, tasks)
    if own_ref:
        for found in matches:
            found[own_ref] = {"lvl": "sure", "why": ["this worker's own session"]}
    refs = {item["ref"] for item in items}
    marks = {item["ref"]: marks_lib.read(session.home, item["ref"]) for item in items}
    # your messages, each anchored to the reply it answers
    for human in transcript.humans:
        human["reply"], human["how"] = transcripts.anchor(human, replies)
    by_reply: dict[int, list[dict]] = {}
    for human in transcript.humans:
        if human["reply"] is not None:
            by_reply.setdefault(human["reply"], []).append(human)

    def member(index: int, ref: str):
        """(level, reasons) when reply `index` belongs on `ref`'s card, after your marks; else None."""
        mark = marks.get(ref, {}).get(replies[index]["key"])
        if mark == "out":
            return None
        if mark == "in":
            return "marked", ["you marked it"]
        found = matches[index].get(ref)
        return (found["lvl"], found["why"]) if found and found["lvl"] in ("sure", "possible") else None

    # a reply "reaches a card" only if a card would show it (a one-liner naming a task is upkeep, not a card entry)
    reach = [len(replies[i]["text"]) >= tagger.MIN_REPLY_CHARS and any(member(i, ref) for ref in refs) for i in range(len(replies))]

    # requests that start a task: a message of yours with no reply above it, linked by time to the task that started right after
    started = {item["ref"]: item.get("started_at") for item in items}
    requests: dict[str, list[dict]] = {}
    request_total = request_linked = 0
    for human in transcript.humans:
        if human["reply"] is not None or len(human["text"]) < REQUEST_MIN_CHARS:
            continue
        request_total += 1
        candidates = sorted((s, ref) for ref, s in started.items() if s and human["e"] - REQUEST_BEFORE_START <= s <= human["e"] + REQUEST_AFTER_START)
        if not candidates:
            continue
        request_linked += 1
        requests.setdefault(candidates[0][1], []).append({**human, "mins": int((candidates[0][0] - human["e"]) / 60)})

    threads: dict[str, dict] = {}
    for item in items:
        ref = item["ref"]
        entries = []
        for index, reply in enumerate(replies):
            found = member(index, ref)
            out = marks.get(ref, {}).get(reply["key"]) == "out"
            if not (found or out) or len(reply["text"]) < tagger.MIN_REPLY_CHARS:
                continue
            if out:  # kept on the card, struck through, so "Put it back" has something to act on
                entries.append({"k": "reply", **reply_view(reply), "text": clip(reply["text"], REPLY_CLIP), "lvl": "out", "why": ["you marked it out"], "n": 0})
                continue
            level, why = found
            roundup = tagger.sure_count(matches[index])
            entries.append({"k": "reply", **reply_view(reply), "text": clip(reply["text"], REPLY_CLIP), "lvl": level, "why": why, "n": roundup})
            for human in by_reply.get(index, []):
                if marks.get(ref, {}).get(human["key"]) == "out":
                    continue
                entries.append(human_view(human, how=human["how"]))
        have = {e["key"] for e in entries}
        for human in requests.get(ref, []):
            if human["key"] not in have and marks.get(ref, {}).get(human["key"]) != "out":
                entries.append(human_view(human, how="request, linked by time", req=True, mins=human["mins"]))
        for human in transcript.humans:  # a message of yours you marked onto this task even though no rule or request found it
            if marks.get(ref, {}).get(human["key"]) == "in" and human["key"] not in {e["key"] for e in entries}:
                entries.append(human_view(human, how="you marked it", marked=True))
        entries.sort(key=lambda e: (e["e"], e["k"] != "reply"))
        n_replies = sum(1 for e in entries if e["k"] == "reply" and e["lvl"] != "out")
        kept = entries[-THREAD_KEEP:] if len(entries) > THREAD_KEEP else entries
        while kept and kept[0]["k"] == "nathan" and not kept[0].get("req") and len(entries) > THREAD_KEEP:
            kept = kept[1:]
        kept = sorted({e["key"] + e["k"]: e for e in [*[e for e in entries if e.get("req")], *kept]}.values(), key=lambda e: (e["e"], e["k"] != "reply"))
        threads[ref] = {"thread": kept, "thread_n": n_replies, "thread_you": sum(1 for e in entries if e["k"] == "nathan"),
                        "thread_cut": max(0, n_replies - sum(1 for e in kept if e["k"] == "reply" and e["lvl"] != "out")), "marks": marks.get(ref, {})}

    asked = {}
    for item in items:
        per_call = {}
        for call in item.get("calls") or []:
            found = asked_reply(replies, matches, item["ref"], call, member)
            if found:
                per_call[call["id"]] = found
        if per_call:
            asked[item["ref"]] = per_call

    upkeep, no_task = [], []
    for index, reply in enumerate(replies):
        if reach[index]:
            continue
        row = {**reply_view(reply), "text": clip(reply["text"], 260)}
        (upkeep if tagger.is_upkeep(reply["text"]) else no_task).append(row)

    levels = {"sure": 0, "possible": 0, "weak": 0, "none": 0}
    for found in matches:
        levels[tagger.best_level(found)] += 1
    return {
        "status": "ok", "asof": transcript.asof, "sessions": len(transcript.sessions), "replies": len(replies), "yours": len(transcript.humans),
        "tasks": threads, "asked": asked,
        "upkeep": {"n": len(upkeep), "items": upkeep[::-1][:ROW_KEEP]}, "notask": {"n": len(no_task), "items": no_task[::-1][:ROW_KEEP]},
        "stats": {"levels": levels, "roundups": sum(1 for f in matches if tagger.sure_count(f) >= 3), "requests": {"total": request_total, "linked": request_linked},
                  "marks": sum(len(m) for m in marks.values())},
    }


def human_view(human: dict, how: str, req: bool = False, mins: int | None = None, marked: bool = False) -> dict:
    how_text = {"sheet": "answer sheet", "sheet-time": "answer sheet", "adjacent": "next message", "none": ""}.get(how.split(" ")[0], how)
    if how.startswith("key "):
        how_text = "keyed " + how.split(" ", 1)[1]
    view = {"k": "nathan", "key": human["key"], "e": human["e"], "d": day(human["e"]), "hm": hm(human["e"]), "text": clip(human["text"], YOURS_CLIP),
            "part": clip(human["part"], 90) if human.get("part") else None, "how": how_text, "link": {"s": human["sid"], "m": human["uid"]}}
    if req:
        view.update({"req": True, "mins": mins})
    if marked:
        view["marked"] = True
    return view


def asked_reply(replies: list[dict], matches: list[dict], ref: str, call: dict, member) -> dict | None:
    """The reply that asked a call (R2 = a). A typed ask's id is in the reply that announced it (`ask: <id>`); a hold is set in the same turn as the
    reply that announces it, so the first reply within 40 minutes of the hold time that the rules tied to the task counts, else the nearest one; a
    worker's own question is relayed later, so only a task-matched reply within 6 hours counts."""
    at = call.get("at")
    if not at:
        return None
    src = call.get("src")
    exact_id = ((call.get("ask") or {}).get("id")) if src == "ask" else None
    if exact_id:
        for index, reply in enumerate(replies):
            if exact_id in reply["text"]:
                return {**reply_view(reply), "how": "exact", "text": clip(reply["text"], ASKED_CLIP), "mins": int((reply["e"] - at) / 60)}
    lo, hi = (at - HOLD_REPLY_BEFORE, at + HOLD_REPLY_AFTER) if src in ("hold", "ask") else (at, at + WORKER_REPLY_AFTER)
    window = [(i, r) for i, r in enumerate(replies) if lo <= r["e"] <= hi and len(r["text"]) >= tagger.MIN_REPLY_CHARS]
    pick = next(((i, r, "task") for i, r in window if member(i, ref)), None)
    if not pick and window and src in ("hold", "ask"):
        pick = (window[0][0], window[0][1], "nearest")
    if not pick:
        return None
    reply = pick[1]
    return {**reply_view(reply), "how": pick[2], "text": clip(reply["text"], ASKED_CLIP), "mins": int((reply["e"] - at) / 60)}
