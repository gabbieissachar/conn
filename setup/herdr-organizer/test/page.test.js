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
  assert.match(view, /canRestore \? `data-command="\$\{escapeHtml\(resume\)\}"`/);
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

function memberTabHelpers() {
  const line = name => html.split('\n').find(row => row.trim().startsWith('const ' + name + ' = ')).trim();
  const view = html.slice(html.indexOf('const ARCHIVE_ID_PATTERN'), html.indexOf('const batchMemberView'));
  const plural = (count, one) => `${count} ${count === 1 ? one : one + 's'}`;
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return new Function('escapeHtml', 'plural', 'state', [line('SESSION_NAME_PATTERN'), line('TAB_ID_PATTERN'), line('WORKSPACE_ID_PATTERN'), view, 'return { memberTabsView, memberTabCommand, groupDestinations, groupTabDestination };'].join('\n'))(escapeHtml, plural, { groupTabDestinations: {} });
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
  assert.match(html, /\$\{flag\}<\/div>\$\{memberTabsView\(member, session, destination\)\}/);
});

test('an archived workspace in the group offers to resume one tab into an open workspace', () => {
  const { memberTabsView, memberTabCommand, groupDestinations, groupTabDestination } = memberTabHelpers();
  const archiveId = '20261014-101500-esim';
  const member = { archive_id: archiveId, status: 'archived', workspace_label: 'esim', tabs: [
    { id: 'w9J:t2', label: 'leader-esim', pane_count: 1, resumable_agent_count: 1, unresumable_agent_count: 0 },
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
  // Only open workspaces of the group's own session are offered, and the first one is the default.
  const data = { herdr_session: 'esim', workspaces: [{ id: 'w9Z', label: 'one' }, { id: 'w9Y', label: 'two' }] };
  assert.equal(groupDestinations({ herdr_session: 'esim' }, data).length, 2);
  assert.deepEqual(groupDestinations({ herdr_session: 'other' }, data), []);
  assert.equal(groupTabDestination({ batch_id: 'b1' }, data.workspaces), 'w9Z');
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
  for (const field of ['planName(item)', 'plan.error', 'plan.at', 'note.text', 'reset']) assert.ok(view.includes(`escapeHtml(${field}`), field);
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

test('context view: the handoff request command is built by the server from ticked identities, never by the page', () => {
  const view = html.slice(html.indexOf('// ---- Context view'), html.indexOf('// ---- Snapshot-backed views'));
  assert.match(view, /api\.run\('handoff-command', \{ labels, panes \}\)/);
  assert.equal(/herdr --session|send-text|send-keys/.test(view), false, 'the page never assembles the shell command');
  assert.match(view, /AT_PROMPT = new Set\(\['idle', 'done'\]\)/, 'sessions at their prompt start ticked');
});
