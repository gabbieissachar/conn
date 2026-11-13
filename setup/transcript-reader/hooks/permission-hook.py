#!/usr/bin/env python3
"""Claude Code's PermissionRequest hook for the transcript reader: the ask goes to the reader page, and its answer comes back here.

  permission-hook.py hook                     what Claude Code runs (stdin: the hook's JSON; stdout: its decision, or nothing)
  permission-hook.py install   --config-dir D [--apply] [--timeout S]    add this hook to D/settings.json (a dry run unless --apply)
  permission-hook.py uninstall --config-dir D [--apply]                  take it out again
  permission-hook.py status    --config-dir D                            whether D's settings.json has it

`hook` fails open on everything. With no output and exit code 0 Claude Code shows its own dialog, so a reader that is not running, a page
nobody has open, a session the reader does not list, an input too big to show whole, a timeout or any error here all leave the dialog in
the pane exactly as it is without this hook. It never exits 2 (which would deny) and it never prints anything but the decision JSON.

The reader (permissions.js) tells this hook where it listens in a small owner-only file, ~/.config/pmos-transcript-reader/permission-hook.json
(PMOS_READER_HOOK_FILE names another one): { port, key, pid }. The key is for this one route and opens nothing else. The hook posts the ask to
127.0.0.1 only, holds the call while the reader's page waits for the person, and prints Claude Code's own JSON for the answer:

  allow  {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}
  deny   {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "...", "interrupt": true}}}

No standing permission is ever returned (no updatedPermissions): the dialog's "don't ask again" stays in the pane.

`install` only edits the settings.json of the folder it is given, after a dated copy beside it, keeps every other key and hook, and adds
one PermissionRequest group with this command. It prints what it would change and writes nothing without --apply.
"""

from __future__ import annotations

import argparse
import datetime
import http.client
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROUTE = "/api/transcript-reader/permission-ask"
HOOK_HEADER = "x-transcript-reader-hook"
DEFAULT_TIMEOUT = 660           # seconds Claude Code lets this hook run (settings.json "timeout"); the reader holds a call for 600
MAX_STDIN = 1024 * 1024
MARK = "permission-hook.py"


def hook_file() -> str:
    return os.environ.get("PMOS_READER_HOOK_FILE") or os.path.join(os.path.expanduser("~"), ".config", "pmos-transcript-reader", "permission-hook.json")


def read_server():
    try:
        with open(hook_file(), encoding="utf-8") as handle:
            record = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    port, key, pid = record.get("port"), record.get("key"), record.get("pid")
    if not (isinstance(port, int) and 0 < port < 65536 and isinstance(key, str) and key and isinstance(pid, int) and pid > 0):
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    return port, key


def decision_json(answer: dict):
    kind = answer.get("decision")
    if kind == "allow":
        return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}
    if kind == "deny":
        message = answer.get("message") if isinstance(answer.get("message"), str) else "The person denied this from the transcript reader."
        return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": message[:500], "interrupt": bool(answer.get("interrupt", True))}}}
    return None


def run_hook() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN + 1)
        if len(raw) > MAX_STDIN:
            return 0
        payload = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return 0
    if not isinstance(payload, dict) or payload.get("hook_event_name") != "PermissionRequest":
        return 0
    server = read_server()
    if not server:
        return 0
    port, key = server
    try:
        wait = max(5.0, float(os.environ.get("PMOS_READER_HOOK_WAIT", DEFAULT_TIMEOUT - 30)))
    except ValueError:
        wait = DEFAULT_TIMEOUT - 30
    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=wait)
        body = json.dumps(payload).encode("utf-8")
        # No Origin and no Sec-Fetch headers: the route refuses a request that carries either, so a web page cannot reach it.
        connection.request("POST", ROUTE, body=body, headers={"Content-Type": "application/json", "Content-Length": str(len(body)), HOOK_HEADER: key})
        response = connection.getresponse()
        data = response.read(64 * 1024)
        if response.status != 200:
            return 0
        answer = json.loads(data.decode("utf-8"))
    except Exception:  # any failure leaves the dialog in the pane
        return 0
    if not isinstance(answer, dict):
        return 0
    out = decision_json(answer)
    if out is None:
        return 0
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
    return 0


# ------------------------------------------------------------------------------------------------------------------------ install

def command_line() -> str:
    return f"python3 -I {os.path.join(HERE, MARK)} hook"


