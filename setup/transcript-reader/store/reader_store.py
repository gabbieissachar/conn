#!/usr/bin/env python3
"""The transcript reader's shadow store: ingest, identity, backup and the validation tooling. `reader_store.py --help` lists the commands.

Design and operations: store/README.md. Run from anywhere; the store lives in ~/.config/pmos-transcript-reader/store (PMOS_READER_STORE_DIR
names another folder). Nothing reads this store yet: the live reader, port 8768 and every pane are untouched.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from rstore.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
