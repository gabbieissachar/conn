'use strict';

// Tests for what the reader page's permission-ask card says (prototype/askcards.js) and for how the page is wired to it. The helper file runs
// in a bare sandbox (no page, no server); the wiring is read from the template. Run from the repo root:
//   node --test setup/transcript-reader/askcards.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const LIVE = fs.readFileSync(path.join(__dirname, 'prototype', 'live.js'), 'utf8');
const BUILD = fs.readFileSync(path.join(__dirname, 'prototype', 'build_prototype.py'), 'utf8');
const { ASK_UNDO_SECONDS, askTitle, askFields, askOutcome, askPlace, asksOf, askBlockedReason } = vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, 'prototype', 'askcards.js'), 'utf8') + '\n({ ASK_UNDO_SECONDS, askTitle, askFields, askOutcome, askPlace, asksOf, askBlockedReason })');

const t = (at) => 'T' + at;
// the sandbox's arrays and objects belong to another realm, which deepEqual tells apart; a JSON round trip brings them home
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the Undo window of an answer is 3 seconds, as the Campus ask\'s', () => assert.equal(ASK_UNDO_SECONDS, 3));

test('the title says what Claude asks to do, by the tool, and names a tool it does not know as it is called', () => {
  assert.equal(askTitle('Bash'), 'Claude asks to run a command');
  assert.equal(askTitle('WebFetch'), 'Claude asks to fetch a web page');
  assert.equal(askTitle('Edit'), 'Claude asks to edit a file');
  assert.equal(askTitle('mcp__slack__slack_send_message'), 'Claude asks to use slack_send_message (from slack)');
  assert.equal(askTitle('SomethingNew'), 'Claude asks to use SomethingNew');
  assert.equal(askTitle(''), 'Claude asks to use a tool');
});

test('every key of the input is a field, the main ones first, and a long or multi-line value is a block that is never cut', () => {
  const long = 'x'.repeat(5000);
  const fields = askFields({ timeout: 30000, description: 'Run the build', command: 'cd /work && make\nmake test', extra_unknown: { a: [1, 2] }, long });
  assert.deepEqual(plain(fields.map((f) => f.key)), ['command', 'description', 'timeout', 'extra_unknown', 'long']);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.equal(byKey.command.block, true, 'a command with a line break is a block');
  assert.equal(byKey.command.text, 'cd /work && make\nmake test', 'the whole of it');
  assert.equal(byKey.command.code, true);
  assert.equal(byKey.description.block, false, 'a short line sits beside its name');
  assert.equal(byKey.description.code, false);
  const one = Object.fromEntries(askFields({ command: 'ls', file_path: '/a/b.md', url: 'https://x.test/', query: 'cats' }).map((f) => [f.key, f]));
  assert.deepEqual(plain([one.command.block, one.command.code]), [true, true], 'even a one-word command is a block in the monospace face');
  assert.deepEqual(plain([one.file_path.block, one.file_path.code, one.url.code, one.query.code]), [false, true, true, false], 'a path or a link is one line in the monospace face');
  assert.equal(byKey.long.text.length, 5000, 'a long value is not cut');
  assert.equal(byKey.long.block, true);
  assert.equal(byKey.timeout.text, '30000');
  assert.equal(byKey.extra_unknown.text, JSON.stringify({ a: [1, 2] }, null, 2), 'an object is shown whole as JSON');
  assert.equal(byKey.extra_unknown.block, true);
});

test('an input with nothing, or not an object, shows no fields instead of failing', () => {
  assert.deepEqual(plain(askFields({})), []);
  assert.deepEqual(plain(askFields(null)), []);
  assert.deepEqual(plain(askFields('x')), []);
});

test('what an answered record says, and in which tone', () => {
  assert.deepEqual(plain(askOutcome({ state: 'allowed', answered_at: 5, at: 1 }, t)), { tone: 'ok', say: 'Answered: Allowed once · T5' });
  assert.deepEqual(plain(askOutcome({ state: 'denied', answered_at: 6, at: 1 }, t)), { tone: 'no', say: 'Answered: Denied · T6' });
  assert.match(askOutcome({ state: 'elsewhere', ended_at: 7, at: 1 }, t).say, /^Answered in the pane, not here · T7$/);
  assert.match(askOutcome({ state: 'expired', ended_at: 8, at: 1 }, t).say, /prompt took over/);
  assert.match(askOutcome({ state: 'gone', ended_at: 9, at: 1 }, t).say, /restarted/);
  assert.equal(askOutcome({ state: 'open', at: 1 }, t).tone, 'open');
});

test('a record goes after the last turn that began at or before it, or first when it came before them all', () => {
  const turns = [{ at: 100 }, { at: 200 }, { at: 300 }, { at: 0 }];
  assert.equal(askPlace(turns, 50), -1);
  assert.equal(askPlace(turns, 100), 0);
  assert.equal(askPlace(turns, 250), 1);
  assert.equal(askPlace(turns, 9999), 2, 'a turn with no time is never the place');
  assert.equal(askPlace([], 5), -1);
});

test('the records of a conversation are those of any of its sessions (a /clear starts a new one), oldest first', () => {
  const asks = [{ id: 'b', session: 'S2', at: 20 }, { id: 'a', session: 'S1', at: 10 }, { id: 'x', session: 'S9', at: 5 }, { id: 'c', session: 'S2', at: 20 }];
  assert.deepEqual(plain(asksOf(asks, ['S1', 'S2']).map((a) => a.id)), ['a', 'b', 'c']);
  assert.deepEqual(plain(asksOf(undefined, ['S1'])), []);
});

test('what Send says at a permission prompt: answer the ask above when it is on the page, Herdr\'s pane otherwise', () => {
  assert.match(askBlockedReason('alpha', true), /Answer it above \(Allow once or Deny\)/);
  assert.match(askBlockedReason('alpha', false), /Answer it in Herdr first\./);
});

test('the template pastes the helper once, offers Allow once and Deny and nothing that grants more, and never builds the card with innerHTML', () => {
  assert.equal(TEMPLATE.split('/*__ASKCARDS__*/').length, 2);
  assert.match(BUILD, /ASKCARDS_SCRIPT = HERE \/ "askcards\.js"/);
  assert.match(BUILD, /\/\*__ASKCARDS__\*\//);
  const section = TEMPLATE.slice(TEMPLATE.indexOf('// ---------------------------------------------------------------- permission asks from Claude'), TEMPLATE.indexOf('// The faded message for each send of the session on screen'));
  assert.ok(section.length > 3000);
  assert.match(section, /"Allow once"/);
  assert.match(section, /"Deny"/);
  assert.doesNotMatch(section, /innerHTML|insertAdjacentHTML/, 'a command is text, never markup');
  assert.doesNotMatch(section, /updatedPermissions|allow_always|decision: "always"|session-wide/);
  assert.match(section, /decision: "allow"|answerAsk\(rec, "allow"\)/);
  assert.match(section, /shown: rec\.digest/, 'the answer names what the card showed');
});

test('live.js carries the two calls, and the answer is a POST of JSON like every other write', () => {
  assert.match(LIVE, /const permissions = \(rev, signal, wait = 25000\) => call\("permissions\?rev="/);
  assert.match(LIVE, /const permissionAnswer = body => call\("permission-answer", \{ method: "POST"/);
  assert.match(LIVE, /return \{ served, state, sync, steps, permissions, permissionAnswer,/);
});
