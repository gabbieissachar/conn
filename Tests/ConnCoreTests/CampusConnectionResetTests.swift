// Nathan's Zscaler case (2026-11-09): the network refused Campus, he turned Zscaler private access on, and "Try again" kept meeting the 403 until Conn was quit and reopened.
// WebKit reuses a pooled connection for every look, so a connection that was open while the network refused keeps answering the refusal; only a new one gets through
// (`FakeCampusServer` models it with a sticky block, and `--campus-check` runs it through Conn's real web views). The store's half is when Conn asks its auth to drop
// the connection: at once on Try again, and by itself, rarely, while the network keeps refusing. These tests run it over a stand-in auth that counts the drops.
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

private let nginx = CampusReply(status: 403, body: Data(FakeCampusWorld.nginxForbidden.utf8))

@MainActor private func makeStore() -> (CampusStore, FakeCampusAuth) {
    let world = FakeCampusWorld()
    world.stepDelay = 0.01
    let auth = FakeCampusAuth(world: world)
    let s = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
    s.pollInterval = 0.2; s.streamPollInterval = 0.5; s.retryInterval = 0.05; s.statusDelay = 0.02; s.reconnectMax = 0.2; s.holdSeconds = 0.05
    return (s, auth)
}

@Suite("Campus: dropping a connection that outlived the refusal") @MainActor struct CampusConnectionResetTests {
    @Test func tryAgainDropsTheConnectionBeforeAskingAgain() async throws {
        let (s, auth) = makeStore()
        s.blockedResetInterval = 3600                                  // not by itself in this test
        auth.override = { _ in nginx }
        s.start()
        #expect(await until { s.link == .blocked })
        #expect(auth.resets == 0)
        auth.override = nil                                            // the network answers again
        s.retry()
        #expect(await until { s.link == .live })
        #expect(auth.resets == 1 && s.resetCount == 1)
        s.stop()
    }

    @Test func aPlainLookNeverDropsTheConnection() async throws {
        let (s, auth) = makeStore()
        s.blockedResetInterval = 3600
        await s.refresh()
        s.kick()
        await s.refresh()
        #expect(auth.resets == 0 && s.resetCount == 0)
    }

    @Test func whileTheNetworkKeepsRefusingTheConnectionIsDroppedByItselfNotAtOnce() async throws {
        let (s, auth) = makeStore()
        s.blockedResetInterval = 0.4
        auth.override = { _ in nginx }
        s.start()
        #expect(await until { s.link == .blocked })
        #expect(auth.resets == 0)                                      // a brief refusal is not met with a drop
        #expect(await until { auth.resets >= 1 })
        // It goes on every interval while the refusal lasts (spaced by the interval, not once per look) ...
        let first = auth.resets
        #expect(await until { auth.resets >= first + 1 })
        // ... and stops once the network answers.
        auth.override = nil
        #expect(await until { s.link == .live })
        let atLive = auth.resets
        try? await Task.sleep(nanoseconds: 700_000_000)
        #expect(auth.resets == atLive)
        s.stop()
    }

    @Test func aSecondRefusalStartsItsOwnWaitInsteadOfDroppingAtOnce() async throws {
        let (s, auth) = makeStore()
        s.blockedResetInterval = 0.5
        auth.override = { _ in nginx }
        s.start()
        #expect(await until { auth.resets >= 1 })
        auth.override = nil
        #expect(await until { s.link == .live })
        let before = auth.resets
        auth.override = { _ in nginx }                                 // refused again, a long while after the last drop
        s.kick()
        #expect(await until { s.link == .blocked })
        #expect(auth.resets == before)                                 // the clock of this refusal has only just started
        s.stop()
    }

    @Test func aSignedOutOrUnreachableCampusIsNeverReset() async throws {
        let (s, auth) = makeStore()
        s.blockedResetInterval = 0.1
        auth.override = { _ in CampusReply(status: 401, body: Data(#"{"error":"no valid campus_session cookie"}"#.utf8)) }
        s.start()
        #expect(await until { s.link == .expired })
        try? await Task.sleep(nanoseconds: 500_000_000)
        #expect(auth.resets == 0)
        s.stop()
    }
}

@Suite("Campus: which cookies a new store takes over") struct CampusCookieScopeTests {
    @Test func campusHostAndItsParentDomainsAndGoogleAreCarried() {
        let host = "campus.shopback.com"
        for d in ["campus.shopback.com", ".campus.shopback.com", "shopback.com", ".shopback.com", "CAMPUS.ShopBack.com"] { #expect(CampusCookieScope.isCampus(domain: d, campusHost: host), "\(d)") }
        for d in ["google.com", ".google.com", "accounts.google.com", ".accounts.google.com"] { #expect(CampusCookieScope.isGoogle(domain: d) && CampusCookieScope.carriesSignIn(domain: d, campusHost: host), "\(d)") }
    }

    @Test func otherSitesAreNotCarried() {
        let host = "campus.shopback.com"
        for d in ["example.com", "evilgoogle.com", "google.com.evil.test", "notshopback.com", "other.shopback.com", "", "."] {
            #expect(!CampusCookieScope.carriesSignIn(domain: d, campusHost: host), "\(d)")
        }
    }

    @Test func onlyCampusHostItselfIsTakenOutOfASharedStore() {
        let host = "campus.shopback.com"
        #expect(CampusCookieScope.isExactly(domain: "campus.shopback.com", campusHost: host) && CampusCookieScope.isExactly(domain: ".campus.shopback.com", campusHost: host))
        // A parent domain's cookies serve other sites in a shared store: copied, never deleted.
        #expect(!CampusCookieScope.isExactly(domain: ".shopback.com", campusHost: host) && !CampusCookieScope.isExactly(domain: ".google.com", campusHost: host))
    }
}
