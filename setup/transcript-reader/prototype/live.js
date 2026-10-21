  // ---------------------------------------------------------------- live link (live.js, shared by both pages)
  // build_prototype.write_page pastes this file into each page's script before hashing it.
  // Only a page served by setup/serve.sh on localhost can reach the server; a file:// page
  // stays read-only.
  const live = (() => {
    const API = "/api/transcript-reader/";
    const served = location.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    let token = null, header = null;
    async function connect() {
      const r = await fetch(API + "token", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || "The server refused the page.");
      token = j.token; header = j.header;
    }
    async function call(path, options = {}) {
      if (!served) throw new Error("Open the served page (reader.py prints its address) to send or follow.");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!token) await connect();
        const r = await fetch(API + path, { cache: "no-store", ...options, headers: { ...(options.headers || {}), [header]: token } });
        let j = null; try { j = await r.json(); } catch (e) { j = null; }
        // A restarted server hands out a new token: fetch it once and try again.
        if (r.status === 403 && attempt === 0 && j && /token/i.test(j.message || "")) { token = null; continue; }
        if (!r.ok) throw new Error((j && j.message) || `The server answered ${r.status}.`);
        return j;
      }
      throw new Error("The server refused the page.");
    }
    const state = follow => call("state" + (follow ? "?follow=1" : ""));
    const send = (sessionId, text) => call("send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId, text }) });
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
    const clip = (text, max) => { const t = text.replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t; };
    // The start of a message about one reply. It points at the reply (its time and opening
    // words) instead of copying it, because the session already holds the text.
    function pointer(at, reply, passage) {
      const opening = reply.split("\n").map(l => l.replace(/^[\s#>*\-\d.)|]+/, "").replace(/[*`_]/g, "").trim()).find(Boolean) || "";
      const when = new Date(at * 1000), today = new Date();
      const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(when);
      const day = when.toDateString() === today.toDateString() ? "" : new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(when) + " ";
      let text = `Re your reply at ${day}${time} ("${clip(opening, 60)}")`;
      if (passage) text += `, the part "${clip(passage, 100)}"`;
      return text + ": ";
    }
    return { served, state, send, poll, pointer };
  })();
