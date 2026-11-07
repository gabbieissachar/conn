// Open asks on the agent rows: the reader's own list of replies that wait for the captain, joined to Herdr's panes.
//
// The transcript reader (localhost:8768) answers `GET /api/transcript-reader/open-asks` with
//   { "status": "ok", "generated_at": "<ISO time>", "as_of": "<ISO time>",
//     "asks": [ { "pane_id": "w1:p3", "herdr": "<Herdr session name>", "session": "<reader session id>", "message": "<reply id> | null",
//                 "lines": ["up to 3 plain-text ask lines"], "at": "<ISO time of the reply>",
//                 "tags": ["Answer sheet · 4 questions", ...], "older": false } ] }
// newest first, one entry per live Herdr pane whose conversation (on the reader's reading list) has an open ask. "Open" is the
// reader's own rule (a reply that needs the captain and nothing from them after it); Conn never recomputes it. Pane ids repeat
// across Herdr sessions, so Conn joins an entry to a row by (`herdr`, `pane_id`): the entry's Herdr session name must be the one
// Conn is attached to. Conn opens the reader at `#s=<session>&m=<message>` (an address the reader already parses and scrolls
// to, flashing the reply once), or at `#s=<session>` alone when `message` is null.
//
// The route sits behind the reader's token guard, and the token reaches only the reader page the browser opened, so Conn asks
// from inside its own Reader web view (see OpenAskStore); a missing token, a 404 (`not_built` before the reader's first build,
// or an older reader) and every other failure are the same thing here: no asks.
//
// Everything here is pure so the sort, the 24 hour fold and the click address are tested without a window or a server.
import Foundation

public struct OpenAsk: Equatable, Sendable {
    public var paneID: String
    /// The Herdr session the pane lives in (pane ids repeat across sessions). Nil when the entry names none: it then joins by pane alone.
    public var herdr: String?
    public var session: String
    /// The asking reply. Nil when the reader could not name it: the reader then opens on the conversation's newest turn.
    public var message: String?
    public var lines: [String]
    public var at: Date?
    public var tags: [String]
    /// The reader's own flag (over 24 hours when it answered). Conn judges age from `at` when it has one, so the fold follows
    /// the clock between polls; this flag is only the fallback for an ask without a usable time.
    public var older: Bool

    public init(paneID: String, herdr: String? = nil, session: String, message: String?, lines: [String] = [], at: Date? = nil, tags: [String] = [], older: Bool = false) {
        self.paneID = paneID; self.herdr = herdr; self.session = session; self.message = message; self.lines = lines; self.at = at; self.tags = tags; self.older = older
    }

    /// Asks older than this sit behind "show N older" (decision G10).
    public static let freshWindow: TimeInterval = 24 * 3600

    public func isOlder(now: Date) -> Bool {
        guard let at = at else { return older }
        return now.timeIntervalSince(at) >= Self.freshWindow
    }

    public func age(now: Date) -> TimeInterval? { at.map { max(0, now.timeIntervalSince($0)) } }

