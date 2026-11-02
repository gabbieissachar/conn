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
const { spawnSync } = require('child_process');
const zlib = require('zlib');
const { create, namesReaderOut, PHOTO_LIMITS, TOKEN_HEADER, TOKEN_META, COPY_HEADER } = require('./api');

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';
const Q = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1';  // a queued send's id

// A built page as build_prototype.write_page leaves it: the token tag unfilled, and the
// payload escaping "<" (here it quotes a transcript that mentions the tag's placeholder).
const builtPage = (title) => `<!doctype html><head>${TOKEN_META}<title>${title}</title></head>`
  + '<script id="payload" type="application/json">{"text":"\\u003cmeta name=\\"reader-token\\" content=\\"__READER_TOKEN__\\">"}</script>';
const tokenIn = (html) => (html.match(/<meta name="reader-token" content="([^"]*)">/) || [])[1];

function writeCodexLog(tree, id, cwd) {
  const file = path.join(tree.codexSessionsDir, '2026', '11', '02', 'rollout-' + id + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', timestamp: '2026-11-02T10:00:00Z', payload: { id, session_id: id, cwd, source: 'cli' } }) + '\n');
  return file;
}

function fixtureTree({ outParts = ['setup', 'transcript-reader', 'out'] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-reader-'));
  const root = path.join(base, 'repo');
  const outDir = path.join(root, ...outParts);
  const projectsDir = path.join(base, 'projects');
  const claudeSessionsDir = path.join(base, 'sessions');  // no running Claude unless a test writes one
  const codexSessionsDir = path.join(base, 'codex-sessions');  // no Codex rollout unless a test writes one
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(projectsDir, '-Users-someone-home'), { recursive: true });
  fs.mkdirSync(codexSessionsDir, { recursive: true });
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
  // The pins file lives outside the repo; a test gets one inside its own temporary folder, never the owner's.
  const pinsFile = path.join(base, 'config', 'pmos-transcript-reader', 'pins.json');
  const starsFile = path.join(base, 'config', 'pmos-transcript-reader', 'stars.json');
  return { root, outDir, projectsDir, claudeSessionsDir, codexSessionsDir, pinsFile, starsFile, logOf: (id) => path.join(projectsDir, '-Users-someone-home', id + '.jsonl'), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
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
    pauses: [],
    sipsCalls: [],
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
      const info = herdr.processInfo[args[5]];
      return ok(JSON.stringify({ result: { process_info: { foreground_processes: (typeof info === 'function' ? info() : info) || [] } } }));
    }
    if (file === 'herdr' && args[2] === 'agent' && args[3] === 'prompt') return { timedOut: false, truncated: false, ...herdr.promptResult };
    if (file === 'herdr' && args[2] === 'agent' && args[3] === 'send-keys') return { timedOut: false, truncated: false, ...herdr.keysResult };
    if (file === 'sips') { herdr.sipsCalls.push(args.slice()); return herdr.sips ? herdr.sips(args) : { code: 1, stdout: '', stderr: 'sips is not set up', timedOut: false, truncated: false }; }  // the HEIC converter, when a test gives one
    if (file === 'python3') { if (herdr.readerGate) await herdr.readerGate; return herdr.readerResult || ok(''); }  // reader.py; a test may make it fail, or hold it
    return { code: 1, stdout: '', stderr: 'unexpected command', timedOut: false, truncated: false };
  };
  herdr.prompts = () => herdr.calls.filter((call) => call.args[2] === 'agent' && call.args[3] === 'prompt');
  herdr.keys = () => herdr.calls.filter((call) => call.args[2] === 'agent' && call.args[3] === 'send-keys');
  herdr.agentCalls = () => herdr.calls.filter((call) => call.args[2] === 'agent');
  herdr.readerRuns = () => herdr.calls.filter((call) => call.file === 'python3').map((call) => call.args.slice(2));
  return herdr;
}

