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
  const files = [[__dirname, 'transcript-reader', ['serve.sh', 'server.js', 'api.js', 'pinstore.js', 'tailnet.js', 'passcode.js']],
    [organizer, 'herdr-organizer', fs.readdirSync(organizer).filter((name) => name.endsWith('.js'))]];
  for (const [from, folder, names] of files) {
    fs.mkdirSync(path.join(root, 'setup', folder), { recursive: true });
    for (const name of names) fs.copyFileSync(path.join(from, name), path.join(root, 'setup', folder, name));
  }
  fs.copyFileSync(path.join(__dirname, '..', 'tailnet-lib.sh'), path.join(root, 'setup', 'tailnet-lib.sh'));  // sourced by serve.sh
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

// The phone address is opt-in, and serve.sh says why it stays off. A fake `tailscale` on the PATH
// stands in for the real one; the real address is bound in tailnet.test.js.
test('serve.sh --tailnet starts loopback only, with one line of why, when Tailscale is down or no passcode is set', { timeout: 60000 }, async () => {
  const { execFile } = require('child_process');
  const root = serverCopy();
  const here = path.join(root, 'setup', 'transcript-reader');
  const script = path.join(here, 'serve.sh');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-fake-tailscale-'));
  const fake = (body) => { fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  const passcodeFile = path.join(root, 'passcode.json');
  const run = (env, ...args) => new Promise((resolve) => execFile('bash', [script, ...args], { timeout: 20000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, PMOS_READER_PORT: '', PMOS_READER_TAILNET: '', PMOS_READER_PASSCODE_FILE: passcodeFile, ...env } }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout })));
  const port = String(await freePort());
  try {
    // Tailscale not running: loopback only, and the reason.
    fake('echo "Tailscale is stopped." >&2; exit 1');
    const down = await run({}, 'start', '--port', port, '--tailnet');
    assert.strictEqual(down.code, 0, down.stdout);
    assert.match(down.stdout, /Reader server started/);
    assert.match(down.stdout, /Tailnet address not served: Tailscale is not running/);
    assert.match((await run({}, 'status', '--port', port)).stdout, /Tailnet address not served \(loopback only\)/);
    // Already running without it: start says how to add it.
    assert.match((await run({}, 'start', '--port', port, '--tailnet')).stdout, /not serving the tailnet address[\s\S]*restart --tailnet/);
    assert.match((await run({}, 'stop', '--port', port)).stdout, /Stopped/);

    // An address outside Tailscale's range is never used.
    fake('echo 192.168.1.20');
    assert.match((await run({}, 'start', '--port', port, '--tailnet')).stdout, /Tailscale is not running or gave no IPv4 address/);
    await run({}, 'stop', '--port', port);

    // Tailscale up, no passcode yet: loopback only, and how to set one. The env var is the same switch.
    fake('echo 100.64.0.9');
    const unset = await run({ PMOS_READER_TAILNET: '1' }, 'start', '--port', port);
    assert.match(unset.stdout, /Tailnet address not served: no passcode is set. Set one with: bash .*serve\.sh passcode/);
    await run({}, 'stop', '--port', port);

    // Without the switch, nothing about the tailnet is attempted, even with a passcode.
    await require('./tailnet').writePasscodeFile(passcodeFile, 'a test passcode');
    const plain = await run({}, 'start', '--port', port);
    assert.ok(!/Tailnet/i.test(plain.stdout), plain.stdout);
    await run({}, 'stop', '--port', port);

    // An address Tailscale gave but this machine does not hold cannot be bound: loopback keeps serving.
    const unbound = await run({}, 'start', '--port', port, '--tailnet');
    assert.strictEqual(unbound.code, 0, unbound.stdout);
    assert.match(unbound.stdout, /Tailnet address not served: 100\.64\.0\.9:\d+ could not be bound/);
    assert.match((await run({}, 'status', '--port', port)).stdout, /serves this copy[\s\S]*not served \(loopback only\)/);
    assert.match(fs.readFileSync(path.join(here, 'out', `server-${port}.log`), 'utf8'), /Tailnet: not served, 100\.64\.0\.9:\d+ could not be bound/);
  } finally {
    await run({}, 'stop', '--port', port);
  }
});

