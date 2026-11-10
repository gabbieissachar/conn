// The agent bridge's wire format (S2): what `fm-ask campus -- <text>` leaves in Conn's inbox, how its text is read as a command, and the reply Conn writes back.
//
// A request reaches Conn as one durable record in the session registry (`<registry>/campus.inbox/NNN.msg`, written by `bin/fm-ask.sh` through `fm-task-inbox-lib.sh`):
//   schema=fm-task-inbox.v1 / at=<utc> / body-terminator=1 / --      (the record's own header, then the body)
//   fm-ask request-id=<id> / from-kind=<kind> / from-ref=<label> / reply-home=<home> / --      (what fm-ask records about the sender)
//   <the text the caller wrote>
// The sender label is whatever the file says: a same-user process can write any label, so it is a claim, not a proof (the audit records it as claimed).
// The text is a short header, a line `---`, and the message:
//   campus: new | continue ses_... | read ses_...
//   agent: plan            (optional)     topic: short title (optional)     answer: text (optional, for a question the thread asked)
//   ---
//   <message text>
// The reply is one file (`<registry>/campus.replies/<request-id>`, the format `fm-session reply` writes), whose body is the `BridgeReply` below.
import Foundation

public struct BridgeRecord: Equatable, Sendable {
    public var requestID: String
    public var fromKind: String
    public var fromRef: String
    /// The caller's text: what follows the second `--`.
    public var text: String
    /// When the record says it was written (`at=`), if it says.
    public var at: Date?
    /// The record's file name (`003.msg`).
    public var fileName: String
}

public enum BridgeRecordParser {
    /// nil when the bytes are not a request record Conn can answer: no id to answer under, or not UTF-8. A record without the `fm-ask` lines still parses when the file
    /// name gives an id (it is then a request from nobody: `fromKind` and `fromRef` are empty and the sender check refuses it).
    public static func parse(_ data: Data, fileName: String) -> BridgeRecord? {
        guard let raw = String(data: data, encoding: .utf8) else { return nil }
        guard let sep = raw.range(of: "\n--\n") else { return nil }
        var meta: [String: String] = [:]
        for line in raw[..<sep.lowerBound].split(separator: "\n", omittingEmptySubsequences: true) {
            if let eq = line.firstIndex(of: "=") { meta[String(line[..<eq])] = String(line[line.index(after: eq)...]) }
        }
        var body = String(raw[sep.upperBound...])
        if meta["body-terminator"] == "1", body.hasSuffix("\n") { body.removeLast() }
        var requestID = "", kind = "", ref = ""
        var text = body
        // The lines fm-ask puts first, up to its own `--`.
        let lines = body.components(separatedBy: "\n")
        if let first = lines.first, first.hasPrefix("fm-ask request-id="), let end = lines.firstIndex(of: "--") {
            for l in lines[..<end] {
                let l = l.hasPrefix("fm-ask ") ? String(l.dropFirst("fm-ask ".count)) : l
                guard let eq = l.firstIndex(of: "=") else { continue }
                let k = String(l[..<eq]), v = String(l[l.index(after: eq)...])
                switch k { case "request-id": requestID = v; case "from-kind": kind = v; case "from-ref": ref = v; default: break }
            }
            text = lines[(end + 1)...].joined(separator: "\n")
        }
        if requestID.isEmpty {
            // No fm-ask lines: the file name is all there is to answer under, and it must be a plain token.
            requestID = (fileName as NSString).deletingPathExtension
        }
        guard validRequestID(requestID) else { return nil }
        return BridgeRecord(requestID: requestID, fromKind: kind, fromRef: ref, text: text, at: meta["at"].flatMap(parseDate), fileName: fileName)
    }

    /// One path-safe token: the rule `fm-ask` and `fm-session` apply (so it can name a file).
    public static func validRequestID(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 128 && !s.hasPrefix(".") && s.range(of: "^[A-Za-z0-9._:-]+$", options: .regularExpression) != nil
    }

