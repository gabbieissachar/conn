import Testing
import Foundation
import Network
import ConnCore
import FakeHerdrKit

private let t0 = Date(timeIntervalSince1970: 1_793_000_000)   // a fixed "now" so no test depends on the clock

private func ask(_ pane: String, hoursAgo: Double? = 1, older: Bool = false, herdr: String? = nil, message: String? = "turn-aaaa01", session: String = "00000000-0000-4000-8000-000000000001",
                 lines: [String] = ["Say if you want it."], tags: [String] = []) -> OpenAsk {
    OpenAsk(paneID: pane, herdr: herdr, session: session, message: message, lines: lines, at: hoursAgo.map { t0.addingTimeInterval(-$0 * 3600) }, tags: tags, older: older)
}

@Suite("Open asks: reading the reader's answer") struct OpenAsksParseTests {
    private func parse(_ json: String) -> OpenAsksFeed? { OpenAsksFeed.parse(Data(json.utf8)) }

    @Test func theAgreedShapeIsRead() throws {
        let feed = try #require(parse(#"""
        {"status":"ok","generated_at":"2026-11-06T09:00:00.123456+00:00","as_of":"2026-11-06T08:59:59+00:00","asks":[
          {"pane_id":"w1:p3","herdr":"esim","session":"0a1b2c3d-0000-4000-8000-000000000001","message":"turn-9f8e7d","lines":["Which rule?","Second line"],
           "at":"2026-11-06T08:40:00+00:00","tags":["Answer sheet · 4 questions","+2 earlier"],"older":false}]}
        """#))
        let whole = try #require(ISO8601DateFormatter().date(from: "2026-11-06T09:00:00+00:00"))
        #expect(abs(try #require(feed.generatedAt).timeIntervalSince(whole) - 0.123) < 0.001)          // six fractional digits, as Python writes them
        let a = try #require(feed.asks.first)
        #expect(feed.asks.count == 1)
        #expect(a.paneID == "w1:p3" && a.herdr == "esim" && a.session == "0a1b2c3d-0000-4000-8000-000000000001" && a.message == "turn-9f8e7d")
        #expect(a.lines == ["Which rule?", "Second line"] && a.tags == ["Answer sheet · 4 questions", "+2 earlier"] && a.older == false)
        #expect(a.at == ISO8601DateFormatter().date(from: "2026-11-06T08:40:00+00:00"))
    }

    @Test func timesMayBeIsoWithAnyFractionOrSecondsSince1970() throws {
        let feed = try #require(parse(#"{"asks":[{"pane_id":"a","session":"s1","message":"turn-000001","at":1793000000},{"pane_id":"b","session":"s1","message":"turn-000002","at":"2026-11-06T08:40:00Z"},{"pane_id":"c","session":"s1","message":"turn-000003","at":"yesterday"}]}"#))
        #expect(feed.asks[0].at == Date(timeIntervalSince1970: 1_793_000_000))
        #expect(feed.asks[1].at != nil)
        #expect(feed.asks[2].at == nil)       // an ask with no usable time is still an ask; the reader's `older` flag then decides the fold
    }

    @Test func entriesThatCannotBeOpenedAreDroppedAndTheRestKept() throws {
        let feed = try #require(parse(#"""
        {"asks":[{"pane_id":"ok","session":"abc-123","message":"turn-000001"},
                 {"session":"abc","message":"turn-000002"},
                 {"pane_id":"no-session","message":"turn-000003"},
                 {"pane_id":"bad-session","session":"a b","message":"turn-000004"},
                 "text", 7]}
        """#))
        #expect(feed.asks.map(\.paneID) == ["ok"])
    }

    @Test func aMissingNullOrUnusableReplyIdKeepsTheAskAndOpensTheSessionAlone() throws {
        let feed = try #require(parse(#"""
        {"asks":[{"pane_id":"null","session":"abc-123","message":null},
                 {"pane_id":"missing","session":"abc-123"},
                 {"pane_id":"bad","session":"abc-123","message":"x'];alert(1)//"},
                 {"pane_id":"short","session":"abc-123","message":"abc"},
                 {"pane_id":"number","session":"abc-123","message":7},
                 {"pane_id":"good","session":"abc-123","message":"turn-000001"}]}
        """#))
        #expect(feed.asks.map(\.paneID) == ["null", "missing", "bad", "short", "number", "good"])
        #expect(feed.asks.dropLast().allSatisfy { $0.message == nil && $0.readerFragment == "s=abc-123" })
        #expect(feed.asks.last?.readerFragment == "s=abc-123&m=turn-000001")
    }

    @Test func fieldsTheReaderMayAddLaterAreIgnored() throws {
        let feed = try #require(parse(#"{"status":"stale","asks":[{"pane_id":"p","herdr":"esim","session":"s1","message":"turn-000001","workspace":"w1","score":0.5,"tags":"not a list","lines":[1,2,"ok"]}]}"#))
        #expect(feed.asks.count == 1 && feed.asks[0].tags.isEmpty && feed.asks[0].lines == ["ok"])
    }

    @Test func panesOfDifferentHerdrSessionsAreDifferentPanes() throws {
        let feed = try #require(parse(#"{"asks":[{"pane_id":"w1:p1","herdr":"esim","session":"s1","message":"turn-000001","at":"2026-11-06T05:00:00Z"},{"pane_id":"w1:p1","herdr":"lab","session":"s2","message":"turn-000002","at":"2026-11-06T06:00:00Z"}]}"#))
        #expect(feed.asks.map(\.herdr) == ["esim", "lab"])
    }

    @Test func oneAskPerPaneTheNewestWins() throws {
        let feed = try #require(parse(#"{"asks":[{"pane_id":"p","session":"s1","message":"turn-old001","at":"2026-11-06T01:00:00Z"},{"pane_id":"p","session":"s1","message":"turn-new001","at":"2026-11-06T05:00:00Z"},{"pane_id":"p","session":"s1","message":"turn-mid001","at":"2026-11-06T03:00:00Z"}]}"#))
        #expect(feed.asks.map(\.message) == ["turn-new001"])
    }

    @Test func somethingThatIsNotAFeedIsNoAnswer() {
        #expect(parse("not json") == nil)
        #expect(parse(#"{"generated_at":"2026-11-06T09:00:00Z"}"#) == nil)
        #expect(parse(#"{"asks":"none"}"#) == nil)
        #expect(parse(#"{"asks":[]}"#)?.asks.isEmpty == true)        // an empty list is a good answer: nothing is waiting
    }

    @Test func theRowTextDropsListMarkersAndJoinsTheLines() {
        #expect(ask("p", lines: ["- Does it need a flag?", "* Or not.", "1. First", "2) Second", "plain"]).text == "Does it need a flag? Or not. First Second plain")
        #expect(ask("p", lines: ["  ", ""]).text == "")
        #expect(ask("p", lines: ["Keep - inside, 3. too"]).text == "Keep - inside, 3. too")
    }
}

@Suite("Open asks: the 24 hour fold") struct OpenAsksFoldTests {
    @Test func anAskIsOlderFromTwentyFourHours() {
        #expect(ask("p", hoursAgo: 23.9).isOlder(now: t0) == false)
        #expect(ask("p", hoursAgo: 24).isOlder(now: t0) == true)
        #expect(ask("p", hoursAgo: 300).isOlder(now: t0) == true)
        #expect(ask("p", hoursAgo: 23.9).isOlder(now: t0.addingTimeInterval(600)) == true)       // it ages out between two answers
    }

    @Test func theReadersFlagDecidesOnlyWhenThereIsNoTime() {
        #expect(ask("p", hoursAgo: nil, older: true).isOlder(now: t0) == true)
        #expect(ask("p", hoursAgo: nil, older: false).isOlder(now: t0) == false)
        #expect(ask("p", hoursAgo: 1, older: true).isOlder(now: t0) == false)         // the clock wins over a stale flag
    }

    @Test func olderAsksAreHiddenUntilAskedFor() {
        let asks = OpenAsks(byPane: ["a": ask("a", hoursAgo: 2), "b": ask("b", hoursAgo: 30), "c": ask("c", hoursAgo: 500)])
        #expect(Set(asks.visible(showOlder: false, now: t0).keys) == ["a"])
        #expect(Set(asks.visible(showOlder: true, now: t0).keys) == ["a", "b", "c"])
    }

    @Test func theOlderCountOnlyCountsLiveAgents() {
        let asks = OpenAsks(byPane: ["a": ask("a", hoursAgo: 2), "b": ask("b", hoursAgo: 30), "gone": ask("gone", hoursAgo: 90)])
        let live = ["a", "b", "c"].map { Agent(id: $0, name: $0, harness: "claude", state: .idle, workspaceID: "w", tabID: "t", sessionID: nil, cwd: "/") }
        #expect(asks.olderCount(among: live, now: t0) == 1)
    }

    @Test func ageIsSaidInTheWordsOfThePrototype() {
        #expect(AskAge.text(10) == "now")
        #expect(AskAge.text(60 * 5) == "5 min")
        #expect(AskAge.text(3600 * 3 + 100) == "3 h")
        #expect(AskAge.text(3600 * 24 * 2 + 5) == "2 d")
        #expect(AskAge.text(nil) == "")
    }
}

@Suite("Open asks: the sidebar order (G12)") struct OpenAsksOrderTests {
    // today's order: needs you e, h; working c, f; done b, g; idle a; unknown d
    private func snap() -> Snapshot {
        var s = Snapshot()
        s.workspaces = [Workspace(id: "w1", label: "one", number: 1, state: .idle, tabCount: 0, paneCount: 0)]
        let states: [(String, AgentState)] = [("a", .idle), ("b", .done), ("c", .working), ("d", .unknown), ("e", .blocked), ("f", .working), ("g", .done), ("h", .blocked)]
        s.agents = states.map { Agent(id: $0.0, name: $0.0, harness: "claude", state: $0.1, workspaceID: "w1", tabID: "t", sessionID: nil, cwd: "/tmp") }
        return s
    }
    private let today = ["e", "h", "c", "f", "b", "g", "a", "d"]

    @Test func withoutAsksTheOrderIsTodays() {
        #expect(snap().prioritized.map(\.id) == today)
        #expect(snap().prioritized(asks: [:]).map(\.id) == today)
    }

    @Test func promptWaitingFirstThenTheNewestAskThenTheRestInTodaysOrder() {
        let asks = ["a": ask("a", hoursAgo: 5), "g": ask("g", hoursAgo: 1), "f": ask("f", hoursAgo: 3)]
        // e and h are prompt waiting (no ask, Herdr's order); then g (1 h), f (3 h), a (5 h); then c, b, d as before.
        #expect(snap().prioritized(asks: asks).map(\.id) == ["e", "h", "g", "f", "a", "c", "b", "d"])
    }

    @Test func aPromptWaitingAgentWithAnAskLeadsItsGroupAndNewestComesFirst() {
        let asks = ["h": ask("h", hoursAgo: 4), "e": ask("e", hoursAgo: 9), "c": ask("c", hoursAgo: 0.5)]
        #expect(snap().prioritized(asks: asks).map(\.id) == ["h", "e", "c", "f", "b", "g", "a", "d"])
    }

    @Test func anAskForAPaneThatIsNotLiveMovesNothing() {
        #expect(snap().prioritized(asks: ["zzz": ask("zzz")]).map(\.id) == today)
    }

    @Test func aHiddenOlderAskDoesNotMoveARow() {
        let all = OpenAsks(byPane: ["a": ask("a", hoursAgo: 30), "g": ask("g", hoursAgo: 2)])
        let hidden = snap().prioritized(asks: all.visible(showOlder: false, now: t0)).map(\.id)
        #expect(hidden == ["e", "h", "g", "c", "f", "b", "a", "d"])
        let shown = snap().prioritized(asks: all.visible(showOlder: true, now: t0)).map(\.id)
        #expect(shown == ["e", "h", "g", "a", "c", "f", "b", "d"])
    }

    @Test func cmdDigitsAndCyclingFollowTheNewOrder() {
        let s = snap()
        let asks = ["a": ask("a", hoursAgo: 5), "g": ask("g", hoursAgo: 1)]
        let order = s.prioritized(asks: asks).map(\.id)        // e h g a c f b d
        #expect(order == ["e", "h", "g", "a", "c", "f", "b", "d"])
        #expect(s.agent(after: nil, offset: 1, asks: asks)?.id == "e")
        #expect(s.agent(after: "h", offset: 1, asks: asks)?.id == "g")
        #expect(s.agent(after: "a", offset: 1, asks: asks)?.id == "c")
        #expect(s.agent(after: "e", offset: -1, asks: asks)?.id == "d")
        #expect(s.agent(after: "d", offset: 1, asks: asks)?.id == "e")
        #expect(s.agent(after: "h", offset: 1, asks: [:])?.id == s.agent(after: "h", offset: 1)?.id)
        #expect(Snapshot.empty.agent(after: nil, offset: 1, asks: asks) == nil)
    }

    @Test func theOrderHoldsWhenTwoAsksShareATime() {
        let asks = ["g": ask("g", hoursAgo: 1), "b": ask("b", hoursAgo: 1)]
        // equal times keep today's order: b before g
        #expect(snap().prioritized(asks: asks).map(\.id) == ["e", "h", "b", "g", "c", "f", "a", "d"])
    }
}

@Suite("Open asks: joining an ask to a row") struct OpenAsksJoinTests {
    private func joined(_ asks: [OpenAsk], to herdr: String?) -> OpenAsks { OpenAsks(feed: OpenAsksFeed(asks: asks), herdrSession: herdr) }

    @Test func anAskForAnotherHerdrSessionNeverReachesARowEvenWhenThePaneIdIsTheSame() {
        let a = joined([ask("w1:p1", herdr: "lab", message: "turn-lab001"), ask("w1:p2", herdr: "esim")], to: "esim")
        #expect(a.byPane.keys.sorted() == ["w1:p2"])
        #expect(joined([ask("w1:p1", herdr: "lab")], to: "esim").isEmpty)
    }

    @Test func theAskOfOurOwnSessionWinsOverACoincidentalPaneIdOfAnother() {
        let a = joined([ask("w1:p1", hoursAgo: 5, herdr: "esim", message: "turn-esim01"), ask("w1:p1", hoursAgo: 1, herdr: "lab", message: "turn-lab001")], to: "esim")
        #expect(a.byPane["w1:p1"]?.message == "turn-esim01")
    }

    @Test func anEntryThatNamesNoHerdrSessionJoinsByPaneAlone() {
        #expect(joined([ask("w1:p1", herdr: nil)], to: "esim").byPane.keys.sorted() == ["w1:p1"])
        #expect(joined([ask("w1:p1", herdr: "esim"), ask("w1:p2", herdr: "lab")], to: nil).byPane.count == 2)     // no session known: nothing is left out
    }

    @Test func theStateJoinsEveryAnswerToItsHerdrSession() {
        var s = OpenAsksState(herdrSession: "esim")
        s.apply(OpenAsksFeed(asks: [ask("w1:p1", herdr: "esim"), ask("w1:p1", herdr: "lab", message: "turn-lab001"), ask("w2:p1", herdr: "lab")]), at: t0)
        #expect(s.asks.byPane.keys.sorted() == ["w1:p1"] && s.asks.byPane["w1:p1"]?.message == "turn-aaaa01")
    }
}

@Suite("Open asks: the click address") struct OpenAsksAddressTests {
    @Test func anAskWithNoReplyOpensTheSessionAlone() {
        #expect(ask("p", message: nil, session: "0a1b2c3d-0000-4000-8000-000000000001").readerFragment == "s=0a1b2c3d-0000-4000-8000-000000000001")
    }

    @Test func aClickOpensTheReaderAtTheSessionAndTheAskingReply() {
        #expect(ask("p", message: "turn-9f8e7d", session: "0a1b2c3d-0000-4000-8000-000000000001").readerFragment == "s=0a1b2c3d-0000-4000-8000-000000000001&m=turn-9f8e7d")
    }

    @Test func onlyIdsTheReaderWouldFollowAreAccepted() {
        #expect(OpenAsk.validMessage("turn-9f8e7d") && OpenAsk.validMessage("abcdef") && OpenAsk.validMessage(String(repeating: "a", count: 64)))
        #expect(!OpenAsk.validMessage("abcde") && !OpenAsk.validMessage(String(repeating: "a", count: 65)) && !OpenAsk.validMessage("a'b'c'd'e") && !OpenAsk.validMessage("abc def"))
        #expect(OpenAsk.validSession("0a1b2c3d-0000") && !OpenAsk.validSession("") && !OpenAsk.validSession("a;b") && !OpenAsk.validSession("a b"))
    }
}

@Suite("Open asks: what Conn keeps between answers") struct OpenAsksStateTests {
    private func feed(_ n: Int, generated: Date? = nil) -> OpenAsksFeed {
        OpenAsksFeed(generatedAt: generated, asks: (0..<n).map { ask("p\($0)", hoursAgo: 1) })
    }

    @Test func aGoodAnswerReplacesWhatWasThere() {
        var s = OpenAsksState()
        s.apply(feed(2), at: t0)
        #expect(s.asks.byPane.count == 2)
        s.apply(feed(1), at: t0.addingTimeInterval(5))
        #expect(s.asks.byPane.keys.sorted() == ["p0"])
        s.apply(feed(0), at: t0.addingTimeInterval(10))        // an empty list is an answer: nothing waits
        #expect(s.asks.isEmpty && s.failures == 0)
    }

    @Test func oneFailedAnswerIsForgivenAndASecondClearsTheRows() {
        var s = OpenAsksState()
        s.apply(feed(2), at: t0)
        s.apply(nil, at: t0.addingTimeInterval(5))
        #expect(s.asks.byPane.count == 2 && s.failures == 1)
        s.apply(nil, at: t0.addingTimeInterval(10))
        #expect(s.asks.isEmpty && s.failures == 2)
        s.apply(feed(1), at: t0.addingTimeInterval(15))        // the reader is back: the rows follow at once
        #expect(s.asks.byPane.count == 1 && s.failures == 0)
    }

    @Test func aReaderThatIsDownFromTheStartShowsNoAsks() {
        var s = OpenAsksState()
        for i in 0..<4 { s.apply(nil, at: t0.addingTimeInterval(Double(i) * 5)) }
        #expect(s.asks.isEmpty)
    }

    @Test func aFixtureFeedIsMovedSoItsMomentIsNow() {
        var s = OpenAsksState(rebaseToNow: true)
        let generated = t0.addingTimeInterval(-86_400 * 40)            // a fixture written long ago
        s.apply(OpenAsksFeed(generatedAt: generated, asks: [ask("p", hoursAgo: nil).withTime(generated.addingTimeInterval(-1200)),
                                                           ask("q", hoursAgo: nil).withTime(generated.addingTimeInterval(-30 * 3600))]), at: t0)
        #expect(s.asks.byPane["p"]?.age(now: t0) == 1200)
        #expect(s.asks.byPane["p"]?.isOlder(now: t0) == false && s.asks.byPane["q"]?.isOlder(now: t0) == true)
        var live = OpenAsksState()                                       // a real answer is never moved
        live.apply(OpenAsksFeed(generatedAt: generated, asks: [ask("p", hoursAgo: nil).withTime(generated)]), at: t0)
        #expect(live.asks.byPane["p"]?.isOlder(now: t0) == true)
    }
}

private extension OpenAsk {
    func withTime(_ d: Date) -> OpenAsk { var a = self; a.at = d; return a }
}

@Suite("Open asks: the fixture the sidebar is built against") struct OpenAsksFixtureTests {
    static let fixtureURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Resources/fixture/open-asks.json")

    @Test func theFixtureIsAFeedAndItsPanesAndSessionsMatchTheStandInHerdr() throws {
        let feed = try #require(OpenAsksFeed.parse(try Data(contentsOf: Self.fixtureURL)))
        let (server, endpoint) = try makeServer(agents: 24)
        defer { server.stop() }
        let snap = try HerdrClient(endpoint: endpoint).snapshot()
        let ours = feed.asks.filter { $0.herdr == "fake" }
        #expect(feed.asks.count == ours.count + 1 && feed.asks.contains { $0.herdr == "other-session" && $0.paneID == "w01:p4" })       // one ask is for another Herdr session, on purpose
        let known = ours.filter { snap.agent($0.paneID) != nil }
        #expect(known.count == ours.count - 1)                            // one ask is for a pane that is not live, on purpose
        for a in known { #expect(snap.agent(a.paneID)?.sessionID == a.session, "\(a.paneID)") }
        var state = OpenAsksState(rebaseToNow: true, herdrSession: "fake")
        state.apply(feed, at: t0)
        #expect(state.asks.byPane["w01:p4"]?.herdr == "fake")             // the other session's ask for the same pane id was left out
        #expect(state.asks.byPane["w05:p3"]?.message == nil)              // one ask names no reply: its click opens the session alone
        let visible = state.asks.visible(showOlder: false, now: t0)
        #expect(Set(visible.keys.filter { snap.agent($0) != nil }) == ["w01:p4", "w01:p2", "w02:p4", "w05:p3"])
        #expect(state.asks.olderCount(among: snap.agents, now: t0) == 3)
        // a prompt-waiting agent with no ask (w03:p3) sits with the others that need you, and an ask on an idle agent leads the rest
        let order = snap.prioritized(asks: visible).map(\.id)
        #expect(order.prefix(5).map { $0 } == ["w01:p4", "w03:p3", "w05:p2", "w01:p2", "w02:p4"])
    }
}

/// A one-answer-per-connection HTTP server on a free port, for the read itself.
private final class AnswerServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "conn.open-asks-test")
    private(set) var port: UInt16 = 0
    private(set) var requests: [String] = []
    private let lock = NSLock()
    private let answers: [String: (Int, String)]

    init?(answers: [String: (Int, String)]) {
        self.answers = answers
        guard let l = try? NWListener(using: .tcp, on: .any) else { return nil }
        listener = l
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let p = self?.listener.port?.rawValue { self?.port = p; ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] c in self?.serve(c) }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 3) == .success, port != 0 else { listener.cancel(); return nil }
    }

    private func serve(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self = self else { conn.cancel(); return }
            let head = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let line = head.split(separator: "\r\n").first.map(String.init) ?? ""
            self.lock.lock(); self.requests.append(line); self.lock.unlock()
            let path = String(line.split(separator: " ").dropFirst().first ?? "/")
            let (code, body) = self.answers[path] ?? (404, "not found")
            let bytes = Data(body.utf8)
            let header = "HTTP/1.1 \(code) X\r\nContent-Type: application/json\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
            conn.send(content: Data(header.utf8) + bytes, completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    func stop() { listener.cancel() }
}

@Suite("Open asks: reading the endpoint") struct OpenAsksFetchTests {
    @Test func theRoutePathIsTheAgreedOne() {
        #expect(OpenAsksSource.path == "/api/transcript-reader/open-asks")
    }

    @Test func aGoodAnswerIsReadAndEveryOtherAnswerIsNil() async throws {
        let good = #"{"generated_at":"2026-11-06T09:00:00Z","asks":[{"pane_id":"w1:p1","session":"abc-123","message":"turn-000001","lines":["Which?"],"at":"2026-11-06T08:00:00Z"}]}"#
        let server = try #require(AnswerServer(answers: [OpenAsksSource.path: (200, good), "/broken": (200, "not json"), "/boom": (500, good),
                                                                 "/not-built": (404, #"{"status":"not_built","asks":[]}"#), "/guarded": (403, "Missing or invalid token")]))
        defer { server.stop() }
        let base = "http://127.0.0.1:\(server.port)"
        let feed = await OpenAsksSource.fetch(URL(string: base + OpenAsksSource.path)!)
        #expect(feed?.asks.map(\.paneID) == ["w1:p1"])
        #expect(await OpenAsksSource.fetch(URL(string: base + "/api/missing")!) == nil)       // an older reader: 404
        #expect(await OpenAsksSource.fetch(URL(string: base + "/boom")!) == nil)
        #expect(await OpenAsksSource.fetch(URL(string: base + "/broken")!) == nil)
        #expect(await OpenAsksSource.fetch(URL(string: base + "/not-built")!) == nil)       // before the reader's first build: no asks
        #expect(await OpenAsksSource.fetch(URL(string: base + "/guarded")!) == nil)         // a refused token: no asks
        #expect(server.requests.first?.hasPrefix("GET /api/transcript-reader/open-asks") == true)       // a read, nothing else
        #expect(server.requests.allSatisfy { $0.hasPrefix("GET ") })
    }

    @Test func aReaderThatIsDownGivesNilQuickly() async throws {
        let server = try #require(AnswerServer(answers: [:]))
        let port = server.port
        server.stop()
        try await Task.sleep(nanoseconds: 200_000_000)
        let start = Date()
        #expect(await OpenAsksSource.fetch(URL(string: "http://127.0.0.1:\(port)\(OpenAsksSource.path)")!, timeout: 2) == nil)
        #expect(Date().timeIntervalSince(start) < 3)
        #expect(await OpenAsksSource.fetch(URL(string: "ftp://example.com/x")!) == nil)
    }

    @Test func aFileAddressIsReadForFixturesAndChecks() async throws {
        let feed = await OpenAsksSource.fetch(OpenAsksFixtureTests.fixtureURL)
        #expect(feed?.asks.count == 9)
        #expect(await OpenAsksSource.fetch(URL(fileURLWithPath: "/nonexistent/open-asks.json")) == nil)
    }
}

@Suite("Open asks: read state") struct AskReadStateTests {
    @Test func aReadAskStaysReadAndANewAskOnTheSamePaneIsUnread() {
        var state = AskReadState()
        let first = ask("w1:p1", message: "turn-aaaa01")
        #expect(!state.isRead(first))
        state.markRead(first, at: t0)
        #expect(state.isRead(first))
        // The same pane asks again: another asking turn, another ask.
        #expect(!state.isRead(ask("w1:p1", message: "turn-bbbb02")))
        // The same turn id on another pane, or in another Herdr session, is another ask too.
        #expect(!state.isRead(ask("w1:p2", message: "turn-aaaa01")))
        #expect(!state.isRead(ask("w1:p1", herdr: "other", message: "turn-aaaa01")))
    }

    @Test func markingUnreadBringsItBack() {
        var state = AskReadState()
        let a = ask("w1:p1")
        state.markRead(a, at: t0)
        state.markUnread(a)
        #expect(!state.isRead(a) && state.isEmpty)
    }

    @Test func withNoTurnIdTheReadersTimeSeparatesTwoAsks() {
        var state = AskReadState()
        let early = ask("w1:p1", hoursAgo: 5, message: nil), late = ask("w1:p1", hoursAgo: 1, message: nil)
        state.markRead(early, at: t0)
        #expect(state.isRead(early) && !state.isRead(late))
        // With neither a turn nor a time the session is all there is to go on.
        #expect(ask("w1:p1", hoursAgo: nil, message: nil).readKey == ask("w1:p1", hoursAgo: nil, message: nil).readKey)
    }

    @Test func oldMarksAndTooManyMarksAreForgotten() {
        var state = AskReadState()
        state.markRead(ask("w1:p1", message: "turn-old001"), at: t0.addingTimeInterval(-AskReadState.maxAge - 60))
        state.markRead(ask("w1:p2", message: "turn-new001"), at: t0)
        #expect(!state.isRead(ask("w1:p1", message: "turn-old001")) && state.isRead(ask("w1:p2", message: "turn-new001")))
        var many = AskReadState()
        for i in 0..<(AskReadState.maxEntries + 25) { many.markRead(ask("w1:p1", message: String(format: "turn-%06d", i)), at: t0.addingTimeInterval(Double(i))) }
        #expect(many.marked.count == AskReadState.maxEntries)
        #expect(many.isRead(ask("w1:p1", message: String(format: "turn-%06d", AskReadState.maxEntries + 24))))   // the newest stay
        #expect(!many.isRead(ask("w1:p1", message: "turn-000000")))
    }

    @Test func countsLeaveReadAsksOutOfTheOlderOfferAndCountThemApart() {
        let agents = (1...4).map { Agent(id: "w1:p\($0)", name: "a\($0)", harness: "claude", state: .idle, workspaceID: "w1", tabID: "w1:t\($0)", sessionID: nil, cwd: "") }
        let asks = OpenAsks(byPane: ["w1:p1": ask("w1:p1", hoursAgo: 30), "w1:p2": ask("w1:p2", hoursAgo: 40), "w1:p3": ask("w1:p3", hoursAgo: 1), "w1:p4": ask("w1:p4", hoursAgo: 2)])
        var read = AskReadState()
        #expect(asks.olderCount(among: agents, now: t0, read: read) == 2 && asks.readCount(among: agents, showOlder: false, now: t0, read: read) == 0)
        read.markRead(ask("w1:p2", hoursAgo: 40), at: t0)       // an older ask, read: not offered any more
        read.markRead(ask("w1:p3", hoursAgo: 1), at: t0)        // a fresh ask, read
        #expect(asks.olderCount(among: agents, now: t0, read: read) == 1)
        #expect(asks.readCount(among: agents, showOlder: false, now: t0, read: read) == 1)    // the read older ask is folded, so only p3 counts
        #expect(asks.readCount(among: agents, showOlder: true, now: t0, read: read) == 2)
    }
}
