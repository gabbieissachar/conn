import Testing
import Foundation
@testable import HelmCore
import FakeHerdrKit

@Suite("Pane stream") struct StreamTests {
    @Test func frameCodecRoundTripsAndIgnoresOtherLines() {
        let f = TerminalFrame(full: true, width: 66, height: 59, seq: 7, bytes: Array("\u{1b}[2Jhi".utf8))
        #expect(FrameCodec.decode(FrameCodec.encode(f)) == f)
        #expect(FrameCodec.decode(Data(#"{"type":"terminal.status","x":1}"#.utf8)) == nil)
        #expect(FrameCodec.decode(Data("not json".utf8)) == nil)
        #expect(FrameCodec.decode(Data(#"{"type":"terminal.frame","bytes":"%%%"}"#.utf8)) == nil)
    }

    @Test func lineBufferSplitsAcrossChunksAndDropsRunawayLines() {
        var b = LineBuffer(limit: 32)
        #expect(b.append(Data("ab".utf8)).isEmpty)
        #expect(b.append(Data("c\nde".utf8)) == [Data("abc".utf8)])
        #expect(b.append(Data("f\n\n".utf8)) == [Data("def".utf8)])
        // A line past the limit is dropped, and the next one is read normally.
        #expect(b.append(Data(String(repeating: "x", count: 40).utf8)).isEmpty)
        #expect(b.append(Data("tail\nok\n".utf8)) == [Data("ok".utf8)])
    }

    @Test func gridEngineDrawsAHerdrStyleFrame() {
        let e = GridEngine()
        // Shape of a real frame: synchronized output, hidden cursor, clear, positioned rows, truecolour SGR, a hyperlink.
        let ansi = "\u{1b}[?2026h\u{1b}[?25l\u{1b}[2J\u{1b}[1;1H\u{1b}[0;38;2;217;119;87m▐▛███▜▌\u{1b}[0m title"
            + "\u{1b}[3;1H\u{1b}]8;;https://example.com\u{1b}\\link\u{1b}]8;;\u{1b}\\ ok\u{1b}[?2026l"
        e.apply(TerminalFrame(full: true, width: 40, height: 6, seq: 1, bytes: Array(ansi.utf8)))
        #expect(e.cols == 40 && e.rows == 6)
        #expect(e.rowText(0) == "▐▛███▜▌ title")
        #expect(e.rowText(2) == "link ok")
        #expect(e.unhandledSequenceCount == 0)
        // A partial frame touches only the rows it names.
        e.apply(TerminalFrame(full: false, width: 40, height: 6, seq: 2, bytes: Array("\u{1b}[2;1H\u{1b}[2Ksecond".utf8)))
        #expect(e.rowText(1) == "second")
        #expect(e.rowText(0) == "▐▛███▜▌ title")
    }

    @Test func paneSessionStreamsFromTheStandIn() throws {
        let (server, endpoint) = try makeServer(agents: 2)
        defer { server.stop() }
        let engine = GridEngine()
        let session = PaneSession(engine: engine, source: DirectStreamSource(endpoint: endpoint), queue: testQueue)
        session.configure(pane: "w01:p1", size: PaneSize(cols: 66, rows: 59))
        #expect(waitUntil { session.state == .live })
        #expect(engine.cols == 66 && engine.rows == 59)
        #expect(waitUntil { (0..<59).contains { engine.rowText($0).contains("Claude Code") } })
        #expect(engine.unhandledSequenceCount == 0)
        // A marker line written on the server arrives as a partial frame within a moment.
        _ = try HerdrClient(endpoint: endpoint).rawCall(method: "fake.mark", params: ["pane_id": "w01:p1"])
        #expect(waitUntil { (0..<59).contains { engine.rowText($0).hasPrefix("MARK ") } })
        #expect(session.stats.seqGaps == 0)
        session.stop()
    }

    @Test func paneSessionReconnectsWithBackoffAfterTheStreamEnds() throws {
        let dir = shortSocketDir()
        let (server, endpoint) = try makeServer(agents: 1, dir: dir)
        let engine = GridEngine()
        let session = PaneSession(engine: engine, source: DirectStreamSource(endpoint: endpoint), queue: testQueue)
        session.backoffInitial = 0.1
        session.configure(pane: "w01:p1", size: PaneSize(cols: 66, rows: 59))
        #expect(waitUntil { session.state == .live })
        server.stop()
        #expect(waitUntil { if case .reconnecting = session.state { return true } else { return false } })
        let (server2, _) = try makeServer(agents: 1, dir: dir)
        defer { server2.stop() }
        #expect(waitUntil(8) { session.state == .live })
        #expect(session.stats.reconnects >= 1)
        session.stop()
    }

