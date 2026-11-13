  // ---------------------------------------------------------------- task tags: the rules behind the task menu (tasktags.js, shared by the reader page and tasktags.test.js)
  // build_prototype.fill_template pastes this file into the reader page's script, after find.js. Every pure rule of the task menu is here, so tasktags.test.js runs them
  // without a page: which tasks a conversation touches, how the menu groups them, which turns a switch hides, the banner's words, the width at which the menu is a rail
  // or a bottom sheet, and what this browser remembers for each conversation.
  //
  // The data is the conversation's own (task_tags.py, run at build time by the Tasks board's tagger): each turn carries `tags` ([[task id, why], ...]) or `tag_row`
  // ("upkeep" for a heartbeat, a check or a routine reply, "none" for talk with no task); session.leader.tasks gives the tasks' titles and states. A turn that touches
  // several tasks shows while any one of them is on (A4); the switches are a set of what is OFF, so a task that shows up later is on until you turn it off (a filter
  // never hides what you have not seen). Switching a task off folds its turns into one row that opens in place (B1).
  const taskTags = (() => {
    const UPKEEP = "·upkeep", NONE = "·none";   // the two rows no task owns (A5)
    const ROW_NAMES = { [UPKEEP]: "Fleet upkeep", [NONE]: "No task" };
    const ROW_HINTS = { [UPKEEP]: "Heartbeats, checks and routine replies that touch no task", [NONE]: "Talk with no task in it" };
    const REASONS = {
      marked: "you marked it", signal: "a status wake-up for it", mention: "the words name it", command: "a command names it",
      wake: "the wake-up names it", pointer: "it points at a reply about it", words: "three rare words of its id appear",
    };
    // The one width at which the menu stops being a bottom sheet and sits beside the column: the Documents list's own rule (820 px). The rail is 20rem from
    // 1030 px, where a 44rem column and the rail both fit; between 820 and 1029 px it is 17rem and the column gives way to it (narrower, never covered).
    const RAIL_MIN = 820, RAIL_WIDE = 1030, REMEMBER_MAX = 60;
    const placement = width => width >= RAIL_MIN ? "rail" : "sheet";
    const railRem = width => width >= RAIL_WIDE ? 20 : width >= RAIL_MIN ? 17 : 0;

    const stem = id => String(id).replace(/^(?:[a-z]+-)?\d{4}-\d{2}-\d{2}-/, "");
    // Until a tracker says which product item a task belongs to (T1 to T4, not built), the key in the task's id groups them: bc-39-specs-task and esim-bc36-final-spec are
    // BC-39 and BC-36 (two or more letters, then a number, with or without the dash; a lone letter is a version or a round, as in l3, v2 or r20). An id with no such key
    // (a misnamed one, like a task that carries only its feature's name) has none.
    const productOf = id => { const m = /(?:^|-)([a-z]{2,6})-?(\d{1,5})(?=-|$)/i.exec(stem(id)); return m ? `${m[1].toUpperCase()}-${m[2]}` : ""; };
    const record = (tasks, id) => (tasks && tasks[id]) || {};
    const nameOf = (id, tasks) => (record(tasks, id).title || "").trim() || stem(id);
    const lastOf = ex => Math.max(ex.reply_at || 0, ex.at || 0);
    const tagsOf = ex => Array.isArray(ex.tags) ? ex.tags : [];

    // What a conversation touches: each task with how many turns and when last, then the two rows. `tagged` is false for a conversation that carries no tags at all
    // (a worker's, a copy built before tags): the menu is not offered for it.
    function summary(exchanges, tasks) {
      const byId = new Map();
      const rows = { [UPKEEP]: { turns: 0, last: 0 }, [NONE]: { turns: 0, last: 0 } };
      let tagged = false, total = 0;
      for (const ex of exchanges || []) {
        if (ex.source === "session") continue;
        const own = tagsOf(ex);
        if (own.length) {
          tagged = true; total += 1;
          for (const [id] of own) {
            let item = byId.get(id);
            if (!item) byId.set(id, item = { id, title: record(tasks, id).title || "", state: record(tasks, id).state || "", turns: 0, last: 0, product: productOf(id) });
            item.turns += 1; item.last = Math.max(item.last, lastOf(ex));
          }
        } else if (ex.tag_row === "upkeep" || ex.tag_row === "none") {
          tagged = true; total += 1;
          const row = rows[ex.tag_row === "upkeep" ? UPKEEP : NONE];
          row.turns += 1; row.last = Math.max(row.last, lastOf(ex));
        }
      }
      const list = [...byId.values()].sort((a, b) => b.last - a.last || (a.id < b.id ? -1 : 1));
      return { tagged, total, tasks: list, rows: [UPKEEP, NONE].map(key => ({ key, name: ROW_NAMES[key], hint: ROW_HINTS[key], ...rows[key] })).filter(row => row.turns) };
    }

    // The menu's groups: the tasks that share a product key, newest group first, then every other task. A key that only one task has (reader-fix-group-3, fw37-lesson-0017:
    // a word and a number, not a product item) makes no group, so a group is a family of two tasks or more; a conversation with no family is one list with no headings.
    function groups(list) {
      const keyed = new Map(), loose = [];
      for (const task of list) {
        if (!task.product) { loose.push(task); continue; }
        if (!keyed.has(task.product)) keyed.set(task.product, []);
        keyed.get(task.product).push(task);
      }
      const make = (key, label, tasks) => ({ key, label, tasks, turns: tasks.reduce((n, t) => n + t.turns, 0), last: Math.max(...tasks.map(t => t.last)) });
      const families = [...keyed].filter(([, tasks]) => tasks.length > 1);
      for (const [, tasks] of keyed) if (tasks.length === 1) loose.push(tasks[0]);
      loose.sort((a, b) => b.last - a.last || (a.id < b.id ? -1 : 1));
      const out = families.map(([key, tasks]) => make(key, key, tasks)).sort((a, b) => b.last - a.last || (a.key < b.key ? -1 : 1));
      if (loose.length) out.push(make("", out.length ? "Other tasks" : "", loose));
      return out;
    }

    // Whether the switches leave a turn on screen. `hidden` is the Set of what is off: task ids and the two row keys. A turn with no tags and no row (a divider, a turn
    // of a copy built before tags) always shows.
    function visible(ex, hidden) {
      if (!hidden || !hidden.size || ex.source === "session") return true;
      const own = tagsOf(ex);
      if (own.length) return own.some(([id]) => !hidden.has(id));
      if (ex.tag_row === "upkeep") return !hidden.has(UPKEEP);
      if (ex.tag_row === "none") return !hidden.has(NONE);
      return true;
    }
    const keysOf = sum => [...sum.tasks.map(t => t.id), ...sum.rows.map(r => r.key)];
    // Only <key>: everything the conversation has but that one is off.
    const only = (sum, key) => new Set(keysOf(sum).filter(k => k !== key));
    // What the switches hide now: the turns, the tasks and rows still on, and how many of the hidden turns came after `since` (an epoch: when the switches last changed).
    function counts(exchanges, sum, hidden, since = 0) {
      const off = new Set([...(hidden || [])].filter(k => keysOf(sum).includes(k)));
      let hiddenTurns = 0, fresh = 0;
      for (const ex of exchanges || []) {
        if (ex.source === "session" || visible(ex, off)) continue;
        hiddenTurns += 1;
        if (since && lastOf(ex) > since) fresh += 1;
      }
      const shownTasks = sum.tasks.filter(t => !off.has(t.id)).length;
      return { off: off.size, hiddenTurns, fresh, shownTasks, totalTasks: sum.tasks.length, upkeepOff: off.has(UPKEEP), noneOff: off.has(NONE) };
    }
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    // The banner always says what is hidden: the tasks still on, how many turns are folded, which of the two rows is off, and what is new since the switches changed.
    function banner(c) {
      if (!c.off) return "";
      // A task's turns that also touch a task that is on stay on screen (A4), so switching a task off can hide nothing yet.
      const parts = [`Showing ${c.shownTasks} of ${plural(c.totalTasks, "task", "tasks")}`, c.hiddenTurns ? `${plural(c.hiddenTurns, "turn", "turns")} hidden` : "no turns hidden"];
      if (c.upkeepOff) parts.push("Fleet upkeep off");
      if (c.noneOff) parts.push("No task off");
      if (c.fresh) parts.push(`${c.fresh} new`);
      return parts.join(" · ");
    }
    // The menu's find box: the tasks whose name, id or state hold every word typed, in any order and any case.
    const matches = (task, tasks, query) => { const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean); const text = `${nameOf(task.id, tasks)} ${task.id} ${task.state || ""}`.toLowerCase(); return words.every(w => text.includes(w)); };
    const foldLabel = n => `${plural(n, "turn", "turns")} in other tasks`;

    // A turn's chip: the first task's name and how many more ("first task +2"), and what each tag says why.
    function chip(ex, tasks) {
      const own = tagsOf(ex);
      if (!own.length) return null;
      const lines = own.map(([id, why]) => `${nameOf(id, tasks)}: ${String(why).split("+").map(r => REASONS[r] || r).join(", ")}`);
      return { text: nameOf(own[0][0], tasks), more: own.length - 1, ids: own.map(([id]) => id), title: `About ${plural(own.length, "task", "tasks")}\n` + lines.join("\n") };
    }

    // What this browser remembers (B2): per conversation, the set that is off, kept as one small JSON object { <conversation id>: { h: [keys], t: epoch } } in the
    // browser's own storage. A conversation is named by any of its session ids (a /clear gives it a newer one). Only the newest REMEMBER_MAX conversations are kept,
    // and a conversation with everything on is not kept at all. Anything unreadable is nothing remembered.
    function parse(raw) {
      try { const value = JSON.parse(raw || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch (e) { return {}; }
    }
    function recall(raw, ids) {
      const all = parse(raw);
      for (const id of [...ids].reverse()) {
        const entry = all[id];
        if (entry && Array.isArray(entry.h)) return new Set(entry.h.filter(k => typeof k === "string").slice(0, 400));
      }
      return new Set();
    }
    function remember(raw, ids, hidden, now) {
      const all = parse(raw);
      for (const id of ids) delete all[id];
      if (hidden && hidden.size) all[ids[ids.length - 1]] = { h: [...hidden].slice(0, 400), t: Math.round(now) };
      const keep = Object.entries(all).filter(([, e]) => e && Array.isArray(e.h)).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)).slice(0, REMEMBER_MAX);
      return JSON.stringify(Object.fromEntries(keep));
    }
    // The rail's own open or closed: what was chosen wins; else it is open where there is room for it (1030 px) in a conversation that touches two tasks or more.
    const railOpen = (choice, width, sum) => choice === "1" ? true : choice === "0" ? false : width >= RAIL_WIDE && sum.tasks.length >= 2;


    // ---------------------------------------------------------------- changing a turn's tasks from the conversation (the turn menu)
    // A tag is changed by one reply mark of the Tasks board (data/<task>/reply-marks.jsonl, filed by Firstmate's fm-reply-mark.sh through the reader's board-mark route):
    // `in` adds the task, `out` takes it off, `clear` withdraws an earlier mark. A turn is read on two sides, the reply and your message, and a mark names the side it is
    // on: `<mk>:<first eight of the turn's uid>:reply|in`, `mk` being the session id of the log that holds the turn (task_tags.py). A tag added here goes on the reply, or
    // on your message while the turn has no reply yet; a tag is taken off on the side(s) it sits on (`tag_sides`: "r", "m" or "rm", left out when every tag is "r").
    // Every write the page makes is `marksFor` handed to the page's one writer, and every read of what the build made of them is `tags` itself, so a store that serves the
    // tags later changes neither the control nor these rules.
    const SIDE_PARTS = { r: "reply", m: "in" };
    const hasText = value => typeof value === "string" && value !== "";
    const markable = ex => Boolean(ex) && ex.source !== "session" && hasText(ex.mk) && hasText(ex.uid);
    const markKey = (ex, part) => markable(ex) ? `${ex.mk}:${ex.uid.slice(0, 8)}:${part}` : "";
    const addPart = ex => ex && ex.reply ? "reply" : "in";
    const tagAt = (ex, id) => tagsOf(ex).findIndex(tag => tag[0] === id);
    const sideOf = (ex, id) => { const at = tagAt(ex, id); return at < 0 ? "r" : (Array.isArray(ex.tag_sides) && ex.tag_sides[at]) || "r"; };
    const partsOf = side => { const parts = [...new Set(String(side || "r").split("").map(c => SIDE_PARTS[c]).filter(Boolean))]; return parts.length ? parts : ["reply"]; };
    const reasonsOf = (ex, id) => { const at = tagAt(ex, id); return at < 0 ? [] : String(tagsOf(ex)[at][1] || "").split("+").filter(Boolean); };
    // What the panel offers for a tag the turn has: a tag you added is taken off ("remove": its mark is withdrawn), a tag the rules made is declined ("drop": an `out`).
    const tagAction = (ex, id) => { const reasons = reasonsOf(ex, id); return reasons.length && reasons.every(r => r === "marked") ? "remove" : "drop"; };
    // The marks one action writes: [{ task, turn, mark }]. add: one `in`; drop: an `out` on each side the tag sits on; remove: a `clear` on each of them.
    function marksFor(ex, id, action) {
      if (!markable(ex) || !id) return [];
      if (action === "add") return [{ task: id, turn: markKey(ex, addPart(ex)), mark: "in" }];
      const mark = action === "drop" ? "out" : action === "remove" ? "clear" : "";
      return mark ? partsOf(sideOf(ex, id)).map(part => ({ task: id, turn: markKey(ex, part), mark })) : [];
    }
    // What undoes them: `clear` for an `in` or an `out` (the turn goes back to what the rules said), `in` again for a `clear`.
    const undoOf = marks => marks.map(m => ({ task: m.task, turn: m.turn, mark: m.mark === "clear" ? "in" : "clear" }));
    // The panel's rows for the tags a turn has: the task, why it is tagged and the one action offered.
    function turnTags(ex, tasks) {
      return tagsOf(ex).map(([id, why]) => ({ id, name: nameOf(id, tasks), state: record(tasks, id).state || "", why: String(why).split("+").map(r => REASONS[r] || r).join(", "), action: tagAction(ex, id), side: sideOf(ex, id) }));
    }
    // The picker: the tasks this conversation touches (newest first), then the other tasks that are In flight or Queued, then finished ones only when the find box
    // matches them. A task only the archive remembers is never offered (the command refuses a task that is not in the backlog), nor one the turn already has.
    const STATE_ORDER = { "In flight": 0, "Queued": 1 };
    function pickList(ex, tasks, sum, query) {
      const have = new Set(tagsOf(ex).map(tag => tag[0])), words = String(query || "").trim();
      const offered = id => !have.has(id) && !(record(tasks, id).archived);
      const fits = item => !words || matches(item, tasks, words);
      const touched = ((sum && sum.tasks) || []).filter(item => offered(item.id) && fits(item));
      const seen = new Set(touched.map(item => item.id)), open = [], finished = [];
      for (const id of Object.keys(tasks || {})) {
        if (seen.has(id) || !offered(id)) continue;
        const item = { id, title: record(tasks, id).title || "", state: record(tasks, id).state || "", turns: 0, last: 0 };
        if (!fits(item)) continue;
        if (item.state === "Done") { if (words) finished.push(item); } else open.push(item);
      }
      open.sort((a, b) => (STATE_ORDER[a.state] ?? 2) - (STATE_ORDER[b.state] ?? 2) || (a.id < b.id ? -1 : 1));
      finished.sort((a, b) => (a.id < b.id ? -1 : 1));
      return [{ key: "touched", label: "In this conversation", tasks: touched }, { key: "open", label: "Other open tasks", tasks: open }, { key: "finished", label: "Finished", tasks: finished }].filter(group => group.tasks.length);
    }
    // A change the page shows before the build has it: `ops` are { task, action } (add, drop or remove) for one turn; the turn comes back with them applied, the same object
    // when they change nothing. An added tag leads (it is `marked`, the strongest reason); a turn left with no tag falls to the "No task" row until the build says better.
    function overlay(ex, ops) {
      const tags = tagsOf(ex).map(tag => tag.slice());
      const sides = tags.map((tag, i) => (Array.isArray(ex.tag_sides) && ex.tag_sides[i]) || "r");
      let changed = false;
      for (const op of ops || []) {
        const at = tags.findIndex(tag => tag[0] === op.task);
        if (op.action === "add" && at < 0) { tags.unshift([op.task, "marked"]); sides.unshift(addPart(ex) === "reply" ? "r" : "m"); changed = true; }
        else if ((op.action === "drop" || op.action === "remove") && at >= 0) { tags.splice(at, 1); sides.splice(at, 1); changed = true; }
      }
      if (!changed) return ex;
      const next = { ...ex };
      delete next.tags; delete next.tag_sides; delete next.tag_row;
      if (tags.length) { next.tags = tags; if (sides.some(side => side !== "r")) next.tag_sides = sides; } else next.tag_row = "none";
      return next;
    }
    // What the toast says of a refused write: the command's sentence without a folder path in it ("no task x in this home's backlog (data directory /Users/...); a mark is filed in ..." is "no task x in this home's backlog").
    const refusalText = message => String(message || "").replace(/\s*\([^)]*\/[^)]*\)/g, "").replace(/;.*$/, "").trim() || "the command refused";
    const addedText = (id, tasks) => `Added to ${nameOf(id, tasks)}.`;
    const droppedText = (id, tasks) => `Taken off ${nameOf(id, tasks)}.`;

    return { UPKEEP, NONE, RAIL_MIN, RAIL_WIDE, REASONS, placement, railRem, stem, productOf, nameOf, summary, groups, matches, visible, only, counts, banner, foldLabel, chip, recall, remember, railOpen, markable, markKey, marksFor, undoOf, tagAction, turnTags, pickList, overlay, refusalText, addedText, droppedText };
  })();