def load_settings(config_dir: str):
    path = os.path.join(config_dir, "settings.json")
    if not os.path.exists(path):
        return path, {}
    with open(path, encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise SystemExit(f"{path} is not a JSON object; nothing was changed.")
    return path, value


def has_hook(settings: dict) -> bool:
    groups = (settings.get("hooks") or {}).get("PermissionRequest") or []
    return any(MARK in str(h.get("command", "")) for g in groups if isinstance(g, dict) for h in g.get("hooks", []) if isinstance(h, dict))


def with_hook(settings: dict, timeout: int) -> dict:
    out = json.loads(json.dumps(settings))
    hooks = out.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise SystemExit("settings.json has a hooks entry that is not an object; nothing was changed.")
    groups = hooks.setdefault("PermissionRequest", [])
    if not isinstance(groups, list):
        raise SystemExit("settings.json has a PermissionRequest entry that is not a list; nothing was changed.")
    groups.append({"matcher": "*", "hooks": [{"type": "command", "command": command_line(), "timeout": timeout}]})
    return out


def without_hook(settings: dict) -> dict:
    out = json.loads(json.dumps(settings))
    hooks = out.get("hooks")
    groups = hooks.get("PermissionRequest") if isinstance(hooks, dict) else None
    if not isinstance(groups, list):
        return out
    kept = []
    for group in groups:
        if isinstance(group, dict) and isinstance(group.get("hooks"), list):
            rest = [h for h in group["hooks"] if not (isinstance(h, dict) and MARK in str(h.get("command", "")))]
            if rest:
                kept.append({**group, "hooks": rest})
            continue
        kept.append(group)
    if kept:
        hooks["PermissionRequest"] = kept
    else:
        del hooks["PermissionRequest"]
        if not hooks:
            del out["hooks"]
    return out


def write_settings(path: str, before_exists: bool, value: dict) -> str:
    backup = ""
    if before_exists:
        backup = f"{path}.bak-reader-permission-{datetime.datetime.now().strftime('%Y%m%d%H%M%S')}"
        shutil.copy2(path, backup)
    temp = path + ".tmp-reader-permission"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.replace(temp, path)
    return backup


def run_edit(args, installing: bool) -> int:
    config_dir = os.path.abspath(os.path.expanduser(args.config_dir))
    if not os.path.isdir(config_dir):
        print(f"{config_dir} is not a folder; nothing was changed.", file=sys.stderr)
        return 1
    path, settings = load_settings(config_dir)
    present = has_hook(settings)
    if installing and present:
        print(f"{path}: the hook is already there; nothing to change.")
        return 0
    if not installing and not present:
        print(f"{path}: the hook is not there; nothing to change.")
        return 0
    after = with_hook(settings, args.timeout) if installing else without_hook(settings)
    verb = "add" if installing else "remove"
    print(f"{path}: would {verb} this PermissionRequest hook" if not args.apply else f"{path}: {verb}ing this PermissionRequest hook")
    if installing:
        print(json.dumps({"hooks": {"PermissionRequest": [after["hooks"]["PermissionRequest"][-1]]}}, indent=2))
    if not args.apply:
        print("Dry run: nothing was written. Add --apply to write it (a dated copy of settings.json is kept beside it).")
        return 0
    backup = write_settings(path, os.path.exists(path), after)
    print(f"Written. {'Copy of the old file: ' + backup if backup else 'There was no settings.json before.'}")
    return 0


def run_status(args) -> int:
    config_dir = os.path.abspath(os.path.expanduser(args.config_dir))
    path, settings = load_settings(config_dir)
    print(f"{path}: {'the hook is there' if has_hook(settings) else 'the hook is not there'}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("hook")
    for name in ("install", "uninstall", "status"):
        p = sub.add_parser(name)
        p.add_argument("--config-dir", required=True)
        if name != "status":
            p.add_argument("--apply", action="store_true")
        if name == "install":
            p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    args = parser.parse_args(argv)
    if args.command == "hook":
        return run_hook()
    if args.command == "install":
        return run_edit(args, True)
    if args.command == "uninstall":
        return run_edit(args, False)
    return run_status(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        # a hook never fails loudly; the other commands report their own errors above
        sys.exit(0 if len(sys.argv) > 1 and sys.argv[1] == "hook" else 1)
