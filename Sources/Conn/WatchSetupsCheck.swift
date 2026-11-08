// `--ui-check` steps for the Watch column setups (README "Watch view"): the setup survives a trip to another view, each column count
// opens on its own last setup, a relaunch reads the setups back from the settings, and presets save, load, rename and delete.
// Fixture only (the stand-in Herdr's agents and the invented lite page; the stand-in Campus for a conversation that is gone).
//
//   CONN_UI_CHECK_ONLY=watch-setups ./run.sh --fixture --ui-check            the steps in one launch (also part of the full --ui-check)
//   CONN_UI_CHECK_ONLY=watch-setups-write CONN_UI_CHECK_HANDOFF=FILE ./run.sh --fixture --ui-check
//   CONN_UI_CHECK_ONLY=watch-setups-read  CONN_UI_CHECK_HANDOFF=FILE ./run.sh --fixture --ui-check
//       two launches in a row (a real relaunch: the first leaves setups in the test settings, the second reads them back)
import SwiftUI
import ConnCore

@MainActor
enum WatchSetupsCheck {
    static func tails(_ l: [String?]) -> [String] { l.map { $0.map { CampusColumn.isCampus($0) ? "C" + String($0.suffix(4)) : String($0.suffix(4)) } ?? "-" } }

    /// The stand-in for "Campus no longer lists it", for a launch where Campus is not live (the real rule is checked in the Campus checks).
    static func simulateGone(_ model: AppModel, _ key: String) { model.watch.isGone = { s in s == key || WatchSetup.isGone(s, campusKnown: false, campusHas: { _ in true }) } }

    static func settle(_ model: AppModel, wait: (Double) async -> Void, timeout: Double = 20) async {
        var t = 0.0
        while t < timeout, !(model.watch.boxes.count >= model.watch.layout.openCount && model.watch.boxes.values.allSatisfy { $0.phase == .ready }) { await wait(0.25); t += 0.25 }
        await wait(0.6)
    }

