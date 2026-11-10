  // ---------------------------------------------------------------- Campus conversations on the embed page (embed.js, DESIGN.md 2026-11-07)
  // build_prototype.fill_template pastes this file into the reader page's script, before selectcopy.js, in every mode; only the embed page
  // (out/live/embed.html, template mode "embed") uses it. It is the whole of what that page knows about the host's data: how the JSON a host
  // hands to window.readerEmbed is read, kept and turned into the turns the reader already draws (inputBlock and replyCard). It has no DOM,
  // no network and no model, so a vm sandbox can run it (embed.test.js). The contract it implements is README.md, "The embed page".
  //
  // The shape mirrors Conn's CampusTimeline.blocks() (helm, ConnCore/Campus/CampusTimeline.swift), so the host's side is a field-by-field copy:
  //   block  { kind: "user", id, text, at? }
  //          { kind: "reply", id, at?, texts: [markdown], tools: [tool], form?: form, stopped?, streaming? }
  //   tool   { tool, argument, output, status: "ok" | "failed" | "running" | "aborted", detail }     (CampusItem's tool fields)
  //          and, additive (a tool without them is drawn as before): title (the step row's words, "campus.search"), input (the whole input, to
  //          6000 characters, a cut one ends in a line "… N more characters not shown"), inputFormat "text" | "code" | "json", outputFormat "text" | "json"
  //   form   { id, status: "open" | "answered" | "cancelled", answer?, questions: [{ text, options: [string], pick? }] }   (CampusForm)
  // Reading is tolerant, as Conn's CampusJSON is: a block of an unknown kind or with nothing to show is skipped and counted, a field of the
  // wrong type is the empty one, and nothing a host sends can throw except text that is not JSON at all.
  const embedModel = (() => {
    const VERSION = 1;
    const STATUS = new Set(["ok", "failed", "running", "aborted"]);
    // opencode's tool names (and the few the reader's own tools use) in the kinds the reader's steps use.
    const TOOL_KINDS = {
      read: "read", write: "wrote", edit: "edited", multiedit: "edited", patch: "edited", apply_patch: "edited", notebookedit: "edited",
      bash: "ran", shell: "ran", command: "ran", exec: "ran",
      grep: "searched", glob: "searched", list: "searched", ls: "searched", find: "searched", search: "searched", codesearch: "searched",
      webfetch: "searched", websearch: "searched", fetch: "searched",
      task: "agent", agent: "agent", subagent: "agent", skill: "skill", question: "asked", ask: "asked",
    };
    const SUMMARY_CHARS = 140, COMMAND_CHARS = 600, INPUT_CHARS = 6000, FAIL_TAIL = 400;
    const text = v => typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
    // Seconds since the epoch; a host that sends milliseconds is read too.
    const epoch = v => typeof v === "number" && Number.isFinite(v) && v > 0 ? (v > 1e11 ? v / 1000 : v) : null;
    const clip = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
    const words = s => (s.match(/\S+/g) || []).length;

    function readForm(raw) {
      if (!raw || typeof raw !== "object") return null;
      const questions = (Array.isArray(raw.questions) ? raw.questions : []).map(q => {
        const t = q && typeof q === "object" ? text(q.text) : "";
        if (!t.trim()) return null;
        return { text: t, options: (Array.isArray(q.options) ? q.options : []).map(text).filter(o => o.trim()), pick: text(q.pick) || null };
      }).filter(Boolean);
      if (!questions.length) return null;
      return { id: text(raw.id), status: raw.status === "answered" || raw.status === "cancelled" ? raw.status : "open", answer: text(raw.answer), questions };
    }
    function readTool(raw) {
      if (!raw || typeof raw !== "object") return null;
      const inputFormat = ["text", "code", "json"].includes(raw.inputFormat) ? raw.inputFormat : "", outputFormat = ["text", "json"].includes(raw.outputFormat) ? raw.outputFormat : "";
      const made = { tool: text(raw.tool), argument: text(raw.argument), output: text(raw.output), status: STATUS.has(raw.status) ? raw.status : "ok", detail: text(raw.detail) };
      // The additive fields are there only when the host sent them, so a tool without them reads exactly as it always did.
      const title = text(raw.title), input = text(raw.input);
      if (title) made.title = title;
      if (input) made.input = input;
      if (input && inputFormat) made.inputFormat = inputFormat;
      if (outputFormat) made.outputFormat = outputFormat;
      return made;
    }
    // One block as the page keeps it, or null when it holds nothing to draw. seen: the ids already taken, so two blocks never share one.
    function readBlock(raw, index, seen) {
      if (!raw || typeof raw !== "object") return null;
      const kind = raw.kind === "user" ? "user" : raw.kind === "reply" || raw.kind === "assistant" ? "reply" : null;
      if (!kind) return null;
      let made;
      if (kind === "user") {
        const t = text(raw.text);
        if (!t.trim()) return null;
        made = { kind, text: t };
      } else {
        const texts = (Array.isArray(raw.texts) ? raw.texts : raw.text != null ? [raw.text] : []).map(text).filter(t => t.trim());
        const tools = (Array.isArray(raw.tools) ? raw.tools : []).map(readTool).filter(Boolean);
        const form = readForm(raw.form), stopped = raw.stopped === true;
        if (!texts.length && !tools.length && !form && !stopped) return null;
        made = { kind, texts, tools, form, stopped, streaming: raw.streaming === true };
      }
      let id = text(raw.id) || `${kind}-${index + 1}`;
      while (seen.has(id)) id += "'";
      seen.add(id);
      return { id, at: epoch(raw.at), ...made };
    }
    // What a host handed over, as { id, live, hasLive, blocks, skipped }: a JSON string, an object { id?, live?, blocks }, or a bare array of blocks.
    // hasLive says whether the working line was part of it (a call that does not mention it leaves the line as it is).
    function parse(input) {
      let raw = input;
      if (typeof raw === "string") raw = JSON.parse(raw);
      if (Array.isArray(raw)) raw = { blocks: raw };
      if (!raw || typeof raw !== "object") throw new TypeError("readerEmbed: expected { blocks, live }, an array of blocks, or their JSON");
      const seen = new Set(), blocks = [];
      let skipped = 0;
      (Array.isArray(raw.blocks) ? raw.blocks : []).forEach((b, i) => { const made = readBlock(b, i, seen); if (made) blocks.push(made); else skipped += 1; });
      return { id: text(raw.id), live: text(raw.live).trim(), hasLive: raw.live !== undefined, blocks, skipped };
    }
    // The blocks held with incoming ones put in: one with the id of a held block replaces it where it stands, any other goes on the end.
    function upsert(held, incoming) {
      const out = held.slice(), at = new Map(out.map((b, i) => [b.id, i]));
      for (const b of incoming) {
        if (at.has(b.id)) out[at.get(b.id)] = b;
        else { at.set(b.id, out.length); out.push(b); }
      }
      return out;
    }

    // The message bar's config as a host hands it (readerEmbed.composer): { name?, send?, reason? } or its JSON text; null, false, undefined or { off: true }
    // is no bar. Anything else that is not an object throws, as parse does.
    function composer(input) {
      let raw = input;
      if (typeof raw === "string") raw = JSON.parse(raw);
      if (raw === null || raw === undefined || raw === false) return null;
      if (typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("readerEmbed.composer: expected { name, send, reason }, its JSON, or null");
      if (raw.off === true) return null;
      return { name: clip(text(raw.name).trim(), 60) || "Campus", send: raw.send !== false, reason: clip(text(raw.reason).trim(), 200) };
    }

    // ---- the reader's turns, made from blocks
    const userTurn = b => ({ source: "captain", kind: "message", label: "You", input: b.text, at: b.at, absorbed: false, uid: b.id });
    // A tool as the step the reader's list and sheet draw (tool_steps.py's short keys): what kind, one line, the command or the file, and
    // whether it failed. A tool still running or stopped says so in its line.
    function stepOf(t, at) {
      const name = t.tool.trim(), kind = TOOL_KINDS[name.toLowerCase()] || "other";
      const arg = t.argument.trim(), title = (t.title || "").trim(), input = t.input || "";
      const first = arg.split("\n").find(l => l.trim()) || "";
      // The row says the tool's own title when the host sent one ("campus.search"), else the first line of what it was given.
      const step = { k: kind, n: name || "tool", s: clip(title || first || name || "tool", SUMMARY_CHARS), at: at || 0 };
      const fileKind = kind === "read" || kind === "edited" || kind === "wrote";
      // The sheet shows the whole input when the host sent one (to INPUT_CHARS, with its own "… N more characters not shown" line), else the
      // argument as before (COMMAND_CHARS).
      if (input.trim() && !fileKind) { step.c = clip(input.replace(/\s+$/, ""), INPUT_CHARS); if (t.inputFormat) step.cf = t.inputFormat; }
      else if (kind === "ran" && arg) step.c = clip(arg, COMMAND_CHARS);
      else if (fileKind && arg) step.p = first;
      else if (arg && kind !== "ran") step.c = clip(arg, COMMAND_CHARS);
      // A JSON output starts at its first line in the sheet (a command's output shows its end, where the error is).
      if (t.outputFormat === "json") step.of = "json";
      const note = t.status === "running" ? "running" : t.status === "aborted" ? "stopped" : "";
      if (note) step.s = `${step.s} (${note})`;
      if (t.output) { step.l = t.output.replace(/\s+$/, "").split("\n").length; step.z = t.output.length; }
      if (t.status === "failed") { step.f = 1; if (t.output) step.t = t.output.slice(-FAIL_TAIL); }
      return step;
    }
    // The turn a reply block is: its texts are the reply, its tools the steps (their output text is outputs[`${id}:${i}`], which the
    // page's step sheet reads), an open question a reply that needs you, an answered one a reply you answered.
    function replyTurn(b) {
      const reply = b.texts.join("\n\n").trim();
      const steps = b.tools.map(t => stepOf(t, b.at));
      const outputs = {};
      b.tools.forEach((t, i) => { if (t.output) outputs[`${b.id}:${i}`] = t.output; });
      const form = b.form;
      const turn = {
        uid: b.id, source: "campus", kind: "reply", at: b.at, reply_at: b.at, reply, reply_words: words(reply), narration: [], tools: steps.length, steps,
        ask_lines: [], reminder_lines: [], documents: [], form, stopped: b.stopped, verdict: "no-action",
      };
      if (form && form.status === "open") { turn.verdict = "needs-you"; turn.ask_state = "open"; }
      else if (form && form.status === "answered") { turn.verdict = "needs-you"; turn.ask_state = "settled"; }
      return { turn, outputs };
    }
    // The blocks as { id, sig, turn, outputs }: sig is the block's content as text, so a block that did not change is not drawn again.
    function view(blocks) {
      return blocks.map(b => {
        const { turn, outputs } = b.kind === "user" ? { turn: userTurn(b), outputs: {} } : replyTurn(b);
        return { id: b.id, kind: b.kind, sig: JSON.stringify(b), turn, outputs };
      });
    }
    // The text a host copies from a conversation, in the words of CampusTimeline.plainText().
    function plain(blocks) {
      return blocks.map(b => {
        if (b.kind === "user") return "You: " + b.text;
        const lines = [];
        if (b.tools.length) lines.push(`(${b.tools.length} tool step${b.tools.length === 1 ? "" : "s"})`);
        lines.push(...b.texts);
        if (b.form) lines.push("Campus asks: " + b.form.questions.map(q => q.text).join(" "));
        if (b.stopped) lines.push("(stopped)");
        return "Campus: " + lines.join("\n");
      }).join("\n\n");
    }
    return { VERSION, TOOL_KINDS, parse, upsert, composer, view, plain, stepOf, userTurn, replyTurn };
  })();
