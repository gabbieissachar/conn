'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { tempTree, startServer, client } = require('./helpers');
const { createRollover, RolloverConfigError, psIdentity, defaultLabels } = require('../rollover');

const NOW = new Date('2026-10-26T12:00:00Z');
const IDENTITY = 'Mon Oct 26 09:00:00 2026     bash /code/bin/fm-watch.sh';
const ROLLER_ALL = ['rollover-live', 'rollover-crew-live', 'rollover-off', 'rollover-primary-live', 'rollover-primary-off'].map((name) => `[ -e "$CONFIG/${name}" ]`).join('\n');

function touch(file, secondsAgo) {
  const when = new Date(NOW.getTime() - secondsAgo * 1000);
  fs.utimesSync(file, when, when);
}

// A firstmate home on disk: state/, data/, config/, and a watcher lock whose owner folder holds the four files firstmate writes.
function makeHome(tree, name, { lock = true, roller = ROLLER_ALL, beatAge = 20, lockHome, pid = process.pid, identity = IDENTITY, secondmate = false } = {}) {
  const home = tree.mkdir(`${name}/home`);
  tree.mkdir(`${name}/home/state`);
  tree.mkdir(`${name}/home/data`);
  tree.mkdir(`${name}/home/config`);
  tree.write(`${name}/home/state/.lock-session`, 'abc\n');
  if (secondmate) tree.write(`${name}/home/.fm-secondmate-home`, 'x\n');
  const code = tree.mkdir(`${name}/code/bin`);
  tree.write(`${name}/code/bin/fm-watch.sh`, '#!/bin/bash\n');
  tree.write(`${name}/code/bin/fm-rollover.sh`, roller);
  if (lock) {
    const owner = `${name}/home/state/.watch.lock.owner.AbC123`;
    tree.write(`${owner}/pid`, `${pid}\n`);
    tree.write(`${owner}/fm-home`, `${lockHome === undefined ? tree.real + '/' + name + '/home' : lockHome}\n`);
    tree.write(`${owner}/watcher-path`, `${tree.real}/${name}/code/bin/fm-watch.sh\n`);
    tree.write(`${owner}/pid-identity`, `${identity}\n`);
    tree.link(`${name}/home/state/.watch.lock`, path.join(tree.real, name, 'home/state/.watch.lock.owner.AbC123'));
    const beat = tree.write(`${name}/home/state/.last-watcher-beat`, '');
    touch(beat, beatAge);
  }
  return { home: path.join(tree.real, name, 'home'), code, owner: lock ? tree.abs(`${name}/home/state/.watch.lock.owner.AbC123`) : null };
}

const options = (extra = {}) => ({ now: () => NOW, identityOf: () => IDENTITY, pidAlive: () => true, platform: 'darwin', ...extra });
const view = (tree, homes, extra = {}) => createRollover({ env: { HERDR_ORGANIZER_ROLLOVER_HOMES: homes }, homedir: path.join(tree.real, 'nohome'), ...options(extra) }).state();

test('rollover registry: labels, ids and the refusals that stop the server from starting', () => {
  assert.deepEqual(defaultLabels(['/h/fm-homes/pmos', '/h/.treehouse/firstmate-8bf1b0/2/firstmate', '/h/.treehouse/firstmate-8bf1b0/3/firstmate']), ['fm-homes/pmos', 'firstmate-8bf1b0/2', 'firstmate-8bf1b0/3']);
  assert.deepEqual(defaultLabels(['/a/x/home', '/b/x/home']), ['a/x/home', 'b/x/home'], 'two homes with the same last two segments get longer tails');
  const tree = tempTree();
  try {
    const one = makeHome(tree, 'one');
    const two = makeHome(tree, 'two');
    const sep = path.delimiter;
    const state = view(tree, `${one.home}${sep}ops=${two.home}`);
    assert.equal(state.homes.length, 2);
    assert.equal(state.homes[1].label, 'ops');
    assert.match(state.homes[0].id, /^h[0-9a-f]{8}$/);
    assert.notEqual(state.homes[0].id, state.homes[1].id);
    assert.throws(() => view(tree, `a=${one.home}${sep}a=${two.home}`), RolloverConfigError, 'two homes with one label');
    assert.throws(() => view(tree, `${one.home}${sep}${one.home}`), RolloverConfigError, 'the same home twice');
    assert.throws(() => view(tree, 'relative/path'), RolloverConfigError, 'a relative path');
    assert.throws(() => view(tree, `bad;label=${one.home}`), RolloverConfigError, 'a label outside the allowed characters');
    assert.throws(() => view(tree, `${'x'.repeat(41)}=${one.home}`), RolloverConfigError, 'a label over 40 characters');
    const unset = createRollover({ env: {}, homedir: '/h', ...options() });
    assert.equal(unset.homes.length, 1, 'with no list, exactly one home');
    assert.equal(unset.homes[0].label, 'fm-homes/pmos');
    assert.equal(createRollover({ env: { HERDR_ORGANIZER_FM_HOME: one.home }, homedir: '/h', ...options() }).homes.length, 1);
  } finally { tree.cleanup(); }
});

