// The silent Campus session refresh (J7=a): reading a token's expiry, when to try, what an attempt came to, the log, and the keeper that runs it, over the
// stand-in Campus (renews, sends to another site's account chooser, never answers). The web view itself is checked by `--campus-check`.
import Testing
import Foundation
import ConnCore
import FakeCampusKit

@MainActor private func until(_ timeout: Double = 5, _ cond: () -> Bool) async -> Bool {
    var t = 0.0
    while !cond() && t < timeout { try? await Task.sleep(nanoseconds: 20_000_000); t += 0.02 }
    return cond()
}

private func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

@Suite("Campus refresh: a token's expiry") struct CampusTokenExpiryTests {
    @Test func readsExpFromTheMiddleSegmentOfAJWT() {
        let token = "h." + b64(#"{"exp":1800003600,"sub":"x"}"#) + ".s"
        #expect(CampusSessionToken.expiry(of: token) == Date(timeIntervalSince1970: 1_800_003_600))
        // A payload whose base64 needs padding, and the url-safe alphabet.
        let odd = "h." + b64(#"{"exp":1800003600,"name":"???>>>"}"#) + ".s"
        #expect(CampusSessionToken.expiry(of: odd) == Date(timeIntervalSince1970: 1_800_003_600))
        #expect(CampusSessionToken.expiry(of: "h." + b64(#"{"exp":1800003600.5}"#) + ".s") != nil)
    }

    @Test func aTokenWithoutAnExpiryIsNotOne() {
        #expect(CampusSessionToken.expiry(of: "") == nil)
        #expect(CampusSessionToken.expiry(of: "plain-cookie-value") == nil)
        #expect(CampusSessionToken.expiry(of: "a.b") == nil)
        #expect(CampusSessionToken.expiry(of: "a.b.c.d") == nil)
        #expect(CampusSessionToken.expiry(of: "h.!!!.s") == nil)
        #expect(CampusSessionToken.expiry(of: "h." + b64(#"{"sub":"x"}"#) + ".s") == nil)
        #expect(CampusSessionToken.expiry(of: "h." + b64(#"{"exp":"soon"}"#) + ".s") == nil)
        #expect(CampusSessionToken.expiry(of: "h." + b64(#"{"exp":0}"#) + ".s") == nil)
        #expect(CampusSessionToken.expiry(of: "h." + b64(#"[1,2]"#) + ".s") == nil)
    }

    @Test func theStandInsTokensCarryTheirExpiry() {
        let exp = Date(timeIntervalSince1970: 1_800_000_900)
        let token = FakeCampusWorld.makeToken(exp: exp, serial: 1)
        #expect(token.hasPrefix(FakeCampusWorld.tokenMarker) && CampusSessionToken.expiry(of: token) == exp)
    }
}

@Suite("Campus refresh: the rules") struct CampusRenewalRuleTests {
    private let host = "campus.shopback.com"
    private func page(_ s: String) -> CampusRenewalPage { CampusRenewalRules.page(for: URL(string: s)!, campusHost: host) }

    @Test func aPageIsCampusItsLoginOrAnotherSite() {
        #expect(page("https://campus.shopback.com/campus/login") == .login)
        #expect(page("https://campus.shopback.com/campus/login?next=%2F") == .login)
        #expect(page("https://campus.shopback.com/login") == .login)
        #expect(page("https://CAMPUS.shopback.com/campus/") == .campus)
        #expect(page("https://campus.shopback.com/spaces/private/default/conversations/ses_x") == .campus)
        #expect(page("https://campus.shopback.com/spaces/private/login-notes") == .campus)          // "login" must be a whole path part near the root
        #expect(page("https://accounts.google.com/o/oauth2/v2/auth?client_id=x") == .elsewhere)
        #expect(page("https://campus.shopback.com.evil.example/campus/") == .elsewhere)
        #expect(page("http://localhost:8080/campus/") == .elsewhere)
    }

    @Test func successNeedsCampusSignedInWithALaterExpiry() {
        let later = t0.addingTimeInterval(3600), earlier = t0
        func o(_ settled: CampusRenewalPage?, timedOut: Bool = false, failed: Bool = false, blocked: Bool = false, old: Date? = earlier, new: Date? = later) -> CampusRenewalOutcome {
            CampusRenewalRules.outcome(settled: settled, timedOut: timedOut, failed: failed, blocked: blocked, oldExpiry: old, newExpiry: new)
        }
        #expect(o(.campus) == .renewed)
        #expect(o(.campus, old: nil) == .renewed)                                    // there was no readable expiry before, now there is
        #expect(o(.campus, new: earlier) == .needsSignIn)                            // back on Campus but nothing renewed
        #expect(o(.campus, new: earlier.addingTimeInterval(-10)) == .needsSignIn)
        #expect(o(.campus, new: nil) == .needsSignIn)                                // no session cookie at all
        #expect(o(.login) == .needsSignIn)
        #expect(o(.elsewhere) == .needsSignIn)
        #expect(o(.elsewhere, new: later.addingTimeInterval(9999)) == .needsSignIn)  // a later expiry does not excuse a page that waits
        #expect(o(.campus, timedOut: true) == .timeout)
        #expect(o(nil, timedOut: true) == .timeout)
        #expect(o(.campus, failed: true) == .error)
        #expect(o(nil) == .error)
        #expect(o(nil, timedOut: true, failed: true) == .error)
        // The network's 403 page is blocked, never "sign in again", wherever the view stood still.
        #expect(o(nil, blocked: true) == .blocked)
        #expect(o(.login, blocked: true) == .blocked && o(.elsewhere, blocked: true) == .blocked && o(.campus, blocked: true) == .blocked)
        #expect(o(nil, timedOut: true, blocked: true) == .blocked)
    }

    @Test func eachOutcomeHasAWordForSettings() {
        #expect(Set([CampusRenewalOutcome.renewed, .needsSignIn, .timeout, .error, .blocked].map(\.label)).count == 5)
        #expect(CampusRenewalOutcome.blocked.rawValue == "blocked" && CampusRenewalOutcome.blocked.label == "blocked by the network")
        #expect(CampusRenewalOutcome.needsSignIn.rawValue == "needs-sign-in" && CampusRenewalOutcome.timeout.rawValue == "time-out")
    }
}

@Suite("Campus refresh: when to try") struct CampusRenewalPlannerTests {
    private let planner = CampusRenewalPlanner(lead: 300, retryAfter: 60, maxAttempts: 3)
    private func attempt(_ at: Date, _ outcome: CampusRenewalOutcome, old: Date) -> CampusRenewalAttempt { CampusRenewalAttempt(at: at, oldExpiry: old, newExpiry: old, outcome: outcome) }

    @Test func noSessionMeansNothingToDo() {
        #expect(planner.next(now: t0, expiry: nil, history: []) == .idle)
    }

    @Test func itWaitsUntilFiveMinutesBeforeTheExpiryThenTries() {
        let exp = t0.addingTimeInterval(3600)
        #expect(planner.next(now: t0, expiry: exp, history: []) == .wait(until: exp.addingTimeInterval(-300)))
        #expect(planner.next(now: exp.addingTimeInterval(-301), expiry: exp, history: []) == .wait(until: exp.addingTimeInterval(-300)))
        #expect(planner.next(now: exp.addingTimeInterval(-300), expiry: exp, history: []) == .attemptNow)
        #expect(planner.next(now: exp.addingTimeInterval(-10), expiry: exp, history: []) == .attemptNow)
        // A session that already ended (a laptop that slept) gets one try at once.
        #expect(planner.next(now: exp.addingTimeInterval(500), expiry: exp, history: []) == .attemptNow)
    }

    @Test func aTimeoutOrAFailedLoadIsTriedAgainAfterAWhileAndNotForever() {
        let exp = t0.addingTimeInterval(3600), first = exp.addingTimeInterval(-300)
        var h = [attempt(first, .timeout, old: exp)]
        #expect(planner.next(now: first.addingTimeInterval(30), expiry: exp, history: h) == .wait(until: first.addingTimeInterval(60)))
        #expect(planner.next(now: first.addingTimeInterval(60), expiry: exp, history: h) == .attemptNow)
        h.append(attempt(first.addingTimeInterval(60), .error, old: exp))
        #expect(planner.next(now: first.addingTimeInterval(120), expiry: exp, history: h) == .attemptNow)
        h.append(attempt(first.addingTimeInterval(120), .timeout, old: exp))
        #expect(planner.next(now: first.addingTimeInterval(500), expiry: exp, history: h) == .idle)         // three tries are used up
    }

    @Test func aNeedsSignInAnswerIsNeverTriedAgainForTheSameExpiry() {
        let exp = t0.addingTimeInterval(3600), first = exp.addingTimeInterval(-300)
        let h = [attempt(first, .needsSignIn, old: exp)]
        #expect(planner.next(now: first.addingTimeInterval(1000), expiry: exp, history: h) == .idle)
        // A new sign-in moves the expiry and its history starts empty.
        let exp2 = exp.addingTimeInterval(3600)
        #expect(planner.next(now: first.addingTimeInterval(1000), expiry: exp2, history: []) == .wait(until: exp2.addingTimeInterval(-300)))
    }
}

@Suite("Campus refresh: the log") struct CampusRenewalLogTests {
    private func tempFile() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("conn-renew-\(UUID().uuidString)/campus/session-refresh.log") }

    @Test func appendsOneLinePerAttemptAndReadsThemBack() throws {
        let f = tempFile()
        let log = CampusRenewalLog(file: f)
        #expect(log.recent().isEmpty)
        let a = CampusRenewalAttempt(at: t0, oldExpiry: t0.addingTimeInterval(300), newExpiry: t0.addingTimeInterval(3900), outcome: .renewed)
        let b = CampusRenewalAttempt(at: t0.addingTimeInterval(3600), oldExpiry: t0.addingTimeInterval(3900), newExpiry: nil, outcome: .needsSignIn)
        log.append(a); log.append(b)
        #expect(CampusRenewalLog(file: f).recent() == [a, b])
        #expect(log.recent(1) == [b])
        let text = try String(contentsOf: f, encoding: .utf8)
        #expect(text.split(separator: "\n").count == 2 && text.contains("\"outcome\":\"renewed\"") && text.contains("\"outcome\":\"needs-sign-in\""))
    }

    @Test func holdsOnlyDatesAndAWord() throws {
        let f = tempFile()
        let log = CampusRenewalLog(file: f)
        log.append(CampusRenewalAttempt(at: t0, oldExpiry: t0, newExpiry: t0.addingTimeInterval(60), outcome: .timeout))
        let keys = try #require(try JSONSerialization.jsonObject(with: Data(String(contentsOf: f, encoding: .utf8).utf8)) as? [String: Any]).keys
        #expect(Set(keys) == ["at", "oldExpiry", "newExpiry", "outcome"])
    }

    @Test func staysSmall() throws {
        let f = tempFile()
        let log = CampusRenewalLog(file: f)
        for i in 0..<(CampusRenewalLog.keep * 2 + 10) { log.append(CampusRenewalAttempt(at: t0.addingTimeInterval(Double(i)), oldExpiry: nil, newExpiry: nil, outcome: .error)) }
        let all = log.recent(10_000)
        #expect(all.count <= CampusRenewalLog.keep * 2 && all.count >= CampusRenewalLog.keep)
        #expect(all.last?.at == t0.addingTimeInterval(Double(CampusRenewalLog.keep * 2 + 9)))                // the newest is always kept
    }
}

@Suite("Campus refresh: the keeper over the stand-in Campus") @MainActor struct CampusSessionKeeperTests {
    private final class Clock { var now = Date(); func advance(to d: Date) { now = d } }

