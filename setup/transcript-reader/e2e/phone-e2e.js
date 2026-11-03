#!/usr/bin/env node
'use strict';

// The offline copy on a phone, end to end, in WebKit with the iPhone profile (Playwright). By hand, not part of `node --test`
// (it needs Playwright and its WebKit, which the repo does not carry):
//
//   PLAYWRIGHT_PATH=<folder with node_modules/playwright> node setup/transcript-reader/e2e/phone-e2e.js <run folder> [screenshots folder]
//
// It builds a made-up world (fixture.py: synthetic session logs under a scratch HOME, an HTML sketch with a stylesheet, a script and a
// picture beside it, one of the owner's own sessions under ~/workspace) and seals it with a scratch passphrase; starts this copy's
// reader server on spare ports with a scratch passcode and a scratch self-signed TLS certificate for "localhost" (the real Tailscale
// certificate cannot be issued until HTTPS certificates are on, and this run never asks Tailscale for anything); then drives the phone:
//
//   sign in over HTTPS, open the sealed copy, enter the passphrase, Download everything now, read a conversation, a markdown document
//   and the HTML sketch in its sandbox, stop the server, reload and read all of it again from the phone, queue a Send, start the server
//   again, see the Send reach the queue, let the sync's drain carry it out to the fake Herdr once, see the receipt, and Forget this device.
//
// Herdr is a fake that records what would have been typed. Nothing is sent to a real pane, and no real session log, passcode,
// passphrase or certificate is read or written.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PLAYWRIGHT = process.env.PLAYWRIGHT_PATH || '/Users/nguyen.tran/.treehouse/firstmate-8bf1b0/2/firstmate/data/reader-signin-errors/pw';
const { webkit, devices } = require(path.join(PLAYWRIGHT, 'node_modules', 'playwright'));
const READER = path.resolve(__dirname, '..');
const { writePasscodeFile } = require(path.join(READER, 'tailnet'));

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-phone-e2e'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const PASSCODE = 'scratch passcode 1234';
const PASSPHRASE = 'scratch passphrase for the e2e';
const results = [];
const check = (ok, what, detail = '') => { results.push({ ok: Boolean(ok), what, detail }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  ' + detail : ''}\n`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let looking = null;  // the page, for the picture taken when a wait runs out
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(150);
  }
  if (looking) {
    await looking.screenshot({ path: path.join(shots, '99-stuck.png') }).catch(() => {});
    process.stdout.write(`stuck at: ${what}\nurl: ${looking.url()}\nmain: ${await looking.locator('#main').innerText({ timeout: 2000 }).then((t) => t.slice(-400), () => 'unreadable')}\n`);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`);
}

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  // ------------------------------------------------------------------ the world and the server
  const world = JSON.parse(execFileSync('python3', [path.join(__dirname, 'fixture.py'), folder, PASSPHRASE], { encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop());
  fs.mkdirSync(path.join(folder, 'cert'), { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(folder, 'cert', 'key.pem'), '-out', path.join(folder, 'cert', 'cert.pem'), '-days', '3', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  fs.chmodSync(path.join(folder, 'cert', 'key.pem'), 0o600);
  await writePasscodeFile(path.join(folder, 'passcode.json'), PASSCODE);
  const [port, plain, secure] = [await freePort(), await freePort(), await freePort()];
  let server = null;
  const startServer = () => new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, 'serve.js'), folder, String(port), String(plain), String(secure), 'localhost'], { env: { ...process.env, FAKE_HERDR_SESSION: world.main }, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (chunk) => { if (String(chunk).startsWith('READY')) { server = child; resolve(JSON.parse(String(chunk).slice(6))); } });
    child.on('exit', (code) => { if (server === child) server = null; reject(new Error('server exited ' + code)); });
  });
  const stopServer = async () => { const child = server; server = null; if (child) { child.kill('SIGTERM'); await sleep(500); } };
  const ready = await startServer();
  check(ready.tailnet && ready.tailnet.https && ready.tailnet.https.host === 'localhost', 'the reader serves a TLS listener beside the plain one', JSON.stringify(ready.tailnet));
  const base = `https://localhost:${secure}`;
  const shell = `${base}/setup/transcript-reader/out/bucket/index.html`;

  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices['iPhone 15'], ignoreHTTPSErrors: true, proxy: { server: 'http://127.0.0.1:9', bypass: 'localhost,127.0.0.1' } });
  const page = await context.newPage();
  const problems = [];
  looking = page;
  page.on('pageerror', (error) => problems.push('pageerror: ' + error.message));
  // Errors the run causes on purpose are not problems: the first sign-in page is a 401, the stopped server cannot be reached, and the
  // sketch tries the network to show its policy blocks it. Playwright's own screenshot puts a stylesheet into the page (to hide the caret),
  // which a page whose policy allows only its own hashed styles refuses once per picture: that line is the tool's, not the page's.
  const expected = /Refused to apply a stylesheet|status of 401|Could not connect to the server|example\.com|Load failed|cancelled|\/api\/transcript-reader\/queue|\/bucket\/r\//;  // the queue's 403 is the restarted server's new token, a receipt's 404 is "not written yet"
  page.on('console', (message) => { if (message.type() === 'error' && !expected.test(message.text() + ' ' + message.location().url)) problems.push(`console after "${(results[results.length - 1] || {}).what}": ${message.text()} (${message.location().url.replace(/^https:\/\/localhost:\d+/, '')}:${message.location().lineNumber}:${message.location().columnNumber}) in a page whose style-src is ${page.url().slice(-30)}`); });
  page.on('dialog', (dialog) => dialog.accept());
  const traffic = [];
  page.on('response', (response) => { if (/queue|signin|\/r\//.test(response.url())) traffic.push(`${response.status()} ${response.request().method()} ${response.url().replace(base, '')}`); });
  page.on('requestfailed', (request) => traffic.push(`FAILED ${request.method()} ${request.url().replace(base, '')} ${request.failure() && request.failure().errorText}`));
  const shot = async (name) => { await page.screenshot({ path: path.join(shots, name + '.png') }); };
  const text = (selector) => page.locator(selector).first().innerText();

  // ------------------------------------------------------------------ the passcode gate over HTTPS
  const probe = await context.request.get(`${base}/api/transcript-reader/state`);
  check(probe.status() === 401, 'the API over HTTPS answers 401 with no sign-in');
  await page.goto(shell);
  check((await page.title()) === 'Transcript reader' && (await page.locator('#p').count()) === 1, 'the sealed copy over HTTPS shows the passcode page first');
  await shot('01-passcode');
  await page.fill('#p', 'wrong one here');
  await page.click('#b');
  await until(async () => /Wrong passcode/.test(await text('#m')), 'the wrong-passcode message');
  await page.fill('#p', PASSCODE);
  await page.click('#b');
  await until(async () => (await page.locator('.unlock').count()) === 1, 'the passphrase card after signing in');
  const cookies = await context.cookies();
  check(cookies.some((cookie) => cookie.name === 'pmos_session' && cookie.secure && cookie.httpOnly), 'the session cookie is Secure and HttpOnly');
  const plainGate = await (await context.request.get(`http://127.0.0.1:${plain}/`, { headers: { 'Sec-Fetch-Mode': 'navigate' } })).status();
  check(plainGate === 401, 'the plain http address keeps working and still asks for the passcode', 'HTTP ' + plainGate);

  // ------------------------------------------------------------------ passphrase, conversation, download
  await shot('02-passphrase');
  await page.fill('.unlock input[type=password]', PASSPHRASE);
  await page.click('.unlock .row button');
  await until(async () => /Tidy the scratch folder/.test(await text('#main')), 'the conversation');
  check(true, 'the passphrase opens the sealed copy, including the starred closed conversation');
  await until(() => page.evaluate(() => navigator.serviceWorker.controller !== null), 'the worker to control the page');
  check(true, 'the service worker is installed and controls the page');
  const picker = await page.evaluate(() => {
    const select = document.querySelector('select[name=session], #crumb-session');
    return { groups: [...select.querySelectorAll('optgroup')].map((g) => g.label), options: [...select.options].map((o) => o.textContent) };
  });
  check(picker.groups.includes('Starred · 2') && picker.options.filter((label) => /★ /.test(label)).length === 2 && picker.options.some((label) => /Your own sessions/.test(label)) && picker.options.some((label) => /Idle at last sync/.test(label)), 'the picker carries live and starred sessions with historical live wording', JSON.stringify(picker));
  await shot('03-conversation');
  // Switch to the main home's conversation, which names the documents.
  const switchTo = (label) => until(() => page.evaluate((wanted) => {
    const select = [...document.querySelectorAll('select[name=session], #crumb-session')].find((x) => [...x.options].some((o) => o.textContent.includes(wanted)));
    if (!select) return false;
    select.value = [...select.options].find((o) => o.textContent.includes(wanted)).value;
    select.dispatchEvent(new Event('change'));
    return true;
  }, label), 'the ' + label + ' conversation in the picker');
  await switchTo('alpha');
  await until(async () => /Drafted the notes/.test(await text('#main')), 'the main conversation');
  check(true, 'the picker switches to the main home\'s conversation');
  await page.click('#bar-toggle');
  const before = await text('#offline-text');
  const offlineUi = await page.evaluate(() => {
    const box = document.querySelector('#offline'), button = document.querySelector('#offline-download');
    return { boxHidden: box.hidden, buttonHidden: button.hidden, display: getComputedStyle(button).display, visibility: getComputedStyle(button).visibility };
  });
  check(/items are on this device/.test(before) && (await page.locator('#offline-download').isVisible()), 'the page offers Download everything now and says what is stored', JSON.stringify({ before, ...offlineUi }));
  const downloading = page.click('#offline-download');
  await downloading;
  await until(async () => /^Done:/.test(await text('#offline-text')), 'the download to finish');
  const done = await text('#offline-text');
  check(/Done: \d+ downloaded/.test(done) && /(KB|MB) is stored on this device/.test(done), 'Download everything now finishes with the count and the stored size', done);
  await shot('04-downloaded');
  const stored = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('hosted-reader'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const count = (store) => new Promise((resolve) => { const r = db.transaction(store).objectStore(store).count(); r.onsuccess = () => resolve(r.result); });
    const names = await new Promise((resolve) => { const r = db.transaction('objects').objectStore('objects').getAllKeys(); r.onsuccess = () => resolve(r.result); });
    return { objects: await count('objects'), names, keys: await count('keys'), cache: (await caches.keys()).join() };
  });
  check(stored.objects === 5 && stored.keys === 1 && /reader-shell/.test(stored.cache), 'the device holds the 5 sealed objects (the live and starred conversations, the markdown file, the sketch and the picture), the key and the shell cache', JSON.stringify(stored));

  // ------------------------------------------------------------------ documents: markdown and the HTML sketch, online
  // On a phone the Documents tab opens the session's file list (one page at a time); the header's document picker, which takes the
  // place of the session picker on this view, then opens a file.
  const openDocuments = async () => { await page.click('#tab-doc'); await until(async () => (await page.locator('#main .docshell.view-list .ghead, #main .docshell.view-list .frow').count()) > 0, 'the file list'); };
  const pickDocument = async (name) => {
    await until(() => page.evaluate((wanted) => { const s = [...document.querySelectorAll('#controls select')].find((x) => [...x.options].some((o) => o.textContent.startsWith(wanted))); if (!s) return false; s.value = [...s.options].find((o) => o.textContent.startsWith(wanted)).value; s.dispatchEvent(new Event('change')); return true; }, name), 'the ' + name + ' entry');
  };
  const sketch = async () => {
    const frameHandle = await until(async () => page.frames().find((f) => f !== page.mainFrame() && /\/view\/[0-9a-f]{32}\//.test(f.url())), 'the sketch frame');
    await until(async () => /Network check: (blocked|LEAKED)/.test(await frameHandle.evaluate(() => document.getElementById('net') && document.getElementById('net').textContent).catch(() => '')), 'the sketch to finish its network check');
    return frameHandle.evaluate(() => ({
      origin: String(origin), script: document.getElementById('out').textContent, net: document.getElementById('net').textContent,
      style: getComputedStyle(document.querySelector('h1')).color, pic: document.getElementById('pic').naturalWidth,
      background: getComputedStyle(document.body).backgroundImage.slice(0, 22),
      parent: (() => { try { void parent.document.title; return 'READ'; } catch (e) { return 'blocked'; } })(),
      storage: (() => { try { localStorage.setItem('x', '1'); return 'allowed'; } catch (e) { return 'blocked'; } })(),
      cookie: (() => { try { return 'read ' + document.cookie.length; } catch (e) { return 'blocked'; } })(),
    }));
  };
  const frameSandbox = () => page.evaluate(() => { const f = document.querySelector('.htmlframe iframe'); return f ? { attribute: f.getAttribute('sandbox'), src: f.getAttribute('src') } : null; });
  await openDocuments();
  check(await page.locator('#main .docshell.view-list .docpane > *').count() === 0 && /^\d+ files in \d+ groups?/.test(await text('#main .fp-count')), 'Documents opens on the file list, with no file drawn yet', await text('#main .fp-count'));
  await pickDocument('notes.md');
  await until(async () => /Release notes|Plan/.test(await text('#main')), 'the markdown document');
  check(await page.locator('#main table').count() === 1, 'the markdown document is drawn, table included');
  await shot('05-markdown');
  await pickDocument('sketch.html');
  const online = await sketch();
  check(online.script.startsWith('The sketch ran its own script.') && online.origin === 'null', 'the sketch\'s own script runs, in an opaque origin', JSON.stringify(online));
  check(online.style === 'rgb(180, 35, 45)' && online.pic === 48 && online.background.startsWith('url("data:image'), 'the stylesheet and the picture beside it loaded', `${online.style} ${online.pic}px ${online.background}`);
  check(online.net === 'Network check: blocked', 'the sketch has no network', online.net);
  check(online.parent === 'blocked' && online.storage === 'blocked' && online.cookie === 'blocked', 'it cannot read the reader, its storage or its cookies', `${online.parent} ${online.storage} ${online.cookie}`);
  const attribute = await frameSandbox();
  check(attribute && attribute.attribute === null && /\/view\/[0-9a-f]{32}\/sketch\.html$/.test(attribute.src), 'the frame loads the worker\'s address and sandboxes through the response\'s policy', JSON.stringify(attribute));
  await shot('06-sketch-online');

  // The picture the reply names is an image document: shown in an <img> from the copy's own bytes, never in a frame.
  const picture = () => page.evaluate(() => { const i = document.querySelector('#main .imgframe img'); return i ? { src: i.src.slice(0, 22), width: i.naturalWidth, frames: document.querySelectorAll('#main iframe').length, note: document.querySelector('#main .imgbar .when').textContent } : null; });
  await pickDocument('dot.png');
  await until(async () => (await picture()) && (await picture()).width > 0, 'the picture');
  const shown = await picture();
  check(shown.src === 'data:image/png;base64,' && shown.width === 48 && shown.frames === 0 && /48 × 48 px/.test(shown.note), 'the picture opens in an <img> from the copy\'s bytes, not in a frame', JSON.stringify(shown));
  await shot('06b-picture-online');

  // ------------------------------------------------------------------ the laptop away
  await stopServer();
  const refused = await context.request.get(`${base}/api/transcript-reader/state`).then(() => 'answered', () => 'no answer');
  check(refused === 'no answer', 'the server is stopped: the phone cannot reach the laptop');
  await page.reload();
  await until(async () => /Offline · copy from/.test(await text('#asof-text')), 'the offline line');
  check(!(await page.locator('.unlock').count()), 'the page opens from the device with no sign-in, no passphrase and no laptop');
  const age = await text('#asof-text');
  check(/copy from .* \(\d+ (min|h)/.test(age), 'it says how old the copy is', age);
  await page.click('#tab-reader');  // the reload keeps the Documents tab the phone was on
  await until(async () => /Sent a short version|Drafted the notes|Tidy the scratch folder/.test(await text('#main')), 'the conversation text');
  await switchTo('alpha');
  await until(async () => /Sent a short version|Drafted the notes/.test(await text('#main')), 'the main conversation, offline');
  check(true, 'both conversations read from the device with the laptop away');
  await shot('07-offline-conversation');
  await openDocuments();
  await pickDocument('sketch.html');
  const away = await sketch();
  check(away.script.startsWith('The sketch ran its own script.') && away.origin === 'null' && away.pic === 48 && away.style === 'rgb(180, 35, 45)', 'the HTML sketch opens offline in its sandbox, script, stylesheet and picture included', JSON.stringify(away));
  check(away.net === 'Network check: blocked' && away.parent === 'blocked' && away.storage === 'blocked', 'and is just as sandboxed offline', JSON.stringify(away));
  await shot('08-sketch-offline');
  await pickDocument('dot.png');
  await until(async () => (await picture()) && (await picture()).width > 0, 'the picture offline');
  check((await picture()).width === 48, 'the picture opens offline too');
  await shot('08c-picture-offline');
  await pickDocument('notes.md');
  await until(async () => /Release notes/.test(await text('#main')), 'the markdown document offline');
  await page.click('#tab-reader');
  await until(async () => /Drafted the notes|Sent a short version/.test(await text('#main')), 'the reader tab');

  // The answer sheet's page is stored too: it opens with the laptop away, and goes back to the reader.
  await page.goto(`${base}/setup/transcript-reader/out/bucket/sheet.html`);
  await until(async () => /No questionnaire found|No answer sheet found|asked/.test(await text('#main') + await text('#meta')), 'the answer sheet offline');
  check(true, 'the answer sheet page opens from the stored shell with the laptop away');
  await shot('08b-sheet-offline');
  await page.goto(shell);
  await until(async () => /Offline · copy from/.test(await text('#asof-text')), 'the reader again');
  await page.click('#tab-reader');
  await until(async () => /Drafted the notes|Sent a short version|Tidy the scratch folder/.test(await text('#main')), 'the reader conversation after the sheet');
  await switchTo('alpha');
  await until(async () => /Drafted the notes|Sent a short version/.test(await text('#main')), 'the main conversation again');

  // ------------------------------------------------------------------ Send while away
  await page.fill('#dock-text', 'Please also send it to the design team. Sent from the train.');
  await page.click('#dock-send');
  // Send holds the message for the Undo window (5 s, nothing leaves the page) before the page tries the laptop.
  await until(async () => /Sending in \d s/.test(await text('#main')), 'the Undo window');
  await until(async () => /Held on this phone/.test(await text('#dock-status') + await text('#main')), 'the held message', 40000);
  check(/Held on this phone/.test(await text('#main')), 'a Send with the laptop away is held on the phone and says so');
  await shot('09-held');
  const queueFolder = path.join(folder, 'out', 'bucket', 'q');
  check(!fs.existsSync(queueFolder) || fs.readdirSync(queueFolder).length === 0, 'nothing reached the laptop\'s queue yet');

  // ------------------------------------------------------------------ the laptop back
  await startServer();
  await until(() => fs.existsSync(queueFolder) && fs.readdirSync(queueFolder).filter((n) => n.endsWith('.json.enc')).length === 1, 'the held message in the laptop\'s queue', 60000).catch(async (error) => {
    process.stdout.write(`traffic: ${traffic.join(' | ')}\nproblems: ${problems.join(' | ')}\nurl: ${page.url()}\n`);
    process.stdout.write(`main: ${await page.locator('#main').innerText({ timeout: 3000 }).then((t) => t.slice(-300), (e) => 'unreadable: ' + e.message.split('\n')[0])}\n`);
    await shot('99-stuck').catch(() => {});
    throw error;
  });
  const queued = fs.readdirSync(queueFolder);
  check(queued.length === 1 && /^[0-9a-f-]{36}\.json\.enc$/.test(queued[0]), 'the held Send reached the laptop\'s queue once, sealed', queued.join());
  check(!fs.readFileSync(path.join(queueFolder, queued[0])).includes('the train'), 'the queue holds sealed bytes only');
  await page.click('#tab-reader');  // the reload for the new token reopens the address's document
  await until(async () => /waiting for the laptop to send it|Queued/.test(await text('#main')), 'the queued state');
  await shot('10-queued');
  const calls = () => (fs.existsSync(world.log) ? fs.readFileSync(world.log, 'utf8').split('\n').filter((l) => l.startsWith('PROMPT')) : []);
  const drainEnv = { ...process.env, HOME: world.home, HOSTED_READER_PASSPHRASE: PASSPHRASE, HOSTED_READER_HERDR: path.join(world.bin, 'herdr'), FAKE_HERDR_SESSION: world.main, FAKE_HERDR_LOG: world.log };
  const drain = () => execFileSync('node', [path.join(READER, 'drain.js'), path.join(folder, 'out', 'bucket'), '--sealed', '--state', path.join(folder, 'out')], { encoding: 'utf8', env: drainEnv, timeout: 60000 });
  const first = drain();
  check(calls().length === 1 && /Please also send it to the design team\. Sent from the train\./.test(calls()[0]), 'the sync\'s drain sent it to the fake Herdr exactly once', first.trim());
  drain();
  check(calls().length === 1, 'a second drain sends nothing more');
  await until(async () => /Sent by the laptop at/.test(await text('#main')), 'the receipt', 40000);
  check(true, 'the phone shows the laptop\'s receipt');
  await shot('11-receipt');

  // ------------------------------------------------------------------ Forget this device
  await page.click('#forget');
  await until(async () => (await page.locator('.unlock').count()) === 1, 'the passphrase card after forgetting');
  const left = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('hosted-reader'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const count = (store) => new Promise((resolve) => { const r = db.transaction(store).objectStore(store).count(); r.onsuccess = () => resolve(r.result); });
    const registrations = (await navigator.serviceWorker.getRegistrations()).length;
    return { objects: await count('objects'), keys: await count('keys'), meta: await count('meta'), outbox: await count('outbox'), caches: (await caches.keys()).length, registrations };
  });
  // The fresh page load after forgetting installs the worker again and keeps the copy's public key parameters (a salt, no secret); everything
  // that was stored from the copy, the key, the held sends and the shell cache are gone.
  check(left.objects === 0 && left.keys === 0 && left.outbox === 0 && left.caches === 0 && left.meta <= 1, 'Forget this device clears the key, the objects, the held sends and the shell cache', JSON.stringify(left));
  await shot('12-forgotten');

  check(problems.length === 0, 'no script error or console error on the page', problems.slice(0, 3).join(' | '));
  await browser.close();
  await stopServer();
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(folder, 'e2e-results.json'), JSON.stringify(results, null, 1));
  process.stdout.write(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${shots}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => { process.stderr.write(`\nERROR ${error.stack || error.message}\n`); process.exit(2); });
