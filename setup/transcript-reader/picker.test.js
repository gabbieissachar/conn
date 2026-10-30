'use strict';

// Tests for the page's session picker rules (prototype/picker.js). Run from the repo root:
//   node --test setup/transcript-reader/picker.test.js
// The file runs in a bare sandbox: its functions take the list and say which sessions run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const picker = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'picker.js'), 'utf8') + '\npicker', { Boolean });

const session = (id, label, extra = {}) => ({ id, pane: label === null ? null : { label, title: 'a title for ' + id }, ...extra });
const titled = (s) => `${s.pane ? s.pane.label : 'no pane'} · ${s.pane ? s.pane.title : s.id}`;
const ids = (entries) => entries.map(([s]) => s.id);

test('sections: a session no pane runs leaves the running part, keeping its index and the list order', () => {
  const list = [session('a', 'alpha'), session('b', 'beta'), session('c', 'gamma'), session('d', null)];
  const running = new Set(['a', 'c']);
  const { running: up, idle } = picker.sections(list, (s) => running.has(s.id));
  assert.deepEqual(ids(up), ['a', 'c']);
  assert.deepEqual(up.map(([, i]) => i), [0, 2]);
  assert.deepEqual(ids(idle), ['b', 'd']);
  assert.deepEqual(idle.map(([, i]) => i), [1, 3], 'a session never seen in a pane runs nowhere');
  assert.equal(JSON.stringify(picker.sections([], () => true)), '{"starred":[],"running":[],"idle":[]}');
  assert.deepEqual(up.concat(idle).map(([, i]) => i), [0, 2, 1, 3], 'with no star the order is what it was');
});

test('sections: starred sessions form the top group, once each, in list order, keeping their index', () => {
  const list = [session('a', 'alpha'), session('b', 'beta'), session('c', 'gamma'), session('d', null), session('e', 'epsilon')];
  const running = new Set(['a', 'c']);
  const stars = new Set(['c', 'd']);
  const { starred, running: up, idle } = picker.sections(list, (s) => running.has(s.id), (s) => stars.has(s.id));
  assert.deepEqual(ids(starred), ['c', 'd'], 'a running one and a closed one are both starred');
  assert.deepEqual(starred.map(([, i]) => i), [2, 3]);
  assert.deepEqual(ids(up), ['a'], 'a starred session is not listed again under running');
  assert.deepEqual(ids(idle), ['b', 'e'], 'nor under closed panes');
  assert.equal(starred.length + up.length + idle.length, list.length);
  assert.deepEqual(ids(picker.sections(list, () => true, () => true).starred), ['a', 'b', 'c', 'd', 'e']);
});

test('part: starred wins over running, running over idle', () => {
  const s = session('a', 'alpha');
  assert.equal(picker.part(s, () => true, () => true), 'starred');
  assert.equal(picker.part(s, () => true, () => false), 'running');
  assert.equal(picker.part(s, () => false, () => false), 'idle');
  assert.equal(picker.part(s, () => false), 'idle', 'no star rule means none starred');
});

test('starOf: a star names a conversation, so it finds the session under any id the conversation has had', () => {
  const moved = session('new-id', 'alpha', { ids: ['new-id', 'old-id'] });
  const plain = session('solo', 'beta');
  assert.equal(picker.starOf(moved, [{ conv: 'old-id', starred: 1 }]), 'old-id', 'starred before a /clear moved it');
  assert.equal(picker.starOf(moved, [{ conv: 'new-id', starred: 1 }]), 'new-id');
  assert.equal(picker.starOf(plain, [{ conv: 'solo', starred: 1 }]), 'solo', 'a session with no id history is its own');
  assert.equal(picker.starOf(plain, [{ conv: 'old-id', starred: 1 }]), null);
  assert.equal(picker.starOf(moved, []), null);
});

test('label: a starred session and an unstarred one with the same label are in different parts, so neither shows its title', () => {
  const list = [session('a', 'dup'), session('b', 'dup')];
  const part = (s) => picker.part(s, () => true, (x) => x.id === 'a');
  assert.equal(picker.label(list[0], list, part, titled), 'dup');
  assert.equal(picker.label(list[1], list, part, titled), 'dup');
  const both = (s) => picker.part(s, () => true, () => true);
  assert.equal(picker.label(list[0], list, both, titled), 'dup · a title for a', 'two in the starred group tell apart again');
});

