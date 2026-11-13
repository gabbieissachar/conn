#!/usr/bin/env node
'use strict';

// A session the reader does not list is shown as itself, never as another conversation, in a real (headless) browser (chrome-devtools-axi), against a lab
// copy of the reader on its own port with a fake Herdr (nothing is sent to any pane). By hand, not part of `node --test`:
//
//   node setup/transcript-reader/e2e/session-unlisted-check.js <scratch folder> [screenshots folder]
//
// Nathan, 2026-11-08: picking a session the reader does not list fell back to another conversation: a page opened on #s=<that session> drew the list's first
// conversation (chooseOpening) and an address followed in the open page stayed on the conversation that was open (followAddress), both with the message
// box aimed at that other conversation's pane. Now both show "No transcript yet for this session", with no message box, until a build lists the session,
// when the page opens it in place. Checked on the full page and on the lite page.

const fs = require('fs');
const path = require('path');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-session-unlisted-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-session-unlisted-check');

const GHOST = 'deadbeef-0000-4000-8000-00000000d00d';  // a session no log, pane or list has
const iso = (at) => new Date(at * 1000).toISOString();
const STATE = `const sel = document.querySelector('select[name=session]'); const chosen = sel ? sel.options[sel.selectedIndex] : null; const dock = document.getElementById('dock');
  return { ok: document.getElementById('main').children.length > 0, hash: location.hash, title: document.title, chosen: chosen ? chosen.text : null, main: document.getElementById('main').innerText.slice(0, 80),
    turns: document.querySelectorAll('#main .reply, #main .you').length, dock: dock ? !dock.hidden : null, note: [...document.querySelectorAll('.kept-note')].map(n => n.textContent).join(' | '), listing: [...document.querySelectorAll('.follow-note')].map(n => n.textContent).join('') };`;

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop, outDir } = await startLab(folder);
  try {
    const base = page.replace(/prototype\.html.*$/, '');
    for (const [name, url, ready] of [['full page', page, /^ ?· Reader|Reader$/], ['lite page', base + 'live/index.html', /Reader$/]]) {
      // ---- opened on an address that names it
      axi('open', 'about:blank'); axi('emulate', '--viewport', '1000x900x1');
      axi('open', url + '#s=' + GHOST.slice(0, 8)); await sleep(1500);
      ev(`localStorage.setItem('tr-follow', '0'); return true;`);
      axi('open', 'about:blank'); axi('open', url + '#s=' + GHOST.slice(0, 8));
      let s = await until(STATE, name + ' opened on the unlisted session');
      check(/No transcript yet for this session/.test(s.main) && s.turns === 0, `${name}: opened on an unlisted session's address it says so, and draws no conversation`, JSON.stringify([s.main, s.turns]));
      check(s.chosen === 'No transcript yet · deadbeef', `${name}: the picker holds that session, not another`, String(s.chosen));
      check(s.dock === false, `${name}: and there is no message box, so nothing can go to another pane`, String(s.dock));
      check(s.hash === '#s=deadbeef', `${name}: the address still names it`, s.hash);
      check(/No transcript yet for this session \(deadbeef\)/.test(s.note), `${name}: the note says which session`, s.note);
      axi('screenshot', path.join(shots, `unlisted-1-${name.split(' ')[0]}.png`));
      await sleep(5500);  // two polls and a wait for builds
      s = ev(STATE);
      check(/No transcript yet/.test(s.main) && s.hash === '#s=deadbeef' && s.dock === false, `${name}: and it stays through the page's polls`, JSON.stringify([s.main, s.hash]));

      // ---- picking another conversation leaves it; its box is that conversation's
      pick('crew-2'); await sleep(1500);
      s = ev(STATE);
      check(/crew-2/.test(s.chosen || '') && s.turns > 0 && s.dock === true && !/deadbeef/.test(s.hash), `${name}: picking crew-2 shows crew-2 with its message box`, JSON.stringify([s.chosen, s.turns, s.dock, s.hash]));
      check(!ev(`return { ok: true, has: [...document.querySelectorAll('select[name=session] option')].some(o => /No transcript yet/.test(o.text)) };`).has, `${name}: and the unlisted session is not left in the picker`);

      // ---- an address followed in the open page
      ev(`location.hash = '#s=${GHOST.slice(0, 8)}'; return true;`); await sleep(1500);
      s = ev(STATE);
      check(/No transcript yet for this session/.test(s.main) && s.turns === 0 && s.dock === false && /deadbeef/.test(s.hash), `${name}: an address followed in the open page shows it, and does not stay on crew-2`, JSON.stringify([s.main, s.turns, s.dock, s.hash]));
      ev(`location.hash = '#s=${lab.crew[2]}'; return true;`); await sleep(1500);
      s = ev(STATE);
      check(s.turns > 0 && s.dock === true && /crew-3/.test(s.chosen || ''), `${name}: and an address that is listed still opens its conversation`, JSON.stringify([s.chosen, s.turns, s.dock]));
    }

    // ---- the session gets its transcript: the page opens it in place (full page)
    axi('open', 'about:blank'); axi('open', page + '#s=' + GHOST.slice(0, 8));
    await until(STATE, 'the full page on the ghost again');
    const log = path.join(lab.home, '.claude', 'projects', '-lab-ghost', GHOST + '.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const at = Date.now() / 1000;
    fs.writeFileSync(log, [
      { type: 'user', uuid: 'u-ghost-1', timestamp: iso(at - 5), cwd: '/lab/ghost', message: { role: 'user', content: 'The question that gives this session its transcript' } },
      { type: 'assistant', timestamp: iso(at), cwd: '/lab/ghost', message: { role: 'assistant', content: [{ type: 'text', text: 'The first answer.' }] } },
    ].map((r) => JSON.stringify(r) + '\n').join(''));
    fs.appendFileSync(path.join(outDir, 'sessions.txt'), GHOST + '\n');
    const opened = await until(`const m = document.getElementById('main').innerText; return { ok: /first answer/.test(m), main: m.slice(0, 60), note: [...document.querySelectorAll('.kept-note')].length, hash: location.hash };`, 'the session opened in place once it had a transcript', 60000);
    check(opened.note === 0, 'when a build lists the session, the page opens it in place and the note goes', JSON.stringify(opened));
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
