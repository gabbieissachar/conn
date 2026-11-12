'use strict';

// The reader's pinned messages, kept in one small file on this laptop, outside the repo, so a
// pin survives a rebuilt page, a new worktree of the repo and a restarted server. The file
// holds which message was pinned (its turn's id from the session log, never the message text), plus the owner's short description:
//
//   { "version": 1, "rev": 7, "pins": [{ "key": "<turn id>:in|reply", "conv": "<conversation id>", "at": <message time>, "pinned": <epoch>, "description": "<owner's short label>" }] }
//
// Like everything this reader writes it is the owner's alone (folder 0700, file 0600). It is
// read and written only through api.js's pins route, behind the same guard as Send.
//
// Newest pin first: a pin added goes to the top, and the file is always written in that order. A file from before (oldest first) is read in that order
// too, and put in it by normalize() when the server starts.
//
// PMOS_READER_PINS names another file; the default is ~/.config/pmos-transcript-reader/pins.json.
//
// The starred sessions of the session picker are kept the same way, by the same code, in a file beside it:
//
//   { "version": 1, "rev": 3, "stars": [{ "conv": "<conversation id>", "starred": <epoch> }] }
// newest star first: a star added goes to the top, and the file is always written in that order (Conn's Starred row reads it as it stands).
// A file from before is read in that order too, and put in it by normalize() when the server starts.
//
// PMOS_READER_STARS names another file; the default is ~/.config/pmos-transcript-reader/stars.json.
//
// The replies the owner marked from the page as "this should be an answer sheet" (kind "missing") or "this sheet is wrong" (kind
// "wrong") are kept the same way, in a third file, by turn id and never with the reply's text; reader.py sheet-flags reads it to
// show the flagged replies and their shape for a parser fixture:
//
//   { "version": 1, "rev": 2, "flags": [{ "key": "<turn id>:reply", "conv": "<conversation id>", "at": <reply time>, "kind": "missing|wrong", "flagged": <epoch> }] }
//
// PMOS_READER_SHEET_FLAGS names another file; the default is ~/.config/pmos-transcript-reader/sheet-flags.json.
//
// The messages and replies the owner hid from the reader's view (a fourth file, same code, same shape of key as a pin: "<turn id>:in" is the
// message, "<turn id>:reply" its reply). A hide only changes what the reader draws: the agent's session log is never touched, and no text of a
// message is kept here. Kept on the server so the laptop and the phone agree:
//
//   { "version": 1, "rev": 4, "hidden": [{ "key": "<turn id>:in|reply", "conv": "<conversation id>", "at": <message time>, "hidden": <epoch> }] }
//
// PMOS_READER_HIDDEN names another file; the default is ~/.config/pmos-transcript-reader/hidden.json.

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
const MAX_FLAGS = 500;
const MAX_HIDDEN = 5000;
const MAX_DESCRIPTION = 80;

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

function defaultSheetFlagsFile(env = process.env) {
  return env.PMOS_READER_SHEET_FLAGS || path.join(os.homedir(), '.config', FOLDER, 'sheet-flags.json');
}

function defaultHiddenFile(env = process.env) {
  return env.PMOS_READER_HIDDEN || path.join(os.homedir(), '.config', FOLDER, 'hidden.json');
}

