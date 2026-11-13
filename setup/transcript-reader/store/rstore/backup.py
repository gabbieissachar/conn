"""The backup (W6, W7): a SQLite `.backup` snapshot, encrypted before it leaves the store's folder, the key in the macOS keychain.

The store is the only copy of a session once Claude deletes its log, so it is backed up nightly:

  1. snapshot   SQLite's online backup API copies a consistent image of the live store into a temporary file in the staging folder
                (owner-only). The ingest may keep writing meanwhile.
  2. encrypt    the image is encrypted to <staging>/reader-store-<UTC time>.sqlite.<age|gpg>, and the plain image is removed at once
                (this is the one place this code deletes a file, and only its own temporary image). The tool is age when it is
                installed (it encrypts to a public key; the private key stays in the keychain and is needed only to restore), else gpg
                (symmetric AES-256; the passphrase is read from the keychain and handed to gpg on its standard input, never in an
                argument, never in the environment, never in a file, never printed).
  3. stage      the encrypted file stays in the staging folder: that is where a restore finds it.
  4. upload     the encrypted file is copied to the Drive folder setting (`drive_folder`), a Google Drive for desktop folder, so Drive
                holds ciphertext only. Until that folder is set and exists, this step stops and says so (`drive_not_configured`);
                steps 1 to 3 do not wait for it. The folder must belong to a ShopBack Drive account (`GoogleDrive-<name>@shopback.com`
                in its path) unless `drive_allow_any` is set in settings.json: a personal Drive is refused, not guessed.

Nothing here writes to the keychain: creating the key is a live write that a person approves (`init_key_command` prints it).
Old snapshots are reported (`older_than`), never deleted.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config, db

SECURITY_ENV = "RSTORE_SECURITY"  # the `security` program that reads the keychain (a test names a fake; the default is macOS's own)
GPG_ENV = "RSTORE_GPG"
AGE_ENV = "RSTORE_AGE"


class BackupError(RuntimeError):
    """A step that cannot go on; the message says what is missing and never includes a secret."""


def tool_path(name: str, env_name: str) -> str | None:
    named = os.environ.get(env_name)
    if named:
        return named if os.access(named, os.X_OK) else None
    return shutil.which(name)


def choose_tool(settings: config.Settings) -> tuple[str, str]:
    """(tool name, its path): age when installed, else gpg, or the one the setting names."""
    wanted = settings.backup_tool
    if wanted in ("auto", "age"):
        age = tool_path("age", AGE_ENV)
        if age and (wanted == "age" or settings.age_recipient):
            return "age", age
        if wanted == "age":
            raise BackupError("backup_tool is age but age is not installed (or no age_recipient is set)")
    gpg = tool_path("gpg", GPG_ENV)
    if gpg:
        return "gpg", gpg
    raise BackupError("neither age nor gpg is installed: nothing can encrypt the snapshot, so none is made")


def keychain_secret(settings: config.Settings) -> str:
    """The backup key from the login keychain, or a BackupError naming the item to create. Read at the moment of use."""
    security = os.environ.get(SECURITY_ENV) or "/usr/bin/security"
    try:
        done = subprocess.run([security, "find-generic-password", "-w", "-s", settings.keychain_service, "-a", settings.keychain_account],
                              capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupError(f"the keychain could not be read ({type(error).__name__})") from None
    secret = done.stdout.rstrip("\n") if done.returncode == 0 else ""
    if not secret:
        raise BackupError(f"no backup key in the keychain (item {settings.keychain_service}, account {settings.keychain_account}); create it: {init_key_command(settings)}")
    return secret


def init_key_command(settings: config.Settings) -> str:
    """The exact command that creates the keychain item. It is a live write: a person runs it, once. `-w` with no value asks for the
    passphrase at the terminal, so it is never in a process listing or a shell history."""
    return f'security add-generic-password -a "{settings.keychain_account}" -s "{settings.keychain_service}" -w'


def utc_stamp(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def snapshot(db_path: Path, dest: Path) -> None:
    """A consistent copy of the live store at <dest> (owner-only), by SQLite's online backup API, checked before it is trusted."""
    config.private_folder(dest.parent)
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.close(fd)
    source = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=60)
    target = sqlite3.connect(dest)
    try:
        source.backup(target)
        target.execute("PRAGMA journal_mode = DELETE")
        found = target.execute("PRAGMA integrity_check").fetchone()[0]
        if found != "ok":
            raise BackupError(f"the snapshot failed its integrity check ({found}); it was not kept")
    finally:
        target.close()
        source.close()
    os.chmod(dest, 0o600)


def encrypt(plain: Path, out: Path, settings: config.Settings) -> str:
    """Encrypt <plain> to <out>; returns the tool used. The partial file is only renamed into place when the tool succeeded."""
    tool, path = choose_tool(settings)
    partial = out.with_name(f".{out.name}.partial")
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.close(fd)
    try:
        if tool == "age":
            done = subprocess.run([path, "-r", settings.age_recipient, "-o", str(partial), str(plain)], capture_output=True, timeout=3600)
        else:
            secret = keychain_secret(settings)
            done = subprocess.run([path, "--batch", "--yes", "--quiet", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--symmetric",
                                   "--cipher-algo", "AES256", "--compress-algo", "none", "-o", str(partial), str(plain)],
                                  input=secret.encode(), capture_output=True, timeout=3600)
        if done.returncode != 0:
            raise BackupError(f"{tool} failed to encrypt the snapshot (exit {done.returncode}); nothing was staged")
        if not partial.stat().st_size:
            raise BackupError(f"{tool} wrote an empty file; nothing was staged")
        os.replace(partial, out)
    finally:
        if partial.exists():
            partial.unlink()
    os.chmod(out, 0o600)
    return tool


