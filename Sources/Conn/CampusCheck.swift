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

        // 0. A launch behind a blocked network (`--campus-blocked-network`): the blocked note, then the stand-in is let through and the rest runs as a normal launch.
        if await standInBlocked(base) { await blockedLaunchChecks(model: model, report: report, wait: wait, until: until, control: control, shot: shot) }

        // 1. Signed out: the section says so and lists nothing; the status bar says so.
        _ = await until(15) { campus.link == .expired }
        report("Campus: before the first sign-in the link is signed out with no rows and no 'as of' time",
               campus.link == .expired && campus.conversations.isEmpty && campus.asOf == nil && campus.asks.isEmpty && model.campusAuth?.kind == "cookie",
               "link=\(campus.link) rows=\(campus.conversations.count) asOf=\(campus.asOf.map { "\($0)" } ?? "nil") auth=\(model.campusAuth?.kind ?? "-")")
        report("Campus: while signed out no remembered Campus column is judged gone (a signed-out Campus never empties a Watch setup)",
               !model.watch.isGone(CampusColumn.key("ses_noLongerThere99")) && !model.watch.isGone(CampusColumn.key("ses_fakeRates01")), "link=\(campus.link)")
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
               documentCookie.isEmpty && !described.contains("eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0") && !(HTTPCookieStorage.shared.cookies ?? []).contains { $0.name == "campus_session" && $0.domain.contains("127.0.0.1") },
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

        await blockedChecks(model: model, report: report, wait: wait, until: until, control: control, js: js, shot: shot)

        await staleConnectionChecks(model: model, report: report, wait: wait, until: until, control: control, js: js, shot: shot)

        await storeSwapChecks(report: report, host: base.host ?? "127.0.0.1")
        // CONN_CAMPUS_CHECK_STOP=stale ends the Campus checks here (about a minute instead of the full run), for working on these steps.
        if ProcessInfo.processInfo.environment["CONN_CAMPUS_CHECK_STOP"] == "stale" { print("ui-check: stopped after the stale-connection steps (CONN_CAMPUS_CHECK_STOP=stale)"); return }

        await writeChecks(model: model, report: report, wait: wait, until: until, control: control, shot: shot)

        await embedComposerChecks(model: model, report: report, wait: wait, until: until, control: control, shot: shot)

        await starChecks(model: model, report: report, wait: wait, until: until, shot: shot)

        await bridgeChecks(model: model, report: report, wait: wait, until: until, control: control, js: js, shot: shot)

        await renewalChecks(model: model, report: report, wait: wait, until: until, control: control, js: js, shot: shot)

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

    // MARK: the page's own message bar (select-to-ask, comments, Send, Undo, Now)

    /// Conn's half of the reader's composer contract, against the real page copy that `CONN_EMBED_URL` names. That copy may not have the message bar yet (the contract was written
    /// first), so when it has no `readerEmbed.composer` the check puts a stand-in for the three calls and the `send` post on the page, which is the page's whole side of the
    /// contract that reaches Conn: what Conn asks of the page (`composer`, `sent`) and what the page posts (`send`).
    static func embedComposerChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                                    control: (String) async -> Void, shot: (String) async -> Void) async {
        guard let url = model.web.embedURL, url.isFileURL else {
            print("ui-check: SKIP Campus embed composer (no CONN_EMBED_URL file)")
            return
        }
        let campus = model.campus
        let id = "ses_fakeOffsite04"
        model.watchOn = false
        model.enableCampusWrites()
        model.openCampus(id)
        func box() -> CampusEmbedBox? { CampusEmbedBox.live.allObjects.first { $0.column == nil && $0.shownID == id && $0.phase == .ready && $0.sets > 0 } }
        guard await until(20, { box() != nil }), let page = box() else { report("Campus embed composer: the page is there", false, "no ready page"); return }
        func log() async -> [String] {
            guard let u = URL(string: "/__fake/log", relativeTo: campus.baseURL), let (d, _) = try? await URLSession.shared.data(from: u) else { return [] }
            return CampusJSON.parse(d)?["writes"].array.compactMap(\.string) ?? []
        }
        func js(_ expr: String) async -> String { await page.read("JSON.stringify((function(){ \(expr) })())") }
        func results() async -> [[String: Any]] {
            guard let d = await js("return window.__sent || [];").data(using: .utf8), let a = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return [] }
            return a
        }
        func post(_ sendID: String, _ text: String, conversation: String? = nil) async {
            let c = conversation ?? id
            _ = await js("window.__send(\(jsString(sendID)), \(jsString(text)), \(jsString(c))); return 1;")
        }
        let installed = await js("""
            var r = window.readerEmbed; if (typeof r.composer === 'function') return 'real';
            window.readerEmbed = Object.assign({}, r, {
              composer: function (c) { window.__cfg = (typeof c === 'string') ? JSON.parse(c) : c; return { ok: true }; },
              sent: function (x) { (window.__sent = window.__sent || []).push(x); } });
            window.__send = function (i, t, c) { window.webkit.messageHandlers.readerEmbed.postMessage({ type: 'send', id: i, conversation: c, text: t, comments: 0 }); };
            return 'shim';
            """)
        page.refreshComposer()
        let on = await until(8) { page.composerOn }
        let cfgOn = await js("return window.__cfg || null;")
        let title = campus.conversation(id)?.title ?? ""
        report("Campus embed composer: the page is asked for its message bar with the conversation's name and Send on, and Conn's own box steps aside",
               installed != "\"real\"" ? on && cfgOn.contains("\"send\":true") && cfgOn.contains(jsStringContent(title)) : on, "page=\(installed) on=\(on) cfg=\(cfgOn)")
        guard installed != "\"real\"" else { return }                       // a page that has the bar of its own is checked by the reader's own e2e; the rest drives the stand-in
        await shot("campus-20-page-composer.png")

        // Script in the page cannot send by itself: Conn must have seen a key or a click in this web view just before (this launch has had none), and only a main-frame post counts.
        let wGesture = await log().count
        await post("pg-0", "Posted by script, no key or click")
        let gestureRefused = await untilResults(results, count: 1, wait: wait)
        let r0 = await results().first ?? [:]
        let logAfterGesture = await log().count
        report("Campus embed composer: a send posted by script, with no key or click in the web view, is refused with a reason and nothing is sent",
               gestureRefused && r0["id"] as? String == "pg-0" && r0["ok"] as? Bool == false && (r0["error"] as? String)?.contains("no key or click") == true && logAfterGesture == wGesture, "result=\(r0)")
        let savedGesture = CampusEmbedBox.requireGesture
        CampusEmbedBox.requireGesture = false                                 // the steps below post by script, as a person's click cannot be scripted headlessly
        defer { CampusEmbedBox.requireGesture = savedGesture }

        // A message the page sends goes through the same gate and is typed into Campus at once (the page already held it through its own Undo window), then the page is told.
        let w0 = await log().count
        let t0 = Date()
        await post("pg-1", "From the page: what changed since Monday?")
        let answered = await untilResults(results, count: 2, wait: wait)
        let took = Date().timeIntervalSince(t0)
        let r1 = Array((await results()).dropFirst())
        let w1 = await log()
        let echoed = await until(8) { campus.timeline(id)?.items.contains { $0.kind == .user && $0.text == "From the page: what changed since Monday?" } == true }
        report("Campus embed composer: a message the page sends is typed into the conversation at once (no second wait), exactly as sent, and the page is told it went",
               answered && took < 2.5 && r1.first?["id"] as? String == "pg-1" && r1.first?["ok"] as? Bool == true && w1.count == w0 + 1 && w1.last?.contains("/\(id)/prompt") == true && w1.last?.contains("From the page: what changed since Monday?") == true && echoed,
               "answered=\(answered) in \(String(format: "%.1f", took)) s result=\(r1.first ?? [:]) log=+\(w1.count - w0) echoed=\(echoed)")
        _ = await until(30) { campus.conversation(id)?.working == false }
        _ = await until(10) { campus.held == nil }

        // Two sends in a row keep their order (the second waits behind the first).
        let w2 = await log().count
        await post("pg-2", "Second from the page")
        await post("pg-3", "Third from the page")
        let both = await untilResults(results, count: 4, wait: wait)
        let w3 = await log()
        report("Campus embed composer: two sends in a row go out in order and the page is told about each", both && w3.count == w2 + 2 && w3[w2].contains("Second from the page") && w3[w2 + 1].contains("Third from the page"),
               "both=\(both) log=\(w3.suffix(2).map { String($0.suffix(40)) })")
        _ = await until(30) { campus.conversation(id)?.working == false }
        _ = await until(10) { campus.held == nil }

        // A failure tells the page why; nothing is sent; no text goes into Conn's own box.
        let draftsBefore = model.campusUnclaimedDrafts[id]?.count ?? 0
        await control("/__fake/fail-writes?on=1")
        let w4 = await log().count
        await post("pg-4", "This one fails")
        let failedAnswer = await untilResults(results, count: 5, wait: wait)
        await control("/__fake/fail-writes?on=0")
        let r4 = await results().last ?? [:]
        let logAfterFail = await log().count
        report("Campus embed composer: when Campus refuses a send the page is told why (so it can give the text back) and Conn's own box takes nothing",
               failedAnswer && r4["id"] as? String == "pg-4" && r4["ok"] as? Bool == false && (r4["error"] as? String)?.isEmpty == false && logAfterFail == w4 && (model.campusUnclaimedDrafts[id]?.count ?? 0) == draftsBefore,
               "result=\(r4)")
        _ = await until(10) { campus.held == nil }

        // A message that names another conversation than the one on screen is refused (page content is untrusted): nothing is sent to either.
        await post("pg-5", "Lost message", conversation: "ses_fakeSprint03")
        let lost = await untilResults(results, count: 6, wait: wait)
        let r5 = await results().last ?? [:]
        let logAfterLost = await log().count
        report("Campus embed composer: a message that names another conversation than the one on screen is refused with a reason and nothing is sent", lost && r5["ok"] as? Bool == false && (r5["error"] as? String)?.contains("not the conversation on screen") == true && logAfterLost == w4, "result=\(r5)")

        // Writes off: the page is told Send is off (and why), and a send it posts anyway is refused.
        model.disableCampusWrites()
        let off = await untilAsync(8, wait: wait) { await js("return window.__cfg && window.__cfg.send === false && window.__cfg.reason.length > 0;") == "true" }
        await post("pg-6", "Should not go")
        let refusedOff = await untilResults(results, count: 7, wait: wait)
        let r6 = await results().last ?? [:]
        let logAfterOff = await log().count
        report("Campus embed composer: with Campus writes off the page's Send is turned off with the reason, and a send posted anyway is refused",
               off && refusedOff && r6["ok"] as? Bool == false && (r6["error"] as? String)?.contains("writes are off") == true && logAfterOff == w4, "off=\(off) result=\(r6)")
        model.enableCampusWrites()
        _ = await untilAsync(8, wait: wait) { await js("return window.__cfg && window.__cfg.send === true;") == "true" }

        // Privacy mode takes the bar away with the page's content.
        model.privacy = true
        let gone = await untilAsync(8, wait: wait) { await js("return window.__cfg === null;") == "true" }
        model.privacy = false
        let back = await untilAsync(8, wait: wait) { await js("return window.__cfg && window.__cfg.send === true;") == "true" }
        report("Campus embed composer: privacy mode takes the page's message bar away and it comes back with the conversation", gone && back, "gone=\(gone) back=\(back)")
        model.disableCampusWrites()
    }

    private static func untilResults(_ results: () async -> [[String: Any]], count: Int, wait: (Double) async -> Void) async -> Bool {
        var t = 0.0
        while t < 10 { if await results().count >= count { return true }; await wait(0.2); t += 0.2 }
        return await results().count >= count
    }

    private static func untilAsync(_ timeout: Double, wait: (Double) async -> Void, _ done: () async -> Bool) async -> Bool {
        var t = 0.0
        while t < timeout { if await done() { return true }; await wait(0.2); t += 0.2 }
        return await done()
    }

    private static func jsStringContent(_ s: String) -> String {
        let t = jsString(s)
        return String(t.dropFirst().dropLast())
    }

    private static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let text = String(decoding: data, as: UTF8.self)
        return String(text.dropFirst().dropLast())
    }

    // MARK: a 403 is the network, not a sign-out

    /// What the stand-in answers now: nginx's 403 page on every path (the way the real Campus is off the company private network), or itself.
    static func standInBlocked(_ base: URL) async -> Bool {
        guard let u = URL(string: "/__fake/blocked-network", relativeTo: base), let (d, _) = try? await URLSession.shared.data(from: u) else { return false }
        return CampusJSON.parse(d)?["on"].bool ?? false
    }

    /// A launch with `--campus-blocked-network`: nobody has signed in, and the network refuses. The sidebar must say it is the network (Try again), never "Sign in".
    /// Then the stand-in is let through and the launch carries on as a normal one.
    static func blockedLaunchChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                                    control: (String) async -> Void, shot: (String) async -> Void) async {
        let campus = model.campus
        let blocked = await until(20) { campus.link == .blocked }
        var asked = false
        if case .expired = campus.link { asked = true }
        report("Campus: a launch behind a blocked network (nginx's 403 page on every path) is 'blocked', not signed out: no Sign in note, no rows, no 'as of' time, no asks",
               blocked && !asked && campus.conversations.isEmpty && campus.asOf == nil && campus.asks.isEmpty && campus.lastBlockedAt != nil,
               "link=\(campus.link) rows=\(campus.conversations.count)")
        report("Campus: the blocked note says it is the network and not the sign-in, names Zscaler, and offers Try again",
               CampusNetworkBlock.title == "Campus refused the connection" && CampusNetworkBlock.note.contains("not your sign-in") && CampusNetworkBlock.note.contains("Zscaler") && CampusNetworkBlock.note.contains("try again"), CampusNetworkBlock.note)
        await wait(0.6)
        await shot("campus-0-blocked-launch.png")
        await control("/__fake/blocked-network?on=0")
        model.retryCampus()
        let back = await until(15) { campus.link == .expired }
        report("Campus: Try again, with the network answering again, finds the plain signed-out state (the sign-in is what is left to do)", back, "link=\(campus.link)")
    }

    /// The network refusing a signed-in Campus, and a sign-in sheet meeting the refusal: the rows stay, nothing is called a sign-out or "not reachable", the sidebar says
    /// network and offers Try again, the sheet says the same instead of nginx's raw page and logs each hop, and Try again recovers once the stand-in answers again.
    static func blockedChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                              control: (String) async -> Void, js: (WKWebView, String) async -> String, shot: (String) async -> Void) async {
        let campus = model.campus
        guard let auth = model.campusAuth else { return }
        let host = campus.baseURL.host ?? ""
        let rowsBefore = campus.conversations.count
        let asOfBefore = campus.asOf
        if campus.link != .live { report("Campus: the blocked-network checks need a live Campus", false, "link=\(campus.link)"); return }

        // 1. The network refuses: not a sign-out, not 'not reachable'; the rows stay, nothing is counted as an ask, the refusal is logged and remembered.
        await control("/__fake/blocked-network?on=1")
        campus.kick()
        let blocked = await until(15) { campus.link == .blocked }
        var wrong = false
        switch campus.link { case .expired, .unreachable: wrong = true; default: break }
        let loggedBlock = model.campusHops?.lastBlocked(campusHost: host)
        report("Campus: nginx's 403 page is the blocked state (rows kept, 'as of' kept, no asks counted, the time remembered and logged), not a sign-out and not 'not reachable'",
               blocked && !wrong && campus.conversations.count == rowsBefore && campus.asOf != nil && asOfBefore != nil && campus.asOf! >= asOfBefore! && campus.asks.isEmpty && campus.lastBlockedAt != nil && loggedBlock != nil,
               "link=\(campus.link) rows=\(campus.conversations.count) lastBlocked=\(campus.lastBlockedAt != nil) logged=\(loggedBlock != nil)")
        await wait(0.6)
        await shot("campus-9b-blocked.png")
        let settingsText = CampusConnectionSettingsSection.blockedText(link: campus.link, thisRun: campus.lastBlockedAt, logged: loggedBlock)
        report("Campus: Settings says the network is blocking Campus now, since when", settingsText.hasPrefix("now (since "), settingsText)

        // 2. The sign-in sheet meets the refusal: not the raw page, the same message with Try again; each hop is logged without a query, cookie or token.
        let hopsBefore = model.campusHops?.recent(1000).count ?? 0
        model.signInToCampus()
        let shown = await until(5) { model.campusSignInShown }
        let refused = await until(15) { auth.signInRefused }
        let page = await js(auth.signInView, "document.body ? document.body.innerText : ''")
        let hops = Array((model.campusHops?.recent(1000) ?? []).dropFirst(hopsBefore)).filter { $0.source == "sign-in" }
        let hopFile = (try? String(contentsOf: model.campusHops!.file, encoding: .utf8)) ?? ""
        report("Campus: a sign-in sheet that meets nginx's 403 page shows the network message with Try again, never the raw page",
               shown && refused && !page.contains("403 Forbidden") && !page.contains("nginx"), "shown=\(shown) refused=\(refused) page='\(page.prefix(40))'")
        report("Campus: each sign-in hop is logged as time, host, path and status (here the 403 on /campus/login), with no query, cookie or token",
               hops.contains { $0.host == host && $0.path == "/campus/login" && $0.status == 403 } && !hopFile.contains("?") && !hopFile.contains("campus_session") && !hopFile.contains("eyJ"),
               "hops=\(hops.map { "\($0.path) \($0.status)" })")
        await wait(0.6)
        await shot("campus-9c-blocked-sheet.png")
        // The sheet is its own window, which the window picture does not include: draw its message card (the very view the sheet shows) in light and dark.
        if let dir = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"].map({ URL(fileURLWithPath: $0) }) {
            for scheme in [ColorScheme.light, .dark] {
                let r = ImageRenderer(content: CampusBlockedSheetCard(onTryAgain: {}).frame(width: 560, height: 360).environment(\.colorScheme, scheme))
                r.scale = 2
                if let img = r.nsImage, let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                    try? png.write(to: dir.appendingPathComponent("campus-9c-blocked-sheet-card-\(scheme == .dark ? "dark" : "light").png"))
                }
            }
        }

        // 3. Try again in the sheet, with the network answering again, loads the login page.
        await control("/__fake/blocked-network?on=0")
        auth.retrySignIn()
        let login = await until(15) { auth.signInView.url?.path == "/campus/login" && !auth.signInView.isLoading && !auth.signInRefused }
        report("Campus: Try again in the sheet, once the network answers, loads Campus's sign-in page and takes the message away", login, "url=\(auth.signInView.url?.path ?? "nil") refused=\(auth.signInRefused)")
        model.closeCampusSignIn()

        // 4. Try again in the sidebar recovers by itself: the same rows, live.
        let back = await until(20) { campus.link == .live && campus.conversations.count == rowsBefore }
        if !back { model.retryCampus() }
        var live = back
        if !live { live = await until(15) { campus.link == .live && campus.conversations.count == rowsBefore } }
        report("Campus: once the network answers again the list is live again with the same rows", live, "link=\(campus.link) rows=\(campus.conversations.count)")
        report("Campus: Settings then says when the network last blocked Campus", CampusConnectionSettingsSection.blockedText(link: campus.link, thisRun: campus.lastBlockedAt, logged: model.campusHops?.lastBlocked(campusHost: host)) != "never", "")

        // 5. A 403 that names a missing module is a named error (not the network, not a sign-out); the not-reachable note it lands in offers Sign in too.
        await control("/__fake/module-required?on=1")
        campus.kick()
        let named = await until(12) { if case .unreachable = campus.link { return true }; return false }
        var why = ""
        if case .unreachable(let w) = campus.link { why = w }
        report("Campus: a 403 module_required is a named error (not the network, not a sign-out): the note says which module is missing", named && campus.link != .expired && campus.link != .blocked && why.contains("workspace module") && why.contains("module_required"), "link=\(campus.link)")
        await wait(0.5)
        await shot("campus-9d-module-required.png")
        await control("/__fake/module-required?on=0")
        campus.kick()
        let healed = await until(15) { campus.link == .live }
        report("Campus: once the module is back the list is live again", healed, "link=\(campus.link)")

        // 6. A real sign-out (401) is still a sign-out.
        await control("/__fake/expire")
        campus.kick()
        let signedOut = await until(12) { campus.link == .expired }
        report("Campus: a 401 is still the signed-out state (rows kept), and signing in brings the list back live", signedOut && campus.conversations.count == rowsBefore && campus.asks.isEmpty, "link=\(campus.link)")
        model.signInToCampus()
        _ = await until(10) { auth.signInView.url?.path == "/campus/login" && !auth.signInView.isLoading }
        _ = await js(auth.signInView, "document.getElementById('go').click(); 'ok'")
        _ = await until(10) { auth.signInView.url?.path == "/campus/login/ok" && !auth.signInView.isLoading }
        campus.kick()
        let signedIn = await until(15) { campus.link == .live }
        model.closeCampusSignIn()
        report("Campus: signing in after a 401 brings the list back live", signedIn && campus.conversations.count == rowsBefore, "link=\(campus.link)")
    }

    // MARK: a connection that outlives the refusal

    /// The sign-in sheet is closed and its window is gone (a sheet's window outlives its closing by a moment), so the next step meets a quiet window list.
    private static func settleSheet(_ model: AppModel, wait: (Double) async -> Void) async {
        var last = NSApp.windows.count, quiet = 0.0, total = 0.0
        while quiet < 1.5 && total < 10 {
            await wait(0.25); total += 0.25
            let now = NSApp.windows.count
            if now == last && !model.campusSignInShown { quiet += 0.25 } else { quiet = 0; last = now }
        }
    }

    /// Nathan's Zscaler case (2026-11-09 17:13 to 17:33 UTC): the network refused Campus, he turned Zscaler private access on, and "Try again" kept meeting the 403 until Conn
    /// was quit and reopened. The stand-in models it: with keep-alive on, a connection that is open while the block (sticky) is on, or opens under it, keeps answering the
    /// refusal after the network answers again; only a new connection gets through. WebKit pools one connection per website data store and reuses it for every page and
    /// fetch, so a plain look, a reload and a new web view all meet it. Try again must drop it (a new store that carries the session), the sheet's Try again as well, and
    /// while the network keeps refusing Conn drops it by itself.
    static func staleConnectionChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                                      control: (String) async -> Void, js: (WKWebView, String) async -> String, shot: (String) async -> Void) async {
        let campus = model.campus
        guard let auth = model.campusAuth else { return }
        if campus.link != .live { report("Campus: the stale-connection checks need a live Campus", false, "link=\(campus.link)"); return }
        let rows = campus.conversations.count
        let savedInterval = campus.blockedResetInterval
        defer { campus.blockedResetInterval = savedInterval }

        // 1. A connection that the refusal stuck to still answers it after the network answers again: a plain look, even a reload and a new look, meets it.
        campus.blockedResetInterval = 3600                                    // by itself, not in this step
        await control("/__fake/keep-alive?on=1")
        campus.kick()
        await wait(1.5)                                                       // Conn's calls now ride pooled connections
        await control("/__fake/blocked-network?on=1&sticky=1")
        campus.kick()
        let blocked = await until(15) { campus.link == .blocked }
        await control("/__fake/blocked-network?on=0")
        let recyclesBefore = auth.recycles
        campus.kick()
        await wait(4)
        let stillBlocked = campus.link == .blocked
        report("Campus: the network answers again, yet a plain look on the connection the refusal stuck to still meets the 403 (the stale connection Nathan's Conn kept until it was quit)",
               blocked && stillBlocked && auth.recycles == recyclesBefore, "blocked=\(blocked) still=\(stillBlocked) link=\(campus.link)")

        // 2. Try again drops it: a new store, the session carried over (not signed out), the rows back, no relaunch.
        let storeBefore = auth.store
        model.retryCampus()
        let live = await until(20) { campus.link == .live && campus.conversations.count == rows }
        report("Campus: Try again drops the stale connection and the list is live again with the same rows, still signed in, with no relaunch",
               live && auth.recycles == recyclesBefore + 1 && auth.store !== storeBefore && campus.link != .expired, "link=\(campus.link) recycles=\(auth.recycles - recyclesBefore) rows=\(campus.conversations.count)")
        await shot("campus-9e-stale-recovered.png")

        // 3. The sign-in sheet over the same stale connection: its plain reload meets the refusal, its Try again recovers.
        campus.blockedResetInterval = 3600
        await control("/__fake/blocked-network?on=1&sticky=1")
        campus.kick()
        _ = await until(15) { campus.link == .blocked }
        model.signInToCampus()
        let refused = await until(15) { auth.signInRefused }
        await control("/__fake/blocked-network?on=0")
        auth.signInView.load(URLRequest(url: campus.baseURL.appendingPathComponent("campus/login")))
        await wait(3)
        let stuck = auth.signInRefused
        report("Campus: the sheet's own reload, with the network answering again, still meets the refusal on the stale connection", refused && stuck, "refused=\(refused) stuck=\(stuck)")
        let sheetView = auth.signInView
        auth.retrySignIn()
        let loaded = await until(20) { auth.signInView !== sheetView && auth.signInView.url?.path == "/campus/login" && !auth.signInView.isLoading && !auth.signInRefused }
        report("Campus: the sheet's Try again drops the connection and loads Campus's sign-in page (the sheet follows the new web view)", loaded, "refused=\(auth.signInRefused) url=\(auth.signInView.url?.path ?? "nil")")
        model.closeCampusSignIn()
        let back = await until(20) { campus.link == .live && campus.conversations.count == rows }
        report("Campus: after that Try again the list is live again too (one store serves the sheet and the list)", back, "link=\(campus.link)")

        // 4. No drop by itself under a person who is signing in by hand.
        await settleSheet(model, wait: wait)
        campus.blockedResetInterval = 0.5
        let recyclesBeforeBlock = auth.recycles
        await control("/__fake/blocked-network?on=1&sticky=1")
        campus.kick()
        _ = await until(15) { campus.link == .blocked }
        model.signInToCampus()
        _ = await until(5) { model.campusSignInShown }
        let atOpen = auth.recycles, viewAtOpen = auth.signInView
        await wait(3)
        report("Campus: while the sign-in sheet is open Conn does not swap the store by itself, even while the network keeps refusing", auth.recycles == atOpen && auth.signInView === viewAtOpen, "recycles=\(auth.recycles - atOpen)")
        model.closeCampusSignIn()

        // 5. Without a click: while the network keeps refusing Conn drops the connection by itself, and meets the network when it is back.
        await control("/__fake/blocked-network?on=0")
        let healed = await until(25) { campus.link == .live && campus.conversations.count == rows }
        report("Campus: with no click at all, a refusal that outlasts the network's return heals by itself (Conn drops the connection while the network keeps refusing)",
               healed && auth.recycles > recyclesBeforeBlock, "link=\(campus.link) recycles=\(auth.recycles - recyclesBeforeBlock)")
        await control("/__fake/keep-alive?on=0")
        await settleSheet(model, wait: wait)

        // 6. The session survived every swap: the cookie is in the new store, so the person was never signed out.
        report("Campus: the sign-in cookie moved with every store (the list never turned signed out)", await auth.store.httpCookieStore.allCookies().contains { $0.name == "campus_session" && $0.isHTTPOnly } && campus.link == .live, "link=\(campus.link)")
    }

    /// A person's launch keeps Campus in WebKit's own storage; a scripted launch never does. The person's path (the default store, then a store with an identifier) is run here
    /// on stores of the check's own: a stand-in for the default store (an identified store seeded with Campus's cookie, Google's and an unrelated site's), then two swaps.
    /// Every store the check makes is removed again. The person's real stores are never opened.
    static func storeSwapChecks(report: (String, Bool, String) -> Void, host: String) async {
        let suite = "dev.local.conn.test.stores.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else { report("Campus stores: a settings suite of the check's own", false, ""); return }
        defer { defaults.removePersistentDomain(forName: suite) }
        let legacyID = UUID()
        var newID: UUID?
        do {
            let legacy = WKWebsiteDataStore(forIdentifier: legacyID)
            func cookie(_ name: String, _ domain: String, httpOnly: Bool = false) -> HTTPCookie? {
                var props: [HTTPCookiePropertyKey: Any] = [.name: name, .value: "check-\(name)", .domain: domain, .path: "/", .expires: Date().addingTimeInterval(3600)]
                if httpOnly { props[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
                return HTTPCookie(properties: props)
            }
            for c in [cookie("campus_session", host, httpOnly: true), cookie("SID", ".google.com"), cookie("other", "unrelated.example.test")].compactMap({ $0 }) { await legacy.httpCookieStore.setCookie(c) }
            let stores = CampusWebStores(persistent: true, defaults: defaults, legacy: { legacy })
            let startedOnLegacy = stores.current === legacy
            // Swap 1: the default store's way: only Campus's and Google's cookies move, Campus's host's leave the old store, the rest stays there.
            let retired1 = stores.install(await stores.prepare(campusHost: host))
            let moved = await stores.current.httpCookieStore.allCookies().map { $0.name }.sorted()
            await stores.forget(retired1)
            let left = await legacy.httpCookieStore.allCookies().map { $0.name }.sorted()
            let savedID = defaults.string(forKey: "conn.campusStore.id").flatMap(UUID.init(uuidString:))
            report("Campus stores: the first swap moves Campus's and Google's cookies to a store with an identifier Conn remembers, takes Campus's out of the old store and leaves the rest there",
                   startedOnLegacy && moved == ["SID", "campus_session"] && left == ["SID", "other"] && savedID != nil && stores.swaps == 1, "moved=\(moved) left=\(left) id=\(savedID != nil)")
            // A new launch finds the store it was left on.
            var sameCookies: [String] = []
            do {
                let relaunched = CampusWebStores(persistent: true, defaults: defaults, legacy: { legacy })
                sameCookies = await relaunched.current.httpCookieStore.allCookies().map { $0.name }.sorted()
            }
            report("Campus stores: a relaunch opens that store again, with the session in it", sameCookies == ["SID", "campus_session"], "cookies=\(sameCookies)")
            // Swap 2: a store of Campus's own moves whole, and the old one is removed.
            let oldID = savedID
            let retired2 = stores.install(await stores.prepare(campusHost: host))
            let moved2 = await stores.current.httpCookieStore.allCookies().map { $0.name }.sorted()
            await stores.forget(retired2)
            newID = defaults.string(forKey: "conn.campusStore.id").flatMap(UUID.init(uuidString:))
            let existing = await WKWebsiteDataStore.allDataStoreIdentifiers
            report("Campus stores: the next swap moves the whole store, remembers the new identifier and removes the old store from disk",
                   moved2 == ["SID", "campus_session"] && newID != nil && newID != oldID && oldID.map { !existing.contains($0) } == true && newID.map { existing.contains($0) } == true && (defaults.stringArray(forKey: "conn.campusStore.leftovers") ?? []).isEmpty,
                   "moved=\(moved2) oldGone=\(oldID.map { !existing.contains($0) } ?? false)")
        }
        // Clean up: the check's own stores leave nothing behind (WebKit does not remove a store that is still held, so they are let go first).
        for id in [legacyID, newID].compactMap({ $0 }) {
            for _ in 0..<10 {
                if (try? await WKWebsiteDataStore.remove(forIdentifier: id)) != nil { break }
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
        }
        let remaining = await WKWebsiteDataStore.allDataStoreIdentifiers
        report("Campus stores: the check removed every store it made", ![legacyID, newID].compactMap { $0 }.contains { remaining.contains($0) }, "remaining=\(remaining.count)")
    }

    // MARK: Watch

    static func watchChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                            js: (WKWebView, String) async -> String, shot: (String) async -> Void, host: String) async {
        let campus = model.campus, watch = model.watch
        watch.forgetEverything()
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
        // A remembered Campus column (Watch setups, README "Watch view") is gone only when the live feed no longer lists the conversation.
        report("Campus: a remembered Campus column is gone only when the live feed does not list it (a listed one is kept, a reader id is never judged by Campus)",
               campus.link == .live && campus.asOf != nil && !model.watch.isGone(CampusColumn.key("ses_fakeRates01")) && model.watch.isGone(CampusColumn.key("ses_noLongerThere99")) && !model.watch.isGone(herdr[0].sessionID!),
               "link=\(campus.link) listed=\(!model.watch.isGone(CampusColumn.key("ses_fakeRates01"))) unlisted=\(model.watch.isGone(CampusColumn.key("ses_noLongerThere99")))")
        if let u = model.web.embedURL, u.isFileURL {
            var columns: [(Int, String)] = []
            for i in watch.layout.slots.indices { if let s = watch.layout.slots[i], let cid = CampusColumn.id(of: s.session) { columns.append((i, cid)) } }
            let drawn = await until(15) {
                columns.allSatisfy { index, id in CampusEmbedBox.live.allObjects.contains { $0.column == index && $0.shownID == id && $0.phase == .ready && $0.sets > 0 } }
            }
            report("Campus: the Campus columns in Watch are drawn on the reader's embed page too, one page per column", !columns.isEmpty && drawn, "columns=\(columns.map { "\($0.0):\($0.1.suffix(4))" })")
        }
        await WatchFocusCheck.campusSteps(model: model, report: report, wait: wait, conversation: "ses_fakeRates01")
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
        // 9. Sending like the other agents: a message typed behind another waits in a queue, Undo takes the lot back in order, Now skips the wait, a failure gives everything back.
        _ = await until(25) { campus.conversation("ses_fakeOffsite04")?.working != true }
        _ = await until(10) { campus.held == nil }
        let offsiteC = campus.conversation("ses_fakeOffsite04")!
        model.openCampus("ses_fakeOffsite04")
        let restoredBefore = restored.count
        let logQ0 = await log().count
        let firstTaken = model.campusSend("First of two", to: offsiteC, delivery: nil)
        let secondTaken = model.campusSend("Second of two", to: offsiteC, delivery: nil)
        await wait(0.5)
        let queued = campus.held?.phase == .held && campus.waiting.count == 1 && campus.waiting.first?.label.hasSuffix(": Second of two") == true
        await shot("campus-18-send-queue.png")
        campus.undo()
        let undoneAll = campus.held?.phase == .undone && campus.held?.alsoReturned == 1 && campus.waiting.isEmpty
        let backTexts = restored.suffix(from: restoredBefore).map { $0.1 }
        // A box that is not on screen when its text comes back takes it when it appears: the first typed on top, and only once.
        model.campusReturnDraft("Second of two", to: "ses_notShown"); model.campusReturnDraft("First of two", to: "ses_notShown")
        let claimOrder = model.claimCampusDrafts("ses_notShown") == "First of two\nSecond of two" && model.claimCampusDrafts("ses_notShown") == nil
        await wait(4)
        report("Campus sending: a message typed behind another waits in a queue under the banner, and Undo takes both back into their boxes (the first on top) with nothing sent",
               firstTaken && secondTaken && queued && undoneAll && backTexts == ["Second of two", "First of two"] && claimOrder,
               "taken=\(firstTaken)/\(secondTaken) queued=\(queued) undone=\(undoneAll) back=\(backTexts)")
        let logQ1 = await log().count
        _ = await until(10) { campus.held == nil }
        _ = model.campusSend("Goes at once", to: campus.conversation("ses_fakeOffsite04")!, delivery: nil)
        _ = model.campusSend("Goes after its own window", to: campus.conversation("ses_fakeOffsite04")!, delivery: nil)
        await wait(0.4)
        let tNow = Date()
        campus.sendNow()
        let nowSent = await until(1.5) { campus.timeline("ses_fakeOffsite04")?.items.contains { $0.kind == .user && $0.text == "Goes at once" } == true }
        let nowTook = Date().timeIntervalSince(tNow)
        let wNow = await log()
        let secondWaits = campus.held?.conversationID == "ses_fakeOffsite04" && campus.held?.phase == .held && campus.waiting.isEmpty
        await shot("campus-19-send-now.png")
        let bothOut = await until(10) { campus.held?.phase == .sent && campus.timeline("ses_fakeOffsite04")?.items.contains { $0.kind == .user && $0.text == "Goes after its own window" } == true }
        let wQ = await log()
        report("Campus sending: Now sends the one at the front at once (well inside the 3-second window); the next waits its own window and goes after it, in order",
               logQ1 == logQ0 && nowSent && nowTook < 2.0 && wNow.count == logQ1 + 1 && wNow.last?.contains("Goes at once") == true && secondWaits && bothOut && wQ.count == logQ1 + 2 && wQ.last?.contains("Goes after its own window") == true,
               "now=\(nowSent) in \(String(format: "%.1f", nowTook)) s log=\(wNow.count - logQ1)/\(wQ.count - logQ1) next=\(secondWaits)")
        _ = await until(25) { campus.conversation("ses_fakeOffsite04")?.working != true }
        _ = await until(10) { campus.held == nil }
        await control("/__fake/fail-writes?on=1")
        let restoredFail = restored.count
        _ = model.campusSend("Fails one", to: campus.conversation("ses_fakeOffsite04")!, delivery: nil)
        _ = model.campusSend("Fails two", to: campus.conversation("ses_fakeOffsite04")!, delivery: nil)
        let failedQ = await until(10) { if case .failed? = campus.held?.phase { return true }; return false }
        await control("/__fake/fail-writes?on=0")
        let failBack = restored.suffix(from: restoredFail).map { $0.1 }
        let wFail = await log()
        report("Campus sending: when the first of two fails, both texts go back to the box (in the order typed) and the second is never sent",
               failedQ && failBack == ["Fails two", "Fails one"] && campus.held?.alsoReturned == 1 && campus.waiting.isEmpty && wFail.count == wQ.count, "failed=\(failedQ) back=\(failBack) log=\(wFail.count)/\(wQ.count)")
        _ = await until(10) { campus.held == nil }
        model.disableCampusWrites()
        report("Campus writes: the switch can be turned off again at once", !campus.writesEnabled, "")
    }
}
