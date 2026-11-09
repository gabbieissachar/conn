'use strict';

// Tests for the settings serve.sh keeps between starts (out/serve-settings-<port>.conf): a plain restart, by anyone,
// brings the reader back with the same switches; an explicit off turns one off; --fresh ignores the kept file.
// Run from the repo root: node --test setup/transcript-reader/servesettings.test.js
// Each test starts a real reader server (serve.sh start) on a free port with a temporary settings file and stops it
// at the end. Only switches that do nothing at start are used (never PMOS_READER_BOARD, which reads a Firstmate home),
// and the Tailscale address is requested only where it is not served (the kept request is what is checked).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SERVE = path.join(__dirname, 'serve.sh');
const REPO = path.resolve(__dirname, '..', '..');
const HAVE_TOOLS = process.platform === 'darwin' && ['lsof', 'curl', 'ps'].every((t) => spawnSync('which', [t]).status === 0);
const skip = HAVE_TOOLS ? false : 'needs macOS with lsof, curl and ps';

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// A lab: a port, a settings file, and a runner for serve.sh with a clean PMOS_READER_* environment.
async function lab(t) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-serve-settings-'));
  const file = path.join(dir, 'kept.conf');
  const run = (args, env = {}) => {
    const clean = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PMOS_READER_')) clean[k] = v;
    const r = spawnSync('bash', [SERVE, ...args, '--port', String(port)], { env: { ...clean, PMOS_READER_SETTINGS_FILE: file, ...env }, encoding: 'utf8', timeout: 60000 });
    return { out: r.stdout + r.stderr, code: r.status };
  };
  t.after(() => { run(['stop']); });
  const kept = () => Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { port, dir, file, run, kept };
}

const onLine = (status) => (status.match(/Switches on in the running reader: (.*)\./) || [])[1];

test('a start keeps its switches, a plain restart brings them back, status shows them', { skip }, async (t) => {
  const L = await lab(t);
  const first = L.run(['start'], { PMOS_READER_BOARD_SEND: '1', PMOS_READER_BOARD_REVIEW: 'on', PMOS_READER_FLEET_TIMELINE: '1' });
  assert.match(first.out, /Reader server started/);
  assert.equal(L.kept().PMOS_READER_BOARD_SEND, '1');
  assert.equal(L.kept().PMOS_READER_BOARD_REVIEW, '1', 'on is kept as 1');
  assert.equal(L.kept().PMOS_READER_BOARD_MARKS, '0');
  assert.equal(fs.statSync(L.file).mode & 0o777, 0o600, 'the kept file is the owner\'s alone');
  assert.equal(onLine(L.run(['status']).out), 'BOARD_SEND BOARD_REVIEW FLEET_TIMELINE');
  // restart with no flags and none of the variables: the same switches come back
  const again = L.run(['restart']);
  assert.match(again.out, /Reader server started/);
  const status = L.run(['status']).out;
  assert.equal(onLine(status), 'BOARD_SEND BOARD_REVIEW FLEET_TIMELINE');
  assert.match(status, /Kept for the next start or restart: BOARD_SEND BOARD_REVIEW FLEET_TIMELINE/);
  assert.doesNotMatch(status, /differ/);
});

test('an explicit off turns one switch off and leaves the others', { skip }, async (t) => {
  const L = await lab(t);
  L.run(['start'], { PMOS_READER_BOARD_SEND: '1', PMOS_READER_BOARD_MARKS: '1' });
  L.run(['restart'], { PMOS_READER_BOARD_SEND: '0' });
  assert.equal(onLine(L.run(['status']).out), 'BOARD_MARKS');
  assert.equal(L.kept().PMOS_READER_BOARD_SEND, '0', 'the off is kept too');
  L.run(['restart']);
  assert.equal(onLine(L.run(['status']).out), 'BOARD_MARKS', 'and stays off on the next plain restart');
});

test('--fresh ignores the kept file for one start, and that start is then what is kept', { skip }, async (t) => {
  const L = await lab(t);
  L.run(['start'], { PMOS_READER_BOARD_SEND: '1' });
  L.run(['restart', '--fresh'], { PMOS_READER_BOARD_MARKS: '1' });
  assert.equal(onLine(L.run(['status']).out), 'BOARD_MARKS');
  assert.equal(L.kept().PMOS_READER_BOARD_SEND, '0');
});

