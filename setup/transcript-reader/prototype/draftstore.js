  // ---------------------------------------------------------------- unsent messages (draftstore.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script, after live.js.
  // The words in the message box that are not sent yet, with their Reply or Comment pointer and Edit position (a draft), and the comments
  // waiting to go together (a batch), kept one entry per conversation in the page's localStorage. localStorage, not sessionStorage:
  // Conn lets go of a Watch column's web view when Watch ends and makes a new one when it comes back, and the Reader column's with it,
  // and a new web view starts with an empty sessionStorage. localStorage is the app's own and outlives a web view, a reload and a restart.
  //   tr-draft:<conversation id>  { text, sid, target: { title, passage, pointer, bare }, editing, at }
  //   tr-batch:<conversation id>  { items: [ { sid, title, passage, typed, pointer, bare } ], at }
  // (the hosted copy's keys start tr-hosted-, as its read marks do, so a draft typed there is not shown in the other page).
  // One entry per conversation, not one map: two pages open on the same origin (a Reader column and a Watch column) then never write
  // over each other's other conversations. An entry is read from storage each time it is asked for, never from a copy held in the page,
  // so words another page sent or removed are not shown again. At most 50 entries are kept (the oldest go first), one that is not
  // written for 7 days is dropped, and words over 20,000 characters (or a batch over 60,000) stay in the page only. Where the browser refuses storage (private
  // mode, a full quota) the entry is held in the page until it closes, which is what the page did before.
  // No page needed: draftstore.test.js runs it in a bare sandbox with a stand-in for the storage.
  const makeDraftStore = ({ storage, now = () => Date.now(), hosted = false, days = 7, max = 50, maxText = 20000 } = {}) => {
    const DRAFT = hosted ? "tr-hosted-draft:" : "tr-draft:", BATCH = hosted ? "tr-hosted-batch:" : "tr-batch:";
    const lifetime = days * 864e5;
    const held = new Map();   // key -> entry the storage did not take (refused, or too long to keep): it lives in this page only
    const alive = entry => Boolean(entry) && typeof entry === "object" && Number.isFinite(entry.at) && now() - entry.at < lifetime;
    const shaped = (key, entry) => key.startsWith(DRAFT) ? typeof entry.text === "string" : Array.isArray(entry.items);
    const read = key => {
      let entry = null, fromStorage = false;
      try { const raw = storage.getItem(key); if (raw !== null && raw !== undefined) { entry = JSON.parse(raw); fromStorage = true; } } catch (e) { entry = null; }
      if (!fromStorage && held.has(key)) entry = held.get(key);
      return alive(entry) && shaped(key, entry) ? entry : null;
    };
    const mine = key => key.startsWith(DRAFT) || key.startsWith(BATCH);
    // What the storage keeps under this page's prefixes: every key, the entry it holds (null when unreadable) and when it was last written.
    const listed = () => {
      const found = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key || !mine(key)) continue;
          let entry = null; try { entry = JSON.parse(storage.getItem(key)); } catch (e) { entry = null; }
          found.push({ key, entry, at: entry && Number.isFinite(entry.at) ? entry.at : 0 });
        }
      } catch (e) { /* storage not readable: nothing to look through */ }
      return found;
    };
    const drop = key => { held.delete(key); try { storage.removeItem(key); } catch (e) { /* nothing kept */ } };
    // Drops what is too old or unreadable, then the oldest beyond the cap. Run once when the page starts, and when an entry is added.
    const prune = () => {
      let rest = listed().filter(item => { const ok = alive(item.entry) && shaped(item.key, item.entry); if (!ok) drop(item.key); return ok; });
      for (const [key, entry] of [...held]) if (!alive(entry)) held.delete(key);
      rest = rest.sort((a, b) => a.at - b.at);
      while (rest.length > max) drop(rest.shift().key);
    };
    const write = (key, entry) => {
      const fresh = !read(key);
      const value = { ...entry, at: now() };
      let text = "";
      try { text = JSON.stringify(value); } catch (e) { text = ""; }
      const small = Boolean(text) && (value.text === undefined ? text.length <= 3 * maxText : String(value.text).length <= maxText);
      if (small) {
        try { storage.setItem(key, text); held.delete(key); if (fresh) prune(); return; } catch (e) { /* refused: held in the page */ }
      } else { try { storage.removeItem(key); } catch (e) { /* nothing older to drop */ } }
      held.set(key, value);
    };
    return {
      draft: sid => read(DRAFT + sid),
      putDraft: (sid, draft) => write(DRAFT + sid, draft),
      dropDraft: sid => drop(DRAFT + sid),
      batch: sid => { const entry = read(BATCH + sid); return entry ? entry.items : []; },
      putBatch: (sid, items) => { if (items.length) write(BATCH + sid, { items }); else drop(BATCH + sid); },
      prune,
      // A draft or batch an older page left in the tab's sessionStorage (tr-drafts and tr-batches, one map each) moves here once, so a
      // reload for new code does not lose what was typed before it. An entry that is already here is the newer one and stays.
      migrate: from => {
        if (!from) return;
        const take = (name, each) => {
          let map = null; try { map = JSON.parse(from.getItem(name) || "null"); } catch (e) { map = null; }
          if (map && typeof map === "object") for (const sid of Object.keys(map)) each(sid, map[sid]);
          try { from.removeItem(name); } catch (e) { /* stays where it is */ }
        };
        take("tr-drafts", (sid, old) => {
          const draft = typeof old === "string" ? { text: old, sid } : old;
          if (draft && typeof draft.text === "string" && !read(DRAFT + sid)) write(DRAFT + sid, draft);
        });
        take("tr-batches", (sid, items) => { if (Array.isArray(items) && items.length && !read(BATCH + sid)) write(BATCH + sid, { items }); });
      },
    };
  };
