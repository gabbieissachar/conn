// The sidebar's data: `session.snapshot` plus `events.subscribe`, kept current across reconnects.
//
// Events are cache invalidation, not state: every event (coalesced over 150 ms) triggers a fresh snapshot read, as the
// Herdr docs prescribe. Per-pane status events need a pane id, so the subscription is rebuilt whenever the pane set
// changes. A health ping on its own connection catches a connection that died silently (sleep, a wedged server).
import Foundation
import Combine

public final class HerdrStore: ObservableObject {
    public enum Link: Equatable {
        case connecting, live, fixture
        case reconnecting(String)
    }

    @Published public private(set) var snapshot = Snapshot.empty
    @Published public private(set) var link: Link = .connecting
    @Published public private(set) var eventCount = 0
    @Published public private(set) var snapshotMillis: Double = 0
    @Published public private(set) var snapshotBytes = 0
    @Published public private(set) var reconnectCount = 0
    /// How long the last outage lasted, from the connection loss to the first good snapshot afterwards.
    @Published public private(set) var lastOutageSeconds: Double?

    public let client: HerdrClient
    public let isFixture: Bool
    public var backoffInitial: TimeInterval = 0.5
    public var backoffMax: TimeInterval = 2
    public var pingInterval: TimeInterval = 20

    private var stopped = false
    private let lock = NSLock()
    private var activeSub: UnixLineSocket?
    private var refreshPending = false
    private var generation = 0
    private var outageStartedAt: Date?
    /// Published state changes land on this queue (the main queue in the app).
    private let queue: DispatchQueue

    public init(client: HerdrClient, queue: DispatchQueue = .main) {
        self.client = client
        self.queue = queue
        self.isFixture = false
    }

    public init(client: HerdrClient, fixture: Snapshot, queue: DispatchQueue = .main) {
        self.client = client
        self.queue = queue
        self.isFixture = true
        self.snapshot = fixture
        self.link = .fixture
    }

    public func start() {
        guard !isFixture else { return }
        lock.lock(); stopped = false; generation += 1; let g = generation; lock.unlock()
        Thread.detachNewThread { [weak self] in self?.runLoop(generation: g) }
    }

    public func stop() {
        lock.lock(); stopped = true; generation += 1; let sub = activeSub; lock.unlock()
        sub?.shutdown()
    }

    /// Drop the current connection and reconnect now (wake from sleep).
    public func reconnectNow() {
        lock.lock(); let sub = activeSub; lock.unlock()
        sub?.shutdown()
    }

    public func fixtureSet(_ paneID: String, state: AgentState) {
        guard isFixture else { return }
        var s = snapshot
        s.setState(paneID, to: state)
        snapshot = s
    }

    private func isCurrent(_ g: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return !stopped && generation == g }

    private func publish(_ snap: Snapshot, millis: Double, bytes: Int) {
        queue.async {
            if self.snapshot != snap { self.snapshot = snap }
            self.snapshotMillis = millis
            self.snapshotBytes = bytes
            if let t = self.outageStartedAt { self.lastOutageSeconds = Date().timeIntervalSince(t); self.outageStartedAt = nil }
            self.link = .live
        }
    }

    private func setLink(_ l: Link) {
        queue.async {
            if case .reconnecting = l, self.outageStartedAt == nil { self.outageStartedAt = Date() }
            if case .reconnecting = l { self.reconnectCount += 1 }
            self.link = l
        }
    }

    private func fetchSnapshot() -> (Snapshot, Double, Int)? {
        let t0 = Date()
        guard let obj = try? client.call(.snapshot), let snap = Snapshot(response: obj) else { return nil }
        let ms = Date().timeIntervalSince(t0) * 1000
        let bytes = (try? JSONSerialization.data(withJSONObject: obj).count) ?? 0
        return (snap, ms, bytes)
    }

    private static let lifecycleEvents = ["workspace.created", "workspace.updated", "workspace.renamed", "workspace.moved", "workspace.reordered",
                                          "workspace.closed", "workspace.focused", "tab.created", "tab.closed", "tab.focused", "tab.renamed",
                                          "tab.moved", "pane.created", "pane.updated", "pane.closed", "pane.focused", "pane.moved", "pane.exited",
                                          "pane.agent_detected", "layout.updated"]

    private func runLoop(generation g: Int) {
        var backoff = backoffInitial
        func wait() { Thread.sleep(forTimeInterval: backoff); backoff = min(backoff * 2, backoffMax) }
        while isCurrent(g) {
            guard let sock = UnixLineSocket(path: client.endpoint.socketPath) else {
                setLink(.reconnecting("no socket for session \(client.endpoint.session)")); wait(); continue
            }
            lock.lock(); activeSub = sock; lock.unlock()
            // Per-pane status events need a pane id, so read a snapshot first to learn the pane set.
            guard let (first, ms, bytes) = fetchSnapshot() else {
                sock.close(); setLink(.reconnecting("snapshot failed")); wait(); continue
            }
            var subscribed = Set(first.paneIDs)
            var subs: [[String: Any]] = Self.lifecycleEvents.map { ["type": $0] }
            subs += first.paneIDs.map { ["type": "pane.agent_status_changed", "pane_id": $0] }
            guard sock.writeLine(["id": "helm_events.subscribe", "method": "events.subscribe", "params": ["subscriptions": subs]]),
                  let ack = sock.readJSON(timeout: 10), ack["error"] == nil else {
                sock.close(); setLink(.reconnecting("subscribe refused")); wait(); continue
            }
            backoff = backoffInitial
            publish(first, millis: ms, bytes: bytes)
            startPinger(sock: sock, generation: g)
            while isCurrent(g), let line = sock.readLine() {
                guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
                if obj["error"] != nil { break }                        // events_lost: resubscribe and resnapshot
                queue.async { self.eventCount += 1 }
                scheduleRefresh { [weak self] snap, ms, bytes in
                    guard let self = self else { return }
                    self.publish(snap, millis: ms, bytes: bytes)
                    if Set(snap.paneIDs) != subscribed { subscribed = Set(snap.paneIDs); sock.shutdown() } // pane set changed: resubscribe
                }
            }
            sock.close()
            if isCurrent(g) { setLink(.reconnecting("connection closed")); Thread.sleep(forTimeInterval: backoffInitial) }
        }
    }

    /// Closes `sock` if a ping on a fresh connection fails twice in a row, so a silently dead subscription reconnects.
    private func startPinger(sock: UnixLineSocket, generation g: Int) {
        let interval = pingInterval
        Thread.detachNewThread { [weak self] in
            var failures = 0
            while let self = self, self.isCurrent(g) {
                Thread.sleep(forTimeInterval: interval)
                guard self.isCurrent(g) else { return }
                self.lock.lock(); let current = self.activeSub === sock; self.lock.unlock()
                if !current { return }
                if (try? self.client.call(.ping)) == nil { failures += 1 } else { failures = 0 }
                if failures >= 2 { sock.shutdown(); return }
            }
        }
    }

    /// Events are cache invalidation: coalesce a burst into one authoritative snapshot read.
    private func scheduleRefresh(_ done: @escaping (Snapshot, Double, Int) -> Void) {
        lock.lock()
        if refreshPending { lock.unlock(); return }
        refreshPending = true
        lock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self = self else { return }
            self.lock.lock(); self.refreshPending = false; self.lock.unlock()
            if let (snap, ms, bytes) = self.fetchSnapshot() { done(snap, ms, bytes) }
        }
    }
}
