'use strict';

// Tests for drain.js, the delivery half of the hosted copy's Send. Run from the repo root:
//   node --test setup/transcript-reader/drain.test.js
// Herdr is a fake that records every call (nothing here can reach a real pane or session); the
// queue, the receipts and the sealed bucket are temporary folders; the passphrase is made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const seal = require('./prototype/seal.js');
const { drain, summary, TTL_MS, RECEIPT_KEEP_MS } = require('./drain.js');

const PASS = 'a made-up passphrase for the drain tests';
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';  // a live pane runs it, but the copy does not list it
const Q1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const Q2 = '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const Q3 = '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

// A fake Herdr: session "work" with a pane per conversation. Every call is recorded.
function fakeHerdr() {
  const herdr = {
    panes: [
      { pane_id: 'w1:p1', tab_id: 'w1:t1', label: 'alpha', agent_status: 'idle', agent_session: { value: A } },
      { pane_id: 'w1:p2', tab_id: 'w1:t2', label: 'beta', agent_status: 'blocked', agent_session: { value: B } },
      { pane_id: 'w1:p3', tab_id: 'w1:t3', label: 'gamma', agent_status: 'idle', agent_session: { value: C } },
    ],
    processInfo: { 'w1:p1': [{ pid: 1001, argv0: 'claude' }], 'w1:p2': [{ pid: 1002, argv0: 'claude' }], 'w1:p3': [{ pid: 1003, argv0: 'claude' }] },
    promptResult: { code: 0, stdout: '{}', stderr: '' },
    calls: [],
  };
  const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });
  herdr.runner = async (file, args) => {
    herdr.calls.push({ file, args: args.slice() });
    if (args[0] === 'session') return ok(JSON.stringify({ sessions: [{ name: 'work', default: false, running: true }] }));
    if (args[2] === 'api' && args[3] === 'snapshot') return ok(JSON.stringify({ result: { snapshot: { focused_pane_id: 'w1:p1', panes: herdr.panes, tabs: [] } } }));
    if (args[2] === 'pane' && args[3] === 'process-info') return ok(JSON.stringify({ result: { process_info: { foreground_processes: herdr.processInfo[args[5]] || [] } } }));
    if (args[2] === 'agent' && args[3] === 'prompt') return { timedOut: false, truncated: false, ...herdr.promptResult };
    if (args[2] === 'agent' && args[3] === 'send-keys') return ok('{}');
    return { code: 1, stdout: '', stderr: 'unexpected command', timedOut: false, truncated: false };
  };
  herdr.prompts = () => herdr.calls.filter((call) => call.args[2] === 'agent' && call.args[3] === 'prompt');
  return herdr;
}

const E = 'eeeeeeee-5555-4555-8555-555555555555';  // listed, but no pane runs it
const CONVERSATIONS = { conversations: [{ id: A }, { id: B }, { id: E }] };

