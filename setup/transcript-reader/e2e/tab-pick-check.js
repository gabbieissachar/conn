#!/usr/bin/env node
'use strict';

// Picking a new Herdr tab in the session picker builds it for the reader, in a real browser (chrome-devtools-axi), against a lab copy of the reader on
// its own port with a fake Herdr (nothing is sent to any pane). By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/tab-pick-check.js <scratch folder> [screenshots folder]
//
// A new Claude tab (a pane, its process, a log) is added to the fake Herdr while Follow is off. The picker offers it under "Herdr tabs not on the
// reader" within a poll; choosing it shows "Building ..." and then the tab's conversation, which is on the reading list, and the group goes. The
// tab-latency.js driver measures how long that takes.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-tab-pick-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, finish, sleep } = make('reader-tab-pick-check');

// The picker's groups, the tab title and the start of the conversation, for the checks (kept short: chrome-devtools-axi drops arguments of about 1000 characters).
const STATE = `const s = document.querySelector('select[name=session]'); return { title: document.title, main: document.getElementById('main').innerText.slice(0, 300),
  groups: [...s.querySelectorAll('optgroup')].map(g => g.label + '|' + [...g.children].map(o => o.text).join('|')) };`;
const WITH_GROUP = `const r = (() => { ${STATE} })(); r.ok = r.groups.some(g => /^Herdr tabs/.test(g)); return r;`;
const SHOWN = `const r = (() => { ${STATE} })(); r.ok = r.title.startsWith('new-tab-1 · ') && /Answer in new tab 1/.test(r.main); return r;`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop, outDir } = await startLab(folder);
  try {
    await openPage(page, '1000x900x1');
    const world = JSON.parse(fs.readFileSync(lab.world, 'utf8'));
    const herdr = world.sessions[0];
    const sid = 'd00d0000-0001-4000-8000-000000000001', cwd = '/lab/newtab-1', now = Date.now() / 1000;
    const iso = (at) => new Date(at * 1000).toISOString();
    const log = path.join(lab.home, '.claude', 'projects', '-lab-newtab-1', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, [
      { type: 'user', uuid: 'u-new-1', timestamp: iso(now - 20), cwd, message: { role: 'user', content: 'Question in new tab 1' } },
      { type: 'assistant', timestamp: iso(now - 10), cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'Answer in new tab 1.' }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
    const pid = spawn('sleep', ['6000'], { stdio: 'ignore', detached: true }).pid;
    lab.pids.newtab = pid;
    fs.mkdirSync(path.join(lab.home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(lab.home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd, startedAt: Date.now() }));
    herdr.tabs.push({ tab_id: 'w1:t101', label: 'new-tab-1' });
    herdr.panes.push({ pane_id: 'w9:p1', tab_id: 'w1:t101', agent: 'claude', agent_status: 'idle', agent_session: sid, title: 'New tab 1', cwd, process: [{ pid, argv0: 'claude', cwd }] });
    fs.writeFileSync(lab.world, JSON.stringify(world, null, 1));

    const offered = await until(WITH_GROUP, 'the picker to offer the new tab', 20000);
    const group = offered.groups.find((g) => /^Herdr tabs/.test(g));
    check(/^Herdr tabs not on the reader · 1\|Idle · new-tab-1 · build now$/.test(group), 'the picker offers the new tab under "Herdr tabs not on the reader"', group);
    check(!/new-tab-1/.test(offered.title) && !/Answer in new tab 1/.test(offered.main), 'it is offered, not opened: the page stays on the conversation it was on', offered.title);
    axi('screenshot', path.join(shots, 'tab-pick-01-offered.png'));

    const t0 = Date.now();
    ev(`const s = document.querySelector('select[name=session]'); const o = [...s.options].find(o => /new-tab-1 · build now/.test(o.text)); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    const shown = await until(SHOWN, 'the tab to be built and shown', 60000);
    process.stdout.write(`      picked to shown: ${Date.now() - t0} ms\n`);
    check(/Answer in new tab 1\./.test(shown.main) && /Question in new tab 1/.test(shown.main), 'the tab\'s conversation is on screen once it is built', shown.title);
    check(!shown.groups.some((g) => /^Herdr tabs/.test(g)), 'the tab is not offered any more: it is on the reader', JSON.stringify(shown.groups.map((g) => g.split('|')[0])));
    check(fs.readFileSync(path.join(outDir, 'sessions.txt'), 'utf8').split('\n').includes(sid), 'the reading list names the new session');
    axi('screenshot', path.join(shots, 'tab-pick-02-shown.png'));
    // Nothing was typed into any pane.
    const calls = fs.existsSync(lab.log) ? fs.readFileSync(lab.log, 'utf8') : '';
    check(!/PROMPT|KEYS/.test(calls), 'no pane was sent anything');
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