test('label: a running session shows its Herdr label alone, whatever closed sessions share the label', () => {
  // leader-workspaceos runs as 6b2d; an older session of the same label stays listed, closed.
  const list = [session('6b2d', 'leader-workspaceos'), session('95b4', 'leader-workspaceos', { reopened: true }), session('x', 'other')];
  const live = (s) => s.id !== '95b4';
  const name = (s) => picker.label(s, list, live, titled);
  assert.equal(name(list[0]), 'leader-workspaceos');
  assert.equal(name(list[1]), 'leader-workspaceos', 'nor does the closed one need its title: it has no twin in its own part');
  assert.equal(name(list[2]), 'other');
});

test('label: two sessions of the same part with one label tell themselves apart by their titles', () => {
  const list = [session('a', 'esim-BC-49-PRD'), session('b', 'esim-BC-49-PRD'), session('c', 'esim-BC-49-PRD'), session('d', 'solo')];
  const live = (s) => s.id !== 'c';
  assert.equal(picker.label(list[0], list, live, titled), 'esim-BC-49-PRD · a title for a');
  assert.equal(picker.label(list[1], list, live, titled), 'esim-BC-49-PRD · a title for b');
  assert.equal(picker.label(list[2], list, live, titled), 'esim-BC-49-PRD', 'the one closed session has no twin among the closed');
  assert.equal(picker.label(list[3], list, live, titled), 'solo');
});

test('label: a session with no known pane has only its own name to go by', () => {
  const list = [session('a', null), session('b', 'beta')];
  assert.equal(picker.label(list[0], list, () => true, titled), 'no pane · a');
  assert.equal(picker.label(list[1], list, () => true, titled), 'beta');
});

test('pageTitle: the open conversation leads the tab title, with the name the picker shows', () => {
  const list = [session('a', 'leader-workspaceos'), session('b', 'dup'), session('c', 'dup')];
  const name = (s) => picker.label(s, list, () => true, titled);
  assert.equal(picker.pageTitle('reader', name(list[0])), 'leader-workspaceos · Reader');
  assert.equal(picker.pageTitle('reader', name(list[1])), 'dup · a title for b · Reader', 'twins keep the title the picker adds');
  assert.equal(picker.pageTitle('doc', name(list[0])), 'leader-workspaceos · Documents');
  assert.equal(picker.pageTitle('fleet', name(list[0])), 'Fleet timeline · Reader');
  assert.equal(picker.pageTitle('reader', null), 'Transcript reader', 'no conversation open');
  assert.equal(picker.pageTitle('doc', null), 'Transcript reader');
});

test('page: the template repaints the tab title where the picker names change', () => {
  const page = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const body = (fn) => page.slice(page.indexOf('function ' + fn + '('), page.indexOf('\n  }\n', page.indexOf('function ' + fn + '(')));
  assert.match(body('paintBar'), /paintTitle\(\)/, 'a switch, Follow Herdr or a view change draws the bar');
  assert.match(body('labelSessions'), /paintTitle\(\)/, 'a poll, a rebuild or a Sync relabels the sessions');
  assert.match(body('paintTitle'), /picker\.pageTitle\(state\.view, session \? pickerName\(session\) : null\)/);
});

