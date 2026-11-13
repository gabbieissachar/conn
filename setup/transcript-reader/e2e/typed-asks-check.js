#!/usr/bin/env node
'use strict';

// Typed asks, in a real browser (chrome-devtools-axi, headless) against a lab copy of the reader with a fake Herdr: nothing is sent to any pane,
// no real record, backlog or log is read. By hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/typed-asks-check.js <scratch folder> [screenshots folder]
//
// The lab's main home (<lab home>/fm-homes/pmos) gets a leader's typed ask record, written the way Firstmate's bin/fm-captain-ask.sh writes it, and
// a backlog with the task it gates, held for the captain. The lab's crew-1 conversation gets the turn that opened it: the tool output ending in the
// ASK_RECORD line with the record's sha, and a reply whose prose cards the sheet finder cannot read. Checked with the typed-ask flag ON for the
// lab's server (PMOS_READER_TYPED_ASKS=1) and then OFF:
//   - ON : the reply wears the "Typed ask" chip and its box lists the record's cards; the sheet page opens on it with the provenance row (who wrote
//          it, the three checks), each card's gate beside the backlog's own hold reason; a keyed answer typed in chat settles the cards ("Answered in
//          chat"), and a file that no longer matches the sha turns the ask back into prose.
//   - OFF: the same logs build the page it was before: no chip, no typed sheet, the unreadable reply has no sheet at all.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { make } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-typed-asks-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, startLab, openPage, pick, finish, sleep } = make('reader-typed-asks-check');

