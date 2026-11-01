// Value types decoded from Herdr's `session.snapshot` response (protocol 22, Herdr 0.9.5).
// Decoding is dictionary-based on purpose: the Herdr docs ask clients to ignore unknown fields.
import Foundation

public enum AgentState: String, CaseIterable, Sendable {
    case blocked, done, working, idle, unknown

    public init(raw: String) { self = AgentState(rawValue: raw) ?? .unknown }

    /// Sort rank for the agents list: things that wait on the captain come first.
    public var rank: Int {
        switch self {
        case .blocked: return 0
        case .done: return 1
        case .working: return 2
        case .idle: return 3
        case .unknown: return 4
        }
    }

    public var label: String {
        switch self {
        case .blocked: return "needs you"
        case .done: return "done"
        case .working: return "working"
        case .idle: return "idle"
        case .unknown: return "unknown"
        }
    }

    /// Waiting on the captain: a question or permission prompt, or a finished task nobody has looked at.
    public var waitsOnCaptain: Bool { self == .blocked || self == .done }
}

public struct Workspace: Identifiable, Equatable, Sendable {
    public var id: String
    public var label: String
    public var number: Int
    public var state: AgentState
    public var tabCount: Int
    public var paneCount: Int
    public init(id: String, label: String, number: Int, state: AgentState, tabCount: Int, paneCount: Int) {
        self.id = id; self.label = label; self.number = number; self.state = state; self.tabCount = tabCount; self.paneCount = paneCount
    }
}

public struct Tab: Identifiable, Equatable, Sendable {
    public var id: String
    public var workspaceID: String
    public var label: String
    public var number: Int
    public var state: AgentState
    public var paneCount: Int
    public init(id: String, workspaceID: String, label: String, number: Int, state: AgentState, paneCount: Int) {
        self.id = id; self.workspaceID = workspaceID; self.label = label; self.number = number; self.state = state; self.paneCount = paneCount
    }
}

public struct Agent: Identifiable, Equatable, Sendable {
    public var id: String            // pane id, for example "w1:p3"
    public var name: String
    public var harness: String       // "claude", "codex", ...
    public var state: AgentState
    public var workspaceID: String
    public var tabID: String
    public var sessionID: String?    // the harness session id Herdr's integration reported (joins a pane to a transcript)
    public var cwd: String
    public var cwdShort: String { (cwd as NSString).lastPathComponent }
    public init(id: String, name: String, harness: String, state: AgentState, workspaceID: String, tabID: String, sessionID: String?, cwd: String) {
        self.id = id; self.name = name; self.harness = harness; self.state = state; self.workspaceID = workspaceID
        self.tabID = tabID; self.sessionID = sessionID; self.cwd = cwd
    }
}

public struct PaneSize: Equatable, Sendable {
    public var cols: Int
    public var rows: Int
    public init(cols: Int, rows: Int) { self.cols = cols; self.rows = rows }
}

public struct Snapshot: Equatable, Sendable {
    public var paneSizes: [String: PaneSize] = [:]
    public var workspaces: [Workspace] = []
    public var tabs: [Tab] = []
    public var agents: [Agent] = []
    public var paneIDs: [String] = []
    public var focusedPaneID: String?

    public static let empty = Snapshot()

    public init() {}

