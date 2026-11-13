"""A lab store for the board's thread tests: the S1 ingest run over synthetic Claude logs in a scratch folder, so the board reads the real versioned
views of a real (small) store. Nothing here touches a real log, the real store or a real Firstmate home."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # setup/transcript-reader
for extra in (ROOT / "store", ROOT / "store" / "tests"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

import synth  # noqa: E402
from rstore import config, db, ingest  # noqa: E402

T0 = synth.T0


class Lab:
    """A synthetic home of session logs and the store ingested from it. `session(...)` writes one log; `ingest()` reads them all into the store."""

    def __init__(self):
        self.home = synth.make_home()
        self.root = Path(tempfile.mkdtemp(prefix="board-labstore-"))
        self.db_path = config.paths(self.root).db
        self.conn = db.connect(self.db_path)
        self.n = 0

    def session(self, cwd: str, turns: list, base: float = T0):
        """turns: (input text, reply text, optional tool command) - the reply is the turn's only assistant text."""
        self.n += 1
        records = [synth.c_owner()]
        for i, turn in enumerate(turns):
            text, reply = turn[0], turn[1]
            command = turn[2] if len(turn) > 2 else None
            at = base + i * 600
            # a real uuid's first eight characters differ from turn to turn (the board's turn ids are those prefixes)
            records.append(synth.c_user(text, at, uuid=f"{self.n:02x}{i:06x}-0000-4000-8000-{self.n:04d}{i:08d}", cwd=cwd))
            if command:
                records.append(synth.c_tool("Bash", {"command": command}, at + 10, f"call{self.n}-{i}", cwd=cwd))
                records.append(synth.c_result(f"call{self.n}-{i}", "ok", at + 20, cwd=cwd))
            records.append(synth.c_say(reply, at + 50, cwd=cwd))
        project = "-" + cwd.strip("/").replace("/", "-")
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(self.n), project=project), records)
        return synth.sid(self.n)

    def ingest(self):
        ingest.Ingester(self.conn, config.Settings(), self.home).scan()
        return self

    def close(self):
        self.conn.close()