async function start({ env = {}, outParts, options = {} } = {}) {  // options: more for create(), or a function of the fake Herdr that gives them
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
  api = create({ root: tree.root, outDir: tree.outDir, port, runner: herdr.runner, env, projectsDir: tree.projectsDir, claudeSessionsDir: tree.claudeSessionsDir, codexSessionsDir: tree.codexSessionsDir, pinsFile: tree.pinsFile, starsFile: tree.starsFile, now: () => clock, pause: async () => {}, rebuildEveryMs: 0, ...(typeof options === 'function' ? options(herdr, tree) : options) });  // no limit on how often rebuilds start, but where a test asks for one
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
  const get = (command, headers = {}) => request({ path: '/api/transcript-reader/' + command, headers: { [TOKEN_HEADER]: token, ...headers } });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    tree, herdr, request, open, token, state, send, post, get, settle, origin, api,
    tick: (ms) => { clock += ms; },
    close: () => new Promise((resolve) => { api.close(); server.close(() => { tree.cleanup(); resolve(); }); }),
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

// The hosted copy sync.py writes into out/hosted/: its shell, an index, objects, and the manifest beside them.
function writeHosted(outDir) {
  const hosted = path.join(outDir, 'hosted');
  for (const folder of ['s', 'd', 'f', 'a', 't', 'r']) fs.mkdirSync(path.join(hosted, folder), { recursive: true });
  fs.writeFileSync(path.join(hosted, 'r', Q + '.json'), JSON.stringify({ id: Q, state: 'sent' }));
  fs.writeFileSync(path.join(hosted, 'index.html'), builtPage('hosted shell'));
  fs.writeFileSync(path.join(hosted, 'sheet.html'), builtPage('hosted sheet'));
  fs.writeFileSync(path.join(hosted, 'a', A + '.json'), JSON.stringify({ questionnaires: [] }));
  fs.writeFileSync(path.join(hosted, 't', A + '.json'), JSON.stringify({ outputs: { 'turn:0': 'tool output' } }));
  fs.writeFileSync(path.join(hosted, 'index.json'), JSON.stringify({ as_of: 1, conversations: [{ id: A, object: `s/${A}.json` }] }));
  fs.writeFileSync(path.join(hosted, 's', A + '.json'), JSON.stringify({ id: A, exchanges: [] }));
  fs.writeFileSync(path.join(hosted, 'd', 'abc123.json'), JSON.stringify({ id: 'abc123', text: '# Notes' }));
  fs.writeFileSync(path.join(hosted, 'f', '2026-W43.json'), JSON.stringify({ events: [] }));
  fs.writeFileSync(path.join(hosted, 'manifest.json'), JSON.stringify({ conversations: { [A]: { members: ['/x/' + A + '.jsonl'] } } }));
  fs.writeFileSync(path.join(hosted, 'pane-labels.json'), JSON.stringify({ [A]: { label: 'alpha' } }));
}

test('hosted: the shell opens in a tab like a page, with the token in its tag, and never in a frame', async () => {
  const t = await start();
  try {
    assert.equal((await t.open('/setup/transcript-reader/out/hosted/index.html')).status, 404, 'not built yet');
    writeHosted(t.tree.outDir);
    const shell = await t.open('/setup/transcript-reader/out/hosted/index.html');
    assert.equal(shell.status, 200);
    assert.equal(tokenIn(shell.raw), t.token);
    const sheet = await t.open('/setup/transcript-reader/out/hosted/sheet.html');
    assert.equal(sheet.status, 200);
    assert.equal(tokenIn(sheet.raw), t.token);
    assert.equal(shell.headers['content-security-policy'], "frame-ancestors 'none'");
    assert.equal(shell.headers['x-frame-options'], 'DENY');
    assert.equal(Object.keys(shell.headers).some((name) => name.startsWith('access-control')), false);
    const framed = await t.request({ path: '/setup/transcript-reader/out/hosted/index.html', headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' } });
    assert.equal(framed.status, 403);
  } finally { await t.close(); }
});

test('hosted: the shell\'s own token-bearing fetch gets each object; without the token, or cross-site, nothing', async () => {
  const t = await start();
  try {
    writeHosted(t.tree.outDir);
    const fetchHeaders = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
    for (const name of ['index.json', `s/${A}.json`, 'd/abc123.json', 'f/2026-W43.json', `a/${A}.json`, `t/${A}.json`, `r/${Q}.json`]) {
      const urlPath = '/setup/transcript-reader/out/hosted/' + name;
      const got = await t.request({ path: urlPath, headers: { ...fetchHeaders, [TOKEN_HEADER]: t.token } });
      assert.equal(got.status, 200, name);
      assert.equal(got.raw, fs.readFileSync(path.join(t.tree.outDir, 'hosted', name), 'utf8'), name);
      assert.equal(got.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(got.headers['cache-control'], 'no-store');
      assert.equal(Object.keys(got.headers).some((header) => header.startsWith('access-control')), false);
      for (const headers of [fetchHeaders, { ...fetchHeaders, [TOKEN_HEADER]: 'b'.repeat(64) }, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
        { 'Sec-Fetch-Site': 'cross-site', [TOKEN_HEADER]: t.token }, { Origin: 'http://evil.example', [TOKEN_HEADER]: t.token }]) {
        const refused = await t.request({ path: urlPath, headers });
        assert.equal(refused.status, 403, name + ' ' + JSON.stringify(headers));
        assert.doesNotMatch(refused.raw, /exchanges|Notes|events|as_of|questionnaires|tool output/);
      }
    }
    const missing = await t.request({ path: '/setup/transcript-reader/out/hosted/s/' + B + '.json', headers: { ...fetchHeaders, [TOKEN_HEADER]: t.token } });
    assert.equal(missing.status, 404);
  } finally { await t.close(); }
});

test('hosted: the manifest, the pane cache and any other name or spelling are never served, nor handed to the static handler', async () => {
  const t = await start();
  try {
    writeHosted(t.tree.outDir);
    const headers = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', [TOKEN_HEADER]: t.token };
    for (const name of ['manifest.json', 'pane-labels.json', `s/../manifest.json`, 's/', 'x/a.json', `s/${A}.jsonl`, 'index.json.partial', `s%2F${A}.json`, 's/sub/a.json']) {
      const response = await t.request({ path: '/setup/transcript-reader/out/hosted/' + name, headers });
      assert.equal(response.headers['x-static'], undefined, name);
      if (name !== `s%2F${A}.json`) assert.equal(response.status, 404, name);
      assert.doesNotMatch(response.raw, /members|alpha/, name);
    }
    const plain = await t.request({ path: '/setup/transcript-reader/out/hosted/manifest.json' });
    assert.equal(plain.headers['x-static'], undefined);
    assert.doesNotMatch(plain.raw, /members/);
  } finally { await t.close(); }
});

test('bucket: the sealed copy of a seal run is served like the hosted copy: its shell to a tab, its params and sealed objects to the shell', async () => {
  const t = await start();
  try {
    const bucket = path.join(t.tree.outDir, 'bucket');
    for (const folder of ['k', 's', 'd', 'f']) fs.mkdirSync(path.join(bucket, folder), { recursive: true });
    fs.writeFileSync(path.join(bucket, 'index.html'), builtPage('sealed shell'));
    fs.writeFileSync(path.join(bucket, 'k', 'params.json'), '{"kdf":"PBKDF2"}');
    fs.writeFileSync(path.join(bucket, 'index.json.enc'), Buffer.from([0x48, 0x52, 0x43, 0x31, 1, 2, 3]));
    fs.writeFileSync(path.join(bucket, 's', A + '.json.enc'), Buffer.from([0x48, 0x52, 0x43, 0x31, 4]));
    fs.writeFileSync(path.join(bucket, 'notes.txt'), 'not served');
    const shell = await t.open('/setup/transcript-reader/out/bucket/index.html');
    assert.equal(shell.status, 200);
    assert.equal(tokenIn(shell.raw), t.token);
    const fetchHeaders = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', [TOKEN_HEADER]: t.token };
    const params = await t.request({ path: '/setup/transcript-reader/out/bucket/k/params.json', headers: fetchHeaders });
    assert.equal(params.status, 200);
    assert.equal(params.headers['content-type'], 'application/json; charset=utf-8');
    for (const name of ['index.json.enc', `s/${A}.json.enc`]) {
      const got = await t.request({ path: '/setup/transcript-reader/out/bucket/' + name, headers: fetchHeaders });
      assert.equal(got.status, 200, name);
      assert.equal(got.headers['content-type'], 'application/octet-stream');
      assert.equal(Object.keys(got.headers).some((header) => header.startsWith('access-control')), false);
      const refused = await t.request({ path: '/setup/transcript-reader/out/bucket/' + name, headers: { 'Sec-Fetch-Site': 'same-origin' } });
      assert.equal(refused.status, 403, name);
    }
    for (const name of ['notes.txt', 'index.json', `s/${A}.json`, 'k/other.json', 'upload.json']) {
      const response = await t.request({ path: '/setup/transcript-reader/out/bucket/' + name, headers: fetchHeaders });
      assert.equal(response.status, 404, name);
      assert.equal(response.headers['x-static'], undefined, name);
    }
    const plainParams = await t.request({ path: '/setup/transcript-reader/out/hosted/k/params.json', headers: fetchHeaders });
    assert.equal(plainParams.status, 404, 'the plain copy has no params, so its shell reads it as plain');
  } finally { await t.close(); }
});

// A sealed request as the page writes it: the envelope's magic, a nonce and ciphertext (nothing here opens it).
const sealedBytes = (n = 60) => Buffer.concat([Buffer.from('HRC1'), Buffer.alloc(n, 7)]);

test('queue: a hosted page\'s Send writes its request into the copy\'s q/ and sends nothing to Herdr', async () => {
  const t = await start();
  try {
    const request = { copy: 'hosted', id: Q, object: { session_id: A, text: 'A1=accept;A2=inline', at: 1761441000.5 } };
    const response = await t.post('queue', request);
    assert.equal(response.status, 200, response.raw);
    assert.deepEqual(response.json, { status: 'ok', id: Q, queued: 1 });
    const file = path.join(t.tree.outDir, 'hosted', 'q', Q + '.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { id: Q, session_id: A, text: 'A1=accept;A2=inline', at: 1761441000.5 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(t.herdr.calls.length, 0, 'queueing never reaches Herdr');
    assert.equal((await t.post('queue', request)).status, 409, 'a request is written once');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).text, 'A1=accept;A2=inline');
    // The queue is write-only from the page: nothing under q/ is served, to anyone.
    const headers = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', [TOKEN_HEADER]: t.token };
    for (const name of [`q/${Q}.json`, 'q/']) {
      const got = await t.request({ path: '/setup/transcript-reader/out/hosted/' + name, headers });
      assert.equal(got.status, 404, name);
      assert.equal(got.headers['x-static'], undefined, name);
    }
  } finally { await t.close(); }
});

test('queue: a sealed page\'s request is stored as the bytes it made, which this server cannot open', async () => {
  const t = await start();
  try {
    const bytes = sealedBytes();
    const response = await t.post('queue', { copy: 'bucket', id: Q, data: bytes.toString('base64') });
    assert.equal(response.status, 200, response.raw);
    const file = path.join(t.tree.outDir, 'bucket', 'q', Q + '.json.enc');
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(t.tree.outDir, 'hosted', 'q')), false);
    // Not sealed at all (no magic), too short, or not base64: refused, and nothing is written.
    for (const data of [Buffer.alloc(80, 1).toString('base64'), Buffer.from('HRC1abc').toString('base64'), '!!not base64!!', '']) {
      const refused = await t.post('queue', { copy: 'bucket', id: '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaa2', data });
      assert.equal(refused.status, 400, data.slice(0, 20));
    }
    assert.deepEqual(fs.readdirSync(path.join(t.tree.outDir, 'bucket', 'q')), [Q + '.json.enc']);
    const room = await t.post('queue', { copy: 'bucket', id: '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaa3', data: sealedBytes(40000).toString('base64') });
    assert.equal(room.status, 200, 'a sealed 4000-character message fits');
    assert.equal((await t.post('queue', { copy: 'bucket', id: '44444444-aaaa-4aaa-8aaa-aaaaaaaaaaa4', data: sealedBytes(70000).toString('base64') })).status, 413);
  } finally { await t.close(); }
});

test('queue: bad requests are refused whole, as send refuses them, and write nothing', async () => {
  const t = await start();
  try {
    const good = { session_id: A, text: 'hello', at: 1 };
    const bad = [
      { copy: 'elsewhere', id: Q, object: good }, { copy: 'hosted', id: 'not-a-uuid', object: good }, { copy: 'hosted', id: Q },
      { copy: 'hosted', id: Q, object: { ...good, session_id: '../../etc' } }, { copy: 'hosted', id: Q, object: { ...good, text: '' } },
      { copy: 'hosted', id: Q, object: { ...good, text: '--help' } }, { copy: 'hosted', id: Q, object: { ...good, text: 'a\u001b[201~b' } },
      { copy: 'hosted', id: Q, object: { ...good, text: 'x'.repeat(4001) } }, { copy: 'hosted', id: Q, object: { ...good, at: 'now' } },
      { copy: 'hosted', id: Q, object: { ...good, extra: 1 } }, { copy: 'hosted', id: Q, object: good, data: 'AAAA' }, { copy: 'hosted', id: Q, object: good, other: 1 },
      { copy: 'bucket', id: Q, object: good },
    ];
    for (const body of bad) assert.equal((await t.post('queue', body)).status >= 400, true, JSON.stringify(body).slice(0, 80));
    assert.equal(fs.existsSync(path.join(t.tree.outDir, 'hosted', 'q')), false);
    assert.equal(fs.existsSync(path.join(t.tree.outDir, 'bucket', 'q')), false);
    // Every route's own guard: the token, the origin and JSON.
    const ok = { copy: 'hosted', id: Q, object: good };
    assert.equal((await t.post('queue', ok, { [TOKEN_HEADER]: 'b'.repeat(64) })).status, 403);
    assert.equal((await t.post('queue', ok, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await t.post('queue', ok, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await t.request({ method: 'GET', path: '/api/transcript-reader/queue', headers: { [TOKEN_HEADER]: t.token } })).status, 404);
    assert.equal(fs.existsSync(path.join(t.tree.outDir, 'hosted', 'q')), false);
  } finally { await t.close(); }
});

test('queue: a full queue takes no more until drain.js has sent what is in it', async () => {
  const t = await start();
  try {
    const id = (n) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    for (let n = 1; n <= 50; n += 1) assert.equal((await t.post('queue', { copy: 'hosted', id: id(n), object: { session_id: A, text: 'm' + n, at: 1 } })).status, 200, 'request ' + n);
    const full = await t.post('queue', { copy: 'hosted', id: id(51), object: { session_id: A, text: 'one more', at: 1 } });
    assert.equal(full.status, 429);
    assert.equal(full.json.code, 'queue_full');
    assert.equal(fs.existsSync(path.join(t.tree.outDir, 'hosted', 'q', id(51) + '.json')), false);
  } finally { await t.close(); }
});

// Taking a queued message back (the page's Undo). The request waits in q/, and the drain claims it by renaming it to
// <name>.claimed; unqueue renames the same file to a tombstone, so exactly one of them has it.
const waitingFile = (t, copy, id = Q) => path.join(t.tree.outDir, copy, 'q', id + (copy === 'bucket' ? '.json.enc' : '.json'));
const tombstoneFile = (t, copy, id = Q) => path.join(t.tree.outDir, copy, 'q', '.cancelled-' + id);
const queuePlain = (t, id = Q, text = 'hello') => t.post('queue', { copy: 'hosted', id, object: { session_id: A, text, at: 1761441000.5 } });

test('unqueue: a message still waiting is taken out of the queue, so no drain can send it, and its text is not kept', async () => {
  const t = await start();
  try {
    assert.equal((await queuePlain(t, Q, 'a message I will take back')).status, 200);
    const gone = await t.post('unqueue', { copy: 'hosted', id: Q });
    assert.equal(gone.status, 200, gone.raw);
    assert.deepEqual(gone.json, { status: 'ok', state: 'cancelled' });
    assert.equal(fs.existsSync(waitingFile(t, 'hosted')), false, 'nothing waits for the drain');
    assert.equal(fs.readFileSync(tombstoneFile(t, 'hosted'), 'utf8'), '', 'the tombstone holds no text');
    assert.equal(fs.statSync(tombstoneFile(t, 'hosted')).mode & 0o777, 0o600);
    assert.equal(t.herdr.calls.length, 0, 'taking back never reaches Herdr');
    assert.deepEqual((await t.post('unqueue', { copy: 'hosted', id: Q })).json, { status: 'ok', state: 'cancelled' }, 'asking again says the same');
  } finally { await t.close(); }
});

test('unqueue: a sealed request is taken back without being opened', async () => {
  const t = await start();
  try {
    const bytes = sealedBytes();
    assert.equal((await t.post('queue', { copy: 'bucket', id: Q, data: bytes.toString('base64') })).status, 200);
    const gone = await t.post('unqueue', { copy: 'bucket', id: Q });
    assert.deepEqual(gone.json, { status: 'ok', state: 'cancelled' });
    assert.equal(fs.existsSync(waitingFile(t, 'bucket')), false);
    assert.equal(fs.readFileSync(tombstoneFile(t, 'bucket'), 'utf8'), '');
  } finally { await t.close(); }
});

test('unqueue: too late once the drain has the message (claimed, or its receipt is written), and nothing is changed', async () => {
  const t = await start();
  try {
    assert.equal((await queuePlain(t)).status, 200);
    // The drain's claim: the same rename, to the name drain.js uses.
    fs.renameSync(waitingFile(t, 'hosted'), waitingFile(t, 'hosted') + '.claimed');
    const late = await t.post('unqueue', { copy: 'hosted', id: Q });
    assert.deepEqual(late.json, { status: 'ok', state: 'too_late' });
    assert.equal(fs.existsSync(waitingFile(t, 'hosted') + '.claimed'), true, 'the claimed request is left alone');
    assert.equal(fs.existsSync(tombstoneFile(t, 'hosted')), false, 'no tombstone: the message is not taken back');
    // After the drain is done the request is gone and the receipt is what is left.
    fs.unlinkSync(waitingFile(t, 'hosted') + '.claimed');
    fs.mkdirSync(path.join(t.tree.outDir, 'hosted', 'r'), { recursive: true });
    fs.writeFileSync(path.join(t.tree.outDir, 'hosted', 'r', Q + '.json'), '{"state":"sent"}');
    assert.deepEqual((await t.post('unqueue', { copy: 'hosted', id: Q })).json, { status: 'ok', state: 'too_late' });
    // A sealed copy's receipt is r/<id>.json.enc.
    const S = '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
    fs.mkdirSync(path.join(t.tree.outDir, 'bucket', 'r'), { recursive: true });
    fs.writeFileSync(path.join(t.tree.outDir, 'bucket', 'r', S + '.json.enc'), sealedBytes());
    assert.deepEqual((await t.post('unqueue', { copy: 'bucket', id: S })).json, { status: 'ok', state: 'too_late' });
    assert.equal(fs.existsSync(tombstoneFile(t, 'bucket', S)), false);
  } finally { await t.close(); }
});

test('unqueue: a message this server never had (a held send whose post was lost) is refused if it turns up later', async () => {
  const t = await start();
  try {
    const first = await t.post('unqueue', { copy: 'hosted', id: Q });
    assert.deepEqual(first.json, { status: 'ok', state: 'cancelled' });
    assert.equal(fs.existsSync(tombstoneFile(t, 'hosted')), true);
    const late = await queuePlain(t, Q, 'the post that was delayed');
    assert.equal(late.status, 409);
    assert.equal(late.json.code, 'cancelled');
    assert.equal(fs.existsSync(waitingFile(t, 'hosted')), false, 'it is not queued');
    // The same for a sealed copy.
    assert.equal((await t.post('unqueue', { copy: 'bucket', id: Q })).json.state, 'cancelled');
    const sealedLate = await t.post('queue', { copy: 'bucket', id: Q, data: sealedBytes().toString('base64') });
    assert.equal(sealedLate.status, 409);
    assert.equal(sealedLate.json.code, 'cancelled');
    // Another id is not affected.
    assert.equal((await queuePlain(t, '66666666-aaaa-4aaa-8aaa-aaaaaaaaaaa6')).status, 200);
  } finally { await t.close(); }
});

test('unqueue: bad requests are refused, behind the same guard as every route, and change nothing', async () => {
  const t = await start();
  try {
    assert.equal((await queuePlain(t)).status, 200);
    for (const body of [{ copy: 'elsewhere', id: Q }, { copy: 'hosted', id: 'not-a-uuid' }, { copy: 'hosted', id: '../../etc/passwd' }, { copy: 'hosted' }, { id: Q },
      { copy: 'hosted', id: Q, extra: 1 }, { copy: 'hosted', id: Q, object: {} }]) {
      assert.equal((await t.post('unqueue', body)).status, 400, JSON.stringify(body));
    }
    const ok = { copy: 'hosted', id: Q };
    assert.equal((await t.post('unqueue', ok, { [TOKEN_HEADER]: 'b'.repeat(64) })).status, 403);
    assert.equal((await t.post('unqueue', ok, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await t.post('unqueue', ok, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await t.request({ method: 'GET', path: '/api/transcript-reader/unqueue', headers: { [TOKEN_HEADER]: t.token } })).status, 404);
    assert.equal(fs.existsSync(waitingFile(t, 'hosted')), true, 'the message is still waiting');
    assert.equal(fs.existsSync(tombstoneFile(t, 'hosted')), false);
  } finally { await t.close(); }
});

test('unqueue: a message taken back leaves room in the queue, and the tombstones are capped', async () => {
  const t = await start();
  try {
    const id = (n) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    for (let n = 1; n <= 50; n += 1) assert.equal((await queuePlain(t, id(n), 'm' + n)).status, 200);
    assert.equal((await queuePlain(t, id(51))).status, 429);
    assert.equal((await t.post('unqueue', { copy: 'hosted', id: id(7) })).json.state, 'cancelled');
    assert.equal((await queuePlain(t, id(51))).status, 200, 'the slot it held is free again');
    // Tombstones for messages never seen are bounded.
    const ghost = (n) => `${String(n).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    let refused = 0;
    for (let n = 1; n <= 210; n += 1) if ((await t.post('unqueue', { copy: 'bucket', id: ghost(n) })).status === 429) refused += 1;
    assert.ok(refused >= 1 && refused <= 11, 'about 200 are kept, then it says to try later: ' + refused);
  } finally { await t.close(); }
});

test('send: the drain\'s own list of sendable sessions replaces the reading list, and nothing else in the checks', async () => {
  const tree = fixtureTree();
  const herdr = fakeHerdr();
  try {
    // C has a live pane but is on no reading list; the list given here names it, and not A.
    const api = create({ root: tree.root, outDir: tree.outDir, port: 1, runner: herdr.runner, projectsDir: tree.projectsDir, claudeSessionsDir: tree.claudeSessionsDir, pause: async () => {}, sendable: () => [C] });
    assert.deepEqual(await api.sendPrompt({ session_id: C, text: 'hello' }), { label: 'unlisted', herdr: 'work', status: 'idle' });
    await assert.rejects(api.sendPrompt({ session_id: A, text: 'hello' }), (error) => error.code === 'not_listed');
    herdr.panes[2].agent_status = 'blocked';
    await assert.rejects(api.sendPrompt({ session_id: C, text: 'hello' }), (error) => error.code === 'agent_blocked');
    assert.equal(herdr.prompts().length, 1);
  } finally { tree.cleanup(); }
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

test('state: a pane whose agent has exited still holds its session id in Herdr, and runs no session', async () => {
  const t = await start();
  try {
    // The reported bug: A's Claude ended and its pane is back at the shell. Herdr keeps A's id and drops the agent
    // (the pane lists no agent, its state is unknown), so the id alone made A look live. B still runs in its pane.
    fs.mkdirSync(t.tree.claudeSessionsDir);
    fs.writeFileSync(path.join(t.tree.claudeSessionsDir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: A }));
    fs.writeFileSync(path.join(t.tree.claudeSessionsDir, process.ppid + '.json'), JSON.stringify({ pid: process.ppid, sessionId: B }));
    t.herdr.panes = t.herdr.panes.map((pane) => (pane.agent_session ? { ...pane, agent: 'claude' } : pane));
    t.herdr.processInfo = { 'w1:p1': [{ pid: process.pid, argv0: 'claude' }], 'w1:p2': [{ pid: process.ppid, argv0: 'claude' }], 'w1:p3': [{ pid: 4243, argv0: 'claude' }] };
    assert.deepEqual(Object.keys((await t.state()).json.panes).sort(), [A, B]);
    await t.settle();
    const before = t.herdr.readerRuns().length;
    // Claude exits: no live process holds its record any more, the pane's foreground is the shell, Herdr keeps the id but names no agent.
    fs.writeFileSync(path.join(t.tree.claudeSessionsDir, process.pid + '.json'), JSON.stringify({ pid: 999999999, sessionId: A }));
    t.herdr.panes[0] = { pane_id: 'w1:p1', tab_id: 'w1:t1', label: 'leader-alpha', agent_status: 'unknown', agent_session: { value: A } };
    t.herdr.processInfo['w1:p1'] = [{ pid: 4242, argv0: 'zsh' }];
    t.tick(5000);
    const { json } = await t.state();
    assert.deepEqual(Object.keys(json.panes), [B], 'the pane that kept A\'s id no longer shows A as running');
    await t.settle();
    assert.equal(t.herdr.readerRuns().length, before + 1, 'and the page is rebuilt, which records that A\'s pane no longer runs it');
    assert.deepEqual(t.herdr.readerRuns().slice(-1), [['rebuild']]);
    // The same pane with Claude in its foreground (no record: Herdr's word stands) still shows the session.
    t.herdr.processInfo['w1:p1'] = [{ pid: 4242, argv0: 'claude' }];
    t.tick(5000);
    assert.deepEqual(Object.keys((await t.state()).json.panes).sort(), [A, B]);
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
    t.tick(100);
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

test('sync: a click reads Herdr again and rebuilds at once, even when no log looks newer, and answers with the state and when it finished', async () => {
  const t = await start();
  try {
    const before = t.herdr.calls.filter((call) => call.args[3] === 'snapshot').length;
    t.tick(1000);
    const synced = await t.post('sync', {});
    assert.equal(synced.status, 200, synced.raw);
    assert.deepEqual(t.herdr.readerRuns(), [['rebuild']], 'the page is newer than every log, and it is rebuilt all the same');
    assert.equal(typeof synced.json.synced, 'number');
    assert.ok(Math.abs(synced.json.synced - (Date.now() / 1000 + 1)) < 5, 'when it finished, by the server\'s clock');
    assert.deepEqual(Object.keys(synced.json.panes).sort(), [A, B], 'the state of each listed session comes with it');
    assert.equal(synced.json.build.error, null);
    assert.ok(t.herdr.calls.filter((call) => call.args[3] === 'snapshot').length > before, 'Herdr was read again');
    assert.equal(t.herdr.agentCalls().length, 0, 'no pane is touched');
    t.tick(5000);
    assert.equal((await t.post('sync', { follow: true })).status, 200);
    assert.deepEqual(t.herdr.readerRuns(), [['rebuild'], ['rebuild']], 'every click rebuilds');
    // A session that stopped running since the last look is seen at once, and the page built for it.
    t.herdr.panes = t.herdr.panes.filter((pane) => pane.pane_id !== 'w1:p2');
    t.tick(5000);
    const after = await t.post('sync', {});
    assert.deepEqual(Object.keys(after.json.panes), [A]);
  } finally { await t.close(); }
});

// The reading list's blind side: live panes running Claude whose session is not listed. Their logs sit beside the listed ones'.
const D = 'dddddddd-4444-4444-8444-444444444444';  // Claude in a pane, with a log
const E = 'eeeeeeee-5555-4555-8555-555555555555';  // another agent in a pane, with a log
const F = 'ffffffff-6666-4666-8666-666666666666';  // Claude in a pane, no log to read
const G = '99999999-7777-4777-8777-777777777777';  // Claude in a pane, taken off the list by hand

function withUnlistedPanes(t) {
  const logs = path.dirname(t.tree.logOf(A));
  for (const id of [D, E, G]) fs.writeFileSync(path.join(logs, id + '.jsonl'), '{}\n');
  for (const pane of t.herdr.panes) if (pane.agent_session && !pane.agent) pane.agent = 'claude';
  t.herdr.panes.push(
    { pane_id: 'w1:p5', tab_id: 'w1:t5', label: 'live-d', agent: 'claude', agent_status: 'working', agent_session: { value: D } },
    { pane_id: 'w1:p6', tab_id: 'w1:t6', label: 'other-agent', agent: 'codex', agent_status: 'idle', agent_session: { value: E } },
    { pane_id: 'w1:p7', tab_id: 'w1:t7', label: 'no-log', agent: 'claude', agent_status: 'idle', agent_session: { value: F } },
    { pane_id: 'w1:p8', tab_id: 'w1:t8', label: 'closed-by-hand', agent: 'claude', agent_status: 'idle', agent_session: { value: G } },
  );
  for (const [pane, id] of [['w1:p1', A], ['w1:p2', B], ['w1:p3', C], ['w1:p5', D], ['w1:p7', F], ['w1:p8', G]]) t.herdr.processInfo[pane] = [{ pid: 2000 + parseInt(pane.slice(4), 10), argv0: 'claude' }];
}

test('sync: every live Claude pane whose session is not listed is listed by the same click; the panes are not touched', async () => {
  const t = await start();
  try {
    withUnlistedPanes(t);
    fs.writeFileSync(path.join(t.tree.outDir, 'closed.txt'), `${G}\n`);
    t.tick(1000);
    const synced = await t.post('sync', {});
    assert.equal(synced.status, 200, synced.raw);
    // C is the unlisted pane of the fixtures; D is Claude too. E is another agent, F has no log, G was taken off by hand.
    assert.deepEqual(t.herdr.readerRuns(), [['adopt', C, D]], 'one rebuild, which lists them first');
    assert.equal(t.herdr.agentCalls().length, 0, 'no pane is touched');
    const read = t.herdr.calls.filter((call) => call.args[0] === '--session').map((call) => call.args[1]);
    assert.deepEqual([...new Set(read)], ['work'], 'the default and dash-named Herdr sessions stay unread');
    // What reader.py adopt did: the next click lists nothing new, and a session listed since is not named again.
    fs.writeFileSync(path.join(t.tree.outDir, 'sessions.txt'), [A, B, C, D].join('\n') + '\n');
    t.tick(5000);
    assert.equal((await t.post('sync', {})).status, 200);
    assert.deepEqual(t.herdr.readerRuns(), [['adopt', C, D], ['rebuild']]);
    assert.deepEqual(Object.keys(synced.json.panes).sort(), [A, B].sort(), 'the answer names the sessions listed when it was read');
  } finally { await t.close(); }
});

test('sync: a session taken off the list by hand stays off, and listing it again by name puts it back in reach', async () => {
  const t = await start();
  try {
    withUnlistedPanes(t);
    fs.writeFileSync(path.join(t.tree.outDir, 'closed.txt'), `${C}\n${D}\n${G}\n`);
    t.tick(1000);
    assert.equal((await t.post('sync', {})).status, 200);
    assert.deepEqual(t.herdr.readerRuns(), [['rebuild']], 'C, D and G were each closed or removed by a person');
    fs.writeFileSync(path.join(t.tree.outDir, 'closed.txt'), `${C}\n`);  // what reader.py add, reopen and follow do for D and G
    t.tick(5000);
    assert.equal((await t.post('sync', {})).status, 200);
    assert.deepEqual(t.herdr.readerRuns().at(-1), ['adopt', D, G], 'C stays off');
  } finally { await t.close(); }
});

test('sync: a pane Herdr stopped answering about lists nothing, and nothing is read from a session that is not running', async () => {
  const t = await start();
  try {
    withUnlistedPanes(t);
    t.herdr.down = true;
    t.tick(1000);
    assert.equal((await t.post('sync', {})).status, 200);
    assert.deepEqual(t.herdr.readerRuns(), [['rebuild']]);
  } finally { await t.close(); }
});

test('sync: a failed rebuild is reported, and bad input and foreign pages are refused', async () => {
  const t = await start();
  try {
    assert.equal((await t.post('sync', { extra: 1 })).status, 400);
    assert.equal((await t.post('sync', { follow: 'yes' })).status, 400);
    assert.equal((await t.post('sync', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.post('sync', {}, { [TOKEN_HEADER]: 'f'.repeat(64) })).status, 403);
    assert.equal((await t.request({ path: '/api/transcript-reader/sync', headers: { [TOKEN_HEADER]: t.token } })).status, 404, 'GET is not a sync');
    assert.equal(t.herdr.readerRuns().length, 0, 'none of them rebuilt anything');
    t.herdr.readerResult = { code: 1, stdout: '', stderr: 'Traceback\nValueError: broken', timedOut: false, truncated: false };
    const failed = await t.post('sync', {});
    assert.equal(failed.status, 502);
    assert.equal(failed.json.code, 'rebuild_failed');
    assert.equal(failed.json.message, 'ValueError: broken');
  } finally { await t.close(); }
});

test('pins: written to the owner-only file outside out/, one change at a time, and the state carries the revision', async () => {
  const t = await start();
  try {
    const key = 'abcdef12-3456-4789-8abc-def012345678:reply';
    assert.deepEqual((await t.get('pins')).json, { status: 'ok', rev: 0, pins: [] });
    assert.equal((await t.state()).json.stamps.pins, 0);
    const pinned = await t.post('pins', { op: 'pin', key, conv: A, at: 1700000000.5 });
    assert.equal(pinned.status, 200, pinned.raw);
    assert.equal(pinned.json.rev, 1);
    assert.deepEqual(pinned.json.pins.map(({ key: k, conv, at }) => [k, conv, at]), [[key, A, 1700000000.5]]);
    assert.equal((await t.post('pins', { op: 'pin', key, conv: A, at: 1700000000.5 })).json.rev, 1, 'pinning again changes nothing');
    assert.equal((await t.state()).json.stamps.pins, 1);
    assert.deepEqual((await t.get('pins')).json.pins.map((pin) => pin.key), [key]);
    const mode = (file) => fs.statSync(file).mode & 0o777;
    assert.equal(mode(t.tree.pinsFile), 0o600);
    assert.equal(mode(path.dirname(t.tree.pinsFile)), 0o700);
    assert.ok(!t.tree.pinsFile.startsWith(t.tree.outDir), 'not under out/, which a fresh copy of the repo starts without');
    assert.equal((await t.post('pins', { op: 'unpin', key })).json.rev, 2);
    assert.deepEqual((await t.get('pins')).json.pins, []);
    assert.equal(t.herdr.agentCalls().length, 0);
    assert.equal(t.herdr.readerRuns().length, 0, 'a pin rebuilds nothing');
  } finally { await t.close(); }
});

test('pins: bad input and foreign pages are refused, and no message text is ever stored', async () => {
  const t = await start();
  try {
    const key = 'abcdef12-3456-4789-8abc-def012345678:in';
    const refused = [
      [{ op: 'pin', key, conv: A }, 400],
      [{ op: 'pin', key, conv: A, at: 'now' }, 400],
      [{ op: 'pin', key, conv: A, at: 1, text: 'the whole message' }, 400],
      [{ op: 'pin', key: 'short:in', conv: A, at: 1 }, 400],
      [{ op: 'pin', key: 'abcdef12-3456-4789-8abc-def012345678:other', conv: A, at: 1 }, 400],
      [{ op: 'pin', key, conv: '../x', at: 1 }, 400],
      [{ op: 'unpin', key, conv: A }, 400],
      [{ op: 'toggle', key }, 400],
      [{}, 400],
    ];
    for (const [body, status] of refused) assert.equal((await t.post('pins', body)).status, status, JSON.stringify(body));
    assert.equal((await t.post('pins', { op: 'pin', key, conv: A, at: 1 }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.post('pins', { op: 'pin', key, conv: A, at: 1 }, { [TOKEN_HEADER]: 'f'.repeat(64) })).status, 403);
    assert.equal((await t.get('pins', { [TOKEN_HEADER]: 'f'.repeat(64) })).status, 403);
    assert.equal(fs.existsSync(t.tree.pinsFile), false, 'nothing was written');
    assert.equal((await t.post('pins', { op: 'pin', key, conv: A, at: 1 })).status, 200);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(t.tree.pinsFile, 'utf8')).pins[0]).sort(), ['at', 'conv', 'key', 'pinned']);
  } finally { await t.close(); }
});

test('stars: written beside the pins in their own owner-only file, one change at a time, and the state carries the revision', async () => {
  const t = await start();
  try {
    assert.deepEqual((await t.get('stars')).json, { status: 'ok', rev: 0, stars: [] });
    assert.equal((await t.state()).json.stamps.stars, 0);
    const starred = await t.post('stars', { op: 'star', conv: A });
    assert.equal(starred.status, 200, starred.raw);
    assert.equal(starred.json.rev, 1);
    assert.deepEqual(starred.json.stars.map(({ conv }) => conv), [A]);
    assert.equal((await t.post('stars', { op: 'star', conv: A })).json.rev, 1, 'starring again changes nothing');
    assert.equal((await t.state()).json.stamps.stars, 1);
    assert.equal((await t.state()).json.stamps.pins, 0, 'a star is not a pin');
    assert.deepEqual((await t.get('stars')).json.stars.map((star) => star.conv), [A]);
    const mode = (file) => fs.statSync(file).mode & 0o777;
    assert.equal(mode(t.tree.starsFile), 0o600);
    assert.equal(mode(path.dirname(t.tree.starsFile)), 0o700);
    assert.ok(!t.tree.starsFile.startsWith(t.tree.outDir), 'not under out/, which a fresh copy of the repo starts without');
    assert.equal(fs.existsSync(t.tree.pinsFile), false, 'the pins file is left alone');
    assert.equal((await t.post('stars', { op: 'unstar', conv: A })).json.rev, 2);
    assert.deepEqual((await t.get('stars')).json.stars, []);
    assert.equal(t.herdr.agentCalls().length, 0);
    assert.equal(t.herdr.readerRuns().length, 0, 'a star rebuilds nothing');
  } finally { await t.close(); }
});

test('stars: bad input and foreign pages are refused, and only the conversation and the time are stored', async () => {
  const t = await start();
  try {
    const refused = [
      [{ op: 'star' }, 400],
      [{ op: 'star', conv: '../x' }, 400],
      [{ op: 'star', conv: A, label: 'a session name' }, 400],
      [{ op: 'unstar', conv: A, at: 1 }, 400],
      [{ op: 'pin', conv: A }, 400],
      [{ op: 'toggle', conv: A }, 400],
      [{}, 400],
    ];
    for (const [body, status] of refused) assert.equal((await t.post('stars', body)).status, status, JSON.stringify(body));
    assert.equal((await t.post('stars', { op: 'star', conv: A }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.post('stars', { op: 'star', conv: A }, { [TOKEN_HEADER]: 'f'.repeat(64) })).status, 403);
    assert.equal((await t.get('stars', { [TOKEN_HEADER]: 'f'.repeat(64) })).status, 403);
    assert.equal(fs.existsSync(t.tree.starsFile), false, 'nothing was written');
    assert.equal((await t.post('stars', { op: 'star', conv: A })).status, 200);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(t.tree.starsFile, 'utf8')).stars[0]).sort(), ['conv', 'starred']);
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
    // A Claude in front whose record names another session. The scan, which asks first, sees a Claude without a
    // record and keeps the pane; the Claude that took the pane over shows only when the send looks again.
    runs(C);
    let asked = 0;
    t.herdr.processInfo['w1:p2'] = () => (asked++ ? [{ pid: process.pid, argv0: 'claude' }] : [{ pid: 4243, argv0: 'claude' }]);
    await refused('other_session');
    // Seen at the scan already, the pane is not B's at all.
    t.herdr.processInfo['w1:p2'] = [{ pid: process.pid, argv0: 'claude' }];
    await refused('no_pane');
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


// ------------------------------------------------------------- events, watching and the worker

const events = (t, query) => t.request({ path: '/api/transcript-reader/events' + query, headers: { [TOKEN_HEADER]: t.token } });
const readStamp = (t, name = 'prototype.stamp') => Number(fs.readFileSync(path.join(t.tree.outDir, name), 'utf8'));
// A build as the builders leave it: the stamp is replaced whole, by a rename.
const publish = (t, stamp, name = 'prototype.stamp') => {
  const partial = path.join(t.tree.outDir, '.' + name + '.partial');
  fs.writeFileSync(partial, String(stamp));
  fs.renameSync(partial, path.join(t.tree.outDir, name));
};
const until = async (condition, ms = 3000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + condition);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const WATCHING = { watch: true, sweepMs: 20 };

test('events: needs the token and the guard like every call, and never sends a CORS header', async () => {
  const t = await start();
  try {
    assert.equal((await t.request({ path: '/api/transcript-reader/events?wait=0' })).status, 403);
    assert.equal((await t.request({ path: '/api/transcript-reader/events?wait=0', headers: { [TOKEN_HEADER]: t.token, Host: 'evil.example:80' } })).status, 403);
    assert.equal((await t.request({ path: '/api/transcript-reader/events?wait=0', headers: { [TOKEN_HEADER]: t.token, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const ok = await events(t, '?wait=0');
    assert.equal(ok.status, 200);
    assert.equal(Object.keys(ok.headers).some((name) => name.startsWith('access-control')), false);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal((await t.request({ method: 'POST', path: '/api/transcript-reader/events', headers: { Origin: t.origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: t.token }, body: {} })).status, 404);
  } finally { await t.close(); }
});

test('events: a build newer than the page\'s answers at once, with the stamps and the build state; the page\'s own build does not', async () => {
  const t = await start();
  try {
    const built = readStamp(t);
    const newer = await events(t, `?reader=${built - 10}&wait=10000`);
    assert.equal(newer.status, 200);
    assert.deepEqual(newer.json.stamps, { reader: built, sheet: 1 });
    assert.deepEqual(newer.json.build, { running: false, adding: null, error: null });
    const sheet = await events(t, `?sheet=0&wait=10000`);
    assert.equal(sheet.json.stamps.sheet, 1, 'the answer sheet\'s stamp, for the sheet page');
    const begun = Date.now();
    const same = await events(t, `?reader=${built}&wait=60`);
    assert.deepEqual(same.json.stamps, { reader: built, sheet: 1 }, 'nothing newer: the same stamps, after the wait');
    assert.ok(Date.now() - begun >= 50 && Date.now() - begun < 2000);
    const garbage = await events(t, '?reader=abc&sheet=&wait=abc');
    assert.equal(garbage.status, 200, 'numbers that are not numbers ask for nothing and wait for nothing');
  } finally { await t.close(); }
});

test('events: a waiting page is answered the moment a build is published, not at the end of its wait', async () => {
  const t = await start({ options: WATCHING });
  try {
    const built = readStamp(t);
    const began = Date.now();
    const waiting = events(t, `?reader=${built}&wait=20000`);
    await t.settle();
    await new Promise((resolve) => setTimeout(resolve, 80));
    publish(t, built + 5);
    const answer = await waiting;
    assert.equal(answer.json.stamps.reader, built + 5);
    assert.ok(Date.now() - began < 3000, 'answered by the publication, not by the wait');
    // The answer sheet's page waits on its own stamp, which another build moves.
    const sheet = events(t, '?sheet=1&wait=20000');
    await new Promise((resolve) => setTimeout(resolve, 80));
    publish(t, 9, 'questionnaire.stamp');
    assert.equal((await sheet).json.stamps.sheet, 9);
  } finally { await t.close(); }
});

test('events: a page that goes away leaves nothing waiting, and the server stopping answers the pages that wait', async () => {
  const t = await start({ options: WATCHING });
  try {
    const built = readStamp(t);
    const gone = http.request({ host: '127.0.0.1', port: Number(t.origin.split(':').pop()), path: `/api/transcript-reader/events?reader=${built}&wait=20000`, headers: { Host: t.origin.slice(7), [TOKEN_HEADER]: t.token } });
    gone.on('error', () => {});
    gone.end();
    await new Promise((resolve) => setTimeout(resolve, 80));
    gone.destroy();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const waiting = events(t, `?reader=${built}&wait=20000`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    t.api.close();
    const answer = await waiting;
    assert.equal(answer.status, 200, 'closing answers a waiting page instead of cutting it off');
  } finally { await t.close(); }
});

test('watch: with a page open, a listed log written after the page was built starts the rebuild at once, with no further request', async () => {
  const t = await start({ options: WATCHING });
  try {
    await t.state();  // a page is open
    publish(t, Date.now() / 1000 - 600);
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());  // the session wrote a new turn
    await until(() => t.herdr.readerRuns().length === 1);
    assert.deepEqual(t.herdr.readerRuns(), [['rebuild']]);
    // The next write is noticed once the pause is over, and not before.
    fs.utimesSync(t.tree.logOf(A), new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(t.herdr.readerRuns().length, 1, 'not within the pause');
    t.tick(300);
    await until(() => t.herdr.readerRuns().length === 2);
  } finally { await t.close(); }
});

test('watch: the file system\'s notice starts the rebuild before the sweep would', async () => {
  const t = await start({ options: { watch: true, sweepMs: 60000 } });  // the sweep is out of the way
  try {
    await t.state();
    await new Promise((resolve) => setTimeout(resolve, 50));
    publish(t, Date.now() / 1000 - 600);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = t.herdr.readerRuns().length;
    fs.utimesSync(t.tree.logOf(B), new Date(), new Date());
    fs.appendFileSync(t.tree.logOf(B), '{}\n');
    await until(() => t.herdr.readerRuns().length > before, 1500);
  } finally { await t.close(); }
});

test('watch: a log written while a rebuild runs is rebuilt as soon as that one ends and the pause is over', async () => {
  let release;
  const t = await start({ options: WATCHING });
  try {
    t.herdr.readerGate = new Promise((resolve) => { release = resolve; });
    publish(t, Date.now() / 1000 - 600);
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());
    await t.state();
    await until(() => t.herdr.calls.some((call) => call.file === 'python3'));
    assert.equal((await t.state()).json.build.running, true);
    fs.utimesSync(t.tree.logOf(A), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(t.herdr.readerRuns().length, 1, 'one rebuild at a time');
    t.herdr.readerGate = null;
    release();
    await t.settle();
    t.tick(300);
    await until(() => t.herdr.readerRuns().length === 2);
  } finally { await t.close(); }
});

test('watch: the first write after a quiet spell is rebuilt for at once, and the writes that follow wait for the limit and are rebuilt for together', async () => {
  const t = await start({ options: { ...WATCHING, rebuildEveryMs: 2000 } });
  try {
    await t.state();
    publish(t, Date.now() / 1000 - 600);
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());
    await until(() => t.herdr.readerRuns().length === 1);
    // Three more writes within the limit, each after the pause that follows a rebuild.
    for (let i = 1; i <= 3; i += 1) {
      t.tick(300);
      publish(t, Date.now() / 1000 - 500 + i);
      fs.utimesSync(t.tree.logOf(i % 2 ? A : B), new Date(Date.now() + i * 1000), new Date(Date.now() + i * 1000));
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.equal(t.herdr.readerRuns().length, 1, 'not within the limit, however many writes');
    t.tick(1200);
    await until(() => t.herdr.readerRuns().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(t.herdr.readerRuns().length, 2, 'the three writes were rebuilt for once');
  } finally { await t.close(); }
});

test('watch: a write that has to wait for the limit is rebuilt for when it is over, with no request and no sweep to notice it', async () => {
  const t = await start({ options: { watch: true, sweepMs: 60000, rebuildEveryMs: 400, now: () => Date.now() } });  // the sweep is out of the way
  try {
    await t.state();
    await new Promise((resolve) => setTimeout(resolve, 50));
    publish(t, Date.now() / 1000 - 600);
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());
    fs.appendFileSync(t.tree.logOf(A), '{}\n');
    await until(() => t.herdr.readerRuns().length === 1, 1500);
    const first = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 320));  // the pause after a rebuild is over, the limit is not
    fs.utimesSync(t.tree.logOf(A), new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    fs.appendFileSync(t.tree.logOf(A), '{}\n');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(t.herdr.readerRuns().length, 1, 'held back');
    await until(() => t.herdr.readerRuns().length === 2, 2000);
    assert.ok(Date.now() - first >= 350, 'not before the limit was over');
  } finally { await t.close(); }
});

test('watch: a Sync, a follow and the reading list\'s own rebuilds are not held back by the limit', async () => {
  const t = await start({ options: { ...WATCHING, rebuildEveryMs: 60000 } });
  try {
    await t.state();
    publish(t, Date.now() / 1000 - 600);
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());
    await until(() => t.herdr.readerRuns().length === 1);
    t.tick(300);
    const synced = await t.post('sync', {});
    assert.equal(synced.status, 200);
    assert.equal(t.herdr.readerRuns().length, 2, 'asked for by a person: now');
  } finally { await t.close(); }
});

test('watch: with no page open nothing is rebuilt, and a page that has gone quiet stops being watched for', async () => {
  const t = await start({ options: WATCHING });
  try {
    publish(t, Date.now() / 1000 - 600);
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(t.herdr.readerRuns().length, 0, 'nobody is looking');
    await t.state();
    await until(() => t.herdr.readerRuns().length === 1);
    t.tick(30000);  // the page has not been heard from for longer than the server keeps watching
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.utimesSync(t.tree.logOf(A), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(t.herdr.readerRuns().length, 1, 'quiet again');
    await t.state();
    await until(() => t.herdr.readerRuns().length === 2);
  } finally { await t.close(); }
});

test('watch: a log that stays newer than every build is rebuilt for once, not in a loop, and the next write is rebuilt for again', async () => {
  const t = await start({ options: WATCHING });
  try {
    await t.state();
    publish(t, Date.now() / 1000 - 600);
    const future = new Date(Date.now() + 3600 * 1000);  // a clock that ran ahead: the log is dated after every build
    fs.utimesSync(t.tree.logOf(A), future, future);
    await until(() => t.herdr.readerRuns().length === 1);
    for (let i = 0; i < 4; i += 1) { t.tick(1000); await new Promise((resolve) => setTimeout(resolve, 60)); }
    await t.state();
    assert.equal(t.herdr.readerRuns().length, 1, 'once, though the page is never newer than the log');
    const later = new Date(Date.now() + 7200 * 1000);
    fs.utimesSync(t.tree.logOf(A), later, later);
    await until(() => t.herdr.readerRuns().length === 2);
  } finally { await t.close(); }
});

test('watch: a failed rebuild is not retried at once, and a page polling a server that does not watch still rebuilds as before', async () => {
  const t = await start({ options: WATCHING });
  try {
    t.herdr.readerResult = { code: 1, stdout: '', stderr: 'ValueError: broken', timedOut: false, truncated: false };
    publish(t, Date.now() / 1000 - 600);
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());
    await t.state();
    await until(() => t.herdr.readerRuns().length === 1);
    t.tick(5000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(t.herdr.readerRuns().length, 1, 'held for 30 seconds');
    t.tick(30000);
    await t.state();
    await until(() => t.herdr.readerRuns().length === 2);
  } finally { await t.close(); }
  const plain = await start();  // no watch: only a poll starts a rebuild, as before
  try {
    publish(plain, Date.now() / 1000 - 600);
    fs.utimesSync(plain.tree.logOf(A), new Date(), new Date());
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(plain.herdr.readerRuns().length, 0);
    await plain.state();
    await plain.settle();
    assert.equal(plain.herdr.readerRuns().length, 1);
  } finally { await plain.close(); }
});

// A reader.py that stays running, as the server starts it, faked by a script that answers each request line and records it.
function fakeWorker({ crash = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-worker-'));
  const requests = path.join(dir, 'requests.log');
  fs.writeFileSync(path.join(dir, 'worker.js'), `
    const fs = require('fs');
    let buffer = '';
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
        const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(request.args) + '\\n');
        if (fs.existsSync(${JSON.stringify(path.join(dir, 'crash'))})) process.exit(3);
        process.stdout.write(JSON.stringify({ id: request.id, code: 0, output: 'built\\n' }) + '\\n');
      }
    });`);
  fs.writeFileSync(path.join(dir, 'fakepy'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, 'worker.js'))}\n`, { mode: 0o755 });
  if (crash) fs.writeFileSync(path.join(dir, 'crash'), '');
  // The worker creates the log and then writes a line to it, so a read in between finds it empty: only whole lines count.
  return { dir, pythonBin: path.join(dir, 'fakepy'),
    requests: () => (fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').split('\n').slice(0, -1).map((line) => JSON.parse(line)) : []),
    stopCrashing: () => fs.rmSync(path.join(dir, 'crash'), { force: true }) };
}

test('worker: the rebuilds go to the reader.py that stays running, one request each; a worker that cannot take one leaves it to a fresh reader.py', async () => {
  const fake = fakeWorker();
  const t = await start({ options: (herdr) => ({ worker: true, pythonBin: fake.pythonBin, runner: (file, args, opts) => herdr.runner(file === fake.pythonBin ? 'python3' : file, args, opts) }) });
  try {
    publish(t, Date.now() / 1000 - 600);
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());
    t.tick(5000);
    await t.state();
    await until(() => fake.requests().length === 1);
    assert.deepEqual(fake.requests(), [['rebuild']]);
    assert.equal(t.herdr.readerRuns().length, 0, 'not by a fresh reader.py');
    // Reopen goes through it too, and answers once it has built.
    const reopened = await t.post('reopen', { session_id: C });
    assert.equal(reopened.status, 200);
    assert.deepEqual(fake.requests().slice(-1), [['reopen', C]]);
    // The worker dies in the middle of a request: that request runs in a fresh reader.py, and the answer is the build's.
    fs.writeFileSync(path.join(fake.dir, 'crash'), '');
    const closed = await t.post('close', { session_id: A });
    assert.equal(closed.status, 200);
    assert.deepEqual(t.herdr.readerRuns(), [['close', A]]);
    // A broken worker is left alone for a while, so the next requests do not each wait for it to fail.
    await t.post('close', { session_id: B });
    assert.equal(fake.requests().length, 3);
    assert.deepEqual(t.herdr.readerRuns(), [['close', A], ['close', B]]);
  } finally { await t.close(); }
});

test('worker: a rebuild that fails in the worker reports what the build said, and the next one is tried', async () => {
  const fake = fakeWorker();
  fs.writeFileSync(path.join(fake.dir, 'worker.js'), `
    let buffer = '';
    let n = 0;
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
        const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        n += 1;
        process.stdout.write(JSON.stringify({ id: request.id, code: n === 1 ? 1 : 0, output: n === 1 ? 'Traceback\\nValueError: broken log\\n' : 'built\\n' }) + '\\n');
      }
    });`);
  const t = await start({ options: { worker: true, pythonBin: fake.pythonBin } });
  try {
    publish(t, Date.now() / 1000 - 600);
    fs.utimesSync(t.tree.logOf(A), new Date(), new Date());
    t.tick(5000);
    await t.state();
    await t.settle();
    await until(() => t.state().then((r) => r.json.build.error === 'ValueError: broken log'));
    const closed = await t.post('close', { session_id: A });
    assert.equal(closed.status, 200, 'the worker that failed one build still takes the next');
  } finally { await t.close(); }
});

// The tool output of the local page's conversations: the page build writes out/steps/<id>.json beside the page, and one route reads it.
test('steps: a conversation\'s tool output is read from the file the page build wrote, with the token, and a conversation with none is an empty set', async () => {
  const t = await start();
  try {
    fs.mkdirSync(path.join(t.tree.outDir, 'steps'));
    fs.writeFileSync(path.join(t.tree.outDir, 'steps', A + '.json'), JSON.stringify({ outputs: { 'turn:0': 'all good', 'turn:2': 'a failure' } }));
    const got = await t.get('steps?conv=' + A);
    assert.equal(got.status, 200);
    assert.deepEqual(got.json, { status: 'ok', outputs: { 'turn:0': 'all good', 'turn:2': 'a failure' } });
    assert.deepEqual((await t.get('steps?conv=' + B)).json, { status: 'ok', outputs: {} });
    fs.writeFileSync(path.join(t.tree.outDir, 'steps', B + '.json'), 'not json');
    assert.deepEqual((await t.get('steps?conv=' + B)).json, { status: 'ok', outputs: {} }, 'a file cut off mid-write is none yet');
    for (const conv of ['', '../prototype', '..%2Fprototype', 'a/b', 'x'.repeat(65), 'a.b']) {
      assert.equal((await t.get('steps?conv=' + conv)).status, 400, conv);
    }
    assert.equal((await t.get('steps?conv=' + A, { [TOKEN_HEADER]: 'f'.repeat(64) })).status, 403, 'without the page\'s token nothing is read');
    assert.equal((await t.request({ path: '/api/transcript-reader/steps?conv=' + A })).status, 403);
    // The folder is not a page: a direct address is never served.
    const direct = await t.request({ path: '/setup/transcript-reader/out/steps/' + A + '.json', headers: { [TOKEN_HEADER]: t.token } });
    assert.notEqual(direct.status, 200);
    assert.doesNotMatch(direct.raw, /all good/);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------- photos in a message
// A photo is uploaded to out/uploads/ (checked by its bytes), and send then names the saved files by path. Herdr and sips are faked.

const crc32 = (buffer) => { let c; let crc = 0xffffffff; for (const byte of buffer) { c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
const chunk = (kind, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(kind, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
// A real PNG (a w x h block of one colour), a header-true JPEG, GIF, WebP and HEIC: what the checks read, without a decoder.
const realPng = (w = 4, h = 4) => { const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head.set([8, 2, 0, 0, 0], 8); const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7f)]))); return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]); };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(40, 1), Buffer.from([0xff, 0xd9])]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([2, 0, 2, 0, 0, 0, 0]), Buffer.alloc(20, 0), Buffer.from([0x3b])]);
const WEBP = (() => { const body = Buffer.concat([Buffer.from('WEBPVP8 '), Buffer.alloc(4), Buffer.alloc(20, 3)]); const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'latin1'); riff.writeUInt32LE(body.length, 4); return Buffer.concat([riff, body]); })();
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(12, 0), Buffer.from('mif1heic')]);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const photoOptions = () => ({ sipsBin: 'sips' });
const savedFiles = (t) => { try { return fs.readdirSync(path.join(t.tree.outDir, 'uploads')).sort(); } catch { return []; } };
const uploadsPath = (t) => fs.realpathSync(path.join(t.tree.outDir, 'uploads'));
const upload = (t, bytes, name = 'photo.png', headers = {}) => t.post('upload', { name, data: b64(bytes) }, headers);

