// `--ui-check` steps for Campus in Conn (README "Campus in Conn"). They run only against the stand-in Campus (`FakeCampus`, started by `run.sh --fixture`):
// the check refuses any other address, so it can never reach the real campus.shopback.com. What it exercises end to end, through Conn's real web-view path:
// signed out, the sign-in page in Conn's own web view (the stand-in's page sets an HttpOnly `campus_session` cookie), rows and marks, an ask sorting to the top, a live
// run on the stream, the "starting" and "expired" edge states, the Watch column rule with a Campus column, a session link in a Herdr column, Cmd-click, Cmd+J, the
// quick switcher rows, and (slice 2) the write gate. SwiftUI builds no accessibility tree for an inert background window (see StarredBarCheck), so the steps read the
// model; `CONN_UI_CHECK_SHOT_DIR=DIR` also writes pictures of each state, which are looked at by eye.
import SwiftUI
import WebKit
import ConnCore

@MainActor
enum CampusCheck {
    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        let campus = model.campus
        guard model.config.campusEnabled, let auth = model.campusAuth, let host = campus.baseURL.host, host == "127.0.0.1", campus.baseURL.port != nil else {
            print("ui-check: SKIP Campus (no stand-in Campus in this launch: use --fixture; the check never touches the real Campus)")
            return
        }
        let base = campus.baseURL
        let shots = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"].map { URL(fileURLWithPath: $0) }
        func shot(_ name: String) async { if let d = shots { await Capture.window(to: d.appendingPathComponent(name)) } }
        func until(_ timeout: Double = 12, _ done: () -> Bool) async -> Bool { var t = 0.0; while !done() && t < timeout { await wait(0.1); t += 0.1 }; return done() }
        func control(_ path: String) async {
            guard let u = URL(string: path, relativeTo: base) else { return }
            _ = try? await URLSession.shared.data(from: u)
        }
        func js(_ web: WKWebView, _ s: String) async -> String {
            let r = try? await web.evaluateJavaScript(s)
            return (r as? String) ?? (r.map { "\($0)" } ?? "")
        }
        let savedMode = model.mode, savedWatch = model.watchOn, savedWeb = model.showWeb
        model.privacy = false; model.watchOn = false
        model.mode = savedMode == .editor ? .herdr : savedMode
        model.showWeb = true; model.webTab = .reader

        // 1. Signed out: the section says so and lists nothing; the status bar says so.
        _ = await until(15) { campus.link == .expired }
        report("Campus: before the first sign-in the link is signed out with no rows and no 'as of' time",
               campus.link == .expired && campus.conversations.isEmpty && campus.asOf == nil && campus.asks.isEmpty && model.campusAuth?.kind == "cookie",
               "link=\(campus.link) rows=\(campus.conversations.count) asOf=\(campus.asOf.map { "\($0)" } ?? "nil") auth=\(model.campusAuth?.kind ?? "-")")
        await shot("campus-1-signed-out.png")

        // 2. Sign in inside Conn's own web view. The stand-in's login page sets an HttpOnly cookie; nothing of it reaches Conn's code.
        model.signInToCampus()
        let sheetShown = await until(5) { model.campusSignInShown }
        let loginLoaded = await until(10) { auth.signInView.url?.path == "/campus/login" && !auth.signInView.isLoading }
        report("Campus: Sign in opens the sheet on the Campus login page in Conn's own web view", sheetShown && loginLoaded, "shown=\(sheetShown) url=\(auth.signInView.url?.path ?? "nil")")
        await shot("campus-2-signin-sheet.png")
        _ = await js(auth.signInView, "document.getElementById('go').click(); 'ok'")
        let cookieSet = await until(10) { auth.signInView.url?.path == "/campus/login/ok" && !auth.signInView.isLoading }
        campus.kick()
        let live = await until(15) { campus.link == .live && campus.conversations.count == 8 }
        report("Campus: after the sign-in the list fills (8 conversations in 3 spaces) and the link is live", cookieSet && live && campus.spaces.count == 3, "link=\(campus.link) rows=\(campus.conversations.count) spaces=\(campus.spaces.count)")
        let closed = await until(10) { !model.campusSignInShown }
        if !closed { model.closeCampusSignIn() }
        report("Campus: the sign-in sheet closes by itself once Campus answers", closed, "closedByItself=\(closed)")
        // Only the stand-in's cookie counts: this process shares its cookie file with the person's own Conn (same bundle id), which holds the real Campus sign-in once they have signed in.
        let documentCookie = await js(auth.apiView, "document.cookie")
        let described = String(describing: campus.conversations) + String(describing: campus.openForms) + String(describing: campus.timelines)
        report("Campus: the cookie never reaches Conn: it is HttpOnly (the page cannot read it) and no Conn-side data holds it",
               documentCookie.isEmpty && !described.contains("fake-session-not-a-secret") && !(HTTPCookieStorage.shared.cookies ?? []).contains { $0.name == "campus_session" && $0.domain.contains("127.0.0.1") },
               "document.cookie='\(documentCookie)'")

        // 3. Rows, marks, order, counts.
        let privateTitles = campus.privateRows.map(\.id)
        report("Campus: private rows sort asks first, then done, then idle (newest first); team rows keep their own order",
               privateTitles.first == "ses_fakeDigest02" && campus.conversation("ses_fakeSprint03")?.state == .done && campus.conversation("ses_fakeKpi06")?.state == .working,
               "private=\(privateTitles.map { String($0.suffix(8)) }) team=\(campus.teamRows.map { String($0.id.suffix(8)) })")
        let askRow = campus.conversation("ses_fakeDigest02")
        report("Campus: a question shows as an ask on its row (its text and tag), counted in the section header and in AGENTS", askRow?.ask?.tag == "Answer sheet · 2 questions" && askRow?.ask?.text.hasPrefix("Which week") == true && campus.asks.contains { $0.id == "ses_fakeDigest02" },
               "ask=\(askRow?.ask?.text ?? "nil") asks=\(campus.asks.count)")
        await shot("campus-3-signed-in.png")