// What a list of kept things is: the file's list name, its add and remove operations, the field that names an
// item, the fields an add carries, how each is checked and made, and the most it holds.
const PINS = {
  list: 'pins', add: 'pin', remove: 'unpin', edit: 'describe', id: 'key', addFields: ['key', 'conv', 'at', 'description'], editFields: ['key', 'description'], max: MAX_PINS,
  tooMany: 'Too many pins: unpin some first.',
  checkId: (body) => { if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) throw new PinError('Invalid message id.'); },
  checkAdd: (body) => {
    if (typeof body.conv !== 'string' || !CONV_RE.test(body.conv)) throw new PinError('Invalid conversation id.');
    if (!Number.isFinite(body.at)) throw new PinError('Invalid time.');
    checkDescription(body);
  },
  checkEdit: (body) => { if (typeof body.description !== 'string') throw new PinError('Description must be one line and at most 80 characters.'); checkDescription(body); },
  make: (body, epoch) => ({ key: body.key, conv: body.conv, at: body.at, pinned: epoch, ...descriptionField(body.description) }),
  valid: (pin) => Boolean(pin) && typeof pin === 'object' && KEY_RE.test(pin.key) && CONV_RE.test(pin.conv)
    && Number.isFinite(pin.at) && Number.isFinite(pin.pinned) && validDescription(pin.description),
  order: (a, b) => b.pinned - a.pinned,  // newest pinned first; a stable sort, so pins of one moment keep the order they were in
};

function validDescription(description) {
  return description === undefined || (typeof description === 'string' && description.length <= MAX_DESCRIPTION && !/[\r\n]/.test(description));
}

function normalizedDescription(description) {
  if (description === undefined) return undefined;
  if (typeof description !== 'string') throw new PinError('Description must be one line and at most 80 characters.');
  const value = description.trim().replace(/\s+/g, ' ');
  if (value.length > MAX_DESCRIPTION || /[\r\n]/.test(description)) throw new PinError('Description must be one line and at most 80 characters.');
  return value;
}

function checkDescription(body) {
  normalizedDescription(body.description);
}

function descriptionField(description) {
  const value = normalizedDescription(description);
  return value ? { description: value } : {};
}

// A starred session is named by its conversation (the same conv a pin carries), never by a session id alone.
const STARS = {
  list: 'stars', add: 'star', remove: 'unstar', id: 'conv', addFields: ['conv'], max: MAX_STARS,
  tooMany: 'Too many stars: unstar some first.',
  checkId: (body) => { if (typeof body.conv !== 'string' || !CONV_RE.test(body.conv)) throw new PinError('Invalid conversation id.'); },
  checkAdd: () => {},
  make: (body, epoch) => ({ conv: body.conv, starred: epoch }),
  valid: (star) => Boolean(star) && typeof star === 'object' && CONV_RE.test(star.conv) && Number.isFinite(star.starred),
  order: (a, b) => b.starred - a.starred,  // newest first; a stable sort, so stars of one moment keep the order they were in
};

// A reply marked from the page: its turn id (the pin's key, for the reply), the conversation, when the reply was written and which way it
// went wrong. No text of the reply is kept.
const SHEET_FLAGS = {
  list: 'flags', add: 'flag', remove: 'unflag', id: 'key', addFields: ['key', 'conv', 'at', 'kind'], max: MAX_FLAGS,
  tooMany: 'Too many marked replies: clear some first.',
  checkId: (body) => { if (typeof body.key !== 'string' || !KEY_RE.test(body.key) || !body.key.endsWith(':reply')) throw new PinError('Invalid message id.'); },
  checkAdd: (body) => {
    if (typeof body.conv !== 'string' || !CONV_RE.test(body.conv)) throw new PinError('Invalid conversation id.');
    if (!Number.isFinite(body.at)) throw new PinError('Invalid time.');
    if (body.kind !== 'missing' && body.kind !== 'wrong') throw new PinError('Invalid mark.');
  },
  make: (body, epoch) => ({ key: body.key, conv: body.conv, at: body.at, kind: body.kind, flagged: epoch }),
  valid: (flag) => Boolean(flag) && typeof flag === 'object' && KEY_RE.test(flag.key) && CONV_RE.test(flag.conv)
    && Number.isFinite(flag.at) && (flag.kind === 'missing' || flag.kind === 'wrong') && Number.isFinite(flag.flagged),
};

