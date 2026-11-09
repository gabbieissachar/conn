#!/usr/bin/env node
'use strict';

// The task menu of a leader's conversation, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own port with a fake Herdr and a leader
// conversation of 31 turns that name six made-up tasks (pane_lab.py, LAB_LEADER=1). By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/task-tags-check.js <scratch folder> [screenshots folder]
//
// It checks the reader page (out/prototype.html) and the lite page a Conn Watch column shows (out/live/index.html), the page's two ways of drawing a conversation:
//   * the turns' chips, the menu (a rail beside the column from 820 px, a bottom sheet below it), a switch, Only and Show all, the banner that says what is hidden,
//     the fold row that opens in place, a search match inside it, A4 (a turn that touches two tasks shows while either is on) and what the browser remembers for each
//     conversation, with the counts taken from the conversation's own data and the rules (prototype/tasktags.js) run in this process;
//   * the width switch at 819 and 820 px, the rail's width at 1029 and 1030 px, and the Watch widths 330, 360, 390, 440 and 480 px, light and dark, with the menu
//     measured against the page's existing controls (the same 44 px on a touch screen, the same pill and button height).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { make, freePort } = require('./axi');
const { spawn, execFileSync } = require('child_process');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-task-tags-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, check, startLab, openPage, pick, finish, sleep, until } = make('reader-task-tags-check');
const taskTags = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'prototype', 'tasktags.js'), 'utf8') + '\ntaskTags', { String, Map, Set, Math, Array, Object, JSON });
const CREW1 = 'c4e70000-0001-4000-8000-000000000001';

// Short expressions (chrome-devtools-axi drops an argument of about 1000 characters or more): a few helpers the page keeps on window, put there again after each load.
const HELPERS = [
  `window.T = { q: s => document.querySelector(s), qa: s => [...document.querySelectorAll(s)], box: n => { const r = n && n.getBoundingClientRect(); return r ? { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } : null; } }; return true;`,
  `T.state = () => { const m = T.q('#taskmenu'), k = T.q('#task-banner'); return { vw: innerWidth, scrollW: document.documentElement.scrollWidth, shown: !m.hidden, menu: m.hidden ? null : T.box(m), role: m.getAttribute('role'), rail: getComputedStyle(document.documentElement).getPropertyValue('--rail').trim(), scrim: !T.q('#task-scrim').hidden, banner: k.hidden ? '' : T.q('#task-banner-text').textContent, bannerBox: k.hidden ? null : T.box(k), bar: T.box(T.q('#bar')), main: T.box(T.q('#main')), dock: T.box(T.q('#dock')), pos: getComputedStyle(m).position }; }; return true;`,
  `T.runs = () => T.qa('#main > .taskrun').map(r => ({ open: r.classList.contains('open'), label: (r.querySelector('.taskfold .l') || {}).textContent || '', count: Number(r.dataset.count) })); T.shownTurns = () => T.qa('#main > [id^=ex-]').length; return true;`,
  `T.rows = () => T.qa('#taskmenu .trow').map(r => ({ key: r.dataset.key, on: r.querySelector('input').checked, n: r.querySelector('.tn').textContent })); T.chips = () => T.qa('.task-chip').map(c => c.textContent); return true;`,
  `T.click = sel => { const n = T.q(sel); if (!n) return false; n.click(); return true; }; T.row = key => T.qa('#taskmenu .trow').find(r => r.dataset.key === key); return true;`,
];
const helpers = () => HELPERS.forEach((expression) => ev(expression));