test('rollover home checks: missing, swapped for a link, state or data a link, and not a firstmate home', () => {
  const tree = tempTree();
  try {
    const good = makeHome(tree, 'good');
    assert.equal(view(tree, good.home).homes[0].status, 'ok');
    assert.equal(view(tree, tree.abs('nowhere')).homes[0].status, 'missing');
    // The registered realpath is fixed at start; a link put there afterwards is refused.
    const rollover = createRollover({ env: { HERDR_ORGANIZER_ROLLOVER_HOMES: good.home }, homedir: '/h', ...options() });
    const other = makeHome(tree, 'other');
    fs.renameSync(good.home, good.home + '.moved');
    fs.symlinkSync(other.home, good.home);
    try { assert.equal(rollover.state().homes[0].status, 'swapped'); } finally { fs.unlinkSync(good.home); fs.renameSync(good.home + '.moved', good.home); }
    const linked = makeHome(tree, 'linked', { lock: false });
    fs.renameSync(path.join(linked.home, 'data'), path.join(linked.home, 'data.real'));
    fs.symlinkSync(path.join(linked.home, 'data.real'), path.join(linked.home, 'data'));
    try { assert.equal(view(tree, linked.home).homes[0].status, 'unsafe', 'data is a link'); } finally { fs.unlinkSync(path.join(linked.home, 'data')); fs.renameSync(path.join(linked.home, 'data.real'), path.join(linked.home, 'data')); }
    const bare = tree.mkdir('bare/home');
    tree.mkdir('bare/home/state');
    tree.mkdir('bare/home/data');
    assert.equal(view(tree, bare).homes[0].status, 'not_firstmate_home');
    const second = makeHome(tree, 'second', { lock: false, secondmate: true });
    fs.unlinkSync(path.join(second.home, 'state', '.lock-session'));
    assert.equal(view(tree, second.home).homes[0].status, 'ok', 'a second-mate home is known by .fm-secondmate-home');
    assert.equal(view(tree, second.home).homes[0].is_secondmate_home, true);
    // A refused home reads nothing else.
    assert.deepEqual(Object.keys(view(tree, bare).homes[0]).sort(), ['id', 'label', 'status']);
  } finally { tree.cleanup(); }
});

