'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, client, fakeRunner, tempTree } = require('./helpers');
const { findLeaks } = require('../text');

const ID_A = 'recovery-20201004T120000Z-0123456789';
const ID_B = 'recovery-20990101T000000Z-abcdef0123';
const ID_STOPPED = 'recovery-20990102T000000Z-0000000001';
const BUNDLES = 'state/workspace-organizer/restart-recovery/bundles';
const JOURNALS = 'state/workspace-organizer/restart-recovery/journals';

// A bundle on disk the way the tool writes it: <id>/manifest.json plus a ready marker.
function makeRoot() {
  const tree = tempTree('herdr-organizer-bundles-');
  tree.mkdir(BUNDLES);
  tree.mkdir(JOURNALS);
  const member = (name) => ({ identity: { herdr_session: name, workspace_id: null, tab_id: null, pane_id: null }, file: 'sessions/x.json' });
  const bundle = (id, { sessions, members, createdAt = '2099-01-01T00:00:00+00:00', ready = true, state = 'sealed' }) => {
    const list = members || sessions.map(member);
    tree.write(`${BUNDLES}/${id}/manifest.json`, JSON.stringify({
      schema_version: 2, bundle_id: id, created_at: createdAt, state, sessions: list,
      mixed_cwd_acknowledgements: [{ identity: { herdr_session: 'project-a', workspace_id: 'w1' }, rebuild_cwd: '/fixture/work/alpha' }],
    }));
    if (ready) tree.write(`${BUNDLES}/${id}/ready`, '{}');
  };
  return { tree, bundle, member, root: tree.root, journals: tree.abs(JOURNALS), bundles: tree.abs(BUNDLES), cleanup: () => tree.cleanup() };
}

const reconcileCalls = (runner) => runner.calls.filter((call) => call.args.includes('reconcile-all'));

