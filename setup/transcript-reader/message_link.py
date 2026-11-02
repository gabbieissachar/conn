#!/usr/bin/env python3
"""The reader's address of one message, to put in a reminder as a link.

Usage (from the repo root):
  python3 setup/transcript-reader/message_link.py <session> [--from-session <session>] [--since <ISO date/time>] <text>
  python3 setup/transcript-reader/message_link.py <session> --message <message id>

<session> is a session id or its first characters (6 or more). The conversation is that session and the ones the same pane ran before
and after it (/clear), as the reader shows them as one.

With <text>, it finds the FIRST reply from the agent in the conversation that contains <text> (a plain, case-sensitive match, so
`L17=` finds the reply that asked L17). Only the agent's replies are looked in, never the owner's messages or a steering message, so
an answer such as "L17=yes" cannot be mistaken for the question. `--from-session` starts the search at that session and includes
newer sessions in the chain. `--since` starts the search at an ISO date or date/time (UTC when no timezone is given). If more than
one agent reply matches, the oldest match is still returned and a warning on stderr lists every match's session, UTC time and message
id; use either scope option to select the intended call. With --message, it checks that the id (or its first characters) names exactly
one message in the conversation and writes the address for it.

It prints two lines, the reader's address for the message on this Mac and on the tailnet:
  local:   http://localhost:8768/setup/transcript-reader/out/prototype.html#s=<session>&m=<message id>
  tailnet: https://<machine>.<tailnet>.ts.net:8443/setup/transcript-reader/out/prototype.html#s=<session>&m=<message id>
Opened, the address shows that conversation scrolled to the message (its reply), outlined for a moment. The reader on the page
accepts either address wherever it is open, and an address into a conversation already open switches to it in place.

The ports are the reader's own: PMOS_READER_PORT (8768) and PMOS_READER_HTTPS_PORT (8443), as serve.sh reads them. The tailnet name is
what Tailscale reports for this machine (`tailscale status --json`, Self.DNSName), as serve.sh asks it, never typed in; PMOS_READER_TAILSCALE
names another tailscale command. With no tailnet name (Tailscale is off, or MagicDNS is), the tailnet line says so and the local
line is still printed. The tailnet address works when the reader was started with --tailnet-https (see README.md).

Exit status: 0 an address was printed, including when a duplicate-match warning was printed; 1 the session or the message was not found
(a plain sentence says which, on stderr); 2 the command line is wrong. It reads the session logs and nothing else, writes nothing, and
prints ids, times and addresses, never the words of a message.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "prototype"))
import build_prototype as builder  # noqa: E402

PAGE_PATH = "/setup/transcript-reader/out/prototype.html"  # where the reader's server serves the page (tailnet.js HOME)
DEFAULT_PORT = "8768"
DEFAULT_HTTPS_PORT = "8443"
SESSION_PREFIX = re.compile(r"^[0-9a-f]{6,}[0-9a-f-]*$")
MESSAGE_ID = re.compile(r"^[0-9A-Za-z_-]{6,64}$")
DNS_NAME = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$")
SHORTEST_ID = 12  # characters of the message id an address carries, more when two messages share them


class NotFound(Exception):
    """Something asked for is not there; the message is the plain sentence that says so."""


def session_log(prefix: str) -> Path:
    if not SESSION_PREFIX.match(prefix):
        raise NotFound(f"{prefix!r} is not a session id: give its first 6 or more characters (hex digits and dashes)")
    found = sorted({log.stem: log for log in builder.PROJECTS.glob(f"*/{prefix}*.jsonl")}.items())
    if not found:
        raise NotFound(f"no session log starts with {prefix}")
    if len(found) > 1:
        raise NotFound(f"{prefix} starts {len(found)} sessions; give more characters")
    return found[0][1]


def conversation(prefix: str) -> list[tuple[str, list[dict]]]:
    """The sessions of the conversation the session belongs to, oldest first, each as (session id, its turns)."""
    chain = builder.session_chain(session_log(prefix))
    return [(member.stem, builder.parsed_log(member, None)["exchanges"]) for member in chain]


def scope_sessions(sessions: list[tuple[str, list[dict]]], prefix: str | None) -> list[tuple[str, list[dict]]]:
    """Return the chain from the session named by <prefix>, inclusive."""
    if prefix is None:
        return sessions
    if not SESSION_PREFIX.match(prefix):
        raise NotFound(f"{prefix!r} is not a session id: give its first 6 or more characters (hex digits and dashes)")
    found = [(index, sid) for index, (sid, _) in enumerate(sessions) if sid.startswith(prefix)]
    if not found:
        raise NotFound(f"no session in that conversation starts with {prefix}")
    if len(found) > 1:
        raise NotFound(f"{prefix} starts {len(found)} sessions in that conversation; give more characters")
    return sessions[found[0][0]:]


def parse_since(value: str | None) -> float | None:
    """Parse an ISO date or date/time, treating a missing timezone as UTC."""
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"invalid --since value {value!r}: use an ISO date or date/time") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def shortest_unique(uid: str, uids: list[str]) -> str:
    """The first characters of <uid> (at least SHORTEST_ID) that no other turn's id starts with."""
    others = [other for other in uids if other != uid]
    size = min(SHORTEST_ID, len(uid))
    while size < len(uid) and any(other.startswith(uid[:size]) for other in others):
        size += 1
    return uid[:size]


