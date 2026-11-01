// A stand-in Herdr: enough of the JSON API, the pane stream and `herdr status` for Helm to run against it.
//
// It exists because the real Herdr lab session cannot be provisioned on this Mac (the lab helper needs a running
// default session) and because anything that writes to a pane must never be tried on the live one. It speaks the same
// wire shapes Herdr 0.9.5 does for the calls Helm makes (checked against a read-only probe of a real session):
//   JSON API on <dir>/<session>/herdr.sock: ping, session.snapshot, events.subscribe, pane.read, pane.send_input
//   pane stream on <dir>/<session>/stream.sock, relayed by `FakeHerdr cli ... terminal session observe`
//   `FakeHerdr cli --session S status --json`
// Test-only control calls start with "fake.": set_state, set_protocol, mark, dump, stall.
import Foundation
import HelmCore

public final class FakeHerdrServer: @unchecked Sendable {
    public struct Config {
        public var directory: String
        public var session: String
        public var agents = 32
        public var cols = 66
        public var rows = 59
        /// Lines a working pane prints per second.
        public var workingRate = 4.0
        public var workingFraction = 0.15
        public var frameInterval = 0.032
        public var serverProtocol = 22
        public init(directory: String, session: String) { self.directory = directory; self.session = session }
    }

    final class Pane {
        let id: String, workspace: String, tab: String, label: String
        var state: AgentState
        var lines: [String]
        var revision = 0
        var sent: [String] = []
        init(id: String, workspace: String, tab: String, label: String, state: AgentState, rows: Int) {
            self.id = id; self.workspace = workspace; self.tab = tab; self.label = label; self.state = state
            lines = Array(repeating: "", count: rows)
        }
    }

    public var config: Config
    private let lock = NSCondition()
    private var panes: [Pane] = []
    private var subscribers: [UnixLineSocket] = []
    private var apiListener: UnixListener?
    private var streamListener: UnixListener?
    private var running = false
    private var serverProtocol: Int
    private var stalled = false
    private var tickCount = 0
    public private(set) var streamClients = 0

    public init(config: Config) {
        self.config = config
        self.serverProtocol = config.serverProtocol
        buildPanes()
    }

    private func buildPanes() {
        let n = config.agents
        for i in 0..<n {
            let ws = "w\(String(format: "%02d", i / 4 + 1))"
            let id = "\(ws):p\(i % 4 + 1)"
            let state: AgentState = i % 7 == 3 ? .blocked : (Double(i % 20) / 20.0 < config.workingFraction ? .working : (i % 5 == 0 ? .done : .idle))
            let p = Pane(id: id, workspace: ws, tab: "\(ws):t\(i % 4 + 1)", label: "agent \(i + 1)", state: state, rows: config.rows)
            Self.paint(p, cols: config.cols)
            panes.append(p)
        }
    }

    static func paint(_ p: Pane, cols: Int) {
        p.lines[0] = "\u{1b}[38;2;217;119;87m ▐▛███▜▌\u{1b}[0m  \u{1b}[1mClaude Code\u{1b}[0m"
        p.lines[1] = "\u{1b}[38;2;217;119;87m▝▜█████▛▘\u{1b}[0m  \(p.label) · \(p.id)"
        p.lines[2] = "\u{1b}[2m" + String(repeating: "─", count: cols) + "\u{1b}[0m"
        p.revision += 1
    }

    // MARK: lifecycle

    public func start() throws {
        let dir = "\(config.directory)/\(config.session)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        guard let api = UnixListener(path: "\(dir)/herdr.sock"), let stream = UnixListener(path: "\(dir)/stream.sock") else {
            throw NSError(domain: "FakeHerdr", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot listen in \(dir) (path too long?)"])
        }
        apiListener = api; streamListener = stream
        lock.lock(); running = true; lock.unlock()
        Thread.detachNewThread { [weak self] in
            while let self = self, let c = api.accept() { Thread.detachNewThread { self.serveAPI(c) } }
        }
        Thread.detachNewThread { [weak self] in
            while let self = self, let c = stream.accept() { Thread.detachNewThread { self.serveStream(c) } }
        }
        Thread.detachNewThread { [weak self] in self?.ticker() }
    }

