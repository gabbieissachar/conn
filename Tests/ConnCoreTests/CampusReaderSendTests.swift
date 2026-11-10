// Campus sending from the reader page's own message bar (README "The embed page", "The composer", in the reader): the page holds a message through its own Undo window
// and then posts `send`; Conn types it into the Campus conversation through the same gate, with no second wait, and answers `sent`. These pin Conn's half: the message
// it accepts, the JSON it gives the page, and how the write behaves (no wait, the switch, one at a time, a failure that tells the page why and keeps no text of its own).
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

@MainActor private func liveStore(hold: Double = 30, stepDelay: Double = 0.01) async -> (CampusStore, FakeCampusAuth, FakeCampusWorld) {
    let world = FakeCampusWorld()
    world.stepDelay = stepDelay
    let auth = FakeCampusAuth(world: world)
    let s = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
    s.holdSeconds = hold; s.statusDelay = 0.02
    await s.refresh()
    s.writesEnabled = true
    return (s, auth, world)
}

@Suite("Campus: the page's message bar, Conn's half") struct ReaderSendMessageTests {
    @Test func aWellFormedSendIsAccepted() {
        let m = CampusEmbed.parseSend(["type": "send", "id": "6f1c-22_ab", "conversation": "ses_x", "text": "3 comments:\n\n1. a\n\n2. b", "comments": 2])
        #expect(m == ReaderSend(id: "6f1c-22_ab", conversation: "ses_x", text: "3 comments:\n\n1. a\n\n2. b", comments: 2))
        #expect(CampusEmbed.parseSend(["type": "send", "id": "a1", "text": "hello"])?.conversation == "")
    }

    @Test func aSendWithoutAnIdOrTextOrWithAnOddIdOrTooLongIsRefused() {
        #expect(CampusEmbed.parseSend(["type": "send", "text": "hello"]) == nil)
        #expect(CampusEmbed.parseSend(["type": "send", "id": "", "text": "hello"]) == nil)
        #expect(CampusEmbed.parseSend(["type": "send", "id": "a1", "text": "   \n"]) == nil)
        #expect(CampusEmbed.parseSend(["type": "send", "id": "a1"]) == nil)
        #expect(CampusEmbed.parseSend(["type": "send", "id": "a'1;alert(1)", "text": "hello"]) == nil)
        #expect(CampusEmbed.parseSend(["type": "send", "id": String(repeating: "a", count: 81), "text": "hello"]) == nil)
        #expect(CampusEmbed.parseSend(["type": "send", "id": "a1", "text": String(repeating: "x", count: CampusEmbed.maxSendLength + 1)]) == nil)
        #expect(CampusEmbed.parseSend(["type": "link", "id": "a1", "text": "hello"]) == nil)
        #expect(CampusEmbed.parseSend(["type": "send", "id": "a1", "text": String(repeating: "x", count: CampusEmbed.maxSendLength)]) != nil)
    }

    @Test func theJSONTheHostGivesThePage() throws {
        let on = try #require(JSONSerialization.jsonObject(with: Data(CampusEmbed.composerConfig(name: "Monthly \"review\"", send: true, reason: "ignored").utf8)) as? [String: Any])
        #expect(on["name"] as? String == "Monthly \"review\"" && on["send"] as? Bool == true && on["reason"] as? String == "")
        let off = try #require(JSONSerialization.jsonObject(with: Data(CampusEmbed.composerConfig(name: "x", send: false, reason: "Sign in to Campus to send.").utf8)) as? [String: Any])
        #expect(off["send"] as? Bool == false && off["reason"] as? String == "Sign in to Campus to send.")
        let ok = try #require(JSONSerialization.jsonObject(with: Data(CampusEmbed.sentResult(id: "a1", error: nil).utf8)) as? [String: Any])
        #expect(ok["id"] as? String == "a1" && ok["ok"] as? Bool == true && ok["error"] == nil)
        let bad = try #require(JSONSerialization.jsonObject(with: Data(CampusEmbed.sentResult(id: "a1", error: "Campus answered 500").utf8)) as? [String: Any])
        #expect(bad["ok"] as? Bool == false && bad["error"] as? String == "Campus answered 500")
    }

    @Test func whySendIsOffIsInThePagesWords() {
        #expect(CampusEmbed.sendReason(writesEnabled: true, link: .live) == nil)
        #expect(CampusEmbed.sendReason(writesEnabled: false, link: .live)?.contains("writes are off") == true)
        #expect(CampusEmbed.sendReason(writesEnabled: true, link: .expired)?.contains("Sign in") == true)
        #expect(CampusEmbed.sendReason(writesEnabled: true, link: .blocked)?.contains("Zscaler") == true)
        #expect(CampusEmbed.sendReason(writesEnabled: true, link: .starting)?.contains("not reachable") == true)
    }
}

@Suite("Campus: sending what the page's message bar hands over") @MainActor struct ReaderSendWriteTests {
    @Test func goesAtOnceWithNoSecondWaitAndTellsThePageItWasTaken() async throws {
        let (s, _, world) = await liveStore(hold: 30)                  // Conn's own window would be 30 s: only a no-wait send can finish
        let c = try #require(s.conversation("ses_fakeSprint03"))
        var results: [String?] = []
        #expect(s.sendFromReader("From the page", to: c) { results.append($0) } == nil)
        #expect(await until(8) { results.count == 1 })
        #expect(results == [nil])
        let w = world.writes()
        #expect(w.count == 1 && w[0].contains("/ses_fakeSprint03/prompt") && w[0].contains("\"text\":\"From the page\"") && !w[0].contains("delivery"))
        #expect(await until(5) { s.held?.phase == .sent })
    }

