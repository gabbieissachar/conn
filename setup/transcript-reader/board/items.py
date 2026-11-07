"""One task of a home -> one card of the board.

Input is what Firstmate already knows (the fleet snapshot's backlog record and, for a task with a worker, its task row), the typed ask
records, the task's status lines, and git's view of its branch. Output is the card (the shape the prototype's data.js used, so the page
built on it needs no second model) with its stage, its facts and its column. The stage and column rules are in lifecycles.py.

Calls, in the order they are looked for: a typed ask record's open card gated on this task (src `ask`: question, choices and recommended
choice as fields); else the hold's prose split into calls (src `hold`, the old way, kept for old holds); then the keyed open decisions of the
task's status lines (src `status`); then a paused line that says the worker waits for the owner (src `wait`). A task with a typed card does
not also show its hold prose.
"""

from __future__ import annotations

import re
import time
from pathlib import Path

from . import hold_parse
from .collect import TASK_ID, Collector
from .lifecycles import place

ARTIFACT = re.compile(r"(ready|report|draft|prototype|published|complete|lesson|written|refreshed|packet)", re.I)
STANDING = re.compile(r"(standing (crew|by)|idle until the next|waiting for the next request|no known eta)", re.I)
WAITS_FOR_CAPTAIN = re.compile(r"(waiting|waits|waiting on|standing by).{0,40}(Nathan|the captain|owner|your)", re.I)
MERGED_WORD = re.compile(r"\b(merged|landed|retired)\b", re.I)
BRANCH_IN_TEXT = re.compile(r"\bbranch ((?:[A-Za-z0-9._-]+)/[\w./-]+)")
HEAD_IN_TEXT = re.compile(r"\bhead ([0-9a-f]{7,40})\b")
PR_IN_TEXT = re.compile(r"(https://[^\s)]+/(?:pull|merge_requests)/\d+)")
LAVISH = re.compile(r"(http://127\.0\.0\.1:\d+/session/\w+)")
BOILERPLATE = re.compile(r"^(Captain hold|Resolution|Decision digest|Resolution mode|Captain decision|Task:|Answer|Reconcile|Captain hold origin|Deliverable of|Created:)")
STALE_QUIET_DAYS = 14
DONE_DAYS = 7
CALL_TEXT_LIMIT = 700


def local_date(epoch: float | None) -> str | None:
    return time.strftime("%Y-%m-%d", time.localtime(epoch)) if epoch else None


def local_stamp(epoch: float | None) -> str | None:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(epoch)) if epoch else None


def iso_epoch(stamp: str | None) -> int | None:
    import calendar
    try:
        return calendar.timegm(time.strptime((stamp or "")[:19], "%Y-%m-%dT%H:%M:%S")) if stamp else None
    except ValueError:
        return None


def fold_open_decisions(events: list[dict]) -> list[dict]:
    """The keyed open-decision fold of a status log (needs-decision and blocked stay open until a resolved line with the same key)."""
    open_by_key, order = {}, []
    for event in events:
        key = event["key"] or "default"
        if event["state"] in ("needs-decision", "blocked"):
            open_by_key[key] = event
            if key not in order:
                order.append(key)
        elif event["state"] == "resolved":
            if event["key"] is None:
                open_by_key.clear()
            else:
                open_by_key.pop(key, None)
    return [{"key": key, "verb": open_by_key[key]["state"], "summary": open_by_key[key]["text"], "at": open_by_key[key]["at"]} for key in order if key in open_by_key]


def decision_call(decision: dict) -> dict:
    link = LAVISH.search(decision.get("summary") or "")
    text = re.sub(r"\s*(\(local only\))?\s*http://127\.0\.0\.1:\d+/session/\w+\s*(\(local only\))?", "", decision.get("summary") or "")
    kind = "board" if link else ("block" if decision.get("verb") == "blocked" else "q")
    at = decision.get("at")
    return {"id": decision.get("key") or "default", "q": hold_parse.clip(text, CALL_TEXT_LIMIT), "opts": [], "src": "status", "type": kind,
            "link": link.group(1) if link else None, "since": local_date(at), "at": at}


def ask_calls(task_id: str, asks: list[dict]) -> list[dict]:
    """Open typed cards gated on this task, as calls. `asks` are the derived fm-ask.v1 records of the home."""
    calls = []
    for record in asks:
        created = iso_epoch(record.get("created_at"))
        for card in record.get("cards") or []:
            gate = card.get("gate") or {}
            if gate.get("task") != task_id or card.get("state") != "open":
                continue
            options = [{"k": "abcdefgh"[i] if i < 8 else str(i), "t": o.get("value", ""), "rec": bool(o.get("recommended")), "note": o.get("note") or ""}
                       for i, o in enumerate(card.get("options") or [])]
            calls.append({
                "id": card.get("key"), "q": hold_parse.clip(card.get("question"), CALL_TEXT_LIMIT), "opts": options, "src": "ask",
                "type": "q" if options else "text", "recommended": card.get("recommended"), "since": local_date(created), "at": created,
                "ask": {"id": record.get("id"), "key": card.get("key"), "title": record.get("title"), "kind": record.get("kind"),
                        "report": (record.get("origin") or {}).get("report"), "state": record.get("state"), "gate": gate.get("mode") or "done"},
            })
    return calls


