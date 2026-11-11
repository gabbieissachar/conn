// What Conn knows about Campus (README "Campus in Conn"): spaces, conversations and their state. In memory only; nothing here is
// written to disk. Campus's private API is read tolerantly (CampusJSON), so a field that is missing or renamed shows as "unknown",
// never as a crash.
import Foundation

public struct CampusSpace: Equatable, Sendable, Identifiable {
    /// `private` or `team` (the path segment of `/api/spaces/<kind>/<folder>`).
    public var kind: String
    public var folder: String
    public var displayName: String
    public var readOnly: Bool
    public var id: String { kind + "/" + folder }
    public var isTeam: Bool { kind != "private" }
    public init(kind: String, folder: String, displayName: String, readOnly: Bool = false) {
        self.kind = kind; self.folder = folder; self.displayName = displayName; self.readOnly = readOnly
    }

    /// `GET /api/spaces` answers `{running, newPrivateSpace, private:[{folderName, displayName, colour}], shared:[{folderName, displayName, readOnly, colour}]}`;
    /// `shared` are team spaces (path kind `team`). A space with no folder name is dropped.
    public static func parseList(_ data: Data) -> [CampusSpace]? {
        guard let root = CampusJSON.parse(data), root.object != nil else { return nil }
        func spaces(_ key: String, kind: String) -> [CampusSpace] {
            root[key].array.compactMap { s in
                guard let folder = s["folderName"].string ?? s["folder"].string, validFolder(folder) else { return nil }
                return CampusSpace(kind: kind, folder: folder, displayName: s["displayName"].string ?? folder, readOnly: s["readOnly"].bool ?? false)
            }
        }
        return spaces("private", kind: "private") + spaces("shared", kind: "team")
    }

    /// A space folder or conversation id goes into a request path: only plain characters are allowed.
    /// `.` and `..` are plain characters too, but as a path segment they walk out of the space: never a folder.
    public static func validFolder(_ s: String) -> Bool { s != "." && s != ".." && s.range(of: "^[A-Za-z0-9._-]{1,128}$", options: .regularExpression) != nil }
    public static func validConversationID(_ s: String) -> Bool { s.range(of: "^[A-Za-z0-9_-]{4,80}$", options: .regularExpression) != nil }
}

/// One conversation row. `working`, `needsYou` and `unread` come with the list; `ask` is read from the open form of a conversation that needs the person.
public struct CampusConversation: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var spaceKind: String
    public var folder: String
    public var spaceName: String
    public var updatedAt: Date?
    public var working: Bool
    public var needsYou: Bool
    public var unread: Bool
    /// What the agent asks, and when the form was opened (nil until read).
    public var ask: CampusAsk?
    public var agent: String?
    public var model: String?

    public init(id: String, title: String, spaceKind: String, folder: String, spaceName: String = "", updatedAt: Date? = nil,
                working: Bool = false, needsYou: Bool = false, unread: Bool = false, ask: CampusAsk? = nil, agent: String? = nil, model: String? = nil) {
        self.id = id; self.title = title; self.spaceKind = spaceKind; self.folder = folder; self.spaceName = spaceName; self.updatedAt = updatedAt
        self.working = working; self.needsYou = needsYou; self.unread = unread; self.ask = ask; self.agent = agent; self.model = model
    }

    /// The four marks Conn already draws: needs you, working, done (finished and not yet looked at), idle (C3).
    public var state: AgentState {
        if needsYou { return .blocked }
        if working { return .working }
        return unread ? .done : .idle
    }

    public var spaceID: String { spaceKind + "/" + folder }
    public var isTeam: Bool { spaceKind != "private" }

    /// `GET /api/spaces/<kind>/<folder>/conversations?limit=50` answers `{conversations:[{id, title, spaceKind, folder, spaceName, spaceColour, updatedAt, working, needsYou, unread, routineRun}], hasMore, partial}`.
    public static func parseList(_ data: Data, space: CampusSpace) -> [CampusConversation]? {
        guard let root = CampusJSON.parse(data), root["conversations"].object == nil, root.object != nil else { return nil }
        return root["conversations"].array.compactMap { c in
            guard let id = c["id"].string, CampusSpace.validConversationID(id) else { return nil }
            return CampusConversation(id: id, title: c["title"].string.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled conversation",
                                      spaceKind: c["spaceKind"].string ?? space.kind, folder: c["folder"].string ?? space.folder,
                                      spaceName: c["spaceName"].string ?? space.displayName, updatedAt: c["updatedAt"].date,
                                      working: c["working"].bool ?? false, needsYou: c["needsYou"].bool ?? false, unread: c["unread"].bool ?? false)
        }
    }
}

