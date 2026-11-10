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
    /// How often a waiting request reads its thread's status when the event stream is not delivering (the fallback). With the stream live the request reads on each event that can
    /// change the answer (a run ending, a question, a permission request) and only this often otherwise (`eventPollInterval`, a safety net for an event that never came).
    public var pollInterval: TimeInterval = 3
    public var eventPollInterval: TimeInterval = 10
    /// A run is read again this soon while an event has just come for it and the status has not caught up yet.
    public var settleInterval: TimeInterval = 0.5
    /// How often the inbox is read when its folder cannot be watched (the fallback), and how often as a safety net while the watch is working.
    public var scanInterval: TimeInterval = 2
    public var watchedScanInterval: TimeInterval = 10
    /// Watch the inbox folder and read it the moment a record arrives. Off: only the timer reads it.
    public var watchInbox = true
    /// After a send, how long a thread may stay idle without a new reply before the request says so.
    public var startGrace: TimeInterval = 20
    /// How long Conn keeps watching a thread that was still working when its request's wait ended, to write the end to `<request id>.late`.
    public var lateBudget: TimeInterval = 1800
    public var preamble = BridgeCommand.preamble
    /// The agents a request may name. A caller never picks the thread's powers: only these (read-only, planning) agents are accepted, `plan` by default; any other name is refused
    /// before anything is sent. Settable from Conn's settings (`conn.campus.bridge.agents`), never from a request.
    public var allowedAgents: [String] = [BridgeCommand.defaultAgent]

    public let store: CampusStore
    public let registry: BridgeRegistry
    public let ownership: BridgeOwnership
    public let audit: BridgeAuditLog
    private let now: () -> Date
    private let pid: Int32

    private var scanTask: Task<Void, Never>?
    private var inboxWatch: BridgeFolderWatch?
    private var rescanPending = false
    public let wake = BridgeWake()
    private var frameSubscription: AnyCancellable?
    private var tasks: [String: Task<Void, Never>] = [:]
    /// Threads still watched after a `working` reply, by request id: each ends by writing `<request id>.late`.
    private var lateTasks: [String: Task<Void, Never>] = [:]
    /// New threads whose request was accepted but not yet in the audit: they count against the caps at once, so a burst cannot pass the check together.
    private var reservedNew: [String: (home: String, at: Date)] = [:]
    private var runningNew = 0
    private var runningThreads: Set<String> = []
    /// Threads with a `continue` between its check and its audit entry: one at a time per thread, so two requests cannot both pass the turn cap on the same count.
    private var continuing: Set<String> = []
    private var finishedBroken: Set<String> = []

    public init(store: CampusStore, registry: BridgeRegistry, ownership: BridgeOwnership, audit: BridgeAuditLog, callers: BridgeCallers = BridgeCallers(), pid: Int32 = getpid(), now: @escaping () -> Date = Date.init) {
        self.store = store; self.registry = registry; self.ownership = ownership; self.audit = audit; self.callers = callers; self.pid = pid; self.now = now
        registry.clearStale(pid: pid)
        refreshCount()
        frameSubscription = store.frameSeen.sink { [weak self] f in
            guard let self = self, let sid = f.sessionID, BridgeWake.wakes(on: f.type) else { return }
            self.wake.signal(sid, settle: BridgeWake.settles(on: f.type))
        }
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
            armInboxWatch()
            scanTask = Task { [weak self] in
                while !Task.isCancelled {
                    self?.scan()
                    self?.armInboxWatch()
                    let watched = self?.inboxWatch != nil
                    let every = watched ? (self?.watchedScanInterval ?? 10) : (self?.scanInterval ?? 2)
                    try? await Task.sleep(nanoseconds: UInt64(max(0.02, every) * 1_000_000_000))
                }
            }
        } else {
            enabled = false
            scanTask?.cancel(); scanTask = nil
            inboxWatch?.stop(); inboxWatch = nil
            registry.unregister(pid: pid)
            wake.signalAll()
        }
    }

    /// Watch the inbox folder (made again when it was removed under the watch): a record is read within milliseconds of arriving. The timer keeps reading it as the fallback.
    private func armInboxWatch() {
        guard enabled, watchInbox else { return }
        if let w = inboxWatch, !w.isLost { return }
        inboxWatch?.stop(); inboxWatch = nil
        inboxWatch = BridgeFolderWatch(directory: registry.inbox) { [weak self] in
            Task { @MainActor in self?.scan() }
        }
    }

    /// Whether the inbox is being watched (the check and the tests read this).
    public var watchingInbox: Bool { inboxWatch != nil && inboxWatch?.isLost == false }

    /// Quit: leave the registry so `fm-who campus` does not name a process that is gone.
    public func shutdown() { setEnabled(false) }

    // MARK: reading the inbox

    /// Look at the inbox now: every record not already being answered starts its own request. Public so a test can drive it.
    public func scan() {
        guard enabled else { return }
        for (name, data) in registry.pending() where tasks[name] == nil && !finishedBroken.contains(name) {
            let record = BridgeRecordParser.parse(data, fileName: name)
            // A record that does not read and was written a moment ago may be half written (a writer that does not stage and rename): look again shortly instead of moving it aside.
            if record == nil, registry.age(of: name).map({ $0 < 1 }) ?? false { rescanSoon(); continue }
            tasks[name] = Task { [weak self] in
                guard let self = self else { return }
                await self.process(name: name, record: record)
                self.tasks[name] = nil
            }
        }
    }

    private func rescanSoon() {
        guard !rescanPending else { return }
        rescanPending = true
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            self?.rescanPending = false
            self?.scan()
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

    /// Wait until every thread watched after a `working` reply has been written to its `.late` file (tests).
    public func waitLateIdle() async {
        while true {
            let running = Array(lateTasks.values)
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
        if let a = command.agent, !allowedAgents.contains(a) { return finish(c, .init(.refused, thread: c.thread, reason: "agent '\(a)' is not allowed: the bridge uses \(allowedAgents.joined(separator: ", "))")) }
        if command.answer != nil, !command.text.isEmpty { return finish(c, .init(.failed, thread: c.thread, reason: "format: give either a message or an answer, not both")) }
        // Campus must be signed in and answering; a signed-out Campus is an answer at once, never a queue.
        switch store.link {
        case .live: break
        case .expired: return finish(c, .init(.signedOut, thread: c.thread, reason: "Campus is signed out: sign in in Conn"))
        case .blocked: return finish(c, .init(.failed, thread: c.thread, reason: CampusNetworkBlock.short))
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
        if r.blockedByNetwork { store.markBlocked(); return finish(c, .init(.failed, reason: CampusNetworkBlock.short)) }
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
        // Reserved before any await and released after the audit entry is written (finish runs inside), so the turn count below is complete when it is read.
        guard continuing.insert(id).inserted else { return finish(c, .init(.refused, thread: id, reason: "another request is already using this thread: wait for its reply")) }
        defer { continuing.remove(id) }
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
            if r.blockedByNetwork { store.markBlocked(); return finish(c, .init(.failed, thread: id, reason: CampusNetworkBlock.short)) }
            guard (200..<300).contains(r.status) else { return finish(c, .init(.failed, thread: id, reason: r.failureText)) }
            finish(c, await awaitRun(conv, baseline: baseline, sent: true))
        case .idle, .unknown:
            if cmd.answer != nil { return finish(c, .init(.refused, thread: id, reason: "the thread is not waiting for an answer: send a message instead")) }
            if activeCount(excluding: id) >= limits.working { return finish(c, .init(.refused, thread: id, reason: "\(limits.working) bridge threads are already working: wait for one to finish")) }
            let baseline = await latestAssistant(conv, client: client)?.id
            guard let r = await client.auth.perform(CampusClient.promptRequest(conv, text: cmd.text, delivery: nil)) else { return finish(c, .init(.failed, thread: id, reason: "Campus did not answer")) }
            if r.signedOut { store.markExpired(); return finish(c, .init(.signedOut, thread: id, reason: "Campus is signed out: sign in in Conn")) }
            if r.blockedByNetwork { store.markBlocked(); return finish(c, .init(.failed, thread: id, reason: CampusNetworkBlock.short)) }
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
    private func awaitRun(_ conv: CampusConversation, baseline: String?, sent: Bool, late: Bool = false) async -> BridgeReply {
        guard let client = store.client else { return .init(.failed, thread: conv.id, reason: "no Campus connection") }
        let start = now()
        let deadline = start.addingTimeInterval(late ? lateBudget : waitBudget)
        var sawBusy = false, errors = 0
        while true {
            if !enabled { return .init(.failed, thread: conv.id, url: url(conv), reason: "the Agent bridge was switched off while this request waited") }
            // The person can take a thread away from agents while a request (above all a late watch) waits on it: nothing more is read from it.
            if ownership.share(for: conv.id) == nil { return Self.noLongerShared(conv.id) }
            // Noted before the status is read: an event that comes while it is being read makes the wait below return at once.
            let seen = wake.count(of: conv.id)
            switch await client.status(of: conv) {
            case .unauthorized: store.markExpired(); return .init(.signedOut, thread: conv.id, url: url(conv), reason: "Campus is signed out: sign in in Conn")
            case .blocked: store.markBlocked(); return .init(.failed, thread: conv.id, url: url(conv), reason: CampusNetworkBlock.short)
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
            if now() >= deadline {
                if late { return .init(.working, thread: conv.id, url: url(conv), reason: "the thread was still working after \(Int(lateBudget / 60)) minutes and Conn stopped watching it: read it with 'campus: read \(conv.id)'") }
                var r = BridgeReply(.working, thread: conv.id, url: url(conv), reason: "the thread is still working: Conn keeps watching it and writes its end to the late reply file; or read it with 'campus: read \(conv.id)'")
                r.watchLate = true
                return r
            }
            await wake.wait(for: conv.id, since: seen, timeout: min(waitTimeout(for: conv.id), max(0.01, deadline.timeIntervalSince(now()))))
        }
    }

    /// How long to wait for an event before reading the status anyway: the poll interval while the stream is down; the longer safety-net interval while it is live; and, for a few
    /// seconds after an event for this thread (the status may not have caught up with it), the short settle interval.
    private func waitTimeout(for id: String) -> TimeInterval {
        let base = store.streamLive ? max(pollInterval, eventPollInterval) : pollInterval
        return wake.recent(id, within: 3) ? min(base, settleInterval) : base
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
        switch store.link {
        case .expired: return .init(.signedOut, thread: id, reason: "Campus is signed out: sign in in Conn")
        case .blocked: return .init(.failed, thread: id, reason: CampusNetworkBlock.short)
        default: return .init(.failed, thread: id, reason: "Campus did not answer")
        }
    }

    /// Write the answer, hand the record back, record the use.
    private func finish(_ c: Ctx, _ reply: BridgeReply) {
        var reply = reply
        if reply.thread == nil { reply.thread = c.thread }
        // A wait that ran out on a thread Conn can still watch promises the end in `<request id>.late`.
        let lateThread = reply.watchLate && enabled ? reply.thread.flatMap { store.conversation($0) } : nil
        reply.watchLate = false
        if lateThread != nil { reply.lateFile = BridgeRegistry.lateName(c.requestID) }
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
        if let conv = lateThread { watchLate(c, conv) }
    }

    /// Keep watching a thread that was still working when the wait ended, and write its end to `<request id>.late` (the same text a reply has). The first reply stays as it is. A Conn
    /// that quits before the thread ends writes a `failed` late reply as the switch goes off; a Conn that is killed loses the watch (the caller still has `campus: read`).
    private func watchLate(_ c: Ctx, _ conv: CampusConversation) {
        let id = c.requestID
        guard lateTasks[id] == nil else { return }
        lateTasks[id] = Task { [weak self] in
            guard let self = self else { return }
            let out = await self.awaitRun(conv, baseline: nil, sent: false, late: true)
            self.finishLate(c, out)
            self.lateTasks[id] = nil
        }
    }

    static func noLongerShared(_ id: String) -> BridgeReply { .init(.refused, thread: id, reason: "that thread is no longer shared with agents: nothing was read from it") }

    private func finishLate(_ c: Ctx, _ reply: BridgeReply) {
        var reply = reply
        // Checked again at the write: a thread taken away from agents after the last read gets no text in a file.
        if reply.thread.map({ ownership.share(for: $0) == nil }) ?? false, reply.status != .failed, reply.status != .refused { reply = Self.noLongerShared(reply.thread ?? "") }
        if reply.thread == nil { reply.thread = c.thread }
        reply.watchLate = false
        let entry = BridgeAuditEntry(at: now(), sender: c.sender.isEmpty ? "?" : c.sender, kind: c.kind, requestID: c.requestID, thread: reply.thread ?? c.thread, action: "late", bytes: c.bytes, sha256: c.sha, outcome: reply.status.rawValue)
        do { try registry.writeLateReply(id: c.requestID, body: reply.render(), now: now()) } catch {
            note(BridgeActivity(at: now(), sender: entry.sender, action: "late", thread: entry.thread, outcome: "failed", reason: "could not write the late reply: \(error)", bytes: c.bytes))
            audit.append(entry); refreshCount()
            return
        }
        audit.append(entry)
        note(BridgeActivity(at: now(), sender: entry.sender, action: "late", thread: entry.thread, outcome: reply.status.rawValue, reason: reply.reason, bytes: c.bytes))
        refreshCount()
    }

    private func note(_ a: BridgeActivity) {
        activity.insert(a, at: 0)
        if activity.count > 100 { activity.removeLast(activity.count - 100) }
    }

    /// Requests in the last 24 hours (the late reply of a request is not another request).
    private func refreshCount() { last24h = audit.read(now: now()).filter { $0.action != "late" }.count }
}

extension CampusFetch {
    /// The value of a good read; a sign-out is noted on the store (so the whole app shows it) and everything else is nil.
    @MainActor func value(_ store: CampusStore) -> T? {
        switch self {
        case .ok(let v): return v
        case .unauthorized: store.markExpired(); return nil
        case .blocked: store.markBlocked(); return nil
        default: return nil
        }
    }
}
