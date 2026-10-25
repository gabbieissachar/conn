'use strict';

// The app's parts one at a time: names, settings, upload keys, the stores, the key command, and
// what the sources must never contain. Run: node --test setup/transcript-reader/replit/units.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { checkBody, classify, maxBytes } = require('./names');
const { loadConfig } = require('./config');
const keys = require('./keys');
const keysCli = require('./keys-cli');
const { fileStore, memoryStore, replitStore } = require('./store');
const { sealedBytes, uuid } = require('./harness');

const GOOD_ENV = { APP_URL: 'https://reader.example.test', OIDC_CLIENT_ID: 'client', OIDC_CLIENT_SECRET: 'placeholder', SESSION_SECRET: 'p'.repeat(32), ALLOWED_EMAILS: 'owner@example.com' };

test('names: only the copy\'s own names are classified', () => {
  const id = uuid();
  const kinds = { 'index.html': 'shell', 'k/params.json': 'params', 'index.json.enc': 'index', 's/abc-1_2.json.enc': 'object', 'd/x.json.enc': 'object', 'a/x.json.enc': 'object', 'sheet.html': 'shell', 'f/2026-W43.json.enc': 'object', [`q/${id}.json.enc`]: 'queue', [`r/${id}.json.enc`]: 'receipt' };
  for (const [name, kind] of Object.entries(kinds)) assert.strictEqual(classify(name), kind, name);
  for (const name of ['', 'index.json', 'k/params.json.enc', 's/.json.enc', 's/a.b.json.enc', 'S/a.json.enc', '_admin/keys.json', 'manifest.json', 'q/x.json.enc', 'x/y.json.enc', 's/' + 'a'.repeat(200) + '.json.enc', null, undefined, 5]) {
    assert.strictEqual(classify(name), null, String(name));
  }
});

test('names: bodies are checked by kind and size', () => {
  const params = { version: 1, kdf: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: 'a', check: 'b' };
  assert.ok(checkBody('object', sealedBytes()));
  assert.ok(!checkBody('object', Buffer.from('HRC1')), 'a bare magic is too short');
  assert.ok(!checkBody('object', Buffer.alloc(maxBytes('object') + 1, 1)), 'over the size limit');
  assert.ok(!checkBody('queue', sealedBytes(maxBytes('queue'))));
  assert.strictEqual(maxBytes('queue'), 64 * 1024, 'the reader\'s own limit');
  assert.ok(checkBody('params', Buffer.from(JSON.stringify(params))));
  for (const bad of [{ ...params, extra: 1 }, { ...params, iterations: 1.5 }, { ...params, hash: 'SHA-1' }, [params], 'text', null]) assert.ok(!checkBody('params', Buffer.from(JSON.stringify(bad))), JSON.stringify(bad));
  assert.ok(!checkBody('shell', Buffer.from('<!doctype html><p>x')), 'the shell pages are code, never an upload');
  assert.ok(!checkBody('params', Buffer.from(JSON.stringify({ ...params, iterations: 1 }))), 'below the 600,000 rounds');
  assert.ok(checkBody('params', Buffer.from(JSON.stringify({ ...params, iterations: 1000000 }))));
  assert.ok(!checkBody('nothing', sealedBytes()));
  assert.ok(!checkBody('object', 'not a buffer'));
});

test('config: refuses to start without an allow-list, a long session secret and an https address', () => {
  const config = loadConfig({ ...GOOD_ENV, ALLOWED_EMAILS: ' A@x.com, b@x.com ,' });
  assert.deepStrictEqual([...config.allowedEmails], ['a@x.com', 'b@x.com']);
  assert.ok(path.isAbsolute(config.shellDir) && config.shellDir.endsWith(path.join('replit', 'shell')), 'next to the app by default');
  assert.strictEqual(loadConfig({ ...GOOD_ENV, SHELL_DIR: '/srv/shells' }).shellDir, '/srv/shells');
  assert.strictEqual(config.issuer, 'https://oauth.id.jumpcloud.com/');
  assert.strictEqual(config.redirectUri, 'https://reader.example.test/auth/callback');
  assert.strictEqual(config.secureCookies, true);
  assert.strictEqual(config.queueLimit, 50, 'the reader\'s own limit');
  assert.strictEqual(loadConfig({ ...GOOD_ENV, SESSION_HOURS: 'junk' }).sessionSeconds, 168 * 3600);
  for (const name of Object.keys(GOOD_ENV)) {
    assert.throws(() => loadConfig({ ...GOOD_ENV, [name]: '' }), new RegExp(`${name} is not set`), name);
  }
  assert.throws(() => loadConfig({ ...GOOD_ENV, ALLOWED_EMAILS: ' , ' }), /ALLOWED_EMAILS has no email address/);
  assert.throws(() => loadConfig({ ...GOOD_ENV, ALLOWED_EMAILS: 'not-an-address' }), /ALLOWED_EMAILS must be/);
  assert.throws(() => loadConfig({ ...GOOD_ENV, SESSION_SECRET: 'short' }), /at least 32/);
  assert.throws(() => loadConfig({ ...GOOD_ENV, APP_URL: 'http://reader.example.test' }), /APP_URL must be an https/);
  assert.throws(() => loadConfig({ ...GOOD_ENV, OIDC_ISSUER: 'http://idp.example.test' }), /OIDC_ISSUER must be an https/);
  assert.doesNotThrow(() => loadConfig({ ...GOOD_ENV, APP_URL: 'http://127.0.0.1:3000', OIDC_ISSUER: 'http://localhost:9' }));
  try { loadConfig({ ...GOOD_ENV, SESSION_SECRET: 'tooshort-but-visible' }); } catch (error) { assert.ok(!error.message.includes('tooshort-but-visible'), 'a message never holds a value'); }
});

