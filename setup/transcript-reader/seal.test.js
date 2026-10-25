'use strict';

// Tests for the hosted copy's encryption (prototype/seal.js), upload.js that seals a bucket with
// it, and the shell's loader opening a sealed bucket (prototype/hosted.js). Run from the repo root:
//   node --test setup/transcript-reader/seal.test.js
// The passphrases are made up; buckets are temporary folders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { PassThrough } = require('stream');
const seal = require('./prototype/seal.js');
const upload = require('./upload.js');

const PASS = 'a made-up passphrase';
const json = (value) => new TextEncoder().encode(JSON.stringify(value));
const gz = (value) => new Uint8Array(zlib.gzipSync(Buffer.from(JSON.stringify(value))));

test('a sealed object opens with its key and path, and with nothing else', async () => {
  const { params, key } = await seal.newParams(PASS);
  assert.equal(params.iterations, 600000);
  assert.equal(seal.fromBase64(params.salt).length, 16);
  const sealed = await seal.close(key, 's/a.json', json({ hello: 'world' }));
  assert.deepEqual([...sealed.subarray(0, 4)], [0x48, 0x52, 0x43, 0x31]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await seal.open(key, 's/a.json', sealed))), { hello: 'world' });
  const again = await seal.close(key, 's/a.json', json({ hello: 'world' }));
  assert.notDeepEqual([...again], [...sealed], 'a fresh nonce every time');
  await assert.rejects(seal.open(key, 's/b.json', sealed), /does not open/, 'passed off as another object');
  const other = await seal.deriveKey('another passphrase', params);
  await assert.rejects(seal.open(other, 's/a.json', sealed), /does not open/);
  const changed = sealed.slice(); changed[40] ^= 1;
  await assert.rejects(seal.open(key, 's/a.json', changed), /does not open/);
  await assert.rejects(seal.open(key, 's/a.json', new Uint8Array(10)), /not a sealed object/);
});

test('the check tells the right passphrase from a wrong one', async () => {
  const { params } = await seal.newParams(PASS);
  assert.ok(await seal.unlock(PASS, params));
  assert.equal(await seal.unlock(PASS + ' ', params), null);
  assert.ok(await seal.unlock(PASS.normalize('NFD'), params), 'the same passphrase typed in another Unicode form');
});

test('a gzipped JSON object opens to its value', async () => {
  const { key } = await seal.newParams(PASS);
  const value = { exchanges: [{ input: 'café ⁣', reply: 'x'.repeat(5000) }] };
  assert.deepEqual(await seal.openJson(key, 'index.json', await seal.close(key, 'index.json', gz(value))), value);
});

function bucket() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-bucket-'));
  return { folder, cleanup: () => fs.rmSync(folder, { recursive: true, force: true }) };
}

async function runUpload(folder, lines, { env = { HOSTED_READER_PASSPHRASE: PASS }, argv = [] } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let said = '';
  output.on('data', (chunk) => { said += chunk; });
  const done = upload.main([folder, ...argv], env, input, output);
  for (const line of lines) input.write(JSON.stringify(line) + '\n');
  input.end();
  const code = await done;
  return { code, said: said.trim().split('\n').map((line) => JSON.parse(line)) };
}

test('upload.js seals each object into <folder>/<path>.enc and writes the params once', async () => {
  const { folder, cleanup } = bucket();
  try {
    const first = await runUpload(folder, [{ path: 'index.json', text: '{"conversations":[]}' }, { path: 's/abc.json', text: '{"id":"abc"}' }]);
    assert.deepEqual(first.said, [{ ready: true, rekeyed: true }, { written: 2 }]);
    const params = JSON.parse(fs.readFileSync(path.join(folder, 'k', 'params.json'), 'utf8'));
    const key = await seal.unlock(PASS, params);
    assert.deepEqual(await seal.openJson(key, 's/abc.json', fs.readFileSync(path.join(folder, 's', 'abc.json.enc'))), { id: 'abc' });
    const second = await runUpload(folder, [{ path: 's/abc.json', text: '{"id":"abc","n":2}' }]);
    assert.deepEqual(second.said, [{ ready: true, rekeyed: false }, { written: 1 }]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'k', 'params.json'), 'utf8')).salt, params.salt);
    const files = fs.readdirSync(folder, { recursive: true }).filter((file) => fs.statSync(path.join(folder, file)).isFile());
    assert.deepEqual(files.sort(), ['index.json.enc', 'k/params.json', 's/abc.json.enc']);
    for (const file of files) assert.equal(fs.readFileSync(path.join(folder, file)).includes(PASS), false, file);
  } finally { cleanup(); }
});

