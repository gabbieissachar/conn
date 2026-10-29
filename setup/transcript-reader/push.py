#!/usr/bin/env python3
"""The hosted reader's second sync target: the app in the ShopBack Replit workspace (replit/README.md).

sync.py --seal seals the hosted copy into a local folder. This runs that, then sends what changed in
the folder to the app's upload endpoint, so the folder stays the one source of truth and the app is
a copy of it. Only sealed bytes leave this laptop: the objects, the index and the key parameters
the app's endpoint accepts. The shell pages (index.html, sheet.html) are code, and the endpoint
takes no code: they are deployed with the app by hand (--copy-shell, below), so a leaked upload key
cannot swap the page that asks for the passphrase.

Usage (from the repo root):
  python3 setup/transcript-reader/push.py URL                 build and seal (sync.py --seal), then upload what changed
  python3 setup/transcript-reader/push.py URL --push-only     upload what changed in the folder as it is
  python3 setup/transcript-reader/push.py URL --launch-agent  print a LaunchAgent that runs this every minute
  python3 setup/transcript-reader/push.py URL --copy-shell DIR  copy the shell pages from the folder into DIR, to put in the app's shell/ folder
  Options: --folder DIR (the sealed folder; default out/bucket-hosted/), --state FILE (what was sent; default out/push.json)

URL is the app's address (https, or http to this machine for a stand-in); HOSTED_READER_URL
can name it instead. The upload key is read from HOSTED_READER_UPLOAD_KEY, else from the macOS
keychain (service pmos-hosted-reader-upload-key), else asked for in a terminal. The key is
never written to a file, a log or a message here, and is not passed to sync.py. The passphrase
sync.py needs is its own business (HOSTED_READER_PASSPHRASE or its prompt).

A run sends the key parameters, then each changed object, then the index, so a
phone never reads an index that names an object not there yet; it removes objects the sync
pruned (conversations older than 90 days) afterwards. What was sent is remembered by content hash in the
state file; an object missing from the app is sent again. A redirect from the app is
refused, so the key is never forwarded anywhere else.

The Send queue (the page queues sealed messages in the app's q/ folder; sync.py drains a q/ folder
beside the sealed copy and writes receipts to r/): before the sync, a run copies the app's queued
messages into <folder>/q/ (never one already handled); after it, a run sends the receipts the
drain wrote to the app's r/ folder, then removes from the app the queued messages that now have a
receipt, and the receipts the drain has since dropped. A message with no receipt yet stays queued.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
FOLDER = OUT / "bucket-hosted"
STATE = OUT / "push.json"
KEY_ENV = "HOSTED_READER_UPLOAD_KEY"
URL_ENV = "HOSTED_READER_URL"
KEYCHAIN_SERVICE = "pmos-hosted-reader-upload-key"
# What the app accepts (replit/names.js), as far as this side builds it.
OBJECT = re.compile(r"^[sdfa]/[A-Za-z0-9_-]{1,64}\.json\.enc$")
UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
QUEUED = re.compile(rf"^q/({UUID})\.json\.enc$")
RECEIPT = re.compile(rf"^r/({UUID})\.json\.enc$")
FIXED = ("k/params.json", "index.json.enc")
SHELLS = ("index.html", "sheet.html")  # code: copied by hand into the app's shell/ folder, never uploaded
PRUNED_PREFIXES = ("s/", "d/", "f/", "a/")
LOOPBACK = {"localhost", "127.0.0.1", "::1"}
ATTEMPTS = 3


class PushError(Exception):
    """A failure to report to the owner, never carrying the key."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # urllib then raises the 3xx as an HTTPError


OPENER = urllib.request.build_opener(NoRedirect)


def check_url(url: str) -> str:
    parts = urllib.parse.urlsplit(url or "")
    host = parts.hostname or ""
    if not (parts.scheme == "https" or (parts.scheme == "http" and host in LOOPBACK)) or not host or parts.username or parts.password or parts.query or parts.fragment:
        raise PushError("The app's address must be an https address (http only to this machine), with no sign-in details in it.")
    return url.rstrip("/")


def find_key(env=None, run=subprocess.run, isatty=sys.stdin.isatty) -> str:
    """The upload key: the environment, else the keychain, else asked for in a terminal."""
    env = os.environ if env is None else env
    if env.get(KEY_ENV):
        return env[KEY_ENV].strip()
    if sys.platform == "darwin":
        found = run(["/usr/bin/security", "find-generic-password", "-a", env.get("USER", ""), "-s", KEYCHAIN_SERVICE, "-w"], capture_output=True, text=True)
        if found.returncode == 0 and found.stdout.strip():
            return found.stdout.strip()
    if isatty():
        key = getpass.getpass("Upload key for the hosted reader: ").strip()
        if key:
            return key
    raise PushError(f"No upload key. Set {KEY_ENV}, or store it in the keychain: security add-generic-password -a \"$USER\" -s {KEYCHAIN_SERVICE} -w")


