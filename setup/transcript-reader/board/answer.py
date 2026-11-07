"""Answering a call on its card (slice 6): a live write into a Firstmate home, behind a flag that is off by default (`PMOS_READER_BOARD_ANSWER=1`).

The board never closes anything itself. It turns the click into the one Firstmate command that already owns that kind of call, run with that home's
`FM_HOME`, and shows the command's own answer:

| The call is                                   | Command                                                                              | What it does                                   |
| typed card (`src: ask`)                       | `fm-captain-ask.sh answered <ask-id>` with `KEY=value` on stdin                      | records that card; closes the gate when all its cards are answered |
| the only call of a prose hold (`src: hold`)   | `fm-captain-hold.sh answers --any-origin --source reader-board` with the keyed line  | records your words and closes (or, for a go, releases) the hold |
| a worker's keyed question (`src: status`)     | `fm-send.sh <task> --resolve-key <key> <text>`                                       | steers the worker and closes that key          |
| a worker waiting for you (`src: wait`)        | `fm-send.sh <task> <text>`                                                           | a plain steer                                  |

A prose hold with several calls is refused: Firstmate can close such a hold only as a whole, so answering one call would close the others unseen.
Those calls are answered in chat, or by re-asking them as typed cards (the typed form closes each call on its own). A review-board call
(`type: board`) is answered on its own board. The client sends which call and what you picked; the option's words for a typed card are taken from
the record, never from the page, and nothing is sent unless the command accepts it.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .collect import TASK_ID, script_env

MAX_ANSWER_BYTES = 8192
KEY = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
ASK_KEY = re.compile(r"^[A-Z][0-9]{1,2}$")
TIMEOUT = 60
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class AnswerError(RuntimeError):
    """The answer was not sent; the message is one plain sentence the page shows."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _clean(text: str) -> str:
    return CONTROL.sub(" ", text or "").strip()


def _run(runner, argv, env, stdin=None):
    run = runner or (lambda a, e, t, s=None: subprocess.run(a, env=e, input=s, capture_output=True, text=True, timeout=t, check=False))
    try:
        return run(argv, env, TIMEOUT, stdin)
    except subprocess.TimeoutExpired:
        raise AnswerError("Firstmate did not answer in time; nothing is known to be recorded. Check the card before trying again.", 504) from None
    except OSError:
        raise AnswerError("The Firstmate command could not start.", 502) from None


def _script(root: Path | None, name: str) -> Path:
    script = Path(root) / "bin" / name if root else None
    if script is None or not script.is_file():
        raise AnswerError(f"This Firstmate checkout has no {name}, so nothing was sent.", 501)
    return script


def _reason(done) -> str:
    lines = [line.strip() for line in ((done.stderr or "") + "\n" + (done.stdout or "")).splitlines() if line.strip()]
    return (lines[-1] if lines else "the command refused")[:240]


def answer(session, root: Path | None, payload: dict, runner=None) -> dict:
    """Record one answer. `payload`: task, call (the card's key or id), src, and either option (a letter) or text, or later (typed cards only)."""
    task = payload.get("task")
    call = payload.get("call")
    src = payload.get("src")
    if not isinstance(task, str) or not TASK_ID.match(task):
        raise AnswerError("That is not a task reference.")
    if not isinstance(call, str) or not KEY.match(call):
        raise AnswerError("That is not a call reference.")
    text = _clean(payload.get("text") or "")
    option = payload.get("option")
    if option is not None and not (isinstance(option, str) and re.fullmatch(r"[a-h0-9]", option)):
        raise AnswerError("That is not one of the options.")
    if len(text.encode("utf-8")) > MAX_ANSWER_BYTES:
        raise AnswerError("That answer is too long to record (8 KB at most).")
    env = script_env(session.home)
    if src == "ask":
        return _answer_typed(session, root, task, call, option, text, bool(payload.get("later")), env, runner)
    if not text and not option:
        raise AnswerError("Pick an option or type an answer first.")
    if src == "hold":
        return _answer_hold(root, task, call, payload, text, env, runner)
    if src in ("status", "wait"):
        return _answer_worker(root, task, call, src, text, env, runner)
    raise AnswerError("This call is answered elsewhere (a review board, or in chat).", 409)


