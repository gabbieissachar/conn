#!/usr/bin/env node
'use strict';

// The step sheet's Format button in a real browser (chrome-devtools-axi, headless), against a lab copy of the reader on its own port with a fake Herdr.
// By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/step-format-check.js <scratch folder> [screenshots folder]
//
// The owner: "the tool call format is so hard to read, can add a format button to enable the command to be formatted in a readable way". Before the change the
// Command block of a Bash step was one long wrapped line. The lab (LAB_COMMANDS=1) gives crew-1's latest reply six shell steps in the shapes of real ones.
// Pinned here at 1440 px and at a 330 px Watch column, light and dark:
//   - a command with ; && | gets a Format button beside Copy; a plain one gets none;
//   - Format lays the command out one statement per line, a heredoc's body and a quoted ; or | untouched;
//   - Copy copies the original text, formatted or not;
//   - the choice is kept across steps and across a reload;
//   - the buttons and the block fit the sheet, with nothing scrolling sideways.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-step-format-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-step-format-check');

const FIRST = 'cat /lab/home/.claude/projects/-lab-workspace-firstmate/memory/usage-notes.md; cd /lab/home/treehouse/1/firstmate && grep -rn -i "campus" data/captain.md data/learnings.md config 2>/dev/null | cut -c1-300 | head -20; fm-who list 2>&1 | head -20; fm-session list 2>&1 | head';
const FIRST_FORMATTED = [
  'cat /lab/home/.claude/projects/-lab-workspace-firstmate/memory/usage-notes.md',
  'cd /lab/home/treehouse/1/firstmate &&',
  '  grep -rn -i "campus" data/captain.md data/learnings.md config 2>/dev/null |',
  '  cut -c1-300 |',
  '  head -20',
  'fm-who list 2>&1 |',
  '  head -20',
  'fm-session list 2>&1 |',
  '  head',
].join('\n');
const HEREDOC = "cat > /lab/crew-1/notes.txt <<'EOF'\nfirst line; with | pipe && more\nsecond line\nEOF\ncat /lab/crew-1/notes.txt | wc -l";
const HEREDOC_FORMATTED = "cat > /lab/crew-1/notes.txt <<'EOF'\nfirst line; with | pipe && more\nsecond line\nEOF\ncat /lab/crew-1/notes.txt |\n  wc -l";
const QUOTED = `echo "a;b | c && d" && echo 'x || y' | sed 's/x/z/' || true`;
const QUOTED_FORMATTED = `echo "a;b | c && d" &&\n  echo 'x || y' |\n  sed 's/x/z/' ||\n  true`;

