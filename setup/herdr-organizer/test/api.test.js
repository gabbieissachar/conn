'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, client, fakeRunner, fixture } = require('./helpers');
const { childEnv } = require('../adapter');
const { findLeaks } = require('../text');

test('sessions: lists names and flags only running non-default sessions as selectable', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    const response = await post('sessions');
    assert.equal(response.status, 200);
    const byName = Object.fromEntries(response.json.data.map((item) => [item.name, item]));
    assert.equal(byName['project-a'].selectable, true);
    assert.equal(byName.default.selectable, false);
    assert.equal(byName['-h'].selectable, false);
    assert.equal(byName['stopped-one'].selectable, false);
    assert.equal(response.raw.includes('socket'), false, 'socket paths are not exposed');
    assert.equal(response.raw.includes('/fixture'), false, 'session directories are not exposed');
  } finally { await server.close(); }
});

test('unknown actions, unknown params and non-allowlisted fields are refused before anything runs', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    assert.equal((await post('rm-everything')).status, 400);
    assert.equal((await post('constructor')).status, 400);
    assert.equal((await post('__proto__')).status, 400);
    assert.equal((await post('verify', { session: 'project-a', extra: 'x' })).status, 400);
    assert.equal((await post('verify', {})).status, 400);
    assert.equal((await post('verify', { session: 5 })).status, 400);
    assert.equal((await post('sessions', { anything: 1 })).status, 400);
    assert.equal(server.calls.length, 0, 'no process was spawned for any refused request');
  } finally { await server.close(); }
});

test('session names are validated against herdr session list: default, stopped, unknown and option-like names are refused', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    for (const name of ['default', 'stopped-one', 'unknown-session', '-h', '--help', '--session=default', 'project-a; rm -rf /', '$(id)', 'a b', '', 'x'.repeat(200)]) {
      const response = await post('verify', { session: name });
      assert.equal(response.status, 400, JSON.stringify(name));
    }
    const verifyCalls = server.calls.filter((call) => call.args.includes('verify-identity'));
    assert.equal(verifyCalls.length, 0, 'the verifier never ran for a refused session');
  } finally { await server.close(); }
});

test('shell metacharacters in a session name never reach a command line', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    await post('verify', { session: 'project-a; touch /tmp/pwned' });
    await post('preflight', { sessions: ['project-a', '$(touch /tmp/pwned)'] });
    const everyArg = server.calls.flatMap((call) => call.args).join('\n');
    assert.equal(everyArg.includes('pwned'), false);
  } finally { await server.close(); }
});

test('verify: runs the report-only verifier with fixed arguments and returns a redacted view', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    const response = await post('verify', { session: 'project-a' });
    assert.equal(response.status, 200);
    const call = server.calls.find((entry) => entry.args.includes('verify-identity'));
    assert.deepEqual(call.args.slice(1), ['verify-identity', '--herdr-session', 'project-a'], 'exactly the report-only form');
    assert.equal(call.args.includes('--apply'), false);
    assert.equal(call.args.includes('--show-session-ids'), false);
    const data = response.json.data;
    assert.equal(data.rows.length, 3);
    assert.equal(data.rows[0].workspace_id, 'w1', 'joined to the live pane list');
    assert.equal(data.rows[0].client, 'claude');
    assert.equal(data.summary.safe_to_apply, 1);
    assert.equal(response.raw.includes('11111111'), false, 'the native agent session id from the pane list never appears');
    assert.equal(response.raw.includes('/fixture'), false, 'pane cwd never appears');
    assert.equal(response.raw.includes('private terminal title'), false);
    assert.deepEqual(findLeaks(response.raw), []);
  } finally { await server.close(); }
});

test('verify still answers when the pane list is unavailable', async () => {
  const runner = fakeRunner({ handle: (file, args) => (args[2] === 'pane' ? { code: 1, stdout: '', stderr: 'down', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const response = await post('verify', { session: 'project-a' });
    assert.equal(response.status, 200);
    assert.equal(response.json.data.rows[0].workspace_id, '');
  } finally { await server.close(); }
});

test('verify: a verifier failure is reported without leaking tool output', async () => {
  const runner = fakeRunner({ handle: (file, args) => (args.includes('verify-identity') ? { code: 2, stdout: '', stderr: 'boom at /Users/someone/.claude/projects/x 11111111-2222-4333-8444-555555555555', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const response = await post('verify', { session: 'project-a' });
    assert.equal(response.status, 502);
    assert.deepEqual(findLeaks(response.raw), []);
  } finally { await server.close(); }
});

test('preflight: runs read-only with an explicit session list and groups failures', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    const response = await post('preflight', { sessions: ['project-a', 'project-b'] });
    assert.equal(response.status, 200);
    const call = server.calls.find((entry) => entry.args.includes('prepare-restart-recovery'));
    assert.deepEqual(call.args.slice(1), ['prepare-restart-recovery', '--session', 'project-a', '--session', 'project-b', '--preflight-only']);
    const data = response.json.data;
    assert.equal(data.ready_to_seal, false);
    assert.deepEqual(data.failures.map((group) => group.kind), ['blocker', 'busy_agent', 'mixed_workspace_cwd', 'unverified_recovery_identity']);
    assert.deepEqual(findLeaks(response.raw), []);
  } finally { await server.close(); }
});

test('preflight: acknowledgements are accepted only for identities in the current failure list', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    const bogus = await post('preflight', { sessions: ['project-a'], acknowledgements: { volatile: ['project-a|w9|w9:t1|w9:p1'] } });
    assert.equal(bogus.status, 400);
    const freeText = await post('preflight', { sessions: ['project-a'], acknowledgements: { volatile: ['anything; rm -rf /'] } });
    assert.equal(freeText.status, 400);
    const wrongKind = await post('preflight', { sessions: ['project-a'], acknowledgements: { volatile: ['project-a|w1'] } });
    assert.equal(wrongKind.status, 400, 'a mixed-cwd identity cannot be used as a volatile-pane acknowledgement');
    const noPreflightWithBogus = server.calls.filter((call) => call.args.includes('--allow-volatile-pane'));
    assert.equal(noPreflightWithBogus.length, 0, 'an unvalidated acknowledgement never reached the tool');

    const good = await post('preflight', { sessions: ['project-a'], acknowledgements: { volatile: ['project-a|w3|w3:t2|w3:p2'], mixed: ['project-a|w1'] } });
    assert.equal(good.status, 200);
    assert.equal(good.json.data.ready_to_seal, true);
    assert.deepEqual(good.json.data.acknowledged, { volatile: 1, mixed: 1 });
    const final = server.calls.filter((call) => call.args.includes('--allow-volatile-pane')).pop();
    assert.deepEqual(final.args.slice(1), ['prepare-restart-recovery', '--session', 'project-a', '--allow-volatile-pane', 'project-a|w3|w3:t2|w3:p2', '--allow-mixed-cwd-workspace', 'project-a|w1', '--preflight-only']);
  } finally { await server.close(); }
});

test('share-report: masked by default, labels on request, and never contains private values', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    const masked = await post('share-report', { sessions: ['project-a'] });
    assert.equal(masked.status, 200);
    const md = masked.json.data.markdown;
    for (const label of ['Alpha space', 'alpha-tab', 'Gamma space', 'project-a']) assert.equal(md.includes(label), false, label);
    assert.deepEqual(findLeaks(md), []);
    assert.match(md, /Session A/);
    const named = await post('share-report', { sessions: ['project-a'], include_labels: true });
    assert.match(named.json.data.markdown, /Alpha space/);
    assert.equal(named.json.data.labels_included, true);
    assert.match(named.json.data.filename, /^herdr-restart-readiness-.*\.md$/);
  } finally { await server.close(); }
});

