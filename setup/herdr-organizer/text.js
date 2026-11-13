'use strict';

// Shared leak patterns. Used twice: to scrub any tool message before it reaches
// the browser, and as the second-layer scan that refuses to produce a share
// report that still contains something private.

const PATTERNS = [
  ['session-id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  ['bundle-id', /recovery-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{10}/g, '[bundle]'],
  ['private-path', /(?:\/Users|\/home|\/private|\/var\/folders|\/tmp|\/Volumes)\/[^\s'"`,;)]*|~\/\.[^\s'"`,;)]*/g, '[path]'],
  ['socket-path', /[\w.\/-]*\.sock\b/g, '[socket]'],
  ['resume-command', /\b(?:claude|codex)(?:-r)?\s+(?:--resume|resume|-r)\b[^\n]*|--resume(?:=|\s+)\S+|\bcodex-r\b|\bclaude-r\b/gi, '[resume]'],
];

function findLeaks(text) {
  const value = String(text == null ? '' : text);
  const kinds = [];
  for (const [kind, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) kinds.push(kind);
    pattern.lastIndex = 0;
  }
  return kinds;
}

// Make a tool message safe to show: replace anything private, collapse
// whitespace, and bound the length.
function scrub(text, maxLength = 300) {
  let value = String(text == null ? '' : text);
  for (const [, pattern, replacement] of PATTERNS) {
    pattern.lastIndex = 0;
    value = value.replace(pattern, replacement);
    pattern.lastIndex = 0;
  }
  value = value.replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? value.slice(0, maxLength - 1) + '…' : value;
}

// Python repr() string reader: 'text' or "text" with backslash escapes.
// Returns { value, end } or null when no quoted string starts at pos.
function readQuoted(source, pos) {
  const quote = source[pos];
  if (quote !== "'" && quote !== '"') return null;
  let out = '';
  let i = pos + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      const next = source[i + 1];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      i += 2;
      continue;
    }
    if (ch === quote) return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  return null;
}

module.exports = { findLeaks, scrub, readQuoted };
