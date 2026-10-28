'use strict';

// A phone for the tests that run the offline copy's page code (prototype/hosted.js, sw.js) in a Node sandbox: a small
// IndexedDB, Cache storage, a service worker registration, and a laptop that can be reachable or not, serving a real sealed
// bucket (sealed with the page's own seal.js). Not a test file itself.
//
//   const phone = require('./phonefake');
//   const laptop = await phone.laptop({ conversations: 3 });   // a sealed bucket in memory, and what answers for it
//   const device = phone.device();                             // storage that outlives page loads, as a phone's does
//   const page = phone.page({ laptop, device });                // one page load: hosted.js in a sandbox over that storage
//
// Every fetch the page makes is recorded in laptop.requests, and laptop.down = true makes them fail the way a shut Mac does
// (the browser's timeout, which the sandbox's clock fires at once).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SEAL = fs.readFileSync(path.join(__dirname, 'prototype', 'seal.js'), 'utf8');
const HOSTED = fs.readFileSync(path.join(__dirname, 'prototype', 'hosted.js'), 'utf8');
const TOKEN = 'c'.repeat(64);
const PASSPHRASE = 'a made-up passphrase for the phone tests';

// ------------------------------------------------------------------ IndexedDB

function createIndexedDB() {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);
  function request(work) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    req.run = () => { req.result = work(); if (req.onsuccess) req.onsuccess({ target: req }); };
    return req;
  }
  function transaction(db, names) {
    const tx = { error: null, oncomplete: null, onerror: null, onabort: null, pending: 0, done: false };
    const finish = () => { if (!tx.done && tx.pending === 0) { tx.done = true; if (tx.oncomplete) tx.oncomplete(); } };
    const track = (req) => { tx.pending += 1; later(() => { req.run(); tx.pending -= 1; later(finish); }); return req; };
    later(finish);
    tx.objectStore = (name) => {
      if (!names.includes(name)) throw new Error('NotFoundError: ' + name);
      const records = db.stores.get(name);
      return {
        get: (key) => track(request(() => (records.has(key) ? structuredClone(records.get(key)) : undefined))),
        put: (value, key) => track(request(() => { records.set(key, structuredClone(value)); return key; })),
        delete: (key) => track(request(() => { records.delete(key); })),
        clear: () => track(request(() => { records.clear(); })),
        openCursor: () => {
          const keys = [...records.keys()].sort();
          let at = 0;
          const req = { result: null, onsuccess: null, onerror: null };
          const step = () => {
            tx.pending += 1;
            later(() => {
              req.result = at < keys.length ? { key: keys[at], value: structuredClone(records.get(keys[at])), continue: () => { at += 1; step(); } } : null;
              if (req.onsuccess) req.onsuccess({ target: req });
              tx.pending -= 1;
              later(finish);
            });
          };
          step();
          return req;
        },
      };
    };
    return tx;
  }
  return {
    databases,
    open(name, version) {
      const open = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      later(() => {
        let db = databases.get(name);
        const upgrading = !db || db.version < version;
        if (!db) { db = { version: 0, stores: new Map() }; databases.set(name, db); }
        const handle = {
          objectStoreNames: { contains: (store) => db.stores.has(store) },
          createObjectStore: (store) => { db.stores.set(store, new Map()); },
          transaction: (names) => transaction(db, [].concat(names)),
        };
        open.result = handle;
        if (upgrading) { db.version = version; if (open.onupgradeneeded) open.onupgradeneeded(); }
        if (open.onsuccess) open.onsuccess();
      });
      return open;
    },
    // What is stored, for a test to look at: store name -> Map of key -> value.
    dump: (name) => (databases.get(name) || { stores: new Map() }).stores,
  };
}

// ------------------------------------------------------------------ the device: storage that outlives page loads

function device() {
  const caches = new Map();
  const cacheApi = {
    open: async (name) => {
      if (!caches.has(name)) caches.set(name, new Map());
      const entries = caches.get(name);
      return { put: async (url, response) => { entries.set(url, response); }, match: async (url) => entries.get(url) };
    },
    keys: async () => [...caches.keys()],
    delete: async (name) => caches.delete(name),
  };
  return { indexedDB: createIndexedDB(), caches: cacheApi, cacheEntries: caches, registrations: [], local: new Map() };
}

// ------------------------------------------------------------------ the laptop and its sealed bucket

