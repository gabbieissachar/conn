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
  if (!bytes) return { keys: [], rev: 0 };
  const value = JSON.parse(bytes.toString('utf8'));
  return { keys: Array.isArray(value.keys) ? value.keys : [], rev: Number(value.rev) || 0 };
}

// Changes to the key file one at a time here, and checked against another process's change (the
// shell command and the app share it): a change made on an older copy is made again on the new one.
let turn = Promise.resolve();
function change(store, apply) {
  const run = async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const value = await load(store);
      const rev = value.rev || 0;
      const result = apply(value);
      if (result === false) return false;
      if (((await load(store)).rev || 0) !== rev) continue;
      value.rev = rev + 1;
      await store.put(FILE, Buffer.from(JSON.stringify(value)));
      return result;
    }
    throw new Error('The key file kept changing under this command; try again.');
  };
  const next = turn.then(run, run);
  turn = next.catch(() => {});
  return next;
}

// A new key: { key, id, label }. The key is not kept anywhere; only its hash is.
async function create(store, label, now = Date.now()) {
  const key = PREFIX + crypto.randomBytes(32).toString('base64url');
  const digest = hash(key);
  const entry = { id: digest.slice(0, 12), hash: digest, label: String(label || 'laptop').slice(0, 60), created: Math.floor(now / 1000) };
  await change(store, (value) => { value.keys.push(entry); return true; });
  return { key, id: entry.id, label: entry.label };
}

// Revokes by id (the first 12 characters of the hash, which list() shows); false when there is none.
async function revoke(store, id, now = Date.now()) {
  return change(store, (value) => {
    const entry = value.keys.find((item) => item.id === id && !item.revoked);
    if (!entry) return false;
    entry.revoked = Math.floor(now / 1000);
    return true;
  });
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