test('keys: a key is shown once, stored as a hash, verified, revoked', async () => {
  const store = memoryStore();
  const { key, id } = await keys.create(store, 'laptop', 1000000);
  assert.match(key, /^hrk_[A-Za-z0-9_-]{43}$/);
  const raw = (await store.get(keys.FILE)).toString();
  assert.ok(!raw.includes(key) && raw.includes(keys.hash(key)));
  assert.deepStrictEqual(await keys.list(store), [{ id, label: 'laptop', created: 1000, revoked: null }]);
  assert.strictEqual(await keys.verify(store, key), id);
  for (const wrong of [key + 'x', key.slice(1), 'hrk_', '', null, undefined, 5, 'x'.repeat(500)]) assert.strictEqual(await keys.verify(store, wrong), null);
  assert.strictEqual(await keys.revoke(store, 'unknown'), false);
  assert.strictEqual(await keys.revoke(store, id, 2000000), true);
  assert.strictEqual(await keys.revoke(store, id), false, 'already revoked');
  assert.strictEqual(await keys.verify(store, key), null);
  assert.strictEqual((await keys.list(store))[0].revoked, 2000);
  assert.strictEqual(await keys.verify(memoryStore(), key), null, 'no key store yet');
});

test('keys: changes made at the same moment are none of them lost', async () => {
  const store = memoryStore();
  const made = await Promise.all(Array.from({ length: 6 }, (_, i) => keys.create(store, 'k' + i)));
  assert.strictEqual((await keys.list(store)).length, 6);
  const [first, second] = made;
  const [a, b, c] = await Promise.all([keys.revoke(store, first.id), keys.create(store, 'late'), keys.revoke(store, second.id)]);
  assert.deepStrictEqual([a, c], [true, true]);
  assert.ok(b.key);
  const after = await keys.list(store);
  assert.strictEqual(after.length, 7);
  assert.deepStrictEqual(after.filter((k) => k.revoked).map((k) => k.id).sort(), [first.id, second.id].sort());
  for (const { key } of made.slice(2)) assert.ok(await keys.verify(store, key));
  // Another process changing the file between this one's read and its check is noticed, and the change made again
  // (a narrow window remains between the check and the write: the store has no compare-and-set).
  const raced = memoryStore();
  await keys.create(raced, 'one');
  const get = raced.get;
  let reads = 0;
  raced.get = async (name) => {
    reads += 1;
    if (reads === 2) {
      const value = JSON.parse((await get(name)).toString());
      value.rev += 1;
      value.keys.push({ id: 'other0000000', hash: 'ab', label: 'other', created: 1 });
      await raced.put(name, Buffer.from(JSON.stringify(value)));
    }
    return get(name);
  };
  await keys.create(raced, 'two');
  assert.deepStrictEqual((await keys.list(raced)).map((k) => k.label).sort(), ['one', 'other', 'two']);
});

test('keys-cli: create prints the key once, list never does, revoke works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replit-keys-'));
  const run = async (...argv) => { const lines = []; const code = await keysCli.main(argv, { OBJECT_STORE_DIR: dir }, (line) => lines.push(line)); return { code, text: lines.join('\n'), lines }; };
  const made = await run('create', 'phone');
  const key = made.lines[1];
  assert.match(key, /^hrk_/);
  const id = /Key ([0-9a-f]{12}) \(phone\)/.exec(made.lines[0])[1];
  const listed = await run('list');
  assert.ok(listed.text.includes(id) && !listed.text.includes(key));
  assert.strictEqual((await run('revoke', id)).text, `Revoked ${id}.`);
  assert.match((await run('list')).text, /REVOKED/);
  assert.strictEqual((await run('revoke', 'nope')).text, 'No live key nope.');
  assert.strictEqual((await run('nonsense')).code, 2);
  assert.ok(!fs.readFileSync(path.join(dir, keys.FILE), 'utf8').includes(key));
});

