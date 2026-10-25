'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempTree, startServer, client, fakeRunner, fixture } = require('./helpers');
const { createRollover } = require('../rollover');
const { createSwitches } = require('../rollover-switches');
const crypto = require('node:crypto');
const idHash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const { NOW, IDENTITY, identityOf, ROLLER_ALL, makeHome } = require('./rollover-fixtures');

// A registry of fixture homes and a write side wired to one private tool root. `server()` makes a second write side on the
// same tool root, the way a scratch server on another port would be.
function setup(tree, names, { roller, hooks, lockWaitMs = 300, pidAlive = () => true, config = {} } = {}) {
  const homes = names.map((name) => makeHome(tree, name, { ...(roller ? { roller } : {}), ...(config[name] || {}) }));
  const toolRoot = tree.mkdir('tools');
  const env = { HERDR_ORGANIZER_ROLLOVER_HOMES: homes.map((home, index) => `${names[index]}=${home.home}`).join(path.delimiter) };
  const ledgerPath = path.join(tree.real, 'tools', 'state', 'workspace-organizer', 'rollover-switches', 'ledger.json');
  const make = (extra = {}) => {
    const rollover = createRollover({ env, homedir: path.join(tree.real, 'nohome'), now: () => NOW, identityOf, pidAlive: extra.pidAlive || pidAlive, platform: 'darwin', ledgerPath });
    const switches = createSwitches({ rollover, toolRoot: path.join(tree.real, 'tools'), now: () => NOW, pidAlive, identityOf, platform: 'darwin', lockWaitMs, hooks, ...extra });
    return { rollover, switches };
  };
  const first = make();
  const ids = Object.fromEntries(names.map((name) => [name, first.rollover.state().homes.find((item) => item.label === name).id]));
  return { homes, toolRoot, ledgerPath, ids, ...first, server: make, dir: path.join(tree.real, 'tools', 'state', 'workspace-organizer', 'rollover-switches') };
}

// Two second-mate records and two crew records the roller could roll, for the home `name`.
function addRecords(tree, name) {
  const worktree = tree.mkdir(`${name}/worktree`);
  const seeded = tree.mkdir(`${name}/sm-home`);
  tree.write(`${name}/sm-home/.fm-secondmate-home`, 'sm-a\n');
  tree.write(`${name}/home/state/sm-a.meta`, `kind=secondmate\nharness=claude\nhome=${seeded}\n`);
  const seededB = tree.mkdir(`${name}/sm-home-b`);
  tree.write(`${name}/sm-home-b/.fm-secondmate-home`, 'sm-b\n');
  tree.write(`${name}/home/state/sm-b.meta`, `kind=secondmate\nharness=claude\nhome=${seededB}\n`);
  for (const id of ['crew-a', 'crew-b']) {
    tree.write(`${name}/home/state/${id}.meta`, `kind=ship\nharness=claude\nworktree=${worktree}\n`);
    tree.write(`${name}/home/data/${id}/brief.md`, 'brief\n');
  }
  tree.write(`${name}/home/state/codex-one.meta`, 'kind=ship\nharness=codex\n');
}

const armToken = (home, kind, ids) => `rollover-arm:${home}:${kind}:${[...ids].sort().join(',')}`;
const arm = (env, name, kind, ids, extra = {}) => env.switches.arm({ home: env.ids[name], kind, ids, confirm: armToken(env.ids[name], kind, ids), ...extra });
const configOf = (env, index = 0) => path.join(env.homes[index].home, 'config');
const listConfig = (env, index = 0) => fs.readdirSync(configOf(env, index)).sort();
const auditLines = (env) => fs.readFileSync(path.join(env.dir, 'audit.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const code = async (promise) => { try { await promise; return 'ok'; } catch (error) { return error.code; } };

test('arm: creates one live file with the page header and the ids, exclusively, and records it', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a']);
    addRecords(tree, 'a');
    const result = await arm(env, 'a', 'second-mates', ['sm-b', 'sm-a']);
    assert.deepEqual(result, { home: env.ids.a, label: 'a', file: 'rollover-live', created: true, ids: 2 });
    const file = path.join(configOf(env), 'rollover-live');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^# created by the Herdr organizer page, request r[0-9a-f]{12}, 2026-10-26T12:00:00\.000Z\nsm-a\nsm-b\n$/, 'header comment, then the sorted ids');
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.deepEqual(listConfig(env), ['rollover-live'], 'no other file was written in the home');
    const ledger = JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8'));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].ino, fs.statSync(file).ino);
    assert.equal(fs.statSync(env.dir).mode & 0o777, 0o700, 'the private folder');
    assert.equal(fs.statSync(env.ledgerPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(env.dir, 'audit.log')).mode & 0o777, 0o600);
    const state = env.rollover.state().homes[0];
    const live = state.files.find((item) => item.name === 'rollover-live');
    assert.equal(live.origin, 'page');
    assert.equal(live.ids_count, 2);
    assert.equal(state.effective.second_mates, 'second mates: live for 2 listed; every other one is dry-run');
    // crew goes into its own file and the two never mix
    await arm(env, 'a', 'crew', ['crew-a']);
    assert.deepEqual(listConfig(env), ['rollover-crew-live', 'rollover-live']);
    assert.match(fs.readFileSync(path.join(configOf(env), 'rollover-crew-live'), 'utf8'), /\ncrew-a\n$/);
  } finally { tree.cleanup(); }
});

