// Campus in Conn, slice 2: the writes, all behind one gate (decision C7).
//   - the "Campus writes" switch is OFF at every launch; off, every write is refused before anything is built or sent;
//   - a write waits 3 seconds with an Undo, the way Conn's Herdr compose box does; Undo (or turning the switch off) takes it back, and Now skips the wait;
//   - one write at a time on the wire. A message typed while another write is in its window or being sent is queued behind it (V1): it waits its turn, goes through
//     its own 3 seconds when it reaches the front, and can be taken back on its own while it waits. Undo on the write in its window takes back the messages
//     waiting behind it too (they were written to follow it), in the order typed. Any other write (Stop, an answer, a picker, a start) still says "one at a time";
//   - when a send fails the text goes back to the box (the caller's `restore`), and so does every message waiting behind it.
// Writes: start a conversation, send (steer or queue), answer a question, Stop, change the model, change the agent. They go through `CampusAuth` like every read, so the cookie
// never leaves the web view. The request bodies follow the scout report's section 3.4 (from the shipped front end, not yet fired by anyone): the first
// live write is the person's own (ROADMAP).
import Foundation

/// The write waiting out its undo window, or the last one's outcome.
public struct CampusHeld: Equatable, Sendable {
    public enum Phase: Equatable, Sendable { case held, sending, sent, undone, failed(String) }
    public var conversationID: String
    public var label: String
    public var secondsLeft: Int
    public var phase: Phase
    public var restores: Bool
    /// How many messages waiting behind this write were taken back with it (it failed, or Undo took the lot back).
    public var alsoReturned = 0
}

/// A message waiting behind the write in its window.
public struct CampusWaiting: Equatable, Identifiable, Sendable {
    public let id: UUID
    public var conversationID: String
    public var label: String
}

/// A write held for its window: everything needed to send it, take it back or finish it. The request is built when it is sent, not when it was typed.
struct CampusPendingWrite {
    let id = UUID()
    var conversationID: String
    var label: String
    /// What the list of waiting messages says of it, when that is shorter than the banner's line.
    var waitingLabel: String?
    /// The wait before it is sent: nil is `holdSeconds`. A message the reader page sends has none, because the page already held it through its own Undo window.
    var window: TimeInterval?
    var request: () -> CampusRequest
    var restore: (() -> Void)?
    var onReply: ((CampusReply) -> Void)?
    /// Told once how it ended: nil when Campus took it, else why it did not go (failed, taken back, switch turned off). Only the reader page's sends listen; the page then
    /// gives the message back to its own box, so such a write has no `restore`.
    var onResult: ((String?) -> Void)?
    var onSuccess: () -> Void
}

public enum CampusWriteRefusal: Error, Equatable, Sendable {
    /// The "Campus writes" switch is off.
    case off
    /// Campus is not signed in and answering.
    case notLive
    /// Another write is waiting or being sent.
    case busy
    /// Too many messages are already waiting behind the one being sent.
    case queueFull
    /// The reader page sent more than `maxPageSendsPerMinute` messages in a minute (a person does not; script in the page might).
    case tooFast
    case invalid

    public var message: String {
        switch self {
        case .off: return "Campus writes are off. Turn them on in the status bar."
        case .notLive: return "Campus is not reachable: sign in first."
        case .busy: return "One write at a time: wait for the pending one or press Undo."
        case .tooFast: return "Too many messages from the page in a minute: wait a little."
        case .queueFull: return "\(CampusStore.maxWaiting) messages are already waiting: wait for one to go, or take one back."
        case .invalid: return "That cannot be sent."
        }
    }
}

