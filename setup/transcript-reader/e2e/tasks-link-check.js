#!/usr/bin/env node
'use strict';

// The Tasks link of the reader page in a real browser (chrome-devtools-axi), against lab copies of the reader on their own ports with a fake Herdr and the board's
// own lab (pane_lab.py conversations, tasks_link_lab.py boards over them): never the live reader, never a real home, store or pane. By hand, not part of
// `node --test` (it needs chrome-devtools-axi, Chrome and a Firstmate checkout):
//
//   node setup/transcript-reader/e2e/tasks-link-check.js [scratch folder] [screenshots folder]
//
// Board flag off: no Tasks tab, no Tasks icon, no board page. Board flag on: the tab of the open header and the icon of the folded one show, and open the board of the
// conversation on screen (#s=<board>) or the board page's own first board when no board reads it; nothing scrolls sideways and the folded row keeps every icon in
// the window at 1440, 1200, 700 and a phone's 390 px; a click lands on the board page with that board's card, whose Conversation link comes back.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { make, freePort, sleep } = require('./axi');

const folder = fs.mkdtempSync(path.join(process.argv[2] ? path.resolve(process.argv[2]) : os.tmpdir(), 'reader-tasks-link-lab-'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { check, ev, until, axi, finish } = make('reader-tasks-link-check');

function startServer(lab, boardLab, port, flags) {
  const out = fs.openSync(path.join(folder, `server-${port}.log`), 'a');
  const env = { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH, ...(flags ? { PMOS_READER_BOARD: '1', PMOS_READER_BOARD_CONFIG: boardLab.config, PMOS_READER_BOARD_CACHE: boardLab.cache, PMOS_READER_BOARD_WORKERS: path.join(boardLab.conf, 'board-workers.json') } : {}) };
  return spawn('node', [path.join(lab.repo, 'setup', 'transcript-reader', 'server.js'), '--port', String(port), '--root', lab.repo], { stdio: ['ignore', out, out], env });
}
async function waitUp(port) {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://localhost:${port}/setup/transcript-reader/out/prototype.html`); if (r.ok || r.status === 403) return;  /* 403: the page refuses a script's fetch, which is the server answering */ } catch (e) { /* not up yet */ } await sleep(200); }
  throw new Error('the lab server did not answer on ' + port);
}
async function openReader(port, viewport) {
  axi('open', 'about:blank'); axi('emulate', '--viewport', viewport);
  axi('open', `http://localhost:${port}/setup/transcript-reader/out/prototype.html`); await sleep(1200);
  ev(`localStorage.setItem('tr-follow', '0'); return true;`);
  axi('open', 'about:blank'); axi('open', `http://localhost:${port}/setup/transcript-reader/out/prototype.html`);
  await until(`return { ok: / · Reader$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the reader page');
}
const pickSession = (sid) => ev(`const s = document.querySelector('select[name=session]'); if (!s) return false; const o = [...s.options].find(o => o.value === '${sid}'); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
const hrefs = () => ev(`const t = document.getElementById('tab-tasks'), i = document.getElementById('view-tasks'); return { tab: t.hidden ? null : t.getAttribute('href'), icon: i.hidden ? null : i.getAttribute('href') };`);
const placed = () => ev(`const bar = document.getElementById('bar'), tab = document.getElementById('tab-tasks'), doc = document.getElementById('tab-doc'), icon = document.getElementById('view-tasks'), d = document.getElementById('view-doc'); const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; return { folded: bar.classList.contains('collapsed'), tab: tab.offsetParent ? r(tab) : null, doc: doc.offsetParent ? r(doc) : null, icon: icon.offsetParent ? r(icon) : null, docIcon: d.offsetParent ? r(d) : null, win: innerWidth, scroll: document.documentElement.scrollWidth };`);
const inWindow = (r, win) => r && r[0] >= 0 && r[0] + r[2] <= win;
const iconsRow = () => ev(`const win = innerWidth, shown = [...document.querySelectorAll('.bar .title > *')].filter(e => e.offsetParent), rects = shown.map(e => e.getBoundingClientRect()); const out = rects.filter(b => b.right > win + 1 || b.left < -1).length; const f = document.getElementById('follow-quick').getBoundingClientRect(), d = document.getElementById('view-doc').getBoundingClientRect(); return { out, followWithDocs: Math.abs(f.top - d.top) < 2, h: Math.round(document.getElementById('bar').getBoundingClientRect().height) };`);
const setFolded = (want) => { const now = ev(`return document.getElementById('bar').classList.contains('collapsed');`); if (now !== want) ev(`document.getElementById('bar-toggle').click(); return true;`); };

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  let lab, boardLab;
  try {
    lab = JSON.parse(execFileSync('python3', [path.join(__dirname, 'pane_lab.py'), path.join(folder, 'panes')], { encoding: 'utf8', timeout: 240000 }).trim().split('\n').pop());
    boardLab = JSON.parse(execFileSync('python3', ['-I', path.join(__dirname, 'tasks_link_lab.py'), path.join(folder, 'boards'), lab.home], { encoding: 'utf8', timeout: 240000 }).trim().split('\n').pop());
  } catch (error) { process.stdout.write('SKIP  no lab (needs a Firstmate checkout): ' + String(error.message).slice(0, 200) + '\n'); process.exit(0); }
  const servers = [];
  const stop = () => { servers.forEach((s) => s.kill()); for (const pid of Object.values(lab.pids)) { try { process.kill(pid); } catch (e) { /* gone */ } } try { axi('stop'); } catch (e) { /* not running */ } };
  try {
    // ---- the board flag off: nothing of a board in the header
    let port = await freePort();
    servers.push(startServer(lab, boardLab, port, false)); await waitUp(port);
    await openReader(port, '1200x900x1');
    await sleep(3500);  // a poll or two
    let h = hrefs();
    check(h.tab === null && h.icon === null, 'board flag off: no Tasks tab and no Tasks icon', JSON.stringify(h));
    check((await fetch(`http://localhost:${port}/setup/transcript-reader/board/`)).status === 404, 'board flag off: the board page does not exist');
    servers.pop().kill(); await sleep(400);

    // ---- the board flag on
    port = await freePort();
    servers.push(startServer(lab, boardLab, port, true)); await waitUp(port);
    await openReader(port, '1200x900x1');
    await until(`return { ok: !document.getElementById('tab-tasks').hidden };`, 'the Tasks tab', 40000);
    check(true, 'board flag on: the Tasks tab shows in the open header once the server says so');
    h = hrefs();
    check(h.tab === '/setup/transcript-reader/board/' || /#s=leader-/.test(h.tab || ''), 'the link opens the board page', JSON.stringify(h));
    // the boards are read at start: once they are, a conversation a board reads names its board
    const crew1 = lab.crew[0], crew3 = lab.crew[2], crew5 = lab.crew[4];
    check(pickSession(crew1), 'crew-1 is on screen');
    await until(`return { ok: document.getElementById('tab-tasks').getAttribute('href') === '/setup/transcript-reader/board/#s=leader-lab' };`, 'crew-1 names the leader-lab board', 120000);
    check(true, 'a conversation a board reads: the tab opens that board (#s=leader-lab)');
    pickSession(crew3);
    await until(`return { ok: document.getElementById('tab-tasks').getAttribute('href') === '/setup/transcript-reader/board/#s=leader-other' };`, 'crew-3 names the leader-other board', 120000);
    check(true, 'another conversation, another board (#s=leader-other)');
    pickSession(crew5);
    await until(`return { ok: document.getElementById('tab-tasks').getAttribute('href') === '/setup/transcript-reader/board/' };`, 'crew-5 names no board', 20000);
    check(true, 'a conversation no board reads: the board page opens on its own first board');
    pickSession(crew1);
    await until(`return { ok: document.getElementById('tab-tasks').getAttribute('href').endsWith('#s=leader-lab') };`, 'crew-1 again', 20000);

    // ---- the header at each width: open (the tab among the tabs) and folded (the icon among the icons)
    for (const [viewport, label, win] of [['1440x900x1', '1440 px', 1440], ['1200x900x1', '1200 px', 1200], ['700x900x1', '700 px', 700], ['390x844x2,mobile,touch', 'a phone (390 px)', 390]]) {
      axi('emulate', '--viewport', viewport); await sleep(900);
      const phone = /mobile/.test(viewport);
      setFolded(false); await sleep(500);
      let p = placed();
      check(p.tab && p.doc && inWindow(p.tab, win) && p.tab[3] === p.doc[3] && Math.abs(p.tab[1] - p.doc[1]) <= 1, `${label}, open: the Tasks tab sits in the tabs row, as tall as Documents and inside the window`, JSON.stringify(p));
      check(p.scroll <= p.win, `${label}, open: nothing scrolls sideways`, JSON.stringify(p));
      axi('screenshot', path.join(shots, `tasks-link-${win}-open.png`));
      setFolded(true); await sleep(500);
      p = placed();
      const row = iconsRow();
      check(p.icon && p.docIcon && inWindow(p.icon, win) && p.icon[2] === p.docIcon[2] && p.icon[3] === p.docIcon[3], `${label}, folded: the Tasks icon is as big as the Documents icon and inside the window`, JSON.stringify(p));
      check(row.out === 0, `${label}, folded: no control of the header row is cut off by the window edge`, JSON.stringify(row));
      check(p.scroll <= p.win, `${label}, folded: nothing scrolls sideways`, JSON.stringify(p));
      if (phone) check(p.icon && p.icon[2] >= 44 && p.icon[3] >= 44, `${label}: the icon is a fingertip big`, JSON.stringify(p.icon));
      if (phone) check(row.h <= 120 && row.followWithDocs, `${label}, folded: the header stays two lines and Follow stays beside Documents`, JSON.stringify(row));
      axi('screenshot', path.join(shots, `tasks-link-${win}-folded.png`));
    }

    // ---- the lite page (the one the Watch and Reader web views of a host load) carries the same header
    axi('emulate', '--viewport', '1200x900x1'); await sleep(600);
    axi('open', 'about:blank'); axi('open', `http://localhost:${port}/setup/transcript-reader/out/live/index.html`);
    await until(`return { ok: !!document.getElementById('tab-tasks') && !document.getElementById('tab-tasks').hidden };`, 'the lite page\'s Tasks tab', 60000);
    check(true, "the lite page shows the Tasks tab too (the host's Reader web view loads it)");
    await openReader(port, '1200x900x1');
    await until(`return { ok: !document.getElementById('tab-tasks').hidden };`, 'the Tasks tab', 20000);
    pickSession(crew1);
    await until(`return { ok: document.getElementById('tab-tasks').getAttribute('href').endsWith('#s=leader-lab') };`, 'crew-1 again', 20000);

    // ---- the click: the board page, on that conversation's board, and the way back
    axi('emulate', '--viewport', '1200x900x1'); await sleep(900);
    setFolded(false);
    ev(`document.getElementById('tab-tasks').click(); return true;`);
    await until(`return { ok: /\\/board\\//.test(location.pathname) && document.querySelectorAll('.card').length > 0 };`, 'the board page with its card', 90000);
    const landed = ev(`return { hash: location.hash, cards: [...document.querySelectorAll('.card')].map(c => c.dataset.ref) };`);
    check(landed.hash === '#s=leader-lab' && landed.cards.includes('leader-lab-task'), 'the tab lands on the board of the conversation that was on screen, with its card', JSON.stringify(landed));
    axi('screenshot', path.join(shots, 'tasks-link-board.png'));
    ev(`document.getElementById('to-reader').click(); return true;`);
    await until(`return { ok: /prototype\\.html/.test(location.pathname) && document.getElementById('main').children.length > 0 };`, 'back on the reader page', 30000);
    check(true, "the board page's Conversation link comes back to the reader");
    await until(`return { ok: !document.getElementById('tab-tasks').hidden };`, 'the Tasks tab again', 20000);
    check(true, 'and the Tasks tab is there again');
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
