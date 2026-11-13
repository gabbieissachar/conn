'use strict';

// Tests for the rules behind the task menu (prototype/tasktags.js): which tasks a conversation touches, how the menu groups them, which turns a switch hides, the
// banner's words, the width at which the menu is a rail or a bottom sheet, and what a browser remembers for each conversation. Run from the repo root:
//   node --test setup/transcript-reader/tasktags.test.js
// The file runs in a bare sandbox: its functions take the conversation's turns (as the build gives them: `tags` or `tag_row`) and the leader's tasks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const taskTags = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'tasktags.js'), 'utf8') + '\ntaskTags', { String, Map, Set, Math, Array, Object, JSON });
const plain = (value) => JSON.parse(JSON.stringify(value));

const TASKS = {
  'bc-39-specs-task': { title: 'Write the BC-39 specs', state: 'In flight' },
  'bc-39-review-round': { title: 'BC-39 review round', state: 'Queued' },
  'lv-50-finish-flow': { title: 'Finish the LV-50 flow', state: 'Done' },
  '2026-11-03-esim-annual-global-l3-requirements': { title: 'Annual global requirements', state: 'In flight' },
};
const turn = (at, tags, extra = {}) => ({ source: 'captain', at, reply_at: at + 5, ...(tags ? { tags } : {}), ...extra });
const EXCHANGES = [
  { source: 'session', at: 0 },
  turn(100, [['bc-39-specs-task', 'mention']]),
  turn(200, [['lv-50-finish-flow', 'signal'], ['bc-39-specs-task', 'mention']]),
  turn(300, null, { source: 'wake', tag_row: 'upkeep' }),
  turn(400, null, { tag_row: 'none' }),
  turn(500, [['2026-11-03-esim-annual-global-l3-requirements', 'mention']]),
  turn(600, null, { source: 'wake', tag_row: 'upkeep' }),
  turn(700, [['bc-39-review-round', 'command']]),
];

test('stem and productOf: the key in the task id is its product item, a dated or misnamed id has none', () => {
  assert.equal(taskTags.stem('2026-11-03-esim-annual-global-l3-requirements'), 'esim-annual-global-l3-requirements');
  assert.equal(taskTags.stem('fm-2026-11-06-esim-listing-output-sync-run'), 'esim-listing-output-sync-run');
  assert.equal(taskTags.productOf('bc-39-specs-task'), 'BC-39');
  assert.equal(taskTags.productOf('2026-10-14-lv-50-finish-flow'), 'LV-50');
  assert.equal(taskTags.productOf('2026-11-03-esim-annual-global-l3-requirements'), '', 'no key in the id');
  assert.equal(taskTags.productOf('fm-2026-11-06-esim-listing-output-sync-run'), '', 'a date is never a key');
  assert.equal(taskTags.productOf('reader-task-tags-build'), '');
  assert.equal(taskTags.productOf('pm-1234-copy-fix'), 'PM-1234');
  assert.equal(taskTags.productOf('esim-bc36-final-spec'), 'BC-36', 'the dash is optional, so bc36 and bc-36 are one product');
  assert.equal(taskTags.productOf('2026-11-02-bc-36-search-dashboard'), 'BC-36');
  assert.equal(taskTags.productOf('esim-l3-selected-quick-spec'), '', 'a lone letter is a version or a round (l3, v2, r20), not a product');
  assert.equal(taskTags.productOf('review-r20-notes'), '');
});

test('nameOf: the backlog title, else the id without its date', () => {
  assert.equal(taskTags.nameOf('bc-39-specs-task', TASKS), 'Write the BC-39 specs');
  assert.equal(taskTags.nameOf('2026-11-03-not-in-backlog', TASKS), 'not-in-backlog');
  assert.equal(taskTags.nameOf('x', undefined), 'x');
});

test('summary: each task with its turns and last time, newest first, then the two rows that have turns', () => {
  const sum = taskTags.summary(EXCHANGES, TASKS);
  assert.equal(sum.tagged, true);
  assert.equal(sum.total, 7, 'the divider is not a turn');
  assert.deepEqual(plain(sum.tasks.map(t => [t.id, t.turns, t.last])), [
    ['bc-39-review-round', 1, 705], ['2026-11-03-esim-annual-global-l3-requirements', 1, 505], ['bc-39-specs-task', 2, 205], ['lv-50-finish-flow', 1, 205]]);
  assert.deepEqual(plain(sum.tasks.map(t => t.product)), ['BC-39', '', 'BC-39', 'LV-50']);
  assert.equal(sum.tasks[0].title, 'BC-39 review round');
  assert.equal(sum.tasks[2].state, 'In flight');
  assert.deepEqual(plain(sum.rows.map(r => [r.key, r.name, r.turns])), [[taskTags.UPKEEP, 'Fleet upkeep', 2], [taskTags.NONE, 'No task', 1]]);
});

test('summary: a conversation with no tags at all (a worker\'s, an old copy) is not tagged, and a row with no turns is not listed', () => {
  assert.equal(taskTags.summary([{ source: 'captain', at: 1 }], TASKS).tagged, false);
  assert.equal(taskTags.summary([], TASKS).tagged, false);
  assert.equal(taskTags.summary(undefined, TASKS).tagged, false);
  const sum = taskTags.summary([turn(1, [['bc-39-specs-task', 'mention']])], TASKS);
  assert.deepEqual(plain(sum.rows), []);
});

test('groups: the tasks that share a product key together, newest group first, the rest last as "Other tasks"', () => {
  const groups = taskTags.groups(taskTags.summary(EXCHANGES, TASKS).tasks);
  assert.deepEqual(plain(groups.map(g => [g.key, g.label, g.tasks.map(t => t.id), g.turns])), [
    ['BC-39', 'BC-39', ['bc-39-review-round', 'bc-39-specs-task'], 3],
    ['', 'Other tasks', ['2026-11-03-esim-annual-global-l3-requirements', 'lv-50-finish-flow'], 2]]);
});

