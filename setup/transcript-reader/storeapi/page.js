'use strict';

// Builds the windowed lite page: one HTML document, no build step beyond this. The shell (page/windowed.html) takes its styles from the
// reader's own template (prototype/template.html's <style>, so the cards, chips, fold rows and dock look exactly like the reader's), the
// vendored markdown-it and markdown.js (so a reply is drawn as the reader draws it), and the page's own script (page/windowed.js). The
// script's hash goes into the page's content policy, as the reader's pages do. The token slot is left for api.js to fill.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function build(root) {
  const reader = path.join(root, 'setup', 'transcript-reader');
  const read = (...parts) => fs.readFileSync(path.join(reader, ...parts), 'utf8');
  const template = read('prototype', 'template.html');
  const start = template.indexOf('<style>');
  const end = template.indexOf('</style>', start);
  if (start < 0 || end < 0) throw new Error('the reader template has no style block');
  const style = template.slice(start + '<style>'.length, end);
  const script = ['(() => {', '"use strict";', read('prototype', 'vendor', 'markdown-it.min.js'), read('prototype', 'markdown.js'), read('storeapi', 'page', 'windowed.js'), '})();'].join('\n');
  const shell = read('storeapi', 'page', 'windowed.html');
  // The shell wraps the script slots itself; the hash covers exactly the text between its <script> tags.
  const inner = shell.slice(shell.indexOf('<script>') + 8, shell.indexOf('</script>'));
  const body = inner.replace('(() => {\n"use strict";\n/*__MARKDOWN_IT__*/\n/*__MARKDOWN__*/\n/*__WINDOWED__*/\n})();', () => script);
  if (body === inner) throw new Error('the page shell lost its script slots');
  const hash = 'sha256-' + crypto.createHash('sha256').update(body).digest('base64');
  return shell.replace('/*__STYLE__*/', () => style).replace(inner, () => body).replace('__SCRIPT_HASH__', hash);
}

module.exports = { build };
