'use strict';

// Tests for the embed page: the page a host's web view (Conn's, for a ShopBack Campus conversation) loads and feeds through window.readerEmbed
// (README.md, "The embed page"). Run from the repo root:
//   node --test setup/transcript-reader/embed.test.js
// Two parts. prototype/embed.js (how a host's JSON is read and turned into the reader's turns) runs in a bare sandbox, as steps.test.js runs steps.js.
// The page's own rules (what it keeps, reaches and hides) are read from template.html and from the page the build makes, as lite.test.js reads them.
// The page drawn in a real browser is e2e/embed-check.js. Every conversation here is invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const HERE = path.join(__dirname, 'prototype');
const sandbox = vm.runInNewContext(
  fs.readFileSync(path.join(HERE, 'steps.js'), 'utf8') + '\n' + fs.readFileSync(path.join(HERE, 'embed.js'), 'utf8') + '\n({ embedModel, stepsView })',
  { Set, Map, Array, Object, Math, Number, String, JSON, Error, TypeError, SyntaxError, isFinite: Number.isFinite });
const { embedModel: model, stepsView: steps } = sandbox;
const plain = (value) => JSON.parse(JSON.stringify(value));
const FIXTURE = path.join(__dirname, 'embed-fixtures', 'campus-conversation.json');

const user = (id, text, extra = {}) => ({ kind: 'user', id, text, ...extra });
const reply = (id, extra = {}) => ({ kind: 'reply', id, texts: ['An answer.'], tools: [], ...extra });
const tool = (name, argument, extra = {}) => ({ tool: name, argument, output: '', status: 'ok', detail: '', ...extra });

// ---------------------------------------------------------------------------------------------------------------- reading what a host sends

test('parse: a JSON string, an object or a bare array of blocks all read the same', () => {
  const blocks = [user('u1', 'Hello'), reply('r1')];
  const want = plain(model.parse({ blocks }));
  assert.deepEqual(plain(model.parse(JSON.stringify({ blocks }))), want);
  assert.deepEqual(plain(model.parse(blocks)), want);
  assert.deepEqual(want.blocks.map((b) => [b.kind, b.id]), [['user', 'u1'], ['reply', 'r1']]);
  assert.equal(want.skipped, 0);
});

test('parse: text that is not JSON throws, anything else a host might send is read tolerantly', () => {
  assert.throws(() => model.parse('not json'), SyntaxError);
  assert.throws(() => model.parse('7'), TypeError);
  assert.throws(() => model.parse(null), TypeError);
  const got = plain(model.parse({ blocks: [null, 7, 'x', { kind: 'system', id: 's' }, { kind: 'user', id: 'u', text: '   ' }, { kind: 'reply', id: 'r' }, user('ok', 'Kept')] }));
  assert.deepEqual(got.blocks.map((b) => b.id), ['ok'], 'an unknown kind, an empty message and a reply with nothing in it are skipped');
  assert.equal(got.skipped, 6, 'and counted');
  assert.deepEqual(plain(model.parse({})).blocks, [], 'no blocks is no blocks');
});

test('parse: a field of the wrong type is the empty one', () => {
  const [b] = plain(model.parse({ blocks: [{ kind: 'reply', id: 5, at: 'soon', texts: 'oops', text: 'The text field', tools: [7, { tool: 3, argument: null, status: 'weird' }], form: 'no', stopped: 'yes', streaming: 1 }] })).blocks;
  assert.equal(b.id, '5', 'a number is its text');
  assert.equal(b.at, null);
  assert.deepEqual(b.texts, ['The text field'], 'the text of a block with no texts list');
  assert.deepEqual(b.tools, [{ tool: '3', argument: '', output: '', status: 'ok', detail: '' }], 'a tool that is not an object is dropped, an unknown status is ok');
  assert.equal(b.form, null);
  assert.equal(b.stopped, false, 'only true is true');
  assert.equal(b.streaming, false);
});

test('parse: ids are kept, made when missing, and never shared by two blocks', () => {
  const got = plain(model.parse({ blocks: [user('same', 'a'), user('same', 'b'), { kind: 'user', text: 'c' }] })).blocks;
  assert.equal(new Set(got.map((b) => b.id)).size, 3);
  assert.equal(got[0].id, 'same');
  assert.equal(got[2].id, 'user-3', 'from the kind and the place when a host sent none');
});

