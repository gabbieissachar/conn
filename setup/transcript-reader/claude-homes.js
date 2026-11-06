'use strict';

// The Claude config folders on this machine, shared by the transcript reader (api.js) and the Herdr organizer
// (../herdr-organizer/adapter.js) so both look in the same places for a session's log.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The folders Claude Code keeps its sessions in besides ~/.claude: one per CLAUDE_CONFIG_DIR a person runs it under (a second
// account is often ~/.claude-personal or ~/.claude-work). A folder named ~/.claude<anything> counts when it holds a projects/ or
// sessions/ folder, which only a Claude config folder does (a plain file such as ~/.claude.json, or a tool's own ~/.claude-xyz
// folder, has neither); so does the folder CLAUDE_CONFIG_DIR names for this process, and each of PMOS_READER_CLAUDE_HOMES (absolute
// paths separated like PATH) for a place outside the home folder. No folder's name is known here: a new account is found by the
// next look. Read-only; the primary ~/.claude is not in the answer.
function otherClaudeHomes({ homeDir = os.homedir(), env = process.env } = {}) {
  const primary = path.join(homeDir, '.claude');
  const found = [];
  const isDir = (folder) => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } };
  const add = (folder) => {
    if (!path.isAbsolute(folder)) return;
    folder = path.resolve(folder);
    if (folder !== primary && !found.includes(folder) && (isDir(path.join(folder, 'projects')) || isDir(path.join(folder, 'sessions')))) found.push(folder);
  };
  let names = [];
  try { names = fs.readdirSync(homeDir); } catch { /* no home folder to look in */ }
  for (const name of names.filter((entry) => entry.startsWith('.claude')).sort()) add(path.join(homeDir, name));
  if (env && typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR) add(env.CLAUDE_CONFIG_DIR);
  if (env && typeof env.PMOS_READER_CLAUDE_HOMES === 'string') for (const folder of env.PMOS_READER_CLAUDE_HOMES.split(path.delimiter)) if (folder) add(folder);
  return found;
}

// A Claude session id as Claude Code writes it.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// pid -> session id of every running Claude Code process, from the record each keeps in <its config folder>/sessions/<pid>.json
// (it follows /clear and --resume). `dirs` are the sessions/ folders to read; a record whose process has ended is skipped.
function runningClaudeSessions(dirs) {
  const found = new Map();
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      let record = null;
      try { record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }  // a record ends with its process
      record = record || {};
      if (!Number.isInteger(record.pid) || typeof record.sessionId !== 'string' || !SESSION_ID_RE.test(record.sessionId)) continue;
      try { process.kill(record.pid, 0); } catch { continue; }
      found.set(record.pid, record.sessionId);
    }
  }
  return found;
}

module.exports = { otherClaudeHomes, runningClaudeSessions };
