'use strict';

// Tests for the answer sheet's rules (prototype/questionnaire.html, between "rules:start" and "rules:end") and its styles.
// Run from the repo root: node --test setup/transcript-reader/sheet.test.js
// The rules run alone in a bare sandbox; the cards come from build_questionnaire.py's own reading of a made-up review.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const HTML = fs.readFileSync(path.join(__dirname, 'prototype', 'questionnaire.html'), 'utf8');
const rules = HTML.slice(HTML.indexOf('/* rules:start'), HTML.indexOf('/* rules:end */'));
const sandbox = vm.runInNewContext(
  `const fields = q => [...q.cards.map(c => ({ ...c, kind: 'card' })), ...q.corrections.map(k => ({ key: k, kind: 'correction' }))];\n${rules}\n({ settledKeys, isAnswered, openCards, answerLine, messageOf, fillPlan, leftOut, countText, sessionOfAddress, inSession })`,
  { Boolean, URLSearchParams, String });

const REVIEW = `Review group B (3 cards): the monthly release note.

| ID | Decision | Depends on | Recommended default | Answer |
| --- | --- | --- | --- | --- |
| B1 | Which month the note covers | none | The **previous** month. | \`previous\`, \`current\`, or \`custom\` |
| B2 | Who receives the copy | B1 | Send it to finance only. | \`finance\`, \`ops\`, or \`both\` |
| B3 | How many rows the table may hold | none | \`500\` | \`100\`, \`500\`, \`1000\` |

Reply with keyed answers: \`B1=...; B2=...; B3=...\`
`;
const parse = (reply) => JSON.parse(execFileSync('python3', ['-c',
  'import json,sys; sys.path.insert(0, sys.argv[1]); from build_questionnaire import parse_questionnaire; print(json.dumps(parse_questionnaire(sys.stdin.read())))',
  path.join(__dirname, 'prototype')], { input: reply, encoding: 'utf8' }));
const withSent = (q, sent) => ({ ...q, sent, sent_at: 1 });

test('Fill recommended fills 3 of 3 on the lab review, though only one recommendation opens with its choice', () => {
  const q = parse(REVIEW);
  assert.equal(q.cards.length, 3);
  const plan = sandbox.fillPlan(q, {}, false);
  assert.deepEqual(plan.map((f) => `${f.key}=${f.value}`), ['B1=previous', 'B2=finance', 'B3=500']);
});

test('Fill leaves alone a card already picked and a card whose recommendation names no single choice', () => {
  const q = parse(REVIEW.replace('Send it to finance only.', 'Send it to finance and ops.'));
  assert.deepEqual(sandbox.fillPlan(q, { B1: 'current' }, false).map((f) => f.key), ['B3'], 'B1 picked; B2 names two choices, so none is starred');
});

test('the preview is exactly what Send types: no gap for a card left out, and the left-out cards are named beside it', () => {
  const q = parse(REVIEW);
  const pointer = 'Re your reply at 09:14 ("Review group B"): ';
  const picked = { B3: '1000' };
  const typed = sandbox.messageOf(q, picked, pointer, false);
  assert.equal(typed, pointer + 'B3=1000');
  assert.doesNotMatch(typed, /\?/);
  assert.deepEqual(sandbox.leftOut(q, picked, false), ['B1', 'B2']);
  assert.equal(sandbox.countText(q, picked, false), '1 of 3 answered. B1 and B2 are left out of what Send types.');
  assert.equal(sandbox.countText(q, { B1: 'a', B2: 'b', B3: 'c' }, false), '3 of 3 answered');
  assert.equal(sandbox.countText(q, {}, false), '0 of 3 answered');
  assert.equal(sandbox.messageOf(q, {}, pointer, false), '', 'nothing picked, nothing to send');
});

test('a questionnaire the session already answered is answered and sends nothing until "Answer again"', () => {
  const q = withSent(parse(REVIEW), { B1: 'previous', B2: 'finance', B3: '500' });
  assert.equal(sandbox.isAnswered(q, false), true);
  assert.deepEqual(sandbox.openCards(q, false), []);
  assert.equal(sandbox.messageOf(q, { B1: 'current' }, 'P: ', false), '', 'a draft is not sent over a sent answer');
  assert.deepEqual(sandbox.fillPlan(q, {}, false), []);
  assert.equal(sandbox.isAnswered(q, true), false, 'reopened');
  assert.equal(sandbox.openCards(q, true).length, 3);
  assert.equal(sandbox.messageOf(q, { B1: 'current' }, 'P: ', true), 'P: B1=current');
});

