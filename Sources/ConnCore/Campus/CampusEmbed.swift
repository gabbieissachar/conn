// A Campus conversation as the reader's embed page takes it (pmos `setup/transcript-reader/README.md`, "The embed page"): the page draws the turns with the
// reader's own cards and styles, so a Campus conversation looks like a Claude or Codex session. This file is Conn's half of that contract and only builds the
// JSON; the web view that carries it is `CampusEmbedBox` (in the app). The JSON is `CampusTimeline.blocks()` field by field:
//   { "id": <conversation>, "live": <working line, only while it runs>, "blocks": [
//       { "kind": "user",  "id", "text" },
//       { "kind": "reply", "id", "texts": [markdown...], "tools": [{ "tool", "argument", "output", "status", "detail" }], "form"?, "stopped", "streaming" } ] }
// An OPEN question is left out on purpose: the page cannot answer one, so Conn keeps the answer buttons under the page (`CampusTranscriptView`); an answered or
// cancelled one goes in, and the page draws it quiet ("Answered: ...").
import Foundation

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
            out["tools"] = tools.map { t -> [String: Any] in ["tool": t.tool, "argument": t.argument, "output": t.output, "status": status(t.toolStatus), "detail": t.detail] }
            if let f = form?.form, !f.isOpen { out["form"] = formJSON(f) }
            let empty = (out["texts"] as? [String])?.isEmpty ?? true
            if empty && tools.isEmpty && out["form"] == nil && !stopped { return nil }
            return out
        }
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
}
