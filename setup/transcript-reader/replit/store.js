'use strict';

// Where the objects live. The app talks to one small interface, so the tests and a local run need
// no Replit:
//   get(name)      -> Buffer, or null when there is no such object
//   put(name, buf)
//   delete(name)   -> whether it existed
//   list(prefix)   -> [{ name, size }], size null when the store does not say
// The names are already checked by names.classify (the app never passes anything else); the file
// store also refuses any path that leaves its folder, as a second line.

const fs = require('fs');
const path = require('path');

function memoryStore() {
  const objects = new Map();
  return {
    async get(name) { return objects.has(name) ? Buffer.from(objects.get(name)) : null; },
    async put(name, bytes) { objects.set(name, Buffer.from(bytes)); },
    async delete(name) { return objects.delete(name); },
    async list(prefix = '') { return [...objects].filter(([name]) => name.startsWith(prefix)).map(([name, bytes]) => ({ name, size: bytes.length })).sort((a, b) => (a.name < b.name ? -1 : 1)); },
  };
}

// A folder as a bucket: for tests and a run on this laptop (OBJECT_STORE_DIR).
function fileStore(root) {
  const base = path.resolve(root);
  const locate = (name) => {
    const file = path.resolve(base, name);
    if (typeof name !== 'string' || !name || name.includes('\0') || !file.startsWith(base + path.sep)) throw new Error('Refused a name outside the store.');
    return file;
  };
  const walk = (dir, out = []) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.isFile() && !entry.name.endsWith('.partial')) out.push(full);
    }
    return out;
  };
  return {
    async get(name) {
      try { return fs.readFileSync(locate(name)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async put(name, bytes) {
      const file = locate(name);
      // Owner-only, like everything else this work writes (the key hashes are in here too).
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const partial = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.partial`);
      fs.writeFileSync(partial, bytes, { mode: 0o600 });
      fs.renameSync(partial, file);
    },
    async delete(name) {
      const file = locate(name);
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      return true;
    },
    async list(prefix = '') {
      return walk(base).map((file) => ({ name: path.relative(base, file).split(path.sep).join('/'), size: fs.statSync(file).size }))
        .filter(({ name }) => name.startsWith(prefix)).sort((a, b) => (a.name < b.name ? -1 : 1));
    },
  };
}

// Replit Object Storage, through its client (npm package @replit/object-storage). Its calls return
// { ok, value, error } rather than throwing. Written from the package's documented shape and not
// run against Replit from here (a hard limit of the build): this is the one place to adjust if the
// client's result shape differs. Pass a client of your own in tests.
function replitStore(client) {
  if (!client) {
    const { Client } = require('@replit/object-storage');
    client = new Client();
  }
  const fail = (result, what) => { throw new Error(`Object storage ${what} failed: ${(result.error && result.error.message) || 'unknown error'}`); };
  const missing = (error) => Boolean(error) && (error.statusCode === 404 || /not.?found|no such|NoSuchKey/i.test(String(error.message || error)));
  return {
    async get(name) {
      const result = await client.downloadAsBytes(name);
      if (!result.ok) { if (missing(result.error)) return null; fail(result, 'download'); }
      const value = Array.isArray(result.value) ? result.value[0] : result.value;
      return Buffer.from(value);
    },
    async put(name, bytes) {
      const result = await client.uploadFromBytes(name, Buffer.from(bytes));
      if (!result.ok) fail(result, 'upload');
    },
    async delete(name) {
      const result = await client.delete(name);
      if (!result.ok) { if (missing(result.error)) return false; fail(result, 'delete'); }
      return true;
    },
    async list(prefix = '') {
      const result = await client.list({ prefix });
      if (!result.ok) fail(result, 'list');
      return result.value.map((item) => ({ name: item.name, size: null })).sort((a, b) => (a.name < b.name ? -1 : 1));
    },
  };
}

module.exports = { memoryStore, fileStore, replitStore };
