// The agent bridge end to end over the stand-in Campus (S2): a request record in, the Campus calls it makes (read from the stand-in's own log of what reached it),
// and the reply file out. Records are written the way `fm-ask` writes them; replies are read the way `fm-ask wait` does (everything after the first `--` line).
import Testing
import Foundation
import ConnCore
import FakeCampusKit

@MainActor
private final class Lab {
    let world = FakeCampusWorld()
    let auth: FakeCampusAuth
    let store: CampusStore
    let registry: BridgeRegistry
    let ownership: BridgeOwnership
    let audit: BridgeAuditLog
    let engine: BridgeEngine
    var seq = 0
    var clock = Date()

    init(limits: BridgeLimits = BridgeLimits(), budget: TimeInterval = 5) async {
        world.stepDelay = 0.01
        auth = FakeCampusAuth(world: world)
        store = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
        store.statusDelay = 0.02
        registry = BridgeRegistry(directory: bridgeTempDir("engine"))
        let n = "conn.tests.bridgeEngine.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: n)!; d.removePersistentDomain(forName: n)
        ownership = BridgeOwnership(defaults: d)
        audit = BridgeAuditLog(file: bridgeTempDir("audit").appendingPathComponent("audit.jsonl"))
        engine = BridgeEngine(store: store, registry: registry, ownership: ownership, audit: audit)
        engine.limits = limits; engine.waitBudget = budget; engine.pollInterval = 0.02; engine.scanInterval = 0.05; engine.startGrace = 2
        await store.refresh()
    }

    func on() { engine.setEnabled(true) }

    /// A request as `fm-ask` leaves it. Returns the record's file name.
    @discardableResult
    func drop(_ id: String, _ text: String, kind: String = "leader", ref: String = "leader-esim", at: Date? = nil) throws -> String {
        seq += 1
        let name = String(format: "%03d.msg", seq)
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime]
        let record = "schema=fm-task-inbox.v1\nat=\(iso.string(from: at ?? Date()))\nbody-terminator=1\n--\nfm-ask request-id=\(id)\nfrom-kind=\(kind)\nfrom-ref=\(ref)\nreply-home=/Users/x/firstmate\n--\n\(text)\n"
        try registry.writeInbox(name, record)
        return name
    }

    /// Run everything waiting to the end and return the reply text of `id` (everything after the first `--` line).
    func run(_ id: String) async -> String {
        engine.scan()
        await engine.waitIdle()
        let raw = (try? String(contentsOf: registry.replies.appendingPathComponent(id), encoding: .utf8)) ?? ""
        return raw.components(separatedBy: "\n--\n").dropFirst().joined(separator: "\n--\n")
    }

    func ask(_ id: String, _ text: String, ref: String = "leader-esim", kind: String = "leader") async throws -> String {
        try drop(id, text, kind: kind, ref: ref)
        return await run(id)
    }

    func field(_ reply: String, _ key: String) -> String? {
        for l in reply.components(separatedBy: "\n") where l.hasPrefix(key + ": ") { return String(l.dropFirst(key.count + 2)) }
        return nil
    }

    func writes(_ filter: String = "") -> [String] { world.writes().filter { filter.isEmpty || $0.contains(filter) } }
    func newText(_ topic: String = "Second reader") -> String { "campus: new\ntopic: \(topic)\n---\nWhat would a finance lead misread in our cashback copy?" }
}

private extension BridgeRegistry {
    func writeInbox(_ name: String, _ text: String) throws {
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        try Data(text.utf8).write(to: inbox.appendingPathComponent(name))
    }
}

@Suite("Bridge: the switch and the registry") @MainActor struct BridgeSwitchTests {
    @Test func offAtLaunchAndNothingIsReadUntilItIsOn() async throws {
        let lab = await Lab()
        #expect(!lab.engine.enabled && !FileManager.default.fileExists(atPath: lab.registry.metaFile.path))
        try lab.drop("r-off", lab.newText())
        lab.engine.scan(); await lab.engine.waitIdle()
        #expect(lab.writes().isEmpty && !lab.registry.replyExists("r-off") && lab.registry.pending().count == 1)
        lab.on()
        #expect(lab.engine.enabled && lab.registry.registeredPID == getpid())
        let reply = await lab.run("r-off")
        #expect(lab.field(reply, "status") == "done")
        lab.engine.setEnabled(false)
        #expect(!lab.engine.enabled && lab.registry.registeredPID == nil)
        try lab.drop("r-after", lab.newText())
        lab.engine.scan(); await lab.engine.waitIdle()
        #expect(!lab.registry.replyExists("r-after"))                       // off again: not read
    }

    @Test func aSecondConnHoldingTheNameStopsTheSwitchWithAReason() async throws {
        let lab = await Lab()
        try lab.registry.register(pid: getppid())
        lab.engine.setEnabled(true)
        #expect(!lab.engine.enabled && lab.engine.problem?.contains("already the session 'campus'") == true)
    }

