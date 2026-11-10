// What the agent bridge keeps (S2): which threads agents may use (settings), the session registry (files), and the audit (one append-only file).
// None of it holds Campus text: the ownership list is addresses and modes, the registry holds the callers' own requests and Conn's replies for the length of a
// request, and the audit holds sizes and hashes.
import Foundation
import Combine

/// How far an agent may go in one thread.
public enum BridgeShare: String, Sendable, CaseIterable {
    /// Started by the bridge: agents may send to it and read it.
    case owned
    /// Shared by the person for reading only.
    case read
    /// Shared by the person for reading and sending.
    case readWrite = "readwrite"

    public var mayRead: Bool { true }
    public var maySend: Bool { self != .read }
}

/// The threads agents may use: the ones the bridge started, and the ones the person shared with "Share with agents". Addresses and modes only, in Conn's settings.
@MainActor
public final class BridgeOwnership: ObservableObject {
    @Published public private(set) var shares: [CampusAddress: BridgeShare] = [:]
    private let defaults: UserDefaults
    public let key: String

    public init(defaults: UserDefaults, key: String = "conn.campus.bridge.threads") {
        self.defaults = defaults; self.key = key
        for s in defaults.array(forKey: key) as? [String] ?? [] {
            guard let bar = s.firstIndex(of: "|"), let mode = BridgeShare(rawValue: String(s[..<bar])), let a = CampusAddress.parse(String(s[s.index(after: bar)...])) else { continue }
            shares[a] = mode
        }
    }

    private func save() { defaults.set(shares.map { "\($0.value.rawValue)|\($0.key.text)" }.sorted(), forKey: key) }

    public func share(for id: String) -> (address: CampusAddress, mode: BridgeShare)? {
        shares.first { $0.key.id == id }.map { ($0.key, $0.value) }
    }
    public func mode(of id: String) -> BridgeShare? { share(for: id)?.mode }

    /// A thread the bridge started: owned, whatever it was before.
    public func addOwned(_ a: CampusAddress) { shares[a] = .owned; save() }

    /// The person's choice for a thread: nil takes it away from agents. A thread the bridge started stays owned (it has no "off": delete it in Campus).
    public func setShared(_ a: CampusAddress, _ mode: BridgeShare?) {
        if shares[a] == .owned { return }
        if let m = mode { shares[a] = m } else { shares[a] = nil }
        save()
    }

    public func clear() { shares = [:]; save() }
}

/// The plain-session registry of `bin/fm-session-lib.sh`: `<registry>/campus.meta` says Conn is the session `campus` (so `fm-who campus` reports `can_receive` from its pid and
/// `fm-ask campus` finds it), requests land in `campus.inbox/NNN.msg`, answers go to `campus.replies/<request-id>`, and a handled request moves to `campus.inbox/handled/`.
public struct BridgeRegistry: Sendable {
    public let directory: URL
    public static let name = "campus"
    public static let schemaMeta = "fm-session.v1"
    public static let schemaReply = "fm-session-reply.v1"

    public init(directory: URL) { self.directory = directory }

