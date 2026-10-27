'use strict';

// Tests for the answer sheet's send-once rules (prototype/sendonce.js). Run from the repo root:
//   node --test setup/transcript-reader/sendonce.test.js
// The file runs in a bare sandbox: the rules hold which answers a questionnaire sent, and the one send in flight.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const makeSendOnce = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'sendonce.js'), 'utf8') + '\nmakeSendOnce', {});

const KEY = 'tr-q:abcd1234:1700000000';
const LINE = 'A1=accept;A2=inline';

// The click handler the page runs, with the request stubbed: begin first, then the send, then done or failed.
function sheet({ fail = false } = {}) {
  const once = makeSendOnce();
  const requests = [];
  async function click(key = KEY, text = LINE) {
    if (!once.begin(key, text)) return;
    try {
      await Promise.resolve();
      requests.push(text);
      if (fail) throw new Error('the pane is gone');
      once.done(key, text, 'Sent', '10:42');
    } catch (e) { once.failed(); }
  }
  return { once, requests, click };
}

test('a second click after a send that went through sends nothing, and Send stays off for those answers', async () => {
  const { once, requests, click } = sheet();
  await click();
  await click();
  assert.deepEqual(requests, [LINE]);
  assert.equal(once.busy(), false);
  assert.deepEqual({ ...once.sentFor(KEY, LINE) }, { text: LINE, word: 'Sent', at: '10:42' });
});

test('edited answers turn Send back on, and another questionnaire is unaffected', async () => {
  const { once, requests, click } = sheet();
  await click();
  assert.equal(once.sentFor(KEY, 'A1=reject;A2=inline'), null);
  assert.equal(once.sentFor('tr-q:other:1', LINE), null);
  await click(KEY, 'A1=reject;A2=inline');
  assert.deepEqual(requests, [LINE, 'A1=reject;A2=inline']);
  // Going back to the first text is a different send from the last one, so it goes.
  await click(KEY, LINE);
  assert.equal(requests.length, 3);
});

test('a failed send turns Send back on so the same answers can be tried again', async () => {
  const { once, requests, click } = sheet({ fail: true });
  await click();
  assert.equal(once.busy(), false);
  assert.equal(once.sentFor(KEY, LINE), null);
  await click();
  assert.deepEqual(requests, [LINE, LINE]);
});

test('a double tap before the first render sends once', async () => {
  const { once, requests, click } = sheet();
  await Promise.all([click(), click()]);
  assert.deepEqual(requests, [LINE]);
  assert.equal(once.sentFor(KEY, LINE).word, 'Sent');
});

test('while one send is in flight no other questionnaire sends either', async () => {
  const { once, requests, click } = sheet();
  assert.equal(once.begin(KEY, LINE), true);
  assert.equal(once.busy(), true);
  await click('tr-q:other:1', 'B1=yes');
  assert.deepEqual(requests, []);
});

test('a queued line reads Queued until the laptop answers: Sent keeps Send off, a refusal turns it on', () => {
  const once = makeSendOnce();
  once.begin(KEY, LINE); once.done(KEY, LINE, 'Queued', '10:42');
  assert.equal(once.sentFor(KEY, LINE).word, 'Queued');
  once.relabel(KEY, LINE, 'Sent');
  assert.equal(once.sentFor(KEY, LINE).word, 'Sent');
  once.forget(KEY, 'other text');
  assert.ok(once.sentFor(KEY, LINE), 'a receipt for answers since replaced does not touch the current record');
  once.forget(KEY, LINE);
  assert.equal(once.sentFor(KEY, LINE), null);
  assert.equal(once.begin(KEY, LINE), true);
});