// A plain copy's folder (out/hosted) or a sealed bucket's, holding the index and no queue yet.
async function copy({ sealed = false } = {}) {
  // The folder sits in a folder of its own: the drain keeps its ledger of handled ids beside the folder, not in it.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-drain-'));
  const folder = path.join(base, sealed ? 'bucket' : 'hosted');
  fs.mkdirSync(folder);
  let key = null;
  if (sealed) {
    let params;
    ({ params, key } = await seal.newParams(PASS));
    fs.mkdirSync(path.join(folder, 'k'));
    fs.writeFileSync(path.join(folder, 'k', 'params.json'), JSON.stringify(params));
    fs.writeFileSync(path.join(folder, 'index.json.enc'), await seal.close(key, 'index.json', zlib.gzipSync(Buffer.from(JSON.stringify(CONVERSATIONS)))));
  } else fs.writeFileSync(path.join(folder, 'index.json'), JSON.stringify(CONVERSATIONS));
  const herdr = fakeHerdr();
  const claudeSessionsDir = path.join(folder, 'no-claude-sessions');
  const api = {
    folder, base, key, herdr, sealed,
    async queue(id, request, { age = 0 } = {}) {
      fs.mkdirSync(path.join(folder, 'q'), { recursive: true });
      const text = Buffer.from(typeof request === 'string' ? request : JSON.stringify({ id, at: Date.now() / 1000, ...request }));
      const file = path.join(folder, 'q', id + (sealed ? '.json.enc' : '.json'));
      fs.writeFileSync(file, sealed ? await seal.close(key, `q/${id}.json`, zlib.gzipSync(text)) : text);
      if (age) { const then = new Date(Date.now() - age); fs.utimesSync(file, then, then); }
    },
    async receipt(id) {
      const file = path.join(folder, 'r', id + (sealed ? '.json.enc' : '.json'));
      if (!fs.existsSync(file)) return null;
      const bytes = fs.readFileSync(file);
      return JSON.parse(sealed ? zlib.gunzipSync(Buffer.from(await seal.open(key, `r/${id}.json`, bytes))).toString('utf8') : bytes.toString('utf8'));
    },
    queued: () => (fs.existsSync(path.join(folder, 'q')) ? fs.readdirSync(path.join(folder, 'q')) : []),
    ledger: () => path.join(base, 'state', `.drain-handled-v2-${crypto.createHash('sha256').update(fs.realpathSync(folder)).digest('hex').slice(0, 16)}.json`),
    drain: (options = {}) => drain({ folder, sealed, stateFolder: path.join(base, 'state'), passphrase: PASS, runner: herdr.runner, claudeSessionsDir, pause: async () => {}, ...options }),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
  return api;
}

for (const sealed of [false, true]) {
  const kind = sealed ? 'sealed' : 'plain';

  test(`${kind}: a queued message is sent once through the reader's own send, and its receipt says so`, async (t) => {
    const lab = await copy({ sealed });
    t.after(lab.cleanup);
    await lab.queue(Q1, { session_id: A, text: 'A1=accept;A2=inline' });
    const result = await lab.drain();
    assert.deepEqual(result, { sent: 1, refused: 0, interrupted: 0, expired: 0 });
    assert.equal(lab.herdr.prompts().length, 1);
    assert.deepEqual(lab.herdr.prompts()[0].args, ['--session', 'work', 'agent', 'prompt', 'w1:p1', 'A1=accept;A2=inline']);
    const receipt = await lab.receipt(Q1);
    assert.equal(receipt.state, 'sent');
    assert.equal(receipt.session_id, A);
    assert.equal(receipt.label, 'alpha');
    assert.ok(receipt.at > 0 && receipt.queued_at > 0);
    assert.deepEqual(lab.queued(), [], 'the request left the queue');
    assert.equal((await lab.drain()).sent, 0);
    assert.equal(lab.herdr.prompts().length, 1, 'never sent again');
    assert.match(summary(result), /1 sent, 0 refused/);
  });

  test(`${kind}: a message that fails the pane checks is refused with its reason, and nothing reaches the pane`, async (t) => {
    const lab = await copy({ sealed });
    t.after(lab.cleanup);
    // B's agent is at a permission prompt; C is not a conversation of this copy; E has no pane.
    await lab.queue(Q1, { session_id: B, text: 'go on' });
    await lab.queue(Q2, { session_id: C, text: 'go on' });
    await lab.queue(Q3, { session_id: E, text: 'go on' });
    const result = await lab.drain();
    assert.deepEqual(result, { sent: 0, refused: 3, interrupted: 0, expired: 0 });
    assert.equal((await lab.receipt(Q1)).code, 'agent_blocked');
    assert.match((await lab.receipt(Q1)).reason, /permission prompt/);
    assert.equal((await lab.receipt(Q2)).code, 'not_listed');
    assert.equal((await lab.receipt(Q3)).code, 'no_pane');
    assert.equal(lab.herdr.calls.filter((call) => call.args[2] === 'agent').length, 0, 'no key and no prompt reached any pane');
    assert.deepEqual(lab.queued(), []);
  });

  test(`${kind}: a pane whose agent left the foreground for a shell is refused`, async (t) => {
    const lab = await copy({ sealed });
    t.after(lab.cleanup);
    lab.herdr.processInfo['w1:p1'] = [{ pid: 2001, argv0: 'zsh' }];
    await lab.queue(Q1, { session_id: A, text: 'hello' });
    await lab.drain();
    assert.equal((await lab.receipt(Q1)).code, 'agent_not_foreground');
    assert.equal(lab.herdr.prompts().length, 0);
  });

  test(`${kind}: a request that is not what the page writes is refused, not sent`, async (t) => {
    const lab = await copy({ sealed });
    t.after(lab.cleanup);
    await lab.queue(Q1, { session_id: A, text: 'bad\u001b[201~ keys' });
    await lab.queue(Q2, { session_id: A, text: '--help' });
    await lab.queue(Q3, { id: 'ffffffff-aaaa-4aaa-8aaa-ffffffffffff', session_id: A, text: 'another id inside' });
    const result = await lab.drain();
    assert.equal(result.refused, 3);
    for (const id of [Q1, Q2, Q3]) assert.equal((await lab.receipt(id)).code, 'invalid', id);
    assert.equal(lab.herdr.calls.length, 0, 'Herdr was not even asked');
  });

  test(`${kind}: a request that waited over 12 hours is expired, and one just inside is sent`, async (t) => {
    const lab = await copy({ sealed });
    t.after(lab.cleanup);
    await lab.queue(Q1, { session_id: A, text: 'too late' }, { age: TTL_MS + 60000 });
    await lab.queue(Q2, { session_id: A, text: 'in time' }, { age: TTL_MS - 600000 });
    const result = await lab.drain();
    assert.equal(result.sent, 1);
    assert.equal(result.expired, 1);
    assert.equal((await lab.receipt(Q1)).code, 'expired');
    assert.equal((await lab.receipt(Q2)).state, 'sent');
    assert.deepEqual(lab.herdr.prompts().map((call) => call.args[5]), ['in time']);
  });

  test(`${kind}: a run that stopped while sending never sends again; the receipt becomes an interrupted refusal`, async (t) => {
    const lab = await copy({ sealed });
    t.after(lab.cleanup);
    await lab.queue(Q1, { session_id: A, text: 'maybe sent' });
    // What the stopped run left: the "sending" receipt, written before the send.
    const text = Buffer.from(JSON.stringify({ id: Q1, session_id: A, state: 'sending', at: 1 }));
    fs.mkdirSync(path.join(lab.folder, 'r'));
    fs.writeFileSync(path.join(lab.folder, 'r', Q1 + (sealed ? '.json.enc' : '.json')), sealed ? await seal.close(lab.key, `r/${Q1}.json`, zlib.gzipSync(text)) : text);
    const result = await lab.drain();
    assert.equal(result.interrupted, 1);
    assert.equal(lab.herdr.prompts().length, 0);
    const receipt = await lab.receipt(Q1);
    assert.equal(receipt.state, 'refused');
    assert.equal(receipt.code, 'interrupted');
    assert.deepEqual(lab.queued(), []);
  });

  test(`${kind}: a refusal from Herdr is a refusal, not a claim of delivery`, async (t) => {
    const lab = await copy({ sealed });
    t.after(lab.cleanup);
    lab.herdr.promptResult = { code: 1, stdout: '', stderr: 'boom' };
    await lab.queue(Q1, { session_id: A, text: 'hello' });
    await lab.drain();
    const receipt = await lab.receipt(Q1);
    assert.equal(receipt.state, 'refused');
    assert.equal(receipt.code, 'herdr_failed');
  });

  test(`${kind}: with nothing queued, Herdr is never asked and no passphrase is needed`, async (t) => {
    const lab = await copy({ sealed });
    t.after(lab.cleanup);
    assert.deepEqual(await lab.drain({ passphrase: '' }), { sent: 0, refused: 0, interrupted: 0, expired: 0 });
    assert.equal(lab.herdr.calls.length, 0);
    assert.match(summary({ sent: 0, refused: 0, interrupted: 0, expired: 0 }), /nothing queued/);
  });

  test(`${kind}: receipts older than a week go, newer ones stay`, async (t) => {
    const lab = await copy({ sealed });
    t.after(lab.cleanup);
    await lab.queue(Q1, { session_id: A, text: 'one' });
    await lab.drain();
    const file = path.join(lab.folder, 'r', Q1 + (sealed ? '.json.enc' : '.json'));
    await lab.queue(Q2, { session_id: A, text: 'two' });
    await lab.drain();
    const then = new Date(Date.now() - RECEIPT_KEEP_MS - 60000);
    fs.utimesSync(file, then, then);
    await lab.drain();
    assert.equal(fs.existsSync(file), false);
    assert.equal((await lab.receipt(Q2)).state, 'sent');
  });
}

test('the caller says whether the folder is sealed; a bucket that lost its params is not read as a plain copy', async (t) => {
  const lab = await copy({ sealed: true });
  t.after(lab.cleanup);
  // Someone with write access to the bucket deletes k/params.json and plants a plain request.
  fs.unlinkSync(path.join(lab.folder, 'k', 'params.json'));
  fs.mkdirSync(path.join(lab.folder, 'q'));
  fs.writeFileSync(path.join(lab.folder, 'q', Q1 + '.json'), JSON.stringify({ id: Q1, session_id: A, text: 'planted', at: Date.now() / 1000 }));
  fs.writeFileSync(path.join(lab.folder, 'index.json'), JSON.stringify(CONVERSATIONS));
  assert.deepEqual(await lab.drain(), { sent: 0, refused: 0, interrupted: 0, expired: 0 }, 'a plain request in a sealed bucket is never read');
  fs.writeFileSync(path.join(lab.folder, 'q', Q2 + '.json.enc'), Buffer.from('HRC1' + 'x'.repeat(40)));
  assert.equal((await lab.drain()).error, 'no-params');
  assert.match(summary({ sent: 0, refused: 0, interrupted: 0, expired: 0, error: 'no-params' }), /no k\/params\.json/);
  assert.equal(lab.herdr.calls.length, 0);
  assert.deepEqual(lab.queued().sort(), [Q1 + '.json', Q2 + '.json.enc']);
  await assert.rejects(drain({ folder: lab.folder, runner: lab.herdr.runner }), /sealed bucket or a plain copy/);
  // And a folder that is plain is read as plain whatever else it holds.
  const plain = await copy();
  t.after(plain.cleanup);
  fs.mkdirSync(path.join(plain.folder, 'k'));
  fs.writeFileSync(path.join(plain.folder, 'k', 'params.json'), '{}');
  await plain.queue(Q1, { session_id: A, text: 'hello' });
  assert.equal((await plain.drain()).sent, 1);
});

test('a request is as old as the time sealed inside it, so a copy put back with a new file time is expired', async (t) => {
  const lab = await copy({ sealed: true });
  t.after(lab.cleanup);
  const day = 24 * 3600;
  await lab.queue(Q1, { session_id: A, text: 'an old request, replayed', at: Date.now() / 1000 - day });  // the file itself is brand new
  await lab.queue(Q2, { session_id: A, text: 'from a clock that is wrong', at: Date.now() / 1000 + 3600 });
  const result = await lab.drain();
  assert.equal(result.expired, 1);
  assert.equal((await lab.receipt(Q1)).code, 'expired');
  assert.equal((await lab.receipt(Q2)).code, 'invalid');
  assert.match((await lab.receipt(Q2)).reason, /clock/);
  assert.equal(lab.herdr.calls.length, 0);
});

test('a request refused for its time is on the laptop\'s record too, so it is not sent when its time comes', async (t) => {
  const lab = await copy({ sealed: true });
  t.after(lab.cleanup);
  // Dated an hour ahead (the page's clock is wrong): refused now. Its receipt is deleted and the same bytes put back
  // two hours later, when the time inside is the past and fresh.
  await lab.queue(Q1, { session_id: A, text: 'from a clock that is wrong', at: Date.now() / 1000 + 3600 });
  const copyOf = fs.readFileSync(path.join(lab.folder, 'q', Q1 + '.json.enc'));
  assert.equal((await lab.receipt(Q1)), null);
  assert.equal((await lab.drain()).refused, 1);
  assert.equal((await lab.receipt(Q1)).code, 'invalid');
  fs.unlinkSync(path.join(lab.folder, 'r', Q1 + '.json.enc'));
  fs.writeFileSync(path.join(lab.folder, 'q', Q1 + '.json.enc'), copyOf);
  const later = () => Date.now() + 2 * 3600 * 1000;
  assert.deepEqual(await lab.drain({ now: later }), { sent: 0, refused: 0, interrupted: 0, expired: 0 });
  assert.equal(lab.herdr.calls.length, 0);
  assert.equal((await lab.receipt(Q1)).code, 'handled');
  assert.deepEqual(lab.queued(), []);
  // The record is kept until the request could no longer be fresh, not just for two days.
  const until = JSON.parse(fs.readFileSync(lab.ledger(), 'utf8'))[Q1];
  assert.ok(until >= Date.now() + 3600 * 1000 + TTL_MS, 'at least until its own time plus 12 hours');
});

test('deleting a receipt does not make a copied request run again: the laptop keeps the ids it handled', async (t) => {
  const lab = await copy({ sealed: true });
  t.after(lab.cleanup);
  const sealedRequest = { session_id: A, text: 'once only' };
  await lab.queue(Q1, sealedRequest);
  const copyOf = fs.readFileSync(path.join(lab.folder, 'q', Q1 + '.json.enc'));
  assert.equal((await lab.drain()).sent, 1);
  // Someone with write access to the bucket removes the receipt and puts the same sealed bytes back.
  fs.unlinkSync(path.join(lab.folder, 'r', Q1 + '.json.enc'));
  fs.writeFileSync(path.join(lab.folder, 'q', Q1 + '.json.enc'), copyOf);
  assert.deepEqual(await lab.drain(), { sent: 0, refused: 0, interrupted: 0, expired: 0 });
  assert.equal(lab.herdr.prompts().length, 1);
  assert.deepEqual(lab.queued(), [], 'the copy is dropped');
  assert.equal((await lab.receipt(Q1)).code, 'handled', 'and the page is told');
  assert.ok(fs.existsSync(lab.ledger()), 'the record is in the state folder');
  assert.deepEqual(fs.readdirSync(lab.base).sort(), ['bucket', 'state'], 'not in the bucket, and not beside it');
  assert.equal(fs.readdirSync(lab.folder).some((name) => name.startsWith('.drain-handled')), false);
});

test('sealed: a plaintext request in a sealed bucket is never read, nor a sealed one in a plain copy', async (t) => {
  const lab = await copy({ sealed: true });
  t.after(lab.cleanup);
  fs.mkdirSync(path.join(lab.folder, 'q'), { recursive: true });
  fs.writeFileSync(path.join(lab.folder, 'q', Q1 + '.json'), JSON.stringify({ id: Q1, session_id: A, text: 'planted', at: 1 }));
  assert.deepEqual(await lab.drain(), { sent: 0, refused: 0, interrupted: 0, expired: 0 });
  assert.equal(lab.herdr.calls.length, 0);
  const plain = await copy();
  t.after(plain.cleanup);
  fs.mkdirSync(path.join(plain.folder, 'q'), { recursive: true });
  fs.writeFileSync(path.join(plain.folder, 'q', Q1 + '.json.enc'), Buffer.from('HRC1' + 'x'.repeat(40)));
  assert.deepEqual(await plain.drain(), { sent: 0, refused: 0, interrupted: 0, expired: 0 });
});

test('sealed: a request sealed under another key, or for another path, is refused as unreadable', async (t) => {
  const lab = await copy({ sealed: true });
  t.after(lab.cleanup);
  const other = (await seal.newParams('another passphrase')).key;
  fs.mkdirSync(path.join(lab.folder, 'q'));
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ id: Q1, session_id: A, text: 'forged', at: Date.now() / 1000 })));
  fs.writeFileSync(path.join(lab.folder, 'q', Q1 + '.json.enc'), await seal.close(other, `q/${Q1}.json`, body));
  fs.writeFileSync(path.join(lab.folder, 'q', Q2 + '.json.enc'), await seal.close(lab.key, `q/${Q1}.json`, body));  // Q1's bytes under Q2's name
  const result = await lab.drain();
  assert.equal(result.refused, 2);
  assert.equal((await lab.receipt(Q1)).code, 'invalid');
  assert.equal((await lab.receipt(Q2)).code, 'invalid');
  assert.equal(lab.herdr.calls.length, 0);
});

