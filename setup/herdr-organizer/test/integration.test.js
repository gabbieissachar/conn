'use strict';

// Runs the real registry and store check (Python) against a temporary copy of the
// Herdr tool scripts, a synthetic Codex store and a faked `herdr` binary. Nothing
// touches a real Herdr session, the user's registry or the user's client stores.
// Skipped when the Herdr tool scripts are not available.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { create } = require('../api');
const { createRollover } = require('../rollover');
const { createSwitches } = require('../rollover-switches');
const { createAdapter, defaultRunner } = require('../adapter');
const { client, tempTree } = require('./helpers');
const http = require('http');

const REAL_TOOL_ROOT = process.env.HERDR_ORGANIZER_TOOL_ROOT || path.join(__dirname, '..', '..', '..', 'personal', '01-System', 'setup', 'herdr');
const available = fs.existsSync(path.join(REAL_TOOL_ROOT, 'agent-session-registry.py'));
const ID = '0f1e2d3c-4b5a-4968-8777-665544332211';

// A stand-in for the `herdr` binary that the real registry tool runs by name. It answers `pane current --current` the
// way Herdr 0.7.3 does with no HERDR_PANE_ID set: with the focused pane of the default session, unless the API socket
// it is pointed at does not exist. The real tool then prefers that pane to the ids it was given, so the stand-in is
// what lets a test see where the registry really wrote.
const FAKE_HERDR = `#!/bin/sh
if [ "$1 $2 $3" = "pane current --current" ]; then
  if [ -n "$HERDR_SOCKET_PATH" ] && [ ! -S "$HERDR_SOCKET_PATH" ]; then
    echo '{"id":"cli:pane:current","error":{"code":"server_not_running","message":"no herdr server is running"}}'
    exit 1
  fi
  printf '{"id":"cli:pane:current","result":{"pane":{"pane_id":"w9:p9","workspace_id":"w9","tab_id":"w9:t9","cwd":"%s","focused":true}}}\\n' "$PWD"
  exit 0
fi
exit 1
`;

async function setup({ currentPaneFallback = false } = {}) {
  const tree = tempTree('herdr-organizer-int-');
  const realBase = tree.real;
  const toolRoot = tree.mkdir('tools');
  for (const name of fs.readdirSync(REAL_TOOL_ROOT)) {
    if (name.endsWith('.py') && !name.startsWith('test-')) tree.write('tools/' + name, fs.readFileSync(path.join(REAL_TOOL_ROOT, name)));
  }
  tree.trackDir('tools/state');
  tree.mkdir('work/alpha');
  const work = fs.realpathSync(tree.abs('work/alpha'));
  tree.write('codex/session_index.jsonl', JSON.stringify({ id: ID, cwd: work }) + '\n');
  const codexHome = tree.abs('codex');
  const panes = { result: { panes: [
    { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2', agent: 'codex', agent_status: 'idle', cwd: work, foreground_cwd: work },
    { pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t3', agent: 'codex', agent_status: 'idle', cwd: work, foreground_cwd: work },
    { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', agent: 'codex', agent_status: 'idle', cwd: realBase, foreground_cwd: realBase },
  ] } };
  const sessions = { sessions: [{ default: true, name: 'default', running: false }, { default: false, name: 'project-a', running: true }] };
  const verifyText = [
    "candidate_ambiguous workspace='A' tab='t2' pane='[pane]' pane_id=w1:p2 candidates=1 exact=0 evidence=cwd_candidate",
    "candidate_ambiguous workspace='A' tab='t3' pane='[pane]' pane_id=w1:p3 candidates=1 exact=0 evidence=cwd_candidate",
    "candidate_ambiguous workspace='B' tab='t1' pane='[pane]' pane_id=w2:p1 candidates=1 exact=0 evidence=cwd_candidate",
    'Summary:', 'total panes: 3', 'verified: native 0; argv 0; handle 0; pid record 0', 'ambiguous: 3; unresolved: 0', 'safe to apply with --apply: 0; manual: 3',
  ].join('\n');
  // No bytecode: the tests import the real verifier and must not write next to it.
  let binPath = process.env.PATH;
  if (currentPaneFallback) {
    const bin = tree.write('bin/herdr', FAKE_HERDR);
    fs.chmodSync(bin, 0o755);
    binPath = path.dirname(bin) + path.delimiter + process.env.PATH;
  }
  const env = { PATH: binPath, CODEX_HOME: codexHome, HOME: realBase, PYTHONDONTWRITEBYTECODE: '1' };
  const runner = async (file, args, options = {}) => {
    const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });
    if (file === 'herdr') {
      if (args[0] === 'session') return ok(JSON.stringify(sessions));
      if (args[2] === 'pane') return ok(JSON.stringify(panes));
    }
    if (args.includes('verify-identity')) return ok(verifyText);
    return defaultRunner(file, args, options);
  };
  let api;
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // The rollover side gets a fixture home inside this temporary tree: no server in these tests may register or write the real home.
  tree.mkdir('rollover-home/state');
  tree.mkdir('rollover-home/data');
  tree.mkdir('rollover-home/config');
  tree.write('rollover-home/state/.lock-session', 'fixture\n');
  const rollover = createRollover({ env: { HERDR_ORGANIZER_ROLLOVER_HOMES: `fixture=${path.join(realBase, 'rollover-home')}` }, homedir: tree.abs('nohome') });
  api = create({ root: tree.root, port, adapter: createAdapter({ toolRoot, runner, env }), env, toolRoot, rollover, switches: createSwitches({ rollover, toolRoot }) });
  return {
    base: tree.root, toolRoot, port, origin: 'http://localhost:' + port, work,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      // Files the registry created inside the temporary tool copy.
      tree.sweep('tools/state');
      tree.sweep('tools');
      tree.cleanup();
    },
  };
}

