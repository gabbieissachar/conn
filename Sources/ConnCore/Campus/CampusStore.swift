// CampusSource: the one in-memory feed behind the CAMPUS sidebar section, the live view, the transcript and the Watch column.
//
// It reads Campus through `CampusAuth` (never the cookie itself):
//   - the list: `GET /api/spaces`, then each space's conversations, every 30 s (every 60 s while the stream is up) and when a frame says
//     something changed; while Campus is starting or the sign-in is gone it asks again every 5 s;
//   - one event stream (`GET /api/events`) with reconnect and backoff; an idle stream (45 s without a byte) is cut and reopened, and a gap
//     is closed by reading the list again and the last 50 messages of every conversation being shown;
//   - for a conversation being shown (`retain`), its timeline: the backfill plus the frames applied on top.
// Frame names are Campus's, but the rows never trust them alone: any frame that may change a run's state makes one `GET .../status`
// (debounced), and that answer is what sets working / needs you / done / idle.
// Everything here is memory only. When the sign-in expires the last rows stay and `asOf` says when they were true (C9).
import Foundation
import Combine

@MainActor
public final class CampusStore: ObservableObject {
    @Published public private(set) var link: CampusLink
    @Published public private(set) var spaces: [CampusSpace] = []
    @Published public private(set) var conversations: [String: CampusConversation] = [:]
    /// The timelines of the conversations being shown. Not published as one: a text delta must redraw one conversation, not the window.
    /// A view that shows one listens to `timelineChanged` (the conversation id).
    public private(set) var timelines: [String: CampusTimeline] = [:]
    public let timelineChanged = PassthroughSubject<String, Never>()
    /// The question a conversation waits on (from `GET .../form` or `form.created`).
    @Published public private(set) var openForms: [String: CampusForm] = [:]
    /// When the rows were last known to be true: the last good answer or frame.
    @Published public private(set) var asOf: Date?
    @Published public private(set) var streamLive = false

    public let auth: CampusAuth?
    public let baseURL: URL
    public var client: CampusClient? { auth.map(CampusClient.init) }
    private let now: () -> Date

    // Timings (a test makes them short).
    public var pollInterval: TimeInterval = 30
    public var streamPollInterval: TimeInterval = 60
    public var retryInterval: TimeInterval = 5
    public var streamIdleLimit: TimeInterval = 45
    public var reconnectMax: TimeInterval = 15
    public var statusDelay: TimeInterval = 0.4

    private var loopTask: Task<Void, Never>?
    private var streamTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?
    private var kicked = false
    private var retained: [String: Int] = [:]
    private var queued: [String: [CampusFrame]] = [:]
    private var pendingStatus: Set<String> = []
    private var linked: Set<String> = []
    private var locallySeen: [String: Date] = [:]
    private var gap = false
    public private(set) var refreshCount = 0
    public private(set) var reconnects = 0
    private var lastBytes = Date()

    public init(auth: CampusAuth?, baseURL: URL, now: @escaping () -> Date = Date.init) {
        self.auth = auth; self.baseURL = baseURL; self.now = now
        link = auth == nil ? .disabled : .starting
    }

    // MARK: running

    public func start() {
        guard auth != nil, loopTask == nil else { return }
        loopTask = Task { [weak self] in await self?.pollLoop() }
        streamTask = Task { [weak self] in await self?.streamLoop() }
    }

    public func stop() {
        loopTask?.cancel(); streamTask?.cancel(); statusTask?.cancel()
        loopTask = nil; streamTask = nil; statusTask = nil
        auth?.closeEventStream()
    }

    /// Ask again now (the sign-in sheet closed, a window came back, a gap was closed).
    public func kick() { kicked = true }