    /// The ask as the row shows it: the lines joined with a space, a list marker (`- `, `* `, `1. `) dropped from the start of each
    /// (the reader's ask lines are often one item of a list). The row clamps it to three lines.
    public var text: String {
        lines.map { $0.replacingOccurrences(of: "^\\s*(?:[-*•]|\\d+[.)])\\s+", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// The reader address of this ask, without the leading `#`: the session, then the asking reply (the session alone when the
    /// reader named no reply).
    public var readerFragment: String { "s=\(session)" + (message.map { "&m=\($0)" } ?? "") }

    /// What makes this ask this ask, for the read mark: the pane (and its Herdr session) plus the asking turn, so a new ask on the same pane
    /// is a different ask and shows as unread. With no turn id the reader's time stands in (a later ask has a later time), else the session.
    public var readKey: String {
        let turn = message ?? at.map { "t\(Int($0.timeIntervalSince1970))" } ?? "s\(session)"
        return [herdr ?? "", paneID, turn].joined(separator: "\u{1F}")
    }

    // The shapes the reader accepts (`address.js`): a hexadecimal session id with dashes, and a turn id of 6 to 64 characters.
    // Conn is stricter about the session than it needs to be for nothing else (an id that fails here is one the reader would not
    // follow either), and it puts both into a script, so only these characters ever get there.
    public static func validSession(_ s: String) -> Bool { s.range(of: "^[0-9A-Za-z-]{1,64}$", options: .regularExpression) != nil }
    public static func validMessage(_ s: String) -> Bool { s.range(of: "^[0-9A-Za-z_-]{6,64}$", options: .regularExpression) != nil }
}

/// Which asks the captain has read (clicked, or marked), kept by `OpenAsk.readKey`. A read ask is hidden from the sidebar and not
/// counted; a new ask on the same pane has another key and shows again. Conn's own record, not the reader's (ROADMAP: it may move to the
/// reader's planned store so the phone and the reader agree).
public struct AskReadState: Equatable, Sendable {
    /// Key -> when it was marked read (seconds since 1970).
    public private(set) var marked: [String: Double]
    /// At most this many marks are kept (the oldest go first), and none older than `maxAge`: asks come and go and the list must not grow for ever.
    public static let maxEntries = 400
    public static let maxAge: TimeInterval = 30 * 24 * 3600

    public init(marked: [String: Double] = [:]) { self.marked = marked }

    public func isRead(_ ask: OpenAsk) -> Bool { marked[ask.readKey] != nil }
    public var isEmpty: Bool { marked.isEmpty }

    public mutating func markRead(_ ask: OpenAsk, at date: Date = Date()) {
        marked[ask.readKey] = date.timeIntervalSince1970
        prune(now: date)
    }

    public mutating func markUnread(_ ask: OpenAsk) { marked[ask.readKey] = nil }
    public mutating func clear() { marked = [:] }

    public mutating func prune(now: Date) {
        let floor = now.timeIntervalSince1970 - Self.maxAge
        marked = marked.filter { $0.value >= floor }
        if marked.count > Self.maxEntries {
            let keep = marked.sorted { $0.value > $1.value }.prefix(Self.maxEntries)
            marked = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
    }
}

/// What the reader answered.
public struct OpenAsksFeed: Equatable, Sendable {
    public var generatedAt: Date?
    public var asks: [OpenAsk]

    public init(generatedAt: Date? = nil, asks: [OpenAsk] = []) { self.generatedAt = generatedAt; self.asks = asks }

    /// The feed in these bytes, or nil when they are not one (not JSON, or no `asks` list). An entry that cannot be used (no pane, or
    /// a session the reader could not follow) is dropped and the rest are kept. A `message` that is null, missing or not an id the
    /// reader would follow is kept as "no reply": the row still opens the conversation. Two entries for one (Herdr session, pane)
    /// keep the newer. Unknown fields (`status`, `as_of`, and any the reader adds later) are ignored.
    public static func parse(_ data: Data) -> OpenAsksFeed? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let list = root["asks"] as? [Any] else { return nil }
        var byKey: [String: OpenAsk] = [:]
        var order: [String] = []
        for item in list {
            guard let o = item as? [String: Any], let pane = o["pane_id"] as? String, !pane.isEmpty,
                  let session = o["session"] as? String, OpenAsk.validSession(session) else { continue }
            let herdr = (o["herdr"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let message = (o["message"] as? String).flatMap { OpenAsk.validMessage($0) ? $0 : nil }
            let ask = OpenAsk(paneID: pane, herdr: herdr, session: session, message: message,
                              lines: (o["lines"] as? [Any])?.compactMap { $0 as? String } ?? [],
                              at: Self.time(o["at"]),
                              tags: (o["tags"] as? [Any])?.compactMap { $0 as? String }.filter { !$0.isEmpty } ?? [],
                              older: (o["older"] as? Bool) ?? false)
            let key = (herdr ?? "") + "\u{1F}" + pane
            if let have = byKey[key] {
                if (ask.at ?? .distantPast) > (have.at ?? .distantPast) { byKey[key] = ask }
            } else { byKey[key] = ask; order.append(key) }
        }
        return OpenAsksFeed(generatedAt: Self.time(root["generated_at"]), asks: order.compactMap { byKey[$0] })
    }

    /// An ISO time (with or without fractional seconds, any number of digits) or a number of seconds since 1970.
    static func time(_ v: Any?) -> Date? {
        if let n = v as? NSNumber, !(v is Bool) { let d = n.doubleValue; return d.isFinite && d > 0 ? Date(timeIntervalSince1970: d) : nil }
        guard let s = v as? String, !s.isEmpty else { return nil }
        // ISO8601DateFormatter takes exactly three fractional digits; Python writes six.
        let t = s.replacingOccurrences(of: "(\\.\\d{3})\\d+", with: "$1", options: .regularExpression)
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: t) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: t)
    }

    /// The same feed with every time moved by `seconds`. A fixture describes one moment (its `generated_at`); this moves that
    /// moment to now, so an invented ask is always as old as the fixture says and never ages out of the 24 hour window.
    public func shifted(by seconds: TimeInterval) -> OpenAsksFeed {
        var f = self
        f.generatedAt = generatedAt?.addingTimeInterval(seconds)
        f.asks = asks.map { var a = $0; a.at = a.at?.addingTimeInterval(seconds); return a }
        return f
    }
}

/// The asks joined to the live panes, and what the sidebar does with them.
public struct OpenAsks: Equatable, Sendable {
    public private(set) var byPane: [String: OpenAsk]

    public static let none = OpenAsks(byPane: [:])
    public init(byPane: [String: OpenAsk]) { self.byPane = byPane }
    /// The asks of this feed that belong to the Herdr session Conn is attached to (`herdrSession`): an entry that names another
    /// Herdr session is dropped, because its pane id may be one of ours by coincidence. An entry that names none joins by pane alone,
    /// and so does everything when `herdrSession` is nil.
    public init(feed: OpenAsksFeed?, herdrSession: String? = nil) {
        var m: [String: OpenAsk] = [:]
        for a in feed?.asks ?? [] {
            if let h = a.herdr, let mine = herdrSession, h != mine { continue }
            if let have = m[a.paneID], (have.at ?? .distantPast) >= (a.at ?? .distantPast) { continue }
            m[a.paneID] = a
        }
        byPane = m
    }

    public var isEmpty: Bool { byPane.isEmpty }

    /// The asks the sidebar lists: every ask under 24 hours, plus the older ones when the captain asked for them.
    public func visible(showOlder: Bool, now: Date) -> [String: OpenAsk] {
        byPane.filter { showOlder || !$0.value.isOlder(now: now) }
    }

    /// How many asks sit behind "show N older", counting only panes that are live (an ask for a pane that is gone is not shown at all).
    /// Asks already read are not offered: `read` leaves them out.
    public func olderCount(among agents: [Agent], now: Date, read: AskReadState = AskReadState()) -> Int {
        agents.reduce(0) { n, a in
            guard let ask = byPane[a.id], ask.isOlder(now: now), !read.isRead(ask) else { return n }
            return n + 1
        }
    }

    /// How many asks sit behind "show N read": read ones for live panes that the age fold would list.
    public func readCount(among agents: [Agent], showOlder: Bool, now: Date, read: AskReadState) -> Int {
        agents.reduce(0) { n, a in
            guard let ask = byPane[a.id], read.isRead(ask), showOlder || !ask.isOlder(now: now) else { return n }
            return n + 1
        }
    }
}

/// What Conn holds between two answers from the reader.
public struct OpenAsksState: Equatable, Sendable {
    public private(set) var asks: OpenAsks = .none
    /// When the last answer (good or not) was taken: the clock the 24 hour fold and the ages are judged by.
    public private(set) var now = Date()
    public private(set) var failures = 0
    /// A fixture feed describes one moment (its `generated_at`); its times are moved so that moment is the moment of the answer.
    public var rebaseToNow = false
    /// Failed answers in a row that clear the asks. One is forgiven: a reader that restarts, or answers slowly once, does not make
    /// the rows jump twice. After that the reader is down or has no such endpoint, and the rows show no asks.
    public static let failuresBeforeClearing = 2

    /// The Herdr session name Conn is attached to; asks for another one are not ours (see `OpenAsks.init(feed:herdrSession:)`).
    public var herdrSession: String?

    public init(rebaseToNow: Bool = false, herdrSession: String? = nil) { self.rebaseToNow = rebaseToNow; self.herdrSession = herdrSession }

    /// Take one answer; nil is "no good answer" (down, missing endpoint, slow, not a feed).
    public mutating func apply(_ feed: OpenAsksFeed?, at date: Date) {
        now = date
        guard var feed = feed else {
            failures += 1
            if failures >= Self.failuresBeforeClearing { asks = .none }
            return
        }
        failures = 0
        if rebaseToNow, let generated = feed.generatedAt { feed = feed.shifted(by: date.timeIntervalSince(generated)) }
        asks = OpenAsks(feed: feed, herdrSession: herdrSession)
    }
}

extension Snapshot {
    /// Agents in the order of the sidebar and Cmd+1...9 once asks are known (decision G12): agents that need the captain first,
    /// prompt waiting (Herdr's `blocked`) before the rest and the newest ask first inside each of those two groups; every other agent
    /// after them in `prioritized`'s order (working, done, idle). `asks` is the visible set (`OpenAsks.visible`): a hidden older ask
    /// does not move a row. Without asks this is exactly `prioritized`.
    public func prioritized(asks: [String: OpenAsk]) -> [Agent] {
        if asks.isEmpty { return prioritized }
        func needsYou(_ a: Agent) -> Bool { a.state == .blocked || asks[a.id] != nil }
        let base = prioritized
        let front = base.enumerated().filter { needsYou($0.element) }.sorted { l, r in
            let lb = l.element.state == .blocked, rb = r.element.state == .blocked
            if lb != rb { return lb }
            let lt = asks[l.element.id]?.at ?? .distantPast, rt = asks[r.element.id]?.at ?? .distantPast
            if lt != rt { return lt > rt }
            return l.offset < r.offset
        }
        return front.map(\.element) + base.filter { !needsYou($0) }
    }

    /// `agent(after:offset:)` in the order `prioritized(asks:)` gives.
    public func agent(after current: String?, offset: Int, asks: [String: OpenAsk]) -> Agent? {
        let list = prioritized(asks: asks)
        guard !list.isEmpty else { return nil }
        let i = list.firstIndex { $0.id == current } ?? (offset >= 0 ? -1 : 0)
        return list[((i + offset) % list.count + list.count) % list.count]
    }
}

/// How Conn finds and reads the reader's open asks.
public enum OpenAsksSource {
    public static let path = "/api/transcript-reader/open-asks"

    /// One read of an address (a `file:` one, or an `http` one that needs no token: a test server, a copy of the feed). nil for
    /// anything but a good answer: the address is down, the endpoint is missing (404), the answer is slow or is not a feed. Never
    /// throws and never waits longer than `timeout`. The live reader's own route needs its token and is read by the Reader web view.
    public static func fetch(_ url: URL, timeout: TimeInterval = 3) async -> OpenAsksFeed? {
        if url.isFileURL { return (try? Data(contentsOf: url)).flatMap(OpenAsksFeed.parse) }
        guard url.scheme == "http" || url.scheme == "https" else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, resp) = try? await URLSession.shared.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return OpenAsksFeed.parse(data)
    }
}

/// How long ago, as the sidebar says it: `now`, `N min`, `N h`, `N d` (the prototype's words).
public enum AskAge {
    public static func text(_ age: TimeInterval?) -> String {
        guard let age = age else { return "" }
        let m = Int(age / 60)
        if m < 1 { return "now" }
        if m < 60 { return "\(m) min" }
        let h = m / 60
        if h < 24 { return "\(h) h" }
        return "\(h / 24) d"
    }
}
