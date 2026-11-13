'use strict';

// The lab the store API's browser check and exit-gate measurements run in (store-api-check.js, store-api-gate.js). Not a test: required by them.
//
// It builds pane_lab.py's world in a scratch folder (a made-up home with session logs, a fake Herdr that shows panes of several agents, a copy of this
// reader's code with its own out/), then adds what S2 needs, every part of it a lab's own:
//   - the store, in <folder>/store (PMOS_READER_STORE_DIR), ingested by the real daemon (store/reader_store.py run) reading the made-up home, with
//     the fake Herdr first on PATH. Its scan interval is a setting of the lab's store (scan_seconds), 0.1 s here by default, so the lab measures
//     the path itself and not the owner's 3-second idle cadence; the number is reported with every measurement.
//   - the fake Herdr's event sockets (e2e/fake-herdr-socket.js), so the server's events.subscribe has a stream to subscribe to.
//   - the reader's server (server.js) on a free port, with PMOS_READER_STORE_API=1.
// Nothing real is read or sent: not a real log, store, Herdr, pane, port (never 8768 or 8443) or window. Stopped by stop().

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { sleep, freePort } = require('./axi');

const HERE = __dirname;
const READER = path.dirname(HERE);

async function startStoreLab(folder, { scanSeconds = 0.1, pollSeconds = 0.05, reconcileSeconds = 3600, bigExchanges = 120, fillers = 20, env: extraEnv = {}, noDaemon = false } = {}) {
  process.env.LAB_BIG_EXCHANGES = String(bigExchanges);
  process.env.LAB_FILLERS = String(fillers);
  const lab = JSON.parse(execFileSync('python3', [path.join(HERE, 'pane_lab.py'), folder], { encoding: 'utf8', timeout: 240000 }).trim().split('\n').pop());
  const storeDir = path.join(folder, 'store');
  const children = [];
  const keep = (child) => { children.push(child); return child; };
  const logFile = (name) => fs.openSync(path.join(folder, name), 'a');
  const baseEnv = { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH, PMOS_READER_STORE_DIR: storeDir };
  delete baseEnv.PMOS_READER_STORE_RECORDER;
  // The store's own settings for this lab: a fast scan, so what is measured is the path and not a cadence.
  const storeCode = path.join(lab.repo, 'setup', 'transcript-reader', 'store', 'reader_store.py');
  execFileSync('python3', [storeCode, 'init'], { env: baseEnv, encoding: 'utf8' });
  const settingsFile = path.join(storeDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  Object.assign(settings, { scan_seconds: scanSeconds, identity_poll_seconds: pollSeconds, reconcile_seconds: reconcileSeconds });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  // The fake Herdr's event sockets: the world file gains each session's socket path, which `session list` then names.
  // A unix socket's path is at most 103 bytes on macOS: the sockets live in a short folder of their own under the system temp folder.
  const socketDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 's2s-'));
  const sockets = keep(spawn('node', [path.join(HERE, 'fake-herdr-socket.js'), lab.world, socketDir], { stdio: ['ignore', 'pipe', logFile('sockets.log')], env: baseEnv }));
  await new Promise((resolve, reject) => { sockets.stdout.once('data', resolve); sockets.once('exit', reject); });
  let daemon = null;
  const daemonEnv = { ...baseEnv, FAKE_HERDR_CALLS: path.join(folder, 'calls-daemon.log') };
  const status = () => { try { return JSON.parse(execFileSync('python3', [storeCode, 'status'], { env: baseEnv, encoding: 'utf8' })); } catch (e) { return null; } };
  // The real store daemon over the lab's logs, with this scan interval (a setting of the lab's store): started again when the interval changes.
  const startDaemon = async ({ scan = scanSeconds, poll = pollSeconds, reconcile = reconcileSeconds } = {}) => {
    if (daemon) { daemon.kill('SIGTERM'); await new Promise((resolve) => { daemon.once('exit', resolve); setTimeout(resolve, 5000); }); const at = children.indexOf(daemon); if (at >= 0) children.splice(at, 1); }
    const next = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    Object.assign(next, { scan_seconds: scan, identity_poll_seconds: poll, reconcile_seconds: reconcile });
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
    daemon = keep(spawn('python3', [storeCode, 'run'], { stdio: ['ignore', logFile('daemon.log'), logFile('daemon.log')], env: daemonEnv, cwd: lab.repo }));
    for (let i = 0; i < 600; i += 1) {   // the first full ingest of the lab's logs, then a heartbeat from this daemon
      const found = status();
      if (found && found.counts && found.counts.sessions >= lab.crew.length + 4 && found.heartbeat && found.heartbeat.pid === daemon.pid && found.heartbeat.status === 'ok') break;
      await sleep(200);
    }
    return daemon;
  };
  const stopDaemon = async () => { if (daemon) { daemon.kill('SIGTERM'); await new Promise((resolve) => { daemon.once('exit', resolve); setTimeout(resolve, 5000); }); const at = children.indexOf(daemon); if (at >= 0) children.splice(at, 1); daemon = null; } };
  if (!noDaemon) await startDaemon();
  // The reader's server on a free port. flagOn false is the reader as it was: the old paths only.
  const startServer = async ({ storeApi = true, env: more = {} } = {}) => {
    const port = await freePort();
    const calls = path.join(folder, `calls-server-${port}.log`);
    const child = keep(spawn('node', [path.join(lab.repo, 'setup', 'transcript-reader', 'server.js'), '--port', String(port), '--root', lab.repo], {
      stdio: ['ignore', logFile('server.log'), logFile('server.log')], env: { ...baseEnv, FAKE_HERDR_CALLS: calls, ...(storeApi ? { PMOS_READER_STORE_API: '1' } : {}), ...extraEnv, ...more },
    }));
    for (let i = 0; i < 100; i += 1) { try { const r = await fetch(`http://localhost:${port}/setup/transcript-reader/out/prototype.html`); if (r.ok) break; } catch (e) { /* not up yet */ } await sleep(100); }
    return { port, child, pid: child.pid, calls, page: `http://localhost:${port}/setup/transcript-reader/windowed/index.html`, oldLite: `http://localhost:${port}/setup/transcript-reader/out/live/index.html`, stop: () => { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } } };
  };
  const main = await startServer();
  const { port, server: serverChild } = { port: main.port, server: main.child };
  const outDir = path.join(lab.repo, 'setup', 'transcript-reader', 'out');
  const page = main.page;

  // One exchange appended to a Claude session's log, stamped now: what a conversation does when the agent answers.
  const find = (sid) => { const out = execFileSync('find', [lab.home, '-name', sid + '.jsonl'], { encoding: 'utf8' }).trim().split('\n')[0]; if (!out) throw new Error('no log for ' + sid); return out; };
  const append = (sid, { user, reply, cwd = '/lab/append' }) => {
    const file = find(sid);
    const at = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const records = [];
    if (user) records.push({ type: 'user', uuid: `u-${at}-${Math.random().toString(16).slice(2, 8)}`, timestamp: iso(at), cwd, message: { role: 'user', content: user } });
    if (reply) records.push({ type: 'assistant', timestamp: iso(at + 1), cwd, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
    fs.appendFileSync(file, records.map((r) => JSON.stringify(r) + '\n').join(''));
    return { at, file };
  };
  const stop = () => {
    try { fs.rmdirSync(socketDir); } catch (e) { /* the sockets' own cleanup removed them; the folder may still hold one */ }
    for (const child of children) { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } }
    for (const pid of Object.values(lab.pids)) { try { process.kill(pid); } catch (e) { /* gone */ } }
  };
  return { lab, folder, port, page, outDir, storeDir, storeCode, env: baseEnv, server: serverChild, main, startServer, startDaemon, stopDaemon, status, get daemon() { return daemon; }, sockets, append, find, stop, settings };
}

module.exports = { startStoreLab };
