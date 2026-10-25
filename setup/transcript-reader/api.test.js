'use strict';

// Tests for the transcript reader's server module. Run from the repo root:
//   node --test setup/transcript-reader/api.test.js
// Herdr and reader.py are faked; session logs and the out/ folder are temporary
// files, so no real session, pane or page is read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { create, TOKEN_HEADER, TOKEN_META, COPY_HEADER } = require('./api');

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

// A built page as build_prototype.write_page leaves it: the token tag unfilled, and the
// payload escaping "<" (here it quotes a transcript that mentions the tag's placeholder).
const builtPage = (title) => `<!doctype html><head>${TOKEN_META}<title>${title}</title></head>`
  + '<script id="payload" type="application/json">{"text":"\\u003cmeta name=\\"reader-token\\" content=\\"__READER_TOKEN__\\">"}</script>';
const tokenIn = (html) => (html.match(/<meta name="reader-token" content="([^"]*)">/) || [])[1];

function fixtureTree({ outParts = ['setup', 'transcript-reader', 'out'] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-reader-'));
  const root = path.join(base, 'repo');
  const outDir = path.join(root, ...outParts);
  const projectsDir = path.join(base, 'projects');
  const claudeSessionsDir = path.join(base, 'sessions');  // no running Claude unless a test writes one
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(projectsDir, '-Users-someone-home'), { recursive: true });
  const write = (file, text) => fs.writeFileSync(file, text);
  write(path.join(outDir, 'prototype.html'), builtPage('reader'));
  write(path.join(outDir, 'questionnaire.html'), builtPage('sheet'));
  write(path.join(outDir, 'sessions.txt'), `${A}\n${B}\n`);
  write(path.join(outDir, 'prototype.stamp'), String(Date.now() / 1000 + 60));
  write(path.join(outDir, 'questionnaire.stamp'), '1');
  for (const id of [A, B, C]) write(path.join(projectsDir, '-Users-someone-home', id + '.jsonl'), '{}\n');
  // Logs older than the page, so no rebuild starts unless a test asks for one.
  const old = new Date(Date.now() - 3600 * 1000);
  for (const id of [A, B, C]) fs.utimesSync(path.join(projectsDir, '-Users-someone-home', id + '.jsonl'), old, old);
  return { root, outDir, projectsDir, claudeSessionsDir, logOf: (id) => path.join(projectsDir, '-Users-someone-home', id + '.jsonl'), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// A fake Herdr: one running named session "work" plus sessions that must never be read.
function fakeHerdr() {
  const herdr = {
    focused: 'w1:p1',
    panes: [
      { pane_id: 'w1:p1', tab_id: 'w1:t1', label: 'leader-alpha', agent_status: 'idle', agent_session: { value: A } },
      { pane_id: 'w1:p2', tab_id: 'w1:t2', label: null, agent_status: 'working', agent_session: { value: B } },
      { pane_id: 'w1:p3', tab_id: 'w1:t3', label: 'unlisted', agent_status: 'idle', agent_session: { value: C } },
      { pane_id: 'w1:p4', tab_id: 'w1:t1', terminal_title_stripped: 'zsh' },
    ],
    // Claude in the foreground of each agent pane; a test changes it for a pane at its shell.
    processInfo: { 'w1:p1': [{ pid: 1001, argv0: 'claude' }], 'w1:p2': [{ pid: 1002, argv0: 'claude' }], 'w1:p3': [{ pid: 1003, argv0: 'claude' }] },
    promptResult: { code: 0, stdout: '{}', stderr: '' },
    keysResult: { code: 0, stdout: '{}', stderr: '' },
    down: false,
    calls: [],
  };
  const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });
  herdr.runner = async (file, args, options = {}) => {
    herdr.calls.push({ file, args: args.slice(), env: options.env });
    if (file === 'herdr' && args[0] === 'session') {
      if (herdr.down) return { code: 1, stdout: '', stderr: 'herdr is not running', timedOut: false, truncated: false };
      return ok(JSON.stringify({ sessions: [
        { name: 'default', default: true, running: true },
        { name: '-h', default: false, running: true },
        { name: 'work', default: false, running: true },
        { name: 'stopped', default: false, running: false },
      ] }));
    }
    if (file === 'herdr' && args[2] === 'api' && args[3] === 'snapshot') {
      return ok(JSON.stringify({ result: { snapshot: { focused_pane_id: herdr.focused, panes: herdr.panes, tabs: [{ tab_id: 'w1:t2', label: 'fm-task-tab' }] } } }));
    }
    if (file === 'herdr' && args[2] === 'pane' && args[3] === 'process-info') {
      return ok(JSON.stringify({ result: { process_info: { foreground_processes: herdr.processInfo[args[5]] || [] } } }));
    }
    if (file === 'herdr' && args[2] === 'agent' && args[3] === 'prompt') return { timedOut: false, truncated: false, ...herdr.promptResult };
    if (file === 'herdr' && args[2] === 'agent' && args[3] === 'send-keys') return { timedOut: false, truncated: false, ...herdr.keysResult };
    if (file === 'python3') return herdr.readerResult || ok('');  // reader.py; a test may make it fail
    return { code: 1, stdout: '', stderr: 'unexpected command', timedOut: false, truncated: false };
  };
  herdr.prompts = () => herdr.calls.filter((call) => call.args[2] === 'agent' && call.args[3] === 'prompt');
  herdr.keys = () => herdr.calls.filter((call) => call.args[2] === 'agent' && call.args[3] === 'send-keys');
  herdr.agentCalls = () => herdr.calls.filter((call) => call.args[2] === 'agent');
  herdr.readerRuns = () => herdr.calls.filter((call) => call.file === 'python3').map((call) => call.args.slice(2));
  return herdr;
}

