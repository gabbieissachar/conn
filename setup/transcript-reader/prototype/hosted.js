  // ---------------------------------------------------------------- hosted copy (hosted.js, the shell only)
  // build_prototype.fill_template pastes this file (after seal.js) into the hosted shell's script.
  // The shell holds no transcript: it loads index.json from its own folder, then one conversation
  // (s/), document (d/) or week of fleet records (f/) when the view needs it, and loads one again
  // only once its stamp in a newer index.json has changed (sync.py writes them; see its help).
  // A folder with k/params.json is a sealed bucket (sync.py --dry-run): every object is <name>.enc,
  // opened with the passphrase's key (seal.js), which this device may remember.
  //
  // A sealed copy also stays on the device (the phone, over the tailnet's HTTPS address) so it opens with the laptop
  // shut. Three pieces, all behind this one object and none of them used by a plain copy:
  //   - on-device storage (IndexedDB "hosted-reader"): the sealed bytes of the index and of every object read or
  //     downloaded, with the stamp each had in the index, so a later load asks the laptop only for what changed and
  //     reads the rest from the device. Only ciphertext is stored: the passphrase is never kept, and the key that
  //     opens it is the one "Remember on this device" already keeps. "Forget this device" clears it all.
  //   - a service worker (sw.js beside the shell): opens the shell pages while the laptop is not reachable, and
  //     serves an HTML file's view (below). The page keeps its own copy of the shell pages up to date in a cache.
  //   - sends held on the device while the laptop is not reachable (the outbox store), which go to the laptop's
  //     queue (queue route, then drain.js and its receipts, as any Send) the next time it answers.
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
    // New page code (a stamp in the index that this page's own differs from): load the page again once per
    // stamp. When the reloaded page still differs, the host serves older page code (the Replit app's shell
    // pages are deployed by hand), so say so and keep going rather than reloading every minute.
    let outdated = "";
    function pageChanged(stamp) {
      let before = null;
      let kept = true;
      try { before = sessionStorage.getItem("hosted-reload-for"); sessionStorage.setItem("hosted-reload-for", String(stamp)); } catch (e) { kept = false; }
      if (before === String(stamp)) outdated = "The app's page is older than the laptop's: deploy the new shell pages (the app's README).";
      else if (kept) location.reload();
      else reload();
    }
    function checked(r, path) {
      if (r.status === 403 && headers["x-transcript-reader-token"]) {
        throw new Error(reload() ? "Reconnecting to the restarted server…" : "The server restarted: reload the page to reconnect.");
      }
      if (!r.ok) throw new Error(r.status === 404 ? `${path} is not built yet.` : `Loading ${path} failed (${r.status}).`);
      return r;
    }
    const nowSeconds = () => Date.now() / 1000;
    // The laptop answers within this long or counts as not reachable (a shut Mac gives no answer at all, and a
    // browser would wait a minute or more to say so). Only the wait for the answer to start is timed, never the download.
    const NETWORK_MS = 8000;
    const RETRY_DOWN_MS = 30000;
    const EXPIRY = 12 * 3600;  // drain.js refuses a request whose own time is older; a held send older than this is not sent
    const net = { down: 0 };
    function unreachable() {
      const error = new Error("The laptop is not reachable.");
      error.network = true;
      return error;
    }
    // One request to the laptop: a failure to get any answer is { network: true }, and while the laptop is known to be down
    // the next requests (apart from a probe) do not wait for another timeout.
    async function request(url, init = {}, { probe = false } = {}) {
      if (net.down && !probe && Date.now() - net.down < RETRY_DOWN_MS) throw unreachable();
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), NETWORK_MS) : null;
      try {
        const r = await fetch(url, { cache: "no-store", ...init, ...(controller ? { signal: controller.signal } : {}) });
        net.down = 0;
        return r;
      } catch (e) {
        net.down = Date.now();
        throw unreachable();
      } finally { if (timer) clearTimeout(timer); }
    }
    const fetched = async (path, options) => checked(await request(path, { headers }, options), path);
    // The bucket's params and key once it is opened; both stay null for a plain copy.
    const sealed = { params: null, key: null };
    // ---------------------------------------------------------------- on-device storage (sealed copies only)
    const DB = "hosted-reader", DB_VERSION = 2, STORES = ["keys", "objects", "stamps", "meta", "outbox"];
    let opening = null;
    function database() {
      if (!opening) {
        opening = new Promise((resolve, reject) => {
          try {
            const open = indexedDB.open(DB, DB_VERSION);
            open.onupgradeneeded = () => { for (const name of STORES) if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name); };
            open.onerror = () => reject(open.error || new Error("This browser would not open its storage."));
            open.onsuccess = () => resolve(open.result);
          } catch (e) { reject(e); }
        }).catch(e => { opening = null; throw e; });
      }
      return opening;
    }
    // Every call is one transaction, resolved when it has completed (so a value is stored once its promise resolves).
    async function transact(stores, mode, run) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result;
        t.oncomplete = () => resolve(result);
        t.onerror = t.onabort = () => reject(t.error || new Error("This browser's storage failed."));
        const asked = run(...stores.map(name => t.objectStore(name)));
        if (asked && "onsuccess" in asked) asked.onsuccess = () => { result = asked.result; };
        else result = asked;
      });
    }
    const dbGet = (store, key) => transact([store], "readonly", s => s.get(key)).then(value => value === undefined ? null : value);
    const dbPut = (store, key, value) => transact([store], "readwrite", s => { s.put(value, key); });
    const dbDel = (store, key) => transact([store], "readwrite", s => { s.delete(key); });
    const dbClear = store => transact([store], "readwrite", s => { s.clear(); });
    // [{ key, value }] for every record of a store, in key order.
    function dbAll(store) {
      return database().then(db => new Promise((resolve, reject) => {
        const out = [];
        const cursor = db.transaction([store], "readonly").objectStore(store).openCursor();
        cursor.onerror = () => reject(cursor.error || new Error("This browser's storage failed."));
        cursor.onsuccess = () => { const c = cursor.result; if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } else resolve(out); };
      }));
    }
    const dbPutObject = (path, stamp, bytes) => transact(["objects", "stamps"], "readwrite", (objects, stamps) => { objects.put(bytes, path); stamps.put({ stamp, size: bytes.byteLength, at: nowSeconds() }, path); });
    const dbDropObject = path => transact(["objects", "stamps"], "readwrite", (objects, stamps) => { objects.delete(path); stamps.delete(path); });
    const safe = promise => promise.catch(() => null);
    // Where this copy's data came from the last time the index was read: "device" when the laptop was not reachable.
    const local = { fromDevice: false, why: "", indexAt: 0 };

    // Reading what the laptop gave, or else what this device kept of it. A sealed object is asked for only when the device holds
    // no copy with the stamp the index names now (so only what changed comes down); with the laptop not reachable, the copy it
    // holds is read even if older, and one it does not hold is said so.
    async function get(path, stamp) {
      if (!sealed.params) return (await fetched(path)).json();
      const kept = stamp === undefined ? null : await safe(dbGet("objects", path));
      const known = kept && await safe(dbGet("stamps", path));
      if (kept && known && known.stamp === stamp) {
        try { return await seal.openJson(sealed.key, path, kept); } catch (e) { /* it does not open (another key, a damaged copy): ask again */ }
      }
      let bytes;
      try {
        bytes = await (await fetched(path + ".enc")).arrayBuffer();
      } catch (e) {
        if (kept) return seal.openJson(sealed.key, path, kept);  // an older copy is better than none
        if (e.network) throw new Error("This is not stored on this device yet, and the laptop is not reachable. Open it once with the laptop awake, or use Download everything now.");
        throw e;
      }
      const value = await seal.openJson(sealed.key, path, bytes);
      if (stamp !== undefined) await safe(dbPutObject(path, stamp, bytes));  // remembered once it opens; a full storage only means it is asked for again
      return value;
    }
    // The key remembered on this device (plan decision 4), under its bucket's salt, until "Forget
    // this device". A browser without IndexedDB (or a private window) keeps it for this page only.
    // "plain" for a plain copy; "open" for a sealed one this device has the key of; else "locked". With the laptop not
    // reachable, the params this device kept stand in for k/params.json, so a stored copy opens.
    async function prepare() {
      registerWorker();
      let r = null;
      try { r = await request("k/params.json", { headers }, { probe: true }); } catch (e) { r = null; }
      if (r && r.status === 404) return "plain";
      if (r) {
        sealed.params = await checked(r, "k/params.json").json();
        const before = await safe(dbGet("meta", "params"));
        // Another salt is another passphrase's copy: what this device stored was sealed under the old key and is of no use.
        if (before && before.salt !== sealed.params.salt) await safe(Promise.all([dbClear("objects"), dbClear("stamps"), dbDel("meta", "index"), dbDel("meta", "shell")]));
        await safe(dbPut("meta", "params", sealed.params));
      } else {
        sealed.params = await safe(dbGet("meta", "params"));
        if (!sealed.params) throw new Error("The laptop is not reachable, and this device has no copy of it stored yet.");
      }
      const kept = await safe(dbGet("keys", sealed.params.salt));
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
      if (remember) await safe(dbPut("keys", sealed.params.salt, key));
      return true;
    }
    // "Forget this device": the key, every stored object, the shell pages the worker holds and the worker itself go.
    async function forget() {
      await safe(Promise.all(STORES.map(dbClear)));
      if (typeof caches !== "undefined") await safe(caches.keys().then(names => Promise.all(names.filter(n => n.startsWith("reader-")).map(n => caches.delete(n)))));
      if (hasWorker()) await safe(navigator.serviceWorker.getRegistrations().then(all => Promise.all(all.map(r => r.unregister()))));
    }
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

    // The index: from the laptop when it answers (and kept on the device), else the one the device kept, which then says so
    // (fromDevice) and how old it is. A plain copy has no stored copy.
    async function index() {
      if (!sealed.params) return get("index.json");
      try {
        const bytes = await (await fetched("index.json.enc", { probe: true })).arrayBuffer();
        const value = await seal.openJson(sealed.key, "index.json", bytes);
        local.fromDevice = false; local.why = "";
        await safe(dbPut("meta", "index", { bytes, at: nowSeconds() }));
        return value;
      } catch (e) {
        const kept = await safe(dbGet("meta", "index"));
        if (!kept) throw e;
        local.fromDevice = true; local.why = e.message; local.indexAt = kept.at;
        return seal.openJson(sealed.key, "index.json", kept.bytes);
      }
    }
    // One object by its index entry ({ object, stamp }), fetched once per stamp; a failed load is tried again next time.
    const kept = new Map();
    function object(entry) {
      const key = entry.object + "@" + entry.stamp;
      if (!kept.has(key)) kept.set(key, get(entry.object, entry.stamp).catch(e => { kept.delete(key); throw e; }));
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
    // ------------------------------------------------------------ on the device: the shell, the worker, "Download everything now"
    const SHELL_CACHE = "reader-shell-v1";
    const SHELL_FILES = ["index.html", "sheet.html", "manifest.webmanifest", "icon-180.png", "icon-512.png"];
    const hasWorker = () => typeof navigator !== "undefined" && Boolean(navigator.serviceWorker) && typeof isSecureContext !== "undefined" && isSecureContext !== false;
    // The worker file sits beside the shell, so its scope is this folder: the shell pages, and the views below.
    let registered = null;
    function registerWorker() {
      if (!registered && hasWorker()) registered = navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).catch(() => null);
      return registered || Promise.resolve(null);
    }
    // Whether the copy can be kept for offline: a sealed copy, in a browser with storage and a worker, on a secure address.
    const offlineCapable = () => Boolean(sealed.params) && hasWorker() && typeof indexedDB !== "undefined";
    // The entries of an index that are objects to fetch: conversations, documents (HTML files too), fleet weeks, answer sheets.
    const entriesOf = idx => [...(idx.conversations || []), ...Object.values(idx.documents || {}), ...Object.values(idx.weeks || {}), ...Object.values(idx.sheets || {})].filter(entry => entry && entry.object && entry.stamp);
    const stampsOf = async () => new Map(((await safe(dbAll("stamps"))) || []).map(({ key, value }) => [key, value]));
    // What this device holds of the copy the index names: { total, have, bytes, all, held }, total and have in objects.
    async function stored(idx) {
      const entries = entriesOf(idx), stamps = await stampsOf();
      let have = 0, bytes = 0;
      for (const entry of entries) {
        const known = stamps.get(entry.object);
        if (known) { bytes += known.size; if (known.stamp === entry.stamp) have += 1; }
      }
      const index = await safe(dbGet("meta", "index"));
      return { total: entries.length, have, bytes: bytes + (index ? index.bytes.byteLength : 0), all: Boolean(await safe(dbGet("meta", "all"))), held: (await heldIds()).size };
    }
    // The shell pages, the web app manifest and its icons, kept in a cache for the worker to open with the laptop away, once per
    // page code (the index names its stamps). The pages are asked for with the token, which only this page holds.
    async function storeShell(idx) {
      if (typeof caches === "undefined" || typeof location === "undefined" || !location.href) return false;
      const stamp = `${idx.template || ""}|${idx.sheet_template || ""}`;
      if (await safe(dbGet("meta", "shell")) === stamp) return true;
      const cache = await caches.open(SHELL_CACHE);
      for (const name of SHELL_FILES) {
        const url = new URL(name, location.href).href;
        const r = await request(url, { headers: name.endsWith(".html") ? { ...headers, Accept: "text/html" } : {} }, { probe: true });
        if (!r.ok) throw new Error(`${name} could not be stored (${r.status}).`);
        await cache.put(url, r);
      }
      await safe(dbPut("meta", "shell", stamp));
      return true;
    }
    // One object's sealed bytes from the laptop, kept once they open. Resolves with its size.
    async function pull(entry) {
      const bytes = await (await fetched(entry.object + ".enc", { probe: true })).arrayBuffer();
      await seal.open(sealed.key, entry.object, bytes);
      await dbPutObject(entry.object, entry.stamp, bytes);
      return bytes.byteLength;
    }
    // Keeps what this device holds equal to the copy the index names: only objects whose stamp differs from the stored one are
    // asked for (four at a time), whatever is stored and no longer named goes, and the shell pages are stored. onProgress gets
    // { done, total, bytes } as it goes. Resolves with { fetched, kept, failed: [{ object, message }], bytes, stopped }, where
    // stopped is set when the laptop stopped answering part way (what came down stays; run it again when it is back).
    async function download(idx, onProgress = () => {}) {
      if (!offlineCapable() || !sealed.key) throw new Error("This browser cannot keep the copy for offline use.");
      await dbPut("meta", "all", true);
      if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.persist) safe(navigator.storage.persist());
      const entries = entriesOf(idx), stamps = await stampsOf();
      const todo = entries.filter(entry => !stamps.has(entry.object) || stamps.get(entry.object).stamp !== entry.stamp);
      const result = { fetched: 0, kept: entries.length - todo.length, failed: [], bytes: 0, stopped: false };
      let done = 0;
      onProgress({ done, total: todo.length, bytes: 0 });
      const queue = todo.slice();
      const run = async () => {
        while (queue.length) {
          const entry = queue.shift();
          try { result.bytes += await pull(entry); result.fetched += 1; } catch (e) {
            result.failed.push({ object: entry.object, message: e.message });
            if (e.network) { result.stopped = true; queue.length = 0; }
          }
          done += 1;
          onProgress({ done, total: todo.length, bytes: result.bytes });
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, todo.length) }, run));
      const named = new Set(entries.map(entry => entry.object));
      for (const path of stamps.keys()) if (!named.has(path)) await safe(dbDropObject(path));
      try { await storeShell(idx); } catch (e) { if (!result.stopped) result.failed.push({ object: "the shell pages", message: e.message }); }
      return result;
    }
    // Every index read from the laptop keeps the shell pages stored for the worker; and after "Download everything now" has been
    // used once, it also brings down just what changed, quietly.
    async function keepFresh(idx) {
      if (!offlineCapable() || !sealed.key) return null;
      if (!(await safe(dbGet("meta", "all")))) { await safe(storeShell(idx)); return null; }
      return download(idx);
    }
    // ----------------------------------------------------- an HTML file's view (the sandboxed viewer, with the laptop away)
    // The local reader shows an HTML file from its own server in a frame with its own Content-Security-Policy (api.js). Offline there
    // is no server, so the page hands the file's text (already folded into one document by sync.py) to the worker, which answers
    // the frame's navigation with it and the same policy: "sandbox allow-scripts" makes the document its own opaque origin, with no
    // network, frames or forms. The frame carries no sandbox attribute of its own because a sandboxed frame is not controlled by the
    // worker; the policy header is what sandboxes it, and with no worker answering, the server has no such address and the frame is empty.
    const views = new Map();
    const MAX_VIEWS = 8;
    if (hasWorker()) {
      navigator.serviceWorker.addEventListener("message", event => {
        const m = event.data;
        if (m && m.kind === "view" && typeof m.key === "string" && event.ports && event.ports[0]) event.ports[0].postMessage({ html: views.has(m.key) ? views.get(m.key) : null });
      });
    }
    // { url, name, size, mtime } for an HTML document whose text is loaded, as the server's html-open answers.
    async function htmlOpen(doc) {
      if (!hasWorker()) throw new Error("This browser cannot show the file here: a service worker needs a secure address (https, or localhost).");
      if (doc.text == null) throw new Error("The file is not loaded yet.");
      await registerWorker();
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => { navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }); setTimeout(resolve, 3000); });
        if (!navigator.serviceWorker.controller) throw new Error("The viewer is not ready: reload this page once, then open the file again.");
      }
      const key = [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
      views.set(key, doc.text);
      while (views.size > MAX_VIEWS) views.delete(views.keys().next().value);
      return { url: new URL(`view/${key}/${encodeURIComponent(doc.name)}`, location.href).href, name: doc.name, size: doc.size || doc.text.length, mtime: doc.mtime };
    }

    // ------------------------------------------------------------ Send, through the queue (plan section 8)
    // The page cannot reach Herdr; it writes a request, {id, session_id, text, at}, for the laptop's sync to send
    // when it is awake. A plain copy writes it as it is; a sealed one gzips and seals it here, under the key this
    // page holds and with its own path as the additional data, so the server that stores it cannot read it.
    // Either way the server it posts to is the reader's own (api.js queue); a static host has no such route yet.
    // A sealed send that cannot reach the laptop is held on the device (the outbox) and posted, under the same id, once the
    // laptop answers; the laptop's own rules then apply as to any send (12 hours, never twice, a receipt).
    const API = "/api/transcript-reader/";
    const uuid = () => {
      if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
      const b = globalThis.crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
      const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
    async function post(route, body) {
      // A send always tries the laptop (it is the person's own action, or a held send's turn), whatever the last request found.
      const r = await request(API + route, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) }, { probe: true });
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      if (r.status === 403 && j && /token/i.test(j.message || "")) throw new Error(reload() ? "Reconnecting to the restarted server…" : "The server restarted: reload the page to reconnect.");
      if (r.status === 404 && !j) throw new Error("This host cannot take a message yet: open the copy from the laptop's own server.");
      if (!r.ok) { const error = new Error((j && j.message) || `The server answered ${r.status}.`); error.status = r.status; error.code = j && j.code; throw error; }
      return j;
    }
    // Queue one message for a conversation (its newest session id); resolves { id, at } once it is stored, with held: true when
    // it is only on this device so far (the laptop was not reachable).
    async function enqueue(sessionId, text) {
      const id = uuid(), at = Date.now() / 1000;
      if (sealed.params) {
        if (!sealed.key) throw new Error("Open the copy with its passphrase first.");
        const path = `q/${id}.json`;
        const bytes = await seal.close(sealed.key, path, await seal.gzip(new TextEncoder().encode(JSON.stringify({ id, session_id: sessionId, text, at }))));
        const body = { copy: "bucket", id, data: seal.toBase64(bytes) };
        try { await post("queue", body); } catch (e) {
          if (!e.network) throw e;
          try { await dbPut("outbox", id, { id, at, session_id: sessionId, body }); } catch (storage) { throw new Error("The laptop is not reachable, and this device could not keep the message either. Copy it and send it later."); }
          return { id, at, held: true };
        }
      } else {
        try { await post("queue", { copy: "hosted", id, object: { session_id: sessionId, text, at } }); } catch (e) { throw e.network ? new Error("The server is not reachable, so nothing was queued.") : e; }
      }
      return { id, at };
    }
    // The ids of the sends held on this device, not yet at the laptop.
    const heldIds = async () => new Set((await safe(dbAll("outbox")) || []).map(item => item.key));
    // Posts what is held, oldest first, while the laptop answers: [{ id, state: "queued" | "refused" | "expired", reason }] for
    // each one settled. A send already queued (409) counts as queued, so none goes twice; one the laptop refuses outright is
    // dropped with its reason; one older than the laptop would accept (12 hours) is dropped and said so; the laptop being
    // unreachable, signed out or full stops the run and leaves the rest held.
    let flushing = null;
    function flush() {
      if (!sealed.params || !sealed.key) return Promise.resolve([]);
      if (!flushing) flushing = (async () => {
        const settled = [];
        const items = ((await safe(dbAll("outbox"))) || []).map(item => item.value).sort((x, y) => x.at - y.at);
        for (const item of items) {
          if (nowSeconds() - item.at > EXPIRY) { await safe(dbDel("outbox", item.id)); settled.push({ id: item.id, state: "expired" }); continue; }
          try { await post("queue", item.body); } catch (e) {
            if (e.status === 409 && e.code === "exists") { /* it got there before: queued */ }
            else if (e.network || e.status === 401 || e.status === 403 || e.status === 429 || e.status >= 500 || !e.status) break;
            else { await safe(dbDel("outbox", item.id)); settled.push({ id: item.id, state: "refused", reason: e.message }); continue; }
          }
          await safe(dbDel("outbox", item.id));
          settled.push({ id: item.id, state: "queued" });
        }
        return settled;
      })().finally(() => { flushing = null; });
      return flushing;
    }
    // What the laptop did with a queued message: { state: "sending" | "sent" | "refused", reason, label, at, ... },
    // or null while no receipt is written yet.
    async function receipt(id) {
      const path = `r/${id}.json`;
      const r = await request(sealed.params ? path + ".enc" : path, { headers });
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
    // Where the list came from: the laptop, or this device's copy of it (with why, and when the device took it).
    const offline = () => ({ fromDevice: local.fromDevice, why: local.why, at: local.indexAt, capable: offlineCapable() });
    return { index, data, object, conversation, documentText, fleet, weeks, stale, closedPane, waiting, asks, poll, reload, pageChanged, outdated: () => outdated, prepare, unlock, forget, askPassphrase, enqueue, receipt,
      flush, heldIds, offline, stored, download, keepFresh, htmlOpen, registerWorker,
      isSealed: () => Boolean(sealed.params), HEARTBEAT, REFRESH_MS };
  })();