test('rollover watcher: the same checks fm_watcher_healthy makes, each failure with its own name', () => {
  const tree = tempTree();
  try {
    const watcherOf = (name, config, extra) => view(tree, makeHome(tree, name, config).home, extra).homes[0].watcher;
    assert.equal(watcherOf('ok', {}), 'running');
    assert.equal(watcherOf('nolock', { lock: false }), 'no_lock');
    assert.equal(watcherOf('dead', {}, { pidAlive: () => false }), 'stale_pid');
    assert.equal(watcherOf('othername', { lockHome: '/somewhere/else' }), 'other_home');
    assert.equal(watcherOf('ident', {}, { identityOf: () => 'a different process' }), 'identity_mismatch');
    assert.equal(watcherOf('oldbeat', { beatAge: 301 }), 'beat_old');
    assert.equal(watcherOf('freshbeat', { beatAge: 299 }), 'running');
    assert.equal(watcherOf('linux', {}, { platform: 'linux' }), 'identity_unverifiable', 'only macOS identity is reproduced');
    // The lock holds the raw $FM_HOME: a trailing slash or a link in its spelling is still this home (R5-4).
    const slash = makeHome(tree, 'slash', { lockHome: tree.real + '/slash/home/' });
    assert.equal(view(tree, slash.home).homes[0].watcher, 'running');
    fs.symlinkSync(path.join(tree.real, 'slash/home'), path.join(tree.real, 'slash/alias'));
    try {
      fs.writeFileSync(path.join(slash.owner, 'fm-home'), path.join(tree.real, 'slash/alias') + '\n');
      assert.equal(view(tree, slash.home).homes[0].watcher, 'running', 'a spelling through a link');
    } finally { fs.unlinkSync(path.join(tree.real, 'slash/alias')); fs.writeFileSync(path.join(slash.owner, 'fm-home'), tree.real + '/slash/home/\n'); }
    // A roller file newer than the watcher's start changes nothing (R5-4): the roller is a new process each pass.
    const roller = path.join(tree.real, 'slash/code/bin/fm-rollover.sh');
    const later = new Date(NOW.getTime() + 3600 * 1000);
    fs.utimesSync(roller, later, later);
    const after = view(tree, slash.home).homes[0];
    assert.equal(after.watcher, 'running');
    assert.equal(JSON.stringify(after).includes('code_changed'), false);
  } finally { tree.cleanup(); }
});

test('rollover watcher: an unsafe lock is named, never followed out of state/', () => {
  const tree = tempTree();
  try {
    const watcherOf = (home) => view(tree, home).homes[0].watcher;
    // A real folder in place of the link.
    const folder = makeHome(tree, 'folder', { lock: false });
    tree.mkdir('folder/home/state/.watch.lock');
    assert.equal(watcherOf(folder.home), 'unsafe_lock');
    // A link to a folder outside state/.
    const out = makeHome(tree, 'out', { lock: false });
    tree.mkdir('elsewhere/.watch.lock.owner.X');
    fs.symlinkSync(path.join(tree.real, 'elsewhere/.watch.lock.owner.X'), path.join(out.home, 'state/.watch.lock'));
    assert.equal(watcherOf(out.home), 'unsafe_lock');
    // A link to a folder under state/ with the wrong name.
    const named = makeHome(tree, 'named', { lock: false });
    tree.mkdir('named/home/state/some-folder');
    fs.symlinkSync(path.join(named.home, 'state/some-folder'), path.join(named.home, 'state/.watch.lock'));
    assert.equal(watcherOf(named.home), 'unsafe_lock');
    // A lock file that is a link, one over 1 KB, and a pid that is not digits.
    for (const [name, mutate] of [
      ['linkfile', (owner) => { fs.unlinkSync(path.join(owner, 'pid')); fs.symlinkSync('/etc/hostname', path.join(owner, 'pid')); }],
      ['bigfile', (owner) => fs.writeFileSync(path.join(owner, 'pid-identity'), 'x'.repeat(2000))],
      ['badpid', (owner) => fs.writeFileSync(path.join(owner, 'pid'), '12 34\n')],
    ]) {
      const made = makeHome(tree, name);
      mutate(made.owner);
      assert.equal(watcherOf(made.home), 'unsafe_lock', name);
    }
    // A watcher-path that is not bin/fm-watch.sh names no code root.
    const odd = makeHome(tree, 'odd');
    fs.writeFileSync(path.join(odd.owner, 'watcher-path'), path.join(tree.real, 'odd/code/bin/fm-rollover.sh') + '\n');
    assert.equal(watcherOf(odd.home), 'unsafe_lock');
  } finally { tree.cleanup(); }
});