    @Test func protocolMismatchOnTheProcessIsReportedToTheOwner() {
        final class Failing: PaneStreamSource {
            var processID: Int32? { nil }
            func start(pane: String, cols: Int, rows: Int, queue: DispatchQueue, onFrame: @escaping (TerminalFrame, UInt64) -> Void, onEnd: @escaping (StreamEnd) -> Void) {
                queue.async { onEnd(.exited(status: 1, stderr: "herdr: server rejected handshake (version 22): client version 23 is newer than server version 22; please upgrade the herdr server")) }
            }
            func stop() {}
        }
        let session = PaneSession(engine: GridEngine(), source: Failing(), queue: testQueue)
        var mismatch = false
        session.onProtocolMismatch = { mismatch = true }
        session.configure(pane: "w1:p1", size: nil)
        #expect(waitUntil { mismatch })
        if case .failed = session.state {} else { Issue.record("expected failed state, got \(session.state)") }
    }

    @Test func textSourceTurnsPaneReadIntoAFullFrame() throws {
        let (server, endpoint) = try makeServer(agents: 1)
        defer { server.stop() }
        let engine = GridEngine()
        let session = PaneSession(engine: engine, source: PaneReadSource(client: HerdrClient(endpoint: endpoint), interval: 0.1), queue: testQueue)
        session.configure(pane: "w01:p1", size: PaneSize(cols: 66, rows: 59))
        #expect(waitUntil { session.state == .live })
        #expect(waitUntil { (0..<59).contains { engine.rowText($0).contains("Claude Code") } })
        session.stop()
    }
}

@Suite("Compatibility") struct CompatibilityTests {
    private func status(client: Int, server: Int, running: Bool = true, stale: Bool = false) -> HerdrStatus {
        let json = """
        {"client":{"version":"0.9.5","protocol":\(client)},"server":{"running":\(running),"version":"0.9.5","protocol":\(server),
         "compatible":\(client == server),"endpoint_compatible":true,"restart_needed":false,"server_binary_stale":\(stale)},"update":{}}
        """
        return HerdrStatus(json: Data(json.utf8))!
    }

    @Test func verdicts() {
        #expect(HerdrCompatibility.verdict(for: status(client: 22, server: 22)) == .ok)
        if case .untested = HerdrCompatibility.verdict(for: status(client: 23, server: 23)) {} else { Issue.record("23/23 should be untested") }
        if case .textOnly = HerdrCompatibility.verdict(for: status(client: 23, server: 22)) {} else { Issue.record("23/22 should be text only") }
        if case .textOnly = HerdrCompatibility.verdict(for: status(client: 22, server: 22, stale: true)) {} else { Issue.record("stale server should be text only") }
        if case .down = HerdrCompatibility.verdict(for: status(client: 22, server: 22, running: false)) {} else { Issue.record("stopped server should be down") }
        #expect(HerdrCompatibility.verdict(for: status(client: 22, server: 22)).allowsStream)
        #expect(!HerdrCompatibility.verdict(for: status(client: 23, server: 22)).allowsStream)
    }

    @Test func parsesTheRealStatusShape() {
        let real = #"{"client":{"version":"0.9.5","channel":"stable","protocol":22,"endpoint_protocol_generation":1},"server":{"status":"running","running":true,"version":"0.9.5","protocol":22,"compatible":true,"endpoint_compatible":true,"restart_needed":false,"server_binary_stale":false},"update":{"restart_needed":false,"server_binary_stale":false}}"#
        let s = HerdrStatus(json: Data(real.utf8))
        #expect(s?.serverProtocol == 22 && s?.clientVersion == "0.9.5")
        #expect(HerdrStatus(json: Data("garbage".utf8)) == nil)
    }
}

@Suite("Decoder robustness") struct DecoderRobustnessTests {
    private func feed(_ s: String, cols: Int = 20, rows: Int = 6) -> GridEngine {
        let e = GridEngine(cols: cols, rows: rows)
        e.feed(Array(s.utf8))
        return e
    }

    @Test func hugeParametersDoNotTrap() {
        // 99999999999999999999 overflows Int; 70000 exceeds the clamp. Neither may crash or move the cursor out of the grid.
        let e = feed("\u{1b}[99999999999999999999B\u{1b}[70000C\u{1b}[70000X\u{1b}[70000@\u{1b}[70000P\u{1b}[70000L\u{1b}[70000M\u{1b}[70000S\u{1b}[70000Thello")
        #expect(e.rows == 6 && e.cols == 20)
        #expect(e.screen.cursorRow >= 0 && e.screen.cursorRow < 6)
        #expect(e.screen.cursorCol >= 0 && e.screen.cursorCol < 20)
    }

    @Test func aSavedCursorFromBeforeAResizeIsClamped() {
        let e = GridEngine(cols: 80, rows: 40)
        e.feed(Array("\u{1b}[39;79H\u{1b}7".utf8))        // save at row 39, column 79
        e.resize(cols: 10, rows: 5)
        e.feed(Array("\u{1b}8hello".utf8))                  // restore, then print: must stay inside the 10x5 grid
        e.feed(Array("\u{1b}[s\u{1b}[1;1H\u{1b}[u".utf8))
        #expect(e.screen.cursorRow < 5 && e.screen.cursorCol < 10)
        #expect(e.unhandledSequenceCount == 0)
    }

