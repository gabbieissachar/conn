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

// sync.py writes each object as one JSON line, and JSON allows U+2028 and U+2029 raw inside a string, so a conversation that holds one
// (a pasted text, or a script that handles them) is a line that holds one. A line ends at "\n" and nowhere else. readline ends it at
// those two as well, which cut such an object in half ("Unterminated string in JSON at position N", N the place of the character) and
// stopped every seal after it: 2 of 795 conversations on the owner's laptop held one, and each run of the sealed copy failed on them.
test('upload.js reads one object per line, and a line ends at a newline only', async () => {
  const { folder, cleanup } = bucket();
  try {
    const objects = {
      's/sep.json': { say: 'a b c', long: 'x'.repeat(111000) + ' ' + 'y'.repeat(2000) },
      's/only.json': { say: ' ' },
      's/big.json': { say: 'z'.repeat(3 * 1024 * 1024) },
      's/others.json': { say: 'a\u0085b\u000bc\u000cd\u001ce f g' },
      'index.json': { conversations: [' '] },
    };
    const lines = Object.entries(objects).map(([name, value]) => ({ path: name, text: JSON.stringify(value) }));
    assert.ok(lines.every((line) => JSON.stringify(line).split('\n').length === 1), 'one line each, as sync.py writes them');
    const sealed = await runUpload(folder, lines);
    assert.deepEqual(sealed.said, [{ ready: true, rekeyed: true }, { written: lines.length }]);
    const key = await seal.unlock(PASS, JSON.parse(fs.readFileSync(path.join(folder, 'k', 'params.json'), 'utf8')));
    for (const [name, value] of Object.entries(objects)) {
      assert.deepEqual(await seal.openJson(key, name, fs.readFileSync(path.join(folder, name + '.enc'))), value, name);
    }
  } finally { cleanup(); }
});

test('upload.js reads a line that arrives in pieces, even in the middle of a character, and one with no newline at the end', async () => {
  const { folder, cleanup } = bucket();
  try {
    const value = { say: 'café   𝄞   日本' + 'w'.repeat(5000) };
    const wire = Buffer.from(JSON.stringify({ path: 's/pieces.json', text: JSON.stringify(value) }) + '\n' + JSON.stringify({ path: 's/last.json', text: '{}' }), 'utf8');
    const input = new PassThrough();
    const output = new PassThrough();
    let said = '';
    output.on('data', (chunk) => { said += chunk; });
    const done = upload.main([folder], { HOSTED_READER_PASSPHRASE: PASS }, input, output);
    for (let at = 0; at < wire.length; at += 7) { input.write(wire.subarray(at, at + 7)); await new Promise((resolve) => setImmediate(resolve)); }
    input.end();
    assert.equal(await done, 0);
    assert.deepEqual(said.trim().split('\n').map((line) => JSON.parse(line)), [{ ready: true, rekeyed: true }, { written: 2 }]);
    const key = await seal.unlock(PASS, JSON.parse(fs.readFileSync(path.join(folder, 'k', 'params.json'), 'utf8')));
    assert.deepEqual(await seal.openJson(key, 's/pieces.json', fs.readFileSync(path.join(folder, 's', 'pieces.json.enc'))), value);
  } finally { cleanup(); }
});

test('a line that is not JSON stops upload.js with a message that quotes none of it, and nothing after it is sealed', async () => {
  const { folder, cleanup } = bucket();
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const secret = 'a private sentence from a conversation';
    input.write(JSON.stringify({ path: 's/first.json', text: '{}' }) + '\n');
    input.write(`{"path":"s/cut.json","text":"${secret}` + '\n');  // a line cut short: its string never closes
    input.end(JSON.stringify({ path: 's/after.json', text: '{}' }) + '\n');
    await assert.rejects(upload.main([folder], { HOSTED_READER_PASSPHRASE: PASS }, input, output), (error) => {
      assert.match(error.message, /A line of \d+ characters is not JSON/);
      assert.ok(!error.message.includes(secret) && !error.message.includes('private'), error.message);
      return true;
    });
    assert.ok(fs.existsSync(path.join(folder, 's', 'first.json.enc')));
    assert.ok(!fs.existsSync(path.join(folder, 's', 'after.json.enc')));
  } finally { cleanup(); }
});

