'use strict';

// The reader's pinned messages, kept in one small file on this laptop, outside the repo, so a
// pin survives a rebuilt page, a new worktree of the repo and a restarted server. The file
// holds only which message was pinned (its turn's id from the session log, never any text):
//
//   { "version": 1, "rev": 7, "pins": [{ "key": "<turn id>:in|reply", "conv": "<conversation id>", "at": <message time>, "pinned": <epoch> }] }
//
// Like everything this reader writes it is the owner's alone (folder 0700, file 0600). It is
// read and written only through api.js's pins route, behind the same guard as Send.
//
// PMOS_READER_PINS names another file; the default is ~/.config/pmos-transcript-reader/pins.json.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FOLDER = 'pmos-transcript-reader';
// A turn's id (the session log's own record id, which never changes) and which part of it: the message or its reply.
const KEY_RE = /^[0-9A-Za-z_-]{8,80}:(?:in|reply)$/;
// A conversation is named by its newest session's id (the hosted copy's object names fit too).
const CONV_RE = /^[0-9A-Za-z_-]{1,64}$/;
const MAX_PINS = 1000;

class PinError extends Error {
  constructor(message, status = 400, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function defaultFile(env = process.env) {
  return env.PMOS_READER_PINS || path.join(os.homedir(), '.config', FOLDER, 'pins.json');
}

function create({ file = defaultFile(), now = () => Date.now() } = {}) {
  const folder = path.dirname(file);

  // The pins as saved. A file that cannot be read as pins counts as empty, and is moved aside (never deleted)
  // before the next write, so a hand edit gone wrong costs nothing.
  function load() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return { rev: 0, pins: [], unreadable: false };
      return { rev: 0, pins: [], unreadable: true };
    }
    try {
      const saved = JSON.parse(text);
      const pins = Array.isArray(saved.pins) ? saved.pins.filter(valid) : null;
      if (!pins || !Number.isInteger(saved.rev)) throw new Error('not pins');
      return { rev: saved.rev, pins, unreadable: false };
    } catch { return { rev: 0, pins: [], unreadable: true }; }
  }

  const valid = (pin) => Boolean(pin) && typeof pin === 'object' && KEY_RE.test(pin.key) && CONV_RE.test(pin.conv)
    && Number.isFinite(pin.at) && Number.isFinite(pin.pinned);

  function save(rev, pins, unreadable) {
    // The folder is this reader's own: made owner-only, and narrowed again if an earlier run left it wider.
    const made = fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (made || path.basename(folder) === FOLDER) fs.chmodSync(folder, 0o700);
    if (unreadable) {
      try { fs.renameSync(file, file + '.unreadable'); } catch { /* it went away: nothing to keep */ }
    }
    const partial = `${file}.${process.pid}.partial`;
    fs.writeFileSync(partial, JSON.stringify({ version: 1, rev, pins }, null, 1) + '\n', { mode: 0o600, flag: 'w' });
    fs.chmodSync(partial, 0o600);
    fs.renameSync(partial, file);  // whole or not at all
  }

  const view = ({ rev, pins }) => ({ rev, pins });

  function read() { return view(load()); }

  // One change: { op: "pin", key, conv, at } adds a pin (again is a no-op) and { op: "unpin", key } takes it off.
  // Answers every pin after the change.
  function change(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PinError('Invalid request.');
    const allowed = body.op === 'pin' ? ['op', 'key', 'conv', 'at'] : ['op', 'key'];
    for (const name of Object.keys(body)) if (!allowed.includes(name)) throw new PinError('Unknown field.');
    if (body.op !== 'pin' && body.op !== 'unpin') throw new PinError('Unknown operation.');
    if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) throw new PinError('Invalid message id.');
    const state = load();
    const has = state.pins.some((pin) => pin.key === body.key);
    if (body.op === 'unpin') {
      if (!has) return view(state);
      const pins = state.pins.filter((pin) => pin.key !== body.key);
      save(state.rev + 1, pins, state.unreadable);
      return { rev: state.rev + 1, pins };
    }
    if (typeof body.conv !== 'string' || !CONV_RE.test(body.conv)) throw new PinError('Invalid conversation id.');
    if (!Number.isFinite(body.at)) throw new PinError('Invalid time.');
    if (has) return view(state);
    if (state.pins.length >= MAX_PINS) throw new PinError('Too many pins: unpin some first.', 409, 'too_many');
    const pins = [...state.pins, { key: body.key, conv: body.conv, at: body.at, pinned: now() / 1000 }];
    save(state.rev + 1, pins, state.unreadable);
    return { rev: state.rev + 1, pins };
  }

  return { read, change, file };
}

module.exports = { create, defaultFile, PinError, KEY_RE, CONV_RE, MAX_PINS };