    @Test func aRecordLeftByAGoneConnIsClearedWhenTheEngineIsMade() async throws {
        let dir = bridgeTempDir("clear")
        let r = BridgeRegistry(directory: dir)
        try r.register(pid: 2_000_000_000)
        let lab = await Lab()
        _ = BridgeEngine(store: lab.store, registry: r, ownership: lab.ownership, audit: lab.audit)
        #expect(r.registeredPID == nil)
    }
}

@Suite("Bridge: starting, continuing and reading") @MainActor struct BridgeFlowTests {
    @Test func aNewThreadIsStartedInMySpaceWithThePreambleThePlanAgentTheRequestIdAsKeyAndATitle() async throws {
        let lab = await Lab(); lab.on()
        lab.world.setNextRun(.normal, reply: "Two things a finance lead could misread: the 30 days and the cap.")
        let reply = try await lab.ask("req-new-1", lab.newText())
        #expect(lab.field(reply, "status") == "done" && reply.contains("Two things a finance lead could misread"))
        let thread = try #require(lab.field(reply, "thread"))
        #expect(thread.hasPrefix("ses_fakeNew") && lab.field(reply, "url")?.hasSuffix("/spaces/private/default/conversations/\(thread)") == true && lab.field(reply, "tokens") == "in=3400 out=212")
        let create = try #require(lab.writes("conversations {").first)
        #expect(create.hasPrefix("POST /api/spaces/private/default/conversations {") && create.contains("\"agent\":\"plan\"") && create.contains("[Idempotency-Key: req-new-1]"))
        #expect(create.contains("automated") && create.contains("read-only") && create.contains("What would a finance lead misread"))
        let rename = try #require(lab.writes("PATCH").first)
        #expect(rename.hasPrefix("PATCH /api/spaces/private/default/conversations/\(thread) ") && lab.world.conversation(thread)?.title == "fm/esim: Second reader" && lab.store.conversation(thread)?.title == "fm/esim: Second reader")
        #expect(lab.ownership.mode(of: thread) == .owned && lab.store.conversation(thread) != nil)
        #expect(lab.registry.pending().isEmpty && FileManager.default.fileExists(atPath: lab.registry.handled.appendingPathComponent("001.msg").path))
        let entries = lab.audit.read()
        #expect(entries.count == 1 && entries[0].action == "new" && entries[0].sender == "leader-esim" && entries[0].requestID == "req-new-1" && entries[0].thread == thread && entries[0].outcome == "done" && entries[0].sha256.count == 64)
        let auditText = (try? String(contentsOf: lab.audit.file, encoding: .utf8)) ?? ""
        #expect(!auditText.contains("finance lead") && !auditText.contains("Two things"))        // sizes and hashes, never text
        #expect(lab.engine.activity.first?.outcome == "done" && lab.engine.last24h == 1)
    }

    @Test func theSameRequestIdAgainIsNotDoneTwice() async throws {
        let lab = await Lab(); lab.on()
        let first = try await lab.ask("req-dup", lab.newText())
        let count = lab.writes("conversations {").count
        try lab.drop("req-dup", lab.newText())                                   // the record again (a replay)
        let second = await lab.run("req-dup")
        #expect(second == first && lab.writes("conversations {").count == count && lab.registry.pending().isEmpty)
    }

    @Test func continueSendsToTheOwnedThreadAndReturnsTheNewReplyNotTheOldOne() async throws {
        let lab = await Lab(); lab.on()
        lab.world.setNextRun(.normal, reply: "First answer.")
        let r1 = try await lab.ask("req-c1", lab.newText())
        let thread = try #require(lab.field(r1, "thread"))
        lab.world.setNextRun(.normal, reply: "Second answer, about Q2.")
        let r2 = try await lab.ask("req-c2", "campus: continue \(thread)\n---\nAnd for Q2?")
        #expect(lab.field(r2, "status") == "done" && r2.contains("Second answer, about Q2.") && !r2.contains("First answer."))
        let prompt = try #require(lab.writes("/prompt").first)
        #expect(prompt.contains("\"text\":\"And for Q2?\"") && !prompt.contains("automated"))
        #expect(lab.audit.read().map(\.action) == ["new", "continue"])
    }

    @Test func readReturnsTheLastReplyWithoutSendingAnything() async throws {
        let lab = await Lab(); lab.on()
        lab.world.setNextRun(.normal, reply: "The only answer.")
        let r1 = try await lab.ask("req-r1", lab.newText())
        let thread = try #require(lab.field(r1, "thread"))
        let before = lab.writes().count
        let r2 = try await lab.ask("req-r2", "campus: read \(thread)")
        #expect(lab.field(r2, "status") == "done" && r2.contains("The only answer.") && lab.writes().count == before)
    }

