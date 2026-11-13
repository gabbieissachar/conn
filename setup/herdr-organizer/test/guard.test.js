'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, client } = require('./helpers');

const RUN = '/api/herdr-organizer/run';

function noCorsHeaders(response) {
  return Object.keys(response.headers).filter((name) => name.toLowerCase().startsWith('access-control-'));
}

test('token is handed out on a same-origin GET and never with CORS headers', async () => {
  const server = await startServer();
  try {
    const response = await request({ port: server.port, path: '/api/herdr-organizer/token', headers: { Host: 'localhost:' + server.port } });
    assert.equal(response.status, 200);
    assert.match(response.json.token, /^[0-9a-f]{64}$/);
    assert.deepEqual(noCorsHeaders(response), []);
  } finally { await server.close(); }
});

test('token endpoint refuses a foreign Origin, a foreign Host and cross-site fetch metadata', async () => {
  const server = await startServer();
  try {
    const host = 'localhost:' + server.port;
    const foreignOrigin = await request({ port: server.port, path: '/api/herdr-organizer/token', headers: { Host: host, Origin: 'https://evil.example' } });
    assert.equal(foreignOrigin.status, 403);
    assert.equal(foreignOrigin.raw.includes('"token"'), false);
    const nullOrigin = await request({ port: server.port, path: '/api/herdr-organizer/token', headers: { Host: host, Origin: 'null' } });
    assert.equal(nullOrigin.status, 403);
    const rebinding = await request({ port: server.port, path: '/api/herdr-organizer/token', headers: { Host: 'evil.example:' + server.port } });
    assert.equal(rebinding.status, 403);
    const wrongPort = await request({ port: server.port, path: '/api/herdr-organizer/token', headers: { Host: 'localhost:1' } });
    assert.equal(wrongPort.status, 403);
    const crossSite = await request({ port: server.port, path: '/api/herdr-organizer/token', headers: { Host: host, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const sameSite = await request({ port: server.port, path: '/api/herdr-organizer/token', headers: { Host: host, 'Sec-Fetch-Site': 'same-site' } });
    assert.equal(sameSite.status, 403);
    for (const response of [foreignOrigin, nullOrigin, rebinding, wrongPort, crossSite, sameSite]) assert.deepEqual(noCorsHeaders(response), []);
  } finally { await server.close(); }
});

test('same-origin requests with each loopback spelling are accepted', async () => {
  const server = await startServer();
  try {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const response = await request({ port: server.port, path: '/api/herdr-organizer/token', headers: { Host: host + ':' + server.port, Origin: 'http://' + host + ':' + server.port, 'Sec-Fetch-Site': 'same-origin' } });
      assert.equal(response.status, 200, host);
    }
  } finally { await server.close(); }
});

test('run refuses every missing or wrong cross-site protection', async () => {
  const server = await startServer();
  try {
    const { token } = await client(server);
    const host = 'localhost:' + server.port;
    const good = { Host: host, Origin: server.origin, 'Content-Type': 'application/json', 'X-Herdr-Organizer-Token': token };
    const body = { action: 'sessions' };
    const attempts = {
      'no token': { ...good, 'X-Herdr-Organizer-Token': undefined },
      'wrong token': { ...good, 'X-Herdr-Organizer-Token': 'a'.repeat(64) },
      'short token': { ...good, 'X-Herdr-Organizer-Token': 'abc' },
      'no origin': { ...good, Origin: undefined },
      'foreign origin': { ...good, Origin: 'https://evil.example' },
      'same host different port origin': { ...good, Origin: 'http://localhost:1' },
      'foreign host': { ...good, Host: 'evil.example:' + server.port },
      'cross-site fetch metadata': { ...good, 'Sec-Fetch-Site': 'cross-site' },
    };
    for (const [name, headers] of Object.entries(attempts)) {
      const cleaned = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
      const response = await request({ port: server.port, method: 'POST', path: RUN, headers: cleaned, body });
      assert.equal(response.status, 403, name);
      assert.deepEqual(noCorsHeaders(response), [], name);
    }
    const ok = await request({ port: server.port, method: 'POST', path: RUN, headers: good, body });
    assert.equal(ok.status, 200);
    assert.deepEqual(noCorsHeaders(ok), []);
  } finally { await server.close(); }
});

test('run requires a JSON content type so a plain form post cannot reach it', async () => {
  const server = await startServer();
  try {
    const { token } = await client(server);
    const response = await request({
      port: server.port, method: 'POST', path: RUN,
      headers: { Host: 'localhost:' + server.port, Origin: server.origin, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Herdr-Organizer-Token': token },
      body: 'action=sessions',
    });
    assert.equal(response.status, 415);
    const text = await request({
      port: server.port, method: 'POST', path: RUN,
      headers: { Host: 'localhost:' + server.port, Origin: server.origin, 'Content-Type': 'text/plain', 'X-Herdr-Organizer-Token': token },
      body: JSON.stringify({ action: 'sessions' }),
    });
    assert.equal(text.status, 415);
    assert.equal(server.calls.length, 0, 'nothing was spawned');
  } finally { await server.close(); }
});

test('a CORS preflight is always refused and carries no allow headers', async () => {
  const server = await startServer();
  try {
    const response = await request({
      port: server.port, method: 'OPTIONS', path: RUN,
      headers: { Host: 'localhost:' + server.port, Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-herdr-organizer-token' },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(noCorsHeaders(response), []);
    const tokenPreflight = await request({ port: server.port, method: 'OPTIONS', path: '/api/herdr-organizer/token', headers: { Host: 'localhost:' + server.port, Origin: 'https://evil.example' } });
    assert.equal(tokenPreflight.status, 403);
    assert.deepEqual(noCorsHeaders(tokenPreflight), []);
  } finally { await server.close(); }
});

test('GET on the run endpoint and unknown routes are refused without leaking anything', async () => {
  const server = await startServer();
  try {
    const { token } = await client(server);
    const host = 'localhost:' + server.port;
    const getRun = await request({ port: server.port, path: RUN, headers: { Host: host, 'X-Herdr-Organizer-Token': token } });
    assert.equal(getRun.status, 405);
    const unknown = await request({ port: server.port, path: '/api/herdr-organizer/nope', headers: { Host: host } });
    assert.equal(unknown.status, 404);
    const foreignProbe = await request({ port: server.port, path: '/api/herdr-organizer/nope', headers: { Host: 'evil.example:' + server.port } });
    assert.equal(foreignProbe.status, 403);
  } finally { await server.close(); }
});

test('the token is random per server start', async () => {
  const first = await startServer();
  const second = await startServer();
  try {
    const a = (await client(first)).token;
    const b = (await client(second)).token;
    assert.notEqual(a, b);
    const crossUse = await request({
      port: first.port, method: 'POST', path: RUN,
      headers: { Host: 'localhost:' + first.port, Origin: first.origin, 'Content-Type': 'application/json', 'X-Herdr-Organizer-Token': b },
      body: { action: 'sessions' },
    });
    assert.equal(crossUse.status, 403);
  } finally { await first.close(); await second.close(); }
});
