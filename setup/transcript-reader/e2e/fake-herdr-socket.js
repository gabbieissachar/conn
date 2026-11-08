#!/usr/bin/env node
'use strict';

// The fake Herdr's event stream: one unix socket for each fake Herdr session that answers `events.subscribe` as Herdr's does (the first
// line back is {"result": {"type": "subscription_started"}}, then {"event": "<kind>", "data": {"type": "<kind>", ...}} lines) and `ping`.
// It has no command that sends a key or a prompt, and reaches nothing real. Two uses:
//
//   as a module (tests):   const sockets = new FakeHerdrSockets(dir); sockets.start('esim'); sockets.emit('esim', 'pane.closed', { pane_id });
//                          sockets.lose('esim') sends an "events_lost" line, sockets.drop('esim') closes every subscriber's connection.
//   as a program (a lab):  node e2e/fake-herdr-socket.js <world.json> <socket folder>
//                          serves every session of the world (fake-herdr-world.js's file), writes each session's `socket` path into the world,
//                          and watches the world file: a pane that appears, goes, changes state or label, or gets the focus is announced as the
//                          event Herdr would send, within a few milliseconds of the file changing.

const fs = require('fs');
const net = require('net');
const path = require('path');

class FakeHerdrSockets {
  constructor(dir) {
    this.dir = dir;
    this.servers = new Map();  // name -> { server, path, conns: Set }
    this.requests = [];
  }

  start(name) {
    fs.mkdirSync(this.dir, { recursive: true });
    const socketPath = path.join(this.dir, name.replace(/[^A-Za-z0-9._-]/g, '_') + '.sock');
    try { fs.unlinkSync(socketPath); } catch { /* none there */ }
    const entry = { path: socketPath, conns: new Set(), subscribed: new Set(), server: null };
    entry.server = net.createServer((conn) => {
      entry.conns.add(conn);
      let buffer = '';
      conn.setEncoding('utf8');
      conn.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let request;
          try { request = JSON.parse(line); } catch { continue; }
          this.requests.push({ session: name, ...request });
          if (request.method === 'events.subscribe') { entry.subscribed.add(conn); conn.write(JSON.stringify({ id: request.id, result: { type: 'subscription_started' } }) + '\n'); }
          else if (request.method === 'ping') conn.write(JSON.stringify({ id: request.id, result: { type: 'pong' } }) + '\n');
        }
      });
      conn.on('close', () => { entry.conns.delete(conn); entry.subscribed.delete(conn); });
      conn.on('error', () => {});
    });
    this.servers.set(name, entry);
    return new Promise((resolve, reject) => { entry.server.once('error', reject); entry.server.listen(socketPath, () => resolve(socketPath)); });
  }

  socketPath(name) { return this.servers.get(name).path; }
  subscribers(name) { const entry = this.servers.get(name); return entry ? entry.subscribed.size : 0; }

  emit(name, kind, data = {}) {
    const entry = this.servers.get(name);
    if (!entry) return;
    const line = JSON.stringify({ event: kind, data: { type: kind, ...data } }) + '\n';
    for (const conn of entry.subscribed) { try { conn.write(line); } catch { /* a closed connection */ } }
  }

  lose(name) { this.emit(name, 'events_lost', { missed: 3 }); }

  drop(name) {
    const entry = this.servers.get(name);
    if (!entry) return;
    for (const conn of entry.conns) { try { conn.destroy(); } catch { /* already gone */ } }
    entry.conns.clear(); entry.subscribed.clear();
  }

  async stop() {
    for (const [name, entry] of this.servers) {
      this.drop(name);
      await new Promise((resolve) => entry.server.close(resolve));
      try { fs.unlinkSync(entry.path); } catch { /* gone */ }
    }
    this.servers.clear();
  }
}

// What a lab driver does: serve the world's sessions and announce each change of the world file the way Herdr would.
async function serveWorld(worldFile, dir) {
  const sockets = new FakeHerdrSockets(dir);
  const read = () => { try { return JSON.parse(fs.readFileSync(worldFile, 'utf8')); } catch { return null; } };
  let world = read();
  if (!world) throw new Error('no world at ' + worldFile);
  let changed = false;
  for (const session of world.sessions || []) {
    session.socket = await sockets.start(session.name);
    changed = true;
  }
  if (changed) { const partial = worldFile + '.sockets'; fs.writeFileSync(partial, JSON.stringify(world, null, 1)); fs.renameSync(partial, worldFile); }
  let known = JSON.stringify(world);
  const diff = (before, after) => {
    for (const session of after.sessions || []) {
      const old = (before.sessions || []).find((entry) => entry.name === session.name);
      const oldPanes = new Map(((old && old.panes) || []).map((pane) => [pane.pane_id, pane]));
      const newPanes = new Map((session.panes || []).map((pane) => [pane.pane_id, pane]));
      for (const [id, pane] of newPanes) {
        const was = oldPanes.get(id);
        if (!was) sockets.emit(session.name, 'pane.created', { pane_id: id, tab_id: pane.tab_id });
        else if (was.agent_status !== pane.agent_status) sockets.emit(session.name, 'pane.agent_status_changed', { pane_id: id, workspace_id: 'w1', agent_status: pane.agent_status || 'unknown' });
        else if (was.agent_session !== pane.agent_session || was.label !== pane.label || was.title !== pane.title || was.agent !== pane.agent) sockets.emit(session.name, 'pane.updated', { pane_id: id });
      }
      for (const id of oldPanes.keys()) if (!newPanes.has(id)) sockets.emit(session.name, 'pane.closed', { pane_id: id });
      if (old && old.focused !== session.focused && session.focused) sockets.emit(session.name, 'pane.focused', { pane_id: session.focused });
    }
  };
  const watcher = setInterval(() => {
    const next = read();
    if (!next) return;
    const text = JSON.stringify(next);
    if (text === known) return;
    diff(JSON.parse(known), next);
    known = text;
  }, 20);
  return { sockets, stop: async () => { clearInterval(watcher); await sockets.stop(); } };
}

if (require.main === module) {
  const [worldFile, dir] = process.argv.slice(2);
  if (!worldFile || !dir) { process.stderr.write('usage: fake-herdr-socket.js <world.json> <socket folder>\n'); process.exit(2); }
  serveWorld(path.resolve(worldFile), path.resolve(dir)).then((served) => {
    process.stdout.write(JSON.stringify({ ready: true, sockets: [...served.sockets.servers.keys()] }) + '\n');
    const stop = () => served.stop().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }, (error) => { process.stderr.write(String(error.message) + '\n'); process.exit(1); });
}

module.exports = { FakeHerdrSockets, serveWorld };
