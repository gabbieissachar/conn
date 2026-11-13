"""Herdr, as the store sees it: read-only inventory commands, and the `events.subscribe` stream.

Reads use the same commands the reader's builder uses (`session list`, `pane list`, `tab list`, `pane process-info`): nothing here
sends a key or a prompt to a pane, starts or stops a session, or changes Herdr in any way. The subscription is one unix-socket
connection per running Herdr session that asks Herdr to tell us when a pane is created, closed, updated, exits or has its agent
detected (`pane.created`, `pane.closed`, `pane.updated`, `pane.exited`, `pane.agent_detected`, `pane.moved`); the stream is only a
hint that something changed, and what a pane runs is always read again from the inventory (a reconcile read).

Wire shape (Herdr protocol 22, probed read-only on this machine): a request is one JSON line
  {"id": "...", "method": "events.subscribe", "params": {"subscriptions": [{"type": "pane.closed"}, ...]}}
and the first reply is {"id": "...", "result": {"type": "subscription_started"}}. Events follow as JSON lines
  {"event": "<kind>", "data": {"type": "<kind>", ...}}   (the schema's EventEnvelope).
Herdr's schema names no loss message. The plan's `events_lost` is handled three ways: an explicit {"event": "events_lost"} line (should
a Herdr ever send one), the connection ending or failing, and a quiet stream that fails a ping; each makes the identity engine read
the whole inventory again, so a missed event is never a silent one.
"""

from __future__ import annotations

import json
import os
import queue
import socket
import subprocess
import threading

SUBSCRIBE_KINDS = ("pane.created", "pane.closed", "pane.updated", "pane.exited", "pane.agent_detected", "pane.moved")


class HerdrClient:
    """Read-only calls to a Herdr (`bin` is the executable; a test points it at a fake)."""

    def __init__(self, bin: str = "herdr", env: dict | None = None, timeout: float = 10.0):
        self.bin = bin
        self.env = env
        self.timeout = timeout

    def call(self, *argv):
        try:
            env = {k: v for k, v in (self.env if self.env is not None else os.environ).items() if k != "HOSTED_READER_PASSPHRASE"}
            done = subprocess.run([self.bin, *argv], capture_output=True, text=True, timeout=self.timeout, env=env)
            return json.loads(done.stdout) if done.returncode == 0 else None
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            return None

    def sessions(self) -> list[dict] | None:
        """Every running, named Herdr session, each with its `life` (the session folder's inode: a deleted and recreated session of the
        same name has a new one). None when Herdr cannot be asked at all."""
        listing = self.call("session", "list", "--json")
        if listing is None:
            return None
        found = []
        for item in listing.get("sessions") or []:
            name = item.get("name") or ""
            if not item.get("running") or name.startswith("-"):
                continue
            found.append({**item, "life": life_of(item)})
        return found

    def panes(self, name: str) -> list[dict] | None:
        reply = self.call("--session", name, "pane", "list")
        return None if reply is None else (reply.get("result") or {}).get("panes") or []

    def tabs(self, name: str) -> list[dict]:
        reply = self.call("--session", name, "tab", "list")
        return ((reply or {}).get("result") or {}).get("tabs") or []

    def process_info(self, name: str, pane_id: str) -> dict | None:
        reply = self.call("--session", name, "pane", "process-info", "--pane", pane_id)
        return (((reply or {}).get("result") or {}).get("process_info")) if reply else None


def life_of(session: dict) -> str:
    try:
        return str(os.stat(session.get("session_dir") or "").st_ino)
    except (OSError, ValueError):
        return ""


