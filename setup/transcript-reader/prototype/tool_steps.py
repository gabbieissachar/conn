"""The tool steps of a turn: what the agent ran, read, edited, wrote or asked, one small record per tool call.

build_prototype.session_exchanges calls make_step for each tool_use block and apply_result for each tool_result
block, so a turn carries `steps` (the page's grouped list and step sheet read them). Option a of the tool-step
decision (README, "Tool steps"): the summary, the command and a failed step's last 400 characters travel with the
turn; the output text travels apart, in one object per conversation the page fetches when a step is opened
(take_outputs moves it out of the turns); the text of a file the agent read never travels at all.

A step is a dict with short keys (there are tens of thousands of them, so the names are kept short):

  k    kind: ran, read, edited, wrote, searched, asked, agent, skill or other
  n    the tool's name as the log has it
  s    one line saying what it did (at most SUMMARY_CHARS): the agent's own description of a command, else the
       command's first line; a path, a pattern, a URL or a question
  c    the command or input as the sheet shows it, up to COMMAND_CHARS (absent for a read, an edit and a write)
  p    the file a read, edit or write named
  at   when the call was made (epoch seconds)
  o    how many of the turn's working notes came before it (the page shows the notes between groups of steps)
  f    1 when the call failed
  t    a failed step's last FAIL_TAIL characters of output
  l, z lines and characters of the whole output (counts only)
  a, r lines an edit or write added and removed
  d    the edit or write as a diff, "+" added, "-" removed, " " kept, "~" a gap, at most DIFF_CHARS; x is 1 when cut
  h    1 when the call touched a dotfile or a credential path: the row stays, nothing of its text is kept
  out  the output text (at most OUTPUT_CHARS), only until take_outputs moves it out of the turn

Copilot's `apply_patch` call carries its whole patch as one string; patch_blocks turns it into the same Write and MultiEdit
inputs a Claude edit has, so its steps and diffs are drawn by the code above.

Only `message.content` of a tool_result record is read. Its `toolUseResult` is a second copy of the same output
(about a fifth of a log's size) and is never looked at.
"""

from __future__ import annotations

import difflib
import json
import re

SUMMARY_CHARS = 140
COMMAND_CHARS = 600
FAIL_TAIL = 400
OUTPUT_CHARS = 1500
DIFF_CHARS = 1500
CONTEXT_LINES = 2

KINDS = {
    "Bash": "ran", "BashOutput": "ran", "KillShell": "ran", "KillBash": "ran",
    "Read": "read",
    "Edit": "edited", "MultiEdit": "edited", "NotebookEdit": "edited",
    "Write": "wrote",
    "Grep": "searched", "Glob": "searched", "LS": "searched", "WebSearch": "searched", "WebFetch": "searched", "ToolSearch": "searched",
    "Agent": "agent", "Task": "agent",
    "Skill": "skill",
    "AskUserQuestion": "asked",
}