const exchanges = () => JSON.parse(fs.readFileSync(path.join(outDir, 'live', 's', `${CREW1}.json`), 'utf8'));
let outDir;
const total = () => expected([]).sum.tasks.length;
const showing = (hidden = '\\d+ turns? hidden') => new RegExp(`^Showing ${total() - 1} of ${total()} tasks · (${hidden})$`);
const conversation = () => { const s = exchanges(); return { exchanges: s.exchanges, tasks: s.leader.tasks }; };
// What the rules say with the given switches off: how many turns hide, and the runs of them in order (the page draws each run as one row).
function expected(off) {
  const { exchanges: ex, tasks } = conversation();
  const sum = taskTags.summary(ex, tasks), set = new Set(off);
  const counts = taskTags.counts(ex, sum, set, 0);
  const runs = []; let current = 0;
  for (const e of ex) {
    if (!taskTags.visible(e, set) && e.source !== 'session') current += 1;
    else if (current) { runs.push(current); current = 0; }
  }
  if (current) runs.push(current);
  return { sum, counts, runs, banner: taskTags.banner(counts) };
}

// The page keeps what you expanded in this tab's session storage and writes it again as it is left, so the storage is emptied from a page that does not (a 404 of the
// same origin) before the next one opens.
function wipe(page) {
  axi('open', 'about:blank'); axi('open', page.replace(/\/setup\/.*$/, '/no-such-page'));
  ev(`localStorage.removeItem('tr-tasks'); localStorage.removeItem('tr-task-rail'); sessionStorage.clear(); return true;`);
}
async function openReader(page, viewport, scheme) {
  wipe(page);
  await openPage(page, viewport);
  if (scheme) { axi('emulate', '--viewport', viewport, '--color-scheme', scheme); await sleep(400); }
  pick('crew-1'); await sleep(1200);
  helpers();
}
async function openLite(port, viewport, scheme) {
  const url = `http://localhost:${port}/setup/transcript-reader/out/live/index.html#s=${CREW1}`;
  wipe(url);
  axi('emulate', '--viewport', viewport, ...(scheme ? ['--color-scheme', scheme] : []));
  axi('open', url);
  await until(`return { ok: document.getElementById('main').children.length > 5 };`, 'the lite page');
  await sleep(900);
  helpers();
}
// The browser's console for the page on screen: nothing at error level.
// The browser's console for the page on screen: nothing at error level. A plain file server (the phone's copy, unsealed) has no k/params.json and no favicon: those two 404s are not the page's.
const consoleClean = (what, plainFiles = false) => {
  const said = axi('console', '--type', 'error');
  const errors = said.split('\n').filter((l) => /\[error\]/.test(l) && !(plainFiles && /status of 404/.test(l)));
  check(errors.length === 0 && (plainFiles || /<no console messages found>/.test(said)), `${what} logged no errors`, errors.slice(0, 4).join(' | '));
};
const quick = () => ev(`const q = T.q('#tasks-quick'), t = T.q('#tasks-toggle'); const n = t && t.offsetParent !== null ? t : q; n.click(); return true;`);

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  process.env.LAB_LEADER = '1';
  const { port, page, stop, outDir: out, lab } = await startLab(folder);
  outDir = out;
  try {
    // ---- 1. the reader page at 1440 px: the rail, the chips, the numbers
    await openReader(page, '1440x900x1', 'light');
    let s = ev(`return T.state();`);
    const all = expected([]);
    check(s.shown && s.role === 'complementary' && s.rail === '20rem' && s.menu.w === 320 && s.menu.x === s.vw - 320, 'at 1440 px the menu is a 320 px rail at the right edge, open by itself (thirteen tasks)', JSON.stringify({ menu: s.menu, rail: s.rail }));
    check(s.main.r <= s.vw - 320 && s.dock.r <= s.vw - 320 && s.bar.r <= s.vw - 320 && s.scrollW <= s.vw, 'the column, the header and the message bar stand left of the rail, and nothing scrolls sideways', JSON.stringify({ main: s.main.r, dock: s.dock.r, bar: s.bar.r, scrollW: s.scrollW }));
    check(s.scrim === false && s.banner === '', 'a rail has no scrim, and with every task on there is no banner');
    let rows = ev(`return T.rows();`);
    const taskRows = all.sum.tasks.map((t) => [t.id, String(t.turns)]), shown = rows.filter((r) => !r.key.startsWith('·')).map((r) => [r.key, r.n]);
    check(JSON.stringify(shown.sort()) === JSON.stringify(taskRows.sort()) && rows.every((r) => r.on), 'the menu lists each task with its turn count from the conversation, all on', JSON.stringify({ shown, taskRows }));
    check(rows.filter((r) => r.key.startsWith('·')).map((r) => `${r.key}:${r.n}`).join() === all.sum.rows.map((r) => `${r.key}:${r.turns}`).join(), 'Fleet upkeep and No task are rows of their own, with their counts');
    const groups = ev(`return T.qa('#taskmenu .tgroup').map(g => g.firstChild.textContent);`);
    check(JSON.stringify(groups) === JSON.stringify(['BC-39', 'AB-12', 'Other tasks']), 'the tasks that share a product key in their ids are grouped (a key one task has makes no group)', JSON.stringify(groups));
    const chips = ev(`return T.chips();`);
    check(chips.length >= 8 && chips.some((c) => /\+1$/.test(c)), 'turns carry chips, and a turn that touches two tasks says "first task +1"', JSON.stringify(chips));
    axi('screenshot', path.join(shots, 'rail-1440-light.png'));

    // ---- 2. a switch: the fold row, the banner, A4, Show all, Only
    ev(`T.row('bc-39-specs-task').querySelector('input').click(); return true;`); await sleep(500);
    let e = expected(['bc-39-specs-task']);
    s = ev(`return T.state();`);
    let runs = ev(`return T.runs();`);
    check(s.banner === e.banner && showing().test(s.banner), 'switching a task off puts the banner in the header: what is hidden, and how much', s.banner);
    check(JSON.stringify(runs.map((r) => r.count)) === JSON.stringify(e.runs) && runs.every((r) => !r.open && r.label === taskTags.foldLabel(r.count)), 'its turns fold into one row for each run ("N turns in other tasks"), shut', JSON.stringify({ runs, expected: e.runs }));
    const both = conversation().exchanges.findIndex((x) => (x.tags || []).length === 2 && x.tags.some(([id]) => id === 'bc-39-specs-task'));
    check(both >= 0 && ev(`return !!document.getElementById('ex-${both}') && !document.getElementById('ex-${both}').closest('.taskrun');`), 'a turn that touches two tasks stays on screen while either is on (A4)', `turn ${both}`);
    ev(`T.q('#main > .taskrun .taskfold').click(); return true;`); await sleep(300);
    runs = ev(`return T.runs();`);
    check(runs[0].open && ev(`return T.qa('#main > .taskrun')[0].querySelectorAll('[id^=ex-]').length;`) === runs[0].count && ev(`return !T.q('#main > .taskrun .taskfold');`), 'a fold row opens in place and shows its turns (the row goes)', JSON.stringify(runs[0]));
    axi('screenshot', path.join(shots, 'banner-1440-light.png'));
    ev(`T.click('#task-banner-all'); return true;`); await sleep(500);
    s = ev(`return T.state();`);
    check(s.banner === '' && ev(`return T.runs().length;`) === 0 && ev(`return T.rows().every(r => r.on);`), 'Show all in the banner brings every task back and the banner goes', s.banner);
    ev(`T.row('lv-50-finish-flow').querySelector('.btn').click(); return true;`); await sleep(500);
    e = expected([...taskTags.only(all.sum, 'lv-50-finish-flow')]);
    s = ev(`return T.state();`);
    check(s.banner === e.banner && /Fleet upkeep off · No task off$/.test(s.banner) && ev(`return T.row('lv-50-finish-flow').querySelector('.btn').getAttribute('aria-pressed') === 'true';`) === true, 'Only keeps one task on, says so in the banner (with both rows off) and its button shows it is pressed', s.banner);
    ev(`T.row('lv-50-finish-flow').querySelector('.btn').click(); return true;`); await sleep(500);
    check(ev(`return T.state().banner;`) === '', 'pressing Only again switches everything back on');

    // ---- 2b. the find box, which a conversation with more than ten tasks has
    check(ev(`return !!T.q('#taskmenu .tm-find input');`), 'past ten tasks the menu has a find box');
    const finds = () => ev(`return { rows: T.qa('#taskmenu .trow:not(.rows)').filter(r => !r.hidden).map(r => r.dataset.key), groups: T.qa('#taskmenu .tgroup').filter(g => !g.hidden).map(g => g.firstChild.textContent), none: !T.q('#taskmenu .tm-none').hidden, fixed: T.qa('#taskmenu .trow.rows').filter(r => !r.hidden).length, value: T.q('#taskmenu .tm-find input').value };`);
    const typeFind = (text) => ev(`const i = T.q('#taskmenu .tm-find input'); i.value = '${text}'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    typeFind('ALPHA copy'); await sleep(300);
    let found = finds();
    check(JSON.stringify(found.rows) === '["ab-12-alpha-copy"]' && JSON.stringify(found.groups) === '["AB-12"]' && found.fixed === 2 && !found.none, 'typing words (any case, any order) keeps the tasks that hold them, their group heading, and the two rows below', JSON.stringify(found));
    typeFind('zzzz'); await sleep(300);
    found = finds();
    check(found.rows.length === 0 && found.groups.length === 0 && found.none && found.fixed === 2, 'a find that matches nothing says so, and Fleet upkeep and No task stay', JSON.stringify(found));
    ev(`T.q('#taskmenu .tm-find input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`); await sleep(300);
    found = finds();
    check(found.value === '' && found.rows.length === total() && ev(`return T.state().shown;`), 'Esc in the find box clears it (the menu stays open)', JSON.stringify({ value: found.value, rows: found.rows.length }));
    typeFind('misc'); await sleep(200);
    ev(`T.row('misc-cleanup-two').querySelector('input').click(); return true;`); await sleep(500);
    found = finds();
    check(found.value === 'misc' && found.rows.length === 3 && ev(`return T.state().banner;`) !== '', 'a switch made inside a find keeps the find (the menu is drawn again with the same words)', JSON.stringify(found));
    typeFind(''); ev(`T.click('#task-banner-all'); return true;`); await sleep(300);

    // ---- 3. what is remembered: per conversation, in this browser
    ev(`T.row('reader-task-tags-build').querySelector('input').click(); T.row('${taskTags.NONE}').querySelector('input').click(); return true;`); await sleep(500);
    const kept = ev(`return JSON.parse(localStorage.getItem('tr-tasks') || '{}');`);
    check(Object.keys(kept).length === 1 && JSON.stringify(Object.values(kept)[0].h.sort()) === JSON.stringify([taskTags.NONE, 'reader-task-tags-build'].sort()), 'the switches are kept in this browser, for this conversation only', JSON.stringify(kept));
    const before = ev(`return T.state().banner;`);
    axi('open', 'about:blank'); axi('open', page); await until(`return { ok: document.getElementById('main').children.length > 0 };`, 'the page'); pick('crew-1'); await sleep(1200); helpers();
    check(ev(`return T.state().banner;`) === before && before !== '', 'a reload brings the same switches back', before);
    pick('crew-2'); await sleep(900);
    check(ev(`return T.state().shown;`) === false && ev(`return T.q('#task-banner').hidden && T.q('#tasks-quick').hidden && !T.q('#tasks-toggle');`), 'a conversation with no tags has no menu, no banner and no button', 'crew-2');
    pick('crew-1'); await sleep(900);
    check(ev(`return T.state().banner;`) === before, 'going back to the conversation brings its switches back', before);
    ev(`T.click('#task-banner-all'); return true;`); await sleep(400);
    check(ev(`return { v: localStorage.getItem('tr-tasks') };`).v === '{}', 'Show all forgets the conversation (nothing is kept for it)');

    // ---- 4. a chip opens the menu on its task; a search match inside a fold opens it
    ev(`T.row('bc-39-specs-task').querySelector('input').click(); return true;`); await sleep(500);
    ev(`T.click('#taskmenu .tm-head button'); return true;`); await sleep(300);
    check(ev(`return T.state().shown;`) === false && ev(`return T.state().rail;`) === '0px' && ev(`return { v: localStorage.getItem('tr-task-rail') };`).v === '0', 'the rail closes with its ✕, the column takes its room back, and the choice is kept');
    ev(`const c = T.qa('.task-chip')[0]; c.click(); return true;`); await sleep(500);
    check(ev(`return T.state().shown;`) === true && ev(`return T.qa('#taskmenu .trow.is-here').length;`) === 1, 'a chip opens the menu and marks the row of its task');
    ev(`document.querySelector('#search-toggle').click(); return true;`); await sleep(300);
    ev(`const i = T.q('#search-input'); i.value = 'second draft'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`); await sleep(700);
    ev(`T.click('#search-next'); return true;`); await sleep(700);
    check(ev(`return T.runs().some(r => r.open);`), 'a search match inside folded turns opens that fold in place', JSON.stringify(ev(`return T.runs();`)));
    ev(`T.click('#search-close'); return true;`); await sleep(300);
    axi('screenshot', path.join(shots, 'fold-open-1440-light.png'));
    ev(`T.click('#task-banner-all'); return true;`); await sleep(300);

    // ---- 4b. new turns in a task that is switched off are counted in the banner (the page's own refresh brings them)
    await openReader(page, '1440x900x1', 'light');
    ev(`T.row('reader-task-tags-build').querySelector('input').click(); return true;`); await sleep(500);
    const log = path.join(lab.home, '.claude', 'projects', '-lab-crew-1', `${CREW1}.jsonl`);
    const stamp = (extra) => new Date(Date.now() + extra).toISOString();
    fs.appendFileSync(log, JSON.stringify({ type: 'user', uuid: 'u-new-1', timestamp: stamp(0), cwd: path.join(lab.home, 'fm-leader'), message: { role: 'user', content: 'One more on the tags' } }) + '\n'
      + JSON.stringify({ type: 'assistant', timestamp: stamp(3000), cwd: path.join(lab.home, 'fm-leader'), message: { role: 'assistant', content: [{ type: 'text', text: 'Nathan, reader-task-tags-build has a new slice on its branch; it waits for your review whenever you are ready.' }] } }) + '\n');
    await until(`return { ok: /1 new$/.test(T.state().banner) };`, 'the banner to count the new turn', 30000);
    check(/1 new$/.test(ev(`return T.state().banner;`)), 'a new turn in a task that is switched off is counted in the banner ("1 new") and does not open the fold', ev(`return T.state().banner;`));
    consoleClean('the reader page');
    ev(`T.click('#task-banner-all'); return true;`); await sleep(300);

    // ---- 4c. a link to a message (and so a pin, which opens the same way) inside folded turns lands on it: the fold opens in place
    const hiddenTurn = conversation().exchanges.findIndex((x) => (x.tags || []).length === 1 && x.tags[0][0] === 'bc-39-specs-task' && x.source !== 'wake');
    ev(`T.row('bc-39-specs-task').querySelector('input').click(); return true;`); await sleep(500);
    const uid = conversation().exchanges[hiddenTurn].uid;
    ev(`location.hash = '#s=${CREW1}&m=${uid}'; return true;`); await sleep(1500);
    check(hiddenTurn >= 0 && ev(`return !!document.getElementById('ex-${hiddenTurn}') && T.runs().some(r => r.open);`), 'a message link into a switched-off task opens its fold in place and lands on the turn', `turn ${hiddenTurn}`);
    ev(`T.click('#task-banner-all'); return true;`); await sleep(300);

    // ---- 5. dark, and the pixel check against the page's own controls
    axi('emulate', '--viewport', '1440x900x1', '--color-scheme', 'dark'); await sleep(500);
    ev(`T.row('bc-39-specs-task').querySelector('input').click(); return true;`); await sleep(500);
    axi('screenshot', path.join(shots, 'rail-1440-dark.png'));
    const pix = ev(`const b = T.q('#tasks-toggle'), w = [...document.querySelectorAll('#controls .btn')].find(x => x.textContent === 'Wake-ups'); const cs = n => { const c = getComputedStyle(n); return { h: Math.round(n.getBoundingClientRect().height), fs: c.fontSize, br: c.borderRadius, bd: c.borderTopWidth, pad: c.paddingLeft }; }; return { by: b && cs(b), wake: w && cs(w) };`);
    check(pix.by && pix.wake && JSON.stringify(pix.by) === JSON.stringify(pix.wake), 'the By task button is the same height, font, radius and padding as its neighbour in the controls (Wake-ups)', JSON.stringify(pix));
    const chip = ev(`const c = T.q('.task-chip'), p = T.q('.pin'); const cs = n => { const x = getComputedStyle(n); return { fs: x.fontSize, h: Math.round(n.getBoundingClientRect().height) }; }; return { chip: cs(c), pin: p && cs(p) };`);
    check(chip.chip.fs === '11px' && chip.chip.h >= 18 && chip.chip.h <= 22, 'a chip is 11 px type and 18 to 22 px tall, a line of the turn\'s header', JSON.stringify(chip));
    ev(`T.click('#task-banner-all'); return true;`); await sleep(300);
    axi('emulate', '--viewport', '1440x900x1', '--color-scheme', 'light'); await sleep(400);

    // ---- 6. the width switch: a bottom sheet at 819 px, a rail from 820 px; 17rem until 1029 px and 20rem from 1030 px; and the Watch widths
    for (const [width, kind, rem] of [[819, 'sheet', '0px'], [820, 'rail', '17rem'], [1029, 'rail', '17rem'], [1030, 'rail', '20rem']]) {
      await openReader(page, `${width}x900x1`, 'light');
      if (kind === 'sheet') { check(ev(`return T.state().shown;`) === false, `${width} px: the menu waits shut (a sheet opens on a tap)`); quick(); await sleep(400); }
      else if (!ev(`return T.state().shown;`)) { quick(); await sleep(400); }
      s = ev(`return T.state();`);
      const widthPx = Math.round(parseFloat(rem) * 16);
      if (kind === 'sheet') check(s.role === 'dialog' && s.scrim && s.pos === 'fixed' && s.menu.b === 900 && s.menu.w === 819 && s.rail === '0px', `${width} px: a bottom sheet, the width of the window, over a scrim`, JSON.stringify({ menu: s.menu, scrim: s.scrim, rail: s.rail }));
      else check(s.role === 'complementary' && !s.scrim && s.menu.w === widthPx && s.menu.x === s.vw - widthPx && s.rail === rem && s.main.r <= s.vw - widthPx, `${width} px: a rail ${widthPx} px wide beside the column, which gives way to it`, JSON.stringify({ menu: s.menu, rail: s.rail, main: s.main.r }));
      check(s.scrollW <= s.vw, `${width} px: nothing scrolls sideways`, `${s.scrollW}`);
      axi('screenshot', path.join(shots, `width-${width}.png`));
    }

    // ---- 7. a Watch column: the lite page at the widths Conn's columns have (330 to 480 px), light and dark
    const FITS = `const vw = innerWidth; const out = []; T.qa('#taskmenu .trow').forEach(r => { const b = T.box(r), o = T.box(r.querySelector('.btn')); if (b.r > vw || o.r > vw || r.scrollWidth > r.clientWidth + 1) out.push(r.dataset.key); }); return out;`;
    const HEADER = `const vw = innerWidth; return T.qa('#bar .title > *').filter(n => n.offsetParent !== null && !n.hidden).map(n => T.box(n)).filter(b => b.w > 0 && (b.r > vw + 1 || b.x < -1)).length;`;
    for (const scheme of ['light', 'dark']) {
      for (const width of [330, 360, 390, 440, 480]) {
        const what = `Watch column ${width} px, ${scheme}`;
        await openLite(port, `${width}x800x1`, scheme);
        s = ev(`return T.state();`);
        check(s.shown === false && s.rail === '0px', `${what}: the menu waits shut and takes no room`, JSON.stringify({ shown: s.shown, rail: s.rail }));
        check(ev(HEADER) === 0, `${what}: the header's controls (with the new icon) all fit the width`);
        if (width <= 440) {  // the header starts folded at a phone's width (440 px and under): the icons stand in for the controls row's buttons
          const icons = ev(`const a = T.box(T.q('#tasks-quick')), b = T.box(T.q('#view-doc')); return { by: [a.w, a.h], doc: [b.w, b.h] };`);
          check(icons.by.join() === icons.doc.join() && icons.by[0] >= 28, `${what}: the By task icon is the size of the Documents icon beside it`, JSON.stringify(icons));
        }
        quick(); await sleep(500);
        s = ev(`return T.state();`);
        check(s.shown && s.role === 'dialog' && s.pos === 'fixed' && s.menu.x === 0 && s.menu.w === width && s.menu.b === 800 && s.scrim && s.scrollW <= width, `${what}: a bottom sheet, the width of the column, over a scrim`, JSON.stringify({ menu: s.menu, scrim: s.scrim, scrollW: s.scrollW }));
        check(ev(FITS).length === 0, `${what}: every task row and its Only button fit inside the sheet`, JSON.stringify(ev(FITS)));
        check(ev(`return document.activeElement === T.q('#taskmenu .tm-head button');`), `${what}: the focus is in the sheet, on its close button`);
        if (width === 330 || width === 480) axi('screenshot', path.join(shots, `watch-${width}-${scheme}-sheet.png`));
        ev(`T.row('bc-39-specs-task').querySelector('input').click(); return true;`); await sleep(500);
        s = ev(`return T.state();`);
        check(s.shown && showing('1 turn hidden').test(s.banner) && s.scrim, `${what}: a switch folds the turns, the sheet stays open and the banner is behind it`, s.banner);
        ev(`document.getElementById('taskmenu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`); await sleep(500);
        s = ev(`return T.state();`);
        check(!s.shown && !s.scrim && ev(`return T.q('#task-banner').offsetParent !== null && T.box(T.q('#task-banner')).r <= innerWidth;`), `${what}: Esc closes the sheet; the banner stays in the header, inside the column`, JSON.stringify(s.bannerBox));
        check(ev(`return document.activeElement === (T.q('#tasks-toggle') && T.q('#tasks-toggle').offsetParent ? T.q('#tasks-toggle') : T.q('#tasks-quick'));`), `${what}: the focus goes back to the control that opened it`);
        if (width === 330 || width === 480) axi('screenshot', path.join(shots, `watch-${width}-${scheme}-banner.png`));
        ev(`T.q('#main > .taskrun .taskfold').click(); return true;`); await sleep(300);
        check(ev(`return document.documentElement.scrollWidth <= innerWidth;`), `${what}: an opened fold does not widen the page`);
        ev(`T.click('#task-banner-all'); return true;`); await sleep(300);
      }
    }

    consoleClean('the lite page');

    // ---- 7b. the phone's copy: the hosted shell built from the same lab (sync.py --build-only), served as plain files; the page is the same code in its hosted mode
    const hostedDir = path.join(folder, 'hosted');
    execFileSync('python3', ['-I', path.join(lab.repo, 'setup', 'transcript-reader', 'sync.py'), '--build-only', '--session', CREW1, '--out', hostedDir, '--main-home', path.join(lab.home, 'fm-leader')],
      { env: { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH }, encoding: 'utf8', timeout: 120000 });
    const hostedPort = await freePort();
    const files = spawn('python3', ['-m', 'http.server', String(hostedPort), '--bind', '127.0.0.1', '--directory', hostedDir], { stdio: 'ignore' });
    try {
      await sleep(800);
      for (const [viewport, label] of [['1440x900x1', '1440 px'], ['390x844x2,mobile,touch', 'a phone']]) {
        const url = `http://localhost:${hostedPort}/index.html#s=${CREW1}`;
        axi('open', 'about:blank'); axi('emulate', '--viewport', viewport, '--color-scheme', 'light'); axi('open', url);
        ev(`localStorage.removeItem('tr-hosted-tasks'); localStorage.removeItem('tr-task-rail'); sessionStorage.clear(); return true;`);
        axi('open', 'about:blank'); axi('open', url);
        await until(`return { ok: document.getElementById('main').children.length > 5 };`, 'the hosted copy', 30000); await sleep(900);
        helpers();
        if (label === 'a phone') { quick(); await sleep(500); }
        const copy = ev(`return { chips: T.chips().length, tasks: T.rows().length };`);
        check(copy.chips >= 8 && copy.tasks === total() + expected([]).sum.rows.length, `the phone's copy (${label}): the turns carry their chips and the menu lists the tasks`, JSON.stringify(copy));
        ev(`T.row('lv-50-finish-flow').querySelector('input').click(); return true;`); await sleep(500);
        const banner = ev(`return T.state().banner;`);
        check(showing('\\d+ turns? hidden|no turns hidden').test(banner), `the phone's copy (${label}): a switch folds the turns and the banner says so`, banner);
        check(ev(`return { v: localStorage.getItem('tr-hosted-tasks') };`).v !== null, `the phone's copy (${label}): the switches are kept under the copy's own key`);
        axi('screenshot', path.join(shots, `hosted-${label === 'a phone' ? '390' : '1440'}.png`));
      }
      consoleClean('the phone\'s copy', true);
    } finally { files.kill(); }

    // ---- 8. a touch screen: every control of the menu and the banner is 44 px
    await openLite(port, '390x844x2,mobile,touch', 'light');
    quick(); await sleep(500);
    const tall = ev(`const small = T.qa('#taskmenu button, #taskmenu input, #taskmenu .trow').filter(n => n.getBoundingClientRect().height < (n.tagName === 'INPUT' ? 22 : n.classList.contains('trow') ? 48 : 44)).map(n => n.className || n.tagName); return small;`);
    const touchIcons = ev(`const a = T.box(T.q('#tasks-quick')), b = T.box(T.q('#view-doc')); return [a.w, a.h, b.w, b.h];`);
    check(touchIcons.join() === '44,44,44,44', 'a phone: the By task icon is 44 px, as the Documents icon beside it', JSON.stringify(touchIcons));
    check(tall.length === 0, 'a phone: the close, Show all and Only buttons are 44 px, the rows 48 px and the checkboxes 22 px', JSON.stringify(tall));
    ev(`T.row('bc-39-specs-task').querySelector('input').click(); return true;`); await sleep(400);
    ev(`T.click('#task-scrim'); return true;`); await sleep(400);
    check(ev(`return !T.state().shown && T.box(T.q('#task-banner-all')).h >= 44;`), 'a phone: a tap outside the sheet closes it, and the banner\'s Show all is 44 px');
    axi('screenshot', path.join(shots, 'phone-390-banner.png'));
    consoleClean('the phone page');
  } catch (error) {
    check(false, 'the run went to its end', String(error && error.message).slice(0, 400));
  } finally {
    finish(stop);
  }
})().catch((error) => { console.error(error); process.exit(1); });