test('photos: PNG, JPEG, GIF and WebP are saved owner-only under a random name, with the extension of what the bytes are', async () => {
  const t = await start({ options: photoOptions });
  try {
    const wanted = [[realPng(), '.png', 'image/png'], [JPEG, '.jpg', 'image/jpeg'], [GIF, '.gif', 'image/gif'], [WEBP, '.webp', 'image/webp']];
    for (const [bytes, ext, type] of wanted) {
      // Named for another type on purpose: the name is never trusted, never used for the file.
      const answer = await upload(t, bytes, 'IMG_0001.heic');
      assert.equal(answer.status, 200, answer.raw);
      assert.match(answer.json.id, new RegExp('^[0-9a-f]{32}\\' + ext + '$'));
      assert.equal(answer.json.type, type);
      assert.equal(answer.json.bytes, bytes.length);
      assert.equal(answer.json.converted, undefined);
      assert.equal(JSON.stringify(answer.json).includes(t.tree.root), false, 'the answer holds no path of the laptop');
      const file = path.join(t.tree.outDir, 'uploads', answer.json.id);
      assert.deepEqual(fs.readFileSync(file), bytes);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the file is the owner\'s alone');
    }
    assert.equal(fs.statSync(path.join(t.tree.outDir, 'uploads')).mode & 0o777, 0o700, 'so is the folder');
    // The same photo twice is two files with two unguessable names.
    const [one, two] = [await upload(t, JPEG, 'a.jpg'), await upload(t, JPEG, 'a.jpg')];
    assert.notEqual(one.json.id, two.json.id);
    assert.equal(savedFiles(t).length, 6);
    // A folder some other process left open is narrowed again.
    fs.chmodSync(path.join(t.tree.outDir, 'uploads'), 0o755);
    await upload(t, JPEG);
    assert.equal(fs.statSync(path.join(t.tree.outDir, 'uploads')).mode & 0o777, 0o700);
  } finally { await t.close(); }
});