test('rollover capability and code root come from the home\'s own watcher, never a default', () => {
  const tree = tempTree();
  try {
    const noCrew = ROLLER_ALL.split('\n').filter((line) => !line.includes('rollover-crew-live')).join('\n') + '\n# rollover-crew-live is only a comment here\n';
    const made = makeHome(tree, 'legacy', { roller: noCrew });
    const home = view(tree, made.home).homes[0];
    const byName = Object.fromEntries(home.files.map((entry) => [entry.name, entry]));
    assert.equal(byName['rollover-crew-live'].capability, 'not_read', 'a comment is not a read');
    assert.equal(byName['rollover-live'].capability, 'read');
    assert.equal(home.effective.crew, null, 'a file the home\'s code does not read gets no effective sentence');
    assert.match(home.effective.second_mates, /dry-run/);
    // A home whose watcher is not running has no capability and no effective sentence.
    const dead = view(tree, makeHome(tree, 'dead', {}).home, { pidAlive: () => false }).homes[0];
    assert.equal(dead.effective, null);
    assert.equal(dead.files.every((entry) => entry.capability === undefined), true);
    // The roller read is the one two folders above watcher-path: swap the file under another code root and the answer follows it.
    const swapped = makeHome(tree, 'swapped', { roller: 'nothing here\n' });
    assert.equal(view(tree, swapped.home).homes[0].files.every((entry) => entry.capability === 'not_read'), true);
  } finally { tree.cleanup(); }
});

test('rollover switch files: state per file, listed-id counts and firstmate\'s own sentences', () => {
  const tree = tempTree();
  try {
    const made = makeHome(tree, 'sw');
    const config = path.join(made.home, 'config');
    const files = (extra) => Object.fromEntries(view(tree, made.home, extra).homes[0].files.map((entry) => [entry.name, entry]));
    const states = files();
    assert.equal(Object.values(states).every((entry) => entry.state === 'absent'), true);
    // regular, with comments, blanks and spaces inside a line (firstmate strips all whitespace)
    fs.writeFileSync(path.join(config, 'rollover-live'), '# created by someone\n\n  a b \nsecond\n   \n#c\n');
    fs.writeFileSync(path.join(config, 'rollover-crew-live'), '# only a comment\n');
    fs.symlinkSync('/nowhere/at/all', path.join(config, 'rollover-primary-live'));
    fs.mkdirSync(path.join(config, 'rollover-off'));
    const some = files();
    assert.equal(some['rollover-live'].state, 'regular');
    assert.equal(some['rollover-live'].ids_count, 2);
    assert.equal(some['rollover-crew-live'].ids_count, 0);
    assert.equal(some['rollover-primary-live'].state, 'symlink', 'a dangling link counts as present, and as a link');
    assert.equal(some['rollover-off'].state, 'not_regular');
    assert.equal(typeof some['rollover-live'].age_seconds, 'number');
    const sentences = view(tree, made.home).homes[0].effective;
    assert.match(sentences.second_mates, /^second mates: off: config\/rollover-off is present/, 'any presence of the off file wins, even a folder');
    fs.rmdirSync(path.join(config, 'rollover-off'));
    const live = view(tree, made.home).homes[0].effective;
    assert.equal(live.second_mates, 'second mates: live for 2 listed; every other one is dry-run');
    assert.equal(live.crew, 'crewmates and scouts: live for every eligible one');
    assert.match(live.primary, /dry-run/, 'a link is not a primary live file');
    assert.equal(JSON.stringify(live).includes('second'), true);
    assert.equal(/\ba\b|\bab\b/.test(live.second_mates), false, 'the ids themselves are not in the sentence');
    fs.unlinkSync(path.join(config, 'rollover-primary-live'));
    fs.writeFileSync(path.join(config, 'rollover-primary-live'), '');
    assert.match(view(tree, made.home).homes[0].effective.primary, /live once it has registered/);
    fs.writeFileSync(path.join(config, 'rollover-primary-off'), '');
    assert.match(view(tree, made.home).homes[0].effective.primary, /off/);
    // An unreadable regular file is reported as such.
    if (process.getuid && process.getuid() !== 0) {
      fs.chmodSync(path.join(config, 'rollover-live'), 0o000);
      try { assert.equal(files()['rollover-live'].state, 'unreadable'); } finally { fs.chmodSync(path.join(config, 'rollover-live'), 0o644); }
    }
    // A config folder that is missing or a link.
    const bare = makeHome(tree, 'bare');
    fs.rmdirSync(path.join(bare.home, 'config'));
    assert.equal(view(tree, bare.home).homes[0].config, 'missing');
    assert.equal(view(tree, bare.home).homes[0].files, undefined);
    fs.symlinkSync(made.home, path.join(bare.home, 'config'));
    assert.equal(view(tree, bare.home).homes[0].config, 'unsafe');
  } finally { tree.cleanup(); }
});

