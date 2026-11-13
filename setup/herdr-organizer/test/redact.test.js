'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildShareReport, ReportBlockedError } = require('../redact');
const { findLeaks, scrub } = require('../text');

const NOW = new Date('2026-10-04T12:00:00.000Z');

const verify = (overrides = {}) => ({
  session: 'secret-session-name',
  summary: { total: 2, verified: { native: 1, argv: 0, handle: 0, pid_record: 0 }, ambiguous: 1, unresolved: 0, safe_to_apply: 1, manual: 1 },
  rows: [
    { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', client: 'claude', workspace_label: 'confidential-project-label', tab_label: 'confidential-tab-label', classification: 'native_verified', candidates: 1, exact: 1, evidence: ['cwd_candidate', 'store_header'] },
    { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', client: 'codex', workspace_label: 'other-label', tab_label: 'other-tab', classification: 'candidate_ambiguous', candidates: 3, exact: 0, evidence: ['cwd_candidate'] },
  ],
  ...overrides,
});

const preflight = () => ({
  ready_to_seal: false,
  sessions: [{ session: 'secret-session-name', process_classes: { busy_agent: 1 }, failure_count: 1 }],
  failures: [{ kind: 'busy_agent', count: 1, entries: [{ session: 'secret-session-name', workspace_id: 'w2', tab_id: 'w2:t1', pane_id: 'w2:p1', workspace_label: 'other-label', tab_label: 'other-tab', reason: 'busy_agent', agent: 'claude', status: 'working' }] }],
});

test('labels and session names are masked by default', () => {
  const report = buildShareReport({ sessions: [{ name: 'secret-session-name', verify: verify(), preflight: preflight() }], now: NOW });
  for (const secret of ['secret-session-name', 'confidential-project-label', 'confidential-tab-label', 'other-label', 'other-tab']) {
    assert.equal(report.markdown.includes(secret), false, secret);
  }
  assert.match(report.markdown, /## Session A/);
  assert.match(report.markdown, /Workspace 1/);
  assert.match(report.markdown, /Tab 2/);
  assert.match(report.markdown, /w1:p1/, 'pane ids stay');
  assert.equal(report.labels_included, false);
  assert.equal(report.leak_scan, 'passed');
});

test('workspace and tab numbers are consistent between the verify and preflight sections', () => {
  const report = buildShareReport({ sessions: [{ name: 'secret-session-name', verify: verify(), preflight: preflight() }], now: NOW });
  const verifyRow = report.markdown.split('\n').find((line) => line.startsWith('| w2:p1 |'));
  const failureRow = report.markdown.split('\n').find((line) => line.startsWith('| busy_agent |'));
  const workspace = /Workspace \d+/.exec(verifyRow)[0];
  assert.ok(failureRow.includes(workspace));
});

test('the opt-in toggle adds real names for that report only', () => {
  const report = buildShareReport({ sessions: [{ name: 'secret-session-name', verify: verify(), preflight: preflight() }], includeLabels: true, now: NOW });
  assert.match(report.markdown, /secret-session-name/);
  assert.match(report.markdown, /Workspace 1 \(confidential-project-label\)/);
  assert.equal(report.labels_included, true);
});

test('the report never contains session ids, resume commands, private paths or bundle ids', () => {
  const report = buildShareReport({ sessions: [{ name: 'a', verify: verify(), preflight: preflight() }], now: NOW });
  assert.deepEqual(findLeaks(report.markdown), []);
  assert.match(report.markdown, /Excluded in every mode: client session ids, resume commands, private paths, transcript text, bundle ids\./);
});

test('raw tool output is not passed through: only allowlisted fields appear', () => {
  const dirty = verify();
  dirty.rows[0].session_id = '11111111-2222-4333-8444-555555555555';
  dirty.rows[0].resume_command = 'claude --resume 11111111-2222-4333-8444-555555555555';
  dirty.rows[0].cwd = '/Users/someone/private/project';
  dirty.rows[0].hint = 'see /Users/someone/private/project';
  const report = buildShareReport({ sessions: [{ name: 'a', verify: dirty, preflight: preflight() }], now: NOW });
  assert.equal(report.markdown.includes('11111111'), false);
  assert.equal(report.markdown.includes('/Users/'), false);
  assert.equal(report.markdown.includes('--resume'), false);
});

test('the leak scan blocks a report when a planted leak sits in an allowed field', () => {
  const planted = [
    ['uuid in evidence', (v) => { v.rows[0].evidence = ['11111111-2222-4333-8444-555555555555']; }],
    ['path in client', (v) => { v.rows[0].client = '/Users/someone/.claude'; }],
    ['resume command in classification', (v) => { v.rows[0].classification = 'codex resume now'; }],
    ['bundle id in pane id', (v) => { v.rows[0].pane_id = 'recovery-20261004T120000Z-0123456789'; }],
    ['socket path in evidence', (v) => { v.rows[0].evidence = ['herdr.sock']; }],
  ];
  for (const [name, mutate] of planted) {
    const dirty = verify();
    mutate(dirty);
    assert.throws(() => buildShareReport({ sessions: [{ name: 'a', verify: dirty, preflight: null }], now: NOW }), ReportBlockedError, name);
  }
});

test('opting into labels cannot smuggle a private value through a label', () => {
  const dirty = verify();
  dirty.rows[0].workspace_label = 'work in /Users/someone/private';
  assert.throws(() => buildShareReport({ sessions: [{ name: 'a', verify: dirty, preflight: null }], includeLabels: true, now: NOW }), ReportBlockedError);
  // masked mode does not echo the label at all, so the same input is fine.
  const masked = buildShareReport({ sessions: [{ name: 'a', verify: dirty, preflight: null }], includeLabels: false, now: NOW });
  assert.equal(masked.markdown.includes('/Users/'), false);
});

test('the blocked-report error names the kind of leak, not its content', () => {
  const dirty = verify();
  dirty.rows[0].evidence = ['11111111-2222-4333-8444-555555555555'];
  try {
    buildShareReport({ sessions: [{ name: 'a', verify: dirty, preflight: null }], now: NOW });
    assert.fail('expected a blocked report');
  } catch (error) {
    assert.ok(error instanceof ReportBlockedError);
    assert.equal(error.status, 422);
    assert.match(error.message, /session-id/);
    assert.equal(error.message.includes('11111111'), false);
  }
});

test('pipes and newlines in labels cannot break the table', () => {
  const dirty = verify();
  dirty.rows[0].workspace_label = 'a | b\nc';
  const report = buildShareReport({ sessions: [{ name: 'a', verify: dirty, preflight: null }], includeLabels: true, now: NOW });
  const row = report.markdown.split('\n').find((line) => line.startsWith('| w1:p1 |'));
  assert.ok(row.includes('a \\| b c'));
  assert.equal(row.split(' | ').length >= 8, true);
});

test('scrub replaces ids, paths, bundle ids and resume commands in tool messages', () => {
  const text = 'failed 11111111-2222-4333-8444-555555555555 at /Users/someone/x/y recovery-20261004T120000Z-0123456789 ran claude --resume abc';
  const cleaned = scrub(text);
  assert.deepEqual(findLeaks(cleaned), []);
  assert.match(cleaned, /\[id\]/);
  assert.match(cleaned, /\[path\]/);
});
