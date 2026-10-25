'use strict';

// The hosted app end to end, against local stand-ins (an OpenID provider and a memory store; see
// harness.js). Run: node --test setup/transcript-reader/replit/app.test.js
// Every secret and object body is made up per run; no transcript content is used.

const assert = require('assert');
const test = require('node:test');
const keys = require('./keys');
const session = require('./session');
const seal = require('../prototype/seal.js');
const zlib = require('zlib');
const { startApp, request, signIn, sealedBytes, uuid, closeAll } = require('./harness');

test.after(closeAll);  // a failed test leaves its servers open; this lets the run end

const OWNER = 'owner@example.com';
const SHELL = Buffer.from('<!doctype html><title>shell</title><p>SHELL-MARKER</p>');
const PARAMS = Buffer.from(JSON.stringify({ version: 1, kdf: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: 'c2FsdA==', check: 'Y2hlY2s=' }));
const SAME_SITE = { 'x-requested-with': 'transcript-reader' };
const bearer = (key, extra = {}) => ({ authorization: `Bearer ${key}`, ...extra });

// An app with a shell, key parameters and a few sealed objects already stored, and an upload key.
async function seeded(options) {
  const app = await startApp(options);
  const bodies = { 'index.html': SHELL, 'k/params.json': PARAMS, 'index.json.enc': sealedBytes(), 's/conv-1.json.enc': sealedBytes(), 'd/doc-1.json.enc': sealedBytes(), 'f/2026-W43.json.enc': sealedBytes() };
  for (const [name, bytes] of Object.entries(bodies)) await app.store.put(name, bytes);
  app.bodies = bodies;
  app.key = await app.newKey('laptop');
  return app;
}

test('every route refuses an unauthenticated request, and none leaks a stored body', async () => {
  const app = await seeded();
  const queued = `q/${uuid()}.json.enc`, receipt = `r/${uuid()}.json.enc`;
  await app.store.put(queued, sealedBytes());
  await app.store.put(receipt, sealedBytes());
  const names = [...Object.keys(app.bodies), queued, receipt, 's/nothing.json.enc', 'nope.txt', '_admin/keys.json'];
  const leaks = [...Object.values(app.bodies), (await app.store.get(queued)), (await app.store.get('_admin/keys.json'))].map((bytes) => bytes.subarray(0, 24));
  const routes = [];
  for (const name of names) for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'POST']) routes.push([method, '/' + name]);
  for (const name of names) for (const method of ['GET', 'PUT', 'DELETE']) routes.push([method, '/api/objects/' + name]);
  routes.push(['GET', '/api/objects'], ['GET', '/api/objects?prefix=s/'], ['GET', '/api'], ['GET', '/api/x'], ['POST', '/api/objects'], ['OPTIONS', '/'], ['GET', '/index.html'], ['PUT', '/'], ['DELETE', '/'], ['POST', '/'], ['GET', '/favicon.ico']);
  for (const [method, path] of routes) {
    const { status, body, headers } = await request(app, method, path, { body: method === 'PUT' || method === 'POST' ? sealedBytes() : undefined });
    const page = (method === 'GET' || method === 'HEAD') && (path === '/' || path === '/index.html');  // the login page answers there
    assert.strictEqual(status, page ? 200 : 401, `${method} ${path}`);
    assert.ok(!body.includes('SHELL-MARKER'), `${method} ${path} leaked the shell`);
    for (const piece of leaks) assert.ok(!body.includes(piece), `${method} ${path} leaked a stored object`);
    assert.strictEqual(headers['access-control-allow-origin'], undefined);
    assert.strictEqual(headers['cache-control'], 'no-store');
  }
  assert.strictEqual((await request(app, 'GET', '/api/objects/s/conv-1.json.enc')).headers['www-authenticate'], 'Bearer');
  await app.close();
});

