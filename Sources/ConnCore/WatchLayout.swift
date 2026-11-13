// The Watch view's columns: which session each column shows, and which column a session goes to.
//
// Watch shows 2 to 4 whole conversations side by side, each on the reader's lite page. This file is the placement rule only,
// as plain values, so unit tests cover it without a window. The rule (the captain's, 2026-11-06):
//   - a session that already has a column keeps it: nothing else moves;
//   - otherwise it goes into a free column, if there is one;
//   - otherwise it replaces the least recently used column, in that column's own place, and the other columns are untouched.
// A session link clicked inside a column (`open(_:from:)`) follows the same rule, with one difference: the column that was clicked
// counts as used by that click, and is never the one replaced (the link must not remove the page it sits in).
// "Used" is a click, a scroll, a keystroke or focus inside the column, and opening a session in it. The clock is a counter, not
// a date, so the order is exact and a test does not depend on time.
import Foundation

public struct WatchColumn: Equatable, Sendable {
    /// Stable for the column's life, also when another session replaces the one it shows (the web view is kept with it).
    public var id: Int
    /// The session id the column was opened with (the lite page takes it, or its first eight characters).
    public var session: String
    /// The value of the layout's clock when the column was last used.
    public var lastUsed: UInt64
}

/// What `WatchLayout.open` did.
public enum WatchPlacement: Equatable, Sendable {
    /// The session already has this column.
    case alreadyOpen(column: Int)
    /// The session took this empty column.
    case freeSlot(column: Int)
    /// The session took the place of the least recently used column, which showed `previous`.
    case replaced(column: Int, previous: String)

    public var column: Int {
        switch self { case .alreadyOpen(let c), .freeSlot(let c), .replaced(let c, _): return c }
    }
}

public struct WatchLayout: Equatable, Sendable {
    public static let allowedCounts = 2...4
    public static let defaultCount = 3
    public static func clamped(_ n: Int) -> Int { min(allowedCounts.upperBound, max(allowedCounts.lowerBound, n)) }

    /// One entry per column position, left to right; nil is a free column.
    public private(set) var slots: [WatchColumn?]
    private var clock: UInt64 = 0
    private var nextID = 1

    public init(count: Int = WatchLayout.defaultCount) { slots = Array(repeating: nil, count: WatchLayout.clamped(count)) }

    public var count: Int { slots.count }
    public var sessions: [String] { slots.compactMap { $0?.session } }
    public var openCount: Int { sessions.count }

    /// The same session: equal ids, or one is the first characters of the other (the reader writes its address with the first
    /// eight characters). A shorter id than eight characters only matches itself, so two different sessions never merge.
    public static func same(_ a: String, _ b: String) -> Bool {
        guard !a.isEmpty, !b.isEmpty else { return false }
        if a == b { return true }
        return min(a.count, b.count) >= 8 && (a.hasPrefix(b) || b.hasPrefix(a))
    }

    public func index(of session: String) -> Int? { slots.firstIndex { $0.map { WatchLayout.same($0.session, session) } ?? false } }

    /// What the columns hold now, to keep: the count and each column's session, left to right.
    public var setup: WatchSetup { WatchSetup(columns: slots.map { $0?.session }) }

    /// Make the columns exactly this setup: the count, and each session in its place. A column that already shows the same session in
    /// the same place keeps its identity (so its web view stays); the others are new. Nothing says which column was used last, so the
    /// columns count as used from left to right: the leftmost is the one a new session replaces first.
    /// `isGone` names a session that no longer exists: its column is left free (for the normal fill rule) and it is returned.
    /// A setup with a number of columns Watch does not have is not applied.
    @discardableResult
    public mutating func apply(_ setup: WatchSetup, isGone: (String) -> Bool = { _ in false }) -> [String] {
        guard let s = setup.sanitized() else { return [] }
        var gone: [String] = []
        var next: [WatchColumn?] = []
        for (i, session) in s.columns.enumerated() {
            guard let session = session else { next.append(nil); continue }
            if isGone(session) { gone.append(session); next.append(nil); continue }
            if i < slots.count, let kept = slots[i], kept.session == session {
                next.append(WatchColumn(id: kept.id, session: session, lastUsed: 0))
            } else {
                next.append(WatchColumn(id: nextID, session: session, lastUsed: 0))
                nextID += 1
            }
        }
        for i in next.indices where next[i] != nil { next[i]!.lastUsed = tick() }
        slots = next
        return gone
    }

    /// A layout holding this setup.
    public init(restoring setup: WatchSetup, isGone: (String) -> Bool = { _ in false }) {
        self.init(count: setup.count)
        apply(setup, isGone: isGone)
    }

    /// The occupied column used longest ago (the leftmost one on a tie, which cannot happen with the counter clock).
    public var leastRecentlyUsed: Int? { leastRecentlyUsed(excluding: nil) }

    /// The same, leaving one column out of the choice.
    public func leastRecentlyUsed(excluding skipped: Int?) -> Int? {
        var best: Int?
        for (i, s) in slots.enumerated() {
            guard let s = s, i != skipped else { continue }
            if best == nil || s.lastUsed < slots[best!]!.lastUsed { best = i }
        }
        return best
    }

    private mutating func tick() -> UInt64 { clock += 1; return clock }

