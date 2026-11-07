#!/usr/bin/env node
'use strict';

// The picker's "closed pane" tag says what Herdr says now, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own port
// with a fake Herdr (nothing is sent to any pane). By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/picker-tags-check.js <scratch folder> [screenshots folder]
//
// The owner's picker said "closed pane" on every starred row, live ones too: the tag came from "reopened by hand" (a flag a conversation keeps for as
// long as ANY session of its pane was once reopened), not from whether a pane runs it. The lab lists three sessions in the reopened file: two that a
// pane runs now (cp-ontology-search, crew-1) and one no pane runs (a filler). The tag must follow the pane: none on the first two, starred or not,
// and "closed pane" on the filler.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-picker-tags-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, click, startLab, openPage, pick, finish, sleep } = make('reader-picker-tags-check');

const OPTIONS = `const sel = document.querySelector('select[name=session]');
  return { ok: true, options: [...sel.options].map(o => ({ text: o.text, group: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label.replace(/ · \\d+$/, '') : '' })) };`;
const has = (options, label) => options.filter((o) => o.text.includes(label));

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  process.env.LAB_FILLERS = '2';
  const { lab, page, stop, outDir } = await startLab(folder);
  try {
    const listed = fs.readFileSync(path.join(outDir, 'sessions.txt'), 'utf8').split('\n').filter(Boolean);
    const filler = listed[listed.length - 1];
    fs.writeFileSync(path.join(outDir, 'reopened.txt'), [lab.search, lab.crew[0], filler].join('\n') + '\n');
    await openPage(page, '1000x900x1');
    pick('cp-ontology-search'); await sleep(900);
    ev(`document.getElementById('sync').click(); return true;`);
    await until(`const s = document.querySelector('select[name=session]'); return { ok: s && [...s.options].some(o => /closed pane/.test(o.text)) };`, 'the build that carries the reopened list', 90000);
    await sleep(800);
    let { options } = ev(OPTIONS);
    const live = has(options, 'cp-ontology-search').concat(has(options, 'crew-1'));
    check(live.length === 2 && live.every((o) => !/closed pane/.test(o.text)), 'a session a pane runs now has no "closed pane" tag, though it was reopened by hand once', JSON.stringify(live.map((o) => o.text)));
    const idle = options.filter((o) => /closed pane/.test(o.text));
    check(idle.length >= 1 && idle.every((o) => o.group === 'Closed panes'), 'a reopened session no pane runs says "closed pane", under Closed panes', JSON.stringify(idle.map((o) => [o.text, o.group])));

    // ---- star the live one: the Starred row says what the pane says too
    click('button', 'Star this session'); await sleep(900);
    ({ options } = ev(OPTIONS));
    const starred = options.filter((o) => o.group === 'Starred');
    check(starred.length === 1 && /cp-ontology-search/.test(starred[0].text) && !/closed pane/.test(starred[0].text), 'a starred live session has no "closed pane" tag', JSON.stringify(starred.map((o) => o.text)));
    axi('screenshot', path.join(shots, 'picker-tags-01.png'));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
