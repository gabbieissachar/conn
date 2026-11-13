#!/usr/bin/env node
'use strict';

// A fake Herdr for the phone end-to-end run (phone-e2e.js): one Herdr session "work" with one idle Claude pane running
// the conversation named in FAKE_HERDR_SESSION. It answers only what the reader and the sync's drain ask, and writes every
// agent prompt it is given to FAKE_HERDR_LOG, so a run can show what would have been typed into a pane. It reaches nothing.

const fs = require('fs');

const session = process.env.FAKE_HERDR_SESSION || '';
const log = process.env.FAKE_HERDR_LOG || '';
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const note = (line) => { if (log) fs.appendFileSync(log, line + '\n'); };

const pane = { pane_id: 'w1:p1', tab_id: 'w1:t1', label: 'alpha', agent: 'claude', agent_status: 'idle', agent_session: { value: session }, terminal_title_stripped: 'Alpha work' };
const rest = args[0] === '--session' ? args.slice(2) : args;

if (args[0] === 'session' && args[1] === 'list') out({ sessions: [{ name: 'work', default: false, running: true }] });
else if (rest[0] === 'pane' && rest[1] === 'list') out({ result: { panes: [pane] } });
else if (rest[0] === 'tab' && rest[1] === 'list') out({ result: { tabs: [{ tab_id: 'w1:t1', label: 'alpha' }] } });
else if (rest[0] === 'api' && rest[1] === 'snapshot') out({ result: { snapshot: { focused_pane_id: 'w1:p1', tabs: [{ tab_id: 'w1:t1', label: 'alpha' }], panes: [pane] } } });
else if (rest[0] === 'pane' && rest[1] === 'process-info') out({ result: { process_info: { foreground_processes: [{ pid: 1001, argv0: 'claude' }] } } });
else if (rest[0] === 'agent' && rest[1] === 'prompt') { note('PROMPT ' + rest.slice(2).join(' ')); out({}); }
else if (rest[0] === 'agent' && rest[1] === 'send-keys') out({});
else { process.stderr.write('fake herdr: unexpected ' + args.join(' ') + '\n'); process.exit(1); }
