#!/usr/bin/env node
'use strict';

// Hiding a message or reply from the reader's view, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own port
// with a fake Herdr (nothing is sent to any pane). By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/hide-check.js <scratch folder> [screenshots folder]
//
// Checks: Hide on a reply takes it out of the conversation and offers Undo; Undo puts it back; a hidden reply stays hidden after the
// browser's own storage is wiped and the page loaded again (the server keeps the set, so the phone agrees with the laptop); Hidden · n
// shows the hidden ones in place, dimmed, each with Show again; a message (not only a reply) can be hidden; the file the server keeps holds
// ids and times, no words of a message; and no session log under the lab's home changed by a single byte.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-hide-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, click, startLab, openPage, pick, finish, sleep } = make('reader-hide-check');

const logsHash = (home) => {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => { for (const name of fs.readdirSync(dir).sort()) { const full = path.join(dir, name); const stat = fs.statSync(full); if (stat.isDirectory()) walk(full); else if (name.endsWith('.jsonl')) hash.update(full).update(fs.readFileSync(full)); } };
  for (const sub of ['.claude', '.claude-personal']) if (fs.existsSync(path.join(home, sub))) walk(path.join(home, sub));
  return hash.digest('hex');
};

const VIEW = `const replies = [...document.querySelectorAll('#main .reply')].filter(r => r.querySelector('button.hide-msg'));
  const inputs = [...document.querySelectorAll('#main .input.captain')];
  const toast = document.getElementById('undo-toast'), toggle = document.getElementById('hidden-toggle');
  return { ok: true, replies: replies.length, firstReply: replies[0] ? replies[0].innerText.slice(0, 60) : '', gone: document.querySelectorAll('#main .gone').length,
    inputs: inputs.length, firstInput: inputs[0] ? inputs[0].innerText.replace(/\\s+/g, ' ').slice(0, 60) : '',
    toast: toast && !toast.hidden ? toast.innerText.replace(/\\s+/g, ' ') : '', toggle: toggle && !toggle.hidden ? toggle.textContent : '', toggleHidden: toggle ? toggle.hidden : null,
    over: document.documentElement.scrollWidth > window.innerWidth + 1 };`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop } = await startLab(folder);
  const file = path.join(lab.home, '.config', 'pmos-transcript-reader', 'hidden.json');
  const saved = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).hidden : []);
  const before = logsHash(lab.home);
  try {
    await openPage(page, '1000x900x1');
    pick('cp-ontology-search'); await sleep(900);
    let s = ev(VIEW);
    const total = s.replies, first = s.firstReply;
    check(total >= 1 && s.toggleHidden === true, 'the lab conversation has replies with a Hide button and no Hidden control yet', JSON.stringify({ total, toggleHidden: s.toggleHidden }));
    axi('screenshot', path.join(shots, 'hide-01-before.png'));

    // ---- Hide a message with a real click (the first Hide on the page is on a message of yours): gone from the view, Undo offered
    const inputsAll = s.inputs;
    click('button', 'Hide'); await sleep(900);
    s = ev(VIEW);
    check(inputsAll >= 1 && s.inputs === inputsAll - 1 && s.replies === total, 'Hide on a message of yours takes it out of the conversation and leaves its reply', JSON.stringify({ inputs: [inputsAll, s.inputs], replies: [total, s.replies] }));
    check(/^Hid the message\./.test(s.toast) && /Undo/.test(s.toast), 'a toast says what was hidden and offers Undo', s.toast);
    check(saved().length === 1 && saved()[0].key.endsWith(':in'), 'the server keeps the id of the message', JSON.stringify(saved().map((h) => h.key.slice(-3))));
    click('button', 'Undo'); await sleep(900);
    s = ev(VIEW);
    check(s.inputs === inputsAll && s.toast === '' && saved().length === 0, 'Undo brings the message back and the server forgets the hide', JSON.stringify({ inputs: s.inputs, saved: saved().length }));

    // ---- Hide a reply: gone, counted, kept without its words
    const hideReply = () => ev(`document.querySelector('#main .reply button.hide-msg').click(); return true;`);
    hideReply(); await sleep(900);
    s = ev(VIEW);
    check(s.replies === total - 1 && s.firstReply !== first, 'Hide takes a reply out of the conversation', JSON.stringify({ was: total, now: s.replies }));
    check(/^Hid the reply\./.test(s.toast), 'the toast says it was a reply', s.toast);
    check(s.toggle === 'Hidden · 1', 'the controls count the hidden reply: Hidden · 1', s.toggle);
    check(saved().length === 1 && saved()[0].key.endsWith(':reply') && !JSON.stringify(saved()).includes(first.slice(0, 20)), 'the server keeps the id and time of the reply, none of its words', JSON.stringify(saved()));
    axi('screenshot', path.join(shots, 'hide-02-hidden-toast.png'));

    // ---- wipe this browser's storage and load the page again: the server's set still hides it (the phone would agree)
    ev(`localStorage.clear(); try { sessionStorage.clear(); } catch (e) {} localStorage.setItem('tr-follow', '0'); return true;`);
    axi('open', 'about:blank'); axi('open', page);
    await until(`return { ok: / · Reader$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the page again');
    pick('cp-ontology-search'); await sleep(1200);
    s = ev(VIEW);
    check(s.replies === total - 1 && s.toggle === 'Hidden · 1', 'with the browser storage wiped and the page loaded again the reply is still hidden', JSON.stringify({ replies: s.replies, toggle: s.toggle }));

    // ---- Hidden · n shows it in place, dimmed, with Show again; pressing it again puts it away
    click('button', 'Hidden · 1'); await sleep(900);
    s = ev(VIEW);
    check(s.replies === total && s.gone === 1, 'Hidden · 1 shows the hidden reply in place, dimmed', JSON.stringify({ replies: s.replies, gone: s.gone }));
    axi('screenshot', path.join(shots, 'hide-03-shown-dimmed.png'));
    click('button', 'Hidden · 1'); await sleep(700);
    s = ev(VIEW);
    check(s.replies === total - 1 && s.gone === 0, 'pressing it again puts the hidden reply away', JSON.stringify({ replies: s.replies, gone: s.gone }));
    click('button', 'Hidden · 1'); await sleep(700);
    click('button', 'Show again'); await sleep(900);
    s = ev(VIEW);
    check(s.replies === total && s.gone === 0 && saved().length === 0, 'Show again on the dimmed reply brings it back for good', JSON.stringify({ replies: s.replies, gone: s.gone, saved: saved().length }));
    click('button', 'Hidden'); await sleep(500);

    // ---- on a phone width nothing overflows and the toast stays reachable
    axi('emulate', '--viewport', '390x800x1'); await sleep(900);
    hideReply(); await sleep(900);
    s = ev(VIEW);
    check(!s.over && /Undo/.test(s.toast), 'at phone width the toast and the pills fit the screen', JSON.stringify({ over: s.over, toast: s.toast }));
    axi('screenshot', path.join(shots, 'hide-04-phone.png'));
    s = ev(`const q = document.getElementById('hidden-quick'); return { ok: true, shown: !q.hidden, label: q.getAttribute('aria-label'), display: getComputedStyle(q).display };`);
    check(s.shown && s.label === 'Hidden · 1' && s.display !== 'none', 'the folded header shows a Hidden icon while the conversation has hidden messages', JSON.stringify(s));
    ev(`document.getElementById('hidden-quick').click(); return true;`); await sleep(800);
    s = ev(VIEW);
    check(s.gone === 1, 'the icon shows the hidden reply in place, as Hidden · n does', JSON.stringify({ gone: s.gone }));
    axi('screenshot', path.join(shots, 'hide-05-phone-shown.png'));
    ev(`document.getElementById('hidden-quick').click(); return true;`); await sleep(500);
    ev(`document.querySelector('#undo-toast button').click(); return true;`); await sleep(500);

    check(logsHash(lab.home) === before, 'no session log of the lab changed by a byte: hiding is a view setting only');
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