# A path whose text is never kept: a dotfile (.env, .npmrc, .gitignore), anything under a folder that holds credentials,
# or a file named like one.
CREDENTIAL_DIRS = {".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".gcloud", ".config", ".secrets", ".password-store"}
CREDENTIAL_NAME = re.compile(r"(?i)^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx)|.*(?:credential|secret|token|passw(?:or)?d)s?[^/]*)$")
DOTFILE_NAME = re.compile(r"^\.[A-Za-z0-9_][A-Za-z0-9_.-]*$")  # .env, .npmrc, .lock-session: not .*run, .., ... or a bare method call
# A word in a command that is a dotfile by its look: starts with a dot and a letter, digit or underscore, stands alone (not after a word, a
# closing bracket, a dot, a dollar, a hyphen, a slash or a glob star: `f.read`, `open(x).read`, `x[0].name`, `*.md`, `a/.b`) and is no call or index
# (`.get(`, `.items[`). A file extension on its own (`'.md'`, `".json"`) is not a dotfile.
BARE_DOTFILE = re.compile(r"(?<![\w)\]}./$*?-])\.[A-Za-z0-9_][A-Za-z0-9_.-]*(?![\w(\[])")
EXTENSIONS = {"md", "json", "jsonl", "sh", "py", "js", "cjs", "mjs", "ts", "tsx", "jsx", "html", "css", "png", "jpg", "jpeg", "gif", "svg", "sql", "txt", "log",
              "msg", "meta", "status", "reply", "yml", "yaml", "toml", "csv", "lock", "pdf", "xml", "ini", "cfg", "conf", "tmp", "bak", "diff", "patch", "zip"}
COMMAND_PARTS = re.compile(r"&&|\|\||[;|\n]")  # the commands a line chains
FILTER_TOOL = re.compile(r"(?:^|[\s|;&(])(?:jq|yq|gojq)\b")  # a jq or yq filter (`.items`) names no file
KNOWN_DOTFILES = re.compile(r"^\.(?:env(?:\..*)?|npmrc|netrc|pypirc|git-credentials|gitconfig|bashrc|bash_profile|zshrc|zprofile|profile|aws|ssh|gnupg|kube|docker|azure|gcloud|config|secrets|password-store)$")
PATH_TOKEN = re.compile(r"[^\s'\"=:;|&<>()`,]+")
FILE_EXTENSION = re.compile(r"\.[A-Za-z0-9]{1,8}$")


def squash(text: str) -> str:
    return " ".join(text.split())


def clip(text: str, limit: int) -> str:
    """The start of <text>, cut to <limit> characters with an ellipsis."""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def tail(text: str, limit: int) -> str:
    """The end of <text>, cut to <limit> characters, starting on a whole line after an ellipsis line: the error of a command is
    at the end of its output."""
    if len(text) <= limit:
        return text
    rest = text[-(limit - 2):]
    line = rest.find("\n")
    return "…\n" + (rest[line + 1:] if 0 <= line < len(rest) - 1 else rest)


def head(text: str, limit: int) -> str:
    """The start of <text>, cut to <limit> characters at the end of a whole line, then an ellipsis line."""
    if len(text) <= limit:
        return text
    kept = text[: limit - 2]
    line = kept.rfind("\n")
    return (kept[:line] if line > 0 else kept) + "\n…"


def sensitive_path(path: str) -> bool:
    parts = [part for part in path.replace("\\", "/").split("/") if part and part not in (".", "..", "~")]
    if not parts:
        return False
    if parts[-1].startswith(".") or any(part in CREDENTIAL_DIRS for part in parts[:-1]):
        return True
    return bool(CREDENTIAL_NAME.match(parts[-1]))


def command_path_is_sensitive(token: str) -> bool:
    """Whether one word of a shell command names a dotfile or a credential path. A word with a slash is a path: a
    dotfile name (`.env`, `state/.lock-session`), a file in a folder that holds credentials (`~/.ssh/id_rsa`) or one
    named like one. A word with no slash only counts here when it is a well-known dotfile (`.env`) or a file named like a
    credential with an extension (`credentials.json`); any other bare dotfile name is found by BARE_DOTFILE in
    touches_secrets, which sees what stands around it (a method call (`f.read()`), a regular expression (`.*run`) and a
    jq path (`.items`) are not files)."""
    parts = [part for part in token.replace("\\", "/").split("/") if part and part not in (".", "..", "~")]
    if not parts:
        return False
    name = parts[-1]
    if "/" in token:
        return bool(DOTFILE_NAME.match(name)) or any(part in CREDENTIAL_DIRS for part in parts[:-1]) or bool(CREDENTIAL_NAME.match(name))
    return bool(KNOWN_DOTFILES.match(name)) or bool(FILE_EXTENSION.search(name) and CREDENTIAL_NAME.match(name))


def touches_secrets(command: str) -> bool:
    """Whether a shell command names a dotfile or a credential path (it may print one)."""
    for token in PATH_TOKEN.findall(command):
        if token.startswith("-") or "://" in token and "/." not in token:
            continue
        if command_path_is_sensitive(token):
            return True
    # A dotfile named on its own (`cat .secrets`): any such word, except in the part of a command that filters with jq or yq, where `.items`
    # is a path into the data and only a well-known dotfile (above) still counts.
    return any(m.group(0)[1:].lower() not in EXTENSIONS for part in COMMAND_PARTS.split(command) if not FILTER_TOOL.search(part) for m in BARE_DOTFILE.finditer(part))


def short_path(path: str) -> str:
    parts = path.split("/")
    return path if len(parts) <= 4 else "…/" + "/".join(parts[-3:])


def line_count(text: str) -> int:
    return len(text.splitlines()) if text else 0


def mcp_label(name: str) -> str:
    parts = name.split("__")
    server = (parts[1] if len(parts) > 1 else "").removeprefix("claude_ai_").removeprefix("plugin_").replace("_", " ")
    tool = (parts[2] if len(parts) > 2 else name).replace("_", " ")
    return f"{server}: {tool}" if server else tool


def compact(value) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return ""


# ------------------------------------------------------------------ diffs

def diff_lines(old: str, new: str) -> tuple[list[str], int, int]:
    """The lines of an edit as a diff with CONTEXT_LINES of unchanged text around each change, and how many lines it
    added and removed."""
    before, after = old.split("\n"), new.split("\n")
    if len(before) * len(after) > 2_000_000:
        ops = [("replace", 0, len(before), 0, len(after))]
    else:
        ops = difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes()
    if all(tag == "equal" for tag, *_ in ops):
        return [], 0, 0
    lines, added, removed = [], 0, 0
    last = len(ops) - 1
    for index, (tag, i1, i2, j1, j2) in enumerate(ops):
        if tag == "equal":
            kept = before[i1:i2]
            if index == 0:
                head, gap = kept[-CONTEXT_LINES:], len(kept) > CONTEXT_LINES
                lines += (["~"] if gap else []) + [" " + line for line in head]
            elif index == last:
                lines += [" " + line for line in kept[:CONTEXT_LINES]] + (["~"] if len(kept) > CONTEXT_LINES else [])
            elif len(kept) <= 2 * CONTEXT_LINES:
                lines += [" " + line for line in kept]
            else:
                lines += [" " + line for line in kept[:CONTEXT_LINES]] + ["~"] + [" " + line for line in kept[-CONTEXT_LINES:]]
            continue
        removed += i2 - i1
        added += j2 - j1
        lines += ["-" + line for line in before[i1:i2]] + ["+" + line for line in after[j1:j2]]
    return lines, added, removed


def cut_lines(lines: list[str], limit: int = DIFF_CHARS) -> tuple[str, bool]:
    """The lines joined, stopping before the one that would pass <limit> characters; whether any were left out."""
    kept, size = [], 0
    for line in lines:
        if size + len(line) + 1 > limit and kept:
            return "\n".join(kept), True
        kept.append(line[:limit])
        size += len(line) + 1
    return "\n".join(kept), False


def edit_pairs(name: str, tool_input: dict) -> list[tuple[str, str]]:
    if name == "MultiEdit":
        return [(str(e.get("old_string") or ""), str(e.get("new_string") or "")) for e in tool_input.get("edits") or [] if isinstance(e, dict)]
    if name == "NotebookEdit":
        return []
    return [(str(tool_input.get("old_string") or ""), str(tool_input.get("new_string") or ""))]


# ------------------------------------------------------------------ Copilot patches

PATCH_FILE = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+?)\s*$")


