#!/usr/bin/env node
'use strict';

// Expand on the Documents view at any width but a phone's, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own
// port with a fake Herdr. By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/expand-width-check.js <scratch folder> [screenshots folder]
//
// The owner: "the expand button should show up even in phone view on desktop use, only in phone use it should not be shown, and also the button
// should be made available in the collapsed menu (icon menu)". Expand used to be drawn only where the window was 820 px wide or more. Now it is on
// every device that has a pointer and hover, whatever the window's width; a phone (touch only: emulated here with `mobile,touch`) has none. On a
// narrow desktop window, expanded, the file keeps the width and the Files / Contents panel slides over it. The folded header has an Expand icon.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-expand-width-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-expand-width-check');

// Short expressions (chrome-devtools-axi drops an argument of about 1000 characters or more).
const HEADER = `const b = [...document.querySelectorAll('#controls .btn, .dlg-head .btn')].filter(x => x.offsetParent); const icon = id => { const n = document.getElementById(id); return n && !n.hidden && getComputedStyle(n).display !== 'none'; };
  return { ok: true, expand: b.some(x => x.textContent === 'Expand'), pressed: (b.find(x => x.textContent === 'Expand') || { getAttribute: () => null }).getAttribute('aria-pressed'), panel: b.some(x => x.textContent === 'Panel'),
    filesBack: b.some(x => /^‹ Files/.test(x.textContent)), iconExpand: icon('expand-quick'), iconFiles: icon('files-quick'), collapsed: document.getElementById('bar').classList.contains('collapsed') };`;
const LAYOUT = `const q = x => document.querySelector(x); const box = n => { const r = n && n.getBoundingClientRect(); return r ? { x: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), y: Math.round(r.top) } : null; };
  const side = q('.docside'), shell = q('.docshell');
  return { ok: true, shell: shell && shell.className, body: box(q('.doc-body')), side: box(side), sideVisible: side ? getComputedStyle(side).visibility : null, list: Boolean(q('.docshell > .filespane') && q('.docshell > .filespane').offsetParent),
    title: (q('.doc-body h1') || {}).textContent || null, innerW: window.innerWidth, scrollW: document.documentElement.scrollWidth, scrim: Boolean(q('.ds-scrim') && getComputedStyle(q('.ds-scrim')).display !== 'none') };`;
