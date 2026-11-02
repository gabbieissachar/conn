#!/usr/bin/env python3
"""Sample footprint and CPU of Conn, its `herdr terminal session observe` children and its WebKit helper processes.
Read-only: proc_pid_rusage on pids this script started or found as new WebKit helpers. Same method as the design
study's baseline sampler (phys_footprint = Activity Monitor's Memory column; CPU% = delta CPU time / wall time).

usage: measure.py NAME "CONN_ARGS" SECONDS [SETTLE_SECONDS]
  e.g. measure.py idle "--session esim --web off --select 6" 60
Results go to $CONN_MEASURE_DIR (default ./measurements) as NAME.json.
"""
import ctypes, ctypes.util, json, os, re, signal, subprocess, sys, time

libproc = ctypes.CDLL(ctypes.util.find_library('proc')); libsys = ctypes.CDLL('/usr/lib/libSystem.dylib')
class TB(ctypes.Structure): _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]
tb = TB(); libsys.mach_timebase_info(ctypes.byref(tb))
U64 = ctypes.c_uint64
class RU4(ctypes.Structure):
    _fields_ = [('ri_uuid', ctypes.c_uint8 * 16)] + [(n, U64) for n in (
        'ri_user_time','ri_system_time','ri_pkg_idle_wkups','ri_interrupt_wkups','ri_pageins','ri_wired_size','ri_resident_size',
        'ri_phys_footprint','ri_proc_start_abstime','ri_proc_exit_abstime','ri_child_user_time','ri_child_system_time',
        'ri_child_pkg_idle_wkups','ri_child_interrupt_wkups','ri_child_pageins','ri_child_elapsed_abstime','ri_diskio_bytesread',
        'ri_diskio_byteswritten','ri_cpu_time_qos_default','ri_cpu_time_qos_maintenance','ri_cpu_time_qos_background',
        'ri_cpu_time_qos_utility','ri_cpu_time_qos_legacy','ri_cpu_time_qos_user_initiated','ri_cpu_time_qos_user_interactive',
        'ri_billed_system_time','ri_serviced_system_time','ri_logical_writes','ri_lifetime_max_phys_footprint','ri_instructions',
        'ri_cycles','ri_billed_energy','ri_serviced_energy','ri_interval_max_phys_footprint','ri_runnable_time')]

def ru(pid):
    r = RU4()
    return r if libproc.proc_pid_rusage(pid, 4, ctypes.byref(r)) == 0 else None

def ps_rows():
    out = subprocess.run(['ps', '-axo', 'pid=,ppid=,command='], capture_output=True, text=True).stdout
    for line in out.splitlines():
        m = re.match(r'\s*(\d+)\s+(\d+)\s+(.*)', line)
        if m: yield int(m.group(1)), int(m.group(2)), m.group(3)

def webkit_helpers():
    out = {}
    for pid, _, cmd in ps_rows():
        m = re.search(r'com\.apple\.WebKit\.(WebContent|GPU|Networking)', cmd)
        if m: out[pid] = m.group(1)
    return out

