#!/usr/bin/env node
'use strict';

// Manage the laptop's upload keys from the Replit shell (or a laptop run with OBJECT_STORE_DIR).
//
//   node keys-cli.js create [label]   makes a key and prints it once; only its hash is stored
//   node keys-cli.js list             ids, labels and dates, never keys
//   node keys-cli.js revoke <id>      the key stops working at once

const keys = require('./keys');
const { fileStore, replitStore } = require('./store');

async function main(argv, env = process.env, out = (line) => console.log(line)) {
  const store = env.OBJECT_STORE_DIR ? fileStore(env.OBJECT_STORE_DIR) : replitStore();
  const [command, arg] = argv;
  if (command === 'create') {
    const { key, id, label } = await keys.create(store, arg);
    out(`Key ${id} (${label}). Copy it now; it is not shown again:`);
    out(key);
    return 0;
  }
  if (command === 'list') {
    for (const item of await keys.list(store)) out(`${item.id}  ${item.label}  created ${new Date(item.created * 1000).toISOString()}${item.revoked ? '  REVOKED' : ''}`);
    return 0;
  }
  if (command === 'revoke' && arg) {
    out(await keys.revoke(store, arg) ? `Revoked ${arg}.` : `No live key ${arg}.`);
    return 0;
  }
  out('usage: node keys-cli.js create [label] | list | revoke <id>');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exit(1); });
}

module.exports = { main };
