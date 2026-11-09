// Campus sending, the way the other agents' composers behave (README "Campus in Conn", Writes): a message typed while another is in its Undo window waits behind it
// (a queue), each goes through its own window when its turn comes, and Now skips the wait of the one at the front. "Nothing was sent" is read from the stand-in's own log.
import Testing
import Foundation
import ConnCore
import FakeCampusKit

@MainActor private func until(_ timeout: Double = 5, _ cond: () -> Bool) async -> Bool {
    var t = 0.0
    while !cond() && t < timeout { try? await Task.sleep(nanoseconds: 20_000_000); t += 0.02 }
    return cond()
}

@MainActor private func liveStore(hold: Double, stepDelay: Double = 0.01) async -> (CampusStore, FakeCampusAuth, FakeCampusWorld) {
    let world = FakeCampusWorld()
    world.stepDelay = stepDelay
    let auth = FakeCampusAuth(world: world)
    let s = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
    s.holdSeconds = hold; s.statusDelay = 0.02
    await s.refresh()
    s.writesEnabled = true
    return (s, auth, world)
}

/// A message box as the composer keeps it: what comes back goes in front of what is there.
@MainActor private final class Box {
    var text = ""
    func restore(_ t: String) { text = text.isEmpty ? t : t + "\n" + text }
}

@Suite("Campus sending: the queue, Undo and Now") @MainActor struct CampusSendQueueTests {
    @Test func aMessageTypedBehindAnotherWaitsAndGoesOutInOrderThroughItsOwnWindow() async throws {
        let (s, _, world) = await liveStore(hold: 0.4)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        let box = Box()
        #expect(s.send("first", to: c, restore: box.restore) == nil)
        #expect(s.send("second", to: c, restore: box.restore) == nil)
        #expect(s.send("third", to: c, restore: box.restore) == nil)
        #expect(s.held?.phase == .held && s.waiting.map(\.label) == ["To \(c.title): second", "To \(c.title): third"])
        #expect(await until(8) { world.writes().count == 3 })
        let w = world.writes()
        #expect(w[0].contains("\"text\":\"first\"") && w[1].contains("\"text\":\"second\"") && w[2].contains("\"text\":\"third\""))
        #expect(s.waiting.isEmpty && box.text.isEmpty)
    }

    @Test func eachWaitingMessageGetsAFullWindowOfItsOwn() async throws {
        let (s, _, world) = await liveStore(hold: 0.6)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        let t0 = Date()
        _ = s.send("one", to: c) { _ in }
        _ = s.send("two", to: c) { _ in }
        #expect(await until(8) { world.writes().count == 1 })
        let first = Date().timeIntervalSince(t0)
        #expect(await until(8) { world.writes().count == 2 })
        let second = Date().timeIntervalSince(t0)
        #expect(first >= 0.55 && second - first >= 0.5, "first at \(first) s, second \(second - first) s after it")
    }