class Remote:
    """The app's upload endpoint. The key lives only in this object's Authorization header."""

    def __init__(self, base: str, key: str, sleep=time.sleep) -> None:
        self.base, self._key, self.sleep = check_url(base), key, sleep

    def call(self, method: str, path: str, body: bytes | None = None) -> bytes:
        request = urllib.request.Request(self.base + path, data=body, method=method, headers={"Authorization": f"Bearer {self._key}", "Content-Type": "application/octet-stream"})
        for attempt in range(1, ATTEMPTS + 1):
            try:
                with OPENER.open(request, timeout=60) as response:
                    return response.read()
            except urllib.error.HTTPError as error:
                reason = error.read(300).decode("utf-8", "replace")
                error.close()
                if error.code in (301, 302, 303, 307, 308):
                    raise PushError("The app answered with a redirect, which is refused so the key is never sent anywhere else. Check the address.") from None
                if error.code in (401, 403):
                    raise PushError("The app refused the upload key (revoked, mistyped or for another app). Make a new one in the Replit shell: node keys-cli.js create.") from None
                if error.code == 429:
                    raise PushError("The app is slowing this key down (too many wrong keys). Wait a minute.") from None
                if error.code < 500 or attempt == ATTEMPTS:
                    raise PushError(f"{method} {path} failed: HTTP {error.code} {reason}".replace(self._key, "***")) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                if attempt == ATTEMPTS:
                    raise PushError(f"Could not reach {urllib.parse.urlsplit(self.base).hostname}: {getattr(error, 'reason', error)}") from None
            self.sleep(2 ** (attempt - 1))
        raise PushError("unreachable")

    def names(self, prefix: str = "") -> set[str]:
        query = f"?prefix={prefix}" if prefix else ""
        return {item["name"] for item in json.loads(self.call("GET", "/api/objects" + query))["objects"]}

    def get(self, name: str) -> bytes:
        return self.call("GET", "/api/objects/" + name)

    def put(self, name: str, data: bytes) -> None:
        self.call("PUT", "/api/objects/" + name, data)

    def delete(self, name: str) -> None:
        self.call("DELETE", "/api/objects/" + name)


def local_files(folder: Path) -> dict[str, Path]:
    """The files of the sealed folder the app takes, by name."""
    found = {name: folder / name for name in FIXED if (folder / name).is_file()}
    for prefix in PRUNED_PREFIXES:
        for path in sorted((folder / prefix).glob("*.json.enc")) if (folder / prefix).is_dir() else []:
            name = f"{prefix}{path.name}"
            if OBJECT.match(name) and path.is_file():
                found[name] = path
    receipts = folder / "r"
    for path in sorted(receipts.glob("*.json.enc")) if receipts.is_dir() else []:
        if RECEIPT.match(f"r/{path.name}") and path.is_file():
            found[f"r/{path.name}"] = path
    return found


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def send_order(names) -> list[str]:
    """Key parameters, then objects, then the index, then receipts."""
    names = set(names)
    return ([n for n in ("k/params.json",) if n in names] + sorted(n for n in names if OBJECT.match(n))
            + [n for n in ("index.json.enc",) if n in names] + sorted(n for n in names if RECEIPT.match(n)))


def push_folder(folder: Path, remote: Remote, state_file: Path = STATE, say=print) -> tuple[int, int, int]:
    """Send what changed: (sent, removed, unchanged)."""
    files = local_files(folder)
    if "index.json.enc" not in files or "k/params.json" not in files:
        raise PushError(f"{folder} holds no sealed copy yet. Run without --push-only to build one.")
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    sent = state.get("files", {}) if state.get("url") == remote.base else {}
    there = remote.names()
    todo = [name for name in send_order(files) if sent.get(name) != digest(files[name]) or name not in there]
    stale = sorted(name for name in there if (name.startswith(PRUNED_PREFIXES) or RECEIPT.match(name)) and name not in files)
    # A queued message is done once its receipt is on the app.
    handled = sorted(name for name in there if (m := QUEUED.match(name)) and f"r/{m.group(1)}.json.enc" in files)
    uploaded = 0
    try:
        for name in todo:
            remote.put(name, files[name].read_bytes())
            sent[name] = digest(files[name])
            uploaded += 1
        for name in stale:
            remote.delete(name)
            sent.pop(name, None)
        for name in handled:
            remote.delete(name)
    finally:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        partial = state_file.with_name(f".{state_file.name}.{os.getpid()}.partial")
        partial.write_text(json.dumps({"url": remote.base, "files": {n: h for n, h in sent.items() if n in files}, "shells": state.get("shells", {})}), encoding="utf-8")
        os.chmod(partial, 0o600)
        os.replace(partial, state_file)
    return uploaded, len(stale) + len(handled), len(files) - len(todo)


def pull_queue(folder: Path, remote: Remote) -> int:
    """Copy the app's queued messages into <folder>/q/ for the sync's drain; returns how many are new.
    A message already there, or already answered (its receipt is in <folder>/r/), is not copied again."""
    fetched = 0
    for name in sorted(remote.names("q/")):
        match = QUEUED.match(name)  # the app's names are checked here too, before any is made a path
        if not match:
            continue
        target = folder / name
        if target.exists() or (folder / "r" / f"{match.group(1)}.json.enc").exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        partial = target.with_name(f".{target.name}.{os.getpid()}.partial")
        partial.write_bytes(remote.get(name))
        os.chmod(partial, 0o600)
        os.replace(partial, target)
        fetched += 1
    return fetched


