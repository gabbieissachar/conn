/* The Tasks page: one board per Firstmate session (big-boss, each leader, and the workers you drive), columns from the session's lifecycle,
   a card per task with its open calls, the reply thread and the reply that asked each call. Reads /api/transcript-reader/board*; answers and marks
   go back through the board's two flagged routes (the page learns from `write` in each answer which are on, and says so where one is off).
   Every string comes in as text (textContent), never as markup. */
(() => {
  "use strict";
  const API = "/api/transcript-reader/";
  const READER = "/setup/transcript-reader/out/prototype.html";
  const token = (document.querySelector('meta[name="reader-token"]') || {}).content || "";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const phone = () => window.innerWidth <= 720;
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const utc = (d) => { const [y, m, dd] = d.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, dd); };
  const fmt = (d) => { if (!d) return ""; const x = new Date(utc(d)); return DAYS[x.getUTCDay()] + " " + x.getUTCDate() + " " + MON[x.getUTCMonth()]; };
  const short = (s, n) => { s = (s || "").replace(/\s+/g, " ").trim(); if (s.length <= n) return s; const cut = s.slice(0, n); return cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : n) + "…"; };
  const label = (c) => (c.id === "call" || c.id === "wait" || c.id === "default" ? "" : c.id);
  const REVIEW_LINK = /^http:\/\/127\.0\.0\.1:\d+\/session\/\w+$/;
  const readerLink = (l) => (l && l.s && l.m ? READER + "#s=" + encodeURIComponent(l.s) + "&m=" + encodeURIComponent(l.m) : null);

  const S = {
    sessions: [], session: null, board: null, write: { marks: false, answer: false, send: false }, loadedAt: 0, error: null, loading: false,
    project: "all", q: "", col: "needs", open: null, grouped: true, shut: {}, barOpen: false, workersOpen: false,
    drafts: {}, confirm: null, busy: null, notice: {}, picker: null, grp: {}, unfold: {}, order: {},
    hidden: new Map(), showHidden: false, full: {}, fullText: {}, fullBusy: {},
  };
  /* The message box at the foot of a card (composer.js): it writes to the supervisor conversation this board reads that has a live Herdr pane (the newest if
     several), else the newest one, and says why Send is off. Its send is the board's own flagged route (PMOS_READER_BOARD_SEND=1). */
  const composer = boardComposer({
    sendOn: () => !!S.write.send,
    target: () => composerTarget(),
    send: (sid, text) => post("board-send", { session: S.session, session_id: sid, text }),
  });
  function composerTarget() {
    const th = S.board && S.board.threads; if (!th || th.status !== "ok") return null;
    const list = (th.session_list || []).slice().sort((a, b) => (b.last || 0) - (a.last || 0)); if (!list.length) return null;
    const panes = composer.state().panes || {}, pick = list.find((x) => panes[x.id]) || list[0];
    return { sid: pick.id, name: (panes[pick.id] && panes[pick.id].label) || S.board.session.label };
  }
  const items = () => (S.board ? S.board.items : []);
  const byRef = () => Object.fromEntries(items().map((t) => [t.ref, t]));
  const ageDays = (d) => (d && S.board ? Math.round((utc(S.board.today) - utc(d)) / 864e5) : null);
  const ago = (d) => { const n = ageDays(d); if (n == null) return ""; return n <= 0 ? "today" : n === 1 ? "yesterday" : n + "d ago"; };
  const newest = (t) => t.calls.map((c) => c.since).filter(Boolean).sort().slice(-1)[0] || t.since;
  const goOnly = (t) => t.calls.length > 0 && t.calls.every((c) => c.type === "go");

  function toast(msg) { const old = document.querySelector(".toast"); if (old) old.remove(); const e = el("div", "toast", msg); document.body.append(e); setTimeout(() => e.remove(), 2600); }
  async function copy(text, what) { try { await navigator.clipboard.writeText(text); } catch (_) { /* clipboard can be blocked */ } toast("Copied " + what + ": " + short(text, 80)); }
  async function api(path, options) {
    const res = await fetch(API + path, { ...options, headers: { "x-transcript-reader-token": token, "content-type": "application/json" } });
    let body = {}; try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) { const error = new Error(body.message || "The reader answered " + res.status + "."); error.status = res.status; throw error; }
    return body;
  }
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

  /* ---- loading ---- */
  async function loadSessions() {
    try {
      const data = await api("board-sessions");
      S.sessions = data.sessions || []; S.write = data.write || S.write;
      if (data.error) S.notice.config = data.error; else delete S.notice.config;
    } catch (e) { S.error = e.message; }
  }
  /* The replies hidden from view are the reader's own list (its hidden.json behind /hidden, keys "<turn id>:reply"): hiding here hides there, and the reverse. */
  async function loadHidden() {
    try { const r = await live.hiddenList(); S.hidden = new Map((r.hidden || []).map((h) => [h.key, h])); } catch (_) { /* no list: nothing is hidden */ }
  }
  async function loadBoard(fresh) {
    if (!S.session) return;
    const asked = S.session;
    S.loading = !S.board;
    try {
      const data = await api("board?session=" + encodeURIComponent(asked) + (fresh ? "&fresh=1" : ""));
      if (asked !== S.session) return;
      S.board = data.board; S.write = data.write || S.write; S.loadedAt = data.cached_at || Date.now(); S.error = null; S.stale = !!data.stale;
      if (data.stale) setTimeout(() => { if (S.session === asked) loadBoard(false); }, 9000);  // an older board came at once; the new one is being built
    } catch (e) { if (asked === S.session) { S.error = e.message; S.board = S.board && S.board.session.id === asked ? S.board : null; } }
    S.loading = false;
    await loadHidden();
    render();
  }
  function chooseSession(id) {
    if (id === S.session) return;
    S.session = id; S.board = null; S.project = "all"; S.q = ""; S.open = null; S.col = "needs"; S.drafts = {}; S.confirm = null; S.error = null; S.stale = false;
    $("find").value = ""; composer.detach(); $("layer").textContent = "";
    history.replaceState(null, "", "#s=" + encodeURIComponent(id));
    render(); loadBoard(false);
  }

  /* ---- filters ---- */
  function visible(t, ignore) {
    if (ignore !== "project" && S.project !== "all" && t.repo !== S.project) return false;
    if (S.q) { const hay = (t.ref + " " + t.title + " " + t.calls.map((c) => c.id + " " + c.q).join(" ")).toLowerCase(); if (!hay.includes(S.q.toLowerCase())) return false; }
    return true;
  }

  /* ---- header ---- */
  function renderBar() {
    const sl = $("sessline"); sl.textContent = "";
    const shown = S.sessions.filter((s) => s.enabled !== false);
    shown.forEach((s) => {
      const b = el("button", "sess" + (s.kind === "worker" ? " worker" : "")); b.type = "button"; b.setAttribute("aria-pressed", String(S.session === s.id));
      b.append(el("span", "sl", s.label || s.id)); if (S.board && S.board.session.id === s.id) b.append(el("span", "n", String(S.board.items.filter((t) => t.col !== "done").length)));
      b.title = (s.label && s.label !== s.id ? s.label + " · " : "") + s.id + (s.kind === "worker" ? " (a worker you drive)" : ""); b.onclick = () => chooseSession(s.id); sl.append(b);
    });
    const workers = S.sessions.filter((s) => s.kind === "worker");
    if (workers.length) { const m = el("button", "more", (S.workersOpen ? "Hide workers" : "Workers you drive") + " (" + workers.filter((w) => w.enabled !== false).length + "/" + workers.length + ")"); m.type = "button"; m.onclick = () => { S.workersOpen = !S.workersOpen; renderWorkers(); renderBar(); }; sl.append(m); }
    if (S.board) { const lc = el("span", "lcchip"); lc.append("Lifecycle ", el("b", "", S.board.lifecycle.name)); lc.title = S.board.lifecycle.blurb; sl.append(lc); }
    const sel = $("project"); sel.textContent = "";
    const counts = {}; items().forEach((t) => { if (t.col !== "done" && visible(t, "project")) counts[t.repo] = (counts[t.repo] || 0) + 1; });
    const o0 = el("option", "", "All projects (" + Object.values(counts).reduce((a, b) => a + b, 0) + ")"); o0.value = "all"; sel.append(o0);
    Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => { const o = el("option", "", r + " (" + n + ")"); o.value = r; sel.append(o); });
    if (S.project !== "all" && !counts[S.project]) { const o = el("option", "", S.project + " (0)"); o.value = S.project; sel.append(o); }
    sel.value = S.project; sel.onchange = () => { S.project = sel.value; render(); };
    const name = S.board ? S.board.session.label : S.session || "";
    $("crumb").textContent = name + " · " + (S.project === "all" ? "All projects" : S.project) + (S.board ? " · " + S.board.lifecycle.name : "");
    const bar = $("bar"); bar.classList.toggle("collapsed", phone() && !S.barOpen);
    $("bar-toggle").setAttribute("aria-expanded", String(!bar.classList.contains("collapsed")));
    const g = $("group"); g.setAttribute("aria-pressed", String(S.grouped)); g.onclick = () => { S.grouped = !S.grouped; render(); };
    $("refresh").onclick = () => { S.loading = true; toast("Reading the fleet again..."); loadBoard(true); };
  }
  function renderWorkers() {
    const box = $("workers"); box.textContent = ""; box.hidden = !S.workersOpen;
    if (!S.workersOpen) return;
    box.className = "workers"; box.append(el("h4", "", "Workers you drive"));
    box.append(el("p", "hint", "A worker you drive directly gets a board of its own. Switch one off to hide it; the worker is unaffected."));
    S.sessions.filter((s) => s.kind === "worker").forEach((w) => {
      const lab = el("label"); const c = el("input"); c.type = "checkbox"; c.checked = w.enabled !== false;
      c.onchange = async () => { try { await post("board-worker", { leader: w.parent, task: w.task, enabled: c.checked }); w.enabled = c.checked; if (!c.checked && S.session === w.id) chooseSession(S.sessions[0].id); renderBar(); } catch (e) { c.checked = !c.checked; toast(e.message); } };
      lab.append(c, el("span", "", (w.task || w.id) + " · under " + w.parent)); box.append(lab);
    });
  }
  function renderBanners() {
    const box = $("banners"); box.textContent = "";
    const add = (text, cls) => box.append(el("p", "banner" + (cls ? " " + cls : ""), text));
    if (S.error) add("The board could not be read: " + S.error);
    if (!S.board) return;
    (S.board.source.errors || []).forEach((e) => add(e));
    const th = S.board.threads || {};
    if (th.status && th.status !== "ok") add("Reply threads are off for this board: " + (th.message || th.status) + ". Cards still show their calls and where the task stands.", "info");
    if (S.notice.config) add(S.notice.config);
    const as = $("asof"); as.textContent = "";
    const d = new Date((S.board.generated_at || 0) * 1000);
    as.append(S.board.session.label + " · read ", el("b", "", d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })));
    if (S.stale) as.append(el("span", "", " · refreshing"));
    if (th.asof) as.append(" · transcripts as of " + new Date(th.asof * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));
    const on = [S.write.answer ? "answers" : null, S.write.marks ? "marks" : null, S.write.send ? "messages to the supervisor" : null].filter(Boolean);
    as.append(" · " + (on.length ? "writes on: " + on.join(" and ") : "read only"));
  }

  /* ---- cards ---- */
  function chips(t, top) {
    top.append(el("span", "chip", t.repo));
    if (t.kind === "captain") top.append(el("span", "chip kind", "call")); else if (t.kind && t.kind !== "task") top.append(el("span", "chip kind", t.kind));
  }
  function refLine(t) {
    const r = el("div", "c-ref"); r.append(el("code", "", t.ref));
    const b = el("button", "copy", "Copy"); b.type = "button"; b.title = "Copy the reference to paste in chat"; b.onclick = (e) => { e.stopPropagation(); copy(t.ref, "reference"); };
    r.append(b); return r;
  }
  function ageText(t) {
    if (t.col === "done") return "done " + fmt(t.done_date);
    if (t.col === "parked") return "back " + fmt(t.until);
    if (t.calls.length && t.col === "needs") return "asked " + ago(newest(t));
    return t.col === "queued" ? "since " + ago(t.since) : t.latest && t.latest.when ? "active " + ago(t.latest.when.slice(0, 10)) : "since " + ago(t.since);
  }
  function footer(t) {
    const f = el("div", "c-foot"), flags = t.flags || [];
    if (t.thread_n) { const c = el("span", "chip thr"); c.append("thread ", el("b", "", String(t.thread_n)), t.thread_you ? " · " + t.thread_you + " from you" : ""); f.append(c); }
    if (t.legacy) f.append(el("span", "chip legacy", "legacy draft branch"));
    else if (t.ready || t.branch) f.append(el("span", "chip " + (t.ready ? "ok" : "br"), t.ready ? "ready · " + (t.branch || "") + (t.head_sha ? " @" + t.head_sha.slice(0, 7) : "") : t.branch));
    if (flags.includes("go_gate")) f.append(el("span", "chip go", "waits for your go"));
    if (t.wait_on && t.col === "waiting") f.append(el("span", "chip wait", "waiting on " + t.wait_on));
    if (t.pr) f.append(el("span", "chip ok", "PR"));
    if (t.report) f.append(el("span", "chip", "report"));
    if (t.blocked_by.length) f.append(el("span", "chip warn", "blocked by " + t.blocked_by.length));
    if (flags.includes("stale_merged")) f.append(el("span", "chip warn", "says finished: record still open"));
    if (flags.includes("branch_in_main")) f.append(el("span", "chip stale", "branch already in main"));
    if (t.driven) f.append(el("span", "chip", "you drive"));
    if (flags.includes("quiet_14d")) f.append(el("span", "chip warn", "quiet " + t.idle_days + "d"));
    else if (t.col === "running" && t.idle_days != null && t.idle_days >= 5) f.append(el("span", "chip warn", "quiet " + t.idle_days + "d"));
    return f.children.length ? f : null;
  }
  function card(t) {
    const c = el("article", "card " + t.col); c.tabIndex = 0; c.setAttribute("role", "button"); c.dataset.ref = t.ref;
    const top = el("div", "c-top"); chips(t, top); top.append(el("span", "age", ageText(t))); c.append(top);
    c.append(el("h3", "c-title", t.title)); c.append(refLine(t));
    if (t.calls.length && (t.col === "needs" || (t.col === "queued" && goOnly(t)))) {
      const ul = el("ul", "c-calls");
      t.calls.slice(0, 4).forEach((k) => { const li = el("li"); li.append(el("span", "lab", label(k) || (k.type === "go" ? "go" : k.type === "wait" ? "wait" : "•")), el("span", "t", short(k.q || t.title, 56))); ul.append(li); });
      if (t.calls.length > 4) ul.append(el("li", "more", "+" + (t.calls.length - 4) + " more calls"));
      c.append(ul);
    } else if (t.latest) {
      const l = el("p", "c-latest"); l.append(el("span", "st " + t.latest.state, t.latest.state), (t.latest.when ? t.latest.when.slice(5, 10) + " · " : "") + t.latest.text); c.append(l);
    }
    const f = footer(t); if (f) c.append(f);
    c.onclick = () => openSheet(t.ref); c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSheet(t.ref); } };
    return c;
  }

  /* ---- columns ---- */
  function needsBody(body, list) {
    const age = (t) => ageDays(newest(t));
    const newestFirst = (a, b) => (age(a) ?? 99) - (age(b) ?? 99);
    if (!S.grouped) { list.sort(newestFirst).forEach((t) => body.append(card(t))); return; }
    const old = list.filter((t) => (age(t) ?? 0) > 14), fresh = list.filter((t) => !((age(t) ?? 0) > 14));
    const groups = [["Open questions", fresh.filter((t) => !goOnly(t)), true], ["Waiting for your go", fresh.filter(goOnly), false], ["Older than 14 days", old, false]].filter((g) => g[1].length);
    groups.forEach(([name, group, open]) => {
      const d = el("details", "grp"); d.open = name in S.grp ? S.grp[name] : (open || groups.length === 1);
      d.addEventListener("toggle", () => { S.grp[name] = d.open; act.textContent = d.open ? "fold" : "show"; });
      const s = el("summary"); const act = el("span", "act", d.open ? "fold" : "show"); s.append(name, el("span", "n", String(group.length)), act); d.append(s);
      const gb = el("div", "grp-body"); group.sort(newestFirst).forEach((t) => gb.append(card(t))); d.append(gb); body.append(d);
    });
  }
  function render() {
    renderBar(); renderBanners(); renderWorkers();
    const colsEl = $("cols"), colbar = $("colbar");
    const keep = {}; document.querySelectorAll(".col").forEach((c) => { const b = c.querySelector(".col-b"); if (b) keep[c.dataset.col] = b.scrollTop; });
    colsEl.textContent = ""; colbar.textContent = ""; S.order = {};
    if (!S.board) { colsEl.append(el("div", "loading", S.error ? "Nothing to show yet." : "Reading the fleet... the first read of a session takes about fifteen seconds.")); $("upkeep").hidden = true; return; }
    const cols = S.board.columns, ph = phone();
    if (!cols.some((c) => c.id === S.col)) S.col = "needs";
    const lists = Object.fromEntries(cols.map((col) => [col.id, items().filter((t) => t.col === col.id && visible(t))]));
    const anyCards = cols.some((col) => lists[col.id].length);
    colbar.append(el("span", "lbl", "More columns than fit: jump to"));
    cols.forEach((col) => {
      const list = lists[col.id], empty = !list.length, rail = !ph && anyCards && empty && !S.unfold[col.id];
      const tab = el("button", "ctab " + col.id); tab.type = "button"; tab.setAttribute("role", ph ? "tab" : "button"); if (ph) tab.setAttribute("aria-selected", String(S.col === col.id));
      tab.append(col.name, el("span", "n", String(list.length)));
      tab.onclick = () => { if (phone()) { S.col = col.id; render(); } else { if (empty && !S.unfold[col.id]) { S.unfold[col.id] = true; render(); } const n = document.querySelector('.col[data-col="' + col.id + '"]'); if (n) n.scrollIntoView({ inline: "start", block: "nearest", behavior: "smooth" }); } };
      colbar.append(tab);
      const c = el("section", "col " + col.id + (S.col === col.id ? " on" : "") + (rail ? " rail" : "") + (empty && anyCards && !ph ? " fold" : "")); c.dataset.col = col.id;
      const h = el("div", "col-h"); const ct = el("div", "col-t"); ct.append(col.name, el("span", "n", String(list.length)));
      if (empty && anyCards && !ph) { h.onclick = () => { S.unfold[col.id] = !S.unfold[col.id]; render(); }; h.title = rail ? "Nothing here: click to open the column" : "Click to fold this empty column"; ct.append(el("span", "fold-hint", "fold")); }
      h.append(ct, el("div", "col-s", col.id === "needs" && S.grouped && list.length && list.every((t) => (ageDays(newest(t)) ?? 0) > 14) ? list.length + " open, all older than 14 days" : col.sub)); c.append(h);
      const body = el("div", "col-b");
      if (!list.length) body.append(el("div", "empty", "Nothing here with these filters."));
      else if (col.id === "needs") needsBody(body, list);
      else if (col.id === "parked") list.sort((a, b) => (a.until || "").localeCompare(b.until || "")).forEach((x) => body.append(card(x)));
      else if (col.id === "done") list.sort((a, b) => (b.done_date || "").localeCompare(a.done_date || "")).forEach((x) => body.append(card(x)));
      else list.forEach((x) => body.append(card(x)));
      c.append(body); colsEl.append(c);
      S.order[col.id] = [...body.querySelectorAll(".card[data-ref]")].map((n) => n.dataset.ref);  // the cards as shown (groups and sort included): what Back and Next walk
    });
    document.querySelectorAll(".col").forEach((c) => { const b = c.querySelector(".col-b"); if (b && keep[c.dataset.col]) b.scrollTop = keep[c.dataset.col]; });
    renderUpkeep(); requestAnimationFrame(updateOverflow);
    if (S.open) { const sb = document.querySelector(".sh-body"); if (sb) S.open.keepScroll = sb.scrollTop; renderSheet(); }
  }

  /* ---- more columns than the window: say so, and say which are out of sight ---- */
  function updateOverflow() {
    const c = $("cols"), cb = $("colbar");
    const ovf = !phone() && !!S.board && c.scrollWidth > c.clientWidth + 2;
    document.body.classList.toggle("ovf", ovf);
    if (!ovf) return;
    const box = c.getBoundingClientRect(), tabs = [...cb.querySelectorAll(".ctab")];
    [...c.querySelectorAll(".col")].forEach((col, i) => {
      const r = col.getBoundingClientRect(), full = r.left >= box.left - 1 && r.right <= box.right + 1;
      if (tabs[i]) { tabs[i].classList.toggle("off", !full); tabs[i].dataset.dir = r.left < box.left - 1 ? "\u2190" : "\u2192"; }
    });
  }

  /* ---- Fleet upkeep and No task found: replies that reach no card ---- */
  function renderUpkeep() {
    const box = $("upkeep"); box.textContent = ""; box.hidden = true;
    const th = S.board && S.board.threads; if (!th || th.status !== "ok") return;
    box.hidden = false;
    [["Fleet upkeep", th.upkeep, "routine replies: acknowledged notices, wake-ups, session restarts. Nothing to decide."], ["No task found", th.notask, "replies about something the rules could not tie to a task. Mark them, or they stay here."]].forEach(([name, g, sub]) => {
      const d = el("details", "up"); const sm = el("summary"); sm.append(name, el("span", "n", String(g.n)), el("span", "sub", sub)); d.append(sm);
      const ul = el("ul");
      g.items.forEach((it) => {
        const li = el("li"); li.append(el("span", "when", fmt(it.d) + " " + it.hm), el("span", "tx", it.text));
        const link = readerLink(it.link); if (link) { const a = el("a", "mk", "Open"); a.href = link; a.target = "_blank"; a.rel = "noopener"; li.append(a); }
        if (S.write.marks) { const b = el("button", "mk", "Belongs to task…"); b.type = "button"; b.onclick = () => openPicker(it); li.append(b); }
        ul.append(li);
        if (S.picker && S.picker.key === it.key) ul.append(pickerRow(it));
      });
      d.append(ul); if (g.n > g.items.length) d.append(el("div", "hint", "Newest " + g.items.length + " of " + g.n + " shown."));
      box.append(d);
    });
  }
  function openPicker(it) { S.picker = { key: it.key, ref: null }; render(); }
  function pickerRow(it) {
    const li = el("li"); const row = el("div", "picker"); const sel = el("select"); sel.setAttribute("aria-label", "Task this reply belongs to");
    const o0 = el("option", "", "Pick a task"); o0.value = ""; sel.append(o0);
    items().filter((t) => t.col !== "done").sort((a, b) => a.ref.localeCompare(b.ref)).forEach((t) => { const o = el("option", "", short(t.ref, 60)); o.value = t.ref; sel.append(o); });
    const go = el("button", "recbtn", "Mark it"); go.type = "button"; go.disabled = true; sel.onchange = () => { go.disabled = !sel.value; };
    go.onclick = () => sendMark(sel.value, it.key, "in");
    const no = el("button", "ghost", "Cancel"); no.type = "button"; no.onclick = () => { S.picker = null; render(); };
    row.append(sel, go, no); li.append(row); return li;
  }
  async function sendMark(task, turn, mark) {
    try {
      await post("board-mark", { session: S.session, task, turn, mark });
      S.picker = null; toast(mark === "clear" ? "Mark withdrawn" : mark === "in" ? "Marked: this reply belongs to " + task : "Marked: not " + task);
      await loadBoard(true);
    } catch (e) { toast(e.message); }
  }

  /* ---- the thread ---- */
  /* What each tag on a reply says, in plain words: its tooltip, and the legend under the thread's heading. The tags come from board/tagger.py. */
  const TAGS = [
    { name: "mention", test: (w) => w === "mention", tip: "The reply names the task id." },
    { name: "command", test: (w) => w === "command", tip: "The turn's own tool calls name the task (for example a message sent to its worker)." },
    { name: "pointer", test: (w) => w === "pointer", tip: "The reply points at the task's files, its branch or PR, or its own review board." },
    { name: "wake", test: (w) => w === "wake", tip: "The wake-up that started this turn named the task." },
    { name: "signal", test: (w) => w === "signal", tip: "The reader tied the wake-up that started this turn to the task." },
    { name: "roundup: N tasks", test: (w) => /^roundup: \d+ tasks$/.test(w), tip: "A reply about several tasks at once. It sits on each of their cards, so it says little about any one of them." },
    { name: "keyed", test: (w) => /^keyed /.test(w), tip: "A call key (like R2) that only this task carries appears in the reply. A weak hint." },
    { name: "title / id words", test: (w) => /^(title|id) words: /.test(w), tip: "Rare words of the task's title or id appear in the reply. A weak hint, so it only counts when three id words match." },
    { name: "named in a sweep", test: (w) => /^named in a sweep/.test(w), tip: "The task id is one of many in a long list. Weak, so the reply stays off the card unless you mark it." },
    { name: "you marked it", test: (w) => /^you marked it/.test(w), tip: "You put this reply on (or took it off) this card yourself." },
    { name: "this worker's own session", test: (w) => w === "this worker's own session", tip: "A worker board: every reply in the worker's own session is about its task." },
  ];
  const tagTip = (w) => { const t = TAGS.find((x) => x.test(w)); return t ? t.tip : ""; };
  function whyChip(text, cls) { const c = el("span", "why " + cls, text), tip = tagTip(text); if (tip) c.title = tip; return c; }
  function tagLegend() {
    const d = el("details", "legend"); d.append(el("summary", "", "What the tags on a reply mean"));
    const dl = el("dl"); TAGS.filter((t) => t.name !== "title / id words" && t.name !== "named in a sweep").concat(TAGS.filter((t) => t.name === "title / id words")).forEach((t) => { dl.append(el("dt", "", t.name), el("dd", "", t.tip)); });
    d.append(dl, el("p", "hint", "Solid tags are exact (the rules are sure the reply is about this task). Dashed cards are possible matches: say yes or no and the board learns it."));
    return d;
  }
  /* A reply is drawn by the reader's own renderer (replyview.js): the start of it, then "Show full reply" (the rest is read on demand). A reply can be hidden
     (the reader's list), and commented on: select words in it, or press Reply, and the message box at the foot of the card points at it. */
  const hideKey = (it) => (it.link && it.link.m ? it.link.m + ":reply" : "");
  const isHidden = (it) => !!hideKey(it) && S.hidden.has(hideKey(it));
  const replyTexts = () => (S.board && S.board.threads && S.board.threads.texts) || {};
  const keepSheetPlace = () => { if (!S.open) return; const sb = document.querySelector(".sh-body"); if (sb) S.open.keepScroll = sb.scrollTop; renderSheet(); };
  async function setHidden(it, hide) {
    const key = hideKey(it); if (!key) return;
    try {
      const r = await live.hiddenChange(hide ? { op: "hide", key, conv: it.link.s, at: it.e } : { op: "unhide", key });
      S.hidden = new Map((r.hidden || []).map((h) => [h.key, h]));
    } catch (e) { toast("Could not " + (hide ? "hide" : "show") + " the reply: " + e.message); return; }
    keepSheetPlace();
    if (hide) toast("Hid the reply. \"Hidden\" above the thread shows it again.");
  }
  async function toggleFull(it, info, open) {
    if (!open) { delete S.full[it.key]; keepSheetPlace(); return; }
    S.full[it.key] = true;
    if (info.more && !S.fullText[it.key]) {
      S.fullBusy[it.key] = true; keepSheetPlace();
      try { S.fullText[it.key] = (await api("board-reply?session=" + encodeURIComponent(S.session) + "&sid=" + encodeURIComponent(it.link.s) + "&uid=" + encodeURIComponent(it.link.m))).md; }
      catch (e) { delete S.full[it.key]; toast("Could not read the whole reply: " + e.message); }
      delete S.fullBusy[it.key];
    }
    keepSheetPlace();
  }
  function replyBody(it) {
    const info = replyTexts()[it.key];
    if (!info) return el("div", "th-body", it.text);  // a board built before the texts came with it: the plain preview
    const md = S.full[it.key] && S.fullText[it.key] ? S.fullText[it.key] : info.md;
    return replyView.clipped(replyView.draw(md), { words: info.words, open: !!S.full[it.key], busy: !!S.fullBusy[it.key], toggle: (open) => toggleFull(it, info, open) });
  }
  /* The pointer a comment on this reply starts with: the conversation view's own words (live.pointer). A reply from an earlier session of the
     conversation than the one the box writes to is described by its words, since that session never saw it. */
  function replyTarget(it) {
    const info = replyTexts()[it.key], text = (S.full[it.key] && S.fullText[it.key]) || (info && info.md) || it.text;
    return (passage) => {
      const to = composerTarget(), earlier = !!(to && to.sid !== it.link.s);
      return { sid: it.link.s, passage, title: "Reply to " + (to ? to.name : S.board.session.label) + " · " + fmt(it.d) + " " + it.hm,
        pointer: (p) => (earlier ? "[From session " + it.link.s.slice(0, 8) + ", an earlier session of this conversation] " : "") + live.pointer(it.e, text, p, earlier, []) };
    };
  }
  function threadItem(t, it) {
    const gone = it.k === "reply" && isHidden(it);
    const box = el("div", "th-item " + (it.k === "reply" ? "reply" + (it.lvl === "possible" ? " possible" : "") + (it.lvl === "out" ? " out" : "") + (gone ? " gone" : "") : "you" + (it.req ? " possible" : ""))); box.dataset.key = it.key || "";
    const h = el("div", "th-h"); h.append(el("span", "who", it.k === "reply" ? S.board.session.label : "you"), el("span", "", it.hm));
    const mk = (text, mark, yes) => { const b = el("button", "mk" + (yes ? " yes" : ""), text); b.type = "button"; b.onclick = () => sendMark(t.ref, it.key, mark); return b; };
    if (it.k === "reply") {
      (it.why || []).forEach((w) => h.append(whyChip(w, it.lvl === "sure" || it.lvl === "marked" ? "sure" : it.lvl === "out" ? "out" : "poss")));
      if (it.n >= 3) h.append(whyChip("roundup: " + it.n + " tasks", "round"));
      h.append(el("span", "sp"));
      if (S.write.marks) {
        if (it.lvl === "out") h.append(mk("Put it back", "clear", true));
        else { if (it.lvl === "possible") h.append(mk("Yes, this task", "in", true)); h.append(it.lvl === "marked" ? mk("Withdraw mark", "clear") : mk("Not this task", "out")); }
      }
      if (hideKey(it)) {
        const hb = el("button", "mk hide", gone ? "Show again" : "Hide"); hb.type = "button"; hb.setAttribute("aria-pressed", String(gone));
        hb.title = gone ? "Show this reply in the thread again" : "Hide this reply here and in the conversation view. The session log is not changed; \"Hidden\" above the thread shows it again.";
        hb.onclick = () => setHidden(it, !gone); h.append(hb);
      }
      if (it.lvl !== "out") {
        const rb = el("button", "mk reply-to", "Reply"); rb.type = "button"; rb.title = "Reply to this in its session. Select words in the reply first to comment on just those.";
        rb.onclick = () => composer.quote(box); h.append(rb);
      }
    } else if (it.req) {
      const rq = el("span", "why poss", "your request · task started " + (it.mins <= 0 ? "at once" : it.mins + " min later")); rq.title = "Your message with no reply above it, sent shortly before this task started. A possible match: say yes or no."; h.append(rq, el("span", "sp"));
      if (S.write.marks) { h.append(mk("Yes, this task", "in", true), mk("Not this task", "out")); }
    } else { if (it.how) { const hw = el("span", "why", it.how); hw.title = /^keyed /.test(it.how) ? "Your message uses a call key (like R2) from the reply above it." : it.how === "answer sheet" ? "Your comment from an answer sheet, tied to the reply it quotes." : it.how === "next message" ? "Your message right after this reply." : /^you marked/.test(it.how) ? "You put this message on this card yourself." : it.how; h.append(hw); } h.append(el("span", "sp")); if (S.write.marks && it.marked) h.append(mk("Withdraw mark", "clear")); }
    const link = readerLink(it.link); if (link) { const a = el("a", "open-link", "open"); a.href = link; a.target = "_blank"; a.rel = "noopener"; a.title = "Open this reply in the conversation view"; h.append(a); }
    box.append(h);
    if (it.part) box.append(el("div", "th-part", "on: " + it.part));
    if (it.k === "reply") { box.append(replyBody(it)); if (it.lvl !== "out") composer.bind(box, replyTarget(it)); }
    else box.append(el("div", "th-body", it.text));
    return box;
  }
  function threadSection(t) {
    const sec = el("div", "sec"); sec.dataset.call = "thread";
    const hh = el("div", "th-top"); hh.append(el("h4", "", "Thread")); sec.append(hh);
    const th = S.board.threads || {};
    if (th.status && th.status !== "ok") { sec.append(el("div", "th-empty", "Reply threads are off: " + (th.message || th.status) + ".")); return sec; }
    if (!t.thread.length) {
      sec.append(el("div", "th-empty", "No reply matched this task. The rules found nothing, which is what a mark is for: open a reply under No task found and say it belongs here." + (S.write.marks ? "" : " (Marking is off in this reader.)")));
      return sec;
    }
    sec.append(tagLegend());
    const nHidden = t.thread.filter((it) => it.k === "reply" && isHidden(it)).length;
    if (nHidden || S.showHidden) {
      const tb = el("button", "mk hidden-toggle", S.showHidden ? "Hide the hidden replies" : "Hidden (" + nHidden + ")"); tb.type = "button"; tb.setAttribute("aria-pressed", String(S.showHidden));
      tb.title = S.showHidden ? "Take the hidden replies out of the thread again" : nHidden + " repl" + (nHidden === 1 ? "y is" : "ies are") + " hidden. Show them (each can be shown again for good).";
      tb.onclick = () => { S.showHidden = !S.showHidden; keepSheetPlace(); }; hh.append(tb);
    }
    const sum = el("p", "th-sum"); sum.append(el("b", "", t.thread_n + " repl" + (t.thread_n === 1 ? "y" : "ies")), " from " + S.board.session.label + (t.thread_you ? ", " + t.thread_you + " of yours attached" : "") + (nHidden && !S.showHidden ? ", " + nHidden + " hidden" : "") + ", oldest first.");
    sec.append(sum);
    if (t.thread_cut) sec.append(el("div", "th-more", "+" + t.thread_cut + " earlier repl" + (t.thread_cut === 1 ? "y" : "ies") + " not shown."));
    const list = el("div", "thread"); let day = null;
    t.thread.forEach((it) => {
      if (it.k === "reply" && isHidden(it) && !S.showHidden) return;
      if (it.d !== day) { day = it.d; list.append(el("div", "th-day", fmt(it.d))); }
      list.append(threadItem(t, it));
    });
    sec.append(list); return sec;
  }

  /* ---- answers ---- */
  const draft = (t, c) => (S.drafts[t.ref] || {})[c.id] || null;
  function setDraft(t, c, v) { (S.drafts[t.ref] = S.drafts[t.ref] || {})[c.id] = v; S.confirm = null; }
  function clearDraft(t, c) { if (S.drafts[t.ref]) delete S.drafts[t.ref][c.id]; S.confirm = null; }
  function choices(c) {
    if (c.opts.length) return c.opts;
    if (c.type === "go") return [{ k: "go", t: "Go: release it to run" }, { k: "drop", t: "Drop it" }];
    return [];
  }
  function answerPayload(t, c) {
    const d = draft(t, c); if (!d) return null;
    const base = { task: t.ref, call: c.id, src: c.src, calls: t.calls.length };
    if (c.src === "ask") return d.later ? { ...base, later: true } : d.o ? { ...base, option: d.o } : { ...base, text: d.text };
    if (d.o === "go") return { ...base, text: "go", release: true };
    const o = c.opts.find((x) => x.k === d.o);
    const words = d.text || (d.o === "drop" ? "drop it" : (label(c) ? label(c) + " -> " : "") + d.o + (o && o.t ? " (" + o.t + ")" : ""));
    return { ...base, option: d.o && /^[a-h]$/.test(d.o) ? d.o : undefined, text: words };
  }
  function draftWords(t, c) {
    const d = draft(t, c); if (!d) return "";
    const lead = label(c) ? label(c) + " = " : "";
    if (d.later) return lead + "later";
    if (d.text) return d.text;
    const o = choices(c).find((x) => x.k === d.o); return o ? (lead + (o.t || o.k)) : d.o;
  }
  function chatLine(t, c) { const d = draft(t, c); const w = d ? (d.later ? "later" : d.text || (d.o && d.o.length === 1 ? d.o : (choices(c).find((x) => x.k === d.o) || {}).t || d.o)) : ""; return t.ref + (label(c) ? "#" + c.id : "") + " = " + w; }
  function optButtons(t, c) {
    const wrap = el("div", "opts");
    if (c.type === "board") {
      const a = el("a", "ghost", "Open the review board"); a.target = "_blank"; a.rel = "noopener";
      if (c.link && REVIEW_LINK.test(c.link)) a.href = c.link;
      wrap.append(a, el("div", "hint", "This call is answered on that board, so the card has no answer controls here."));
      return wrap;
    }
    const cur = draft(t, c);
    choices(c).forEach((o) => {
      const b = el("button", "opt"); b.type = "button"; b.setAttribute("aria-pressed", String(!!(cur && cur.o === o.k)));
      b.append(el("span", "k", o.k.length === 1 ? o.k : "→"), el("span", "tx", o.t || (o.rec ? "the recommended answer" : "")));
      if (o.rec || (c.recommended && c.recommended === o.t)) b.append(el("span", "star", "★ recommended"));
      b.onclick = (e) => { e.stopPropagation(); if (cur && cur.o === o.k) clearDraft(t, c); else setDraft(t, c, { o: o.k }); render(); };
      wrap.append(b);
    });
    const other = el("div", "other"); const i = el("input"); i.type = "text"; i.placeholder = c.opts.length ? "Other: type your own answer" : c.src === "wait" || c.src === "status" ? "Reply to the worker" : "Type your answer";
    i.value = cur && cur.text ? cur.text : ""; i.setAttribute("aria-label", "Your answer");
    i.onchange = () => { const v = i.value.trim(); if (v) setDraft(t, c, { text: v }); else clearDraft(t, c); render(); };
    other.append(i); wrap.append(other);
    if (c.src === "ask") {
      const later = el("button", "opt"); later.type = "button"; later.setAttribute("aria-pressed", String(!!(cur && cur.later))); later.append(el("span", "k", "…"), el("span", "tx", "Later: keep it held, decide another time"));
      later.onclick = () => { if (cur && cur.later) clearDraft(t, c); else setDraft(t, c, { later: true }); render(); }; wrap.append(later);
    }
    return wrap;
  }
  function viaText(c, t) {
    const d = t ? draft(t, c) : null;
    return c.src === "ask" ? "fm-captain-ask.sh answered " + ((c.ask && c.ask.id) || "<ask>") : c.src === "hold" ? "fm-captain-hold.sh answers (" + (d && d.o === "go" ? "releases this hold so the work can run" : "closes this hold") + ")" : c.src === "status" ? "fm-send.sh " + "<task> --resolve-key " + c.id : "fm-send.sh <task>";
  }
  function answerBar(t, c) {
    const bar = el("div", "recbar");
    if (!S.write.answer) {
      bar.append(el("div", "off-note", "Answering on the card is off in this reader (PMOS_READER_BOARD_ANSWER=1 turns it on). Answer in chat:"));
      const cur = draft(t, c);
      const b = el("button", "ghost", "Copy answer for chat"); b.type = "button"; b.disabled = !cur; b.onclick = () => copy(chatLine(t, c), "answer");
      bar.append(b, el("span", "hint", cur ? chatLine(t, c) : "Pick an answer first.")); return bar;
    }
    if (c.src === "hold" && t.calls.length > 1) { const cur = draft(t, c); const b = el("button", "ghost", "Copy answer for chat"); b.type = "button"; b.disabled = !cur; b.onclick = () => copy(chatLine(t, c), "answer"); bar.append(b, el("span", "hint", cur ? chatLine(t, c) : "Pick an answer first.")); return bar; }
    const key = t.ref + "/" + c.id, cur = draft(t, c);
    if (S.confirm === key) {
      const cf = el("div", "confirm"); cf.append("This writes to " + S.board.session.label + "'s Firstmate home through ", el("code", "", viaText(c, t)), ": ", el("b", "", draftWords(t, c)));
      const row = el("div", "row"); const yes = el("button", "primary", S.busy === key ? "Recording…" : "Record it"); yes.type = "button"; yes.disabled = S.busy === key;
      yes.onclick = () => doAnswer(t, c); const no = el("button", "ghost", "Not yet"); no.type = "button"; no.onclick = () => { S.confirm = null; render(); };
      row.append(yes, no); cf.append(row); bar.append(cf);
    } else {
      const b = el("button", "recbtn", "Record this answer"); b.type = "button"; b.disabled = !cur; b.onclick = () => { S.confirm = key; S.notice[key] = null; render(); };
      bar.append(b, el("span", "hint", cur ? draftWords(t, c) : "Pick an answer first."));
    }
    if (S.notice[key]) bar.append(el("div", "err", S.notice[key]));
    return bar;
  }
  async function doAnswer(t, c) {
    const key = t.ref + "/" + c.id, payload = answerPayload(t, c); if (!payload) return;
    S.busy = key; render();
    try {
      await post("board-answer", { session: S.session, ...payload });
      S.busy = null; S.confirm = null; clearDraft(t, c); toast((label(c) || "Call") + " recorded"); await loadBoard(true);
    } catch (e) { S.busy = null; S.notice[key] = e.message; render(); }
  }

  /* ---- the sheet ---- */
  function askedRow(t, c) {
    const r = el("div", "asked"), a = c.asked;
    const i = t.calls.indexOf(c), prev = i > 0 ? t.calls[i - 1] : null;
    if (a && prev && prev.asked && prev.asked.key === a.key) { r.append("Asked in the same reply as ", el("b", "", label(prev) || "the call above"), "."); return r; }
    const th = S.board.threads || {};
    if (!a) { r.append(el("span", "quiet", th.status === "ok" ? "Asking reply: none found in the conversations the reader keeps (the call may be older than they are)." : "Asking reply: not available while reply threads are off.")); return r; }
    r.append("Asked in the reply of ", el("b", "", fmt(a.d) + " " + a.hm), a.how === "exact" ? el("span", "why sure", "names this ask") : a.how === "nearest" ? el("span", "why poss", "nearest reply to the hold time") : el("span", "why sure", "set in this reply's turn"));
    r.append(el("div", "ask-q", "“" + short(a.text, 160) + "”"));
    const link = readerLink(a.link); if (link) { const open = el("a", "ghost", "Open this reply in the reader"); open.href = link; open.target = "_blank"; open.rel = "noopener"; r.append(open); }
    return r;
  }
  function callBox(t, c) {
    const bx = el("div", "callbox" + (draft(t, c) ? " answered" : "")); bx.dataset.call = c.id;
    const tp = el("div", "c-top"); const lb = label(c); if (lb) tp.append(el("span", "chip lab", lb));
    tp.append(el("span", "chip", c.type === "go" ? "waiting for your go" : c.type === "board" ? "answered on a review board" : c.src === "status" ? "asked by the worker" : c.src === "wait" ? "worker is waiting" : c.src === "ask" ? "card for you" : "held for you"), el("span", "age", "asked " + ago(c.since || t.since)));
    bx.append(tp, el("div", "q", c.q || t.title));
    bx.append(askedRow(t, c)); bx.append(optButtons(t, c));
    if (c.type !== "board") bx.append(answerBar(t, c));
    return bx;
  }
  function renderSheet() {
    const t = byRef()[S.open.ref]; if (!t) { S.open = null; composer.detach(); $("layer").textContent = ""; return; }
    const L = $("layer"); L.textContent = "";
    const scrim = el("div", "scrim"); scrim.onclick = closeSheet; L.append(scrim);
    const sh = el("aside", "sheet"); sh.setAttribute("role", "dialog"); sh.setAttribute("aria-label", t.title);
    const head = el("div", "sh-head"); const row = el("div", "sh-row"); row.append(el("code", "sh-ref", t.ref));
    const cr = el("button", "copy", "Copy ref"); cr.type = "button"; cr.onclick = () => copy(t.ref, "reference");
    const cl = el("button", "copy", "Copy link"); cl.type = "button"; cl.onclick = () => copy(location.origin + location.pathname + "#s=" + encodeURIComponent(S.session) + "&t=" + encodeURIComponent(t.ref), "link");
    const x = el("button", "x", "✕"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.onclick = closeSheet;
    row.append(x, cr, cl); head.append(row); head.append(navRow(t)); head.append(el("div", "sh-title", t.title));
    const top = el("div", "c-top"); chips(t, top); const cn = S.board.columns.find((c) => c.id === t.col);
    top.append(el("span", "chip " + (t.col === "needs" ? "warn" : ["ready", "review", "pr", "done"].includes(t.col) ? "ok" : ""), cn ? cn.name : t.col)); head.append(top); sh.append(head);
    const body = el("div", "sh-body");
    if (t.calls.length) {
      const sec = el("div", "sec"); sec.append(el("h4", "", t.calls.length > 1 ? "Open calls" : "Open call"));
      if (t.head) sec.append(el("p", "hint", t.head));
      if (S.write.answer && t.calls.length > 1 && t.calls.every((c) => c.src === "hold")) sec.append(el("div", "off-note", "These " + t.calls.length + " calls are written as one block of text in the hold, and Firstmate can close such a hold only whole, so answering one here would close the others unseen. Answer them in chat (Copy answer for chat), or have them re-asked as cards so each closes on its own."));
      t.calls.forEach((c) => sec.append(callBox(t, c))); body.append(sec);
    }
    if (t.latest || t.answer) {
      const sec = el("div", "sec"); sec.append(el("h4", "", "Where it stands")); const ul = el("ul", "stl");
      if (t.latest) { const li = el("li"); li.append(el("span", "st " + t.latest.state, t.latest.state), " ", t.latest.text, el("div", "when", t.latest.when || "no time on the line")); if (t.legacy) li.append(el("div", "hint", "This worker line predates the drafts rule. \"Ready in branch\" only says where the draft sits; nothing needs landing.")); ul.append(li); }
      if (t.answer) { const li = el("li"); li.append(el("span", "st done", "your earlier answer"), " ", t.answer); ul.append(li); }
      sec.append(ul); body.append(sec);
    }
    body.append(threadSection(t));
    if (t.note) { const sec = el("div", "sec"); sec.append(el("h4", "", "Note on the task"), el("p", "", t.note)); body.append(sec); }
    const kv = el("dl", "kv"); const add = (k, v) => { kv.append(el("dt", "", k)); const dd = el("dd"); if (v instanceof Node) dd.append(v); else dd.textContent = v; kv.append(dd); };
    add("Session", S.board.session.label + " · project " + t.repo + " · " + (t.kind === "captain" ? "call" : t.kind));
    add("On the board since", fmt(t.since) + " (" + ago(t.since) + ")");
    if (t.until) add("Back on", fmt(t.until));
    if (t.report) add("Report", t.report);
    if (t.branch) add("Branch", t.branch + (t.head_sha ? " @ " + t.head_sha : "") + (t.legacy ? " · legacy draft branch: nothing to land" : t.ready ? " · ready, not merged" : "") + (t.branch_state === "merged" ? " · already in main" : t.branch_state === "ahead" ? " · " + t.branch_ahead + " commit" + (t.branch_ahead === 1 ? "" : "s") + " not in main" : ""));
    if (t.summary) add("Report says", t.summary);
    if (t.pr) add("PR", t.pr);
    if (t.blocked_by.length) { const w = el("span"); const refs = byRef(); t.blocked_by.forEach((r, i) => { if (i) w.append(", "); if (refs[r]) { const b = el("button", "linkbtn", r); b.type = "button"; b.onclick = () => jumpTo(r); w.append(b); } else w.append(r); }); add("Blocked by", w); }
    const sec = el("div", "sec"); sec.append(el("h4", "", "Details"), kv); body.append(sec);
    sh.append(body); L.append(sh); composer.attach(sh);
    document.querySelectorAll(".card.current").forEach((n) => n.classList.remove("current"));
    const cur = document.querySelector('.col [data-ref="' + CSS.escape(t.ref) + '"]'); if (cur) cur.classList.add("current");
    if (S.open.scrollTo) { const n = body.querySelector('[data-call="' + S.open.scrollTo + '"]'); if (n) { n.scrollIntoView({ block: "start" }); n.classList.add("flash"); } S.open.scrollTo = null; }
    if (S.open.keepScroll != null) { body.scrollTop = S.open.keepScroll; S.open.keepScroll = null; }
  }
  /* Back and Next walk the cards of this card's column as the board shows them now (its filters, its groups, its sort); arrow keys do the same. */
  function neighbours(t) {
    const list = (S.order && S.order[t.col]) || [], i = list.indexOf(t.ref);
    return i < 0 ? null : { i, n: list.length, prev: i > 0 ? list[i - 1] : null, next: i < list.length - 1 ? list[i + 1] : null };
  }
  function navRow(t) {
    const nb = neighbours(t), row = el("div", "sh-nav");
    const cn = S.board.columns.find((c) => c.id === t.col), colName = cn ? cn.name : t.col;
    if (!nb) { row.append(el("span", "pos", "Not in " + colName + " with the filters now on")); return row; }
    const mk = (text, ref, label, key) => { const b = el("button", "navbtn", text); b.type = "button"; b.disabled = !ref; b.setAttribute("aria-label", label); b.title = label + " (" + key + ")"; b.dataset.nav = key; b.onclick = () => stepSheet(ref); return b; };
    row.append(mk("\u2039 Back", nb.prev, "Previous card in " + colName, "\u2190"), el("span", "pos", (nb.i + 1) + " of " + nb.n + " in " + colName), mk("Next \u203a", nb.next, "Next card in " + colName, "\u2192"));
    return row;
  }
  function stepSheet(ref) {
    if (!ref || !byRef()[ref]) return;
    S.open = { ref, scrollTo: null }; S.confirm = null; renderSheet();
    const body = document.querySelector(".sh-body"); if (body) body.scrollTop = 0;
    const node = document.querySelector('.col [data-ref="' + CSS.escape(ref) + '"]'); if (node) node.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function openSheet(ref, callId) { S.open = { ref, scrollTo: callId || null }; render(); }
  function closeSheet() { S.open = null; S.confirm = null; composer.detach(); $("layer").textContent = ""; }

  /* ---- references: #s=<session>&t=<ref>[/<call>], and the find box ---- */
  function parseRef(s) {
    s = (s || "").trim().replace(/^.*[#&]t=/, "").replace(/^`|`$/g, ""); const m = s.match(/^([^#/\s]+)(?:[#/]([^\s]+))?$/); if (!m) return null;
    return byRef()[m[1]] ? { ref: m[1], call: m[2] || null } : null;
  }
  function jumpTo(ref, callId) {
    const t = byRef()[ref]; if (!t) { toast("No task in " + (S.board ? S.board.session.label : "this session") + " has the reference " + ref); return; }
    let notice = null;
    if (!visible(t)) { S.project = "all"; S.q = ""; $("find").value = ""; notice = "Filters cleared to show it."; }
    S.col = t.col; S.open = null; composer.detach(); $("layer").textContent = ""; render();
    const node = document.querySelector('.col [data-ref="' + CSS.escape(ref) + '"]');
    if (node) { const g = node.closest("details"); if (g) g.open = true; node.scrollIntoView({ block: "center" }); node.classList.add("flash"); }
    openSheet(ref, callId);
    if (notice) toast(notice);
  }
  $("find").addEventListener("input", (e) => { S.q = e.target.value.trim(); const r = parseRef(S.q); if (r && (S.q === r.ref || S.q.includes("#") || S.q.includes("/"))) { S.q = ""; jumpTo(r.ref, r.call); return; } render(); });
  $("find").addEventListener("keydown", (e) => { if (e.key === "Enter") { const r = parseRef($("find").value); if (r) { S.q = ""; jumpTo(r.ref, r.call); } } });
  $("bar-toggle").onclick = () => { S.barOpen = $("bar").classList.contains("collapsed"); renderBar(); };
  document.addEventListener("keydown", (e) => {
    if (!S.open) return;
    if (e.key === "Escape") { if (e.target && e.target.tagName === "TEXTAREA") return; closeSheet(); return; }
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const a = document.activeElement, typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
    if (typing) return;  // arrows move the caret in a text box, never the card
    const t = byRef()[S.open.ref], nb = t && neighbours(t); if (!nb) return;
    const ref = e.key === "ArrowLeft" ? nb.prev : nb.next; if (!ref) return;
    e.preventDefault(); stepSheet(ref);
  });
  let wasPhone = phone();
  $("cols").addEventListener("scroll", updateOverflow, { passive: true });
  window.addEventListener("resize", () => { renderBar(); if (wasPhone !== phone()) { wasPhone = phone(); render(); } else updateOverflow(); });
  function fromHash() {
    const p = new URLSearchParams(location.hash.slice(1)); const s = p.get("s"), t = p.get("t");
    if (s && s !== S.session && S.sessions.some((x) => x.id === s)) { chooseSession(s); }
    if (t) { const m = t.match(/^([^/]+)(?:\/(.+))?$/); const go = () => jumpTo(m[1], m[2]); if (S.board) go(); else S.pendingJump = go; }
  }
  window.addEventListener("hashchange", fromHash);

  async function start() {
    render();
    await loadSessions();
    const wanted = new URLSearchParams(location.hash.slice(1)).get("s");
    const first = S.sessions.find((s) => s.id === wanted && s.enabled !== false) || S.sessions.find((s) => s.enabled !== false);
    if (!first) { S.error = S.error || "No sessions are set up for the board."; render(); return; }
    S.session = first.id; render();
    await loadBoard(false);
    if (S.pendingJump) { const go = S.pendingJump; S.pendingJump = null; go(); } else fromHash();
    setInterval(() => { if (!document.hidden && Date.now() - S.loadedAt > 45000) loadBoard(false); }, 15000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - S.loadedAt > 20000) loadBoard(false); });
  }
  window.__board = { S, render, jumpTo };
  start();
})();
