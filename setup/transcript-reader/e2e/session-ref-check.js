#!/usr/bin/env node
'use strict';

// A reply's mentions of other sessions as links, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own port.
// By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/session-ref-check.js <scratch folder> [screenshots folder]
//
// It builds the lab (pane_lab.py with LAB_REFS=1: crew-1's latest reply names tabs of the lab's Herdr, a session id, and things that must stay
// text), starts that copy's server on a free port with a fake Herdr (never a real pane, never the owner's server) and drives a browser session of
// its own. On the full reader page and on the lite page (out/live/index.html) it checks that:
//   - exactly the references the reader lists are links, each a.session-ref[data-session] holding the right conversation's id, with the page's own
//     #s=<id> as the href; a tab it does not list, the conversation's own name, a command, a path, a file name and a longer name stay text;
//   - a click opens that conversation in the normal reading view (tab title, text, message box), the address becomes its #s=, and browser Back
//     returns to the conversation left, scrolled to where it was.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-session-ref-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION || 'reader-session-ref-check';
const results = [];
const check = (ok, what, detail = '') => { results.push({ ok: Boolean(ok), what, detail }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  ' + detail : ''}\n`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const axi = (...args) => {
  try { return execFileSync('chrome-devtools-axi', args, { encoding: 'utf8', timeout: 90000, env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: SESSION } }); }
  catch (error) { throw new Error(`chrome-devtools-axi ${args.slice(0, 2).join(' ')}: ${String(error.stdout || error.stderr || error.message).trim().slice(0, 300)}`); }
};
function ev(expression) {
  const line = axi('eval', `JSON.stringify((() => { ${expression} })())`).split('\n').find((l) => l.startsWith('result: '));
  if (!line) throw new Error('no result for: ' + expression);
  let value = JSON.parse(line.slice('result: '.length));
  while (typeof value === 'string') { try { value = JSON.parse(value); } catch (e) { break; } }
  return value;
}
async function until(expression, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = ev(expression); if (last && (typeof last !== 'object' || last.ok !== false)) return last; } catch (e) { last = e.message; }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

const LINKS = `const links = [...document.querySelectorAll('#main a.session-ref')];
  return { ok: links.length > 0, links: links.map(a => ({ text: a.textContent, session: a.dataset.session, href: a.getAttribute('href'), inCode: Boolean(a.querySelector('code')) })) };`;
