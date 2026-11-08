#!/usr/bin/env node
'use strict';

// A fake Herdr whose world is a JSON file (FAKE_HERDR_WORLD), read again on every call, so a lab can change the panes while the reader
// runs (a /clear, a pane closing, a Claude that starts under another config folder). It answers only what the reader asks
// (`session list`, `api snapshot`, `pane list`, `tab list`, `pane process-info`) and writes every `agent send-keys` and `agent prompt` to
// FAKE_HERDR_LOG, so a run can show what would have been typed into a pane. It reaches nothing real.
//
//   { "sessions": [ { "name": "esim", "focused": "w1:p1", "socket": "<unix socket path of fake-herdr-socket.js, optional: session list then names it as Herdr's socket_path>",
//       "tabs": [ { "tab_id": "w1:t1", "label": "alpha" } ],
//       "panes": [ { "pane_id": "w1:p1", "tab_id": "w1:t1", "label": null, "agent": "claude", "agent_status": "idle",
//                    "agent_session": "<id or null: Herdr's own idea of the session>", "title": "Alpha work",
//                    "process": [ { "pid": 1001, "argv0": "claude", "cwd": "/work" } ] } ] } ] }

const fs = require('fs');
const path = require('path');

const world = JSON.parse(fs.readFileSync(process.env.FAKE_HERDR_WORLD, 'utf8'));
const log = process.env.FAKE_HERDR_LOG || '';
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const note = (line) => { if (log) fs.appendFileSync(log, line + '\n'); };

// <FAKE_HERDR_DIR>/control.json, read on every call: { "delay_ms": n } makes each `agent send-keys` (the first step of a send, which empties the pane's
// input box, in 25 calls) take n ms, as a real pane does; { "fail_prompt": true } makes `agent prompt` fail.
const control = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.env.FAKE_HERDR_DIR || '', 'control.json'), 'utf8')); } catch (e) { return {}; } })();
const wait = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const rest = args[0] === '--session' ? args.slice(2) : args;
const named = args[0] === '--session' ? args[1] : null;
const session = (world.sessions || []).find((entry) => entry.name === named) || null;

const paneOf = (pane) => {
  const shown = { pane_id: pane.pane_id, tab_id: pane.tab_id, label: pane.label || undefined, terminal_title_stripped: pane.title || undefined, cwd: pane.cwd || undefined };
  if (pane.agent) { shown.agent = pane.agent; shown.agent_status = pane.agent_status || 'idle'; } else shown.agent_status = 'unknown';
  if (pane.agent_session) shown.agent_session = { agent: pane.agent, kind: 'id', source: 'herdr:' + pane.agent, value: pane.agent_session };
  return shown;
};

if (args[0] === 'session' && args[1] === 'list') {
  out({ sessions: (world.sessions || []).map((entry) => ({ name: entry.name, default: false, running: entry.running !== false, session_dir: process.env.FAKE_HERDR_DIR || '', ...(entry.socket ? { socket_path: entry.socket } : {}) })) });
} else if (!session) {
  process.stderr.write('fake herdr: unknown session ' + args.join(' ') + '\n'); process.exit(1);
} else if (rest[0] === 'pane' && rest[1] === 'list') out({ result: { panes: session.panes.map(paneOf) } });
else if (rest[0] === 'tab' && rest[1] === 'list') out({ result: { tabs: session.tabs } });
else if (rest[0] === 'api' && rest[1] === 'snapshot') out({ result: { snapshot: { focused_pane_id: session.focused, tabs: session.tabs, panes: session.panes.map(paneOf) } } });
else if (rest[0] === 'pane' && rest[1] === 'process-info') {
  const pane = session.panes.find((entry) => entry.pane_id === rest[rest.indexOf('--pane') + 1]);
  if (!pane) { process.stderr.write('fake herdr: no such pane\n'); process.exit(1); }
  out({ result: { process_info: { cwd: pane.cwd, foreground_processes: pane.process || [] } } });
} else if (rest[0] === 'agent' && rest[1] === 'prompt' && control.fail_prompt) { note(`PROMPT-REFUSED ${named} ${rest[2]}`); process.stderr.write('fake herdr: the pane refused the prompt\n'); process.exit(1); }
else if (rest[0] === 'agent' && rest[1] === 'prompt') { note(`PROMPT ${named} ${rest[2]} ${rest.slice(3).join(' ')}`); out({}); }
else if (rest[0] === 'agent' && rest[1] === 'send-keys') { wait(control.delay_ms); note(`KEYS ${named} ${rest[2]} ${rest.slice(3).join(' ')}`); out({}); }
else { process.stderr.write('fake herdr: unexpected ' + args.join(' ') + '\n'); process.exit(1); }
