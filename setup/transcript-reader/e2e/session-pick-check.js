#!/usr/bin/env node
'use strict';

// Picking a session in the reader's picker, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own port.
// By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/session-pick-check.js <scratch folder> [screenshots folder]
//
// It builds the lab (pane_lab.py: panes of Claude, Claude under another config folder, Codex and Copilot, several with no Herdr session
// id, two in one working folder), starts that copy's server on a free port with a fake Herdr (never a real pane, never the owner's server
// or reading list) and drives a browser session of its own. For each of the four sessions the owner was choosing between it checks that the
// session shown, the browser tab's title and the message box all belong to the one picked, first on a quiet page, then while the picker's
// list is held open (what a click on a native select does) and another conversation gets a reply, so the build that arrives puts that
// conversation first and moves every one above it down by one place. Last it sends one message to the claude pane and reads what the
// fake Herdr was asked to type, and where.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const READER = path.resolve(__dirname, '..');
const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-session-pick-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION || 'reader-session-pick-check';
const results = [];
const check = (ok, what, detail = '') => { results.push({ ok: Boolean(ok), what, detail }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  ' + detail : ''}\n`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const axi = (...args) => execFileSync('chrome-devtools-axi', args, { encoding: 'utf8', timeout: 90000, env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: SESSION } });
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

// What the page shows: the browser tab's title (the open conversation's picker name), the text of the conversation, the message box, the picker.
const SHOWN = `const main = document.getElementById('main'); const dock = document.getElementById('dock');
  const sel = document.querySelector('select[name=session]');
  return { ok: true, title: document.title, main: main ? main.innerText.slice(0, 4000) : '', dock: dock && !dock.hidden ? dock.innerText : '', picked: sel ? sel.options[sel.selectedIndex].text : null };`;
const pickValue = (label) => `const sel = document.querySelector('select[name=session]'); const o = [...sel.options].find(o => o.text.endsWith(' · ${label}') || o.text === '${label}');
  if (!o) return { ok: false, options: [...sel.options].map(o => o.value + ':' + o.text) }; sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, value: o.value };`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const lab = JSON.parse(execFileSync('python3', [path.join(__dirname, 'pane_lab.py'), folder], { encoding: 'utf8', timeout: 180000 }).trim().split('\n').pop());
  const port = await freePort();
  const out = fs.openSync(path.join(folder, 'server.log'), 'a');
  const server = spawn('node', [path.join(lab.repo, 'setup', 'transcript-reader', 'server.js'), '--port', String(port), '--root', lab.repo], {
    stdio: ['ignore', out, out], env: { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH },
  });
  const page = `http://localhost:${port}/setup/transcript-reader/out/prototype.html`;
  const outDir = path.join(lab.repo, 'setup', 'transcript-reader', 'out');
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(page); if (r.ok) break; } catch (e) { /* not up yet */ } await sleep(200); }
    axi('open', 'about:blank');
    axi('emulate', '--viewport', '1000x900x1');
    axi('open', page); await sleep(1500);
    // Following Herdr's focus would move the page by itself; the checks are of picking.
    ev(`localStorage.setItem('tr-follow', '0'); return true;`);
    axi('open', 'about:blank'); axi('open', page); await until(`return { ok: / · Reader$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the page');
    await sleep(800);

    // What each of the four must show: its picker name, a word from its own conversation, and what the message box says about the target.
    const wanted = [
      { label: 'cp-ontology-learning', says: 'copilot pane', dock: /Sending to Copilot is not supported/ },
      { label: 'cp-ontology-search', says: 'search', dock: /To cp-ontology-search/ },
      { label: 'cp-whatapps-tool', says: 'tool', dock: /To cp-whatapps-tool/ },
      { label: 'fm-adjoe-wrong-trip-split-fix', says: 'codex pane', dock: /To fm-adjoe-wrong-trip-split-fix/ },
    ];
    const pickAndCheck = async (when, entry) => {
      const chosen = ev(pickValue(entry.label));
      await sleep(900);
      const s = ev(SHOWN);
      const ok = s.title.startsWith(entry.label + ' · ') && s.main.includes(entry.says) && entry.dock.test(s.dock);
      check(ok, `${when}: choosing ${entry.label} shows its conversation, its tab title and its message box`, ok ? '' : `value ${chosen.value}; tab "${s.title}"; box "${s.dock.replace(/\n/g, ' | ')}"; conversation mentions ${(s.main.match(/in (search|tool|crew-\d|the \w+ pane)/g) || []).slice(0, 2).join(', ')}`);
      return s;
    };

    // ---- 1. a quiet page
    for (const entry of wanted) await pickAndCheck('quiet page', entry);
    axi('screenshot', path.join(shots, '01-picked-search.png'));

    // ---- 2. the list held open while a build moves the sessions: the options are the ones drawn before the build.
    ev(`const sel = document.querySelector('select[name=session]'); sel.matches = () => true; window.__held = [...sel.options].map(o => o.value + ':' + o.text); return true;`);
    const crew8 = path.join(lab.home, '.claude', 'projects', '-lab-crew-8', lab.crew[7] + '.jsonl');
    const now = new Date().toISOString();
    fs.appendFileSync(crew8, [
      { type: 'user', uuid: 'u-late', timestamp: now, cwd: '/lab/crew-8', message: { role: 'user', content: 'A late question in crew-8' } },
      { type: 'assistant', timestamp: now, cwd: '/lab/crew-8', message: { role: 'assistant', content: [{ type: 'text', text: 'A late answer in crew-8.' }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
    const first = () => { try { const t = fs.readFileSync(path.join(outDir, 'prototype.html'), 'utf8'); const i = t.indexOf('id="payload"'); const j = t.indexOf('>', i) + 1; const k = t.indexOf('</script>', j); return JSON.parse(t.slice(j, k)).sessions.map((x) => (x.pane || {}).label); } catch (e) { return []; } };
    for (let i = 0; i < 80 && first()[0] !== 'crew-8'; i++) await sleep(250);
    check(first()[0] === 'crew-8', 'a reply in crew-8 puts it first in the next build, moving the others down', first().join(', '));
    await sleep(4000);  // the page takes the build
    const held = ev(`const sel = document.querySelector('select[name=session]'); return { held: window.__held, now: [...sel.options].map(o => o.value + ':' + o.text) };`);
    process.stdout.write(`      picker while held open: ${held.now.slice(0, 8).join(' | ')} ...\n`);
    for (const entry of wanted) await pickAndCheck('list held open across a build', entry);
    axi('screenshot', path.join(shots, '02-picked-after-build.png'));

    // ---- 3. the list closed again: it follows the build
    ev(`delete document.querySelector('select[name=session]').matches; return true;`);
    await sleep(1500);
    for (const entry of wanted.slice(1, 3)) await pickAndCheck('list closed again', entry);

    // ---- 4. one message to the claude pane goes to that pane's tab and to no other (fake Herdr: nothing real is typed)
    await pickAndCheck('before sending', wanted[1]);
    ev(`const box = document.getElementById('dock-text'); box.value = 'hello from the lab'; box.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await sleep(300);
    ev(`document.getElementById('dock-send').click(); return true;`);
    // Send holds the message for the Undo window first (a few seconds), then types it.
    for (let i = 0; i < 60 && !(fs.existsSync(lab.log) && /PROMPT /.test(fs.readFileSync(lab.log, 'utf8'))); i++) await sleep(500);
    const log = fs.existsSync(lab.log) ? fs.readFileSync(lab.log, 'utf8').trim().split('\n') : [];
    const prompts = log.filter((l) => l.startsWith('PROMPT '));
    check(prompts.length === 1 && prompts[0].startsWith('PROMPT esim w1:p2 '), 'Send types the message into the picked pane (cp-ontology-search, w1:p2) and nowhere else', prompts.join(' / ') || 'nothing was sent');
    const keys = log.filter((l) => l.startsWith('KEYS '));
    check(keys.length > 0 && keys.every((l) => l.startsWith('KEYS esim w1:p2 ')), 'the keys that empty the box went to that pane only', `${keys.length} calls`);
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
