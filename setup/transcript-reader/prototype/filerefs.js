  // ---------------------------------------------------------------- markdown files named by their path (filerefs.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script, after sessionrefs.js. Pure functions, so filerefs.test.js runs them
  // without a page. A reply that names a markdown file by its absolute path ("/Users/me/notes/plan.md", in prose or alone in a code span) gets a
  // link on it (README.md, "Markdown files open in an editor"): the page draws it as <a class="file-ref" data-path="/abs/path.md">, which a host
  // such as Conn catches by that class and attribute and opens in its own editor. Only a path that starts at "/" counts: a "~/x.md" or "docs/x.md"
  // does not say which file, and a web address that ends in .md is a web address.
  //   scan(text)        the absolute .md paths in prose: [{ start, end, path }]
  //   whole(text)       the path a whole inline-code span is, or null (a command that holds a path stays a command)
  //   vscodeUrl(path)   the address that opens the file in VS Code from a plain browser
  const fileRefs = (() => {
    // One segment of a path: no space, quote, bracket, pipe, star, colon (a ":12" line number is not part of the file) or backslash.
    const SEG = "[^\\s`\"'<>()\\[\\]{}|*?\\\\:;,/]+";
    // A "/" that is not the end of a word, a path, a web address ("https://x/y.md": the first "/" follows a colon) or a "~/" path, then segments, then ".md" not followed by more of a name (a word, a "/", a "-" or a ".word": "plan.md.bak" is another file).
    const PATH = new RegExp(`(^|[^\\w/.~:@%-])(/(?:${SEG}/)*${SEG}\\.md)(?![\\w/-]|\\.\\w)`, "g");
    const WHOLE = /^\/[^\0<>"|?*\n]+\.md$/;
    const clean = path => !/(^|\/)\.\.?(\/|$)/.test(path) && !/\/\//.test(path);  // no "..", ".", or empty segment: that is not one file
    function scan(text) {
      const found = [];
      PATH.lastIndex = 0;
      for (let m = PATH.exec(text); m; m = PATH.exec(text)) {
        const start = m.index + m[1].length;
        if (clean(m[2])) found.push({ start, end: start + m[2].length, path: m[2] });
      }
      return found;
    }
    function whole(text) {
      const path = String(text);
      return WHOLE.test(path) && clean(path) ? path : null;
    }
    const vscodeUrl = path => "vscode://file" + path.split("/").map(encodeURIComponent).join("/");
    return { scan, whole, vscodeUrl };
  })();