test('parse: times are seconds, and milliseconds are read as such', () => {
  const [a, b, c, d] = plain(model.parse({ blocks: [user('a', 'x', { at: 1762500000 }), user('b', 'x', { at: 1762500000000 }), user('c', 'x', { at: -5 }), user('d', 'x')] })).blocks;
  assert.deepEqual([a.at, b.at, c.at, d.at], [1762500000, 1762500000, null, null]);
});

test('parse: the live line is the host\'s to change, and a call that does not mention it leaves it alone', () => {
  assert.deepEqual(plain(model.parse({ blocks: [], live: '  reading a.csv ' })), { id: '', live: 'reading a.csv', hasLive: true, blocks: [], skipped: 0 });
  assert.equal(model.parse({ blocks: [] }).hasLive, false);
  assert.equal(model.parse({ blocks: [], live: '' }).hasLive, true, 'an empty line is a line: it takes the strip away');
  assert.equal(model.parse({ id: 'ses_1', blocks: [] }).id, 'ses_1');
});

test('parse: a form needs a question; its options and pick are strings', () => {
  const form = (extra) => plain(model.parse({ blocks: [reply('r', { form: extra })] })).blocks[0].form;
  assert.equal(form({ id: 'f', questions: [] }), null);
  assert.equal(form({ id: 'f', questions: [{ text: '  ' }] }), null);
  assert.deepEqual(form({ id: 'f', questions: [{ text: 'Which?', options: ['a', '', 'b', 7], pick: 'b' }] }),
    { id: 'f', status: 'open', answer: '', questions: [{ text: 'Which?', options: ['a', 'b', '7'], pick: 'b' }] });
  assert.equal(form({ id: 'f', status: 'answered', answer: 'a', questions: [{ text: 'Which?' }] }).status, 'answered');
  assert.equal(form({ id: 'f', status: 'bogus', questions: [{ text: 'Which?' }] }).status, 'open', 'an unknown status is a question still open');
});

test('the fixture a Conn worker can start from reads whole', () => {
  const got = plain(model.parse(fs.readFileSync(FIXTURE, 'utf8')));
  assert.equal(got.skipped, 0);
  assert.deepEqual(got.blocks.map((b) => b.kind), ['user', 'reply', 'user', 'reply']);
  assert.equal(got.id, 'ses_lab_voucher_week_44');
  assert.equal(got.blocks[3].form.status, 'open');
  assert.equal(got.blocks[3].tools.find((t) => t.status === 'failed').tool, 'bash');
});

// ---------------------------------------------------------------------------------------------------------------- update and append

test('upsert: a block with a held id replaces it where it stands, any other goes on the end', () => {
  const held = plain(model.parse({ blocks: [user('u1', 'one'), reply('r1', { texts: ['first'] }), user('u2', 'two')] })).blocks;
  const incoming = plain(model.parse({ blocks: [reply('r1', { texts: ['first, longer'] }), reply('r2', { texts: ['new'] })] })).blocks;
  const merged = model.upsert(held, incoming);
  assert.deepEqual(merged.map((b) => b.id), ['u1', 'r1', 'u2', 'r2']);
  assert.deepEqual(plain(merged[1].texts), ['first, longer']);
  assert.deepEqual(held.map((b) => b.id), ['u1', 'r1', 'u2'], 'what was held is not changed');
  assert.deepEqual(model.upsert(held, []).map((b) => b.id), ['u1', 'r1', 'u2']);
  assert.deepEqual(model.upsert([], incoming).map((b) => b.id), ['r1', 'r2']);
});

test('view: a block that did not change has the same signature, one that did has another', () => {
  const a = model.view(plain(model.parse({ blocks: [user('u', 'x'), reply('r', { texts: ['a'] })] })).blocks);
  const b = model.view(plain(model.parse({ blocks: [user('u', 'x'), reply('r', { texts: ['a b'] })] })).blocks);
  assert.equal(a[0].sig, b[0].sig);
  assert.notEqual(a[1].sig, b[1].sig);
});

// ---------------------------------------------------------------------------------------------------------------- the reader's turns

const turnsOf = (blocks) => plain(model.view(plain(model.parse({ blocks })).blocks));