test('page: both pickers lead with the Starred group, the option text carries the star, and a star change redraws them', () => {
  const page = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const body = (fn) => page.slice(page.indexOf('function ' + fn + '('), page.indexOf('\n  }\n', page.indexOf('function ' + fn + '(')));
  assert.match(body('fillSessionsInto'), /picker\.sections\(data\.sessions, paneLive, starred\)[\s\S]*Starred · /, 'the local picker');
  assert.match(body('fillHostedSessions'), /picker\.sections\(data\.sessions, \(\) => false, starred\)[\s\S]*Starred · /, 'the hosted copy\'s picker');
  assert.match(page, /const optionText = s => \(starred\(s\) \? "★ " : ""\)/, 'every option, labelSessions\' redraw included');
  assert.match(page, /const pickerSection = s => picker\.part\(s, [^)]*\)?[^;]*starred\)/, 'twins in different parts are not told apart by title');
  assert.match(body('fillSessionsInto'), /\$\("option", null, optionText\(s\)\)/, 'the local picker draws the star and status itself: nothing rewrites its option text afterwards');
  assert.match(page, /stars\.onChange\(paintStars\)/);
  assert.match(page, /stars\.refresh\(s\.stamps && s\.stamps\.stars\)/, 'the state poll carries the revision');
  assert.match(body('toggleStar'), /picker\.starOf\(session, stars\.all\(\)\) \|\| session\.id/, 'unstar by the conversation the star was made under');
});

test('page: the batch list starts folded on every screen and Add leaves it as the reader left it', () => {
  const page = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const body = (fn) => page.slice(page.indexOf('function ' + fn + '('), page.indexOf('\n  }\n', page.indexOf('function ' + fn + '(')));
  assert.match(page, /const link = \{[^\n]*batchOpen: false,/, 'folded at load');
  assert.match(page, /link\.dockSid = session\.id;[^\n]*link\.batchOpen = false;/, 'folded again on a switch of session');
  assert.match(body('renderBatch'), /if \(!items\.length\) link\.batchOpen = false;/, 'an emptied batch folds');
  assert.doesNotMatch(page, /link\.batchOpen = !narrow\.matches/, 'no screen size opens or folds it on Add');
  assert.doesNotMatch(body('addToBatch') || page.slice(page.indexOf('Added to the batch') - 900, page.indexOf('Added to the batch')), /batchOpen/, 'Add does not touch it');
  assert.match(page, /dock\("batch-toggle"\)\.addEventListener\("click", \(\) => \{ link\.batchOpen = !link\.batchOpen; renderDock\(\); \}\)/, 'the heading still toggles it');
});

// ---- an open list stays open: the page's own fillSessions, run on a stand-in for the page's elements ----
// A native list closes when its select leaves the page, and a build lands every second or two while agents write, so the page
// draws the picker aside, changes the select only when what it would show differs, and not while its list is open.

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.isConnected = true; this.text = ''; this.sets = 0; this.chosen = -1; this.opened = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this.sets += 1; }
  get childNodes() { return this.children; }
  get options() { return this.children.flatMap((c) => (c.tagName === 'OPTGROUP' ? c.children : [c])); }
  get innerHTML() { return this.children.map((c) => (c.tagName === 'OPTGROUP' ? `<g>${c.innerHTML}</g>` : `<o ${c.value}>${c.text}</o>`)).join(''); }
  // Like the browser's: a select built option by option has its last-set choice; moved options carry none, so the
  // select starts from its first option unless the page sets the value.
  get selectedIndex() { return this.fromBuild !== undefined ? this.fromBuild : this.chosen; }
  set value(v) { this.chosen = this.options.findIndex((o) => o.value === v); }
  get value() { return this.options[this.chosen] ? this.options[this.chosen].value : ''; }
  matches(query) { if (query !== ':open') throw new Error('unsupported'); if (this.noOpenSupport) throw new SyntaxError('not a selector'); return this.opened; }
}

function pickerPage({ openSupport = true } = {}) {
  const timers = [];
  const world = { list: [['a', 'Alpha'], ['b', 'Beta']], chosen: 'a', active: null };
  // What the page's fillSessionsInto makes: the options for the sessions it lists, one of them chosen.
  const build = (select) => {
    select.children = world.list.map(([value, text]) => { return { tagName: 'OPTION', value, text }; });
    select.fromBuild = world.list.findIndex(([value]) => value === world.chosen);
  };
  const source = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const from = source.indexOf('const pickerOpen = ');
  const to = source.indexOf('  function fillSessionsInto(');
  const sandbox = { $: (tag) => { const e = new El(tag); if (!openSupport) e.noOpenSupport = true; return e; }, fillSessionsInto: build, document: { get activeElement() { return world.active; } }, setTimeout: (fn) => timers.push(fn), Set };
  const fillSessions = vm.runInNewContext(source.slice(from, to) + '\nfillSessions;', sandbox);
  const select = new El('select');
  if (!openSupport) select.noOpenSupport = true;
  return { world, select, fillSessions, timers, tick: () => { const due = timers.splice(0); due.forEach((fn) => fn()); } };
}