def hold_calls(rec: dict, hold_at: int | None) -> list[dict]:
    reason = rec.get("hold_reason") or ""
    if not reason.strip():
        return [], None
    head, parts = hold_parse.split_hold(reason)
    calls = []
    for key, body in parts:
        stem, options = hold_parse.parse_options(body)
        calls.append({"id": key or "call", "q": hold_parse.clip(hold_parse.clean_question(stem), CALL_TEXT_LIMIT), "opts": options, "src": "hold",
                      "type": hold_parse.call_type(body, options), "since": local_date(hold_at), "at": hold_at})
    return calls, hold_parse.clip(hold_parse.clean_question(head), 240) if head and len(calls) > 1 else None


def project_dir(session, rec: dict, task: dict | None) -> Path | None:
    if task and task.get("project"):
        return Path(task["project"])
    repo = rec.get("repo")
    if repo and re.fullmatch(r"[A-Za-z0-9._-]+", repo):
        return Path(session.home) / "projects" / repo
    return None


def build_item(session, lifecycle: dict, rec: dict, task: dict | None, asks: list[dict], collector: Collector, now: float, today: str) -> dict | None:
    task_id = rec.get("id")
    if not task_id or not TASK_ID.match(task_id) or not rec.get("structured", True):
        return None
    done = rec.get("state") == "done"
    done_date = rec.get("done") or rec.get("reported") or (rec.get("completion") or {}).get("date")
    if done:
        cutoff = time.strftime("%Y-%m-%d", time.localtime(now - DONE_DAYS * 86400))
        if not done_date or done_date < cutoff:
            return None
    body = rec.get("body_lines") or []
    body_text = "\n".join(body)
    tail = collector.status_tail(session, task_id) if (task or not done) else []
    last = tail[-1] if tail else None
    snapshot_last = (((task or {}).get("paths") or {}).get("status_log") or {}).get("last_event") or None
    if last is None and snapshot_last:
        last = {"state": snapshot_last.get("state"), "text": snapshot_last.get("note") or "", "at": None, "key": None, "on": None}
        found = re.search(r"\[on=([^\]]+)\]", snapshot_last.get("raw") or "")
        last["on"] = found.group(1).strip() if found else None
    # --- calls
    hold_at = iso_epoch(rec.get("hold_set"))
    bucket = rec.get("hold_bucket")
    held = rec.get("hold_kind") == "captain" and not done
    calls: list[dict] = []
    head = None
    ask_found = ask_calls(task_id, asks) if not done else []
    if ask_found:
        calls.extend(ask_found)
    elif held and bucket in ("live", "aged"):
        parsed = hold_calls(rec, hold_at)
        if parsed:
            calls.extend(parsed[0])
            head = parsed[1]
    decisions = (((task or {}).get("hints") or {}).get("open_decisions")) if task else None
    if decisions is None and not done:
        decisions = fold_open_decisions(tail)
    if not done:
        calls.extend(decision_call(d) for d in decisions or [])
    if not calls and not done and last and last["state"] == "paused" and WAITS_FOR_CAPTAIN.search(last["text"]):
        calls.append({"id": "wait", "q": hold_parse.clip(last["text"], CALL_TEXT_LIMIT), "opts": [], "src": "wait", "type": "wait", "since": local_date(last.get("at")), "at": last.get("at")})
    # --- branch, pr, report
    branch = (task or {}).get("branch")
    head_sha = None
    pr = ((task or {}).get("pr") or {}).get("url") or rec.get("pr_url")
    for event in reversed(tail):
        if not branch:
            found = BRANCH_IN_TEXT.search(event["text"])
            if found:
                branch = found.group(1)
                head_found = HEAD_IN_TEXT.search(event["text"])
                head_sha = head_found.group(1) if head_found else None
        if not pr:
            found = PR_IN_TEXT.search(event["text"])
            pr = found.group(1) if found else None
    git = collector.branch_state(project_dir(session, rec, task), branch) if not done else {"state": "none", "ahead": 0, "base": None}
    report_rel, report_exists = collector.report_for(session, task_id, " ".join([rec.get("title") or "", body_text, rec.get("hold_reason") or ""]))
    # --- readiness (what the worker's lines say about the branch)
    ready = merged = False
    if branch:
        seen_ready = False
        for event in tail:
            if event["state"] == "working":
                seen_ready = False
            if event["state"] == "done" and "ready" in event["text"]:
                seen_ready, merged = True, False
            elif seen_ready and MERGED_WORD.search(event["text"]):
                merged = True
        ready = seen_ready and not merged
    elif last and re.search(r"\b(merged|retired - work merged)\b", last["text"], re.I):
        merged = True
    last_state = last["state"] if last else None
    branch_in_main = git["state"] == "merged" and last_state in ("done", "paused", "resolved")
    merged_record = bool(merged or branch_in_main) and not done
    if branch_in_main and not ready:
        ready = False
    pr_open = bool(pr) and not done
    legacy_branch = git["state"] == "ahead" and not pr_open and not done and not merged_record
    artifact_text = bool(last) and last_state in ("done", "paused") and bool(ARTIFACT.search(last["text"]))
    artifact_file = artifact_text and report_exists
    artifact = artifact_text and (report_exists or bool(branch))
    wait_on = last["on"] if (last and last_state == "paused" and last.get("on")) else None
    standing = bool(last) and last_state in ("paused", "done") and bool(STANDING.search(last["text"]))
    facts = {
        "ready": ready, "pr_open": pr_open, "merged_record": merged_record, "legacy_branch": legacy_branch, "artifact": artifact,
        "artifact_file": artifact_file, "waiting_on": bool(wait_on), "standing": standing,
        "paused_idle": last_state == "paused" and not artifact, "captain_driven": bool((task or {}).get("driver")) or "captain-driven" in body_text,
        "live": task is not None, "kind": rec.get("kind") or (task or {}).get("kind") or "task", "last_state": last_state,
    }
    # --- stage and column
    unresolved = rec.get("unresolved_blocker_ids") or []
    stage = "active"
    if done:
        stage = "done"
    elif calls and not (held and bucket == "dated" and all(c["src"] == "hold" for c in calls)):
        stage = "needs"
    elif held and bucket == "dated":
        stage = "parked"
    elif rec.get("state") == "queued" or (held and bucket == "blocked"):
        stage = "queued"
    column = place(lifecycle, stage, facts)
    go_only = stage == "needs" and bool(calls) and all(c["type"] == "go" for c in calls)
    queued_ids = {c["id"] for c in lifecycle["columns"]}
    if go_only and "queued" in queued_ids:
        column = "queued"  # R8 = a: a call that only waits for the owner's word waits in Queued, labelled
    idle_days = None
    if last and last.get("at"):
        idle_days = int((now - last["at"]) / 86400)
    elif snapshot_last and snapshot_last.get("age_seconds") is not None:
        idle_days = int(snapshot_last["age_seconds"] / 86400)
    flags = []
    if go_only:
        flags.append("go_gate")
    if bucket == "aged" and stage == "needs":
        flags.append("aged_hold")
    if merged_record and column not in ("done", "needs"):
        flags.append("stale_merged")
    if stage == "active" and idle_days is not None and idle_days >= STALE_QUIET_DAYS and column not in ("done",):
        flags.append("quiet_14d")
    legacy_shown = legacy_branch and any(c["id"] == "legacy" for c in lifecycle["columns"])  # "legacy draft branch" is a PM-lifecycle idea: elsewhere an unlanded branch is just a branch
    if legacy_shown:
        flags.append("legacy_branch")
    if git["state"] == "merged" and not done:
        flags.append("branch_in_main")
    if unresolved:
        flags.append("blocked")
    note_lines = [line for line in body if not BOILERPLATE.match(line)]
    answer = None
    for index, line in enumerate(body):
        if line.startswith("Captain decision:") and index + 1 < len(body):
            answer = body[index + 1]
    origin = next((m.group(1) for line in body for m in [re.match(r"Captain hold origin: (\S+)", line.strip())] if m), None)
    spawn = re.match(r"s(\d{9,10})", (task or {}).get("spawn_gen") or "")
    started_at = int(spawn.group(1)) if spawn else (collector.created_at(body) or next((e["at"] for e in tail if e.get("at")), None))
    stamps = [c["at"] for c in calls if c.get("at")] + ([last["at"]] if last and last.get("at") else []) + ([started_at] if started_at else [])
    activity = max(stamps) if stamps else None
    return {
        "ref": task_id, "repo": rec.get("repo") or "no project", "kind": facts["kind"], "title": hold_parse.clip(rec.get("title"), 150),
        "since": rec.get("since"), "created_at": collector.created_at(body), "started_at": started_at,
        "col": column, "stage": stage, "calls": calls, "head": head, "until": rec.get("hold_until") if held and bucket == "dated" else None,
        "held": held and bucket in ("live", "aged"), "hold_bucket": bucket if held else None, "done_date": done_date if done else None,
        "report": report_rel, "summary": hold_parse.clip(collector.report_summary(session, report_rel), 300) if report_rel else None,
        "branch": branch, "branch_state": git["state"], "branch_ahead": git["ahead"], "base_branch": git["base"], "ready": ready, "head_sha": head_sha,
        "pr": pr, "latest": ({"state": last["state"], "when": local_stamp(last.get("at")), "at": last.get("at"), "on": last.get("on"), "text": hold_parse.clip(last["text"], 240)} if last else None),
        "idle_days": idle_days, "merged": merged_record, "note": hold_parse.clip(" ".join(note_lines[:2]), 240) or None,
        "answer": hold_parse.clip(answer, 240) if answer else None, "blocked_by": list(unresolved), "driven": facts["captain_driven"], "live": facts["live"],
        "legacy": legacy_shown, "wait_on": wait_on, "flags": flags, "activity": activity, "origin": origin,
    }
