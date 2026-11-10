#!/usr/bin/env node
'use strict';

// Reviewing a task on its card, in a real browser (chrome-devtools-axi), against review_lab.py: a scratch Firstmate home whose tasks are each in a state a
// review action must treat differently, and the reader's own api.js on a free port with a Herdr that is never there. Never the live reader, never a real home,
// task or pane. By hand, not part of `node --test` (it needs chrome-devtools-axi, Chrome and a Firstmate checkout with the backlog and ask commands):
//
//   node setup/transcript-reader/e2e/review-check.js [scratch folder]
//
// Round 1, the review flag off: the Review box is there, every button is off, and it says what turns it on. Round 2, the flag on: each action writes the
// scratch home's real record through Firstmate's own command (Delay -> a hold with a date -> Parked; Needs you; Queued from a hold; Done; Queued from Done;
// a follow-up with a due date -> a new card that says when it is due and which task it follows), a task a worker has, a branch that has not landed or a
// typed card waiting is refused with its reason, nothing scrolls sideways, and a phone's buttons are tap-sized, light and dark. Round 3 is the review round: a
// recorded outcome marks the task reviewed (a chip on its card, a count in the round line, a line in the reader's own board-rounds.json, never the backlog),
// Mark reviewed and Undo, the Not yet reviewed filter, a new round that asks first and forgets the marks, and the marks surviving a reload.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { make, freePort, sleep } = require('./axi');

const folder = fs.mkdtempSync(path.join(process.argv[2] ? path.resolve(process.argv[2]) : os.tmpdir(), 'reader-review-lab-'));
const repo = path.resolve(__dirname, '..', '..', '..');
const t = make('reader-review-check');
const { check, ev, until, axi } = t;

