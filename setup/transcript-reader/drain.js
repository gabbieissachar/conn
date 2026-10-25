#!/usr/bin/env node
'use strict';

// Sends what the hosted copy's page queued: the delivery half of its Send (plan section 8).
// The page writes a request, {session_id, text}, to <folder>/q/<uuid>.json (a plain copy) or, sealed
// by the page with the passphrase's key, to q/<uuid>.json.enc (a sealed bucket); the sync agent
// (sync.py, once a minute while the laptop is awake) runs this on the folder.
//
//   node setup/transcript-reader/drain.js <folder>          (a sealed bucket: HOSTED_READER_PASSPHRASE)
//
// Each request is checked again here, now, by the local reader's own send (api.js sendPrompt, so the
// conditions are the same code): the session is a conversation of this copy; one live Herdr pane
// runs it; its agent is Claude running that very session, in the foreground and not at a permission
// prompt or question; the pane's input box is emptied; then the text goes in as one message.
// Whatever the outcome, a receipt is written to r/<uuid>.json(.enc) for the page to show, and the
// request leaves q/. Written before the send as "sending" and then replaced, so a run that stops
// midway never sends the same text twice: the next run turns that receipt into "refused:
// interrupted" and the owner checks the pane. A refusal is final (nothing retries by itself): the
// page says why and the owner sends again. A request that waited over 12 hours is refused as
// expired, so an old message never lands in a conversation that moved on. Receipts go after 7 days.
//
// HOSTED_READER_HERDR names the Herdr binary (default `herdr`); tests give it a fake. With no
// request in q/, nothing is read, unlocked or sent.
//
// Receipt: { id, session_id, state: "sending" | "sent" | "refused", code, reason, label, queued_at, at }.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const seal = require('./prototype/seal.js');
const { replace } = require('./upload.js');
const { create, checkText } = require('./api');

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID_RE = new RegExp('^' + ID + '$');
const TTL_MS = 12 * 3600 * 1000;
const RECEIPT_KEEP_MS = 7 * 86400 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;

const listing = (folder, re) => { try { return fs.readdirSync(folder).filter((name) => re.test(name)); } catch { return []; } };
const exists = (file) => { try { fs.statSync(file); return true; } catch { return false; } };
const mtimeMs = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

// The conversations the copy lists, which a request may name (the newest session of each).
async function listedIds(folder, key) {
  let text;
  try {
    text = key ? zlib.gunzipSync(Buffer.from(await seal.open(key, 'index.json', fs.readFileSync(path.join(folder, 'index.json.enc'))))).toString('utf8')
      : fs.readFileSync(path.join(folder, 'index.json'), 'utf8');
    return ((JSON.parse(text).conversations) || []).map((entry) => entry.id).filter((id) => SESSION_ID_RE.test(id));
  } catch { return []; }
}

