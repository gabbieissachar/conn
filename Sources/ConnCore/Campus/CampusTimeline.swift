// One conversation as the live view and the transcript draw it. A timeline is built from two sources that agree:
//   - the backfill, `GET .../<id>/message?limit=50&order=desc` (opencode v2 messages), read once when a conversation is shown or after a gap;
//   - the stream, `session.*` frames applied as they arrive (the event names are the scout report's, section 3.5).
// Event payload keys are read tolerantly (see CampusJSON): the name of a tool, the delta of a reasoning part and so on are looked up
// under the few names the opencode v2 schema uses; a frame that carries none of them still moves the run forward without a crash.
import Foundation

public struct CampusItem: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case user, step, reasoning, tool, text, form, idle, stopped }
    public enum ToolStatus: Equatable, Sendable { case running, ok, failed, aborted }
    public var id: String
    public var kind: Kind
    public var text: String = ""
    public var streaming = false
    // step
    public var step = 0
    public var detail = ""          // step: "in 2.1k · out 96"; tool: its duration; idle: tokens
    // tool
    public var tool = ""
    public var argument = ""        // the short line: the command, the file, the start of the code
    public var title = ""           // what the call does, in a few words ("campus.search"); empty when Campus gives none
    public var input = ""           // the whole input as text (code, a command, JSON), cut at `CampusToolCall.inputLimit`
    public var inputFormat = Format.text
    public var output = ""          // the result, JSON already indented, cut at `CampusToolCall.outputLimit`
    public var outputFormat = Format.text
    public var toolStatus = ToolStatus.running
    // form
    public var form: CampusForm?
    public init(id: String, kind: Kind) { self.id = id; self.kind = kind }
}

extension CampusItem {
    /// Take what a call or a tool part says about its input: the short line, the whole input, and the title. Never empties a field a frame before it filled.
    mutating func fillInput(from d: CampusJSON) {
        let arg = CampusTimeline.argument(d)
        if !arg.isEmpty { argument = arg }
        let full = CampusToolCall.input(d)
        if !full.text.isEmpty { input = full.text; inputFormat = full.format }
        let t = CampusToolCall.title(d, code: inputFormat == .code ? input : "")
        if !t.isEmpty { title = t }
    }
}

public struct CampusTimeline: Equatable, Sendable {
    public private(set) var items: [CampusItem] = []
    /// The short line the live strip shows ("reading table-a.csv", "thinking", "writing").
    public private(set) var live = ""
    public private(set) var loaded = false
    /// Frames before this time are already in the backfill.
    public private(set) var backfilledAt: Date?
    public var stepCount: Int { items.filter { $0.kind == .step }.count }
    private var counter = 0
    private var open: [String: Int] = [:]    // streaming part key -> index in items

    public init() {}

    public var openForm: CampusForm? { items.last { $0.kind == .form && ($0.form?.isOpen ?? false) }?.form }
    public var lastTokens: String? { items.last { $0.kind == .step && !$0.detail.isEmpty }?.detail }

    private mutating func nextID(_ p: String) -> String { counter += 1; return "\(p)\(counter)" }

    @discardableResult
    private mutating func add(_ item: CampusItem, key: String? = nil) -> Int {
        items.append(item)
        if let k = key { open[k] = items.count - 1 }
        return items.count - 1
    }

    // MARK: the stream

