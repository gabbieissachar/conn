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

test('closed: "closed pane" follows the pane, not the flag a conversation keeps for having once been reopened', () => {
  const runs = (ids) => (s) => ids.includes(s.id);
  const running = runs(['live']);
  assert.equal(picker.closed(session('live', 'alpha', { reopened: true }), running), false, 'reopened once, a pane runs it now');
  assert.equal(picker.closed(session('live', 'alpha'), running), false);
  assert.equal(picker.closed(session('gone', 'beta', { reopened: true }), running), true, 'reopened, no pane runs it');
  assert.equal(picker.closed(session('gone', 'beta'), running), true, 'seen in a pane that no longer runs it');
  assert.equal(picker.closed(session('never', null, { reopened: true }), running), true, 'reopened by hand, never seen in a pane');
  assert.equal(picker.closed(session('never', null), running), false, 'never seen in a pane and not reopened: not a closed pane');
  assert.equal(picker.closed(session('kept', 'gamma', { kept: 1700000000 }), runs(['kept'])), true, 'kept on screen after its pane closed, whatever the poll says');
});

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
  assert.match(body('fillHostedSessions'), /picker\.sections\(data\.sessions, hostedPickerLive, starred\)[\s\S]*Starred · /, 'the hosted copy\'s picker uses Herdr state from the build');
  assert.doesNotMatch(body('fillHostedSessions'), /homes\.map\(home/, 'the hosted copy mirrors the live sections instead of regrouping by home');
  assert.match(page, /const hostedPickerLive = s => Boolean\(s\.pane && s\.pane\.live\)/, 'the hosted picker uses the pane state carried by the copy');
  assert.match(page, /data\.stars/, 'the hosted page reads stars carried by the copied index');
  assert.match(page, /at last sync/, 'the hosted picker labels Herdr state as historical');
  assert.match(page, /const optionText = s => \(starred\(s\) \? "★ " : ""\)/, 'every option, labelSessions\' redraw included');
  assert.match(page, /const pickerSection = s => picker\.part\(s, [^)]*\)?[^;]*starred\)/, 'twins in different parts are not told apart by title');
  assert.match(body('fillSessionsInto'), /\$\("option", null, optionText\(s\)\)/, 'the local picker draws the star and status itself: nothing rewrites its option text afterwards');
  assert.match(page, /stars\.onChange\(paintStars\)/);
  assert.match(page, /stars\.refresh\(s\.stamps && s\.stamps\.stars\)/, 'the state poll carries the revision');
  assert.match(body('toggleStar'), /picker\.starOf\(session, HOSTED \? \(data\.stars \|\| \[\]\) : stars\.all\(\)\) \|\| session\.id/, 'unstar by the conversation the star was made under');
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
  const conv = make(), docs = make(), files = make();
  const world = { state: { view: 'reader', docPage: 'list', doc: null }, count: 0, wide: false };
  const sandbox = {
    state: world.state,
    data: { documents: { open: {} } },
    wideDoc: () => world.wide,
    document: { getElementById: (id) => ({ 'view-conv': conv, 'view-doc': docs, 'files-quick': files })[id] },
    listedDocuments: () => new Array(world.count).fill(0),
    String,
  };
  const run = vm.runInNewContext(fnBody(page, 'docsLabel') + '\n  }\n' + fnBody(page, 'paintViewIcons') + '\n  }\n({ docsLabel, paintViewIcons })', sandbox);
  return { conv, docs, files, world, ...run };
}

