// Launch options. They come from CONN_ARGS (see run.sh) as well as argv: AppKit treats stray argv words as files to
// open, which stops SwiftUI from opening its first window, so run.sh passes options through the environment.
import Foundation
import ConnCore

enum RendererKind: String { case swiftTerm = "swiftterm", grid = "grid" }

struct AppConfig {
    var session = "esim"
    var socketDir: String?
    var herdrBin: String?
    var writeSessions: String?
    var fixture = false
    /// Decision B2: SwiftTerm. The captain looked at it on a real screen and it draws; `--renderer grid` selects the cell-grid view.
    var renderer = RendererKind.swiftTerm
    var mode: CenterMode?
    /// `--agent-view` / `--no-agent-view`: the Agent-view flag for this launch (nil: CONN_AGENT_VIEW, then the saved preference).
    var agentViewRequested: Bool?
    var select: Int?
    var showWeb: Bool?
    var dark = false
    var privacy = false
    var openFiles: [String] = []
    var selftest: Double?
    var quitAfter: Double?
    var shot: String?
    var shotDelay = 8.0
    var tour: String?
    var holdSeconds = 3
    var sendTest: String?
    /// Test hook: attach the Herdr client pane at launch against a stand-in Herdr. A person's own launch attaches by itself
    /// (see `LaunchPlan`); a scripted launch never does.
    var startFallback = false
    /// A Herdr client config file for the Herdr client pane (`--client-config PATH` or CONN_HERDR_CLIENT_CONFIG). Checked by
    /// `HerdrClientConfig.validate` before every attach; without it the pane writes its own hidden-sidebar config.
    var clientConfig: String?
    var probeDraw = false
    var compare = false
    var uiTour = false
    var webTab: WebKind?
    /// `--watch [2|3|4]`: open on the Watch view with that many columns (3 without a number), for screenshots and measurements.
    var watch: Int?
    /// Force the text path (`pane.read` polling) instead of the stream: for testing it against real Herdr, or if a stream misbehaves.
    var textPanes = false
    /// Test hook: open FILE in the editor, type into the text view as a user would, save, and report.
    var editorTest: String?
    /// Content size of the window in points (`--window 1100x700`), for screenshots of a small and a large window.
    var windowSize: CGSize?
    /// Open the selected pane's history view once the pane is up (for screenshots).
    var openHistory = false
    /// Test mode: the app never takes focus, shows no Dock icon or menu-bar item, and its windows are invisible and inert.
    /// Every scripted or diagnostic launch is a background launch (`--foreground` or CONN_FOREGROUND=1 opts out, for a
    /// person who wants to look at the window); a plain `./run.sh` is not.
    var background = false
    var foreground = false

    static func parse(_ a: [String]) -> AppConfig {
        var c = AppConfig()
        var i = 1
        func next() -> String? { i += 1; return i < a.count ? a[i] : nil }
        while i < a.count {
            switch a[i] {
            case "--session": if let v = next() { c.session = v }
            case "--socket-dir": c.socketDir = next()
            case "--herdr-bin": c.herdrBin = next()
            case "--write": c.writeSessions = next()
            case "--fixture": c.fixture = true
            case "--renderer": if let v = next(), let r = RendererKind(rawValue: v) { c.renderer = r }
            case "--mode": if let v = next(), let m = CenterMode.parse(v) { c.mode = m }
            case "--agent-view": c.agentViewRequested = true
            case "--no-agent-view": c.agentViewRequested = false
            case "--select": c.select = next().flatMap(Int.init)
            case "--web": c.showWeb = (next() ?? "on") != "off"
            case "--dark": c.dark = true
            case "--privacy": c.privacy = true
            case "--open": if let v = next() { c.openFiles.append(v) }
            case "--selftest": c.selftest = next().flatMap(Double.init) ?? 10
            case "--quit-after": c.quitAfter = next().flatMap(Double.init)
            case "--shot": c.shot = next()
            case "--shot-delay": c.shotDelay = next().flatMap(Double.init) ?? 8
            case "--tour": c.tour = next()
            case "--hold": c.holdSeconds = next().flatMap(Int.init) ?? 3
            case "--send-test": c.sendTest = next()
            case "--start-fallback": c.startFallback = true
            case "--client-config": c.clientConfig = next()
            case "--probe-draw": c.probeDraw = true
            case "--compare": c.compare = true
            case "--ui-check": c.uiTour = true
            case "--watch":
                // The number is optional: a following option is not swallowed.
                if i + 1 < a.count, let n = Int(a[i + 1]) { c.watch = WatchLayout.clamped(n); i += 1 } else { c.watch = WatchLayout.defaultCount }
            case "--web-tab": c.webTab = (next() ?? "") == "organizer" ? .organizer : .reader
            case "--text-panes": c.textPanes = true
            case "--editor-test": c.editorTest = next()
            case "--window":
                let parts = (next() ?? "").split(separator: "x").compactMap { Double($0) }
                if parts.count == 2, parts[0] >= 400, parts[1] >= 300 { c.windowSize = CGSize(width: parts[0], height: parts[1]) }
            case "--history": c.openHistory = true
            case "--background": c.background = true
            case "--foreground": c.foreground = true
            default: break
            }
            i += 1
        }
        return c
    }

