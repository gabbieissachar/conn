// Conn: a native Mac workspace app and a client of one Herdr session (`herdr server` stays the backend).
import SwiftUI
import AppKit
import ConnCore
import ConnTerminal

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor func applicationDidFinishLaunching(_ n: Notification) {
        let cfg = Runtime.config, model = Runtime.model
        if cfg.runsInBackground {
            // Test mode: no Dock icon, never activated, never key, nothing the person at the keyboard can see or click.
            NSApplication.shared.setActivationPolicy(.accessory)
            Background.keepWindowsInert()
        } else {
            NSApplication.shared.setActivationPolicy(.regular)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        if cfg.dark { model.appearance = .dark }
        if let t = cfg.webTab { model.webTab = t }
        if let n = cfg.watch { model.setWatchCount(n); model.watchOn = true }
        model.privacy = cfg.privacy
        // The first view was set when the model was made (`LaunchPlan`). A person's own launch on the Herdr client view
        // attaches the client here, so the view is ready without a click; a scripted launch never does.
        if cfg.launchPlan.attachesClient { model.attachHerdrClient() }
        if let size = cfg.windowSize { DispatchQueue.main.async { Capture.mainWindow()?.setContentSize(size) } }
        model.editor.restoreSession()
        for f in cfg.openFiles { model.editor.openFromOutside([URL(fileURLWithPath: f)]) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            let list = model.agentOrder
            if let i = cfg.select, i < list.count { model.select(list[i].id) }
            if cfg.compare, model.comparePaneID == nil { model.toggleCompare() }
            if cfg.openHistory { DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { model.openHistory() } }
        }
        if let dir = cfg.tour { Task { @MainActor in try? await Task.sleep(nanoseconds: 3_000_000_000); await Tour.run(dir: URL(fileURLWithPath: dir), model: model); model.shutdown(); NSApplication.shared.terminate(nil) } }
        if let path = cfg.shot {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(cfg.shotDelay * 1_000_000_000))
                await Capture.window(to: URL(fileURLWithPath: path))
                model.shutdown(); NSApplication.shared.terminate(nil)
            }
        }
        if let file = cfg.editorTest {
            Task { @MainActor in await EditorSelfTest.run(file: file, model: model) }
        }
        if cfg.uiTour { Task { @MainActor in await UICheck.run(model: model) } }
        if cfg.campusCheck { Task { @MainActor in await CampusCheck.runAlone(model: model) } }
        if let secs = cfg.campusBridgeLab { Task { @MainActor in await CampusCheck.bridgeLab(model: model, seconds: secs) } }
        if cfg.probeDraw { Task { @MainActor in await DrawProbe.run(model: model) } }
        if cfg.startFallback {
            // The Herdr client pane is an interactive second client: this test hook may only run when both the socket
            // directory and the herdr executable are a stand-in's, never attach to a real session without a click.
            if !model.endpoint.isStandIn {
                FileHandle.standardError.write("conn: --start-fallback refused: it would attach a second client to a real Herdr session\n".data(using: .utf8)!)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { model.mode = .herdr; model.attachHerdrClient() }
            }
        }
        if let text = cfg.sendTest {
            // End-to-end check of the compose path without clicking: type the text into the box and send it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { model.compose = text; model.send() }
        }
        if let secs = cfg.selftest { Task { @MainActor in await SelfTest.run(after: secs, model: model) } }
        if let q = cfg.quitAfter { DispatchQueue.main.asyncAfter(deadline: .now() + q) { model.shutdown(); NSApplication.shared.terminate(nil) } }
        model.updateStats()
    }

    @MainActor func application(_ application: NSApplication, open urls: [URL]) {
        // Finder's Open With, a drop on the Dock icon, and the `conn` command (through `open -a`): folders and files.
        Runtime.model.openFromOutside(urls)
    }

    @MainActor func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Runtime.model.editor.confirmQuit() ? .terminateNow : .terminateCancel
    }

    @MainActor func applicationWillTerminate(_ n: Notification) { Runtime.model.shutdown() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/// Test mode (`--background`): every window is made fully transparent and click-through the moment AppKit first updates it,
/// and any window that becomes key gives it up again. Nothing in the app calls `activate` or `makeKeyAndOrderFront` in this
/// mode, and the process is an accessory (no Dock icon), so it cannot take the keyboard or the pointer from another app.
/// Views still lay out and draw, so the in-process checks and captures work.
@MainActor
enum Background {
    /// Held for the life of the process: without it App Nap throttles timers and layout of a window nobody can see.
    private static var activity: NSObjectProtocol?

    static func keepWindowsInert() {
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "Conn test mode: keep timers, layout and streams running in an inert window")
        let nc = NotificationCenter.default
        for name in [NSWindow.didUpdateNotification, NSWindow.didBecomeKeyNotification, NSWindow.didBecomeMainNotification, NSWindow.didExposeNotification] {
            nc.addObserver(forName: name, object: nil, queue: .main) { n in
                guard let w = n.object as? NSWindow else { return }
                MainActor.assumeIsolated { inert(w) }
            }
        }
        // Windows that exist before the first notification.
        Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in MainActor.assumeIsolated { NSApp.windows.forEach(inert) } }
    }

    private static func inert(_ w: NSWindow) {
        if w.alphaValue != 0 { w.alphaValue = 0 }
        if !w.ignoresMouseEvents { w.ignoresMouseEvents = true }
        if w.isKeyWindow { w.resignKey() }
    }
}

