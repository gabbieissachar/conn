// `--ui-check` step for the open asks on the agent rows. With `--fixture` the asks come from Resources/fixture/open-asks.json
// (times moved so the fixture's moment is now), so every number below is known: 8 asks for this Herdr session (a ninth, for another
// Herdr session, is left out), 7 for live panes, 4 of them under 24 hours, 3 older. It checks what a person would meet: the order of the list and of Cmd+1..9, the fold behind "show N older",
// where a click lands (with an ask, without one, and on an ask that is folded away), that the reader being down changes
// nothing but the asks, and, from a drawing of the window, that the red bar of an ask block is on screen. SwiftUI builds no
// accessibility tree for an inert background window, so the drawing is read as pixels (like the starred row check).
import SwiftUI
import Network
import ConnCore

@MainActor
enum AskRowsCheck {
    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture else { await runLive(model: model, report: report, wait: wait); return }
        let store = model.openAsks
        let savedOlder = store.showOlder
        defer { store.showOlder = savedOlder }
        store.showOlder = false
        model.showWeb = true; model.webTab = .reader; model.readerFollows = true
        if let w = Capture.mainWindow() { w.setContentSize(NSSize(width: 1500, height: 900)) }
        await wait(2)
        let now = Date()

        // 1. The feed is read and joined to the live panes.
        let live = Set(model.snapshot.agents.map(\.id))
        let liveAsks = store.asks.byPane.filter { live.contains($0.key) }
        report("the fixture's open asks are read (8 for this Herdr session, one of them for a pane that is not live; an ask of another Herdr session that reuses a pane id is left out)", store.asks.byPane.count == 8 && liveAsks.count == 7 && store.asks.byPane["w01:p4"]?.herdr == "fake" && store.lastAnswerGood == true, "asks=\(store.asks.byPane.count) live=\(liveAsks.count) polls=\(store.polls)")