test('a user block is a message of yours, the way the reader draws one', () => {
  const [row] = turnsOf([user('u1', 'Why did it drop?', { at: 1762500000 })]);
  assert.deepEqual(row.turn, { source: 'captain', kind: 'message', label: 'You', input: 'Why did it drop?', at: 1762500000, absorbed: false, uid: 'u1' });
});

test('a reply block is a reply: its texts joined, its words counted, its tools the steps', () => {
  const [row] = turnsOf([reply('r1', { at: 1762500042, texts: ['## Title', 'Two words'], tools: [tool('read', '/a/b.csv', { output: 'x,y\n1,2\n' }), tool('bash', 'ls -la\nmore', { output: 'file\n' })] })]);
  const t = row.turn;
  assert.equal(t.reply, '## Title\n\nTwo words');
  assert.equal(t.reply_words, 4);
  assert.equal(t.tools, 2);
  assert.equal(t.uid, 'r1');
  assert.deepEqual(plain(steps.summary(t).parts), ['2 steps']);
  assert.deepEqual(Object.keys(row.outputs), ['r1:0', 'r1:1'], 'the keys the step sheet asks for (stepsView.key)');
  assert.equal(steps.key(t, 1), 'r1:1');
  assert.equal(row.outputs['r1:0'], 'x,y\n1,2\n');
});

test('tool names become the reader\'s step kinds, and what a step says comes from its argument', () => {
  const blocks = [reply('r', { tools: [
    tool('read', '/a/b.md'), tool('write', '/a/new.md'), tool('edit', '/a/old.md'), tool('bash', 'git status && git diff\nmore'), tool('grep', 'TODO'),
    tool('webfetch', 'https://example.com'), tool('task', 'review the plan'), tool('skill', 'write-prd'), tool('question', 'which one?'), tool('campus_search', 'x'), tool('', ''),
  ] })];
  const list = turnsOf(blocks)[0].turn.steps;
  assert.deepEqual(list.map((s) => s.k), ['read', 'wrote', 'edited', 'ran', 'searched', 'searched', 'agent', 'skill', 'asked', 'other', 'other']);
  assert.equal(list[0].p, '/a/b.md', 'a file read names its file');
  assert.equal(list[3].s, 'git status && git diff', 'a command says its first line');
  assert.equal(list[3].c, 'git status && git diff\nmore', 'and the sheet shows all of it');
  assert.equal(list[10].s, 'tool', 'a tool with neither name nor argument still has a row');
  assert.equal(steps.summary({ uid: 'r', steps: list }).parts[1], 'edited 2 files', 'a write and an edit are the files changed');
});

test('a tool with a title, an input and formats: the row says the title, the sheet holds the whole input, a JSON output starts at its first line', () => {
  const code = 'const hits = await campus.search({ q: "voucher redemptions", limit: 5 });\nreturn hits.map(h => h.title);';
  const json = '[\n  {\n    "q": "voucher",\n    "hits": 3\n  }\n]';
  const [row] = turnsOf([reply('r', { tools: [tool('execute', 'const hits = ...', { title: 'campus.search', input: code, inputFormat: 'code', output: json, outputFormat: 'json', detail: '1.2s' })] })]);
  const step = row.turn.steps[0];
  assert.equal(step.s, 'campus.search', 'the row says the title, not the first line of the argument');
  assert.equal(step.n, 'execute', 'the tool\'s own name stays for the sheet\'s second line');
  assert.equal(step.k, 'other');
  assert.equal(step.c, code, 'the sheet\'s input is the whole input');
  assert.equal(step.cf, 'code');
  assert.equal(step.of, 'json');
  assert.equal(row.outputs['r:0'], json, 'the whole output is the sheet\'s');
  // A JSON output shows from its first line, any other from its end.
  const first = steps.outputLines(step, 'l1\nl2\nl3\nl4', 2), last = steps.outputLines({}, 'l1\nl2\nl3\nl4', 2);
  assert.deepEqual(plain(first), { text: 'l1\nl2', total: 4, hidden: 2 });
  assert.deepEqual(plain(last), { text: 'l3\nl4', total: 4, hidden: 2 });
  assert.equal(steps.outputLines({ of: 'json' }, 'l1\nl2\nl3', Infinity).hidden, 0, 'Show all N lines shows every line');
});

