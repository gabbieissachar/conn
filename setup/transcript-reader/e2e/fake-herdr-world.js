#!/usr/bin/env node
'use strict';

// A fake Herdr whose world is a JSON file (FAKE_HERDR_WORLD), read again on every call, so a lab can change the panes while the reader
// runs (a /clear, a pane closing, a Claude that starts under another config folder). It answers only what the reader asks
// (`session list`, `api snapshot`, `pane list`, `tab list`, `pane process-info`) and writes every `agent send-keys` and `agent prompt` to
// FAKE_HERDR_LOG, so a run can show what would have been typed into a pane. It reaches nothing real.
//
//   { "sessions": [ { "name": "esim", "focused": "w1:p1",
//       "tabs": [ { "tab_id": "w1:t1", "label": "alpha" } ],
//       "panes": [ { "pane_id": "w1:p1", "tab_id": "w1:t1", "label": null, "agent": "claude", "agent_status": "idle",
//                    "agent_session": "<id or null: Herdr's own idea of the session>", "title": "Alpha work",
//                    "process": [ { "pid": 1001, "argv0": "claude", "cwd": "/work" } ] } ] } ] }

const fs = require('fs');

const world = JSON.parse(fs.readFileSync(process.env.FAKE_HERDR_WORLD, 'utf8'));
const log = process.env.FAKE_HERDR_LOG || '';
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const note = (line) => { if (log) fs.appendFileSync(log, line + '\n'); };

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
  out({ sessions: (world.sessions || []).map((entry) => ({ name: entry.name, default: false, running: true, session_dir: process.env.FAKE_HERDR_DIR || '' })) });
} else if (!session) {
  process.stderr.write('fake herdr: unknown session ' + args.join(' ') + '\n'); process.exit(1);
} else if (rest[0] === 'pane' && rest[1] === 'list') out({ result: { panes: session.panes.map(paneOf) } });
else if (rest[0] === 'tab' && rest[1] === 'list') out({ result: { tabs: session.tabs } });
else if (rest[0] === 'api' && rest[1] === 'snapshot') out({ result: { snapshot: { focused_pane_id: session.focused, tabs: session.tabs, panes: session.panes.map(paneOf) } } });
else if (rest[0] === 'pane' && rest[1] === 'process-info') {
  const pane = session.panes.find((entry) => entry.pane_id === rest[rest.indexOf('--pane') + 1]);
  if (!pane) { process.stderr.write('fake herdr: no such pane\n'); process.exit(1); }
  out({ result: { process_info: { cwd: pane.cwd, foreground_processes: pane.process || [] } } });
} else if (rest[0] === 'agent' && rest[1] === 'prompt') { note(`PROMPT ${named} ${rest[2]} ${rest.slice(3).join(' ')}`); out({}); }
else if (rest[0] === 'agent' && rest[1] === 'send-keys') { note(`KEYS ${named} ${rest[2]} ${rest.slice(3).join(' ')}`); out({}); }
else { process.stderr.write('fake herdr: unexpected ' + args.join(' ') + '\n'); process.exit(1); }