extension CampusClient {
    public static func promptRequest(_ c: CampusConversation, text: String, delivery: String?) -> CampusRequest {
        var body: [String: Any] = ["text": text]
        if let d = delivery, ["steer", "queue"].contains(d) { body["delivery"] = d }
        return json("POST", conversationPath(c) + "/prompt", body)
    }
    /// `POST /api/spaces/<kind>/<folder>/conversations` with an `Idempotency-Key` header and `{"text"}` (the first message): the call Campus's own front end makes
    /// to start a conversation (scout report 3.3, from the shipped bundle; nobody has fired it yet). The key is the client's, so a retry of the same start is the same start.
    public static func createRequest(in space: CampusSpace, text: String, key: String, agent: String? = nil) -> CampusRequest {
        var body: [String: Any] = ["text": text]
        if let a = agent { body["agent"] = a }       // the create body takes an agent id (scout report 3.3)
        var r = json("POST", "/api/spaces/\(space.kind)/\(space.folder)/conversations", body)
        r.headers["Idempotency-Key"] = key
        return r
    }
    /// `PATCH .../<id> {"title"}` (scout report 3.4): the agent bridge titles the threads it starts.
    public static func renameRequest(kind: String, folder: String, id: String, title: String) -> CampusRequest { json("PATCH", conversationPath(kind: kind, folder: folder, id: id), ["title": title]) }
    public static func interruptRequest(_ c: CampusConversation) -> CampusRequest { json("POST", conversationPath(c) + "/interrupt", [:]) }
    public static func answerRequest(_ c: CampusConversation, form: CampusForm, answers: [String]) -> CampusRequest {
        // One question: its answer as text; several: the answers in order.
        let answer: Any = answers.count == 1 ? answers[0] : answers
        return json("POST", conversationPath(c) + "/form/\(form.id)/reply", ["answer": answer])
    }
    public static func agentRequest(_ c: CampusConversation, agent: String) -> CampusRequest { json("POST", conversationPath(c) + "/agent", ["agent": agent]) }
    public static func modelRequest(_ c: CampusConversation, model: CampusChoice) -> CampusRequest {
        var m: [String: Any] = ["id": model.id, "providerID": model.provider ?? "campus"]
        if let v = model.variant { m["variant"] = v }
        return json("POST", conversationPath(c) + "/model", ["model": m])
    }

    static func json(_ method: String, _ path: String, _ body: [String: Any]) -> CampusRequest {
        CampusRequest(method: method, path: path, headers: ["Content-Type": "application/json"], body: try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
    }

    public func choices(in s: String) async -> (agents: [CampusChoice], models: [CampusChoice])? {
        let parts = s.split(separator: "/").map(String.init)
        guard parts.count == 2 else { return nil }
        async let a = auth.perform(CampusRequest(path: "/api/spaces/\(parts[0])/\(parts[1])/composer/agents"))
        async let m = auth.perform(CampusRequest(path: "/api/spaces/\(parts[0])/\(parts[1])/composer/models"))
        guard let ra = await a, let rm = await m, ra.status == 200, rm.status == 200 else { return nil }
        return (CampusChoice.parseList(ra.body, keys: ["agents"]), CampusChoice.parseList(rm.body, keys: ["models"]))
    }
}

@MainActor
extension CampusStore {
    // MARK: the gate

    /// The most messages that may wait behind the one in its window.
    public nonisolated static let maxWaiting = 5
    /// The most messages the reader page may send in a minute.
    public nonisolated static let maxPageSendsPerMinute = 10

    /// A write is in its window or on the wire, or a message waits behind one.
    var busy: Bool {
        if let h = held, h.phase == .held || h.phase == .sending { return true }
        return !waitingWrites.isEmpty
    }

    private func syncWaiting() { waiting = waitingWrites.map { CampusWaiting(id: $0.id, conversationID: $0.conversationID, label: $0.waitingLabel ?? $0.label) } }

    /// Hold a write for its undo window, then send it. Refused (nothing is built into a request that is sent) when the switch is off, Campus is not live, or another write is pending.
    /// `onReply` gets the answer of a write that went through (a start reads the new conversation's id from it), before `onSuccess`.
    private func hold(_ id: String, label: String, request: CampusRequest, restore: (() -> Void)?, onReply: ((CampusReply) -> Void)? = nil, onSuccess: @escaping () -> Void) -> CampusWriteRefusal? {
        guard writesEnabled else { return .off }
        guard link == .live, auth != nil else { return .notLive }
        if busy { return .busy }
        begin(CampusPendingWrite(conversationID: id, label: label, request: { request }, restore: restore, onReply: onReply, onSuccess: onSuccess))
        return nil
    }

