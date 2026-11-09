#!/usr/bin/env node
'use strict';

// A reply link on the Tasks board, as a host's Watch column meets it (chrome-devtools-axi, a lab board from board_lab.py, the reader's own api.js on a free port, a Herdr that is
// never there: never the live reader, never a real home or pane). By hand, not part of `node --test` (it needs chrome-devtools-axi, Chrome and a Firstmate checkout):
//
//   node setup/transcript-reader/e2e/board-reply-link-check.js [scratch folder]
//
// The fault it pins (Nathan, 2026-11-09: "from the task detail view, when I click on a reply link, if the session's in a Watch column, it does not open up the reply, it's just
// stuck"): Conn's Watch column is a web view with no new window to open and no pane to switch to, and a click on `a[target=_blank]` there is handed to a hook the column does not
// have, so it goes nowhere. A click the column's own capture script takes (`a[data-session]`, which sends the host the session and whether Cmd was held, and stops the page's
// navigation) does open the conversation by Conn's column rule. The board's reply links were plain `target=_blank` links with no `data-session`, so the column never took them.
//
// This page stands in for the column: it installs the same capture handler Conn writes into a Watch column (helm Sources/Conn/Web.swift, `sessionLinkScript`, no Campus host)
// with a recorder for the `connSession` message handler, and, after it, one more listener that records what a link would hand a host as a new window and cancels it. A click on
// a reply link is then either taken (the host is told the session) or goes to the new-window hook (the stuck case). Without a host script the links keep their address (`#s=&m=`),
// `target=_blank` and `rel=noopener`: the Reader pane's path, which Conn routes to the reader pane.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { make, freePort, sleep } = require('./axi');

const folder = fs.mkdtempSync(path.join(process.argv[2] ? path.resolve(process.argv[2]) : os.tmpdir(), 'reader-board-reply-link-lab-'));
const repo = path.resolve(__dirname, '..', '..', '..');
const { check, ev, until, axi, finish } = make('reader-board-reply-link-check');

function startServer(lab, port) {
  const out = fs.openSync(path.join(folder, `server-${port}.log`), 'a');
  const env = { ...process.env, PMOS_READER_BOARD_CONFIG: lab.config, PMOS_READER_BOARD_CACHE: lab.cache, PMOS_READER_BOARD_WORKERS: path.join(lab.conf, 'board-workers.json'),
    LAB_OUT: lab.out, LAB_HIDDEN: lab.hidden, LAB_HERDR: lab.herdr };
  return spawn('node', [path.join(__dirname, 'board-lab-server.js'), repo, String(port)], { stdio: ['ignore', out, out], env });
}
async function waitUp(port) {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/setup/transcript-reader/board/`); if (r.ok || r.status === 403) return; } catch (e) { /* not up yet */ } await sleep(200); }
  throw new Error('the lab server did not answer on ' + port);
}
// Conn's capture handler for a Watch column (Web.swift sessionLinkScript with no Campus host), a recorder for its message handler, and the new-window hook: what a click that
// the handler did not take would have asked a host to open.
const HOST = `const t = window; t.__told = []; t.__opened = [];
t.webkit = { messageHandlers: { connSession: { postMessage: (m) => t.__told.push(m) } } };
t.addEventListener('click', (e) => { if (e.button !== 0) return; const x = e.target, a = x && x.closest ? x.closest('a[data-session]') : null, s = a && a.getAttribute('data-session');
  if (s) { e.preventDefault(); e.stopImmediatePropagation(); try { t.webkit.messageHandlers.connSession.postMessage({ session: s, reader: !!e.metaKey }); } catch (z) {} } }, true);
t.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (a) { t.__opened.push({ href: a.getAttribute('href'), target: a.target }); e.preventDefault(); } });
return true;`;
const SEL = `.sheet a.open-link, .sheet .asked a.ghost`;  // the page draws itself again now and then, so a link is found again by its place each time
const links = () => ev(`return [...document.querySelectorAll('${SEL}')].map((a, i) => ({ i, cls: a.className, href: a.getAttribute('href'), target: a.target, rel: a.rel, session: a.dataset.session || null, message: a.dataset.message || null }));`);
const click = (i, meta) => { ev(`window.__told = []; window.__opened = []; document.querySelectorAll('${SEL}')[${i}].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: ${meta ? 'true' : 'false'}, view: window })); return true;`); return ev(`return { told: window.__told, opened: window.__opened };`); };

(async () => {
  let lab;
  try { lab = JSON.parse(execFileSync('python3', ['-I', path.join(__dirname, 'board_lab.py'), folder], { encoding: 'utf8', timeout: 240000 }).trim().split('\n').pop()); }
  catch (error) { process.stdout.write('SKIP  no lab (needs a Firstmate checkout with typed asks)\n'); process.exit(0); }
  const servers = [];
  const stop = () => { servers.forEach((s) => s.kill()); try { axi('stop'); } catch (e) { /* not running */ } };
  try {
    const port = await freePort();
    servers.push(startServer(lab, port)); await waitUp(port);
    // a card of one session's board, opened from #t= (what a Tasks icon in a column leads to)
    axi('open', 'about:blank'); axi('emulate', '--viewport', '480x900x1');
    axi('open', `http://127.0.0.1:${port}/setup/transcript-reader/board/?session=leader-lab&run=${Date.now()}#t=alpha-route/Z1`);
    await until(`return { ok: !!document.querySelector('.sheet .callbox') };`, 'the card', 60000);
    const all = links();
    const thread = all.filter((l) => /open-link/.test(l.cls)), asked = all.filter((l) => /ghost/.test(l.cls));
    check(thread.length >= 1 && asked.length === 1, 'the card has reply links in its thread and the link of the reply that asked the call', JSON.stringify(all.map((l) => l.cls)));
    check(all.every((l) => /^\/setup\/transcript-reader\/out\/prototype\.html#s=[^&]+&m=[^&]+$/.test(l.href) && l.target === '_blank' && /noopener/.test(l.rel)),
      'with no host the links keep the reader\'s own address, a new tab and noopener (the Reader pane\'s path)', JSON.stringify(all[0]));
    check(all.every((l) => l.session && l.message && l.href.includes('#s=' + encodeURIComponent(l.session) + '&m=' + encodeURIComponent(l.message))),
      'each carries the conversation and the reply it opens as data-session and data-message, the same ids as its address', JSON.stringify(all[0]));
    // the column: Conn's handler on the page
    ev(HOST);
    for (const l of all) {
      const what = /ghost/.test(l.cls) ? 'the "Open this reply in the reader" link' : 'a thread reply\'s open link';
      let got = click(l.i, false);
      check(got.told.length === 1 && got.told[0].session === l.session && got.told[0].reader === false && got.opened.length === 0,
        `in a Watch column a click on ${what} is taken by the column (the host is told the session) and does not go to the new-window hook`, JSON.stringify(got));
      got = click(l.i, true);
      check(got.told.length === 1 && got.told[0].session === l.session && got.told[0].reader === true && got.opened.length === 0,
        `and a Cmd-click on ${what} is taken too, for the normal reader`, JSON.stringify(got));
    }
  } catch (error) { check(false, 'the run finished', error.stack || error.message); }
  finish(stop);
})();
