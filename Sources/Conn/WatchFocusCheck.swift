// `--ui-check` steps for Watch focus (README "Watch view", "Hiding a column"): a column's content is blurred by its control and shown by the same one; a hidden session whose turn
// ends leaves a cue that stays; showing it lands on the reply that turn ended with; hidden columns and the cue are kept across a Conn quit. Fixture only: the stand-in Herdr's
// agents (their states are moved with its `fake.set_state`) and the invented lite page, which marks its replies as the reader does (`data-msg="<turn id>:reply"`).
//
//   CONN_UI_CHECK_ONLY=watch-focus ./run.sh --fixture --ui-check            the steps in one launch (also part of the full --ui-check)
//   CONN_UI_CHECK_ONLY=watch-focus-write CONN_UI_CHECK_HANDOFF=FILE ./run.sh --fixture --ui-check
//   CONN_UI_CHECK_ONLY=watch-focus-read  CONN_UI_CHECK_HANDOFF=FILE ./run.sh --fixture --ui-check
//       two launches in a row (a real relaunch: the first leaves a hidden column with a cue and one hidden with none in the test settings, the second reads them back)
import SwiftUI
import WebKit
import ConnCore

@MainActor
enum WatchFocusCheck {
    static func tails(_ l: [String?]) -> [String] { l.map { $0.map { String($0.suffix(4)) } ?? "-" } }
    static func turn(_ sid: String, _ k: Int) -> String { "t-\(String(format: "%04d", WatchCheck.tail(sid)))-\(String(format: "%02d", k))" }

    private static func fake(_ model: AppModel, _ method: String, _ params: [String: Any]) -> Bool {
        guard let sock = UnixLineSocket(path: model.endpoint.socketPath) else { return false }
        defer { sock.close() }
        guard sock.writeLine(["id": "check", "method": method, "params": params]), let reply = sock.readJSON(timeout: 5) else { return false }
        return reply["error"] == nil
    }