test('the login pages and sign-in routes are the only public ones', async () => {
  const app = await seeded();
  for (const path of ['/', '/index.html', '/login', '/login?e=denied', '/login?e=<script>']) {
    const { status, body, headers } = await request(app, 'GET', path);
    assert.strictEqual(status, 200, path);
    assert.match(body.toString(), /Sign in/);
    assert.ok(!body.toString().includes('<script>'), 'the error code is never echoed');
    assert.match(headers['content-security-policy'], /default-src 'none'/);
  }
  const start = await request(app, 'GET', '/auth/start');
  assert.strictEqual(start.status, 302);
  const to = new URL(start.headers.location);
  assert.strictEqual(to.origin, app.idp.issuer);
  assert.strictEqual(to.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(to.searchParams.get('redirect_uri'), app.config.redirectUri);
  assert.match(start.headers['set-cookie'][0], /HttpOnly; SameSite=Lax/);
  const bare = await request(app, 'GET', '/auth/callback?code=x&state=y');
  assert.strictEqual(bare.status, 400);
  assert.strictEqual((await request(app, 'POST', '/logout')).status, 403);
  await app.close();
});

test('a signed-in allow-listed owner reads the shell and every object, byte for byte', async () => {
  const app = await seeded();
  const { cookie, response } = await signIn(app, OWNER);
  assert.ok(cookie, 'signed in');
  assert.match(response.headers['set-cookie'].find((line) => line.startsWith('hr_session=')), /HttpOnly; SameSite=Lax; Max-Age=604800/);
  const root = await request(app, 'GET', '/', { headers: { cookie } });
  assert.strictEqual(root.status, 200);
  assert.deepStrictEqual(root.body, SHELL);
  assert.match(root.headers['content-security-policy'], /connect-src 'self'/);
  for (const [name, bytes] of Object.entries(app.bodies)) {
    const got = await request(app, 'GET', '/' + name, { headers: { cookie } });
    assert.strictEqual(got.status, 200, name);
    assert.deepStrictEqual(got.body, bytes, name);
  }
  assert.strictEqual((await request(app, 'GET', '/s/missing.json.enc', { headers: { cookie } })).status, 404);
  assert.strictEqual((await request(app, 'GET', '/_admin/keys.json', { headers: { cookie } })).status, 404);
  assert.strictEqual((await request(app, 'POST', '/index.html', { headers: { cookie } })).status, 405);
  await app.close();
});

test('an empty bucket shows the owner a plain note rather than an error page', async () => {
  const app = await startApp();
  const { cookie } = await signIn(app, OWNER);
  const root = await request(app, 'GET', '/', { headers: { cookie } });
  assert.strictEqual(root.status, 404);
  assert.match(root.body.toString(), /Nothing has been uploaded yet/);
  await app.close();
});

test('an account off the allow-list is refused, with no session', async () => {
  const app = await seeded();
  for (const [email, extra] of [['stranger@example.com', {}], ['owner@example.com.evil.test', {}], ['', {}], [OWNER, { claims: { email_verified: false } }]]) {
    const { refused, cookie } = await signIn(app, email, extra);
    assert.ok(!cookie, `${email} must not get in`);
    assert.strictEqual(refused.status, 403);
    assert.match(refused.body.toString(), /not allowed/);
    assert.ok(!refused.headers['set-cookie'].some((line) => /^hr_session=[^;]/.test(line)), 'no session cookie');
  }
  assert.ok(app.logs.every((line) => !line.includes('stranger') && !line.includes('example.com')), 'the log holds no address');
  await app.close();
});

test('the provider must say the email is verified, unless the owner opted in for a directory that never says', async () => {
  const strict = await seeded();
  const none = { claims: { email_verified: undefined } };
  for (const extra of [none, { claims: { email_verified: false } }, { claims: { email_verified: 'false' } }, { claims: { email_verified: 0 } }]) {
    const { refused, cookie } = await signIn(strict, OWNER, extra);
    assert.ok(!cookie, JSON.stringify(extra));
    assert.strictEqual(refused.status, 403);
  }
  assert.ok(strict.logs.some((line) => /did not say the email is verified/.test(line)), 'the log says why, without the address');
  assert.ok((await signIn(strict, OWNER, { claims: { email_verified: 'true' } })).cookie, 'a string true counts');
  const loose = await seeded({ env: { OIDC_EMAIL_VERIFIED_OPTIONAL: '1' } });
  assert.ok((await signIn(loose, OWNER, none)).cookie, 'no claim at all is accepted once opted in');
  for (const claim of [false, 'false', 0]) assert.ok(!(await signIn(loose, OWNER, { claims: { email_verified: claim } })).cookie, 'an explicit no is never accepted');
  assert.ok(!(await signIn(loose, 'stranger@example.com', none)).cookie, 'still only the allow-list');
});

test('the allow-list matches case-insensitively, and removing someone ends their session at once', async () => {
  const app = await seeded({ allowed: ' Owner@Example.com , second@example.com ' });
  const { cookie } = await signIn(app, 'OWNER@example.COM');
  assert.ok(cookie);
  assert.strictEqual((await request(app, 'GET', '/', { headers: { cookie } })).status, 200);
  app.config.allowedEmails.delete('owner@example.com');
  assert.strictEqual((await request(app, 'GET', '/index.json.enc', { headers: { cookie } })).status, 401);
  await app.close();
});

test('forged, expired and wrong-kind cookies, and a broken sign-in, are refused', async () => {
  let clock = Date.now();
  const app = await seeded({ now: () => clock });
  const secret = app.config.sessionSecret;
  const path = '/index.json.enc';
  const good = session.sign(secret, 'session', { e: OWNER }, 60, clock);
  assert.strictEqual((await request(app, 'GET', path, { headers: { cookie: 'hr_session=' + good } })).status, 200);
  const cases = {
    tamperedPayload: (good[0] === 'e' ? 'f' : 'e') + good.slice(1),
    tamperedTag: good.slice(0, good.indexOf('.') + 2) + (good[good.indexOf('.') + 2] === 'A' ? 'B' : 'A') + good.slice(good.indexOf('.') + 3),
    otherSecret: session.sign('x'.repeat(40), 'session', { e: OWNER }, 60, clock),
    loginKind: session.sign(secret, 'login', { e: OWNER }, 60, clock),
    notAllowed: session.sign(secret, 'session', { e: 'stranger@example.com' }, 60, clock),
    garbage: 'not-a-token',
    noPayloadTag: good.split('.')[0],
  };
  for (const [what, value] of Object.entries(cases)) assert.strictEqual((await request(app, 'GET', path, { headers: { cookie: 'hr_session=' + value } })).status, 401, what);
  clock += 61000;
  assert.strictEqual((await request(app, 'GET', path, { headers: { cookie: 'hr_session=' + good } })).status, 401, 'expired');

  // The provider's side: another nonce, another audience, a bad signature, a spent code.
  for (const [what, extra] of Object.entries({ nonce: { claims: { nonce: 'other' } }, audience: { claims: { aud: 'someone-else' } }, expired: { claims: { exp: Math.floor(clock / 1000) - 3600 } }, signature: { badKey: true }, algNone: { alg: 'none' }, algHmac: { alg: 'HS256' }, issuer: { claims: { iss: 'https://other.example' } } })) {
    const { refused, cookie } = await signIn(app, OWNER, extra);
    assert.ok(!cookie, what);
    assert.strictEqual(refused.status, 502, what);
  }
  // A callback with the wrong state, and one without the login cookie.
  const started = await request(app, 'GET', '/auth/start');
  const code = app.idp.issue(started.headers.location, OWNER);
  const wrongState = await request(app, 'GET', `/auth/callback?code=${code}&state=forged`, { headers: { cookie: require('./harness').cookieHeader(started) } });
  assert.strictEqual(wrongState.status, 400);
  assert.strictEqual(app.idp.tokenCalls > 0, true);
  const calls = app.idp.tokenCalls;
  const noCookie = await request(app, 'GET', `/auth/callback?code=${code}&state=${new URL(started.headers.location).searchParams.get('state')}`);
  assert.strictEqual(noCookie.status, 400);
  assert.strictEqual(app.idp.tokenCalls, calls, 'the code is not even exchanged without the login cookie');
  await app.close();
});

test('the owner can queue a sealed message for the laptop, only through their own page', async () => {
  const app = await seeded();
  const { cookie } = await signIn(app, OWNER);
  const id = uuid();
  const path = `/q/${id}.json.enc`;
  const bytes = sealedBytes(100);
  const put = (headers, body = bytes, where = path) => request(app, 'PUT', where, { headers: { cookie, ...headers }, body });
  assert.strictEqual((await put({})).status, 403, 'no same-site header');
  assert.strictEqual((await put({ ...SAME_SITE, origin: 'https://evil.example' })).status, 403, 'another origin');
  assert.strictEqual((await put({ ...SAME_SITE }, Buffer.from('{"plain":"text"}'))).status, 422, 'not sealed');
  assert.strictEqual((await put({ ...SAME_SITE }, sealedBytes(300 * 1024))).status, 413, 'too big');
  assert.strictEqual((await put({ ...SAME_SITE }, bytes, '/q/not-a-uuid.json.enc')).status, 404);
  assert.strictEqual((await put({ ...SAME_SITE, origin: app.base })).status, 201);
  assert.strictEqual((await put({ ...SAME_SITE })).status, 409, 'a queued message is never overwritten');
  assert.deepStrictEqual(await app.store.get(`q/${id}.json.enc`), bytes);
  assert.strictEqual((await request(app, 'PUT', path, { headers: SAME_SITE, body: bytes })).status, 401, 'no session');
  // The page can read what it queued, but write nothing else.
  assert.deepStrictEqual((await request(app, 'GET', path, { headers: { cookie } })).body, bytes);
  for (const name of ['index.html', 'k/params.json', 'index.json.enc', 's/x.json.enc', `r/${uuid()}.json.enc`]) {
    assert.strictEqual((await request(app, 'PUT', '/' + name, { headers: { cookie, ...SAME_SITE }, body: name === 'index.html' ? SHELL : sealedBytes() })).status, 403, name);
  }
  assert.strictEqual((await request(app, 'DELETE', path, { headers: { cookie, ...SAME_SITE } })).status, 405);
  await app.close();
});

test('the queue holds a limited number of messages', async () => {
  const app = await seeded();
  app.config.queueLimit = 3;
  const { cookie } = await signIn(app, OWNER);
  const status = [];
  for (let i = 0; i < 4; i += 1) status.push((await request(app, 'PUT', `/q/${uuid()}.json.enc`, { headers: { cookie, ...SAME_SITE }, body: sealedBytes() })).status);
  assert.deepStrictEqual(status, [201, 201, 201, 429]);
  await app.close();
});

test('the laptop key drains the queue, and its receipts reach only the signed-in owner', async () => {
  const app = await seeded();
  const { cookie } = await signIn(app, OWNER);
  const id = uuid();
  const queued = sealedBytes(50);
  await request(app, 'PUT', `/q/${id}.json.enc`, { headers: { cookie, ...SAME_SITE }, body: queued });
  const listed = JSON.parse((await request(app, 'GET', '/api/objects?prefix=q/', { headers: bearer(app.key) })).body);
  assert.deepStrictEqual(listed.objects.map((o) => o.name), [`q/${id}.json.enc`]);
  const taken = await request(app, 'GET', `/api/objects/q/${id}.json.enc`, { headers: bearer(app.key) });
  assert.deepStrictEqual(taken.body, queued);
  const receipt = sealedBytes(30);
  assert.strictEqual((await request(app, 'PUT', `/api/objects/r/${id}.json.enc`, { headers: bearer(app.key), body: receipt })).status, 201);
  assert.strictEqual((await request(app, 'DELETE', `/api/objects/q/${id}.json.enc`, { headers: bearer(app.key) })).status, 200);
  assert.strictEqual(await app.store.get(`q/${id}.json.enc`), null);
  assert.deepStrictEqual((await request(app, 'GET', `/r/${id}.json.enc`, { headers: { cookie } })).body, receipt);
  assert.strictEqual((await request(app, 'GET', `/r/${id}.json.enc`)).status, 401, 'not without a session');
  assert.strictEqual((await request(app, 'GET', `/r/${id}.json.enc`, { headers: bearer(app.key) })).status, 401, 'a key is not a session');
  // The key cannot write the queue (that is the owner's) and cannot read the sealed copy back.
  assert.strictEqual((await request(app, 'PUT', `/api/objects/q/${uuid()}.json.enc`, { headers: bearer(app.key), body: sealedBytes() })).status, 403);
  assert.strictEqual((await request(app, 'GET', '/api/objects/s/conv-1.json.enc', { headers: bearer(app.key) })).status, 403);
  await app.close();
});

test('the upload endpoint refuses a missing, wrong or revoked key, and revocation is immediate', async () => {
  const app = await seeded();
  const url = '/api/objects/s/new.json.enc';
  const body = sealedBytes();
  assert.strictEqual((await request(app, 'PUT', url, { body })).status, 401);
  assert.strictEqual((await request(app, 'PUT', url, { headers: bearer('hrk_wrong'), body })).status, 401);
  assert.strictEqual((await request(app, 'PUT', url, { headers: { authorization: `Basic ${app.key}` }, body })).status, 401);
  assert.strictEqual((await request(app, 'PUT', url, { headers: bearer(app.key.slice(0, -1)), body })).status, 401);
  assert.strictEqual(await app.store.get('s/new.json.enc'), null);
  assert.strictEqual((await request(app, 'PUT', url, { headers: bearer(app.key), body })).status, 201);
  assert.deepStrictEqual(await app.store.get('s/new.json.enc'), body);
  const [entry] = await keys.list(app.store);
  assert.ok(await keys.revoke(app.store, entry.id));
  assert.strictEqual((await request(app, 'PUT', url, { headers: bearer(app.key), body: sealedBytes() })).status, 401, 'revoked');
  assert.strictEqual((await request(app, 'GET', '/api/objects', { headers: bearer(app.key) })).status, 401, 'revoked for every call');
  const fresh = await app.newKey('second');
  assert.strictEqual((await request(app, 'PUT', url, { headers: bearer(fresh), body: sealedBytes() })).status, 201, 'a new key works');
  // The store holds hashes only.
  const stored = (await app.store.get(keys.FILE)).toString();
  assert.ok(!stored.includes(app.key) && !stored.includes(fresh));
  await app.close();
});

test('wrong keys are slowed down, but a live key is never locked out by them', async () => {
  const app = await seeded();
  let last = 0;
  for (let i = 0; i < 14; i += 1) last = (await request(app, 'GET', '/api/objects', { headers: bearer('hrk_guess' + i) })).status;
  assert.strictEqual(last, 429);
  assert.strictEqual((await request(app, 'GET', '/api/objects', { headers: bearer(app.key) })).status, 200);
  await app.close();
});

test('the upload endpoint takes only sealed objects, the key parameters and the shell', async () => {
  const app = await seeded();
  const put = (name, body) => request(app, 'PUT', '/api/objects/' + name, { headers: bearer(app.key), body });
  const plainJson = Buffer.from(JSON.stringify({ exchanges: [{ text: 'a plain transcript line' }] }));
  assert.strictEqual((await put('s/a.json.enc', sealedBytes())).status, 201);
  assert.strictEqual((await put('d/a.json.enc', sealedBytes())).status, 201);
  assert.strictEqual((await put('f/2026-W44.json.enc', sealedBytes())).status, 201);
  assert.strictEqual((await put('index.json.enc', sealedBytes())).status, 201);
  assert.strictEqual((await put('k/params.json', PARAMS)).status, 201);
  assert.strictEqual((await put('index.html', SHELL)).status, 201);
  assert.strictEqual((await put(`r/${uuid()}.json.enc`, sealedBytes())).status, 201);
  // Refused bodies: plain JSON, gzip, an empty body, a short "sealed" one, the wrong magic.
  for (const [what, body] of Object.entries({ plain: plainJson, gzip: zlib.gzipSync(plainJson), empty: Buffer.alloc(0), short: Buffer.from('HRC1abc'), magic: Buffer.concat([Buffer.from('HRC2'), Buffer.alloc(60, 9)]) })) {
    const { status } = await put('s/b.json.enc', body);
    assert.ok(status === 422 || status === 400, `${what} answered ${status}`);
  }
  assert.strictEqual(await app.store.get('s/b.json.enc'), null);
  // Key parameters: no extra fields (nowhere to hide a transcript), no other KDF, no plain text.
  const extra = { ...JSON.parse(PARAMS), note: 'x' };
  assert.strictEqual((await put('k/params.json', Buffer.from(JSON.stringify(extra)))).status, 422);
  assert.strictEqual((await put('k/params.json', Buffer.from(JSON.stringify({ ...JSON.parse(PARAMS), kdf: 'scrypt' })))).status, 422);
  assert.strictEqual((await put('k/params.json', Buffer.from('not json'))).status, 422);
  assert.strictEqual((await put('k/params.json', Buffer.alloc(5000, 32))).status, 413);
  assert.strictEqual((await put('index.html', Buffer.from('{"not":"a page"}'))).status, 422);
  // Names that are not part of the copy.
  for (const name of ['s/a.json', 'x/a.json.enc', 's/a.json.enc.bak', 'index.json', 'manifest.json', 'pane-labels.json', 'redactions.json', 'upload.json', 'k/check', 's/' + 'a'.repeat(65) + '.json.enc', 's/a%20b.json.enc', 'q/' + uuid() + '.json']) {
    assert.strictEqual((await put(name, sealedBytes())).status, 400, name);
  }
  assert.strictEqual((await request(app, 'GET', '/api/objects?prefix=_admin/', { headers: bearer(app.key) })).status, 400);
  await app.close();
});

test('the laptop lists names and deletes what the sync pruned, never the shell or the key parameters', async () => {
  const app = await seeded();
  const names = (await request(app, 'GET', '/api/objects', { headers: bearer(app.key) }));
  const all = JSON.parse(names.body).objects.map((o) => o.name);
  assert.deepStrictEqual(all, Object.keys(app.bodies).sort());
  assert.ok(!all.includes('_admin/keys.json'), 'the key store is never listed');
  assert.deepStrictEqual(JSON.parse((await request(app, 'GET', '/api/objects?prefix=s/', { headers: bearer(app.key) })).body).objects.map((o) => o.name), ['s/conv-1.json.enc']);
  assert.strictEqual((await request(app, 'DELETE', '/api/objects/s/conv-1.json.enc', { headers: bearer(app.key) })).status, 200);
  assert.strictEqual(await app.store.get('s/conv-1.json.enc'), null);
  for (const name of ['index.html', 'k/params.json', 'index.json.enc']) {
    assert.strictEqual((await request(app, 'DELETE', '/api/objects/' + name, { headers: bearer(app.key) })).status, 403, name);
    assert.ok(await app.store.get(name), name);
  }
  await app.close();
});

test('object names that climb, hide or double-encode are refused on every route', async () => {
  const app = await seeded();
  const { cookie } = await signIn(app, OWNER);
  await app.store.put('secret-outside.txt', Buffer.from('OUTSIDE-MARKER'));
  const before = (await app.store.list('')).map((o) => o.name).join();
  const names = [
    '../k/params.json', 's/../index.json.enc', 's/%2e%2e/index.json.enc', '%2e%2e/%2e%2e/etc/passwd', 's/..%2fk%2fparams.json', 's%2f..%2f..%2f_admin%2fkeys.json',
    's/%252e%252e/x.json.enc', '..%5c..%5cx.json.enc', 's%5cx.json.enc', 's//x.json.enc', '/s/x.json.enc', 's/x.json.enc/', 's/x.json.enc/../../_admin/keys.json',
    's/a%00.json.enc', 's/a%0a.json.enc', '_admin/keys.json', '_admin%2fkeys.json', 'secret-outside.txt', '%', 's/%zz.json.enc', 'S/conv-1.json.enc', 's/conv-1.JSON.ENC', 'k/params.json/..',
  ];
  for (const name of names) {
    const attempts = [
      ['GET', '/' + name, { cookie }], ['GET', '/api/objects/' + name, bearer(app.key)], ['PUT', '/api/objects/' + name, bearer(app.key)],
      ['DELETE', '/api/objects/' + name, bearer(app.key)], ['PUT', '/' + name, { cookie, ...SAME_SITE }],
    ];
    for (const [method, path, headers] of attempts) {
      const { status, body } = await request(app, method, path, { headers, body: method === 'PUT' ? sealedBytes() : undefined });
      assert.ok(status >= 400 && status < 500, `${method} ${path} answered ${status}`);
      assert.ok(!body.includes('OUTSIDE-MARKER') && !body.includes('"hash"'), `${method} ${path} leaked`);
    }
  }
  assert.strictEqual((await app.store.list('')).map((o) => o.name).join(), before, 'nothing was written, moved or deleted');
  assert.ok(await app.store.get('s/conv-1.json.enc'));
  await app.close();
});

test('the app stores and returns the sealed bytes unchanged, so the shell can open them', async () => {
  const app = await seeded();
  const { cookie } = await signIn(app, OWNER);
  const { params, key } = await seal.newParams('a made-up passphrase');
  const name = 's/round-trip.json.enc';
  const text = JSON.stringify({ exchanges: ['synthetic text'] });
  const sealed = Buffer.from(await seal.close(key, name, zlib.gzipSync(Buffer.from(text))));
  assert.strictEqual((await request(app, 'PUT', '/api/objects/k/params.json', { headers: bearer(app.key), body: Buffer.from(JSON.stringify(params)) })).status, 201);
  assert.strictEqual((await request(app, 'PUT', '/api/objects/' + name, { headers: bearer(app.key), body: sealed })).status, 201);
  const got = await request(app, 'GET', '/' + name, { headers: { cookie } });
  const reopened = await seal.unlock('a made-up passphrase', JSON.parse((await request(app, 'GET', '/k/params.json', { headers: { cookie } })).body));
  assert.ok(reopened, 'the stored parameters open with the passphrase');
  assert.strictEqual(JSON.stringify(await seal.openJson(reopened, name, got.body)), text);
  await app.close();
});

test('responses carry no CORS header and forbid framing and caching', async () => {
  const app = await seeded();
  const { cookie } = await signIn(app, OWNER);
  for (const [path, headers] of [['/', { cookie }], ['/index.json.enc', { cookie }], ['/login', {}], ['/api/objects', bearer(app.key)], ['/nothing', {}]]) {
    const { headers: got } = await request(app, 'GET', path, { headers });
    assert.strictEqual(got['access-control-allow-origin'], undefined, path);
    assert.strictEqual(got['cache-control'], 'no-store', path);
    assert.strictEqual(got['x-frame-options'], 'DENY', path);
    assert.strictEqual(got['x-content-type-options'], 'nosniff', path);
  }
  await app.close();
});
