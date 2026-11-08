// The agent bridge (S2): leaders ask Campus through Conn.
//
// How a request travels: `fm-ask campus --wait N -- <text>` leaves a record in the session registry; Conn, registered there as the plain session `campus`, reads it,
// does the call through the signed-in Campus web view it already has (Conn's code never holds a credential), and writes the answer where `fm-ask wait` reads it.
// No port, no socket; a request survives a Conn restart (an old one is refused, see `BridgeLimits.staleAfter`). Decisions: H2 conn-bridge, H3 standing go for threads the
// bridge starts, H4 callers (`BridgeCallers`), H5 threads in My space titled `fm/<home>: <topic>`.
//
// What it is not: a security boundary. Every process of the same macOS user can already read Conn's web-view cookie store or drive a signed-in browser profile, and a sender
// label in a file proves nothing. What the bridge does is narrow the easy path (send text, read threads it started or the person shared; no other space, no settings, no
// connectors, no permission answers), count and record every use, and give the person one off switch (off at every launch).
//
// Order of checks for a request (each refusal is a reply, never silence): the switch, a stale record, the caller, the command's shape, size, secrets and attachments, which thread,
// Campus signed in, the turn and thread caps. A permission request is never answered: it comes back as `needs-answer` with reason `permission` and only the person decides, in Conn.
import Foundation
import Combine

public struct BridgeActivity: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public var at: Date
    public var sender: String
    public var action: String
    public var thread: String?
    public var outcome: String
    public var reason: String?
    public var bytes: Int
    public static func == (l: BridgeActivity, r: BridgeActivity) -> Bool { l.id == r.id }
}

@MainActor
public final class BridgeEngine: ObservableObject {
    /// The "Agent bridge" switch. Off at every launch: nothing is read from the inbox, and Conn is not registered as `campus`, until the person turns it on.
    @Published public private(set) var enabled = false
    /// Why the switch could not go on (another Conn holds the name `campus`, the registry folder cannot be written).
    @Published public private(set) var problem: String?
    /// The latest requests, newest first (memory only; the audit file has the longer record).
    @Published public private(set) var activity: [BridgeActivity] = []
    /// Requests answered in the last 24 hours.
    @Published public private(set) var last24h = 0
    @Published public var callers: BridgeCallers

    public var limits = BridgeLimits()
    /// How long one request waits for Campus's agent before answering `working` (the caller reads on with `campus: read`).
    public var waitBudget: TimeInterval = 100
    public var pollInterval: TimeInterval = 3
    public var scanInterval: TimeInterval = 2
    /// After a send, how long a thread may stay idle without a new reply before the request says so.
    public var startGrace: TimeInterval = 20
    public var preamble = BridgeCommand.preamble

    public let store: CampusStore
    public let registry: BridgeRegistry
    public let ownership: BridgeOwnership
    public let audit: BridgeAuditLog
    private let now: () -> Date
    private let pid: Int32

    private var scanTask: Task<Void, Never>?
    private var tasks: [String: Task<Void, Never>] = [:]
    /// New threads whose request was accepted but not yet in the audit: they count against the caps at once, so a burst cannot pass the check together.
    private var reservedNew: [String: (home: String, at: Date)] = [:]
    private var runningNew = 0
    private var runningThreads: Set<String> = []
    private var finishedBroken: Set<String> = []

    public init(store: CampusStore, registry: BridgeRegistry, ownership: BridgeOwnership, audit: BridgeAuditLog, callers: BridgeCallers = BridgeCallers(), pid: Int32 = getpid(), now: @escaping () -> Date = Date.init) {
        self.store = store; self.registry = registry; self.ownership = ownership; self.audit = audit; self.callers = callers; self.pid = pid; self.now = now
        registry.clearStale(pid: pid)
        refreshCount()
    }

    // MARK: the switch

    /// Turn the bridge on or off. On: Conn becomes the session `campus` and the inbox is read. Off: Conn leaves the registry (requests already there stay) and what is in flight
    /// is answered as stopped.
    public func setEnabled(_ on: Bool) {
        guard on != enabled else { return }
        if on {
            do { try registry.register(pid: pid, now: now()) } catch BridgeRegistry.RegisterError.heldByAnother(let other) {
                problem = "Another Conn (process \(other)) is already the session 'campus'. Quit it first."; return
            } catch { problem = "Could not register as the session 'campus': \(error)"; return }
            problem = nil
            enabled = true
            scanTask = Task { [weak self] in
                while !Task.isCancelled {
                    self?.scan()
                    try? await Task.sleep(nanoseconds: UInt64(max(0.02, self?.scanInterval ?? 2) * 1_000_000_000))
                }
            }
        } else {
            enabled = false
            scanTask?.cancel(); scanTask = nil
            registry.unregister(pid: pid)
        }
    }

