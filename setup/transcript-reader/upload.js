#!/usr/bin/env node
'use strict';

// Seals the hosted copy's objects into a local folder: the bucket --seal writes (sync.py
// --seal runs this; ship 2 writes nowhere else). The format is prototype/seal.js's, which the
// hosted shell uses to open them.
//
//   HOSTED_READER_PASSPHRASE=... node setup/transcript-reader/upload.js <folder>
//
//   ... node setup/transcript-reader/upload.js <folder> --new-key   (seal under a new passphrase)
//
// The passphrase comes from the environment only, and is never written or printed. On start it
// reads <folder>/k/params.json. When there is none, or with --new-key, it writes new params (a
// new salt: every object must then be sealed again) and says so; a passphrase that does not open
// existing params stops it, with {"ready":false} on stdout. Then it prints
// {"ready":true,"rekeyed":...} and reads one JSON line per object from stdin,
// {"path":"s/<id>.json","text":"<the object's JSON>"}, gzips and seals it, and writes
// <folder>/<path>.enc in one rename. At the end of stdin it prints {"written":<count>}. A line ends at "\n" and nowhere else
// (see lines() below).

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const zlib = require('zlib');
const seal = require('./prototype/seal.js');

// The paths sync.py writes: the index, and conversation, document, week, answer-sheet and tool-output objects.
const OBJECT_RE = /^(?:index|[sdfat]\/[A-Za-z0-9_-]{1,64})\.json$/;

// The owner's alone (0600 in 0700 folders), like Claude's logs and the reader's own files.
function replace(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const partial = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.partial`);
  fs.writeFileSync(partial, bytes, { mode: 0o600 });
  fs.chmodSync(partial, 0o600);
  fs.renameSync(partial, file);
}

// The lines of a stream: each ends at "\n" and at nothing else. readline is not used for this on purpose: it also ends a line at
// U+2028 and U+2029, and sync.py writes those as they are inside a conversation's text (JSON allows them raw in a string), so it cut
// such an object in half and the seal stopped there ("Unterminated string in JSON at position N"). A character split between two
// chunks is joined by the decoder; a last line with no newline is still a line.
async function* lines(input) {
  const decoder = new StringDecoder('utf8');
  let pieces = [];  // the start of a line whose end has not arrived yet (joined once, not on every chunk: a line may be megabytes)
  for await (const chunk of input) {
    let text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n')) {
      yield pieces.concat(text.slice(0, at)).join('');
      pieces = [];
      text = text.slice(at + 1);
    }
    if (text) pieces.push(text);
  }
  pieces.push(decoder.end());
  const last = pieces.join('');
  if (last) yield last;
}

async function main(argv, env = process.env, input = process.stdin, output = process.stdout) {
  const folder = argv[0];
  const passphrase = env.HOSTED_READER_PASSPHRASE || '';
  if (!folder) throw new Error('usage: upload.js <folder>');
  if (!passphrase) throw new Error('Set HOSTED_READER_PASSPHRASE; the passphrase is read from the environment only.');
  const paramsFile = path.join(folder, 'k', 'params.json');
  let params = null;
  try { params = JSON.parse(fs.readFileSync(paramsFile, 'utf8')); } catch { params = null; }
  let key = params && !argv.includes('--new-key') ? await seal.unlock(passphrase, params) : null;
  if (params && !key && !argv.includes('--new-key')) {
    output.write(JSON.stringify({ ready: false, error: 'wrong-passphrase' }) + '\n');
    return 2;
  }
  const rekeyed = !key;
  if (rekeyed) {
    ({ params, key } = await seal.newParams(passphrase));
    replace(paramsFile, JSON.stringify(params));
  }
  output.write(JSON.stringify({ ready: true, rekeyed }) + '\n');
  let written = 0;
  for await (const line of lines(input)) {
    if (!line.trim()) continue;
    let item;
    // Not the parser's own message: V8's quotes the start of the text it could not read, and this one ends up in a log and on the page's Sync line.
    try { item = JSON.parse(line); } catch { throw new Error(`A line of ${line.length} characters is not JSON, so nothing after it was sealed`); }
    const { path: name, text } = item || {};
    if (typeof name !== 'string' || !OBJECT_RE.test(name) || typeof text !== 'string') throw new Error('Not an object of the hosted copy: ' + String(name).slice(0, 80));
    replace(path.join(folder, name + '.enc'), await seal.close(key, name, zlib.gzipSync(Buffer.from(text, 'utf8'))));
    written += 1;
  }
  output.write(JSON.stringify({ written }) + '\n');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(error.message + '\n'); process.exit(1); });
}

module.exports = { main, lines, OBJECT_RE, replace };
