#!/usr/bin/env node
'use strict';

// The Tasks page in a real browser (chrome-devtools-axi), against a lab: a scratch Firstmate home, a lab store of synthetic supervisor replies and the
// reader's own api.js on a free port with a Herdr that is never there (never the live reader, never a real home or pane). By hand, not part of
// `node --test` (it needs chrome-devtools-axi, Chrome and a Firstmate checkout with typed asks):
//
//   node setup/transcript-reader/e2e/board-check.js [scratch folder]
//
// Round 1, both writes off: the board draws its columns and cards from the home's records; a go-only hold waits in Queued with its label; a card opens
// its sheet with the calls, the reply that asked each, and the thread with why each reply is there; answering is off and says so; the page is read only;
// nothing scrolls sideways at a desktop or a phone width, and the phone gets a bottom sheet. Round 2, both writes on: a typed card answered on the card
// closes its task in the scratch home; a reply marked "Not this task" is one line in the task's own reply-marks.jsonl and can be put back; a hold of
// several prose calls offers no Record button.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { make, freePort, sleep } = require('./axi');

const folder = fs.mkdtempSync(path.join(process.argv[2] ? path.resolve(process.argv[2]) : os.tmpdir(), 'reader-board-lab-'));
const repo = path.resolve(__dirname, '..', '..', '..');
const t = make('reader-board-check');
const { check, ev, until, axi } = t;

function startServer(lab, port, flags) {
  const out = fs.openSync(path.join(folder, `server-${port}.log`), 'a');
  const env = { ...process.env, PMOS_READER_BOARD_CONFIG: lab.config, PMOS_READER_BOARD_CACHE: lab.cache, PMOS_READER_BOARD_WORKERS: path.join(lab.conf, 'board-workers.json'),
    LAB_OUT: lab.out, LAB_HIDDEN: lab.hidden, LAB_HERDR: lab.herdr };
  return spawn('node', [path.join(__dirname, 'board-lab-server.js'), repo, String(port), ...flags], { stdio: ['ignore', out, out], env });
}
async function waitUp(port) {
  let last = '';
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/setup/transcript-reader/board/`); if (r.ok || r.status === 403) return;  /* 403: the page refuses a script's fetch, which is the server answering */ last = 'HTTP ' + r.status; } catch (e) { last = e.message; } await sleep(200); }
  throw new Error('the lab server did not answer on ' + port + ': ' + last);
}
const cards = () => ev(`const m = {}; document.querySelectorAll('.card').forEach(c => { m[c.dataset.ref] = c.closest('.col').dataset.col; }); return m;`);
async function openBoard(port, hash = '', viewport = '1100x900x1') {
  axi('open', 'about:blank'); axi('emulate', '--viewport', viewport);
  axi('open', `http://127.0.0.1:${port}/setup/transcript-reader/board/?run=${Date.now()}#s=leader-lab${hash}`);
  await until(`return { ok: document.querySelectorAll('.card').length > 0 };`, 'the cards', 60000);
}
// Every column reachable at this width: either they all fit, or the board says so (jump bar with one tab per column) and the last tab brings the last column fully into view.
const reach = () => ev(`const c = document.getElementById('cols'), cols = [...c.querySelectorAll('.col')], b = c.getBoundingClientRect(); const out = (x) => { const r = x.getBoundingClientRect(); return r.right > b.right + 1 || r.left < b.left - 1; }; return { fits: c.scrollWidth <= c.clientWidth + 2, n: cols.length, tabs: document.querySelectorAll('.ctab').length, bar: getComputedStyle(document.getElementById('colbar')).display, doc: document.documentElement.scrollWidth <= innerWidth, clip: cols.filter(out).length };`);
async function checkWidth(width, label) {
  const r = reach();
  check(r.doc, `${label}: nothing scrolls sideways on the page`, JSON.stringify(r));
  if (width <= 720) { check(r.bar !== 'none' && r.tabs === r.n, `${label}: the phone has one tab per column`, JSON.stringify(r)); return; }
  if (r.fits) { check(r.clip === 0, `${label}: every column fits in the window`, JSON.stringify(r)); return; }
  check(r.bar !== 'none' && r.tabs === r.n, `${label}: the columns do not all fit, so the jump bar shows one tab per column`, JSON.stringify(r));
  ev(`const t = [...document.querySelectorAll('.ctab')].pop(); t.click(); return true;`);
  await until(`const c = document.getElementById('cols'), l = [...c.querySelectorAll('.col')].pop(), b = c.getBoundingClientRect(), r = l.getBoundingClientRect(); return { ok: r.right <= b.right + 1 && r.left >= b.left - 1 };`, `${label}: the last column in view`, 8000);
  check(true, `${label}: the last tab brings the last column fully into view`);
}
const sheetText = () => ev(`const s = document.querySelector('.sheet'); return s ? s.innerText : '';`);

