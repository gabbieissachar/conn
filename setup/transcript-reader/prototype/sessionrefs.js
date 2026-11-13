  // ---------------------------------------------------------------- references to other sessions in a reply (sessionrefs.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script. Pure functions, so sessionrefs.test.js runs them without a page.
  // A reply often names another session: a Herdr tab label ("fm-2026-11-06-esim-listing-output-sync-run"), a role ("leader-esim", "big-boss",
  // which are tab labels too) or a session id. The page links each one it can resolve to a conversation the reader lists, with the same
  // mapping the picker uses (a conversation's pane label, its ids), and leaves everything else as text: no link that goes nowhere.
  //   index(sessions, { rank, skip })   what the page keeps while the list is the same: label -> conversation, and id -> conversation
  //   scan(text, index)                 the references in prose: [{ start, end, session }]
  //   whole(text, index)                the conversation a whole inline-code span names (also by the first 8+ characters of an id), or null
  //   signature(index)                  the label and id pairs that decide the links, so a redrawn page can tell they changed
//   used(texts, index)                the references these replies make, as text: what a drawing of them reads of the index
  const sessionRefs = (() => {
    // A label that can be told from prose: letters, digits, "_" and "-", at least 6 characters, with a "-" or "_" in it. "1", "personal" and
    // "Claude Code" are labels too (a pane with no name of its own), and would match ordinary words.
    const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{4,}[A-Za-z0-9]$/;
    const TOKEN = /[A-Za-z0-9_][A-Za-z0-9_-]*/g;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const HEX = /^[0-9a-f][0-9a-f-]{7,34}$/;
    const eligible = label => typeof label === "string" && LABEL.test(label) && /[-_]/.test(label);
    // A better conversation first: one a pane runs now, then the one with the newest turn. <rank>(session) answers [running 0 or 1, last turn].
    const better = (rank, a, b) => { const x = rank(a), y = rank(b); return x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1]; };
    // <sessions>: the page's conversations ({ id, ids, pane: { label } }). <skip>: the ids of the conversation on screen, which a reply
    // naming itself does not link to.
    function index(sessions, options = {}) {
      const rank = options.rank || (() => [0, 0]);
      const skip = new Set(options.skip || []);
      const labels = new Map(), ids = new Map();
      for (const s of sessions || []) {
        if (!s || !s.id) continue;
        for (const id of s.ids || [s.id]) if (UUID.test(id) && !ids.has(id)) ids.set(id, s);
        const label = s.pane && s.pane.label;
        if (!eligible(label)) continue;
        const held = labels.get(label);
        if (!held || better(rank, s, held)) labels.set(label, s);
      }
      const ownIds = new Set();
      for (const s of sessions || []) if (s && (s.ids || [s.id]).some(id => skip.has(id))) for (const id of s.ids || [s.id]) ownIds.add(id);
      return { labels, ids, skip: ownIds, any: labels.size > 0 || ids.size > 0 };
    }
    const own = (index, s) => (s.ids || [s.id]).some(id => index.skip.has(id));
    // The conversation a whole token names: a label, a full id, or (when <prefix>) the first 8 or more characters of exactly one id.
    function resolve(token, index, prefix) {
      let s = index.labels.get(token) || (UUID.test(token) ? index.ids.get(token) : null);
      if (!s && prefix && HEX.test(token)) {
        const found = new Set();
        for (const [id, c] of index.ids) if (id.replace(/-/g, "").startsWith(token) || id.startsWith(token)) found.add(c);
        if (found.size === 1) [s] = found;
      }
      return s && !own(index, s) ? s : null;
    }
    // Where a token sits decides whether it is a reference: not a part of a path, an address or a file name.
    const BEFORE = /[/\\.@#=]$/, AFTER = /^(?:[/\\@]|\.[A-Za-z0-9])/;
    function scan(text, index) {
      const found = [];
      if (!index || !index.any || typeof text !== "string") return found;
      TOKEN.lastIndex = 0;
      let m;
      while ((m = TOKEN.exec(text))) {
        const start = m.index, end = start + m[0].length;
        if (BEFORE.test(text.slice(Math.max(0, start - 1), start)) || AFTER.test(text.slice(end, end + 2))) continue;
        const prefix = /\bsessions?\s+$/i.test(text.slice(Math.max(0, start - 12), start));
        const session = resolve(m[0], index, prefix);
        if (session) found.push({ start, end, session });
      }
      return found;
    }
    const whole = (text, index) => {
      const token = typeof text === "string" ? text.trim() : "";
      return index && index.any && token ? resolve(token, index, true) : null;
    };
    const signature = index => JSON.stringify([[...index.labels].map(([label, s]) => [label, s.id]).sort(), index.ids.size, [...index.skip].sort()]);
    // What a drawing of these replies reads of the index: the references the replies make (a token, and the conversation it opens), as text. A
    // tab renamed or added that no reply names changes nothing here, so a build that only did that does not draw the conversation again;
    // one a reply names does (it is a link now, or goes elsewhere). Prose is scanned and a whole code span is looked up, as the page links them;
    // a token in a code block or a path is read too, which can only draw the conversation once more than needed.
    function used(texts, index) {
      if (!index || !index.any) return "[]";
      const pairs = new Set();
      for (const text of texts || []) {
        if (typeof text !== "string" || !text) continue;
        for (const hit of scan(text, index)) pairs.add(`${text.slice(hit.start, hit.end)}>${hit.session.id}`);
        for (const span of text.match(/`[^`\n]+`/g) || []) {
          const token = span.slice(1, -1).trim(), found = whole(token, index);
          if (found) pairs.add(`${token}>${found.id}`);
        }
      }
      return JSON.stringify([...pairs].sort());
    }
    return { eligible, index, scan, whole, signature, used };
  })();
