// The focus session: one block of work of a length chosen each time (decision F4), no breaks inside it. A pure value type with no timer and no clock of
// its own: every call takes the moment it happens, so the rules are unit-tested without waiting.
//
//   idle --start--> running <--pause/resume--> paused
//   running --time is up--> done --restart--> running          (done --dismiss--> idle)
//   running or paused --stop early--> idle
//
// Time is a deadline `Date` (`endsAt`) while running and the time left while paused, so a sleeping Mac, App Nap or a late timer tick cannot make the
// countdown drift. Focused time is the time spent running (a pause does not count); a session that ran past its deadline while the Mac slept counts
// only up to the deadline.
import Foundation

public struct FocusSession: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case idle
        case running(endsAt: Date)
        case paused(remaining: TimeInterval)
        case done
    }

    public enum End: Equatable, Sendable { case finished, stoppedEarly }

    public enum Event: Equatable, Sendable {
        case started, paused, resumed, extended
        /// The session is over: it ran out (`finished`, the Done state) or the person stopped it (`stoppedEarly`, back to idle). `focusedSeconds` is
        /// the time this run was running, for the daily total.
        case ended(End, focusedSeconds: TimeInterval)
    }

    public static let minMinutes = 1
    public static let maxMinutes = 180
    /// What "+5 min" adds.
    public static let extensionSeconds: TimeInterval = 300
    /// The default length offered first (a person picks one each time; this is only the first suggestion).
    public static let defaultMinutes = 25
    public static let presetMinutes = [15, 25, 45, 60, 90]

    public private(set) var phase: Phase = .idle
    /// The length of the last start, in seconds: what Restart repeats. "+5 min" lengthens this run only.
    public private(set) var lengthSeconds: TimeInterval
    public private(set) var startedAt: Date?
    /// Running time of this run that is already closed (a pause or the end closes it).
    private var accrued: TimeInterval = 0
    private var runningSince: Date?

    public init(lengthMinutes: Int = FocusSession.defaultMinutes) {
        lengthSeconds = TimeInterval(Self.clamped(lengthMinutes) * 60)
    }

    public static func clamped(_ minutes: Int) -> Int { min(maxMinutes, max(minMinutes, minutes)) }

    public var lengthMinutes: Int { Int(lengthSeconds / 60) }

    public var isRunning: Bool { if case .running = phase { return true } else { return false } }
    public var isPaused: Bool { if case .paused = phase { return true } else { return false } }
    /// Running or paused: the Focus stays on and the marker file stays (decision F15).
    public var isActive: Bool { isRunning || isPaused }
    public var isDone: Bool { phase == .done }
    public var isIdle: Bool { phase == .idle }

    /// The deadline while running; nil otherwise (the marker file's `ends_at` is null while paused).
    public var endsAt: Date? { if case .running(let e) = phase { return e } else { return nil } }

    /// Time left: counted down while running, frozen while paused, zero otherwise.
    public func remaining(at now: Date) -> TimeInterval {
        switch phase {
        case .running(let e): return max(0, e.timeIntervalSince(now))
        case .paused(let r): return r
        case .idle, .done: return 0
        }
    }

    /// Time spent running in this run so far (a pause does not count).
    public func focused(at now: Date) -> TimeInterval {
        switch phase {
        case .running(let e): return accrued + max(0, min(now, e).timeIntervalSince(runningSince ?? now))
        case .paused, .done: return accrued
        case .idle: return 0
        }
    }

    /// 0 at the start, 1 at the end, for a progress bar. Measured against what the run has to cover (its length plus every "+5 min").
    public func progress(at now: Date) -> Double {
        guard isActive || isDone else { return 0 }
        let left = remaining(at: now)
        let total = focused(at: now) + left
        return total > 0 ? min(1, max(0, focused(at: now) / total)) : 1
    }

    // MARK: transitions (each returns what happened; an empty list means the call changed nothing)

    /// Start a session of `minutes` (clamped to 1...180) from idle or done.
    @discardableResult
    public mutating func start(minutes: Int, now: Date) -> [Event] {
        guard phase == .idle || phase == .done else { return [] }
        lengthSeconds = TimeInterval(Self.clamped(minutes) * 60)
        return begin(now: now)
    }

    /// Repeat the last length from the Done state (or from idle).
    @discardableResult
    public mutating func restart(now: Date) -> [Event] {
        guard phase == .idle || phase == .done else { return [] }
        return begin(now: now)
    }

    private mutating func begin(now: Date) -> [Event] {
        startedAt = now
        accrued = 0
        runningSince = now
        phase = .running(endsAt: now.addingTimeInterval(lengthSeconds))
        return [.started]
    }

    @discardableResult
    public mutating func pause(now: Date) -> [Event] {
        guard case .running(let e) = phase else { return [] }
        if now >= e { return tick(now: now) }
        accrued += max(0, now.timeIntervalSince(runningSince ?? now))
        runningSince = nil
        phase = .paused(remaining: e.timeIntervalSince(now))
        return [.paused]
    }

    @discardableResult
    public mutating func resume(now: Date) -> [Event] {
        guard case .paused(let r) = phase else { return [] }
        runningSince = now
        phase = .running(endsAt: now.addingTimeInterval(r))
        return [.resumed]
    }

    /// "+5 min": running or paused. Never takes the time left past the longest session (180 minutes).
    @discardableResult
    public mutating func extend(now: Date) -> [Event] {
        let cap = TimeInterval(Self.maxMinutes * 60)
        switch phase {
        case .running(let e):
            if now >= e { return [] }
            let left = e.timeIntervalSince(now)
            guard left < cap else { return [] }
            phase = .running(endsAt: now.addingTimeInterval(min(cap, left + Self.extensionSeconds)))
            return [.extended]
        case .paused(let r):
            guard r < cap else { return [] }
            phase = .paused(remaining: min(cap, r + Self.extensionSeconds))
            return [.extended]
        case .idle, .done:
            return []
        }
    }

    /// Stop early (decision F7): back to idle, and the time already focused counts.
    @discardableResult
    public mutating func stopEarly(now: Date) -> [Event] {
        guard isActive else { return [] }
        let f = focused(at: now)
        phase = .idle
        runningSince = nil; startedAt = nil; accrued = 0
        return [.ended(.stoppedEarly, focusedSeconds: f)]
    }

    /// Time is up: the Done state. Nothing starts on its own afterwards (decision F6).
    @discardableResult
    public mutating func tick(now: Date) -> [Event] {
        guard case .running(let e) = phase, now >= e else { return [] }
        let f = accrued + max(0, e.timeIntervalSince(runningSince ?? e))
        accrued = f
        runningSince = nil
        phase = .done
        return [.ended(.finished, focusedSeconds: f)]
    }

    /// Leave the Done state without restarting ("Choose another length").
    @discardableResult
    public mutating func dismissDone() -> Bool {
        guard phase == .done else { return false }
        phase = .idle; startedAt = nil; accrued = 0
        return true
    }
}