    /// Show `session`: the rule in the file header. The result says which column it is in and how it got there.
    /// `clicked` is the column a link was clicked in, when the session is opened from a link: that column counts as used and is
    /// never the one replaced. Without it (a sidebar row, a key) every column may be replaced.
    @discardableResult
    public mutating func open(_ session: String, from clicked: Int? = nil) -> WatchPlacement {
        let clicked = clicked.flatMap { slots.indices.contains($0) && slots[$0] != nil ? $0 : nil }
        if let c = clicked { touch(c) }
        if let i = index(of: session) {
            slots[i]!.lastUsed = tick()
            return .alreadyOpen(column: i)
        }
        if let free = slots.firstIndex(where: { $0 == nil }) {
            slots[free] = WatchColumn(id: nextID, session: session, lastUsed: tick())
            nextID += 1
            return .freeSlot(column: free)
        }
        let i = leastRecentlyUsed(excluding: clicked) ?? leastRecentlyUsed!
        let previous = slots[i]!.session
        slots[i]!.session = session
        slots[i]!.lastUsed = tick()
        return .replaced(column: i, previous: previous)
    }

    /// The column was used (click, scroll, keystroke or focus inside it).
    public mutating func touch(_ column: Int) {
        guard slots.indices.contains(column), slots[column] != nil else { return }
        slots[column]!.lastUsed = tick()
    }

    /// The column was closed: it is free again, and the other columns stay where they are.
    @discardableResult
    public mutating func close(_ column: Int) -> String? {
        guard slots.indices.contains(column), let s = slots[column] else { return nil }
        slots[column] = nil
        return s.session
    }

    /// Change the number of columns. More columns add free ones on the right. Fewer keeps the most recently used sessions, in
    /// their order, and returns the sessions that no longer fit.
    @discardableResult
    public mutating func setCount(_ requested: Int) -> [String] {
        let n = WatchLayout.clamped(requested)
        guard n != slots.count else { return [] }
        var kept = slots.compactMap { $0 }
        var dropped: [String] = []
        while kept.count > n {
            let oldest = kept.indices.min { kept[$0].lastUsed < kept[$1].lastUsed }!
            dropped.append(kept[oldest].session)
            kept.remove(at: oldest)
        }
        // A shrink that loses nobody still closes the gaps from the right: keep the sessions in their order.
        if n < slots.count { slots = kept.map { Optional($0) } + Array(repeating: nil, count: n - kept.count) }
        else { slots += Array(repeating: nil, count: n - slots.count) }
        return dropped
    }

    /// Fill the free columns with these sessions, in this order (the first is the one the person is looking at, so it counts as
    /// the most recently used). Sessions already open are skipped. Returns the columns that were filled.
    @discardableResult
    public mutating func fill(with candidates: [String]) -> [Int] {
        var picks: [String] = []
        for c in candidates where index(of: c) == nil && !picks.contains(where: { WatchLayout.same($0, c) }) { picks.append(c) }
        let free = slots.indices.filter { slots[$0] == nil }
        let taking = Array(picks.prefix(free.count))
        // The clock runs forward, so the last pick gets the earliest tick and the first pick the latest.
        for (n, session) in taking.enumerated().reversed() {
            slots[free[n]] = WatchColumn(id: nextID, session: session, lastUsed: tick())
            nextID += 1
        }
        return Array(free.prefix(taking.count))
    }
}

/// The address of a conversation on the reader's lite page: `#s=<session>` or `#s=<session>&m=<turn id>` (the page scrolls to
/// that turn's reply and outlines it; README of the reader, "The lite page"). Both parts are checked against the shapes the
/// page accepts, so nothing odd is ever put into a web view's script or address.
public enum WatchAddress {
    public static func validSession(_ s: String) -> Bool { s.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil }
    /// The reader's turn ids: 6 to 64 of letters, digits, `_` and `-`.
    public static func validTurn(_ s: String) -> Bool { s.range(of: "^[0-9A-Za-z_-]{6,64}$", options: .regularExpression) != nil }

    /// The fragment (without `#`), or nil when the session is not one the page could open. A turn id that is not valid is left
    /// off: the conversation then opens at its newest turn.
    public static func fragment(session: String, message: String?) -> String? {
        guard validSession(session) else { return nil }
        if let m = message, validTurn(m) { return "s=\(session)&m=\(m)" }
        return "s=\(session)"
    }

    /// The query item that tells a lite page it is a Watch column (`watch=1`). The column's own header already names the session, so a
    /// page that reads the flag leaves out its session picker; a page that does not read it ignores it (checked on the reader's lite
    /// page of 2026-11-13: it renders as before). The contract with the reader is `data/conn-fix-queue-2/watch-picker-note.md`.
    public static let columnFlag = URLQueryItem(name: "watch", value: "1")

    /// The address a lite page is loaded at. `pin` is the load counter (`conn=<n>`, which makes WKWebView treat the load as a new
    /// document and not as a fragment jump); `column` adds `watch=1`, for a Watch column's page and nothing else (the full reader page
    /// never gets it). The query's own items come first, then `conn`, then `watch`; the fragment is `#s=...` as `fragment(session:message:)` made it.
    ///
    /// A file page (a stand-in for a check) is returned as it is: WKWebView refuses to show a file address that carries a query ("The URL can't be
    /// shown"), and such a page takes its hash after it has loaded.
    public static func pageURL(base: URL, fragment: String?, pin: Int?, column: Bool) -> URL? {
        if base.isFileURL { return base }
        guard var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        // Whatever else the base address asks for stays; Conn's own two items are always set here, never copied from an earlier load.
        var items = (comps.queryItems ?? []).filter { $0.name != "conn" && $0.name != columnFlag.name }
        if let pin = pin { items.append(URLQueryItem(name: "conn", value: "\(pin)")) }
        if column { items.append(columnFlag) }
        comps.queryItems = items.isEmpty ? nil : items
        comps.fragment = fragment
        return comps.url
    }
}
