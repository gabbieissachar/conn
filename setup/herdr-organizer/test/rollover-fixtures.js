'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NOW = new Date('2026-10-26T12:00:00Z');
const IDENTITY = 'Mon Oct 26 09:00:00 2026     bash /code/bin/fm-watch.sh';
const ROLLER_ALL = ['rollover-live', 'rollover-crew-live', 'rollover-off', 'rollover-primary-live', 'rollover-primary-off'].map((name) => `[ -e "$CONFIG/${name}" ]`).join('\n');

// Every fixture home gets its own fake pid, and the identity of that pid names that home's watcher script, as firstmate's does.
const IDENTITIES = new Map();
let nextPid = 4000000;
const identityOf = (pid) => IDENTITIES.get(pid) || IDENTITY;

function touch(file, secondsAgo) {
  const when = new Date(NOW.getTime() - secondsAgo * 1000);
  fs.utimesSync(file, when, when);
}

// A firstmate home on disk: state/, data/, config/, and a watcher lock whose owner folder holds the four files firstmate writes.
function makeHome(tree, name, { lock = true, roller = ROLLER_ALL, beatAge = 20, lockHome, pid = (nextPid += 1), identity, secondmate = false } = {}) {
  const home = tree.mkdir(`${name}/home`);
  tree.mkdir(`${name}/home/state`);
  tree.mkdir(`${name}/home/data`);
  tree.mkdir(`${name}/home/config`);
  tree.write(`${name}/home/state/.lock-session`, 'abc\n');
  if (secondmate) tree.write(`${name}/home/.fm-secondmate-home`, 'x\n');
  const code = tree.mkdir(`${name}/code/bin`);
  tree.write(`${name}/code/bin/fm-watch.sh`, '#!/bin/bash\n');
  tree.write(`${name}/code/bin/fm-rollover.sh`, roller);
  const watcherPath = `${tree.real}/${name}/code/bin/fm-watch.sh`;
  const identityText = identity === undefined ? `Mon Oct 26 09:00:00 2026     bash ${watcherPath}` : identity;
  IDENTITIES.set(pid, identityText);
  if (lock) {
    const owner = `${name}/home/state/.watch.lock.owner.AbC123`;
    tree.write(`${owner}/pid`, `${pid}\n`);
    tree.write(`${owner}/fm-home`, `${lockHome === undefined ? tree.real + '/' + name + '/home' : lockHome}\n`);
    tree.write(`${owner}/watcher-path`, `${watcherPath}\n`);
    tree.write(`${owner}/pid-identity`, `${identityText}\n`);
    tree.link(`${name}/home/state/.watch.lock`, path.join(tree.real, name, 'home/state/.watch.lock.owner.AbC123'));
    const beat = tree.write(`${name}/home/state/.last-watcher-beat`, '');
    touch(beat, beatAge);
  }
  return { home: path.join(tree.real, name, 'home'), code, owner: lock ? tree.abs(`${name}/home/state/.watch.lock.owner.AbC123`) : null };
}

// A stand-in for firstmate's `fm-rollover.sh`: it names the switch files on code lines (so the capability text check passes),
// has a `check)` branch, logs how it was called, and answers by the end of the id.
const ROLLER_STUB = `#!/bin/bash
: rollover-live rollover-crew-live rollover-off rollover-primary-live rollover-primary-off
printf '%s|%s|%s|%s|%s|%s\\n' "$PWD" "$FM_HOME" "\${FM_STATE_OVERRIDE-unset}" "\${FM_ROOT_OVERRIDE-unset}" "\${GIT_OPTIONAL_LOCKS-}" "$*" >> "$FM_HOME/../calls.log"
id=$2
case "$1" in
  check)
    case "$id" in
      *-ok) echo "eligible: context 41% (90000 of 200000 tokens), idle, nothing in flight (dry-run: config/rollover-crew-live does not cover it)"; exit 0 ;;
      *-covered) echo "eligible: context 41% (90000 of 200000 tokens), idle, nothing in flight"; exit 0 ;;
      *-low) echo "ineligible: context 12% of its 200000 window is below the 30% threshold"; exit 1 ;;
      *-uuid) echo "ineligible: no gauge record for session 0f1e2d3c-4b5a-4968-8777-665544332211 under /Users/someone/private, so its context is unknown"; exit 1 ;;
      *-skip) echo "skip: only Claude sessions roll for now; 'codex' is deferred"; exit 1 ;;
      *-off) echo "off: config/rollover-off is present"; exit 1 ;;
      *-slow) exec sleep 5 ;;
      *-junk) echo "something unexpected"; exit 2 ;;
    esac ;;
esac
`;

module.exports = { NOW, IDENTITY, identityOf, ROLLER_ALL, ROLLER_STUB, touch, makeHome };
