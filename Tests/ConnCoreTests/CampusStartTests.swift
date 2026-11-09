// Campus in Conn: starting a conversation (`POST /api/spaces/<kind>/<folder>/conversations`). It goes through the same write gate as every other write: the switch,
// the 3-second Undo, one at a time, nothing lost on a failure. "What reached Campus" is read from the stand-in's own log of the writes it received.
import Testing
import Foundation
import ConnCore
import FakeCampusKit

@MainActor private func until(_ timeout: Double = 5, _ cond: () -> Bool) async -> Bool {
    var t = 0.0
    while !cond() && t < timeout { try? await Task.sleep(nanoseconds: 20_000_000); t += 0.02 }
    return cond()
}

@MainActor private func liveStore(hold: Double = 0.05) async -> (CampusStore, FakeCampusAuth, FakeCampusWorld) {
    let world = FakeCampusWorld()
    world.stepDelay = 0.01
    let auth = FakeCampusAuth(world: world)
    let s = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
    s.holdSeconds = hold; s.statusDelay = 0.02
    await s.refresh()
    return (s, auth, world)
}

private let mine = CampusSpace(kind: "private", folder: "default", displayName: "My space")
private let growth = CampusSpace(kind: "team", folder: "growth-ops", displayName: "Growth Ops")

@Suite("Campus: starting a conversation") @MainActor struct CampusStartTests {
    @Test func offRefusesAndNothingIsSent() async throws {
        let (s, _, world) = await liveStore()
        var made: [CampusConversation?] = []
        #expect(s.startConversation(in: mine, text: "Plan the offsite") { made.append($0) } == .off)
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(world.writes().isEmpty && s.held == nil && made.isEmpty)
    }

    @Test func aStartIsSentOnceAfterTheWindowAndTheNewConversationIsInTheRows() async throws {
        let (s, _, world) = await liveStore(hold: 1.0)
        s.writesEnabled = true
        var made: [CampusConversation?] = []
        #expect(s.startConversation(in: mine, text: "  Plan the offsite dinner  ") { made.append($0) } == nil)
        #expect(s.held?.phase == .held && s.held?.conversationID == CampusStore.startKey(mine))
        #expect(world.writes().isEmpty)                         // still inside the window: read right after the start, not after a pause a busy machine could stretch past it
        #expect(await until(20) { s.held?.phase == .sent })
        let w = world.writes()
        #expect(w.count == 1 && w[0].hasPrefix("POST /api/spaces/private/default/conversations {") && w[0].contains("\"text\":\"Plan the offsite dinner\"") && w[0].contains("[Idempotency-Key: "))
        let c = try #require(made.first ?? nil)
        #expect(made.count == 1 && c.id.hasPrefix("ses_fakeNew") && c.spaceID == "private/default" && c.title == "Plan the offsite dinner" && s.conversation(c.id) != nil)
        // The run the text started is read back: the row is working, and a later list still has it.
        #expect(await until { s.conversation(c.id)?.working == true })
        await s.refresh()
        #expect(s.conversation(c.id) != nil)
    }

    @Test func aTeamSpaceStartsInItsOwnPath() async throws {
        let (s, _, world) = await liveStore()
        s.writesEnabled = true
        var made: [CampusConversation?] = []
        #expect(s.startConversation(in: growth, text: "Refresh the KPI sheet") { made.append($0) } == nil)
        #expect(await until { s.held?.phase == .sent })
        let w = world.writes()
        #expect(w.count == 1 && w[0].hasPrefix("POST /api/spaces/team/growth-ops/conversations {"))
        #expect(made.first??.spaceID == "team/growth-ops" && made.first??.isTeam == true && made.first??.spaceName == "Growth Ops")
    }

    @Test func undoSendsNothingNotEvenAfterTheWindow() async throws {
        let (s, _, world) = await liveStore(hold: 1.0)
        s.writesEnabled = true
        var restored = 0, made = 0
        let t0 = Date()
        #expect(s.startConversation(in: mine, text: "Never mind", restore: { restored += 1 }) { _ in made += 1 } == nil)
        try await Task.sleep(nanoseconds: 100_000_000)
        s.undo()
        guard Date().timeIntervalSince(t0) < 0.8 else { return }
        #expect(s.held?.phase == .undone && restored == 1)
        try await Task.sleep(nanoseconds: 1_200_000_000)
        #expect(world.writes().isEmpty && made == 0)
    }

    @Test func oneAtATimeAndEmptyOrReadOnlyIsInvalid() async throws {
        let (s, _, _) = await liveStore(hold: 0.5)
        s.writesEnabled = true
        #expect(s.startConversation(in: mine, text: "   ") { _ in } == .invalid)
        #expect(s.startConversation(in: CampusSpace(kind: "team", folder: "archive", displayName: "Archive", readOnly: true), text: "hello") { _ in } == .invalid)
        #expect(s.startConversation(in: mine, text: "first") { _ in } == nil)
        #expect(s.startConversation(in: growth, text: "second") { _ in } == .busy)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        #expect(s.send("while a start waits", to: c) { _ in } == .busy)
        s.undo()
    }

