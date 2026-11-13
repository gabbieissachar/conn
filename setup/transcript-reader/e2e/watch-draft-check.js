#!/usr/bin/env node
'use strict';

// The unsent message survives a web view being let go of, in a real (headless) browser (chrome-devtools-axi), against a lab copy of the reader on
// its own port with a fake Herdr (nothing is sent to any real pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/watch-draft-check.js <scratch folder> [screenshots folder]
//
// Nathan, 2026-11-12: the normal view keeps the words typed in the message box but not yet sent, and a Watch column loses them when he goes to
// another view and comes back. Conn lets go of every Watch column's web view when Watch ends (and the Reader column's with it) and makes new ones
// when Watch comes back, and a new web view starts with an empty sessionStorage, where the drafts were kept. A second browser tab behaves the same:
// same stored data, empty sessionStorage. So each page (the lite page a Watch column loads, 380 px, and the full page of the normal view) is checked
// the way Nathan meets it: type, open the conversation in a new tab as the "new web view", look at the box. Run against the code before the fix, the
// new-view checks fail (that is the reproduction); after it they hold.
//
// Also: the Reply pointer, a batch and the Edit position come back; another conversation's box stays empty; a view that comes back reads what
// another wrote; Undo keeps the words; a sent message does not come back; an 8-day-old draft is dropped; then screenshots of a restored draft at
// Watch widths (330, 480 px), a phone (390 px) and 1440 px, light and dark.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-watch-draft-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, finish, sleep } = make('reader-watch-draft-check');

const STATE = `const t = document.getElementById('dock-text'); const chip = document.getElementById('dock-chip'); const ls = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^tr-(hosted-)?(draft|batch):/.test(k)) ls.push(k.replace(/:.*/, '')); } } catch (e) { /* no storage */ }
  return { ok: true, title: document.title.slice(0, 12), box: t ? t.value : null, readonly: Boolean(t && t.readOnly), send: document.getElementById('dock-send').textContent,
    chip: chip ? !chip.hidden : null, chipText: chip ? document.getElementById('dock-chip-title').textContent : '', batch: [...document.querySelectorAll('#dock-batch-list li .what span')].map((x) => x.textContent), ls };`;