    public func stop() {
        lock.lock(); running = false; let subs = subscribers; subscribers = []; lock.unlock()
        lock.broadcast()
        apiListener?.close(); streamListener?.close()
        subs.forEach { $0.shutdown() }
    }

    private var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return running }

    // MARK: simulated activity

    private func ticker() {
        var carry: [String: Double] = [:]
        let dt = 0.05
        while isRunning {
            Thread.sleep(forTimeInterval: dt)
            lock.lock()
            tickCount += 1
            for p in panes where p.state == .working {
                carry[p.id, default: 0] += config.workingRate * dt
                while carry[p.id, default: 0] >= 1 {
                    carry[p.id]! -= 1
                    Self.appendLine(p, "\u{1b}[38;2;120;190;120m●\u{1b}[0m step \(p.revision) \u{1b}[2mreading files and thinking about the change\u{1b}[0m", cols: config.cols)
                }
            }
            lock.unlock()
            lock.broadcast()
        }
    }

    static func appendLine(_ p: Pane, _ text: String, cols: Int) {
        p.lines.removeFirst()
        p.lines.append(text)
        p.revision += 1
    }

    private func broadcastEvent(_ name: String, _ data: [String: Any]) {
        lock.lock(); let subs = subscribers; lock.unlock()
        for s in subs { s.writeLine(["event": name, "data": data]) }
    }

    // MARK: JSON API

    private func snapshotJSON() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var wsOrder: [String] = []
        for p in panes where !wsOrder.contains(p.workspace) { wsOrder.append(p.workspace) }
        let workspaces: [[String: Any]] = wsOrder.enumerated().map { i, w in
            let ps = panes.filter { $0.workspace == w }
            let st = ps.map(\.state).min { $0.rank < $1.rank } ?? .idle
            return ["workspace_id": w, "number": i + 1, "label": "space \(i + 1)", "focused": i == 0, "pane_count": ps.count, "tab_count": ps.count,
                    "active_tab_id": ps[0].tab, "agent_status": st.rawValue]
        }
        let tabs: [[String: Any]] = panes.enumerated().map { i, p in
            ["tab_id": p.tab, "workspace_id": p.workspace, "number": i % 4 + 1, "label": p.label, "pane_count": 1, "agent_status": p.state.rawValue, "focused": false]
        }
        let paneJSON: [[String: Any]] = panes.map { p in
            ["pane_id": p.id, "terminal_id": "term_\(p.id)", "workspace_id": p.workspace, "tab_id": p.tab, "focused": false, "cwd": "/tmp/fixture",
             "label": "", "agent": "claude", "agent_status": p.state.rawValue, "revision": p.revision]
        }
        let agents: [[String: Any]] = panes.map { p in
            ["terminal_id": "term_\(p.id)", "agent": "claude", "terminal_title_stripped": p.label, "agent_status": p.state.rawValue,
             "agent_session": ["source": "fake", "agent": "claude", "kind": "id", "value": "00000000-0000-4000-8000-\(String(format: "%012d", panes.firstIndex { $0 === p } ?? 0))"],
             "workspace_id": p.workspace, "tab_id": p.tab, "pane_id": p.id, "focused": false, "cwd": "/tmp/fixture"]
        }
        let layouts: [[String: Any]] = panes.map { p in
            ["workspace_id": p.workspace, "tab_id": p.tab, "zoomed": false, "area": ["x": 0, "y": 0, "width": config.cols, "height": config.rows],
             "focused_pane_id": p.id, "panes": [["pane_id": p.id, "focused": true, "rect": ["x": 0, "y": 0, "width": config.cols, "height": config.rows]]], "splits": []]
        }
        let snap: [String: Any] = ["version": "fake", "protocol": serverProtocol, "focused_workspace_id": wsOrder.first ?? "", "focused_tab_id": panes.first?.tab ?? "",
                                   "focused_pane_id": panes.first?.id ?? "", "workspaces": workspaces, "tabs": tabs, "panes": paneJSON, "layouts": layouts, "agents": agents]
        return ["result": ["type": "session_snapshot", "snapshot": snap]]
    }

    private func pane(_ id: String?) -> Pane? { lock.lock(); defer { lock.unlock() }; return panes.first { $0.id == id } }

    private func serveAPI(_ c: UnixLineSocket) {
        defer { c.close() }
        while let req = c.readJSON() {
            let id = req["id"] as? String ?? ""
            let method = req["method"] as? String ?? ""
            let params = req["params"] as? [String: Any] ?? [:]
            func reply(_ result: [String: Any]) { var r = result; r["id"] = id; c.writeLine(r) }
            func fail(_ code: String, _ msg: String) { c.writeLine(["id": id, "error": ["code": code, "message": msg]]) }
            lock.lock(); let isStalled = stalled; lock.unlock()
            if isStalled && method != "fake.stall" { continue }   // simulate a wedged server: requests get no answer
            switch method {
            case "ping": reply(["result": ["type": "pong"]])
            case "session.snapshot": reply(snapshotJSON())
            case "events.subscribe":
                lock.lock(); subscribers.append(c); lock.unlock()
                reply(["result": ["type": "subscription_started"]])
                // Keep the connection open: events are pushed by broadcastEvent. Block until the client goes away.
                while c.readLine() != nil {}
                lock.lock(); subscribers.removeAll { $0 === c }; lock.unlock()
                return
            case "pane.read":
                guard let p = pane(params["pane_id"] as? String) else { fail("pane_not_found", "no such pane"); continue }
                lock.lock(); let text = p.lines.joined(separator: "\n"); let rev = p.revision; lock.unlock()
                reply(["result": ["type": "pane_read", "read": ["pane_id": p.id, "source": "visible", "format": "ansi", "text": text, "revision": rev, "truncated": false]]])
            case "pane.send_input":
                guard let p = pane(params["pane_id"] as? String) else { fail("pane_not_found", "no such pane"); continue }
                let text = params["text"] as? String ?? ""
                let keys = params["keys"] as? [String] ?? []
                lock.lock()
                p.sent.append(text + (keys.isEmpty ? "" : " <" + keys.joined(separator: "+") + ">"))
                Self.appendLine(p, "\u{1b}[1m> \(text)\u{1b}[0m", cols: config.cols)
                if keys.contains("Enter") { p.state = .working }
                lock.unlock()
                lock.broadcast()
                broadcastEvent("pane.agent_status_changed", ["pane_id": p.id, "agent_status": p.state.rawValue])
                reply(["result": ["type": "ok"]])
                if keys.contains("Enter") {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self = self else { return }
                        self.lock.lock()
                        p.state = .done
                        Self.appendLine(p, "\u{1b}[38;2;120;190;120m●\u{1b}[0m done: \(text.prefix(40))", cols: self.config.cols)
                        self.lock.unlock()
                        self.lock.broadcast()
                        self.broadcastEvent("pane.agent_status_changed", ["pane_id": p.id, "agent_status": "done"])
                    }
                }
            // ---- test-only controls ----
            case "fake.set_state":
                guard let p = pane(params["pane_id"] as? String), let s = params["state"] as? String else { fail("bad_params", "pane_id, state"); continue }
                lock.lock(); p.state = AgentState(raw: s); lock.unlock()
                broadcastEvent("pane.agent_status_changed", ["pane_id": p.id, "agent_status": s])
                reply(["result": ["type": "ok"]])
            case "fake.set_protocol":
                lock.lock(); serverProtocol = (params["protocol"] as? Int) ?? 22; lock.unlock()
                reply(["result": ["type": "ok"]])
            case "fake.mark":
                // Append a line carrying the server's own monotonic clock, for end-to-end latency measurements.
                guard let p = pane(params["pane_id"] as? String) else { fail("pane_not_found", "no such pane"); continue }
                lock.lock(); Self.appendLine(p, "MARK \(monotonicNanos())", cols: config.cols); lock.unlock()
                lock.broadcast()
                reply(["result": ["type": "ok"]])
            case "fake.dump":
                guard let p = pane(params["pane_id"] as? String) else { fail("pane_not_found", "no such pane"); continue }
                lock.lock(); let sent = p.sent; lock.unlock()
                reply(["result": ["type": "dump", "sent": sent]])
            case "fake.stall":
                lock.lock(); stalled = (params["on"] as? Bool) ?? true; lock.unlock()
                reply(["result": ["type": "ok"]])
            default: fail("unknown_method", method)
            }
        }
    }

    // MARK: pane stream (what `herdr terminal session observe` relays)

    private func serveStream(_ c: UnixLineSocket) {
        defer { c.close() }
        guard let hello = c.readJSON(timeout: 5), let id = hello["pane"] as? String, let p = pane(id) else { return }
        lock.lock(); streamClients += 1; lock.unlock()
        defer { lock.lock(); streamClients -= 1; lock.unlock() }
        let cols = (hello["cols"] as? Int) ?? config.cols
        let rows = (hello["rows"] as? Int) ?? config.rows
        var sent: [String]? = nil
        var seq: UInt64 = 0
        var lastRevision = -1
        var lastSend = Date.distantPast
        while isRunning {
            lock.lock()
            // NSCondition is not re-entrant: read `running` directly while the lock is held.
            while running && p.revision == lastRevision && sent != nil { lock.wait(until: Date().addingTimeInterval(0.25)) }
            let rev = p.revision
            let lines = p.lines
            let stillRunning = running
            lock.unlock()
            if !stillRunning { return }
            let wait = config.frameInterval - Date().timeIntervalSince(lastSend)
            if wait > 0 { Thread.sleep(forTimeInterval: wait) }
            lastSend = Date()
            lastRevision = rev
            // observer geometry: the pane keeps its own layout; crop or pad to what was asked for
            let visible = Array(lines.suffix(rows))
            var bytes = "\u{1b}[?2026h\u{1b}[?25l"
            let full = sent == nil
            if full { bytes += "\u{1b}[2J" }
            for (i, line) in visible.enumerated() where full || sent![i] != line {
                bytes += "\u{1b}[\(i + 1);1H\u{1b}[0m\u{1b}[2K\(line)"
            }
            bytes += "\u{1b}[?2026l"
            sent = visible
            seq += 1
            let frame = TerminalFrame(full: full, width: cols, height: rows, seq: seq, bytes: Array(bytes.utf8))
            if !c.writeRawLine(FrameCodec.encode(frame)) { return }
        }
    }

    // MARK: status (the CLI side)

    public func statusJSON(clientProtocol: Int) -> Data {
        lock.lock(); let sp = serverProtocol; lock.unlock()
        let compatible = sp == clientProtocol
        let obj: [String: Any] = [
            "client": ["version": "fake", "channel": "stable", "protocol": clientProtocol, "endpoint_protocol_generation": 1, "session": config.session],
            "server": ["status": "running", "running": true, "version": "fake", "protocol": sp, "compatible": compatible, "endpoint_compatible": true,
                       "restart_needed": false, "server_binary_stale": false, "session": config.session],
            "update": ["restart_needed": false, "server_binary_stale": false],
        ]
        return (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
    }

    /// Server-side protocol as the CLI would learn it from the live server.
    public func currentProtocol() -> Int { lock.lock(); defer { lock.unlock() }; return serverProtocol }
}