test('rollover ids: every id that cannot roll now carries the roller\'s own reason', () => {
  const tree = tempTree();
  try {
    const made = makeHome(tree, 'ids', { secondmate: false });
    const state = path.join(made.home, 'state');
    const meta = (id, fields) => tree.write(`ids/home/state/${id}.meta`, Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    const worktree = tree.mkdir('ids/worktree');
    const brief = (id) => tree.write(`ids/home/data/${id}/brief.md`, 'brief\n');
    const seeded = tree.mkdir('ids/sm-home');
    tree.write('ids/sm-home/.fm-secondmate-home', 'sm-ok\n');
    const wrongSeed = tree.mkdir('ids/sm-other');
    tree.write('ids/sm-other/.fm-secondmate-home', 'someone-else\n');
    meta('sm-ok', { kind: 'secondmate', harness: 'claude', home: seeded });
    meta('sm-wrong', { kind: 'secondmate', harness: 'claude', home: wrongSeed });
    meta('sm-nohome', { kind: 'secondmate', harness: 'claude' });
    meta('sm-codex', { kind: 'secondmate', harness: 'codex', home: seeded });
    meta('sm-remote', { kind: 'secondmate', harness: 'claude', remote_host: 'box', home: seeded });
    meta('crew-ok', { kind: 'ship', harness: 'claude-opus', worktree });
    brief('crew-ok');
    meta('crew-nokind', { harness: 'claude', worktree });
    brief('crew-nokind');
    meta('crew-nobrief', { kind: 'scout', harness: 'claude', worktree });
    meta('crew-noworktree', { kind: 'ship', harness: 'claude', worktree: '/does/not/exist' });
    meta('primary', { kind: 'ship', harness: 'claude', worktree });
    meta('crew-other', { kind: 'primary', harness: 'claude', worktree });
    tree.write('ids/target.meta', 'kind=ship\n');
    fs.symlinkSync(path.join(tree.real, 'ids/target.meta'), path.join(state, 'crew-link.meta'));
    tree.write('ids/home/state/has space.meta', 'kind=ship\n');
    tree.write('ids/home/state/old.meta.retired-slot-reused', 'kind=ship\n');
    const ids = view(tree, made.home).homes[0].ids;
    const reasons = (list) => Object.fromEntries(list.list.map((item) => [item.id, item.ok ? 'ok' : item.reason]));
    assert.deepEqual(reasons(ids.second_mates), { 'sm-codex': 'harness', 'sm-nohome': 'home_unseeded', 'sm-ok': 'ok', 'sm-remote': 'remote', 'sm-wrong': 'home_unseeded' });
    assert.deepEqual(reasons(ids.crew), { 'crew-link': 'symlink', 'crew-nobrief': 'no_brief', 'crew-nokind': 'ok', 'crew-noworktree': 'no_worktree', 'crew-ok': 'ok', primary: 'reserved' });
    assert.equal(JSON.stringify(ids).includes('has space'), false, 'a name outside the pattern never appears');
    assert.equal(JSON.stringify(ids).includes('retired'), false);
    assert.equal(JSON.stringify(ids).includes('crew-other'), false, 'a kind the roller does not roll is not listed');
  } finally { tree.cleanup(); }
});

test('rollover-state reads only: no file is created, changed or removed, and no path or lock text leaves the server', () => {
  const tree = tempTree();
  try {
    const made = makeHome(tree, 'quiet');
    fs.writeFileSync(path.join(made.home, 'config', 'rollover-live'), 'one\n');
    const snapshot = () => {
      const out = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(dir, entry.name);
          const info = fs.lstatSync(full);
          out.push([full, info.mode, info.size, info.mtimeMs, info.ino].join(' '));
          if (entry.isDirectory()) walk(full);
        }
      };
      walk(tree.real);
      return out.join('\n');
    };
    const before = snapshot();
    const text = JSON.stringify(view(tree, made.home));
    assert.equal(snapshot(), before, 'the tree is byte-for-byte unchanged, mtimes included');
    assert.equal(text.includes(tree.real), false, 'no private path');
    assert.equal(text.includes('fm-watch'), false);
    assert.equal(text.includes('AbC123'), false, 'no lock owner folder name');
    assert.equal(text.includes('Oct 26'), false, 'no process identity');
    const source = fs.readFileSync(path.join(__dirname, '..', 'rollover.js'), 'utf8');
    assert.equal(/\b(writeFile|appendFile|unlink|rmdir|rm|mkdir|rename|symlink|link|chmod|chown|truncate|copyFile|utimes)(Sync)?\(/.test(source), false, 'the module calls no filesystem write');
    assert.equal(/O_WRONLY|O_RDWR|O_CREAT/.test(source), false);
  } finally { tree.cleanup(); }
});