    private func pollLoop() async {
        while !Task.isCancelled {
            kicked = false
            await refresh()
            let wait: TimeInterval
            switch link {
            case .live: wait = streamLive ? streamPollInterval : pollInterval
            case .starting, .expired: wait = retryInterval
            case .unreachable: wait = retryInterval * 2
            case .disabled: wait = 3600
            }
            var slept: TimeInterval = 0
            while slept < wait, !kicked, !Task.isCancelled { try? await Task.sleep(nanoseconds: 50_000_000); slept += 0.05 }
        }
    }

    private func streamLoop() async {
        var backoff: TimeInterval = 0.5
        while !Task.isCancelled {
            guard let auth = auth else { return }
            if link == .expired || link == .starting && refreshCount == 0 { try? await Task.sleep(nanoseconds: 100_000_000); continue }
            lastBytes = now()
            var reader = CampusSSEReader()
            let watchdog = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    guard let self = self else { return }
                    if self.now().timeIntervalSince(self.lastBytes) > self.streamIdleLimit { auth.closeEventStream(); return }
                }
            }
            for await ev in auth.openEventStream() {
                if Task.isCancelled { break }
                switch ev {
                case .opened(let status):
                    if status == 200 {
                        streamLive = true; backoff = 0.5; lastBytes = now()
                        if gap { gap = false; reconnects += 1; await closeGap() }
                    } else if status == 401 { setExpired() }
                    else if status == 503 { link = .starting }
                case .text(let t):
                    lastBytes = now()
                    for f in reader.feed(t) { handle(f) }
                case .closed:
                    break
                }
            }
            watchdog.cancel()
            streamLive = false
            gap = true
            if Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            backoff = min(reconnectMax, backoff * 2)
        }
    }

    /// The stream was away: read the list again and the messages of everything being shown, so nothing said in the gap is missing.
    private func closeGap() async {
        kick()
        for id in retained.keys { await backfill(id) }
    }

    // MARK: the list

    public func refresh() async {
        guard let client = client else { return }
        refreshCount += 1
        switch await client.spaces() {
        case .unauthorized: setExpired(); return
        case .starting: link = .starting; return
        case .failed(let why):
            if conversations.isEmpty && link != .expired { link = .unreachable(why) } else if link == .live { link = .unreachable(why) }
            return
        case .ok(let list): if list != spaces { spaces = list }
        }
        var next: [String: CampusConversation] = [:]
        var failedSpaces: Set<String> = []
        for s in spaces {
            switch await client.conversations(in: s) {
            case .unauthorized: setExpired(); return
            case .starting: link = .starting; return
            case .failed: failedSpaces.insert(s.id)
            case .ok(let list): for c in list { next[c.id] = merged(c) }
            }
        }
        // A space that did not answer keeps its rows; a conversation opened from a link stays until it is gone from Campus too.
        for (id, c) in conversations where next[id] == nil && (failedSpaces.contains(c.spaceID) || linked.contains(id)) { next[id] = c }
        if next != conversations { conversations = next }
        for id in openForms.keys where !(next[id]?.needsYou ?? false) { openForms[id] = nil }
        link = .live
        asOf = now()
        for c in next.values where c.needsYou && openForms[c.id] == nil { await loadForm(c) }
        for id in retained.keys where timelines[id]?.loaded != true { await backfill(id) }
    }

    private func merged(_ c: CampusConversation) -> CampusConversation {
        var c = c
        if let old = conversations[c.id] { c.ask = c.needsYou ? old.ask : nil; c.agent = old.agent; c.model = old.model }
        if let seen = locallySeen[c.id], seen == c.updatedAt { c.unread = false }
        return c
    }

    private func setExpired() {
        guard link != .expired else { return }
        link = .expired
        streamLive = false
        auth?.closeEventStream()
    }

    private func loadForm(_ c: CampusConversation) async {
        guard let client = client else { return }
        if case .ok(let forms) = await client.openForms(of: c), let f = forms.first {
            openForms[c.id] = f
            conversations[c.id]?.ask = CampusAsk(text: f.asText, tag: f.tag, at: conversations[c.id]?.updatedAt)
        }
    }

    /// One conversation named by a link (its kind, folder and id): added to the rows when Campus knows it.
    @discardableResult
    public func ensureConversation(kind: String, folder: String, id: String) async -> CampusConversation? {
        if let c = conversations[id] { return c }
        guard let client = client, ["private", "team"].contains(kind), CampusSpace.validFolder(folder), CampusSpace.validConversationID(id) else { return nil }
        if case .ok(var c) = await client.conversation(kind: kind, folder: folder, id: id) {
            if let sp = spaces.first(where: { $0.kind == kind && $0.folder == folder }) { c.spaceName = sp.displayName }
            linked.insert(id); conversations[id] = c
            if case .ok(let st) = await client.status(of: c) { applyStatus(id, st) }
            return conversations[id]
        }
        return nil
    }

    // MARK: what the views read

    public func conversation(_ id: String) -> CampusConversation? { conversations[id] }
    public func timeline(_ id: String) -> CampusTimeline? { timelines[id] }

    /// Rows are listed by need, then by recency: asks first (newest ask first), then working, done and idle, each newest first.
    public func sorted(_ list: [CampusConversation]) -> [CampusConversation] {
        func rank(_ c: CampusConversation) -> Int { c.state.listRank }
        func at(_ c: CampusConversation) -> Date { (c.state == .blocked ? c.ask?.at : nil) ?? c.updatedAt ?? .distantPast }
        return list.sorted { l, r in rank(l) != rank(r) ? rank(l) < rank(r) : at(l) > at(r) }
    }

    public func rows(inSpace id: String) -> [CampusConversation] { sorted(conversations.values.filter { $0.spaceID == id }) }
    public var privateRows: [CampusConversation] { sorted(conversations.values.filter { !$0.isTeam }) }
    public var teamRows: [CampusConversation] { sorted(conversations.values.filter { $0.isTeam }) }
    public var teamSpaces: [CampusSpace] { spaces.filter { $0.isTeam } }

    /// Questions waiting on the person. Not counted while the sign-in is gone: the rows are old news then (C9).
    public var asks: [CampusConversation] { link == .live ? sorted(conversations.values.filter { $0.needsYou }) : [] }
    public var workingCount: Int { conversations.values.filter { $0.working }.count }
    public func asks(inTeam team: Bool) -> Int { asks.filter { $0.isTeam == team }.count }
    public func working(inTeam team: Bool) -> Int { conversations.values.filter { $0.working && $0.isTeam == team }.count }

    /// Rows that wait on the person, then everything else in the order Watch fills and the quick switcher lists.
    public var attentionOrder: [CampusConversation] { sorted(Array(conversations.values)) }

    public func webURL(for c: CampusConversation) -> URL? { CampusClient.webURL(base: baseURL, kind: c.spaceKind, folder: c.folder, id: c.id) }

    /// The person looked at a conversation: it stops being "done" in Conn (Campus's own unread mark is left alone).
    public func markSeen(_ id: String) {
        guard var c = conversations[id], c.unread else { return }
        locallySeen[id] = c.updatedAt; c.unread = false; conversations[id] = c
    }

    // MARK: timelines

    /// A conversation is on screen (the live view, the transcript, a Watch column): keep its timeline and read its last messages.
    public func retain(_ id: String) {
        retained[id, default: 0] += 1
        if timelines[id] == nil { timelines[id] = CampusTimeline(); timelineChanged.send(id) }
        if retained[id] == 1 { Task { [weak self] in await self?.backfill(id) } }
    }

    public func release(_ id: String) {
        guard let n = retained[id] else { return }
        if n <= 1 { retained[id] = nil; timelines[id] = nil; queued[id] = nil; timelineChanged.send(id) } else { retained[id] = n - 1 }
    }

    public func isRetained(_ id: String) -> Bool { retained[id] != nil }

    public func backfill(_ id: String) async {
        guard let client = client, let c = conversations[id] else { return }
        let t0 = now()
        switch await client.messages(of: c) {
        case .ok(let items):
            guard timelines[id] != nil else { return }
            timelines[id]!.backfill(items, fetchedAt: t0)
            for f in queued.removeValue(forKey: id) ?? [] { timelines[id]?.apply(f) }
            timelineChanged.send(id)
            if case .ok(let st) = await client.status(of: c) { applyStatus(id, st) }
            if c.needsYou { await loadForm(c) }
            if c.agent == nil, case .ok(let detail) = await client.conversation(kind: c.spaceKind, folder: c.folder, id: id) {
                conversations[id]?.agent = detail.agent; conversations[id]?.model = detail.model
            }
        case .unauthorized: setExpired()
        case .starting: link = .starting
        case .failed: break
        }
    }

    // MARK: frames

    public func handle(_ f: CampusFrame) {
        let t = now()
        if asOf.map({ t.timeIntervalSince($0) > 1 }) ?? true { asOf = t }
        guard let sid = f.sessionID else { return }
        switch f.type {
        case "session.created", "session.renamed", "session.metadata.updated", "session.deleted":
            kick()
        case "form.created":
            if let form = CampusForm.parse(f.data), conversations[sid] != nil {
                openForms[sid] = form
                conversations[sid]?.ask = CampusAsk(text: form.asText, tag: form.tag, at: f.created ?? now())
                conversations[sid]?.needsYou = true; conversations[sid]?.working = false
            }
        case "session.execution.started", "session.step.started":
            if conversations[sid]?.working == false { conversations[sid]?.working = true; conversations[sid]?.needsYou = false; openForms[sid] = nil }
        default: break
        }
        if conversations[sid] == nil { kick() }
        if timelines[sid] != nil {
            if timelines[sid]!.loaded { timelines[sid]!.apply(f); timelineChanged.send(sid) } else { queued[sid, default: []].append(f); if queued[sid]!.count > 2000 { queued[sid]!.removeFirst(500) } }
        }
        if !f.type.hasSuffix(".delta"), f.type != "session.tool.progress", conversations[sid] != nil { scheduleStatus(sid) }
    }

    private func scheduleStatus(_ id: String) {
        pendingStatus.insert(id)
        guard statusTask == nil else { return }
        statusTask = Task { [weak self] in
            while let self = self, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(self.statusDelay * 1_000_000_000))
                let ids = self.pendingStatus; self.pendingStatus = []
                for id in ids { await self.readStatus(id) }
                if self.pendingStatus.isEmpty { self.statusTask = nil; return }
            }
        }
    }

    private func readStatus(_ id: String) async {
        guard let client = client, let c = conversations[id] else { return }
        switch await client.status(of: c) {
        case .ok(let st): applyStatus(id, st)
        case .unauthorized: setExpired()
        default: break
        }
    }

    /// `status.state` sets the row: busy is working, needs_you is a question, idle is done (unread) or idle.
    func applyStatus(_ id: String, _ st: CampusStatus) {
        guard var c = conversations[id] else { return }
        let was = c
        c.working = st.run == .busy
        c.needsYou = st.run == .needsYou
        // A conversation on screen is being read: it does not turn "done" under the person's eyes.
        c.unread = st.unread && locallySeen[id] != c.updatedAt && retained[id] == nil
        if !c.needsYou { c.ask = nil; openForms[id] = nil }
        if c != was { conversations[id] = c }
        if c.needsYou && openForms[id] == nil { Task { [weak self] in await self?.loadForm(c) } }
        if !c.working, !c.needsYou, timelines[id]?.loaded == true, let last = timelines[id]?.items.last, last.kind != .idle, last.kind != .stopped, last.kind != .user {
            timelines[id]!.finishRun(tokens: timelines[id]!.lastTokens ?? "")
            timelineChanged.send(id)
        }
    }

    /// For checks and tests: set a row state without a request.
    public func setConversation(_ c: CampusConversation) { conversations[c.id] = c }
}