const stamp = (outDir) => { try { return fs.statSync(path.join(outDir, 'prototype.html')).mtimeMs; } catch (e) { return 0; } };
const iso = (at) => new Date(at * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const ASK = 'ask-20261108T050000Z-4e2d';
const GATE = 'gate-lab-mapping';
const HOLD_REASON = 'Pick the mapping and who closes it (lab hold reason)';

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const { lab, page, stop, outDir } = await startLab(folder, { PMOS_READER_TYPED_ASKS: '1' });
  const main = path.join(lab.home, 'fm-homes', 'pmos');
  const log = path.join(lab.home, '.claude', 'projects', '-lab-crew-1', lab.crew[0] + '.jsonl');
  const append = (records) => fs.appendFileSync(log, records.map((r) => JSON.stringify(r) + '\n').join(''));
  const waitBuild = async (before) => { for (let i = 0; i < 160 && stamp(outDir) === before; i++) await sleep(250); await sleep(600); };
  try {
    // ---- the leader's home: the record, its events, and the backlog it gates
    fs.mkdirSync(path.join(main, 'state', 'ask-records'), { recursive: true });
    fs.mkdirSync(path.join(main, 'data'), { recursive: true });
    fs.writeFileSync(path.join(main, '.tasks.toml'), 'backend = "markdown"\n\n[markdown]\npath = "data/backlog.md"\n');
    fs.writeFileSync(path.join(main, 'data', 'backlog.md'), `## In flight\n\n## Queued\n- [ ] ${GATE} - Mapping call (repo: sample) (kind: captain) (hold: fm-hold-v1:${Buffer.from(HOLD_REASON).toString('base64').replace(/=+$/, '')}) (hold-kind: captain)\n  Captain hold set: 2026-11-08T04:00:00Z\n\n  Created: 2026-11-08T04:00:01Z\n## Done\n`);
    const gate = { task: GATE, mode: 'done', identity: '2026-11-08T04:00:00Z#0' };
    const record = {
      schema: 'fm-ask.v1', id: ASK, created_at: '2026-11-08T05:00:00Z', home: { path: main, label: 'big-boss', role: 'main' },
      writer: { session_id: lab.crew[0], harness: 'claude', role: 'leader', captain_driven: false, pane: 'w3:p1' }, title: 'Lab mapping ask', kind: 'decision',
      cards: [
        { key: 'Z1', question: 'How do several cards map to held tasks?', options: [{ value: 'record-owns-cards', note: 'one task per gate', recommended: true }, { value: 'one-task-per-card', note: '', recommended: false }], recommended: 'record-owns-cards', gate },
        { key: 'Z2', question: 'Who closes the record when the answer arrives?', options: [{ value: 'leader-call', note: '', recommended: true }, { value: 'hook', note: '', recommended: false }], recommended: 'leader-call', gate },
      ],
      revises: [], expires_at: null,
    };
    const recordFile = path.join(main, 'state', 'ask-records', ASK + '.json');
    const body = JSON.stringify(record) + '\n';
    fs.writeFileSync(recordFile, body);
    const sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(main, 'state', 'ask-records', ASK + '.events'), JSON.stringify({ at: '2026-11-08T05:00:00Z', event: 'opened', sha }) + '\n');

    // ---- the conversation's turn: open the record, then reply in prose the finder cannot read
    const now = Date.now() / 1000;
    const before = stamp(outDir);
    append([
      { type: 'user', uuid: 'u-typed-1', timestamp: iso(now - 20), cwd: '/lab/crew-1', message: { role: 'user', content: 'Please ask me the mapping questions' } },
      { type: 'assistant', timestamp: iso(now - 15), cwd: '/lab/crew-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_typed_1', name: 'Bash', input: { command: 'bin/fm-captain-ask.sh open --title "Lab mapping ask"' } }] } },
      { type: 'user', timestamp: iso(now - 14), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_typed_1', content: `fm-captain-ask: recorded 2 cards (2 gated). Put the id from the last line in your reply footer as \`ask: ${ASK}\`.\nASK_RECORD v1 ${ASK} cards=Z1,Z2 gates=2 sha=${sha} home=big-boss` }] } },
      { type: 'assistant', timestamp: iso(now - 10), cwd: '/lab/crew-1', message: { role: 'assistant', content: [{ type: 'text', text: `I put two calls in the doc and need you to look at them.\n\nask: ${ASK}` }] } },
    ]);
    await waitBuild(before);
    await openPage(page, '1000x900x1');
    pick('crew-1'); await sleep(1500);

    // ---- ON: the reader page
    const REPLY = `const card = [...document.querySelectorAll('#main .reply')].reverse().find(c => c.querySelector('.chip.typed'));
      if (!card) return { ok: false };
      return { ok: true, chip: card.querySelector('.chip.typed').title, keys: [...card.querySelectorAll('.cardq b')].map(b => b.textContent),
        needs: card.classList.contains('needs'), verdict: [...card.querySelectorAll('.chip')].map(c => c.textContent), href: (card.querySelector('a.btn.sheet') || {}).href || '' };`;
    let s = await until(REPLY, 'the reply with the Typed ask chip');
    check(s.chip.includes(ASK) && s.chip.includes(sha) && s.chip.includes('open: Z1, Z2'), 'the reply wears the Typed ask chip, which names the record, its sha and the open cards', s.chip);
    check(s.keys.join() === 'Z1,Z2' && s.needs && s.verdict.includes('Needs you'), 'the reply is a needs-you turn and its box lists the record\'s cards, though the prose has none the finder can read', JSON.stringify(s.verdict) + ' ' + s.keys.join());
    check(/questionnaire\.html#q=/.test(s.href) || /sheet\.html#q=/.test(s.href), 'and it links to an answer sheet', s.href);
    axi('screenshot', path.join(shots, 'typed-asks-01-reader.png'));

    // ---- ON: the sheet page
    const base = page.replace(/prototype\.html.*$/, '');
    const sheetUrl = base + 'questionnaire.html' + s.href.slice(s.href.indexOf('#'));
    axi('open', sheetUrl);
    await sleep(1800);
    const SHEET = `const row = document.querySelector('.typed-row'); if (!row) return { ok: false };
      return { ok: true, row: row.innerText, keys: [...document.querySelectorAll('.card .key')].map(n => n.textContent), gates: [...document.querySelectorAll('.card .gate')].map(n => n.innerText),
        bad: document.querySelectorAll('.typed-row .check.bad').length };`;
    s = await until(SHEET, 'the sheet page with its provenance row');
    check(/Typed ask/.test(s.row) && /written by leader, in big-boss/.test(s.row) && s.row.includes(sha), 'the sheet page opens with the provenance row: who wrote it, where, and the record\'s sha', s.row.replace(/\n/g, ' | '));
    check(s.bad === 0 && /linked to its turn/.test(s.row) && /file unmodified/.test(s.row) && /written by this conversation/.test(s.row), 'with the three checks, all passed', s.row.replace(/\n/g, ' | '));
    check(s.keys.join() === 'Z1,Z2', 'the cards are the record\'s', s.keys.join());
    check(s.gates.length === 2 && s.gates.every((g) => g.includes(GATE) && g.includes(HOLD_REASON) && /held for you in the backlog/.test(g)), 'each card shows its gate beside the backlog\'s own hold reason', JSON.stringify(s.gates));
    axi('screenshot', path.join(shots, 'typed-asks-02-sheet.png'));

    // ---- ON: the lite page and its sheet (the other page path) take the same typed ask
    axi('open', base + 'live/index.html#s=' + lab.crew[0]); await sleep(2500);
    s = await until(`const card = [...document.querySelectorAll('#main .reply')].reverse().find(c => c.querySelector('.chip.typed'));
      if (!card) return { ok: false };
      return { ok: true, keys: [...card.querySelectorAll('.cardq b')].map(b => b.textContent), link: (card.querySelector('a.btn.sheet') || {}).href || '' };`, 'the lite page with the Typed ask chip');
    check(s.keys.join() === 'Z1,Z2' && /live\/sheet\.html#q=/.test(s.link), 'the lite page shows the typed ask too: chip, the record\'s cards in the box, and a link to the lite sheet', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'typed-asks-04-lite.png'));
    axi('open', s.link); await sleep(2500);
    s = await until(`const row = document.querySelector('.typed-row'); if (!row) return { ok: false };
      return { ok: true, row: row.innerText, keys: [...document.querySelectorAll('.card .key')].map(n => n.textContent), gates: document.querySelectorAll('.card .gate').length };`, 'the lite sheet with its provenance row');
    check(s.keys.join() === 'Z1,Z2' && s.gates === 2 && /✓ linked to its turn/.test(s.row), 'and the lite sheet has the provenance row, the cards and each gate', JSON.stringify(s));
    axi('screenshot', path.join(shots, 'typed-asks-05-lite-sheet.png'));

    // ---- ON: the captain answers one card in chat; the record is not told
    const before2 = stamp(outDir);
    append([
      { type: 'user', uuid: 'u-typed-2', timestamp: iso(Date.now() / 1000 - 4), cwd: '/lab/crew-1', message: { role: 'user', content: 'Z1=record-owns-cards' } },
      { type: 'assistant', timestamp: iso(Date.now() / 1000 - 2), cwd: '/lab/crew-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted, thank you.' }] } },
    ]);
    await waitBuild(before2);
    axi('open', 'about:blank'); axi('open', sheetUrl);
    await sleep(2500);
    s = await until(`const row = document.querySelector('.typed-row'); if (!row) return { ok: false };
      const cards = [...document.querySelectorAll('.card')].map(c => ({ key: c.querySelector('.key').textContent, answered: c.classList.contains('answered'), hint: (c.querySelector('.hint') || {}).textContent || '' }));
      return { ok: cards.some(c => c.answered), row: row.innerText, cards };`, 'the sheet with Z1 answered in chat');
    check(s.cards.find((c) => c.key === 'Z1').answered && !s.cards.find((c) => c.key === 'Z2').answered, 'Z1, answered in chat, shows as answered and Z2 is still open', JSON.stringify(s.cards));
    check(/You answered Z1 in chat/.test(s.row) && /not told/.test(s.row), 'and the provenance row says the record has not been told', s.row.replace(/\n/g, ' | '));
    check(/You answered Z1 in chat \(record-owns-cards\)/.test(s.cards.find((c) => c.key === 'Z1').hint), 'and the card says what was answered', s.cards[0].hint);
    axi('screenshot', path.join(shots, 'typed-asks-03-answered-in-chat.png'));
    axi('open', page); await sleep(1500);
    pick('crew-1'); await sleep(1200);
    s = ev(`const card = [...document.querySelectorAll('#main .reply')].reverse().find(c => c.querySelector('.chip.typed')); return { ok: true, chips: card ? [...card.querySelectorAll('.chip')].map(c => c.textContent) : [] };`);
    check(s.chips.includes('Needs you') || s.chips.includes('Typed ask'), 'the reader page still shows the typed ask with Z2 open', JSON.stringify(s.chips));

    // ---- a record that no longer matches the sha it printed is prose only again
    // (a record changing on its own starts no rebuild: the next change of a listed log does, as a leader's next command would)
    const before3 = stamp(outDir);
    fs.writeFileSync(recordFile, body.replace('How do several cards', 'How do several cards (edited)'));
    append([{ type: 'assistant', timestamp: iso(Date.now() / 1000), cwd: '/lab/crew-1', message: { role: 'assistant', content: [{ type: 'text', text: 'One more thing.' }] } }]);
    await waitBuild(before3);
    axi('open', page); await sleep(1500);
    pick('crew-1'); await sleep(1200);
    s = ev(`return { ok: true, chip: document.querySelectorAll('#main .chip.typed').length };`);
    check(s.chip === 0, 'a record edited after it was printed is shown as prose only: no Typed ask chip', String(s.chip));
    fs.writeFileSync(recordFile, body);

    // ---- OFF: the same logs and files, built without the flag
    const env = { ...process.env, HOME: lab.home, PATH: lab.bin + path.delimiter + process.env.PATH, PMOS_READER_TYPED_ASKS: '0' };
    execFileSync('python3', [path.join(lab.repo, 'setup', 'transcript-reader', 'reader.py'), 'rebuild'], { env, cwd: lab.repo, timeout: 180000 });
    const off = fs.readFileSync(path.join(outDir, 'prototype.html'), 'utf8');
    check(!/"typed":\{/.test(off) && !off.includes('typed_lines'), 'with the flag off the page the build writes holds no typed ask at all', String(off.length));
    const sheet = fs.readFileSync(path.join(outDir, 'questionnaire.html'), 'utf8');
    check(!sheet.includes(ASK), 'and neither does the answer sheet page');
  } catch (error) {
    check(false, 'the run finished', error.message);
  }
  finish(stop);
})();
