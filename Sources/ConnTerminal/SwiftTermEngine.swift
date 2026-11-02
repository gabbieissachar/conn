// SwiftTerm behind ConnCore's TerminalEngine protocol (decision B2).
//
// What SwiftTerm does here: it is the terminal core and the AppKit view. Herdr's frames are plain ANSI, so
// `feed(byteArray:)` is all the input path there is. What it is not allowed to do: send anything. The view is
// observe-only (every byte the view would send to a program is dropped), and the untrusted terminal-to-host features
// - clipboard read and write requests (OSC 52 and Kitty), titles, bells, links - are refused or reduced, because the
// bytes come from an agent's screen.
import AppKit
import CoreText
import SwiftTerm
import ConnCore

@MainActor
final class ObserveOnlyDelegate: TerminalViewDelegate {
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    /// Observe-only: nothing the view would type or report (mouse, focus) leaves the app.
    func send(source: TerminalView, data: ArraySlice<UInt8>) {}
    func scrolled(source: TerminalView, position: Double) {}
    /// A link in a pane is opened only on an explicit click, and only for web URLs.
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return }
        NSWorkspace.shared.open(url)
    }
    func bell(source: TerminalView) {}
    /// Copy requests from the screen are ignored: text the user selects and copies with Cmd+C is the only way in.
    func clipboardCopy(source: TerminalView, content: Data) {}
    func clipboardRead(source: TerminalView) -> Data? { nil }
    func kittyClipboardCapabilities(source: TerminalView) -> KittyClipboardCapabilities { [] }
    func kittyClipboardAvailableMimeTypes(source: TerminalView, location: KittyClipboardLocation) -> [String]? { nil }
    func kittyClipboardRead(source: TerminalView, location: KittyClipboardLocation, mimeType: String) -> KittyClipboardReadResult? { nil }
    func kittyClipboardWrite(source: TerminalView, location: KittyClipboardLocation, content: KittyClipboardWriteContent) -> KittyClipboardWriteResult { .denied }
    func kittyClipboardRequestPermission(source: TerminalView, request: KittyClipboardPermissionRequest) -> KittyClipboardPermissionResult { .deny }
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

/// The SwiftTerm view at a fixed grid, scaled to fit its host. The grid is Herdr's pane size, never the window's.
@MainActor
public final class ConnTerminalView: TerminalView {
    private let observeOnly = ObserveOnlyDelegate()
    public private(set) var gridCols = 80
    public private(set) var gridRows = 24
    public private(set) var fontPoints: CGFloat = 12
    /// The host re-fits the view whenever the grid changes (a full frame can carry a new pane size).
    public var onGridChange: (() -> Void)?
    public private(set) var theme = TerminalTheme.light

    public override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        terminalDelegate = observeOnly
        allowMouseReporting = false          // selection and Cmd+C only
        changeScrollback(nil)                // the stream is the visible screen: no local scrollback exists
        optionAsMetaKey = false
    }

    public func apply(theme: TerminalTheme) {
        self.theme = theme
        reapplyTheme()
    }

    /// A soft reset (which `resize(cols:rows:)` performs) puts the palette back to SwiftTerm's own, so the theme is
    /// installed again after anything that resets.
    func reapplyTheme() {
        nativeBackgroundColor = theme.bg
        nativeForegroundColor = theme.fg
        installColors(theme.swiftTermPalette)
        needsDisplay = true
    }

    /// Set the grid and the font, then snap the view to exactly that many cells.
    public func setGrid(cols: Int, rows: Int, fontPoints newPoints: CGFloat) {
        let changed = cols != gridCols || rows != gridRows
        gridCols = cols; gridRows = rows
        defer { if changed { onGridChange?() } }
        if abs(newPoints - fontPoints) > 0.01 {
            // A font change makes SwiftTerm recompute its grid from the frame. Give it room for any font first, so the
            // recomputed grid is never smaller than the pane's (that would crop the right edge of an idle pane for good).
            setFrameSize(NSSize(width: 4000, height: 3000))
            fontPoints = newPoints
            font = NSFont.monospacedSystemFont(ofSize: newPoints, weight: .regular)
        }
        // resize(cols:rows:) soft-resets the terminal: only do it when the grid really differs.
        // resize(cols:rows:) soft-resets the terminal (which also puts SwiftTerm's own palette back): only do it when the
        // grid really differs, and install the theme again afterwards.
        let dims = terminalDimensions
        if dims.cols != cols || dims.rows != rows {
            resize(cols: cols, rows: rows)
            reapplyTheme()
        }
        let opt = getOptimalFrameSize()
        // A half-point of slack keeps floor(width / cellWidth) from landing one cell short.
        setFrameSize(NSSize(width: opt.width + 0.5, height: opt.height + 0.5))
    }

    /// Asks AppKit to draw the view now. SwiftTerm normally draws from a display-link tick that follows its own dirty
    /// mark; a pane that gets one burst of output and then nothing depended on that single tick (a static "needs you"
    /// or "done" pane stayed blank for a while on the captain's screen). Setting the frame to its current size makes
    /// SwiftTerm invalidate its contents and mark the view for display through AppKit's own cycle, which does not wait
    /// for a tick.
    public func nudgeDisplay() {
        setFrameSize(frame.size)
        needsDisplay = true
    }

    /// One cell at this size as SwiftTerm measures it (the advance of "W" and the line height, each snapped to whole device
    /// pixels so text stays crisp). The host uses it to choose the font; the view's real size is checked afterwards.
    public static func cellSize(forPoints points: CGFloat, scale: CGFloat) -> CGSize {
        let f = NSFont.monospacedSystemFont(ofSize: points, weight: .regular)
        let ct = f as CTFont
        let height = ceil(CTFontGetAscent(ct) + CTFontGetDescent(ct) + CTFontGetLeading(ct))
        var chars: [UniChar] = [0x57], glyphs: [CGGlyph] = [0]
        let width = CTFontGetGlyphsForCharacters(ct, &chars, &glyphs, 1)
            ? f.advancement(forGlyph: NSGlyph(glyphs[0])).width
            : ("W" as NSString).size(withAttributes: [.font: f]).width
        let s = max(scale, 1)
        return CGSize(width: max(1, (width * s).rounded() / s), height: max(1, ceil(height * s) / s))
    }

    /// Width of one cell at the current font (for choosing the font that fits a host).
    public static func cellWidth(forPoints points: CGFloat) -> CGFloat {
        let f = NSFont.monospacedSystemFont(ofSize: points, weight: .regular)
        return ("M" as NSString).size(withAttributes: [.font: f]).width
    }
}

