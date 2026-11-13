#!/usr/bin/env python3
"""The Tasks board's data layer. `board_cli.py --help` lists the commands; design and routes: board/README.md. Read-only."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from board.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
