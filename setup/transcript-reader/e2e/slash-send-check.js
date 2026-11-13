#!/usr/bin/env node
'use strict';

// A slash command or a skill reference typed in the conversation's message box, in a real browser (chrome-devtools-axi), against a lab copy of
// the reader on its own port with a fake Herdr (nothing is typed into a real pane; the owner's server is not touched). By hand, not part of
// `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/slash-send-check.js <scratch folder> [screenshots folder]
//
// The page runs with window.confirm answering "no" at once, as it does in Conn's web view and in the Integrated Browser of VS Code (neither shows a
// native dialog), which is how the owner meets it. The fake Herdr records each call, so the run shows what the pane would have been given.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-slash-send-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-slash-send-check');

const BOX = `const q = i => document.getElementById(i); const b = q('dock-text');
  return { value: b.value, readOnly: b.readOnly, send: q('dock-send').textContent, sendOff: q('dock-send').disabled, add: q('dock-add').textContent, status: q('dock-status').textContent,
    faded: [...document.querySelectorAll('.pending')].map(n => n.innerText.replace(/\\s+/g, ' ').slice(0, 120)) };`;
const type = (text) => ev(`const b = document.getElementById('dock-text'); b.value = ${JSON.stringify(text)}; b.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
const press = () => ev(`document.getElementById('dock-send').click(); return true;`);

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop } = await startLab(folder);
  const control = (value) => fs.writeFileSync(path.join(folder, 'control.json'), JSON.stringify(value));
  // The calls the fake Herdr recorded that reached a pane as text or an Enter (the keys that empty the input box are left out).
  const calls = () => (fs.existsSync(lab.log) ? fs.readFileSync(lab.log, 'utf8').split('\n') : []).filter((l) => /^(PROMPT|TEXT|KEYS .* enter$)/.test(l) || /^KEYS \S+ \S+ enter$/.test(l));
  try {
    control({ delay_ms: 5 });
    await openPage(page, '1000x900x1');
    ev(`window.__asked = []; window.confirm = (m) => { window.__asked.push(m); return false; }; return true;`);
    pick('cp-whatapps-tool'); await sleep(900);
    let s = ev(BOX);
    check(/To cp-whatapps-tool/.test(s.status), 'the box aims at the picked Claude pane', s.status);

    // A plain message, for comparison: held, then sent.
    type('a plain message'); press(); await sleep(400);
    s = ev(BOX);
    check(/^Undo/.test(s.send), 'plain: Send holds the message for the Undo window', JSON.stringify(s));
    ev(`document.getElementById('dock-add').click(); return true;`);
    for (let i = 0; i < 40 && calls().length < 1; i++) await sleep(250);
    check(calls().length === 1 && /a plain message/.test(calls()[0]), 'plain: the pane was given the message', JSON.stringify(calls()));

    for (const text of ['/bearings', '/bearings plain', '/clear']) {
      const before = calls().length;
      type(text); await sleep(200);
      s = ev(BOX);
      check(!s.sendOff, `${text}: Send is on`, JSON.stringify({ send: s.send, off: s.sendOff, status: s.status }));
      press(); await sleep(500);
      s = ev(BOX);
      let asked = ev(`return window.__asked.slice();`);
      check(asked.length === 0, `${text}: no native dialog is asked`, JSON.stringify(asked));
      if (text === '/clear') {
        // The page asks for itself: Send reads Confirm and Add reads Keep, and nothing is held or sent yet.
        check(s.send === 'Confirm /clear' && s.add === 'Keep' && !s.readOnly && /Send \/clear to cp-whatapps-tool\? It starts that session over/.test(s.status), '/clear: the first press asks in the page (Confirm / Keep)', JSON.stringify(s));
        axi('screenshot', path.join(shots, 'slash-clear-asked.png'));
        await sleep(1500);
        check(calls().length === before, '/clear: nothing is sent while the question is open', JSON.stringify(calls().slice(before)));
        // Keep leaves the command in the box, unsent.
        ev(`document.getElementById('dock-add').click(); return true;`); await sleep(300);
        s = ev(BOX);
        check(s.send === 'Send' && s.add === 'Add' && s.value === '/clear' && calls().length === before, '/clear: Keep closes the question and leaves the words in the box', JSON.stringify(s));
        // Esc does the same.
        press(); await sleep(300);
        ev(`document.getElementById('dock-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true;`); await sleep(300);
        s = ev(BOX);
        check(s.send === 'Send' && s.value === '/clear', '/clear: Esc closes the question too', JSON.stringify(s));
        // Changing the words closes it, and a press on the new words asks about those.
        press(); await sleep(300);
        type('/clear'); await sleep(200);
        s = ev(BOX);
        check(s.send === 'Confirm /clear', '/clear: the same words typed again keep the question open (it is about this text)', JSON.stringify(s));
        type('/clear now'); await sleep(200);
        s = ev(BOX);
        check(s.send === 'Send', '/clear: other words close the question', JSON.stringify(s));
        type('/clear'); await sleep(200);
        press(); await sleep(300);
        s = ev(BOX);
        check(s.send === 'Confirm /clear', '/clear: asked again for a new press', JSON.stringify(s));
        press(); await sleep(500);
        s = ev(BOX);
      }
      check(/^Undo/.test(s.send), `${text}: Send holds it for the Undo window`, JSON.stringify({ send: s.send, readOnly: s.readOnly }));
      if (/^Undo/.test(s.send)) { ev(`document.getElementById('dock-add').click(); return true;`); }
      else { axi('screenshot', path.join(shots, `slash-${text.replace(/\W+/g, '-')}-stuck.png`)); }
      for (let i = 0; i < 40 && calls().length <= before; i++) await sleep(250);
      await sleep(1500);
      check(calls().slice(before).some((l) => l.includes(text) && l.trim().endsWith(text)), `${text}: the pane was given exactly what was typed`, JSON.stringify(calls().slice(before)));
      asked = ev(`return window.__asked.slice();`);
      check(asked.length === 0, `${text}: and no native dialog was ever asked`, JSON.stringify(asked));
      type(''); await sleep(300);
    }
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  }
  finish(stop);
})();