def listening_pid(port):
    out = subprocess.run(['lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN', '-t'], capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else None

def descendants(root, rows):
    kids = {}
    for pid, ppid, _ in rows: kids.setdefault(ppid, []).append(pid)
    out, stack = [], [root]
    while stack:
        for k in kids.get(stack.pop(), []): out.append(k); stack.append(k)
    return out

def server_targets():
    """What keeps running next to the app: the Herdr server, the reader (and its worker) and the organizer. Measured in the
    same window as the app, never borrowed from an earlier study. The Herdr server is required: its CPU is where pane
    streams are paid for."""
    rows = list(ps_rows())
    t = {}
    env_pid = os.environ.get('CONN_MEASURE_SERVER_PID')
    herdr = [pid for pid, _, cmd in rows if cmd.rstrip().endswith('herdr server')]
    pid = int(env_pid) if env_pid else (herdr[0] if len(herdr) == 1 else None)
    if pid is None:
        sys.exit(f'measure.py: cannot pick the Herdr server pid ({len(herdr)} candidates); set CONN_MEASURE_SERVER_PID')
    t[f'server-herdr-{pid}'] = pid
    for name, port in (('reader', 8768), ('organizer', 8765)):
        p = listening_pid(port)
        if p:
            t[f'server-{name}-{p}'] = p
            for d in descendants(p, rows): t[f'server-{name}-worker-{d}'] = d
    return t

def main():
    name, args, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
    settle = float(sys.argv[4]) if len(sys.argv) > 4 else 12
    here = os.path.dirname(os.path.abspath(__file__))
    app = os.path.join(here, '..', 'build/Conn.app/Contents/MacOS/Conn')
    before = webkit_helpers()
    noapp = os.environ.get('CONN_MEASURE_NOAPP') == '1'     # servers alone, for paired with/without windows
    p = None if noapp else subprocess.Popen([app], env={**os.environ, 'CONN_ARGS': args}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1 if noapp else settle)
    targets = {} if noapp else {'app': p.pid}
    if os.environ.get('CONN_MEASURE_SERVERS', '1') == '1': targets.update(server_targets())
    for pid, ppid, cmd in ([] if noapp else ps_rows()):
        if ppid == p.pid and 'herdr' in cmd.lower() and 'observe' in cmd: targets[f'observer-{pid}'] = pid
    for pid, kind in ({} if noapp else webkit_helpers()).items():
        if pid not in before: targets[f'webkit-{kind}-{pid}'] = pid
    rows = []; t_end = time.time() + seconds; interval = 2.0
    while True:
        t = time.time(); snap = {}
        for k, pid in targets.items():
            r = ru(pid)
            if r: snap[k] = (r.ri_phys_footprint, (r.ri_user_time + r.ri_system_time) * tb.numer // tb.denom)
        rows.append((t, snap))
        if t >= t_end: break
        time.sleep(max(0, interval - (time.time() - t)))
    if p:
        p.send_signal(signal.SIGTERM)
        try: p.wait(10)
        except Exception: p.kill()
    span = rows[-1][0] - rows[0][0]
    groups = {}
    for k in targets:
        g = 'app' if k == 'app' else 'observers' if k.startswith('observer') else 'webkit' if k.startswith('webkit') else k.split('-')[0] + '-' + k.split('-')[1]
        groups.setdefault(g, []).append(k)
    result = {'name': name, 'args': args, 'seconds': round(span), 'samples': len(rows), 'groups': {}}
    tot_fp = [0.0] * len(rows); tot_cpu = 0.0
    for g, keys in groups.items():
        fps = [sum(r[1][k][0] for k in keys if k in r[1]) / 1e6 for r in rows]
        cpu = 0.0
        for k in keys:
            ends = [r[1][k][1] for r in rows if k in r[1]]
            if len(ends) > 1: cpu += 100 * (ends[-1] - ends[0]) / 1e9 / span
        result['groups'][g] = {'processes': len(keys), 'footprint_mb_mean': round(sum(fps) / len(fps), 1), 'footprint_mb_max': round(max(fps), 1), 'cpu_percent': round(cpu, 2)}
        for i, v in enumerate(fps): tot_fp[i] += v
        tot_cpu += cpu
    result['app_footprint_series_mb'] = [round(r[1]['app'][0] / 1e6, 1) for r in rows if 'app' in r[1]]
    result['total'] = {'footprint_mb_mean': round(sum(tot_fp) / len(tot_fp), 1), 'footprint_mb_max': round(max(tot_fp), 1), 'cpu_percent': round(tot_cpu, 2)}
    own = [g for g in result['groups'] if not g.startswith('server-')]
    result['conn_only'] = {'footprint_mb_mean': round(sum(result['groups'][g]['footprint_mb_mean'] for g in own), 1),
                           'cpu_percent': round(sum(result['groups'][g]['cpu_percent'] for g in own), 2)}
    print(json.dumps(result, indent=1))
    outdir = os.environ.get('CONN_MEASURE_DIR', os.path.join(here, '..', 'measurements'))
    os.makedirs(outdir, exist_ok=True)
    out = os.path.join(outdir, f'{name}.json')
    with open(out, 'w') as f: json.dump(result, f, indent=1)

main()