extension CampusConversation {
    /// The answer to a start (`POST .../conversations`). Its shape is the one thing about that call nobody has seen, so the new conversation is looked for where Campus's
    /// other answers keep one: the object itself, or under `data`, `conversation` or `session`. nil when none of them carries a valid id.
    public static func parseCreated(_ data: Data, space: CampusSpace, now: Date = Date()) -> CampusConversation? {
        guard let root = CampusJSON.parse(data), root.object != nil else { return nil }
        for j in [root, root["data"], root["conversation"], root["session"]] where j.object != nil {
            guard let id = j["id"].string, CampusSpace.validConversationID(id) else { continue }
            let title = j["title"].string.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled conversation"
            return CampusConversation(id: id, title: title, spaceKind: space.kind, folder: space.folder, spaceName: space.displayName, updatedAt: j["time"]["updated"].date ?? now,
                                      working: true, agent: j["agent"].string, model: j["model"]["id"].string)
        }
        return nil
    }
}

public struct CampusAsk: Equatable, Sendable {
    public var text: String
    public var tag: String
    public var at: Date?
    public init(text: String, tag: String, at: Date? = nil) { self.text = text; self.tag = tag; self.at = at }
}

/// `GET .../<id>/status` answers `{state: "idle"|"needs_you"|"busy", unread, parked[], held[], spaceDirectory}`.
public struct CampusStatus: Equatable, Sendable {
    public enum Run: Equatable, Sendable { case idle, needsYou, busy, unknown(String) }
    public var run: Run
    public var unread: Bool
    public init(run: Run, unread: Bool = false) { self.run = run; self.unread = unread }
    public static func parse(_ data: Data) -> CampusStatus? {
        guard let root = CampusJSON.parse(data), let s = root["state"].string else { return nil }
        let run: Run
        switch s { case "idle": run = .idle; case "needs_you": run = .needsYou; case "busy": run = .busy; default: run = .unknown(s) }
        return CampusStatus(run: run, unread: root["unread"].bool ?? false)
    }
}

/// A permission the agent asks for (`permission.asked`, one item of `permissions[]` in `GET .../<id>/form`): run a command, write a file, reach a path. It is a grant, not a
/// chat answer, so it is read plainly and answered only by a person's click. The fields follow opencode's permission request (`id`, `permission`, `patterns[]`); the reply
/// values are opencode's (`once`, `always`, `reject`). Nobody has seen Campus's own, so every reader here is tolerant and the first real answer is the person's (ROADMAP).
public struct CampusPermission: Equatable, Sendable {
    /// One thing the person can answer: what the button says, and the value Campus is sent in `{"decision": ...}`.
    public struct Decision: Equatable, Sendable {
        public var label: String
        public var value: String
        public init(label: String, value: String) { self.label = label; self.value = value }
    }
    /// What is asked for (`bash`, `edit`, `webfetch`, ...), as Campus names it.
    public var name: String
    /// The commands, paths or addresses it applies to, as Campus gave them.
    public var patterns: [String]
    public var decisions: [Decision]

    public init(name: String, patterns: [String] = [], decisions: [Decision] = CampusPermission.defaultDecisions) { self.name = name; self.patterns = patterns; self.decisions = decisions }

    public static let allowOnce = Decision(label: "Allow once", value: "once")
    public static let reject = Decision(label: "Reject", value: "reject")
    /// What Conn offers when the request lists no choices of its own: this one time, or not at all.
    public static let defaultDecisions = [allowOnce, reject]
    /// Whether a standing grant ("always allow") is offered as a button. Off: a wrong click must not turn into a permission that outlasts the thread (README, decision P1).
    public static let offersStandingGrant = false
    /// The most characters of patterns that Conn will let a person allow. The card always shows every pattern in full (a grant must be read whole, so nothing is cut), but past this
    /// length it offers only Reject and the way to open the thread in Campus: nobody reads that much on a card, and a tail they did not read is not consent.
    public static let approvableLimit = 2_000

