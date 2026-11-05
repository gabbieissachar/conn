#!/usr/bin/env node
'use strict';

// A build that changes another conversation no longer draws the conversation on screen again, in a real (headless) browser
// (chrome-devtools-axi), against a lab copy of the reader on its own port with a fake Herdr. By hand, not part of `node --test` (it needs
// chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/redraw-check.js <scratch folder> [screenshots folder]
//
// The page shows one long conversation (LAB_BIG_EXCHANGES, 120 exchanges). For each build the check counts the DOM nodes added to #main
// (a MutationObserver), whether a turn's element is still the same one (an expando put on it), where the page is scrolled and what a reply
// the reader opened is doing:
//   - a build of ANOTHER conversation that reaches the page as a delta,
//   - the same through the full page (the delta route made to fail, so the page reads the whole build: new objects, same content),
//   - a build of the conversation ON SCREEN, which must draw it again, with the new reply in it,
//   - and the lite page (out/live), which takes builds through its index and has the same two cases (another conversation, then this one).
// For the first two the picker (part of the controls, which are still drawn) must show the other conversation's new name, so the header
// is not stale, and nothing may be added to #main.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-redraw-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
process.env.LAB_BIG_EXCHANGES = process.env.LAB_BIG_EXCHANGES || '120';
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-redraw-check');

