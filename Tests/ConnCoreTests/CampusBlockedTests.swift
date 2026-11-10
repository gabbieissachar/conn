// Campus answers only on the company private network (Zscaler private access). Off it, a public ingress answers every path with nginx's own `403 Forbidden` page: the
// network, not the person's sign-in. So a 403 is never a sign-out. Signed out is a redirect to the login or a 401; a 403 is `module_required` (Campus's JSON, signed in
// but a module missing), another JSON refusal of Campus's own (kept as its text), or blocked by the network (any 403 whose body is not Campus's JSON), on every path:
// the list, a timeline read, the event stream, a write, the agent bridge and the silent refresh.
import Testing
import Foundation
import ConnCore
import FakeCampusKit

@MainActor private func until(_ timeout: Double = 5, _ cond: () -> Bool) async -> Bool {
    // A wall-clock deadline with room: the suites run in parallel and one of them holds the main actor for about 20 s, so counting sleeps of 20 ms
    // (which stretch under that load) gave up before the condition had a turn on the main actor. A passing wait still ends as soon as the condition holds.
    let end = Date().addingTimeInterval(max(timeout, 30))
    while !cond() && Date() < end { try? await Task.sleep(nanoseconds: 20_000_000) }
    return cond()
}

private let moduleBody = Data(#"{"error":"module_required","module":"ide"}"#.utf8)
private let nginx = CampusReply(status: 403, body: Data(FakeCampusWorld.nginxForbidden.utf8))
private let forbiddenJSON = CampusReply(status: 403, body: Data(#"{"error":"forbidden"}"#.utf8))

@MainActor private func makeStore() -> (CampusStore, FakeCampusAuth, FakeCampusWorld) {
    let world = FakeCampusWorld()
    world.stepDelay = 0.01
    let auth = FakeCampusAuth(world: world)
    let s = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
    s.pollInterval = 0.2; s.streamPollInterval = 0.5; s.retryInterval = 0.1; s.statusDelay = 0.02; s.reconnectMax = 0.2; s.holdSeconds = 0.05
    return (s, auth, world)
}

@Suite("Campus: a 403 is the network, not a sign-out") @MainActor struct CampusBlockedTests {
    @Test func theReplyReadsWhichAnswersMeanSignedOutAndWhichMeanBlocked() {
        // Signed out: a redirect to the login page, or 401. Never a 403.
        #expect(CampusReply(status: 401).signedOut)
        #expect(CampusReply(status: 200, body: Data("<html>".utf8), loginRedirect: true).signedOut)
        #expect(!nginx.signedOut && !forbiddenJSON.signedOut && !CampusReply(status: 403).signedOut)
        #expect(!CampusReply(status: 200).signedOut && !CampusReply(status: 404).signedOut && !CampusReply(status: 500).signedOut && !CampusReply(status: 503).signedOut)
        // Blocked: a 403 whose body is not Campus's JSON (nginx's page, or nothing at all).
        #expect(nginx.blockedByNetwork && CampusReply(status: 403).blockedByNetwork && CampusReply(status: 403, body: Data("<html>Forbidden</html>".utf8)).blockedByNetwork)
        #expect(nginx.failureText == CampusNetworkBlock.short && nginx.failureText.contains("Zscaler"))
        // Campus's own JSON refusals keep their own names, and are not the network's.
        let module = CampusReply(status: 403, body: moduleBody)
        #expect(module.moduleRequired && !module.signedOut && !module.blockedByNetwork)
        #expect(module.failureText.contains("ide module") && module.failureText.contains("module_required"))
        #expect(!forbiddenJSON.blockedByNetwork && forbiddenJSON.failureText == "Campus answered 403")
        #expect(!CampusReply(status: 403, body: Data("{}".utf8)).blockedByNetwork)                // any JSON object is Campus's own
        // Only a 403 can be a block or a module refusal.
        #expect(!CampusReply(status: 401, body: Data("<html>".utf8)).blockedByNetwork && !CampusReply(status: 500, body: Data("<html>".utf8)).blockedByNetwork)
        #expect(!CampusReply(status: 401, body: moduleBody).moduleRequired)
        #expect(CampusReply(status: 403, body: Data(#"{"error":"module_required"}"#.utf8)).failureText.contains("a module"))
        #expect(CampusReply(status: 500).failureText == "Campus answered 500")
        // The words say it is the network and what to check.
        #expect(CampusNetworkBlock.note.contains("not your sign-in") && CampusNetworkBlock.note.contains("Zscaler"))
    }

    @Test func neverSignedInWith401ShowsTheSignedOutState() async throws {
        let (s, auth, _) = makeStore()
        auth.override = { _ in CampusReply(status: 401, body: Data(#"{"error":"no valid campus_session cookie"}"#.utf8)) }
        await s.refresh()
        #expect(s.link == .expired && s.conversations.isEmpty && s.asOf == nil && s.asks.isEmpty)
    }

    @Test func aBlockedNetworkIsNotASignOutAndKeepsTheLastRowsUntilItClears() async throws {
        let (s, auth, _) = makeStore()
        await s.refresh()
        let asOf = try #require(s.asOf)
        #expect(s.asks.count == 1 && s.lastBlockedAt == nil)
        var blockedAt: [Date] = []
        s.onBlocked = { blockedAt.append($0) }
        auth.override = { _ in nginx }
        await s.refresh()
        #expect(s.link == .blocked && s.link != .expired && s.conversations.count == 8 && s.asOf == asOf && s.asks.isEmpty)
        #expect(s.lastBlockedAt != nil && blockedAt.count == 1)
        await s.refresh()                                                            // still blocked: no second report
        #expect(s.link == .blocked && blockedAt.count == 1)
        auth.override = nil
        await s.refresh()
        #expect(s.link == .live && s.asOf! > asOf && s.asks.count == 1)              // Try again recovers once the network answers
    }

    @Test func neverSignedInBehindABlockedNetworkIsBlockedNotSignedOut() async throws {
        let (s, auth, _) = makeStore()
        auth.override = { _ in nginx }
        await s.refresh()
        #expect(s.link == .blocked && s.conversations.isEmpty && s.asOf == nil && s.asks.isEmpty)
    }

    @Test func aJSONRefusalThatIsNotAModuleIsNeitherASignOutNorBlocked() async throws {
        let (s, auth, _) = makeStore()
        auth.override = { _ in forbiddenJSON }
        await s.refresh()
        guard case .unreachable(let why) = s.link else { Issue.record("link was \(s.link)"); return }
        #expect(why == "Campus answered 403" && s.lastBlockedAt == nil)
    }

    @Test func aModuleRefusalIsANamedErrorNotASignOut() async throws {
        let (s, auth, _) = makeStore()
        auth.override = { _ in CampusReply(status: 403, body: moduleBody) }
        await s.refresh()
        guard case .unreachable(let why) = s.link else { Issue.record("link was \(s.link)"); return }
        #expect(why.contains("ide module") && why.contains("module_required"))
        // One space refusing for its module keeps the list live with that space's rows.
        auth.override = nil
        await s.refresh()
        #expect(s.link == .live && s.conversations.count == 8)
        auth.override = { $0.path.contains("/growth-ops/") ? CampusReply(status: 403, body: moduleBody) : nil }
        await s.refresh()
        #expect(s.link == .live && s.conversations.count == 8)
    }

    @Test func aTimelineReadThatIsBlockedBlocksTheLinkToo() async throws {
        let (s, auth, _) = makeStore()
        await s.refresh()
        auth.override = { $0.path.contains("/message") ? nginx : nil }
        s.retain("ses_fakeSprint03")
        #expect(await until { s.link == .blocked })
        s.release("ses_fakeSprint03")
    }

    @Test func aStatusReadThatIsBlockedBlocksTheLinkToo() async throws {
        let (s, auth, _) = makeStore()
        await s.refresh()
        auth.override = { $0.path.hasSuffix("/status") ? nginx : nil }
        s.handle(CampusFrame(type: "session.execution.finished", sessionID: "ses_fakeSprint03"))     // a frame that may change a run's state makes one status read
        #expect(await until { s.link == .blocked })
    }

    @Test func aStreamThatOpensWith403IsBlockedUnlessItsBodyIsCampusJSON() async throws {
        let (s, auth, _) = makeStore()
        s.pollInterval = 60; s.streamPollInterval = 60; s.retryInterval = 60            // only the stream may change the link in this test
        await s.refresh()
        #expect(s.link == .live)
        auth.streamAnswer = (403, "status 403 module_required")
        s.start()
        #expect(await until { auth.streamsOpened >= 3 })
        #expect(s.link == .live)                                                         // reopened again and again, never blocked or signed out
        let opened = auth.streamsOpened
        auth.streamAnswer = (403, "status 403 json")                                     // another named JSON error of Campus's own
        #expect(await until { auth.streamsOpened >= opened + 3 })
        #expect(s.link == .live)
        auth.streamAnswer = (403, "status 403")                                          // nginx's page: the network
        #expect(await until { s.link == .blocked })
        #expect(s.link != .expired)
        s.stop()
    }

    @Test func aStreamThatOpensWith401IsSignedOut() async throws {
        let (s, auth, _) = makeStore()
        s.pollInterval = 60; s.streamPollInterval = 60; s.retryInterval = 60
        await s.refresh()
        auth.streamAnswer = (401, "status 401")
        s.start()
        #expect(await until { s.link == .expired })
        s.stop()
    }

    @Test func aWriteRefusedByTheNetworkBlocksTheLinkAndReturnsTheTextWithTheNetworkWords() async throws {
        let (s, auth, world) = makeStore()
        await s.refresh()
        s.writesEnabled = true
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        auth.override = { $0.method == "POST" ? nginx : nil }
        var restored: [String] = []
        _ = s.send("Please keep this", to: c) { restored.append($0) }
        #expect(await until { s.link == .blocked })
        #expect(await until { if case .failed = s.held?.phase { return true }; return false })
        #expect(restored == ["Please keep this"] && world.writes().isEmpty)
        if case .failed(let why)? = s.held?.phase { #expect(why == CampusNetworkBlock.short) }
    }

    @Test func aWriteRefusedWith401SignsOut() async throws {
        let (s, auth, _) = makeStore()
        await s.refresh()
        s.writesEnabled = true
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        auth.override = { $0.method == "POST" ? CampusReply(status: 401) : nil }
        var restored: [String] = []
        _ = s.send("Keep me too", to: c) { restored.append($0) }
        #expect(await until { s.link == .expired })
        #expect(await until { if case .failed = s.held?.phase { return true }; return false })
        #expect(restored == ["Keep me too"])
        if case .failed(let why)? = s.held?.phase { #expect(why == "Campus answered 401") }
    }

    @Test func aWriteRefusedForAModuleStaysSignedInAndNamesTheModule() async throws {
        let (s, auth, _) = makeStore()
        await s.refresh()
        s.writesEnabled = true
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        auth.override = { $0.method == "POST" ? CampusReply(status: 403, body: moduleBody) : nil }
        var restored: [String] = []
        _ = s.send("Keep me", to: c) { restored.append($0) }
        #expect(await until { if case .failed = s.held?.phase { return true }; return false })
        #expect(s.link == .live && restored == ["Keep me"])
        if case .failed(let why)? = s.held?.phase { #expect(why.contains("ide module")) }
    }
}

@Suite("Campus: the stand-in blocks the network") struct CampusBlockedServerTests {
    @Test func theStandInCanAnswerNginxsPageOnEveryPathAndNameAMissingModule() async throws {
        let world = FakeCampusWorld(authMode: .cookie)
        let server = FakeCampusServer(world: world)
        try server.start()
        defer { server.stop() }
        let base = "http://127.0.0.1:\(server.port)"
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpShouldSetCookies = false
        let net = URLSession(configuration: cfg)
        func get(_ path: String, cookie: String? = nil) async throws -> (Int, Data, HTTPURLResponse) {
            var r = URLRequest(url: URL(string: base + path)!)
            if let c = cookie { r.setValue(c, forHTTPHeaderField: "Cookie") }
            let (d, resp) = try await net.data(for: r)
            let h = resp as! HTTPURLResponse
            return (h.statusCode, d, h)
        }
        #expect(try await get("/api/spaces").0 == 401)                                   // signed out is 401
        let login = try await get("/campus/login/ok")
        let cookie = String(try #require(login.2.value(forHTTPHeaderField: "Set-Cookie")).split(separator: ";")[0])
        #expect(try await get("/api/spaces", cookie: cookie).0 == 200)
        // Blocked: the exact nginx page on every path (pages, API, stream), whatever the cookie says; the control paths still answer.
        #expect(try await get("/__fake/blocked-network").1 == Data(#"{"on":false}"#.utf8))
        _ = try await get("/__fake/blocked-network?on=1")
        for path in ["/campus/login", "/campus/login/ok", "/campus/api/me", "/campus", "/api/spaces", "/api/events", "/api/spaces/private/default/conversations"] {
            let r = try await get(path, cookie: cookie)
            #expect(r.0 == 403 && r.2.value(forHTTPHeaderField: "Content-Type") == "text/html", "\(path) -> \(r.0)")
            #expect(String(decoding: r.1, as: UTF8.self) == FakeCampusWorld.nginxForbidden && String(decoding: r.1, as: UTF8.self).contains("<center>nginx</center>"))
            let reply = CampusReply(status: r.0, body: r.1)
            #expect(reply.blockedByNetwork && !reply.signedOut && !reply.moduleRequired)
        }
        _ = try await get("/__fake/blocked-network?on=0")
        #expect(try await get("/api/spaces", cookie: cookie).0 == 200)                   // and it clears
        _ = try await get("/__fake/module-required?on=1")
        let module = try await get("/api/spaces", cookie: cookie)
        let reply = CampusReply(status: module.0, body: module.1)
        #expect(module.0 == 403 && reply.moduleRequired && !reply.signedOut && !reply.blockedByNetwork)
        _ = try await get("/__fake/module-required?on=0")
        world.expireLogin()
        #expect(try await get("/api/spaces", cookie: cookie).0 == 401)                    // signed out again: 401
    }
}

@Suite("Campus: the sign-in hop log") struct CampusHopLogTests {
    private func tempFile() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("conn-hops-\(UUID().uuidString)/sign-in-hops.log") }
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func aHopHoldsATimeAHostAPathAndAStatusNeverAQueryOrAFragment() throws {
        let url = try #require(URL(string: "https://Campus.ShopBack.com/campus/auth/callback?code=SECRET&state=ALSO#frag"))
        let hop = CampusHop(at: t0, source: "sign-in", url: url, status: 403)
        #expect(hop.host == "campus.shopback.com" && hop.path == "/campus/auth/callback" && hop.status == 403)
        #expect(!(String(data: try JSONEncoder().encode(hop), encoding: .utf8) ?? "").contains("SECRET"))
        #expect(CampusHop(at: t0, source: "sign-in", host: "x", path: "/a?token=SECRET", status: 200).path == "/a")
        #expect(CampusHop(at: t0, source: "sign-in", host: "x", path: "/" + String(repeating: "a", count: 500), status: 200).path.count == CampusHop.maxPath)
    }

    @Test func keepsOnlyThoseFieldsAndFindsTheLastBlock() throws {
        let f = tempFile()
        let log = CampusHopLog(file: f)
        log.append(CampusHop(at: t0, source: "sign-in", host: "campus.shopback.com", path: "/campus/login", status: 302))
        log.append(CampusHop(at: t0.addingTimeInterval(1), source: "sign-in", host: "accounts.google.com", path: "/o/oauth2/v2/auth", status: 403))     // another host's 403 is not Campus's
        #expect(log.lastBlocked(campusHost: "campus.shopback.com") == nil)
        log.append(CampusHop(at: t0.addingTimeInterval(10), source: "sign-in", host: "campus.shopback.com", path: "/campus/login", status: 403))
        log.append(CampusHop(at: t0.addingTimeInterval(20), source: "sign-in", host: "campus.shopback.com", path: "/campus/login", status: 200))
        #expect(log.lastBlocked(campusHost: "Campus.ShopBack.com") == t0.addingTimeInterval(10))
        #expect(log.recent().count == 4)
        let first = try #require(try JSONSerialization.jsonObject(with: Data(String(contentsOf: f, encoding: .utf8).split(separator: "\n")[0].utf8)) as? [String: Any]).keys
        #expect(Set(first) == ["at", "source", "host", "path", "status"])
        // A new log object reads what the old one wrote (the next launch).
        #expect(CampusHopLog(file: f).lastBlocked(campusHost: "campus.shopback.com") == t0.addingTimeInterval(10))
    }

    @Test func staysSmall() {
        let log = CampusHopLog(file: tempFile())
        for i in 0..<(CampusHopLog.keep * 2 + 10) { log.append(CampusHop(at: t0.addingTimeInterval(Double(i)), source: "sign-in", host: "campus.shopback.com", path: "/p", status: 200)) }
        let all = log.recent(10_000)
        #expect(all.count <= CampusHopLog.keep * 2 && all.count >= CampusHopLog.keep)
        #expect(all.last?.at == t0.addingTimeInterval(Double(CampusHopLog.keep * 2 + 9)))
    }
}
