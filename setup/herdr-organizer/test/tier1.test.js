'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, client, fakeRunner, fixture, tempTree } = require('./helpers');
const { findLeaks } = require('../text');

const ID = '0f1e2d3c-4b5a-4968-8777-665544332211';
const MASKED = '0f1e...2211';

// A server whose pane list points at a real temporary folder, since the write path only
// accepts a pane whose working directory exists. `done()` removes only what the test made.
async function manualServer({ storeCheck, panes, serverEnv, handle } = {}) {
  const tree = tempTree('herdr-organizer-cwd-');
  tree.mkdir('work/alpha/sub');
  const real = fs.realpathSync(tree.abs('work/alpha/sub'));
  const runner = fakeRunner({ paneCwd: real, storeCheck, panes: typeof panes === 'function' ? panes(real, tree) : panes, handle });
  const server = await startServer({ runner: runner.runner, env: serverEnv });
  return { server, calls: runner.calls, real, tree, done: async () => { await server.close(); tree.cleanup(); } };
}

async function verified(post) {
  const response = await post('verify', { session: 'project-a' });
  assert.equal(response.status, 200);
}

const manual = (overrides = {}) => ({ session: 'project-a', pane_id: 'w1:p2', client: 'codex', session_id: ID, confirm: 'save:w1:p2', ...overrides });
const registerCalls = (calls) => calls.filter((call) => call.args.includes('register'));

test('verify-apply: needs the exact confirm token and runs only the tool\'s own apply path', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    for (const confirm of ['', 'apply:project-b', 'apply', 'yes']) {
      const refused = await post('verify-apply', { session: 'project-a', confirm });
      assert.equal(refused.status, 400, confirm);
      assert.equal(refused.json.code, 'confirm_required');
    }
    assert.equal(server.calls.filter((call) => call.args.includes('--apply')).length, 0, 'nothing ran without the token');
    const ok = await post('verify-apply', { session: 'project-a', confirm: 'apply:project-a' });
    assert.equal(ok.status, 200);
    assert.deepEqual({ w: ok.json.data.written, s: ok.json.data.skipped, v: ok.json.data.initially_verified }, { w: 1, s: 0, v: 1 });
    const call = server.calls.find((entry) => entry.args.includes('--apply'));
    assert.deepEqual(call.args.slice(1), ['verify-identity', '--herdr-session', 'project-a', '--apply']);
    assert.equal(ok.raw.includes('Alpha space'), false, 'rows and labels are not echoed');
  } finally { await server.close(); }
});

test('verify-apply: default and stopped sessions are refused', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    for (const name of ['default', 'stopped-one', '-h']) assert.equal((await post('verify-apply', { session: name, confirm: 'apply:' + name })).status, 400, name);
    assert.equal(server.calls.filter((call) => call.args.includes('--apply')).length, 0);
  } finally { await server.close(); }
});

test('save-manual-identity: saves through register with explicit pane ids, a stdin store check and a masked result', async () => {
  const env = await manualServer({ serverEnv: { HERDR_PANE_ID: 'w9:p9', HERDR_SESSION: 'other', HERDR_SOCKET_PATH: '/x', PATH: process.env.PATH } });
  try {
    const { post } = await client(env.server);
    await verified(post);
    const response = await post('save-manual-identity', manual());
    assert.equal(response.status, 200, response.raw);
    assert.equal(response.json.data.masked_id, MASKED);
    assert.equal(response.json.data.folder_confirmed, 'match');
    assert.equal(response.raw.includes(ID), false, 'the full id is never returned');

    const check = env.calls.find((call) => typeof call.args[0] === 'string' && call.args[0].endsWith('store_check.py'));
    assert.equal(check.args.join(' ').includes(ID), false, 'the store check receives the id on stdin, not argv');
    assert.deepEqual(JSON.parse(check.input), { client: 'codex', session_id: ID, pane_cwd: env.real, herdr_session: 'project-a', pane_id: 'w1:p2' });

    const [register] = registerCalls(env.calls);
    assert.deepEqual(register.args.slice(1), ['register', '--client', 'codex', '--session-id', ID, '--allow-no-herdr', '--pane-id', 'w1:p2', '--workspace-id', 'w1', '--tab-id', 'w1:t2', '--herdr-session', 'project-a', '--cwd', env.real]);
    assert.equal(Object.keys(register.env).some((key) => key.startsWith('HERDR_')), false, 'no Herdr context reaches register');
  } finally { await env.done(); }
});

