'use strict';

// Tests for the pins file (pinstore.js). Run from the repo root:
//   node --test setup/transcript-reader/pinstore.test.js
// Every file is made inside a fresh temporary folder, never the owner's real pins file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create, createStars, createSheetFlags, createHidden, defaultFile, defaultStarsFile, defaultSheetFlagsFile, defaultHiddenFile, PinError, MAX_PINS, MAX_STARS, MAX_FLAGS, MAX_HIDDEN, MAX_DESCRIPTION } = require('./pinstore');

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

test('a pin can carry and later edit the owner short description, while clearing it keeps old pin shape', () => {
  const folder = fresh();
  const file = path.join(folder, 'pins.json');
  const store = create({ file, now: () => 5_000_000 });
  const added = store.change({ op: 'pin', key: K1, conv: CONV, at: 1, description: '  The handoff  ' });
  assert.equal(added.pins[0].description, 'The handoff');
  const edited = store.change({ op: 'describe', key: K1, description: 'Updated handoff' });
  assert.equal(edited.pins[0].description, 'Updated handoff');
  const cleared = store.change({ op: 'describe', key: K1, description: '' });
  assert.deepEqual(cleared.pins[0], { key: K1, conv: CONV, at: 1, pinned: 5000 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pins[0].description, undefined);
  assert.equal(MAX_DESCRIPTION, 80);
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
    { op: 'pin', key: K1, conv: CONV, at: 1, text: 'hello' }, { op: 'pin', key: K1, conv: CONV, at: 1, description: 'x'.repeat(MAX_DESCRIPTION + 1) },
    { op: 'pin', key: K1, conv: CONV, at: 1, description: 'one\ntwo' }, { op: 'describe', key: K1 }, { op: 'describe', key: K1, description: 'one\ntwo' },
    { op: 'unpin', key: K1, at: 1 }, { op: 'pin', key: 'x:in', conv: CONV, at: 1 },
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

test('sheet marks: a third file beside the pins, holding a turn id, its conversation, the reply time and the kind of mark, never any text', () => {
  assert.equal(defaultSheetFlagsFile({}), path.join(os.homedir(), '.config', 'pmos-transcript-reader', 'sheet-flags.json'));
  assert.equal(defaultSheetFlagsFile({ PMOS_READER_SHEET_FLAGS: '/somewhere/else.json' }), '/somewhere/else.json');
  const folder = fresh();
  const own = path.join(folder, 'pmos-transcript-reader');
  fs.mkdirSync(own, { mode: 0o755 });
  fs.chmodSync(own, 0o755);
  const file = path.join(own, 'sheet-flags.json');
  const store = createSheetFlags({ file, now: () => 5_000_000 });
  assert.deepEqual(store.read(), { rev: 0, flags: [] });
  const mark = { op: 'flag', key: K2, conv: CONV, at: 1700000000, kind: 'wrong' };
  assert.deepEqual(store.change(mark), { rev: 1, flags: [{ key: K2, conv: CONV, at: 1700000000, kind: 'wrong', flagged: 5000 }] });
  assert.deepEqual(store.change(mark).rev, 1, 'marking again changes nothing');
  assert.deepEqual(createSheetFlags({ file }).read().flags.map((flag) => flag.key), [K2], 'a restarted server sees it');
  assert.equal(mode(file), 0o600);
  assert.equal(mode(own), 0o700);
  assert.deepEqual(store.change({ op: 'unflag', key: 'zzzzzzzz-3456-4789-8abc-def012345678:reply' }).rev, 1);
  assert.deepEqual(store.change({ op: 'unflag', key: K2 }), { rev: 2, flags: [] });
  assert.equal(fs.existsSync(path.join(own, 'pins.json')) || fs.existsSync(path.join(own, 'stars.json')), false, 'the other files are not touched');
});

test('sheet marks: only a reply can be marked, with a known kind; bad input writes nothing; the cap holds', () => {
  const folder = fresh();
  const file = path.join(folder, 'pmos-transcript-reader', 'sheet-flags.json');
  const store = createSheetFlags({ file });
  const good = { op: 'flag', key: K2, conv: CONV, at: 1, kind: 'missing' };
  for (const body of [null, [], {}, { op: 'flag' }, { ...good, key: K1 }, { ...good, kind: 'other' }, { ...good, kind: undefined }, { ...good, conv: '../x' }, { ...good, at: 'now' }, { ...good, text: 'x' }, { op: 'pin', key: K2 }, { op: 'unflag', key: K1 }]) {
    assert.throws(() => store.change(body), PinError, JSON.stringify(body));
  }
  assert.equal(fs.existsSync(file), false);
  for (let i = 0; i < MAX_FLAGS; i += 1) store.change({ ...good, key: `abcdef12-3456-4789-8abc-${String(i).padStart(12, '0')}:reply` });
  assert.throws(() => store.change({ ...good, key: 'abcdef12-3456-4789-8abc-ffffffffffff:reply' }), (e) => e instanceof PinError && e.status === 409 && e.code === 'too_many');
});

test('hidden messages: a fourth file beside the pins, holding a turn id and part, its conversation and the message time, never any text', () => {
  assert.equal(defaultHiddenFile({}), path.join(os.homedir(), '.config', 'pmos-transcript-reader', 'hidden.json'));
  assert.equal(defaultHiddenFile({ PMOS_READER_HIDDEN: '/somewhere/else.json' }), '/somewhere/else.json');
  const folder = fresh();
  const file = path.join(folder, 'pmos-transcript-reader', 'hidden.json');
  const store = createHidden({ file, now: () => 6_000_000 });
  assert.deepEqual(store.read(), { rev: 0, hidden: [] });
  const hide = { op: 'hide', key: K2, conv: CONV, at: 1700000000 };
  assert.deepEqual(store.change(hide), { rev: 1, hidden: [{ key: K2, conv: CONV, at: 1700000000, hidden: 6000 }] });
  assert.equal(store.change(hide).rev, 1, 'hiding what is hidden changes nothing');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  for (const bad of [{ ...hide, key: 'x' }, { ...hide, conv: '../etc' }, { op: 'hide', key: K2, conv: CONV }, { ...hide, text: 'words' }, { op: 'pin', key: K2, conv: CONV, at: 1 }]) assert.throws(() => store.change(bad), PinError, JSON.stringify(bad));
  assert.deepEqual(store.change({ op: 'unhide', key: K2 }), { rev: 2, hidden: [] });
  assert.equal(MAX_HIDDEN, 5000);
  // A file that is not a hidden list is moved aside, never overwritten.
  const other = path.join(fresh(), 'hidden.json');
  fs.writeFileSync(other, '{"not":"mine"}');
  const mixed = createHidden({ file: other });
  assert.deepEqual(mixed.read(), { rev: 0, hidden: [] });
  mixed.change(hide);
  assert.equal(fs.readFileSync(other + '.unreadable', 'utf8'), '{"not":"mine"}');
});

// ---------------------------------------------------------------------------------------------------- stars: newest first (2026-11-08)

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';

test('stars: a star added goes to the top, and the file is written in that order, which is the order Conn\'s row reads', () => {
  const folder = fresh();
  const file = path.join(folder, 'stars.json');
  let clock = 1_000_000;
  const store = createStars({ file, now: () => clock });
  store.change({ op: 'star', conv: C1 });
  clock += 1000;
  store.change({ op: 'star', conv: C2 });
  clock += 1000;
  const after = store.change({ op: 'star', conv: C3 });
  assert.deepEqual(after.stars.map((star) => star.conv), [C3, C2, C1], 'the newest first');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).stars.map((star) => star.conv), [C3, C2, C1], 'and so in the file');
  // Unstarring and starring again puts it back at the top, not where it was.
  clock += 1000;
  store.change({ op: 'unstar', conv: C2 });
  clock += 1000;
  assert.deepEqual(store.change({ op: 'star', conv: C2 }).stars.map((star) => star.conv), [C2, C3, C1]);
});

// ---------------------------------------------------------------------------------------------------- pins: newest first (2026-11-12)

const K3 = 'abcdef12-3456-4789-8abc-def012345679:in';

test('pins: a pin added goes to the top, and the file is written in that order; a description, edit or unpin keeps the order', () => {
  const folder = fresh();
  const file = path.join(folder, 'pins.json');
  let clock = 1_000_000;
  const pins = create({ file, now: () => clock });
  pins.change({ op: 'pin', key: K1, conv: CONV, at: 1 });
  clock += 1000;
  pins.change({ op: 'pin', key: K2, conv: CONV, at: 2, description: 'Handoff' });
  clock += 1000;
  const after = pins.change({ op: 'pin', key: K3, conv: CONV, at: 3 });
  assert.deepEqual(after.pins.map((pin) => pin.key), [K3, K2, K1], 'the newest pinned first, whatever the messages\' own order');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pins.map((pin) => pin.key), [K3, K2, K1], 'and so in the file');
  assert.equal(after.pins[1].description, 'Handoff', 'the description stays on its pin');
  assert.deepEqual(pins.change({ op: 'describe', key: K1, description: 'Oldest' }).pins.map((pin) => pin.key), [K3, K2, K1]);
  assert.deepEqual(pins.change({ op: 'unpin', key: K2 }).pins.map((pin) => pin.key), [K3, K1]);
  // Unpinning and pinning again puts it back on top.
  clock += 1000;
  assert.deepEqual(pins.change({ op: 'pin', key: K2, conv: CONV, at: 2 }).pins.map((pin) => pin.key), [K2, K3, K1]);
});

