#!/usr/bin/env node
'use strict';

// Markdown files named by their absolute path open in an editor, in a real (headless) browser (chrome-devtools-axi), against a lab copy of the reader on its
// own port with a fake Herdr (nothing is sent to any pane, no editor is started). By hand, not part of `node --test`:
//
//   LAB_DOCS=2 node setup/transcript-reader/e2e/file-ref-check.js <scratch folder> [screenshots folder]
//
// The contract for a host such as Conn (README.md, "Markdown files open in an editor"): an absolute .md path in a reply is <a class="file-ref" data-path>, and
// the Documents view's button is <button class="file-ref" data-path>. Checked: which paths become links (and which do not: a web address, a relative or
// home path, a code span that holds a command, a fenced block), what a link does with no host (a listed file opens in the Documents view, another in VS Code),
// what a host that calls preventDefault gets (the path, and no navigation), the button on a markdown file and not on a page, and the lite page.
// VS Code is never started: the Navigation API catches the vscode:// address before it leaves the page.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-file-ref-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-file-ref-check');

const stamp = (outDir) => { try { return fs.statSync(path.join(outDir, 'prototype.html')).mtimeMs; } catch (e) { return 0; } };
const iso = (at) => new Date(at * 1000).toISOString();

(async () => {
  process.env.LAB_DOCS = process.env.LAB_DOCS || '2';
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop, outDir } = await startLab(folder);
  const log = path.join(lab.home, '.claude', 'projects', '-lab-crew-1', lab.crew[0] + '.jsonl');
  const one = path.join(lab.home, 'lab-docs', 'notes-1.md'), two = path.join(lab.home, 'lab-docs', 'notes-2.md'), sketch = path.join(lab.home, 'lab-docs', 'sketch.html');
  const gone = '/lab/nowhere/missing-plan.md';
  const text = [
    `Plan: ${one} has the first part, \`${two}\` the second, and ${gone} is not written yet.`,
    '',
    `Not links: \`cat ${one}\`, https://example.com/docs/readme.md, docs/readme.md, ~/x.md, /Users/me/../plan.md and ${one}.bak.`,
    '',
    '```',
    one,
    '```',
  ].join('\n');
  const REPLY = `const card = [...document.querySelectorAll('#main .reply')].reverse().find(c => /Plan:/.test(c.innerText)); if (!card) return { ok: false };
    const refs = [...card.querySelectorAll('a.file-ref')]; return { ok: true, refs: refs.map(a => ({ path: a.dataset.path, href: a.getAttribute('href'), code: Boolean(a.querySelector('code')), text: a.textContent })), fenced: card.querySelectorAll('pre a.file-ref').length };`;
  try {
    const before = stamp(outDir);
    const at = Date.now() / 1000 + 1;
    fs.appendFileSync(log, [
      { type: 'user', uuid: 'u-ref-1', timestamp: iso(at - 5), cwd: '/lab/crew-1', message: { role: 'user', content: 'Where are the notes?' } },
      { type: 'assistant', timestamp: iso(at), cwd: '/lab/crew-1', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
    for (let i = 0; i < 120 && stamp(outDir) === before; i++) await sleep(250);
    await sleep(500);
    await openPage(page, '1000x900x1');
    pick('crew-1'); await sleep(1500);

    // ---- which paths are links
    let s = await until(REPLY, 'the reply with its paths');
    check(s.refs.map((r) => r.path).join() === [one, two, gone].join(), 'three paths of the reply are links: the two files and the one not written yet', JSON.stringify(s.refs.map((r) => r.path)));
    check(s.refs[1].code && s.refs[1].text === two, 'the one alone in a code span is a link around the code', JSON.stringify(s.refs[1]));
    check(s.fenced === 0, 'and nothing in the fenced block, the command, the web address, the relative, home and ".." paths or "notes-1.md.bak" is', String(s.fenced));
    check(/^#s=c4e70000&d=[0-9a-f]{10}$/.test(s.refs[0].href) && /^#s=c4e70000&d=[0-9a-f]{10}$/.test(s.refs[1].href), 'a file the reader lists opens in its Documents view: the address names the conversation and the document', JSON.stringify([s.refs[0].href, s.refs[1].href]));
    check(s.refs[2].href === 'vscode://file/lab/nowhere/missing-plan.md', 'any other opens in VS Code from a plain browser', s.refs[2].href);
    axi('screenshot', path.join(shots, 'file-ref-1-reply.png'));

    // ---- a host that handles the click gets the path, and nothing else happens
    ev(`window.__host = []; document.addEventListener('click', e => { const el = e.target.closest('.file-ref[data-path]'); if (el) { e.preventDefault(); window.__host.push(el.dataset.path); } }, true); return true;`);
    ev(`const card = [...document.querySelectorAll('#main .reply')].reverse().find(c => /Plan:/.test(c.innerText)); card.querySelectorAll('a.file-ref').forEach(a => a.click()); return true;`);
    await sleep(500);
    s = ev(`return { ok: true, host: window.__host, hash: location.hash, view: document.body.className };`);
    check(s.host.join() === [one, two, gone].join() && /^#s=c4e70000$/.test(s.hash) && !/docmode/.test(s.view), 'a host that calls preventDefault gets each path, and the page does not move', JSON.stringify(s));

    // ---- no host: a listed file opens in the Documents view, with the button
    axi('open', 'about:blank'); axi('open', page + '#s=c4e70000'); await sleep(1800);
    pick('crew-1'); await sleep(1200);
    ev(`const card = [...document.querySelectorAll('#main .reply')].reverse().find(c => /Plan:/.test(c.innerText)); card.querySelector('a.file-ref').click(); return true;`);
    s = await until(`const b = document.querySelector('button.file-ref'); return { ok: /docmode/.test(document.body.className) && Boolean(b), title: (document.querySelector('.doc-body h1') || {}).textContent, path: b && b.dataset.path, label: b && b.textContent, hash: location.hash };`, 'the Documents view');
    check(s.title === 'Notes 1' && /&d=/.test(s.hash), 'with no host, clicking the link opens the file in the Documents view', JSON.stringify(s));
    check(s.path === one && s.label === 'Open in editor', 'and the view has a button.file-ref carrying the file\'s absolute path', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'file-ref-2-docview.png'));

    // ---- the button: the host's answer stands; with none it goes to VS Code (caught before it leaves)
    ev(`window.__host = []; document.addEventListener('click', e => { if (window.__hostOn) { const el = e.target.closest('.file-ref[data-path]'); if (el) { e.preventDefault(); window.__host.push(el.dataset.path); } } }, true); window.__hostOn = true; window.__nav = []; navigation.addEventListener('navigate', e => { if (/^vscode:/.test(e.destination.url)) { window.__nav.push(e.destination.url); e.preventDefault(); } }); return true;`);
    ev(`document.querySelector('button.file-ref').click(); return true;`); await sleep(600);
    s = ev(`return { ok: true, host: window.__host, nav: window.__nav };`);
    check(s.host.join() === one && s.nav.length === 0, 'a host that handles the button\'s click gets the path and VS Code is not asked', JSON.stringify(s));
    ev(`window.__hostOn = false; document.querySelector('button.file-ref').click(); return true;`); await sleep(600);
    s = ev(`return { ok: true, host: window.__host, nav: window.__nav };`);
    check(s.nav.length === 1 && s.nav[0] === 'vscode://file' + one, 'with no host the button opens vscode://file/<the path>', JSON.stringify(s.nav));

    // ---- an unlisted path's link, with no host
    axi('open', 'about:blank'); axi('open', page + '#s=c4e70000'); await sleep(1800);
    pick('crew-1'); await sleep(1200);
    ev(`window.__nav = []; navigation.addEventListener('navigate', e => { if (/^vscode:/.test(e.destination.url)) { window.__nav.push(e.destination.url); e.preventDefault(); } }); const card = [...document.querySelectorAll('#main .reply')].reverse().find(c => /Plan:/.test(c.innerText)); card.querySelectorAll('a.file-ref')[2].click(); return true;`); await sleep(600);
    s = ev(`return { ok: true, nav: window.__nav, hash: location.hash };`);
    check(s.nav.join() === 'vscode://file' + gone && /^#s=c4e70000$/.test(s.hash), 'with no host, a path the reader does not list opens in VS Code and the page stays', JSON.stringify(s));

    // ---- no button on a page
    s = ev(`const card = [...document.querySelectorAll('#main .reply')].find(c => c.querySelector('.doc-chip')); return { ok: true, chips: [...document.querySelectorAll('.doc-chip span:last-child')].map(n => n.textContent) };`);
    ev(`const chip = [...document.querySelectorAll('.doc-chip')].find(c => /sketch/.test(c.textContent)); if (chip) chip.click(); return true;`);
    s = await until(`return { ok: /docmode/.test(document.body.className), page: Boolean(document.querySelector('iframe')) || /sketch/.test(document.querySelector('.summary').textContent), buttons: document.querySelectorAll('button.file-ref').length };`, 'the page in the Documents view');
    check(s.buttons === 0, 'a page (an HTML file) has no editor button', JSON.stringify(s));

    // ---- the lite page
    axi('open', 'about:blank'); axi('open', page.replace('prototype.html', 'live/index.html') + '#s=c4e70000'); await sleep(2500);
    s = await until(REPLY, 'the lite page\'s reply');
    check(s.refs.map((r) => r.path).join() === [one, two, gone].join(), 'the lite page draws the same three links', JSON.stringify(s.refs.map((r) => r.path)));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
