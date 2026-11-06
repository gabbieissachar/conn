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
        #expect(LaunchPlan.make(requested: nil, scripted: false, opensFiles: false, agentViewEnabled: true) == LaunchPlan(mode: .herdr, attachesClient: true))
    }

    @Test func withTheAgentViewOnAScriptedLaunchStaysOnItAndNeverAttaches() {
        #expect(LaunchPlan.make(requested: nil, scripted: true, opensFiles: false, agentViewEnabled: true) == LaunchPlan(mode: .agent, attachesClient: false))
    }

    @Test func aModeThatWasAskedForWins() {
        #expect(LaunchPlan.make(requested: .agent, scripted: false, opensFiles: false, agentViewEnabled: true) == LaunchPlan(mode: .agent, attachesClient: false))
        #expect(LaunchPlan.make(requested: .editor, scripted: false, opensFiles: false, agentViewEnabled: true) == LaunchPlan(mode: .editor, attachesClient: false))
        #expect(LaunchPlan.make(requested: .herdr, scripted: false, opensFiles: false, agentViewEnabled: true) == LaunchPlan(mode: .herdr, attachesClient: true))
        // A scripted launch may ask for the view (a screenshot of it) but is never the one that attaches a client by itself.
        #expect(LaunchPlan.make(requested: .herdr, scripted: true, opensFiles: false, agentViewEnabled: true) == LaunchPlan(mode: .herdr, attachesClient: false))
        #expect(LaunchPlan.make(requested: .agent, scripted: true, opensFiles: true, agentViewEnabled: true) == LaunchPlan(mode: .agent, attachesClient: false))
    }

    @Test func filesNamedOnTheCommandLineOpenInTheEditorWithoutAttaching() {
        #expect(LaunchPlan.make(requested: nil, scripted: false, opensFiles: true, agentViewEnabled: true) == LaunchPlan(mode: .editor, attachesClient: false))
        #expect(LaunchPlan.make(requested: nil, scripted: true, opensFiles: true, agentViewEnabled: true) == LaunchPlan(mode: .editor, attachesClient: false))
    }

    @Test func noScriptedLaunchEverAttaches() {
        for requested in [nil] + CenterMode.allCases.map({ Optional($0) }) {
            for opens in [false, true] {
                #expect(!LaunchPlan.make(requested: requested, scripted: true, opensFiles: opens, agentViewEnabled: true).attachesClient)
            }
        }
    }

    // MARK: the Agent view is off unless the flag turns it on

    @Test func withTheAgentViewOffALaunchNeverOpensOnIt() {
        for requested in [nil] + CenterMode.allCases.map({ Optional($0) }) {
            for scripted in [false, true] {
                for opens in [false, true] {
                    let plan = LaunchPlan.make(requested: requested, scripted: scripted, opensFiles: opens, agentViewEnabled: false)
                    #expect(plan.mode != .agent)
                    #expect(plan.attachesClient == (plan.mode == .herdr && !scripted))
                }
            }
        }
        #expect(LaunchPlan.make(requested: nil, scripted: true, opensFiles: false, agentViewEnabled: false) == LaunchPlan(mode: .herdr, attachesClient: false))
        #expect(LaunchPlan.make(requested: .agent, scripted: false, opensFiles: false, agentViewEnabled: false) == LaunchPlan(mode: .herdr, attachesClient: true))
        #expect(LaunchPlan.make(requested: .editor, scripted: false, opensFiles: false, agentViewEnabled: false) == LaunchPlan(mode: .editor, attachesClient: false))
        #expect(LaunchPlan.make(requested: nil, scripted: false, opensFiles: true, agentViewEnabled: false) == LaunchPlan(mode: .editor, attachesClient: false))
    }

    @Test func theViewsAPersonCanReachFollowTheFlag() {
        #expect(ViewPolicy(agentViewEnabled: true).modes == [.herdr, .agent, .editor])
        #expect(ViewPolicy(agentViewEnabled: false).modes == [.herdr, .editor])
        for m in CenterMode.allCases {
            #expect(ViewPolicy(agentViewEnabled: true).resolve(m) == m)
            #expect(ViewPolicy(agentViewEnabled: false).resolve(m) == (m == .agent ? .herdr : m))
        }
    }

    @Test func theFlagComesFromTheLaunchThenTheEnvironmentThenTheSavedPreferenceAndIsOffOtherwise() {
        #expect(ViewPolicy.agentViewFlag(launch: nil, environment: nil, saved: nil) == false)
        #expect(ViewPolicy.agentViewFlag(launch: nil, environment: nil, saved: true) == true)
        #expect(ViewPolicy.agentViewFlag(launch: nil, environment: "1", saved: false) == true)
        #expect(ViewPolicy.agentViewFlag(launch: nil, environment: "on", saved: nil) == true)
        #expect(ViewPolicy.agentViewFlag(launch: nil, environment: "0", saved: true) == false)
        #expect(ViewPolicy.agentViewFlag(launch: nil, environment: "", saved: true) == true)
        #expect(ViewPolicy.agentViewFlag(launch: nil, environment: "maybe", saved: nil) == false)
        #expect(ViewPolicy.agentViewFlag(launch: true, environment: "0", saved: false) == true)
        #expect(ViewPolicy.agentViewFlag(launch: false, environment: "1", saved: true) == false)
    }

    // MARK: where a session jump lands

    @Test func quickSwitcherAlwaysShowsTheSessionInTheHerdrClientView() {
        for enabled in [false, true] {
            let p = ViewPolicy(agentViewEnabled: enabled)
            #expect(p.action(for: .quickSwitcher, clientRunning: false) == .showHerdrClientView)
            #expect(p.action(for: .quickSwitcher, clientRunning: true) == .moveHerdrClient)
        }
    }

    @Test func otherJumpsGoToTheAgentViewOnlyWhenItIsOn() {
        #expect(ViewPolicy(agentViewEnabled: true).action(for: .other, clientRunning: false) == .showInAgentView)
        #expect(ViewPolicy(agentViewEnabled: true).action(for: .other, clientRunning: true) == .showInAgentView)
        #expect(ViewPolicy(agentViewEnabled: false).action(for: .other, clientRunning: false) == .showHerdrClientView)
        #expect(ViewPolicy(agentViewEnabled: false).action(for: .other, clientRunning: true) == .moveHerdrClient)
    }

    @Test func noJumpWithTheAgentViewOffEverLandsThere() {
        let p = ViewPolicy(agentViewEnabled: false)
        for jump in [ViewPolicy.Jump.quickSwitcher, .other] {
            for running in [false, true] { #expect(p.action(for: jump, clientRunning: running) != .showInAgentView) }
        }
    }
}
