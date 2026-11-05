#!/usr/bin/env node
'use strict';

// Marking a reply's answer sheet as wrong or missing, and drawing it again, in a real browser (chrome-devtools-axi), against a lab copy of
// the reader on its own port. By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/sheet-flag-check.js <scratch folder> [screenshots folder]
//
// The lab (pane_lab.py) has one pane whose latest reply is a keyed-answer reply in the shape the owner flagged on 2026-11-04 (a Key | Call |
// Recommended table, the choices inside the Call cell). The run first puts the lab copy's sheet finder back to the one that did not read
// that shape (its key column rule, one line, as it was) and has the page draw itself again, which is the owner's problem: no sheet. Then,
// through the page only: opens the Sheet control on the reply, marks it as one that should have a sheet, sees the mark kept (the marks file in
// the lab's own home, ids and times only), lists it with `reader.py sheet-flags` and prints its masked shape; puts the real finder back, has
// the page Re-render, and sees the sheet appear (9 questions, the link under the reply) with the mark still there; clears the mark.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { make } = require('./axi');

const READER = path.resolve(__dirname, '..');
const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-sheet-flag-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { check, axi, ev, until, click, startLab, openPage, pick, finish, sleep } = make('reader-sheet-flag-check');

const REPLY = `const card = [...document.querySelectorAll('.reply')].find(c => c.querySelector('button.sheet-flag'));
  if (!card) return { ok: false, replies: document.querySelectorAll('.reply').length };
  const panel = card.querySelector('.sheetfix'), button = card.querySelector('button.sheet-flag');
  return { ok: true, link: Boolean(card.querySelector('a.btn.sheet')), linkText: (card.querySelector('a.btn.sheet') || {}).textContent || '', open: !panel.hidden, pressed: button.getAttribute('aria-pressed'),
    panel: panel.hidden ? '' : panel.innerText.replace(/\\n+/g, ' | '), acts: [...panel.querySelectorAll('button')].map(b => b.textContent) };`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop, outDir } = await startLab(folder);
  const flagsFile = path.join(lab.home, '.config', 'pmos-transcript-reader', 'sheet-flags.json');
  const parser = path.join(lab.repo, 'setup', 'transcript-reader', 'prototype', 'build_questionnaire.py');
  const real = fs.readFileSync(path.join(READER, 'prototype', 'build_questionnaire.py'), 'utf8');
  const OLD_RULE = 'column(header, "id", "card")', NEW_RULE = 'column(header, "id", "card", "key")';
  const cli = (...args) => execFileSync('python3', ['-I', path.join(lab.repo, 'setup', 'transcript-reader', 'reader.py'), 'sheet-flags', ...args], { encoding: 'utf8', env: { ...process.env, HOME: lab.home } });
  try {
    // ---- the finder as it was: the reply has no sheet
    check(real.includes(NEW_RULE), 'the finder in this copy reads a table whose id column is called Key');
    fs.writeFileSync(parser, real.replace(NEW_RULE, OLD_RULE));
    await openPage(page);
    pick('cp-whatapps-tool'); await sleep(800);
    let s = await until(REPLY, 'the reply with the Sheet control');
    check(s.link === true, 'the lab starts with the sheet drawn by the current finder', JSON.stringify(s));
    click('button', 'Sheet'); await sleep(500);
    s = ev(REPLY);
    check(s.open && /It has an answer sheet with 9 questions/.test(s.panel) && s.acts.includes('Mark: this sheet is wrong') && s.acts.includes('Re-render'), 'the Sheet control opens a panel that says what the reply has now', s.panel);
    click('button', 'Re-render'); await until(`const p = document.querySelector('.sheetfix'); return { ok: Boolean(p) && /Drawn again/.test(p.innerText), text: p && p.innerText };`, 'Re-render with the old finder', 60000);
    s = ev(REPLY);
    check(s.link === false && /still no answer sheet/.test(s.panel) && /It has no answer sheet/.test(s.panel), 'with the finder as it was, Re-render shows what the owner saw: no answer sheet', s.panel);
    check(s.acts.includes('Mark: this should be a sheet'), 'the mark offered is for a reply that should have a sheet', s.acts.join(', '));
    axi('screenshot', path.join(shots, 'sheet-flag-01-no-sheet.png'));

    // ---- mark it
    click('button', 'Mark: this should be a sheet'); await sleep(800);
    s = ev(REPLY);
    check(s.pressed === 'true' && /Marked as a reply that should have a sheet/.test(s.panel) && s.acts.includes('Clear mark'), 'marking it is shown on the button and in the panel', s.panel);
    const kept = JSON.parse(fs.readFileSync(flagsFile, 'utf8')).flags;
    check(kept.length === 1 && kept[0].kind === 'missing' && /^[\w-]{8,80}:reply$/.test(kept[0].key) && Object.keys(kept[0]).sort().join() === 'at,conv,flagged,key,kind', 'the mark is kept by id, time and kind only, in the lab\'s own home', JSON.stringify(kept[0]));
    check((fs.statSync(flagsFile).mode & 0o777) === 0o600, 'the marks file is the owner\'s alone');
    const listing = cli();
    check(/missing/.test(listing) && /now no answer sheet/.test(listing) && !/Restore the strict/.test(listing), 'reader.py sheet-flags lists it and says the finder still makes no sheet of it, with none of its text', listing.split('\n')[0]);
    const shape = cli('--shape', kept[0].key.slice(0, 8));
    check(/\| Key \| Call \| Recommended \|/.test(shape) && /\| \*\*R1\*\* \|/.test(shape) && !/strict option/.test(shape) && /Reply like `R1=a; R2=a; \.\.\.`/.test(shape), 'its shape comes out with the structure kept and the words masked', shape.split('\n').slice(2, 6).join(' / '));

    // ---- the finder as it is now: Re-render draws the sheet
    fs.writeFileSync(parser, real);
    await sleep(300);
    click('button', 'Re-render'); await until(`const p = document.querySelector('.sheetfix'); return { ok: Boolean(p) && /Drawn again: it is an answer sheet/.test(p.innerText), text: p && p.innerText };`, 'Re-render with the current finder', 60000);
    s = ev(REPLY);
    check(s.link === true && /Drawn again: it is an answer sheet with 9 questions/.test(s.panel), 'Re-render with the current finder draws the answer sheet (9 questions) and the link appears under the reply', `${s.linkText} | ${s.panel}`);
    check(s.pressed === 'true' && /Its sheet now has 9 questions|It has an answer sheet with 9 questions/.test(s.panel), 'the mark is still there, with the reply now having a sheet', s.panel);
    check(/now an answer sheet with 9 questions/.test(cli()), 'reader.py sheet-flags says the same');
    axi('screenshot', path.join(shots, 'sheet-flag-02-sheet-drawn.png'));
    const sheet = fs.readFileSync(path.join(outDir, 'questionnaire.html'), 'utf8');
    check(/Restore the strict option checks/.test(sheet) && /wait for the new build/.test(sheet), 'the answer sheet page itself carries the questions with their choices');

    // ---- clear the mark
    click('button', 'Clear mark'); await sleep(800);
    s = ev(REPLY);
    check(s.pressed === 'false' && /Not marked/.test(s.panel) && JSON.parse(fs.readFileSync(flagsFile, 'utf8')).flags.length === 0, 'clearing the mark takes it off the button, the panel and the file', s.panel);
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  }
  finish(stop);
})();
