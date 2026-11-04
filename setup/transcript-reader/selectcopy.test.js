'use strict';

// Tests for copy-on-select's decision and clipboard paths. The browser wiring stays in
// template.html, while this small module is shared by the local and hosted/offline pages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'prototype', 'selectcopy.js'), 'utf8');
const api = vm.runInNewContext(`${source}\nreaderSelectCopy`, {});
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

test('decision: empty and whitespace-only selections are ignored', () => {
  same(api.decide({ text: '', eligible: true }), { copy: false, reason: 'empty' });
  same(api.decide({ text: ' \n\t', eligible: true }), { copy: false, reason: 'empty' });
  same(api.decide({ text: 'words', collapsed: true, eligible: true }), { copy: false, reason: 'empty' });
});

test('decision: editable fields and areas outside the reader are ignored', () => {
  same(api.decide({ text: 'draft', editable: true, eligible: true }), { copy: false, reason: 'editable' });
  same(api.decide({ text: 'header', eligible: false }), { copy: false, reason: 'outside' });
});

test('DOM boundaries: editable fields are skipped and reader areas are eligible', () => {
  const textarea = { nodeType: 1, closest: selector => selector.includes('textarea') ? textarea : null };
  const reply = { nodeType: 1, closest: selector => selector.includes('#main .reply') ? reply : null };
  assert.equal(api.isEditableTarget(textarea), true);
  assert.equal(api.copyArea(reply), reply);
});

test('decision: the same unchanged selection is copied once', () => {
  const first = api.decide({ text: 'same words', eligible: true, signature: 'node-a:1-node-a:11' });
  same(first, { copy: true, text: 'same words', signature: 'node-a:1-node-a:11' });
  same(api.decide({ text: 'same words', eligible: true, signature: first.signature }, first.signature), { copy: false, reason: 'repeat' });
  same(api.decide({ text: 'same words', eligible: true, signature: 'node-b:1-node-b:11' }, first.signature), { copy: true, text: 'same words', signature: 'node-b:1-node-b:11' });
});

test('clipboard: secure contexts use navigator.clipboard without the fallback', async () => {
  const calls = [];
  const result = await api.copy('line 1\nline 2', {
    isSecureContext: true,
    navigator: { clipboard: { writeText: text => { calls.push(text); return Promise.resolve(); } } },
    document: { execCommand: () => { throw new Error('fallback should not run'); } },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, ['line 1\nline 2']);
});

test('clipboard: plain HTTP uses the hidden textarea fallback synchronously', async () => {
  const calls = [];
  const parent = {
    children: [],
    appendChild(node) { this.children.push(node); },
    removeChild(node) { this.children = this.children.filter(child => child !== node); },
  };
  const document = {
    body: parent,
    createElement(tag) {
      assert.equal(tag, 'textarea');
      return {
        style: {},
        setAttribute(name, value) { this[name] = value; },
        select() { calls.push(['select', this.value]); },
        remove() { parent.removeChild(this); },
      };
    },
    execCommand(command) { calls.push(['execCommand', command]); return true; },
  };
  const result = await api.copy('keep\nline breaks', { isSecureContext: false, navigator: {}, document });
  assert.equal(result, true);
  assert.deepEqual(calls, [['select', 'keep\nline breaks'], ['execCommand', 'copy']]);
  assert.deepEqual(parent.children, []);
});
