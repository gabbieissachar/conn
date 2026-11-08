// `--ui-check` steps for every way a person leaves Watch for the Editor view and comes back (README "Watch setups"): the same column count and the same session in
// each column, in order, whichever way out and whichever way back. Fixture only (the stand-in Herdr, the invented lite page, a stand-in folder with two small files).
//
// Ways in, each driven the way the app reaches it: a click on a file link in a column, a click on the Documents view's file button in a column (both are real click events
// in the page, so the injected script, the message handler and the path check run), `conn <path>` (the same call Finder's Open With and a drop on the window make; Cmd+O
// ends in it too, after a panel no check can answer), the toolbar's View picker, and two menu items that show the Editor (File > New Document, Layout > Editor; Open Folder, Go to File, the Explorer and the tab items
// set the same view the same way before they act).
// Ways back: the toolbar's Watch button, Shift+Cmd+W, Layout > Watch Several Sessions, and a click on an agent in the sidebar while away followed by the toolbar button.
// Every trip is also made twice in a row, the second from wherever the first left the window (Watch back on over the Editor view).
//
//   CONN_UI_CHECK_ONLY=watch-trips ./run.sh --fixture --ui-check                 the steps in one launch (also part of the full --ui-check)
//   CONN_UI_CHECK_ONLY=watch-trips-write CONN_UI_CHECK_HANDOFF=FILE CONN_UI_CHECK_QUIT=editor|watch ./run.sh --fixture --ui-check
//   CONN_UI_CHECK_ONLY=watch-trips-read  CONN_UI_CHECK_HANDOFF=FILE CONN_UI_CHECK_QUIT=editor|watch ./run.sh --fixture --ui-check
//       two launches in a row: the first leaves a setup, goes to the Editor view and quits there (or quits with Watch on); the second is the relaunch
import SwiftUI
import WebKit
import ConnCore

@MainActor
enum WatchTripsCheck {
    // MARK: the pieces

    @MainActor
    struct Kit {
        let model: AppModel
        let wait: (Double) async -> Void
        let notes: URL, plan: URL

        var slots: [String?] { model.watch.layout.slots.map { $0?.session } }
        var loaded: Bool { model.watch.boxes.count == model.watch.layout.openCount && model.watch.boxes.values.allSatisfy { $0.phase == .ready && !$0.released } }
        var addresses: [String] { model.watch.layout.slots.map { c in c.flatMap { model.watch.boxes[$0.id]?.webView.url?.fragment } ?? "-" } }

        /// Every column's page is ready (or `timeout` passes), then a moment for it to settle.
        func settle(timeout: Double = 20) async {
            var t = 0.0
            while t < timeout, !loaded { await wait(0.1); t += 0.1 }
            await wait(0.35)
        }

        func js(_ box: WebBox, _ s: String) async -> String { await ReaderPinCheck.js(box, s) }
        func jsString(_ s: String) -> String { "'" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'") + "'" }

        /// A real click event on the fixture page's file link (`which` = "link") or Documents button ("button"), pointed at `path`.
        func click(_ b: WebBox, _ which: String, path: String) async -> String {
            await js(b, "(() => { const el = document.querySelector('[data-ref-file=\"\(which)\"]'); if (!el) return 'no element'; el.setAttribute('data-path', \(jsString(path))); return el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 })) ? 'not prevented' : 'prevented'; })()")
        }

        func firstColumn() -> WebBox? { model.watch.layout.slots.compactMap({ $0 }).compactMap({ model.watch.boxes[$0.id] }).first }

        func menuItem(_ menu: String, where match: (NSMenuItem) -> Bool) -> (NSMenu, Int)? {
            guard let sub = NSApp.mainMenu?.items.first(where: { $0.title == menu })?.submenu, let i = sub.items.firstIndex(where: match) else { return nil }
            return (sub, i)
        }
        /// Run a menu item's action through its menu, the way a click on it does.
        @discardableResult
        func perform(_ menu: String, _ title: String) -> Bool {
            guard let (sub, i) = menuItem(menu, where: { $0.title == title }) else { return false }
            sub.performActionForItem(at: i)
            return true
        }
        /// The Watch item of the Layout menu, found by its key (Shift+Cmd+W); its title says "Watch Several Sessions" or "Leave Watch" as the menu was last built.
        func watchMenuItem() -> (NSMenu, Int)? {
            menuItem("Layout") { $0.keyEquivalent.lowercased() == "w" && $0.keyEquivalentModifierMask.intersection([.command, .shift, .option, .control]) == [.command, .shift] }
        }
    }