    /// A character that could hide or fake part of a command (a line break, a tab, another control, a bidi override or a zero-width mark) is shown as a visible token.
    static func visible(_ s: String) -> String {
        var out = ""
        for u in s.unicodeScalars {
            switch u.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator:
                switch u {
                case "\n", "\r", "\u{2028}", "\u{2029}": out += "⏎"
                case "\t": out += "⇥"
                default: out += "<U+" + String(format: "%04X", u.value) + ">"
                }
            default: out.unicodeScalars.append(u)
            }
        }
        return out
    }

    /// Too much to read on a card: only Reject is offered.
    public var tooLongToApprove: Bool { patterns.joined(separator: ", ").count > Self.approvableLimit }

    /// The wire value of the choice the button of that label stands for.
    public func value(for label: String) -> String? { decisions.first { $0.label == label }?.value }

    /// `Allow bash: curl https://example.test`: the one line the row, the card and the page's record show.
    public var question: String {
        let joined = Self.visible(patterns.joined(separator: ", "))
        return "Allow \(Self.visible(name))" + (joined.isEmpty ? "" : ": " + joined)
    }

    /// The words on a button for a reply value (`once` is "Allow once").
    public static func label(forValue v: String) -> String {
        switch v.lowercased() {
        case "once", "allow", "allow_once", "approve", "approved", "granted": return "Allow once"
        case "reject", "rejected", "deny", "denied": return "Reject"
        case "always", "allow_always": return "Always allow"
        default: return v.isEmpty ? v : v.prefix(1).uppercased() + v.dropFirst()
        }
    }

    static func isStanding(_ value: String) -> Bool { value.lowercased().contains("always") }

    /// The choices a request lists (`options`, `choices`, `decisions` or `replies`: strings, or objects with a label and a value), without a standing grant unless that is on;
    /// the defaults when it lists none that Conn may offer.
    static func decisions(in j: CampusJSON) -> [Decision] {
        let list = j.first("options", "choices", "decisions", "replies").array
        var out: [Decision] = []
        for o in list {
            if let s = o.string, !s.isEmpty { out.append(Decision(label: label(forValue: s), value: s)); continue }
            guard o.object != nil else { continue }
            let value = o.first("value", "id", "decision", "reply", "name").string ?? o.first("label", "text", "title").string ?? ""
            guard !value.isEmpty else { continue }
            out.append(Decision(label: o.first("label", "text", "title", "name").string ?? label(forValue: value), value: value))
        }
        if !offersStandingGrant { out.removeAll { isStanding($0.value) } }
        // The labels are the buttons: two with the same words would be one choice.
        var seen: Set<String> = []
        out = out.filter { seen.insert($0.label).inserted }
        return out.isEmpty ? defaultDecisions : out
    }
}

/// A question the agent put to the person (`form.created`, `GET .../<id>/form`). Campus's question tool: one or more questions, each with options.
/// A permission ask is carried the same way (one question, its choices as the options, `permission` set) so the row, the cards, the transcript record and the write gate
/// are one path for both; only the call that answers it differs.
public struct CampusForm: Equatable, Sendable, Identifiable {
    public struct Question: Equatable, Sendable {
        public var text: String
        public var options: [String]
        public var pick: String?
        public init(text: String, options: [String], pick: String? = nil) { self.text = text; self.options = options; self.pick = pick }
    }
    /// `resolved`: it left Campus's pending list without Conn answering it (answered in Campus's own page or by another client, or withdrawn); shown as "Answered in Campus".
    public enum Status: Equatable, Sendable { case open, answered(String), cancelled, resolved }
    public var id: String
    public var questions: [Question]
    public var status: Status
    /// Set when this is a permission ask: what is asked and what each button sends.
    public var permission: CampusPermission?

    public init(id: String, questions: [Question], status: Status = .open, permission: CampusPermission? = nil) { self.id = id; self.questions = questions; self.status = status; self.permission = permission }

    public var isOpen: Bool { status == .open }
    public var isPermission: Bool { permission != nil }
    /// The row's ask text and tag (C2/C3: a Campus question is an open ask like a Herdr one).
    public var asText: String { permission?.question ?? questions.map(\.text).joined(separator: " ") }
    public var tag: String {
        if let p = permission { return "Permission · \(p.name)" }
        return questions.count > 1 ? "Answer sheet · \(questions.count) questions" : "Question · \(questions.first?.options.count ?? 0) options"
    }

    /// The form in a payload, whatever it is wrapped in (`form`, `data`, or bare). Option lists of strings or of `{label|text|value}` objects both work.
    public static func parse(_ j: CampusJSON) -> CampusForm? {
        let f = j["form"].isNull ? j : j["form"]
        guard let id = f.first("id", "formID", "formId").string, validID(id) else { return nil }
        let qs: [CampusJSON] = f.first("questions", "fields", "items").array
        let questions: [Question] = qs.compactMap { q in
            let text = q.first("question", "text", "title", "label", "prompt").string ?? ""
            guard !text.isEmpty else { return nil }
            let opts = q.first("options", "choices").array.compactMap { o in o.string ?? o.first("label", "text", "value").string }
            return Question(text: text, options: opts)
        }
        guard !questions.isEmpty else { return nil }
        return CampusForm(id: id, questions: questions)
    }

