'use strict';

// Tests for how the page draws markdown (prototype/markdown.js over the vendored markdown-it). Run from the repo root:
//   node --test setup/transcript-reader/markdown.test.js
// The two files run in a sandbox, as the page's script would run them. Every text here is synthetic placeholder text.
// The cases are the ones the old hand-written renderer drew wrongly (literal ** and __ around code, a lone *, a line
// break, an escape, a link with brackets in its address, a ~~strike~~, a paragraph inside a list item).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROTOTYPE = path.join(__dirname, 'prototype');
const VENDOR = fs.readFileSync(path.join(PROTOTYPE, 'vendor', 'markdown-it.min.js'), 'utf8');
const GLUE = fs.readFileSync(path.join(PROTOTYPE, 'markdown.js'), 'utf8');

function load() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(VENDOR, sandbox);
  return vm.runInContext(GLUE + '\nmarkdownView;', sandbox);
}
const { render, inline, plain } = load();
const html = (text, opts) => render(text, opts).html;
const reply = (text, ask, reminder) => render(text, { ask, reminder }).html;

// What a reader sees of drawn HTML: the tags gone (a block or a break leaving a space), entities decoded, the Copy label and
// the code label left out, spaces squeezed.
const visible = (markup) => markup
  .replace(/<span class="code-label">.*?<\/span>/g, '').replace(/<button\b.*?<\/button>/g, '')
  .replace(/<\/?(?:p|li|ul|ol|h\d|td|th|tr|table|thead|tbody|div|pre|blockquote)\b[^>]*>|<br>|<hr>/g, ' ')
  .replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

test('the vendored parser and this file can sit inside the page script', () => {
  assert.match(VENDOR, /^\/\*! markdown-it \d+\.\d+\.\d+ /, 'the vendored file names its version');
  for (const [name, source] of [['markdown-it.min.js', VENDOR], ['markdown.js', GLUE]]) {
    assert.ok(!/<\/script/i.test(source), `${name} cannot close the script element it is pasted into`);
    assert.ok(!/sourceMappingURL/.test(source), `${name} points at no source map`);
  }
  assert.ok(!/\beval\b|new Function|\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|document\./.test(GLUE.replace(/\/\/.*$/gm, '')), 'markdown.js reads no page, loads nothing and runs no text as code');
});

test('bold in either marker, beside punctuation', () => {
  assert.equal(html('Plain **bold** and __bold too__.'), '<p>Plain <strong>bold</strong> and <strong>bold too</strong>.</p>\n');
  assert.equal(html('(**in parens**) and **colon:** text'), '<p>(<strong>in parens</strong>) and <strong>colon:</strong> text</p>\n');
  assert.equal(inline('**a** and *b* and ~~c~~'), '<strong>a</strong> and <em>b</em> and <s>c</s>');
});

test('bold that holds code, a link, a lone star or a line break, which showed as literal ** before', () => {
  assert.equal(inline('**`code` in bold**'), '<strong><code>code</code> in bold</strong>');
  assert.equal(inline('**run `npm test` now**'), '<strong>run <code>npm test</code> now</strong>');
  assert.equal(inline('**[the docs](https://example.test/d)**'), '<strong><a href="https://example.test/d" target="_blank" rel="noopener noreferrer">the docs</a></strong>');
  assert.equal(inline('[**the docs**](https://example.test/d)'), '<a href="https://example.test/d" target="_blank" rel="noopener noreferrer"><strong>the docs</strong></a>');
  assert.equal(inline('**a * b is bold**'), '<strong>a * b is bold</strong>');
  assert.equal(html('**bold that spans\ntwo lines** after'), '<p><strong>bold that spans<br>\ntwo lines</strong> after</p>\n');
});

test('bold italic, nested emphasis and strike', () => {
  assert.equal(inline('***both***'), '<em><strong>both</strong></em>');
  assert.equal(inline('**bold with *nested italic* inside**'), '<strong>bold with <em>nested italic</em> inside</strong>');
  assert.equal(inline('~~gone~~ text'), '<s>gone</s> text');
});

