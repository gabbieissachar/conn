// A stand-in Campus: the shapes of the private API Conn reads and writes (scout report section 3), with INVENTED content only (no real
// conversation text, names or ids). One router serves both the HTTP stand-in server (`FakeCampus serve`, which Conn's hidden web view
// talks to, cookie and all) and the in-process `FakeCampusAuth` (unit tests). Nothing here is Campus's real answer: the field names of
// message parts and events are read from the scout report where it names them and otherwise are plausible opencode v2 shapes that
// Conn's tolerant readers accept; the first live sign-in is what confirms them (ROADMAP).
import Foundation
import ConnCore

public struct FakeCampusResponse: Sendable {
    public var status = 200
    public var contentType = "application/json"
    public var body = Data()
    public var headers: [String: String] = [:]
    public var isStream = false
}

public final class FakeCampusWorld: @unchecked Sendable {
    public struct Conv {
        public var id: String, title: String, kind: String, folder: String, spaceName: String
        public var updatedAt: Date
        public var state: String           // idle | busy | needs_you
        public var unread: Bool
        public var agent = "build", model = "general-flash"
        public var messages: [[String: Any]] = []   // oldest first
        public var form: [String: Any]?
        public var gen = 0                // bumped to cancel a running script
    }

    public enum AuthMode { case none, cookie }
    public let authMode: AuthMode
    /// Seconds between the steps of a scripted run.
    public var stepDelay: TimeInterval = 0.35
    /// Where the stand-in says it lives, for the links inside its replies (the HTTP server sets its own address).
    public var publicBase = "https://campus.example.test"
    /// The token the stand-in's login page sets as the `campus_session` cookie: an invented value, not a credential of anything.
    public static let cookieValue = "fake-session-not-a-secret"

    private let lock = NSLock()
    private var convs: [Conv] = []
    private var session = 0
    private var loggedIn = true
    private var starting = false
    private var failWrites = false
    private var subscribers: [Int: AsyncStream<String>.Continuation] = [:]
    private var nextSub = 0
    public private(set) var log: [String] = []
    private var heartbeat: Timer?

    public init(authMode: AuthMode = .none) {
        self.authMode = authMode
        if authMode == .cookie { loggedIn = false }
        reset()
    }

    public static let spaces: [(kind: String, folder: String, name: String)] = [("private", "default", "My space"), ("team", "growth-ops", "Growth Ops"), ("team", "merchant-success", "Merchant Success")]

