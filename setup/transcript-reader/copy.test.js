'use strict';

// Fix group 4 (copy and small fixes): what the page says and how its small controls behave. Run from the repo root:
//   node --test setup/transcript-reader/copy.test.js
// The file reads the page sources as text and runs the page's own summaryLine; nothing is served.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (name) => fs.readFileSync(path.join(__dirname, 'prototype', name), 'utf8');
const page = read('template.html');
const sheet = read('questionnaire.html');
const fnBody = (src, fn) => src.slice(src.indexOf('function ' + fn + '('), src.indexOf('\n  }\n', src.indexOf('function ' + fn + '(')));
const styleBlock = page.match(/<style>([\s\S]*?)<\/style>/)[1];
const rule = (css, selector) => { const at = css.indexOf(selector + ' {'); assert.ok(at >= 0, 'rule ' + selector); return css.slice(at, css.indexOf('}', at) + 1); };

test('copy: the answer sheet has one name in the header, in a reply and on the sheet itself', () => {
  assert.match(page, /<span class="txt">Answer sheet<span class="go"> →<\/span><\/span>/);
  assert.match(styleBlock, /@media \(max-width: 440px\) \{ \.to-sheet \.go \{ display: none; \} \.name \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \} \}/, 'at phone width only the arrow goes, never a word, and the title gives way to a long badge');
  assert.doesNotMatch(page, /class="short"|Sheet →|Answer these questions/, 'no short form at phone width, no third name');
  assert.match(page, /"Answered · open the answer sheet" : "Answer sheet →"/);
  assert.match(page, /title="Answer sheet" aria-label="Answer sheet"/);
  assert.doesNotMatch(sheet, /Questionnaire"|No questionnaire found|this questionnaire is not/i, 'the sheet does not call itself a questionnaire');
  assert.match(sheet, /<title>Answer sheet \(prototype\)<\/title>/);
});

test('copy: "Your previous" names the button that goes back to your previous message', () => {
  assert.match(page, /\$\("button", "btn", "Your previous"\)/);
  assert.doesNotMatch(page, /Your last/);
});

test('copy: no "No action" chip, and a reply that flags nothing draws no chip at all', () => {
  const chip = fnBody(page, 'verdictChip');
  assert.doesNotMatch(chip, /"No action"/);
  assert.match(chip, /ex\.verdict === "no-action"\) return null/);
  assert.doesNotMatch(styleBlock, /\.chip\.none/);
  assert.match(page, /const verdict = verdictChip\(ex\);\n\s+if \(verdict\) who\.append\(verdict\);/, 'a null is never appended as the word "null"');
});

test('copy: the header count line leaves out every zero', () => {
  const { summaryLine } = vm.runInNewContext(fnBody(page, 'summaryLine') + '\n  }\n({ summaryLine })');
  assert.equal(summaryLine(11, [[6, 'from you'], [0, 'from Firstmate'], [0, 'from other sessions'], [4, 'wake-ups folded'], [4, 'need you']]), '11 turns · 6 from you · 4 wake-ups folded · 4 need you');
  assert.equal(summaryLine(2, [[1, 'from you'], [0, 'from Firstmate'], [0, 'wake-ups folded'], [0, 'need you']]), '2 turns · 1 from you');
  assert.equal(summaryLine(1, [[0, 'from you']]), '1 turn');
  assert.match(fnBody(page, 'renderReader'), /summaryLine\(exs\.length,/);
});

test('copy: one pressed style, in the "you" blue, for every toggle, and none in the "Needs you" yellow', () => {
  const css = styleBlock;
  const pressed = [...css.matchAll(/^[^\n{]*\[aria-pressed="true"\][^\n{]*\{[^}]*\}/gm)].map((m) => m[0]).filter((r) => !/svg/.test(r));
  assert.equal(pressed.length, 1, 'one rule decides it: ' + pressed.join(' | '));
  for (const sel of ['.btn', '.view-btn', '.follow-quick', '.star-btn', '.pin', '.search-row button']) assert.ok(pressed[0].includes(sel + '[aria-pressed="true"]'), sel + ' is in it');
  assert.match(pressed[0], /background: var\(--you-wash\); border-color: var\(--you\); color: var\(--you\);/);
  assert.doesNotMatch(pressed[0], /--ask/);
});

test('copy: the empty Documents state draws its file names as code and says it once', () => {
  const view = page.slice(page.indexOf('if (!entry) {', page.indexOf('function renderDocView')));
  const empty = view.slice(0, view.indexOf('return;'));
  assert.match(empty, /inline\("A markdown, HTML or image file that a message or reply names \(such as `requirements\.md`/);
  assert.doesNotMatch(empty, /"summary"/, 'no second line above it');
  assert.match(styleBlock, /\.md code, \.empty code \{/);
});

test('copy: the picker row says what its time is (named or changed), and "changed" is said once in the viewer', () => {
  assert.match(fnBody(page, 'fileRow'), /`\$\{x\.by \|\| "named"\} \$\{fmtListed\(x\.at\)\}`/);
  assert.match(page, /unnamed: true, by: "changed"/, 'a task file nobody named has only a change time');
  assert.match(page, /by: \(data\.documents\[e\.id\]\.mtime \|\| 0\) > \(e\.at \|\| 0\) \? "changed" : "named"/);
  assert.match(page, /\$\{framed \? "" : ` · changed /, 'an HTML file or picture says it in its toolbar only');
  assert.match(page, /As on disk now · changed/);
});

test('page: every "Show full reply" button says whether it is open', () => {
  const clip = fnBody(page, 'clipped');
  assert.match(clip, /more\.type = "button"; more\.setAttribute\("aria-expanded", "false"\)/);
  assert.match(clip, /more\.setAttribute\("aria-expanded", "true"\)/);
  assert.match(clip, /close: \(\) => \{[^}]*more\.setAttribute\("aria-expanded", "false"\)/);
  // The one place the button is made: no other "Show full" button is drawn without it.
  assert.equal(page.split('"Show full reply"').length - 1, 1);
});

test('page: the fade over a clipped reply does not take taps from a link under it', () => {
  assert.match(rule(styleBlock, '.clip::after'), /pointer-events: none;/);
});

function contrast(a, b) {
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('page: fold times and code labels reach 4.5:1 on the colours they sit on, light and dark', () => {
  const light = styleBlock.match(/:root \{([\s\S]*?)\n  \}/)[1], dark = styleBlock.match(/prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n    \}/)[1];
  const token = (block, name) => block.match(new RegExp('--' + name + ': (#[0-9a-f]{6})'))[1];
  assert.match(rule(styleBlock, '.fold .t'), /color: var\(--dim\)/);
  assert.match(rule(styleBlock, '.code-label'), /color: var\(--dim\)/);
  // .fold sits on the page (--wash); the code label sits on --paper.
  assert.ok(contrast(token(light, 'dim'), token(light, 'wash')) >= 4.5, 'fold time, light');
  assert.ok(contrast(token(light, 'dim'), token(light, 'paper')) >= 4.5, 'code label, light');
  assert.ok(contrast(token(dark, 'dim'), token(dark, 'wash')) >= 4.5, 'fold time, dark');
  assert.ok(contrast(token(dark, 'dim'), token(dark, 'paper')) >= 4.5, 'code label, dark');
});
