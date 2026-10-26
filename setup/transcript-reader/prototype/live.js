  // ---------------------------------------------------------------- live link (live.js, shared by both pages)
  // build_prototype.write_page pastes this file into each page's script before hashing it.
  // Only a page served by the reader's own server (setup/transcript-reader/serve.sh), on localhost
  // or on the Mac's Tailscale address (the phone, serve.sh --tailnet), can reach the server; a
  // file:// page stays read-only.
  const live = (() => {
    const API = "/api/transcript-reader/";
    // The server writes its per-start token into the page as it serves it (api.js);
    // no endpoint hands it out, so other pages on this origin cannot get it.
    const token = (document.querySelector('meta[name="reader-token"]') || {}).content || "";
    // Loopback is the reader's own server. Beyond it, only a Tailscale address (100.64.0.0/10, the one
    // other address the server listens on) counts, and only for a page that carries the token: a file
    // copy has none, and a page some other server hands out has no token the reader would accept.
    const served = location.protocol === "http:" && (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
      || (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(location.hostname) && /^[0-9a-f]{64}$/.test(token)));
    // A restarted server has a new token, which only a fresh load of the page brings:
    // reload once, unless a text box is being typed in or the last try was under a minute ago.
    function reloadForToken() {
      if (document.activeElement && document.activeElement.tagName === "TEXTAREA") return false;
      let last = 0;
      try { last = Number(sessionStorage.getItem("reader-token-reload")) || 0; } catch (e) { last = 0; }
      if (Date.now() - last < 60000) return false;
      try { sessionStorage.setItem("reader-token-reload", String(Date.now())); } catch (e) { /* reload anyway */ }
      location.reload();
      return true;
    }
    async function request(path, options = {}) {
      if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("This page has no server token: reload it from the address reader.py prints.");
      const r = await fetch(API + path, { cache: "no-store", ...options, headers: { ...(options.headers || {}), "x-transcript-reader-token": token } });
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      if (r.status === 403 && j && /token/i.test(j.message || "")) {
        throw new Error(reloadForToken() ? "Reconnecting to the restarted server…" : "The server restarted: reload the page to reconnect.");
      }
      // The tailnet listener signs a phone out when the server restarts or the passcode changes: a fresh load
      // of the page brings the sign-in page, and signing in comes back to this address (drafts survive a reload).
      if (r.status === 401 && j && j.code === "sign_in_required") {
        throw new Error(reloadForToken() ? "Signed out: opening the sign-in page…" : "Signed out: reload the page to sign in again.");
      }
      if (!r.ok) { const error = new Error((j && j.message) || `The server answered ${r.status}.`); error.status = r.status; throw error; }
      return j;
    }
    async function call(path, options = {}) {
      if (!served) throw new Error("Open the served page (reader.py prints its address) to send or follow.");
      return request(path, options);
    }
    const state = follow => call("state" + (follow ? "?follow=1" : ""));
    // The built page's current text, for a page that swaps in new turns without reloading.
    const page = name => call("page?name=" + encodeURIComponent(name)).then(j => j.html);
    const send = (sessionId, text) => call("send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId, text }) });
    // The Sync button: the server reads Herdr again and rebuilds the pages now, then answers like state, with when it finished.
    const sync = follow => call("sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ follow: Boolean(follow) }) });
    // An HTML file a reply names: the server checks it again and answers with the address to show it from, { url, name, size, mtime }.
    // It needs only a served page with its token, so it also works on the Tailscale address, where the page is not `served` as above.
    async function htmlOpen(id) {
      if (location.protocol !== "http:") throw new Error("Open the served page (reader.py prints its address) to see an HTML file.");
      return request("html-open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    }
    // The pinned messages the server keeps in its owner-only file (pins.js), and one change to them.
    const pinsList = () => call("pins");
    const pinsChange = change => call("pins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
    // Reopen a session whose pane has closed, to read it again, or close one; both answer once the page is rebuilt.
    const changeList = (command, sessionId) => call(command, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) });
    // tick runs every 2 seconds while the page is visible, and at once when it is shown again.
    function poll(tick) {
      if (!served) return;
      let busy = false;
      const run = async () => {
        if (busy || document.hidden) return;
        busy = true;
        try { await tick(); } catch (e) { /* the next tick tries again */ } finally { busy = false; }
      };
      setInterval(run, 2000);
      document.addEventListener("visibilitychange", run);
      run();
    }
    // Quoted words come from an agent's reply. Should the line ever land in a shell, `$`,
    // backticks and backslashes are what could run or escape there, so quotes drop them.
    const clip = (text, max) => { const t = text.replace(/[`$\\]/g, "").replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t; };
    // The start of a message about one reply. It points at the reply (its time and opening
    // words) instead of copying it, because the session holds the text. A session that no
    // longer holds it (cleared since, or compacted: `unheld`) gets what the reply asked, its
    // asking lines, or else the first few hundred characters in place of the opening words.
    function pointer(at, reply, passage, unheld = false, asks = []) {
      const opening = reply.split("\n").map(l => l.replace(/^[\s#>*\-\d.)|]+/, "").replace(/[*`_]/g, "").trim()).find(Boolean) || "";
      const when = new Date(at * 1000), today = new Date();
      const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(when);
      const day = when.toDateString() === today.toDateString() ? "" : new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(when) + " ";
      let text = `Re your reply at ${day}${time}`;
      if (!unheld) text += ` ("${clip(opening, 60)}")`;
      else if (asks.length) text += ` ("${clip(opening, 60)}"), which asked: "${clip(asks.map(a => a.replace(/[*_]/g, "")).join(" / "), 400)}"`;
      else text += `, which began: "${clip(reply.replace(/[*_#>|]/g, ""), 300)}"`;
      if (passage) text += `, the part "${clip(passage, 100)}"`;
      return text + ": ";
    }
    return { served, state, sync, pinsList, pinsChange, page, send, changeList, htmlOpen, poll, pointer, clip };
  })();
