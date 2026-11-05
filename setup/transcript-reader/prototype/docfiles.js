  // ---------------------------------------------------------------- documents list (docfiles.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script, after find.js.
  // How the Documents tab lists a conversation's files: folder groups (or, for a leader's conversation, task groups), a find box and a type filter. Pure functions of the
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
    // ------------------------------------------------------------ by task (a leader's conversation only)
    // A leader is a conversation run in a Firstmate home. Its tasks are the folders of the home's data/: a task's files are the files in
    // data/<task id>/ (any depth), and its title and state come from the home's backlog (session.leader = { dir: the home as a document's
    // folder is shown, tasks: { id: { title, state, more } } }). A file in no task folder is in the group "Other files".
    const OTHER = "·other";
    const isLeader = session => Boolean(session && session.leader && session.leader.dir);
    // The grouping a conversation's list uses, from the choice kept in the browser (null, or anything but "folder", means by task): by task
    // only for a leader's conversation, by folder for every other whatever was chosen.
    const pref = stored => stored === "folder" ? "folder" : "task";
    const mode = (session, stored) => isLeader(session) && pref(stored) === "task" ? "task" : "folder";
    // The task folder a document's folder is in (its id), or null: the first folder under the home's data/.
    function taskOf(dir, leader) {
      if (!leader || !leader.dir) return null;
      const root = leader.dir + "/data/", d = String(dir || "");
      return d.startsWith(root) ? d.slice(root.length).split("/")[0] || null : null;
    }
    // The folders below the task's own, where the file is ("" when it is directly in the task folder).
    function inside(dir, leader) {
      const id = taskOf(dir, leader);
      return id ? String(dir).slice(leader.dir.length + "/data/".length + id.length + 1) : "";
    }
    function task(id, leader) {
      const t = (leader.tasks && leader.tasks[id]) || {};
      return { id, title: t.title || id, state: t.state || "", known: Boolean(t.title), more: t.more || 0 };
    }
    // What a find matches besides the name and the folder: the task's id and title.
    function taskText(doc, leader) {
      const id = taskOf(doc.dir, leader);
      if (!id) return "";
      const t = task(id, leader);
      return t.id + " " + t.title;
    }
    // The line under a file's name in a list of matches: its task and the folder in it, or its folder when it is in none.
    function where(doc, leader, max = 30) {
      const id = taskOf(doc.dir, leader);
      if (!id) return tail(doc.dir, max);
      const t = task(id, leader), sub = inside(doc.dir, leader);
      return t.id + (t.title !== t.id ? " · " + t.title : "") + (sub ? " · " + sub : "");
    }
    // The entries' tasks, as groups: each task with a file in the entries is a group, the one with the newest file first, whatever its state (a
    // backlog keeps rows In flight that were parked weeks ago, and a task finished today is what a person looks for); the files in no task are
    // one last group. Within a group the newest file is first.
    function taskGroups(entries, docs, leader) {
      const order = new Map(entries.map((e, i) => [e.id, i]));
      const recent = (a, b) => (b.at || 0) - (a.at || 0) || order.get(b.id) - order.get(a.id);
      const byTask = new Map();
      for (const e of entries) {
        const key = taskOf(docs[e.id].dir, leader) || OTHER;
        if (!byTask.has(key)) byTask.set(key, []);
        byTask.get(key).push(e);
      }
      const out = [];
      for (const [key, files] of byTask) {
        files.sort(recent);
        const other = key === OTHER, info = other ? null : task(key, leader);
        out.push({ key, task: info, other, single: false, dir: null, files, at: files[0].at });
      }
      return out.sort((a, b) => (a.other ? 1 : 0) - (b.other ? 1 : 0) || (b.at || 0) - (a.at || 0) || (a.key < b.key ? -1 : 1));
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
    // <extra>, when given, is a function of a document that adds words to what is searched (the By task view adds the task's id and title).
    function find(entries, docs, query, kind = "all", extra = null) {
      const ws = words(query);
      const order = new Map(entries.map((e, i) => [e.id, i]));
      return entries.filter(e => {
        const d = docs[e.id];
        if (kind !== "all" && kindOf(d) !== kind) return false;
        const text = (d.name + " " + d.dir + (extra ? " " + extra(d) : "")).toLowerCase();
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
    // A document's contents list above it (a phone, a narrow window) is opened by a tap and closed by one, and the page draws itself again with
    // every build while an agent writes. The list is a new element each time, so what the owner chose is kept here, by document: a list opened
    // stays open through every redraw until it is closed or an item is chosen, and another document starts folded. <beside> is the wide layout,
    // where the list is always open and nothing is learned from it.
    function tocKeeper() {
      let key = null, open = false;
      return {
        opened(k, beside) { if (k !== key) { key = k; open = false; } return Boolean(beside) || open; },
        set(k, value) { if (k === key) open = Boolean(value); },
      };
    }
    // The expanded Documents view (wide windows): the file takes the width and the panel beside it shows the file browser or the contents. Both
    // choices are the owner's and are kept in the browser; the panel shows the contents by default, and only for a file that has a contents list.
    const expandedPref = stored => stored === "1";
    const sidePref = stored => stored === "files" ? "files" : "contents";
    const sideShows = (want, hasContents) => want === "contents" && hasContents ? "contents" : "files";
    return { tocKeeper, expandedPref, sidePref, sideShows, SINGLE, OTHER, kindOf, title, above, tail, groups, isLeader, pref, mode, taskOf, inside, task, taskText, where, taskGroups, opened, words, narrowing, counts, find, marks };
  })();
