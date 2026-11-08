// The daily total (decision F13): time focused, eye breaks taken and eye breaks skipped, for today on this Mac only (decision F18: a Mac-only feature,
// nothing is shared across devices). Three numbers in Conn's own settings under one key, reset when the local date changes. Nothing else is kept: no
// session history, no times of day, no day other than today.
import Foundation

public struct FocusDayTotal: Equatable, Sendable {
    /// The local date the numbers belong to, `yyyy-MM-dd`.
    public var day: String
    public var focusedSeconds: Int
    public var breaksTaken: Int
    public var breaksSkipped: Int

    public init(day: String, focusedSeconds: Int = 0, breaksTaken: Int = 0, breaksSkipped: Int = 0) {
        self.day = day; self.focusedSeconds = max(0, focusedSeconds); self.breaksTaken = max(0, breaksTaken); self.breaksSkipped = max(0, breaksSkipped)
    }

    public static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// "1 h 25 min", "25 min", "under a minute", "0 min".
    public static func durationText(seconds: Int) -> String {
        let s = max(0, seconds)
        if s == 0 { return "0 min" }
        let m = s / 60
        if m == 0 { return "under a minute" }
        return m >= 60 ? (m % 60 == 0 ? "\(m / 60) h" : "\(m / 60) h \(m % 60) min") : "\(m) min"
    }
}

/// Reads and writes the day's numbers in a `UserDefaults` domain (the app's own, or the test domain in test mode).
@MainActor
public final class FocusTotalsStore {
    public nonisolated static let defaultKey = "conn.focus.total"
    private let defaults: UserDefaults
    private let key: String
    private let calendar: Calendar

    public init(defaults: UserDefaults, key: String = FocusTotalsStore.defaultKey, calendar: Calendar = .current) {
        self.defaults = defaults; self.key = key; self.calendar = calendar
    }

    /// Today's numbers: what is stored when it is from today, zeros when it is from another day or unreadable.
    public func today(at now: Date) -> FocusDayTotal {
        let day = FocusDayTotal.dayKey(now, calendar: calendar)
        guard let d = defaults.dictionary(forKey: key), d["day"] as? String == day else { return FocusDayTotal(day: day) }
        return FocusDayTotal(day: day, focusedSeconds: d["focused"] as? Int ?? 0, breaksTaken: d["taken"] as? Int ?? 0, breaksSkipped: d["skipped"] as? Int ?? 0)
    }

    @discardableResult
    public func addFocused(_ seconds: TimeInterval, at now: Date) -> FocusDayTotal {
        var t = today(at: now)
        t.focusedSeconds += max(0, Int(seconds.rounded()))
        save(t); return t
    }

    @discardableResult
    public func addBreak(taken: Bool, at now: Date) -> FocusDayTotal {
        var t = today(at: now)
        if taken { t.breaksTaken += 1 } else { t.breaksSkipped += 1 }
        save(t); return t
    }

    public func reset() { defaults.removeObject(forKey: key) }

    private func save(_ t: FocusDayTotal) {
        defaults.set(["day": t.day, "focused": t.focusedSeconds, "taken": t.breaksTaken, "skipped": t.breaksSkipped] as [String: Any], forKey: key)
    }
}

/// The few preferences the feature remembers across launches. A session itself is never remembered: it ends with the app (Conn Focus goes off on quit).
@MainActor
public final class FocusPrefs {
    public static let eyeKey = "conn.focus.eye"
    public static let minutesKey = "conn.focus.minutes"
    /// True from just before "Conn Focus On" runs until "Conn Focus Off" has succeeded: a launch that finds it set switches the Focus off (a crash or a
    /// kill leaves the Focus on, and nothing else would turn it off).
    public static let mayBeOnKey = "conn.focus.mayBeOn"
    private let defaults: UserDefaults
    public init(defaults: UserDefaults) { self.defaults = defaults }

    public var eyeEnabled: Bool {
        get { defaults.object(forKey: Self.eyeKey) as? Bool ?? false }
        set { defaults.set(newValue, forKey: Self.eyeKey) }
    }
    public var minutes: Int {
        get { FocusSession.clamped(defaults.object(forKey: Self.minutesKey) as? Int ?? FocusSession.defaultMinutes) }
        set { defaults.set(FocusSession.clamped(newValue), forKey: Self.minutesKey) }
    }
    public var focusMayBeOn: Bool {
        get { defaults.bool(forKey: Self.mayBeOnKey) }
        set { defaults.set(newValue, forKey: Self.mayBeOnKey) }
    }
}
