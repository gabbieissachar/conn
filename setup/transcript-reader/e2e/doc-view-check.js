#!/usr/bin/env node
'use strict';

// The Documents view in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own port. By hand, not part of
// `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/doc-view-check.js <scratch folder> [screenshots folder]
//
// It builds the lab with three markdown files that crew-1's latest reply names (pane_lab.py, LAB_DOCS), starts that copy's server on a free
// port with a fake Herdr (never a real pane, never the owner's server) and drives a browser session of its own.
//   1. Narrow window (a phone): the contents list above a document, once opened, stays open while the page is drawn again by new builds
//      (it used to close itself), until the owner closes it or picks an item.
//   2. Wide window: the expanded mode, where the document has the width and the panel on its right switches between the file browser and the
//      contents.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-doc-view-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-doc-view-check');

// Where the Documents view stands: the document open, the contents list (a <details> above a phone's document), the layout classes.
const STATE = `const toc = document.querySelector('.toc'); const shell = document.querySelector('.docshell');
  return { ok: true, view: document.body.className, shell: shell ? shell.className : null, toc: toc ? { open: toc.open, same: toc === window.__toc, n: toc.querySelectorAll('a').length } : null,
    title: (document.querySelector('.doc-body h1') || {}).textContent || null };`;

// A new reply in crew-8: a build follows and the page draws itself again.
let late = 0;
const writeLate = (lab) => {
  const log = path.join(lab.home, '.claude', 'projects', '-lab-crew-8', lab.crew[7] + '.jsonl');
  const now = new Date().toISOString();
  fs.appendFileSync(log, [
    { type: 'user', uuid: `u-late-${late}`, timestamp: now, cwd: '/lab/crew-8', message: { role: 'user', content: `A late question ${late} in crew-8` } },
    { type: 'assistant', timestamp: now, cwd: '/lab/crew-8', message: { role: 'assistant', content: [{ type: 'text', text: `A late answer ${late} in crew-8.` }] } },
  ].map((r) => JSON.stringify(r) + '\n').join(''));
  late += 1;
};
const builtAt = (outDir) => { try { return fs.statSync(path.join(outDir, 'prototype.html')).mtimeMs; } catch (e) { return 0; } };
async function aBuild(lab, outDir) {
  const before = builtAt(outDir);
  writeLate(lab);
  for (let i = 0; i < 80 && builtAt(outDir) === before; i++) await sleep(250);
  await sleep(4500);  // the page's own poll takes it
}

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  process.env.LAB_DOCS = '3';
  const { lab, page, outDir, stop } = await startLab(folder);
  try {
    // ---- 1. a phone: the contents list stays open
    await openPage(page, '390x844x2,mobile,touch');
    pick('crew-1'); await sleep(900);
    ev(`document.getElementById('view-doc').click(); return true;`); await sleep(700);
    let s = ev(`return { ok: true, rows: [...document.querySelectorAll('.frow, .ghead')].map(n => n.className + ':' + n.textContent.slice(0, 30)) };`);
    process.stdout.write(`      list page: ${s.rows.join(' | ')}\n`);
    ev(`const g = document.querySelector('.ghead'); if (g && g.getAttribute('aria-expanded') !== 'true') g.click(); document.querySelector('.frow').click(); return true;`); await sleep(900);
    ev(`window.__toc = document.querySelector('.toc'); return true;`);
    s = ev(STATE);
    check(s.toc && s.toc.open === false && s.toc.n >= 6 && s.toc.same, 'a document opens on a phone with its contents list folded above it', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'narrow-1-folded.png'));
    ev(`document.querySelector('.toc summary').click(); return true;`); await sleep(400);
    s = ev(STATE);
    check(s.toc && s.toc.open === true, 'tapping Contents opens the list', JSON.stringify(s.toc));
    axi('screenshot', path.join(shots, 'narrow-2-open.png'));
    for (let n = 1; n <= 3; n++) {
      await aBuild(lab, outDir);
      s = ev(STATE);
      check(s.toc && s.toc.open === true, `still open after new build ${n}`, JSON.stringify(s.toc));
    }
    axi('screenshot', path.join(shots, 'narrow-3-after-builds.png'));
    // closing it is the owner's too: it stays closed through a build
    ev(`document.querySelector('.toc summary').click(); return true;`); await sleep(400);
    await aBuild(lab, outDir);
    s = ev(STATE);
    check(s.toc && s.toc.open === false, 'closed by a tap, it stays closed through a build', JSON.stringify(s.toc));
    // choosing an item closes it and scrolls to the section
    ev(`document.querySelector('.toc summary').click(); return true;`); await sleep(400);
    ev(`const a = [...document.querySelectorAll('.toc nav a')][3]; window.__item = a.textContent; a.click(); return true;`); await sleep(700);
    s = ev(`const h = [...document.querySelectorAll('.doc-md h2, .doc-md h3')].find(n => n.textContent === window.__item); return { ok: true, open: document.querySelector('.toc').open, top: h ? Math.round(h.getBoundingClientRect().top) : null, item: window.__item };`);
    check(s.open === false && s.top !== null && s.top < 400, 'choosing an item closes the list and scrolls to its section', JSON.stringify(s));
    // another document starts folded, even after the first was left open
    ev(`document.querySelector('.toc summary').click(); return true;`); await sleep(300);
    ev(`document.querySelector('.docshell').scrollIntoView(); const b = [...document.querySelectorAll('.btn')].find(x => /^‹ Files/.test(x.textContent)); b.click(); return true;`); await sleep(700);
    ev(`const rows = [...document.querySelectorAll('.frow')]; const cur = rows.find(r => r.getAttribute('aria-current') !== 'true' && /notes-/.test(r.title)); cur.click(); return true;`); await sleep(900);
    s = ev(STATE);
    check(s.toc && s.toc.open === false && s.title !== 'Notes 3', 'a different document opens with its list folded', JSON.stringify(s));

    // ---- 2. a wide window: the expanded view
    ev(`localStorage.removeItem('tr-docwide'); localStorage.removeItem('tr-docside'); return true;`);
    await openPage(page, '1440x900x1');
    pick('crew-1'); await sleep(900);
    ev(`(document.getElementById('tab-doc').offsetParent ? document.getElementById('tab-doc') : document.getElementById('view-doc')).click(); return true;`); await sleep(900);
    // The page's own answer, in two short expressions (chrome-devtools-axi drops an argument of about 1000 characters or more).
    const HELP = `const q = x => document.querySelector(x); const box = n => { const r = n && n.getBoundingClientRect(); return r ? { x: Math.round(r.left), w: Math.round(r.width), y: Math.round(r.top) } : null; };`;
    const WIDE_A = HELP + `const shell = q('.docshell'), files = q('.filespane');
      return { ok: true, shell: shell && shell.className, files: box(files), filesIn: files ? files.parentElement.className : null, pane: box(q('.docpane')), body: box(q('.doc-body')), side: box(q('.docside')),
        toc: box(q('.docview > .toc')), title: (q('.doc-body h1') || {}).textContent || null };`;
    const WIDE_B = `const q = x => document.querySelector(x); const side = q('.docside'); const ex = [...document.querySelectorAll('#controls .btn')].find(b => b.textContent === 'Expand');
      return { ok: true, tabs: side ? [...side.querySelectorAll('.ds-tabs .btn:not(.ds-close)')].map(b => b.textContent + ':' + b.getAttribute('aria-pressed') + (b.disabled ? ':disabled' : '')) : null,
        sideShows: side ? (side.querySelector('.filespane') ? 'files' : side.querySelector('.toc') ? 'contents' : 'nothing') : null, tocLinks: document.querySelectorAll('.toc nav a').length,
        expand: ex ? ex.getAttribute('aria-pressed') : null, wide: document.body.classList.contains('docwide'), scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };`;
    const wide = () => ({ ...ev(WIDE_A), ...ev(WIDE_B) });
    s = wide();
    check(/view-file/.test(s.shell) && !/expanded/.test(s.shell) && s.files && s.pane && s.files.x < s.pane.x && !s.side && s.expand === 'false', 'a wide window starts as before: the file list on the left, the file beside it, Expand off', JSON.stringify(s));
    check(s.toc && s.toc.x > s.body.x, 'the contents list sits beside the file (1180 px and more), as before', JSON.stringify(s.toc));
    axi('screenshot', path.join(shots, 'wide-1-normal.png'));
    const normalBody = s.body.w;
    ev(`[...document.querySelectorAll('#controls .btn')].find(x => x.textContent === 'Expand').click(); return true;`); await sleep(700);
    s = wide();
    check(/expanded/.test(s.shell) && s.side && s.pane && s.pane.x < s.side.x && s.expand === 'true' && s.wide, 'Expand: the file on the left, one panel on its right, the button pressed', JSON.stringify({ shell: s.shell, pane: s.pane, side: s.side, expand: s.expand }));
    check(s.sideShows === 'contents' && s.tabs.join() === 'Files:false,Contents:true' && s.tocLinks >= 12 && !s.toc, 'the panel opens on Contents (the list is not drawn twice)', JSON.stringify({ tabs: s.tabs, shows: s.sideShows, links: s.tocLinks, toc: s.toc }));
    check(s.body.w > normalBody + 150 && s.scrollW <= s.innerW, 'the file is wider than before and the page does not scroll sideways', `${normalBody} -> ${s.body.w}; page ${s.scrollW} of ${s.innerW}`);
    axi('screenshot', path.join(shots, 'wide-2-expanded-contents.png'));
    // contents: a click goes to the section, and the section being read is marked
    ev(`const a = [...document.querySelectorAll('.docside .toc nav a')][5]; window.__item = a.textContent; a.click(); return true;`); await sleep(800);
    s = ev(`const h = [...document.querySelectorAll('.doc-md h2, .doc-md h3')].find(n => n.textContent === window.__item); const cur = document.querySelector('.docside .toc a[aria-current=true]'); return { ok: true, top: h ? Math.round(h.getBoundingClientRect().top) : null, current: cur && cur.textContent, item: window.__item };`);
    check(s.top !== null && s.top < 300 && s.current === s.item, 'a Contents entry goes to its section and is marked as the one being read', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'wide-3-expanded-scrolled.png'));
    // Files: the browser is in the panel
    ev(`[...document.querySelectorAll('.ds-tabs .btn:not(.ds-close)')].find(b => b.textContent === 'Files').click(); return true;`); await sleep(500);
    s = wide();
    check(s.sideShows === 'files' && s.tabs.join() === 'Files:true,Contents:false' && s.filesIn === 'ds-body' && s.files.x > s.pane.x, 'Files shows the file browser in the panel', JSON.stringify({ tabs: s.tabs, filesIn: s.filesIn, files: s.files }));
    axi('screenshot', path.join(shots, 'wide-4-expanded-files.png'));
    // a new build keeps the panel, the layout and the document
    await aBuild(lab, outDir);
    s = wide();
    check(/expanded/.test(s.shell) && s.sideShows === 'files' && s.title === 'Notes 3', 'a new build keeps the expanded view, the panel and the document', JSON.stringify({ shell: s.shell, shows: s.sideShows, title: s.title }));
    // choose another file in the panel: the file changes, the panel stays on Files
    ev(`const row = [...document.querySelectorAll('.docside .frow')].find(r => /notes-1/.test(r.title)); row.click(); return true;`); await sleep(900);
    s = wide();
    check(s.title === 'Notes 1' && s.sideShows === 'files' && /expanded/.test(s.shell), 'choosing a file in the panel opens it and the panel stays on Files', JSON.stringify({ title: s.title, shows: s.sideShows }));
    // a page without headings: Contents is off
    ev(`const row = [...document.querySelectorAll('.docside .frow')].find(r => /sketch/.test(r.title)); row.click(); return true;`); await sleep(1500);
    s = wide();
    check(s.sideShows === 'files' && /Contents:false:disabled/.test(s.tabs.join()), 'a file with no contents list leaves Contents off', JSON.stringify({ tabs: s.tabs, shows: s.sideShows }));
    axi('screenshot', path.join(shots, 'wide-5-expanded-html.png'));
    ev(`const row = [...document.querySelectorAll('.docside .frow')].find(r => /notes-2/.test(r.title)); row.click(); return true;`); await sleep(900);
    ev(`[...document.querySelectorAll('.ds-tabs .btn:not(.ds-close)')].find(b => b.textContent === 'Contents').click(); return true;`); await sleep(400);
    s = wide();
    check(s.sideShows === 'contents' && s.title === 'Notes 2' && s.tocLinks >= 12, 'back on a markdown file, Contents works again', JSON.stringify({ shows: s.sideShows, title: s.title, links: s.tocLinks }));
    // both choices are kept in this browser
    axi('open', 'about:blank'); axi('open', page);
    await until(`return { ok: / · Reader$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the page again');
    await sleep(800);
    s = ev(`return { ok: true, stored: [localStorage.getItem('tr-docwide'), localStorage.getItem('tr-docside')], view: location.hash };`);
    check(s.stored.join() === '1,contents', 'the expanded view and the panel are kept in the browser', JSON.stringify(s));
    ev(`(document.getElementById('tab-doc').offsetParent ? document.getElementById('tab-doc') : document.getElementById('view-doc')).click(); return true;`); await sleep(1000);
    s = wide();
    check(/expanded/.test(s.shell) && s.sideShows === 'contents', 'a reload opens Documents expanded again, on the same panel', JSON.stringify({ shell: s.shell, shows: s.sideShows }));
    // narrowing the window to a phone: no panel, the phone's own pages
    const openDocs = async () => {  // a resized window loads the page again, on the conversation
      pick('crew-1'); await sleep(900);
      ev(`(document.getElementById('tab-doc').offsetParent ? document.getElementById('tab-doc') : document.getElementById('view-doc')).click(); return true;`); await sleep(1000);
    };
    axi('emulate', '--viewport', '390x844x2,mobile,touch'); await sleep(1200);
    await openDocs();
    s = wide();
    check(/docshell/.test(s.shell) && !/expanded/.test(s.shell) && !s.side && !s.wide && s.expand === null && s.scrollW <= s.innerW, 'on a phone there is no panel and no Expand button, though the choice is kept', JSON.stringify({ shell: s.shell, side: s.side, expand: s.expand }));
    axi('emulate', '--viewport', '1440x900x1'); await sleep(1200);
    await openDocs();
    s = wide();
    check(/expanded/.test(s.shell) && s.side && s.expand === 'true', 'at the wide size again the expanded view is back', s.shell);
    // collapse
    ev(`[...document.querySelectorAll('#controls .btn')].find(x => x.textContent === 'Expand').click(); return true;`); await sleep(700);
    s = wide();
    check(!/expanded/.test(s.shell) && !s.side && s.files && s.files.x < s.pane.x && s.expand === 'false' && !s.wide && s.toc, 'pressing Expand again puts the file list back on the left', JSON.stringify({ shell: s.shell, files: s.files, pane: s.pane, expand: s.expand }));
    axi('screenshot', path.join(shots, 'wide-6-collapsed.png'));
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  }
  finish(stop);
})();
