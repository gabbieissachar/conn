#!/usr/bin/env node
'use strict';

// The turn menu of a leader's conversation (change a turn's tasks, "add this message to a task"), in a real browser (chrome-devtools-axi), against a lab copy of the reader on
// its own port with a fake Herdr, the pane lab's leader conversation (LAB_LEADER=1: 38 turns, thirteen made-up tasks) and a stand-in for Firstmate's reply-mark command
// (mark_lab.py) that writes the real line to a made-up home. Never the live reader, a real home, store or pane. By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/task-mark-check.js <scratch folder> [screenshots folder]
//
// It checks, on the reader page (out/prototype.html) and the lite page a Conn Watch column shows (out/live/index.html), with real clicks:
//   * what the build carries (a key on each turn, the board that owns the home, archive-only tasks flagged) and what the page offers: the chip's menu and a "+ Task" pill on a
//     turn with no task, only where the server says marks can be written (flag off: the chip is as it was; the phone's answer is tested in tailnet.test.js);
//   * add, "Not this task", Remove and Undo: the line each writes (the right turn key, the side the tag sits on, source reader), the tag shown at once, the build's answer
//     replacing it, a refused write shown and taken back, two quick marks, the picker (this conversation's tasks, open ones, finished ones on a find, an archived one never);
//   * the shape at 1440, 1030, 820 and 819 px and the Watch widths 330, 360, 390, 440 and 480 px, light and dark: a popover from 820 px, a bottom sheet below it, inside the
//     window, no sideways scroll, 44 px controls on a narrow window, Esc and a click outside close it, the focus goes back to the chip.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { make, freePort } = require('./axi');
const { spawn, execFileSync } = require('child_process');