test('page: a build that changes nothing the picker shows leaves the select alone, open or not', () => {
  const page = pickerPage();
  page.fillSessions(page.select);
  assert.equal(page.select.sets, 1, 'drawn the first time');
  page.fillSessions(page.select);
  page.select.opened = true;
  page.fillSessions(page.select);
  assert.equal(page.select.sets, 1, 'drawn again, nothing replaced');
  assert.equal(page.timers.length, 0, 'and nothing waits');
});

test('page: a change that arrives while the list is open waits for it to close, then shows, with the choice kept', () => {
  const page = pickerPage();
  page.fillSessions(page.select);
  page.select.opened = true;
  page.world.list.push(['c', 'Gamma']);  // a fresh session
  page.world.chosen = 'b';
  page.fillSessions(page.select);
  page.fillSessions(page.select);
  assert.equal(page.select.options.length, 2, 'the open list is not touched');
  assert.equal(page.timers.length, 1, 'one check is waiting, however many builds land');
  page.tick();
  assert.equal(page.select.options.length, 2, 'still open at the check: it asks again');
  assert.equal(page.timers.length, 1);
  page.select.opened = false;
  page.tick();
  assert.deepEqual(page.select.options.map((o) => o.value), ['a', 'b', 'c'], 'the fresh session shows once the list is closed');
  assert.equal(page.select.value, 'b', 'the choice is set by value, as moved options carry none');
  assert.equal(page.timers.length, 0);
  page.fillSessions(page.select);
  assert.equal(page.select.sets, 2, 'and the next build with nothing new replaces nothing');
});

test('page: a change with the list closed shows at once, and the chosen session is the one the page chose', () => {
  const page = pickerPage();
  page.fillSessions(page.select);
  page.world.chosen = 'b';
  page.fillSessions(page.select);
  assert.equal(page.select.value, 'b');
  page.world.list = [['b', 'Beta renamed']];
  page.fillSessions(page.select);
  assert.deepEqual(page.select.options.map((o) => o.text), ['Beta renamed']);
});

test('page: where the browser has no :open, a focused select counts as open', () => {
  const page = pickerPage({ openSupport: false });
  page.fillSessions(page.select);
  page.world.active = page.select;
  page.world.list = [['a', 'Alpha'], ['b', 'Beta renamed']];
  page.fillSessions(page.select);
  assert.equal(page.select.options[1].text, 'Beta', 'not touched while it has the focus');
  page.world.active = null;
  page.tick();
  assert.equal(page.select.options[1].text, 'Beta renamed');
});

test('page: the picker is one element kept across renders, and a poll relabels through the same guarded fill', () => {
  const page = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
  const body = (fn) => page.slice(page.indexOf('function ' + fn + '('), page.indexOf('\n  }\n', page.indexOf('function ' + fn + '(')));
  // Both views draw their controls through pickerRow, which keeps the row around the picker.
  const render = body('renderReader');
  const keeper = body('pickerRow');
  assert.match(render, /pickerRow\(controls, session\)/);
  assert.match(keeper, /const kept = session && pick\.row && pick\.row\.parentNode && pick\.row\.parentNode\.parentNode === controls/, 'the row around the picker is found again');
  assert.match(keeper, /if \(child !== pick\.row\) child\.remove\(\)/, 'the controls around it are drawn again, not it');
  assert.match(render, /if \(pickRow\.parentNode !== row\) row\.append\(pickRow\);/, 'moving it would close an open list');
  assert.match(render, /if \(row\.parentNode !== controls\) controls\.append\(row\);/);
  assert.doesNotMatch(render, /const select = \$\("select"\); select\.name = "session"/, 'no new select for every build');
  assert.match(keeper, /made\.name = "session"/, 'the one select is made once, by pickerRow');
  assert.match(body('labelSessions'), /fillSessions\(select\)/, 'no option text rewritten under an open list');
});