    @Test func aReplyOverSixtyFourKilobytesIsCutAndTheUrlOpensTheRest() async throws {
        let lab = await Lab(); lab.on()
        lab.world.setNextRun(.normal, reply: String(repeating: "word ", count: 20_000))        // 100,000 bytes
        let reply = try await lab.ask("req-big", lab.newText())
        let text = String(reply.components(separatedBy: "reply:").dropFirst().joined(separator: "reply:"))
        #expect(lab.field(reply, "status") == "done" && text.utf8.count <= BridgeReply.maxReplyBytes + 1 && text.contains("[cut: the rest of the reply is in Campus]") && lab.field(reply, "url") != nil)
    }

    @Test func aReplyCarriesTextPartsOnly() async throws {
        let lab = await Lab(); lab.on()
        // The stand-in's finished run has reasoning and tool parts in the timeline but the reply message holds the text; check no tool output leaks into the reply.
        let reply = try await lab.ask("req-parts", lab.newText())
        #expect(!reply.contains("20 rows") && !reply.contains("python3 diff_rates.py") && !reply.contains("diffing merchant"))
    }
}

@Suite("Bridge: which threads, which callers") @MainActor struct BridgeAccessTests {
    @Test func aThreadNobodySharedIsRefusedOnEveryActionAndNothingReachesCampus() async throws {
        let lab = await Lab(); lab.on()
        let before = lab.writes().count
        let c = try await lab.ask("req-x1", "campus: continue ses_fakeSprint03\n---\nhello")
        let r = try await lab.ask("req-x2", "campus: read ses_fakeSprint03")
        #expect(lab.field(c, "status") == "refused" && lab.field(r, "status") == "refused" && lab.field(c, "reason")?.contains("not one the bridge started") == true)
        #expect(lab.writes().count == before && lab.writes("ses_fakeSprint03").isEmpty)
    }

    @Test func aThreadTheOwnerSharedForReadingCanBeReadButNotSentTo() async throws {
        let lab = await Lab(); lab.on()
        lab.ownership.setShared(CampusAddress(kind: "private", folder: "default", id: "ses_fakeSprint03"), .read)
        let r = try await lab.ask("req-s1", "campus: read ses_fakeSprint03")
        #expect(lab.field(r, "status") == "done" && r.contains("Sprint 42 closed"))
        let c = try await lab.ask("req-s2", "campus: continue ses_fakeSprint03\n---\nhello")
        #expect(lab.field(c, "status") == "refused" && lab.field(c, "reason")?.contains("reading only") == true && lab.writes("ses_fakeSprint03").isEmpty)
        // Shared for reading and sending: the send goes through.
        lab.ownership.setShared(CampusAddress(kind: "private", folder: "default", id: "ses_fakeSprint03"), .readWrite)
        lab.world.setNextRun(.normal, reply: "Sent and answered.")
        let w = try await lab.ask("req-s3", "campus: continue ses_fakeSprint03\n---\nhello")
        #expect(lab.field(w, "status") == "done" && w.contains("Sent and answered.") && lab.writes("ses_fakeSprint03/prompt").count == 1)
    }

    @Test(arguments: [
        ("child", "fm-conn-fix-queue", "worker"), ("session", "session-4242", "plain session"), ("leader", "leader-personal-work", "personal"), ("child", "fm-personal-budget", "personal"), ("leader", "", "does not say who"),
    ])
    func callersOutsideTheListAreRefusedWithoutAnyCampusCall(kind: String, ref: String, word: String) async throws {
        let lab = await Lab(); lab.on()
        let r = try await lab.ask("req-caller-\(kind)", lab.newText(), ref: ref, kind: kind)
        #expect(lab.field(r, "status") == "refused" && lab.field(r, "reason")?.contains(word) == true && lab.writes().isEmpty)
        #expect(lab.audit.read().first?.outcome == "refused")
    }

    @Test func aCaptainDrivenWorkerAllowedInSettingsGetsThrough() async throws {
        let lab = await Lab(); lab.on()
        lab.engine.callers = BridgeCallers(alsoAllowed: ["fm-campus-trial"])
        let r = try await lab.ask("req-w1", lab.newText(), ref: "fm-campus-trial", kind: "child")
        #expect(lab.field(r, "status") == "done" && lab.writes("conversations {").count == 1)
    }
}

@Suite("Bridge: the agent and the turn reservation") @MainActor struct BridgeReservationTests {
    @Test func aRequestCannotPickAnAgentOutsideTheAllowedList() async throws {
        let lab = await Lab(); lab.on()
        let bad = try await lab.ask("req-ag1", "campus: new\nagent: build\n---\nPlease do the work.")
        #expect(lab.field(bad, "status") == "refused" && lab.field(bad, "reason")?.contains("agent 'build' is not allowed") == true && lab.writes().isEmpty)
        let ok = try await lab.ask("req-ag2", "campus: new\nagent: plan\n---\nPlease plan the work.")
        #expect(lab.field(ok, "status") == "done" && lab.writes("conversations {").first?.contains("\"agent\":\"plan\"") == true)
        lab.engine.allowedAgents = ["plan", "review"]
        let rev = try await lab.ask("req-ag3", "campus: new\nagent: review\n---\nPlease review.")
        #expect(lab.field(rev, "status") == "done" && lab.writes("conversations {").last?.contains("\"agent\":\"review\"") == true)
        // A continue that names a disallowed agent is refused too (it would be ignored, which hides the attempt).
        let thread = try #require(lab.field(ok, "thread"))
        let c = try await lab.ask("req-ag4", "campus: continue \(thread)\nagent: build\n---\nhi")
        #expect(lab.field(c, "status") == "refused" && lab.writes("/prompt").isEmpty)
    }