test('arm: the file appears complete or not at all (R7-1)', async () => {
  const tree = tempTree();
  try {
    const snapshots = [];
    let failWrites = false;
    const env = setup(tree, ['a'], { hooks: {
      write: (fd, text) => { if (failWrites) { const error = new Error('no space left on device'); error.code = 'ENOSPC'; throw error; } fs.writeSync(fd, text); },
      beforeLink: (home, name, temp) => { snapshots.push({ target: fs.existsSync(path.join(home.configDir, name)), temp: fs.readFileSync(temp, 'utf8'), listing: fs.readdirSync(home.configDir) }); },
    } });
    addRecords(tree, 'a');
    // a failed write: no target, no temp, no record, and a refusal the page can show
    failWrites = true;
    assert.equal(await code(arm(env, 'a', 'second-mates', ['sm-a'])), 'write_failed');
    assert.deepEqual(listConfig(env), [], 'no empty switch file, which firstmate would read as live for every eligible session, and no temp file');
    assert.equal(fs.existsSync(env.ledgerPath), false, 'no ledger entry');
    assert.equal(auditLines(env).at(-1).outcome, 'write_failed');
    assert.deepEqual(snapshots, [], 'the failure happened before the link');
    // a good write: at the moment before the link the real name does not exist yet and the temp already holds every id
    failWrites = false;
    await arm(env, 'a', 'second-mates', ['sm-b', 'sm-a']);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].target, false, 'a reader polling config/ sees no file until it is complete');
    assert.match(snapshots[0].temp, /\nsm-a\nsm-b\n$/, 'the temp file is complete before it gets its name');
    assert.ok(snapshots[0].listing.every((entry) => entry.startsWith('.rollover-live.tmp.')), 'only a dot-named temp file exists meanwhile');
    assert.deepEqual(listConfig(env), ['rollover-live'], 'the temp file is gone afterwards');
    assert.match(fs.readFileSync(path.join(configOf(env), 'rollover-live'), 'utf8'), /\nsm-a\nsm-b\n$/);
    assert.equal(JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8')).entries[0].ino, fs.statSync(path.join(configOf(env), 'rollover-live')).ino, 'the ledger holds the linked inode');
    // an existing file still wins, and leaves no temp behind
    assert.equal(await code(arm(env, 'a', 'second-mates', ['sm-a'])), 'exists');
    assert.deepEqual(listConfig(env), ['rollover-live']);
    // Stop's off file goes the same way
    failWrites = true;
    const stopped = await env.switches.stop({ homes: [env.ids.a] }).catch((error) => error);
    assert.deepEqual(listConfig(env), ['rollover-live'], 'a failed off file leaves nothing either');
    assert.ok(stopped);
  } finally { tree.cleanup(); }
});

test('arm: the confirm token, the ids and the kind are checked before anything is read or written', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a']);
    addRecords(tree, 'a');
    const id = env.ids.a;
    const call = (params) => code(env.switches.arm({ home: id, kind: 'second-mates', ids: ['sm-a'], confirm: armToken(id, 'second-mates', ['sm-a']), ...params }));
    assert.equal(await call({ confirm: '' }), 'confirm_required');
    assert.equal(await call({ confirm: armToken(id, 'crew', ['sm-a']) }), 'confirm_required', 'the token names the kind');
    assert.equal(await call({ confirm: armToken(id, 'second-mates', ['sm-b']) }), 'confirm_required', 'and the ids');
    assert.equal(await call({ ids: [], confirm: armToken(id, 'second-mates', []) }), 'ids_required', 'an empty list is refused: every eligible, now and later, is not offered');
    assert.equal(await call({ ids: ['sm-a; rm -rf x'], confirm: 'x' }), 'bad_ids');
    assert.equal(await call({ ids: ['../escape'], confirm: 'x' }), 'bad_ids');
    assert.equal(await call({ ids: Array.from({ length: 65 }, (_, index) => `s${index}`), confirm: 'x' }), 'bad_ids');
    assert.equal(await call({ kind: 'primary', confirm: 'x' }), 'bad_kind', 'the primary is never armed through this action');
    assert.equal(await call({ home: 'hdeadbeef', confirm: armToken('hdeadbeef', 'second-mates', ['sm-a']) }), 'unknown_home');
    assert.deepEqual(listConfig(env), [], 'nothing was written');
  } finally { tree.cleanup(); }
});

