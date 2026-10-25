#!/usr/bin/env node
'use strict';

// Starts the app: node main.js. Settings come from the environment (config.js). Objects go to
// Replit Object Storage, or to the folder OBJECT_STORE_DIR names for a run on a laptop.

const http = require('http');
const { loadConfig } = require('./config');
const { createHandler } = require('./app');
const { OidcClient } = require('./oidc');
const { fileStore, replitStore } = require('./store');

function main(env = process.env) {
  const config = loadConfig(env);
  const store = env.OBJECT_STORE_DIR ? fileStore(env.OBJECT_STORE_DIR) : replitStore();
  const oidc = new OidcClient({ issuer: config.issuer, clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri });
  const server = http.createServer(createHandler({ config, store, oidc, log: (line) => console.log(line) }));
  const port = Number(env.PORT) || 3000;
  server.listen(port, env.HOST || '0.0.0.0', () => console.log(`Transcript reader listening on port ${port}`));
  return server;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { main };