    static func shot(_ name: String) async {
        if let d = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] { await Capture.window(to: URL(fileURLWithPath: d).appendingPathComponent(name)) }
    }

    /// Sessions of agents the stand-in Herdr has, none of them the ones Watch fills by itself first.
    static func pick(_ model: AppModel) -> [String]? {
        let s = model.snapshot.prioritized.compactMap { $0.sessionID }
        return s.count >= 12 ? s : nil
    }

    // MARK: one launch

    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture else { return }
        let saved = (count: model.watch.count, mode: model.mode, web: model.showWeb, tab: model.webTab)
        defer { model.watchOn = false; model.watch.forgetEverything(); model.setWatchCount(saved.count); model.mode = saved.mode; model.showWeb = saved.web; model.webTab = saved.tab }
        if let w = Capture.mainWindow() { w.setContentSize(NSSize(width: 1500, height: 900)) }
        guard let sessions = pick(model) else { report("Watch setups: enough agents with a conversation", false, "too few"); return }
        func slots() -> [String?] { model.watch.layout.slots.map { $0?.session } }
        func loaded() -> Bool { model.watch.boxes.count == model.watch.layout.openCount && model.watch.boxes.values.allSatisfy { $0.phase == .ready } }
        func addresses() -> [String] { model.watch.layout.slots.map { c in c.flatMap { model.watch.boxes[$0.id]?.webView.url?.fragment } ?? "-" } }
        model.watch.openAskTurnID = { _ in nil }

        // The person's setup: three columns, picked by hand and not the ones Watch fills by itself.
        model.mode = .agent; model.showWeb = true; model.webTab = .reader
        model.watchOn = false; await wait(0.3)
        model.watch.forgetEverything()
        model.setWatchCount(3)
        model.watchOn = true; await settle(model, wait: wait)
        for c in (0..<3).reversed() { model.watch.close(column: c) }
        let mine = [sessions[9], sessions[4], sessions[7]]
        for s in mine { model.watch.open(session: s) }
        await settle(model, wait: wait)
        report("setup: three columns hold the three sessions picked by hand, in order", slots() == mine.map { Optional($0) }, "slots=\(tails(slots()))")
        await shot("watch-setups-1-before.png")

        // 1. Away to another view and back: the same count, the same session in each column, the same order.
        for (name, from, away) in [("Editor", CenterMode.agent, CenterMode.editor), ("Herdr client", .agent, .herdr), ("Agent", .herdr, .agent)] {
            model.watchOn = false; model.mode = from; await wait(0.3)
            model.watchOn = true; await settle(model, wait: wait)
            let first = slots()
            model.mode = away; await wait(0.8)
            let off = !model.watchOn && model.watch.boxes.isEmpty
            let kept = slots()
            model.watchOn = true; await settle(model, wait: wait)
            report("Watch to the \(name) view and back: Watch let go of its web views while away, then every column is back as it was, in order",
                   model.mode == away && off && kept == first && slots() == first && model.watch.count == 3 && loaded(),
                   "mode=\(model.mode.rawValue) off=\(off) before=\(tails(first)) away=\(tails(kept)) after=\(tails(slots())) count=\(model.watch.count) views=\(model.watch.boxes.count)")
            if name == "Editor" { await shot("watch-setups-2-after-editor.png") }
        }
        report("each column reopens at its newest turn (no asking reply: the address is the session alone)", addresses().enumerated().allSatisfy { $0.element == "s=\(mine[$0.offset])" }, "addresses=\(addresses().map { String($0.suffix(10)) })")

        // A column the person closed stays closed over the trip (it is not filled again from the sidebar).
        model.watch.close(column: 1)
        let withGap = slots()
        model.mode = .editor; await wait(0.6)
        model.watchOn = true; await settle(model, wait: wait)
        report("a column closed before the trip is still free after it, and the others did not move", slots() == withGap && withGap[1] == nil && model.watch.boxes.count == 2, "before=\(tails(withGap)) after=\(tails(slots())) views=\(model.watch.boxes.count)")
        model.watch.open(session: mine[1]); await settle(model, wait: wait)

        // 2. Each column count opens on its own last setup.
        let three = slots()
        model.setWatchCount(2); await settle(model, wait: wait)
        let twoFirst = slots()
        model.watch.close(column: 0); model.watch.open(session: sessions[10]); model.watch.open(session: sessions[11]); await settle(model, wait: wait)
        let two = slots()
        model.setWatchCount(4); await settle(model, wait: wait)
        let four = slots()
        report("a count never used (4) fills as it always did: every column filled from the sidebar's order, none twice", four.count == 4 && four.allSatisfy { $0 != nil } && Set(four.compactMap { $0 }).count == 4 && loaded(), "four=\(tails(four))")
        await shot("watch-setups-4-four-columns.png")
        model.setWatchCount(3); await settle(model, wait: wait)
        report("3 -> 2 -> 4 -> 3 columns: the three-column setup is back as it was", slots() == three && loaded(), "three=\(tails(three)) two=\(tails(twoFirst)) four=\(tails(four)) back=\(tails(slots()))")
        await shot("watch-setups-3-after-2-and-3.png")
        model.setWatchCount(2); await settle(model, wait: wait)
        report("2 columns opens the two-column setup as it was last left (not the shrink of the three)", slots() == two && loaded(), "left=\(tails(two)) now=\(tails(slots()))")
        model.setWatchCount(4); await settle(model, wait: wait)
        report("4 columns opens the four-column setup as it was last left", slots() == four && loaded(), "left=\(tails(four)) now=\(tails(slots()))")
        model.setWatchCount(3); await settle(model, wait: wait)

        // The settings hold ids and order only, and a relaunch reads them back.
        let key = WatchModel.setupsKey
        let raw = AppModel.defaults.data(forKey: key)
        let text = raw.map { String(decoding: $0, as: UTF8.self) } ?? ""
        let names = model.snapshot.agents.map(\.name).filter { $0.count > 3 }
        let read = WatchSetups.decode(raw)
        let relaunched = WatchModel(hub: model.web, defaults: AppModel.defaults)
        report("the settings hold the last setup of each count as session ids and order, and no name or text", raw != nil && read == model.watch.setups && read.last(forCount: 3)?.columns == three && read.last(forCount: 2)?.columns == two && read.last(forCount: 4)?.columns == four && names.allSatisfy { !text.contains($0) } && text.contains(mine[0]),
               "bytes=\(raw?.count ?? 0) counts=\([2, 3, 4].map { read.last(forCount: $0)?.count ?? 0 }) names=\(names.count)")
        report("a relaunch (a second model on the same settings) opens on the setup it was left in", relaunched.count == 3 && relaunched.layout.setup.columns == three && AppModel.defaults.integer(forKey: WatchModel.countKey) == 3,
               "count=\(relaunched.count) setup=\(tails(relaunched.layout.setup.columns)) left=\(tails(three))")

        // 3. Presets.
        await presets(model: model, report: report, wait: wait, sessions: sessions)
    }

    static func presets(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, sessions: [String]) async {
        func slots() -> [String?] { model.watch.layout.slots.map { $0?.session } }
        func loaded() -> Bool { model.watch.boxes.count == model.watch.layout.openCount && model.watch.boxes.values.allSatisfy { $0.phase == .ready } }
        func layoutMenu() -> NSMenu? { NSApp.mainMenu?.items.first { $0.title == "Layout" }?.submenu }
        func titles(_ m: NSMenu?) -> [String] { m?.items.filter { !$0.isSeparatorItem }.map(\.title) ?? [] }
        func loadMenu() -> NSMenu? { layoutMenu()?.items.first { $0.title == "Load Preset" }?.submenu }
        func item(_ title: String) -> NSMenuItem? { layoutMenu()?.items.first { $0.title == title } }
        func quiet() { model.toastText = nil }

        model.watch.forgetEverything()
        model.setWatchCount(3); model.watchOn = true; await settle(model, wait: wait)
        for c in (0..<3).reversed() { model.watch.close(column: c) }
        let review = [sessions[6], sessions[2], sessions[8]]
        for s in review { model.watch.open(session: s) }
        await settle(model, wait: wait)
        await wait(0.4)
        let saveItem = item("Save Column Setup as Preset\u{2026}"), manageItem = item("Rename or Delete Presets\u{2026}")
        // The items' enabled state and the presets listed under Load Preset are drawn when SwiftUI rebuilds the menu as it opens (this inert window never opens it):
        // they follow `watch.setups`, and are a hand check (README "Watch view").
        report("Layout has Save Column Setup as Preset, Load Preset and Rename or Delete Presets (no new shortcut), after Watch Columns",
               saveItem != nil && item("Load Preset") != nil && manageItem != nil && saveItem?.keyEquivalent == "" && item("Load Preset")?.keyEquivalent == "" && manageItem?.keyEquivalent == "",
               "items=\(titles(layoutMenu()).filter { $0.contains("Preset") || $0.contains("Watch") })")
        report("with no preset the Load Preset menu says so", titles(loadMenu()) == ["No Presets Yet"] && model.watch.setups.presets.isEmpty, "load=\(titles(loadMenu()))")

        // Save: the sheet opens (Layout > Save Column Setup as Preset), a name keeps what the columns hold.
        model.watchPresetSheet = .save; await wait(0.8)
        let sheet = Capture.mainWindow()?.attachedSheet
        report("Save Column Setup as Preset opens a sheet that asks for the name", model.watchPresetSheet == .save && sheet != nil, "sheet=\(sheet.map { String(describing: type(of: $0)) } ?? "nil")")
        model.watchPresetSheet = nil; await wait(0.3)
        quiet()
        let emptyName = model.saveWatchPreset(name: "   ")
        report("an empty name is refused with a notice and nothing is kept", !emptyName && model.watch.setups.presets.isEmpty && model.toastText == WatchSetups.Refusal.emptyName.message, "kept=\(model.watch.setups.presets.count) toast=\(model.toastText ?? "nil")")
        let saved = model.saveWatchPreset(name: "  Review   set ")
        let p1 = model.watch.setups.presets.first
        report("Save keeps the name (spaces tidied) and the three columns, in order", saved && p1?.name == "Review set" && p1?.setup.columns == review.map { Optional($0) } && model.watch.setups.presets.count == 1, "name=\(p1?.name ?? "nil") setup=\(tails(p1?.setup.columns ?? []))")

        // Load: the count and every column. From another setup, and from Watch off.
        model.setWatchCount(2); await settle(model, wait: wait)
        model.watch.open(session: sessions[10]); await settle(model, wait: wait)
        guard let id = p1?.id else { report("a preset to load", false, "none"); return }
        quiet()
        model.loadWatchPreset(id); await settle(model, wait: wait)
        report("Load Preset sets the column count and puts every session in its column, loaded", model.watch.count == 3 && slots() == review.map { Optional($0) } && loaded(), "count=\(model.watch.count) slots=\(tails(slots())) toast=\(model.toastText ?? "nil")")
        await shot("watch-setups-6-preset-loaded.png")
        model.mode = .editor; await wait(0.6)
        model.loadWatchPreset(id); await settle(model, wait: wait)
        report("Load Preset from another view turns Watch on with the preset's setup", model.watchOn && slots() == review.map { Optional($0) } && loaded(), "on=\(model.watchOn) slots=\(tails(slots()))")

        // Same name replaces; rename; a taken name is refused; delete.
        model.watch.close(column: 2)
        let replaced = model.saveWatchPreset(name: "REVIEW SET")
        let again = model.watch.setups.presets
        report("saving under an existing name (any capitals) replaces that preset in place", replaced && again.count == 1 && again[0].id == id && again[0].name == "REVIEW SET" && again[0].setup.columns == [review[0], review[1], nil], "presets=\(again.map(\.name)) setup=\(tails(again.first?.setup.columns ?? []))")
        model.watch.open(session: review[2]); await settle(model, wait: wait)
        _ = model.saveWatchPreset(name: "Second")
        let second = model.watch.setups.presets.first { $0.name == "Second" }
        quiet()
        let taken = model.renameWatchPreset(id, to: "second")
        report("renaming to a name another preset has is refused with a notice", !taken && model.watch.setups.preset(id: id)?.name == "REVIEW SET" && model.toastText == WatchSetups.Refusal.nameTaken.message, "name=\(model.watch.setups.preset(id: id)?.name ?? "nil") toast=\(model.toastText ?? "nil")")
        let renamed = model.renameWatchPreset(id, to: "Daily review")
        let p = model.watch.setups.preset(id: id)
        report("rename keeps the setup and changes the name", renamed && p?.name == "Daily review" && p?.setup.columns == [review[0], review[1], nil], "name=\(p?.name ?? "nil") setup=\(tails(p?.setup.columns ?? []))")
        // The settings keep the presets across a relaunch.
        let afterRelaunch = WatchModel(hub: model.web, defaults: AppModel.defaults)
        report("a relaunch reads the presets back", afterRelaunch.setups.presets.map(\.name) == ["Daily review", "Second"], "names=\(afterRelaunch.setups.presets.map(\.name))")
        model.deleteWatchPreset(id)
        report("delete removes that preset only", model.watch.setups.presets.map(\.name) == ["Second"] && model.watch.setups.preset(id: id) == nil, "left=\(model.watch.setups.presets.map(\.name))")
        if let s2 = second { model.deleteWatchPreset(s2.id) }
        report("with every preset deleted none is left", model.watch.setups.presets.isEmpty, "left=\(model.watch.setups.presets.count)")

        // A preset holding a conversation that no longer exists: loading frees its column, the normal fill takes it, and a notice says so.
        // (Campus tells that a conversation is gone only while it is live and has answered, so a signed-out Campus never empties a setup.)
        let gone = CampusColumn.key("ses_noLongerThere99")
        simulateGone(model, gone)
        defer { model.wireWatchSetups() }
        model.watch.forgetEverything()
        model.watch.openCampus("ses_noLongerThere99"); model.watch.open(session: review[0]); model.watch.open(session: review[2])
        _ = model.saveWatchPreset(name: "With a gone one")
        let gid = model.watch.setups.presets.first?.id ?? ""
        model.watch.emptyColumns()
        quiet()
        model.loadWatchPreset(gid); await settle(model, wait: wait)
        let after = slots()
        report("a preset's conversation that no longer exists leaves its column free for the normal fill, the others stay, and a notice says so",
               after.count == 3 && after[1] == review[0] && after[2] == review[2] && after[0] != nil && after[0] != gone && (model.toastText ?? "").contains("gone") && loaded(),
               "slots=\(tails(after)) toast=\(model.toastText ?? "nil")")
        await shot("watch-setups-7-gone-column.png")
        model.deleteWatchPreset(gid)
        model.watch.forgetEverything()
    }

    // MARK: two launches in a row

    /// What launch one leaves for launch two: the sessions it used, as JSON. The file is named by `CONN_UI_CHECK_HANDOFF`.
    struct Handoff: Codable { var three: [String?]; var two: [String?]; var gone: String }

    static func handoffURL() -> URL? { ProcessInfo.processInfo.environment["CONN_UI_CHECK_HANDOFF"].map { URL(fileURLWithPath: $0) } }

    /// Launch one: leave a three-column setup with a free column in the middle, and a two-column setup whose second column holds a Campus
    /// conversation that will not exist, then quit on three columns.
    static func writeLaunch(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture, let url = handoffURL(), let sessions = pick(model) else { report("Watch setups (launch 1): a stand-in Herdr, a hand-off file and enough agents", false, "missing"); return }
        model.mode = .agent; model.showWeb = true; model.webTab = .reader
        model.watch.openAskTurnID = { _ in nil }
        model.watch.forgetEverything()
        let gone = CampusColumn.key("ses_noLongerThere99")
        model.setWatchCount(2); model.watchOn = true; await settle(model, wait: wait)
        model.watch.emptyColumns()
        model.watch.open(session: sessions[8]); model.watch.openCampus("ses_noLongerThere99"); await settle(model, wait: wait)
        let two = model.watch.layout.setup.columns
        model.setWatchCount(3); await settle(model, wait: wait)
        model.watch.emptyColumns()
        model.watch.open(session: sessions[9]); model.watch.open(session: sessions[4]); model.watch.open(session: sessions[7]); model.watch.close(column: 1)
        await settle(model, wait: wait)
        let three = model.watch.layout.setup.columns
        let wrote = (try? JSONEncoder().encode(Handoff(three: three, two: two, gone: gone))).flatMap { try? $0.write(to: url) } != nil
        report("launch 1 left a three-column setup with a free middle column and a two-column setup with a conversation that will not exist",
               wrote && three == [sessions[9], nil, sessions[7]] && two == [sessions[8], gone] && model.watch.count == 3, "three=\(tails(three)) two=\(tails(two)) wrote=\(wrote)")
        model.watchOn = false
        // Quit on three columns without clearing anything: this launch's settings are the next launch's start.
    }

    /// Launch two: the settings hold what launch one left. Opening on three columns shows that setup as it was, the free column still free;
    /// two columns shows the other, the column whose conversation is gone is free and takes the normal fill, with a notice.
    static func readLaunch(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture, let url = handoffURL(), let data = try? Data(contentsOf: url), let h = try? JSONDecoder().decode(Handoff.self, from: data) else {
            report("Watch setups (launch 2): a hand-off file from launch 1", false, "missing or unreadable"); return
        }
        model.mode = .agent; model.showWeb = true; model.webTab = .reader
        model.watch.openAskTurnID = { _ in nil }
        report("launch 2 starts on the three columns launch 1 left, each session in its place and the middle column free, before Watch is turned on",
               model.watch.count == 3 && model.watch.layout.setup.columns == h.three && !model.watchOn, "count=\(model.watch.count) setup=\(tails(model.watch.layout.setup.columns)) expected=\(tails(h.three))")
        model.watchOn = true; await settle(model, wait: wait)
        report("Watch turned on shows that setup: two columns loaded, the free one not filled", model.watch.layout.setup.columns == h.three && model.watch.boxes.count == 2 && model.watch.boxes.values.allSatisfy { $0.phase == .ready },
               "setup=\(tails(model.watch.layout.setup.columns)) views=\(model.watch.boxes.count)")
        await shot("watch-setups-8-after-relaunch.png")
        simulateGone(model, h.gone)
        model.toastText = nil
        model.setWatchCount(2); await settle(model, wait: wait)
        let now = model.watch.layout.setup.columns
        report("two columns opens launch 1's two-column setup: the conversation that is gone leaves its column free for the normal fill, with a notice",
               now.count == 2 && now[0] == h.two[0] && now[1] != nil && now[1] != h.gone && (model.toastText ?? "").contains("gone") && model.watch.boxes.count == 2,
               "now=\(tails(now)) expected0=\(tails([h.two[0]])) toast=\(model.toastText ?? "nil")")
        model.setWatchCount(3); await settle(model, wait: wait)
        report("and three columns is still the setup launch 1 left", model.watch.layout.setup.columns == h.three, "setup=\(tails(model.watch.layout.setup.columns))")
        model.watchOn = false
        model.watch.forgetEverything()
        model.wireWatchSetups()
    }
}