    static func shot(_ name: String) async {
        if let d = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] { await Capture.window(to: URL(fileURLWithPath: d).appendingPathComponent(name)) }
    }

    static func settle(_ model: AppModel, wait: (Double) async -> Void, timeout: Double = 20) async {
        var t = 0.0
        while t < timeout, !(model.watch.boxes.count >= model.watch.layout.openCount && model.watch.boxes.values.allSatisfy { $0.phase == .ready && $0.hideApplied }) { await wait(0.25); t += 0.25 }
        await wait(0.6)
    }

    /// What the page says about itself: the style on its root and whether it takes clicks.
    static func pageState(_ b: WebBox?) async -> (blurred: Bool, inert: Bool, clicks: Bool) {
        guard let b = b else { return (false, false, true) }
        let r = await ReaderPinCheck.js(b, "(() => { const s = getComputedStyle(document.documentElement); return [s.filter.indexOf('blur') >= 0, !!(document.body && document.body.inert), s.pointerEvents !== 'none'].join(','); })()")
        let p = r.split(separator: ",").map(String.init)
        return p.count == 3 ? (p[0] == "true", p[1] == "true", p[2] == "true") : (false, false, true)
    }

    // MARK: one launch

    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture, model.endpoint.isStandIn else { print("ui-check: SKIP Watch focus (needs the stand-in Herdr: the checks move its agents' states)"); return }
        let saved = (count: model.watch.count, mode: model.mode, web: model.showWeb, tab: model.webTab)
        let agents = model.snapshot.prioritized.filter { $0.sessionID != nil }
        guard let a = agents.first(where: { $0.state == .working }), let b = agents.first(where: { $0.state == .idle && $0.id != a.id }), let c = agents.first(where: { $0.state == .idle && $0.id != a.id && $0.id != b.id }),
              let sa = a.sessionID, let sb = b.sessionID, let sc = c.sessionID else { report("Watch focus: a working agent and two idle ones with a conversation", false, "agents=\(agents.count)"); return }
        let first = (a: a.state, b: b.state, c: c.state)
        defer {
            for (id, s) in [(a.id, first.a), (b.id, first.b), (c.id, first.c)] { _ = fake(model, "fake.set_state", ["pane_id": id, "state": s.rawValue]) }
            model.watchOn = false; model.watch.forgetEverything(); model.setWatchCount(saved.count); model.mode = saved.mode; model.showWeb = saved.web; model.webTab = saved.tab
        }
        func until(_ timeout: Double, _ done: () -> Bool) async { var t = 0.0; while !done() && t < timeout { await wait(0.1); t += 0.1 } }
        func set(_ id: String, _ s: AgentState) async { _ = fake(model, "fake.set_state", ["pane_id": id, "state": s.rawValue]); await until(6) { model.snapshot.agent(id)?.state == s } }
        func box(_ i: Int) -> WebBox? { model.watch.layout.slots[i].flatMap { model.watch.boxes[$0.id] } }
        func column(_ i: Int) -> WatchColumn? { model.watch.layout.slots[i] }
        func flashes(_ i: Int) -> Int { column(i).flatMap { model.watch.flashes[$0.id] } ?? 0 }
        func js(_ i: Int, _ s: String) async -> String { guard let b = box(i) else { return "-" }; return await ReaderPinCheck.js(b, s) }
        func outlined(_ i: Int) async -> String { await js(i, "((document.querySelector('.is-linked')||{dataset:{}}).dataset.msg||'').replace(/:reply$/,'')") }
        func below(_ i: Int, _ msg: String) async -> Int { Int(await js(i, "(() => { const n = document.querySelector('[data-msg=\"\(msg):reply\"]'); const h = document.querySelector('header'); return n ? String(Math.round(n.getBoundingClientRect().top - (h ? h.offsetHeight : 0))) : '-999'; })()")) ?? -999 }
        func atBottom(_ i: Int) async -> Bool { await js(i, "String(window.innerHeight + window.scrollY >= document.body.scrollHeight - 4)") == "true" }

        model.mode = .agent; model.showWeb = true; model.webTab = .reader
        model.watch.openAskTurnID = { _ in nil }
        model.watch.forgetEverything()
        model.setWatchCount(3); model.watchOn = true; await settle(model, wait: wait)
        model.watch.emptyColumns()
        for s in [sa, sb, sc] { model.watch.open(session: s) }
        await settle(model, wait: wait)
        guard model.watch.layout.sessions == [sa, sb, sc], (0...2).allSatisfy({ box($0) != nil }) else { report("Watch focus: three columns showing the three agents", false, "columns=\(tails(model.watch.layout.slots.map { $0?.session }))"); return }

        // 1. The control hides a column's content and shows it again; the other columns are not touched.
        let before = await pageState(box(0))
        let hid = model.watch.toggleHidden(column: 0)
        await settle(model, wait: wait)
        let after = await pageState(box(0)), others = [await pageState(box(1)), await pageState(box(2))]
        report("the hide control blurs the column's page and the page takes no click or key; the other columns are untouched",
               hid == true && model.watch.isHidden(column(0)!) && !before.blurred && after.blurred && after.inert && !after.clicks && others.allSatisfy { !$0.blurred && $0.clicks } && !model.watch.isHidden(column(1)!),
               "returned=\(String(describing: hid)) before=\(before) after=\(after) others=\(others)")
        await shot("watch-focus-1-hidden.png")

        // 2. A session that was working when hidden: no cue while it works; its turn ends and the cue comes once it has stayed stopped.
        await wait(0.8)
        report("while the hidden session is still working there is no cue", model.watch.cue(column(0)!) == nil && model.watch.isHidden(column(0)!), "cue=\(String(describing: model.watch.cue(column(0)!)))")
        let flash0 = flashes(0)
        await set(a.id, .idle)
        report("the turn has just ended: the cue waits for the session to stay stopped", model.watch.cue(column(0)!) == nil, "cue=\(String(describing: model.watch.cue(column(0)!)))")
        await until(8) { model.watch.cue(column(0)!) != nil }
        report("a few seconds later the column carries the cue \"finished\", highlighted once", model.watch.cue(column(0)!) == .finished && flashes(0) == flash0 + 1 && model.watch.cueTime(column(0)!) != nil,
               "cue=\(String(describing: model.watch.cue(column(0)!))) flash \(flash0) -> \(flashes(0))")
        await shot("watch-focus-2-cue.png")

        // 3. A pause between two tool calls is not a turn ending.
        _ = model.watch.toggleHidden(column: 1)
        await set(b.id, .working); await wait(0.5); await set(b.id, .idle); await wait(1.0); await set(b.id, .working)
        await wait(WatchAttention.settle + 1.2)
        report("a session that stops for a moment and works again raises no cue", model.watch.isHidden(column(1)!) && model.watch.cue(column(1)!) == nil, "cue=\(String(describing: model.watch.cue(column(1)!)))")
        await set(b.id, .done)
        await until(8) { model.watch.cue(column(1)!) != nil }
        report("... and when it does stop for good the cue comes", model.watch.cue(column(1)!) == .finished, "cue=\(String(describing: model.watch.cue(column(1)!)))")

        // 4. A turn that ends on a question says the session needs the person.
        _ = model.watch.toggleHidden(column: 2)
        await set(c.id, .working); await wait(0.4); await set(c.id, .blocked)
        await until(8) { model.watch.cue(column(2)!) != nil }
        report("a turn that ends waiting on the person raises the cue \"needs you\"", model.watch.cue(column(2)!) == .needsYou, "cue=\(String(describing: model.watch.cue(column(2)!)))")
        await shot("watch-focus-3-three-hidden.png")

        // 5. What is kept: session ids and the cue, no text.
        let stored = AppModel.defaults.data(forKey: WatchModel.hiddenKey)
        let kept = WatchAttention.decode(stored)
        let text = stored.map { String(decoding: $0, as: UTF8.self) } ?? ""
        report("the hidden sessions and their cues are written to Conn's settings, and nothing from any conversation",
               kept.isHidden(sa) && kept.isHidden(sb) && kept.isHidden(sc) && kept.cue(for: sa) == .finished && kept.cue(for: sc) == .needsYou && !text.contains("Turn ") && !text.contains("Notes in"),
               "hidden=\(kept.holds.count) cues=\(kept.holds.values.compactMap(\.cue).map(\.rawValue)) bytes=\(stored?.count ?? 0)")

        // 6. Leaving Watch and coming back: the same columns are hidden, their pages blurred before they are drawn, the cues still up.
        model.watchOn = false; await wait(0.8)
        model.watchOn = true; await settle(model, wait: wait)
        let back = await [pageState(box(0)), pageState(box(1)), pageState(box(2))]
        report("after leaving Watch and coming back the columns are still hidden (pages blurred) and the cues are still there",
               back.allSatisfy { $0.blurred && !$0.clicks } && model.watch.cue(column(0)!) == .finished && model.watch.cue(column(1)!) == .finished && model.watch.cue(column(2)!) == .needsYou && (0...2).allSatisfy { box($0)?.hideApplied == true },
               "pages=\(back) cues=\((0...2).map { model.watch.cue(column($0)!)?.rawValue ?? "-" })")

        // 7. Showing a column with a cue lands it on the reply that turn ended with (just under the header, outlined), and the blur is lifted after it has moved.
        let scrollHidden = await js(0, "String(Math.round(scrollY))")
        let landings0 = box(0)?.landings ?? -1
        let shown = model.watch.toggleHidden(column: 0)
        report("showing the column hands the cue back: no cue, no longer hidden", shown == false && !model.watch.isHidden(column(0)!) && model.watch.cue(column(0)!) == nil, "returned=\(String(describing: shown))")
        await until(8) { !(box(0)?.contentHidden ?? true) }
        await wait(0.6)
        let want = turn(sa, 12)
        let landed = await outlined(0), off = await below(0, want), bottom = await atBottom(0)
        let now = await pageState(box(0))
        report("... the page lands on that turn's reply, outlined, and the blur is gone and the page takes clicks again",
               box(0)?.landings == landings0 + 1 && box(0)?.lastLanded == want && landed == want && (abs(off - 8) <= 24 || bottom) && !now.blurred && !now.inert && now.clicks,
               "landings \(landings0) -> \(box(0)?.landings ?? -1) landed=\(box(0)?.lastLanded ?? "-") outlined=\(landed) below header=\(off) atBottom=\(bottom) page=\(now) scrollY \(scrollHidden)")
        await shot("watch-focus-4-landed.png")

        // 8. Hiding and showing with no turn ended in between moves nothing.
        let scroll1 = await js(0, "String(Math.round(scrollY))")
        _ = model.watch.toggleHidden(column: 0); await settle(model, wait: wait)
        _ = model.watch.toggleHidden(column: 0); await wait(0.8)
        let scroll2 = await js(0, "String(Math.round(scrollY))")
        report("hiding a column and showing it with no turn ended in between does not move the page or land on anything", box(0)?.landings == landings0 + 1 && scroll1 == scroll2 && !model.watch.isHidden(column(0)!), "scrollY \(scroll1) -> \(scroll2) landings=\(box(0)?.landings ?? -1)")

        // 9. A column that is closed or replaced is no longer hidden.
        model.watch.close(column: 2)
        report("closing a hidden column forgets it", !model.watch.attention.isHidden(sc) && !WatchAttention.decode(AppModel.defaults.data(forKey: WatchModel.hiddenKey)).isHidden(sc), "stillHidden=\(model.watch.attention.isHidden(sc))")
        let other = agents.first { $0.sessionID != nil && ![sa, sb, sc].contains($0.sessionID!) }!.sessionID!
        model.watch.open(session: other)
        let replaced = model.watch.layout.index(of: other)
        let freshState = await pageState(replaced.flatMap { box($0) })
        report("a session that opens in a column is not hidden because an earlier one there was", replaced != nil && !model.watch.isHidden(column(replaced!)!) && !freshState.blurred, "column=\(replaced.map(String.init) ?? "-") page=\(freshState)")

    }

    /// A Campus conversation in a column: the same control, the state Campus reports (moved by a stand-in so the check does not wait for the stand-in's own runs), the same cue, and showing it lands.
    static func campusSteps(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, conversation id: String) async {
        func until(_ timeout: Double, _ done: () -> Bool) async { var t = 0.0; while !done() && t < timeout { await wait(0.1); t += 0.1 } }
        let key = CampusColumn.key(id)
        model.watch.openCampus(id)
        guard let i = model.watch.layout.index(of: key), let col = model.watch.layout.slots[i] else { report("a Campus conversation opens in a column", false, "columns=\(tails(model.watch.layout.slots.map { $0?.session }))"); return }
        let wired = model.watch.stateOf
        var state: AgentState = .working
        model.watch.stateOf = { $0 == key ? state : wired($0) }
        defer { model.watch.stateOf = wired }
        await wait(0.8)
        let hid = model.watch.toggleHidden(column: i)
        let lands0 = model.watch.lands[key] ?? 0
        await wait(0.6)
        // With the reader's embed page loaded in this column (a file copy, `CONN_EMBED_URL`) its page is blurred like a reader column's.
        let embed = CampusEmbedBox.live.allObjects.first { $0.column == i && $0.phase == .ready }
        if let e = embed {
            let hidden = (try? await e.webView.evaluateJavaScript("getComputedStyle(document.documentElement).filter.indexOf('blur') >= 0 && document.body.inert === true")) as? Bool ?? false
            report("... a Campus column's embed page is blurred and takes no click or key", hidden && e.contentHidden && e.hideApplied, "page=\(hidden) box=\(e.contentHidden)")
        }
        await shot("watch-focus-6-campus-hidden.png")
        state = .idle
        model.watch.observeStates()
        await until(8) { model.watch.cue(col) != nil }
        report("a Campus column hides by the same control and raises the cue when the conversation's turn ends", hid == true && model.watch.cue(col) == .finished, "hid=\(String(describing: hid)) cue=\(String(describing: model.watch.cue(col)))")
        let landed0 = embed?.landings ?? 0
        let shown = model.watch.toggleHidden(column: i)
        await wait(1.0)
        report("... and showing it asks the transcript to land on its newest reply", shown == false && !model.watch.isHidden(col) && (model.watch.lands[key] ?? 0) == lands0 + 1, "lands \(lands0) -> \(model.watch.lands[key] ?? 0)")
        if let e = embed {
            let cleared = (try? await e.webView.evaluateJavaScript("getComputedStyle(document.documentElement).filter === 'none' && document.body.inert === false")) as? Bool ?? false
            report("... on the embed page the newest reply is outlined and the blur is gone", cleared && !e.contentHidden && e.landings == landed0 + 1, "cleared=\(cleared) landings \(landed0) -> \(e.landings)")
        }
    }

    // MARK: a relaunch

    struct Handoff: Codable { var withCue: String; var quiet: String; var other: String }
    static func handoffURL() -> URL? { ProcessInfo.processInfo.environment["CONN_UI_CHECK_HANDOFF"].map { URL(fileURLWithPath: $0) } }

    /// Launch one: two columns hidden, one with a cue (its turn ended while hidden) and one with none, a third column in plain view; then quit with all of it in the settings.
    static func writeLaunch(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture, model.endpoint.isStandIn, let url = handoffURL() else { report("Watch focus (launch 1): a stand-in Herdr and a hand-off file", false, "missing"); return }
        let agents = model.snapshot.prioritized.filter { $0.sessionID != nil }
        guard let a = agents.first(where: { $0.state == .working }), let b = agents.first(where: { $0.state == .idle && $0.id != a.id }), let c = agents.first(where: { $0.state == .idle && $0.id != a.id && $0.id != b.id }),
              let sa = a.sessionID, let sb = b.sessionID, let sc = c.sessionID else { report("Watch focus (launch 1): agents", false, ""); return }
        model.mode = .agent; model.showWeb = true; model.webTab = .reader
        model.watch.openAskTurnID = { _ in nil }
        model.watch.forgetEverything()
        model.setWatchCount(3); model.watchOn = true; await settle(model, wait: wait)
        model.watch.emptyColumns()
        for s in [sa, sb, sc] { model.watch.open(session: s) }
        await settle(model, wait: wait)
        _ = model.watch.toggleHidden(column: 0); _ = model.watch.toggleHidden(column: 1)
        _ = fake(model, "fake.set_state", ["pane_id": a.id, "state": "idle"])
        var t = 0.0
        while t < 9, model.watch.cue(model.watch.layout.slots[0]!) == nil { await wait(0.1); t += 0.1 }
        let wrote = (try? JSONEncoder().encode(Handoff(withCue: sa, quiet: sb, other: sc))).flatMap { try? $0.write(to: url) } != nil
        report("launch 1 left two hidden columns, the first with a cue and the second with none, and a third in plain view",
               wrote && model.watch.cue(model.watch.layout.slots[0]!) == .finished && model.watch.isHidden(model.watch.layout.slots[1]!) && model.watch.cue(model.watch.layout.slots[1]!) == nil && !model.watch.isHidden(model.watch.layout.slots[2]!),
               "wrote=\(wrote) cue=\(model.watch.cue(model.watch.layout.slots[0]!)?.rawValue ?? "-")")
        model.watchOn = false
        // Quit with everything in place: this launch's settings are the next launch's start.
    }

    /// Launch two: the settings hold what launch one left. Watch turned on shows the same columns hidden (their pages blurred before they are drawn) and the cue still on the first;
    /// showing that column lands on the last reply, and the one hidden with no cue stays hidden.
    static func readLaunch(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture, let url = handoffURL(), let data = try? Data(contentsOf: url), let h = try? JSONDecoder().decode(Handoff.self, from: data) else { report("Watch focus (launch 2): a hand-off file from launch 1", false, "missing or unreadable"); return }
        model.mode = .agent; model.showWeb = true; model.webTab = .reader
        model.watch.openAskTurnID = { _ in nil }
        report("launch 2 starts with the two sessions hidden and the cue on the first, before Watch is turned on", model.watch.attention.isHidden(h.withCue) && model.watch.attention.isHidden(h.quiet) && !model.watch.attention.isHidden(h.other) && model.watch.attention.cue(for: h.withCue) == .finished,
               "hidden=\(model.watch.attention.holds.count)")
        model.watchOn = true; await settle(model, wait: wait)
        func box(_ i: Int) -> WebBox? { model.watch.layout.slots[i].flatMap { model.watch.boxes[$0.id] } }
        let pages = await [pageState(box(0)), pageState(box(1)), pageState(box(2))]
        report("Watch turned on shows the same columns hidden (pages blurred, no clicks) and the other one in plain view",
               model.watch.layout.sessions == [h.withCue, h.quiet, h.other] && pages[0].blurred && pages[1].blurred && !pages[2].blurred && !pages[0].clicks && pages[2].clicks,
               "columns=\(tails(model.watch.layout.slots.map { $0?.session })) pages=\(pages)")
        await shot("watch-focus-5-after-relaunch.png")
        _ = model.watch.toggleHidden(column: 0)
        var t = 0.0
        while t < 8, box(0)?.contentHidden ?? false { await wait(0.1); t += 0.1 }
        await wait(0.6)
        var landed = "-"
        if let b = box(0) { landed = await ReaderPinCheck.js(b, "((document.querySelector('.is-linked')||{dataset:{}}).dataset.msg||'').replace(/:reply$/,'')") }
        report("showing the first column after the relaunch lands on its last reply", box(0)?.lastLanded == turn(h.withCue, 12) && landed == turn(h.withCue, 12) && model.watch.attention.isHidden(h.quiet), "landed=\(box(0)?.lastLanded ?? "-") outlined=\(landed)")
    }
}
