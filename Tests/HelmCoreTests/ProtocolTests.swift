import Testing
import Foundation
@testable import HelmCore
import FakeHerdrKit

@Suite("Herdr JSON API") struct ProtocolTests {
    @Test func snapshotDecodesThroughTheSocket() throws {
        let (server, endpoint) = try makeServer(agents: 8)
        defer { server.stop() }
        let snap = try HerdrClient(endpoint: endpoint).snapshot()
        #expect(snap.agents.count == 8)
        #expect(snap.workspaces.count == 2)
        #expect(snap.paneSizes[snap.agents[0].id] == PaneSize(cols: 66, rows: 59))
        #expect(snap.prioritized.first?.state == .blocked)       // waiting-on-you agents sort first
        #expect(snap.agents.allSatisfy { $0.sessionID != nil })
    }

    @Test func writesAreRefusedUnlessTheSessionIsAllowed() throws {
        let (server, endpoint) = try makeServer(agents: 2)
        defer { server.stop() }
        let observer = HerdrClient(endpoint: endpoint)             // default policy: observe only
        let pane = try observer.snapshot().agents[0].id
        #expect(throws: HerdrError.writeRefused(session: "fake1", method: "pane.send_input")) {
            try observer.sendInput(pane: pane, text: "hello")
        }
        let other = HerdrClient(endpoint: endpoint, writePolicy: WritePolicy(writableSessions: ["somewhere-else"]))
        #expect(throws: HerdrError.self) { try other.sendInput(pane: pane, text: "hello") }
        // Nothing reached the stand-in.
        let dump = try observer.call(.ping)
        #expect(dump["result"] != nil)
        let writer = HerdrClient(endpoint: endpoint, writePolicy: WritePolicy(writableSessions: ["fake1"]))
        try writer.sendInput(pane: pane, text: "hello")
        let sent = try writer.rawCall(method: "fake.dump", params: ["pane_id": pane])
        #expect(((sent["result"] as? [String: Any])?["sent"] as? [String]) == ["hello <Enter>"])
    }

    @Test func invalidIdentifiersNeverReachTheSocket() throws {
        let (server, endpoint) = try makeServer(agents: 1)
        defer { server.stop() }
        let writer = HerdrClient(endpoint: endpoint, writePolicy: WritePolicy(writableSessions: ["fake1"]))
        #expect(throws: HerdrError.invalidArgument("pane id")) { try writer.sendInput(pane: "w1:p1; rm", text: "x") }
        #expect(ObserveProcessSource.arguments(session: "a b", pane: "w1:p1", cols: 80, rows: 24) == nil)
        #expect(ObserveProcessSource.arguments(session: "esim", pane: "$(x)", cols: 80, rows: 24) == nil)
        #expect(ObserveProcessSource.arguments(session: "esim", pane: "w1:p1", cols: 5, rows: 24) == nil)
        #expect(ObserveProcessSource.arguments(session: "esim", pane: "w1:p1", cols: 66, rows: 59)
                == ["--session", "esim", "terminal", "session", "observe", "w1:p1", "--cols", "66", "--rows", "59"])
    }

    @Test func paneReadReturnsTheScreenText() throws {
        let (server, endpoint) = try makeServer(agents: 1)
        defer { server.stop() }
        let text = try HerdrClient(endpoint: endpoint).readPane("w01:p1")
        #expect(text.contains("Claude Code"))
    }

    @Test func theStandInRefusesToReplaceALiveSocketOrRunInARealHerdrDirectory() throws {
        // Something already listens at <dir>/fake1/herdr.sock: the stand-in must refuse and leave it reachable.
        let dir = shortSocketDir()
        try FileManager.default.createDirectory(atPath: dir + "/fake1", withIntermediateDirectories: true)
        let existing = try #require(UnixListener(path: dir + "/fake1/herdr.sock"))
        Thread.detachNewThread { while let c = existing.accept() { c.close() } }
        let server = FakeHerdrServer(config: FakeHerdrServer.Config(directory: dir, session: "fake1"))
        #expect(throws: (any Error).self) { try server.start() }
        let probe = UnixLineSocket(path: dir + "/fake1/herdr.sock")
        #expect(probe != nil)
        probe?.close()
        existing.close()
        let real = FakeHerdrServer(config: FakeHerdrServer.Config(directory: NSHomeDirectory() + "/.config/herdr/sessions", session: "esim"))
        #expect(throws: (any Error).self) { try real.start() }
    }

    @Test func onlyAnEndpointWithBothADifferentDirectoryAndADifferentBinaryIsAStandIn() {
        let home = NSHomeDirectory()
        let real = HerdrEndpoint(session: "esim", socketDirectory: home + "/.config/herdr/sessions", binaryPath: home + "/.local/bin/herdr")
        #expect(!real.isStandIn)
        // The reviewer's case: a scratch socket directory but the default, real executable.
        #expect(!HerdrEndpoint(session: "esim", socketDirectory: "/tmp/x", binaryPath: home + "/.local/bin/herdr").isStandIn)
        #expect(!HerdrEndpoint(session: "esim", socketDirectory: "/tmp/x", binaryPath: "/opt/homebrew/bin/herdr").isStandIn)
        // A real executable with the real directory, and no executable at all.
        #expect(!HerdrEndpoint(session: "esim", socketDirectory: home + "/.config/herdr/sessions", binaryPath: "/tmp/shim/herdr").isStandIn)
        #expect(!HerdrEndpoint(session: "fake", socketDirectory: "/tmp/x", binaryPath: "").isStandIn)
        #expect(HerdrEndpoint(session: "fake", socketDirectory: "/tmp/x", binaryPath: "/tmp/shim/herdr").isStandIn)
    }

    @Test func aRealSessionOfTheSameNameMeansNotAStandInWhateverTheExecutableIs() throws {
        let dir = shortSocketDir()
        try FileManager.default.createDirectory(atPath: dir + "/esim", withIntermediateDirectories: true)
        #expect(!HerdrEndpoint.realSessionAnswers("esim", realSocketDirectory: dir))
        let listener = try #require(UnixListener(path: dir + "/esim/herdr.sock"))
        Thread.detachNewThread { while let c = listener.accept() { c.close() } }
        #expect(HerdrEndpoint.realSessionAnswers("esim", realSocketDirectory: dir))
        #expect(!HerdrEndpoint.realSessionAnswers("other", realSocketDirectory: dir))
        listener.close()
    }

    @Test func unreachableSessionThrows() {
        let client = HerdrClient(endpoint: HerdrEndpoint(session: "nope", socketDirectory: shortSocketDir(), binaryPath: ""))
        #expect(throws: HerdrError.self) { try client.snapshot() }
    }
}

