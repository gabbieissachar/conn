#!/usr/bin/env python3
"""A fake Herdr for the store's tests: the read commands the store uses, and an `events.subscribe` socket that can lose its events.

Two parts that share one world file:

  CLI      `fake_herdr.py session list --json`, `--session NAME pane list`, `tab list`, `pane process-info --pane ID` (and the
           reader's `api snapshot`). The world is a JSON file named by FAKE_HERDR_WORLD, read again on every call, so a test changes
           panes while the store runs:

             { "sessions": [ { "name": "esim", "dir": "/tmp/x/esim", "socket": "/tmp/x/esim/h.sock", "running": true,
                 "tabs": [ { "tab_id": "w1:t1", "label": "alpha" } ],
                 "panes": [ { "pane_id": "w1:p1", "tab_id": "w1:t1", "terminal_id": "term_1", "label": null, "agent": "claude",
                              "agent_status": "idle", "agent_session": "<Herdr's id or null>", "title": "Alpha", "cwd": "/work",
                              "fgpg": 1001, "process": [ { "pid": 1001, "argv0": "claude", "name": "2.1", "cwd": "/work" } ] } ] } ] }

  SERVER   FakeHerdrServer, run in the test's own process: one unix socket per Herdr session that answers `events.subscribe` with
           `subscription_started` and then sends whatever the test emits. `emit` sends one event line; `lose_events` sends an
           explicit `events_lost` line; `drop` closes every subscriber's connection (a Herdr that went away mid-stream).

It never sends a key or a prompt: it has no such command, and a call it does not know exits 1.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
from pathlib import Path


def pane_of(pane: dict) -> dict:
    shown = {"pane_id": pane["pane_id"], "tab_id": pane.get("tab_id"), "workspace_id": "w1", "terminal_id": pane.get("terminal_id"),
             "label": pane.get("label") or None, "terminal_title_stripped": pane.get("title"), "cwd": pane.get("cwd"), "focused": False,
             "agent_status": pane.get("agent_status") or "unknown", "revision": 0}
    if pane.get("agent"):
        shown["agent"] = pane["agent"]
    if pane.get("agent_session"):
        shown["agent_session"] = {"agent": pane.get("agent"), "kind": "id", "source": "herdr:" + str(pane.get("agent")), "value": pane["agent_session"]}
    return shown


def cli(argv: list[str]) -> int:
    world = json.loads(Path(os.environ["FAKE_HERDR_WORLD"]).read_text(encoding="utf-8"))
    out = lambda value: sys.stdout.write(json.dumps(value) + "\n")
    if argv[:2] == ["session", "list"]:
        out({"sessions": [{"name": s["name"], "default": False, "running": s.get("running", True), "session_dir": s["dir"], "socket_path": s["socket"]} for s in world["sessions"]]})
        return 0
    rest = argv[2:] if argv[:1] == ["--session"] else argv
    named = argv[1] if argv[:1] == ["--session"] else None
    session = next((s for s in world["sessions"] if s["name"] == named), None)
    if session is None or not session.get("running", True):
        sys.stderr.write("fake herdr: unknown or stopped session\n")
        return 1
    if session.get("fail") and rest[:2] == ["pane", "process-info"] and session["fail"] == "process-info":
        sys.stderr.write("fake herdr: process-info failed\n")
        return 1
    if rest[:2] == ["pane", "list"]:
        out({"id": "cli:pane:list", "result": {"panes": [pane_of(p) for p in session["panes"]], "type": "pane_list"}})
    elif rest[:2] == ["tab", "list"]:
        out({"result": {"tabs": session.get("tabs", [])}})
    elif rest[:2] == ["api", "snapshot"]:
        out({"result": {"snapshot": {"panes": [pane_of(p) for p in session["panes"]], "tabs": session.get("tabs", [])}}})
    elif rest[:2] == ["pane", "process-info"]:
        pane = next((p for p in session["panes"] if p["pane_id"] == rest[rest.index("--pane") + 1]), None)
        if pane is None:
            sys.stderr.write("fake herdr: no such pane\n")
            return 1
        out({"result": {"process_info": {"pane_id": pane["pane_id"], "foreground_process_group_id": pane.get("fgpg"), "shell_pid": 1,
                                         "foreground_processes": pane.get("process", [])}}})
    else:
        sys.stderr.write("fake herdr: unexpected " + " ".join(argv) + "\n")
        return 1
    return 0


class FakeHerdrServer:
    """Unix-socket servers, one per Herdr session name, speaking just enough of events.subscribe."""

    def __init__(self):
        self.listeners: dict[str, socket.socket] = {}
        self.paths: dict[str, str] = {}
        self.conns: dict[str, list[socket.socket]] = {}
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        self.stopping = False

    def start(self, name: str, path: str) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        if os.path.exists(path):
            os.unlink(path)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        listener.listen(8)
        self.listeners[name], self.paths[name], self.conns[name] = listener, path, []
        threading.Thread(target=self._accept, args=(name, listener), daemon=True).start()

    def _accept(self, name: str, listener: socket.socket) -> None:
        while not self.stopping:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(name, conn), daemon=True).start()

    def _serve(self, name: str, conn: socket.socket) -> None:
        buffer = b""
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    try:
                        request = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    with self.lock:
                        self.requests.append({"session": name, **request})
                    if request.get("method") == "events.subscribe":
                        with self.lock:
                            self.conns[name].append(conn)
                        conn.sendall((json.dumps({"id": request.get("id"), "result": {"type": "subscription_started"}}) + "\n").encode())
                    elif request.get("method") == "ping":
                        conn.sendall((json.dumps({"id": request.get("id"), "result": {"type": "pong"}}) + "\n").encode())
        except OSError:
            return
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def subscribers(self, name: str) -> int:
        with self.lock:
            return len(self.conns.get(name, []))

    def emit(self, name: str, kind: str, **data) -> None:
        """One event line: {"event": "<kind>", "data": {"type": "<kind>", ...}}. <kind> is the stream's name (pane.closed) or the
        schema's (pane_closed): the store accepts either."""
        line = (json.dumps({"event": kind, "data": {"type": kind, **data}}) + "\n").encode()
        with self.lock:
            for conn in list(self.conns.get(name, [])):
                try:
                    conn.sendall(line)
                except OSError:
                    self.conns[name].remove(conn)

    def lose_events(self, name: str) -> None:
        self.emit(name, "events_lost", missed=3)

    def drop(self, name: str) -> None:
        with self.lock:
            for conn in self.conns.get(name, []):
                try:
                    conn.shutdown(socket.SHUT_RDWR)
                    conn.close()
                except OSError:
                    pass
            self.conns[name] = []

    def stop(self) -> None:
        self.stopping = True
        for name in list(self.listeners):
            self.drop(name)
            try:
                self.listeners[name].close()
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(cli(sys.argv[1:]))
