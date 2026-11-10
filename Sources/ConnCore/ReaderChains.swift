import Foundation

// Which session ids are one conversation. A conversation keeps one pane across `/clear`, and every `/clear` starts a new session id, so one conversation has a chain of ids and Herdr's
// `agent_session` names only the newest. A Watch column holds the id it was opened with, which can be an older one in the chain (a setup remembered from before a `/clear`, a star, a link);
// matched to Herdr's agent by equal ids it finds nobody, and the column's header said "no agent" for a session that is running and working.
//
// The reader says which ids belong together in its glance feed (`out/glance.json`, README "The glance feed": `conversations[].ids`, "every session id of the conversation, oldest first (Herdr's
// `agent_session` may name any of them)"). Conn reads that file as it reads `stars.json`: no HTTP, no token; a missing or unreadable file means no chains, and ids then match as before.

public struct ReaderChains: Equatable, Sendable {
    /// Chain number by whole id, and the ids grouped by their first eight characters (the reader writes its addresses with eight, so a short id is looked up among those).
    private var byID: [String: Int] = [:]
    private var byPrefix: [String: [(id: String, chain: Int)]] = [:]
    public private(set) var count = 0

    public init() {}

    public init(chains: [[String]]) {
        for (n, ids) in chains.enumerated() {
            for id in ids where id.count >= 8 { byID[id] = n; byPrefix[String(id.prefix(8)), default: []].append((id, n)) }
        }
        count = chains.count
    }

    public static func == (a: ReaderChains, b: ReaderChains) -> Bool { a.byID == b.byID }

    /// The chain an id belongs to: the id itself, or an address that is the first characters (at least eight) of exactly one listed id. Nil when none, or when the short address is
    /// the start of ids of two different chains (it names no conversation then).
    private func chain(of s: String) -> Int? {
        if let n = byID[s] { return n }
        guard s.count >= 8 else { return nil }
        let hits = Set((byPrefix[String(s.prefix(8))] ?? []).filter { $0.id.hasPrefix(s) }.map(\.chain))
        return hits.count == 1 ? hits.first : nil
    }

    /// The chains in a glance feed (`{ "conversations": [ { "id": ..., "ids": [...] } ] }`): the `ids`, with `id` itself when it is not among them. Anything else gives no chains.
    public static func parse(_ data: Data) -> ReaderChains {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let convs = root["conversations"] as? [[String: Any]] else { return ReaderChains() }
        var chains: [[String]] = []
        for c in convs {
            var ids = (c["ids"] as? [String]) ?? []
            if let id = c["id"] as? String, !ids.contains(id) { ids.append(id) }
            if ids.count > 1 { chains.append(ids) }
        }
        return ReaderChains(chains: chains)
    }

    /// The file a launch reads: `CONN_READER_GLANCE`, else the reader's own place for it (beside `pane-labels.json`).
    public static func defaultFile(env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> URL {
        if let f = env["CONN_READER_GLANCE"], !f.isEmpty { return URL(fileURLWithPath: f) }
        return URL(fileURLWithPath: home + "/workspace/pmos/setup/transcript-reader/out/glance.json")
    }

    /// The same conversation: the same session (`WatchLayout.same`: equal ids, or one is the first characters of the other), or two ids of one chain.
    public func same(_ a: String, _ b: String) -> Bool {
        if WatchLayout.same(a, b) { return true }
        guard let x = chain(of: a), let y = chain(of: b) else { return false }
        return x == y
    }
}