def _answer_typed(session, root, task, call, option, text, later, env, runner) -> dict:
    ask_script = _script(root, "fm-captain-ask.sh")
    if not ASK_KEY.match(call):
        raise AnswerError("That is not a card key.")
    listed = _run(runner, [str(ask_script), "list", "--open", "--resolve", "--json"], env)
    if listed.returncode != 0:
        raise AnswerError("Could not read the open cards: " + _reason(listed), 502)
    try:
        records = json.loads(listed.stdout)
    except ValueError:
        raise AnswerError("Could not read the open cards.", 502) from None
    found = None
    for record in records if isinstance(records, list) else []:
        for card in record.get("cards") or []:
            if card.get("key") == call and card.get("state") == "open" and (card.get("gate") or {}).get("task") == task:
                found = (record, card)
    if not found:
        raise AnswerError("That card is no longer open for this task (answered elsewhere, expired or replaced). Refresh the board.", 409)
    record, card = found
    if later:
        value = "later"
    elif option:
        options = card.get("options") or []
        index = "abcdefgh".index(option) if option in "abcdefgh" else -1
        if index < 0 or index >= len(options):
            raise AnswerError("That is not one of the card's options.")
        value = options[index].get("value", "")
    else:
        value = text
    # The reply grammar reads every `KEY=value` in the line and ends a value at `;` or a newline: words that could be read as another card's answer or
    # as the end of this one are rewritten, so the text can never answer a card you did not pick.
    value = re.sub(r"\s*[;\n\r|]+\s*", ", ", value)
    value = re.sub(r"\b([A-Z]\d{1,2})\s*=", r"\1:", value).strip(" ,")
    if not value:
        raise AnswerError("Pick an option or type an answer first.")
    done = _run(runner, [str(ask_script), "answered", record["id"]], env, f"{call}={value}\n")
    if done.returncode != 0:
        raise AnswerError("Firstmate did not record the answer: " + _reason(done), 409)
    return {"recorded": True, "via": "fm-captain-ask.sh answered", "ask": record["id"], "call": call, "value": value, "output": _tail(done.stdout)}


def _answer_hold(root, task, call, payload, text, env, runner) -> dict:
    if int(payload.get("calls") or 1) > 1:
        raise AnswerError("This hold has several calls written as one block of text, and Firstmate can only close such a hold whole. "
                          "Answer these in chat, or have them re-asked as cards so each closes on its own.", 409)
    hold_script = _script(root, "fm-captain-hold.sh")
    mode = "release" if payload.get("release") else "done"
    words = text or str(payload.get("option") or "")
    line = f"{task}\t{words.replace(chr(9), ' ').replace(chr(10), ' ')}\tboard card\t{mode}\n"
    done = _run(runner, [str(hold_script), "answers", "--any-origin", "--source", "reader-board"], env, line)
    if done.returncode != 0 or re.search(r"^(skipped|refused):", done.stdout or "", re.M):
        raise AnswerError("Firstmate did not record the answer: " + _reason(done), 409)
    return {"recorded": True, "via": "fm-captain-hold.sh answers", "call": call, "mode": mode, "output": _tail(done.stdout)}


def _answer_worker(root, task, call, src, text, env, runner) -> dict:
    send_script = _script(root, "fm-send.sh")
    argv = [str(send_script), task]
    if src == "status":
        argv += ["--resolve-key", call]
    argv.append(text)
    done = _run(runner, argv, env)
    if done.returncode != 0:
        raise AnswerError("Firstmate did not send the answer: " + _reason(done), 409)
    return {"recorded": True, "via": "fm-send.sh", "call": call, "output": _tail(done.stdout)}


def _tail(text: str | None) -> str:
    lines = [line for line in (text or "").splitlines() if line.strip()]
    return "\n".join(lines[-4:])[:600]