extension HerdrClient {
    /// Test helper: any method, no policy gate (used for the stand-in's `fake.*` controls).
    func rawCall(method: String, params: [String: Any]) throws -> [String: Any] {
        guard let sock = UnixLineSocket(path: endpoint.socketPath) else { throw HerdrError.unreachable("no socket") }
        defer { sock.close() }
        sock.writeLine(["id": "t", "method": method, "params": params])
        guard let obj = sock.readJSON(timeout: 5) else { throw HerdrError.unreachable("no reply") }
        return obj
    }
}

@Suite("Agent navigation") struct NavigationTests {
    private func snapshot() throws -> Snapshot {
        let (server, endpoint) = try makeServer(agents: 8)
        defer { server.stop() }
        return try HerdrClient(endpoint: endpoint).snapshot()
    }

    @Test func cyclingFollowsTheSidebarOrderAndWrapsBothWays() throws {
        let s = try snapshot()
        let order = s.prioritized.map(\.id)
        #expect(s.agent(after: nil, offset: 1)?.id == order[0])
        #expect(s.agent(after: order[0], offset: 1)?.id == order[1])
        #expect(s.agent(after: order.last, offset: 1)?.id == order[0])
        #expect(s.agent(after: order[0], offset: -1)?.id == order.last)
        #expect(s.agent(after: "gone", offset: -1)?.id == order.last)
        #expect(Snapshot.empty.agent(after: nil, offset: 1) == nil)
    }

    @Test func jumpingToWaitingVisitsOnlyAgentsThatWaitAndWraps() throws {
        let s = try snapshot()
        let waiting = s.prioritized.filter { $0.state.waitsOnCaptain }.map(\.id)
        #expect(!waiting.isEmpty)
        #expect(s.nextWaiting(after: nil)?.id == waiting[0])
        #expect(s.nextWaiting(after: waiting.last)?.id == waiting[0])
        let idle = s.agents.first { !$0.state.waitsOnCaptain }!.id
        #expect(s.nextWaiting(after: idle)?.id == waiting[0])
        var none = s
        for a in s.agents { none.setState(a.id, to: .idle) }
        #expect(none.nextWaiting(after: nil) == nil)
    }
}

@Suite("Compose policy") struct ComposePolicyTests {
    @Test func singleLineTextIsAllowedAndEverythingElseIsExplained() {
        #expect(ComposePolicy.problem(for: "run the wider checkout suite") == nil)
        #expect(ComposePolicy.problem(for: "  trailing spaces and a final newline\n") == nil)   // trimmed first
        #expect(ComposePolicy.problem(for: "") != nil && ComposePolicy.problem(for: " \n ") != nil)
        for text in ["first line\nsecond line", "a\r\nb", "a\rb", "a\u{2028}b", "a\u{0085}b"] {
            #expect(ComposePolicy.problem(for: text) == ComposePolicy.multiLineMessage)
        }
    }

    @Test func theStandInReceivesOneLineAsOneSend() throws {
        let (server, endpoint) = try makeServer(agents: 1)
        defer { server.stop() }
        let writer = HerdrClient(endpoint: endpoint, writePolicy: WritePolicy(writableSessions: ["fake1"]))
        try writer.sendInput(pane: "w01:p1", text: "one line")
        let sent = try writer.rawCall(method: "fake.dump", params: ["pane_id": "w01:p1"])
        #expect(((sent["result"] as? [String: Any])?["sent"] as? [String]) == ["one line <Enter>"])
    }
}

@Suite("Real-shaped snapshot") struct FixtureSnapshotTests {
    @Test func theInventedFixtureSnapshotParsesLikeARealOne() throws {
        // Resources/fixture/snapshot.json has the shape of a 0.9.5 reply (14 agents in 7 spaces, names invented).
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("Resources/fixture/snapshot.json"))
        let obj = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let snap = try #require(Snapshot(response: obj))
        #expect(snap.agents.count == 14 && snap.workspaces.count == 7)
        #expect(snap.paneSizes.count == snap.paneIDs.count)
        #expect(snap.prioritized.first?.state.waitsOnCaptain == true)
        #expect(snap.agents.allSatisfy { !$0.name.isEmpty })
    }
}
