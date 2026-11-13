'use strict';

// Tests for the page's search matching (prototype/find.js). Run from the repo root:
//   node --test setup/transcript-reader/find.test.js
// The file runs in a sandbox, as the page's script would run it. Every turn is synthetic placeholder text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'prototype', 'find.js'), 'utf8');
// The page defines markdownView (the vendored parser and markdown.js) and stepsView (steps.js) before find.js, which reads replies and steps through them.
const MARKDOWN = ['vendor/markdown-it.min.js', 'markdown.js', 'steps.js'].map((file) => fs.readFileSync(path.join(__dirname, 'prototype', file), 'utf8'));

// What the sandbox builds has its own Array and Object, which a strict comparison tells apart: compare as data.
const deepEqual = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);

function load() {
  const sandbox = {};
  vm.createContext(sandbox);
  for (const source of MARKDOWN) vm.runInContext(source, sandbox);
  return vm.runInContext(SOURCE + '\nfinder;', sandbox);
}

// A turn as the builder makes it, with the fields the matching reads.
const turn = (extra) => ({
  source: 'captain', kind: 'message', label: 'You', input: '', reply: '', reply_words: 0, narration: [], narration_words: 0,
  folded: false, verdict: 'no-action', at: 100, reply_at: null, ...extra,
});
const session = (id, exchanges, extra = {}) => ({ id, exchanges, ...extra });
const keys = (hits) => hits.map((h) => h.key);

test('folding keeps one character for one character, so offsets stay offsets', () => {
  const { fold } = load();
  for (const text of ['Plain TEXT', 'It\u2019s \u201cquoted\u201d \u2018too\u2019', 'a\u2010b\u2011c\u2012d\u2013e\u2014f\u2015g\u2212h', 'dotted \u0130stanbul', 'non\u00a0breaking', 'astral \u{1D400} done']) {
    assert.equal(fold(text).length, text.length, text);
  }
  assert.equal(fold('It\u2019s \u201cQuoted\u201d'), 'it\'s "quoted"');
  assert.equal(fold('a\u2013b\u2014c\u2212d'), 'a-b-c-d');
  assert.equal(fold('A\u00a0B'), 'a b');
  // The two-character lowercase of a capital I with a dot stays as it was.
  assert.equal(fold('\u0130x').length, 2);
});

test('a query is words and "quoted phrases", folded, with two characters of searching the least', () => {
  const { parse } = load();
  deepEqual(parse('Merge Request').terms, ['merge', 'request']);
  deepEqual(parse('the "exact   phrase" here').terms, ['the', 'exact phrase', 'here']);
  deepEqual(parse('say "unclosed quote').terms, ['say', 'unclosed quote'], 'an unclosed quote runs to the end');
  deepEqual(parse('"" ""').terms, [], 'an empty phrase is nothing');
  deepEqual(parse('it\u2019s \u201cfolded\u201d').terms, ['it\'s', 'folded']);
  deepEqual(parse('fm/branch-name c7639c').terms, ['fm/branch-name', 'c7639c'], 'identifiers stay as typed');
  assert.equal(parse('').ok, false);
  assert.equal(parse('   ').ok, false);
  assert.equal(parse('a').ok, false);
  assert.equal(parse('ab').ok, true);
  assert.equal(parse('a b').ok, true, 'two words are two characters of searching');
});

