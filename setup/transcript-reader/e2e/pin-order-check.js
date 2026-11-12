#!/usr/bin/env node
'use strict';

// The Pins panel lists the newest pin first, in a real (headless) browser (chrome-devtools-axi), against a lab copy of the reader on its own port with a
// fake Herdr (nothing is sent to any pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/pin-order-check.js <scratch folder> [screenshots folder]
//
// Nathan, 2026-11-12: the newest pin should be at the top of the pin view, and it was not. The check pins three messages of one conversation in an order
// that is not their reading order (the 1st, the 3rd, then the 2nd): "This conversation" (the panel's first list) and "All conversations" must both read
// 2nd, 3rd, 1st, so must pins.json (which other readers read as it stands), and a reload shows the same.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-pin-order-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, click, check, startLab, openPage, pick, finish, sleep } = make('reader-pin-order-check');

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop } = await startLab(folder);
  const file = path.join(lab.home, '.config', 'pmos-transcript-reader', 'pins.json');
  const saved = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).pins.map((pin) => pin.key); } catch (e) { return []; } };
  const LIST = `return { ok: true, scope: [...document.querySelectorAll('#pins-panel .pins-scope button.btn')].map(b => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')), items: [...document.querySelectorAll('#pins-panel .pins-list li .pin-text')].map(x => x.textContent) };`;
  try {
    await openPage(page, '1000x900x1');
    pick('crew-2'); await sleep(1500);
    const keys = ev(`return [...document.querySelectorAll('#main button.pin')].map(b => b.dataset.pin);`);
    check(keys.length >= 3, 'the conversation has at least three pinnable messages', String(keys.length));
    const order = [keys[0], keys[2], keys[1]];
    for (const key of order) {
      ev(`document.querySelector('#main button.pin[data-pin="${key}"]').click(); return true;`);
      for (let i = 0; i < 60 && !saved().includes(key); i++) await sleep(100);
      await sleep(300);
    }
    check(saved().join() === [keys[1], keys[2], keys[0]].join(), 'pins.json is the newest pin first (2nd, 3rd, 1st)', saved().map((k) => keys.indexOf(k) + 1).join());
    // pinning a message opens the panel by itself (on This conversation, with the new pin's description open), so the panel is already there
    let list = await until(LIST, 'the Pins panel');
    const label = (items) => items.join(' | ');
    // the lab's crew-2 reads: First question, First answer (its reply), Second question; the pins were made in the order 1st, 3rd, 2nd
    const want = ['First answer', 'Second question', 'First question'];
    check(list.items.length === 3, 'the panel lists the three pins', label(list.items));
    check(/\*/.test(list.scope[0]), 'it opens on This conversation', list.scope.join(' / '));
    const starts = (items) => items.length === 3 && items.every((text, n) => text.startsWith(want[n]));
    check(starts(list.items), 'This conversation lists the newest pin first', label(list.items) + ' | wanted ' + label(want));
    axi('screenshot', path.join(shots, 'pin-order-here.png'));
    ev(`document.querySelectorAll('#pins-panel .pins-scope button.btn')[1].click(); return true;`);
    await sleep(500);
    list = await until(LIST, 'the all-conversations list');
    check(starts(list.items), 'All conversations lists the newest pin first too', label(list.items));
    axi('screenshot', path.join(shots, 'pin-order-all.png'));
    // unpin the newest and pin it again: it comes back on top
    axi('open', 'about:blank'); axi('open', page); await sleep(1800);
    pick('crew-2'); await sleep(1500);
    click('button', 'Pins · 3'); await sleep(600);
    list = await until(LIST, 'the Pins panel after a reload');
    check(starts(list.items), 'a reload shows the same order', label(list.items));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
