'use strict';

// Tests for showing an HTML file a reply names (api.js: html-open and the viewer address). Run from the repo root:
//   node --test setup/transcript-reader/html.test.js
// Everything is temporary files: a fake home folder and temp folder (the only places a file may be shown from),
// a folder outside both, and an out/ folder holding the list of files the page offers. No real session, pane or
// page is read, and Herdr is never asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { create, TOKEN_HEADER } = require('./api');

const PAGE = '<!doctype html><title>sketch</title><link rel="stylesheet" href="style.css"><img src="img/dot.png"><script src="app.js"></script>';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function start({ withTailnet = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-html-')));
  const dirs = { home: path.join(base, 'home'), temp: path.join(base, 'temp'), outside: path.join(base, 'outside'), repo: path.join(base, 'repo') };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const outDir = path.join(dirs.repo, 'setup', 'transcript-reader', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const sketches = path.join(dirs.home, 'scratch', 'sketches');
  fs.mkdirSync(path.join(sketches, 'img'), { recursive: true });
  fs.writeFileSync(path.join(sketches, 'region.html'), PAGE);
  fs.writeFileSync(path.join(sketches, 'style.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(sketches, 'app.js'), 'document.title="ran"');
  fs.writeFileSync(path.join(sketches, 'img', 'dot.png'), PNG);
  const files = { aaaaaaaaaa: path.join(sketches, 'region.html') };
  const list = () => fs.writeFileSync(path.join(outDir, 'html-files.json'), JSON.stringify(files));
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
  // The page opened in a tab carries the token, as in api.test.js; a built page is not needed to ask for it here.
  fs.writeFileSync(path.join(outDir, 'prototype.html'), `<!doctype html><head><meta name="reader-token" content="__READER_TOKEN__"></head>`);
  const page = await request({ path: '/setup/transcript-reader/out/prototype.html', headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
  const token = page.raw.match(/content="([0-9a-f]{64})"/)[1];
  const openFile = (id, headers = {}) => request({ method: 'POST', path: '/api/transcript-reader/html-open', headers: { Origin: origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: token, ...headers }, body: { id } });
  // What a sandboxed frame without an origin sends for the files it loads: no token, no Origin, cross-site.
  const asFrame = (urlPath, headers = {}) => request({ path: urlPath, headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script', ...headers } });
  const view = async (id = 'aaaaaaaaaa') => { const opened = await openFile(id); assert.equal(opened.status, 200, opened.raw); return opened.json; };
  return {
    base, dirs, outDir, sketches, files, list, request, token, openFile, asFrame, view, origin, host, port, api, clock: { tick: (ms) => { clock += ms; } },
    close: () => new Promise((resolve) => server.close(() => { fs.rmSync(base, { recursive: true, force: true }); resolve(); })),
  };
}

const noCors = (response) => Object.keys(response.headers).filter((name) => name.startsWith('access-control'));

test('open: a file the page offers is checked now and given an address; the answer says what the file is', async () => {
  const t = await start();
  try {
    const opened = await t.openFile('aaaaaaaaaa');
    assert.equal(opened.status, 200);
    assert.equal(opened.json.name, 'region.html');
    assert.equal(opened.json.size, Buffer.byteLength(PAGE));
    assert.ok(Math.abs(opened.json.mtime - fs.statSync(path.join(t.sketches, 'region.html')).mtimeMs / 1000) < 0.001);
    assert.match(opened.json.url, /^\/api\/transcript-reader\/html\/[A-Za-z0-9_-]{22}\/region\.html$/);
    assert.equal(opened.headers['cache-control'], 'no-store');
    assert.deepEqual(noCors(opened), []);
    const again = await t.openFile('aaaaaaaaaa');
    assert.notEqual(again.json.url, opened.json.url, 'each open gets its own key');
  } finally { await t.close(); }
});

test('open: needs the token, the same origin and a JSON body, like every route that asks for something', async () => {
  const t = await start();
  try {
    const route = '/api/transcript-reader/html-open';
    assert.equal((await t.request({ method: 'POST', path: route, headers: { Origin: t.origin, 'Content-Type': 'application/json' }, body: { id: 'aaaaaaaaaa' } })).status, 403, 'no token');
    assert.equal((await t.request({ method: 'POST', path: route, headers: { Origin: t.origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: 'f'.repeat(64) }, body: { id: 'aaaaaaaaaa' } })).status, 403, 'wrong token');
    assert.equal((await t.openFile('aaaaaaaaaa', { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'cross-site');
    assert.equal((await t.openFile('aaaaaaaaaa', { Origin: 'http://evil.example' })).status, 403, 'foreign origin');
    assert.equal((await t.openFile('aaaaaaaaaa', { Host: 'evil.example:80' })).status, 403, 'foreign host');
    assert.equal((await t.request({ method: 'POST', path: route, headers: { Origin: t.origin, [TOKEN_HEADER]: t.token, 'Content-Type': 'text/plain' }, body: { id: 'aaaaaaaaaa' } })).status, 415);
    assert.equal((await t.request({ path: route, headers: { [TOKEN_HEADER]: t.token } })).status, 404, 'a GET is not an open');
  } finally { await t.close(); }
});

test('open: only an id the last build listed opens; the request never names a path', async () => {
  const t = await start();
  try {
    for (const id of ['bbbbbbbbbb', 'AAAAAAAAAA', 'aaaaaaaaa', '../etc/passwd', '', 7, null, ['aaaaaaaaaa'], { id: 'aaaaaaaaaa' }, '__proto__', 'constructor']) {
      const response = await t.openFile(id);
      assert.ok([400, 404].includes(response.status), JSON.stringify(id) + ' -> ' + response.status);
    }
    const extra = await t.request({ method: 'POST', path: '/api/transcript-reader/html-open', headers: { Origin: t.origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: t.token }, body: { id: 'aaaaaaaaaa', path: '/etc/passwd' } });
    assert.equal(extra.status, 400);
    fs.writeFileSync(path.join(t.outDir, 'html-files.json'), '{not json');
    assert.equal((await t.openFile('aaaaaaaaaa')).status, 404, 'a broken list offers nothing');
    fs.rmSync(path.join(t.outDir, 'html-files.json'));
    assert.equal((await t.openFile('aaaaaaaaaa')).status, 404, 'no list offers nothing');
  } finally { await t.close(); }
});

test('open: the list itself is never served, by any route', async () => {
  const t = await start();
  try {
    const headers = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
    const response = await t.request({ path: '/setup/transcript-reader/out/html-files.json', headers });
    assert.equal(response.status, 404);
    assert.equal(response.raw.includes(t.sketches), false);
    assert.equal((await t.request({ path: '/api/transcript-reader/page?name=html-files.json', headers: { [TOKEN_HEADER]: t.token } })).status, 404);
  } finally { await t.close(); }
});

test('open: the folder limits are the markdown documents\': under the home or a temp folder, after links are followed', async () => {
  const t = await start();
  try {
    const inTemp = path.join(t.dirs.temp, 'scratch.html');
    const outside = path.join(t.dirs.outside, 'secret.html');
    fs.writeFileSync(inTemp, '<p>temp</p>');
    fs.writeFileSync(outside, '<p>secret</p>');
    fs.symlinkSync(outside, path.join(t.sketches, 'link.html'));
    fs.symlinkSync(inTemp, path.join(t.sketches, 'tolink.html'));
    Object.assign(t.files, { bbbbbbbbbb: inTemp, cccccccccc: outside, dddddddddd: path.join(t.sketches, 'link.html'), eeeeeeeeee: path.join(t.sketches, 'tolink.html'), ffffffffff: path.join(t.sketches, '..', '..', '..', 'outside', 'secret.html') });
    t.list();
    assert.equal((await t.openFile('bbbbbbbbbb')).status, 200, 'a temp folder');
    assert.equal((await t.openFile('eeeeeeeeee')).status, 200, 'a link that stays inside the allowed folders');
    for (const id of ['cccccccccc', 'dddddddddd', 'ffffffffff']) {
      const response = await t.openFile(id);
      assert.equal(response.status, 403, id);
      assert.equal(response.json.code, 'outside');
    }
  } finally { await t.close(); }
});

test('open: a missing file, a folder, a file that is not HTML and one over the size limit are refused with the reason', async () => {
  const t = await start();
  try {
    fs.mkdirSync(path.join(t.sketches, 'folder.html'));
    fs.writeFileSync(path.join(t.sketches, 'notes.txt'), 'x');
    const big = path.join(t.sketches, 'big.html');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 8 * 1024 * 1024 + 1);
    Object.assign(t.files, { bbbbbbbbbb: path.join(t.sketches, 'gone.html'), cccccccccc: path.join(t.sketches, 'folder.html'), dddddddddd: path.join(t.sketches, 'notes.txt'), eeeeeeeeee: big, ffffffffff: 'relative/a.html' });
    t.list();
    const codes = {};
    for (const id of ['bbbbbbbbbb', 'cccccccccc', 'dddddddddd', 'eeeeeeeeee', 'ffffffffff']) { const r = await t.openFile(id); codes[id] = [r.status, r.json.code]; }
    assert.deepEqual(codes, { bbbbbbbbbb: [404, 'gone'], cccccccccc: [404, 'gone'], dddddddddd: [404, 'not_html'], eeeeeeeeee: [413, 'too_big'], ffffffffff: [404, 'not_listed'] });
    fs.truncateSync(big, 8 * 1024 * 1024);
    assert.equal((await t.openFile('eeeeeeeeee')).status, 200, 'the limit itself is allowed');
  } finally { await t.close(); }
});

test('view: the file is served rendered-safe: sandboxed by its own response, with a restrictive policy and no CORS header', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    const response = await t.request({ path: url, headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' } });
    assert.equal(response.status, 200);
    assert.equal(response.raw, PAGE);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
    assert.deepEqual(noCors(response), []);
    const policy = response.headers['content-security-policy'];
    const directives = Object.fromEntries(policy.split('; ').map((part) => { const [name, ...rest] = part.split(' '); return [name, rest.join(' ')]; }));
    assert.equal(directives.sandbox, 'allow-scripts', 'the response is sandboxed without allow-same-origin, even opened alone in a tab');
    assert.equal(directives['default-src'], "'none'");
    assert.equal(directives['connect-src'], "'none'", 'no fetch, XHR, WebSocket or beacon');
    assert.equal(directives['frame-src'], "'none'");
    assert.equal(directives['form-action'], "'none'");
    assert.equal(directives['object-src'], "'none'");
    assert.equal(directives['frame-ancestors'], "'self'", 'only the reader page may frame it');
    assert.equal(directives['script-src'], "'self' 'unsafe-inline'", 'its own scripts run, no remote ones');
    for (const name of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src']) assert.doesNotMatch(directives[name], /https?:|\*/, name + ' names no remote host');
    assert.doesNotMatch(policy, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
  } finally { await t.close(); }
});

test('view: the file is read as it is on disk at each request, so a reload shows the agent\'s latest edit', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    assert.equal((await t.asFrame(url)).raw, PAGE);
    fs.writeFileSync(path.join(t.sketches, 'region.html'), '<p>edited</p>');
    assert.equal((await t.asFrame(url)).raw, '<p>edited</p>');
    fs.rmSync(path.join(t.sketches, 'region.html'));
    assert.equal((await t.asFrame(url)).status, 404, 'a file that is gone is not served from memory');
  } finally { await t.close(); }
});

test('view: files beside the page, and below it, load with their own types; each answer is sandboxed too', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    for (const [name, type, body] of [['style.css', 'text/css; charset=utf-8', Buffer.from('body{margin:0}')], ['app.js', 'text/javascript; charset=utf-8', Buffer.from('document.title="ran"')], ['img/dot.png', 'image/png', PNG]]) {
      const response = await t.asFrame(dir + name);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers['content-type'], type, name);
      assert.deepEqual(response.bytes, body, name);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.match(response.headers['content-security-policy'], /^sandbox;/, name + ' is sandboxed even opened alone');
      assert.deepEqual(noCors(response), []);
    }
    fs.writeFileSync(path.join(t.sketches, 'second.html'), '<p>second</p>');
    assert.equal((await t.asFrame(dir + 'second.html')).raw, '<p>second</p>', 'a link to another page beside it works');
    assert.match((await t.asFrame(dir + 'second.html')).headers['content-security-policy'], /^sandbox allow-scripts;/);
  } finally { await t.close(); }
});

test('view: nothing outside the page\'s folder loads, and nothing hidden, linked out, or of another type', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    fs.writeFileSync(path.join(t.dirs.home, 'scratch', 'above.css'), 'x');
    fs.writeFileSync(path.join(t.dirs.outside, 'secret.png'), 'x');
    fs.writeFileSync(path.join(t.sketches, '.hidden.css'), 'x');
    fs.mkdirSync(path.join(t.sketches, '.git'));
    fs.writeFileSync(path.join(t.sketches, '.git', 'x.png'), 'x');
    fs.writeFileSync(path.join(t.sketches, 'data.json'), '{}');
    fs.writeFileSync(path.join(t.sketches, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(t.sketches, 'run.py'), 'x');
    fs.writeFileSync(path.join(t.sketches, 'font.woff2'), 'x');
    fs.mkdirSync(path.join(t.sketches, 'sub'));
    fs.symlinkSync(path.join(t.dirs.outside, 'secret.png'), path.join(t.sketches, 'sub', 'out.png'));
    fs.symlinkSync(path.join(t.dirs.home, 'scratch', 'above.css'), path.join(t.sketches, 'up.css'));
    fs.symlinkSync(t.dirs.outside, path.join(t.sketches, 'outdir'));
    for (const name of ['../above.css', '%2e%2e/above.css', '..%2Fabove.css', '%2e%2e%2fabove.css', 'sub/../../above.css', '..%5Cabove.css', '.hidden.css', '.git/x.png', 'data.json', 'notes.txt', 'run.py', 'font.woff2',
      'sub/out.png', 'up.css', 'outdir/secret.png', 'sub', 'sub/', '', 'img//dot.png', 'img/', 'missing.png', '%00style.css', 'style.css%00', '%ZZ']) {
      const response = await t.asFrame(dir + name);
      assert.ok([400, 403, 404].includes(response.status), name + ' -> ' + response.status);
      assert.notEqual(response.raw, 'x', name);
      assert.notEqual(response.raw, '{}', name);
    }
    assert.equal((await t.asFrame(dir.replace(/html\/[^/]+\//, 'html/' + 'x'.repeat(22) + '/') + 'style.css')).status, 404, 'an unknown key');
    // The reader's own routes are not reachable through the address either.
    assert.equal((await t.asFrame(dir + '../state')).status, 404);
    assert.equal((await t.asFrame('/api/transcript-reader/html/')).status, 404);
    assert.equal((await t.asFrame('/api/transcript-reader/html')).status, 403, 'not the address: an API route, which refuses a cross-site request');
  } finally { await t.close(); }
});

test('view: an HTML file directly in the home or a temp folder gets its own folder\'s files and nothing below', async () => {
  const t = await start();
  try {
    for (const root of [t.dirs.home, t.dirs.temp]) {
      fs.mkdirSync(path.join(root, 'deep'), { recursive: true });
      fs.writeFileSync(path.join(root, 'top.html'), '<p>top</p>');
      fs.writeFileSync(path.join(root, 'beside.css'), 'b');
      fs.writeFileSync(path.join(root, 'deep', 'below.png'), 'x');
      fs.writeFileSync(path.join(root, 'deep', 'below.css'), 'x');
      t.files.bbbbbbbbbb = path.join(root, 'top.html');
      t.list();
      const { url } = await t.view('bbbbbbbbbb');
      const dir = url.slice(0, url.lastIndexOf('/') + 1);
      assert.equal((await t.asFrame(url)).raw, '<p>top</p>');
      assert.equal((await t.asFrame(dir + 'beside.css')).status, 200, root);
      assert.equal((await t.asFrame(dir + 'deep/below.css')).status, 404, root + ': not the whole home folder');
      assert.equal((await t.asFrame(dir + 'deep/below.png')).status, 404, root);
    }
  } finally { await t.close(); }
});

test('view: the address is the credential: it needs a key that open gave, which lapses from disuse and is limited in number', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    assert.equal((await t.asFrame(url)).status, 200);
    t.clock.tick(59 * 60 * 1000);
    assert.equal((await t.asFrame(dir + 'style.css')).status, 200, 'use renews it');
    t.clock.tick(59 * 60 * 1000);
    assert.equal((await t.asFrame(url)).status, 200);
    t.clock.tick(61 * 60 * 1000);
    assert.equal((await t.asFrame(url)).status, 404, 'an hour unused: gone');
    const first = (await t.view()).url;
    for (let i = 0; i < 64; i += 1) await t.view();
    assert.equal((await t.asFrame(first)).status, 404, 'the oldest key goes when more than 64 are held');
    assert.equal((await t.asFrame(first.replace(/html\/[^/]+\//, 'html/' + 'A'.repeat(22) + '/'))).status, 404);
  } finally { await t.close(); }
});

test('view: it answers GET only, and only for the reader\'s own host and origin; a frame needs no token, a page on another site no way in', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    assert.equal((await t.asFrame(url)).status, 200, 'cross-site Fetch-Metadata and no token, as a sandboxed frame sends');
    assert.equal((await t.request({ path: url })).status, 200, 'a request without Fetch-Metadata (an old browser)');
    assert.equal((await t.request({ method: 'POST', path: url, headers: { Origin: t.origin, 'Content-Type': 'application/json' }, body: {} })).status, 405);
    assert.equal((await t.request({ method: 'OPTIONS', path: url })).status, 403, 'no preflight is ever answered');
    assert.equal((await t.asFrame(url, { Host: 'evil.example:80' })).status, 403, 'DNS rebinding: a foreign host');
    assert.equal((await t.asFrame(url, { Host: 'localhost:1' })).status, 403);
    assert.equal((await t.asFrame(url, { Origin: 'http://evil.example' })).status, 403, 'a foreign origin');
    assert.equal((await t.asFrame(url, { Origin: 'null' })).status, 403, 'a CORS fetch from the sandboxed frame (a module script, a font) is refused, as the reader sends no CORS header');
    // The cross-site allowance is for this address only: the API, the pages and the open call still refuse a cross-site request.
    assert.equal((await t.asFrame('/api/transcript-reader/state', { 'x-transcript-reader-token': t.token })).status, 403);
    assert.equal((await t.asFrame('/setup/transcript-reader/out/prototype.html')).status, 403);
    assert.equal((await t.openFile('aaaaaaaaaa', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  } finally { await t.close(); }
});

test('view: a file over the size limit is refused, and so is a large file beside the page', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    const picture = path.join(t.sketches, 'photo.png');
    fs.writeFileSync(picture, '');
    fs.truncateSync(picture, 32 * 1024 * 1024);
    const served = await t.asFrame(dir + 'photo.png');
    assert.equal(served.status, 200, 'a picture may be large');
    assert.equal(served.bytes.length, 32 * 1024 * 1024);
    fs.truncateSync(picture, 32 * 1024 * 1024 + 1);
    assert.equal((await t.asFrame(dir + 'photo.png')).status, 413);
    fs.writeFileSync(path.join(t.sketches, 'region.html'), '');
    fs.truncateSync(path.join(t.sketches, 'region.html'), 8 * 1024 * 1024 + 1);
    assert.equal((await t.asFrame(url)).status, 413, 'a file that grew past the limit since it was opened');
  } finally { await t.close(); }
});

test('view: a file that is replaced by a link out of the allowed folders after it was opened is not served', async () => {
  const t = await start();
  try {
    const { url } = await t.view();
    fs.writeFileSync(path.join(t.dirs.outside, 'secret.html'), '<p>secret</p>');
    fs.rmSync(path.join(t.sketches, 'region.html'));
    fs.symlinkSync(path.join(t.dirs.outside, 'secret.html'), path.join(t.sketches, 'region.html'));
    const response = await t.asFrame(url);
    assert.equal(response.status, 404);
    assert.equal(response.raw.includes('secret'), false);
  } finally { await t.close(); }
});