    /// A permission request in a payload: the object itself, or under `permission` or `request` (an event's data). Its `permission` is the kind (`bash`), its `patterns` what it
    /// applies to. A request with no id, or one that names nothing it asks for, is not read: Conn would have nothing true to show or answer.
    public static func parsePermission(_ j: CampusJSON) -> CampusForm? {
        let p = j["permission"].object != nil ? j["permission"] : (j["request"].object != nil ? j["request"] : j)
        guard let id = p.first("id", "permissionID", "permissionId", "requestID", "requestId").string, validID(id) else { return nil }
        let name = p.first("permission", "type", "kind", "title", "name").string ?? ""
        var patterns = p["patterns"].array.compactMap(\.string).filter { !$0.isEmpty }
        if patterns.isEmpty, let one = p.first("pattern", "path", "command", "description").string, !one.isEmpty { patterns = [one] }
        guard !name.isEmpty || !patterns.isEmpty else { return nil }
        var perm = CampusPermission(name: name.isEmpty ? "a permission" : name, patterns: patterns, decisions: CampusPermission.decisions(in: p))
        // Too long to read on a card: nothing that grants is offered (what is asked is still shown in full).
        if perm.tooLongToApprove { perm.decisions = [CampusPermission.reject] }
        return CampusForm(id: id, questions: [Question(text: perm.question, options: perm.decisions.map(\.label))], permission: perm)
    }

    public static func validID(_ s: String) -> Bool { s.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil }

    /// `GET .../<id>/form` answers `{sessionIDs, permissions[], forms[]}`: the open forms (questions only: the agent bridge reads this one and never answers a permission).
    public static func parseOpenForms(_ data: Data) -> [CampusForm] {
        guard let root = CampusJSON.parse(data) else { return [] }
        return root["forms"].array.compactMap(parse)
    }

    /// Everything the agent waits on in that answer, a permission first (it holds up a tool; a question comes when the run has stopped). `permissionsOnly` reads an answer that is the
    /// permissions themselves: `{permissions: [...]}` or a bare list.
    public static func parseOpenRequests(_ data: Data, permissionsOnly: Bool = false) -> [CampusForm] {
        guard let root = CampusJSON.parse(data) else { return [] }
        let perms = root["permissions"].array.isEmpty && permissionsOnly ? root.array : root["permissions"].array
        return perms.compactMap(parsePermission) + (permissionsOnly ? [] : root["forms"].array.compactMap(parse))
    }

    /// The text of the answers given for a reply: one pick per question.
    public var pickedText: String? {
        let picks = questions.compactMap(\.pick)
        return picks.count == questions.count ? picks.joined(separator: "; ") : nil
    }
}

/// How a conversation's agent and model are shown in the live view header and the pickers (`composer/agents`, `composer/models`).
public struct CampusChoice: Equatable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var provider: String?
    public var variant: String?
    public init(id: String, label: String, provider: String? = nil, variant: String? = nil) { self.id = id; self.label = label; self.provider = provider; self.variant = variant }

    public static func parseList(_ data: Data, keys: [String]) -> [CampusChoice] {
        guard let root = CampusJSON.parse(data) else { return [] }
        var list = root.array
        if list.isEmpty { for k in keys { let v = root[k].array; if !v.isEmpty { list = v; break } } }
        if list.isEmpty { list = root["data"].array }
        return list.compactMap { c in
            if let s = c.string { return CampusChoice(id: s, label: s) }
            guard let id = c.first("id", "name", "alias").string, !id.isEmpty else { return nil }
            return CampusChoice(id: id, label: c.first("label", "displayName", "name", "id").string ?? id, provider: c["providerID"].string, variant: c["variant"].string)
        }
    }
}

/// What the Campus link is doing, for the sidebar, the status bar and the edge states (C9).
public enum CampusLink: Equatable, Sendable {
    /// Campus is not part of this launch.
    case disabled
    /// Waiting for the first answer, or Campus answered `503 opencode_starting`.
    case starting
    case live
    /// The sign-in is gone (401, or a redirect to the login). The last rows stay, dimmed, with an "as of" time.
    case expired
    /// The network refused the connection: a 403 that is not Campus's own JSON error (an nginx page, off the company private network). Not a sign-out: signing in does not help.
    case blocked
    /// Campus cannot be reached (no network, a server error).
    case unreachable(String)
}

/// A Campus conversation in a Watch column: the layout (`WatchLayout`) keeps a column's session as a string, and a Campus column's string
/// is `campus:<conversation id>`, which no reader session id can be (the reader's ids are letters, digits and dashes).
public enum CampusColumn {
    public static let prefix = "campus:"
    public static func key(_ id: String) -> String { prefix + id }
    public static func isCampus(_ s: String) -> Bool { s.hasPrefix(prefix) }
    public static func id(of key: String) -> String? { isCampus(key) ? String(key.dropFirst(prefix.count)) : nil }
}