const TYPE = (text) => `const b = document.getElementById('dock-text'); b.value = ${JSON.stringify(text)}; b.dispatchEvent(new Event('input', { bubbles: true })); return true;`;
const CLICK_ID = (id) => `document.getElementById('${id}').click(); return true;`;
const prompts = (lab) => (fs.existsSync(lab.log) ? fs.readFileSync(lab.log, 'utf8').split(/^(?=PROMPT)/m) : []).filter((l) => /^PROMPT/.test(l));

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, port, stop } = await startLab(folder);
  const base = `http://localhost:${port}/setup/transcript-reader/out/`;
  const [A, B] = [lab.crew[0], lab.crew[1]];
  const ready = (title) => until(`return { ok: document.title.startsWith('${title} · ') && !!document.getElementById('dock-text') };`, title + ' drawn');
  let size = '380x800x1';
  // The "new web view": a second tab on the same address. It shares the stored data and has no sessionStorage of its own.
  const newView = async (url, title) => { axi('newpage', url); axi('emulate', '--viewport', size); await ready(title); await sleep(900); };
  const closeView = () => { const ids = [...axi('pages').matchAll(/^\s+(\d+),/gm)].map((m) => m[1]); axi('closepage', ids[ids.length - 1]); axi('selectpage', ids[ids.length - 2]); };
  const open = async (url, title, full) => { axi('open', 'about:blank'); axi('emulate', '--viewport', size); axi('open', url); await ready(title); if (full) ev(`localStorage.setItem('tr-follow', '0'); return true;`); await sleep(900); };

  try {
    for (const [name, file, viewport] of [['lite page (Watch column)', 'live/index.html', '380x800x1'], ['full page (normal view)', 'prototype.html', '1000x900x1']]) {
      size = viewport;
      const full = file === 'prototype.html';
      const urlA = `${base}${file}#s=${A}`, urlB = `${base}${file}#s=${B}`;
      const at = (what) => `${name}: ${what}`;
      // Start clean: nothing kept from the previous page's checks.
      axi('open', 'about:blank'); axi('open', urlA); await ready('crew-1');
      ev(`localStorage.clear(); sessionStorage.clear(); return true;`);
      await open(urlA, 'crew-1', full);

      // 1. words and a Reply pointer, then the web view is let go of and a new one made
      ev(`const r = document.querySelector('#main button.reply-to'); if (r) r.click(); return Boolean(r);`); await sleep(500);
      ev(TYPE('unsent words about the next step'));
      let s = ev(STATE);
      check(s.box === 'unsent words about the next step' && s.chip, at('typed words and a Reply pointer are in the bar'), JSON.stringify({ box: s.box, chip: s.chip }));
      await newView(urlA, 'crew-1');
      s = ev(STATE);
      check(s.box === 'unsent words about the next step', at('a new web view of the conversation has the words back'), JSON.stringify(s.box));
      check(s.chip === true && /\S/.test(s.chipText), at('and the Reply pointer'), JSON.stringify({ chip: s.chip, title: s.chipText }));
      check(s.ls.includes('tr-draft') || s.ls.includes('tr-hosted-draft'), at('the draft is kept in localStorage (one entry for the conversation)'), JSON.stringify(s.ls));

      // 2. the other conversation has its own, empty box
      ev(`location.hash = '#s=${B}'; return true;`); await ready('crew-2'); await sleep(700);
      s = ev(STATE);
      check(s.box === '' && s.chip === false, at('another conversation has an empty box and no pointer'), JSON.stringify({ box: s.box, chip: s.chip }));

      // 3. a words typed in the second view are what the first one shows when it comes back to the conversation
      ev(`location.hash = '#s=${A}'; return true;`); await ready('crew-1'); await sleep(700);
      ev(TYPE('newer words typed in the second view')); closeView(); await sleep(300);
      ev(`location.hash = '#s=${B}'; return true;`); await ready('crew-2'); await sleep(500);
      ev(`location.hash = '#s=${A}'; return true;`); await ready('crew-1'); await sleep(700);
      s = ev(STATE);
      check(s.box === 'newer words typed in the second view', at('the first view reads what the second wrote when it comes back to the conversation'), JSON.stringify(s.box));

      // 4. the Undo window: a view made while the message is held has the words and nothing was sent; the held page's window then ends and the pane gets it once
      const before = prompts(lab).length;
      ev(CLICK_ID('dock-send')); await sleep(500);
      s = ev(STATE);
      check(s.readonly && /^Undo/.test(s.send), at('Send holds the message (Undo window)'), JSON.stringify({ readonly: s.readonly, send: s.send }));
      await newView(urlA, 'crew-1');
      s = ev(STATE);
      check(s.box === 'newer words typed in the second view' && prompts(lab).length === before, at('a view made during the Undo window has the words and nothing was sent'), JSON.stringify({ box: s.box, sent: prompts(lab).length - before }));
      closeView();
      for (let i = 0; i < 60 && prompts(lab).length === before; i++) await sleep(250);
      check(prompts(lab).length === before + 1, at('the held page\'s window ended and the pane got the message once'), String(prompts(lab).length - before));
      await sleep(1500);
      await newView(urlA, 'crew-1');
      s = ev(STATE);
      check(s.box === '' && !s.ls.some((k) => /draft/.test(k)), at('after the send a new web view has an empty box and no draft entry is left'), JSON.stringify({ box: s.box, ls: s.ls }));
      closeView();

      // 5. Undo: the words are back in the box and kept
      ev(TYPE('words that are taken back')); ev(CLICK_ID('dock-send')); await sleep(500);
      ev(CLICK_ID('dock-send')); await sleep(600);   // while held, the button reads Undo
      s = ev(STATE);
      check(s.box === 'words that are taken back' && !s.readonly && prompts(lab).length === before + 1, at('Undo puts the words back in the box and sends nothing'), JSON.stringify({ box: s.box, readonly: s.readonly }));
      await newView(urlA, 'crew-1');
      s = ev(STATE);
      check(s.box === 'words that are taken back', at('a new web view still has them after Undo'), JSON.stringify(s.box));
      closeView();

      // 5b. Send now: the box empties as soon as it goes, and no view brings the words back
      ev(CLICK_ID('dock-send')); await sleep(500);
      ev(`const n = [...document.querySelectorAll('button')].find(b => b.textContent === 'Send now'); if (n) n.click(); return Boolean(n);`);
      for (let i = 0; i < 40 && prompts(lab).length === before + 1; i++) await sleep(250);
      check(prompts(lab).length === before + 2, at('Send now: the pane got the message once'), String(prompts(lab).length - before));
      s = ev(STATE);
      check(s.box === '' && !s.readonly, at('the box is empty as soon as it goes'), JSON.stringify({ box: s.box, readonly: s.readonly }));
      await sleep(1500);
      await newView(urlA, 'crew-1');
      s = ev(STATE);
      check(s.box === '' && !s.ls.some((k) => /draft/.test(k)), at('after Send now a new web view has an empty box and no draft entry is left'), JSON.stringify({ box: s.box, ls: s.ls }));
      closeView();

      // 6. a batch and the Edit position come back; the half-typed words with them
      ev(TYPE('first comment')); ev(CLICK_ID('dock-add')); await sleep(400);
      ev(TYPE('second comment')); ev(CLICK_ID('dock-add')); await sleep(400);
      ev(`document.querySelectorAll('#dock-batch-list li button')[0].click(); return true;`); await sleep(400);   // Edit the first comment
      s = ev(STATE);
      check(s.box === 'first comment' && s.batch.length === 1, at('Edit puts the first comment in the box'), JSON.stringify({ box: s.box, batch: s.batch }));
      ev(TYPE('first comment, reworded'));
      await newView(urlA, 'crew-1');
      s = ev(STATE);
      check(s.box === 'first comment, reworded' && s.batch.join() === 'second comment', at('a new web view has the box in Edit and the comment still waiting'), JSON.stringify({ box: s.box, batch: s.batch }));
      ev(CLICK_ID('dock-add')); await sleep(500);
      s = ev(STATE);
      check(s.batch.join() === 'first comment, reworded,second comment', at('Add puts the edited comment back in its place (first)'), JSON.stringify(s.batch));
      closeView();
      ev(TYPE('half-typed words')); await sleep(200);
      await newView(urlA, 'crew-1');
      s = ev(STATE);
      check(s.batch.length === 2 && s.box === 'half-typed words', at('the batch (2 comments) and the half-typed words come back together'), JSON.stringify({ batch: s.batch, box: s.box }));
      axi('screenshot', path.join(shots, `${full ? 'full' : 'lite'}-restored-light.png`));
      closeView();

      // 7. an entry older than 7 days is not shown, and is removed at the next page start
      ev(`for (const k of Object.keys(localStorage)) { if (/^tr-(hosted-)?(draft|batch):/.test(k)) { const v = JSON.parse(localStorage.getItem(k)); v.at = Date.now() - 8 * 864e5; localStorage.setItem(k, JSON.stringify(v)); } } return true;`);
      await newView(urlA, 'crew-1');
      s = ev(STATE);
      check(s.box === '' && s.batch.length === 0 && s.ls.length === 0, at('an 8-day-old draft and batch are not shown and are removed'), JSON.stringify({ box: s.box, batch: s.batch, ls: s.ls }));
      closeView();

      // 8. an emptied box leaves nothing behind
      ev(TYPE('words to take back')); ev(TYPE('')); await sleep(200);
      s = ev(STATE);
      check(!s.ls.some((k) => /draft/.test(k)), at('a box emptied by hand leaves no entry'), JSON.stringify(s.ls));
    }

    // 9. the pictures: a restored draft with a pointer and a batch at Watch widths, a phone and 1440 px, light and dark
    for (const [file, w, h, scheme, file2] of [
      ['live/index.html', 330, 800, 'light', 'lite-330-light'], ['live/index.html', 330, 800, 'dark', 'lite-330-dark'],
      ['live/index.html', 480, 800, 'light', 'lite-480-light'], ['live/index.html', 480, 800, 'dark', 'lite-480-dark'],
      ['prototype.html', 390, 844, 'light', 'full-390-light'], ['prototype.html', 390, 844, 'dark', 'full-390-dark'],
      ['prototype.html', 1440, 900, 'light', 'full-1440-light'], ['prototype.html', 1440, 900, 'dark', 'full-1440-dark'],
    ]) {
      size = `${w}x${h}x1`;
      const full = file === 'prototype.html', url = `${base}${file}#s=${A}`;
      axi('open', 'about:blank'); axi('emulate', '--viewport', size, '--color-scheme', scheme);
      axi('open', url); await ready('crew-1'); if (full) ev(`localStorage.setItem('tr-follow', '0'); return true;`); await sleep(700);
      ev(`localStorage.clear(); return true;`);
      axi('open', 'about:blank'); axi('open', url); await ready('crew-1'); await sleep(700);
      ev(TYPE('first comment')); ev(CLICK_ID('dock-add')); await sleep(300);
      ev(TYPE('second comment')); ev(CLICK_ID('dock-add')); await sleep(300);
      ev(`const r = document.querySelector('#main button.reply-to'); if (r) r.click(); return true;`); await sleep(400);
      ev(TYPE('Unsent words that are long enough to wrap onto a second line in the message box at a narrow width.'));
      await newView(url, 'crew-1');
      axi('emulate', '--viewport', size, '--color-scheme', scheme);
      await sleep(400);
      const s = ev(STATE);
      const wide = ev(`return { ok: true, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };`);
      check(s.box.startsWith('Unsent words') && s.batch.length === 2 && s.chip && wide.overflow <= 0, `${file2}: the restored draft, pointer and batch draw, and the page does not scroll sideways`, JSON.stringify({ box: s.box.slice(0, 20), batch: s.batch.length, chip: s.chip, overflow: wide.overflow }));
      axi('screenshot', path.join(shots, `${file2}.png`));
      closeView();
    }
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  }
  finish(stop);
})();