test('what is not emphasis stays as written: spaced stars, snake_case, an escape', () => {
  assert.equal(inline('** not bold because of spaces **'), '** not bold because of spaces **');
  assert.equal(inline('snake_case_name and a ** b'), 'snake_case_name and a ** b');
  assert.equal(inline('\\*escaped\\* stars'), '*escaped* stars');
  assert.equal(inline('see `**/*.md` globs'), 'see <code>**/*.md</code> globs');
});

test('a web address links and anything else is plain words with its target on hover', () => {
  const web = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  assert.equal(inline('[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) page'), web('https://en.wikipedia.org/wiki/Foo_(bar)', 'wiki') + ' page');
  assert.equal(inline('visit https://example.test/a?b=1, then go'), 'visit ' + web('https://example.test/a?b=1', 'https://example.test/a?b=1') + ', then go');
  assert.equal(inline('(see https://example.test/a) and https://example.test/b.'), '(see ' + web('https://example.test/a', 'https://example.test/a') + ') and ' + web('https://example.test/b', 'https://example.test/b') + '.', 'trailing punctuation is not part of the address');
  assert.equal(inline('read notes.md or www.example.com'), 'read notes.md or www.example.com', 'a bare file name or host is not a link');
  assert.equal(inline('[notes](./notes/a.md)'), '<span class="local-link" title="./notes/a.md">notes</span>');
  assert.equal(inline('[abs](/Users/me/a.md) and [home](~/x/a.md)'), '<span class="local-link" title="/Users/me/a.md">abs</span> and <span class="local-link" title="~/x/a.md">home</span>');
  assert.equal(inline('[file](file:///tmp/a.md)'), '<span class="local-link" title="file:///tmp/a.md">file</span>');
  assert.equal(inline('![a picture](https://example.test/p.png)'), web('https://example.test/p.png', 'a picture'), 'an image is never fetched, only linked');
});

const ATTRIBUTES = ['href', 'target', 'rel', 'class', 'title', 'id', 'start', 'style', 'type', 'data-label', 'aria-label'];
const ALLOWED = ['p', 'a', 'span', 'code', 'pre', 'div', 'button', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 's', 'br', 'hr'];

