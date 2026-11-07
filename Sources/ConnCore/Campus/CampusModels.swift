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
    public static func validFolder(_ s: String) -> Bool { s.range(of: "^[A-Za-z0-9._-]{1,128}$", options: .regularExpression) != nil }
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

/// A question the agent put to the person (`form.created`, `GET .../<id>/form`). Campus's question tool: one or more questions, each with options.
public struct CampusForm: Equatable, Sendable, Identifiable {
    public struct Question: Equatable, Sendable {
        public var text: String
        public var options: [String]
        public var pick: String?
        public init(text: String, options: [String], pick: String? = nil) { self.text = text; self.options = options; self.pick = pick }
    }
    public enum Status: Equatable, Sendable { case open, answered(String), cancelled }
    public var id: String
    public var questions: [Question]
    public var status: Status

    public init(id: String, questions: [Question], status: Status = .open) { self.id = id; self.questions = questions; self.status = status }

    public var isOpen: Bool { status == .open }
    /// The row's ask text and tag (C2/C3: a Campus question is an open ask like a Herdr one).
    public var asText: String { questions.map(\.text).joined(separator: " ") }
    public var tag: String { questions.count > 1 ? "Answer sheet · \(questions.count) questions" : "Question · \(questions.first?.options.count ?? 0) options" }

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

    public static func validID(_ s: String) -> Bool { s.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil }

    /// `GET .../<id>/form` answers `{sessionIDs, permissions[], forms[]}`: the open forms.
    public static func parseOpenForms(_ data: Data) -> [CampusForm] {
        guard let root = CampusJSON.parse(data) else { return [] }
        return root["forms"].array.compactMap(parse)
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
    /// The sign-in is gone (401, or 403: Campus answers a person who is not signed in with 403). The last rows stay, dimmed, with an "as of" time.
    case expired
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
