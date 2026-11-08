'use strict';

// The pane watch against a fake Herdr that speaks events.subscribe over unix sockets (e2e/fake-herdr-socket.js). Run from the repo root:
//   node --test setup/transcript-reader/storeapi/herdr-watch.test.js
// Herdr's CLI is a fake runner over a world object; nothing real is read or sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPaneWatch } = require('./herdr-watch');
const { readSnapshot } = require('../api');
const { SESSION_NAME_RE } = require('../../herdr-organizer/adapter');
const { FakeHerdrSockets } = require('../e2e/fake-herdr-socket');

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const got = await check(); if (got) return got; await sleep(10); } assert.fail('timed out waiting for ' + what); };

async function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-watch-'));
  const sockets = new FakeHerdrSockets(dir);
  const socketPath = await sockets.start('work');
  const world = {
    sessions: [{ name: 'work', default: false, running: true, session_dir: dir, socket_path: socketPath }],
    focused: 'w1:p1',
    panes: [
      { pane_id: 'w1:p1', tab_id: 'w1:t1', label: 'alpha', agent: 'claude', agent_status: 'idle', agent_session: { value: A } },
      { pane_id: 'w1:p2', tab_id: 'w1:t2', label: 'beta', agent: 'claude', agent_status: 'working', agent_session: { value: B } },
    ],
    calls: [],
  };
  const runner = async (file, args) => {
    world.calls.push(args.join(' '));
    const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
    if (args[0] === 'session' && args[1] === 'list') return world.down ? { code: 1, stdout: '', stderr: 'down' } : ok({ sessions: world.sessions });
    if (args[2] === 'api' && args[3] === 'snapshot') return ok({ result: { snapshot: { focused_pane_id: world.focused, panes: world.panes, tabs: [] } } });
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const watch = createPaneWatch({ runner, readSnapshot, sessionNameOk: (name) => SESSION_NAME_RE.test(name), reconcileMs: 3600 * 1000, backoffMs: 20, idlePingMs: 60 * 1000 });
  const changes = [];
  watch.onChange((change) => changes.push(change));
  return { dir, sockets, world, watch, changes, reads: () => world.calls.filter((call) => call.includes('api snapshot')).length, done: async () => { watch.stop(); await sockets.stop(); } };
}

test('start reads every running named session once and subscribes to its socket', async () => {
  const l = await lab();
  try {
    await l.watch.start();
    const [session] = l.watch.sessions();
    assert.equal(session.name, 'work');
    assert.deepEqual(session.panes.map((pane) => [pane.pane_id, pane.session_id, pane.status, pane.label]), [['w1:p1', A, 'idle', 'alpha'], ['w1:p2', B, 'working', 'beta']]);
    assert.equal(session.focused, 'w1:p1');
    await until(() => l.sockets.subscribers('work') === 1, 'the subscription');
    assert.equal(l.sockets.requests.find((r) => r.method === 'events.subscribe').params.subscriptions.some((s) => s.type === 'pane.closed'), true);
  } finally { await l.done(); }
});

