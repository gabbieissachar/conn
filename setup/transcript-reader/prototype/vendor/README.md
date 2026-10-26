# Vendored markdown-it

`markdown-it.min.js` is the UMD build of [markdown-it](https://github.com/markdown-it/markdown-it) 15.0.3 (`dist/browser/markdown-it.umd.min.js` in the npm package of that name; it bundles its own dependencies: linkify-it, mdurl, uc.micro, entities, punycode.js). It is the only change from that file: the leading license line is added and the trailing `sourceMappingURL` comment is removed, because the page pastes the file into its own script, where no map exists.

`build_prototype.fill_template` pastes it into the reader page ahead of `markdown.js`, so the page (and the hosted copy) draws markdown with no network at run time. Licenses: markdown-it, linkify-it, mdurl, uc.micro and punycode.js are MIT (`markdown-it.LICENSE`); entities is BSD-2-Clause.

To update it: `npm pack markdown-it@<version>`, unpack, copy `dist/browser/markdown-it.umd.min.js` over this file with the two changes above, change the version in the first line and here, then run `markdown.test.js` and `find.test.js` (every drawing and search rule in `markdown.js` is pinned there).