    static func tails(_ l: [String?]) -> [String] { WatchSetupsCheck.tails(l) }

    // MARK: ways in and ways back

    /// A way to the Editor view from Watch. `file`: the file it opens (the Editor must show it).
    struct Into {
        let name: String
        let file: ((Kit) -> URL)?
        let go: (Kit) async -> Void
    }

    static let ways: [Into] = [
        Into(name: "a click on a file link in a column", file: { $0.notes }) { k in
            guard let b = k.firstColumn() else { return }
            _ = await k.click(b, "link", path: k.notes.path)
        },
        Into(name: "a click on the Documents button (plan.md) in a column", file: { $0.plan }) { k in
            guard let b = k.firstColumn() else { return }
            _ = await k.click(b, "button", path: k.plan.path)
        },
        Into(name: "conn <path> (Finder's Open With, a drop, Cmd+O after its panel)", file: { $0.notes }) { k in k.model.openFromOutside([k.notes]) },
        Into(name: "the toolbar's View picker on Editor", file: nil) { k in k.model.mode = .editor },
        Into(name: "File > New Document", file: nil) { k in k.perform("File", "New Document") },
        Into(name: "Layout > Editor (Opt+Cmd+3)", file: nil) { k in k.perform("Layout", "Editor") },
    ]

    /// A way back to Watch.
    struct Back {
        let name: String
        /// The way may first do something else while away (a click on an agent in the sidebar); `away` is checked before Watch comes back.
        let go: (Kit) async -> Void
    }

    static let returns: [Back] = [
        Back(name: "the toolbar's Watch button") { k in k.model.watchOn = true },
        Back(name: "Shift+Cmd+W") { k in
            if let (m, i) = k.watchMenuItem() { m.performActionForItem(at: i) } else { k.model.watchOn = true }
        },
        Back(name: "Layout > Watch Several Sessions") { k in
            if !k.perform("Layout", "Watch Several Sessions") && !k.perform("Layout", "Leave Watch") { k.model.watchOn = true }
        },
        Back(name: "a click on an agent in the sidebar, then the toolbar's Watch button") { k in
            // The row's click is `select`. The agent is one no column holds, so a column replaced by mistake would show.
            if let a = k.model.snapshot.prioritized.first(where: { a in a.sessionID.map { s in !k.slots.contains { $0 == s } } ?? false }) { k.model.select(a.id) }
            await k.wait(0.4)
            k.model.watchOn = true
        },
    ]