const iso = (at) => new Date(at).toISOString();

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop } = await startLab(folder);
  const world = () => JSON.parse(fs.readFileSync(lab.world, 'utf8'));
  const rename = (tab, label) => { const w = world(); w.sessions[0].tabs.find((t) => t.tab_id === tab).label = label; fs.writeFileSync(lab.world, JSON.stringify(w, null, 1)); };
  const logOf = (n) => path.join(lab.home, '.claude', 'projects', `-lab-crew-${n}`, `${lab.crew[n - 1]}.jsonl`);
  // A new exchange at the end of crew-n's conversation: the next build of the reader is for it.
  const reply = (n, text) => {
    const at = Date.now();
    fs.appendFileSync(logOf(n), [
      { type: 'user', uuid: `u-new-${n}-${at}`, timestamp: iso(at - 5000), cwd: `/lab/crew-${n}`, message: { role: 'user', content: `A new question in crew-${n}` } },
      { type: 'assistant', timestamp: iso(at), cwd: `/lab/crew-${n}`, message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
  };
  const seen = () => ev(`return { ok: true, added: window.__added, fetches: window.__fetches.slice(), kept: Boolean(window.__turn && window.__turn.isConnected && window.__turn.__kept === 'same'), y: Math.round(window.scrollY), open: window.__more ? window.__more.getAttribute('aria-expanded') : null, turns: document.querySelectorAll('#main [id^=ex-]').length, mainText: document.getElementById('main').innerText.includes('FRESH-REPLY') };`);
  const options = () => ev(`return [...document.querySelectorAll('select[name=session] option')].map(o => o.text).join(' | ');`);
  // What the page does at a build: its fetches (a delta, or the page) tell a build has been taken.
  const arm = () => ev(`window.__added = 0; window.__fetches = []; return true;`);
  async function build(what) {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const s = seen();
      if (s.fetches.some((name) => name === 'delta' || name === 'page' || name === 'index.json')) { await sleep(900); return seen(); }
      await sleep(300);
    }
    throw new Error('the page took no build for: ' + what);
  }

  // On the page just opened: count what is added to #main, note the fetches, mark a turn, open a clipped reply and scroll. Answers the turns shown.
  function prepare() {
    ev(`window.__mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) window.__added += 1 + n.getElementsByTagName('*').length; }); window.__mo.observe(document.getElementById('main'), { childList: true, subtree: true }); window.__added = 0; window.__fetches = []; return true;`);
    ev(`const f = window.fetch; window.__failDelta = false; window.fetch = function (...a) { const url = String((a[0] && a[0].url) || a[0]).split('?')[0]; const name = url.split('/').pop(); if (window.__failDelta && name === 'delta') return Promise.reject(new Error('delta route down')); return f.apply(this, a).then((r) => { window.__fetches.push(name); return r; }); }; return true;`);
    const total = ev(`return document.querySelectorAll('#main [id^=ex-]').length;`);
    ev(`const t = document.querySelectorAll('#main [id^=ex-]')[40]; t.__kept = 'same'; window.__turn = t; window.__more = null; return true;`);
    ev(`const m = [...document.querySelectorAll('#main button.more')].find((b) => b.getAttribute('aria-expanded') === 'false'); if (m) { m.click(); window.__more = m; } return Boolean(m);`);
    ev(`window.scrollTo(0, 2600); return true;`);
    return total;
  }

  try {
    await openPage(page, '1000x900x1');
    pick('crew-3'); await sleep(1200);
    const total = prepare();
    check(total >= 100, 'the page shows a long conversation (crew-3)', `${total} turns`);
    await sleep(400);
    const before = seen();
    check(before.open === 'true' || before.open === null, 'a clipped reply is open on the page (or none is clipped)', String(before.open));
    arm();

    // ---- 1. another conversation's build, as a delta
    rename('w1:t6', 'crew-2 renamed once');
    reply(2, 'a reply in another conversation');
    let s = await build('another conversation, delta');
    let names = options();
    check(s.fetches.includes('delta') && !s.fetches.includes('page'), 'the build came as a delta', s.fetches.join(','));
    check(s.added === 0, 'another conversation changed: nothing was added to the page of the one on screen', `${s.added} nodes added`);
    check(s.kept && s.turns === total, 'the turn marked on the page is still the same element, all turns still there', JSON.stringify({ kept: s.kept, turns: s.turns }));
    check(Math.abs(s.y - 2600) <= 3 && s.open === before.open, 'the page stayed where it was and the opened reply stayed open', JSON.stringify({ y: s.y, open: s.open }));
    check(/crew-2 renamed once/.test(names), 'the header is not stale: the picker names the other conversation as it is now', names.slice(0, 200));
    axi('screenshot', path.join(shots, 'redraw-1-delta.png'));

    // ---- 2. the same, but the page has to read the whole build
    arm(); ev(`window.__failDelta = true; return true;`);
    rename('w1:t8', 'crew-4 renamed');
    reply(4, 'a reply in a third conversation');
    s = await build('another conversation, full page');
    names = options();
    check(s.fetches.includes('page') && !s.fetches.includes('delta'), 'the build came as the full page', s.fetches.join(','));
    check(s.added === 0, 'the full page of a build that changed another conversation adds nothing either (same content, new objects)', `${s.added} nodes added`);
    check(s.kept && s.turns === total && Math.abs(s.y - 2600) <= 3, 'the marked turn is the same element and the place is kept', JSON.stringify({ kept: s.kept, turns: s.turns, y: s.y }));
    check(/crew-4 renamed/.test(names), 'the header follows here too', names.slice(0, 220));
    ev(`window.__failDelta = false; return true;`);

    // ---- 3. the conversation on screen changed: it is drawn again, with the new reply
    arm();
    reply(3, 'FRESH-REPLY in the conversation on screen');
    s = await build('the conversation on screen');
    check(s.added > 100 && !s.kept, 'the conversation on screen changed: it is drawn again', JSON.stringify({ added: s.added, kept: s.kept }));
    check(s.mainText && s.turns === total + 1, 'and the new reply is on the page', JSON.stringify({ turns: s.turns, text: s.mainText }));
    axi('screenshot', path.join(shots, 'redraw-3-changed.png'));

    // ---- 4. the lite page (out/live), which takes builds through its index: another conversation's build, then the one on screen
    axi('open', 'about:blank');
    axi('open', page.replace('prototype.html', 'live/index.html') + '#s=' + lab.crew[2].slice(0, 8));
    await until(`return { ok: document.querySelectorAll('#main [id^=ex-]').length > 100 };`, 'the lite page');
    await sleep(800);
    const liteTotal = prepare();
    check(liteTotal === total + 1, 'the lite page shows the same conversation', `${liteTotal} turns`);
    arm();
    rename('w1:t6', 'crew-2 renamed twice');
    reply(2, 'another reply in another conversation');
    s = await build('the lite page, another conversation');
    check(s.added === 0 && s.kept && s.turns === liteTotal && Math.abs(s.y - 2600) <= 3, 'lite: another conversation changed, and nothing on the page was drawn again', JSON.stringify({ added: s.added, kept: s.kept, turns: s.turns, y: s.y }));
    check(/crew-2 renamed twice/.test(options()), 'lite: the picker is current', options().slice(0, 160));
    arm();
    reply(3, 'FRESH-REPLY in the conversation on the lite page');
    s = await build('the lite page, this conversation');
    check(s.added > 100 && !s.kept && s.turns === liteTotal + 1 && s.mainText, 'lite: the conversation on screen changed, so it is drawn again with the new reply', JSON.stringify({ added: s.added, kept: s.kept, turns: s.turns, text: s.mainText }));
    axi('screenshot', path.join(shots, 'redraw-4-lite.png'));
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  }
  finish(stop);
})();
