'use strict';

// A Send made on a phone while the laptop is away goes through the existing queue once the laptop answers: held on the phone
// (hosted.js outbox), posted to the reader's own server (api.js queue route), delivered by drain.js to a fake Herdr, and the
// receipt comes back sealed for the phone to read. Run: node --test setup/transcript-reader/phonequeue.test.js
// Nothing here can reach a real pane: Herdr is a fake that records its calls. The passphrase is a made-up one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const phone = require('./phonefake');
const { start } = require('./server');
const { drain } = require('./drain');
const { TOKEN_META } = require('./api');

const SESSION = '11111111-1111-4111-8111-111111111111';  // the conversation phonefake's copy lists
const plain = (value) => JSON.parse(JSON.stringify(value));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function fakeHerdr() {
  const herdr = { calls: [] };
  const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });
  herdr.runner = async (file, args) => {
    herdr.calls.push({ file, args: args.slice() });
    if (args[0] === 'session') return ok(JSON.stringify({ sessions: [{ name: 'work', default: false, running: true }] }));
    if (args[2] === 'api' && args[3] === 'snapshot') return ok(JSON.stringify({ result: { snapshot: { focused_pane_id: 'w1:p1', tabs: [], panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', label: 'alpha', agent_status: 'idle', agent_session: { value: SESSION } }] } } }));
    if (args[2] === 'pane' && args[3] === 'process-info') return ok(JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 1001, argv0: 'claude' }] } } }));
    if (args[2] === 'agent') return ok('{}');
    return { code: 1, stdout: '', stderr: 'unexpected command', timedOut: false, truncated: false };
  };
  herdr.prompts = () => herdr.calls.filter((call) => call.args[2] === 'agent' && call.args[3] === 'prompt');
  return herdr;
}

test('a Send queued from a phone with the laptop away is carried out once when it is back, and its receipt reaches the phone', async (t) => {
  // The reader's own server, serving a sealed bucket folder it also takes queued requests into.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-phonequeue-'));
  const root = path.join(base, 'repo');
  const bucket = path.join(root, 'setup', 'transcript-reader', 'out', 'bucket');
  fs.mkdirSync(path.join(bucket, 'k'), { recursive: true });
  const laptop = await phone.laptop({ conversations: 1, documents: 0, weeks: 0 });
  fs.writeFileSync(path.join(bucket, 'k', 'params.json'), JSON.stringify(laptop.params));
  fs.writeFileSync(path.join(bucket, 'index.json.enc'), laptop.sealed.get('index.json'));
  fs.writeFileSync(path.join(bucket, 'index.html'), `<!doctype html><head>${TOKEN_META}</head>shell`);
  const port = await freePort();
  const server = await start({ root, port, env: {}, pinsFile: path.join(base, 'pins.json'), projectsDir: path.join(base, 'projects'), claudeSessionsDir: path.join(base, 'sessions'), runner: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, truncated: false }) });
  t.after(() => server.close());
  const call = (options) => new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : options.body;
    const req = http.request({ host: '127.0.0.1', port, method: options.method || 'GET', path: options.path, headers: { Host: `localhost:${port}`, ...options.headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  const shell = await call({ path: '/setup/transcript-reader/out/bucket/index.html', headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
  const token = shell.body.toString().match(/content="([0-9a-f]{64})"/)[1];

  // The phone's connection to the laptop: the queue and the receipts go to the real server, the rest is the sealed copy in memory.
  const memory = laptop.respond;
  laptop.respond = async (url, options = {}) => {
    const forwarded = url.startsWith('/api/transcript-reader/queue') || /^r\//.test(url);
    if (!forwarded) return memory(url, options);
    laptop.requests.push({ url, method: options.method || 'GET', headers: options.headers });
    if (laptop.down) throw new TypeError('Load failed');
    const route = options.method === 'POST' ? url : `/setup/transcript-reader/out/bucket/${url}`;
    const answer = await call({ method: options.method, path: route, body: options.body, headers: { ...options.headers, Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    return { ok: answer.status < 400, status: answer.status, json: async () => JSON.parse(answer.body.toString()), arrayBuffer: async () => answer.body.buffer.slice(answer.body.byteOffset, answer.body.byteOffset + answer.body.byteLength) };
  };
  const device = phone.device();
  // The page carries the token the real server wrote into the shell.
  const tokened = phone.page({ laptop, device, token });
  await tokened.hosted.prepare();
  await tokened.hosted.unlock(phone.PASSPHRASE, true);

  // 1. The laptop is away: the Send is held on the phone and nothing reached the server.
  laptop.down = true;
  const held = await tokened.hosted.enqueue(SESSION, 'A1=accept;A2=inline, sent from a train');
  assert.equal(held.held, true);
  assert.deepEqual(fs.existsSync(path.join(bucket, 'q')) ? fs.readdirSync(path.join(bucket, 'q')) : [], []);

  // 2. The laptop answers again: the held send goes to the reader's queue, sealed, under its id.
  laptop.down = false;
  assert.deepEqual(plain(await tokened.hosted.flush()), [{ id: held.id, state: 'queued' }]);
  assert.deepEqual(fs.readdirSync(path.join(bucket, 'q')), [`${held.id}.json.enc`]);
  assert.equal(fs.statSync(path.join(bucket, 'q', `${held.id}.json.enc`)).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(bucket, 'q', `${held.id}.json.enc`)).includes('from a train'), 'the server only ever holds sealed bytes');
  assert.deepEqual(plain(await tokened.hosted.flush()), [], 'nothing left to post');

  // 3. The sync's drain delivers it to a fake Herdr, once, however often it runs.
  const herdr = fakeHerdr();
  const options = { folder: bucket, sealed: true, stateFolder: path.join(base, 'state'), passphrase: phone.PASSPHRASE, runner: herdr.runner, claudeSessionsDir: path.join(base, 'no-sessions'), pause: async () => {} };
  assert.deepEqual(plain(await drain(options)), { sent: 1, refused: 0, interrupted: 0, expired: 0 });
  assert.deepEqual(herdr.prompts().map((c) => c.args), [['--session', 'work', 'agent', 'prompt', 'w1:p1', 'A1=accept;A2=inline, sent from a train']]);
  assert.deepEqual(plain(await drain(options)), { sent: 0, refused: 0, interrupted: 0, expired: 0 });
  assert.equal(herdr.prompts().length, 1, 'never twice');

  // 4. The phone reads the sealed receipt from the server.
  const receipt = plain(await tokened.hosted.receipt(held.id));
  assert.equal(receipt.state, 'sent');
  assert.equal(receipt.label, 'alpha');
  assert.equal(receipt.session_id, SESSION);

  // A held send the laptop already has (the post got through, the answer was lost) is not queued a second time.
  laptop.down = true;
  const again = await tokened.hosted.enqueue(SESSION, 'second message');
  laptop.down = false;
  await call({ method: 'POST', path: '/api/transcript-reader/queue', headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token, Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(plain(await outboxBody(device, again.id))) });
  assert.deepEqual(plain(await tokened.hosted.flush()), [{ id: again.id, state: 'queued' }]);
  assert.deepEqual(fs.readdirSync(path.join(bucket, 'q')), [`${again.id}.json.enc`], 'still one request in the queue');
});

const TOKEN_HEADER = 'x-transcript-reader-token';
// The body a held send would post, read from the phone's outbox.
async function outboxBody(device, id) {
  return device.indexedDB.dump('hosted-reader').get('outbox').get(id).body;
}