/// Every time any SwiftTerm view finishes drawing (its own hook, `TerminalView.onFramePresented`), the monotonic time.
public final class DrawLog: @unchecked Sendable {
    public static let shared = DrawLog()
    private let lock = NSLock()
    private var times: [UInt64] = []
    private init() {}
    func record() { lock.lock(); if times.count < 100_000 { times.append(monotonicNanos()) }; lock.unlock() }
    public var snapshot: [UInt64] { lock.lock(); defer { lock.unlock() }; return times }
    public func firstDraw(after t: UInt64) -> UInt64? { snapshot.first { $0 >= t } }
}

public final class SwiftTermEngine: TerminalEngine {
    public let view: ConnTerminalView
    /// How many forced draws were issued (tests and the self test read it).
    public private(set) var displayNudges = 0
    private var earlyNudge: DispatchWorkItem?
    private var settleNudge: DispatchWorkItem?
    /// Quick draw after a full frame, and a final draw once the stream has been quiet this long.
    static let earlyDelay: TimeInterval = 0.06, settleDelay: TimeInterval = 0.25
    public var name: String { "swiftterm" }
    /// SwiftTerm does not report unhandled sequences; the cell-grid engine is the one that counts them.
    public var unhandledSequenceCount: Int { 0 }

    public init() {
        view = MainActor.assumeIsolated { ConnTerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 400)) }
        TerminalView.onFramePresented = { DrawLog.shared.record() }
    }

    public var cols: Int { view.terminalDimensions.cols }
    public var rows: Int { view.terminalDimensions.rows }

    /// Clamped like the cell-grid engine's: `apply` and `PaneSession.configure` already keep a stream from asking for more,
    /// but a grid of 65535 by 65535 cells would need about 69 GB, so the engine is the last line.
    public func resize(cols: Int, rows: Int) {
        let c = min(max(2, cols), TerminalFrame.maxCols), r = min(max(1, rows), TerminalFrame.maxRows)
        MainActor.assumeIsolated { view.setGrid(cols: c, rows: r, fontPoints: view.fontPoints) }
    }

    /// A soft reset plus a clear, not RIS: RIS also forgets the theme's default colours and the pane would turn black.
    public func reset() {
        view.softReset()
        // A soft reset leaves the character sets alone: a stream that switched G0 to the DEC line-drawing set (ESC ( 0, or
        // SO) would draw every later frame as box characters. A full frame must start from ASCII in G0 whatever came before.
        view.feed(text: "\u{1b}(B\u{1b})B\u{1b}*B\u{1b}+B\u{0f}\u{1b}[0m\u{1b}[2J\u{1b}[H")
        MainActor.assumeIsolated { view.reapplyTheme() }
        scheduleNudge(early: true)
    }

    public func feed(_ bytes: [UInt8]) {
        view.feed(byteArray: bytes[...])
        scheduleNudge(early: false)
    }

    /// A debounced nudge: `settleDelay` after the last bytes (one extra draw per burst, so a stream that keeps going
    /// is not slowed), and `earlyDelay` after a reset (the first draw of a new pane).
    private func scheduleNudge(early: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let delay = early ? Self.earlyDelay : Self.settleDelay
            let w = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated { guard let self = self else { return }; self.view.nudgeDisplay(); self.displayNudges += 1 }
            }
            if early { self.earlyNudge?.cancel(); self.earlyNudge = w } else { self.settleNudge?.cancel(); self.settleNudge = w }
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
        }
    }

    public func rowText(_ row: Int) -> String {
        guard row >= 0, row < rows else { return "" }
        var s = view.visibleRowsText(row..<(row + 1)).first ?? ""
        while s.hasSuffix(" ") { s.removeLast() }
        return s
    }
}