test('arm: every refusal names its reason, writes nothing and is audited', async () => {
  const tree = tempTree();
  try {
    const noCrew = ROLLER_ALL.split('\n').filter((line) => !line.includes('rollover-crew-live')).join('\n') + '\n';
    const env = setup(tree, ['ok', 'nocrew', 'dead', 'noconfig', 'linked', 'swapme'], { roller: undefined });
    for (const name of ['ok', 'nocrew', 'dead', 'noconfig', 'linked', 'swapme']) addRecords(tree, name);
    fs.writeFileSync(path.join(tree.real, 'nocrew/code/bin/fm-rollover.sh'), noCrew);
    const refused = async (name, kind, ids) => code(arm(env, name, kind, ids));
    // exists: a regular file, a dangling link
    fs.writeFileSync(path.join(configOf(env, 0), 'rollover-live'), '');
    assert.equal(await refused('ok', 'second-mates', ['sm-a']), 'exists', 'an operator file is never overwritten');
    assert.equal(fs.readFileSync(path.join(configOf(env, 0), 'rollover-live'), 'utf8'), '');
    fs.unlinkSync(path.join(configOf(env, 0), 'rollover-live'));
    fs.symlinkSync('/nowhere/at/all', path.join(configOf(env, 0), 'rollover-live'));
    assert.equal(await refused('ok', 'second-mates', ['sm-a']), 'exists', 'not even through a dangling link');
    assert.equal(fs.lstatSync(path.join(configOf(env, 0), 'rollover-live')).isSymbolicLink(), true);
    assert.equal(fs.existsSync('/nowhere'), false);
    fs.unlinkSync(path.join(configOf(env, 0), 'rollover-live'));
    // off present: any presence counts
    fs.symlinkSync('/nowhere/off', path.join(configOf(env, 0), 'rollover-off'));
    assert.equal(await refused('ok', 'second-mates', ['sm-a']), 'off_present');
    fs.unlinkSync(path.join(configOf(env, 0), 'rollover-off'));
    // a file the home's code does not read
    assert.equal(await refused('nocrew', 'crew', ['crew-a']), 'unsupported');
    // no running watcher
    const stale = env.server({ pidAlive: () => false });
    assert.equal(await code(stale.switches.arm({ home: env.ids.dead, kind: 'second-mates', ids: ['sm-a'], confirm: armToken(env.ids.dead, 'second-mates', ['sm-a']) })), 'no_watcher');
    // ids that cannot roll now, with the roller's own reasons
    let details;
    try { await arm(env, 'ok', 'crew', ['crew-a', 'codex-one', 'ghost', 'sm-a']); } catch (error) { details = error; }
    assert.equal(details.code, 'not_rolled');
    assert.deepEqual(details.reasons, [{ id: 'codex-one', reason: 'harness' }, { id: 'ghost', reason: 'unknown' }, { id: 'sm-a', reason: 'unknown' }], 'a second mate is not a crew id, and an unknown id is named');
    // config folder missing or a link
    fs.rmdirSync(configOf(env, 3));
    assert.equal(await refused('noconfig', 'second-mates', ['sm-a']), 'no_config');
    assert.equal(fs.existsSync(configOf(env, 3)), false, 'the config folder is never created');
    fs.rmdirSync(configOf(env, 4));
    fs.symlinkSync(configOf(env, 0), configOf(env, 4));
    assert.equal(await refused('linked', 'second-mates', ['sm-a']), 'unsafe');
    assert.deepEqual(listConfig(env, 0), [], 'nothing leaked through the link into another home');
    // a swapped home path
    fs.renameSync(env.homes[5].home, env.homes[5].home + '.real');
    fs.symlinkSync(env.homes[0].home, env.homes[5].home);
    try { assert.equal(await refused('swapme', 'second-mates', ['sm-a']), 'home_unavailable'); } finally { fs.unlinkSync(env.homes[5].home); fs.renameSync(env.homes[5].home + '.real', env.homes[5].home); }
    assert.deepEqual(listConfig(env, 0), []);
    // every refusal after the request was understood has an intent line and a result line with the code
    const lines = auditLines(env);
    const results = lines.filter((line) => line.phase === 'result').map((line) => line.outcome);
    assert.deepEqual(results, ['exists', 'exists', 'off_present', 'unsupported', 'no_watcher', 'not_rolled', 'no_config', 'unsafe', 'home_unavailable']);
    assert.equal(lines.filter((line) => line.phase === 'intent').length, results.length);
    assert.equal(JSON.stringify(lines).includes('crew-a'), false, 'the audit holds counts, not ids');
  } finally { tree.cleanup(); }
});

