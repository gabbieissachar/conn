"""Tests for push.py, the sync agent's upload target for the Replit app (replit/).

Run from the repo root: python3 -m unittest setup/transcript-reader/test_push.py
Everything runs against local stand-ins on 127.0.0.1: a small server that plays the app's upload
endpoint (the failure cases), and the real app started with a folder as its store (the contract).
Objects are made up (the endpoint checks only the sealed magic); the keys and the passphrase are
made up; nothing leaves this machine.
"""

import hashlib
import http.server
import io
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import push  # noqa: E402

HERE = Path(__file__).resolve().parent
KEY = "hrk_" + "k" * 43
NAME = re.compile(r"^/api/objects/((?:index\.html|k/params\.json|index\.json\.enc|[sdfqr]/[A-Za-z0-9_-]{1,64}\.json\.enc))$")


def sealed(tag: str) -> bytes:
    return b"HRC1" + tag.encode() * 32


PARAMS = json.dumps({"version": 1, "kdf": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "c2FsdA==", "check": "Y2hlY2s="}).encode()
SHELL = b"<!doctype html><title>shell</title>"


class StandIn:
    """The app's upload endpoint as far as push.py can tell: a bearer key, names, a store, and modes for failures."""

    def __init__(self, key=KEY):
        self.key, self.store, self.log, self.fail_puts, self.mode, self.auth_seen = key, {}, [], 0, None, []
        stand = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body=b"{}", headers=None):
                self.send_response(status)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def handle_any(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                stand.auth_seen.append(self.headers.get("Authorization"))
                stand.log.append((self.command, self.path))
                if stand.mode == "redirect":
                    return self.reply(302, headers={"Location": stand.redirect_to})
                if self.headers.get("Authorization") != f"Bearer {stand.key}":
                    return self.reply(401, b'{"error":"a valid upload key is required"}')
                if self.path == "/api/objects" and self.command == "GET":
                    return self.reply(200, json.dumps({"objects": [{"name": n, "size": len(b)} for n, b in sorted(stand.store.items())]}).encode())
                match = NAME.match(self.path)
                if not match:
                    return self.reply(400, b'{"error":"not an object name"}')
                name = match.group(1)
                if self.command == "PUT":
                    if stand.fail_puts:
                        stand.fail_puts -= 1
                        return self.reply(503, b'{"error":"try again"}')
                    if name.endswith(".enc") and not body.startswith(b"HRC1"):
                        return self.reply(422, b'{"error":"not a sealed object"}')
                    stand.store[name] = body
                    return self.reply(201)
                if self.command == "DELETE":
                    return self.reply(200, json.dumps({"deleted": stand.store.pop(name, None) is not None}).encode())
                return self.reply(405)

            do_GET = do_PUT = do_DELETE = handle_any

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def puts(self):
        return [path[len("/api/objects/"):] for method, path in self.log if method == "PUT"]


def make_folder(root: Path, objects: dict[str, bytes] | None = None) -> Path:
    folder = root / "sealed"
    files = {"k/params.json": PARAMS, "index.json.enc": sealed("i"), "index.html": SHELL, "s/aaa.json.enc": sealed("a"), "s/bbb.json.enc": sealed("b"), "d/ddd.json.enc": sealed("d"), "f/2026-W43.json.enc": sealed("f")}
    files.update(objects or {})
    for name, data in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return folder


class PushTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state = self.root / "push.json"
        self.stand = StandIn()
        self.addCleanup(self.stand.close)
        self.addCleanup(self.tmp.cleanup)
        self.folder = make_folder(self.root)

    def remote(self, key=KEY):
        return push.Remote(self.stand.url, key, sleep=lambda seconds: None)

    def run_push(self, **kwargs):
        return push.push_folder(self.folder, self.remote(), self.state, **kwargs)

    def test_a_first_push_sends_the_key_parameters_then_objects_then_index_then_shell(self):
        sent, removed, same = self.run_push()
        self.assertEqual((sent, removed, same), (7, 0, 0))
        self.assertEqual(self.stand.puts(), ["k/params.json", "d/ddd.json.enc", "f/2026-W43.json.enc", "s/aaa.json.enc", "s/bbb.json.enc", "index.json.enc", "index.html"])
        for name, data in self.stand.store.items():
            self.assertEqual(data, (self.folder / name).read_bytes(), name)
        self.assertEqual(set(self.stand.auth_seen), {f"Bearer {KEY}"})

    def test_a_second_push_with_nothing_changed_sends_nothing(self):
        self.run_push()
        self.stand.log.clear()
        self.assertEqual(self.run_push(), (0, 0, 7))
        self.assertEqual(self.stand.log, [("GET", "/api/objects")])

    def test_only_a_changed_object_is_sent_again_and_a_pruned_one_is_removed(self):
        self.run_push()
        (self.folder / "s/aaa.json.enc").write_bytes(sealed("A"))
        (self.folder / "index.json.enc").write_bytes(sealed("I"))
        (self.folder / "d/ddd.json.enc").unlink()
        self.stand.store["q/00000000-0000-4000-8000-000000000001.json.enc"] = sealed("q")
        self.stand.store["r/00000000-0000-4000-8000-000000000002.json.enc"] = sealed("r")
        self.stand.log.clear()
        sent, removed, _ = self.run_push()
        self.assertEqual((sent, removed), (2, 1))
        self.assertEqual(self.stand.puts(), ["s/aaa.json.enc", "index.json.enc"], "the index goes after the object it names")
        self.assertNotIn("d/ddd.json.enc", self.stand.store)
        self.assertEqual(self.stand.store["s/aaa.json.enc"], sealed("A"))
        self.assertIn(("DELETE", "/api/objects/d/ddd.json.enc"), self.stand.log)
        self.assertEqual([n for n in self.stand.store if n[0] in "qr"].__len__(), 2, "queued messages and receipts are never touched")

    def test_an_object_missing_from_the_app_is_sent_again(self):
        self.run_push()
        del self.stand.store["s/bbb.json.enc"]
        self.stand.log.clear()
        self.assertEqual(self.run_push()[0], 1)
        self.assertEqual(self.stand.puts(), ["s/bbb.json.enc"])

    def test_the_state_file_holds_hashes_and_the_address_only(self):
        self.run_push()
        raw = self.state.read_text()
        state = json.loads(raw)
        self.assertEqual(state["url"], self.stand.url)
        self.assertEqual(state["files"]["s/aaa.json.enc"], hashlib.sha256(sealed("a")).hexdigest())
        self.assertNotIn(KEY, raw)
        self.assertEqual(oct(self.state.stat().st_mode & 0o777), "0o600")
        # Another address starts over: everything is sent.
        other = StandIn()
        self.addCleanup(other.close)
        self.assertEqual(push.push_folder(self.folder, push.Remote(other.url, KEY, sleep=lambda s: None), self.state)[0], 7)

    def test_a_wrong_or_revoked_key_stops_the_run_with_nothing_sent_and_no_key_in_the_message(self):
        stand_key = "hrk_" + "z" * 43
        for key in (stand_key, KEY[:-1], ""):
            with self.assertRaises(push.PushError) as caught:
                push.push_folder(self.folder, self.remote(key), self.state)
            self.assertIn("refused the upload key", str(caught.exception))
            self.assertNotIn(key or "\0", str(caught.exception))
        self.assertEqual(self.stand.puts(), [])
        self.assertFalse(self.state.exists() and json.loads(self.state.read_text())["files"], "nothing is remembered as sent")

    def test_a_redirect_is_refused_and_the_key_goes_nowhere_else(self):
        elsewhere = StandIn()
        self.addCleanup(elsewhere.close)
        self.stand.mode, self.stand.redirect_to = "redirect", elsewhere.url + "/api/objects"
        with self.assertRaises(push.PushError) as caught:
            self.run_push()
        self.assertIn("redirect", str(caught.exception))
        self.assertEqual(elsewhere.log, [], "the second server was never contacted, so it never saw the key")

    def test_a_busy_app_is_tried_again_and_a_dead_one_is_reported_without_the_address_path(self):
        self.stand.fail_puts = 2
        self.assertEqual(self.run_push()[0], 7)
        self.stand.fail_puts = 10
        (self.folder / "s/aaa.json.enc").write_bytes(sealed("A"))
        with self.assertRaises(push.PushError) as caught:
            self.run_push()
        self.assertIn("HTTP 503", str(caught.exception))
        # The failed object is not remembered as sent, so the next run sends it.
        self.stand.fail_puts = 0
        self.assertEqual(self.run_push()[0], 1)
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        dead = f"http://127.0.0.1:{sock.getsockname()[1]}"
        sock.close()
        with self.assertRaises(push.PushError) as caught:
            push.push_folder(self.folder, push.Remote(dead, KEY, sleep=lambda s: None), self.state)
        self.assertIn("Could not reach 127.0.0.1", str(caught.exception))

    def test_a_folder_with_no_sealed_copy_is_not_pushed(self):
        empty = self.root / "empty"
        empty.mkdir()
        with self.assertRaises(push.PushError):
            push.push_folder(empty, self.remote(), self.state)
        (empty / "s").mkdir()
        (empty / "s/x.json.enc").write_bytes(sealed("x"))
        with self.assertRaises(push.PushError):
            push.push_folder(empty, self.remote(), self.state)
        self.assertEqual(self.stand.puts(), [])

    def test_only_the_names_the_app_takes_are_sent(self):
        for name in ("manifest.json", "pane-labels.json", "s/plain.json", "s/.x.json.enc.1.partial", "q/00000000-0000-4000-8000-000000000003.json.enc", "x/y.json.enc"):
            path = self.folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"{}")
        self.run_push()
        self.assertEqual(sorted(self.stand.store), sorted(["k/params.json", "index.json.enc", "index.html", "s/aaa.json.enc", "s/bbb.json.enc", "d/ddd.json.enc", "f/2026-W43.json.enc"]))


