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

test('a port another process holds on IPv6 loopback alone is an error too, since localhost would reach it', async () => {
  const port = await freePort();
  const other = net.createServer();
  const listening = await new Promise((resolve) => { other.once('error', () => resolve(false)); other.listen(port, '::1', () => resolve(true)); });
  if (!listening) return;  // no IPv6 loopback here: nothing to collide with
  try {
    await assert.rejects(start({ root: repoCopy(), port }), { code: 'EADDRINUSE' });
    // The IPv4 side it had bound is let go again.
    const free = await new Promise((resolve) => { const s = net.createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
    assert.ok(free);
  } finally {
    other.close();
  }
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

// A copy of the reader's server files in a fresh repo-shaped folder, so serve.sh writes its
// out/ folder and log there rather than in this repo copy.
function serverCopy() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-serve-')));
  const organizer = path.join(__dirname, '..', 'herdr-organizer');
  const files = [[__dirname, 'transcript-reader', ['serve.sh', 'server.js', 'api.js', 'pinstore.js']],
    [organizer, 'herdr-organizer', fs.readdirSync(organizer).filter((name) => name.endsWith('.js'))]];
  for (const [from, folder, names] of files) {
    fs.mkdirSync(path.join(root, 'setup', folder), { recursive: true });
    for (const name of names) fs.copyFileSync(path.join(from, name), path.join(root, 'setup', folder, name));
  }
  return root;
}

// serve.sh end to end, on a free port: started with its output piped (as a caller capturing it
// would), it must return, serve this copy, refuse a second start on another copy's port, and stop.
test('serve.sh starts, reports, restarts and stops this copy\'s server without hanging a piped caller', { timeout: 60000 }, async () => {
  const { execFile } = require('child_process');
  const root = serverCopy();
  const here = path.join(root, 'setup', 'transcript-reader');
  const script = path.join(here, 'serve.sh');
  const umask = process.umask(0o022);  // the usual default, which would leave new files readable by all
  const run = (...args) => new Promise((resolve) => execFile('bash', [script, ...args], { timeout: 20000, env: { ...process.env, PMOS_READER_PORT: '' } }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout })));
  const port = String(await freePort());
  try {
    const started = await run('start', '--port', port);
    assert.strictEqual(started.code, 0, started.stdout);
    assert.match(started.stdout, /Reader server started/);
    // out/ holds private transcript text: owner-only, like Claude's logs, whatever the umask.
    const mode = (file) => fs.statSync(file).mode & 0o777;
    assert.strictEqual(mode(path.join(here, 'out')), 0o700);
    assert.strictEqual(mode(path.join(here, 'out', `server-${port}.log`)), 0o600);
    assert.match((await run('status', '--port', port)).stdout, /serves this copy of the repo/);
    assert.match((await run('start', '--port', port)).stdout, /already running/);
    const answer = await get(Number(port), '/');
    assert.strictEqual(answer.headers[COPY_HEADER], copyId(root));
    assert.match((await run('restart', '--port', port)).stdout, /Stopped[\s\S]*started/);
  } finally {
    assert.match((await run('stop', '--port', port)).stdout, /Stopped the reader server/);
  }
  assert.match((await run('status', '--port', port)).stdout, /Nothing listens/);
  const refused = await run('start', '--port', '8765');
  assert.strictEqual(refused.code, 2);
  assert.ok(!fs.existsSync(path.join(__dirname, 'out', `server-${port}.log`)), 'nothing written in this repo copy');
  process.umask(umask);
});
