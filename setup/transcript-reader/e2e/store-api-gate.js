#!/usr/bin/env node
'use strict';

// The S2 exit-gate measurements that can be taken in the lab (plan section 3, S2): log write to screen, bytes written per change, idle CPU per open
// page, and how often the reader asks Herdr. By hand (a headless browser, a few minutes), not part of `node --test`:
//
//   node setup/transcript-reader/e2e/store-api-gate.js <scratch folder> <results.json>
//
// The lab is store-api-lab.js's: pane_lab.py's made-up home and fake Herdr, the real store daemon reading it, the reader's server with the store API on.
// The store's scan interval is a setting of the lab's store: the gate's 0.5 s is measured with 0.1 s (and 0.25 s), the owner's own 3 s default is
// measured too and reported beside it, because the daemon polls the logs and that cadence is a floor under any log-write-to-screen number.
// Every number comes with what it was taken with. Nothing real is read or sent; headless only.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { make } = require('./axi');
const { startStoreLab } = require('./store-api-lab');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-store-api-gate'));
const resultsFile = path.resolve(process.argv[3] || path.join(folder, 'gate-results.json'));
const { axi, ev, until, sleep } = make('reader-store-api-gate');
const say = (line) => process.stdout.write(line + '\n');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)] : null; };
const stats = (values) => ({ n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values), min: Math.min(...values) });
const probe = (pids) => JSON.parse(execFileSync('python3', [path.join(__dirname, 'rusage_probe.py'), ...pids.map(String)], { encoding: 'utf8' }));
const sizeOf = (file) => { try { return fs.statSync(file).size; } catch (e) { return 0; } };

// Chrome's own renderer processes (the headless one chrome-devtools-axi started), whose CPU is the page's.
function rendererPids() {
  const list = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n');
  const browsers = list.filter((l) => /puppeteer_dev_chrome_profile/.test(l) && !/--type=/.test(l)).map((l) => Number(l.trim().split(/\s+/)[0]));
  return list.filter((l) => /--type=renderer/.test(l) && /puppeteer_dev_chrome_profile|Renderer/.test(l)).map((l) => l.trim().split(/\s+/).map(Number)).filter(([pid, ppid]) => browsers.includes(ppid) || browsers.length === 0).map(([pid]) => pid);
}

// The page's own token, as the browser holds it (the stream's second witness reads with it).
const tokenOf = () => ev(`return document.querySelector('meta[name=reader-token]').content;`);

// A Node client of the stream: when each event reached it, as a second witness of where the time goes.
function streamClient(port, token, sessionId) {
  const events = [];
  const req = http.request({ host: '127.0.0.1', port, path: `/api/transcript-reader/stream?sessions=${sessionId}`, headers: { Host: 'localhost:' + port, 'x-transcript-reader-token': token } }, (res) => {
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const name = (/^event: (.*)$/m.exec(block) || [])[1];
        const data = (/^data: (.*)$/m.exec(block) || [])[1];
        if (name && data) events.push({ name, at: Date.now(), data: JSON.parse(data) });
      }
    });
  });
  req.end();
  return { events, close: () => req.destroy() };
}

