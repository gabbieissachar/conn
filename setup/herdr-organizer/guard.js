'use strict';

// Cross-site protection for the Herdr organizer API.
//
// serve.sh sends Access-Control-Allow-Origin: * on its other routes, so any web
// page the user visits could call a localhost endpoint. Every route handled by
// this module therefore requires, all at once:
//   - a Host header naming loopback on the served port (defeats DNS rebinding),
//   - an Origin header equal to the served origin on POST (and equal when sent on GET),
//   - Sec-Fetch-Site same-origin or none when the browser sends it,
//   - application/json bodies on POST,
//   - the per-server-start token in a custom header (forces a CORS preflight for
//     any cross-site caller, and the preflight is always refused).
// None of these routes ever sends an Access-Control-Allow-* header.

const crypto = require('crypto');

const TOKEN_HEADER = 'x-herdr-organizer-token';
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// tokenHeader lets another module behind the same server (the transcript reader)
// use the same checks with its own token and header name. hosts replaces the loopback
// names the Host and Origin must carry: the reader's tailnet listener passes its one
// Tailscale address, so that listener accepts nothing else. Left out, loopback as before. scheme is
// the one the served origin uses: "https" for the reader's TLS listener, whose Origin is https://<name>:<port>.
// onRefuse(req, verdict) is told of every refusal, once, as it is made (the reader writes it to its log); it cannot change the
// answer, and a throw in it is ignored. A check made with { quiet: true } is a probe whose refusal is not one (it is not told).
function createGuard({ port, token, tokenHeader = TOKEN_HEADER, hosts = LOOPBACK_HOSTS, scheme = 'http', onRefuse } = {}) {
  if (scheme !== 'http' && scheme !== 'https') throw new Error('guard scheme is http or https');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('guard needs the served port');
  const serverToken = token || crypto.randomBytes(32).toString('hex');
  if (!Array.isArray(hosts) || !hosts.length) throw new Error('guard needs at least one host');
  const allowedHosts = new Set(hosts.map((host) => String(host).toLowerCase() + ':' + port));
  const allowedOrigins = new Set(hosts.map((host) => scheme + '://' + String(host).toLowerCase() + ':' + port));
  const tokenBuffer = Buffer.from(serverToken, 'utf8');
  // The address this guard serves, as a browser writes it (the first of its hosts): where a refused page load is told to go instead.
  const origin = scheme + '://' + String(hosts[0]).toLowerCase() + ':' + port;

  function tokenMatches(candidate) {
    if (typeof candidate !== 'string') return false;
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    if (candidateBuffer.length !== tokenBuffer.length) return false;
    return crypto.timingSafeEqual(candidateBuffer, tokenBuffer);
  }

  // Returns { ok: true } or { ok: false, status, message[, fetchSite] }, fetchSite being the Sec-Fetch-Site value that was refused. crossSite (for a GET only) lets a
  // request through that Fetch-Metadata calls cross-site: what a sandboxed page without its own
  // origin loads for itself (the reader's HTML viewer, whose address is its own credential). The
  // Host and Origin checks stay, so a page on another site still cannot read it.
  function evaluate(req, { requireToken = true, crossSite = false } = {}) {
    const method = String(req.method || '').toUpperCase();
    if (method === 'OPTIONS') return { ok: false, status: 403, message: 'Cross-origin preflight is not allowed for this endpoint' };
    if (method !== 'GET' && method !== 'POST') return { ok: false, status: 405, message: 'Method not allowed' };

    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) return { ok: false, status: 403, message: 'Host not allowed for this endpoint' };

    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none' && !(crossSite && method === 'GET')) {
      return { ok: false, status: 403, message: 'Cross-site request refused', fetchSite };
    }

    const origin = req.headers.origin;
    if (origin === undefined) {
      if (method === 'POST') return { ok: false, status: 403, message: 'Origin header required' };
    } else if (!allowedOrigins.has(String(origin).toLowerCase())) {
      return { ok: false, status: 403, message: 'Origin not allowed for this endpoint' };
    }

    if (method === 'POST') {
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') return { ok: false, status: 415, message: 'JSON body required' };
    }

    if (requireToken && !tokenMatches(req.headers[tokenHeader])) {
      return { ok: false, status: 403, message: 'Missing or invalid token' };
    }
    return { ok: true };
  }

  function check(req, options = {}) {
    const verdict = evaluate(req, options);
    if (!verdict.ok && onRefuse && !options.quiet) {
      try { onRefuse(req, verdict); } catch { /* a log that cannot be written changes no answer */ }
    }
    return verdict;
  }

  return { check, token: serverToken, tokenHeader, origin };
}

module.exports = { createGuard, TOKEN_HEADER };
