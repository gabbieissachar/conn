#!/usr/bin/env node
'use strict';

// The windowed lite page in a real (headless) browser, against a lab of its own: the store API on, the real store daemon reading made-up logs,
// a fake Herdr with event sockets. By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/store-api-check.js <scratch folder> [screenshots folder]
//
// It checks what the page promises: it draws the newest turns of a session with the reader's own cards; a turn the log gains reaches the screen
// as one new node (no request, no redraw of the others); older turns load as you scroll up and the window never holds more than 200;
// a search finds a conversation and opens it at the turn, with "Back to the latest"; a Send goes through the unchanged guarded route to the
// (fake) pane; a hidden page closes its stream and takes up what it missed when shown. Nothing real is read or sent; headless only.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');
const { startStoreLab } = require('./store-api-lab');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-store-api-lab'));
const shots = process.argv[3] ? path.resolve(process.argv[3]) : null;
const { axi, ev, until, check, sleep } = make('reader-store-api-check');

const state = (expr) => ev(`const S = window.__readerWindowed; return ${expr};`);

(async () => {
  const lab = await startStoreLab(folder, { bigExchanges: 260, fillers: 12 });
  const crew1 = lab.lab.crew[0];
  const shot = (name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); axi('screenshot', path.join(shots, name)); } };
  const finish = () => {
    lab.stop();
    try { axi('stop'); } catch (e) { /* not running */ }
  };
  let failures = 0;
  const record = check;
  const mark = (ok, what, detail) => { if (!ok) failures += 1; record(ok, what, detail); };
  try {
    axi('open', 'about:blank'); axi('emulate', '--viewport', '1000x900x1');
    axi('open', lab.page + '#s=' + crew1);
    await until(`const S = window.__readerWindowed; return { ok: Boolean(S && S.turns.length && document.getElementById("main").childElementCount > 0) };`, 'the page drawn');
    await sleep(600);
    mark(ev(`return /crew-1 · Reader \\(windowed\\)/.test(document.title);`), 'the page names the session in its title');
    mark(state('S.turns.length') === 40, 'it opens on the newest 40 turns', 'got ' + state('S.turns.length'));
    mark(state('S.marks.total') >= 260, 'the store holds the whole conversation', 'total ' + state('S.marks.total'));
    mark(ev(`return document.querySelectorAll('#main .turn').length === 40 && document.querySelectorAll('#main .reply').length > 0 && document.querySelectorAll('#main .input.captain').length > 0;`), 'the turns are the reader\'s own cards (input blocks, reply cards)');
    mark(ev(`const opts = [...document.querySelectorAll('#session option')]; return opts.length >= 12 && opts.some(o => /crew-1/.test(o.text));`), 'the picker lists the sessions, the open panes first');
    mark(ev(`return window.innerHeight + scrollY >= document.documentElement.scrollHeight - 140;`), 'it opens at the newest turn');
    shot('01-opened.png');

    // A turn the log gains: one render, no request.
    const before = ev(`return { renders: window.__stats.renders, fetches: window.__stats.fetches, nodes: document.getElementById('main').childElementCount };`);
    const wrote = lab.append(crew1, { user: 'LAB-MARK-1 one more question from the lab?', reply: 'LAB-MARK-1 the answer, and a question: should I go on?' });
    const on = await until(`return { ok: Boolean(window.__marks['1']), at: window.__marks['1'] };`, 'the new turn on screen', 8000);
    const after = ev(`return { renders: window.__stats.renders, fetches: window.__stats.fetches, nodes: document.getElementById('main').childElementCount };`);
    mark(on.at - wrote.at < 1500, 'a log write is on screen in well under 1.5 s with the lab\'s fast scan', `${on.at - wrote.at} ms`);
    mark(after.renders === before.renders + 1, 'one turn drawn, none of the others redrawn', `renders ${before.renders} -> ${after.renders}`);
    mark(after.fetches === before.fetches, 'no request made for it (it came in the stream)');
    mark(after.nodes === before.nodes + 1, 'one node added at the end');
    mark(ev(`return Boolean(document.querySelector('#main .turn:last-child .reply.needs'));`), 'the reply that asks is marked as needing you');
    mark(ev(`return window.innerHeight + scrollY >= document.documentElement.scrollHeight - 140;`), 'the page stayed at the newest turn');
    // The same turn grows in place as the reply is written.
    const grownAt = lab.append(crew1, { reply: 'LAB-MARK-2 and then some more words in the same exchange.' }).at;
    await until(`return { ok: /LAB-MARK-2/.test(document.querySelector('#main .turn:last-child').textContent) };`, 'the reply to grow', 8000);
    mark(ev(`return document.querySelectorAll('#main .turn').length === ${after.nodes};`), 'a reply that grows redraws the tail turn in place (no new node)', `${Date.now() - grownAt} ms`);
    shot('02-live-append.png');

    // Older turns, by scrolling up.
    const first = state('S.turns[0].idx');
    const anchorTop = () => ev(`const n = document.querySelector('#main .turn[data-idx="${first}"]'); return n ? Math.round(n.getBoundingClientRect().top + scrollY) - Math.round(scrollY) : null;`);
    ev(`window.scrollTo(0, 0); return true;`);
    await sleep(100);
    const anchorBefore = anchorTop();
    await until(`return { ok: window.__readerWindowed.turns[0].idx < ${first} };`, 'older turns to load');
    mark(state('S.turns[0].idx') === first - 40, 'scrolling to the top loads 40 older turns', `first ${first} -> ${state('S.turns[0].idx')}`);
    await sleep(300);
    mark(Math.abs(anchorTop() - anchorBefore) <= 2, 'what was being read stays where it was on screen (the page does not jump)', `the turn at the top moved ${anchorTop() - anchorBefore}px`);
    // The window never holds more than 200 turns.
    for (let i = 0; i < 6; i += 1) { ev(`window.scrollTo(0, 0); return true;`); await sleep(500); }
    mark(state('S.turns.length') <= 200 && ev(`return document.getElementById('main').childElementCount <= 200;`), 'the window never holds more than 200 turns', 'turns ' + state('S.turns.length'));
    shot('03-older.png');

    // Search, jump, back.
    ev(`const q = document.getElementById('q'); q.value = 'Earlier answer 12 in crew-1'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true;`);
    await until(`return { ok: document.querySelectorAll('#results .hit').length > 0 };`, 'search results');
    mark(ev(`return document.querySelector('#results .hit mark') !== null;`), 'search shows the matched words marked');
    shot('04-search.png');
    ev(`document.querySelector('#results .hit').click(); return true;`);
    await until(`return { ok: !document.getElementById('back').hidden };`, 'the jump');
    mark(state('S.jumped') === true && state('S.turns[0].idx') < 20, 'a hit opens the conversation at that turn, with "Back to the latest"', 'first ' + state('S.turns[0].idx'));
    ev(`document.getElementById('back').click(); return true;`);
    await until(`return { ok: window.__readerWindowed.jumped === false && window.__readerWindowed.turns.at(-1).idx === window.__readerWindowed.marks.last_idx };`, 'back to the latest');
    mark(true, 'Back to the latest returns to the newest turns');

    // Picking another session.
    const other = lab.lab.crew[1];
    ev(`const s = document.getElementById('session'); s.value = '${other}'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    await until(`return { ok: window.__readerWindowed.cur === '${other}' && window.__readerWindowed.turns.length > 0 };`, 'another session');
    mark(ev(`return /crew-2/.test(document.title) && location.hash === '#s=${other}';`), 'picking a session opens it and names it in the address');
    lab.append(other, { reply: 'LAB-MARK-3 for the second session.' });
    await until(`return { ok: Boolean(window.__marks['3']) };`, 'a turn in the picked session', 8000);
    mark(true, 'the stream follows the picked session');

    // Send: the unchanged guarded route, to the fake Herdr.
    ev(`const t = document.getElementById('text'); t.value = 'lab hello'; document.getElementById('send').click(); return true;`);
    await until(`return { ok: /Sent\\./.test(document.getElementById('note').textContent) || /nothing was sent|not on the reading list|refused/.test(document.getElementById('note').textContent) };`, 'the send to answer', 15000);
    const note = ev(`return document.getElementById('note').textContent;`);
    const herdrLog = fs.existsSync(lab.lab.log) ? fs.readFileSync(lab.lab.log, 'utf8') : '';
    mark(/Sent\./.test(note) && /PROMPT esim w3:p2 lab hello/.test(herdrLog), 'Send goes through the guarded route to the (fake) pane', note + ' | ' + herdrLog.split('\n').filter((l) => l.startsWith('PROMPT')).join(' / '));
    shot('05-sent.png');

    // A hidden page closes its stream; shown again it takes up what it missed.
    const streams = state('window.__stats.streams');
    ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); return true;`);
    await sleep(300);
    lab.append(other, { reply: 'LAB-MARK-4 written while the page was hidden.' });
    await sleep(1500);
    mark(ev(`return !window.__marks['4'];`), 'a hidden page draws nothing');
    ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); return true;`);
    await until(`return { ok: Boolean(window.__marks['4']) };`, 'the missed turn after the page is shown', 8000);
    mark(state('window.__stats.streams') === streams + 1, 'shown again: one catch-up and a new stream', `streams ${streams} -> ${state('window.__stats.streams')}`);

    // The look at a phone's width, and the dark scheme.
    axi('emulate', '--viewport', '390x800x2');
    await sleep(500);
    shot('06-phone.png');
    mark(ev(`return document.documentElement.scrollWidth <= innerWidth + 1;`), 'no sideways scroll at a phone\'s width');
  } catch (error) {
    mark(false, 'the check ran to the end', error.message);
  } finally { finish(); }
  process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
})();