test('photos: what is not an image is refused by its bytes, whatever it is called, and nothing is saved', async () => {
  const t = await start({ options: photoOptions });
  try {
    const refused = [
      ['a page renamed .png', Buffer.from('<!doctype html><script>alert(1)</script>'), 'cute.png'],
      ['a text file renamed .png', Buffer.from('just some notes, long enough to look like a file'), 'notes.png'],
      ['a PNG signature and nothing else', realPng().subarray(0, 8), 'cut.png'],
      ['a PNG whose first chunk is not IHDR', Buffer.concat([realPng().subarray(0, 8), chunk('IDAT', Buffer.alloc(13, 1)), Buffer.alloc(12)]), 'odd.png'],
      ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'), 'logo.svg'],
      ['a PDF', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'), 'scan.png'],
      ['a ZIP', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]), 'photos.jpg'],
      ['a JPEG signature with a marker no JPEG starts with', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x00]), Buffer.alloc(40)]), 'bad.jpg'],
      ['a WebP that claims more than it holds', Buffer.concat([WEBP.subarray(0, 4), Buffer.from([0xff, 0xff, 0, 0]), WEBP.subarray(8)]), 'big.webp'],
      ['a QuickTime movie (ftyp, but not HEIC)', Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(20)]), 'clip.heic'],
      ['an AVIF', Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypavif'), Buffer.alloc(20)]), 'a.avif'],
    ];
    for (const [what, bytes, name] of refused) {
      const answer = await upload(t, bytes, name);
      assert.equal(answer.status, 415, what + ': ' + answer.raw);
      assert.equal(answer.json.code, 'not_image', what);
      assert.match(answer.json.message, new RegExp('^' + name.replace('.', '\\.') + ' is not a PNG, JPEG, GIF, WebP or HEIC image'), what);
    }
    for (const [what, body, status] of [
      ['no data', { name: 'a.png' }, 400], ['empty data', { name: 'a.png', data: '' }, 400], ['data that is not base64', { name: 'a.png', data: 'not base64!' }, 400],
      ['data that is not text', { data: 12 }, 400], ['an unknown field', { data: b64(JPEG), path: '/etc/passwd' }, 400], ['a name that is not text', { name: ['a'], data: b64(JPEG) }, 400],
    ]) assert.equal((await t.post('upload', body)).status, status, what);
    assert.deepEqual(savedFiles(t).filter((name) => !name.startsWith('.')), [], 'nothing was kept');
    // The name only ever reaches the refusal, without control characters, and never longer than a line.
    const long = await upload(t, Buffer.from('x'.repeat(60)), 'a\u0000b\u001b[31m' + 'z'.repeat(200) + '.png');
    assert.doesNotMatch(long.json.message, /[\u0000-\u001f]/);
    assert.ok(long.json.message.length < 160);
  } finally { await t.close(); }
});

