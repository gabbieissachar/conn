'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parse = require('../parse');
const { fixture } = require('./helpers');

test('verifier report: rows, quoting, hints and summary', () => {
  const report = parse.parseVerifierReport(fixture('verify-report.txt'));
  assert.equal(report.rows.length, 3);
  const [native, ambiguous, unresolved] = report.rows;
  assert.deepEqual({ c: native.classification, v: native.verified, p: native.pane_id, n: native.candidates, e: native.exact }, { c: 'native_verified', v: true, p: 'w1:p1', n: 1, e: 1 });
  assert.deepEqual(native.evidence, ['cwd_candidate', 'native_claude', 'store_header']);
  assert.equal(ambiguous.verified, false);
  assert.match(ambiguous.hint, /confirm manually/);
  assert.equal(unresolved.workspace_label, "Beta's space", 'python repr double-quoted label');
  assert.deepEqual(unresolved.evidence, []);
  assert.deepEqual(report.summary, { total: 3, verified: { native: 1, argv: 0, handle: 0, pid_record: 0 }, ambiguous: 1, unresolved: 1, safe_to_apply: 1, manual: 2 });
});

test('verifier report never keeps a session id even if the tool printed one', () => {
  const line = "native_verified workspace='W' tab='T' pane='[pane]' pane_id=w1:p1 candidates=1 exact=1 evidence=store_header session_id=11111111-2222-4333-8444-555555555555";
  const row = parse.parseVerifierLine(line);
  assert.ok(row);
  assert.equal(JSON.stringify(row).includes('11111111'), false);
});

test('verifier parser skips lines it does not recognise', () => {
  assert.equal(parse.parseVerifierLine('garbage'), null);
  assert.equal(parse.parseVerifierLine("mystery_class workspace='W' tab='T' pane='[pane]' pane_id=w1:p1 candidates=1 exact=1 evidence=x"), null);
  const report = parse.parseVerifierReport('nothing useful\nat all');
  assert.deepEqual(report.rows, []);
  assert.equal(report.summary.total, null);
});

test('apply result line is parsed to counts', () => {
  const out = 'applied verified registrations: 2\nSummary:\ntotal panes: 3\napply result: written 2; skipped 1; initially verified 3\n';
  assert.deepEqual(parse.parseApplyResult(out), { written: 2, skipped: 1, initially_verified: 3 });
  assert.deepEqual(parse.parseApplyResult('nothing'), { written: null, skipped: null, initially_verified: null });
});

test('preflight failure output: json summary, grouped failures, labels and acknowledgements', () => {
  const parsed = parse.parsePreflight(fixture('preflight-fail.txt'));
  assert.equal(parsed.ready_to_seal, false);
  assert.equal(parsed.sessions[0].session, 'project-a');
  assert.equal(parsed.sessions[0].failure_count, 4);
  assert.deepEqual(parsed.failures.map((group) => group.kind), ['blocker', 'busy_agent', 'mixed_workspace_cwd', 'unverified_recovery_identity']);
  const blocker = parsed.failures[0].entries[0];
  assert.deepEqual(blocker.identity, { session: 'project-a', workspace_id: 'w3', tab_id: 'w3:t2', pane_id: 'w3:p2' });
  assert.equal(blocker.workspace_label, 'Gamma space');
  assert.equal(blocker.tab_label, 'gamma-tab');
  assert.deepEqual(blocker.ack, { flag: 'volatile-pane', value: 'project-a|w3|w3:t2|w3:p2' });
  const busy = parsed.failures[1].entries[0];
  assert.deepEqual({ reason: busy.reason, agent: busy.agent, status: busy.status, trusted: busy.trusted_restore }, { reason: 'busy_agent', agent: 'claude', status: 'working', trusted: true });
  const mixed = parsed.failures[2].entries[0];
  assert.equal(mixed.identity.tab_id, '');
  assert.deepEqual(mixed.ack, { flag: 'mixed-cwd-workspace', value: 'project-a|w1' });
  assert.equal(parsed.failures[3].entries[0].ack, null);
});

test('preflight pass output has no failures and is ready', () => {
  const parsed = parse.parsePreflight(fixture('preflight-pass.txt'));
  assert.equal(parsed.ready_to_seal, true);
  assert.deepEqual(parsed.failures, []);
});

test('preflight parser returns an unknown state for output it cannot read', () => {
  assert.equal(parse.parsePreflight('Error: something broke').ready_to_seal, null);
});

test('seal result requires a ready bundle id', () => {
  const out = '{\n  "bundle_id": "recovery-20261004T120000Z-0123456789",\n  "session_count": 2,\n  "ready": true\n}\nRecovery bundle sealed.';
  assert.deepEqual(parse.parseSealResult(out), { bundle_id: 'recovery-20261004T120000Z-0123456789', session_count: 2 });
  assert.equal(parse.parseSealResult('{\n  "bundle_id": "x",\n  "ready": false\n}'), null);
  assert.equal(parse.parseSealResult('nope'), null);
});

test('session and pane list parsers drop private fields from the public view', () => {
  const sessions = parse.parseSessions(fixture('session-list.json'));
  assert.deepEqual(sessions.map((item) => [item.name, item.running, item.isDefault]), [['default', false, true], ['-h', false, false], ['project-a', true, false], ['project-b', true, false], ['stopped-one', false, false]]);
  const panes = parse.parsePanes(fixture('pane-list.json'));
  assert.equal(panes[0].cwd, '/fixture/work/alpha');
  assert.equal(panes[1].cwd, '/fixture/work/alpha/sub', 'foreground cwd preferred');
  const view = JSON.stringify(parse.publicPane(panes[0]));
  assert.equal(view.includes('11111111'), false);
  assert.equal(view.includes('/fixture'), false);
  assert.equal(view.includes('private terminal title'), false);
});

test('cleanup preview: tabs to close, protected tabs and the kept tab are parsed; pane ids become counts', () => {
  const parsed = parse.parseCleanupPreview(fixture('cleanup-w1.txt'));
  assert.equal(parsed.workspace_id, 'w1');
  assert.deepEqual(parsed.tabs_to_close.map((tab) => [tab.tab_id, tab.pane_count]), [['w1:t3', 1], ['w1:t4', 2]]);
  assert.deepEqual(parsed.protected_tabs, [{ tab_id: 'w1:t1', label: '', pane_count: 1, reason: 'agent_detected' }]);
  assert.equal(parsed.kept_tab_id, '');
  assert.equal(JSON.stringify(parsed).includes('w1:p5'), false, 'pane ids are not kept');
  assert.equal(parse.parseCleanupPreview('nothing'), null);
  assert.equal(parse.parseCleanupPreview('{\n  "other": 1\n}'), null);
});
