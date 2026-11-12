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
    /// Seconds the server holds the answer back (a sign-in that never finishes).
    public var delay: TimeInterval = 0
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
        /// Pending permission requests, in the shape read on a live thread (`GET .../requests` lists them next to the forms, `GET .../permission` answers `{data: [...]}`, `GET .../form`
        /// answers `{data: [forms]}` and so never lists them). `POST .../permission/<id>/reply {"decision"}` answers one:
        /// `once` and `always` let the run go on, `reject` ends it; any other value is refused with 400 (opencode's values, the only guess there is).
        public var permissions: [[String: Any]] = []
        public var gen = 0                // bumped to cancel a running script
    }

    public enum AuthMode { case none, cookie }
    public let authMode: AuthMode
    /// Seconds between the steps of a scripted run.
    public var stepDelay: TimeInterval = 0.35
    /// Where the stand-in says it lives, for the links inside its replies (the HTTP server sets its own address).
    public var publicBase = "https://campus.example.test"
    /// The first segment of every token the stand-in sets as the `campus_session` cookie (the base64url of `{"alg":"none","typ":"JWT"}`): an invented value, not a credential
    /// of anything. A check that no Conn-side data holds the cookie looks for this.
    public static let tokenMarker = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0"

    /// What a hidden visit to Campus's sign-in path (`GET /campus/login`) does (the silent refresh). The default is the real login page, which waits for a click.
    public enum RenewMode: String, Sendable {
        /// The login page itself (needs a click).
        case page
        /// A person with a valid session is sent straight back into the app with a new token that lives longer; one without gets the login page.
        case renews
        /// Sent back into the app, but nothing is renewed: the cookie stays as it was.
        case lands
        /// Sent to another site's account chooser (a page that waits for input).
        case google
        /// The answer never comes (held back for two minutes).
        case hang
    }

    /// A token that looks like Google's: three segments, the middle one carrying `exp` (seconds since 1970). Unsigned, invented.
    public static func makeToken(exp: Date, serial: Int) -> String {
        func b64(_ d: Data) -> String { d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
        let payload = (try? JSONSerialization.data(withJSONObject: ["exp": Int(exp.timeIntervalSince1970), "sub": "usr_fake", "n": serial], options: [.sortedKeys])) ?? Data()
        return tokenMarker + "." + b64(payload) + ".not-a-signature"
    }

    private let lock = NSLock()
    private var convs: [Conv] = []
    private var session = 0
    private var loggedIn = true
    private var starting = false
    private var failWrites = false
    private var blockedNetwork = false
    // A "stale route" (sticky block): the answer that a connection opened, or already open, while the network refused keeps coming back on that connection for as long as it
    // lives, even after the network answers again; only a new connection gets through. That is what a pooled connection to the public ingress does after the private
    // path comes back. `poisonBelow` is the connection counter at the moment the block was lifted: a connection numbered under it is stale.
    private var stickyBlock = false
    private var poisonBelow = 0
    private var connectionCounter = 0
    private var keepAlive = false
    private var token = ""
    private var tokenExp = Date.distantPast
    private var tokenSerial = 0
    private var tokenLife: TimeInterval = 3600
    private var renewMode = RenewMode.page
    private var renewals = 0
    private var moduleRequired = false
    /// What the next run does (the agent bridge's checks): the default, end on a question, end on a permission request, or never end until released.
    public enum NextRun: String { case normal, ask, permission, hold, codeTool }
    private var nextRun = NextRun.normal
    private var nextReply: String?
    private var createdKeys: [String: String] = [:]     // Idempotency-Key -> the conversation it made
    private var createdCount = 0
    private var subscribers: [Int: AsyncStream<String>.Continuation] = [:]
    private var nextSub = 0
    public private(set) var log: [String] = []
    private var logTimes: [Date] = []
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
            asst([tool("read", ["filePath": "sprint-42/tickets.csv"], "38 rows", 500), tool("shell", ["command": "python3 tally.py"], "38 tickets, 31 closed, 7 carried over", 1400), text("## Sprint 42\n\nSprint 42 closed **31 of 38** tickets. Seven moved over: three wait on design, two are blocked by the payments sandbox and two are small.\n\n| Theme | Tickets |\n|---|---|\n| Handoffs | 4 |\n| Test data | 2 |\n| Review wait time | 1 |\n\n```sh\npython3 tally.py\n```\n\nThe related thread is [the offsite thread]({{CAMPUS}}/spaces/private/default/conversations/ses_fakeOffsite04) if you want the agenda next to it. The [retro notes](https://example.com/retro-notes) have the rest.")], 3600, 210)])
        let offsite = conv("ses_fakeOffsite04", "Plan the Q1 offsite agenda", "private", "default", "My space", ago: 10800, state: "idle", unread: false, msgs: [user("Plan a two-day agenda for the Q1 offsite."), asst([text("Day one: strategy in the morning, two working sessions after lunch, dinner. Day two: planning for the quarter, a shorter retro and travel home by 4 pm.")], 1800, 380)])
        let email = conv("ses_fakeEmail05", "Rewrite onboarding email copy", "private", "default", "My space", ago: 93600, state: "idle", unread: false, msgs: [user("Rewrite the welcome email so it fits on one screen."), asst([text("The new version has a two-line opener, three short bullets and one button. It is 74 words, down from 190.")], 1100, 190)])
        var kpi = conv("ses_fakeKpi06", "Weekly KPI sheet refresh", "team", "growth-ops", "Growth Ops", ago: 120, state: "busy", unread: false, msgs: [user("Refresh the weekly KPI sheet from the exports in the shared folder.")])
        kpi.model = "coding-flash"
        let outreach = conv("ses_fakeOutreach07", "Partner outreach list cleanup", "team", "growth-ops", "Growth Ops", ago: 3000, state: "idle", unread: true, msgs: [user("Remove duplicates from the partner outreach list."), asst([tool("shell", ["command": "python3 dedupe.py"], "412 rows in, 377 out", 1100), text("I removed 35 duplicate rows and kept the newest contact date for each.")], 2000, 90)])
        let renewal = conv("ses_fakeRenewal08", "Draft the renewal checklist", "team", "merchant-success", "Merchant Success", ago: 18000, state: "idle", unread: false, msgs: [user("Draft a checklist for merchant renewals."), asst([text("Eight steps in three groups: prepare, meet and close.")], 1500, 260)])
        convs = [digest, rates, sprint, offsite, email, kpi, outreach, renewal]
        log = []
        createdKeys = [:]; createdCount = 0
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
    /// Called with every event's type and conversation as it is emitted (a lab records when each happened; nothing else uses it).
    public var onEmit: ((String, String) -> Void)?
    func emit(_ type: String, _ sid: String, _ data: [String: Any] = [:]) {
        onEmit?(type, sid)
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

    /// The next run (a prompt, a form reply or a start) does `mode` and, when it ends with a reply, says `reply`. Taken once.
    public func setNextRun(_ mode: NextRun, reply: String? = nil) { lock.lock(); nextRun = mode; nextReply = reply; lock.unlock() }
    private func takeNextRun() -> (NextRun, String?) { lock.lock(); defer { lock.unlock(); nextRun = .normal; nextReply = nil }; return (nextRun, nextReply) }

    /// Let a held run end with its reply.
    public func release(_ id: String) {
        mutate(id) { $0.messages.append(["id": "msg_a\(UUID().uuidString.prefix(6))", "type": "assistant", "content": [["type": "text", "text": "Released: here is the reply."]], "tokens": ["input": 100, "output": 10], "finish": "stop"]); $0.state = "idle"; $0.unread = true }
        emit("session.idle", id)
    }

    /// The `execute` call of the `codeTool` run: invented code and an invented result (no real query, page or person).
    public static let codeToolCode = "const searches = [ { q: \"placement rules for the home screen\", k: \"home screen placement\" }, { q: \"who owns the feature flags\", k: \"flags owner\" } ];\nconst out = [];\nfor (const s of searches) {\n  try {\n    const r = await tools.campus.search({ query: s.q, keywords: s.k, limit: 10 });\n    out.push({ q: s.q, hits: (r.hits || []).map(h => ({ path: h.path, heading: h.heading })) });\n  } catch (e) { out.push({ q: s.q, error: String(e) }); }\n}\nreturn out;"
    public static let codeToolResult = "[{\"q\":\"placement rules for the home screen\",\"hits\":[{\"path\":\"product/example/reference/placements\",\"heading\":null,\"link\":\"https://campus.example.test/kb/product/example/placements\",\"snippet\":\"Example placements: what a user meets first\"},{\"path\":\"product/example/reference/sections\",\"heading\":\"Sections\",\"link\":\"https://campus.example.test/kb/product/example/sections\",\"snippet\":\"Sections of the example home screen\"}]},{\"q\":\"who owns the feature flags\",\"hits\":[]}]"

    /// Start a scripted run on a conversation: `ask` ends it on a question, otherwise it ends done (unread).
    public func startRun(_ id: String, userText: String?, ask askRequested: Bool) {
        guard conv(id) != nil else { return }
        let (mode, say) = takeNextRun()
        let ask = askRequested || mode == .ask
        var gen = 0
        mutate(id) { $0.gen += 1; gen = $0.gen; $0.state = "busy"; $0.form = nil; $0.unread = false; if let t = userText { $0.messages.append(["id": "msg_u\(UUID().uuidString.prefix(6))", "type": "user", "text": t]) } }
        if let t = userText { emit("session.inbox.enqueued", id, ["item": ["type": "user", "payload": ["text": t], "delivery": "steer"]]) }
        emit("session.execution.started", id)
        let delay = stepDelay
        let call = "call_\(gen)"
        let head: [() -> Void] = [
            { self.emit("session.step.started", id) },
            { self.emit("session.reasoning.started", id); self.emit("session.reasoning.delta", id, ["delta": "Two tables, so read both first "]) },
            { self.emit("session.reasoning.delta", id, ["delta": "and then diff them merchant by merchant."]); self.emit("session.reasoning.ended", id) },
        ]
        // `codeTool`: one Campus-style `execute` call (a `code` input that calls `tools.campus.search`, a JSON result as text parts plus the value), in opencode v2's shape.
        let tools: [() -> Void] = mode == .codeTool ? [
            { self.emit("session.tool.input.started", id, ["callID": call + "x", "name": "execute"]); self.emit("session.tool.called", id, ["callID": call + "x", "tool": "execute", "input": ["code": Self.codeToolCode]]) },
            { self.emit("session.tool.success", id, ["callID": call + "x", "content": [["type": "text", "text": Self.codeToolResult]], "structured": (try? JSONSerialization.jsonObject(with: Data(Self.codeToolResult.utf8))) ?? [:]]); self.emit("session.step.ended", id, ["tokens": ["input": 2100, "output": 96]]) },
        ] : [
            { self.emit("session.tool.input.started", id, ["callID": call + "a", "tool": "read"]); self.emit("session.tool.called", id, ["callID": call + "a", "tool": "read", "input": ["filePath": "rates/table-a.csv"]]) },
            { self.emit("session.tool.success", id, ["callID": call + "a", "output": "20 rows", "duration": 400]) },
            { self.emit("session.tool.input.started", id, ["callID": call + "b", "tool": "shell"]); self.emit("session.tool.called", id, ["callID": call + "b", "tool": "shell", "input": ["command": "python3 diff_rates.py"]]) },
            { self.emit("session.tool.progress", id, ["callID": call + "b", "output": "diffing"]) },
            { self.emit("session.tool.success", id, ["callID": call + "b", "output": "14 of 20 merchants: B higher", "duration": 1600]); self.emit("session.step.ended", id, ["tokens": ["input": 2100, "output": 96]]) },
        ]
        let tail: [() -> Void] = [
            { self.emit("session.step.started", id); self.emit("session.text.started", id); self.emit("session.text.delta", id, ["delta": "Table B pays more on 14 of the 20 merchants. "]) },
            { self.emit("session.text.delta", id, ["delta": "The gap is widest on travel and food delivery."]); self.emit("session.text.ended", id) },
        ]
        let steps = head + tools + tail
        DispatchQueue.global().async { [weak self] in
            guard let self = self else { return }
            for s in steps {
                Thread.sleep(forTimeInterval: delay)
                guard self.conv(id)?.gen == gen else { return }
                s()
            }
            Thread.sleep(forTimeInterval: delay)
            guard self.conv(id)?.gen == gen else { return }
            if mode == .hold { return }           // stays busy until `release`
            let answer = say ?? "Table B pays more on 14 of the 20 merchants. The gap is widest on travel and food delivery."
            var parts: [[String: Any]] = [["type": "text", "text": answer]]
            if mode == .codeTool { parts.insert(["type": "tool", "callID": call + "x", "name": "execute", "state": ["status": "completed", "input": ["code": Self.codeToolCode], "content": [["type": "text", "text": Self.codeToolResult]]], "time": ["created": 1_000, "ran": 1_100, "completed": 2_300]], at: 0) }
            let a: [String: Any] = ["id": "msg_a\(UUID().uuidString.prefix(6))", "type": "assistant", "content": parts, "tokens": ["input": 3400, "output": 212], "finish": "stop"]
            if mode == .permission {
                let perm = Self.permissionObject(id: "per_demo\(gen)", session: id, action: "shell", resources: ["curl https://example.test"])
                let msg = Self.waitingToolMessage(for: perm, command: "curl https://example.test")
                self.mutate(id) { $0.state = "needs_you"; $0.form = nil; $0.permissions = [perm]; $0.messages.append(msg) }
                self.emit("session.step.ended", id, ["tokens": ["input": 3400, "output": 212]])
                self.emit("permission.asked", id, perm)
                return
            }
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

    public func record(_ line: String) { lock.lock(); log.append(line); logTimes.append(Date()); lock.unlock() }
    public func writes() -> [String] { lock.lock(); defer { lock.unlock() }; return log }
    /// When each line of `writes()` arrived at the stand-in: a timing check reads these, not the moment a polling test happened to notice the line.
    public func writeTimes() -> [Date] { lock.lock(); defer { lock.unlock() }; return logTimes }

    public func expireLogin() { lock.lock(); loggedIn = false; lock.unlock(); dropStreams() }
    public func setStarting(_ on: Bool) { lock.lock(); starting = on; lock.unlock() }
    /// While on, every path (the pages, the API and the stream) is answered with nginx's own `403 Forbidden` page: what the public ingress answers off the company private network.
    /// `sticky`: the refusal also sticks to every connection that is open now or opens while it lasts (see `connectionIsStale`).
    public func setBlockedNetwork(_ on: Bool, sticky: Bool = false) {
        lock.lock()
        if on { stickyBlock = sticky } else if stickyBlock { poisonBelow = connectionCounter; stickyBlock = false }
        blockedNetwork = on
        lock.unlock()
        if on { dropStreams() }
    }
    /// A new connection's number (the server asks for one at each accept).
    public func newConnection() -> Int { lock.lock(); defer { lock.unlock() }; connectionCounter += 1; return connectionCounter }
    /// Whether the connection numbered `n` still answers the refusal: it was open when a sticky block began, or opened under it.
    public func connectionIsStale(_ n: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return stickyBlock || n <= poisonBelow }
    /// While on, the server keeps a connection open after an answer (as the real ingress does), so a client pools it.
    public func setKeepAlive(_ on: Bool) { lock.lock(); keepAlive = on; lock.unlock() }
    public var keepsAlive: Bool { lock.lock(); defer { lock.unlock() }; return keepAlive }
    /// The exact page the real ingress answers with (HTML, no Campus JSON).
    public static let nginxForbidden = "<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n<center><h1>403 Forbidden</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n"
    /// While on, every signed-in API call is refused with `403 {"error":"module_required",...}`: signed in, but the account lacks the module.
    public func setModuleRequired(_ on: Bool) { lock.lock(); moduleRequired = on; lock.unlock() }

    private func ok(_ o: Any) -> FakeCampusResponse { var r = FakeCampusResponse(); r.body = Self.data(o); return r }
    private func err(_ code: Int, _ msg: String) -> FakeCampusResponse { var r = FakeCampusResponse(); r.status = code; r.body = Self.data(["error": msg]); return r }

    /// `cookie` is the request's Cookie header (the HTTP stand-in passes it; the in-process one passes nil and the mode is `.none`).
    public func route(method: String, path rawPath: String, cookie: String?, body: Data?, headers: [String: String] = [:], staleConnection: Bool = false) -> FakeCampusResponse {
        let comps = URLComponents(string: "http://x" + rawPath)
        let path = comps?.path ?? rawPath
        let query = Dictionary((comps?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        if path.hasPrefix("/__fake/") { return control(path, query) }
        lock.lock(); let blocked = blockedNetwork || staleConnection; lock.unlock()
        if blocked { var r = FakeCampusResponse(); r.status = 403; r.contentType = "text/html"; r.body = Data(Self.nginxForbidden.utf8); return r }
        if path == "/campus/login" || path == "/campus/login/ok" {
            var r = FakeCampusResponse(); r.contentType = "text/html; charset=utf-8"
            if path == "/campus/login", let silent = silentLogin(cookie: cookie) { return silent }
            if path.hasSuffix("/ok") { r.headers["Set-Cookie"] = "campus_session=\(mintToken()); Path=/; HttpOnly; SameSite=Lax" }
            r.body = Data("<!doctype html><html><head><title>Stand-in Campus sign-in</title></head><body style=\"font:15px -apple-system;margin:40px\"><h2>Stand-in Campus</h2><p>Invented sign-in page for Conn's own checks.</p><p><a id=\"go\" href=\"/campus/login/ok\">Sign in with ShopBack</a></p><p id=\"state\">\(path.hasSuffix("/ok") ? "signed in" : "signed out")</p></body></html>".utf8)
            return r
        }
        if path == "/campus" || path == "/campus/" {
            var r = FakeCampusResponse(); r.contentType = "text/html; charset=utf-8"
            r.body = Data("<!doctype html><html><head><title>Stand-in Campus</title></head><body style=\"font:15px -apple-system;margin:40px\"><h2>Stand-in Campus</h2><p>The app, as the stand-in has it.</p></body></html>".utf8)
            return r
        }
        lock.lock(); let isIn = loggedIn; let isStarting = starting; let needsModule = moduleRequired; lock.unlock()
        if authMode == .cookie {
            if !(isIn && validSession(cookie)) { return err(401, "no valid campus_session cookie") }
        }
        if needsModule && path.hasPrefix("/api/") { var r = FakeCampusResponse(); r.status = 403; r.body = Self.data(["error": "module_required", "module": "workspace"]); return r }
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
        if parts.count == 5 && parts[4] == "conversations" && method == "POST" { return create(kind: kind, folder: folder, path: path, body: body, key: headers.first { $0.key.lowercased() == "idempotency-key" }?.value) }
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
        case ("GET", ["requests"]): return ok(["sessionIDs": [id], "permissions": c.permissions, "forms": c.form.map { [$0] } ?? []])
        case ("GET", ["form"]): return ok(["data": c.form.map { [$0] } ?? []])
        case ("GET", ["permission"]): return ok(["data": c.permissions])
        case ("PATCH", []):
            record("PATCH \(path) \(String(data: body ?? Data(), encoding: .utf8) ?? "")")
            if let t = CampusJSON.parse(body ?? Data())?["title"].string { mutate(id) { $0.title = t } }
            return ok(["ok": true])
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
            if method == "POST", tail.count == 3, tail[0] == "permission", tail[2] == "reply" {
                record("POST \(path) \(String(data: body ?? Data(), encoding: .utf8) ?? "")")
                guard c.permissions.contains(where: { $0["id"] as? String == tail[1] }) else { return err(404, "no_such_permission") }
                let decision = CampusJSON.parse(body ?? Data())?["decision"].string ?? ""
                guard ["once", "always", "reject"].contains(decision) else { return err(400, "bad_decision") }
                finishPermission(id, tail[1], decision: decision, announce: true)
                return ok(["ok": true])
            }
            return err(404, "not_found")
        }
    }

    /// A permission request as a live thread listed it: `{id, sessionID, action, resources[], save[], source{type, messageID, id}, message}`. The values are invented.
    public static func permissionObject(id: String, session: String, action: String, resources: [String], message: String = "This writes to a file the team's instance takes in as trusted, so the person approves each change.") -> [String: Any] {
        ["id": id, "sessionID": session, "action": action, "resources": resources, "save": resources.map { ($0.split(separator: " ").first.map(String.init) ?? $0) + " *" },
         "source": ["type": "tool", "messageID": "msg_ask_\(id)", "id": "chatcmpl-tool-\(id)"], "message": message]
    }

    /// The assistant message that holds the tool call a permission waits on, as a live thread had it (`state.status: "running"`, `state.input.command`): the call's own command, which
    /// is what runs, and which Campus's `resources` only split into parts.
    public static func waitingToolMessage(for perm: [String: Any], command: String) -> [String: Any] {
        let source = perm["source"] as? [String: Any] ?? [:]
        let tool: [String: Any] = ["type": "tool", "id": source["id"] as? String ?? "", "name": perm["action"] as? String ?? "shell", "executed": false,
                                   "state": ["status": "running", "input": ["command": command], "metadata": [String: Any]()], "time": ["created": 1_000, "ran": 1_100]]
        return ["id": source["messageID"] as? String ?? "", "type": "assistant", "content": [tool]]
    }

    /// A permission answered: it leaves the list, `permission.replied` says so (not when `announce` is off: another client's answer that Conn saw no event for), and the run goes on
    /// (`once`, `always`) or ends (`reject`).
    private func finishPermission(_ id: String, _ permID: String, decision: String, announce: Bool) {
        mutate(id) { $0.permissions.removeAll { $0["id"] as? String == permID } }
        if announce { emit("permission.replied", id, ["permissionID": permID, "reply": decision]) }
        if decision == "reject" {
            mutate(id) { $0.gen += 1; $0.state = "idle"; $0.unread = true }
            emit("session.idle", id)
        } else {
            startRun(id, userText: nil, ask: false)
        }
    }

    /// The person answers the pending permission somewhere that is not Conn (Campus's own page): the same end as `POST .../permission/<id>/reply`, recorded as nothing.
    public func answerPermissionElsewhere(_ id: String, decision: String = "once", announce: Bool = true) {
        guard let permID = conv(id)?.permissions.first?["id"] as? String else { return }
        finishPermission(id, permID, decision: decision, announce: announce)
    }

    /// A thread that waits on a permission (what a run in `permission` mode ends on), without a run: for a check or a test that needs the wait to be there at once.
    /// `announce` also sends the `permission.asked` event; without it only the status and the listing say so.
    /// `command` is what the waiting tool call really runs (default: the resources joined with `; `); `withTool: false` leaves the call out of the thread's messages.
    public func askPermission(_ id: String, name: String = "shell", patterns: [String] = ["curl https://example.test"], command: String? = nil, withTool: Bool = true, permissionID: String? = nil, announce: Bool = true) {
        let perm = Self.permissionObject(id: permissionID ?? "per_demo\(Int.random(in: 100...999))", session: id, action: name, resources: patterns)
        let msg = Self.waitingToolMessage(for: perm, command: command ?? patterns.joined(separator: "; "))
        mutate(id) { $0.gen += 1; $0.state = "needs_you"; $0.form = nil; $0.permissions = [perm]; $0.unread = false; if withTool { $0.messages.append(msg) } }
        if announce { emit("permission.asked", id, perm) }
    }

    /// `POST /api/spaces/<kind>/<folder>/conversations {"text"}` with an Idempotency-Key: a new conversation that starts a run on the text. The same key answers with the
    /// conversation it already made. The answer's shape (`{"data": {id, title, ...}}`) is a guess: nobody has seen the real one (ROADMAP).
    private func create(kind: String, folder: String, path: String, body: Data?, key: String?) -> FakeCampusResponse {
        guard let space = Self.spaces.first(where: { $0.kind == kind && $0.folder == folder }) else { return err(404, "not_found") }
        lock.lock(); let failing = failWrites; lock.unlock()
        if failing { return err(500, "forced_failure") }
        guard let text = CampusJSON.parse(body ?? Data())?["text"].string, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return err(400, "text_required") }
        record("POST \(path) \(String(data: body ?? Data(), encoding: .utf8) ?? "") [Idempotency-Key: \(key ?? "none")]")
        lock.lock()
        if let k = key, let id = createdKeys[k], let c = convs.first(where: { $0.id == id }) { lock.unlock(); return created(c) }
        createdCount += 1
        let id = "ses_fakeNew\(String(format: "%02d", createdCount))"
        let c = Conv(id: id, title: String(text.prefix(40)), kind: kind, folder: folder, spaceName: space.name, updatedAt: Date(), state: "idle", unread: false)
        convs.append(c)
        if let k = key { createdKeys[k] = id }
        lock.unlock()
        emit("session.created", id, ["version": 1, "projectID": "prj_fake", "slug": "fake-new"])
        startRun(id, userText: text, ask: false)
        return created(conv(id) ?? c)
    }

    private func created(_ c: Conv) -> FakeCampusResponse {
        ok(["data": ["id": c.id, "title": c.title, "agent": c.agent, "model": ["id": c.model, "providerID": "campus"], "time": ["created": Int(c.updatedAt.timeIntervalSince1970 * 1000), "updated": Int(c.updatedAt.timeIntervalSince1970 * 1000)]]])
    }

    private func lockedConvs() -> [Conv] { lock.lock(); defer { lock.unlock() }; return convs }

    /// A new token that lives `tokenLife` seconds, now the only valid one; the person is signed in.
    private func mintToken() -> String {
        lock.lock(); defer { lock.unlock() }
        tokenSerial += 1
        tokenExp = Date().addingTimeInterval(tokenLife)
        token = Self.makeToken(exp: tokenExp, serial: tokenSerial)
        loggedIn = true
        return token
    }

    /// The Cookie header carries the current token and it has not run out.
    private func validSession(_ cookie: String?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !token.isEmpty && Date() < tokenExp && (cookie ?? "").contains("campus_session=\(token)")
    }

    /// What `GET /campus/login` does under the current `RenewMode`; nil: serve the login page.
    private func silentLogin(cookie: String?) -> FakeCampusResponse? {
        lock.lock(); let mode = renewMode; lock.unlock()
        switch mode {
        case .page: return nil
        case .renews:
            lock.lock(); let isIn = loggedIn; lock.unlock()
            guard isIn, validSession(cookie) else { return nil }
            lock.lock(); renewals += 1; lock.unlock()
            var r = FakeCampusResponse(); r.status = 302; r.contentType = "text/html; charset=utf-8"
            r.headers["Location"] = "/campus/"
            r.headers["Set-Cookie"] = "campus_session=\(mintToken()); Path=/; HttpOnly; SameSite=Lax"
            return r
        case .lands:
            var r = FakeCampusResponse(); r.status = 302; r.contentType = "text/html; charset=utf-8"
            r.headers["Location"] = "/campus/"
            return r
        case .google:
            var r = FakeCampusResponse(); r.status = 302; r.contentType = "text/html; charset=utf-8"
            // Another host name (the stand-in listens on loopback, so `localhost` is another site to the browser): a page of Google's, not of Campus's.
            let other = publicBase.contains("127.0.0.1") ? publicBase.replacingOccurrences(of: "127.0.0.1", with: "localhost") : "https://accounts.example.test"
            r.headers["Location"] = other + "/__fake/google"
            return r
        case .hang:
            var r = FakeCampusResponse(); r.contentType = "text/html; charset=utf-8"; r.delay = 120
            r.body = Data("<!doctype html><title>late</title>".utf8)
            return r
        }
    }

    /// How long the next tokens live, in seconds (the real one is 3600).
    public func setSessionLife(_ seconds: TimeInterval) { lock.lock(); tokenLife = max(1, seconds); lock.unlock() }
    public func setRenewMode(_ m: RenewMode) { lock.lock(); renewMode = m; lock.unlock() }
    /// How many silent sign-ins made a new token.
    public var renewalCount: Int { lock.lock(); defer { lock.unlock() }; return renewals }
    /// The current token's expiry (nil: no token yet).
    public var sessionExpiry: Date? { lock.lock(); defer { lock.unlock() }; return token.isEmpty ? nil : tokenExp }

    private func control(_ path: String, _ q: [String: String]) -> FakeCampusResponse {
        switch path {
        case "/__fake/renew": setRenewMode(RenewMode(rawValue: q["mode"] ?? "page") ?? .page); return ok(["ok": true])
        case "/__fake/session-life": if let s = q["seconds"].flatMap(Double.init) { setSessionLife(s) }; return ok(["ok": true])
        case "/__fake/renewals": return ok(["renewals": renewalCount])
        case "/__fake/session": return ok(["exp": sessionExpiry.map { Int($0.timeIntervalSince1970) } ?? 0, "renewals": renewalCount])
        case "/__fake/google":
            var r = FakeCampusResponse(); r.contentType = "text/html; charset=utf-8"
            r.body = Data("<!doctype html><html><head><title>Stand-in account chooser</title></head><body style=\"font:15px -apple-system;margin:40px\"><h2>Choose an account</h2><p>Invented page of another site, for Conn's own checks. It waits for a click.</p><p><button id=\"pick\">person@example.test</button></p></body></html>".utf8)
            return r
        case "/__fake/expire": expireLogin(); return ok(["ok": true])
        case "/__fake/starting": setStarting(q["on"] != "0"); return ok(["ok": true])
        case "/__fake/blocked-network":
            if let on = q["on"] { setBlockedNetwork(on != "0", sticky: q["sticky"] == "1") }   // without `on`, only reads
            lock.lock(); let on = blockedNetwork; lock.unlock()
            return ok(["on": on])
        case "/__fake/keep-alive": setKeepAlive(q["on"] != "0"); return ok(["ok": true])
        case "/__fake/module-required": setModuleRequired(q["on"] != "0"); return ok(["ok": true])
        case "/__fake/fail-writes": lock.lock(); failWrites = q["on"] != "0"; lock.unlock(); return ok(["ok": true])
        case "/__fake/log": return ok(["writes": writes()])
        case "/__fake/reset": reset(); return ok(["ok": true])
        case "/__fake/drop-streams": dropStreams(); return ok(["ok": true])
        case "/__fake/next-run": setNextRun(NextRun(rawValue: q["mode"] ?? "normal") ?? .normal, reply: q["reply"]); return ok(["ok": true])
        case "/__fake/release": if let c = q["c"] { release(c) }; return ok(["ok": true])
        case "/__fake/permission": if let c = q["c"] { askPermission(c, name: q["name"] ?? "shell", announce: q["announce"] != "0") }; return ok(["ok": true])
        case "/__fake/permission-answered-elsewhere": if let c = q["c"] { answerPermissionElsewhere(c, decision: q["decision"] ?? "once", announce: q["announce"] != "0") }; return ok(["ok": true])
        case "/__fake/state": if let c = q["c"], let v = conv(c) { return ok(["state": v.state, "permissions": v.permissions.count, "form": v.form != nil, "unread": v.unread]) }; return err(404, "not_found")
        case "/__fake/run": if let c = q["c"] { startRun(c, userText: q["text"], ask: q["ask"] == "1") }; return ok(["ok": true])
        case "/__fake/subscribers": return ok(["subscribers": subscriberCount])
        default: return err(404, "not_found")
        }
    }
}
