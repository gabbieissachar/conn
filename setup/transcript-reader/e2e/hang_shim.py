#!/usr/bin/env python3
"""Runs reader.py as the reader's server starts it (`python3 -I reader.py worker`), in a world where opening or listing anything under
LAB_HANG_DIR never returns: macOS waiting on a permission dialog nobody has answered for ~/Downloads, which is what stopped the owner's reader
(sync-hang-check.js). Any other command is run as it is. Used only by that check; the owner's reader never runs through it.
"""

import builtins
import io
import os
import runpy
import sys
import time

args = sys.argv[1:]
real_python = os.environ["LAB_REAL_PYTHON"]
rest = args[1:] if args[:1] == ["-I"] else args
if not rest or not rest[0].endswith("reader.py"):
    os.execv(real_python, [real_python, *args])

hang = os.path.realpath(os.environ["LAB_HANG_DIR"])


def stuck(path):
    try:
        name = os.path.realpath(os.fspath(path))
    except (TypeError, ValueError):
        return False
    return name == hang or name.startswith(hang + os.sep)


def hang_forever():
    while True:
        time.sleep(3600)


def guard(call, reading_only):
    def guarded(target=".", *a, **k):
        mode = a[0] if a else k.get("mode", "r")
        if isinstance(target, (str, os.PathLike)) and stuck(target) and (not reading_only or not any(flag in str(mode) for flag in "wax+")):
            hang_forever()
        return call(target, *a, **k)
    return guarded


io.open = builtins.open = guard(io.open, True)
os.scandir = guard(os.scandir, False)
os.listdir = guard(os.listdir, False)
reader = rest[0]
sys.argv = [reader, *rest[1:]]
runpy.run_path(reader, run_name="__main__")
