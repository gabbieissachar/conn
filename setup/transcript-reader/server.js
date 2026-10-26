#!/usr/bin/env node
'use strict';

// The transcript reader's own server: its built pages and /api/transcript-reader/*, on
// its own port and in its own process, started and stopped by serve.sh in this folder.
// Nothing else is served, so no other app shares the pages' origin (the pages embed
// private transcripts). Every request goes to api.js, which holds the guard; a path it
// does not claim is a 404.
//
//   node setup/transcript-reader/server.js [--port 8768] [--root <repo root>]
//        [--tailnet-ip <Tailscale IPv4> --passcode-file <file>]
//
// With --tailnet-ip it also listens on that one address, on the same port, for the owner's
// phone (tailnet.js: a passcode first). Without it, or without a passcode file, loopback only.
//
// Every answer, 404s included, carries the copy header api.js puts on the pages, plus
// x-transcript-reader-server, so serve.sh and reader.py can tell which copy of the repo
// answers on a port (and that it is a reader server at all).

const http = require('http');
const net = require('net');
const path = require('path');
const { create, COPY_HEADER, copyId } = require('./api');

const DEFAULT_PORT = 8768;
const TAILNET_RANGE = [100 * 2 ** 24 + 64 * 2 ** 16, 100 * 2 ** 24 + 128 * 2 ** 16];  // 100.64.0.0/10, Tailscale's addresses
const SERVER_HEADER = 'x-transcript-reader-server';

// Whether text is a Tailscale IPv4 address, the only kind the tailnet listener may bind.
function isTailnetAddress(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return false;
  const value = parts.reduce((sum, part) => sum * 256 + Number(part), 0);
  return value >= TAILNET_RANGE[0] && value < TAILNET_RANGE[1];
}

// Listens on loopback only, IPv4 and IPv6 (a bare listen would expose the reader to the network),
// plus, when tailnet is { ip, passcodeFile[, port] } and the passcode file holds a hash, that one
// address (never 0.0.0.0 or another interface). A tailnet listener that cannot bind leaves loopback
// serving and says why in `tailnetError`. Resolves to { port, tailnet, tailnetError, close }, tailnet
// being { ip, port } or null.
function start({ root, port = DEFAULT_PORT, tailnet = null, ...options }) {
  if (tailnet && (!tailnet.ip || ['0.0.0.0', '::', '::0'].includes(tailnet.ip) || net.isIP(tailnet.ip) !== 4)) throw new Error('The tailnet listener needs one IPv4 address');
  const api = create({ root, port, ...(tailnet ? { tailnet } : {}), ...options });
  const copy = copyId(root);
  const onRequest = (listener) => (req, res) => {
    res.setHeader(COPY_HEADER, copy);
    res.setHeader(SERVER_HEADER, '1');
    if (api.handle(req, res, listener)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Not found');
  };
  const v4 = http.createServer(onRequest('loopback'));
  const v6 = http.createServer(onRequest('loopback'));
  return new Promise((resolve, reject) => {
    v4.once('error', reject);
    v4.listen(port, '127.0.0.1', () => {
      const bound = v4.address().port;
      const ready = (closeLoopback) => {
        if (!tailnet) { resolve({ port: bound, tailnet: null, tailnetError: null, close: closeLoopback }); return; }
        if (!api.tailnet.hasPasscode()) { resolve({ port: bound, tailnet: null, tailnetError: 'no passcode is set', close: closeLoopback }); return; }
        const tn = http.createServer(onRequest('tailnet'));
        tn.on('error', (error) => {
          if (tn.listening) { process.stderr.write(`Tailnet listener error: ${error.code || error.message}\n`); return; }
          resolve({ port: bound, tailnet: null, tailnetError: `${tailnet.ip}:${tailnet.port || bound} could not be bound (${error.code || error.message})`, close: closeLoopback });
        });
        tn.listen(tailnet.port || bound, tailnet.ip, () => resolve({ port: bound, tailnet: { ip: tailnet.ip, port: tn.address().port }, tailnetError: null, close: () => { closeLoopback(); tn.close(); } }));
      };
      v6.once('error', (error) => {
        // No IPv6 loopback on this machine: IPv4 alone serves. Anything else, a port another
        // process holds on ::1 above all, would leave "localhost" reaching that process
        // (browsers try ::1 first), so the start fails.
        if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) ready(() => v4.close());
        else v4.close(() => reject(error));
      });
      v6.listen(bound, '::1', () => ready(() => { v4.close(); v6.close(); }));
    });
  });
}

function main(argv) {
  const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const port = Number(option('--port', process.env.PMOS_READER_PORT || DEFAULT_PORT));
  const root = path.resolve(option('--root', path.join(__dirname, '..', '..')));
  if (!Number.isInteger(port) || port < 1 || port > 65535) { process.stderr.write('Invalid port\n'); process.exit(2); }
  const tailnetIp = option('--tailnet-ip', '');
  const passcodeFile = option('--passcode-file', path.join(__dirname, 'out', 'passcode.json'));
  if (tailnetIp && !isTailnetAddress(tailnetIp)) { process.stderr.write(`Not a Tailscale address: ${tailnetIp}\n`); process.exit(2); }
  start({ root, port, tailnet: tailnetIp ? { ip: tailnetIp, passcodeFile } : null }).then((server) => {
    process.stdout.write(`Transcript reader serving ${root} on http://localhost:${port}\n`);
    if (server.tailnet) process.stdout.write(`Tailnet: also serving http://${server.tailnet.ip}:${server.tailnet.port}, passcode required\n`);
    else if (tailnetIp) process.stdout.write(`Tailnet: not served, ${server.tailnetError}\n`);
  }, (error) => {
    process.stderr.write(`Could not listen on port ${port}: ${error.message}\n`);
    process.exit(1);
  });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { start, isTailnetAddress, DEFAULT_PORT, SERVER_HEADER };
