// What Conn's one menu-bar item says and what the focus line at the top of its menu says. Pure: the views draw these values, and the unit tests check them
// without a menu bar. The menu-bar item is the logo, then (only when something waits on the person) the waiting count, then (only while a focus session exists)
// the session: a small glyph and the time left. The same glyph and wording are used on the toolbar pill, so the two read alike.
import Foundation

public struct MenuBarStatus: Equatable, Sendable {
    /// What the item shows for the focus session; `none` when no session runs, is paused or waits in Done.
    public enum Focus: Equatable, Sendable { case none, running, paused, done }

    public let waiting: Int
    public let focus: Focus
    /// Red: Conn Focus did not switch on, or may still be on after the session. It shows with no session too (Focus left on silences banners), as the popover's red box does.
    public let warning: Bool
    /// The time left (`24:13`), frozen while paused; "Done" at the end; nil with no session.
    public let timeText: String?
    /// The number of things waiting, nil for none.
    public let countText: String?

    public init(waiting: Int, focus: Focus, warning: Bool, timeText: String?) {
        self.waiting = max(0, waiting)
        self.focus = focus
        self.warning = warning
        self.timeText = timeText
        self.countText = waiting > 0 ? "\(waiting)" : nil
    }

    public static func make(waiting: Int, session: FocusSession, link: FocusLink, now: Date) -> MenuBarStatus {
        let focus: Focus = session.isRunning ? .running : (session.isPaused ? .paused : (session.isDone ? .done : .none))
        let time: String? = focus == .none ? nil : (focus == .done ? "Done" : FocusTimeFormat.clock(session.remaining(at: now)))
        return MenuBarStatus(waiting: waiting, focus: focus, warning: link.isRed, timeText: time)
    }

    /// The name of the SF Symbol drawn before the time, nil when the time stands alone. A running countdown needs none (`24:13` beside the logo reads as a timer, and the
    /// menu bar's room is short: items that do not fit end up under the notch), while the states that are not a plain countdown carry one; a warning replaces them, as it does
    /// on the toolbar pill.
    public var focusSymbol: String? {
        if warning { return "exclamationmark.triangle.fill" }
        switch focus {
        case .running: return nil
        case .paused: return "pause.fill"
        case .done: return "checkmark"
        case .none: return nil
        }
    }

    /// What VoiceOver and the item's tooltip say: the app first, then what waits, then the session.
    public var accessibilityText: String {
        var parts = ["Conn"]
        parts.append(waiting == 0 ? "nothing is waiting on you" : (waiting == 1 ? "1 session is waiting on you" : "\(waiting) sessions are waiting on you"))
        switch focus {
        case .none: break
        case .running: parts.append("focus session, \(timeText ?? "") left")
        case .paused: parts.append("focus session paused, \(timeText ?? "") left")
        case .done: parts.append("focus session done")
        }
        if warning { parts.append("Conn Focus is not on, other apps' banners are not silenced") }
        return parts.joined(separator: ", ")
    }
}

/// The focus line at the top of the menu: a title, a second line, an optional red sentence, and the buttons that make sense in this state.
public struct MenuFocusLine: Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case pause, resume, extend, restart
        /// Run the Focus shortcut again (the red state's "Try again").
        case retry
        /// Open Conn's own focus popover: where a length is chosen, a session is stopped early, and the eye breaks and setup live.
        case openControls
    }

    public let title: String
    public let detail: String
    /// The red headline (what went wrong), nil when all is well.
    public let warning: String?
    public let actions: [Action]

    public static func make(session: FocusSession, link: FocusLink, now: Date, timeZone: TimeZone = .current, locale: Locale = .current) -> MenuFocusLine {
        let length = "\(session.lengthMinutes) min"
        let warning: String? = {
            switch link {
            case .didNotSwitchOn: return "Conn Focus did not switch on"
            case .couldNotSwitchOff: return "Conn Focus may still be on"
            default: return nil
            }
        }()
        let retry: [Action] = warning == nil ? [] : [.retry]
        switch session.phase {
        case .idle:
            return MenuFocusLine(title: "Focus session", detail: "Not running", warning: warning, actions: retry + [.openControls])
        case .running(let end):
            return MenuFocusLine(title: "Focus \(FocusTimeFormat.clock(session.remaining(at: now))) left",
                                 detail: "\(length) · ends \(FocusTimeFormat.endTime(end, locale: locale, timeZone: timeZone))",
                                 warning: warning, actions: retry + [.pause, .extend, .openControls])
        case .paused:
            return MenuFocusLine(title: "Paused, \(FocusTimeFormat.clock(session.remaining(at: now))) left", detail: length,
                                 warning: warning, actions: retry + [.resume, .extend, .openControls])
        case .done:
            let focused = Int((session.focused(at: now) / 60).rounded())
            return MenuFocusLine(title: "Focus session done", detail: "\(focused) min focused", warning: warning, actions: retry + [.restart, .openControls])
        }
    }
}
