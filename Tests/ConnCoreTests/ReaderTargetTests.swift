import Testing
import Foundation
import ConnCore
import FakeHerdrKit

@Suite("Reader target: which conversation an agent row stands for") struct ReaderTargetTests {
    private let herdrSession = "87138c9a-a945-4537-a348-b33221b9848f"
    private let askSession = "5c4c926e-dd8c-4cc2-88a3-744bc08c177f"

    @Test func theSessionHerdrNamesWins() {
        #expect(ReaderTarget.session(herdr: herdrSession, ask: askSession) == herdrSession)
        #expect(ReaderTarget.session(herdr: herdrSession, ask: nil) == herdrSession)
    }

    @Test func withNoHerdrSessionTheAsksSessionIsUsed() {
        #expect(ReaderTarget.session(herdr: nil, ask: askSession) == askSession)
    }

    @Test func noSessionAtAllMeansNoTranscriptYet() {
        #expect(ReaderTarget.session(herdr: nil, ask: nil) == nil)
        #expect(ReaderTarget.session(herdr: "", ask: "") == nil)
    }

    @Test func aSessionTheReaderWouldNotFollowIsNoSession() {
        #expect(ReaderTarget.session(herdr: "../etc", ask: nil) == nil)
        #expect(ReaderTarget.session(herdr: "has space", ask: askSession) == askSession)       // falls to the next candidate
        #expect(ReaderTarget.session(herdr: String(repeating: "a", count: 65), ask: nil) == nil)
    }

    @Test func aFreshPaneHasNoSessionUntilHerdrReportsOne() throws {
        let (server, endpoint) = try makeServer(agents: 4)
        defer { server.stop() }
        let client = HerdrClient(endpoint: endpoint)
        _ = try client.rawCall(method: "fake.add_pane", params: ["pane_id": "wNEW:p1", "label": "fresh scout", "state": "working"])
        let before = try #require(client.snapshot().agent("wNEW:p1"))
        #expect(before.sessionID == nil)                                    // Herdr omits `agent_session` for it
        #expect(ReaderTarget.session(herdr: before.sessionID, ask: nil) == nil)
        // The others still name theirs.
        let others = try client.snapshot().agents.filter { $0.id != "wNEW:p1" }
        #expect(!others.isEmpty && others.allSatisfy { $0.sessionID != nil })
        _ = try client.rawCall(method: "fake.set_session", params: ["pane_id": "wNEW:p1", "session": "00000000-0000-4000-8000-000000000042"])
        let after = try #require(client.snapshot().agent("wNEW:p1"))
        #expect(ReaderTarget.session(herdr: after.sessionID, ask: nil) == "00000000-0000-4000-8000-000000000042")
    }
}
