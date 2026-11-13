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

  // The copy waits a moment after the selection, so that "Comment on this" (a click, or Cmd/Ctrl+Enter) started in that moment leaves the
  // clipboard as it was: nothing was written, so there is nothing to take back. One pending job at a time; a new selection replaces it.
  //   arm(job)    wait <delay> ms, then run(job)          cancel()   drop it (a comment started)
  //   hold()      stop the clock, keep the job            release()  start the wait again (the pointer left the button)
  //   soon()      shorten the wait to <grace> ms          flush()    run it now
  // The timer functions and the clock are injected so selectcopy.test.js runs it without waiting.
  // onChange(event) tells the page what the wait is doing, so it can show it (the countdown chip). event.state is one of
  //   "armed" and "released"   the wait runs from a full ring: { from: 1, ms: <delay> }
  //   "soon"                   it is shortened: { from: <share of the delay still left>, ms: <grace> }
  //   "held"                   the clock stopped, the job kept
  //   "fired"                  the wait ran out or flush() was asked: { by: "timer" | "flush" }, the job is run next
  //   "cancelled"              the job was dropped: { reason } is what cancel(reason) was given ("comment" when none)
  // It is called after the state changed and never throws into the caller.
  function deferred(run, { delay = 800, grace = 250, setTimer, clearTimer, now, onChange } = {}) {
    const set = setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clear = clearTimer || (id => clearTimeout(id));
    const clock = now || (() => Date.now());
    const tell = event => { if (typeof onChange === "function") { try { onChange(event); } catch (e) { /* the page's drawing is not the copy's business */ } } };
    let job = null, timer = null, due = 0, held = false, by = "timer";
    const stop = () => { if (timer !== null) clear(timer); timer = null; };
    const fire = () => { const next = job; job = null; timer = null; held = false; if (next) { tell({ state: "fired", by }); by = "timer"; run(next); } };
    const start = ms => { stop(); due = clock() + ms; timer = set(fire, ms); };
    return {
      arm(next) { job = next; held = false; by = "timer"; start(delay); tell({ state: "armed", from: 1, ms: delay }); },
      cancel(reason = "comment") { const had = job !== null; stop(); job = null; held = false; if (had) tell({ state: "cancelled", reason }); return had; },
      hold() { if (job === null) return false; stop(); held = true; tell({ state: "held" }); return true; },
      release() { if (job === null || !held) return false; held = false; start(delay); tell({ state: "released", from: 1, ms: delay }); return true; },
      soon() {
        if (job === null || held) return false;
        const left = due - clock();
        if (left > grace) { start(grace); tell({ state: "soon", from: Math.max(0, Math.min(1, left / delay)), ms: grace }); }
        return true;
      },
      flush() { if (job === null) return false; stop(); by = "flush"; fire(); return true; },
      pending() { return job !== null; },
      held() { return job !== null && held; },
      // What is left of the wait in ms (0 when none is running), for a page that draws it from the middle.
      remaining() { return job === null || held || timer === null ? 0 : Math.max(0, due - clock()); },
    };
  }

  // The words on the countdown chip beside "Comment on this", and what a screen reader is told when it ends. With reduced motion no ring drains,
  // so the counting chip says "Copying" instead of "Copy".
  function chipLabel(phase, reducedMotion = false) {
    if (phase === "counting") return reducedMotion ? "Copying" : "Copy";
    if (phase === "paused") return "Copy paused";
    if (phase === "copied") return "\u2713 Copied";
    if (phase === "skipped") return "Not copied";
    return "";
  }
  const chipSpoken = phase => phase === "copied" ? "Copied" : phase === "skipped" ? "Not copied" : "";

  return { decide, isEditableTarget, copyArea, fallback, copy, deferred, chipLabel, chipSpoken };
})();
