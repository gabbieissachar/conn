"""Private state-file policy shared by the Herdr sidecars."""

from __future__ import annotations

import stat
from pathlib import Path


PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


def _secure_default_directory(path: Path) -> None:
    try:
        if path.is_symlink():
            raise OSError("symbolic links are not allowed")
        path.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
        path.chmod(PRIVATE_DIR_MODE)
        if not path.is_dir() or stat.S_IMODE(path.stat().st_mode) != PRIVATE_DIR_MODE:
            raise OSError(f"mode is not {PRIVATE_DIR_MODE:o}")
    except OSError as exc:
        raise SystemExit(f"private Herdr agent state directory is not secure: {path}: {exc}") from exc


def _validate_explicit_parent(path: Path) -> None:
    parent = path.parent
    try:
        if parent.is_symlink():
            raise OSError("symbolic links are not allowed")
        if not parent.exists():
            raise OSError("parent directory does not exist")
        if not parent.is_dir():
            raise OSError("parent path is not a directory")
        if stat.S_IMODE(parent.stat().st_mode) != PRIVATE_DIR_MODE:
            raise OSError(f"parent directory mode is not {PRIVATE_DIR_MODE:o}")
    except OSError as exc:
        raise SystemExit(f"private Herdr agent state parent is not secure: {parent}: {exc}") from exc


def ensure_private_file(path: Path, *, default_state_dir: Path) -> None:
    """Validate the parent policy and tighten an existing regular state file."""
    if path.parent == default_state_dir:
        _secure_default_directory(default_state_dir)
    else:
        _validate_explicit_parent(path)
    try:
        if path.is_symlink():
            raise OSError("symbolic links are not allowed")
        if path.exists():
            if not path.is_file():
                raise OSError("path is not a regular file")
            path.chmod(PRIVATE_FILE_MODE)
            if stat.S_IMODE(path.stat().st_mode) != PRIVATE_FILE_MODE:
                raise OSError(f"mode is not {PRIVATE_FILE_MODE:o}")
    except OSError as exc:
        raise SystemExit(f"private Herdr agent state file is not secure: {path}: {exc}") from exc