test('share-report: a label that carries a private value blocks the report (labels on)', async () => {
  const dirtyVerify = fixture('verify-report.txt').replace("workspace='Alpha space'", "workspace='see /Users/someone/private'");
  const runner = fakeRunner({ handle: (file, args) => (args.includes('verify-identity') ? { code: 0, stdout: dirtyVerify, stderr: '', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const blocked = await post('share-report', { sessions: ['project-a'], include_labels: true });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.json.code, 'report_blocked');
    assert.equal(blocked.raw.includes('/Users/'), false);
    const masked = await post('share-report', { sessions: ['project-a'] });
    assert.equal(masked.status, 200);
  } finally { await server.close(); }
});

test('snapshot: refreshes only a validated session', async () => {
  const runner = fakeRunner({ handle: (file, args) => (args.includes('snapshot') ? { code: 0, stdout: 'wrote /Users/someone/state/live-snapshot.json', stderr: '', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const refused = await post('snapshot', { session: 'default' });
    assert.equal(refused.status, 400);
    const ok = await post('snapshot', { session: 'project-a' });
    assert.equal(ok.status, 200);
    assert.equal(ok.raw.includes('/Users/'), false, 'tool output is not echoed');
    const call = runner.calls.find((entry) => entry.args.includes('snapshot'));
    assert.deepEqual(call.args.slice(1), ['--session', 'project-a', 'snapshot']);
  } finally { await server.close(); }
});

test('child processes never inherit the Herdr context of the shell that started the server', () => {
  const env = childEnv({ PATH: '/bin', HERDR_SESSION: 'x', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/s', HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 't', HERDR_ENV: '1', HERDR_LAB_HELPER: '/lab', PMOS_HERDR_AGENT_MANIFEST: '/m' });
  assert.deepEqual(Object.keys(env).sort(), ['HERDR_LAB_HELPER', 'PATH', 'PMOS_HERDR_AGENT_MANIFEST']);
});

test('oversized and malformed bodies are refused', async () => {
  const server = await startServer();
  try {
    const { token } = await client(server);
    const { request } = require('./helpers');
    const headers = { Host: 'localhost:' + server.port, Origin: server.origin, 'Content-Type': 'application/json', 'X-Herdr-Organizer-Token': token };
    const bad = await request({ port: server.port, method: 'POST', path: '/api/herdr-organizer/run', headers, body: '{not json' });
    assert.equal(bad.status, 400);
    const array = await request({ port: server.port, method: 'POST', path: '/api/herdr-organizer/run', headers, body: '[]' });
    assert.equal(array.status, 400);
    const huge = await request({ port: server.port, method: 'POST', path: '/api/herdr-organizer/run', headers, body: JSON.stringify({ action: 'sessions', params: { pad: 'x'.repeat(70 * 1024) } }) });
    assert.equal(huge.status, 413);
    const extraField = await request({ port: server.port, method: 'POST', path: '/api/herdr-organizer/run', headers, body: { action: 'sessions', command: 'ls' } });
    assert.equal(extraField.status, 400);
  } finally { await server.close(); }
});

test('cleanup-preview: previews every workspace read-only and builds copy-only commands from validated ids', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    const response = await post('cleanup-preview', { session: 'project-a' });
    assert.equal(response.status, 200);
    const data = response.json.data;
    assert.deepEqual(data.workspaces.map((item) => item.workspace_id), ['w1', 'w2']);
    assert.deepEqual(data.totals, { workspaces: 2, workspaces_with_empty_tabs: 1, tabs_to_close: 2, workspaces_to_close: 0, protected_tabs: 3, errors: 0 });
    assert.deepEqual(data.workspaces[0].tabs_to_close.map((tab) => [tab.tab_id, tab.label, tab.pane_count]), [['w1:t3', 'scratch shell', 1], ['w1:t4', 'old shell', 2]]);
    assert.equal(data.workspaces[1].protected_tabs[1].reason, 'non_shell_process');
    const previews = server.calls.filter((call) => call.args.includes('cleanup-empty-tabs'));
    assert.equal(previews.length, 2);
    for (const call of previews) {
      assert.equal(call.args.includes('--execute'), false, 'the page never runs the closing form');
      assert.equal(call.args.includes('--confirm'), false);
    }
    assert.deepEqual(previews.map((call) => call.args.slice(1)).sort(), [
      ['--session', 'project-a', 'cleanup-empty-tabs', '--workspace', 'w1'],
      ['--session', 'project-a', 'cleanup-empty-tabs', '--workspace', 'w2'],
    ]);
    assert.equal(data.commands.preview_all, 'for ws in w1 w2; do herdr-organizer --session project-a cleanup-empty-tabs --workspace "$ws"; done');
    assert.equal(data.commands.execute_all, 'herdr-organizer --session project-a cleanup-empty-tabs --workspace w1 --execute --confirm w1', 'only workspaces with something to close');
    assert.deepEqual(findLeaks(response.raw), []);
  } finally { await server.close(); }
});

test('cleanup-preview: joins several closable workspaces into one stop-on-failure command', async () => {
  const w3 = fixture('cleanup-w1.txt').replace(/w1/g, 'w3');
  const base = fakeRunner({ handle: (file, args) => {
    if (file === 'herdr' && args[2] === 'pane') {
      return { code: 0, stdout: JSON.stringify({ result: { panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1' }, { pane_id: 'w3:p1', workspace_id: 'w3', tab_id: 'w3:t1' }] } }), stderr: '', timedOut: false, truncated: false };
    }
    if (args.includes('cleanup-empty-tabs') && args.includes('w3')) return { code: 0, stdout: w3, stderr: '', timedOut: false, truncated: false };
    return undefined;
  } });
  const server = await startServer({ runner: base.runner });
  try {
    const { post } = await client(server);
    const response = await post('cleanup-preview', { session: 'project-a' });
    assert.equal(response.json.data.commands.execute_all,
      'herdr-organizer --session project-a cleanup-empty-tabs --workspace w1 --execute --confirm w1 && \\\nherdr-organizer --session project-a cleanup-empty-tabs --workspace w3 --execute --confirm w3');
  } finally { await server.close(); }
});

test('cleanup-preview: a workspace id that does not match the fixed pattern is never run or put in a command', async () => {
  const runner = fakeRunner({ handle: (file, args) => {
    if (file === 'herdr' && args[2] === 'pane') {
      const panes = [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1' }, { pane_id: 'x:p1', workspace_id: 'w1; touch /tmp/pwned', tab_id: 'x:t1' }, { pane_id: 'y:p1', workspace_id: '$(id)', tab_id: 'y:t1' }, { pane_id: 'z:p1', workspace_id: '--help', tab_id: 'z:t1' }];
      return { code: 0, stdout: JSON.stringify({ result: { panes } }), stderr: '', timedOut: false, truncated: false };
    }
    return undefined;
  } });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const response = await post('cleanup-preview', { session: 'project-a' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.data.workspaces.map((item) => item.workspace_id), ['w1']);
    const everything = JSON.stringify(runner.calls) + response.raw;
    assert.equal(everything.includes('pwned'), false);
    assert.equal(everything.includes('$(id)'), false);
  } finally { await server.close(); }
});

test('cleanup-preview: one failing workspace is reported without failing the rest', async () => {
  const runner = fakeRunner({ handle: (file, args) => (args.includes('cleanup-empty-tabs') && args.includes('w2') ? { code: 1, stdout: '', stderr: 'boom /Users/someone/x', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const response = await post('cleanup-preview', { session: 'project-a' });
    assert.equal(response.status, 200);
    assert.equal(response.json.data.totals.errors, 1);
    assert.equal(response.json.data.workspaces[1].error, 'Preview failed for this workspace.');
    assert.equal(response.raw.includes('/Users/'), false);
    assert.equal(response.json.data.totals.tabs_to_close, 2);
  } finally { await server.close(); }
});

test('cleanup-preview: the default, stopped and unknown sessions are refused before any preview runs', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    for (const name of ['default', 'stopped-one', 'nope', '-h']) assert.equal((await post('cleanup-preview', { session: name })).status, 400, name);
    assert.equal(server.calls.filter((call) => call.args.includes('cleanup-empty-tabs')).length, 0);
  } finally { await server.close(); }
});

test('identical verify requests while one is running share a single run', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = fakeRunner({ handle: async (file, args) => {
    if (args.includes('verify-identity')) { await gate; return { code: 0, stdout: fixture('verify-report.txt'), stderr: '', timedOut: false, truncated: false }; }
    return undefined;
  } });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const first = post('verify', { session: 'project-a' });
    const second = post('verify', { session: 'project-a' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(runner.calls.filter((call) => call.args.includes('verify-identity')).length, 1);
  } finally { await server.close(); }
});

test('snapshot-data: serves the snapshot from the tool root and refuses one that carries a private value', async () => {
  const { tempTree } = require('./helpers');
  const tree = tempTree('herdr-organizer-test-');
  const snapshot = 'state/workspace-organizer/live-snapshot.json';
  tree.mkdir('state/workspace-organizer');
  const server = await startServer({ toolRoot: tree.root });
  try {
    const { post } = await client(server);
    const missing = await post('snapshot-data');
    assert.equal(missing.status, 404);
    tree.write(snapshot, JSON.stringify({ herdr_session: 'project-a', workspaces: [{ id: 'w1', label: 'Alpha', tabs: [] }], archives: [] }));
    const ok = await post('snapshot-data');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.workspaces[0].label, 'Alpha');
    const boot = Date.parse(ok.json.data.boot_time);
    assert.ok(Number.isFinite(boot) && boot < Date.now() && boot > Date.now() - 400 * 24 * 3600 * 1000, 'the snapshot carries the time the computer last started');
    require('fs').writeFileSync(tree.abs(snapshot), JSON.stringify({ workspaces: [{ id: 'w1', label: 'claude --resume 11111111-2222-4333-8444-555555555555', tabs: [] }] }));
    const leaky = await post('snapshot-data');
    assert.equal(leaky.status, 502);
    assert.equal(leaky.raw.includes('11111111'), false);
  } finally {
    await server.close();
    tree.cleanup();
  }
});

test('archive-all-preview: runs the read-only preview, drops free text, and builds copy-only commands from the validated session', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    const response = await post('archive-all-preview', { session: 'project-a' });
    assert.equal(response.status, 200);
    const data = response.json.data;
    assert.deepEqual(data.to_archive.map((item) => [item.workspace_id, item.label, item.pane_count]), [['w1', 'Alpha', 3], ['w2', 'Beta', 1]]);
    assert.deepEqual(data.totals, { workspaces: 5, to_archive: 2, skipped: 3, omitted: 0 });
    const bySkip = Object.fromEntries(data.skipped.map((item) => [item.workspace_id, item]));
    assert.deepEqual(bySkip.w3.reasons, ['active_agent']);
    assert.deepEqual(bySkip.w3.active_pane_ids, ['w3:p1']);
    assert.deepEqual(bySkip.w4.unverified_panes, [{ pane_id: 'w4:p2', client: 'codex' }]);
    assert.deepEqual(bySkip.w5.reasons, ['capture_failed']);
    assert.equal('error' in bySkip.w5, false, 'the tool free-text error is dropped');
    assert.deepEqual(findLeaks(response.raw), []);
    const runs = server.calls.filter((call) => call.args.includes('archive-all'));
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].args.slice(1), ['--session', 'project-a', 'archive-all']);
    for (const flag of ['--execute', '--confirm', '--allow-active', '--allow-unresumable-agents']) assert.equal(runs[0].args.includes(flag), false, flag);
    assert.equal(data.commands.preview, 'herdr-organizer --session project-a archive-all');
    assert.equal(data.commands.execute, 'herdr-organizer --session project-a archive-all --execute --confirm project-a');
    assert.equal(data.commands.snapshot, 'herdr-organizer --session project-a archive-all --snapshot --execute --confirm project-a');
    assert.equal(data.commands.snapshot_preview, 'herdr-organizer --session project-a archive-all --snapshot', 'the snapshot has its own preview-only command');
  } finally { await server.close(); }
});

test('archive-all-preview: with nothing to archive there is no execute command', async () => {
  const none = fixture('archive-all-preview.txt').replace(/"to_archive": \[[\s\S]*?\n  \],\n  "skipped"/, '"to_archive": [],\n  "skipped"');
  const runner = fakeRunner({ handle: (file, args) => (args.includes('archive-all') ? { code: 0, stdout: none, stderr: '', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const response = await post('archive-all-preview', { session: 'project-a' });
    assert.equal(response.status, 200);
    assert.equal(response.json.data.totals.to_archive, 0);
    assert.equal(response.json.data.commands.execute, '');
    assert.match(response.json.data.commands.snapshot, /--snapshot --execute --confirm project-a$/, 'a working-agent workspace can still be saved as a snapshot');
  } finally { await server.close(); }
});

test('archive-all-preview: with nothing that could be saved there is no snapshot command either', async () => {
  const bare = fixture('archive-all-preview.txt').replace(/"to_archive": \[[\s\S]*?\n  \],\n  "skipped"/, '"to_archive": [],\n  "skipped"').replace(/"active_agent"/g, '"capture_failed"');
  const runner = fakeRunner({ handle: (file, args) => (args.includes('archive-all') ? { code: 0, stdout: bare, stderr: '', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const response = await post('archive-all-preview', { session: 'project-a' });
    assert.equal(response.json.data.commands.snapshot, '');
  } finally { await server.close(); }
});

test('archive-all-preview: ids that do not match their patterns and unknown reasons never reach the browser', async () => {
  const hostile = JSON.stringify({
    session: 'project-a',
    to_archive: [{ workspace_id: 'w1', label: 'Fine', tab_count: 1, pane_count: 1, resumable_agent_panes: 0 }, { workspace_id: 'w1; touch /tmp/pwned', label: 'x' }, { workspace_id: '$(id)', label: 'y' }],
    skipped: [{ workspace_id: 'w2', label: '/Users/someone/secret', reasons: ['active_agent', 'rm -rf'], active_pane_ids: ['w2:p1', 'bad'], unverified_panes: [{ pane_id: 'w2:p2', client: '--help' }, { pane_id: 'nope', client: 'codex' }] }],
  }, null, 2);
  const runner = fakeRunner({ handle: (file, args) => (args.includes('archive-all') ? { code: 0, stdout: hostile + '\nPreview only.\n', stderr: '', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const response = await post('archive-all-preview', { session: 'project-a' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.data.to_archive.map((item) => item.workspace_id), ['w1']);
    const skipped = response.json.data.skipped[0];
    assert.deepEqual(skipped.reasons, ['active_agent']);
    assert.deepEqual(skipped.active_pane_ids, ['w2:p1']);
    assert.deepEqual(skipped.unverified_panes, [{ pane_id: 'w2:p2', client: '' }]);
    assert.equal(skipped.label.includes('/Users/'), false);
    assert.equal(response.raw.includes('pwned') || response.raw.includes('$(id)') || response.raw.includes('rm -rf'), false);
  } finally { await server.close(); }
});

test('archive-all-preview: a failed or mismatched preview is reported as an error, never as an empty plan', async () => {
  const failing = fakeRunner({ handle: (file, args) => (args.includes('archive-all') ? { code: 1, stdout: '', stderr: 'Error: Could not reach Herdr socket /Users/someone/.config/herdr/herdr.sock', timedOut: false, truncated: false } : undefined) });
  let server = await startServer({ runner: failing.runner });
  try {
    const { post } = await client(server);
    const response = await post('archive-all-preview', { session: 'project-a' });
    assert.equal(response.status, 502);
    assert.equal(response.json.code, 'archive_preview_failed');
    assert.equal(response.raw.includes('/Users/'), false);
  } finally { await server.close(); }
  const other = fixture('archive-all-preview.txt').replace('"session": "project-a"', '"session": "someone-else"');
  const mismatch = fakeRunner({ handle: (file, args) => (args.includes('archive-all') ? { code: 0, stdout: other, stderr: '', timedOut: false, truncated: false } : undefined) });
  server = await startServer({ runner: mismatch.runner });
  try {
    const { post } = await client(server);
    assert.equal((await post('archive-all-preview', { session: 'project-a' })).status, 502);
  } finally { await server.close(); }
});

test('archive-all-preview: the default, stopped and unknown sessions are refused before the tool starts', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    for (const name of ['default', 'stopped-one', 'nope', '-h', '--execute']) assert.equal((await post('archive-all-preview', { session: name })).status, 400, name);
    assert.equal((await post('archive-all-preview', { session: 'project-a', extra: 'x' })).status, 400);
    assert.equal((await post('archive-all-preview', {})).status, 400);
    assert.equal(server.calls.filter((call) => call.args.includes('archive-all')).length, 0);
  } finally { await server.close(); }
});

test('archive-all-preview: it is read-only (tier 0) and no action in the allowlist can archive or restore', async () => {
  const server = await startServer();
  try {
    assert.equal(server.api.ACTIONS['archive-all-preview'].tier, 0);
    for (const name of Object.keys(server.api.ACTIONS)) assert.equal(/archive-all$|restore|execute/.test(name), false, name);
  } finally { await server.close(); }
});

test('archive-all-preview: workspaces the parser drops are counted as omitted, not silently lost', async () => {
  const text = fixture('archive-all-preview.txt').replace('"workspace_id": "w2"', '"workspace_id": "bad id"');
  const runner = fakeRunner({ handle: (file, args) => (args.includes('archive-all') ? { code: 0, stdout: text, stderr: '', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const data = (await post('archive-all-preview', { session: 'project-a' })).json.data;
    assert.equal(data.totals.omitted, 1);
    assert.equal(data.totals.workspaces, 5);
    assert.equal(data.to_archive.length + data.skipped.length, 4);
  } finally { await server.close(); }
  const short = fixture('archive-all-preview.txt').replace('"workspace_total": 5', '"workspace_total": 9');
  const runner2 = fakeRunner({ handle: (file, args) => (args.includes('archive-all') ? { code: 0, stdout: short, stderr: '', timedOut: false, truncated: false } : undefined) });
  const server2 = await startServer({ runner: runner2.runner });
  try {
    const { post } = await client(server2);
    assert.equal((await post('archive-all-preview', { session: 'project-a' })).json.data.totals.omitted, 4, 'the tool counted more workspaces than it listed');
  } finally { await server2.close(); }
});

test('archive-all-preview: a tool without the archive-all command gets a clear message', async () => {
  const runner = fakeRunner({ handle: (file, args) => (args.includes('archive-all') ? { code: 2, stdout: '', stderr: "workspace-organizer.py: error: argument command: invalid choice: 'archive-all' (choose from 'snapshot', 'archive')", timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const response = await post('archive-all-preview', { session: 'project-a' });
    assert.equal(response.status, 501);
    assert.equal(response.json.code, 'tool_outdated');
    assert.match(response.json.message, /does not have archive-all yet/);
  } finally { await server.close(); }
});

test('cleanup-preview: a workspace whose every tab is empty is reported as closing entirely, and the command stays copy-only', async () => {
  const whole = JSON.stringify({ workspace_id: 'w1', tabs_to_close: [{ tab_id: 'w1:t1', label: 'a', pane_ids: ['w1:p1'] }, { tab_id: 'w1:t2', label: 'b', pane_ids: ['w1:p2'] }], protected_tabs: [], kept_tab_id: null, kept_reason: null, close_workspace: true }, null, 2);
  const base = fakeRunner({ handle: (file, args) => {
    if (file === 'herdr' && args[2] === 'pane') return { code: 0, stdout: JSON.stringify({ result: { panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1' }] } }), stderr: '', timedOut: false, truncated: false };
    if (args.includes('cleanup-empty-tabs')) return { code: 0, stdout: whole + '\nPreview only. Re-run with --execute --confirm \'w1\' to close 2 empty shell tab(s) and the workspace itself, which has nothing else in it.\n', stderr: '', timedOut: false, truncated: false };
    return undefined;
  } });
  const server = await startServer({ runner: base.runner });
  try {
    const { post } = await client(server);
    const response = await post('cleanup-preview', { session: 'project-a' });
    assert.equal(response.status, 200);
    const item = response.json.data.workspaces[0];
    assert.equal(item.close_workspace, true);
    assert.equal(item.kept_tab_id, '');
    assert.equal(item.tabs_to_close.length, 2);
    assert.equal(response.json.data.totals.workspaces_to_close, 1);
    assert.equal(response.json.data.commands.execute_all, 'herdr-organizer --session project-a cleanup-empty-tabs --workspace w1 --execute --confirm w1');
    for (const call of server.calls.filter((entry) => entry.args.includes('cleanup-empty-tabs'))) assert.equal(call.args.includes('--execute'), false);
  } finally { await server.close(); }
});

test('snapshot-data: a tab keeps its working folders, and a path anywhere else still refuses the snapshot', async () => {
  const { tempTree } = require('./helpers');
  const tree = tempTree('herdr-organizer-test-');
  const snapshot = 'state/workspace-organizer/live-snapshot.json';
  tree.mkdir('state/workspace-organizer');
  const server = await startServer({ toolRoot: tree.root });
  const folder = '/Users/someone/.treehouse/firstmate-8bf1b0/3/firstmate/state/.treehouse/personal-1ab7cc/5/personal';
  const tab = (extra) => ({ id: 'w9Z:t2', label: 'Work', index: 0, pane_count: 1, working_folders: [{ path: folder, source: 'agent_files', pane_ids: ['w9Z:p1'] }], ...extra });
  const write = (value) => require('fs').writeFileSync(tree.abs(snapshot), JSON.stringify(value));
  try {
    const { post } = await client(server);
    tree.write(snapshot, '{}');
    write({ workspaces: [{ id: 'w9Z', label: 'Alpha', tabs: [tab()] }], archives: [] });
    const ok = await post('snapshot-data');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.data.workspaces[0].tabs[0].working_folders, [{ path: folder, source: 'agent_files', pane_ids: ['w9Z:p1'] }]);
    // A path in a label (or any other field) is still a private value.
    write({ workspaces: [{ id: 'w9Z', label: folder, tabs: [tab()] }], archives: [] });
    assert.equal((await post('snapshot-data')).status, 502);
    write({ workspaces: [{ id: 'w9Z', label: 'Alpha', tabs: [tab({ label: folder })] }], archives: [] });
    assert.equal((await post('snapshot-data')).status, 502);
    // A folder that is not a clean absolute path is dropped, never shown.
    write({ workspaces: [{ id: 'w9Z', label: 'Alpha', tabs: [tab({ working_folders: [{ path: 'relative', pane_ids: ['w9Z:p1'] }, { path: '/tmp/a\nb', pane_ids: ['w9Z:p1'] }, { path: '/tmp/ok', pane_ids: ['bad id'] }, { path: '/tmp/ok', pane_ids: ['w9Z:p1'] }] })] }], archives: [] });
    const cleaned = await post('snapshot-data');
    assert.equal(cleaned.status, 200);
    assert.deepEqual(cleaned.json.data.workspaces[0].tabs[0].working_folders, [{ path: '/tmp/ok', source: 'pane', pane_ids: ['w9Z:p1'] }]);
    // A client session id inside a folder path still blocks the snapshot.
    write({ workspaces: [{ id: 'w9Z', label: 'Alpha', tabs: [tab({ working_folders: [{ path: '/tmp/11111111-2222-4333-8444-555555555555', pane_ids: ['w9Z:p1'] }] })] }], archives: [] });
    assert.equal((await post('snapshot-data')).status, 502);
  } finally {
    await server.close();
    tree.cleanup();
  }
});

test('snapshot-data: a tab keeps its verified agent sessions, and a session id anywhere else still refuses the snapshot', async () => {
  const { tempTree } = require('./helpers');
  const tree = tempTree('herdr-organizer-test-');
  const snapshot = 'state/workspace-organizer/live-snapshot.json';
  tree.mkdir('state/workspace-organizer');
  const server = await startServer({ toolRoot: tree.root });
  const id = '11111111-2222-4333-8444-555555555555';
  const tab = (extra) => ({ id: 'w9Z:t2', label: 'Work', index: 0, pane_count: 1, agent_sessions: [{ pane_id: 'w9Z:p1', client: 'claude', session_id: id }], ...extra });
  const write = (value) => require('fs').writeFileSync(tree.abs(snapshot), JSON.stringify(value));
  try {
    const { post } = await client(server);
    tree.write(snapshot, '{}');
    write({ workspaces: [{ id: 'w9Z', label: 'Alpha', tabs: [tab()] }], archives: [] });
    const ok = await post('snapshot-data');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.data.workspaces[0].tabs[0].agent_sessions, [{ pane_id: 'w9Z:p1', client: 'claude', session_id: id }]);
    // The same id in a label, or in the resume state, is still a private value.
    write({ workspaces: [{ id: 'w9Z', label: id, tabs: [tab()] }], archives: [] });
    assert.equal((await post('snapshot-data')).status, 502);
    write({ workspaces: [{ id: 'w9Z', label: 'Alpha', tabs: [tab({ label: id })] }], archives: [] });
    assert.equal((await post('snapshot-data')).status, 502);
    write({ workspaces: [{ id: 'w9Z', label: 'Alpha', tabs: [tab({ agent_resume: [{ pane_id: 'w9Z:p1', client: 'claude', session_id: id }] })] }], archives: [] });
    assert.equal((await post('snapshot-data')).status, 502);
    // An entry that is not a clean id, client or pane is dropped, never shown.
    write({ workspaces: [{ id: 'w9Z', label: 'Alpha', tabs: [tab({ agent_sessions: [
      { pane_id: 'w9Z:p1', client: 'claude', session_id: 'claude --resume abc' },
      { pane_id: 'w9Z:p1', client: 'shell', session_id: id },
      { pane_id: 'bad id', client: 'claude', session_id: id },
      { pane_id: 'w9Z:p2', client: 'codex', session_id: id },
    ] })] }], archives: [] });
    const cleaned = await post('snapshot-data');
    assert.equal(cleaned.status, 200);
    assert.deepEqual(cleaned.json.data.workspaces[0].tabs[0].agent_sessions, [{ pane_id: 'w9Z:p2', client: 'codex', session_id: id }]);
  } finally {
    await server.close();
    tree.cleanup();
  }
});

test('context-gauge: joins the gauge to live panes, shows only short ids, and sorts by context used', async () => {
  const gauge = [
    { session_id: '99999999-aaaa-4bbb-8ccc-000000000001', map: 'low-task', kind: 'ship', current: true, source: 'statusline', window_inferred: false, input_tokens: 90000, percent: 9, busy: 'idle claude-hook', age_s: 30 },
    { session_id: '11111111-2222-4333-8444-555555555555', map: 'secondmate-x', kind: 'secondmate', current: true, source: 'transcript', window_inferred: true, input_tokens: 420000, percent: 42.04, busy: 'busy claude-hook', age_s: 7200 },
    { session_id: null, map: 'superseded-task', kind: 'scout', current: false, source: 'none', percent: null, busy: 'unknown superseded' },
    { session_id: '77777777-aaaa-4bbb-8ccc-000000000002', map: 'old-session', kind: 'ship', current: false, source: 'statusline', percent: 99, busy: 'idle claude-hook' },
    { session_id: '88888888-aaaa-4bbb-8ccc-000000000003', map: 'primary', kind: 'primary', current: true, source: 'transcript', input_tokens: 150000, percent: null, busy: 'unknown no-record', age_s: 2 },
  ].map((row) => JSON.stringify(row)).join('\n') + '\nnot json\n';
  const fake = fakeRunner({ handle: (file) => (file === 'bash' ? { code: 0, stdout: gauge, stderr: '', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: fake.runner });
  try {
    const { post } = await client(server);
    const response = await post('context-gauge');
    assert.equal(response.status, 200);
    const { rows, thresholds } = response.json.data;
    assert.deepEqual(thresholds, { warn: 18, high: 25 });
    assert.deepEqual(rows.map((row) => row.map), ['secondmate-x', 'primary', 'low-task'], 'sorted by percent, superseded and non-current rows dropped');
    assert.equal(rows[0].id, '11111111');
    assert.equal(rows[0].percent, 42);
    assert.equal(rows[0].estimated, true);
    assert.equal(rows[0].busy, 'busy');
    assert.equal(rows[0].pane_id, 'w1:p1', 'joined to the live pane by session id');
    assert.ok(['project-a', 'project-b'].includes(rows[0].herdr_session), 'the fixture serves one pane list to every running session');
    assert.equal(rows[1].percent, 15, 'a count with no percent is read against the assumed 1M window');
    assert.equal(rows[1].estimated, true);
    assert.equal(rows[2].estimated, false);
    assert.equal(rows[2].pane_id, null, 'no live pane for that session');
    assert.equal(response.raw.includes('11111111-2222'), false, 'no full session id leaves the server');
    const call = fake.calls.find((item) => item.file === 'bash');
    assert.deepEqual(call.args, ['/fixture/bin/fm-ctx-gauge.sh', 'report', '--json']);
    assert.equal(call.env.FM_HOME, '/fixture/fm-home');
    assert.equal((await post('context-gauge', { session: 'project-a' })).status, 400, 'the browser sends no params');
    assert.equal(server.api.ACTIONS['context-gauge'].tier, 0);
  } finally { await server.close(); }
});

test('context-gauge: each live row carries its herdr tab label, null when the tab list cannot be read', async () => {
  const gauge = [
    { session_id: '11111111-2222-4333-8444-555555555555', map: 'secondmate-x', kind: 'secondmate', current: true, source: 'statusline', window_inferred: false, input_tokens: 90000, percent: 9, busy: 'idle claude-hook', age_s: 30 },
    { session_id: '99999999-aaaa-4bbb-8ccc-000000000001', map: 'no-pane', kind: 'ship', current: true, source: 'statusline', window_inferred: false, input_tokens: 90000, percent: 8, busy: 'idle claude-hook', age_s: 30 },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
  const panes = [{ pane_id: 'w1:p1', agent: 'claude', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', value: '11111111-2222-4333-8444-555555555555' }, label: 'leader-x', cwd: '/fixture/x', foreground_cwd: '/fixture/x', tab_id: 'w1:t7', workspace_id: 'w1' }];
  const run = async (tabs) => {
    const fake = fakeRunner({
      panes,
      handle: (file, args) => {
        if (file === 'bash') return { code: 0, stdout: gauge, stderr: '', timedOut: false, truncated: false };
        if (file === 'herdr' && args[2] === 'tab' && args[3] === 'list') return tabs;
        return undefined;
      },
    });
    const server = await startServer({ runner: fake.runner });
    try {
      const { post } = await client(server);
      const response = await post('context-gauge');
      assert.equal(response.status, 200);
      return Object.fromEntries(response.json.data.rows.map((row) => [row.map, row]));
    } finally { await server.close(); }
  };
  const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });
  let rows = await run(ok(JSON.stringify({ result: { tabs: [{ tab_id: 'w1:t7', label: 'fm-2026-10-21-the-task', workspace_id: 'w1' }, { tab_id: 'w1:t8', label: 'other' }] } })));
  assert.equal(rows['secondmate-x'].tab_label, 'fm-2026-10-21-the-task', 'the tab the pane lives in');
  assert.equal(rows['no-pane'].tab_label, null, 'no live pane, no tab');
  rows = await run({ code: 1, stdout: '', stderr: 'boom', timedOut: false, truncated: false });
  assert.equal(rows['secondmate-x'].tab_label, null, 'an unreadable tab list leaves the gauge name to the page');
  assert.equal(rows['secondmate-x'].pane_id, 'w1:p1');
});

test('archive-context: reads an archived Claude session\'s last context from its transcript by the first 8 characters, and never returns more', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-claude-'));
  const usage = (tokens, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 3600000).toISOString(), message: { model: 'claude-x', usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: tokens - 1010 } }, ...extra });
  const write = (project, id, lines) => {
    fs.mkdirSync(path.join(root, 'projects', project), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', project, `${id}.jsonl`), lines.join('\n') + '\n');
  };
  write('-proj-a', 'aaaaaaaa-1111-4bbb-8ccc-000000000001', [usage(100000), usage(410000), usage(900000, { isSidechain: true })]);
  write('-proj-b', 'bbbbbbbb-1111-4bbb-8ccc-000000000002', [usage(500000), JSON.stringify({ type: 'system', subtype: 'compact_boundary' })]);
  write('-proj-b', 'cccccccc-1111-4bbb-8ccc-000000000003', [usage(250000)]);
  write('-proj-b', 'notes.txt', ['ignored']);
  const server = await startServer({ runner: fakeRunner({}).runner, env: { CLAUDE_CONFIG_DIR: root } });
  try {
    const { post } = await client(server);
    const response = await post('archive-context', { prefixes: ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'aaaaaaaa'] });
    assert.equal(response.status, 200);
    const rows = Object.fromEntries(response.json.data.rows.map((row) => [row.id, row]));
    assert.deepEqual(Object.keys(rows).sort(), ['aaaaaaaa', 'cccccccc'], 'a compacted session and a session with no transcript have no row');
    assert.equal(rows.aaaaaaaa.percent, 41, 'the newest main-thread usage line against the assumed 1M window');
    assert.equal(rows.aaaaaaaa.tokens, 410000);
    assert.equal(rows.aaaaaaaa.estimated, true);
    assert.ok(rows.aaaaaaaa.age_s >= 3500 && rows.aaaaaaaa.age_s < 4000);
    assert.equal(response.raw.includes('1111-4bbb'), false, 'no whole session id leaves the server');
    assert.equal(response.raw.includes(root), false, 'no path leaves the server');
    assert.deepEqual((await post('archive-context', { prefixes: ['../../etc', 'short', 'aaaaaaaa/x', 5] })).json.data.rows, [], 'only 8-character ids are looked up');
    assert.equal((await post('archive-context', {})).status, 400);
    assert.equal((await post('archive-context', { prefixes: ['aaaaaaaa'], path: '/x' })).status, 400);
    assert.equal(server.api.ACTIONS['archive-context'].tier, 0);
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('context-gauge: a live Claude pane the gauge has no usable row for is read from its own transcript and replaces the stale row', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-claude-'));
  const live = '33333333-aaaa-4bbb-8ccc-000000000001';
  const compacted = '44444444-aaaa-4bbb-8ccc-000000000002';
  const small = '55555555-aaaa-4bbb-8ccc-000000000003';
  const bare = '66666666-aaaa-4bbb-8ccc-000000000004';
  const usage = (tokens, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 60000).toISOString(), message: { model: 'claude-x', usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: tokens - 1010 } }, ...extra });
  const write = (id, lines) => {
    fs.mkdirSync(path.join(root, 'projects', '-proj'), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', '-proj', `${id}.jsonl`), lines.join('\n') + '\n');
  };
  write(live, [usage(100000), usage(380000), usage(900000, { isSidechain: true }), 'not json']);
  write(compacted, [usage(500000), JSON.stringify({ type: 'system', subtype: 'compact_boundary' })]);
  write(small, [usage(150000)]);
  const pane = (id, paneId, label, cwd) => ({ pane_id: paneId, agent: 'claude', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', value: id }, label, cwd, foreground_cwd: cwd, tab_id: 'w1:t1', workspace_id: 'w1' });
  const panes = [
    pane(live, 'w1:p1', 'leader-nip', '/fixture/homes/nip'),
    pane(compacted, 'w1:p2', 'leader-compacted', '/fixture/homes/compacted'),
    pane(small, 'w1:p3', 'leader-small', '/fixture/homes/small'),
    pane(bare, 'w1:p4', 'leader-no-transcript', '/fixture/homes/bare'),
  ];
  const gauge = [
    { session_id: '11111111-aaaa-4bbb-8ccc-00000000000a', map: 'secondmate-nip', kind: 'secondmate', home: '/fixture/homes/nip', current: true, source: 'statusline', percent: null, input_tokens: null, busy: 'idle claude-hook', age_s: 20000 },
    { session_id: bare, map: 'secondmate-bare', kind: 'secondmate', home: '/fixture/homes/bare', current: true, source: 'statusline', percent: null, input_tokens: null, busy: 'idle claude-hook', age_s: 5 },
    { session_id: live, map: 'ignored-duplicate', kind: 'ship', current: true, source: 'statusline', percent: null, busy: 'idle claude-hook' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
  const fake = fakeRunner({ panes, handle: (file) => (file === 'bash' ? { code: 0, stdout: gauge, stderr: '', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: fake.runner, env: { CLAUDE_CONFIG_DIR: root } });
  try {
    const { post } = await client(server);
    const response = await post('context-gauge');
    assert.equal(response.status, 200);
    const rows = Object.fromEntries(response.json.data.rows.map((row) => [row.map, row]));
    assert.equal(rows['leader-nip'].percent, 38, 'the live session is read from its transcript, not the replaced one');
    assert.equal(rows['leader-nip'].tokens, 380000);
    assert.equal(rows['leader-nip'].pane_id, 'w1:p1');
    assert.equal(rows['leader-nip'].busy, 'idle');
    assert.equal(rows['leader-nip'].estimated, true);
    assert.ok(rows['leader-nip'].age_s >= 55 && rows['leader-nip'].age_s < 300);
    assert.equal(rows['secondmate-nip'], undefined, 'the replaced session no pane runs is dropped');
    assert.equal(rows['ignored-duplicate'], undefined, 'a gauge row for a pane read from its transcript is not shown twice');
    assert.equal(rows['leader-compacted'].percent, null, 'a compaction after the newest usage line makes the count unknown');
    assert.equal(rows['leader-compacted'].tokens, null);
    assert.equal(rows['leader-small'].percent, 15, 'a count under 200000 is read against the assumed 1M window and marked estimated');
    assert.equal(rows['leader-small'].estimated, true);
    assert.equal(rows['leader-small'].tokens, 150000);
    assert.equal(rows['secondmate-bare'].pane_id, 'w1:p4', 'with no transcript the gauge row stays');
    assert.equal(rows['leader-no-transcript'], undefined);
    assert.equal(response.raw.includes(live), false, 'no full session id leaves the server');
    assert.equal(response.raw.includes('/fixture/homes'), false, 'no folder leaves the server');
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context-gauge: a failing or unconfigured gauge is an error, not an empty list', async () => {
  const failing = fakeRunner({ handle: (file) => (file === 'bash' ? { code: 1, stdout: '', stderr: '/secret/path boom', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: failing.runner });
  try {
    const { post } = await client(server);
    const response = await post('context-gauge');
    assert.equal(response.status, 502);
    assert.equal(response.raw.includes('/secret/path'), false);
  } finally { await server.close(); }
  const unconfigured = await startServer({ fmHome: null });
  try {
    const { post } = await client(unconfigured);
    assert.equal((await post('context-gauge')).status, 501);
  } finally { await unconfigured.close(); }
});

const quotaReport = (provider) => JSON.stringify({ generatedAt: '2026-10-21T08:20:18.161Z', schemaVersion: 5, providers: [provider] });
const quotaRunner = (stdout, code = 0) => fakeRunner({ handle: (file) => (file === 'quota-axi' ? { code, stdout, stderr: '/secret/path boom', timedOut: false, truncated: false } : undefined) });
const quotaWindow = (id, label, percentUsed, pace, resetsAt = '2026-10-25T21:59:59.888546+00:00') => ({ id, label, kind: 'weekly', percentUsed, resetsAt, windowSeconds: 604800, percentRemaining: 100 - percentUsed, pace });

test('plan-usage: returns the three Claude windows with pace and nothing else quota-axi knows', async () => {
  const report = quotaReport({
    provider: 'claude',
    plan: 'max-secret-plan',
    accountKeys: ['acct-secret-key'],
    state: { status: 'fresh', stale: false, refreshedAt: '2026-10-21T08:20:52.083Z' },
    windows: [
      quotaWindow('extra_usage', 'extra usage', 0, { status: 'unknown' }),
      quotaWindow('model:fable', 'Fable week', 78.04, { status: 'ahead', elapsedPercent: 34.7309, projectedExhaustedAt: '2026-10-23T00:00:00.000Z' }),
      quotaWindow('five_hour', 'session', 20, { status: 'behind', elapsedPercent: 83.6256 }, '2026-10-21T09:09:59.888489+00:00'),
      quotaWindow('seven_day', 'week', 30, { status: 'sideways', elapsedPercent: 34.7309 }),
    ],
  });
  const fake = quotaRunner(report);
  const server = await startServer({ runner: fake.runner });
  try {
    const { post } = await client(server);
    const response = await post('plan-usage');
    assert.equal(response.status, 200);
    const { windows, read_at: readAt } = response.json.data;
    assert.deepEqual(windows.map((item) => item.id), ['five_hour', 'seven_day', 'model:fable'], 'fixed order, extra usage dropped');
    assert.deepEqual(windows.map((item) => item.label), ['Current session', 'Current week', 'Current week (Fable)']);
    assert.deepEqual(windows.map((item) => item.percent_used), [20, 30, 78]);
    assert.deepEqual(windows.map((item) => item.pace), ['behind', 'unknown', 'ahead'], 'an unrecognised pace word becomes unknown');
    assert.equal(windows[0].resets_at, '2026-10-21T09:09:59.888Z');
    assert.equal(windows[0].elapsed_percent, 83.6);
    assert.equal(windows[2].projected_exhausted_at, '2026-10-23T00:00:00.000Z');
    assert.equal(readAt, '2026-10-21T08:20:52.083Z');
    assert.equal(response.raw.includes('acct-secret-key') || response.raw.includes('max-secret-plan'), false, 'no account or plan evidence leaves the server');
    const call = fake.calls.find((item) => item.file === 'quota-axi');
    assert.deepEqual(call.args, ['--provider', 'claude', '--full', '--json', '--no-credential-refresh', '--max-age', '1m']);
    assert.equal(server.api.ACTIONS['plan-usage'].tier, 0);
  } finally { await server.close(); }
});

test('plan-usage: fresh skips the reuse window, and the macOS certificate bundle is added only when the caller has none', async () => {
  const report = quotaReport({ provider: 'claude', state: { status: 'fresh' }, windows: [quotaWindow('five_hour', 'session', 5, { status: 'on_pace' })] });
  const fake = quotaRunner(report);
  const server = await startServer({ runner: fake.runner, env: {} });
  try {
    const { post } = await client(server);
    assert.equal((await post('plan-usage', { fresh: true })).status, 200);
    assert.equal((await post('plan-usage', { fresh: 'yes' })).status, 400, 'the browser can only send a boolean');
    assert.equal((await post('plan-usage', { account: 'other' })).status, 400, 'no other parameter is accepted');
    const [call] = fake.calls.filter((item) => item.file === 'quota-axi');
    assert.deepEqual(call.args, ['--provider', 'claude', '--full', '--json', '--no-credential-refresh']);
    assert.equal(call.env.NODE_EXTRA_CA_CERTS, fs.existsSync('/etc/ssl/cert.pem') ? '/etc/ssl/cert.pem' : undefined);
  } finally { await server.close(); }
  const own = quotaRunner(report);
  const kept = await startServer({ runner: own.runner, env: { NODE_EXTRA_CA_CERTS: '/custom/ca.pem' } });
  try {
    const { post } = await client(kept);
    assert.equal((await post('plan-usage')).status, 200);
    assert.equal(own.calls.find((item) => item.file === 'quota-axi').env.NODE_EXTRA_CA_CERTS, '/custom/ca.pem');
  } finally { await kept.close(); }
});

test('plan-usage: says what is missing instead of showing an empty or stale card', async () => {
  const cases = [
    { name: 'keychain approval', stdout: quotaReport({ provider: 'claude', windows: [], state: { status: 'auth_required' }, attempts: [{ source: 'keychain', status: 'failed', error: 'keychain_access_required' }] }), code: 0, expect: /Keychain approval/ },
    { name: 'vendor fetch failure', stdout: quotaReport({ provider: 'claude', windows: [], state: { status: 'error', error: 'fetch failed' } }), code: 0, expect: /could not be read \(fetch failed\)/ },
    { name: 'no claude entry', stdout: JSON.stringify({ providers: [] }), code: 0, expect: /could not be read/ },
    { name: 'stale cached windows', stdout: quotaReport({ provider: 'claude', windows: [quotaWindow('five_hour', 'session', 5, { status: 'on_pace' })], state: { status: 'stale', stale: true, error: 'fetch failed' } }), code: 0, expect: /stale/ },
    { name: 'stale flag alone', stdout: quotaReport({ provider: 'claude', windows: [quotaWindow('seven_day', 'week', 5, { status: 'on_pace' })], state: { status: 'fresh', stale: true } }), code: 0, expect: /stale/ },
    { name: 'quota-axi missing', stdout: '', code: 127, expect: /quota-axi installed/ },
  ];
  for (const item of cases) {
    const server = await startServer({ runner: quotaRunner(item.stdout, item.code).runner });
    try {
      const { post } = await client(server);
      const response = await post('plan-usage');
      assert.equal(response.status, 502, item.name);
      assert.match(response.raw, item.expect, item.name);
      assert.equal(response.raw.includes('/secret/path'), false, `${item.name}: no stderr leaks`);
    } finally { await server.close(); }
  }
});

const codexDay = (date, ...credits) => ({ date, values: Object.fromEntries(credits.map((value, index) => [`model-${index}`, value])) });
const codexHome = (tokens) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  if (tokens) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens }));
  return dir;
};
// Every day from `from` through `to` (YYYY-MM-DD) with 0 credits, so a test only names the days that carry usage.
const codexDays = (from, to, usage = {}) => {
  const days = [];
  for (let day = from; day <= to; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) days.push(codexDay(day, ...(usage[day] || [0])));
  return days;
};
const curlRunner = (body, status = 200, code = 0) => fakeRunner({ handle: (file) => (file === 'curl' ? { code, stdout: `${typeof body === 'string' ? body : JSON.stringify(body)}\n${status}`, stderr: '/secret/path boom', timedOut: false, truncated: false } : undefined) });

test('codex-credits: sums week to date (from Monday) and month to date, and never puts the token on a command line', async () => {
  const home = codexHome({ access_token: 'tok.en-secret_1', account_id: 'acct-id-1', refresh_token: 'refresh-secret' });
  const fake = curlRunner({ breakdown: 'model', data: [
    codexDay('2026-09-30', 50),
    ...codexDays('2026-10-01', '2026-10-21', { '2026-10-01': [1.5, 0.25], '2026-10-18': [10], '2026-10-19': [2, 1], '2026-10-21': [0.5, 0] }),
  ] });
  const server = await startServer({ runner: fake.runner, env: { CODEX_HOME: home }, now: () => new Date(2026, 9, 21, 15, 0) });
  try {
    const { post } = await client(server);
    const response = await post('codex-credits');
    assert.equal(response.status, 200);
    const data = response.json.data;
    assert.deepEqual(data.week, { since: '2026-10-19', credits: 3.5, usd: 0.14 }, 'Monday 19 October onward');
    assert.deepEqual(data.month, { since: '2026-10-01', credits: 15.25, usd: 0.61 }, 'the 1st onward, not September; 4 cents a credit');
    assert.equal(data.usd_per_credit, 0.04);
    assert.equal(data.month_limit, 3000, 'the limit comes from the server, next to the rate');
    assert.deepEqual(data.models.map((item) => item.model), ['model-0', 'model-1']);
    assert.equal(data.data_through, '2026-10-21');
    const call = fake.calls.find((item) => item.file === 'curl');
    assert.deepEqual(call.args, ['-K', '-'], 'the credential rides stdin, not argv');
    assert.match(call.input, /url = "https:\/\/chatgpt\.com\/backend-api\/wham\/usage\/daily-workspace-user-credit-usage\?start_date=2026-10-01&end_date=2026-10-2[12]&breakdown=model"/, 'the credit endpoint, an inclusive date range, split by model');
    assert.match(call.input, /Bearer tok\.en-secret_1/);
    assert.equal(response.raw.includes('secret'), false, 'no token or account evidence leaves the server');
    assert.equal(server.api.ACTIONS['codex-credits'].tier, 0);
    assert.equal((await post('codex-credits', { account: 'x' })).status, 400);
  } finally { await server.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('codex-credits: says what is missing instead of showing zeros', async () => {
  const good = { access_token: 'tok', account_id: 'acct' };
  const cases = [
    { name: 'no auth file', home: codexHome(null), runner: curlRunner({ data: [] }), expect: /Codex sign-in/ },
    { name: 'token with shell or config characters', home: codexHome({ access_token: 'a"b\nc', account_id: 'acct' }), runner: curlRunner({ data: [] }), expect: /Codex sign-in/ },
    { name: 'a missing day in the middle', home: codexHome(good), runner: curlRunner({ breakdown: 'model', data: [...codexDays('2026-10-01', '2026-10-09'), ...codexDays('2026-10-11', '2026-10-21')] }), expect: /incomplete/ },
    { name: 'the trailing day is missing', home: codexHome(good), runner: curlRunner({ breakdown: 'model', data: codexDays('2026-10-01', '2026-10-20') }), expect: /incomplete/ },
    { name: 'a day listed twice', home: codexHome(good), runner: curlRunner({ breakdown: 'model', data: [...codexDays('2026-10-01', '2026-10-21'), codexDay('2026-10-05', 3)] }), expect: /incomplete/ },
    { name: 'no access to the credit report', home: codexHome(good), runner: curlRunner({ detail: 'no' }, 403), expect: /not available for this account/ },
    { name: 'expired sign-in', home: codexHome(good), runner: curlRunner({ detail: 'no' }, 401), expect: /expired/ },
    { name: 'server error', home: codexHome(good), runner: curlRunner('oops', 500), expect: /HTTP 500/ },
    { name: 'unexpected body', home: codexHome(good), runner: curlRunner({ data: 'nope' }), expect: /could not be read/ },
    { name: 'a day with no values', home: codexHome(good), runner: curlRunner({ data: [codexDay('2026-10-01', 1), { date: '2026-10-02' }] }), expect: /incomplete/ },
    { name: 'a day with an empty values list', home: codexHome(good), runner: curlRunner({ data: [codexDay('2026-10-01', 1), { date: '2026-10-02', values: {} }] }), expect: /incomplete/ },
    { name: 'a model with a null amount', home: codexHome(good), runner: curlRunner({ data: [codexDay('2026-10-01', 1), { date: '2026-10-02', values: { m: null } }] }), expect: /incomplete/ },
    { name: 'a model with a text amount', home: codexHome(good), runner: curlRunner({ data: [codexDay('2026-10-01', 1), { date: '2026-10-02', values: { m: '5' } }] }), expect: /incomplete/ },
    { name: 'no days at all', home: codexHome(good), runner: curlRunner({ data: [] }), expect: /incomplete/ },
    { name: 'the first requested day is missing', home: codexHome(good), runner: curlRunner({ data: [codexDay('2026-10-05', 1)] }), expect: /incomplete/ },
    { name: 'curl missing', home: codexHome(good), runner: curlRunner('', 0, 127), expect: /curl/ },
  ];
  for (const item of cases) {
    const server = await startServer({ runner: item.runner.runner, env: { CODEX_HOME: item.home }, now: () => new Date(2026, 9, 21, 15, 0) });
    try {
      const { post } = await client(server);
      const response = await post('codex-credits');
      assert.equal(response.status, 502, item.name);
      assert.match(response.raw, item.expect, item.name);
      assert.equal(response.raw.includes('/secret/path'), false, `${item.name}: no stderr leaks`);
    } finally { await server.close(); fs.rmSync(item.home, { recursive: true, force: true }); }
  }
});

test('codex-credits: a breakdown that is not by model still totals, but never labels its keys as models', async () => {
  const home = codexHome({ access_token: 'tok', account_id: 'acct' });
  const fake = curlRunner({ breakdown: 'user', data: codexDays('2026-10-01', '2026-10-21', { '2026-10-21': [4] }) });
  const server = await startServer({ runner: fake.runner, env: { CODEX_HOME: home }, now: () => new Date(2026, 9, 21, 15, 0) });
  try {
    const { post } = await client(server);
    const response = await post('codex-credits');
    assert.equal(response.status, 200);
    assert.equal(response.json.data.month.credits, 4);
    assert.deepEqual(response.json.data.models, []);
  } finally { await server.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('leader-space: reports each identity as ok, missing, duplicate or elsewhere without changing anything', async () => {
  const panes = [
    { pane_id: 'wK:p5', workspace_id: 'wK', tab_id: 'wK:t5', agent: 'claude', agent_status: 'working', label: 'big-boss' },
    { pane_id: 'wK:p2', workspace_id: 'wK', tab_id: 'wK:t2', agent: 'claude', agent_status: 'idle', label: 'leader-esim', agent_session: { agent: 'claude', kind: 'id', value: 'abcdefgh-0000-4000-8000-000000000000' } },
    { pane_id: 'wK:p4', workspace_id: 'wK', tab_id: 'wK:t4', agent: 'claude', agent_status: 'idle', label: 'leader-nip' },
    { pane_id: 'wJ:p2', workspace_id: 'wJ', tab_id: 'wJ:t2', agent: 'claude', agent_status: 'idle', label: 'leader-nip' },
    { pane_id: 'wJ:p3', workspace_id: 'wJ', tab_id: 'wJ:t3', agent: 'claude', agent_status: 'idle', label: 'leader-workspaceos' },
    { pane_id: 'wK:p9', workspace_id: 'wK', tab_id: 'wK:t9', agent: 'claude', agent_status: 'idle', label: 'leader-extra' },
    { pane_id: 'wK:p8', workspace_id: 'wK', tab_id: 'wK:t8', agent: 'claude', agent_status: 'idle' },
  ];
  const workspaces = [{ workspace_id: 'wK', label: 'leader-space' }, { workspace_id: 'wJ', label: 'old workspace' }];
  const fake = fakeRunner({
    panes,
    sessions: [{ default: false, name: 'project-a', running: true }],
    handle: (file, args) => (file === 'herdr' && args.includes('workspace') && args.includes('list')
      ? { code: 0, stdout: JSON.stringify({ result: { workspaces } }), stderr: '', timedOut: false, truncated: false }
      : undefined),
  });
  const server = await startServer({ runner: fake.runner });
  try {
    const { post } = await client(server);
    const response = await post('leader-space');
    assert.equal(response.status, 200);
    const byLabel = Object.fromEntries(response.json.data.rows.map((row) => [row.label, row]));
    assert.equal(byLabel['big-boss'].state, 'ok');
    assert.equal(byLabel['leader-esim'].state, 'ok');
    assert.equal(byLabel['leader-esim'].panes[0].id, 'abcdefgh', 'the row carries the first 8 characters of the pane\'s session id, so Open can name the session');
    assert.equal(byLabel['big-boss'].panes[0].id, '', 'a pane with no session has no prefix');
    assert.equal(response.raw.includes('abcdefgh-0000'), false, 'never more than 8 characters of a session id');
    assert.equal(byLabel['leader-nip'].state, 'duplicate', 'two panes carry the label');
    assert.equal(byLabel['leader-workspaceos'].state, 'elsewhere', 'one pane, but outside leader-space');
    assert.equal(byLabel['leader-fleet-watch'].state, 'missing');
    assert.equal(byLabel['leader-personal-work'].state, 'missing');
    assert.deepEqual(response.json.data.unexpected.map((item) => item.label), ['leader-extra']);
    assert.equal(response.json.data.workspace, 'leader-space');
    assert.equal((await post('leader-space', { session: 'project-a' })).status, 400, 'the browser sends no params');
    assert.equal(server.api.ACTIONS['leader-space'].tier, 0);
    assert.equal(fake.calls.some((call) => call.args.some((arg) => ['rename', 'close', 'move', 'create'].includes(arg))), false, 'read-only calls only');
  } finally { await server.close(); }
});

test('handoff-command: builds a copy-only send command from the live audit for ticked identities only', async () => {
  const panes = [
    { pane_id: 'wK:p5', workspace_id: 'wK', tab_id: 'wK:t5', agent: 'claude', agent_status: 'working', label: 'big-boss' },
    { pane_id: 'wK:p2', workspace_id: 'wK', tab_id: 'wK:t2', agent: 'claude', agent_status: 'idle', label: 'leader-esim' },
    { pane_id: 'wK:p4', workspace_id: 'wK', tab_id: 'wK:t4', agent: 'claude', agent_status: 'idle', label: 'leader-nip' },
    { pane_id: 'wJ:p2', workspace_id: 'wJ', tab_id: 'wJ:t2', agent: 'claude', agent_status: 'idle', label: 'leader-nip' },
  ];
  const workspaces = [{ workspace_id: 'wK', label: 'leader-space' }, { workspace_id: 'wJ', label: 'old workspace' }];
  const fake = fakeRunner({
    panes,
    sessions: [{ default: false, name: 'project-a', running: true }],
    handle: (file, args) => (file === 'herdr' && args.includes('workspace') && args.includes('list')
      ? { code: 0, stdout: JSON.stringify({ result: { workspaces } }), stderr: '', timedOut: false, truncated: false }
      : undefined),
  });
  const server = await startServer({ runner: fake.runner });
  try {
    const { post } = await client(server);
    const response = await post('handoff-command', { labels: ['leader-esim', 'leader-nip', 'leader-fleet-watch'] });
    assert.equal(response.status, 200);
    const data = response.json.data;
    assert.deepEqual(data.ready, [{ label: 'leader-esim', herdr_session: 'project-a', pane_id: 'wK:p2' }]);
    assert.deepEqual(data.skipped, [{ label: 'leader-nip', state: 'duplicate' }, { label: 'leader-fleet-watch', state: 'missing' }]);
    assert.equal(data.command, `herdr --session project-a pane send-text wK:p2 '${data.text}' && herdr --session project-a pane send-keys wK:p2 Enter`);
    assert.equal(data.text.includes("'"), false, 'the fixed text cannot break out of its quotes');
    assert.equal((await post('handoff-command', { labels: ['leader-nip'] })).json.data.command, null, 'no command when nothing is ready');
    assert.equal((await post('handoff-command', { labels: ['rm -rf /'] })).status, 400, 'only known identities');
    assert.equal((await post('handoff-command', { labels: [] })).status, 400);
    assert.equal((await post('handoff-command', { labels: ['leader-esim'], text: 'x' })).status, 400, 'the browser sends no text');
    assert.equal(server.api.ACTIONS['handoff-command'].tier, 0);
    assert.equal(fake.calls.some((call) => call.args.some((arg) => ['send-text', 'send-keys', 'rename', 'close'].includes(arg))), false, 'nothing is sent from the server');
  } finally { await server.close(); }
});

test('handoff-command: any live Claude pane can be ticked by reference, with text that names no home folder', async () => {
  const id = (n) => `aaaaaaa${n}-bbbb-4ccc-8ddd-00000000000${n}`;
  const agent = (n) => ({ agent: 'claude', agent_session: { agent: 'claude', kind: 'id', value: id(n) } });
  const panes = [
    { pane_id: 'wK:p2', workspace_id: 'wK', agent_status: 'idle', label: 'leader-esim', ...agent(1) },
    { pane_id: 'wX:p2', workspace_id: 'wX', agent_status: 'idle', ...agent(2) },
    { pane_id: 'wX:p3', workspace_id: 'wX', agent_status: 'idle', agent: 'codex', agent_session: { agent: 'codex', kind: 'id', value: id(3) } },
  ];
  const fake = fakeRunner({
    panes,
    sessions: [{ default: false, name: 'project-a', running: true }, { default: false, name: 'stopped-one', running: false }],
    handle: (file, args) => (file === 'herdr' && args.includes('workspace') && args.includes('list')
      ? { code: 0, stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: 'wK', label: 'leader-space' }] } }), stderr: '', timedOut: false, truncated: false }
      : undefined),
  });
  const server = await startServer({ runner: fake.runner });
  try {
    const { post } = await client(server);
    const response = await post('handoff-command', { labels: ['leader-esim'], panes: ['project-a|wX:p2|aaaaaaa2', 'project-a|wK:p2|aaaaaaa1', 'project-a|wX:p3|aaaaaaa3', 'project-a|wZ:p9|aaaaaaa9', 'stopped-one|wX:p2|aaaaaaa2', 'project-a|wX:p2|aaaaaaa7'] });
    assert.equal(response.status, 200);
    const data = response.json.data;
    assert.deepEqual(data.ready, [{ label: 'leader-esim', herdr_session: 'project-a', pane_id: 'wK:p2' }, { label: '', herdr_session: 'project-a', pane_id: 'wX:p2' }]);
    assert.deepEqual(data.skipped.map((item) => item.label), ['wX:p3', 'wZ:p9', 'wX:p2', 'wX:p2'], 'a codex pane, an unknown pane, a stopped session and a pane that runs another session now are skipped; a pane already taken as a leader is not repeated');
    assert.equal(data.skipped[3].state, 'runs another session now', 'a pane id reused by another session is never offered');
    const lines = data.command.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes(data.text) && data.text.includes('own home folder'));
    assert.ok(lines[1].includes(`'${data.other_text}'`) && !data.other_text.includes('home folder'));
    assert.equal((await post('handoff-command', { panes: ['bad ref'] })).status, 400, 'only well-formed references');
    assert.equal((await post('handoff-command', { panes: ["a'b|wX:p2|aaaaaaa2"] })).status, 400);
    assert.equal((await post('handoff-command', { panes: ['project-a|wX:p2'] })).status, 400, 'a reference without the session id is refused');
    assert.equal((await post('handoff-command', { panes: ['project-a|wX:p2|short'] })).status, 400);
    assert.equal((await post('handoff-command', {})).status, 400);
    assert.equal((await post('handoff-command', { panes: ['project-a|wX:p2|aaaaaaa2'], text: 'x' })).status, 400, 'the browser sends no text');
    assert.equal(fake.calls.some((call) => call.args.some((arg) => ['send-text', 'send-keys', 'rename', 'close'].includes(arg))), false, 'nothing is sent from the server');
  } finally { await server.close(); }
});

// A fixture for `handoff-restart-command`: ordinary Claude panes read from a transcript (kind "session"), one fleet pane the gauge names,
// one Claude pane with no transcript and no gauge row, and a codex pane. Every Herdr session gets its own pane list.
function restartFixture() {
  const { tempTree } = require('./helpers');
  const tree = tempTree('herdr-organizer-restart-');
  const id = (n) => `aaaaaaa${n}-bbbb-4ccc-8ddd-00000000000${n}`;
  const usage = JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 60000).toISOString(), message: { model: 'claude-x', usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 99000 } } });
  for (const n of [2, 4, 6]) tree.write(`claude/projects/-proj/${id(n)}.jsonl`, `${usage}\n`);
  const pane = (paneId, n, extra = {}) => ({ pane_id: paneId, workspace_id: paneId.split(':')[0], tab_id: `${paneId.split(':')[0]}:t1`, agent: 'claude', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', value: id(n) }, ...extra });
  const lists = {
    'project-a': [pane('wX:p2', 2), pane('wX:p4', 4), pane('wS:p1', 5, { label: 'ship-one' }), pane('wX:p7', 7), pane('wX:p3', 3, { agent: 'codex', agent_session: { agent: 'codex', kind: 'id', value: id(3) } })],
    'project-b': [pane('wY:p1', 6)],
  };
  const gauge = JSON.stringify({ session_id: id(5), map: 'ship-one', kind: 'ship', current: true, source: 'statusline', window_inferred: false, input_tokens: 90000, percent: 9, busy: 'idle claude-hook', age_s: 30 }) + '\n';
  const fake = fakeRunner({
    sessions: [{ default: false, name: 'project-a', running: true }, { default: false, name: 'project-b', running: true }, { default: false, name: 'stopped-one', running: false }],
    handle: (file, args) => {
      if (file === 'bash') return { code: 0, stdout: gauge, stderr: '', timedOut: false, truncated: false };
      if (file === 'herdr' && args[0] === '--session' && args[2] === 'pane' && args[3] === 'list') {
        return { code: 0, stdout: JSON.stringify({ result: { panes: lists[args[1]] || [] } }), stderr: '', timedOut: false, truncated: false };
      }
      return undefined;
    },
  });
  return { tree, fake, root: tree.abs('claude') };
}

test('handoff-restart-command: builds one copy-only command per Herdr session for ordinary Claude panes, with the exact confirm string', async () => {
  const { tree, fake, root } = restartFixture();
  const server = await startServer({ runner: fake.runner, env: { CLAUDE_CONFIG_DIR: root } });
  try {
    const { post } = await client(server);
    const response = await post('handoff-restart-command', { panes: ['project-a|wX:p4|aaaaaaa4', 'project-b|wY:p1|aaaaaaa6', 'project-a|wX:p2|aaaaaaa2', 'project-a|wX:p2|aaaaaaa2'] });
    assert.equal(response.status, 200);
    const data = response.json.data;
    assert.deepEqual(data.ready, [
      { label: '', herdr_session: 'project-a', pane_id: 'wX:p4', id: 'aaaaaaa4' },
      { label: '', herdr_session: 'project-b', pane_id: 'wY:p1', id: 'aaaaaaa6' },
      { label: '', herdr_session: 'project-a', pane_id: 'wX:p2', id: 'aaaaaaa2' },
    ], 'a repeated reference is made once');
    assert.deepEqual(data.skipped, []);
    assert.deepEqual(data.command.split('\n'), [
      'herdr-organizer --session project-a handoff-restart --pane wX:p4:aaaaaaa4 --pane wX:p2:aaaaaaa2 --execute --confirm handoff-restart:project-a:aaaaaaa2,aaaaaaa4',
      'herdr-organizer --session project-b handoff-restart --pane wY:p1:aaaaaaa6 --execute --confirm handoff-restart:project-b:aaaaaaa6',
    ], 'the confirm names the distinct ids in ascii order whatever the order of the panes, and the command carries no path and no other flag');
    assert.equal(response.raw.includes('-bbbb-4ccc'), false, 'never more than 8 characters of a session id');
    assert.equal(response.raw.includes(root), false, 'no private path leaves the server');
    assert.equal(server.api.ACTIONS['handoff-restart-command'].tier, 0);
    assert.equal(fake.calls.some((call) => call.args.some((arg) => ['send-text', 'send-keys', 'prompt', 'rename', 'close'].includes(arg))), false, 'nothing is sent from the server');
  } finally { await server.close(); tree.cleanup(); }
});

test('handoff-restart-command: a fleet pane, a codex pane, a reused pane id, a stopped session and a pane the gauge cannot name are skipped', async () => {
  const { tree, fake, root } = restartFixture();
  const server = await startServer({ runner: fake.runner, env: { CLAUDE_CONFIG_DIR: root } });
  try {
    const { post } = await client(server);
    const response = await post('handoff-restart-command', { panes: ['project-a|wS:p1|aaaaaaa5', 'project-a|wX:p3|aaaaaaa3', 'project-a|wX:p2|aaaaaaa9', 'project-a|wZ:p9|aaaaaaa2', 'stopped-one|wX:p2|aaaaaaa2', 'project-a|wX:p7|aaaaaaa7', 'project-a|wX:p2|aaaaaaa2'] });
    assert.equal(response.status, 200);
    const data = response.json.data;
    assert.deepEqual(data.ready.map((item) => item.pane_id), ['wX:p2']);
    assert.deepEqual(data.skipped.map((item) => [item.label, item.state]), [
      ['ship-one', 'a firstmate session, or one the gauge cannot name'],
      ['wX:p3', 'no live Claude pane'],
      ['wX:p2', 'runs another session now'],
      ['wZ:p9', 'no live Claude pane'],
      ['wX:p2', 'session not running'],
      ['wX:p7', 'a firstmate session, or one the gauge cannot name'],
    ]);
    assert.equal(data.command, 'herdr-organizer --session project-a handoff-restart --pane wX:p2:aaaaaaa2 --execute --confirm handoff-restart:project-a:aaaaaaa2');
  } finally { await server.close(); tree.cleanup(); }
});

test('handoff-restart-command: a fleet row is never offered, and nothing is built when nothing is left', async () => {
  const { tree, fake, root } = restartFixture();
  const server = await startServer({ runner: fake.runner, env: { CLAUDE_CONFIG_DIR: root } });
  try {
    const { post } = await client(server);
    const response = await post('handoff-restart-command', { panes: ['project-a|wS:p1|aaaaaaa5'] });
    assert.equal(response.status, 200);
    assert.equal(response.json.data.command, null);
    assert.deepEqual(response.json.data.ready, []);
  } finally { await server.close(); tree.cleanup(); }
});

test('handoff-restart-command: only well-formed references are taken, and the browser sends no text, flag or path', async () => {
  const { tree, fake, root } = restartFixture();
  const server = await startServer({ runner: fake.runner, env: { CLAUDE_CONFIG_DIR: root } });
  try {
    const { post } = await client(server);
    for (const panes of [[], 'project-a|wX:p2|aaaaaaa2', ['bad ref'], ["a'b|wX:p2|aaaaaaa2"], ['project-a|wX:p2'], ['project-a|wX:p2|short'], ['project-a|wX:p2|aaaaaaa_'], ['project-a|wX:p2|aaaaaaa2; id'], [1]]) {
      assert.equal((await post('handoff-restart-command', { panes })).status, 400, JSON.stringify(panes));
    }
    assert.equal((await post('handoff-restart-command', {})).status, 400);
    assert.equal((await post('handoff-restart-command', { panes: ['project-a|wX:p2|aaaaaaa2'], text: 'x' })).status, 400);
    assert.equal((await post('handoff-restart-command', { panes: ['project-a|wX:p2|aaaaaaa2'], confirm: 'x', flags: ['--skip-fleet-gauge'] })).status, 400);
    assert.equal(fake.calls.length, 0, 'a refused request spawns nothing');
  } finally { await server.close(); tree.cleanup(); }
});

test('handoff-restart-command: an unreadable gauge is an error, so fleet sessions are never guessed', async () => {
  const failing = fakeRunner({ handle: (file) => (file === 'bash' ? { code: 1, stdout: '', stderr: '/secret/path boom', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: failing.runner });
  try {
    const { post } = await client(server);
    const response = await post('handoff-restart-command', { panes: ['project-a|wX:p2|aaaaaaa2'] });
    assert.equal(response.status, 502);
    assert.equal(response.raw.includes('/secret/path'), false);
  } finally { await server.close(); }
});

// R5-7: a pane that had /clear typed by `handoff-restart` and that Herdr still reports under its old session id.
function clearMarkFixture(records) {
  const { tempTree } = require('./helpers');
  const tree = tempTree('herdr-organizer-marks-');
  const id = (n) => `aaaaaaa${n}-bbbb-4ccc-8ddd-00000000000${n}`;
  const usage = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-x', usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 99000 } } });
  for (const n of [1, 2, 3, 4]) tree.write(`claude/projects/-proj/${id(n)}.jsonl`, `${usage}\n`);
  const pane = (paneId, n) => ({ pane_id: paneId, workspace_id: 'wX', tab_id: 'wX:t1', agent: 'claude', agent_status: 'idle', agent_session: { agent: 'claude', kind: 'id', value: id(n) } });
  const fake = fakeRunner({
    sessions: [{ default: false, name: 'project-a', running: true }],
    panes: [pane('wX:p1', 1), pane('wX:p2', 2), pane('wX:p3', 3), pane('wX:p4', 4)],
    handle: (file) => (file === 'bash' ? { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false } : undefined),
  });
  for (const [name, record] of Object.entries(records)) tree.write(`tools/state/workspace-organizer/handoff-runs/${name}`, typeof record === 'string' ? record : JSON.stringify(record));
  return { tree, fake, root: tree.abs('claude'), toolRoot: tree.abs('tools') };
}
const clearRecord = (run, panes, extra = {}) => ({ version: 1, run_id: run, session: 'project-a', started_at: '2026-10-26T01:00:00+00:00', confirm: 'handoff-restart:project-a:x', panes, ...extra });
const clearedPane = (paneId, before, at, extra = {}) => ({ pane_id: paneId, id8_before: before, id8_after: before, label: 'x', step: 'clear', state: 'typed_unconfirmed', reason: 'typed_unconfirmed', updated_at: at, document: '/Users/someone/private/handoff.md', clear_typed_at: at, ...extra });

test('context-gauge: a pane with a typed /clear that Herdr still reports under the old id carries the time, the run and an under-12-hours flag, and nothing else from the record', async () => {
  const records = {
    'handoff-20261026-010000-aaaaaa.json': clearRecord('handoff-20261026-010000-aaaaaa', {
      'wX:p1': clearedPane('wX:p1', 'aaaaaaa1', '2026-10-26T01:25:13+00:00'),
      'wX:p2': clearedPane('wX:p2', 'aaaaaaa2', '2026-10-25T13:00:00+00:00'),
      'wX:p3': clearedPane('wX:p3', 'ffffffff', '2026-10-26T01:25:13+00:00'),
      'wX:p4': { pane_id: 'wX:p4', id8_before: 'aaaaaaa4', state: 'refused', reason: 'working', updated_at: '2026-10-26T01:25:13+00:00' },
    }),
  };
  const { tree, fake, root, toolRoot } = clearMarkFixture(records);
  const server = await startServer({ runner: fake.runner, toolRoot, env: { CLAUDE_CONFIG_DIR: root }, now: () => new Date('2026-10-26T02:30:00Z') });
  try {
    const { post } = await client(server);
    const response = await post('context-gauge');
    assert.equal(response.status, 200);
    const rows = Object.fromEntries(response.json.data.rows.map((row) => [row.pane_id, row]));
    assert.deepEqual([rows['wX:p1'].cleared_at, rows['wX:p1'].cleared_run, rows['wX:p1'].still_old_id], ['2026-10-26T01:25:13.000Z', 'handoff-20261026-010000-aaaaaa', true], 'cleared an hour ago and the id is unchanged');
    assert.deepEqual([rows['wX:p2'].cleared_at, rows['wX:p2'].still_old_id], ['2026-10-25T13:00:00.000Z', false], 'older than 12 hours: the time stays for the stale note, the flag goes');
    assert.equal(rows['wX:p3'].cleared_at, undefined, 'the pane reports another id than the record names, so Herdr did update it');
    assert.equal(rows['wX:p4'].cleared_at, undefined, 'a pane the run only refused had no /clear typed');
    assert.equal(response.raw.includes('/Users/someone'), false, 'the document path never leaves the server');
    assert.equal(response.raw.includes('document'), false);
    assert.equal(response.raw.includes('handoff-restart:'), false, 'neither does the confirm string');
  } finally { await server.close(); tree.cleanup(); }
});

test('context-gauge: the newest typed /clear for a pane wins, and a record that is not trustworthy is ignored', async () => {
  const good = (run, at) => clearRecord(run, { 'wX:p1': clearedPane('wX:p1', 'aaaaaaa1', at) });
  const records = {
    'handoff-20261026-000000-aaaaaa.json': good('handoff-20261026-000000-aaaaaa', '2026-10-26T00:10:00+00:00'),
    'handoff-20261026-020000-bbbbbb.json': good('handoff-20261026-020000-bbbbbb', '2026-10-26T02:10:00+00:00'),
    'handoff-20261026-021000-cccccc.json': good('handoff-20261026-999999-zzzzzz', '2026-10-26T02:20:00+00:00'),
    'handoff-20261026-022000-dddddd.json': '{not json',
    'handoff-20261026-023000-eeeeee.json': clearRecord('handoff-20261026-023000-eeeeee', { 'wX:p1': clearedPane('wX:p1', 'aaaaaaa1', 'yesterday') }),
    'handoff-20261026-024000-ffffff.json': clearRecord('handoff-20261026-024000-ffffff', { 'bad pane': clearedPane('bad pane', 'aaaaaaa1', '2026-10-26T02:25:00+00:00') }, { session: '-h' }),
    'notes.json': good('notes', '2026-10-26T02:28:00+00:00'),
  };
  const { tree, fake, root, toolRoot } = clearMarkFixture(records);
  const server = await startServer({ runner: fake.runner, toolRoot, env: { CLAUDE_CONFIG_DIR: root }, now: () => new Date('2026-10-26T02:30:00Z') });
  try {
    const { post } = await client(server);
    const row = (await post('context-gauge')).json.data.rows.find((item) => item.pane_id === 'wX:p1');
    assert.deepEqual([row.cleared_run, row.cleared_at], ['handoff-20261026-020000-bbbbbb', '2026-10-26T02:10:00.000Z'], 'a record whose run id is not its file name, bad JSON, a bad time, a bad session or pane and a stray file name are never used');
  } finally { await server.close(); tree.cleanup(); }
});

test('context-gauge: a run-record folder that is a link is not read, and a missing one marks nothing', async () => {
  const { tree, fake, root, toolRoot } = clearMarkFixture({});
  tree.mkdir('real-runs');
  tree.write('real-runs/handoff-20261026-010000-aaaaaa.json', JSON.stringify(clearRecord('handoff-20261026-010000-aaaaaa', { 'wX:p1': clearedPane('wX:p1', 'aaaaaaa1', '2026-10-26T01:25:13+00:00') })));
  tree.link('tools/state/workspace-organizer/handoff-runs', tree.abs('real-runs'));
  const server = await startServer({ runner: fake.runner, toolRoot, env: { CLAUDE_CONFIG_DIR: root }, now: () => new Date('2026-10-26T02:30:00Z') });
  try {
    const { post } = await client(server);
    assert.equal((await post('context-gauge')).json.data.rows.some((row) => row.cleared_at), false);
  } finally { await server.close(); tree.cleanup(); }
  const none = clearMarkFixture({});
  const second = await startServer({ runner: none.fake.runner, toolRoot: none.toolRoot, env: { CLAUDE_CONFIG_DIR: none.root } });
  try {
    const { post } = await client(second);
    const response = await post('context-gauge');
    assert.equal(response.status, 200);
    assert.equal(response.json.data.rows.some((row) => row.cleared_at), false);
  } finally { await second.close(); none.tree.cleanup(); }
});

test('focus-tab: shows the tab of a live pane, finds the tab itself and sends nothing into any pane', async () => {
  const fake = fakeRunner({
    handle: (file, args) => (file === 'herdr' && args.includes('tab') && args.includes('focus')
      ? { code: 0, stdout: '{"result":{"type":"ok"}}', stderr: '', timedOut: false, truncated: false }
      : undefined),
  });
  const server = await startServer({ runner: fake.runner });
  try {
    const { post } = await client(server);
    const response = await post('focus-tab', { session: 'project-a', pane_id: 'w1:p1', id: '11111111' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.data, { herdr_session: 'project-a', tab_id: 'w1:t1' });
    const focus = fake.calls.filter((call) => call.args.includes('focus'));
    assert.equal(focus.length, 1);
    assert.deepEqual(focus[0].args, ['--session', 'project-a', 'tab', 'focus', 'w1:t1'], 'the tab comes from the live pane list');
    assert.equal(fake.calls.some((call) => call.args.some((arg) => ['send-text', 'send-keys', 'run', 'prompt', 'close', 'rename'].includes(arg))), false);
    assert.equal(server.api.ACTIONS['focus-tab'].lock, false, 'opening a tab never waits on a seal');
  } finally { await server.close(); }
});

test('focus-tab: refuses a stopped or default session, a malformed or unknown pane, extra params and a tab id from the browser', async () => {
  const fake = fakeRunner();
  const server = await startServer({ runner: fake.runner });
  try {
    const { post } = await client(server);
    for (const session of ['default', 'stopped-one', 'nope', '-h', '--execute']) assert.equal((await post('focus-tab', { session, pane_id: 'w1:p1', id: '11111111' })).status, 400, session);
    for (const pane_id of ['bad', "w2:p1'; rm -rf /", '--all', 'w2:t1']) assert.equal((await post('focus-tab', { session: 'project-a', pane_id, id: '11111111' })).status, 400, pane_id);
    const gone = await post('focus-tab', { session: 'project-a', pane_id: 'w9:p9', id: '11111111' });
    assert.equal(gone.status, 404);
    assert.equal(gone.json.code, 'pane_gone');
    assert.equal((await post('focus-tab', { session: 'project-a', pane_id: 'w1:p1', id: '11111111', tab_id: 'w1:t1' })).status, 400, 'the browser names no tab');
    assert.equal((await post('focus-tab', { session: 'project-a' })).status, 400);
    assert.equal((await post('focus-tab', { session: 'project-a', pane_id: 'w1:p1' })).status, 400, 'the row\'s session id is required');
    for (const id of ['short', '1111111111', "1111111';", '--all', '11111 11']) assert.equal((await post('focus-tab', { session: 'project-a', pane_id: 'w1:p1', id })).status, 400, id);
    assert.equal(fake.calls.filter((call) => call.args.includes('focus')).length, 0, 'nothing was focused');
  } finally { await server.close(); }
});

test('focus-tab: a pane that runs another session than the row showed is refused and nothing is focused', async () => {
  const fake = fakeRunner();
  const server = await startServer({ runner: fake.runner });
  try {
    const { post } = await client(server);
    // Pane w1:p1 runs session 11111111-...; the row was read when that pane ran another session.
    const moved = await post('focus-tab', { session: 'project-a', pane_id: 'w1:p1', id: '99999999' });
    assert.equal(moved.status, 409);
    assert.equal(moved.json.code, 'session_moved');
    // A pane with no agent session at all cannot match any row.
    const none = await post('focus-tab', { session: 'project-a', pane_id: 'w2:p1', id: '11111111' });
    assert.equal(none.status, 409);
    assert.equal(none.json.code, 'session_moved');
    assert.equal(fake.calls.filter((call) => call.args.includes('focus')).length, 0, 'no tab was focused');
    assert.equal(moved.raw.includes('11111111-2222'), false, 'no full session id reaches the browser');
  } finally { await server.close(); }
});

test('focus-tab: a Herdr failure is reported, not hidden', async () => {
  const fake = fakeRunner({ handle: (file, args) => (args.includes('tab') && args.includes('focus') ? { code: 1, stdout: '', stderr: 'no such tab', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ runner: fake.runner });
  try {
    const { post } = await client(server);
    const response = await post('focus-tab', { session: 'project-a', pane_id: 'w1:p1', id: '11111111' });
    assert.equal(response.status, 502);
    assert.equal(response.json.code, 'herdr_unavailable');
    assert.equal(response.raw.includes('no such tab'), false, 'Herdr output does not reach the browser');
  } finally { await server.close(); }
});
