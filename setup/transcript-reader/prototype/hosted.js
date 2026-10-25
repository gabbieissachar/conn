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
        template: idx.template, chosen: true, closed: [], sessions, documents, weeks: idx.weeks || {}, weeksSig: sig,
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
    return { index, data, conversation, documentText, fleet, weeks, stale, closedPane, waiting, asks, poll, reload, prepare, unlock, forget,
      isSealed: () => Boolean(sealed.params), HEARTBEAT, REFRESH_MS };
  })();
