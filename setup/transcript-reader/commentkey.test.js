'use strict';

// Tests for the Cmd/Ctrl+Enter shortcut for "Comment on this" (prototype/commentkey.js). Run from the repo root:
//   node --test setup/transcript-reader/commentkey.test.js
// The file runs in a bare sandbox: the functions take a key event's fields and say whether it is the shortcut.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const commentKey = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'commentkey.js'), 'utf8') + '\ncommentKey', { Boolean });

const body = { tagName: 'BODY' };
const key = (extra = {}) => ({ key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, repeat: false, target: body, ...extra });

test('Cmd+Enter and Ctrl+Enter are the shortcut', () => {
  assert.equal(commentKey.pressed(key()), true);
  assert.equal(commentKey.pressed(key({ metaKey: false, ctrlKey: true })), true);
});

test('a plain Enter, or another key with Cmd, is not', () => {
  assert.equal(commentKey.pressed(key({ metaKey: false })), false);
  assert.equal(commentKey.pressed(key({ key: 'k' })), false);
});

test('Shift, Alt, a composing input method and a held key are not', () => {
  for (const extra of [{ shiftKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }]) assert.equal(commentKey.pressed(key(extra)), false, JSON.stringify(extra));
});

test('focus in a text field is not: the message box keeps Cmd+Enter as Add', () => {
  for (const target of [{ tagName: 'TEXTAREA' }, { tagName: 'INPUT' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(commentKey.pressed(key({ target })), false, target.tagName);
  }
  assert.equal(commentKey.pressed(key({ target: { tagName: 'DIV', isContentEditable: false } })), true);
});

test('the hint shows the Mac symbols on a Mac and Ctrl+Enter elsewhere', () => {
  assert.equal(commentKey.label('MacIntel'), '⌘↵');
  assert.equal(commentKey.label('iPhone'), '⌘↵');
  assert.equal(commentKey.label('Win32'), 'Ctrl+Enter');
  assert.equal(commentKey.label('Linux x86_64'), 'Ctrl+Enter');
  assert.equal(commentKey.label(undefined), 'Ctrl+Enter');
});
