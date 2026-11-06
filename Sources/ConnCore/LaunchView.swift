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

/// What a launch starts with.
public struct LaunchPlan: Equatable, Sendable {
    public var mode: CenterMode
    /// True when the Herdr client starts at launch without a click on Attach.
    public var attachesClient: Bool

    public init(mode: CenterMode, attachesClient: Bool) { self.mode = mode; self.attachesClient = attachesClient }

    /// A person's own launch opens on the Herdr client view and attaches its client. An explicit `--mode` wins, and files named
    /// on the command line open in the editor. A scripted launch (a check, a capture, a fixture, a test hook) never attaches
    /// by itself, because that would put a second client on a real Herdr session: it keeps the Agent view unless a mode was
    /// asked for, and a mode asked for only shows the view.
    public static func make(requested: CenterMode?, scripted: Bool, opensFiles: Bool) -> LaunchPlan {
        if let m = requested { return LaunchPlan(mode: m, attachesClient: m == .herdr && !scripted) }
        if opensFiles { return LaunchPlan(mode: .editor, attachesClient: false) }
        if scripted { return LaunchPlan(mode: .agent, attachesClient: false) }
        return LaunchPlan(mode: .herdr, attachesClient: true)
    }
}
