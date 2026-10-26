  // ---------------------------------------------------------------- pins (pins.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script, after live.js.
  // A pin names one message by its turn's id (the session log's own record id, which never changes)
  // and the part pinned: "<id>:in" is the message, "<id>:reply" the reply to it. It holds no text, only
  // { key, conv, at, pinned }: where it sits, when the message was written and when it was pinned.
  // The served local page keeps pins in one small owner-only file on the laptop, outside the repo, through
  // the reader's own server (pinstore.js), so they survive a rebuilt page, a new copy of the repo and a
  // restarted server. A page that cannot reach it (a file copy, the hosted copy, a server too old to have
  // the route) keeps them in this browser, and the local page moves them into the file once it can.
  const pins = (() => {
    const BROWSER = HOSTED ? "tr-hosted-pins" : "tr-pins";
    const MAX = 1000;
    let items = [];
    let rev = 0;
    let where = "browser";
    const listeners = new Set();
    const notify = () => listeners.forEach(fn => { try { fn(); } catch (e) { /* a listener's own trouble */ } });
    const sound = p => Boolean(p) && typeof p.key === "string" && typeof p.conv === "string" && Number.isFinite(p.at) && Number.isFinite(p.pinned);
    function browserItems() {
      try { const saved = JSON.parse(localStorage.getItem(BROWSER) || "[]"); return Array.isArray(saved) ? saved.filter(sound) : []; } catch (e) { return []; }
    }
    function saveBrowser(list) {
      try { localStorage.setItem(BROWSER, JSON.stringify(list)); return true; } catch (e) { return false; }
    }
    // The pins of this page's own store, once, before the first paint.
    async function load() {
      if (!canLive) { items = browserItems(); return; }
      try {
        const saved = await live.pinsList();
        items = saved.pins; rev = saved.rev; where = "file";
        // Pins kept in this browser while no server route existed move into the file (union), then leave the browser.
        const waiting = browserItems().filter(p => !items.some(q => q.key === p.key));
        if (waiting.length) {
          let latest = saved;
          for (const p of waiting) latest = await live.pinsChange({ op: "pin", key: p.key, conv: p.conv, at: p.at });
          items = latest.pins; rev = latest.rev;
        }
        if (browserItems().length) saveBrowser([]);
      } catch (e) {
        where = "browser"; items = browserItems();
      }
    }
    // Another tab or page changed the file (the poll reads its revision) or this browser's store: take the new list.
    async function refresh(stamp) {
      if (where !== "file" || stamp == null || stamp === rev) return;
      try { const saved = await live.pinsList(); items = saved.pins; rev = saved.rev; notify(); } catch (e) { /* the next poll tries again */ }
    }
    const has = key => items.some(p => p.key === key);
    // Pin or unpin a message. The list changes at once; a refused or failed save puts it back and says why.
    async function toggle(key, conv, at) {
      const was = items;
      const pinned = !has(key);
      if (pinned && items.length >= MAX) throw new Error(`There are ${MAX} pins already: unpin some first.`);
      items = pinned ? [...items, { key, conv, at, pinned: Date.now() / 1000 }] : items.filter(p => p.key !== key);
      notify();
      try {
        if (where === "file") {
          const saved = await live.pinsChange(pinned ? { op: "pin", key, conv, at } : { op: "unpin", key });
          items = saved.pins; rev = saved.rev;
        } else if (!saveBrowser(items)) throw new Error("This browser would not keep the pin.");
      } catch (e) { items = was; notify(); throw e; }
      notify();
    }
    window.addEventListener("storage", e => { if (where === "browser" && e.key === BROWSER) { items = browserItems(); notify(); } });
    return {
      load, refresh, has, toggle, onChange: fn => listeners.add(fn),
      all: () => items.slice(), count: () => items.length,
      where: () => where,
    };
  })();