test('icons: Documents is lit on the Documents view and Conversation is offered on every other view', () => {
  const page = iconPage();
  page.paintViewIcons({});
  assert.equal(page.conv.hidden, true, 'on the Conversation view the picker is the conversation: no icon for it');
  assert.equal(page.docs.attrs['aria-pressed'], 'false');
  assert.equal(page.files.hidden, true, 'the Files icon is not for the Conversation view');
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

test('icons: Files appears only for an open multi-file document on a phone file page', () => {
  const page = iconPage();
  page.world.count = 2;
  page.world.state.view = 'doc';
  page.world.state.docPage = 'file';
  page.world.state.doc = 'open';
  page.paintViewIcons({});
  assert.equal(page.files.hidden, false);
  page.world.state.docPage = 'list';
  page.paintViewIcons({});
  assert.equal(page.files.hidden, true, 'the list button hides when the list is already on screen');
  page.world.state.docPage = 'file';
  page.world.wide = true;
  page.paintViewIcons({});
  assert.equal(page.files.hidden, true, 'the wide layout already shows the list beside the file');
  page.world.wide = false;
  page.world.count = 1;
  page.paintViewIcons({});
  assert.equal(page.files.hidden, true, 'a single file has no separate list page');
  page.world.count = 2;
  page.world.state.view = 'reader';
  page.paintViewIcons({});
  assert.equal(page.files.hidden, true, 'the Files icon hides on non-Documents views');
});

test('page: the icons and the tabs go to a view by the same functions, and the Documents icon on its own view does nothing', () => {
  const page = pageSource();
  assert.match(page, /document\.getElementById\("tab-reader"\)\.addEventListener\("click", showReaderView\);/);
  assert.match(page, /document\.getElementById\("tab-doc"\)\.addEventListener\("click", showDocView\);/);
  assert.match(page, /document\.getElementById\("view-conv"\)\.addEventListener\("click", showReaderView\);/);
  assert.match(page, /document\.getElementById\("view-doc"\)\.addEventListener\("click", \(\) => \{ if \(state\.view !== "doc"\) showDocView\(\); \}\);/);
  assert.match(page, /document\.getElementById\("files-quick"\)\.addEventListener\("click", showDocList\);/);
  assert.match(fnBody(page, 'showDocList'), /state\.docPage = "list"; docReveal = state\.doc;/, 'the Files icon opens the existing list page');
  assert.match(fnBody(page, 'showReaderView'), /if \(opening\) showLatest\(\)/, 'back to the conversation opens at its latest turn, as the tab does');
  assert.match(fnBody(page, 'paintBar'), /paintViewIcons\(session\);/, 'every draw of the bar keeps the icons right');
  assert.match(fnBody(page, 'render'), /docsLabel\(data\.sessions\[state\.session\]\)/, 'tab and icon share one label');
});

test('page: paintViewIcons only changes attributes, so the title row and the picker in it are never drawn again', () => {
  const body = fnBody(pageSource(), 'paintViewIcons');
  assert.doesNotMatch(body, /replaceChildren|innerHTML|\.append\(|\.remove\(|fillSessions/);
});

// The page's own pinsLabel and paintPinsIcon, run on stand-ins for the elements and the state.
function pinsIconPage() {
  const page = pageSource();
  const make = () => ({ hidden: true, attrs: {}, title: '', setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } });
  const icon = make(), panel = make();
  const world = { state: { view: 'reader', pinsOpen: false }, count: 0, look: { open: false } };
  const sandbox = { state: world.state, look: world.look, pins: { count: () => world.count }, document: { getElementById: (id) => ({ 'pins-quick': icon, 'pins-panel': panel })[id] }, String };
  const run = vm.runInNewContext(fnBody(page, 'pinsLabel') + '\n  }\n' + fnBody(page, 'paintPinsIcon') + '\n  }\n({ pinsLabel, paintPinsIcon })', sandbox);
  return { icon, panel, world, ...run };
}

test('pin icon: named with the count, lit while the panel is open, shown on the Conversation with a session only', () => {
  const page = pinsIconPage();
  page.paintPinsIcon({});
  assert.equal(page.icon.hidden, false);
  assert.equal(page.icon.attrs['aria-label'], 'Pins');
  assert.equal(page.icon.title, 'Pins');
  assert.equal(page.icon.attrs['aria-pressed'], 'false');
  assert.equal(page.panel.hidden, true);
  page.world.count = 3;
  page.world.state.pinsOpen = true;
  page.paintPinsIcon({});
  assert.equal(page.icon.attrs['aria-label'], 'Pins · 3', 'the same words as the Pins control');
  assert.equal(page.icon.title, 'Pins · 3 (open)');
  assert.equal(page.icon.attrs['aria-pressed'], 'true');
  assert.equal(page.panel.hidden, false, 'the panel shows in the folded header too');
  page.world.look.open = true;
  page.paintPinsIcon({});
  assert.equal(page.panel.hidden, true, 'a search has the screen');
  page.world.look.open = false;
  page.world.state.view = 'doc';
  page.paintPinsIcon({});
  assert.equal(page.icon.hidden, true);
  assert.equal(page.panel.hidden, true);
  page.world.state.view = 'reader';
  page.paintPinsIcon(null);
  assert.equal(page.icon.hidden, true, 'no session, nothing to pin');
});

test('page: the pin icon sits after the answer sheet icon and before Follow, is an icon of the neighbours\' kind, and opens the same panel as Pins', () => {
  const page = pageSource();
  const title = page.match(/<div class="title">([\s\S]*?)<\/div>/)[1];
  assert.match(title, /<button class="view-btn" id="pins-quick" type="button" aria-controls="pins-panel" aria-pressed="false" aria-label="Pins" title="Pins" hidden><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">/);
  assert.match(title.match(/id="pins-quick"[\s\S]*?<\/svg>/)[0], /stroke="currentColor" stroke-width="1\.4"/, 'the weight of the Documents and answer sheet icons');
  assert.ok(title.indexOf('class="to-sheet"') < title.indexOf('id="pins-quick"') && title.indexOf('id="pins-quick"') < title.indexOf('id="follow-quick"'));
  assert.match(page, /document\.getElementById\("pins-quick"\)\.addEventListener\("click", togglePins\);/);
  assert.match(page, /pinned\.addEventListener\("click", togglePins\);/, 'the Pins control in the controls is untouched and shares the switch');
  assert.match(fnBody(page, 'togglePins'), /state\.pinsOpen = !state\.pinsOpen; paintPins\(\);/);
  assert.match(fnBody(page, 'paintBar'), /paintPinsIcon\(session\);/, 'every draw of the bar keeps it right');
  assert.equal((page.match(/id="pins-panel"/g) || []).length, 1, 'one panel, in the header and not in the controls, so folded or open shows it');
  assert.match(page.match(/<div id="controls"><\/div>[\s\S]*?<\/header>/)[0], /<div id="pins-panel" hidden><\/div>/);
  assert.match(page, /\.bar\.collapsed \.view-btn:not\(\[hidden\]\) \{ display: grid; \}/, 'folded only, with the same size, tap area and pressed look as the other icons');
});

test('page: on a phone the pin icon keeps Follow on the same row', () => {
  const page = pageSource();
  assert.match(page, /@media \(pointer: coarse\) and \(max-width: 440px\) \{\s*\.bar\.collapsed \.title \{ column-gap: 4px; \}\s*\.bar :is\(\.follow-quick, \.jump\) \{ padding: 0 4px; \}/);
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
  assert.match(title, /<button class="view-btn" id="files-quick" type="button" aria-label="Files" title="Files" hidden><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">/);
  assert.match(title.match(/id="files-quick"[\s\S]*?<\/svg>/)[0], /stroke="currentColor" stroke-width="1\.4"/, 'the Files icon has the same stroke weight as its neighbours');
  assert.ok(title.indexOf('id="view-conv"') < title.indexOf('id="view-doc"') && title.indexOf('id="view-doc"') < title.indexOf('id="files-quick"') && title.indexOf('id="files-quick"') < title.indexOf('class="to-sheet"') && title.indexOf('class="to-sheet"') < title.indexOf('id="follow-quick"'));
  assert.doesNotMatch(page.match(/<div id="bar-more">[\s\S]*?<div id="controls">/)[0], /view-btn|to-sheet/, 'the unfolded controls are untouched');
});

test('page: the Documents view has the Conversation\'s header row, with the document picker where the session picker is, kept across renders', () => {
  const page = pageSource();
  const render = fnBody(page, 'renderDocViewIn');
  assert.match(fnBody(page, 'renderDocView'), /renderDocViewIn\(\);/, 'the view is drawn by renderDocViewIn, then the panel');
  assert.match(render, /pickerRow\(controls, session\)/, 'the same helper as the Conversation');
  assert.match(fnBody(page, 'renderReader'), /pickerRow\(controls, session\)/);
  assert.doesNotMatch(render, /controls\.replaceChildren\(\)/, 'the controls are not emptied: that would take the picker out of the page and close its open list');
  assert.doesNotMatch(render, /controls\.append\(row, /, 'nor is its row appended again');
  assert.match(render, /if \(session\) \{ fillDocuments\(pick\.docs\); if \(pickRow\.parentNode !== row\) row\.append\(pickRow\); paintStar\(star\); \}/, 'filled through the guarded fill, moved only when it is not in the row');
  assert.match(render, /if \(row\.parentNode !== controls\) controls\.append\(row\);/);
  assert.match(fnBody(page, 'pickerRow'), /if \(child !== pick\.row\) child\.remove\(\)/, 'the row around the picker is kept, the rest drawn again');
  // One element per job in the one row: the view shows the session picker or the document picker, never both.
  assert.match(fnBody(page, 'pickerRow'), /pick\.row\.append\(made, docs, pick\.star\)/);
  assert.match(fnBody(page, 'pickerRow'), /pick\.select\.hidden = state\.view === "doc"; pick\.docs\.hidden = state\.view !== "doc";/);
  assert.match(fnBody(page, 'paintBar'), /const pick = state\.view === "reader" && data\.sessions\.length > 1;/, 'the folded line has the session picker on the Conversation only');
  assert.match(fnBody(page, 'paintBar'), /const docPick = state\.view === "doc" && Boolean\(session\);/, 'and the document picker on the Documents view');
  assert.match(fnBody(page, 'paintBar'), /if \(docPick && folded\) fillDocuments\(document\.getElementById\("crumb-doc"\)\);/);
  assert.match(fnBody(page, 'paintStar'), /state\.view === "reader" && data\.sessions\[state\.session\]/, 'a star is for a session, chosen on the Conversation');
});

test('page: a session is chosen on the Conversation only, so pickSession has no Documents branch, and the document picker takes its place on that view', () => {
  const page = pageSource();
  const body = fnBody(page, 'pickSession');
  assert.doesNotMatch(body, /state\.view === "doc"|docPage|setAddress\(\); window\.scrollTo/, 'nothing left to do for a session chosen on the Documents view');
  assert.match(body, /whenReady\(\(\) => \{ render\(\); showLatest\(\); \}\);/);
  assert.match(page, /document\.getElementById\("crumb-doc"\)\.addEventListener\("change", e => chooseDocument\(e\.target\.value\)\);/, 'the folded picker chooses a file as a row in the list does');
  assert.match(page, /docs\.addEventListener\("change", \(\) => chooseDocument\(docs\.value\)\);/);
  assert.match(fnBody(page, 'pickDoc'), /state\.doc = docs\.length \? docs\[docs\.length - 1\]\.id : null/, 'the newest file, or none (the empty note)');
});

// ---- a choice names a session by its id, never by its place in a list that every build puts in a new order

test('indexOf: the option holds the session id, and the session is found wherever the list has moved it', () => {
  const before = [session('a', 'alpha'), session('b', 'beta'), session('c', 'gamma'), session('d', 'delta')];
  assert.equal(picker.indexOf(before, 'c'), 2);
  // A reply in "d" puts it first: every session above it moves down one place. The picker held open still offers "c" by what it drew.
  const after = [before[3], before[0], before[1], before[2]];
  assert.equal(picker.indexOf(after, 'c'), 3, 'the same session, one place further down');
  assert.equal(after[picker.indexOf(after, 'c')].id, 'c');
  assert.equal(picker.indexOf(after, 'gone'), -1, 'a session no longer on the page is none');
  assert.equal(picker.indexOf([], 'a'), -1);
});

test('indexOf: a session that a /clear gave a newer id is still found by an id it had', () => {
  const list = [session('new', 'alpha', { ids: ['new', 'old'] }), session('other', 'beta')];
  assert.equal(picker.indexOf(list, 'old'), 0);
  assert.equal(picker.indexOf(list, 'new'), 0);
  assert.equal(picker.indexOf([session('old', 'x'), session('z', 'y', { ids: ['z', 'old'] })], 'old'), 0, 'the session that is called by that id comes before one that only had it');
});

test('page: the session picker offers ids, and a choice is looked up in the list as it is now (the held-open picker bug)', () => {
  const page = pageSource();
  assert.doesNotMatch(page, /opt\.value = i;/, 'no option holds a place in the list');
  assert.equal(page.match(/opt\.value = s\.id;/g).length, 2, 'the live picker and the hosted copy\'s picker both offer ids');
  const body = fnBody(page, 'pickSession');
  assert.match(body, /picker\.indexOf\(data\.sessions, value\)/);
  assert.doesNotMatch(body, /Number\(value\)/, 'the value is not a number');
  assert.match(body, /if \(index < 0\) \{ render\(\); return; \}/, 'a session that left the page changes nothing but the picker');
});
