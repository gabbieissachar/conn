'use strict';

// Compression of the reader server's answers (compress.js), negotiated and checked through the real server on
// loopback. Run: node --test setup/transcript-reader/compress.test.js

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const zlib = require('zlib');
const { negotiate } = require('./compress');
const { start } = require('./server');

const BIG = 'a long agent reply, the kind of text a transcript is made of. '.repeat(400);

function repoCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-compress-'));
  const out = path.join(root, 'setup', 'transcript-reader', 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'prototype.html'), `<!doctype html><meta name="reader-token" content="__READER_TOKEN__"><script id="payload" type="application/json">{"generated":1,"text":"${BIG}"}</script>`);
  fs.writeFileSync(path.join(out, 'prototype.stamp'), '1');
  fs.writeFileSync(path.join(out, 'sessions.txt'), '');
  return root;
}

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// The answer with its body as sent (bytes) and as a browser would read it (decoded).
const get = (port, urlPath, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { Host: 'localhost:' + port, ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const sent = Buffer.concat(chunks);
      const coding = res.headers['content-encoding'];
      const body = coding === 'gzip' ? zlib.gunzipSync(sent) : coding === 'br' ? zlib.brotliDecompressSync(sent) : sent;
      resolve({ status: res.statusCode, headers: res.headers, sent, text: body.toString('utf8') });
    });
  }).on('error', reject).end();
});

const OPEN = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
const PAGE = '/setup/transcript-reader/out/prototype.html';

async function withServer(run) {
  const root = repoCopy();
  const port = await freePort();
  const server = await start({ root, port });
  try { await run(port, root); } finally { server.close(); }
}

test('negotiation: br wins at equal weight, q=0 refuses, a heavier gzip wins, "*" stands for any coding', () => {
  assert.strictEqual(negotiate('gzip, deflate, br'), 'br');
  assert.strictEqual(negotiate('gzip'), 'gzip');
  assert.strictEqual(negotiate('br;q=0.5, gzip;q=0.9'), 'gzip');
  assert.strictEqual(negotiate('br;q=0, gzip'), 'gzip');
  assert.strictEqual(negotiate('br;q=0, gzip;q=0'), null);
  assert.strictEqual(negotiate('*'), 'br');
  assert.strictEqual(negotiate('identity'), null);
  assert.strictEqual(negotiate('GZIP'), 'gzip');
  assert.strictEqual(negotiate('gzip;q=junk'), null);
  assert.strictEqual(negotiate(undefined), null);
  assert.strictEqual(negotiate(''), null);
});

test('the built page is compressed when the browser accepts it, and arrives as the same text with the token filled in', async () => {
  await withServer(async (port) => {
    const plain = await get(port, PAGE, OPEN);
    assert.strictEqual(plain.status, 200);
    assert.strictEqual(plain.headers['content-encoding'], undefined, 'no Accept-Encoding, no encoding');
    assert.match(plain.text, /content="[0-9a-f]{64}"/);
    for (const [coding, accept] of [['gzip', 'gzip'], ['br', 'gzip, deflate, br']]) {
      const packed = await get(port, PAGE, { ...OPEN, 'Accept-Encoding': accept });
      assert.strictEqual(packed.status, 200, coding);
      assert.strictEqual(packed.headers['content-encoding'], coding);
      assert.match(packed.headers.vary, /Accept-Encoding/i);
      assert.strictEqual(packed.headers['content-length'], undefined, 'the length is of the plain text, so it goes');
      assert.ok(packed.sent.length < plain.sent.length / 10, `${coding}: ${packed.sent.length} of ${plain.sent.length} bytes`);
      // Everything else the page carries is unchanged: its headers, and its text apart from the per-start token.
      for (const name of ['content-type', 'cache-control', 'content-security-policy', 'x-frame-options', 'cross-origin-opener-policy', 'referrer-policy', 'x-content-type-options', 'x-transcript-reader-server', 'x-transcript-reader-copy']) {
        assert.strictEqual(packed.headers[name], plain.headers[name], `${coding} ${name}`);
      }
      assert.strictEqual(packed.text, plain.text);
    }
  });
});

test('API JSON is compressed too, and the guard still answers first: no token, no body, compressed or not', async () => {
  await withServer(async (port) => {
    const page = await get(port, PAGE, OPEN);
    const token = page.text.match(/content="([0-9a-f]{64})"/)[1];
    const headers = { 'x-transcript-reader-token': token, 'Accept-Encoding': 'gzip' };
    const full = await get(port, '/api/transcript-reader/page?name=prototype.html', headers);
    assert.strictEqual(full.status, 200);
    assert.strictEqual(full.headers['content-encoding'], 'gzip');
    assert.strictEqual(full.headers['content-type'], 'application/json');
    assert.strictEqual(JSON.parse(full.text).status, 'ok');
    assert.ok(!full.text.includes(token), 'the JSON page carries the unfilled token tag, never the token');
    const refused = await get(port, '/api/transcript-reader/page?name=prototype.html', { 'Accept-Encoding': 'gzip' });
    assert.strictEqual(refused.status, 403);
    assert.ok(!refused.text.includes(token));
    // A wrong Host is refused before any of it.
    const rebinding = await get(port, PAGE, { ...OPEN, 'Accept-Encoding': 'gzip', Host: 'evil.example:' + port });
    assert.strictEqual(rebinding.status, 403);
  });
});

test('what is not worth or not safe to compress goes as it was: errors, HEAD, and a coding the browser refused', async () => {
  await withServer(async (port) => {
    const missing = await get(port, '/nothing-here', { 'Accept-Encoding': 'gzip' });
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.headers['content-encoding'], undefined, 'only a 200 is compressed');
    assert.strictEqual(missing.text, 'Not found');
    const head = await get(port, PAGE, { ...OPEN, 'Accept-Encoding': 'gzip' }, 'HEAD');
    assert.strictEqual(head.headers['content-encoding'], undefined);
    const refused = await get(port, PAGE, { ...OPEN, 'Accept-Encoding': 'gzip;q=0, br;q=0' });
    assert.strictEqual(refused.headers['content-encoding'], undefined);
    assert.match(refused.text, /payload/);
  });
});

test('a large answer streams through in order and a client that leaves mid-answer leaves no stuck server', async () => {
  const root = repoCopy();
  const out = path.join(root, 'setup', 'transcript-reader', 'out');
  const text = (BIG + '\n').repeat(300);
  fs.writeFileSync(path.join(out, 'prototype.html'), `<!doctype html><meta name="reader-token" content="__READER_TOKEN__"><script id="payload" type="application/json">{"generated":1,"text":"${text.replace(/\n/g, ' ')}"}</script>`);
  const port = await freePort();
  const server = await start({ root, port });
  try {
    const packed = await get(port, PAGE, { ...OPEN, 'Accept-Encoding': 'br' });
    assert.strictEqual(packed.headers['content-encoding'], 'br');
    assert.ok(packed.text.includes(text.slice(0, 5000).replace(/\n/g, ' ')));
    await new Promise((resolve) => {
      const request = http.get({ host: '127.0.0.1', port, path: PAGE, headers: { Host: 'localhost:' + port, ...OPEN, 'Accept-Encoding': 'gzip' } }, (res) => { res.once('data', () => { request.destroy(); setTimeout(resolve, 50); }); });
      request.on('error', () => {});
    });
    assert.strictEqual((await get(port, PAGE, { ...OPEN, 'Accept-Encoding': 'gzip' })).status, 200);
  } finally { server.close(); }
});
