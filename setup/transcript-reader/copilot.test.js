'use strict';

// Tests for what the reader page does with a Copilot session (prototype/template.html): the conversation is read only, so the
// message bar says so first and never calls it a fault. Run from the repo root: node --test setup/transcript-reader/copilot.test.js
// The server's side (the panes, the log, the refusal) is in api.test.js; the parser's is in test_copilot.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

const SENTENCE = 'Sending to Copilot is not supported yet.';

test('the message bar gives a Copilot session its reason before any other, and the server refuses with the same words', () => {
  const chain = page.slice(page.indexOf('let reason = "";'));
  const first = chain.slice(0, chain.indexOf('const command = dockTyped()'));
  assert.match(first, /^let reason = "";\s*\/\/[^\n]*\n\s*if \(session\.agent === "copilot"\) reason = "Sending to Copilot is not supported yet\. Copy still works\.";\s*\n\s*else if \(HOSTED\)/,
    'the Copilot reason leads the chain, so no copy (served, hosted or offline) offers Send for it');
  assert.ok(first.includes(SENTENCE));
  assert.ok(api.includes(`const COPILOT_SEND_REFUSAL = '${SENTENCE}';`), 'the server says the same sentence');
});

test('the Copilot reason is a plain note, not drawn as a fault', () => {
  const line = page.split('\n').find((text) => text.includes('status.classList.toggle("bad"'));
  assert.ok(line, 'the status line toggles its fault style');
  assert.match(line, /Boolean\(reason && pane && session\.agent !== "copilot"\)/);
});

test('Send checks for a Copilot session before it asks Herdr anything or presses a key', () => {
  const body = api.slice(api.indexOf('async function sendPrompt(body)'));
  const refusal = body.indexOf('isCopilotSession(sessionId)');
  assert.ok(refusal > 0, 'sendPrompt checks');
  assert.ok(refusal < body.indexOf('await scan('), 'before Herdr is read');
  assert.ok(refusal < body.indexOf("'send-keys'"), 'before any key is sent');
  assert.ok(refusal < body.indexOf("'agent', 'prompt'"), 'before any text is sent');
});
