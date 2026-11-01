// The request side of the Herdr JSON API, with the write gate.
//
// Helm talks to Herdr in three ways:
//   1. JSON requests over the session's Unix socket (this file): `session.snapshot`, `events.subscribe`, `ping`,
//      `pane.read`, and - only when the WritePolicy allows the session - `pane.send_input`.
//   2. The pane stream, a child process running `herdr terminal session observe` (PaneStream.swift). The stream has no
//      JSON-API equivalent: it is the CLI's private binary protocol re-encoded as JSON lines.
//   3. `herdr status --json` for the compatibility check (Compatibility.swift).
// Nothing else exists: no split, close, rename, focus, resize or control-mode path.
import Foundation

public enum HerdrError: Error, Equatable, CustomStringConvertible {
    case unreachable(String)
    case writeRefused(session: String, method: String)
    case rejected(code: String, message: String)
    case malformed(String)
    case invalidArgument(String)

    public var description: String {
        switch self {
        case .unreachable(let s): return "Herdr is unreachable: \(s)"
        case .writeRefused(let session, let method): return "Writes to session \(session) are off (\(method) refused)"
        case .rejected(let code, let message): return "Herdr refused the request (\(code)): \(message)"
        case .malformed(let s): return "Unexpected reply from Herdr: \(s)"
        case .invalidArgument(let s): return "Invalid argument: \(s)"
        }
    }
}

public enum ReadSource: String, Sendable { case visible, recent }

public enum HerdrRequest: Sendable {
    case ping
    case snapshot
    case readPane(pane: String, source: ReadSource, ansi: Bool)
    /// Text typed into a pane, then keys (for example ["Enter"]). The one write.
    case sendInput(pane: String, text: String, keys: [String])

    public var method: String {
        switch self {
        case .ping: return "ping"
        case .snapshot: return "session.snapshot"
        case .readPane: return "pane.read"
        case .sendInput: return "pane.send_input"
        }
    }

    public var isWrite: Bool { if case .sendInput = self { return true } else { return false } }

    func params() throws -> [String: Any] {
        switch self {
        case .ping, .snapshot: return [:]
        case .readPane(let pane, let source, let ansi):
            guard HerdrEndpoint.validPaneID(pane) else { throw HerdrError.invalidArgument("pane id") }
            return ["pane_id": pane, "source": source.rawValue, "format": ansi ? "ansi" : "text", "strip_ansi": !ansi]
        case .sendInput(let pane, let text, let keys):
            guard HerdrEndpoint.validPaneID(pane) else { throw HerdrError.invalidArgument("pane id") }
            var p: [String: Any] = ["pane_id": pane]
            if !text.isEmpty { p["text"] = text }
            if !keys.isEmpty { p["keys"] = keys }
            return p
        }
    }
}

public final class HerdrClient: @unchecked Sendable {
    public let endpoint: HerdrEndpoint
    public let writePolicy: WritePolicy
    public var timeout: TimeInterval = 5

    public init(endpoint: HerdrEndpoint, writePolicy: WritePolicy = .observeOnly) {
        self.endpoint = endpoint
        self.writePolicy = writePolicy
    }

    /// One request, one response, on its own connection (the docs: snapshot on a connection other than the subscription).
    public func call(_ request: HerdrRequest) throws -> [String: Any] { try callCounting(request).0 }

    /// Like `call`, also returning the size of the reply line in bytes.
    public func callCounting(_ request: HerdrRequest) throws -> ([String: Any], Int) {
        if request.isWrite && !writePolicy.allowsWrites(to: endpoint.session) {
            throw HerdrError.writeRefused(session: endpoint.session, method: request.method)
        }
        guard HerdrEndpoint.validSession(endpoint.session) else { throw HerdrError.invalidArgument("session name") }
        let params = try request.params()
        guard let sock = UnixLineSocket(path: endpoint.socketPath) else {
            throw HerdrError.unreachable("no socket at \(endpoint.socketPath)")
        }
        defer { sock.close() }
        guard sock.writeLine(["id": "helm_\(request.method)", "method": request.method, "params": params]) else {
            throw HerdrError.unreachable("write failed")
        }
        guard let line = sock.readLine(timeout: timeout) else {
            throw sock.timedOut ? HerdrError.unreachable("no reply within \(Int(timeout)) s") : HerdrError.unreachable("connection closed")
        }
        guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { throw HerdrError.malformed("reply is not a JSON object") }
        if let err = obj["error"] as? [String: Any] {
            throw HerdrError.rejected(code: (err["code"] as? String) ?? "error", message: (err["message"] as? String) ?? "")
        }
        return (obj, line.count)
    }

    public func snapshot() throws -> Snapshot {
        let obj = try call(.snapshot)
        guard let snap = Snapshot(response: obj) else { throw HerdrError.malformed("no snapshot in reply") }
        return snap
    }

    /// Text of a pane as the server sees it (the text fallback when the stream is unavailable).
    public func readPane(_ pane: String, source: ReadSource = .visible, ansi: Bool = true) throws -> String {
        let obj = try call(.readPane(pane: pane, source: source, ansi: ansi))
        guard let result = obj["result"] as? [String: Any] else { throw HerdrError.malformed("no result") }
        if let read = result["read"] as? [String: Any], let text = read["text"] as? String { return text }
        if let text = result["text"] as? String { return text }
        throw HerdrError.malformed("no text in pane.read result")
    }

    public func sendInput(pane: String, text: String, keys: [String] = ["Enter"]) throws {
        _ = try call(.sendInput(pane: pane, text: text, keys: keys))
    }
}
