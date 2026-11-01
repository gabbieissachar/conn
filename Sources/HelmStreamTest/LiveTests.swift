// The D2 stream test, read-only. Everything here talks to Herdr through the same code the app uses:
// HerdrClient (snapshot, pane.read, ping), ObserveProcessSource (the pane stream) and HerdrStore (sidebar events).
// No request that changes a pane exists in this file.
import Foundation
import HelmCore
import Darwin

enum LiveTests {
    static func pickPanes(_ snap: Snapshot, count: Int, workingFirst: Bool = true) -> [Agent] {
        let ordered = workingFirst
            ? snap.agents.sorted { ($0.state == .working ? 0 : 1) < ($1.state == .working ? 0 : 1) }
            : snap.agents
        return Array(ordered.prefix(count))
    }

    // MARK: compatibility

    static func compat(_ endpoint: HerdrEndpoint) -> [String: Any] {
        let t0 = Date()
        guard let status = HerdrCompatibility.probe(endpoint: endpoint) else { return ["error": "status probe failed"] }
        let verdict = HerdrCompatibility.verdict(for: status)
        return ["client": ["version": status.clientVersion, "protocol": status.clientProtocol],
                "server": ["version": status.serverVersion, "protocol": status.serverProtocol, "running": status.serverRunning],
                "verdict": "\(verdict)", "probeMillis": Int(Date().timeIntervalSince(t0) * 1000)]
    }

    // MARK: stream versus the server's own screen

    /// Compares when the stream shows a screen state with when `pane.read` (the server's own view of the pane) first
    /// reported the same text. The poller samples at `pollInterval`, so lags are good to about that resolution.
    static func lag(_ endpoint: HerdrEndpoint, pane: Agent, size: PaneSize, seconds: Double, pollInterval: Double = 0.05) -> [String: Any] {
        let client = HerdrClient(endpoint: endpoint)
        let engine = GridEngine()
        let q = DispatchQueue(label: "lag")
        let lock = NSLock()
        var pollStates: [(t: UInt64, text: String, prev: UInt64)] = []
        var lastPollReply: UInt64 = 0
        var engineStates: [(t: UInt64, text: String)] = []
        var lastEngine = ""
        var frames = 0, fullFrames = 0, bytes = 0
        var arrivals: [UInt64] = []
        var applyNanos: [Double] = []
        var firstFrameAt: UInt64?
        let source = ObserveProcessSource(endpoint: endpoint)
        let start = monotonicNanos()
        var pollCount = 0, pollFailures = 0
        var pollMillis: [Double] = []
        var stop = false
        let poller = Thread {
            var last = ""
            while true {
                lock.lock(); let done = stop; lock.unlock()
                if done { return }
                let t0 = monotonicNanos()
                if let text = try? client.readPane(pane.id, source: .visible, ansi: false) {
                    let t1 = monotonicNanos()
                    let n = normalizedText(text)
                    lock.lock()
                    pollCount += 1
                    pollMillis.append(Double(t1 - t0) / 1e6)
                    if n != last { last = n; pollStates.append((t1, n, lastPollReply)) }
                    lastPollReply = t1
                    lock.unlock()
                } else { lock.lock(); pollFailures += 1; lock.unlock() }
                Thread.sleep(forTimeInterval: pollInterval)
            }
        }
        poller.start()
        source.start(pane: pane.id, cols: size.cols, rows: size.rows, queue: q, onFrame: { frame, arrived in
            let a0 = monotonicNanos()
            engine.apply(frame)
            let a1 = monotonicNanos()
            let text = normalizedScreen(engine)
            lock.lock()
            frames += 1; if frame.full { fullFrames += 1 }; bytes += frame.bytes.count
            arrivals.append(arrived)
            applyNanos.append(Double(a1 - a0) / 1e6)
            if firstFrameAt == nil { firstFrameAt = arrived }
            if text != lastEngine { lastEngine = text; engineStates.append((arrived, text)) }
            lock.unlock()
        }, onEnd: { end in log("lag: stream ended: \(end)") })
        Thread.sleep(forTimeInterval: seconds)
        source.stop()
        lock.lock(); stop = true; lock.unlock()
        Thread.sleep(forTimeInterval: pollInterval * 2)
        lock.lock(); defer { lock.unlock() }

        let matched = ScreenMatcher.match(stream: engineStates.dropFirst().map { Sighting(t: $0.t, text: $0.text) },
                                          polls: pollStates.map { Sighting(t: $0.t, text: $0.text, previousPollAt: $0.prev) })
        let lags = matched.lowerBoundMillis, lagsUpper = matched.upperBoundMillis, unmatchedEngine = matched.unmatched
        let engineSet = Set(engineStates.map(\.text))
        let pollOnly = pollStates.dropFirst().filter { !engineSet.contains($0.text) }.count
        var gaps: [Double] = []
        for i in arrivals.indices.dropFirst() { gaps.append(Double(arrivals[i] - arrivals[i - 1]) / 1e6) }
        return [
            "pane": "(content not recorded)", "paneSize": "\(size.cols)x\(size.rows)", "seconds": seconds,
            "frames": frames, "fullFrames": fullFrames, "bytes": bytes,
            "framesPerSecond": Double(frames) / seconds, "bytesPerSecond": Double(bytes) / seconds,
            "firstFrameMillis": firstFrameAt.map { Double($0 - start) / 1e6 } ?? -1,
            "engineScreenChanges": engineStates.count, "pollScreenChanges": pollStates.count,
            "pollSamples": pollCount, "pollFailures": pollFailures, "pollRequestMillis": Distribution(values: pollMillis).json,
            "matchedStates": lags.count, "streamStatesNeverSeenByPoll": unmatchedEngine, "pollStatesNeverShownByStream": pollOnly,
            "streamLagBehindPaneReadMillis(lowerBound)": Distribution(values: lags).json,
            "streamLagBehindPaneReadMillis(upperBound)": Distribution(values: lagsUpper).json,
            "frameInterArrivalMillis": Distribution(values: gaps).json,
            "decodeAndApplyMillis": Distribution(values: applyNanos).json,
            "unhandledSequences": engine.unhandledSequenceCount,
            "pollResolutionMillis": pollInterval * 1000,
        ]
    }