        // 2. Order: prompt waiting first, then the newest ask, then today's order; Cmd+1..9 follows it.
        let freshOrder = ["w01:p4", "w03:p3", "w05:p2", "w01:p2", "w02:p4", "w05:p3"]
        let order = model.agentOrder.map(\.id)
        report("agents that need you lead the list: prompt waiting first, then the newest ask, the rest in today's order", Array(order.prefix(6)) == freshOrder && Array(order.dropFirst(6)) == model.snapshot.prioritized.map(\.id).filter { !freshOrder.contains($0) },
               "first six=\(order.prefix(6)) all=\(order.count)")
        report("the folded older asks (3) move no row", store.visible().count == 5 && Set(store.visible().keys).isDisjoint(with: ["w04:p2", "w02:p2", "w06:p3"]) && store.asks.olderCount(among: model.snapshot.agents, now: store.now) == 3,
               "visible=\(store.visible().keys.sorted()) older=\(store.asks.olderCount(among: model.snapshot.agents, now: store.now))")
        if let win = Capture.mainWindow() {
            func press(_ digit: String, _ code: UInt16) async -> Bool {
                guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: win.windowNumber, context: nil, characters: digit, charactersIgnoringModifiers: digit, isARepeat: false, keyCode: code) else { return false }
                let handled = NSApp.mainMenu?.performKeyEquivalent(with: e) ?? false
                await wait(0.4)
                return handled
            }
            let h1 = await press("1", 18); let a = model.selectedPaneID
            let h2 = await press("2", 19); let b = model.selectedPaneID
            let h4 = await press("4", 21); let d = model.selectedPaneID
            report("Cmd+1, Cmd+2 and Cmd+4 open the agents in the new order", h1 && h2 && h4 && a == order[0] && b == order[1] && d == order[3], "handled=\(h1)/\(h2)/\(h4) selected=\(a ?? "-")/\(b ?? "-")/\(d ?? "-") want=\(order[0])/\(order[1])/\(order[3])")
        }
        let beforeCycle = model.selectedPaneID
        model.cycle(1)
        report("next agent follows the new order", beforeCycle != nil && model.selectedPaneID == order[(order.firstIndex(of: beforeCycle!)! + 1) % order.count], "from=\(beforeCycle ?? "-") to=\(model.selectedPaneID ?? "-")")

        // 3. The red bar of an ask block is on screen, and the block has its three parts.
        if let win = Capture.mainWindow(), let content = win.contentView {
            await wait(0.5)
            let rect = NSRect(x: 0, y: 0, width: 250, height: content.bounds.height)
            if let rep = content.bitmapImageRepForCachingDisplay(in: rect) {
                content.cacheDisplay(in: rect, to: rep)
                if let px = StarredBarCheck.Pixels(rep) {
                    let scale = CGFloat(px.width) / rect.width
                    let want = AgentState.blocked.color
                    let ns = NSColor(want).usingColorSpace(.deviceRGB) ?? .red
                    func near(_ x: Int, _ y: Int) -> Bool {
                        let p = px.rgb(x, y)
                        return abs(p[0] - ns.redComponent) < 0.08 && abs(p[1] - ns.greenComponent) < 0.08 && abs(p[2] - ns.blueComponent) < 0.08 && px.alpha(x, y) > 0.9
                    }
                    // A bar is a run of that colour at least 24 points tall in one column; the state glyph and the state text are
                    // shorter. The column with the most such runs counts, one run per ask block in view.
                    var bars = 0
                    for x in Int(30 * scale)..<Int(70 * scale) {
                        var run = 0, found = 0
                        for y in 0...px.height {
                            if y < px.height, near(x, y) { run += 1 } else { if CGFloat(run) / scale >= 24 { found += 1 }; run = 0 }
                        }
                        bars = max(bars, found)
                    }
                    report("each ask block on screen has its red leading bar (at least 3 of the 4 are in view)", bars >= 3, "bars=\(bars)")
                } else { report("the sidebar can be read as pixels", false, "no pixels") }
            }
            if let dir = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] {
                await Capture.window(to: URL(fileURLWithPath: dir).appendingPathComponent("asks-on-rows.png"))
            }
        }

        // 4. Clicks. A row with an ask opens the reader at that reply; a row without one is what it always was.
        let reader = model.web.box(.reader)
        func fragment() async -> String {
            var n = 0
            while reader.phase != .ready && n < 40 { await wait(0.2); n += 1 }
            await wait(0.8)
            return reader.webView.url?.fragment ?? ""
        }
        guard let asking = model.snapshot.agent("w01:p2"), let ask = store.visible()["w01:p2"] else { report("the fixture agent with an ask exists", false, ""); return }
        model.sidebarOpenAgent(asking)
        let f1 = await fragment()
        report("a click on a row with an ask opens the reader at the session and the asking reply", f1 == ask.readerFragment && model.selectedPaneID == asking.id && model.webTab == .reader,
               "fragment=\(f1) want=\(ask.readerFragment) selected=\(model.selectedPaneID ?? "-")")
        await wait(1.0)      // longer than the 0.35 s pin that follows a selection: it must not take the reader off the ask
        let f1b = await fragment()
        report("the reader stays on the ask (the pin that follows a selection does not override it)", f1b == f1, "fragment=\(f1b)")
        // An ask the reader could not name a reply for (`message` null): the row still opens the conversation, at its newest turn.
        if let unnamed = model.snapshot.agent("w05:p3"), let ask5 = store.visible()["w05:p3"] {
            model.sidebarOpenAgent(unnamed)
            let f1c = await fragment()
            report("a click on an ask with no reply id opens the session alone", ask5.message == nil && f1c == "s=\(ask5.session)" && model.selectedPaneID == unnamed.id, "fragment=\(f1c)")
        } else { report("the fixture agent with an ask and no reply id exists", false, "") }
        guard let plain = model.snapshot.agent("w03:p2"), store.visible()["w03:p2"] == nil, let sid = plain.sessionID else { report("a fixture agent without an ask exists", false, ""); return }
        model.sidebarOpenAgent(plain)
        let f2 = await fragment()
        report("a click on a row without an ask opens its session at the newest turn, as before (no reply in the address)", f2 == "s=\(sid)" && model.selectedPaneID == plain.id, "fragment=\(f2)")
        guard let folded = model.snapshot.agent("w04:p2"), let foldedSession = folded.sessionID else { report("the folded fixture agent exists", false, ""); return }
        model.sidebarOpenAgent(folded)
        let f3 = await fragment()
        report("a click on a row whose older ask is folded away behaves as a row without an ask", f3 == "s=\(foldedSession)", "fragment=\(f3)")
        store.showOlder = true; await wait(0.5)
        let shownOrder = model.agentOrder.map(\.id)
        report("show older lists the three older asks too, after the fresh ones and in newest-first order", Array(shownOrder.prefix(9)) == freshOrder + ["w04:p2", "w02:p2", "w06:p3"] && store.visible().count == 8, "first nine=\(shownOrder.prefix(9))")
        model.sidebarOpenAgent(folded)
        let f4 = await fragment()
        let olderAsk = store.visible()["w04:p2"]
        report("with older asks shown, a click on one opens the reader at its reply", olderAsk != nil && f4 == olderAsk!.readerFragment, "fragment=\(f4)")
        // The reader hidden: a click on an ask shows the column again.
        model.showWeb = false; await wait(0.5)
        model.sidebarOpenAgent(asking)
        let f5 = await fragment()
        report("a click on an ask shows the reader column when it was hidden", model.showWeb && model.webTab == .reader && f5 == ask.readerFragment, "showWeb=\(model.showWeb) fragment=\(f5)")
        store.showOlder = false

        // 5. The reader goes away: after the forgiven first failure the rows show no asks and the order is today's.
        let feed = store.asks.byPane.values.map { $0 }
        store.apply(nil, at: Date())
        let kept = store.asks.byPane.count == 8
        store.apply(nil, at: Date()); await wait(0.5)
        report("a failed answer is forgiven once; the second clears the asks and the list is in today's order", kept && store.asks.isEmpty && model.agentOrder.map(\.id) == model.snapshot.prioritized.map(\.id) && model.ask(for: asking) == nil,
               "keptAfterOne=\(kept) asksNow=\(store.asks.byPane.count)")
        model.sidebarOpenAgent(asking)
        let f6 = await fragment()
        report("with no asks a click is today's behaviour", f6 == "s=\(asking.sessionID ?? "-")", "fragment=\(f6)")
        store.apply(OpenAsksFeed(generatedAt: nil, asks: feed.sorted { $0.paneID < $1.paneID }), at: Date()); await wait(0.5)
        report("the asks come back when the reader does", store.asks.byPane.count == 8, "asks=\(store.asks.byPane.count)")
        _ = now
    }

    /// Against a real Herdr and the real reader (a scripted launch: own settings, no Herdr client attached, nothing typed into Herdr).
    /// Waits for the first good answer, prints what the rows would show, then does what a click on the top ask row does and reads
    /// where the reader page landed.
    private static func runLive(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        let store = model.openAsks
        model.showWeb = true; model.webTab = .reader; model.readerFollows = true
        var n = 0
        while store.lastAnswerGood != true && n < 80 { await wait(0.5); n += 1 }
        let answered = store.lastAnswerGood == true      // the page may be mid-reload for a later poll (another check pins it); one good answer is the proof
        let live = Set(model.snapshot.agents.map(\.id))
        let visible = store.visible()
        let order = model.agentOrder.map(\.id)
        let base = model.snapshot.prioritized(asks: visible).map(\.id)
        let fresh = store.asks.byPane.filter { live.contains($0.key) && visible[$0.key] != nil }
        print("ui-check: info open asks from the real reader: answered=\(store.lastAnswerGood.map(String.init) ?? "none") polls=\(store.polls) feedAsks=\(store.asks.byPane.count) forLivePanes=\(store.asks.byPane.keys.filter { live.contains($0) }.count) visibleUnder24h=\(visible.count) agents=\(model.snapshot.agents.count) older=\(store.asks.olderCount(among: model.snapshot.agents, now: store.now))")
        let sameSession = store.asks.byPane.values.filter { a in model.snapshot.agent(a.paneID)?.sessionID == a.session }.count
        print("ui-check: info the ask's session is the agent's own session id for \(sameSession) of \(store.asks.byPane.count) asks")
        report("the real reader answers the open-asks route from inside the Reader page", answered, "polls=\(store.polls)")
        report("with the reader's asks the agent order is a permutation of the agents (nothing lost or doubled)", Set(order).count == order.count && Set(order) == live && order == base, "agents=\(order.count)")
        let needs = order.map { visible[$0] != nil || model.snapshot.agent($0)?.state == .blocked }
        let firstPlain = needs.firstIndex(of: false) ?? needs.count
        report("agents with an ask (or a prompt waiting) lead the list", !needs[firstPlain...].contains(true), "needYou=\(needs.filter { $0 }.count) leading=\(firstPlain)")
        guard let top = order.compactMap({ id in visible[id].flatMap { a in model.snapshot.agent(id).map { ($0, a) } } }).first else { print("ui-check: info no live agent has an open ask under 24 hours; the click was not tried"); return }
        let (agent, ask) = top
        model.sidebarOpenAgent(agent)
        let reader = model.web.box(.reader)
        n = 0
        while reader.phase != .ready && n < 80 { await wait(0.25); n += 1 }
        await wait(1.5)
        let hash = reader.webView.url?.fragment ?? ""
        let probe = try? await reader.webView.callAsyncJavaScript("const el = document.querySelector('.is-linked'); if (!el) return null; const r = el.getBoundingClientRect(); return { msg: el.dataset.msg || el.id, top: Math.round(r.top), height: Math.round(r.height), vh: innerHeight, running: el.getAnimations().length, title: document.title };", arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
        print("ui-check: info real click: pane=\(agent.id) askAge=\(ask.at.map { Int(store.now.timeIntervalSince($0)) } ?? -1)s fragmentPrefix=\(hash.prefix(12)) outlined=\(probe.map { "msg=\(($0["msg"] as? String)?.prefix(8) ?? "-") top=\($0["top"] ?? "-") height=\($0["height"] ?? "-") viewport=\($0["vh"] ?? "-") animations=\($0["running"] ?? "-")" } ?? "none")")
        // The real reader shortens its own address to the first eight characters of the session once it has opened it, so the
        // address is compared by that prefix; the outlined reply is what proves it scrolled to the asking reply.
        let shown = probe?["msg"] as? String
        report("a click on the top ask row opens the reader at the asking reply (its session is in the address and that reply is the outlined one)",
               hash.hasPrefix("s=\(ask.session.prefix(8))") && (ask.message == nil || shown == "\(ask.message!):reply"), "session=\(hash.hasPrefix("s=\(ask.session.prefix(8))")) outlined=\(shown.map { String($0.prefix(8)) } ?? "none") want=\(ask.message.map { String($0.prefix(8)) } ?? "-")")
        _ = fresh
    }
}