(async () => {
  const lab = await startStoreLab(folder, { bigExchanges: 300, fillers: 30, scanSeconds: 0.1, pollSeconds: 0.05 });
  const crew1 = lab.lab.crew[0];
  const results = { when: new Date().toISOString(), machine: execFileSync('uname', ['-sm'], { encoding: 'utf8' }).trim() + ', node ' + process.version, lab: {} };
  let marker = 1000;
  const note = (key, value) => { results[key] = value; fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1)); say(`${key}: ${JSON.stringify(value)}`); };
  try {
    const found = lab.status();
    results.lab = { sessions: found.counts.sessions, turns: found.counts.turns, events: found.counts.events, conversationTurns: 300, panes: found.counts.panes, storeMB: Math.round(found.bytes / 1e5) / 10 };
    axi('open', 'about:blank'); axi('emulate', '--viewport', '1000x900x1');
    axi('open', lab.main.page + '#s=' + crew1);
    await until(`const S = window.__readerWindowed; return { ok: Boolean(S && S.turns.length) };`, 'the page');
    await sleep(800);
    const token = tokenOf();

    // ----------------------------------------------------------------------------------- 1. log write to screen
    async function latency(label, count, gapMs) {
      const client = streamClient(lab.main.port, token, crew1);
      await sleep(500);
      const writes = new Map();
      for (let i = 0; i < count; i += 1) {
        marker += 1;
        const written = lab.append(crew1, { user: `LAB-MARK-${marker} question ${i}?`, reply: `LAB-MARK-${marker} the answer to ${i}, a few words long enough to be a real reply.` });
        writes.set(marker, written.at);
        await sleep(gapMs);
      }
      await sleep(1500);
      const marks = ev(`return window.__marks;`);
      const screen = [], wire = [];
      for (const [n, at] of writes) {
        if (marks[n]) screen.push(marks[n] - at);
        const hit = client.events.find((e) => e.name === 'turns' && e.data.turns.some((t) => t.input.includes(`LAB-MARK-${n} `) || t.reply.includes(`LAB-MARK-${n} `)));
        if (hit) wire.push(hit.at - at);
      }
      client.close();
      note(label, { scan_seconds: lab.settings.scan_seconds, reconcile_seconds: 3600, writes: count, on_screen: { ...stats(screen), unit: 'ms, log write to drawn on screen' }, event_at_client: { ...stats(wire), unit: 'ms, log write to the stream event at a Node client' } });
    }
    await latency('latency_scan_0.1s', 40, 1300);
    await lab.startDaemon({ scan: 0.25, poll: 0.05 });
    await sleep(1500);
    lab.settings.scan_seconds = 0.25;
    await latency('latency_scan_0.25s', 30, 1300);
    await lab.startDaemon({ scan: 3.0, poll: 0.5 });
    await sleep(1500);
    lab.settings.scan_seconds = 3.0;
    await latency('latency_scan_3s_owner_default', 24, 4200);

    // ----------------------------------------------------------------------------------- 2. bytes written per change
    // Disk bytes the processes of a path asked the kernel to write (proc_pid_rusage), over a window with no change (what the path writes idle) and over
    // a window with N changes: the per-change figure is the difference over N. The store daemon is the writer of the new path, the reader's server
    // (and the reader.py worker it starts) of the old one.
    async function bytesPerChange(label, count, gapMs, pids, files) {
      const idleSeconds = 24;
      const idle0 = probe(pids); const idleStart = Date.now();
      await sleep(idleSeconds * 1000);
      const idle1 = probe(pids); const idleWall = (Date.now() - idleStart) / 1000;
      const sizes = Object.fromEntries(files.map((f) => [f, sizeOf(f)]));
      const before = probe(pids); const start = Date.now();
      for (let i = 0; i < count; i += 1) {
        marker += 1;
        lab.append(crew1, { user: `LAB-MARK-${marker} byte question ${i}?`, reply: `LAB-MARK-${marker} the answer, a few words long enough to be a real reply.` });
        await sleep(gapMs);
      }
      await sleep(3000);
      const after = probe(pids); const wall = (Date.now() - start) / 1000;
      const per = {};
      for (const pid of pids) {
        if (!(before[pid] && after[pid] && idle0[pid] && idle1[pid])) continue;
        const idleRate = (idle1[pid].written - idle0[pid].written) / idleWall;
        const idleCpu = (idle1[pid].cpu_s - idle0[pid].cpu_s) / idleWall;
        per[pid] = {
          idle_kb_per_second: Math.round(idleRate / 102.4) / 10,
          kb_written_per_change: Math.round(((after[pid].written - before[pid].written) - idleRate * wall) / count / 102.4) / 10,
          cpu_ms_per_change: Math.round(((after[pid].cpu_s - before[pid].cpu_s) - idleCpu * wall) / count * 1e4) / 10,
        };
      }
      const growth = Object.fromEntries(files.map((f) => [path.basename(f), Math.round((sizeOf(f) - sizes[f]) / count / 102.4) / 10]));
      note(label, { changes: count, scan_seconds: lab.settings.scan_seconds, per_process: per, file_growth_kb_per_change_gross: growth });
    }
    const dbFiles = ['reader-store.sqlite', 'reader-store.sqlite-wal'].map((n) => path.join(lab.storeDir, n));
    for (const scan of [3.0, 0.1]) {
      await lab.startDaemon({ scan, poll: scan === 0.1 ? 0.05 : 0.5 });
      lab.settings.scan_seconds = scan;
      await sleep(3000);
      await bytesPerChange(`bytes_new_path_scan_${scan}s`, 24, scan === 3.0 ? 4000 : 1500, [lab.main.pid, lab.daemon.pid], dbFiles);
    }

    // The old path, same lab and same changes: the reader server with the flag off and its old lite page open, rebuilding the pages as the logs change.
    await lab.stopDaemon();
    const old = await lab.startServer({ storeApi: false });
    axi('open', old.oldLite + '#s=' + crew1);
    await until(`return { ok: document.getElementById('main') && document.getElementById('main').children.length > 0 };`, 'the old lite page', 30000);
    await sleep(3000);
    const workerPids = () => { try { return execFileSync('pgrep', ['-P', String(old.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch (e) { return []; } };
    const outDir = lab.outDir;
    // A first change starts the worker; the measured ones follow.
    lab.append(crew1, { user: `LAB-MARK-${(marker += 1)} warm`, reply: 'warm' });
    await sleep(6000);
    const pids = [old.pid, ...workerPids()];
    const stamp = path.join(outDir, 'prototype.html');
    await bytesPerChange('bytes_old_path', 24, 3000, pids, [stamp, path.join(outDir, 'live', 's', crew1 + '.json')]);
    note('old_page_bytes', { prototype_html_kb: Math.round(sizeOf(stamp) / 102.4) / 10, live_conversation_object_kb: Math.round(sizeOf(path.join(outDir, 'live', 's', crew1 + '.json')) / 102.4) / 10, note: 'the old path rewrites these files (and parsed/, steps/, glance.json) for every change' });
    old.stop();

    // ----------------------------------------------------------------------------------- 3. idle CPU per open lite page, and Herdr calls
    async function idleWindow(label, seconds, pids, calls) {
      const renderers = rendererPids();
      const before = probe([...pids, ...renderers]);
      const callsBefore = calls ? (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0) : 0;
      const t0 = Date.now();
      await sleep(seconds * 1000);
      const wall = (Date.now() - t0) / 1000;
      const after = probe([...pids, ...renderers]);
      const cpu = (pid) => (after[pid] && before[pid] ? after[pid].cpu_s - before[pid].cpu_s : 0);
      const callsAfter = calls ? (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0) : 0;
      const out = { seconds: Math.round(wall), server_cpu_percent: Math.round(cpu(pids[0]) / wall * 1e4) / 100, renderer_cpu_percent: Math.round(renderers.reduce((sum, pid) => sum + cpu(pid), 0) / wall * 1e4) / 100, herdr_calls: callsAfter - callsBefore, store_daemon_cpu_percent: pids[1] ? Math.round(cpu(pids[1]) / wall * 1e4) / 100 : null };
      note(label, out);
      return out;
    }
    for (const scan of [3.0, 0.1]) {
      await lab.startDaemon({ scan, poll: scan === 0.1 ? 0.05 : 0.5 });
      await sleep(3000);
      const tag = scan === 3.0 ? 'owner_default_scan_3s' : 'lab_scan_0.1s';
      axi('open', 'about:blank'); await sleep(2000);
      await idleWindow(`idle_no_page_${tag}`, 45, [lab.main.pid, lab.daemon.pid], lab.main.calls);
      axi('open', lab.main.page + '#s=' + crew1);
      await until(`const S = window.__readerWindowed; return { ok: Boolean(S && S.turns.length) };`, 'the page');
      await sleep(3000);
      await idleWindow(`idle_one_windowed_page_${tag}`, 45, [lab.main.pid, lab.daemon.pid], lab.main.calls);
    }
    // Herdr: how often the reader asks it while a page is open, the poll as it was and the watch that replaces it.
    await lab.stopDaemon();
    const off = await lab.startServer({ storeApi: false });
    axi('open', off.oldLite + '#s=' + crew1);
    await until(`return { ok: document.getElementById('main') && document.getElementById('main').children.length > 0 };`, 'the old lite page (flag off)', 30000);
    await sleep(3000);
    await idleWindow('herdr_old_lite_page_flag_off_poll', 60, [off.pid], off.calls);
    off.stop();
    const on = await lab.startServer({ storeApi: true });
    axi('open', on.oldLite + '#s=' + crew1);
    await until(`return { ok: document.getElementById('main') && document.getElementById('main').children.length > 0 };`, 'the old lite page (flag on)', 30000);
    await sleep(3000);
    await idleWindow('herdr_old_lite_page_flag_on_events', 60, [on.pid], on.calls);
    axi('open', on.page + '#s=' + crew1);
    await until(`const S = window.__readerWindowed; return { ok: Boolean(S && S.turns.length) };`, 'the windowed page');
    await sleep(3000);
    await idleWindow('herdr_windowed_page_flag_on_events', 60, [on.pid], on.calls);
    on.stop();
    note('done', true);
  } catch (error) {
    note('error', String(error && error.stack || error));
  } finally {
    lab.stop();
    try { axi('stop'); } catch (e) { /* not running */ }
  }
  process.exit(results.error ? 1 : 0);
})();
