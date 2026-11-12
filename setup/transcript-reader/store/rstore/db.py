"""Opening the store: owner-only files, WAL, one writer, explicit transactions."""

from __future__ import annotations

import contextlib
import fcntl
import os
import sqlite3
import time
from pathlib import Path

from . import config, schema


def connect(db_path: Path, *, create: bool = True, readonly: bool = False) -> sqlite3.Connection:
    """The store at <db_path>, created (owner-only, at the current schema) when it is missing and <create> is set.

    The connection is in autocommit mode: a caller opens a transaction with `transaction(conn)`, so a half-done unit of work is never
    committed by accident. WAL lets a reader (a CLI, a diff job, later the API) read while the ingest writes.
    """
    db_path = Path(db_path)
    exists = db_path.exists()
    if not exists and not create:
        raise FileNotFoundError(f"no store at {db_path}")
    if not exists:
        config.private_folder(db_path.parent)
        fd = os.open(db_path, os.O_WRONLY | os.O_CREAT, 0o600)  # owner-only from the first byte, whatever the umask
        os.close(fd)
    os.chmod(db_path, 0o600)
    if readonly:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, isolation_level=None, timeout=30, check_same_thread=False)
    else:
        conn = sqlite3.connect(db_path, isolation_level=None, timeout=30, check_same_thread=False)  # one thread at a time: a process hands its connection over, never shares it
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    if not readonly:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = FULL")  # the store may hold the only copy of a session: a commit is on disk
        conn.execute("PRAGMA secure_delete = ON")  # `forget` removes the text from the file (it rebuilds the search index and vacuums)
        if schema.version_of(conn) == 0 and not conn.execute("SELECT name FROM sqlite_master WHERE name = 'meta'").fetchone():
            schema.create(conn)
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('created_at', ?)", (str(time.time()),))
        else:
            schema.migrate(conn)
            schema.ensure_fts_settings(conn)
        for suffix in ("-wal", "-shm"):
            side = Path(str(db_path) + suffix)
            if side.exists():
                os.chmod(side, 0o600)
    else:
        found = schema.version_of(conn)
        if found > schema.SCHEMA_VERSION:
            raise RuntimeError(f"the store is schema version {found}; this code knows {schema.SCHEMA_VERSION}")
    return conn


@contextlib.contextmanager
def transaction(conn: sqlite3.Connection):
    """One unit of work, all or nothing. A kill in the middle leaves the store as it was before the unit began."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


@contextlib.contextmanager
def single_writer(lock_path: Path):
    """The ingest process holds this for its whole life: two ingests on one store would interleave cursors. Fails at once when held."""
    config.private_folder(Path(lock_path).parent)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError(f"another ingest holds {lock_path}") from None
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode())
        yield
    finally:
        os.close(fd)  # closing the descriptor releases the lock


def bump(conn: sqlite3.Connection, name: str, key: str, by: int = 1, now: float | None = None) -> None:
    """Add to a counter (skip and unknown-record counters). Call inside the transaction that did the thing counted."""
    conn.execute(
        "INSERT INTO counters(name, key, count, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(name, key) DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at",
        (name, key, by, now if now is not None else time.time()),
    )


def file_event(conn: sqlite3.Connection, kind: str, source_id: int | None, detail: dict | None = None, now: float | None = None) -> None:
    import json

    conn.execute(
        "INSERT INTO file_events(at, source_id, kind, detail) VALUES (?, ?, ?, ?)",
        (now if now is not None else time.time(), source_id, kind, json.dumps(detail or {}, sort_keys=True)),
    )
    bump(conn, "file_event", kind, now=now)