test('save-manual-identity: saves without any identity check, and a check can only add protection', async () => {
  const env = await manualServer();
  try {
    const { post } = await client(env.server);
    const early = await post('save-manual-identity', manual());
    assert.equal(early.status, 200, early.raw);
    assert.equal(early.json.data.masked_id, MASKED);
    assert.equal(registerCalls(env.calls).length, 1);
    assert.equal(early.raw.includes(ID), false);
  } finally { await env.done(); }
});

test('save-manual-identity: replacing a different registered session needs the confirmation unless a check found the pane unverified', async () => {
  const other = { valid_format: true, exists: true, store_folder: 'match', registered_elsewhere: false, already_registered_here: false, pane_registered_other: true };
  const env = await manualServer({ storeCheck: other });
  try {
    const { post } = await client(env.server);
    const refused = await post('save-manual-identity', manual());
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'pane_registered');
    assert.equal(registerCalls(env.calls).length, 0);
    const confirmed = await post('save-manual-identity', manual({ replace_existing: true }));
    assert.equal(confirmed.status, 200, confirmed.raw);
    assert.equal(registerCalls(env.calls).length, 1);
    // The folder override does not stand in for the replacement.
    const folderOnly = await post('save-manual-identity', manual({ folder_override: true }));
    assert.equal(folderOnly.json.code, 'pane_registered');
    // A recent check that found this pane unverified already says it may be replaced.
    await verified(post);
    const afterCheck = await post('save-manual-identity', manual());
    assert.equal(afterCheck.status, 200, afterCheck.raw);
  } finally { await env.done(); }
});

test('save-manual-identity: refuses for verified panes and for the wrong client', async () => {
  const env = await manualServer();
  try {
    const { post } = await client(env.server);
    await verified(post);
    const alreadyVerified = await post('save-manual-identity', manual({ pane_id: 'w1:p1', client: 'claude', confirm: 'save:w1:p1' }));
    assert.equal(alreadyVerified.status, 409);
    assert.equal(alreadyVerified.json.code, 'already_verified');
    const wrongClient = await post('save-manual-identity', manual({ client: 'claude' }));
    assert.equal(wrongClient.status, 409);
    assert.equal(wrongClient.json.code, 'client_mismatch');
    const notInCheck = await post('save-manual-identity', manual({ pane_id: 'w2:p2', client: 'claude', confirm: 'save:w2:p2' }));
    assert.equal(notInCheck.status, 409, 'a pane without an agent is refused');
    assert.equal(registerCalls(env.calls).length, 0);
  } finally { await env.done(); }
});