    /// Quit: leave the registry so `fm-who campus` does not name a process that is gone.
    public func shutdown() { setEnabled(false) }

    // MARK: reading the inbox

    /// Look at the inbox now: every record not already being answered starts its own request. Public so a test can drive it.
    public func scan() {
        guard enabled else { return }
        for (name, data) in registry.pending() where tasks[name] == nil && !finishedBroken.contains(name) {
            let record = BridgeRecordParser.parse(data, fileName: name)
            tasks[name] = Task { [weak self] in
                guard let self = self else { return }
                await self.process(name: name, record: record)
                self.tasks[name] = nil
            }
        }
    }

    /// Wait until every request in flight is answered (tests, and a clean quit).
    public func waitIdle() async {
        while true {
            let running = Array(tasks.values)
            if running.isEmpty { return }
            for t in running { await t.value }
        }
    }

    // MARK: one request

    private struct Ctx {
        var name: String
        var requestID: String
        var sender: String
        var kind: String
        var action = "unknown"
        var thread: String?
        var bytes = 0
        var sha = ""
    }

    private func process(name: String, record: BridgeRecord?) async {
        guard let record = record else {
            // Not a request Conn can answer (no usable id, not text): move it aside so it is not read again and again.
            registry.acknowledge(fileName: name)
            note(BridgeActivity(at: now(), sender: "?", action: "unknown", thread: nil, outcome: "refused", reason: "unreadable request record \(name)", bytes: 0))
            return
        }
        var c = Ctx(name: name, requestID: record.requestID, sender: record.fromRef, kind: record.fromKind)
        c.bytes = record.text.utf8.count
        c.sha = BridgeContent.sha256(record.text)
        // A request that was already answered (the same id again, or a record left behind by a crash after the reply) is not done twice.
        if registry.replyExists(record.requestID) { registry.acknowledge(fileName: name); return }
        if let at = record.at, now().timeIntervalSince(at) > limits.staleAfter {
            return finish(c, .init(.refused, reason: "the request waited more than \(Int(limits.staleAfter / 60)) minutes before Conn read it (the bridge was off or Conn was closed): send it again"))
        }
        if let why = callers.refusal(kind: record.fromKind, ref: record.fromRef) { return finish(c, .init(.refused, reason: why)) }
        let command: BridgeCommand
        do { command = try BridgeCommand.parse(record.text) } catch BridgeCommand.ParseError.format(let why) { return finish(c, .init(.failed, reason: "format: \(why)")) } catch { return finish(c, .init(.failed, reason: "format")) }
        c.action = command.action.name
        c.thread = command.action.thread
        let payload = [command.text, command.answer ?? "", command.topic ?? ""].joined(separator: "\n")
        if command.text.utf8.count + (command.answer?.utf8.count ?? 0) > limits.requestBytes {
            return finish(c, .init(.refused, thread: c.thread, reason: "the message is over \(limits.requestBytes / 1024) KB"))
        }
        if let why = BridgeContent.refusal(payload) { return finish(c, .init(.refused, thread: c.thread, reason: "not sent: \(why)")) }
        if command.answer != nil, !command.text.isEmpty { return finish(c, .init(.failed, thread: c.thread, reason: "format: give either a message or an answer, not both")) }
        // Campus must be signed in and answering; a signed-out Campus is an answer at once, never a queue.
        switch store.link {
        case .live: break
        case .expired: return finish(c, .init(.signedOut, thread: c.thread, reason: "Campus is signed out: sign in in Conn"))
        case .starting: return finish(c, .init(.failed, thread: c.thread, reason: "Campus is starting the person's workspace: try again in a minute"))
        case .unreachable(let why): return finish(c, .init(.failed, thread: c.thread, reason: "Campus is not reachable: \(why)"))
        case .disabled: return finish(c, .init(.failed, thread: c.thread, reason: "Campus is not part of this Conn"))
        }
        guard store.client != nil else { return finish(c, .init(.failed, reason: "no Campus connection")) }
        switch command.action {
        case .new: await runNew(&c, command)
        case .continue(let id): await runContinue(&c, command, id: id)
        case .read(let id): await runRead(&c, id: id)
        }
    }

    // MARK: the three actions

