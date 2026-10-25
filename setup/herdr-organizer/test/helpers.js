'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { create } = require('../api');
const { createAdapter } = require('../adapter');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// A fake process runner. `calls` records every command so tests can assert what
// was (and was not) spawned. `overrides` may supply a function that returns a
// result for a call, or undefined to fall through to the fixtures.
// A temporary directory tree for a test. Cleanup removes only what the test created and
// registered, one entry at a time (unlink, then rmdir deepest first). It never deletes
// recursively and never follows a link, so a symlink to somewhere else is only unlinked.
function tempTree(prefix = 'herdr-organizer-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const files = [];
  const dirs = [root];
  const abs = (rel) => path.join(root, rel);
  const tree = {
    root,
    real: fs.realpathSync(root),
    abs,
    mkdir(rel) {
      const target = abs(rel);
      const missing = [];
      for (let current = target; current !== root && !fs.existsSync(current); current = path.dirname(current)) missing.push(current);
      fs.mkdirSync(target, { recursive: true });
      dirs.push(...missing.reverse());
      return target;
    },
    write(rel, content) {
      tree.mkdir(path.dirname(rel));
      fs.writeFileSync(abs(rel), content);
      files.push(abs(rel));
      return abs(rel);
    },
    link(rel, target) {
      tree.mkdir(path.dirname(rel));
      fs.symlinkSync(target, abs(rel));
      files.push(abs(rel));
      return abs(rel);
    },
    // Unlinks every non-directory entry directly inside one directory (no recursion), for
    // files a tool created that the test did not register itself.
    sweep(rel) {
      const dir = abs(rel);
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) if (!entry.isDirectory()) files.push(path.join(dir, entry.name));
    },
    // Registers a directory a tool created, so cleanup removes it once it is empty.
    trackDir(rel) { dirs.push(abs(rel)); },
    cleanup() {
      for (const file of files.reverse()) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
      for (const dir of [...dirs].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(dir); } catch { /* not empty or gone */ } }
    },
  };
  return tree;
}

function fakeRunner(overrides = {}) {
  const calls = [];
  const runner = async (file, args, options = {}) => {
    calls.push({ file, args: args.slice(), input: options.input, env: options.env });
    if (overrides.handle) {
      const custom = await overrides.handle(file, args);
      if (custom !== undefined) return custom;
    }
    const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });
    if (file === 'herdr' && args[0] === 'session' && args[1] === 'list') return ok(overrides.sessions ? JSON.stringify({ sessions: overrides.sessions }) : fixture('session-list.json'));
    if (file === 'herdr' && args[0] === '--session' && args[2] === 'pane' && args[3] === 'list') {
      if (overrides.panes) return ok(JSON.stringify({ result: { panes: overrides.panes } }));
      let text = fixture('pane-list.json');
      if (overrides.paneCwd) text = text.replace(/\/fixture\/work\/(alpha\/sub|alpha|beta)/g, overrides.paneCwd);
      return ok(text);
    }
    if (args.includes('reconcile-all')) return ok(fixture('reconcile-preview.txt'));
    if (args.includes('verify-identity')) return ok(fixture(args.includes('--apply') ? 'verify-apply.txt' : 'verify-report.txt'));
    if (typeof args[0] === 'string' && args[0].endsWith('store_check.py')) {
      return ok(JSON.stringify(overrides.storeCheck || { valid_format: true, exists: true, store_folder: 'match', registered_elsewhere: false, already_registered_here: false }));
    }
    if (args.includes('register')) return ok('registered ok\nmanifest: /fixture/manifest.json\n');
    if (args.includes('cleanup-empty-tabs')) {
      const workspace = args[args.indexOf('--workspace') + 1];
      const name = 'cleanup-' + workspace + '.txt';
      return fs.existsSync(path.join(FIXTURES, name)) ? ok(fixture(name)) : { code: 1, stdout: '', stderr: 'unknown workspace', timedOut: false, truncated: false };
    }
    if (args.includes('archive-all')) return ok(fixture('archive-all-preview.txt'));
    if (args.includes('prepare-restart-recovery')) {
      const acknowledged = args.includes('--allow-volatile-pane') && args.includes('--allow-mixed-cwd-workspace');
      const sealing = !args.includes('--preflight-only');
      const name = sealing && acknowledged ? 'seal-ok.txt' : acknowledged ? 'preflight-pass.txt' : 'preflight-fail.txt';
      return { code: acknowledged ? 0 : 1, stdout: fixture(name), stderr: '', timedOut: false, truncated: false };
    }
    return { code: 1, stdout: '', stderr: 'unexpected command', timedOut: false, truncated: false };
  };
  return { runner, calls };
}

// Starts a real HTTP server on an ephemeral loopback port wired to the API
// module, the way serve.sh wires it.
async function startServer({ runner, toolRoot = '/fixture/tools', env = {}, fmHome = '/fixture/fm-home', gaugeScript = '/fixture/bin/fm-ctx-gauge.sh', now, rollover, switches } = {}) {
  const fake = runner ? { runner, calls: [] } : fakeRunner();
  const active = runner || fake.runner;
  let api;
  const server = http.createServer((req, res) => {
    if (api.handle(req, res)) return;
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const adapter = createAdapter({ toolRoot, runner: active, env, fmHome, gaugeScript, ...(now ? { now } : {}) });
  api = create({ root: '/fixture/root', port, adapter, env, toolRoot, ...(rollover ? { rollover } : {}), ...(switches ? { switches } : {}) });
  return {
    port,
    api,
    calls: fake.calls,
    origin: 'http://localhost:' + port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function request({ port, method = 'GET', path: urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// A same-origin client: obtains the token the way the page does, then posts actions.
async function client(server) {
  const base = { Host: 'localhost:' + server.port };
  const tokenResponse = await request({ port: server.port, path: '/api/herdr-organizer/token', headers: base });
  const token = tokenResponse.json && tokenResponse.json.token;
  const post = (action, params, extra = {}) => request({
    port: server.port,
    method: 'POST',
    path: '/api/herdr-organizer/run',
    headers: { ...base, Origin: server.origin, 'Content-Type': 'application/json', 'X-Herdr-Organizer-Token': token, ...extra },
    body: params === undefined ? { action } : { action, params },
  });
  return { token, post, base };
}

module.exports = { fixture, tempTree, fakeRunner, startServer, request, client };
