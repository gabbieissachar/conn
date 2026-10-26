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
// Tailscale address, so that listener accepts nothing else. Left out, loopback as before.
function createGuard({ port, token, tokenHeader = TOKEN_HEADER, hosts = LOOPBACK_HOSTS } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('guard needs the served port');
  const serverToken = token || crypto.randomBytes(32).toString('hex');
  if (!Array.isArray(hosts) || !hosts.length) throw new Error('guard needs at least one host');
  const allowedHosts = new Set(hosts.map((host) => String(host).toLowerCase() + ':' + port));
  const allowedOrigins = new Set(hosts.map((host) => 'http://' + String(host).toLowerCase() + ':' + port));
  const tokenBuffer = Buffer.from(serverToken, 'utf8');

  function tokenMatches(candidate) {
    if (typeof candidate !== 'string') return false;
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    if (candidateBuffer.length !== tokenBuffer.length) return false;
    return crypto.timingSafeEqual(candidateBuffer, tokenBuffer);
  }

  // Returns { ok: true } or { ok: false, status, message }.
  function check(req, { requireToken = true } = {}) {
    const method = String(req.method || '').toUpperCase();
    if (method === 'OPTIONS') return { ok: false, status: 403, message: 'Cross-origin preflight is not allowed for this endpoint' };
    if (method !== 'GET' && method !== 'POST') return { ok: false, status: 405, message: 'Method not allowed' };

    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) return { ok: false, status: 403, message: 'Host not allowed for this endpoint' };

    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return { ok: false, status: 403, message: 'Cross-site request refused' };
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

  return { check, token: serverToken, tokenHeader };
}

module.exports = { createGuard, TOKEN_HEADER };
