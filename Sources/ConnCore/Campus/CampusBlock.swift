// Campus behind the network. Campus answers only on the company private network (Zscaler private access): off it, `campus.shopback.com` resolves to a public
// ingress that refuses every path with an nginx `403 Forbidden` page (an HTML body, no Campus JSON). That is the network, not the person's sign-in, so Conn
// names it as its own state (`CampusLink.blocked`) instead of calling it a sign-out, says what to check, and keeps a small log of the sign-in sheet's hops so the
// next refusal explains itself.
//
// The log holds a time, a host, a path (never a query) and a status for each hop of the sign-in sheet. No cookie, no token, no query string, no page text.
import Foundation

/// The words for the blocked state, one place so the sidebar, the sign-in sheet, a refused write and the agent bridge say the same thing.
public enum CampusNetworkBlock {
    public static let title = "Campus refused the connection"
    public static let note = "This is the network, not your sign-in. Campus only answers on the company private network: check that Zscaler (private access) is connected, then try again."
    /// For a one-line refusal (a write, a bridge reply).
    public static let short = "Campus refused this connection (403 from the network, not from Campus): this is not your sign-in; check that Zscaler private access is connected"
}

/// One hop of the sign-in sheet (or one blocked answer of the API), as it is logged.
public struct CampusHop: Equatable, Codable, Sendable {
    public var at: Date
    /// `sign-in` (a page the sign-in sheet loaded) or `api` (Conn's own reads of Campus found the network refusing).
    public var source: String
    public var host: String
    /// The path only, never a query, and cut at `maxPath` characters.
    public var path: String
    /// The HTTP status of the page; 0 when the load failed before an answer.
    public var status: Int

    public static let maxPath = 120

    public init(at: Date, source: String, host: String, path: String, status: Int) {
        self.at = at; self.source = source; self.host = host.lowercased(); self.status = status
        self.path = String(path.prefix { $0 != "?" && $0 != "#" }.prefix(Self.maxPath))
    }

    /// A hop from an address: its host and path, the query and the fragment dropped.
    public init(at: Date, source: String, url: URL, status: Int) {
        self.init(at: at, source: source, host: url.host ?? "-", path: url.path.isEmpty ? "/" : url.path, status: status)
    }

    /// The network refusing Campus: a 403 from Campus's own host.
    public func isBlock(campusHost: String) -> Bool { status == 403 && host == campusHost.lowercased() }
}

/// A small file of hops, one JSON line each, newest last. Trimmed (by writing a new file in the old one's place) once it passes twice `keep`.
public final class CampusHopLog: @unchecked Sendable {
    public let file: URL
    public static let keep = 300
    private let lock = NSLock()
    public init(file: URL) { self.file = file }

    private static var encoder: JSONEncoder { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; e.outputFormatting = [.sortedKeys]; return e }
    private static var decoder: JSONDecoder { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }

    public func append(_ hop: CampusHop) {
        lock.lock(); defer { lock.unlock() }
        guard let line = try? Self.encoder.encode(hop) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        var all = readLocked()
        all.append(hop)
        if all.count > Self.keep * 2 {
            // Past twice the cap: write the newest ones as a new file in the old one's place.
            let text = all.suffix(Self.keep).compactMap { try? Self.encoder.encode($0) }.map { String(decoding: $0, as: UTF8.self) }.joined(separator: "\n") + "\n"
            try? Data(text.utf8).write(to: file, options: .atomic)
            return
        }
        if let h = try? FileHandle(forWritingTo: file) {
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: line + Data("\n".utf8))
        } else {
            try? (line + Data("\n".utf8)).write(to: file, options: .atomic)
        }
    }

    public func recent(_ limit: Int = 50) -> [CampusHop] {
        lock.lock(); defer { lock.unlock() }
        return Array(readLocked().suffix(limit))
    }

    /// When the network last refused Campus (a 403 from Campus's host), from this log; nil when it never did.
    public func lastBlocked(campusHost: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        return readLocked().last { $0.isBlock(campusHost: campusHost) }?.at
    }

    private func readLocked() -> [CampusHop] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { try? Self.decoder.decode(CampusHop.self, from: Data($0.utf8)) }
    }
}