// ---- the folded header's view switch: icons for Conversation, Documents and the answer sheet, and the same picker on both views ----

const pageSource = () => fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const fnBody = (page, fn) => page.slice(page.indexOf('function ' + fn + '('), page.indexOf('\n  }\n', page.indexOf('function ' + fn + '(')));

// The page's own docsLabel and paintViewIcons, run on stand-ins for the elements and the state.
function iconPage() {
  const page = pageSource();
  const make = () => ({ hidden: false, attrs: {}, title: '', setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } });
  const conv = make(), docs = make();
  const world = { state: { view: 'reader' }, count: 0 };
  const sandbox = { state: world.state, document: { getElementById: (id) => ({ 'view-conv': conv, 'view-doc': docs })[id] }, sessionDocuments: () => new Array(world.count).fill(0), String };
  const run = vm.runInNewContext(fnBody(page, 'docsLabel') + '\n  }\n' + fnBody(page, 'paintViewIcons') + '\n  }\n({ docsLabel, paintViewIcons })', sandbox);
  return { conv, docs, world, ...run };
}

test('icons: Documents is lit on the Documents view and Conversation is offered on every other view', () => {
  const page = iconPage();
  page.paintViewIcons({});
  assert.equal(page.conv.hidden, true, 'on the Conversation view the picker is the conversation: no icon for it');
  assert.equal(page.docs.attrs['aria-pressed'], 'false');
  page.world.state.view = 'doc';
  page.paintViewIcons({});
  assert.equal(page.conv.hidden, false);
  assert.equal(page.docs.attrs['aria-pressed'], 'true');
  page.world.state.view = 'fleet';
  page.paintViewIcons({});
  assert.equal(page.conv.hidden, false, 'the fleet timeline can go back to the conversation too');
  assert.equal(page.docs.attrs['aria-pressed'], 'false');
});

test('icons: the Documents icon is named like its tab, with the count', () => {
  const page = iconPage();
  page.paintViewIcons({});
  assert.equal(page.docs.attrs['aria-label'], 'Documents');
  assert.equal(page.docs.title, 'Documents');
  page.world.count = 3;
  page.world.state.view = 'doc';
  page.paintViewIcons({});
  assert.equal(page.docs.attrs['aria-label'], 'Documents (3)');
  assert.equal(page.docs.title, 'Documents (3) (on screen)', 'the tooltip says it is the view on screen');
  assert.equal(page.docsLabel({}), 'Documents (3)');
});

test('page: the icons and the tabs go to a view by the same functions, and the Documents icon on its own view does nothing', () => {
  const page = pageSource();
  assert.match(page, /document\.getElementById\("tab-reader"\)\.addEventListener\("click", showReaderView\);/);
  assert.match(page, /document\.getElementById\("tab-doc"\)\.addEventListener\("click", showDocView\);/);
  assert.match(page, /document\.getElementById\("view-conv"\)\.addEventListener\("click", showReaderView\);/);
  assert.match(page, /document\.getElementById\("view-doc"\)\.addEventListener\("click", \(\) => \{ if \(state\.view !== "doc"\) showDocView\(\); \}\);/);
  assert.match(fnBody(page, 'showReaderView'), /if \(opening\) showLatest\(\)/, 'back to the conversation opens at its latest turn, as the tab does');
  assert.match(fnBody(page, 'paintBar'), /paintViewIcons\(session\);/, 'every draw of the bar keeps the icons right');
  assert.match(fnBody(page, 'render'), /docsLabel\(data\.sessions\[state\.session\]\)/, 'tab and icon share one label');
});

