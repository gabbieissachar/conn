// Campus in Conn, slice 2: the write gate (C7). Switch off refuses, Undo cancels, a failure restores the draft, one write at a time, and every write kind
// (send, steer and queue, answer, Stop, model, agent) goes through the same gate. "Nothing was sent" is read from the stand-in's own log of the writes it received.
import Testing
import Foundation
import ConnCore
import FakeCampusKit

@MainActor private func until(_ timeout: Double = 5, _ cond: () -> Bool) async -> Bool {
    var t = 0.0
    while !cond() && t < timeout { try? await Task.sleep(nanoseconds: 20_000_000); t += 0.02 }
    return cond()
}

@MainActor private func liveStore(hold: Double = 0.2) async -> (CampusStore, FakeCampusAuth, FakeCampusWorld) {
    let world = FakeCampusWorld()
    world.stepDelay = 0.01
    let auth = FakeCampusAuth(world: world)
    let s = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
    s.holdSeconds = hold; s.statusDelay = 0.02
    await s.refresh()
    return (s, auth, world)
}

@Suite("Campus writes: the gate") @MainActor struct CampusWriteGateTests {
    @Test func theSwitchIsOffAtLaunchAndOffRefusesEveryKindOfWrite() async throws {
        let (s, _, world) = await liveStore()
        #expect(s.writesEnabled == false)
        let c = try #require(s.conversation("ses_fakeSprint03"))
        let form = try #require(s.openForms["ses_fakeDigest02"])
        s.pick(form, question: 0, option: "Last full week"); s.pick(form, question: 1, option: "Table")
        let digest = try #require(s.conversation("ses_fakeDigest02"))
        var restored: [String] = []
        #expect(s.send("hello", to: c) { restored.append($0) } == .off)
        #expect(s.stop(c) == .off)
        #expect(s.answer(form, in: digest) == .off)
        #expect(s.setModel(CampusChoice(id: "coding-pro", label: "coding-pro"), for: c) == .off)
        #expect(s.setAgent(CampusChoice(id: "plan", label: "plan"), for: c) == .off)
        try await Task.sleep(nanoseconds: 400_000_000)
        #expect(world.writes().isEmpty && s.held == nil && restored.isEmpty)
    }