    static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// The sequence number of a record file name (`003.msg` is 3); nil for anything else.
    public static func sequence(_ fileName: String) -> Int? {
        guard fileName.hasSuffix(".msg") else { return nil }
        let n = String(fileName.dropLast(4))
        return n.range(of: "^[0-9]+$", options: .regularExpression) != nil ? Int(n) : nil
    }
}

/// What the caller asked for.
public struct BridgeCommand: Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case new
        case `continue`(String)
        case read(String)

        public var name: String {
            switch self { case .new: return "new"; case .continue: return "continue"; case .read: return "read" }
        }
        public var thread: String? {
            switch self { case .new: return nil; case .continue(let t), .read(let t): return t }
        }
    }
    public var action: Action
    public var agent: String?
    public var topic: String?
    public var answer: String?
    public var text: String

    public enum ParseError: Error, Equatable, Sendable { case format(String) }

    /// The default agent of a bridge thread: opencode's planning agent, meant not to edit (whether Campus's setup also blocks connector writes is a check for the
    /// first real thread; the preamble below says so too).
    public static let defaultAgent = "plan"
    public static let maxTopic = 80

    /// Read the text. Header lines come first, then `---`, then the message. Anything else is a `format` error with a one-line reason.
    public static func parse(_ text: String) throws -> BridgeCommand {
        let lines = text.components(separatedBy: "\n")
        var header: [String: String] = [:]
        var bodyStart = lines.count
        for (i, line) in lines.enumerated() {
            if line.trimmingCharacters(in: .whitespaces) == "---" { bodyStart = i + 1; break }
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            guard let colon = t.firstIndex(of: ":") else { throw ParseError.format("expected 'name: value' lines, then ---, then the message") }
            let k = t[..<colon].lowercased().trimmingCharacters(in: .whitespaces)
            let v = t[t.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard ["campus", "agent", "topic", "answer", "attach", "file", "attachment", "attachments"].contains(k) else { throw ParseError.format("unknown header '\(k)'") }
            if header[k] != nil { throw ParseError.format("header '\(k)' given twice") }
            header[k] = v
        }
        guard let verb = header["campus"], !verb.isEmpty else { throw ParseError.format("first header must be 'campus: new | continue ses_... | read ses_...'") }
        let parts = verb.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        let action: Action
        switch (parts.first, parts.count) {
        case ("new", 1): action = .new
        case ("continue", 2) where CampusSpace.validConversationID(parts[1]): action = .continue(parts[1])
        case ("read", 2) where CampusSpace.validConversationID(parts[1]): action = .read(parts[1])
        default: throw ParseError.format("campus: must be 'new', 'continue ses_...' or 'read ses_...'")
        }
        let body = bodyStart <= lines.count ? lines[min(bodyStart, lines.count)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) : ""
        var agent: String?
        if let a = header["agent"] {
            guard a.range(of: "^[A-Za-z0-9._-]{1,40}$", options: .regularExpression) != nil else { throw ParseError.format("agent must be a plain name") }
            agent = a
        }
        var topic: String?
        if let t = header["topic"] { topic = BridgeCommand.cleanTopic(t) }
        if header["attach"] != nil || header["file"] != nil || header["attachment"] != nil || header["attachments"] != nil { throw ParseError.format("attachments are not accepted") }
        switch action {
        case .new:
            guard !body.isEmpty else { throw ParseError.format("'campus: new' needs a message after ---") }
            if header["answer"] != nil { throw ParseError.format("'answer:' is only for 'continue'") }
        case .continue:
            guard !body.isEmpty || header["answer"] != nil else { throw ParseError.format("'campus: continue' needs a message after --- or an 'answer:'") }
        case .read:
            guard body.isEmpty, header["answer"] == nil else { throw ParseError.format("'campus: read' takes no message") }
        }
        return BridgeCommand(action: action, agent: agent, topic: topic, answer: header["answer"], text: body)
    }

    /// A title is one short plain line: control characters and newlines go, runs of spaces collapse, the length is capped.
    public static func cleanTopic(_ s: String) -> String {
        let kept = s.unicodeScalars.map { $0.properties.generalCategory == .control ? " " : String($0) }.joined()
        let one = kept.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        return String(one.prefix(maxTopic))
    }

    /// `fm/<home>: <topic>`: the home is the sender label without its `leader-` prefix; with no topic the title says only that the thread is the bridge's.
    public static func title(home: String, topic: String?) -> String {
        let h = home.hasPrefix("leader-") ? String(home.dropFirst("leader-".count)) : home
        let safe = cleanTopic(h)
        let clean = cleanTopic(topic ?? "")
        let t = clean.isEmpty ? "agent request" : clean
        return "fm/\(safe.isEmpty ? "unknown" : safe): \(t)"
    }

    /// Said first in every thread the bridge starts. Advisory only: it asks the Campus agent to stay inside the conversation. The bridge's own limits are the switch,
    /// the caps and the refusals, not this text.
    public static let preamble = """
    This conversation was started by an automated agent through Conn's agent bridge. It is automated and read-only. Do not send, post, share, publish, delete or change anything outside this conversation, and do not use a connector to write. Answer in plain text, in your own words, and ask at most one question if you must. The message follows after the line of dashes.
    ----------
    """
}