test('bundles: lists sealed bundles newest first with only safe fields', async () => {
  const fixtureRoot = makeRoot();
  fixtureRoot.bundle(ID_A, { sessions: ['project-a'], createdAt: '2020-10-04T12:00:00+00:00' });
  fixtureRoot.bundle(ID_B, { sessions: ['project-a', 'project-b'] });
  fixtureRoot.bundle(ID_STOPPED, { sessions: ['project-a', 'stopped-one'], createdAt: '2099-01-02T00:00:00+00:00' });
  fixtureRoot.bundle('recovery-20990103T000000Z-0000000002', { sessions: ['project-a'], createdAt: '2099-01-03T00:00:00+00:00', ready: false });
  fixtureRoot.tree.mkdir(`${BUNDLES}/not-a-bundle`);
  fixtureRoot.tree.write(`${JOURNALS}/${ID_B}.json`, JSON.stringify({ status: 'completed', sessions: { 'project-a': { secret: '/Users/someone/x' } } }));
  const server = await startServer({ toolRoot: fixtureRoot.root });
  try {
    const { post } = await client(server);
    const response = await post('bundles');
    assert.equal(response.status, 200);
    const list = response.json.data.bundles;
    assert.deepEqual(list.map((item) => item.bundle_id), ['recovery-20990103T000000Z-0000000002', ID_STOPPED, ID_B, ID_A]);
    const byId = Object.fromEntries(list.map((item) => [item.bundle_id, item]));
    assert.equal(byId[ID_A].ready, true);
    assert.equal(byId[ID_A].compatible, true);
    assert.equal(byId[ID_A].before_boot, true, 'sealed before the current boot');
    assert.equal(byId[ID_B].before_boot, false);
    assert.equal(byId['recovery-20990103T000000Z-0000000002'].ready, false, 'no ready marker means not sealed');
    assert.deepEqual(byId[ID_B].sessions, [{ name: 'project-a', running: true }, { name: 'project-b', running: true }]);
    assert.deepEqual(byId[ID_STOPPED].sessions, [{ name: 'project-a', running: true }, { name: 'stopped-one', running: false }], 'a stopped member is shown, not hidden');
    assert.equal(byId[ID_STOPPED].compatible, true);
    assert.equal(byId[ID_B].journal_status, 'completed');
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

// Each of these is a valid-looking bundle that the tool did not write for this machine's
// live sessions. It must be marked incompatible, and no preview process may start for it.
const INCOMPATIBLE = [
  ['default session', 'recovery-20990201T000000Z-0000000001', (m) => ({ sessions: ['project-a', 'default'] }), 'default_session', { defaultRunning: true }],
  ['default session even when stopped', 'recovery-20990201T000000Z-0000000002', () => ({ sessions: ['default'] }), 'default_session', {}],
  ['unknown member', 'recovery-20990201T000000Z-0000000003', () => ({ sessions: ['project-a', 'ghost-session'] }), 'unknown_session', {}],
  ['no members', 'recovery-20990201T000000Z-0000000004', () => ({ sessions: [] }), 'no_members', {}],
  ['member without an identity', 'recovery-20990201T000000Z-0000000005', () => ({ members: [{ file: 'sessions/x.json' }] }), 'malformed_member', {}],
  ['member that is not an object', 'recovery-20990201T000000Z-0000000006', () => ({ members: ['project-a', 7, null] }), 'malformed_member', {}],
  ['option-like member name', 'recovery-20990201T000000Z-0000000007', () => ({ sessions: ['--help'] }), 'malformed_member', {}],
  ['member name with metacharacters', 'recovery-20990201T000000Z-0000000008', () => ({ sessions: ['project-a; touch /tmp/pwned'] }), 'malformed_member', {}],
  ['repeated member', 'recovery-20990201T000000Z-0000000009', () => ({ sessions: ['project-a', 'project-a'] }), 'malformed_member', {}],
  ['one good and one malformed member', 'recovery-20990201T000000Z-000000000a', () => ({ members: [{ identity: { herdr_session: 'project-a' } }, { identity: {} }] }), 'malformed_member', {}],
  ['member name that is not a string', 'recovery-20990201T000000Z-000000000b', () => ({ members: [{ identity: { herdr_session: ['project-a'] } }] }), 'malformed_member', {}],
  ['manifest without a session list', 'recovery-20990201T000000Z-000000000c', () => ({ members: 'project-a' }), 'malformed_manifest', {}],
];

test('bundles: default, unknown, missing and malformed members mark a bundle incompatible and no preview process starts', async () => {
  const fixtureRoot = makeRoot();
  for (const [, id, build] of INCOMPATIBLE) {
    const spec = build();
    if (typeof spec.members === 'string') {
      fixtureRoot.tree.write(`${BUNDLES}/${id}/manifest.json`, JSON.stringify({ schema_version: 2, bundle_id: id, created_at: '2099-02-01T00:00:00+00:00', state: 'sealed', sessions: spec.members }));
      fixtureRoot.tree.write(`${BUNDLES}/${id}/ready`, '{}');
    } else fixtureRoot.bundle(id, spec);
  }
  fixtureRoot.bundle(ID_B, { sessions: ['project-a'] });
  // The default session is running in this scenario, as the review describes.
  const sessions = [
    { default: true, name: 'default', running: true },
    { default: false, name: 'project-a', running: true },
    { default: false, name: 'project-b', running: true },
    { default: false, name: 'stopped-one', running: false },
  ];
  const runner = fakeRunner({ sessions });
  const server = await startServer({ toolRoot: fixtureRoot.root, runner: runner.runner });
  try {
    const { post } = await client(server);
    const list = (await post('bundles')).json.data.bundles;
    const byId = Object.fromEntries(list.map((item) => [item.bundle_id, item]));
    for (const [name, id, , problem] of INCOMPATIBLE) {
      assert.equal(byId[id].compatible, false, name);
      assert.equal(byId[id].problem, problem, name);
      assert.deepEqual(byId[id].sessions, [], name + ': members of an unusable bundle are not reported');
    }
    assert.equal(byId[ID_B].compatible, true);
    assert.equal(byId[ID_B].problem, '');

    for (const [name, id] of INCOMPATIBLE) {
      const response = await post('reconcile-preview', { bundle: id });
      assert.equal(response.status, 409, name);
      assert.equal(response.json.code, 'bundle_incompatible', name);
    }
    assert.equal(reconcileCalls(runner).length, 0, 'the tool never started for an incompatible bundle');
    assert.equal(JSON.stringify(runner.calls).includes('pwned'), false);

    const ok = await post('reconcile-preview', { bundle: ID_B });
    assert.equal(ok.status, 200);
    assert.equal(reconcileCalls(runner).length, 1, 'a compatible bundle still previews');
  } finally { await server.close(); fixtureRoot.cleanup(); }
});

test('reconcile-preview: the bundle is validated against the live session list again right before the tool starts', async () => {
  const fixtureRoot = makeRoot();
  fixtureRoot.bundle(ID_B, { sessions: ['project-a'] });
  let listCalls = 0;
  const runner = fakeRunner({ handle: (file, args) => {
    if (file === 'herdr' && args[0] === 'session' && args[1] === 'list') {
      listCalls += 1;
      // The bundles list sees a normal machine; by the time the preview validates, the session is gone.
      const sessions = listCalls <= 1
        ? [{ default: true, name: 'default', running: false }, { default: false, name: 'project-a', running: true }]
        : [{ default: true, name: 'default', running: false }];
      return { code: 0, stdout: JSON.stringify({ sessions }), stderr: '', timedOut: false, truncated: false };
    }
    return undefined;
  } });
  const server = await startServer({ toolRoot: fixtureRoot.root, runner: runner.runner });
  try {
    const { post } = await client(server);
    const listed = (await post('bundles')).json.data.bundles;
    assert.equal(listed[0].compatible, true, 'compatible when it was listed');
    const refused = await post('reconcile-preview', { bundle: ID_B });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'bundle_incompatible', 'the preview did its own fresh validation');
    assert.equal(reconcileCalls(runner).length, 0);
  } finally { await server.close(); fixtureRoot.cleanup(); }
});

test('bundles: a bundle that cannot be validated because Herdr is unreachable is not previewed', async () => {
  const fixtureRoot = makeRoot();
  fixtureRoot.bundle(ID_B, { sessions: ['project-a'] });
  const runner = fakeRunner({ handle: (file, args) => (file === 'herdr' && args[0] === 'session' ? { code: 1, stdout: '', stderr: 'down', timedOut: false, truncated: false } : undefined) });
  const server = await startServer({ toolRoot: fixtureRoot.root, runner: runner.runner });
  try {
    const { post } = await client(server);
    const listed = (await post('bundles')).json.data.bundles;
    assert.equal(listed[0].problem, 'sessions_unavailable');
    assert.equal(listed[0].compatible, false);
    assert.notEqual((await post('reconcile-preview', { bundle: ID_B })).status, 200);
    assert.equal(reconcileCalls(runner).length, 0);
  } finally { await server.close(); fixtureRoot.cleanup(); }
});

test('bundles: symlinked or non-regular components are refused and never read through', async () => {
  const fixtureRoot = makeRoot();
  const outside = tempTreeFor();
  // A real, valid bundle that lives outside the bundle folder, and links that point at it.
  outside.write('real/manifest.json', JSON.stringify({ schema_version: 2, bundle_id: 'x', created_at: '2099-01-01T00:00:00+00:00', state: 'sealed', sessions: [{ identity: { herdr_session: 'project-a' } }] }));
  outside.write('real/ready', '{}');
  outside.write('real/journal.json', JSON.stringify({ status: 'completed' }));
  const idDirLink = 'recovery-20990301T000000Z-0000000001';
  const idManifestLink = 'recovery-20990301T000000Z-0000000002';
  const idReadyLink = 'recovery-20990301T000000Z-0000000003';
  const idJournalLink = 'recovery-20990301T000000Z-0000000004';
  const idManifestDir = 'recovery-20990301T000000Z-0000000005';
  const idGood = 'recovery-20990301T000000Z-0000000006';
  fixtureRoot.tree.link(`${BUNDLES}/${idDirLink}`, outside.abs('real'));
  fixtureRoot.tree.mkdir(`${BUNDLES}/${idManifestLink}`);
  fixtureRoot.tree.link(`${BUNDLES}/${idManifestLink}/manifest.json`, outside.abs('real/manifest.json'));
  fixtureRoot.tree.write(`${BUNDLES}/${idManifestLink}/ready`, '{}');
  fixtureRoot.bundle(idReadyLink, { sessions: ['project-a'], ready: false });
  fixtureRoot.tree.link(`${BUNDLES}/${idReadyLink}/ready`, outside.abs('real/ready'));
  fixtureRoot.bundle(idJournalLink, { sessions: ['project-a'] });
  fixtureRoot.tree.link(`${JOURNALS}/${idJournalLink}.json`, outside.abs('real/journal.json'));
  fixtureRoot.tree.mkdir(`${BUNDLES}/${idManifestDir}/manifest.json`);
  fixtureRoot.bundle(idGood, { sessions: ['project-a'] });
  const runner = fakeRunner();
  const server = await startServer({ toolRoot: fixtureRoot.root, runner: runner.runner });
  try {
    const { post } = await client(server);
    const list = (await post('bundles')).json.data.bundles;
    const byId = Object.fromEntries(list.map((item) => [item.bundle_id, item]));
    for (const id of [idDirLink, idManifestLink, idReadyLink, idJournalLink, idManifestDir]) {
      assert.equal(byId[id].compatible, false, id);
      assert.equal(byId[id].problem, 'unsafe_path', id);
      assert.deepEqual(byId[id].sessions, [], id);
      assert.equal(byId[id].created_at, '', 'nothing was read through the link: ' + id);
      const response = await post('reconcile-preview', { bundle: id });
      assert.equal(response.status, 409, id);
      assert.equal(response.json.code, 'bundle_incompatible', id);
    }
    assert.equal(byId[idGood].compatible, true);
    assert.equal(reconcileCalls(runner).length, 0, 'no preview process started for an unsafe bundle');
  } finally { await server.close(); outside.cleanup(); fixtureRoot.cleanup(); }
});

test('bundles: a symlinked bundle folder or state folder yields no bundles at all', async () => {
  const outside = tempTree('herdr-organizer-outside-');
  const id = 'recovery-20990301T000000Z-0000000007';
  outside.write(`${id}/manifest.json`, JSON.stringify({ schema_version: 2, bundle_id: id, created_at: '2099-01-01T00:00:00+00:00', state: 'sealed', sessions: [{ identity: { herdr_session: 'project-a' } }] }));
  outside.write(`${id}/ready`, '{}');
  const tree = tempTree('herdr-organizer-linkroot-');
  tree.mkdir('state/workspace-organizer/restart-recovery');
  tree.link(BUNDLES, outside.root);
  const server = await startServer({ toolRoot: tree.root });
  try {
    const { post } = await client(server);
    assert.deepEqual((await post('bundles')).json.data.bundles, []);
    assert.equal((await post('reconcile-preview', { bundle: id })).status, 409);
  } finally { await server.close(); tree.cleanup(); outside.cleanup(); }
});

// A second tree used for link targets; created next to the first so cleanup order stays simple.
function tempTreeFor() { return tempTree('herdr-organizer-targets-'); }

test('reconcile-preview: validates the bundle id and runs the read-only preview only', async () => {
  const fixtureRoot = makeRoot();
  fixtureRoot.bundle(ID_B, { sessions: ['project-a'] });
  const runner = fakeRunner();
  const server = await startServer({ toolRoot: fixtureRoot.root, runner: runner.runner });
  try {
    const { post } = await client(server);
    for (const bad of ['../../etc/passwd', 'recovery-x', ID_B + ' --confirm ' + ID_B, ID_B + '; touch /tmp/pwned', '', '--help', ID_B.toUpperCase()]) {
      const response = await post('reconcile-preview', { bundle: bad });
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
    assert.equal((await post('reconcile-preview', { bundle: ID_A })).status, 404, 'a well-formed id that is not on disk');
    assert.equal(reconcileCalls(runner).length, 0, 'the tool never ran for a refused bundle');

    const ok = await post('reconcile-preview', { bundle: ID_B });
    assert.equal(ok.status, 200);
    const call = reconcileCalls(runner)[0];
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
    assert.equal(reconcileCalls(runner).length, 0);
  } finally { await server.close(); fixtureRoot.cleanup(); }
});

test('reconcile-preview: the unsealed bundle and tool failures are reported without leaking', async () => {
  const fixtureRoot = makeRoot();
  fixtureRoot.bundle(ID_A, { sessions: ['project-a'], createdAt: '2020-10-04T12:00:00+00:00', ready: false });
  fixtureRoot.bundle(ID_B, { sessions: ['project-a'] });
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

test('snapshot-data: a symlinked snapshot file is refused', async () => {
  const outside = tempTree('herdr-organizer-snap-outside-');
  outside.write('snapshot.json', JSON.stringify({ workspaces: [{ id: 'w1', label: 'Alpha', tabs: [] }], archives: [] }));
  const tree = tempTree('herdr-organizer-snap-');
  tree.link('state/workspace-organizer/live-snapshot.json', outside.abs('snapshot.json'));
  const server = await startServer({ toolRoot: tree.root });
  try {
    const { post } = await client(server);
    const response = await post('snapshot-data');
    assert.equal(response.status, 502);
    assert.equal(response.json.code, 'snapshot_invalid');
    assert.equal(response.raw.includes('Alpha'), false);
  } finally { await server.close(); tree.cleanup(); outside.cleanup(); }
});