async function drain({ folder, passphrase = '', root = path.join(__dirname, '..', '..'), runner, herdrBin = 'herdr', claudeSessionsDir, pause, now = () => Date.now(), env } = {}) {
  const queue = path.join(folder, 'q');
  const sealed = exists(path.join(folder, 'k', 'params.json'));
  const entries = listing(queue, new RegExp('^' + ID + (sealed ? '\\.json\\.enc$' : '\\.json$')));
  const result = { sent: 0, refused: 0, interrupted: 0, expired: 0 };
  if (!entries.length) { prune(folder, sealed, now()); return result; }
  let key = null;
  if (sealed) {
    if (!passphrase) throw new Error('Set HOSTED_READER_PASSPHRASE: the sealed bucket has requests waiting.');
    try { key = await seal.unlock(passphrase, JSON.parse(fs.readFileSync(path.join(folder, 'k', 'params.json'), 'utf8'))); } catch { key = null; }
    if (!key) return { ...result, error: 'wrong-passphrase' };
  }
  const lock = path.join(queue, '.drain.lock');
  try {
    if (now() - mtimeMs(lock) > LOCK_STALE_MS && exists(lock)) fs.unlinkSync(lock);
    fs.closeSync(fs.openSync(lock, 'wx', 0o600));
  } catch { return { ...result, error: 'busy' }; }
  try {
    const ids = await listedIds(folder, key);
    const api = create({ root, port: 1, token: crypto.randomBytes(32).toString('hex'), ...(runner ? { runner } : {}), herdrBin, ...(env ? { env } : {}),
      ...(claudeSessionsDir ? { claudeSessionsDir } : {}), ...(pause ? { pause } : {}), outDir: path.join(folder, '.unused'), sendable: () => ids });
    const receiptPath = (id) => path.join(folder, 'r', id + (sealed ? '.json.enc' : '.json'));
    const write = async (receipt) => {
      const rel = `r/${receipt.id}.json`;
      const text = Buffer.from(JSON.stringify(receipt), 'utf8');
      replace(receiptPath(receipt.id), sealed ? await seal.close(key, rel, zlib.gzipSync(text)) : text);
    };
    const readReceipt = async (id) => {
      try {
        const bytes = fs.readFileSync(receiptPath(id));
        return JSON.parse(sealed ? zlib.gunzipSync(Buffer.from(await seal.open(key, `r/${id}.json`, bytes))).toString('utf8') : bytes.toString('utf8'));
      } catch { return null; }
    };
    for (const name of entries.sort((a, b) => mtimeMs(path.join(queue, a)) - mtimeMs(path.join(queue, b)))) {
      const file = path.join(queue, name);
      const id = name.slice(0, 36);
      const waited = now() - mtimeMs(file);
      const done = async (state, fields) => {
        await write({ id, session_id: null, ...fields, state, at: Math.floor(now() / 1000) });
        fs.unlinkSync(file);
        result[state] += 1;
      };
      const before = exists(receiptPath(id)) ? await readReceipt(id) : null;
      if (before) {
        // A receipt exists: this request was handled, or stopped midway. It is never sent again.
        if (before.state === 'sending') { result.interrupted += 1; await write({ ...before, state: 'refused', code: 'interrupted', reason: 'The laptop stopped while sending this. It may or may not have reached the pane: check it before sending again.', at: Math.floor(now() / 1000) }); }
        fs.unlinkSync(file);
        continue;
      }
      let request = null;
      try {
        const bytes = fs.readFileSync(file);
        request = JSON.parse(sealed ? zlib.gunzipSync(Buffer.from(await seal.open(key, `q/${id}.json`, bytes))).toString('utf8') : bytes.toString('utf8'));
        if (!request || request.id !== id || typeof request.session_id !== 'string' || !SESSION_ID_RE.test(request.session_id) || !Number.isFinite(request.at)) throw new Error('shape');
        request.text = checkText(request.text);
      } catch { request = null; }
      if (!request) { await done('refused', { code: 'invalid', reason: 'The request could not be read, so nothing was sent.' }); continue; }
      const fields = { session_id: request.session_id, queued_at: request.at };
      if (waited > TTL_MS) { result.expired += 1; await done('refused', { ...fields, code: 'expired', reason: 'This waited more than 12 hours for the laptop, so it was not sent. Send it again if it still matters.' }); continue; }
      await write({ id, ...fields, state: 'sending', at: Math.floor(now() / 1000) });
      try {
        const sent = await api.sendPrompt({ session_id: request.session_id, text: request.text });
        await done('sent', { ...fields, label: sent.label });
      } catch (error) {
        const known = error && typeof error.code === 'string' && typeof error.status === 'number';
        await done('refused', { ...fields, code: known ? error.code : 'failed', reason: known ? error.message : 'The laptop could not send it.' });
      }
    }
    prune(folder, sealed, now());
    return result;
  } finally { try { fs.unlinkSync(lock); } catch { /* gone already */ } }
}

// Receipts the page has had a week to read.
function prune(folder, sealed, at) {
  const directory = path.join(folder, 'r');
  for (const name of listing(directory, new RegExp('^' + ID + (sealed ? '\\.json\\.enc$' : '\\.json$')))) {
    if (at - mtimeMs(path.join(directory, name)) > RECEIPT_KEEP_MS) { try { fs.unlinkSync(path.join(directory, name)); } catch { /* gone already */ } }
  }
}

function summary(result) {
  if (result.error === 'wrong-passphrase') return 'Drain: that passphrase does not open this bucket; its waiting requests were left.';
  if (result.error === 'busy') return 'Drain: another drain is running on this folder.';
  const total = result.sent + result.refused + result.interrupted;
  return total ? `Drain: ${result.sent} sent, ${result.refused + result.interrupted} refused (${result.expired} expired)` : 'Drain: nothing queued';
}

if (require.main === module) {
  const [folder] = process.argv.slice(2);
  if (!folder) { process.stderr.write('usage: drain.js <folder>\n'); process.exit(2); }
  drain({ folder: path.resolve(folder), passphrase: process.env.HOSTED_READER_PASSPHRASE || '', herdrBin: process.env.HOSTED_READER_HERDR || 'herdr' })
    .then((result) => { process.stdout.write(summary(result) + '\n'); process.exitCode = result.error ? 1 : 0; },
      (error) => { process.stderr.write(error.message + '\n'); process.exit(1); });
}

module.exports = { drain, summary, TTL_MS, RECEIPT_KEEP_MS };
