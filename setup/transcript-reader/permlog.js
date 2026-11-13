'use strict';

// Whether the tool call a permission ask is about has an answer in the session log yet (permissions.js asks this when it checks an ask is still the one
// on screen). Claude Code writes the assistant's tool_use to the session log before it asks permission, and the tool_result when the call ends
// (run, or refused: "The user doesn't want to proceed with this tool use"). The permission hook's own input has no tool_use id, so the call is found by
// its tool name and exact input, newest first.
//
//   'done'     the newest tool_use with this name and input has its tool_result: the ask was answered somewhere (the pane) and is over
//   'pending'  that tool_use has no result yet: still waiting (or running)
//   'unknown'  the tail of the log has no such tool_use (not written yet, or beyond the part read): nothing is concluded
//
// Only the end of the log is read (TAIL_BYTES), and only when the log changed since the last look (path, size and modified time), so a check every
// couple of seconds costs one stat while nothing is written. Read-only: the log is never opened for writing.

const fs = require('fs');

const TAIL_BYTES = 768 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}

// The tool_use blocks of the log's tail, in order: { id, name, input }, and the set of tool_use ids that have a tool_result.
function readTail(file) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    text = buffer.toString('utf8');
  } finally { fs.closeSync(fd); }
  // A tail that starts inside a line leaves that line out.
  const lines = text.split('\n');
  if (stat.size > length) lines.shift();
  const uses = [];
  const results = new Set();
  for (const line of lines) {
    if (!line.includes('tool_use') && !line.includes('tool_result')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const content = record && record.message && record.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') uses.push({ id: block.id, name: block.name, input: block.input });
      else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') results.add(block.tool_use_id);
    }
  }
  return { uses, results, key: `${file}|${stat.size}|${stat.mtimeMs}` };
}

function create() {
  const tails = new Map();  // file -> { key, uses, results } of the last read; a handful of logs at most
  return {
    // file: the session's log path (or null); tool and input as the hook gave them.
    state(file, tool, input) {
      if (!file) return 'unknown';
      let tail;
      try {
        const stat = fs.statSync(file);
        const key = `${file}|${stat.size}|${stat.mtimeMs}`;
        tail = tails.get(file);
        if (!tail || tail.key !== key) {
          tail = readTail(file);
          tails.delete(file);
          tails.set(file, tail);
          if (tails.size > 8) tails.delete(tails.keys().next().value);
        }
      } catch { return 'unknown'; }
      const wanted = canonical(input);
      for (let i = tail.uses.length - 1; i >= 0; i--) {
        const use = tail.uses[i];
        if (use.name === tool && canonical(use.input) === wanted) return tail.results.has(use.id) ? 'done' : 'pending';
      }
      return 'unknown';
    },
  };
}

module.exports = { create, canonical, TAIL_BYTES };
