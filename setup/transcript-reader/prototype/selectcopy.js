// The small, DOM-free decisions behind copy-on-select. The page supplies the DOM
// boundary and the browser APIs; this part keeps the behavior easy to test.
const readerSelectCopy = (() => {
  function decide({ text = "", collapsed = false, editable = false, eligible = true, signature = "" } = {}, previousSignature = null) {
    if (collapsed || !text || !text.trim()) return { copy: false, reason: "empty" };
    if (editable) return { copy: false, reason: "editable" };
    if (!eligible) return { copy: false, reason: "outside" };
    if (signature && signature === previousSignature) return { copy: false, reason: "repeat" };
    return { copy: true, text, signature: signature || text };
  }

  function element(node) {
    return node && (node.nodeType === 1 ? node : node.parentElement);
  }

  function isEditableTarget(node) {
    const el = element(node);
    return Boolean(el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'));
  }

  function copyArea(node) {
    const el = element(node);
    return el && el.closest ? el.closest("#main .reply, #main .input, #main .notes, #main .doc-body, #pins-panel .pins-list, #search-results") : null;
  }

  // This is deliberately synchronous when it takes the fallback. Plain HTTP
  // pages need execCommand while the mouse-up gesture is still active.
  function fallback(text, doc) {
    if (!doc || typeof doc.createElement !== "function") return false;
    const parent = doc.body || doc.documentElement;
    if (!parent) return false;
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.style.top = "0";
    area.style.opacity = "0";
    parent.appendChild(area);
    area.select();
    let ok = false;
    try { ok = Boolean(doc.execCommand && doc.execCommand("copy")); } catch (e) { ok = false; }
    if (typeof area.remove === "function") area.remove();
    else if (typeof parent.removeChild === "function") parent.removeChild(area);
    return ok;
  }

  function copy(text, { navigator: nav, document: doc, isSecureContext } = {}) {
    nav = nav || (typeof navigator !== "undefined" ? navigator : null);
    doc = doc || (typeof document !== "undefined" ? document : null);
    const secure = isSecureContext === undefined ? Boolean(nav && nav.clipboard) : isSecureContext;
    if (secure && nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
      try { return Promise.resolve(nav.clipboard.writeText(text)).then(() => true, () => false); } catch (e) { return Promise.resolve(false); }
    }
    return Promise.resolve(fallback(text, doc));
  }

  return { decide, isEditableTarget, copyArea, fallback, copy };
})();
