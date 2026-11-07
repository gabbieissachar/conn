"""Per-harness readers: a log's records with their byte offsets, and each record as an `events` row.

What a record becomes (plan S1, "Events"): its raw identity fields (uuid, parent, origin, isMeta, tool_use_id, absorbed) as columns,
the rest of what is worth keeping in a small `meta` JSON, and a short excerpt of its text. The whole text of a user or assistant
message lives in `turns`, derived by the reader's own rules; the event keeps 400 characters so a row can be recognised.

Three groups of records:
  kept      become an event row.
  consumed  give a fact about the session (its owner account, its title) and become no row.
  ignored   are in KNOWN_IGNORED: counted by kind (counters: ignored_record), never stored. `api-request-blob` is the one the plan
            names: it is never indexed as text.
Anything else is `unknown`: counted (counters: unknown_record) and still stored as a bare row (kind, ids, time, the names of its
keys), so a record type Claude adds tomorrow is visible and its position is kept without its text being guessed at.

Tool output follows the reader's own privacy rule: the text comes from tool_steps (a bounded output; nothing at all for a step that
touched a dotfile or a credential path), never from a record's `toolUseResult` copy.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from . import builder

bp = builder.bp
tool_steps = builder.tool_steps

EXCERPT = 400
META_MAX = 6000

# ------------------------------------------------------------------------------------------------------------ known record kinds

CLAUDE_KEPT = {"user", "assistant", "system"}
CLAUDE_CONSUMED = {"session-owner", "bridge-session", "ai-title", "custom-title", "agent-name"}
CLAUDE_IGNORED = {
    "api-request", "api-request-blob", "api-request-shape", "last-prompt", "atis-latch", "mode", "permission-mode", "queue-operation",
    "file-history-snapshot", "file-history-delta", "cost-state", "tools-used", "summary", "pr-link",
}
# Attachments: only a queued command is a conversation event (it starts an absorbed turn). The rest are the harness reminding itself.
CLAUDE_ATTACHMENT_KEPT = {"queued_command"}
CLAUDE_ATTACHMENT_IGNORED = {
    "total_tokens_reminder", "deferred_tools_record", "environment", "hook_success", "prompt_snapshot", "date", "deferred_tools_delta",
    "model", "session_context", "instructions", "mcp_instructions_delta", "skill_listing", "structured_output", "credential_org",
    "hook_additional_context", "agent_listing_delta", "edited_text_file", "remote_session_change", "silent_turn_reminder",
    "compact_file_reference", "command_permissions", "auto_mode", "file", "hook_non_blocking_error", "read_truncation_notice",
    "output_style", "nested_memory", "invoked_skills", "output_style_instructions", "hook_blocking_error", "hook_cancelled",
    "hook_system_message", "hook_error_during_execution", "diagnostics", "todo_reminder", "plan_mode", "ultrathink_effort",
}
CODEX_IGNORED_TOP = {"token_usage_record", "turn_context", "world_state", "compacted", "inter_agent_communication_metadata"}
CODEX_EVENT_MSG_IGNORED = {"item_completed", "token_count", "task_started", "task_complete", "thread_settings_applied", "turn_aborted"}
CODEX_RESPONSE_KEPT = {"message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output",
                       "web_search_call", "tool_search_call", "tool_search_output", "agent_message", "compaction"}
COPILOT_KEPT = {"user.message", "assistant.message", "tool.execution_start", "tool.execution_complete", "session.start", "session.resume",
                "session.compaction_complete", "session.shutdown", "session.model_change"}
COPILOT_IGNORED = {
    "hook.start", "hook.end", "assistant.turn_start", "assistant.turn_end", "session.usage_record", "session.usage_checkpoint",
    "permission.requested", "permission.completed", "model.turn_started", "model.model_call_started", "model.captured_assignment_context",
    "model.turn_ended", "model.model_call_success", "model.message", "model.response", "model.messages_snapshot", "external_tool.requested",
    "external_tool.completed", "session.auto_mode_resolved", "system.message", "session.binary_asset", "session.permissions_changed",
    "subagent.deselected", "skill.context_delivered_ref", "skill.invoked", "skill.invoked_ref", "system.notification", "session.compaction_start",
    "subagent.started", "subagent.configured", "subagent.selected",
}
PI_KEPT = {"message"}
PI_CONSUMED = {"session"}
PI_IGNORED = {"model_change", "thinking_level_change", "label", "custom", "custom_message"}


def known_ignored(harness: str) -> set[str]:
    """The record kinds a harness is known to write that the store does not keep (for the coverage of the unknown-record counter)."""
    return {
        "claude": CLAUDE_IGNORED,
        "codex": CODEX_IGNORED_TOP | {f"event_msg/{kind}" for kind in CODEX_EVENT_MSG_IGNORED},
        "copilot": COPILOT_IGNORED,
        "pi": PI_IGNORED,
    }[harness]


# ------------------------------------------------------------------------------------------------------------------ reading

@dataclass
class Line:
    offset: int
    end: int
    record: dict | None  # None: a line that is not a JSON object (counted as corrupt, never stops a pass)
    raw_len: int = 0


def read_lines(path: Path, start: int = 0):
    """Yield each complete line of <path> from byte <start>, with its offset. A last line without its newline is taken only when it
    parses whole (a record is complete when its object closes); otherwise it is left for the next pass, and the pass ends there.

    The generator's return value is the offset after the last line taken, read it from `StopIteration.value` or use `consume`.
    """
    consumed = start
    with open(path, "rb") as handle:
        handle.seek(start)
        offset = start
        for raw in handle:
            complete = raw.endswith(b"\n")
            text = raw.strip()
            record = None
            if text:
                try:
                    value = json.loads(text.decode("utf-8", errors="replace"))
                    record = value if isinstance(value, dict) else None
                except json.JSONDecodeError:
                    record = None
                    if not complete:
                        break  # the writer is mid-line: wait for the rest
            elif not complete:
                break
            end = offset + len(raw)
            yield Line(offset, end, record, len(raw))
            consumed = end
            offset = end
    return consumed


def consume(path: Path, start: int = 0) -> tuple[list[Line], int]:
    """read_lines as a list and the offset reached."""
    lines: list[Line] = []
    gen = read_lines(path, start)
    try:
        while True:
            lines.append(next(gen))
    except StopIteration as done:
        return lines, (done.value if done.value is not None else (lines[-1].end if lines else start))


# ------------------------------------------------------------------------------------------------------------------- helpers

def excerpt(text: str, limit: int = EXCERPT) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit]


def small_meta(record: dict, keys: tuple[str, ...]) -> dict:
    out = {}
    for key in keys:
        value = record.get(key)
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            out[key] = value if not isinstance(value, str) else value[:200]
    return out


def meta_json(meta: dict) -> str:
    text = json.dumps(meta, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    if len(text) > META_MAX:
        text = json.dumps({"truncated": True, "keys": sorted(meta)[:20]}, separators=(",", ":"))
    return text


def new_row(kind: str, offset: int, **fields) -> dict:
    row = {"kind": kind, "offset": offset, "uuid": None, "parent_uuid": None, "origin": None, "is_meta": 0, "is_sidechain": 0,
           "tool_use_id": None, "tool_name": None, "absorbed": 0, "starts_turn": 0, "at": None, "role": None, "text": None,
           "text_len": 0, "meta": "{}"}
    row.update(fields)
    return row


@dataclass
class Facts:
    """What one pass learned about a session from records that become no row."""

    cwd: str | None = None
    title: str | None = None
    account_uuid: str | None = None
    org_uuid: str | None = None
    first_at: float | None = None
    last_at: float | None = None
    session_id: str | None = None
    parent_thread: str | None = None
    ignored: dict = field(default_factory=dict)
    unknown: dict = field(default_factory=dict)
    corrupt: int = 0

    def note(self, at: float | None) -> None:
        if at is not None:
            if self.first_at is None or at < self.first_at:
                self.first_at = at
            if self.last_at is None or at > self.last_at:
                self.last_at = at

    def count(self, group: str, key: str) -> None:
        bucket = self.ignored if group == "ignored" else self.unknown
        bucket[key] = bucket.get(key, 0) + 1


def _result_blocks(blocks, steps_by_id: dict) -> tuple[list[dict], str]:
    """The tool_result blocks of a record as small dicts (id, failed, counts, the bounded output) and the text to keep as the row's
    excerpt. A step that touched a credential path (h) keeps no text at all: tool_steps.apply_result enforces that."""
    results, texts = [], []
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        tool_use_id = block.get("tool_use_id")
        known = steps_by_id.get(tool_use_id)
        if known is None:
            # No step for this call (its record is not in the store): nothing of its output is kept, because the rule that hides a
            # credential path's output lives in the step.
            results.append({"id": tool_use_id, "no_step": 1})
            continue
        step = dict(known)
        step.pop("out", None)
        tool_steps.apply_result(step, block)
        out = step.pop("out", "") or ""
        item = {"id": tool_use_id, **{k: step[k] for k in ("f", "t", "l", "z") if k in step}}
        if step.get("h"):
            item["h"] = 1
        results.append(item)
        if out:
            texts.append(out)
    return results, "\n".join(texts)


# --------------------------------------------------------------------------------------------------------------------- Claude

def claude_row(record: dict, offset: int, facts: Facts, steps_by_id: dict) -> dict | None:
    kind = record.get("type")
    at = bp.iso_to_epoch(record.get("timestamp"))
    facts.note(at)
    if isinstance(record.get("cwd"), str) and record["cwd"] and not facts.cwd:
        facts.cwd = record["cwd"]
    if kind == "session-owner":
        facts.account_uuid = record.get("accountUuid") or facts.account_uuid
        facts.org_uuid = record.get("organizationUuid") or facts.org_uuid
        return None
    if kind == "bridge-session":
        facts.account_uuid = facts.account_uuid or record.get("ownerAccountUuid")
        facts.org_uuid = facts.org_uuid or record.get("ownerOrganizationUuid")
        return None
    if kind in ("ai-title", "custom-title", "agent-name"):
        value = record.get("aiTitle") or record.get("customTitle") or record.get("agentName")
        if isinstance(value, str) and value.strip() and (kind != "ai-title" or not facts.title):
            facts.title = value.strip()[:200]
        return None
    if kind in CLAUDE_IGNORED:
        facts.count("ignored", f"claude:{kind}")
        return None
    common = dict(uuid=record.get("uuid"), parent_uuid=record.get("parentUuid"), at=at,
                  is_meta=int(bool(record.get("isMeta"))), is_sidechain=int(bool(record.get("isSidechain"))))
    origin = record.get("origin")
    if isinstance(origin, dict):
        common["origin"] = origin.get("kind")
    meta = small_meta(record, ("sessionId", "requestId", "promptId", "permissionMode", "gitBranch", "entrypoint", "version", "userType",
                               "slug", "agentId", "sourceToolAssistantUUID", "sourceToolUseID", "isCompactSummary",
                               "isVisibleInTranscriptOnly", "subtype", "level"))
    if kind == "user":
        content = (record.get("message") or {}).get("content")
        if bp.is_tool_result(record):
            results, text = _result_blocks(content, steps_by_id)
            meta["results"] = results
            first = results[0]["id"] if results else None
            return new_row("user", offset, role="tool_result", tool_use_id=first, text=excerpt(text, bp.tool_steps.OUTPUT_CHARS),
                           text_len=len(text), meta=meta_json(meta), **common)
        text = bp.block_text(content)
        return new_row("user", offset, role="user", text=excerpt(text), text_len=len(text), meta=meta_json(meta), **common)
    if kind == "assistant":
        content = (record.get("message") or {}).get("content")
        texts, tools = [], []
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and (block.get("text") or "").strip():
                texts.append(block["text"])
            elif block.get("type") == "tool_use":
                step = tool_steps.make_step(block, at, 0)
                tool_use_id = block.get("id") if isinstance(block.get("id"), str) else None
                if tool_use_id:
                    steps_by_id[tool_use_id] = step
                tools.append({"id": tool_use_id, "name": block.get("name") or "tool"})
        if tools:
            meta["tools"] = tools
        text = "\n\n".join(texts)
        model = (record.get("message") or {}).get("model")
        if isinstance(model, str):
            meta["model"] = model
        first = tools[0] if tools else {}
        return new_row("assistant", offset, role="assistant", tool_use_id=first.get("id"), tool_name=first.get("name"),
                       text=excerpt(text), text_len=len(text), meta=meta_json(meta), **common)
    if kind == "attachment":
        attachment = record.get("attachment") if isinstance(record.get("attachment"), dict) else {}
        sub = attachment.get("type")
        if sub in CLAUDE_ATTACHMENT_KEPT:
            prompt = attachment.get("prompt")
            text = prompt if isinstance(prompt, str) else bp.block_text(prompt)
            origin = attachment.get("origin") if isinstance(attachment.get("origin"), dict) else {}
            return new_row("attachment", offset, role="queued", text=excerpt(text), text_len=len(text),
                           meta=meta_json({**meta, "attachment": sub}), **{**common, "origin": origin.get("kind")})
        facts.count("ignored", f"claude:attachment/{sub}" if sub in CLAUDE_ATTACHMENT_IGNORED else "claude:attachment/other")
        if sub not in CLAUDE_ATTACHMENT_IGNORED:
            facts.count("unknown", f"claude:attachment/{sub}")
        return None
    if kind == "system":
        text = record.get("content") if isinstance(record.get("content"), str) else ""
        return new_row("system", offset, role="system", text=excerpt(text, 200), text_len=len(text), meta=meta_json(meta), **common)
    # Unknown to this code: kept as a bare row, counted.
    facts.count("unknown", f"claude:{kind}")
    return new_row(str(kind), offset, uuid=record.get("uuid"), parent_uuid=record.get("parentUuid"), at=at,
                   meta=meta_json({"unknown": True, "keys": sorted(record)[:30]}))


# --------------------------------------------------------------------------------------------------------------------- Codex

def codex_row(record: dict, offset: int, facts: Facts, steps_by_id: dict) -> dict | None:
    top = record.get("type")
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    at = bp.iso_to_epoch(record.get("timestamp") or payload.get("timestamp"))
    facts.note(at)
    if top == "session_meta":
        if isinstance(payload.get("cwd"), str) and not facts.cwd:
            facts.cwd = payload["cwd"]
        facts.session_id = payload.get("id") or payload.get("session_id") or facts.session_id
        facts.parent_thread = payload.get("parent_thread_id") or facts.parent_thread
        facts.account_uuid = payload.get("creator_account_id") or facts.account_uuid
        return None
    if top == "event_msg":
        sub = payload.get("type")
        facts.count("ignored" if sub in CODEX_EVENT_MSG_IGNORED else "unknown", f"codex:event_msg/{sub}")
        return None
    if top in CODEX_IGNORED_TOP:
        facts.count("ignored", f"codex:{top}")
        return None
    if top != "response_item":
        facts.count("unknown", f"codex:{top}")
        return new_row(str(top), offset, at=at, meta=meta_json({"unknown": True, "keys": sorted(record)[:30]}))
    sub = payload.get("type")
    meta = small_meta(payload, ("role", "status", "name", "call_id", "id"))
    if sub == "message":
        text = bp.codex_record_text(payload.get("content"))
        return new_row("response_item", offset, role=payload.get("role"), uuid=payload.get("id"), at=at, text=excerpt(text),
                       text_len=len(text), meta=meta_json({**meta, "payload": sub}))
    if sub == "reasoning":
        text = bp.codex_summary_text(payload.get("summary"))
        return new_row("response_item", offset, role="reasoning", at=at, text=excerpt(text), text_len=len(text), meta=meta_json({**meta, "payload": sub}))
    if sub in ("custom_tool_call", "function_call"):
        call_id = payload.get("call_id") or payload.get("id")
        raw_input = payload.get("input") if sub == "custom_tool_call" else payload.get("arguments")
        name = "Bash" if payload.get("name") == "exec" else payload.get("name") or "tool"
        step = tool_steps.make_step({"name": name, "input": bp.codex_tool_input(raw_input), "id": call_id}, at, 0)
        if isinstance(call_id, str):
            steps_by_id[call_id] = step
        return new_row("response_item", offset, role="tool_call", tool_use_id=call_id if isinstance(call_id, str) else None, tool_name=name,
                       at=at, meta=meta_json({**meta, "payload": sub}))
    if sub in ("custom_tool_call_output", "function_call_output"):
        call_id = payload.get("call_id")
        known = steps_by_id.get(call_id)
        out, item = "", {"id": call_id, "no_step": 1}
        if known is not None:
            step = dict(known)
            step.pop("out", None)
            tool_steps.apply_result(step, {"content": bp.codex_output_text(payload.get("output")), "is_error": payload.get("status") == "failed"})
            out = step.pop("out", "") or ""
            item = {"id": call_id, **{k: step[k] for k in ("f", "t", "l", "z") if k in step}}
            if step.get("h"):
                item["h"] = 1
        return new_row("response_item", offset, role="tool_result", tool_use_id=call_id if isinstance(call_id, str) else None, at=at,
                       text=excerpt(out, tool_steps.OUTPUT_CHARS), text_len=len(out), meta=meta_json({**meta, "payload": sub, "results": [item]}))
    if sub in CODEX_RESPONSE_KEPT:
        return new_row("response_item", offset, role=sub, at=at, meta=meta_json({**meta, "payload": sub}))
    facts.count("unknown", f"codex:response_item/{sub}")
    return new_row("response_item", offset, at=at, meta=meta_json({"unknown": True, "payload": sub}))


# ------------------------------------------------------------------------------------------------------------------- Copilot

def copilot_step(name, arguments, at, cwd: str) -> dict:
    """One step for a Copilot tool call (a patch makes several blocks): the first block's step, hidden when any block's is."""
    blocks = bp.copilot_tool_blocks(name, arguments, cwd)
    steps = [tool_steps.make_step(block, at, 0) for block in blocks]
    step = dict(steps[0])
    if any(item.get("h") for item in steps):
        step["h"] = 1
    return step


def copilot_row(record: dict, offset: int, facts: Facts, steps_by_id: dict) -> dict | None:
    kind = record.get("type")
    data = record.get("data") if isinstance(record.get("data"), dict) else {}
    at = bp.iso_to_epoch(record.get("timestamp"))
    facts.note(at)
    if kind in ("session.start", "session.resume"):
        context = data.get("context") if isinstance(data.get("context"), dict) else {}
        if isinstance(context.get("cwd"), str) and context["cwd"]:
            facts.cwd = facts.cwd or context["cwd"]
        facts.session_id = data.get("sessionId") or facts.session_id
    if kind in COPILOT_IGNORED:
        facts.count("ignored", f"copilot:{kind}")
        return None
    if kind not in COPILOT_KEPT:
        facts.count("unknown", f"copilot:{kind}")
        return new_row(str(kind), offset, uuid=record.get("id"), parent_uuid=record.get("parentId"), at=at,
                       meta=meta_json({"unknown": True, "keys": sorted(record)[:30]}))
    common = dict(uuid=record.get("id"), parent_uuid=record.get("parentId"), at=at)
    is_helper = bool(record.get("agentId") or data.get("parentToolCallId"))
    meta = {"agent": record.get("agentId")} if record.get("agentId") else {}
    if kind == "user.message":
        text = data.get("content") if isinstance(data.get("content"), str) else ""
        meta["delivery"] = data.get("delivery")
        meta["messageId"] = data.get("messageId")
        return new_row(kind, offset, role="user", text=excerpt(text), text_len=len(text), meta=meta_json(meta), is_sidechain=int(is_helper), **common)
    if kind == "assistant.message":
        text = data.get("content") if isinstance(data.get("content"), str) else ""
        tools = []
        for request in data.get("toolRequests") or []:
            if isinstance(request, dict):
                tools.append({"id": request.get("toolCallId"), "name": request.get("name")})
                if isinstance(request.get("toolCallId"), str) and request["toolCallId"] not in steps_by_id:
                    steps_by_id[request["toolCallId"]] = copilot_step(request.get("name"), request.get("arguments"), at, facts.cwd or "")
        if tools:
            meta["tools"] = tools
        first = tools[0] if tools else {}
        return new_row(kind, offset, role="assistant", tool_use_id=first.get("id"), tool_name=first.get("name"), text=excerpt(text),
                       text_len=len(text), meta=meta_json(meta), is_sidechain=int(is_helper), **common)
    if kind == "tool.execution_start":
        if isinstance(data.get("toolCallId"), str) and data["toolCallId"] not in steps_by_id:
            steps_by_id[data["toolCallId"]] = copilot_step(data.get("toolName"), data.get("arguments"), at, facts.cwd or "")
        return new_row(kind, offset, role="tool_call", tool_use_id=data.get("toolCallId"), tool_name=data.get("toolName"),
                       meta=meta_json(meta), is_sidechain=int(is_helper), **common)
    if kind == "tool.execution_complete":
        result = data.get("result") if isinstance(data.get("result"), dict) else {}
        output = result.get("content") if isinstance(result.get("content"), str) else ""
        known = steps_by_id.get(data.get("toolCallId"))
        out = ""
        if known is None:
            meta["no_step"] = 1  # no step for this call: nothing of its output is kept (the credential-path rule lives in the step)
        else:
            step = dict(known)
            step.pop("out", None)
            tool_steps.apply_result(step, {"content": output, "is_error": data.get("success") is False})
            out = step.pop("out", "") or ""
            if step.get("h"):
                meta["h"] = 1
        return new_row(kind, offset, role="tool_result", tool_use_id=data.get("toolCallId"), text=excerpt(out, tool_steps.OUTPUT_CHARS),
                       text_len=len(out), meta=meta_json(meta), is_sidechain=int(is_helper), **common)
    return new_row(kind, offset, role="system", meta=meta_json(meta), is_sidechain=int(is_helper), **common)


# ----------------------------------------------------------------------------------------------------------------------- Pi

def pi_row(record: dict, offset: int, facts: Facts, steps_by_id: dict) -> dict | None:
    kind = record.get("type")
    at = bp.iso_to_epoch(record.get("timestamp"))
    facts.note(at)
    if kind == "session":
        if isinstance(record.get("cwd"), str):
            facts.cwd = facts.cwd or record["cwd"]
        facts.session_id = record.get("id") or facts.session_id
        return None
    if kind == "message":
        message = record.get("message") if isinstance(record.get("message"), dict) else {}
        content = message.get("content")
        role = message.get("role")
        # A tool result's text is never kept for Pi: the credential-path rule needs the call's step, and Pi's results do not name their call.
        text = "" if role in ("toolResult", "tool_result", "tool") else bp.block_text(content)
        tools = []
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict) and block.get("type") in ("toolCall", "tool_use"):
                tools.append({"id": block.get("id"), "name": block.get("name")})
        meta = {"tools": tools} if tools else {}
        first = tools[0] if tools else {}
        return new_row("message", offset, uuid=record.get("id"), parent_uuid=record.get("parentId"), role=role, at=at,
                       tool_use_id=first.get("id"), tool_name=first.get("name"), text=excerpt(text), text_len=len(text), meta=meta_json(meta))
    if kind in PI_IGNORED:
        facts.count("ignored", f"pi:{kind}")
        return None
    facts.count("unknown", f"pi:{kind}")
    return new_row(str(kind), offset, uuid=record.get("id"), parent_uuid=record.get("parentId"), at=at,
                   meta=meta_json({"unknown": True, "keys": sorted(record)[:30]}))


ROW_FUNCTIONS = {"claude": claude_row, "codex": codex_row, "copilot": copilot_row, "pi": pi_row}
