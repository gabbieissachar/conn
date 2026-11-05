#!/usr/bin/env node
'use strict';

// How long the reader takes to connect to a session again after `/clear`, in a real browser (chrome-devtools-axi), against a lab copy of the
// reader on its own port with a fake Herdr (never a real pane). By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/clear-reconnect-check.js <scratch folder> [screenshots folder]
//
// A `/clear` in a Claude pane starts a new session: a new log under the pane's project folder (first record the /clear command), the running
// process's record under ~/.claude/sessions naming the new id, and, depending on the Herdr, its own session id for the pane changing at once or
// staying the old one. The page is open, as the owner has it. For each case the check times, from the moment the files change:
//   - "listed"     the server's state names the pane's new session among the live listed ones,
//   - "built"      the page on disk holds the conversation under the new id,
//   - "on screen"  the open page's picker offers the conversation under the new id, running (no "closed pane" in its name), and the message
//                  box of that conversation says it sends to the pane,
// and fails when the page takes longer than LIMIT_MS (8 s) from the moment the new session can be read (its log exists). The lab is the one of pane_lab.py; a sibling pane is cleared too, to see that
// a clear in one pane never moves another.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-clear-reconnect-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { check, axi, ev, startLab, openPage, pick, finish, sleep } = make('reader-clear-reconnect-check');
const LIMIT_MS = Number(process.env.CLEAR_LIMIT_MS || 8000);  // the longest a person should wait for the page to show the cleared session again

const iso = (at) => new Date(at).toISOString();
const uuid = () => crypto.randomUUID();

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop, outDir, port } = await startLab(folder);
  // Plain http, not fetch: Node's fetch sends Fetch-Metadata that marks it as a script, which the page route refuses (it is for a tab).
  const get = (url, headers = {}) => new Promise((resolve, reject) => http.get(url, { headers }, (res) => { let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve(text)); }).on('error', reject));
  const token = (await get(page)).match(/name="reader-token" content="([0-9a-f]{64})"/)[1];
  const state = async () => JSON.parse(await get(`http://localhost:${port}/api/transcript-reader/state`, { 'x-transcript-reader-token': token }));
  const built = () => {
    try {
      const t = fs.readFileSync(path.join(outDir, 'prototype.html'), 'utf8'); const i = t.indexOf('id="payload"'); const j = t.indexOf('>', i) + 1; const k = t.indexOf('</script>', j);
      return JSON.parse(t.slice(j, k)).sessions.map((s) => ({ id: s.id, ids: s.ids, label: (s.pane || {}).label, live: Boolean(s.pane && s.pane.live) }));
    } catch (e) { return []; }
  };
  const world = () => JSON.parse(fs.readFileSync(lab.world, 'utf8'));
  const saveWorld = (w) => fs.writeFileSync(lab.world, JSON.stringify(w, null, 1));
  const home = path.join(lab.home, '.claude');

  // A /clear in pane <n> (crew-n): the old log's last records, a new session whose log starts with the command, the process's record, and Herdr's
  // own id for the pane. `logLagMs` is how long after the process's record and Herdr the new log appears (0: first).
  function clearPane(n, { herdrUpdates, logLagMs = 0 }) {
    const old = lab.crew[n - 1], fresh = uuid(), at = Date.now();
    // The clear writes to the OLD log as the session ends (records with no time of their own: a cost summary), which is what links the new log to it.
    fs.appendFileSync(path.join(home, 'projects', `-lab-crew-${n}`, `${old}.jsonl`), JSON.stringify({ type: 'cost-state', totalCostUSD: 0.1 }) + '\n');
    const writeLog = () => {
      const logFile = path.join(home, 'projects', `-lab-crew-${n}`, `${fresh}.jsonl`);
      fs.writeFileSync(logFile, [
        { type: 'user', uuid: uuid(), timestamp: iso(Date.now()), cwd: `/lab/crew-${n}`, message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' } },
      ].map((r) => JSON.stringify(r) + '\n').join(''));
    };
    if (!logLagMs) writeLog(); else setTimeout(writeLog, logLagMs);
    fs.writeFileSync(path.join(home, 'sessions', `${lab.pids['crew-' + n]}.json`), JSON.stringify({ pid: lab.pids['crew-' + n], sessionId: fresh, cwd: `/lab/crew-${n}`, kind: 'interactive' }));
    if (herdrUpdates) { const w = world(); w.sessions[0].panes.find((p) => p.pane_id === `w3:p${n}`).agent_session = fresh; saveWorld(w); }
    return { old, fresh, t0: Date.now(), lag: logLagMs };
  }
  const screen = (fresh, label) => ev(`const sel = document.querySelector('select[name=session]'); const opts = [...sel.options].filter(o => o.value === '${fresh}'); const dock = document.getElementById('dock');
    return { ok: opts.length > 0, text: opts.map(o => o.text).join(' | '), live: opts.length > 0 && !/closed pane/.test(opts[0].text), title: document.title, label: '${label}' };`);

  try {
    await openPage(page);
    pick('crew-2'); await sleep(600);

    for (const [name, n, herdrUpdates, logLagMs] of [
      ['Herdr gives the pane the new id at once', 2, true, 0],
      ['Herdr keeps the pane\'s old id (the process record has the new one)', 3, false, 0],
      ['the process record and Herdr change first, the new log appears 5 s later', 4, true, 5000],
      ['the new log appears 5 s after the record, and Herdr keeps the old id', 5, false, 5000],
    ]) {
      pick(`crew-${n}`); await sleep(600);
      const c = clearPane(n, { herdrUpdates, logLagMs });
      const times = {};
      const end = Date.now() + 60000;
      while (Date.now() < end && !(times.listed && times.built && times.screen)) {
        const at = Date.now() - c.t0;
        if (!times.listed) { const s = await state(); if (s.panes && s.panes[c.fresh]) times.listed = at; }
        if (!times.built && built().some((s) => s.id === c.fresh && s.live)) times.built = at;
        if (!times.screen) { try { const s = screen(c.fresh, `crew-${n}`); if (s.ok && s.live) times.screen = Date.now() - c.t0; } catch (e) { /* the page is drawing */ } }
        await sleep(100);
      }
      process.stdout.write(`      ${name}: ${JSON.stringify(times)}\n`);
      check(times.listed !== undefined && times.built !== undefined && times.screen !== undefined, `${name}: the page shows the cleared session running`, JSON.stringify(times));
      const joined = built().find((s) => s.id === c.fresh);
      check(Boolean(joined) && joined.ids.includes(c.old), `${name}: it is one conversation with the turns before the clear`, joined ? joined.ids.map((i) => i.slice(0, 8)).join(' + ') : 'not built');
      // The reader cannot show a conversation before its log exists: the wait that counts runs from the later of the clear and the new log.
      const waited = (times.screen || Infinity) - c.lag;
      check(waited <= LIMIT_MS, `${name}: on screen within ${LIMIT_MS / 1000} s of the clear being readable`, `${waited} ms`);
      axi('screenshot', path.join(shots, `clear-${n}.png`));
    }
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  }
  finish(stop);
})();
