#!/usr/bin/env node
'use strict';

// The Tasks link of the reader page in a real browser (chrome-devtools-axi), against lab copies of the reader on their own ports with a fake Herdr and the board's
// own lab (pane_lab.py conversations, tasks_link_lab.py boards over them): never the live reader, never a real home, store or pane. By hand, not part of
// `node --test` (it needs chrome-devtools-axi, Chrome and a Firstmate checkout):
//
//   node setup/transcript-reader/e2e/tasks-link-check.js [scratch folder] [screenshots folder]
//
// Board flag off: no Tasks tab, no Tasks icon, no All tasks tab, no board page. Board flag on: "All tasks" (the whole board, every session) shows on every conversation;
// "Tasks" (the tab of the open header, the icon of the folded one) shows only on a conversation a board reads, appears once that board is known, and opens that one
// board alone (board/?session=<board>: one board read, no session list, no other board fetched, no switch to another session) with a link to the whole board;
// nothing scrolls sideways and the folded row keeps every icon in the window at 1440, 1200, 700 and a phone's 390 px, light and dark; a click lands on the right
// board page, whose Conversation link comes back.

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
const hrefs = () => ev(`const t = document.getElementById('tab-tasks'), i = document.getElementById('view-tasks'), a = document.getElementById('tab-tasks-all'); return { tab: t.hidden ? null : t.getAttribute('href'), icon: i.hidden ? null : i.getAttribute('href'), all: a.hidden ? null : a.getAttribute('href') };`);
const BOARD = '/setup/transcript-reader/board/';
const placed = () => ev(`const bar = document.getElementById('bar'), tab = document.getElementById('tab-tasks'), all = document.getElementById('tab-tasks-all'), doc = document.getElementById('tab-doc'), icon = document.getElementById('view-tasks'), d = document.getElementById('view-doc'); const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; return { folded: bar.classList.contains('collapsed'), tab: tab.offsetParent ? r(tab) : null, all: all.offsetParent ? r(all) : null, doc: doc.offsetParent ? r(doc) : null, icon: icon.offsetParent ? r(icon) : null, docIcon: d.offsetParent ? r(d) : null, win: innerWidth, scroll: document.documentElement.scrollWidth };`);
// The Tasks page as one board alone or as the whole board: which boards and sessions it shows, and which board calls it made (the page's own fetches).
const onPage = () => ev(`const sess = [...document.querySelectorAll('.sessline .sess')]; const link = document.getElementById('all-tasks'); return { search: location.search, hash: location.hash, title: document.title, cards: [...document.querySelectorAll('.card')].map(c => c.dataset.ref), sess: sess.map(b => b.querySelector('.sl').textContent + (b.classList.contains('only') ? '*' : '')), all: link ? link.getAttribute('href') : null, workers: !document.getElementById('workers').hidden };`);
const boardCalls = () => ev(`return performance.getEntriesByType('resource').map(e => new URL(e.name)).filter(u => u.pathname.includes('/api/transcript-reader/board')).map(u => u.pathname.split('/').pop() + u.search);`);
const boardFit = () => ev(`const w = innerWidth, tabs = [...document.querySelectorAll('.bar .tabs > *')].filter(e => e.offsetParent); const link = document.getElementById('all-tasks'); const l = link && link.getBoundingClientRect(); return { scroll: document.documentElement.scrollWidth <= w, outTabs: tabs.filter(e => e.getBoundingClientRect().right > w + 1 || e.getBoundingClientRect().left < -1).length, link: l ? [Math.round(l.left), Math.round(l.width), Math.round(l.height)] : null, win: w };`);
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
    check(h.tab === null && h.icon === null && h.all === null, 'board flag off: no Tasks tab, no Tasks icon and no All tasks tab', JSON.stringify(h));
    check((await fetch(`http://localhost:${port}/setup/transcript-reader/board/`)).status === 404, 'board flag off: the board page does not exist');
    servers.pop().kill(); await sleep(400);

    // ---- the board flag on
    port = await freePort();
    servers.push(startServer(lab, boardLab, port, true)); await waitUp(port);
    await openReader(port, '1200x900x1');
    await until(`return { ok: !document.getElementById('tab-tasks-all').hidden };`, 'the All tasks tab', 40000);
    check(true, 'board flag on: the All tasks tab shows in the open header once the server says so');
    h = hrefs();
    check(h.all === BOARD, 'All tasks opens the whole board page (no session in the address)', JSON.stringify(h));
    // the boards are read at start: once they are, a conversation a board reads has a Tasks tab that names its board; any other has none
    const crew1 = lab.crew[0], crew3 = lab.crew[2], crew5 = lab.crew[4];
    check(pickSession(crew5), 'crew-5 is on screen (no board reads it)');
    await sleep(2500);  // a state poll or two: the answer for this conversation is "no board", and it stays that way
    h = hrefs();
    check(h.tab === null && h.icon === null, 'a conversation no board reads: no Tasks tab and no Tasks icon', JSON.stringify(h));
    check(h.all === BOARD, 'and All tasks is still there', JSON.stringify(h));
    check(pickSession(crew1), 'crew-1 is on screen');
    await until(`return { ok: !document.getElementById('tab-tasks').hidden && document.getElementById('tab-tasks').getAttribute('href') === '${BOARD}?session=leader-lab' };`, 'crew-1 names the leader-lab board', 120000);
    check(true, 'a conversation a board reads: the Tasks tab appears once that board is known and opens that board alone (?session=leader-lab)');
    h = hrefs();
    check(h.icon === `${BOARD}?session=leader-lab` && h.all === BOARD, "the folded header's icon goes to the same board, and All tasks stays the whole one", JSON.stringify(h));
    pickSession(crew3);
    await until(`return { ok: document.getElementById('tab-tasks').getAttribute('href') === '${BOARD}?session=leader-other' };`, 'crew-3 names the leader-other board', 120000);
    check(true, 'another conversation, another board (?session=leader-other)');
    pickSession(crew5);
    await until(`return { ok: document.getElementById('tab-tasks').hidden && document.getElementById('view-tasks').hidden };`, 'crew-5 has no Tasks link again', 20000);
    check(true, 'back on the conversation no board reads: the Tasks tab and icon go again');
    pickSession(crew1);
    await until(`return { ok: !document.getElementById('tab-tasks').hidden && document.getElementById('tab-tasks').getAttribute('href').endsWith('?session=leader-lab') };`, 'crew-1 again', 20000);

    // ---- the header at each width: open (the tabs among the tabs) and folded (the icon among the icons), light and dark
    for (const [viewport, label, win] of [['1440x900x1', '1440 px', 1440], ['1200x900x1', '1200 px', 1200], ['700x900x1', '700 px', 700], ['390x844x2,mobile,touch', 'a phone (390 px)', 390]]) {
      axi('emulate', '--viewport', viewport); await sleep(900);
      const phone = /mobile/.test(viewport);
      for (const scheme of (win === 1440 || phone) ? ['light', 'dark'] : ['light']) {
        axi('emulate', '--viewport', viewport, '--color-scheme', scheme); await sleep(700);  // one call: a call with only the scheme puts the window back to its first size
        const what = `${label}${scheme === 'dark' ? ', dark' : ''}`;
        setFolded(false); await sleep(500);
        let p = placed();
        check(p.tab && p.doc && inWindow(p.tab, win) && p.tab[3] === p.doc[3] && Math.abs(p.tab[1] - p.doc[1]) <= 1, `${what}, open: the Tasks tab sits in the tabs row, as tall as Documents and inside the window`, JSON.stringify(p));
        check(p.all && p.tab && inWindow(p.all, win) && p.all[3] === p.doc[3] && (p.all[1] > p.tab[1] || p.all[0] >= p.tab[0] + p.tab[2]), `${what}, open: the All tasks tab follows Tasks, as tall as Documents and inside the window`, JSON.stringify(p));
        check(p.scroll <= p.win, `${what}, open: nothing scrolls sideways`, JSON.stringify(p));
        axi('screenshot', path.join(shots, `tasks-link-${win}-${scheme}-open.png`));
        setFolded(true); await sleep(500);
        p = placed();
        const row = iconsRow();
        check(p.icon && p.docIcon && inWindow(p.icon, win) && p.icon[2] === p.docIcon[2] && p.icon[3] === p.docIcon[3], `${what}, folded: the Tasks icon is as big as the Documents icon and inside the window`, JSON.stringify(p));
        check(row.out === 0, `${what}, folded: no control of the header row is cut off by the window edge`, JSON.stringify(row));
        check(p.scroll <= p.win, `${what}, folded: nothing scrolls sideways`, JSON.stringify(p));
        if (phone) check(p.icon && p.icon[2] >= 44 && p.icon[3] >= 44, `${what}: the icon is a fingertip big`, JSON.stringify(p.icon));
        if (phone) check(row.h <= 120 && row.followWithDocs, `${what}, folded: the header stays two lines and Follow stays beside Documents`, JSON.stringify(row));
        axi('screenshot', path.join(shots, `tasks-link-${win}-${scheme}-folded.png`));
        // a conversation no board reads: the folded header is as it was before the Tasks icon (no icon, nothing cut off)
        pickSession(crew5); await sleep(900);
        const none = placed(), noneRow = iconsRow();
        check(none.icon === null && noneRow.out === 0 && none.scroll <= none.win, `${what}, folded, no board: no Tasks icon, nothing cut off`, JSON.stringify([none, noneRow]));
        axi('screenshot', path.join(shots, `tasks-link-${win}-${scheme}-folded-no-board.png`));
        setFolded(false); await sleep(500);
        const open5 = placed();
        check(open5.tab === null && open5.all && inWindow(open5.all, win), `${what}, open, no board: no Tasks tab, and All tasks is in the window`, JSON.stringify(open5));
        axi('screenshot', path.join(shots, `tasks-link-${win}-${scheme}-open-no-board.png`));
        pickSession(crew1); await sleep(700);
      }
    }

    // ---- the lite page (the one the Watch and Reader web views of a host load) carries the same header
    axi('emulate', '--viewport', '1200x900x1', '--color-scheme', 'light'); await sleep(600);
    axi('open', 'about:blank'); axi('open', `http://localhost:${port}/setup/transcript-reader/out/live/index.html`);
    await until(`return { ok: !!document.getElementById('tab-tasks-all') && !document.getElementById('tab-tasks-all').hidden };`, 'the lite page\'s All tasks tab', 60000);
    check(true, "the lite page shows the All tasks tab too (the host's Reader web view loads it)");
    await openReader(port, '1200x900x1');
    await until(`return { ok: !document.getElementById('tab-tasks-all').hidden };`, 'the All tasks tab', 20000);
    pickSession(crew1);
    await until(`return { ok: !document.getElementById('tab-tasks').hidden && document.getElementById('tab-tasks').getAttribute('href').endsWith('?session=leader-lab') };`, 'crew-1 again', 20000);

    // ---- the click on Tasks: that conversation's board alone, one board read and no other, and the way to the whole board and back
    axi('emulate', '--viewport', '1200x900x1'); await sleep(900);
    setFolded(false);
    ev(`document.getElementById('tab-tasks').click(); return true;`);
    await until(`return { ok: /\\/board\\//.test(location.pathname) && document.querySelectorAll('.card').length > 0 };`, 'the board page with its card', 90000);
    let landed = onPage();
    check(landed.search === '?session=leader-lab' && landed.cards.includes('leader-lab-task'), 'Tasks lands on the board of the conversation that was on screen, with its card', JSON.stringify(landed));
    check(!landed.cards.includes('leader-other-task'), "and nothing of another session's board is on it", JSON.stringify(landed.cards));
    check(landed.sess.length === 1 && landed.sess[0] === 'Lab*' && !landed.workers, 'the header names this session alone (no session to switch to, no worker switch)', JSON.stringify(landed.sess));
    check(landed.all === BOARD && /Lab/.test(landed.title), 'a link to the whole board is in the header, and the tab is named for the session', JSON.stringify({ all: landed.all, title: landed.title }));
    const calls = boardCalls();
    check(calls.length > 0 && calls.every((c) => c === 'board?session=leader-lab' || c === 'board?session=leader-lab&fresh=1'), 'the page read that one board and nothing else (no session list, no other board)', JSON.stringify(calls));
    axi('screenshot', path.join(shots, 'tasks-link-board-only.png'));
    // a card opens by #t= in the scoped page too, and the copied link keeps the page's scope
    ev(`location.hash = '#t=leader-lab-task'; return true;`);
    await until(`return { ok: !!document.querySelector('.sheet') };`, 'the card sheet (#t=)', 15000);
    check(true, 'a card opens from #t=<task> in the board of one session');
    ev(`const b = [...document.querySelectorAll('.sheet button.copy')].find(x => x.textContent === 'Copy link'); if (b) b.click(); return !!b;`);
    await until(`const t = document.querySelector('.toast'); return { ok: !!t && /Copied link/.test(t.textContent) };`, 'the copied link toast', 8000);
    const copied = ev(`return document.querySelector('.toast').textContent;`);
    check(/\/board\/\?session=leader-lab#t=/.test(copied), "the copied link keeps the page's scope (?session=...#t=...)", copied);
    // the whole-board link, from inside the scoped page
    ev(`document.getElementById('all-tasks').click(); return true;`);
    await until(`return { ok: !location.search && document.querySelectorAll('.sessline .sess').length >= 2 && document.querySelectorAll('.card').length > 0 };`, 'the whole board', 90000);
    landed = onPage();
    check(landed.sess.length >= 2 && landed.sess.every((x) => !x.endsWith('*')) && landed.all === null, 'All tasks opens the whole board: every session is a chip to switch to', JSON.stringify(landed.sess));
    axi('screenshot', path.join(shots, 'tasks-link-board-whole.png'));
    ev(`document.getElementById('to-reader').click(); return true;`);
    await until(`return { ok: /prototype\\.html/.test(location.pathname) && document.getElementById('main').children.length > 0 };`, 'back on the reader page', 30000);
    check(true, "the board page's Conversation link comes back to the reader");
    await until(`return { ok: !document.getElementById('tab-tasks-all').hidden };`, 'the All tasks tab again', 20000);
    check(true, 'and the Tasks links are there again');

    // ---- the click on All tasks, from a conversation no board reads
    pickSession(crew5); await sleep(900);
    ev(`document.getElementById('tab-tasks-all').click(); return true;`);
    await until(`return { ok: /\\/board\\//.test(location.pathname) && document.querySelectorAll('.card').length > 0 };`, 'the whole board from crew-5', 90000);
    landed = onPage();
    check(landed.search === '' && landed.sess.length >= 2, 'All tasks works from a conversation with no board: the whole board, every session', JSON.stringify(landed));

    // ---- the page of one session at the widths, light and dark; and one that has no board
    for (const [viewport, label, win] of [['1440x900x1', '1440 px', 1440], ['390x844x2,mobile,touch', 'a phone (390 px)', 390]]) {
      for (const scheme of ['light', 'dark']) {
        axi('open', 'about:blank'); axi('emulate', '--viewport', viewport, '--color-scheme', scheme);
        axi('open', `http://localhost:${port}${BOARD}?session=leader-other&run=${Date.now()}`);
        await until(`return { ok: document.querySelectorAll('.card').length > 0 };`, 'the cards of one session', 60000);
        const fit = boardFit();
        const what = `${label}${scheme === 'dark' ? ', dark' : ''}`;
        check(fit.scroll && fit.outTabs === 0, `${what}: the page of one session scrolls nowhere sideways and the tabs are inside the window`, JSON.stringify(fit));
        check(fit.link && fit.link[0] >= 0 && fit.link[0] + fit.link[1] <= win, `${what}: the All tasks link is inside the window, beside the session's name`, JSON.stringify(fit));
        const only = onPage();
        check(only.sess.length === 1 && only.cards.includes('leader-other-task') && !only.cards.includes('leader-lab-task'), `${what}: the other board alone`, JSON.stringify(only));
        axi('screenshot', path.join(shots, `tasks-link-board-only-${win}-${scheme}.png`));
      }
    }
    axi('open', 'about:blank'); axi('emulate', '--viewport', '1200x900x1', '--color-scheme', 'light');
    axi('open', `http://localhost:${port}${BOARD}?session=nothing-here&run=${Date.now()}`);
    await until(`return { ok: /could not be read/.test(document.getElementById('banners').textContent) };`, 'the banner for a session with no board', 30000);
    const missing = onPage();
    check(missing.cards.length === 0 && missing.all === BOARD, 'a session with no board says so and still offers the whole board', JSON.stringify(missing));
    check(boardCalls().every((c) => c.startsWith('board?session=nothing-here')), 'and asked for that one board only', JSON.stringify(boardCalls()));
    axi('screenshot', path.join(shots, 'tasks-link-board-only-missing.png'));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
