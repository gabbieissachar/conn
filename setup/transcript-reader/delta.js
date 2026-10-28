'use strict';

// What changed between two builds of the reader page, so an open page takes the difference instead of the whole page.
//
// The page's data is its payload (build_prototype.build): sessions (each with its turns), a fleet event list, the
// documents the turns name, and a few small values. A new reply changes one session's tail, a fleet event or two, and
// maybe a document, but the built page is every session's whole text (22 MB on the owner's machine). The page tells
// the server which build it holds (its `generated` time); the server keeps a digest of each recent build it has seen
// (per session, per turn, per fleet event, per document) and answers with only what differs from that build:
//
//   { status: 'ok', delta: true, base, generated, template,
//     sessions: { order: [id, ...], changed: { id: { ...the session without its turns, count, from, exchanges: [tail] } } },
//     fleet?:     { count, from, items: [tail] },   // the events after the first one that differs
//     documents?: { set: { id: doc }, drop: [id] },
//     whole?:     { key: value } }                  // any other changed top-level value (homes, summaries, closed, ...)
//
// `from` is how many leading turns the page already has and keeps; a session the page lacks has from 0. The page checks
// each `count` against what it built, and anything it cannot resolve falls back to the full page, so a delta never
// leaves the page with a half-merged payload. A build the server has not seen (a restart, or a page loaded before this
// server started) answers { delta: false }, and the page fetches the full page, which the server notes for the next time.

const crypto = require('crypto');

const PAYLOAD_OPEN = '<script id="payload" type="application/json">';
const PAYLOAD_CLOSE = '</script>';
const TEMPLATE_RE = /<meta name="template" content="([^"]*)">/;
const GENERATED_RE = /^\{"generated":([0-9.eE+-]+)[,}]/;
const KEEP_BUILDS = 6;

const digest = (value) => crypto.createHash('sha1').update(JSON.stringify(value)).digest('base64');

// The payload's JSON text and the template hash named in a built page's head, or null for a text that is not one.
function split(html) {
  const open = html.indexOf(PAYLOAD_OPEN);
  if (open < 0) return null;
  const start = open + PAYLOAD_OPEN.length;
  // The payload escapes every "<", so the first closing tag after it ends it.
  const end = html.indexOf(PAYLOAD_CLOSE, start);
  if (end < 0) return null;
  const template = (html.slice(0, open).match(TEMPLATE_RE) || [])[1] || '';
  return { json: html.slice(start, end), template };
}

// What a build leaves behind to compare the next one with: digests only, so keeping six of them costs little.
function summarize(payload) {
  const sessions = new Map();
  for (const session of payload.sessions || []) {
    const { exchanges, ...rest } = session;
    sessions.set(session.id, { meta: digest(rest), turns: (exchanges || []).map(digest) });
  }
  const documents = new Map(Object.entries(payload.documents || {}).map(([id, doc]) => [id, digest(doc)]));
  const whole = {};
  for (const [key, value] of Object.entries(payload)) if (!['sessions', 'fleet', 'documents', 'generated'].includes(key)) whole[key] = digest(value);
  return { order: (payload.sessions || []).map((s) => s.id), sessions, fleet: (payload.fleet || []).map(digest), documents, whole };
}

// How many leading digests of `old` the new list repeats.
function common(old, items) {
  let k = 0;
  while (k < old.length && k < items.length && old[k] === items[k]) k += 1;
  return k;
}

function create() {
  // generated -> { template, summary, payload }; the payload only for the newest build, which is the one a delta is made from.
  const builds = new Map();

  function remember(generated, template, summary, payload) {
    builds.set(generated, { template, summary, payload });
    if (payload) for (const [key, build] of builds) if (key !== generated && build.payload && Number(key) < Number(generated)) build.payload = null;
    while (builds.size > KEEP_BUILDS) builds.delete(builds.keys().next().value);
  }

  // Reads a built page's text in, unless that build is already known. Returns its { generated, template, payload } or null.
  function note(html) {
    const parts = split(html);
    if (!parts) return null;
    const quick = (parts.json.slice(0, 64).match(GENERATED_RE) || [])[1];
    const known = quick !== undefined && builds.get(Number(quick));
    if (known && known.payload) return { generated: Number(quick), template: known.template, payload: known.payload };
    let payload;
    try { payload = JSON.parse(parts.json); } catch { return null; }
    const generated = Number(payload.generated);
    if (!Number.isFinite(generated)) return null;
    const have = builds.get(generated);
    remember(generated, parts.template, have ? have.summary : summarize(payload), payload);
    return { generated, template: parts.template, payload };
  }

  // The delta from the build the page holds (`have`, its generated time) to the build in `html`, or { delta: false }.
  function since(html, have) {
    const current = note(html);
    if (!current) return { delta: false };
    const base = builds.get(Number(have));
    if (current.generated === Number(have)) return { delta: false, unchanged: true, generated: current.generated };
    if (!base || !Number.isFinite(Number(have)) || Number(have) > current.generated) return { delta: false };
    const { payload } = current;
    const before = base.summary;
    const after = builds.get(current.generated).summary;
    const changed = {};
    for (const session of payload.sessions || []) {
      const { exchanges = [], ...rest } = session;
      const now = after.sessions.get(session.id);
      const known = before.sessions.get(session.id);
      const from = known ? common(known.turns, now.turns) : 0;
      if (known && known.meta === now.meta && from === known.turns.length && from === exchanges.length) continue;
      changed[session.id] = { ...rest, count: exchanges.length, from, exchanges: exchanges.slice(from) };
    }
    const out = { status: 'ok', delta: true, base: Number(have), generated: current.generated, template: current.template,
      sessions: { order: after.order, changed } };
    const fleet = payload.fleet || [];
    const fleetFrom = common(before.fleet, after.fleet);
    if (!(fleetFrom === before.fleet.length && fleetFrom === fleet.length)) out.fleet = { count: fleet.length, from: fleetFrom, items: fleet.slice(fleetFrom) };
    const documents = payload.documents || {};
    const set = {};
    for (const [id, doc] of Object.entries(documents)) if (before.documents.get(id) !== after.documents.get(id)) set[id] = doc;
    const drop = [...before.documents.keys()].filter((id) => !after.documents.has(id));
    if (Object.keys(set).length || drop.length) out.documents = { set, drop };
    const whole = {};
    for (const [key, hash] of Object.entries(after.whole)) if (before.whole[key] !== hash) whole[key] = payload[key];
    if (Object.keys(whole).length) out.whole = whole;
    return out;
  }

  return { note, since, known: (generated) => builds.has(Number(generated)) };
}

module.exports = { create, split, digest };
