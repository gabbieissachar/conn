'use strict';

// Tests for Claude's permission asks in the reader: the broker (permissions.js), its routes in api.js, and the hook command (hooks/permission-hook.py).
// Run from the repo root:  node --test setup/transcript-reader/permissions.test.js
// Herdr is faked, no Claude runs, and every file is in a temporary folder: no real pane, session, settings.json or port is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const permissionsLib = require('./permissions');
const { create, TOKEN_HEADER, TOKEN_META } = require('./api');

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';
const HOOK = path.join(__dirname, 'hooks', 'permission-hook.py');

const payload = (overrides = {}) => ({
  session_id: A, cwd: '/work/alpha', permission_mode: 'default', hook_event_name: 'PermissionRequest',
  tool_name: 'Bash', tool_input: { command: 'touch permission-probe.txt', description: 'Make the probe file' }, ...overrides,
});

// ------------------------------------------------------------------------------------------------------------------------ the broker

function broker(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-permissions-'));
  let clock = 1_800_000_000_000;
  const closing = [];
  const status = { value: 'blocked' };
  const log = { value: 'unknown' };
  const perms = permissionsLib.create({
    now: () => clock, enabled: true, file: path.join(dir, 'asks.json'), hookFile: path.join(dir, 'hook.json'),
    listed: () => [A, B], paneStatus: async () => status.value, logState: async () => log.value, needPage: false, waitMs: 60_000, sweepMs: 0, ...extra,
  });
  // a hook call: the connection can be ended to stand for the hook process being killed
  const call = (body = payload()) => {
    let end = () => {};
    const connection = { onClose: (fn) => { end = fn; } };
    const answer = perms.ask(body, connection);
    closing.push(end);
    return { answer, hangUp: () => end() };
  };
  return { perms, dir, call, status, log, tick: (ms) => { clock += ms; }, file: path.join(dir, 'asks.json') };
}
const openOf = (b) => b.perms.list(A).asks.find((ask) => ask.state === 'open');

test('broker: an ask is held open until the page answers, and Allow once returns allow and nothing else', async () => {
  const b = broker();
  const { answer } = b.call();
  const ask = openOf(b);
  assert.equal(ask.tool, 'Bash');
  assert.deepEqual(ask.input, payload().tool_input, 'the whole input is there');
  assert.equal(ask.state, 'open');
  const settled = await Promise.race([answer.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('held'), 30))]);
  assert.equal(settled, 'held');
  await b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'allow' });
  assert.deepEqual(await answer, { decision: 'allow' }, 'no standing grant, no updatedPermissions, nothing but allow');
  assert.equal(b.perms.list(A).asks[0].state, 'allowed');
  assert.ok(b.perms.list(A).asks[0].answered_at > 0);
});

test('broker: Deny returns deny with a message and stops the turn by default; a switch lets it go on', async () => {
  const b = broker();
  const first = b.call();
  const ask = openOf(b);
  await b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'deny' });
  const out = await first.answer;
  assert.equal(out.decision, 'deny');
  assert.equal(out.interrupt, true);
  assert.match(out.message, /denied/i);
  assert.equal(b.perms.list(A).asks[0].state, 'denied');
  const soft = broker({ denyInterrupts: false });
  const second = soft.call();
  const next = openOf(soft);
  await soft.perms.answer({ id: next.id, shown: next.digest, decision: 'deny' });
  assert.equal((await second.answer).interrupt, false);
});

test('broker: an answer for what the card did not show is refused, and the ask stays open', async () => {
  const b = broker();
  const { answer } = b.call();
  const ask = openOf(b);
  await assert.rejects(b.perms.answer({ id: ask.id, shown: 'deadbeef', decision: 'allow' }), (error) => error.code === 'changed' && error.status === 409);
  await assert.rejects(b.perms.answer({ id: ask.id, decision: 'allow' }), (error) => error.code === 'changed');
  assert.equal(openOf(b).state, 'open');
  await b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'deny' });
  await answer;
});

test('broker: only Allow once and Deny exist; any other decision (a standing grant included) is refused', async () => {
  const b = broker();
  b.call();
  const ask = openOf(b);
  for (const decision of ['always', 'allow_always', 'allow-session', '', undefined, 'ALLOW', 1]) {
    await assert.rejects(b.perms.answer({ id: ask.id, shown: ask.digest, decision }), (error) => error.status === 400, String(decision));
  }
  assert.equal(openOf(b).state, 'open');
});

test('broker: a hook that ended first (the dialog was answered in the pane) is over, and a late answer is refused', async () => {
  const b = broker();
  const { answer, hangUp } = b.call();
  const ask = openOf(b);
  hangUp();
  assert.deepEqual((await answer).decision, 'none');
  assert.equal(b.perms.list(A).asks[0].state, 'elsewhere');
  await assert.rejects(b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'allow' }), (error) => error.code === 'over' && /pane/.test(error.message));
});