test('undo: removes only a file the page made and left unchanged', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a']);
    addRecords(tree, 'a');
    const id = env.ids.a;
    const file = path.join(configOf(env), 'rollover-live');
    // arm then undo at once, no confirm for a live file
    await arm(env, 'a', 'second-mates', ['sm-a']);
    assert.deepEqual(await env.switches.undo({ home: id, file: 'rollover-live' }), { home: id, label: 'a', file: 'rollover-live', removed: true });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8')).entries, [], 'the record is gone with the file');
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-live' })), 'not_created_by_page', 'nothing left to remove');
    // an operator-made file
    fs.writeFileSync(file, 'sm-a\n');
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-live' })), 'not_created_by_page');
    assert.equal(fs.existsSync(file), true);
    fs.unlinkSync(file);
    // edited after creation
    await arm(env, 'a', 'second-mates', ['sm-a']);
    fs.appendFileSync(file, 'sm-b\n');
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-live' })), 'changed_since_created');
    assert.equal(fs.existsSync(file), true, 'an edited file is the operator\'s and stays');
    // a swapped inode with the same content
    const content = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    await arm(env, 'a', 'second-mates', ['sm-a']);
    const made = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    fs.writeFileSync(file, made);
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-live' })), 'changed_since_created', 'same text, different file');
    assert.notEqual(content, undefined);
    // no longer a plain file; and already gone
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-live' })), 'not_regular');
    fs.rmdirSync(file);
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-live' })), 'gone');
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-live' })), 'not_created_by_page', 'the stale record was cleared');
    // only the three files of this slice, and only by name
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-primary-live' })), 'bad_file');
    assert.equal(await code(env.switches.undo({ home: id, file: '../state/.lock-session' })), 'bad_file');
  } finally { tree.cleanup(); }
});

test('stop and undo of the off file: Stop needs no confirm, removing off needs the resume token', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a']);
    const id = env.ids.a;
    const stopped = await env.switches.stop({ homes: [id] });
    assert.deepEqual(stopped.homes, [{ id, label: 'a', result: 'created' }]);
    const off = path.join(configOf(env), 'rollover-off');
    assert.match(fs.readFileSync(off, 'utf8'), /^# created by the Herdr organizer page, request r[0-9a-f]{12}, /);
    assert.equal(env.rollover.state().homes[0].files.find((item) => item.name === 'rollover-off').origin, 'page');
    assert.equal((await env.switches.stop({ homes: [id] })).homes[0].result, 'present_by_page', 'a second Stop leaves it alone');
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-off' })), 'confirm_required');
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-off', confirm: 'rollover-resume:hother' })), 'confirm_required');
    assert.equal(fs.existsSync(off), true);
    await env.switches.undo({ home: id, file: 'rollover-off', confirm: `rollover-resume:${id}` });
    assert.equal(fs.existsSync(off), false);
    // the operator's own off file is left alone and reported
    fs.writeFileSync(off, '');
    assert.equal((await env.switches.stop()).homes[0].result, 'present_other');
    assert.equal(fs.readFileSync(off, 'utf8'), '');
    assert.equal(await code(env.switches.undo({ home: id, file: 'rollover-off', confirm: `rollover-resume:${id}` })), 'not_created_by_page');
    assert.equal(await code(env.switches.stop({ homes: ['hnothere'] })), 'bad_homes');
    assert.equal(await code(env.switches.stop({ homes: [] })), 'bad_homes');
  } finally { tree.cleanup(); }
});