(async () => {
  let lab;
  try { lab = JSON.parse(execFileSync('python3', ['-I', path.join(__dirname, 'board_lab.py'), folder], { encoding: 'utf8', timeout: 240000 }).trim().split('\n').pop()); }
  catch (error) { process.stdout.write('SKIP  no lab (needs a Firstmate checkout with typed asks)\n'); process.exit(0); }
  const servers = [];
  const stop = () => { servers.forEach((s) => s.kill()); try { axi('stop'); } catch (e) { /* not running */ } };
  try {
    // ---- round 1: both writes off
    let port = await freePort();
    servers.push(startServer(lab, port, [])); await waitUp(port);
    await openBoard(port);
    const placed = cards();
    check(placed['alpha-route'] === 'needs' && placed['delta-two-calls'] === 'needs' && placed['epsilon-figma'] === 'needs', 'the open calls are in Needs you', JSON.stringify(placed));
    check(placed['gamma-later'] === 'queued', 'a hold that only waits for your go is in Queued', placed['gamma-later']);
    check(ev(`return [...document.querySelectorAll('.card[data-ref="gamma-later"] .chip')].some(c => c.textContent === 'waits for your go');`), 'and carries its label');
    check(/read only/.test(ev(`return document.getElementById('asof').textContent;`)), 'the page says it is read only');
    check(ev(`return document.querySelector('.card[data-ref="alpha-route"] .c-calls .lab').textContent;`) === 'Z1', 'a typed card shows its key on the card face');
    ev(`location.hash = '#s=leader-lab&t=alpha-route/Z1'; return true;`);
    await until(`return { ok: !!document.querySelector('.sheet .callbox') };`, 'the sheet');
    const sheet = sheetText();
    check(/Which route should alpha take\?/.test(sheet) && /the shared plugin/.test(sheet) && /recommended/.test(sheet), 'the sheet shows the call, its options and the recommended one');
    check(/Asked in the reply of/.test(sheet), 'and the reply that asked it');
    check(/Answering on the card is off/.test(sheet) && !/Record this answer/.test(sheet), 'answering is off and says so');
    check(ev(`return [...document.querySelectorAll('.th-item.reply .why')].some(w => w.textContent === 'mention');`), 'the thread says why a reply is there');
    check(!ev(`return [...document.querySelectorAll('.th-item .mk')].some(b => /this task|Put it back|Withdraw/.test(b.textContent));`), 'marking is off: no mark buttons');
    // round 4, item 5: every tag on a reply explains itself, and a small legend says what each means
    check(ev(`const w = [...document.querySelectorAll('.th-item.reply .why')].find(x => x.textContent === 'mention'); return !!w && /names the task id/.test(w.title);`), 'a reply tag has a plain tooltip');
    const legend = ev(`const d = document.querySelector('.sheet details.legend'); if (!d) return null; d.open = true; return [...d.querySelectorAll('dt')].map(x => x.textContent);`);
    check(legend && ['mention', 'command', 'pointer', 'wake'].every((k) => legend.includes(k)) && legend.some((k) => /^roundup/.test(k)) && legend.includes('keyed'), 'a legend lists mention, command, pointer, wake, roundup and keyed', JSON.stringify(legend));
    // round 4, item 2: Back and Next (and the arrow keys) walk the cards of this column as shown
    const nav = () => ev(`const s = document.querySelector('.sheet'); const b = [...s.querySelectorAll('.navbtn')]; return { ref: s.querySelector('.sh-ref').textContent, pos: (s.querySelector('.sh-nav .pos') || {}).textContent, back: b[0] && !b[0].disabled, next: b[1] && !b[1].disabled, order: window.__board.S.order.needs };`);
    let at = nav();
    check(/^\d+ of \d+ in Needs you$/.test(at.pos) && at.order.includes(at.ref), 'the sheet says where it is in its column', JSON.stringify(at));
    ev(`window.__board.S.open = null; document.getElementById('layer').textContent = ''; return true;`);
    ev(`window.__board.jumpTo(window.__board.S.order.needs[0]); return true;`);
    await until(`return { ok: !!document.querySelector('.sheet .navbtn') };`, 'the first card of the column');
    at = nav(); const order = at.order;
    check(at.ref === order[0] && !at.back && (order.length < 2 || at.next), 'on the first card Back is off and Next is on', JSON.stringify(at));
    if (order.length > 1) {
      ev(`document.querySelector('.sheet .navbtn[data-nav="\u2192"]').click(); return true;`);
      check(nav().ref === order[1], 'Next opens the next card');
      ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); return true;`);
      check(nav().ref === order[0], 'the left arrow goes back');
      ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true;`);
      check(nav().ref === order[1], 'the right arrow goes on');
      ev(`const i = document.querySelector('.sheet .other input') || document.querySelector('.sheet input, .sheet textarea'); if (!i) return false; i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true;`);
      check(nav().ref === order[1], 'arrow keys typed in a text box never change the card');
      ev(`document.activeElement && document.activeElement.blur(); window.__board.jumpTo(window.__board.S.order.needs[window.__board.S.order.needs.length - 1]); return true;`);
      await sleep(300);
      at = nav(); check(at.next === false && at.back === true, 'on the last card Next is off', JSON.stringify(at));
    }
    ev(`window.__board.S.open = null; document.getElementById('layer').textContent = ''; return true;`);
    ev(`window.__board.jumpTo('alpha-route', 'Z1'); return true;`);
    await until(`return { ok: !!document.querySelector('.sheet .callbox') };`, 'the sheet again');
    // round 4, item 3: replies are drawn by the reader's own renderer, clipped behind "Show full reply", and can be hidden and shown again
    const reply0 = () => ev(`const r = [...document.querySelectorAll('.sheet .th-item.reply')].find(x => /The routes/.test(x.innerText) || x.querySelector('.rmd .clip')); return r ? { key: r.dataset.key, md: !!r.querySelector('.rmd .md'), h2: !!r.querySelector('.md h4'), li: r.querySelectorAll('.md li').length, table: !!r.querySelector('.md .table-wrap table'), code: !!r.querySelector('.md .codebox pre'), link: (r.querySelector('.md a[href^="https://example.test"]') || {}).target, clip: !!r.querySelector('.rmd .clip'), more: (r.querySelector('.rmd .more') || {}).textContent || '', text: r.innerText, pwned: window.__pwned === undefined, scripts: r.querySelectorAll('script, img').length } : null;`);
    let r0 = reply0();
    check(r0 && r0.md && r0.h2 && r0.li >= 3 && r0.table && r0.code && r0.link === '_blank', 'a reply is drawn by the reader\'s renderer: heading, list, table, code box, links open in a new tab', JSON.stringify(r0 && { ...r0, text: undefined }));
    check(r0 && r0.pwned && r0.scripts === 0 && /<script>window\.__pwned = 1<\/script>/.test(r0.text), 'markup inside a reply shows as text and runs nothing');
    check(r0 && r0.clip && /^Show full reply \(\d+ words\)$/.test(r0.more) && !/Paragraph 8/.test(r0.text.replace(/\s+/g, ' ')) , 'a long reply is clipped behind "Show full reply (N words)"', r0 && r0.more);
    const key0 = r0 && r0.key;
    ev(`document.querySelector('.sheet .th-item[data-key="${key0}"] .rmd .more').click(); return true;`);
    await until(`const r = document.querySelector('.sheet .th-item[data-key="${key0}"]'); return { ok: !!r && !r.querySelector('.rmd .clip') && /Paragraph 8/.test(r.innerText) && (r.querySelector('.rmd .more') || {}).textContent === 'Show less' };`, 'the whole reply');
    check(true, 'Show full reply opens the whole reply, read on demand, and the button says Show less');
    ev(`document.querySelector('.sheet .th-item[data-key="${key0}"] .rmd .more').click(); return true;`);
    await until(`const r = document.querySelector('.sheet .th-item[data-key="${key0}"]'); return { ok: !!r && !!r.querySelector('.rmd .clip') };`, 'clipped again');
    check(true, 'and Show less clips it again');
    // hide and show again: the reader's own list (here a scratch file)
    const hiddenFile = () => { try { return JSON.parse(fs.readFileSync(lab.hidden, 'utf8')).hidden.map((h) => h.key); } catch (e) { return []; } };
    ev(`document.querySelector('.sheet .th-item[data-key="${key0}"] .mk.hide').click(); return true;`);
    await until(`return { ok: !document.querySelector('.sheet .th-item[data-key="${key0}"]') && !!document.querySelector('.sheet .hidden-toggle') };`, 'the reply hidden');
    check(hiddenFile().length === 1 && /^[0-9a-f-]{36}:reply$/.test(hiddenFile()[0]), 'Hide puts the reply on the reader\'s own hidden list (the full turn id and :reply)', JSON.stringify(hiddenFile()));
    check(/^Hidden \(1\)$/.test(ev(`return document.querySelector('.sheet .hidden-toggle').textContent;`)), 'the thread says how many are hidden');
    ev(`document.querySelector('.sheet .hidden-toggle').click(); return true;`);
    await until(`const r = document.querySelector('.sheet .th-item.gone'); return { ok: !!r && r.querySelector('.mk.hide').textContent === 'Show again' };`, 'the hidden reply shown');
    check(true, 'the toggle shows hidden replies, dashed, each with Show again');
    ev(`document.querySelector('.sheet .th-item.gone .mk.hide').click(); return true;`);
    await until(`return { ok: !document.querySelector('.sheet .th-item.gone') };`, 'the reply shown again');
    check(hiddenFile().length === 0, 'Show again takes it off the list');
    ev(`const t = document.querySelector('.sheet .hidden-toggle'); if (t && t.getAttribute('aria-pressed') === 'true') t.click(); return true;`);
    // round 4, item 4 (drafting only here: Send is off in this round)
    const cmp = () => ({ ...ev(`const c = document.querySelector('.sheet .cmp'), sh = document.querySelector('.sheet'); if (!c) return {}; const r = c.getBoundingClientRect(), b = sh.getBoundingClientRect(); return { bottom: Math.round(b.bottom - r.bottom), open: !document.querySelector('.cmp-body').hidden, h: Math.round(r.height), send: document.querySelector('.cmp .go').disabled, sendText: document.querySelector('.cmp .go').textContent, noteEnd: document.documentElement.scrollWidth <= innerWidth };`),
      ...ev(`return { why: document.querySelector('.cmp-why').textContent, bar: document.querySelector('.cmp-toggle').innerText.replace(/\\s+/g, ' '), batch: document.querySelectorAll('.cmp-batch li').length, chip: !document.querySelector('.cmp-chip').hidden, line: document.querySelector('.cmp-chip .cmp-line').textContent, passage: document.querySelector('.cmp-passage span').textContent, value: document.querySelector('.cmp textarea').value };`) });
    let c = cmp();
    check(c && c.bottom === 0 && c.open && c.send && /Message lab-supervisor|Message Lab/.test(c.bar), 'the message box is pinned to the foot of the card and Send is off', JSON.stringify(c));
    check(/Sending from the board is off/.test(c.why), 'and says why Send is off', c.why);
    // select words in a reply, then comment on them: the floating button, the chip, the exact line
    ev(`const md = document.querySelector('.sheet .th-item.reply .md p'); const range = document.createRange(); const t = md.firstChild; range.setStart(t, 0); range.setEnd(t, Math.min(t.length, 24)); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); document.dispatchEvent(new Event('selectionchange')); return true;`);
    await until(`const f = document.querySelector('.cmp-float'); return { ok: !!f && !f.hidden };`, 'the floating Comment button');
    check(true, 'selecting words in a reply offers "Comment on this"');
    ev(`document.querySelector('.cmp-float').click(); return true;`);
    await until(`return { ok: !document.querySelector('.cmp-chip').hidden };`, 'the pointer chip');
    c = cmp();
    check(/^Reply to .* · /.test(ev(`return document.querySelector('.cmp-chip .cmp-head span').textContent;`)) && c.passage.length > 5 && /^Re your reply at \d\d:\d\d \("Nathan, alpha-route needs your pick[^"]*"\), the part "Nathan, alpha-route need": …$/.test(c.line), 'the chip names the reply, shows the selected words and the exact line Send would type', JSON.stringify({ line: c.line, passage: c.passage }));
    ev(`const t = document.querySelector('.cmp textarea'); t.value = 'first comment'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.cmp-row .alt').click(); return true;`);
    c = cmp();
    check(c.batch === 1 && !c.chip && c.value === '' && /Added to the batch \(1\)/.test(c.why) && /1 in the batch/.test(c.bar), 'Add puts the comment in the batch', JSON.stringify(c));
    ev(`const t = document.querySelector('.cmp textarea'); t.value = 'second, plain'; t.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    ev(`document.querySelector('.cmp-batchtoggle').click(); document.querySelector('.cmp-acts .cmp-linkbtn').click(); return true;`);
    c = cmp();
    check(c.batch === 1 && c.sendText === 'Send 2', 'a batch of one plus the box reads Send 2', JSON.stringify(c));
    check(/^2 comments:\n\n1\. Re your reply at \d\d:\d\d \("Nathan, alpha-route/.test(ev(`return document.querySelector('.cmp-preview .cmp-line').textContent;`)), 'Exact text shows the numbered message Send would type');
    // the draft and the batch survive the card being redrawn and another card being opened
    ev(`window.__board.render(); return true;`); await sleep(200);
    c = cmp(); check(c.value === 'second, plain' && c.batch === 1, 'the draft and the batch survive a redraw', JSON.stringify(c));
    // fold the box into its bar and open it again
    ev(`document.querySelector('.cmp-toggle').click(); return true;`);
    c = cmp(); check(!c.open && c.h < 60 && c.bottom === 0 && /draft/.test(c.bar), 'the box folds into a one-line bar that says there is a draft', JSON.stringify(c));
    ev(`window.__board.render(); return true;`); await sleep(150);
    check(!cmp().open, 'a folded box stays folded across a redraw');
    ev(`document.querySelector('.cmp-toggle').click(); return true;`);
    check(cmp().open, 'and opens again');
    check(ev(`return document.documentElement.scrollWidth <= innerWidth;`), 'no sideways scroll with the box open');
    check(ev(`return document.documentElement.scrollWidth <= innerWidth;`), 'no sideways scroll at desktop width');
    // a long worker name: cut with an ellipsis inside its chip, the same padding as the others, the whole name in the tooltip
    const chip = ev(`const sl = document.getElementById('sessline'), b = document.createElement('button'), s = document.createElement('span'); b.className = 'sess worker'; s.className = 'sl'; s.textContent = '2026-11-06-esim-listing-output-sync-run-with-a-very-long-tail'; b.title = s.textContent; b.append(s); sl.append(b); const r = b.getBoundingClientRect(), pad = getComputedStyle(b).paddingLeft; const o = sl.querySelector('.sess:not(.worker)'); return { cut: s.scrollWidth > s.clientWidth, ell: getComputedStyle(s).textOverflow, w: Math.round(r.width), pad, pad0: o ? getComputedStyle(o).paddingLeft : pad, tip: b.title.length > 40 };`);
    check(chip.cut && chip.ell === 'ellipsis' && chip.w <= 17 * 16 + 2 && chip.pad === chip.pad0 && chip.tip, 'a long worker chip is cut with an ellipsis, pads like the others and keeps its name in the tooltip', JSON.stringify(chip));
    ev(`document.querySelector('.sess.worker:last-child') && document.querySelector('.sess.worker:last-child').remove(); return true;`);
    // the Needs you column: a folded group says what it is, and a lone group opens by itself
    const grp = ev(`const col = document.querySelector('.col.needs'), g = [...col.querySelectorAll('details.grp')]; return { n: g.length, open: g.map(x => x.open), act: g.map(x => x.querySelector('.act') && x.querySelector('.act').textContent), sub: col.querySelector('.col-s').textContent };`);
    check(grp.n !== 1 || grp.open[0] === true, 'a Needs you column with one group shows it open', JSON.stringify(grp));
    check(grp.act.every((a, i) => a === (grp.open[i] ? 'fold' : 'show')), 'each group says whether it folds or shows', JSON.stringify(grp));
    if (grp.n) {
      ev(`document.querySelector('.col.needs details.grp > summary').click(); return true;`); await sleep(300);
      ev(`window.__board.render(); return true;`);
      check(ev(`return document.querySelector('.col.needs details.grp').open;`) === !grp.open[0], 'a group keeps the fold you chose across a redraw');
      ev(`document.querySelector('.col.needs details.grp > summary').click(); return true;`); await sleep(300);
    }
    for (const [w, label] of [[1200, '1200 px'], [1440, '1440 px'], [900, '900 px']]) { await openBoard(port, '', `${w}x900x1`); await checkWidth(w, label); }
    await openBoard(port, '', '1100x900x1');
    for (const dark of ['light', 'dark']) { axi('emulate', '--color-scheme', dark); await sleep(300); check(ev(`return getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)';`), `the page has its own background in ${dark}`); }
    axi('emulate', '--color-scheme', 'light');
    await openBoard(port, '&t=delta-two-calls', '390x844x2,mobile,touch');
    await until(`return { ok: !!document.querySelector('.sheet') };`, 'the phone sheet');
    check(ev(`const r = document.querySelector('.sheet').getBoundingClientRect(); return r.width === innerWidth && r.bottom === innerHeight && r.top > 0;`), 'on a phone the card is a bottom sheet');
    check(ev(`return document.documentElement.scrollWidth <= innerWidth;`), 'no sideways scroll at 390 px');
    check(ev(`return getComputedStyle(document.getElementById('colbar')).display !== 'none';`), 'the phone has the column tabs');
    await checkWidth(390, '390 px');
    servers.pop().kill();

    // ---- round 2: both writes on
    port = await freePort();
    servers.push(startServer(lab, port, ['--marks', '--answer'])); await waitUp(port);
    await openBoard(port);
    check(/writes on: answers and marks/.test(ev(`return document.getElementById('asof').textContent;`)), 'the page says which writes are on');
    ev(`location.hash = '#s=leader-lab&t=delta-two-calls'; return true;`);
    await until(`return { ok: !!document.querySelector('.sheet .callbox') };`, 'the multi-call sheet');
    check(/only whole/.test(sheetText()) && !/Record this answer/.test(sheetText()), 'a hold of several prose calls offers no Record button');
    ev(`const b = [...document.querySelectorAll('.th-item.reply .mk')].find(x => x.textContent === 'Not this task'); window.__turn = b.closest('.th-item').dataset.key; b.click(); return window.__turn;`);
    const marks = path.join(lab.home, 'data', 'delta-two-calls', 'reply-marks.jsonl');
    await until(`return { ok: !!document.querySelector('.th-item.reply.out') };`, 'the struck-through reply', 60000);
    const line = JSON.parse(fs.readFileSync(marks, 'utf8').trim().split('\n').pop());
    check(line.mark === 'out' && line.by === 'card' && /^[0-9a-f]{8}:[0-9a-f]{8}:reply$/.test(line.turn) && !('text' in line), 'a mark is one line on the task\'s own record, with no reply text', JSON.stringify(line));
    ev(`document.querySelector('.th-item.reply.out .mk').click(); return true;`);
    await until(`return { ok: !document.querySelector('.th-item.reply.out') };`, 'the reply put back', 60000);
    check(JSON.parse(fs.readFileSync(marks, 'utf8').trim().split('\n').pop()).mark === 'clear', 'put it back withdraws the mark');
    ev(`location.hash = '#s=leader-lab&t=alpha-route/Z1'; return true;`);
    await until(`return { ok: !!document.querySelector('.sheet .callbox .opt') };`, 'the typed card');
    check(ev(`const b = document.querySelector('.callbox .recbtn'); return !!b && b.disabled;`), 'Record is off until an answer is picked');
    ev(`document.querySelector('.callbox .opt').click(); document.querySelector('.callbox .recbtn').click(); return true;`);
    check(/fm-captain-ask\.sh answered/.test(ev(`return document.querySelector('.callbox .confirm').textContent;`)), 'Record asks again and shows the exact command first');
    ev(`document.querySelector('.callbox .confirm .primary').click(); return true;`);
    await until(`return { ok: document.querySelector('.card[data-ref="alpha-route"]') && document.querySelector('.card[data-ref="alpha-route"]').closest('.col').dataset.col === 'done' };`, 'the card in Done', 90000);
    check(/\[x\] alpha-route/.test(fs.readFileSync(path.join(lab.home, 'data', 'backlog.md'), 'utf8')), 'the scratch home\'s own task is closed by Firstmate\'s command');
    check(ev(`return document.documentElement.scrollWidth <= innerWidth;`), 'still no sideways scroll');
    servers.pop().kill();

    // ---- round 3 (item 4): sending from the card, with the reader's own guarded Send against a fake Herdr that types nowhere
    port = await freePort();
    servers.push(startServer(lab, port, ['--send'])); await waitUp(port);
    await openBoard(port, '&t=delta-two-calls');
    await until(`return { ok: !!document.querySelector('.sheet .cmp') && /To lab-supervisor/.test(document.querySelector('.cmp-why').textContent) };`, 'the box aimed at the live pane', 30000);
    check(/writes on: messages to the supervisor/.test(ev(`return document.getElementById('asof').textContent;`)), 'the page says which writes are on');
    check(/To lab-supervisor · idle/.test(ev(`return document.querySelector('.cmp-why').textContent;`)) && !ev(`return document.querySelector('.cmp .go').disabled && false;`), 'the box says which pane it writes to and its state');
    const promptsOf = () => (fs.existsSync(lab.log) ? fs.readFileSync(lab.log, 'utf8').split(/^(?=PROMPT)/m) : []).filter((l) => /^PROMPT/.test(l));
    ev(`const r = [...document.querySelectorAll('.sheet .th-item.reply')].find(x => /here are the calls/.test(x.innerText)); const p = r.querySelector('.md p'); const range = document.createRange(); range.setStart(p.firstChild, 0); range.setEnd(p.firstChild, 20); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); r.querySelector('.reply-to').click(); return true;`);
    await until(`return { ok: !document.querySelector('.cmp-chip').hidden };`, 'the chip');
    check(/^Re your reply at \d\d:\d\d \("Nathan, here are the calls[^"]*"\), the part "Nathan, here are the[^"]*": $/.test(ev(`return document.querySelector('.cmp-chip .cmp-line').textContent.replace(/…$/, '');`)), 'a comment on a reply of the live session points at it with its opening words and the selected part, as in the conversation view');
    ev(`const t = document.querySelector('.cmp textarea'); t.value = 'go with R1'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.cmp-row .alt').click(); return true;`);
    ev(`const t = document.querySelector('.cmp textarea'); t.value = 'and R2 too'; t.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    check(ev(`return document.querySelector('.cmp .go').textContent;`) === 'Send 2' && !ev(`return document.querySelector('.cmp .go').disabled;`), 'Send is on, and says it sends both');
    // Undo: the box locks with its words, and nothing leaves
    ev(`document.querySelector('.cmp .go').click(); return true;`); await sleep(700);
    let h = ev(`const t = document.querySelector('.cmp textarea'); return { ro: t.readOnly, send: document.querySelector('.cmp .go').textContent, add: document.querySelector('.cmp-row .alt').textContent, say: document.querySelector('.cmp-why').textContent, pend: [...document.querySelectorAll('.cmp-pending')].map(n => n.innerText.replace(/\\s+/g, ' ').slice(0, 80)), value: t.value };`);
    check(h.ro && /^Undo \d$/.test(h.send) && h.add === 'Now' && /Sending in \d s/.test(h.say) && h.pend.length === 1 && /nothing has left this page yet/.test(h.pend[0]), 'Send holds the message: box locked, Send reads Undo, Add reads Now, the faded message says nothing has left the page', JSON.stringify(h));
    ev(`document.querySelector('.cmp .go').click(); return true;`); await sleep(500);
    h = ev(`const t = document.querySelector('.cmp textarea'); return { ro: t.readOnly, value: t.value, send: document.querySelector('.cmp .go').textContent, pend: document.querySelectorAll('.cmp-pending').length };`);
    check(!h.ro && h.value === 'and R2 too' && h.send === 'Send 2' && h.pend === 0 && promptsOf().length === 0, 'Undo gives the words back and nothing reached the pane', JSON.stringify({ ...h, sent: promptsOf().length }));
    // Send now: out at once; the box and the batch empty; the pane gets one numbered message
    ev(`document.querySelector('.cmp .go').click(); return true;`); await sleep(400);
    ev(`document.querySelector('.cmp-row .alt').click(); return true;`);
    await until(`return { ok: document.querySelector('.cmp textarea').value === '' && document.querySelectorAll('.cmp-batch li').length === 0 };`, 'the box emptied');
    check(true, 'Send now empties the box and the batch at once');
    for (let i = 0; i < 80 && promptsOf().length === 0; i++) await sleep(250);
    const got = promptsOf();
    check(got.length === 1 && /^PROMPT lab w1:p1 2 comments:/.test(got[0]) && /1\. Re your reply at \d\d:\d\d \("Nathan, here are the calls/.test(got[0]) && /: go with R1/.test(got[0]) && /2\. and R2 too/.test(got[0]), 'the pane got one numbered message, as the conversation view sends a batch', JSON.stringify(got).slice(0, 400));
    await until(`return { ok: /Sent to lab-supervisor/.test(document.querySelector('.cmp-pending') ? document.querySelector('.cmp-pending').innerText : '') || /^Sent to/.test(document.querySelector('.cmp-why').textContent) };`, 'the sent note', 30000);
    check(true, 'the faded message says it was sent');
    // a reply from an earlier session than the one the box writes to is described by its words (that session never saw it)
    await openBoard(port, '&t=alpha-route');
    await until(`return { ok: !!document.querySelector('.sheet .cmp') && /To lab-supervisor/.test(document.querySelector('.cmp-why').textContent) };`, 'the box aimed at the live pane', 30000);
    ev(`[...document.querySelectorAll('.sheet .th-item.reply')][0].querySelector('.reply-to').click(); return true;`);
    check(/^\[From session 5e551001, an earlier session of this conversation\] Re your reply at \d\d:\d\d, which began: "Nathan, alpha-route/.test(ev(`return document.querySelector('.cmp-chip .cmp-line').textContent;`)), 'a reply from an earlier session is pointed at by its opening words, with the session it came from');
    // a send to a session the board does not read is refused by the route, and the reader's own checks stand
    const refused = await fetch(`http://127.0.0.1:${port}/api/transcript-reader/board-send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 'leader-lab', session_id: lab.sup, text: 'x' }) });
    check(refused.status === 403, 'a script without the page\'s token cannot post a send', String(refused.status));
    // layout at three widths: the box stays at the foot, inside the window, nothing scrolls sideways
    for (const [w, label] of [[1200, '1200 px'], [1440, '1440 px'], ['390x844x2,mobile,touch', '390 px']]) {
      await openBoard(port, '&t=delta-two-calls', typeof w === 'number' ? `${w}x900x1` : w);
      await until(`return { ok: !!document.querySelector('.sheet .cmp') };`, 'the box');
      const fit = ev(`const c = document.querySelector('.cmp').getBoundingClientRect(), s = document.querySelector('.sheet').getBoundingClientRect(), b = document.querySelector('.sh-body').getBoundingClientRect(); return { inside: c.bottom <= innerHeight + 1 && c.top >= 0, atFoot: Math.abs(c.bottom - s.bottom) < 2, readable: b.height > 120, side: document.documentElement.scrollWidth <= innerWidth, w: Math.round(c.width) };`);
      check(fit.inside && fit.atFoot && fit.readable && fit.side, `${label}: the box is at the foot of the card, inside the window, with room left to read`, JSON.stringify(fit));
      const folded = ev(`return document.querySelector('.cmp-body').hidden;`);
      check(folded === (typeof w !== 'number'), `${label}: the box ${typeof w === 'number' ? 'is open' : 'starts folded on a phone'}`, String(folded));
      if (typeof w !== 'number') {
        ev(`const r = [...document.querySelectorAll('.sheet .th-item.reply')][0]; r.querySelector('.reply-to').click(); return true;`);
        check(!ev(`return document.querySelector('.cmp-body').hidden;`) && !ev(`return document.querySelector('.cmp-chip').hidden;`), `${label}: Reply opens the folded box with its pointer`);
        const f2 = ev(`const c = document.querySelector('.cmp').getBoundingClientRect(), b = document.querySelector('.sh-body').getBoundingClientRect(); return { inside: c.bottom <= innerHeight + 1, room: Math.round(b.height), side: document.documentElement.scrollWidth <= innerWidth };`);
        check(f2.inside && f2.room > 100 && f2.side, `${label}: opened with a pointer there is still room to read the thread`, JSON.stringify(f2));
      }
    }
  } catch (error) {
    check(false, 'the run', String(error.message || error).slice(0, 300));
  }
  t.finish(stop);
})();
