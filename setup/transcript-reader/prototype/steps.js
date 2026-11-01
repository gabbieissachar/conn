  // ---------------------------------------------------------------- tool steps (steps.js)
  // build_prototype.fill_template pastes this file into the reader page's script, before find.js. Plain functions over the
  // steps a turn carries (tool_steps.py makes them), with no DOM, no network and no model, so a vm sandbox can run them
  // (steps.test.js): the summary row, the grouping with the working notes between groups, the rows a diff draws, the tail of
  // an output, and where a step's output text comes from. The page draws what these answer.
  const stepsView = (() => {
    const KIND = { ran: "Ran", read: "Read", edited: "Edited", wrote: "Wrote", searched: "Searched", asked: "Asked", agent: "Agent", skill: "Skill", other: "Tool" };
    const FIRST_ROWS = 10;      // a turn shows this many steps, then "N more"
    const DIFF_ROWS = 12;       // a diff shows this many lines behind "Show full diff"
    const TAIL_LINES = 12;      // an output shows this many of its last lines behind "Show all N lines"
    const WINDOW_DAYS = 7;      // the sealed copy keeps the output of this many days without being asked
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const list = ex => ex && Array.isArray(ex.steps) ? ex.steps : [];
    const key = (ex, i) => `${ex.uid}:${i}`;
    const files = ex => new Set(list(ex).filter(s => s.k === "edited" || s.k === "wrote").map(s => s.p || s.s));
    // "7 steps · edited 2 files · 1 failed": what the row on a reply says before it is opened. failed is its own part, so the
    // page can colour it.
    function summary(ex) {
      const steps = list(ex), failed = steps.filter(s => s.f).length, edited = files(ex).size;
      const parts = [plural(steps.length, "step"), ...(edited ? [`edited ${plural(edited, "file")}`] : [])];
      return { total: steps.length, failed, edited, parts, failedText: failed ? `${failed} failed` : "", text: [...parts, ...(failed ? [`${failed} failed`] : [])].join(" · ") };
    }
    // The turn's steps in runs of consecutive calls, with the working notes that came between the runs: a list of
    // { type: "note", text, at } and { type: "group", steps: [index, ...] } in reading order. A step's `o` says how many
    // notes came before it; a note after the last step (an older object with no `o`) still comes out, at the end.
    function plan(ex) {
      const steps = list(ex), notes = Array.isArray(ex.narration) ? ex.narration : [];
      const blocks = [];
      let seen = 0, group = null;
      steps.forEach((step, i) => {
        const upTo = Math.min(Math.max(Number(step.o) || 0, seen), notes.length);
        if (upTo > seen) {
          group = null;
          for (; seen < upTo; seen += 1) blocks.push({ type: "note", text: notes[seen], at: seen });
        }
        if (!group) { group = { type: "group", steps: [] }; blocks.push(group); }
        group.steps.push(i);
      });
      for (; seen < notes.length; seen += 1) blocks.push({ type: "note", text: notes[seen], at: seen });
      return blocks;
    }
    // The first <limit> steps of a plan, whole notes only where a step they lead to is shown; hidden counts the rest.
    function visible(blocks, limit = FIRST_ROWS) {
      const total = blocks.reduce((n, b) => n + (b.type === "group" ? b.steps.length : 0), 0);
      const out = [];
      let shown = 0, waiting = [];
      for (const block of blocks) {
        if (block.type === "note") { waiting.push(block); continue; }
        const take = block.steps.slice(0, Math.max(0, limit - shown));
        if (!take.length) break;
        out.push(...waiting, { type: "group", steps: take });
        waiting = [];
        shown += take.length;
        if (take.length < block.steps.length) break;
      }
      return { blocks: out, shown, hidden: total - shown };
    }
    // A diff's text as rows: + added, - removed, a space kept, ~ a gap.
    function diffRows(text) {
      return (text || "").split("\n").map(line => line === "~" ? { type: "gap", text: "" } : { type: line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx", text: line.slice(1) });
    }
    const clipRows = (rows, limit = DIFF_ROWS) => ({ rows: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit) });
    const counts = step => step.a || step.r ? `+${step.a || 0} −${step.r || 0}` : "";
    // The last <lines> lines of an output: the error of a command is at the end. total is every line there is.
    function tail(text, lines = TAIL_LINES) {
      const all = String(text || "").replace(/\s+$/, "").split("\n");
      return { text: all.slice(-lines).join("\n"), total: all.length, hidden: Math.max(0, all.length - lines) };
    }
    // Where a step's output text comes from, and what to say when it is not there:
    //   none     nothing to show (no output was recorded, or an edit that worked)
    //   kept     a file read, or a step that touched a dotfile or credential path: the text is never kept
    //   show     the conversation's output object is loaded: read it
    //   fetch    ask for it now (the laptop's page always; the sealed copy for a step inside its window)
    //   offer    older than the window: the output stays at the laptop until "Download this conversation's outputs"
    // ctx: { loaded: the output object is in hand, sealed: this is the sealed copy, from: the window's first second }.
    function outputPlan(step, ctx) {
      if (step.h) return { kind: "kept", note: "Not kept: this touched a dotfile or a credential path." };
      if (step.k === "read") return { kind: "kept", note: step.l ? `${plural(step.l, "line")} read. The text of a file the agent read is never kept.` : "The text of a file the agent read is never kept." };
      if (!step.l) return { kind: "none" };
      if (ctx.loaded) return { kind: "show" };
      if (!ctx.sealed || !ctx.from || (step.at || 0) >= ctx.from) return { kind: "fetch" };
      return { kind: "offer", note: `No output on this device for this step. Output stays here for the last ${WINDOW_DAYS} days; older output waits at the laptop.` };
    }
    const failedAt = ex => list(ex).map((s, i) => s.f ? i : -1).filter(i => i >= 0);
    // What a search reads of a step: its summary, its file, and the start of its command (the whole command is not searched: the sealed
    // copy searches what it holds inline).
    const searchText = step => [step.s, step.p, (step.c || "").slice(0, 100)].filter(Boolean).join(" ");
    const windowFrom = builtAt => (builtAt || 0) - WINDOW_DAYS * 86400;
    return { KIND, FIRST_ROWS, DIFF_ROWS, TAIL_LINES, WINDOW_DAYS, list, key, files, summary, plan, visible, diffRows, clipRows, counts, tail, outputPlan, failedAt, searchText, windowFrom, plural };
  })();