test('save-manual-identity: input validation, confirmation and pane checks happen before anything is written', async () => {
  const env = await manualServer();
  const server = env.server;
  try {
    const { post } = await client(server);
    await verified(post);
    const attempts = [
      ['bad confirm', manual({ confirm: 'save:w1:p1' }), 400],
      ['no confirm', manual({ confirm: '' }), 400],
      ['bad pane pattern', manual({ pane_id: 'w1:p2; touch /tmp/pwned', confirm: 'save:w1:p2; touch /tmp/pwned' }), 400],
      ['option-like pane', manual({ pane_id: '--help', confirm: 'save:--help' }), 400],
      ['unknown pane', manual({ pane_id: 'w9:p9', confirm: 'save:w9:p9' }), 404],
      ['bad client', manual({ client: 'gemini' }), 400],
      ['not a uuid', manual({ session_id: 'not-a-session-id' }), 400],
      ['uuid plus junk', manual({ session_id: ID + ' --execute' }), 400],
      ['empty id', manual({ session_id: '' }), 400],
      ['default session', manual({ session: 'default' }), 400],
      ['stopped session', manual({ session: 'stopped-one' }), 400],
    ];
    for (const [name, params, status] of attempts) {
      const response = await post('save-manual-identity', params);
      assert.equal(response.status, status, name);
      assert.equal(response.raw.includes('pwned'), false, name);
      assert.equal(response.raw.includes('not-a-session-id'), false, 'a bad id is not echoed: ' + name);
    }
    assert.equal(registerCalls(env.calls).length, 0);
    assert.equal(env.calls.some((call) => JSON.stringify(call.args).includes('pwned')), false);
  } finally { await env.done(); }
});

test('save-manual-identity: each store check outcome is enforced and nothing leaks the id', async () => {
  const outcomes = [
    ['not in store', { valid_format: true, exists: false, store_folder: 'unknown', registered_elsewhere: false, already_registered_here: false }, 404, 'not_in_store'],
    ['registered elsewhere', { valid_format: true, exists: true, store_folder: 'match', registered_elsewhere: true, already_registered_here: false }, 409, 'already_registered'],
    ['folder differs', { valid_format: true, exists: true, store_folder: 'differs', registered_elsewhere: false, already_registered_here: false }, 409, 'folder_differs'],
    ['folder unknown', { valid_format: true, exists: true, store_folder: 'unknown', registered_elsewhere: false, already_registered_here: false }, 409, 'folder_unknown'],
  ];
  for (const [name, storeCheck, status, code] of outcomes) {
    const env = await manualServer({ storeCheck });
    try {
      const { post } = await client(env.server);
      await verified(post);
      const response = await post('save-manual-identity', manual());
      assert.equal(response.status, status, name);
      assert.equal(response.json.code, code, name);
      assert.equal(response.raw.includes(ID), false, name);
      assert.equal(registerCalls(env.calls).length, 0, name + ': nothing was written');
    } finally { await env.done(); }
  }
});

test('save-manual-identity: the folder override is honoured only when sent, and only for folder problems', async () => {
  const differs = await manualServer({ storeCheck: { valid_format: true, exists: true, store_folder: 'differs', registered_elsewhere: false, already_registered_here: false } });
  try {
    const { post } = await client(differs.server);
    await verified(post);
    assert.equal((await post('save-manual-identity', manual({ folder_override: false }))).status, 409);
    const ok = await post('save-manual-identity', manual({ folder_override: true }));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.folder_confirmed, 'override');
    assert.equal(registerCalls(differs.calls).length, 1);
  } finally { await differs.done(); }
  const claimed = await manualServer({ storeCheck: { valid_format: true, exists: true, store_folder: 'match', registered_elsewhere: true, already_registered_here: false } });
  try {
    const { post } = await client(claimed.server);
    await verified(post);
    const refused = await post('save-manual-identity', manual({ folder_override: true }));
    assert.equal(refused.status, 409, 'the override cannot bypass the already-registered check');
    assert.equal(registerCalls(claimed.calls).length, 0);
  } finally { await claimed.done(); }
});