    @Test func nowSkipsTheWaitOfTheOneAtTheFrontAndNotTheNextOnesWindow() async throws {
        let (s, _, world) = await liveStore(hold: 30)                   // a window nobody would sit out: only Now can make this finish
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        _ = s.send("now please", to: c) { _ in }
        _ = s.send("later", to: c) { _ in }
        s.holdSeconds = 0.6                                              // the window the second message gets when its turn comes
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(world.writes().isEmpty)
        let t0 = Date()
        s.sendNow()
        #expect(await until(8) { world.writes().count == 1 })
        #expect(world.writes().first?.contains("\"text\":\"now please\"") == true)
        // The message behind it starts its own window when the first is out.
        #expect(await until(5) { s.held?.phase == .held && s.waiting.isEmpty })
        if Date().timeIntervalSince(t0) < 0.5 { #expect(world.writes().count == 1) }
        #expect(await until(8) { world.writes().count == 2 })
        #expect(world.writes().last?.contains("\"text\":\"later\"") == true)
    }

    @Test func nowOnASingleSendJustSendsItAtOnce() async throws {
        let (s, _, world) = await liveStore(hold: 30)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        _ = s.send("hurry", to: c) { _ in }
        s.sendNow()
        #expect(await until(8) { world.writes().count == 1 })
        #expect(await until(8) { s.held?.phase == .sent })
        s.sendNow()                       // nothing in a window: nothing happens
        try await Task.sleep(nanoseconds: 150_000_000)
        #expect(world.writes().count == 1)
    }

    @Test func nowDoesNothingWithTheSwitchOffOrNothingHeld() async throws {
        let (s, _, world) = await liveStore(hold: 0.2)
        s.sendNow()
        #expect(s.held == nil)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        _ = s.send("stay", to: c) { _ in }
        s.writesEnabled = false
        s.sendNow()
        try await Task.sleep(nanoseconds: 500_000_000)
        #expect(world.writes().isEmpty)
    }

    @Test func undoOnTheFirstTakesBackTheWholeLotInTheOrderTyped() async throws {
        let (s, _, world) = await liveStore(hold: 1.5)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        let box = Box()
        let t0 = Date()
        _ = s.send("alpha", to: c, restore: box.restore)
        _ = s.send("beta", to: c, restore: box.restore)
        _ = s.send("gamma", to: c, restore: box.restore)
        try await Task.sleep(nanoseconds: 100_000_000)
        s.undo()
        guard Date().timeIntervalSince(t0) < 1.2 else { return }
        #expect(box.text == "alpha\nbeta\ngamma")
        #expect(s.held?.phase == .undone && s.held?.alsoReturned == 2 && s.waiting.isEmpty)
        try await Task.sleep(nanoseconds: 1_800_000_000)
        #expect(world.writes().isEmpty)                      // none of them was ever sent
    }

    @Test func aWaitingMessageCanBeTakenBackOnItsOwnAndTheRestGoOn() async throws {
        let (s, _, world) = await liveStore(hold: 0.5)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        let box = Box()
        _ = s.send("keep", to: c, restore: box.restore)
        _ = s.send("drop me", to: c, restore: box.restore)
        _ = s.send("also keep", to: c, restore: box.restore)
        let drop = try #require(s.waiting.first)
        s.takeBack(drop.id)
        #expect(box.text == "drop me" && s.waiting.count == 1)
        s.takeBack(drop.id)                                   // already gone: nothing happens
        #expect(box.text == "drop me")
        #expect(await until(8) { world.writes().count == 2 })
        let w = world.writes()
        #expect(w[0].contains("\"text\":\"keep\"") && w[1].contains("\"text\":\"also keep\""))
    }

    @Test func aFailureGivesEverythingBackAndSendsNothingMore() async throws {
        let (s, auth, world) = await liveStore(hold: 0.1)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        auth.override = { $0.method == "POST" ? CampusReply(status: 500) : nil }
        let box = Box()
        _ = s.send("one", to: c, restore: box.restore)
        _ = s.send("two", to: c, restore: box.restore)
        _ = s.send("three", to: c, restore: box.restore)
        #expect(await until(5) { if case .failed? = s.held?.phase { return true }; return false })
        #expect(box.text == "one\ntwo\nthree" && s.held?.alsoReturned == 2 && s.waiting.isEmpty)
        try await Task.sleep(nanoseconds: 400_000_000)
        #expect(world.writes().isEmpty)
    }

    @Test func theQueueIsCappedAndAnyOtherWriteStillSaysOneAtATime() async throws {
        let (s, _, _) = await liveStore(hold: 5)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        #expect(s.send("head", to: c) { _ in } == nil)
        for i in 1...CampusStore.maxWaiting { #expect(s.send("m\(i)", to: c) { _ in } == nil) }
        #expect(s.send("one too many", to: c) { _ in } == .queueFull)
        #expect(s.waiting.count == CampusStore.maxWaiting)
        #expect(s.stop(c) == .busy)
        #expect(s.setAgent(CampusChoice(id: "plan", label: "plan"), for: c) == .busy)
        #expect(CampusWriteRefusal.queueFull.message.contains("\(CampusStore.maxWaiting) messages"))
        s.undo()
        #expect(s.waiting.isEmpty)
    }

    @Test func turningTheSwitchOffGivesBackTheMessageInItsWindowAndEveryOneWaiting() async throws {
        let (s, _, world) = await liveStore(hold: 1.0)
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        let box = Box()
        let t0 = Date()
        _ = s.send("a", to: c, restore: box.restore)
        _ = s.send("b", to: c, restore: box.restore)
        s.writesEnabled = false
        guard Date().timeIntervalSince(t0) < 0.6 else { return }
        #expect(box.text == "a\nb" && s.waiting.isEmpty)
        try await Task.sleep(nanoseconds: 1_300_000_000)
        #expect(world.writes().isEmpty)
    }

    @Test func aMessageThatWaitedBehindAnotherFindsTheRunItStartedAndQueuesAfterIt() async throws {
        let (s, _, world) = await liveStore(hold: 0.3, stepDelay: 0.4)     // a run of about 4 s
        let c = try #require(s.conversation("ses_fakeSprint03"))
        #expect(!c.working)
        _ = s.send("start the run", to: c) { _ in }
        _ = s.send("and then this", to: c) { _ in }                // typed while the conversation was idle, with no choice to make
        #expect(await until(8) { world.writes().count == 2 })
        let w = world.writes()
        #expect(!w[0].contains("delivery") && w[1].contains("\"delivery\":\"queue\""), "the second finds the run the first started and goes after it: \(w)")
    }

    @Test func aChosenSteerOrQueueIsSentAsChosenEvenIfTheRunEndedInTheWindow() async throws {
        let (s, _, world) = await liveStore(hold: 0.05)
        let kpi = try #require(s.conversation("ses_fakeKpi06"))
        #expect(kpi.working)
        _ = s.send("steer this", to: kpi, delivery: "steer") { _ in }
        _ = s.send("queue this", to: kpi, delivery: "queue") { _ in }
        #expect(await until(8) { world.writes().count == 2 })
        let w = world.writes()
        #expect(w[0].contains("\"delivery\":\"steer\"") && w[1].contains("\"delivery\":\"queue\""))
    }

    @Test func aMessageToAnIdleConversationStaysPlainEvenWhenItWaited() async throws {
        let (s, _, world) = await liveStore(hold: 0.05)
        let c = try #require(s.conversation("ses_fakeSprint03"))
        #expect(!c.working)
        _ = s.send("hello", to: c) { _ in }
        #expect(await until(5) { world.writes().count == 1 })
        #expect(!world.writes()[0].contains("delivery"))
    }

    @Test func messagesToDifferentConversationsKeepTheirOwnBoxes() async throws {
        let (s, _, world) = await liveStore(hold: 5)
        let a = try #require(s.conversation("ses_fakeOffsite04"))
        let b = try #require(s.conversation("ses_fakeSprint03"))
        var back: [(String, String)] = []
        _ = s.send("to a", to: a) { back.append((a.id, $0)) }
        _ = s.send("to b", to: b) { back.append((b.id, $0)) }
        #expect(s.waiting.first?.conversationID == b.id)
        s.undo()
        #expect(back.map(\.0) == [b.id, a.id] && back.map(\.1) == ["to b", "to a"])
        #expect(world.writes().isEmpty)
    }
}
