'use strict';

// The reader's own server (server.js) and the check setup/serve.sh uses to keep the reader's
// out/ folder to itself. Run: node --test setup/transcript-reader/server.test.js

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { copyId, namesReaderOut, COPY_HEADER } = require('./api');
const { start, SERVER_HEADER, DEFAULT_PORT } = require('./server');

function repoCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-server-'));
  fs.mkdirSync(path.join(root, 'setup', 'transcript-reader', 'out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'setup', 'transcript-reader', 'out', 'prototype.html'), '<!doctype html><meta name="reader-token" content="__READER_TOKEN__">page');
  fs.writeFileSync(path.join(root, 'setup', 'transcript-reader', 'out', 'sessions.txt'), 'aaaaaaaa-1111-4111-8111-111111111111\n');
  fs.writeFileSync(path.join(root, 'notes.md'), 'a repo file another app may read');
  return root;
}

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const get = (port, urlPath, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: urlPath, headers: { Host: 'localhost:' + port, ...headers } }, (res) => {
    let raw = '';
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
  }).on('error', reject);
});

test('the default port is the reader\'s own, not another page\'s', () => {
  assert.strictEqual(DEFAULT_PORT, 8768);
  assert.ok(![8765, 8766, 8767].includes(DEFAULT_PORT));
});

test('every answer names the copy and the reader server, and only the reader\'s routes answer', async () => {
  const root = repoCopy();
  const port = await freePort();
  const server = await start({ root, port });
  try {
    const nothing = await get(port, '/');
    assert.strictEqual(nothing.status, 404);
    assert.strictEqual(nothing.headers[COPY_HEADER], copyId(root));
    assert.strictEqual(nothing.headers[SERVER_HEADER], '1');
    // Another app's file is not served here: this server holds nothing but the reader.
    const file = await get(port, '/notes.md');
    assert.strictEqual(file.status, 404);
    assert.ok(!file.raw.includes('another app'));
    assert.strictEqual(file.headers['access-control-allow-origin'], undefined);
    const page = await get(port, '/setup/transcript-reader/out/prototype.html', { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.headers[COPY_HEADER], copyId(root));
    assert.match(page.raw, /content="[0-9a-f]{64}"/);
    // The guard still holds on this origin: a wrong Host is refused.
    const rebinding = await get(port, '/setup/transcript-reader/out/prototype.html', { Host: 'evil.example:' + port });
    assert.strictEqual(rebinding.status, 403);
    const api = await get(port, '/api/transcript-reader/state');
    assert.strictEqual(api.status, 403, 'no token, no state');
  } finally { server.close(); }
});

test('a port already taken is an error, not a second server', async () => {
  const root = repoCopy();
  const port = await freePort();
  const first = await start({ root, port });
  try { await assert.rejects(start({ root, port }), /EADDRINUSE/); } finally { first.close(); }
});

test('the shared server refuses anything that names the reader\'s out/ folder, however it is spelled', () => {
  const root = repoCopy();
  const req = (url) => ({ url });
  for (const url of [
    '/setup/transcript-reader/out/prototype.html', '/setup/transcript-reader/out/sessions.txt', '/setup/transcript-reader/out/',
    '/setup/transcript-reader//out/prototype.html', '/setup/transcript-reader/out/../out/sessions.txt',
    '/setup/transcript-reader/%6fut/prototype.html', '/setup/transcript-reader/out/prototype.html?x=1', '/%zz',
  ]) assert.strictEqual(namesReaderOut(root, req(url)), true, url);
  for (const url of ['/notes.md', '/setup/transcript-reader/README.md', '/setup/serve.sh', '/']) assert.strictEqual(namesReaderOut(root, req(url)), false, url);
});