    private func make(life: TimeInterval = 600, mode: FakeCampusWorld.RenewMode) -> (CampusSessionKeeper, FakeCampusRenewer, FakeCampusWorld, Clock, CampusRenewalLog) {
        let world = FakeCampusWorld(authMode: .cookie)
        world.setSessionLife(life)
        world.setRenewMode(mode)
        let renewer = FakeCampusRenewer(world: world)
        renewer.signIn()
        let clock = Clock()
        let log = CampusRenewalLog(file: FileManager.default.temporaryDirectory.appendingPathComponent("conn-keeper-\(UUID().uuidString)/session-refresh.log"))
        let keeper = CampusSessionKeeper(renewer: renewer, log: log, planner: CampusRenewalPlanner(lead: 300, retryAfter: 60, maxAttempts: 3), now: { clock.now })
        keeper.attemptTimeout = 0.2
        return (keeper, renewer, world, clock, log)
    }

    @Test func knowsTheExpiryAndWaitsUntilFiveMinutesBefore() async {
        let (keeper, renewer, _, clock, _) = make(mode: .renews)
        let exp = await renewer.sessionExpiry()
        #expect(exp != nil)
        clock.advance(to: exp!.addingTimeInterval(-3000))
        let wait = await keeper.tick()
        #expect(keeper.expiry == exp && renewer.attempts == 0 && !keeper.needsSignIn)
        #expect(wait > 0 && wait <= keeper.pollInterval)
    }