    @Test func aSignedOutCampusRefusesTheStart() async throws {
        let (s, auth, world) = await liveStore()
        s.writesEnabled = true
        auth.override = { _ in CampusReply(status: 401) }
        await s.refresh()
        #expect(s.link == .expired)
        #expect(s.startConversation(in: mine, text: "hello") { _ in } == .notLive)
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(world.writes().isEmpty)
    }

    @Test func aFailedStartKeepsTheTextAndTheRetryUsesTheSameKey() async throws {
        let (s, auth, world) = await liveStore()
        s.writesEnabled = true
        var keys: [String] = []
        auth.override = { r in
            guard r.method == "POST" else { return nil }
            keys.append(r.headers["Idempotency-Key"] ?? "none")
            return CampusReply(status: 500)
        }
        var restored = 0
        _ = s.startConversation(in: mine, text: "Summarise the retro", restore: { restored += 1 }) { _ in }
        #expect(await until { if case .failed = s.held?.phase { return true }; return false })
        if case .failed(let why)? = s.held?.phase { #expect(why == "Campus answered 500") }
        #expect(restored == 1 && world.writes().isEmpty)
        _ = s.startConversation(in: mine, text: "Summarise the retro") { _ in }
        #expect(await until { keys.count == 2 && s.held?.phase != .held && s.held?.phase != .sending })
        #expect(keys.count == 2 && keys[0] == keys[1] && keys[0] != "none" && !keys[0].isEmpty)
        // Once it goes through, the next start of the same text is a new start with a new key.
        auth.override = { r in if r.method == "POST" { keys.append(r.headers["Idempotency-Key"] ?? "none") }; return nil }
        _ = s.startConversation(in: mine, text: "Summarise the retro") { _ in }
        #expect(await until { s.held?.phase == .sent && keys.count == 3 })
        _ = s.startConversation(in: mine, text: "Summarise the retro") { _ in }
        #expect(await until { s.held?.phase == .sent && keys.count == 4 })
        #expect(keys[2] == keys[0] && keys[3] != keys[2])
    }

    @Test func theSameKeyIsTheSameConversationAtTheStandIn() async throws {
        let world = FakeCampusWorld()
        world.stepDelay = 0.01
        let body = Data(#"{"text":"Plan it"}"#.utf8)
        let a = world.route(method: "POST", path: "/api/spaces/private/default/conversations", cookie: nil, body: body, headers: ["Idempotency-Key": "k1"])
        let b = world.route(method: "POST", path: "/api/spaces/private/default/conversations", cookie: nil, body: body, headers: ["idempotency-key": "k1"])
        let c = world.route(method: "POST", path: "/api/spaces/private/default/conversations", cookie: nil, body: body, headers: ["Idempotency-Key": "k2"])
        let idA = CampusJSON.parse(a.body)?["data"]["id"].string, idB = CampusJSON.parse(b.body)?["data"]["id"].string, idC = CampusJSON.parse(c.body)?["data"]["id"].string
        #expect(idA != nil && idA == idB && idC != idA)
        #expect(world.route(method: "POST", path: "/api/spaces/private/default/conversations", cookie: nil, body: Data("{}".utf8)).status == 400)
        #expect(world.route(method: "POST", path: "/api/spaces/team/nowhere/conversations", cookie: nil, body: body).status == 404)
    }

    @Test func theAnswerIsReadWhereverCampusKeepsTheConversation() throws {
        func parse(_ json: String) -> CampusConversation? { CampusConversation.parseCreated(Data(json.utf8), space: growth) }
        #expect(parse(#"{"data":{"id":"ses_abc123","title":"Hello"}}"#)?.id == "ses_abc123")
        #expect(parse(#"{"id":"ses_abc123"}"#)?.title == "Untitled conversation")
        #expect(parse(#"{"conversation":{"id":"ses_abc123","agent":"build","model":{"id":"coding-pro"}}}"#).map { $0.agent == "build" && $0.model == "coding-pro" } == true)
        #expect(parse(#"{"session":{"id":"ses_abc123"}}"#)?.spaceID == "team/growth-ops")
        #expect(parse(#"{"data":{"id":"../etc"}}"#) == nil)       // an id that cannot go into a path is not taken
        #expect(parse(#"{"ok":true}"#) == nil && parse("not json") == nil && parse(#"[1,2]"#) == nil)
        #expect(parse(#"{"data":{"id":"ses_abc123"}}"#)?.working == true)
    }

    @Test func anAnswerWithoutAnIdIsReportedAsNilAndTheListIsAskedAgain() async throws {
        let (s, auth, _) = await liveStore()
        s.writesEnabled = true
        auth.override = { r in r.method == "POST" ? CampusReply(status: 200, body: Data(#"{"ok":true}"#.utf8)) : nil }
        var results: [CampusConversation?] = []
        s.start()                                               // the poll loop is what a kick wakes
        defer { s.stop() }
        #expect(await until { s.refreshCount >= 2 })
        try await Task.sleep(nanoseconds: 300_000_000)
        let before = s.refreshCount
        _ = s.startConversation(in: mine, text: "hello") { results.append($0) }
        #expect(await until { results.count == 1 })
        #expect(results[0] == nil && s.held?.phase == .sent)
        #expect(await until { s.refreshCount > before })
    }
}