enum TextFinderCommand {
    /// Sends the standard text-finder action down the responder chain, as the Find menu items of a text app do.
    @MainActor @discardableResult
    static func send(_ action: NSTextFinder.Action, to target: Any? = nil) -> Bool {
        let item = NSMenuItem()
        item.tag = action.rawValue
        return NSApp.sendAction(#selector(NSResponder.performTextFinderAction(_:)), to: target, from: item)
    }
}

struct ConnCommands: Commands {
    @ObservedObject var app: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Document") { app.mode = .editor; app.editor.newDocument() }.keyboardShortcut("n")
            Button("Open…") { app.mode = .editor; app.editor.showOpenPanel(startingIn: app.selectedAgent?.cwd) }.keyboardShortcut("o")
            Button("Open Folder…") { app.mode = .editor; app.editor.showOpenFolderPanel(startingIn: app.selectedAgent?.cwd) }
                .keyboardShortcut("o", modifiers: [.command, .shift])
            Menu("Open Recent") {
                let folders = RecentFolders.existing(app.editor.recentFolders)
                let recents = NSDocumentController.shared.recentDocumentURLs
                ForEach(folders, id: \.self) { path in
                    Button((path as NSString).lastPathComponent) { app.openFromOutside([URL(fileURLWithPath: path)]) }.help(path)
                }
                if !folders.isEmpty && !recents.isEmpty { Divider() }
                ForEach(recents, id: \.self) { url in
                    Button(url.lastPathComponent) { app.openFromOutside([url]) }.help(url.path)
                }
                if folders.isEmpty && recents.isEmpty { Text("No recent items") }
            }
            Button("Close Folder") { app.editor.closeFolder() }.disabled(app.editor.folder == nil)
        }
        // Conn has nothing to print, and Cmd+P is Go to File in the Editor view.
        CommandGroup(replacing: .printItem) {}
        // The editor's text view has a find bar, but the Edit menu SwiftUI builds has no Find items to trigger it.
        CommandGroup(after: .textEditing) {
            Button("Find…") { TextFinderCommand.send(.showFindInterface) }.keyboardShortcut("f")
            Button("Find Next") { TextFinderCommand.send(.nextMatch) }.keyboardShortcut("g")
            Button("Find Previous") { TextFinderCommand.send(.previousMatch) }.keyboardShortcut("g", modifiers: [.command, .shift])
        }
        CommandGroup(replacing: .saveItem) {
            Button("Save") { if let d = app.editor.current { app.editor.save(d) } }.keyboardShortcut("s").disabled(app.editor.current == nil)
            Button("Save As…") { if let d = app.editor.current { app.editor.saveAs(d) } }.keyboardShortcut("s", modifiers: [.command, .shift]).disabled(app.editor.current == nil)
            Button("Close Document") { if let d = app.editor.current { app.editor.close(d) } }.keyboardShortcut("w").disabled(app.editor.current == nil || app.mode != .editor)
            Divider()
            // With the Explorer focused these copy its selected row; otherwise the open file.
            Button("Copy Path") { app.editor.copyPath(relative: false) }.keyboardShortcut("c", modifiers: [.command, .option])
            Button("Copy Relative Path") { app.editor.copyPath(relative: true) }.keyboardShortcut("c", modifiers: [.command, .option, .shift])
            Divider()
            Button(app.connCommandInstallTitle) { app.showConnCommandAlert(app.installConnCommand()) }
            Button("Uninstall 'conn' Command") { app.showConnCommandAlert(app.uninstallConnCommand()) }.disabled(!app.connCommandRemovable)
        }
        CommandMenu("Agents") {
            Button("Quick Switcher…") { app.showSwitcher = true }.keyboardShortcut("k")
            Button("Next Agent") { app.cycle(1) }.keyboardShortcut("]")
            Button("Previous Agent") { app.cycle(-1) }.keyboardShortcut("[")
            Button("Next Agent Waiting on You") { app.jumpToWaiting() }.keyboardShortcut("j")
            if app.agentViewEnabled {
                Button(app.primaryHistory == nil ? "Scroll Back (Show History)" : "Back to Live Pane") { app.toggleHistory(.primary) }
                    .keyboardShortcut("y")
            }
            Divider()
            ForEach(0..<9, id: \.self) { i in
                Button("Agent \(i + 1)") { app.selectNth(i) }.keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
            }
            if app.agentViewEnabled {
                Divider()
                Button(app.comparePaneID == nil ? "Compare with Previous Agent" : "Close Comparison") { app.toggleCompare() }.keyboardShortcut("\\")
            }
        }
        if app.campus.link != .disabled {
            CommandMenu("Campus") {
                Button("Sign in to Campus…") { app.signInToCampus() }
                Button("Open Campus in the Browser") { NSWorkspace.shared.open(app.campus.baseURL) }
                Button("Check Campus Now") { app.campus.kick() }
                Divider()
                CampusNewMenuItems(campus: app.campus).environmentObject(app)
                Divider()
                // The conversation on screen: keep it in the Reader column's starred row, or put it in a Watch column (no shortcut: Cmd+K, Cmd+J and Cmd+1..9 are taken).
                Button(app.campusSelected.map { app.campusIsStarred($0.id) } == true ? "Remove Star from This Conversation" : "Star This Conversation") { if let c = app.campusSelected { app.toggleCampusStar(c) } }
                    .disabled(app.campusSelected == nil)
                Button("Open This Conversation in a Watch Column") { if let c = app.campusSelected { app.showCampusInWatch(c.id) } }.disabled(app.campusSelected == nil)
                Divider()
                Toggle("Campus Writes", isOn: Binding(get: { app.campus.writesEnabled }, set: { on in if on { app.requestCampusWrites() } else { app.disableCampusWrites() } }))
                if let b = app.campusBridge {
                    Toggle("Agent Bridge", isOn: Binding(get: { b.enabled }, set: { on in if on { app.requestCampusBridge() } else { app.disableCampusBridge() } }))
                    Button("Agent Bridge Activity…") { app.campusBridgeActivityShown = true }
                }
            }
        }
        CommandMenu("Layout") {
            // A view keeps its own number (Editor stays Opt+Cmd+3) when the Agent view is off.
            ForEach(app.viewPolicy.modes) { m in
                Button(m.rawValue) { app.mode = m }
                    .keyboardShortcut(KeyEquivalent(Character("\((CenterMode.allCases.firstIndex(of: m) ?? 0) + 1)")), modifiers: [.command, .option])
            }
            Divider()
            // From another view these show the Editor first (as Open... does), then act.
            Toggle("Explorer", isOn: Binding(get: { app.explorerVisible }, set: { on in
                if app.mode != .editor { app.mode = .editor; app.explorerVisible = true } else { app.explorerVisible = on }
            })).keyboardShortcut("b")
            Button("Focus Explorer") { app.mode = .editor; app.editor.toggleExplorerFocus() }.keyboardShortcut("e", modifiers: [.command, .shift])
            Button("Go to File…") { app.mode = .editor; app.editor.showQuickOpen() }.keyboardShortcut("p")
            Button("Next Editor Tab") { app.mode = .editor; app.editor.cycleTab(1) }.keyboardShortcut("]", modifiers: [.command, .shift])
            Button("Previous Editor Tab") { app.mode = .editor; app.editor.cycleTab(-1) }.keyboardShortcut("[", modifiers: [.command, .shift])
            Divider()
            if app.agentViewEnabled {
                Button("Make Pane Text Bigger") { app.zoomPane(1) }.keyboardShortcut("=").disabled(app.mode != .agent)
                Button("Make Pane Text Smaller") { app.zoomPane(-1) }.keyboardShortcut("-").disabled(app.mode != .agent)
                Button("Pane Text Fits the Pane") { app.resetPaneZoom() }.keyboardShortcut("0").disabled(app.mode != .agent)
                Divider()
            }
            Button(app.watchOn ? "Leave Watch" : "Watch Several Sessions") { app.watchOn.toggle() }.keyboardShortcut("w", modifiers: [.command, .shift])
            Picker("Watch Columns", selection: Binding(get: { app.watch.count }, set: { app.setWatchCount($0) })) {
                ForEach(Array(WatchLayout.allowedCounts), id: \.self) { Text("\($0) columns").tag($0) }
            }
            Divider()
            Toggle("Reader and Organizer", isOn: $app.readerToggle).keyboardShortcut("r", modifiers: [.command, .option])
            Toggle("Reader Follows Selected Agent", isOn: $app.readerFollows).keyboardShortcut("f", modifiers: [.command, .option])
            Toggle("Privacy Mode", isOn: $app.privacy).keyboardShortcut("b", modifiers: [.command, .shift])
            // Ctrl+Cmd+S is the system's own key for a sidebar (Finder, Mail); Cmd+B is the Editor's Explorer.
            Button(app.sidebarVisible ? "Hide Sidebar" : "Show Sidebar") { app.sidebarVisible.toggle() }.keyboardShortcut("s", modifiers: [.command, .control])
            Divider()
            Button("Reload Web Panes") { app.reloadWeb() }.keyboardShortcut("r")
        }
    }
}

struct ConnApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    private let app = MainActor.assumeIsolated { Runtime.model }

    var body: some Scene {
        // One window: the model and its terminal views are shared, and a second window would fight over them.
        Window("Conn", id: "main") {
            MainView()
                .environmentObject(app)
                .frame(minWidth: 1000, minHeight: 600)
        }
        .defaultSize(width: 1500, height: 920)
        .commands { ConnCommands(app: app) }

        MenuBarExtra(isInserted: .constant(!Runtime.config.runsInBackground)) {
            WaitingMenu().environmentObject(app)
        } label: {
            MenuBarLabel(app: app)
        }
        .menuBarExtraStyle(.window)

        Settings { CampusSettingsView(campus: app.campus).environmentObject(app) }
    }
}