def reply_matches(sessions: list[tuple[str, list[dict]]], text: str, since: float | None = None) -> list[tuple[str, str, float | None]]:
    """(session id, turn id, reply time) for each agent reply containing <text>, oldest first."""
    matches = []
    for sid, exchanges in sessions:
        for exchange in exchanges:
            uid = exchange.get("uid")
            reply = exchange.get("reply") or ""
            reply_at = exchange.get("reply_at") or exchange.get("at")
            if uid and text in reply and (since is None or (reply_at is not None and reply_at >= since)):
                matches.append((sid, uid, reply_at))
    return matches


def first_reply(sessions: list[tuple[str, list[dict]]], text: str) -> tuple[str, str] | None:
    """(session id, turn id) of the first turn whose reply, the agent's words, contains <text>."""
    matches = reply_matches(sessions, text)
    return matches[0][:2] if matches else None


def display_time(timestamp: float | None) -> str:
    """Format a reply timestamp for a duplicate-match warning."""
    if timestamp is None:
        return "unknown time"
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def warn_duplicate_matches(text: str, matches: list[tuple[str, str, float | None]]) -> None:
    """Tell the caller which agent replies share a key without printing reply text."""
    if len(matches) < 2:
        return
    print(f"warning: {text!r} appears in {len(matches)} agent replies that may be separate asks; using the oldest match", file=sys.stderr)
    print("matches:", file=sys.stderr)
    for sid, uid, timestamp in matches:
        print(f"  session {sid} time {display_time(timestamp)} message {uid}", file=sys.stderr)
    print("use --from-session or --since to scope the search", file=sys.stderr)


def named_message(sessions: list[tuple[str, list[dict]]], wanted: str) -> tuple[str, str]:
    """(session id, turn id) of the one turn whose id is <wanted> or starts with it."""
    if not MESSAGE_ID.match(wanted):
        raise NotFound(f"{wanted!r} is not a message id: give its first 6 or more characters")
    hits: dict[str, str] = {}
    for sid, exchanges in sessions:
        for exchange in exchanges:
            uid = exchange.get("uid")
            if isinstance(uid, str) and uid.startswith(wanted):
                hits.setdefault(uid, sid)
    if wanted in hits:
        return hits[wanted], wanted
    if not hits:
        raise NotFound(f"no message in that conversation has an id starting with {wanted}")
    if len(hits) > 1:
        raise NotFound(f"{wanted} starts {len(hits)} messages in that conversation; give more characters")
    uid = next(iter(hits))
    return hits[uid], uid


