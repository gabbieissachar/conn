'use strict';

// Tests for the reader page's address (prototype/address.js). Run from the repo root:
//   node --test setup/transcript-reader/address.test.js
// The file runs in a bare sandbox: the functions take a hash or a list of turns and answer plain values.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const address = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'address.js'), 'utf8') + '\naddress', { String, Array });
const SID = '9322c689-5f92-495b-b073-26102bcd7137';
const UID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

test('#s= alone, and #s= with &d=, read as they always have', () => {
  assert.deepEqual({ ...address.parse('#s=9322c689') }, { session: '9322c689', doc: null, message: null });
  assert.deepEqual({ ...address.parse(`#s=${SID}`) }, { session: SID, doc: null, message: null });
  assert.deepEqual({ ...address.parse('#s=9322c689&d=0123456789') }, { session: '9322c689', doc: '0123456789', message: null });
});

test('&m= names a message: a uuid, a prefix of one, and the hashed id a turn without one gets', () => {
  assert.deepEqual({ ...address.parse(`#s=9322c689&m=${UID}`) }, { session: '9322c689', doc: null, message: UID });
  assert.equal(address.parse('#s=9322c689&m=5e6f7a8b-9c0d').message, '5e6f7a8b-9c0d');
  assert.equal(address.parse('#s=9322c689&m=5e6f7a').message, '5e6f7a');
  assert.equal(address.parse('#s=9322c689&m=t0123456789abcdef01234567').message, 't0123456789abcdef01234567');
});

test('anything else is not an address, so the page reads none', () => {
  for (const hash of ['', '#', '#s=', '#s=XYZ', '#m=5e6f7a8b-9c0d', '#s=9322c689&m=', '#s=9322c689&m=abc', '#s=9322c689&m=' + 'a'.repeat(65),
    '#s=9322c689&m=5e6f7a8b-9c0d&d=0123456789', '#s=9322c689&d=0123456789&m=5e6f7a8b-9c0d', '#s=9322c689&d=012345678',
    '#s=9322c689&x=1', '#s=9322c689&m=5e6f7a8b 9c0d', 'x#s=9322c689', '#s=9322c689&m=5e6f7a8b-9c0d&m=5e6f7a8b-9c0d']) {
    assert.equal(address.parse(hash), null, JSON.stringify(hash));
  }
  assert.equal(address.parse(undefined), null);
  assert.equal(address.parse(null), null);
});

test('a hash naming a document and a message together is not an address (the two are different places)', () => {
  assert.equal(address.parse('#s=9322c689&d=0123456789&m=5e6f7a8b-9c0d'), null);
});

test('build writes what parse reads, the session cut to 8 characters', () => {
  assert.equal(address.build({ session: SID }), '#s=9322c689');
  assert.equal(address.build({ session: SID, doc: '0123456789' }), '#s=9322c689&d=0123456789');
  assert.equal(address.build({ session: SID, message: UID }), `#s=9322c689&m=${UID}`);
  for (const parts of [{ session: SID }, { session: SID, doc: '0123456789' }, { session: SID, message: UID }]) {
    const back = address.parse(address.build(parts));
    assert.equal(back.session, SID.slice(0, 8));
    assert.equal(back.doc, parts.doc || null);
    assert.equal(back.message, parts.message || null);
  }
});

test('find answers the turn whose id is the given one, exactly or by its first characters', () => {
  const turns = [{ uid: 'aaaaaaaa-0000' }, { uid: UID }, { uid: '5e6f7a8b-ffff-4e1f-8a2b-3c4d5e6f7a8b' }, { uid: 'bbbbbbbb-1111' }];
  assert.equal(address.find(turns, UID), 1);
  assert.equal(address.find(turns, 'bbbbbbbb-1111'), 3);
  assert.equal(address.find(turns, 'bbbbbb'), 3);
  assert.equal(address.find(turns, '5e6f7a8b-9c0d'), 1);
});

test('find takes the exact id over an earlier turn whose id merely starts with it, and the first of two that share a start', () => {
  const turns = [{ uid: 'abcdef-longer' }, { uid: 'abcdef' }];
  assert.equal(address.find(turns, 'abcdef'), 1);
  assert.equal(address.find(turns, 'abcdef-'), 0);
  assert.equal(address.find([{ uid: '5e6f7a8b-1' }, { uid: '5e6f7a8b-2' }], '5e6f7a8b'), 0);
});

test('find answers -1 for an id no turn has, a turn without an id, and bad input', () => {
  assert.equal(address.find([{ uid: UID }], 'ffffffff-0000'), -1);
  assert.equal(address.find([{ source: 'session' }, null, { uid: 7 }], '5e6f7a'), -1);
  assert.equal(address.find([{ uid: UID }], ''), -1);
  assert.equal(address.find(null, UID), -1);
  assert.equal(address.find(undefined, UID), -1);
  assert.equal(address.find([{ uid: UID }], undefined), -1);
});

test('the part an address points at is the reply, or the message when the turn has no reply', () => {
  assert.equal(address.part({ reply: 'Here it is.' }), 'reply');
  assert.equal(address.part({ reply: '' }), 'in');
  assert.equal(address.part({}), 'in');
  assert.equal(address.part(null), 'in');
});
