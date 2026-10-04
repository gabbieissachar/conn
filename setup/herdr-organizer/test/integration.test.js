'use strict';

// Runs the real registry and store check (Python) against a temporary copy of the
// Herdr tool scripts, a synthetic Codex store and a faked `herdr` binary. Nothing
// touches a real Herdr session, the user's registry or the user's client stores.
// Skipped when the Herdr tool scripts are not available.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../api');
const { createAdapter, defaultRunner } = require('../adapter');
const { client } = require('./helpers');
const http = require('http');

const REAL_TOOL_ROOT = process.env.HERDR_ORGANIZER_TOOL_ROOT || path.join(__dirname, '..', '..', '..', 'personal', '01-System', 'setup', 'herdr');
const available = fs.existsSync(path.join(REAL_TOOL_ROOT, 'agent-session-registry.py'));
const ID = '0f1e2d3c-4b5a-4968-8777-665544332211';

async function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-organizer-int-'));
  const realBase = fs.realpathSync(base);
  const toolRoot = path.join(base, 'tools');
  fs.mkdirSync(toolRoot);
  for (const name of fs.readdirSync(REAL_TOOL_ROOT)) if (name.endsWith('.py') && !name.startsWith('test-')) fs.copyFileSync(path.join(REAL_TOOL_ROOT, name), path.join(toolRoot, name));
  fs.mkdirSync(path.join(base, 'work', 'alpha'), { recursive: true });
  const work = fs.realpathSync(path.join(base, 'work', 'alpha'));
  const codexHome = path.join(base, 'codex');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({ id: ID, cwd: work }) + '\n');
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
  const env = { PATH: process.env.PATH, CODEX_HOME: codexHome, HOME: base };
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
  api = create({ root: base, port, adapter: createAdapter({ toolRoot, runner, env }), env });
  return { base, toolRoot, port, origin: 'http://localhost:' + port, work, close: async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); } };
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
