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
//        [--https-host <machine>.<tailnet>.ts.net --https-port <port> --cert-file <crt> --key-file <key>]
//
// With --tailnet-ip it also listens on that one address, on the same port, for the owner's
// phone (tailnet.js: a passcode first). Without it, or without a passcode file, loopback only.
// With the --https-* options too it adds a TLS listener on that address under the machine's Tailscale name
// (serve.sh --tailnet-https fetches the certificate with tailscale cert), with the same passcode gate: the phone
// needs a secure address for an offline copy. The plain listener keeps serving beside it.
//
// Every answer, 404s included, carries the copy header api.js puts on the pages, plus
// x-transcript-reader-server, so serve.sh and reader.py can tell which copy of the repo
// answers on a port (and that it is a reader server at all).

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const path = require('path');
const { create, COPY_HEADER, copyId } = require('./api');
const { isTailnetAddress } = require('./tailnet');

const DEFAULT_PORT = 8768;
const SERVER_HEADER = 'x-transcript-reader-server';
const CERT_RECHECK_MS = 60 * 60 * 1000;

// Listens on loopback only, IPv4 and IPv6 (a bare listen would expose the reader to the network),
// plus, when tailnet is { ip, passcodeFile[, port, https] } and the passcode file holds a hash, that one
// address (never 0.0.0.0 or another interface). https is { host, port, certFile, keyFile }: a TLS listener
// on that same address under the machine's Tailscale name, which the Tailscale certificate (tailscale cert)
// is for. It never replaces the plain listener, and a certificate that is missing, unreadable or for another
// name leaves the plain one serving and says why in `httpsError`. A tailnet listener that cannot bind leaves
// loopback serving and says why in `tailnetError`. Resolves to { port, tailnet, tailnetError, httpsError,
// close }, tailnet being { ip, port[, https] } (https { host, port, expires }, only when served) or null.
function start({ root, port = DEFAULT_PORT, tailnet = null, ...options }) {
  if (tailnet && (!tailnet.ip || ['0.0.0.0', '::', '::0'].includes(tailnet.ip) || net.isIP(tailnet.ip) !== 4)) throw new Error('The tailnet listener needs one IPv4 address');
  let tls = null;
  let httpsError = null;
  if (tailnet && tailnet.https) {
    tls = readCertificate(tailnet.https);
    if (tls.error) { httpsError = tls.error; tls = null; }
  }
  const api = create({ root, port, ...(tailnet ? { tailnet: { ...tailnet, https: tls ? { host: tailnet.https.host.toLowerCase(), port: tailnet.https.port } : undefined } } : {}), ...options });
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
        const done = (extra) => resolve({ port: bound, tailnet: null, tailnetError: null, httpsError, ...extra });
        if (!tailnet) { done({ close: closeLoopback }); return; }
        if (!api.tailnet.hasPasscode()) { done({ tailnetError: 'no passcode is set', httpsError: tailnet.https ? 'no passcode is set' : null, close: closeLoopback }); return; }
        const tn = http.createServer(onRequest('tailnet'));
        tn.on('error', (error) => {
          if (tn.listening) { process.stderr.write(`Tailnet listener error: ${error.code || error.message}\n`); return; }
          done({ tailnetError: `${tailnet.ip}:${tailnet.port || bound} could not be bound (${error.code || error.message})`, httpsError: tailnet.https ? 'the plain tailnet listener could not be bound' : null, close: closeLoopback });
        });
        tn.listen(tailnet.port || bound, tailnet.ip, () => {
          const plain = { ip: tailnet.ip, port: tn.address().port };
          const finish = (secure) => {
            const stops = [closeLoopback, () => tn.close()];
            if (secure) stops.push(secure.close);
            done({ tailnet: secure ? { ...plain, https: secure.info } : plain, httpsError, close: () => stops.forEach((stop) => stop()) });
          };
          if (!tls) { finish(null); return; }
          const tlsServer = https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, onRequest('tailnet-https'));
          // A renewed certificate (tailscale cert again, or serve.sh cert) is picked up without a restart.
          const watch = setInterval(() => {
            const fresh = readCertificate(tailnet.https);
            if (!fresh.error && fresh.stamp !== tls.stamp) { tls = fresh; tlsServer.setSecureContext({ cert: fresh.cert, key: fresh.key }); }
          }, tailnet.https.recheckMs || CERT_RECHECK_MS);
          watch.unref();
          tlsServer.on('error', (error) => {
            if (tlsServer.listening) { process.stderr.write(`Tailnet HTTPS listener error: ${error.code || error.message}\n`); return; }
            clearInterval(watch);
            httpsError = `${tailnet.ip}:${tailnet.https.port} could not be bound (${error.code || error.message})`;
            finish(null);
          });
          tlsServer.listen(tailnet.https.port, tailnet.ip, () => finish({
            info: { host: tailnet.https.host.toLowerCase(), port: tlsServer.address().port, expires: tls.expires },
            close: () => { clearInterval(watch); tlsServer.close(); },
          }));
        });
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