class Subscription(threading.Thread):
    """One Herdr session's event stream, kept connected. Items go to <out>:
      ("event", name, life, kind, data)   a Herdr event
      ("lost",  name, life, reason)       events may have been missed (explicit message, disconnect, a failed ping): read the inventory
      ("started", name, life, None)       the subscription is live (also after every reconnect)
    """

    def __init__(self, name: str, life: str, socket_path: str, out: "queue.Queue", kinds=SUBSCRIBE_KINDS, *, backoff: float = 1.0,
                 max_backoff: float = 30.0, idle_ping: float = 120.0, connect=None):
        super().__init__(daemon=True, name=f"herdr-sub-{name}")
        self.session_name, self.life, self.socket_path, self.out, self.kinds = name, life, socket_path, out, kinds
        self.backoff, self.max_backoff, self.idle_ping = backoff, max_backoff, idle_ping
        self.connect = connect or self._connect
        self.stop_flag = threading.Event()
        self.sock = None

    def _connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect(self.socket_path)
        return sock

    def stop(self) -> None:
        self.stop_flag.set()
        sock = self.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def run(self) -> None:
        delay = self.backoff
        while not self.stop_flag.is_set():
            try:
                self.sock = sock = self.connect()
                request = {"id": f"rstore-{os.getpid()}", "method": "events.subscribe",
                           "params": {"subscriptions": [{"type": kind} for kind in self.kinds]}}
                sock.sendall((json.dumps(request) + "\n").encode())
                sock.settimeout(self.idle_ping)
                buffer = b""
                live = False
                while not self.stop_flag.is_set():
                    try:
                        chunk = sock.recv(65536)
                    except socket.timeout:
                        # A quiet stream proves nothing: ask Herdr something. A failed ping is a lost stream.
                        sock.sendall((json.dumps({"id": "ping", "method": "ping", "params": {}}) + "\n").encode())
                        continue
                    if not chunk:
                        break
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not line.strip():
                            continue
                        try:
                            message = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        live = self._deliver(message, live)
                        delay = self.backoff
                if not self.stop_flag.is_set():
                    self.out.put(("lost", self.session_name, self.life, "disconnect"))
            except (OSError, socket.error) as error:
                if not self.stop_flag.is_set():
                    self.out.put(("lost", self.session_name, self.life, f"connect: {type(error).__name__}"))
            finally:
                try:
                    if self.sock:
                        self.sock.close()
                except OSError:
                    pass
            if self.stop_flag.wait(delay):
                return
            delay = min(self.max_backoff, delay * 2)

    def _deliver(self, message: dict, live: bool) -> bool:
        result = message.get("result")
        if isinstance(result, dict) and result.get("type") == "subscription_started":
            self.out.put(("started", self.session_name, self.life, None))
            return True
        kind = message.get("event") or (message.get("data") or {}).get("type") or message.get("type")
        if kind == "events_lost":
            self.out.put(("lost", self.session_name, self.life, "events_lost"))
            return live
        if isinstance(kind, str) and "error" not in message:
            data = message.get("data") if isinstance(message.get("data"), dict) else message
            self.out.put(("event", self.session_name, self.life, kind.replace("_", ".", 1) if "." not in kind else kind, data))
        return live


class Feed:
    """The subscriptions of every running Herdr session, one queue. `sync` starts a subscription for a new session (or a new life of
    one), and stops the one of a session that is no longer running."""

    def __init__(self, client: HerdrClient, *, subscription_factory=Subscription):
        self.client = client
        self.queue: "queue.Queue" = queue.Queue()
        self.subs: dict[str, Subscription] = {}
        self.factory = subscription_factory

    def sync(self, sessions: list[dict]) -> None:
        running = {s["name"]: s for s in sessions}
        for name, sub in list(self.subs.items()):
            if name not in running or running[name]["life"] != sub.life:
                sub.stop()
                del self.subs[name]
        for name, item in running.items():
            if name not in self.subs and item.get("socket_path"):
                sub = self.factory(name, item["life"], item["socket_path"], self.queue)
                self.subs[name] = sub
                sub.start()

    def drain(self, wait: float = 0.0, limit: int = 1000) -> list[tuple]:
        items: list[tuple] = []
        try:
            items.append(self.queue.get(timeout=wait) if wait > 0 else self.queue.get_nowait())
            while len(items) < limit:
                items.append(self.queue.get_nowait())
        except queue.Empty:
            pass
        return items

    def stop(self) -> None:
        for sub in self.subs.values():
            sub.stop()
        self.subs.clear()