def tailscale_command() -> str | None:
    named = os.environ.get("PMOS_READER_TAILSCALE")
    if named:
        return named if Path(named).is_file() or shutil.which(named) else None
    return shutil.which("tailscale") or next((str(app) for app in [Path("/Applications/Tailscale.app/Contents/MacOS/Tailscale")] if app.is_file()), None)


def tailnet_name() -> str | None:
    """This machine's name on the tailnet, as Tailscale reports it (the same source serve.sh starts the HTTPS address from)."""
    command = tailscale_command()
    if not command:
        return None
    try:
        done = subprocess.run([command, "status", "--json"], capture_output=True, text=True, timeout=10)
        name = str((json.loads(done.stdout).get("Self") or {}).get("DNSName") or "").rstrip(".")
    except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
        return None
    return name if DNS_NAME.match(name) else None


def addresses(session_id: str, message_id: str, name: str | None) -> tuple[str, str | None]:
    """The address on this Mac and, when the machine has a tailnet name, on the tailnet."""
    port = os.environ.get("PMOS_READER_PORT") or DEFAULT_PORT
    secure = os.environ.get("PMOS_READER_HTTPS_PORT") or DEFAULT_HTTPS_PORT
    anchor = f"{PAGE_PATH}#s={session_id[:8]}&m={message_id}"
    return f"http://localhost:{port}{anchor}", f"https://{name}:{secure}{anchor}" if name else None


def main(argv: list[str]) -> int:
    usage = (
        "usage: message_link.py <session> [--from-session <session>] [--since <ISO date/time>] <text>\n"
        "       message_link.py <session> --message <message id>"
    )
    session = text = wanted = from_session = since_text = None
    positional = []
    try:
        if not argv:
            raise ValueError
        session = argv[0]
        index = 1
        while index < len(argv):
            argument = argv[index]
            if argument in ("--from-session", "--from"):
                if from_session is not None or index + 1 >= len(argv) or argv[index + 1].startswith("--"):
                    raise ValueError
                from_session = argv[index + 1]
                index += 2
            elif argument == "--since":
                if since_text is not None or index + 1 >= len(argv) or argv[index + 1].startswith("--"):
                    raise ValueError
                since_text = argv[index + 1]
                index += 2
            elif argument == "--message":
                if wanted is not None or index + 1 >= len(argv) or argv[index + 1].startswith("--"):
                    raise ValueError
                wanted = argv[index + 1]
                index += 2
            elif argument.startswith("--"):
                raise ValueError
            else:
                positional.append(argument)
                index += 1
        if wanted is not None:
            if positional or from_session is not None or since_text is not None:
                raise ValueError
        elif len(positional) == 1:
            text = positional[0]
        else:
            raise ValueError
    except ValueError:
        print(usage, file=sys.stderr)
        return 2
    if text is not None and not text.strip():
        print("the text to look for is empty\n" + usage, file=sys.stderr)
        return 2
    try:
        since = parse_since(since_text)
        all_sessions = conversation(session)
        sessions = scope_sessions(all_sessions, from_session)
        if wanted is not None:
            sid, uid = named_message(sessions, wanted)
        else:
            matches = reply_matches(sessions, text, since)
            if not matches:
                raise NotFound(f"no reply from the agent in that conversation contains {text!r}")
            warn_duplicate_matches(text, matches)
            sid, uid = matches[0][:2]
    except (NotFound, ValueError) as error:
        if isinstance(error, ValueError):
            print(str(error), file=sys.stderr)
            return 2
        print(str(error), file=sys.stderr)
        return 1
    uids = [exchange["uid"] for _, exchanges in all_sessions for exchange in exchanges if isinstance(exchange.get("uid"), str)]
    local, tailnet = addresses(sid, shortest_unique(uid, uids), tailnet_name())
    print(f"local:   {local}")
    if tailnet:
        print(f"tailnet: {tailnet}")
    else:
        print("tailnet: not available (Tailscale gives this machine no name)")
        print("no tailnet name: Tailscale is off or MagicDNS is; only the local address is printed", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
