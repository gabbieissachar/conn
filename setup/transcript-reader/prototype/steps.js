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
    // A shell command laid out for reading, the way the step sheet's Format button shows it: one statement per line, split at
    // ; and at a newline, and a command that goes on after && || | or |& breaks after the operator and continues on a line
    // indented by two spaces (the operator stays at the end of the line, so the layout is still a valid command). Only the
    // layout changes: quoted strings, $( ), ( ), { }, [[ ]], backticks, comments, escapes, redirections (2>&1, >|) and a
    // heredoc's body are copied exactly as they were, and after a heredoc's start the rest of its line is left whole, because
    // its body must follow that line. A command this cannot read with certainty (an unclosed quote or bracket, a case ... in,
    // a heredoc inside a bracket, a stray ;;) comes back unchanged. The Copy button always copies the original text.
    function formatCommand(text) {
      const src = String(text == null ? "" : text), n = src.length, BAIL = {};
      const out = [], stack = ["cmd"], heredocs = [];
      let cur = "", i = 0, wasChained = false, holdLine = false, contAt = -1, blankBefore = false;
      const wordStart = at => at === 0 || /[\s;|&(]/.test(src[at - 1]);
      // The part read so far, without the spaces around it and without a "\<newline>" the author left before an operator.
      const take = () => {
        let t = cur;
        if (contAt >= 0 && /^\\\n[ \t]*$/.test(t.slice(contAt))) t = t.slice(0, contAt);
        cur = ""; contAt = -1;
        return t.replace(/\s+$/, "").replace(/^\s+/, "");
      };
      const push = (t, op) => {
        if (blankBefore && out.length && !wasChained) out.push("");
        blankBefore = false;
        out.push((wasChained ? "  " : "") + t + (op ? " " + op : ""));
        wasChained = Boolean(op);
      };
      const endStatement = () => { const t = take(); if (t) push(t, ""); else wasChained = false; };
      const operator = (op, width) => {
        const t = take();
        if (!t) throw BAIL;
        push(t, op);
        i += width;
        while (i < n) {
          if (/\s/.test(src[i])) i++;
          else if (src[i] === "\\" && src[i + 1] === "\n") i += 2;
          else break;
        }
      };
      try {
        while (i < n) {
          const c = src[i], top = stack[stack.length - 1], base = stack.length === 1, next = src[i + 1];
          if (top === "dq") {
            if (c === "\\") { cur += src.substr(i, 2); i += 2; continue; }
            if (c === '"') { stack.pop(); cur += c; i++; continue; }
            if (c === "$" && next === "(") { stack.push("paren"); cur += "$("; i += 2; continue; }
            if (c === "$" && next === "{") { stack.push("brace"); cur += "${"; i += 2; continue; }
            if (c === "`") { stack.push("bt"); cur += c; i++; continue; }
            cur += c; i++; continue;
          }
          if (c === "\\") {
            if (next === "\n") { contAt = cur.length; cur += "\\\n"; i += 2; continue; }
            cur += src.substr(i, 2); i += 2; continue;
          }
          if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) throw BAIL; cur += src.slice(i, j + 1); i = j + 1; continue; }
          if (c === "$" && next === "'") {
            let j = i + 2;
            while (j < n && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
            if (j >= n) throw BAIL;
            cur += src.slice(i, j + 1); i = j + 1; continue;
          }
          if (c === '"') { stack.push("dq"); cur += c; i++; continue; }
          if (c === "$" && next === "(") { stack.push("paren"); cur += "$("; i += 2; continue; }
          if (c === "$" && next === "{") { stack.push("brace"); cur += "${"; i += 2; continue; }
          if (c === "`") { if (top === "bt") stack.pop(); else stack.push("bt"); cur += c; i++; continue; }
          if (c === "(") { stack.push("paren"); cur += c; i++; continue; }
          if (c === ")") { if (top !== "paren") throw BAIL; stack.pop(); cur += c; i++; continue; }
          if (c === "{" && wordStart(i) && /\s/.test(next || "")) { stack.push("brace"); cur += c; i++; continue; }
          if (c === "}" && top === "brace") { stack.pop(); cur += c; i++; continue; }
          if (c === "[" && next === "[" && wordStart(i)) { stack.push("dbl"); cur += "[["; i += 2; continue; }
          if (c === "]" && next === "]" && top === "dbl") { stack.pop(); cur += "]]"; i += 2; continue; }
          if (c === "#" && wordStart(i)) { const j = src.indexOf("\n", i); const e = j < 0 ? n : j; cur += src.slice(i, e); i = e; continue; }
          if (c === "<" && next === "<") {
            if (src[i + 2] === "<") { cur += "<<<"; i += 3; continue; }
            if (!base) throw BAIL;
            let j = i + 2;
            const dash = src[j] === "-";
            if (dash) j++;
            while (src[j] === " " || src[j] === "\t") j++;
            let word;
            if (src[j] === "'" || src[j] === '"') {
              const k = src.indexOf(src[j], j + 1);
              if (k < 0) throw BAIL;
              word = src.slice(j + 1, k); j = k + 1;
            } else {
              const m = /^\\?([^\s;|&()<>'"\\]+)/.exec(src.slice(j));
              if (!m) throw BAIL;
              word = m[1]; j += m[0].length;
            }
            cur += src.slice(i, j); i = j;
            heredocs.push({ word, dash }); holdLine = true;
            continue;
          }
          if (!base) { cur += c; i++; continue; }
          // From here on the character is at the top level of the command.
          if (c === "\n") {
            if (heredocs.length) {
              i++;
              for (const hd of heredocs) {
                for (;;) {
                  if (i >= n) throw BAIL;
                  const e = src.indexOf("\n", i), line = src.slice(i, e < 0 ? n : e);
                  cur += "\n" + line; i = e < 0 ? n : e + 1;
                  if ((hd.dash ? line.replace(/^\t+/, "") : line) === hd.word) break;
                }
              }
              heredocs.length = 0; holdLine = false;
              endStatement();
              continue;
            }
            if (!cur.trim() && out.length && /\n[ \t]*$/.test(src.slice(Math.max(0, i - 40), i))) blankBefore = true;
            endStatement(); i++;
            continue;
          }
          if (holdLine) { cur += c; i++; continue; }
          if (c === ";") {
            if (next === ";" || next === "&") throw BAIL;
            endStatement(); i++;
            continue;
          }
          if (c === "&" && next === "&") { operator("&&", 2); continue; }
          if (c === "|" && src[i - 1] !== ">") {
            if (next === "|") operator("||", 2);
            else if (next === "&") operator("|&", 2);
            else operator("|", 1);
            continue;
          }
          if (c === "c" && wordStart(i) && /^case\s/.test(src.slice(i, i + 5)) && (!cur.trim() || /(^|\s)(then|do|else|elif)$/.test(cur.trim()))) throw BAIL;
          cur += c; i++;
        }
        if (stack.length !== 1 || heredocs.length) throw BAIL;
      } catch (e) {
        if (e === BAIL) return src;
        throw e;
      }
      endStatement();
      return out.length ? out.join("\n") : src;
    }
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
    // ctx: { loaded: the output object is in hand, sealed: this is the sealed copy, from: the window's first second, inline: the output came with the turn }.
    function outputPlan(step, ctx) {
      if (step.h) return { kind: "kept", note: "Not kept: this touched a dotfile or a credential path." };
      // ctx.inline: the output came with the turn (the embed page's host sends it), so a file's text is shown as it was given.
      if (step.k === "read" && !ctx.inline) return { kind: "kept", note: step.l ? `${plural(step.l, "line")} read. The text of a file the agent read is never kept.` : "The text of a file the agent read is never kept." };
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
    return { KIND, FIRST_ROWS, DIFF_ROWS, TAIL_LINES, WINDOW_DAYS, list, key, files, summary, plan, visible, diffRows, clipRows, counts, tail, formatCommand, outputPlan, failedAt, searchText, windowFrom, plural };
  })();