const header = () => ev(HEADER);
const layout = () => ev(LAYOUT);
const openDocuments = async (name) => {
  pick(name); await sleep(900);
  ev(`(document.getElementById('tab-doc').offsetParent ? document.getElementById('tab-doc') : document.getElementById('view-doc')).click(); return true;`); await sleep(900);
};
const chooseNotes = async (n) => {
  // On a page where the list is a page of its own (a narrow, not expanded window) a file is chosen from it; elsewhere it is the open one already.
  ev(`const g = document.querySelector('.ghead'); if (g && g.getAttribute('aria-expanded') !== 'true') g.click(); const r = [...document.querySelectorAll('.frow')].find(x => /notes-${n}/.test(x.title)); if (r) r.click(); return true;`); await sleep(900);
};
const pressExpand = async () => { ev(`[...document.querySelectorAll('#controls .btn')].find(x => x.textContent === 'Expand').click(); return true;`); await sleep(800); };

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  process.env.LAB_DOCS = '3';
  const { page, stop } = await startLab(folder);
  try {
    // ---- 1. a desktop window dragged narrow: Expand is there
    await openPage(page, '600x900x1');
    ev(`localStorage.removeItem('tr-docwide'); localStorage.removeItem('tr-docside'); return true;`);
    await openDocuments('crew-1');
    await chooseNotes(3);
    let h = header(), l = layout();
    check(h.expand && h.pressed === 'false' && h.filesBack && !h.panel, 'a narrow desktop window: Expand is in the header, beside the way back to the file list', JSON.stringify(h));
    check(/view-file/.test(l.shell) && !/expanded/.test(l.shell) && l.body && l.body.w > 400, 'not expanded: the file on a page of its own, as on a phone', JSON.stringify(l));
    axi('screenshot', path.join(shots, 'expand-1-narrow-desktop.png'));

    // ---- 2. press it: the file keeps the width, a Panel button appears, the panel is not on screen yet
    await pressExpand();
    h = header(); l = layout();
    check(h.pressed === 'true' && h.panel && !h.filesBack, 'Expand pressed: Panel takes the place of the way back to the list', JSON.stringify(h));
    check(/expanded/.test(l.shell) && !/side-open/.test(l.shell) && l.sideVisible === 'hidden' && l.body.w > 400 && l.scrollW <= l.innerW, 'the file keeps the width and the panel waits off screen, with no sideways scroll', JSON.stringify(l));
    axi('screenshot', path.join(shots, 'expand-2-narrow-expanded.png'));

    // ---- 3. Panel: the panel slides over the file, on Contents; the file is not moved
    const bodyWidth = l.body.w;
    ev(`document.getElementById('panel-toggle').click(); return true;`); await sleep(500);
    l = layout();
    check(/side-open/.test(l.shell) && l.sideVisible === 'visible' && l.side.r === l.innerW && l.side.w <= 352 && l.body.w === bodyWidth && l.scrim, 'Panel: the panel slides over the file from the right edge; the file does not move; the rest dims', JSON.stringify(l));
    const tabs = ev(`return { ok: true, tabs: [...document.querySelectorAll('.docside .ds-tabs .btn')].map(b => b.textContent + ':' + b.getAttribute('aria-pressed')), links: document.querySelectorAll('.docside .toc nav a').length };`);
    check(/Files:false/.test(tabs.tabs.join()) && /Contents:true/.test(tabs.tabs.join()) && tabs.links >= 6, 'the drawer opens on Contents', JSON.stringify(tabs));
    axi('screenshot', path.join(shots, 'expand-3-narrow-drawer-contents.png'));
    // a contents entry goes to its section and the drawer gives way
    ev(`const a = [...document.querySelectorAll('.docside .toc nav a')][4]; window.__item = a.textContent; a.click(); return true;`); await sleep(800);
    l = layout();
    const sec = ev(`const h = [...document.querySelectorAll('.doc-md h2, .doc-md h3')].find(n => n.textContent === window.__item); return { ok: true, top: h ? Math.round(h.getBoundingClientRect().top) : null };`);
    check(!/side-open/.test(l.shell) && sec.top !== null && sec.top < 400, 'choosing a contents entry scrolls to its section and closes the drawer', JSON.stringify({ shell: l.shell, top: sec.top }));

    // ---- 4. Files in the drawer: choosing a file shows it and closes the drawer
    ev(`document.getElementById('panel-toggle').click(); return true;`); await sleep(400);
    ev(`[...document.querySelectorAll('.docside .ds-tabs .btn')].find(b => b.textContent === 'Files').click(); return true;`); await sleep(500);
    l = layout();
    const files = ev(`const f = document.querySelector('.docside .filespane'); return { ok: true, shown: Boolean(f && f.offsetParent), rows: document.querySelectorAll('.docside .frow').length };`);
    check(files.shown && files.rows >= 3, 'Files shows the file browser in the drawer', JSON.stringify(files));
    axi('screenshot', path.join(shots, 'expand-4-narrow-drawer-files.png'));
    ev(`const r = [...document.querySelectorAll('.docside .frow')].find(x => /notes-1/.test(x.title)); r.click(); return true;`); await sleep(900);
    l = layout();
    check(l.title === 'Notes 1' && !/side-open/.test(l.shell) && /expanded/.test(l.shell), 'choosing a file opens it and closes the drawer, still expanded', JSON.stringify({ title: l.title, shell: l.shell }));

    // ---- 5. the other ways to close it: Esc, the ✕, a click outside it
    for (const [how, close] of [['Esc', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`], ['the ✕', `document.querySelector('.docside .ds-close').click(); return true;`], ['a click outside it', `document.querySelector('.ds-scrim').click(); return true;`]]) {
      ev(`document.getElementById('panel-toggle').click(); return true;`); await sleep(400);
      check(/side-open/.test(layout().shell), `before ${how}: the drawer is open`);
      ev(close); await sleep(500);
      check(!/side-open/.test(layout().shell) && layout().sideVisible === 'hidden', `${how} closes the drawer`);
    }

    // ---- 6. a build (the page drawn again) keeps an open drawer open
    ev(`document.getElementById('panel-toggle').click(); return true;`); await sleep(400);
    ev(`document.getElementById('sync').click(); return true;`); await sleep(4000);
    check(/side-open/.test(layout().shell), 'a Sync (the page drawn again) leaves the drawer open');
    ev(`document.querySelector('.docside .ds-close').click(); return true;`); await sleep(400);

    // ---- 7. the folded header: Expand and Files icons
    ev(`document.getElementById('bar-toggle').click(); return true;`); await sleep(700);
    h = header();
    check(h.collapsed && h.iconExpand && h.iconFiles, 'the folded header has an Expand icon, and a Files icon that opens the panel', JSON.stringify(h));
    axi('screenshot', path.join(shots, 'expand-5-narrow-folded.png'));
    ev(`document.getElementById('files-quick').click(); return true;`); await sleep(500);
    check(/side-open/.test(layout().shell), 'the Files icon opens the drawer');
    ev(`document.querySelector('.docside .ds-close').click(); return true;`); await sleep(400);
    ev(`document.getElementById('expand-quick').click(); return true;`); await sleep(800);
    h = header(); l = layout();
    check(!/expanded/.test(l.shell) && h.iconFiles === true && h.iconExpand === true, 'the Expand icon turns it off (the Files icon is the way back to the list again)', JSON.stringify({ shell: l.shell, h }));
    ev(`document.getElementById('expand-quick').click(); return true;`); await sleep(800);
    check(/expanded/.test(layout().shell), 'and on again');

    // ---- 8. widening the window: the panel sits beside the file, as it always did
    axi('emulate', '--viewport', '1440x900x1'); await sleep(1000);
    ev(`document.getElementById('bar-toggle').click(); return true;`); await sleep(500);
    l = layout(); h = header();
    check(/expanded/.test(l.shell) && l.side && l.body && l.body.r <= l.side.x + 1 && l.sideVisible === 'visible' && !h.panel, 'wide again: the panel is beside the file, no Panel button', JSON.stringify({ shell: l.shell, side: l.side, body: l.body, panel: h.panel }));
    axi('screenshot', path.join(shots, 'expand-6-wide.png'));

    // ---- 9. a phone: no Expand, in the header or the folded one
    await openPage(page, '390x844x2,mobile,touch');
    await openDocuments('crew-1');
    await chooseNotes(2);
    h = header();
    check(!h.expand && !h.panel && h.filesBack, 'a phone has no Expand button, and keeps the way back to the file list', JSON.stringify(h));
    ev(`const b = document.getElementById('bar-toggle'); if (!document.getElementById('bar').classList.contains('collapsed')) b.click(); return true;`); await sleep(600);
    h = header();
    check(h.collapsed && !h.iconExpand, 'nor has the folded header of a phone', JSON.stringify(h));
    axi('screenshot', path.join(shots, 'expand-7-phone-folded.png'));
    // a phone held wide (landscape) is still a phone
    axi('emulate', '--viewport', '900x420x2,mobile,touch'); await sleep(900);
    ev(`const b = document.getElementById('bar-toggle'); if (document.getElementById('bar').classList.contains('collapsed')) b.click(); return true;`); await sleep(600);
    h = header();
    check(!h.expand && !h.iconExpand, 'a phone held wide has none either (it is a device, not a width)', JSON.stringify(h));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
