  // ---------------------------------------------------------------- Claude's permission asks (askcards.js, pasted into the reader page)
  // build_prototype.fill_template pastes this file into the reader page's script. It holds what the card for an ask says and where an ask goes in
  // a conversation, as plain functions with no page in them: askcards.test.js runs it in a bare sandbox. The server side is permissions.js; the card
  // itself, its buttons and the Undo window are drawn by the page (template.html, "Permission asks").
  const ASK_UNDO_SECONDS = 3;
  const ASK_VERBS = {
    Bash: "run a command", Write: "write a file", Edit: "edit a file", MultiEdit: "edit a file", NotebookEdit: "edit a notebook", Read: "read a file",
    Glob: "look for files", Grep: "search files", WebFetch: "fetch a web page", WebSearch: "search the web", Task: "start a helper agent", Agent: "start a helper agent",
  };
  // What the card is titled: "Claude asks to run a command". A tool this does not know is named as it is called, so nothing is hidden behind a guess.
  const askTitle = tool => {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(tool || "");
    if (mcp) return `Claude asks to use ${mcp[2]} (from ${mcp[1]})`;
    return ASK_VERBS[tool] ? `Claude asks to ${ASK_VERBS[tool]}` : `Claude asks to use ${tool || "a tool"}`;
  };
  // The main keys of a tool input come first, in this order; every other key follows in the order it came.
  const ASK_FIRST = ["command", "description", "file_path", "notebook_path", "path", "url", "pattern", "query", "prompt", "old_string", "new_string", "content", "edits"];
  const ASK_INLINE_MAX = 100;
const ASK_BLOCK = ["command", "old_string", "new_string", "content", "prompt"];
const ASK_MONO = ["file_path", "notebook_path", "path", "url", "pattern"];
  // Every key of the input as a field: { key, text, block }. A short one-line string is shown beside its name, anything longer, with line breaks, or not
  // a string (a list, an object) is shown in a block: all of it, never cut. Nothing is dropped, so an input with a key this does not know still shows whole.
  const askFields = input => {
    const keys = Object.keys(input && typeof input === "object" ? input : {});
    const ordered = [...ASK_FIRST.filter(k => keys.includes(k)), ...keys.filter(k => !ASK_FIRST.includes(k))];
    return ordered.map(key => {
      const value = input[key];
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      // The command, the text of an edit and anything that is not a string are always a block in the monospace face (spaces and line breaks count in them);
      // a path, a link or a pattern is one line of the same face; the rest is prose.
      const block = typeof value !== "string" || ASK_BLOCK.includes(key) || text.includes("\n") || text.length > ASK_INLINE_MAX;
      return { key, text, block, code: block || ASK_MONO.includes(key) };
    });
  };
  // What the record says once it is no longer open, and in which tone. t(at) is a time of day.
  const askOutcome = (rec, t) => {
    const at = rec.answered_at || rec.ended_at || rec.at;
    if (rec.state === "allowed") return { tone: "ok", say: `Answered: Allowed once · ${t(at)}` };
    if (rec.state === "denied") return { tone: "no", say: `Answered: Denied · ${t(at)}` };
    if (rec.state === "elsewhere") return { tone: "other", say: `Answered in the pane, not here · ${t(at)}` };
    if (rec.state === "expired") return { tone: "other", say: `Not answered here in time; the pane's own prompt took over · ${t(at)}` };
    if (rec.state === "gone") return { tone: "other", say: `Ended without an answer from here (the reader restarted) · ${t(at)}` };
    return { tone: "open", say: "" };
  };
  // Where a record goes among a conversation's turns: the index of the last turn that began at or before it, or -1 when it came before them all.
  const askPlace = (exchanges, at) => {
    let place = -1;
    for (let i = 0; i < exchanges.length; i++) { if (exchanges[i].at && exchanges[i].at <= at) place = i; }
    return place;
  };
  // The records of a conversation, in the order they happened: those whose session is one of the conversation's (a /clear starts a new session).
  const asksOf = (asks, ids) => (Array.isArray(asks) ? asks : []).filter(a => ids.includes(a.session)).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  // What a Send into a pane that waits at a prompt says: the ask on the page is the way through, else Herdr's pane is.
  const askBlockedReason = (label, open) => open ? `${label} is waiting for you at a permission prompt. Answer it above (Allow once or Deny); Send is back after that.` : `${label} is at a permission prompt or question. Answer it in Herdr first.`;
