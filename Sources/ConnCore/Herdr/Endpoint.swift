// Where a Herdr session lives, and the one access policy that decides whether the app may write to it.
import Foundation

public struct HerdrEndpoint: Equatable, Sendable {
    public var session: String
    /// Directory that holds `<session>/herdr.sock`. Herdr 0.9.5 keeps it at `~/.config/herdr/sessions`.
    public var socketDirectory: String
    /// The `herdr` executable used for the pane stream and `status`. Nil if none was found.
    public var binaryPath: String?

    public init(session: String, socketDirectory: String? = nil, binaryPath: String? = nil) {
        self.session = session
        self.socketDirectory = socketDirectory ?? HerdrEndpoint.defaultSocketDirectory
        self.binaryPath = binaryPath ?? HerdrEndpoint.findBinary()
    }

    public static var defaultSocketDirectory: String {
        if let d = ProcessInfo.processInfo.environment["CONN_HERDR_SOCKET_DIR"], !d.isEmpty { return d }
        return NSHomeDirectory() + "/.config/herdr/sessions"
    }

    public var socketPath: String { "\(socketDirectory)/\(session)/herdr.sock" }
    /// Stream socket of the stand-in Herdr (the real one has no such file; its stream is the CLI's private protocol).
    public var fakeStreamSocketPath: String { "\(socketDirectory)/\(session)/stream.sock" }

    public static func findBinary() -> String? {
        let env = ProcessInfo.processInfo.environment
        var candidates: [String] = []
        if let b = env["CONN_HERDR_BIN"], !b.isEmpty { candidates.append(b) }
        if let b = env["HERDR_BIN"], !b.isEmpty { candidates.append(b) }
        candidates += [NSHomeDirectory() + "/.local/bin/herdr", "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// The executables a real Herdr install puts on this machine.
    public static var realBinaryPaths: [String] { [NSHomeDirectory() + "/.local/bin/herdr", "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"] }

    /// True only when BOTH the socket directory and the `herdr` executable are outside a real Herdr install, so nothing
    /// this endpoint does can reach a real session (an attach goes wherever the executable sends it, not where the socket
    /// directory points).
    /// True if a session called `session` is answering in a real Herdr's socket directory. A wrapper script around the real
    /// `herdr` executable passes the path checks below, but it still attaches to that session, so this one does not look at paths.
    public static func realSessionAnswers(_ session: String, realSocketDirectory: String = NSHomeDirectory() + "/.config/herdr/sessions") -> Bool {
        guard validSession(session), let probe = UnixLineSocket(path: "\(realSocketDirectory)/\(session)/herdr.sock") else { return false }
        probe.close()
        return true
    }

    public var isStandIn: Bool {
        if Self.realSessionAnswers(session) { return false }
        let real = (NSHomeDirectory() + "/.config/herdr") as NSString
        let dir = (socketDirectory as NSString).standardizingPath
        if dir == real.standardizingPath || dir.hasPrefix(real.standardizingPath + "/") { return false }
        guard let bin = binaryPath, !bin.isEmpty else { return false }
        let resolved = URL(fileURLWithPath: bin).resolvingSymlinksInPath().path
        let real2 = Self.realBinaryPaths.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
        return !real2.contains(resolved) && !Self.realBinaryPaths.contains(bin)
    }

    public static func validPaneID(_ s: String) -> Bool {
        s.range(of: "^[A-Za-z0-9:_.-]{1,64}$", options: .regularExpression) != nil
    }

    public static func validSession(_ s: String) -> Bool {
        s.range(of: "^[A-Za-z0-9_.-]{1,64}$", options: .regularExpression) != nil
    }
}

/// Which sessions the app may write to. The default is none: every pane is observe-only until the captain says otherwise.
/// A write is anything that changes what a pane receives (text, keys) - the compose box is the only user of it.
public struct WritePolicy: Equatable, Sendable {
    public var writableSessions: Set<String>

    public static let observeOnly = WritePolicy(writableSessions: [])

    public init(writableSessions: Set<String> = []) { self.writableSessions = writableSessions }

    public func allowsWrites(to session: String) -> Bool { writableSessions.contains(session) }

    /// `CONN_WRITE_SESSIONS=a,b` or `--write a`.
    public static func parse(_ csv: String?) -> WritePolicy {
        WritePolicy(writableSessions: Set((csv ?? "").split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }))
    }
}
