#!/usr/bin/env node
'use strict';

// Seals the hosted copy's objects into a local folder: the bucket of a dry run (sync.py
// --dry-run runs this; ship 2 writes nowhere else). The format is prototype/seal.js's, which the
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
// <folder>/<path>.enc in one rename. At the end of stdin it prints {"written":<count>}.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const seal = require('./prototype/seal.js');

// The paths sync.py writes: the index, and conversation, document, week and answer-sheet objects.
const OBJECT_RE = /^(?:index|[sdfa]\/[A-Za-z0-9_-]{1,64})\.json$/;

// The owner's alone (0600 in 0700 folders), like Claude's logs and the reader's own files.
function replace(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const partial = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.partial`);
  fs.writeFileSync(partial, bytes, { mode: 0o600 });
  fs.chmodSync(partial, 0o600);
  fs.renameSync(partial, file);
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
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const { path: name, text } = JSON.parse(line);
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

module.exports = { main, OBJECT_RE };
