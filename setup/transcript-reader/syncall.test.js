'use strict';

// One Sync click, end to end: the server's sync route with the real reader.py and builder, against
// synthetic logs and a fake Herdr in a temporary folder. It pins that a click brings every listed
// live session up to date (turns, and the state of its pane), not only the one Herdr has focused or
// the one open on screen. Run from the repo root:
//   node --test setup/transcript-reader/syncall.test.js
// No real session, pane or page is read or written: the repo copy is copied into a temporary root,
// HOME points at a temporary folder, and `herdr` is a script there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { create, TOKEN_HEADER } = require('./api');

const IDS = { A: 'aaaaaaaa-1111-4111-8111-111111111111', B: 'bbbbbbbb-2222-4222-8222-222222222222', C: 'cccccccc-3333-4333-8333-333333333333' };
const PANES = { A: 'w1:p1', B: 'w1:p2', C: 'w1:p3' };

// The few calls reader.py and api.js make, answered from herdr.json beside it (a test edits that file).
const FAKE_HERDR = `#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
config = json.load(open(os.path.join(here, 'herdr.json')))
args = sys.argv[1:]
if args[:1] == ['--session']:
    args = args[2:]
def out(value):
    print(json.dumps(value))
if args[:2] == ['session', 'list']:
    out({'sessions': [{'name': 'work', 'default': False, 'running': True, 'session_dir': here}]})
elif args[:2] == ['pane', 'list']:
    out({'result': {'panes': config['panes']}})
elif args[:2] == ['tab', 'list']:
    out({'result': {'tabs': []}})
elif args[:2] == ['api', 'snapshot']:
    out({'result': {'snapshot': {'focused_pane_id': config['focused'], 'panes': config['panes'], 'tabs': []}}})
elif args[:2] == ['pane', 'process-info']:
    out({'result': {'process_info': {'foreground_processes': [{'pid': os.getpid(), 'argv0': 'claude'}]}}})
else:
    sys.exit(1)
`;

