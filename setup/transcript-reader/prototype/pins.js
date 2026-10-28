  // ---------------------------------------------------------------- pins and stars (pins.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script, after live.js.
  // A pin names one message by its turn's id (the session log's own record id, which never changes)
  // and the part pinned: "<id>:in" is the message, "<id>:reply" the reply to it. It holds no text, only
  // { key, conv, at, pinned }: where it sits, when the message was written and when it was pinned.
  // The served local page keeps pins in one small owner-only file on the laptop, outside the repo, through
  // the reader's own server (pinstore.js), so they survive a rebuilt page, a new copy of the repo and a
  // restarted server. A page that cannot reach it (a file copy, the hosted copy, a server too old to have
  // the route) keeps them in this browser, and the local page moves them into the file once it can.
  // The picker's stars are kept the same way by the same code (kept, below): one list per kind, in the server's
  // stars file or this browser, each { conv, starred }: which conversation, and when it was starred.
  // One kept list, as the page holds it: <ask> names the server's calls ({ list, change }), <id> the field that
  // names an item, <add> and <remove> its two operations, <noun> and <undo> the words of the cap's message, <make>
  // the item an add builds from its other fields, and <storage> where this browser keeps it.
  const kept = ({ storage, ask, id, add, remove, noun, undo, make, sound, max }) => {
    const BROWSER = HOSTED ? "tr-hosted-" + storage : "tr-" + storage;
    let items = [];
    let rev = 0;
    let where = "browser";
    const listeners = new Set();
    const notify = () => listeners.forEach(fn => { try { fn(); } catch (e) { /* a listener's own trouble */ } });
    const list = saved => saved[noun];
    function browserItems() {
      try { const saved = JSON.parse(localStorage.getItem(BROWSER) || "[]"); return Array.isArray(saved) ? saved.filter(sound) : []; } catch (e) { return []; }
    }
    function saveBrowser(all) {
      try { localStorage.setItem(BROWSER, JSON.stringify(all)); return true; } catch (e) { return false; }
    }
    // The items of this page's own store, once, before the first paint.
    async function load() {
      if (!canLive) { items = browserItems(); return; }
      try {
        const saved = await ask.list();
        items = list(saved); rev = saved.rev; where = "file";
        // Items kept in this browser while no server route existed move into the file (union), then leave the browser.
        const waiting = browserItems().filter(p => !items.some(q => q[id] === p[id]));
        if (waiting.length) {
          let latest = saved;
          for (const p of waiting) latest = await ask.change({ op: add, ...fields(p) });
          items = list(latest); rev = latest.rev;
        }
        if (browserItems().length) saveBrowser([]);
      } catch (e) {
        where = "browser"; items = browserItems();
      }
    }
    // What an add sends: the item without the time the server stamps.
    const fields = p => { const { pinned, starred, ...rest } = p; return rest; };
    // Another tab or page changed the file (the poll reads its revision) or this browser's store: take the new list.
    async function refresh(stamp) {
      if (where !== "file" || stamp == null || stamp === rev) return;
      try { const saved = await ask.list(); items = list(saved); rev = saved.rev; notify(); } catch (e) { /* the next poll tries again */ }
    }
    const has = key => items.some(p => p[id] === key);
    // Add or remove one item. The list changes at once; a refused or failed save puts it back and says why.
    async function toggle(key, more = {}) {
      const was = items;
      const added = !has(key);
      if (added && items.length >= max) throw new Error(`There are ${max} ${noun} already: ${undo} some first.`);
      items = added ? [...items, make(key, more)] : items.filter(p => p[id] !== key);
      notify();
      try {
        if (where === "file") {
          const saved = await ask.change(added ? { op: add, [id]: key, ...more } : { op: remove, [id]: key });
          items = list(saved); rev = saved.rev;
        } else if (!saveBrowser(items)) throw new Error(`This browser would not keep the ${add}.`);
      } catch (e) { items = was; notify(); throw e; }
      notify();
    }
    window.addEventListener("storage", e => { if (where === "browser" && e.key === BROWSER) { items = browserItems(); notify(); } });
    return {
      load, refresh, has, toggle, onChange: fn => listeners.add(fn),
      all: () => items.slice(), count: () => items.length,
      where: () => where,
    };
  };
  const pinStore = kept({
    storage: "pins", ask: { list: () => live.pinsList(), change: c => live.pinsChange(c) },
    id: "key", add: "pin", remove: "unpin", noun: "pins", undo: "unpin", max: 1000,
    make: (key, more) => ({ key, ...more, pinned: Date.now() / 1000 }),
    sound: p => Boolean(p) && typeof p.key === "string" && typeof p.conv === "string" && Number.isFinite(p.at) && Number.isFinite(p.pinned),
  });
  // Pin or unpin a message: its key, the conversation and the time it was written.
  const pins = { ...pinStore, toggle: (key, conv, at) => pinStore.toggle(key, { conv, at }) };
  const stars = kept({
    storage: "stars", ask: { list: () => live.starsList(), change: c => live.starsChange(c) },
    id: "conv", add: "star", remove: "unstar", noun: "stars", undo: "unstar", max: 200,
    make: conv => ({ conv, starred: Date.now() / 1000 }),
    sound: p => Boolean(p) && typeof p.conv === "string" && Number.isFinite(p.starred),
  });