test('photos: one photo is at most 12 MB, a message at most 6 photos and 30 MB, and the folder at most 1 GB', async () => {
  const t = await start({ options: photoOptions });
  try {
    assert.deepEqual({ ...PHOTO_LIMITS }, { MAX_PHOTOS: 6, MAX_PHOTO_BYTES: 12 * 1024 * 1024, MAX_PHOTOS_BYTES: 30 * 1024 * 1024 });
    const png = (bytes) => Buffer.concat([realPng(), Buffer.alloc(bytes - realPng().length)]);  // a PNG with its tail padded to a size
    const big = await upload(t, png(12 * 1024 * 1024 + 100));
    assert.equal(big.status, 413);
    assert.equal(big.json.code, 'too_big');
    assert.equal(big.json.message, 'photo.png is 12 MB; a photo can be at most 12 MB.');
    const huge = await upload(t, png(14 * 1024 * 1024));
    assert.equal(huge.status, 413, 'a body past the limit is stopped before it is read whole');
    assert.equal(huge.json.message, 'That photo is too big: a photo can be at most 12 MB.');
    const edge = await upload(t, png(12 * 1024 * 1024));
    assert.equal(edge.status, 200, 'exactly 12 MB is taken');
    assert.deepEqual(savedFiles(t), [edge.json.id]);

    // A message: the count, then the total.
    const ids = [];
    for (let i = 0; i < 7; i += 1) ids.push((await upload(t, realPng(4 + i, 4))).json.id);
    const seven = await t.send({ session_id: B, text: 'seven', images: ids });
    assert.equal(seven.status, 413);
    assert.equal(seven.json.code, 'too_many');
    const three = [edge.json.id, (await upload(t, png(11 * 1024 * 1024))).json.id, (await upload(t, png(11 * 1024 * 1024))).json.id];
    const total = await t.send({ session_id: B, text: 'three big ones', images: three });
    assert.equal(total.status, 413);
    assert.equal(total.json.code, 'too_big');
    assert.match(total.json.message, /add up to 34 MB; a message can carry at most 30 MB/);
    assert.equal((await t.send({ session_id: B, text: 'two big ones', images: three.slice(0, 2) })).status, 200, '23 MB is within 30');
    assert.equal(t.herdr.prompts().length, 1, 'nothing was typed for the refused ones');

    // The folder: a file already there that fills it (a sparse file, so the test writes nothing) makes the next photo wait.
    const fill = path.join(t.tree.outDir, 'uploads', 'f'.repeat(32) + '.png');
    fs.writeFileSync(fill, '');
    fs.truncateSync(fill, 1024 * 1024 * 1024);
    const full = await upload(t, realPng());
    assert.equal(full.status, 507);
    assert.equal(full.json.code, 'folder_full');
    assert.match(full.json.message, /out\/uploads/);
  } finally { await t.close(); }
});