    /// Put a write in its window: the banner counts down, and at the end (or at Now) it is sent.
    private func begin(_ w: CampusPendingWrite) {
        let total = max(0, w.window ?? holdSeconds)
        held = CampusHeld(conversationID: w.conversationID, label: w.label, secondsLeft: Int(total.rounded(.up)), phase: .held, restores: w.restore != nil)
        heldWrite = w
        heldTask?.cancel()
        heldTask = Task { [weak self] in
            // The window is real time, however busy the app is: the deadline is a clock time, not a count of ticks.
            let deadline = Date().addingTimeInterval(total)
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: 50_000_000)
                if Task.isCancelled { return }
                guard let self = self, self.held?.phase == .held, self.heldWrite?.id == w.id else { return }
                let s = Int(max(0, deadline.timeIntervalSinceNow).rounded(.up))
                if s != self.held?.secondsLeft { self.held?.secondsLeft = s }
            }
            guard !Task.isCancelled else { return }
            await self?.dispatch(w)
        }
    }

    /// The end of the window (or Now): send the write, then finish it, go on to the next message waiting, or give everything back.
    private func dispatch(_ w: CampusPendingWrite) async {
        guard held?.phase == .held, heldWrite?.id == w.id, writesEnabled, let auth = auth else { return }
        held?.phase = .sending
        let reply = await auth.perform(w.request())
        if let r = reply, (200..<300).contains(r.status), !r.loginRedirect {
            held?.phase = .sent
            heldWrite = nil
            w.onReply?(r)
            w.onSuccess()
            w.onResult?(nil)
            if !advance() { clearHeld(after: 2.5) }
        } else {
            if reply?.signedOut == true { markExpired() }
            if reply?.blockedByNetwork == true { markBlocked() }
            // Nothing is lost: the text goes back into the box, and so does everything that was waiting behind it (in the order typed).
            let why = reply?.failureText ?? "Campus did not answer"
            let n = returnWaiting(reason: "An earlier message did not go: \(why)")
            w.restore?(); w.onResult?(why); heldWrite = nil
            held?.phase = .failed(why)
            held?.alsoReturned = n
            clearHeld(after: 8)
        }
    }

    /// The write in the window was sent: the next message waiting starts its own window. False when none waits (or none can go: they come back to their boxes).
    private func advance() -> Bool {
        guard !waitingWrites.isEmpty else { return false }
        guard writesEnabled, link == .live, auth != nil else { held?.alsoReturned = returnWaiting(reason: "Campus is not reachable or writes were turned off"); return false }
        let next = waitingWrites.removeFirst()
        syncWaiting()
        begin(next)
        return true
    }

    /// Give every waiting message back to its box, last first so each lands in front of the one after it and the order typed is kept. Returns how many.
    @discardableResult
    private func returnWaiting(reason: String = "Taken back") -> Int {
        let all = waitingWrites
        waitingWrites = []
        syncWaiting()
        for w in all.reversed() { w.restore?(); w.onResult?(reason) }
        return all.count
    }

    private func clearHeld(after s: Double) {
        let snapshot = held
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
            if self?.held == snapshot { self?.held = nil }
        }
    }

    /// Take the waiting write back: nothing was sent, and the text returns to the box. Everything waiting behind it comes back too, in the order typed.
    public func undo() {
        guard held?.phase == .held else { return }
        heldTask?.cancel()
        let n = returnWaiting()
        heldWrite?.restore?(); heldWrite?.onResult?("Taken back"); heldWrite = nil
        held?.phase = .undone
        held?.alsoReturned = n
        clearHeld(after: 2)
    }

    /// Now: skip what is left of the window and send the write at once. The messages waiting behind it keep their own windows.
    public func sendNow() {
        guard held?.phase == .held, writesEnabled, let w = heldWrite else { return }
        heldTask?.cancel()
        heldTask = Task { [weak self] in await self?.dispatch(w) }
    }

    /// Take one waiting message back out of the queue and into its box; the rest keep their places.
    public func takeBack(_ id: UUID) {
        guard let i = waitingWrites.firstIndex(where: { $0.id == id }) else { return }
        let w = waitingWrites.remove(at: i)
        syncWaiting()
        w.restore?(); w.onResult?("Taken back")
    }

    func cancelHeld(reason: String) {
        if held?.phase == .held { undo() } else { returnWaiting(reason: reason) }
    }

    // MARK: the writes

    /// The id the banner and the held record use for a start in `space` (there is no conversation yet).
    public static func startKey(_ space: CampusSpace) -> String { "new:" + space.id }

    /// Start a conversation in a space with its first message. Same gate as every write: switch on, Campus live, 3 seconds with an Undo, one at a time.
    /// `onCreated` runs once Campus answered: the new conversation (already in the rows), or nil when Campus took the start but Conn could not read the new id from the
    /// answer (the list finds it on its next read). Retrying the same text in the same space after a failure sends the same Idempotency-Key, so one failed attempt that
    /// did reach Campus cannot make two conversations.
    @discardableResult
    public func startConversation(in space: CampusSpace, text: String, restore: (() -> Void)? = nil, onCreated: @escaping (CampusConversation?) -> Void) -> CampusWriteRefusal? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !space.readOnly else { return .invalid }
        let draft = space.id + "\u{0}" + t
        let key = createKeys[draft] ?? UUID().uuidString
        let short = t.count > 50 ? String(t.prefix(50)) + "…" : t
        let refusal = hold(Self.startKey(space), label: "Start a conversation in \(space.displayName): \(short)", request: CampusClient.createRequest(in: space, text: t, key: key), restore: restore ?? {}, onReply: { [weak self] reply in
            guard let self = self else { return }
            self.createKeys[draft] = nil
            if let c = CampusConversation.parseCreated(reply.body, space: space) { onCreated(self.adopt(c)) } else { self.kick(); onCreated(nil) }
        }, onSuccess: {})
        if refusal == nil { createKeys[draft] = key }
        return refusal
    }

    /// Send a message. While a run is working the person picks `steer` (now) or `queue` (after the run); an idle conversation takes neither.
    /// A message typed while another write is in its window or on the wire waits behind it (at most `maxWaiting`) and goes through its own window when its turn comes.
    @discardableResult
    public func send(_ text: String, to c: CampusConversation, delivery: String? = nil, restore: @escaping (String) -> Void) -> CampusWriteRefusal? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return .invalid }
        guard writesEnabled else { return .off }
        guard link == .live, auth != nil else { return .notLive }
        let id = c.id
        let short = t.count > 50 ? String(t.prefix(50)) + "…" : t
        let behind = busy
        let chosen: String? = c.working ? (delivery ?? "steer") : nil
        let w = CampusPendingWrite(conversationID: id, label: "Send to \(c.title): \(short)", waitingLabel: "To \(c.title): \(short)", request: { [weak self] in
            // The delivery is what the person chose while the run was working. A message that waited behind another and had none finds, when its turn comes, the run
            // the other one started: it goes after that run.
            let late = behind && chosen == nil && self?.conversations[id]?.working == true
            return CampusClient.promptRequest(c, text: t, delivery: late ? "queue" : chosen)
        }, restore: { restore(t) }, onReply: nil, onSuccess: { [weak self] in
            guard let self = self else { return }
            if self.timelines[id] != nil { self.timelines[id]!.appendUser(t); self.timelineChanged.send(id) }
            self.requestStatus(id)
        })
        if behind {
            guard waitingWrites.count < Self.maxWaiting else { return .queueFull }
            waitingWrites.append(w)
            syncWaiting()
        } else {
            begin(w)
        }
        return nil
    }

    /// A message the reader page's own composer hands over, after the page held it through its own Undo window (and Now): it goes without a second wait of Conn's, behind the
    /// write in front of it if there is one, through the same switch, the same one-at-a-time rule and the same queue. `done` is told once: nil when Campus took it, else why
    /// not (the page then gives the message back to its own box). A refusal is returned at once and `done` is not called. While the run works it goes as Steer, as Send does.
    @discardableResult
    public func sendFromReader(_ text: String, to c: CampusConversation, done: @escaping (String?) -> Void) -> CampusWriteRefusal? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return .invalid }
        guard writesEnabled else { return .off }
        guard link == .live, auth != nil else { return .notLive }
        if busy && waitingWrites.count >= Self.maxWaiting { return .queueFull }
        let stamp = now()
        pageSendTimes = pageSendTimes.filter { stamp.timeIntervalSince($0) < 60 }
        guard pageSendTimes.count < Self.maxPageSendsPerMinute else { return .tooFast }
        pageSendTimes.append(stamp)
        let id = c.id
        let short = t.count > 50 ? String(t.prefix(50)) + "…" : t
        let behind = busy
        let chosen: String? = c.working ? "steer" : nil
        let w = CampusPendingWrite(conversationID: id, label: "Send to \(c.title): \(short)", waitingLabel: "To \(c.title): \(short)", window: 0, request: { [weak self] in
            let late = behind && chosen == nil && self?.conversations[id]?.working == true
            return CampusClient.promptRequest(c, text: t, delivery: late ? "queue" : chosen)
        }, restore: nil, onReply: nil, onResult: done, onSuccess: { [weak self] in
            guard let self = self else { return }
            if self.timelines[id] != nil { self.timelines[id]!.appendUser(t); self.timelineChanged.send(id) }
            self.requestStatus(id)
        })
        if behind { waitingWrites.append(w); syncWaiting() } else { begin(w) }
        return nil
    }

    /// Stop the run (interrupt).
    @discardableResult
    public func stop(_ c: CampusConversation) -> CampusWriteRefusal? {
        let id = c.id
        return hold(id, label: "Stop \(c.title)", request: CampusClient.interruptRequest(c), restore: nil) { [weak self] in
            guard let self = self else { return }
            if self.timelines[id] != nil { self.timelines[id]!.stopRun(stoppedByPerson: true); self.timelineChanged.send(id) }
            self.conversations[id]?.working = false
            self.requestStatus(id)
        }
    }

    public func pick(_ form: CampusForm, question: Int, option: String) {
        var m = picks[form.id] ?? [:]
        m[question] = option
        picks[form.id] = m
    }

    public func clearPicks(_ form: CampusForm) { picks[form.id] = nil }

    public func pickedAnswers(_ form: CampusForm) -> [String]? {
        let m = picks[form.id] ?? [:]
        let answers = form.questions.indices.compactMap { m[$0] }
        return answers.count == form.questions.count ? answers : nil
    }

    /// Answer the open question with the picked options (a single question answers as soon as its option is picked).
    @discardableResult
    public func answer(_ form: CampusForm, in c: CampusConversation) -> CampusWriteRefusal? {
        guard let answers = pickedAnswers(form), form.isOpen else { return .invalid }
        let id = c.id
        let text = answers.joined(separator: "; ")
        return hold(id, label: "Answer \(c.title): \(text)", request: CampusClient.answerRequest(c, form: form, answers: answers), restore: { [weak self] in self?.picks[form.id] = nil }) { [weak self] in
            guard let self = self else { return }
            self.picks[form.id] = nil
            self.openForms[id] = nil
            self.conversations[id]?.needsYou = false; self.conversations[id]?.ask = nil
            if self.timelines[id] != nil { self.timelines[id]!.answerForm(form.id, text: text); self.timelineChanged.send(id) }
            self.requestStatus(id)
        }
    }

    @discardableResult
    public func setAgent(_ agent: CampusChoice, for c: CampusConversation) -> CampusWriteRefusal? {
        let id = c.id
        return hold(id, label: "Change agent to \(agent.label)", request: CampusClient.agentRequest(c, agent: agent.id), restore: nil) { [weak self] in self?.conversations[id]?.agent = agent.id }
    }

    @discardableResult
    public func setModel(_ model: CampusChoice, for c: CampusConversation) -> CampusWriteRefusal? {
        let id = c.id
        return hold(id, label: "Change model to \(model.label)", request: CampusClient.modelRequest(c, model: model), restore: nil) { [weak self] in self?.conversations[id]?.model = model.id }
    }

    /// The agents and models a space offers (read once per space; reading is not gated).
    func loadChoices(for c: CampusConversation) async {
        let s = c.spaceID
        guard agents[s] == nil, !choicesLoading.contains(s), let client = client else { return }
        choicesLoading.insert(s)
        defer { choicesLoading.remove(s) }
        if let r = await client.choices(in: s) { agents[s] = r.agents; models[s] = r.models }
    }
}
