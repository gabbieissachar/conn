'use strict';

// Tests for showing an image file a reply names (api.js: image-open and the viewer address it shares with HTML files). Run from the repo root:
//   node --test setup/transcript-reader/image.test.js
// Everything is temporary files: a fake home folder and temp folder (the only places a file may be shown from), a folder outside both, and an
// out/ folder holding the lists of files the page offers. No real session, pane or page is read, and Herdr is never asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { create, TOKEN_HEADER } = require('./api');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch("/api/transcript-reader/state")</script></svg>';

async function start() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-image-')));
  const dirs = { home: path.join(base, 'home'), temp: path.join(base, 'temp'), outside: path.join(base, 'outside'), repo: path.join(base, 'repo') };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const outDir = path.join(dirs.repo, 'setup', 'transcript-reader', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const shots = path.join(dirs.home, 'scratch', 'shots');
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, 'home.png'), PNG);
  fs.writeFileSync(path.join(shots, 'evil.svg'), EVIL_SVG);
  fs.writeFileSync(path.join(shots, 'beside.png'), PNG);
  fs.writeFileSync(path.join(shots, 'page.html'), '<p>page</p>');
  const files = { aaaaaaaaaa: path.join(shots, 'home.png'), bbbbbbbbbb: path.join(shots, 'evil.svg') };
  const htmlFiles = { dddddddddd: path.join(shots, 'page.html') };
  const list = () => {
    fs.writeFileSync(path.join(outDir, 'image-files.json'), JSON.stringify(files));
    fs.writeFileSync(path.join(outDir, 'html-files.json'), JSON.stringify(htmlFiles));
  };
  list();
  let clock = Date.now();
  let api;
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) { res.writeHead(404); res.end('not here'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  api = create({ root: dirs.repo, port, outDir, homeDir: dirs.home, tempRoots: [dirs.temp], now: () => clock, claudeSessionsDir: path.join(base, 'sessions'), pinsFile: path.join(base, 'pins.json') });
  const host = 'localhost:' + port;
  const origin = 'http://' + host;
  const request = ({ method = 'GET', path: urlPath, headers = {}, body }) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ agent: false, host: '127.0.0.1', port, method, path: urlPath, headers: { Host: host, ...headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const bytes = Buffer.concat(chunks); let json = null; try { json = JSON.parse(bytes.toString('utf8')); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, bytes, raw: bytes.toString('utf8'), json }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  fs.writeFileSync(path.join(outDir, 'prototype.html'), `<!doctype html><head><meta name="reader-token" content="__READER_TOKEN__"></head>`);
  const page = await request({ path: '/setup/transcript-reader/out/prototype.html', headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
  const token = page.raw.match(/content="([0-9a-f]{64})"/)[1];
  const open = (route, id, headers = {}) => request({ method: 'POST', path: '/api/transcript-reader/' + route, headers: { Origin: origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: token, ...headers }, body: { id } });
  const openImage = (id, headers) => open('image-open', id, headers);
  // What the reader page's own <img> sends: same origin, no token, no Origin on a GET.
  const asImg = (urlPath, headers = {}) => request({ path: urlPath, headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image', ...headers } });
  const view = async (id = 'aaaaaaaaaa') => { const opened = await openImage(id); assert.equal(opened.status, 200, opened.raw); return opened.json; };
  return {
    base, dirs, outDir, shots, files, list, request, token, open, openImage, asImg, view, origin, host, port, clock: { tick: (ms) => { clock += ms; } },
    close: () => new Promise((resolve) => server.close(() => { fs.rmSync(base, { recursive: true, force: true }); resolve(); })),
  };
}

const noCors = (response) => Object.keys(response.headers).filter((name) => name.startsWith('access-control'));

test('image-open: a listed image is checked now and given an address; the answer says what the file is', async () => {
  const t = await start();
  try {
    const opened = await t.openImage('aaaaaaaaaa');
    assert.equal(opened.status, 200);
    assert.equal(opened.json.name, 'home.png');
    assert.equal(opened.json.size, PNG.length);
    assert.ok(Math.abs(opened.json.mtime - fs.statSync(path.join(t.shots, 'home.png')).mtimeMs / 1000) < 0.001);
    assert.match(opened.json.url, /^\/api\/transcript-reader\/html\/[A-Za-z0-9_-]{22}\/home\.png$/);
    assert.equal(opened.headers['cache-control'], 'no-store');
    assert.deepEqual(noCors(opened), []);
  } finally { await t.close(); }
});

test('image-open: needs the token and the same origin, takes only an id, and the request never names a path', async () => {
  const t = await start();
  try {
    assert.equal((await t.openImage('aaaaaaaaaa', { [TOKEN_HEADER]: 'wrong' })).status, 403);
    assert.equal((await t.openImage('aaaaaaaaaa', { Origin: 'http://evil.example' })).status, 403);
    const extra = await t.request({ method: 'POST', path: '/api/transcript-reader/image-open', headers: { Origin: t.origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: t.token }, body: { id: 'aaaaaaaaaa', path: '/etc/passwd' } });
    assert.equal(extra.status, 400);
    for (const id of ['../../etc/passwd', 'zzzzzzzzzz', 'aaaaaaaaaaa', '__proto__']) assert.equal((await t.openImage(id)).status, 400, id);
    assert.equal((await t.openImage('eeeeeeeeee')).json.code, 'not_listed', 'an id the last build did not list');
    fs.writeFileSync(path.join(t.outDir, 'image-files.json'), '{not json');
    assert.equal((await t.openImage('aaaaaaaaaa')).json.code, 'not_listed');
  } finally { await t.close(); }
});

test('image-open and html-open each open only what their own list offers', async () => {
  const t = await start();
  try {
    assert.equal((await t.open('html-open', 'aaaaaaaaaa')).json.code, 'not_listed', 'an image id does not open as an HTML file');
    assert.equal((await t.openImage('dddddddddd')).json.code, 'not_listed', 'an HTML id does not open as an image');
    assert.equal((await t.open('html-open', 'dddddddddd')).status, 200);
  } finally { await t.close(); }
});

test('image-open: the home and temp folders only, after links are followed; a missing file, a folder, another type and one over 10 MB are refused with the reason', async () => {
  const t = await start();
  try {
    fs.mkdirSync(path.join(t.shots, 'folder.png'));
    fs.writeFileSync(path.join(t.shots, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(t.dirs.outside, 'secret.png'), PNG);
    fs.symlinkSync(path.join(t.dirs.outside, 'secret.png'), path.join(t.shots, 'link.png'));
    fs.symlinkSync(path.join(t.shots, 'notes.txt'), path.join(t.shots, 'text.png'));
    fs.writeFileSync(path.join(t.dirs.temp, 'in-temp.png'), PNG);
    const big = path.join(t.shots, 'big.png');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 10 * 1024 * 1024 + 1);
    Object.assign(t.files, {
      bbbbbbbbb1: path.join(t.shots, 'gone.png'), bbbbbbbbb2: path.join(t.shots, 'folder.png'), bbbbbbbbb3: path.join(t.shots, 'notes.txt'), bbbbbbbbb4: big, bbbbbbbbb5: 'relative/a.png',
      bbbbbbbbb6: path.join(t.dirs.outside, 'secret.png'), bbbbbbbbb7: path.join(t.shots, 'link.png'), bbbbbbbbb8: path.join(t.shots, 'text.png'), bbbbbbbbb9: path.join(t.dirs.temp, 'in-temp.png'),
    });
    t.list();
    const ids = Object.keys(t.files).filter((id) => /^bbbbbbbbb\d$/.test(id));
    const codes = {};
    for (const id of ids) { const r = await t.openImage(id); codes[id] = [r.status, r.json.code]; }
    assert.deepEqual(codes, {
      bbbbbbbbb1: [404, 'gone'], bbbbbbbbb2: [404, 'gone'], bbbbbbbbb3: [404, 'not_image'], bbbbbbbbb4: [413, 'too_big'], bbbbbbbbb5: [404, 'not_listed'],
      bbbbbbbbb6: [403, 'outside'], bbbbbbbbb7: [403, 'outside'], bbbbbbbbb8: [404, 'not_image'], bbbbbbbbb9: [200, undefined],
    });
    fs.truncateSync(big, 10 * 1024 * 1024);
    assert.equal((await t.openImage('bbbbbbbbb4')).status, 200, 'the limit itself is allowed');
  } finally { await t.close(); }
});

test('view: the image is served with its own type, bytes as on disk, sandboxed by its own response, and no CORS header', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    for (const get of [t.asImg, (u) => t.request({ path: u, headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } })]) {
      const response = await get(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'image/png');
      assert.deepEqual(response.bytes, PNG);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.match(response.headers['content-security-policy'], /^sandbox;/);
      assert.doesNotMatch(response.headers['content-security-policy'], /allow-/);
      assert.deepEqual(noCors(response), []);
    }
  } finally { await t.close(); }
});

test('view: an SVG with a script is served as an image and sandboxed without allow-scripts, so opened alone in a tab it runs nothing', async () => {
  const t = await start();
  try {
    const { url } = await t.view('bbbbbbbbbb');
    const response = await t.asImg(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/svg+xml');
    assert.equal(response.raw, EVIL_SVG, 'served as it is; the safety is in how it is shown');
    const policy = response.headers['content-security-policy'];
    assert.match(policy, /^sandbox;/);
    assert.doesNotMatch(policy, /allow-scripts|allow-same-origin/);
    assert.match(policy, /default-src 'none'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  } finally { await t.close(); }
});

test('view: an image\'s address serves that one file and nothing beside it', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    for (const name of ['beside.png', 'page.html', 'evil.svg', 'home.png/../beside.png']) assert.equal((await t.asImg(dir + name)).status, 404, name);
    assert.equal((await t.asImg(url)).status, 200);
    // An HTML file's address still serves what is beside it, as before.
    const html = (await t.open('html-open', 'dddddddddd')).json;
    assert.equal((await t.asImg(html.url.slice(0, html.url.lastIndexOf('/') + 1) + 'beside.png')).status, 200);
  } finally { await t.close(); }
});

test('view: the file is read as it is on disk at each request, a link out after it was opened is not served, and the key lapses from disuse', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    assert.deepEqual((await t.asImg(url)).bytes, PNG);
    fs.writeFileSync(path.join(t.shots, 'home.png'), 'edited');
    assert.equal((await t.asImg(url)).raw, 'edited');
    fs.rmSync(path.join(t.shots, 'home.png'));
    fs.writeFileSync(path.join(t.dirs.outside, 'secret.png'), 'secret');
    fs.symlinkSync(path.join(t.dirs.outside, 'secret.png'), path.join(t.shots, 'home.png'));
    assert.equal((await t.asImg(url)).status, 404);
    t.clock.tick(61 * 60 * 1000);
    assert.equal((await t.asImg(url)).status, 404, 'an hour unused');
  } finally { await t.close(); }
});

test('view: a file that grew over the image limit after it was opened is refused', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    fs.truncateSync(path.join(t.shots, 'home.png'), 10 * 1024 * 1024 + 1);
    assert.equal((await t.asImg(url)).status, 413);
  } finally { await t.close(); }
});
