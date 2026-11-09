#!/usr/bin/env node
'use strict';

// A reply card names its turn (README.md, "A reply card names its turn"), in a real browser (chrome-devtools-axi, headless), against a lab copy of
// the reader on its own port. By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/reply-turn-check.js <scratch folder> [screenshots folder]
//
// It builds the lab (pane_lab.py), starts that copy's server on a free port with a fake Herdr (never a real pane, never the owner's server) and
// drives a browser session of its own. On the full reader page and on the lite page (out/live/index.html) it checks that:
//   - every reply card in the conversation has data-turn="<turn id>", an id that is not empty and not repeated;
//   - data-msg is as it was: "<turn id>:reply", so data-turn is exactly data-msg without ":reply";
//   - the last reply card in the page is the conversation's latest turn, found the way a host does it (the last .reply[data-turn]);
//   - an input block (the captain's message) has no data-turn: it names replies only;
//   - a fresh load of the same conversation names the same turns.
// The embed page's half is in e2e/embed-check.js (section 1).

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-reply-turn-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION || 'reader-reply-turn-check';
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

// What a host sees: every reply card's data-turn and data-msg, in page order, and the inputs' attributes.
const CARDS = `const cards = [...document.querySelectorAll('#main .reply')];
  const inputs = [...document.querySelectorAll('#main .input')];
  const last = [...document.querySelectorAll('#main .reply[data-turn]')].pop();
  return { ok: cards.length > 0, cards: cards.map(c => ({ turn: c.dataset.turn || '', msg: c.dataset.msg || '' })),
    inputsWithTurn: inputs.filter(i => i.hasAttribute('data-turn')).length, inputs: inputs.length,
    lastTurn: last ? last.dataset.turn : '', lastCardIsLastReply: last ? cards[cards.length - 1] === last : false };`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const lab = JSON.parse(execFileSync('python3', [path.join(__dirname, 'pane_lab.py'), folder], { encoding: 'utf8', timeout: 180000, env: { ...process.env, LAB_BIG_EXCHANGES: '14' } }).trim().split('\n').pop());
  const port = await freePort();
  const out = fs.openSync(path.join(folder, 'server.log'), 'a');
  const server = spawn('node', [path.join(lab.repo, 'setup', 'transcript-reader', 'server.js'), '--port', String(port), '--root', lab.repo], {
    stdio: ['ignore', out, out], env: { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH },
  });
  const base = `http://localhost:${port}/setup/transcript-reader/out/`;
  const CREW1 = lab.crew[0];
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(base + 'prototype.html'); if (r.ok) break; } catch (e) { /* not up yet */ } await sleep(200); }
    axi('open', 'about:blank');
    axi('emulate', '--viewport', '1000x800x1');

    for (const [name, file] of [['full page', 'prototype.html'], ['lite page', 'live/index.html']]) {
      axi('open', 'about:blank');
      axi('open', base + file); await sleep(1200);
      ev(`localStorage.setItem('tr-follow', '0'); localStorage.setItem('tr-live-follow', '0'); return true;`);
      axi('open', 'about:blank');
      axi('open', `${base}${file}#s=${CREW1}`);
      await until(`return { ok: document.title.startsWith('crew-1 · ') && document.querySelectorAll('#main .reply').length > 3 };`, `${name}: crew-1 with its replies`);
      await sleep(600);
      const got = ev(CARDS);
      const turns = got.cards.map((c) => c.turn);
      check(got.cards.length > 3 && turns.every((t) => t.length > 0), `${name}: every reply card has a data-turn`, `${got.cards.length} cards, ${turns.filter((t) => !t).length} without`);
      check(new Set(turns).size === turns.length, `${name}: no turn id is repeated`);
      check(got.cards.every((c) => c.msg === `${c.turn}:reply`), `${name}: data-msg is as it was, "<turn id>:reply", so data-turn is data-msg without ":reply"`, got.cards.slice(0, 2).map((c) => `${c.turn}|${c.msg}`).join(' '));
      check(got.inputs > 0 && got.inputsWithTurn === 0, `${name}: the captain's messages carry no data-turn (replies only)`, `${got.inputs} inputs, ${got.inputsWithTurn} with`);
      check(got.lastCardIsLastReply && got.lastTurn === turns[turns.length - 1], `${name}: the last .reply[data-turn] is the latest reply, which is how a host finds the one to land on`, got.lastTurn);
      axi('screenshot', path.join(shots, `${name.replace(' ', '-')}-1.png`));

      // A fresh load of the same conversation draws the same names.
      axi('open', 'about:blank');
      axi('open', `${base}${file}#s=${CREW1}`);
      await until(`return { ok: document.title.startsWith('crew-1 · ') && document.querySelectorAll('#main .reply').length > 3 };`, `${name}: crew-1 again`);
      const again = ev(CARDS);
      check(JSON.stringify(again.cards) === JSON.stringify(got.cards), `${name}: a fresh load of the same conversation names the same turns`);
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
