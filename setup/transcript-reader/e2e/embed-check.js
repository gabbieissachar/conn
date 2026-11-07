#!/usr/bin/env node
'use strict';

// The embed page in a real browser (chrome-devtools-axi, headless), by hand, not part of `node --test` (it needs chrome-devtools-axi and a Chrome):
//
//   node setup/transcript-reader/e2e/embed-check.js <scratch folder> [screenshots folder]
//
// The page a host's web view loads and feeds through window.readerEmbed (README.md, "The embed page"). embed_lab.py builds it into the folder, with the
// reader's own page for a made-up Claude conversation that says what the fixture says. The page is opened as a file and again over a plain server on a
// spare port that counts every request. Nothing real is read or sent: no Herdr, no pane, no reader server, never the owner's reader on 8768.
//   1. As a file: the entry point is there, there is no header, message bar or token, and a call draws the fixture with the reader's own cards.
//   2. The look: the same words in the reader's own page and in the embed page have the same computed style, element by element.
//   3. Behavior: the steps list and the step sheet with the host's output, a clipped reply that stays open through an update, `upsert` redrawing
//      only the block that changed, the working strip, "New reply" when scrolled up and following when at the bottom, a link handed to the host,
//      a second conversation replacing the first, bad input, and the reader's keys doing nothing.
//   4. Served over HTTP: one request in all (the page itself), a fetch refused by the page's content policy, nothing in localStorage or sessionStorage.

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const { execFileSync } = require('child_process');
const { make, freePort } = require('./axi');

const folder = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'reader-embed-lab'));
const shots = path.resolve(process.argv[3] || path.join(folder, 'screenshots'));
const { axi, ev, until, check, finish, sleep } = make('reader-embed-check');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'embed-fixtures', 'campus-conversation.json'), 'utf8'));

// chrome-devtools-axi drops an argument of about 1000 characters: a big value goes into the page in pieces.
function put(name, value) {
  const text = JSON.stringify(value);
  ev(`window.${name} = ''; return true;`);
  for (let i = 0; i < text.length; i += 500) ev(`window.${name} += ${JSON.stringify(text.slice(i, i + 500))}; return true;`);
  return ev(`window.${name} = JSON.parse(window.${name}); return true;`);
}
const call = (expression) => { const done = ev(`try { return { ok: true, value: ${expression} }; } catch (e) { return { ok: true, error: e.name + ': ' + e.message }; }`); return done.error || done.value; };
const set = (value) => { put('__in', value); return ev(`return window.readerEmbed.set(window.__in);`); };
const upsert = (value) => { put('__in', value); return ev(`return window.readerEmbed.upsert(window.__in);`); };
const text = (selector) => ev(`return [...document.querySelectorAll(${JSON.stringify(selector)})].map(n => n.textContent.trim().replace(/\\s+/g, ' ').slice(0, 80));`);
const count = (selector) => ev(`return document.querySelectorAll(${JSON.stringify(selector)}).length;`);
const visible = (selector) => ev(`const n = document.querySelector(${JSON.stringify(selector)}); return Boolean(n) && !n.hidden && getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0;`);
const atBottom = () => ev(`return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;`);
const clone = (value) => JSON.parse(JSON.stringify(value));