// A sealed bucket in memory. objects: path -> value, sealed on demand under the passphrase's key; index.json lists their stamps.
async function laptop({ conversations = 3, documents = 1, weeks = 1, passphrase = PASSPHRASE } = {}) {
  const sandbox = { crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, Blob, Response, CompressionStream, DecompressionStream, Uint8Array };
  vm.createContext(sandbox);
  const seal = vm.runInContext(SEAL + '\nseal;', sandbox);
  const { params, key } = await seal.newParams(passphrase);
  const lap = { seal, params, key, passphrase, down: false, status: {}, requests: [], plain: new Map(), sealed: new Map(), stamps: {}, queued: [], queueAnswer: null };
  lap.set = async (rel, value, stamp) => {
    lap.plain.set(rel, value);
    lap.stamps[rel] = stamp || `${rel}@${lap.plain.size}`;
    lap.sealed.set(rel, Buffer.from(await seal.close(key, rel, await seal.gzip(new TextEncoder().encode(JSON.stringify(value))))));
  };
  lap.index = {
    version: 1, as_of: Date.now() / 1000 - 5, since: 0, template: 'page-code-1', sheet_template: 'sheet-code-1', homes: ['main'], summaries: [],
    conversations: [], documents: {}, weeks: {}, sheets: {},
  };
  for (let i = 0; i < conversations; i += 1) {
    const id = `${String(i + 1).repeat(8)}-1111-4111-8111-111111111111`;
    await lap.set(`s/${id}.json`, { id, home: 'main', exchanges: [{ at: 1000 + i, source: 'captain', input: `Message ${i}`, reply: `Reply ${i}` }] });
    lap.index.conversations.push({ id, ids: [id], home: 'main', object: `s/${id}.json`, stamp: lap.stamps[`s/${id}.json`], last: 1000 + i, needs: 0 });
  }
  for (let i = 0; i < documents; i += 1) {
    const rel = `d/doc${i}.json`;
    await lap.set(rel, { id: `doc${i}`, name: `notes${i}.md`, text: `# Notes ${i}` });
    lap.index.documents[`doc${i}`] = { id: `doc${i}`, name: `notes${i}.md`, dir: '~/x', mtime: 1, object: rel, stamp: lap.stamps[rel] };
  }
  for (let i = 0; i < weeks; i += 1) {
    const rel = `f/2026-W4${i}.json`;
    await lap.set(rel, { week: `2026-W4${i}`, events: [{ at: 1000 + i }] });
    lap.index.weeks[`2026-W4${i}`] = { object: rel, stamp: lap.stamps[rel], from: 900, to: 1100, events: 1, open: 0 };
  }
  // Seals the index as it is now (a build the laptop made), under the key.
  lap.publish = async (patch = {}) => {
    Object.assign(lap.index, patch);
    lap.sealed.set('index.json', Buffer.from(await seal.close(key, 'index.json', await seal.gzip(new TextEncoder().encode(JSON.stringify(lap.index))))));
  };
  await lap.publish();
  const paramsText = JSON.stringify(params);
  // The server's answer to one request, as the page's fetch gets it. A shut laptop never answers: the browser's timeout rejects it.
  lap.respond = async (url, options = {}) => {
    lap.requests.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    if (lap.down) throw new TypeError('Load failed');
    const reply = (status, body, extra = {}) => ({ ok: status < 400, status, ...extra, json: async () => (typeof body === 'string' ? JSON.parse(body) : body), arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new TextEncoder().encode(String(body)).buffer), text: async () => String(body) });
    if (lap.status[url]) return reply(lap.status[url], lap.status[url] === 403 ? { status: 'error', message: 'Missing or invalid token' } : {});
    if (url === 'k/params.json') return reply(200, paramsText);
    if (url.startsWith('/api/transcript-reader/queue') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      if (lap.queueAnswer) return reply(lap.queueAnswer.status, lap.queueAnswer.body);
      if (lap.queued.some((item) => item.id === body.id)) return reply(409, { status: 'error', code: 'exists', message: 'That request is already queued.' });
      lap.queued.push(body);
      return reply(200, { status: 'ok', id: body.id, queued: lap.queued.length });
    }
    if (url.endsWith('.enc') && lap.sealed.has(url.slice(0, -4))) return reply(200, lap.sealed.get(url.slice(0, -4)));
    if (/^(?:index|sheet)\.html$|^manifest\.webmanifest$|^icon-/.test(url.split('/').pop() || '')) return reply(200, `<shell ${url}>`, { headers: { get: () => 'text/html' } });
    return reply(404, {});
  };
  lap.fetchesOf = (pattern) => lap.requests.filter((request) => pattern.test(request.url) && request.method === 'GET').map((request) => request.url);
  return lap;
}

// ------------------------------------------------------------------ one page load

// hosted.js (with seal.js) in a sandbox over the device's storage and the laptop. secure: false makes the page's address one a
// service worker is not allowed on (plain http on a tailnet address).
function page({ laptop: lap, device: dev, secure = true, now = () => Date.now(), token = TOKEN } = {}) {
  const timers = [];
  const listeners = {};
  const sessionStore = new Map();
  let reloads = 0;
  const workerMessages = [];
  const serviceWorker = {
    controller: {},
    register: async (url) => { dev.registrations.push(url); return {}; },
    ready: Promise.resolve({}),
    getRegistrations: async () => { const all = dev.registrations.splice(0).map((url) => ({ unregister: async () => true, url })); return all; },
    addEventListener: (name, fn) => { workerMessages.push({ name, fn }); },
  };
  const sandbox = {
    document: {
      hidden: false,
      querySelector: (selector) => (selector === 'meta[name="reader-token"]' ? { content: token } : null),
      addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    },
    fetch: (url, options = {}) => new Promise((resolve, reject) => {
      if (options.signal) options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      lap.respond(url, options).then(resolve, reject);
    }),
    AbortController, Date: class extends Date { static now() { return now(); } }, JSON, Map, Set, Promise, Object, Number, String, Error, Array, Uint8Array, TextEncoder, TextDecoder, Math, URL,
    crypto: globalThis.crypto, btoa, atob, Blob, Response, CompressionStream, DecompressionStream, structuredClone,
    indexedDB: dev.indexedDB, caches: dev.caches,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    setInterval: (fn, ms) => { timers.push({ fn, ms, every: true }); return timers.length; },
    sessionStorage: { getItem: (k) => sessionStore.get(k) || null, setItem: (k, v) => sessionStore.set(k, v) },
    location: { href: 'https://phone.example.ts.net:8443/setup/transcript-reader/out/bucket/index.html', reload: () => { reloads += 1; } },
    navigator: { serviceWorker, storage: { persist: async () => true } },
    isSecureContext: secure,
    confirm: () => true,
  };
  if (!secure) delete sandbox.navigator.serviceWorker;
  vm.createContext(sandbox);
  const hosted = vm.runInContext(SEAL + HOSTED + '\nhosted;', sandbox);
  return { hosted, sandbox, timers, listeners, workerMessages, reloads: () => reloads, serviceWorker };
}

module.exports = { laptop, device, page, createIndexedDB, TOKEN, PASSPHRASE };
