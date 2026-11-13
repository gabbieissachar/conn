'use strict';

// Tests for reading a markdown file the page lists without its text (api.js: md-open), which is how the Documents view's By task grouping opens
// a file of a leader's task folder that no conversation named. Run from the repo root:
//   node --test setup/transcript-reader/taskdocs.test.js
// Everything is temporary files: a fake home folder and temp folder (the only places a file may be read from), a folder outside both, and an
// out/ folder holding the list of files the page offers. No real session, pane or page is read, and Herdr is never asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { create, TOKEN_HEADER } = require('./api');

async function start(options = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-taskdocs-')));
  const dirs = { home: path.join(base, 'home'), temp: path.join(base, 'temp'), outside: path.join(base, 'outside'), repo: path.join(base, 'repo') };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const outDir = path.join(dirs.repo, 'setup', 'transcript-reader', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const task = path.join(dirs.home, 'firstmate', 'data', 'reader-x');
  fs.mkdirSync(task, { recursive: true });
  fs.writeFileSync(path.join(task, 'brief.md'), '# Brief\n\nThe ask.\n');
  fs.writeFileSync(path.join(task, 'page.html'), '<p>page</p>');
  fs.writeFileSync(path.join(dirs.outside, 'secret.md'), 'secret');
  const files = { aaaaaaaaaa: path.join(task, 'brief.md') };
  const list = () => fs.writeFileSync(path.join(outDir, 'md-files.json'), JSON.stringify(files));
  list();
  let api;
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) { res.writeHead(404); res.end('not here'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  api = create({ root: dirs.repo, port, outDir, homeDir: dirs.home, tempRoots: [dirs.temp], now: () => Date.now(), claudeSessionsDir: path.join(base, 'sessions'), pinsFile: path.join(base, 'pins.json'), ...options });
  const host = 'localhost:' + port;
  const origin = 'http://' + host;
  const request = ({ method = 'GET', path: urlPath, headers = {}, body }) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ agent: false, host: '127.0.0.1', port, method, path: urlPath, headers: { Host: host, ...headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, raw, json }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  fs.writeFileSync(path.join(outDir, 'prototype.html'), `<!doctype html><head><meta name="reader-token" content="__READER_TOKEN__"></head>`);
  const page = await request({ path: '/setup/transcript-reader/out/prototype.html', headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
  const token = page.raw.match(/content="([0-9a-f]{64})"/)[1];
  const openMd = (id, headers = {}, body = { id }) => request({ method: 'POST', path: '/api/transcript-reader/md-open', headers: { Origin: origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: token, ...headers }, body });
  return { base, dirs, outDir, task, files, list, request, token, origin, openMd, close: () => new Promise((resolve) => server.close(() => { fs.rmSync(base, { recursive: true, force: true }); resolve(); })) };
}

test('md-open: a listed markdown file is read as it is now, with its name, size and change time', async () => {
  const t = await start();
  try {
    const opened = await t.openMd('aaaaaaaaaa');
    assert.equal(opened.status, 200, opened.raw);
    assert.equal(opened.json.text, '# Brief\n\nThe ask.\n');
    assert.equal(opened.json.name, 'brief.md');
    assert.equal(opened.json.size, Buffer.byteLength('# Brief\n\nThe ask.\n'));
    assert.ok(Math.abs(opened.json.mtime - fs.statSync(path.join(t.task, 'brief.md')).mtimeMs / 1000) < 0.001);
    fs.writeFileSync(path.join(t.task, 'brief.md'), 'changed');
    assert.equal((await t.openMd('aaaaaaaaaa')).json.text, 'changed', 'read again from disk at each open');
    assert.deepEqual(Object.keys(opened.headers).filter((name) => name.startsWith('access-control')), [], 'no cross-origin answer');
  } finally { await t.close(); }
});

test('md-open: needs the token and the same origin, takes only an id, and the request never names a path', async () => {
  const t = await start();
  try {
    assert.equal((await t.request({ method: 'POST', path: '/api/transcript-reader/md-open', headers: { Origin: t.origin, 'Content-Type': 'application/json' }, body: { id: 'aaaaaaaaaa' } })).status, 403, 'no token');
    assert.equal((await t.openMd('aaaaaaaaaa', { Origin: 'http://evil.example' })).status, 403, 'another origin');
    assert.equal((await t.openMd(null, {}, { id: 'aaaaaaaaaa', path: path.join(t.dirs.outside, 'secret.md') })).status, 400, 'a field that is not the id');
    assert.equal((await t.openMd(null, {}, { id: path.join(t.dirs.outside, 'secret.md') })).status, 400, 'a path in place of an id');
    assert.equal((await t.openMd('bbbbbbbbbb')).json.code, 'not_listed', 'an id the build did not list');
    assert.equal((await t.request({ method: 'GET', path: '/api/transcript-reader/md-open', headers: { Origin: t.origin, [TOKEN_HEADER]: t.token } })).status, 404, 'POST only');
    fs.writeFileSync(path.join(t.outDir, 'md-files.json'), '{not json');
    assert.equal((await t.openMd('aaaaaaaaaa')).json.code, 'not_listed', 'a list that cannot be read offers nothing');
  } finally { await t.close(); }
});

test('md-open: only markdown the list offers, from the home and temp folders after links are followed, within 512 KB', async () => {
  const t = await start();
  try {
    t.files.cccccccccc = path.join(t.dirs.outside, 'secret.md');
    t.files.dddddddddd = path.join(t.task, 'page.html');
    t.files.eeeeeeeeee = path.join(t.task, 'gone.md');
    t.files.ffffffffff = t.task;
    fs.symlinkSync(path.join(t.dirs.outside, 'secret.md'), path.join(t.task, 'link.md'));
    t.files.aaaaaaaaab = path.join(t.task, 'link.md');
    fs.writeFileSync(path.join(t.task, 'big.md'), 'x'.repeat(512 * 1024 + 1));
    t.files.aaaaaaaaac = path.join(t.task, 'big.md');
    fs.writeFileSync(path.join(t.dirs.temp, 'scratch.md'), 'in temp');
    t.files.aaaaaaaaad = path.join(t.dirs.temp, 'scratch.md');
    t.list();
    const code = async (id) => { const r = await t.openMd(id); return [r.status, r.json.code]; };
    assert.deepEqual(await code('cccccccccc'), [403, 'outside'], 'a file outside the home and temp folders');
    assert.deepEqual(await code('aaaaaaaaab'), [403, 'outside'], 'a link out of them');
    assert.deepEqual(await code('dddddddddd'), [404, 'not_markdown'], 'another type, though listed');
    assert.deepEqual(await code('eeeeeeeeee'), [404, 'gone']);
    assert.deepEqual(await code('ffffffffff'), [404, 'gone'], 'a folder');
    assert.deepEqual(await code('aaaaaaaaac'), [413, 'too_big']);
    assert.match((await t.openMd('aaaaaaaaac')).json.message, /512 KB/);
    assert.equal((await t.openMd('aaaaaaaaad')).json.text, 'in temp', 'a temp folder is allowed');
  } finally { await t.close(); }
});

test('md-open: a file that does not answer is given up within the time allowed, and its folder is left alone for a while (the server goes on)', async () => {
  let clock = 1000000;
  const t = await start({ mdReadMs: 150, now: () => clock });
  // The open of one file never returns, as for a file in ~/Downloads that macOS holds behind an unanswered permission dialog.
  const real = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = (file, ...rest) => { if (String(file).endsWith('stuck.md')) { reads += 1; return new Promise(() => {}); } return real.call(fs.promises, file, ...rest); };
  try {
    fs.writeFileSync(path.join(t.task, 'stuck.md'), 'never read');
    fs.writeFileSync(path.join(t.task, 'next.md'), 'same folder');
    fs.mkdirSync(path.join(t.dirs.temp, 'elsewhere'));
    fs.writeFileSync(path.join(t.dirs.temp, 'elsewhere', 'fine.md'), 'another folder');
    t.files.bbbbbbbbbb = path.join(t.task, 'stuck.md');
    t.files.bbbbbbbbbc = path.join(t.task, 'next.md');
    t.files.bbbbbbbbbd = path.join(t.dirs.temp, 'elsewhere', 'fine.md');
    t.list();
    const began = Date.now();
    const first = await t.openMd('bbbbbbbbbb');
    assert.equal(first.status, 504);
    assert.equal(first.json.code, 'unresponsive');
    assert.match(first.json.message, /not answering/);
    assert.ok(Date.now() - began < 2000, 'answered after the time allowed, not after the open');
    const again = Date.now();
    assert.equal((await t.openMd('bbbbbbbbbc')).status, 504, 'the folder is left alone');
    assert.ok(Date.now() - again < 100, 'and not waited for');
    assert.equal(reads, 1, 'not asked again');
    assert.equal((await t.openMd('bbbbbbbbbd')).json.text, 'another folder', 'another folder is read');
    assert.equal((await t.request({ method: 'GET', path: '/api/transcript-reader/state', headers: { [TOKEN_HEADER]: t.token } })).status, 200, 'the server answers other requests meanwhile');
    clock += 5 * 60 * 1000 + 1;
    fs.promises.readFile = real;
    assert.equal((await t.openMd('bbbbbbbbbc')).json.text, 'same folder', 'asked again once its time is over');
  } finally { fs.promises.readFile = real; await t.close(); }
});