test('groups: a key only one task has (a word and a number, not a product) makes no group', () => {
  const ex = [turn(1, [['reader-fix-group-3', 'mention']]), turn(2, [['reader-fix-group-4', 'mention']]), turn(3, [['china-5-rows', 'mention']]), turn(4, [['esim-bc36-a', 'mention']]), turn(5, [['esim-bc36-b', 'mention']])];
  const groups = taskTags.groups(taskTags.summary(ex, {}).tasks);
  assert.deepEqual(plain(groups.map(g => [g.label, g.tasks.length])), [['BC-36', 2], ['Other tasks', 3]]);
  assert.deepEqual(plain(groups[1].tasks.map(t => t.id)), ['china-5-rows', 'reader-fix-group-4', 'reader-fix-group-3'], 'newest first');
});

test('matches: every word, in any order and any case, in the name, the id or the state', () => {
  const task = { id: 'bc-39-specs-task', state: 'In flight' };
  assert.equal(taskTags.matches(task, TASKS, ''), true);
  assert.equal(taskTags.matches(task, TASKS, 'SPECS bc-39'), true);
  assert.equal(taskTags.matches(task, TASKS, 'write specs'), true, 'the backlog title');
  assert.equal(taskTags.matches(task, TASKS, 'in flight'), true);
  assert.equal(taskTags.matches(task, TASKS, 'queued'), false);
  assert.equal(taskTags.matches(task, TASKS, 'specs zzz'), false);
});

test('groups: a conversation whose tasks have no key is one list with no heading', () => {
  const sum = taskTags.summary([turn(1, [['reader-task-tags-build', 'mention']]), turn(2, [['2026-11-03-esim-annual-global-l3-requirements', 'mention']])], TASKS);
  const groups = taskTags.groups(sum.tasks);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, '');
  assert.equal(groups[0].tasks.length, 2);
});

test('visible: with nothing off every turn shows; a turn that touches several tasks shows while any one is on (A4)', () => {
  const [divider, , both] = EXCHANGES;
  assert.equal(taskTags.visible(both, new Set()), true);
  assert.equal(taskTags.visible(both, undefined), true);
  assert.equal(taskTags.visible(both, new Set(['bc-39-specs-task'])), true, 'lv-50-finish-flow is still on');
  assert.equal(taskTags.visible(both, new Set(['bc-39-specs-task', 'lv-50-finish-flow'])), false);
  assert.equal(taskTags.visible(divider, new Set(['bc-39-specs-task'])), true, 'a session divider is never folded away');
});

test('visible: the two rows are their own switches, and a turn with no tag and no row always shows', () => {
  const upkeep = EXCHANGES[3], none = EXCHANGES[4];
  assert.equal(taskTags.visible(upkeep, new Set([taskTags.UPKEEP])), false);
  assert.equal(taskTags.visible(upkeep, new Set([taskTags.NONE])), true);
  assert.equal(taskTags.visible(none, new Set([taskTags.NONE])), false);
  assert.equal(taskTags.visible({ source: 'captain', at: 1 }, new Set([taskTags.NONE, taskTags.UPKEEP, 'x'])), true);
});

test('only: everything but the one key is off, rows included', () => {
  const sum = taskTags.summary(EXCHANGES, TASKS);
  const off = taskTags.only(sum, 'lv-50-finish-flow');
  assert.equal(off.has('lv-50-finish-flow'), false);
  assert.equal(off.size, sum.tasks.length - 1 + sum.rows.length);
  assert.equal(taskTags.only(sum, taskTags.NONE).has(taskTags.UPKEEP), true);
  const shown = EXCHANGES.filter(ex => taskTags.visible(ex, off));
  assert.deepEqual(plain(shown.map(ex => ex.at)), [0, 200], 'the divider and the one turn that touches that task');
});

test('counts and banner: the banner always says what is hidden, which row is off and what is new', () => {
  const sum = taskTags.summary(EXCHANGES, TASKS);
  assert.equal(taskTags.banner(taskTags.counts(EXCHANGES, sum, new Set(), 0)), '', 'nothing off: no banner');
  const some = taskTags.counts(EXCHANGES, sum, new Set(['bc-39-specs-task', 'lv-50-finish-flow']), 0);
  assert.deepEqual(plain([some.off, some.hiddenTurns, some.shownTasks, some.totalTasks]), [2, 2, 2, 4]);
  const most = taskTags.counts(EXCHANGES, sum, taskTags.only(sum, 'bc-39-review-round'), 0);
  assert.equal(taskTags.banner(most), 'Showing 1 of 4 tasks · 6 turns hidden · Fleet upkeep off · No task off');
  const fresh = taskTags.counts(EXCHANGES, sum, taskTags.only(sum, 'bc-39-review-round'), 450);
  assert.equal(fresh.fresh, 2, 'hidden turns written after the switches changed');
  assert.match(taskTags.banner(fresh), /2 new$/);
  assert.equal(taskTags.banner(taskTags.counts(EXCHANGES, sum, new Set(['lv-50-finish-flow']), 0)), 'Showing 3 of 4 tasks · no turns hidden', 'every turn of that task also touches another task that is on');
});

