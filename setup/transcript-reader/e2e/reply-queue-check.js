#!/usr/bin/env node
'use strict';

// The reply queue, in a real (headless) browser (chrome-devtools-axi), against a lab copy of the reader on its own port with a fake Herdr (nothing is sent to
// any pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/reply-queue-check.js <scratch folder> [screenshots folder]
//
// Nathan, 2026-11-13: many replies arrive at once and he misses some. The lab's crew-1 is that conversation (LAB_BURST=14 in pane_lab.py: fourteen questions and
// replies twelve seconds apart, every sixth reply asking something). The check does what he would: skims from the newest reply upward and queues some with one
// tap each (no panel, no keyboard, the page where it was), goes through them oldest first from the header, opens each in place, takes each off with Done,
// and watches the queue survive a reload, a second web view (the Watch column coming back), a second conversation, a pin, a hide, replies arriving while the page is
// open and a reply that left the page. Then screenshots at a phone (390 px), a Watch column (330 and 480 px) and 1440 px, light and dark.
// For comparison the same conversation without a queue is in e2e notes (reply-queue-design.md): Pin, the one way to mark a reply today, opens a panel and a
// keyboard for its description on every tap.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.LAB_BURST = process.env.LAB_BURST || '14';
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-reply-queue-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, finish, sleep } = make('reader-reply-queue-check');

const PHONE = '390x844x2,mobile,touch';
const STATE = `const all = [...document.querySelectorAll('#main .reply[data-rq]')]; const q = all.filter(c => c.classList.contains('queued')); const num = c => (c.textContent.match(/\\(report (\\d+)\\)/) || [])[1];
  const t = document.getElementById('queue-toggle'), k = document.getElementById('queue-quick'), n = document.getElementById('queue-quick-n');
  return { ok: true, cards: all.length, queued: q.map(num).map(Number), chips: q.map(c => c.querySelector('.chip.queue').textContent), pills: q.map(c => c.querySelector('.queue-btn').textContent),
    toggle: t ? t.textContent : null, quick: !k.hidden, badge: n.hidden ? '' : n.textContent, quickLabel: k.getAttribute('aria-label'), top: Math.round(scrollY) };`;
const PANEL = `const rows = [...document.querySelectorAll('#queue-panel .pin-item')]; return { ok: true, open: !document.getElementById('queue-panel').hidden, note: (document.querySelector('#queue-panel .queue-note') || {}).textContent || '',
  rows: rows.map(r => r.textContent.replace(/^(\\d+) · Reply · .*?(Nathan|No longer|Loading)/, '$1 $2').slice(0, 56)), gone: rows.map(r => r.classList.contains('gone')), clear: !!document.querySelector('#queue-panel .queue-clear'),
  height: document.getElementById('bar').offsetHeight };`;