const SHOWN = `const main = document.getElementById('main'); const dock = document.getElementById('dock');
  return { ok: true, title: document.title, hash: location.hash, main: main ? main.innerText.slice(0, 6000) : '', dock: dock && !dock.hidden ? dock.innerText : '', y: Math.round(scrollY) };`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const lab = JSON.parse(execFileSync('python3', [path.join(__dirname, 'pane_lab.py'), folder], { encoding: 'utf8', timeout: 180000, env: { ...process.env, LAB_REFS: '1', LAB_BIG_EXCHANGES: '14' } }).trim().split('\n').pop());
  const port = await freePort();
  const out = fs.openSync(path.join(folder, 'server.log'), 'a');
  const server = spawn('node', [path.join(lab.repo, 'setup', 'transcript-reader', 'server.js'), '--port', String(port), '--root', lab.repo], {
    stdio: ['ignore', out, out], env: { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH },
  });
  const base = `http://localhost:${port}/setup/transcript-reader/out/`;
  const [SEARCH, CODEX, CREW1, CREW3] = [lab.search, lab.codex, lab.crew[0], lab.crew[2]];
  const wanted = [['cp-ontology-search', SEARCH], ['fm-adjoe-wrong-trip-split-fix', CODEX], ['crew-3', CREW3], [CREW3, CREW3]];
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(base + 'prototype.html'); if (r.ok) break; } catch (e) { /* not up yet */ } await sleep(200); }
    axi('open', 'about:blank');
    axi('emulate', '--viewport', '1000x800x1');

    for (const [name, file, titleRe] of [['full page', 'prototype.html', / · Reader$/], ['lite page', 'live/index.html', / · Reader$/]]) {
      axi('open', 'about:blank');
      axi('open', base + file); await sleep(1200);
      ev(`localStorage.setItem('tr-follow', '0'); localStorage.setItem('tr-live-follow', '0'); return true;`);
      axi('open', 'about:blank');
      axi('open', `${base}${file}#s=${CREW1}`);
      await until(`return { ok: / · Reader$/.test(document.title) && document.querySelectorAll('#main a.session-ref').length > 0 && document.title.startsWith('crew-1 · ') };`, `${name}: crew-1 with its links`);
      await sleep(600);
      const got = ev(LINKS);
      const asked = got.links.map((l) => [l.text, l.session]);
      check(JSON.stringify(asked) === JSON.stringify(wanted), `${name}: exactly the four references the reader lists are links, each to its own conversation`, JSON.stringify(asked));
      check(got.links.every((l) => l.href === `#s=${l.session}`), `${name}: each href is the page's own #s=<session id>`, got.links.map((l) => l.href).join(' '));
      check(got.links.find((l) => l.text === 'fm-adjoe-wrong-trip-split-fix').inCode, `${name}: a label in a code span keeps its code look inside the link`);
      const text = ev(`const out = {}; for (const word of ['herdr pane list cp-whatapps-tool', 'fm-no-such-tab-anywhere', '/lab/crew-3/notes.md', 'crew-3.md', 'cp-ontology-search-two']) { const el = [...document.querySelectorAll('#main .md *')].filter(e => e.textContent.includes(word)).pop(); out[word] = el ? Boolean(el.closest('a.session-ref') || el.querySelector('a.session-ref')) : null; } return out;`);
      check(Object.values(text).every((linked) => linked === false), `${name}: a command, an unlisted tab, a path, a file name and a longer name stay text`, JSON.stringify(text));
      axi('screenshot', path.join(shots, `${name.replace(' ', '-')}-1-links.png`));

      // A click opens that conversation in the normal reading view.
      // Scrolled up from the latest reply, to a place the reader would not go back to by itself (it opens on the latest reply).
      const latestY = ev(`return document.documentElement.scrollHeight - innerHeight;`);
      ev(`window.scrollTo(0, 1800); return true;`); await sleep(400);
      const before = ev(SHOWN);
      check(latestY > 2500 && Math.abs(before.y - 1800) <= 5, `${name}: the reader is scrolled up from the latest reply, so Back has a place of its own to return to`, `latest at ${latestY}, now ${before.y}`);
      ev(`[...document.querySelectorAll('#main a.session-ref')].find(a => a.textContent === 'cp-ontology-search').click(); return true;`);
      const opened = await until(`return { ok: document.title.startsWith('cp-ontology-search · ') && /search/.test(document.getElementById('main').innerText) };`, `${name}: the picked conversation`).catch((e) => ({ ok: false, error: e.message }));
      const shown = ev(SHOWN);
      check(opened.ok !== false && titleRe.test(shown.title) && shown.hash === `#s=${SEARCH.slice(0, 8)}`, `${name}: a click opens cp-ontology-search in the normal reading view, address #s=`, `title "${shown.title}" hash ${shown.hash}`);
      check(/To cp-ontology-search/.test(shown.dock), `${name}: its message box is that conversation's`, shown.dock.replace(/\n/g, ' | ').slice(0, 120));
      axi('screenshot', path.join(shots, `${name.replace(' ', '-')}-2-opened.png`));

      // Back returns to where the reader was.
      ev(`history.back(); return true;`);
      await until(`return { ok: document.title.startsWith('crew-1 · ') && document.querySelectorAll('#main a.session-ref').length > 0 };`, `${name}: back on crew-1`);
      await sleep(900);
      const back = ev(SHOWN);
      check(back.hash === `#s=${CREW1.slice(0, 8)}` && /^crew-1 · /.test(back.title) && Math.abs(back.y - before.y) <= 40, `${name}: Back returns to crew-1, scrolled to where it was`, `was ${before.y}, now ${back.y}, hash ${back.hash}`);

      // The same click twice in a row works (the link is not used up) and Back/Forward move between the two.
      ev(`[...document.querySelectorAll('#main a.session-ref')].find(a => a.textContent === 'fm-adjoe-wrong-trip-split-fix').click(); return true;`);
      await until(`return { ok: document.title.startsWith('fm-adjoe-wrong-trip-split-fix · ') };`, `${name}: the codex conversation`);
      ev(`history.back(); return true;`);
      await until(`return { ok: document.title.startsWith('crew-1 · ') };`, `${name}: back again`);
      check(true, `${name}: a second link opens its conversation and Back returns again`);
    }
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  } finally {
    server.kill();
    for (const pid of Object.values(lab.pids)) { try { process.kill(pid); } catch (e) { /* gone */ } }
    try { axi('stop'); } catch (e) { /* not running */ }
  }
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
  process.exit(failed.length ? 1 : 0);
})();
