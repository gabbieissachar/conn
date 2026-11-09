#!/usr/bin/env node
'use strict';

// The expanded Documents view is a dialog over the page, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own port with a
// fake Herdr. By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/expand-dialog-check.js <scratch folder> [screenshots folder]
//
// The owner: "the document view expand button does not really expand the doc view, I think it might be due the fact the reader app view and column got
// constrained to page width, so can consider opening a dialog for the expanded view". Reproduced before the change: in a Watch column (330 to 480 px)
// Expand left the file exactly as wide as before (456 px at 480; the list was already a page of its own) under a header 236 px tall and a message bar,
// and in a browser tab at 1440 px it widened the file from 568 to 1048 px but left the page's header on top and the page scrolling. A window can never
// give a dialog more than its own width, so what a dialog adds in a narrow column is everything else: no page header, the whole height above the
// message bar, the page behind it still. This check pins that at the Watch widths (330, 360, 390, 440, 480), at 700 and at 1440, light and dark.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-expand-dialog-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, check, startLab, openPage, pick, finish, sleep } = make('reader-expand-dialog-check');

// Short expressions (chrome-devtools-axi drops an argument of about 1000 characters or more).
const BOXES = `const q = x => document.querySelector(x); const b = n => { const r = n && n.getBoundingClientRect(); return r ? { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } : null; };
  const dock = q('#dock');
  return { ok: true, vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth, shell: q('.docshell') && q('.docshell').className, dlg: b(q('.docshell.expanded')), head: b(q('.dlg-head')), pane: b(q('.docpane')),
    body: b(q('.doc-body')), side: b(q('.docside')), dock: b(dock), bar: b(q('#bar')), role: q('.docshell') && q('.docshell').getAttribute('role'), sideVis: q('.docside') ? getComputedStyle(q('.docside')).visibility : null };`;
const CTRL = `const vis = n => n && n.offsetParent !== null && n.getBoundingClientRect().width > 0; const bs = [...document.querySelectorAll('.dlg-head .btn')];
  const hit = n => { const r = n.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === n || n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); };
  return { ok: true, labels: bs.map(n => n.querySelector('.long') ? n.querySelector('.long').textContent : n.textContent), shown: bs.map(n => Boolean(vis(n) && hit(n))), title: (q => q && q.textContent)(document.querySelector('.dlg-title')),
    titleW: (q => q ? Math.round(q.getBoundingClientRect().width) : 0)(document.querySelector('.dlg-title')), rows: new Set(bs.map(n => Math.round(n.getBoundingClientRect().top))).size };`;
