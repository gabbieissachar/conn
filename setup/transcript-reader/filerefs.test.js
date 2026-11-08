'use strict';

// Tests for how the reader page finds a markdown file named by its absolute path in a reply (prototype/filerefs.js). Run from the repo root:
//   node --test setup/transcript-reader/filerefs.test.js
// The functions run alone in a bare sandbox; the page's own use of them (links in a reply, the Documents button) is in lite.test.js and, in a browser,
// e2e/file-ref-check.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const refs = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'prototype', 'filerefs.js'), 'utf8') + '\nfileRefs', { String, RegExp, encodeURIComponent });
const paths = (text) => Array.from(refs.scan(text), (f) => text.slice(f.start, f.end));

test('an absolute path to a markdown file in prose is found, where it is, and nothing around it', () => {
  const text = 'The plan is at /Users/me/work/plan.md and the notes are in /tmp/notes-2.md, (see /var/x/y.md). Done.';
  assert.deepEqual(paths(text), ['/Users/me/work/plan.md', '/tmp/notes-2.md', '/var/x/y.md']);
  assert.deepEqual(Array.from(refs.scan(text), (f) => f.path), paths(text));
  assert.equal(paths('/Users/me/plan.md')[0], '/Users/me/plan.md', 'at the start of the text');
  assert.equal(paths('Open `/a/b.md` now').length, 1, 'a path next to a backtick (the text of a code span is scanned alone, but prose may hold one)');
  assert.deepEqual(paths('/a/b.md:12 and /a/c.md#top'), ['/a/b.md', '/a/c.md'], 'a line number or an anchor is not part of the file');
  assert.deepEqual(paths('Folders with dots: /Users/me/.claude/projects/-Users-me-x/notes.v2.md'), ['/Users/me/.claude/projects/-Users-me-x/notes.v2.md']);
});

test('what is not one file is left alone: a web address, a relative or home path, a longer name, a path with ".." in it', () => {
  for (const text of [
    'See https://example.com/docs/readme.md for it',
    'file:///Users/me/readme.md',
    'docs/readme.md and ./notes.md and ../up.md',
    '~/notes/plan.md',
    'the file /Users/me/plan.md.bak and /Users/me/plan.mdx',
    '/Users/me/../other/plan.md',
    '/Users/me/./plan.md',
    'two slashes //Users/me/plan.md',
    'plan.md alone',
    'a/b/c.md',
    'a command: cat /etc/x.txt',
  ]) assert.deepEqual(paths(text), [], text);
});

test('a code span is a path only when all of it is: a command that holds one stays a command', () => {
  assert.equal(refs.whole('/Users/me/work/plan.md'), '/Users/me/work/plan.md');
  assert.equal(refs.whole('/Users/me/My Notes/plan.md'), '/Users/me/My Notes/plan.md', 'a folder with a space is fine inside a code span, where the span says where the path ends');
  for (const text of ['cat /Users/me/plan.md', 'plan.md', '~/plan.md', 'docs/plan.md', '/Users/me/plan.txt', '/Users/me/../plan.md', '/a//b.md', '']) assert.equal(refs.whole(text), null, JSON.stringify(text));
});

test('the editor address of a file: vscode://file/ and the path, each segment encoded', () => {
  assert.equal(refs.vscodeUrl('/Users/me/work/plan.md'), 'vscode://file/Users/me/work/plan.md');
  assert.equal(refs.vscodeUrl('/Users/me/My Notes/a#b.md'), 'vscode://file/Users/me/My%20Notes/a%23b.md');
});

// ---------------------------------------------------------------------------------------------------- the page's use of them (2026-11-08)

const PAGE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');
const README = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');

test('the page links paths in replies before it links sessions, never on the embed page, and gives the Documents view\'s markdown file a button.file-ref', () => {
  assert.ok(PAGE.includes('/*__FILEREFS__*/'), 'the module is pasted in the reader page\'s script');
  const reply = PAGE.slice(PAGE.indexOf('const md = renderMarkdown(ex.reply,'), PAGE.indexOf('if (sid && ex.uid) md.dataset.find'));
  assert.ok(reply.indexOf('linkFilePaths(md, sid)') > 0 && reply.indexOf('linkFilePaths(md, sid)') < reply.indexOf('linkSessionRefs(md, sid)'), 'files, then sessions');
  assert.ok(PAGE.includes('function linkFilePaths(box, sid) {\n    if (EMBED) return box;'), 'the embed page links nothing');
  assert.ok(PAGE.includes('const a = $("a", "file-ref");\n    a.dataset.path = path;'), 'an a.file-ref carrying data-path');
  assert.ok(PAGE.includes('$("button", "btn file-ref", "Open in editor")') && PAGE.includes('edit.dataset.path = d.path;'), 'and the button');
  assert.ok(PAGE.includes('framed0(d) || !d.path || !canLive ? null'), 'a page or a picture, a file with no path and a copy with no files of its own have none');
  assert.ok(PAGE.includes('setTimeout(() => { if (!event.defaultPrevented) location.href = fileRefs.vscodeUrl(path); }, 0);'), 'a host\'s preventDefault stands');
  assert.ok(PAGE.includes('if (!doc && !canLive) return null;'), 'the hosted copy links the documents it holds and no other path');
});

test('the README gives a host the contract: the two elements, the attribute, the selector and what a plain browser does', () => {
  const section = README.slice(README.indexOf('## Markdown files open in an editor'), README.indexOf('## The hosted copy'));
  for (const word of ['a.file-ref', 'button', '.file-ref[data-path]', 'data-path', 'preventDefault', 'vscode://file/', 'Documents view', 'e2e/file-ref-check.js']) assert.ok(section.includes(word), word);
});