test('broker: Herdr must still see the pane at a prompt; the agent having moved on, or no one pane, refuses and leaves the ask open', async () => {
  const b = broker();
  const { answer } = b.call();
  const ask = openOf(b);
  b.status.value = 'working';
  await assert.rejects(b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'allow' }), (error) => error.code === 'moved_on');
  b.status.value = 'idle';
  await assert.rejects(b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'allow' }), (error) => error.code === 'moved_on');
  b.status.value = null;
  await assert.rejects(b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'allow' }), (error) => error.code === 'no_pane');
  assert.equal(openOf(b).state, 'open', 'a refusal does not end the ask');
  b.status.value = 'blocked';
  await b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'allow' });
  assert.equal((await answer).decision, 'allow');
});

test('broker: the hook ending while Herdr is being asked ends the ask; the answer is refused and nothing is returned twice', async () => {
  const b = broker();
  let release;
  b.perms.close();  // a fresh broker whose paneStatus waits
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = broker({ paneStatus: () => gate.then(() => 'blocked') });
  const { answer, hangUp } = slow.call();
  const ask = openOf(slow);
  const pending = slow.perms.answer({ id: ask.id, shown: ask.digest, decision: 'allow' });
  hangUp();
  release();
  await assert.rejects(pending, (error) => error.code === 'over');
  assert.equal((await answer).decision, 'none');
  assert.equal(slow.perms.list(A).asks[0].state, 'elsewhere');
});

test('broker: a call is not taken unless the session is listed, a page is looking, and the whole input fits; otherwise the dialog is left alone', async () => {
  const b = broker();
  for (const body of [payload({ session_id: C }), payload({ hook_event_name: 'Notification' }), payload({ tool_input: null }), payload({ tool_name: '' }), payload({ session_id: 'nope' }), null, 'text']) {
    assert.equal((await b.call(body).answer).decision, 'none', JSON.stringify(body));
  }
  const big = payload({ tool_input: { content: 'x'.repeat(permissionsLib.MAX_SHOWN_BYTES + 10) } });
  assert.equal((await b.call(big).answer).decision, 'none', 'too big to show whole: never answered from here');
  assert.equal(b.perms.list().asks.length, 0, 'nothing was recorded for any of them');
  const off = broker({ enabled: false });
  assert.equal((await off.call().answer).decision, 'none');
  const quiet = broker({ needPage: true });
  assert.equal((await quiet.call().answer).decision, 'none', 'no page has looked');
  quiet.perms.list(A);  // a page asks for the asks
  const taken = quiet.call();
  assert.equal(openOf(quiet).state, 'open', 'a page that looked a moment ago is open and looking');
  quiet.tick(31_000);
  assert.equal((await quiet.call().answer).decision, 'none', 'and not after it has been gone for 30 s');
  taken.hangUp();
});

test('broker: the hold has a limit, after which the hook is told there is no answer from here', async () => {
  const b = broker({ waitMs: 20 });
  const { answer } = b.call();
  assert.equal((await answer).decision, 'none');
  assert.equal(b.perms.list(A).asks[0].state, 'expired');
});

test('broker: what Claude also offers (a standing grant) is shown as a note on the record, never returned', async () => {
  const b = broker();
  const { answer } = b.call(payload({ permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'localSettings' }] }));
  const ask = openOf(b);
  assert.deepEqual(ask.suggestions, ['addRules: touch:*']);
  await b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'allow' });
  assert.deepEqual(await answer, { decision: 'allow' });
});

test('broker: an ask whose pane was at a prompt and no longer is (answered in the pane) ends as answered in the pane, and the hook is let go', async () => {
  const b = broker();
  const { answer } = b.call();
  await b.perms.sweep();
  assert.equal(openOf(b).state, 'open', 'seen at a prompt: still open');
  b.status.value = 'working';
  await b.perms.sweep();
  assert.equal(b.perms.list(A).asks[0].state, 'elsewhere');
  assert.equal((await answer).decision, 'none');
});

test('broker: a pane never seen at a prompt within the grace ends the ask as expired; within it, the ask waits', async () => {
  const b = broker();
  b.status.value = 'working';
  const { answer } = b.call();
  b.tick(permissionsLib.SEEN_GRACE_MS - 1000);
  await b.perms.sweep();
  assert.equal(openOf(b).state, 'open');
  b.tick(2000);
  await b.perms.sweep();
  assert.equal(b.perms.list(A).asks[0].state, 'expired');
  assert.equal((await answer).decision, 'none');
});

