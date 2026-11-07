// The Campus feed end to end against the stand-in Campus: rows, marks, order, asks, the stream with reconnect, an idle stream cut and reopened,
// "as of" when the sign-in expires, and the HTTP stand-in's own cookie gate.
import Testing
import Foundation
import ConnCore
import FakeCampusKit

@MainActor private func until(_ timeout: Double = 5, _ cond: () -> Bool) async -> Bool {
    var t = 0.0
    while !cond() && t < timeout { try? await Task.sleep(nanoseconds: 20_000_000); t += 0.02 }
    return cond()
}

@MainActor private func makeStore(_ world: FakeCampusWorld = FakeCampusWorld(), fast: Bool = true) -> (CampusStore, FakeCampusAuth) {
    world.stepDelay = 0.01
    let auth = FakeCampusAuth(world: world)
    let s = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
    if fast { s.pollInterval = 0.2; s.streamPollInterval = 0.5; s.retryInterval = 0.1; s.statusDelay = 0.02; s.reconnectMax = 0.2 }
    return (s, auth)
}

@Suite("Campus: the feed") @MainActor struct CampusStoreTests {
    @Test func theFirstRefreshFillsSpacesRowsMarksAndAsks() async throws {
        let (s, _) = makeStore()
        #expect(s.link == .starting)
        await s.refresh()
        #expect(s.link == .live && s.spaces.map(\.id) == ["private/default", "team/growth-ops", "team/merchant-success"] && s.asOf != nil)
        #expect(s.conversations.count == 8)
        // asks first, then done (unread), then idle by recency
        #expect(s.privateRows.map(\.title) == ["Draft the weekly partner digest", "Summarise sprint tickets for the retro", "Compare two cashback rate tables", "Plan the Q1 offsite agenda", "Rewrite onboarding email copy"])
        let digest = try #require(s.conversation("ses_fakeDigest02"))
        #expect(digest.state == .blocked)
        let ask = try #require(digest.ask)
        #expect(ask.text == "Which week should the digest cover? Which format?" && ask.tag == "Answer sheet · 2 questions")
        #expect(s.asks.map(\.id) == ["ses_fakeDigest02"] && s.workingCount == 1 && s.working(inTeam: true) == 1 && s.asks(inTeam: true) == 0)
        #expect(s.teamRows.map(\.state) == [.working, .done, .idle] && s.conversation("ses_fakeSprint03")?.state == .done)
    }