test('sealed: neither the text nor the receipt is readable on disk, and the wrong passphrase leaves the queue alone', async (t) => {
  const lab = await copy({ sealed: true });
  t.after(lab.cleanup);
  await lab.queue(Q1, { session_id: A, text: 'a very private message' });
  assert.deepEqual(await lab.drain({ passphrase: 'not it' }), { sent: 0, refused: 0, interrupted: 0, expired: 0, error: 'wrong-passphrase' });
  assert.equal(lab.herdr.calls.length, 0);
  assert.deepEqual(lab.queued(), [Q1 + '.json.enc']);
  await assert.rejects(lab.drain({ passphrase: '' }), /HOSTED_READER_PASSPHRASE/);
  await lab.drain();
  for (const file of [path.join(lab.folder, 'r', Q1 + '.json.enc')]) {
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.includes('private'), false);
    assert.equal(bytes.includes('sent'), false);
  }
});

test('a drain killed mid-send leaves a lock that the next one takes over at once; a lock of a live drain holds', async (t) => {
  const lab = await copy();
  t.after(lab.cleanup);
  await lab.queue(Q1, { session_id: A, text: 'hello' });
  const lock = path.join(lab.folder, 'q', '.drain.lock');
  // The pid of a process that has ended (a child that exited).
  const dead = require('child_process').spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(lock, String(process.pid));
  assert.equal((await lab.drain()).error, 'busy', 'this very process is alive');
  fs.writeFileSync(lock, String(dead));
  assert.equal((await lab.drain()).sent, 1, 'its owner is gone, so no ten minutes of waiting');
  assert.equal(fs.existsSync(lock), false);
  // A pid that was reused by another process is still stale after ten minutes.
  await lab.queue(Q2, { session_id: A, text: 'again' });
  fs.writeFileSync(lock, String(process.pid));
  const old = new Date(Date.now() - 11 * 60000);
  fs.utimesSync(lock, old, old);
  assert.equal((await lab.drain()).sent, 1);
});

