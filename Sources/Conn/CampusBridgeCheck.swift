// `--ui-check` steps for the agent bridge (S2), run by `CampusCheck` against the stand-in Campus over HTTP (Conn's real web-view path). The check plays the part of `fm-ask`: it writes
// request records into the bridge's own session registry (a folder of this launch's own: never the person's) in the format `fm-ask` writes, and reads the reply files the way
// `fm-ask wait` does. What reached Campus is read from the stand-in's own log. Never the real Campus, never the person's registry or audit.
import SwiftUI
import WebKit
import ConnCore

extension CampusCheck {
    static func bridgeChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                             control: (String) async -> Void, js: (WKWebView, String) async -> String, shot: (String) async -> Void) async {
        let campus = model.campus
        guard let bridge = model.campusBridge, let auth = model.campusAuth else { report("Agent bridge: the checks need the bridge", false, "no bridge in this launch"); return }
        guard campus.link == .live else { report("Agent bridge: the checks need a live Campus", false, "link=\(campus.link)"); return }
        let base = campus.baseURL
        let reg = bridge.registry
        func log() async -> [String] {
            guard let u = URL(string: "/__fake/log", relativeTo: base), let (d, _) = try? await URLSession.shared.data(from: u) else { return [] }
            return CampusJSON.parse(d)?["writes"].array.compactMap(\.string) ?? []
        }
        var seq = 0
        func drop(_ id: String, _ text: String, kind: String = "leader", ref: String = "leader-esim", at: Date = Date()) {
            seq += 1
            let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime]
            let rec = "schema=fm-task-inbox.v1\nat=\(iso.string(from: at))\nbody-terminator=1\n--\nfm-ask request-id=\(id)\nfrom-kind=\(kind)\nfrom-ref=\(ref)\nreply-home=/Users/x/firstmate\n--\n\(text)\n"
            try? FileManager.default.createDirectory(at: reg.inbox, withIntermediateDirectories: true)
            try? Data(rec.utf8).write(to: reg.inbox.appendingPathComponent(String(format: "%03d.msg", 900 + seq)))
        }
        func reply(_ id: String, timeout: Double = 40) async -> String {
            _ = await until(timeout) { reg.replyExists(id) }
            let raw = (try? String(contentsOf: reg.replies.appendingPathComponent(id), encoding: .utf8)) ?? ""
            return raw.components(separatedBy: "\n--\n").dropFirst().joined(separator: "\n--\n")
        }
        func field(_ r: String, _ k: String) -> String? { r.components(separatedBy: "\n").first { $0.hasPrefix(k + ": ") }.map { String($0.dropFirst(k.count + 2)) } }
        func ask(_ id: String, _ text: String, kind: String = "leader", ref: String = "leader-esim", timeout: Double = 40) async -> String { drop(id, text, kind: kind, ref: ref); return await reply(id, timeout: timeout) }
        func metaHas(_ s: String) -> Bool { ((try? String(contentsOf: reg.metaFile, encoding: .utf8)) ?? "").contains(s) }
        let unique = String(UUID().uuidString.prefix(6)).lowercased()
        bridge.pollInterval = 0.4; bridge.scanInterval = 0.2

        // 1. Off at launch, and turning it on asks first.
        let launchedOff = !bridge.enabled && reg.registeredPID == nil
        model.requestCampusBridge()
        report("Agent bridge: off at launch (Conn is not the session 'campus'), and turning it on asks first without turning it on by itself", launchedOff && model.campusConfirmBridge && !bridge.enabled && reg.registeredPID == nil,
               "enabled=\(bridge.enabled) confirm=\(model.campusConfirmBridge) registered=\(String(describing: reg.registeredPID))")
        model.campusConfirmBridge = false
        // A request that arrives while it is off is left alone.
        drop("req-\(unique)-early", "campus: new\ntopic: too early\n---\nQuestion one for the stand-in.")
        await wait(1.0)
        let wEarly = await log()
        report("Agent bridge: with the switch off a request in the inbox is not read, not answered and nothing reaches Campus", !reg.replyExists("req-\(unique)-early") && reg.pending().count == 1 && !wEarly.contains { $0.contains("too early") }, "pending=\(reg.pending().count)")
        model.enableCampusBridge()
        report("Agent bridge: on, Conn is the session 'campus' (its record names this process, as fm-who reads it)", bridge.enabled && reg.registeredPID == getpid() && metaHas("name=campus") && metaHas("harness=conn") && metaHas("pid=\(getpid())"), "pid=\(String(describing: reg.registeredPID))")

        // 2. The request that waited is stale only after ten minutes: this one is fresh, so it is answered now. A new thread: preamble, plan agent, the request id as the key, a title.
        let first = await reply("req-\(unique)-early")
        let thread = field(first, "thread") ?? ""
        let w1 = await log()
        let create = w1.first { $0.contains("conversations {") && $0.contains("[Idempotency-Key: req-\(unique)-early]") } ?? ""
        report("Agent bridge: a request starts a thread in My space with the fixed read-only preamble, the plan agent and the request id as the Idempotency-Key, then titles it fm/<home>: <topic>",
               field(first, "status") == "done" && thread.hasPrefix("ses_") && create.hasPrefix("POST /api/spaces/private/default/conversations") && create.contains("\"agent\":\"plan\"") && create.contains("automated") && create.contains("read-only")
                 && w1.contains { $0.hasPrefix("PATCH /api/spaces/private/default/conversations/\(thread) ") && $0.contains("esim: too early") },
               "reply=\(first.prefix(160).replacingOccurrences(of: "\n", with: " | ")) title=\(campus.conversation(thread)?.title ?? "nil")")
        report("Agent bridge: the new thread is in the CAMPUS list with its title, marked as the bridge's, and the record was handed back", campus.conversation(thread)?.title == "fm/esim: too early" && bridge.ownership.mode(of: thread) == .owned && reg.pending().isEmpty,
               "title=\(campus.conversation(thread)?.title ?? "nil") mode=\(String(describing: bridge.ownership.mode(of: thread)))")
        await wait(0.5)
        await shot("campus-18-bridge-on.png")

        // 3. Continue returns the new reply; read returns it again without sending.
        await control("/__fake/next-run?mode=normal&reply=Second%20reply%20for%20the%20follow-up.")
        let second = await ask("req-\(unique)-c1", "campus: continue \(thread)\n---\nAnd what about the second question?")
        let prompts = (await log()).filter { $0.contains("/\(thread)/prompt") }
        report("Agent bridge: continue sends to the thread and returns the new reply, not the old one", field(second, "status") == "done" && second.contains("Second reply for the follow-up.") && prompts.count == 1 && !(prompts.first ?? "").contains("automated"), "reply=\(second.prefix(140).replacingOccurrences(of: "\n", with: " | "))")
        let before = (await log()).count
        let readBack = await ask("req-\(unique)-r1", "campus: read \(thread)")
        let afterRead = (await log()).count
        report("Agent bridge: read returns the last reply and sends nothing", field(readBack, "status") == "done" && readBack.contains("Second reply for the follow-up.") && afterRead == before, "status=\(field(readBack, "status") ?? "nil")")

        // 3b. With every timer set to 30 seconds, the event stream and the inbox folder watch still answer in seconds: the request is read the moment it arrives and the wait ends on the
        // stream's own `session.idle`, not at a poll. (The stand-in's run takes about 4 seconds.)
        let timers = (bridge.pollInterval, bridge.eventPollInterval, bridge.scanInterval, bridge.watchedScanInterval)
        bridge.pollInterval = 30; bridge.eventPollInterval = 30; bridge.scanInterval = 30; bridge.watchedScanInterval = 30
        await control("/__fake/next-run?mode=normal&reply=Woken%20by%20the%20stream.")
        let tWoken = Date()
        let woken = await ask("req-\(unique)-wk", "campus: continue \(thread)\n---\nAnd a third question?", timeout: 25)
        let wokenIn = Date().timeIntervalSince(tWoken)
        report("Agent bridge: with every timer at 30 s the inbox folder watch and the event stream still answer in seconds (the request is read on arrival, the wait ends on the stream's own idle event)",
               field(woken, "status") == "done" && woken.contains("Woken by the stream.") && wokenIn < 12 && campus.streamLive && bridge.watchingInbox,
               "took=\(String(format: "%.1f", wokenIn)) s status=\(field(woken, "status") ?? "nil") streamLive=\(campus.streamLive) watching=\(bridge.watchingInbox)")
        // 3c. A run still going when the wait ends is `working` and names its late file; Conn keeps watching and writes the end there as soon as the stream says the run is over (timers still at 30 s).
        let budget = bridge.waitBudget
        bridge.waitBudget = 2
        await control("/__fake/next-run?mode=hold")
        let working = await ask("req-\(unique)-lt", "campus: continue \(thread)\n---\nTake your time on this one.", timeout: 20)
        bridge.waitBudget = budget
        let lateName = "req-\(unique)-lt.late"
        let notYet = !FileManager.default.fileExists(atPath: reg.replies.appendingPathComponent(lateName).path)
        let tLate = Date()
        await control("/__fake/release?c=\(thread)")
        _ = await until(25) { reg.lateExists("req-\(unique)-lt") }
        let lateIn = Date().timeIntervalSince(tLate)
        let lateRaw = (try? String(contentsOf: reg.replies.appendingPathComponent(lateName), encoding: .utf8)) ?? ""
        let lateBody = lateRaw.components(separatedBy: "\n--\n").dropFirst().joined(separator: "\n--\n")
        let firstStill = field(await reply("req-\(unique)-lt"), "status") == "working"
        report("Agent bridge: a run still going when the wait ends is answered working with its late file named, and Conn writes the end of the run there within seconds of the stream's idle event (the first reply stays working)",
               field(working, "status") == "working" && field(working, "late") == lateName && notYet && field(lateBody, "status") == "done" && lateBody.contains("Released: here is the reply.") && lateIn < 12
                 && firstStill && bridge.audit.read().contains { $0.requestID == "req-\(unique)-lt" && $0.action == "late" && $0.outcome == "done" },
               "first=\(field(working, "status") ?? "nil") late=\(field(working, "late") ?? "nil") took=\(String(format: "%.1f", lateIn)) s lateStatus=\(field(lateBody, "status") ?? "nil")")
        _ = await until(10) { campus.conversation(thread)?.working == false }
        (bridge.pollInterval, bridge.eventPollInterval, bridge.scanInterval, bridge.watchedScanInterval) = timers

        // 4. A permission request comes back and is never answered; a question comes back and an answer continues the run.
        await control("/__fake/next-run?mode=permission")
        // The stand-in's log is the whole run's: the permission steps before these answered one of their own (a person's click), so only what the bridge sent from here on counts.
        let logBeforePermission = await log().count
        let perm = await ask("req-\(unique)-p1", "campus: continue \(thread)\n---\nPlease fetch the page.")
        let wp = Array(await log().dropFirst(logBeforePermission))
        report("Agent bridge: a permission request is returned as needs-answer (reason: permission) and never answered by the bridge", field(perm, "status") == "needs-answer" && field(perm, "reason") == "permission" && !wp.contains { $0.contains("/permission") } && !wp.contains { $0.contains("/\(thread)/form/") },
               "status=\(field(perm, "status") ?? "nil") reason=\(field(perm, "reason") ?? "nil")")
        let blockedAnswer = await ask("req-\(unique)-p2", "campus: continue \(thread)\nanswer: yes allow it")
        let wp2 = Array(await log().dropFirst(logBeforePermission))
        report("Agent bridge: an 'answer:' from the caller does not answer a permission request either", field(blockedAnswer, "reason") == "permission" && !wp2.contains { $0.contains("/permission") }, "status=\(field(blockedAnswer, "status") ?? "nil")")
        // The permission stays the person's: end that run on the stand-in so the next steps start clean (the stand-in has no route a bridge could use).
        await control("/__fake/release?c=\(thread)")
        _ = await until(10) { campus.conversation(thread)?.needsYou == false }
        await control("/__fake/next-run?mode=ask")
        let q = await ask("req-\(unique)-q1", "campus: continue \(thread)\n---\nWhich merchants should lead?")
        let answered = await { () -> String in
            await control("/__fake/next-run?mode=normal&reply=Led%20with%20the%20top%20five.")
            return await ask("req-\(unique)-q2", "campus: continue \(thread)\nanswer: Top 5 by volume")
        }()
        report("Agent bridge: a question is returned with its options and an 'answer:' continues the run to its reply", field(q, "status") == "needs-answer" && (field(q, "question") ?? "").contains("Top 5 by volume") && field(answered, "status") == "done" && answered.contains("Led with the top five."),
               "q=\(field(q, "status") ?? "nil") a=\(field(answered, "status") ?? "nil")")

        // 5. Refusals: a worker, a secret, a thread nobody shared, the Campus owner's own other threads.
        let writesBefore = (await log()).count
        let worker = await ask("req-\(unique)-w", "campus: new\n---\nhello", kind: "child", ref: "fm-conn-fix-queue")
        let secret = await ask("req-\(unique)-s", "campus: new\n---\nthe key is -----BEGIN PRIVATE KEY----- abc")
        let other = await ask("req-\(unique)-o", "campus: continue ses_fakeSprint03\n---\nhello")
        let writesAfter = (await log()).count
        report("Agent bridge: a worker, a secret and a thread nobody shared are each refused with a reply and nothing reaches Campus",
               field(worker, "status") == "refused" && field(secret, "status") == "refused" && field(other, "status") == "refused" && writesAfter == writesBefore, "worker=\(field(worker, "status") ?? "nil") secret=\(field(secret, "status") ?? "nil") other=\(field(other, "status") ?? "nil")")

        // 6. Share with Agents: reading only, then reading and sending.
        let sprint = campus.conversation("ses_fakeSprint03")!
        model.shareCampus(sprint, .read)
        let readShared = await ask("req-\(unique)-sr", "campus: read ses_fakeSprint03")
        let sendShared = await ask("req-\(unique)-ss", "campus: continue ses_fakeSprint03\n---\nhello")
        let wShare = await log()
        report("Agent bridge: Share with Agents (read only) lets a thread be read and still refuses a send", field(readShared, "status") == "done" && readShared.contains("Sprint 42 closed") && field(sendShared, "status") == "refused" && !wShare.contains { $0.contains("ses_fakeSprint03/prompt") }, "read=\(field(readShared, "status") ?? "nil") send=\(field(sendShared, "status") ?? "nil")")
        model.shareCampus(sprint, nil)

        // 7. Signed out: an answer at once, nothing sent.
        await control("/__fake/expire")
        campus.kick()
        _ = await until(12) { campus.link == .expired }
        let t0 = Date()
        let writesSO = (await log()).count
        let so = await ask("req-\(unique)-so", "campus: new\ntopic: while signed out\n---\nAre you there?", timeout: 10)
        let writesSO2 = (await log()).count
        report("Agent bridge: with Campus signed out a request is answered at once with signed-out and nothing is sent", field(so, "status") == "signed-out" && Date().timeIntervalSince(t0) < 5 && writesSO2 == writesSO, "status=\(field(so, "status") ?? "nil") after=\(String(format: "%.1f", Date().timeIntervalSince(t0))) s")
        model.signInToCampus()
        _ = await until(10) { auth.signInView.url?.path == "/campus/login" && !auth.signInView.isLoading }
        _ = await js(auth.signInView, "document.getElementById('go').click(); 'ok'")
        _ = await until(10) { auth.signInView.url?.path == "/campus/login/ok" && !auth.signInView.isLoading }
        campus.kick()
        _ = await until(15) { campus.link == .live }
        model.closeCampusSignIn()

        // 8. The audit and the activity list: one record per request, sizes and hashes, no text; the list shows them.
        let entries = bridge.audit.read()
        let auditText = (try? String(contentsOf: bridge.audit.file, encoding: .utf8)) ?? ""
        report("Agent bridge: the audit holds one record per request (sender as claimed, request id, thread, action, size, hash, outcome) and none of the text",
               entries.count >= 12 && entries.contains { $0.requestID == "req-\(unique)-early" && $0.thread == thread && $0.action == "new" && $0.outcome == "done" && $0.sha256.count == 64 } && !auditText.contains("second question") && !auditText.contains("Top 5") && !auditText.contains("PRIVATE KEY"),
               "entries=\(entries.count) file=\(bridge.audit.file.lastPathComponent)")
        report("Agent bridge: the activity list shows the requests, newest first, and the status bar counts them", bridge.activity.count >= 12 && bridge.last24h >= 12 && bridge.activity.first?.outcome == "signed-out", "activity=\(bridge.activity.count) today=\(bridge.last24h)")
        model.campusBridgeActivityShown = true
        await wait(0.8)
        await shot("campus-19-bridge-activity.png")
        model.campusBridgeActivityShown = false

        // 9. Off: the record is taken out of the registry, the inbox is left alone, nothing more is read.
        model.disableCampusBridge()
        drop("req-\(unique)-after", "campus: new\n---\nafter off")
        await wait(1.0)
        report("Agent bridge: off again, Conn leaves the registry (fm-who would not name it), and a later request is not read", !bridge.enabled && reg.registeredPID == nil && !reg.replyExists("req-\(unique)-after") && reg.pending().count == 1, "registered=\(String(describing: reg.registeredPID)) pending=\(reg.pending().count)")
        reg.acknowledge(fileName: String(format: "%03d.msg", 900 + seq))
        model.campusSelectedID = nil
    }
}

