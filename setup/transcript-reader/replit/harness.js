'use strict';

// Test stand-ins, no network beyond 127.0.0.1: an OpenID provider (discovery, token endpoint,
// signing keys) and the app on a memory store. The tests play the browser themselves.
// Nothing here holds transcript content or a real credential; every secret is made up per run.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHandler } = require('./app');
const { loadConfig } = require('./config');
const keys = require('./keys');
const { OidcClient } = require('./oidc');
const { memoryStore } = require('./store');

let counter = 0;
const open = new Set();
const closeAll = () => Promise.all([...open].map((app) => app.close()));

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

// A stand-in provider. issue() gives the code the browser would come back with.
async function startIdp(clientSecret) {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  let base = '';
  const idp = { issuer: '', clientId: 'test-client', clientSecret, tokenCalls: 0 };
  const server = http.createServer((req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/.well-known/openid-configuration') {
      return reply(200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', jwks_uri: base + '/jwks', token_endpoint_auth_methods_supported: ['client_secret_post'] });
    }
    if (req.url === '/jwks') return reply(200, { keys: [jwk] });
    // For a browser rehearsal: with idp.autoEmail set, /authorize signs that person in without asking.
    if (req.url.startsWith('/authorize') && idp.autoEmail) {
      const query = new URL(req.url, base).searchParams;
      const handle = idp.issue(base + req.url, idp.autoEmail);
      res.writeHead(302, { location: `${query.get('redirect_uri')}?code=${handle}&state=${query.get('state')}` });
      return res.end();
    }
    if (req.url === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        idp.tokenCalls += 1;
        const form = new URLSearchParams(raw);
        const grant = codes.get(form.get('code'));
        codes.delete(form.get('code'));
        const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (!grant || form.get('client_secret') !== clientSecret || form.get('client_id') !== idp.clientId || challenge !== grant.challenge) return reply(400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: base, aud: idp.clientId, sub: 'user-1', iat: now, exp: now + 300, nonce: grant.nonce, email: grant.email, email_verified: true, ...grant.claims };
        const alg = grant.alg || 'RS256';
        const signing = `${b64({ alg, kid: 'k1' })}.${b64(claims)}`;
        const key = grant.badKey ? other.privateKey : pair.privateKey;
        // "none" and an HMAC keyed with the public key's bytes are the classic ways to forge a token.
        const tag = alg === 'none' ? '' : alg === 'HS256' ? crypto.createHmac('sha256', jwk.n).update(signing).digest().toString('base64url') : crypto.sign('RSA-SHA256', Buffer.from(signing), key).toString('base64url');
        reply(200, { id_token: `${signing}.${tag}`, token_type: 'Bearer' });
      });
      return;
    }
    reply(404, {});
  });
  const port = await listen(server);
  base = idp.issuer = `http://127.0.0.1:${port}`;
  // What the provider's login would do after the browser reaches /authorize: a code for this person.
  idp.issue = (authorizeUrl, email, extra = {}) => {
    const query = new URL(authorizeUrl).searchParams;
    const handle = String(++counter).padStart(8, '0');
    codes.set(handle, { email, nonce: query.get('nonce'), challenge: query.get('code_challenge'), ...extra });
    return handle;
  };
  idp.close = () => close(server);
  return idp;
}

// The app with its stand-in provider. Options: allowed (emails), env (config overrides), now (a clock).
async function startApp({ allowed = 'owner@example.com', env = {}, now } = {}) {
  const idp = await startIdp('test-client-credential');
  const store = memoryStore();
  const logs = [];
  let handler = null;
  const server = http.createServer((req, res) => handler(req, res));
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-shell-'));  // where the owner deploys the shell pages
  const config = loadConfig({
    SHELL_DIR: shellDir, APP_URL: base, OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret,
    SESSION_SECRET: 'test-session-signing-value-0123456789abcdef', ALLOWED_EMAILS: allowed, ...env,
  });
  const clock = now ? { now } : {};
  const oidc = new OidcClient({ issuer: config.issuer, clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri, ...clock });
  handler = createHandler({ config, store, oidc, log: (line) => logs.push(line), ...clock });
  const app = { base, config, store, idp, logs, port, oidc, shellDir };
  app.close = async () => { open.delete(app); await close(server); await idp.close(); };
  open.add(app);
  app.newKey = async (label) => (await keys.create(store, label)).key;
  return app;
}

// One request with exactly the path given (fetch would tidy ".." away). Resolves { status, headers, body }.
function request(app, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const cookieHeader = (response) => [].concat(response.headers['set-cookie'] || []).map((line) => line.split(';')[0]).filter((pair) => !pair.endsWith('=')).join('; ');

// Signs the browser in the way the provider would: start, the provider's code, the callback.
// Returns the Cookie header of the session, or { refused: <callback response> } when it is refused.
async function signIn(app, email, extra = {}) {
  const started = await request(app, 'GET', '/auth/start');
  if (started.status !== 302) return { refused: started };
  const login = cookieHeader(started);
  const state = new URL(started.headers.location).searchParams.get('state');
  const code = app.idp.issue(started.headers.location, email, extra);
  const callback = await request(app, 'GET', `/auth/callback?code=${code}&state=${state}`, { headers: { cookie: login } });
  if (callback.status !== 302) return { refused: callback };
  return { cookie: cookieHeader(callback), response: callback };
}

// Made-up sealed bytes (the app checks only the magic and the size) and ids; a counter keeps them different.
const sealedBytes = (size = 64) => Buffer.concat([Buffer.from('HRC1'), Buffer.alloc(size, ++counter % 251)]);
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

module.exports = { closeAll, startApp, startIdp, request, signIn, cookieHeader, sealedBytes, uuid, listen, close };