test('the ledger is kept apart by folder, outside it and its neighbours, and a wipe of the folder does not clear it', async (t) => {
  const one = await copy({ sealed: true });
  const two = await copy({ sealed: true });  // another folder, also called bucket, in a parent of its own
  t.after(() => { one.cleanup(); two.cleanup(); });
  assert.notEqual(one.ledger(), two.ledger());
  await one.queue(Q1, { session_id: A, text: 'one' });
  await one.drain();
  assert.ok(fs.existsSync(one.ledger()));
  assert.equal(fs.existsSync(two.ledger()), false);
  fs.rmSync(path.join(one.folder, 'r'), { recursive: true, force: true });
  assert.ok(fs.existsSync(one.ledger()), 'what the folder holds can go; the record stays');
});

test('a second drain on the same folder stops while the first runs, and takes over a lock left over 10 minutes', async (t) => {
  const lab = await copy();
  t.after(lab.cleanup);
  await lab.queue(Q1, { session_id: A, text: 'hello' });
  const lock = path.join(lab.folder, 'q', '.drain.lock');
  fs.writeFileSync(lock, '');
  assert.equal((await lab.drain()).error, 'busy');
  assert.equal(lab.herdr.calls.length, 0);
  const old = new Date(Date.now() - 11 * 60000);
  fs.utimesSync(lock, old, old);
  assert.equal((await lab.drain()).sent, 1);
  assert.equal(fs.existsSync(lock), false, 'the lock goes with the run');
});