test('a reply is matched on what the page draws: markers gone, a link as label and address, code as written', () => {
  const { plainMarkdown, parse, search } = load();
  assert.equal(plainMarkdown('the **deploy** step'), 'the deploy step');
  assert.equal(plainMarkdown('run `npm test` now'), 'run npm test now');
  assert.equal(plainMarkdown('see [the docs](https://example.test/a_b) for more'), 'see the docs https://example.test/a_b for more');
  assert.equal(plainMarkdown('# Heading ##\n\n- item one\n* item two\n> quoted line'), 'Heading item one item two quoted line');
  assert.equal(plainMarkdown('| Name | Value |\n|---|---|\n| widget | 42 |'), 'Name Value widget 42');
  assert.equal(plainMarkdown('a *slanted* word and snake_case_name'), 'a slanted word and snake_case_name');
  // Fenced code is as written: its markers and pipes stay, its fence lines go.
  assert.equal(plainMarkdown('before\n```bash\nls **/*.js | wc\n```\nafter'), 'before ls **/*.js | wc after');
  // A code span keeps what is inside it.
  assert.equal(plainMarkdown('use `**/*.md` globs'), 'use **/*.md globs');
  assert.equal(plainMarkdown('C# and issue #12'), 'C# and issue #12', 'a trailing # outside a heading stays');
  assert.equal(plainMarkdown('first\n\n\n   second   line  '), 'first second line');
  // A phrase across a bold boundary matches, and the words are found in the marker-free copy.
  const finder = load();
  const s = session('s1', [turn({ reply: 'Then the **deploy** step runs.', reply_words: 5, verdict: 'no-action' })]);
  assert.equal(finder.search([s], parse('"the deploy step"').terms, 'any', 'here').length, 1);
});

test('search reads the markers the page now draws: bold around code, __bold__, ~~strike~~, an escape, a line break', () => {
  const { plainMarkdown, parse, search } = load();
  assert.equal(plainMarkdown('**`code` in bold** and __under__ and ~~gone~~'), 'code in bold and under and gone');
  assert.equal(plainMarkdown('**a * b** and \\*escaped\\*'), 'a * b and *escaped*');
  assert.equal(plainMarkdown('**bold that spans\ntwo lines** after'), 'bold that spans two lines after');
  assert.equal(plainMarkdown('- [ ] open task\n- [x] done task'), 'open task done task');
  assert.equal(plainMarkdown('| a |\n|:-:|\n| x<br>y |'), 'a x y');
  const finder = load();
  const s = session('s1', [turn({ reply: 'Run **`npm test` first**, then __ship it__.', reply_words: 7, verdict: 'no-action' })]);
  assert.equal(finder.search([s], parse('"npm test first, then ship it"').terms, 'any', 'here').length, 1);
  assert.equal(finder.search([s], parse('**').terms, 'any', 'here').length, 0, 'the markers are not words the page shows');
  assert.equal(finder.search([s], parse('__ship').terms, 'any', 'here').length, 0);
});

test('the field builder: a doorbell searches what it delivered, a wake-up its reply, notes are their own part, dividers are skipped', () => {
  const finder = load();
  const exchanges = [
    turn({ source: 'session', kind: 'cleared', label: 'Cleared', input: 'divider words alpha' }),
    turn({ source: 'firstmate', kind: 'steer', label: 'Firstmate: instruction', input: 'Firstmate: list the inbox pointerline', delivered: ['the delivered instruction about beta', 'and a second one'] }),
    turn({ source: 'firstmate', kind: 'steer', label: 'Firstmate: instruction', input: 'Firstmate: ring again pointerline', delivered: [], repeat: true }),
    turn({ source: 'firstmate', kind: 'steer', label: 'Firstmate: instruction', input: 'Firstmate: lost pointerline', delivered: [], undelivered: true }),
    turn({ source: 'wake', kind: 'check', label: 'Check: queue', input: '<task-notification> noticeword', reply: 'The wake-up reply about gamma.', folded: true }),
    turn({ source: 'captain', input: 'my question about delta', reply: 'the answer about epsilon', narration: ['working note one zeta', 'working note two'], narration_words: 7, reply_at: 130 }),
  ];
  const fields = finder.fieldsOf(session('s1', exchanges));
  const find = (word) => fields.filter((f) => f.low.includes(word)).map((f) => `${f.i}:${f.part}`);
  deepEqual(find('alpha'), [], 'a divider holds no words');
  deepEqual(find('beta'), ['1:in']);
  deepEqual(find('pointerline'), ['3:in'], 'only the instruction that was not found keeps its pointer line');
  deepEqual(find('noticeword'), [], 'a wake-up\'s own notice is not a message');
  deepEqual(find('gamma'), ['4:reply']);
  deepEqual(find('delta'), ['5:in']);
  deepEqual(find('epsilon'), ['5:reply']);
  deepEqual(find('zeta'), ['5:notes'], 'working notes are a part of their own');
  const wake = fields.find((f) => f.i === 4);
  assert.equal(wake.folded, true);
  assert.equal(wake.label, 'Wake-up reply');
  assert.equal(fields.find((f) => f.i === 5 && f.part === 'notes').label, 'Working notes');
  assert.equal(fields.find((f) => f.i === 5 && f.part === 'in').label, 'You');
  assert.equal(fields.find((f) => f.i === 1).label, 'Firstmate: instruction');
  // The newest turn's reply was written later than its message.
  assert.equal(fields.find((f) => f.i === 5 && f.part === 'reply').at, 130);
});