    @Test func renewsFiveMinutesBeforeTheEndAndTheSessionNowEndsLater() async throws {
        let (keeper, renewer, world, clock, log) = make(mode: .renews)
        let old = try #require(await renewer.sessionExpiry())
        world.setSessionLife(3600)                                   // the renewed token lives longer, so its expiry is plainly later
        clock.advance(to: old.addingTimeInterval(-299))
        await keeper.tick()
        let a = try #require(keeper.lastAttempt)
        #expect(a.outcome == .renewed && a.oldExpiry == old && a.newExpiry! > old)
        #expect(keeper.expiry == a.newExpiry && !keeper.needsSignIn && renewer.attempts == 1 && world.renewalCount == 1)
        #expect(log.recent() == [a])
        // The new expiry is an hour off: no second try now.
        await keeper.tick()
        #expect(renewer.attempts == 1)
    }

    @Test func aGoogleAccountChooserStopsAtOnceAndSaysSignInAgain() async throws {
        let (keeper, renewer, world, clock, log) = make(mode: .google)
        let old = try #require(await renewer.sessionExpiry())
        clock.advance(to: old.addingTimeInterval(-200))
        await keeper.tick()
        #expect(keeper.lastAttempt?.outcome == .needsSignIn && keeper.needsSignIn)
        #expect(keeper.expiry == old && renewer.attempts == 1)       // nothing changed: the session is the one it was
        // It does not try again for the same session, however long it waits.
        clock.advance(to: old.addingTimeInterval(-100)); await keeper.tick()
        clock.advance(to: old.addingTimeInterval(-10)); await keeper.tick()
        #expect(renewer.attempts == 1 && keeper.needsSignIn)
        #expect(log.recent().map(\.outcome) == [.needsSignIn])
        // The person signs in by hand: the session moves, the note goes, and the cycle starts over.
        world.setSessionLife(3600); renewer.signIn()
        await keeper.tick()
        #expect(!keeper.needsSignIn && keeper.expiry! > old)
    }

