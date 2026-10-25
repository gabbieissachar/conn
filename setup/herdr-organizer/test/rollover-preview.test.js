'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempTree, startServer, client } = require('./helpers');
const { createRollover } = require('../rollover');
const { createPreview } = require('../rollover-preview');
const { NOW, IDENTITY, identityOf, ROLLER_STUB, makeHome } = require('./rollover-fixtures');

// One fixture home whose watcher code root is a different folder from its data home, as for ~/fm-homes/pmos.
function setup(tree, { roller = ROLLER_STUB, timeoutMs = 3000, env = {} } = {}) {
  const made = makeHome(tree, 'p', { roller });
  const ids = ['crew-ok', 'crew-covered', 'crew-low', 'crew-uuid', 'crew-skip', 'crew-off', 'crew-slow', 'crew-junk'];
  const worktree = tree.mkdir('p/worktree');
  for (const id of ids) { tree.write(`p/home/state/${id}.meta`, `kind=ship\nharness=claude\nworktree=${worktree}\n`); tree.write(`p/home/data/${id}/brief.md`, 'brief\n'); }
  const rollover = createRollover({ env: { HERDR_ORGANIZER_ROLLOVER_HOMES: `p=${made.home}` }, homedir: path.join(tree.real, 'nohome'), now: () => NOW, identityOf, pidAlive: () => true, platform: 'darwin' });
  const preview = createPreview({ rollover, env, timeoutMs });
  const id = rollover.state().homes[0].id;
  return { made, rollover, preview, id, calls: path.join(tree.real, 'p', 'calls.log') };
}

const code = async (promise) => { try { await promise; return 'ok'; } catch (error) { return error.code; } };

test('preview: asks the home\'s own roller, from its own code root, against its own data folder', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, { env: { FM_ROOT_OVERRIDE: '/elsewhere', FM_STATE_OVERRIDE: '/elsewhere/state', HERDR_PANE_ID: 'w9:p9', PATH: process.env.PATH } });
    const result = await env.preview.preview({ home: env.id, kind: 'crew', ids: ['crew-ok', 'crew-covered', 'crew-low'] });
    assert.deepEqual(result.results.map((item) => [item.id, item.verdict, item.covered]), [['crew-covered', 'eligible', true], ['crew-low', 'ineligible', undefined], ['crew-ok', 'eligible', false]]);
    assert.equal(result.eligible, 2);
    assert.equal(result.results.find((item) => item.id === 'crew-ok').detail.includes('dry-run'), false, 'the not-covered note is in `covered`, not repeated in the text');
    assert.equal(result.label, 'p');
    const calls = fs.readFileSync(env.calls, 'utf8').trim().split('\n').map((line) => line.split('|'));
    assert.equal(calls.length, 3, 'one check per id and nothing else was run');
    for (const [cwd, home, stateOverride, rootOverride, optionalLocks, args] of calls) {
      assert.equal(fs.realpathSync(cwd), env.made.home, 'it runs against the data home');
      assert.equal(home, env.made.home);
      assert.equal(stateOverride, 'unset', 'no inherited firstmate override can point it elsewhere');
      assert.equal(rootOverride, 'unset');
      assert.equal(optionalLocks, '0', 'git is told not to refresh any index');
      assert.match(args, /^check crew-(ok|covered|low)$/);
    }
    assert.notEqual(path.join(tree.real, 'p/code'), env.made.home, 'the code root and the data home are separate folders');
  } finally { tree.cleanup(); }
});

test('preview: every kind of verdict is passed on in plain words, and private text is masked', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree);
    const result = await env.preview.preview({ home: env.id, kind: 'crew', ids: ['crew-uuid', 'crew-skip', 'crew-off', 'crew-junk', 'crew-covered', 'crew-slow'].slice(0, 5) });
    const by = Object.fromEntries(result.results.map((item) => [item.id, item]));
    assert.equal(by['crew-skip'].verdict, 'skip');
    assert.equal(by['crew-off'].verdict, 'off');
    assert.equal(by['crew-junk'].verdict, 'unreadable');
    assert.equal(by['crew-uuid'].verdict, 'ineligible');
    assert.equal(by['crew-uuid'].detail.includes('0f1e2d3c'), false, 'a session id is masked');
    assert.equal(by['crew-uuid'].detail.includes('/Users'), false, 'a private path is masked');
    assert.match(by['crew-uuid'].detail, /\[id\].*\[path\]/);
    assert.equal(JSON.stringify(result).includes(tree.real), false);
  } finally { tree.cleanup(); }
});

test('preview: a slow check is cut off and named, and unknown ids are not run', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, { timeoutMs: 400 });
    const result = await env.preview.preview({ home: env.id, kind: 'crew', ids: ['crew-slow', 'ghost', 'crew-ok'] });
    const by = Object.fromEntries(result.results.map((item) => [item.id, item.verdict]));
    assert.deepEqual(by, { 'crew-ok': 'eligible', 'crew-slow': 'timeout', ghost: 'unknown' });
    const calls = fs.readFileSync(env.calls, 'utf8');
    assert.equal(calls.includes('ghost'), false, 'an id with no task record is never passed to the roller');
  } finally { tree.cleanup(); }
});