    // MARK: switching panes: spawn to first frame

    static func coldStart(_ endpoint: HerdrEndpoint, panes: [Agent], sizes: [String: PaneSize], rounds: Int) -> [String: Any] {
        var samples: [Double] = []
        var failures = 0
        let q = DispatchQueue(label: "cold")
        for i in 0..<rounds {
            let pane = panes[i % panes.count]
            let size = sizes[pane.id] ?? PaneSize(cols: 66, rows: 59)
            let source = ObserveProcessSource(endpoint: endpoint)
            var first: UInt64?
            let t0 = monotonicNanos()
            source.start(pane: pane.id, cols: size.cols, rows: size.rows, queue: q, onFrame: { _, arrived in if first == nil { first = arrived } }, onEnd: { _ in })
            if sleepUntil(5, { q.sync { first != nil } }) { samples.append(Double(q.sync { first! } - t0) / 1e6) } else { failures += 1 }
            source.stop()
            Thread.sleep(forTimeInterval: 0.2)
        }
        return ["rounds": rounds, "failures": failures, "spawnToFirstFrameMillis": Distribution(values: samples).json]
    }

    // MARK: many agents: CPU and footprint

    static func fleet(_ endpoint: HerdrEndpoint, observers: Int, seconds: Double, serverPID: pid_t?, label: String) -> [String: Any] {
        let client = HerdrClient(endpoint: endpoint)
        let q = DispatchQueue(label: "fleet")
        let store = HerdrStore(client: client, queue: q)
        store.start()
        guard sleepUntil(10, { q.sync { store.link == .live } }) else { return ["error": "store did not connect"] }
        let snap = q.sync { store.snapshot }
        let picks = pickPanes(snap, count: observers)
        var sessions: [PaneSession] = []
        for a in picks {
            let s = PaneSession(engine: GridEngine(), source: ObserveProcessSource(endpoint: endpoint), queue: q)
            q.sync { s.configure(pane: a.id, size: snap.paneSizes[a.id] ?? PaneSize(cols: 66, rows: 59)) }
            sessions.append(s)
        }
        let settle = 8.0
        Thread.sleep(forTimeInterval: settle)
        let live = q.sync { sessions.filter { $0.state == .live }.count }
        var selfCPU = CPUSampler(), childCPU = CPUSampler(), serverCPU = CPUSampler()
        let me = getpid()
        func childPIDs() -> [pid_t] { q.sync { sessions.compactMap { $0.processID } } }
        _ = selfCPU.sample(pids: [me]); _ = childCPU.sample(pids: childPIDs()); _ = serverCPU.sample(pids: serverPID.map { [$0] } ?? [])
        let framesBefore = q.sync { sessions.map { $0.stats.frames } }
        var selfC: [Double] = [], childC: [Double] = [], serverC: [Double] = []
        var footApp: [Double] = [], footKids: [Double] = [], footServer: [Double] = []
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            Thread.sleep(forTimeInterval: 2)
            selfC.append(selfCPU.sample(pids: [me]))
            let kids = childPIDs()
            childC.append(childCPU.sample(pids: kids))
            if let sp = serverPID { serverC.append(serverCPU.sample(pids: [sp])); if let u = ProcessUsage.read(sp) { footServer.append(Double(u.footprint) / ProcessUsage.mebibyte) } }
            footApp.append(Double(ProcessUsage.read(me)?.footprint ?? 0) / ProcessUsage.mebibyte)
            footKids.append(kids.compactMap { ProcessUsage.read($0) }.map { Double($0.footprint) / ProcessUsage.mebibyte }.reduce(0, +))
        }
        let framesAfter = q.sync { sessions.map { $0.stats.frames } }
        let totalFrames = zip(framesAfter, framesBefore).map { $0 - $1 }.reduce(0, +)
        let gaps = q.sync { sessions.map { $0.stats.seqGaps }.reduce(0, +) }
        let unhandled = q.sync { sessions.map { $0.engine.unhandledSequenceCount }.reduce(0, +) }
        let reconnects = q.sync { sessions.map { $0.stats.reconnects }.reduce(0, +) }
        let applyMax = q.sync { sessions.map { Double($0.stats.applyNanosMax) / 1e6 }.max() ?? 0 }
        let agents = snap.agents.count
        let snapMillis = q.sync { store.snapshotMillis }, snapBytes = q.sync { store.snapshotBytes }, events = q.sync { store.eventCount }
        q.sync { sessions.forEach { $0.stop() } }
        store.stop()
        func mean(_ v: [Double]) -> Double { v.isEmpty ? 0 : (v.reduce(0, +) / Double(v.count) * 100).rounded() / 100 }
        return ["label": label, "agentsInSession": agents, "observersRequested": observers, "observersLive": live, "seconds": seconds,
                "sidebarSnapshotMillis": snapMillis, "sidebarSnapshotBytes": snapBytes, "sidebarEventsSeen": events,
                "cpuPercentOfOneCore": ["helmTestProcess": mean(selfC), "observerChildren": mean(childC), "herdrServer": serverPID == nil ? -1 : mean(serverC),
                                        "helmPlusChildren": mean(zip(selfC, childC).map { $0 + $1 })],
                "cpuP90": ["helmPlusChildren": Distribution(values: zip(selfC, childC).map { $0 + $1 }).percentile(90)],
                "footprintMB": ["helmTestProcess": mean(footApp), "observerChildren": mean(footKids), "herdrServer": serverPID == nil ? -1 : mean(footServer)],
                "framesApplied": totalFrames, "framesPerSecond": Double(totalFrames) / seconds, "seqGaps": gaps,
                "unhandledSequences": unhandled, "reconnects": reconnects, "slowestApplyMillis": applyMax]
    }

    // MARK: a consumer that stops reading

    /// Stops the observer child (SIGSTOP) for `pausedSeconds` while the server keeps producing, then resumes it.
    /// Answers: does Herdr drop a slow consumer, and does the stream catch up to the pane's current screen?
    static func slowConsumer(_ endpoint: HerdrEndpoint, pane: Agent, size: PaneSize, pausedSeconds: Double) -> [String: Any] {
        let client = HerdrClient(endpoint: endpoint)
        let engine = GridEngine()
        let q = DispatchQueue(label: "slow")
        let source = ObserveProcessSource(endpoint: endpoint)
        var frames = 0
        var ended: StreamEnd?
        source.start(pane: pane.id, cols: size.cols, rows: size.rows, queue: q, onFrame: { f, _ in engine.apply(f); frames += 1 }, onEnd: { ended = $0 })
        guard sleepUntil(8, { q.sync { frames > 0 } }), let pid = source.processID else { source.stop(); return ["error": "no first frame"] }
        Thread.sleep(forTimeInterval: 2)
        let beforeStop = q.sync { frames }
        kill(pid, SIGSTOP)
        Thread.sleep(forTimeInterval: pausedSeconds)
        let stillAliveWhileStopped = kill(pid, 0) == 0
        let resumeAt = monotonicNanos()
        kill(pid, SIGCONT)
        var catchUpMillis: Double?
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
            if let text = try? client.readPane(pane.id, source: .visible, ansi: false), normalizedText(text) == q.sync(execute: { normalizedScreen(engine) }) {
                catchUpMillis = Double(monotonicNanos() - resumeAt) / 1e6; break
            }
        }
        let afterResume = q.sync { frames } - beforeStop
        let endState = q.sync { ended.map { "\($0)" } }
        source.stop()
        return ["pausedSeconds": pausedSeconds, "processAliveAfterPause": stillAliveWhileStopped, "framesAfterResume": afterResume,
                "streamEndedByServer": endState ?? "no", "caughtUpToPaneReadMillis": catchUpMillis ?? -1,
                "caughtUp": catchUpMillis != nil]
    }
}