// The style of the first element that matches, as the properties the look is made of.
const STYLE = `const p = ['fontSize','fontWeight','fontFamily','lineHeight','color','backgroundColor','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','borderTopWidth','borderLeftWidth','borderTopColor','borderLeftColor','borderRadius','textDecorationLine','textTransform','letterSpacing','width'];`;
function styleOf(selector, nth = 0) {
  return ev(`${STYLE} const n = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!n) return null; const s = getComputedStyle(n); const o = {}; for (const k of p) o[k] = s[k]; return o;`);
}

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const lab = JSON.parse(execFileSync('python3', [path.join(__dirname, 'embed_lab.py'), folder], { encoding: 'utf8', timeout: 240000 }).trim().split('\n').pop());
  // A plain server of its own, in another process (the driver blocks on the browser tool): it serves the page and writes the path of every request it gets.
  const dir = path.dirname(lab.embed);
  const log = path.join(folder, 'requests.log');
  fs.writeFileSync(log, '');
  const port = await freePort();
  const code = `const http = require('http'), fs = require('fs'); const [dir, log, port] = process.argv.slice(1);
    http.createServer((req, res) => { fs.appendFileSync(log, req.url + '\\n'); if (req.url !== '/embed.html') { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "frame-ancestors 'none'" }); res.end(fs.readFileSync(dir + '/embed.html')); }).listen(Number(port), '127.0.0.1');`;
  const server = spawn('node', ['-e', code, dir, log, String(port)], { stdio: 'ignore' });
  const requests = { get list() { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); }, clear() { fs.writeFileSync(log, ''); } };
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/embed.html`)).ok) break; } catch (e) { await sleep(100); } }
  const stop = () => { server.kill(); try { axi('stop'); } catch (e) { /* not running */ } };
  try {
    // ---- 1. as a file
    axi('open', 'about:blank');
    axi('emulate', '--viewport', '520x900x2', '--color-scheme', 'dark');
    axi('open', 'file://' + lab.embed);
    await until(`return { ok: typeof window.readerEmbed === 'object' };`, 'the entry point');
    check(ev(`return window.readerEmbed.version;`) === 1, 'the entry point is there with its version, when the page has loaded');
    check(ev(`return document.body.classList.contains('embed') && !document.querySelector('meta[name="reader-token"]');`), 'the page is in embed mode and holds no token');
    check(!visible('#bar') && !visible('#dock') && !visible('#search') && !visible('#new-reply') && !visible('#float-comment'), 'no header, message bar, search or floating button');
    check(count('#main > *') === 0 && ev(`return window.readerEmbed.plainText();`) === '', 'before any call the page is empty');

    const first = set(FIXTURE);
    check(first.ok && first.blocks === 4 && first.skipped === 0, 'set takes the fixture whole', JSON.stringify(first));
    check(count('#main .input') === 2 && count('#main .reply') === 2, 'two messages of yours and two replies, drawn by the reader\'s own cards', `${count('#main .input')}/${count('#main .reply')}`);
    check(text('#main .input .who b').join() === 'You,You', 'your messages say You');
    check(text('.reply .md h4').join('|') === 'Voucher redemptions, week 44|Why Australia dipped', 'markdown is markdown: headings are headings (small ones, as in a reply)', text('.reply .md h4').join('|'));
    check(count('.reply .md table') === 1 && count('.reply .md li') >= 6 && count('.reply .md strong') >= 2 && count('.reply .md a[href^="https://"]') === 1 && count('.reply .codebox button.copy') === 1, 'a table, lists, bold, a link and a code box with its Copy button');
    check(!/##|\*\*/.test(text('.md').join(' ')), 'no ## or ** shows through');
    check(text('.reply .steps-row').join('|') === '▶2 steps|▶3 steps · edited 1 file · 1 failed', 'the steps rows read as the reader\'s do', text('.reply .steps-row').join('|'));
    check(text('.reply .chip').join('|') === 'Needs you', 'the open question is a reply that needs you', text('.reply .chip').join('|'));
    check(count('.asks.cform .copt') === 2 && text('.asks.cform .cardq span').join('').startsWith('Split the Australian figure by state?'), 'its question and its two choices are in the yellow box');
    check(count('.pin, .hide-msg, .reply-to, .sheet-flag, .sheetfix') === 0, 'no Pin, Hide, Reply or Sheet button');
    check(text('.reply > .who > span:last-child').every((t) => /\d{2}:\d{2}$/.test(t)), 'each reply has its time', text('.reply > .who > span:last-child').join('|'));
    const plainText = ev(`return window.readerEmbed.plainText();`);
    check(plainText.startsWith("You: Can you summarise last week's voucher redemptions by market?\n\nCampus: (2 tool steps)\n## Voucher") && plainText.endsWith('Campus asks: Split the Australian figure by state?'), 'plainText has the words CampusTimeline.plainText() writes');
    axi('screenshot', path.join(shots, 'embed-dark.png'));

    // ---- 2. the look, against the reader's own page for the same words
    axi('open', 'file://' + lab.reference);
    await until(`return { ok: document.querySelectorAll('#main .reply').length === 2 };`, 'the reference page');
    // What the reader draws for the same words, element by element: measured as drawn, then again with every clipped reply and steps list opened.
    const drawn = [['#main .input', 0], ['#main .input', 1], ['#main .reply', 0], ['#main .reply', 1], ['#main .reply .who', 0], ['#main .md h4', 0], ['#main .md p', 0], ['#main .md table', 0], ['#main .md th', 0], ['#main .md td', 0],
      ['#main .md li', 0], ['#main .md a', 0], ['#main .codebox', 0], ['#main .codebox pre', 0], ['#main .steps-row', 0], ['#main .steps-row .what', 0], ['#main .steps-row .steps-failed', 0], ['#main .more', 0], ['#main .md blockquote', 0]];
    const opened = [['#main .step', 0], ['#main .step .k', 0], ['#main .step .s', 0], ['#main .step.failed', 0], ['#main .step-group', 0], ['#main .reply .clip', 0]];
    const open = `document.querySelectorAll('.reply .more').forEach(b => b.click()); document.querySelectorAll('.steps-row').forEach(b => b.click()); return true;`;
    const measure = (pairs) => pairs.map(([selector, nth]) => styleOf(selector, nth));
    const reference = [measure(drawn)]; ev(open); reference.push(measure(opened));
    axi('screenshot', path.join(shots, 'reference-reader-dark.png'));
    axi('open', 'file://' + lab.embed);
    await until(`return { ok: typeof window.readerEmbed === 'object' };`, 'the entry point again');
    set(FIXTURE);
    const embedded = [measure(drawn)]; ev(open); embedded.push(measure(opened));
    [drawn, opened].forEach((pairs, stage) => pairs.forEach(([selector, nth], i) => {
      const a = reference[stage][i], b = embedded[stage][i];
      if (!a || !b) { check(Boolean(a) === Boolean(b), `${selector}[${nth}] is in both pages`, `reference ${Boolean(a)}, embed ${Boolean(b)}`); return; }
      // The reply that needs you has the yellow edge; the reference's has no ask.
      const allowed = selector === '#main .reply' && nth === 1 ? ['borderLeftWidth', 'borderLeftColor'] : [];
      // What sits inside that reply is 3 px narrower for the same reason: its edge is 4 px, not 1.
      const narrower = ['#main .md blockquote', '#main .step.failed'].includes(selector) && Number.parseFloat(a.width) - Number.parseFloat(b.width) === 3;
      const real = Object.keys(a).filter((key) => a[key] !== b[key] && !allowed.includes(key) && !(key === 'width' && narrower));
      check(real.length === 0, `${selector}[${nth}] looks as it does in the reader`, real.map((key) => `${key}: ${a[key]} vs ${b[key]}`).join('; '));
    }));
    axi('screenshot', path.join(shots, 'embed-dark-expanded.png'));
    axi('emulate', '--color-scheme', 'light');
    axi('open', 'about:blank'); axi('open', 'file://' + lab.embed);
    await until(`return { ok: typeof window.readerEmbed === 'object' };`, 'the entry point (light)');
    set({ ...FIXTURE, live: 'writing' });
    axi('screenshot', path.join(shots, 'embed-light.png'));
    axi('emulate', '--color-scheme', 'dark');
    axi('open', 'about:blank'); axi('open', 'file://' + lab.embed);
    await until(`return { ok: typeof window.readerEmbed === 'object' };`, 'the entry point (dark again)');

    // ---- 3. behavior
    set(FIXTURE);
    ev(`document.querySelector('.steps-row').click(); return true;`);
    check(count('.step') === 2 && text('.step .k').join('|') === 'Read|Ran', 'a steps row opens its list of steps', text('.step .k').join('|'));
    ev(`document.querySelector('.step').click(); return true;`);
    await until(`return { ok: !document.querySelector('.step-sheet').hidden };`, 'the step sheet');
    const sheet = ev(`const d = document.querySelector('.step-sheet'); return { out: [...d.querySelectorAll('pre')].map(p => p.textContent).join('~'), ask: d.querySelector('[data-act="ask"]').hidden, pos: d.querySelector('.pos').textContent };`);
    check(sheet.out.includes('/workspace/data/redemptions-week-44.csv') && sheet.out.includes('SG,1204,1136'), 'the step\'s sheet shows its file and the output the host sent, a file read included', sheet.out.slice(0, 120));
    check(sheet.ask === true && sheet.pos === 'Step 1 of 2', 'with no "Ask about this", and Prev and Next through the turn', JSON.stringify(sheet));
    ev(`document.querySelector('.step-sheet [data-act="close"]').click(); return true;`);
    ev(`document.querySelectorAll('.reply .steps-row')[1].click(); return true;`);
    ev(`[...document.querySelectorAll('.step')].find(s => s.classList.contains('failed')).click(); return true;`);
    await until(`return { ok: !document.querySelector('.step-sheet').hidden && /does not exist/.test(document.querySelector('.step-sheet').textContent) };`, 'the failed step\'s output');
    check(ev(`return document.querySelector('.step-title.failed') !== null;`), 'a failed step is marked failed, with the error the host sent');
    ev(`document.querySelector('.step-sheet [data-act="close"]').click(); return true;`);

    // A clipped reply stays open through an update, and an update redraws only the block that changed.
    ev(`document.querySelector('.reply .more').click(); return true;`);
    ev(`window.__nodes = [...document.querySelectorAll('#main > *')]; window.__nodes.forEach((n, i) => n.dataset.mark = 'n' + i); return window.__nodes.length;`);
    const grown = clone(FIXTURE.blocks[3]);
    grown.texts[0] += '\n\nA last line that arrived while the reply was streaming.';
    grown.streaming = true;
    upsert({ blocks: [grown] });
    const same = ev(`const now = [...document.querySelectorAll('#main > *')]; return { n: now.length, kept: now.map(x => x.dataset.mark || 'new').join(','), last: now[now.length - 1].textContent.includes('A last line that arrived') };`);
    check(same.n === 4 && same.kept === 'n0,n1,n2,new' && same.last, 'upsert drew the one block again where it stood and left the other three nodes as they were', same.kept);
    check(count('.reply .clip') === 0, 'what was opened stays open (the long reply was not clipped again)');
    check(text('.reply .steps-row').length === 2, 'and the steps rows are still there');
    upsert([clone(FIXTURE.blocks[3])]);
    check(!text('.reply').join(' ').includes('A last line that arrived'), 'the block goes back to what it was, in place');
    // The same set again changes nothing at all.
    ev(`window.__nodes = [...document.querySelectorAll('#main > *')]; return true;`);
    set(FIXTURE);
    check(ev(`const now = [...document.querySelectorAll('#main > *')]; return now.length === window.__nodes.length && now.every((n, i) => n === window.__nodes[i]);`), 'a set of what is already there touches no node');

    // The working strip.
    check(visible('.embed-live') && text('.embed-live .txt').join() === 'reading redemptions-week-44.csv', 'the fixture\'s working line is on the strip');
    call(`readerEmbed.live('reading table-a.csv')`);
    check(visible('.embed-live') && text('.embed-live .txt').join() === 'reading table-a.csv', 'live() shows what the agent is doing');
    upsert({ blocks: [], live: 'writing' });
    check(text('.embed-live .txt').join() === 'writing', 'an upsert that names the line changes it');
    upsert({ blocks: [] });
    check(text('.embed-live .txt').join() === 'writing', 'and one that does not leaves it alone');
    call(`readerEmbed.live('')`);
    check(!visible('.embed-live'), 'an empty line takes the strip away');

    // A question answered, and a reply stopped.
    const answered = clone(FIXTURE.blocks[3]);
    answered.form = { ...answered.form, status: 'answered', answer: 'Yes, by state', questions: [{ ...answered.form.questions[0], pick: 'Yes, by state' }] };
    answered.stopped = true;
    upsert({ blocks: [answered] });
    check(count('.asks.cform.done') === 1 && text('.cform .notes').join() === 'Answered: Yes, by state' && text('.copt.picked').join() === 'Yes, by state', 'an answered question is quiet, with the pick filled and what was answered');
    check(text('.reply .chip').join('|') === 'Answered' && count('.reply.needs') === 0, 'and its reply no longer needs you', text('.reply .chip').join('|'));
    check(text('.reply .notes').join('|').includes('Stopped before it finished.'), 'a stopped reply says so');
    answered.form.status = 'cancelled';
    upsert({ blocks: [answered] });
    check(text('.cform .notes').join() === 'Not answered: the question was cancelled.' && count('.reply .chip') === 0, 'a cancelled question says so and asks nothing of you');
    set(FIXTURE);

    // Following, and "New reply".
    let serial = 0;
    const more = (n) => ({ blocks: Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? 'reply' : 'user', id: `more_${serial += 1}`, text: `Another question ${i}`, texts: [`Another answer ${i}. `.repeat(40)], tools: [] })) });
    upsert(more(6));
    check(count('#main > *') === 10, 'six more blocks went on the end', String(count('#main > *')));
    ev(`window.scrollTo(0, document.documentElement.scrollHeight); return true;`); await sleep(200);
    upsert(more(2));
    await sleep(300);
    check(atBottom() && !visible('.embed-new'), 'at the bottom, an update follows the newest content');
    ev(`window.scrollTo(0, 0); return true;`); await sleep(200);
    upsert(more(2));
    await sleep(300);
    check(ev(`return window.scrollY < 50;`) && visible('.embed-new') && text('.embed-new').join() === 'New reply ↓', 'scrolled up, the place is kept and "New reply ↓" offers the way down');
    ev(`document.querySelector('.embed-new').click(); return true;`); await sleep(300);
    check(atBottom() && !visible('.embed-new'), 'the button goes to the newest and goes away');
    axi('screenshot', path.join(shots, 'embed-dark-scrolled.png'));

    // A link goes to the host, and takes the view nowhere.
    set(FIXTURE);
    ev(`window.__told = []; window.webkit = { messageHandlers: { readerEmbed: { postMessage: m => window.__told.push(m) } } }; window.__href = location.href; document.querySelector('.md a[href^="https://"]').click(); return true;`);
    await sleep(400);
    check(ev(`return location.href === window.__href;`), 'a click on a web address leaves the page where it is');
    check(JSON.stringify(ev(`return window.__told;`)) === JSON.stringify([{ type: 'link', url: 'https://example.com/dashboards/vouchers' }]), 'and tells the host which address', JSON.stringify(ev(`return window.__told;`)));
    ev(`delete window.webkit; window.__opened = []; window.open = (u, t, f) => { window.__opened.push([u, t, f]); return null; }; document.querySelector('.md a[href^="https://"]').click(); return true;`);
    check(JSON.stringify(ev(`return window.__opened;`)) === JSON.stringify([['https://example.com/dashboards/vouchers', '_blank', 'noopener']]), 'with no host listening a new window opens it');

    // Another conversation replaces the first; the same one goes on.
    ev(`window.scrollTo(0, 0); document.querySelectorAll('.reply .more').forEach(b => b.click()); return true;`);
    const other = set({ id: 'ses_other', blocks: [{ kind: 'user', id: 'o1', text: 'A different conversation' }, { kind: 'reply', id: 'o2', texts: ['**Only** this one.'], tools: [] }] });
    check(other.blocks === 2 && count('#main .input') === 1 && count('#main .reply') === 1 && text('#main .md').join() === 'Only this one.', 'a set with another id replaces the conversation', JSON.stringify(other));
    check(set({ id: 'ses_other', blocks: [{ kind: 'user', id: 'o1', text: 'A different conversation' }] }).blocks === 1 && count('#main .reply') === 0, 'a set with the same id replaces the blocks and keeps the page');
    check(call(`readerEmbed.clear().blocks`) === 0 && text('#main').join('') === 'No messages yet.', 'clear empties it');
    set(FIXTURE);

    // What a host can get wrong.
    check(String(call(`readerEmbed.set('not json')`)).startsWith('SyntaxError'), 'text that is not JSON throws a SyntaxError for the host to see', String(call(`readerEmbed.set('not json')`)));
    const messy = ev(`return window.readerEmbed.upsert({ blocks: [null, 3, { kind: 'bogus' }, { kind: 'user', id: 'ok1', text: 'Still here' }] });`);
    check(messy.ok && messy.skipped === 3, 'everything else it is sent is read tolerantly and counted', JSON.stringify(messy));
    set(FIXTURE);

    // The reader's keys and redraws do nothing here.
    const before = ev(`return document.getElementById('main').innerHTML.length;`);
    for (const key of ['j', 'k', 'n', 'w', '/']) ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); return true;`);
    await sleep(300);
    check(ev(`return document.getElementById('main').innerHTML.length;`) === before && !visible('#search'), 'the reader\'s keys (j, k, n, w, /) do nothing');
    ev(`document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('hashchange')); return true;`);
    check(ev(`return document.getElementById('main').innerHTML.length;`) === before && count('#main .input') === 2, 'a hash change or a visibility change draws nothing else');

    // ---- 4. served over HTTP: one request, no fetch, nothing stored
    requests.clear();
    axi('open', `http://127.0.0.1:${port}/embed.html`);
    await until(`return { ok: typeof window.readerEmbed === 'object' };`, 'the served page');
    set(FIXTURE);
    ev(`document.querySelector('.steps-row').click(); document.querySelector('.step').click(); return true;`);
    upsert({ blocks: [{ kind: 'user', id: 'x1', text: 'Draws again' }], live: 'working' });
    ev(`window.scrollTo(0, 0); window.scrollTo(0, 99999); return true;`);
    ev(`window.__fetched = 'pending'; fetch('/embed.html').then(() => { window.__fetched = 'allowed'; }, () => { window.__fetched = 'refused'; }); return true;`);
    await until(`return { ok: window.__fetched !== 'pending' };`, 'the fetch to answer');
    check(ev(`return window.__fetched;`) === 'refused', 'a fetch from the page is refused by its own content policy');
    await sleep(2500);  // longer than the reader page's 2-second poll
    check(requests.list.filter((url) => url !== '/favicon.ico').join() === '/embed.html', 'one request in all: the page itself, no poll, no events wait, no object', requests.list.join(','));
    check(ev(`return performance.getEntriesByType('resource').length;`) === 0, 'and the page loaded no resource');
    check(ev(`return localStorage.length + sessionStorage.length;`) === 0, 'nothing in localStorage or sessionStorage after all of it');
    check(ev(`return document.cookie;`) === '', 'no cookie');
    const errors = axi('console').split('\n').filter((line) => /\[error\]/i.test(line) && !/favicon|Content Security Policy/i.test(line));
    check(errors.length === 0, 'no error in the console but the two lines about the refused fetch', errors.slice(0, 3).join(' | '));
    axi('emulate', '--viewport', '900x800x1');
    axi('screenshot', path.join(shots, 'embed-wide-served.png'));
  } catch (error) {
    check(false, 'the run', error.message);
  }
  finish(stop);
})();