    @Test func aSendWaitsItsUndoWindowThenIsDelivered() async throws {
        let (s, _, world) = await liveStore(hold: 1.0)
        s.writesEnabled = true
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        let t0 = Date()
        #expect(s.send("Add a dinner", to: c) { _ in } == nil)
        #expect(s.held?.phase == .held && s.held?.secondsLeft == 1)
        try await Task.sleep(nanoseconds: 150_000_000)
        if Date().timeIntervalSince(t0) < 0.8 { #expect(world.writes().isEmpty) }     // still inside the window: nothing sent (a loaded machine may oversleep)
        #expect(await until { s.held?.phase == .sent })
        let w = world.writes()
        #expect(w.count == 1 && w[0].hasPrefix("POST /api/spaces/private/default/conversations/ses_fakeOffsite04/prompt") && w[0].contains("\"text\":\"Add a dinner\"") && !w[0].contains("delivery"))
    }

    @Test func undoCancelsAndTheTextComesBack() async throws {
        let (s, _, world) = await liveStore(hold: 1.5)
        s.writesEnabled = true
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        var restored: [String] = []
        let t0 = Date()
        #expect(s.send("Take me back", to: c) { restored.append($0) } == nil)
        try await Task.sleep(nanoseconds: 100_000_000)
        s.undo()
        // A machine busy enough to oversleep the whole window has nothing to undo: only judge a send that was still waiting.
        guard Date().timeIntervalSince(t0) < 1.2 else { return }
        #expect(s.held?.phase == .undone && restored == ["Take me back"])
        try await Task.sleep(nanoseconds: 1_700_000_000)
        #expect(world.writes().isEmpty)                         // never sent, not even after the window would have ended
    }

    @Test func turningTheSwitchOffInsideTheWindowTakesTheWriteBack() async throws {
        let (s, _, world) = await liveStore(hold: 1.0)
        s.writesEnabled = true
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        var restored: [String] = []
        let t0 = Date()
        _ = s.send("Not after all", to: c) { restored.append($0) }
        s.writesEnabled = false
        guard Date().timeIntervalSince(t0) < 0.5 else { return }
        try await Task.sleep(nanoseconds: 1_300_000_000)
        #expect(restored == ["Not after all"] && world.writes().isEmpty)
    }

    @Test func aFailedSendReturnsTheTextAndSaysWhy() async throws {
        let (s, auth, world) = await liveStore(hold: 0.05)
        s.writesEnabled = true
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        auth.override = { $0.method == "POST" ? CampusReply(status: 500) : nil }
        var restored: [String] = []
        _ = s.send("Please keep this", to: c) { restored.append($0) }
        #expect(await until { if case .failed = s.held?.phase { return true }; return false })
        #expect(restored == ["Please keep this"] && world.writes().isEmpty)
        if case .failed(let why)? = s.held?.phase { #expect(why == "Campus answered 500") }
    }

    @Test func aSignedOutCampusRefusesAndOneWriteAtATime() async throws {
        let (s, auth, _) = await liveStore(hold: 0.5)
        s.writesEnabled = true
        let c = try #require(s.conversation("ses_fakeOffsite04"))
        #expect(s.send("first", to: c) { _ in } == nil)
        #expect(s.send("second", to: c) { _ in } == .busy)
        s.undo()
        auth.override = { _ in CampusReply(status: 401) }
        await s.refresh()
        #expect(s.send("signed out", to: c) { _ in } == .notLive)
        #expect(s.send("   ", to: c) { _ in } == .invalid)
    }

    @Test func stopAnswerAgentAndModelEachGoThroughTheSameWindow() async throws {
        let (s, _, world) = await liveStore(hold: 0.05)
        s.writesEnabled = true
        let kpi = try #require(s.conversation("ses_fakeKpi06"))
        #expect(s.stop(kpi) == nil)
        #expect(await until { world.writes().count == 1 })
        let digest = try #require(s.conversation("ses_fakeDigest02"))
        let form = try #require(s.openForms["ses_fakeDigest02"])
        #expect(s.answer(form, in: digest) == .invalid)         // not every question is picked yet
        s.pick(form, question: 0, option: "Last full week"); s.pick(form, question: 1, option: "Short bullets")
        try await Task.sleep(nanoseconds: 150_000_000)
        #expect(s.answer(form, in: digest) == nil)
        #expect(await until { world.writes().count == 2 })
        try await Task.sleep(nanoseconds: 100_000_000)
        let sprint = try #require(s.conversation("ses_fakeSprint03"))
        #expect(s.setModel(CampusChoice(id: "coding-pro", label: "coding-pro", provider: "campus"), for: sprint) == nil)
        #expect(await until { world.writes().count == 3 })
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(s.setAgent(CampusChoice(id: "plan", label: "plan"), for: sprint) == nil)
        #expect(await until { world.writes().count == 4 })
        try await Task.sleep(nanoseconds: 100_000_000)
        let w = world.writes()
        #expect(w.count == 4)
        #expect(w[0].contains("/ses_fakeKpi06/interrupt"))
        #expect(w[1].contains("/ses_fakeDigest02/form/frm_demo_digest/reply") && w[1].contains("\"answer\":[\"Last full week\",\"Short bullets\"]"))
        #expect(w[2].contains("/ses_fakeSprint03/model") && w[2].contains("\"id\":\"coding-pro\"") && w[2].contains("\"providerID\":\"campus\""))
        #expect(w[3].contains("/ses_fakeSprint03/agent") && w[3].contains("\"agent\":\"plan\""))
        #expect(s.conversation("ses_fakeSprint03")?.model == "coding-pro" && s.conversation("ses_fakeSprint03")?.agent == "plan")
    }

    @Test func aWorkingConversationTakesSteerOrQueueAnIdleOneTakesNeither() async throws {
        let (s, _, world) = await liveStore(hold: 0.02)
        s.writesEnabled = true
        let kpi = try #require(s.conversation("ses_fakeKpi06"))
        #expect(kpi.working)
        _ = s.send("now please", to: kpi, delivery: "steer") { _ in }
        #expect(await until { world.writes().count == 1 })
        try await Task.sleep(nanoseconds: 100_000_000)
        _ = s.send("later please", to: kpi, delivery: "queue") { _ in }
        #expect(await until { world.writes().count == 2 })
        let w = world.writes()
        #expect(w[0].contains("\"delivery\":\"steer\"") && w[1].contains("\"delivery\":\"queue\""))
    }

    @Test func choicesForTheComposerAreRead() async throws {
        let (s, _, _) = await liveStore()
        let c = try #require(s.conversation("ses_fakeSprint03"))
        s.retain(c.id)
        #expect(await until { s.agents["private/default"] != nil && s.models["private/default"] != nil })
        #expect(s.agents["private/default"]?.map(\.id) == ["build", "plan"] && s.models["private/default"]?.map(\.id).contains("coding-pro") == true)
        s.release(c.id)
    }
}