test('manual identity: real store check and real registry write, private files, duplicate and folder guards', { skip: !available }, async () => {
  const env = await setup();
  try {
    const { post } = await client(env);
    assert.equal((await post('verify', { session: 'project-a' })).status, 200);
    const params = (overrides = {}) => ({ session: 'project-a', pane_id: 'w1:p2', client: 'codex', session_id: ID, confirm: 'save:w1:p2', ...overrides });

    const unknown = await post('save-manual-identity', params({ session_id: 'ffffffff-1111-4222-8333-444444444444' }));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.code, 'not_in_store');

    const saved = await post('save-manual-identity', params());
    assert.equal(saved.status, 200, saved.raw);
    assert.equal(saved.json.data.masked_id, '0f1e...2211');
    assert.equal(saved.raw.includes(ID), false);

    const manifest = path.join(env.toolRoot, 'state', 'herdr-agent-sessions.json');
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.equal(data.panes.length, 1);
    assert.deepEqual({ client: data.panes[0].client, pane: data.panes[0].pane_id, workspace: data.panes[0].workspace_id, tab: data.panes[0].tab_id, session: data.panes[0].herdr_session, id: data.panes[0].session_id },
      { client: 'codex', pane: 'w1:p2', workspace: 'w1', tab: 'w1:t2', session: 'project-a', id: ID });
    assert.equal(fs.statSync(manifest).mode & 0o777, 0o600, 'the registry keeps its private-file policy');
    assert.equal(fs.statSync(path.dirname(manifest)).mode & 0o777, 0o700);

    const claimed = await post('save-manual-identity', params({ pane_id: 'w1:p3', confirm: 'save:w1:p3' }));
    assert.equal(claimed.status, 409);
    assert.equal(claimed.json.code, 'already_registered', 'the same conversation cannot be bound to a second pane');

    const elsewhere = await post('save-manual-identity', params({ pane_id: 'w2:p1', confirm: 'save:w2:p1' }));
    assert.equal(elsewhere.status, 409, 'already registered check runs before the folder check');
  } finally { await env.close(); }
});

test('manual identity: the registry records the pane that was asked for, not the current pane Herdr would name', { skip: !available }, async () => {
  // Regression: with no HERDR_PANE_ID, Herdr answers `pane current --current` with the focused pane of the default
  // session. `register` preferred that pane, so the page said "Saved" while the identity landed on another pane, and
  // saving the same id again was refused as already registered to another pane.
  const env = await setup({ currentPaneFallback: true });
  try {
    const { post } = await client(env);
    assert.equal((await post('verify', { session: 'project-a' })).status, 200);
    const saved = await post('save-manual-identity', { session: 'project-a', pane_id: 'w1:p2', client: 'codex', session_id: ID, confirm: 'save:w1:p2' });
    assert.equal(saved.status, 200, saved.raw);
    const manifest = path.join(env.toolRoot, 'state', 'herdr-agent-sessions.json');
    const panes = JSON.parse(fs.readFileSync(manifest, 'utf8')).panes;
    assert.deepEqual(panes.map((item) => [item.herdr_session, item.pane_id, item.workspace_id, item.tab_id]), [['project-a', 'w1:p2', 'w1', 'w1:t2']],
      'one record, for the pane that was asked for and in its own Herdr session');
    // The same id on the same pane is not "registered to another pane".
    const again = await post('save-manual-identity', { session: 'project-a', pane_id: 'w1:p2', client: 'codex', session_id: ID, confirm: 'save:w1:p2' });
    assert.equal(again.status, 200, again.raw);
  } finally { await env.close(); }
});

test('manual identity: a folder mismatch is refused without the override and saved with it', { skip: !available }, async () => {
  const env = await setup();
  try {
    const { post } = await client(env);
    assert.equal((await post('verify', { session: 'project-a' })).status, 200);
    const params = (overrides = {}) => ({ session: 'project-a', pane_id: 'w2:p1', client: 'codex', session_id: ID, confirm: 'save:w2:p1', ...overrides });
    const refused = await post('save-manual-identity', params());
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'folder_differs');
    assert.equal(fs.existsSync(path.join(env.toolRoot, 'state', 'herdr-agent-sessions.json')), false, 'nothing was written');
    const saved = await post('save-manual-identity', params({ folder_override: true }));
    assert.equal(saved.status, 200, saved.raw);
    assert.equal(saved.json.data.folder_confirmed, 'override');
  } finally { await env.close(); }
});

test('the real store check never exposes the id, even through an error', { skip: !available }, async () => {
  const env = await setup();
  try {
    const { post } = await client(env);
    await post('verify', { session: 'project-a' });
    const responses = [];
    for (const id of ['not-valid', ID.replace(/0/g, '1')]) responses.push(await post('save-manual-identity', { session: 'project-a', pane_id: 'w1:p2', client: 'codex', session_id: id, confirm: 'save:w1:p2' }));
    for (const response of responses) {
      assert.ok(response.status >= 400);
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(response.raw), false);
    }
  } finally { await env.close(); }
});