def shell_hashes(folder: Path) -> dict[str, str]:
    return {name: digest(folder / name) for name in SHELLS if (folder / name).is_file()}


def copy_shells(folder: Path, dest: Path, state_file: Path = STATE) -> list[str]:
    """Copy the shell pages out of the sealed folder into <dest> (no transcript in them) and remember
    which ones, so a run can say when the folder's pages are newer than the deployed ones."""
    found = shell_hashes(folder)
    if not found:
        raise PushError(f"{folder} holds no shell pages yet. Run without --push-only to build them.")
    dest.mkdir(parents=True, exist_ok=True)
    for name in found:
        (dest / name).write_bytes((folder / name).read_bytes())
    update_state(state_file, shells=found)
    return sorted(found)


def update_state(state_file: Path, **fields) -> None:
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    state.update(fields)
    state_file.parent.mkdir(parents=True, exist_ok=True)
    partial = state_file.with_name(f".{state_file.name}.{os.getpid()}.partial")
    partial.write_text(json.dumps(state), encoding="utf-8")
    os.chmod(partial, 0o600)
    os.replace(partial, state_file)


def shell_notice(folder: Path, state_file: Path = STATE) -> str:
    """What to tell the owner when the folder's shell pages are not the ones last copied out for the app."""
    try:
        copied = json.loads(state_file.read_text(encoding="utf-8")).get("shells", {})
    except (OSError, ValueError):
        copied = {}
    now = shell_hashes(folder)
    if now and now != copied:
        return "The shell pages changed since you last copied them for the app: run this with --copy-shell DIR, put the files in the app's shell/ folder and redeploy (README.md)."
    return ""


def launch_agent(url: str, folder: Path) -> str:
    """A LaunchAgent that runs the sync and the upload every minute. Only printed: install it yourself.
    The passphrase comes from the login keychain here; push.py finds the upload key there itself."""
    import sync  # only for the shared constants
    from xml.sax.saxutils import escape
    command = (f'{sync.PASSPHRASE_ENV}="$(/usr/bin/security find-generic-password -w -s {sync.KEYCHAIN_SERVICE})" '
               f'exec /usr/bin/env python3 "{Path(__file__).resolve()}" "{url}" --folder "{folder.resolve()}"')
    log = OUT / "push-agent.log"
    # launchd's own PATH holds none of the tools a run uses (node seals and sends, python3 builds, herdr
    # is the pane a send reaches), so the agent gets the folders they are in now, as sync.py's does.
    found = [str(Path(shutil.which(tool)).resolve().parent) for tool in ("node", "python3", "herdr") if shutil.which(tool)]
    path = ":".join(dict.fromkeys([*found, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]))
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pmos.transcript-reader-push</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>{escape(command)}</string></array>
  <key>WorkingDirectory</key><string>{escape(str(sync.reader.REPO.resolve()))}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>{escape(path)}</string></dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>{escape(str(log))}</string>
  <key>StandardErrorPath</key><string>{escape(str(log))}</string>
</dict>
</plist>
"""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", nargs="?", default=os.environ.get(URL_ENV), help="the app's address")
    parser.add_argument("--folder", default=str(FOLDER))
    parser.add_argument("--state", default=str(STATE))
    parser.add_argument("--push-only", action="store_true", help="upload the folder as it is, without sealing again first")
    parser.add_argument("--launch-agent", action="store_true", help="print a LaunchAgent that runs this every minute")
    parser.add_argument("--copy-shell", metavar="DIR", help="copy the shell pages from the folder into DIR, for the app's shell/ folder (nothing is uploaded)")
    args = parser.parse_args(argv)
    folder = Path(args.folder).expanduser()
    try:
        if args.copy_shell:
            names = copy_shells(folder, Path(args.copy_shell).expanduser(), Path(args.state).expanduser())
            print(f"Copied {', '.join(names)} to {args.copy_shell}. Put them in the app's shell/ folder and redeploy (README.md).")
            return 0
        url = check_url(args.url)
        if args.launch_agent:
            print(launch_agent(url, folder), end="")
            return 0
        key = find_key()
        remote = Remote(url, key)
        if not args.push_only:
            pull_queue(folder, remote)
            code = subprocess.run([sys.executable, str(HERE / "sync.py"), "--seal", str(folder)], env={k: v for k, v in os.environ.items() if k != KEY_ENV}).returncode
            if code:
                print("The sync stopped, so nothing was uploaded.", file=sys.stderr)
                return code
        sent, removed, same = push_folder(folder, remote, Path(args.state).expanduser())
    except PushError as error:
        print(f"Not uploaded: {error}", file=sys.stderr)
        return 1
    print(f"Uploaded {sent} objects to {urllib.parse.urlsplit(url).hostname}, removed {removed}, {same} already there.")
    notice = shell_notice(folder, Path(args.state).expanduser())
    if notice:
        print(notice)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