test('every word must be in the same part: a word in the message and another in its reply do not match', () => {
  const finder = load();
  const s = session('s1', [
    turn({ input: 'only the apple here', reply: 'only the banana here' }),
    turn({ input: 'apple and banana together', reply: 'nothing' }),
    turn({ input: 'plain', reply: 'banana then apple', narration: ['apple note'] }),
  ]);
  const hits = finder.search([s], finder.parse('apple banana').terms, 'any', 'here');
  deepEqual(hits.map((h) => `${h.field.i}:${h.field.part}`), ['1:in', '2:reply']);
  assert.equal(finder.search([s], finder.parse('apple').terms, 'any', 'here').length, 4, 'one word: the message, the other message, the reply and the note');
  // Matching is case-insensitive and a substring, so a prefix finds the word and its forms.
  assert.equal(finder.search([s], finder.parse('APPL').terms, 'any', 'here').length, 4);
  // A quoted phrase stays together.
  assert.equal(finder.search([s], finder.parse('"banana then apple"').terms, 'any', 'here').length, 1);
  assert.equal(finder.search([s], finder.parse('"apple banana"').terms, 'any', 'here').length, 0);
});

test('the Needs you filter finds only the asks still open', () => {
  const finder = load();
  const s = session('s1', [
    turn({ input: 'one', reply: 'kilo should I merge it?', verdict: 'needs-you', ask_state: 'quiet' }),
    turn({ input: 'two', reply: 'kilo which account?', verdict: 'needs-you', ask_state: 'settled' }),
    turn({ input: 'three', reply: 'kilo shall I land it?', verdict: 'needs-you', ask_state: 'open' }),
    turn({ input: 'four', reply: 'kilo any pick?', verdict: 'needs-you' }),
  ]);
  const terms = finder.parse('kilo').terms;
  deepEqual(finder.search([s], terms, 'needs', 'here').map((h) => h.field.i), [2, 3], 'an ask with no state (an older copy) is open');
  deepEqual(finder.search([s], terms, 'replies', 'here').map((h) => h.field.i), [0, 1, 2, 3], 'the others stay searchable as replies');
});

test('each Who filter', () => {
  const finder = load();
  const s = session('s1', [
    turn({ input: 'zulu from you', reply: 'zulu reply, no ask', verdict: 'no-action' }),
    turn({ source: 'firstmate', kind: 'steer', label: 'Firstmate: instruction', input: 'zulu instruction' }),
    turn({ source: 'peer', kind: 'message', label: 'From other', input: 'zulu peer note' }),
    turn({ input: 'plain', reply: 'zulu should I merge it?', verdict: 'needs-you', narration: ['zulu working note'] }),
  ]);
  const terms = finder.parse('zulu').terms;
  const who = (name) => finder.search([s], terms, name, 'here').map((h) => `${h.field.i}:${h.field.part}`);
  deepEqual(who('any'), ['0:in', '0:reply', '1:in', '2:in', '3:reply', '3:notes']);
  deepEqual(who('you'), ['0:in']);
  deepEqual(who('replies'), ['0:reply', '3:reply', '3:notes'], 'replies and the working notes are the agent\'s words');
  deepEqual(who('needs'), ['3:reply']);
  deepEqual(who('firstmate'), ['1:in']);
  deepEqual(finder.filters.sort(), ['any', 'failed', 'firstmate', 'needs', 'replies', 'tools', 'you']);
  assert.equal(finder.search([s], terms, 'nobody', 'here').length, 6, 'an unknown filter is Anyone');
});

