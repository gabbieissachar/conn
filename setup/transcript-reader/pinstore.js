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
//
// The starred sessions of the session picker are kept the same way, by the same code, in a file beside it:
//
//   { "version": 1, "rev": 3, "stars": [{ "conv": "<conversation id>", "starred": <epoch> }] }
//
// PMOS_READER_STARS names another file; the default is ~/.config/pmos-transcript-reader/stars.json.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FOLDER = 'pmos-transcript-reader';
// A turn's id (the session log's own record id, which never changes) and which part of it: the message or its reply.
const KEY_RE = /^[0-9A-Za-z_-]{8,80}:(?:in|reply)$/;
// A conversation is named by its newest session's id (the hosted copy's object names fit too).
const CONV_RE = /^[0-9A-Za-z_-]{1,64}$/;
const MAX_PINS = 1000;
const MAX_STARS = 200;

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

function defaultStarsFile(env = process.env) {
  return env.PMOS_READER_STARS || path.join(os.homedir(), '.config', FOLDER, 'stars.json');
}

// What a list of kept things is: the file's list name, its add and remove operations, the field that names an
// item, the fields an add carries, how each is checked and made, and the most it holds.
const PINS = {
  list: 'pins', add: 'pin', remove: 'unpin', id: 'key', addFields: ['key', 'conv', 'at'], max: MAX_PINS,
  tooMany: 'Too many pins: unpin some first.',
  checkId: (body) => { if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) throw new PinError('Invalid message id.'); },
  checkAdd: (body) => {
    if (typeof body.conv !== 'string' || !CONV_RE.test(body.conv)) throw new PinError('Invalid conversation id.');
    if (!Number.isFinite(body.at)) throw new PinError('Invalid time.');
  },
  make: (body, epoch) => ({ key: body.key, conv: body.conv, at: body.at, pinned: epoch }),
  valid: (pin) => Boolean(pin) && typeof pin === 'object' && KEY_RE.test(pin.key) && CONV_RE.test(pin.conv)
    && Number.isFinite(pin.at) && Number.isFinite(pin.pinned),
};

// A starred session is named by its conversation (the same conv a pin carries), never by a session id alone.
const STARS = {
  list: 'stars', add: 'star', remove: 'unstar', id: 'conv', addFields: ['conv'], max: MAX_STARS,
  tooMany: 'Too many stars: unstar some first.',
  checkId: (body) => { if (typeof body.conv !== 'string' || !CONV_RE.test(body.conv)) throw new PinError('Invalid conversation id.'); },
  checkAdd: () => {},
  make: (body, epoch) => ({ conv: body.conv, starred: epoch }),
  valid: (star) => Boolean(star) && typeof star === 'object' && CONV_RE.test(star.conv) && Number.isFinite(star.starred),
};

function createList(kind, { file, now = () => Date.now() }) {
  const folder = path.dirname(file);
  const empty = { rev: 0, [kind.list]: [], unreadable: false };

  // The items as saved. A file that cannot be read as that list counts as empty, and is moved aside (never deleted)
  // before the next write, so a hand edit gone wrong costs nothing.
  function load() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return { ...empty };
      return { ...empty, unreadable: true };
    }
    try {
      const saved = JSON.parse(text);
      const items = Array.isArray(saved[kind.list]) ? saved[kind.list].filter(kind.valid) : null;
      if (!items || !Number.isInteger(saved.rev)) throw new Error('not ' + kind.list);
      return { rev: saved.rev, [kind.list]: items, unreadable: false };
    } catch { return { ...empty, unreadable: true }; }
  }

  function save(rev, items, unreadable) {
    // The folder is this reader's own: made owner-only, and narrowed again if an earlier run left it wider.
    const made = fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (made || path.basename(folder) === FOLDER) fs.chmodSync(folder, 0o700);
    if (unreadable) {
      try { fs.renameSync(file, file + '.unreadable'); } catch { /* it went away: nothing to keep */ }
    }
    const partial = `${file}.${process.pid}.partial`;
    fs.writeFileSync(partial, JSON.stringify({ version: 1, rev, [kind.list]: items }, null, 1) + '\n', { mode: 0o600, flag: 'w' });
    fs.chmodSync(partial, 0o600);
    fs.renameSync(partial, file);  // whole or not at all
  }

  const view = (state) => ({ rev: state.rev, [kind.list]: state[kind.list] });

  function read() { return view(load()); }

  // One change: { op: <add>, ...fields } adds an item (again is a no-op) and { op: <remove>, <id> } takes it off.
  // Answers every item after the change.
  function change(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PinError('Invalid request.');
    const allowed = body.op === kind.add ? ['op', ...kind.addFields] : ['op', kind.id];
    for (const name of Object.keys(body)) if (!allowed.includes(name)) throw new PinError('Unknown field.');
    if (body.op !== kind.add && body.op !== kind.remove) throw new PinError('Unknown operation.');
    kind.checkId(body);
    const state = load();
    const items = state[kind.list];
    const has = items.some((item) => item[kind.id] === body[kind.id]);
    if (body.op === kind.remove) {
      if (!has) return view(state);
      const rest = items.filter((item) => item[kind.id] !== body[kind.id]);
      save(state.rev + 1, rest, state.unreadable);
      return { rev: state.rev + 1, [kind.list]: rest };
    }
    kind.checkAdd(body);
    if (has) return view(state);
    if (items.length >= kind.max) throw new PinError(kind.tooMany, 409, 'too_many');
    const more = [...items, kind.make(body, now() / 1000)];
    save(state.rev + 1, more, state.unreadable);
    return { rev: state.rev + 1, [kind.list]: more };
  }

  return { read, change, file };
}

const create = (options = {}) => createList(PINS, { file: defaultFile(), ...options });
const createStars = (options = {}) => createList(STARS, { file: defaultStarsFile(), ...options });

module.exports = { create, createStars, defaultFile, defaultStarsFile, PinError, KEY_RE, CONV_RE, MAX_PINS, MAX_STARS };