    /// Apply one frame for this conversation. Frames older than the backfill are ignored (the backfill already holds them).
    public mutating func apply(_ f: CampusFrame) {
        if let at = backfilledAt, let c = f.created, c < at { return }
        let d = f.data
        switch f.type {
        case "session.execution.started":
            live = "starting"
        case "session.inbox.enqueued":
            let payload = d["item"]["payload"]
            if d["item"]["type"].string == "user" || payload["text"].string != nil {
                let text = payload["text"].string ?? payload.plainText
                if !text.isEmpty, !isDuplicateUser(text) { var i = CampusItem(id: nextID("u"), kind: .user); i.text = text; add(i) }
            }
        case "session.step.started":
            var i = CampusItem(id: nextID("s"), kind: .step); i.step = stepCount + 1; add(i, key: "step")
        case "session.step.ended":
            if let n = open["step"], items.indices.contains(n) { items[n].detail = Self.tokens(d["tokens"].isNull ? d["usage"]["tokens"] : d["tokens"]) }
            open["step"] = nil
        case "session.reasoning.started":
            live = "thinking"
            var i = CampusItem(id: nextID("r"), kind: .reasoning); i.streaming = true; add(i, key: "reasoning")
        case "session.reasoning.delta":
            append(to: "reasoning", kind: .reasoning, delta: d.first("delta", "text").string ?? "")
        case "session.reasoning.ended":
            if let n = open["reasoning"], items.indices.contains(n) {
                items[n].streaming = false
                if let full = d["text"].string, !full.isEmpty { items[n].text = full }
            }
            open["reasoning"] = nil
        case "session.tool.input.started":
            let name = Self.toolName(d)
            var i = CampusItem(id: nextID("t"), kind: .tool); i.tool = name; add(i, key: "tool:" + Self.toolKey(d))
            live = name.isEmpty ? "working" : "running \(name)"
        case "session.tool.input.ended", "session.tool.called":
            let key = "tool:" + Self.toolKey(d)
            let n = open[key] ?? add({ var i = CampusItem(id: nextID("t"), kind: .tool); i.tool = Self.toolName(d); return i }(), key: key)
            let name = Self.toolName(d)
            if !name.isEmpty { items[n].tool = name }
            items[n].fillInput(from: d)
            live = Self.liveText(tool: items[n].tool, argument: items[n].argument)
        case "session.tool.progress":
            if let n = open["tool:" + Self.toolKey(d)], items.indices.contains(n) {
                if let o = CampusToolCall.output(d) { items[n].output = o.text; items[n].outputFormat = o.format }
                else { let s = d.first("text", "delta").plainText; if !s.isEmpty { items[n].output = Self.clip(s); items[n].outputFormat = .text } }
            }
        case "session.tool.success", "session.tool.failed", "session.tool.error":
            let key = "tool:" + Self.toolKey(d)
            if let n = open[key], items.indices.contains(n) {
                let ok = f.type == "session.tool.success"
                items[n].toolStatus = ok ? .ok : .failed
                items[n].fillInput(from: d)
                if let o = CampusToolCall.output(d) { items[n].output = o.text; items[n].outputFormat = o.format }
                if let ms = CampusToolCall.milliseconds(d) { items[n].detail = Self.duration(ms) }
            }
            open[key] = nil
        case "session.text.started":
            live = "writing"
            var i = CampusItem(id: nextID("x"), kind: .text); i.streaming = true; add(i, key: "text")
        case "session.text.delta":
            if open["text"] == nil { var i = CampusItem(id: nextID("x"), kind: .text); i.streaming = true; add(i, key: "text") }
            append(to: "text", kind: .text, delta: d.first("delta", "text").string ?? "")
        case "session.text.ended":
            if let n = open["text"], items.indices.contains(n) {
                items[n].streaming = false
                if let full = d["text"].string, !full.isEmpty { items[n].text = full }
            }
            open["text"] = nil
        case "form.created":
            if var form = CampusForm.parse(d) {
                if !items.contains(where: { $0.form?.id == form.id }) {
                    form.status = .open
                    var i = CampusItem(id: nextID("f"), kind: .form); i.form = form; add(i)
                }
            }
            live = ""
        case "permission.asked", "permission.created", "permission.requested":
            // A permission ask is a form with one question and its choices as options: it stands in the transcript where the agent stopped.
            if let form = CampusForm.parsePermission(d) { showRequest(form) }
            live = ""
        case "permission.replied", "permission.answered", "permission.resolved", "permission.granted", "permission.rejected", "permission.denied":
            // The person's own answer is already on the item (it is only marked while open); this is for one given in Campus's page or by another client.
            if let id = d.first("permissionID", "permissionId", "requestID", "requestId", "id").string {
                let reply = d.first("reply", "response", "decision").string ?? (f.type == "permission.rejected" || f.type == "permission.denied" ? "reject" : "")
                markForm(id, status: reply.isEmpty ? .resolved : .answered(CampusPermission.label(forValue: reply)))
            }
        case "form.replied", "form.answered":
            if let id = d.first("formID", "formId", "id").string {
                let answer = d.first("answer", "text").plainText
                markForm(id, status: answer.isEmpty ? .resolved : .answered(answer))
            }
        case "form.cancelled", "form.rejected":
            if let id = d.first("formID", "formId", "id").string { markForm(id, status: .cancelled) }
        case "session.idle", "session.execution.ended", "session.execution.finished":
            finishRun(tokens: lastTokens ?? "")
        case "session.interrupted", "session.execution.interrupted", "session.aborted":
            stopRun(stoppedByPerson: true)
        default:
            break
        }
    }