    @Test func malformedSequencesAreCountedNotFatal() {
        let e = feed("\u{1b}[38;2;1mx\u{1b}[?9999hy\u{1b}Zz\u{1b}[;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;m ok\u{1b}]8;;\u{1b}")
        #expect(e.rowText(0).contains("ok"))
    }
}

@Suite("Frame sanity and observer registry", .serialized) struct SanityTests {
    @Test func framesWithAbsurdGeometryAreRejectedAndCounted() {
        let huge = TerminalFrame(full: true, width: 65535, height: 65535, seq: 1, bytes: Array("x".utf8))
        #expect(!huge.isSane)
        #expect(!TerminalFrame(full: true, width: 0, height: 10, seq: 1, bytes: []).isSane)
        #expect(TerminalFrame(full: true, width: 66, height: 59, seq: 1, bytes: []).isSane)
        #expect(TerminalFrame(full: false, width: 0, height: 0, seq: 2, bytes: []).isSane)
        // The engine refuses to resize for such a frame, and a session counts it.
        let e = GridEngine(cols: 10, rows: 5)
        e.apply(huge)
        #expect(e.cols == 10 && e.rows == 5)
        final class OneFrame: PaneStreamSource {
            var processID: Int32? { nil }
            func start(pane: String, cols: Int, rows: Int, queue: DispatchQueue, onFrame: @escaping (TerminalFrame, UInt64) -> Void, onEnd: @escaping (StreamEnd) -> Void) {
                queue.async { onFrame(TerminalFrame(full: true, width: 65535, height: 65535, seq: 1, bytes: Array("x".utf8)), 0) }
            }
            func stop() {}
        }
        let session = PaneSession(engine: GridEngine(cols: 10, rows: 5), source: OneFrame(), queue: testQueue)
        session.configure(pane: "w1:p1", size: PaneSize(cols: 66, rows: 59))
        #expect(waitUntil { session.stats.rejectedFrames == 1 })
        #expect(session.stats.frames == 0)
        session.stop()
    }

    @Test func registryRecognisesOnlyItsOwnCommandLineAndSparesLiveChildren() throws {
        let dir = shortSocketDir()
        setenv("HELM_STATE_DIR", dir, 1)
        defer { unsetenv("HELM_STATE_DIR") }
        #expect(ObserverRegistry.looksLikeOurObserver(" /Users/x/.local/bin/herdr --session esim terminal session observe w1:p3 --cols 66 --rows 59"))
        #expect(!ObserverRegistry.looksLikeOurObserver(" /bin/sleep 30"))
        #expect(!ObserverRegistry.looksLikeOurObserver(" herdr session attach esim"))
        // A child that still has its parent is not an orphan and must not be signalled.
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        defer { child.terminate() }
        ObserverRegistry.record(child.processIdentifier)
        #expect(ObserverRegistry.reapOrphans().isEmpty)
        #expect(child.isRunning)
        ObserverRegistry.record(child.processIdentifier)
        ObserverRegistry.forget(child.processIdentifier)
        #expect(ObserverRegistry.reapOrphans().isEmpty)
    }
}

@Suite("Protocol refusal text") struct RefusalTextTests {
    @Test func recognisesHerdrsRealHandshakeErrors() {
        #expect(PaneSession.isProtocolRefusal("herdr: server rejected handshake (version 22): client version 23 is newer than server version 22; please upgrade the herdr server"))
        #expect(PaneSession.isProtocolRefusal("herdr: server rejected handshake (version 24): client version 23 is older than server version 24; please upgrade the herdr client"))
        #expect(PaneSession.isProtocolRefusal("error: protocol_mismatch"))
        #expect(!PaneSession.isProtocolRefusal("herdr: cannot connect to socket"))
        #expect(!PaneSession.isProtocolRefusal(""))
    }

    @Test func anUnrecognisedEarlyExitAsksTheOwnerToRecheckCompatibility() {
        final class Dying: PaneStreamSource {
            var processID: Int32? { nil }
            func start(pane: String, cols: Int, rows: Int, queue: DispatchQueue, onFrame: @escaping (TerminalFrame, UInt64) -> Void, onEnd: @escaping (StreamEnd) -> Void) {
                queue.async { onEnd(.exited(status: 1, stderr: "herdr: something new went wrong")) }
            }
            func stop() {}
        }
        let session = PaneSession(engine: GridEngine(), source: Dying(), queue: testQueue)
        session.backoffInitial = 5
        var asked = false
        session.onStreamFailedBeforeFrames = { _ in asked = true }
        session.configure(pane: "w1:p1", size: nil)
        #expect(waitUntil { asked })
        session.stop()
    }
}