test('a tool whose input was cut by the host keeps the host\'s own line, and an input over the 6,000 characters is cut by the page', () => {
  const cut = 'x'.repeat(5960) + '\n… 4,031 more characters not shown';
  assert.ok(cut.length <= 6000);
  const step = turnsOf([reply('r', { tools: [tool('execute', 'x', { title: 'campus.run', input: cut, inputFormat: 'text' })] })])[0].turn.steps[0];
  assert.equal(step.c, cut, 'a cut input is shown as the host sent it, ending in its own line');
  assert.ok(step.c.endsWith('… 4,031 more characters not shown'));
  const long = turnsOf([reply('r', { tools: [tool('execute', 'x', { input: 'y'.repeat(9000) })] })])[0].turn.steps[0];
  assert.equal(long.c.length, 6000, 'a host that sent more is cut at 6,000 characters');
  assert.ok(long.c.endsWith('…'));
});

test('a tool without the new fields reads and draws exactly as before, and a format that is not one is dropped', () => {
  const old = model.parse({ blocks: [reply('r', { tools: [tool('bash', 'ls -la\nmore', { output: 'a\nb' })] })] }).blocks[0].tools[0];
  assert.deepEqual(plain(old), { tool: 'bash', argument: 'ls -la\nmore', output: 'a\nb', status: 'ok', detail: '' }, 'no title, input or format keys at all');
  const step = turnsOf([reply('r', { tools: [tool('bash', 'ls -la\nmore', { output: 'a\nb' })] })])[0].turn.steps[0];
  assert.equal(step.s, 'ls -la');
  assert.equal(step.c, 'ls -la\nmore');
  assert.equal(step.cf, undefined);
  assert.equal(step.of, undefined);
  const odd = model.parse({ blocks: [reply('r', { tools: [tool('x', 'a', { inputFormat: 'yaml', outputFormat: 'xml', title: 7, input: null })] })] }).blocks[0].tools[0];
  assert.deepEqual(plain(odd), { tool: 'x', argument: 'a', output: '', status: 'ok', detail: '', title: '7' }, 'only the formats the contract names are kept; a number is its text');
  // A file tool keeps its path even when the host sent an input.
  const file = turnsOf([reply('r', { tools: [tool('read', '/a/b.csv', { input: '{"path":"/a/b.csv"}', inputFormat: 'json' })] })])[0].turn.steps[0];
  assert.equal(file.p, '/a/b.csv');
  assert.equal(file.c, undefined);
});

test('a failed tool is a failed step with the tail of its output; a running or stopped one says so in its line', () => {
  const long = 'x'.repeat(900) + 'THE END';
  const list = turnsOf([reply('r', { tools: [tool('bash', 'psql', { status: 'failed', output: long }), tool('read', '/a', { status: 'running' }), tool('bash', 'sleep 9', { status: 'aborted' })] })])[0].turn.steps;
  assert.equal(list[0].f, 1);
  assert.equal(list[0].t.length, 400);
  assert.ok(list[0].t.endsWith('THE END'));
  assert.equal(list[1].s, '/a (running)');
  assert.equal(list[2].s, 'sleep 9 (stopped)');
  assert.equal(list[1].f, undefined);
  assert.equal(steps.summary({ uid: 'r', steps: list }).text, '3 steps · 1 failed');
});

test('an output the host sent is shown, a file\'s text included, because it came with the turn', () => {
  const step = turnsOf([reply('r', { tools: [tool('read', '/a/b.csv', { output: 'a\nb\n' })] })])[0].turn.steps[0];
  assert.equal(steps.outputPlan(step, { loaded: true, inline: true }).kind, 'show');
  assert.equal(steps.outputPlan(step, { loaded: true }).kind, 'kept', 'the reader\'s own pages still never keep the text of a file the agent read');
  assert.equal(steps.outputPlan(turnsOf([reply('r', { tools: [tool('bash', 'true')] })])[0].turn.steps[0], { loaded: true, inline: true }).kind, 'none', 'no output, nothing to show');
});

