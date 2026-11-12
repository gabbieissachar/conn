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

/// A permission the agent asks for (`permission.asked`, one item of `permissions[]` in `GET .../<id>/requests`, or of `data[]` in `GET .../<id>/permission`): run a command, write a
/// file, reach a path. It is a grant, not a chat answer, so it is read plainly and answered only by a person's click. The real shape (seen on a live thread, ROADMAP N38) is
/// `{id, sessionID, action: "shell", resources: [the command's parts], save: [the patterns "always" would keep], source: {type: "tool", messageID, id}, message: Campus's reason}`;
/// opencode's older `permission` and `patterns[]` are read too. The reply values are still opencode's (`once`, `always`, `reject`): nobody has answered a real one yet, so the
/// first real answer is the person's (ROADMAP N38).
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
    /// The choices the card offers right now: `held` unless something stops a grant (the command is not confirmed, or it is too long to read on a card), then Reject only.
    public var decisions: [Decision]
    /// The choices the request itself allows (without a standing grant), kept back until `decisions` may offer them.
    public var held: [Decision]
    /// Why Campus asks, in its words (`message`): "This changes a file the team's Team Instance takes in as trusted ...". Shown under the ask, never part of what is granted.
    public var reason: String
    /// The tool call this ask holds up (`source: {type: "tool", messageID, id}`). `resources` is Campus's own split of that call's command into parts and is not what runs, so an ask
    /// that comes from a tool call is granted only against the call itself: Conn reads the call (`state.input.command`) and shows that.
    public var source: Source?
    /// What the tool call will really run, read from the call itself (`command`), once Conn has found it.
    public var command: String?

    public struct Source: Equatable, Sendable {
        public var type: String
        public var messageID: String?
        public var toolID: String?
        public init(type: String, messageID: String? = nil, toolID: String? = nil) { self.type = type; self.messageID = messageID; self.toolID = toolID }
        public var isTool: Bool { type == "tool" }
    }

    public init(name: String, patterns: [String] = [], decisions: [Decision] = CampusPermission.defaultDecisions, reason: String = "", source: Source? = nil, command: String? = nil) {
        self.name = name; self.patterns = patterns; self.decisions = decisions; self.held = decisions; self.reason = reason; self.source = source; self.command = command
        refreshDecisions()
    }

    /// Whether this ask comes from a tool call whose real command Conn has not read: only Reject is offered until it has.
    public var needsConfirmation: Bool { source?.isTool == true && command == nil }

    mutating func refreshDecisions() { decisions = (needsConfirmation || tooLongToApprove) ? [Self.reject] : held }

    /// The card's note while only Reject is offered, or "".
    public var notice: String {
        if needsConfirmation { return "Conn could not read the command this will run, so only Reject is offered. Open the thread in Campus to allow it." }
        if tooLongToApprove { return "Too long to read on a card, so only Reject is offered. Open the thread in Campus to allow it." }
        return ""
    }

    /// One tool call found in a thread's messages: what it will run (`state.input.command`, else its whole input as text).
    public struct ToolCall: Equatable, Sendable {
        public var messageID: String
        public var toolID: String
        public var command: String
        public init(messageID: String, toolID: String, command: String) { self.messageID = messageID; self.toolID = toolID; self.command = command }
    }

    /// The tool calls of `GET .../message` (`{data: [{id, content: [{type: "tool", id, name, state: {input: {command}}}]}]}`) that have an input to show.
    public static func toolCommands(inMessages data: Data) -> [ToolCall]? {
        guard let root = CampusJSON.parse(data) else { return nil }
        var out: [ToolCall] = []
        for m in root["data"].array {
            guard let mid = m["id"].string else { continue }
            for part in m["content"].array where part["type"].string == "tool" {
                guard let tid = part["id"].string else { continue }
                // Never the reader's clipped copy of the input: a grant is read whole (the card's own length limit decides what may be allowed).
                let input = CampusToolCall.inputValue(part)
                let command = input["command"].string ?? input.string ?? (input.isNull ? "" : CampusJSONText.pretty(input))
                if !command.isEmpty { out.append(ToolCall(messageID: mid, toolID: tid, command: command)) }
            }
        }
        return out
    }

    /// The same ask with the command the tool call really runs: what the card then shows and what a grant covers.
    func confirmed(command c: String) -> CampusPermission {
        var p = self
        p.command = c
        p.refreshDecisions()
        return p
    }

    /// The most characters of Campus's reason the card shows (it explains the ask; what is granted is shown whole above it and never cut).
    public static let reasonLimit = 400

    /// Campus's reason as the card shows it: the same allowlist as the ask, one line, cut at `reasonLimit` with an ellipsis.
    public var reasonShown: String {
        let t = Self.visible(reason).trimmingCharacters(in: .whitespaces)
        return t.count > Self.reasonLimit ? String(t.prefix(Self.reasonLimit)) + "…" : t
    }

    public static let allowOnce = Decision(label: "Allow once", value: "once")
    public static let reject = Decision(label: "Reject", value: "reject")
    /// What Conn offers when the request lists no choices of its own: this one time, or not at all.
    public static let defaultDecisions = [allowOnce, reject]
    /// Whether a standing grant ("always allow") is offered as a button. Off: a wrong click must not turn into a permission that outlasts the thread (README, decision P1).
    public static let offersStandingGrant = false
    /// The most characters, as shown on the card, that Conn will let a person allow. The card always shows every pattern in full (a grant must be read whole, so nothing is cut), but past
    /// this length it offers only Reject and the way to open the thread in Campus: nobody reads that much on a card, and a tail they did not read is not consent.
    public static let approvableLimit = 2_000

    /// What the card shows for Campus's text: printable ASCII and the precomposed Latin letters of Latin-1 and Latin Extended-A (U+00C0 to U+017F, so accented names read as they are; not the dotless i, kra, long s, and nothing from U+0180 up, where letters such as ɑ, ǀ and ǃ pass for ASCII) pass; every other character is a visible token,
    /// `⏎` for a line break, `⇥` for a tab, `<U+202E>` for anything else (other scripts, combining marks, spaces that are not a plain space, controls, bidi overrides, zero-width marks).
    /// An allowlist, so a character nobody thought of is shown as a token and cannot hide or fake part of a command.
    static func visible(_ s: String) -> String {
        // Letters that can pass for an ASCII one are shown as tokens even inside the range: dotless i, kra, n with a leading apostrophe, long s.
        let lookAlikes: Set<UInt32> = [0x131, 0x138, 0x149, 0x17F]
        var out = ""
        for u in s.unicodeScalars {
            let v = u.value
            let latinLetter = ((0xC0...0x17F).contains(v) && v != 0xD7 && v != 0xF7 && !lookAlikes.contains(v)) && [.uppercaseLetter, .lowercaseLetter].contains(u.properties.generalCategory)
            if (0x20...0x7E).contains(v) || latinLetter { out.unicodeScalars.append(u); continue }
            switch u {
            case "\n", "\r", "\u{2028}", "\u{2029}": out += "⏎"
            case "\t": out += "⇥"
            default: out += "<U+" + String(format: "%04X", v) + ">"
            }
        }
        return out
    }

    /// Too much to read on a card: only Reject is offered. Measured on the exact text the card shows (the kind and the patterns, escapes counted as shown), in Unicode scalars.
    public var tooLongToApprove: Bool { question.unicodeScalars.count > Self.approvableLimit }

    /// The wire value of the choice the button of that label stands for.
    public func value(for label: String) -> String? { decisions.first { $0.label == label }?.value }

    /// `Allow bash: curl https://example.test`: the one line the row, the card and the page's record show.
    public var question: String {
        // The call's own command when it has been read; otherwise Campus's list of resources.
        let joined = Self.visible(command ?? patterns.joined(separator: ", "))
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
        let name = p.first("action", "permission", "type", "kind", "title", "name").string ?? ""
        // `resources` is Campus's (the command's parts, or the paths); `patterns` is opencode's. `save` is what an always-allow would keep, which Conn never offers.
        // `resources` counts only when it holds at least one string; an empty or odd one falls through to `patterns`.
        var patterns = p["resources"].array.compactMap(\.string).filter { !$0.isEmpty }
        if patterns.isEmpty { patterns = p["patterns"].array.compactMap(\.string).filter { !$0.isEmpty } }
        if patterns.isEmpty, let one = p.first("pattern", "path", "command", "description").string, !one.isEmpty { patterns = [one] }
        guard !name.isEmpty || !patterns.isEmpty else { return nil }
        var source: CampusPermission.Source?
        if let st = p["source"].object != nil ? p["source"]["type"].string : nil { source = .init(type: st, messageID: p["source"].first("messageID", "messageId").string, toolID: p["source"]["id"].string) }
        // Too long to read on a card, or from a tool call whose command is not read yet: nothing that grants is offered (what is asked is still shown in full).
        let perm = CampusPermission(name: name.isEmpty ? "a permission" : name, patterns: patterns, decisions: CampusPermission.decisions(in: p), reason: p["message"].string ?? "", source: source)
        return CampusForm(permission: perm, id: id)
    }

    /// An ask built from its permission: the question line and the options are what the permission shows and offers.
    init(permission perm: CampusPermission, id: String, status: Status = .open) {
        self.init(id: id, questions: [Question(text: perm.question, options: perm.decisions.map(\.label))], status: status, permission: perm)
    }

    /// The ask against the command its tool call runs, when that call (`source.messageID` and `source.id`) is among `calls`; the ask as it was when it is not.
    public func confirmed(calls: [CampusPermission.ToolCall]) -> CampusForm {
        guard let p = permission, p.needsConfirmation, let src = p.source, let tool = src.toolID,
              let call = calls.first(where: { $0.toolID == tool && (src.messageID == nil || $0.messageID == src.messageID) }) else { return self }
        return confirmed(command: call.command)
    }

    /// This permission ask against the command its tool call really runs.
    public func confirmed(command: String) -> CampusForm {
        guard let p = permission else { return self }
        return CampusForm(permission: p.confirmed(command: command), id: id, status: status)
    }

    public static func validID(_ s: String) -> Bool { s.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil }

    /// The open forms (questions only) in `GET .../<id>/form`, which answers `{data: [forms]}` (seen live: `{"data":[]}` while a permission waited), or in `GET .../<id>/requests`,
    /// which answers `{sessionIDs, permissions[], forms[]}`.
    public static func parseOpenForms(_ data: Data) -> [CampusForm] {
        guard let root = CampusJSON.parse(data) else { return [] }
        return (root["forms"].array.isEmpty ? root["data"].array : root["forms"].array).compactMap(parse)
    }

    /// Everything the agent waits on in that answer, a permission first (it holds up a tool; a question comes when the run has stopped). `GET .../requests` answers both lists
    /// (`{sessionIDs, permissions[], forms[]}`), `GET .../form` the forms in `data`. `permissionsOnly` reads an answer that is the permissions themselves: `GET .../permission` answers
    /// `{data: [...]}` (seen live), and `{permissions: [...]}` or a bare list are read too.
    public static func parseOpenRequests(_ data: Data, permissionsOnly: Bool = false) -> [CampusForm] {
        guard let root = CampusJSON.parse(data) else { return [] }
        var perms = root["permissions"].array
        if perms.isEmpty && permissionsOnly { perms = root["data"].array.isEmpty ? root.array : root["data"].array }
        return perms.compactMap(parsePermission) + (permissionsOnly ? [] : parseOpenForms(data))
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