test('ordering: this conversation in reading order; all of them with the newest match\'s conversation first, newest first inside', () => {
  const finder = load();
  const older = session('old', [turn({ input: 'kilo one', at: 100 }), turn({ input: 'kilo two', at: 200 })]);
  const newer = session('new', [turn({ input: 'kilo three', at: 150 }), turn({ input: 'kilo four', at: 400, reply: 'kilo reply', reply_at: 420 })]);
  deepEqual(finder.search([newer], ['kilo'], 'any', 'here').map((h) => `${h.field.i}:${h.field.part}`), ['0:in', '1:in', '1:reply']);
  const all = finder.search([older, newer], ['kilo'], 'any', 'all').map((h) => `${h.conv}:${h.field.i}:${h.field.part}`);
  deepEqual(all, ['new:1:reply', 'new:1:in', 'new:0:in', 'old:1:in', 'old:0:in']);
  // The list a conversation was in first does not matter.
  deepEqual(finder.search([newer, older], ['kilo'], 'any', 'all').map((h) => h.conv), ['new', 'new', 'new', 'old', 'old']);
  // Turns with no time sort by position.
  const bare = session('bare', [turn({ input: 'kilo a', at: null }), turn({ input: 'kilo b', at: null })]);
  deepEqual(finder.search([bare], ['kilo'], 'any', 'all').map((h) => h.field.i), [1, 0]);
});

test('a match is named like a pin, by the turn\'s id, and keeps its name when turns above it shift the numbers', () => {
  const finder = load();
  const a = turn({ uid: 'uid-aaaaaaaa', input: 'lima first', reply: 'lima reply' });
  const b = turn({ uid: 'uid-bbbbbbbb', input: 'lima second' });
  const before = finder.search([session('s1', [a, b])], ['lima'], 'any', 'here');
  deepEqual(keys(before), ['uid-aaaaaaaa:in', 'uid-aaaaaaaa:reply', 'uid-bbbbbbbb:in']);
  // A /clear joins earlier turns above: the same turns, now further down.
  const joined = [turn({ source: 'session', kind: 'cleared', label: 'Cleared' }), turn({ uid: 'uid-cccccccc', input: 'earlier lima' }), a, b];
  const after = finder.search([session('s2', joined)], ['lima'], 'any', 'here');
  deepEqual(keys(after), ['uid-cccccccc:in', 'uid-aaaaaaaa:in', 'uid-aaaaaaaa:reply', 'uid-bbbbbbbb:in']);
  deepEqual(after.map((h) => h.field.i), [1, 2, 2, 3]);
  // A page built before turns had ids still names them, by position.
  deepEqual(keys(finder.search([session('s3', [turn({ input: 'lima' })])], ['lima'], 'any', 'here')), ['n0:in']);
});

test('the cache folds again only a conversation that gained a turn, whose words grew or whose stamp changed', () => {
  const finder = load();
  const make = (extra = {}) => [turn({ uid: 'u1', input: 'mike one', reply: 'reply one', reply_words: 2 }), turn({ uid: 'u2', input: 'mike two', reply: 'reply two', reply_words: 2, ...extra })];
  const sessions = () => [session('s1', make()), session('s2', [turn({ uid: 'u9', input: 'mike other' })])];
  finder.search(sessions(), ['mike'], 'any', 'all');
  assert.equal(finder.stats.builds, 2, 'both conversations are folded on the first search');
  // A rebuild of the page brings every conversation again as new objects with the same turns: nothing is folded again.
  finder.search(sessions(), ['mike'], 'any', 'all');
  assert.equal(finder.stats.builds, 2);
  // One conversation gains a turn.
  const grown = [session('s1', [...make(), turn({ uid: 'u3', input: 'mike three' })]), session('s2', [turn({ uid: 'u9', input: 'mike other' })])];
  finder.search(grown, ['mike'], 'any', 'all');
  assert.equal(finder.stats.builds, 3, 'only the conversation that gained a turn');
  // The last reply grows while the agent writes.
  const longer = [session('s1', [...make(), turn({ uid: 'u3', input: 'mike three', reply: 'a reply that grew', reply_words: 4 })]), grown[1]];
  finder.search(longer, ['mike'], 'any', 'all');
  assert.equal(finder.stats.builds, 4, 'only the conversation whose last reply grew');
  deepEqual(keys(finder.search(longer, ['grew'], 'any', 'all')), ['u3:reply']);
  // The hosted copy's stamp changes when the laptop rebuilt the conversation.
  finder.search([session('s1', longer[0].exchanges, { stamp: 'v2' }), longer[1]], ['mike'], 'any', 'all');
  assert.equal(finder.stats.builds, 5);
  // A conversation not loaded yet holds no turns.
  deepEqual(finder.search([session('s5', null)], ['mike'], 'any', 'here'), []);
  assert.equal(finder.stats.builds, 5);
});