def patch_blocks(patch: str, cwd: str = "") -> list[dict]:
    """The tool_use blocks (name and input, as a Claude edit has them) of a Copilot `apply_patch` string.

    The patch is `*** Begin Patch`, then for each file `*** Add File: path` (every line `+text`), `*** Update File: path`
    (hunks of ` kept`, `-removed` and `+added` lines, each hunk opened by an `@@` line, and optionally `*** Move to: path`) or
    `*** Delete File: path`, then
    `*** End Patch`. An added file is a Write, an updated one a MultiEdit with one edit per hunk, a deleted one a Delete.
    A relative path starts from <cwd>. Text that is no patch gives no block.
    """
    blocks: list[dict] = []
    current: dict | None = None
    hunk: dict | None = None

    def place(path: str) -> str:
        path = path.strip()
        return path if path.startswith("/") or not cwd else cwd.rstrip("/") + "/" + path

    def close() -> None:
        nonlocal current, hunk
        if current is None:
            return
        if current["name"] == "Write":
            current["input"]["content"] = "\n".join(current.pop("lines"))
        elif current["name"] == "MultiEdit":
            current["input"]["edits"] = [{"old_string": "\n".join(h["old"]), "new_string": "\n".join(h["new"])} for h in current.pop("hunks")]
        else:
            current.pop("lines", None)
        blocks.append(current)
        current, hunk = None, None

    for line in patch.splitlines():
        head = PATCH_FILE.match(line)
        if head:
            close()
            action, path = head.group(1), place(head.group(2))
            if action == "Add":
                current = {"name": "Write", "input": {"file_path": path}, "lines": []}
            elif action == "Update":
                current = {"name": "MultiEdit", "input": {"file_path": path}, "hunks": []}
            else:
                current = {"name": "Delete", "input": {"file_path": path}}
            continue
        if current is not None and current["name"] == "MultiEdit" and line.startswith("*** Move to:"):
            current["input"]["move_to"] = place(line[len("*** Move to:"):])  # kept so make_step checks it as it checks the source
            continue
        if current is None or line.startswith(("*** Begin Patch", "*** End Patch", "*** End of File", "*** Move to:")):
            if line.startswith("*** End Patch"):
                close()
            continue
        if current["name"] == "Write":
            current["lines"].append(line[1:] if line.startswith("+") else line)
        elif current["name"] == "MultiEdit":
            if line.startswith("@@") or hunk is None:
                hunk = {"old": [], "new": []}
                current["hunks"].append(hunk)
                if line.startswith("@@"):
                    continue
            if line.startswith("-"):
                hunk["old"].append(line[1:])
            elif line.startswith("+"):
                hunk["new"].append(line[1:])
            else:  # a kept line: a space and its text, or a bare empty line
                kept = line[1:] if line.startswith(" ") else line
                hunk["old"].append(kept)
                hunk["new"].append(kept)
    close()
    return blocks