test('a part-answered questionnaire keeps the answered cards out of the line and counts only the open ones', () => {
  const q = withSent(parse(REVIEW), { B1: 'previous' });
  assert.equal(sandbox.isAnswered(q, false), false);
  assert.deepEqual(sandbox.settledKeys(q, false), ['B1']);
  assert.deepEqual(sandbox.fillPlan(q, {}, false).map((f) => f.key), ['B2', 'B3']);
  assert.equal(sandbox.messageOf(q, { B1: 'current', B2: 'ops' }, 'P: ', false), 'P: B2=ops');
  assert.equal(sandbox.countText(q, { B2: 'ops' }, false), '1 of 2 answered. B3 is left out of what Send types.');
});

// ---- styles
const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const dark = { ...light, ...tokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf('* { box-sizing')) ) };
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const rule = (selector) => { const at = css.indexOf(selector + ' {'); assert.ok(at >= 0, `${selector} has a rule`); return css.slice(at, css.indexOf('}', at)); };

test('text on filled and picked controls reaches 4.5:1 in light and dark', () => {
  assert.match(rule('.dock button.primary'), /color: var\(--paper\)/, 'Send draws var(--paper) on the blue, not white');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const pairs = [['Send', t.paper, t.you], ['picked chip', t.ink, t['you-wash']], ['tick', t.you, t['you-wash']], ['star on a picked chip', t.ask, t['you-wash']],
      ['hint', t.muted, t.paper], ['prototype label', t.muted, t.paper], ['section label', t.muted, t.wash]];
    for (const [what, fg, bg] of pairs) assert.ok(contrast(fg, bg) >= 4.5, `${name}: ${what} ${contrast(fg, bg).toFixed(2)}:1`);
  }
});

test('a picked chip is a wash with an outline, so Send is the only solid control; the prototype label is not red; no all-caps label', () => {
  assert.match(rule('.opt[aria-pressed="true"]'), /background: var\(--you-wash\)/);
  assert.doesNotMatch(css, /text-transform:\s*uppercase/);
  assert.doesNotMatch(rule('.proto'), /var\(--open\)/);
});

test('every control is at least 44 px tall on a phone or a touch screen', () => {
  const at = css.indexOf('@media (max-width: 440px), (pointer: coarse)');
  assert.ok(at >= 0);
  const block = css.slice(at, css.indexOf('</style>') >= 0 ? css.length : undefined);
  for (const selector of ['select.pick', '.opt', '.dock button', '.sent button']) assert.ok(block.includes(selector), selector);
  assert.match(block, /min-height: 44px/);
  assert.match(block, /\.title a \{[^}]*min-height: 44px/);
  assert.match(block, /\.other \{ min-height: 44px/);
});

// --------------------------------------------------------------------------------------------------- scoped to the conversation (2026-11-08)

test('sheet: the address names the conversation whose sheets it lists, by #s= or by a reply\'s #q= link, and no address lists them all', () => {
  assert.equal(sandbox.sessionOfAddress('#s=AAAA1111'), 'aaaa1111');
  assert.equal(sandbox.sessionOfAddress('#q=bbbb2222%3A1762600000'), 'bbbb2222');
  assert.equal(sandbox.sessionOfAddress('#s=cccc3333&q=bbbb2222:1'), 'cccc3333', 'the conversation is named first');
  assert.equal(sandbox.sessionOfAddress(''), '');
  assert.equal(sandbox.sessionOfAddress('#pick=bbbb2222:1'), '', 'the page\'s own memory of a pick does not narrow the list to it');
});

test('sheet: a sheet is of the conversation when its pane\'s newest session or the session it was asked in starts with the address', () => {
  const list = [{ session: 'aaaa1111-0000' }, { session: 'bbbb2222-0000' }, { session: 'bbbb2222-0000', from_session: 'cccc3333-0000' }];
  assert.deepEqual(list.filter((q) => sandbox.inSession(q, 'bbbb2222')).length, 2);
  assert.deepEqual(list.filter((q) => sandbox.inSession(q, 'cccc3333')), [list[2]], 'a questionnaire from before a /clear is of the same conversation');
  assert.deepEqual(list.filter((q) => sandbox.inSession(q, '')).length, 3, 'no address: every conversation\'s');
  assert.equal(list.filter((q) => sandbox.inSession(q, 'dddd4444')).length, 0);
});

test('sheet: the reader page\'s title bar link and the sheet\'s way back both name the conversation', () => {
  assert.ok(HTML.includes('back.href = (LAZY ? "index.html" : "prototype.html") + (onlySession ? "#s=" + encodeURIComponent(onlySession.slice(0, 8)) : "");'));
  assert.ok(HTML.includes('qs = data.questionnaires.filter(ofSession);'), 'a rebuild of the served sheet is scoped the same way');
});
