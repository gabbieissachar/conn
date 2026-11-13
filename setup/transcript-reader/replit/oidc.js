'use strict';

// A small OpenID Connect client for the authorization-code flow with PKCE, on Node's built-ins
// alone. It works with JumpCloud (the Marking-Down sign-in) or Google: only the issuer differs.
// It checks the ID token it gets back (RS256 signature against the issuer's keys, issuer, audience,
// expiry, nonce) and returns its claims; whether the person may come in is the app's allow-list.

const crypto = require('crypto');

const TIMEOUT_MS = 10000;
const SKEW_SECONDS = 60;
const trimmed = (url) => String(url).replace(/\/+$/, '');

class OidcClient {
  // fetchImpl is a test hook; real runs use the global fetch. now() is in milliseconds.
  constructor({ issuer, clientId, clientSecret, redirectUri, fetchImpl = globalThis.fetch, now = Date.now }) {
    Object.assign(this, { issuer, clientId, clientSecret, redirectUri, fetchImpl, now });
    this.meta = null;
    this.metaAt = 0;
    this.keys = new Map();
  }

  async json(url, options = {}) {
    const response = await this.fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`The sign-in provider answered ${response.status}.`);
    return response.json();
  }

  async discover() {
    if (this.meta && this.now() - this.metaAt < 3600 * 1000) return this.meta;
    const meta = await this.json(`${trimmed(this.issuer)}/.well-known/openid-configuration`);
    if (trimmed(meta.issuer) !== trimmed(this.issuer)) throw new Error('The sign-in provider names a different issuer.');
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof meta[field] !== 'string') throw new Error(`The sign-in provider's configuration has no ${field}.`);
    }
    this.meta = meta;
    this.metaAt = this.now();
    return meta;
  }

  // Where to send the browser, and the secrets of this attempt to keep in the login cookie.
  async start() {
    const meta = await this.discover();
    const login = {
      state: crypto.randomBytes(24).toString('base64url'),
      nonce: crypto.randomBytes(24).toString('base64url'),
      verifier: crypto.randomBytes(48).toString('base64url'),
    };
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, redirect_uri: this.redirectUri, scope: 'openid email profile',
      state: login.state, nonce: login.nonce, code_challenge: crypto.createHash('sha256').update(login.verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), login };
  }

  // The verified claims of the ID token this code gives, or an Error.
  async finish(code, login) {
    const meta = await this.discover();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: login.verifier });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const methods = meta.token_endpoint_auth_methods_supported || ['client_secret_basic'];
    if (methods.includes('client_secret_basic')) {
      headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64');
    } else {
      form.set('client_id', this.clientId);
      form.set('client_secret', this.clientSecret);
    }
    const tokens = await this.json(meta.token_endpoint, { method: 'POST', headers, body: form.toString() });
    if (typeof tokens.id_token !== 'string') throw new Error('The sign-in provider returned no ID token.');
    return this.verify(tokens.id_token, login.nonce);
  }

  async keyFor(kid, refetch = true) {
    if (this.keys.has(kid)) return this.keys.get(kid);
    if (!refetch) return null;
    const { jwks_uri: uri } = await this.discover();
    const set = await this.json(uri);
    this.keys = new Map((set.keys || []).filter((jwk) => jwk.kty === 'RSA' && jwk.kid).map((jwk) => [jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })]));
    return this.keyFor(kid, false);
  }

  async verify(token, nonce) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('The ID token is malformed.');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header.alg !== 'RS256') throw new Error('The ID token is not signed with RS256.');
    const key = await this.keyFor(header.kid);
    if (!key) throw new Error('The ID token is signed with an unknown key.');
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error('The ID token signature is wrong.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (trimmed(claims.iss) !== trimmed(this.issuer)) throw new Error('The ID token is from another issuer.');
    if (!audience.includes(this.clientId) || (audience.length > 1 && claims.azp !== this.clientId)) throw new Error('The ID token is for another client.');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 + SKEW_SECONDS * 1000 <= this.now()) throw new Error('The ID token has expired.');
    if (typeof claims.iat === 'number' && claims.iat * 1000 - SKEW_SECONDS * 1000 > this.now()) throw new Error('The ID token is from the future.');
    if (claims.nonce !== nonce) throw new Error('The ID token answers another sign-in attempt.');
    return claims;
  }
}

module.exports = { OidcClient };