    private func runNew(_ c: inout Ctx, _ cmd: BridgeCommand) async {
        let history = audit.read(now: now())
        let pending = reservedNew.values
        let extra = pending.map { BridgeAuditEntry(at: $0.at, sender: $0.home, kind: "", requestID: "", thread: "pending", action: "new", bytes: 0, sha256: "", outcome: "pending") }
        if let why = BridgeCaps.newThreadRefusal(history: history + extra, home: c.sender, now: now(), limits: limits) { return finish(c, .init(.refused, reason: why)) }
        if activeCount() >= limits.working { return finish(c, .init(.refused, reason: "\(limits.working) bridge threads are already working: wait for one to finish")) }
        guard let space = store.spaces.first(where: { !$0.isTeam && !$0.readOnly }), let client = store.client else { return finish(c, .init(.failed, reason: "Campus has not listed My space yet")) }
        reservedNew[c.requestID] = (c.sender, now())
        runningNew += 1
        defer { reservedNew[c.requestID] = nil; runningNew -= 1 }
        let text = preamble + "\n\n" + cmd.text
        let reply = await client.auth.perform(CampusClient.createRequest(in: space, text: text, key: c.requestID, agent: cmd.agent ?? BridgeCommand.defaultAgent))
        guard let r = reply else { return finish(c, .init(.failed, reason: "Campus did not answer")) }
        if r.signedOut { store.markExpired(); return finish(c, .init(.signedOut, reason: "Campus is signed out: sign in in Conn")) }
        guard (200..<300).contains(r.status) else { return finish(c, .init(.failed, reason: r.failureText)) }
        guard let made = CampusConversation.parseCreated(r.body, space: space) else { return finish(c, .init(.failed, reason: "shape: Campus answered a start with something Conn does not know; no thread id was read")) }
        let addr = CampusAddress(made)
        ownership.addOwned(addr)
        c.thread = made.id
        let c2 = store.adopt(made)
        // The title says who asked. A failed rename is not a failed request.
        let title = BridgeCommand.title(home: c.sender, topic: cmd.topic)
        if let rr = await client.auth.perform(CampusClient.renameRequest(kind: addr.kind, folder: addr.folder, id: addr.id, title: title)), (200..<300).contains(rr.status) { store.setTitle(made.id, title) }
        runningThreads.insert(made.id)
        defer { runningThreads.remove(made.id) }
        let out = await awaitRun(c2, baseline: nil, sent: true)
        finish(c, out)
    }

