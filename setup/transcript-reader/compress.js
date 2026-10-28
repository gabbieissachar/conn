'use strict';

// Compression for the reader server's answers (server.js puts it in front of every listener: loopback and both
// tailnet ones). The phone reads over a Tailscale relay with little throughput, and the built page and its JSON are text
// that shrinks five to ten times. Only the body changes: every status, header, guard and passcode check stays api.js's,
// because this wraps the response before api.js sees it and decides at writeHead.
//
// Compressed: a 200 answer whose type is text or JSON (the built pages, API JSON, static shell files, a shown file's
// HTML, script and style), when the request's Accept-Encoding names br or gzip (br wins at equal q). Left alone: any
// other status, an answer that already names an encoding, a HEAD request, pictures and other binary types, and a small
// body (the gain does not pay for the encoding header).

const zlib = require('zlib');
const { Writable } = require('stream');

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/i;
// Brotli at its default quality (11) is slow on a 20 MB page; 5 is close to gzip's speed and smaller.
const BROTLI_QUALITY = 5;
const MIN_BYTES = 256;

// 'br', 'gzip' or null: the coding the request asks for. An entry with q=0 is a refusal; "*" stands for any coding.
function negotiate(header) {
  if (typeof header !== 'string') return null;
  const weights = new Map();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    weights.set(name.trim(), Number.isFinite(weight) ? weight : 0);
  }
  const weight = (name) => (weights.has(name) ? weights.get(name) : (weights.get('*') || 0));
  const br = weight('br');
  const gzip = weight('gzip');
  if (br <= 0 && gzip <= 0) return null;
  return br >= gzip ? 'br' : 'gzip';
}

// Header names are case-insensitive: the key spelled as the caller wrote it, or undefined.
const keyOf = (headers, name) => Object.keys(headers).find((key) => key.toLowerCase() === name);

function addVary(headers, value) {
  const key = keyOf(headers, 'vary');
  if (key === undefined) { headers.Vary = value; return; }
  if (!String(headers[key]).split(',').some((v) => v.trim().toLowerCase() === value.toLowerCase() || v.trim() === '*')) headers[key] += ', ' + value;
}

// Wraps res so a compressible answer leaves compressed. Call it first thing for a request, before anything writes.
function compression(req, res) {
  const coding = req.method === 'HEAD' ? null : negotiate(req.headers['accept-encoding']);
  if (!coding) return;
  const writeHead = res.writeHead;
  const write = res.write;
  const end = res.end;
  let stream = null;
  res.writeHead = function (status, ...rest) {
    res.writeHead = writeHead;
    const given = rest.find((value) => value && typeof value === 'object' && !Array.isArray(value));
    const headers = { ...(given || {}) };
    const type = headers[keyOf(headers, 'content-type')] || res.getHeader('content-type');
    const length = headers[keyOf(headers, 'content-length')] ?? res.getHeader('content-length');
    const encoded = headers[keyOf(headers, 'content-encoding')] || res.getHeader('content-encoding');
    if (status === 200 && !encoded && typeof type === 'string' && COMPRESSIBLE.test(type) && !(length !== undefined && Number(length) < MIN_BYTES)) {
      const lengthKey = keyOf(headers, 'content-length');
      if (lengthKey !== undefined) delete headers[lengthKey];
      res.removeHeader('content-length');
      addVary(headers, 'Accept-Encoding');
      headers['Content-Encoding'] = coding;
      stream = coding === 'br'
        ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
        : zlib.createGzip({ level: 6 });
      stream.pipe(new Writable({
        write(chunk, encoding, done) { if (write.call(res, chunk)) done(); else res.once('drain', done); },
        final(done) { end.call(res); done(); },
      }));
      res.on('close', () => stream.destroy());
      res.write = (chunk, encoding, callback) => stream.write(chunk, encoding, callback);
      res.end = (chunk, encoding, callback) => {
        if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
        else if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
        stream.end(chunk, encoding, callback);
        return res;
      };
      const out = given ? rest.map((value) => (value === given ? headers : value)) : [...rest, headers];
      return writeHead.call(res, status, ...out);
    }
    return writeHead.call(res, status, ...rest);
  };
}

module.exports = { compression, negotiate };