test('pins: a file from before (oldest first) is read newest first, and normalize() puts it in that order once, keeping descriptions and moving the revision', () => {
  const folder = fresh();
  const file = path.join(folder, 'pins.json');
  const old = [
    { key: K1, conv: CONV, at: 1, pinned: 10, description: 'First' },
    { key: K2, conv: CONV, at: 2, pinned: 30 },
    { key: K3, conv: CONV, at: 3, pinned: 20, description: 'Third' },
  ];
  fs.writeFileSync(file, JSON.stringify({ version: 1, rev: 6, pins: old }));
  const store = create({ file });
  assert.deepEqual(store.read().pins.map((pin) => pin.key), [K2, K3, K1], 'read in order whatever the file holds');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pins[0].key, K1, 'the file is not touched by a read');
  assert.equal(store.normalize(), true);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.pins, [old[1], old[2], old[0]], 'the same pins, descriptions included, newest first');
  assert.equal(written.rev, 7, 'the revision moved, so a page holding the old list takes the new one');
  assert.equal(store.normalize(), false, 'once');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rev, 7);
  assert.equal(create({ file: path.join(folder, 'none.json') }).normalize(), false, 'no file, nothing written');
  fs.writeFileSync(path.join(folder, 'bad.json'), 'not json');
  assert.equal(create({ file: path.join(folder, 'bad.json') }).normalize(), false, 'a file that is not pins is left alone');
  assert.equal(fs.readFileSync(path.join(folder, 'bad.json'), 'utf8'), 'not json');
});

test('stars: a file from before (oldest first) is read newest first, and normalize() puts it in that order once, moving the revision', () => {
  const folder = fresh();
  const file = path.join(folder, 'stars.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, rev: 4, stars: [{ conv: C1, starred: 10 }, { conv: C2, starred: 30 }, { conv: C3, starred: 20 }] }));
  const store = createStars({ file });
  assert.deepEqual(store.read().stars.map((star) => star.conv), [C2, C3, C1], 'read in order whatever the file holds');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stars[0].conv, C1, 'the file is not touched by a read');
  assert.equal(store.normalize(), true);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.stars.map((star) => star.conv), [C2, C3, C1]);
  assert.equal(written.rev, 5, 'the revision moved, so a page holding the old list takes the new one');
  assert.equal(store.normalize(), false, 'once');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rev, 5);
  assert.equal(createStars({ file: path.join(folder, 'none.json') }).normalize(), false, 'no file, nothing written');
  fs.writeFileSync(path.join(folder, 'bad.json'), 'not json');
  assert.equal(createStars({ file: path.join(folder, 'bad.json') }).normalize(), false, 'a file that is not stars is left alone');
  assert.equal(fs.readFileSync(path.join(folder, 'bad.json'), 'utf8'), 'not json');
});
