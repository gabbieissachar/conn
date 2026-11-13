#!/usr/bin/env node
'use strict';

// How long going back from the answer sheet to the conversation takes, in a real (headless) browser (chrome-devtools-axi), against a lab copy of
// the reader on its own port with a fake Herdr (nothing is sent to any pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/sheet-back-latency.js <scratch folder> [rounds]
//
// The lab is the size of Nathan's reading list (LAB_FILLERS=90 conversations, LAB_BIG_EXCHANGES=400 exchanges each: a 12 MB page). The
// conversation is cp-whatapps-tool, which has an answer sheet. For each of the two readers (the full page and the lite page) it opens the sheet
// from the conversation and clicks the sheet's way back, `rounds` times (default 5). Everything is read from the page that is opened, after it
// settled, from its own clocks (milliseconds since that page's navigation began):
//   first paint   the page first drew something (Paint Timing),
//   turns drawn   the conversation's turns are on screen (a MutationObserver cannot run before the page does, so this is the first paint
//                 of the page, which already holds them; the check below says they are there),
//   state         the answer of the server's first /state call: the dock says "Connecting to the local server…" until it comes (the pane
//                 Send goes to, and the live badges, are known only then),
//   ready         the dock names its pane ("To <pane> · ..."), by polling it from the driver (about 100 ms resolution).
// LAB_FILLERS and LAB_BIG_EXCHANGES set the size; ONLY=<variant name> runs one reader.

const fs = require('fs');
const { make } = require('./axi');

const folder = require('path').resolve(process.argv[2] || require('path').join(require('os').tmpdir(), 'reader-sheet-back-lab'));
const rounds = Number(process.argv[3] || 5);
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-sheet-back-latency');
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

(async () => {
  process.env.LAB_FILLERS = process.env.LAB_FILLERS || '90';
  process.env.LAB_BIG_EXCHANGES = process.env.LAB_BIG_EXCHANGES || '400';
  const { page, stop, outDir } = await startLab(folder);
  try {
    await sleep(3000);
    const base = page.replace(/prototype\.html.*$/, '');
    process.stdout.write(`      prototype.html is ${(fs.statSync(require('path').join(outDir, 'prototype.html')).size / 1048576).toFixed(1)} MB in this lab\n`);
    await openPage(page, '1000x900x1');
    const variants = [
      { name: 'full reader', dir: '', reader: 'prototype.html', open: async () => { axi('open', page); await sleep(1500); pick('cp-whatapps-tool'); await sleep(1200); } },
      { name: 'lite page', dir: 'live/', reader: 'index.html', open: async () => { axi('open', base + 'live/index.html#s=700100aa'); await sleep(2000); } },
    ].filter((v) => !process.env.ONLY || v.name === process.env.ONLY);
    for (const v of variants) {
      const rows = [];
      for (let round = 0; round < rounds; round++) {
        await v.open();
        await until(`return { ok: document.querySelectorAll('#main .reply').length > 0 };`, 'the conversation');
        const link = ev(`return { ok: true, href: document.querySelector('a.to-sheet').getAttribute('href') };`).href;
        axi('open', base + v.dir + link); await sleep(1500);
        await until(`return { ok: document.querySelectorAll('.card .key').length > 0 };`, 'the sheet');
        await sleep(2500);  // the sheet has been polling the server, as it does while it is read
        const start = Date.now();
        ev(`document.querySelector('.title a').click(); return true;`);
        let ready = null;
        for (let i = 0; i < 300 && ready === null; i++) {
          try {
            const s = ev(`const st = document.getElementById('dock-status'); return { ok: true, page: location.pathname.split('/').pop(), turns: document.querySelectorAll('#main .reply').length, status: st ? st.textContent : '' };`);
            if (s.page === v.reader && s.turns > 0 && /^To /.test(s.status)) ready = Date.now() - start;
          } catch (e) { /* the page is changing */ }
        }
        await sleep(800);
        const m = ev(`const fcp = performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint'); const st = performance.getEntriesByType('resource').find(e => /\\/state(\\?|$)/.test(e.name));
          return { ok: true, fcp: fcp ? Math.round(fcp.startTime) : -1, state: st ? Math.round(st.responseEnd) : -1, turns: document.querySelectorAll('#main .reply, #main .you').length, page: location.pathname.split('/').pop() };`);
        rows.push({ ...m, ready });
        process.stdout.write(`      ${v.name} round ${round + 1}: first paint ${m.fcp} ms, first /state answered ${m.state} ms (page clock); the dock named its pane ${ready} ms after the click (driver clock)\n`);
      }
      const col = (k) => median(rows.map((r) => r[k]));
      process.stdout.write(`      ${v.name}: MEDIAN first paint ${col('fcp')} ms, first /state answered ${col('state')} ms, dock ready ${col('ready')} ms (driver)\n`);
      check(rows.every((r) => r.turns > 0 && r.page === v.reader && r.ready !== null), `${v.name}: the conversation and its controls came back every round`);
    }
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
