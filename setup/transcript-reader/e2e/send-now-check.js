#!/usr/bin/env node
'use strict';

// Send now empties the message box at once, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own port with a
// fake Herdr (nothing is typed into a real pane; the owner's server and reading list are not touched). By hand, not part of `node --test`
// (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/send-now-check.js <scratch folder> [screenshots folder]
//
// The fake Herdr takes 0.1 s for each of the 25 calls that empty the pane's input box (the first step of a send; a real pane takes a second or more), which is the
// stretch in which the owner saw the words still in the box after pressing Send now. It checks: the box locked with its words through the
// Undo window and Undo giving them back; Send now (the Now button, the faded message's button and Enter) emptying the box and the pointer
// at once, the box free to type in while the pane still takes the message; the end of the window doing the same; a failed send putting the
// words back in an empty box, or into the batch when something else was typed meanwhile; and a batch going out with the box.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-send-now-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-send-now-check');

const BOX = `const b = document.getElementById('dock-text'); const q = i => document.getElementById(i);
  return { ok: true, value: b.value, readOnly: b.readOnly, send: q('dock-send').textContent, sendOff: q('dock-send').disabled, add: q('dock-add').textContent, status: q('dock-status').textContent,
    batch: q('dock-batch').hidden ? 0 : document.querySelectorAll('#dock-batch-list li').length, faded: [...document.querySelectorAll('.pending')].map(n => n.innerText.replace(/\\s+/g, ' ').slice(0, 90)) };`;