    /// True for an explicit `--background` / CONN_BACKGROUND=1, and for every launch that runs a self-test, a check, a
    /// capture or any other scripted hook, unless it asks to be `--foreground` (or CONN_FOREGROUND=1).
    var runsInBackground: Bool {
        let env = ProcessInfo.processInfo.environment
        if foreground || env["CONN_FOREGROUND"] == "1" { return false }
        if background || env["CONN_BACKGROUND"] == "1" { return true }
        return hasScriptedHook
    }

    private var hasScriptedHook: Bool {
        uiTour || selftest != nil || shot != nil || tour != nil || probeDraw || editorTest != nil || sendTest != nil || startFallback || quitAfter != nil
    }

    /// A launch driven by a script or a test rather than a person: any scripted hook, a background launch (whether or not it
    /// opted back into `--foreground`), the fixture, or an option that only makes sense on the Agent view (`--select`,
    /// `--compare`, `--history`). It never attaches the Herdr client by itself.
    var isScriptedLaunch: Bool {
        background || ProcessInfo.processInfo.environment["CONN_BACKGROUND"] == "1" || hasScriptedHook || fixture || select != nil || compare || openHistory || watch != nil
    }

    /// Whether the Agent view exists in this launch (see `ViewPolicy`). Off by default. A test launch reads the preference from its
    /// own test domain, so a person's saved setting never changes what a check sees.
    var agentViewEnabled: Bool {
        let saved = (runsInBackground ? UserDefaults(suiteName: "dev.local.conn.test") ?? .standard : .standard).object(forKey: ViewPolicy.defaultsKey) as? Bool
        return ViewPolicy.agentViewFlag(launch: agentViewRequested, environment: ProcessInfo.processInfo.environment["CONN_AGENT_VIEW"], saved: saved)
    }

    var launchPlan: LaunchPlan { LaunchPlan.make(requested: mode, scripted: isScriptedLaunch, opensFiles: !openFiles.isEmpty, agentViewEnabled: agentViewEnabled) }

    var endpoint: HerdrEndpoint {
        HerdrEndpoint(session: session, socketDirectory: socketDir, binaryPath: herdrBin)
    }

    var clientConfigPath: String? {
        clientConfig ?? ProcessInfo.processInfo.environment["CONN_HERDR_CLIENT_CONFIG"].flatMap { $0.isEmpty ? nil : $0 }
    }

    var writePolicy: WritePolicy { .parse(writeSessions ?? ProcessInfo.processInfo.environment["CONN_WRITE_SESSIONS"]) }
}

@MainActor
enum Runtime {
    static let config: AppConfig = {
        ConnMigration.migrateIfNeeded()
        let env = (ProcessInfo.processInfo.environment["CONN_ARGS"] ?? "").split(separator: " ").map(String.init)
        return AppConfig.parse(["Conn"] + env + Array(CommandLine.arguments.dropFirst()))
    }()
    static let model: AppModel = AppModel(config: config)
}
