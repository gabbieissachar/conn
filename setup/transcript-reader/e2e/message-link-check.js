#!/usr/bin/env node
'use strict';

// The reader's message addresses and in-place address changes, in a real browser (chrome-devtools-axi), against a lab copy of the
// reader on its own port. By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/message-link-check.js <scratch folder> [screenshots folder]
//
// It builds the lab (message_lab.py: made-up session logs under a scratch HOME, a copy of this reader's code with its own out/, a Herdr
// that sees nothing), starts that copy's server on a free port, and drives a browser session of its own (CHROME_DEVTOOLS_AXI_SESSION), never
// the owner's tabs, servers (8765, 8768) or Herdr. It checks, from a fresh load and from another conversation already open:
//   - a message address opens the conversation scrolled to the message, with the message outlined, whether the message sits in the
//     conversation's older session (a /clear chain), inside a folded run of wake-ups, or in a long reply that is clipped;
//   - an unknown message id opens the conversation and says so; #s= and &d= still open as they always did;
//   - an address change while the page is open switches in place (a marker on window survives, so the page did not load again), the
//     page's own address writes cause no second change, and the same link works a second time;
//   - the same landing on the lite page (out/live/index.html, which Conn's columns and asks open): from a fresh load and in place, the reply
//     is scrolled to just under the header and outlined once (the outline is an animation that ends: it does not stay lit).

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const READER = path.resolve(__dirname, '..');
const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-message-link-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION || 'reader-message-links-check';
const results = [];
const check = (ok, what, detail = '') => { results.push({ ok: Boolean(ok), what, detail }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  ' + detail : ''}\n`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const axi = (...args) => execFileSync('chrome-devtools-axi', args, { encoding: 'utf8', timeout: 90000, env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: SESSION } });
// What the page's expression answered: the tool prints it as a JSON string, once or twice over.
function ev(expression) {
  const line = axi('eval', `JSON.stringify((() => { ${expression} })())`).split('\n').find((l) => l.startsWith('result: '));
  if (!line) throw new Error('no result for: ' + expression);
  let value = JSON.parse(line.slice('result: '.length));
  while (typeof value === 'string') { try { value = JSON.parse(value); } catch (e) { break; } }
  return value;
}
async function until(expression, what, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = ev(expression); if (last && (typeof last !== 'object' || last.ok !== false)) return last; } catch (e) { last = e.message; }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

// What a check reads off the page.
const LINKED = `const el = document.querySelector('.is-linked'); if (!el) return { ok: false, linked: null }; const r = el.getBoundingClientRect(); const bar = document.getElementById('bar').getBoundingClientRect();
  return { ok: true, linked: el.dataset.msg || el.id, top: Math.round(r.top), height: Math.round(r.height), barBottom: Math.round(bar.bottom), scrollY: Math.round(scrollY), vh: innerHeight,
    clipped: Boolean(el.querySelector('.clip, button.more')), hash: location.hash, note: (document.getElementById('follow-note') || {}).textContent || '', title: document.title, marker: window.__marker || null };`;
const STATE = `return { hash: location.hash, note: (document.getElementById('follow-note') || {}).textContent || '', title: document.title, marker: window.__marker || null, linked: document.querySelectorAll('.is-linked').length,
  changes: window.__changes || 0, scrollY: Math.round(scrollY), docView: document.getElementById('tab-doc').getAttribute('aria-selected') };`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const lab = JSON.parse(execFileSync('python3', [path.join(__dirname, 'message_lab.py'), folder], { encoding: 'utf8', timeout: 180000 }).trim().split('\n').pop());
  const port = await freePort();
  const out = fs.openSync(path.join(folder, 'server.log'), 'a');
  const server = spawn('node', [path.join(lab.repo, 'setup', 'transcript-reader', 'server.js'), '--port', String(port), '--root', lab.repo], {
    stdio: ['ignore', out, out], env: { ...process.env, HOME: lab.home, PMOS_READER_PROJECTS: path.join(lab.home, '.claude', 'projects'), PATH: lab.bin + path.delimiter + process.env.PATH },
  });
  const page = `http://localhost:${port}/setup/transcript-reader/out/prototype.html`;
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(page); if (r.ok) break; } catch (e) { /* not up yet */ } await sleep(200); }
    const [NEW, OLD, OTHER] = [lab.new.slice(0, 8), lab.old.slice(0, 8), lab.other.slice(0, 8)];
    const m = (uid) => uid.slice(0, 12);
    axi('emulate', '--viewport', '1000x800x1');
    // Following Herdr's focus would move the page to the conversation Herdr shows; the checks are of addresses alone.
    axi('open', page); await sleep(1500); ev(`localStorage.setItem('tr-follow', '0'); return true;`);

    // A fresh load: another page first, so nothing of the reader is kept.
    const fresh = async (hash) => { axi('open', 'about:blank'); axi('open', page + hash); await until(`return { ok: / · (Reader|Documents)$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the page'); await sleep(700); };

    // ---- 1. a message in the older session of a /clear chain, in a long reply that is clipped, from a fresh load
    await fresh(`#s=${NEW}&m=${m(lab.ask)}`);
    let s = await until(LINKED, 'the message on a fresh load');
    check(s.linked === `${lab.ask}:reply`, 'fresh load: the long reply in the older session is the outlined message', s.linked);
    check(!s.clipped, 'fresh load: the clipped reply is shown in full');
    check(s.top >= s.barBottom - 2 && s.top < s.barBottom + 40 && s.scrollY > 0, 'fresh load: the reply sits just under the header', `top ${s.top}, header ends ${s.barBottom}, scrolled ${s.scrollY}`);
    check(s.hash === `#s=${NEW}`, 'fresh load: the address goes back to #s= once there', s.hash);
    check(s.note === '', 'fresh load: no notice when the message is found', s.note);
    check(/22222222/.test(s.title), 'fresh load: the conversation opened is the chain', s.title);
    axi('screenshot', path.join(shots, '01-fresh-clipped-reply.png'));

    // ---- 2. the same message by the older session's own id
    await fresh(`#s=${OLD}&m=${m(lab.ask)}`);
    s = ev(LINKED);
    check(s.linked === `${lab.ask}:reply` && /22222222/.test(s.title), 'fresh load by the older session id of the chain: same conversation, same message', `${s.linked} ${s.title}`);

    // ---- 3. a reply inside a folded run of wake-ups
    await fresh(`#s=${NEW}&m=${m(lab.folded)}`);
    s = ev(LINKED);
    check(s.linked === `${lab.folded}:reply` && s.height > 0, 'fresh load: a reply inside a folded run of wake-ups is revealed and outlined', s.linked);
    check(s.top >= s.barBottom - 2 && s.top < s.barBottom + 40, 'fresh load: the folded reply sits just under the header', `top ${s.top}`);
    axi('screenshot', path.join(shots, '02-fresh-folded-wake.png'));

    // ---- 4. an unknown message id, and a session that is not on the reader
    await fresh(`#s=${NEW}&m=ffffffffffff`);
    s = ev(STATE);
    check(/was not found in this conversation/.test(s.note) && s.linked === 0 && /22222222/.test(s.title), 'fresh load: an unknown message opens the conversation and says plainly it was not found', s.note);
    await fresh(`#s=deadbeef&m=${m(lab.ask)}`);
    s = ev(STATE);
    check(/Session deadbeef is not on the reader any more/.test(s.note) && s.linked === 0, 'fresh load: an unknown session says so and looks for no message in the conversation that opened', s.note);

    // ---- 5. #s= and &d= as they always were
    await fresh(`#s=${OTHER}`);
    s = ev(STATE);
    check(s.hash === `#s=${OTHER}` && /(33333333|alpha)/.test(s.title) && s.linked === 0, 'fresh load: #s= opens the conversation as before', `${s.hash} ${s.title}`);
    const doc = ev(`return Object.keys(JSON.parse(document.getElementById('payload').textContent).documents || {})[0] || null;`);
    check(Boolean(doc), 'the lab has a document to open', String(doc));
    await fresh(`#s=${OTHER}&d=${doc}`);
    s = ev(STATE);
    check(s.hash === `#s=${OTHER}&d=${doc}` && s.docView === 'true', 'fresh load: #s=&d= opens the Documents view as before', `${s.hash} docView=${s.docView}`);

    // ---- 6. from another conversation already open: in place, no load
    await fresh(`#s=${OTHER}`);
    ev(`window.__marker = 'kept'; window.__changes = 0; window.addEventListener('hashchange', () => { window.__changes++; }); return true;`);
    ev(`location.hash = '#s=${NEW}&m=${m(lab.ask)}'; return true;`);
    s = await until(LINKED, 'the message after an address change');
    check(s.marker === 'kept', 'in place: the page did not load again (a marker on window survives)');
    check(s.linked === `${lab.ask}:reply` && /22222222/.test(s.title) && !s.clipped, 'in place: the conversation switched and the message is outlined, in full', `${s.linked} ${s.title}`);
    check(s.top >= s.barBottom - 2 && s.top < s.barBottom + 40, 'in place: the message sits just under the header', `top ${s.top}`);
    check(s.hash === `#s=${NEW}`, 'in place: the address went back to #s=', s.hash);
    await sleep(600);
    check(ev(STATE).changes === 1, 'in place: the page\'s own address write caused no second change', String(ev(STATE).changes));
    axi('screenshot', path.join(shots, '03-in-place-from-other-conversation.png'));

    // ---- 7. plain #s= in place, both ways
    ev(`location.hash = '#s=${OTHER}'; return true;`);
    s = await until(`const t = document.title; return { ok: /(33333333|alpha)/.test(t), title: t, hash: location.hash, marker: window.__marker || null, linked: document.querySelectorAll('.is-linked').length };`, 'the other conversation in place');
    check(s.marker === 'kept' && s.hash === `#s=${OTHER}` && s.linked === 0, 'in place: #s= switches to another conversation without a load', `${s.title} ${s.hash}`);
    ev(`location.hash = '#s=${NEW}'; return true;`);
    s = await until(`const t = document.title; return { ok: /22222222/.test(t), title: t, marker: window.__marker || null, bottom: innerHeight + scrollY >= document.documentElement.scrollHeight - 80 };`, 'the chain in place');
    check(s.marker === 'kept' && s.bottom, 'in place: #s= back to the chain opens at its latest turn', JSON.stringify(s));

    // ---- 8. a folded reply, in place; then the same link twice
    ev(`location.hash = '#s=${NEW}&m=${m(lab.folded)}'; return true;`);
    s = await until(LINKED, 'the folded reply in place');
    check(s.linked === `${lab.folded}:reply` && s.marker === 'kept', 'in place: a reply inside a folded run is revealed and outlined', s.linked);
    ev(`window.scrollTo(0, 0); return true;`);
    ev(`location.hash = '#s=${NEW}&m=${m(lab.folded)}'; return true;`);
    s = await until(`const el = document.querySelector('.is-linked'); return { ok: Boolean(el) && scrollY > 100, scrollY: Math.round(scrollY), linked: el && el.dataset.msg };`, 'the same link a second time');
    check(s.linked === `${lab.folded}:reply`, 'in place: the same link works a second time (the address had gone back to #s=)', `scrolled ${s.scrollY}`);
    ev(`location.hash = '#s=${NEW}&m=${m(lab.late)}'; return true;`);
    s = await until(`const el = document.querySelector('.is-linked'); return { ok: Boolean(el) && el.dataset.msg === '${lab.late}:reply', linked: el && el.dataset.msg, n: document.querySelectorAll('.is-linked').length };`, 'a message in the newest session');
    check(s.n === 1, 'in place: a message in the newest session is outlined, and only one reply is', JSON.stringify(s));

    // ---- 9. unknown things in place leave the conversation as it was
    ev(`location.hash = '#s=${NEW}&m=ffffffffffff'; return true;`);
    s = await until(`const n = document.getElementById('follow-note').textContent; return { ok: /was not found in this conversation/.test(n), note: n, marker: window.__marker || null };`, 'the not-found notice in place');
    check(s.marker === 'kept', 'in place: an unknown message says so without loading the page', s.note);
    ev(`location.hash = '#s=deadbeef'; return true;`);
    s = await until(`const n = document.getElementById('follow-note').textContent; return { ok: /Session deadbeef is not on the reader any more/.test(n), note: n, title: document.title };`, 'the unknown-session notice in place');
    check(/22222222/.test(s.title), 'in place: an unknown session says so and stays where it was', s.note);

    // ---- 10. the Documents view in place
    ev(`location.hash = '#s=${OTHER}&d=${doc}'; return true;`);
    s = await until(`return { ok: document.getElementById('tab-doc').getAttribute('aria-selected') === 'true', hash: location.hash, marker: window.__marker || null };`, 'the Documents view in place');
    check(s.marker === 'kept' && s.hash === `#s=${OTHER}&d=${doc}`, 'in place: #s=&d= opens the Documents view without a load', s.hash);

    // ---- 11. a conversation whose pane has closed: opened again as a fresh load opens it, and in place
    const CLOSED = lab.closed.slice(0, 8);
    await fresh(`#s=${CLOSED}`);
    s = await until(`return { ok: /(44444444|gamma)/.test(document.title), title: document.title, note: (document.getElementById('follow-note') || {}).textContent || '', hash: location.hash };`, 'the closed-pane conversation on a fresh load', 20000);
    check(s.hash === `#s=${CLOSED}` && !/not on the reader/.test(s.note), 'fresh load: a closed pane\'s conversation is listed again and opened', `${s.title} ${s.note}`);
    await fresh(`#s=${OTHER}`);
    ev(`window.__marker = 'kept'; return true;`);
    ev(`location.hash = '#s=${lab.closed.slice(0, 8)}&m=${m(lab.closed_reply)}'; return true;`);
    s = await until(`const el = document.querySelector('.is-linked'); return { ok: Boolean(el) && /(44444444|gamma)/.test(document.title), linked: el && el.dataset.msg, marker: window.__marker || null, note: (document.getElementById('follow-note') || {}).textContent || '' };`, 'the closed-pane message in place', 20000);
    check(s.marker === 'kept' && s.linked === `${lab.closed_reply}:reply`, 'in place: a closed pane\'s conversation is listed again, opened and its message outlined, without a load', `${s.linked} ${s.note}`);

    // ---- 12. the lite page: what a column or a list of asks opens, #s=<conversation>&m=<turn>
    const lite = `http://localhost:${port}/setup/transcript-reader/out/live/index.html`;
    const freshLite = async (hash) => { axi('open', 'about:blank'); axi('open', lite + hash); await until(`return { ok: / · (Reader|Documents)$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the lite page'); await sleep(700); };
    ev(`localStorage.setItem('tr-live-follow', '0'); return true;`);
    await freshLite(`#s=${NEW}&m=${m(lab.ask)}`);
    s = await until(LINKED, 'the message on a fresh load of the lite page');
    check(s.linked === `${lab.ask}:reply` && /22222222/.test(s.title), 'lite page, fresh load: the conversation opens on the message and outlines it', `${s.linked} ${s.title}`);
    check(s.top >= s.barBottom - 2 && s.top < s.barBottom + 40 && s.scrollY > 0, 'lite page, fresh load: the reply sits just under the header', `top ${s.top}, header ends ${s.barBottom}, scrolled ${s.scrollY}`);
    check(s.hash === `#s=${NEW}` && !s.clipped, 'lite page, fresh load: the address goes back to #s=, and the clipped reply is shown in full', s.hash);
    const flashing = ev(`const el = document.querySelector('.is-linked'); return { running: el ? el.getAnimations().length : -1 };`);
    check(flashing.running === 1, 'lite page, fresh load: the reply is flashing (the outline animation is running)', JSON.stringify(flashing));
    // The outline is an animation of 2.8 s that ends (the class stays for a redraw to continue it): "flash once" means no outline left lit after it.
    await sleep(3200);
    const lit = ev(`const el = document.querySelector('.is-linked'); return { running: el ? el.getAnimations().length : -1, shadow: el ? getComputedStyle(el).boxShadow : '' };`);
    check(lit.running === 0 && (lit.shadow === 'none' || /rgba\(0, 0, 0, 0\)/.test(lit.shadow)), 'lite page: the outline has faded out once (nothing is left lit and nothing animates)', JSON.stringify(lit));
    axi('screenshot', path.join(shots, '05-lite-fresh-clipped-reply.png'));
    await freshLite(`#s=${NEW}&m=${m(lab.folded)}`);
    s = await until(LINKED, 'a reply in a folded run on the lite page');
    check(s.linked === `${lab.folded}:reply` && s.height > 0 && s.top >= s.barBottom - 2 && s.top < s.barBottom + 40, 'lite page, fresh load: a reply inside a folded run is revealed, outlined and just under the header', `${s.linked} top ${s.top}`);
    await freshLite(`#s=${NEW}&m=ffffffffffff`);
    s = ev(STATE);
    check(/was not found in this conversation/.test(s.note) && s.linked === 0, 'lite page, fresh load: an unknown message opens the conversation and says plainly it was not found', s.note);
    await freshLite(`#s=${OTHER}`);
    ev(`window.__marker = 'kept'; window.__changes = 0; window.addEventListener('hashchange', () => { window.__changes++; }); return true;`);
    ev(`location.hash = '#s=${NEW}&m=${m(lab.ask)}'; return true;`);
    s = await until(LINKED, 'the message in place on the lite page');
    check(s.marker === 'kept' && s.linked === `${lab.ask}:reply` && /22222222/.test(s.title) && !s.clipped, 'lite page, in place: another conversation loads, opens on the message and outlines it, without a page load', `${s.linked} ${s.title}`);
    check(s.top >= s.barBottom - 2 && s.top < s.barBottom + 40 && s.hash === `#s=${NEW}`, 'lite page, in place: the reply sits just under the header, and the address went back to #s=', `top ${s.top} ${s.hash}`);
    ev(`window.scrollTo(0, 0); return true;`);
    ev(`location.hash = '#s=${NEW}&m=${m(lab.ask)}'; return true;`);
    s = await until(`const el = document.querySelector('.is-linked'); return { ok: Boolean(el) && scrollY > 100, scrollY: Math.round(scrollY), linked: el && el.dataset.msg, n: document.querySelectorAll('.is-linked').length };`, 'the same link a second time on the lite page');
    check(s.linked === `${lab.ask}:reply` && s.n === 1, 'lite page, in place: the same link a second time scrolls to the reply again, and only one reply is outlined', JSON.stringify(s));

    // ---- 13. a phone-width screen
    axi('emulate', '--viewport', '390x844x3,mobile,touch');
    await fresh(`#s=${NEW}&m=${m(lab.ask)}`);
    s = ev(LINKED);
    check(s.linked === `${lab.ask}:reply` && s.top >= s.barBottom - 2 && s.top < s.barBottom + 40, 'phone width: the message sits just under the header', `top ${s.top}, header ends ${s.barBottom}`);
    axi('screenshot', path.join(shots, '04-phone-width.png'));
  } catch (error) {
    check(false, 'the run', error.message);
  } finally {
    server.kill('SIGTERM');
    try { axi('emulate', '--viewport', '1000x800x1'); } catch (e) { /* the page stays as it is */ }
    try { axi('open', 'about:blank'); } catch (e) { /* the page stays */ }
  }
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n${results.length - failed} passed, ${failed} failed. Screenshots: ${shots}\n`);
  process.exit(failed ? 1 : 0);
})();