    @Test func twoContinuesOnOneThreadCannotBothPassTheTurnCap() async throws {
        var lim = BridgeLimits(); lim.turnsPerThread = 2
        let lab = await Lab(limits: lim); lab.on()
        let r = try await lab.ask("req-tr0", lab.newText())                 // turn 1
        let thread = try #require(lab.field(r, "thread"))
        try lab.drop("req-tr1", "campus: continue \(thread)\n---\nfirst")
        try lab.drop("req-tr2", "campus: continue \(thread)\n---\nsecond")
        lab.engine.scan(); await lab.engine.waitIdle()
        func status(_ id: String) -> String {
            let raw = (try? String(contentsOf: lab.registry.replies.appendingPathComponent(id), encoding: .utf8)) ?? ""
            return lab.field(raw.components(separatedBy: "\n--\n").dropFirst().joined(separator: "\n--\n"), "status") ?? "?"
        }
        let s = [status("req-tr1"), status("req-tr2")].sorted()
        #expect(s == ["done", "refused"] && lab.writes("/prompt").count == 1, "\(s)")
    }
}

@Suite("Bridge: what is refused before anything is sent") @MainActor struct BridgeRefusalTests {
    @Test func formatSecretsSizeAttachmentsAndStaleRequestsAreRefusedWithAReplyAndNoCampusCall() async throws {
        let lab = await Lab(); lab.on()
        let cases: [(String, String, String)] = [
            ("req-f1", "hello there", "format"),
            ("req-f2", "campus: new\n---\nuse this: -----BEGIN PRIVATE KEY-----\nabc", "private key"),
            ("req-f3", "campus: new\n---\nexport STRIPE_SECRET_KEY=sk_live_1234567890", "secret"),
            ("req-f4", "campus: new\n---\n" + String(repeating: "a short sentence. ", count: 600), "over 8 KB"),
            ("req-f5", "campus: new\nattach: /tmp/report.pdf\n---\nplease read", "attachments"),
            ("req-f6", "campus: new\n---\nsee data:application/pdf;base64,JVBERi0xLjQ", "attachment"),
        ]
        for (id, text, word) in cases {
            let r = try await lab.ask(id, text)
            #expect(["refused", "failed"].contains(lab.field(r, "status") ?? ""), "\(id): \(r)")
            #expect((lab.field(r, "reason") ?? "").contains(word), "\(id): \(r)")
        }
        try lab.drop("req-f7", lab.newText(), at: Date().addingTimeInterval(-3600))
        let stale = await lab.run("req-f7")
        #expect(lab.field(stale, "status") == "refused" && lab.field(stale, "reason")?.contains("waited") == true)
        #expect(lab.writes().isEmpty && lab.registry.pending().isEmpty && lab.audit.read().count == 7)
    }
}

@Suite("Bridge: questions, permissions, working, signed out") @MainActor struct BridgeStatesTests {
    @Test func aPermissionRequestIsReturnedAndNeverAnswered() async throws {
        let lab = await Lab(); lab.on()
        lab.world.setNextRun(.permission)
        let r = try await lab.ask("req-p1", lab.newText())
        let thread = try #require(lab.field(r, "thread"))
        #expect(lab.field(r, "status") == "needs-answer" && lab.field(r, "reason") == "permission" && lab.field(r, "question")?.contains("bash") == true && lab.field(r, "question")?.contains("never answers") == true)
        // Even an explicit answer from the caller does not answer it.
        let a = try await lab.ask("req-p2", "campus: continue \(thread)\nanswer: yes allow it")
        #expect(lab.field(a, "status") == "needs-answer" && lab.field(a, "reason") == "permission")
        #expect(lab.writes("/permission").isEmpty && lab.writes("/form/").isEmpty && lab.writes("/prompt").isEmpty)
    }