    private mutating func append(to key: String, kind: CampusItem.Kind, delta: String) {
        guard !delta.isEmpty else { return }
        if open[key] == nil { var i = CampusItem(id: nextID("p"), kind: kind); i.streaming = true; add(i, key: key) }
        if let n = open[key], items.indices.contains(n) { items[n].text += delta }
    }

    private func isDuplicateUser(_ text: String) -> Bool {
        if let last = items.last(where: { $0.kind == .user }), last.text == text, items.last?.kind == .user { return true }
        return false
    }

    /// An ask that is still open takes its end (the person's answer, or Campus's). One that already has an end keeps it: an event for an answer Conn sent must not overwrite its words.
    private mutating func markForm(_ id: String, status: CampusForm.Status) {
        for n in items.indices where items[n].form?.id == id && items[n].form?.isOpen == true { items[n].form?.status = status }
    }

    /// An ask Campus says is pending (an event, or `GET .../form`): in the transcript at the end, where the agent stopped, unless it is there already. One that was closed only because
    /// Campus's list did not have it for a moment (`resolveOpenForms`) opens again; one the person answered stays answered.
    @discardableResult
    public mutating func showRequest(_ form: CampusForm) -> Bool {
        if let n = items.firstIndex(where: { $0.form?.id == form.id }) {
            guard items[n].form?.status == .resolved else { return false }
            items[n].form?.status = .open
            return true
        }
        var f = form
        f.status = .open
        var i = CampusItem(id: nextID("f"), kind: .form); i.form = f; add(i)
        return true
    }

    /// Campus no longer lists the asks that are open here (its status says nothing waits, or it waits on another): they were answered elsewhere, so the transcript says so and the
    /// buttons go. Only an open ask is touched.
    @discardableResult
    public mutating func resolveOpenForms(except openID: String? = nil) -> Bool {
        var changed = false
        for n in items.indices where items[n].form?.isOpen == true && items[n].form?.id != openID { items[n].form?.status = .resolved; changed = true }
        return changed
    }

    /// The agent finished its turn: nothing streams any more, and the end of the run is marked once.
    public mutating func finishRun(tokens: String) {
        for n in items.indices where items[n].streaming { items[n].streaming = false }
        for n in items.indices where items[n].kind == .tool && items[n].toolStatus == .running { items[n].toolStatus = .ok }
        open = [:]
        live = ""
        if items.last?.kind != .idle && items.contains(where: { $0.kind != .user }) {
            var i = CampusItem(id: nextID("i"), kind: .idle); i.detail = tokens; add(i)
        }
    }

    /// The run was interrupted (by Stop): running tools show as stopped.
    public mutating func stopRun(stoppedByPerson: Bool) {
        for n in items.indices where items[n].kind == .tool && items[n].toolStatus == .running { items[n].toolStatus = .aborted }
        for n in items.indices where items[n].streaming { items[n].streaming = false }
        open = [:]
        live = ""
        if items.last?.kind != .stopped { add(CampusItem(id: nextID("z"), kind: .stopped)) }
    }

    /// The person's own message, shown at once when a send is delivered (before the stream echoes it back, which is then not shown twice).
    public mutating func appendUser(_ text: String) {
        guard !isDuplicateUser(text) else { return }
        var i = CampusItem(id: nextID("u"), kind: .user); i.text = text; add(i)
    }

