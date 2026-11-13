#!/usr/bin/env node
'use strict';

// An answer sheet that reads its choices out of table cells and knows review groups, in a real (headless) browser (chrome-devtools-axi),
// against a lab copy of the reader on its own port with a fake Herdr (nothing is sent to any pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/sheet-cells-check.js <scratch folder> [screenshots folder]
//
// Nathan, 2026-11-08: a reply of two review groups whose tables held the choices as backtick letters with their words in the Answer cell
// showed no choices on the sheet, and its two groups as one list. The lab's crew-1 gets that shape (invented text,
// answer-sheet-fixtures/backtick-letters-in-cells-two-review-groups.md): the sheet must show each letter with its words, mark the recommended
// one, and put each group under its own heading with its lead-in.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const READER = path.resolve(__dirname, '..');
const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-sheet-cells-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-sheet-cells-check');

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
      { type: 'user', uuid: 'u-cells-1', timestamp: iso(at - 5), cwd: '/lab/crew-1', message: { role: 'user', content: 'Start the design' } },
      { type: 'assistant', timestamp: iso(at), cwd: '/lab/crew-1', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
    for (let i = 0; i < 120 && stamp(outDir) === before; i++) await sleep(250);
    await sleep(500);
    await openPage(page, '1000x900x1');
    pick('crew-1'); await sleep(1500);
    const REPLY = `const card = [...document.querySelectorAll('#main .reply')].reverse().find(c => c.querySelector('a.btn.sheet'));
      return card ? { ok: true, href: card.querySelector('a.btn.sheet').getAttribute('href') } : { ok: false };`;
    const reply = await until(REPLY, 'the reply with its answer sheet link');
    const base = page.replace(/prototype\.html.*$/, '');
    axi('open', base + 'questionnaire.html' + reply.href.slice(reply.href.indexOf('#')));
    await sleep(1800);
    const SHEET = `const cards = [...document.querySelectorAll('.card')].map(c => ({ key: c.querySelector('.key').textContent, opts: [...c.querySelectorAll('.opt')].map(o => o.firstChild.textContent), star: [...c.querySelectorAll('.opt')].filter(o => o.querySelector('.star')).map(o => o.firstChild.textContent), notes: [...c.querySelectorAll('.opt-note')].map(n => n.textContent), rec: (c.querySelector('.rec') || {}).textContent || '' }));
      return { ok: cards.length > 0, cards, heads: [...document.querySelectorAll('.group-head')].map(h => h.innerText.replace(/\\n+/g, ' | ')) };`;
    const s = await until(SHEET, 'the sheet page with its cards');
    check(s.cards.map((c) => c.key).join() === 'P1,P2,P3,P4,P5,P6', 'the sheet lists P1 to P6', s.cards.map((c) => c.key).join());
    const p1 = s.cards[0];
    check(p1.opts.slice(0, 3).join() === 'a,b,c' && p1.star.join() === 'b', 'P1 offers a, b and c in the reply\'s order, and b carries the recommended star', JSON.stringify([p1.opts, p1.star]));
    check(/Recommended: the app, the digest and the system/.test(p1.rec), 'P1 shows its recommendation by its words, not by the letter b', p1.rec);
    check(p1.notes.some((n) => /^a the app and the digest only/.test(n)) && p1.notes.some((n) => /^c the app's own badge/.test(n)), 'the words of a and c are under the buttons', JSON.stringify(p1.notes));
    check(s.heads.length === 2 && /^Review group A.*what "quiet" means \| Answer these in order/.test(s.heads[0]) && /^Review group B.*the timer \| These are independent/.test(s.heads[1]), 'each group has its own heading and lead-in', JSON.stringify(s.heads));
    const order = ev(`const main = document.getElementById('main'); return { ok: true, order: [...main.querySelectorAll('.group-head, .card')].map(n => n.classList.contains('group-head') ? 'G' : n.querySelector('.key').textContent).join('') };`).order;
    check(order === 'GP1P2P3GP4P5P6', 'the headings stand above their own cards', order);
    axi('screenshot', path.join(shots, 'sheet-cells-1-sheet.png'));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
