#!/usr/bin/env python3
"""CPU time and bytes written by running processes, from macOS's proc_pid_rusage (no sudo: the owner's own processes), for the lab's measurements.

  rusage_probe.py <pid> [<pid> ...]     one JSON line: { "<pid>": { "cpu_s": ..., "written": <bytes>, "read": <bytes> }, ... }

`written` is the disk traffic the process asked the kernel to write (ri_diskio_byteswritten: cumulative, so a measurement is the difference of two
reads). A process that is gone is left out. Reads nothing but the kernel's counters.
"""
import ctypes
import ctypes.util
import json
import sys


class RusageV2(ctypes.Structure):
    _fields_ = [("ri_uuid", ctypes.c_uint8 * 16), ("ri_user_time", ctypes.c_uint64), ("ri_system_time", ctypes.c_uint64),
                ("ri_pkg_idle_wkups", ctypes.c_uint64), ("ri_interrupt_wkups", ctypes.c_uint64), ("ri_pageins", ctypes.c_uint64),
                ("ri_wired_size", ctypes.c_uint64), ("ri_resident_size", ctypes.c_uint64), ("ri_phys_footprint", ctypes.c_uint64),
                ("ri_proc_start_abstime", ctypes.c_uint64), ("ri_proc_exit_abstime", ctypes.c_uint64),
                ("ri_child_user_time", ctypes.c_uint64), ("ri_child_system_time", ctypes.c_uint64),
                ("ri_child_pkg_idle_wkups", ctypes.c_uint64), ("ri_child_interrupt_wkups", ctypes.c_uint64), ("ri_child_pageins", ctypes.c_uint64),
                ("ri_child_elapsed_abstime", ctypes.c_uint64), ("ri_diskio_bytesread", ctypes.c_uint64), ("ri_diskio_byteswritten", ctypes.c_uint64)]


class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


def main(pids):
    libc = ctypes.CDLL(ctypes.util.find_library("c"))
    base = Timebase()
    libc.mach_timebase_info(ctypes.byref(base))
    scale = base.numer / base.denom / 1e9
    out = {}
    for pid in pids:
        info = RusageV2()
        if libc.proc_pid_rusage(int(pid), 2, ctypes.byref(info)) != 0:
            continue
        out[str(pid)] = {"cpu_s": (info.ri_user_time + info.ri_system_time) * scale, "written": info.ri_diskio_byteswritten, "read": info.ri_diskio_bytesread}
    print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1:])