        // 4. An ask sorts to the top: the stand-in's autorun (or the check's own start) ends the run on a question.
        if campus.conversation("ses_fakeRates01")?.state != .blocked { await control("/__fake/run?c=ses_fakeRates01&ask=1") }
        let rose = await until(30) { campus.conversation("ses_fakeRates01")?.state == .blocked && campus.openForms["ses_fakeRates01"] != nil }
        report("Campus: a run that ends on a question moves its row to the top of the section and counts as an ask", rose && campus.privateRows.first?.id == "ses_fakeRates01" && campus.asks.count == 2,
               "top=\(campus.privateRows.first?.id.suffix(8) ?? "-") asks=\(campus.asks.count)")

        // 5. The live view and the transcript.
        model.openCampus("ses_fakeSprint03")
        let loaded = await until(10) { campus.timeline("ses_fakeSprint03")?.loaded == true }
        await wait(0.6)
        let sprintItems = campus.timeline("ses_fakeSprint03")?.items ?? []
        report("Campus: choosing a row shows it in the centre and clears the Herdr highlight; the row stops being 'done' in Conn; its messages load",
               model.campusSelectedID == "ses_fakeSprint03" && campus.conversation("ses_fakeSprint03")?.state == .idle && loaded && sprintItems.contains { $0.kind == .tool && $0.tool == "shell" } && sprintItems.contains { $0.kind == .text },
               "selected=\(model.campusSelectedID ?? "nil") state=\(campus.conversation("ses_fakeSprint03")?.state.label ?? "-") items=\(sprintItems.map { "\($0.kind)" })")
        let text = sprintItems.first { $0.kind == .text }?.text ?? ""
        let linkRuns = CampusText.attributed(text).runs.filter { $0.link != nil && CampusClient.conversationLink($0.link!, campusHost: host) != nil }
        report("Campus: a reply that names another Campus conversation by its link shows it as a link", linkRuns.count == 1 && CampusClient.conversationLink(linkRuns.first!.link!, campusHost: host)?.id == "ses_fakeOffsite04", "links=\(linkRuns.count)")
        await shot("campus-4-live-view-and-transcript.png")

        // 6. A live run on the stream: steps, a tool, reasoning, text, then done; the shown conversation is not marked unread.
        model.openCampus("ses_fakeOffsite04")
        _ = await until(10) { campus.timeline("ses_fakeOffsite04")?.loaded == true }
        await control("/__fake/run?c=ses_fakeOffsite04&text=Add%20a%20closing%20dinner&ask=0")
        let working = await until(10) { campus.conversation("ses_fakeOffsite04")?.working == true }
        let progressed = await until(15) { campus.timeline("ses_fakeOffsite04")?.items.contains { $0.kind == .tool && $0.toolStatus == .running } == true }
        let liveText = campus.timeline("ses_fakeOffsite04")?.live ?? ""
        await shot("campus-5-running.png")
        let finished = await until(25) { campus.conversation("ses_fakeOffsite04")?.working == false && campus.timeline("ses_fakeOffsite04")?.items.last?.kind == .idle }
        let kinds = (campus.timeline("ses_fakeOffsite04")?.items ?? []).map(\.kind)
        report("Campus: a run streams in: the row goes working, a tool shows as running with a live line, then the run ends with one end marker and the shown conversation is not 'done' to itself",
               working && progressed && !liveText.isEmpty && finished && kinds.contains(.reasoning) && kinds.last == .idle && !zip(kinds, kinds.dropFirst()).contains { $0 == .idle && $1 == .idle } && campus.conversation("ses_fakeOffsite04")?.state == .idle,
               "working=\(working) tool=\(progressed) live='\(liveText)' kinds=\(kinds) state=\(campus.conversation("ses_fakeOffsite04")?.state.label ?? "-")")
        await shot("campus-6-finished.png")

        // 6b. The reader's embed page: markdown, steps, links, the working strip, an open question, privacy, and the fallbacks.
        await embedChecks(model: model, report: report, wait: wait, until: until, control: control, shot: shot)

        // 7. Quick switcher rows and Cmd+J.
        let switcher = model.campusSwitcherRows
        report("Campus: the quick switcher lists Campus rows after Herdr's, asks first", switcher.count == 8 && switcher.first?.state == .blocked && switcher.prefix(2).allSatisfy { $0.state == .blocked }, "rows=\(switcher.count) first=\(switcher.first?.state.label ?? "-")")
        let waitingList = model.waitingTargets
        report("Campus: Cmd+J walks Herdr agents that wait on you, then Campus questions, newest first",
               waitingList.contains(.campus("ses_fakeRates01")) && waitingList.contains(.campus("ses_fakeDigest02")) && waitingList.lastIndex(where: { if case .herdr = $0 { return true } else { return false } }).map { $0 < waitingList.firstIndex(of: .campus("ses_fakeRates01"))! } != false,
               "targets=\(waitingList.count)")
        model.openCampus("ses_fakeSprint03")
        model.jumpToNextWaiting(); await wait(0.3)
        report("Campus: Cmd+J from a Campus row lands on a waiting item and a Campus question can be reached", { if case .campus = model.nextWaitingTarget() { return true }; if case .herdr = model.nextWaitingTarget() { return true }; return false }() && model.currentTarget != nil, "now=\(String(describing: model.currentTarget))")
        model.openCampus("ses_fakeRates01"); await wait(0.5)

        // 8. Privacy mode: the Campus text is redacted (a view-level change; the picture is the evidence).
        model.privacy = true; await wait(0.6)
        await shot("campus-7-privacy.png")
        model.privacy = false; await wait(0.3)

        // 9. Watch with a Campus column: the rule, links, Cmd-click.
        await watchChecks(model: model, report: report, wait: wait, until: until, js: js, shot: shot, host: host)

