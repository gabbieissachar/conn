'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, client, fakeRunner } = require('./helpers');
const { findLeaks } = require('../text');

const ID_A = 'recovery-20201004T120000Z-0123456789';
const ID_B = 'recovery-20990101T000000Z-abcdef0123';
const ID_STOPPED = 'recovery-20990102T000000Z-0000000001';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-organizer-bundles-'));
  const bundles = path.join(root, 'state', 'workspace-organizer', 'restart-recovery', 'bundles');
  const journals = path.join(root, 'state', 'workspace-organizer', 'restart-recovery', 'journals');
  fs.mkdirSync(bundles, { recursive: true });
  fs.mkdirSync(journals, { recursive: true });
  const bundle = (id, { sessions, createdAt, ready = true, state = 'sealed' }) => {
    fs.mkdirSync(path.join(bundles, id));
    fs.writeFileSync(path.join(bundles, id, 'manifest.json'), JSON.stringify({
      schema_version: 2, bundle_id: id, created_at: createdAt, state,
      sessions: sessions.map((name) => ({ identity: { herdr_session: name, workspace_id: null, tab_id: null, pane_id: null }, file: 'sessions/x.json' })),
      mixed_cwd_acknowledgements: [{ identity: { herdr_session: sessions[0], workspace_id: 'w1' }, rebuild_cwd: '/fixture/work/alpha' }],
    }));
    if (ready) fs.writeFileSync(path.join(bundles, id, 'ready'), '{}');
  };
  return { root, bundles, journals, bundle, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('bundles: lists sealed bundles newest first with only safe fields', async () => {
  const fixtureRoot = makeRoot();
  fixtureRoot.bundle(ID_A, { sessions: ['project-a'], createdAt: '2020-10-04T12:00:00+00:00' });
  fixtureRoot.bundle(ID_B, { sessions: ['project-a', 'project-b'], createdAt: '2099-01-01T00:00:00+00:00' });
  fixtureRoot.bundle(ID_STOPPED, { sessions: ['project-a', 'stopped-one'], createdAt: '2099-01-02T00:00:00+00:00' });
  fixtureRoot.bundle('recovery-20990103T000000Z-0000000002', { sessions: ['project-a'], createdAt: '2099-01-03T00:00:00+00:00', ready: false });
  fs.mkdirSync(path.join(fixtureRoot.bundles, 'not-a-bundle'));
  fs.mkdirSync(path.join(fixtureRoot.bundles, '..evil'));
  fs.writeFileSync(path.join(fixtureRoot.journals, ID_B + '.json'), JSON.stringify({ status: 'complete', sessions: { 'project-a': { secret: '/Users/someone/x' } } }));
  const server = await startServer({ toolRoot: fixtureRoot.root });
  try {
    const { post } = await client(server);
    const response = await post('bundles');
    assert.equal(response.status, 200);
    const list = response.json.data.bundles;
    assert.deepEqual(list.map((item) => item.bundle_id), ['recovery-20990103T000000Z-0000000002', ID_STOPPED, ID_B, ID_A]);
    const byId = Object.fromEntries(list.map((item) => [item.bundle_id, item]));
    assert.equal(byId[ID_A].ready, true);
    assert.equal(byId[ID_A].before_boot, true, 'sealed before the current boot');
    assert.equal(byId[ID_B].before_boot, false);
    assert.equal(byId['recovery-20990103T000000Z-0000000002'].ready, false, 'no ready marker means not sealed');
    assert.deepEqual(byId[ID_B].sessions, [{ name: 'project-a', running: true }, { name: 'project-b', running: true }]);
    assert.deepEqual(byId[ID_STOPPED].sessions, [{ name: 'project-a', running: true }, { name: 'stopped-one', running: false }]);
    assert.equal(byId[ID_B].journal_status, 'complete');
    assert.equal(byId[ID_A].journal_status, '');
    assert.match(response.json.data.boot_time, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(response.raw.includes('/fixture'), false, 'manifest folders are never returned');
    assert.equal(response.raw.includes('/Users/'), false, 'journal contents are never returned');
    assert.equal(response.raw.includes('not-a-bundle'), false);
  } finally { await server.close(); fixtureRoot.cleanup(); }
});

test('bundles: an empty or missing bundle folder is an empty list', async () => {
  const server = await startServer({ toolRoot: '/definitely/not/here' });
  try {
    const { post } = await client(server);
    const response = await post('bundles');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.data.bundles, []);
  } finally { await server.close(); }
});

test('reconcile-preview: validates the bundle id and runs the read-only preview only', async () => {
  const fixtureRoot = makeRoot();
  fixtureRoot.bundle(ID_B, { sessions: ['project-a'], createdAt: '2099-01-01T00:00:00+00:00' });
  const runner = fakeRunner();
  const server = await startServer({ toolRoot: fixtureRoot.root, runner: runner.runner });
  try {
    const { post } = await client(server);
    for (const bad of ['../../etc/passwd', 'recovery-x', ID_B + ' --confirm ' + ID_B, ID_B + '; touch /tmp/pwned', '', '--help', ID_B.toUpperCase()]) {
      const response = await post('reconcile-preview', { bundle: bad });
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
    assert.equal((await post('reconcile-preview', { bundle: ID_A })).status, 404, 'a well-formed id that is not on disk');
    assert.equal(runner.calls.filter((call) => call.args.includes('reconcile-all')).length, 0, 'the tool never ran for a refused bundle');

    const ok = await post('reconcile-preview', { bundle: ID_B });
    assert.equal(ok.status, 200);
    const call = runner.calls.find((entry) => entry.args.includes('reconcile-all'));
    assert.deepEqual(call.args.slice(1), ['reconcile-all', '--bundle', ID_B]);
    assert.equal(call.args.includes('--confirm'), false, 'the page never confirms a reconcile');
    assert.deepEqual(ok.json.data.sessions, [{ session: 'project-a', adopt: 3, rebuild: 1, ambiguous: 1, other: 0 }]);
    assert.deepEqual(ok.json.data.totals, { adopt: 3, rebuild: 1, ambiguous: 1, other: 0 });
    const commands = ok.json.data.commands;
    assert.equal(commands.confirm, `herdr-organizer reconcile-all --bundle ${ID_B} --confirm ${ID_B}`);
    assert.equal(commands.confirm_resume, `herdr-organizer reconcile-all --bundle ${ID_B} --confirm ${ID_B} --resume-agents`);
    assert.equal(commands.confirm_extra_copy, `herdr-organizer reconcile-all --bundle ${ID_B} --confirm ${ID_B} --copy-ambiguous --confirm-extra copy:${ID_B}`);
    assert.equal(commands.rollback_preview, `herdr-organizer rollback-reconcile --bundle ${ID_B}`);
    assert.equal(commands.rollback, `herdr-organizer rollback-reconcile --bundle ${ID_B} --confirm ${ID_B}`);
    assert.equal(runner.calls.some((entry) => JSON.stringify(entry.args).includes('pwned')), false);
  } finally { await server.close(); fixtureRoot.cleanup(); }
});

test('reconcile-preview: a bundled session that is not running is reported before the tool runs', async () => {
  const fixtureRoot = makeRoot();
  fixtureRoot.bundle(ID_STOPPED, { sessions: ['project-a', 'stopped-one'], createdAt: '2099-01-02T00:00:00+00:00' });
  const runner = fakeRunner();
  const server = await startServer({ toolRoot: fixtureRoot.root, runner: runner.runner });
  try {
    const { post } = await client(server);
    const response = await post('reconcile-preview', { bundle: ID_STOPPED });
    assert.equal(response.status, 409);
    assert.equal(response.json.code, 'not_attached');
    assert.match(response.json.message, /stopped-one/);
    assert.equal(runner.calls.filter((call) => call.args.includes('reconcile-all')).length, 0);
  } finally { await server.close(); fixtureRoot.cleanup(); }
});

test('reconcile-preview: the unsealed bundle and tool failures are reported without leaking', async () => {
  const fixtureRoot = makeRoot();
  fixtureRoot.bundle(ID_A, { sessions: ['project-a'], createdAt: '2020-10-04T12:00:00+00:00', ready: false });
  fixtureRoot.bundle(ID_B, { sessions: ['project-a'], createdAt: '2099-01-01T00:00:00+00:00' });
  const runner = fakeRunner({ handle: (file, args) => (args.includes('reconcile-all') ? { code: 1, stdout: '', stderr: 'Error: Recovery session x is not attached /Users/someone/.config/herdr/sessions/x/herdr.sock', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ toolRoot: fixtureRoot.root, runner: runner.runner });
  try {
    const { post } = await client(server);
    assert.equal((await post('reconcile-preview', { bundle: ID_A })).status, 404, 'an unsealed bundle is not previewed');
    const failed = await post('reconcile-preview', { bundle: ID_B });
    assert.equal(failed.status, 409);
    assert.equal(failed.json.code, 'not_attached');
    assert.deepEqual(findLeaks(failed.raw), []);
  } finally { await server.close(); fixtureRoot.cleanup(); }
});
