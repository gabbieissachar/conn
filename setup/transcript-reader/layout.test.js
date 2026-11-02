'use strict';

// Tests for the page's layout and touch rules (prototype/template.html): where the header starts on a phone, the one column width,
// the jumps in the folded header, the table cue, the readable line length and the 44 px controls. Run from the repo root:
//   node --test setup/transcript-reader/layout.test.js
// The page's own code runs on stand-ins for the browser; the style rules are read from its source. Nothing is served or drawn here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const STYLE = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
const fnBody = (fn) => PAGE.slice(PAGE.indexOf('function ' + fn + '('), PAGE.indexOf('\n  }\n', PAGE.indexOf('function ' + fn + '(')) + 5);

// ---- the header's first state: a remembered choice wins, else the width decides ----

// The page's own lines that read the choice and the width, run with a stand-in for each.
function startup({ phone, kept, broken = false }) {
  const from = PAGE.indexOf('const narrow = matchMedia(');
  const to = PAGE.indexOf('state.barOpen = barChoice === null', from);
  const source = PAGE.slice(from, PAGE.indexOf('\n', to));
  const state = { barOpen: true };
  const localStorage = { getItem: (key) => { if (broken) throw new Error('no storage'); return key === 'tr-bar' ? kept : null; } };
  const matchMedia = (query) => ({ matches: query === '(max-width: 440px)' ? phone : false, addEventListener() {} });
  return vm.runInNewContext(source + '\n({ barOpen: state.barOpen, barChoice })', { state, localStorage, matchMedia });
}

test('a phone opens with the header folded and a wide screen with it open, when nothing was chosen', () => {
  assert.equal(startup({ phone: true, kept: null }).barOpen, false);
  assert.equal(startup({ phone: false, kept: null }).barOpen, true);
});

test('what was chosen in this browser wins over the width, on a phone and off it', () => {
  assert.equal(startup({ phone: true, kept: '1' }).barOpen, true, 'opened on a phone and remembered');
  assert.equal(startup({ phone: false, kept: '0' }).barOpen, false, 'folded on a wide screen and remembered');
  assert.equal(startup({ phone: true, kept: '0' }).barOpen, false);
  assert.equal(startup({ phone: false, kept: '1' }).barOpen, true);
});

test('a browser that keeps nothing (or throws) gets the width\'s default, and a value it does not know is no choice', () => {
  assert.equal(startup({ phone: true, kept: null, broken: true }).barOpen, false);
  assert.equal(startup({ phone: false, kept: null, broken: true }).barOpen, true);
  assert.equal(startup({ phone: true, kept: 'maybe' }).barChoice, null);
});

