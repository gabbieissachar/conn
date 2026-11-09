"""Reviewing a task on its card (T-round): record what you decided on the task's real record.

A live write into a Firstmate home, behind `PMOS_READER_BOARD_REVIEW=1` (off by default). The board never edits a backlog file. Each outcome is the
Firstmate command that already owns that change, run with the session's own `FM_HOME`, and the command's own sentence is what the card shows:

| You chose                       | The task is                                  | Command                                                                              |
| Done                            | held for you (a captain hold)                | `fm-captain-hold.sh answers --any-origin --source reader-board`, mode `done`         |
|                                 | otherwise                                    | `fm-tasks-axi.sh done <id> --note ...`                                               |
| Queued                          | held for you                                 | `fm-captain-hold.sh answers ...`, mode `release` (the command refuses it while away) |
|                                 | held another way                             | `fm-tasks-axi.sh unhold <id>`                                                        |
|                                 | in flight or done (no worker)                | `fm-tasks-axi.sh reopen <id>`                                                        |
| Delay until a date              | any open task without a worker               | `fm-captain-hold.sh hold <id> --reason ... --until YYYY-MM-DD`                       |
| Needs you                       | any open task without a worker               | `fm-captain-hold.sh hold <id> --reason ...`                                          |
| Follow-up                       | (a new task)                                 | `fm-tasks-axi.sh add --mint <title> --kind task --queue --body ...` (`Follow-up of:`, `Due by:`) |

The stages the board can set are the ones the backlog itself has (needs you, queued, parked until a date, done). The other columns of a lifecycle (Running,
Ready to land, In review ...) are decided by what the worker reports, so a card cannot be moved into them.

Done, Delay and Needs you are refused, with the reason on the card and nothing changed, when the task still has a live worker (a `state/<id>.meta`), a branch
or PR that has not landed, or an open typed card (answer it, or say Later on it, first): finishing such a task is Firstmate's own landing and cleanup, and a
board button must never force it. The facts come from the board's own last read (the Node side passes them), and the worker record is checked again here.
"""

from __future__ import annotations

import re
import time
from pathlib import Path

from .answer import AnswerError, _clean, _reason, _run, _tail
from .answer import _script as _checkout_script
from .collect import TASK_ID, script_env

ACTIONS = ("done", "queue", "delay", "needs", "followup")
DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
MAX_NOTE = 300
MAX_TITLE = 140
MAX_DELAY_DAYS = 400
REPO = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


class ReviewError(AnswerError):
    """The review was not recorded; the message is one plain sentence the card shows."""


def _script(root, name):
    try:
        return _checkout_script(root, name)
    except AnswerError as error:
        raise ReviewError(str(error).replace("so nothing was sent", "so nothing was changed"), error.status) from None


def _line(text, limit):
    """One plain line: control characters and line breaks become spaces, parentheses (the backlog refuses them in a reason) become dashes."""
    text = re.sub(r"\s+", " ", _clean(text or "")).strip()
    return text.replace("(", "- ").replace(")", "").strip()[:limit]


def _date(value, what):
    found = DATE.match(value or "")
    if not found:
        raise ReviewError(f"{what} must be a date (YYYY-MM-DD).")
    try:
        time.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ReviewError(f"{what} is not a real date.") from None
    return value


def parse_show(text: str) -> dict:
    """`fm-tasks-axi.sh show <id>`: indented `key: value` lines under `task:`."""
    values = {}
    for line in (text or "").splitlines():
        found = re.match(r"^\s{2}([a-z_]+):\s*(.*)$", line)
        if found:
            value = found.group(2).strip()
            if len(value) >= 2 and value[0] == value[-1] == '"':
                value = value[1:-1]
            values[found.group(1)] = "" if value == "-" else value
    return values


def _today() -> str:
    return time.strftime("%Y-%m-%d")


def refusal(current: dict, home: Path, task: str, action: str, facts: dict | None) -> str | None:
    """Why this action must not run on this task now, as one sentence (None when it may). `current` is the task's own record (`show`)."""
    state, held, hold_kind = current.get("state"), current.get("held") == "yes", current.get("hold_kind")
    facts = facts or {}
    live = (Path(home) / "state" / f"{task}.meta").is_file() or bool(facts.get("live"))
    if action == "done" and (facts.get("ready") or facts.get("branch_state") == "ahead" or (facts.get("pr") and not facts.get("merged"))):
        return "This task has a branch or PR that has not landed, so it cannot be marked done here. Land it first. Nothing was changed."
    if action in ("done", "delay", "needs") and live:
        return "A worker still has this task, so finishing or holding it is Firstmate's job (landing and cleanup). Nothing was changed."
    if action == "queue" and live and state == "in_flight":
        return "A worker is running on this task, so it cannot be moved back to Queued from here. Nothing was changed."
    if action in ("done", "delay", "needs", "queue") and facts.get("ask_open"):
        return "This task has an open card waiting for your answer. Answer it (or say Later on it) first, so the card does not stay open on a task that moved. Nothing was changed."
    if action == "done" and state == "done":
        return "This task is already done."
    if action in ("delay", "needs") and state == "done":
        return "This task is already done. Move it back to Queued first. Nothing was changed."
    if action == "queue" and state == "queued" and not held:
        return "This task is already queued."
    if action == "needs" and held and hold_kind == "captain" and not current.get("hold_until"):
        return "This task is already waiting for you."
    return None


