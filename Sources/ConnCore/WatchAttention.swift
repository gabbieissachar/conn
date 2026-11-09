// Watch focus: a column's content can be hidden (blurred) so a session that is not the one being read does not pull the eye, and a hidden session whose
// running turn ends leaves a cue that stays until the column is shown again. This file is the rule, with no view in it: which sessions are hidden, whether
// each was seen working since, and the cue a finished turn raised.
//
// The cue is about a turn that ended, not a state that flickered: a session that stops working must stay stopped for `settle` seconds before the cue is raised, so
// a pause between two tool calls does not cry wolf. What the cue says follows the state the session ended in: waiting on the person ("needs you") or finished.
//
// Hidden sessions are kept by session id (not by column), so a session keeps being hidden when its column moves with a change of count, and a session that
// leaves Watch loses it (`keep(only:)`). Only the session ids and a pending cue are written down (`encoded`): no text from any conversation.
import Foundation

public enum WatchCue: String, Codable, Equatable, Sendable {
    /// The turn ended and nothing waits on the person.
    case finished
    /// The turn ended on a question or a permission prompt.
    case needsYou
}

public struct WatchAttention: Equatable, Sendable {
    public struct Hold: Equatable, Sendable {
        /// The session was seen working since it was hidden (or was working when it was hidden): the turn it is in is one a cue is owed for.
        public var running: Bool
        /// The turn ended while hidden: what it ended as, and when the cue was raised.
        public var cue: WatchCue?
        public var cueAt: Date?
        /// The session stopped working at this time and has not been seen working again (a cue is raised once it has stayed that way for `settle`).
        public var quietSince: Date?
        /// What it stopped as.
        public var quietState: AgentState?

        public init(running: Bool = false, cue: WatchCue? = nil, cueAt: Date? = nil) { self.running = running; self.cue = cue; self.cueAt = cueAt }
    }

    /// How long a session must stay stopped before its turn counts as over.
    public static let settle: TimeInterval = 3

    /// The hidden sessions, by session id as the column holds it.
    public private(set) var holds: [String: Hold] = [:]

    public init() {}

    public var isEmpty: Bool { holds.isEmpty }
    public func isHidden(_ session: String) -> Bool { holds[session] != nil }
    public func cue(for session: String) -> WatchCue? { holds[session]?.cue }
    public func cueTime(for session: String) -> Date? { holds[session]?.cueAt }

    /// Hide a session. `state` is what the app knows of it now (nil: no signal); a session that is working already owes a cue when that turn ends.
    public mutating func hide(_ session: String, state: AgentState?) {
        holds[session] = Hold(running: state == .working)
    }

    /// Show a session again. Returns the cue it was holding (the app then lands the column on the reply that turn ended with), nil when none was.
    @discardableResult
    public mutating func show(_ session: String) -> WatchCue? {
        defer { holds.removeValue(forKey: session) }
        return holds[session]?.cue
    }

    /// Tell the rule what a hidden session is doing now. A session that is not hidden, or one with no signal (nil), changes nothing.
    /// Returns true when this raised a cue.
    @discardableResult
    public mutating func observe(_ session: String, state: AgentState?, now: Date) -> Bool {
        guard var h = holds[session], let state = state else { return false }
        switch state {
        case .working:
            h.running = true
            h.quietSince = nil
            h.quietState = nil
        case .unknown:
            break
        case .idle, .done, .blocked:
            if h.running {
                if h.quietSince == nil { h.quietSince = now }
                h.quietState = state
            }
        }
        holds[session] = h
        return raise(session, now: now)
    }

    /// Raise the cues whose session has now stayed stopped long enough. Returns those sessions.
    @discardableResult
    public mutating func advance(now: Date) -> [String] {
        holds.keys.sorted().filter { raise($0, now: now) }
    }

    /// When the next stopped session will have settled (nil when none is waiting): the app wakes then and calls `advance`.
    public var nextSettle: Date? {
        holds.values.compactMap { $0.running ? $0.quietSince.map { $0.addingTimeInterval(Self.settle) } : nil }.min()
    }

    private mutating func raise(_ session: String, now: Date) -> Bool {
        guard var h = holds[session], h.running, let since = h.quietSince, let state = h.quietState, now.timeIntervalSince(since) >= Self.settle else { return false }
        h.cue = state == .blocked ? .needsYou : .finished
        h.cueAt = now
        h.running = false
        h.quietSince = nil
        h.quietState = nil
        holds[session] = h
        return true
    }

    /// Forget every hidden session that is not in `sessions` (a column closed or replaced). Returns whether anything went.
    @discardableResult
    public mutating func keep(only sessions: Set<String>) -> Bool {
        let gone = holds.keys.filter { !sessions.contains($0) }
        for s in gone { holds.removeValue(forKey: s) }
        return !gone.isEmpty
    }

    // MARK: kept across launches

    private struct Stored: Codable { var v: Int; var hidden: [String: Entry] }
    private struct Entry: Codable { var cue: WatchCue?; var at: Double? }

    /// The session ids and any cue waiting, as data for Conn's own settings. Nothing is said of what any conversation holds.
    public func encoded() -> Data? {
        let hidden = holds.mapValues { Entry(cue: $0.cue, at: $0.cueAt?.timeIntervalSince1970) }
        return try? JSONEncoder().encode(Stored(v: 1, hidden: hidden))
    }

    /// Read what `encoded` wrote. Anything that does not read as that is nothing hidden; a session id that is not one a column could hold is dropped.
    public static func decode(_ data: Data?) -> WatchAttention {
        var a = WatchAttention()
        guard let data = data, let s = try? JSONDecoder().decode(Stored.self, from: data), s.v == 1 else { return a }
        for (session, e) in s.hidden where session.count <= 200 && !session.isEmpty {
            a.holds[session] = Hold(running: false, cue: e.cue, cueAt: e.at.map { Date(timeIntervalSince1970: $0) })
        }
        return a
    }
}