test('the Herdr commands a drain runs do not inherit the passphrase', async (t) => {
  const lab = await copy({ sealed: true });
  t.after(lab.cleanup);
  const seen = [];
  const before = process.env.HOSTED_READER_PASSPHRASE;
  process.env.HOSTED_READER_PASSPHRASE = PASS;
  t.after(() => { if (before === undefined) delete process.env.HOSTED_READER_PASSPHRASE; else process.env.HOSTED_READER_PASSPHRASE = before; });
  await lab.queue(Q1, { session_id: A, text: 'hello' });
  await lab.drain({ runner: async (file, args, options) => { seen.push(options.env); return lab.herdr.runner(file, args, options); } });
  assert.ok(seen.length > 3);
  for (const env of seen) assert.equal(Object.keys(env).some((name) => name.includes('PASSPHRASE')), false);
  assert.equal((await lab.receipt(Q1)).state, 'sent');
});

test('the files a drain writes are the owner\'s alone', async (t) => {
  const lab = await copy({ sealed: true });
  t.after(lab.cleanup);
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));
  await lab.queue(Q1, { session_id: A, text: 'hello' });
  await lab.drain();
  const mode = (file) => fs.statSync(file).mode & 0o777;
  assert.equal(mode(path.join(lab.folder, 'r')), 0o700);
  assert.equal(mode(path.join(lab.folder, 'r', Q1 + '.json.enc')), 0o600);
});
