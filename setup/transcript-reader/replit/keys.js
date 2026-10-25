'use strict';

// Upload keys, the Marking-Down pattern: a long random bearer key, shown once, of which only the
// SHA-256 hash is kept, and which can be revoked. The hashes are one object in the store
// (_admin/keys.json, a name names.classify never serves) so a revoked key stops working at once,
// without a deploy. Nothing here logs or returns a key except create(), once.

const crypto = require('crypto');

const FILE = '_admin/keys.json';
const PREFIX = 'hrk_';

const hash = (key) => crypto.createHash('sha256').update(key, 'utf8').digest('hex');

async function load(store) {
  const bytes = await store.get(FILE);
  if (!bytes) return { keys: [] };
  const value = JSON.parse(bytes.toString('utf8'));
  return { keys: Array.isArray(value.keys) ? value.keys : [] };
}

const save = (store, value) => store.put(FILE, Buffer.from(JSON.stringify(value)));

// A new key: { key, id, label }. The key is not kept anywhere; only its hash is.
async function create(store, label, now = Date.now()) {
  const key = PREFIX + crypto.randomBytes(32).toString('base64url');
  const digest = hash(key);
  const entry = { id: digest.slice(0, 12), hash: digest, label: String(label || 'laptop').slice(0, 60), created: Math.floor(now / 1000) };
  const value = await load(store);
  value.keys.push(entry);
  await save(store, value);
  return { key, id: entry.id, label: entry.label };
}

// Revokes by id (the first 12 characters of the hash, which list() shows); false when there is none.
async function revoke(store, id, now = Date.now()) {
  const value = await load(store);
  const entry = value.keys.find((item) => item.id === id && !item.revoked);
  if (!entry) return false;
  entry.revoked = Math.floor(now / 1000);
  await save(store, value);
  return true;
}

async function list(store) {
  return (await load(store)).keys.map(({ id, label, created, revoked }) => ({ id, label, created, revoked: revoked || null }));
}

// The entry's id when the presented key is a live one, else null. Compares hashes in constant time.
async function verify(store, presented) {
  if (typeof presented !== 'string' || !presented.startsWith(PREFIX) || presented.length > 200) return null;
  const given = Buffer.from(hash(presented), 'hex');
  let found = null;
  for (const entry of (await load(store)).keys) {
    const known = Buffer.from(String(entry.hash), 'hex');
    if (known.length === given.length && crypto.timingSafeEqual(known, given) && !entry.revoked) found = entry.id;
  }
  return found;
}

module.exports = { create, revoke, list, verify, hash, FILE };
