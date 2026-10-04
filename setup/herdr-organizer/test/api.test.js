'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  const env = childEnv({ PATH: '/bin', HERDR_SESSION: 'x', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/s', HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 't', HERDR_ENV: '1', HERDR_LAB_HELPER: '/lab', HERDR_AGENT_MANIFEST: '/m' });
  assert.deepEqual(Object.keys(env).sort(), ['HERDR_AGENT_MANIFEST', 'HERDR_LAB_HELPER', 'PATH']);
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
    assert.deepEqual(data.totals, { workspaces: 2, workspaces_with_empty_tabs: 1, tabs_to_close: 2, protected_tabs: 3, errors: 0 });
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
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-organizer-test-'));
  const dir = path.join(root, 'state', 'workspace-organizer');
  fs.mkdirSync(dir, { recursive: true });
  const server = await startServer({ toolRoot: root });
  try {
    const { post } = await client(server);
    const missing = await post('snapshot-data');
    assert.equal(missing.status, 404);
    fs.writeFileSync(path.join(dir, 'live-snapshot.json'), JSON.stringify({ herdr_session: 'project-a', workspaces: [{ id: 'w1', label: 'Alpha', tabs: [] }], archives: [] }));
    const ok = await post('snapshot-data');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.workspaces[0].label, 'Alpha');
    fs.writeFileSync(path.join(dir, 'live-snapshot.json'), JSON.stringify({ workspaces: [{ id: 'w1', label: 'claude --resume 11111111-2222-4333-8444-555555555555', tabs: [] }] }));
    const leaky = await post('snapshot-data');
    assert.equal(leaky.status, 502);
    assert.equal(leaky.raw.includes('11111111'), false);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