    public func reset() {
        lock.lock(); defer { lock.unlock() }
        for c in convs { _ = c }
        let now = Date()
        func conv(_ id: String, _ title: String, _ kind: String, _ folder: String, _ space: String, ago: TimeInterval, state: String, unread: Bool, msgs: [[String: Any]] = []) -> Conv {
            Conv(id: id, title: title, kind: kind, folder: folder, spaceName: space, updatedAt: now.addingTimeInterval(-ago), state: state, unread: unread, messages: msgs)
        }
        func user(_ t: String) -> [String: Any] { ["id": "msg_u\(UUID().uuidString.prefix(6))", "type": "user", "text": t] }
        func asst(_ parts: [[String: Any]], _ i: Int, _ o: Int) -> [String: Any] { ["id": "msg_a\(UUID().uuidString.prefix(6))", "type": "assistant", "content": parts, "tokens": ["input": i, "output": o], "finish": "stop"] }
        func text(_ t: String) -> [String: Any] { ["type": "text", "text": t] }
        func tool(_ n: String, _ input: [String: Any], _ out: String, _ ms: Int) -> [String: Any] { ["type": "tool", "name": n, "input": input, "output": out, "status": "completed", "duration": ms] }
        let digestForm: [String: Any] = ["id": "frm_demo_digest", "questions": [["question": "Which week should the digest cover?", "options": [["label": "Last full week"], ["label": "This week so far"], ["label": "I will give dates"]]], ["question": "Which format?", "options": [["label": "Short bullets"], ["label": "Two paragraphs"], ["label": "Table"]]]]]
        var digest = conv("ses_fakeDigest02", "Draft the weekly partner digest", "private", "default", "My space", ago: 360, state: "needs_you", unread: false, msgs: [
            user("Draft the weekly partner digest from last week's notes."),
            asst([["type": "reasoning", "text": "The notes folder holds several weeks. I should check which week the digest covers before I draft anything."], tool("read", ["filePath": "notes/index.md"], "index of weeks", 300), tool("shell", ["command": "ls notes | tail -3"], "week-44.md\nweek-45.md\nweek-46.md", 800)], 2900, 140)])
        digest.form = digestForm
        let rates = conv("ses_fakeRates01", "Compare two cashback rate tables", "private", "default", "My space", ago: 5, state: "idle", unread: false, msgs: [user("Compare the cashback rates in the two tables and tell me where B beats A.")])
        let sprint = conv("ses_fakeSprint03", "Summarise sprint tickets for the retro", "private", "default", "My space", ago: 1500, state: "idle", unread: true, msgs: [
            user("Summarise last sprint's tickets for the retro."),
            asst([tool("read", ["filePath": "sprint-42/tickets.csv"], "38 rows", 500), tool("shell", ["command": "python3 tally.py"], "38 tickets, 31 closed, 7 carried over", 1400), text("Sprint 42 closed 31 of 38 tickets. Seven moved over: three wait on design, two are blocked by the payments sandbox and two are small. The retro has three themes: handoffs, test data and review wait time. The related thread is {{CAMPUS}}/spaces/private/default/conversations/ses_fakeOffsite04 if you want the agenda next to it.")], 3600, 210)])
        let offsite = conv("ses_fakeOffsite04", "Plan the Q1 offsite agenda", "private", "default", "My space", ago: 10800, state: "idle", unread: false, msgs: [user("Plan a two-day agenda for the Q1 offsite."), asst([text("Day one: strategy in the morning, two working sessions after lunch, dinner. Day two: planning for the quarter, a shorter retro and travel home by 4 pm.")], 1800, 380)])
        let email = conv("ses_fakeEmail05", "Rewrite onboarding email copy", "private", "default", "My space", ago: 93600, state: "idle", unread: false, msgs: [user("Rewrite the welcome email so it fits on one screen."), asst([text("The new version has a two-line opener, three short bullets and one button. It is 74 words, down from 190.")], 1100, 190)])
        var kpi = conv("ses_fakeKpi06", "Weekly KPI sheet refresh", "team", "growth-ops", "Growth Ops", ago: 120, state: "busy", unread: false, msgs: [user("Refresh the weekly KPI sheet from the exports in the shared folder.")])
        kpi.model = "coding-flash"
        let outreach = conv("ses_fakeOutreach07", "Partner outreach list cleanup", "team", "growth-ops", "Growth Ops", ago: 3000, state: "idle", unread: true, msgs: [user("Remove duplicates from the partner outreach list."), asst([tool("shell", ["command": "python3 dedupe.py"], "412 rows in, 377 out", 1100), text("I removed 35 duplicate rows and kept the newest contact date for each.")], 2000, 90)])
        let renewal = conv("ses_fakeRenewal08", "Draft the renewal checklist", "team", "merchant-success", "Merchant Success", ago: 18000, state: "idle", unread: false, msgs: [user("Draft a checklist for merchant renewals."), asst([text("Eight steps in three groups: prepare, meet and close.")], 1500, 260)])
        convs = [digest, rates, sprint, offsite, email, kpi, outreach, renewal]
        log = []
        session += 1
        starting = false
    }

    // MARK: events

    /// A stream of SSE text: every frame as `data: <json>\n\n`. Cancel by ending the iteration.
    public func subscribe() -> AsyncStream<String> {
        AsyncStream { cont in
            lock.lock(); let id = nextSub; nextSub += 1; subscribers[id] = cont; lock.unlock()
            cont.yield("data: " + Self.json(["id": "evt_hello", "created": Int(Date().timeIntervalSince1970 * 1000), "type": "server.connected", "data": [String: Any]()]) + "\n\n")
            cont.onTermination = { [weak self] _ in self?.lock.lock(); self?.subscribers[id] = nil; self?.lock.unlock() }
        }
    }

    public var subscriberCount: Int { lock.lock(); defer { lock.unlock() }; return subscribers.count }

    /// End every open stream (a dropped connection).
    public func dropStreams() {
        lock.lock(); let subs = subscribers; subscribers = [:]; lock.unlock()
        for (_, c) in subs { c.finish() }
    }

    public func emitHeartbeat() { lock.lock(); let subs = subscribers; lock.unlock(); for (_, c) in subs { c.yield(": heartbeat\n\n") } }

