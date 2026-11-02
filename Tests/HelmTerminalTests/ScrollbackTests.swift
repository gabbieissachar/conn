import Testing
import Foundation
@testable import SwiftTerm

/// Why a live pane has no scrollback of its own. Herdr re-renders the pane for the observer: a full frame clears the screen
/// and writes every row at an absolute position, later frames rewrite only the rows that changed. A real working pane
/// sampled read-only (42 frames, 19,908 bytes) held 0 line feeds, 0 carriage returns, 572 cursor positions, SGR colours and
/// mode changes. A terminal only moves a line into its scrollback when a line feed scrolls the screen, so a terminal fed
/// these frames never gets any. (Seeding it from `pane.read` is no fix either: Herdr's ANSI read of the `recent` source
/// is only the screen, so history would arrive without colour and go stale at once.)
@Suite("Scrollback finding") struct ScrollbackTests {
    final class Delegate: TerminalDelegate { func send(source: Terminal, data: ArraySlice<UInt8>) {} }

    private func herdrShapedFrame(rows: Int, cols: Int, step: Int, full: Bool) -> [UInt8] {
        var s = "\u{1b}[?2026h\u{1b}[?25l"
        if full { s += "\u{1b}[2J" }
        for r in 0..<rows where full || r == step % rows || r == rows - 1 {
            s += "\u{1b}[\(r + 1);1H\u{1b}[0m\u{1b}[2K\u{1b}[38;2;120;190;120mstep \(step) row \(r)\u{1b}[0m"
        }
        s += "\u{1b}[?2026l"
        return Array(s.utf8)
    }

    @Test func positionedFramesNeverPushALineIntoTheScrollback() {
        let delegate = Delegate()
        let term = Terminal(delegate: delegate, options: TerminalOptions(cols: 66, rows: 20, scrollback: 1000))
        term.feed(byteArray: herdrShapedFrame(rows: 20, cols: 66, step: 0, full: true))
        for step in 1...2000 { term.feed(byteArray: herdrShapedFrame(rows: 20, cols: 66, step: step, full: false)) }
        #expect(term.buffer.yBase == 0)                                   // nothing scrolled off
        #expect(term.buffer.lines.count == 20)                            // the buffer is the screen and nothing else
    }

    @Test func theSameTextWithLineFeedsDoesFillTheScrollback() {
        // The control: the measurement above would show 0 for a terminal that could not keep history at all.
        let delegate = Delegate()
        let term = Terminal(delegate: delegate, options: TerminalOptions(cols: 66, rows: 20, scrollback: 1000))
        for step in 0..<200 { term.feed(byteArray: Array("step \(step)\r\n".utf8)) }
        #expect(term.buffer.yBase >= 180)
    }
}