# ------------------------------------------------------------------ steps

def summary_of(kind: str, name: str, tool_input: dict) -> tuple[str, str]:
    """(one line, the longer input the sheet shows) for a call."""
    get = lambda *keys: next((str(tool_input[key]) for key in keys if isinstance(tool_input.get(key), (str, int, float)) and str(tool_input[key]).strip()), "")  # noqa: E731
    if name == "Bash":
        command = get("command")
        line = squash(get("description")) or squash(next((l for l in command.splitlines() if l.strip()), ""))
        return line, command
    if name == "BashOutput":
        return "Check a background command", get("bash_id")
    if name in ("KillShell", "KillBash"):
        return "Stop a background command", get("shell_id", "bash_id")
    if kind in ("read", "edited", "wrote"):
        return short_path(get("file_path", "notebook_path", "path")), ""
    if name == "Delete":
        return "Delete " + short_path(get("file_path")), ""
    if name == "Grep":
        pattern, where = get("pattern"), get("path")
        return pattern + (f" in {short_path(where)}" if where else ""), pattern
    if name in ("Glob", "LS"):
        pattern = get("pattern", "path")
        where = get("path") if name == "Glob" else ""
        return pattern + (f" in {short_path(where)}" if where else ""), pattern
    if name == "WebSearch":
        return get("query"), get("query")
    if name == "WebFetch":
        return get("url"), get("url") + (f"\n{get('prompt')}" if get("prompt") else "")
    if name == "ToolSearch":
        return get("query"), get("query")
    if kind == "agent":
        return squash(get("description")) or get("subagent_type") or "Run a helper agent", get("prompt")
    if kind == "skill":
        return squash(get("skill") + (" " + get("args") if get("args") else "")), get("args")
    if name == "AskUserQuestion":
        first = (tool_input.get("questions") or [{}])[0] if isinstance(tool_input.get("questions"), list) else {}
        question = squash(str(first.get("question") or "")) if isinstance(first, dict) else ""
        return question or "Ask a question", compact(tool_input)
    if name.startswith("mcp__"):
        return mcp_label(name), compact(tool_input) if tool_input else ""
    return name, compact(tool_input) if tool_input else ""


