#!/usr/bin/env node
'use strict';

// A Watch column's lite page has no session picker, in a real (headless) browser (chrome-devtools-axi), against a lab copy of the reader on its own port with a fake
// Herdr (nothing is sent to any pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/watch-picker-check.js <scratch folder> [screenshots folder]
//
// Nathan, 2026-11-13: in Watch mode the column header already names the session, so the session picker (the name, with a star) in the reader page below it takes room for
// nothing. Conn now loads the lite page with ?conn=<n>&watch=1 (data/conn-fix-queue-2/watch-picker-note.md). The check opens the lite page the way a Watch column does, at the
// Watch widths (330, 360, 390, 440, 480 px), folded and unfolded, light and dark, and compares it with the same page without the flag: the picker is gone (not drawn, so it is
// not in the tab order either), the star is still there and works, the document picker stays, every other control stays, the header is no taller (shorter where it was three
// lines or unfolded), the address still goes to #s=<first 8> with the query kept; and ?watch=0, ?watch=2, the full page and the embed page ignore the flag.

const fs = require('fs');
const path = require('path');
process.env.LAB_DOCS = process.env.LAB_DOCS || '3';
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-watch-picker-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, finish, sleep } = make('reader-watch-picker-check');

// What the page shows: heights, what is visible, the star, the address. visible() is "drawn and tabbable": displayed, not hidden, not inert.
const VIS = `const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]');`;
const MEASURE_A = VIS + `const bar = document.getElementById('bar'); const star = [...document.querySelectorAll('#crumb-star, .pick-row .star-btn')].find(vis);
  return { ok: true, h: bar.offsetHeight, folded: bar.classList.contains('collapsed'), nopick: bar.classList.contains('nopick'), crumbSession: vis(document.getElementById('crumb-session')), crumb: vis(document.getElementById('crumb')),
    selSession: vis(document.querySelector('select[name=session]')), selDoc: vis(document.querySelector('select[name=doc]')), crumbDoc: vis(document.getElementById('crumb-doc')), star: !!star, starPressed: star ? star.getAttribute('aria-pressed') : null };`;
const MEASURE_B = VIS + `const names = ['jump-prev', 'jump-next', 'jump-ask', 'pins-quick', 'follow-quick', 'search-toggle', 'bar-toggle', 'view-doc', 'live'];
  return { ok: true, kept: Object.fromEntries(names.map((n) => [n, vis(document.getElementById(n))])), wide: document.documentElement.scrollWidth > innerWidth + 1, hash: location.hash, search: location.search };`;