test('the tailnet request is kept, and --no-tailnet turns it off', { skip }, async (t) => {
  const L = await lab(t);
  // No passcode file in this lab: the address is not served, but the request is what restarts must remember.
  const noPass = path.join(L.dir, 'no-passcode.json');
  L.run(['start', '--tailnet-https', '--https-port', '48443'], { PMOS_READER_PASSCODE_FILE: noPass });
  assert.equal(L.kept().PMOS_READER_TAILNET, '1');
  assert.equal(L.kept().PMOS_READER_TAILNET_HTTPS, '1');
  assert.equal(L.kept().PMOS_READER_HTTPS_PORT, '48443');
  L.run(['restart'], { PMOS_READER_PASSCODE_FILE: noPass });
  assert.equal(L.kept().PMOS_READER_TAILNET_HTTPS, '1', 'a plain restart keeps it');
  assert.equal(L.kept().PMOS_READER_HTTPS_PORT, '48443');
  L.run(['restart', '--no-tailnet-https'], { PMOS_READER_PASSCODE_FILE: noPass });
  assert.equal(L.kept().PMOS_READER_TAILNET, '1');
  assert.equal(L.kept().PMOS_READER_TAILNET_HTTPS, '0');
  L.run(['restart', '--no-tailnet'], { PMOS_READER_PASSCODE_FILE: noPass });
  assert.equal(L.kept().PMOS_READER_TAILNET, '0');
  assert.equal(L.kept().PMOS_READER_TAILNET_HTTPS, '0');
});

test('the store recorder path is kept, off by the word off, and dropped with a note when the file is gone', { skip }, async (t) => {
  const L = await lab(t);
  const recorder = path.join(L.dir, 'recorder.py');
  fs.writeFileSync(recorder, '# a stand-in\n');
  L.run(['start'], { PMOS_READER_STORE_RECORDER: recorder });
  assert.equal(L.kept().PMOS_READER_STORE_RECORDER, recorder);
  L.run(['restart']);
  assert.equal(onLine(L.run(['status']).out), 'STORE_RECORDER');
  L.run(['restart'], { PMOS_READER_STORE_RECORDER: 'off' });
  assert.equal(L.kept().PMOS_READER_STORE_RECORDER, '');
  L.run(['restart'], { PMOS_READER_STORE_RECORDER: recorder });
  fs.renameSync(recorder, recorder + '.gone');
  const gone = L.run(['restart']);
  assert.match(gone.out, /kept store recorder .* no longer exists/);
  assert.equal(L.kept().PMOS_READER_STORE_RECORDER, '');
});

test('the first restart of a reader started by hand takes over its switches', { skip }, async (t) => {
  const L = await lab(t);
  // As Nathan's live reader was: started with node and the switches in its environment, no kept file.
  const clean = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PMOS_READER_')) clean[k] = v;
  const child = spawn('node', [path.join(__dirname, 'server.js'), '--port', String(L.port), '--root', REPO], { env: { ...clean, PMOS_READER_BOARD_MARKS: '1', PMOS_READER_BOARD_REVIEW: '1' }, stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 40 && !/serves this copy/.test(L.run(['status']).out); i++) await new Promise((r) => setTimeout(r, 250));
  const before = L.run(['status']);
  assert.equal(onLine(before.out), 'BOARD_MARKS BOARD_REVIEW');
  assert.match(before.out, /Nothing kept yet/);
  const restart = L.run(['restart']);
  assert.match(restart.out, /Kept the running reader's settings/);
  assert.equal(onLine(L.run(['status']).out), 'BOARD_MARKS BOARD_REVIEW', 'the restart did not drop them');
  assert.equal(L.kept().PMOS_READER_BOARD_MARKS, '1');
});

test('status says when the running reader differs from the kept settings', { skip }, async (t) => {
  const L = await lab(t);
  L.run(['start'], { PMOS_READER_BOARD_SEND: '1' });
  fs.writeFileSync(L.file, fs.readFileSync(L.file, 'utf8').replace('PMOS_READER_BOARD_MARKS=0', 'PMOS_READER_BOARD_MARKS=1'));
  assert.match(L.run(['status']).out, /differ from the kept ones; restart to apply/);
});

test('a file with unknown keys or odd lines is read safely (nothing is evaluated)', { skip }, async (t) => {
  const L = await lab(t);
  const marker = path.join(L.dir, 'evaluated');
  fs.writeFileSync(L.file, `# comment\nEVIL=$(touch ${marker})\nPMOS_READER_BOARD_SEND=$(touch ${marker})\nnot a setting\nPMOS_READER_BOARD_MARKS=1\n`);
  const r = L.run(['start']);
  assert.match(r.out, /Reader server started/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(onLine(L.run(['status']).out), 'BOARD_MARKS');
});
