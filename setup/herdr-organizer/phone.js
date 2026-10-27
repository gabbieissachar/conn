'use strict';

// The Herdr organizer page on the owner's phone, over Tailscale. Opt-in: serve.sh adds this listener
// to the shared app server (port 8765) only when started with --tailnet, Tailscale answered with an
// address and a passcode is set. See DESIGN.md "Phone access".
//
// It is a listener of its own, bound to the one Tailscale address, with its own request handler.
// It never hands a request to the shared handler, so nothing that server serves (the other apps,
// the repo's files, its write routes) can be reached from the tailnet, whatever those routes do.
// What it answers is the explicit list below, and every other path is a 404:
//
//   GET  /apps/wip-herdr-workspace-organizer.html     the page (and, below, its own assets: none today)
//   POST /api/herdr-workspace-organizer/snapshot      the page's "Refresh snapshot": one fixed command
//   GET|POST /api/herdr-organizer/*                   the organizer API, under the tailnet guard
//   GET  /herdr-organizer/signin and /signout, POST /herdr-organizer/signin   the passcode
//
// Everything on the list but the sign-in routes needs a signed-in session first (the passcode page, the
// cookie, the sessions and the throttling are the transcript reader's own, in transcript-reader/tailnet.js,
// with this site's paths and words and the reader's passcode file: one sign-in opens both apps). The API
// then applies its usual checks, now for the tailnet origin: the Host and Origin must be exactly
// http://<tailscale ip>:<port>, plus Fetch-Metadata, JSON bodies, the per-start token and the
// one-change-at-a-time lock, as on loopback.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { isTailnetAddress, defaultPasscodeFile } = require('../transcript-reader/tailnet');
const { PREFIX, PAGE_PATH, ORGANIZER_SITE } = require('./api');
const { refreshSnapshot } = require('./snapshot-refresh');

const SNAPSHOT_ROUTE = '/api/herdr-workspace-organizer/snapshot';

// Files the page loads from this server, by the path it asks for: { file: repo-relative, type }.
// None today (the page is one self-contained file; its fonts come from Google). A test fails when
// the page starts to name a local file that is not listed here.
const ASSETS = new Map();

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'",
};

// What serve.sh passes to the node program once it has found a Tailscale address and a passcode:
// null when the switch is off, { ip, passcodeFile } when on (the reader's passcode file: one passcode, one sign-in). A value that is not a Tailscale address throws.
function tailnetFromEnv(env = process.env, root) {
  const ip = String(env.PMOS_SERVE_TAILNET_IP || '').trim();
  if (!ip) return null;
  if (!isTailnetAddress(ip)) throw new Error(`${ip} is not a Tailscale address (100.64.0.0/10)`);
  return { ip, passcodeFile: defaultPasscodeFile(root, env) };
}

// Which part of the list a path is on, or null. Exact match only: no prefix tricks, no decoding,
// no case folding, so a spelling the list does not name is a 404.
function classify(pathname, site, assets = ASSETS) {
  if (pathname === PAGE_PATH) return 'page';
  if (assets.has(pathname)) return 'asset';
  if (pathname === SNAPSHOT_ROUTE) return 'snapshot';
  if (pathname.startsWith(PREFIX)) return 'api';
  if (pathname === site.signin || pathname === site.signout) return 'signin';
  return null;
}

const plain = (res, status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(message); };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };

// api is the organizer API created with a tailnet option (api.tailnet is its sign-in lane).
// refresh and assets are injectable for tests.
function createHandler({ root, api, refresh = refreshSnapshot, assets = ASSETS }) {
  const lane = api.tailnet;
  if (!lane) throw new Error('The phone handler needs the organizer API created with a tailnet option');
  let refreshing = null;

  function serveFile(res, file, headers) {
    fs.readFile(file, (error, data) => {
      if (error) { plain(res, 404, 'Not found'); return; }
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  return function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { plain(res, 400, 'Bad request'); return; }
    const kind = classify(url.pathname, ORGANIZER_SITE, assets);
    if (!kind) { plain(res, 404, 'Not found'); return; }
    // The guard's Host, Origin and Fetch-Metadata checks, then the passcode session; a sign-in route is answered here.
    if (lane.intercept(req, res, url, kind === 'page')) return;
    if (kind === 'api') {
      if (!api.handle(req, res, 'tailnet')) plain(res, 404, 'Not found');
      return;
    }
    if (kind === 'snapshot') {
      if (req.method !== 'POST') { plain(res, 405, 'POST required'); return; }
      const verdict = lane.guard.check(req);
      if (!verdict.ok) { json(res, verdict.status, { status: 'error', code: 'refused', message: verdict.message }); return; }
      // One refresh at a time: a second tap while it runs shares its answer instead of starting another.
      if (!refreshing) refreshing = refresh(root).finally(() => { refreshing = null; });
      refreshing.then(({ status, body }) => json(res, status, body));
      return;
    }
    if (req.method !== 'GET') { plain(res, 405, 'GET required'); return; }
    if (kind === 'page') { serveFile(res, path.join(root, 'apps', path.basename(PAGE_PATH)), PAGE_HEADERS); return; }
    const asset = assets.get(url.pathname);
    serveFile(res, path.join(root, asset.file), { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  };
}

// Binds the one address given (never 0.0.0.0, never another interface) next to the loopback listeners
// serve.sh already has, when the passcode file holds a hash. Resolves to { ip, port, close, error }:
// error says why nothing listens (loopback keeps serving), ip and port say where the phone connects.
function listen({ root, api, tailnet, port, refresh, assets }) {
  const lane = api.tailnet;
  if (!lane) return Promise.resolve({ error: 'it was not asked for' });
  if (!tailnet || !tailnet.ip || ['0.0.0.0', '::', '::0'].includes(tailnet.ip)) return Promise.resolve({ error: 'it needs one Tailscale IPv4 address' });
  if (!lane.hasPasscode()) return Promise.resolve({ error: 'no passcode is set' });
  const bind = tailnet.port || port;
  const server = http.createServer(createHandler({ root, api, refresh, assets }));
  return new Promise((resolve) => {
    server.on('error', (error) => {
      if (server.listening) { process.stderr.write(`Tailnet listener error: ${error.code || error.message}\n`); return; }
      resolve({ error: `${tailnet.ip}:${bind} could not be bound (${error.code || error.message})` });
    });
    server.listen(bind, tailnet.ip, () => resolve({ ip: tailnet.ip, port: server.address().port, close: () => server.close() }));
  });
}

module.exports = { createHandler, listen, tailnetFromEnv, classify, ASSETS, PAGE_HEADERS, SNAPSHOT_ROUTE };
