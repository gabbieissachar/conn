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

test('skipped pane: before the identity check there is only a check button, never an id form', () => {
  const { view } = loadPaneView(baseRestart(null), baseAa());
  const out = view('esim', pane);
  assert.match(out, /Check identity/);
  assert.equal(/Set session id|<form/.test(out), false);
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
  assert.match(panel, /Run Archive all first/);
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
