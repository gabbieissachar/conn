'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

module.exports = { NOW, IDENTITY, ROLLER_ALL, touch, makeHome };
