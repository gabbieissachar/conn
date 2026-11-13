  // ---------------------------------------------------------------- the reply queue (replyqueue.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script, after draftstore.js.
  // Replies set aside to go through later, one list for each conversation, kept in the page's localStorage for the same reason the unsent
  // message is (draftstore.js): Conn lets go of a Watch column's web view when Watch ends and makes a new one when it comes back, and the Reader
  // column's with it, and the app's own localStorage outlives a web view, a reload and a restart. It is not the pins' list. A pin is for good, holds
  // an owner's label and is listed across every conversation; a queued reply is temporary (it goes when it is Done, or after 14 days) and belongs to
  // the conversation it was queued in.
  //   tr-queue:<conversation id>  { items: [ { key, at, queued } ], at }
  // (the hosted copy's keys start tr-hosted-, as its drafts do). key is the reply's own key, the pin's key for the same reply (the turn's id, then
  // ":reply"), so it holds however the page is rebuilt. at is when the reply was written (seconds, as the page's turns have it), queued when it was
  // queued (milliseconds, as the clock gives it), at (outside the items) when the entry was last written. It holds no message text.
  // One entry per conversation, so two pages open on the same origin (a Reader column and a Watch column) never write over each other's other
  // conversations, and an entry is read from storage each time it is asked for, never from a copy held in the page. A conversation that goes on
  // under a new id after a /clear is read under every id it has had, and what is written goes to the newest (the earlier entries are then dropped).
  // Where the browser refuses storage (private mode, a full quota) the entry is held in the page until it closes.
  // No page needed: replyqueue.test.js runs it in a bare sandbox with a stand-in for the storage.
  const makeReplyQueue = ({ storage, now = () => Date.now(), hosted = false, days = 14, max = 200, conversations = 100 } = {}) => {
    const PREFIX = hosted ? "tr-hosted-queue:" : "tr-queue:";
    const lifetime = days * 864e5;
    const held = new Map();   // key -> entry the storage did not take: it lives in this page only
    const sound = item => Boolean(item) && typeof item === "object" && typeof item.key === "string" && item.key.length > 0 && item.key.length <= 200
      && Number.isFinite(item.at) && Number.isFinite(item.queued);
    const alive = item => now() - item.queued < lifetime;
    const readEntry = id => {
      const key = PREFIX + id;
      let entry = null, fromStorage = false;
      try { const raw = storage.getItem(key); if (raw !== null && raw !== undefined) { entry = JSON.parse(raw); fromStorage = true; } } catch (e) { entry = null; }
      if (!fromStorage && held.has(key)) entry = held.get(key);
      return entry && typeof entry === "object" && Array.isArray(entry.items) ? entry : null;
    };
    const itemsOf = id => { const entry = readEntry(id); return entry ? entry.items.filter(item => sound(item) && alive(item)) : []; };
    const writeEntry = (id, items) => {
      const key = PREFIX + id;
      if (!items.length) { held.delete(key); try { storage.removeItem(key); } catch (e) { /* nothing kept */ } return; }
      const value = { items, at: now() };
      try { storage.setItem(key, JSON.stringify(value)); held.delete(key); } catch (e) { held.set(key, value); }
    };
    // The conversation's queue, whatever ids it has had: oldest reply first (the reading order), then the one queued first, then by key so the order is always the same.
    const items = ids => {
      const seen = new Map();
      for (const id of ids) for (const item of itemsOf(id)) {
        const have = seen.get(item.key);
        if (!have || item.queued < have.queued) seen.set(item.key, { key: item.key, at: item.at, queued: item.queued });
      }
      return [...seen.values()].sort((a, b) => a.at - b.at || a.queued - b.queued || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    };
    const settle = (home, ids, list) => { for (const id of ids) if (id !== home) writeEntry(id, []); writeEntry(home, list); };
    return {
      prefix: PREFIX,
      items,
      has: (ids, key) => items(ids).some(item => item.key === key),
      count: ids => items(ids).length,
      // What changed since a page last looked: the keys, in order.
      signature: ids => items(ids).map(item => item.key).join("|"),
      // Queue a reply: { key, at } (and queued, when it goes back where it was). False when it is queued already.
      add(home, ids, item) {
        const list = items(ids);
        if (list.some(x => x.key === item.key)) return false;
        if (list.length >= max) throw new Error(`The queue holds ${max} replies already: mark some Done first.`);
        const next = { key: item.key, at: item.at, queued: Number.isFinite(item.queued) ? item.queued : now() };
        if (!sound(next)) throw new Error("That reply cannot be queued.");
        settle(home, ids, [...list, next]);
        return true;
      },
      // Take one off (Done): the item, so an Undo can put it back, or null when it was not there.
      remove(home, ids, key) {
        const list = items(ids), at = list.findIndex(item => item.key === key);
        if (at < 0) return null;
        const [gone] = list.splice(at, 1);
        settle(home, ids, list);
        return gone;
      },
      // Take every one off: the items, for an Undo.
      clear(home, ids) {
        const list = items(ids);
        settle(home, ids, []);
        return list;
      },
      // Put back what clear took off.
      restore(home, ids, back) {
        const list = items(ids), have = new Set(list.map(item => item.key));
        const added = back.filter(item => sound(item) && !have.has(item.key));
        if (added.length) settle(home, ids, [...list, ...added].slice(0, max));
        return added.length;
      },
      // Drops what is expired or unreadable, then the oldest entries beyond the cap. Run once when the page starts.
      prune() {
        const ids = [];
        try { for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key && key.startsWith(PREFIX)) ids.push(key.slice(PREFIX.length)); } } catch (e) { return; }
        const kept = [];
        for (const id of ids) {
          const entry = readEntry(id), live = entry ? entry.items.filter(item => sound(item) && alive(item)) : [];
          if (!live.length) writeEntry(id, []);
          else { if (live.length !== entry.items.length) writeEntry(id, live); kept.push({ id, at: Number.isFinite(entry.at) ? entry.at : 0 }); }
        }
        kept.sort((a, b) => a.at - b.at);
        while (kept.length > conversations) writeEntry(kept.shift().id, []);
      },
      // The queue as the conversation on screen can show it. exchanges: the conversation's turns, undefined while it is not loaded; hidden(ex): whether
      // the reply is hidden from this view. Each row is { item, ex, index, state }: "here" (the reply is on the page), "hidden" (it is, but hidden),
      // "gone" (no turn of the conversation has that id: it is older than the page keeps, or left with a compaction) or "unloaded" (the conversation is
      // not loaded yet, so nothing can be said). The ones that can be gone to come first, oldest first; the ones that cannot come last.
      rows(list, exchanges, hidden = () => false) {
        const place = new Map();
        if (Array.isArray(exchanges)) exchanges.forEach((ex, index) => { if (ex && ex.uid && ex.reply && !place.has(ex.uid + ":reply")) place.set(ex.uid + ":reply", { ex, index }); });
        const made = list.map(item => {
          if (!Array.isArray(exchanges)) return { item, state: "unloaded" };
          const found = place.get(item.key);
          if (!found) return { item, state: "gone" };
          return { item, ex: found.ex, index: found.index, state: hidden(found.ex) ? "hidden" : "here" };
        });
        return [...made.filter(row => row.state !== "gone"), ...made.filter(row => row.state === "gone")];
      },
      // The row Next goes to: the oldest reply that can be shown.
      next: rows => rows.find(row => row.state === "here" || row.state === "hidden") || null,
      // What a row says of its reply: its first two lines of words, without the marks of markdown, in at most `max` characters.
      snippet(text, max = 160) {
        const lines = String(text || "").split("\n").map(line => line.replace(/^[\s#>*\-\d.)|]+/, "").replace(/[*`_]/g, "").trim().replace(/\s+/g, " ")).filter(Boolean);
        const joined = lines.slice(0, 2).join(" · ");
        return !joined ? "(no text)" : joined.length > max ? joined.slice(0, max - 1).trimEnd() + "…" : joined;
      },
    };
  };
