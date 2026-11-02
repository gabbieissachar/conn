import Testing
import Foundation
import AppKit
import ConnCore
@testable import ConnTerminal

/// Buzz lesson 5: the hostile-input runs of the first slice (the reviewer's fuzz cases) all went through the cell-grid
/// decoder; SwiftTerm has been the default pane view since. These feed the same streams to `SwiftTermEngine`, the way
/// frames reach it (`apply` with full frames at a sane size), and assert bounded time and memory, and that the pane still
/// takes the next frame.
///
/// The time bound is per byte, not a flat number: `swift test` builds SwiftTerm unoptimised, where the worst stream here
/// (a flood of CSI sequences) costs about 26 microseconds a byte, about 25 times what the shipped release build takes
/// (about 1 microsecond a byte; ordinary Herdr frames cost under 0.01). The bound is 100 microseconds a byte plus a second,
/// which catches an unbounded or quadratic loop, not a slow machine. `CONN_HOSTILE_SCALE=full` adds the 2 MB and 12 MB
/// random streams (minutes in a debug build; run them with `swift test -c release -Xswiftc -enable-testing`).
extension SwiftTermMainActorTests {
@Suite("SwiftTerm hostile input") @MainActor struct HostileInputTests {
    static let secondsPerByte = 100e-6
    static let maxGrowthBytes: Int64 = 128 << 20
    static let full = ProcessInfo.processInfo.environment["CONN_HOSTILE_SCALE"] == "full"

    /// `n` bytes by default, five times as many at full scale.
    private func size(_ n: Int) -> Int { Self.full ? n * 5 : n }

    private func footprint() -> Int64 { Int64(ProcessUsage.read(getpid())?.footprint ?? 0) }

    private func esc(_ s: String) -> [UInt8] { Array(("\u{1b}" + s).utf8) }

    /// Feeds `bytes` as one full frame, checks time and footprint, then proves the engine still draws the next frame.
    private func feedHostile(_ name: String, _ bytes: [UInt8], sourceLocation: SourceLocation = #_sourceLocation) {
        let engine = SwiftTermEngine()
        engine.resize(cols: 66, rows: 59)
        let before = footprint()
        let t0 = monotonicNanos()
        engine.apply(TerminalFrame(full: true, width: 66, height: 59, seq: 1, bytes: bytes))
        let seconds = Double(monotonicNanos() - t0) / 1e9
        let growth = footprint() - before
        let budget = 1.0 + Double(bytes.count) * Self.secondsPerByte
        print("hostile: \(name) \(bytes.count) bytes \(String(format: "%.3f", seconds)) s, footprint \(growth >> 10) KB")
        #expect(seconds < budget, "\(name) took \(seconds) s for \(bytes.count) bytes (budget \(budget) s)", sourceLocation: sourceLocation)
        #expect(growth < Self.maxGrowthBytes, "\(name) grew the footprint by \(growth >> 20) MB", sourceLocation: sourceLocation)
        // A full frame always starts with a clear; whatever state the hostile bytes left, the next frame must show.
        engine.apply(TerminalFrame(full: true, width: 66, height: 59, seq: 2, bytes: Array("\u{1b}[?2026h\u{1b}[2J\u{1b}[1;1HALIVE-AFTER-\(name)\u{1b}[?2026l".utf8)))
        #expect(engine.rowText(0).contains("ALIVE-AFTER-\(name)"), "\(name): the pane did not take the next frame (row 0: \(engine.rowText(0).prefix(40)))", sourceLocation: sourceLocation)
        #expect(engine.rows == 59 && engine.cols == 66, "\(name) changed the grid to \(engine.cols)x\(engine.rows)", sourceLocation: sourceLocation)
    }

    @Test func hugeCursorAndEraseParameters() {
        let big = "9223372036854775807"
        feedHostile("cud", esc("[5;1H") + esc("[\(big)B"))
        feedHostile("cuf", esc("[5;5H") + esc("[\(big)C"))
        feedHostile("ech", esc("[5;5H") + esc("[\(big)X"))
        feedHostile("cuu99digits", esc("[5;5H") + esc("[" + String(repeating: "9", count: 99) + "A"))
        feedHostile("repeat", Array("A".utf8) + esc("[\(big)b"))
        feedHostile("insertDelete", esc("[\(big)L") + esc("[\(big)M") + esc("[\(big)@") + esc("[\(big)P"))
        feedHostile("scrollRegion", esc("[100;200r") + esc("[\(big)S") + esc("[\(big)T"))
    }

    @Test func aFiveThousandDigitSgrAndAHundredThousandSemicolons() {
        feedHostile("sgr5000", esc("[" + String(repeating: "9", count: 5000) + "m"))
        feedHostile("semicolons", esc("[" + String(repeating: ";", count: 100_000) + "H"))
        feedHostile("sgrColourFlood", esc("[" + String(repeating: "38;2;1;2;3;", count: 20_000) + "m"))
    }

    @Test func oscStringsOfAnySizeIncludingOnesThatNeverEnd() {
        feedHostile("osc8Big", esc("]8;;" + String(repeating: "u", count: size(100_000))) + [0x07])
        // No terminator at all: payload, then the next frame arrives.
        feedHostile("oscNeverEnds", esc("]0;" + String(repeating: "t", count: size(200_000))))
        feedHostile("oscOpenedManyTimes", Array(String(repeating: "\u{1b}]52;c;AAAA", count: size(10_000)).utf8))
        // A link, a title and a clipboard write with an enormous payload must not reach anything either.
        feedHostile("clipboard", esc("]52;c;" + String(repeating: "QUFB", count: size(50_000))) + [0x07])
    }

