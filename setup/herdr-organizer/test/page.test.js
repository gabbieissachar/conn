'use strict';

// Static checks on the page source. The page is a single HTML file, so these guard the
// properties that must not regress without driving a browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'apps', 'wip-herdr-workspace-organizer.html'), 'utf8');

test('the page only fetches from the organizer API, never from a raw static file', () => {
  const targets = [...html.matchAll(/fetch\(\s*(['"`])([^'"`]*)\1/g)].map((match) => match[2]);
  assert.ok(targets.length >= 3, 'found the fetch calls');
  for (const target of targets) assert.match(target, /^\/api\//, target);
  assert.equal(/live-snapshot\.json['"`]/.test(html.replace(/<!--[\s\S]*?-->/, '')), false, 'the page does not name the raw snapshot file');
  assert.equal(html.includes('DATA_URL'), false, 'the static snapshot fallback is gone');
});

test('the snapshot error state shows the failure instead of falling back', () => {
  const load = html.slice(html.indexOf('const load = async'), html.indexOf('const refreshSnapshot'));
  assert.match(load, /api\.run\('snapshot-data'\)/);
  assert.match(load, /Snapshot unavailable/);
  assert.equal(/fetch\(/.test(load), false, 'load() has no second fetch to fall back on');
});

test('write actions send a confirm token and the page never builds a command for the server', () => {
  for (const action of ['verify-apply', 'save-manual-identity', 'seal-bundle']) {
    const call = html.slice(html.indexOf(`'${action}'`));
    assert.match(call.slice(0, 400), /confirm:/, action);
  }
  assert.equal(/\bcommand:\s*|\bargs:\s*|shell:\s*/.test(html.slice(html.indexOf('const api = {'), html.indexOf('const restart = {'))), false);
});

test('bundles that are not compatible are never offered for a preview', () => {
  assert.match(html, /bundle\.ready && bundle\.compatible/);
});

test('archive all: the page only previews through the server and copies the execute command', () => {
  const calls = [...html.matchAll(/api\.run\('([^']+)'/g)].map((match) => match[1]);
  assert.ok(calls.includes('archive-all-preview'));
  for (const name of calls) assert.equal(/archive-all$|restore|execute/.test(name), false, name);
  // the execute form is only ever copied: it comes from the server preview and sits behind data-aa-copy
  assert.match(html, /data-aa-copy="\$\{escapeHtml\(canCopy \? result\.commands\.execute : ''\)\}"/);
  assert.equal(/api\.run\([^)]*archive-all[^)]*--execute/.test(html), false);
});

test('archive all and restore all never offer an override flag or force', () => {
  assert.equal(html.includes('--force'), false);
  const batchSection = html.slice(html.indexOf('// ---- Archive all workspaces ----'), html.indexOf('// ---- Snapshot-backed views'));
  assert.equal(/--allow-active|--allow-unresumable-agents|--force/.test(batchSection), false);
});

test('restore all is copy-only, built from a validated batch id, and disabled when nothing is archived', () => {
  const view = html.slice(html.indexOf('const batchView = (batch'), html.indexOf('const batchesView'));
  assert.match(view, /BATCH_ID_PATTERN\.test\(id\)/);
  assert.match(view, /canRestore = valid && counts\.archived > 0/);
  assert.match(view, /restore-batch --batch \$\{id\}/);
  assert.match(view, /--resume-agents --execute --confirm \$\{id\}/);
  assert.equal(/api\.run/.test(view), false, 'the group card never calls the server');
  assert.match(view, /Copy restore all \+ resume agents/);
  assert.match(view, /Copy restore all \(layout only\)/);
});

test('the session id field in a skipped row reuses the manual identity flow and saves with a confirm token', () => {
  assert.match(html, /manualFormView\(session, \{ pane_id: pane\.pane_id/);
  assert.match(html, /const rerenderManual = \(\) => \{ renderRestart\(\); renderArchiveAll\(\); \}/);
  const call = html.slice(html.indexOf("'save-manual-identity'"));
  assert.match(call.slice(0, 400), /confirm: `save:\$\{pane\}`/);
});

// Behavioural check: the page's own pane-view functions are cut out of the source and run with minimal stand-ins,
// so what a skipped pane shows depends on what the identity check said, not on the text of the source.
function loadPaneView(restart, archiveAll) {
  const vm = require('vm');
  const slice = (from, to) => html.slice(html.indexOf(from), html.indexOf(to));
  const code = [
    slice('const archivePaneState = ', 'const archiveCheckSeconds'),
    slice('const archiveCheckSeconds', 'const archiveAllPaneView'),
    slice('const archiveAllPaneView', 'const archiveAllSkippedView'),
  ].join('\n');
  const context = {
    restart,
    state: { archiveAll },
    escapeHtml: (value) => String(value ?? ''),
    manualKey: (session, pane) => `${session}|${pane}`,
    manualFormView: () => '<form data-manual-form>',
    plural: (count, one, many) => `${count} ${count === 1 ? one : (many || one + 's')}`,
    CLASS_LABELS: { candidate_ambiguous: ['Ambiguous', 'warn'], unresolved: ['Unresolved', 'bad'] },
    Date,
    Math,
  };
  vm.createContext(context);
  vm.runInContext(`${code}\nthis.view = archiveAllPaneView; this.paneState = archivePaneState;`, context);
  return context;
}

const baseAa = () => ({ checking: {}, checkStarted: {}, applying: false, applied: {} });
const baseRestart = (rows) => ({ manual: {}, applyResult: {}, verify: rows ? { esim: { data: { rows } } } : {} });
const pane = { pane_id: 'w6:p2', client: 'codex' };

test('skipped pane: before the identity check it offers both a check and setting the session id directly', () => {
  const { view } = loadPaneView(baseRestart(null), baseAa());
  const out = view('esim', pane);
  assert.match(out, /Check identity/);
  assert.match(out, /Set session id/);
  assert.equal(/<form/.test(out), false, 'the form opens only when asked');
  const restart = baseRestart(null);
  restart.manual['esim|w6:p2'] = { open: true, client: 'codex', draft: '' };
  assert.match(loadPaneView(restart, baseAa()).view('esim', pane), /<form data-manual-form>/);
});

test('skipped pane: a session id can be set while the identity check is still running', () => {
  const aa = baseAa();
  aa.checking.esim = true;
  aa.checkStarted.esim = Date.now();
  const restart = baseRestart(null);
  assert.match(loadPaneView(restart, aa).view('esim', pane), /checking identities[\s\S]*Set session id/);
  restart.manual['esim|w6:p2'] = { open: true, client: 'codex', draft: '' };
  assert.match(loadPaneView(restart, aa).view('esim', pane), /<form data-manual-form>/);
});

test('the save sends the replace confirmation only when the pane already has a different session', () => {
  assert.match(html, /replace_existing: entry\.replace === true/);
  assert.match(html, /error\.code === 'pane_registered'\) entry\.needsReplace = true/);
  assert.match(html, /data-action="manual-replace"/);
});

test('skipped pane: a pane the check verified offers apply and never the id form (it cannot work for it)', () => {
  const { view } = loadPaneView(baseRestart([{ pane_id: 'w6:p2', verified: true, classification: 'handle_verified', candidates: 1 }]), baseAa());
  const out = view('esim', pane);
  assert.match(out, /Apply verified identities/);
  assert.match(out, /not registered yet/);
  assert.equal(/Set session id|<form/.test(out), false);
});

test('skipped pane: an ambiguous or unresolved pane gets the id form, with its candidate count', () => {
  const restart = baseRestart([{ pane_id: 'w6:p2', verified: false, classification: 'candidate_ambiguous', candidates: 5 }]);
  restart.manual['esim|w6:p2'] = { open: true, client: 'codex', draft: '' };
  const out = loadPaneView(restart, baseAa()).view('esim', pane);
  assert.match(out, /Ambiguous/);
  assert.match(out, /5 candidate sessions/);
  assert.match(out, /Close form/);
  assert.match(out, /<form data-manual-form>/);
  restart.manual = {};
  assert.match(loadPaneView(restart, baseAa()).view('esim', pane), /Set session id/);
});

test('skipped pane: progress shows elapsed seconds while the check runs, and a registered pane says so', () => {
  const aa = baseAa();
  aa.checking.esim = true;
  aa.checkStarted.esim = Date.now() - 12000;
  assert.match(loadPaneView(baseRestart(null), aa).view('esim', pane), /checking identities… 1[12]s/);
  const restart = baseRestart([{ pane_id: 'w6:p2', verified: true, classification: 'handle_verified', candidates: 1 }]);
  const applied = baseAa();
  applied.applied.esim = { written: 3, skipped: 0 };
  const done = loadPaneView(restart, applied).view('esim', pane);
  assert.match(done, /applied, preview again/);
  assert.match(done, /the tool wrote 3 identities/);
  assert.match(done, /does not show this pane was one of them/);
  assert.equal(/registered<|Registered/.test(done), false, 'it never claims this pane is registered');
  assert.equal(/Apply verified identities/.test(done), false);
});

test('skipped pane: a pane the check did not list asks for a fresh check instead of a dead end', () => {
  const out = loadPaneView(baseRestart([{ pane_id: 'w9:p9', verified: false, classification: 'unresolved', candidates: 0 }]), baseAa()).view('esim', pane);
  assert.match(out, /Check again/);
  assert.equal(/<form/.test(out), false);
});

test('group card: each archived member has its own copy-only restore, and delete is offered for every group', () => {
  const view = html.slice(html.indexOf('const ARCHIVE_ID_PATTERN'), html.indexOf('const batchesView'));
  assert.match(view, /member\.status === 'archived' \? memberRestoreCommand/);
  assert.match(view, /restore --archive \$\{member\.archive_id\} --resume-agents --execute --confirm \$\{member\.archive_id\}/);
  assert.match(view, /ARCHIVE_ID_PATTERN\.test\(member\.archive_id/);
  assert.match(view, /delete-batch --batch \$\{id\} --archives --execute --confirm delete-archives:\$\{id\}/);
  assert.match(view, /delete-batch --batch \$\{id\} --execute --confirm \$\{id\}/);
  assert.match(view, /valid && removable/);
  assert.match(view, /Copy delete group record only/);
  assert.equal(/api\.run/.test(view), false, 'the group card never calls the server');
  assert.equal(/--force/.test(view), false);
});

test('skipped pane: an apply result from the Restart tab or an earlier check never marks this pane as done', () => {
  const restart = baseRestart([{ pane_id: 'w6:p2', verified: true, classification: 'handle_verified', candidates: 1 }]);
  restart.applyResult.esim = { written: 14, skipped: 0 };
  const out = loadPaneView(restart, baseAa()).view('esim', pane);
  assert.match(out, /Apply verified identities/);
  assert.equal(/applied, preview again/.test(out), false);
  const failed = baseAa();
  failed.applied.esim = { error: 'The apply step returned nothing.' };
  const retry = loadPaneView(restart, failed).view('esim', pane);
  assert.match(retry, /The apply step returned nothing\./);
  assert.match(retry, /Apply verified identities/, 'a failed apply can be retried');
});

test('skipped pane: no state renders a literal template placeholder', () => {
  const states = [
    [baseRestart(null), baseAa()],
    [baseRestart([{ pane_id: 'w6:p2', verified: true, classification: 'handle_verified', candidates: 1 }]), baseAa()],
    [baseRestart([{ pane_id: 'w6:p2', verified: false, classification: 'candidate_ambiguous', candidates: 5 }]), baseAa()],
    [baseRestart([{ pane_id: 'w9:p9', verified: false, classification: 'unresolved', candidates: 0 }]), baseAa()],
  ];
  const applied = baseAa();
  applied.applied.esim = { written: 1 };
  states.push([baseRestart([{ pane_id: 'w6:p2', verified: true, classification: 'handle_verified', candidates: 1 }]), applied]);
  const checking = baseAa();
  checking.checking.esim = true;
  states.push([baseRestart(null), checking]);
  for (const [restart, aa] of states) {
    const out = loadPaneView(restart, aa).view('esim', pane);
    assert.equal(out.includes('${'), false, out);
  }
});

test('group card: permanent delete needs its own confirm value and shows a visible warning, not only a tooltip', () => {
  const view = html.slice(html.indexOf('const ARCHIVE_ID_PATTERN'), html.indexOf('const batchesView'));
  assert.match(view, /--archives --execute --confirm delete-archives:\$\{id\}/);
  assert.equal(/--archives --execute --confirm \$\{id\}/.test(view), false, 'the record-only confirm value cannot be reused');
  assert.match(view, /<div class="archive-meta"[^`]*Delete group \+ \$\{plural\(removable, 'archive'\)\} is permanent\./);
  assert.match(view, /still archived, so/);
});

test('group card: a layout-only copy keeps every restore command, shows layout open, and never counts as restored', () => {
  const view = html.slice(html.indexOf('const hasOpenLayout'), html.indexOf('const batchesView'));
  // the open copy counts only while Herdr still lists the workspace, and only for an archived member
  assert.match(view, /member\.status === 'archived' && Boolean\(member\.layout_workspace_id\) && liveIds\.has\(member\.layout_workspace_id\)/);
  assert.match(view, /\[layoutOpen, 'layout open'\]/);
  // the per-member and group resume commands stay for an archived member, whatever its layout copy
  assert.match(view, /const restoreCommand = member\.status === 'archived' \? memberRestoreCommand\(member, session\) : ''/);
  assert.match(view, /canRestore && !notRebooted \? `data-command="\$\{escapeHtml\(resume\)\}"`/);
  // layout only is offered only while some archived member has no open copy, so it cannot make duplicates
  assert.match(view, /const canLayout = canRestore && layoutOpen < archivedMembers\.length/);
  assert.match(view, /canLayout \? `data-command="\$\{escapeHtml\(layout\)\}"`/);
  assert.equal(/--force/.test(view), false);
  const batches = html.slice(html.indexOf('const batchesView'), html.indexOf('// ---- Snapshot-backed views'));
  assert.match(batches, /new Set\(\(data\.workspaces \|\| \[\]\)\.map\(workspace => workspace\.id\)\)/);
});

test('cleanup card: a workspace of only empty tabs is shown as closing entirely, with the guarded cases explained', () => {
  const view = html.slice(html.indexOf('const cleanupAllView'), html.indexOf('const runCleanupPreview'));
  assert.match(view, /workspace\.close_workspace \? 'closes entirely'/);
  assert.match(view, /the whole workspace closes with its last tab/);
  assert.match(view, /the command would run inside this workspace/);
  assert.match(view, /it is the only workspace in the session/);
  assert.match(view, /totals\.workspaces_to_close/);
  assert.equal(/api\.run\([^)]*execute/.test(view), false, 'the page still only copies the closing command');
  assert.equal(/keeps one/.test(view), false, 'the old promise that one tab always stays is gone');
});

test('add tabs to the archive group: copy-only, validated ids, finished same-session groups only, no override', () => {
  const panel = html.slice(html.indexOf('const TAB_ID_PATTERN'), html.indexOf('const archiveTabKey'));
  assert.match(panel, /selected\.every\(tab => TAB_ID_PATTERN\.test\(tab\.id\)\)/);
  assert.match(panel, /BATCH_ID_PATTERN\.test\(batch\.batch_id/);
  assert.match(panel, /\['completed', 'completed_with_failures'\]\.includes\(batch\.status\)/);
  assert.match(panel, /batch\.herdr_session === data\.herdr_session/);
  assert.match(panel, /--session \$\{chosenBatch\.herdr_session\} add-tabs-to-batch --batch \$\{destination\} \$\{tabArgs\}/);
  assert.match(panel, /--execute --confirm \$\{destination\}/);
  // the preview copy has no execute flag, so it can only read
  assert.match(panel, /id="copy-batch-preview"[^>]*data-command="\$\{escapeHtml\(batchBase\)\}"/);
  assert.equal(/--force|--allow-active|--allow-unresumable-agents/.test(panel), false);
  assert.equal(html.includes("api.run('add-tabs"), false, 'the page never runs the command itself');
});

test('add tabs to the archive group: three modes, a disabled state with a reason, and no literal placeholder', () => {
  const panel = html.slice(html.indexOf('const TAB_MODES'), html.indexOf('const archiveTabKey'));
  assert.match(panel, /\['batch', 'Add to archive group'\]/);
  assert.match(panel, /Run Archive all again to finish it/);
  assert.match(panel, /This session has no archive group yet\. The command starts it with these tabs/);
  assert.match(panel, /id="copy-move-tabs" \$\{command \? '' : 'disabled'\}/);
  assert.match(html, /data-tabs-mode/);
  assert.equal(html.includes('toggle-selected-tabs-action'), false, 'the two-way toggle is gone');
});

test('the selected-tabs panel has a dismiss button that clears the selection, and Esc does the same', () => {
  assert.equal((html.match(/data-panel-close="tabs"/g) || []).length, 1);
  assert.ok((html.match(/data-panel-close="archived"/g) || []).length >= 2, 'the restore panel and its one-archive notice both have it');
  assert.match(html, /\(state\.view === 'archives' \? state\.selectedArchivedTabs : state\.view === 'group' \? state\.selectedGroupTabs : state\.selectedTabs\)\.clear\(\)/);
  assert.match(html, /event\.key !== 'Escape'/);
  assert.match(html, /addEventListener\('click', dismissSelection\)/);
});

// Runs the page's own Move panel on plain data.
function movePanel(selectedLabels, { chosen = '' } = {}) {
  const line = name => html.split('\n').find(row => row.trim().startsWith('const ' + name + ' = ')).trim();
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const source = html.slice(html.indexOf('const TAB_MODES'), html.indexOf('const archiveTabKey'));
  const workspaces = [
    { id: 'wBK', label: 'leader-space', tab_count: 2, tabs: [{ id: 'wBK:t1', label: 'leader-esim' }, { id: 'wBK:t2', label: 'big-boss' }] },
    { id: 'wA8', label: 'esim', tab_count: 3, tabs: [{ id: 'wA8:t1', label: 'shell' }, { id: 'wA8:t2', label: 'claude' }, { id: 'wA8:t3', label: 'leader-nip' }] },
    { id: 'wB1', label: 'nip', tab_count: 0, tabs: [] },
  ];
  const ids = { 'leader-esim': 'wBK:t1', 'big-boss': 'wBK:t2', shell: 'wA8:t1', claude: 'wA8:t2', 'leader-nip': 'wA8:t3' };
  const state = { selectedTabs: new Set(selectedLabels.map(label => ids[label])), selectedTabsAction: 'move', destinationWorkspace: chosen, selectedTabsArchive: '', selectedTabsBatch: '' };
  const { movePanelView } = new Function('escapeHtml', 'state', [line('TAB_ID_PATTERN'), line('SESSION_NAME_PATTERN'), 'const BATCH_ID_PATTERN = /^batch-[0-9]{8}-[0-9]{6}(-[0-9]+)?$/;', source, 'return { movePanelView };'].join('\n'))(escapeHtml, state);
  const out = movePanelView({ workspaces, archives: [], batches: [], herdr_session: 'esim' });
  const options = [...out.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
  return { out, options, state, command: (out.match(/id="copy-move-tabs"[^>]*data-command="([^"]*)"/) || [])[1] };
}

test('the Move panel follows the leader rule and starts with nothing chosen', () => {
  // leader-space is the first workspace on the operator's machine, which used to make it the default for any tab.
  const ordinary = movePanel(['shell']);
  assert.deepEqual(ordinary.options, ['', 'wB1'], 'an ordinary tab is offered no leader-space, and not its own workspace');
  assert.equal(ordinary.command, '', 'no destination is chosen, so there is no command to copy');
  assert.equal(ordinary.state.destinationWorkspace, '', 'a computed default is never stored');
  const leader = movePanel(['leader-nip']);
  assert.deepEqual(leader.options, ['', 'wBK'], 'a leader tab is offered only leader-space');
  assert.equal(leader.command, '', 'and still has to be picked');
  assert.deepEqual(movePanel(['big-boss']).options, [''], 'a leader tab already in leader-space has no other place to go');
  const mixed = movePanel(['leader-esim', 'shell']);
  assert.deepEqual(mixed.options, [''], 'a mix has no destination');
  assert.match(mixed.out, /Leader tabs and other tabs cannot go into one workspace/);
  // A pick the user made counts while it is offered, and not otherwise.
  const picked = movePanel(['shell'], { chosen: 'wB1' });
  assert.match(picked.command, /move-tabs --tab wA8:t1 --to-workspace wB1 --execute --confirm wB1/);
  assert.equal(movePanel(['shell'], { chosen: 'wBK' }).command, '', 'a stale choice of leader-space is not used');
  assert.equal(/<option value="[^"]+" selected/.test(ordinary.out), false, 'no workspace is marked selected');
});

test('a leader selection in a move is offered only leader-space', () => {
  const { restoreDestinations } = require('node:vm').runInNewContext(`${html.slice(html.indexOf('const LEADER_WORKSPACE_LABEL = '), html.indexOf('const archiveTabKey = '))}; ({ restoreDestinations })`, {});
  const workspaces = [{ id: 'wBK', label: 'leader-space' }, { id: 'wA8', label: 'esim' }];
  assert.deepEqual(restoreDestinations(workspaces, [{ label: 'big-boss' }]).map(item => item.id), ['wBK']);
  assert.match(html, /restoreDestinations\(data\.workspaces\.filter\(workspace => !sourceWorkspaces\.has\(workspace\.id\)\), selected\)/, 'the Move panel uses the same rule as the restore panels');
});

// Runs the page's own rollover card on plain data.
function rolloverHarness(overrides = {}) {
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (count, one) => `${count} ${count === 1 ? one : one + 's'}`;
  const source = html.slice(html.indexOf('// ---- Context rollover'), html.indexOf('// ---- Context view')).replace(/^    const rollover = \{.*$/m, '');
  const rollover = { loading: false, data: null, error: '', at: '', open: new Set(), pick: new Map(), confirm: null, busy: false, result: null, ...overrides };
  const api = { run: async () => { throw new Error('no network in this test'); } };
  const functions = new Function('escapeHtml', 'plural', 'rollover', 'contextAge', 'api', 'planClock', 'state', 'renderContext', `${source}; return { rolloverCard, rolloverToken, rolloverArmBlock, rolloverPicked, rolloverVerdictText };`)(escapeHtml, plural, rollover, seconds => `${seconds} s ago`, api, () => '09:05', { view: 'context' }, () => {});
  return { ...functions, rollover };
}

const ROLLOVER_FILES = ['rollover-live', 'rollover-crew-live', 'rollover-off', 'rollover-primary-live', 'rollover-primary-off'];
function rolloverHome(extra = {}) {
  return { id: 'ha02f1cb9', label: 'fm-homes/pmos', status: 'ok', config: 'ok', watcher: 'running', is_secondmate_home: false, roller_log_age_seconds: 90,
    files: ROLLOVER_FILES.map(name => ({ name, state: 'absent', capability: 'read' })),
    effective: { second_mates: 'second mates: dry-run: config/rollover-live is absent, so nothing is sent or restarted', crew: 'crewmates and scouts: dry-run: config/rollover-crew-live is absent, so nothing is sent or restarted', primary: 'the primary: dry-run, nothing is sent or typed' },
    ids: { second_mates: { list: [{ id: 'sm-ok', ok: true }, { id: '<b>x</b>', ok: false, reason: 'harness' }] }, crew: { list: [{ id: 'crew-a', ok: true }, { id: 'crew-b', ok: true }] } },
    ...extra };
}

test('rollover card: one block per home, the reasons Arm is not offered, and what each file is', () => {
  const made = { name: 'rollover-live', state: 'regular', capability: 'read', ids_count: 2, origin: 'page' };
  const idle = { id: 'h11111111', label: 'firstmate-8bf1b0/2', status: 'ok', config: 'ok', watcher: 'stale_pid', is_secondmate_home: true, files: ROLLOVER_FILES.map(name => ({ name, state: 'absent' })), effective: null, ids: { second_mates: { list: [] }, crew: { list: [] } } };
  const withFile = rolloverHome({ files: ROLLOVER_FILES.map(name => (name === 'rollover-live' ? made : name === 'rollover-off' ? { name, state: 'regular', capability: 'read', origin: 'page_header_only' } : { name, state: 'absent', capability: 'read' })) });
  const { rolloverCard } = rolloverHarness({ data: { homes: [withFile, idle, { id: 'h2', label: 'gone', status: 'missing' }, { id: 'h3', label: 'nocfg', status: 'ok', config: 'missing', watcher: 'no_lock' }], unregistered_homes: 8, platform_supported: true }, at: '09:05' });
  const out = rolloverCard();
  assert.match(out, /watcher running/);
  assert.match(out, /watcher stopped/);
  assert.match(out, /no watcher right now/, 'a home with no lock is not called broken: a Claude-run firstmate starts its watcher between turns (R7-4)');
  assert.match(out, /made by this page/);
  assert.match(out, /has this page&#39;s header, no record: remove it by hand/);
  assert.match(out, /No watcher is running in this home right now, so nothing reads these files at this moment\. A firstmate run by Claude starts one at the end of each turn/);
  assert.match(out, /This home folder is not there/);
  assert.match(out, /does not create one/);
  assert.match(out, /8 other firstmate homes on this computer are not listed here, and Stop does not cover them/);
  assert.match(out, /&lt;b&gt;x&lt;\/b&gt; - not a Claude session/, 'ids are escaped and carry their reason');
  assert.match(out, /Second mates: 1 of 2 could roll now/);
  assert.match(out, /read 09:05/);
  assert.match(out, /Stop every listed home/);
  assert.equal(/data-command/.test(out), false, 'nothing here copies a command');
  // Arm: disabled with a reason until an id is ticked, and for each condition the server also refuses
  const arm = kind => out.match(new RegExp(`data-ro-arm="${kind}"[^>]*>`))[0];
  assert.match(arm('second-mates'), /disabled/, 'the off file is present in the first home');
  assert.match(out, /The off file is present, so a live file would do nothing/);
  assert.equal((out.match(/data-ro-undo="rollover-live"/g) || []).length, 1, 'Remove only for a file the page made and recorded');
  assert.equal(/data-ro-undo="rollover-off"/.test(out), false, 'the off file with the header and no record has no button');
});

test('rollover card: Arm needs a ticked id and says why it is not offered', () => {
  const home = rolloverHome();
  const { rolloverCard, rolloverArmBlock, rolloverPicked, rolloverToken, rollover } = rolloverHarness({ data: { homes: [home], unregistered_homes: 0, platform_supported: true } });
  assert.equal(rolloverArmBlock(home, 'crew'), 'Tick at least one id.');
  assert.match(rolloverCard(), /data-ro-arm="crew"[^>]*disabled/);
  rollover.pick.set('ha02f1cb9|crew', new Set(['crew-b', 'crew-a', 'gone-id']));
  assert.deepEqual(rolloverPicked(home, 'crew'), ['crew-a', 'crew-b'], 'a tick for an id that no longer qualifies is dropped, and the list is sorted');
  assert.equal(rolloverArmBlock(home, 'crew'), '');
  const armed = rolloverCard();
  assert.equal(/data-ro-arm="crew"[^>]*disabled/.test(armed), false);
  assert.match(armed, /Arm crewmates and scouts \(2\)/);
  assert.equal(rolloverToken('ha02f1cb9', 'crew', ['crew-b', 'crew-a']), 'rollover-arm:ha02f1cb9:crew:crew-a,crew-b', 'the token the server expects');
  // each condition that blocks Arm
  const block = (changes, kind = 'crew') => rolloverArmBlock({ ...home, ...changes }, kind);
  assert.match(block({ watcher: 'beat_old' }), /No watcher runs in this home right now\. A firstmate run by Claude starts one at the end of each turn/);
  assert.match(block({ config: 'missing' }), /cannot be written to/);
  assert.match(block({ files: home.files.map(file => (file.name === 'rollover-crew-live' ? { ...file, capability: 'not_read' } : file)) }), /does not read this file/);
  assert.match(block({ files: home.files.map(file => (file.name === 'rollover-off' ? { ...file, state: 'symlink' } : file)) }), /off file is present/);
  assert.match(block({ files: home.files.map(file => (file.name === 'rollover-crew-live' ? { ...file, state: 'regular' } : file)) }), /already exists/);
  // the confirmation names the home, the file and the ids, and says a restart cannot be undone
  rollover.confirm = { kind: 'arm', home: 'ha02f1cb9', which: 'crew', ids: ['crew-a', 'crew-b'] };
  const confirm = rolloverCard();
  assert.match(confirm, /Arm crewmates and scouts in fm-homes\/pmos\?/);
  assert.match(confirm, /creates rollover-crew-live[^]*crew-a, crew-b/);
  assert.match(confirm, /A restart cannot be undone/);
  assert.match(confirm, /data-ro-go="arm"/);
  assert.match(confirm, /data-ro-cancel/);
  rollover.confirm = { kind: 'undo', home: 'ha02f1cb9', file: 'rollover-off' };
  assert.match(rolloverCard(), /Turn rolling back on in fm-homes\/pmos\?[^]*Every live switch still present/);
  rollover.confirm = null;
  rollover.result = { tone: 'bad', text: '2 of those ids cannot roll now. Nothing was written.', rows: ['<i>x</i>: no worktree'] };
  const refused = rolloverCard();
  assert.match(refused, /class="scope-note error" id="rollover-result"/);
  assert.match(refused, /&lt;i&gt;x&lt;\/i&gt;: no worktree/, 'a reason row is escaped');
  rollover.busy = true;
  assert.equal(/id="rollover-stop"[^>]*disabled/.test(rolloverCard()), false, 'Stop is never greyed out, even while another change runs (R7-2)');
  assert.match(rolloverCard(), /data-ro-arm="crew"[^>]*disabled/);
  assert.match(rolloverHarness({}).rolloverCard(), /class="skeleton"/);
  const failed = rolloverHarness({ error: 'Not found.' }).rolloverCard();
  assert.match(failed, /Not found\./);
  assert.match(failed, /id="rollover-stop"/, 'Stop stays on the card when the state read fails (R7-2)');
  assert.match(rolloverHarness({}).rolloverCard(), /id="rollover-stop"/, 'and while the first read is still running');
  assert.match(rolloverHarness({ data: { homes: [], unregistered_homes: 0, platform_supported: false } }).rolloverCard(), /needs macOS/);
  assert.match(rolloverHarness({ data: { homes: [home], unregistered_homes: 0, platform_supported: true }, open: new Set(['ha02f1cb9:Crewmates and scouts']) }).rolloverCard(), /data-ro-open="ha02f1cb9:Crewmates and scouts" open/, 'an opened list stays open across a redraw');
});

test('rollover card: the preview names who would roll for the ticked ids, in plain words, escaped, and only for those ids', () => {
  const home = rolloverHome();
  const results = [
    { id: 'crew-a', verdict: 'eligible', covered: false, detail: 'context 41% (90000 of 200000 tokens), idle' },
    { id: 'crew-b', verdict: 'ineligible', detail: 'context 12% of its 200000 window is below the 30% threshold' },
    { id: '<b>x</b>', verdict: 'skip', detail: 'only Claude sessions roll for now' },
  ];
  const { rolloverCard, rollover, rolloverVerdictText } = rolloverHarness({ data: { homes: [home], unregistered_homes: 0, platform_supported: true } });
  rollover.pick.set('ha02f1cb9|crew', new Set(['crew-a', 'crew-b']));
  assert.match(rolloverCard(), /data-ro-preview="crew"[^>]*>Check who would roll/);
  assert.equal(/data-ro-preview="crew"[^>]*disabled/.test(rolloverCard()), false);
  assert.match(rolloverCard(), /data-ro-preview="second-mates"[^>]*disabled/, 'nothing ticked for second mates');
  rollover.preview = { home: 'ha02f1cb9', kind: 'crew', ids: ['crew-a', 'crew-b'], loading: true, error: '', data: null, at: '' };
  assert.match(rolloverCard(), /Asking this home's firstmate/);
  assert.match(rolloverCard(), /data-ro-preview="crew"[^>]*disabled/, 'one question at a time');
  rollover.preview = { home: 'ha02f1cb9', kind: 'crew', ids: ['crew-a', 'crew-b'], loading: false, error: '', data: { results, eligible: 1 }, at: '09:07' };
  const out = rolloverCard();
  assert.match(out, /Asked this home's firstmate at 09:07\. 1 of 3 would roll\. This is a read-only check; nothing was changed\./);
  assert.match(out, /pill good">would roll once armed<\/span> crew-a/);
  assert.match(out, /pill warn">would not roll now<\/span> crew-b/);
  assert.match(out, /&lt;b&gt;x&lt;\/b&gt;/, 'an id is escaped');
  assert.match(out, /below the 30% threshold/);
  assert.deepEqual(rolloverVerdictText({ verdict: 'eligible', covered: true }), ['would roll at the next pass', 'good']);
  // ticking another id makes the earlier answer stale, so it is not shown for the new selection
  rollover.pick.set('ha02f1cb9|crew', new Set(['crew-a']));
  assert.equal(rolloverCard().includes('would roll once armed'), false);
  rollover.pick.set('ha02f1cb9|crew', new Set(['crew-a', 'crew-b']));
  rollover.preview = { ...rollover.preview, error: 'No watcher runs in that home.', data: null };
  assert.match(rolloverCard(), /ro-preview scope-note error">No watcher runs in that home\./);
  // the confirmation says whether the ids were checked
  rollover.preview = { home: 'ha02f1cb9', kind: 'crew', ids: ['crew-a', 'crew-b'], loading: false, error: '', data: { results, eligible: 1 }, at: '09:07' };
  rollover.confirm = { kind: 'arm', home: 'ha02f1cb9', which: 'crew', ids: ['crew-a', 'crew-b'] };
  assert.match(rolloverCard(), /Checked at 09:07: 1 of 3 would roll\./);
  rollover.preview = null;
  assert.match(rolloverCard(), /The ids were not checked against the roller's rules\./);
});

test('rollover card: the page names only the rollover actions of this slice and builds every token itself', () => {
  const names = [...new Set((html.match(/api\.run\('rollover-[a-z-]+'|runRollover\('rollover-[a-z-]+'/g) || []).map(item => item.replace(/.*'(rollover-[a-z-]+)'/, '$1')))].sort();
  assert.deepEqual(names, ['rollover-arm', 'rollover-preview', 'rollover-state', 'rollover-stop', 'rollover-undo']);
  assert.equal(/rollover-primary|handoff-restart/.test(html), false, 'no primary action and no handoff-restart in the page yet');
  assert.match(html, /api\.run\('rollover-stop', \{\}\)/, 'Stop sends nothing but itself: no confirm, no typed text');
  assert.match(html, /const runStop = async \(\) => \{\s*if \(rollover\.stopping\) return;/, 'Stop does not wait for another request, and a second click while one Stop runs is ignored');
  assert.match(html, /confirm: `rollover-resume:\$\{home\.id\}`/, 'removing the off file carries the resume token');
  assert.match(html, /confirm: rolloverToken\(home\.id, ask\.which, ids\)/);
  assert.match(html, /\$\{body\}\$\{rolloverCard\(\)\}/, 'the card sits under the sessions table');
  assert.match(html, /if \(!rollover\.data && !rollover\.error && !rollover\.loading\) loadRollover\(\)/);
  assert.equal(/rollover[A-Za-z.]*\.(pick|confirm)\s*=\s*[^=].*localStorage/.test(html), false, 'nothing about a pending change is remembered across a reload');
  assert.equal(/navigator\.clipboard[^;]*rollover/.test(html), false);
});

test('the archive group has its own tab, and the Archives tab no longer holds the group card', () => {
  assert.match(html, /data-view="group"[^>]*>Archive group</);
  const group = html.slice(html.indexOf('<section id="group-section"'), html.indexOf('<section id="archives-section"'));
  assert.match(group, /id="batches"/);
  const archives = html.slice(html.indexOf('<section id="archives-section"'), html.indexOf('</main>'));
  assert.equal(archives.includes('id="batches"'), false, 'the group card is not on the Archives tab');
  assert.match(html, /document\.querySelector\('#group-section'\)\.hidden = state\.view !== 'group'/);
  assert.match(html, /VIEW_BADGES = \{[^}]*group:/);
});

test('the archive group card says it is one group per session that holds only archived workspaces', () => {
  const card = html.slice(html.indexOf('const batchTitle'), html.indexOf('document.querySelector(\'#batches\').addEventListener'));
  assert.match(card, /Archive group · \$\{batch\.herdr_session\}/);
  assert.match(card, /One group per session, holding only workspaces that are still archived/);
  assert.equal(/\[counts\.restored, 'restored'\]|\[counts\.deleted, 'deleted'\]/.test(card), false, 'restored and deleted members are not in the group, so they are not counted');
});

test('a tab shows a copy-only cd command for each working folder, quoted when the path needs it', () => {
  const view = html.slice(html.indexOf('const shellQuote'), html.indexOf('const workspaceView'));
  assert.match(view, /cd \$\{shellQuote\(folder\.path\)\}/);
  assert.match(view, /data-command="\$\{escapeHtml\(command\)\}"/);
  assert.equal(/api\.run/.test(view), false, 'showing a folder never calls the server');
  // Run the two helpers on real values.
  const code = view.slice(0, view.indexOf('// One line per distinct working folder'));
  const { shellQuote, folderCommand } = new Function(code + '; return { shellQuote, folderCommand };')();
  const root = '/Users/someone/.treehouse/firstmate-8bf1b0/3/firstmate/state/.treehouse/personal-1ab7cc/5/personal';
  assert.equal(folderCommand({ path: root }), 'cd ' + root);
  assert.equal(folderCommand({ path: '/Users/someone/My Work/it\'s' }), "cd '/Users/someone/My Work/it'\\''s'");
  assert.equal(folderCommand({ path: '/tmp/a;rm -rf x' }), "cd '/tmp/a;rm -rf x'");
  assert.equal(folderCommand({ path: 'relative/path' }), '');
  assert.equal(folderCommand({ path: '/tmp/a\nrm x' }), '');
  assert.equal(folderCommand({}), '');
  assert.match(view, /agent works in/);
  assert.match(view, /shell folder/);
});

test('with no archive group yet, adding tabs starts it, confirmed by the session name, copy-only', () => {
  const panel = html.slice(html.indexOf('const TAB_MODES'), html.indexOf('const archiveTabKey'));
  assert.match(panel, /!batchChoices\.length && SESSION_NAME_PATTERN\.test\(data\.herdr_session/);
  assert.match(panel, /add-tabs-to-batch \$\{tabArgs\}`/);
  assert.match(panel, /--execute --confirm \$\{newGroupSession\}/);
  assert.equal(/api\.run/.test(panel), false, 'the panel never calls the server');
});

test('a tab shows a copy button for each verified agent session id, and copying the id never calls the server', () => {
  const view = html.slice(html.indexOf('// One line per agent in the tab whose client session id is verified'), html.indexOf('const tabView'));
  assert.match(view, /Copy session id/);
  assert.match(view, /data-command="\$\{escapeHtml\(item\.session_id\)\}" data-copied="Session id copied"/);
  assert.equal(/api\.run/.test(view), false, 'showing a session id never calls the server');
  assert.match(html, /copy\(button\.dataset\.command, button\.dataset\.copied\)/);
  const { agentSessionsView } = new Function('escapeHtml', view + '; return { agentSessionsView };')(value => String(value));
  const id = '11111111-2222-4333-8444-555555555555';
  const one = agentSessionsView({ pane_count: 1, agent_sessions: [{ pane_id: 'w9Z:p1', client: 'claude', session_id: id }] });
  assert.match(one, /claude session/);
  assert.match(one, new RegExp('data-command="' + id + '"'));
  assert.equal(one.includes('w9Z:p1'), false, 'a one-pane tab does not need the pane id');
  const many = agentSessionsView({ pane_count: 2, agent_sessions: [{ pane_id: 'w9Z:p2', client: 'codex', session_id: id }] });
  assert.match(many, /w9Z:p2/);
  // Anything that is not a well-formed id is not offered for copying.
  assert.equal(agentSessionsView({ pane_count: 1, agent_sessions: [{ pane_id: 'w9Z:p1', client: 'claude', session_id: 'claude --resume x' }] }), '');
  assert.equal(agentSessionsView({ pane_count: 1 }), '');
});

function memberTabHelpers(context = { data: null }, archiveContext = { rows: new Map() }, stateExtra = {}) {
  const line = name => html.split('\n').find(row => row.trim().startsWith('const ' + name + ' = ')).trim();
  const view = html.slice(html.indexOf('const ARCHIVE_ID_PATTERN'), html.indexOf('const batchMemberView'));
  const leaderRules = html.slice(html.indexOf('const LEADER_WORKSPACE_LABEL = '), html.indexOf('const archiveTabKey = '));
  const plural = (count, one) => `${count} ${count === 1 ? one : one + 's'}`;
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return new Function('escapeHtml', 'plural', 'state', 'context', 'archiveContext', [line('SESSION_NAME_PATTERN'), line('TAB_ID_PATTERN'), line('WORKSPACE_ID_PATTERN'), line('archiveTabKey'), line('percentLevel'), leaderRules, view, 'return { memberPickKeys, memberTabsView, memberTabCommand, groupDestinations, groupTabDestination, groupLeaderDestination, archivedContextPill };'].join('\n'))(escapeHtml, plural, { groupTabDestinations: {}, selectedGroupTabs: new Set(), ...stateExtra }, context, archiveContext);
}

test('the archive group lists each archived workspace\'s tabs by name, with their pane counts', () => {
  const { memberTabsView } = memberTabHelpers();
  const out = memberTabsView({ workspace_label: 'esim', archive_id: 'a', tabs: [{ id: 'w9J:t2', label: 'leader-esim', pane_count: 1 }, { id: 'w9J:t3', label: '<b>x</b>', pane_count: 2 }] });
  assert.match(out, /leader-esim/);
  assert.match(out, /1 pane/);
  assert.match(out, /2 panes/);
  assert.equal(out.includes('<b>x</b>'), false, 'tab names are escaped');
  assert.equal(memberTabsView({ tabs: [] }), '');
  assert.equal(memberTabsView({}), '');
  assert.match(html, /\$\{flag\}<\/div>\$\{memberTabsView\(member, session, destination, batchId\)\}/);
});

test('the archive group shows how full each archived session\'s context was, from the gauge, before it is restored', () => {
  const data = { thresholds: { warn: 35, high: 60 }, rows: [
    { id: 'abcdef12', percent: 41.5, estimated: false },
    { id: 'abcdef12', percent: 12, estimated: false },
    { id: '99999999', percent: 70, estimated: true },
    { id: 'aaaaaaaa', percent: null, estimated: true },
  ] };
  const { archivedContextPill, memberTabsView } = memberTabHelpers({ data });
  assert.match(archivedContextPill({ agent_session_prefixes: ['abcdef12'] }), /pill warn[^>]*>41\.5%</, 'the fullest record of the session, amber from the warn threshold');
  assert.match(archivedContextPill({ agent_session_prefixes: ['99999999'] }), /pill bad[^>]*>~70%</, 'an estimate is marked and red from the high threshold');
  assert.equal(archivedContextPill({ agent_session_prefixes: ['aaaaaaaa'] }), '', 'no percent, no pill');
  assert.equal(archivedContextPill({ agent_session_prefixes: ['zzzzzzzz'] }), '', 'no gauge record, no pill');
  assert.equal(archivedContextPill({}), '');
  assert.match(memberTabsView({ workspace_label: 'w', archive_id: 'a', tabs: [{ id: 'w9J:t2', label: 'x', pane_count: 1, agent_session_prefixes: ['abcdef12'] }] }), /41\.5%/);
  assert.equal(memberTabHelpers().archivedContextPill({ agent_session_prefixes: ['abcdef12'] }), '', 'nothing before the gauge has been read');
  // A session the gauge does not know is read from its transcript; the gauge's own row still wins when both exist.
  const fromTranscript = memberTabHelpers({ data }, { rows: new Map([['zzzzzzzz', { id: 'zzzzzzzz', percent: 52, estimated: true }], ['abcdef12', { id: 'abcdef12', percent: 99, estimated: true }]]) }).archivedContextPill;
  assert.match(fromTranscript({ agent_session_prefixes: ['zzzzzzzz'] }), /pill warn[^>]*>~52%</);
  assert.match(fromTranscript({ agent_session_prefixes: ['abcdef12'] }), />41\.5%</, 'the gauge row wins');
  assert.match(html, /api\.run\('archive-context', \{ prefixes: wanted \}\)/);
  assert.match(html, /if \(state\.view === 'group'\) loadArchiveContext\(data\)/);
  assert.match(html, /state\.view === 'group' && !context\.data && !context\.loading\) loadContext\(\)/, 'opening the group reads the gauge');
});

test('the archive group offers a copy-only command that removes tabs held twice, and only when there are some', () => {
  const view = html.slice(html.indexOf('const batchView'), html.indexOf('const batchesView'));
  assert.match(view, /dedupe-group --batch \$\{id\} --execute --confirm \$\{id\}/);
  assert.match(view, /valid && duplicates\.length \? `<button class="danger"/, 'the button appears only when the snapshot lists duplicates');
  assert.ok(view.includes('escapeHtml(item.label)'), 'tab names are escaped');
  assert.match(view, /ARCHIVE_ID_PATTERN\.test\(item\.archive_id/, 'only well-formed ids are listed');
});

test('tabs picked inside the archive group restore into one workspace, one command per archive', () => {
  const key = (archive, tab) => `${archive}::${tab}`;
  const archiveA = '20261014-101500-esim';
  const archiveB = '20261014-101600-ops';
  const state = { groupTabDestinations: {}, groupPanelDestinations: {}, selectedGroupTabs: new Set([key(archiveA, 'w9J:t2'), key(archiveA, 'w9J:t4'), key(archiveB, 'w8K:t2')]), selectedGroupBatch: 'batch-20261014-101500' };
  const helpers = (stateValue = state) => {
    const line = name => html.split('\n').find(row => row.trim().startsWith('const ' + name + ' = ')).trim();
    const view = html.slice(html.indexOf('const groupPanelView'), html.indexOf('const archivedTabView'));
    const groupView = html.slice(html.indexOf('const ARCHIVE_ID_PATTERN'), html.indexOf('const memberTabsView'));
    const leaderRules = html.slice(html.indexOf('const LEADER_WORKSPACE_LABEL = '), html.indexOf('const archiveTabKey = '));
    const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return new Function('escapeHtml', 'state', [line('SESSION_NAME_PATTERN'), line('TAB_ID_PATTERN'), line('WORKSPACE_ID_PATTERN'), line('archiveTabKey'), leaderRules, groupView, view, 'return { groupPanelView };'].join('\n'))(escapeHtml, stateValue);
  };
  const tab = (id, unresumable = 0) => ({ id, label: id, pane_count: 1, resumable_agent_count: 1, unresumable_agent_count: unresumable });
  const batch = { batch_id: 'batch-20261014-101500', herdr_session: 'esim', members: [
    { archive_id: archiveA, status: 'archived', tabs: [tab('w9J:t2'), tab('w9J:t3'), tab('w9J:t4')] },
    { archive_id: archiveB, status: 'archived', tabs: [tab('w8K:t2')] },
  ] };
  const data = { herdr_session: 'esim', workspaces: [{ id: 'w9Z', label: 'one' }, { id: 'w9Y', label: 'two' }], batches: [batch] };
  const out = helpers().groupPanelView(data);
  assert.match(out, /3 selected/);
  const command = out.match(/class="primary"[^>]*data-command="([^"]*)"/)[1];
  const parts = command.split(' &amp;&amp; ');
  assert.equal(parts.length, 2, 'one restore per archive that gives up tabs');
  assert.equal(parts[0], `herdr-organizer --session esim restore-tabs --archive ${archiveA} --tab w9J:t2 --tab w9J:t4 --to-workspace w9Z --execute --confirm ${archiveA}`);
  assert.match(parts[1], new RegExp(`--archive ${archiveB} --tab w8K:t2 --to-workspace w9Z --execute --confirm ${archiveB}$`));
  // A tab with an unverified agent session blocks the whole command and says why.
  const blocked = helpers({ ...state, selectedGroupTabs: new Set([key(archiveA, 'w9J:t2')]) }).groupPanelView({ ...data, batches: [{ ...batch, members: [{ ...batch.members[0], tabs: [tab('w9J:t2', 1)] }] }] });
  assert.match(blocked, /data-command=""/);
  assert.match(blocked, /not verified/);
  // No selection, no panel; a group of another session has no destination.
  assert.equal(helpers({ ...state, selectedGroupTabs: new Set() }).groupPanelView(data), '');
  assert.match(helpers({ ...state, groupTabDestinations: {} }).groupPanelView({ ...data, herdr_session: 'other' }), /data-command=""/);
  assert.match(html, /document\.querySelector\('#move-panel'\)\.innerHTML = state\.view === 'archives' \? restorePanelView\(data\) : state\.view === 'group' \? groupPanelView\(data\)/);
});

test('the group panel never defaults an ordinary tab into leader-space and sends leader tabs only there', () => {
  const key = (archive, tab) => `${archive}::${tab}`;
  const archiveId = '20261014-101500-esim';
  const panel = (labels, workspaces) => {
    const line = name => html.split('\n').find(row => row.trim().startsWith('const ' + name + ' = ')).trim();
    const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const tabs = labels.map((label, index) => ({ id: `w9J:t${index + 2}`, label, pane_count: 1, resumable_agent_count: 1, unresumable_agent_count: 0 }));
    const state = { groupTabDestinations: {}, groupPanelDestinations: {}, selectedGroupBatch: 'batch-20261014-101500', selectedGroupTabs: new Set(tabs.map(tab => key(archiveId, tab.id))) };
    const view = new Function('escapeHtml', 'state', [line('SESSION_NAME_PATTERN'), line('TAB_ID_PATTERN'), line('WORKSPACE_ID_PATTERN'), line('archiveTabKey'), html.slice(html.indexOf('const LEADER_WORKSPACE_LABEL = '), html.indexOf('const archiveTabKey = ')), html.slice(html.indexOf('const ARCHIVE_ID_PATTERN'), html.indexOf('const memberTabsView')), html.slice(html.indexOf('const groupPanelView'), html.indexOf('const archivedTabView')), 'return { groupPanelView };'].join('\n'))(escapeHtml, state);
    const data = { herdr_session: 'esim', workspaces, batches: [{ batch_id: 'batch-20261014-101500', herdr_session: 'esim', members: [{ archive_id: archiveId, status: 'archived', workspace_label: 'esim (selected tabs)', tabs }] }] };
    return view.groupPanelView(data);
  };
  // leader-space is the first open workspace on the operator's machine.
  const workspaces = [{ id: 'wBK', label: 'leader-space' }, { id: 'wA8', label: 'esim' }, { id: 'wB1', label: 'nip' }];
  const ordinary = panel(['shell', 'claude'], workspaces);
  assert.match(ordinary, /--to-workspace wA8 /, 'the open workspace named like the archive is the default');
  assert.equal(ordinary.includes('wBK'), false, 'leader-space is not even listed for ordinary tabs');
  assert.match(panel(['shell'], [workspaces[0], workspaces[2]]), /--to-workspace wB1 /, 'without a name match, the first workspace that is not leader-space');
  const leaders = panel(['leader-esim', 'big-boss'], workspaces);
  assert.match(leaders, /--to-workspace wBK /);
  assert.equal(leaders.includes('wA8'), false, 'leader tabs are offered only leader-space');
  const mixed = panel(['leader-esim', 'shell'], workspaces);
  assert.match(mixed, /data-command=""/, 'a mixed selection builds no command');
  assert.match(mixed, /Leader tabs and other tabs cannot go into one workspace/);
  assert.match(panel(['leader-esim'], [workspaces[1]]), /no leader-space workspace is open/);
});

test('a leader tab in the group has its own resume button aimed at leader-space, an ordinary tab follows the picker', () => {
  const batch = { batch_id: 'batch-20261014-101500', herdr_session: 'esim' };
  const data = { herdr_session: 'esim', batches: [batch], workspaces: [{ id: 'wBK', label: 'leader-space' }, { id: 'wA8', label: 'esim' }] };
  const { memberTabsView, groupLeaderDestination } = memberTabHelpers({ data: null }, { rows: new Map() }, { data });
  assert.equal(groupLeaderDestination(batch.batch_id), 'wBK');
  assert.equal(groupLeaderDestination('unknown-batch'), '');
  const member = { archive_id: '20261014-101500-esim', status: 'archived', workspace_label: 'esim', tabs: [
    { id: 'w9J:t2', label: 'leader-esim', pane_count: 1, resumable_agent_count: 1, unresumable_agent_count: 0 },
    { id: 'w9J:t3', label: 'shell', pane_count: 1, resumable_agent_count: 1, unresumable_agent_count: 0 },
  ] };
  const out = memberTabsView(member, ' --session esim', 'wA8', batch.batch_id);
  assert.match(out, /--tab w9J:t2 --to-workspace wBK /, 'the leader tab goes to leader-space');
  assert.match(out, /--tab w9J:t3 --to-workspace wA8 /, 'the other tab goes where the picker says');
  const noLeaderSpace = memberTabHelpers({ data: null }, { rows: new Map() }, { data: { ...data, workspaces: [data.workspaces[1]] } });
  const blocked = noLeaderSpace.memberTabsView(member, ' --session esim', 'wA8', batch.batch_id);
  assert.equal(blocked.includes('--tab w9J:t2'), false, 'no leader-space open: the leader tab gets no command');
  assert.match(blocked, /no leader-space workspace is open/);
});

test('per-tab resume buttons go to the member\'s own open workspace unless the picker was used, and never to an unrelated one', () => {
  const batch = { batch_id: 'batch-20261014-101500', herdr_session: 'esim' };
  const data = { herdr_session: 'esim', batches: [batch], workspaces: [{ id: 'wBK', label: 'leader-space' }, { id: 'wBV', label: 'Herdr-Fix' }, { id: 'wCG', label: 'BC-43' }] };
  const { memberTabsView } = memberTabHelpers({ data: null }, { rows: new Map() }, { data });
  const tab = { id: 'w9J:t3', label: 'shell', pane_count: 1, resumable_agent_count: 1, unresumable_agent_count: 0 };
  const member = label => ({ archive_id: '20261014-101500-esim', status: 'archived', workspace_label: label, tabs: [tab] });
  assert.match(memberTabsView(member('BC-43 (selected tabs) (selected tabs)'), ' --session esim', '', batch.batch_id), /--tab w9J:t3 --to-workspace wCG /, 'the open workspace named like the archive');
  assert.match(memberTabsView(member('Herdr-Fix'), ' --session esim', '', batch.batch_id), /--to-workspace wBV /, 'another member in the same group goes to its own');
  assert.match(memberTabsView(member('BC-43'), ' --session esim', 'wBV', batch.batch_id), /--to-workspace wBV /, 'a workspace picked by the user wins');
  const none = memberTabsView(member('closed-one'), ' --session esim', '', batch.batch_id);
  assert.equal(none.includes('--to-workspace'), false, 'no workspace carries the name: no command, not the first workspace');
  assert.match(none, /Pick one in &quot;Resume tabs into&quot;/);
});

test('the group panel works out the default again for each selection and forgets a choice when the selection ends', () => {
  const key = (archive, tab) => `${archive}::${tab}`;
  const bc43 = '20261014-101500-bc43';
  const fix = '20261014-101600-fix';
  const line = name => html.split('\n').find(row => row.trim().startsWith('const ' + name + ' = ')).trim();
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tab = id => ({ id, label: 'shell', pane_count: 1, resumable_agent_count: 1, unresumable_agent_count: 0 });
  const batch = { batch_id: 'batch-20261014-101500', herdr_session: 'esim', members: [
    { archive_id: bc43, status: 'archived', workspace_label: 'BC-43 (selected tabs)', tabs: [tab('w1:t2')] },
    { archive_id: fix, status: 'archived', workspace_label: 'Herdr-Fix', tabs: [tab('w2:t2')] },
  ] };
  const data = { herdr_session: 'esim', workspaces: [{ id: 'wBK', label: 'leader-space' }, { id: 'wBV', label: 'Herdr-Fix' }, { id: 'wCG', label: 'BC-43' }], batches: [batch] };
  const state = { groupTabDestinations: {}, groupPanelDestinations: {}, selectedGroupBatch: batch.batch_id, selectedGroupTabs: new Set() };
  const { groupPanelView } = new Function('escapeHtml', 'state', [line('SESSION_NAME_PATTERN'), line('TAB_ID_PATTERN'), line('WORKSPACE_ID_PATTERN'), line('archiveTabKey'), html.slice(html.indexOf('const LEADER_WORKSPACE_LABEL = '), html.indexOf('const archiveTabKey = ')), html.slice(html.indexOf('const ARCHIVE_ID_PATTERN'), html.indexOf('const memberTabsView')), html.slice(html.indexOf('const groupPanelView'), html.indexOf('const archivedTabView')), 'return { groupPanelView };'].join('\n'))(escapeHtml, state);
  state.selectedGroupTabs = new Set([key(fix, 'w2:t2')]);
  assert.match(groupPanelView(data), /--to-workspace wBV /, 'first selection: the insurance member\'s workspace');
  state.selectedGroupTabs = new Set([key(bc43, 'w1:t2')]);
  assert.match(groupPanelView(data), /--to-workspace wCG /, 'second selection in the same group: its own workspace, not the first one\'s');
  assert.deepEqual(state.groupPanelDestinations, {}, 'rendering stores nothing');
  state.groupPanelDestinations[batch.batch_id] = 'wBV';
  assert.match(groupPanelView(data), /--to-workspace wBV /, 'a choice the user made stays while the selection lasts');
  state.selectedGroupTabs = new Set();
  assert.equal(groupPanelView(data), '');
  assert.deepEqual(state.groupPanelDestinations, {}, 'the choice ends with the selection');
  state.selectedGroupTabs = new Set([key(bc43, 'w1:t2')]);
  assert.match(groupPanelView(data), /--to-workspace wCG /, 'the next selection starts from its own default again');
});

test('the snapshot restore buttons are disabled when any snapshot member was captured after the last boot, with a deliberate way around it', () => {
  const start = html.indexOf('const snapshotNotRebooted = ');
  const vm = require('node:vm');
  const { snapshotNotRebooted } = vm.runInNewContext(`${html.slice(start, html.indexOf('const NOT_REBOOTED_REASON'))}; ({ snapshotNotRebooted })`, {});
  const boot = '2026-10-25T00:00:00Z';
  const archives = [{ archive_id: 'a1', created_at: '2026-10-25T02:00:00Z' }, { archive_id: 'a2', created_at: '2026-10-24T20:00:00Z' }, { archive_id: 'a3', created_at: 'not a time' }];
  assert.equal(snapshotNotRebooted([{ archive_id: 'a1' }], archives, boot), true, 'captured after boot: the workspaces are still open');
  assert.equal(snapshotNotRebooted([{ archive_id: 'a2' }], archives, boot), false, 'captured before boot: the restart happened');
  assert.equal(snapshotNotRebooted([{ archive_id: 'a1' }, { archive_id: 'a2' }], archives, boot), true, 'one member left over from before the boot does not switch the guard off');
  assert.equal(snapshotNotRebooted([{ archive_id: 'a2' }, { archive_id: 'a3' }, { archive_id: 'missing' }], archives, boot), false, 'unreadable times add nothing');
  assert.equal(snapshotNotRebooted([{ archive_id: 'a3' }], archives, boot), false, 'an unreadable time never blocks');
  assert.equal(snapshotNotRebooted([{ archive_id: 'missing' }], archives, boot), false, 'a member with no archive never blocks');
  assert.equal(snapshotNotRebooted([{ archive_id: 'a1' }], archives, undefined), false, 'no boot time never blocks');
  assert.equal(snapshotNotRebooted([], archives, boot), false);
  assert.match(html, /snapshotCount && notRebooted \? `<button class="primary" type="button" disabled/, 'the primary button is disabled with the reason');
  assert.match(html, /Copy anyway \(computer not restarted\)/, 'a Herdr-only restart can still copy the command, on purpose');
  assert.match(html, /canRestore && !notRebooted \? `data-command="\$\{escapeHtml\(resume\)\}"` : 'disabled'/, 'restore all restores snapshot members too, so the same guard disables it');
});

test('the archive group can select every tab of one archived workspace at once, and a stacked mark reads once', () => {
  const { memberPickKeys } = memberTabHelpers();
  const archiveId = '20261014-101500-esim';
  const tab = id => ({ id, label: id, pane_count: 1 });
  assert.deepEqual(memberPickKeys({ archive_id: archiveId, status: 'archived', tabs: [tab('w9J:t2'), tab('w9J:t3'), { id: 'bad id', label: 'x' }, { id: 'w9J:t4', label: '' }] }),
    [`${archiveId}::w9J:t2`, `${archiveId}::w9J:t3`], 'only well-formed, named tabs can be picked');
  assert.deepEqual(memberPickKeys({ archive_id: archiveId, status: 'restored', tabs: [tab('w9J:t2')] }), [], 'a restored workspace offers nothing');
  assert.deepEqual(memberPickKeys({ archive_id: 'bad id', status: 'archived', tabs: [tab('w9J:t2')] }), []);
  assert.match(html, /pickKeys\.length > 1 \? `<button type="button" class="small-btn" data-select-group-member=/, 'a workspace with one tab needs no shortcut');
  const tidy = new Function(html.split('\n').find(row => row.trim().startsWith('const tidyLabel = ')).trim() + '\nreturn tidyLabel;')();
  assert.equal(tidy('leader-space (selected tabs) (selected tabs)'), 'leader-space (selected tabs)');
  assert.equal(tidy('crew'), 'crew');
  assert.equal(tidy(null), '');
});

test('context view: only sessions with a live pane are listed', () => {
  const view = html.slice(html.indexOf('const renderContext'), html.indexOf('const copyHandoff'));
  assert.match(view, /allRows\.filter\(row => row\.pane_id\)/);
});

test('an archived workspace in the group offers to resume one tab into an open workspace', () => {
  const { memberTabsView, memberTabCommand, groupDestinations, groupTabDestination } = memberTabHelpers();
  const archiveId = '20261014-101500-esim';
  const member = { archive_id: archiveId, status: 'archived', workspace_label: 'esim', tabs: [
    { id: 'w9J:t2', label: 'esim-shell', pane_count: 1, resumable_agent_count: 1, unresumable_agent_count: 0 },
    { id: 'w9J:t3', label: 'unverified', pane_count: 1, resumable_agent_count: 0, unresumable_agent_count: 1 },
  ] };
  assert.equal(memberTabCommand(member, member.tabs[0], ' --session esim', 'w9Z'),
    `herdr-organizer --session esim restore-tab --archive ${archiveId} --tab w9J:t2 --to-workspace w9Z --execute --confirm ${archiveId}`);
  const out = memberTabsView(member, ' --session esim', 'w9Z');
  assert.match(out, /--tab w9J:t2 --to-workspace w9Z/);
  assert.equal(out.includes('--tab w9J:t3'), false, 'a tab with an unverified agent session gets no command');
  assert.match(out, /disabled/);
  // Nothing is offered without a destination, for a workspace that is no longer archived, or for odd ids.
  assert.equal(memberTabCommand(member, member.tabs[0], '', ''), '');
  assert.equal(memberTabCommand({ ...member, status: 'restored' }, member.tabs[0], '', 'w9Z'), '');
  assert.equal(memberTabCommand(member, { id: 'w9J:t2; rm -rf x', label: 'x' }, '', 'w9Z'), '');
  assert.equal(memberTabCommand(member, member.tabs[0], '', 'w9Z; rm'), '');
  assert.equal(memberTabCommand({ ...member, archive_id: 'bad id' }, member.tabs[0], '', 'w9Z'), '');
  assert.equal(memberTabsView({ ...member, status: 'restored' }, '', 'w9Z').includes('Copy resume tab'), false);
  // Only open workspaces of the group's own session are offered.
  const data = { herdr_session: 'esim', workspaces: [{ id: 'w9Z', label: 'one' }, { id: 'w9Y', label: 'two' }] };
  assert.equal(groupDestinations({ herdr_session: 'esim' }, data).length, 2);
  assert.deepEqual(groupDestinations({ herdr_session: 'other' }, data), []);
  assert.equal(groupTabDestination({ batch_id: 'b1' }, data.workspaces), '', 'nothing chosen: the picker does not decide, each tab uses its own workspace');
});

test('context view: read-only, fetched through the organizer API, and escapes what it prints', () => {
  const view = html.slice(html.indexOf('// ---- Context view'), html.indexOf('// ---- Snapshot-backed views'));
  assert.match(view, /api\.run\('context-gauge'\)/);
  assert.equal(/fetch\(|confirm:|data-command/.test(view), false, 'no raw fetch, no write token, no copied command');
  assert.match(view, /api\.run\('leader-space'\)/);
  for (const field of ['row.map', 'row.kind', 'row.id', 'row.title', 'row.herdr_session', 'row.pane_id', 'row.busy', 'row.leader.label', 'row.problem.label', 'row.problem.state', 'pane.herdr_session', 'pane.pane_id', 'item.label', 'item.state', 'item.herdr_session', 'item.pane_id']) assert.match(view, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}`), field);
  assert.match(view, /escapeHtml\(sessionName\(row\)\)/, 'the tab label is printed escaped');
  assert.match(html, /data-view="context"/);
});

test('context view: the Claude plan rail reads through plan-usage only, prints escaped, and never states a run-out the window outlasts', () => {
  const view = html.slice(html.indexOf('// ---- Context view'), html.indexOf('// ---- Snapshot-backed views'));
  assert.match(view, /api\.run\('plan-usage', fresh \? \{ fresh: true \} : \{\}\)/);
  for (const field of ['planName(item)', 'plan.error', 'readStamp(plan)', 'note.text', 'reset']) assert.ok(view.includes(`escapeHtml(${field}`), field);
  assert.match(view, /Date\.parse\(item\.projected_exhausted_at\) < Date\.parse\(item\.resets_at\)/, 'a run-out after the reset is not a run-out');
  assert.match(view, /plan-reload/);
});

test('context view: the Codex credit chips read through codex-credits only and print escaped', () => {
  const view = html.slice(html.indexOf('// ---- Context view'), html.indexOf('// ---- Snapshot-backed views'));
  assert.match(view, /api\.run\('codex-credits'\)/);
  for (const field of ['name', 'title', 'codex.error']) assert.ok(view.includes(`escapeHtml(${field}`), field);
  assert.match(view, /\$\{planRail\(\)\}\$\{codexRail\(\)\}/, 'the Codex row sits right under the Claude row');
  assert.equal(/auth\.json|access_token|Bearer/.test(view), false, 'the page never touches a credential');
});

test('the snapshot command needs no preview of the command that closes everything', () => {
  const start = html.indexOf('const snapshotExecuteCommand = ');
  const vm = require('node:vm');
  const { snapshotExecuteCommand } = vm.runInNewContext(`const SESSION_NAME_PATTERN = ${html.split('\n').find(row => row.trim().startsWith('const SESSION_NAME_PATTERN = ')).trim().replace(/^const SESSION_NAME_PATTERN = /, '').replace(/;$/, '')};${html.slice(start, html.indexOf('const archiveAllView = '))}; ({ snapshotExecuteCommand })`, {});
  const command = 'herdr-organizer --session esim archive-all --snapshot --execute --confirm esim';
  assert.equal(snapshotExecuteCommand(null, false, 'esim'), command, 'no preview run: built from the validated session');
  assert.equal(snapshotExecuteCommand(null, false, 'bad name; rm'), '', 'an unvalidated session builds nothing');
  assert.equal(snapshotExecuteCommand(null, false, ''), '');
  assert.equal(snapshotExecuteCommand({ commands: { snapshot: command } }, false, 'esim'), command, 'a preview that offers it wins');
  assert.equal(snapshotExecuteCommand({ commands: { snapshot: '' } }, false, 'esim'), '', 'a preview that found nothing to save offers nothing');
  assert.equal(snapshotExecuteCommand({ commands: { snapshot: command } }, true, 'esim'), '', 'a stale preview offers nothing');
});

test('archive all offers a copy-only snapshot command and the group marks snapshot members', () => {
  assert.match(html, /const canSnapshot = Boolean\(snapshotCommand\);/, 'the button is on whenever there is a command');
  assert.match(html, /data-aa-copy="\$\{escapeHtml\(snapshotCommand\)\}"/, 'copy-only');
  assert.match(html, /Copy snapshot for restart/);
  assert.match(html, /data-aa-copy="\$\{escapeHtml\(snapshotPreviewCommand\)\}"/, 'the preview-only snapshot command is copied');
  assert.match(html, /result\?\.commands\?\.snapshot_preview/, 'it comes from the preview, with a fallback built from the session');
  assert.match(html, /Copy snapshot preview/);
  assert.match(html, /\$\{base\} --snapshot-only --resume-agents --execute --confirm \$\{id\}/, 'the group has a command that restores only the snapshot members');
  assert.match(html, /Copy restore snapshot \+ resume agents/);
  assert.match(html, /<h3>Save a snapshot before a restart<\/h3>/, 'the snapshot has its own card');
  assert.match(html, /member\.snapshot \? `<span class="pill"[^`]*>snapshot · \$\{plural\(\(member\.tabs \|\| \[\]\)\.length, 'tab'\)\}<\/span>`/, 'a snapshot member shows its tab count');
  assert.match(html, /Snapshot: \$\{plural\(snapshotCount, 'workspace'\)\} · \$\{plural\(snapshotTabs, 'tab'\)\}/, 'the group line says how many workspaces and tabs the snapshot holds');
});

test('context view: the Codex month chip reads against the limit the server sends, with the Claude amber and red lines', () => {
  const view = html.slice(html.indexOf('// ---- Context view'), html.indexOf('// ---- Snapshot-backed views'));
  assert.equal(/CODEX_MONTH_LIMIT/.test(html), false, 'the page holds no limit of its own');
  assert.match(view, /usd_per_credit: rate, month_limit: limit \} = codex\.data/, 'the limit arrives with the rate');
  assert.match(view, /const percent = item\.credits \/ limit \* 100;\s*const level = planLevel\(percent\)/);
  assert.match(view, /codexMonthChip\(month, `[^`]*`, limit\)/, 'the month chip uses the limit view and the week chip stays plain');
  assert.match(view, /Over the \$\{limit\.toLocaleString\(\)\} limit by/, 'going over the limit is said in the tooltip');
  assert.match(view, /Number\.isFinite\(limit\) \? codexMonthChip/, 'a server that sends no limit shows no month chip instead of NaN');
});

test('context view: a rail says when its last read failed, not an old update time', () => {
  const start = html.indexOf('const readStamp = ');
  const vm = require('node:vm');
  const { readStamp } = vm.runInNewContext(`${html.slice(start, html.indexOf('const planClock'))}; ({ readStamp })`, {});
  assert.equal(readStamp({ at: '', failedAt: '' }), 'not read yet');
  assert.equal(readStamp({ at: '10:15', failedAt: '' }), 'updated 10:15');
  assert.equal(readStamp({ at: '', failedAt: '10:20' }), 'failed 10:20');
  // The loaders clear the old time on a failure and clear the failure on a success.
  const loaders = html.slice(html.indexOf('const loadPlan = '), html.indexOf('// Re-read while the Context tab is open'));
  assert.equal((loaders.match(/plan\.at = ''; plan\.failedAt = planClock/g) || []).length, 1);
  assert.equal((loaders.match(/codex\.at = ''; codex\.failedAt = planClock/g) || []).length, 1);
  assert.match(loaders, /plan\.failedAt = '';/);
  assert.match(loaders, /codex\.failedAt = '';/);
});

test('selected tabs panel: each mode states its effect in a visible line, not only in a tooltip', () => {
  const panel = html.slice(html.indexOf('const MODE_LINES = '), html.indexOf('const detail = mode === \'batch\''));
  for (const mode of ['move', 'archive', 'batch']) assert.match(panel, new RegExp(`${mode}: '[^']*closes`, 'i'), mode);
  assert.match(panel, /archive: '[^']*stops their processes/, 'the destructive effect of Archive is spelled out');
  assert.match(panel, /move: '[^']*stops their processes[^']*resumes verified agent sessions/, 'Move says processes stop and only verified agents come back');
  assert.match(html, /<p class="mp-note" id="mode-effect">\$\{escapeHtml\(MODE_LINES\[mode\]\)\}<\/p>/, 'the line is in the panel, escaped');
});

test('context view: a chip is coloured by the percent it prints', () => {
  const start = html.indexOf('const PLAN_WARN = 70');
  const vm = require('node:vm');
  const { planLevel } = vm.runInNewContext(`${html.slice(start, html.indexOf('const planClock'))}; ({ planLevel })`, {});
  assert.equal(planLevel(69.4), '', 'reads 69%, not amber');
  assert.equal(planLevel(69.6), 'warn', 'reads 70%, amber');
  assert.equal(planLevel(84.4), 'warn');
  assert.equal(planLevel(84.6), 'bad', 'reads 85%, red');
  assert.equal(planLevel(102), 'bad');
  assert.equal(planLevel(0), '');
  assert.match(html, /const level = planLevel\(item\.percent_used\);/, 'the Claude chips use the same rule');
});

test('workspaces view: the compact toggle shows names and tick boxes only, escaped, and is remembered safely', () => {
  const view = html.slice(html.indexOf('const compactTabView'), html.indexOf('const workspaceView'));
  assert.match(view, /data-select-tab="\$\{escapeHtml\(tab\.id\)\}"/, 'compact rows keep the selection tick box');
  for (const field of ['tab.label', 'workspace.label']) assert.ok(view.includes(`escapeHtml(${field}`), field);
  // The one copy button copies the tab's own name, escaped, so a tab can be referred to quickly. No command and no folder lines.
  assert.match(view, /class="copy-name" data-command="\$\{escapeHtml\(tab\.label\)\}" data-copied="Tab name copied"/);
  assert.equal((view.match(/data-command/g) || []).length, 1, 'compact view carries no command buttons or folder lines');
  assert.equal(/Copy (move|archive|cleanup|restore)/.test(view), false);
  assert.match(html, /try \{ return localStorage\.getItem\(COMPACT_KEY\) === '1'; \} catch \{ return false; \}/);
  assert.match(html, /workspaces\.map\(state\.compact \? compactWorkspaceView : workspaceView\)/);
  // Names wrap in the compact Workspaces view so a phone shows them in full; the Context rows wrap the same way (next test).
  assert.match(html, /\.workspaces\.compact \.compact-tab \.tab-name \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/);
  assert.doesNotMatch(html, /\.workspaces\.compact \.workspace-title strong \{[^}]*white-space: normal/, 'workspace names keep their one line');
});

test('phone layout: Context session names wrap instead of being cut, and the header stops sticking on a narrow screen', () => {
  assert.match(html, /\.ctx-compact \.compact-tab \.tab-name \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/);
  assert.doesNotMatch(html, /\.ctx-compact \.compact-tab \.tab-name \{[^}]*text-overflow: ellipsis/, 'no ellipsis on a session name');
  assert.match(html, /@media \(max-width: 600px\) \{ \.topbar \{ position: static; \} \.controls \{ flex-wrap: wrap; \} \.search \{ flex: 1 1 100%; \} \.move-panel \.mode-row \{ margin-left: 0; \} \}/, 'the filter has its own row on a phone, and the mode buttons start at the left edge');
  assert.match(html, /@media \(max-width: 640px\) \{ \.summary \{ gap: 8px;[^}]*\} \.metric \{ min-height: 0;/, 'the three counts stay in one row on a phone');
  assert.equal(/@media \(max-width: 640px\) \{ \.summary \{ grid-template-columns: 1fr;/.test(html), false);
  assert.match(html, /\.toast \{[^}]*max-width: calc\(100vw - 48px\); overflow-wrap: anywhere/, 'a long message stays inside the screen');
});

test('context view: the handoff request command is built by the server from ticked identities, never by the page', () => {
  const view = html.slice(html.indexOf('// ---- Context view'), html.indexOf('// ---- Snapshot-backed views'));
  assert.match(view, /api\.run\('handoff-command', \{ labels, panes \}\)/);
  assert.equal(/herdr --session|send-text|send-keys/.test(view), false, 'the page never assembles the shell command');
  assert.equal(/picked\.set\(row\.label/.test(view), false, 'no session starts ticked: the only writer of a tick is the box itself');
});

// Runs the page's own pick-key and prune functions on plain rows, so the check is of the shipped code and not of a copy.
function pickFunctions() {
  const start = html.indexOf('const pickKeyOf = ');
  const end = html.indexOf('const percentLevel = ');
  const vm = require('node:vm');
  return vm.runInNewContext(`${html.slice(start, end)}; ({ pickKeyOf, prunePicks })`, {});
}

test('context view: a tick is keyed by session, pane and session id, and a reload drops ticks whose session changed', () => {
  const { pickKeyOf, prunePicks } = pickFunctions();
  const row = (id, pane) => ({ id, herdr_session: 'project-a', pane_id: pane, leader: null });
  assert.equal(pickKeyOf(row('aaaaaaaa', 'wC1:p3')), 'project-a|wC1:p3|aaaaaaaa');
  assert.equal(pickKeyOf({ ...row('', 'wC1:p3') }), '', 'a pane with no session id is not pickable');
  assert.equal(pickKeyOf({ ...row('bbbbbbbb', 'wK:p2'), leader: { label: 'leader-esim' } }), 'leader-esim', 'a leader keeps its label key');
  // Session X is ticked in wC1:p3; the next load shows session Y in the same pane, and X is gone.
  const picked = new Map([['project-a|wC1:p3|aaaaaaaa', true], ['project-a|wC1:p4|cccccccc', true], ['leader-esim', true]]);
  prunePicks(picked, [row('dddddddd', 'wC1:p3'), row('cccccccc', 'wC1:p4'), { ...row('', 'wK:p2'), leader: { label: 'leader-esim' } }]);
  assert.deepEqual([...picked.keys()].sort(), ['leader-esim', 'project-a|wC1:p4|cccccccc'], 'the pane that now runs another session is not ticked');
  assert.equal(picked.get(pickKeyOf(row('dddddddd', 'wC1:p3'))), undefined, 'the new session in the reused pane starts unticked');
});

// Runs the page's own destination rules on plain data, so the check is of the shipped code and not of a copy.
function destinationFunctions() {
  const start = html.indexOf('const LEADER_WORKSPACE_LABEL = ');
  const end = html.indexOf('const archiveTabKey = ');
  const vm = require('node:vm');
  return vm.runInNewContext(`${html.slice(start, end)}; ({ isLeaderTabLabel, restoreDestinations, ownWorkspace, defaultDestination, chosenOrDefaultDestination })`, {});
}

test('restore destinations: leader-space is offered only for leader tabs, and the default is the workspace with the archive\'s own name', () => {
  const { isLeaderTabLabel, restoreDestinations, ownWorkspace, defaultDestination, chosenOrDefaultDestination } = destinationFunctions();
  // leader-space is first in the list, as it is on the operator's machine.
  const workspaces = [{ id: 'wBK', label: 'leader-space' }, { id: 'wA8', label: 'esim' }, { id: 'wB1', label: 'nip' }];
  const tab = label => ({ label });
  assert.deepEqual(['big-boss', 'leader-esim', 'leader-x'].map(isLeaderTabLabel), [true, true, true]);
  assert.deepEqual(['leader-', 'esim', '', undefined, 'my-leader-tab'].map(isLeaderTabLabel), [false, false, false, false, false]);
  assert.deepEqual(restoreDestinations(workspaces, [tab('shell'), tab('claude')]).map(item => item.id), ['wA8', 'wB1'], 'ordinary tabs never see leader-space');
  assert.deepEqual(restoreDestinations(workspaces, [tab('leader-esim'), tab('big-boss')]).map(item => item.id), ['wBK'], 'leader tabs see only leader-space');
  assert.equal(restoreDestinations(workspaces, [tab('leader-esim'), tab('shell')]).length, 0, 'a mix has no destination');
  // The first open workspace is leader-space, yet an ordinary selection defaults to the workspace named like its archive.
  const offered = restoreDestinations(workspaces, [tab('shell')]);
  assert.equal(defaultDestination(offered, ['nip (selected tabs)']), 'wB1');
  assert.equal(defaultDestination(offered, ['no such workspace']), 'wA8', 'without a match, the first offered one, never leader-space');
  assert.equal(defaultDestination([], ['esim']), '');
  assert.equal(ownWorkspace(offered, ['nip (selected tabs) (selected tabs)']), 'wB1');
  assert.equal(ownWorkspace(offered, ['no such workspace']), '', 'no name match is not a guess');
  const chosen = {};
  assert.equal(chosenOrDefaultDestination(chosen, 'k', offered, ['esim']), 'wA8');
  assert.deepEqual(chosen, {}, 'a default is never stored, so it cannot carry into the next selection');
  assert.equal(chosenOrDefaultDestination(chosen, 'k', offered, ['nip']), 'wB1', 'the next selection gets its own default');
  chosen.k = 'wB1';
  assert.equal(chosenOrDefaultDestination(chosen, 'k', offered, ['esim']), 'wB1', 'a destination the user picked stays while it is offered');
  chosen.k = 'wBK';
  assert.equal(chosenOrDefaultDestination(chosen, 'k', offered, ['esim']), 'wA8', 'a stale choice of leader-space is replaced');
});

test('restore destinations: every restore panel and per-tab button follows the leader convention', () => {
  assert.match(html, /restoreDestinations\(data\.workspaces \|\| \[\], selected\.map/, 'the single-archive panel');
  assert.match(html, /restoreDestinations\(groupDestinations\(batch, data\), pickedTabs\)/, 'the group panel');
  assert.match(html, /groupDestinations\(batch, state\.data\)\.filter\(workspace => workspace\.label !== LEADER_WORKSPACE_LABEL\)/, 'the group picker offers no leader-space');
  assert.match(html, /const target = leader \? groupLeaderDestination\(batchId\) : \(destination \|\| memberOwnDestination\(member, batchId\)\);/, 'a leader tab targets leader-space on its own, another tab its own workspace unless the picker says otherwise');
  assert.equal(/groupTabDestination\(batch, [A-Za-z]*\)[^;]*\[0\]/.test(html), false, 'no destination falls back to the first workspace of the list');
  assert.equal(html.includes('keepOrDefaultDestination'), false, 'only the change handlers store a destination');
});

test('context view: the compact toggle keeps the tick box, puts the percent next to the name, and is remembered safely', () => {
  const view = html.slice(html.indexOf('const contextCompactRow'), html.indexOf('const contextRow = '));
  assert.match(view, /handoffPickBox\(row\)/, 'compact rows keep the handoff tick box');
  assert.ok(view.indexOf('escapeHtml(sessionName(row))') < view.indexOf('contextPercent(row'), 'the percent follows the session name');
  assert.match(html, /try \{ return localStorage\.getItem\(CONTEXT_COMPACT_KEY\) === '1'; \} catch \{ return false; \}/);
  assert.match(html, /context\.compact \? `<div class="ctx-compact">/);
});

test('context table: every session row has an Open button that sends only a session name, pane id and the row\'s 8-character session id', () => {
  assert.match(html, /const openTabButton = row => row\.pane_id && row\.herdr_session && row\.id/);
  assert.match(html, /\$\{openTabButton\(row\)\}<\/td><\/tr>/, 'the table row carries it');
  assert.match(html, /\$\{contextPercent\(row, contextLevel\(row, thresholds\)\)\}\$\{openTabButton\(row\)\}<\/label>/, 'and so does the compact row');
  const handler = html.slice(html.indexOf('const openTab = async'), html.indexOf('const copyHandoff'));
  assert.match(handler, /api\.run\('focus-tab', \{ session: button\.dataset\.session, pane_id: button\.dataset\.pane, id: button\.dataset\.id \}\)/);
  assert.equal(/tab_id|command|args/.test(handler), false, 'the page names no tab and builds no command');
});
