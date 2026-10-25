#!/usr/bin/env node
'use strict';

// The transcript reader's own server: its built pages and /api/transcript-reader/*, on
// its own port and in its own process, started and stopped by serve.sh in this folder.
// Nothing else is served, so no other app shares the pages' origin (the pages embed
// private transcripts). Every request goes to api.js, which holds the guard; a path it
// does not claim is a 404.
//
//   node setup/transcript-reader/server.js [--port 8768] [--root <repo root>]
//
// Every answer, 404s included, carries the copy header api.js puts on the pages, plus
// x-transcript-reader-server, so serve.sh and reader.py can tell which copy of the repo
// answers on a port (and that it is a reader server at all).

const http = require('http');
const path = require('path');
const { create, COPY_HEADER, copyId } = require('./api');

const DEFAULT_PORT = 8768;
const SERVER_HEADER = 'x-transcript-reader-server';

// Listens on loopback only, IPv4 and IPv6 (a bare listen would expose the reader to the network).
// Resolves to { port, close }.
function start({ root, port = DEFAULT_PORT, ...options }) {
  const api = create({ root, port, ...options });
  const copy = copyId(root);
  const onRequest = (req, res) => {
    res.setHeader(COPY_HEADER, copy);
    res.setHeader(SERVER_HEADER, '1');
    if (api.handle(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Not found');
  };
  const v4 = http.createServer(onRequest);
  const v6 = http.createServer(onRequest);
  return new Promise((resolve, reject) => {
    v4.once('error', reject);
    v4.listen(port, '127.0.0.1', () => {
      const bound = v4.address().port;
      const ready = (close) => resolve({ port: bound, close });
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
  start({ root, port }).then(() => process.stdout.write(`Transcript reader serving ${root} on http://localhost:${port}\n`), (error) => {
    process.stderr.write(`Could not listen on port ${port}: ${error.message}\n`);
    process.exit(1);
  });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { start, DEFAULT_PORT, SERVER_HEADER };
