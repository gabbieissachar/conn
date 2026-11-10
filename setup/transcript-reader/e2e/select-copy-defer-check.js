#!/usr/bin/env node
'use strict';

// The delayed copy of Copy on select (README.md, "Copy on select waits 0.8 s"), in a real browser (chrome-devtools-axi, headless) against a lab
// copy of the reader on its own port with a fake Herdr (nothing is sent to a pane; the owner's server and clipboard are not touched). By hand,
// not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/select-copy-defer-check.js <scratch folder> [screenshots folder]
//
// Headless Chrome has no clipboard to read back, so the page's navigator.clipboard.writeText is wrapped to record each write with the time it
// was asked for (the wrapper still calls the real one); the selection, the click on "Comment on this", the hover and the keys are the browser's
// own, sent through the DevTools protocol in one `run` script per step so the gaps between them are milliseconds, not process starts.
// It checks that: a selection is copied once, about 0.8 s after it and not before; a click on "Comment on this" in that time means no copy at
// all; so does Cmd+Enter; the pointer resting on the button holds the copy, and leaving without a click lets it run 0.8 s later; a comment
// begun after the 0.8 s finds the copy done; a second selection replaces the first and restarts the wait; a cancelled copy does not block
// copying the same passage later, while a passage already copied is not copied twice; a bare Cmd shortens the wait to a quarter second and
// another Cmd key copies at once; Copy on select turned off in the wait means no copy; on plain http (no navigator.clipboard) the copy is
// immediate, at the mouseup (no chip, the corner note).
// The countdown chip beside "Comment on this" (README.md, "Copy on select shows its wait"): the ring drains over the wait on the browser's own
// animation clock, "Copy paused" while the pointer rests on the button, the ring restarts full when it leaves and speeds up for a bare Cmd; the
// end is "Copied" (and no corner note) or "Not copied" (a comment began first) for 1.4 s, spoken once to a screen reader; a click on the chip
// copies at once; it sits beside the button where there is room and under it in a narrow window. Then a matrix: 1440 px, a 390 px phone-width
// window and a 330 px Watch column, light and dark, each with the ring counting, paused and the two ends, measured (the chip inside the window,
// clear of the button) and screenshotted. Reduced motion has no browser switch here: the stylesheet rule is read, the label is unit-tested.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-select-copy-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION || 'reader-select-copy-check';
const { axi, ev, check, startLab, openPage, pick, finish, sleep } = make(SESSION);

// One script in the browser session: `page` is its handle (eval, click, press, wait). It prints the last JSON line it logs.
function run(body) {
  let out;
  try { out = execFileSync('chrome-devtools-axi', ['run'], { input: body, encoding: 'utf8', timeout: 120000, env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: SESSION } }); }
  catch (error) { throw new Error(`chrome-devtools-axi run: ${String(error.stdout || '')}${String(error.stderr || error.message)}`.trim().slice(0, 500)); }
  const line = out.split('\n').filter((l) => l.startsWith('{') || l.startsWith('[')).pop();
  if (!line) throw new Error('no result from: ' + out.slice(0, 300));
  return JSON.parse(line);
}