test('broker: a result for that tool call in the session log ends the ask, even while the pane is at a prompt for another one, and an answer is refused', async () => {
  const b = broker();
  const first = b.call();
  const ask = openOf(b);
  b.log.value = 'pending';
  await b.perms.sweep();
  assert.equal(openOf(b).state, 'open', 'a call with no result yet is still waiting');
  b.log.value = 'done';
  await assert.rejects(b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'allow' }), (error) => error.code === 'over');
  assert.equal(b.perms.list(A).asks[0].state, 'elsewhere');
  assert.equal((await first.answer).decision, 'none');
  const second = b.call(payload({ tool_input: { command: 'ls' } }));
  b.log.value = 'done';
  await b.perms.sweep();
  assert.equal(b.perms.list(A).asks[0].state, 'elsewhere', 'the sweep finds it too');
  assert.equal((await second.answer).decision, 'none');
});

test('broker: with a sweep timer on, a pane that moves on ends the ask by itself', async () => {
  const b = broker({ sweepMs: 20 });
  const { answer } = b.call();
  await new Promise((resolve) => setTimeout(resolve, 60));
  b.status.value = 'idle';
  const out = await Promise.race([answer, new Promise((resolve) => setTimeout(() => resolve('late'), 2000))]);
  assert.equal(out.decision, 'none');
  assert.equal(b.perms.list(A).asks[0].state, 'elsewhere');
  b.perms.close();
});

test('broker: the digest is the same for the same ask whatever order its keys came in, and differs when one word differs', () => {
  const one = permissionsLib.digestOf('Bash', { command: 'ls', description: 'x' });
  assert.equal(one, permissionsLib.digestOf('Bash', { description: 'x', command: 'ls' }));
  assert.notEqual(one, permissionsLib.digestOf('Bash', { command: 'ls ', description: 'x' }));
  assert.notEqual(one, permissionsLib.digestOf('Write', { command: 'ls', description: 'x' }));
});

test('broker: records are kept in an owner-only file, an ask open at a restart is over, and the oldest go first', async () => {
  const b = broker();
  b.call();
  const ask = openOf(b);
  await b.perms.answer({ id: ask.id, shown: ask.digest, decision: 'allow' });
  const second = b.call(payload({ tool_input: { command: 'ls' } }));
  assert.equal(fs.statSync(b.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(b.file)).mode & 0o777, 0o700);
  const again = permissionsLib.create({ enabled: true, file: b.file, hookFile: path.join(b.dir, 'hook.json'), listed: () => [A], needPage: false, now: () => 1_800_000_100_000 });
  const records = again.list(A).asks;
  assert.deepEqual(records.map((r) => r.state).sort(), ['allowed', 'gone']);
  assert.ok(records.every((r) => r.input && r.tool), 'what was asked is kept whole');
  second.hangUp();
  // a record older than the keep limit is dropped when the file is read
  const late = permissionsLib.create({ enabled: true, file: b.file, hookFile: path.join(b.dir, 'hook.json'), listed: () => [A], needPage: false, now: () => 1_800_000_000_000 + (permissionsLib.KEEP_DAYS + 1) * 86400_000 });
  assert.equal(late.list(A).asks.length, 0);
});

test('broker: the hook file names the port and a key that only this server holds, and is emptied when it stops', () => {
  const b = broker();
  b.perms.publishHook(4321);
  const record = JSON.parse(fs.readFileSync(path.join(b.dir, 'hook.json'), 'utf8'));
  assert.equal(record.port, 4321);
  assert.equal(record.pid, process.pid);
  assert.match(record.key, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(b.dir, 'hook.json')).mode & 0o777, 0o600);
  assert.equal(b.perms.hookKeyMatches(record.key), true);
  assert.equal(b.perms.hookKeyMatches(record.key.replace(/.$/, 'x')), false);
  assert.equal(b.perms.hookKeyMatches(''), false);
  b.perms.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.dir, 'hook.json'), 'utf8')).port, 0);
});

test('broker: waiting for a change answers at once when there already was one, and otherwise when one comes', async () => {
  const b = broker();
  const before = b.perms.rev();
  const started = Date.now();
  const waiting = b.perms.wait(before, 5000);
  b.call();
  await waiting;
  assert.ok(Date.now() - started < 1000);
  await b.perms.wait(before, 5000);  // already newer: returns now
});

// ------------------------------------------------------------------------------------------------------------------------ the routes

