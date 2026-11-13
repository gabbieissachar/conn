  // ---------------------------------------------------------------- reply drawing for the Tasks page (board/page/replyview.js)
  // board.js (the server side) pastes this into the page's script after the reader's own markdown-it and markdown.js. A reply on a card is drawn by
  // markdownView, the renderer every reply of the conversation view goes through, into a box of the same shape (`div.md`, the CSS of markdown.css),
  // and clipped the way the reader clips one: past 90 words it shows the start behind a "Show full reply (N words)" button. Where the reader's page
  // keeps the clip open for good, the card's button turns back into "Show less". Nothing here touches the page's state: the page tells it what is open.
  // The text is markdown-it's output (raw HTML off, every piece escaped, only http(s) links), the same as in the reader, so it goes in as markup here.
  const replyView = (() => {
    const WORDS = 90;  // the reader's limit (clipped() in the conversation view); the server cuts a preview at the same size
    const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

    // A table wider than the reply scrolls inside its own box, with a shadow on the edge that has more behind it (the reader's tableCue).
    function tableCue(wrap) {
      const cue = make("div", "table-cue");
      wrap.replaceWith(cue); cue.append(wrap, make("span", "cue l"), make("span", "cue r"));
      const paint = () => {
        const room = wrap.scrollWidth - wrap.clientWidth;
        cue.classList.toggle("more-r", room > 1 && wrap.scrollLeft < room - 1);
        cue.classList.toggle("more-l", room > 1 && wrap.scrollLeft > 1);
      };
      wrap.addEventListener("scroll", paint, { passive: true });
      if (window.ResizeObserver) new ResizeObserver(paint).observe(wrap); else requestAnimationFrame(paint);
    }

    // The reply's markdown as the reader draws it: one `div.md`.
    function draw(markdown) {
      const drawn = markdownView.render(String(markdown || ""), { ask: [], reminder: [], doc: false });
      const box = make("div", "md");
      box.innerHTML = drawn.html;
      box.querySelectorAll(".table-wrap").forEach(tableCue);
      return box;
    }

    // A reply whole, or clipped behind its button. open: whether the reader asked for all of it; toggle(open) is told when the button is pressed (the page
    // keeps the choice across a redraw and fetches the rest of a long reply before it opens). busy: the rest is being fetched.
    function clipped(box, { words, open, busy, toggle }) {
      const wrap = make("div", "rmd");
      if (words <= WORDS && !open) { wrap.append(box); return wrap; }
      const inner = make("div", open ? "" : "clip"); inner.append(box); wrap.append(inner);
      const more = make("button", "more" + (open ? " less" : ""), busy ? "Loading the whole reply..." : open ? "Show less" : `Show full reply (${words} words)`);  // open: it sticks to the foot of the window while the reply is long, so the way back is always in reach
      more.type = "button"; more.setAttribute("aria-expanded", String(Boolean(open))); more.disabled = Boolean(busy);
      more.addEventListener("click", () => toggle(!open));
      wrap.append(more);
      return wrap;
    }

    // A code box's Copy button copies exactly the code shown (the reader's handler); a page opened over plain http falls back to a hidden text box.
    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* no clipboard permission: the fallback */ }
      const area = make("textarea"); area.value = text; area.setAttribute("readonly", ""); area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.append(area); area.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      area.remove(); return ok;
    }
    document.addEventListener("click", async (e) => {
      const button = e.target.closest && e.target.closest(".rmd button.copy");
      if (!button) return;
      const pre = button.parentElement.querySelector("pre"); if (!pre) return;
      const ok = await copyText(pre.textContent);
      button.dataset.label = ok ? "Copied" : "Copy failed";
      setTimeout(() => { button.dataset.label = "Copy"; }, 1500);
    });

    return { draw, clipped, copyText, WORDS };
  })();
