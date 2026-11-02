// Who owns a key press: the app or the pane (buzz lesson 3, decided before panes take input).
//
// The rule, in four lines:
//   1. An app shortcut always carries Command. Shift and Option may join it (Opt+Cmd+1/2/3 switch the centre view);
//      a chord without Command is never the app's.
//   2. Control and Option (Alt) chords without Command always reach the focused pane: they are how terminal programs
//      are driven (Ctrl-C, Ctrl-R, Alt-B, Esc prefixes), and no terminal sends Command chords, so the two never clash.
//   3. One chord, Cmd+L, moves keyboard focus between the compose box and the pane. It acts on the key press and is
//      ignored while an input method is composing (marked text), when the keys belong to the input method.
//   4. Everything else without Command (plain keys, Shift-only, Ctrl, Alt) belongs to whatever has focus.
// Today panes are observe-only and take no keys; this type is what the key view asks the day they do, and the Agents menu
// is audited against it (`--ui-check`).
import Foundation

public struct KeyModifiers: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let command = KeyModifiers(rawValue: 1)
    public static let control = KeyModifiers(rawValue: 2)
    public static let option = KeyModifiers(rawValue: 4)
    public static let shift = KeyModifiers(rawValue: 8)
}

public struct KeyChord: Equatable, Sendable {
    public var key: String
    public var modifiers: KeyModifiers
    public init(_ key: String, _ modifiers: KeyModifiers = []) { self.key = key.lowercased(); self.modifiers = modifiers }
}

public enum KeyRoute: Equatable, Sendable {
    /// A menu or app shortcut: handle it in the app.
    case app
    /// Send it to the focused pane (or whatever else has focus).
    case pane
    /// Move focus between the compose box and the pane.
    case toggleFocus
    /// The toggle chord while an input method is composing: do nothing, the input method owns the keys.
    case ignoredWhileComposing
}

public enum KeyRule {
    public static let focusToggle = KeyChord("l", [.command])

    /// Whether a chord with these modifiers can be an app shortcut at all.
    public static func isAppChord(_ modifiers: KeyModifiers) -> Bool { modifiers.contains(.command) }

    public static func route(_ chord: KeyChord, composing: Bool = false) -> KeyRoute {
        if chord == focusToggle { return composing ? .ignoredWhileComposing : .toggleFocus }
        return isAppChord(chord.modifiers) ? .app : .pane
    }
}