const folder = fs.mkdtempSync(path.join(process.argv[2] ? path.resolve(process.argv[2]) : os.tmpdir(), 'reader-task-mark-lab-'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, check, openPage, pick, finish, sleep, until } = make('reader-task-mark-check');
const CREW1 = 'c4e70000-0001-4000-8000-000000000001';

const HELPERS = [
  `window.M = { q: s => document.querySelector(s), qa: s => [...document.querySelectorAll(s)], box: n => { const r = n && n.getBoundingClientRect(); return r ? { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } : null; } }; return true;`,
  `M.menu = () => { const m = M.q('#turnmenu'); return { shown: !m.hidden, box: m.hidden ? null : M.box(m), role: m.getAttribute('role'), modal: m.getAttribute('aria-modal'), pos: getComputedStyle(m).position, scrim: !M.q('#turn-scrim').hidden, vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth, active: (document.activeElement && (document.activeElement.dataset.focus || document.activeElement.className)) || '' }; }; return true;`,
  `M.rows = () => M.qa('#turnmenu .trow.have').map(r => ({ name: r.querySelector('.tt').textContent, sub: r.querySelector('.ts').textContent, act: r.querySelector('.btn').textContent })); M.picks = () => M.qa('#turnmenu .trow.pick').map(r => r.dataset.task); M.groups = () => M.qa('#turnmenu .tm-picks .tgroup').map(g => g.textContent); return true;`,
  `M.turns = () => M.qa('#main > [id^=ex-]'); M.chip = uid => document.querySelector('.task-chip[data-uid="' + uid + '"]'); M.toast = () => { const t = M.q('#undo-toast'); return t && !t.hidden ? t.textContent : ''; }; return true;`,
];
const helpers = () => HELPERS.forEach((expression) => ev(expression));

let outDir, home, bin, servers = [];
const exchanges = (sid = CREW1) => JSON.parse(fs.readFileSync(path.join(outDir, 'live', 's', `${sid}.json`), 'utf8'));
const marksFile = (task) => { try { return fs.readFileSync(path.join(home, 'data', task, 'reply-marks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
const calls = () => { try { return fs.readFileSync(path.join(bin, 'calls.log'), 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };
const setDelay = (seconds) => fs.writeFileSync(path.join(bin, 'delay'), String(seconds));
const keyOf = (ex, part) => `${ex.mk}:${ex.uid.slice(0, 8)}:${part}`;
const turnWhere = (test) => exchanges().exchanges.findIndex(test);

function startServer(lab, markLab, port, flags) {
  const out = fs.openSync(path.join(folder, `server-${port}.log`), 'a');
  const env = { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH, PMOS_READER_BOARD_CONFIG: markLab.config, PMOS_READER_BOARD_CACHE: markLab.cache, PMOS_READER_BOARD_WORKERS: path.join(markLab.conf, 'board-workers.json'), ...flags };
  const child = spawn('node', [path.join(lab.repo, 'setup', 'transcript-reader', 'server.js'), '--port', String(port), '--root', lab.repo], { stdio: ['ignore', out, out], env });
  servers.push(child);
  return child;
}
async function waitUp(port) {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://localhost:${port}/setup/transcript-reader/out/prototype.html`); if (r.ok || r.status === 403) return; } catch (e) { /* not up */ } await sleep(250); }
  throw new Error('the lab server did not answer on ' + port);
}
function wipe(page) {
  axi('open', 'about:blank'); axi('open', page.replace(/\/setup\/.*$/, '/no-such-page'));
  ev(`localStorage.removeItem('tr-tasks'); localStorage.removeItem('tr-task-rail'); sessionStorage.clear(); return true;`);
}
async function openReader(page, viewport, scheme) {
  wipe(page);
  await openPage(page, viewport);
  if (scheme) { axi('emulate', '--viewport', viewport, '--color-scheme', scheme); await sleep(400); }
  pick('crew-1'); await sleep(1200);
  ev(`localStorage.setItem('tr-task-rail', '0'); return true;`);
  helpers();
  await until(`return { ok: !!document.querySelector('.task-chip[data-uid]') };`, 'the chips to offer the turn menu', 20000);
}
async function openLite(port, viewport, scheme) {
  const url = `http://localhost:${port}/setup/transcript-reader/out/live/index.html#s=${CREW1}`;
  wipe(url);
  axi('emulate', '--viewport', viewport, ...(scheme ? ['--color-scheme', scheme] : []));
  axi('open', url);
  await until(`return { ok: document.getElementById('main').children.length > 5 };`, 'the lite page');
  await sleep(900);
  ev(`localStorage.setItem('tr-task-rail', '0'); return true;`);
  helpers();
  await until(`return { ok: !!document.querySelector('.task-chip[data-uid]') };`, 'the chips to offer the turn menu (lite page)', 20000);
}
const consoleClean = (what) => {
  const said = axi('console', '--type', 'error');
  const errors = said.split('\n').filter((l) => /\[error\]/.test(l));
  check(errors.length === 0 && /<no console messages found>/.test(said), `${what} logged no errors`, errors.slice(0, 4).join(' | '));
};


// A real click (the browser's own, at the middle of the control) on the element a short expression names: its place among the snapshot's buttons of the same name.
const snapLines = () => axi('snapshot', '--full').split('\n');
function again(work) {  // the page draws itself again between the snapshot and the action now and then: take the snapshot once more
  for (let attempt = 1; ; attempt++) {
    try { return work(); } catch (error) { if (attempt >= 4 || !/STALE_REF/.test(error.message)) throw error; }
  }
}
function realClick(selector, n = 0) { return again(() => realClickOnce(selector, n)); }
function realClickOnce(selector, n) {
  const info = ev(`const el = M.qa('${selector}')[${n}]; if (!el) return null; el.scrollIntoView({ block: 'center' }); const nm = b => b.getAttribute('aria-label') || b.textContent.trim().replace(/\\s+/g, ' '); const name = nm(el); return { name, rank: M.qa('button').filter(b => b.getClientRects().length > 0 && nm(b) === name).indexOf(el) };`);
  if (!info) throw new Error(`no ${selector} number ${n}`);
  const hits = snapLines().filter((l) => l.includes(`button "${info.name}"`));
  const line = hits[info.rank];
  if (!line) throw new Error(`no snapshot button "${info.name}" number ${info.rank} (${hits.length} found)`);
  axi('click', '@' + line.match(/uid=(\S+)/)[1]);
  return info.name;
}
function realType(label, text) { return again(() => realTypeOnce(label, text)); }
function realTypeOnce(label, text) {
  const line = snapLines().find((l) => l.includes(`"${label}"`) && /searchbox|textbox|combobox/.test(l));
  if (!line) throw new Error(`no field "${label}" among: ${snapLines().filter((l) => /Find|search|box/i.test(l)).slice(0, 6).join(' || ')}`);
  axi('fill', '@' + line.match(/uid=(\S+)/)[1], text);
}
// The conversation's data in the build, and the chip or pill the page draws for a turn (found by the turn's own id).
const where = (test) => { const found = turnWhere(test); if (found < 0) throw new Error('no such turn in the build'); return found; };
const byUid = (uid) => exchanges().exchanges.findIndex((e) => e.uid === uid);
const chipOf = (uid) => ev(`const c = M.chip('${uid}'); return c ? { cls: c.className, text: c.textContent, title: c.title } : null;`);
const isPill = (uid) => { const c = chipOf(uid); return Boolean(c && /task-chip add/.test(c.cls)); };
const isChip = (uid) => { const c = chipOf(uid); return Boolean(c && !/ add/.test(c.cls)); };
const tagsIn = (uid) => (exchanges().exchanges[byUid(uid)].tags || []).map((t) => t[0]);
const buildHas = async (uid, task, present = true) => { const end = Date.now() + 25000; while (Date.now() < end) { if (tagsIn(uid).includes(task) === present) return true; await sleep(300); } return false; };
const firstPill = () => ev(`const p = M.q('.task-chip.add:not(.quiet)'); return p && p.dataset.uid;`);
const pillUids = (n) => ev(`return M.qa('.task-chip.add:not(.quiet)').slice(0, ${n}).map(p => p.dataset.uid);`);
const ratio = (a, b) => { const lum = (c) => { const [r, g, bl] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; }; const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const realHover = (selector, n = 0) => again(() => realHoverOnce(selector, n));
const realHoverOnce = (selector, n) => {
  const info = ev(`const el = M.qa('${selector}')[${n}]; if (!el) return null; el.scrollIntoView({ block: 'center' }); const nm = b => b.getAttribute('aria-label') || b.textContent.trim().replace(/\\s+/g, ' '); const name = nm(el); return { name, rank: M.qa('button').filter(b => b.getClientRects().length > 0 && nm(b) === name).indexOf(el) };`);
  const line = snapLines().filter((l) => l.includes(`button "${info.name}"`))[info.rank];
  axi('hover', '@' + line.match(/uid=(\S+)/)[1]);
};

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  for (let i = 0; i < 4; i++) { try { axi('open', 'about:blank'); break; } catch (e) { await sleep(2500); } }  // the first call after the last run's stop can find the bridge recycling
  process.env.LAB_LEADER = '1';
  const lab = JSON.parse(execFileSync('python3', [path.join(__dirname, 'pane_lab.py'), path.join(folder, 'lab')], { encoding: 'utf8', timeout: 180000 }).trim().split('\n').pop());
  const markLab = JSON.parse(execFileSync('python3', ['-I', path.join(__dirname, 'mark_lab.py'), path.join(folder, 'marks'), lab.home], { encoding: 'utf8', timeout: 60000 }).trim().split('\n').pop());
  home = markLab.home; bin = path.join(markLab.fm, 'bin');
  outDir = path.join(lab.repo, 'setup', 'transcript-reader', 'out');
  // Two tasks the conversation never names: one open (the picker's "Other open tasks") and one finished (offered only to a find that matches it).
  const backlogFile = path.join(home, 'data', 'backlog.md');
  fs.writeFileSync(backlogFile, fs.readFileSync(backlogFile, 'utf8').replace('## Queued\n', '## Queued\n- [ ] untouched-queued-one - A queued task nobody has talked about (repo: pmos)\n') + '- [x] untouched-finished-one - A finished task nobody has talked about (repo: pmos)\n');
  // The pane lab built its page without the board config: build again with it, as the reader's own server will.
  execFileSync('python3', [path.join(lab.repo, 'setup', 'transcript-reader', 'reader.py'), 'rebuild'], { cwd: lab.repo, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH, PMOS_READER_BOARD_CONFIG: markLab.config } });
  const stop = () => { for (const s of servers) s.kill(); for (const pid of Object.values(lab.pids)) { try { process.kill(pid); } catch (e) { /* gone */ } } try { axi('stop'); } catch (e) { /* not running */ } };
  const log = path.join(lab.home, '.claude', 'projects', '-lab-crew-1', `${CREW1}.jsonl`);
  try {
    const port = await freePort();
    startServer(lab, markLab, port, { PMOS_READER_BOARD: '1', PMOS_READER_BOARD_MARKS: '1' });
    await waitUp(port);
    const page = `http://localhost:${port}/setup/transcript-reader/out/prototype.html`;
    const lite = `http://localhost:${port}/setup/transcript-reader/out/live/index.html#s=${CREW1}`;
    process.stdout.write(`lab ${folder} port ${port}\n`);

    // ---- 0. what the build carries
    const built = exchanges();
    const turns = built.exchanges.filter((e) => e.source !== 'session');
    check(built.leader && built.leader.board === 'leader-lab', 'the leader\'s conversation names the board that owns its home', JSON.stringify(built.leader && built.leader.board));
    check(turns.length > 30 && turns.every((e) => /^[0-9a-f]{8}$/.test(e.mk || '')), 'every turn carries the first eight characters of its own log\'s session id');
    check(built.leader.tasks['ancient-archived-task'] && built.leader.tasks['ancient-archived-task'].archived === true && !built.leader.tasks['bc-39-specs-task'].archived, 'a task only the archive remembers is flagged, one the backlog holds is not');
    const iBoth = where((e) => (e.tags || []).length === 1 && e.tags[0][0] === 'ab-12-alpha-copy');
    const uidBoth = built.exchanges[iBoth].uid;
    check((built.exchanges[iBoth].tag_sides || [])[0] === 'rm', 'a tag the words of both your message and the reply made sits on both sides', JSON.stringify(built.exchanges[iBoth].tag_sides));

    // ---- 1. the reader page at 1440 px: the chip and the pill, and what a click opens
    await openReader(page, '1440x900x1', 'light');
    const uidNone = firstPill();
    let c = chipOf(uidNone);
    check(c && /task-chip add/.test(c.cls) && c.text === '+ Task' && exchanges().exchanges[byUid(uidNone)].tag_row === 'none', 'a turn with no task has a "+ Task" pill in its header', JSON.stringify(c));
    c = chipOf(uidBoth);
    check(c && !/ add/.test(c.cls) && c.text.includes('AB-12 alpha copy') && ev(`return M.chip('${uidBoth}').getAttribute('aria-haspopup');`) === 'dialog', 'a tagged turn keeps its chip, which now opens the tasks of the turn');
    // Fleet upkeep turns are folded wake-ups: show them, the pill is there but quiet until the pointer is over the turn or it has focus (a desktop; a touch screen never shows it)
    ev(`const b = M.qa('button').find(n => n.textContent.trim() === 'Wake-ups'); b.click(); return !!b;`); await sleep(800);
    const quiet = ev(`const q = M.q('.task-chip.add.quiet'); return q ? { opacity: getComputedStyle(q).opacity, uid: q.dataset.uid } : null;`);
    check(quiet && quiet.opacity === '0', 'a Fleet upkeep turn has its pill hidden until the pointer is over it or it has focus', JSON.stringify(quiet));
    realHover('.task-chip.add.quiet', 0); await sleep(300);
    check(Boolean(await until(`return { ok: getComputedStyle(M.q('.task-chip.add.quiet')).opacity === '1' };`, 'the pill to show under the pointer', 4000).catch(() => false)), 'with the pointer over the turn the pill shows');
    ev(`const b = M.qa('button').find(n => n.textContent.trim() === 'Wake-ups'); b.click(); return true;`); await sleep(500);
    realClick('.task-chip.add:not(.quiet)', 0);
    await sleep(500);
    helpers();
    let m = ev(`return M.menu();`);
    const pillBox = ev(`return M.box(M.q('.task-chip[aria-expanded=true]'));`);
    check(m.shown && m.role === 'dialog' && m.pos === 'absolute' && m.modal === 'false' && !m.scrim && m.box.w === 352, 'a click on the pill opens a 352 px popover (no scrim, not modal) at 1440 px', JSON.stringify(m));
    check(m.box.y >= pillBox.b && m.box.x >= 0 && m.box.r <= m.vw && m.box.b <= m.vh, 'the popover sits under the pill and inside the window', JSON.stringify({ menu: m.box, pill: pillBox, vw: m.vw, vh: m.vh }));
    check(m.active === 'f', 'the find box has the focus on a desktop, so typing finds a task at once', m.active);
    check(ev(`return M.rows().length;`) === 0 && /no task/.test(ev(`return M.q('#turnmenu .tm-list .tgroup').textContent;`)), 'a turn with no task says so and lists none');
    const picks = ev(`return M.picks();`), groups = ev(`return M.groups();`);
    check(groups.join() === 'In this conversation,Other open tasks' && picks.length >= 10 && picks[picks.length - 1] === 'untouched-queued-one' && !picks.includes('untouched-finished-one'), 'the picker lists this conversation\'s tasks, then the other open ones, and not a finished task nobody has touched', JSON.stringify({ groups, picks }));
    check(!picks.includes('ancient-archived-task') && picks.includes('old-archived-task'), 'a task only the archive knows is never offered, a finished one the backlog still holds is (it is in this conversation)');
    realType('Find a task to add this turn to', 'archived'); await sleep(400);
    check(JSON.stringify(ev(`return M.picks();`)) === '["old-archived-task"]', 'the find box narrows the list by words of a task\'s name, id or state', JSON.stringify(ev(`return M.picks();`)));
    realType('Find a task to add this turn to', 'nobody finished'); await sleep(400);
    check(JSON.stringify(ev(`return M.picks();`)) === '["untouched-finished-one"]' && ev(`return M.groups().join();`) === 'Finished', 'a finished task nobody has touched is offered only to a find that matches it', JSON.stringify(ev(`return M.picks();`)));
    realType('Find a task to add this turn to', 'zzzz'); await sleep(300);
    check(ev(`return /No open task matches/.test(M.q('#turnmenu .tm-none').textContent);`), 'a find with no match says so');
    ev(`const i = M.q('#turnmenu .tm-find input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`); await sleep(300);
    axi('screenshot', path.join(shots, 'popover-pill-1440-light.png'));

    // ---- 2. add: shown at once, written once on the reply, confirmed by the build, removed, undone
    setDelay(2.5);
    const before = calls().length;
    const turnKey = keyOf(exchanges().exchanges[byUid(uidNone)], 'reply');
    realClick('#turnmenu .trow.pick[data-task="reader-task-tags-build"]');
    const t0 = Date.now();
    await until(`return { ok: !!M.chip('${uidNone}') && !/add/.test(M.chip('${uidNone}').className) };`, 'the chip to show at once', 3000);
    check(Date.now() - t0 < 2000 && ev(`return M.menu().shown === false;`), 'the new tag shows before the command has finished, and the menu has closed', `${Date.now() - t0} ms`);
    check(/Saving/.test(ev(`return M.toast();`)), 'the toast says it is saving while the command runs', ev(`return M.toast();`));
    await until(`return { ok: /Added to Task tags in the reader/.test(M.toast()) };`, 'the toast to say it is added', 8000);
    const lines = calls().slice(before);
    check(lines.length === 1 && lines[0] === `reader-task-tags-build in ${turnKey} reader`, 'one mark was filed, on the reply, from "reader"', JSON.stringify(lines));
    const file = marksFile('reader-task-tags-build').filter((l) => l.turn === turnKey);
    check(file.length === 1 && file[0].mark === 'in' && file[0].by === 'reader', 'the task\'s own record has the line', JSON.stringify(file));
    check(ev(`return !!M.q('#undo-toast button');`), 'the toast has an Undo');
    check(await buildHas(uidNone, 'reader-task-tags-build'), 'the next build carries the tag (the page asked for it 1.5 s after the mark)', JSON.stringify(tagsIn(uidNone)));
    await sleep(2500);
    c = chipOf(uidNone);
    check(c && c.text.includes('Task tags in the reader') && /you marked it/.test(c.title), 'the chip stays when the build\'s answer replaces what was shown, now from the file ("you marked it")', JSON.stringify(c));
    axi('screenshot', path.join(shots, 'added-1440-light.png'));
    realClick(`#main .task-chip[data-uid="${uidNone}"]`);
    await sleep(500); helpers();
    let rows = ev(`return M.rows();`);
    check(rows.length === 1 && rows[0].act === 'Remove' && /you marked it/.test(rows[0].sub), 'a tag you made offers Remove', JSON.stringify(rows));
    axi('screenshot', path.join(shots, 'popover-tag-1440-light.png'));
    realClick('#turnmenu .trow.have .btn');
    await until(`return { ok: !!M.chip('${uidNone}') && /add/.test(M.chip('${uidNone}').className) };`, 'the pill to come back', 4000);
    await until(`return { ok: /Taken off/.test(M.toast()) };`, 'the toast to say it is taken off', 8000);
    check(calls().slice(before).length === 2, 'Remove brings the pill back at once and files a clear');
    realClick('#undo-toast button');
    await until(`return { ok: !!M.chip('${uidNone}') && !/add/.test(M.chip('${uidNone}').className) };`, 'Undo to put the tag back', 4000);
    await sleep(2500);
    const afterUndo = calls().slice(before);
    check(afterUndo.map((l) => l.split(' ')[1]).join() === 'in,clear,in' && afterUndo.every((l) => l.includes(turnKey)), 'Undo of a Remove puts the mark back (in, clear, in on the same turn key)', JSON.stringify(afterUndo));
    check(await buildHas(uidNone, 'reader-task-tags-build'), 'and the build agrees');
    realClick(`#main .task-chip[data-uid="${uidNone}"]`); await sleep(400); realClick('#turnmenu .trow.have .btn');
    check(await buildHas(uidNone, 'reader-task-tags-build', false), 'removed again, the build has no tag on the turn');
    setDelay(0);

    // ---- 3. Not this task on a tag your message and the reply both made: an out on each side; Undo clears both
    const k0 = calls().length;
    realClick(`#main .task-chip[data-uid="${uidBoth}"]`); await sleep(500); helpers();
    rows = ev(`return M.rows();`);
    check(rows.length === 1 && rows[0].act === 'Not this task' && /the words name it/.test(rows[0].sub), 'a tag the rules made offers Not this task, with why it is there', JSON.stringify(rows));
    realClick('#turnmenu .trow.have .btn');
    await until(`return { ok: !!M.chip('${uidBoth}') && /add/.test(M.chip('${uidBoth}').className) };`, 'the tag to go at once', 4000);
    await until(`return { ok: /Taken off/.test(M.toast()) };`, 'the toast', 8000);
    const outs = calls().slice(k0);
    const base = keyOf(exchanges().exchanges[iBoth], '');
    check(outs.length === 2 && outs.some((l) => l === `ab-12-alpha-copy out ${base}reply reader`) && outs.some((l) => l === `ab-12-alpha-copy out ${base}in reader`), 'an out on the reply and one on your message, so the tag really goes', JSON.stringify(outs));
    check(await buildHas(uidBoth, 'ab-12-alpha-copy', false), 'the build agrees: the turn has no tag');
    realClick('#undo-toast button');
    await until(`return { ok: !!M.chip('${uidBoth}') && !/add/.test(M.chip('${uidBoth}').className) };`, 'Undo to bring it back', 4000);
    await sleep(2500);
    const undone = calls().slice(k0 + 2);
    check(undone.length === 2 && undone.every((l) => l.includes(' clear ')) && await buildHas(uidBoth, 'ab-12-alpha-copy'), 'Undo clears both, and the rules\' tag is back in the build', JSON.stringify(undone));

    // ---- 4. a refused write is shown and taken back
    const backlog = path.join(home, 'data', 'backlog.md'), keepBacklog = fs.readFileSync(backlog, 'utf8');
    fs.writeFileSync(backlog, keepBacklog.replace(/^- \[.\] misc-cleanup-one - .*\n/m, ''));
    const k1 = calls().length;
    const uidRefused = firstPill();
    realClick('.task-chip.add:not(.quiet)', 0); await sleep(500); helpers();
    realType('Find a task to add this turn to', 'Cleanup one'); await sleep(300);
    realClick('#turnmenu .trow.pick[data-task="misc-cleanup-one"]');
    await until(`return { ok: /Not saved/.test(M.toast()) };`, 'the refusal to be shown', 8000);
    check(/not in this home's backlog/.test(ev(`return M.toast();`)) && calls().length === k1 + 1, 'a task the home no longer has is refused with the command\'s own sentence', ev(`return M.toast();`));
    check(isPill(uidRefused), 'and the tag shown meanwhile is taken back (the pill is there again)', JSON.stringify(chipOf(uidRefused)));
    fs.writeFileSync(backlog, keepBacklog);

    // ---- 5. a message with no reply yet is marked on the message
    const stamp = (extra) => new Date(Date.now() + extra).toISOString();
    const cwd = path.join(lab.home, 'fm-leader');
    fs.appendFileSync(log, JSON.stringify({ type: 'user', uuid: 'u-new-msg-1', timestamp: stamp(0), cwd, message: { role: 'user', content: 'A message nobody has answered yet' } }) + '\n');
    await until(`return { ok: M.qa('#main .input').some(n => /nobody has answered/.test(n.textContent)) };`, 'the new message on the page', 60000);
    const newUid = 'u-new-msg-1';
    const k2 = calls().length;
    realClick(`#main .task-chip[data-uid="${newUid}"]`); await sleep(500);
    realClick('#turnmenu .trow.pick[data-task="bc-39-review-round"]');
    await until(`return { ok: /Added to BC-39 review round/.test(M.toast()) };`, 'the toast', 8000);
    const msgLines = calls().slice(k2);
    check(msgLines.length === 1 && msgLines[0].startsWith('bc-39-review-round in ') && msgLines[0].includes(':u-new-ms:in reader'), 'a message with no reply yet is marked on your message (the :in side)', JSON.stringify(msgLines));
    check(await buildHas(newUid, 'bc-39-review-round'), 'and the build tags it');

    // ---- 6. two quick marks on two turns: both written, both shown
    setDelay(0.6);
    const k3 = calls().length;
    const [uidA, uidB] = pillUids(2);
    realClick('.task-chip.add:not(.quiet)', 0); await sleep(400);
    realClick('#turnmenu .trow.pick[data-task="lv-50-finish-flow"]');
    if (process.env.DEBUG_TIMELINE) { const t = Date.now(); const out = []; while (Date.now() - t < 7000) { out.push([Date.now() - t, isPill(uidA) ? 'pill' : 'chip', ev(`return M.toast();`)]); await sleep(300); } process.stdout.write(JSON.stringify(out) + '\n'); }
    await sleep(150);
    realClick('.task-chip.add:not(.quiet)', 0); await sleep(400);
    realClick('#turnmenu .trow.pick[data-task="lv-50-finish-flow"]');
    await sleep(3500);
    const two = calls().slice(k3);
    check(two.length === 2 && new Set(two).size === 2 && two.every((l) => l.startsWith('lv-50-finish-flow in ')), 'two marks on two turns in quick succession are two lines, none lost', JSON.stringify(two));
    setDelay(0);
    check(await buildHas(uidA, 'lv-50-finish-flow') && await buildHas(uidB, 'lv-50-finish-flow'), 'and the build has both');
    check(isChip(uidA) && isChip(uidB), 'and the page shows both');

    // ---- 7. keyboard: Esc closes it and the focus goes back to the pill; the arrow keys; a press outside closes it
    await openReader(page, '1440x900x1', 'light'); helpers();
    realClick('.task-chip.add:not(.quiet)', 0); await sleep(500);
    axi('press', 'Escape'); await sleep(300);
    check(ev(`return M.menu().shown;`) === false && ev(`const a = document.activeElement; return !!a && a.classList.contains('task-chip') && a.getAttribute('aria-expanded') === 'false';`), 'Esc closes the menu and the focus goes back to the pill');
    realClick('.task-chip.add:not(.quiet)', 0); await sleep(500);
    axi('press', 'ArrowDown'); axi('press', 'ArrowDown'); await sleep(200);
    check(/^p:/.test(ev(`return M.menu().active;`)), 'the arrow keys walk the list from the find box', ev(`return M.menu().active;`));
    ev(`document.getElementById('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true;`); await sleep(300);
    check(ev(`return M.menu().shown;`) === false, 'a press outside it closes it');

    // ---- 8. contrast of the pill in both themes, and the screenshots
    for (const scheme of ['light', 'dark']) {
      await openReader(page, '1440x900x1', scheme); helpers();
      const colours = ev(`const p = M.q('.task-chip.add:not(.quiet)'), cs = getComputedStyle(p); const bg = el => { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c; n = n.parentElement; } return 'rgb(255,255,255)'; }; return { fg: cs.color, bg: bg(p), border: cs.borderColor };`);
      check(ratio(colours.fg, colours.bg) >= 4.5, `the "+ Task" pill reads at 4.5:1 or better in ${scheme} (${ratio(colours.fg, colours.bg).toFixed(2)})`, JSON.stringify(colours));
      realClick('.task-chip.add:not(.quiet)', 0); await sleep(500);
      axi('screenshot', path.join(shots, `popover-pill-1440-${scheme}.png`));
      axi('press', 'Escape'); await sleep(200);
    }

    // ---- 9. widths: a popover from 820 px, a bottom sheet below it; the lite page's Watch widths
    const shape = async (label, opener, viewport, scheme, sheet) => {
      await opener(viewport, scheme); helpers();
      realClick('.task-chip.add:not(.quiet)', 0); await sleep(600); helpers();
      const s = ev(`return M.menu();`);
      const rowH = ev(`const r = M.q('#turnmenu .trow.pick'); return r ? Math.round(r.getBoundingClientRect().height) : 0;`);
      const btnH = ev(`const b = M.q('#turnmenu .tm-head button'); return b ? Math.round(b.getBoundingClientRect().height) : 0;`);
      const vw = Number(viewport.split('x')[0]);
      const inside = s.box && s.box.x >= 0 && s.box.r <= s.vw + 1 && s.box.b <= s.vh + 1 && s.box.y >= 0;
      check(s.shown && (sheet ? s.pos === 'fixed' && s.scrim && s.modal === 'true' && s.box.x === 0 && s.box.r === s.vw && Math.abs(s.box.b - s.vh) <= 1 : s.pos === 'absolute' && !s.scrim && s.box.w <= 352), `${label}: ${sheet ? 'a bottom sheet over the column' : 'a popover under the pill'}`, JSON.stringify(s));
      check(inside && s.scrollW <= s.vw, `${label}: inside the window and the page does not scroll sideways`, JSON.stringify({ box: s.box, scrollW: s.scrollW, vw: s.vw }));
      if (vw <= 440) check(rowH >= 44 && btnH >= 44, `${label}: rows and the close button are 44 px tall for a thumb`, JSON.stringify({ rowH, btnH }));
      return s;
    };
    for (const [width, sheet] of [[1030, false], [820, false], [819, true]]) {
      await shape(`reader page at ${width} px`, (v, sc) => openReader(page, v, sc), `${width}x900x1`, 'light', sheet);
      axi('press', 'Escape'); await sleep(200);
    }
    for (const width of [330, 360, 390, 440, 480]) {
      await shape(`Watch column of ${width} px (the lite page)`, (v, sc) => openLite(port, v, sc), `${width}x800x1`, 'light', true);
      axi('screenshot', path.join(shots, `sheet-lite-${width}-light.png`));
      axi('press', 'Escape'); await sleep(200);
    }
    await shape('Watch column of 390 px, dark', (v, sc) => openLite(port, v, sc), '390x800x1', 'dark', true);
    axi('screenshot', path.join(shots, 'sheet-lite-390-dark.png'));
    axi('press', 'Escape'); await sleep(300);
    check(ev(`return M.menu().shown;`) === false && ev(`return document.body.style.overflow === '';`), 'Esc closes the sheet and the page scrolls again');
    realClick('.task-chip.add:not(.quiet)', 0); await sleep(500);
    ev(`document.getElementById('turn-scrim').click(); return true;`); await sleep(300);
    check(ev(`return M.menu().shown;`) === false, 'a tap on the scrim closes the sheet');
    consoleClean('the lite page');

    // ---- 10. the marks flag off: the chip is as it was, no pill, the turn menu never appears
    servers[0].kill(); await sleep(500);
    const port2 = await freePort();
    startServer(lab, markLab, port2, { PMOS_READER_BOARD: '1' });
    await waitUp(port2);
    const page2 = `http://localhost:${port2}/setup/transcript-reader/out/prototype.html`;
    wipe(page2); await openPage(page2, '1440x900x1'); pick('crew-1'); await sleep(2500); helpers();
    check(ev(`return M.qa('.task-chip').length > 5 && M.qa('.task-chip.add').length === 0 && M.qa('.task-chip[data-uid]').length === 0;`), 'with the marks flag off there is no pill, and the chips are what they were');
    ev(`localStorage.setItem('tr-task-rail', '0'); M.q('.task-chip').click(); return true;`); await sleep(500);
    check(ev(`return M.menu().shown === false && !M.q('#taskmenu').hidden;`), 'a chip opens the By task menu, as before');
  } catch (e) {
    process.stderr.write(String(e.stack || e) + '\n');
    check(false, 'the run finished', String(e.message || e).slice(0, 300));
  } finally { finish(stop); }
})().catch((e) => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