function paneWorld() {
  const world = { status: 'blocked', panes: null, calls: [] };
  const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });
  world.runner = async (file, args) => {
    world.calls.push([file, ...args]);
    if (file === 'herdr' && args[0] === 'session') return ok(JSON.stringify({ sessions: [{ name: 'work', default: false, running: true }] }));
    if (file === 'herdr' && args[2] === 'api' && args[3] === 'snapshot') {
      return ok(JSON.stringify({ result: { snapshot: { focused_pane_id: 'w1:p1', tabs: [{ tab_id: 'w1:t1', label: 'alpha' }], panes: world.panes || [
        { pane_id: 'w1:p1', tab_id: 'w1:t1', label: 'alpha', agent: 'claude', agent_status: world.status, agent_session: { value: A } },
        { pane_id: 'w1:p2', tab_id: 'w1:t2', label: 'beta', agent: 'claude', agent_status: 'idle', agent_session: { value: B } },
      ] } } }));
    }
    if (file === 'herdr' && args[2] === 'pane' && args[3] === 'process-info') return ok(JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 1, argv0: 'claude' }] } } }));
    if (file === 'herdr') return ok('{}');
    return { code: 1, stdout: '', stderr: 'unexpected', timedOut: false, truncated: false };
  };
  return world;
}

async function startServer({ permissions = true, env = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-permission-routes-'));
  const root = path.join(base, 'repo');
  const outDir = path.join(root, 'setup', 'transcript-reader', 'out');
  const projectsDir = path.join(base, 'projects', '-Users-someone-home');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  const page = `<!doctype html><head>${TOKEN_META}<title>reader</title></head>`;
  fs.writeFileSync(path.join(outDir, 'prototype.html'), page);
  fs.writeFileSync(path.join(outDir, 'sessions.txt'), `${A}\n${B}\n`);
  fs.writeFileSync(path.join(outDir, 'prototype.stamp'), String(Date.now() / 1000 + 60));
  fs.writeFileSync(path.join(outDir, 'questionnaire.stamp'), '1');
  const old = new Date(Date.now() - 3600 * 1000);
  for (const id of [A, B]) { const f = path.join(projectsDir, id + '.jsonl'); fs.writeFileSync(f, '{}\n'); fs.utimesSync(f, old, old); }
  const world = paneWorld();
  let api;
  const server = http.createServer((req, res) => { if (api.handle(req, res)) return; res.writeHead(404); res.end('no'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const hookFile = path.join(base, 'config', 'permission-hook.json');
  api = create({
    root, outDir, port, runner: world.runner, projectsDir: path.dirname(projectsDir), claudeSessionsDir: path.join(base, 'sessions'), codexSessionsDir: path.join(base, 'codex'), copilotHomeDir: path.join(base, 'copilot'),
    pinsFile: path.join(base, 'config', 'pins.json'), starsFile: path.join(base, 'config', 'stars.json'), sheetFlagsFile: path.join(base, 'config', 'flags.json'), hiddenFile: path.join(base, 'config', 'hidden.json'),
    permissionsFile: path.join(base, 'config', 'permission-asks.json'), permissionsHookFile: hookFile, pause: async () => {}, rebuildEveryMs: 0,
    env: { ...env, ...(permissions ? { PMOS_READER_PERMISSIONS: '1' } : {}) }, ...(permissions && typeof permissions === 'object' ? { permissions } : {}),
  });
  api.publishHook(port);
  const host = '127.0.0.1:' + port;
  const origin = 'http://' + host;
  const request = ({ method = 'GET', path: urlPath, headers = {}, body }) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { Host: host, ...headers, ...(data !== undefined ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, raw, json }); });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
  const opened = await request({ path: '/setup/transcript-reader/out/prototype.html', headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
  const token = (opened.raw.match(/content="([0-9a-f]{64})"/) || [])[1];
  const hookKey = () => JSON.parse(fs.readFileSync(hookFile, 'utf8')).key;
  const page$ = {
    get: (p) => request({ path: '/api/transcript-reader/' + p, headers: { [TOKEN_HEADER]: token } }),
    post: (p, body) => request({ method: 'POST', path: '/api/transcript-reader/' + p, headers: { Origin: origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: token }, body }),
  };
  // the hook's own call: its key, no Origin, no Fetch-Metadata; returns a handle whose `.done` is the answer and which can be hung up
  const hookCall = (body = payload(), headers = {}) => {
    const data = JSON.stringify(body);
    let req;
    const done = new Promise((resolve, reject) => {
      req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/transcript-reader/permission-ask', headers: { Host: host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-transcript-reader-hook': hookKey(), ...headers } }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* */ } resolve({ status: res.statusCode, json, raw }); });
      });
      req.on('error', (error) => resolve({ error: error.code || error.message }));
      req.write(data);
      req.end();
    });
    return { done, hangUp: () => req.destroy() };
  };
  return { world, api, page$, hookCall, request, token, hookFile, hookKey, port, base, origin, close: () => new Promise((resolve) => { api.close(); server.close(() => resolve()); server.closeAllConnections && server.closeAllConnections(); }) };
}
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await check(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timed out'); };

test('routes: off by default; the hook route, the list and the answer are all not found', async () => {
  const s = await startServer({ permissions: false });
  try {
    assert.equal((await s.page$.get('permissions')).status, 404);
    assert.equal((await s.page$.post('permission-answer', { id: 'p000000000000', shown: 'x', decision: 'allow' })).status, 404);
    assert.equal((await s.request({ method: 'POST', path: '/api/transcript-reader/permission-ask', headers: { 'Content-Type': 'application/json' }, body: payload() })).status, 404);
    assert.equal(fs.existsSync(s.hookFile), false, 'no hook file is written while it is off');
    assert.equal((await s.page$.get('state')).json.permissions, undefined);
  } finally { await s.close(); }
});

test('routes: an ask from the hook shows in the list and the state, and the page answers it once', async () => {
  const s = await startServer();
  try {
    await s.page$.get('permissions');  // a page is open and looking
    const call = s.hookCall();
    const listed = await until(async () => { const r = await s.page$.get('permissions?session=' + A); return r.json.asks.length ? r.json : null; });
    const ask = listed.asks[0];
    assert.equal(ask.state, 'open');
    assert.equal(ask.tool, 'Bash');
    assert.equal(ask.input.command, 'touch permission-probe.txt');
    assert.equal(listed.write, true, 'the laptop page may answer');
    const state = await s.page$.get('state');
    assert.deepEqual(state.json.permissions.open, { [A]: 1 });
    assert.equal((await s.page$.get('permissions?session=' + B)).json.asks.length, 0, 'another session has none');
    const answered = await s.page$.post('permission-answer', { id: ask.id, shown: ask.digest, decision: 'allow' });
    assert.equal(answered.status, 200, answered.raw);
    assert.equal(answered.json.ask.state, 'allowed');
    const result = await call.done;
    assert.deepEqual(result.json, { status: 'ok', decision: 'allow' });
    const again = await s.page$.post('permission-answer', { id: ask.id, shown: ask.digest, decision: 'allow' });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'over');
    assert.deepEqual((await s.page$.get('state')).json.permissions.open, {});
  } finally { await s.close(); }
});

