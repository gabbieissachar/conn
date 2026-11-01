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
