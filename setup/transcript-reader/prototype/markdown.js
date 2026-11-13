  // ---------------------------------------------------------------- markdown (markdown.js, the reader page only)
  // build_prototype.fill_template pastes vendor/markdown-it.min.js and then this file into the reader page's script,
  // before find.js. Everything the page draws as markdown (replies, status and inbox lines, whole documents) goes through
  // here, and so does the search's idea of what a reply reads as, so the two cannot drift apart. It has no DOM, no network
  // and no model, so a vm sandbox can run it (markdown.test.js).
  // Text from outside (pages, Slack, tool output) can never inject markup: raw HTML is off, so a tag shows as the text it
  // is, every piece of text and every attribute is escaped by markdown-it's renderer, and only an http(s) address becomes a
  // link. Anything else a link points at (a local file) is plain words with the target on hover.
  const markdownView = (() => {
    const md = globalThis.markdownit({ html: false, linkify: true, breaks: true, typographer: false });
    // Only an address that names its scheme links; a bare "notes.md" or "a.b" is not a web address.
    md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
    // Every destination is kept as written: the page decides below which ones link, so a file: path still shows on hover.
    md.validateLink = () => true;
    md.normalizeLink = href => href;
    md.normalizeLinkText = text => text;
    const escape = md.utils.escapeHtml;
    const WEB = /^https?:\/\//i;
    const BREAK = /<br\s*\/?>/i;
    const NONE = new Map();

    // A code block in a box with a Copy button. The button's label is drawn by CSS, so selecting the code never picks it up.
    // A leading blank line is doubled because an HTML parser drops the first newline of a pre.
    function codeBox(label, code) {
      const body = code.replace(/\n$/, "");
      return `<div class="codebox">${label ? `<span class="code-label">${escape(label)}</span>` : ""}`
        + `<button type="button" class="copy" data-label="Copy" aria-label="Copy" title="Copy this to the clipboard"></button>`
        + `<pre>${body.startsWith("\n") ? "\n" : ""}${escape(body)}</pre></div>\n`;
    }
    md.renderer.rules.fence = (tokens, i) => codeBox((tokens[i].info.trim().match(/^[\w+#.-]*/) || [""])[0], tokens[i].content);
    md.renderer.rules.code_block = (tokens, i) => codeBox("", tokens[i].content);
    md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
    md.renderer.rules.table_close = () => "</table></div>\n";

    const token = (state, type, tag, nesting) => new state.Token(type, tag, nesting);
    const raw = (state, html) => { const t = token(state, "html_inline", "", 0); t.content = html; return t; };

    // What a run of inline tokens shows as text: the words of a link without its address, code as written, a break as a space.
    function inlineText(children, withLinks) {
      let out = "", href = null, label = "";
      for (const c of children) {
        if (c.type === "link_open") { href = c.attrGet("href") || c.attrGet("title") || ""; label = ""; continue; }
        if (c.type === "link_close") {
          if (withLinks && href && label !== href) out += " " + href;
          href = null;
          continue;
        }
        const text = c.type === "text" || c.type === "code_inline" ? c.content : c.type === "image" ? c.content : c.type === "softbreak" || c.type === "hardbreak" ? " " : "";
        out += text;
        if (href !== null) label += text;
      }
      return out;
    }

    // Links and images: an http(s) address opens in a new tab, anything else is plain words with its target on hover. No
    // image is ever fetched, so one is drawn as a link (or words) around its description.
    function links(state, children) {
      const out = [];
      let local = false;
      const open = (href, kind) => {
        const t = token(state, "link_open", WEB.test(href) ? "a" : "span", 1);
        t.attrs = WEB.test(href) ? [["href", href], ["target", "_blank"], ["rel", "noopener noreferrer"]] : [["class", "local-link"], ["title", href]];
        t.meta = { kind };
        return t;
      };
      for (const c of children) {
        if (c.type === "link_open") {
          const t = open(c.attrGet("href") || "", "link");
          local = t.tag === "span";
          out.push(t);
        } else if (c.type === "link_close") {
          const t = token(state, "link_close", local ? "span" : "a", -1);
          out.push(t);
        } else if (c.type === "image") {
          const href = c.attrGet("src") || "";
          const text = token(state, "text", "", 0);
          text.content = c.content || "image";
          out.push(open(href, "image"), text, token(state, "link_close", WEB.test(href) ? "a" : "span", -1));
        } else out.push(c);
      }
      return out;
    }

    // A <br> typed into a cell or a line is a line break, as on GitHub. It is not a line of the source.
    function breaks(state, children) {
      const out = [];
      for (const c of children) {
        if (c.type !== "text" || !BREAK.test(c.content)) { out.push(c); continue; }
        c.content.split(/<br\s*\/?>/i).forEach((piece, k) => {
          if (k) { const br = token(state, "hardbreak", "br", 0); br.meta = { synthetic: true }; out.push(br); }
          if (piece) { const t = token(state, "text", "", 0); t.content = piece; out.push(t); }
        });
      }
      return out;
    }

    // The lines of a block that ask or remind get a span of their own, so a long paragraph marks only its line. A mark
    // that falls inside bold, italics or a link closes and reopens it at the line end, so the markup stays nested.
    function marked(state, children, first, marks) {
      const counted = c => (c.type === "softbreak" || c.type === "hardbreak") && !(c.meta && c.meta.synthetic);
      const last = first + children.filter(counted).length;
      let any = false;
      for (let n = first; n <= last; n += 1) if (marks.has(n)) any = true;
      if (!any) return children;
      const out = [], stack = [];
      let line = first;
      const begin = () => { if (marks.has(line)) out.push(raw(state, `<span class="${marks.get(line)}">`)); };
      const end = () => { if (marks.has(line)) out.push(raw(state, "</span>")); };
      begin();
      for (const c of children) {
        if (!counted(c)) {
          if (c.nesting === 1) stack.push(c); else if (c.nesting === -1) stack.pop();
          out.push(c);
          continue;
        }
        for (let k = stack.length - 1; k >= 0; k -= 1) out.push(token(state, stack[k].type.replace("_open", "_close"), stack[k].tag, -1));
        end();
        out.push(c);
        line += 1;
        begin();
        for (const open of stack) { const again = token(state, open.type, open.tag, 1); again.attrs = open.attrs && open.attrs.map(a => [...a]); out.push(again); }
      }
      end();
      return out;
    }

    // Runs after markdown-it's own passes on every parse, whole or inline-only.
    md.core.ruler.push("reader", state => {
      const env = state.env, marks = env.marks || NONE, tokens = state.tokens;
      tokens.forEach((t, i) => {
        if (t.type === "heading_open") {
          const level = Number(t.tag.slice(1));
          if (env.doc) {
            const id = `doc-h-${t.map[0] + env.offset}`;
            t.attrSet("id", id);
            env.headings.push({ level, id, text: inlineText(tokens[i + 1].children, false) });
          } else t.tag = "h4";
        } else if (t.type === "heading_close" && !env.doc) t.tag = "h4";
        else if ((t.type === "hr" || t.type === "tr_open") && t.map && marks.has(t.map[0] + env.offset)) t.attrJoin("class", marks.get(t.map[0] + env.offset));
        if (t.type !== "inline" || !t.children) return;
        // A task item: "[ ] text" or "[x] text" as the first words of a list item.
        const item = tokens[i - 1] && tokens[i - 1].type === "paragraph_open" && tokens[i - 2] && tokens[i - 2].type === "list_item_open" ? tokens[i - 2] : null;
        const first = t.children[0], task = item && first && first.type === "text" && first.content.match(/^\[([ xX])\]\s+/);
        if (task) { first.content = first.content.slice(task[0].length); item.attrJoin("class", task[1] === " " ? "task" : "task done"); }
        t.children = breaks(state, links(state, t.children));
        if (t.map) t.children = marked(state, t.children, t.map[0] + env.offset, marks);
      });
    });

    const squash = text => text.replace(/\s+/g, " ").trim();
    const environment = (opts = {}) => {
      const marks = new Map();
      for (const n of opts.reminder || []) marks.set(n, "reminder");
      for (const n of opts.ask || []) marks.set(n, "ask");
      return { marks, doc: Boolean(opts.doc), offset: opts.offset || 0, headings: [] };
    };

    // The HTML of a markdown text. ask and reminder are the line numbers (from 0) the reply's own lines mark; doc is a whole
    // document, with real heading levels (listed, each with the id its heading gets, for the contents list) and a front matter
    // box when it opens with one. Returns { html, headings: [{ level, id, text }] }.
    function render(text, opts = {}) {
      let body = String(text), front = "", offset = 0;
      if (opts.doc) {
        const lines = body.split("\n");
        const close = lines[0].trim() === "---" ? lines.findIndex((line, n) => n && line.trim() === "---") : -1;
        if (close > 0) { front = codeBox("front matter", lines.slice(1, close).join("\n")); body = lines.slice(close + 1).join("\n"); offset = close + 1; }
      }
      const env = environment({ ...opts, offset });
      const html = front + md.render(body, env);
      return { html, headings: env.headings };
    }
    // One line of markdown drawn inline, with no block around it (an asked line, a status summary).
    const inline = text => md.renderInline(String(text), environment());
    // What a text reads as once drawn: the markers gone, a link as its label and its address, code as written, a table
    // without its pipes, spaces squeezed. The search matches on this (find.js).
    function plain(text) {
      const out = [];
      for (const t of md.parse(String(text), environment())) {
        if (t.type === "inline") out.push(inlineText(t.children, true));
        else if (t.type === "fence" || t.type === "code_block") out.push(t.content);
      }
      return squash(out.join(" "));
    }
    return { render, inline, plain };
  })();