// The TLS certificate and key files, or { error } saying in one plain sentence what is wrong. stamp changes when
// either file does, so a renewed certificate is noticed.
function readCertificate({ host, certFile, keyFile }) {
  // A Tailscale name has dots (<machine>.<tailnet>.ts.net); "localhost" is also taken, for a scratch certificate in a test.
  if (typeof host !== 'string' || net.isIP(host) || /^[\d.]+$/.test(host) || (host !== 'localhost' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host))) return { error: 'the machine has no Tailscale name to serve HTTPS under' };
  let cert;
  let key;
  let stamp;
  try {
    cert = fs.readFileSync(certFile);
    key = fs.readFileSync(keyFile);
    stamp = [certFile, keyFile].map((file) => fs.statSync(file).mtimeMs).join(':');
  } catch { return { error: `the Tailscale certificate is not there (${certFile}); turn on HTTPS certificates for the tailnet, then run serve.sh cert` }; }
  let parsed;
  try {
    parsed = new crypto.X509Certificate(cert);
    tls.createSecureContext({ cert, key });
  } catch { return { error: 'the Tailscale certificate or its key cannot be read' }; }
  if (!parsed.checkHost(host)) return { error: `the Tailscale certificate is not for ${host}` };
  if (Date.parse(parsed.validTo) <= Date.now()) return { error: 'the Tailscale certificate has expired; run serve.sh cert to renew it' };
  return { cert, key, stamp, expires: Date.parse(parsed.validTo) / 1000 };
}

function main(argv) {
  const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const port = Number(option('--port', process.env.PMOS_READER_PORT || DEFAULT_PORT));
  const root = path.resolve(option('--root', path.join(__dirname, '..', '..')));
  if (!Number.isInteger(port) || port < 1 || port > 65535) { process.stderr.write('Invalid port\n'); process.exit(2); }
  const tailnetIp = option('--tailnet-ip', '');
  const passcodeFile = option('--passcode-file', path.join(__dirname, 'out', 'passcode.json'));
  if (tailnetIp && !isTailnetAddress(tailnetIp)) { process.stderr.write(`Not a Tailscale address: ${tailnetIp}\n`); process.exit(2); }
  const httpsHost = option('--https-host', '');
  const https_ = httpsHost ? { host: httpsHost, port: Number(option('--https-port', '8443')), certFile: option('--cert-file', ''), keyFile: option('--key-file', '') } : null;
  if (https_ && (!tailnetIp || !Number.isInteger(https_.port) || https_.port < 1 || https_.port > 65535)) { process.stderr.write('--https-host needs --tailnet-ip and a valid --https-port\n'); process.exit(2); }
  start({ root, port, tailnet: tailnetIp ? { ip: tailnetIp, passcodeFile, ...(https_ ? { https: https_ } : {}) } : null }).then((server) => {
    process.stdout.write(`Transcript reader serving ${root} on http://localhost:${port}\n`);
    if (server.tailnet) process.stdout.write(`Tailnet: also serving http://${server.tailnet.ip}:${server.tailnet.port}, passcode required\n`);
    else if (tailnetIp) process.stdout.write(`Tailnet: not served, ${server.tailnetError}\n`);
    if (server.tailnet && server.tailnet.https) process.stdout.write(`Tailnet HTTPS: https://${server.tailnet.https.host}:${server.tailnet.https.port}, passcode required, certificate valid until ${new Date(server.tailnet.https.expires * 1000).toISOString().slice(0, 10)}\n`);
    else if (https_) process.stdout.write(`Tailnet HTTPS: not served, ${server.httpsError}\n`);
  }, (error) => {
    process.stderr.write(`Could not listen on port ${port}: ${error.message}\n`);
    process.exit(1);
  });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { start, isTailnetAddress, DEFAULT_PORT, SERVER_HEADER };