test('stores: memory and file stores agree, and the file store stays inside its folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replit-store-'));
  for (const store of [memoryStore(), fileStore(dir)]) {
    assert.strictEqual(await store.get('s/a.json.enc'), null);
    await store.put('s/a.json.enc', Buffer.from('one'));
    await store.put('s/b.json.enc', Buffer.from('three'));
    await store.put('index.html', Buffer.from('x'));
    assert.deepStrictEqual(await store.get('s/a.json.enc'), Buffer.from('one'));
    assert.deepStrictEqual((await store.list('s/')).map((o) => [o.name, o.size]), [['s/a.json.enc', 3], ['s/b.json.enc', 5]]);
    assert.strictEqual(await store.delete('s/a.json.enc'), true);
    assert.strictEqual(await store.delete('s/a.json.enc'), false);
    assert.deepStrictEqual((await store.list('')).map((o) => o.name), ['index.html', 's/b.json.enc']);
  }
  const files = fileStore(dir);
  for (const name of ['../x', 's/../../x', '/etc/passwd', '', 'a\0b']) {
    await assert.rejects(() => files.put(name, Buffer.from('no')), /outside the store/, JSON.stringify(name));
    await assert.rejects(() => files.get(name), /outside the store/);
  }
  assert.ok(!fs.existsSync(path.join(dir, '..', 'x')));
  // What the store writes is owner-only: the key hashes are among it.
  await files.put('_admin/keys.json', Buffer.from('{}'));
  assert.strictEqual(fs.statSync(path.join(dir, '_admin', 'keys.json')).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.join(dir, '_admin')).mode & 0o777, 0o700);
});

test('replit store: maps the client\'s { ok, value, error } results, with a stand-in client', async () => {
  const data = new Map();
  const client = {
    async uploadFromBytes(name, bytes) { data.set(name, bytes); return { ok: true, value: null, error: null }; },
    async downloadAsBytes(name) { return data.has(name) ? { ok: true, value: [data.get(name)], error: null } : { ok: false, value: null, error: { message: 'No such object', statusCode: 404 } }; },
    async delete(name) { return data.delete(name) ? { ok: true, value: null, error: null } : { ok: false, value: null, error: { message: 'not found' } }; },
    async list({ prefix }) { return { ok: true, value: [...data.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name })), error: null }; },
  };
  const store = replitStore(client);
  assert.strictEqual(await store.get('s/a.json.enc'), null);
  await store.put('s/a.json.enc', Buffer.from('abc'));
  assert.deepStrictEqual(await store.get('s/a.json.enc'), Buffer.from('abc'));
  assert.deepStrictEqual(await store.list('s/'), [{ name: 's/a.json.enc', size: null }]);
  assert.strictEqual(await store.delete('s/a.json.enc'), true);
  assert.strictEqual(await store.delete('s/a.json.enc'), false);
  const broken = replitStore({ downloadAsBytes: async () => ({ ok: false, error: { message: 'quota exceeded' } }), uploadFromBytes: async () => ({ ok: false, error: { message: 'denied' } }) });
  await assert.rejects(() => broken.get('x'), /download failed: quota exceeded/);
  await assert.rejects(() => broken.put('x', Buffer.from('a')), /upload failed: denied/);
  assert.deepStrictEqual(await replitStore({ downloadAsBytes: async () => ({ ok: true, value: Buffer.from('flat') }) }).get('x'), Buffer.from('flat'), 'a bare value works too');
});

test('the app never decrypts, and the sources hold no credential', () => {
  const sources = fs.readdirSync(__dirname).filter((file) => file.endsWith('.js') && !file.endsWith('.test.js') && file !== 'harness.js');
  for (const file of sources) {
    const text = fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/(^|\s)\/\/\s.*$/gm, '');  // code, not comments
    assert.ok(!/decrypt|createDecipher|subtle|passphrase|seal\.js/i.test(text), `${file} must not decrypt or know the passphrase`);
    assert.ok(!/(?:hrk_|sk-|AKIA|-----BEGIN)[A-Za-z0-9+/_-]{20,}/.test(text), `${file} holds something shaped like a credential`);
  }
});