    @Test func theLoginPageItselfAndALandingWithoutARenewalAreSignInAgainToo() async throws {
        // A visit that lands on Campus's own login page (the stand-in's default): it waits for a click.
        let (keeper, renewer, _, clock, _) = make(mode: .page)
        let old = try #require(await renewer.sessionExpiry())
        clock.advance(to: old.addingTimeInterval(-100))
        await keeper.tick()
        #expect(keeper.lastAttempt?.outcome == .needsSignIn && keeper.needsSignIn)
        // Back on Campus, but the session did not move (the cookie was already the newest): not a success.
        let (k2, r2, _, c2, _) = make(mode: .lands)
        let old2 = try #require(await r2.sessionExpiry())
        c2.advance(to: old2.addingTimeInterval(-100))
        await k2.tick()
        #expect(k2.lastAttempt?.outcome == .needsSignIn && k2.needsSignIn)
    }

    @Test func aVisitThatNeverAnswersTimesOutAndIsTriedAgainThenGivenUp() async throws {
        let (keeper, renewer, _, clock, log) = make(mode: .hang)
        let old = try #require(await renewer.sessionExpiry())
        clock.advance(to: old.addingTimeInterval(-250))
        await keeper.tick()
        #expect(keeper.lastAttempt?.outcome == .timeout && !keeper.needsSignIn && renewer.attempts == 1)
        await keeper.tick()                                          // a minute has not passed
        #expect(renewer.attempts == 1)
        clock.advance(to: clock.now.addingTimeInterval(61)); await keeper.tick()
        clock.advance(to: clock.now.addingTimeInterval(61)); await keeper.tick()
        #expect(renewer.attempts == 3)
        clock.advance(to: clock.now.addingTimeInterval(61)); await keeper.tick()
        #expect(renewer.attempts == 3 && !keeper.needsSignIn)
        #expect(log.recent().map(\.outcome) == [.timeout, .timeout, .timeout])
    }