// A message or reply hidden from the reader's view: its turn id and part (the pin's key), the conversation and when the message was written.
const HIDDEN = {
  list: 'hidden', add: 'hide', remove: 'unhide', id: 'key', addFields: ['key', 'conv', 'at'], max: MAX_HIDDEN,
  tooMany: 'Too many hidden messages: show some again first.',
  checkId: (body) => { if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) throw new PinError('Invalid message id.'); },
  checkAdd: (body) => {
    if (typeof body.conv !== 'string' || !CONV_RE.test(body.conv)) throw new PinError('Invalid conversation id.');
    if (!Number.isFinite(body.at)) throw new PinError('Invalid time.');
  },
  make: (body, epoch) => ({ key: body.key, conv: body.conv, at: body.at, hidden: epoch }),
  valid: (item) => Boolean(item) && typeof item === 'object' && KEY_RE.test(item.key) && CONV_RE.test(item.conv)
    && Number.isFinite(item.at) && Number.isFinite(item.hidden),
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
      if (kind.order) items.sort(kind.order);
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

  // One change: { op: <add>, ...fields } adds an item (again is a no-op), { op: <edit>, <id>, ...fields } changes its owner label,
  // and { op: <remove>, <id> } takes it off.
  // Answers every item after the change.
  function change(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PinError('Invalid request.');
    const allowed = body.op === kind.add ? ['op', ...kind.addFields] : kind.edit && body.op === kind.edit ? ['op', ...(kind.editFields || [kind.id])] : ['op', kind.id];
    for (const name of Object.keys(body)) if (!allowed.includes(name)) throw new PinError('Unknown field.');
    if (body.op !== kind.add && body.op !== kind.remove && (!kind.edit || body.op !== kind.edit)) throw new PinError('Unknown operation.');
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
    if (kind.edit && body.op === kind.edit) {
      if (kind.checkEdit) kind.checkEdit(body);
      if (!has) return view(state);
      const description = normalizedDescription(body.description);
      const current = items.find((item) => item[kind.id] === body[kind.id]);
      if ((current.description || '') === description) return view(state);
      const changed = items.map((item) => {
        if (item[kind.id] !== body[kind.id]) return item;
        const next = { ...item };
        if (description) next.description = description;
        else delete next.description;
        return next;
      });
      save(state.rev + 1, changed, state.unreadable);
      return { rev: state.rev + 1, [kind.list]: changed };
    }
    kind.checkAdd(body);
    if (has) return view(state);
    if (items.length >= kind.max) throw new PinError(kind.tooMany, 409, 'too_many');
    const more = [...items, kind.make(body, now() / 1000)];
    if (kind.order) more.sort(kind.order);
    save(state.rev + 1, more, state.unreadable);
    return { rev: state.rev + 1, [kind.list]: more };
  }

  // Put a file written before the list had an order in it (a stars file from before: oldest first) in order, once. The revision moves, so a page that
  // holds the old list takes the new one. Nothing is written when the file is as it should be, or cannot be read as this list.
  function normalize() {
    if (!kind.order) return false;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
    let saved;
    try { saved = JSON.parse(text); } catch { return false; }
    if (!saved || !Array.isArray(saved[kind.list]) || !Number.isInteger(saved.rev)) return false;
    const kept = saved[kind.list].filter(kind.valid);
    const sorted = kept.slice().sort(kind.order);
    if (sorted.every((item, n) => item === kept[n])) return false;
    save(saved.rev + 1, sorted, false);
    return true;
  }

  return { read, change, file, normalize };
}

const create = (options = {}) => createList(PINS, { file: defaultFile(), ...options });
const createStars = (options = {}) => createList(STARS, { file: defaultStarsFile(), ...options });
const createSheetFlags = (options = {}) => createList(SHEET_FLAGS, { file: defaultSheetFlagsFile(), ...options });
const createHidden = (options = {}) => createList(HIDDEN, { file: defaultHiddenFile(), ...options });

module.exports = { create, createStars, createSheetFlags, createHidden, defaultFile, defaultStarsFile, defaultSheetFlagsFile, defaultHiddenFile, PinError, KEY_RE, CONV_RE, MAX_PINS, MAX_STARS, MAX_FLAGS, MAX_HIDDEN, MAX_DESCRIPTION };