test('routes: the long wait on the list answers the moment an ask arrives', async () => {
  const s = await startServer();
  try {
    const first = (await s.page$.get('permissions?session=' + A)).json;
    const started = Date.now();
    const waiting = s.page$.get(`permissions?session=${A}&rev=${first.rev}&wait=20000`);
    await new Promise((r) => setTimeout(r, 50));
    const call = s.hookCall();
    const woke = await waiting;
    assert.ok(Date.now() - started < 3000);
    assert.equal(woke.json.asks[0].state, 'open');
    call.hangUp();
    await call.done;
  } finally { await s.close(); }
});

test('routes: a page waiting for asks counts as open and looking; with none, the hook is left to the dialog at once', async () => {
  const s = await startServer();
  try {
    const result = await s.hookCall().done;
    assert.equal(result.json.decision, 'none');
    assert.equal(result.json.why, 'nobody is looking');
    await s.page$.get('permissions');
    const call = s.hookCall();
    await until(async () => (await s.page$.get('permissions')).json.asks.length);
    call.hangUp();
    await call.done;
  } finally { await s.close(); }
});

test('routes: the hook route refuses a page: no key, a wrong key, an Origin, Fetch-Metadata, another Host, a form post, a GET', async () => {
  const s = await startServer();
  try {
    await s.page$.get('permissions');
    const post = (headers, body = payload()) => s.request({ method: 'POST', path: '/api/transcript-reader/permission-ask', headers: { 'Content-Type': 'application/json', ...headers }, body });
    assert.equal((await post({})).status, 403, 'no key');
    assert.equal((await post({ 'x-transcript-reader-hook': 'f'.repeat(64) })).status, 403, 'wrong key');
    assert.equal((await post({ 'x-transcript-reader-hook': s.hookKey(), Origin: s.origin })).status, 403, 'a page always sends an Origin');
    assert.equal((await post({ 'x-transcript-reader-hook': s.hookKey(), 'Sec-Fetch-Site': 'same-origin' })).status, 403, 'and Fetch-Metadata');
    assert.equal((await post({ 'x-transcript-reader-hook': s.hookKey(), Host: 'evil.example:80' })).status, 403, 'a rebound host');
    assert.equal((await post({ 'x-transcript-reader-hook': s.hookKey(), 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await s.request({ path: '/api/transcript-reader/permission-ask', headers: { 'x-transcript-reader-hook': s.hookKey() } })).status, 405);
    assert.equal((await s.page$.get('permissions')).json.asks.length, 0, 'none of them left an ask');
    // and the page token does not open the hook route
    assert.equal((await s.page$.post('permission-ask', payload())).status, 403);
  } finally { await s.close(); }
});

test('routes: the answer is refused for a stale card, for an agent that moved on, and from the phone; none of them ends the ask', async () => {
  const s = await startServer();
  try {
    await s.page$.get('permissions');
    const call = s.hookCall();
    const ask = (await until(async () => { const r = await s.page$.get('permissions?session=' + A); return r.json.asks[0] ? r.json : null; })).asks[0];
    const stale = await s.page$.post('permission-answer', { id: ask.id, shown: 'a'.repeat(24), decision: 'allow' });
    assert.equal(stale.json.code, 'changed');
    s.world.status = 'working';
    const moved = await s.page$.post('permission-answer', { id: ask.id, shown: ask.digest, decision: 'allow' });
    assert.equal(moved.json.code, 'moved_on');
    assert.match(moved.json.message, /moved on/);
    const extra = await s.page$.post('permission-answer', { id: ask.id, shown: ask.digest, decision: 'allow', always: true });
    assert.equal(extra.status, 400, 'no other field, a standing grant included');
    const grant = await s.page$.post('permission-answer', { id: ask.id, shown: ask.digest, decision: 'always' });
    assert.equal(grant.status, 400);
    assert.equal((await s.page$.get('permissions?session=' + A)).json.asks[0].state, 'open');
    s.world.status = 'blocked';
    const ok = await s.page$.post('permission-answer', { id: ask.id, shown: ask.digest, decision: 'deny' });
    assert.equal(ok.status, 200);
    assert.equal((await call.done).json.decision, 'deny');
  } finally { await s.close(); }
});

test('routes: the hook ending (a dialog answered in the pane) leaves the record "answered elsewhere" and a late answer says so', async () => {
  const s = await startServer();
  try {
    await s.page$.get('permissions');
    const call = s.hookCall();
    const ask = (await until(async () => { const r = await s.page$.get('permissions?session=' + A); return r.json.asks[0] ? r.json : null; })).asks[0];
    call.hangUp();
    await call.done;
    await until(async () => (await s.page$.get('permissions?session=' + A)).json.asks[0].state === 'elsewhere');
    const late = await s.page$.post('permission-answer', { id: ask.id, shown: ask.digest, decision: 'allow' });
    assert.equal(late.status, 409);
    assert.equal(late.json.code, 'over');
  } finally { await s.close(); }
});

test('routes: an ask for a session that is not listed is never taken', async () => {
  const s = await startServer();
  try {
    await s.page$.get('permissions');
    const result = await s.hookCall(payload({ session_id: C })).done;
    assert.equal(result.json.decision, 'none');
    assert.equal(result.json.why, 'not listed');
  } finally { await s.close(); }
});

test('routes: the sweep ends an ask when Herdr stops seeing the pane at a prompt, and a result in the session log refuses an answer', async () => {
  const s = await startServer({ permissions: { sweepMs: 40 } });
  try {
    await s.page$.get('permissions');
    const call = s.hookCall();
    await until(async () => (await s.page$.get('permissions?session=' + A)).json.asks[0]);
    await new Promise((resolve) => setTimeout(resolve, 1200));  // Herdr's reading (700 ms old at most) shows the pane at its prompt
    assert.equal((await s.page$.get('permissions?session=' + A)).json.asks[0].state, 'open');
    s.world.status = 'working';
    await until(async () => (await s.page$.get('permissions?session=' + A)).json.asks[0].state === 'elsewhere', 4000);
    const out = await call.done;
    assert.equal(out.json.decision, 'none');
    // a second ask: the pane stays at a prompt, but the session log already holds the call's result
    s.world.status = 'blocked';
    await new Promise((resolve) => setTimeout(resolve, 900));
    const again = s.hookCall(payload({ tool_input: { command: 'echo second' } }));
    const ask = (await until(async () => (await s.page$.get('permissions?session=' + A)).json.asks.find((a) => a.state === 'open'), 3000));
    const log = path.join(s.base, 'projects', '-Users-someone-home', A + '.jsonl');
    fs.appendFileSync(log, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'echo second' } }] } }) + '\n'
      + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'second' }] } }) + '\n');
    const refused = await s.page$.post('permission-answer', { id: ask.id, shown: ask.digest, decision: 'allow' });
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.json.code, 'over');
    assert.equal((await again.done).json.decision, 'none');
  } finally { await s.close(); }
});