    /// The person answered a question (the answers go in as a plain message of the picks, shown on the form itself).
    public mutating func answerForm(_ id: String, text: String) { markForm(id, status: .answered(text)) }

    // MARK: the backfill

    /// Replace the timeline with the messages Campus holds (oldest first), as of `fetchedAt`: later frames are applied on top, earlier ones are dropped.
    public mutating func backfill(_ messages: [CampusItem], fetchedAt: Date) {
        let keepForms = items.filter { $0.kind == .form && !($0.form?.isOpen ?? true) }
        items = messages
        for k in keepForms where !items.contains(where: { $0.form?.id == k.form?.id }) { items.append(k) }
        counter += items.count
        open = [:]
        loaded = true
        backfilledAt = fetchedAt.addingTimeInterval(-1)
        if openForm == nil, let last = items.last, last.kind == .idle { live = "" }
    }

    // MARK: field readers

    static func toolName(_ d: CampusJSON) -> String { d.first("tool", "name", "toolName").string ?? "" }
    static func toolKey(_ d: CampusJSON) -> String { d.first("callID", "callId", "toolCallID", "toolCallId", "partID", "id").string ?? "current" }
    static func argument(_ d: CampusJSON) -> String {
        let input = CampusToolCall.inputValue(d)
        if let s = input.string { return clip(s, 120) }
        guard let o = input.object else { return "" }
        for k in ["command", "filePath", "path", "pattern", "url", "query", "description", "text"] { if let s = o[k]?.string, !s.isEmpty { return clip(s, 120) } }
        return o.keys.sorted().first.map { clip(o[$0]?.plainText ?? "", 120) } ?? ""
    }
    static func liveText(tool: String, argument: String) -> String {
        let leaf = argument.split(separator: "/").last.map(String.init) ?? argument
        switch tool { case "read": return leaf.isEmpty ? "reading" : "reading \(leaf)"
        case "write", "edit": return leaf.isEmpty ? "writing" : "writing \(leaf)"
        case "shell", "bash": return leaf.isEmpty ? "running a command" : "running \(clip(argument, 40))"
        default: return tool.isEmpty ? "working" : "running \(tool)" }
    }
    static func tokens(_ t: CampusJSON) -> String {
        guard let i = t["input"].number else { return "" }
        let o = t["output"].number ?? 0
        return "in \(compact(i)) · out \(compact(o))"
    }
    static func compact(_ n: Double) -> String { n >= 1000 ? String(format: "%.1fk", n / 1000) : String(Int(n)) }
    static func duration(_ ms: Double) -> String { ms < 1000 ? "\(Int(ms)) ms" : String(format: "%.1fs", ms / 1000) }
    static func clip(_ s: String, _ n: Int = 400) -> String { s.count > n ? String(s.prefix(n)) + "…" : s }

