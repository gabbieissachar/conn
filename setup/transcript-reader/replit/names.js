'use strict';

// The names the app serves and accepts, and what each kind of body must look like. Everything that
// reaches the object store goes through classify(): a name that is not one of these never touches
// storage, which is what refuses traversal ("..", encoded dots, backslashes, a leading slash).
//
// The layout is the bucket sync.py --dry-run writes (README.md "The sealed copy"):
//   index.html           the shell page (no transcript in it); sheet.html, the answer sheet's shell
//   k/params.json        the salt and iteration count of the key derivation (no secret), and a sealed check word
//   index.json.enc       the sealed index
//   s|d|f|a/<id>.json.enc  a sealed conversation, document, week of fleet records or answer sheet
//   q/<uuid>.json.enc    a sealed message the page queues for the laptop to send (POST /api/transcript-reader/queue, the owner's session)
//   r/<uuid>.json.enc    a sealed receipt the laptop writes for a queued message

const MIB = 1024 * 1024;

const KINDS = {
  shell: { re: /^(?:index|sheet)\.html$/, max: 4 * MIB, type: 'text/html; charset=utf-8' },
  params: { re: /^k\/params\.json$/, max: 4096, type: 'application/json' },
  index: { re: /^index\.json\.enc$/, max: 32 * MIB, type: 'application/octet-stream' },
  object: { re: /^[sdfa]\/[A-Za-z0-9_-]{1,64}\.json\.enc$/, max: 32 * MIB, type: 'application/octet-stream' },
  queue: { re: /^q\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.enc$/, max: 64 * 1024, type: 'application/octet-stream' },
  receipt: { re: /^r\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.enc$/, max: 64 * 1024, type: 'application/octet-stream' },
};

const MAGIC = Buffer.from('HRC1');  // prototype/seal.js: "HRC1", a 12-byte nonce, then the ciphertext and its tag
const SEALED_MIN = 32;
const PARAMS_KEYS = ['version', 'kdf', 'hash', 'iterations', 'salt', 'check'];

// The kind of a name, or null when the app serves no such name.
function classify(name) {
  if (typeof name !== 'string' || name.length > 128) return null;
  for (const [kind, { re }] of Object.entries(KINDS)) if (re.test(name)) return kind;
  return null;
}

const sealed = (kind) => kind === 'index' || kind === 'object' || kind === 'queue' || kind === 'receipt';

// Whether bytes are a plausible body for the kind; false means refuse the upload. Only sealed
// objects, the key parameters and the shell page are accepted, so the store holds no plain transcript.
function checkBody(kind, bytes) {
  if (!KINDS[kind] || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > KINDS[kind].max) return false;
  if (sealed(kind)) return bytes.length >= SEALED_MIN && bytes.subarray(0, 4).equals(MAGIC);
  if (kind === 'params') {
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { return false; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    if (keys.join() !== [...PARAMS_KEYS].sort().join()) return false;
    return value.kdf === 'PBKDF2' && value.hash === 'SHA-256' && Number.isInteger(value.iterations) && value.iterations > 0
      && typeof value.salt === 'string' && typeof value.check === 'string' && Number.isInteger(value.version);
  }
  if (kind === 'shell') return /^\s*<!doctype html/i.test(bytes.subarray(0, 64).toString('utf8'));
  return false;
}

const maxBytes = (kind) => (KINDS[kind] ? KINDS[kind].max : 0);
const contentType = (kind) => KINDS[kind].type;

module.exports = { classify, checkBody, maxBytes, contentType, KINDS, MAGIC };
