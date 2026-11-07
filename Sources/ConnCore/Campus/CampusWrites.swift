// Campus in Conn, slice 2: the writes, all behind one gate (decision C7).
//   - the "Campus writes" switch is OFF at every launch; off, every write is refused before anything is built or sent;
//   - a write waits 3 seconds with an Undo, the way Conn's Herdr compose box does; Undo (or turning the switch off) takes it back;
//   - one write at a time;
//   - when a send fails the text goes back to the box (the caller's `restore`).
// Writes: send (steer or queue), answer a question, Stop, change the model, change the agent. They go through `CampusAuth` like every read, so the cookie
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
}

public enum CampusWriteRefusal: Error, Equatable, Sendable {
    /// The "Campus writes" switch is off.
    case off
    /// Campus is not signed in and answering.
    case notLive
    /// Another write is waiting or being sent.
    case busy
    case invalid

    public var message: String {
        switch self {
        case .off: return "Campus writes are off. Turn them on in the status bar."
        case .notLive: return "Campus is not reachable: sign in first."
        case .busy: return "One send at a time: wait for the pending one or press Undo."
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

    /// Hold a write for its undo window, then send it. Refused (nothing is built into a request that is sent) when the switch is off, Campus is not live, or another write is pending.
    private func hold(_ id: String, label: String, request: CampusRequest, restore: (() -> Void)?, onSuccess: @escaping () -> Void) -> CampusWriteRefusal? {
        guard writesEnabled else { return .off }
        guard link == .live, let auth = auth else { return .notLive }
        if let h = held, h.phase == .held || h.phase == .sending { return .busy }
        let total = max(0, holdSeconds)
        held = CampusHeld(conversationID: id, label: label, secondsLeft: Int(total.rounded(.up)), phase: .held, restores: restore != nil)
        heldRestore = restore
        heldTask?.cancel()
        heldTask = Task { [weak self] in
            // The window is real time, however busy the app is: the deadline is a clock time, not a count of ticks.
            let deadline = Date().addingTimeInterval(total)
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: 50_000_000)
                if Task.isCancelled { return }
                guard let self = self, self.held?.phase == .held else { return }
                let s = Int(max(0, deadline.timeIntervalSinceNow).rounded(.up))
                if s != self.held?.secondsLeft { self.held?.secondsLeft = s }
            }
            guard let self = self, !Task.isCancelled, self.held?.phase == .held, self.writesEnabled else { return }
            self.held?.phase = .sending
            let reply = await auth.perform(request)
            if Task.isCancelled { return }
            if let r = reply, (200..<300).contains(r.status), !r.loginRedirect {
                self.held?.phase = .sent
                self.heldRestore = nil
                onSuccess()
                self.clearHeld(after: 2.5)
            } else {
                if reply?.signedOut == true { self.markExpired() }
                // Nothing is lost: the text goes back into the box.
                self.heldRestore?(); self.heldRestore = nil
                self.held?.phase = .failed(reply?.failureText ?? "Campus did not answer")
                self.clearHeld(after: 8)
            }
        }
        return nil
    }

    private func clearHeld(after s: Double) {
        let snapshot = held
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
            if self?.held == snapshot { self?.held = nil }
        }
    }

    /// Take the waiting write back: nothing was sent, and the text returns to the box.
    public func undo() {
        guard held?.phase == .held else { return }
        heldTask?.cancel()
        heldRestore?(); heldRestore = nil
        held?.phase = .undone
        clearHeld(after: 2)
    }

    func cancelHeld(reason: String) {
        guard held?.phase == .held else { return }
        undo()
    }

    // MARK: the writes

    /// Send a message. While a run is working the person picks `steer` (now) or `queue` (after the run); an idle conversation takes neither.
    @discardableResult
    public func send(_ text: String, to c: CampusConversation, delivery: String? = nil, restore: @escaping (String) -> Void) -> CampusWriteRefusal? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return .invalid }
        let d: String? = c.working ? (delivery ?? "steer") : nil
        let id = c.id
        let short = t.count > 50 ? String(t.prefix(50)) + "…" : t
        return hold(id, label: "Send to \(c.title): \(short)", request: CampusClient.promptRequest(c, text: t, delivery: d), restore: { restore(t) }) { [weak self] in
            guard let self = self else { return }
            if self.timelines[id] != nil { self.timelines[id]!.appendUser(t); self.timelineChanged.send(id) }
            self.requestStatus(id)
        }
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