    @Test func theStreamMovesARowToNeedsYouAndFillsAShownTimeline() async throws {
        let world = FakeCampusWorld()
        let (s, _) = makeStore(world)
        await s.refresh()
        s.start()
        s.retain("ses_fakeRates01")
        #expect(await until { s.timeline("ses_fakeRates01")?.loaded == true })
        #expect(await until { world.subscriberCount == 1 })
        world.startRun("ses_fakeRates01", userText: nil, ask: true)
        // The list can show the row as needing you a moment before the question's own frame arrives, so wait for the question, its form and the reply.
        #expect(await until(8) { s.conversation("ses_fakeRates01")?.state == .blocked && s.conversation("ses_fakeRates01")?.ask != nil && s.openForms["ses_fakeRates01"] != nil
            && s.timeline("ses_fakeRates01")?.items.contains { $0.kind == .text && $0.text.contains("14 of the 20") } == true })
        let c = try #require(s.conversation("ses_fakeRates01"))
        #expect(c.ask?.text == "Which merchants should the summary lead with?" && s.asks.first?.id == "ses_fakeRates01")
        let tl = try #require(s.timeline("ses_fakeRates01"))
        #expect(tl.items.contains { $0.kind == .tool && $0.tool == "shell" } && tl.items.contains { $0.kind == .text && $0.text.contains("14 of the 20") })
        #expect(s.openForms["ses_fakeRates01"]?.questions.count == 1)
        s.stop()
    }

    @Test func aDroppedStreamReconnectsAndTheGapIsClosed() async throws {
        let world = FakeCampusWorld()
        let (s, auth) = makeStore(world)
        await s.refresh(); s.start()
        s.retain("ses_fakeRates01")
        #expect(await until { world.subscriberCount == 1 && s.streamLive })
        world.dropStreams()
        #expect(await until { s.reconnects >= 1 && s.streamLive })
        #expect(auth.streamsOpened >= 2)
        // Something said while the stream was away is still found: the run starts with no stream, the backfill reads it.
        world.dropStreams()
        world.startRun("ses_fakeRates01", userText: "while away", ask: false)
        #expect(await until(8) { s.timeline("ses_fakeRates01")?.items.contains { $0.kind == .user && $0.text == "while away" } == true })
        s.stop()
    }

    @Test func anIdleStreamIsCutAndReopened() async throws {
        let (s, auth) = makeStore()
        s.streamIdleLimit = 0.4
        await s.refresh(); s.start()
        #expect(await until { auth.streamsOpened >= 1 && s.streamLive })
        #expect(await until(5) { auth.streamsOpened >= 2 })
        s.stop()
    }

    @Test func anExpiredLoginKeepsTheLastRowsDimmedWithAnAsOfTimeAndCountsNoAsks() async throws {
        let (s, auth) = makeStore()
        await s.refresh()
        let asOf = try #require(s.asOf)
        #expect(s.asks.count == 1)
        auth.override = { _ in CampusReply(status: 401, body: Data(#"{"error":"unauthenticated"}"#.utf8)) }
        await s.refresh()
        #expect(s.link == .expired && s.conversations.count == 8 && s.asOf == asOf && s.asks.isEmpty)
        auth.override = { _ in CampusReply(status: 200, body: Data("<html>sign in</html>".utf8), loginRedirect: true) }
        await s.refresh()
        #expect(s.link == .expired)
        auth.override = nil
        await s.refresh()
        #expect(s.link == .live && s.asOf! > asOf && s.asks.count == 1)
    }

    @Test func aCampusThatIsStartingShowsStartingUntilItAnswers() async throws {
        let (s, auth) = makeStore()
        auth.override = { _ in CampusReply(status: 503, body: Data(#"{"error":"opencode_starting"}"#.utf8)) }
        await s.refresh()
        #expect(s.link == .starting && s.conversations.isEmpty)
        auth.override = nil
        s.start()
        #expect(await until { s.link == .live && s.conversations.count == 8 })
        s.stop()
    }

    @Test func noAnswerAtAllIsUnreachableNotExpired() async throws {
        let (s, auth) = makeStore()
        auth.offline = true
        await s.refresh()
        if case .unreachable = s.link {} else { Issue.record("link was \(s.link)") }
        auth.offline = false
        await s.refresh()
        #expect(s.link == .live)
    }

    @Test func aSpaceThatDoesNotAnswerKeepsItsRows() async throws {
        let (s, auth) = makeStore()
        await s.refresh()
        auth.override = { $0.path.contains("/growth-ops/") ? CampusReply(status: 500) : nil }
        await s.refresh()
        #expect(s.link == .live && s.conversations.count == 8)
    }

    @Test func markingSeenClearsDoneOnlyInConn() async throws {
        let (s, _) = makeStore()
        await s.refresh()
        #expect(s.conversation("ses_fakeSprint03")?.state == .done)
        s.markSeen("ses_fakeSprint03")
        #expect(s.conversation("ses_fakeSprint03")?.state == .idle)
        await s.refresh()
        #expect(s.conversation("ses_fakeSprint03")?.state == .idle)       // the same update does not make it done again
    }

    @Test func aConversationNamedByALinkIsAddedAndKept() async throws {
        let (s, _) = makeStore()
        await s.refresh()
        s.setConversation(CampusConversation(id: "ses_fakeElse99", title: "x", spaceKind: "private", folder: "default"))
        let c = await s.ensureConversation(kind: "private", folder: "default", id: "ses_fakeOffsite04")
        #expect(c?.title == "Plan the Q1 offsite agenda")
        #expect(await s.ensureConversation(kind: "private", folder: "../x", id: "ses_fakeOffsite04") != nil)       // already known
        #expect(await s.ensureConversation(kind: "private", folder: "../x", id: "ses_unknown123") == nil)
    }

    @Test func fixtureContentIsInvented() {
        let w = FakeCampusWorld()
        let all = [try? w.route(method: "GET", path: "/api/spaces/private/default/conversations", cookie: nil, body: nil).body,
                   w.route(method: "GET", path: "/api/spaces/private/default/conversations/ses_fakeSprint03/message", cookie: nil, body: nil).body].compactMap { $0 }
        for d in all { let t = String(decoding: d, as: UTF8.self).lowercased(); #expect(!t.contains("shopback") && !t.contains("ses_e4c12")) }
    }
}

@Suite("Campus: the stand-in server's cookie gate") struct CampusServerTests {
    @Test func theApiAnswers401WithoutTheCookieAndTheLoginPageSetsItHttpOnly() async throws {
        let world = FakeCampusWorld(authMode: .cookie)
        world.stepDelay = 0.01
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
        #expect(try await get("/api/spaces").0 == 401)
        #expect(try await get("/campus/api/me").0 == 401)
        let login = try await get("/campus/login/ok")
        let setCookie = try #require(login.2.value(forHTTPHeaderField: "Set-Cookie"))
        #expect(setCookie.contains("HttpOnly") && setCookie.contains("campus_session="))
        let cookie = String(setCookie.split(separator: ";")[0])
        let spaces = try await get("/api/spaces", cookie: cookie)
        #expect(spaces.0 == 200 && CampusSpace.parseList(spaces.1)?.count == 3)
        world.setStarting(true)
        let starting = try await get("/api/spaces", cookie: cookie)
        #expect(starting.0 == 503 && CampusJSON.parse(starting.1)?["error"].string == "opencode_starting")
        world.setStarting(false)
        // The event stream arrives in chunks and carries the run's frames.
        var r = URLRequest(url: URL(string: base + "/api/events")!)
        r.setValue(cookie, forHTTPHeaderField: "Cookie")
        let (bytes, resp) = try await net.bytes(for: r)
        #expect((resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") == "text/event-stream")
        world.startRun("ses_fakeRates01", userText: nil, ask: false)
        var reader = CampusSSEReader(); var types: [String] = []
        var line = ""
        loop: for try await b in bytes {
            line.append(Character(UnicodeScalar(b)))
            if line.hasSuffix("\n\n") { for f in reader.feed(line) { types.append(f.type) }; line = ""; if types.contains("session.idle") { break loop } }
        }
        #expect(types.first == "server.connected" && types.contains("session.tool.success") && types.last == "session.idle")
        world.expireLogin()
        #expect(try await get("/api/spaces", cookie: cookie).0 == 401)
    }
}