test('stop covers every registered home, never waits for a missing watcher, and counts the homes it does not cover', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['run', 'idle', 'bare', 'legacy'], { pidAlive: () => true, config: { idle: { lock: false } } });
    fs.rmdirSync(configOf(env, 2));
    fs.writeFileSync(path.join(tree.real, 'legacy/code/bin/fm-rollover.sh'), 'nothing here\n');
    tree.mkdir('h/.treehouse/firstmate-aaaaaa/1/firstmate');
    const rollover = createRollover({ env: { HERDR_ORGANIZER_ROLLOVER_HOMES: env.homes.map((home, index) => `${['run', 'idle', 'bare', 'legacy'][index]}=${home.home}`).join(path.delimiter) }, homedir: path.join(tree.real, 'h'), now: () => NOW, identityOf, pidAlive: () => true, platform: 'darwin' });
    const switches = createSwitches({ rollover, toolRoot: path.join(tree.real, 'tools'), now: () => NOW, pidAlive: () => true, identityOf, platform: 'darwin' });
    const result = await switches.stop();
    const by = Object.fromEntries(result.homes.map((item) => [item.label, item.result]));
    assert.deepEqual(by, { run: 'created', idle: 'created_no_watcher', bare: 'no_config', legacy: 'not_read' });
    assert.equal(result.unregistered_homes, 1);
    assert.equal(fs.existsSync(path.join(configOf(env, 0), 'rollover-off')), true);
    assert.equal(fs.existsSync(path.join(configOf(env, 1), 'rollover-off')), true, 'a home with no watcher still gets the file: a watcher started later reads it');
    assert.equal(fs.existsSync(path.join(configOf(env, 3), 'rollover-off')), false, 'a home whose code does not read the file gets nothing');
    assert.equal(JSON.stringify(result).includes('aaaaaa'), false);
    // Stop removes nothing: a live file is still there
    fs.writeFileSync(path.join(configOf(env, 0), 'rollover-live'), '');
    await switches.stop();
    assert.equal(fs.existsSync(path.join(configOf(env, 0), 'rollover-live')), true);
  } finally { tree.cleanup(); }
});

test('Stop and Resume interleaved leave the file and the record telling the same story', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a']);
    const id = env.ids.a;
    await env.switches.stop({ homes: [id] });
    for (let round = 0; round < 6; round += 1) {
      const order = round % 2 ? [env.switches.stop({ homes: [id] }), env.switches.undo({ home: id, file: 'rollover-off', confirm: `rollover-resume:${id}` }).catch(() => null)]
        : [env.switches.undo({ home: id, file: 'rollover-off', confirm: `rollover-resume:${id}` }).catch(() => null), env.switches.stop({ homes: [id] })];
      await Promise.all(order);
      const present = fs.existsSync(path.join(configOf(env), 'rollover-off'));
      const entries = JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8')).entries.filter((entry) => entry.file === 'rollover-off');
      assert.equal(entries.length, present ? 1 : 0, `round ${round}: the record matches the file`);
      if (!present) await env.switches.stop({ homes: [id] });
    }
    const second = env.server();
    await Promise.all([env.switches.stop({ homes: [id] }), second.switches.stop({ homes: [id] })]);
    assert.equal(fs.existsSync(path.join(configOf(env), 'rollover-off')), true, 'two servers stopping at once end stopped');
  } finally { tree.cleanup(); }
});

test('a config folder swapped between the check and the create: only the page\'s own new file is removed', async () => {
  const tree = tempTree();
  try {
    const other = tree.mkdir('elsewhere');
    const env = setup(tree, ['a'], { hooks: { beforeCreate: (home) => { fs.renameSync(home.configDir, home.configDir + '.away'); fs.symlinkSync(other, home.configDir); } } });
    addRecords(tree, 'a');
    tree.write('elsewhere/keep.txt', 'mine\n');
    assert.equal(await code(arm(env, 'a', 'second-mates', ['sm-a'])), 'parent_changed');
    assert.deepEqual(fs.readdirSync(other).sort(), ['keep.txt'], 'the file that landed in the other folder was removed, and nothing else');
    assert.equal(fs.existsSync(env.ledgerPath), false, 'no record of a file that does not exist');
    assert.equal(auditLines(env).at(-1).outcome, 'parent_changed');
    fs.unlinkSync(configOf(env));
    fs.renameSync(configOf(env) + '.away', configOf(env));
  } finally { tree.cleanup(); }
});

test('two servers on one tool root keep both records and both files can be undone', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a']);
    addRecords(tree, 'a');
    const other = env.server();
    await arm(env, 'a', 'second-mates', ['sm-a']);
    await other.switches.arm({ home: env.ids.a, kind: 'crew', ids: ['crew-a'], confirm: armToken(env.ids.a, 'crew', ['crew-a']) });
    assert.equal(JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8')).entries.length, 2, 'neither entry was lost');
    await other.switches.undo({ home: env.ids.a, file: 'rollover-live' });
    await env.switches.undo({ home: env.ids.a, file: 'rollover-crew-live' });
    assert.deepEqual(listConfig(env), []);
    // at the same moment
    await Promise.all([arm(env, 'a', 'second-mates', ['sm-b']), other.switches.arm({ home: env.ids.a, kind: 'crew', ids: ['crew-b'], confirm: armToken(env.ids.a, 'crew', ['crew-b']) })]);
    assert.deepEqual(listConfig(env), ['rollover-crew-live', 'rollover-live']);
    assert.equal(JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8')).entries.length, 2);
    assert.deepEqual(fs.readdirSync(env.dir).filter((name) => name.startsWith('op.')), [], 'no lock folder is left behind');
  } finally { tree.cleanup(); }
});