def make_step(block: dict, at: float | None, notes: int) -> dict:
    """The step a tool_use block makes, with <notes> working notes before it."""
    name = str(block.get("name") or "tool")
    tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
    kind = KINDS.get(name) or ("asked" if name.startswith("mcp__") else "other")
    line, command = summary_of(kind, name, tool_input)
    step: dict = {"k": kind, "n": name, "s": clip(squash(line) or name, SUMMARY_CHARS), "at": round(at) if at else 0, "o": notes}
    if command:
        step["c"] = clip(command, COMMAND_CHARS)
    path = next((str(tool_input[key]) for key in ("file_path", "notebook_path") if isinstance(tool_input.get(key), str) and tool_input[key]), "")
    if not path and kind == "read" and isinstance(tool_input.get("path"), str):
        path = tool_input["path"]
    if path:
        step["p"] = path
    # move_to is where a patch moves the file it updates: either end being a dotfile or credential path hides the step.
    paths = [str(tool_input[key]) for key in ("file_path", "notebook_path", "path", "move_to") if isinstance(tool_input.get(key), str) and tool_input[key]]
    if any(sensitive_path(p) for p in paths) or (name == "Bash" and touches_secrets(command)):
        step["h"] = 1
        return step  # the row says what it touched; no diff, and apply_result keeps none of its output
    if kind == "edited":
        lines, added, removed = [], 0, 0
        for old, new in edit_pairs(name, tool_input):
            part, a, r = diff_lines(old, new)
            lines += (["~"] if lines and part else []) + part
            added, removed = added + a, removed + r
        if lines:
            step["a"], step["r"] = added, removed
            step["d"], cut = cut_lines(lines)
            if cut:
                step["x"] = 1
    elif kind == "wrote":
        content = str(tool_input.get("content") or "")
        step["a"] = line_count(content)
        text, cut = cut_lines(["+" + line for line in content.splitlines()])
        if text:
            step["d"] = text
        if cut:
            step["x"] = 1
    return step


def result_text(content) -> str:
    """The text of a tool_result's content (a string, or text blocks). Never the record's `toolUseResult`."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(item.get("text") or "") for item in content if isinstance(item, dict) and item.get("type") == "text")
    return ""


def apply_result(step: dict, block: dict) -> None:
    """Record what a tool_result block says about its step: whether it failed, how long the output was, a failed
    step's tail and the output text (not for a file read, a step that touched a dotfile or credential path, or an edit
    or write that worked: their text is the file's, or only a confirmation)."""
    text = result_text(block.get("content"))
    failed = block.get("is_error") is True
    if failed:
        step["f"] = 1
    if step["k"] in ("edited", "wrote") and not failed:
        return  # only a confirmation: the diff is the call's own input
    if text:
        step["l"], step["z"] = line_count(text), len(text)
    if not text or step.get("h") or step["k"] == "read":
        return
    if failed:
        step["t"] = tail(text.strip(), FAIL_TAIL)
    step["out"] = tail(text.rstrip(), OUTPUT_CHARS) if step["k"] == "ran" or failed else head(text.rstrip(), OUTPUT_CHARS)


def step_key(exchange: dict, index: int) -> str:
    return f"{exchange.get('uid')}:{index}"


def take_outputs(exchanges: list[dict]) -> dict[str, str]:
    """Move every step's output text out of the turns (the page and the conversation object never hold it) and give it
    back by the step's key, "<turn id>:<n>"."""
    taken: dict[str, str] = {}
    for exchange in exchanges:
        for index, step in enumerate(exchange.get("steps") or []):
            text = step.pop("out", None)
            if text:
                taken[step_key(exchange, index)] = text
    return taken
