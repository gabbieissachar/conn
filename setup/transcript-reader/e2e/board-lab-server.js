'use strict';
// The Tasks board's lab server (board-check.js): the reader's api.js on its own port, no worker, no watcher, and a Herdr that is never there.
//   node board-lab-server.js <repo root> <port> [--marks] [--answer] [--send] [--warm]
//        [--tailnet-ip <Tailscale IPv4> --passcode-file <file> --https-host <name> --https-port <port> --cert-file <crt> --key-file <key>]
// With --tailnet-ip it is also reachable from the phone the way the reader's own tailnet copy is (server.js start: the same passcode gate, HTTPS under the machine's
// Tailscale name), with the board's page and read routes on the TLS address only (api.js, board.tailnet). Its writes stay loopback-only.
const http = require('http');
const path = require('path');
const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3]);
if (!Number.isInteger(port) || port === 8768 || port === 8765 || port === 8766) { process.stderr.write('pick another port\n'); process.exit(2); }
const { create } = require(path.join(root, 'setup', 'transcript-reader', 'api.js'));
const board = { enabled: true, marks: process.argv.includes('--marks'), answer: process.argv.includes('--answer'), send: process.argv.includes('--send') };
// --warm: the board remembers its boards on disk (the board cache folder, PMOS_READER_BOARD_CACHE) and reads them all at start, as the reader does when it runs for real.
if (process.argv.includes('--warm')) { const { boardCacheDir } = require(path.join(root, 'setup', 'transcript-reader', 'board.js')); board.persistDir = boardCacheDir(process.env); board.warm = true; }
// A lab keeps its own reading list (LAB_OUT), hide list (LAB_HIDDEN, with its pins, stars and flags beside it) and fake Herdr (LAB_HERDR); each left out falls back to the
// reader's default, except that Herdr is then one that is never there. A lab on the owner's real data leaves LAB_HIDDEN out on purpose: a reply hidden there is hidden in the reader.
const lab = {
  ...(process.env.LAB_OUT ? { outDir: process.env.LAB_OUT } : {}),
  ...(process.env.LAB_HIDDEN ? { hiddenFile: process.env.LAB_HIDDEN, pinsFile: process.env.LAB_HIDDEN + '.pins', starsFile: process.env.LAB_HIDDEN + '.stars', sheetFlagsFile: process.env.LAB_HIDDEN + '.flags' } : {}),
};
const option = (name) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : ''; };
const tailnetIp = option('--tailnet-ip');
if (tailnetIp) {
  const { start } = require(path.join(root, 'setup', 'transcript-reader', 'server.js'));
  const httpsHost = option('--https-host');
  start({
    root, port, tailnet: { ip: tailnetIp, passcodeFile: option('--passcode-file'), ...(httpsHost ? { https: { host: httpsHost, port: Number(option('--https-port')), certFile: option('--cert-file'), keyFile: option('--key-file') } } : {}) },
    herdrBin: process.env.LAB_HERDR || '/usr/bin/false', board: { ...board, tailnet: true }, worker: false, watch: false, ...lab,
  }).then((server) => {
    process.stdout.write('board lab on ' + port + '\n');
    if (server.tailnet) process.stdout.write('tailnet ' + server.tailnet.ip + ':' + server.tailnet.port + (server.tailnet.https ? ' https ' + server.tailnet.https.host + ':' + server.tailnet.https.port : ' (no https: ' + server.httpsError + ')') + '\n');
    else process.stdout.write('tailnet not served: ' + server.tailnetError + '\n');
  }, (error) => { process.stderr.write('could not start: ' + error.message + '\n'); process.exit(1); });
} else {
  const api = create({ root, port, herdrBin: process.env.LAB_HERDR || '/usr/bin/false', board, worker: false, watch: false, ...lab });
  http.createServer((req, res) => { if (!api.handle(req, res, 'loopback')) { res.writeHead(404); res.end('Not found'); } })
    .listen(port, '127.0.0.1', () => process.stdout.write('board lab on ' + port + '\n'));
}
