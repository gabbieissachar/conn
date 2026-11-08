// The agent bridge's rules (S2), all pure: who may call, what may not be sent, and the caps. The engine asks these before it touches Campus.
//
// Decision H4 (Nathan, 2026-11-08): big-boss, the leader homes and captain-driven workers may call; never a worker or a session in a personal or personal-work home or
// project. Conn cannot tell a captain-driven worker from any other worker by its label (`fm-<task id>`), so a worker is let in only when the person has added its exact
// label to the "also allow" list in settings; a leader label that names a personal home is refused by a fixed pattern. A label in a file is a claim: the audit records it
// as claimed, and nothing here can prove it (a supported token with server-side scopes is the only real fix: ROADMAP).
import Foundation
import CryptoKit

public struct BridgeCallers: Equatable, Sendable {
    /// Exact labels the person allows besides big-boss and the leaders (a captain-driven worker, for one).
    public var alsoAllowed: [String]
    /// Case-insensitive fragments that keep a label out whatever else says (a personal or personal-work home).
    public var deniedFragments: [String]

    public static let defaultDenied = ["personal"]

    public init(alsoAllowed: [String] = [], deniedFragments: [String] = BridgeCallers.defaultDenied) {
        self.alsoAllowed = alsoAllowed; self.deniedFragments = deniedFragments
    }

    /// nil when the caller may use the bridge; otherwise the one-line reason.
    public func refusal(kind: String, ref: String) -> String? {
        let label = ref.trimmingCharacters(in: .whitespaces)
        guard !label.isEmpty, label.range(of: "^[A-Za-z0-9._-]{1,80}$", options: .regularExpression) != nil else { return "the request does not say who sent it (send it with fm-ask)" }
        if let hit = deniedFragments.first(where: { !$0.isEmpty && label.lowercased().contains($0.lowercased()) }) {
            return "'\(label)' is a \(hit) home or session, which never uses the Campus bridge"
        }
        let isBigBoss = kind == "leader" && label == "big-boss"
        let isLeader = kind == "leader" && label.hasPrefix("leader-") && label.count > "leader-".count
        if isBigBoss || isLeader { return nil }
        if alsoAllowed.contains(label) { return nil }
        switch kind {
        case "child": return "'\(label)' is a worker: only big-boss and the leader homes use the Campus bridge (a captain-driven worker has to be allowed in Conn's settings)"
        case "session": return "'\(label)' is a plain session: only big-boss and the leader homes use the Campus bridge"
        default: return "'\(label)' may not use the Campus bridge"
        }
    }
}

public struct BridgeLimits: Equatable, Sendable {
    public var requestBytes = 8 * 1024
    public var replyBytes = BridgeReply.maxReplyBytes
    public var newPerHourPerHome = 6
    public var newPerDay = 20
    public var working = 3
    public var turnsPerThread = 10
    /// A request older than this when Conn reaches it is refused without any work (the switch was off, or Conn was closed): it is not what the caller wants any more.
    public var staleAfter: TimeInterval = 600
    public init() {}
}

public enum BridgeContent {
    /// nil when the text may go to Campus; otherwise the one-line reason it may not. The refusal is by shape: a private key header, a bearer token, a well-known token
    /// prefix, a `NAME=value` line whose name says it is a secret, a JWT, a long hex or base64 run, and anything that carries an attachment.
    public static func refusal(_ text: String) -> String? {
        if matches(text, "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----") { return "it contains a private key" }
        if matches(text, "(?i)\\bbearer\\s+[A-Za-z0-9._~+/=-]{16,}") { return "it contains a bearer token" }
        if matches(text, "\\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abpsr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\\.[0-9A-Za-z_-]{20,})") { return "it contains a token or key" }
        if matches(text, "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}") { return "it contains a signed token (JWT)" }
        if matches(text, "(?im)^\\s*(export\\s+)?[A-Z][A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)[A-Z0-9_]*\\s*[=:]\\s*\\S{6,}") { return "it contains a line that sets a secret (NAME=value)" }
        if matches(text, "(?i)\\b(password|passwd|secret|api[_ -]?key|token)\\s*(is|=|:)\\s*[\"']?[A-Za-z0-9!@#$%^&*._~+/=-]{8,}") { return "it contains what looks like a password or key" }
        if matches(text, "\\b[0-9a-fA-F]{32,}\\b") { return "it contains a long hex string" }
        if let run = longRun(text) { return "it contains a long token-like string (\(run.count) characters)" }
        if matches(text, "(?i)data:[a-z]+/[a-z0-9.+-]+;base64,") { return "it carries an attachment (a data URI)" }
        return nil
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }

    /// A run of 40 or more characters from the base64 and URL-safe alphabets that mixes letters and digits. A path with slashes in it is split at the slashes (an address
    /// is not a token), and a word of letters only never counts.
    static func longRun(_ text: String) -> String? {
        var run = ""
        func check() -> String? {
            defer { run = "" }
            guard run.count >= 40 else { return nil }
            let hasDigit = run.contains { $0.isNumber }, hasLetter = run.contains { $0.isLetter }
            return hasDigit && hasLetter ? run : nil
        }
        for ch in text {
            if ch.isASCII, ch.isLetter || ch.isNumber || "+=_-".contains(ch) { run.append(ch) } else if let hit = check() { return hit }
        }
        return check()
    }

    public static func sha256(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// What the audit says happened. The caps count started threads and turns from it, so a restart does not reset a cap. Never the text: its byte count and its hash.
public struct BridgeAuditEntry: Equatable, Sendable, Codable {
    public var at: Date
    public var sender: String
    public var kind: String
    public var requestID: String
    public var thread: String?
    public var action: String
    public var bytes: Int
    public var sha256: String
    public var outcome: String
    public init(at: Date, sender: String, kind: String, requestID: String, thread: String?, action: String, bytes: Int, sha256: String, outcome: String) {
        self.at = at; self.sender = sender; self.kind = kind; self.requestID = requestID; self.thread = thread; self.action = action; self.bytes = bytes; self.sha256 = sha256; self.outcome = outcome
    }
}

public enum BridgeCaps {
    /// nil when another new thread may start now; otherwise the reason it may not (the hour cap per home, the day cap in total).
    public static func newThreadRefusal(history: [BridgeAuditEntry], home: String, now: Date, limits: BridgeLimits) -> String? {
        let started = history.filter { $0.action == "new" && $0.thread != nil }
        let hour = started.filter { $0.sender == home && now.timeIntervalSince($0.at) < 3600 }.count
        if hour >= limits.newPerHourPerHome { return "\(home) has started \(hour) threads in the last hour (the cap is \(limits.newPerHourPerHome) an hour per home)" }
        let day = started.filter { now.timeIntervalSince($0.at) < 86_400 }.count
        if day >= limits.newPerDay { return "\(day) threads were started in the last 24 hours (the cap is \(limits.newPerDay) a day in total)" }
        return nil
    }

    /// Turns the bridge has used on a thread: every send that went through (the `new` is the first turn, each `continue` another).
    public static func turns(on thread: String, history: [BridgeAuditEntry]) -> Int {
        history.filter { $0.thread == thread && ($0.action == "new" || $0.action == "continue") && $0.outcome != "refused" && $0.outcome != "signed-out" }.count
    }
}