    @Test func aBlockedNetworkIsNotSignInAgainAndIsTriedAgainLaterThenGivenUp() async throws {
        let (keeper, renewer, world, clock, log) = make(mode: .renews)
        let old = try #require(await renewer.sessionExpiry())
        world.setBlockedNetwork(true)                                // off the company private network: nginx's 403 page on /campus/login
        clock.advance(to: old.addingTimeInterval(-250))
        await keeper.tick()
        #expect(keeper.lastAttempt?.outcome == .blocked && !keeper.needsSignIn && renewer.attempts == 1)
        await keeper.tick()                                          // a minute has not passed
        #expect(renewer.attempts == 1)
        clock.advance(to: clock.now.addingTimeInterval(61)); await keeper.tick()
        world.setBlockedNetwork(false)                               // the network is back: the next try renews
        world.setSessionLife(3600)
        clock.advance(to: clock.now.addingTimeInterval(61)); await keeper.tick()
        #expect(renewer.attempts == 3 && keeper.lastAttempt?.outcome == .renewed && !keeper.needsSignIn)
        #expect(log.recent().map(\.outcome) == [.blocked, .blocked, .renewed])
        world.setRenewMode(.google)
    }

    @Test func aSessionThatAlreadyEndedGetsOneTry() async throws {
        let (keeper, renewer, _, clock, _) = make(mode: .google)
        let old = try #require(await renewer.sessionExpiry())
        clock.advance(to: old.addingTimeInterval(4000))
        await keeper.tick(); await keeper.tick()
        #expect(renewer.attempts == 1 && keeper.needsSignIn)
    }

    @Test func noSessionCookieMeansNoVisit() async {
        let (keeper, renewer, _, clock, _) = make(mode: .renews)
        renewer.clearCookie()
        clock.advance(to: Date().addingTimeInterval(100_000))
        await keeper.tick()
        #expect(keeper.expiry == nil && renewer.attempts == 0 && !keeper.needsSignIn)
    }

    @Test func nothingIsTriedWhileTheSignInSheetIsOpen() async throws {
        let (keeper, renewer, _, clock, _) = make(mode: .renews)
        let old = try #require(await renewer.sessionExpiry())
        clock.advance(to: old.addingTimeInterval(-100))
        keeper.paused = true
        await keeper.tick()
        #expect(renewer.attempts == 0)
        keeper.paused = false
        await keeper.tick()
        #expect(renewer.attempts == 1)
    }

    @Test func theLoopTriesOnItsOwnWhenTheTimeComesAndNudgeReadsTheCookieAgain() async throws {
        let (keeper, renewer, world, _, _) = make(life: 1, mode: .renews)        // a one-second session: the five-minute lead has long passed
        keeper.pollInterval = 0.1
        world.setSessionLife(3600)
        keeper.start()
        defer { keeper.stop() }
        #expect(await until(5) { keeper.lastAttempt?.outcome == .renewed })
        #expect(renewer.attempts == 1)
        // A new sign-in is noticed on a nudge, without waiting out the poll.
        keeper.pollInterval = 60
        renewer.overrideExpiry = .some(nil)
        keeper.nudge()
        #expect(await until(5) { keeper.expiry == nil })
    }