test('an open question is a reply that needs you, an answered one a reply you answered, a cancelled one neither', () => {
  const form = (status, extra = {}) => ({ id: 'f', status, questions: [{ text: 'Which?', options: ['a', 'b'] }], ...extra });
  const t = (status) => turnsOf([reply('r', { texts: [], form: form(status) })])[0].turn;
  assert.deepEqual([t('open').verdict, t('open').ask_state], ['needs-you', 'open']);
  assert.deepEqual([t('answered').verdict, t('answered').ask_state], ['needs-you', 'settled']);
  assert.deepEqual([t('cancelled').verdict, t('cancelled').ask_state], ['no-action', undefined]);
  assert.equal(t('open').reply, '', 'a reply of questions alone has no text');
  assert.equal(t('open').form.questions[0].options.length, 2);
  assert.equal(turnsOf([reply('r')])[0].turn.verdict, 'no-action');
});

test('a reply that was stopped, with nothing else, is still a block', () => {
  const rows = turnsOf([user('u', 'go'), { kind: 'reply', id: 'r', texts: [], tools: [], stopped: true }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].turn.stopped, true);
});

test('plain text is the words CampusTimeline.plainText() writes', () => {
  const blocks = plain(model.parse({ blocks: [user('u', 'Hi'), reply('r', { texts: ['Hello', 'there'], tools: [tool('read', 'a'), tool('read', 'b')], form: { id: 'f', questions: [{ text: 'One?' }, { text: 'Two?' }] }, stopped: true })] })).blocks;
  assert.equal(model.plain(blocks), 'You: Hi\n\nCampus: (2 tool steps)\nHello\nthere\nCampus asks: One? Two?\n(stopped)');
  assert.equal(model.plain(plain(model.parse({ blocks: [reply('r', { texts: ['x'], tools: [tool('read', 'a')] })] })).blocks), 'Campus: (1 tool step)\nx');
});

// ---------------------------------------------------------------------------------------------------------------- the page

