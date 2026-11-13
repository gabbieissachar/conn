  // ---------------------------------------------------------------- the windowed lite page (storeapi/page.js builds this into one page)
  // It draws one session's turns from the store API (/api/transcript-reader/sessions/<id>/turns) with the reader's own markdown, cards and styles,
  // and keeps them current from the stream (/stream, Server-Sent Events read with fetch, so the token travels in a header as for every call).
  //   - Windowed: at most MOUNTED turns are in the page. It opens on the newest ones; older ones load as you scroll up ("before"); a turn that
  //     arrives is one node added at the end (or the tail node redrawn in place as its reply grows): nothing else is drawn again.
  //   - No timer. A page with nothing happening runs nothing: no poll, no clock. A hidden page closes its stream and takes up what it missed
  //     (one request) when shown again.
  //   - Not here, on purpose: the answer sheet, Documents, pins, hiding, batches, photos and Undo (the full page and the current lite page keep them).
  const MOUNTED = 200;
  const FIRST = 40;
  const PAGE = 40;
  const API = "/api/transcript-reader/";
  const token = (document.querySelector('meta[name="reader-token"]') || {}).content || "";
  const $ = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
  const byId = id => document.getElementById(id);
  const fmtTime = s => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(s * 1000));
  const fmtDay = s => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date(s * 1000));
  const fmtWhen = s => s ? `${fmtDay(s)} ${fmtTime(s)}` : "";
  const ago = s => { const m = Math.max(0, Math.round((Date.now() / 1000 - s) / 60)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };
  const PANE_STATES = { working: "Working", blocked: "Waiting for you", done: "Done", idle: "Idle" };

  const S = {
    sessions: [], byId: new Map(), live: new Map(), asks: [], cur: null, turns: [], marks: null, previous: null, answerWords: 15, moreBefore: false, jumped: false,
    open: new Set(), nodes: new Map(), stream: null, lastIdx: -1, following: true, loading: false, asOf: null, error: null, hidden: false,
  };
  window.__readerWindowed = S;  // the lab and the tests read it
  const stats = window.__stats = { events: 0, renders: 0, nodes: 0, fetches: 0, streams: 0 };
  const marks = window.__marks = {};  // the lab's marker: a turn whose text holds LAB-MARK-<n> is stamped with the time it was on screen
  const LAB = /LAB-MARK-(\d+)/g;

  async function api(path, options = {}) {
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("This page has no server token: open it from the address the reader prints.");
    stats.fetches += 1;
    const response = await fetch(API + path, { cache: "no-store", ...options, headers: { ...(options.headers || {}), "x-transcript-reader-token": token } });
    let body = null;
    try { body = await response.json(); } catch (e) { body = null; }
    if (!response.ok) { const error = new Error((body && body.message) || `The server answered ${response.status}.`); error.status = response.status; error.code = body && body.code; throw error; }
    return body;
  }

  // ---------------------------------------------------------------- what a turn shows (the reader's rules, build_prototype.py)
  const openAsk = ex => Boolean(S.marks) && ex.verdict === "needs-you" && ex.idx >= (S.marks.last_captain === null ? -1 : S.marks.last_captain);
  function folded(i) {
    const ex = S.turns[i];
    if (!(ex.source === "wake" && ex.verdict !== "needs-you")) return false;
    const m = S.marks;
    if (ex.idx === m.last_idx && !ex.reply) return false;
    const prev = i > 0 ? S.turns[i - 1] : S.previous;
    if (prev && ex.reply_words >= S.answerWords && !(i > 0 ? Boolean(prev.reply) : prev.has_reply) && (prev.source === "captain" || (prev.source === "session" && prev.kind === "command"))) return false;
    return ex.idx !== (m.last_reply !== null ? m.last_reply : m.last_reply_any);
  }
  const words = text => (text.trim() ? text.trim().split(/\s+/).length : 0);

  function renderMarkdown(text, askLines, reminderLines) {
    const box = $("div", "md");
    box.innerHTML = markdownView.render(text, { ask: askLines, reminder: reminderLines, doc: false }).html;
    return box;
  }
  function clipped(node, count, limit, label, key) {
    const wrap = $("div");
    if (count <= limit || S.open.has(key)) { wrap.append(node); return wrap; }
    const inner = $("div", "clip"); inner.append(node); wrap.append(inner);
    const more = $("button", "more", `${label} (${count} words)`); more.type = "button"; more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => { S.open.add(key); inner.classList.remove("clip"); more.remove(); });
    wrap.append(more);
    return wrap;
  }
  function verdictChip(ex, open) {
    if (ex.verdict === "needs-you") { const c = open ? $("span", "chip needs", "Needs you") : $("span", "chip asked", "Asked"); if (!open) c.title = "Asked, and you have written since"; return c; }
    if (ex.verdict === "no-action") return null;
    return $("span", "chip reminder", "No reply");
  }
  function replyCard(ex, open) {
    const card = $("div", "reply" + (open ? " needs" : ""));
    const who = $("div", "who");
    const chip = verdictChip(ex, open);
    if (chip) who.append(chip);
    if (ex.reminder_lines.length && ex.verdict !== "needs-you") who.append($("span", "chip reminder", "reminds you of open items"));
    who.append($("span", null, fmtWhen(ex.reply_at || ex.at)));
    card.append(who);
    const later = ex.ask_lines.filter(n => n > 1);
    if (open && later.length && ex.reply_words > 90 && !S.open.has(ex.idx + ":reply")) {
      const box = $("div", "asks");
      const lines = ex.reply.split("\n");
      later.slice(0, 3).forEach(n => { const d = $("div"); d.innerHTML = markdownView.inline((lines[n] || "").replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")); box.append(d); });
      if (later.length > 3) box.append($("div", "notes", `and ${later.length - 3} more below`));
      card.append(box);
    }
    if (ex.reply) card.append(clipped(renderMarkdown(ex.reply, open ? ex.ask_lines : [], ex.reminder_lines), ex.reply_words, 90, "Show full reply", ex.idx + ":reply"));
    if (ex.narration.length || ex.tools) {
      const notes = $("div", "notes");
      const parts = [];
      if (ex.narration.length) parts.push(`${ex.narration.length} working note${ex.narration.length === 1 ? "" : "s"}`);
      if (ex.tools) parts.push(`${ex.tools} tool step${ex.tools === 1 ? "" : "s"}`);
      const button = $("button", null, parts.join(", ")); button.type = "button";
      const body = $("div");
      const show = () => { ex.narration.forEach(n => body.append($("div", "note-body", n))); };
      button.addEventListener("click", () => { if (body.childElementCount) { body.replaceChildren(); S.open.delete(ex.idx + ":notes"); } else { show(); S.open.add(ex.idx + ":notes"); } });
      if (S.open.has(ex.idx + ":notes")) show();
      notes.append(button, body);
      card.append(notes);
    }
    return card;
  }
  function inputBlock(ex) {
    const block = $("div", `input ${ex.source}`);
    const who = $("div", "who");
    who.append($("b", null, ex.source === "captain" ? (ex.kind === "command" ? `You ran ${String(ex.label || "").split(" ")[0]}` : "You") : ex.label || ex.source));
    who.append($("span", null, fmtWhen(ex.at)));
    if (ex.absorbed) who.append($("span", null, "· sent while it was busy"));
    block.append(who);
    block.append(clipped($("div", null, ex.input), words(ex.input), 120, "Show all", ex.idx + ":input"));
    return block;
  }
  function turnNode(ex, fold, open) {
    const wrap = $("div", "turn");
    wrap.dataset.idx = String(ex.idx);
    if (ex.source === "session") { wrap.append($("div", "divider", `${ex.label} · ${fmtWhen(ex.at)}`)); return wrap; }
    if (ex.source === "wake") {
      if (!fold) {
        const head = $("div", "who wake-who", `Wake-up · ${fmtWhen(ex.at)} · ${ex.label}`); head.title = ex.label;
        wrap.append(head);
        if (ex.reply || ex.tools) wrap.append(replyCard(ex, open));
        return wrap;
      }
      const row = $("button", "fold"); row.type = "button";
      row.append($("span", "t", fmtTime(ex.at)), $("span", "l", `Wake-up · ${ex.label}`), $("span", null, ex.reply ? `${ex.reply_words}w` : ""));
      const detail = $("div");
      const show = shown => { row.setAttribute("aria-expanded", String(shown)); detail.replaceChildren(...(shown && ex.reply ? [replyCard(ex, open)] : [])); if (shown) S.open.add(ex.idx + ":fold"); else S.open.delete(ex.idx + ":fold"); };
      row.addEventListener("click", () => show(row.getAttribute("aria-expanded") !== "true"));
      show(S.open.has(ex.idx + ":fold"));
      wrap.append(row, detail);
      return wrap;
    }
    wrap.append(inputBlock(ex));
    if (ex.reply || ex.tools) wrap.append(replyCard(ex, open));
    return wrap;
  }

  // ---------------------------------------------------------------- the window
  const main = byId("main");
  const sig = (ex, fold, open) => [ex.idx, ex.reply_at, ex.reply.length, ex.input.length, ex.tools, ex.verdict, ex.ask_lines.length, fold, open].join(":");
  function stamp(ex) {
    // Every marker the turn holds (a reply that grows keeps the markers it had), each stamped once, when it is on screen.
    for (const found of (ex.reply + "\n" + ex.input).matchAll(LAB)) {
      const n = found[1];
      if (!marks[n]) requestAnimationFrame(() => { if (!marks[n]) marks[n] = Date.now(); });
    }
  }
  // Brings the page's nodes in line with S.turns: a node is drawn when its turn is new or changed (its signature moved, which includes a fold
  // or an open ask changing), and left alone otherwise. A new turn at the end is one append.
  function paint() {
    const keep = new Set();
    let before = null;
    const ordered = [];
    for (let i = 0; i < S.turns.length; i += 1) {
      const ex = S.turns[i], fold = folded(i), open = openAsk(ex), s = sig(ex, fold, open);
      keep.add(ex.idx);
      let node = S.nodes.get(ex.idx);
      if (!node || node._sig !== s) {
        const fresh = turnNode(ex, fold, open);
        fresh._sig = s;
        stats.renders += 1;
        stamp(ex);
        if (node) node.replaceWith(fresh);
        S.nodes.set(ex.idx, fresh);
        node = fresh;
        if (!fresh.isConnected) ordered.push([i, fresh]);
      }
    }
    for (const [idx, node] of [...S.nodes]) if (!keep.has(idx)) { node.remove(); S.nodes.delete(idx); }
    // Nodes not yet in the page go in at their place: the end (the usual case), or the start (older turns), without touching the others.
    for (const [i, node] of ordered) {
      const next = S.turns.slice(i + 1).map(t => S.nodes.get(t.idx)).find(n => n && n.isConnected);
      if (next) main.insertBefore(node, next); else main.append(node);
    }
    void before;
    stats.nodes = main.childElementCount;
    byId("older").hidden = !S.moreBefore;
    byId("back").hidden = !S.jumped;
    byId("empty").hidden = S.turns.length > 0 || S.loading;
  }
  const nearEnd = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 140;
  function scrollEnd() { window.scrollTo(0, document.documentElement.scrollHeight); }

  // A window of turns replaces what is held (opening a session, a jump, a catch-up that cannot be merged).
  function setWindow(answer, { toEnd = true } = {}) {
    S.turns = answer.turns; S.marks = answer.marks; S.previous = answer.previous; S.moreBefore = answer.more_before; S.answerWords = answer.answer_words || 15;
    S.lastIdx = answer.turns.length ? answer.turns[answer.turns.length - 1].idx : -1;
    for (const node of S.nodes.values()) node.remove();
    S.nodes.clear();
    paint();
    if (toEnd) scrollEnd();
  }
  // New or changed turns of the open session, from the stream or a catch-up: the changed ones replace theirs by index, the new ones are appended.
  function merge(turns, marksNow) {
    if (!turns.length) return;
    S.marks = marksNow || S.marks;
    if (S.jumped) {
      // The newest turns are not what is on screen (a search hit, older turns being read): a turn already held is updated in place, and
      // nothing is added at the end, so the window stays one run of turns. The newest ones wait behind "Back to the latest".
      for (const ex of turns) { const at = S.turns.findIndex(t => t.idx === ex.idx); if (at >= 0) S.turns[at] = ex; }
      paint();
      return;
    }
    const wasEnd = nearEnd();
    for (const ex of turns) {
      const at = S.turns.findIndex(t => t.idx === ex.idx);
      if (at >= 0) S.turns[at] = ex;
      else if (ex.idx > S.lastIdx) S.turns.push(ex);
    }
    S.lastIdx = S.turns.length ? S.turns[S.turns.length - 1].idx : -1;
    // The window is cut at the far end only while following the newest turns: what is read stays.
    let cut = false;
    while (wasEnd && S.turns.length > MOUNTED) { S.turns.shift(); cut = true; }
    if (cut) { S.moreBefore = true; S.previous = null; }
    paint();
    if (wasEnd) scrollEnd(); else byId("new-reply").hidden = false;
  }

  async function loadOlder() {
    if (S.loading || !S.moreBefore || !S.turns.length || !S.cur) return;
    S.loading = true;
    const first = S.turns[0].idx;
    const anchor = main.firstElementChild;
    const was = anchor ? anchor.getBoundingClientRect().top : 0;
    try {
      const answer = await api(`sessions/${S.cur}/turns?before=${first}&limit=${PAGE}`);
      S.turns = [...answer.turns, ...S.turns];
      S.moreBefore = answer.more_before;
      S.previous = answer.previous;
      S.marks = answer.marks;
      paint();
      if (anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - was);  // what was read stays where it was
      // The far end is released while reading older turns, so the window never grows past MOUNTED.
      while (S.turns.length > MOUNTED) { S.turns.pop(); }
      S.lastIdx = S.turns.length ? S.turns[S.turns.length - 1].idx : -1;
      if (S.turns.length && S.turns[S.turns.length - 1].idx < S.marks.last_idx) S.jumped = true;
      paint();
    } catch (error) { say(error.message, true); } finally { S.loading = false; }
  }

  async function catchUp() {
    if (!S.cur || S.jumped) return;
    try {
      const answer = await api(`sessions/${S.cur}/turns?after=${Math.max(-1, S.lastIdx - 1)}&limit=100`);
      if (answer.more_after) { setWindow(await api(`sessions/${S.cur}/turns?limit=${FIRST}`)); return; }
      merge(answer.turns, answer.marks);
    } catch (error) { say(error.message, true); }
  }

  // ---------------------------------------------------------------- sessions, panes, asks
  let pickerDirty = false, listing = false;
  const liveOf = id => S.live.get(id) || null;
  const folderName = cwd => String(cwd || "").split("/").filter(Boolean).pop() || "";
  const nameOf = s => (liveOf(s.id) && liveOf(s.id).label) || s.title || (folderName(s.cwd) ? `${folderName(s.cwd)} · ${s.id.slice(0, 8)}` : `${s.harness} · ${s.id.slice(0, 8)}`);
  function optionText(s) {
    const live = liveOf(s.id);
    const state = live ? (PANE_STATES[live.status] || "Live") + " · " : "";
    return (s.starred ? "★ " : "") + (s.open_asks ? "● " : "") + state + nameOf(s) + (s.last_at ? " · " + ago(s.last_at) : "");
  }
  function fillPicker() {
    const select = byId("session");
    if (document.activeElement === select) { pickerDirty = true; return; }  // an open list is not redrawn under the hand: it is, when it is let go
    pickerDirty = false;
    const asking = [], live = [], starred = [], recent = [];
    for (const s of S.sessions) (s.open_asks && liveOf(s.id) ? asking : liveOf(s.id) ? live : s.starred ? starred : recent).push(s);
    select.replaceChildren();
    const group = (label, list) => { if (!list.length) return; const g = document.createElement("optgroup"); g.label = label; for (const s of list) { const o = document.createElement("option"); o.value = s.id; o.textContent = optionText(s); g.append(o); } select.append(g); };
    group("Needs you", asking); group("Open panes", live); group("Starred", starred); group("Recent", recent);
    if (S.cur) select.value = S.cur;
  }
  function paintHeader() {
    const live = liveOf(S.cur), s = S.byId.get(S.cur);
    const pane = byId("pane");
    pane.textContent = live ? (PANE_STATES[live.status] || live.status) : (s ? "No pane" : "");
    pane.className = "live" + (live && live.status === "working" ? " on" : "");
    document.title = (s ? nameOf(s) : "Reader") + " · Reader (windowed)";
    byId("send").disabled = !live; byId("text").disabled = !live;
    byId("text").placeholder = live ? "Message" : "No open pane runs this session";
    // The connection says whether what is on screen is current; the store's own time is shown only when it is not.
    const conn = byId("conn");
    conn.textContent = S.live_ok ? "Live" : (S.retrying ? "Reconnecting…" : "");
    conn.className = "live" + (S.live_ok ? " on" : "");
    byId("asof").textContent = !S.live_ok && S.asOf ? "Not live: the store was last heard from at " + fmtTime(Date.parse(S.asOf) / 1000) : "";
  }
  function paintAsks() {
    const strip = byId("asks-strip");
    strip.replaceChildren();
    strip.hidden = !S.asks.length;
    for (const ask of S.asks.slice(0, 6)) {
      const b = $("button", "btn ask-chip"); b.type = "button";
      b.append($("b", null, (liveOf(ask.session) && liveOf(ask.session).label) || ask.pane_id), $("span", null, " " + (ask.lines[0] || "asks you something")));
      b.addEventListener("click", () => openSession(ask.session, { uid: ask.message }));
      strip.append(b);
    }
  }
  async function loadSessions() {
    const answer = await api("sessions?limit=100");
    S.asOf = answer.as_of;
    S.sessions = answer.sessions; S.byId = new Map(answer.sessions.map(s => [s.id, s]));
    for (const s of answer.sessions) if (s.live) S.live.set(s.id, s.live);
    fillPicker();
  }

  async function openSession(id, { idx = null, uid = null } = {}) {
    if (!id) return;
    S.cur = id; S.jumped = false; S.open.clear();
    history.replaceState(null, "", "#s=" + id);
    byId("session").value = id;
    byId("new-reply").hidden = true;
    S.loading = true; byId("empty").hidden = true;
    try {
      let answer;
      if (idx !== null) { answer = await api(`sessions/${id}/turns?after=${Math.max(-1, idx - 6)}&limit=${PAGE}`); S.jumped = answer.more_after; }
      else answer = await api(`sessions/${id}/turns?limit=${FIRST}`);
      S.loading = false;
      setWindow(answer, { toEnd: idx === null });
      if (idx !== null) { const node = S.nodes.get(idx); if (node) node.scrollIntoView({ block: "start" }); }
      say("");
    } catch (error) { S.loading = false; S.turns = []; paint(); say(error.status === 404 ? "That session is not on this page's list." : error.message, true); }
    paintHeader();
    connect();
  }

  // ---------------------------------------------------------------- the stream
  let controller = null, retry = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  function handle(name, data) {
    stats.events += 1;
    if (name === "hello") {
      S.asOf = data.as_of;
      const have = data.sessions[S.cur];
      if (have && have.last_idx > S.lastIdx) catchUp();
      paintHeader();
    } else if (name === "live") {
      if (data.snapshot) S.live.clear();
      for (const c of data.changes) { if (c.live) S.live.set(c.id, c.live); else S.live.delete(c.id); const row = S.byId.get(c.id); if (row) row.live = c.live; }
      fillPicker(); paintHeader();
    } else if (name === "session") {
      const row = S.byId.get(data.id);
      if (row) { row.turns = data.turns; row.last_at = data.last_at; if (data.title) row.title = data.title; row.log_state = data.log_state; fillPicker(); }
      else if (!listing) { listing = true; loadSessions().catch(() => {}).finally(() => { listing = false; }); }  // a session this page has not listed yet
    } else if (name === "turns") {
      if (data.id === S.cur) merge(data.turns, data.marks);
    } else if (name === "resync") {
      if (data.id === S.cur) openSession(S.cur);
    } else if (name === "asks") {
      S.asks = data.asks; for (const s of S.sessions) s.open_asks = S.asks.filter(a => a.session === s.id).length;
      paintAsks(); fillPicker();
    }
  }
  async function connect() {
    if (controller) controller.abort();
    if (document.hidden) return;
    const mine = controller = new AbortController();
    stats.streams += 1;
    try {
      const response = await fetch(API + "stream" + (S.cur ? "?sessions=" + encodeURIComponent(S.cur) : ""), { cache: "no-store", signal: mine.signal, headers: { "x-transcript-reader-token": token } });
      if (!response.ok || !response.body) throw new Error("stream " + response.status);
      retry = 0; S.live_ok = true; S.retrying = false; paintHeader();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          let name = "message", data = "";
          for (const line of block.split("\n")) { if (line.startsWith("event: ")) name = line.slice(7); else if (line.startsWith("data: ")) data += line.slice(6); }
          if (data) { try { handle(name, JSON.parse(data)); } catch (e) { /* one bad event is not the stream */ } }
        }
      }
    } catch (error) { if (error && error.name === "AbortError") return; }
    if (mine !== controller || document.hidden) return;
    S.live_ok = false; S.retrying = true; paintHeader();
    retry += 1;
    await pause(Math.min(30000, 500 * 2 ** retry));
    if (mine === controller && !document.hidden) { await catchUp(); connect(); }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (controller) { controller.abort(); controller = null; } S.live_ok = false; return; }
    catchUp().then(() => connect());
  });

  // ---------------------------------------------------------------- search, send, controls
  function say(text, bad) { const el = byId("note"); el.textContent = text || ""; el.hidden = !text; el.className = "note" + (bad ? " bad" : ""); }
  async function search() {
    const q = byId("q").value.trim();
    const box = byId("results");
    if (!q) { box.hidden = true; return; }
    try {
      const answer = await api("search?q=" + encodeURIComponent(q));
      box.replaceChildren();
      box.hidden = false;
      box.append($("div", "notes", `${answer.results.length} conversation${answer.results.length === 1 ? "" : "s"}${answer.scope === "curated" ? " among the starred and open ones" : ""}`));
      for (const hit of answer.results) {
        const b = $("button", "hit"); b.type = "button";
        b.append($("b", null, (liveOf(hit.id) && liveOf(hit.id).label) || hit.title || folderName(hit.cwd) || hit.id.slice(0, 8)), $("span", "when", " · " + (hit.last_at ? ago(hit.last_at) : "")));
        const snippet = $("div", "snip");
        const parts = String(hit.snippet || "").split(/(\[\[|\]\])/);
        let on = false;
        for (const part of parts) { if (part === "[[") on = true; else if (part === "]]") on = false; else if (part) { if (on) snippet.append($("mark", null, part)); else snippet.append(document.createTextNode(part)); } }
        b.append(snippet);
        b.addEventListener("click", () => { box.hidden = true; openSession(hit.id, { idx: hit.turn_idx }); });
        box.append(b);
      }
    } catch (error) { say(error.message, true); }
  }
  async function sendMessage() {
    const text = byId("text").value.trim();
    if (!text || !S.cur) return;
    byId("send").disabled = true;
    try {
      await api("send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: S.cur, text }) });
      byId("text").value = "";
      say("Sent.");
    } catch (error) { say(error.message, true); }
    paintHeader();
  }

  byId("session").addEventListener("change", e => { openSession(e.target.value); e.target.blur(); });
  byId("session").addEventListener("blur", () => { if (pickerDirty) fillPicker(); });
  byId("q").addEventListener("keydown", e => { if (e.key === "Enter") search(); else if (e.key === "Escape") byId("results").hidden = true; });
  byId("send").addEventListener("click", sendMessage);
  byId("text").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); } });
  byId("older").addEventListener("click", loadOlder);
  byId("back").addEventListener("click", () => openSession(S.cur));
  byId("new-reply").addEventListener("click", () => { byId("new-reply").hidden = true; scrollEnd(); });
  window.addEventListener("scroll", () => {
    if (nearEnd()) byId("new-reply").hidden = true;
    if (window.scrollY < 300 && S.moreBefore && !S.loading) loadOlder();
  }, { passive: true });
  main.addEventListener("click", e => {
    const button = e.target.closest("button.copy");
    if (!button) return;
    const pre = button.parentElement.querySelector("pre");
    if (pre && navigator.clipboard) navigator.clipboard.writeText(pre.textContent).then(() => { button.dataset.label = "Copied"; setTimeout(() => { button.dataset.label = "Copy"; }, 1200); }, () => {});
  });

  (async () => {
    try {
      await loadSessions();
      const wanted = (/^#s=([0-9A-Za-z_-]{1,64})/.exec(location.hash) || [])[1];
      const first = (wanted && S.byId.get(wanted)) || S.sessions.find(s => liveOf(s.id)) || S.sessions.find(s => s.starred) || S.sessions[0];
      if (first) await openSession(first.id); else { paintHeader(); byId("empty").hidden = false; connect(); }
    } catch (error) { say(error.message, true); }
  })();