extension LiveTests {
    /// Diagnostic for the lag test's screen matching: how does the engine's screen differ from `pane.read`?
    /// Prints row indexes, lengths and the code point at the first difference, never row text.
    static func rowDiff(_ endpoint: HerdrEndpoint, pane: Agent, size: PaneSize) -> [String: Any] {
        let client = HerdrClient(endpoint: endpoint)
        let engine = GridEngine()
        let q = DispatchQueue(label: "diff")
        let source = ObserveProcessSource(endpoint: endpoint)
        var frames = 0
        source.start(pane: pane.id, cols: size.cols, rows: size.rows, queue: q, onFrame: { f, _ in engine.apply(f); frames += 1 }, onEnd: { _ in })
        _ = sleepUntil(5, { q.sync { frames > 0 } })
        Thread.sleep(forTimeInterval: 1.5)
        let text = (try? client.readPane(pane.id, source: .visible, ansi: false)) ?? ""
        let (gridRows, readRows): ([String], [String]) = q.sync {
            ((0..<engine.rows).map { engine.rowText($0) }, text.split(separator: "\n", omittingEmptySubsequences: false).map { String($0) })
        }
        source.stop()
        var differing: [[String: Any]] = []
        for i in 0..<max(gridRows.count, readRows.count) {
            let a = i < gridRows.count ? gridRows[i] : "<none>"
            let b = i < readRows.count ? normalizedText(readRows[i]) : "<none>"
            if a != b {
                let ua = Array(a.unicodeScalars), ub = Array(b.unicodeScalars)
                var k = 0
                while k < min(ua.count, ub.count), ua[k] == ub[k] { k += 1 }
                differing.append(["row": i, "gridLen": ua.count, "readLen": ub.count, "firstDiffAt": k,
                                  "gridScalar": k < ua.count ? Int(ua[k].value) : -1, "readScalar": k < ub.count ? Int(ub[k].value) : -1])
            }
            if differing.count >= 12 { break }
        }
        return ["gridRows": gridRows.count, "readRows": readRows.count, "gridNonBlank": gridRows.filter { !$0.isEmpty }.count,
                "readNonBlank": readRows.filter { !normalizedText($0).isEmpty }.count, "differingRows(first12)": differing]
    }
}
