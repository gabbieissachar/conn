// `--ui-check` steps for the Watch view. With `--fixture` the columns show the invented lite page (Resources/fixture/fixture-lite.html),
// which follows an address the way the reader's lite page does, so the column rule is checked end to end: free column, a session
// already open (its column scrolls to the asking reply and flashes, the others stay), and replacement of the least recently used
// column (same column and web view, the others untouched). The "used" signal is the page's own report (a click, scroll, key or focus
// event inside the page), so a synthetic event dispatched in the page takes the same route a real one does. Without `--fixture` the
// real reader's lite page is opened read-only: nothing is sent to any agent.
import SwiftUI
import WebKit
import ConnCore

@MainActor
enum WatchCheck {
    static func tail(_ sid: String) -> Int { Int(sid.split(separator: "-").last ?? "") ?? 0 }
    static func mb(_ b: UInt64) -> String { String(format: "%.0f MB", Double(b) / ProcessUsage.mebibyte) }

    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        let fixture = model.config.fixture
        guard let win = Capture.mainWindow() else { report("Watch: the window is there", false, "no main window"); return }
        let savedCount = model.watch.count, savedMode = model.mode, savedWeb = model.showWeb, savedTab = model.webTab
        // The count is remembered across launches (and a test launch's own domain keeps it between runs): start from the default, because the
        // fixture's conversations repeat every few sessions, so four columns can show the same one twice and fail "its own conversation".
        model.setWatchCount(WatchLayout.defaultCount)
        model.mode = .agent; model.showWeb = true; model.webTab = .reader; await wait(0.5)
        let shots = fixture ? ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"].map { URL(fileURLWithPath: $0) } : nil
        func shot(_ name: String) async { if let d = shots { await Capture.window(to: d.appendingPathComponent(name)) } }
        // The Watch menu item (Layout, Shift+Cmd+W): its key and modifiers are read from the menu, and its action is run through the
        // menu. A synthetic Shift+Cmd+letter event is not matched by AppKit's key-equivalent search in this inert window, so the
        // press itself is for a person (README, Watch).
        func watchItem() -> (menu: NSMenu, index: Int, item: NSMenuItem)? {
            guard let layout = NSApp.mainMenu?.items.first(where: { $0.title == "Layout" })?.submenu else { return nil }
            guard let i = layout.items.firstIndex(where: { $0.keyEquivalent.lowercased() == "w" }) else { return nil }
            return (layout, i, layout.items[i])
        }
        func key(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags) async -> Bool {
            guard let w = watchItem() else { return false }
            w.menu.performActionForItem(at: w.index)
            await wait(0.6)
            return true
        }
        func js(_ box: WebBox, _ s: String) async -> String { await ReaderPinCheck.js(box, s) }
        func settle(timeout: Double = 20) async {
            var t = 0.0
            while t < timeout, !(model.watch.boxes.count >= model.watch.layout.openCount && model.watch.boxes.values.allSatisfy { $0.phase == .ready }) { await wait(0.25); t += 0.25 }
            await wait(0.6)
        }
        func columnBoxes() -> [WebBox?] { model.watch.layout.slots.map { c in c.flatMap { model.watch.boxes[$0.id] } } }
        func scrollY(_ b: WebBox?) async -> String { guard let b = b else { return "-" }; return await js(b, "String(Math.round(window.scrollY))") }
        let withSession = model.snapshot.prioritized.filter { $0.sessionID != nil }
        guard withSession.count >= 6 else { report("Watch: enough agents with a conversation", false, "only \(withSession.count)"); return }