test('counts: an id the conversation does not have is ignored, and one hidden task is "1 turn"', () => {
  const sum = taskTags.summary([turn(1, [['bc-39-specs-task', 'mention']]), turn(2, [['lv-50-finish-flow', 'mention']])], TASKS);
  const c = taskTags.counts([turn(1, [['bc-39-specs-task', 'mention']]), turn(2, [['lv-50-finish-flow', 'mention']])], sum, new Set(['no-such-task', 'bc-39-specs-task']), 0);
  assert.equal(c.off, 1);
  assert.equal(taskTags.banner(c), 'Showing 1 of 2 tasks · 1 turn hidden');
  assert.equal(taskTags.foldLabel(1), '1 turn in other tasks');
  assert.equal(taskTags.foldLabel(14), '14 turns in other tasks');
});

test('chip: the first task\'s name with how many more, and what each tag says why', () => {
  const both = taskTags.chip(EXCHANGES[2], TASKS);
  assert.equal(both.text, 'Finish the LV-50 flow');
  assert.equal(both.more, 1);
  assert.deepEqual(plain(both.ids), ['lv-50-finish-flow', 'bc-39-specs-task']);
  assert.match(both.title, /^About 2 tasks\nFinish the LV-50 flow: a status wake-up for it\nWrite the BC-39 specs: the words name it$/);
  assert.equal(taskTags.chip(EXCHANGES[3], TASKS), null);
  assert.match(taskTags.chip(turn(1, [['bc-39-specs-task', 'signal+mention']]), TASKS).title, /a status wake-up for it, the words name it/);
});

test('placement: a rail at 820 px and wider, a bottom sheet narrower, on any device', () => {
  assert.equal(taskTags.placement(819), 'sheet');
  assert.equal(taskTags.placement(819.9), 'sheet');
  assert.equal(taskTags.placement(820), 'rail');
  assert.equal(taskTags.placement(1440), 'rail');
  assert.equal(taskTags.placement(330), 'sheet');
  assert.equal(taskTags.RAIL_MIN, 820);
});

test('railRem: 20rem where a 44rem column fits beside it (1030 px), 17rem down to 820 px, none below', () => {
  assert.equal(taskTags.railRem(1440), 20);
  assert.equal(taskTags.railRem(1030), 20);
  assert.equal(taskTags.railRem(1029), 17);
  assert.equal(taskTags.railRem(820), 17);
  assert.equal(taskTags.railRem(819), 0);
});

test('railOpen: what was chosen wins; else open on a wide window in a conversation that touches two tasks or more', () => {
  const two = taskTags.summary(EXCHANGES, TASKS), one = taskTags.summary([turn(1, [['bc-39-specs-task', 'mention']])], TASKS);
  assert.equal(taskTags.railOpen(null, 1440, two), true);
  assert.equal(taskTags.railOpen(null, 1440, one), false);
  assert.equal(taskTags.railOpen(null, 1029, two), false, 'no room for it beside a 44rem column until 1030 px');
  assert.equal(taskTags.railOpen('1', 900, one), true);
  assert.equal(taskTags.railOpen('0', 1440, two), false);
});

test('remember and recall: per conversation, by any of its session ids, and everything-on is not kept', () => {
  let raw = taskTags.remember('', ['s1', 's2'], new Set(['bc-39-specs-task', taskTags.NONE]), 1000);
  assert.deepEqual(plain([...taskTags.recall(raw, ['s1', 's2'])]), ['bc-39-specs-task', taskTags.NONE]);
  assert.deepEqual(plain([...taskTags.recall(raw, ['s1', 's2', 's3'])]), ['bc-39-specs-task', taskTags.NONE], 'a /clear gives the conversation a newer session id and it keeps its switches');
  assert.deepEqual(plain([...taskTags.recall(raw, ['s2'])]), ['bc-39-specs-task', taskTags.NONE]);
  assert.deepEqual(plain([...taskTags.recall(raw, ['other'])]), []);
  raw = taskTags.remember(raw, ['s1', 's2', 's3'], new Set(['x']), 2000);
  assert.deepEqual(plain(Object.keys(JSON.parse(raw))), ['s3'], 'the memory of the older ids moves to the newest');
  raw = taskTags.remember(raw, ['s1', 's2', 's3'], new Set(), 3000);
  assert.equal(raw, '{}', 'Show all forgets the conversation');
});

test('remember: only the newest conversations are kept, and bad storage is nothing remembered', () => {
  let raw = '';
  for (let i = 0; i < 70; i++) raw = taskTags.remember(raw, ['c' + i], new Set(['k']), i);
  const kept = Object.keys(JSON.parse(raw));
  assert.equal(kept.length, 60);
  assert.ok(kept.includes('c69') && !kept.includes('c0'));
  for (const bad of ['not json', '[]', '5', 'null', '{"a":5}', '{"a":{"h":"x"}}']) assert.equal(taskTags.recall(bad, ['a']).size, 0, bad);
  assert.equal(taskTags.remember('not json', ['a'], new Set(['k']), 1).includes('"a"'), true);
});

// ---- the page's own task block (prototype/template.html), run on stand-ins for the browser: the banner, Show all, what is kept, and the width switch ----

const PAGE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const BLOCK = PAGE.slice(PAGE.indexOf('// ---------------------------------------------------------------- the task menu'), PAGE.indexOf("// ---------------------------------------------------------------- stars: the picker's favourite sessions"));