test('only the owner\'s own tap keeps a choice; the width\'s default never does, and a turned phone follows it until a choice is made', () => {
  const body = fnBody('setBarOpen');
  assert.match(body, /setBarOpen\(open, chosen = true\)/);
  assert.match(body, /if \(chosen\) \{\s*barChoice = open;\s*try \{ localStorage\.setItem\("tr-bar", open \? "1" : "0"\); \}/);
  assert.match(PAGE, /narrow\.addEventListener\("change", \(\) => \{ if \(barChoice === null\) setBarOpen\(!narrow\.matches, false\); \}\);/);
  assert.match(PAGE, /document\.getElementById\("bar-toggle"\)\.addEventListener\("click", \(\) => \{ if \(look\.open\) closeSearch\(\); else setBarOpen\(!state\.barOpen\); \}\);/);
  assert.match(PAGE, /document\.getElementById\("crumb"\)\.addEventListener\("click", \(\) => \{ if \(look\.open\) closeSearch\(\); else setBarOpen\(true\); \}\);/);
});

test('nothing else opens or folds the header, so an HTML file on a phone keeps whatever the header was', () => {
  const writes = PAGE.match(/state\.barOpen = /g) || [];
  assert.equal(writes.length, 2, 'the start-up line and setBarOpen only');
});

// ---- one column width, with room for a side menu ----

test('the header, the conversation and the message bar share one width variable: 44rem, 76rem on Documents', () => {
  assert.match(STYLE, /--col: 44rem; --col-doc: 76rem; --rail: 0px;/);
  assert.match(STYLE, /\.bar-inner \{ max-width: var\(--col\);/);
  assert.match(STYLE, /\n {2}main \{ max-width: var\(--col\);/);
  assert.match(STYLE, /\.dock-inner \{ max-width: var\(--col\);/);
  assert.match(STYLE, /\.docmode \{ --col: var\(--col-doc\); \}/);
  assert.doesNotMatch(STYLE, /27rem/, 'no column of 432 px left');
});

test('a side menu can take the right edge: the page, the message bar and the new-reply pill all leave --rail', () => {
  assert.match(STYLE, /body \{ padding-right: var\(--rail\); \}/);
  assert.match(STYLE, /\.dock \{ position: fixed; left: 0; right: var\(--rail\);/);
  assert.match(STYLE, /\.new-reply \{ position: fixed; left: calc\(\(100% - var\(--rail\)\) \/ 2\);/);
});

// ---- the readable line ----

test('prose stops at --measure (35rem, about 75 characters) in a reply and in a document; tables and code keep the whole box', () => {
  assert.match(STYLE, /--measure: 35rem;/);
  const rule = STYLE.match(/\.md > :is\(([^)]*)\) \{ max-width: var\(--measure\); \}/);
  assert.ok(rule, 'one rule for the prose elements');
  for (const tag of ['p', 'ul', 'ol', 'blockquote', 'hr', 'h1', 'h6']) assert.ok(rule[1].split(', ').includes(tag), tag);
  for (const tag of ['table', 'pre', 'div']) assert.ok(!rule[1].split(', ').includes(tag), tag + ' is not capped');
});

test('a document\'s contents list sits beside it from 1180 px, opened, and above it folded below that', () => {
  assert.match(STYLE, /@media \(min-width: 1180px\) \{\s*\.docview \{ display: grid; grid-template-columns: minmax\(0, calc\(var\(--measure\) \+ 36px\)\) minmax\(12rem, 16rem\);/);
  assert.match(PAGE, /const sideToc = matchMedia\("\(min-width: 1180px\)"\);/);
  assert.equal((PAGE.match(/toc\.open = sideToc\.matches;/g) || []).length, 2, 'opened on draw, and kept open after a jump');
  assert.match(PAGE, /sideToc\.addEventListener\("change", \(\) => \{ if \(state\.view === "doc"\) render\(\); \}\);/);
});

// ---- the table cue ----

// The page's tableCue on stand-ins: an element with a class list, children and the scroll numbers of a table box.
function cueWorld() {
  const make = (cls) => ({ cls, kids: [], classList: { set: new Set(), toggle(name, on) { if (on) this.set.add(name); else this.set.delete(name); } }, append(...kids) { for (const kid of kids) { this.kids.push(kid); kid.parent = this; } }, replaceWith(node) { this.replacedBy = node; } });
  const observed = [];
  const sandbox = { $: (tag, cls) => make(cls), ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { observed.push(this.fn); } }, window: {}, requestAnimationFrame: (fn) => fn() };
  sandbox.window.ResizeObserver = sandbox.ResizeObserver;
  vm.runInNewContext(fnBody('tableCue') + '\nthis.tableCue = tableCue;', sandbox);
  const table = (scrollWidth, clientWidth) => {
    const wrap = { scrollWidth, clientWidth, scrollLeft: 0, listeners: {}, replaceWith(node) { this.replacedBy = node; }, addEventListener(name, fn) { this.listeners[name] = fn; } };
    sandbox.tableCue(wrap);
    return { wrap, cue: wrap.replacedBy, scrollTo(x) { wrap.scrollLeft = x; wrap.listeners.scroll(); }, resize: () => observed.forEach((fn) => fn()) };
  };
  return { table, classes: (t) => [...t.cue.classList.set].sort() };
}

test('a table wider than its box shows a cue on the right, then on both edges, then only on the left at the end', () => {
  const { table, classes } = cueWorld();
  const t = table(700, 400);
  assert.equal(t.cue.kids[0], t.wrap, 'the scrolling box sits inside the one that carries the cue');
  assert.deepEqual(t.cue.kids.slice(1).map((k) => k.cls), ['cue l', 'cue r'], 'with the two edges beside it');
  t.resize();
  assert.deepEqual(classes(t), ['more-r']);
  t.scrollTo(150);
  assert.deepEqual(classes(t), ['more-l', 'more-r']);
  t.scrollTo(300);
  assert.deepEqual(classes(t), ['more-l'], 'the right edge is reached');
});

test('a table that fits shows no cue, and one that stops fitting when the window narrows gets it', () => {
  const { table, classes } = cueWorld();
  const t = table(400, 400);
  t.resize();
  assert.deepEqual(classes(t), []);
  t.wrap.clientWidth = 300;
  t.resize();
  assert.deepEqual(classes(t), ['more-r']);
});

test('the cue is drawn on a box around the table so it stays put while the table scrolls, and never takes a tap', () => {
  assert.match(STYLE, /\.table-cue \{ position: relative;/);
  assert.match(STYLE, /\.table-cue \.cue \{[^}]*pointer-events: none;/);
  assert.match(STYLE, /\.table-cue\.more-l \.cue\.l, \.table-cue\.more-r \.cue\.r \{ display: block; \}/);
  assert.match(PAGE, /box\.querySelectorAll\("\.table-wrap"\)\.forEach\(tableCue\);/, 'every drawn table, in a reply and in a document');
});

// ---- the folded header and touch ----

test('the folded header has the three jumps, and they are the pills\' own function', () => {
  const title = PAGE.match(/<div class="title">(.*?)<\/div>/s)[1];
  for (const id of ['jump-prev', 'jump-next', 'jump-ask']) assert.match(title, new RegExp(`<button class="jump[^"]*" id="${id}" type="button" aria-label="[^"]+" title="[^"]+">`));
  assert.match(PAGE, /getElementById\("jump-prev"\)\.addEventListener\("click", \(\) => jump\("captain", -1\)\);/);
  assert.match(PAGE, /getElementById\("jump-next"\)\.addEventListener\("click", \(\) => jump\("captain", 1\)\);/);
  assert.match(PAGE, /getElementById\("jump-ask"\)\.addEventListener\("click", \(\) => jump\("needs", 1\)\);/);
  assert.match(fnBody('paintBar'), /state\.view !== "reader" \|\| !session \|\| !session\.exchanges\.length/, 'only on a conversation with turns');
  assert.match(STYLE, /\.bar\.collapsed \.jump:not\(\[hidden\]\) \{ display: block; \}/, 'only while folded');
});

test('on a phone\'s width the folded header is two lines, and the sync line stays out of it unless it warns', () => {
  const block = STYLE.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n {2}\}/)[1];
  assert.match(block, /\.bar\.collapsed \.title \{ flex-wrap: wrap;/);
  assert.match(block, /\.bar\.collapsed \.title::after \{ content: ""; order: 6; flex: 0 0 100%; height: 0; \}/, 'the break');
  assert.match(block, /\.bar\.collapsed \.asof:not\(\.stale\) \{ display: none; \}/);
  assert.match(block, /\.bar\.searching \.title::after/, 'a search has the one line');
});

test('every control of the header is 44 px where the screen is touched', () => {
  const blocks = [...STYLE.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n {2}\}/g)].map((m) => m[1]);
  const block = blocks.find((b) => b.includes('.bar .tab'));
  assert.ok(block, 'one block for the header');
  const rule = (selector) => { const hit = block.split('\n').find((line) => line.includes(selector)); assert.ok(hit, selector); return hit; };
  assert.match(rule('.bar :is(.view-btn, .bar-toggle, .search-toggle, .star-btn, .crumb-star)'), /width: 44px; height: 44px/);
  assert.match(rule('.bar.collapsed .to-sheet'), /width: 44px; height: 44px/, 'the icon');
  assert.match(rule('.bar .to-sheet {'), /min-height: 44px/, 'the text link of the open header');
  assert.match(rule('.bar :is(.follow-quick, .jump)'), /height: 44px; min-width: 44px/);
  assert.match(rule('.bar .crumb {'), /min-height: 44px/);
  assert.match(rule('.bar :is(.crumb-session, .crumb-doc, .controls select)'), /height: 44px/);
  assert.match(rule('.bar .tab, .bar .btn'), /min-height: 44px/, 'tabs, pills, Pins, Follow Herdr and the search chips');
  assert.match(rule('.bar .asof button.sync'), /min-height: 44px/);
  assert.match(rule('.bar .asof a.offline-link'), /min-height: 44px/);
  assert.match(rule('.search-row input'), /height: 44px/);
  assert.match(rule('.search-row button'), /height: 44px; min-width: 44px/);
  assert.match(rule('.pin-item, .pin-x'), /min-height: 44px/);
  assert.match(rule('.bar.collapsed .view-btn::after'), /content: none/, 'the icons are 44 px themselves, not by a larger tap area');
});