        // 1. The shortcut turns Watch on: columns filled, the full reader unloaded, every column its own web view.
        model.watch.openAskTurnID = { _ in nil }
        let startedOn = model.watchOn
        let wi = watchItem()
        report("the Layout menu has Watch on Shift+Cmd+W", wi.map { $0.item.keyEquivalentModifierMask.intersection([.command, .shift, .control, .option]) == [.command, .shift] && $0.item.isEnabled } ?? false,
               "item=\(wi.map { "\($0.item.title) [\($0.item.keyEquivalent)] mask=\($0.item.keyEquivalentModifierMask.rawValue)" } ?? "none")")
        let toggled = await key("W", 13, [.command, .shift])
        await settle()
        let boxes = columnBoxes()
        let widths = boxes.compactMap { $0?.webView.frame.width }
        report("the Watch menu item (Shift+Cmd+W) turns Watch on: \(model.watch.count) columns, each filled with a session", toggled && !startedOn && model.watchOn && model.watch.layout.openCount == model.watch.count && boxes.allSatisfy { $0 != nil },
               "handled=\(toggled) on=\(model.watchOn) columns=\(model.watch.layout.sessions.map { String($0.prefix(8)) })")
        report("the full reader is unloaded while Watch is on", model.web.readerBox == nil && model.web.allBoxes.allSatisfy { $0.kind != .reader },
               "readerBox=\(model.web.readerBox == nil ? "nil" : "present")")
        let ids = Set(boxes.compactMap { $0.map { ObjectIdentifier($0) } })
        report("each column is its own web view on the lite page, loaded", ids.count == boxes.count && boxes.allSatisfy { $0?.phase == .ready && $0?.lite == true && WebLinkPolicy.isPage(model.web.liteBaseURL, $0?.webView.url) },
               "views=\(ids.count) phases=\(boxes.map { String(describing: $0?.phase) }) path=\(boxes.first??.webView.url?.path ?? "-")")
        report("the columns are readable widths side by side", widths.count == boxes.count && widths.allSatisfy { $0 >= WatchArea.minColumnWidth - 1 },
               "widths=\(widths.map { Int($0) }) window=\(Int(win.contentView?.frame.width ?? 0))")
        let titles = await withTaskGroupTitles(boxes, fixture: fixture)
        // The fixture page names a conversation by its session number modulo its 14 invented titles, so two sessions can share a title:
        // "not the same twice" is judged on the address each column was opened on, which the title only mirrors. With the real reader a
        // column whose session is not on the reader's list shows the reader's fallback conversation, so only fixtures judge it.
        let addresses = boxes.compactMap { $0?.webView.url?.fragment }
        report("each column shows its own conversation (not blank, not the same twice)", titles.allSatisfy { !$0.isEmpty } && addresses.count == boxes.count && (!fixture || Set(addresses).count == addresses.count), "titles=\(titles) addresses=\(addresses.map { String($0.suffix(12)) })")
        await shot("watch-\(model.watch.count)-columns.png")
        print("ui-check: info Watch columns: sessions=\(model.watch.layout.sessions) selected=\(model.selectedAgent?.sessionID ?? "-") candidates=\(model.agentOrder.prefix(8).map { "\($0.id)=\($0.sessionID ?? "-")" })")
        print("ui-check: info Watch memory, \(model.watch.count) columns: web content \(boxes.compactMap { $0?.pid }.compactMap { ProcessUsage.read($0)?.footprint }.map(mb)), app \(mb(ProcessUsage.read(getpid())?.footprint ?? 0))")

        // 2. The number of columns: 2, 4, 3; remembered; more columns fill from the sidebar's order.
        for n in [2, 4, 3] {
            model.setWatchCount(n); await settle()
            let bs = columnBoxes()
            let stored = AppModel.defaults.integer(forKey: WatchModel.countKey)
            report("\(n) columns: \(n) web views, all filled, the count is remembered", model.watch.count == n && bs.count == n && bs.allSatisfy { $0 != nil } && model.watch.boxes.count == n && stored == n,
                   "count=\(model.watch.count) views=\(model.watch.boxes.count) stored=\(stored) widths=\(bs.compactMap { $0?.webView.frame.width }.map { Int($0) })")
            if n != 3 { await shot("watch-\(n)-columns.png") }
            if n == 4 { print("ui-check: info Watch memory, 4 columns: web content \(bs.compactMap { $0?.pid }.compactMap { ProcessUsage.read($0)?.footprint }.map(mb))") }
        }

        if fixture {
            await ruleChecks(model: model, report: report, wait: wait, settle: settle, columnBoxes: columnBoxes, scrollY: scrollY, js: js, withSession: withSession, shot: shot)
        } else {
            await liveChecks(model: model, report: report, wait: wait, settle: settle, js: js)
        }