    @Test func synchronizedOutputThatIsNeverEnded() {
        feedHostile("sync2026", esc("[?2026h") + Array(String(repeating: "x", count: 100_000).utf8))
        feedHostile("sync2026Repeated", Array(String(repeating: "\u{1b}[?2026h", count: 100_000).utf8))
    }

    @Test func aCharacterSetSwitchDoesNotSurviveTheNextFullFrame() {
        // ESC ( 0 (G0 = DEC line drawing) and SO (shift out to G1, set to line drawing) turn letters into box characters.
        // The first version of the engine kept them across a full frame; reset() now restores ASCII.
        feedHostile("charsetG0", esc("(0") + Array("lqqk".utf8))
        feedHostile("charsetShiftOut", esc(")0") + [0x0e] + Array("lqqk".utf8))
    }

    @Test func aSavedCursorFromBeforeAShrink() {
        let engine = SwiftTermEngine()
        engine.resize(cols: 66, rows: 59)
        engine.apply(TerminalFrame(full: false, width: 0, height: 0, seq: 1, bytes: esc("[59;66H") + esc("7")))
        engine.resize(cols: 33, rows: 29)
        engine.apply(TerminalFrame(full: false, width: 0, height: 0, seq: 2, bytes: esc("8") + Array("X".utf8) + esc("[u") + Array("Y".utf8)))
        #expect(engine.cols == 33 && engine.rows == 29)
        engine.apply(TerminalFrame(full: true, width: 33, height: 29, seq: 3, bytes: esc("[2J") + esc("[1;1HOK")))
        #expect(engine.rowText(0).hasPrefix("OK"))
    }

    @Test func randomBytesBiasedTowardsEscapeSequences() {
        var g = SystemRandomNumberGenerator()
        var b = [UInt8](repeating: 0, count: Self.full ? 2_000_000 : 100_000)
        for i in 0..<b.count {
            let r = UInt8.random(in: 0...255, using: &g)
            b[i] = r % 7 == 0 ? 0x1b : (r % 11 == 0 ? UInt8(ascii: "[") : (r % 13 == 0 ? UInt8(ascii: ";") : r))
        }
        feedHostile("random", b)
    }

    @Test func aCsiFloodAndTheLargestFrameTheLineBufferAllowsOfRandomBytes() {
        // LineBuffer drops lines over 16 MiB, so a frame can carry up to about 12 MiB of bytes (base64 inflates by a third).
        var g = SystemRandomNumberGenerator()
        var flood = [UInt8]()
        while flood.count < size(40_000) {
            flood += esc("[")
            for _ in 0..<Int.random(in: 0...6, using: &g) { flood.append(UInt8(ascii: "0") + UInt8.random(in: 0...9, using: &g)); if Bool.random(using: &g) { flood.append(UInt8(ascii: ";")) } }
            flood.append(UInt8.random(in: 0x40...0x7e, using: &g))
        }
        feedHostile("csiFlood", flood)
        guard Self.full else { return }
        var b = [UInt8](repeating: 0, count: 12 << 20)
        for i in 0..<b.count {
            let r = UInt8.random(in: 0...255, using: &g)
            b[i] = r % 7 == 0 ? 0x1b : (r % 11 == 0 ? UInt8(ascii: "[") : r)
        }
        feedHostile("random12MB", b)
    }

    @Test func terminalQueriesGetNoAnswerOutOfTheApp() {
        // The view is observe-only: replies to these queries (device attributes, cursor report, colour query, window size)
        // go to the delegate's `send`, which drops everything. The stream is processed and bounded like any other.
        feedHostile("queries", esc("[c") + esc("[>c") + esc("[6n") + esc("[5n") + esc("[>q") + esc("]10;?") + [0x07] + esc("[18t") + esc("[?u"))
        let engine = SwiftTermEngine()
        #expect(engine.view.terminalDelegate is ObserveOnlyDelegate)
    }

    @Test func aGeometryTheStreamCannotAskForAndASizeChangeFromInside() {
        // 65535 x 65535 would need about 69 GB: such a frame is dropped before any resize...
        let engine = SwiftTermEngine()
        engine.resize(cols: 66, rows: 59)
        let before = footprint()
        engine.apply(TerminalFrame(full: true, width: 65535, height: 65535, seq: 1, bytes: Array("x".utf8)))
        engine.apply(TerminalFrame(full: true, width: 5000, height: 5000, seq: 2, bytes: Array("x".utf8)))
        #expect(engine.cols == 66 && engine.rows == 59)
        // ...and a program asking the terminal to resize itself (xterm window operations, DECCOLM) may not exceed the cap.
        // (1000 x 1000, not more: a test must not be able to hurt the machine if this ever fails.)
        engine.apply(TerminalFrame(full: false, width: 0, height: 0, seq: 3, bytes: esc("[8;1000;1000t") + esc("[?3h") + esc("[4;10000;10000t")))
        #expect(engine.cols <= TerminalFrame.maxCols && engine.rows <= TerminalFrame.maxRows)
        #expect(footprint() - before < Self.maxGrowthBytes)
    }

    @Test func aDirectResizeIsClampedLikeTheCellGridEngine() {
        // Not reachable from the stream (apply refuses first, PaneSession.configure clamps), but the engine is the last
        // line: the cell-grid engine clamps in `resize`, so this one must as well.
        let engine = SwiftTermEngine()
        let before = footprint()
        engine.resize(cols: 1000, rows: 1000)          // 1000 x 1000, not 65535: a failing test must not hurt the machine
        #expect(engine.cols <= TerminalFrame.maxCols && engine.rows <= TerminalFrame.maxRows)
        #expect(footprint() - before < Self.maxGrowthBytes)
    }
}
}