test('a conversation that left the list is dropped from the cache when every conversation is searched', () => {
  const finder = load();
  finder.search([session('a', [turn({ input: 'november' })]), session('b', [turn({ input: 'november' })])], ['november'], 'any', 'all');
  assert.equal(finder.stats.builds, 2);
  finder.search([session('a', [turn({ input: 'november' })])], ['november'], 'any', 'all');
  assert.equal(finder.stats.builds, 2, 'a is kept');
  finder.search([session('a', [turn({ input: 'november' })]), session('b', [turn({ input: 'november' })])], ['november'], 'any', 'all');
  assert.equal(finder.stats.builds, 3, 'b was dropped, so it is folded again');
});

test('the occurrences in a part are counted over every word', () => {
  const { occurrences } = load();
  assert.equal(occurrences('one two one two one', ['one']), 3);
  assert.equal(occurrences('one two one two one', ['one', 'two']), 5);
  assert.equal(occurrences('aaaa', ['aa']), 2, 'occurrences do not overlap');
  assert.equal(occurrences('nothing', ['zz']), 0);
});

test('a snippet is built from the text as drawn, with every word marked and the cut ends said', () => {
  const finder = load();
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const s = session('s1', [turn({ input: `${words} NEEDLE and another needle after ${words}` })]);
  const [hit] = finder.search([s], ['needle'], 'any', 'here');
  const { pieces, cut } = finder.snippet(hit.field, ['needle']);
  const text = pieces.map((p) => p.text).join('');
  deepEqual(cut, { before: true, after: true });
  deepEqual(pieces.filter((p) => p.hit).map((p) => p.text), ['NEEDLE', 'needle'], 'the words keep their case in the text');
  assert.ok(text.length <= 50 + 110 + 20, `about 160 characters, not ${text.length}`);
  assert.ok(text.indexOf('NEEDLE') < 60, 'about 50 characters of lead-in');
  assert.ok(!/^\s/.test(text) && !/^ord/.test(text), 'not cut inside a word');
  // A short text is whole, with nothing cut.
  const short = finder.search([session('s2', [turn({ input: 'a short needle line' })])], ['needle'], 'any', 'here')[0];
  deepEqual(finder.snippet(short.field, ['needle']), { pieces: [{ text: 'a short ', hit: false }, { text: 'needle', hit: true }, { text: ' line', hit: false }], cut: { before: false, after: false } });
  // Markup in a message stays text: pieces are strings for text nodes, never markup.
  const odd = finder.search([session('s3', [turn({ input: 'a <b>needle</b> & more' })])], ['needle'], 'any', 'here')[0];
  assert.equal(finder.snippet(odd.field, ['needle']).pieces.map((p) => p.text).join(''), 'a <b>needle</b> & more');
  // A reply's snippet reads without its markers.
  const md = finder.search([session('s4', [turn({ reply: 'the **needle** in `code`', reply_words: 4 })])], ['needle'], 'any', 'here')[0];
  assert.equal(finder.snippet(md.field, ['needle']).pieces.map((p) => p.text).join(''), 'the needle in code');
});