function startServer(lab, port, flags) {
  const out = fs.openSync(path.join(folder, `server-${port}.log`), 'a');
  const env = { ...process.env, PMOS_READER_BOARD_CONFIG: lab.config, PMOS_READER_BOARD_CACHE: lab.cache, PMOS_READER_BOARD_WORKERS: path.join(lab.conf, 'board-workers.json'),
    PMOS_READER_BOARD_ROUNDS: path.join(lab.conf, 'board-rounds.json'), LAB_OUT: lab.out, LAB_HIDDEN: lab.hidden };
  return spawn('node', [path.join(__dirname, 'board-lab-server.js'), repo, String(port), ...flags], { stdio: ['ignore', out, out], env });
}
async function waitUp(port) {
  let last = '';
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/setup/transcript-reader/board/`); if (r.ok || r.status === 403) return; last = 'HTTP ' + r.status; } catch (e) { last = e.message; } await sleep(200); }
  throw new Error('the lab server did not answer on ' + port + ': ' + last);
}
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA');  // YYYY-MM-DD in local time, as the board's own "today"
const cards = () => ev(`const m = {}; document.querySelectorAll('.card').forEach(c => { m[c.dataset.ref] = c.closest('.col').dataset.col; }); return m;`);
async function openBoard(port, hash = '', viewport = '1440x900x1') {
  axi('open', 'about:blank'); axi('emulate', '--viewport', viewport);
  axi('open', `http://127.0.0.1:${port}/setup/transcript-reader/board/?run=${Date.now()}#s=leader-lab${hash}`);
  await until(`return { ok: document.querySelectorAll('.card').length > 0 };`, 'the cards', 60000);
}
async function openTask(ref) {
  ev(`window.__board.jumpTo(${JSON.stringify(ref)}); return true;`);
  await until(`return { ok: !!document.querySelector('.sheet .rv') && document.querySelector('.sheet .sh-ref').textContent === ${JSON.stringify(ref)} };`, 'the sheet of ' + ref);
}
const btn = (act) => ev(`const b = document.querySelector('.sheet .rv-btn[data-act="${act}"]'); return b ? { off: b.disabled, tip: b.title, h: Math.round(b.getBoundingClientRect().height) } : null;`);
const press = (act) => ev(`document.querySelector('.sheet .rv-btn[data-act="${act}"]').click(); return true;`);
// Fill a box of the open form the way typing does (the page listens to input), then record.
const fill = (name, value) => ev(`const i = document.querySelector('.sheet .rv-form [name="${name}"]'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
const record = () => ev(`document.querySelector('.sheet .rv-form button[type="submit"]').click(); return true;`);
const rounds = (lab) => { try { return JSON.parse(fs.readFileSync(path.join(lab.conf, 'board-rounds.json'), 'utf8')).rounds['leader-lab'] || null; } catch (e) { return null; } };
const roundText = () => ev(`const r = document.getElementById('round'); return r.hidden ? '(hidden)' : r.innerText.replace(/\\s+/g, ' ');`);
const cardHas = (ref, what) => ev(`const c = document.querySelector('.card[data-ref="${ref}"]'); return !!c && [...c.querySelectorAll('.chip')].some(x => ${what});`);
const backlog = (lab) => fs.readFileSync(lab.backlog, 'utf8');
async function recorded(what, test) { await until(`const m = document.querySelector('.toast'); return { ok: !!m && ${test} };`, what, 30000); }
const edges = (label) => {
  const r = ev(`const s = document.querySelector('.sheet'), b = s.getBoundingClientRect(), rv = s.querySelector('.rv').getBoundingClientRect(); const over = [...s.querySelectorAll('.rv button, .rv input')].filter(x => { const r = x.getBoundingClientRect(); return r.right > b.right + 1 || r.left < b.left - 1; }).length; return { side: document.documentElement.scrollWidth <= innerWidth, over, inside: rv.right <= b.right + 1 && rv.left >= b.left - 1 };`);
  check(r.side && r.over === 0 && r.inside, `${label}: the Review box fits inside the card and nothing scrolls sideways`, JSON.stringify(r));
};

(async () => {
  let lab;
  try { lab = JSON.parse(execFileSync('python3', ['-I', path.join(__dirname, 'review_lab.py'), folder], { encoding: 'utf8', timeout: 240000 }).trim().split('\n').pop()); }
  catch (error) { process.stdout.write('SKIP  no lab (needs a Firstmate checkout with the backlog and ask commands)\n'); process.exit(0); }
  const servers = [];
  const stop = () => { servers.forEach((s) => s.kill()); try { axi('stop'); } catch (e) { /* not running */ } };
  try {
    // ---- round 1: the flag off
    let port = await freePort();
    servers.push(startServer(lab, port, [])); await waitUp(port);
    await openBoard(port);
    await openTask('rv-queued');
    check(['done', 'delay', 'needs', 'followup'].every((a) => btn(a) && btn(a).off) && btn('queue').off, 'review off: every button is there and off');
    check(/PMOS_READER_BOARD_REVIEW=1/.test(ev(`return document.querySelector('.sheet .rv .off-note').textContent;`)), 'and the box says what turns it on');
    check(/read only/.test(ev(`return document.getElementById('asof').textContent;`)), 'the page still says it is read only');
    check(roundText() === '(hidden)', 'review off, no round yet: there is no round line');
    servers.forEach((s) => s.kill()); servers.length = 0;

    // ---- round 2: the flag on
    port = await freePort();
    servers.push(startServer(lab, port, ['--review'])); await waitUp(port);
    await openBoard(port);
    check(/writes on: reviews/.test(ev(`return document.getElementById('asof').textContent;`)), 'the page says reviews are on');
    const start = cards();
    check(/No review round yet/.test(roundText()) && ev(`return !!document.getElementById('round-start');`), 'review on, no round yet: the round line says so and offers Start a round', roundText());
    check(start['rv-queued'] === 'queued' && start['rv-held'] === 'needs' && start['rv-card'] === 'needs', 'the lab opens as built', JSON.stringify(start));

    // what each task allows, and why not
    await openTask('rv-queued');
    check(btn('queue').off && /Already queued/.test(btn('queue').tip) && ['done', 'delay', 'needs', 'followup'].every((a) => !btn(a).off), 'a plain queued task: everything but Queued works');
    await openTask('rv-live');
    check(btn('done').off && btn('delay').off && btn('needs').off && /worker still has/.test(btn('done').tip) && !btn('followup').off, 'a task a worker has: Done, Delay and Needs you are off, with the reason, and a follow-up can still be added');
    check(/worker still has/.test(ev(`return document.querySelector('.sheet .rv-why').textContent;`)), 'and the reason is written under the buttons, not only in a tooltip');
    await openTask('rv-ready');
    check(btn('done').off && /not landed/.test(btn('done').tip), 'a branch that has not landed: Done is off and says to land it first');
    await openTask('rv-card');
    check(['done', 'queue', 'delay', 'needs'].every((a) => btn(a).off) && /open card/.test(btn('done').tip), 'a task with a typed card waiting: every move is off until the card is answered');
    await openTask('rv-finished');
    check(btn('done').off && /Already done/.test(btn('done').tip) && !btn('queue').off, 'a finished task: Done is "already done" and Queued reopens it');

    // Delay until a date
    await openTask('rv-queued'); press('delay');
    check(ev(`const g = document.querySelector('.sheet .rv-form button[type="submit"]'); return g.disabled;`), 'Delay: Record is off until a date is picked');
    const until3 = day(3);
    fill('until', day(-1));
    fill('until', until3); fill('note', 'wait for the vendor');
    check(/fm-captain-hold\.sh hold --until/.test(ev(`return document.querySelector('.sheet .rv-says').textContent;`)) && ev(`return document.querySelector('.sheet .rv-says').textContent;`).includes('(with your note)'), 'Delay: the box says which Firstmate command it will run, before anything runs');
    edges('1440 px');
    check(!/Delayed from the board review/.test(backlog(lab)), 'nothing is written before Record');
    record(); await recorded('the delay recorded', `/held until/.test(m.textContent)`);
    check(backlog(lab).includes(until3), 'Delay: the scratch home\'s backlog now holds the task until that date', until3);
    await until(`return { ok: document.querySelector('.card[data-ref="rv-queued"]') && document.querySelector('.card[data-ref="rv-queued"]').closest('.col').dataset.col === 'parked' };`, 'the card in Parked until a date');
    check(true, 'Delay: the card moved to Parked until a date');
    check(ev(`return !document.querySelector('.sheet .rv-form');`), 'and the form closed');
    check(rounds(lab) && rounds(lab).reviewed['rv-queued'] && rounds(lab).reviewed['rv-queued'].outcome === 'delay', 'Delay also marks the task reviewed, in the reader\'s own board-rounds.json', JSON.stringify(rounds(lab)));
    check(cardHas('rv-queued', `x.textContent === 'reviewed'`) && /started .* · 1 of \d+ open tasks reviewed/.test(roundText()), 'and a round started: the card says reviewed and the round line counts it', roundText());
    check(!/rv-queued[^\n]*reviewed/i.test(backlog(lab)), 'the mark is not written into the backlog');

    // Needs you (a held task goes back to waiting for the captain)
    await openTask('rv-queued'); press('needs'); record();
    await recorded('back in needs you', `/Needs you/.test(m.textContent)`);
    await until(`return { ok: document.querySelector('.card[data-ref="rv-queued"]').closest('.col').dataset.col === 'needs' };`, 'the card in Needs you');
    check(true, 'Needs you: the card moved to Needs you');

    // Queued from a captain hold (the keyed answer intake: release)
    await openTask('rv-queued'); press('queue');
    check(/answers \(release\)/.test(ev(`return document.querySelector('.sheet .rv-says').textContent;`)), 'Queued from a hold: it goes through the keyed answer intake and says so');
    record(); await recorded('queued', `/Queued/.test(m.textContent)`);
    await until(`return { ok: document.querySelector('.card[data-ref="rv-queued"]').closest('.col').dataset.col === 'queued' };`, 'the card in Queued');
    check(true, 'Queued: the card is back in Queued');

    // Done (a draft nobody is working on)
    await openTask('rv-draft'); press('done'); fill('note', 'read it, fine'); record();
    await recorded('done recorded', `/done/.test(m.textContent)`);
    await until(`const c = document.querySelector('.card[data-ref="rv-draft"]'); return { ok: !c || c.closest('.col').dataset.col === 'done' };`, 'the draft done');
    check(/- \[x\] rv-draft/.test(backlog(lab)), 'Done: the backlog marks the task done', backlog(lab).split('\n').find((l) => /rv-draft/.test(l)));

    // Queued from Done (reopen)
    await openTask('rv-finished'); press('queue'); record();
    await recorded('reopened', `/Queued/.test(m.textContent)`);
    await until(`return { ok: document.querySelector('.card[data-ref="rv-finished"]').closest('.col').dataset.col === 'queued' };`, 'the finished task back in Queued');
    check(/- \[ \] rv-finished/.test(backlog(lab)), 'Queued from Done: the backlog opens the task again');

    // Follow-up with a due date
    await openTask('rv-held'); press('followup');
    check(ev(`return document.querySelector('.sheet .rv-form button[type="submit"]').disabled;`), 'Follow-up: Record is off until it has a title');
    fill('title', 'Check the venue deposit'); fill('due', day(5)); fill('note', 'ask for the receipt');
    record(); await recorded('follow-up added and sent', `/Follow-up/.test(m.textContent) && /sent to Lab at \\d\\d:\\d\\d/.test(m.textContent)`);
    check(/Due by: /.test(backlog(lab)) && backlog(lab).includes('Follow-up of: rv-held') && backlog(lab).includes(day(5)), 'Follow-up: the new task carries its due date and the task it follows', backlog(lab).split('\n').filter((l) => /Check the venue/.test(l)).join(' | '));
    await until(`return { ok: [...document.querySelectorAll('.card')].some(c => /Check the venue deposit/.test(c.innerText)) };`, 'the follow-up card', 30000);
    const faces = ev(`const n = [...document.querySelectorAll('.card')].find(c => /Check the venue deposit/.test(c.innerText)); return n ? { col: n.closest('.col').dataset.col, due: [...n.querySelectorAll('.chip')].map(c => c.textContent), ref: n.dataset.ref } : null;`);
    check(faces && faces.col === 'queued' && faces.due.some((x) => /^due /.test(x)) && faces.due.some((x) => /follow-up of rv-held/.test(x)), 'Follow-up: a new card in Queued says when it is due and which task it follows', JSON.stringify(faces));
    check(ev(`const s = document.querySelector('.card[data-ref="rv-held"]'); return !!s;`), 'the task it follows is unchanged');

    // The home's firstmate is told: a durable note in the home's own inbox, one check wake, and the card says when
    const notes = () => { try { return fs.readdirSync(path.join(lab.home, 'state', 'inbox')).filter((f) => f.endsWith('.note')); } catch (e) { return []; } };
    const wakes = () => { try { return fs.readFileSync(path.join(lab.home, 'state', '.wake-queue'), 'utf8').split('\n').filter((l) => l.trim()); } catch (e) { return []; } };
    const noteText = notes().length ? fs.readFileSync(path.join(lab.home, 'state', 'inbox', notes()[0]), 'utf8') : '';
    check(notes().length === 1 && wakes().length === 1, 'Follow-up: one durable note in the home\'s inbox and one check wake', JSON.stringify({ notes: notes(), wakes: wakes().length }));
    check(faces && noteText.includes('Item: ' + faces.ref) && noteText.includes('Title: Check the venue deposit') && noteText.includes('Follow-up of: rv-held') && noteText.includes('Due by: ' + day(5)) && noteText.includes('Note: ask for the receipt'),
      'the note names the new item, its title, what it follows, the due date and your note', noteText.slice(0, 400));
    const sentLine = ev(`const e = document.querySelector('.sheet .rv-sent'); return e ? { text: e.textContent, bad: e.classList.contains('bad') } : null;`);
    check(sentLine && !sentLine.bad && /: Sent to Lab at \d\d:\d\d$/.test(sentLine.text), 'the card says "Sent to Lab at hh:mm"', JSON.stringify(sentLine));
    if (process.env.REVIEW_SHOTS) { fs.mkdirSync(process.env.REVIEW_SHOTS, { recursive: true }); ev(`document.querySelector('.sheet .rv-sent').scrollIntoView({ block: 'center' }); return true;`); axi('screenshot', path.join(process.env.REVIEW_SHOTS, 'followup-sent-1440.png')); }
    // A note that cannot be written leaves the item added and says so on the card (never silent)
    const inbox = path.join(lab.home, 'state', 'inbox');
    fs.chmodSync(inbox, 0o500);
    try {
      await openTask('rv-held'); press('followup');
      fill('title', 'Chase the hotel again');
      record(); await recorded('follow-up added', `/Follow-up/.test(m.textContent)`);
      await until(`return { ok: !!document.querySelector('.sheet .rv-sent.bad') };`, 'the warning on the card', 30000);
      const bad = ev(`return document.querySelector('.sheet .rv-sent').textContent;`);
      check(/Lab/.test(bad) && /(Not sent|not yet seen)/.test(bad) && backlog(lab).includes('Chase the hotel again'), 'a note that cannot be written: the item is added and the card says Lab was not told', bad);
    } finally { fs.chmodSync(inbox, 0o700); }

    // ---- round 3: the review round
    await openBoard(port);  // a reload: the marks come back from the reader's own file
    check(cardHas('rv-queued', `x.textContent === 'reviewed'`) && cardHas('rv-draft', `x.textContent === 'reviewed'`), 'after a reload the reviewed tasks are still reviewed');
    check(!cardHas('rv-live', `/reviewed/.test(x.textContent)`) && !cardHas('rv-card', `/reviewed/.test(x.textContent)`), 'and a task nobody reviewed has no chip');
    const before = backlog(lab);
    await openTask('rv-card');
    check(rounds(lab).reviewed['rv-card'] === undefined, 'opening a card does not mark it reviewed');
    ev(`document.querySelector('.sheet .rv-seen-btn').click(); return true;`);
    await until(`return { ok: !!document.querySelector('.card[data-ref="rv-card"] .chip.rvd') };`, 'the chip on the card');
    check(rounds(lab).reviewed['rv-card'].outcome === 'seen' && backlog(lab) === before, 'Mark reviewed marks it (outcome seen) and changes nothing on the task');
    check(/Reviewed .* · marked reviewed/.test(ev(`return document.querySelector('.sheet .rv-seen-t').textContent;`)), 'the card says when, and what you did');
    const n1 = (/(\d+) of (\d+) open/.exec(roundText()) || []).slice(1).map(Number);
    ev(`document.querySelector('.sheet .rv-seen [data-round="unmark"]').click(); return true;`);
    await until(`return { ok: !document.querySelector('.card[data-ref="rv-card"] .chip.rvd') };`, 'the chip gone');
    check(rounds(lab).reviewed['rv-card'] === undefined && (/(\d+) of/.exec(roundText()) || [])[1] === String(n1[0] - 1), 'Undo takes the mark off and the count drops', roundText());
    ev(`document.querySelector('.sheet .rv-seen-btn').click(); return true;`);
    await until(`return { ok: !!document.querySelector('.card[data-ref="rv-card"] .chip.rvd') };`, 'marked again');
    // the filter
    const total = ev(`return document.querySelectorAll('.card').length;`);
    ev(`window.__board.S.open = null; document.getElementById('layer').textContent = ''; document.getElementById('unreviewed').click(); return true;`);
    const left = ev(`return { cards: document.querySelectorAll('.card').length, rvd: document.querySelectorAll('.col:not([data-col="done"]) .card .chip.rvd').length, n: document.querySelector('#unreviewed .n').textContent, pressed: document.getElementById('unreviewed').getAttribute('aria-pressed') };`);
    check(left.pressed === 'true' && left.rvd === 0 && left.cards < total && String(left.cards) >= left.n, 'Not yet reviewed shows only the tasks without a mark (done ones stay)', JSON.stringify({ ...left, total }));
    ev(`document.getElementById('unreviewed').click(); return true;`);
    check(ev(`return document.querySelectorAll('.card').length;`) === total, 'and pressing it again shows every task');
    // a new round asks first, keeps the round on "Keep", forgets the marks on "Start"
    const marks0 = Object.keys(rounds(lab).reviewed).length;
    ev(`document.getElementById('round-start').click(); return true;`);
    check(new RegExp('Forget ' + marks0 + ' marks? and start over').test(roundText()), 'Start a new round asks first and says how many marks it forgets', roundText());
    ev(`[...document.querySelectorAll('#round button')].find(b => /Keep this round/.test(b.textContent)).click(); return true;`);
    check(Object.keys(rounds(lab).reviewed).length === marks0 && ev(`return !!document.getElementById('round-start');`), 'Keep this round changes nothing');
    const oldId = rounds(lab).id;
    await sleep(1100);
    ev(`document.getElementById('round-start').click(); document.getElementById('round-yes').click(); return true;`);
    await until(`return { ok: /0 of [0-9]+ open/.test(document.getElementById('round').innerText) };`, 'the new round');
    check(rounds(lab).id !== oldId && Object.keys(rounds(lab).reviewed).length === 0 && ev(`return document.querySelectorAll('.card .chip.rvd').length;`) === 0, 'a new round forgets the marks and starts again at none', JSON.stringify(rounds(lab)));
    // the task changed after you reviewed it: the chip says so
    await openTask('rv-live'); ev(`document.querySelector('.sheet .rv-seen-btn').click(); return true;`);
    await until(`return { ok: !!document.querySelector('.card[data-ref="rv-live"] .chip.rvd') };`, 'rv-live reviewed');
    fs.appendFileSync(path.join(lab.home, 'state', 'rv-live.status'), `working [at=${Math.floor(Date.now() / 1000) + 120}]: more work after the review\n`);
    ev(`document.getElementById('refresh').click(); return true;`);
    await until(`return { ok: [...document.querySelectorAll('.card[data-ref="rv-live"] .chip.rvd.changed')].length === 1 };`, 'the changed chip', 40000);
    check(/changed since/.test(ev(`return document.querySelector('.card[data-ref="rv-live"] .chip.rvd').textContent;`)), 'a task that changed after you reviewed it says "reviewed · changed since", and the filter shows it again');
    // the phone: tap-sized buttons and a form that fits, light and dark
    await openBoard(port, '', '390x844x2,mobile,touch');
    await openTask('rv-queued'); press('followup');
    const phone = ev(`const bs = [...document.querySelectorAll('.sheet .rv-btn')].map(b => Math.round(b.getBoundingClientRect().height)), is = [...document.querySelectorAll('.sheet .rv-form input')].map(i => Math.round(i.getBoundingClientRect().height)); return { bs: Math.min(...bs), is: Math.min(...is), fs: getComputedStyle(document.querySelector('.sheet .rv-form input')).fontSize };`);
    check(phone.bs >= 44 && phone.is >= 44 && phone.fs === '16px', 'phone: buttons and boxes are at least 44 px tall and the text is 16 px (no zoom on focus)', JSON.stringify(phone));
    edges('390 px');
    const rl = ev(`const r = document.getElementById('round').getBoundingClientRect(), bs = [...document.querySelectorAll('#round button')].map(b => Math.round(b.getBoundingClientRect().height)); return { side: document.documentElement.scrollWidth <= innerWidth, inside: r.right <= innerWidth + 1 && r.left >= -1, bs: Math.min(...bs) };`);
    check(rl.side && rl.inside && rl.bs >= 44, 'phone: the round line fits the width and its buttons are tap-sized', JSON.stringify(rl));
    for (const scheme of ['light', 'dark']) {
      axi('emulate', '--color-scheme', scheme); await sleep(300);
      if (!ev(`return !!document.querySelector('.sheet .rv-form input');`)) { await openTask('rv-queued'); press('followup'); }
      const look = ev(`const rv = document.querySelector('.sheet .rv'), b = document.querySelector('.sheet .rv-btn[aria-pressed="true"]'), x = getComputedStyle(rv); return { bg: x.backgroundColor, border: x.borderTopColor, pressed: b ? getComputedStyle(b).color : null, ink: getComputedStyle(document.querySelector('.sheet .rv-form input')).color };`);
      check(look.bg !== 'rgba(0, 0, 0, 0)' && look.pressed && look.pressed !== look.bg && look.ink !== look.bg, `phone, ${scheme}: the Review box has its own background and readable text`, JSON.stringify(look));
    }
    axi('emulate', '--color-scheme', 'light');
    // the line that says whether the home was told: the long warning wraps inside the card, and both colours read in light and dark, on a phone
    const shots = process.env.REVIEW_SHOTS;
    for (const scheme of ['light', 'dark']) {
      axi('emulate', '--color-scheme', scheme); await sleep(300);
      ev(`window.__board.S.rvSent = { ref: 'rv-queued', item: 'check-the-venue-deposit-66', ok: false, text: 'Not sent to Lab. The follow-up is in its backlog, but its inbox did not take the note, so nothing woke it. Mention it in that session.' }; return true;`);
      await openTask('rv-queued');
      ev(`window.__lum = (c) => { const [r, g, b] = c.match(/[0-9.]+/g).slice(0, 3).map((v) => { v = Number(v) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }; return true;`);
      const sl = ev(`const e = document.querySelector('.sheet .rv-sent'); if (!e) return null; const sh = document.querySelector('.sheet'); let n = e, bg = 'rgba(0, 0, 0, 0)'; while (n && /rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) { bg = getComputedStyle(n).backgroundColor; n = n.parentElement; } const a = window.__lum(getComputedStyle(e).color), c = window.__lum(bg), r = e.getBoundingClientRect(), q = sh.getBoundingClientRect(); return { ratio: Math.round((Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05) * 10) / 10, inside: r.right <= q.right + 1 && r.left >= q.left - 1, side: document.documentElement.scrollWidth <= innerWidth };`);
      check(sl && sl.ratio >= 4.5 && sl.inside && sl.side, `phone, ${scheme}: the "not told" line wraps inside the card and reads (contrast 4.5 or more)`, JSON.stringify(sl));
      edges(`390 px, ${scheme}, with the line`);
      if (shots) { fs.mkdirSync(shots, { recursive: true }); ev(`document.querySelector('.sheet .rv-sent').scrollIntoView({ block: 'center' }); return true;`); axi('screenshot', path.join(shots, `followup-not-told-phone-${scheme}.png`)); }
    }
    axi('emulate', '--color-scheme', 'light');
    for (const scheme of ['light', 'dark']) {
      await openBoard(port, '', '1440x900x1'); axi('emulate', '--color-scheme', scheme);
      await openTask('rv-held'); press('delay'); fill('until', day(2)); await sleep(200);
      edges(`1440 px, ${scheme}`);
    }
    axi('emulate', '--color-scheme', 'light');
  } catch (error) {
    check(false, 'the run', String(error.message || error).slice(-600));
  }
  t.finish(stop);
})();