extension CampusCheck {
    /// `--campus-bridge-lab SECONDS`: a stand-in-only lab for a real `fm-ask`. It signs in to the stand-in Campus (the check's own way), turns the bridge on over the registry the launch was told about
    /// (`FM_SESSIONS_DIR`), says so on stdout, answers whatever arrives for SECONDS and quits, printing what the audit holds. Refuses any Campus that is not the stand-in.
    static func bridgeLab(model: AppModel, seconds: Double) async {
        func wait(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        func until(_ t: Double, _ done: () -> Bool) async -> Bool { var x = 0.0; while !done() && x < t { await wait(0.1); x += 0.1 }; return done() }
        func js(_ web: WKWebView, _ s: String) async -> String { ((try? await web.evaluateJavaScript(s)) as? String) ?? "" }
        let campus = model.campus
        guard let bridge = model.campusBridge, let auth = model.campusAuth, campus.baseURL.host == "127.0.0.1" else { print("bridge-lab: refused (not the stand-in Campus)"); model.shutdown(); NSApplication.shared.terminate(nil); return }
        await wait(5)
        model.signInToCampus()
        _ = await until(10) { auth.signInView.url?.path == "/campus/login" && !auth.signInView.isLoading }
        _ = await js(auth.signInView, "document.getElementById('go').click(); 'ok'")
        _ = await until(10) { auth.signInView.url?.path == "/campus/login/ok" && !auth.signInView.isLoading }
        campus.kick()
        let live = await until(20) { campus.link == .live }
        model.closeCampusSignIn()
        bridge.setEnabled(true)
        print("bridge-lab: ready live=\(live) enabled=\(bridge.enabled) registry=\(bridge.registry.directory.path) pid=\(getpid())")
        fflush(stdout)
        await wait(seconds)
        for a in bridge.activity.reversed() { print("bridge-lab: activity \(a.sender) \(a.action) \(a.thread ?? "-") \(a.outcome) \(a.reason ?? "")") }
        print("bridge-lab: audit entries=\(bridge.audit.read().count)")
        bridge.setEnabled(false)
        print("bridge-lab: done registered=\(String(describing: bridge.registry.registeredPID))")
        model.shutdown()
        NSApplication.shared.terminate(nil)
    }
}