    @Test func theSwitchOffAndSignedOutAndEmptyAreRefusedAtOnceAndTheAnswerIsNotCalled() async throws {
        let (s, auth, world) = await liveStore()
        let c = try #require(s.conversation("ses_fakeSprint03"))
        var results: [String?] = []
        #expect(s.sendFromReader("   ", to: c) { results.append($0) } == .invalid)
        s.writesEnabled = false
        #expect(s.sendFromReader("hello", to: c) { results.append($0) } == .off)
        s.writesEnabled = true
        auth.override = { _ in CampusReply(status: 401) }
        await s.refresh()
        #expect(s.sendFromReader("hello", to: c) { results.append($0) } == .notLive)
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(results.isEmpty && world.writes().isEmpty)
    }

    @Test func aFailureTellsThePageWhyAndLeavesNoTextForTheNativeBox() async throws {
        let (s, auth, world) = await liveStore()
        let c = try #require(s.conversation("ses_fakeSprint03"))
        auth.override = { $0.method == "POST" ? CampusReply(status: 500) : nil }
        var results: [String?] = []
        _ = s.sendFromReader("keep this", to: c) { results.append($0) }
        #expect(await until(5) { results.count == 1 })
        #expect(results == ["Campus answered 500"] && world.writes().isEmpty)
        if case .failed(let why)? = s.held?.phase { #expect(why == "Campus answered 500") } else { Issue.record("not failed: \(String(describing: s.held))") }
        #expect(s.held?.restores == false)                                  // the page gives the text back, not a native box
    }

    @Test func behindAnotherWriteItWaitsItsTurnInOrderAndIsAnsweredInOrder() async throws {
        let (s, _, world) = await liveStore(hold: 0.3)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        var order: [String] = []
        _ = s.send("native first", to: c) { _ in }
        _ = s.sendFromReader("page second", to: c) { order.append("page second: \($0 ?? "ok")") }
        _ = s.sendFromReader("page third", to: c) { order.append("page third: \($0 ?? "ok")") }
        #expect(s.waiting.map(\.label) == ["To \(c.title): page second", "To \(c.title): page third"])
        #expect(await until(8) { world.writes().count == 3 })
        let w = world.writes()
        #expect(w[0].contains("native first") && w[1].contains("page second") && w[2].contains("page third"))
        #expect(await until(5) { order.count == 2 })
        #expect(order == ["page second: ok", "page third: ok"])
    }

    @Test func aFailureOfTheOneInFrontTellsTheWaitingPageSendsToo() async throws {
        let (s, auth, world) = await liveStore(hold: 0.1)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        auth.override = { $0.method == "POST" ? CampusReply(status: 500) : nil }
        var results: [String: String?] = [:]
        _ = s.sendFromReader("one", to: c) { results["one"] = $0 }
        _ = s.sendFromReader("two", to: c) { results["two"] = $0 }
        #expect(await until(5) { results.count == 2 })
        #expect(results["one"] == "Campus answered 500")
        if let two = results["two"], let why = two { #expect(why.contains("An earlier message did not go")) } else { Issue.record("two was told nothing useful: \(String(describing: results["two"]))") }
        #expect(world.writes().isEmpty)
    }

    @Test func takingTheWaitingOneBackOrTurningTheSwitchOffTellsThePage() async throws {
        let (s, _, world) = await liveStore(hold: 5)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        var results: [String: String?] = [:]
        _ = s.send("head", to: c) { _ in }
        _ = s.sendFromReader("waiting a", to: c) { results["a"] = $0 }
        _ = s.sendFromReader("waiting b", to: c) { results["b"] = $0 }
        s.takeBack(try #require(s.waiting.first).id)
        #expect(results["a"] == "Taken back")
        s.writesEnabled = false
        #expect(results["b"] != nil)
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(world.writes().isEmpty)
    }

    @Test func theReaderPageMaySendOnlyAFewMessagesAMinute() async throws {
        let (s, _, world) = await liveStore(hold: 0.01)
        let c = try #require(s.conversation("ses_fakeSprint03"))
        var results: [String?] = []
        for i in 1...CampusStore.maxPageSendsPerMinute {
            #expect(s.sendFromReader("m\(i)", to: c) { results.append($0) } == nil)
            #expect(await until(8) { results.count == i })
        }
        #expect(s.sendFromReader("one more", to: c) { results.append($0) } == .tooFast)
        #expect(CampusWriteRefusal.tooFast.message.contains("Too many"))
        #expect(world.writes().count == CampusStore.maxPageSendsPerMinute && results.count == CampusStore.maxPageSendsPerMinute)
        // The person's own sends are not counted.
        _ = s.send("typed in Conn", to: c) { _ in }
        s.sendNow()
        #expect(await until(8) { world.writes().count == CampusStore.maxPageSendsPerMinute + 1 })
    }

    @Test func aWorkingConversationTakesItAsSteerAndTheQueueIsCapped() async throws {
        let (s, _, world) = await liveStore(hold: 0.05)
        let kpi = try #require(s.conversation("ses_fakeKpi06"))
        #expect(kpi.working)
        _ = s.sendFromReader("into the run", to: kpi) { _ in }
        #expect(await until(8) { world.writes().count == 1 })
        #expect(world.writes()[0].contains("\"delivery\":\"steer\""))
        let (t, _, _) = await liveStore(hold: 30)
        let c = try #require(t.conversation("ses_fakeSprint03"))
        _ = t.send("head", to: c) { _ in }
        for i in 1...CampusStore.maxWaiting { #expect(t.sendFromReader("m\(i)", to: c) { _ in } == nil) }
        #expect(t.sendFromReader("too many", to: c) { _ in } == .queueFull)
        t.undo()
    }
}
