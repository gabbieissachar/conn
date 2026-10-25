'use strict';

// "Who would roll": runs firstmate's own `fm-rollover.sh check <id>` for the ids a switch would name, and reports each
// verdict. The check is read-only by the roller's own header. It runs the code of the home's own watcher (the code root
// comes only from that home's watcher lock) against that home's data folder, which are two different folders for the
// `~/fm-homes/pmos` data home. Nothing here writes.

const path = require('path');
const { AdapterError, childEnv, defaultRunner } = require('./adapter');
const { readRegular } = require('./rollover');
const { scrub } = require('./text');

const KINDS = new Set(['second-mates', 'crew']);
// An id may not start with a dash: the roller reads `--primary` as the primary's check, which is not part of this preview.
const PREVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_IDS = 64;
const CONCURRENCY = 3;
const VERDICT_LINE = /^(eligible|skip|ineligible|off|config-error):\s*(.*)$/;
const NOT_COVERED = /\(dry-run: config\/[a-z-]+ does not cover it\)/;

function refuse(status, code, message) { return new AdapterError(message, status, code); }

function createPreview({ rollover, runner = defaultRunner, env = process.env, timeoutMs = 30000, bashBin = 'bash' } = {}) {
  // A clean environment: no inherited Herdr context and no firstmate override that would point the roller at another folder.
  function checkEnv(home) {
    const base = childEnv(env);
    for (const key of Object.keys(base)) if (key.startsWith('FM_')) delete base[key];
    return { ...base, FM_HOME: home.real, GIT_OPTIONAL_LOCKS: '0' };
  }

  async function runCheck(script, home, id) {
    // The runner kills the shell at the limit, but a child the roller started can hold its pipes open a while longer, so the answer does not wait for it.
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs + 1000); });
    const result = await Promise.race([runner(bashBin, [script, 'check', id], { env: checkEnv(home), cwd: home.real, timeoutMs, maxBytes: 64 * 1024 }), late]);
    clearTimeout(timer);
    if (result.timedOut) return { id, verdict: 'timeout', detail: 'The check did not finish in time.' };
    const line = String(result.stdout || '').split('\n').find((item) => item.trim()) || '';
    const match = VERDICT_LINE.exec(line.trim());
    if (!match) return { id, verdict: 'unreadable', detail: scrub(result.stderr || result.stdout || 'The check printed nothing.', 160) };
    const detail = scrub(match[2], 240);
    return { id, verdict: match[1], detail, ...(match[1] === 'eligible' ? { covered: !NOT_COVERED.test(match[2]) } : {}) };
  }

  async function preview({ home: homeId, kind, ids }) {
    if (!KINDS.has(kind)) throw refuse(400, 'bad_kind', 'The kind must be second-mates or crew.');
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS || ids.some((id) => typeof id !== 'string' || !PREVIEW_ID.test(id))) throw refuse(400, 'bad_ids', 'Name between 1 and 64 valid ids.');
    const wanted = [...new Set(ids)].sort();
    const home = typeof homeId === 'string' ? rollover.inspect(homeId) : null;
    if (!home) throw refuse(404, 'unknown_home', 'That home is not registered with this page.');
    if (home.status !== 'ok') throw refuse(409, 'home_unavailable', 'That home cannot be used right now (' + home.status.replace(/_/g, ' ') + ').');
    if (home.watcher !== 'running' || !home.codeRoot) throw refuse(409, 'no_watcher', 'No watcher runs in that home, so there is no firstmate code to ask who would roll.');
    const script = path.join(home.codeRoot, 'bin', 'fm-rollover.sh');
    const text = readRegular(script, 2 * 1024 * 1024);
    if (text === null || !/^\s*check\)/m.test(text)) throw refuse(409, 'unsupported', "That home's firstmate has no check command, so nothing was asked.");
    const known = new Map((kind === 'crew' ? home.ids.crew.list : home.ids.second_mates.list).map((item) => [item.id, item]));
    const results = new Array(wanted.length);
    let next = 0;
    const worker = async () => {
      while (next < wanted.length) {
        const index = next; next += 1;
        const id = wanted[index];
        results[index] = known.has(id) ? await runCheck(script, home, id) : { id, verdict: 'unknown', detail: 'No task record of this kind has this id in that home.' };
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));
    return { home: home.id, label: home.label, kind, results, eligible: results.filter((item) => item.verdict === 'eligible').length };
  }

  return { preview };
}

module.exports = { createPreview };