test('serve.sh passcode takes the passcode only from a terminal and leaves no file otherwise', { timeout: 30000 }, async () => {
  const { execFile } = require('child_process');
  const root = serverCopy();
  const script = path.join(root, 'setup', 'transcript-reader', 'serve.sh');
  const passcodeFile = path.join(root, 'out-here', 'passcode.json');
  const result = await new Promise((resolve) => {
    const child = execFile('bash', [script, 'passcode'], { timeout: 10000, env: { ...process.env, PMOS_READER_PASSCODE_FILE: passcodeFile } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.end('a test passcode\na test passcode\n');
  });
  assert.notStrictEqual(result.code, 0);
  assert.match(result.stderr, /terminal/);
  assert.ok(!fs.existsSync(passcodeFile));
});

// --tailnet-https: the machine's Tailscale name comes from `tailscale status --json` (never typed in), the certificate
// from `tailscale cert`, and every way that can fail ends in one plain line with the plain address still serving.
// A fake `tailscale` stands in for the real one, so nothing here asks Tailscale for a certificate.
test('serve.sh --tailnet-https takes the name from Tailscale, fetches the certificate, and says plainly why it stays off', { timeout: 90000 }, async (t) => {
  const { execFile, execFileSync } = require('child_process');
  const root = serverCopy();
  const here = path.join(root, 'setup', 'transcript-reader');
  const script = path.join(here, 'serve.sh');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-fake-tailscale-'));
  const certDir = path.join(root, 'certs');
  const passcodeFile = path.join(root, 'passcode.json');
  const NAME = 'scratch-mac.scratch-net.ts.net';
  const real = (() => { try { return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim(); } catch { return ''; } })();
  const ip = real || '100.64.0.9';
  // The fake answers `ip -4`, `status --json` and `cert`, which it records and makes from a scratch certificate in $FAKE_CERT.
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh
case "$1" in
  ip) echo ${ip} ;;
  status) printf '%s' "$FAKE_STATUS" ;;
  cert) echo "$@" >> "$FAKE_LOG"
    case "$FAKE_CERT_MODE" in
      off) echo "500 Internal Server Error: your Tailscale account does not support getting TLS certs" >&2; exit 1 ;;
      other) echo "dial tcp: lookup failed" >&2; exit 1 ;;
    esac
    while [ $# -gt 0 ]; do case "$1" in --cert-file) cp "$FAKE_CERT/c.pem" "$2"; shift ;; --key-file) cp "$FAKE_CERT/k.pem" "$2"; shift ;; esac; shift; done ;;
esac
`, { mode: 0o755 });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-fake-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(scratch, 'k.pem'), '-out', path.join(scratch, 'c.pem'), '-days', '5', '-subj', '/CN=' + NAME, '-addext', 'subjectAltName=DNS:' + NAME], { stdio: 'ignore', timeout: 30000 });
  } catch { t.skip('openssl cannot make a scratch certificate here'); return; }
  const log = path.join(scratch, 'cert-calls.txt');
  const status = JSON.stringify({ Self: { DNSName: NAME + '.' } });
  const run = (env, ...args) => new Promise((resolve) => execFile('bash', [script, ...args], { timeout: 30000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, PMOS_READER_PORT: '', PMOS_READER_TAILNET: '', PMOS_READER_TAILNET_HTTPS: '', PMOS_READER_HTTPS_PORT: '', PMOS_READER_PASSCODE_FILE: passcodeFile, PMOS_READER_CERT_DIR: certDir, FAKE_STATUS: status, FAKE_LOG: log, FAKE_CERT: scratch, FAKE_CERT_MODE: '', ...env } }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout })));
  const port = String(await freePort());
  const httpsPort = String(await freePort());
  try {
    await require('./tailnet').writePasscodeFile(passcodeFile, 'a test passcode');
    // HTTPS certificates off for the tailnet: one plain reason, the plain tailnet address as before.
    const off = await run({ FAKE_CERT_MODE: 'off' }, 'start', '--port', port, '--tailnet-https');
    assert.match(off.stdout, /HTTPS address not served: HTTPS certificates are not turned on for this tailnet[\s\S]*Tailscale admin console/);
    assert.strictEqual((off.stdout.match(/HTTPS address not served/g) || []).length, 1, 'one line, not several');
    assert.match(off.stdout, /Reader server started/);
    await run({}, 'stop', '--port', port);
    // Some other failure: its last line, shortened.
    assert.match((await run({ FAKE_CERT_MODE: 'other' }, 'start', '--port', port, '--tailnet-https')).stdout, /HTTPS address not served: Could not get a Tailscale certificate: dial tcp: lookup failed/);
    await run({}, 'stop', '--port', port);
    // No machine name (MagicDNS off): nothing to serve HTTPS under, and nothing is asked of Tailscale.
    fs.writeFileSync(log, '');
    assert.match((await run({ FAKE_STATUS: '{"Self":{}}' }, 'start', '--port', port, '--tailnet-https')).stdout, /HTTPS address not served: this machine has no Tailscale name/);
    assert.strictEqual(fs.readFileSync(log, 'utf8'), '', 'tailscale cert was not run without a name');
    await run({}, 'stop', '--port', port);
    // The HTTPS switch itself is also an environment variable, and says the same.
    assert.match((await run({ PMOS_READER_TAILNET_HTTPS: '1', FAKE_CERT_MODE: 'off' }, 'start', '--port', port)).stdout, /HTTPS address not served/);
    await run({}, 'stop', '--port', port);
    // A bad HTTPS port is refused up front.
    for (const bad of ['80', '443', port, '8765', 'abc']) assert.strictEqual((await run({}, 'start', '--port', port, '--tailnet-https', '--https-port', bad)).code, 2, bad);

    if (!real) { t.diagnostic('no Tailscale address on this machine: the served-HTTPS path was not run'); return; }
    // The certificate is there: HTTPS is served under the name Tailscale reported, the cert files are owner-only, the
    // plain address still serves, and `status` says both.
    const ok = await run({}, 'start', '--port', port, '--tailnet-https', '--https-port', httpsPort);
    assert.match(ok.stdout, new RegExp(`Tailnet address served: http://${ip.replace(/\./g, '\\.')}:${port}`), ok.stdout);
    assert.match(ok.stdout, new RegExp(`HTTPS address served: https://${NAME.replace(/\./g, '\\.')}:${httpsPort} \\(passcode required\\)`), ok.stdout);
    assert.match(fs.readFileSync(log, 'utf8'), new RegExp(`cert --cert-file ${certDir}/${NAME}\\.crt --key-file ${certDir}/${NAME}\\.key ${NAME}`));
    assert.strictEqual(fs.statSync(certDir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(certDir, NAME + '.key')).mode & 0o777, 0o600);
    const state = await run({}, 'status', '--port', port, '--tailnet-https', '--https-port', httpsPort);
    assert.match(state.stdout, new RegExp(`HTTPS address served: https://${NAME.replace(/\./g, '\\.')}:${httpsPort}`));
    assert.match(fs.readFileSync(path.join(here, 'out', `server-${port}.log`), 'utf8'), /Tailnet HTTPS: https:\/\/scratch-mac\.scratch-net\.ts\.net:\d+, passcode required, certificate valid until \d{4}-\d{2}-\d{2}/);
    // serve.sh cert renews it by hand and says until when.
    assert.match((await run({}, 'cert')).stdout, new RegExp(`Certificate for ${NAME.replace(/\./g, '\\.')} is valid until \\d{4}-\\d{2}-\\d{2}`));
  } finally {
    await run({}, 'stop', '--port', port);
  }
});