test('a status event is applied from the event itself, with no Herdr call', async () => {
  const l = await lab();
  try {
    await l.watch.start();
    await until(() => l.sockets.subscribers('work') === 1, 'the subscription');
    await sleep(80);  // the read that follows subscription_started
    const callsBefore = l.world.calls.length;
    l.sockets.emit('work', 'pane.agent_status_changed', { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' });
    await until(() => l.watch.sessions()[0].panes[0].status === 'working', 'the new status');
    assert.equal(l.world.calls.length, callsBefore, 'no Herdr call for a status event');
    assert.equal(l.changes.at(-1).kind, 'status');
    // The same status again is not a change.
    const version = l.watch.version;
    l.sockets.emit('work', 'pane.agent_status_changed', { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' });
    await sleep(60);
    assert.equal(l.watch.version, version);
  } finally { await l.done(); }
});

test('a focus event moves the focused pane at once', async () => {
  const l = await lab();
  try {
    await l.watch.start();
    await until(() => l.sockets.subscribers('work') === 1, 'the subscription');
    l.sockets.emit('work', 'pane.focused', { pane_id: 'w1:p2' });
    await until(() => l.watch.sessions()[0].focused === 'w1:p2', 'the new focus');
  } finally { await l.done(); }
});

test('a pane that is created or closed reads that one session again, once for a burst', async () => {
  const l = await lab();
  try {
    await l.watch.start();
    await until(() => l.sockets.subscribers('work') === 1, 'the subscription');
    await sleep(80);
    const before = l.reads();
    l.world.panes.push({ pane_id: 'w1:p3', tab_id: 'w1:t3', label: 'gamma', agent: 'claude', agent_status: 'idle', agent_session: { value: A } });
    l.sockets.emit('work', 'pane.created', { pane_id: 'w1:p3' });
    l.sockets.emit('work', 'tab.created', { tab_id: 'w1:t3' });
    l.sockets.emit('work', 'pane.updated', { pane_id: 'w1:p3' });
    await until(() => l.watch.sessions()[0].panes.length === 3, 'the new pane');
    assert.equal(l.reads() - before, 1, 'one read for the burst');
    l.world.panes = l.world.panes.filter((pane) => pane.pane_id !== 'w1:p1');
    l.sockets.emit('work', 'pane.closed', { pane_id: 'w1:p1' });
    await until(() => l.watch.sessions()[0].panes.length === 2, 'the closed pane to go');
    assert.equal(l.changes.filter((change) => change.kind === 'panes').length >= 2, true);
  } finally { await l.done(); }
});

test('a lost stream (an explicit events_lost, or the connection ending) reads the inventory again and subscribes again', async () => {
  const l = await lab();
  try {
    await l.watch.start();
    await until(() => l.sockets.subscribers('work') === 1, 'the subscription');
    await sleep(80);
    let before = l.reads();
    l.world.panes[0].agent_status = 'blocked';   // changed while "events were lost"
    l.sockets.lose('work');
    await until(() => l.watch.sessions()[0].panes[0].status === 'blocked', 'the inventory read after events_lost');
    assert.ok(l.reads() > before);
    await until(() => l.sockets.subscribers('work') === 1 && l.sockets.requests.filter((r) => r.method === 'events.subscribe').length >= 2, 'a second subscription');
    // The connection dropping is the same.
    before = l.reads();
    l.world.panes[0].agent_status = 'done';
    l.sockets.drop('work');
    await until(() => l.watch.sessions()[0].panes[0].status === 'done', 'the inventory read after a dropped connection');
    await until(() => l.sockets.requests.filter((r) => r.method === 'events.subscribe').length >= 3, 'a third subscription');
    assert.ok(l.watch.stats().lost >= 2);
  } finally { await l.done(); }
});

test('a Herdr session that is restarted (a new socket) is subscribed again at the new socket; one that goes is dropped', async () => {
  const l = await lab();
  try {
    await l.watch.start();
    await until(() => l.sockets.subscribers('work') === 1, 'the subscription');
    // Herdr restarted: the old socket is gone, a new one listens, and the list names it.
    l.sockets.drop('work');
    await l.sockets.stop();
    const again = new FakeHerdrSockets(path.join(l.dir, 'second'));
    const second = await again.start('work');
    l.world.sessions[0].socket_path = second;
    await until(() => again.subscribers('work') === 1, 'the subscription at the new socket', 5000);
    again.emit('work', 'pane.agent_status_changed', { pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'done' });
    await until(() => l.watch.sessions()[0].panes[1].status === 'done', 'an event from the new socket');
    // The session stops running: dropped on the next reconcile.
    l.world.sessions[0].running = false;
    await l.watch.reconcile();
    assert.deepEqual(l.watch.sessions(), []);
    await again.stop();
  } finally { await l.done(); }
});

test('Herdr not answering leaves what is held (it says nothing about panes); the default session and odd names are never read', async () => {
  const l = await lab();
  try {
    l.world.sessions.push({ name: 'default', default: true, running: true, session_dir: l.dir, socket_path: '/nowhere' }, { name: '-h', default: false, running: true, session_dir: l.dir, socket_path: '/nowhere' });
    await l.watch.start();
    assert.deepEqual(l.watch.sessions().map((s) => s.name), ['work']);
    l.world.down = true;
    assert.equal(await l.watch.reconcile(), false);
    assert.equal(l.watch.sessions().length, 1);
    assert.equal(l.world.calls.some((call) => call.includes('--session default') || call.includes('--session -h')), false);
  } finally { await l.done(); }
});

test('a Herdr that answers no read-only call with anything but reads: the watch never sends a key, a prompt or a close', async () => {
  const l = await lab();
  try {
    await l.watch.start();
    l.sockets.emit('work', 'pane.closed', { pane_id: 'w1:p1' });
    await sleep(100);
    assert.equal(l.world.calls.every((call) => /^(session list --json|--session work api snapshot)$/.test(call)), true, l.world.calls.join('|'));
    assert.equal(l.sockets.requests.every((r) => r.method === 'events.subscribe' || r.method === 'ping'), true);
  } finally { await l.done(); }
});