test('text from outside cannot inject markup or script', () => {
  const hostile = [
    '<script>window.x = 1</script>', '<img src="x" onerror="window.y = 1">', '<a href="javascript:alert(1)">x</a>',
    '[js](javascript:alert(1))', '[data](data:text/html,<script>1</script>)', '[q](https://e.test/"onmouseover="alert(1))',
    '[q2](https://e.test/\'onmouseover=\'alert(1))', '<https://e.test/"onfocus="x>', '`<script>`', '| <b>x</b> | y |\n|--|--|\n| <i>z</i> | w |',
    '```html\n<script>alert(1)</script>\n```', '# <h1>x</h1>', '> <iframe src="x"></iframe>', '- <style>*{}</style>', '[x](<javascript:alert(1)>)',
  ];
  for (const text of hostile) {
    for (const doc of [false, true]) {
      const out = html(text, { doc });
      // Text never holds a raw "<", so every "<" opens a tag, and each tag is plain: a name and quoted attributes only.
      assert.equal((out.match(/</g) || []).length, (out.match(/<\/?[a-z0-9]+(?: [a-z-]+(?:="[^"]*")?)*>/g) || []).length, `${text} drew a tag that is not plain: ${out}`);
      for (const [tagText] of out.matchAll(/<[^>]*>/g)) {
        assert.ok(ALLOWED.includes(tagText.match(/^<\/?([a-z0-9]+)/)[1]), `${text} drew ${tagText}`);
        for (const [, name] of tagText.replace(/="[^"]*"/g, '').matchAll(/ ([a-z-]+)/g)) assert.ok(ATTRIBUTES.includes(name), `${text} gave ${tagText} a ${name} attribute`);
      }
      assert.ok(!/href="(?!https?:\/\/)/i.test(out), `${text} linked to something that is not http(s)`);
    }
  }
  assert.equal(inline('<b>x</b> & "q"'), '&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;');
  assert.equal(inline('[js](javascript:alert(1))'), '<span class="local-link" title="javascript:alert(1)">js</span>');
});

test('lists nest, number, tick, and hold more than one paragraph', () => {
  const nested = html('- one **a**\n  - two\n    - three\n- back');
  assert.equal(nested, '<ul>\n<li>one <strong>a</strong>\n<ul>\n<li>two\n<ul>\n<li>three</li>\n</ul>\n</li>\n</ul>\n</li>\n<li>back</li>\n</ul>\n');
  assert.match(html('1. first\n2. second\n   1. nested'), /^<ol>\n<li>first<\/li>\n<li>second\n<ol>\n<li>nested<\/li>\n<\/ol>\n<\/li>\n<\/ol>\n$/);
  assert.match(html('3. starts at three\n4. next'), /^<ol start="3">/);
  const tasks = html('- [ ] open **x**\n- [x] done\n- [X] also done\n- plain [x] later');
  assert.match(tasks, /<li class="task">open <strong>x<\/strong><\/li>/);
  assert.equal((tasks.match(/class="task"/g) || []).length, 1);
  assert.equal((tasks.match(/class="task done"/g) || []).length, 2);
  assert.ok(!tasks.includes('[ ]') && !tasks.includes('[x] done'), 'the box is drawn by the page, not typed');
  const loose = html('- item\n\n  second paragraph\n\n- next');
  assert.match(loose, /<li>\n<p>item<\/p>\n<p>second paragraph<\/p>\n<\/li>/, 'the second paragraph stays in its item');
  assert.match(html('- item\n\n  ```bash\n  echo hi\n  ```'), /<li>\n<p>item<\/p>\n<div class="codebox">/, 'code inside an item stays in its item');
  assert.match(html('* star\n+ plus'), /<ul>\n<li>star<\/li>\n<\/ul>\n<ul>\n<li>plus<\/li>\n<\/ul>/);
});

test('block quotes and rules', () => {
  assert.equal(html('> **Quoted** and `code`\n> second line'), '<blockquote>\n<p><strong>Quoted</strong> and <code>code</code><br>\nsecond line</p>\n</blockquote>\n');
  assert.equal(html('before\n\n---\n\nafter'), '<p>before</p>\n<hr>\n<p>after</p>\n');
});

test('tables: header, alignment, inline markup, an escaped pipe and a <br> in a cell', () => {
  const out = html('| Name | Value |\n|:-:|--:|\n| **bold** | `code` |\n| [l](https://e.test/) | a \\| b |\n| ~~x~~ | one<br>two |');
  assert.match(out, /^<div class="table-wrap"><table>\n<thead>\n<tr>\n<th style="text-align:center">Name<\/th>\n<th style="text-align:right">Value<\/th>/);
  assert.match(out, /<td style="text-align:center"><strong>bold<\/strong><\/td>/);
  assert.match(out, /<td style="text-align:right"><code>code<\/code><\/td>/);
  assert.match(out, /<a href="https:\/\/e.test\/" target="_blank" rel="noopener noreferrer">l<\/a>/);
  assert.match(out, /a \| b/);
  assert.match(out, /<s>x<\/s>/);
  assert.match(out, /one<br>\s*two/);
  assert.match(out, /<\/table><\/div>\n$/);
  assert.match(html('| A | B |\n|---|---|\n| 1 | 2 |'), /<th>A<\/th>/, 'a plain rule row, three dashes, is a header too');
  assert.match(html('| A | B |\n|-|-|\n| 1 | 2 |'), /<th>A<\/th>/, 'one dash is a rule row too');
});

test('a code block is a box with its label and a Copy button, and its text is never marked up', () => {
  const out = html('```bash\necho "**not bold**" <b>\n```');
  assert.equal(out, '<div class="codebox"><span class="code-label">bash</span><button type="button" class="copy" data-label="Copy" aria-label="Copy" title="Copy this to the clipboard"></button><pre>echo &quot;**not bold**&quot; &lt;b&gt;</pre></div>\n');
  assert.match(html('~~~\nplain\n~~~'), /^<div class="codebox"><button type="button" class="copy"[^>]*><\/button><pre>plain<\/pre><\/div>\n$/, 'no label when the fence names no language');
  assert.match(html('```\n\nstarts blank\n```'), /<pre>\n\nstarts blank<\/pre>/, 'a first blank line survives the HTML parser dropping one');
  assert.match(html('text\n\n    indented code\n'), /<pre>indented code<\/pre>/);
  assert.match(html('```js x y\nlet a;\n```'), /<span class="code-label">js<\/span>/, 'the label is the first word of the info line');
});

test('a reply keeps small headings; a document gets real levels, an id from its source line, and a front matter box', () => {
  assert.equal(html('# Big\n## Smaller **bold**'), '<h4>Big</h4>\n<h4>Smaller <strong>bold</strong></h4>\n');
  const doc = render('# Title\n\ntext\n\n## Part `a` and **b**\n\nSetext\n======', { doc: true });
  assert.match(doc.html, /<h1 id="doc-h-0">Title<\/h1>/);
  assert.match(doc.html, /<h2 id="doc-h-4">Part <code>a<\/code> and <strong>b<\/strong><\/h2>/);
  assert.match(doc.html, /<h1 id="doc-h-6">Setext<\/h1>/);
  assert.deepEqual(JSON.parse(JSON.stringify(doc.headings)), [
    { level: 1, id: 'doc-h-0', text: 'Title' }, { level: 2, id: 'doc-h-4', text: 'Part a and b' }, { level: 1, id: 'doc-h-6', text: 'Setext' },
  ]);
  const front = render('---\ntitle: x\ntags: [a, b]\n---\n# After\n', { doc: true });
  assert.match(front.html, /^<div class="codebox"><span class="code-label">front matter<\/span>.*<pre>title: x\ntags: \[a, b\]<\/pre><\/div>\n<h1 id="doc-h-4">After<\/h1>/s, 'headings keep the line they have in the file');
  assert.equal(front.headings[0].id, 'doc-h-4');
  assert.match(render('---\nnot front matter, no closing rule\n\ntext', { doc: true }).html, /<hr>/, 'a document that only opens with a rule is not front matter');
  assert.ok(!/id="doc-h/.test(html('# a')), 'a reply has no heading ids');
  assert.match(html('---\nx\n---\ntext'), /<hr>/, 'a reply has no front matter box');
});

test('the lines of a reply that ask or remind are marked where they are', () => {
  const out = reply('A **bold\nstatement** first.\nShould I **merge**?\nA plain line.\n\n- Which `option`?\n\n| Q | A |\n|--|--|\n| ok? | no |\n\n---', [2, 5, 9], [3]);
  assert.match(out, /<p>A <strong>bold<\/strong><br>\n<strong>statement<\/strong> first\.<br>\n<span class="ask">Should I <strong>merge<\/strong>\?<\/span><br>\n<span class="reminder">A plain line\.<\/span><\/p>/, 'the bold that crosses the line end is closed and opened again, so the spans nest');
  assert.match(out, /<li><span class="ask">Which <code>option<\/code>\?<\/span><\/li>/);
  assert.match(out, /<tr class="ask">\n<td>ok\?<\/td>/);
  assert.equal(reply('line one\nline two', [], []), '<p>line one<br>\nline two</p>\n', 'no mark, no span');
  assert.equal(reply('# Head?\n\nbody', [0], []), '<h4><span class="ask">Head?</span></h4>\n<p>body</p>\n');
  assert.equal(reply('one\n\n***', [2], []), '<p>one</p>\n<hr class="ask">\n');
  // A link that crosses the line end keeps both halves as links.
  assert.equal(reply('[a\nb](https://e.test/)', [1], []), '<p><a href="https://e.test/" target="_blank" rel="noopener noreferrer">a</a><br>\n<span class="ask"><a href="https://e.test/" target="_blank" rel="noopener noreferrer">b</a></span></p>\n');
  // A <br> typed into a line is not a line of the source, so the lines after it keep their numbers.
  assert.match(reply('a<br>b\nc?', [1], []), /<br>\n<span class="ask">c\?<\/span>/);
});

test('every mark a reply asks for is drawn once and every span is closed', () => {
  const lines = ['**a**', '*b*', '`c`', '[d](https://e.test/)', 'e **f', 'g** h', '~~i~~', 'j'];
  const text = lines.join('\n');
  for (let mask = 0; mask < 1 << lines.length; mask += 1) {
    const ask = lines.map((_, n) => n).filter((n) => mask & (1 << n));
    const out = reply(text, ask, []);
    assert.equal((out.match(/<span class="ask">/g) || []).length, ask.length, `lines ${ask}`);
    assert.equal((out.match(/<\/span>/g) || []).length, ask.length, `lines ${ask}`);
    for (const tag of ['strong', 'em', 's', 'a']) assert.equal((out.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length, (out.match(new RegExp(`</${tag}>`, 'g')) || []).length, `${tag} balanced for lines ${ask}`);
  }
});

test('the words the search matches are the words the page shows', () => {
  const samples = [
    'the **deploy** step', 'run `npm test` now', '**`code` in bold** and __under__ and ~~gone~~ and ***both***', '**a * b** and \\*escaped\\*',
    '# Heading ##\n\n- item one\n* item two\n> quoted line', '| Name | Value |\n|:-:|---|\n| **widget** | 42 |', 'before\n```bash\nls **/*.js | wc\n```\nafter',
    '1. one\n2. two\n   - nested **x**', '- [ ] open\n- [x] done', 'a<br>b & c < d', '**bold that spans\ntwo lines** after', 'a *slanted* word and snake_case_name',
    '- item\n\n  second paragraph\n\n- next', '| a |\n|--|\n| x<br>y |', 'plain\n\n\n   spaced   out  ', '[the **docs**](./notes/a.md) here',
  ];
  for (const text of samples) {
    const shown = visible(html(text));
    // A link is read as its label and its address; the page shows the label, with the address on hover or behind it.
    const read = plain(text).replace(/ \.\/notes\/a\.md/, '');
    // Task boxes are drawn by CSS, so neither side holds them. A table's rule row and a rule's dashes hold no words.
    assert.equal(read, shown, text);
  }
});

test('plain: a reply read the way the page draws it', () => {
  assert.equal(plain('the **deploy** step'), 'the deploy step');
  assert.equal(plain('see [the docs](https://example.test/a_b) for more'), 'see the docs https://example.test/a_b for more');
  assert.equal(plain('a link https://example.test/x here'), 'a link https://example.test/x here', 'an address that is its own label is said once');
  assert.equal(plain('**`code` in bold**'), 'code in bold');
  assert.equal(plain('__under__ ~~gone~~'), 'under gone');
  assert.equal(plain('use `**/*.md` globs'), 'use **/*.md globs');
  assert.equal(plain('before\n```bash\nls **/*.js | wc\n```\nafter'), 'before ls **/*.js | wc after');
  assert.equal(plain('first\n\n\n   second   line  '), 'first second line');
  assert.equal(plain('C# and issue #12'), 'C# and issue #12');
  assert.equal(plain('| Name | Value |\n|:-:|---|\n| widget | 42 |'), 'Name Value widget 42');
  assert.equal(plain(''), '');
});
