// `--ui-check` steps for the Agent-view flag (README "The Agent view flag"). They press keys the way the other checks do: events
// built and delivered to the app's own menu inside this process, never posted to the system.
//   runOff: the Agent view is off. It is unreachable (no Opt+Cmd+2, no menu entry, no code path), its commands are gone, and every
//           session jump (Cmd+K, Cmd+1..9, Cmd+J, Cmd+[ and Cmd+], the sidebar) shows the session in the Herdr client view.
//   runOn:  the Agent view is on. Cmd+K shows the session in the Herdr client view; the other jumps go to the Agent view as before.
import SwiftUI
import ConnCore

@MainActor
enum AgentViewCheck {
    typealias Report = (String, Bool, String) -> Void
    typealias Wait = (Double) async -> Void

    /// A key press delivered to the main menu; true when a menu item took it. The menu runs its action on a later turn.
    static func press(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags, wait: Wait) async -> Bool {
        guard let win = Capture.mainWindow(),
              let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                       windowNumber: win.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)
        else { return false }
        let handled = NSApp.mainMenu?.performKeyEquivalent(with: e) ?? false
        await wait(0.4)
        return handled
    }

    private static func titles(_ menu: String) -> [String] {
        NSApp.mainMenu?.items.first { $0.title == menu }?.submenu?.items.filter { !$0.isSeparatorItem }.map(\.title) ?? []
    }

    private static func shot(_ model: AppModel, _ name: String) async {
        guard model.config.fixture, let dir = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] else { return }
        await Capture.window(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
    }

    /// Where a jump should leave things: the Herdr client view, the session selected, no client attached, no pane streaming.
    private static func shown(_ model: AppModel, _ id: String?, mode: CenterMode = .herdr) -> Bool {
        model.mode == mode && model.selectedPaneID == id && !model.fallback.running && (mode == .agent || model.primary.paneID == nil)
    }

    /// `menusMatchFlag`: the menus were built with the Agent view off (the launch had the flag off), so their items can be checked.
    /// SwiftUI builds them once, at launch; in a launch with the flag on they still show the Agent view's items here, and the
    /// commands behind them must then do nothing on their own (the model refuses the Agent view).
    static func runOff(model: AppModel, menusMatchFlag: Bool, report: Report, wait: Wait) async {
        model.agentViewEnabled = false
        model.mode = .herdr
        model.showSwitcher = false
        await wait(0.8)
        let list = model.snapshot.prioritized
        report("Agent view off: only the Herdr client and the Editor are views", model.viewPolicy.modes == [.herdr, .editor], "modes=\(model.viewPolicy.modes.map(\.rawValue))")
        model.mode = .agent; await wait(0.2)
        report("Agent view off: asking for the Agent view in code lands on the Herdr client", model.mode == .herdr && model.primary.paneID == nil, "mode=\(model.mode.rawValue)")
        model.mode = .editor; model.mode = .agent; await wait(0.2)
        report("Agent view off: asking for it from the Editor lands on the Herdr client", model.mode == .herdr, "mode=\(model.mode.rawValue)")

        // Menus: no Agent entry, no Opt+Cmd+2, no history, compare or pane-zoom command.
        let layout = NSApp.mainMenu?.items.first { $0.title == "Layout" }?.submenu?.items.filter { !$0.isSeparatorItem }.prefix(2).map { "\($0.title) [\($0.keyEquivalent)]" } ?? []
        let layoutAll = titles("Layout"), agentsAll = titles("Agents")
        func menuReport(_ name: String, _ ok: Bool, _ detail: String) {
            if menusMatchFlag { report(name, ok, detail) } else { print("ui-check: SKIP \(name) (this launch built its menus with the Agent view on; run without --agent-view)") }
        }
        menuReport("Agent view off: the Layout menu offers Herdr client (Opt+Cmd+1) and Editor (Opt+Cmd+3) and no Agent entry",
                   layout == ["Herdr client [1]", "Editor [3]"] && !layoutAll.contains("Agent"), "layout=\(layout)")
        let gone = ["Make Pane Text Bigger", "Make Pane Text Smaller", "Pane Text Fits the Pane"].allSatisfy { !layoutAll.contains($0) }
            && ["Scroll Back (Show History)", "Back to Live Pane", "Compare with Previous Agent", "Close Comparison"].allSatisfy { !agentsAll.contains($0) }
        menuReport("Agent view off: the history, compare and pane-zoom commands are not in the menus", gone, "Layout=\(layoutAll) Agents=\(agentsAll)")
        let modeBefore = model.mode
        let h2 = await press("2", 19, [.command, .option], wait: wait)
        report("Agent view off: Opt+Cmd+2 does nothing", (!menusMatchFlag || !h2) && model.mode == modeBefore, "handled=\(h2) mode=\(model.mode.rawValue)")
        let hy = await press("y", 16, [.command], wait: wait)
        report("Agent view off: Cmd+Y does nothing (no history, no empty view)", (!menusMatchFlag || !hy) && model.primaryHistory == nil && model.mode == .herdr, "handled=\(hy) mode=\(model.mode.rawValue)")
        let hb = await press("\\", 42, [.command], wait: wait)
        model.toggleCompare(); await wait(0.2)
        report("Agent view off: compare cannot be opened", (!menusMatchFlag || !hb) && model.comparePaneID == nil, "handled=\(hb) compare=\(model.comparePaneID ?? "nil")")

        guard list.count > 4 else { print("ui-check: not enough agents for the session-jump checks"); return }
        // Every jump starts from the Editor, so each also proves it leaves another view for the Herdr client view.
        model.mode = .editor; await wait(0.2)
        let hk = await press("k", 40, [.command], wait: wait)
        let opened = model.showSwitcher
        model.showSwitcher = false
        report("Agent view off: Cmd+K opens the quick switcher", hk && opened, "handled=\(hk)")
        model.select(list[3].id, via: .quickSwitcher); await wait(0.4)
        report("Agent view off: picking a session in the quick switcher shows it in the Herdr client view", shown(model, list[3].id), "mode=\(model.mode.rawValue) selected=\(model.selectedAgent?.name ?? "nil") clientRunning=\(model.fallback.running)")
        model.mode = .editor; await wait(0.2)
        let h3 = await press("3", 20, [.command], wait: wait)
        report("Agent view off: Cmd+3 shows the third agent in the Herdr client view", h3 && shown(model, list[2].id), "handled=\(h3) mode=\(model.mode.rawValue) selected=\(model.selectedAgent?.name ?? "nil")")
        model.mode = .editor; await wait(0.2)
        let nextWaiting = model.snapshot.nextWaiting(after: model.selectedPaneID)?.id
        let hj = await press("j", 38, [.command], wait: wait)
        report("Agent view off: Cmd+J shows the next agent waiting on you in the Herdr client view", hj && nextWaiting != nil && shown(model, nextWaiting), "handled=\(hj) mode=\(model.mode.rawValue) selected=\(model.selectedAgent?.name ?? "nil")")
        model.mode = .editor; await wait(0.2)
        let nextID = model.snapshot.agent(after: model.selectedPaneID, offset: 1)?.id
        let hn = await press("]", 30, [.command], wait: wait)
        report("Agent view off: Cmd+] shows the next agent in the Herdr client view", hn && shown(model, nextID), "handled=\(hn) mode=\(model.mode.rawValue) selected=\(model.selectedAgent?.name ?? "nil")")
        model.mode = .editor; await wait(0.2)
        model.sidebarOpenAgent(list[1]); await wait(0.4)
        report("Agent view off: a sidebar click with no client attached shows the agent in the Herdr client view", shown(model, list[1].id), "mode=\(model.mode.rawValue) selected=\(model.selectedAgent?.name ?? "nil")")
        model.mode = .editor; await wait(0.2)
        model.sidebarOpenWorkspace(list[2].workspaceID); await wait(0.4)
        report("Agent view off: a sidebar click on a space shows the Herdr client view", model.mode == .herdr && model.primary.paneID == nil, "mode=\(model.mode.rawValue)")

        // What a person sees with the flag off: the two-segment switcher and the Attach pane; then a failed attach in that same view.
        model.selectWorkspace(list[0].workspaceID); model.select(list[0].id, via: .quickSwitcher); await wait(1)
        await shot(model, "agent-view-off-herdr-client.png")
        if model.endpoint.isStandIn {
            model.attachHerdrClient(); await wait(3)
            let failed = !model.fallback.running
            report("Agent view off: attaching the Herdr client keeps the Herdr client view, and a failed attach shows why there, never the Agent view",
                   model.mode == .herdr && (!failed || (model.fallback.failureText != nil || model.herdrClientError != nil || model.fallback.exitCode != nil)),
                   "mode=\(model.mode.rawValue) running=\(model.fallback.running) failure=\(model.fallback.failureText != nil) exit=\(model.fallback.exitCode.map(String.init) ?? "-")")
            await shot(model, "agent-view-off-attach-result.png")
            if model.fallback.running { model.fallback.stop(); await wait(0.5) }
        } else {
            print("ui-check: SKIP failed attach (it would start a client on a real Herdr session)")
        }
    }

    static func runOn(model: AppModel, report: Report, wait: Wait) async {
        let list = model.snapshot.prioritized
        guard model.agentViewEnabled, list.count > 4 else { return }
        model.mode = .agent; await wait(0.3)
        model.select(list[1].id, via: .quickSwitcher); await wait(0.5)
        report("Agent view on: picking a session in the quick switcher shows it in the Herdr client view", shown(model, list[1].id), "mode=\(model.mode.rawValue) selected=\(model.selectedAgent?.name ?? "nil") clientRunning=\(model.fallback.running)")
        model.mode = .editor; await wait(0.2)
        model.select(list[2].id, via: .quickSwitcher); await wait(0.4)
        report("Agent view on: the same from the Editor", shown(model, list[2].id), "mode=\(model.mode.rawValue)")
        let h3 = await press("3", 20, [.command], wait: wait)
        report("Agent view on: Cmd+3 still shows the agent in the Agent view", h3 && shown(model, list[2].id, mode: .agent), "handled=\(h3) mode=\(model.mode.rawValue)")
        model.mode = .herdr; await wait(0.2)
        let hj = await press("j", 38, [.command], wait: wait)
        report("Agent view on: Cmd+J still goes to the Agent view", hj && model.mode == .agent, "handled=\(hj) mode=\(model.mode.rawValue)")
        model.mode = .editor; await wait(0.2)
        model.select(list[0].id, via: .quickSwitcher); await wait(0.4)
        await shot(model, "agent-view-on-herdr-client.png")
        model.mode = .agent; await wait(1)
    }
}
