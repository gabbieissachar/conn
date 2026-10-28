'use strict';

// Tests for the page's link to the reader's server (prototype/live.js), as the phone meets it on the
// Mac's Tailscale address. Run from the repo root: node --test setup/transcript-reader/live.test.js
// The file runs in a sandbox with a fake location, document and fetch, as the page's script would.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'prototype', 'live.js'), 'utf8');
const TOKEN = 'ab'.repeat(32);

// token: what the server wrote into the page's reader-token tag ('' for a copy with none).
function load({ protocol = 'http:', hostname = 'localhost', token = TOKEN, answer = null, activeTag = 'BODY' } = {}) {
  const fetched = [];
  const reloads = [];
  const store = new Map();
  const sandbox = {
    location: { protocol, hostname, reload: () => reloads.push(1) },
    document: {
      querySelector: (selector) => (selector === 'meta[name="reader-token"]' ? { content: token } : null),
      activeElement: { tagName: activeTag },
      addEventListener: () => {},
    },
    sessionStorage: { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => { store.set(key, String(value)); } },
    fetch: async (url, options) => {
      fetched.push({ url, options });
      const { status = 200, body = { status: 'ok' } } = answer || {};
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
    Date, JSON, Math, Number, Error, Promise, Intl, RegExp, String, Array, Object, setInterval: () => 0,
  };
  vm.createContext(sandbox);
  const live = vm.runInContext(SOURCE + '\nlive;', sandbox);
  return { live, fetched, reloads };
}

test('a page on localhost, 127.0.0.1 or [::1] is served, as before', () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) assert.equal(load({ hostname }).live.served, true, hostname);
  assert.equal(load({ hostname: 'localhost', token: '' }).live.served, true, 'loopback needs nothing but the address');
});

test('a page on a Tailscale address that carries the server token is served: Send, Sync, Follow and pins work on the phone', () => {
  for (const hostname of ['100.64.0.1', '100.97.27.50', '100.100.100.100', '100.127.255.254']) assert.equal(load({ hostname }).live.served, true, hostname);
});

test('a Tailscale address alone is not enough: a page without the server token stays read-only', () => {
  assert.equal(load({ hostname: '100.97.27.50', token: '' }).live.served, false, 'no token, as in a file copy');
  assert.equal(load({ hostname: '100.97.27.50', token: '__READER_TOKEN__' }).live.served, false, 'the unfilled placeholder');
  assert.equal(load({ hostname: '100.97.27.50', token: 'ab'.repeat(31) }).live.served, false, 'a token of the wrong length');
});

test('the machine\'s Tailscale name is served over https with the server token, and over nothing else', () => {
  const name = 'some-machine.some-tailnet.ts.net';
  assert.equal(load({ protocol: 'https:', hostname: name }).live.served, true);
  assert.equal(load({ protocol: 'https:', hostname: name, token: '' }).live.served, false, 'no token');
  assert.equal(load({ protocol: 'http:', hostname: name }).live.served, false, 'the name is the TLS listener\'s, not the plain one\'s');
  for (const other of ['some-machine.ts.net.example.com', 'ts.net', 'evilts.net', 'some-machine.tsxnet']) assert.equal(load({ protocol: 'https:', hostname: other }).live.served, false, other);
});

test('any other address stays read-only, token or not', () => {
  for (const hostname of ['100.63.255.255', '100.128.0.1', '10.0.0.5', '192.168.1.20', '172.16.0.9', '100.97.27', '100.97.27.50.1', 'example.com', 'localhost.example.com', 'foo.100.97.27.50', '']) {
    assert.equal(load({ hostname }).live.served, false, hostname);
  }
  assert.equal(load({ protocol: 'https:', hostname: '100.97.27.50' }).live.served, false, 'https is not the reader\'s own server');
  assert.equal(load({ protocol: 'file:', hostname: '' }).live.served, false, 'a file copy');
});

test('on the tailnet address Send carries the token header and reaches the server', async () => {
  const { live, fetched } = load({ hostname: '100.97.27.50' });
  await live.send('aaaaaaaa-1111-4111-8111-111111111111', 'hello from the phone');
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, '/api/transcript-reader/send');
  assert.equal(fetched[0].options.method, 'POST');
  assert.equal(fetched[0].options.headers['x-transcript-reader-token'], TOKEN);
  assert.deepEqual(JSON.parse(fetched[0].options.body), { session_id: 'aaaaaaaa-1111-4111-8111-111111111111', text: 'hello from the phone' });
});

test('a read-only page refuses to call the server at all', async () => {
  const { live, fetched } = load({ hostname: '192.168.1.20' });
  await assert.rejects(() => live.send('aaaaaaaa-1111-4111-8111-111111111111', 'x'), /Open the served page/);
  assert.equal(fetched.length, 0);
});

test('a phone the server signed out (a restart, a new passcode) reloads once to the sign-in page, and says so when it cannot', async () => {
  const signedOut = { status: 401, body: { status: 'error', code: 'sign_in_required', message: 'Sign in first.' } };
  const first = load({ hostname: '100.97.27.50', answer: signedOut });
  await assert.rejects(() => first.live.state(false), /Signed out: opening the sign-in page/);
  assert.equal(first.reloads.length, 1, 'one reload brings the passcode page');
  // Not twice within a minute, so a page that cannot sign in does not reload in a loop.
  await assert.rejects(() => first.live.state(false), /Signed out: reload the page to sign in again/);
  assert.equal(first.reloads.length, 1);
  // Never while a message is being written; the box keeps it.
  const typing = load({ hostname: '100.97.27.50', answer: signedOut, activeTag: 'TEXTAREA' });
  await assert.rejects(() => typing.live.send('aaaaaaaa-1111-4111-8111-111111111111', 'x'), /Signed out: reload the page to sign in again/);
  assert.equal(typing.reloads.length, 0);
});

test('other refusals keep their own words', async () => {
  const { live } = load({ hostname: '100.97.27.50', answer: { status: 409, body: { status: 'error', message: 'No live Herdr pane runs this session.' } } });
  await assert.rejects(() => live.send('aaaaaaaa-1111-4111-8111-111111111111', 'x'), /No live Herdr pane runs this session\./);
});

test('on a touch screen the box, Send and Add, the links under it and the Pin and Reply pills are finger-sized', () => {
  const template = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const block = (template.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n  \}/) || [])[1] || '';
  assert.match(block, /\.dock-row button \{[^}]*min-height: 44px/);
  assert.match(block, /\.dock textarea \{[^}]*min-height: 44px/);
  assert.match(block, /\.dock-acts button/);
  assert.match(block, /\.pin, \.reply-to/);
});
