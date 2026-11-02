import Testing
import Foundation
import HelmCore
import FakeHerdrKit

/// The history view reads `pane.read` with source `recent` and format `text`. These pin the stand-in to what real Herdr
/// 0.9.5 answered to a read-only probe of a live session: `recent` text is the scrollback above the screen plus the
/// screen, `recent` ansi is the screen alone, and `lines` keeps the newest N.
@Suite("History reads", .serialized) struct HistoryReadTests {
    @Test func recentTextIsScrollbackPlusScreenAndAnsiRecentIsOnlyTheScreen() throws {
        let (server, endpoint) = try makeServer(agents: 2) { $0.historyLines = 120; $0.rows = 20 }
        defer { server.stop() }
        let client = HerdrClient(endpoint: endpoint)
        let visible = try client.readPane("w01:p1", source: .visible, ansi: false)
        #expect(visible.split(separator: "\n", omittingEmptySubsequences: false).count == 20)
        let recent = try client.readPane("w01:p1", source: .recent, ansi: false, lines: 3000)
        let lines = recent.split(separator: "\n", omittingEmptySubsequences: false)
        #expect(lines.count == 140)                                    // 120 scrollback + the 20-row screen
        #expect(lines.first?.contains("earlier output") == true && lines.first?.contains("step 1 ") == true)
        #expect(recent.hasSuffix(visible))                              // the screen is the tail
        #expect(!recent.contains("\u{1b}"))                             // text format carries no escape sequences
        let newest = try client.readPane("w01:p1", source: .recent, ansi: false, lines: 25)
        #expect(newest.split(separator: "\n", omittingEmptySubsequences: false).count == 25)
        let ansi = try client.readPane("w01:p1", source: .recent, ansi: true, lines: 3000)
        #expect(ansi.split(separator: "\n", omittingEmptySubsequences: false).count == 20)   // the screen only, as real Herdr answers
    }

    @Test func outputThatScrollsOffTheScreenJoinsTheHistory() throws {
        let (server, endpoint) = try makeServer(agents: 1) { $0.historyLines = 5; $0.rows = 10 }
        defer { server.stop() }
        let client = HerdrClient(endpoint: endpoint, writePolicy: WritePolicy(writableSessions: ["fake1"]))
        let before = try client.readPane("w01:p1", source: .recent, ansi: false, lines: 3000).split(separator: "\n", omittingEmptySubsequences: false).count
        try client.sendInput(pane: "w01:p1", text: "one more line", keys: [])
        let after = try client.readPane("w01:p1", source: .recent, ansi: false, lines: 3000)
        #expect(after.split(separator: "\n", omittingEmptySubsequences: false).count == before + 1)
        #expect(after.hasSuffix("> one more line"))
    }
}