test('the folder lock: a live holder makes arm wait then refuse, and Stop goes ahead without a record', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a'], { lockWaitMs: 200 });
    addRecords(tree, 'a');
    fs.mkdirSync(env.dir, { recursive: true, mode: 0o700 });
    const holder = (name, data) => { fs.mkdirSync(path.join(env.dir, name)); if (data) fs.writeFileSync(path.join(env.dir, name, 'holder'), JSON.stringify(data)); };
    holder('op.lock', { pid: process.pid, identity_sha256: idHash(IDENTITY), started: NOW.toISOString(), nonce: 'live-holder' });
    const started = Date.now();
    assert.equal(await code(arm(env, 'a', 'second-mates', ['sm-a'])), 'busy_other_process');
    assert.ok(Date.now() - started >= 180, 'it waited for the holder first');
    assert.deepEqual(listConfig(env), []);
    const stopped = await env.switches.stop({ homes: [env.ids.a] });
    assert.equal(stopped.homes[0].result, 'created', 'Stop is never blocked by bookkeeping');
    assert.equal(fs.existsSync(path.join(configOf(env), 'rollover-off')), true);
    assert.equal(fs.existsSync(env.ledgerPath), false, 'and writes no record while it cannot hold the lock');
    assert.equal(auditLines(env).at(-1).ledger, 'skipped (lock busy)');
    assert.equal(env.rollover.state().homes[0].files.find((item) => item.name === 'rollover-off').origin, 'page_header_only', 'the card shows it as having the page\'s header and no record');
    assert.equal(await code(env.switches.undo({ home: env.ids.a, file: 'rollover-off', confirm: `rollover-resume:${env.ids.a}` })), 'busy_other_process');
    assert.equal(fs.readFileSync(path.join(env.dir, 'op.lock', 'holder'), 'utf8').includes('live-holder'), true, 'the live holder\'s lock was not touched');
  } finally { tree.cleanup(); }
});

test('the folder lock: a dead holder, a changed identity and an old holder-less folder are replaced; a fresh holder-less one is waited for', async () => {
  const tree = tempTree();
  try {
    const dead = 987654;
    const env = setup(tree, ['a'], { lockWaitMs: 150, pidAlive: (pid) => pid !== dead });
    addRecords(tree, 'a');
    fs.mkdirSync(env.dir, { recursive: true, mode: 0o700 });
    const lock = path.join(env.dir, 'op.lock');
    const place = (data, old) => {
      fs.mkdirSync(lock);
      if (data) fs.writeFileSync(path.join(lock, 'holder'), JSON.stringify(data));
      if (old) { const when = new Date(NOW.getTime() - 120 * 1000); fs.utimesSync(lock, when, when); }
    };
    const clear = () => { for (const name of fs.readdirSync(lock)) fs.unlinkSync(path.join(lock, name)); fs.rmdirSync(lock); };
    const armOnce = async (id) => { await arm(env, 'a', 'second-mates', [id]); await env.switches.undo({ home: env.ids.a, file: 'rollover-live' }); };
    place({ pid: dead, identity_sha256: idHash(IDENTITY), nonce: 'n1' });
    await armOnce('sm-a');
    assert.equal(fs.existsSync(lock), false, 'a dead holder\'s lock was replaced, used and released');
    place({ pid: process.pid, identity_sha256: idHash('some other process'), nonce: 'n2' });
    await armOnce('sm-a');
    place(null, true);
    await armOnce('sm-a');
    place(null, false);
    fs.utimesSync(lock, NOW, NOW);
    assert.equal(await code(arm(env, 'a', 'second-mates', ['sm-a'])), 'busy_other_process', 'a holder-less folder made a moment ago may still be getting its holder');
    clear();
    assert.deepEqual(fs.readdirSync(env.dir).filter((name) => /^op\.(stale|done|new|steal)/.test(name)), [], 'no half-made lock is left behind');
  } finally { tree.cleanup(); }
});