test('save-manual-identity: a failing registry and a failing store check report without leaking', async () => {
  const first = await manualServer({ handle: (file, args) => (args.includes('register') ? { code: 2, stdout: '', stderr: 'boom ' + ID + ' at /Users/someone/state/x.json', timedOut: false, truncated: false } : undefined) });
  try {
    const { post } = await client(first.server);
    await verified(post);
    const response = await post('save-manual-identity', manual());
    assert.equal(response.status, 502);
    assert.equal(response.raw.includes(ID), false);
    assert.deepEqual(findLeaks(response.raw), []);
  } finally { await first.done(); }
  const second = await manualServer({ handle: (file, args) => (typeof args[0] === 'string' && args[0].endsWith('store_check.py') ? { code: 1, stdout: '{"error":"check_failed"}', stderr: ID, timedOut: false, truncated: false } : undefined) });
  try {
    const { post } = await client(second.server);
    await verified(post);
    const response = await post('save-manual-identity', manual());
    assert.equal(response.status, 502);
    assert.equal(response.raw.includes(ID), false);
    assert.equal(registerCalls(second.calls).length, 0);
  } finally { await second.done(); }
});

// The write path trusts nothing from Herdr's pane list. Each case below is a pane list that
// is malformed or inconsistent in one way; neither the store check nor register may start.
const pane = (overrides, cwd) => ({ pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2', agent: 'codex', agent_status: 'idle', cwd, foreground_cwd: cwd, ...overrides });
const PANE_CASES = [
  ['workspace id with shell metacharacters', (cwd) => [pane({ workspace_id: 'w1; touch /tmp/pwned' }, cwd)]],
  ['workspace id that is not a workspace id', (cwd) => [pane({ workspace_id: 'x1' }, cwd)]],
  ['empty workspace id', (cwd) => [pane({ workspace_id: '' }, cwd)]],
  ['tab id that is not a tab id', (cwd) => [pane({ tab_id: 'tab-2' }, cwd)]],
  ['tab id with an option-like value', (cwd) => [pane({ tab_id: '--help' }, cwd)]],
  ['tab id from another workspace', (cwd) => [pane({ tab_id: 'w2:t2' }, cwd)]],
  ['pane id from another workspace', (cwd) => [pane({ workspace_id: 'w2', tab_id: 'w2:t2' }, cwd)]],
  ['pane listed twice', (cwd) => [pane({}, cwd), pane({}, cwd)]],
  ['missing folder', () => [pane({ cwd: undefined, foreground_cwd: undefined }, undefined)]],
  ['empty folder', () => [pane({}, '')]],
  ['relative folder', () => [pane({}, 'work/alpha')]],
  ['folder with a parent segment', (cwd) => [pane({}, cwd + '/../sub')]],
  ['folder with a trailing slash', (cwd) => [pane({}, cwd + '/')]],
  ['folder with a double slash', (cwd) => [pane({}, cwd.replace(/\/([^/]+)$/, '//$1'))]],
  ['folder with a newline', (cwd) => [pane({}, cwd + '\n')]],
  ['folder with a control character', (cwd) => [pane({}, cwd + '\u0001')]],
  ['folder that does not exist', (cwd) => [pane({}, cwd + '/missing-child')]],
  ['folder that is a file', (cwd, tree) => { tree.write('work/not-a-folder.txt', 'x'); return [pane({}, tree.abs('work/not-a-folder.txt'))]; }],
  ['folder that is absurdly long', (cwd) => [pane({}, '/' + 'a'.repeat(5000))]],
];

test('save-manual-identity: a malformed or inconsistent live pane stops the write before the store check and register', async () => {
  for (const [name, build] of PANE_CASES) {
    const env = await manualServer({ panes: (real, tree) => build(real, tree) });
    try {
      const { post } = await client(env.server);
      await verified(post);
      const response = await post('save-manual-identity', manual());
      assert.ok([404, 409].includes(response.status), name + ' (' + response.status + ')');
      assert.equal(response.json.code, 'pane_invalid', name);
      assert.equal(env.calls.some((call) => typeof call.args[0] === 'string' && call.args[0].endsWith('store_check.py')), false, name + ': the store check did not start');
      assert.equal(registerCalls(env.calls).length, 0, name + ': register did not start');
      assert.equal(response.raw.includes(ID), false, name);
      assert.equal(response.raw.includes(env.real), false, name + ': the folder is not echoed');
      assert.equal(JSON.stringify(env.calls).includes('pwned'), false, name);
    } finally { await env.done(); }
  }
});

test('save-manual-identity: the store check and register receive the normalized folder, not the raw one', async () => {
  // A pane reported through a symlink: the normalized (real) folder is what is checked and written.
  const env = await manualServer({ panes: (real, tree) => {
    const linked = tree.link('work/linked-alpha', real);
    return [pane({}, linked)];
  } });
  try {
    const { post } = await client(env.server);
    await verified(post);
    const response = await post('save-manual-identity', manual());
    assert.equal(response.status, 200, response.raw);
    const check = env.calls.find((call) => typeof call.args[0] === 'string' && call.args[0].endsWith('store_check.py'));
    assert.equal(JSON.parse(check.input).pane_cwd, env.real);
    const [register] = registerCalls(env.calls);
    assert.equal(register.args[register.args.indexOf('--cwd') + 1], env.real);
  } finally { await env.done(); }
});

test('save-manual-identity: a missing pane is reported as missing and nothing starts', async () => {
  const env = await manualServer({ panes: (real) => [pane({ pane_id: 'w1:p9' }, real)] });
  try {
    const { post } = await client(env.server);
    await verified(post);
    const response = await post('save-manual-identity', manual());
    assert.equal(response.status, 404);
    assert.equal(response.json.code, 'pane_missing');
    assert.equal(registerCalls(env.calls).length, 0);
  } finally { await env.done(); }
});

test('seal-bundle: needs the confirm token and validated acknowledgements, and runs the tool\'s sealing command', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    const acks = { volatile: ['project-a|w3|w3:t2|w3:p2'], mixed: ['project-a|w1'] };
    const sealCalls = () => server.calls.filter((call) => call.args.includes('prepare-restart-recovery') && !call.args.includes('--preflight-only'));
    assert.equal((await post('seal-bundle', { sessions: ['project-a'], acknowledgements: acks, confirm: '' })).status, 400);
    assert.equal((await post('seal-bundle', { sessions: ['project-a'], acknowledgements: acks, confirm: 'seal:project-b' })).status, 400);
    assert.equal((await post('seal-bundle', { sessions: ['project-a'], acknowledgements: { volatile: ['project-a|w9|w9:t1|w9:p1'] }, confirm: 'seal:project-a' })).status, 400, 'a made-up acknowledgement');
    assert.equal(sealCalls().length, 0, 'nothing sealed so far');

    const ok = await post('seal-bundle', { sessions: ['project-a'], acknowledgements: acks, confirm: 'seal:project-a' });
    assert.equal(ok.status, 200);
    assert.deepEqual({ sealed: ok.json.data.sealed, id: ok.json.data.bundle_id, n: ok.json.data.session_count }, { sealed: true, id: 'recovery-20261004T120000Z-0123456789', n: 1 });
    assert.equal(sealCalls().length, 1);
    assert.deepEqual(sealCalls()[0].args.slice(1), ['prepare-restart-recovery', '--session', 'project-a', '--allow-volatile-pane', 'project-a|w3|w3:t2|w3:p2', '--allow-mixed-cwd-workspace', 'project-a|w1']);
  } finally { await server.close(); }
});