function pageWith({ width = 1440, stored = {}, session, canLive = false, marks = false } = {}) {
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = {
    id, hidden: true, textContent: '', dataset: {}, style: { setProperty(name, value) { this[name] = value; } }, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, replaceChildren() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, contains: () => false,
  });
  const kept = { ...stored }, calls = { render: 0 };
  const env = {
    HOSTED: false, EMBED: false, innerWidth: width, Date, Set, Map, Math, Number, String, Array, Object, JSON,
    localStorage: { getItem: (k) => (k in kept ? kept[k] : null), setItem: (k, v) => { kept[k] = String(v); } },
    matchMedia: (query) => ({ get matches() { return width >= Number(/min-width: (\d+)px/.exec(query)[1]); }, addEventListener() {}, media: query }),
    taskTags, document: { getElementById: element, documentElement: element('root'), body: element('body'), activeElement: null },
    state: { view: 'reader', session: 0, open: new Set() }, data: { sessions: [session] }, fmtShortDay: () => 'day', fmtTime: () => 'time', runSpan: () => 'span', reveals: new Map(),
    readingAnchor: () => ({}), restoreAnchor: () => {}, render: () => { calls.render += 1; env.readTasks(); env.paintTaskBanner(); },
    $: (tag, cls, text) => ({ tag, className: cls || '', textContent: text || '', dataset: {}, scrollTop: 0, append() {}, addEventListener() {}, setAttribute() {}, classList: { add() {} },
      querySelector: () => null, querySelectorAll: () => [], replaceChildren() {}, focus() {}, scrollIntoView() {} }),
    paintBar: () => {}, innerHeight: 900,
    // what the turn menu's block reads of the page around it
    addEventListener() {}, scrollX: 0, scrollY: 0, canLive, link: { board: marks ? { page: '/board/', boards: {}, write: { marks: true } } : null },
    refreshData: async () => { env.refreshed += 1; }, refreshed: 0, toasts: [], toast(text, undo) { env.toasts.push({ text, undo }); },
    timers: [], setTimeout(fn, ms) { env.timers.push({ fn, ms }); return env.timers.length; }, clearTimeout(id) { if (env.timers[id - 1]) env.timers[id - 1].cleared = true; },
    live: { written: [], rerenders: 0, fail: null, boardMark(body) { this.written.push(body); return this.fail ? Promise.reject(new Error(this.fail)) : Promise.resolve({ status: 'ok' }); }, rerender() { this.rerenders += 1; return Promise.resolve({}); } },
  };
  vm.createContext(env);
  vm.runInContext(BLOCK + '\nthis.readTasks = readTasks; this.setTaskOff = setTaskOff; this.paintTaskBanner = paintTaskBanner; this.taskShows = taskShows; this.taskSignature = taskSignature; this.menuShown = menuShown; this.openTaskMenu = openTaskMenu; this.closeTaskMenu = closeTaskMenu; this.getState = () => taskState; this.taskUi = taskUi; this.turnUi = turnUi; this.turnOps = turnOps; this.turnMenuOffered = turnMenuOffered; this.applyTurnOverlay = applyTurnOverlay; this.changeTurn = changeTurn; this.writeMarks = writeMarks; this.marksWritable = marksWritable; this.openTurnMenu = openTurnMenu; this.closeTurnMenu = closeTurnMenu;', env);
  env.kept = kept; env.calls = calls; env.element = element;
  env.readTasks();
  return env;
}
const leaderSession = (over = {}) => ({ id: 'sess-new', ids: ['sess-old', 'sess-new'], exchanges: EXCHANGES, leader: { tasks: TASKS }, ...over });

test('page: a conversation with tags has task state, one without (a worker\'s) has none and shows every turn', () => {
  const page = pageWith({ session: leaderSession() });
  assert.equal(page.getState().sum.tasks.length, 4);
  assert.equal(page.getState().active, false);
  assert.equal(page.taskShows(EXCHANGES[1]), true);
  const worker = pageWith({ session: { id: 'w', ids: ['w'], exchanges: [{ source: 'captain', at: 1 }] } });
  assert.equal(worker.getState(), null);
  assert.equal(worker.taskShows(EXCHANGES[1]), true);
  const rowsOnly = pageWith({ session: leaderSession({ exchanges: [turn(1, null, { tag_row: 'upkeep' }), turn(2, null, { tag_row: 'none' })] }) });
  assert.equal(rowsOnly.getState(), null, 'a leader whose turns touch no task has nothing to switch: no menu');
  const embed = pageWith({ session: leaderSession() }); embed.EMBED = true; embed.readTasks();
  assert.equal(embed.getState(), null, 'the embed page keeps nothing and draws no menu');
});

test('page: a switch draws the page again, writes the banner, hides the turns and is kept; Show all undoes all four', () => {
  const page = pageWith({ session: leaderSession() });
  page.setTaskOff(new Set(['bc-39-specs-task', 'lv-50-finish-flow']));
  assert.equal(page.calls.render, 1);
  assert.equal(page.element('task-banner').hidden, false);
  assert.equal(page.element('task-banner-text').textContent, 'Showing 2 of 4 tasks · 2 turns hidden');
  assert.equal(page.taskShows(EXCHANGES[1]), false);
  assert.equal(page.taskShows(EXCHANGES[2]), false);
  assert.equal(page.taskShows(EXCHANGES[5]), true);
  assert.equal(page.taskSignature(), ['bc-39-specs-task', 'lv-50-finish-flow'].sort().join('\u0001'));
  assert.deepEqual(plain(Object.keys(JSON.parse(page.kept['tr-tasks']))), ['sess-new'], 'kept under the conversation\'s newest id');
  page.setTaskOff(new Set());
  assert.equal(page.element('task-banner').hidden, true);
  assert.equal(page.element('task-banner-text').textContent, '');
  assert.equal(page.taskSignature(), '');
  assert.equal(page.kept['tr-tasks'], '{}');
  assert.equal(page.taskShows(EXCHANGES[1]), true);
});

