#!/usr/bin/env node
'use strict';

// How long a new Herdr tab takes to be an available session in the reader, and where the time goes, in a real browser (chrome-devtools-axi),
// against a lab copy of the reader on its own port with a fake Herdr (nothing is sent to any pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/tab-latency.js <scratch folder> follow|tab [tabs]
//
// A new Claude tab (a pane, its process, a log with one exchange) is added to the fake Herdr, twice: the first time against the worker the
// server starts for its first build (cold), the second against the warm one. `follow` turns Follow Herdr on and moves Herdr's focus to the new
// tab, which is how the owner got a new session onto the reader; `tab` picks the tab in the session picker's "Herdr tabs" group instead.
// The time from the tab appearing in Herdr to each of: the server listing it (sessions.txt), the build that carries it (prototype.stamp), and
// the page having it chosen. Set LAB_FILLERS and LAB_BIG_EXCHANGES for a list of the owner's size (about 90 conversations).

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-tab-latency-lab'));
const mode = process.argv[3] === 'tab' ? 'tab' : 'follow';
const count = Number(process.argv[4] || 2);
const { axi, ev, until, check, startLab, openPage, finish, sleep } = make('reader-tab-latency');

const iso = (at) => new Date(at * 1000).toISOString();

(async () => {
  process.env.LAB_FILLERS = process.env.LAB_FILLERS || '40';
  process.env.LAB_BIG_EXCHANGES = process.env.LAB_BIG_EXCHANGES || '120';
  const { lab, page, stop, outDir } = await startLab(folder);
  const world = JSON.parse(fs.readFileSync(lab.world, 'utf8'));
  const herdr = world.sessions[0];
  const newTab = async (n) => {
    const sid = `d00d0000-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
    const cwd = `/lab/newtab-${n}`;
    const now = Date.now() / 1000;
    const log = path.join(lab.home, '.claude', 'projects', `-lab-newtab-${n}`, `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, [
      { type: 'user', uuid: `u-new-${n}`, timestamp: iso(now - 20), cwd, message: { role: 'user', content: `Question in new tab ${n}` } },
      { type: 'assistant', timestamp: iso(now - 10), cwd, message: { role: 'assistant', content: [{ type: 'text', text: `Answer in new tab ${n}.` }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
    const { spawn } = require('child_process');
    const pid = spawn('sleep', ['6000'], { stdio: 'ignore', detached: true }).pid;
    fs.mkdirSync(path.join(lab.home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(lab.home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd, startedAt: Date.now() }));
    lab.pids[`new-${n}`] = pid;
    const label = `new-tab-${n}`;
    herdr.tabs.push({ tab_id: `w1:t${100 + n}`, label });
    herdr.panes.push({ pane_id: `w9:p${n}`, tab_id: `w1:t${100 + n}`, agent: 'claude', agent_status: 'idle', agent_session: sid, title: `New tab ${n}`, cwd, process: [{ pid, argv0: 'claude', cwd }] });
    return { sid, label, pane: `w9:p${n}`, log };
  };
  const listedAt = (sid) => { try { return fs.readFileSync(path.join(outDir, 'sessions.txt'), 'utf8').includes(sid); } catch (e) { return false; } };
  const stampNow = () => { try { return Number(fs.readFileSync(path.join(outDir, 'prototype.stamp'), 'utf8')); } catch (e) { return 0; } };
  try {
    await openPage(page, '1000x900x1');
    if (mode === 'follow') {
      ev(`localStorage.setItem('tr-follow', '1'); return true;`);
      axi('open', 'about:blank'); axi('open', page);
      await until(`return { ok: / · Reader$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the page with Follow on');
    }
    await sleep(2500);
    for (let n = 1; n <= count; n++) {
      const stamp0 = stampNow();
      // The page records when the picker first has this tab chosen.
      ev(`window.__chosen = null; clearInterval(window.__watch); window.__watch = setInterval(() => { if (!window.__chosen && document.title.startsWith('new-tab-${n} · ')) window.__chosen = Date.now(); }, 25); return true;`);
      const tab = await newTab(n);
      const t0 = Date.now();
      fs.writeFileSync(lab.world, JSON.stringify(world, null, 1));
      let tList = null, tBuilt = null, tChosen = null, tOffered = null;
      if (mode === 'follow') herdr.focused = tab.pane;
      if (mode === 'follow') fs.writeFileSync(lab.world, JSON.stringify(world, null, 1));
      let picked = false;
      for (let waited = 0; waited < 120000 && tChosen === null; waited += 20) {
        if (tList === null && listedAt(tab.sid)) tList = Date.now() - t0;
        if (tBuilt === null && tList !== null && stampNow() > stamp0) tBuilt = Date.now() - t0;
        if (mode === 'tab' && !picked && waited % 200 === 0) {
          // The tab is offered in the picker once the page has heard of it; picking it is one change of the select.
          const offered = ev(`const s = document.querySelector('select[name=session]'); const o = [...s.options].find(o => /new-tab-${n}/.test(o.text)); if (!o) return { ok: true, found: false }; if (!window.__picked) { window.__picked = Date.now(); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } return { ok: true, found: true, at: window.__picked };`);
          if (offered.found) { picked = true; tOffered = offered.at - t0; }
        }
        if (waited % 200 === 0) { const c = ev(`return { ok: true, at: window.__chosen };`).at; if (c) tChosen = c - t0; }
        await sleep(20);
      }
      ev(`window.__picked = null; return true;`);
      process.stdout.write(`      tab ${n} (${n === 1 ? 'first build: cold worker' : 'warm worker'}), mode ${mode}: offered ${tOffered === null ? '-' : tOffered + ' ms'}; listed ${tList} ms; built ${tBuilt} ms; shown ${tChosen} ms\n`);
      check(tChosen !== null, `the new tab ${n} became the session on screen`, JSON.stringify({ offered: tOffered, listed: tList, built: tBuilt, shown: tChosen }));
      await sleep(1500);
    }
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