// A repo-shaped temporary root holding a copy of the reader (reader.py, the builders and the page template),
// so a rebuild writes its out/ folder there, and a home with one log per session.
function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-syncall-')));
  const root = path.join(base, 'repo');
  const here = path.join(root, 'setup', 'transcript-reader');
  fs.cpSync(__dirname, here, { recursive: true, filter: (from) => !['__pycache__', 'out', 'replit'].includes(path.basename(from)) });
  const home = path.join(base, 'home');
  const logs = path.join(home, '.claude', 'projects', '-Users-someone-project');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(path.join(here, 'out'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(here, 'out', 'sessions.txt'), Object.values(IDS).join('\n') + '\n');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), FAKE_HERDR, { mode: 0o755 });
  const herdr = {
    focused: PANES.A,
    panes: Object.keys(IDS).map((key) => ({ pane_id: PANES[key], tab_id: 'w1:t1', label: 'live-' + key, agent: 'claude', agent_status: 'idle', agent_session: { value: IDS[key] } })),
  };
  const saveHerdr = () => fs.writeFileSync(path.join(bin, 'herdr.json'), JSON.stringify(herdr));
  saveHerdr();
  let clock = Date.parse('2026-10-26T02:00:00Z') / 1000;
  const log = (key) => path.join(logs, IDS[key] + '.jsonl');
  // One turn: a message from the owner and the agent's reply, a second apart.
  const turn = (key, text) => {
    clock += 60;
    const stamp = (seconds) => new Date((clock + seconds) * 1000).toISOString();
    const record = (type, seconds, message) => JSON.stringify({ type, timestamp: stamp(seconds), cwd: '/Users/someone/project', message }) + '\n';
    fs.appendFileSync(log(key), record('user', 0, { role: 'user', content: text }) + record('assistant', 1, { role: 'assistant', content: [{ type: 'text', text: 'reply to ' + text }] }));
    fs.utimesSync(log(key), new Date(), new Date());
  };
  return {
    root, here, home, bin, herdr, turn,
    focus: (key) => { herdr.focused = PANES[key]; saveHerdr(); },
    status: (key, value) => { herdr.panes.find((pane) => pane.pane_id === PANES[key]).agent_status = value; saveHerdr(); },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

async function start(w) {
  const token = 'a1'.repeat(32);
  const env = { ...process.env, HOME: w.home, PATH: w.bin + path.delimiter + process.env.PATH, PMOS_READER_PINS: path.join(w.home, 'pins.json') };
  let api;
  const server = http.createServer((req, res) => { if (!api.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  api = create({
    root: w.root, port, token, env, herdrBin: path.join(w.bin, 'herdr'),
    projectsDir: path.join(w.home, '.claude', 'projects'), claudeSessionsDir: path.join(w.home, '.claude', 'sessions'), pinsFile: path.join(w.home, 'pins.json'),
  });
  const host = 'localhost:' + port;
  const call = (method, command, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Host: host, Origin: 'http://' + host, [TOKEN_HEADER]: token, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: '127.0.0.1', port, method, path: '/api/transcript-reader/' + command, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  // The page as a tab swaps it in: the server's current text of the built page, and the payload inside it.
  const payload = async () => {
    const answer = await call('GET', 'page?name=prototype.html');
    assert.equal(answer.status, 200);
    return JSON.parse(answer.json.html.match(/<script id="payload" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  };
  return { call, payload, sync: (body = {}) => call('POST', 'sync', body), close: () => new Promise((resolve) => server.close(resolve)) };
}

const newestAsk = (payload, id) => {
  const session = payload.sessions.find((s) => s.id === id);
  assert.ok(session, `${id.slice(0, 8)} is on the page`);
  return session.exchanges.filter((e) => e.source === 'captain').map((e) => e.input).pop();
};

test('sync: one click brings every listed live session up to date, not only the focused or the open one', { timeout: 120000 }, async () => {
  const w = world();
  const server = await start(w);
  try {
    for (const key of 'ABC') w.turn(key, `first ask ${key}`);
    const first = await server.sync();
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const page = await server.payload();
    for (const key of 'ABC') assert.equal(newestAsk(page, IDS[key]), `first ask ${key}`);
    assert.deepEqual(Object.keys(first.json.panes).sort(), Object.values(IDS).sort());

    // While the owner reads A, with Herdr focused on A and no poll in between, the two others move on.
    w.focus('A');
    w.turn('B', 'second ask B');
    w.turn('C', 'second ask C');
    w.status('B', 'working');
    w.status('C', 'blocked');
    const stale = await server.payload();
    assert.equal(newestAsk(stale, IDS.B), 'first ask B', 'nothing has read the logs again yet');

    const synced = await server.sync();
    assert.equal(synced.status, 200, JSON.stringify(synced.json));
    const after = await server.payload();
    assert.ok(after.generated > page.generated, 'the page was built again');
    assert.equal(synced.json.stamps.reader, after.generated, 'the answer names that very build');
    assert.equal(newestAsk(after, IDS.A), 'first ask A');
    assert.equal(newestAsk(after, IDS.B), 'second ask B', 'a session that was not focused has its newest turn');
    assert.equal(newestAsk(after, IDS.C), 'second ask C');
    const reply = (id) => after.sessions.find((s) => s.id === id).exchanges.at(-1).reply;
    assert.equal(reply(IDS.B), 'reply to second ask B');
    assert.equal(reply(IDS.C), 'reply to second ask C');
    // Each pane's state is Herdr's now, for all of them, in the same answer.
    assert.deepEqual(Object.fromEntries(Object.entries(synced.json.panes).map(([id, pane]) => [id, pane.status])), { [IDS.A]: 'idle', [IDS.B]: 'working', [IDS.C]: 'blocked' });
  } finally { await server.close(); w.cleanup(); }
});
