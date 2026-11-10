// A Campus conversation as the reader's embed page takes it (pmos `setup/transcript-reader/README.md`, "The embed page"): the page draws the turns with the
// reader's own cards and styles, so a Campus conversation looks like a Claude or Codex session. This file is Conn's half of that contract and only builds the
// JSON; the web view that carries it is `CampusEmbedBox` (in the app). The JSON is `CampusTimeline.blocks()` field by field:
//   { "id": <conversation>, "live": <working line, only while it runs>, "blocks": [
//       { "kind": "user",  "id", "text" },
//       { "kind": "reply", "id", "texts": [markdown...], "tools": [{ "tool", "argument", "output", "status", "detail", "title"?, "input"?, "inputFormat"?, "outputFormat"? }], "form"?, "stopped", "streaming" } ] }
// An OPEN question is left out on purpose: the page cannot answer one, so Conn keeps the answer buttons under the page (`CampusTranscriptView`); an answered or
// cancelled one goes in, and the page draws it quiet ("Answered: ...").
import Foundation

/// A message the page's own composer hands the host once its Undo window has ended (`{ "type": "send", ... }`, README "The embed page", "The composer").
public struct ReaderSend: Equatable, Sendable {
    public let id: String
    /// The conversation the page was showing, or empty.
    public let conversation: String
    public let text: String
    /// How many comments the text carries (information only).
    public let comments: Int
    public init(id: String, conversation: String, text: String, comments: Int) { self.id = id; self.conversation = conversation; self.text = text; self.comments = comments }
}

public enum CampusEmbed {
    /// The page's entry point and its handshake (README "The embed page"): the page posts `ready` to the handler named `readerEmbed` and answers `version`.
    public static let handlerName = "readerEmbed"
    public static let version = 1
    /// Where the live reader serves the page (a navigation; the page itself asks nothing of the server).
    public static let servedAddress = "http://localhost:8768/setup/transcript-reader/out/live/embed.html"

    /// The conversation as the JSON text `window.readerEmbed.set` takes. `working` adds the strip at the foot ("starting" while Campus has said nothing yet).
    public static func json(id: String, timeline: CampusTimeline, working: Bool) -> String {
        var root: [String: Any] = ["id": id, "blocks": timeline.blocks().compactMap(block)]
        if working { root["live"] = timeline.live.isEmpty ? "starting" : timeline.live }
        guard JSONSerialization.isValidJSONObject(root), let data = try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) else {
            return "{\"id\":\"\",\"blocks\":[]}"
        }
        return text
    }

    /// One block, or nil when the page would skip it anyway (an empty message, a reply with nothing in it).
    static func block(_ b: CampusBlock) -> [String: Any]? {
        switch b {
        case .user(let i):
            guard !i.text.isEmpty else { return nil }
            return ["kind": "user", "id": i.id, "text": i.text]
        case .reply(let id, let tools, let texts, let form, let stopped):
            var out: [String: Any] = ["kind": "reply", "id": id, "texts": texts.map(\.text).filter { !$0.isEmpty }, "stopped": stopped,
                                      "streaming": texts.contains { $0.streaming }]
            out["tools"] = tools.map(toolJSON)
            if let f = form?.form, !f.isOpen { out["form"] = formJSON(f) }
            let empty = (out["texts"] as? [String])?.isEmpty ?? true
            if empty && tools.isEmpty && out["form"] == nil && !stopped { return nil }
            return out
        }
    }

    /// One tool step. `argument` is the call's input when that is one piece of text (code or a command: the page shows it in the step's sheet, today cut at 600 characters), else
    /// the short line. The fields after `detail` are Conn's additions for a call with something to read (a Campus code call: its title, its whole input, its result as JSON):
    /// each is left out when empty, so a tool that has none sends what it always did.
    static func toolJSON(_ t: CampusItem) -> [String: Any] {
        var o: [String: Any] = ["tool": t.tool, "argument": !t.input.isEmpty && t.inputFormat != .json ? t.input : t.argument, "output": t.output, "status": status(t.toolStatus), "detail": t.detail]
        if !t.title.isEmpty { o["title"] = t.title }
        if !t.input.isEmpty { o["input"] = t.input; o["inputFormat"] = t.inputFormat.rawValue }
        if !t.output.isEmpty { o["outputFormat"] = t.outputFormat.rawValue }
        return o
    }

    static func status(_ s: CampusItem.ToolStatus) -> String {
        switch s { case .running: return "running"; case .ok: return "ok"; case .failed: return "failed"; case .aborted: return "aborted" }
    }

    static func formJSON(_ f: CampusForm) -> [String: Any] {
        var out: [String: Any] = ["id": f.id, "questions": f.questions.map { q -> [String: Any] in
            var o: [String: Any] = ["text": q.text, "options": q.options]
            if let p = q.pick { o["pick"] = p }
            return o
        }]
        switch f.status {
        case .open: out["status"] = "open"
        case .answered(let t): out["status"] = "answered"; out["answer"] = t
        case .cancelled: out["status"] = "cancelled"
        }
        return out
    }

    // MARK: the page's composer (opt-in): select-to-ask, comments, the batch, Send, Undo, Now

    /// The longest message Conn types for the page (the page itself keeps to 4,000 characters; this is the host's own limit on what any page may hand it).
    public static let maxSendLength = 8_000

    /// A `send` message from the page, or nil when it is not one Conn will act on (no id, no text, an id that is not a plain token, a text over the limit).
    public static func parseSend(_ body: [String: Any]) -> ReaderSend? {
        guard body["type"] as? String == "send", let id = body["id"] as? String, !id.isEmpty, id.count <= 80,
              id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }),
              let text = body["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= maxSendLength else { return nil }
        return ReaderSend(id: id, conversation: body["conversation"] as? String ?? "", text: text, comments: body["comments"] as? Int ?? 0)
    }

    /// What `readerEmbed.composer(config)` takes: the name shown in the box, whether Send is on, and the sentence shown while it is off.
    public static func composerConfig(name: String, send: Bool, reason: String) -> String {
        json(["name": name, "send": send, "reason": send ? "" : reason])
    }

    /// What `readerEmbed.sent(result)` takes: the answer to one `send`.
    public static func sentResult(id: String, error: String?) -> String {
        var o: [String: Any] = ["id": id, "ok": error == nil]
        if let e = error { o["error"] = e }
        return json(o)
    }

    /// Why the page's Send is off, in the words the page shows, or nil when it is on (Campus writes are on and the link is live).
    public static func sendReason(writesEnabled: Bool, link: CampusLink) -> String? {
        if !writesEnabled { return "Campus writes are off. Turn them on in the status bar." }
        switch link {
        case .live: return nil
        case .expired: return "Signed out of Campus. Sign in to send."
        case .blocked: return "Campus refused the connection. Check Zscaler, then try again."
        default: return "Campus is not reachable."
        }
    }

    private static func json(_ o: [String: Any]) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), let t = String(data: d, encoding: .utf8) else { return "{}" }
        return t
    }
}
