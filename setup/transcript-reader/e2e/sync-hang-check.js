#!/usr/bin/env node
'use strict';

// The reader keeps syncing when a file a reply names cannot be opened (the owner's reader stood still for hours: every rebuild froze opening a
// markdown file in ~/Downloads, which macOS held behind a permission dialog nobody had answered). In a real browser (chrome-devtools-axi), against
// a lab copy of the reader on its own port with a fake Herdr (never a real pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/sync-hang-check.js <new scratch folder> [--before <git rev>]
//
// The lab's python3 is a shim (hang_shim.py) in which opening or listing anything under <home>/Downloads never returns. A new reply is written to
// two conversations: crew-2's names <home>/Downloads/Plan.md, crew-3's names nothing. The page is open as the owner has it. The check times, from
// the write, when the built page holds each reply, and when the open page shows it; both must arrive within LIMIT_MS (20 s), the one that names
// the file left out of its documents, nothing else lost.
//
// --before <rev> runs the same world on the build code of that revision (the two files this fix changed are put back as they were), which is how
// the stall was reproduced: no reply shows, the server ends each rebuild after a minute (SYNC_LIMIT_MS=90000 waits that long).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { execFileSync } = require('child_process');
const { make } = require('./axi');

const args = process.argv.slice(2);
const before = args.includes('--before') ? args[args.indexOf('--before') + 1] : null;
const folder = path.resolve(args.find((a) => !a.startsWith('--') && a !== before) || path.join(require('os').tmpdir(), 'reader-sync-hang-lab'));
const { check, axi, ev, startLab, openPage, pick, finish, sleep } = make('reader-sync-hang-check');
const LIMIT_MS = Number(process.env.SYNC_LIMIT_MS || 20000);
const iso = (at) => new Date(at).toISOString();
const uuid = () => crypto.randomUUID();
const realPython = execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();

(async () => {
  // The shim python3 sits beside the lab, first on the server's PATH; the lab's own build (pane_lab.py) runs before it and is unaffected.
  const shim = `${folder}-shim`;
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'python3'), `#!/bin/sh\nexec "${realPython}" "${path.join(__dirname, 'hang_shim.py')}" "$@"\n`, { mode: 0o755 });
  const home = path.join(folder, 'home');
  const downloads = path.join(home, 'Downloads');
  const { lab, page, stop, outDir, port } = await startLab(folder, {
    PATH: [shim, path.join(folder, 'bin'), process.env.PATH].join(path.delimiter), LAB_HANG_DIR: downloads, LAB_REAL_PYTHON: realPython,
  });
  if (before) {
    const code = path.join(lab.repo, 'setup', 'transcript-reader', 'prototype');
    const root = execFileSync('git', ['-C', __dirname, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    for (const name of ['build_prototype.py', 'build_cache.py']) {
      fs.writeFileSync(path.join(code, name), execFileSync('git', ['-C', root, 'show', `${before}:setup/transcript-reader/prototype/${name}`], { encoding: 'utf8', maxBuffer: 1 << 26 }));
    }
    process.stdout.write(`      build code of ${before}\n`);
  }
  fs.mkdirSync(downloads, { recursive: true });
  const plan = path.join(downloads, 'Plan.md');
  fs.writeFileSync(plan, '# Plan\n\nThe lab file whose folder never answers.\n');
  const built = () => {
    try {
      const t = fs.readFileSync(path.join(outDir, 'prototype.html'), 'utf8'); const i = t.indexOf('id="payload"'); const j = t.indexOf('>', i) + 1; const k = t.indexOf('</script>', j);
      return JSON.parse(t.slice(j, k));
    } catch (e) { return null; }
  };
  const has = (payload, marker) => Boolean(payload) && JSON.stringify(payload.sessions).includes(marker);
  const documentsOf = (payload, marker) => {
    const session = ((payload || {}).sessions || []).find((s) => JSON.stringify(s).includes(marker));
    return session ? Object.values(payload.documents || {}).filter((d) => d.path === plan).length : -1;
  };
  const reply = (n, text) => {
    const file = path.join(home, '.claude', 'projects', `-lab-crew-${n}`, `${lab.crew[n - 1]}.jsonl`);
    const at = Date.now();
    fs.appendFileSync(file, [
      { type: 'user', uuid: uuid(), timestamp: iso(at - 500), cwd: `/lab/crew-${n}`, message: { role: 'user', content: 'What is the state now?' } },
      { type: 'assistant', uuid: uuid(), timestamp: iso(at), cwd: `/lab/crew-${n}`, message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
  };

  // Plain http, not fetch: Node's fetch sends Fetch-Metadata that marks it as a script, which the page route refuses (it is for a tab).
  const get = (url, headers = {}) => new Promise((resolve, reject) => http.get(url, { headers }, (res) => { let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve(text)); }).on('error', reject));
  const serverBuild = async () => {
    const token = (await get(page)).match(/name="reader-token" content="([0-9a-f]{64})"/)[1];
    return JSON.parse(await get(`http://localhost:${port}/api/transcript-reader/state`, { 'x-transcript-reader-token': token })).build;
  };

  try {
    await openPage(page);
    pick('crew-2'); await sleep(600);
    const t0 = Date.now();
    reply(2, `HANGMARK-TWO: the plan is in \`${plan}\`.`);
    reply(3, 'HANGMARK-THREE: nothing here names a file.');
    const times = {};
    const end = t0 + LIMIT_MS;
    while (Date.now() < end && !(times.twoBuilt && times.threeBuilt && times.twoScreen)) {
      const payload = built();
      if (!times.twoBuilt && has(payload, 'HANGMARK-TWO')) times.twoBuilt = Date.now() - t0;
      if (!times.threeBuilt && has(payload, 'HANGMARK-THREE')) times.threeBuilt = Date.now() - t0;
      if (times.twoBuilt && !times.twoScreen) {
        try { if (ev(`return document.body.innerText.includes('HANGMARK-TWO');`)) times.twoScreen = Date.now() - t0; } catch (e) { /* the page is drawing */ }
      }
      await sleep(250);
    }
    process.stdout.write(`      ${JSON.stringify(times)}; the server says: ${JSON.stringify(await serverBuild())}\n`);
    check(times.twoBuilt !== undefined, `the reply that names the file in the stuck folder is built within ${LIMIT_MS / 1000} s`, `${times.twoBuilt} ms`);
    check(times.threeBuilt !== undefined, `a reply in another conversation is built within ${LIMIT_MS / 1000} s`, `${times.threeBuilt} ms`);
    check(times.twoScreen !== undefined, 'the open page shows the reply', `${times.twoScreen} ms`);
    check(documentsOf(built(), 'HANGMARK-TWO') === 0, 'the file that did not answer is left out of the documents, the rest of the page is there', String(documentsOf(built(), 'HANGMARK-TWO')));
    try { axi('screenshot', path.join(folder, 'sync-hang.png')); } catch (e) { /* no page */ }
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
