#!/usr/bin/env node
'use strict';

// One answer sheet is one review group, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own port with a fake
// Herdr (nothing is sent to any pane). By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/sheet-group-check.js <scratch folder> [screenshots folder]
//
// The owner, 2026-11-06: "the answer sheet for this review group got mixed up with previous/not relevant questions. Can tighten the answer sheet
// logics to render answer sheet for 1 coherent section/1 review group." Her reply that opened review group X (X1 to X6, "Reply with keyed answers:
// X1=...") began with a recap table, Key | In plain words, of calls from earlier groups; the sheet listed Z2 and Z3 beside X1 to X6. The lab's
// crew-1 gets two replies in that shape (invented text, answer-sheet-fixtures/): the glossary one, and one that recaps an earlier group's decisions
// in a table that looks like cards. The reader page's box under the reply and the sheet page must list the group's cards only.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const READER = path.resolve(__dirname, '..');
const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-sheet-group-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-sheet-group-check');

const stamp = (outDir) => { try { return fs.statSync(path.join(outDir, 'prototype.html')).mtimeMs; } catch (e) { return 0; } };
const iso = (at) => new Date(at * 1000).toISOString();

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop, outDir } = await startLab(folder);
  const log = path.join(lab.home, '.claude', 'projects', '-lab-crew-1', lab.crew[0] + '.jsonl');
  const ask = (n, text) => {
    const at = Date.now() / 1000 + n;
    fs.appendFileSync(log, [
      { type: 'user', uuid: `u-group-${n}`, timestamp: iso(at - 5), cwd: '/lab/crew-1', message: { role: 'user', content: `Next group please ${n}` } },
      { type: 'assistant', timestamp: iso(at), cwd: '/lab/crew-1', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
  };
  const fixture = (name) => fs.readFileSync(path.join(READER, 'answer-sheet-fixtures', name + '.md'), 'utf8');
  try {
    const before = stamp(outDir);
    ask(1, fixture('glossary-then-one-review-group'));
    for (let i = 0; i < 120 && stamp(outDir) === before; i++) await sleep(250);
    await sleep(500);
    await openPage(page, '1000x900x1');
    pick('crew-1'); await sleep(1500);

    // ---- the reader page: the box under the reply lists the group, and the link opens the sheet
    const REPLY = `const card = [...document.querySelectorAll('#main .reply')].reverse().find(c => c.querySelector('a.btn.sheet'));
      if (!card) return { ok: false };
      const keys = [...card.querySelectorAll('.cardq b')].map(b => b.textContent);
      return { ok: true, keys, more: [...card.querySelectorAll('.asks .notes')].map(n => n.textContent), href: card.querySelector('a.btn.sheet').getAttribute('href') };`;
    let s = await until(REPLY, 'the reply with its answer sheet link');
    check(s.keys.join() === 'X1,X2,X3,X4' && s.more.some((t) => /2 more in the answer sheet/.test(t)), 'the box under the reply lists X1 to X4 and says 2 more are in the sheet: six questions, none of them Z2 or Z3', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'sheet-group-01-reader.png'));

    // ---- the sheet page, opened as the link does
    const base = page.replace(/prototype\.html.*$/, '');
    axi('open', base + 'questionnaire.html' + s.href.slice(s.href.indexOf('#')));
    await sleep(1800);
    const SHEET = `const keys = [...document.querySelectorAll('.card .key')].map(n => n.textContent);
      const ctx = document.querySelector('details.context'); const aside = [...document.querySelectorAll('.section')].map(n => n.textContent);
      return { ok: keys.length > 0, keys, context: ctx ? ctx.innerText.slice(0, 700) : '', aside };`;
    s = await until(SHEET, 'the sheet page with its cards');
    check(s.keys.join() === 'X1,X2,X3,X4,X5,X6', 'the sheet lists X1 to X6 and nothing else', s.keys.join());
    ev(`document.querySelector('details.context').open = true; return true;`); await sleep(400);
    const text = ev(`return { ok: true, text: document.querySelector('details.context').innerText };`).text;
    check(!/what those keys meant|Personal script|Z3|Land/.test(text) && /Review group X/.test(text), 'with it open, the recap of earlier calls is not in it, and the group\'s section is', text.slice(0, 160).replace(/\n/g, ' | '));
    check(!s.aside.some((t) => /Not on this sheet/.test(t)), 'nothing is "left out" of a glossary: it never asked anything');
    axi('screenshot', path.join(shots, 'sheet-group-02-sheet.png'));

    // ---- a reply that recaps an earlier group's decisions in a table that looks like cards
    const before2 = stamp(outDir);
    ask(2, fixture('recap-table-of-an-earlier-group'));
    for (let i = 0; i < 120 && stamp(outDir) === before2; i++) await sleep(250);
    await sleep(3500);  // the sheet page takes the build
    s = await until(`const keys = [...document.querySelectorAll('.card .key')].map(n => n.textContent); return { ok: keys.length > 0, keys, aside: [...document.querySelectorAll('.locked-item')].map(n => n.textContent) };`, 'the sheet page of the newer reply');
    axi('open', base + 'questionnaire.html'); await sleep(1800);
    s = ev(`const keys = [...document.querySelectorAll('.card .key')].map(n => n.textContent); return { ok: true, keys, aside: [...document.querySelectorAll('.locked-item')].map(n => n.textContent), sections: [...document.querySelectorAll('.section')].map(n => n.textContent) };`);
    check(s.keys.join() === 'B1,B2,B3', 'the newest reply\'s sheet lists B1 to B3, not the earlier group\'s A1 to A3', s.keys.join());
    check(s.sections.includes('Not on this sheet') && s.aside.some((t) => /^A1, A2, A3:/.test(t)), 'and says in the margin that A1, A2 and A3 are not asked here', JSON.stringify(s.aside));
    axi('screenshot', path.join(shots, 'sheet-group-03-recap.png'));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
