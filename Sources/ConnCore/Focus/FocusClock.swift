// The clock the focus session and the eye clock are driven by. Everything that decides "has the time come" takes a `Date` from a
// `FocusClock`, so a unit test or `--ui-check` moves time by hand (`ManualFocusClock`) and never waits, and the real app uses the
// system clock. A countdown is always a deadline `Date`, never a tick counter: a sleeping Mac or App Nap cannot make it drift.
import Foundation

public protocol FocusClock: AnyObject {
    var now: Date { get }
}

public final class SystemFocusClock: FocusClock {
    public init() {}
    public var now: Date { Date() }
}

/// A clock that only moves when told to (tests, `--ui-check`).
public final class ManualFocusClock: FocusClock {
    public private(set) var now: Date
    public init(_ start: Date = Date(timeIntervalSince1970: 1_800_000_000)) { now = start }
    public func advance(by seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
    public func set(_ date: Date) { now = date }
}
