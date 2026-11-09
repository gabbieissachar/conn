'use strict';
// Review rounds of the Tasks board: which tasks you have already looked at in this round (board/README.md, "Reviewing a task on its card").
//
// A round belongs to one board session and has an id (when it started). A task is "reviewed" in the round once you press Mark reviewed on its card or record a review
// outcome on it (done, queued, delayed, needs you, a follow-up); opening a card does not count. A new round, started from the board, forgets the old marks. With no
// round yet, the first mark starts one. The marks are a small file of the reader's own, never a Firstmate home and never a backlog body:
//   board-rounds.json   { "rounds": { "<board session>": { "id": "<epoch s>", "started": <epoch s>, "reviewed": { "<task>": { "at": <epoch s>, "outcome": "seen|done|queue|delay|needs|followup" } } } } }
// next to the board's config (`PMOS_READER_BOARD_ROUNDS` moves it). Read at every board answer (it is small); written atomically.

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUTCOMES = ['seen', 'done', 'queue', 'delay', 'needs', 'followup'];
const MAX_MARKS = 2000;
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

function roundsFile(env = process.env) {
  if (env.PMOS_READER_BOARD_ROUNDS) return env.PMOS_READER_BOARD_ROUNDS;
  const config = env.PMOS_READER_BOARD_CONFIG || path.join(os.homedir(), '.config', 'pmos-transcript-reader', 'board.json');
  return path.join(path.dirname(config), 'board-rounds.json');
}

function create({ file = roundsFile(), now = () => Date.now() } = {}) {
  const seconds = () => Math.floor(now() / 1000);
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data.rounds === 'object' && data.rounds ? data.rounds : {};
    } catch { return {}; }
  }
  function save(rounds) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = path.join(path.dirname(file), `.rounds-${process.pid}-${now()}`);
    fs.writeFileSync(tmp, JSON.stringify({ rounds }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  // What the page is given: null (no round yet) or { id, started, reviewed: { task: { at, outcome } } } with only well-formed marks.
  function get(session) {
    const round = load()[session];
    if (!round || typeof round !== 'object' || typeof round.id !== 'string') return null;
    const reviewed = {};
    for (const [task, mark] of Object.entries(round.reviewed && typeof round.reviewed === 'object' ? round.reviewed : {})) {
      if (TASK_RE.test(task) && mark && Number.isFinite(mark.at) && OUTCOMES.includes(mark.outcome)) reviewed[task] = { at: mark.at, outcome: mark.outcome };
    }
    return { id: round.id, started: Number(round.started) || 0, reviewed };
  }
  function start(session) {
    const rounds = load();
    const at = seconds();
    rounds[session] = { id: String(at), started: at, reviewed: {} };
    save(rounds);
    return get(session);
  }
  function mark(session, task, outcome) {
    if (!TASK_RE.test(task || '') || !OUTCOMES.includes(outcome)) return null;
    const rounds = load();
    const round = rounds[session] && typeof rounds[session] === 'object' && typeof rounds[session].id === 'string' ? rounds[session] : { id: String(seconds()), started: seconds(), reviewed: {} };
    round.reviewed = round.reviewed && typeof round.reviewed === 'object' ? round.reviewed : {};
    round.reviewed[task] = { at: seconds(), outcome };
    const tasks = Object.keys(round.reviewed);
    if (tasks.length > MAX_MARKS) tasks.sort((a, b) => round.reviewed[a].at - round.reviewed[b].at).slice(0, tasks.length - MAX_MARKS).forEach((t) => { delete round.reviewed[t]; });
    rounds[session] = round;
    save(rounds);
    return get(session);
  }
  function unmark(session, task) {
    const rounds = load();
    const round = rounds[session];
    if (round && round.reviewed && typeof round.reviewed === 'object' && Object.hasOwn(round.reviewed, task)) { delete round.reviewed[task]; save(rounds); }
    return get(session);
  }
  return { get, start, mark, unmark, file };
}

module.exports = { create, roundsFile, OUTCOMES };