    // MARK: one launch

    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: @escaping (Double) async -> Void) async {
        guard model.config.fixture else { return }
        let saved = (count: model.watch.count, mode: model.mode, web: model.showWeb, tab: model.webTab, agentView: model.agentViewEnabled)
        defer {
            model.watchOn = false; model.watch.forgetEverything(); model.setWatchCount(saved.count)
            for d in model.editor.docs { _ = model.editor.close(d) }
            model.agentViewEnabled = saved.agentView; model.mode = saved.mode; model.showWeb = saved.web; model.webTab = saved.tab
        }
        if let w = Capture.mainWindow() { w.setContentSize(NSSize(width: 1500, height: 900)) }
        guard let sessions = WatchSetupsCheck.pick(model) else { report("Watch trips: enough agents with a conversation", false, "too few"); return }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("conn-ui-check-watchtrips-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let notes = dir.appendingPathComponent("notes.md"), plan = dir.appendingPathComponent("plan.md")
        try? "# Notes\n\nA reader link opens here.\n".write(to: notes, atomically: true, encoding: .utf8)
        try? "# Plan\n\nA Documents button opens here.\n".write(to: plan, atomically: true, encoding: .utf8)
        let k = Kit(model: model, wait: wait, notes: notes, plan: plan)
        func sameFile(_ a: URL?, _ b: URL) -> Bool { a?.resolvingSymlinksInPath().path == b.resolvingSymlinksInPath().path }
        model.watch.openAskTurnID = { _ in nil }
        let mine = [sessions[9], sessions[4], sessions[7]]

        /// Start a configuration: the Agent view on or off, the person's three columns, Watch on.
        func begin(agentView: Bool) async -> (setup: [String?], addresses: [String]) {
            model.watchOn = false
            model.agentViewEnabled = agentView
            model.mode = agentView ? .agent : .herdr; model.showWeb = true; model.webTab = .reader
            await wait(0.3)
            model.watch.forgetEverything()
            model.setWatchCount(3)
            model.watchOn = true; await k.settle()
            for c in (0..<3).reversed() { model.watch.close(column: c) }
            for s in mine { model.watch.open(session: s) }
            await k.settle()
            return (k.slots, k.addresses)
        }

        /// One trip: out by `into`, check the Editor view shows, back by `back`, check the setup. `chained`: the trip starts from wherever the last one ended.
        func trip(_ into: Into, _ back: Back, want: (setup: [String?], addresses: [String]), tag: String) async -> Bool {
            for d in model.editor.docs { _ = model.editor.close(d) }
            if !model.watchOn { model.watchOn = true }
            await k.settle()
            let startMode = model.mode
            let before = k.slots
            await into.go(k)
            await wait(0.7)
            let fileOK = into.file.map { f in sameFile(model.editor.current?.url, f(k)) } ?? true
            let away = model.mode == .editor && !model.watchOn && model.watch.boxes.isEmpty
            let kept = k.slots
            await back.go(k)
            await k.settle()
            let back_ = model.watchOn && k.slots == want.setup && model.watch.count == want.setup.count && k.loaded && k.addresses == want.addresses
            let ok = before == want.setup && away && fileOK && kept == want.setup && back_
            report("\(tag): Watch to the Editor view by \(into.name), back by \(back.name): every column is back, the same session in the same place",
                   ok, "startMode=\(startMode.rawValue) editorShown=\(away) mode=\(model.mode.rawValue) watchOn=\(model.watchOn) file=\(fileOK) before=\(tails(before)) away=\(tails(kept)) after=\(tails(k.slots)) want=\(tails(want.setup)) count=\(model.watch.count) views=\(model.watch.boxes.count)/\(model.watch.layout.openCount) addresses=\(k.addresses.map { String($0.suffix(6)) })")
            return ok
        }

        // The person's own launch: the Agent view is off (the Herdr client view is the first view). Every way in meets every way back.
        var want = await begin(agentView: false)
        report("setup: three columns hold the three sessions picked by hand, in order, on the Herdr client view", want.setup == mine.map { Optional($0) } && model.mode == .herdr && model.watchOn, "slots=\(tails(want.setup)) mode=\(model.mode.rawValue)")
        await WatchSetupsCheck.shot("watch-trips-1-before.png")
        for into in ways { for back in returns { _ = await trip(into, back, want: want, tag: "Agent view off") } }
        await WatchSetupsCheck.shot("watch-trips-2-back-after-editor.png")

        // The same trips twice in a row: the second starts from where the first left the window (Watch on again, over the Editor view).
        want = await begin(agentView: false)
        for into in ways {
            for round in 1...2 { _ = await trip(into, returns[0], want: want, tag: "Agent view off, round \(round) in a row") }
        }

        // The Agent view on (the flag): the way in and the way back from the Agent view.
        want = await begin(agentView: true)
        for into in ways { _ = await trip(into, returns[0], want: want, tag: "Agent view on") }
        for back in returns.dropFirst() { _ = await trip(ways[0], back, want: want, tag: "Agent view on") }

        // The Editor view's own state is not touched by Watch coming and going: the file the trip opened is still the tab shown, nothing unsaved is touched.
        report("the Editor view kept what the trips opened (the notes file is a tab, never lost to Watch coming back)", model.editor.docs.contains { sameFile($0.url, notes) } || model.editor.docs.isEmpty, "tabs=\(model.editor.docs.count)")
        model.watchOn = false
    }

    // MARK: two launches in a row

    /// What launch one leaves for launch two.
    struct Handoff: Codable { var setup: [String?]; var quit: String }

    static func handoffURL() -> URL? { ProcessInfo.processInfo.environment["CONN_UI_CHECK_HANDOFF"].map { URL(fileURLWithPath: $0) } }
    static var quitWhere: String { ProcessInfo.processInfo.environment["CONN_UI_CHECK_QUIT"] == "watch" ? "watch" : "editor" }

    /// Launch one: three columns picked by hand (a free one in the middle), out to the Editor view by a click on a file link in a column, back, and then quit
    /// in the Editor view (`QUIT=editor`, after a second trip out) or with Watch on (`QUIT=watch`).
    static func writeLaunch(model: AppModel, report: (String, Bool, String) -> Void, wait: @escaping (Double) async -> Void) async {
        guard model.config.fixture, let url = handoffURL(), let sessions = WatchSetupsCheck.pick(model) else { report("Watch trips (launch 1): a stand-in Herdr, a hand-off file and enough agents", false, "missing"); return }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("conn-ui-check-watchtrips-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let notes = dir.appendingPathComponent("notes.md"), plan = dir.appendingPathComponent("plan.md")
        try? "# Notes\n".write(to: notes, atomically: true, encoding: .utf8)
        try? "# Plan\n".write(to: plan, atomically: true, encoding: .utf8)
        let k = Kit(model: model, wait: wait, notes: notes, plan: plan)
        model.agentViewEnabled = false
        model.mode = .herdr; model.showWeb = true; model.webTab = .reader
        model.watch.openAskTurnID = { _ in nil }
        model.watch.forgetEverything()
        model.setWatchCount(3); model.watchOn = true; await k.settle()
        model.watch.emptyColumns()
        model.watch.open(session: sessions[9]); model.watch.open(session: sessions[4]); model.watch.open(session: sessions[7]); model.watch.close(column: 1)
        await k.settle()
        let setup = k.slots
        // Out by a file link in a column, back by the toolbar's button: the first round trip.
        if let b = k.firstColumn() { _ = await k.click(b, "link", path: notes.path) }
        await wait(0.7)
        model.watchOn = true; await k.settle()
        let again = k.slots == setup
        if quitWhere == "editor" {
            // Out again, by the Documents button, and quit in the Editor view.
            if let b = k.firstColumn() { _ = await k.click(b, "button", path: plan.path) }
            await wait(0.7)
        }
        let wrote = (try? JSONEncoder().encode(Handoff(setup: setup, quit: quitWhere))).flatMap { try? $0.write(to: url) } != nil
        let where_ = quitWhere == "editor" ? (model.mode == .editor && !model.watchOn) : model.watchOn
        report("launch 1 left three columns with a free middle one, went to the Editor view by a file link and back, and is quitting \(quitWhere == "editor" ? "in the Editor view" : "with Watch on")",
               wrote && setup == [sessions[9], nil, sessions[7]] && again && where_, "setup=\(tails(setup)) back=\(again) where=\(where_) mode=\(model.mode.rawValue) watchOn=\(model.watchOn) wrote=\(wrote)")
        // Quit as it is: this launch's settings are the next launch's start.
    }

    /// Launch two: the relaunch. The three columns are as launch one left them; Watch comes on by each way back and shows them, the free column still free.
    static func readLaunch(model: AppModel, report: (String, Bool, String) -> Void, wait: @escaping (Double) async -> Void) async {
        guard model.config.fixture, let url = handoffURL(), let data = try? Data(contentsOf: url), let h = try? JSONDecoder().decode(Handoff.self, from: data) else {
            report("Watch trips (launch 2): a hand-off file from launch 1", false, "missing or unreadable"); return
        }
        let k = Kit(model: model, wait: wait, notes: URL(fileURLWithPath: "/"), plan: URL(fileURLWithPath: "/"))
        model.agentViewEnabled = false
        model.mode = .herdr; model.showWeb = true; model.webTab = .reader
        model.watch.openAskTurnID = { _ in nil }
        report("launch 2 starts on the setup launch 1 quit with (\(h.quit)): three columns, each session in its place, the middle one free, Watch off",
               model.watch.count == 3 && model.watch.layout.setup.columns == h.setup && !model.watchOn, "count=\(model.watch.count) setup=\(tails(model.watch.layout.setup.columns)) expected=\(tails(h.setup)) watchOn=\(model.watchOn)")
        for (i, back) in returns.prefix(3).enumerated() {
            model.watchOn = false; await wait(0.4)
            await back.go(k); await k.settle()
            report("relaunched, Watch comes on by \(back.name): the setup launch 1 left, two columns loaded, the free one not filled",
                   model.watchOn && k.slots == h.setup && model.watch.boxes.count == 2 && k.loaded, "setup=\(tails(k.slots)) views=\(model.watch.boxes.count)")
            if i == 0 { await WatchSetupsCheck.shot("watch-trips-3-after-relaunch-\(h.quit).png") }
        }
        model.watchOn = false
        model.watch.forgetEverything()
    }
}
