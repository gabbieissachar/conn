// The terminal boundary (decision B2: SwiftTerm behind a protocol).
//
// Herdr renders every pane on the server and streams the result as ANSI, with rows positioned absolutely. A client
// only has to turn those bytes into a cell grid and draw it. The engine that holds the grid is replaceable:
//   - GridEngine (here): the 450-line decoder from the prototype, enough for Herdr's frames.
//   - SwiftTermEngine (ConnTerminal): upstream SwiftTerm's terminal core and its AppKit view.
// Anything above this protocol (PaneSession, the app) neither knows nor cares which one it feeds.
import Foundation

public protocol TerminalEngine: AnyObject {
    var name: String { get }
    var cols: Int { get }
    var rows: Int { get }
    func resize(cols: Int, rows: Int)
    /// Clear the screen and forget the pen state, as a full frame requires.
    func reset()
    func feed(_ bytes: [UInt8])
    /// Text of one row without trailing spaces (selection, tests, privacy checks).
    func rowText(_ row: Int) -> String
    /// How many escape sequences the engine could not act on (evidence of decoder coverage; 0 on Herdr's frames).
    var unhandledSequenceCount: Int { get }
}

public extension TerminalEngine {
    /// Apply one stream frame: a full frame carries the pane's geometry and repaints everything.
    func apply(_ frame: TerminalFrame) {
        guard frame.isSane else { return }
        if frame.full {
            resize(cols: frame.width, rows: frame.height)
            reset()
        }
        feed(frame.bytes)
    }
}

public final class GridEngine: TerminalEngine {
    public let screen: VTScreen
    public var name: String { "grid" }
    public var cols: Int { screen.cols }
    public var rows: Int { screen.rows }
    public var unhandledSequenceCount: Int { screen.unhandled.values.reduce(0, +) }

    public init(cols: Int = 80, rows: Int = 24) { screen = VTScreen(cols: cols, rows: rows) }

    public func resize(cols: Int, rows: Int) { screen.resize(cols: min(max(1, cols), TerminalFrame.maxCols), rows: min(max(1, rows), TerminalFrame.maxRows)) }
    public func reset() { screen.clearAll() }
    public func feed(_ bytes: [UInt8]) { screen.feed(bytes) }
    public func rowText(_ row: Int) -> String { row >= 0 && row < screen.rows ? screen.rowText(row) : "" }
}
