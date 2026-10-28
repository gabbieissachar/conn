'use strict';

// Tests for the pins file (pinstore.js). Run from the repo root:
//   node --test setup/transcript-reader/pinstore.test.js
// Every file is made inside a fresh temporary folder, never the owner's real pins file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create, createStars, defaultFile, defaultStarsFile, PinError, MAX_PINS, MAX_STARS } = require('./pinstore');

const K1 = 'abcdef12-3456-4789-8abc-def012345678:in';
const K2 = 'abcdef12-3456-4789-8abc-def012345678:reply';
const CONV = 'cccccccc-3333-4333-8333-333333333333';
const mode = (file) => fs.statSync(file).mode & 0o777;
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pinstore-'));

test('the default file is outside the repo, in the owner\'s config folder, and one variable moves it', () => {
  assert.equal(defaultFile({}), path.join(os.homedir(), '.config', 'pmos-transcript-reader', 'pins.json'));
  assert.equal(defaultFile({ PMOS_READER_PINS: '/somewhere/else.json' }), '/somewhere/else.json');
});

test('no file reads as no pins; a pin is kept with its conversation, message time and pin time, and nothing else', () => {
  const folder = fresh();
  const file = path.join(folder, 'pmos-transcript-reader', 'pins.json');
  const store = create({ file, now: () => 5_000_000 });
  assert.deepEqual(store.read(), { rev: 0, pins: [] });
  assert.deepEqual(store.change({ op: 'pin', key: K1, conv: CONV, at: 1700000000 }), { rev: 1, pins: [{ key: K1, conv: CONV, at: 1700000000, pinned: 5000 }] });
  // A second store on the same file (a restarted server) sees the same pins.
  assert.deepEqual(create({ file }).read().pins.map((pin) => pin.key), [K1]);
  assert.deepEqual(store.change({ op: 'pin', key: K2, conv: CONV, at: 1700000100 }).pins.map((pin) => pin.key), [K1, K2]);
});

test('the file is 0600 in a 0700 folder, also when an earlier run left the folder wider', () => {
  const folder = fresh();
  const own = path.join(folder, 'pmos-transcript-reader');
  fs.mkdirSync(own, { mode: 0o755 });
  fs.chmodSync(own, 0o755);
  const file = path.join(own, 'pins.json');
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  const store = create({ file });
  store.change({ op: 'pin', key: K1, conv: CONV, at: 1 });
  assert.equal(mode(file), 0o600, 'a file left readable by others is replaced by an owner-only one');
  assert.equal(mode(own), 0o700);
  // A folder that is not this reader's own (PMOS_READER_PINS pointing into a shared place) is not narrowed.
  const shared = path.join(folder, 'shared');
  fs.mkdirSync(shared, { mode: 0o755 });
  fs.chmodSync(shared, 0o755);
  create({ file: path.join(shared, 'pins.json') }).change({ op: 'pin', key: K1, conv: CONV, at: 1 });
  assert.equal(mode(shared), 0o755);
  assert.equal(mode(path.join(shared, 'pins.json')), 0o600);
  // A folder made on the way is owner-only, however deep.
  const deep = path.join(folder, 'a', 'b', 'pins.json');
  create({ file: deep }).change({ op: 'pin', key: K1, conv: CONV, at: 1 });
  assert.equal(mode(path.dirname(deep)), 0o700);
});

test('pinning again changes nothing, and unpinning what is not pinned changes nothing', () => {
  const store = create({ file: path.join(fresh(), 'pins.json') });
  store.change({ op: 'pin', key: K1, conv: CONV, at: 1 });
  assert.equal(store.change({ op: 'pin', key: K1, conv: CONV, at: 2 }).rev, 1);
  assert.equal(store.change({ op: 'unpin', key: K2 }).rev, 1);
  assert.deepEqual(store.change({ op: 'unpin', key: K1 }), { rev: 2, pins: [] });
});

test('bad input is refused with a reason and writes nothing', () => {
  const file = path.join(fresh(), 'pins.json');
  const store = create({ file });
  const bad = [
    null, [], 'pin', {}, { op: 'pin' }, { op: 'pin', key: K1 }, { op: 'pin', key: K1, conv: CONV }, { op: 'pin', key: K1, conv: CONV, at: NaN },
    { op: 'pin', key: K1, conv: CONV, at: 1, text: 'hello' }, { op: 'unpin', key: K1, at: 1 }, { op: 'pin', key: 'x:in', conv: CONV, at: 1 },
    { op: 'pin', key: K1, conv: 'a/b', at: 1 }, { op: 'pin', key: K1 + '!', conv: CONV, at: 1 }, { op: 'swap', key: K1 },
  ];
  for (const body of bad) assert.throws(() => store.change(body), PinError, JSON.stringify(body));
  assert.equal(fs.existsSync(file), false);
});