    var seq = 0
    func emit(_ type: String, _ sid: String, _ data: [String: Any] = [:]) {
        lock.lock()
        seq += 1
        var d = data; d["sessionID"] = sid
        let frame = ["id": "evt_\(seq)", "created": Int(Date().timeIntervalSince1970 * 1000), "type": type, "data": d, "durable": ["aggregateID": sid, "seq": seq, "version": 1]] as [String: Any]
        let text = "data: " + Self.json(frame) + "\n\n"
        let subs = subscribers
        lock.unlock()
        for (_, c) in subs { c.yield(text) }
    }

    static func json(_ o: Any) -> String { String(data: (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{}".utf8), encoding: .utf8) ?? "{}" }
    static func data(_ o: Any) -> Data { Data(json(o).utf8) }

    // MARK: runs

    private func mutate(_ id: String, _ f: (inout Conv) -> Void) { lock.lock(); if let i = convs.firstIndex(where: { $0.id == id }) { f(&convs[i]); convs[i].updatedAt = Date() }; lock.unlock() }
    private func conv(_ id: String) -> Conv? { lock.lock(); defer { lock.unlock() }; return convs.first { $0.id == id } }
    public func conversation(_ id: String) -> Conv? { conv(id) }

    /// Start a scripted run on a conversation: `ask` ends it on a question, otherwise it ends done (unread).
    public func startRun(_ id: String, userText: String?, ask: Bool) {
        guard conv(id) != nil else { return }
        var gen = 0
        mutate(id) { $0.gen += 1; gen = $0.gen; $0.state = "busy"; $0.form = nil; $0.unread = false; if let t = userText { $0.messages.append(["id": "msg_u\(UUID().uuidString.prefix(6))", "type": "user", "text": t]) } }
        if let t = userText { emit("session.inbox.enqueued", id, ["item": ["type": "user", "payload": ["text": t], "delivery": "steer"]]) }
        emit("session.execution.started", id)
        let delay = stepDelay
        let call = "call_\(gen)"
        let steps: [() -> Void] = [
            { self.emit("session.step.started", id) },
            { self.emit("session.reasoning.started", id); self.emit("session.reasoning.delta", id, ["delta": "Two tables, so read both first "]) },
            { self.emit("session.reasoning.delta", id, ["delta": "and then diff them merchant by merchant."]); self.emit("session.reasoning.ended", id) },
            { self.emit("session.tool.input.started", id, ["callID": call + "a", "tool": "read"]); self.emit("session.tool.called", id, ["callID": call + "a", "tool": "read", "input": ["filePath": "rates/table-a.csv"]]) },
            { self.emit("session.tool.success", id, ["callID": call + "a", "output": "20 rows", "duration": 400]) },
            { self.emit("session.tool.input.started", id, ["callID": call + "b", "tool": "shell"]); self.emit("session.tool.called", id, ["callID": call + "b", "tool": "shell", "input": ["command": "python3 diff_rates.py"]]) },
            { self.emit("session.tool.progress", id, ["callID": call + "b", "output": "diffing"]) },
            { self.emit("session.tool.success", id, ["callID": call + "b", "output": "14 of 20 merchants: B higher", "duration": 1600]); self.emit("session.step.ended", id, ["tokens": ["input": 2100, "output": 96]]) },
            { self.emit("session.step.started", id); self.emit("session.text.started", id); self.emit("session.text.delta", id, ["delta": "Table B pays more on 14 of the 20 merchants. "]) },
            { self.emit("session.text.delta", id, ["delta": "The gap is widest on travel and food delivery."]); self.emit("session.text.ended", id) },
        ]
        DispatchQueue.global().async { [weak self] in
            guard let self = self else { return }
            for s in steps {
                Thread.sleep(forTimeInterval: delay)
                guard self.conv(id)?.gen == gen else { return }
                s()
            }
            Thread.sleep(forTimeInterval: delay)
            guard self.conv(id)?.gen == gen else { return }
            let answer = "Table B pays more on 14 of the 20 merchants. The gap is widest on travel and food delivery."
            let a: [String: Any] = ["id": "msg_a\(UUID().uuidString.prefix(6))", "type": "assistant", "content": [["type": "text", "text": answer]], "tokens": ["input": 3400, "output": 212], "finish": "stop"]
            if ask {
                let form: [String: Any] = ["id": "frm_demo_\(gen)", "questions": [["question": "Which merchants should the summary lead with?", "options": [["label": "Top 5 by volume"], ["label": "Biggest rate gaps"], ["label": "All 20 in a table"]]]]]
                self.mutate(id) { $0.messages.append(a); $0.state = "needs_you"; $0.form = form }
                self.emit("session.step.ended", id, ["tokens": ["input": 3400, "output": 212]])
                self.emit("form.created", id, ["form": form])
            } else {
                self.mutate(id) { $0.messages.append(a); $0.state = "idle"; $0.unread = true }
                self.emit("session.step.ended", id, ["tokens": ["input": 3400, "output": 212]])
                self.emit("session.idle", id)
            }
        }
    }

    private func stopRun(_ id: String) {
        mutate(id) { $0.gen += 1; $0.state = "idle"; $0.form = nil }
        emit("session.execution.ended", id)
    }

    // MARK: the router

    public func record(_ line: String) { lock.lock(); log.append(line); lock.unlock() }
    public func writes() -> [String] { lock.lock(); defer { lock.unlock() }; return log }

    public func expireLogin() { lock.lock(); loggedIn = false; lock.unlock(); dropStreams() }
    public func setStarting(_ on: Bool) { lock.lock(); starting = on; lock.unlock() }

    private func ok(_ o: Any) -> FakeCampusResponse { var r = FakeCampusResponse(); r.body = Self.data(o); return r }
    private func err(_ code: Int, _ msg: String) -> FakeCampusResponse { var r = FakeCampusResponse(); r.status = code; r.body = Self.data(["error": msg]); return r }

    /// `cookie` is the request's Cookie header (the HTTP stand-in passes it; the in-process one passes nil and the mode is `.none`).
    public func route(method: String, path rawPath: String, cookie: String?, body: Data?) -> FakeCampusResponse {
        let comps = URLComponents(string: "http://x" + rawPath)
        let path = comps?.path ?? rawPath
        let query = Dictionary((comps?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        if path.hasPrefix("/__fake/") { return control(path, query) }
        if path == "/campus/login" || path == "/campus/login/ok" {
            var r = FakeCampusResponse(); r.contentType = "text/html; charset=utf-8"
            if path.hasSuffix("/ok") { lock.lock(); loggedIn = true; lock.unlock(); r.headers["Set-Cookie"] = "campus_session=\(Self.cookieValue); Path=/; HttpOnly; SameSite=Lax" }
            r.body = Data("<!doctype html><html><head><title>Stand-in Campus sign-in</title></head><body style=\"font:15px -apple-system;margin:40px\"><h2>Stand-in Campus</h2><p>Invented sign-in page for Conn's own checks.</p><p><a id=\"go\" href=\"/campus/login/ok\">Sign in with ShopBack</a></p><p id=\"state\">\(path.hasSuffix("/ok") ? "signed in" : "signed out")</p></body></html>".utf8)
            return r
        }
        lock.lock(); let isIn = loggedIn; let isStarting = starting; lock.unlock()
        if authMode == .cookie {
            let has = (cookie ?? "").contains("campus_session=\(Self.cookieValue)")
            if !(has && isIn) { return err(401, "no valid campus_session cookie") }
        }
        if path == "/campus/api/me" { return ok(["id": "usr_fake", "email": "person@example.test", "displayName": "Test Person", "modules": ["workspace"]]) }
        if isStarting && path.hasPrefix("/api/") { return err(503, "opencode_starting") }
        if path == "/api/spaces" {
            return ok(["running": true, "newPrivateSpace": false, "private": [["folderName": "default", "displayName": "My space", "colour": "blue"]],
                       "shared": [["folderName": "growth-ops", "displayName": "Growth Ops", "readOnly": false, "colour": "green"], ["folderName": "merchant-success", "displayName": "Merchant Success", "readOnly": false, "colour": "amber"]]])
        }
        if path == "/api/events" { var r = FakeCampusResponse(); r.contentType = "text/event-stream"; r.isStream = true; return r }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 4, parts[0] == "api", parts[1] == "spaces" else { return err(404, "not_found") }
        let kind = parts[2], folder = parts[3]
        if parts.count == 5 && parts[4] == "conversations" {
            let list = lockedConvs().filter { $0.kind == kind && $0.folder == folder }
            return ok(["conversations": list.map { c in ["id": c.id, "title": c.title, "spaceKind": c.kind, "folder": c.folder, "spaceName": c.spaceName, "spaceColour": "blue", "updatedAt": Int(c.updatedAt.timeIntervalSince1970 * 1000), "working": c.state == "busy", "needsYou": c.state == "needs_you", "unread": c.unread, "routineRun": false] as [String: Any] }, "hasMore": false, "partial": false])
        }
        if parts.count == 6 && parts[4] == "composer" {
            if parts[5] == "agents" { return ok(["data": [["id": "build", "name": "build"], ["id": "plan", "name": "plan"]]]) }
            if parts[5] == "models" { return ok(["data": ["coding-pro", "coding-flash", "general-pro", "general-flash"].map { ["id": $0, "providerID": "campus"] }]) }
            return err(404, "not_found")
        }
        guard parts.count >= 6, parts[4] == "conversations", let c = conv(parts[5]), c.kind == kind, c.folder == folder else { return err(404, "not_found") }
        let id = c.id
        let tail = Array(parts.dropFirst(6))
        lock.lock(); let failing = failWrites; lock.unlock()
        if method == "POST", failing { return err(500, "forced_failure") }
        switch (method, tail) {
        case ("GET", []): return ok(["data": ["id": id, "agent": c.agent, "model": ["id": c.model, "providerID": "campus"], "title": c.title, "time": ["updated": Int(c.updatedAt.timeIntervalSince1970 * 1000)]]])
        case ("GET", ["message"]):
            var r = ok(["data": Array(c.messages.reversed()), "cursor": ["previous": NSNull(), "next": NSNull()]])
            r.body = Data(String(decoding: r.body, as: UTF8.self).replacingOccurrences(of: "{{CAMPUS}}", with: publicBase).utf8)
            return r
        case ("GET", ["status"]): return ok(["state": c.state, "unread": c.unread, "parked": [Any](), "held": [Any](), "spaceDirectory": "/workspace/spaces/\(kind)/\(folder)"])
        case ("GET", ["form"]): return ok(["sessionIDs": [id], "permissions": [Any](), "forms": c.form.map { [$0] } ?? []])
        case ("POST", ["prompt"]):
            record("POST \(path) \(String(data: body ?? Data(), encoding: .utf8) ?? "")")
            let text = CampusJSON.parse(body ?? Data())?["text"].string ?? ""
            if c.state == "busy" { emit("session.inbox.enqueued", id, ["item": ["type": "user", "payload": ["text": text], "delivery": CampusJSON.parse(body ?? Data())?["delivery"].string ?? "queue"]]); return ok(["ok": true]) }
            startRun(id, userText: text, ask: false)
            return ok(["ok": true])
        case ("POST", ["interrupt"]):
            record("POST \(path) \(String(data: body ?? Data(), encoding: .utf8) ?? "")")
            stopRun(id); return ok(["ok": true])
        case ("POST", ["agent"]):
            record("POST \(path) \(String(data: body ?? Data(), encoding: .utf8) ?? "")")
            if let a = CampusJSON.parse(body ?? Data())?["agent"].string { mutate(id) { $0.agent = a } }; return ok(["ok": true])
        case ("POST", ["model"]):
            record("POST \(path) \(String(data: body ?? Data(), encoding: .utf8) ?? "")")
            if let m = CampusJSON.parse(body ?? Data())?["model"]["id"].string { mutate(id) { $0.model = m } }; return ok(["ok": true])
        default:
            if method == "POST", tail.count == 3, tail[0] == "form", tail[2] == "reply" {
                record("POST \(path) \(String(data: body ?? Data(), encoding: .utf8) ?? "")")
                guard c.form?["id"] as? String == tail[1] else { return err(404, "no_such_form") }
                emit("form.replied", id, ["formID": tail[1]])
                startRun(id, userText: nil, ask: false)
                return ok(["ok": true])
            }
            return err(404, "not_found")
        }
    }

    private func lockedConvs() -> [Conv] { lock.lock(); defer { lock.unlock() }; return convs }

    private func control(_ path: String, _ q: [String: String]) -> FakeCampusResponse {
        switch path {
        case "/__fake/expire": expireLogin(); return ok(["ok": true])
        case "/__fake/starting": setStarting(q["on"] != "0"); return ok(["ok": true])
        case "/__fake/fail-writes": lock.lock(); failWrites = q["on"] != "0"; lock.unlock(); return ok(["ok": true])
        case "/__fake/log": return ok(["writes": writes()])
        case "/__fake/reset": reset(); return ok(["ok": true])
        case "/__fake/drop-streams": dropStreams(); return ok(["ok": true])
        case "/__fake/run": if let c = q["c"] { startRun(c, userText: q["text"], ask: q["ask"] == "1") }; return ok(["ok": true])
        case "/__fake/subscribers": return ok(["subscribers": subscriberCount])
        default: return err(404, "not_found")
        }
    }
}