// ------------------------------------------------------------------------------------------------------------------------ the log check

test('log check: the newest tool call with this tool and input is done once it has a result, pending before, unknown when the tail has none', () => {
  const permlog = require('./permlog');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-permlog-'));
  const file = path.join(dir, A + '.jsonl');
  const use = (id, input, name = 'Bash') => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id, name, input }] } });
  const result = (id) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: true }] } });
  const check = permlog.create();
  assert.equal(check.state(file, 'Bash', { command: 'ls' }), 'unknown', 'no log');
  assert.equal(check.state(null, 'Bash', { command: 'ls' }), 'unknown');
  fs.writeFileSync(file, [use('t1', { command: 'ls', description: 'd' }), result('t1'), use('t2', { description: 'd', command: 'ls' })].join('\n') + '\n');
  assert.equal(check.state(file, 'Bash', { command: 'ls', description: 'd' }), 'pending', 'the newest of two equal calls decides, whatever the key order');
  fs.appendFileSync(file, result('t2') + '\n');
  assert.equal(check.state(file, 'Bash', { command: 'ls', description: 'd' }), 'done', 'a refusal is a result too');
  assert.equal(check.state(file, 'Bash', { command: 'pwd' }), 'unknown', 'another input');
  assert.equal(check.state(file, 'Edit', { command: 'ls', description: 'd' }), 'unknown', 'another tool');
});