        // Leaving Watch loads the full reader again, pinned to the selected agent, and lets go of the columns.
        let off = await key("W", 13, [.command, .shift])
        await wait(1)
        report("the Watch menu item turns Watch off: the columns are let go and the full reader is back", off && !model.watchOn && model.watch.boxes.isEmpty && model.web.readerBox != nil,
               "on=\(model.watchOn) columnViews=\(model.watch.boxes.count) readerBox=\(model.web.readerBox == nil ? "nil" : "present") phase=\(model.web.readerBox.map { String(describing: $0.phase) } ?? "-")")
        if let r = model.web.readerBox { await ReaderPinCheck.settled(r, wait: wait) }
        report("the reader loads again after Watch", model.web.readerBox?.phase == .ready, "phase=\(model.web.readerBox.map { String(describing: $0.phase) } ?? "-")")
        let again = await key("W", 13, [.command, .shift])
        await settle()
        report("turning Watch on again opens the same sessions", again && model.watchOn && model.watch.layout.openCount == 3, "sessions=\(model.watch.layout.sessions.map { String($0.prefix(8)) })")
        _ = await key("W", 13, [.command, .shift])
        await wait(0.8)
        model.setWatchCount(savedCount)
        model.mode = savedMode; model.showWeb = savedWeb; model.webTab = savedTab
        model.wireWatchAsks()      // back to the app's own switch (the agent rows' open asks)
    }

    /// The titles the lite page shows. The fixture page has an element `#title`; the real page's title is read from the document.
    static func withTaskGroupTitles(_ boxes: [WebBox?], fixture: Bool) async -> [String] {
        var out: [String] = []
        for b in boxes {
            guard let b = b else { out.append(""); continue }
            let s = fixture ? "(document.getElementById('title')||{}).textContent||''" : "document.title||''"
            out.append(await ReaderPinCheck.js(b, s))
        }
        return out
    }

    // MARK: the column rule against the fixture's lite page

    static func ruleChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, settle: (Double) async -> Void,
                           columnBoxes: () -> [WebBox?], scrollY: (WebBox?) async -> String, js: (WebBox, String) async -> String,
                           withSession: [Agent], shot: (String) async -> Void) async {
        func turn(_ sid: String, _ k: Int) -> String { "t-\(String(format: "%04d", tail(sid)))-\(String(format: "%02d", k))" }
        func agentWith(session: String) -> Agent? { model.snapshot.agents.first { $0.sessionID == session } }
        func opened() -> [String] { model.watch.layout.slots.map { $0?.session ?? "-" } }
        func prefixes(_ l: [String]) -> [String] { l.map { String($0.suffix(4)) } }
        func linked(_ b: WebBox?) async -> String { guard let b = b else { return "-" }; return await js(b, "(document.querySelector('.is-linked')||{dataset:{}}).dataset.msg||''") }
        func atBottom(_ b: WebBox?) async -> Bool { guard let b = b else { return false }; return await js(b, "String(window.innerHeight + window.scrollY >= document.body.scrollHeight - 4)") == "true" }

        // A. A session that is already open: its column scrolls to the asking reply and flashes; nothing else moves.
        model.watch.openAskTurnID = { sid in turn(sid, 4) }
        let before = columnBoxes()
        let sessions0 = opened()
        guard before.count == 3, before.allSatisfy({ $0 != nil }) else { report("the column rule can be checked (three columns are showing)", false, "columns=\(sessions0)"); return }
        let target = 1
        let sidA = sessions0[target]
        let scrolls0 = await [scrollY(before[0]), scrollY(before[1]), scrollY(before[2])]
        let flashBefore = model.watch.flashes[model.watch.layout.slots[target]!.id] ?? 0
        if let a = agentWith(session: sidA) { model.sidebarOpenAgent(a) }
        await wait(1.3)
        let after = columnBoxes()
        let scrolls1 = await [scrollY(after[0]), scrollY(after[1]), scrollY(after[2])]
        let linkedMsg = await linked(after[target])
        report("an agent whose session is already a column: no column is added or replaced",
               opened() == sessions0 && zip(before, after).allSatisfy { $0 === $1 }, "columns=\(prefixes(opened())) same views=\(zip(before, after).allSatisfy { $0 === $1 })")
        report("... that column scrolls to the asking reply and outlines it, in place (no page load)",
               linkedMsg == turn(sidA, 4) && scrolls1[target] != scrolls0[target] && after[target]?.pinsInPlace == 1 && after[target]?.pinsLoaded == 1,
               "outlined=\(linkedMsg) want=\(turn(sidA, 4)) scrollY \(scrolls0[target]) -> \(scrolls1[target]) inPlace=\(after[target]?.pinsInPlace ?? -1) loads=\(after[target]?.pinsLoaded ?? -1)")
        report("... and the column is highlighted once", (model.watch.flashes[model.watch.layout.slots[target]!.id] ?? 0) == flashBefore + 1, "flash \(flashBefore) -> \(model.watch.flashes[model.watch.layout.slots[target]!.id] ?? 0)")
        report("... the other columns keep their scroll and their pages", scrolls1[0] == scrolls0[0] && scrolls1[2] == scrolls0[2] && after[0]?.pinsLoaded == before[0]?.pinsLoaded,
               "scrollY \(scrolls0) -> \(scrolls1)")
        await shot("watch-ask-landed.png")

        // B. A free column is used before anything is replaced.
        model.watch.openAskTurnID = { _ in nil }
        let open0 = Set(opened())
        let freeIdx = 2
        model.watch.close(column: freeIdx); await wait(0.4)
        let afterClose = columnBoxes()
        report("closing a column frees it and lets go of its web view; the others stay", model.watch.layout.slots[freeIdx] == nil && model.watch.boxes.count == 2 && afterClose[0] === after[0] && afterClose[1] === after[1],
               "columns=\(prefixes(opened())) views=\(model.watch.boxes.count)")
        guard let agentB = withSession.first(where: { !open0.contains($0.sessionID!) }) else { report("a further agent to open", false, ""); return }
        model.sidebarOpenAgent(agentB); await settle(15)
        let afterB = columnBoxes()
        report("an agent not shown goes into the free column", opened()[freeIdx] == agentB.sessionID && afterB[0] === after[0] && afterB[1] === after[1] && afterB[freeIdx] != nil && afterB[freeIdx] !== after[2],
               "columns=\(prefixes(opened())) wanted=\(String(agentB.sessionID!.suffix(4)))")
        let bottomB = await atBottom(afterB[freeIdx])
        report("... and with no open ask it opens at the newest turn", bottomB, "atBottom=\(bottomB)")

        // C. Every column taken: the least recently used one is replaced in place. "Used" arrives from the page itself.
        for i in [0, 2, 1] {
            _ = await js(afterB[i]!, "window.dispatchEvent(new Event('pointerdown')); 'ok'")
            await wait(0.4)
        }
        report("clicks inside the columns (reported by the pages) set the order of use: the first column is now the least recently used", model.watch.layout.leastRecentlyUsed == 0, "lru=\(model.watch.layout.leastRecentlyUsed.map(String.init) ?? "-")")
        for (i, ev) in [(1, "wheel"), (2, "keydown")] {   // a scroll and a keystroke count too
            _ = await js(afterB[i]!, "window.dispatchEvent(new Event('\(ev)')); 'ok'")
            await wait(0.4)
        }
        _ = await js(afterB[0]!, "window.dispatchEvent(new Event('focusin')); 'ok'"); await wait(0.4)
        report("a scroll, a keystroke and focus count as use as well", model.watch.layout.leastRecentlyUsed == 1, "lru=\(model.watch.layout.leastRecentlyUsed.map(String.init) ?? "-")")
        let scrollsC0 = await [scrollY(afterB[0]), scrollY(afterB[2])]
        let sessionsC0 = opened()
        let open1 = Set(sessionsC0)
        guard let agentC = withSession.first(where: { !open1.contains($0.sessionID!) }) else { report("another agent to open", false, ""); return }
        let loadsBefore = afterB.map { $0?.pinsLoaded ?? -1 }
        model.sidebarOpenAgent(agentC); await settle(15)
        let afterC = columnBoxes()
        var want = sessionsC0; want[1] = agentC.sessionID!
        let scrollsC1 = await [scrollY(afterC[0]), scrollY(afterC[2])]
        report("with every column taken, the least recently used column is replaced in place and the others are untouched",
               opened() == want && zip(afterB, afterC).allSatisfy { $0 === $1 } && afterC[0]?.pinsLoaded == loadsBefore[0] && afterC[2]?.pinsLoaded == loadsBefore[2] && scrollsC0 == scrollsC1,
               "columns=\(prefixes(opened())) want=\(prefixes(want)) same views=\(zip(afterB, afterC).allSatisfy { $0 === $1 }) scrollY \(scrollsC0) -> \(scrollsC1)")
        report("... the replaced column's page loaded the new session (not an address change on the old page)", afterC[1]?.pinsLoaded == loadsBefore[1] + 1 && afterC[1]?.shownSession.map { agentC.sessionID!.hasPrefix($0) || $0.hasPrefix(agentC.sessionID!) } == true,
               "loads \(loadsBefore[1]) -> \(afterC[1]?.pinsLoaded ?? -1) shown=\(afterC[1]?.shownSession ?? "-")")
        await shot("watch-replaced.png")

        // D. A space in the sidebar keeps the columns; leaving the view by choosing another one ends Watch.
        if let ws = model.snapshot.workspaces.last {
            model.sidebarOpenWorkspace(ws.id); await wait(0.5)
            report("clicking a space does not change the columns", model.watchOn && opened() == want, "columns=\(prefixes(opened()))")
        }
        model.watchOn = true
        model.mode = .editor; await wait(0.5)
        report("choosing another view (Editor) ends Watch and brings the reader back", !model.watchOn && model.web.readerBox != nil && model.watch.boxes.isEmpty, "on=\(model.watchOn) readerBox=\(model.web.readerBox == nil ? "nil" : "present")")
        model.mode = .agent; await wait(0.3)
        model.watchOn = true; await settle(15)

        await linkChecks(model: model, report: report, wait: wait, settle: settle, columnBoxes: columnBoxes, js: js, withSession: withSession, shot: shot)
    }

    // MARK: a session link clicked inside a column

    /// The fixture's lite page draws two session links in its last reply (`a.session-ref[data-session]`, data-ref `next` and `later`: the
    /// sessions one and two after its own), the way the reader draws a reply that names another session. A click is dispatched in the page like a
    /// real one (the page's capture handler cannot tell it apart), so the whole route runs: the injected script, the message handler, the
    /// column rule and the view. Checked: the clicked column never navigates; an open session keeps its column; a free column is used
    /// first; otherwise the least recently used column other than the clicked one is replaced; a Cmd-click opens the normal reader on
    /// the session; and in the full reader the same link is the page's own (Conn does not take it).
    static func linkChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, settle: (Double) async -> Void,
                           columnBoxes: () -> [WebBox?], js: (WebBox, String) async -> String, withSession: [Agent], shot: (String) async -> Void) async {
        func opened() -> [String] { model.watch.layout.slots.map { $0?.session ?? "-" } }
        func tails(_ l: [String]) -> [String] { l.map { String($0.suffix(3)) } }
        func ref(_ b: WebBox?, _ which: String) async -> String {
            guard let b = b else { return "" }
            return await js(b, "(document.querySelector('a[data-ref=\"\(which)\"]')||{dataset:{}}).dataset.session||''")
        }
        func click(_ b: WebBox?, _ which: String, meta: Bool = false) async -> String {
            guard let b = b else { return "no web view" }
            return await js(b, "(() => { const a = document.querySelector('a[data-ref=\"\(which)\"]'); if (!a) return 'no link'; return a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, metaKey: \(meta) })) ? 'not prevented' : 'prevented'; })()")
        }
        /// What a column's page is on: its address (with the load counter's query), how it was moved, its own hash and scroll.
        func state(_ b: WebBox?) async -> String {
            guard let b = b else { return "-" }
            let page = await js(b, "location.hash + '|' + Math.round(scrollY)")
            return "\(b.webView.url?.absoluteString ?? "-")|loads=\(b.pinsLoaded)|inPlace=\(b.pinsInPlace)|\(page)"
        }
        func states(_ bs: [WebBox?]) async -> [String] { var out: [String] = []; for b in bs { out.append(await state(b)) }; return out }
        func flash(_ i: Int) -> Int { model.watch.layout.slots[i].flatMap { model.watch.flashes[$0.id] } ?? 0 }
        func sameViews(_ a: [WebBox?], _ b: [WebBox?], _ idx: [Int]) -> Bool { idx.allSatisfy { a[$0] != nil && a[$0] === b[$0] } }

        let boxes0 = columnBoxes()
        guard boxes0.count == 3, boxes0.allSatisfy({ $0 != nil }), let id0 = model.watch.layout.slots[0]?.id else { report("a session link can be checked (three columns are showing)", false, "columns=\(tails(opened()))"); return }
        let n0 = await ref(boxes0[0], "next"), l0 = await ref(boxes0[0], "later")
        report("the lite page draws session links (a[data-session]) that name other sessions", !n0.isEmpty && !l0.isEmpty && n0 != l0 && n0 != model.watch.layout.slots[0]!.session && l0 != model.watch.layout.slots[0]!.session,
               "next=\(n0.suffix(3)) later=\(l0.suffix(3)) own=\(model.watch.layout.slots[0]!.session.suffix(3))")
        await shot("watch-session-link.png")

        // A. The linked session is already open in another column: that column keeps it, flashes once, nothing else moves, and the clicked
        // column does not navigate. (The clicked column is made the most recently used first, so opening the target elsewhere cannot replace it.)
        model.watch.used(columnID: id0)
        model.watch.open(session: n0); await settle(15)
        let boxesA = columnBoxes(), sessA = opened()
        guard let j = model.watch.layout.index(of: n0), j != 0 else { report("the linked session is open in another column (setup)", false, "columns=\(tails(sessA))"); return }
        let statesA = await states(boxesA), flashJ = flash(j), flash0 = flash(0)
        let resultA = await click(boxesA[0], "next"); await wait(1.0)
        let boxesA2 = columnBoxes(), statesA2 = await states(boxesA2)
        report("a click on a session link in a column does not navigate that column", resultA == "prevented" && statesA2[0] == statesA[0] && boxesA2[0] === boxesA[0] && boxesA2[0]?.phase == .ready,
               "click=\(resultA) before=\(statesA[0].suffix(40)) after=\(statesA2[0].suffix(40))")
        report("... a session that is already open keeps its column: no column is added or replaced", opened() == sessA && sameViews(boxesA, boxesA2, [0, 1, 2]), "columns=\(tails(opened())) want=\(tails(sessA))")
        report("... the column that has it is highlighted once, the clicked column is not, and no page moved", flash(j) == flashJ + 1 && flash(0) == flash0 && statesA2 == statesA, "flash \(flashJ) -> \(flash(j)) clicked \(flash0) -> \(flash(0)) same states=\(statesA2 == statesA)")

        // B. Not open, and a column is free: the free column is used first.
        if let q = model.watch.layout.index(of: l0) { model.watch.close(column: q) }
        if model.watch.layout.openCount == model.watch.count { model.watch.close(column: 2) }
        await wait(0.4)
        guard let free = model.watch.layout.slots.firstIndex(where: { $0 == nil }) else { report("a free column (setup)", false, "columns=\(tails(opened()))"); return }
        let boxesB = columnBoxes(), statesB = await states(boxesB), sessB = opened()
        let resultB = await click(boxesB[0], "later"); await settle(15)
        let boxesB2 = columnBoxes(), statesB2 = await states(boxesB2)
        var wantB = sessB; wantB[free] = l0
        let keep = [0, 1, 2].filter { boxesB[$0] != nil }
        report("a link to a session that is not shown goes into the free column", resultB == "prevented" && opened() == wantB && boxesB2[free] != nil, "free=\(free) columns=\(tails(opened())) want=\(tails(wantB))")
        report("... the clicked column did not navigate and the other columns keep their web views and pages", statesB2[0] == statesB[0] && sameViews(boxesB, boxesB2, keep) && keep.allSatisfy { statesB2[$0] == statesB[$0] },
               "kept=\(keep) same states=\(keep.map { statesB2[$0] == statesB[$0] })")

        // C. Every column taken, and the clicked column is the least recently used: the clicked one is spared, and the next oldest is replaced.
        if let q = model.watch.layout.index(of: l0) { model.watch.close(column: q) }
        for s in withSession.compactMap(\.sessionID) where model.watch.layout.openCount < model.watch.count && model.watch.layout.index(of: s) == nil && s != l0 && s != n0 { model.watch.open(session: s) }
        await settle(15)
        guard model.watch.layout.openCount == model.watch.count, model.watch.layout.index(of: l0) == nil, let id1 = model.watch.layout.slots[1]?.id, let id2 = model.watch.layout.slots[2]?.id else { report("every column taken and the linked session not shown (setup)", false, "columns=\(tails(opened()))"); return }
        model.watch.used(columnID: id1); model.watch.used(columnID: id2)      // the first column is now the least recently used, then the second
        let lruBefore = model.watch.layout.leastRecentlyUsed
        let boxesC = columnBoxes(), statesC = await states(boxesC), sessC = opened()
        let loadsC1 = boxesC[1]?.pinsLoaded ?? -9      // a number, not the box: the box is the same one afterwards
        let resultC = await click(boxesC[0], "later"); await settle(15)
        let boxesC2 = columnBoxes(), statesC2 = await states(boxesC2)
        var wantC = sessC; wantC[1] = l0
        report("with every column taken a link replaces the least recently used column other than the one clicked, even when the clicked one is the oldest",
               lruBefore == 0 && resultC == "prevented" && opened() == wantC, "lruBefore=\(lruBefore.map(String.init) ?? "-") columns=\(tails(opened())) want=\(tails(wantC))")
        report("... the clicked column did not navigate; the replaced column kept its web view and loaded the new session; the third is untouched",
               statesC2[0] == statesC[0] && sameViews(boxesC, boxesC2, [0, 1, 2]) && boxesC2[1]?.pinsLoaded == loadsC1 + 1 && statesC2[2] == statesC[2],
               "clicked same=\(statesC2[0] == statesC[0]) views=\(sameViews(boxesC, boxesC2, [0, 1, 2])) loads \(loadsC1) -> \(boxesC2[1]?.pinsLoaded ?? -1) third same=\(statesC2[2] == statesC[2])")
        await shot("watch-session-link-replaced.png")

        // D. Cmd-click: leave Watch and show the normal reader on that session.
        let boxesD = columnBoxes(), sessD = opened()
        let target = await ref(boxesD[0], "next")
        let resultD = await click(boxesD[0], "next", meta: true); await wait(1.2)
        report("a Cmd-click on a session link leaves Watch: the columns are let go and the normal reader is loaded", resultD == "prevented" && !model.watchOn && model.watch.boxes.isEmpty && model.web.readerBox != nil,
               "click=\(resultD) watchOn=\(model.watchOn) columnViews=\(model.watch.boxes.count) readerBox=\(model.web.readerBox == nil ? "nil" : "present")")
        if let r = model.web.readerBox { await ReaderPinCheck.settled(r, wait: wait) }
        let landed = await ReaderPinCheck.until("#s=\(target)", wait: wait) { model.web.readerBox == nil ? "-" : await js(model.web.readerBox!, "location.hash") }
        report("... and the reader is pinned to the session the link names (not to the selected agent), on the Reader pane", landed.value == "#s=\(target)" && model.webTab == .reader && model.showWeb,
               "hash=\(landed.value.suffix(16)) want=\(target.suffix(16)) tab=\(model.webTab.rawValue) after \(landed.ms) ms")
        await wait(1.0)      // the selected agent's own pin (debounced) must not take the reader away again
        let stays = model.web.readerBox == nil ? "-" : await js(model.web.readerBox!, "location.hash")
        report("... and stays there: the selected agent's own pin does not take it back", stays == "#s=\(target)", "hash=\(stays.suffix(16))")
        report("... the columns' sessions are kept for the next Watch", model.watch.layout.sessions == sessD, "columns=\(tails(model.watch.layout.sessions)) want=\(tails(sessD))")

        // E. In the full reader the same link is the page's own: Conn neither injects its handler nor takes the click.
        if let rb = model.web.readerBox {
            let injected = await js(rb, "String(window.__connSessionLinks)")
            let next = await ref(rb, "next")
            let resultE = await click(rb, "next")
            let navigated = await ReaderPinCheck.until("#s=\(next)", wait: wait) { await js(rb, "location.hash") }
            report("in the full reader a session link is left to the page: Conn's handler is not there, the click is not taken, the page follows its own link and Watch stays off",
                   injected == "undefined" && !next.isEmpty && resultE == "not prevented" && navigated.value == "#s=\(next)" && !model.watchOn,
                   "handler=\(injected) click=\(resultE) hash=\(navigated.value.suffix(16)) want=\(next.suffix(16)) watchOn=\(model.watchOn)")
        } else { report("the full reader is there to check its session link", false, "readerBox=nil") }

        model.watchOn = true; await settle(15)
    }

    // MARK: the real reader's lite page, read only

    /// The agent rows' open asks while Watch is on (real reader): the full Reader page is unloaded, so the asks must come through a
    /// column's lite page, and a click on the top ask row must put that conversation in a column on the asking reply.
    static func liveAsks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, settle: (Double) async -> Void, js: (WebBox, String) async -> String) async {
        let store = model.openAsks
        model.wireWatchAsks()      // the checks above ran with no ask turn (every column at its newest turn); this one runs on the app's own switch
        let unloaded = model.web.readerBox == nil
        let feed = await model.web.fetchOpenAsks()
        let pages = model.web.extraReaderPages()?.count ?? -1
        report("Watch on, full Reader page unloaded: the open asks are still answered, through a column's lite page", unloaded && model.web.readerBox == nil && feed != nil && pages > 0,
               "readerBox=\(model.web.readerBox == nil ? "unloaded" : "loaded") liteViews=\(pages) feedAsks=\(feed?.asks.count ?? -1)")
        let before = store.polls
        store.refresh()
        var n = 0
        while store.polls == before && n < 20 { await wait(0.25); n += 1 }
        await wait(2)
        let visible = store.visible()
        print("ui-check: info Watch asks from the lite pages: polls=\(store.polls) answered=\(store.lastAnswerGood.map(String.init) ?? "none") storeAsks=\(store.asks.byPane.count) visibleUnder24h=\(visible.count) readerBox=\(model.web.readerBox == nil ? "unloaded" : "loaded")")
        report("the store is answered while Watch is on, and the full Reader page stays unloaded", store.lastAnswerGood == true && model.web.readerBox == nil, "polls=\(store.polls)")
        let order = model.agentOrder.map(\.id)
        guard let top = order.compactMap({ id in visible[id].flatMap { a in model.snapshot.agent(id).map { ($0, a) } } }).first else { print("ui-check: info no live agent has an open ask under 24 hours; the Watch click was not tried"); return }
        let (agent, ask) = top
        let openBefore = model.watch.layout.slots.compactMap { $0 }.first { $0.session == ask.session }.flatMap { model.watch.boxes[$0.id] }
        let inPlaceBefore = openBefore?.pinsInPlace ?? 0, loadsBefore = openBefore?.pinsLoaded ?? 0
        model.sidebarOpenAgent(agent)
        let column = model.watch.layout.slots.compactMap { $0 }.first { $0.session == ask.session }
        let box = column.flatMap { model.watch.boxes[$0.id] }
        // The outline fades after about 3 seconds: look for it often, and keep the first sighting.
        var msg = ""
        var looks = 0
        var timeline: [String] = []
        while msg.isEmpty && looks < 24, let b = box {
            await wait(0.25); looks += 1
            msg = await js(b, "(document.querySelector('.is-linked')||{dataset:{}}).dataset.msg||''")
            timeline.append(await js(b, "location.hash.slice(0,24) + '/' + Math.round(scrollY) + '/' + document.readyState"))
        }
        print("ui-check: info Watch click timeline: \(timeline.enumerated().filter { $0.offset % 3 == 0 }.map(\.element))")
        let want = ask.message ?? ""
        var probe = "-"
        if let b = box, !want.isEmpty { probe = await js(b, "(() => { const els = [...document.querySelectorAll('[data-msg]')]; return 'turns=' + els.length + ' hasAsk=' + els.some(e => (e.dataset.msg || '').startsWith('\(want.prefix(12))')) + ' linked=' + document.querySelectorAll('.is-linked').length + ' notFound=' + document.body.innerText.includes('was not found in this conversation') + ' hash=' + location.hash.slice(0, 40) + ' askNodes=' + els.filter(e => (e.dataset.msg || '').startsWith('\(want.prefix(12))')).map(e => e.dataset.msg.slice(-8) + ':' + e.className + ':' + Math.round(e.getBoundingClientRect().top)).join('|') + ' scrollY=' + Math.round(scrollY) })()") }
        var follows = "-"
        if let b = box { follows = await js(b, "String(window.__connFollowsAddress)") }
        print("ui-check: info Watch click path: alreadyOpen=\(openBefore != nil) inPlace \(inPlaceBefore)->\(box?.pinsInPlace ?? -1) loads \(loadsBefore)->\(box?.pinsLoaded ?? -1) follows=\(follows)")
        print("ui-check: info Watch click probe: \(probe) phase=\(box.map { String(describing: $0.phase) } ?? "-")")
        print("ui-check: info Watch click: askAge=\(ask.at.map { Int(store.now.timeIntervalSince($0)) } ?? -1)s pane=\(agent.id) column=\(column.map { String($0.session.prefix(8)) } ?? "none") outlined=\(msg.prefix(12)) wanted=\(want.prefix(12)) reader=\(model.web.readerBox == nil ? "unloaded" : "loaded")")
        report("a click on the top ask row in Watch puts that conversation in a column on the asking reply", column != nil && !msg.isEmpty && (want.isEmpty || msg.hasPrefix(want)) && model.web.readerBox == nil, "outlined=\(msg.prefix(12)) wanted=\(want.prefix(12))")
    }

    static func liveChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, settle: (Double) async -> Void, js: (WebBox, String) async -> String) async {
        let boxes = model.watch.layout.slots.compactMap { $0.flatMap { model.watch.boxes[$0.id] } }
        // The lite page is a normal reader page: it draws a conversation, or says why it cannot.
        var states: [String] = []
        for b in boxes { states.append(await js(b, "(document.getElementById('main')||document.body).children.length > 0 ? 'drawn' : 'empty'")) }
        report("each column's lite page drew something", states.allSatisfy { $0 == "drawn" }, "states=\(states)")
        await liveAsks(model: model, report: report, wait: wait, settle: settle, js: js)
        // The address with a turn id: when the reader's feed names an open ask, a column opened on it scrolls to and outlines that reply.
        let glance = URL(fileURLWithPath: NSHomeDirectory() + "/workspace/pmos/setup/transcript-reader/out/glance.json")
        guard let data = try? Data(contentsOf: glance), let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let convs = root["conversations"] as? [[String: Any]] else { print("ui-check: SKIP lite page with &m= (no glance feed)"); return }
        let live = Set(model.snapshot.agents.compactMap(\.sessionID))
        guard let c = convs.first(where: { ($0["open_asks"] as? Int ?? 0) > 0 && (($0["ask"] as? [String: Any])?["uid"] as? String) != nil && live.contains(($0["id"] as? String) ?? "") }),
              let sid = c["id"] as? String, let uid = (c["ask"] as? [String: Any])?["uid"] as? String else { print("ui-check: SKIP lite page with &m= (no open ask on a live agent)"); return }
        model.watch.openAskTurnID = { $0 == sid ? uid : nil }
        let placement = model.watch.open(session: sid)
        await settle(25)
        guard let col = placement.map({ model.watch.layout.slots[$0.column]! }), let b = model.watch.boxes[col.id] else { report("the lite page opens on an asking reply", false, "no column"); return }
        await wait(2)
        let msg = await js(b, "(document.querySelector('.is-linked')||{dataset:{}}).dataset.msg||''")
        report("the lite page, opened with &m=<turn id> from the reader's feed, scrolls to and outlines that reply", !msg.isEmpty, "outlined turn=\(msg.prefix(12)) wanted=\(uid.prefix(12)) placement=\(String(describing: placement))")
        model.wireWatchAsks()
    }
}