/// A stand-in for the reader's token guard on a free local port: the page carries the token in `<meta name="reader-token">`, the
/// open-asks route answers 200 only with that token in `x-transcript-reader-token`, 403 without it, and `routeStatus` can make it
/// answer 404 (`not_built`, or an older reader) instead. It records what each route was asked.
final class StandInReaderServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "conn.stand-in-reader")
    private(set) var port: UInt16 = 0
    let token = "tok-\(Int.random(in: 100000...999999))"
    private let lock = NSLock()
    private var _seen: [(path: String, token: String?)] = []
    var routeStatus = 200
    var seen: [(path: String, token: String?)] { lock.lock(); defer { lock.unlock() }; return _seen }
    static let feed = #"{"status":"ok","generated_at":"2026-11-06T09:00:00.000000+00:00","as_of":"2026-11-06T09:00:00.000000+00:00","asks":[{"pane_id":"w1:p1","herdr":"fake","session":"00000000-0000-4000-8000-0000000000aa","message":null,"lines":["Which one?"],"at":"2026-11-06T08:50:00.000000+00:00","tags":[],"older":false}]}"#

    init?() {
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
            let lines = head.components(separatedBy: "\r\n")
            let path = String((lines.first ?? "").split(separator: " ").dropFirst().first?.split(separator: "?").first ?? "/")
            let sent = lines.first { $0.lowercased().hasPrefix("x-transcript-reader-token:") }.map { String($0.drop(while: { $0 != ":" }).dropFirst()).trimmingCharacters(in: .whitespaces) }
            self.lock.lock(); self._seen.append((path, sent)); self.lock.unlock()
            var code = 200, type = "text/html; charset=utf-8", body = "not found"
            switch path {
            case "/page.html": body = "<!doctype html><meta charset=\"utf-8\"><meta name=\"reader-token\" content=\"\(self.token)\"><title>reader</title>"
            case "/lite.html": body = "<!doctype html><meta charset=\"utf-8\"><meta name=\"reader-token\" content=\"\(self.token)\"><title>lite</title>"
            case "/notoken.html": body = "<!doctype html><meta charset=\"utf-8\"><meta name=\"reader-token\" content=\"__READER_TOKEN__\"><title>reader</title>"
            case OpenAsksSource.path:
                type = "application/json"
                if self.routeStatus != 200 { code = self.routeStatus; body = #"{"status":"not_built","asks":[]}"# }
                else if sent == self.token { body = Self.feed } else { code = 403; body = "Missing or invalid token" }
            default: code = 404
            }
            let bytes = Data(body.utf8)
            let header = "HTTP/1.1 \(code) X\r\nContent-Type: \(type)\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
            conn.send(content: Data(header.utf8) + bytes, completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    func stop() { listener.cancel() }
}

@MainActor
enum OpenAsksPageReadCheck {
    /// The live path of the poll: the question goes out from inside the reader page, with the token that page holds.
    static func run(report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard let server = StandInReaderServer() else { report("a stand-in reader for the open-asks read starts", false, "could not listen"); return }
        defer { server.stop() }
        let root = "http://127.0.0.1:\(server.port)"
        func settled(_ box: WebBox) async { var n = 0; while box.phase != .ready && n < 60 { await wait(0.1); n += 1 } }

        let box = WebBox(kind: .reader, baseURL: URL(string: "\(root)/page.html")!, fixtureDir: nil)
        let beforeLoad = await box.fetchOpenAsks()
        box.loadIfNeeded(); await settled(box)
        let feed = await box.fetchOpenAsks()
        let asked = server.seen.filter { $0.path == OpenAsksSource.path }
        report("the page read sends the token the reader page holds and gets the asks (nothing is asked before the page is loaded)",
               beforeLoad == nil && feed?.asks.map(\.paneID) == ["w1:p1"] && feed?.asks.first?.message == nil && asked.count == 1 && asked.first?.token == server.token,
               "before=\(beforeLoad == nil) asks=\(feed?.asks.count ?? -1) requests=\(asked.count) tokenSent=\(asked.first?.token == server.token)")

        server.routeStatus = 404
        let missing = await box.fetchOpenAsks()
        report("a 404 (not built yet, or an older reader) is no asks", missing == nil, "feed=\(missing == nil ? "nil" : "some")")
        server.routeStatus = 200

        let bare = WebBox(kind: .reader, baseURL: URL(string: "\(root)/notoken.html")!, fixtureDir: nil)
        bare.loadIfNeeded(); await settled(bare)
        let before = server.seen.count
        let none = await bare.fetchOpenAsks()
        report("a page that holds no token is not asked and gives no asks", none == nil && server.seen.count == before, "feed=\(none == nil ? "nil" : "some") requests=\(server.seen.count - before)")

        // The hub asks from whichever reader page is loaded. Normal mode: it loads the full page itself, answers on the next beat.
        let hub = WebHub(fixture: false, resourceDir: nil, readerURL: URL(string: "\(root)/page.html")!)
        let first = await hub.fetchOpenAsks()
        if let b = hub.readerBox { await settled(b) }
        let second = await hub.fetchOpenAsks()
        report("the hub loads the full reader page when no page is loaded, and asks it on the next beat",
               first == nil && hub.readerBox != nil && second?.asks.map(\.paneID) == ["w1:p1"], "first=\(first == nil ? "nil" : "some") second=\(second?.asks.count ?? -1)")

        // Watch mode (extra pages given, the full page not loaded): a lite page on the same server answers, and the full page is never loaded.
        let lite = WebBox(kind: .reader, baseURL: URL(string: "\(root)/lite.html")!, fixtureDir: nil)
        let watchHub = WebHub(fixture: false, resourceDir: nil, readerURL: URL(string: "\(root)/page.html")!)
        watchHub.extraReaderPages = { [lite] in [lite.webView] }
        let notYet = await watchHub.fetchOpenAsks()
        lite.loadIfNeeded(); await settled(lite)
        let before2 = server.seen.filter { $0.path == "/page.html" }.count
        let viaLite = await watchHub.fetchOpenAsks()
        report("with the Watch view's lite page loaded, the asks come from it and the full reader page is not loaded",
               notYet == nil && viaLite?.asks.map(\.paneID) == ["w1:p1"] && watchHub.readerBox == nil && server.seen.filter { $0.path == "/page.html" }.count == before2,
               "notYet=\(notYet == nil ? "nil" : "some") viaLite=\(viaLite?.asks.count ?? -1) fullPageBuilt=\(watchHub.readerBox != nil)")
        let emptyHub = WebHub(fixture: false, resourceDir: nil, readerURL: URL(string: "\(root)/page.html")!)
        emptyHub.extraReaderPages = { [] }
        let none2 = await emptyHub.fetchOpenAsks()
        report("with the Watch view on and no page loaded yet, the asks are empty and the full page stays unloaded", none2 == nil && emptyHub.readerBox == nil, "feed=\(none2 == nil ? "nil" : "some")")

        server.stop()
        try? await Task.sleep(nanoseconds: 300_000_000)
        let down = await box.fetchOpenAsks()
        report("a reader that has gone away gives no asks and no hang", down == nil, "feed=\(down == nil ? "nil" : "some")")
    }
}
