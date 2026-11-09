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
// typed card waiting is refused with its reason, nothing scrolls sideways, and a phone's buttons are tap-sized, light and dark.

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
    servers.forEach((s) => s.kill()); servers.length = 0;

    // ---- round 2: the flag on
    port = await freePort();
    servers.push(startServer(lab, port, ['--review'])); await waitUp(port);
    await openBoard(port);
    check(/writes on: reviews/.test(ev(`return document.getElementById('asof').textContent;`)), 'the page says reviews are on');
    const start = cards();
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
    record(); await recorded('follow-up added', `/Follow-up/.test(m.textContent)`);
    check(/Due by: /.test(backlog(lab)) && backlog(lab).includes('Follow-up of: rv-held') && backlog(lab).includes(day(5)), 'Follow-up: the new task carries its due date and the task it follows', backlog(lab).split('\n').filter((l) => /Check the venue/.test(l)).join(' | '));
    await until(`return { ok: [...document.querySelectorAll('.card')].some(c => /Check the venue deposit/.test(c.innerText)) };`, 'the follow-up card', 30000);
    const faces = ev(`const n = [...document.querySelectorAll('.card')].find(c => /Check the venue deposit/.test(c.innerText)); return n ? { col: n.closest('.col').dataset.col, due: [...n.querySelectorAll('.chip')].map(c => c.textContent), ref: n.dataset.ref } : null;`);
    check(faces && faces.col === 'queued' && faces.due.some((x) => /^due /.test(x)) && faces.due.some((x) => /follow-up of rv-held/.test(x)), 'Follow-up: a new card in Queued says when it is due and which task it follows', JSON.stringify(faces));
    check(ev(`const s = document.querySelector('.card[data-ref="rv-held"]'); return !!s;`), 'the task it follows is unchanged');

    // the phone: tap-sized buttons and a form that fits, light and dark
    await openBoard(port, '', '390x844x2,mobile,touch');
    await openTask('rv-queued'); press('followup');
    const phone = ev(`const bs = [...document.querySelectorAll('.sheet .rv-btn')].map(b => Math.round(b.getBoundingClientRect().height)), is = [...document.querySelectorAll('.sheet .rv-form input')].map(i => Math.round(i.getBoundingClientRect().height)); return { bs: Math.min(...bs), is: Math.min(...is), fs: getComputedStyle(document.querySelector('.sheet .rv-form input')).fontSize };`);
    check(phone.bs >= 44 && phone.is >= 44 && phone.fs === '16px', 'phone: buttons and boxes are at least 44 px tall and the text is 16 px (no zoom on focus)', JSON.stringify(phone));
    edges('390 px');
    for (const scheme of ['light', 'dark']) {
      axi('emulate', '--color-scheme', scheme); await sleep(300);
      if (!ev(`return !!document.querySelector('.sheet .rv-form input');`)) { await openTask('rv-queued'); press('followup'); }
      const look = ev(`const rv = document.querySelector('.sheet .rv'), b = document.querySelector('.sheet .rv-btn[aria-pressed="true"]'), x = getComputedStyle(rv); return { bg: x.backgroundColor, border: x.borderTopColor, pressed: b ? getComputedStyle(b).color : null, ink: getComputedStyle(document.querySelector('.sheet .rv-form input')).color };`);
      check(look.bg !== 'rgba(0, 0, 0, 0)' && look.pressed && look.pressed !== look.bg && look.ink !== look.bg, `phone, ${scheme}: the Review box has its own background and readable text`, JSON.stringify(look));
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
