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
  const view = html.slice(html.indexOf('const batchView = batch'), html.indexOf('const batchesView'));
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

const baseAa = () => ({ checking: {}, checkStarted: {}, applying: false });
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
  restart.applyResult.esim = { written: 3, skipped: 0 };
  const done = loadPaneView(restart, baseAa()).view('esim', pane);
  assert.match(done, /registered/);
  assert.match(done, /Preview again to include this workspace/);
  assert.equal(/Apply verified identities/.test(done), false);
});

test('skipped pane: a pane the check did not list asks for a fresh check instead of a dead end', () => {
  const out = loadPaneView(baseRestart([{ pane_id: 'w9:p9', verified: false, classification: 'unresolved', candidates: 0 }]), baseAa()).view('esim', pane);
  assert.match(out, /Check again/);
  assert.equal(/<form/.test(out), false);
});