test('log check: only the tail is read, a line cut by it is left out, and an unchanged log is not read again', () => {
  const permlog = require('./permlog');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-permlog-tail-'));
  const file = path.join(dir, B + '.jsonl');
  const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } });
  const old = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Bash', input: { command: 'old' } }] } });
  const lines = [old];
  for (let i = 0; i < Math.ceil((permlog.TAIL_BYTES * 1.2) / 1000); i++) lines.push(filler);
  lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'new', name: 'Bash', input: { command: 'new' } }] } }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const check = permlog.create();
  assert.equal(check.state(file, 'Bash', { command: 'old' }), 'unknown', 'beyond the part read: nothing concluded');
  assert.equal(check.state(file, 'Bash', { command: 'new' }), 'pending');
  const spy = fs.readSync;
  let reads = 0;
  fs.readSync = (...args) => { reads += 1; return spy(...args); };
  try { assert.equal(check.state(file, 'Bash', { command: 'new' }), 'pending'); } finally { fs.readSync = spy; }
  assert.equal(reads, 0, 'the log did not change, so it was not read');
});

// ------------------------------------------------------------------------------------------------------------------------ the hook command

const runHook = (input, env, args = ['hook']) => new Promise((resolve) => {
  const child = spawn('python3', ['-I', HOOK, ...args], { env: { PATH: process.env.PATH, HOME: env.HOME || os.tmpdir(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, out, err }));
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
});

test('hook command: prints Claude Code\'s own allow JSON for an Allow once, and nothing for anything else', async () => {
  const s = await startServer();
  try {
    await s.page$.get('permissions');
    const ran = runHook(payload(), { PMOS_READER_HOOK_FILE: s.hookFile });
    const ask = (await until(async () => { const r = await s.page$.get('permissions?session=' + A); return r.json.asks[0] ? r.json : null; })).asks[0];
    await s.page$.post('permission-answer', { id: ask.id, shown: ask.digest, decision: 'allow' });
    const result = await ran;
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.equal(result.err, '');
  } finally { await s.close(); }
});

test('hook command: Deny prints deny with a message and interrupt, and no updatedPermissions anywhere', async () => {
  const s = await startServer();
  try {
    await s.page$.get('permissions');
    const ran = runHook(payload(), { PMOS_READER_HOOK_FILE: s.hookFile });
    const ask = (await until(async () => { const r = await s.page$.get('permissions?session=' + A); return r.json.asks[0] ? r.json : null; })).asks[0];
    await s.page$.post('permission-answer', { id: ask.id, shown: ask.digest, decision: 'deny' });
    const result = await ran;
    const parsed = JSON.parse(result.out);
    assert.equal(parsed.hookSpecificOutput.decision.behavior, 'deny');
    assert.equal(parsed.hookSpecificOutput.decision.interrupt, true);
    assert.match(parsed.hookSpecificOutput.decision.message, /denied/i);
    assert.equal(result.out.includes('updatedPermissions'), false);
  } finally { await s.close(); }
});

test('hook command: fails open - no server, a dead pid, a wrong key, garbage input, another event, a server error all print nothing and exit 0', async () => {
  const s = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-hook-open-'));
  try {
    const cases = [
      ['no hook file', payload(), { PMOS_READER_HOOK_FILE: path.join(dir, 'missing.json') }],
      ['a stopped server (port 0)', payload(), (() => { const f = path.join(dir, 'zero.json'); fs.writeFileSync(f, JSON.stringify({ version: 1, port: 0, key: '', pid: 0 })); return { PMOS_READER_HOOK_FILE: f }; })()],
      ['a dead pid', payload(), (() => { const f = path.join(dir, 'dead.json'); fs.writeFileSync(f, JSON.stringify({ version: 1, port: s.port, key: 'a'.repeat(64), pid: 999999 })); return { PMOS_READER_HOOK_FILE: f }; })()],
      ['a wrong key', payload(), (() => { const f = path.join(dir, 'key.json'); fs.writeFileSync(f, JSON.stringify({ version: 1, port: s.port, key: 'a'.repeat(64), pid: process.pid })); return { PMOS_READER_HOOK_FILE: f }; })()],
      ['a closed port', payload(), (() => { const f = path.join(dir, 'port.json'); fs.writeFileSync(f, JSON.stringify({ version: 1, port: 9, key: s.hookKey(), pid: process.pid })); return { PMOS_READER_HOOK_FILE: f }; })()],
      ['garbage on stdin', '{not json', { PMOS_READER_HOOK_FILE: s.hookFile }],
      ['empty stdin', '', { PMOS_READER_HOOK_FILE: s.hookFile }],
      ['another event', payload({ hook_event_name: 'Notification' }), { PMOS_READER_HOOK_FILE: s.hookFile }],
      ['nobody looking', payload(), { PMOS_READER_HOOK_FILE: s.hookFile }],
    ];
    for (const [name, input, env] of cases) {
      const result = await runHook(input, env);
      assert.equal(result.code, 0, name);
      assert.equal(result.out, '', name);
      assert.equal(result.err, '', name);
    }
  } finally { await s.close(); }
});

test('hook command: killed by Claude Code (the dialog answered in the pane), the ask ends as "answered elsewhere"', async () => {
  const s = await startServer();
  try {
    await s.page$.get('permissions');
    const child = spawn('python3', ['-I', HOOK, 'hook'], { env: { PATH: process.env.PATH, PMOS_READER_HOOK_FILE: s.hookFile }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(JSON.stringify(payload()));
    await until(async () => (await s.page$.get('permissions?session=' + A)).json.asks[0]);
    child.kill('SIGKILL');
    await until(async () => (await s.page$.get('permissions?session=' + A)).json.asks[0].state === 'elsewhere');
  } finally { await s.close(); }
});

test('hook command: install writes only the folder it is given, keeps every other key and hook, is a dry run without --apply, and uninstall puts it back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-hook-install-'));
  const settings = path.join(dir, 'settings.json');
  const original = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }], PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'python3 notify.py' }] }] }, permissions: { allow: ['Bash(ls:*)'] } };
  fs.writeFileSync(settings, JSON.stringify(original, null, 2));
  const run = (...args) => spawnSync('python3', ['-I', HOOK, ...args, '--config-dir', dir], { encoding: 'utf8' });
  const dry = run('install');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run: nothing was written/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), original, 'a dry run changes nothing');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  const applied = run('install', '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(after.model, 'x');
  assert.deepEqual(after.permissions, original.permissions);
  assert.deepEqual(after.hooks.Stop, original.hooks.Stop);
  assert.equal(after.hooks.PermissionRequest.length, 2);
  assert.deepEqual(after.hooks.PermissionRequest[0], original.hooks.PermissionRequest[0], 'the notification hook stays first, untouched');
  const added = after.hooks.PermissionRequest[1];
  assert.equal(added.matcher, '*');
  assert.equal(added.hooks[0].type, 'command');
  assert.match(added.hooks[0].command, /^python3 -I \/.*permission-hook\.py hook$/);
  assert.equal(added.hooks[0].timeout, 660);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-reader-permission-')).length, 1, 'a dated copy of the old file');
  assert.match(run('install', '--apply').stdout, /already there/);
  assert.match(run('status').stdout, /the hook is there/);
  const removed = run('uninstall', '--apply');
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), original, 'uninstall leaves the file as it was, the other hook included');
});

test('hook command: install into a folder with no settings.json writes one with just this hook; a settings.json that is not an object is refused untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-hook-install-new-'));
  const run = (...args) => spawnSync('python3', ['-I', HOOK, ...args, '--config-dir', dir], { encoding: 'utf8' });
  assert.equal(run('install', '--apply').status, 0);
  const made = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(made), ['hooks']);
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-hook-install-bad-'));
  fs.writeFileSync(path.join(bad, 'settings.json'), '[1,2]');
  const refused = spawnSync('python3', ['-I', HOOK, 'install', '--apply', '--config-dir', bad], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.equal(fs.readFileSync(path.join(bad, 'settings.json'), 'utf8'), '[1,2]');
  const missing = spawnSync('python3', ['-I', HOOK, 'install', '--apply', '--config-dir', path.join(bad, 'nope')], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
});