const PAGE_SOURCE = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
const LIVE_SOURCE = fs.readFileSync(path.join(HERE, 'live.js'), 'utf8');
const built = (() => {
  const done = spawnSync('python3', ['-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import build_prototype as b; sys.stdout.write(b.embed_shell()[0])', HERE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(done.status, 0, done.stderr);
  return done.stdout;
})();

test('page: it keeps nothing, whatever code reaches storage: both stores are memory in embed mode', () => {
  assert.ok(PAGE_SOURCE.includes('const localStorage = EMBED ? memoryStorage() : browserStorage("localStorage");'));
  assert.ok(PAGE_SOURCE.includes('const sessionStorage = EMBED ? memoryStorage() : browserStorage("sessionStorage");'));
  const memory = PAGE_SOURCE.match(/const memoryStorage = .*/)[0];
  const store = vm.runInNewContext(`${memory}; memoryStorage()`, { Map, String });
  store.setItem('a', 1);
  assert.equal(store.getItem('a'), '1');
  assert.equal(store.getItem('missing'), null);
  assert.equal(store.length, 1);
  store.removeItem('a');
  assert.equal(store.getItem('a'), null);
  const first = vm.runInNewContext(`${memory}; [memoryStorage(), memoryStorage()]`, { Map, String });
  first[0].setItem('k', 'v');
  assert.equal(first[1].getItem('k'), null, 'one store each: the two do not share');
});

test('page: it reaches no server, whatever address it is opened from, and its content policy allows no connection at all', () => {
  assert.ok(LIVE_SOURCE.includes('const embedded = typeof MODE === "string" && MODE === "embed";'));
  assert.ok(LIVE_SOURCE.includes('const served = !embedded && '));
  const policy = built.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
  for (const rule of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "img-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(policy.includes(rule), rule);
  assert.match(policy, /script-src 'sha256-[A-Za-z0-9+/=]+'/, 'its own script only, by hash');
  assert.equal(built.includes('<meta name="reader-token"'), false);
  assert.equal(built.includes('/*__'), false, 'no slot left');
  assert.ok(built.includes('const MODE = "embed";'));
  assert.equal(/<(?:link|img|iframe|script)\s[^>]*(?:src|href)=/i.test(built), false, 'nothing is loaded from anywhere');
});

test('page: the reader\'s own functions draw the turns, and the reader\'s controls are there only when the host asked for the composer', () => {
  const run = PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('function embedPaint('), PAGE_SOURCE.indexOf('function startEmbed()'));
  assert.ok(/inputBlock\(row\.turn, row\.id, key, sid\)/.test(run) && /replyCard\(row\.turn, key, sid\)/.test(run), 'inputBlock and replyCard, the code that draws a Claude or Codex conversation');
  assert.ok(PAGE_SOURCE.includes('const pinKey = (ex, part) => ex.uid && !EMBED ?'), 'no pin or hide button without a key');
  assert.ok(PAGE_SOURCE.includes('if (sid && ex.reply && (!EMBED || embedHost)) {'), 'a Reply button only with the composer');
  assert.ok(PAGE_SOURCE.includes('node.ask.hidden = !sid || (EMBED && !embedHost);'), '"Ask about this" on a step only with the composer');
  assert.ok(PAGE_SOURCE.includes('const dockSession = () => EMBED && !embedHost ? null :'), 'no message bar without the composer');
  assert.ok(PAGE_SOURCE.includes('if (EMBED) state.copySelection = false;'));
  assert.ok(PAGE_SOURCE.includes('if (!EMBED) window.addEventListener("hashchange", followAddress);'));
  assert.ok(PAGE_SOURCE.includes('if (!EMBED) window.addEventListener("pagehide", () => {'));
  assert.ok(PAGE_SOURCE.includes('if (EMBED) startEmbed();\n  else if (!LAZY) openReading(chooseOpening());'), 'the reading list is never opened');
  assert.match(PAGE_SOURCE, /body\.embed #bar, body\.embed \.copy-note, body\.embed #new-reply \{ display: none !important; \}/);
  assert.match(PAGE_SOURCE, /body\.embed:not\(\.embed-composer\) #dock, body\.embed:not\(\.embed-composer\) \.float-comment \{ display: none !important; \}/, 'the bar and "Comment on this" are hidden until the composer is on');
  assert.match(PAGE_SOURCE, /body\.embed #dock-photo, body\.embed #dock-thumbs \{ display: none !important; \}/, 'no photos in the embed page');
});

test('page: the entry point is window.readerEmbed with the calls the README names', () => {
  const entry = PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('window.readerEmbed = Object.freeze({'), PAGE_SOURCE.indexOf('tell({ type: "ready"'));
  for (const name of ['version:', 'set:', 'upsert:', 'live:', 'clear:', 'plainText:', 'composer, sent, composerState']) assert.ok(entry.includes(name), name);
  assert.ok(PAGE_SOURCE.includes('tell({ type: "ready", version: embedModel.VERSION });'));
  assert.ok(PAGE_SOURCE.includes('if (!tell({ type: "link", url })) window.open(url, "_blank", "noopener");'), 'a web address never takes the view away');
});

test('page: the contract in the README names every call and field the page has', () => {
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## The embed page'));
  assert.ok(section.length > 500, 'the README has the section');
  for (const word of ['window.readerEmbed', 'readerEmbed.set', 'readerEmbed.upsert', 'readerEmbed.live', 'readerEmbed.clear', 'readerEmbed.plainText', 'out/live/embed.html',
    '"kind": "user"', '"kind": "reply"', 'texts', 'tools', 'form', 'stopped', 'streaming', 'status', 'questions', 'options', 'pick', 'answer', 'messageHandlers.readerEmbed', '"type": "link"', '"type": "ready"', 'readerEmbed.composer', 'readerEmbed.sent', 'readerEmbed.composerState', '"type": "send"', 'inputFormat', 'outputFormat', 'more characters not shown', 'The composer']) {
    assert.ok(section.includes(word), `README, "The embed page", names ${word}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------- the composer

test('composer: null, false, undefined and { off: true } are no bar; an object is a bar with the name, send and reason read tolerantly', () => {
  for (const off of [null, false, undefined, { off: true }, 'null', 'false', '{"off":true}']) assert.equal(model.composer(off), null, String(off));
  assert.deepEqual(plain(model.composer({})), { name: 'Campus', send: true, reason: '' }, 'the defaults');
  assert.deepEqual(plain(model.composer({ name: '  Monthly review ', send: true })), { name: 'Monthly review', send: true, reason: '' });
  assert.deepEqual(plain(model.composer('{"name":"Q3 plan","send":false,"reason":"Sign in to Campus to send."}')), { name: 'Q3 plan', send: false, reason: 'Sign in to Campus to send.' });
  assert.equal(model.composer({ send: 0 }).send, true, 'only false turns Send off');
  assert.equal(model.composer({ name: 'x'.repeat(200) }).name.length <= 60, true, 'a name is clipped');
  assert.equal(model.composer({ name: {}, reason: [] }).name, 'Campus', 'a field of the wrong type is the empty one');
});

test('composer: what is not a config throws, so a host sees its mistake', () => {
  assert.throws(() => model.composer('not json'), SyntaxError);
  assert.throws(() => model.composer(3), TypeError);
  assert.throws(() => model.composer([1]), TypeError);
  assert.throws(() => model.composer(true), TypeError);
});

test('composer page: a send goes to the host as { type: send, id, conversation, text, comments }, and only the host\'s answer ends it', () => {
  assert.ok(PAGE_SOURCE.includes('tell({ type: "send", id, conversation: embed.conv || "", text, comments })'), 'the message the README names');
  assert.ok(PAGE_SOURCE.includes('const EMBED_ANSWER_MS = 60000;'), 'a host that never answers is a failure after 60 seconds');
  assert.ok(/No host is listening, so nothing was sent\./.test(PAGE_SOURCE), 'a host that is not listening fails at once, in words');
  assert.ok(/may or may not have gone/.test(PAGE_SOURCE), 'and one that does not answer says the message may have gone');
  assert.ok(PAGE_SOURCE.includes('EMBED ? await embedSend('), 'the embed page never calls the server or the queue');
  assert.ok(PAGE_SOURCE.includes('body.embed-composer .embed-live { bottom: var(--dock-h, 0px); }'), 'the working strip sits over the bar');
});

test('composer page: the bar keeps nothing and reaches nothing: the draft and the batch go to memory, and no network call is on its path', () => {
  const send = PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('function embedSend('), PAGE_SOURCE.indexOf('const embedBottom'));
  assert.equal(/fetch\(|XMLHttpRequest|live\.send|hosted\.|localStorage|sessionStorage/.test(send), false, 'embedSend only tells the host');
  assert.ok(PAGE_SOURCE.includes('const embedded = typeof MODE === "string" && MODE === "embed";') || LIVE_SOURCE.includes('const embedded = typeof MODE === "string" && MODE === "embed";'));
});

test('composer page: the page\'s composer contract in the README matches the config the page reads', () => {
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('### The composer (opt-in)'), readme.indexOf('### What the page does with them'));
  for (const word of ['`name`', '`send`', '`reason`', 'Comment on this', 'Reply', 'Ask about this', 'Clear all', 'Exact text', 'Undo', 'Now', '5 seconds', '`/clear`', '4,000', 'sent({ id, ok: true })', 'sent({ id, ok: false, error })', '60 seconds', 'No host is listening', 'e2e/embed-check.js']) {
    assert.ok(section.includes(word), `the composer section names ${word}`);
  }
});

test('reply turn: every reply card carries its turn id as data-turn, before anything pin- or embed-specific, and the pin key stays data-msg', () => {
  const card = PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('function replyCard('), PAGE_SOURCE.indexOf('const fix = sheetFixOffered('));
  const turn = card.indexOf('if (ex.uid) card.dataset.turn = ex.uid;');
  assert.ok(turn > 0, 'the card gets data-turn from the turn\'s id');
  assert.ok(turn < card.indexOf('if (sid && ex.reply && (!EMBED || embedHost))'), 'it is set for every card, not only where a pin is drawn (the embed page has no pin key)');
  assert.ok(card.includes('card.dataset.msg = pinKey(ex, "reply");'), 'data-msg is the pin key, as it was');
  assert.equal(/dataset\.turn/.test(PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('function inputBlock('), PAGE_SOURCE.indexOf('function inputBlock(') + 3000)), false, 'a message of the captain\'s carries no data-turn');
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## A reply card names its turn'), readme.indexOf('## Markdown files open in an editor'));
  for (const word of ['`data-turn`', '`.reply[data-turn]`', '`data-msg` is unchanged', 'full reader page, the lite page and the embed page']) assert.ok(section.includes(word), `the README section names ${word}`);
});
