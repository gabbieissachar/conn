#!/usr/bin/env node
'use strict';

// The reader's own server for the phone end-to-end run (phone-e2e.js): this copy's server.js over a scratch out/ folder, a scratch
// passcode file and a scratch TLS certificate, on spare ports, with the fake Herdr first on PATH. Started and stopped by the driver,
// which restarts it to show the phone reaching the laptop again. It never reads the owner's passcode, certificate or pins file.
//
//   node serve.js <run folder> <port> <plain tailnet port> <https port> <host>

const fs = require('fs');
const path = require('path');
const { start } = require('../server');

const [folder, port, plainPort, httpsPort, host] = process.argv.slice(2);
// The pages are served under /setup/transcript-reader/out/ of a repo root, so the run gets a root of its own whose out/ is the run's.
const root = path.join(folder, 'repo');
fs.mkdirSync(path.join(root, 'setup', 'transcript-reader'), { recursive: true });
const link = path.join(root, 'setup', 'transcript-reader', 'out');
if (!fs.existsSync(link)) fs.symlinkSync(path.join(folder, 'out'), link);
const home = path.join(folder, 'home');

start({
  root, port: Number(port),
  tailnet: {
    ip: '127.0.0.1', port: Number(plainPort), passcodeFile: path.join(folder, 'passcode.json'),
    https: { host, port: Number(httpsPort), certFile: path.join(folder, 'cert', 'cert.pem'), keyFile: path.join(folder, 'cert', 'key.pem') },
  },
  env: { ...process.env, PATH: path.join(folder, 'bin') + path.delimiter + process.env.PATH, PMOS_READER_STARS: path.join(folder, 'stars.json'), FAKE_HERDR_SESSION: process.env.FAKE_HERDR_SESSION, FAKE_HERDR_LOG: path.join(folder, 'herdr.log') },
  pinsFile: path.join(folder, 'pins.json'), starsFile: path.join(folder, 'stars.json'), projectsDir: path.join(home, '.claude', 'projects'), claudeSessionsDir: path.join(home, '.claude', 'sessions'),
}).then((server) => {
  process.stdout.write(`READY ${JSON.stringify({ port: server.port, tailnet: server.tailnet, httpsError: server.httpsError })}\n`);
}, (error) => { process.stderr.write(`FAILED ${error.message}\n`); process.exit(1); });