test('photos: files older than 30 days leave the folder as a new photo arrives, and a leftover conversion file after an hour', async () => {
  const t = await start({ options: photoOptions });
  try {
    const first = await upload(t, JPEG);
    const dir = path.join(t.tree.outDir, 'uploads');
    const old = path.join(dir, 'a'.repeat(32) + '.jpg');
    const recent = path.join(dir, 'b'.repeat(32) + '.jpg');
    const leftover = path.join(dir, '.convert-0123456789abcdef.heic');
    const fresh = path.join(dir, '.convert-fedcba9876543210.heic');
    for (const file of [old, recent, leftover, fresh]) fs.writeFileSync(file, 'x');
    const days = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);
    fs.utimesSync(old, days(31), days(31));
    fs.utimesSync(recent, days(29), days(29));
    fs.utimesSync(leftover, days(1), days(1));
    await upload(t, JPEG);
    assert.equal(fs.existsSync(old), false, 'a photo past 30 days is gone');
    assert.equal(fs.existsSync(recent), true, 'one at 29 days stays');
    assert.equal(fs.existsSync(leftover), false, 'a leftover temp file of a day ago is gone');
    assert.equal(fs.existsSync(fresh), true, 'one just made may belong to a conversion in progress');
    assert.equal(fs.existsSync(path.join(dir, first.json.id)), true);
  } finally { await t.close(); }
});