    /// `FM_SESSIONS_DIR`, else `${XDG_STATE_HOME:-$HOME/.local/state}/firstmate/sessions`: where `fm-session` and `fm-ask` look.
    public static func defaultDirectory(env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> URL {
        if let d = env["FM_SESSIONS_DIR"], !d.isEmpty { return URL(fileURLWithPath: d, isDirectory: true) }
        let state = env["XDG_STATE_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? home + "/.local/state"
        return URL(fileURLWithPath: state, isDirectory: true).appendingPathComponent("firstmate/sessions", isDirectory: true)
    }

    public var metaFile: URL { directory.appendingPathComponent("\(Self.name).meta") }
    public var inbox: URL { directory.appendingPathComponent("\(Self.name).inbox", isDirectory: true) }
    public var handled: URL { inbox.appendingPathComponent("handled", isDirectory: true) }
    public var replies: URL { directory.appendingPathComponent("\(Self.name).replies", isDirectory: true) }

    public enum RegisterError: Error, Equatable, Sendable { case heldByAnother(pid: Int32), io(String) }

    private func meta() -> [String: String] {
        guard let t = try? String(contentsOf: metaFile, encoding: .utf8) else { return [:] }
        var m: [String: String] = [:]
        for l in t.split(separator: "\n") { if let eq = l.firstIndex(of: "=") { m[String(l[..<eq])] = String(l[l.index(after: eq)...]) } }
        return m
    }

    /// The pid the record names, if any.
    public var registeredPID: Int32? { meta()["pid"].flatMap { Int32($0) } }

    static func alive(_ pid: Int32) -> Bool { pid > 1 && kill(pid, 0) == 0 }

    /// Make Conn the session `campus`. Refused when another running process holds the name (a second Conn), so two apps never answer one inbox.
    public func register(pid: Int32 = getpid(), now: Date = Date()) throws {
        if let old = registeredPID, old != pid, Self.alive(old) { throw RegisterError.heldByAnother(pid: old) }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)      // as `fm-session register` does: the callers' requests are the person's own
            try fm.createDirectory(at: handled, withIntermediateDirectories: true)
            try fm.createDirectory(at: replies, withIntermediateDirectories: true)
            let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]
            let text = "schema=\(Self.schemaMeta)\nname=\(Self.name)\nharness=conn\nsession_id=conn-\(pid)\npid=\(pid)\ncwd=\(directory.path)\nregistered_at=\(f.string(from: now))\n"
            try Self.writeAtomically(Data(text.utf8), to: metaFile)
        } catch { throw RegisterError.io("\(error)") }
    }

    /// Take Conn's name out of the registry (switch off, quit). Only a record that names this process is removed; pending requests stay in the inbox.
    public func unregister(pid: Int32 = getpid()) {
        guard registeredPID == pid else { return }
        try? FileManager.default.removeItem(at: metaFile)
    }

    /// A record left by a Conn that is no longer running: removed at launch, so `fm-who campus` does not report a name nobody answers for.
    public func clearStale(pid: Int32 = getpid()) {
        guard let old = registeredPID, old != pid, !Self.alive(old) else { return }
        try? FileManager.default.removeItem(at: metaFile)
    }

    /// The records waiting, in sequence order, with their bytes (a record over 256 KB is read as empty and refused by the parser).
    public func pending() -> [(name: String, data: Data)] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: inbox.path) else { return [] }
        return names.compactMap { n -> (Int, String)? in BridgeRecordParser.sequence(n).map { ($0, n) } }.sorted { $0.0 < $1.0 }.map { _, n in
            let u = inbox.appendingPathComponent(n)
            let size = (try? FileManager.default.attributesOfItem(atPath: u.path)[.size] as? Int) ?? 0
            return (n, size > 256 * 1024 ? Data() : ((try? Data(contentsOf: u)) ?? Data()))
        }
    }

    /// Seconds since the inbox record was last written (nil when it is not there).
    public func age(of fileName: String, now: Date = Date()) -> TimeInterval? {
        guard let m = (try? FileManager.default.attributesOfItem(atPath: inbox.appendingPathComponent(fileName).path))?[.modificationDate] as? Date else { return nil }
        return now.timeIntervalSince(m)
    }

    public func replyExists(_ id: String) -> Bool { FileManager.default.fileExists(atPath: replies.appendingPathComponent(id).path) }

    /// The answer, as `fm-session reply` writes it: a staged file renamed into place, so a reader never sees half of it.
    public func writeReply(id: String, body: String, now: Date = Date()) throws {
        guard BridgeRecordParser.validRequestID(id) else { throw RegisterError.io("bad request id") }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]
        let text = "schema=\(Self.schemaReply)\nrequest_id=\(id)\nat=\(f.string(from: now))\n--\n\(body)\n"
        try FileManager.default.createDirectory(at: replies, withIntermediateDirectories: true)
        try Self.writeAtomically(Data(text.utf8), to: replies.appendingPathComponent(id))
    }

    /// Move a record to `handled/`: the acknowledgement.
    public func acknowledge(fileName: String) {
        let from = inbox.appendingPathComponent(fileName)
        guard FileManager.default.fileExists(atPath: from.path) else { return }
        try? FileManager.default.createDirectory(at: handled, withIntermediateDirectories: true)
        let to = handled.appendingPathComponent(fileName)
        if FileManager.default.fileExists(atPath: to.path) { try? FileManager.default.removeItem(at: to) }
        try? FileManager.default.moveItem(at: from, to: to)
    }

    static func writeAtomically(_ data: Data, to url: URL) throws {
        let stage = url.deletingLastPathComponent().appendingPathComponent(".staging.\(UUID().uuidString.prefix(8))")
        try data.write(to: stage)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stage.path)
        // rename(2) replaces the destination in one step, so a reader sees the old file or the whole new one.
        if rename(stage.path, url.path) != 0 { throw RegisterError.io("could not move \(stage.lastPathComponent) into place (\(errno))") }
    }
}

/// The audit: one JSON line per request, appended, never rewritten, in Conn's own folder. Time, the sender label as claimed, request id, thread, action, byte count, the sha256
/// of the text, outcome. Not the text (the request is already in the `fm-ask` record).
public struct BridgeAuditLog: Sendable {
    public let file: URL
    public init(file: URL) { self.file = file }

    static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .secondsSince1970; e.outputFormatting = [.sortedKeys]; return e }()
    static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .secondsSince1970; return d }()

    public func append(_ e: BridgeAuditEntry) {
        guard var line = try? Self.encoder.encode(e) else { return }
        line.append(0x0A)
        let fm = FileManager.default
        try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if !fm.fileExists(atPath: file.path) { fm.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        guard let h = try? FileHandle(forWritingTo: file) else { return }
        defer { try? h.close() }
        _ = try? h.seekToEnd()
        try? h.write(contentsOf: line)
    }

    /// Everything within `window` seconds of `now` (a line that does not decode is skipped, never an error).
    public func read(since window: TimeInterval = 86_400, now: Date = Date()) -> [BridgeAuditEntry] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return data.split(separator: 0x0A).compactMap { try? Self.decoder.decode(BridgeAuditEntry.self, from: Data($0)) }.filter { now.timeIntervalSince($0.at) < window }
    }
}
