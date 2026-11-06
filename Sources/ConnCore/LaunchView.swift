// Which centre view Conn opens on, and whether the Herdr client attaches by itself. Pure rules, so unit tests cover them
// without starting the app: the app only supplies the facts (what was asked for, whether the launch is scripted).
import Foundation

/// The centre views, in the order of the view switcher, the Layout menu and Opt+Cmd+1/2/3.
public enum CenterMode: String, CaseIterable, Identifiable, Sendable {
    case herdr = "Herdr client", agent = "Agent", editor = "Editor"
    public var id: String { rawValue }
    public var symbol: String {
        switch self {
        case .herdr: return "rectangle.inset.filled.and.person.filled"
        case .agent: return "terminal"
        case .editor: return "doc.text"
        }
    }
    /// The `--mode` argument values.
    public static func parse(_ s: String) -> CenterMode? {
        switch s { case "herdr": return .herdr; case "agent": return .agent; case "editor": return .editor; default: return nil }
    }
}

/// Whether the Agent view exists. It is kept in code (the history view, compare, the guarded compose box, per-pane zoom, and the
/// planned home of native agent-pane work) but is off by default: the Herdr client view is the one a person works in. One flag
/// turns it on; with it off nothing reaches the Agent view, so nothing can land on an empty one.
public struct ViewPolicy: Equatable, Sendable {
    public var agentViewEnabled: Bool
    /// The UserDefaults key of the saved preference (`defaults write dev.local.conn conn.agentView -bool YES`).
    public static let defaultsKey = "conn.agentView"
    public init(agentViewEnabled: Bool) { self.agentViewEnabled = agentViewEnabled }

    /// The views a person can reach, in switcher order.
    public var modes: [CenterMode] { CenterMode.allCases.filter { $0 != .agent || agentViewEnabled } }

    /// A view as asked for, or the Herdr client when the Agent view is off. Every way of setting the view goes through this.
    public func resolve(_ mode: CenterMode) -> CenterMode { mode == .agent && !agentViewEnabled ? .herdr : mode }

    /// Where a person asked to jump to a session from.
    public enum Jump: Equatable, Sendable {
        /// Cmd+K: always shows the session in the Herdr client view.
        case quickSwitcher
        /// Cmd+1..9, Cmd+J, Cmd+[ and Cmd+], the sidebar when no client is attached, the menu-bar list: the Agent view when it
        /// is on (as before), otherwise the Herdr client view.
        case other
    }

    /// What a session jump does.
    public enum Action: Equatable, Sendable {
        /// Select the session and switch to the Agent view.
        case showInAgentView
        /// Switch to the Herdr client view and move the running embedded client to the session.
        case moveHerdrClient
        /// Switch to the Herdr client view and select the session in the sidebar; no client is attached, and a jump never
        /// attaches one (the view shows its Attach button or the failed-attach notice).
        case showHerdrClientView
    }

    public func action(for jump: Jump, clientRunning: Bool) -> Action {
        if jump == .other && agentViewEnabled { return .showInAgentView }
        return clientRunning ? .moveHerdrClient : .showHerdrClientView
    }

    /// The Agent-view flag for a launch. First that is set wins: the launch (`--agent-view`, `--no-agent-view`), the environment
    /// (`CONN_AGENT_VIEW`, 1/true/yes/on or 0/false/no/off), the saved preference (`conn.agentView`); otherwise off.
    public static func agentViewFlag(launch: Bool?, environment: String?, saved: Bool?) -> Bool {
        if let l = launch { return l }
        switch environment?.lowercased() {
        case "1", "true", "yes", "on": return true
        case "0", "false", "no", "off": return false
        default: break
        }
        return saved ?? false
    }
}

/// What a launch starts with.
public struct LaunchPlan: Equatable, Sendable {
    public var mode: CenterMode
    /// True when the Herdr client starts at launch without a click on Attach.
    public var attachesClient: Bool

    public init(mode: CenterMode, attachesClient: Bool) { self.mode = mode; self.attachesClient = attachesClient }

    /// A person's own launch opens on the Herdr client view and attaches its client. An explicit `--mode` wins, and files named
    /// on the command line open in the editor. A scripted launch (a check, a capture, a fixture, a test hook) never attaches
    /// by itself, because that would put a second client on a real Herdr session: it keeps the Agent view unless a mode was
    /// asked for, and a mode asked for only shows the view. With the Agent view off, anything that would open on it opens on
    /// the Herdr client view instead.
    public static func make(requested: CenterMode?, scripted: Bool, opensFiles: Bool, agentViewEnabled: Bool) -> LaunchPlan {
        let policy = ViewPolicy(agentViewEnabled: agentViewEnabled)
        let mode: CenterMode
        if let m = requested { mode = policy.resolve(m) }
        else if opensFiles { mode = .editor }
        else if scripted { mode = policy.resolve(.agent) }
        else { mode = .herdr }
        return LaunchPlan(mode: mode, attachesClient: mode == .herdr && !scripted)
    }
}
