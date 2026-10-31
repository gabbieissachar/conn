  // ---------------------------------------------------------------- documents list (docfiles.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script, after find.js.
  // How the Documents tab lists a conversation's files: folder groups, a find box and a type filter. Pure functions of the
  // entries (each { id, at, index }, in the order sessionDocuments gives: the longest unnamed first) and of data.documents, so
  // docfiles.test.js runs them without a page.
  const docfiles = (() => {
    const SINGLE = "·single";  // the key of the group that holds the files that are alone in their folder
    const kindOf = doc => (doc && doc.kind) || "md";
    const segments = dir => String(dir || "").replace(/^~(\/|$)/, "").split("/").filter(s => s && s !== ".");
    // A folder named for what it holds says little by itself (three conversations each have a "context"), so it keeps its parent.
    const GENERIC = /^(context|data|handoffs|docs|src|planning|assets|reviews|prds|prototypes|esim|notes|reports|baseline|firstmate)$/i;
    const generic = segs => segs.length > 1 && GENERIC.test(segs[segs.length - 1]);
    // A task's worktree is deep and says the same thing every time: ~/.treehouse/<home>/<n>/ shows as ~/…/.
    const shorten = dir => dir.replace(/^~\/\.treehouse\/[^/]+\/\d+\//, "~/…/");
    const clipLeft = (text, max) => text.length > max ? "…" + text.slice(text.length - max + 1) : text;
    const root = dir => String(dir || "").startsWith("~") ? "~" : "";
    // The folder's own name: what a group is called.
    function title(dir) {
      const segs = segments(dir);
      if (!segs.length) return root(dir) || "/";
      return generic(segs) ? segs[segs.length - 2] + "/" + segs[segs.length - 1] : segs[segs.length - 1];
    }
    // The folders above the one title names, clipped from the left to <max> characters: what tells two folders with one name apart.
    function above(dir, max = 40) {
      const segs = segments(dir);
      const up = segs.slice(0, Math.max(0, segs.length - (generic(segs) ? 2 : 1)));
      return clipLeft(shorten(root(dir) + "/" + up.join("/")), max);
    }
    // Where a file is, clipped from the left (the end of a path is the part that tells folders apart).
    const tail = (dir, max = 44) => clipLeft(shorten(String(dir || "")), max);

    // The entries' folders, as groups: a folder with two or more of the entries is a group named by the folder, newest group first;
    // a file alone in its folder joins one last group, "Single files", so a long run of folders with one file each is one fold.
    // Within a group the newest-named file is first.
    function groups(entries, docs) {
      const order = new Map(entries.map((e, i) => [e.id, i]));
      const recent = (a, b) => (b.at || 0) - (a.at || 0) || order.get(b.id) - order.get(a.id);
      const byDir = new Map();
      for (const e of entries) {
        const dir = docs[e.id].dir;
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push(e);
      }
      const many = [], alone = [];
      for (const [dir, files] of byDir) {
        if (files.length > 1) many.push({ key: dir, dir, single: false, files: files.sort(recent) });
        else alone.push(files[0]);
      }
      many.sort((a, b) => recent(a.files[0], b.files[0]));
      const out = many.map(g => ({ ...g, at: g.files[0].at }));
      if (alone.length) { alone.sort(recent); out.push({ key: SINGLE, dir: null, single: true, files: alone, at: alone[0].at }); }
      return out;
    }
    // Which groups start open: the newest folder's (on a screen with room for the list beside a file), and the one holding <current>
    // when a person has just opened a file from outside the list. On a phone the list starts folded, so the first screen is the whole set.
    function opened(list, current, wide) {
      const open = new Set();
      if (wide && list.length) open.add(list[0].key);
      if (current) { const home = list.find(g => g.files.some(f => f.id === current)); if (home) open.add(home.key); }
      return open;
    }
    const words = query => String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    // Whether a query or a type is narrowing the list (the page then shows matches as one list, not folders).
    const narrowing = (query, kind) => words(query).length > 0 || (kind || "all") !== "all";
    // How many of the entries each type holds, and all of them.
    function counts(entries, docs) {
      const n = { all: entries.length, md: 0, html: 0, image: 0 };
      for (const e of entries) n[kindOf(docs[e.id])] += 1;
      return n;
    }
    // The entries a query and a type leave, newest first: every word must be in the file's name or its folder, in any order.
    function find(entries, docs, query, kind = "all") {
      const ws = words(query);
      const order = new Map(entries.map((e, i) => [e.id, i]));
      return entries.filter(e => {
        const d = docs[e.id];
        if (kind !== "all" && kindOf(d) !== kind) return false;
        const text = (d.name + " " + d.dir).toLowerCase();
        return ws.every(w => text.includes(w));
      }).sort((a, b) => (b.at || 0) - (a.at || 0) || order.get(b.id) - order.get(a.id));
    }
    // Where the query's words are in <text>, as [start, end) ranges that do not overlap, in order: the page marks them.
    function marks(text, query) {
      const ws = words(query), low = text.toLowerCase(), hits = [];
      if (!ws.length || low.length !== text.length) return hits;  // a letter that lowers to two characters moves every offset after it: no marks
      for (const w of ws) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) hits.push([i, i + w.length]);
      hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      const out = [];
      for (const [s, e] of hits) {
        const last = out[out.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
      }
      return out;
    }
    return { SINGLE, kindOf, title, above, tail, groups, opened, words, narrowing, counts, find, marks };
  })();