async function start({ env = {}, outParts } = {}) {
  const tree = fixtureTree({ outParts });
  const herdr = fakeHerdr();
  let api;
  // Requests this module does not claim go to a copy of serve.sh's static handler, which
  // reads any file under the repo; its answers are marked so a test can tell who answered.
  const server = http.createServer((req, res) => {
    if (api.handle(req, res)) return;
    fs.readFile(path.join(tree.root, decodeURIComponent(req.url.split('?')[0])), (error, data) => {
      if (error) { res.writeHead(404, { 'X-Static': '1' }); res.end('static: not found'); return; }
      res.writeHead(200, { 'X-Static': '1', 'Access-Control-Allow-Origin': '*' }); res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let clock = Date.now();
  api = create({ root: tree.root, outDir: tree.outDir, port, runner: herdr.runner, env, projectsDir: tree.projectsDir, claudeSessionsDir: tree.claudeSessionsDir, now: () => clock, pause: async () => {} });
  const host = 'localhost:' + port;
  const origin = 'http://' + host;
  const request = ({ method = 'GET', path: urlPath, headers = {}, body }) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { Host: host, ...headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, raw, json }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  // The browser opening the page in a tab, which is the only way to the token.
  const open = (urlPath = '/setup/transcript-reader/out/prototype.html', headers = {}) => request({ path: urlPath, headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', ...headers } });
  const token = tokenIn((await open()).raw);
  const state = (follow = false) => request({ path: '/api/transcript-reader/state' + (follow ? '?follow=1' : ''), headers: { [TOKEN_HEADER]: token } });
  const send = (body, headers = {}) => request({ method: 'POST', path: '/api/transcript-reader/send', headers: { Origin: origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: token, ...headers }, body });
  const post = (command, body, headers = {}) => request({ method: 'POST', path: '/api/transcript-reader/' + command, headers: { Origin: origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: token, ...headers }, body });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    tree, herdr, request, open, token, state, send, post, settle, origin,
    tick: (ms) => { clock += ms; },
    close: () => new Promise((resolve) => server.close(() => { tree.cleanup(); resolve(); })),
  };
}

test('pages: served same-origin without CORS headers; cross-site and foreign hosts are refused', async () => {
  const t = await start();
  try {
    const page = await t.open();
    assert.equal(page.status, 200);
    assert.match(page.raw, /reader/);
    assert.equal(Object.keys(page.headers).some((name) => name.startsWith('access-control')), false);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal((await t.open('/setup/transcript-reader/out/questionnaire.html')).status, 200);
    assert.equal((await t.request({ path: '/setup/transcript-reader/out/prototype.html', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await t.request({ path: '/setup/transcript-reader/out/prototype.html', headers: { Host: 'evil.example:80' } })).status, 403);
    assert.equal((await t.request({ path: '/setup/transcript-reader/out/prototype.html', headers: { Origin: 'http://evil.example' } })).status, 403);
  } finally { await t.close(); }
});

test('pages: opened in a tab, a page carries the token in its tag only; it refuses frames and cuts off its opener', async () => {
  const t = await start();
  try {
    const page = await t.open();
    assert.match(t.token, /^[0-9a-f]{64}$/);
    assert.equal(page.raw.split(t.token).length, 2, 'the token appears once, in the tag');
    assert.ok(page.raw.includes('\\u003cmeta name=\\"reader-token\\" content=\\"__READER_TOKEN__\\">'), 'transcript text that mentions the tag is left alone');
    assert.match(fs.readFileSync(path.join(t.tree.outDir, 'prototype.html'), 'utf8'), /content="__READER_TOKEN__">/, 'the built file never holds a token');
    assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'");
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(tokenIn((await t.request({ path: '/setup/transcript-reader/out/prototype.html' })).raw), t.token, 'a request without Fetch-Metadata (curl) gets the page, as with the guard');
  } finally { await t.close(); }
});

test('pages: a page names the copy of the repo it comes from, as reader.py computes it', async () => {
  const t = await start();
  try {
    const page = await t.open();
    const python = require('child_process').spawnSync('python3', ['-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import reader; from pathlib import Path; print(reader.copy_id(Path(sys.argv[2])))', __dirname, t.tree.root], { encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    assert.match(page.headers[COPY_HEADER], /^[0-9a-f]{16}$/);
    assert.equal(page.headers[COPY_HEADER], python.stdout.trim());
  } finally { await t.close(); }
});

test('pages: a script fetching, framing or embedding a page from this origin gets neither the page nor the token', async () => {
  const t = await start();
  try {
    for (const headers of [
      { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
      { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' },
      { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' },
      { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'object' },
      { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' },
    ]) {
      const response = await t.request({ path: '/setup/transcript-reader/out/prototype.html', headers });
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.raw.includes(t.token), false);
      assert.doesNotMatch(response.raw, /payload/);
    }
    assert.equal((await t.open('/setup/transcript-reader/out/prototype.html', { 'Sec-Fetch-Site': 'same-origin' })).status, 200, 'a link from the other page, or a reload, still opens it');
    for (const urlPath of ['/api/transcript-reader/token', '/api/transcript-reader/page?name=prototype.html']) {
      const response = await t.request({ path: urlPath, headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } });
      assert.equal(response.status, 403, urlPath);
      assert.equal(response.raw.includes(t.token), false, urlPath);
    }
  } finally { await t.close(); }
});

test('pages: with the token, a page reads its own built text to swap in new turns', async () => {
  const t = await start();
  try {
    const response = await t.request({ path: '/api/transcript-reader/page?name=prototype.html', headers: { [TOKEN_HEADER]: t.token } });
    assert.equal(response.status, 200);
    assert.equal(response.json.html, fs.readFileSync(path.join(t.tree.outDir, 'prototype.html'), 'utf8'));
    assert.equal((await t.request({ path: '/api/transcript-reader/page?name=sessions.txt', headers: { [TOKEN_HEADER]: t.token } })).status, 404);
    assert.equal((await t.request({ path: '/api/transcript-reader/page?name=../out/sessions.txt', headers: { [TOKEN_HEADER]: t.token } })).status, 404);
  } finally { await t.close(); }
});

test('pages: the reading list, stamps and any other spelling of out/ are never handed to the static handler', async () => {
  const t = await start();
  try {
    for (const urlPath of [
      '/setup/transcript-reader/out/sessions.txt',
      '/setup/transcript-reader/out/prototype.stamp',
      '/setup/transcript-reader/out/pane-labels.json',
      '/setup/transcript-reader/out%2Fsessions.txt',
      '/setup/Transcript-Reader/out/sessions.txt',
      '/setup//transcript-reader/out/sessions.txt',
      '/setup/transcript-reader/prototype/../out/sessions.txt',
      '/setup/transcript-reader/out/',
      '/%E0%A4%A',
    ]) {
      const response = await t.request({ path: urlPath });
      assert.equal(response.status, 404, urlPath);
      assert.doesNotMatch(response.raw, new RegExp(A), urlPath);
    }
    fs.writeFileSync(path.join(t.tree.root, 'setup', 'transcript-reader', 'README.md'), 'readme');
    const other = await t.request({ path: '/setup/transcript-reader/README.md' });
    assert.equal(other.headers['x-static'], '1', 'other files stay with the static handler');
    assert.equal(other.raw, 'readme');
  } finally { await t.close(); }
});

test('pages: a request URL nothing can parse is refused here, never passed to the static handler', async () => {
  const t = await start();
  try {
    const response = await t.request({ path: '//[' });
    assert.equal(response.status, 400);
    assert.equal(response.headers['x-static'], undefined);
    const after = await t.request({ path: '/setup/transcript-reader/README.md' });
    assert.notEqual(after.status, 0, 'the server still answers');
  } finally { await t.close(); }
});

test('pages: a spelling the file system folds (Unicode form and case) or a symlink into out/ is still kept from the static handler', async () => {
  // out/ under a folder whose name is not ASCII, written in composed form (é).
  const t = await start({ outParts: ['setup', 'caf\u00e9', 'out'] });
  try {
    const variants = [
      '/setup/cafe%CC%81/out/sessions.txt',  // decomposed (e + combining accent)
      '/setup/CAFE%CC%81/OUT/sessions.txt',  // decomposed and upper case: toLowerCase() alone misses it
      '/setup/CAF%C3%89/out/sessions.txt',   // composed upper case
    ];
    for (const urlPath of variants) {
      const response = await t.request({ path: urlPath });
      assert.doesNotMatch(response.raw, new RegExp(A), urlPath);
      // Where this file system folds the spelling into out/, this module must have answered it.
      if (fs.existsSync(path.join(t.tree.root, decodeURIComponent(urlPath)))) assert.equal(response.headers['x-static'], undefined, urlPath);
    }
    fs.symlinkSync(t.tree.outDir, path.join(t.tree.root, 'setup', 'shortcut'));
    const linked = await t.request({ path: '/setup/shortcut/sessions.txt' });
    assert.equal(linked.status, 404);
    assert.equal(linked.headers['x-static'], undefined);
    assert.doesNotMatch(linked.raw, new RegExp(A));
  } finally { await t.close(); }
});

test('api: every call needs the token; there is no endpoint that hands it out', async () => {
  const t = await start();
  try {
    assert.equal((await t.request({ path: '/api/transcript-reader/state' })).status, 403);
    assert.equal((await t.request({ path: '/api/transcript-reader/state', headers: { [TOKEN_HEADER]: 'wrong' } })).status, 403);
    assert.equal((await t.request({ path: '/api/transcript-reader/token' })).status, 403);
    assert.equal((await t.request({ path: '/api/transcript-reader/token', headers: { [TOKEN_HEADER]: t.token } })).status, 404);
    assert.equal((await t.request({ method: 'OPTIONS', path: '/api/transcript-reader/send' })).status, 403);
    assert.equal((await t.send({ session_id: A, text: 'hi' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await t.send({ session_id: A, text: 'hi' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal(t.herdr.agentCalls().length, 0);
  } finally { await t.close(); }
});

test('state: names the focused pane and the live panes of listed sessions only; default and dash-named sessions are never read', async () => {
  const t = await start();
  try {
    const { json } = await t.state();
    assert.equal(json.focus.session_id, A);
    assert.equal(json.focus.label, 'leader-alpha');
    assert.equal(json.focus.listed, true);
    assert.deepEqual(Object.keys(json.panes).sort(), [A, B]);
    assert.equal(json.panes[B].label, 'fm-task-tab', 'a pane without its own label takes its tab label');
    assert.equal(json.panes[B].status, 'working');
    const read = t.herdr.calls.filter((call) => call.args[0] === '--session').map((call) => call.args[1]);
    assert.deepEqual([...new Set(read)], ['work']);
    assert.equal(t.herdr.readerRuns().length, 0, 'nothing was rebuilt');
  } finally { await t.close(); }
});

test('state: a Claude pane whose session id no running Claude holds takes its foreground Claude\'s session', async () => {
  const t = await start();
  try {
    // Claude restarted in A's pane now runs C (this test process stands in for it); B's pane is back at its shell.
    fs.mkdirSync(t.tree.claudeSessionsDir);
    fs.writeFileSync(path.join(t.tree.claudeSessionsDir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: C }));
    fs.writeFileSync(path.join(t.tree.claudeSessionsDir, '999999999.json'), JSON.stringify({ pid: 999999999, sessionId: B }));  // not running
    t.herdr.panes = t.herdr.panes.map((pane) => (pane.agent_session ? { ...pane, agent: 'claude' } : pane));
    t.herdr.processInfo = { 'w1:p1': [{ pid: process.pid, argv0: 'claude' }], 'w1:p2': [{ pid: 4242, argv0: 'zsh' }] };
    const { json } = await t.state();
    assert.equal(json.focus.session_id, C);
    assert.equal(json.focus.listed, false);
    assert.deepEqual(Object.keys(json.panes), [], 'neither listed session runs in a pane now');
    const asked = t.herdr.calls.filter((call) => call.args[3] === 'process-info').map((call) => call.args[5]);
    assert.deepEqual(asked, ['w1:p1', 'w1:p2'], 'a pane whose id a running Claude holds is not asked about');
  } finally { await t.close(); }
});

test('state: the focus counter moves when Herdr focuses another pane or the focused pane starts another session', async () => {
  const t = await start();
  try {
    const first = (await t.state()).json.focus.seq;
    t.tick(1000);
    assert.equal((await t.state()).json.focus.seq, first, 'no change, no move');
    t.herdr.focused = 'w1:p2';
    t.tick(1000);
    const moved = (await t.state()).json.focus;
    assert.equal(moved.seq, first + 1);
    assert.equal(moved.session_id, B);
    t.herdr.panes[1] = { ...t.herdr.panes[1], agent_session: { value: C } };
    t.tick(1000);
    const cleared = (await t.state()).json.focus;
    assert.equal(cleared.seq, first + 2);
    assert.equal(cleared.session_id, C);
    assert.equal(cleared.listed, false);
    assert.equal(cleared.readable, true);
  } finally { await t.close(); }
});

test('state: following adds a focused session that has a log; not following never does', async () => {
  const t = await start();
  try {
    t.herdr.focused = 'w1:p3';
    await t.state(false);
    await t.settle();
    assert.deepEqual(t.herdr.readerRuns(), []);
    t.tick(5000);
    await t.state(true);
    await t.settle();
    assert.deepEqual(t.herdr.readerRuns(), [['follow', C]]);
    const run = t.herdr.calls.find((call) => call.file === 'python3');
    assert.equal(run.args[0], '-I');
    assert.match(run.args[1], /setup\/transcript-reader\/reader\.py$/);
  } finally { await t.close(); }
});

test('state: a listed log newer than the page starts one rebuild, spaced out', async () => {
  const t = await start();
  try {
    fs.writeFileSync(path.join(t.tree.outDir, 'prototype.stamp'), String(Date.now() / 1000 - 600));
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());  // the session wrote a new turn
    t.tick(5000);
    await t.state();
    await t.settle();
    assert.deepEqual(t.herdr.readerRuns(), [['rebuild']]);
    t.tick(1000);
    await t.state();
    await t.settle();
    assert.equal(t.herdr.readerRuns().length, 1, 'not again within the gap');
    fs.writeFileSync(path.join(t.tree.outDir, 'prototype.stamp'), String(Date.now() / 1000 + 60));
    t.tick(5000);
    await t.state();
    await t.settle();
    assert.equal(t.herdr.readerRuns().length, 1, 'a page newer than every log is left alone');
  } finally { await t.close(); }
});

test('state: a listed session whose pane closes starts one rebuild; Herdr not answering starts none', async () => {
  const t = await start();
  try {
    await t.state();
    await t.settle();
    const panes = t.herdr.panes;
    t.herdr.panes = panes.filter((pane) => pane.pane_id !== 'w1:p2');  // B's pane closed
    t.tick(5000);
    await t.state();
    await t.settle();
    assert.deepEqual(t.herdr.readerRuns(), [['rebuild']]);
    t.tick(5000);
    await t.state();
    await t.settle();
    assert.equal(t.herdr.readerRuns().length, 1, 'one closed pane, one rebuild');
    t.herdr.down = true;
    t.tick(5000);
    await t.state();
    await t.settle();
    assert.equal(t.herdr.readerRuns().length, 1, 'no panes listed is not a closed pane');
  } finally { await t.close(); }
});

test('state: a dropped session that runs in a pane again starts one rebuild, even when nothing is listed', async () => {
  const t = await start();
  try {
    fs.writeFileSync(path.join(t.tree.outDir, 'sessions.txt'), '');
    fs.writeFileSync(path.join(t.tree.outDir, 'dropped.txt'), `${C}\n`);  // C's pane is listed by the fake Herdr
    await t.state();
    await t.settle();
    assert.deepEqual(t.herdr.readerRuns(), [['rebuild']]);
    fs.writeFileSync(path.join(t.tree.outDir, 'dropped.txt'), '');  // reader.py listed it again
    t.tick(5000);
    await t.state();
    await t.settle();
    assert.equal(t.herdr.readerRuns().length, 1, 'once it is listed again, nothing more to rebuild');
  } finally { await t.close(); }
});

test('state: a failed rebuild shows until a page built after it, by hand say, ends it and its hold', async () => {
  const t = await start();
  try {
    fs.writeFileSync(path.join(t.tree.outDir, 'prototype.stamp'), String(Date.now() / 1000 - 600));
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());
    t.herdr.readerResult = { code: 1, stdout: '', stderr: 'Traceback\nValueError: broken', timedOut: false, truncated: false };
    t.tick(5000);
    await t.state();
    await t.settle();
    assert.equal((await t.state()).json.build.error, 'ValueError: broken');
    t.herdr.readerResult = null;
    t.tick(5000);
    await t.settle();
    assert.equal((await t.state()).json.build.error, 'ValueError: broken', 'held: no retry within 30 s');
    assert.equal(t.herdr.readerRuns().length, 1);
    fs.writeFileSync(path.join(t.tree.outDir, 'prototype.stamp'), String((Date.now() + 10000) / 1000));  // reader.py add, run by hand
    assert.equal((await t.state()).json.build.error, null);
    fs.utimesSync(t.tree.logOf(A), new Date(Date.now() + 20000), new Date(Date.now() + 20000));
    t.tick(5000);
    await t.state();
    await t.settle();
    assert.equal(t.herdr.readerRuns().length, 2, 'and the hold went with it');
  } finally { await t.close(); }
});

test('reopen and close: one click runs reader.py with that session and answers once it has rebuilt', async () => {
  const t = await start();
  try {
    const opened = await t.post('reopen', { session_id: C });
    assert.equal(opened.status, 200, opened.raw);
    const closed = await t.post('close', { session_id: B });
    assert.equal(closed.status, 200, closed.raw);
    assert.deepEqual(t.herdr.readerRuns(), [['reopen', C], ['close', B]]);
    assert.equal(t.herdr.agentCalls().length, 0, 'no pane is touched');
  } finally { await t.close(); }
});

test('reopen and close: bad input, a session without a log, an unlisted close and a foreign page are refused', async () => {
  const t = await start();
  try {
    const refused = [
      ['reopen', { session_id: C, extra: 1 }, 400],
      ['reopen', { session_id: 'not-an-id' }, 400],
      ['reopen', { session_id: 'dddddddd-4444-4444-8444-444444444444' }, 404],
      ['close', { session_id: C }, 409],
    ];
    for (const [command, body, status] of refused) assert.equal((await t.post(command, body)).status, status, command + ' ' + JSON.stringify(body));
    assert.equal((await t.post('reopen', { session_id: C }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.post('close', { session_id: A }, { [TOKEN_HEADER]: 'f'.repeat(64) })).status, 403);
    assert.deepEqual(t.herdr.readerRuns(), []);
  } finally { await t.close(); }
});

test('send: the exact text goes to the one pane running the session, with no Herdr context inherited', async () => {
  const t = await start({ env: { HERDR_PANE_ID: 'w9:p9', HERDR_SESSION: 'other', PATH: '/usr/bin' } });
  try {
    const text = 'Re your reply at 10:57 ("Checkpoint for group A"): A2=link-only\nand a second line';
    const response = await t.send({ session_id: B, text });
    assert.equal(response.status, 200, response.raw);
    assert.equal(response.json.label, 'fm-task-tab');
    const prompts = t.herdr.prompts();
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].args, ['--session', 'work', 'agent', 'prompt', 'w1:p2', text]);
    assert.equal(prompts[0].env.HERDR_PANE_ID, undefined);
    assert.equal(prompts[0].env.HERDR_SESSION, undefined);
  } finally { await t.close(); }
});

test('send: bad input, unlisted sessions, missing panes and blocked or unknown agents are refused before Herdr is asked', async () => {
  const t = await start();
  try {
    const refused = [
      [{ session_id: A, text: 'hi', extra: 1 }, 400],
      [{ session_id: 'not-an-id', text: 'hi' }, 400],
      [{ session_id: A, text: '   ' }, 400],
      [{ session_id: A, text: 'hi \u001b[201~ rm -rf ~' }, 400],
      [{ session_id: A, text: '--help' }, 400],
      [{ session_id: A, text: 'x'.repeat(4001) }, 413],
      [{ session_id: C, text: 'hi' }, 409],
    ];
    for (const [body, status] of refused) assert.equal((await t.send(body)).status, status, JSON.stringify(body).slice(0, 60));
    t.herdr.panes = t.herdr.panes.filter((pane) => pane.pane_id !== 'w1:p1');
    const gone = await t.send({ session_id: A, text: 'hi' });
    assert.equal(gone.status, 409);
    assert.equal(gone.json.code, 'no_pane');
    t.herdr.panes[0] = { ...t.herdr.panes[0], agent_status: 'blocked' };
    const blocked = await t.send({ session_id: B, text: 'hi' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'agent_blocked');
    t.herdr.panes[0] = { ...t.herdr.panes[0], agent_status: 'unknown' };
    const unknown = await t.send({ session_id: B, text: 'hi' });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.json.code, 'agent_unknown');
    assert.equal(t.herdr.agentCalls().length, 0);
  } finally { await t.close(); }
});

test('send: nothing goes unless the pane\'s foreground holds Claude running that session', async () => {
  const t = await start();
  try {
    fs.mkdirSync(t.tree.claudeSessionsDir);
    // This test process stands in for a running Claude; its record names the session it holds.
    const runs = (id) => fs.writeFileSync(path.join(t.tree.claudeSessionsDir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: id }));
    const refused = async (code, status = 409) => {
      const response = await t.send({ session_id: B, text: 'hi' });
      assert.equal(response.status, status, response.raw);
      assert.equal(response.json.code, code);
    };
    // Claude suspended with Ctrl+Z: Herdr keeps the agent and its last state, but zsh is in front.
    t.herdr.processInfo['w1:p2'] = [{ pid: 4242, argv0: 'zsh' }];
    await refused('agent_not_foreground');
    t.herdr.processInfo['w1:p2'] = [];
    await refused('agent_not_foreground');
    // A Claude in front whose record names another session.
    runs(C);
    t.herdr.processInfo['w1:p2'] = [{ pid: process.pid, argv0: 'claude' }];
    await refused('other_session');
    assert.equal(t.herdr.agentCalls().length, 0, 'no key and no prompt reached the pane');
    // The pane's own Claude, by its record, even when Herdr names the process by its version.
    runs(B);
    t.herdr.processInfo['w1:p2'] = [{ pid: 4243, argv0: 'caffeinate' }, { pid: process.pid, argv0: '2.1.309' }];
    const sent = await t.send({ session_id: B, text: 'hi' });
    assert.equal(sent.status, 200, sent.raw);
    assert.equal(t.herdr.prompts().length, 1);
  } finally { await t.close(); }
});

test('send: the pane\'s input box is emptied, a few keys at a time, before the message goes', async () => {
  const t = await start();
  try {
    const sent = await t.send({ session_id: B, text: 'hi' });
    assert.equal(sent.status, 200, sent.raw);
    const agent = t.herdr.agentCalls();
    const keys = t.herdr.keys();
    assert.equal(keys.length, 25);
    assert.deepEqual(agent.slice(0, keys.length), keys, 'every clearing call comes before the prompt');
    assert.deepEqual(agent[agent.length - 1].args, ['--session', 'work', 'agent', 'prompt', 'w1:p2', 'hi']);
    for (const call of keys) {
      assert.deepEqual(call.args.slice(0, 5), ['--session', 'work', 'agent', 'send-keys', 'w1:p2']);
      // Only line-deleting keys: never ctrl+c or esc, which would stop a working agent.
      assert.deepEqual(call.args.slice(5), ['ctrl+k', 'ctrl+u', 'ctrl+k', 'ctrl+u', 'ctrl+k', 'ctrl+u', 'ctrl+k', 'ctrl+u']);
    }
  } finally { await t.close(); }
});

test('send: when Herdr cannot empty the input box, the message is not sent', async () => {
  const t = await start();
  try {
    t.herdr.keysResult = { code: 1, stdout: '', stderr: 'socket gone' };
    const failed = await t.send({ session_id: A, text: 'hi' });
    assert.equal(failed.status, 502);
    assert.equal(failed.json.code, 'herdr_failed');
    assert.equal(t.herdr.keys().length, 1);
    assert.equal(t.herdr.prompts().length, 0);
  } finally { await t.close(); }
});

test('send: a message of several lines goes to Herdr as one prompt', async () => {
  const t = await start();
  try {
    const sent = await t.send({ session_id: A, text: 'first line\r\n\n- second line\n\tindented' });
    assert.equal(sent.status, 200);
    assert.deepEqual(t.herdr.prompts().map((call) => call.args[call.args.length - 1]), ['first line\n\n- second line\n\tindented']);
  } finally { await t.close(); }
});

test('send: a refusal from Herdr is reported, not claimed as sent', async () => {
  const t = await start();
  try {
    t.herdr.promptResult = { code: 1, stdout: '', stderr: 'error: agent_blocked' };
    const blocked = await t.send({ session_id: A, text: 'hi' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'agent_blocked');
    t.herdr.promptResult = { code: 1, stdout: '', stderr: 'socket gone' };
    const failed = await t.send({ session_id: A, text: 'hi' });
    assert.equal(failed.status, 502);
    assert.equal(failed.json.code, 'herdr_failed');
  } finally { await t.close(); }
});
