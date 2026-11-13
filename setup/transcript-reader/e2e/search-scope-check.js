#!/usr/bin/env node
'use strict';

// A search of "this conversation" belongs to that conversation, and a search of "all conversations" is the only one that crosses them, in a
// real browser (chrome-devtools-axi), against a lab copy of the reader on its own port with a fake Herdr (nothing is sent to any pane).
// By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/search-scope-check.js <scratch folder> [screenshots folder]
//
// Checks, as the owner asked: a search of this conversation does not follow a switch to another conversation, and is there again when its own
// conversation is shown again; while a conversation has its own search the all-conversations search cannot be turned on (the All chip is off,
// the key does nothing) until that search is closed; the all-conversations search crosses sessions; a conversation with its own search takes the
// screen back from it; and a reload keeps each.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-search-scope-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-search-scope-check');

const STATE = `const row = document.getElementById('search'), q = document.getElementById('search-input');
  const chip = s => document.querySelector('#search [data-scope=' + s + ']');
  return { ok: true, open: !row.hidden, query: q.value, count: document.getElementById('search-count').textContent, note: document.getElementById('search-note').hidden ? '' : document.getElementById('search-note').textContent,
    here: chip('here').getAttribute('aria-pressed'), all: chip('all').getAttribute('aria-pressed'), allOff: chip('all').getAttribute('aria-disabled') === 'true' || chip('all').disabled,
    marked: typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.size : -1, title: document.title.split(' · ')[0] };`;
const type = (text) => ev(`const q = document.getElementById('search-input'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
const key = (k, shift = false) => ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, metaKey: true, shiftKey: ${shift}, bubbles: true, cancelable: true })); return true;`);

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { page, stop } = await startLab(folder);
  try {
    await openPage(page, '1000x900x1');
    pick('cp-ontology-search'); await sleep(900);
    let s = ev(STATE);
    check(s.open === false, 'a page with no search open shows no search row', JSON.stringify(s));

    // ---- a search of this conversation, then another conversation
    key('f'); await sleep(400);
    type('answer'); await sleep(600);
    s = ev(STATE);
    check(s.open && s.query === 'answer' && s.here === 'true' && /of|match|message/.test(s.count), 'Cmd+F opens a search of this conversation (cp-ontology-search) and finds its words', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'search-01-own.png'));
    pick('cp-whatapps-tool'); await sleep(1000);
    s = ev(STATE);
    check(s.open === false && s.title === 'cp-whatapps-tool', 'switching to another conversation: that search is not there any more', JSON.stringify(s));
    check(s.marked <= 0, 'and nothing in the other conversation is marked by it', JSON.stringify({ marked: s.marked }));
    axi('screenshot', path.join(shots, 'search-02-other.png'));
    pick('cp-ontology-search'); await sleep(1000);
    s = ev(STATE);
    check(s.open && s.query === 'answer' && s.here === 'true', 'back in its own conversation the search is there again with its words', JSON.stringify(s));

    // ---- while it is on, all conversations cannot be turned on
    check(s.allOff === true, 'the All conversations chip is off while this conversation has its own search', JSON.stringify(s));
    key('f', true); await sleep(400);
    s = ev(STATE);
    check(s.open && s.here === 'true' && s.all === 'false', 'Cmd+Shift+F does not turn on all conversations over it', JSON.stringify(s));
    ev(`document.querySelector('#search [data-scope=all]').click(); return true;`); await sleep(400);
    s = ev(STATE);
    check(s.open && s.here === 'true' && s.all === 'false' && /Close/.test(s.note), 'pressing All says to close this conversation\'s search first, and changes nothing', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'search-03-all-off.png'));

    // ---- close it: all conversations can be turned on, and it crosses sessions
    ev(`document.getElementById('search-close').click(); return true;`); await sleep(500);
    s = ev(STATE);
    check(s.open === false, 'closing the search turns the conversation\'s own search off', JSON.stringify(s));
    key('f', true); await sleep(400);
    type('answer'); await sleep(700);
    s = ev(STATE);
    check(s.open && s.all === 'true' && s.here === 'false' && s.allOff === false, 'Cmd+Shift+F now opens the all-conversations search', JSON.stringify(s));
    const allCount = s.count;
    pick('cp-whatapps-tool'); await sleep(1000);
    s = ev(STATE);
    check(s.open && s.all === 'true' && s.query === 'answer' && s.title === 'cp-whatapps-tool', 'the all-conversations search stays on across a switch of conversation', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'search-04-all.png'));

    // ---- a conversation with its own search takes the screen back from it
    ev(`document.querySelector('#search [data-scope=here]').click(); return true;`); await sleep(500);
    type('tool'); await sleep(600);
    s = ev(STATE);
    check(s.open && s.here === 'true' && s.all === 'false' && s.query === 'tool', 'This conversation on an all-conversations search starts this conversation\'s own search', JSON.stringify(s));
    pick('cp-ontology-search'); await sleep(1000);
    s = ev(STATE);
    check(s.open === false, 'the other conversation has no search of its own: nothing shows there', JSON.stringify(s));
    key('f'); await sleep(400);
    type('question'); await sleep(600);
    pick('cp-whatapps-tool'); await sleep(1000);
    s = ev(STATE);
    check(s.open && s.here === 'true' && s.query === 'tool', 'each conversation keeps its own search: the tool pane\'s is back with its words', JSON.stringify(s));

    // ---- a reload keeps the one on screen, and the other one waits in its conversation
    axi('open', 'about:blank'); axi('open', page);
    await until(`return { ok: / · Reader$/.test(document.title) && document.getElementById('main').children.length > 0 };`, 'the page again');
    await sleep(900);
    s = ev(STATE);
    check(s.open && s.query === 'tool' && s.here === 'true', 'a reload keeps the conversation\'s own search', JSON.stringify(s));
    pick('cp-ontology-search'); await sleep(1000);
    s = ev(STATE);
    check(s.open && s.query === 'question' && s.here === 'true', 'and the other conversation\'s own search, kept through the reload', JSON.stringify(s));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
