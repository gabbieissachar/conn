// `--ui-check` step for the collapsible left panel: Layout > Hide Sidebar and its key (Ctrl+Cmd+S), the remembered state, and the
// Watch columns taking the room it gives up. Nothing here needs a Herdr session, so it runs with or without `--fixture`.
import SwiftUI
import ConnCore

@MainActor
enum SidebarCheck {
    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        let saved = (sidebar: model.sidebarVisible, watch: model.watchOn, mode: model.mode, web: model.showWeb)
        defer { model.sidebarVisible = saved.sidebar; model.watchOn = saved.watch; model.mode = saved.mode; model.showWeb = saved.web }
        let key = "conn.sidebar.visible"
        model.sidebarVisible = true
        if let w = Capture.mainWindow() { w.setContentSize(NSSize(width: 1500, height: 900)) }

        // The menu item and its key.
        func layoutItem() -> NSMenuItem? {
            NSApp.mainMenu?.items.first { $0.title == "Layout" }?.submenu?.items.first { $0.title == "Hide Sidebar" || $0.title == "Show Sidebar" }
        }
        await wait(0.5)
        let item = layoutItem()
        let mods = item?.keyEquivalentModifierMask ?? []
        report("Layout has a sidebar item on Ctrl+Cmd+S (the system's own sidebar key; Cmd+B is the Explorer's)",
               item != nil && item?.keyEquivalent == "s" && mods.contains(.command) && mods.contains(.control) && !mods.contains(.shift) && !mods.contains(.option),
               "title=\(item?.title ?? "-") key=\(item?.keyEquivalent ?? "-") mods=\(mods.rawValue)")
        var clashes: [String] = []
        func scan(_ m: NSMenu) { for i in m.items where !i.isSeparatorItem {
            if i.keyEquivalent == "s", i.keyEquivalentModifierMask.intersection([.command, .control, .option, .shift]) == [.command, .control], i.title != "Hide Sidebar", i.title != "Show Sidebar" { clashes.append(i.title) }
            if let sub = i.submenu { scan(sub) } } }
        if let main = NSApp.mainMenu { scan(main) }
        report("no other menu item uses Ctrl+Cmd+S", clashes.isEmpty, "clashes=\(clashes)")

        // The key hides it, the same key shows it again, and the choice is written to the preferences.
        func press() async -> Bool {
            guard let win = Capture.mainWindow(),
                  let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command, .control], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: win.windowNumber, context: nil, characters: "s", charactersIgnoringModifiers: "s", isARepeat: false, keyCode: 1) else { return false }
            let handled = NSApp.mainMenu?.performKeyEquivalent(with: e) ?? false
            await wait(0.4)
            return handled
        }
        var viaKey = await press()
        if !viaKey, let i = layoutItem(), let action = i.action { viaKey = NSApp.sendAction(action, to: i.target, from: i) }     // an inert window may not match the key itself
        await wait(0.3)
        report("Ctrl+Cmd+S (the menu item) hides the sidebar and the choice is saved", !model.sidebarVisible && AppModel.defaults.object(forKey: key) as? Bool == false,
               "key=\(viaKey) visible=\(model.sidebarVisible) saved=\(String(describing: AppModel.defaults.object(forKey: key)))")      // the item's title follows when the menu opens: a hand check
        _ = await press()
        if model.sidebarVisible == false, let i = layoutItem(), let action = i.action { _ = NSApp.sendAction(action, to: i.target, from: i) }
        await wait(0.3)
        report("the same key shows it again and that is saved too", model.sidebarVisible && AppModel.defaults.object(forKey: key) as? Bool == true,
               "visible=\(model.sidebarVisible) saved=\(String(describing: AppModel.defaults.object(forKey: key)))")

        // Watch: its columns share what the sidebar gives up.
        model.showWeb = true
        model.watch.forgetEverything()
        model.watchOn = true
        model.setWatchCount(3)
        await wait(2.5)
        // The columns' web views are made when their views first draw: wait for all three instead of trusting a fixed pause on a busy machine.
        var waited = 0.0
        while model.watch.boxes.count < 3 && waited < 15 { await wait(0.25); waited += 0.25 }
        await wait(0.5)
        func columnWidths() -> [CGFloat] { model.watch.boxes.values.map { $0.webView.frame.width }.sorted() }
        let withSidebar = columnWidths()
        model.sidebarVisible = false
        await wait(1.0)
        let without = columnWidths()
        let gained = zip(withSidebar, without).reduce(0) { $0 + ($1.1 - $1.0) }
        report("with the sidebar hidden the Watch columns use its width (about 251 pt more in total)", withSidebar.count == without.count && !withSidebar.isEmpty && gained > 230 && gained < 270,
               "slots=\(model.watch.layout.slots.map { $0?.session.suffix(6).description ?? "-" }) campus=\(model.campusSelectedID ?? "nil") phases=\(model.watch.boxes.values.map { "\($0.phase)" }) columns=\(withSidebar.count) before=\(withSidebar.map { Int($0) }) after=\(without.map { Int($0) }) gained=\(Int(gained))")
        if let dir = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] { await Capture.window(to: URL(fileURLWithPath: dir).appendingPathComponent("watch-sidebar-hidden.png")) }
        model.sidebarVisible = true
        await wait(1.0)
        let back = columnWidths()
        report("showing it again gives the columns their width back", back.count == withSidebar.count && zip(back, withSidebar).allSatisfy { abs($0 - $1) < 1.5 }, "after=\(back.map { Int($0) })")
        model.watchOn = false
    }
}