def act(session, root: Path | None, payload: dict, runner=None) -> dict:
    """Record one review outcome. `payload`: task, action, note, until (delay), title and due (followup), facts (the board's own read, added by the reader)."""
    task, action = payload.get("task"), payload.get("action")
    if not isinstance(task, str) or not TASK_ID.match(task):
        raise ReviewError("That is not a task reference.")
    if action not in ACTIONS:
        raise ReviewError("That is not a review action.")
    note = _line(payload.get("note"), MAX_NOTE)
    facts = payload.get("facts") if isinstance(payload.get("facts"), dict) else {}
    env = script_env(session.home)
    tasks_script = _script(root, "fm-tasks-axi.sh")
    if action == "followup":
        return _followup(session, task, payload, note, facts, tasks_script, env, runner)
    shown = _run(runner, [str(tasks_script), "show", task], env)
    if shown.returncode != 0:
        raise ReviewError("The backlog has no task with that reference now. Refresh the board.", 404)
    current = parse_show(shown.stdout)
    why = refusal(current, session.home, task, action, facts)
    if why:
        raise ReviewError(why, 409)
    held, hold_kind = current.get("held") == "yes", current.get("hold_kind")
    state = current.get("state")
    via, done = None, None
    if action == "delay":
        until = _date(payload.get("until"), "The date")
        if until <= _today():
            raise ReviewError("Pick a date after today.")
        if until > time.strftime("%Y-%m-%d", time.localtime(time.time() + MAX_DELAY_DAYS * 86400)):
            raise ReviewError("That date is more than a year away. Pick a nearer one, or park the task another way.")
        reason = f"Delayed from the board review until {until}" + (f": {note}" if note else "")
        via, done = "fm-captain-hold.sh hold --until", _run(runner, [str(_script(root, "fm-captain-hold.sh")), "hold", task, "--reason", reason, "--until", until], env)
    elif action == "needs":
        reason = "Put back in Needs you from the board review" + (f": {note}" if note else "")
        via, done = "fm-captain-hold.sh hold", _run(runner, [str(_script(root, "fm-captain-hold.sh")), "hold", task, "--reason", reason], env)
    elif action == "done":
        words = "Closed from the board review" + (f": {note}" if note else "")
        if held and hold_kind == "captain":
            via, done = "fm-captain-hold.sh answers (done)", _run(runner, [str(_script(root, "fm-captain-hold.sh")), "answers", "--any-origin", "--source", "reader-board"], env,
                                                              f"{task}\t{words}\tboard review\tdone\n")
            if done.returncode == 0 and re.search(r"^(skipped|refused):", done.stdout or "", re.M):
                done.returncode = 1
        else:
            via, done = "fm-tasks-axi.sh done", _run(runner, [str(tasks_script), "done", task, "--note", words], env)
    else:  # queue
        if held and hold_kind == "captain":
            words = "Moved to Queued from the board review" + (f": {note}" if note else "")
            via, done = "fm-captain-hold.sh answers (release)", _run(runner, [str(_script(root, "fm-captain-hold.sh")), "answers", "--any-origin", "--source", "reader-board"], env,
                                                                 f"{task}\t{words}\tboard review\trelease\n")
            if done.returncode == 0 and re.search(r"^(skipped|refused):", done.stdout or "", re.M):
                done.returncode = 1
        elif held:
            via, done = "fm-tasks-axi.sh unhold", _run(runner, [str(tasks_script), "unhold", task], env)
        else:
            via, done = "fm-tasks-axi.sh reopen", _run(runner, [str(tasks_script), "reopen", task], env)
    if done.returncode != 0:
        raise ReviewError("Firstmate did not record it: " + _reason(done), 409)
    after = _run(runner, [str(tasks_script), "show", task], env)
    now = parse_show(after.stdout) if after.returncode == 0 else {}
    return {"recorded": True, "via": via, "task": task, "action": action, "output": _tail(done.stdout),
            "after": {"state": now.get("state"), "held": now.get("held") == "yes", "until": now.get("hold_until") or None}}


def _followup(session, task, payload, note, facts, tasks_script, env, runner) -> dict:
    title = _line(payload.get("title"), MAX_TITLE)
    if len(title) < 3:
        raise ReviewError("Give the follow-up a title (3 characters or more).")
    due = payload.get("due")
    lines = [f"Created: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}", f"Follow-up of: {task}"]
    if due:
        _date(due, "The due date")
        lines.append(f"Due by: {due}")
    if note:
        lines.append(f"Note: {note}")
    argv = [str(tasks_script), "add", "--mint", title, "--kind", "task", "--queue", "--body", "\n".join(lines)]
    repo = facts.get("repo")
    if isinstance(repo, str) and REPO.match(repo) and repo != "no project":
        argv[2:2] = ["--repo", repo]
    done = _run(runner, argv, env)
    if done.returncode != 0:
        raise ReviewError("Firstmate did not add the follow-up: " + _reason(done), 409)
    found = re.search(r"added ([A-Za-z0-9][A-Za-z0-9._-]*)", done.stdout or "")
    return {"recorded": True, "via": "fm-tasks-axi.sh add", "task": task, "action": "followup", "followup": found.group(1) if found else None, "due": due or None,
            "output": _tail(done.stdout)}
