"""Synthetic session logs for the store's tests: made-up text only, laid out as each harness lays them out under a home folder.

No test here reads a real log, a real Herdr or a real keychain.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
STORE = HERE.parent
if str(STORE) not in sys.path:
    sys.path.insert(0, str(STORE))

T0 = 1_790_000_000.0


def iso(at: float) -> str:
    return datetime.fromtimestamp(at, timezone.utc).isoformat().replace("+00:00", "Z")


def uid(prefix: str, n: int) -> str:
    return f"{prefix}{n:07d}-0000-4000-8000-{n:012d}"[:36]


def sid(n: int) -> str:
    return f"5e5510{n:02d}-0000-4000-8000-{n:012d}"


def write_jsonl(path: Path, records, mode: str = "w") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, mode, encoding="utf-8") as handle:
        for record in records:
            handle.write(record if isinstance(record, str) else json.dumps(record) + "\n")


def append_jsonl(path: Path, records) -> None:
    write_jsonl(path, records, "a")


# ----------------------------------------------------------------------------------------------------------------- Claude

def c_user(text, at, uuid=None, cwd="/work/alpha", **extra):
    return {"type": "user", "uuid": uuid or uid("u", int(at)), "parentUuid": None, "timestamp": iso(at), "cwd": cwd, "sessionId": "x",
            "message": {"role": "user", "content": text}, **extra}


def c_say(text, at, cwd="/work/alpha", **extra):
    return {"type": "assistant", "uuid": uid("a", int(at)), "timestamp": iso(at), "cwd": cwd,
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}, **extra}


def c_tool(name, tool_input, at, call_id, cwd="/work/alpha", text=None):
    blocks = ([{"type": "text", "text": text}] if text else []) + [{"type": "tool_use", "id": call_id, "name": name, "input": tool_input}]
    return {"type": "assistant", "uuid": uid("t", int(at)), "timestamp": iso(at), "cwd": cwd, "message": {"role": "assistant", "content": blocks}}


def c_result(call_id, text, at, cwd="/work/alpha", error=False):
    return {"type": "user", "uuid": uid("r", int(at)), "timestamp": iso(at), "cwd": cwd,
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call_id, "content": text, "is_error": error}]}}


def c_queued(text, at, uuid=None):
    return {"type": "attachment", "uuid": uuid or uid("q", int(at)), "timestamp": iso(at),
            "attachment": {"type": "queued_command", "prompt": text}}


def c_wake(at, task="task-one"):
    text = f"<task-notification>\nfirstmate watcher wake\nsignal: /x/state/{task}.status\n</task-notification>"
    return c_user(text, at, origin={"kind": "task-notification"})


def c_owner(org="org-aaaa", account="acc-bbbb"):
    return {"type": "session-owner", "sessionId": "x", "accountUuid": account, "organizationUuid": org}


def claude_conversation(base: float = T0, n_turns: int = 4, cwd: str = "/work/alpha", with_tools: bool = True, org="org-aaaa") -> list[dict]:
    """A small Claude session: questions, a tool call with its result, a message that arrives while the agent works, a wake-up."""
    records = [c_owner(org), {"type": "mode", "mode": "normal", "sessionId": "x"}, {"type": "api-request", "id": "r1", "sessionId": "x"},
               {"type": "api-request-blob", "hash": "h1", "message": "SECRET-BLOB-TEXT", "sessionId": "x"},
               {"type": "ai-title", "aiTitle": "Synthetic alpha work", "sessionId": "x"}]
    at = base
    for n in range(n_turns):
        records.append(c_user(f"Question {n} about alpha?", at, cwd=cwd))
        at += 5
        if with_tools:
            records.append(c_tool("Bash", {"command": f"echo step {n}", "description": f"say step {n}"}, at, f"call-{n}", cwd=cwd, text=f"Working on {n}."))
            at += 2
            records.append(c_result(f"call-{n}", f"step {n}\n", at, cwd=cwd))
            at += 2
        records.append(c_say(f"Answer {n}: please decide, should I merge it?" if n % 2 else f"Answer {n}: done.", at, cwd=cwd))
        at += 30
        if n == 1:
            records.append(c_user("Another thought while you work", at, cwd=cwd))
            records.append(c_queued("A message that arrived while busy", at + 1))
            records.append(c_say("Handled both.", at + 3, cwd=cwd))
            at += 20
        if n == 2:
            records.append(c_wake(at))
            records.append(c_say("Noted the status.", at + 2, cwd=cwd))
            at += 20
    return records


def claude_path(home: Path, sid_: str, project: str = "-work-alpha", folder: str = ".claude") -> Path:
    return home / folder / "projects" / project / f"{sid_}.jsonl"


# ----------------------------------------------------------------------------------------------------------------- Codex

def codex_conversation(sid_: str, base: float = T0, cwd: str = "/work/codex", n: int = 2) -> list[dict]:
    records = [{"type": "session_meta", "timestamp": iso(base), "payload": {"id": sid_, "session_id": sid_, "cwd": cwd, "source": "cli"}}]
    at = base + 1
    for k in range(n):
        records.append({"type": "response_item", "timestamp": iso(at), "payload": {"type": "message", "id": f"m{k}u", "role": "user",
                        "content": [{"type": "input_text", "text": f"Codex question {k}"}]}})
        records.append({"type": "response_item", "timestamp": iso(at + 1), "payload": {"type": "custom_tool_call", "name": "exec", "call_id": f"c{k}",
                        "input": json.dumps({"command": f"ls {k}"})}})
        records.append({"type": "response_item", "timestamp": iso(at + 2), "payload": {"type": "custom_tool_call_output", "call_id": f"c{k}",
                        "output": f"file{k}\n"}})
        records.append({"type": "event_msg", "timestamp": iso(at + 2), "payload": {"type": "token_count"}})
        records.append({"type": "response_item", "timestamp": iso(at + 3), "payload": {"type": "message", "id": f"m{k}a", "role": "assistant",
                        "content": [{"type": "output_text", "text": f"Codex answer {k}. Should I continue?" if k else "Codex answer 0."}]}})
        at += 10
    return records


def codex_path(home: Path, sid_: str, day: str = "2026/11/06") -> Path:
    return home / ".codex" / "sessions" / day / f"rollout-2026-11-06T10-00-00-{sid_}.jsonl"


# --------------------------------------------------------------------------------------------------------------- Copilot

def copilot_conversation(sid_: str, base: float = T0, cwd: str = "/work/copilot", n: int = 2) -> list[dict]:
    records = [{"type": "session.start", "id": "e0", "timestamp": iso(base), "data": {"sessionId": sid_, "version": 1, "context": {"cwd": cwd}}}]
    at = base + 1
    for k in range(n):
        records.append({"type": "user.message", "id": f"u{k}", "timestamp": iso(at), "data": {"content": f"Copilot question {k}", "messageId": f"00000{k}-0000-4000-8000-000000000000", "delivery": "idle"}})
        records.append({"type": "assistant.message", "id": f"a{k}", "timestamp": iso(at + 1), "data": {"messageId": f"a-{k}", "content": f"Copilot answer {k}.", "toolRequests": []}})
        records.append({"type": "hook.start", "id": f"h{k}", "timestamp": iso(at + 1), "data": {}})
        if k == 0:
            records.append({"type": "session.compaction_complete", "id": "cc", "timestamp": iso(at + 2), "data": {"success": True}})
        at += 10
    return records


def copilot_path(home: Path, sid_: str) -> Path:
    return home / ".copilot" / "session-state" / sid_ / "events.jsonl"


# ---------------------------------------------------------------------------------------------------------------------- Pi

def pi_conversation(sid_: str, base: float = T0, cwd: str = "/work/pi", n: int = 2) -> list[dict]:
    records = [{"type": "session", "version": 3, "id": sid_, "timestamp": iso(base), "cwd": cwd},
               {"type": "model_change", "id": "mc", "parentId": None, "timestamp": iso(base), "modelId": "m", "provider": "p"}]
    at = base + 1
    for k in range(n):
        records.append({"type": "message", "id": f"pu{k}", "parentId": None, "timestamp": iso(at),
                        "message": {"role": "user", "content": [{"type": "text", "text": f"Pi question {k}"}]}})
        records.append({"type": "message", "id": f"pa{k}", "parentId": f"pu{k}", "timestamp": iso(at + 1),
                        "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"}, {"type": "toolCall", "id": f"tc{k}", "name": "bash", "arguments": {}}]}})
        records.append({"type": "message", "id": f"pr{k}", "parentId": f"pa{k}", "timestamp": iso(at + 2),
                        "message": {"role": "toolResult", "content": [{"type": "text", "text": "ok"}]}})
        records.append({"type": "message", "id": f"pf{k}", "parentId": f"pr{k}", "timestamp": iso(at + 3),
                        "message": {"role": "assistant", "content": [{"type": "text", "text": f"Pi answer {k}."}]}})
        at += 10
    return records


def pi_path(home: Path, sid_: str, project: str = "--work-pi--") -> Path:
    return home / ".pi" / "agent" / "sessions" / project / f"2026-11-05T06-04-48-408Z_{sid_}.jsonl"


# ---------------------------------------------------------------------------------------------------------------------- homes

def make_home(prefix: str = "rstore-test-") -> Path:
    return Path(tempfile.mkdtemp(prefix=prefix)).resolve()


def lines(records) -> list[str]:
    return [json.dumps(r) + "\n" for r in records]
