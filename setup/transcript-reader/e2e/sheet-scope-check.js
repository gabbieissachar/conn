#!/usr/bin/env node
'use strict';

// The answer sheet lists the open conversation's sheets only, in a real (headless) browser (chrome-devtools-axi), against a lab copy of the
// reader on its own port with a fake Herdr (nothing is sent to any pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/sheet-scope-check.js <scratch folder> [screenshots folder]
//
// Nathan, 2026-11-08: the sheet view lists the sheets of every session; it must list the open session's only. In the lab two conversations have
// a sheet: cp-whatapps-tool (pane_lab.py gives it a keyed-answer reply) and crew-1 (this check adds one). With crew-1 on screen, the title bar's
// "Answer sheet" link and the reply's own link must open a sheet whose picker lists crew-1's alone, and the sheet's way back must return to crew-1.
// A sheet page opened with no address still lists both.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const READER = path.resolve(__dirname, '..');
const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-sheet-scope-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-sheet-scope-check');

const stamp = (outDir) => { try { return fs.statSync(path.join(outDir, 'prototype.html')).mtimeMs; } catch (e) { return 0; } };
const iso = (at) => new Date(at * 1000).toISOString();

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop, outDir } = await startLab(folder);
  const log = path.join(lab.home, '.claude', 'projects', '-lab-crew-1', lab.crew[0] + '.jsonl');
  const text = fs.readFileSync(path.join(READER, 'answer-sheet-fixtures', 'backtick-letters-in-cells-two-review-groups.md'), 'utf8');
  try {
    const before = stamp(outDir);
    const at = Date.now() / 1000 + 1;
    fs.appendFileSync(log, [
      { type: 'user', uuid: 'u-scope-1', timestamp: iso(at - 5), cwd: '/lab/crew-1', message: { role: 'user', content: 'Start the design' } },
      { type: 'assistant', timestamp: iso(at), cwd: '/lab/crew-1', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
    for (let i = 0; i < 120 && stamp(outDir) === before; i++) await sleep(250);
    await sleep(500);
    await openPage(page, '1000x900x1');
    pick('crew-1'); await sleep(1500);
    const base = page.replace(/prototype\.html.*$/, '');
    const SHEET = `const opts = [...document.querySelectorAll('#pick option')].map(o => o.text);
      return { ok: opts.length > 0 && document.querySelectorAll('.card .key').length > 0, opts, keys: [...document.querySelectorAll('.card .key')].map(n => n.textContent).join(), back: document.querySelector('.title a').getAttribute('href') };`;

    // ---- the title bar link of the conversation on screen
    const link = ev(`const a = document.querySelector('a.to-sheet'); return { ok: true, href: a.getAttribute('href') };`).href;
    check(/^questionnaire\.html#s=c4e70000$/.test(link), 'the title bar link names the conversation on screen', link);
    axi('open', base + link); await sleep(1500);
    let s = await until(SHEET, 'the sheet page');
    check(s.opts.length === 1 && /crew-1/.test(s.opts[0]), 'its picker lists crew-1\'s sheet alone', JSON.stringify(s.opts));
    check(s.keys.startsWith('P1,P2'), 'and opens on its cards', s.keys);
    check(s.back === 'prototype.html#s=c4e70000', 'the way back names the conversation', s.back);
    axi('screenshot', path.join(shots, 'sheet-scope-1-scoped.png'));

    // ---- the reply's own link
    axi('open', base + 'prototype.html'); await sleep(1500);
    pick('crew-1'); await sleep(1200);
    const reply = await until(`const card = [...document.querySelectorAll('#main .reply')].reverse().find(c => c.querySelector('a.btn.sheet')); return card ? { ok: true, href: card.querySelector('a.btn.sheet').getAttribute('href') } : { ok: false };`, 'the reply with its sheet link');
    axi('open', base + reply.href); await sleep(1500);
    s = await until(SHEET, 'the sheet page of the reply link');
    check(s.opts.length === 1, 'the reply\'s link lists one conversation\'s sheet too', JSON.stringify(s.opts));

    // ---- no address: every conversation's, as a bookmark of the page is
    axi('open', base + 'questionnaire.html'); await sleep(1500);
    s = await until(SHEET, 'the unscoped sheet page');
    check(s.opts.length >= 2 && s.opts.some((o) => /crew-1/.test(o)) && s.opts.some((o) => /cp-whatapps-tool/.test(o)), 'with no address the picker lists crew-1\'s and cp-whatapps-tool\'s', JSON.stringify(s.opts));
    ev(`const p = document.getElementById('pick'); p.value = '1'; p.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true };`);
    await sleep(500);
    check(ev(`return { ok: true, hash: location.hash };`).hash.startsWith('#pick='), 'a pick in the unscoped list is remembered as #pick, which does not narrow the list on reload');
    axi('screenshot', path.join(shots, 'sheet-scope-2-all.png'));

    // ---- a conversation with no sheet
    axi('open', base + 'prototype.html'); await sleep(1500);
    pick('cp-ontology-learning'); await sleep(1200);
    const none = ev(`return { ok: true, href: document.querySelector('a.to-sheet').getAttribute('href') };`).href;
    axi('open', base + none); await sleep(1500);
    s = ev(`return { ok: true, text: document.getElementById('main').innerText };`);
    check(/This conversation has no answer sheet/.test(s.text), 'a conversation with no sheet says so, and lists no other\'s', s.text.slice(0, 100));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