    @Test func nothingTheKeeperHoldsOrWritesIsATokenOrACookie() async throws {
        let (keeper, renewer, _, clock, log) = make(mode: .renews)
        let old = try #require(await renewer.sessionExpiry())
        clock.advance(to: old.addingTimeInterval(-100))
        await keeper.tick()
        let held = String(describing: keeper.lastAttempt as Any) + String(describing: keeper.expiry as Any)
        let written = try String(contentsOf: log.file, encoding: .utf8)
        for text in [held, written] { #expect(!text.contains(FakeCampusWorld.tokenMarker) && !text.contains("campus_session") && !text.contains("not-a-signature")) }
    }

    @Test func aRestartShowsTheLastLoggedAttempt() async throws {
        let (keeper, renewer, _, clock, log) = make(mode: .google)
        let old = try #require(await renewer.sessionExpiry())
        clock.advance(to: old.addingTimeInterval(-100))
        await keeper.tick()
        let again = CampusSessionKeeper(renewer: renewer, log: log)
        #expect(again.lastAttempt == keeper.lastAttempt && again.lastAttempt?.outcome == .needsSignIn)
    }
}

@Suite("Campus refresh: the stand-in server's silent sign-in over real HTTP") struct CampusRenewalServerTests {
    @Test func theStandInRenewsSendsAwayOrHoldsAsTold() async throws {
        let world = FakeCampusWorld(authMode: .cookie)
        let server = FakeCampusServer(world: world)
        try server.start()
        defer { server.stop() }
        let base = "http://127.0.0.1:\(server.port)"
        final class NoRedirect: NSObject, URLSessionTaskDelegate {
            func urlSession(_ s: URLSession, task: URLSessionTask, willPerformHTTPRedirection r: HTTPURLResponse, newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
        }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpShouldSetCookies = false
        let net = URLSession(configuration: cfg, delegate: NoRedirect(), delegateQueue: nil)
        func get(_ path: String, cookie: String? = nil) async throws -> (Int, Data, HTTPURLResponse) {
            var r = URLRequest(url: URL(string: base + path)!)
            if let c = cookie { r.setValue(c, forHTTPHeaderField: "Cookie") }
            let (d, resp) = try await net.data(for: r)
            let h = resp as! HTTPURLResponse
            return (h.statusCode, d, h)
        }
        world.setSessionLife(600)
        let login = try await get("/campus/login/ok")
        let first = String(try #require(login.2.value(forHTTPHeaderField: "Set-Cookie")).split(separator: ";")[0])
        let firstExp = try #require(CampusSessionToken.expiry(of: String(first.dropFirst("campus_session=".count))))
        #expect(try await get("/api/spaces", cookie: first).0 == 200)
        // Default: the login page itself.
        #expect(try await get("/campus/login", cookie: first).0 == 200)
        // Renews: a redirect into the app with a new token that ends later.
        world.setSessionLife(3600); _ = try await get("/__fake/renew?mode=renews")
        let renewed = try await get("/campus/login", cookie: first)
        #expect(renewed.0 == 302 && renewed.2.value(forHTTPHeaderField: "Location") == "/campus/")
        let second = String(try #require(renewed.2.value(forHTTPHeaderField: "Set-Cookie")).split(separator: ";")[0])
        #expect(CampusSessionToken.expiry(of: String(second.dropFirst("campus_session=".count)))! > firstExp)
        #expect(try await get("/api/spaces", cookie: second).0 == 200 && world.renewalCount == 1)
        // Without a valid session the renewing path shows the login page.
        #expect(try await get("/campus/login").0 == 200)
        // Google: another host name.
        _ = try await get("/__fake/renew?mode=google")
        let g = try await get("/campus/login", cookie: second)
        #expect(g.0 == 302 && g.2.value(forHTTPHeaderField: "Location")?.hasPrefix("http://localhost:\(server.port)/__fake/google") == true)
        #expect(String(decoding: try await get("/__fake/google").1, as: UTF8.self).contains("Choose an account"))
    }

    @Test func aSessionThatRanOutIsSignedOutToTheStandIn() async throws {
        let world = FakeCampusWorld(authMode: .cookie)
        world.setSessionLife(1)
        let r = world.route(method: "GET", path: "/campus/login/ok", cookie: nil, body: nil)
        let cookie = String(try #require(r.headers["Set-Cookie"]).split(separator: ";")[0])
        #expect(world.route(method: "GET", path: "/api/spaces", cookie: cookie, body: nil).status == 200)
        try await Task.sleep(nanoseconds: 1_300_000_000)
        #expect(world.route(method: "GET", path: "/api/spaces", cookie: cookie, body: nil).status == 401)
    }
}
