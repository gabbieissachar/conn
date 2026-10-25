'use strict';

// Signed cookies, with no server-side state: <payload>.<HMAC-SHA256>, both base64url. The payload
// names its kind ('session' or 'login') and an expiry, so a login-flow cookie never passes as a
// session. Changing SESSION_SECRET signs everyone out.

const crypto = require('crypto');

const mac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest();

function sign(secret, kind, data, seconds, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...data, k: kind, exp: Math.floor(now / 1000) + seconds })).toString('base64url');
  return `${body}.${mac(secret, body).toString('base64url')}`;
}

// The payload when the token is ours, of this kind and not expired; else null.
function verify(secret, kind, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [body, tag, extra] = token.split('.');
  if (!body || !tag || extra !== undefined) return null;
  const given = Buffer.from(tag, 'base64url');
  const expected = mac(secret, body);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || data.k !== kind || typeof data.exp !== 'number' || data.exp * 1000 <= now) return null;
  return data;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

// A Set-Cookie value. A secure deployment gets the __Host- prefix's guarantees (Secure, Path=/, no Domain).
function cookie(name, value, { seconds, secure }) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}

module.exports = { sign, verify, parseCookies, cookie };
