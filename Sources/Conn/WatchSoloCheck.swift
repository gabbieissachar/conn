// `--ui-check` steps for the button that puts one Watch column on its own (README "Watch focus", "Only this column"). Three columns of the stand-in Herdr's agents: pressing it on a column
// hides (blurs) the other two and shows this one, pressing it again shows them, a column that was hidden is shown, the hidden ids are kept for a relaunch, and with one column it does nothing.
import SwiftUI
import ConnCore

@MainActor
enum WatchSoloCheck {
    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture, model.endpoint.isStandIn else { print("ui-check: SKIP Watch only-this-column (needs the stand-in Herdr)"); return }
        let saved = (count: model.watch.count, mode: model.mode, web: model.showWeb, tab: model.webTab)
        let ids = model.snapshot.prioritized.compactMap(\.sessionID).prefix(3).map { $0 }
        guard ids.count == 3 else { report("Watch only-this-column: three agents with a conversation", false, "agents=\(ids.count)"); return }
        defer { model.watchOn = false; model.watch.forgetEverything(); model.setWatchCount(saved.count); model.mode = saved.mode; model.showWeb = saved.web; model.webTab = saved.tab }
        func column(_ i: Int) -> WatchColumn? { model.watch.layout.slots[i] }
        func hidden(_ i: Int) -> Bool { column(i).map { model.watch.isHidden($0) } ?? false }
        func state() -> [Bool] { (0..<model.watch.layout.slots.count).map { hidden($0) } }
        func blurred() async -> [Bool] {
            var out: [Bool] = []
            for i in 0..<model.watch.layout.slots.count { out.append(await WatchFocusCheck.pageState(column(i).flatMap { model.watch.boxes[$0.id] }).blurred) }
            return out
        }
        func shot(_ name: String) async {
            if let d = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] { await Capture.window(to: URL(fileURLWithPath: d).appendingPathComponent(name), webSnapshots: false) }
        }

        model.mode = .agent; model.showWeb = true; model.webTab = .reader
        model.watch.forgetEverything()
        model.setWatchCount(3); model.watchOn = true; await WatchFocusCheck.settle(model, wait: wait)
        model.watch.emptyColumns()
        for s in ids { model.watch.open(session: s) }
        await WatchFocusCheck.settle(model, wait: wait)
        guard model.watch.layout.sessions == ids else { report("Watch only-this-column: three columns showing the three agents", false, "sessions=\(model.watch.layout.sessions)"); return }

        // 1. From nothing hidden: the middle column on its own.
        let r1 = model.watch.focusColumn(1)
        await wait(0.8)
        report("only-this-column on the middle column hides the other two and keeps it shown (the eye button's own hide: their pages are blurred)",
               r1 == true && state() == [true, false, true] && model.watch.isFocused(column: 1) && !model.watch.isFocused(column: 0), "result=\(String(describing: r1)) hidden=\(state())")
        let b1 = await blurred()
        report("the hidden columns' pages are blurred and the focused one is not", b1 == [true, false, true], "blurred=\(b1)")
        await shot("watch-solo-1-middle.png")

        // 2. Pressed on another column while one is on its own: the focus moves.
        let r2 = model.watch.focusColumn(0)
        await wait(0.8)
        report("pressed on the first column it takes the focus: the first is shown, the middle and last are hidden", r2 == true && state() == [false, true, true], "result=\(String(describing: r2)) hidden=\(state())")

        // 3. Pressed again on the focused column: the others come back.
        let r3 = model.watch.focusColumn(0)
        await wait(0.8)
        report("pressed again on the column that is on its own, the other columns are shown again", r3 == false && state() == [false, false, false] && !model.watch.isFocused(column: 0), "result=\(String(describing: r3)) hidden=\(state())")
        let b3 = await blurred()
        report("their pages are readable again", b3 == [false, false, false], "blurred=\(b3)")

        // 4. A column the person had hidden themselves, and is the one asked for: it is shown.
        model.watch.toggleHidden(column: 2); await wait(0.5)
        let r4 = model.watch.focusColumn(2)
        await wait(0.8)
        report("a column that was hidden is shown by its own only-this-column, and the others are hidden", r4 == true && state() == [true, true, false], "result=\(String(describing: r4)) hidden=\(state())")

        // 5. Kept across a quit: the hidden sessions are in Conn's settings, ids only.
        let saved5 = WatchAttention.decode(AppModel.defaults.data(forKey: WatchModel.hiddenKey))
        report("what is hidden is kept for a relaunch (the two other sessions, ids only)", saved5.isHidden(ids[0]) && saved5.isHidden(ids[1]) && !saved5.isHidden(ids[2]), "kept=\(ids.map { saved5.isHidden($0) })")
        await shot("watch-solo-2-last.png")
        model.watch.focusColumn(2); await wait(0.5)

        // 6. One column: nothing to hide.
        model.setWatchCount(2); await wait(0.5)
        model.watch.close(column: 1); await wait(0.5)
        let single = model.watch.layout.slots.compactMap { $0 }.count
        let r6 = model.watch.focusColumn(0)
        report("with only one column the button does nothing", single == 1 && r6 == nil && !(column(0).map { model.watch.isHidden($0) } ?? true), "columns=\(single) result=\(String(describing: r6))")
    }
}