    @Test func aQuestionIsReturnedAndAnAnswerContinuesTheRun() async throws {
        let lab = await Lab(); lab.on()
        lab.world.setNextRun(.ask)
        let r = try await lab.ask("req-q1", lab.newText())
        let thread = try #require(lab.field(r, "thread"))
        #expect(lab.field(r, "status") == "needs-answer" && lab.field(r, "question")?.contains("Which merchants should the summary lead with?") == true && lab.field(r, "question")?.contains("Top 5 by volume | Biggest rate gaps") == true)
        // No answer given: the question comes back, nothing is sent.
        let again = try await lab.ask("req-q2", "campus: continue \(thread)\n---\nsomething else")
        #expect(lab.field(again, "status") == "needs-answer" && lab.writes("/prompt").isEmpty && lab.writes("/form/").isEmpty)
        // Wrong number of parts: refused with the question again.
        let bad = try await lab.ask("req-q3", "campus: continue \(thread)\nanswer: a | b")
        #expect(lab.field(bad, "status") == "needs-answer" && lab.field(bad, "reason")?.contains("1 part") == true && lab.writes("/form/").isEmpty)
        lab.world.setNextRun(.normal, reply: "Led with the top five.")
        let ok = try await lab.ask("req-q4", "campus: continue \(thread)\nanswer: Top 5 by volume")
        #expect(lab.field(ok, "status") == "done" && ok.contains("Led with the top five."))
        let form = try #require(lab.writes("/form/").first)
        #expect(form.contains("/reply {\"answer\":\"Top 5 by volume\"}") && lab.writes("/permission").isEmpty)
    }

    @Test func anAnswerToAThreadThatAsksNothingIsRefused() async throws {
        let lab = await Lab(); lab.on()
        let r = try await lab.ask("req-a1", lab.newText())
        let thread = try #require(lab.field(r, "thread"))
        let a = try await lab.ask("req-a2", "campus: continue \(thread)\nanswer: yes")
        #expect(lab.field(a, "status") == "refused" && lab.field(a, "reason")?.contains("not waiting for an answer") == true)
    }

    @Test func aRunStillGoingWhenTheBudgetEndsIsWorkingNotAFailureAndReadFindsTheEnd() async throws {
        let lab = await Lab(budget: 0.4); lab.on()
        lab.world.setNextRun(.hold)
        let r = try await lab.ask("req-h1", lab.newText())
        let thread = try #require(lab.field(r, "thread"))
        #expect(lab.field(r, "status") == "working" && lab.field(r, "reason")?.contains("campus: read \(thread)") == true)
        // Sending to a thread that is still working sends nothing.
        let c = try await lab.ask("req-h2", "campus: continue \(thread)\n---\nhurry up")
        #expect(lab.field(c, "status") == "working" && lab.field(c, "reason")?.contains("nothing was sent") == true && lab.writes("/prompt").isEmpty)
        lab.world.release(thread)
        let done = try await lab.ask("req-h3", "campus: read \(thread)")
        #expect(lab.field(done, "status") == "done" && done.contains("Released: here is the reply."))
    }

    @Test func signedOutAnswersAtOnceAndSendsNothing() async throws {
        // A 30-second budget and a 20-second bound: "at once" means it did not wait for the budget, and a bound as tight as the old 5 s budget failed on a loaded machine.
        let lab = await Lab(budget: 30); lab.on()
        lab.auth.override = { _ in CampusReply(status: 401, body: Data("{\"error\":\"no valid campus_session cookie\"}".utf8)) }
        await lab.store.refresh()
        #expect(lab.store.link == .expired)
        let t0 = Date()
        let r = try await lab.ask("req-so", lab.newText())
        #expect(lab.field(r, "status") == "signed-out" && Date().timeIntervalSince(t0) < 20 && lab.writes().isEmpty)
        lab.auth.override = nil
    }

    @Test func campusSigningOutDuringACallIsSignedOutToo() async throws {
        let lab = await Lab(); lab.on()
        lab.auth.override = { r in r.method == "POST" ? CampusReply(status: 401, body: Data("{\"error\":\"no valid campus_session cookie\"}".utf8)) : nil }
        let r = try await lab.ask("req-so2", lab.newText())
        #expect(lab.field(r, "status") == "signed-out" && lab.store.link == .expired)
    }

    @Test func aBlockedNetworkAnswersAtOnceAsFailedWithTheNetworkWordsNotSignedOut() async throws {
        let lab = await Lab(budget: 30); lab.on()
        lab.auth.override = { _ in CampusReply(status: 403, body: Data(FakeCampusWorld.nginxForbidden.utf8)) }
        await lab.store.refresh()
        #expect(lab.store.link == .blocked)
        let t0 = Date()
        let r = try await lab.ask("req-bl", lab.newText())
        #expect(lab.field(r, "status") == "failed" && lab.field(r, "reason")?.contains("Zscaler") == true && Date().timeIntervalSince(t0) < 20 && lab.writes().isEmpty)
        lab.auth.override = nil
    }

    @Test func theNetworkBlockingDuringACallBlocksTheLinkAndIsNotSignedOut() async throws {
        let lab = await Lab(); lab.on()
        lab.auth.override = { r in r.method == "POST" ? CampusReply(status: 403, body: Data(FakeCampusWorld.nginxForbidden.utf8)) : nil }
        let r = try await lab.ask("req-bl2", lab.newText())
        #expect(lab.field(r, "status") == "failed" && lab.field(r, "reason")?.contains("Zscaler") == true && lab.store.link == .blocked)
    }