class AddressAndKeyTest(unittest.TestCase):
    def test_only_https_or_this_machine_is_accepted(self):
        for url in ("https://reader.example.test", "https://reader.example.test/", "http://127.0.0.1:8000", "http://localhost:3000"):
            push.check_url(url)
        for url in ("http://reader.example.test", "ftp://reader.example.test", "https://user:pw@reader.example.test", "https://reader.example.test?x=1", "", None, "reader.example.test"):
            with self.assertRaises(push.PushError, msg=str(url)):
                push.check_url(url)

    def test_the_key_comes_from_the_environment_then_the_keychain_and_is_never_printed(self):
        self.assertEqual(push.find_key({push.KEY_ENV: f" {KEY}\n"}), KEY)
        calls = []

        def keychain(argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout=KEY + "\n", stderr="")

        with mock.patch.object(sys, "platform", "darwin"):
            self.assertEqual(push.find_key({"USER": "someone"}, run=keychain, isatty=lambda: False), KEY)
            self.assertEqual(calls[0][:2], ["/usr/bin/security", "find-generic-password"])
            self.assertIn("-w", calls[0])
            self.assertIn(push.KEYCHAIN_SERVICE, calls[0])
            missing = lambda argv, **kw: subprocess.CompletedProcess(argv, 44, stdout="", stderr="not found")
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err), self.assertRaises(push.PushError) as caught:
                push.find_key({"USER": "someone"}, run=missing, isatty=lambda: False)
            self.assertIn(push.KEYCHAIN_SERVICE, str(caught.exception))
        self.assertNotIn(KEY, out.getvalue() + err.getvalue())

    def test_the_key_never_reaches_sync_py_or_the_output_of_a_failed_run(self):
        stand = StandIn(key="hrk_" + "other" * 8)
        self.addCleanup(stand.close)
        with tempfile.TemporaryDirectory() as tmp:
            folder = make_folder(Path(tmp))
            env = {**os.environ, push.KEY_ENV: KEY}
            result = subprocess.run([sys.executable, str(HERE / "push.py"), stand.url, "--push-only", "--folder", str(folder), "--state", str(Path(tmp) / "state.json")],
                                    env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("refused the upload key", result.stderr)
        self.assertNotIn(KEY, result.stdout + result.stderr)
        # With a build step, the child is given the environment without the key.
        seen = {}

        def fake_run(argv, env=None, **kwargs):
            seen["env"] = env
            return subprocess.CompletedProcess(argv, 2)

        with mock.patch.dict(os.environ, {push.KEY_ENV: KEY}), mock.patch.object(push.subprocess, "run", fake_run), redirect_stderr(io.StringIO()):
            self.assertEqual(push.main([stand.url, "--folder", "/nonexistent"]), 2)
        self.assertNotIn(push.KEY_ENV, seen["env"])


@unittest.skipUnless(subprocess.run(["which", "node"], capture_output=True).returncode == 0, "needs Node")
class RealAppTest(unittest.TestCase):
    """push.py against the real app (replit/main.js) on a folder store, on 127.0.0.1."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = self.root / "store"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.env = {**os.environ, "OBJECT_STORE_DIR": str(self.store), "APP_URL": f"http://127.0.0.1:{self.port}", "OIDC_ISSUER": "http://127.0.0.1:9",
                    "OIDC_CLIENT_ID": "test-client", "OIDC_CLIENT_SECRET": "placeholder", "SESSION_SECRET": "p" * 40, "ALLOWED_EMAILS": "owner@example.com",
                    "PORT": str(self.port), "HOST": "127.0.0.1"}
        made = subprocess.run(["node", str(HERE / "replit" / "keys-cli.js"), "create", "test"], env=self.env, capture_output=True, text=True, check=True)
        self.key = made.stdout.strip().splitlines()[1]
        self.id = re.search(r"Key ([0-9a-f]{12})", made.stdout).group(1)
        self.app = subprocess.Popen(["node", str(HERE / "replit" / "main.js")], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.addCleanup(self.stop)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)
        self.url = f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.app.terminate()
        self.app.wait(timeout=10)
        self.app.stdout.close()

    def test_real_sealed_objects_go_through_and_land_byte_for_byte(self):
        folder = self.root / "sealed"
        passphrase = {"HOSTED_READER_PASSPHRASE": "a made-up passphrase"}
        lines = [json.dumps({"path": "s/aaa.json", "text": json.dumps({"exchanges": ["synthetic"]})}), json.dumps({"path": "index.json", "text": json.dumps({"conversations": []})})]
        sealing = subprocess.run(["node", str(HERE / "upload.js"), str(folder)], input="\n".join(lines) + "\n", env={**os.environ, **passphrase}, capture_output=True, text=True)
        self.assertEqual(sealing.returncode, 0, sealing.stderr)
        (folder / "index.html").write_bytes(SHELL)
        sent, removed, same = push.push_folder(folder, push.Remote(self.url, self.key), self.root / "state.json")
        self.assertEqual((sent, removed, same), (4, 0, 0))
        for name in ("k/params.json", "index.json.enc", "s/aaa.json.enc", "index.html"):
            self.assertEqual((self.store / name).read_bytes(), (folder / name).read_bytes(), name)
        self.assertEqual(push.push_folder(folder, push.Remote(self.url, self.key), self.root / "state.json"), (0, 0, 4))
        # The sync pruned a conversation: it goes from the app too.
        (folder / "s/aaa.json.enc").unlink()
        self.assertEqual(push.push_folder(folder, push.Remote(self.url, self.key), self.root / "state.json")[1], 1)
        self.assertFalse((self.store / "s/aaa.json.enc").exists())

    def test_a_revoked_key_is_refused_by_the_real_app_at_once(self):
        folder = make_folder(self.root)
        self.assertEqual(push.push_folder(folder, push.Remote(self.url, self.key), self.root / "state.json")[0], 7)
        subprocess.run(["node", str(HERE / "replit" / "keys-cli.js"), "revoke", self.id], env=self.env, capture_output=True, text=True, check=True)
        (folder / "s/aaa.json.enc").write_bytes(sealed("A"))
        with self.assertRaises(push.PushError) as caught:
            push.push_folder(folder, push.Remote(self.url, self.key), self.root / "state.json")
        self.assertIn("refused the upload key", str(caught.exception))
        self.assertEqual((self.store / "s/aaa.json.enc").read_bytes(), sealed("a"))

    def test_plain_content_is_refused_by_the_real_app(self):
        folder = make_folder(self.root, {"s/plain.json.enc": b'{"exchanges":[{"text":"plain"}]}'})
        with self.assertRaises(push.PushError) as caught:
            push.push_folder(folder, push.Remote(self.url, self.key), self.root / "state.json")
        self.assertIn("422", str(caught.exception))
        self.assertFalse((self.store / "s/plain.json.enc").exists())


if __name__ == "__main__":
    unittest.main()