test('photos: the upload route takes the same checks as send: token, origin, host, Fetch-Metadata and a JSON body', async () => {
  const t = await start({ options: photoOptions });
  try {
    const body = JSON.stringify({ name: 'a.png', data: b64(realPng()) });
    const base = { method: 'POST', path: '/api/transcript-reader/upload', body, headers: { Origin: t.origin, 'Content-Type': 'application/json', [TOKEN_HEADER]: t.token } };
    const without = (name) => { const headers = { ...base.headers }; delete headers[name]; return { ...base, headers }; };
    const over = (extra) => ({ ...base, headers: { ...base.headers, ...extra } });
    const refused = [
      ['no token', without(TOKEN_HEADER), 403],
      ['a wrong token', over({ [TOKEN_HEADER]: 'f'.repeat(64) }), 403],
      ['no Origin', without('Origin'), 403],
      ['another site\'s Origin', over({ Origin: 'http://evil.example' }), 403],
      ['a cross-site fetch', over({ 'Sec-Fetch-Site': 'cross-site' }), 403],
      ['a foreign Host', over({ Host: 'evil.example:80' }), 403],
      ['a body that is not JSON', over({ 'Content-Type': 'text/plain' }), 415],
      ['a form post', over({ 'Content-Type': 'multipart/form-data; boundary=x' }), 415],
      ['a preflight', { ...base, method: 'OPTIONS' }, 403],
    ];
    for (const [what, request, status] of refused) assert.equal((await t.request(request)).status, status, what);
    assert.equal((await t.request({ path: '/api/transcript-reader/upload', headers: { [TOKEN_HEADER]: t.token } })).status, 404, 'a GET finds no route');
    assert.deepEqual(savedFiles(t), [], 'nothing was saved');
    assert.equal((await t.request(base)).status, 200, 'the same request with everything right is taken');
    assert.equal(savedFiles(t).length, 1);
  } finally { await t.close(); }
});

test('photos: send adds the saved files\' absolute paths after what was typed, and answers with the text as it went', async () => {
  const t = await start({ options: photoOptions });
  try {
    const one = (await upload(t, realPng(), 'a.png')).json.id;
    const two = (await upload(t, JPEG, 'b.jpg')).json.id;
    const dir = uploadsPath(t);
    assert.ok(path.isAbsolute(dir));
    const lines = `Attached image: ${dir}/${one}\nAttached image: ${dir}/${two}`;

    const both = await t.send({ session_id: B, text: 'look at these two', images: [one, two] });
    assert.equal(both.status, 200, both.raw);
    assert.equal(both.json.text, `look at these two\n\n${lines}`);
    assert.deepEqual(t.herdr.prompts()[0].args, ['--session', 'work', 'agent', 'prompt', 'w1:p2', `look at these two\n\n${lines}`]);

    const alone = await t.send({ session_id: B, images: [one] });
    assert.equal(alone.status, 200, alone.raw);
    assert.equal(alone.json.text, `Attached image: ${dir}/${one}`);
    const blank = await t.send({ session_id: B, text: '   \n ', images: [two] });
    assert.equal(blank.json.text, `Attached image: ${dir}/${two}`);
    assert.equal(t.herdr.prompts()[2].args[5], `Attached image: ${dir}/${two}`);

    // A message with a comment batch or a pointer is just text by now; the photos follow it.
    const numbered = 'Re your reply at 10:57 ("Checkpoint"): A2=link-only';
    assert.equal((await t.send({ session_id: B, text: numbered, images: [one] })).json.text, `${numbered}\n\nAttached image: ${dir}/${one}`);

    // Without photos nothing changes: no text in the answer, the words as they were.
    const plain = await t.send({ session_id: B, text: 'no photos', images: [] });
    assert.equal(plain.json.text, undefined);
    assert.equal(t.herdr.prompts()[t.herdr.prompts().length - 1].args[5], 'no photos');
    assert.equal((await t.send({ session_id: B, text: '   ' })).status, 400, 'words are still needed when no photo goes');
    // A saved photo can go again (the same file named by a second message), since the page may retry after a failed send.
    assert.equal((await t.send({ session_id: B, text: 'again', images: [one] })).status, 200);
  } finally { await t.close(); }
});

test('photos: send takes only ids an upload gave, still in the folder, and a command goes alone; none of it reaches Herdr', async () => {
  const t = await start({ options: photoOptions });
  try {
    const id = (await upload(t, realPng())).json.id;
    const gone = 'c'.repeat(32) + '.png';
    fs.writeFileSync(path.join(t.tree.outDir, 'secret.txt'), 'private');
    fs.symlinkSync(path.join(t.tree.outDir, 'secret.txt'), path.join(t.tree.outDir, 'uploads', 'd'.repeat(32) + '.png'));
    fs.mkdirSync(path.join(t.tree.outDir, 'uploads', 'e'.repeat(32) + '.png'));
    const refused = [
      [{ session_id: B, text: 'hi', images: [gone] }, 409, 'image_gone'],
      [{ session_id: B, text: 'hi', images: ['d'.repeat(32) + '.png'] }, 409, 'image_gone'],
      [{ session_id: B, text: 'hi', images: ['e'.repeat(32) + '.png'] }, 409, 'image_gone'],
      [{ session_id: B, text: 'hi', images: ['../prototype.html'] }, 400],
      [{ session_id: B, text: 'hi', images: [path.join(t.tree.outDir, 'uploads', id)] }, 400],
      [{ session_id: B, text: 'hi', images: ['../uploads/' + id] }, 400],
      [{ session_id: B, text: 'hi', images: [id.replace('.png', '.svg')] }, 400],
      [{ session_id: B, text: 'hi', images: [id.toUpperCase()] }, 400],
      [{ session_id: B, text: 'hi', images: [id, id] }, 400],
      [{ session_id: B, text: 'hi', images: id }, 400],
      [{ session_id: B, text: 'hi', images: [7] }, 400],
      [{ session_id: B, text: 'hi', images: [id], more: 1 }, 400],
      [{ session_id: B, text: '/clear', images: [id] }, 400, 'command_with_photos'],
      [{ session_id: B, images: [id], text: '/compact now' }, 400, 'command_with_photos'],
      [{ session_id: B, text: 'hi \u001b[201~', images: [id] }, 400],
      [{ session_id: C, text: 'hi', images: [id] }, 409, 'not_listed'],
    ];
    for (const [body, status, code] of refused) {
      const answer = await t.send(body);
      assert.equal(answer.status, status, JSON.stringify(body).slice(0, 90) + ' ' + answer.raw);
      if (code) assert.equal(answer.json.code, code);
    }
    assert.equal(t.herdr.agentCalls().length, 0, 'no key and no prompt reached a pane');
    assert.equal(fs.readFileSync(path.join(t.tree.outDir, 'secret.txt'), 'utf8'), 'private');
  } finally { await t.close(); }
});

test('photos: saved photos are never served, to anyone, on any address', async () => {
  const t = await start({ options: photoOptions });
  try {
    const id = (await upload(t, realPng())).json.id;
    const headers = { [TOKEN_HEADER]: t.token };
    const tab = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
    for (const [what, request] of [
      ['in a tab, with the token', { path: '/setup/transcript-reader/out/uploads/' + id, headers: { ...headers, ...tab } }],
      ['in a tab, without it', { path: '/setup/transcript-reader/out/uploads/' + id, headers: tab }],
      ['as a script\'s fetch', { path: '/setup/transcript-reader/out/uploads/' + id, headers: { ...headers, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } }],
      ['by another spelling', { path: '/setup/transcript-reader/out/%75ploads/' + id, headers: { ...headers, ...tab } }],
      ['by a doubled slash', { path: '/setup/transcript-reader//out/uploads/' + id, headers: { ...headers, ...tab } }],
      ['as an api path', { path: '/api/transcript-reader/uploads/' + id, headers }],
      ['as the viewer\'s address', { path: '/api/transcript-reader/html/' + id + '/' + id, headers }],
      ['the folder itself', { path: '/setup/transcript-reader/out/uploads/', headers: { ...headers, ...tab } }],
    ]) {
      const answer = await t.request(request);
      assert.notEqual(answer.status, 200, what);
      assert.equal(Object.keys(answer.headers).some((name) => name.startsWith('access-control')), false, what);
      assert.equal(answer.raw.includes(id), false, what + ' names nothing of the folder');
    }
    // The only way a picture comes back is image-open, for a file the page build listed; a photo is not one.
    const open = await t.post('image-open', { id: id.slice(0, 10) });
    assert.equal(open.status, 404);
    assert.equal(open.json.code, 'not_listed');
    // And the server that shares the repo for other apps refuses the whole folder.
    assert.equal(namesReaderOut(t.tree.root, { url: '/setup/transcript-reader/out/uploads/' + id }), true);
  } finally { await t.close(); }
});

test('photos: an iPhone\'s HEIC is converted to JPEG by sips and only the JPEG is kept', async () => {
  const t = await start({ options: photoOptions });
  try {
    t.herdr.sips = async (args) => {
      assert.deepEqual(args.slice(0, 6), ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90']);
      assert.deepEqual(fs.readFileSync(args[6]), HEIC, 'sips is given the bytes that arrived');
      assert.equal(fs.statSync(args[6]).mode & 0o777, 0o600);
      assert.equal(args[7], '--out');
      fs.writeFileSync(args[8], JPEG);
      return { code: 0, stdout: args[8], stderr: '', timedOut: false, truncated: false };
    };
    const answer = await upload(t, HEIC, 'IMG_4021.HEIC');
    assert.equal(answer.status, 200, answer.raw);
    assert.match(answer.json.id, /^[0-9a-f]{32}\.jpg$/);
    assert.equal(answer.json.type, 'image/jpeg');
    assert.equal(answer.json.converted, 'heic');
    assert.deepEqual(fs.readFileSync(path.join(t.tree.outDir, 'uploads', answer.json.id)), JPEG);
    assert.deepEqual(savedFiles(t), [answer.json.id], 'the HEIC and the work files are gone');
    assert.equal(t.herdr.sipsCalls.length, 1);
    assert.equal(t.herdr.sipsCalls[0][6].startsWith(uploadsPath(t)), true, 'the work files are in the owner-only folder');

    // sips failing, or answering with something that is not a JPEG, keeps nothing.
    t.herdr.sips = async () => ({ code: 1, stdout: '', stderr: 'Error 13: cannot read', timedOut: false, truncated: false });
    const failed = await upload(t, HEIC, 'broken.heic');
    assert.equal(failed.status, 415);
    assert.equal(failed.json.code, 'heic_failed');
    assert.match(failed.json.message, /^broken\.heic is a HEIC photo and the laptop could not convert it to JPEG/);
    t.herdr.sips = async (args) => { fs.writeFileSync(args[8], Buffer.from('not a jpeg, just text')); return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }; };
    assert.equal((await upload(t, HEIC)).status, 415);
    t.herdr.sips = async () => { throw new Error('spawn failed'); };
    assert.equal((await upload(t, HEIC)).status, 415);
    assert.deepEqual(savedFiles(t), [answer.json.id], 'still only the one converted photo');
    // A photo that is already a JPEG never goes to sips.
    const calls = t.herdr.sipsCalls.length;
    await upload(t, JPEG);
    assert.equal(t.herdr.sipsCalls.length, calls);
  } finally { await t.close(); }
});

