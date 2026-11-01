// One terminal slot: the engine that holds the screen, the stream feeding it, and the reconnect policy.
// All state lives on the main queue; sources deliver there.
import Foundation
import Combine

public final class PaneSession: ObservableObject {
    public enum State: Equatable {
        case idle
        case starting
        case live
        case reconnecting(attempt: Int, reason: String)
        case failed(String)
    }

    public struct Stats: Equatable {
        public var frames = 0
        public var fullFrames = 0
        public var bytes = 0
        public var seqGaps = 0
        public var applyNanosTotal: UInt64 = 0
        public var applyNanosMax: UInt64 = 0
        public var reconnects = 0
        /// arrival-to-applied (queue hop plus decode into the engine), nanoseconds, for the last frame.
        public var lastArrivalToAppliedNanos: UInt64 = 0
    }

    public let engine: TerminalEngine
    @Published public private(set) var state: State = .idle
    @Published public private(set) var paneID: String?
    @Published public private(set) var cols = 0
    @Published public private(set) var rows = 0
    public private(set) var stats = Stats()
    public private(set) var framesSinceStart = 0
    /// Called on the main queue after every frame is applied (the view invalidates itself here).
    public var onApplied: (() -> Void)?
    /// Called when the process says the stream protocol is refused; the owner can switch to the text source.
    public var onProtocolMismatch: (() -> Void)?

    public var source: PaneStreamSource
    public var processID: Int32? { source.processID }
    public var backoffInitial: TimeInterval = 0.5
    public var backoffMax: TimeInterval = 8

    private var generation = 0
    private var expectedSeq: UInt64?
    private var attempt = 0
    private var startedAt = Date()
    private let queue: DispatchQueue

    public init(engine: TerminalEngine, source: PaneStreamSource, queue: DispatchQueue = .main) {
        self.engine = engine
        self.source = source
        self.queue = queue
    }

    /// Point this slot at a pane; reopens the stream when the pane or its native size changes.
    public func configure(pane id: String?, size: PaneSize?) {
        let c = min(500, max(20, size?.cols ?? 100)), r = min(300, max(5, size?.rows ?? 30))
        guard id != paneID || c != cols || r != rows else { return }
        paneID = id; cols = c; rows = r
        attempt = 0
        restart()
    }

    public func replaceSource(_ s: PaneStreamSource) {
        source.stop()
        source = s
        if paneID != nil { restart() }
    }

    /// Reopen the stream now (wake from sleep, a Herdr restart noticed by the store).
    public func restart() {
        source.stop()
        generation += 1
        let g = generation
        expectedSeq = nil
        framesSinceStart = 0
        startedAt = Date()
        engine.resize(cols: max(cols, 20), rows: max(rows, 5))
        engine.reset()
        onApplied?()
        guard let id = paneID else { state = .idle; return }
        state = attempt == 0 ? .starting : state
        source.start(pane: id, cols: cols, rows: rows, queue: queue, onFrame: { [weak self] frame, arrived in
            guard let self = self, self.generation == g else { return }
            self.apply(frame, arrivedAt: arrived)
        }, onEnd: { [weak self] end in
            guard let self = self, self.generation == g else { return }
            self.ended(end)
        })
    }

    public func stop() {
        generation += 1
        source.stop()
        state = .idle
    }

    private func apply(_ f: TerminalFrame, arrivedAt: UInt64) {
        let t0 = monotonicNanos()
        if f.full {
            expectedSeq = f.seq &+ 1
        } else if let e = expectedSeq {
            if f.seq != e { stats.seqGaps += 1 }
            expectedSeq = f.seq &+ 1
        }
        engine.apply(f)
        let t1 = monotonicNanos()
        stats.frames += 1
        if f.full { stats.fullFrames += 1 }
        stats.bytes += f.bytes.count
        stats.applyNanosTotal &+= t1 - t0
        stats.applyNanosMax = max(stats.applyNanosMax, t1 - t0)
        stats.lastArrivalToAppliedNanos = t1 &- arrivedAt
        framesSinceStart += 1
        if state != .live { state = .live; attempt = 0 }
        onApplied?()
    }

    private func ended(_ end: StreamEnd) {
        var reason: String
        switch end {
        case .failedToStart(let r): reason = r
        case .exited(let status, let stderr): reason = stderr.isEmpty ? "stream ended (exit \(status))" : String(stderr.suffix(160))
        }
        let lower = reason.lowercased()
        if lower.contains("protocol_mismatch") || lower.contains("protocol mismatch") {
            state = .failed(reason)
            onProtocolMismatch?()
            return
        }
        // A stream that ran for a while was healthy: start the backoff over.
        if framesSinceStart > 0 && Date().timeIntervalSince(startedAt) > 5 { attempt = 0 }
        attempt += 1
        stats.reconnects += 1
        state = .reconnecting(attempt: attempt, reason: reason)
        let delay = min(backoffMax, backoffInitial * pow(2, Double(attempt - 1)))
        let g = generation
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.generation == g, self.paneID != nil else { return }
            self.restart()
        }
    }
}
