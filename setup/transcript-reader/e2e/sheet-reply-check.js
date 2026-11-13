#!/usr/bin/env node
'use strict';

// The original reply beside the answer sheet, in a real (headless) browser (chrome-devtools-axi), against a lab copy of the reader on its own port with a
// fake Herdr (nothing is sent to any pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/sheet-reply-check.js <scratch folder> [screenshots folder]
//
// Nathan, 2026-11-08: sheets often miss content, so he wants the reply each sheet was built from beside it. The lab's crew-1 gets a reply with tables, a code
// box and a list (invented text, answer-sheet-fixtures/). On its sheet the "Original reply" button must open the reply in a panel drawn as the conversation
// draws it (tables with their header row, a code box with its Copy button), placed beside the sheet in a wide window and above the answer line in a narrow one,
// and Esc or Close must give the sheet back.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const READER = path.resolve(__dirname, '..');
const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-sheet-reply-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-sheet-reply-check');

const stamp = (outDir) => { try { return fs.statSync(path.join(outDir, 'prototype.html')).mtimeMs; } catch (e) { return 0; } };
const iso = (at) => new Date(at * 1000).toISOString();

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop, outDir } = await startLab(folder);
  const log = path.join(lab.home, '.claude', 'projects', '-lab-crew-1', lab.crew[0] + '.jsonl');
  const fixture = fs.readFileSync(path.join(READER, 'answer-sheet-fixtures', 'backtick-letters-in-cells-two-review-groups.md'), 'utf8');
  const text = fixture.replace('Reply with keyed answers:', '```\nreminders --mute --until-end\n```\n\n- the notes go to `notes.md`\n- the digest stays as it is\n\nReply with keyed answers:');
  try {
    const before = stamp(outDir);
    const at = Date.now() / 1000 + 1;
    fs.appendFileSync(log, [
      { type: 'user', uuid: 'u-reply-1', timestamp: iso(at - 5), cwd: '/lab/crew-1', message: { role: 'user', content: 'Start the design' } },
      { type: 'assistant', timestamp: iso(at), cwd: '/lab/crew-1', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
    for (let i = 0; i < 120 && stamp(outDir) === before; i++) await sleep(250);
    await sleep(500);
    await openPage(page, '1280x860x1');
    pick('crew-1'); await sleep(1500);
    const base = page.replace(/prototype\.html.*$/, '');
    const link = ev(`return { ok: true, href: document.querySelector('a.to-sheet').getAttribute('href') };`).href;
    axi('open', base + link); await sleep(1800);
    await until(`return { ok: document.querySelectorAll('.card .key').length > 0 };`, 'the sheet');

    // ---- closed at first, with the button there
    let s = ev(`const b = document.getElementById('reply-open'); const p = document.getElementById('reply-panel'); return { ok: true, button: !b.hidden, label: b.textContent, expanded: b.getAttribute('aria-expanded'), panel: !p.hidden };`);
    check(s.button && s.label === 'Original reply' && s.expanded === 'false' && !s.panel, 'the sheet has an "Original reply" button, and the reply is not open', JSON.stringify(s));
    ev(`document.getElementById('reply-open').click(); return true;`); await sleep(500);

    // ---- wide window: side by side
    s = ev(`const p = document.getElementById('reply-panel').getBoundingClientRect(); const m = document.querySelector('main').getBoundingClientRect(); const d = document.querySelector('.dock .inner').getBoundingClientRect(); const b = document.querySelector('.bar .inner').getBoundingClientRect();
      return { ok: true, open: !document.getElementById('reply-panel').hidden, panel: [Math.round(p.left), Math.round(p.top), Math.round(p.right), Math.round(p.bottom)], main: [Math.round(m.left), Math.round(m.right)], dock: [Math.round(d.left), Math.round(d.right)], bar: [Math.round(b.left), Math.round(b.right)], w: innerWidth, h: innerHeight };`);
    check(s.open && s.main[1] <= s.panel[0] && s.dock[1] <= s.panel[0] && s.bar[1] <= s.panel[0], 'in a wide window the sheet, its answer line and its header stand left of the reply, with no overlap', JSON.stringify(s));
    check(s.panel[2] <= s.w && s.panel[3] <= s.h && s.panel[1] >= 0, 'and the reply is inside the window', JSON.stringify(s.panel));
    s = ev(`const body = document.getElementById('reply-body'); const tables = [...body.querySelectorAll('.table-wrap table')]; return { ok: true, tables: tables.length, heads: tables.map(t => [...t.querySelectorAll('th')].map(h => h.textContent).join('|')), rows: tables.map(t => t.querySelectorAll('tbody tr').length), codes: body.querySelectorAll('td code').length, box: body.querySelectorAll('.codebox pre').length, boxText: (body.querySelector('.codebox pre') || {}).textContent || '', copy: body.querySelectorAll('.codebox button.copy').length, items: body.querySelectorAll('li').length, headings: [...body.querySelectorAll('h4')].map(h => h.textContent) };`);
    check(s.tables === 2 && s.heads[0] === 'ID|Decision|Depends on|Recommended|Answer' && s.heads[1] === 'ID|Decision|Recommended|Answer' && s.rows.join() === '3,3', 'the reply is drawn with its two tables, header rows and rows', JSON.stringify([s.heads, s.rows]));
    check(s.codes >= 12 && s.box === 1 && /reminders --mute/.test(s.boxText) && s.copy === 1 && s.items >= 5, 'with the choices in the cells as code, a code box with its Copy button, and its list', JSON.stringify(s));
    check(s.headings.some((h) => /Review group A/.test(h)) && s.headings.some((h) => /Review group B/.test(h)), 'and the headings of both review groups', JSON.stringify(s.headings));
    const look = ev(`const t = document.querySelector('#reply-body table'); const th = t.querySelector('th'); const cs = getComputedStyle(th); const wrap = getComputedStyle(t.parentElement); return { ok: true, thWeight: cs.fontWeight, thBg: cs.backgroundColor, wrapBorder: wrap.borderTopWidth + ' ' + wrap.borderTopLeftRadius, tdSize: getComputedStyle(t.querySelector('td')).fontSize };`);
    check(look.thWeight === '650' && look.tdSize === '14px' && /8px/.test(look.wrapBorder), 'the table looks as the conversation\'s: header weight 650, 14px cells, a 1px rounded border', JSON.stringify(look));
    axi('screenshot', path.join(shots, 'sheet-reply-1-wide.png'));

    // ---- Copy on the code box
    ev(`window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; return true;`);
    ev(`document.querySelector('#reply-body button.copy').click(); return true;`); await sleep(300);
    check(ev(`return { ok: true, v: window.__copied };`).v === 'reminders --mute --until-end', 'Copy on the code box copies its text');

    // ---- the reply stays while the sheet is used
    ev(`document.querySelector('.card .opt').click(); return true;`); await sleep(300);
    s = ev(`return { ok: true, open: !document.getElementById('reply-panel').hidden, pressed: document.querySelector('.card .opt').getAttribute('aria-pressed') };`);
    check(s.open && s.pressed === 'true', 'picking an answer leaves the reply open beside the sheet');

    // ---- Esc and Close
    ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`); await sleep(300);
    s = ev(`const m = document.querySelector('main').getBoundingClientRect(); return { ok: true, open: !document.getElementById('reply-panel').hidden, expanded: document.getElementById('reply-open').getAttribute('aria-expanded'), center: Math.round(m.left + m.width / 2), w: innerWidth };`);
    check(!s.open && s.expanded === 'false' && Math.abs(s.center - s.w / 2) < 8, 'Esc closes it and the sheet is centred again', JSON.stringify(s));
    ev(`document.getElementById('reply-open').click(); return true;`); await sleep(300);
    ev(`document.getElementById('reply-close').click(); return true;`); await sleep(300);
    check(!ev(`return { ok: true, v: !document.getElementById('reply-panel').hidden };`).v, 'the Close button does too');

    // ---- kept for the tab, and a narrow window
    ev(`document.getElementById('reply-open').click(); return true;`); await sleep(300);
    axi('open', base + link); await sleep(1800);
    check((await until(`return { ok: document.querySelectorAll('.card .key').length > 0, open: !document.getElementById('reply-panel').hidden };`, 'the reloaded sheet')).open, 'a reload of the sheet opens beside its reply again (kept for the tab)');
    axi('emulate', '--viewport', '400x860x2'); await sleep(900);
    s = ev(`const p = document.getElementById('reply-panel').getBoundingClientRect(); const d = document.querySelector('.dock').getBoundingClientRect(); return { ok: true, open: !document.getElementById('reply-panel').hidden, panel: [Math.round(p.left), Math.round(p.top), Math.round(p.right), Math.round(p.bottom)], dockTop: Math.round(d.top), w: innerWidth, close: Math.round(document.getElementById('reply-close').getBoundingClientRect().height), tableWide: document.querySelector('#reply-body .table-wrap').scrollWidth > document.querySelector('#reply-body .table-wrap').clientWidth };`);
    check(s.open && s.panel[0] >= 0 && s.panel[2] <= s.w && s.panel[3] <= s.dockTop, 'on a phone-width window it floats above the answer line, inside the window', JSON.stringify(s));
    check(s.close >= 44, 'and Close is a 44 px control on touch widths', String(s.close));
    check(s.tableWide, 'a wide table scrolls sideways inside the panel instead of breaking it');
    axi('screenshot', path.join(shots, 'sheet-reply-2-narrow.png'));
    axi('emulate', '--viewport', '1280x860x1'); await sleep(600);

    // ---- another sheet takes its own reply; no reply, no button
    axi('open', base + 'questionnaire.html'); await sleep(1800);
    await until(`return { ok: document.querySelectorAll('.card .key').length > 0 };`, 'the unscoped sheet');
    const both = ev(`const sel = document.getElementById('pick'); const out = []; for (let i = 0; i < sel.options.length; i++) { sel.value = String(i); sel.dispatchEvent(new Event('change', { bubbles: true })); out.push({ label: sel.options[i].text.split(' · ')[0], first: (document.querySelector('#reply-body h4') || {}).textContent || '', button: !document.getElementById('reply-open').hidden }); } return { ok: true, out };`);
    check(both.out.length >= 2 && both.out.every((o) => o.button), 'every sheet of the lab has its reply to open', JSON.stringify(both.out));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