// What the page needs, in pieces short enough for one eval each.
const INSTALL = [
  `window.__w = []; const real = navigator.clipboard.writeText.bind(navigator.clipboard);
   navigator.clipboard.writeText = (t) => { window.__w.push({ at: performance.now(), text: t }); return real(t); }; return true;`,
  // Selects text[from, end) of the longest text node of the last reply (the lab's replies are short: a different `from` makes a different passage), then lets go of the mouse over it (the page's own mouseup).
  `window.__pick = (from) => { const r = [...document.querySelectorAll('#main .reply')].pop(); const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
     let n, best = null; while ((n = w.nextNode())) if (!best || n.nodeValue.length > best.nodeValue.length) best = n; n = best;
     const s = getSelection(); s.removeAllRanges(); const range = document.createRange(); range.setStart(n, from); range.setEnd(n, n.nodeValue.length); s.addRange(range);
     window.__m = performance.now(); n.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return s.toString(); }; return true;`,
  `window.__state = () => ({ writes: window.__w.map((x) => ({ after: Math.round(x.at - window.__m), text: x.text })), focus: document.activeElement && document.activeElement.id,
     button: !document.getElementById('float-comment').hidden, chip: [...document.querySelectorAll('#dock .chip, #dock-chip')].some((n) => n.offsetParent !== null) }); return true;`,
,
  // A selection no earlier step made (the page does not copy an unchanged selection twice): another start and a shorter end each time.
  `window.__n = 0; window.__fresh = () => { const n = ++window.__n, r = [...document.querySelectorAll('#main .reply')].pop(); const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
     let t, best = null; while ((t = w.nextNode())) if (!best || t.nodeValue.length > best.nodeValue.length) best = t;
     const s = getSelection(); s.removeAllRanges(); const range = document.createRange(); range.setStart(best, n % 6); range.setEnd(best, best.nodeValue.length - 1 - Math.floor(n / 6)); s.addRange(range);
     window.__m = performance.now(); best.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return s.toString(); }; return true;`,
  // The chip as the person sees it, and the ring's own animation.
  `window.__chip = () => { const c = document.getElementById('copy-chip'), b = document.getElementById('float-comment'), a = c.querySelector('.arc').getAnimations()[0];
     const rc = c.getBoundingClientRect(), rb = b.getBoundingClientRect(), r = (x) => [x.left, x.top, x.right, x.bottom].map(Math.round);
     return { shown: !c.hidden && c.offsetParent !== null, phase: c.dataset.phase, text: c.textContent.trim(), aria: c.getAttribute('aria-label'), disabled: c.disabled, opacity: getComputedStyle(c).opacity,
       live: document.getElementById('copy-live').textContent, note: document.getElementById('copy-note').classList.contains('show'),
       anim: a ? { dur: a.effect.getTiming().duration, t: Math.round(a.currentTime), state: a.playState } : null, chip: r(rc), btn: r(rb), floatHidden: b.hidden, vw: innerWidth, vh: innerHeight }; }; return true;`,
];
// Back to a quiet page: no pointer chip (dropping it focuses the box, so that comes first), the box not focused, no selection, no button.
const reset = async () => {
  ev(`const d = document.getElementById('dock-chip-drop'); if (d && d.offsetParent) d.click(); const t = document.getElementById('dock-text'); if (t) t.blur(); getSelection().removeAllRanges(); document.getElementById('float-comment').hidden = true; return true;`);
  await sleep(1000);  // a copy still waiting from the step before runs now, not inside the next step
  ev(`window.__w.length = 0; return true;`);
};
const state = () => ev(`return window.__state();`);

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { page, stop } = await startLab(folder);
  try {
    await openPage(page, '1000x900x1');
    pick('cp-ontology-search'); await sleep(900);
    ev(`localStorage.setItem('tr-copy-selection', '1'); return true;`);
    // (a script longer than 900 characters cannot go through ev: each goes through one `run`)
    INSTALL.forEach((s) => run(`await page.eval(${JSON.stringify('(() => {' + s + '})()')}); console.log('[1]');`));
    ev(`window.__note = []; const note = document.getElementById('copy-note'); new MutationObserver(() => { if (note.classList.contains('show')) window.__note.push(Math.round(performance.now() - window.__m)); }).observe(note, { attributes: true, attributeFilter: ['class'] }); return true;`);
    if (process.env.SC_DEBUG) ev(`window.__ev = []; const lg = (t) => () => window.__ev.push(t + '@' + Math.round(performance.now() - (window.__m || 0))); for (const t of ['blur', 'focus']) window.addEventListener(t, lg('win-' + t)); for (const t of ['pointerenter', 'pointerleave', 'click']) document.getElementById('float-comment').addEventListener(t, lg('btn-' + t)); for (const t of ['keydown']) document.addEventListener(t, (e) => window.__ev.push('key:' + e.key + '@' + Math.round(performance.now() - window.__m)), true); return true;`);
    const wide = ev(`return { secure: window.isSecureContext, clipboard: !!navigator.clipboard, copy: document.querySelector('[title*="clipboard"]') ? document.querySelector('[title*="clipboard"]').getAttribute('aria-pressed') : 'none', coarse: matchMedia('(pointer: coarse)').matches, replies: document.querySelectorAll('#main .reply').length };`);
    check(wide.secure && wide.clipboard && wide.replies > 0 && !wide.coarse, 'the lab page is a secure context with a clipboard and a reply to select in', JSON.stringify(wide));

    // ---- 1. a selection is copied once, about 0.8 s later
    await reset();
    let r = run(`await page.eval(() => window.__pick(0));
      await page.wait(1500); console.log(JSON.stringify({ late: await page.eval(() => window.__state()), note: await page.eval(() => window.__note) }));`);
    check(r.late.writes.length === 1 && r.late.writes[0].after >= 780 && r.late.writes[0].after <= 1100 && r.late.writes[0].text.length >= 20,
      'it is copied once, 0.8 s after the selection, with the selected words', JSON.stringify(r.late.writes));
    check(r.late.button, 'and "Comment on this" was on offer the whole time', String(r.late.button));
    check(r.note.length === 0, 'the corner note stays quiet: the chip carries the result when "Comment on this" is on screen', JSON.stringify(r.note));

    // ---- 2. a click on "Comment on this" inside the wait: no copy at all
    await reset();
    r = run(`await page.eval(() => window.__pick(2));
      await page.click('#float-comment');
      await page.wait(1600); console.log(JSON.stringify(await page.eval(() => window.__state())));`);
    check(r.writes.length === 0, 'a click on "Comment on this" within the wait: nothing is ever written to the clipboard', JSON.stringify(r.writes));
    check(r.focus === 'dock-text', 'and the comment did start (the message box has the focus, with its pointer)', String(r.focus));

    // ---- 3. Cmd+Enter inside the wait does the same
    await reset();
    ev(`window.__k = []; document.addEventListener('keydown', (e) => window.__k.push(e.key + (e.metaKey ? '+meta' : '') + '@' + Math.round(performance.now() - window.__m)), true); return true;`);
    r = run(`await page.eval(() => window.__pick(4));
      await page.press('Meta+Enter');
      await page.wait(1600); console.log(JSON.stringify(await page.eval(() => Object.assign(window.__state(), { keys: window.__k }))));`);
    check(r.writes.length === 0 && r.focus === 'dock-text', 'Cmd+Enter inside the wait: nothing is written and the comment starts', JSON.stringify({ writes: r.writes, keys: r.keys, focus: r.focus }));
    await reset();
    r = run(`await page.eval(() => window.__pick(5));
      await page.press('Control+Enter');
      await page.wait(1600); console.log(JSON.stringify(await page.eval(() => window.__state())));`);
    check(r.writes.length === 0 && r.focus === 'dock-text', 'and Ctrl+Enter', JSON.stringify({ writes: r.writes.length, focus: r.focus }));

    // ---- 4. the pointer resting on the button holds the copy; leaving without a click lets it run, 0.8 s later
    // The hover is one more process (a snapshot for the button's ref, then the move), so the page times the pointer's arrival itself and a step
    // that arrived after the wait was over is run again with a fresh selection.
    const hover = (name) => { for (let i = 0; ; i++) { const l = axi('snapshot').split('\n').find((x) => x.includes(name)); try { return axi('hover', '@' + l.match(/uid=(\S+)/)[1]); } catch (e) { if (i > 3 || !/STALE_REF/.test(e.message)) throw e; } } };
    ev(`const b = document.getElementById('float-comment'); b.addEventListener('pointerenter', () => { window.__enter = Math.round(performance.now() - window.__m); }); b.addEventListener('pointerleave', () => { window.__left = performance.now(); }); return true;`);
    let held = null;
    for (let attempt = 1; attempt <= 4 && !held; attempt++) {
      await reset();
      ev(`window.__enter = null; window.__pick(${6 + attempt}); return true;`);
      hover('button "Comment on this');
      await sleep(1300);
      const got = ev(`return { enter: window.__enter, writes: window.__w.length };`);
      if (got.enter !== null && got.enter < 700) held = got; else if (got.enter === null) throw new Error('the pointer never reached "Comment on this"');
    }
    check(held && held.writes === 0, 'the pointer resting on "Comment on this" holds the copy (1.3 s later, no write)', JSON.stringify(held));
    hover('button "Sync');
    await sleep(1500);
    let s = ev(`return { w: window.__w.map((x) => Math.round(x.at - window.__left)) };`);
    check(s.w.length === 1 && s.w[0] >= 780 && s.w[0] <= 1100, 'leaving the button without a click lets it run, once, 0.8 s after the pointer left', `${JSON.stringify(s.w)} ms after the pointer left`);

    // ---- 5. a comment begun after the 0.8 s finds the copy done
    await reset();
    r = run(`await page.eval(() => window.__pick(10));
      await page.wait(1300); const before = await page.eval(() => window.__state().writes.length);
      const hov = await page.eval(() => [...document.querySelectorAll(':hover')].map((n) => n.id || n.tagName).join('>'));
      await page.click('#float-comment'); await page.wait(300);
      console.log(JSON.stringify({ before, hov, after: await page.eval(() => window.__state()) }));`);
    check(r.before === 1 && r.after.writes.length === 1 && r.after.focus === 'dock-text', 'a comment begun after the wait: the copy had run (the limit of this change), once, and the comment starts', JSON.stringify({ before: r.before, after: r.after.writes.length, hover: r.hov, ev: process.env.SC_DEBUG ? ev(`return window.__ev;`) : undefined }));

    // ---- 6. a second selection replaces the first and restarts the wait
    await reset();
    // both picks and the gap between them run inside the page: a round trip to the browser is itself a quarter second
    r = run(`const second = await page.eval(() => { window.__pick(11); window.__gap = performance.now(); return new Promise((done) => setTimeout(() => { window.__gap = Math.round(performance.now() - window.__gap); done(window.__pick(13)); }, 500)); });
      await page.wait(1500); console.log(JSON.stringify({ second, gap: await page.eval(() => window.__gap), end: await page.eval(() => window.__state()) }));`);
    check(r.end.writes.length === 1 && r.end.writes[0].text === r.second && r.end.writes[0].after >= 780,
      'a second selection 0.5 s after the first replaces it: one copy, of the second, 0.8 s after the second', JSON.stringify({ gap: r.gap, writes: r.end.writes }));

    // ---- 7. a cancelled copy does not block the same passage later; a passage already copied is not copied twice
    await reset();
    r = run(`await page.eval(() => window.__pick(14)); await page.click('#float-comment'); await page.wait(900);
      const cancelled = await page.eval(() => window.__state().writes.length);
      await page.eval(() => { const t = document.getElementById('dock-chip-drop'); if (t && t.offsetParent) t.click(); });
      await page.eval(() => window.__pick(14)); await page.wait(1300);
      const again = await page.eval(() => window.__state().writes.length);
      await page.eval(() => window.__pick(14)); await page.wait(1300);
      console.log(JSON.stringify({ cancelled, again, twice: await page.eval(() => window.__state().writes.length) }));`);
    check(r.cancelled === 0 && r.again === 1 && r.twice === 1, 'the same passage: cancelled by a comment (0 copies), selected again (copied), selected again unchanged (not copied twice)', JSON.stringify(r));

    // ---- 8. a bare Cmd shortens the wait to a quarter second, another Cmd key copies at once
    await reset();
    r = run(`await page.eval(() => window.__pick(16));
      await page.press('Meta'); await page.wait(900); console.log(JSON.stringify(await page.eval(() => window.__state())));`);
    check(r.writes.length === 1 && r.writes[0].after < 700, 'a bare Cmd press shortens the wait (copied well before 0.8 s)', JSON.stringify(r.writes));
    await reset();
    r = run(`await page.eval(() => window.__pick(18));
      await page.press('Meta+Shift+4'); await page.wait(150); console.log(JSON.stringify(await page.eval(() => window.__state())));`);
    check(r.writes.length === 1 && r.writes[0].after < 500, 'another Cmd key (Cmd+Shift+4, a screenshot) copies at once', JSON.stringify(r.writes));

    // ---- 9. Copy on select turned off inside the wait: no copy
    await reset();
    r = run(`await page.eval(() => window.__pick(20));
      await page.eval(() => { document.querySelector('[title*="clipboard"]').click(); });
      await page.wait(1500); console.log(JSON.stringify({ state: await page.eval(() => window.__state()), on: await page.eval(() => localStorage.getItem('tr-copy-selection')) }));`);
    check(r.on === '0' && r.state.writes.length === 0, 'Copy on select switched off inside the wait: nothing is copied', JSON.stringify({ on: r.on, writes: r.state.writes.length }));
    ev(`document.querySelector('[title*="clipboard"]').click(); return localStorage.getItem('tr-copy-selection');`);


    // ---- 9b. the countdown chip: the ring drains over the wait, then it says Copied (and the corner note stays quiet)
    await reset();
    r = run(`await page.eval(() => window.__fresh());
      await page.wait(250); const counting = await page.eval(() => window.__chip());
      await page.wait(900); const copied = await page.eval(() => window.__chip());
      await page.wait(1500); const gone = await page.eval(() => window.__chip());
      console.log(JSON.stringify({ counting, copied, gone, writes: await page.eval(() => window.__w.length) }));`);
    const mid = (a) => (a[1] + a[3]) / 2;
    check(r.counting.shown && r.counting.phase === 'counting' && r.counting.text === 'Copy' && r.counting.aria === 'Copy selection now' && !r.counting.disabled,
      'the chip is on screen at once after the selection: "Copy", a button named "Copy selection now"', JSON.stringify({ shown: r.counting.shown, text: r.counting.text, aria: r.counting.aria }));
    check(r.counting.anim && r.counting.anim.dur === 800 && r.counting.anim.state === 'running' && r.counting.anim.t >= 50 && r.counting.anim.t < 800,
      'its ring is one 800 ms animation of the browser, running part way (a round trip to the browser is a few hundred ms)', JSON.stringify(r.counting.anim));
    check(r.counting.chip[0] >= r.counting.btn[2] && Math.abs(mid(r.counting.chip) - mid(r.counting.btn)) <= 6 && r.counting.chip[2] <= r.counting.vw,
      'with room to spare it sits beside "Comment on this", on its line, inside the window', JSON.stringify({ chip: r.counting.chip, btn: r.counting.btn, vw: r.counting.vw }));
    check(r.copied.shown && r.copied.phase === 'copied' && r.copied.text === '✓ Copied' && r.copied.disabled && r.copied.live === 'Copied' && !r.copied.note,
      'when the copy runs the chip says Copied, a screen reader is told once, and the corner note stays quiet', JSON.stringify({ text: r.copied.text, live: r.copied.live, note: r.copied.note }));
    check(!r.gone.shown && r.writes === 1, 'the chip is gone about 1.4 s later; one copy was made', JSON.stringify({ shown: r.gone.shown, writes: r.writes }));

    // ---- 9c. a click on the chip copies at once
    await reset();
    r = run(`await page.eval(() => window.__fresh());
      await page.wait(200); await page.click('#copy-chip'); await page.wait(250);
      console.log(JSON.stringify({ state: await page.eval(() => window.__state()), chip: await page.eval(() => window.__chip()) }));`);
    check(r.state.writes.length === 1 && r.state.writes[0].after < 700 && r.chip.phase === 'copied',
      'a click on the chip copies at once, well inside the wait, and ends as Copied', JSON.stringify({ writes: r.state.writes, phase: r.chip.phase }));

    // ---- 9d. "Comment on this" first: Not copied, the button gone, the chip stays for its moment, the clipboard untouched
    await reset();
    r = run(`await page.eval(() => window.__fresh());
      await page.wait(200); await page.click('#float-comment'); await page.wait(60);
      const skipped = await page.eval(() => window.__chip()); await page.wait(1900);
      console.log(JSON.stringify({ skipped, later: await page.eval(() => window.__chip()), writes: await page.eval(() => window.__w.length) }));`);
    check(r.skipped.shown && r.skipped.phase === 'skipped' && r.skipped.text === 'Not copied' && r.skipped.live === 'Not copied' && r.skipped.floatHidden && !r.skipped.note,
      'a comment begun first: the chip says Not copied while the button has gone', JSON.stringify({ text: r.skipped.text, live: r.skipped.live, floatHidden: r.skipped.floatHidden }));
    check(!r.later.shown && r.writes === 0, 'and then fades; nothing was written', JSON.stringify({ shown: r.later.shown, writes: r.writes }));

    // ---- 9e. the pointer on the button: the ring stops and the chip says so; leaving starts the whole ring again
    await reset();
    r = run(`await page.eval(() => window.__fresh());
      await page.wait(200); await page.eval(() => document.getElementById('float-comment').dispatchEvent(new PointerEvent('pointerenter')));
      await page.wait(60); const paused = await page.eval(() => window.__chip());
      await page.wait(1200); const still = await page.eval(() => window.__chip()); const heldWrites = await page.eval(() => window.__w.length);
      await page.eval(() => document.getElementById('float-comment').dispatchEvent(new PointerEvent('pointerleave')));
      await page.wait(60); const resumed = await page.eval(() => window.__chip());
      await page.wait(1000); console.log(JSON.stringify({ paused, still, heldWrites, resumed, end: await page.eval(() => window.__chip()) }));`);
    check(r.paused.phase === 'paused' && r.paused.text === 'Copy paused' && r.paused.anim.state === 'paused' && r.paused.shown,
      'the pointer on "Comment on this": the chip reads "Copy paused" and the ring stops', JSON.stringify({ text: r.paused.text, anim: r.paused.anim }));
    check(r.heldWrites === 0 && Math.abs(r.still.anim.t - r.paused.anim.t) <= 20, 'and stays stopped (1.2 s later: no write, the ring where it was)', JSON.stringify({ heldWrites: r.heldWrites, before: r.paused.anim.t, after: r.still.anim.t }));
    check(r.resumed.phase === 'counting' && r.resumed.text === 'Copy' && r.resumed.anim.dur === 800 && r.resumed.anim.state === 'running' && r.resumed.anim.t < r.still.anim.t && r.end.phase === 'copied',
      'leaving without a click starts the whole ring again (a new 800 ms animation, younger than the stopped one), and it ends as Copied', JSON.stringify({ resumed: r.resumed.anim, stopped: r.still.anim, end: r.end.phase }));

    // ---- 9f. a bare Cmd: the ring is shortened to the quarter second the copy now gets
    await reset();
    // (the Cmd and the reading of the ring are one script in the page: a round trip to the browser is itself a third of a second)
    r = run(`const sooner = await page.eval(() => new Promise((done) => { window.__fresh(); setTimeout(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true, bubbles: true })); done(window.__chip()); }, 300); }));
      await page.wait(700); console.log(JSON.stringify({ sooner, end: await page.eval(() => window.__chip()) }));`);
    check(r.sooner.anim && r.sooner.anim.dur === 250 && r.sooner.anim.t < 100 && r.sooner.phase === 'counting' && r.end.phase === 'copied', 'a bare Cmd shortens the ring to 250 ms and the chip ends as Copied', JSON.stringify({ anim: r.sooner.anim, end: r.end.phase }));

    // ---- 9g. the selection let go of in the wait: no button, so no chip; the copy still runs and the corner note says so
    await reset();
    r = run(`const notes = await page.eval(() => window.__note.length);
      await page.eval(() => window.__fresh());
      await page.wait(100); await page.eval(() => getSelection().removeAllRanges()); await page.wait(60);
      const dropped = await page.eval(() => window.__chip()); await page.wait(1000);
      console.log(JSON.stringify({ dropped, after: await page.eval(() => window.__chip()), writes: await page.eval(() => window.__w.length), notes: await page.eval(() => window.__note.length) - notes }));`);
    check(!r.dropped.shown && !r.after.shown && r.notes === 1 && r.writes === 1, 'with no button to comment with there is no chip: the copy runs and the corner note says Copied', JSON.stringify({ chip: r.after.shown, notes: r.notes, writes: r.writes }));

    // ---- 9h. the matrix: 1440 px, a 390 px window and a 330 px Watch column, light and dark. Timers and the ring run ten times slower here
    // (and the result stays for a minute) so each state can be measured and photographed; nothing above depends on it.
    run(`await page.eval(() => { const set = window.setTimeout.bind(window); window.__k = 1; window.__long = false;
      window.setTimeout = (f, ms, ...a) => set(f, ms === 800 || ms === 250 ? ms * window.__k : ms === 1400 && window.__long ? 60000 : ms, ...a);
      const anim = Element.prototype.animate; Element.prototype.animate = function (kf, o) { return anim.call(this, kf, o && o.duration ? { ...o, duration: o.duration * window.__k } : o); }; return true; });
      console.log('[1]');`);
    const setK = (k, long) => ev(`window.__k = ${k}; window.__long = ${long}; return true;`);
    const measure = (name, beside, st, expect) => {
      const c = st.chip, b = st.btn, inside = c[0] >= 0 && c[2] <= st.vw && c[1] >= 0 && c[3] <= st.vh;
      const apart = st.floatHidden || c[2] <= b[0] || c[0] >= b[2] || c[3] <= b[1] || c[1] >= b[3];
      const place = st.floatHidden ? true : beside ? c[0] >= b[2] && Math.abs(mid(c) - mid(b)) <= 6 : c[1] >= b[3] && Math.abs(c[0] - b[0]) <= 2;
      check(st.shown && st.phase === expect.phase && st.text === expect.text && inside && apart && place && c[3] - c[1] <= 28,
        `${name}: ${expect.text}, ${beside ? 'beside' : 'under'} the button, inside the window, clear of the button, one line`, JSON.stringify({ chip: c, btn: b, vw: st.vw, text: st.text }));
    };
    for (const [vp, name, beside] of [['1440x900x1', '1440', true], ['390x844x1', 'window-390', false], ['330x800x1', 'watch-330', false]]) {
      for (const scheme of ['light', 'dark']) {
        const tag = `${name}-${scheme}`;
        axi('emulate', '--viewport', vp, '--color-scheme', scheme); await sleep(700);
        await reset(); setK(10, true);
        ev(`window.__fresh(); document.getElementById('float-comment').scrollIntoView({ block: 'center' }); return true;`); await sleep(1300);
        const counting = ev(`return window.__chip();`), slot = counting.btn;
        measure(tag, beside, counting, { phase: 'counting', text: 'Copy' });
        const ring = ev(`return window.__chip().anim;`);
        check(ring && ring.dur === 8000 && ring.t > 300 && ring.t < 7500 && ring.state === 'running', `${tag}: the ring is part way down`, JSON.stringify(ring));
        axi('screenshot', path.join(shots, `chip-${tag}-counting.png`));
        ev(`document.getElementById('float-comment').dispatchEvent(new PointerEvent('pointerenter')); return true;`); await sleep(200);
        measure(tag, beside, ev(`return window.__chip();`), { phase: 'paused', text: 'Copy paused' });
        axi('screenshot', path.join(shots, `chip-${tag}-paused.png`));
        ev(`document.getElementById('float-comment').dispatchEvent(new PointerEvent('pointerleave')); return true;`);
        ev(`document.getElementById('float-comment').click(); return true;`); await sleep(250);
        const skipped = ev(`return window.__chip();`);
        measure(tag, beside, skipped, { phase: 'skipped', text: 'Not copied' });
        check(Math.abs(skipped.chip[0] - slot[0]) <= 2 && Math.abs(mid(skipped.chip) - mid(slot)) <= 6, `${tag}: with the button gone the chip takes its place`, JSON.stringify({ chip: skipped.chip, slot }));
        axi('screenshot', path.join(shots, `chip-${tag}-skipped.png`));
        await reset(); setK(1, true);
        ev(`window.__fresh(); document.getElementById('float-comment').scrollIntoView({ block: 'center' }); return true;`); await sleep(1300);
        measure(tag, beside, ev(`return window.__chip();`), { phase: 'copied', text: '✓ Copied' });
        axi('screenshot', path.join(shots, `chip-${tag}-copied.png`));
      }
    }
    axi('emulate', '--viewport', '1000x900x1', '--color-scheme', 'light'); await sleep(600);
    setK(1, false);
    // the result of the last step stays for a minute here: a selection copied while Copy on select is switched off ends it (the page drops the chip)
    ev(`window.__fresh(); document.querySelector('[title*="clipboard"]').click(); return true;`); await sleep(1300);
    ev(`document.querySelector('[title*="clipboard"]').click(); return true;`);
    const reduce = ev(`const rules = []; for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) if (rule.media && /prefers-reduced-motion/.test(rule.conditionText || rule.media.mediaText)) for (const inner of rule.cssRules) if (/copy-ring|copy-chip/.test(inner.selectorText || '')) rules.push(inner.cssText.slice(0, 80)); return rules;`);
    check(reduce.length >= 2 && reduce.some((x) => /copy-ring/.test(x) && /display: none/.test(x)), 'reduced motion: the stylesheet draws no ring and no fade (the label is "Copying", unit-tested)', JSON.stringify(reduce));
    await reset();

    // ---- 10. plain http (no navigator.clipboard): the copy is immediate, at the mouseup
    await reset();
    ev(`window.__x = []; const e = document.execCommand.bind(document); document.execCommand = (c) => { window.__x.push({ c, at: performance.now() }); return e(c); };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); return true;`);
    s = ev(`const out = window.__pick(22); return { out, calls: window.__x.map((x) => ({ c: x.c, after: Math.round(x.at - window.__m) })) };`);
    check(s.calls.length === 1 && s.calls[0].c === 'copy' && s.calls[0].after <= 50, 'plain http fallback: execCommand("copy") runs inside the mouseup, not after a wait', JSON.stringify(s.calls));
    await sleep(1200);
    s = ev(`return { calls: window.__x.length };`);
    check(s.calls === 1, 'and nothing more later', String(s.calls));
    s = ev(`return window.__chip();`);
    check(!s.shown, 'and no chip was drawn: there was no wait to count down', JSON.stringify({ shown: s.shown }));
  } catch (e) {
    check(false, 'the check ran to its end', e.message);
  }
  finish(stop);
})();
