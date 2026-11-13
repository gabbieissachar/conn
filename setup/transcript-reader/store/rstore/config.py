"""Where the store lives and the settings it runs under.

The store is an archive (W1): once Claude deletes a log the store holds the only copy of that session, so the file lives outside the
repository, where a recycled worktree or a rebuilt `out/` folder cannot take it. Default: ~/.config/pmos-transcript-reader/store/.
PMOS_READER_STORE_DIR names another folder (a test, a lab, a measurement); nothing here ever points at the live reader's out/ folder.

Settings are one small JSON file, `settings.json`, in that folder. Every key has a default, so the file may be absent. No secret is a
setting: the backup's key is read from the macOS keychain at the moment it is used (backup.py).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_DIR = Path.home() / ".config" / "pmos-transcript-reader" / "store"
DB_NAME = "reader-store.sqlite"
SETTINGS_NAME = "settings.json"

# The scope policies (W2 = everything). "shopback-only" is kept so the answer can be changed without a code change: it skips a session
# whose log names an owner organisation that is not listed in `shopback_org_uuids`, and any session whose working folder is under one of
# `personal_cwd_prefixes`. Every skip is counted (counters: skipped_source), never silent.
SCOPE_POLICIES = ("everything", "shopback-only")


@dataclass
class Settings:
    """What a run is told. Loaded from settings.json; unknown keys are kept so a newer file survives an older run."""

    scope_policy: str = "everything"
    shopback_org_uuids: list[str] = field(default_factory=list)
    personal_cwd_prefixes: list[str] = field(default_factory=lambda: ["~/workspace/pmos/personal-work", "~/workspace/pmos/on-lab"])
    # Backup (W6, W7): where the encrypted snapshot goes. drive_folder is unset until Google Drive for desktop is signed in.
    drive_folder: str | None = None
    backup_tool: str = "auto"  # auto: age when it is installed, else gpg; or "age" / "gpg"
    keychain_service: str = "pmos-reader-store-backup"
    keychain_account: str = field(default_factory=lambda: os.environ.get("USER", "reader-store"))
    age_recipient: str | None = None  # an age public key (the private key stays in the keychain, for restoring)
    keep_snapshots: int = 14  # staged snapshots beyond this many are reported as old (never deleted by this code)
    # Timing of the long-running ingest.
    scan_seconds: float = 3.0  # how often the logs are listed and changed ones ingested (an idle scan is about 30 ms of CPU)
    reconcile_seconds: float = 60.0  # how often the whole Herdr inventory is read again (events are hints; this is the truth)
    identity_poll_seconds: float = 0.5  # the loop's wake: pid records, Herdr events, panes an event named
    extra: dict = field(default_factory=dict)

    def validate(self) -> None:
        if self.scope_policy not in SCOPE_POLICIES:
            raise ValueError(f"scope_policy must be one of {SCOPE_POLICIES}, not {self.scope_policy!r}")
        if self.backup_tool not in ("auto", "age", "gpg"):
            raise ValueError("backup_tool must be auto, age or gpg")


@dataclass
class Paths:
    """Every file the store keeps, under one folder."""

    root: Path

    @property
    def db(self) -> Path:
        return self.root / DB_NAME

    @property
    def settings(self) -> Path:
        return self.root / SETTINGS_NAME

    @property
    def staging(self) -> Path:
        return self.root / "backup-staging"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def lock(self) -> Path:
        return self.root / "ingest.lock"

    @property
    def reports(self) -> Path:
        return self.root / "reports"


def store_dir(env: dict | None = None) -> Path:
    env = os.environ if env is None else env
    named = env.get("PMOS_READER_STORE_DIR")
    return Path(named).expanduser() if named else DEFAULT_DIR


def paths(root: Path | None = None) -> Paths:
    return Paths(Path(root) if root else store_dir())


def private_folder(folder: Path) -> None:
    """<folder> and any missing parent, readable by the owner alone (the store holds every session's text)."""
    folder = Path(folder)
    if not folder.is_dir():
        private_folder(folder.parent)
        folder.mkdir(mode=0o700, exist_ok=True)
    os.chmod(folder, 0o700)


def load_settings(where: Paths) -> Settings:
    settings = Settings()
    try:
        raw = json.loads(where.settings.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    known = {name for name in Settings.__dataclass_fields__ if name != "extra"}
    for key, value in raw.items():
        if key in known:
            setattr(settings, key, value)
        else:
            settings.extra[key] = value
    settings.validate()
    return settings


def save_settings(where: Paths, settings: Settings) -> None:
    settings.validate()
    private_folder(where.root)
    data = {name: getattr(settings, name) for name in Settings.__dataclass_fields__ if name != "extra"}
    data.update(settings.extra)
    partial = where.settings.with_name(f".{SETTINGS_NAME}.{os.getpid()}.partial")
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(partial, where.settings)