test('spans find the words over several text nodes, without touching them', () => {
  const { spans } = load();
  const nodes = ['The plan: ', 'deploy', ' then verify', 'the second line'];
  const pieces = [{ text: nodes[0], gap: false }, { text: nodes[1], gap: false }, { text: nodes[2], gap: false }, { text: nodes[3], gap: true }];
  // A word inside one node.
  deepEqual(spans(pieces, ['plan']).map((s) => [s.from.piece, s.from.offset, s.to.piece, s.to.offset]), [[0, 4, 0, 8]]);
  // A word that is a whole node, found by its case-folded form.
  deepEqual(spans(pieces, ['deploy']).map((s) => [s.from.piece, s.from.offset, s.to.piece, s.to.offset]), [[1, 0, 1, 6]]);
  // A phrase across a bold boundary: "plan: deploy then" spans three nodes.
  deepEqual(spans(pieces, ['plan: deploy then']).map((s) => [s.from.piece, s.from.offset, s.to.piece, s.to.offset]), [[0, 4, 2, 5]]);
  // A block end between nodes stands for a space.
  deepEqual(spans(pieces, ['verify the second']).map((s) => [s.from.piece, s.from.offset, s.to.piece, s.to.offset]), [[2, 6, 3, 10]]);
  // Without a block end there is no space: words of two nodes joined by nothing do not match across it.
  deepEqual(spans([{ text: 'foo', gap: false }, { text: 'bar', gap: false }], ['foo bar']), []);
  deepEqual(spans([{ text: 'foo', gap: false }, { text: 'bar', gap: false }], ['foobar']).length, 1);
  // Every word of the query, each occurrence, case-insensitively; characters a pattern would read stay literal.
  const ids = [{ text: 'Branch fm/Reader-Search.1 and fm/reader-search.1 (again) [x]', gap: false }];
  assert.equal(spans(ids, ['fm/reader-search.1']).length, 2);
  assert.equal(spans(ids, ['(again)']).length, 1);
  assert.equal(spans(ids, ['[x]']).length, 1);
  assert.equal(spans(ids, ['fm/reader-searchx1']).length, 0, 'a dot is a dot');
  assert.equal(spans(ids, ['branch', 'again']).length, 2);
});

test('the matching has no way out of the page', () => {
  assert.ok(!/\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|\bimport\b|\beval\b|new Function|innerHTML|document\./.test(SOURCE.replace(/\/\/.*$/gm, '')), 'find.js reads no page and writes none: it only holds functions over turns');
});

// ------------------------------------------------------------------------------------------------------------ tool steps
// A turn's steps are a part of it ("steps"): what each says it did, its file and the first 100 characters of its command.

const step = (extra) => ({ k: 'ran', n: 'Bash', s: 'Run the tests', at: 100, o: 0, ...extra });

test('a command or a path that appears only in a step is found, as the Tools part of its turn', () => {
  const finder = load();
  const s = session('a', [
    turn({ uid: 'u1', input: 'Run everything', reply: 'Done.', steps: [step({ c: 'pytest tests/billing/test_invoice.py -q', p: undefined }), step({ k: 'read', s: '\u2026/config/settings.toml', p: '/work/app/config/settings.toml' })] }),
  ]);
  const byCommand = finder.search([s], ['test_invoice'], 'any', 'here');
  deepEqual(keys(byCommand), ['u1:steps']);
  assert.equal(byCommand[0].field.label, 'Tool steps');
  const byPath = finder.search([s], ['/work/app/config'], 'any', 'here');
  deepEqual(keys(byPath), ['u1:steps'], 'the whole path, though the row shows its end');
  deepEqual(keys(finder.search([s], ['run the tests'], 'any', 'here')), ['u1:steps'], 'the summary');
  deepEqual(keys(finder.search([s], ['nothing like it'], 'any', 'here')), []);
  // The snippet is cut from the same text.
  const { pieces } = finder.snippet(byCommand[0].field, ['test_invoice']);
  assert.equal(pieces.filter((p) => p.hit).map((p) => p.text).join(''), 'test_invoice');
});