test('page: a reload reads the switches back, also under an older session id of the conversation', () => {
  const first = pageWith({ session: leaderSession() });
  first.setTaskOff(new Set(['bc-39-specs-task']));
  const again = pageWith({ session: leaderSession(), stored: first.kept });
  assert.equal(again.getState().active, true);
  assert.equal(again.getState().off.has('bc-39-specs-task'), true);
  const cleared = pageWith({ session: leaderSession({ id: 'sess-newest', ids: ['sess-old', 'sess-new', 'sess-newest'] }), stored: first.kept });
  assert.equal(cleared.getState().off.has('bc-39-specs-task'), true, 'a /clear gave the conversation a newer session and it keeps its switches');
  const other = pageWith({ session: leaderSession({ id: 'x', ids: ['x'] }), stored: first.kept });
  assert.equal(other.getState().active, false, 'another conversation is not touched');
});

test('page: new turns after the switches changed are counted in the banner and the rest of the turns stay folded', () => {
  const page = pageWith({ session: leaderSession() });
  page.setTaskOff(new Set(['bc-39-specs-task']));
  page.taskUi.changed.set('sess-new', 450);  // the switches changed at 450 (the stand-in clock is the real one, the turns' times are small numbers)
  const grown = [...EXCHANGES, turn(800, [['bc-39-specs-task', 'mention']])];
  page.data.sessions[0] = leaderSession({ exchanges: grown });
  page.readTasks(); page.paintTaskBanner();
  assert.match(page.element('task-banner-text').textContent, /2 turns hidden · 1 new$/);
});

test('page: the width switch is the menu\'s own 820 px: shut as a sheet at 819 px until opened, a rail from 820 px once chosen', () => {
  const narrow = pageWith({ session: leaderSession(), width: 819 });
  assert.equal(narrow.menuShown(), false);
  narrow.openTaskMenu('bc-39-specs-task');
  assert.equal(narrow.menuShown(), true);
  assert.equal(narrow.taskUi.sheet, true, 'a sheet below 820 px');
  assert.equal(narrow.kept['tr-task-rail'], undefined, 'a sheet is not the rail\'s choice');
  narrow.closeTaskMenu();
  assert.equal(narrow.menuShown(), false);
  const edge = pageWith({ session: leaderSession(), width: 820 });
  assert.equal(edge.menuShown(), false, 'no room for it unasked beside the column until 1030 px');
  edge.openTaskMenu(null);
  assert.equal(edge.menuShown(), true);
  assert.equal(edge.taskUi.sheet, false);
  assert.equal(edge.kept['tr-task-rail'], '1', 'a rail: the choice is kept');
  edge.closeTaskMenu();
  assert.equal(edge.kept['tr-task-rail'], '0');
  assert.equal(pageWith({ session: leaderSession(), width: 1440 }).menuShown(), true, 'open by itself where there is room and the conversation touches several tasks');
});