const boxes = () => ev(BOXES);
const ctrl = () => ev(CTRL);
const openNotes = async (n = 3) => {
  pick('crew-1'); await sleep(900);
  ev(`(document.getElementById('tab-doc').offsetParent ? document.getElementById('tab-doc') : document.getElementById('view-doc')).click(); return true;`); await sleep(900);
  ev(`const g = document.querySelector('.ghead'); if (g && g.getAttribute('aria-expanded') !== 'true') g.click(); const r = [...document.querySelectorAll('.frow')].find(x => /notes-${n}/.test(x.title)); if (r) r.click(); return true;`); await sleep(900);
};
const press = async (label) => { ev(`[...document.querySelectorAll('#controls .btn, .dlg-head .btn')].find(x => /^${label}/.test(x.textContent)).click(); return true;`); await sleep(800); };
const scrollPane = (y) => ev(`const p = document.querySelector('.docpane'); p.scrollTop = ${y}; return true;`);

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  process.env.LAB_DOCS = '3';
  const { page, stop } = await startLab(folder);
  try {
    // ---- 1. a Watch column and a narrow window: the file gets the whole window, with no page header over it
    for (const win of [330, 360, 390, 440, 480, 700]) {
      const viewport = `${win}x800x1`;
      await openPage(page, viewport);
      ev(`sessionStorage.removeItem('tr-docdialog'); return true;`);
      await openNotes(3);
      const before = boxes();
      await press('Expand');
      const a = boxes(), c = ctrl();
      const what = `${win} px`;
      check(a.role === 'dialog' && a.dlg && a.dlg.x === 0 && a.dlg.y === 0 && a.dlg.r === a.vw && a.dlg.b === a.dock.y, `${what}: Expand opens a dialog over the whole window, down to the message bar`, JSON.stringify({ dlg: a.dlg, dock: a.dock }));
      check(a.pane && a.pane.y <= 90 && a.pane.h >= a.vh - a.dock.h - 100, `${what}: the file has the height (${before.body ? before.body.y : '?'} px of page header above it before, ${a.pane && a.pane.y} now)`, JSON.stringify({ pane: a.pane, dock: a.dock, vh: a.vh }));
      check(a.body && a.body.w >= a.vw - 24 && a.scrollW <= a.vw, `${what}: the file is the window's width and nothing scrolls sideways`, JSON.stringify({ body: a.body, scrollW: a.scrollW }));
      check(c.labels[0] === '✕ Close' && c.shown.every(Boolean) && c.title === 'notes-3.md' && c.titleW >= 60 && c.rows <= 2, `${what}: Close, the name and the buttons are in view, in at most two rows`, JSON.stringify(c));
      axi('screenshot', path.join(shots, `dialog-${win}-light.png`));
      // the page behind is still; the pane scrolls; Esc closes
      scrollPane(900); await sleep(300);
      const sc = ev(`return { ok: true, pane: Math.round(document.querySelector('.docpane').scrollTop), page: Math.round(scrollY) };`);
      check(sc.pane > 300 && sc.page === 0, `${what}: the file scrolls inside the dialog and the page behind does not`, JSON.stringify(sc));
      ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`); await sleep(700);
      const z = boxes();
      check(!/expanded/.test(z.shell) && z.role === null && z.bar && z.bar.h > 40, `${what}: Esc closes it and the page header is back`, JSON.stringify({ shell: z.shell, bar: z.bar }));
    }

    // ---- 2. the narrow dialog's panel (Files | Contents) is a drawer over the file, from the dialog's own header
    await openPage(page, '390x800x1');
    ev(`sessionStorage.removeItem('tr-docdialog'); return true;`);
    await openNotes(3);
    await press('Expand');
    let a = boxes();
    check(a.side && a.sideVis === 'hidden', 'narrow: the panel waits off screen', JSON.stringify({ side: a.side, vis: a.sideVis }));
    await press('Panel');
    a = boxes();
    check(/side-open/.test(a.shell) && a.sideVis === 'visible' && a.side.r === a.vw && a.side.y >= a.head.b - 1 && a.side.b <= a.dock.y + 1 && a.side.w <= 352, 'Panel: the drawer slides over the file from the right, under the dialog header and above the message bar', JSON.stringify({ side: a.side, head: a.head, dock: a.dock }));
    axi('screenshot', path.join(shots, 'dialog-390-drawer-light.png'));
    ev(`const x = [...document.querySelectorAll('.docside .toc nav a')][5]; x.click(); return true;`); await sleep(700);
    a = boxes();
    check(!/side-open/.test(a.shell) && /expanded/.test(a.shell), 'a Contents entry closes the drawer, and the dialog stays', a.shell);
    await press('Panel');
    ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`); await sleep(500);
    a = boxes();
    check(!/side-open/.test(a.shell) && /expanded/.test(a.shell), 'Esc closes the drawer first, the dialog is still open', a.shell);
    ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`); await sleep(500);
    check(!/expanded/.test(boxes().shell), 'and the next Esc closes the dialog');

    // ---- 3. a box with its own Esc keeps it: the file filter in the panel clears itself, the dialog stays
    await press('Expand');
    await press('Panel');
    ev(`[...document.querySelectorAll('.docside .ds-tabs .btn')].find(b => b.textContent === 'Files').click(); return true;`); await sleep(400);
    ev(`const i = document.querySelector('.docside input'); i.focus(); i.value = 'notes'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`); await sleep(500);
    a = boxes();
    check(/expanded/.test(a.shell) && ev(`return document.querySelector('.docside input').value === '';`), 'Esc in the file filter clears the filter and leaves the dialog open', a.shell);
    ev(`document.querySelector('.dlg-close').click(); return true;`); await sleep(600);
    check(!/expanded/.test(boxes().shell), 'the Close button closes it');

    // ---- 4. a browser tab at 1440 px: inset, the page dimmed behind it, the panel beside the file; light and dark
    for (const scheme of ['light', 'dark']) {
      await openPage(page, '1440x900x1');
      axi('emulate', '--viewport', '1440x900x1', '--color-scheme', scheme); await sleep(600);
      ev(`sessionStorage.removeItem('tr-docdialog'); return true;`);
      await openNotes(3);
      await press('Expand');
      a = boxes();
      const c = ctrl();
      check(a.dlg && a.dlg.x === 10 && a.dlg.y === 10 && a.dlg.r === a.vw - 10 && a.dlg.b === a.dock.y - 10, `1440 ${scheme}: the dialog sits 10 px inside the window, above the message bar`, JSON.stringify({ dlg: a.dlg, dock: a.dock }));
      check(a.side && a.pane && a.pane.r <= a.side.x && a.sideVis === 'visible' && a.body.w >= 1000, `1440 ${scheme}: the panel is beside the file, the file is 1000 px or more wide (568 before)`, JSON.stringify({ pane: a.pane, side: a.side, body: a.body }));
      check(c.labels.join() === '✕ Close,Message about this file,Open in editor' && c.shown.every(Boolean) && c.rows === 1, `1440 ${scheme}: Close, Message about this file and Open in editor on one row`, JSON.stringify(c));
      const look = ev(`const cs = getComputedStyle(document.querySelector('.docshell')); return { ok: true, bg: cs.backgroundColor, shadow: cs.boxShadow.slice(0, 60), body: getComputedStyle(document.body).backgroundColor };`);
      check(look.shadow !== 'none' && look.bg !== 'rgba(0, 0, 0, 0)', `1440 ${scheme}: it has a background and the page dimmed behind it`, JSON.stringify(look));
      axi('screenshot', path.join(shots, `dialog-1440-${scheme}.png`));
      if (scheme === 'light') {
        // a page (an HTML file) fills the dialog: the frame reaches the pane's foot
        ev(`[...document.querySelectorAll('.docside .ds-tabs .btn')].find(b => b.textContent === 'Files').click(); return true;`); await sleep(400);
        ev(`const r = [...document.querySelectorAll('.docside .frow')].find(x => /sketch/.test(x.title)); r.click(); return true;`); await sleep(1500);
        const f = ev(`const p = document.querySelector('.docpane').getBoundingClientRect(), f = document.querySelector('.htmlframe').getBoundingClientRect(); return { ok: true, paneB: Math.round(p.bottom), frameB: Math.round(f.bottom), frameH: Math.round(f.height), frameW: Math.round(f.width), paneW: Math.round(p.width) };`);
        check(f.paneB - f.frameB <= 20 && f.frameH > 500 && f.frameW >= f.paneW - 30, '1440 light: an HTML page fills the dialog down to its foot', JSON.stringify(f));
        axi('screenshot', path.join(shots, 'dialog-1440-html.png'));
      }
    }
    axi('emulate', '--viewport', '1440x900x1', '--color-scheme', 'light'); await sleep(400);

    // ---- 5. a phone has no Expand and so no dialog
    await openPage(page, '390x844x2,mobile,touch');
    await openNotes(2);
    const phone = ev(`return { ok: true, expand: [...document.querySelectorAll('#controls .btn')].some(x => x.textContent === 'Expand'), dialog: Boolean(document.querySelector('.docshell[role=dialog]')) };`);
    check(!phone.expand && !phone.dialog, 'a phone: no Expand, no dialog', JSON.stringify(phone));
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  }
  finish(stop);
})();
