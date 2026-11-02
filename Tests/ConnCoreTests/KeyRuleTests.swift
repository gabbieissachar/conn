import Testing
import ConnCore

@Suite("Key ownership") struct KeyRuleTests {
    @Test func appShortcutsAlwaysCarryCommand() {
        #expect(KeyRule.route(KeyChord("k", [.command])) == .app)
        #expect(KeyRule.route(KeyChord("1", [.command])) == .app)
        #expect(KeyRule.route(KeyChord("b", [.command, .shift])) == .app)
        #expect(KeyRule.route(KeyChord("1", [.command, .option])) == .app)     // Opt+Cmd+1: centre view
        #expect(KeyRule.route(KeyChord("s", [.command, .control])) == .app)    // Cmd+Ctrl+S: sidebar
    }

    @Test func controlAndAltWithoutCommandAlwaysReachThePane() {
        for key in ["a", "c", "d", "j", "k", "l", "r", "z", "1", "[", "\\", "space", "return", "tab", "escape", "left"] {
            #expect(KeyRule.route(KeyChord(key, [.control])) == .pane, "Ctrl+\(key)")
            #expect(KeyRule.route(KeyChord(key, [.option])) == .pane, "Alt+\(key)")
            #expect(KeyRule.route(KeyChord(key, [.control, .option])) == .pane, "Ctrl+Alt+\(key)")
            #expect(KeyRule.route(KeyChord(key, [.control, .shift])) == .pane, "Ctrl+Shift+\(key)")
            #expect(KeyRule.route(KeyChord(key, [.option, .shift])) == .pane, "Alt+Shift+\(key)")
        }
    }

    @Test func plainAndShiftOnlyKeysBelongToTheFocusedView() {
        #expect(KeyRule.route(KeyChord("a")) == .pane)
        #expect(KeyRule.route(KeyChord("a", [.shift])) == .pane)
        #expect(KeyRule.route(KeyChord("escape")) == .pane)
    }

    @Test func oneChordTogglesFocusAndIsIgnoredWhileAnInputMethodComposes() {
        #expect(KeyRule.focusToggle.modifiers == [.command])                     // a toggle is an app chord too
        #expect(KeyRule.route(KeyRule.focusToggle) == .toggleFocus)
        #expect(KeyRule.route(KeyChord("L", [.command])) == .toggleFocus)         // key case does not matter
        #expect(KeyRule.route(KeyRule.focusToggle, composing: true) == .ignoredWhileComposing)
        // Composing changes only the toggle: other chords route as before, and the same letter without Command is a pane key.
        #expect(KeyRule.route(KeyChord("k", [.command]), composing: true) == .app)
        #expect(KeyRule.route(KeyChord("l", [.control]), composing: true) == .pane)
        #expect(KeyRule.route(KeyChord("l", [.command, .shift])) == .app)        // not the toggle
    }

    @Test func everyChordIsOwnedByExactlyOneSide() {
        // All 16 modifier combinations: the owner depends on Command alone, and the toggle is the only special case.
        for raw in 0..<16 {
            let m = KeyModifiers(rawValue: raw)
            let route = KeyRule.route(KeyChord("x", m))
            #expect(route == (m.contains(.command) ? .app : .pane), "modifiers \(raw)")
            #expect(KeyRule.isAppChord(m) == m.contains(.command))
        }
    }
}
