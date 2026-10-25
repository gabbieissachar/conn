  // ---------------------------------------------------------------- hosted copy (hosted.js, the shell only)
  // build_prototype.fill_template pastes this file (after seal.js) into the hosted shell's script.
  // The shell holds no transcript: it loads index.json from its own folder, then one conversation
  // (s/), document (d/) or week of fleet records (f/) when the view needs it, and loads one again
  // only once its stamp in a newer index.json has changed (sync.py writes them; see its help).
  // A folder with k/params.json is a sealed bucket (sync.py --dry-run): every object is <name>.enc,
  // opened with the passphrase's key (seal.js), which this device may remember.
  const hosted = (() => {
    // Served by the reader's own server (serve.sh), the objects answer only with the per-start token api.js writes
    // into the shell as it serves it. On a static host the tag stays unfilled and none is sent.
    const token = (document.querySelector('meta[name="reader-token"]') || {}).content || "";
    const headers = /^[0-9a-f]{64}$/.test(token) ? { "x-transcript-reader-token": token } : {};
    // The sync agent rebuilds at least this often while the laptop is awake (its heartbeat), so
    // an older build means the laptop is asleep or not syncing.
    const HEARTBEAT = 600;
    const REFRESH_MS = 30000;
    // Load the shell again for new page code or a restarted server's token, at most once a minute.
    function reload() {
      let last = 0;
      try { last = Number(sessionStorage.getItem("hosted-reload")) || 0; } catch (e) { last = 0; }
      if (Date.now() - last < 60000) return false;
      try { sessionStorage.setItem("hosted-reload", String(Date.now())); } catch (e) { /* reload anyway */ }
      location.reload();
      return true;
    }
    function checked(r, path) {
      if (r.status === 403 && headers["x-transcript-reader-token"]) {
        throw new Error(reload() ? "Reconnecting to the restarted server…" : "The server restarted: reload the page to reconnect.");
      }
      if (!r.ok) throw new Error(r.status === 404 ? `${path} is not built yet.` : `Loading ${path} failed (${r.status}).`);
      return r;
    }
    const fetched = async path => checked(await fetch(path, { cache: "no-store", headers }), path);
    // The bucket's params and key once it is opened; both stay null for a plain copy.
    const sealed = { params: null, key: null };
    async function get(path) {
      if (!sealed.params) return (await fetched(path)).json();
      return seal.openJson(sealed.key, path, await (await fetched(path + ".enc")).arrayBuffer());
    }
    // The key remembered on this device (plan decision 4), under its bucket's salt, until "Forget
    // this device". A browser without IndexedDB (or a private window) keeps it for this page only.
    function keys(mode, run) {
      return new Promise((resolve) => {
        try {
          const opening = indexedDB.open("hosted-reader", 1);
          opening.onupgradeneeded = () => opening.result.createObjectStore("keys");
          opening.onerror = () => resolve(null);
          opening.onsuccess = () => {
            const request = run(opening.result.transaction("keys", mode).objectStore("keys"));
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => resolve(null);
          };
        } catch (e) { resolve(null); }
      });
    }
    // "plain" for a plain copy; "open" for a sealed one this device has the key of; else "locked".
    async function prepare() {
      const r = await fetch("k/params.json", { cache: "no-store", headers });
      if (r.status === 404) return "plain";
      sealed.params = await checked(r, "k/params.json").json();
      const kept = await keys("readonly", store => store.get(sealed.params.salt));
      if (kept) {
        try { await seal.open(kept, "k/check", seal.fromBase64(sealed.params.check)); sealed.key = kept; return "open"; } catch (e) { /* not this bucket's key any more */ }
      }
      return "locked";
    }
    // Whether the passphrase opens the bucket; with remember, this device keeps the key (never the passphrase).
    async function unlock(passphrase, remember) {
      const key = await seal.unlock(passphrase, sealed.params);
      if (!key) return false;
      sealed.key = key;
      if (remember) await keys("readwrite", store => store.put(key, sealed.params.salt));
      return true;
    }
    const forget = () => keys("readwrite", store => store.clear());
    // The passphrase card, for the reader's shell and the answer sheet's alike (in #main; body.locked
    // lets each page hide what waits for it). Its look is added once, with the pages' own colours.
    const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
    function style() {
      if (document.getElementById("unlock-style")) return;
      const css = el("style"); css.id = "unlock-style";
      css.textContent = ".unlock { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-top: 18px; }  .unlock h2 { font-size: 17px; margin: 0 0 4px; }  .unlock p { font-size: 14px; color: var(--muted); margin: 0 0 12px; }  .unlock input[type=password] { width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--paper); color: var(--ink); font: 16px/1.4 var(--sans); }  .unlock input[type=password]:focus { outline: 2px solid var(--you); outline-offset: -1px; }  .unlock label { display: flex; gap: 8px; align-items: center; font-size: 14px; margin: 10px 0 12px; }  .unlock .row { display: flex; gap: 10px; align-items: center; }  .unlock .row button { background: var(--you); border: 1px solid var(--you); color: var(--paper); font-weight: 600; border-radius: 10px; padding: 7px 16px; font-size: 14px; }  .unlock .row button:disabled { opacity: .6; cursor: default; }  .unlock .why { font-size: 13px; color: var(--muted); }  .unlock .why.bad { color: var(--open); }";
      document.head.append(css);
    }
    // A sealed copy's passphrase: resolves once it opens the copy. The key, not the passphrase, may stay on this device.
      function askPassphrase() {
        style();
      document.body.classList.add("locked");
      const card = el("div", "unlock"), input = el("input"), remember = el("input"), open = el("button", null, "Open"), why = el("div", "why");
      input.type = "password"; input.autocomplete = "current-password"; input.setAttribute("aria-label", "Passphrase"); input.placeholder = "Passphrase";
      remember.type = "checkbox"; remember.checked = true;
      const label = el("label"); label.append(remember, document.createTextNode("Remember on this device"));
      const row = el("div", "row"); open.type = "button"; row.append(open, why);
      card.append(el("h2", null, "This copy is encrypted"), el("p", null, "Enter the passphrase the laptop's sync uses. It opens the copy here and is never sent anywhere."), input, label, row);
      document.getElementById("main").replaceChildren(card);
      input.focus();
      return new Promise(resolve => {
        const tryIt = async () => {
          if (!input.value || open.disabled) return;
          open.disabled = true; why.className = "why"; why.textContent = "Opening…";
          let ok = false;
          try { ok = await unlock(input.value, remember.checked); } catch (e) { ok = false; }
          open.disabled = false;
          if (!ok) { why.className = "why bad"; why.textContent = "That passphrase does not open this copy."; input.select(); return; }
          input.value = "";
          document.body.classList.remove("locked");
          document.getElementById("main").replaceChildren(el("div", "empty", "Loading…"));
          resolve();
        };
        open.addEventListener("click", tryIt);
        input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); tryIt(); } });
      });
    }

    const index = () => get("index.json");
    // One object by its index entry ({ object, stamp }), fetched once per stamp; a failed load is tried again next time.
    const kept = new Map();
    function object(entry) {
      const key = entry.object + "@" + entry.stamp;
      if (!kept.has(key)) kept.set(key, get(entry.object).catch(e => { kept.delete(key); throw e; }));
      return kept.get(key);
    }
    // The weeks of fleet records the timeline shows: those reaching into its window, and older
    // ones holding items never marked settled.
    const weeks = idx => Object.keys(idx.weeks || {}).sort().filter(key => idx.weeks[key].to >= idx.since || idx.weeks[key].open > 0);
    const weeksSig = idx => JSON.stringify(weeks(idx).map(key => [key, idx.weeks[key].stamp]));
    // The page's data from an index (the local page's payload, less what loads on demand): each
    // conversation keeps the turns already loaded while its stamp is the same, each document its
    // text, and the fleet records stay while no week the timeline shows has changed.
    function data(idx, previous) {
      const before = new Map(((previous && previous.sessions) || []).map(s => [s.object, s]));
      const sessions = (idx.conversations || []).map(entry => {
        const old = before.get(entry.object);
        return { ...entry, exchanges: old && old.stamp === entry.stamp ? old.exchanges : null };
      });
      const documents = {};
      for (const [id, meta] of Object.entries(idx.documents || {})) {
        const old = previous && previous.documents[id];
        documents[id] = { ...meta, text: old && old.stamp === meta.stamp ? old.text : null };
      }
      const sig = weeksSig(idx);
      return {
        generated: idx.as_of || 0, since: idx.since || 0, homes: idx.homes || [], summaries: idx.summaries || [],
        template: idx.template, sheetTemplate: idx.sheet_template, sheets: idx.sheets || {}, chosen: true, closed: [], sessions, documents, weeks: idx.weeks || {}, weeksSig: sig,
        fleet: previous && previous.weeksSig === sig ? previous.fleet : null,
      };
    }
    async function conversation(session) {
      if (!session.exchanges) session.exchanges = (await object(session)).exchanges || [];
      return session;
    }
    async function documentText(meta) {
      if (meta.text == null) meta.text = (await object(meta)).text || "";
      return meta;
    }
    // The timeline's records: its weeks in order, each already sorted by time.
    async function fleet(d) {
      if (d.fleet) return d.fleet;
      const parts = await Promise.all(weeks(d).map(key => object(d.weeks[key])));
      d.fleet = parts.flatMap(part => part.events || []);
      return d.fleet;
    }
    // ------------------------------------------------------------ Send, through the queue (plan section 8)
    // The page cannot reach Herdr; it writes a request, {id, session_id, text, at}, for the laptop's sync to send
    // when it is awake. A plain copy writes it as it is; a sealed one gzips and seals it here, under the key this
    // page holds and with its own path as the additional data, so the server that stores it cannot read it.
    // Either way the server it posts to is the reader's own (api.js queue); a static host has no such route yet.
    const API = "/api/transcript-reader/";
    const uuid = () => {
      if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
      const b = globalThis.crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
      const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
    async function post(route, body) {
      const r = await fetch(API + route, { method: "POST", cache: "no-store", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      if (r.status === 403 && j && /token/i.test(j.message || "")) throw new Error(reload() ? "Reconnecting to the restarted server…" : "The server restarted: reload the page to reconnect.");
      if (r.status === 404 && !j) throw new Error("This host cannot take a message yet: open the copy from the laptop's own server.");
      if (!r.ok) throw new Error((j && j.message) || `The server answered ${r.status}.`);
      return j;
    }
    // Queue one message for a conversation (its newest session id); resolves { id, at } once it is stored.
    async function enqueue(sessionId, text) {
      const id = uuid(), at = Date.now() / 1000;
      if (sealed.params) {
        if (!sealed.key) throw new Error("Open the copy with its passphrase first.");
        const path = `q/${id}.json`;
        const bytes = await seal.close(sealed.key, path, await seal.gzip(new TextEncoder().encode(JSON.stringify({ id, session_id: sessionId, text, at }))));
        await post("queue", { copy: "bucket", id, data: seal.toBase64(bytes) });
      } else await post("queue", { copy: "hosted", id, object: { session_id: sessionId, text, at } });
      return { id, at };
    }
    // What the laptop did with a queued message: { state: "sending" | "sent" | "refused", reason, label, at, ... },
    // or null while no receipt is written yet.
    async function receipt(id) {
      const path = `r/${id}.json`;
      const r = await fetch(sealed.params ? path + ".enc" : path, { cache: "no-store", headers });
      if (r.status === 404) return null;
      checked(r, path);
      return sealed.params ? seal.openJson(sealed.key, path, await r.arrayBuffer()) : r.json();
    }
    const stale = (asOf, now = Date.now() / 1000) => now - asOf > HEARTBEAT;
    // A pane Herdr ran the conversation in, closed by the build: its old asks wait on no one.
    const closedPane = s => Boolean(s.pane && !s.pane.live);
    // The replies that need you since your last message, while a live pane runs the conversation.
    // The list says "since your last message", apart from the page's own "need you" count of every ask.
    const waiting = s => s.pane && s.pane.live ? s.needs || 0 : 0;
    const asks = s => waiting(s) ? `${waiting(s)} since your last message` : "";
    // tick runs every 30 seconds while the page is visible, and at once when it is shown again.
    function poll(tick) {
      let busy = false;
      const run = async () => {
        if (busy || document.hidden) return;
        busy = true;
        try { await tick(); } catch (e) { /* the next tick tries again */ } finally { busy = false; }
      };
      setInterval(run, REFRESH_MS);
      document.addEventListener("visibilitychange", run);
    }
    return { index, data, object, conversation, documentText, fleet, weeks, stale, closedPane, waiting, asks, poll, reload, prepare, unlock, forget, askPassphrase, enqueue, receipt,
      isSealed: () => Boolean(sealed.params), HEARTBEAT, REFRESH_MS };
  })();
