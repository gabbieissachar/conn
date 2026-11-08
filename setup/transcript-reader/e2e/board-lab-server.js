'use strict';
// The Tasks board's lab server (board-check.js): the reader's api.js on its own port, no worker, no watcher, and a Herdr that is never there.
//   node board-lab-server.js <repo root> <port> [--marks] [--answer]
const http = require('http');
const path = require('path');
const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3]);
if (!Number.isInteger(port) || port === 8768 || port === 8765 || port === 8766) { process.stderr.write('pick another port\n'); process.exit(2); }
const { create } = require(path.join(root, 'setup', 'transcript-reader', 'api.js'));
const board = { enabled: true, marks: process.argv.includes('--marks'), answer: process.argv.includes('--answer'), send: process.argv.includes('--send') };
// A lab keeps its own reading list, hide list and fake Herdr (LAB_OUT, LAB_HIDDEN, LAB_HERDR); with none of them it reads nothing of the owner's (a Herdr that is never there).
const lab = process.env.LAB_OUT ? { outDir: process.env.LAB_OUT, hiddenFile: process.env.LAB_HIDDEN, pinsFile: process.env.LAB_HIDDEN + '.pins', starsFile: process.env.LAB_HIDDEN + '.stars', sheetFlagsFile: process.env.LAB_HIDDEN + '.flags' } : {};
const api = create({ root, port, herdrBin: process.env.LAB_HERDR || '/usr/bin/false', board, worker: false, watch: false, ...lab });
http.createServer((req, res) => { if (!api.handle(req, res, 'loopback')) { res.writeHead(404); res.end('Not found'); } })
  .listen(port, '127.0.0.1', () => process.stdout.write('board lab on ' + port + '\n'));