/// What Conn writes back.
public struct BridgeReply: Equatable, Sendable {
    public enum Status: String, Sendable { case done, working, needsAnswer = "needs-answer", refused, failed, signedOut = "signed-out" }
    public var status: Status
    public var thread: String?
    public var url: String?
    public var reason: String?
    public var question: String?
    public var reply: String?
    public var tokensIn: Int?
    public var tokensOut: Int?
    /// The file Conn will write the end of the run to when this reply is `working` and the thread is still being watched (`<request id>.late`, in the replies folder).
    public var lateFile: String?
    /// Set by the engine when the wait ran out on a thread it will keep watching (not written; `lateFile` is what the caller reads).
    var watchLate = false

    public init(_ status: Status, thread: String? = nil, url: String? = nil, reason: String? = nil, question: String? = nil, reply: String? = nil, tokensIn: Int? = nil, tokensOut: Int? = nil) {
        self.status = status; self.thread = thread; self.url = url; self.reason = reason; self.question = question; self.reply = reply; self.tokensIn = tokensIn; self.tokensOut = tokensOut
    }

    public static let maxReplyBytes = 64 * 1024

    /// `key: value` lines; `reply:` last, because it can run over many lines and the caller reads everything after it.
    public func render() -> String {
        var out = "status: \(status.rawValue)\n"
        if let t = thread { out += "thread: \(t)\n" }
        if let u = url { out += "url: \(u)\n" }
        if let l = lateFile { out += "late: \(l)\n" }
        if let r = reason { out += "reason: \(Self.oneLine(r))\n" }
        if let q = question { out += "question: \(Self.oneLine(q))\n" }
        if let i = tokensIn, let o = tokensOut { out += "tokens: in=\(i) out=\(o)\n" }
        if let r = reply {
            let cut = Self.truncated(r)
            out += "reply:" + (cut.contains("\n") ? "\n" : " ") + cut + "\n"
        }
        return out
    }

    static func oneLine(_ s: String) -> String { s.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ") }

    /// At most 64 KB of UTF-8, cut on a character boundary; the rest stays in Campus (the url opens it).
    static func truncated(_ s: String) -> String {
        guard s.utf8.count > maxReplyBytes else { return s }
        var bytes = 0, end = s.startIndex
        for i in s.indices {
            let n = String(s[i]).utf8.count
            if bytes + n > maxReplyBytes - 64 { break }
            bytes += n; end = s.index(after: i)
        }
        return String(s[..<end]) + "\n[cut: the rest of the reply is in Campus]"
    }
}
