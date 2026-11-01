  // ---------------------------------------------------------------- find (find.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script, after pins.js and markdown.js.
  // The matching behind the search row: plain functions over the turns the page already holds, with no DOM, no
  // network and no model, so a vm sandbox can run them (find.test.js). A match is a part of a turn: your message
  // (or the instruction a Firstmate doorbell delivered), the reply, or the turn's working notes. A part is named the
  // way a pin is, "<turn id>:<part>", so a match keeps its identity when a /clear joins earlier turns above it.
  // Matching is a case-insensitive substring over the part's text as the page draws it: every word must be in the
  // same part, in any order, and a "quoted phrase" stays together.
  const finder = (() => {
    const RANK = { in: 0, reply: 1, notes: 2 };
    const stats = { builds: 0 };
    const cache = new Map();
    // One character for one character, so an offset in the folded copy is an offset in the text it came from.
    function fold(text) {
      let low = text.toLowerCase();
      // A few letters (İ) lower to two characters: those stay as they were, so the copy stays the same length.
      if (low.length !== text.length) low = Array.from(text, ch => { const l = ch.toLowerCase(); return l.length === ch.length ? l : ch; }).join("");
      return low.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\u00a0/g, " ");
    }
    // The words of a query: bare words and "quoted phrases" (an unclosed quote runs to the end), folded, with the
    // spaces inside a phrase squeezed as they are in the text. Two characters of searching are the least.
    function parse(query) {
      const terms = (fold(query).match(/"[^"]*"?|\S+/g) || []).map(t => t.replace(/^"|"$/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
      return { terms, ok: terms.join("").length >= 2 };
    }
    const squash = text => text.replace(/\s+/g, " ").trim();
    // What a reply reads as once the page has drawn it: the markers gone, a link as its label and its address, code as
    // written, a table without its pipes, spaces squeezed. markdown.js draws the page and reads this off the same parse
    // (markdownView, which the page script defines before this file), so the words searched are the words shown.
    const plainMarkdown = text => markdownView.plain(text);
    // The text each kind of part shows. A message and the working notes are drawn as written; only a reply is markdown.
    const instruction = ex => ex.source === "firstmate" && ex.delivered && ex.delivered.length ? ex.delivered.join("\n\n") : ex.input;
    const partText = (ex, part) => part === "in" ? squash(instruction(ex) || "") : part === "reply" ? plainMarkdown(ex.reply || "") : squash((ex.narration || []).join("\n\n"));
    const uid = (ex, i) => ex.uid || "n" + i;
    // The searchable parts of a conversation, in reading order. Dividers hold no words. A wake-up's own notice is not
    // a message, so only its reply is searched. A doorbell that rings again for a message already shown delivers
    // nothing, and the page draws one line for it. A Firstmate doorbell searches what it delivered, not the pointer.
    function build(session) {
      stats.builds += 1;
      const fields = [];
      (session.exchanges || []).forEach((ex, i) => {
        if (ex.source === "session") return;
        const id = uid(ex, i);
        // needs: an ask still open, as asks.js reads it (a copy built before ask_state has none, and reads as open).
        const add = (part, who, label, at) => {
          const low = fold(partText(ex, part));
          if (low) fields.push({ i, part, key: `${id}:${part}`, who, label, at, needs: part === "reply" && ex.verdict === "needs-you" && (ex.ask_state || "open") === "open", folded: ex.source === "wake" && Boolean(ex.folded), low, ex });
        };
        if (ex.source !== "wake" && !(ex.source === "firstmate" && ex.repeat)) add("in", ex.source === "captain" ? "you" : ex.source === "firstmate" ? "firstmate" : "peer", ex.source === "captain" ? "You" : ex.label, ex.at);
        if (ex.reply) add("reply", "reply", ex.source === "wake" ? "Wake-up reply" : "Reply", ex.reply_at || ex.at);
        if (ex.narration && ex.narration.length) add("notes", "notes", "Working notes", ex.reply_at || ex.at);
      });
      return fields;
    }
    // A conversation's parts are built once and kept while its turns are the same: a rebuild of the page (every few
    // seconds while an agent works) brings every conversation again, but only one that gained a turn, or whose words
    // grew, or whose stamp changed (the hosted copy's) is folded again.
    function signature(session) {
      let words = 0, delivered = 0;
      for (const e of session.exchanges) {
        words += (e.reply_words || 0) + (e.narration_words || 0);
        for (const d of e.delivered || []) delivered += d.length;
      }
      return `${session.stamp || ""}|${session.exchanges.length}|${words}|${delivered}`;
    }
    function fieldsOf(session) {
      if (!session.exchanges) return [];
      const sig = signature(session), kept = cache.get(session.id);
      if (kept && kept.sig === sig) return kept.fields;
      const fields = build(session);
      cache.set(session.id, { sig, fields });
      return fields;
    }
    const WHO = {
      any: () => true,
      you: f => f.who === "you",
      replies: f => f.who === "reply" || f.who === "notes",
      needs: f => f.who === "reply" && f.needs,
      firstmate: f => f.who === "firstmate",
    };
    function occurrences(low, terms) {
      let n = 0;
      for (const t of terms) for (let at = low.indexOf(t); at >= 0; at = low.indexOf(t, at + t.length)) n += 1;
      return n;
    }
    // The matching parts of the given conversations: [{ conv, key, field, count }]. Scope "here" lists one
    // conversation in reading order, as find in a page does. Scope "all" lists the conversation with the newest match
    // first, and the newest match first inside each. Without a way to rank, the newest is the one written last.
    function search(sessions, terms, who, scope) {
      if (!terms.length) return [];
      const pass = WHO[who] || WHO.any;
      const groups = [];
      for (const s of sessions) {
        const hits = fieldsOf(s).filter(f => pass(f) && terms.every(t => f.low.includes(t))).map(field => ({ conv: s.id, key: field.key, field, count: occurrences(field.low, terms) }));
        if (hits.length) groups.push(hits);
      }
      if (scope !== "all") return groups.flat();
      // Every conversation is in hand here, so one that left the list (or got a newer id after a /clear) is dropped.
      const alive = new Set(sessions.map(s => s.id));
      for (const id of cache.keys()) if (!alive.has(id)) cache.delete(id);
      const newer = (a, b) => (b.field.at || 0) - (a.field.at || 0) || b.field.i - a.field.i || RANK[b.field.part] - RANK[a.field.part];
      groups.forEach(g => g.sort(newer));
      groups.sort((a, b) => newer(a[0], b[0]));
      return groups.flat();
    }
    // About 50 characters before the first match and 110 after it, from the text as drawn, as [{ text, hit }] pieces
    // with every word marked, so the page builds the line from text nodes. cut says which ends were cut.
    function snippet(field, terms, before = 50, after = 110) {
      const text = partText(field.ex, field.part), low = field.low;
      const first = Math.min(...terms.map(t => low.indexOf(t)).filter(at => at >= 0), text.length);
      let start = Math.max(0, first - before), end = Math.min(text.length, first + after);
      // Cut at a space when one is near, so a word is not split.
      if (start > 0) { const gap = text.indexOf(" ", start); if (gap >= 0 && gap < first) start = gap + 1; }
      if (end < text.length) { const gap = text.lastIndexOf(" ", end); if (gap > first) end = gap; }
      const marks = [];
      for (const t of terms) for (let at = low.indexOf(t, start); at >= 0 && at < end; at = low.indexOf(t, at + t.length)) marks.push([at, Math.min(end, at + t.length)]);
      marks.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const m of marks) { const last = merged[merged.length - 1]; if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); else merged.push([...m]); }
      const pieces = [];
      let at = start;
      for (const [from, to] of merged) { if (from > at) pieces.push({ text: text.slice(at, from), hit: false }); pieces.push({ text: text.slice(from, to), hit: true }); at = to; }
      if (at < end) pieces.push({ text: text.slice(at, end), hit: false });
      return { pieces, cut: { before: start > 0, after: end < text.length } };
    }
    // Where the words sit in text drawn over several nodes (the page lists the text nodes of one part). pieces are
    // [{ text, gap }], gap meaning a line or block ended before this piece (a space, which no node holds). Returns
    // [{ from: { piece, offset }, to: { piece, offset } }] for every word, to highlight without touching the nodes.
    function spans(pieces, terms) {
      let all = "";
      const starts = pieces.map((p, k) => { if (k && p.gap) all += " "; const at = all.length; all += p.text; return at; });
      const low = fold(all);
      const where = at => {
        let k = starts.length - 1;
        while (k > 0 && starts[k] > at) k -= 1;
        return { piece: k, offset: at - starts[k] };
      };
      const found = [];
      for (const t of terms) {
        const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "g");
        for (const m of low.matchAll(re)) {
          const from = where(m.index), to = where(m.index + m[0].length - 1);
          found.push({ from, to: { piece: to.piece, offset: to.offset + 1 } });
        }
      }
      return found;
    }
    return { fold, parse, plainMarkdown, fieldsOf, search, snippet, spans, occurrences, partText, uid, stats, filters: Object.keys(WHO), reset: () => { cache.clear(); stats.builds = 0; } };
  })();
