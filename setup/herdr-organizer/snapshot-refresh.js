'use strict';

// The organizer page's "Refresh snapshot" button, when no session is picked, posts to
// /api/herdr-workspace-organizer/snapshot. The route takes no input: it runs one fixed command,
// `workspace-organizer.py snapshot`, which reads Herdr and rewrites the live snapshot file.
// organizer-serve.sh (loopback) and phone.js (the Tailscale listener, behind its guard and passcode) both
// answer it with this, so the command lives in one place.

const { spawn: nodeSpawn } = require('child_process');

const SCRIPT = 'setup/herdr/workspace-organizer.py';

// Resolves to { status, body }: 200 with the tool's output, or 500 with why it failed. Never rejects.
function refreshSnapshot(root, { spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (status, body) => { if (!settled) { settled = true; resolve({ status, body }); } };
    let proc;
    try { proc = spawn('python3', [SCRIPT, 'snapshot'], { cwd: root }); } catch (error) { done(500, { status: 'error', message: error.message }); return; }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === 0) done(200, { status: 'ok', output: stdout.trim() });
      else done(500, { status: 'error', code, message: stderr.trim() || stdout.trim() || 'Snapshot refresh failed' });
    });
    proc.on('error', (error) => done(500, { status: 'error', message: error.message }));
  });
}

module.exports = { refreshSnapshot, SCRIPT };