test('page: paintViewIcons only changes attributes, so the title row and the picker in it are never drawn again', () => {
  const body = fnBody(pageSource(), 'paintViewIcons');
  assert.doesNotMatch(body, /replaceChildren|innerHTML|\.append\(|\.remove\(|fillSessions/);
});

test('page: the folded header shows the icons, the answer sheet link turns into one, and the unfolded header keeps its tabs and its text link', () => {
  const page = pageSource();
  assert.match(page, /\.view-btn, \.to-sheet \.sheet-ico \{ display: none; \}/, 'not in the unfolded header, where the tabs are');
  assert.match(page, /\.bar\.collapsed \.view-btn:not\(\[hidden\]\) \{ display: grid; \}/);
  assert.match(page, /\.bar\.collapsed \.to-sheet \.txt \{ display: none; \}/, 'the words go, the link stays');
  assert.match(page, /\.bar\.collapsed \.to-sheet \{[^}]*width: 30px; height: 28px;/, 'as big as the Documents icon, no bigger');
  assert.match(page, /\.view-btn \{[^}]*width: 30px; height: 28px;/);
  assert.match(page, /\.bar\.collapsed \.view-btn::after, \.bar\.collapsed \.to-sheet::after \{ content: ""; position: absolute; inset: -8px -3px; \}/, 'a tap area past the box');
  assert.match(page, /\.locked \.view-btn \{ display: none !important; \}/, 'a sealed copy waits for its passphrase first');
  const title = page.match(/<div class="title">([\s\S]*?)<\/div>/)[1];
  assert.match(title, /id="view-conv"[^>]*aria-label="Conversation"[^>]*title="Conversation"[^>]*hidden/);
  assert.match(title, /id="view-doc"[^>]*aria-label="Documents"[^>]*aria-pressed="false"/);
  assert.match(title, /<a class="to-sheet" href="questionnaire\.html" title="Answer sheet" aria-label="Answer sheet">/);
  assert.ok(title.indexOf('id="view-conv"') < title.indexOf('id="view-doc"') && title.indexOf('id="view-doc"') < title.indexOf('class="to-sheet"') && title.indexOf('class="to-sheet"') < title.indexOf('id="follow-quick"'));
  assert.doesNotMatch(page.match(/<div id="bar-more">[\s\S]*?<div id="controls">/)[0], /view-btn|to-sheet/, 'the unfolded controls are untouched');
});

test('page: the Documents view has the Conversation\'s header, the one session picker kept across renders', () => {
  const page = pageSource();
  const render = fnBody(page, 'renderDocView');
  assert.match(render, /pickerRow\(controls, session\)/, 'the same helper as the Conversation');
  assert.match(fnBody(page, 'renderReader'), /pickerRow\(controls, session\)/);
  assert.doesNotMatch(render, /controls\.replaceChildren\(\)/, 'the controls are not emptied: that would take the picker out of the page and close its open list');
  assert.doesNotMatch(render, /controls\.append\(row, /, 'nor is its row appended again');
  assert.match(render, /if \(session\) \{ fillSessions\(sessions\); if \(pickRow\.parentNode !== row\) row\.append\(pickRow\); paintStar\(star\); \}/, 'filled through the guarded fill, moved only when it is not in the row');
  assert.match(render, /if \(row\.parentNode !== controls\) controls\.append\(row\);/);
  assert.match(fnBody(page, 'pickerRow'), /if \(child !== pick\.row\) child\.remove\(\)/, 'the row around the picker is kept, the rest drawn again');
  assert.match(fnBody(page, 'paintBar'), /const pick = \(state\.view === "reader" \|\| state\.view === "doc"\) && data\.sessions\.length > 1;/, 'the folded line has the picker on both views');
  assert.match(fnBody(page, 'paintStar'), /\(state\.view === "reader" \|\| state\.view === "doc"\)/, 'and its star');
});

test('page: a switch of session on the Documents view stays there and shows the new session\'s files', () => {
  const page = pageSource();
  const body = fnBody(page, 'pickSession');
  assert.match(body, /const docs = state\.view === "doc";/);
  assert.match(body, /if \(docs\) \{ setAddress\(\); window\.scrollTo\(0, 0\); \} else showLatest\(\);/, 'no jump to the latest turn of a view that has none; the address names the file it landed on');
  assert.match(fnBody(page, 'pickDoc'), /state\.doc = docs\.length \? docs\[docs\.length - 1\]\.id : null/, 'the newest file, or none (the empty note)');
});
