// The 20-20-20 eye clock (decisions F8 to F11): every 20 minutes a 20-second break to look 20 feet away. A pure value type, like `FocusSession`: no timer,
// no clock, no idle probe of its own. It runs with or without a focus session and has its own switch.
//
//   off --enable--> counting(breakAt) --time comes--> onBreak(endsAt) --20 s--> counting (a new 20 minutes)
//   onBreak --skip--> counting (a new 20 minutes)        onBreak --snooze--> counting (2 minutes)
//   away (screen locked, display or Mac asleep, or no input for 2 minutes) and back --> counting (a new 20 minutes)   (decision F10)
//
// No break starts while the person is away. A break in progress when they leave the screen ends there and counts as taken (they did look away).
import Foundation

public struct EyeBreakConfig: Equatable, Sendable {
    public var intervalSeconds: TimeInterval = 20 * 60
    public var breakSeconds: TimeInterval = 20
    public var snoozeSeconds: TimeInterval = 2 * 60
    /// No input for this long counts as away (decision F10).
    public var awayAfterIdleSeconds: TimeInterval = 2 * 60
    public init() {}
}

/// What the machine can see of the person at one moment. The real reader is in the app (`SystemPresence`); a test script writes its own.
public struct PresenceSample: Equatable, Sendable {
    /// Seconds since the last keyboard, mouse or trackpad input.
    public var idleSeconds: TimeInterval
    public var screenLocked: Bool
    /// The display or the whole Mac is asleep.
    public var asleep: Bool
    /// The screen locked or went to sleep since the last sample, even if it is back by now (a short lock between two samples still restarts the clock).
    public var leftSinceLastSample: Bool
    public init(idleSeconds: TimeInterval = 0, screenLocked: Bool = false, asleep: Bool = false, leftSinceLastSample: Bool = false) {
        self.idleSeconds = idleSeconds; self.screenLocked = screenLocked; self.asleep = asleep; self.leftSinceLastSample = leftSinceLastSample
    }

    public func isAway(after threshold: TimeInterval) -> Bool { screenLocked || asleep || idleSeconds >= threshold }
}

public enum EyeBreakOutcome: Equatable, Sendable {
    /// The 20 seconds ran out.
    case completed
    /// The person pressed Skip.
    case skipped
    /// The screen locked or went to sleep during the break: they looked away, so it counts as taken.
    case leftTheScreen
    /// The eye timer was switched off during the break.
    case switchedOff
}

public enum EyeBreakEvent: Equatable, Sendable {
    case breakStarted
    case breakEnded(EyeBreakOutcome)
    case snoozed
    /// The person came back from being away: the 20 minutes start over.
    case clockRestarted
}

public struct EyeBreakClock: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case off
        case counting(breakAt: Date)
        case onBreak(startedAt: Date, endsAt: Date)
    }

    public var config: EyeBreakConfig
    public private(set) var phase: Phase = .off
    /// Set while the person is away (the first sample that said so).
    public private(set) var awaySince: Date?

    public init(config: EyeBreakConfig = EyeBreakConfig()) { self.config = config }

    public var isOn: Bool { phase != .off }
    public var isOnBreak: Bool { if case .onBreak = phase { return true } else { return false } }

    /// Seconds until the next break while counting; nil when off or on a break.
    public func secondsUntilBreak(at now: Date) -> TimeInterval? {
        if case .counting(let t) = phase { return max(0, t.timeIntervalSince(now)) }
        return nil
    }

    /// Seconds left of the break in progress; nil when not on a break.
    public func breakSecondsLeft(at now: Date) -> TimeInterval? {
        if case .onBreak(_, let e) = phase { return max(0, e.timeIntervalSince(now)) }
        return nil
    }

    @discardableResult
    public mutating func enable(now: Date) -> Bool {
        guard phase == .off else { return false }
        awaySince = nil
        phase = .counting(breakAt: now.addingTimeInterval(config.intervalSeconds))
        return true
    }

    @discardableResult
    public mutating func disable() -> [EyeBreakEvent] {
        let was = phase
        phase = .off; awaySince = nil
        if case .onBreak = was { return [.breakEnded(.switchedOff)] }
        return []
    }

    /// Skip the break in progress (decision F11): the next one is a full interval away.
    @discardableResult
    public mutating func skip(now: Date) -> [EyeBreakEvent] {
        guard isOnBreak else { return [] }
        phase = .counting(breakAt: now.addingTimeInterval(config.intervalSeconds))
        return [.breakEnded(.skipped)]
    }

    /// Snooze the break in progress (decision F11): it comes back in 2 minutes, and counts as neither taken nor skipped.
    @discardableResult
    public mutating func snooze(now: Date) -> [EyeBreakEvent] {
        guard isOnBreak else { return [] }
        phase = .counting(breakAt: now.addingTimeInterval(config.snoozeSeconds))
        return [.snoozed]
    }

    /// One look at the clock and at the person. Called every few seconds (every second while a break shows).
    @discardableResult
    public mutating func tick(now: Date, presence: PresenceSample) -> [EyeBreakEvent] {
        guard phase != .off else { return [] }
        var events: [EyeBreakEvent] = []
        let away = presence.isAway(after: config.awayAfterIdleSeconds)
        if away {
            if awaySince == nil { awaySince = now }
            // Leaving during a break ends it there; nothing starts while the person is away.
            if isOnBreak {
                events.append(.breakEnded(.leftTheScreen))
                phase = .counting(breakAt: now.addingTimeInterval(config.intervalSeconds))
            }
            return events
        }
        // Present. Back from being away, or away and back between two samples: the 20 minutes start over.
        if awaySince != nil || presence.leftSinceLastSample {
            awaySince = nil
            if isOnBreak { events.append(.breakEnded(.leftTheScreen)) }
            phase = .counting(breakAt: now.addingTimeInterval(config.intervalSeconds))
            events.append(.clockRestarted)
            return events
        }
        switch phase {
        case .counting(let t):
            if now >= t {
                phase = .onBreak(startedAt: now, endsAt: now.addingTimeInterval(config.breakSeconds))
                events.append(.breakStarted)
            }
        case .onBreak(_, let e):
            if now >= e {
                phase = .counting(breakAt: now.addingTimeInterval(config.intervalSeconds))
                events.append(.breakEnded(.completed))
            }
        case .off:
            break
        }
        return events
    }
}
