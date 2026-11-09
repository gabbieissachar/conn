  // ---------------------------------------------------------------- undoing a send (undosend.js, the reader page only)
  // build_prototype.fill_template pastes this file into the reader page's script. Two parts, neither of which touches the page:
  //   makeSendHold   the Undo window. Send holds the message in the page for a few seconds, and nothing is asked of any server or
  //                  pane until the window ends, so Undo inside it can say the message was never sent.
  //   describeSend   what the faded message in the conversation says about itself at each step after that, and which buttons it
  //                  has, so the owner can tell whether Undo is still possible and why it is not.
  // No page needed: undosend.test.js runs it in a bare sandbox.
  const UNDO_SECONDS = 5;
  const SEND_HANDOFF_VERSION = 1;

  // A full navigation destroys the page timer. Keep enough text state in this tab to resume when the
  // new page is a different session. A reload of the same session discards the record and leaves its draft alone.
  const makeSendHandoff = ({ hold, deadline, sentItems = [], sentBox = "", pointed = false }) => ({
    version: SEND_HANDOFF_VERSION, id: hold.id, sid: hold.sid, text: hold.text, at: hold.at, photos: hold.photos || 0,
    deadline, sentItems: sentItems.map(item => ({ ...item })), sentBox, pointed,
  });
  const resumeSendHandoff = (record, currentSid, now) => {
    if (!record || record.version !== SEND_HANDOFF_VERSION || typeof record.id !== "string" || typeof record.sid !== "string"
      || typeof record.deadline !== "number" || !Number.isFinite(record.deadline)) return null;
    if (record.sid === currentSid) return { action: "discard" };
    return { action: "resume", seconds: Math.max(0, record.deadline - now), hold: { ...record } };
  };
  // clock: { now() in seconds, after(ms, fn) -> handle, cancel(handle) }, the page's own timers or a test's.
  const makeSendHold = clock => {
    let held = null;
    const release = mine => {
      if (!mine || held !== mine) return false;
      clock.cancel(mine.timer);
      held = null;
      mine.job();
      return true;
    };
    return {
      // Holds <job> (the send) for <seconds>, then runs it once. False when another message is already held.
      begin(job, seconds, meta = null) {
        if (held) return false;
        const mine = { job, meta, deadline: clock.now() + seconds, timer: null };
        held = mine;
        mine.timer = clock.after(seconds * 1000, () => release(mine));
        return true;
      },
      // Takes the message back before it left: the job never runs. False when it already ran (or nothing was held).
      undo() {
        if (!held) return false;
        clock.cancel(held.timer);
        held = null;
        return true;
      },
      // "Send now": runs the job at once instead of at the end of the window.
      release: () => release(held),
      active: () => held !== null,
      meta: () => held && held.meta,
      // Whole seconds left, rounded up, so the last second reads 1 and never 0 while the message is still held.
      left: () => held ? Math.max(1, Math.ceil(held.deadline - clock.now())) : 0,
    };
  };

  // The commands that end, reset, shrink or sign out the session on the other end ask first. The question is the page's own: a native confirm() is
  // answered "no" at once by a web view with no dialog (Conn's, the Integrated Browser of VS Code), which left /clear with a Send that did nothing.
  // The first Send (or Enter) opens the question for exactly this text in exactly this session (Send reads "Confirm /clear", Add reads "Keep"),
  // the second Send sends, and another text, another session, Keep, Esc or COMMAND_ASK_SECONDS without an answer closes it. Any other message,
  // /bearings and every other skill or command included, is never asked about: its press is "send".
  const SESSION_COMMANDS = {
    "/clear": "starts that session over", "/exit": "ends that session", "/quit": "ends that session",
    "/compact": "replaces that session's earlier turns with a summary", "/logout": "signs that agent out",
    "/rewind": "opens a menu in the pane to roll that session back",
  };
  const COMMAND_ASK_SECONDS = 6;
  const sessionCommand = text => {
    const m = /^\/(clear|exit|quit|compact|logout|rewind)(?=\s|$)/.exec(typeof text === "string" ? text : "");
    return m ? { command: m[0], says: SESSION_COMMANDS[m[0]] } : null;
  };
  // clock: as for makeSendHold. changed() runs when the question closes by itself (the page paints again).
  const makeCommandAsk = (clock, changed = () => {}) => {
    let asked = null;
    const close = () => {
      if (!asked) return false;
      clock.cancel(asked.timer);
      asked = null;
      return true;
    };
    return {
      // What pressing Send does with this text in this session: "send", or "ask" when the question has just been opened.
      press(sid, text) {
        if (!sessionCommand(text)) { close(); return "send"; }
        if (asked && asked.sid === sid && asked.text === text) { close(); return "send"; }
        close();
        const mine = { sid, text, timer: null };
        asked = mine;
        mine.timer = clock.after(COMMAND_ASK_SECONDS * 1000, () => { if (asked === mine) { asked = null; changed(); } });
        return "ask";
      },
      // Called as the page paints: a question about other words, or in another session, is over (so the same words typed again, later, ask again).
      sync(sid, text) { if (asked && (asked.sid !== sid || asked.text !== text)) close(); },
      // The command being asked about for exactly this text in this session, else "".
      open: (sid, text) => asked && asked.sid === sid && asked.text === text ? sessionCommand(text).command : "",
      close,
      // The question, in words, for the status line.
      words: (name, text) => { const c = sessionCommand(text); return c ? `Send ${c.command} to ${name}? It ${c.says}. Press Confirm, or Keep to leave it.` : ""; },
    };
  };

  // What the faded message says at each step, from the record the page keeps of it:
  //   p       { at, label, agent, text, queue?: { state: "held" | "queued" | "sending" | "sent" | "refused", receipt?, cancelling?,
  //             tooLate? } }  (no queue: sent straight to the pane by the page served from the laptop)
  //   hold    { left } while the message is still in the Undo window, else null
  //   flight  "pane" or "queue" from the end of the window until the server or the queue has answered, else null
  //   t(s)    a time of day, and now() the clock in seconds
  // Returns { stage, say, hint, actions } where actions are the buttons: "undo", "now" (send now), "edit" (back into the box),
  // "dismiss". Undo is offered only at the steps where the holder can prove the message never reached the agent.
  const LATE_AFTER = 60;
  const describeSend = (p, { hold = null, flight = null, t, now }) => {
    // The window is over and the request is running: it has left the page, so it is no longer "nothing has left this page yet".
    if (flight) return { stage: "flying", say: flight === "queue" ? "Queuing it for the laptop now · too late to undo" : `Sending to ${p.label} now · too late to undo`, hint: "", actions: [] };
    if (hold) return { stage: "window", say: `Sending in ${hold.left} s · nothing has left this page yet`, hint: "", actions: ["undo", "now"] };
    const queue = p.queue, receipt = queue && queue.receipt;
    const working = agent => agent === "working";
    // Sent to the pane. When the agent was working, Claude Code keeps the message as a queued one until its turn ends, and only a
    // key typed in the pane takes it back (the reader never sends keys to a pane).
    const delivered = (when, by, agent) => {
      const late = now() - when > LATE_AFTER;
      const holdHint = working(agent) ? `${p.label} was working, so Claude Code may hold this as a queued message until its turn ends. Press ↑ in the pane to take it back.` : "";
      return {
        stage: late ? "stuck" : working(agent) ? "held-by-agent" : "delivered",
        say: late ? `${by} · not in the log yet; check the pane · too late to undo here`
          : working(agent) ? `${by} · ${p.label} was working · too late to undo here` : `${by} · waiting for ${p.label} · too late to undo here`,
        hint: late ? "" : holdHint, actions: [],
      };
    };
    if (!queue) return delivered(p.at, `Sent ${t(p.at)}`, p.agent);
    if (queue.state === "refused") return { stage: "refused", say: `Not sent · ${(receipt && receipt.reason) || "The laptop refused it."}`, hint: "", actions: ["edit", "dismiss"] };
    if (queue.state === "sent") return delivered(receipt && receipt.state === "sent" ? receipt.at : p.at, `Sent by the laptop at ${t(receipt ? receipt.at : p.at)}`, receipt && receipt.agent);
    if (queue.state === "sending") return { stage: "sending", say: `Queued ${t(p.at)} · the laptop is sending it now · too late to undo`, hint: "", actions: [] };
    if (queue.cancelling) return { stage: "cancelling", say: "Undoing · waiting for the laptop to confirm it did not send this", hint: "Nothing is claimed as undone until it answers.", actions: [] };
    if (queue.tooLate) return { stage: "late", say: `Too late to undo · the laptop already has this message`, hint: "", actions: [] };
    if (queue.state === "held") return { stage: "held", say: `Held on this phone since ${t(p.at)} · goes to the laptop when it is reachable`, hint: "", actions: ["undo"] };
    return { stage: "queued", say: `Queued ${t(p.at)} · waiting for the laptop to send it to ${p.label}`, hint: "", actions: ["undo"] };
  };