const type = (text) => ev(`const b = document.getElementById('dock-text'); b.value = ${JSON.stringify(text)}; b.dispatchEvent(new Event('input', { bubbles: true })); return true;`);

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop } = await startLab(folder);
  const control = (value) => fs.writeFileSync(path.join(folder, 'control.json'), JSON.stringify(value));
  // One entry per prompt the fake Herdr was asked to type (a message can run over several lines).
  const prompts = () => (fs.existsSync(lab.log) ? fs.readFileSync(lab.log, 'utf8').split(/^(?=PROMPT)/m) : []).filter((l) => /^PROMPT/.test(l));
  try {
    control({ delay_ms: 100 });
    await openPage(page, '1000x900x1');
    pick('cp-ontology-search'); await sleep(900);
    let s = ev(BOX);
    check(/To cp-ontology-search/.test(s.status) && s.value === '', 'the box is empty and aims at the picked pane', s.status);

    // ---- Undo: the box holds its words, locked, and gives them back
    type('first message');
    ev(`document.getElementById('dock-send').click(); return true;`); await sleep(600);
    s = ev(BOX);
    check(s.readOnly && s.value === 'first message' && /^Undo/.test(s.send) && s.add === 'Now', 'Send holds the message: the box stays locked with its words, Send reads Undo, Add reads Now', JSON.stringify(s));
    ev(`document.getElementById('dock-send').click(); return true;`); await sleep(600);
    s = ev(BOX);
    check(!s.readOnly && s.value === 'first message' && prompts().length === 0, 'Undo gives the words back in an unlocked box and nothing was sent', JSON.stringify({ value: s.value, sent: prompts().length }));

    // ---- Send now, by the Now button: the box is empty at once, while the pane is still taking the message
    ev(`document.getElementById('dock-send').click(); return true;`); await sleep(500);
    ev(`document.getElementById('dock-add').click(); return true;`);
    const t0 = Date.now(); await sleep(250);
    s = ev(BOX);
    check(s.value === '' && !s.readOnly && prompts().length === 0, 'Send now (Now): the box is empty within a quarter of a second, before the pane has the message', `${Date.now() - t0} ms; ${JSON.stringify({ value: s.value, readOnly: s.readOnly, sent: prompts().length })}`);
    check(s.faded.some((t) => /first message/.test(t)), 'the message shows in the conversation, faded, as the one on its way', s.faded.join(' | '));
    type('the next one, typed while it goes'); await sleep(200);
    s = ev(BOX);
    check(s.value === 'the next one, typed while it goes', 'the box takes the next message while the first is still going', s.value);
    axi('screenshot', path.join(shots, 'send-now-1-going.png'));
    for (let i = 0; i < 40 && prompts().length === 0; i++) await sleep(250);
    await sleep(800);
    s = ev(BOX);
    check(prompts().length === 1 && /first message/.test(prompts()[0]) && s.value === 'the next one, typed while it goes', 'the pane got the first message once, and what was typed meanwhile is untouched', `${prompts().length} sent; box "${s.value}"`);
    ev(`const b = document.getElementById('dock-text'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); return true;`);

    // ---- Send now, by the faded message's own button
    type('second message');
    ev(`document.getElementById('dock-send').click(); return true;`); await sleep(500);
    ev(`[...document.querySelectorAll('.pending .reply-to')].find((b) => b.textContent === 'Send now').click(); return true;`); await sleep(250);
    s = ev(BOX);
    check(s.value === '' && prompts().length === 1, 'Send now on the faded message empties the box at once too', JSON.stringify({ value: s.value, sent: prompts().length }));
    for (let i = 0; i < 40 && prompts().length < 2; i++) await sleep(250);
    check(prompts().length === 2 && /second message/.test(prompts()[1]), 'and it is sent', prompts()[1] || 'nothing');

    // ---- the end of the Undo window does the same
    type('third message');
    ev(`document.getElementById('dock-send').click(); return true;`); await sleep(5800);
    s = ev(BOX);
    check(s.value === '' && !s.readOnly && prompts().length === 2, 'when the Undo window ends the box is empty while the pane still takes the message', JSON.stringify({ value: s.value, sent: prompts().length }));
    for (let i = 0; i < 40 && prompts().length < 3; i++) await sleep(250);
    check(prompts().length === 3, 'the third message is sent', String(prompts().length));

    // ---- a batch goes out with the box, and the batch is empty at once too
    control({ delay_ms: 100 });
    type('comment one');
    ev(`document.getElementById('dock-add').click(); return true;`); await sleep(300);
    type('comment two');
    s = ev(BOX);
    check(s.batch === 1 && /Send 2/.test(s.send), 'a batch of one comment and one in the box reads Send 2', JSON.stringify({ batch: s.batch, send: s.send }));
    ev(`document.getElementById('dock-send').click(); return true;`); await sleep(500);
    ev(`document.getElementById('dock-add').click(); return true;`); await sleep(250);
    s = ev(BOX);
    check(s.value === '' && s.batch === 0, 'Send now empties the box and the batch at once', JSON.stringify({ value: s.value, batch: s.batch }));
    for (let i = 0; i < 40 && prompts().length < 4; i++) await sleep(250);
    check(prompts().length === 4 && /comment one/.test(prompts()[3]) && /comment two/.test(prompts()[3]), 'the pane got both comments in one message', prompts()[3] || 'nothing');

    // ---- a send that fails: the words come back into the empty box
    control({ delay_ms: 30, fail_prompt: true });
    type('this one is refused');
    ev(`document.getElementById('dock-send').click(); return true;`); await sleep(500);
    ev(`document.getElementById('dock-add').click(); return true;`); await sleep(200);
    s = ev(BOX);
    check(s.value === '', 'a message on its way has left the box, even though it may still fail', JSON.stringify({ value: s.value }));
    await until(`const b = document.getElementById('dock-text'); return { ok: b.value === 'this one is refused', value: b.value };`, 'the refused message back in the box', 15000);
    s = ev(BOX);
    check(s.value === 'this one is refused' && !s.readOnly && !s.faded.some((t) => /this one is refused/.test(t)) && s.batch === 0, 'refused, the message is back in the box, the box unlocked, no faded copy of it left', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'send-now-2-refused.png'));
    // and the batch with it
    ev(`const b = document.getElementById('dock-text'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); return true;`);

    // ---- refused while something else was typed: nothing is overwritten, the refused words go to the batch
    control({ delay_ms: 40, fail_prompt: true });
    type('refused, with a batch');
    ev(`document.getElementById('dock-add').click(); return true;`); await sleep(300);
    type('and a box');
    ev(`document.getElementById('dock-send').click(); return true;`); await sleep(500);
    ev(`document.getElementById('dock-add').click(); return true;`); await sleep(250);
    type('typed while it was going');
    await until(`const t = document.getElementById('dock-status').textContent; return { ok: /did not accept/.test(t) && !document.getElementById('dock-text').readOnly, t };`, 'the refusal', 15000);
    await sleep(500);
    s = ev(BOX);
    check(s.value === 'typed while it was going' && s.batch === 2, 'refused while the box holds new words: the new words stay in the box, the refused ones are back in the batch', JSON.stringify({ value: s.value, batch: s.batch, status: s.status }));
    axi('screenshot', path.join(shots, 'send-now-3-refused-batch.png'));
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  }
  finish(stop);
})();