test('the folder lock: a live holder whose identity cannot be read right now stays held (R7-3)', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a']);
    const holderSide = env.server();
    const held = holderSide.switches.internals.tryAcquire();
    assert.ok(held);
    // ps failed or timed out in the other process: no identity, the pid is alive, so the lock is not stale and cannot be taken
    const blind = env.server({ identityOf: () => null });
    assert.equal(blind.switches.internals.staleNonce(), null);
    assert.equal(await blind.switches.internals.reclaim(held), false);
    assert.equal(blind.switches.internals.tryAcquire(), null, 'a second writer cannot get in');
    // a genuinely different process on that pid is still stale
    const changed = env.server({ identityOf: () => 'a different process' });
    assert.equal(changed.switches.internals.staleNonce(), held);
    holderSide.switches.internals.releaseFolderLock(held);
  } finally { tree.cleanup(); }
});

test('the folder lock: a long process identity does not hide the holder, and the lock is released afterwards', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a']);
    addRecords(tree, 'a');
    const longIdentity = 'Mon Oct 26 09:00:00 2026     node ' + 'x'.repeat(60000);
    const long = env.server({ identityOf: () => longIdentity });
    await long.switches.arm({ home: env.ids.a, kind: 'crew', ids: ['crew-a'], confirm: armToken(env.ids.a, 'crew', ['crew-a']) });
    assert.deepEqual(fs.readdirSync(env.dir).filter((name) => name.startsWith('op.')), [], 'released, nothing left');
    const held = long.switches.internals.tryAcquire();
    assert.ok(held);
    assert.ok(long.switches.internals.staleNonce() === null, 'a live holder with a long identity is read and is not stale');
    long.switches.internals.releaseFolderLock(held);
    assert.equal(fs.existsSync(long.switches.internals.lockPath), false);
  } finally { tree.cleanup(); }
});

test('the folder lock: exactly one process holds it when two race, and a second judge of one dead holder cannot take a fresh lock', async () => {
  const tree = tempTree();
  try {
    const dead = 987654;
    const env = setup(tree, ['a'], { pidAlive: (pid) => pid !== dead });
    const a = env.switches.internals;
    const b = env.server().switches.internals;
    // absent lock: two processes try at once
    const first = a.tryAcquire();
    const second = b.tryAcquire();
    assert.ok(first && !second, 'one holds it, the other gets nothing');
    assert.equal(fs.existsSync(path.join(env.dir, 'op.lock', 'holder')), true, 'the lock never exists without its holder');
    a.releaseFolderLock(first);
    assert.equal(fs.existsSync(a.lockPath), false);
    // a dead holder judged stale by both
    fs.mkdirSync(a.lockPath);
    fs.writeFileSync(path.join(a.lockPath, 'holder'), JSON.stringify({ pid: dead, identity_sha256: idHash(IDENTITY), nonce: 'old-nonce' }));
    const judgedByA = a.staleNonce();
    const judgedByB = b.staleNonce();
    assert.equal(judgedByA, 'old-nonce');
    assert.equal(judgedByB, 'old-nonce');
    assert.equal(await a.reclaim(judgedByA), true);
    const fresh = a.tryAcquire();
    assert.ok(fresh, 'A now holds a fresh lock');
    assert.equal(await b.reclaim(judgedByB), false, 'B judged the old holder; the lock now carries another nonce');
    assert.equal(JSON.parse(fs.readFileSync(path.join(a.lockPath, 'holder'), 'utf8')).nonce, fresh, 'A\'s lock is untouched');
    assert.equal(b.tryAcquire(), null);
    a.releaseFolderLock(fresh);
    // a stale steal mutex does not wedge reclaiming
    fs.mkdirSync(a.lockPath);
    fs.writeFileSync(path.join(a.lockPath, 'holder'), JSON.stringify({ pid: dead, identity_sha256: idHash(IDENTITY), nonce: 'n3' }));
    fs.mkdirSync(path.join(env.dir, 'op.steal'));
    const long = new Date(NOW.getTime() - 60 * 1000);
    fs.utimesSync(path.join(env.dir, 'op.steal'), long, long);
    assert.equal(await a.reclaim('n3'), true, 'a steal mutex older than 5 s is cleared and the reclaim goes on');
    assert.equal(fs.existsSync(path.join(env.dir, 'op.steal')), false);
    fs.mkdirSync(a.lockPath);
    fs.writeFileSync(path.join(a.lockPath, 'holder'), JSON.stringify({ pid: dead, identity_sha256: idHash(IDENTITY), nonce: 'n4' }));
    fs.mkdirSync(path.join(env.dir, 'op.steal'));
    fs.utimesSync(path.join(env.dir, 'op.steal'), NOW, NOW);
    assert.equal(await a.reclaim('n4'), false, 'a fresh steal mutex means another process is reclaiming: wait');
    assert.equal(fs.existsSync(a.lockPath), true, 'and the lock is left alone');
  } finally { tree.cleanup(); }
});

