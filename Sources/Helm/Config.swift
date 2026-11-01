// Launch options. They come from HELM_ARGS (see run.sh) as well as argv: AppKit treats stray argv words as files to
// open, which stops SwiftUI from opening its first window, so run.sh passes options through the environment.
import Foundation
import HelmCore

enum RendererKind: String { case swiftTerm = "swiftterm", grid = "grid" }
enum CenterMode: String, CaseIterable, Identifiable {
    case agent = "Agent", editor = "Editor", herdr = "Herdr screen"
    var id: String { rawValue }
    var symbol: String { self == .agent ? "terminal" : (self == .editor ? "doc.text" : "rectangle.inset.filled.and.person.filled") }
    static func parse(_ s: String) -> CenterMode? {
        switch s { case "agent": return .agent; case "editor": return .editor; case "herdr": return .herdr; default: return nil }
    }
}

struct AppConfig {
    var session = "esim"
    var socketDir: String?
    var herdrBin: String?
    var writeSessions: String?
    var fixture = false
    /// The cell-grid view is the default until the SwiftTerm pane has been seen on a real screen (see the handoff).
    var renderer = RendererKind.grid
    var mode: CenterMode?
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
            default: break
            }
            i += 1
        }
        return c
    }

    var endpoint: HerdrEndpoint {
        HerdrEndpoint(session: session, socketDirectory: socketDir, binaryPath: herdrBin)
    }

    var writePolicy: WritePolicy { .parse(writeSessions ?? ProcessInfo.processInfo.environment["HELM_WRITE_SESSIONS"]) }
}

@MainActor
enum Runtime {
    static let config: AppConfig = {
        let env = (ProcessInfo.processInfo.environment["HELM_ARGS"] ?? "").split(separator: " ").map(String.init)
        return AppConfig.parse(["Helm"] + env + Array(CommandLine.arguments.dropFirst()))
    }()
    static let model: AppModel = AppModel(config: config)
}