    private func runContinue(_ c: inout Ctx, _ cmd: BridgeCommand, id: String) async {
        guard let (addr, mode) = ownership.share(for: id) else { return finish(c, .init(.refused, thread: id, reason: "that thread is not one the bridge started or the person shared with agents")) }
        guard mode.maySend else { return finish(c, .init(.refused, thread: id, reason: "that thread is shared with agents for reading only")) }
        let history = audit.read(now: now())
        if BridgeCaps.turns(on: id, history: history) >= limits.turnsPerThread { return finish(c, .init(.refused, thread: id, reason: "this thread has used its \(limits.turnsPerThread) turns: start a new one")) }
        guard let conv = await store.ensureConversation(kind: addr.kind, folder: addr.folder, id: addr.id), let client = store.client else { return finish(c, .init(.failed, thread: id, reason: "Campus does not have that thread")) }
        guard let st = await client.status(of: conv).value(store) else { return finish(c, signedOutOrFailed(id)) }
        runningThreads.insert(id)
        defer { runningThreads.remove(id) }
        switch st.run {
        case .busy:
            return finish(c, .init(.working, thread: id, url: url(conv), reason: "the thread is still working and nothing was sent: read it with 'campus: read \(id)'"))
        case .needsYou:
            guard let answer = cmd.answer else { return finish(c, await needsAnswer(conv, client: client)) }
            let (forms, permissions) = await openRequests(conv, client: client)
            guard let form = forms.first(where: \.isOpen) else {
                return finish(c, permissions.isEmpty ? .init(.failed, thread: id, reason: "the thread says it waits on the person but has no open question") : permissionReply(conv, permissions))
            }
            let answers = answer.components(separatedBy: " | ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            guard answers.count == form.questions.count else { return finish(c, .init(.needsAnswer, thread: id, url: url(conv), reason: "the question has \(form.questions.count) part(s): answer with that many parts separated by ' | '", question: describe(form))) }
            let baseline = await latestAssistant(conv, client: client)?.id
            guard let r = await client.auth.perform(CampusClient.answerRequest(conv, form: form, answers: answers)) else { return finish(c, .init(.failed, thread: id, reason: "Campus did not answer")) }
            if r.signedOut { store.markExpired(); return finish(c, .init(.signedOut, thread: id, reason: "Campus is signed out: sign in in Conn")) }
            guard (200..<300).contains(r.status) else { return finish(c, .init(.failed, thread: id, reason: r.failureText)) }
            finish(c, await awaitRun(conv, baseline: baseline, sent: true))
        case .idle, .unknown:
            if cmd.answer != nil { return finish(c, .init(.refused, thread: id, reason: "the thread is not waiting for an answer: send a message instead")) }
            if activeCount(excluding: id) >= limits.working { return finish(c, .init(.refused, thread: id, reason: "\(limits.working) bridge threads are already working: wait for one to finish")) }
            let baseline = await latestAssistant(conv, client: client)?.id
            guard let r = await client.auth.perform(CampusClient.promptRequest(conv, text: cmd.text, delivery: nil)) else { return finish(c, .init(.failed, thread: id, reason: "Campus did not answer")) }
            if r.signedOut { store.markExpired(); return finish(c, .init(.signedOut, thread: id, reason: "Campus is signed out: sign in in Conn")) }
            guard (200..<300).contains(r.status) else { return finish(c, .init(.failed, thread: id, reason: r.failureText)) }
            finish(c, await awaitRun(conv, baseline: baseline, sent: true))
        }
    }

    private func runRead(_ c: inout Ctx, id: String) async {
        guard let (addr, _) = ownership.share(for: id) else { return finish(c, .init(.refused, thread: id, reason: "that thread is not one the bridge started or the person shared with agents")) }
        guard let conv = await store.ensureConversation(kind: addr.kind, folder: addr.folder, id: addr.id) else { return finish(c, .init(.failed, thread: id, reason: "Campus does not have that thread")) }
        runningThreads.insert(id)
        defer { runningThreads.remove(id) }
        finish(c, await awaitRun(conv, baseline: nil, sent: false))
    }

    // MARK: waiting for the run

    /// Poll the thread's status until it stops. `idle` reads the newest assistant message (text parts only: no reasoning, no tool output); a question or a permission request ends the
    /// wait as `needs-answer`; the budget running out is `working`, not a failure.
    private func awaitRun(_ conv: CampusConversation, baseline: String?, sent: Bool) async -> BridgeReply {
        guard let client = store.client else { return .init(.failed, thread: conv.id, reason: "no Campus connection") }
        let start = now()
        let deadline = start.addingTimeInterval(waitBudget)
        var sawBusy = false, errors = 0
        while true {
            if !enabled { return .init(.failed, thread: conv.id, url: url(conv), reason: "the Agent bridge was switched off while this request waited") }
            switch await client.status(of: conv) {
            case .unauthorized: store.markExpired(); return .init(.signedOut, thread: conv.id, url: url(conv), reason: "Campus is signed out: sign in in Conn")
            case .starting, .failed:
                errors += 1
                if errors >= 4 { return .init(.failed, thread: conv.id, url: url(conv), reason: "Campus stopped answering while the thread was running") }
            case .ok(let st):
                errors = 0
                store.applyStatus(conv.id, st)            // the row follows what the bridge saw (the "working at once" cap reads the rows)
                switch st.run {
                case .busy: sawBusy = true
                case .needsYou: return await needsAnswer(conv, client: client)
                case .idle, .unknown:
                    let latest = await latestAssistant(conv, client: client)
                    let fresh = latest != nil && latest!.id != baseline
                    if sawBusy || fresh || !sent {
                        guard let l = latest, !l.text.isEmpty else { return .init(.failed, thread: conv.id, url: url(conv), reason: "the thread finished without a text reply") }
                        return .init(.done, thread: conv.id, url: url(conv), reply: l.text, tokensIn: l.tokensIn, tokensOut: l.tokensOut)
                    }
                    if now().timeIntervalSince(start) > startGrace { return .init(.failed, thread: conv.id, url: url(conv), reason: "the thread did not start a run after the message") }
                }
            }
            if now() >= deadline { return .init(.working, thread: conv.id, url: url(conv), reason: "the thread is still working: read it with 'campus: read \(conv.id)'") }
            try? await Task.sleep(nanoseconds: UInt64(max(0.01, pollInterval) * 1_000_000_000))
        }
    }

    /// The newest assistant message with text: its id, its text parts joined, its token counts.
    private func latestAssistant(_ c: CampusConversation, client: CampusClient) async -> (id: String, text: String, tokensIn: Int?, tokensOut: Int?)? {
        guard let r = await client.auth.perform(CampusRequest(path: CampusClient.conversationPath(c) + "/message?limit=20&order=desc")), (200..<300).contains(r.status), let root = CampusJSON.parse(r.body) else { return nil }
        for m in root["data"].array where m["type"].string == "assistant" {
            let text = m["content"].array.filter { $0["type"].string == "text" }.compactMap { $0["text"].string }.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, let id = m["id"].string else { continue }
            return (id, text, m["tokens"]["input"].int, m["tokens"]["output"].int)
        }
        return nil
    }

    // MARK: questions and permissions (never answered here)

    private func openRequests(_ c: CampusConversation, client: CampusClient) async -> (forms: [CampusForm], permissions: [CampusJSON]) {
        guard let r = await client.auth.perform(CampusRequest(path: CampusClient.conversationPath(c) + "/form")), (200..<300).contains(r.status), let root = CampusJSON.parse(r.body) else { return ([], []) }
        return (CampusForm.parseOpenForms(r.body), root["permissions"].array)
    }

    private func needsAnswer(_ c: CampusConversation, client: CampusClient) async -> BridgeReply {
        let (forms, permissions) = await openRequests(c, client: client)
        if let f = forms.first(where: \.isOpen) { return .init(.needsAnswer, thread: c.id, url: url(c), question: describe(f)) }
        if !permissions.isEmpty { return permissionReply(c, permissions) }
        return .init(.needsAnswer, thread: c.id, url: url(c), reason: "the thread waits on the person in Campus", question: "The thread waits on the person; no question could be read.")
    }

    /// A permission request is the person's to decide: it is returned, never answered (the stand-in's log must show no `/permission/` write).
    private func permissionReply(_ c: CampusConversation, _ permissions: [CampusJSON]) -> BridgeReply {
        let name = permissions.first.flatMap { $0.first("permission", "title", "tool", "name").string } ?? "a permission"
        return .init(.needsAnswer, thread: c.id, url: url(c), reason: "permission", question: "The thread asks for \(name). Only the person decides this, in Conn or in Campus; the bridge never answers a permission request.")
    }

    private func describe(_ f: CampusForm) -> String {
        f.questions.enumerated().map { i, q in "\(i + 1). \(q.text)" + (q.options.isEmpty ? "" : " (options: \(q.options.joined(separator: " | ")))") }.joined(separator: " ")
    }

    // MARK: bookkeeping

    private func activeCount(excluding id: String? = nil) -> Int {
        let ownedWorking = ownership.shares.filter { $0.value == .owned }.map(\.key.id).filter { store.conversation($0)?.working == true && !runningThreads.contains($0) && $0 != id }.count
        return runningNew + runningThreads.subtracting(id.map { [$0] } ?? []).count + ownedWorking
    }

    private func url(_ c: CampusConversation) -> String? { store.webURL(for: c)?.absoluteString }

    private func signedOutOrFailed(_ id: String) -> BridgeReply {
        store.link == .expired ? .init(.signedOut, thread: id, reason: "Campus is signed out: sign in in Conn") : .init(.failed, thread: id, reason: "Campus did not answer")
    }

    /// Write the answer, hand the record back, record the use.
    private func finish(_ c: Ctx, _ reply: BridgeReply) {
        var reply = reply
        if reply.thread == nil { reply.thread = c.thread }
        let entry = BridgeAuditEntry(at: now(), sender: c.sender.isEmpty ? "?" : c.sender, kind: c.kind, requestID: c.requestID, thread: reply.thread ?? c.thread, action: c.action, bytes: c.bytes, sha256: c.sha, outcome: reply.status.rawValue)
        do {
            try registry.writeReply(id: c.requestID, body: reply.render(), now: now())
        } catch {
            finishedBroken.insert(c.name)
            note(BridgeActivity(at: now(), sender: entry.sender, action: c.action, thread: entry.thread, outcome: "failed", reason: "could not write the reply: \(error)", bytes: c.bytes))
            audit.append(entry); refreshCount()
            return
        }
        registry.acknowledge(fileName: c.name)
        audit.append(entry)
        note(BridgeActivity(at: now(), sender: entry.sender, action: c.action, thread: entry.thread, outcome: reply.status.rawValue, reason: reply.reason, bytes: c.bytes))
        refreshCount()
    }

    private func note(_ a: BridgeActivity) {
        activity.insert(a, at: 0)
        if activity.count > 100 { activity.removeLast(activity.count - 100) }
    }

    private func refreshCount() { last24h = audit.read(now: now()).count }
}

extension CampusFetch {
    /// The value of a good read; a sign-out is noted on the store (so the whole app shows it) and everything else is nil.
    @MainActor func value(_ store: CampusStore) -> T? {
        switch self {
        case .ok(let v): return v
        case .unauthorized: store.markExpired(); return nil
        default: return nil
        }
    }
}