test('the audit log: an intent before and a result after, no ids and no paths, one line each', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a']);
    addRecords(tree, 'a');
    await env.switches.arm({ home: env.ids.a, kind: 'second-mates', ids: ['sm-a'], confirm: armToken(env.ids.a, 'second-mates', ['sm-a']) }, { origin: 'http://localhost:8765' });
    await env.switches.stop({ homes: [env.ids.a] });
    await env.switches.undo({ home: env.ids.a, file: 'rollover-live' });
    const lines = auditLines(env);
    assert.deepEqual(lines.map((line) => `${line.phase}:${line.action}`), ['intent:rollover-arm', 'result:rollover-arm', 'intent:rollover-stop', 'result:rollover-stop', 'intent:rollover-undo', 'result:rollover-undo']);
    assert.equal(lines[0].request, lines[1].request, 'the two lines of one attempt share a request id');
    assert.equal(lines[0].origin, 'http://localhost:8765');
    assert.equal(lines[0].ids, 1);
    assert.match(lines[1].sha256, /^[0-9a-f]{64}$/);
    assert.equal(lines[1].outcome, 'created');
    assert.equal(JSON.stringify(lines).includes(tree.real), false, 'no path');
    assert.equal(JSON.stringify(lines).includes('sm-a'), false, 'no ids');
    const source = fs.readFileSync(path.join(__dirname, '..', 'rollover-switches.js'), 'utf8');
    assert.equal(/rmSync|recursive: true[^}]*force|execSync\(|spawnSync\(/.test(source.replace(/mkdirSync\(dir, \{ recursive: true/, '')), false, 'nothing is removed recursively and no command is run');
  } finally { tree.cleanup(); }
});

test('rollover actions over HTTP: the same guard as every tier 1 action, Stop outside the lock, a refusal reaches the page with its reasons', async () => {
  const tree = tempTree();
  try {
    const env = setup(tree, ['a']);
    addRecords(tree, 'a');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runner = fakeRunner({ handle: async (file, args) => {
      if (args.includes('--apply')) { await gate; return { code: 0, stdout: fixture('verify-apply.txt'), stderr: '', timedOut: false, truncated: false }; }
      return undefined;
    } });
    const server = await startServer({ runner: runner.runner, rollover: env.rollover, switches: env.switches, toolRoot: env.toolRoot });
    try {
      assert.equal(server.api.ACTIONS['rollover-stop'].lock, false, 'Stop never waits behind another change');
      for (const name of ['rollover-arm', 'rollover-undo']) assert.equal(server.api.ACTIONS[name].tier, 1);
      const { post } = await client(server);
      const refused = await post('rollover-arm', { home: env.ids.a, kind: 'crew', ids: ['crew-a', 'codex-one'], confirm: armToken(env.ids.a, 'crew', ['crew-a', 'codex-one']) });
      assert.equal(refused.status, 409);
      assert.equal(refused.json.code, 'not_rolled');
      assert.deepEqual(refused.json.details, [{ id: 'codex-one', reason: 'harness' }]);
      assert.equal((await post('rollover-arm', { home: env.ids.a, kind: 'crew', ids: ['crew-a'], confirm: 'yes' })).json.code, 'confirm_required');
      assert.equal((await post('rollover-arm', { home: env.ids.a, kind: 'crew', ids: ['crew-a'] })).status, 400, 'a missing param');
      const ok = await post('rollover-arm', { home: env.ids.a, kind: 'crew', ids: ['crew-a'], confirm: armToken(env.ids.a, 'crew', ['crew-a']) });
      assert.equal(ok.status, 200);
      assert.equal(ok.raw.includes(tree.real), false);
      assert.equal(auditLines(env).find((line) => line.phase === 'intent').origin, server.origin, 'the audit names the request origin');
      // a slow tier 1 action is in flight: arm is told to wait, Stop and the read-only state are not
      const slow = post('verify-apply', { session: 'project-a', confirm: 'apply:project-a' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal((await post('rollover-undo', { home: env.ids.a, file: 'rollover-crew-live' })).json.code, 'busy');
      const stop = await post('rollover-stop', {});
      assert.equal(stop.status, 200);
      assert.equal(stop.json.data.homes[0].result, 'created');
      assert.equal((await post('rollover-state')).status, 200);
      release();
      assert.equal((await slow).status, 200);
    } finally { release(); await server.close(); }
  } finally { tree.cleanup(); }
});