test('upload.js refuses a passphrase the bucket does not know, unless told to seal under a new key', async () => {
  const { folder, cleanup } = bucket();
  try {
    await runUpload(folder, [{ path: 'index.json', text: '{}' }]);
    const before = fs.readFileSync(path.join(folder, 'index.json.enc'));
    const wrong = await runUpload(folder, [{ path: 'index.json', text: '{"x":1}' }], { env: { HOSTED_READER_PASSPHRASE: 'not it' } });
    assert.equal(wrong.code, 2);
    assert.deepEqual(wrong.said, [{ ready: false, error: 'wrong-passphrase' }]);
    assert.deepEqual(fs.readFileSync(path.join(folder, 'index.json.enc')), before);
    const rekeyed = await runUpload(folder, [{ path: 'index.json', text: '{"x":1}' }], { env: { HOSTED_READER_PASSPHRASE: 'new one' }, argv: ['--new-key'] });
    assert.deepEqual(rekeyed.said, [{ ready: true, rekeyed: true }, { written: 1 }]);
    assert.ok(await seal.unlock('new one', JSON.parse(fs.readFileSync(path.join(folder, 'k', 'params.json'), 'utf8'))));
  } finally { cleanup(); }
});

test('upload.js takes the passphrase from the environment only, and writes only the objects the copy has', async () => {
  const { folder, cleanup } = bucket();
  try {
    await assert.rejects(runUpload(folder, [], { env: {} }), /HOSTED_READER_PASSPHRASE/);
    for (const name of ['../escape.json', 'manifest.json', 's/../x.json', 'k/params.json', 'x/y.json']) {
      await assert.rejects(runUpload(folder, [{ path: name, text: '{}' }]), /Not an object/, name);
    }
    assert.equal(fs.existsSync(path.join(path.dirname(folder), 'escape.json.enc')), false);
  } finally { cleanup(); }
});

// The shell's loader in a sandbox, fetching a sealed bucket from memory (no IndexedDB here).
function shell(files) {
  const calls = [];
  const sandbox = {
    document: { querySelector: () => ({ content: '__READER_TOKEN__' }), addEventListener() {}, hidden: false },
    fetch: async (url) => {
      calls.push(url);
      const body = files[url];
      if (body === undefined) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, json: async () => JSON.parse(Buffer.from(body).toString()), arrayBuffer: async () => Uint8Array.from(body).buffer };
    },
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Blob, Response, DecompressionStream, atob, btoa, Uint8Array, ArrayBuffer,
    JSON, Map, Promise, Object, Number, String, Error, Date, Boolean, Array, setInterval: () => 0,
    sessionStorage: { getItem: () => null, setItem() {} }, location: { reload() {} },
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, 'prototype', 'seal.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'prototype', 'hosted.js'), 'utf8');
  return { hosted: vm.runInContext(source + '\nhosted;', sandbox), calls };
}

test('the shell opens a sealed bucket with the passphrase, and a plain copy without one', async () => {
  const { params, key } = await seal.newParams(PASS);
  const index = { as_of: 5, since: 1, homes: ['main'], conversations: [{ id: 'a', ids: ['a'], home: 'main', object: 's/a.json', stamp: 's1' }], documents: {}, weeks: {} };
  const files = {
    'k/params.json': Buffer.from(JSON.stringify(params)),
    'index.json.enc': await seal.close(key, 'index.json', gz(index)),
    's/a.json.enc': await seal.close(key, 's/a.json', gz({ id: 'a', exchanges: [{ input: 'hi' }] })),
  };
  const { hosted, calls } = shell(files);
  assert.equal(await hosted.prepare(), 'locked');
  assert.equal(hosted.isSealed(), true);
  assert.equal(await hosted.unlock('not it', true), false);
  assert.equal(await hosted.unlock(PASS, true), true, 'remembering is a no-op without IndexedDB');
  const data = hosted.data(await hosted.index(), null);
  assert.equal(data.generated, 5);
  await hosted.conversation(data.sessions[0]);
  assert.deepEqual(data.sessions[0].exchanges, [{ input: 'hi' }]);
  assert.deepEqual(calls, ['k/params.json', 'index.json.enc', 's/a.json.enc']);

  const plain = shell({ 'index.json': Buffer.from(JSON.stringify(index)) });
  assert.equal(await plain.hosted.prepare(), 'plain');
  assert.equal(plain.hosted.isSealed(), false);
  assert.equal((await plain.hosted.index()).as_of, 5);
});

test('the shell refuses an object the host swapped for another', async () => {
  const { params, key } = await seal.newParams(PASS);
  const files = { 'k/params.json': Buffer.from(JSON.stringify(params)), 'index.json.enc': await seal.close(key, 's/a.json', gz({ conversations: [] })) };
  const { hosted } = shell(files);
  await hosted.prepare();
  await hosted.unlock(PASS, false);
  await assert.rejects(hosted.index(), /index\.json does not open/);
});