        // 10. The edge states: starting, then the login expiring with the last rows kept and dimmed.
        model.watchOn = false; await wait(0.5)
        model.openCampus("ses_fakeRates01")
        await control("/__fake/starting?on=1")
        campus.kick()
        let starting = await until(12) { campus.link == .starting }
        report("Campus: when Campus is starting the link says so and the rows stay (nothing is lost)", starting && campus.conversations.count == 8, "link=\(campus.link) rows=\(campus.conversations.count)")
        await shot("campus-8-starting.png")
        await control("/__fake/starting?on=0")
        campus.kick()
        let backLive = await until(12) { campus.link == .live }
        let asOfBefore = campus.asOf
        await control("/__fake/expire")
        campus.kick()
        let expired = await until(12) { campus.link == .expired }
        report("Campus: when the login expires the last rows stay, asks are no longer counted, and the 'as of' time is kept",
               backLive && expired && campus.conversations.count == 8 && campus.asks.isEmpty && campus.asOf != nil && campus.asOf! >= asOfBefore!, "link=\(campus.link) rows=\(campus.conversations.count) asks=\(campus.asks.count)")
        await wait(0.5)
        await shot("campus-9-expired.png")
        model.signInToCampus()
        _ = await until(10) { auth.signInView.url?.path == "/campus/login" && !auth.signInView.isLoading }
        _ = await js(auth.signInView, "document.getElementById('go').click(); 'ok'")
        _ = await until(10) { auth.signInView.url?.path == "/campus/login/ok" && !auth.signInView.isLoading }
        campus.kick()
        let again = await until(15) { campus.link == .live && campus.asOf! > asOfBefore! }
        model.closeCampusSignIn()
        report("Campus: signing in again brings the list back live", again, "link=\(campus.link)")

        await signedOutChecks(model: model, report: report, wait: wait, until: until, control: control, js: js, shot: shot)

        await writeChecks(model: model, report: report, wait: wait, until: until, control: control, shot: shot)