test('rollover counts the firstmate homes it does not cover, without naming them', () => {
  const tree = tempTree();
  try {
    const made = makeHome(tree, 'mine');
    tree.mkdir('h/.treehouse/firstmate-aaaaaa/1/firstmate');
    tree.mkdir('h/.treehouse/firstmate-aaaaaa/2/firstmate');
    tree.mkdir('h/.treehouse/firstmate-aaaaaa/3/other');
    tree.mkdir('h/.treehouse/personal-bbbbbb/1/firstmate');
    tree.mkdir('h/fm-homes/pmos');
    const rollover = createRollover({ env: { HERDR_ORGANIZER_ROLLOVER_HOMES: `${made.home}${path.delimiter}${path.join(tree.real, 'h/fm-homes/pmos')}` }, homedir: path.join(tree.real, 'h'), ...options() });
    const state = rollover.state();
    assert.equal(state.unregistered_homes, 2, 'two second-mate homes are not registered; the registered fm-homes one is not counted');
    assert.equal(JSON.stringify(state).includes('aaaaaa'), false);
  } finally { tree.cleanup(); }
});

test('rollover identity is what fm_pid_identity prints for the same process', { skip: process.platform !== 'darwin' }, async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const viaShell = execFileSync('bash', ['-c', `out=$(COLUMNS=10000 LC_ALL=C ps -p ${child.pid} -o lstart= -o command= 2>/dev/null) || exit 1; printf '%s\\n' "$out" | sed 's/^[[:space:]]*//'`], { encoding: 'utf8' }).replace(/\n+$/, '');
    assert.equal(psIdentity(child.pid), viaShell);
    assert.match(viaShell, /sleep 30$/);
    assert.equal(psIdentity(99999999), null, 'a process that is gone has no identity');
  } finally { child.kill(); }
});

test('rollover-state: a tier 0 action with no params, served to the page with the same guard as the rest', async () => {
  const tree = tempTree();
  try {
    const made = makeHome(tree, 'api');
    const rollover = createRollover({ env: { HERDR_ORGANIZER_ROLLOVER_HOMES: `mine=${made.home}` }, homedir: path.join(tree.real, 'h'), ...options() });
    const server = await startServer({ rollover });
    try {
      assert.equal(server.api.ACTIONS['rollover-state'].tier, 0);
      const { post } = await client(server);
      const response = await post('rollover-state');
      assert.equal(response.status, 200);
      assert.equal(response.json.data.homes[0].label, 'mine');
      assert.equal(response.json.data.homes[0].watcher, 'running');
      assert.equal(response.raw.includes(tree.real), false);
      assert.equal((await post('rollover-state', { home: 'x' })).status, 400, 'it takes no params');
      assert.equal((await post('rollover-state', undefined, { Origin: 'http://evil.example' })).status, 403, 'a foreign origin is refused');
    } finally { await server.close(); }
  } finally { tree.cleanup(); }
});
