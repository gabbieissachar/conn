// Real Campus answers 403 (not 401) to a person who is not signed in, so a 403 is a sign-out on every path (the list, a timeline read, the event stream, a write),
// except the 403 that names a missing module (`{"error":"module_required",...}`): the person is signed in and the refusal keeps its own name.
import Testing
import Foundation
import ConnCore
import FakeCampusKit

@MainActor private func until(_ timeout: Double = 5, _ cond: () -> Bool) async -> Bool {
    var t = 0.0
    while !cond() && t < timeout { try? await Task.sleep(nanoseconds: 20_000_000); t += 0.02 }
    return cond()
}

private let moduleBody = Data(#"{"error":"module_required","module":"ide"}"#.utf8)
private let forbidden = CampusReply(status: 403, body: Data(#"{"error":"forbidden"}"#.utf8))

@MainActor private func makeStore() -> (CampusStore, FakeCampusAuth, FakeCampusWorld) {
    let world = FakeCampusWorld()
    world.stepDelay = 0.01
    let auth = FakeCampusAuth(world: world)
    let s = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
    s.pollInterval = 0.2; s.streamPollInterval = 0.5; s.retryInterval = 0.1; s.statusDelay = 0.02; s.reconnectMax = 0.2; s.holdSeconds = 0.05
    return (s, auth, world)
}

@Suite("Campus: a 403 is a sign-out") @MainActor struct CampusSignedOutTests {
    @Test func theReplyReadsWhichAnswersMeanSignedOut() {
        #expect(CampusReply(status: 401).signedOut)
        #expect(forbidden.signedOut)
        #expect(CampusReply(status: 403).signedOut)                                    // no body at all
        #expect(CampusReply(status: 200, body: Data("<html>".utf8), loginRedirect: true).signedOut)
        #expect(!CampusReply(status: 200).signedOut && !CampusReply(status: 404).signedOut && !CampusReply(status: 500).signedOut && !CampusReply(status: 503).signedOut)
        let module = CampusReply(status: 403, body: moduleBody)
        #expect(module.moduleRequired && !module.signedOut)
        #expect(module.failureText.contains("ide module") && module.failureText.contains("module_required"))
        #expect(!CampusReply(status: 401, body: moduleBody).moduleRequired)           // only a 403 is a module refusal
        #expect(CampusReply(status: 403, body: Data(#"{"error":"module_required"}"#.utf8)).failureText.contains("a module"))
        #expect(CampusReply(status: 500).failureText == "Campus answered 500")
    }

    @Test func neverSignedInShowsTheSignedOutStateNotUnreachable() async throws {
        let (s, auth, _) = makeStore()
        auth.override = { _ in forbidden }
        await s.refresh()
        // The state the sidebar turns into "Sign in to Campus": signed out, nothing ever read, no 'as of' time.
        #expect(s.link == .expired && s.conversations.isEmpty && s.asOf == nil && s.asks.isEmpty)
    }

    @Test func signedInEarlierThenA403KeepsTheLastRowsAndComesBackAfterTheSignIn() async throws {
        let (s, auth, _) = makeStore()
        await s.refresh()
        let asOf = try #require(s.asOf)
        #expect(s.asks.count == 1)
        auth.override = { _ in forbidden }
        await s.refresh()
        #expect(s.link == .expired && s.conversations.count == 8 && s.asOf == asOf && s.asks.isEmpty)
        auth.override = nil
        await s.refresh()
        #expect(s.link == .live && s.asOf! > asOf && s.asks.count == 1)
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

    @Test func aTimelineReadThatAnswers403SignsOutToo() async throws {
        let (s, auth, _) = makeStore()
        await s.refresh()
        auth.override = { $0.path.contains("/message") ? forbidden : nil }
        s.retain("ses_fakeSprint03")
        #expect(await until { s.link == .expired })
        s.release("ses_fakeSprint03")
    }

    @Test func aStreamThatOpensWith403IsSignedOutUnlessItNamesAModule() async throws {
        let (s, auth, _) = makeStore()
        s.pollInterval = 60; s.streamPollInterval = 60; s.retryInterval = 60            // only the stream may change the link in this test
        await s.refresh()
        #expect(s.link == .live)
        auth.streamAnswer = (403, "status 403 module_required")
        s.start()
        #expect(await until { auth.streamsOpened >= 3 })
        #expect(s.link == .live)                                                         // reopened again and again, never signed out
        auth.streamAnswer = (403, "status 403")
        #expect(await until { s.link == .expired })
        s.stop()
    }

    @Test func aWriteRefusedWith403SignsOutAndReturnsTheText() async throws {
        let (s, auth, world) = makeStore()
        await s.refresh()
        s.writesEnabled = true
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        auth.override = { $0.method == "POST" ? forbidden : nil }
        var restored: [String] = []
        _ = s.send("Please keep this", to: c) { restored.append($0) }
        #expect(await until { s.link == .expired })
        #expect(await until { if case .failed = s.held?.phase { return true }; return false })
        #expect(restored == ["Please keep this"] && world.writes().isEmpty)
        if case .failed(let why)? = s.held?.phase { #expect(why == "Campus answered 403") }
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

@Suite("Campus: the stand-in answers 403 when signed out") struct CampusSignedOutServerTests {
    @Test func theStandInCanAnswer403WithoutTheCookieAndNameAMissingModule() async throws {
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
        #expect(try await get("/api/spaces").0 == 401)                                   // the default stays 401
        _ = try await get("/__fake/signed-out-status?code=403")
        let out = try await get("/api/spaces")
        #expect(out.0 == 403 && CampusReply(status: out.0, body: out.1).signedOut)
        #expect(try await get("/campus/api/me").0 == 403)
        let login = try await get("/campus/login/ok")
        let cookie = String(try #require(login.2.value(forHTTPHeaderField: "Set-Cookie")).split(separator: ";")[0])
        #expect(try await get("/api/spaces", cookie: cookie).0 == 200)
        _ = try await get("/__fake/module-required?on=1")
        let module = try await get("/api/spaces", cookie: cookie)
        let reply = CampusReply(status: module.0, body: module.1)
        #expect(module.0 == 403 && reply.moduleRequired && !reply.signedOut)
        _ = try await get("/__fake/module-required?on=0")
        world.expireLogin()
        #expect(try await get("/api/spaces", cookie: cookie).0 == 403)                    // signed out again: 403 now
        _ = try await get("/__fake/signed-out-status?code=401")
        #expect(try await get("/api/spaces", cookie: cookie).0 == 401)
    }
}