// What the open sheet shows of its Command block: its text, its buttons, their boxes, and whether anything overflows.
const BOX = `const b = n => { const r = n && n.getBoundingClientRect(); return r ? { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } : null; };`;
const sheet = () => {
  const text = ev(`const d = document.querySelector('.step-sheet'), pre = d.querySelector('.step-sec pre.step-code'), fmt = d.querySelector('.step-format');
    return { ok: true, pos: d.querySelector('.pos').textContent, text: pre ? pre.textContent : null, fmt: Boolean(fmt), pressed: fmt ? fmt.getAttribute('aria-pressed') : null };`);
  const boxes = ev(`${BOX} const d = document.querySelector('.step-sheet'), body = d.querySelector('.step-body');
    return { ok: true, fmtBox: b(d.querySelector('.step-format')), copyBox: b(d.querySelector('.step-copy:not(.step-format)')), preBox: b(d.querySelector('.step-sec pre.step-code')), sheet: b(d),
      sideways: d.scrollWidth > d.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth, bodySideways: body.scrollWidth > body.clientWidth + 1 };`);
  return { ...text, ...boxes };
};
const next = async () => { ev(`document.querySelector('.step-sheet [data-act="next"]').click(); return true;`); await sleep(250); };
const openSheet = async (index = 0) => {
  pick('crew-1'); await sleep(1200);
  ev(`const rows = document.querySelectorAll('.reply .steps-row'); if (!document.querySelector('.step')) rows[rows.length - 1].click(); return true;`); await sleep(400);
  ev(`document.querySelectorAll('.step')[${index}].click(); return true;`);
  await until(`return { ok: !document.querySelector('.step-sheet').hidden };`, 'the step sheet');
  await sleep(300);
};
const clickFormat = async () => { ev(`document.querySelector('.step-format').click(); return true;`); await sleep(250); };
// Copy is read from the page: the clipboard is stood in for, so the text that would reach it can be read.
const copied = async () => {
  ev(`window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); return true;`);
  ev(`document.querySelector('.step-sheet .step-copy:not(.step-format)').click(); return true;`); await sleep(250);
  return ev(`return window.__copied;`);
};

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  process.env.LAB_COMMANDS = '1';
  const { page, stop } = await startLab(folder);
  try {
    // ---- 1. 1440 px, light: the real-shaped command
    await openPage(page, '1440x900x1');
    axi('emulate', '--viewport', '1440x900x1', '--color-scheme', 'light'); await sleep(500);
    ev(`localStorage.removeItem('tr-step-format'); return true;`);
    await openSheet(0);
    let s = sheet();
    check(s.pos === 'Step 1 of 6' && s.text === FIRST && s.fmt && s.pressed === 'false', 'the command shows as written, with a Format button that is off', JSON.stringify({ pos: s.pos, fmt: s.fmt, pressed: s.pressed }));
    check(s.fmtBox && s.copyBox && s.fmtBox.r <= s.copyBox.x && Math.abs(s.fmtBox.y - s.copyBox.y) <= 2, 'Format sits beside Copy, to its left, on the same row', JSON.stringify({ f: s.fmtBox, c: s.copyBox }));
    axi('screenshot', path.join(shots, '01-1440-light-before.png'));
    await clickFormat();
    s = sheet();
    check(s.text === FIRST_FORMATTED && s.pressed === 'true', 'Format lays it out one statement per line, pipes and && continued with an indent', JSON.stringify(s.text));
    check(!s.sideways && !s.bodySideways, 'nothing scrolls sideways', JSON.stringify({ sideways: s.sideways, body: s.bodySideways }));
    check((await copied()) === FIRST, 'Copy still copies the original text, not the layout');
    axi('screenshot', path.join(shots, '02-1440-light-formatted.png'));
    check(String(ev(`return localStorage.getItem('tr-step-format');`)) === '1', 'the choice is kept');

    // ---- 2. the choice carries to the next steps; a plain command has no button; a heredoc and quotes stay as they were
    await next();
    s = sheet();
    check(s.pos === 'Step 2 of 6' && s.text === 'ls -la /lab/crew-1' && !s.fmt, 'a command with nothing to lay out has no Format button and shows as written', JSON.stringify({ pos: s.pos, text: s.text, fmt: s.fmt }));
    await next();
    s = sheet();
    check(s.pos === 'Step 3 of 6' && s.text === HEREDOC_FORMATTED && s.pressed === 'true', 'the heredoc step is laid out with its body left exactly as it was, and the choice carried over', JSON.stringify(s.text));
    check((await copied()) === HEREDOC, 'Copy copies the whole heredoc as written');
    await next();
    s = sheet();
    check(s.text === QUOTED_FORMATTED, 'a ; or | inside quotes does not split', JSON.stringify(s.text));
    await next();
    s = sheet();
    check(s.text.startsWith('(cd /lab/crew-1 && make build) |\n  tee /lab/crew-1/build.log\necho $(ls /lab/crew-1 | wc -l) files'), 'a subshell and a command substitution stay whole', JSON.stringify(s.text));
    await next();
    s = sheet();
    check(s.text.split('\n').length === 2 && s.text.includes('/lab/workspace/some/very/long/directory/name/for/a/script/that/keeps/going/and/going/transcript_reader_build_prototype_with_a_long_name.py --out /lab/workspace/another/long/directory/name/out.html &&'), 'a long path is kept whole on its line', JSON.stringify(s.text.slice(0, 120)));
    ev(`document.querySelector('.step-sheet [data-act="close"]').click(); return true;`);

    // ---- 3. a reload keeps the choice; turning it off keeps that too
    axi('open', 'about:blank'); axi('open', page);
    await until(`return { ok: / · Reader$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the page again');
    await sleep(600);
    await openSheet(0);
    s = sheet();
    check(s.text === FIRST_FORMATTED && s.pressed === 'true', 'after a reload the sheet opens laid out');
    await clickFormat();
    s = sheet();
    check(s.text === FIRST && s.pressed === 'false' && String(ev(`return localStorage.getItem('tr-step-format');`)) === '0', 'turning Format off shows the original again and keeps that', JSON.stringify({ pressed: s.pressed }));
    await clickFormat();

    // ---- 4. a 330 px Watch column and a phone, light and dark: the buttons and the block fit
    for (const [win, tag] of [[330, 'watch'], [390, 'phone']]) {
      for (const scheme of ['light', 'dark']) {
        await openPage(page, win === 390 ? '390x844x2,mobile,touch' : `${win}x800x1`);
        axi('emulate', '--viewport', win === 390 ? '390x844x2,mobile,touch' : `${win}x800x1`, '--color-scheme', scheme); await sleep(500);
        await openSheet(0);
        s = sheet();
        const what = `${win} px ${scheme}`;
        check(s.fmt && s.pressed === 'true' && s.text === FIRST_FORMATTED, `${what}: the sheet opens laid out (the choice was kept)`);
        check(s.fmtBox && s.copyBox && s.copyBox.r <= s.sheet.r && s.fmtBox.x >= s.sheet.x && Math.abs(s.fmtBox.y - s.copyBox.y) <= 2, `${what}: Format and Copy are on one row inside the sheet`, JSON.stringify({ f: s.fmtBox, c: s.copyBox, sheet: s.sheet }));
        check(s.fmtBox.h >= (win === 390 ? 44 : 36) && s.copyBox.h >= (win === 390 ? 44 : 36), `${what}: both buttons are big enough to tap`, JSON.stringify({ f: s.fmtBox.h, c: s.copyBox.h }));
        check(!s.sideways && !s.bodySideways && s.preBox.r <= s.sheet.r, `${what}: nothing scrolls sideways`, JSON.stringify({ sideways: s.sideways, body: s.bodySideways }));
        axi('screenshot', path.join(shots, `03-${tag}-${scheme}-formatted.png`));
        await clickFormat();
        s = sheet();
        check(s.text === FIRST && s.pressed === 'false', `${what}: off shows the original`);
        axi('screenshot', path.join(shots, `04-${tag}-${scheme}-original.png`));
        await clickFormat();
      }
    }

    // ---- 5. 1440 px dark
    await openPage(page, '1440x900x1');
    axi('emulate', '--viewport', '1440x900x1', '--color-scheme', 'dark'); await sleep(500);
    await openSheet(0);
    s = sheet();
    check(s.text === FIRST_FORMATTED && s.pressed === 'true', '1440 px dark: laid out, Format on');
    axi('screenshot', path.join(shots, '05-1440-dark-formatted.png'));
    axi('emulate', '--viewport', '1440x900x1', '--color-scheme', 'light');
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  }
  finish(stop);
})();