const TOAST = `const t = document.getElementById('undo-toast'); return { ok: true, shown: !!t && !t.hidden, text: t ? t.querySelector('span').textContent : '', buttons: t ? [...t.querySelectorAll('button')].map(b => b.textContent) : [] };`;
const NEXT_UP = `const bar = document.getElementById('bar').offsetHeight; const c = [...document.querySelectorAll('#main .reply.is-target')].sort((a, b) => Math.abs(a.getBoundingClientRect().top - bar) - Math.abs(b.getBoundingClientRect().top - bar))[0]; return { ok: true, key: c ? c.dataset.rq : null, num: c ? (c.textContent.match(/\\(report (\\d+)\\)/) || [])[1] : null, under: c ? Math.round(c.getBoundingClientRect().top - bar) : null };`;
const CARD = (n) => `const c = [...document.querySelectorAll('#main .reply[data-rq]')].find(c => c.textContent.includes('(report ${n})')); if (!c) return { ok: false }; return { ok: true, found: true, key: c.dataset.rq };`;
const CLICK_CARD = (n, cls) => `const c = [...document.querySelectorAll('#main .reply[data-rq]')].find(c => c.textContent.includes('(report ${n})')); if (!c) return false; c.querySelector('${cls}').click(); return true;`;
const LS = `const q = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^tr-(hosted-)?queue:/.test(k)) q[k.replace(/^.*queue:/, '').slice(0, 8)] = JSON.parse(localStorage.getItem(k)).items.length; } return q;`;
const NOSCROLL = `return { ok: true, wide: document.documentElement.scrollWidth > innerWidth + 1, sw: document.documentElement.scrollWidth, iw: innerWidth };`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, port, stop } = await startLab(folder);
  const base = `http://localhost:${port}/setup/transcript-reader/out/`;
  const [A, B] = [lab.crew[0], lab.crew[1]];
  const log = path.join(lab.home, '.claude', 'projects', '-lab-crew-1', `${A}.jsonl`);
  const open = async (url, viewport, scheme = 'light') => {
    axi('open', 'about:blank'); axi('emulate', '--viewport', viewport, '--color-scheme', scheme);
    axi('open', url); await sleep(900);
    ev(`localStorage.setItem('tr-follow', '0'); return true;`);
    axi('open', 'about:blank'); axi('open', url);
    await until(`return { ok: document.title.indexOf('crew-') === 0 && document.querySelectorAll('#main .reply').length > 0 };`, 'the conversation drawn');
    await sleep(700);
  };
  const go = (url, viewport, scheme) => open(url, viewport, scheme);
  const near = (a, b, d = 3) => Math.abs(a - b) <= d;
  const shot = (name) => axi('screenshot', path.join(shots, name));

  try {
    // ---- 1. the conversation, before anything is queued
    await go(`${base}prototype.html#s=${A}`, PHONE);
    ev(`localStorage.removeItem('tr-queue:${A}'); return true;`);
    await go(`${base}prototype.html#s=${A}`, PHONE);
    let s = ev(STATE);
    check(s.cards === 14, 'crew-1 has fourteen reply cards (the replies that arrived at once)', String(s.cards));
    check(ev(`return document.querySelectorAll('#main .queue-btn').length;`) === 14 && ev(`return [...document.querySelectorAll('#main .queue-btn')].every(b => b.textContent === 'Queue' && b.getAttribute('aria-label') === 'Add this reply to the queue');`), 'every reply has a Queue pill', '');
    check(s.queued.length === 0 && s.quick === false, 'nothing is queued, and the folded header has no queue icon yet (it is as it was)', JSON.stringify({ quick: s.quick }));
    check(ev(`return document.querySelectorAll('#main .input .queue-btn').length;`) === 0, 'a message of yours has no Queue pill (only replies queue)', '');

    // ---- 2. skim from the newest reply upward, queue four with one tap each; the page stays where it is
    ev(`window.scrollTo(0, document.documentElement.scrollHeight); return true;`); await sleep(400);
    const barHeightBefore = ev(`return document.getElementById('bar').offsetHeight;`);
    for (const n of [12, 9, 6, 3]) {
      ev(`const c = [...document.querySelectorAll('#main .reply[data-rq]')].find(c => c.textContent.includes('(report ${n})')); c.scrollIntoView({ block: 'center' }); return true;`); await sleep(250);
      const before = ev(`return { top: Math.round(scrollY), card: Math.round([...document.querySelectorAll('#main .reply[data-rq]')].find(c => c.textContent.includes('(report ${n})')).getBoundingClientRect().top) };`);
      ev(CLICK_CARD(n, '.queue-btn')); await sleep(250);
      const after = ev(`return { top: Math.round(scrollY), card: Math.round([...document.querySelectorAll('#main .reply[data-rq]')].find(c => c.textContent.includes('(report ${n})')).getBoundingClientRect().top), pins: !document.getElementById('pins-panel') || document.getElementById('pins-panel').hidden, qp: document.getElementById('queue-panel').hidden, focus: document.activeElement && document.activeElement.tagName };`);
      check(near(before.card, after.card, 4) && after.pins && after.qp && after.focus !== 'INPUT', `report ${n}: one tap queues it, the card stays where it was, no panel opens and no box takes the keyboard`, JSON.stringify({ before: before.card, after: after.card }));
    }
    s = ev(STATE);
    check(JSON.stringify(s.queued) === JSON.stringify([3, 6, 9, 12]), 'four are queued: 3, 6, 9, 12 (in reading order, though queued newest first)', JSON.stringify(s.queued));
    check(JSON.stringify(s.chips) === JSON.stringify(['Queued · 1 of 4', 'Queued · 2 of 4', 'Queued · 3 of 4', 'Queued · 4 of 4']), 'each queued card says its place, oldest first', JSON.stringify(s.chips));
    check(s.pills.every((p) => p === 'Done'), 'on a queued card the pill reads Done', JSON.stringify(s.pills));
    check(s.toggle === 'Queue · 4' && s.quick && s.badge === '4' && /Queue · 4/.test(s.quickLabel), 'the header counts them: Queue · 4 in the controls, an icon with 4 on it in the folded header', JSON.stringify({ toggle: s.toggle, badge: s.badge }));
    check(near(ev(`return document.getElementById('bar').offsetHeight;`), barHeightBefore, 2), 'the folded header is no taller with the queue icon in it (it sits beside Search)', `${barHeightBefore} -> ${ev('return document.getElementById("bar").offsetHeight;')}`);
    const stored = ev(`return { raw: localStorage.getItem('tr-queue:${A}') };`).raw;
    check(stored && !/Nathan|worker|report/.test(stored) && JSON.parse(stored).items.length === 4, 'the queue is kept in this browser under the conversation\'s id, with no message text in it', stored.slice(0, 120));
    check(ev(`return document.getElementById('pins-toggle') ? document.getElementById('pins-toggle').textContent : 'Pins';`) === 'Pins', 'the pins are untouched (Pins, no count)', '');

    // ---- 3. the panel: oldest first, a row goes to the reply in place and does not take it off
    ev(`document.getElementById('queue-quick').click(); return true;`); await sleep(500);
    let p = ev(PANEL);
    check(p.open && /^4 to go through, oldest first$/.test(p.note) && p.rows.length === 4 && p.rows.every((r, i) => r.startsWith(`${i + 1} Nathan`)) && p.clear, 'the Queue panel lists the four, numbered oldest first, with Clear all', JSON.stringify(p.rows));
    check(['report 3', 'report 6', 'report 9', 'report 12'].every((w, i) => ev(`return document.querySelectorAll('#queue-panel .pin-item')[${i}].textContent.includes('${w}');`)), 'in reading order: 3, 6, 9, 12', '');
    shot('phone-panel-light.png');
    ev(`document.querySelectorAll('#queue-panel .pin-item')[0].click(); return true;`); await sleep(900);
    let n = ev(NEXT_UP);
    check(n.num === '3' && n.under >= -2 && n.under <= 24, 'the first row goes to report 3 in place, right under the header, and flashes it', JSON.stringify(n));
    check(ev(PANEL).open === false && ev(STATE).queued.length === 4, 'the panel closes and opening a reply does not take it off the queue', '');

    // ---- 4. Done in place: the toast, Undo, Next
    ev(CLICK_CARD(3, '.queue-btn')); await sleep(400);
    s = ev(STATE); const t = ev(TOAST);
    check(JSON.stringify(s.queued) === JSON.stringify([6, 9, 12]) && s.toggle === 'Queue · 3' && s.badge === '3', 'Done takes report 3 off the queue: three left, counted in the header', JSON.stringify(s.queued));
    check(JSON.stringify(s.chips) === JSON.stringify(['Queued · 1 of 3', 'Queued · 2 of 3', 'Queued · 3 of 3']), 'the places of the others move up', JSON.stringify(s.chips));
    check(t.shown && t.text === 'Done · 3 left' && JSON.stringify(t.buttons) === JSON.stringify(['Next ↓', 'Undo']), 'a toast says Done · 3 left, with Next and Undo', JSON.stringify(t));
    shot('phone-toast-light.png');
    ev(`[...document.querySelectorAll('#undo-toast button')].find(b => b.textContent === 'Undo').click(); return true;`); await sleep(400);
    s = ev(STATE);
    check(JSON.stringify(s.queued) === JSON.stringify([3, 6, 9, 12]) && s.chips[0] === 'Queued · 1 of 4', 'Undo puts report 3 back in its place', JSON.stringify(s.queued));
    ev(CLICK_CARD(3, '.queue-btn')); await sleep(300);
    ev(`[...document.querySelectorAll('#undo-toast button')].find(b => b.textContent === 'Next ↓').click(); return true;`); await sleep(900);
    n = ev(NEXT_UP);
    check(n.num === '6' && n.under >= -2 && n.under <= 24 && JSON.stringify(ev(STATE).queued) === JSON.stringify([6, 9, 12]), 'Next goes to the oldest one left, report 6, in place, and takes nothing off', JSON.stringify(n));

    // ---- 5. a pin and a queue on one card, each on its own
    const pinned6 = () => ev(`return [...document.querySelectorAll('#main .reply[data-rq]')].find(c => c.textContent.includes('(report 6)')).querySelector('.pin').textContent;`);
    ev(CLICK_CARD(6, '.pin')); await sleep(600);
    check(pinned6() === 'Pinned' && ev(STATE).queued.includes(6), 'report 6 is pinned and still queued: the card wears both', JSON.stringify(ev(STATE).queued));
    ev(CLICK_CARD(6, '.queue-btn')); await sleep(400);
    check(pinned6() === 'Pinned' && !ev(STATE).queued.includes(6), 'Done on report 6 leaves it pinned', pinned6());
    ev(CLICK_CARD(6, '.queue-btn')); await sleep(300);
    check(ev(STATE).queued.includes(6) && pinned6() === 'Pinned', 'and it can be queued again', '');
    ev(`document.getElementById('queue-quick').click(); return true;`); await sleep(400);
    check(ev(`return { q: !document.getElementById('queue-panel').hidden, p: document.getElementById('pins-panel').hidden };`).p, 'opening the Queue panel closes the Pins panel (one panel at a time)', '');
    ev(`document.getElementById('pins-quick').click(); return true;`); await sleep(400);
    check(ev(`return document.getElementById('queue-panel').hidden && !document.getElementById('pins-panel').hidden;`), 'opening the Pins panel closes the Queue panel', '');
    ev(`document.querySelector('#pins-panel .pin-x').click(); return true;`); await sleep(500);
    check(ev(STATE).queued.includes(6) && pinned6() === 'Pin', 'unpinning report 6 leaves it queued', JSON.stringify(ev(STATE).queued));
    ev(`document.getElementById('pins-quick').click(); return true;`); await sleep(200);

    // ---- 6. it survives a reload, a second web view and another conversation
    await go(`${base}prototype.html#s=${A}`, PHONE);
    s = ev(STATE);
    check(JSON.stringify(s.queued) === JSON.stringify([6, 9, 12]) && s.toggle === 'Queue · 3', 'a reload finds the same queue', JSON.stringify(s.queued));
    axi('newpage', `${base}live/index.html#s=${A}`); axi('emulate', '--viewport', '380x800x1'); await until(`return { ok: document.querySelectorAll('#main .reply').length > 0 };`, 'the lite page'); await sleep(900);
    s = ev(STATE);
    check(JSON.stringify(s.queued) === JSON.stringify([6, 9, 12]) && s.chips[0] === 'Queued · 1 of 3', 'a new web view of the lite page (a Watch column coming back) has it too', JSON.stringify(s.queued));
    // the second view queues another; the first one follows
    ev(CLICK_CARD(14, '.queue-btn')); await sleep(300);
    const pageId = (re) => ((axi('pages').split('\n').find((l) => re.test(l)) || '').match(/^\s*(\d+),/) || [])[1];
    const [fullId, liteId] = [pageId(/prototype\.html/), pageId(/live\/index\.html/)];
    axi('selectpage', fullId); await sleep(1500);
    s = ev(STATE);
    check(JSON.stringify(s.queued) === JSON.stringify([6, 9, 12, 14]) && s.badge === '4', 'what the second view queued shows in the first one without a reload', JSON.stringify(s.queued));
    axi('closepage', liteId); axi('selectpage', fullId); await sleep(300);
    ev(`location.hash = '#s=${B}'; return true;`); await sleep(1500);
    await until(`return { ok: document.title.startsWith('crew-2') };`, 'crew-2');
    s = ev(STATE);
    check(s.queued.length === 0 && s.toggle === 'Queue' && !s.quick, 'another conversation (crew-2) has its own, empty queue', JSON.stringify({ toggle: s.toggle, quick: s.quick }));
    ev(`document.querySelector('#main .reply[data-rq] .queue-btn').click(); return true;`); await sleep(300);
    check(JSON.stringify(ev(LS)) === JSON.stringify({ [A.slice(0, 8)]: 4, [B.slice(0, 8)]: 1 }), 'one entry for each conversation in the storage', JSON.stringify(ev(LS)));
    ev(`location.hash = '#s=${A}'; return true;`); await sleep(1500);
    await until(`return { ok: document.title.startsWith('crew-1') };`, 'crew-1 again');
    check(ev(STATE).queued.length === 4, 'back in crew-1 its four are there, and crew-2\'s one is not among them', JSON.stringify(ev(STATE).queued));

    // ---- 7. a reply that is no longer on the page stays in the list, last, until it is Done
    ev(`const k = 'tr-queue:${A}'; const e = JSON.parse(localStorage.getItem(k)); e.items.push({ key: 'ffffffff-0000-4000-8000-00000000dead:reply', at: 1, queued: Date.now() }); localStorage.setItem(k, JSON.stringify(e)); window.dispatchEvent(new Event('focus')); return true;`); await sleep(600);
    ev(`document.getElementById('queue-quick').click(); return true;`); await sleep(500);
    p = ev(PANEL);
    check(p.rows.length === 5 && p.gone[4] === true && /^5 No longer/.test(p.rows[4]) && p.gone.slice(0, 4).every((g) => !g), 'a reply that left the page is the last row, says so, and cannot be gone to', JSON.stringify(p.rows));
    check(ev(STATE).toggle === 'Queue · 5', 'it is counted (nothing leaves the queue unseen)', '');
    shot('phone-gone-light.png');
    ev(`document.querySelectorAll('#queue-panel .queue-done')[4].click(); return true;`); await sleep(400);
    p = ev(PANEL);
    check(p.rows.length === 4 && ev(STATE).toggle === 'Queue · 4', 'Done on it takes it off', JSON.stringify(p.rows));
    ev(`document.getElementById('queue-quick').click(); return true;`); await sleep(300);

    // ---- 8. hide a queued reply: the list says so, and Next shows it where it is
    ev(CLICK_CARD(9, '.hide-msg')); await sleep(700);
    ev(`document.getElementById('queue-quick').click(); return true;`); await sleep(500);
    p = ev(PANEL);
    check(p.rows.length === 4 && p.rows.some((r) => /^2 /.test(r)) && ev(`return document.querySelectorAll('#queue-panel .pin-meta')[1].textContent.includes('hidden');`), 'a hidden reply is still in the queue, marked hidden', JSON.stringify(p.rows));
    ev(`document.querySelectorAll('#queue-panel .pin-item')[1].click(); return true;`); await sleep(1000);
    n = ev(NEXT_UP);
    check(n.num === '9' && ev(`return document.getElementById('hidden-toggle').getAttribute('aria-pressed') === 'true';`), 'going to it turns the Hidden view on and shows it in place', JSON.stringify(n));
    ev(CLICK_CARD(9, '.hide-msg')); await sleep(500);   // Show again
    ev(`document.getElementById('hidden-toggle').click(); return true;`); await sleep(300);

    // ---- 9. replies arrive while the page is open: the queue stays, the new ones can be queued
    const before = ev(STATE);
    execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(__dirname))}); import pane_lab; pane_lab.burst_more(${JSON.stringify(log)}, 14, 8)`]);
    s = await until(`const c = document.querySelectorAll('#main .reply[data-rq]').length; return { ok: c >= 22, cards: c };`, 'eight more replies on the page', 40000);
    const after = ev(STATE);
    check(after.cards === 22 && JSON.stringify(after.queued) === JSON.stringify(before.queued), 'eight more replies arrive while the page is open: the queue is as it was', JSON.stringify({ cards: after.cards, queued: after.queued }));
    ev(`const c = [...document.querySelectorAll('#main .reply[data-rq]')]; c[c.length - 2].querySelector('.queue-btn').click(); return true;`); await sleep(300);
    s = ev(STATE);
    check(s.queued.length === 5 && s.queued[4] === 21 && s.chips[4] === 'Queued · 5 of 5', 'a reply that arrived can be queued: it goes last (it is the newest)', JSON.stringify(s.queued));

    // ---- 10. the keyboard, and Clear all with its Undo
    ev(`window.scrollTo(0, document.documentElement.scrollHeight); return true;`); await sleep(300);
    ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true })); return true;`); await sleep(900);
    n = ev(NEXT_UP);
    check(n.num === '6' && n.under >= -2 && n.under <= 24, 'the q key goes to the oldest queued reply', JSON.stringify(n));
    ev(`document.getElementById('queue-quick').click(); return true;`); await sleep(400);
    ev(`document.querySelector('#queue-panel .queue-clear').click(); return true;`); await sleep(400);
    s = ev(STATE);
    check(s.queued.length === 0 && ev(TOAST).text === 'Cleared 5', 'Clear all takes every reply off, with a toast', JSON.stringify(ev(TOAST)));
    ev(`[...document.querySelectorAll('#undo-toast button')].find(b => b.textContent === 'Undo').click(); return true;`); await sleep(400);
    check(JSON.stringify(ev(STATE).queued) === JSON.stringify([6, 9, 12, 14, 21]), 'Undo brings all five back, in their places', JSON.stringify(ev(STATE).queued));
    ev(`document.getElementById('queue-quick').click(); return true;`); await sleep(200);

    // ---- 11. what it looks like: phone, Watch columns and a wide window, light and dark
    for (const scheme of ['light', 'dark']) {
      await go(`${base}prototype.html#s=${A}`, PHONE, scheme);
      ev(`const c = document.querySelector('#main .reply.queued'); window.scrollTo(0, window.scrollY + c.getBoundingClientRect().top - document.getElementById('bar').offsetHeight - 70); return true;`); await sleep(500);
      shot(`phone-queued-${scheme}.png`);
      ev(`document.getElementById('queue-quick').click(); return true;`); await sleep(500);
      shot(`phone-panel-${scheme}.png`);
      check(ev(NOSCROLL).wide === false, `390 px ${scheme}: no sideways scroll with the panel open`, JSON.stringify(ev(NOSCROLL)));
      for (const [width, name] of [[330, 'watch330'], [480, 'watch480']]) {
        await go(`${base}live/index.html#s=${A}`, `${width}x800x2`, scheme);
        ev(`const c = document.querySelector('#main .reply.queued'); window.scrollTo(0, window.scrollY + c.getBoundingClientRect().top - document.getElementById('bar').offsetHeight - 30); return true;`); await sleep(500);
        shot(`${name}-queued-${scheme}.png`);
        check(ev(NOSCROLL).wide === false, `${width} px ${scheme}: the lite page has no sideways scroll with queued replies`, JSON.stringify(ev(NOSCROLL)));
        ev(`(document.getElementById('queue-quick').hidden ? document.getElementById('queue-toggle') : document.getElementById('queue-quick')).click(); return true;`); await sleep(500);
        shot(`${name}-panel-${scheme}.png`);
        check(ev(NOSCROLL).wide === false && ev(PANEL).open, `${width} px ${scheme}: the panel opens and fits`, JSON.stringify(ev(NOSCROLL)));
      }
      await go(`${base}prototype.html#s=${A}`, '1440x900x1', scheme);
      ev(`const c = document.querySelector('#main .reply.queued'); window.scrollTo(0, window.scrollY + c.getBoundingClientRect().top - document.getElementById('bar').offsetHeight - 60); return true;`); await sleep(500);
      shot(`wide-queued-${scheme}.png`);
      ev(`document.getElementById('queue-toggle').click(); return true;`); await sleep(500);
      shot(`wide-panel-${scheme}.png`);
      check(ev(PANEL).open && ev(`return { v: document.getElementById('queue-toggle').getAttribute('aria-pressed') };`).v === 'true', `1440 px ${scheme}: the Queue control in the open controls opens the panel`, '');
    }
  } catch (error) {
    check(false, 'the check ran to the end', String(error && error.stack || error).slice(0, 600));
  }
  finish(stop);
})();