    @Test func anUnexpectedAnswerToAStartIsAShapeFailureWithoutAThread() async throws {
        let lab = await Lab(); lab.on()
        lab.auth.override = { r in r.method == "POST" && r.path.hasSuffix("/conversations") ? CampusReply(status: 200, body: Data("{\"ok\":true}".utf8)) : nil }
        let r = try await lab.ask("req-shape", lab.newText())
        #expect(lab.field(r, "status") == "failed" && lab.field(r, "reason")?.hasPrefix("shape:") == true && lab.field(r, "thread") == nil && lab.ownership.shares.isEmpty)
    }

    @Test func switchingOffWhileARequestWaitsAnswersItAsStopped() async throws {
        let lab = await Lab(budget: 30); lab.on()
        lab.world.setNextRun(.hold)
        try lab.drop("req-off-mid", lab.newText())
        lab.engine.scan()
        try await Task.sleep(nanoseconds: 400_000_000)
        lab.engine.setEnabled(false)
        await lab.engine.waitIdle()
        let raw = (try? String(contentsOf: lab.registry.replies.appendingPathComponent("req-off-mid"), encoding: .utf8)) ?? ""
        #expect(raw.contains("status: failed") && raw.contains("switched off"))
    }
}

@Suite("Bridge: the caps") @MainActor struct BridgeCapsEngineTests {
    @Test func theSeventhThreadInAnHourFromOneHomeIsRefusedAndAnotherHomeIsNot() async throws {
        let lab = await Lab(); lab.on()
        for i in 1...6 {
            let r = try await lab.ask("req-cap\(i)", lab.newText("Topic \(i)"))
            #expect(lab.field(r, "status") == "done", "request \(i): \(r)")
        }
        let seventh = try await lab.ask("req-cap7", lab.newText("Topic 7"))
        #expect(lab.field(seventh, "status") == "refused" && lab.field(seventh, "reason")?.contains("6 threads in the last hour") == true)
        #expect(lab.writes("conversations {").count == 6)
        let other = try await lab.ask("req-cap8", lab.newText("Topic 8"), ref: "leader-nip")
        #expect(lab.field(other, "status") == "done")
    }

    @Test func aBurstOfRequestsCannotPassTheCapTogether() async throws {
        var lim = BridgeLimits(); lim.newPerHourPerHome = 2
        let lab = await Lab(limits: lim); lab.on()
        lab.world.setNextRun(.hold)
        for i in 1...4 { try lab.drop("req-burst\(i)", lab.newText("Burst \(i)")) }
        lab.engine.waitBudgetShort()
        lab.engine.scan()
        await lab.engine.waitIdle()
        let statuses = (1...4).map { i in lab.field((try? String(contentsOf: lab.registry.replies.appendingPathComponent("req-burst\(i)"), encoding: .utf8))?.components(separatedBy: "\n--\n").last ?? "", "status") ?? "?" }
        #expect(statuses.filter { $0 == "refused" }.count == 2 && lab.writes("conversations {").count == 2, "\(statuses)")
    }

    @Test func aThreadHasTenTurns() async throws {
        var lim = BridgeLimits(); lim.turnsPerThread = 3
        let lab = await Lab(limits: lim); lab.on()
        let r = try await lab.ask("req-t0", lab.newText())
        let thread = try #require(lab.field(r, "thread"))
        for i in 1...2 { let c = try await lab.ask("req-t\(i)", "campus: continue \(thread)\n---\nturn \(i)"); #expect(lab.field(c, "status") == "done") }
        let over = try await lab.ask("req-t3", "campus: continue \(thread)\n---\none too many")
        #expect(lab.field(over, "status") == "refused" && lab.field(over, "reason")?.contains("3 turns") == true && lab.writes("/prompt").count == 2)
    }

    @Test func threeBridgeThreadsWorkingAtOnceIsTheLimit() async throws {
        var lim = BridgeLimits(); lim.working = 1
        let lab = await Lab(limits: lim, budget: 0.3); lab.on()
        lab.world.setNextRun(.hold)
        let first = try await lab.ask("req-w1", lab.newText("First"))
        #expect(lab.field(first, "status") == "working")
        let second = try await lab.ask("req-w2", lab.newText("Second"), ref: "leader-nip")
        #expect(lab.field(second, "status") == "refused" && lab.field(second, "reason")?.contains("already working") == true && lab.writes("conversations {").count == 1)
    }

    @Test func theDefaultsAreTheAgreedNumbers() {
        let l = BridgeLimits()
        #expect(l.newPerHourPerHome == 6 && l.newPerDay == 20 && l.working == 3 && l.turnsPerThread == 10 && l.requestBytes == 8 * 1024 && l.replyBytes == 64 * 1024)
    }
}

/// Polls without blocking the main actor (the engine's own tasks run on it).
@MainActor private func eventually(_ timeout: TimeInterval = 15, _ condition: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
}

@Suite("Bridge: waking on the event stream and on the inbox folder") @MainActor struct BridgeWakeTests {
    private func frame(_ type: String, _ sid: String) -> CampusFrame { CampusFrame(type: type, sessionID: sid) }