        model.campusSelectedID = nil
        // Leave Watch as it was found: the checks after this one open it again and must not meet a Campus column.
        model.watchOn = false
        for i in model.watch.layout.slots.indices where model.watch.layout.slots[i].map({ CampusColumn.isCampus($0.session) }) == true { model.watch.close(column: i) }
        model.watchOn = savedWatch; model.showWeb = savedWeb; model.mode = savedMode
    }

    /// `--campus-check`: just these steps, then quit.
    static func runAlone(model: AppModel) async {
        func wait(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        func report(_ name: String, _ ok: Bool, _ detail: String = "") { print("ui-check: \(ok ? "PASS" : "FAIL") \(name) \(detail)") }
        await wait(6)
        await run(model: model, report: report, wait: wait)
        print("ui-check: done")
        model.shutdown()
        NSApplication.shared.terminate(nil)
    }

    // MARK: the reader's embed page (E9=a)

    /// Needs the reader's embed page as a file (`CONN_EMBED_URL=file:///.../embed.html`: a copy of the reader's build, never the reader on 8768). Without one the step says so
    /// and the native transcript is what ran above.
    static func embedChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                            control: (String) async -> Void, shot: (String) async -> Void) async {
        let campus = model.campus
        guard let url = model.web.embedURL, url.isFileURL else {
            print("ui-check: SKIP Campus embed page (no CONN_EMBED_URL file: copy the reader's embed.html somewhere and point CONN_EMBED_URL at it; the native transcript is what ran above)")
            return
        }
        model.watchOn = false
        func box(_ id: String) -> CampusEmbedBox? { CampusEmbedBox.live.allObjects.first { $0.column == nil && $0.shownID == id && $0.phase == .ready && $0.sets > 0 } }
        func dom(_ b: CampusEmbedBox, _ expr: String) async -> String { await b.read("JSON.stringify((function(){ \(expr) })())") }
        func untilAsync(_ timeout: Double = 10, _ done: () async -> Bool) async -> Bool {
            var t = 0.0
            while t < timeout { if await done() { return true }; await wait(0.2); t += 0.2 }
            return await done()
        }
        func count(_ b: CampusEmbedBox, _ selector: String) async -> Int { Int(await dom(b, "return document.querySelectorAll(\(jsString(selector))).length;")) ?? -1 }

        // 1. The Reader column draws the conversation on the page.
        model.openCampus("ses_fakeSprint03")
        let shown = await until(20) { box("ses_fakeSprint03") != nil }
        guard let page = box("ses_fakeSprint03") else { report("Campus embed: the Reader column loads the reader's embed page and hands it the conversation", false, "no ready page; phases=\(CampusEmbedBox.live.allObjects.map { "\($0.phase)" })"); return }
        _ = await dom(page, "document.querySelectorAll('.reply .more').forEach(function(b){ b.click(); }); return 1;")
        await wait(0.4)
        report("Campus embed: the Reader column loads the reader's embed page and hands it the conversation (a message of yours and the reply)",
               shown && page.lastAnswer["ok"] as? Bool == true && (page.lastAnswer["blocks"] as? Int) == 2 && (page.lastAnswer["skipped"] as? Int) == 0,
               "answer=\(page.lastAnswer)")

        // 1b. The page is walled in: an opaque origin of its own (not the reader's, not a file's) and no network load of any kind, even a fetch the page's own policy would allow.
        let origin = await dom(page, "return location.origin;")
        let reached = (try? await page.webView.callAsyncJavaScript("try { await fetch(u, { mode: 'no-cors' }); return 'reached'; } catch (e) { return 'blocked'; }", arguments: ["u": campus.baseURL.absoluteString], in: nil, contentWorld: .page)) as? String ?? "?"
        report("Campus embed: the page runs on an opaque origin of its own and cannot reach any server (not Campus's stand-in, not the reader's)", origin == "\"null\"" && reached == "blocked", "origin=\(origin) fetch=\(reached)")

        // 2. It looks like a Claude or Codex session: the markdown is drawn, not shown raw.
        let inputs = await count(page, "#main .input"), replies = await count(page, "#main .reply"), tables = await count(page, ".reply .md table"), heads = Int(await dom(page, "return [].filter.call(document.querySelectorAll('.reply .md *'), function(n){ return n.children.length === 0 && n.textContent.trim() === 'Sprint 42'; }).length;")) ?? -1
        let bold = await count(page, ".reply .md strong"), boxes = await count(page, ".reply .codebox"), steps = await dom(page, "var r = document.querySelector('.steps-row'); return r ? r.textContent.trim().replace(/\\s+/g, ' ') : '';")
        let raw = await dom(page, "return document.getElementById('main').textContent.indexOf('##') >= 0 || document.getElementById('main').textContent.indexOf('**') >= 0 || document.getElementById('main').textContent.indexOf('|---') >= 0;")
        report("Campus embed: markdown is drawn as the reader draws it (heading, bold, table, code box), none of it shown raw",
               inputs == 1 && replies == 1 && tables == 1 && heads == 1 && bold >= 1 && boxes == 1 && raw == "false", "inputs=\(inputs) replies=\(replies) tables=\(tables) heading=\(heads) strong=\(bold) codebox=\(boxes) raw=\(raw)")
        report("Campus embed: the tool steps are one row in the reader's own words ('N steps')", steps.contains("2 steps"), "row='\(steps)'")
        await shot("campus-11-embed-transcript.png")

        // 3. Links go through Conn: a web address leaves for the browser (recorded here), a Campus conversation opens by the usual rule; the page never navigates.
        var opened: [URL] = []
        let savedOpen = CampusEmbedBox.openExternal
        CampusEmbedBox.openExternal = { opened.append($0) }
        let urlBefore = page.webView.url
        _ = await dom(page, "document.querySelector('.md a[href^=\"https://example.com\"]').click(); return 1;")
        let gotWeb = await until(5) { !opened.isEmpty }
        report("Campus embed: a web link in the page is handed to Conn (opened outside, the page does not navigate)", gotWeb && opened.first?.absoluteString == "https://example.com/retro-notes" && page.webView.url == urlBefore, "opened=\(opened.map(\.absoluteString)) navigated=\(page.webView.url != urlBefore)")
        _ = await dom(page, "document.querySelector('.md a[href*=\"ses_fakeOffsite04\"]').click(); return 1;")
        let gotCampus = await until(8) { model.campusSelectedID == "ses_fakeOffsite04" }
        report("Campus embed: a link to a Campus conversation opens it by the usual rule, not in the browser", gotCampus && opened.count == 1 && page.webView.url == urlBefore, "selected=\(model.campusSelectedID ?? "nil") opened=\(opened.count)")
        CampusEmbedBox.openExternal = savedOpen

        // 4. A run streams in: the page's working strip, the new message, then the strip goes.
        _ = await until(10) { box("ses_fakeOffsite04") != nil }
        await control("/__fake/run?c=ses_fakeOffsite04&text=Add%20a%20walking%20tour&ask=0")
        var strip = ""
        let stripShown = await untilAsync(15) {
            strip = await box("ses_fakeOffsite04")?.read("(function(){var s=document.querySelector('.embed-live .txt');return s&&getComputedStyle(s.parentNode.parentNode).display!=='none'?s.textContent:'';})()") ?? ""
            return !strip.isEmpty
        }
        await shot("campus-12-embed-running.png")
        let finished = await until(30) { campus.conversation("ses_fakeOffsite04")?.working == false && campus.timeline("ses_fakeOffsite04")?.items.last?.kind == .idle }
        await wait(0.6)
        let offsite = box("ses_fakeOffsite04")
        var sentText = "", stripAfter = ""
        if let o = offsite {
            sentText = await dom(o, "return [].map.call(document.querySelectorAll('#main .input'), function(n){return n.textContent;}).join('|');")
            stripAfter = await dom(o, "var s = document.querySelector('.embed-live'); return s ? getComputedStyle(s).display : 'none';")
        }
        report("Campus embed: a run shows the page's working strip while it goes, the new message and reply arrive in place, and the strip is gone when it ends",
               stripShown && finished && sentText.contains("Add a walking tour") && stripAfter.contains("none"), "strip='\(strip)' finished=\(finished) inputs=\(sentText.suffix(60)) stripAfter=\(stripAfter)")

        // 5. An open question is not on the page (it cannot answer one); Conn's own buttons answer it.
        model.openCampus("ses_fakeDigest02")
        _ = await until(10) { box("ses_fakeDigest02") != nil }
        await wait(0.6)
        if let digest = box("ses_fakeDigest02") {
            let asks = await count(digest, ".asks.cform"), needs = await count(digest, ".reply.needs")
            report("Campus embed: an open question is left off the page and stays with Conn's own answer buttons", asks == 0 && needs == 0 && campus.openForms["ses_fakeDigest02"] != nil && model.campusSelected?.needsYou == true, "page asks=\(asks) needs=\(needs) open=\(campus.openForms["ses_fakeDigest02"] != nil)")
            await shot("campus-13-embed-question.png")
        } else { report("Campus embed: an open question is left off the page and stays with Conn's own answer buttons", false, "no page") }

        // 6. Privacy mode takes the conversation off the page (the native view is redacted).
        model.openCampus("ses_fakeSprint03")
        _ = await until(10) { box("ses_fakeSprint03") != nil }
        model.privacy = true
        await wait(1.0)
        var hidden = -2
        if let b = box("ses_fakeSprint03") { hidden = await count(b, "#main .input, #main .reply") }
        model.privacy = false
        let back = await until(10) { box("ses_fakeSprint03") != nil }
        await wait(0.8)
        var backCount = -2
        if let b = box("ses_fakeSprint03") { backCount = await count(b, "#main .reply") }
        report("Campus embed: privacy mode empties the page and the conversation comes back when it is off", hidden == 0 && back && backCount == 1, "inPrivacy=\(hidden) after=\(backCount)")

        // 7. Without the page the native transcript stays: a missing file, a page with no entry point, a server that answers 404.
        let saved = CampusEmbedBox.loadTimeout
        CampusEmbedBox.loadTimeout = 6
        func phase(_ u: URL) async -> String {
            let b = CampusEmbedBox()
            b.start(url: u)
            _ = await until(12) { if case .unavailable = b.phase { return true }; return b.phase == .ready }
            b.release()
            return "\(b.phase)"
        }
        let missing = await phase(URL(fileURLWithPath: "/nonexistent-conn-check/embed.html"))
        let noEntry = await phase(URL(string: "/campus/login", relativeTo: campus.baseURL)!.absoluteURL)
        let notFound = await phase(URL(string: "/__fake/no-such-page.html", relativeTo: campus.baseURL)!.absoluteURL)
        CampusEmbedBox.loadTimeout = saved
        report("Campus embed: with no page (missing file, a page without the entry point, a 404) the box gives up with a reason and the native transcript stays",
               missing.hasPrefix("unavailable") && noEntry.hasPrefix("unavailable") && notFound.contains("404"), "missing=\(missing.prefix(60)) noEntry=\(noEntry.prefix(60)) 404=\(notFound.prefix(60))")
        // A page that does not carry the strict content policy is refused, even if it has the entry point.
        let loose = FileManager.default.temporaryDirectory.appendingPathComponent("conn-embed-loose-\(getpid()).html")
        try? "<!doctype html><title>loose</title><script>window.readerEmbed = { version: 1, set: function () { return { ok: true }; } };</script>".write(to: loose, atomically: true, encoding: .utf8)
        let looseResult = await phase(loose)
        report("Campus embed: a page without the strict content policy is refused, whatever else it has", looseResult.contains("content policy"), "loose=\(looseResult.prefix(90))")
        model.openCampus("ses_fakeOffsite04")
    }

    private static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let text = String(decoding: data, as: UTF8.self)
        return String(text.dropFirst().dropLast())
    }

    // MARK: 403 when signed out

    /// Real Campus answers 403 (not 401) to a person who is not signed in. The stand-in answers either; this flips it to 403 and back to what the launch had
    /// (`--campus-signed-out-403` starts it on 403, which makes the very first step above the "never signed in with a 403" case).
    static func signedOutChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                                control: (String) async -> Void, js: (WKWebView, String) async -> String, shot: (String) async -> Void) async {
        let campus = model.campus
        guard let auth = model.campusAuth else { return }
        func current() async -> Int {
            guard let u = URL(string: "/__fake/signed-out-status", relativeTo: campus.baseURL), let (d, _) = try? await URLSession.shared.data(from: u) else { return 401 }
            return CampusJSON.parse(d)?["code"].int ?? 401
        }
        func signIn() async {
            model.signInToCampus()
            _ = await until(10) { auth.signInView.url?.path == "/campus/login" && !auth.signInView.isLoading }
            _ = await js(auth.signInView, "document.getElementById('go').click(); 'ok'")
            _ = await until(10) { auth.signInView.url?.path == "/campus/login/ok" && !auth.signInView.isLoading }
            campus.kick()
            _ = await until(15) { campus.link == .live }
            model.closeCampusSignIn()
        }
        let launchCode = await current()
        let rowsBefore = campus.conversations.count
        let asOfBefore = campus.asOf

        // A 403 to a signed-out person is the signed-out state: the rows stay, nothing is called "not reachable", and the sidebar offers Sign in.
        await control("/__fake/signed-out-status?code=403")
        await control("/__fake/expire")
        campus.kick()
        let signedOut = await until(12) { campus.link == .expired }
        var unreachable = false
        if case .unreachable = campus.link { unreachable = true }
        report("Campus: a 403 answer to a signed-out person is the signed-out state (rows kept, 'as of' kept, no asks counted), not 'not reachable'",
               signedOut && !unreachable && campus.conversations.count == rowsBefore && campus.asOf != nil && campus.asOf! >= asOfBefore! && campus.asks.isEmpty,
               "link=\(campus.link) rows=\(campus.conversations.count) asOf=\(campus.asOf != nil ? "kept" : "gone")")
        await wait(0.5)
        await shot("campus-9b-expired-403.png")
        await signIn()
        report("Campus: signing in after a 403 brings the list back live", campus.link == .live && campus.conversations.count == rowsBefore, "link=\(campus.link)")

        // A 403 that names a missing module is a named error, not a sign-out; the not-reachable note it lands in offers Sign in too.
        await control("/__fake/module-required?on=1")
        campus.kick()
        let named = await until(12) { if case .unreachable = campus.link { return true }; return false }
        var why = ""
        if case .unreachable(let w) = campus.link { why = w }
        report("Campus: a 403 module_required is a named error (not a sign-out): the note says which module is missing", named && campus.link != .expired && why.contains("workspace module") && why.contains("module_required"), "link=\(campus.link)")
        await wait(0.5)
        await shot("campus-9c-module-required.png")
        await control("/__fake/module-required?on=0")
        campus.kick()
        let healed = await until(15) { campus.link == .live }
        report("Campus: once the module is back the list is live again", healed, "link=\(campus.link)")
        await control("/__fake/signed-out-status?code=\(launchCode)")
        report("Campus: the stand-in is left answering what the launch had when signed out", await current() == launchCode, "code=\(launchCode)")
    }

    // MARK: Watch

    static func watchChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                            js: (WKWebView, String) async -> String, shot: (String) async -> Void, host: String) async {
        let campus = model.campus, watch = model.watch
        watch.setCount(3)
        let herdr = model.snapshot.prioritized.filter { $0.sessionID != nil }
        guard herdr.count >= 6 else { report("Campus: Watch checks need agents with a conversation", false, "only \(herdr.count)"); return }
        func opened() -> [String] { watch.layout.slots.map { $0?.session ?? "-" } }
        func short(_ l: [String]) -> [String] { l.map { CampusColumn.isCampus($0) ? "C" + String($0.suffix(4)) : String($0.suffix(4)) } }
        model.watchOn = true
        _ = await until(20) { watch.layout.openCount == 3 && watch.boxes.count == 3 && watch.boxes.values.allSatisfy { $0.phase == .ready } }
        // A Campus conversation takes a column by the same rule as a reader session: here every column is taken, so the least recently used one is replaced.
        let before = opened()
        let boxesBefore = watch.boxes.count
        model.openCampus("ses_fakeRates01"); await wait(0.5)
        let after = opened()
        let at = after.firstIndex(of: CampusColumn.key("ses_fakeRates01"))
        report("Campus: in Watch a Campus conversation takes a column by the column rule (every column was taken: the least recently used one is replaced, the others untouched)",
               at != nil && zip(before, after).enumerated().allSatisfy { $0.offset == at || $0.element.0 == $0.element.1 } && watch.boxes.count == boxesBefore - 1,
               "before=\(short(before)) after=\(short(after)) views \(boxesBefore) -> \(watch.boxes.count)")
        let flashBefore = watch.flashes[watch.layout.slots[at ?? 0]!.id] ?? 0
        model.openCampus("ses_fakeRates01"); await wait(0.3)
        report("Campus: choosing it again keeps its column (nothing moves) and flashes it", opened() == after && (watch.flashes[watch.layout.slots[at ?? 0]!.id] ?? 0) == flashBefore + 1, "columns=\(short(opened()))")
        await shot("campus-10-watch.png")
        // A second Campus conversation, then a Herdr one replacing a Campus column: the column gets a web view again.
        model.openCampus("ses_fakeSprint03"); await wait(0.5)
        let two = opened().filter(CampusColumn.isCampus).count
        report("Campus: two Campus columns can sit beside Herdr's", two == 2, "columns=\(short(opened()))")
        if let u = model.web.embedURL, u.isFileURL {
            var columns: [(Int, String)] = []
            for i in watch.layout.slots.indices { if let s = watch.layout.slots[i], let cid = CampusColumn.id(of: s.session) { columns.append((i, cid)) } }
            let drawn = await until(15) {
                columns.allSatisfy { index, id in CampusEmbedBox.live.allObjects.contains { $0.column == index && $0.shownID == id && $0.phase == .ready && $0.sets > 0 } }
            }
            report("Campus: the Campus columns in Watch are drawn on the reader's embed page too, one page per column", !columns.isEmpty && drawn, "columns=\(columns.map { "\($0.0):\($0.1.suffix(4))" })")
        }
        let notShown = herdr.first { a in !watch.layout.sessions.contains { WatchLayout.same($0, a.sessionID!) } }!
        for i in watch.layout.slots.indices where watch.layout.slots[i].map({ CampusColumn.isCampus($0.session) }) == true { watch.used(columnID: watch.layout.slots[i]!.id) }
        let herdrIdx = opened().firstIndex { !CampusColumn.isCampus($0) }!
        watch.used(columnID: watch.layout.slots[herdrIdx]!.id)
        // Make a Campus column the least recently used.
        let campusIdx = opened().firstIndex(of: CampusColumn.key("ses_fakeRates01"))!
        for i in watch.layout.slots.indices where i != campusIdx { watch.used(columnID: watch.layout.slots[i]!.id) }
        model.sidebarOpenAgent(notShown)
        _ = await until(15) { watch.layout.slots[campusIdx].map { !CampusColumn.isCampus($0.session) } == true && watch.boxes.count == watch.layout.sessions.filter { !CampusColumn.isCampus($0) }.count }
        let replaced = watch.layout.slots[campusIdx]
        report("Campus: a Herdr session replacing a Campus column gives that column a web view; every other column is untouched",
               replaced.map { !CampusColumn.isCampus($0.session) && watch.boxes[$0.id] != nil } == true, "columns=\(short(opened())) views=\(watch.boxes.count)")

        // A link to a Campus conversation inside a Herdr column: taken before it leaves Conn, opened in another column; the clicked column does not navigate.
        model.openCampus("ses_fakeSprint03"); await wait(0.4)
        let clicked = watch.layout.slots.indices.first { i in watch.layout.slots[i].map { !CampusColumn.isCampus($0.session) && watch.boxes[$0.id]?.phase == .ready } == true }!
        let clickedBox = watch.boxes[watch.layout.slots[clicked]!.id]!
        let urlBefore = clickedBox.webView.url
        let target = CampusClient.webURL(base: campus.baseURL, kind: "team", folder: "growth-ops", id: "ses_fakeKpi06")!.absoluteString
        let sessionsBefore = opened()
        _ = await js(clickedBox.webView, "(function(){var a=document.createElement('a');a.id='campus-link';a.href='\(target)';a.textContent='kpi';document.body.appendChild(a);a.click();return 'ok';})()")
        let placed = await until(10) { watch.layout.sessions.contains(CampusColumn.key("ses_fakeKpi06")) }
        let kpiAt = opened().firstIndex(of: CampusColumn.key("ses_fakeKpi06"))
        report("Campus: a click on a Campus link in a Herdr column opens it in another column (never the clicked one) and the clicked page does not navigate",
               placed && kpiAt != nil && kpiAt != clicked && clickedBox.webView.url == urlBefore && opened()[clicked] == sessionsBefore[clicked], "clicked=\(clicked) placedAt=\(kpiAt.map(String.init) ?? "-") columns=\(short(opened()))")
        // Cmd-click leaves Watch for the normal view on that conversation.
        let target2 = CampusClient.webURL(base: campus.baseURL, kind: "team", folder: "growth-ops", id: "ses_fakeOutreach07")!.absoluteString
        guard let box2 = watch.layout.slots.compactMap({ $0 }).compactMap({ watch.boxes[$0.id] }).first(where: { $0.phase == .ready }) else { report("Campus: a Herdr column to Cmd-click in", false, ""); return }
        _ = await js(box2.webView, "(function(){var a=document.createElement('a');a.href='\(target2)';a.textContent='o';document.body.appendChild(a);a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,metaKey:true}));return 'ok';})()")
        let left = await until(10) { !model.watchOn && model.campusSelectedID == "ses_fakeOutreach07" }
        report("Campus: a Cmd-click on that kind of link leaves Watch and shows the conversation in the normal view", left, "watch=\(model.watchOn) selected=\(model.campusSelectedID ?? "nil")")
        model.watchOn = true
        _ = await until(10) { watch.layout.openCount == 3 }
        model.watchOn = false
        await wait(0.5)
    }

    // MARK: slice 2: the write gate

    static func writeChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                            control: (String) async -> Void, shot: (String) async -> Void) async {
        let campus = model.campus
        let base = campus.baseURL
        func log() async -> [String] {
            guard let u = URL(string: "/__fake/log", relativeTo: base), let (d, _) = try? await URLSession.shared.data(from: u) else { return [] }
            return CampusJSON.parse(d)?["writes"].array.compactMap(\.string) ?? []
        }
        var restored: [(String, String)] = []
        let sub = model.campusDraftRestore.sink { restored.append($0) }
        defer { sub.cancel() }
        model.watchOn = false
        let offsite = campus.conversation("ses_fakeOffsite04")!
        model.openCampus("ses_fakeOffsite04")

        // 1. Off by default: every write is refused before anything is sent.
        let launchedOff = !campus.writesEnabled
        let digest = campus.conversation("ses_fakeDigest02")!
        let form = campus.openForms["ses_fakeDigest02"]
        if let f = form { campus.pick(f, question: 0, option: "Last full week"); campus.pick(f, question: 1, option: "Short bullets") }
        let sent = model.campusSend("Should not go", to: offsite, delivery: nil)
        model.campusStop(campus.conversation("ses_fakeKpi06")!)
        if let f = form { model.campusAnswer(f, in: digest) }
        model.campusSetModel(CampusChoice(id: "coding-pro", label: "coding-pro"), for: offsite)
        await wait(4)
        var logNow = await log()
        report("Campus writes: the switch is off at launch, and with it off send, Stop, answer and the pickers are refused and nothing reaches Campus",
               launchedOff && !sent && campus.held == nil && restored.isEmpty && logNow.isEmpty, "off=\(launchedOff) held=\(String(describing: campus.held)) log=\(logNow.count)")
        let mineSpace = campus.spaces.first { !$0.isTeam }!
        let growthSpace = campus.spaces.first { $0.folder == "growth-ops" }!
        model.newCampusConversation(in: mineSpace)
        let startedOff = model.startCampusConversation("Should not start", in: mineSpace)
        await wait(3.5)
        report("Campus writes: with the switch off 'New conversation' opens no sheet and a start is refused before anything is sent",
               model.campusNewIn == nil && !startedOff && campus.held == nil, "sheet=\(model.campusNewIn?.id ?? "nil") held=\(String(describing: campus.held))")
        logNow = await log()
        model.requestCampusWrites()
        report("Campus writes: turning the switch on asks first and does not turn it on by itself", model.campusConfirmWrites && !campus.writesEnabled, "confirm=\(model.campusConfirmWrites)")
        model.campusConfirmWrites = false
        if let f = form { campus.clearPicks(f) }
        model.enableCampusWrites()
        await shot("campus-11-writes-on.png")

        // 2. A send waits 3 seconds with an Undo; Undo cancels it and the text comes back.
        let t0 = Date()
        let taken = model.campusSend("Add a closing dinner", to: offsite, delivery: nil)
        await wait(1.0)
        let secondsShown = campus.held?.secondsLeft
        await shot("campus-12-undo-window.png")
        campus.undo()
        let phaseAfterUndo = campus.held?.phase
        await wait(4)
        logNow = await log()
        report("Campus writes: a send waits in a 3-second window with an Undo; Undo sends nothing and returns the text to the box",
               taken && secondsShown != nil && secondsShown! <= 3 && secondsShown! >= 1 && phaseAfterUndo == .undone && restored.last?.1 == "Add a closing dinner" && logNow.isEmpty,
               "taken=\(taken) secondsLeft=\(secondsShown.map(String.init) ?? "-") restored=\(restored.map { $0.1 }) after=\(String(format: "%.1f", Date().timeIntervalSince(t0))) s")

        // 3. A failure returns the draft and says why.
        await control("/__fake/fail-writes?on=1")
        _ = model.campusSend("Keep this text", to: offsite, delivery: nil)
        let failed = await until(10) { if case .failed? = campus.held?.phase { return true }; return false }
        await control("/__fake/fail-writes?on=0")
        logNow = await log()
        report("Campus writes: when a send fails the text comes back and the reason is shown", failed && restored.last?.1 == "Keep this text" && logNow.isEmpty, "phase=\(String(describing: campus.held?.phase)) restored=\(restored.last?.1 ?? "nil")")
        await wait(0.3)

        // 4. The send that goes through: delivered after the window, echoed in the transcript, the run starts.
        _ = await until(10) { campus.held == nil }
        _ = model.campusSend("Add a closing dinner", to: offsite, delivery: nil)
        let delivered = await until(8) { campus.held?.phase == .sent }
        let w1 = await log()
        let echoed = await until(8) { campus.timeline("ses_fakeOffsite04")?.items.contains { $0.kind == .user && $0.text == "Add a closing dinner" } == true }
        let started = await until(10) { campus.conversation("ses_fakeOffsite04")?.working == true }
        report("Campus writes: after the window the send is delivered once (as a plain prompt), shown in the transcript, and the run starts",
               delivered && w1.count == 1 && w1[0].contains("/ses_fakeOffsite04/prompt") && w1[0].contains("Add a closing dinner") && !w1[0].contains("delivery") && echoed && started, "log=\(w1) echoed=\(echoed) working=\(started)")

        // 5. While the run works: Steer and Queue say how they are sent; Stop interrupts.
        _ = await until(10) { campus.held == nil }
        _ = model.campusSend("Make it vegetarian", to: campus.conversation("ses_fakeOffsite04")!, delivery: "steer")
        _ = await until(8) { campus.held?.phase == .sent }
        _ = await until(10) { campus.held == nil }
        _ = model.campusSend("And add a lunch", to: campus.conversation("ses_fakeOffsite04")!, delivery: "queue")
        _ = await until(8) { campus.held?.phase == .sent }
        let w2 = await log()
        report("Campus writes: while a run works, Steer and Queue are sent with their own delivery", w2.count == 3 && w2[1].contains("\"delivery\":\"steer\"") && w2[2].contains("\"delivery\":\"queue\""), "log=\(w2.suffix(2))")
        _ = await until(25) { campus.conversation("ses_fakeOffsite04")?.working == false }
        // A second run to stop.
        await control("/__fake/run?c=ses_fakeOffsite04&text=Another%20pass&ask=0")
        _ = await until(10) { campus.conversation("ses_fakeOffsite04")?.working == true }
        _ = await until(10) { campus.held == nil }
        model.campusStop(campus.conversation("ses_fakeOffsite04")!)
        _ = await until(8) { campus.held?.phase == .sent }
        let stopped = await until(10) { campus.conversation("ses_fakeOffsite04")?.working == false && campus.timeline("ses_fakeOffsite04")?.items.contains { $0.kind == .stopped } == true }
        let w3 = await log()
        report("Campus writes: Stop sends the interrupt after the window and the run shows as stopped", stopped && w3.last?.contains("/ses_fakeOffsite04/interrupt") == true, "last=\(w3.last ?? "nil")")
        await shot("campus-13-stopped.png")

        // 6. Answering a question with several parts: pick each, then send; the row stops asking.
        _ = await until(10) { campus.held == nil }
        let f = campus.openForms["ses_fakeDigest02"]!
        model.campusPick(f, in: digest, question: 0, option: "Last full week")
        let partial = campus.pickedAnswers(f) == nil
        model.campusPick(f, in: digest, question: 1, option: "Short bullets")
        model.campusAnswer(f, in: digest)
        _ = await until(8) { campus.held?.phase == .sent }
        let answered = await until(15) { campus.conversation("ses_fakeDigest02")?.needsYou == false }
        let w4 = await log()
        report("Campus writes: an answer to a question with two parts needs both picks, goes through the same window, and the row stops asking",
               partial && answered && w4.last?.contains("/ses_fakeDigest02/form/frm_demo_digest/reply") == true && w4.last?.contains("\"answer\":[\"Last full week\",\"Short bullets\"]") == true && campus.openForms["ses_fakeDigest02"] == nil,
               "partial=\(partial) last=\(w4.last ?? "nil")")

        // 7. Model and agent pickers.
        _ = await until(10) { campus.held == nil }
        model.openCampus("ses_fakeSprint03")
        _ = await until(10) { campus.models["private/default"] != nil }
        let sprint = campus.conversation("ses_fakeSprint03")!
        model.campusSetModel(campus.models["private/default"]!.first { $0.id == "coding-pro" }!, for: sprint)
        _ = await until(8) { campus.held?.phase == .sent }
        _ = await until(10) { campus.held == nil }
        model.campusSetAgent(campus.agents["private/default"]!.first { $0.id == "plan" }!, for: campus.conversation("ses_fakeSprint03")!)
        _ = await until(8) { campus.held?.phase == .sent }
        let w5 = await log()
        report("Campus writes: the model and agent pickers send their change after the window and show it", w5.suffix(2).first?.contains("\"id\":\"coding-pro\"") == true && w5.last?.contains("\"agent\":\"plan\"") == true && campus.conversation("ses_fakeSprint03")?.model == "coding-pro" && campus.conversation("ses_fakeSprint03")?.agent == "plan",
               "model=\(campus.conversation("ses_fakeSprint03")?.model ?? "-") agent=\(campus.conversation("ses_fakeSprint03")?.agent ?? "-")")
        await shot("campus-14-composer.png")

        // 8. Start a conversation: the sheet, the same window, the new conversation opens; a team space starts in its own path; closing the sheet takes a waiting start back.
        _ = await until(10) { campus.held == nil }
        let logBefore = await log().count
        model.newCampusConversation(in: mineSpace)
        let sheetOpen = model.campusNewIn?.id == "private/default"
        await shot("campus-15-new-conversation.png")
        let startTaken = model.startCampusConversation("Plan the Q2 offsite agenda", in: mineSpace)
        await wait(1.0)
        let waiting = campus.held?.phase == .held && campus.held?.conversationID == CampusStore.startKey(mineSpace) && model.campusNewIn != nil
        await shot("campus-16-new-conversation-undo.png")
        let sentNew = await until(10) { campus.held?.phase == .sent }
        let opened = await until(10) { model.campusNewIn == nil && model.campusSelectedID?.hasPrefix("ses_fakeNew") == true }
        let w6 = await log()
        let newID = model.campusSelectedID ?? ""
        let rowThere = campus.conversation(newID)?.title == "Plan the Q2 offsite agenda"
        report("Campus writes: 'New conversation' starts after the window with one POST to the space's conversations path, closes the sheet and opens the new conversation in the centre",
               sheetOpen && startTaken && waiting && sentNew && opened && rowThere && w6.count == logBefore + 1 && w6.last?.hasPrefix("POST /api/spaces/private/default/conversations {") == true && w6.last?.contains("Idempotency-Key: ") == true,
               "sheet=\(sheetOpen) waiting=\(waiting) sent=\(sentNew) opened=\(opened) selected=\(newID) log=\(w6.last ?? "nil")")
        let working = await until(10) { campus.conversation(newID)?.working == true }
        let echoedNew = await until(8) { campus.timeline(newID)?.items.contains { $0.kind == .user && $0.text == "Plan the Q2 offsite agenda" } == true }
        report("Campus writes: the conversation that was started shows its first message and its run", working && echoedNew, "working=\(working) echoed=\(echoedNew)")
        await shot("campus-17-new-conversation-opened.png")
        _ = await until(25) { campus.conversation(newID)?.working == false }
        _ = await until(10) { campus.held == nil }
        model.newCampusConversation(in: growthSpace)
        _ = model.startCampusConversation("Pull the Q2 partner list", in: growthSpace)
        let sentTeam = await until(10) { campus.held?.phase == .sent }
        _ = await until(10) { model.campusNewIn == nil }
        let w7 = await log()
        report("Campus writes: a team space starts in its own path and the conversation lands in that space",
               sentTeam && w7.last?.hasPrefix("POST /api/spaces/team/growth-ops/conversations {") == true && campus.conversation(model.campusSelectedID ?? "")?.spaceID == "team/growth-ops", "log=\(w7.last ?? "nil") selected=\(model.campusSelectedID ?? "nil")")
        _ = await until(25) { campus.conversation(model.campusSelectedID ?? "")?.working == false }
        _ = await until(10) { campus.held == nil }
        let logBeforeCancel = await log().count
        model.newCampusConversation(in: mineSpace)
        _ = model.startCampusConversation("Changed my mind", in: mineSpace)
        await wait(0.5)
        model.closeCampusNew()
        let phaseAfterClose = campus.held?.phase
        await wait(4)
        let w8 = await log()
        report("Campus writes: closing the 'New conversation' sheet inside the window takes the start back and nothing is sent",
               phaseAfterClose == .undone && model.campusNewIn == nil && w8.count == logBeforeCancel, "phase=\(String(describing: phaseAfterClose)) log=\(w8.count)/\(logBeforeCancel)")
        _ = await until(10) { campus.held == nil }
        model.disableCampusWrites()
        report("Campus writes: the switch can be turned off again at once", !campus.writesEnabled, "")
    }
}
