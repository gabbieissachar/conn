'use strict';

// Shared helpers of the browser checks in this folder (chrome-devtools-axi, a browser session of its own, a lab copy of the reader on a
// free port started with pane_lab.py). Not a test: required by the *-check.js drivers.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function make(sessionName) {
  const SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION || sessionName;
  const results = [];
  const check = (ok, what, detail = '') => { results.push({ ok: Boolean(ok), what, detail }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  ' + detail : ''}\n`); };
  const axi = (...args) => {
    try { return execFileSync('chrome-devtools-axi', args, { encoding: 'utf8', timeout: 90000, env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: SESSION } }); }
    catch (error) { throw new Error(`chrome-devtools-axi ${args.slice(0, 2).join(' ')}: ${String(error.stdout || error.stderr || error.message).trim().slice(0, 300)}`); }
  };
  // What the page's expression answered: the tool prints it as a JSON string, once or twice over.
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
  // A real click on the control with this accessible name (a native dialog it opened would be an error here).
  function click(role, name) {
    for (let attempt = 1; ; attempt++) {
      const line = axi('snapshot').split('\n').find((l) => l.includes(`${role} "${name}"`));
      if (!line) throw new Error(`no ${role} "${name}"`);
      try { axi('click', '@' + line.match(/uid=(\S+)/)[1]); return; } catch (error) { if (attempt >= 4 || !/STALE_REF/.test(error.message)) throw error; }  // the page drew itself again between the two calls
    }
  }
  // The lab: built by pane_lab.py into <folder>, its server started on a free port with a fake Herdr first on PATH.
  async function startLab(folder, extraEnv = {}) {
    const lab = JSON.parse(execFileSync('python3', [path.join(__dirname, 'pane_lab.py'), folder], { encoding: 'utf8', timeout: 180000 }).trim().split('\n').pop());
    const port = await freePort();
    const out = fs.openSync(path.join(folder, 'server.log'), 'a');
    const server = spawn('node', [path.join(lab.repo, 'setup', 'transcript-reader', 'server.js'), '--port', String(port), '--root', lab.repo], {
      stdio: ['ignore', out, out], env: { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH, ...extraEnv },
    });
    const page = `http://localhost:${port}/setup/transcript-reader/out/prototype.html`;
    for (let i = 0; i < 50; i++) { try { const r = await fetch(page); if (r.ok) break; } catch (e) { /* not up yet */ } await sleep(200); }
    const stop = () => {
      server.kill();
      for (const pid of Object.values(lab.pids)) { try { process.kill(pid); } catch (e) { /* gone */ } }
      try { axi('stop'); } catch (e) { /* not running */ }
    };
    return { lab, port, page, server, stop, outDir: path.join(lab.repo, 'setup', 'transcript-reader', 'out') };
  }
  // Opens the page with Follow off (it would move the page to the pane Herdr focuses by itself) and waits until it is drawn.
  async function openPage(page, viewport = '1000x900x1') {
    axi('open', 'about:blank');
    axi('emulate', '--viewport', viewport);
    axi('open', page); await sleep(1500);
    ev(`localStorage.setItem('tr-follow', '0'); return true;`);
    axi('open', 'about:blank'); axi('open', page);
    await until(`return { ok: / · Reader$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the page');
    await sleep(800);
  }
  const pick = (label) => ev(`const sel = document.querySelector('select[name=session]'); const o = [...sel.options].find(o => o.text.endsWith('${label}')); sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  const finish = (stop) => {
    stop();
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
    process.exit(failed.length ? 1 : 0);
  };
  return { SESSION, results, check, axi, ev, until, click, startLab, openPage, pick, finish, sleep };
}

module.exports = { make, sleep, freePort };
