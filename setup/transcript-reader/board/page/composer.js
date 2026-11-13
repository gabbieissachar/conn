  // ---------------------------------------------------------------- the message box of the Tasks page's card view (board/page/composer.js)
  // board.js (the server side) pastes this into the page's script after the reader's own live.js (the pointer words, the pane list), undosend.js (the
  // Undo window and what the faded message says) and commentkey.js. It is the conversation view's message dock for the card view, kept to the same
  // behaviour and the same words: a comment on a reply or on a selected passage of it points at the reply ("Re your reply at 10:00 (...), the part
  // "...": your words"), comments wait together in a batch that goes as one numbered message, Send holds the message for UNDO_SECONDS with the box locked
  // so Undo can say it never left (Send turns into Undo, Add into Now, Enter sends now, Esc takes it back), and a message in flight is a faded one with
  // the same buttons. Enter sends, Shift+Enter starts a line, Cmd/Ctrl+Enter adds to the batch.
  // What it does not do: photos (the conversation view's attach button), the hosted copy's queue (the board is loopback only), and a held message
  // surviving a reload (the draft does; the box keeps its words through the window).
  // The send itself is the board's flagged route (`host.send`), which runs the reader's own guarded Send: the same checks of the pane, its foreground
  // session and Herdr's state, so a refusal reads the same. With the flag off the box still drafts, quotes, batches and copies, and says why Send is off.
  const boardComposer = (host) => {
    const MAX_SEND = 4000, SENDABLE = new Set(["idle", "working", "done"]), CLEAR_ASK_MS = 6000, FOLD_AT = 90, POLL_MS = 3000, PENDING_KEEP_S = 120;
    const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const button = (text, cls, title) => { const b = make("button", cls, text); b.type = "button"; if (title) b.title = title; return b; };
    const stored = (store, key) => { try { return JSON.parse(store.getItem(key) || "null"); } catch (e) { return null; } };
    const keep = (store, key, value) => { try { store.setItem(key, JSON.stringify(value)); } catch (e) { /* kept until the page reloads */ } };
    const drafts = stored(sessionStorage, "tb-drafts") || {};
    const batches = stored(sessionStorage, "tb-batches") || {};
    // Open on a screen with room; folded on a phone (a quote opens it), until the owner chooses in this browser.
    let open = !matchMedia("(max-width: 440px)").matches;
    try { const chosen = localStorage.getItem("tb-cmp-open"); if (chosen === "1" || chosen === "0") open = chosen === "1"; } catch (e) { /* the default */ }
    const touch = matchMedia("(pointer: coarse)");

    const link = { quote: null, editing: null, hold: null, sending: false, flight: null, result: null, batchOpen: false, preview: false, clearing: null,
      pending: [], foldOpen: false, panes: undefined, batchSig: "", resultTimer: 0 };
    const clock = { now: () => Date.now() / 1000, after: (ms, fn) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h) };
    const sendHold = makeSendHold(clock);
    // A command that ends or resets the session asks in the page first (commandAsk, undosend.js), never with confirm(): a web view with no dialog answers "no".
    const commandAsk = makeCommandAsk(clock, () => render());
    let holdTimer = 0, pollTimer = 0, attached = false;
    const targets = new WeakMap();  // a reply's box -> its builder: passage => { sid, title, passage, pointer(p) }

    // ---- the box
    const root = make("section", "cmp"); root.setAttribute("aria-label", "Message the supervisor");
    const bar = make("div", "cmp-bar");
    const toggle = button("", "cmp-toggle"); toggle.setAttribute("aria-controls", "cmp-body");
    const barSay = make("span", "cmp-say"); const barUndo = button("Undo", "cmp-barundo", "Take the message back before it is sent (Esc)"); barUndo.hidden = true;
    bar.append(toggle, barUndo); root.append(bar);
    const body = make("div", "cmp-body"); body.id = "cmp-body"; root.append(body);
    const pendingBox = make("div", "cmp-pending-list"); pendingBox.hidden = true;
    const batchBox = make("div", "cmp-batch"); batchBox.hidden = true;
    const batchHead = make("div", "cmp-head"), batchToggle = button("", "cmp-batchtoggle"), batchClear = button("Clear all", "cmp-linkbtn"), batchKeep = button("Keep", "cmp-linkbtn");
    batchKeep.hidden = true; batchHead.append(batchToggle, batchClear, batchKeep);
    const batchList = make("ol"); batchBox.append(batchHead, batchList);
    const previewBox = make("div", "cmp-preview"); previewBox.hidden = true;
    const previewText = make("div", "cmp-line"); previewBox.append(make("div", "cmp-label", "Sends exactly:"), previewText);
    const chip = make("div", "cmp-chip"); chip.hidden = true;
    const chipHead = make("div", "cmp-head"), chipTitle = make("span"), chipDrop = button("✕", "cmp-x", "Drop the pointer and write a plain message"); chipDrop.setAttribute("aria-label", "Drop the pointer");
    chipHead.append(chipTitle, chipDrop);
    const passageRow = make("div", "cmp-passage"), passageText = make("span"); passageRow.append(passageText);
    const chipLabel = make("div", "cmp-label"), chipLine = make("div", "cmp-line");
    chip.append(chipHead, passageRow, chipLabel, chipLine);
    const acts = make("div", "cmp-acts"), why = make("span", "cmp-why"), count = make("span", "cmp-count"), exactBtn = button("Exact text", "cmp-linkbtn"), copyBtn = button("Copy", "cmp-linkbtn", "Copy exactly what Send would type");
    acts.append(why, count, exactBtn, copyBtn);
    const row = make("div", "cmp-row");
    const text = make("textarea"); text.rows = 1; text.setAttribute("autocomplete", "off");
    const addBtn = button("Add", "alt"), sendBtn = button("Send", "go");
    row.append(text, addBtn, sendBtn);
    body.append(pendingBox, batchBox, previewBox, chip, acts, row);
    const floater = button("Comment on this", "cmp-float", "Quote the selected words in a message (Cmd+Enter / Ctrl+Enter)"); floater.hidden = true;
    document.body.append(floater);

    // ---- what the box writes to
    const here = () => host.target();                 // { sid, name } | null: the conversation the message goes to
    const sid = () => (here() || {}).sid || "";
    const name = () => (here() || {}).name || "the supervisor";
    const batchOf = (id) => batches[id] || [];
    const saveBatch = (id, items) => { if (items.length) batches[id] = items; else delete batches[id]; keep(sessionStorage, "tb-batches", batches); };
    const typed = () => text.value.trim();
    const quotePointer = () => link.quote.pointer(link.quote.passage);
    const message = () => { const t = typed(); return !t ? "" : link.quote && !t.startsWith("/") ? quotePointer() + t : t; };
    const itemText = (item) => item.pointer + item.typed;
    const sameItem = (a, b) => a && b && a.title === b.title && a.passage === b.passage && a.typed === b.typed && a.pointer === b.pointer && a.bare === b.bare;
    const withoutSent = (items, sent) => { const rest = items.slice(); for (const w of sent || []) { const at = rest.findIndex((i) => sameItem(i, w)); if (at >= 0) rest.splice(at, 1); } return rest; };
    const boxPlace = (id, n) => link.editing && link.editing.sid === id ? Math.min(link.editing.index, n) : n;
    const frozen = (saved) => ({ title: saved.title, passage: saved.passage, pointer: (p) => (p ? saved.pointer : saved.bare) });

    // What Send types: the batch's comments, numbered, with what is in the box last (or in its place while one is edited), as in the conversation view.
    function outgoing() {
      const id = sid(); if (!id) return "";
      const parts = batchOf(id).map(itemText), current = message();
      if (current) parts.splice(boxPlace(id, parts.length), 0, current);
      if (parts.length < 2) return parts[0] || "";
      return `${parts.length} comments:\n\n` + parts.map((t, i) => `${i + 1}. ${t}`).join("\n\n");
    }
    function saveDraft() {
      const id = sid(); if (!id) return;
      const t = text.value, q = link.quote;
      if (t.trim() || q) drafts[id] = { text: t, quote: q && { title: q.title, passage: q.passage, pointer: q.pointer(q.passage), bare: q.pointer("") }, editing: link.editing && link.editing.sid === id ? link.editing.index : null };
      else delete drafts[id];
      keep(sessionStorage, "tb-drafts", drafts);
    }
    const grow = () => { text.style.height = "auto"; text.style.height = Math.min(text.scrollHeight + 2, parseFloat(getComputedStyle(text).lineHeight || "20") * 6 + 14) + "px"; };
    const say = (ok, msg, ms) => { link.result = { ok, text: msg }; clearTimeout(link.resultTimer); if (ms) link.resultTimer = setTimeout(() => { if (link.result && link.result.ok === ok && link.result.text === msg) { link.result = null; render(); } }, ms); };
    const heldHere = () => Boolean(link.hold && link.hold.sid === sid());

    // ---- a comment on a reply, or on a passage of it. A comment already written against another pointer goes into the batch first.
    function openQuote(target) {
      if (link.hold) { say(false, heldHere() ? "The message is in its Undo window. Undo it first, or wait a moment." : "Another message is in its Undo window. Wait a moment."); render(); return; }
      const t = typed();
      const queued = Boolean(link.quote && t && !t.startsWith("/")) && addToBatch();
      link.quote = target; link.foldOpen = false;
      if (queued) say(true, `The last comment went into the batch (${batchOf(sid()).length}).`, 6000); else link.result = null;
      saveDraft(); hideFloat(); open = true; render(); text.focus();  // opened for this comment; the owner's own choice (the bar) is what is kept
    }
    function dropQuote() { if (heldHere()) return; link.quote = null; saveDraft(); render(); }
    function addToBatch() {
      const id = sid(), t = typed();
      if (!id || !t || link.hold) return false;
      if (t.startsWith("/")) { say(false, "A command goes on its own, so it cannot join a batch."); render(); return false; }
      const q = link.quote;
      const item = { title: q ? q.title : "Message", passage: q ? q.passage : "", typed: t, pointer: q ? quotePointer() : "", bare: q ? q.pointer("") : "" };
      const items = batchOf(id).slice();
      items.splice(boxPlace(id, items.length), 0, item);
      saveBatch(id, items);
      link.editing = null; text.value = ""; link.quote = null; saveDraft(); grow();
      say(true, `Added to the batch (${items.length}). Send sends them all.`);
      render(); return true;
    }
    function editItem(i) {
      const id = sid(); if (!id || link.hold) return;
      if (typed()) { say(false, "Add or clear what is in the box first."); render(); return; }
      const items = batchOf(id).slice(), [item] = items.splice(i, 1);
      saveBatch(id, items);
      link.editing = { sid: id, index: i }; link.quote = item.pointer ? frozen(item) : null;
      text.value = item.typed; saveDraft(); grow(); link.result = null; render(); text.focus();
    }
    function removeItem(i) {
      const id = sid(); if (!id || link.hold) return;
      const items = batchOf(id).slice(); items.splice(i, 1); saveBatch(id, items);
      if (link.editing && link.editing.sid === id && link.editing.index > i) link.editing.index -= 1;
      render();
    }
    // "Clear all" asks in the page, never with confirm(): the first press arms it, the second removes the batch (the conversation view's rule).
    const armed = (id, n) => Boolean(link.clearing) && link.clearing.sid === id && link.clearing.n === n;
    function disarm() { if (link.clearing) { clearTimeout(link.clearing.timer); link.clearing = null; } }
    batchClear.addEventListener("click", () => {
      const id = sid(), items = batchOf(id); if (!id || !items.length || link.hold) return;
      if (armed(id, items.length)) { disarm(); saveBatch(id, []); link.editing = null; say(true, "Batch cleared."); render(); return; }
      disarm(); link.clearing = { sid: id, n: items.length, timer: setTimeout(() => { link.clearing = null; render(); }, CLEAR_ASK_MS) }; render();
    });
    batchKeep.addEventListener("click", () => { disarm(); render(); });
    batchToggle.addEventListener("click", () => { link.batchOpen = !link.batchOpen; link.batchSig = ""; render(); });
    exactBtn.addEventListener("click", () => { link.preview = !link.preview; render(); });

    // ---- sending
    // Send holds the message in the page for UNDO_SECONDS with the box locked, then asks the server. Until then nothing has left the page.
    const heldMessage = (h) => ({ text: h.text, label: name(), at: h.at });
    function paintHold() { if (link.hold) render(); }
    function endHold() { link.hold = null; clearInterval(holdTimer); holdTimer = 0; }
    function undoHold() {
      if (!sendHold.undo()) return;
      endHold(); say(true, "Undone: it was never sent. Your message is still in the box.", 6000); render(); text.focus();
    }
    const sendNow = () => sendHold.release();
    function sendDock() {
      if (link.hold) return;
      const out = outgoing(); if (!out || sendBtn.disabled) return;
      const id = sid();
      if (commandAsk.press(id, out) === "ask") { render(); return; }
      const sentItems = batchOf(id).slice(), sentBox = text.value, pointed = Boolean(link.quote), at = clock.now();
      const hold = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, sid: id, text: out, at, deadline: at + UNDO_SECONDS, sentItems, sentBox, pointed };
      const begun = sendHold.begin(() => { endHold(); deliver({ sid: id, text: out, sentItems, sentBox }); }, UNDO_SECONDS, hold);
      if (!begun) { say(false, "Another message is still in its Undo window. Wait a moment."); render(); return; }
      link.hold = hold; link.result = null; holdTimer = setInterval(paintHold, 500); render();
    }
    // The moment a send leaves the page, what it carries comes out of the box, the pointer and the batch; the returned function puts it all back for a
    // send that fails (into the box when it is empty, else into the batch, so nothing typed meanwhile is overwritten).
    function takeSent({ sid: id, sentItems, sentBox }) {
      const same = id === sid(), saved = drafts[id], quote = link.quote, editing = link.editing;
      let boxTaken = false;
      if (same && text.value === sentBox) { text.value = ""; link.editing = null; link.quote = null; saveDraft(); grow(); boxTaken = true; }
      else if (saved && saved.text === sentBox) { delete drafts[id]; keep(sessionStorage, "tb-drafts", drafts); boxTaken = true; }
      if (sentItems.length) saveBatch(id, withoutSent(batchOf(id), sentItems));
      return () => {
        if (sentItems.length) saveBatch(id, sentItems.concat(batchOf(id)));
        if (!boxTaken) return;
        if (id === sid() && !text.value && !link.quote) { text.value = sentBox; link.quote = quote; link.editing = editing; saveDraft(); grow(); return; }
        if (sentBox.trim()) saveBatch(id, batchOf(id).concat({ title: "Message", passage: "", typed: sentBox, pointer: "", bare: "" }));
      };
    }
    async function deliver({ sid: id, text: out, sentItems, sentBox }) {
      const at = clock.now();
      link.sending = true; link.result = null; link.flight = { sid: id, text: out };
      const putBack = takeSent({ sid: id, sentItems, sentBox }); render();
      try {
        const sent = await host.send(id, out);
        say(true, `Sent to ${sent.label || name()} at ${fmtClock(at)}.`, 4000);
        link.pending.push({ sid: id, text: out, at, label: sent.label || name(), agent: sent.status });
        link.flight = null;
      } catch (e) { link.flight = null; say(false, e.message); putBack(); }
      link.sending = false; render();
    }
    // A message the pane has, shown until it is dismissed (the card's thread is not the session's log, so the box cannot see it land): the wording of
    // the conversation view's faded message, without the buttons that no longer apply once it is out of the page.
    function giveBack(p, said) {
      link.pending = link.pending.filter((x) => x !== p);
      const id = p.sid;
      if (!text.value.trim() && !link.quote && id === sid()) { text.value = p.text; link.editing = null; saveDraft(); grow(); say(true, `${said} It is in the box.`, 8000); }
      else { saveBatch(id, batchOf(id).concat({ title: "Message", passage: "", typed: p.text, pointer: "", bare: "" })); say(true, `${said} It is in the batch.`, 8000); }
      render();
    }
    const fmtClock = (s) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(s * 1000));
    function pendingNode(p, held) {
      const d = describeSend(p, { hold: held ? { left: sendHold.left() } : null, flight: p.flight || null, t: fmtClock, now: clock.now });
      const node = make("div", "cmp-pending" + (d.stage === "refused" ? " refused" : "")), head = make("div", "cmp-head");
      const sayEl = make("span", "cmp-pendsay", d.say);
      head.append(make("b", "", "You"), sayEl);
      const act = (label, cls, title, run) => { const b = button(label, "cmp-pendbtn" + cls, title); b.addEventListener("click", run); head.append(b); };
      if (d.actions.includes("undo")) act("Undo", " undo", "Take it back before it is sent (Esc)", undoHold);
      if (d.actions.includes("now")) act("Send now", "", "Skip the wait and send it", sendNow);
      if (!held && !p.flight) act("Dismiss", "", "", () => { link.pending = link.pending.filter((x) => x !== p); render(); });
      node.append(head); if (d.hint) node.append(make("div", "cmp-hint", d.hint));
      node.append(make("div", "cmp-pendtext", p.text));
      return node;
    }

    // ---- the pane: whether Send can work, and the words when it cannot
    async function poll() {
      try { const s = await live.state(false); link.panes = s.panes || {}; } catch (e) { if (link.panes === undefined) link.panes = {}; }
      render();
    }
    const paneOf = () => (link.panes ? link.panes[sid()] || null : null);
    function whyOff(out, command, batch) {
      if (!host.sendOn()) return "Sending from the board is off in this reader (PMOS_READER_BOARD_SEND=1 turns it on). Copy still works.";
      if (!sid()) return "No conversation of this board's supervisor was found, so there is no one to send to. Copy still works.";
      if (link.panes === undefined) return "Connecting to the local server…";
      const pane = paneOf();
      if (!pane) return "No live Herdr pane runs this session. Copy still works.";
      if (pane.status === "blocked") return `${pane.label} is at a permission prompt or question. Answer it in Herdr first.`;
      if (!SENDABLE.has(pane.status)) return `Herdr cannot tell what ${pane.label} is doing (it may be suspended to a shell). Check the pane first.`;
      if (batch && command) return "A command goes on its own: send the batch first, or clear it.";
      if (link.hold && link.hold.sid !== sid()) return `Send is back when ${name()}'s Undo window ends.`;
      return "";
    }

    // ---- drawing
    function fillLine(pointer, t, command, full) {
      if (!t || command || pointer.length <= FOLD_AT) { chipLine.replaceChildren(full || pointer + "…"); return; }
      const fold = button(link.foldOpen ? pointer : pointer.slice(0, 60).trimEnd() + "… ▸", "cmp-fold", link.foldOpen ? "Fold the pointer" : "Show the whole pointer");
      fold.setAttribute("aria-expanded", String(Boolean(link.foldOpen)));
      fold.addEventListener("click", () => { link.foldOpen = !link.foldOpen; render(); });
      chipLine.replaceChildren(fold, t);
    }
    let lastSid = null;
    function render() {
      const id = sid(), n = name();
      if (id !== lastSid) {  // another conversation: its own draft and batch
        lastSid = id; link.result = null; link.batchOpen = false; link.batchSig = ""; disarm();
        const d = (id && drafts[id]) || { text: "" };
        link.quote = d.quote ? frozen(d.quote) : null; link.editing = d.editing != null ? { sid: id, index: d.editing } : null;
        text.value = d.text || ""; grow();
      }
      const batch = batchOf(id), out = outgoing(), command = typed().startsWith("/"), held = heldHere(), over = out.length > MAX_SEND;
      commandAsk.sync(id, out);
      const asking = held ? "" : commandAsk.open(id, out);  // a /clear or the like asked about: Send reads Confirm and Add reads Keep until it is answered
      const elsewhere = Boolean(link.hold && link.hold.sid !== id), pane = paneOf();
      const off = whyOff(out, command, batch.length);
      text.placeholder = `Message ${n}`; text.setAttribute("aria-label", `Message ${n}`); text.readOnly = held;
      // the bar: always there, the whole box folds into it
      toggle.textContent = ""; toggle.append(make("span", "cmp-chev"), make("b", "", `Message ${n}`));
      toggle.setAttribute("aria-expanded", String(open));
      const bits = [];
      if (held) bits.push(`sending in ${sendHold.left()} s`);
      else if (host.sendOn() && pane) bits.push(`${pane.status}`);
      else if (!host.sendOn()) bits.push("send is off");
      if (batch.length) bits.push(`${batch.length} in the batch`);
      if (!open && (typed() || link.quote) && !held) bits.push("draft");
      barSay.textContent = bits.join(" · "); toggle.append(barSay);
      barUndo.hidden = !held || open;
      body.hidden = !open; root.classList.toggle("shut", !open);
      // pending messages (held, on their way, sent)
      const nodes = link.pending.filter((p) => p.sid === id).map((p) => pendingNode(p, false));
      if (link.hold && link.hold.sid === id) nodes.push(pendingNode(heldMessage(link.hold), true));
      else if (link.flight && link.flight.sid === id) nodes.push(pendingNode({ ...link.flight, at: clock.now(), label: n, flight: "pane" }, false));
      pendingBox.hidden = !nodes.length; pendingBox.replaceChildren(...nodes);
      // the batch
      batchBox.hidden = !batch.length;
      if (!batch.length) { link.batchOpen = false; disarm(); if (link.batchSig) { batchList.replaceChildren(); link.batchSig = ""; } }
      const isArmed = armed(id, batch.length), sig = JSON.stringify([id, link.batchOpen, batch, Boolean(link.hold), isArmed]);
      if (batch.length && sig !== link.batchSig) {
        link.batchSig = sig;
        batchClear.textContent = isArmed ? `Remove ${batch.length === 1 ? "it" : "all " + batch.length}?` : "Clear all"; batchClear.classList.toggle("armed", isArmed); batchKeep.hidden = !isArmed;
        batchToggle.textContent = `${link.batchOpen ? "▾" : "▸"} Batch · ${batch.length} comment${batch.length === 1 ? "" : "s"} to send together`; batchToggle.setAttribute("aria-expanded", String(link.batchOpen));
        batchList.hidden = !link.batchOpen;
        batchList.replaceChildren(...batch.map((item, i) => {
          const li = make("li"), what = make("div", "what");
          what.append(make("small", "", item.pointer ? item.pointer.replace(/^\[From [^\]]*\]\s*/, "").replace(/:\s*$/, "") : "Plain message"), make("span", "", item.typed)); what.title = itemText(item);
          const edit = button("Edit", "", "Put this comment back in the box"), drop = button("✕", ""); drop.setAttribute("aria-label", `Remove comment ${i + 1}`);
          edit.disabled = drop.disabled = Boolean(link.hold);
          edit.addEventListener("click", () => editItem(i)); drop.addEventListener("click", () => removeItem(i));
          li.append(make("span", "n", `${i + 1}.`), what, edit, drop); return li;
        }));
      }
      exactBtn.hidden = !batch.length; exactBtn.textContent = link.preview ? "Hide exact text" : "Exact text"; exactBtn.setAttribute("aria-expanded", String(link.preview && Boolean(batch.length)));
      previewBox.hidden = !link.preview || !batch.length; previewText.textContent = out;
      // the pointer
      const q = link.quote; chip.hidden = !q;
      if (q) {
        chipTitle.textContent = q.title; passageRow.hidden = !q.passage; passageText.textContent = q.passage ? `“${q.passage}”` : "";
        chipLabel.textContent = command ? "Sends exactly (a command goes alone, without the pointer):" : batch.length ? `Comment ${boxPlace(id, batch.length) + 1} reads:` : "Sends exactly:";
        fillLine(quotePointer(), typed(), command, message());
      }
      // the buttons
      const total = batch.length + (typed() ? 1 : 0);
      sendBtn.disabled = held ? false : Boolean(off) || link.sending || !out || over;
      sendBtn.classList.toggle("undo", held);
      sendBtn.title = held ? "Take the message back before it is sent (Esc)" : asking ? `Send ${asking} now (Enter)` : "Send to the session's Herdr pane (Enter; Shift+Enter for a new line)";
      sendBtn.textContent = held ? `Undo ${sendHold.left()}` : asking ? `Confirm ${asking}` : batch.length ? `Send ${total}` : "Send";
      addBtn.disabled = held || asking ? false : link.sending || elsewhere || !typed() || command;
      addBtn.textContent = held ? "Now" : asking ? "Keep" : "Add";
      addBtn.title = held ? "Send this message now (Enter; Cmd+Enter or Ctrl+Enter)" : asking ? "Do not send the command (Esc)" : "Add to the batch and write the next comment (Cmd+Enter or Ctrl+Enter)";
      addBtn.setAttribute("aria-label", held ? "Send this message now" : asking ? "Do not send the command" : "Add to the batch and write the next comment");
      copyBtn.disabled = !out;
      count.hidden = out.length <= 3500; count.textContent = `${out.length.toLocaleString()} / ${MAX_SEND.toLocaleString()}`; count.classList.toggle("bad", over);
      why.classList.toggle("bad", !held && !asking && !elsewhere && (Boolean(link.result && !link.result.ok) || Boolean(off && pane && host.sendOn())));
      why.textContent = held ? `Sending in ${sendHold.left()} s · Undo takes it back` : asking ? commandAsk.words(n, out) : link.result ? link.result.text : off || (pane ? `To ${pane.label} · ${pane.status}${link.sending ? " · sending…" : ""}` : "");
    }

    // ---- keys and buttons
    text.addEventListener("input", () => { link.result = null; grow(); saveDraft(); render(); });
    text.addEventListener("keydown", (e) => {
      if (heldHere()) {  // in the Undo window the box is locked: Esc takes the message back, Enter sends it now
        if (e.isComposing) return;
        if (e.key === "Escape") { e.preventDefault(); undoHold(); }
        else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendNow(); }
        else if (e.key === "Enter") e.preventDefault();
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); addToBatch(); return; }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch.matches) { e.preventDefault(); sendDock(); }
      if (e.key === "Escape") { e.stopPropagation(); if (askingHere()) keepCommand(); else if (link.quote) dropQuote(); else text.blur(); }
    });
    // The question a /clear asks (commandAsk): open for the text in the box, in the conversation on screen. Keep, or Esc, leaves the command unsent.
    const askingHere = () => Boolean(commandAsk.open(sid(), outgoing()));
    const keepCommand = () => { commandAsk.close(); render(); text.focus(); };
    sendBtn.addEventListener("click", () => { if (heldHere()) undoHold(); else sendDock(); });
    addBtn.addEventListener("click", () => { if (heldHere()) sendNow(); else if (askingHere()) keepCommand(); else { addToBatch(); text.focus(); } });
    barUndo.addEventListener("click", undoHold);
    chipDrop.addEventListener("click", dropQuote);
    copyBtn.addEventListener("click", async () => { const out = outgoing(); if (!out) return; const ok = await replyViewCopy(out); say(ok, ok ? "Copied." : "Copy failed.", 3000); render(); });
    const replyViewCopy = (t) => replyView.copyText(t);
    function setOpen(on) { open = on; try { localStorage.setItem("tb-cmp-open", on ? "1" : "0"); } catch (e) { /* kept for this page */ } render(); }
    toggle.addEventListener("click", () => { setOpen(!open); if (open) text.focus(); });

    // ---- comment on a selected passage: the floating button, and Cmd/Ctrl+Enter (the conversation view's)
    const selectedPassage = (card) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !card.contains(sel.anchorNode) || !card.contains(sel.focusNode)) return "";
      return sel.toString().trim();
    };
    const cardOf = (node) => { let n = node && (node.nodeType === 1 ? node : node.parentElement); while (n) { if (targets.has(n)) return n; n = n.parentElement; } return null; };
    function hideFloat() { floater.hidden = true; }
    function placeFloat() {
      const sel = window.getSelection();
      if (!attached || !sel || sel.isCollapsed || !sel.rangeCount) { hideFloat(); return; }
      const card = cardOf(sel.anchorNode); if (!card || cardOf(sel.focusNode) !== card || !sel.toString().trim()) { hideFloat(); return; }
      const r = sel.getRangeAt(0).getBoundingClientRect(); if (!r.width && !r.height) { hideFloat(); return; }
      floater.hidden = false; const w = floater.offsetWidth || 120;
      floater.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
      floater.style.top = Math.max(8, r.top - (floater.offsetHeight || 30) - 8) + "px";
      floater.dataset.card = "1"; floater.cardNode = card;
    }
    let floatFrame = 0;
    document.addEventListener("selectionchange", () => { cancelAnimationFrame(floatFrame); floatFrame = requestAnimationFrame(placeFloat); });
    floater.addEventListener("mousedown", (e) => e.preventDefault());  // pressing it must not clear the selection it quotes
    floater.addEventListener("click", () => { const card = floater.cardNode; if (card) quote(card); });
    document.addEventListener("keydown", (e) => {
      if (!attached || !commentKey.pressed(e)) return;
      const sel = window.getSelection(); if (!sel || sel.isCollapsed) return;
      const card = cardOf(sel.anchorNode); if (!card) return;
      e.preventDefault(); quote(card);
    });
    // The Reply button of a reply, or a selection in it: a pointer at the reply, with the selected words when there are any.
    function quote(card) { const build = targets.get(card); if (build) openQuote(build(selectedPassage(card))); }

    // ---- the page uses it
    function attach(parent) {
      const focused = document.activeElement === text, from = text.selectionStart, to = text.selectionEnd;
      parent.append(root); attached = true; render();
      if (focused) { text.focus(); try { text.setSelectionRange(from, to); } catch (e) { /* not selectable */ } }
      if (!pollTimer && host.sendOn()) { poll(); pollTimer = setInterval(poll, POLL_MS); }  // the pane is only asked about when Send can be on
    }
    function detach() { attached = false; hideFloat(); clearInterval(pollTimer); pollTimer = 0; if (root.parentNode) root.remove(); }
    window.addEventListener("beforeunload", (e) => { if (link.hold || link.sending) { e.preventDefault(); e.returnValue = ""; } });
    if (window.visualViewport) {  // a phone's keyboard shrinks the visual viewport: the card's sheet rides above it
      const lift = () => { const sheet = document.querySelector(".sheet"); if (sheet && attached) sheet.style.bottom = Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop) + "px"; };
      visualViewport.addEventListener("resize", lift); visualViewport.addEventListener("scroll", lift);
    }
    return {
      node: root, attach, detach, render, quote, hold: () => Boolean(link.hold || link.sending),
      bind: (node, build) => targets.set(node, build), selectedPassage, text: () => text, state: () => link,
    };
  };
