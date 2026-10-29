#!/usr/bin/env python3
"""Builds the phone end-to-end run's synthetic world and the sealed copy from it (phone-e2e.js runs this).

  python3 setup/transcript-reader/e2e/fixture.py <folder> <passphrase>

Under <folder> it makes a home folder (HOME for everything it runs) holding made-up Claude Code session logs: a main
Firstmate home's conversation that names a markdown file and an HTML sketch (with a stylesheet, a script and a picture beside
it), and one of the owner's own sessions under ~/workspace; then runs sync.py --seal against it with a fake Herdr. No real
session log, record or passphrase is read: HOME points at the folder, and the passphrase is the argument.

Prints one JSON line: the ids and paths the driver needs.
"""

import json
import os
import struct
import subprocess
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
READER = HERE.parent
MAIN = "aaaaaaaa-1111-4111-8111-111111111111"
OWN = "ffffffff-6666-4666-8666-666666666666"
NOW = time.time()
T0 = float(int(NOW - 3 * 3600))


def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat().replace("+00:00", "Z")


def user(text, at, cwd):
    return {"type": "user", "timestamp": iso(at), "cwd": cwd, "message": {"role": "user", "content": text}}


def say(text, at, cwd):
    return {"type": "assistant", "timestamp": iso(at), "cwd": cwd, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def write_log(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    os.utime(path, (NOW - 120, NOW - 120))


def png(size, color):
    """A solid-colour PNG, made with zlib alone."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + bytes(color) * size for _ in range(size))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def main(folder: Path, passphrase: str) -> None:
    home = folder / "home"
    main_home = home / "fm-homes" / "pmos"
    workspace = home / "workspace" / "pmos"
    scratch = workspace / "scratch"
    for place in (main_home / "state", main_home / "data", scratch, home / ".claude" / "projects"):
        place.mkdir(parents=True, exist_ok=True)
    (main_home / "notes.md").write_text("# Release notes\n\n## Plan\n\n- Ship the **offline copy**\n- Check it on the phone\n\n| Step | Owner |\n| --- | --- |\n| Download | you |\n| Read | you |\n", encoding="utf-8")
    (scratch / "dot.png").write_bytes(png(48, (31, 95, 209)))
    (scratch / "site.css").write_text("body { font-family: sans-serif; margin: 16px; background: #fffbe6 url(dot.png) no-repeat right top; } h1 { color: #b4232d; }", encoding="utf-8")
    (scratch / "app.js").write_text("document.getElementById('out').textContent = 'The sketch ran its own script. origin=' + origin;", encoding="utf-8")
    (scratch / "sketch.html").write_text(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sketch</title><link rel="stylesheet" href="site.css"><script src="app.js" defer></script></head>'
        '<body><h1>Offline sketch</h1><p id="out">The script has not run.</p><img id="pic" src="dot.png" alt="a blue square" width="48" height="48">'
        '<p id="net">Network check: waiting</p><script>fetch("https://example.com/").then(()=>{document.getElementById("net").textContent="Network check: LEAKED"},()=>{document.getElementById("net").textContent="Network check: blocked"})</script></body></html>', encoding="utf-8")
    main_cwd, own_cwd = str(main_home), str(workspace)
    pointer = f"{main_home / 'notes.md'}"
    write_log(home / ".claude" / "projects" / "main" / f"{MAIN}.jsonl", [
        user("Can you draft the release notes and a sketch of the new screen?", T0, main_cwd),
        say(f"Drafted the notes in `~/fm-homes/pmos/notes.md` and a sketch at `~/workspace/pmos/scratch/sketch.html`.\n\n| Part | State |\n| --- | --- |\n| Notes | **done** |\n| Sketch | done |\n\nShould I send the notes to the team?", T0 + 60, main_cwd),
        user("Yes, but keep it short.", T0 + 300, main_cwd),
        say("Sent a short version.\n\n```\nsent: release-notes-short\n```", T0 + 330, main_cwd),
    ])
    write_log(home / ".claude" / "projects" / "own" / f"{OWN}.jsonl", [
        user("Tidy the scratch folder.", T0 + 600, own_cwd),
        say("Done. Nothing needed deleting.", T0 + 640, own_cwd),
    ])
    env = {**os.environ, "HOME": str(home), "PATH": f"{folder / 'bin'}{os.pathsep}{os.environ['PATH']}", "HOSTED_READER_PASSPHRASE": passphrase,
           "FAKE_HERDR_SESSION": MAIN, "FAKE_HERDR_LOG": str(folder / "herdr.log")}
    (folder / "bin").mkdir(exist_ok=True)
    herdr = folder / "bin" / "herdr"
    herdr.write_text(f"#!/bin/sh\nexec node {HERE / 'fake-herdr.js'} \"$@\"\n", encoding="utf-8")
    herdr.chmod(0o755)
    out = folder / "out"
    done = subprocess.run([sys.executable, str(READER / "sync.py"), "--seal", str(out / "bucket"), "--out", str(out / "hosted"), "--main-home", str(main_home), "--workspace", str(home / "workspace")],
                          capture_output=True, text=True, env=env, cwd=str(READER.parent.parent))
    if done.returncode:
        sys.stderr.write(done.stdout + done.stderr)
        raise SystemExit(done.returncode)
    print(json.dumps({"home": str(home), "out": str(out), "main": MAIN, "own": OWN, "log": str(folder / "herdr.log"), "bin": str(folder / "bin")}))


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve(), sys.argv[2])
