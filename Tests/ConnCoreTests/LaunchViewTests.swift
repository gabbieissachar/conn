import Testing
import Foundation
import ConnCore

/// The order of the centre views and what a launch opens on.
@Suite("Launch view") struct LaunchViewTests {
    @Test func theViewsAreHerdrClientThenAgentThenEditor() {
        // The switcher and the Layout menu list `allCases` in order, and the menu gives item i the key i + 1 (Opt+Cmd+1/2/3).
        #expect(CenterMode.allCases == [.herdr, .agent, .editor])
        #expect(CenterMode.allCases.map(\.rawValue) == ["Herdr client", "Agent", "Editor"])
        #expect(CenterMode.allCases.map(\.symbol) == ["rectangle.inset.filled.and.person.filled", "terminal", "doc.text"])
    }

    @Test func modeArgumentsParse() {
        #expect(CenterMode.parse("herdr") == .herdr)
        #expect(CenterMode.parse("agent") == .agent)
        #expect(CenterMode.parse("editor") == .editor)
        #expect(CenterMode.parse("Herdr client") == nil)
        #expect(CenterMode.parse("") == nil)
    }

    @Test func aPersonsOwnLaunchOpensOnTheHerdrClientAndAttachesIt() {
        #expect(LaunchPlan.make(requested: nil, scripted: false, opensFiles: false) == LaunchPlan(mode: .herdr, attachesClient: true))
    }

    @Test func aScriptedLaunchStaysOnTheAgentViewAndNeverAttaches() {
        #expect(LaunchPlan.make(requested: nil, scripted: true, opensFiles: false) == LaunchPlan(mode: .agent, attachesClient: false))
    }

    @Test func aModeThatWasAskedForWins() {
        #expect(LaunchPlan.make(requested: .agent, scripted: false, opensFiles: false) == LaunchPlan(mode: .agent, attachesClient: false))
        #expect(LaunchPlan.make(requested: .editor, scripted: false, opensFiles: false) == LaunchPlan(mode: .editor, attachesClient: false))
        #expect(LaunchPlan.make(requested: .herdr, scripted: false, opensFiles: false) == LaunchPlan(mode: .herdr, attachesClient: true))
        // A scripted launch may ask for the view (a screenshot of it) but is never the one that attaches a client by itself.
        #expect(LaunchPlan.make(requested: .herdr, scripted: true, opensFiles: false) == LaunchPlan(mode: .herdr, attachesClient: false))
        #expect(LaunchPlan.make(requested: .agent, scripted: true, opensFiles: true) == LaunchPlan(mode: .agent, attachesClient: false))
    }

    @Test func filesNamedOnTheCommandLineOpenInTheEditorWithoutAttaching() {
        #expect(LaunchPlan.make(requested: nil, scripted: false, opensFiles: true) == LaunchPlan(mode: .editor, attachesClient: false))
        #expect(LaunchPlan.make(requested: nil, scripted: true, opensFiles: true) == LaunchPlan(mode: .editor, attachesClient: false))
    }

    @Test func noScriptedLaunchEverAttaches() {
        for requested in [nil] + CenterMode.allCases.map({ Optional($0) }) {
            for opens in [false, true] {
                #expect(!LaunchPlan.make(requested: requested, scripted: true, opensFiles: opens).attachesClient)
            }
        }
    }
}