test('preview: refusals before anything runs', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree);
    const ask = (params) => code(env.preview.preview({ home: env.id, kind: 'crew', ids: ['crew-ok'], ...params }));
    assert.equal(await ask({ kind: 'primary' }), 'bad_kind');
    assert.equal(await ask({ ids: [] }), 'bad_ids');
    assert.equal(await ask({ ids: ['--primary'] }), 'bad_ids', 'the primary\'s check is not part of this preview');
    assert.equal(await ask({ ids: ['-x'] }), 'bad_ids');
    assert.equal(await ask({ ids: ['a b'] }), 'bad_ids');
    assert.equal(await ask({ ids: ['x; rm -rf /'] }), 'bad_ids');
    assert.equal(await ask({ ids: Array.from({ length: 65 }, (_, index) => `i${index}`) }), 'bad_ids');
    assert.equal(await ask({ home: 'hdeadbeef' }), 'unknown_home');
    assert.equal(fs.existsSync(env.calls), false, 'nothing was run for a refused request');
    // no watcher, and a roller that has no check command
    const dead = createPreview({ rollover: createRollover({ env: { HERDR_ORGANIZER_ROLLOVER_HOMES: `p=${env.made.home}` }, homedir: '/h', now: () => NOW, identityOf, pidAlive: () => false, platform: 'darwin' }) });
    assert.equal(await code(dead.preview({ home: env.id, kind: 'crew', ids: ['crew-ok'] })), 'no_watcher');
    fs.writeFileSync(path.join(tree.real, 'p/code/bin/fm-rollover.sh'), ': rollover-live rollover-crew-live rollover-off rollover-primary-live rollover-primary-off\n');
    assert.equal(await ask({}), 'unsupported');
    assert.equal(fs.existsSync(env.calls), false);
  } finally { tree.cleanup(); }
});

test('preview: a lock whose process runs another script gets nothing run (R7-5)', async () => {
  const tree = tempTree();
  try {
    const made = makeHome(tree, 'q', { roller: ROLLER_STUB, identity: 'Mon Oct 26 09:00:00 2026     sleep 1800' });
    const worktree = tree.mkdir('q/worktree');
    tree.write('q/home/state/crew-ok.meta', `kind=ship\nharness=claude\nworktree=${worktree}\n`);
    const rollover = createRollover({ env: { HERDR_ORGANIZER_ROLLOVER_HOMES: `q=${made.home}` }, homedir: path.join(tree.real, 'nohome'), now: () => NOW, identityOf, pidAlive: () => true, platform: 'darwin' });
    const preview = createPreview({ rollover });
    assert.equal(await code(preview.preview({ home: rollover.state().homes[0].id, kind: 'crew', ids: ['crew-ok'] })), 'no_watcher');
    assert.equal(fs.existsSync(path.join(tree.real, 'q', 'calls.log')), false, 'the roller named by the lock was not run');
  } finally { tree.cleanup(); }
});

test('preview: it only reads, writes nothing under the home, and names no write', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree);
    const listing = () => fs.readdirSync(env.made.home, { recursive: true }).sort().join('\n');
    const before = listing();
    await env.preview.preview({ home: env.id, kind: 'crew', ids: ['crew-ok', 'crew-low'] });
    assert.equal(listing(), before, 'the data home is unchanged');
    assert.deepEqual(fs.readdirSync(path.join(env.made.home, 'config')), []);
    const source = fs.readFileSync(path.join(__dirname, '..', 'rollover-preview.js'), 'utf8');
    assert.equal(/\b(writeFile|appendFile|unlink|rmdir|mkdir|rename|symlink|chmod|openSync)(Sync)?\(/.test(source), false);
    assert.equal(/'(roll|gate|tick)'/.test(source), false, 'only the check command is ever passed to the roller');
  } finally { tree.cleanup(); }
});

test('rollover-preview over HTTP: tier 0, same guard, takes a home, a kind and ids', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree);
    const server = await startServer({ rollover: env.rollover, preview: env.preview });
    try {
      assert.equal(server.api.ACTIONS['rollover-preview'].tier, 0);
      const { post } = await client(server);
      const ok = await post('rollover-preview', { home: env.id, kind: 'crew', ids: ['crew-ok'] });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.data.results[0].verdict, 'eligible');
      assert.equal(ok.raw.includes(tree.real), false);
      assert.equal((await post('rollover-preview', { home: env.id, kind: 'crew' })).status, 400, 'missing ids');
      assert.equal((await post('rollover-preview', { home: env.id, kind: 'crew', ids: ['crew-ok'], path: '/x' })).status, 400, 'no path param');
      assert.equal((await post('rollover-preview', { home: env.id, kind: 'crew', ids: ['crew-ok'] }, { Origin: 'http://evil.example' })).status, 403);
    } finally { await server.close(); }
  } finally { tree.cleanup(); }
});