def decrypt(encrypted: Path, out: Path, settings: config.Settings) -> None:
    """The restore: encrypted file to plain SQLite file. gpg reads the same keychain item; age needs the identity (private key) file
    named by RSTORE_AGE_IDENTITY, which the person fetches from the keychain for this one command."""
    if encrypted.name.endswith(".age"):
        identity = os.environ.get("RSTORE_AGE_IDENTITY")
        age = tool_path("age", AGE_ENV)
        if not (identity and age):
            raise BackupError("restoring an age file needs age and RSTORE_AGE_IDENTITY (a file holding the private key)")
        done = subprocess.run([age, "-d", "-i", identity, "-o", str(out), str(encrypted)], capture_output=True, timeout=3600)
    else:
        gpg = tool_path("gpg", GPG_ENV)
        if not gpg:
            raise BackupError("gpg is not installed")
        secret = keychain_secret(settings)
        done = subprocess.run([gpg, "--batch", "--yes", "--quiet", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--decrypt",
                               "-o", str(out), str(encrypted)], input=secret.encode(), capture_output=True, timeout=3600)
    if done.returncode != 0:
        raise BackupError(f"decryption failed (exit {done.returncode}): wrong key, or not an encrypted snapshot")
    os.chmod(out, 0o600)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def stage(conn: sqlite3.Connection, where: config.Paths, settings: config.Settings, clock=time.time) -> dict:
    """Steps 1 to 3. Returns {snapshot, path, bytes, sha256, tool}. A failed step leaves no half file behind."""
    now = clock()
    config.private_folder(where.staging)
    plain = where.staging / f".plain-{os.getpid()}-{utc_stamp(now)}.sqlite"
    try:
        snapshot(where.db, plain)
        tool, _ = choose_tool(settings)
        out = where.staging / f"reader-store-{utc_stamp(now)}.sqlite.{'age' if tool == 'age' else 'gpg'}"
        encrypt(plain, out, settings)
    finally:
        if plain.exists():
            plain.unlink()  # the only file this code deletes: its own plain image, never left beside the ciphertext
    digest = sha256(out)
    with db.transaction(conn):
        conn.execute("INSERT INTO backups(at, snapshot, bytes, sha256, tool) VALUES (?, ?, ?, ?, ?)", (now, out.name, out.stat().st_size, digest, tool))
    return {"snapshot": out.name, "path": str(out), "bytes": out.stat().st_size, "sha256": digest, "tool": tool}


def drive_problem(settings: config.Settings) -> str | None:
    """Why the upload step cannot run, or None when it can."""
    folder = settings.drive_folder
    if not folder:
        return "drive_not_configured"
    path = Path(folder).expanduser()
    if not path.is_dir():
        return "drive_folder_missing"
    allowed = settings.extra.get("drive_allow_any") is True
    if not allowed and not any(part.startswith("GoogleDrive-") and part.lower().endswith("@shopback.com") for part in path.parts):
        return "drive_folder_not_shopback"
    return None


def upload(conn: sqlite3.Connection, where: config.Paths, settings: config.Settings, encrypted: Path, clock=time.time) -> dict:
    """Step 4. Copies the encrypted file to the Drive folder and checks the copy. Stops, with a plain status, when Drive is not set up."""
    problem = drive_problem(settings)
    if problem:
        return {"status": problem, "uploaded": False}
    folder = Path(settings.drive_folder).expanduser()
    target = folder / encrypted.name
    partial = folder / f".{encrypted.name}.partial"
    shutil.copyfile(encrypted, partial)
    os.replace(partial, target)
    if sha256(target) != sha256(encrypted):
        raise BackupError("the uploaded copy does not match the staged file; it was left for inspection")
    now = clock()
    with db.transaction(conn):
        conn.execute("UPDATE backups SET uploaded_at = ?, upload_to = ? WHERE snapshot = ?", (now, str(folder), encrypted.name))
    return {"status": "uploaded", "uploaded": True, "to": str(target)}


def older_than(where: config.Paths, keep: int) -> list[str]:
    """Staged snapshots beyond the newest <keep>: reported so a person can move them aside. Never deleted here."""
    names = sorted(p.name for p in where.staging.glob("reader-store-*.sqlite.*") if not p.name.startswith("."))
    return names[:-keep] if keep and len(names) > keep else []


def verify(encrypted: Path, settings: config.Settings, scratch: Path) -> dict:
    """Decrypt <encrypted> into <scratch> (a fresh folder) and check the image: integrity, and what it holds."""
    config.private_folder(scratch)
    out = scratch / "restored.sqlite"
    decrypt(encrypted, out, settings)
    conn = sqlite3.connect(f"file:{out}?mode=ro", uri=True)
    try:
        return {"integrity": conn.execute("PRAGMA integrity_check").fetchone()[0],
                "sessions": conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0],
                "turns": conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0],
                "schema_version": conn.execute("PRAGMA user_version").fetchone()[0], "path": str(out)}
    finally:
        conn.close()
