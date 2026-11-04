'use strict';

// Tests for the reader page's Undo rules (prototype/undosend.js): the Undo window that holds a message in the page before anything
// is sent, and what the faded message says (and which buttons it has) at each step after that. Run from the repo root:
//   node --test setup/transcript-reader/undosend.test.js
// The file runs in a bare sandbox with a clock the test moves by hand: no page, no timers, no server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'prototype', 'template.html'), 'utf8');

const { UNDO_SECONDS, makeSendHold, makeSendHandoff, resumeSendHandoff, describeSend } = vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, 'prototype', 'undosend.js'), 'utf8') + '\n({ UNDO_SECONDS, makeSendHold, makeSendHandoff, resumeSendHandoff, describeSend })', { Math });

// A clock that only moves when told to, with timers that fire when it passes them.
function clock() {
  const c = { at: 1000, timers: [], seq: 0 };
  c.now = () => c.at;
  c.after = (ms, fn) => { c.seq += 1; c.timers.push({ id: c.seq, due: c.at + ms / 1000, fn }); return c.seq; };
  c.cancel = (id) => { c.timers = c.timers.filter((timer) => timer.id !== id); };
  c.tick = (seconds) => {
    const end = c.at + seconds;
    for (;;) {
      const next = c.timers.filter((timer) => timer.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      c.timers = c.timers.filter((timer) => timer !== next);
      c.at = next.due;
      next.fn();
    }
    c.at = end;
  };
  return c;
}

test('the Undo window is a few seconds', () => {
  assert.ok(UNDO_SECONDS >= 3 && UNDO_SECONDS <= 10, String(UNDO_SECONDS));
});

test('a message held for the window is sent once, when the window ends, and not before', () => {
  const c = clock(), hold = makeSendHold(c), sent = [];
  assert.equal(hold.begin(() => sent.push('A'), 5), true);
  assert.equal(hold.active(), true);
  c.tick(4.9);
  assert.deepEqual(sent, [], 'nothing leaves the page inside the window');
  assert.equal(hold.active(), true);
  c.tick(0.2);
  assert.deepEqual(sent, ['A']);
  assert.equal(hold.active(), false);
  c.tick(60);
  assert.deepEqual(sent, ['A'], 'never again');
});

test('Undo inside the window means the send never runs: it was never sent', () => {
  const c = clock(), hold = makeSendHold(c), sent = [];
  hold.begin(() => sent.push('A'), 5);
  c.tick(3);
  assert.equal(hold.undo(), true);
  assert.equal(hold.active(), false);
  c.tick(60);
  assert.deepEqual(sent, [], 'the timer was cancelled and nothing ever went');
  assert.equal(hold.undo(), false, 'nothing is held to undo twice');
});

test('Undo after the window has ended is too late and changes nothing', () => {
  const c = clock(), hold = makeSendHold(c), sent = [];
  hold.begin(() => sent.push('A'), 5);
  c.tick(5);
  assert.deepEqual(sent, ['A']);
  assert.equal(hold.undo(), false, 'a click that arrives after the send is told it is too late');
  assert.deepEqual(sent, ['A']);
});

test('Send now runs the send at once, once, and Undo cannot follow it', () => {
  const c = clock(), hold = makeSendHold(c), sent = [];
  hold.begin(() => sent.push('A'), 5);
  c.tick(1);
  assert.equal(hold.release(), true);
  assert.deepEqual(sent, ['A']);
  assert.equal(hold.release(), false, 'a second Send now does nothing');
  assert.equal(hold.undo(), false);
  c.tick(60);
  assert.deepEqual(sent, ['A'], 'the timer does not send it a second time');
});

test('the dock makes Add into Now only for the held message on screen', () => {
  assert.match(TEMPLATE, /add\.disabled = held \? false : link\.sending \|\| elsewhere \|\| !dockTyped\(\) \|\| command;/);
  assert.match(TEMPLATE, /if \(!add\.dataset\.addSize && add\.getBoundingClientRect\(\)\.width > 0\)/);
  assert.match(TEMPLATE, /const \{ width, height \} = add\.getBoundingClientRect\(\);/);
  assert.match(TEMPLATE, /add\.style\.height = `\$\{height\}px`;/);
  assert.match(TEMPLATE, /add\.textContent = held \? "Now" : "Add";/);
  assert.match(TEMPLATE, /add\.title = held \? "Send this message now \(Enter; Cmd\+Enter or Ctrl\+Enter\)"/);
  assert.match(TEMPLATE, /add\.setAttribute\("aria-label", held \? "Send this message now" : "Add to the batch and write the next comment"\);/);
  assert.match(TEMPLATE, /if \(heldHere\(\)\) sendNow\(\); else \{ addToBatch\(\); dock\("text"\)\.focus\(\); \}/);
  assert.match(TEMPLATE, /if \(e\.isComposing\) return;/);
  assert.match(TEMPLATE, /else if \(e\.key === "Enter" && !e\.shiftKey\) \{ e\.preventDefault\(\); sendNow\(\); \}/);
});

test('only one message is in the window at a time, and a new one can start after it ends or is undone', () => {
  const c = clock(), hold = makeSendHold(c), sent = [];
  assert.equal(hold.begin(() => sent.push('A'), 5), true);
  assert.equal(hold.begin(() => sent.push('B'), 5), false, 'a second message is refused while one is held');
  c.tick(5);
  assert.equal(hold.begin(() => sent.push('B'), 5), true);
  hold.undo();
  assert.equal(hold.begin(() => sent.push('C'), 5), true);
  c.tick(5);
  assert.deepEqual(sent, ['A', 'C']);
});

test('the window counts down in whole seconds, never reading 0 while the message is still held, and keeps what it was told about the message', () => {
  const c = clock(), hold = makeSendHold(c);
  assert.equal(hold.left(), 0);
  assert.equal(hold.meta(), null);
  hold.begin(() => {}, 5, { sid: 'S1', text: 'hello' });
  assert.deepEqual([hold.left(), hold.meta().sid, hold.meta().text], [5, 'S1', 'hello']);
  c.tick(1.2);
  assert.equal(hold.left(), 4);
  c.tick(3.7);
  assert.equal(hold.left(), 1);
  c.tick(0.2);
  assert.equal(hold.left(), 0);
  assert.equal(hold.meta(), null);
});

test('a send that throws still leaves the window free for the next message', () => {
  const c = clock(), hold = makeSendHold(c);
  hold.begin(() => { throw new Error('boom'); }, 5);
  assert.throws(() => c.tick(5), /boom/);
  assert.equal(hold.active(), false);
  assert.equal(hold.begin(() => {}, 5), true);
});

test('a full navigation resumes a live hold only when the new page is another session', () => {
  const record = makeSendHandoff({ hold: { id: 'send-1', sid: 'alpha', text: 'hello', photos: 0 }, deadline: 105, sentBox: 'hello' });
  const resumed = resumeSendHandoff(record, 'beta', 101);
  assert.equal(resumed.action, 'resume');
  assert.equal(resumed.seconds, 4);
  assert.equal(resumed.hold.sid, 'alpha', 'the resumed send keeps its original session');
  assert.equal(resumeSendHandoff(record, 'alpha', 101).action, 'discard', 'a reload keeps the draft and never sends');
});

test('a resumed hold can expire immediately but still runs once for its original session', () => {
  const record = makeSendHandoff({ hold: { id: 'send-2', sid: 'alpha', text: 'hello', photos: 0 }, deadline: 105 });
  const resumed = resumeSendHandoff(record, 'beta', 106);
  assert.equal(resumed.action, 'resume');
  assert.equal(resumed.seconds, 0);
  assert.equal(resumed.hold.sid, 'alpha');
});

// ------------------------------------------------------------------------------------------------ the faded message

const t = (s) => 'T' + s;
const at = 5000;
// The sandbox's arrays are not this realm's, so the actions are copied for deepEqual.
const say = (p, options = {}) => { const d = describeSend({ at, label: 'alpha', text: 'hi', ...p }, { t, now: () => at + 5, ...options }); return { ...d, actions: [...d.actions] }; };

test('in the window: says nothing has left the page, and offers Undo and Send now', () => {
  const d = say({}, { hold: { left: 4 } });
  assert.equal(d.stage, 'window');
  assert.match(d.say, /Sending in 4 s/);
  assert.match(d.say, /nothing has left this page/);
  assert.deepEqual(d.actions, ['undo', 'now']);
});

test('the window is over and the request is running: it has left the page, and it is too late to undo', () => {
  const pane = say({}, { flight: 'pane' });
  assert.equal(pane.stage, 'flying');
  assert.match(pane.say, /Sending to alpha now · too late to undo/);
  assert.doesNotMatch(pane.say, /nothing has left this page/);
  assert.deepEqual(pane.actions, []);
  const queue = say({}, { flight: 'queue' });
  assert.match(queue.say, /Queuing it for the laptop now · too late to undo/);
  assert.deepEqual(queue.actions, []);
});

test('sent straight to the pane: too late to undo here, and no Undo button', () => {
  const d = say({});
  assert.equal(d.stage, 'delivered');
  assert.match(d.say, /Sent T5000 · waiting for alpha/);
  assert.match(d.say, /too late to undo here/);
  assert.deepEqual(d.actions, []);
  assert.equal(d.hint, '');
});

test('sent to a pane whose agent was working: says Claude Code may hold it as a queued message, and how to take it back in the pane', () => {
  const d = say({ agent: 'working' });
  assert.equal(d.stage, 'held-by-agent');
  assert.match(d.say, /alpha was working/);
  assert.match(d.say, /too late to undo here/);
  assert.match(d.hint, /may hold this as a queued message/);
  assert.match(d.hint, /Press ↑ in the pane/);
  assert.deepEqual(d.actions, [], 'the reader never sends a key to a pane');
  for (const agent of ['idle', 'done', undefined]) assert.equal(say({ agent }).hint, '', String(agent));
});

test('sent but not in the log after a minute: says to check the pane, and is still too late to undo', () => {
  const d = say({ agent: 'working' }, { now: () => at + 61 });
  assert.equal(d.stage, 'stuck');
  assert.match(d.say, /not in the log yet; check the pane/);
  assert.match(d.say, /too late to undo here/);
  assert.deepEqual(d.actions, []);
});

test('held on the phone: Undo is offered, and the text says where the message is', () => {
  const d = say({ queue: { state: 'held' } });
  assert.equal(d.stage, 'held');
  assert.match(d.say, /Held on this phone since T5000/);
  assert.deepEqual(d.actions, ['undo']);
});

test('queued for the laptop: Undo is offered', () => {
  const d = say({ queue: { state: 'queued' } });
  assert.equal(d.stage, 'queued');
  assert.match(d.say, /Queued T5000 · waiting for the laptop to send it to alpha/);
  assert.deepEqual(d.actions, ['undo']);
});

test('being undone while the laptop is away: no buttons, and it does not claim the message is undone', () => {
  const d = say({ queue: { state: 'held', cancelling: true } });
  assert.equal(d.stage, 'cancelling');
  assert.match(d.say, /Undoing · waiting for the laptop to confirm it did not send this/);
  assert.match(d.hint, /Nothing is claimed as undone/);
  assert.deepEqual(d.actions, []);
  assert.doesNotMatch(d.say, /^Undone|was never sent/);
});

test('the laptop answered too late to a click on Undo: says so plainly, with no buttons', () => {
  const d = say({ queue: { state: 'queued', tooLate: true } });
  assert.equal(d.stage, 'late');
  assert.match(d.say, /Too late to undo/);
  assert.deepEqual(d.actions, []);
});

test('the laptop is sending it now: too late to undo', () => {
  const d = say({ queue: { state: 'sending' } });
  assert.equal(d.stage, 'sending');
  assert.match(d.say, /the laptop is sending it now · too late to undo/);
  assert.deepEqual(d.actions, []);
});

test('sent by the laptop: too late to undo, and the working hint follows the receipt', () => {
  const sent = { state: 'sent', receipt: { state: 'sent', at: at + 2, agent: 'idle' } };
  const d = say({ queue: sent });
  assert.equal(d.stage, 'delivered');
  assert.match(d.say, /Sent by the laptop at T5002 · waiting for alpha · too late to undo here/);
  assert.deepEqual(d.actions, []);
  const busy = say({ queue: { state: 'sent', receipt: { state: 'sent', at: at + 2, agent: 'working' } } });
  assert.equal(busy.stage, 'held-by-agent');
  assert.match(busy.hint, /Press ↑ in the pane/);
  const stuck = say({ queue: sent }, { now: () => at + 2 + 61 });
  assert.equal(stuck.stage, 'stuck');
});

test('refused: it was not sent, so it can be edited and dismissed', () => {
  const d = say({ queue: { state: 'refused', receipt: { state: 'refused', reason: 'No live Herdr pane is running that session, so nothing was sent.' } } });
  assert.equal(d.stage, 'refused');
  assert.match(d.say, /^Not sent · No live Herdr pane/);
  assert.deepEqual(d.actions, ['edit', 'dismiss']);
  assert.match(say({ queue: { state: 'refused' } }).say, /The laptop refused it/);
});

test('Undo is offered only where the holder can prove the message never reached the agent', () => {
  const offered = [];
  const cases = {
    window: [{}, { hold: { left: 3 } }], direct: [{}, {}], 'direct, agent working': [{ agent: 'working' }, {}], held: [{ queue: { state: 'held' } }, {}],
    queued: [{ queue: { state: 'queued' } }, {}], cancelling: [{ queue: { state: 'held', cancelling: true } }, {}], late: [{ queue: { state: 'queued', tooLate: true } }, {}],
    sending: [{ queue: { state: 'sending' } }, {}], sent: [{ queue: { state: 'sent', receipt: { at } } }, {}], refused: [{ queue: { state: 'refused', receipt: {} } }, {}],
  };
  for (const [name, [p, options]] of Object.entries(cases)) if (say(p, options).actions.includes('undo')) offered.push(name);
  assert.deepEqual(offered, ['window', 'held', 'queued']);
});