test('page: the style rules use the same 820 px as the script, and the rail is the width the script sets', () => {
  const style = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
  assert.ok(style.includes(`@media (min-width: ${taskTags.RAIL_MIN}px) {\n    .taskmenu { z-index: 5; left: auto; top: 0; right: 0; bottom: 0; width: var(--rail);`), 'the rail rule starts at RAIL_MIN');
  assert.ok(/\.taskmenu \{ position: fixed; z-index: 31; left: 0; right: 0; bottom: 0;/.test(style), 'below it the menu is a bottom sheet');
  assert.ok(BLOCK.includes('matchMedia(`(min-width: ${taskTags.RAIL_MIN}px)`)'), 'the script asks the same width');
  assert.ok(/body \{ padding-right: var\(--rail\); \}/.test(style) && /\.dock \{[^}]*right: var\(--rail\)/.test(style), 'the column and the message bar make room through --rail');
});

// ---- changing a turn's tasks from the conversation (the turn menu): the marks one action writes, the picker, the overlay

const MARKED = (extra = {}) => ({ source: 'captain', uid: 'abcdef12-0000-4000-8000-000000000001', mk: '5e550000', reply: 'Nathan, done.', at: 100, reply_at: 105, ...extra });
const BIG = {
  'bc-39-specs-task': { title: 'Write the BC-39 specs', state: 'In flight' },
  'bc-39-review-round': { title: 'BC-39 review round', state: 'Queued' },
  'zz-queued-one': { title: 'A queued one', state: 'Queued' },
  'aa-flight-one': { title: 'An in flight one', state: 'In flight' },
  'lv-50-finish-flow': { title: 'Finish the LV-50 flow', state: 'Done' },
  'old-archived': { title: 'Old finished work', state: 'Done', archived: true },
};

test('markable: a turn with its log id and its own id can be marked, a divider and a turn from a copy built before the keys cannot', () => {
  assert.equal(taskTags.markable(MARKED()), true);
  assert.equal(taskTags.markable(MARKED({ mk: undefined })), false, 'a copy built before the keys');
  assert.equal(taskTags.markable(MARKED({ uid: '' })), false);
  assert.equal(taskTags.markable(MARKED({ source: 'session' })), false, 'a divider');
  assert.equal(taskTags.markable(null), false);
});

test('markKey: the board\'s turn id, the log\'s eight characters then the turn\'s eight then the side', () => {
  assert.equal(taskTags.markKey(MARKED(), 'reply'), '5e550000:abcdef12:reply');
  assert.equal(taskTags.markKey(MARKED(), 'in'), '5e550000:abcdef12:in');
  assert.equal(taskTags.markKey(MARKED({ mk: '' }), 'reply'), '');
});

test('marksFor add: one in, on the reply, or on your message while the turn has no reply yet', () => {
  assert.deepEqual(plain(taskTags.marksFor(MARKED(), 'zz-queued-one', 'add')), [{ task: 'zz-queued-one', turn: '5e550000:abcdef12:reply', mark: 'in' }]);
  assert.deepEqual(plain(taskTags.marksFor(MARKED({ reply: '' }), 'zz-queued-one', 'add')), [{ task: 'zz-queued-one', turn: '5e550000:abcdef12:in', mark: 'in' }], 'a message with no reply yet');
});

test('marksFor drop: an out on each side the tag sits on, so a tag from your message\'s words really goes', () => {
  const both = MARKED({ tags: [['bc-39-specs-task', 'mention'], ['zz-queued-one', 'mention'], ['aa-flight-one', 'mention']], tag_sides: ['rm', 'm', 'r'] });
  assert.deepEqual(plain(taskTags.marksFor(both, 'bc-39-specs-task', 'drop')).map(m => m.turn.split(':')[2] + '=' + m.mark), ['reply=out', 'in=out']);
  assert.deepEqual(plain(taskTags.marksFor(both, 'zz-queued-one', 'drop')).map(m => m.turn.split(':')[2] + '=' + m.mark), ['in=out']);
  assert.deepEqual(plain(taskTags.marksFor(both, 'aa-flight-one', 'drop')).map(m => m.turn.split(':')[2] + '=' + m.mark), ['reply=out']);
  const plainTurn = MARKED({ tags: [['bc-39-specs-task', 'mention']] });
  assert.deepEqual(plain(taskTags.marksFor(plainTurn, 'bc-39-specs-task', 'drop')).map(m => m.turn.split(':')[2]), ['reply'], 'no tag_sides: the reply');
});

test('marksFor remove: a clear on each side the tag sits on; anything else writes nothing', () => {
  const ex = MARKED({ tags: [['zz-queued-one', 'marked']], tag_sides: ['m'] });
  assert.deepEqual(plain(taskTags.marksFor(ex, 'zz-queued-one', 'remove')), [{ task: 'zz-queued-one', turn: '5e550000:abcdef12:in', mark: 'clear' }]);
  assert.deepEqual(plain(taskTags.marksFor(ex, 'zz-queued-one', 'nonsense')), []);
  assert.deepEqual(plain(taskTags.marksFor(MARKED({ mk: '' }), 'zz-queued-one', 'add')), [], 'a turn with no key writes nothing');
  assert.deepEqual(plain(taskTags.marksFor(ex, '', 'add')), []);
});

test('undoOf: clear for an in or an out, in again for a clear', () => {
  const marks = [{ task: 'a', turn: 't:1:reply', mark: 'in' }, { task: 'a', turn: 't:1:in', mark: 'out' }, { task: 'b', turn: 't:2:in', mark: 'clear' }];
  assert.deepEqual(plain(taskTags.undoOf(marks)).map(m => m.mark), ['clear', 'clear', 'in']);
  assert.deepEqual(plain(taskTags.undoOf(marks)).map(m => m.turn), ['t:1:reply', 't:1:in', 't:2:in']);
});

test('tagAction: a tag you added is removed, one the rules made is declined, one that is both is declined', () => {
  const ex = MARKED({ tags: [['a', 'marked'], ['b', 'mention+signal'], ['c', 'marked+mention']] });
  assert.deepEqual(['a', 'b', 'c'].map(id => taskTags.tagAction(ex, id)), ['remove', 'drop', 'drop']);
});

test('turnTags: each tag with its name, state, the reasons in words and its action', () => {
  const rows = plain(taskTags.turnTags(MARKED({ tags: [['bc-39-specs-task', 'signal+mention'], ['zz-queued-one', 'marked']], tag_sides: ['r', 'm'] }), BIG));
  assert.deepEqual(rows.map(r => [r.id, r.name, r.state, r.why, r.action, r.side]), [
    ['bc-39-specs-task', 'Write the BC-39 specs', 'In flight', 'a status wake-up for it, the words name it', 'drop', 'r'],
    ['zz-queued-one', 'A queued one', 'Queued', 'you marked it', 'remove', 'm'],
  ]);
  assert.deepEqual(plain(taskTags.turnTags(MARKED({ tag_row: 'none' }), BIG)), []);
});

test('pickList: this conversation\'s tasks first, then open ones (in flight before queued), finished ones only on a match, an archived one never, none the turn has', () => {
  const sum = taskTags.summary([{ source: 'captain', at: 1, tags: [['lv-50-finish-flow', 'x']] }, { source: 'captain', at: 9, tags: [['bc-39-review-round', 'x']] }, { source: 'captain', at: 5, tags: [['old-archived', 'x']] }], BIG);
  const ex = MARKED({ tags: [['bc-39-specs-task', 'mention']] });
  const groups = plain(taskTags.pickList(ex, BIG, sum, ''));
  assert.deepEqual(groups.map(g => [g.key, g.tasks.map(t => t.id)]), [
    ['touched', ['bc-39-review-round', 'lv-50-finish-flow']],
    ['open', ['aa-flight-one', 'zz-queued-one']],
  ]);
  const found = plain(taskTags.pickList(ex, BIG, sum, 'finish flow'));
  assert.deepEqual(found.map(g => [g.key, g.tasks.map(t => t.id)]), [['touched', ['lv-50-finish-flow']]]);
  const finished = plain(taskTags.pickList(MARKED({ tag_row: 'none' }), BIG, taskTags.summary([], BIG), 'old finished'));
  assert.deepEqual(finished, [], 'an archived task is never offered, even on a match');
  const done = plain(taskTags.pickList(MARKED({ tag_row: 'none' }), BIG, taskTags.summary([], BIG), 'lv-50'));
  assert.deepEqual(done.map(g => [g.key, g.tasks.map(t => t.id)]), [['finished', ['lv-50-finish-flow']]], 'a finished task the conversation has not touched shows only when the find matches');
});

test('pickList: a long list of tasks is built in a millisecond or two', () => {
  const many = {};
  for (let i = 0; i < 214; i += 1) many[`task-${String(i).padStart(3, '0')}-thing`] = { title: `Task number ${i}`, state: i % 3 ? 'Queued' : 'In flight' };
  const start = process.hrtime.bigint();
  for (let n = 0; n < 50; n += 1) taskTags.pickList(MARKED({ tag_row: 'none' }), many, taskTags.summary([], many), '');
  const each = Number(process.hrtime.bigint() - start) / 1e6 / 50;
  assert.ok(each < 5, `${each.toFixed(2)} ms`);
});

test('overlay: an added tag leads the turn, a dropped one goes, a turn left with none falls to No task, an unchanged turn is the same object', () => {
  const ex = MARKED({ tags: [['bc-39-specs-task', 'mention']] });
  const added = plain(taskTags.overlay(ex, [{ task: 'zz-queued-one', action: 'add' }]));
  assert.deepEqual(added.tags, [['zz-queued-one', 'marked'], ['bc-39-specs-task', 'mention']]);
  assert.equal('tag_sides' in added, false, 'every tag on the reply: no sides');
  const onMessage = plain(taskTags.overlay(MARKED({ reply: '', tag_row: 'none' }), [{ task: 'zz-queued-one', action: 'add' }]));
  assert.deepEqual([onMessage.tags, onMessage.tag_sides, 'tag_row' in onMessage], [[['zz-queued-one', 'marked']], ['m'], false]);
  const dropped = plain(taskTags.overlay(ex, [{ task: 'bc-39-specs-task', action: 'drop' }]));
  assert.deepEqual([dropped.tags, dropped.tag_row], [undefined, 'none']);
  assert.equal(taskTags.overlay(ex, [{ task: 'bc-39-specs-task', action: 'add' }]), ex, 'adding what is there changes nothing');
  assert.equal(taskTags.overlay(ex, [{ task: 'nothing', action: 'drop' }]), ex);
  assert.equal(taskTags.overlay(ex, []), ex);
  assert.deepEqual(plain(ex.tags), [['bc-39-specs-task', 'mention']], 'the turn the build gave is never changed');
});

test('overlay keeps the sides of the tags that stay in step with them', () => {
  const ex = MARKED({ tags: [['a', 'mention'], ['b', 'mention']], tag_sides: ['m', 'r'] });
  const next = plain(taskTags.overlay(ex, [{ task: 'a', action: 'drop' }, { task: 'c', action: 'add' }]));
  assert.deepEqual(next.tags.map(t => t[0]), ['c', 'b']);
  assert.equal('tag_sides' in next, false, 'what is left sits on the reply');
  const keep = plain(taskTags.overlay(ex, [{ task: 'b', action: 'drop' }]));
  assert.deepEqual([keep.tags.map(t => t[0]), keep.tag_sides], [['a'], ['m']]);
});

test('refusalText: the command\'s sentence without a path or the tail after a semicolon', () => {
  assert.equal(taskTags.refusalText("Firstmate did not file the mark: no task ancient-archived-task in this home's backlog (data directory /Users/someone/fm-homes/x/data); a mark is filed in "), "Firstmate did not file the mark: no task ancient-archived-task in this home's backlog");
  assert.equal(taskTags.refusalText("Firstmate did not file the mark: task 'x' is not in this home's backlog"), "Firstmate did not file the mark: task 'x' is not in this home's backlog");
  assert.equal(taskTags.refusalText(''), 'the command refused');
  assert.equal(taskTags.refusalText(undefined), 'the command refused');
});

test('the words of the toast', () => {
  assert.equal(taskTags.addedText('bc-39-specs-task', BIG), 'Added to Write the BC-39 specs.');
  assert.equal(taskTags.droppedText('2026-11-03-esim-annual-global-l3-requirements', {}), 'Taken off esim-annual-global-l3-requirements.');
});

// ---- the page's turn menu logic (the same block, on stand-ins): when it is offered, what a change writes and shows, how a refusal and an Undo are handled

const markSession = (over = {}) => ({
  id: 'sess-new', ids: ['sess-old', 'sess-new'], leader: { tasks: BIG, board: 'leader-lab' },
  exchanges: [
    { source: 'captain', uid: 'abcdef12-0000', mk: '5e550000', reply: 'Nathan, ok.', at: 100, reply_at: 105, tag_row: 'none' },
    { source: 'captain', uid: 'bbbbbbbb-0000', mk: '5e550000', reply: 'Nathan, done.', at: 200, reply_at: 205, tags: [['bc-39-specs-task', 'mention']], tag_sides: ['rm'] },
    { source: 'captain', uid: 'cccccccc-0000', mk: '5e550000', reply: '', at: 300, tag_row: 'none' },
  ], ...over,
});
const markPage = (over = {}) => pageWith({ session: markSession(over.session), canLive: true, marks: true, ...over.page });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('page: the turn menu is offered only where the server says marks can be written, for a leader\'s turn that has its keys', () => {
  const page = markPage();
  const [none, tagged] = page.data.sessions[0].exchanges;
  assert.equal(page.turnMenuOffered(page.data.sessions[0], none), true, 'a turn with no task');
  assert.equal(page.turnMenuOffered(page.data.sessions[0], tagged), true, 'a tagged turn');
  const off = markPage({ page: { marks: false } });
  assert.equal(off.turnMenuOffered(off.data.sessions[0], off.data.sessions[0].exchanges[0]), false, 'the server did not say marks can be written (flag off, the phone, a copy)');
  const copy = markPage({ page: { canLive: false } });
  assert.equal(copy.turnMenuOffered(copy.data.sessions[0], copy.data.sessions[0].exchanges[0]), false, 'a page no server serves');
  const noBoard = markPage({ session: { leader: { tasks: BIG } } });
  assert.equal(noBoard.turnMenuOffered(noBoard.data.sessions[0], noBoard.data.sessions[0].exchanges[0]), false, 'no board owns the home');
  const old = markPage();
  assert.equal(old.turnMenuOffered(old.data.sessions[0], { ...none, mk: undefined }), false, 'a copy built before the keys');
  const embed = markPage(); embed.EMBED = true;
  assert.equal(embed.turnMenuOffered(embed.data.sessions[0], none), false, 'the embed page');
});

test('page: adding a task shows at once, writes one in on the reply, says so with an Undo, and builds the pages again after one pause', async () => {
  const page = markPage();
  const session = page.data.sessions[0], ex = session.exchanges[0];
  const done = page.changeTurn(session, ex, 'zz-queued-one', 'add');
  assert.deepEqual(plain(session.exchanges[0].tags), [['zz-queued-one', 'marked']], 'the tag is on the turn before the command has answered');
  assert.equal(page.calls.render, 1);
  assert.equal(page.toasts.at(-1).text, 'Saving…');
  await done;
  assert.deepEqual(plain(page.live.written), [{ session: 'leader-lab', task: 'zz-queued-one', turn: '5e550000:abcdef12:reply', mark: 'in', source: 'reader' }]);
  assert.deepEqual(plain(session.exchanges[0].tags), [['zz-queued-one', 'marked']], 'the tag is on the turn while the build has not got it');
  assert.equal(page.toasts.at(-1).text, 'Added to A queued one.');
  assert.equal(typeof page.toasts.at(-1).undo, 'function');
  assert.equal(page.timers.filter((t) => !t.cleared).length, 1, 'one build is asked for');
  assert.equal(page.timers.at(-1).ms, 1500);
  await page.timers.at(-1).fn(); await flush();
  assert.equal(page.live.rerenders, 1);
  assert.equal(page.refreshed, 1);
});

test('page: two marks in a row ask for one build, the last one\'s', async () => {
  const page = markPage();
  const session = page.data.sessions[0];
  await page.changeTurn(session, session.exchanges[0], 'zz-queued-one', 'add');
  await page.changeTurn(session, session.exchanges[2], 'zz-queued-one', 'add');
  assert.equal(page.timers.filter((t) => !t.cleared).length, 1, 'the first request was cancelled by the second');
  assert.equal(page.live.written.length, 2);
  assert.equal(page.live.written[1].turn, '5e550000:cccccccc:in', 'a message with no reply yet is marked on your message');
});

test('page: a refusal takes the shown change back and says why', async () => {
  const page = markPage();
  page.live.fail = 'Firstmate did not file the mark: task is not in this home\'s backlog';
  const session = page.data.sessions[0];
  await page.changeTurn(session, session.exchanges[0], 'zz-queued-one', 'add');
  assert.equal(page.turnOps.length, 0);
  page.readTasks();
  assert.equal(session.exchanges[0].tags, undefined, 'the turn is as the build had it');
  assert.equal(session.exchanges[0].tag_row, 'none');
  assert.match(page.toasts.at(-1).text, /^Not saved: Firstmate did not file the mark/);
  assert.equal(page.timers.filter((t) => !t.cleared).length, 0, 'nothing to build');
});

test('page: Not this task writes an out on each side the tag sits on, in order; Undo clears both and the tag comes back', async () => {
  const page = markPage();
  const session = page.data.sessions[0], both = session.exchanges[1];
  await page.changeTurn(session, both, 'bc-39-specs-task', 'drop');
  assert.deepEqual(plain(page.live.written.map((w) => [w.turn.split(':')[2], w.mark])), [['reply', 'out'], ['in', 'out']]);
  assert.equal(session.exchanges[1].tags, undefined, 'the tag is gone from the turn at once');
  assert.equal(page.toasts.at(-1).text, 'Taken off Write the BC-39 specs.');
  page.toasts.at(-1).undo();
  await flush(); await flush();
  assert.deepEqual(plain(page.live.written.slice(2).map((w) => [w.turn.split(':')[2], w.mark])), [['reply', 'clear'], ['in', 'clear']]);
  assert.deepEqual(plain(session.exchanges[1].tags.map((t) => t[0])), ['bc-39-specs-task'], 'shown again until the build says what the rules said');
});

test('page: a change is dropped once a build made after it arrives, and an old one is dropped after two minutes', async () => {
  const page = markPage();
  const session = page.data.sessions[0];
  await page.changeTurn(session, session.exchanges[0], 'zz-queued-one', 'add');
  page.data.generated = 1;  // a build from long before the write
  page.readTasks();
  assert.equal(page.turnOps.length, 1);
  assert.deepEqual(plain(session.exchanges[0].tags), [['zz-queued-one', 'marked']]);
  page.data.generated = Date.now() / 1000 + 5;  // a build made after it
  page.readTasks();
  assert.equal(page.turnOps.length, 0);
  assert.equal(session.exchanges[0].tags, undefined, 'the build had no tag here (the file did not change): the page shows what the build says');
  await page.changeTurn(session, session.exchanges[2], 'zz-queued-one', 'add');
  page.data.generated = 1;
  page.turnOps[0].at -= 121000;
  page.readTasks();
  assert.equal(page.turnOps.length, 0, 'a change nobody confirmed is not kept for ever');
});

test('page: a change on a conversation that is not on screen is kept for when it is, and does not touch the one that is', async () => {
  const page = markPage();
  const session = page.data.sessions[0];
  await page.changeTurn(session, session.exchanges[0], 'zz-queued-one', 'add');
  page.data.sessions[0] = markSession({ id: 'other', ids: ['other'] });
  page.readTasks();
  assert.equal(page.data.sessions[0].exchanges[0].tags, undefined);
  assert.equal(page.turnOps.length, 1);
});
