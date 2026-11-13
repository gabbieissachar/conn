#!/usr/bin/env node
'use strict';

// A newly starred session goes to the top of the Starred group, in a real (headless) browser (chrome-devtools-axi), against a lab copy of the reader on
// its own port with a fake Herdr (nothing is sent to any pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/star-order-check.js <scratch folder> [screenshots folder]
//
// Nathan, 2026-11-08: a newly pinned (starred) session goes to the top of the pinned list. Stars are kept in the lab home's stars.json, which Conn reads as it
// stands. The check stars crew-4, crew-2 and crew-6 one after the other from the page's star button: the picker's Starred group must be crew-6, crew-2,
// crew-4 and so must the file; unstarring crew-2 and starring it again puts it on top; a reload shows the same. (A file written oldest first by an earlier
// version is put in order by the server on start: pinstore.test.js.)

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-star-order-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-star-order-check');

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop } = await startLab(folder);
  const file = path.join(lab.home, '.config', 'pmos-transcript-reader', 'stars.json');
  const order = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).stars.map((star) => star.conv); } catch (e) { return []; } };
  const labelOf = (id) => `crew-${lab.crew.indexOf(id) + 1}`;
  const GROUP = `const g = [...document.querySelectorAll('select[name=session] optgroup')].find(x => /^Starred/.test(x.label)); return { ok: true, label: g ? g.label : null, names: g ? [...g.querySelectorAll('option')].map(o => o.text.replace(/^★ /, '').split(' · ').pop()) : [] };`;
  try {
    await openPage(page, '1000x900x1');
    const star = async (label, expectCount) => {
      pick(label); await sleep(1200);
      ev(`document.querySelector('.star-btn:not([hidden])').click(); return true;`);
      for (let i = 0; i < 60 && order().length !== expectCount; i++) await sleep(100);
      await sleep(600);
    };
    await star('crew-4', 1);
    await sleep(1100);
    await star('crew-2', 2);
    await sleep(1100);
    await star('crew-6', 3);
    let g = ev(GROUP);
    check(g.names.join() === 'crew-6,crew-2,crew-4', 'the picker\'s Starred group is the newest star first: crew-6, crew-2, crew-4', JSON.stringify(g));
    check(order().map(labelOf).join() === 'crew-6,crew-2,crew-4', 'and so is the stars file that Conn reads', order().map(labelOf).join());
    axi('screenshot', path.join(shots, 'star-order-1.png'));
    // unstar crew-2, star it again: it comes back on top, not where it was
    pick('crew-2'); await sleep(1000);
    ev(`document.querySelector('.star-btn:not([hidden])').click(); return true;`);
    for (let i = 0; i < 60 && order().length !== 2; i++) await sleep(100);
    await sleep(1100);
    ev(`document.querySelector('.star-btn:not([hidden])').click(); return true;`);
    for (let i = 0; i < 60 && order().length !== 3; i++) await sleep(100);
    await sleep(800);
    g = ev(GROUP);
    check(g.names.join() === 'crew-2,crew-6,crew-4', 'starring crew-2 again puts it on top', JSON.stringify(g));
    check(order().map(labelOf).join() === 'crew-2,crew-6,crew-4', 'in the file too', order().map(labelOf).join());
    // another tab sees the order
    axi('open', 'about:blank'); axi('open', page); await sleep(1800);
    g = await until(GROUP, 'the Starred group after a reload');
    check(g.names.join() === 'crew-2,crew-6,crew-4' && /Starred · 3/.test(g.label), 'a reload shows the same order', JSON.stringify(g));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
