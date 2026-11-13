#!/usr/bin/env node
'use strict';

// "Clear all" on a batch of comments in the message bar, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its
// own port. By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/batch-clear-check.js <scratch folder> [screenshots folder]
//
// It builds the lab (pane_lab.py, fake Herdr), adds three comments to a batch and presses Clear all with real clicks. The button used to ask
// with a native confirm(), which a browser that shows no dialog answers "no", so it did nothing. The check is that no dialog opens (a dialog
// would stop the click with an error here), that the first press only arms the button, that Keep and the timeout put it back, and that
// the second press removes the batch, with the batch kept per conversation.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const READER = path.resolve(__dirname, '..');
const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-batch-clear-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION || 'reader-batch-clear-check';
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


// A real click on the element with this accessible name (a dialog the click opens would be an error here).
function click(name) {
  for (let attempt = 1; ; attempt++) {
    const line = axi('snapshot').split('\n').find((l) => l.includes(`button "${name}"`));
    if (!line) throw new Error(`no button "${name}"`);
    try { axi('click', '@' + line.match(/uid=(\S+)/)[1]); return; } catch (error) { if (attempt >= 4 || !/STALE_REF/.test(error.message)) throw error; }  // the page drew itself again between the two calls
  }
}
const DOCK = `const all = Object.keys(localStorage).filter((k) => /^tr-batch:/.test(k)).flatMap((k) => JSON.parse(localStorage.getItem(k)).items);
  return { ok: true, n: all.length, shown: !document.getElementById('dock-batch').hidden, clear: document.getElementById('dock-batch-clear').textContent, keep: !document.getElementById('dock-batch-keep').hidden };`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const lab = JSON.parse(execFileSync('python3', [path.join(__dirname, 'pane_lab.py'), folder], { encoding: 'utf8', timeout: 180000 }).trim().split('\n').pop());
  const port = await freePort();
  const out = fs.openSync(path.join(folder, 'server.log'), 'a');
  const server = spawn('node', [path.join(lab.repo, 'setup', 'transcript-reader', 'server.js'), '--port', String(port), '--root', lab.repo], {
    stdio: ['ignore', out, out], env: { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH },
  });
  const page = `http://localhost:${port}/setup/transcript-reader/out/prototype.html`;
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(page); if (r.ok) break; } catch (e) { /* not up yet */ } await sleep(200); }
    axi('open', 'about:blank');
    axi('emulate', '--viewport', '1000x900x1');
    axi('open', page); await sleep(1500);
    ev(`localStorage.setItem('tr-follow', '0'); return true;`);
    axi('open', 'about:blank'); axi('open', page); await until(`return { ok: / · Reader$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the page');
    await sleep(800);
    const pick = (label) => ev(`const sel = document.querySelector('select[name=session]'); const o = [...sel.options].find(o => o.text.endsWith('${label}')); sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    const add = (words) => ev(`const t = document.getElementById('dock-text'); for (const w of ${JSON.stringify(words)}) { t.value = w; t.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('dock-add').click(); } return true;`);
    pick('cp-ontology-search'); await sleep(600);
    add(['first comment', 'second comment', 'a third, longer comment that wraps]']);
    let s = ev(DOCK);
    check(s.shown && s.n === 3 && s.clear === 'Clear all' && !s.keep, 'three comments are in the batch', JSON.stringify(s));

    // a first press arms it: nothing is removed, no dialog opens
    click('Clear all'); await sleep(300);
    s = ev(DOCK);
    check(s.n === 3 && s.clear === 'Remove all 3?' && s.keep, 'the first press asks in the page (no dialog) and removes nothing', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'batch-clear-armed.png'));
    // Keep puts it back
    click('Keep'); await sleep(300);
    s = ev(DOCK);
    check(s.n === 3 && s.clear === 'Clear all' && !s.keep, 'Keep puts the button back and keeps the batch', JSON.stringify(s));
    // a question left alone is withdrawn
    click('Clear all'); await sleep(7000);
    s = ev(DOCK);
    check(s.n === 3 && s.clear === 'Clear all' && !s.keep, 'a question nobody answers is withdrawn after a few seconds', JSON.stringify(s));
    // another conversation's batch is its own
    click('Clear all'); await sleep(200);
    pick('cp-whatapps-tool'); await sleep(600);
    s = ev(DOCK);
    check(!s.shown && s.n === 3, 'another conversation shows no batch and does not inherit the question', JSON.stringify(s));
    add(['one for the tool pane']); await sleep(300);
    s = ev(DOCK);
    check(s.shown && s.clear === 'Clear all' && !s.keep, 'its own batch starts with the button as it was', JSON.stringify(s));
    pick('cp-ontology-search'); await sleep(600);
    // the second press removes that conversation's batch only
    click('Clear all'); await sleep(200); click('Remove all 3?'); await sleep(400);
    s = ev(DOCK);
    check(s.n === 1, 'the second press removes the three comments of this conversation and leaves the other conversation\'s one', JSON.stringify(s));
    check(!s.shown, 'and the batch bar goes away', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'batch-clear-done.png'));
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