const VISIBLE_CONTROLS = ['jump-prev', 'jump-next', 'jump-ask', 'pins-quick', 'follow-quick', 'search-toggle', 'bar-toggle', 'live'];

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, port, stop } = await startLab(folder);
  const base = `http://localhost:${port}/setup/transcript-reader/out/`;
  const A = lab.crew[0];
  // Opens one address at one width, folded or not (the page remembers the choice in tr-bar), light or dark, and waits for the conversation.
  const open = async (url, width, { folded, scheme = 'light', wait = 'crew-1' } = {}) => {
    axi('open', 'about:blank'); axi('emulate', '--viewport', `${width}x800x2`, '--color-scheme', scheme);
    axi('open', url); await sleep(700);
    ev(`localStorage.setItem('tr-follow', '0'); localStorage.setItem('tr-bar', '${folded ? 0 : 1}'); return true;`);
    axi('open', 'about:blank'); axi('open', url);
    await until(`return { ok: document.title.indexOf('${wait}') === 0 && document.querySelectorAll('#main > *').length > 0 };`, 'the page drawn');
    await sleep(900);
    return measure();
  };
  const measure = () => ({ ...ev(MEASURE_A), ...ev(MEASURE_B) });
  const shot = (name) => axi('screenshot', path.join(shots, name));
  const lite = (query) => `${base}live/index.html${query}#s=${A}`;

  try {
    const rows = [];
    for (const width of [330, 360, 390, 440, 480]) {
      for (const folded of [true, false]) {
        const at = `${width} px ${folded ? 'folded' : 'unfolded'}`;
        const without = await open(lite('?conn=3'), width, { folded });
        const flagged = await open(lite('?conn=3&watch=1'), width, { folded });
        rows.push({ width, folded, without: without.h, flagged: flagged.h });
        check(flagged.nopick === true && without.nopick === false, `${at}: the flag is read (the header carries the mark), and without it the page is as it was`, JSON.stringify({ flagged: flagged.nopick, without: without.nopick }));
        check(!flagged.crumbSession && !flagged.selSession && !flagged.crumb, `${at}: no session picker and no session name is drawn`, JSON.stringify({ crumbSession: flagged.crumbSession, selSession: flagged.selSession, crumb: flagged.crumb }));
        check(folded ? without.crumbSession : without.selSession, `${at}: and without the flag the picker is there (the comparison is a real one)`, JSON.stringify(without));
        check(flagged.star, `${at}: the star is still on the page`, '');
        check(VISIBLE_CONTROLS.every((n) => flagged.kept[n] === without.kept[n] || (!folded && n !== 'live')) || !folded, `${at}: every other control is still there`, JSON.stringify(flagged.kept));
        if (folded) check(VISIBLE_CONTROLS.every((n) => flagged.kept[n] === without.kept[n]), `${at}: the folded header keeps all of its buttons`, JSON.stringify({ with: flagged.kept, without: without.kept }));
        check(flagged.h <= without.h, `${at}: the header is no taller (${without.h} px before, ${flagged.h} px now)`, '');
        check(flagged.wide === false, `${at}: no sideways scroll`, '');
        check(/^#s=c4e70000$/.test(flagged.hash) && flagged.search === '?conn=3&watch=1', `${at}: the address goes to #s=<first 8> and the query is kept`, `${flagged.search}${flagged.hash}`);
        if (width === 330 || width === 480) {
          for (const scheme of ['light', 'dark']) {
            await open(lite('?conn=3&watch=1'), width, { folded, scheme }); shot(`watch-${width}-${folded ? 'folded' : 'open'}-${scheme}.png`);
            if (scheme === 'light') { await open(lite('?conn=3'), width, { folded }); shot(`before-${width}-${folded ? 'folded' : 'open'}-light.png`); }
          }
        }
      }
    }
    // the sizes, as a table for DESIGN.md
    process.stdout.write('\nheader heights (px): width, state, without the flag, with it\n' + rows.map((r) => `  ${r.width}  ${r.folded ? 'folded  ' : 'unfolded'}  ${r.without}  ${r.flagged}`).join('\n') + '\n\n');
    const r330 = rows.find((r) => r.width === 330 && r.folded), open480 = rows.find((r) => r.width === 480 && !r.folded);
    check(r330.flagged < r330.without, `330 px folded: shorter (${r330.without} px to ${r330.flagged} px: the quick buttons no longer need a third line)`, '');
    check(open480.flagged < open480.without, `480 px unfolded: shorter (${open480.without} px to ${open480.flagged} px: the picker's line is gone)`, '');

    // with a queue and the Tasks icon (both sit beside Search in a folded header with a picker): they go to the icons' line, and the header stays two lines
    for (const width of [330, 360]) {
      const plain = await open(lite('?conn=3'), width, { folded: true });
      ev(`document.querySelector('#main .queue-btn').click(); document.getElementById('view-tasks').hidden = false; return true;`); await sleep(500);
      const withIcons = measure();
      await open(lite('?conn=3&watch=1'), width, { folded: true });
      ev(`document.getElementById('view-tasks').hidden = false; return true;`); await sleep(300);
      const queued = ev(`const q = document.getElementById('queue-quick'); const r = q.getBoundingClientRect(); const live = document.getElementById('live').getBoundingClientRect(); return { ok: true, shown: !!q.getClientRects().length, badge: document.getElementById('queue-quick-n').textContent, queueTop: Math.round(r.top), liveTop: Math.round(live.top), h: document.getElementById('bar').offsetHeight, wide: document.documentElement.scrollWidth > innerWidth + 1 };`);
      check(queued.shown && queued.badge === '1' && queued.queueTop > queued.liveTop && queued.h === 79 && !queued.wide, `${width} px folded, a queued reply and the Tasks icon: the queue icon is on the icons' line and the header is 79 px (it was ${withIcons.h} px with the picker)`, JSON.stringify(queued));
      if (width === 330) shot('watch-330-folded-queue-light.png');
      ev(`localStorage.removeItem('tr-queue:${A}'); return true;`);
    }

    // the star: toggles from the folded header and from the unfolded controls, and comes back
    for (const folded of [true, false]) {
      await open(lite('?conn=3&watch=1'), folded ? 360 : 480, { folded });
      const before = measure().starPressed;
      ev(`const s = [...document.querySelectorAll('#crumb-star, .pick-row .star-btn')].find(el => el.getClientRects().length); s.click(); return true;`); await sleep(1200);
      const after = measure().starPressed;
      check(before !== after && after !== null, `${folded ? 'folded' : 'unfolded'}: the star toggles (${before} -> ${after})`, '');
      ev(`const s = [...document.querySelectorAll('#crumb-star, .pick-row .star-btn')].find(el => el.getClientRects().length); s.click(); return true;`); await sleep(1200);
      check(measure().starPressed === before, `${folded ? 'folded' : 'unfolded'}: and toggles back`, '');
    }

    // the document picker stays
    for (const [folded, width] of [[true, 360], [false, 480]]) {
      await open(lite('?conn=3&watch=1'), width, { folded });
      ev(`document.getElementById('view-doc').click(); document.getElementById('tab-doc').click(); return true;`); await sleep(1200);
      const doc = measure();
      check(folded ? doc.crumbDoc : doc.selDoc, `Documents view, ${folded ? 'folded' : 'unfolded'}: the document picker is there`, JSON.stringify({ crumbDoc: doc.crumbDoc, selDoc: doc.selDoc }));
      check(!doc.selSession && !doc.crumbSession, 'and still no session picker', '');
    }

    // other values and other pages
    for (const query of ['?conn=3&watch=0', '?conn=3&watch=2', '?conn=3&watch=', '?conn=3&watchx=1']) {
      const m = await open(lite(query), 360, { folded: true });
      const plain = await open(lite('?conn=3'), 360, { folded: true });
      check(m.nopick === false && m.crumbSession && m.h === plain.h, `${query}: the page is as without the flag`, JSON.stringify({ h: m.h, plain: plain.h }));
    }
    const full = await open(`${base}prototype.html?conn=3&watch=1#s=${A}`, 360, { folded: true });
    const fullPlain = await open(`${base}prototype.html?conn=3#s=${A}`, 360, { folded: true });
    check(full.nopick === false && full.crumbSession && full.h === fullPlain.h, 'the full page ignores the flag (picker there, same header)', JSON.stringify({ h: full.h, plain: fullPlain.h }));
    axi('open', 'about:blank'); axi('emulate', '--viewport', '360x800x2'); axi('open', `${base}live/embed.html?watch=1`); await sleep(1500);
    check(ev(`return { ok: true, flagged: document.getElementById('bar') ? document.getElementById('bar').classList.contains('nopick') : false, drew: document.body.children.length > 0 };`).flagged === false, 'the embed page ignores the flag', '');
  } catch (error) {
    check(false, 'the check ran to the end', String(error && error.stack || error).slice(0, 600));
  }
  finish(stop);
})();
