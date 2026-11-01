// The same measurements against the stand-in Herdr, where the scenarios the real session cannot be put through are
// safe: marker latency (the server stamps its own clock into a pane), a server restart, a protocol mismatch, 32 busy panes.
import Foundation
import HelmCore
import Darwin

enum FakeSuite {
    static func rawCall(_ endpoint: HerdrEndpoint, _ method: String, _ params: [String: Any]) {
        guard let s = UnixLineSocket(path: endpoint.socketPath) else { return }
        s.writeLine(["id": "m", "method": method, "params": params])
        _ = s.readLine(timeout: 2)
        s.close()
    }

    static func run(fakeBin: String) -> [String: Any] {
        let base = "/tmp/hfs-\(getpid())"
        let sockDir = base + "/s"
        try? FileManager.default.createDirectory(atPath: sockDir, withIntermediateDirectories: true)
        let shim = base + "/herdr"
        try? "#!/bin/sh\nexec '\(fakeBin)' cli \"$@\"\n".write(toFile: shim, atomically: true, encoding: .utf8)
        chmod(shim, 0o755)
        let endpoint = HerdrEndpoint(session: "fake", socketDirectory: sockDir, binaryPath: shim)
        var results: [String: Any] = ["standIn": "FakeHerdr (not Herdr): numbers show the app's own overhead, not Herdr's"]

        func startServer(agents: Int = 32, fraction: Double = 0.5) -> Child {
            let c = try! Child(fakeBin, ["serve", "--dir", sockDir, "--session", "fake", "--agents", "\(agents)", "--working-fraction", "\(fraction)", "--working-rate", "4"])
            if !sleepUntil(5, { (try? HerdrClient(endpoint: endpoint).call(.ping)) != nil }) { log("stand-in did not start") }
            return c
        }
        var server = startServer()
        defer { server.terminate() }
        let snap = (try? HerdrClient(endpoint: endpoint).snapshot()) ?? .empty
        let idle = snap.agents.first { $0.state == .idle }!
        let working = snap.agents.first { $0.state == .working }!
        let size = snap.paneSizes[idle.id] ?? PaneSize(cols: 66, rows: 59)

        // 1. Marker latency on an idle pane: server stamp -> bytes through the CLI child -> JSON -> engine.
        do {
            let q = DispatchQueue(label: "mark")
            let session = PaneSession(engine: GridEngine(), source: ObserveProcessSource(endpoint: endpoint), queue: q)
            var seen = Set<UInt64>()
            var lat: [Double] = []
            session.onApplied = {
                let now = monotonicNanos()
                for r in 0..<session.engine.rows {
                    let t = session.engine.rowText(r)
                    if t.hasPrefix("MARK "), let ns = UInt64(t.dropFirst(5)), !seen.contains(ns) { seen.insert(ns); lat.append(Double(now - ns) / 1e6) }
                }
            }
            q.sync { session.configure(pane: idle.id, size: size) }
            _ = sleepUntil(5, { q.sync { session.state == .live } })
            for _ in 0..<200 { rawCall(endpoint, "fake.mark", ["pane_id": idle.id]); Thread.sleep(forTimeInterval: 0.04) }
            Thread.sleep(forTimeInterval: 0.3)
            let l = q.sync { lat }
            results["markerLatencyMillis"] = Distribution(values: l).json
            results["markerLatencyNote"] = "stand-in coalesces frames at 32 ms like Herdr does; 200 marks, 40 ms apart, idle pane"
            q.sync { session.stop() }
        }

        // 2. 32 busy panes: sidebar plus 32 observers.
        results["load32"] = LiveTests.fleet(endpoint, observers: 32, seconds: 40, serverPID: server.pid, label: "stand-in, 32 observers, half the panes streaming 4 lines/s")

        // 3. Protocol mismatch: the CLI refuses, the session reports it, the text path takes over.
        do {
            rawCall(endpoint, "fake.set_protocol", ["protocol": 23])
            let status = HerdrCompatibility.probe(endpoint: endpoint)
            let verdict = status.map { HerdrCompatibility.verdict(for: $0) }
            let q = DispatchQueue(label: "mismatch")
            let engine = GridEngine()
            let session = PaneSession(engine: engine, source: ObserveProcessSource(endpoint: endpoint), queue: q)
            var mismatchAt: UInt64?
            let t0 = monotonicNanos()
            session.onProtocolMismatch = {
                mismatchAt = monotonicNanos()
                session.replaceSource(PaneReadSource(client: HerdrClient(endpoint: endpoint), interval: 0.25))
            }
            q.sync { session.configure(pane: working.id, size: size) }
            let degraded = sleepUntil(8, { q.sync { mismatchAt != nil && session.state == .live } })
            let showsText = q.sync { (0..<engine.rows).contains { engine.rowText($0).contains("Claude Code") } }
            results["protocolMismatch"] = ["statusVerdict": verdict.map { "\($0)" } ?? "probe failed", "streamRefusedDetectedMillis": mismatchAt.map { Double($0 - t0) / 1e6 } ?? -1,
                                           "textPathShowsPane": degraded && showsText]
            q.sync { session.stop() }
            rawCall(endpoint, "fake.set_protocol", ["protocol": 22])
        }

        // 4. A consumer that stops reading for 20 s.
        results["slowConsumer"] = LiveTests.slowConsumer(endpoint, pane: working, size: size, pausedSeconds: 20)

        // 5. Server restart: kill the stand-in for 3 s, bring it back, time the recovery of the sidebar and of a pane stream.
        do {
            let q = DispatchQueue(label: "restart")
            let store = HerdrStore(client: HerdrClient(endpoint: endpoint), queue: q)
            store.start()
            let session = PaneSession(engine: GridEngine(), source: ObserveProcessSource(endpoint: endpoint), queue: q)
            q.sync { session.configure(pane: working.id, size: size) }
            _ = sleepUntil(8, { q.sync { store.link == .live && session.state == .live } })
            server.terminate()
            Thread.sleep(forTimeInterval: 3)
            let sawOutage = q.sync { if case .reconnecting = store.link { return true } else { return false } }
            let restartAt = monotonicNanos()
            server = startServer()
            var storeBack: Double?, streamBack: Double?
            let end = Date().addingTimeInterval(20)
            while Date() < end, storeBack == nil || streamBack == nil {
                Thread.sleep(forTimeInterval: 0.02)
                if storeBack == nil, q.sync(execute: { store.link == .live }) { storeBack = Double(monotonicNanos() - restartAt) / 1e6 }
                if streamBack == nil, q.sync(execute: { session.state == .live }) { streamBack = Double(monotonicNanos() - restartAt) / 1e6 }
            }
            results["serverRestart"] = ["outageSeconds": 3, "sidebarSawOutage": sawOutage, "sidebarLiveAgainMillisAfterServerBack": storeBack ?? -1,
                                        "paneStreamLiveAgainMillisAfterServerBack": streamBack ?? -1, "sidebarReconnects": q.sync { store.reconnectCount },
                                        "paneReconnects": q.sync { session.stats.reconnects }]
            store.stop(); q.sync { session.stop() }
        }
        return results
    }
}