test('seal-bundle: a failing preflight seals nothing and says so; default and stopped sessions are refused', async () => {
  const server = await startServer();
  try {
    const { post } = await client(server);
    const failed = await post('seal-bundle', { sessions: ['project-a'], confirm: 'seal:project-a' });
    assert.equal(failed.status, 409);
    assert.equal(failed.json.code, 'preflight_failed');
    for (const name of ['default', 'stopped-one']) assert.equal((await post('seal-bundle', { sessions: [name], confirm: 'seal:' + name })).status, 400, name);
    assert.equal(server.calls.some((call) => JSON.stringify(call.args).includes('stopped-one') || JSON.stringify(call.args).includes('"default"')), false);
  } finally { await server.close(); }
});

test('only one tier 1 change runs at a time', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = fakeRunner({ handle: async (file, args) => {
    if (args.includes('--apply')) { await gate; return { code: 0, stdout: fixture('verify-apply.txt'), stderr: '', timedOut: false, truncated: false }; }
    return undefined;
  } });
  const server = await startServer({ runner: runner.runner });
  try {
    const { post } = await client(server);
    const first = post('verify-apply', { session: 'project-a', confirm: 'apply:project-a' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await post('seal-bundle', { sessions: ['project-a'], confirm: 'seal:project-a' });
    assert.equal(second.status, 409);
    assert.equal(second.json.code, 'busy');
    const read = await post('sessions');
    assert.equal(read.status, 200, 'read-only actions are not blocked');
    release();
    assert.equal((await first).status, 200);
    const after = await post('seal-bundle', { sessions: ['project-a'], confirm: 'seal:project-a' });
    assert.notEqual(after.json.code, 'busy', 'the lock is released once the first change finished');
  } finally { await server.close(); }
});

test('tier 1 actions still need every cross-site protection', async () => {
  const server = await startServer();
  try {
    const { token } = await client(server);
    const { request } = require('./helpers');
    const bodies = [
      { action: 'verify-apply', params: { session: 'project-a', confirm: 'apply:project-a' } },
      { action: 'save-manual-identity', params: manual() },
      { action: 'seal-bundle', params: { sessions: ['project-a'], confirm: 'seal:project-a' } },
      { action: 'focus-tab', params: { session: 'project-a', pane_id: 'w1:p1', id: '11111111' } },
      { action: 'rollover-arm', params: { home: 'h00000000', kind: 'crew', ids: ['x'], confirm: 'rollover-arm:h00000000:crew:x' } },
      { action: 'rollover-stop', params: {} },
      { action: 'rollover-undo', params: { home: 'h00000000', file: 'rollover-live' } },
    ];
    // Every action the server runs at tier 1 or above is covered, so a new one cannot be added without a body here.
    const covered = bodies.map((body) => body.action);
    for (const [name, action] of Object.entries(server.api.ACTIONS)) if (action.tier >= 1) assert.ok(covered.includes(name), name + ' needs a cross-site case');
    for (const body of bodies) {
      for (const headers of [
        { Host: 'localhost:' + server.port, Origin: 'https://evil.example', 'Content-Type': 'application/json', 'X-Herdr-Organizer-Token': token },
        { Host: 'localhost:' + server.port, Origin: server.origin, 'Content-Type': 'application/json' },
        { Host: 'evil.example:' + server.port, Origin: server.origin, 'Content-Type': 'application/json', 'X-Herdr-Organizer-Token': token },
        { Host: 'localhost:' + server.port, Origin: server.origin, 'Content-Type': 'text/plain', 'X-Herdr-Organizer-Token': token },
      ]) {
        const response = await request({ port: server.port, method: 'POST', path: '/api/herdr-organizer/run', headers, body });
        assert.ok([403, 415].includes(response.status), body.action + ' ' + response.status);
      }
    }
    assert.equal(server.calls.filter((call) => call.args.includes('prepare-restart-recovery')).length, 0, 'nothing was sealed');
    assert.equal(server.calls.filter((call) => call.args.includes('focus')).length, 0, 'nothing was focused');
    assert.equal(server.calls.filter((call) => call.args.includes('--apply')).length, 0, 'no identity was applied');
    assert.equal(registerCalls(server.calls).length, 0, 'no manual identity was registered');
    assert.equal(fs.existsSync('/fixture/tools/state'), false, 'no rollover record or audit line was started for a refused request');
    assert.equal(server.calls.some((call) => typeof call.args[0] === 'string' && call.args[0].endsWith('store_check.py')), false, 'the manual identity check did not start');
  } finally { await server.close(); }
});
