#!/usr/bin/env node
'use strict';

// A Claude permission ask answered from the reader page, in a real browser (chrome-devtools-axi), against a lab copy of the reader on its own port
// with a fake Herdr and a SCRATCH Claude config folder (nothing real is touched: no pane, no ~/.claude, no live settings, not port 8768). By hand,
// not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/permission-ask-check.js <scratch folder> [screenshots folder]
//
// What stands in for Claude Code: the check installs the hook into <folder>/claude-config/settings.json with the hook's own `install` command, reads
// the hook command back out of that settings file, and runs exactly that command line with the PermissionRequest JSON on stdin, as Claude Code does.
// The fake Herdr reports the pane as blocked and records every key or text it is given, which this check requires to be none.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-permission-ask-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { check, axi, ev, until, startLab, openPage, pick, finish, sleep } = make('reader-permission-ask-check');

const COMMAND = 'cd /lab/crew-1 && python3 build.py --out dist \\\n  --flag "a;b" | tee build.log && echo done';
const ask = (extra = {}) => ({ session_id: null, cwd: '/lab/crew-1', permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: COMMAND, description: 'Build the docs and keep a log' }, ...extra });

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop, outDir, port } = await startLab(folder, { PMOS_READER_PERMISSIONS: '1' });
  const crew = lab.crew[0];
  const world = () => JSON.parse(fs.readFileSync(lab.world, 'utf8'));
  const setStatus = (status) => { const w = world(); w.sessions[0].panes.find((p) => p.pane_id === 'w3:p1').agent_status = status; fs.writeFileSync(lab.world, JSON.stringify(w, null, 1)); };
  const herdrCalls = () => (fs.existsSync(lab.log) ? fs.readFileSync(lab.log, 'utf8').split('\n') : []).filter((l) => /^(KEYS|PROMPT|TEXT)/.test(l));

  // The scratch Claude config folder, set up with the hook's own installer; the command Claude Code would run is read back from the file it wrote.
  const config = path.join(folder, 'claude-config');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } }, null, 2));
  const hookScript = path.join(lab.repo, 'setup', 'transcript-reader', 'hooks', 'permission-hook.py');
  const installed = execFileSync('python3', ['-I', hookScript, 'install', '--config-dir', config, '--apply'], { encoding: 'utf8' });
  check(/Written/.test(installed), 'the installer wrote the scratch settings.json', installed.split('\n')[0]);
  const settings = JSON.parse(fs.readFileSync(path.join(config, 'settings.json'), 'utf8'));
  const commandLine = settings.hooks.PermissionRequest[0].hooks[0].command;
  check(settings.hooks.Stop && settings.model === 'x', 'the other hooks and keys of the scratch settings are kept');
  const runClaudeHook = (payload) => {
    const child = spawn('sh', ['-c', commandLine], { env: { PATH: process.env.PATH, HOME: lab.home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
    child.stdin.end(JSON.stringify({ ...payload, session_id: payload.session_id || crew }));
    return { child, done };
  };
  const cards = `return [...document.querySelectorAll('#main .ask-card')].map(c => ({ cls: c.className, head: c.querySelector('.ask-head').innerText.replace(/\\s+/g, ' '), foot: c.querySelector('.ask-foot').innerText.replace(/\\s+/g, ' '), buttons: [...c.querySelectorAll('.ask-foot button')].map(b => b.textContent + (b.disabled ? '(off)' : '')) }));`;
  const dockSays = `const b = document.getElementById('dock-status'); return { status: b ? b.textContent : '', send: document.getElementById('dock-send').disabled };`;

  try {
    await openPage(page, '1440x900x1');
    pick('crew-1'); await sleep(900);
    check(ev(`return /crew-1/.test(document.querySelector('select[name=session]').selectedOptions[0].text);`), 'the page is open on crew-1');

    // ---- an ask arrives while the page is open and the pane is at its prompt
    setStatus('blocked');
    const first = runClaudeHook(ask());
    await until(`return { ok: document.querySelectorAll('#main .ask-card.open').length === 1 };`, 'the card');
    let c = ev(cards);
    check(c.length === 1 && /needs you/i.test(c[0].head) && /Claude asks to run a command/.test(c[0].head), 'the open ask is a card at the end of the conversation', JSON.stringify(c[0]));
    const shown = ev(`const pre = [...document.querySelectorAll('#main .ask-card pre')].find(p => p.getAttribute('aria-label') === 'command'); return { text: pre ? pre.textContent : null, where: document.querySelector('#main .ask-card .ask-where').textContent, last: document.querySelector('#main').lastElementChild.classList.contains('ask-card') };`);
    check(shown.text === COMMAND, 'the command is shown whole, line breaks and quoting as it was', JSON.stringify(shown.text));
    check(/\/lab\/crew-1/.test(shown.where) && shown.last, 'it says where it runs and sits last, where the session stopped');
    check(c[0].buttons.join('|') === 'Allow once|Deny', 'only Allow once and Deny are offered', c[0].buttons.join('|'));
    check(!/don't ask again/i.test(c[0].foot), 'no standing grant is offered');
    let d = ev(dockSays);
    check(/Answer it above/.test(d.status) && d.send, 'Send says to answer the ask above, and is off', JSON.stringify(d));
    axi('screenshot', path.join(shots, 'ask-open-1440-light.png'));

    // ---- Allow once, with Undo inside the window: nothing is answered
    ev(`document.querySelector('#main .ask-card.open .btn.allow').click(); return true;`);
    await sleep(500);
    c = ev(cards);
    check(c[0].buttons.length === 1 && /^Undo \d/.test(c[0].buttons[0]) && /Allowing in \d s/.test(c[0].foot), 'Allow once holds the answer, with a countdown and Undo', JSON.stringify(c[0]));
    axi('screenshot', path.join(shots, 'ask-hold-1440-light.png'));
    ev(`document.querySelector('#main .ask-card.open .btn.undo').click(); return true;`);
    await sleep(3800);
    c = ev(cards);
    check(c.length === 1 && /open/.test(c[0].cls) && c[0].buttons.join('|') === 'Allow once|Deny', 'Undo took it back: still open, nothing sent', JSON.stringify(c[0]));
    check((await Promise.race([first.done.then(() => 'answered'), sleep(100).then(() => 'held')])) === 'held', 'the hook is still waiting after Undo');

    // ---- the dialog is answered in the pane: Herdr stops seeing the prompt, the card becomes the record, and the hook is let go with no decision
    setStatus('working');
    await until(`return { ok: !!document.querySelector('#main .ask-card.elsewhere') };`, 'the card ending as answered in the pane', 15000);
    c = ev(cards);
    check(/Answered in the pane, not here/.test(c[0].foot) && c[0].buttons.length === 0, 'a prompt answered in the pane ends the card by itself ("Answered in the pane, not here")', c[0].foot);
    const letGo = await first.done;
    check(letGo.code === 0 && letGo.out === '', 'and the hook printed nothing, so the pane\'s own dialog is left as it is', JSON.stringify(letGo.out));
    d = ev(dockSays);
    check(!/Answer it above/.test(d.status), 'Send no longer points at an ask', d.status);
    axi('screenshot', path.join(shots, 'ask-elsewhere-1440-light.png'));

    // ---- a new ask while the pane is at a prompt again; Allow once for real: the hook prints Claude Code's allow JSON, the card becomes the record
    setStatus('blocked'); await sleep(1200);
    const allowed = runClaudeHook(ask());
    await until(`return { ok: document.querySelectorAll('#main .ask-card.open').length === 1 };`, 'the next card');
    ev(`document.querySelector('#main .ask-card.open .btn.allow').click(); return true;`);
    const out = await allowed.done;
    check(out.code === 0 && JSON.stringify(JSON.parse(out.out)) === JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }), 'the hook printed allow and nothing else', out.out.trim());
    await until(`return { ok: !!document.querySelector('#main .ask-card.allowed') };`, 'the record', 9000);
    c = ev(cards);
    check(/Answered: Allowed once/.test(c.find((x) => /allowed/.test(x.cls)).foot) && c.find((x) => /allowed/.test(x.cls)).buttons.length === 0, 'the card is now the record "Answered: Allowed once", with no buttons', c.map((x) => x.foot).join(' | '));
    const placed = ev(`const c = document.querySelector('#main .ask-card.allowed'); const p = c.previousElementSibling; return { prev: p ? p.classList.contains('ask-card') ? 'card' : p.innerText.replace(/\\s+/g, ' ').slice(0, 60) : null };`);
    check(placed.prev === 'card' || /Latest answer in crew-1/.test(placed.prev), 'the records sit after the whole turn they came in (message and reply), oldest first', JSON.stringify(placed));
    axi('screenshot', path.join(shots, 'ask-allowed-1440-light.png'));

    // ---- Deny: stops the turn (interrupt), and the record says Denied
    const second = runClaudeHook(ask({ tool_name: 'Edit', tool_input: { file_path: '/lab/crew-1/notes.md', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree', replace_all: false } }));
    await until(`return { ok: document.querySelectorAll('#main .ask-card.open').length === 1 };`, 'the second card');
    c = ev(cards);
    check(/Claude asks to edit a file/.test(c.find((x) => /open/.test(x.cls)).head), 'a file edit reads as one, with its old and new text', c.find((x) => /open/.test(x.cls)).head);
    axi('screenshot', path.join(shots, 'ask-edit-1440-light.png'));
    ev(`document.querySelector('#main .ask-card.open .btn.deny').click(); return true;`);
    const denied = await second.done;
    const parsed = JSON.parse(denied.out);
    check(parsed.hookSpecificOutput.decision.behavior === 'deny' && parsed.hookSpecificOutput.decision.interrupt === true && !denied.out.includes('updatedPermissions'), 'Deny printed deny with interrupt, and no standing permission', denied.out.trim().slice(0, 160));
    await until(`return { ok: !!document.querySelector('#main .ask-card.denied') };`, 'the denied record', 9000);

    // ---- the dialog answered in the pane: the hook ends first, and the record says so
    const third = runClaudeHook(ask({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com/docs', prompt: 'Summarise the page' } }));
    await until(`return { ok: document.querySelectorAll('#main .ask-card.open').length === 1 };`, 'the third card');
    third.child.kill('SIGKILL');
    await until(`return { ok: document.querySelectorAll('#main .ask-card.elsewhere').length === 2 };`, 'the second elsewhere record', 9000);
    check(true, 'a hook ended by Claude Code leaves "Answered in the pane, not here" at once, without waiting for Herdr');

    // ---- the records sit among the turns in the order they happened, and survive a reload
    axi('open', 'about:blank'); axi('open', page);
    await until(`return { ok: /· Reader$/.test(document.title) && document.querySelectorAll('#main .ask-card').length >= 4 };`, 'the page again with the records', 20000);
    pick('crew-1'); await sleep(900);
    c = ev(cards);
    check(c.length === 4 && ['elsewhere', 'allowed', 'denied', 'elsewhere'].every((state, i) => new RegExp(state).test(c[i].cls)), 'after a reload the four records are there, oldest first', c.map((x) => x.cls.split(' ')[1]).join(','));

    // ---- no key and no text ever reached a pane
    check(herdrCalls().length === 0, 'the fake Herdr was given no key and no text for any of it', JSON.stringify(herdrCalls()));

    // ---- another session shows none of them
    pick('crew-2'); await sleep(900);
    check(ev(`return document.querySelectorAll('#main .ask-card').length;`) === 0, 'another conversation shows none of them');
    pick('crew-1'); await sleep(600);

    // ---- looks: phone width and dark, with a record and an open ask each
    const fourth = runClaudeHook(ask({ tool_input: { command: 'rm -rf build && make all 2>&1 | tail -40', description: 'Clean build' } }));
    setStatus('blocked');
    await until(`return { ok: document.querySelectorAll('#main .ask-card.open').length === 1 };`, 'the fourth card');
    for (const [viewport, scheme, name] of [['390x844x1', 'light', '390-light'], ['390x844x1', 'dark', '390-dark'], ['1440x900x1', 'dark', '1440-dark']]) {
      axi('emulate', '--viewport', viewport, '--color-scheme', scheme); await sleep(700);
      const fit = ev(`const c = document.querySelector('#main .ask-card.open'); const r = c.getBoundingClientRect(); return { fits: r.right <= innerWidth + 0.5 && r.left >= -0.5, scrollX: document.documentElement.scrollWidth <= innerWidth + 1, bg: getComputedStyle(c).backgroundColor };`);
      check(fit.fits && fit.scrollX, `the card fits ${name} with no sideways scroll`, JSON.stringify(fit));
      ev(`document.querySelector('#main .ask-card.open').scrollIntoView({ block: 'center' }); return true;`); await sleep(200);
      axi('screenshot', path.join(shots, `ask-open-${name}.png`));
    }
    axi('emulate', '--viewport', '1440x900x1', '--color-scheme', 'light');
    fourth.child.kill('SIGKILL');
    await sleep(500);
  } catch (error) {
    check(false, 'the run finished', error.message);
    try { axi('screenshot', path.join(shots, '99-stuck.png')); } catch (e) { /* no page */ }
  }
  finish(stop);
})();