    /// The messages of `GET .../<id>/message?limit=50&order=desc` (`{data:[message...], cursor}`), as items oldest first. Message kinds:
    /// `user`, `assistant` (with `content[]` of text, reasoning and tool parts, plus `finish` and `tokens`), `system`, `agent-switched`,
    /// `model-switched`, `idle` (with `outcome`). The ones that carry nothing to read are skipped.
    public static func items(fromMessages data: Data) -> [CampusItem]? {
        guard let root = CampusJSON.parse(data), root.object != nil else { return nil }
        let messages = Array(root["data"].array.reversed())
        var out: [CampusItem] = []
        var n = 0
        func id(_ m: CampusJSON, _ p: String) -> String { n += 1; return (m["id"].string ?? p) + "#\(n)" }
        var step = 0
        for m in messages {
            switch m["type"].string ?? m["role"].string ?? "" {
            case "user":
                let text = m.first("text", "content", "parts").plainText
                if !text.isEmpty { var i = CampusItem(id: id(m, "u"), kind: .user); i.text = text; out.append(i) }
            case "assistant":
                step += 1
                var s = CampusItem(id: id(m, "s"), kind: .step); s.step = step; s.detail = tokens(m["tokens"]); out.append(s)
                for part in m["content"].array {
                    switch part["type"].string ?? "" {
                    case "text":
                        let t = part["text"].plainText
                        if !t.isEmpty { var i = CampusItem(id: id(m, "x"), kind: .text); i.text = t; out.append(i) }
                    case "reasoning":
                        let t = part["text"].plainText
                        if !t.isEmpty { var i = CampusItem(id: id(m, "r"), kind: .reasoning); i.text = t; out.append(i) }
                    case "tool", "tool-call", "tool-invocation":
                        var i = CampusItem(id: id(m, "t"), kind: .tool)
                        i.tool = toolName(part); i.fillInput(from: part)
                        if let o = CampusToolCall.output(part) { i.output = o.text; i.outputFormat = o.format }
                        let st = part.first("status", "state").string ?? (part["state"]["status"].string ?? "")
                        i.toolStatus = st == "error" || st == "failed" ? .failed : (st == "running" || st == "pending" ? .running : .ok)
                        if let ms = CampusToolCall.milliseconds(part) { i.detail = duration(ms) }
                        out.append(i)
                    case "form", "question":
                        if let f = CampusForm.parse(part) { var i = CampusItem(id: id(m, "f"), kind: .form); i.form = f; out.append(i) }
                    case "permission", "permission-request", "permission-asked":
                        if var f = CampusForm.parsePermission(part) {
                            // A part that carries its reply is a record of an answer; one without is still waiting (the store closes it when Campus no longer lists it).
                            if let reply = part.first("reply", "response", "decision").string { f.status = .answered(CampusPermission.label(forValue: reply)) }
                            var i = CampusItem(id: id(m, "f"), kind: .form); i.form = f; out.append(i)
                        }
                    default: break
                    }
                }
            case "idle":
                var i = CampusItem(id: id(m, "i"), kind: .idle); i.detail = out.last(where: { $0.kind == .step })?.detail ?? ""; out.append(i)
            default: break
            }
        }
        return out
    }
}

/// The transcript's shape (the reader's way of reading): the person's messages, and between them one reply that gathers the agent's tool steps,
/// its text, and a question it waits on. Reasoning, steps and the end marker are the live view's, not the transcript's.
public enum CampusBlock: Identifiable, Equatable, Sendable {
    case user(CampusItem)
    case reply(id: String, tools: [CampusItem], texts: [CampusItem], form: CampusItem?, stopped: Bool)

    public var id: String {
        switch self { case .user(let i): return i.id; case .reply(let id, _, _, _, _): return id }
    }
}

extension CampusTimeline {
    public func blocks() -> [CampusBlock] {
        var out: [CampusBlock] = []
        var tools: [CampusItem] = [], texts: [CampusItem] = [], form: CampusItem?, stopped = false
        var first: String?
        func flush() {
            if first != nil { out.append(.reply(id: "r-" + (first ?? ""), tools: tools, texts: texts, form: form, stopped: stopped)) }
            tools = []; texts = []; form = nil; stopped = false; first = nil
        }
        for i in items {
            switch i.kind {
            case .user: flush(); out.append(.user(i))
            case .tool: first = first ?? i.id; tools.append(i)
            case .text: first = first ?? i.id; texts.append(i)
            case .form: first = first ?? i.id; form = i
            case .stopped: first = first ?? i.id; stopped = true
            case .step, .reasoning, .idle: break
            }
        }
        flush()
        return out
    }

    /// The transcript as plain text, for Copy.
    public func plainText() -> String {
        blocks().map { b -> String in
            switch b {
            case .user(let i): return "You: " + i.text
            case .reply(_, let tools, let texts, let form, let stopped):
                var lines: [String] = []
                if !tools.isEmpty { lines.append("(\(tools.count) tool step\(tools.count == 1 ? "" : "s"))") }
                lines += texts.map(\.text)
                if let f = form?.form { lines.append("Campus asks: " + f.asText) }
                if stopped { lines.append("(stopped)") }
                return "Campus: " + lines.joined(separator: "\n")
            }
        }.joined(separator: "\n\n")
    }
}
