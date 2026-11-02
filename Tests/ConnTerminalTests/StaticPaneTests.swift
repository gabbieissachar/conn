import Testing
import Foundation
import AppKit
import ConnCore
@testable import ConnTerminal

/// A source that delivers exactly one full frame, shaped like a real Herdr frame (synchronized output around the
/// body, a cursor move and cursor-show after it), and then nothing: what a "needs you" or "done" pane looks like.
final class OneShotSource: PaneStreamSource {
    var processID: Int32? { nil }
    func start(pane: String, cols: Int, rows: Int, queue: DispatchQueue,
               onFrame: @escaping (TerminalFrame, UInt64) -> Void, onEnd: @escaping (StreamEnd) -> Void) {
        let body = "\u{1b}[?2026h\u{1b}[?25l\u{1b}[2J\u{1b}[1;1H\u{1b}[38;2;217;119;87m▐▛███▜▌\u{1b}[0m  Claude Code\u{1b}[2;1Hneeds your answer to continue\u{1b}[?2026l\u{1b}[3;3H\u{1b}[?25h"
        queue.async { onFrame(TerminalFrame(full: true, width: 66, height: 20, seq: 1, bytes: Array(body.utf8)), monotonicNanos()) }
    }
    func stop() {}
}

extension SwiftTermMainActorTests {
@Suite("SwiftTerm static pane") @MainActor struct StaticPaneTests {
    @Test func aPaneThatReceivesOneFullFrameAndNothingAfterItShowsItsTextAndIsRedrawnPromptly() async throws {
        let engine = SwiftTermEngine()
        let session = PaneSession(engine: engine, source: OneShotSource(), queue: .main)
        let t0 = monotonicNanos()
        session.configure(pane: "w1:p1", size: PaneSize(cols: 66, rows: 20))
        var textAt: Double?
        var nudgedAt: Double?
        while Double(monotonicNanos() - t0) / 1e9 < 2.0 {
            try await Task.sleep(nanoseconds: 10_000_000)
            let now = Double(monotonicNanos() - t0) / 1e9
            if textAt == nil, (0..<20).contains(where: { engine.rowText($0).contains("needs your answer") }) { textAt = now }
            if nudgedAt == nil, engine.displayNudges > 0 { nudgedAt = now }
            if textAt != nil, nudgedAt != nil { break }
        }
        // The text reached the SwiftTerm view, and a forced draw followed within a second (no later frame ever came).
        #expect(textAt != nil && textAt! < 1.0)
        #expect(nudgedAt != nil && nudgedAt! < 1.0)
        #expect(session.stats.frames == 1)
        session.stop()
    }
}
}