    /// `root` is the decoded JSON of a full response line: {"id":..., "result": {"type":"session_snapshot","snapshot":{...}}}
    public init?(response root: [String: Any]) {
        guard let result = root["result"] as? [String: Any],
              let snap = result["snapshot"] as? [String: Any] else { return nil }
        let panes = (snap["panes"] as? [[String: Any]]) ?? []
        var paneByID: [String: [String: Any]] = [:]
        for p in panes { if let id = p["pane_id"] as? String { paneByID[id] = p } }
        paneIDs = panes.compactMap { $0["pane_id"] as? String }
        focusedPaneID = snap["focused_pane_id"] as? String
        // The size Herdr's own client gave each pane. An observer cannot reflow it, so Helm asks for exactly this.
        for l in (snap["layouts"] as? [[String: Any]]) ?? [] {
            for lp in (l["panes"] as? [[String: Any]]) ?? [] {
                if let id = lp["pane_id"] as? String, let r = lp["rect"] as? [String: Any],
                   let w = r["width"] as? Int, let h = r["height"] as? Int { paneSizes[id] = PaneSize(cols: w, rows: h) }
            }
        }
        workspaces = ((snap["workspaces"] as? [[String: Any]]) ?? []).compactMap { w in
            guard let id = w["workspace_id"] as? String else { return nil }
            return Workspace(id: id, label: (w["label"] as? String) ?? id, number: (w["number"] as? Int) ?? 0,
                             state: AgentState(raw: (w["agent_status"] as? String) ?? ""),
                             tabCount: (w["tab_count"] as? Int) ?? 0, paneCount: (w["pane_count"] as? Int) ?? 0)
        }
        tabs = ((snap["tabs"] as? [[String: Any]]) ?? []).compactMap { t in
            guard let id = t["tab_id"] as? String, let ws = t["workspace_id"] as? String else { return nil }
            return Tab(id: id, workspaceID: ws, label: (t["label"] as? String) ?? id, number: (t["number"] as? Int) ?? 0,
                       state: AgentState(raw: (t["agent_status"] as? String) ?? ""), paneCount: (t["pane_count"] as? Int) ?? 1)
        }
        let tabLabel = Dictionary(tabs.map { ($0.id, $0.label) }, uniquingKeysWith: { a, _ in a })
        agents = ((snap["agents"] as? [[String: Any]]) ?? []).compactMap { a in
            guard let pid = a["pane_id"] as? String else { return nil }
            let pane = paneByID[pid] ?? [:]
            let paneLabel = (pane["label"] as? String) ?? ""
            let tabID = (a["tab_id"] as? String) ?? ""
            let name = !paneLabel.isEmpty ? paneLabel : (tabLabel[tabID] ?? ((a["terminal_title_stripped"] as? String) ?? pid))
            let session = (a["agent_session"] as? [String: Any])
            let sid = (session?["kind"] as? String) == "id" ? session?["value"] as? String : nil
            return Agent(id: pid, name: name, harness: (a["agent"] as? String) ?? "agent",
                         state: AgentState(raw: (a["agent_status"] as? String) ?? ""),
                         workspaceID: (a["workspace_id"] as? String) ?? "", tabID: tabID, sessionID: sid,
                         cwd: (a["cwd"] as? String) ?? "")
        }
    }

    public func workspace(_ id: String?) -> Workspace? { workspaces.first { $0.id == id } }
    public func agent(_ paneID: String?) -> Agent? { agents.first { $0.id == paneID } }
    public func tabs(in workspaceID: String?) -> [Tab] { tabs.filter { $0.workspaceID == workspaceID } }
    public func agents(in workspaceID: String?) -> [Agent] { agents.filter { $0.workspaceID == workspaceID } }
    public func agent(inTab tabID: String) -> Agent? { agents.first { $0.tabID == tabID } }

    /// Agents in the order the sidebar and the Cmd+1...9 shortcuts use: waiting first, then working, then idle.
    public var prioritized: [Agent] {
        agents.enumerated().sorted { l, r in
            if l.element.state.rank != r.element.state.rank { return l.element.state.rank < r.element.state.rank }
            return l.offset < r.offset
        }.map { $0.element }
    }

    public mutating func setState(_ paneID: String, to state: AgentState) {
        guard let i = agents.firstIndex(where: { $0.id == paneID }) else { return }
        agents[i].state = state
        let a = agents[i]
        if let t = tabs.firstIndex(where: { $0.id == a.tabID }) { tabs[t].state = state }
        if let w = workspaces.firstIndex(where: { $0.id == a.workspaceID }) {
            workspaces[w].state = agents(in: a.workspaceID).map(\.state).min { $0.rank < $1.rank } ?? .idle
        }
    }
}