test('only the start of a command is searched: the rest of it stays with the laptop', () => {
  const finder = load();
  const s = session('a', [turn({ uid: 'u1', steps: [step({ c: 'echo ' + 'x'.repeat(120) + ' needle-after-the-cut' })] })]);
  deepEqual(keys(finder.search([s], ['needle-after-the-cut'], 'any', 'here')), []);
  deepEqual(keys(finder.search([s], ['echo'], 'any', 'here')), ['u1:steps']);
});

test('the Tools chip reads the steps alone, Replies leaves them out, and Anyone reads everything', () => {
  const finder = load();
  const s = session('a', [turn({ uid: 'u1', input: 'deploy the app', reply: 'The deploy is done.', narration: ['starting the deploy'], narration_words: 3, steps: [step({ s: 'Run the deploy script' })] })]);
  deepEqual(keys(finder.search([s], ['deploy'], 'any', 'here')).sort(), ['u1:in', 'u1:notes', 'u1:reply', 'u1:steps']);
  deepEqual(keys(finder.search([s], ['deploy'], 'tools', 'here')), ['u1:steps']);
  deepEqual(keys(finder.search([s], ['deploy'], 'replies', 'here')).sort(), ['u1:notes', 'u1:reply']);
  deepEqual(keys(finder.search([s], ['deploy'], 'you', 'here')), ['u1:in']);
  assert.ok(finder.filters.includes('tools') && finder.filters.includes('failed'));
});

test('the Failed chip finds only the failed steps: a word in a step that worked does not count', () => {
  const finder = load();
  const s = session('a', [
    turn({ uid: 'u1', steps: [step({ s: 'Run the billing tests', f: 1 }), step({ s: 'List the folder' })] }),
    turn({ uid: 'u2', steps: [step({ s: 'Run the billing tests' }), step({ s: 'Run the export check', f: 1 })] }),
    turn({ uid: 'u3', steps: [step({ s: 'Run the billing tests' })] }),
  ]);
  deepEqual(keys(finder.search([s], ['billing'], 'failed', 'here')), ['u1:steps'], 'u2 failed on another step; u3 did not fail');
  deepEqual(keys(finder.search([s], ['billing'], 'tools', 'here')), ['u1:steps', 'u2:steps', 'u3:steps']);
  deepEqual(keys(finder.search([s], ['export'], 'failed', 'here')), ['u2:steps']);
  deepEqual(keys(finder.search([s], ['list the folder'], 'failed', 'here')), [], 'it worked');
  assert.equal(finder.search([s], ['billing'], 'failed', 'here')[0].count, 1, 'occurrences are counted in the failed steps\' words');
});

test('a turn that gains steps is searched again, and in a tie of time the steps are listed first', () => {
  const finder = load();
  const first = session('a', [turn({ uid: 'u1', reply: 'ok', reply_words: 1 })], { stamp: 's' });
  deepEqual(keys(finder.search([first], ['tests'], 'any', 'here')), []);
  const grown = session('a', [turn({ uid: 'u1', reply: 'ok', reply_words: 1, steps: [step()] })], { stamp: 's' });
  deepEqual(keys(finder.search([grown], ['tests'], 'any', 'here')), ['u1:steps']);
  const tie = session('b', [turn({ uid: 't1', at: 50, reply_at: 60, narration: ['run the tests'], narration_words: 3, reply: 'tests', reply_words: 1, steps: [step()] })]);
  deepEqual(keys(finder.search([tie], ['tests'], 'any', 'all')), ['t1:steps', 't1:notes', 't1:reply'], 'one moment, three parts: the steps, then the notes, then the reply');
});

test('a turn from a copy built before steps were kept has none, and finds as it did', () => {
  const finder = load();
  const s = session('a', [turn({ uid: 'u1', reply: 'tests pass', reply_words: 2, tools: 4 })]);
  deepEqual(keys(finder.search([s], ['tests'], 'any', 'here')), ['u1:reply']);
  deepEqual(keys(finder.search([s], ['tests'], 'tools', 'here')), []);
});
