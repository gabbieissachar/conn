// How a time left is written on the pill, in the menu bar and on the eye panel. Rounded up, so a countdown never shows 0:00 while time is left and shows 25:00 for
// the first second of a 25-minute session.
import Foundation

public enum FocusTimeFormat {
    /// `24:13`, `0:07`, and `1:05:09` from an hour up.
    public static func clock(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds.rounded(.up)))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    /// The clock time a session ends at, in the person's own style (`14:32` or `2:32 PM`).
    public static func endTime(_ date: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = locale; f.timeZone = timeZone
        f.timeStyle = .short; f.dateStyle = .none
        return f.string(from: date)
    }
}