test('a file that is not pins counts as empty, and is moved aside before the next write, never lost', () => {
  const folder = fresh();
  const file = path.join(folder, 'pins.json');
  fs.writeFileSync(file, '{ not json');
  const store = create({ file });
  assert.deepEqual(store.read(), { rev: 0, pins: [] });
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'reading never changes it');
  store.change({ op: 'pin', key: K1, conv: CONV, at: 1 });
  assert.equal(fs.readFileSync(file + '.unreadable', 'utf8'), '{ not json');
  assert.deepEqual(create({ file }).read().pins.map((pin) => pin.key), [K1]);
});

test('entries that are not pins are dropped on reading, and the number of pins is capped', () => {
  const file = path.join(fresh(), 'pins.json');
  const good = { key: K1, conv: CONV, at: 1, pinned: 2 };
  fs.writeFileSync(file, JSON.stringify({ version: 1, rev: 3, pins: [good, { key: 'bad' }, null, { ...good, key: K2, at: 'x' }] }));
  const store = create({ file });
  assert.deepEqual(store.read(), { rev: 3, pins: [good] });
  const many = Array.from({ length: MAX_PINS }, (_, i) => ({ key: `abcdef12-3456-4789-8abc-${String(i).padStart(12, '0')}:in`, conv: CONV, at: i, pinned: i }));
  fs.writeFileSync(file, JSON.stringify({ version: 1, rev: 9, pins: many }));
  assert.throws(() => store.change({ op: 'pin', key: K2, conv: CONV, at: 1 }), (error) => error.status === 409 && error.code === 'too_many');
  assert.equal(store.change({ op: 'unpin', key: many[0].key }).pins.length, MAX_PINS - 1, 'unpinning is always possible');
});

test('stars: the same store in a file beside the pins, holding a conversation and when it was starred, nothing else', () => {
  assert.equal(defaultStarsFile({}), path.join(os.homedir(), '.config', 'pmos-transcript-reader', 'stars.json'));
  assert.equal(defaultStarsFile({ PMOS_READER_STARS: '/somewhere/else.json' }), '/somewhere/else.json');
  const folder = fresh();
  const own = path.join(folder, 'pmos-transcript-reader');
  fs.mkdirSync(own, { mode: 0o755 });
  fs.chmodSync(own, 0o755);
  const file = path.join(own, 'stars.json');
  const store = createStars({ file, now: () => 5_000_000 });
  assert.deepEqual(store.read(), { rev: 0, stars: [] });
  assert.deepEqual(store.change({ op: 'star', conv: CONV }), { rev: 1, stars: [{ conv: CONV, starred: 5000 }] });
  assert.deepEqual(store.change({ op: 'star', conv: CONV }), { rev: 1, stars: [{ conv: CONV, starred: 5000 }] }, 'starring again changes nothing');
  assert.deepEqual(createStars({ file }).read().stars.map((star) => star.conv), [CONV], 'a restarted server sees it');
  assert.equal(mode(file), 0o600);
  assert.equal(mode(own), 0o700);
  assert.deepEqual(store.change({ op: 'unstar', conv: 'dddddddd-4444-4444-8444-444444444444' }), { rev: 1, stars: [{ conv: CONV, starred: 5000 }] });
  assert.deepEqual(store.change({ op: 'unstar', conv: CONV }), { rev: 2, stars: [] });
  assert.equal(fs.existsSync(path.join(own, 'pins.json')), false, 'the pins file is not touched');
});

test('stars: bad input is refused and writes nothing; the cap holds; a file that is not stars is moved aside, never lost', () => {
  const folder = fresh();
  const file = path.join(folder, 'pmos-transcript-reader', 'stars.json');
  const store = createStars({ file });
  for (const body of [null, [], {}, { op: 'star' }, { op: 'star', conv: '../x' }, { op: 'star', conv: CONV, at: 1 }, { op: 'unstar', conv: CONV, starred: 1 }, { op: 'pin', conv: CONV }, { op: 'star', key: K1 }]) {
    assert.throws(() => store.change(body), PinError, JSON.stringify(body));
  }
  assert.equal(fs.existsSync(file), false);
  for (let i = 0; i < MAX_STARS; i += 1) store.change({ op: 'star', conv: `conv-${i}` });
  assert.throws(() => store.change({ op: 'star', conv: 'one-more' }), (e) => e instanceof PinError && e.status === 409 && e.code === 'too_many');
  assert.equal(store.change({ op: 'unstar', conv: 'conv-0' }).stars.length, MAX_STARS - 1, 'unstarring makes room');
  // Pins in the stars file (a mix-up) read as no stars and are kept aside.
  const other = path.join(folder, 'pmos-transcript-reader', 'mixed.json');
  fs.writeFileSync(other, JSON.stringify({ version: 1, rev: 3, pins: [] }));
  const mixed = createStars({ file: other });
  assert.deepEqual(mixed.read(), { rev: 0, stars: [] });
  mixed.change({ op: 'star', conv: CONV });
  assert.equal(JSON.parse(fs.readFileSync(other + '.unreadable', 'utf8')).rev, 3);
});