    /// A lab whose timers are too slow to matter: whatever answers in time was woken by an event or by the folder watch.
    private func slowTimers(budget: TimeInterval = 60, slowPoll: Bool = true) async -> Lab {
        let lab = await Lab(budget: budget)
        lab.engine.pollInterval = slowPoll ? 60 : 0.02; lab.engine.eventPollInterval = slowPoll ? 60 : 0.02
        lab.engine.scanInterval = 60; lab.engine.watchedScanInterval = 60; lab.engine.settleInterval = 0.1
        return lab
    }

    /// Starts a held run through the bridge and waits until the request is waiting on it (the rename that follows the start has reached the stand-in).
    private func startHeld(_ lab: Lab, _ id: String) async throws -> String {
        lab.world.setNextRun(.hold)
        let before = Set(lab.store.conversations.keys)
        try lab.drop(id, lab.newText())
        #expect(await eventually { lab.writes().contains { $0.hasPrefix("PATCH ") } })
        let thread = try #require(lab.store.conversations.keys.first { !before.contains($0) })
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(!lab.registry.replyExists(id))
        return thread
    }

    @Test func theFramesThatWakeARequestAreTheOnesThatCanChangeItsAnswer() {
        for t in ["session.idle", "session.execution.started", "session.execution.ended", "session.step.ended", "session.interrupted", "form.created", "form.replied", "permission.asked"] { #expect(BridgeWake.wakes(on: t), "\(t)") }
        for t in ["session.text.delta", "session.reasoning.delta", "session.tool.progress", "session.tool.success", "session.text.started", "session.created"] { #expect(!BridgeWake.wakes(on: t), "\(t)") }
        #expect(BridgeWake.settles(on: "session.idle") && BridgeWake.settles(on: "form.created") && !BridgeWake.settles(on: "session.step.ended") && !BridgeWake.settles(on: "session.execution.started"))
    }

    @Test func aWaitReturnsAtOnceForAnEventThatCameAfterTheCountWasTaken() async {
        let w = BridgeWake()
        let seen = w.count(of: "ses_a")
        w.signal("ses_a")
        let t0 = Date()
        #expect(await w.wait(for: "ses_a", since: seen, timeout: 30))
        #expect(Date().timeIntervalSince(t0) < 1)
        // No event: the wait ends at its timeout and says so.
        let t1 = Date()
        #expect(await w.wait(for: "ses_a", since: w.count(of: "ses_a"), timeout: 0.15) == false)
        #expect(Date().timeIntervalSince(t1) >= 0.1)
        // An event for another thread does not end it.
        let other = Task { @MainActor in await w.wait(for: "ses_b", since: w.count(of: "ses_b"), timeout: 0.3) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        w.signal("ses_a")
        #expect(await other.value == false)
    }

    @Test func aRunEndingWakesTheWaitAtOnceNotAtTheNextPoll() async throws {
        let lab = await slowTimers(); lab.on()
        let thread = try await startHeld(lab, "req-wk1")
        lab.world.release(thread)
        let t0 = Date()
        lab.store.handle(frame("session.idle", thread))
        #expect(await eventually(10) { lab.registry.replyExists("req-wk1") })
        let took = Date().timeIntervalSince(t0)
        let reply = await lab.run("req-wk1")
        #expect(lab.field(reply, "status") == "done" && reply.contains("Released: here is the reply."), "\(reply)")
        #expect(took < 5, "answered \(took) s after the event; the poll interval is 60 s")
    }

    @Test func anEventForAnotherThreadDoesNotWakeIt() async throws {
        let lab = await slowTimers(); lab.on()
        let thread = try await startHeld(lab, "req-wk2")
        lab.world.release(thread)
        lab.store.handle(frame("session.idle", "ses_someoneElse"))
        lab.store.handle(frame("session.text.delta", thread))
        try await Task.sleep(nanoseconds: 1_000_000_000)
        #expect(!lab.registry.replyExists("req-wk2"))
        lab.store.handle(frame("session.idle", thread))
        #expect(await eventually(10) { lab.registry.replyExists("req-wk2") })
    }

    @Test func aStatusThatIsBehindTheEventIsReadAgainAfterTheSettleInterval() async throws {
        let lab = await slowTimers(); lab.on()
        let thread = try await startHeld(lab, "req-wk3")
        // The event comes while Campus still says busy: the request reads once, sees busy, and reads again soon (not after 60 s).
        lab.store.handle(frame("session.idle", thread))
        try await Task.sleep(nanoseconds: 400_000_000)
        #expect(!lab.registry.replyExists("req-wk3"))
        lab.world.release(thread)
        #expect(await eventually(10) { lab.registry.replyExists("req-wk3") })
    }

    @Test func withNoEventsTheTimerStillAnswers() async throws {
        let lab = await Lab(budget: 60); lab.on()          // the lab's 0.02 s poll, no frame ever delivered
        lab.world.setNextRun(.hold)
        let before = Set(lab.store.conversations.keys)
        try lab.drop("req-wk4", lab.newText())
        #expect(await eventually { lab.writes().contains { $0.hasPrefix("PATCH ") } })
        let thread = try #require(lab.store.conversations.keys.first { !before.contains($0) })
        lab.world.release(thread)
        #expect(await eventually(10) { lab.registry.replyExists("req-wk4") })
    }

    @Test func switchingOffEndsAWaitAtOnce() async throws {
        let lab = await slowTimers(); lab.on()
        _ = try await startHeld(lab, "req-wk5")
        lab.engine.setEnabled(false)
        #expect(await eventually(5) { lab.registry.replyExists("req-wk5") })
        #expect(lab.field(await lab.run("req-wk5"), "reason")?.contains("switched off") == true)
    }

    // MARK: the inbox folder

    @Test func aRecordIsReadTheMomentItArrivesNotAtTheNextTimer() async throws {
        let lab = await slowTimers(slowPoll: false); lab.on()
        #expect(lab.engine.watchingInbox)
        let t0 = Date()
        try lab.drop("req-ib1", lab.newText())
        #expect(await eventually(10) { lab.registry.replyExists("req-ib1") })
        #expect(Date().timeIntervalSince(t0) < 6, "the timer is 60 s")
        #expect(lab.field(await lab.run("req-ib1"), "status") == "done")
    }

    @Test func withoutAFolderWatchTheTimerReadsTheInbox() async throws {
        let lab = await Lab(); lab.engine.watchInbox = false; lab.on()
        #expect(!lab.engine.watchingInbox)
        try lab.drop("req-ib2", lab.newText())
        #expect(await eventually(10) { lab.registry.replyExists("req-ib2") })
    }

    @Test func aWatchOnAFolderThatWentAwayIsMadeAgain() async throws {
        let lab = await Lab(); lab.engine.watchedScanInterval = 0.1; lab.on()
        #expect(lab.engine.watchingInbox)
        try FileManager.default.removeItem(at: lab.registry.inbox)
        #expect(await eventually(5) { !lab.engine.watchingInbox })
        try FileManager.default.createDirectory(at: lab.registry.inbox, withIntermediateDirectories: true)
        #expect(await eventually(5) { lab.engine.watchingInbox })
        try lab.drop("req-ib3", lab.newText())
        #expect(await eventually(10) { lab.registry.replyExists("req-ib3") })
    }

    @Test func aRecordStillBeingWrittenIsNotMovedAsideAsUnreadable() async throws {
        let lab = await slowTimers(slowPoll: false); lab.on()
        // A writer that does not stage and rename: the file appears empty, the folder watch fires, the content comes a moment later.
        let name = "001.msg"
        try FileManager.default.createDirectory(at: lab.registry.inbox, withIntermediateDirectories: true)
        let url = lab.registry.inbox.appendingPathComponent(name)
        FileManager.default.createFile(atPath: url.path, contents: Data())
        try await Task.sleep(nanoseconds: 150_000_000)
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime]
        let record = "schema=fm-task-inbox.v1\nat=\(iso.string(from: Date()))\nbody-terminator=1\n--\nfm-ask request-id=req-ib4\nfrom-kind=leader\nfrom-ref=leader-esim\nreply-home=/Users/x/firstmate\n--\n\(lab.newText())\n"
        try Data(record.utf8).write(to: url)
        #expect(await eventually(10) { lab.registry.replyExists("req-ib4") })
        #expect(!lab.engine.activity.contains { $0.reason?.contains("unreadable") == true })
    }

    @Test func aStagedFileAndAFileThatIsNotARecordAreLeftAlone() async throws {
        let lab = await slowTimers(slowPoll: false); lab.on()
        try FileManager.default.createDirectory(at: lab.registry.inbox, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: lab.registry.inbox.appendingPathComponent(".staging.abc123").path, contents: Data("half".utf8))
        FileManager.default.createFile(atPath: lab.registry.inbox.appendingPathComponent("notes.txt").path, contents: Data("x".utf8))
        try await Task.sleep(nanoseconds: 700_000_000)
        #expect(lab.engine.activity.isEmpty)
        #expect(FileManager.default.fileExists(atPath: lab.registry.inbox.appendingPathComponent("notes.txt").path))
    }
}

private extension BridgeEngine {
    /// A short wait for a held run (the burst test only needs the requests to be accepted).
    func waitBudgetShort() { waitBudget = 0.25 }
}
