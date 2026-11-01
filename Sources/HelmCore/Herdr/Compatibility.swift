// Is the installed `herdr` safe to stream from? Answered by `herdr --session <s> status --json` before any stream opens.
//
// Herdr documents its JSON API as stable across builds ("endpoint protocol generation") but keeps the numbered
// client/server protocol that the pane stream rides on out of that promise ("same-install and internal operations").
// The numbered protocol went from 5 to 22 between 2026-05 and 2026-11. So the app checks, and when the stream is not
// known to work it drops to the text path (`pane.read`, JSON API only) instead of showing a broken pane.
import Foundation

public struct HerdrStatus: Equatable, Sendable {
    public var clientVersion = ""
    public var clientProtocol = 0
    public var serverRunning = false
    public var serverVersion = ""
    public var serverProtocol = 0
    public var endpointCompatible = false
    public var compatible = false
    public var restartNeeded = false
    public var serverBinaryStale = false

    public init() {}

    public init?(json: Data) {
        guard let root = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any],
              let client = root["client"] as? [String: Any], let server = root["server"] as? [String: Any] else { return nil }
        clientVersion = (client["version"] as? String) ?? ""
        clientProtocol = (client["protocol"] as? Int) ?? 0
        serverRunning = (server["running"] as? Bool) ?? false
        serverVersion = (server["version"] as? String) ?? ""
        serverProtocol = (server["protocol"] as? Int) ?? 0
        endpointCompatible = (server["endpoint_compatible"] as? Bool) ?? false
        compatible = (server["compatible"] as? Bool) ?? false
        let update = root["update"] as? [String: Any]
        restartNeeded = ((server["restart_needed"] as? Bool) ?? false) || ((update?["restart_needed"] as? Bool) ?? false)
        serverBinaryStale = ((server["server_binary_stale"] as? Bool) ?? false) || ((update?["server_binary_stale"] as? Bool) ?? false)
    }
}

public enum StreamVerdict: Equatable, Sendable {
    /// Client and server speak the protocol this decoder was verified against.
    case ok
    /// Same protocol on both sides but newer than the tested one: try the stream, check the first frame, keep the text path ready.
    case untested(String)
    /// The stream would be refused or is unreliable: use the text path.
    case textOnly(String)
    /// Nothing to talk to.
    case down(String)

    public var allowsStream: Bool {
        switch self { case .ok, .untested: return true; case .textOnly, .down: return false }
    }

    public var message: String? {
        switch self {
        case .ok: return nil
        case .untested(let m), .textOnly(let m), .down(let m): return m
        }
    }
}

public enum HerdrCompatibility {
    /// The private protocol versions the stream decoder has been checked against (Herdr 0.9.5 speaks 22).
    public static let testedProtocols: ClosedRange<Int> = 22...22

    public static func verdict(for s: HerdrStatus) -> StreamVerdict {
        guard s.serverRunning else { return .down("Herdr server is not running") }
        if s.clientProtocol != s.serverProtocol || !s.compatible {
            return .textOnly("Herdr client protocol \(s.clientProtocol) and server protocol \(s.serverProtocol) differ (client \(s.clientVersion), server \(s.serverVersion)); restart the server to stream panes")
        }
        if s.serverBinaryStale || s.restartNeeded {
            return .textOnly("Herdr was updated but its server was not restarted; panes show text until it restarts")
        }
        if !testedProtocols.contains(s.serverProtocol) {
            return .untested("Herdr protocol \(s.serverProtocol) is newer than the one this app was tested with (\(testedProtocols.upperBound))")
        }
        return .ok
    }

    /// Runs `herdr --session <s> status --json`. Nil if the executable is missing or its output is not recognisable.
    public static func probe(endpoint: HerdrEndpoint, timeout: TimeInterval = 5) -> HerdrStatus? {
        guard HerdrEndpoint.validSession(endpoint.session), let bin = endpoint.binaryPath else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = ["--session", endpoint.session, "status", "--json"]
        var env = ProcessInfo.processInfo.environment
        env["HELM_HERDR_SOCKET_DIR"] = endpoint.socketDirectory
        env.removeValue(forKey: "HERDR_SESSION")
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        var data = Data()
        let reader = DispatchGroup()
        reader.enter()
        DispatchQueue.global().async { data = out.fileHandleForReading.readDataToEndOfFile(); reader.leave() }
        if reader.wait(timeout: .now() + max(0.1, deadline.timeIntervalSinceNow)) == .timedOut { p.terminate(); return nil }
        return HerdrStatus(json: data)
    }
}
