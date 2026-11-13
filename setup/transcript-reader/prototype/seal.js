  // ---------------------------------------------------------------- the hosted copy's encryption (seal.js)
  // One format for both ends, through WebCrypto alone: upload.js (Node) seals each object before
  // it is written to the bucket, and build_prototype.fill_template pastes this file into the hosted
  // shell, which opens them in the browser. Nothing here holds or logs a passphrase.
  //
  // An object is gzip-compressed JSON, sealed with AES-256-GCM under a key derived from the
  // passphrase with PBKDF2-SHA256 (k/params.json holds the salt and iteration count, no secret).
  // Sealed bytes are "HRC1", a random 12-byte nonce, then the ciphertext and its tag. The object's
  // own path is the additional data, so the host cannot pass one object off as another.
  // params.check is the sealed word "hosted-reader" (path "k/check"): opening it tells a right
  // passphrase from a wrong one before anything else is fetched.
  const seal = (() => {
    const subtle = globalThis.crypto.subtle;
    const MAGIC = [0x48, 0x52, 0x43, 0x31];  // "HRC1"
    const ITERATIONS = 600000;
    const CHECK = "hosted-reader";
    const text = new TextEncoder();
    const toBase64 = bytes => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
    const fromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
    // The key a passphrase gives under these params; it never leaves WebCrypto (not extractable).
    async function deriveKey(passphrase, params) {
      if (params.kdf !== "PBKDF2" || params.hash !== "SHA-256") throw new Error("This copy uses a key derivation this page does not know.");
      const base = await subtle.importKey("raw", text.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
      return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(params.salt), iterations: params.iterations },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    }
    async function close(key, path, bytes) {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: text.encode(path) }, key, bytes));
      const out = new Uint8Array(4 + 12 + sealed.length);
      out.set(MAGIC, 0); out.set(iv, 4); out.set(sealed, 16);
      return out;
    }
    // The plaintext, or an Error: a wrong key, another object's bytes or a changed byte all fail the tag.
    async function open(key, path, bytes) {
      const data = new Uint8Array(bytes);
      if (data.length < 32 || MAGIC.some((b, i) => data[i] !== b)) throw new Error(`${path} is not a sealed object.`);
      try {
        return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: data.subarray(4, 16), additionalData: text.encode(path) }, key, data.subarray(16)));
      } catch (e) {
        throw new Error(`${path} does not open with this passphrase.`);
      }
    }
    // New params: a fresh salt, and the check sealed under the key they give.
    async function newParams(passphrase) {
      const params = { version: 1, kdf: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: toBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))) };
      const key = await deriveKey(passphrase, params);
      params.check = toBase64(await close(key, "k/check", text.encode(CHECK)));
      return { params, key };
    }
    // The key, when the passphrase opens these params' check; else null.
    async function unlock(passphrase, params) {
      const key = await deriveKey(passphrase, params);
      try { await open(key, "k/check", fromBase64(params.check)); return key; } catch (e) { return null; }
    }
    const gunzip = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const gzip = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    // A sealed object back to its JSON value.
    const openJson = async (key, path, bytes) => JSON.parse(new TextDecoder().decode(await gunzip(await open(key, path, bytes))));
    return { deriveKey, close, open, openJson, newParams, unlock, gunzip, gzip, toBase64, fromBase64, ITERATIONS };
  })();
  if (typeof module !== "undefined") module.exports = seal;