test('photos: with the real sips on this Mac, a HEIC made from a PNG comes out as a JPEG', { skip: !fs.existsSync('/usr/bin/sips') && 'sips is not here' }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-heic-'));
  const png = path.join(scratch, 'a.png');
  const heic = path.join(scratch, 'a.heic');
  fs.writeFileSync(png, realPng(64, 48));
  const made = spawnSync('/usr/bin/sips', ['-s', 'format', 'heic', png, '--out', heic], { encoding: 'utf8' });
  if (made.status !== 0 || !fs.existsSync(heic)) { fs.rmSync(scratch, { recursive: true, force: true }); return; }  // this sips cannot write HEIC: nothing to prove here
  const { defaultRunner } = require('../herdr-organizer/adapter');
  // The fake Herdr answers everything but the converter, which is the real one here.
  const t = await start({ options: (herdr) => ({ runner: async (file, args, opts) => (file === '/usr/bin/sips' ? defaultRunner(file, args, opts) : herdr.runner(file, args, opts)) }) });
  try {
    const answer = await upload(t, fs.readFileSync(heic), 'IMG_1.HEIC');
    assert.equal(answer.status, 200, answer.raw);
    assert.equal(answer.json.type, 'image/jpeg');
    const kept = fs.readFileSync(path.join(t.tree.outDir, 'uploads', answer.json.id));
    assert.deepEqual([...kept.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.deepEqual(savedFiles(t), [answer.json.id]);
  } finally { await t.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('photos: the hosted copy\'s queue carries no photo, and the reading list and the pane check hold for a send with photos too', async () => {
  const t = await start({ options: photoOptions });
  try {
    const id = (await upload(t, realPng())).json.id;
    const queued = await t.post('queue', { copy: 'hosted', id: Q, object: { session_id: A, text: 'hi', at: Date.now() / 1000, images: [id] } });
    assert.equal(queued.status, 400);
    assert.equal(queued.json.message, 'Unknown field.');
    assert.equal((await t.post('queue', { copy: 'hosted', id: Q, images: [id], object: { session_id: A, text: 'hi', at: 1 } })).status, 400);
    assert.equal(fs.existsSync(path.join(t.tree.outDir, 'hosted', 'q')), false, 'nothing was queued');
    t.herdr.panes[1] = { ...t.herdr.panes[1], agent_status: 'blocked' };
    const blocked = await t.send({ session_id: B, text: 'hi', images: [id] });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'agent_blocked');
    t.herdr.panes[1] = { ...t.herdr.panes[1], agent_status: 'idle' };
    t.herdr.processInfo['w1:p2'] = [{ pid: 4242, argv0: 'zsh' }];
    assert.equal((await t.send({ session_id: B, text: 'hi', images: [id] })).json.code, 'agent_not_foreground');
    assert.equal(t.herdr.prompts().length, 0);
  } finally { await t.close(); }
});

test('photos: out/ holds them and is gitignored, and the page\'s own limits are the server\'s', () => {
  const repo = path.resolve(__dirname, '..', '..');
  const ignored = spawnSync('git', ['check-ignore', '-q', 'setup/transcript-reader/out/uploads/' + 'a'.repeat(32) + '.jpg'], { cwd: repo });
  if (ignored.error || ignored.status === 128) return;  // not a git checkout here
  assert.equal(ignored.status, 0, 'a saved photo would show up in git status');
  const page = fs.readFileSync(path.join(__dirname, 'prototype', 'attach.js'), 'utf8');
  const [photos, one, all] = page.match(/const MAX_PHOTOS = (\d+), MAX_PHOTO_BYTES = (\d+) \* 1024 \* 1024, MAX_PHOTOS_BYTES = (\d+) \* 1024 \* 1024;/).slice(1).map(Number);
  assert.deepEqual({ MAX_PHOTOS: photos, MAX_PHOTO_BYTES: one * 1024 * 1024, MAX_PHOTOS_BYTES: all * 1024 * 1024 }, { ...PHOTO_LIMITS });
});

// ---------------------------------------------------------------- copy-sync: the hosted and sealed copies' Sync builds a new copy

// The runs of sync.py the fake runner saw (reader.py runs go through the same fake python3).
const syncRuns = (t) => t.herdr.calls.filter((call) => call.file === 'python3' && String(call.args[1]).endsWith('sync.py'));

test('copy-sync: the page\'s Sync has the laptop build the sealed copy (sync.py --seal, as the LaunchAgent would), and asks how it went', async () => {
  const t = await start();
  try {
    let release;
    t.herdr.readerGate = new Promise((resolve) => { release = resolve; });
    const started = await t.post('copy-sync', { copy: 'bucket' });
    assert.equal(started.status, 200, started.raw);
    assert.equal(started.json.status, 'ok');
    assert.equal(started.json.state, 'running');
    assert.equal(syncRuns(t).length, 1);
    const run = syncRuns(t)[0];
    assert.deepEqual(run.args.slice(2), ['--seal', path.join(t.tree.outDir, 'bucket'), '--out', path.join(t.tree.outDir, 'hosted')]);
    assert.ok(!JSON.stringify(run).includes('PASSPHRASE'), 'the server hands the build no passphrase: sync.py reads the keychain itself');
    // A second tap while it builds joins it.
    assert.equal((await t.post('copy-sync', { copy: 'bucket' })).json.state, 'running');
    assert.equal(syncRuns(t).length, 1);
    assert.equal((await t.get('copy-sync?copy=bucket')).json.state, 'running');
    release();
    await t.settle();
    const done = await t.get('copy-sync?copy=bucket');
    assert.equal(done.status, 200);
    assert.equal(done.json.state, 'done');
    assert.equal(t.herdr.agentCalls().length, 0, 'building a copy never reaches a pane');
  } finally { await t.close(); }
});

test('copy-sync: a build that fails says why, the plain copy is built by --build-only, and the owner\'s options go along', async () => {
  const t = await start({ env: { PMOS_READER_COPY_ARGS: '--panes  open --no-workspace' } });
  try {
    t.herdr.readerResult = { code: 1, stdout: '', stderr: 'Set HOSTED_READER_PASSPHRASE, keep the passphrase in the login keychain', timedOut: false, truncated: false };
    assert.equal((await t.post('copy-sync', { copy: 'bucket' })).json.state, 'running');
    await t.settle();
    const failed = (await t.get('copy-sync?copy=bucket')).json;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.message, 'Set HOSTED_READER_PASSPHRASE, keep the passphrase in the login keychain');
    t.herdr.readerResult = null;
    await t.post('copy-sync', { copy: 'hosted' });
    assert.deepEqual(syncRuns(t)[1].args.slice(2), ['--build-only', '--out', path.join(t.tree.outDir, 'hosted'), '--panes', 'open', '--no-workspace']);
    assert.equal((await t.get('copy-sync?copy=never')).status, 400);
    await t.settle();
    assert.equal((await t.get('copy-sync?copy=hosted')).json.state, 'done');
  } finally { await t.close(); }
});

test('copy-sync: the same guard as every route, and it names only the sealed or the plain copy', async () => {
  const t = await start();
  try {
    const bare = { 'Content-Type': 'application/json' };
    assert.equal((await t.request({ method: 'POST', path: '/api/transcript-reader/copy-sync', headers: { ...bare, Origin: t.origin }, body: { copy: 'bucket' } })).status, 403, 'no token');
    assert.equal((await t.request({ method: 'POST', path: '/api/transcript-reader/copy-sync', headers: { ...bare, [TOKEN_HEADER]: t.token, Origin: 'http://evil.example' }, body: { copy: 'bucket' } })).status, 403, 'a foreign origin');
    assert.equal((await t.request({ path: '/api/transcript-reader/copy-sync?copy=bucket' })).status, 403, 'no token to read it either');
    for (const body of [{}, { copy: 'both' }, { copy: '../bucket' }, { copy: 7 }]) assert.equal((await t.post('copy-sync', body)).status, 400, JSON.stringify(body));
    assert.equal(syncRuns(t).length, 0, 'nothing was built');
  } finally { await t.close(); }
});

test('Codex: a live pane maps to its native rollout and Send waits for a leading skill command', async () => {
  const t = await start({ options: (herdr, tree) => {
    writeCodexLog(tree, A, tree.root);
    herdr.panes[0] = { ...herdr.panes[0], agent: 'codex', agent_session: { value: null } };
    herdr.processInfo['w1:p1'] = [{ pid: 9001, argv0: 'codex', cwd: tree.root }];
    return { pause: async (ms) => herdr.pauses.push(ms) };
  } });
  try {
    const state = await t.state();
    assert.equal(state.status, 200);
    assert.equal(state.json.panes[A].status, 'idle');
    assert.equal(state.json.focus.session_id, A);
    const sent = await t.send({ session_id: A, text: '$open skill' });
    assert.equal(sent.status, 200, sent.raw);
    assert.equal(t.herdr.pauses[0], 1200);
    assert.equal(t.herdr.prompts().at(-1).args.at(-1), '$open skill');
  } finally { await t.close(); }
});

test('Codex: Sync adopts an unlisted live Codex pane, and a changed foreground session is rejected', async () => {
  const t = await start({ options: (herdr, tree) => {
    writeCodexLog(tree, A, tree.root);
    writeCodexLog(tree, B, path.join(tree.root, 'other'));
    const unlistedCwd = path.join(tree.root, 'd');
    writeCodexLog(tree, D, unlistedCwd);
    herdr.panes[0] = { ...herdr.panes[0], agent: 'codex', agent_session: { value: null } };
    herdr.panes[2] = { ...herdr.panes[2], agent: 'codex', agent_session: { value: null } };
    let foregroundChecks = 0;
    herdr.processInfo['w1:p1'] = () => {
      foregroundChecks += 1;
      const changed = foregroundChecks === 3;
      return [{ pid: changed ? 9002 : 9001, argv0: 'codex', cwd: changed ? path.join(tree.root, 'other') : tree.root }];
    };
    herdr.processInfo['w1:p3'] = [{ pid: 9003, argv0: 'codex', cwd: unlistedCwd }];
    return { pause: async () => {} };
  } });
  try {
    const synced = await t.post('sync', {});
    assert.equal(synced.status, 200, synced.raw);
    assert.ok(t.herdr.readerRuns().some((run) => run[0] === 'adopt' && run.includes(D)), 'Sync should adopt the unlisted Codex rollout');
    const refused = await t.send({ session_id: A, text: 'continue' });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'other_session');
    assert.equal(t.herdr.prompts().length, 0);
  } finally { await t.close(); }
});