// The shell's loader in a sandbox, fetching a sealed bucket from memory (no IndexedDB here).
function shell(files) {
  const calls = [];
  const posts = [];
  const sandbox = {
    document: { querySelector: () => ({ content: '__READER_TOKEN__' }), addEventListener() {}, hidden: false },
    fetch: async (url, options = {}) => {
      if (options.method === 'POST') { posts.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ status: 'ok' }) }; }
      calls.push(url);
      const body = files[url];
      if (body === undefined) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, json: async () => JSON.parse(Buffer.from(body).toString()), arrayBuffer: async () => Uint8Array.from(body).buffer };
    },
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Blob, Response, DecompressionStream, CompressionStream, atob, btoa, Uint8Array, ArrayBuffer,
    JSON, Map, Promise, Object, Number, String, Error, Date, Boolean, Array, setInterval: () => 0,
    sessionStorage: { getItem: () => null, setItem() {} }, location: { reload() {} },
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, 'prototype', 'seal.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'prototype', 'hosted.js'), 'utf8');
  return { hosted: vm.runInContext(source + '\nhosted;', sandbox), calls, posts };
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

test('a sealed page queues a send as bytes only its key opens, bound to its own path', async () => {
  const { params, key } = await seal.newParams(PASS);
  const files = { 'k/params.json': Buffer.from(JSON.stringify(params)) };
  const { hosted, posts } = shell(files);
  await hosted.prepare();
  await assert.rejects(hosted.enqueue('aaaaaaaa-1111-4111-8111-111111111111', 'before the passphrase'), /passphrase first/);
  await hosted.unlock(PASS, false);
  const queued = await hosted.enqueue('aaaaaaaa-1111-4111-8111-111111111111', 'A1=accept;A2=inline');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/transcript-reader/queue');
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['copy', 'data', 'id']);
  assert.equal(posts[0].body.copy, 'bucket');
  assert.equal(posts[0].body.id, queued.id);
  assert.match(queued.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const bytes = Buffer.from(posts[0].body.data, 'base64');
  assert.equal(bytes.includes('accept'), false, 'the text is not in the posted bytes');
  assert.deepEqual([...bytes.subarray(0, 4)], [0x48, 0x52, 0x43, 0x31]);
  const opened = await seal.openJson(key, `q/${queued.id}.json`, bytes);
  assert.deepEqual(opened, { id: queued.id, session_id: 'aaaaaaaa-1111-4111-8111-111111111111', text: 'A1=accept;A2=inline', at: queued.at });
  await assert.rejects(seal.openJson(key, 'q/another.json', bytes), /does not open/);
  // The same bytes the drain opens: gzip around JSON, sealed with the path.
  assert.deepEqual(JSON.parse(zlib.gunzipSync(Buffer.from(await seal.open(key, `q/${queued.id}.json`, bytes))).toString('utf8')).text, 'A1=accept;A2=inline');
});

test('a sealed page reads a receipt the laptop sealed, and none while there is none', async () => {
  const { params, key } = await seal.newParams(PASS);
  const id = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const receipt = { id, state: 'refused', code: 'agent_blocked', reason: 'at a permission prompt', at: 5 };
  const files = { 'k/params.json': Buffer.from(JSON.stringify(params)) };
  const { hosted, calls } = shell(files);
  await hosted.prepare();
  await hosted.unlock(PASS, false);
  assert.equal(await hosted.receipt(id), null);
  files[`r/${id}.json.enc`] = await seal.close(key, `r/${id}.json`, gz(receipt));
  assert.deepEqual(await hosted.receipt(id), receipt);
  assert.deepEqual(calls.slice(-2), [`r/${id}.json.enc`, `r/${id}.json.enc`]);
  files[`r/${id}.json.enc`] = await seal.close(key, 'r/another.json', gz(receipt));
  await assert.rejects(hosted.receipt(id), /does not open/, 'a receipt passed off from another request');
});
