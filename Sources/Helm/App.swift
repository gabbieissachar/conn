// Helm: a native Mac workspace app and a client of one Herdr session (`herdr server` stays the backend).
import SwiftUI
import AppKit
import HelmCore
import HelmTerminal

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor func applicationDidFinishLaunching(_ n: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        let cfg = Runtime.config, model = Runtime.model
        if cfg.dark { model.appearance = .dark }
        model.privacy = cfg.privacy
        if let m = cfg.mode { model.mode = m }
        model.editor.restoreSession()
        for f in cfg.openFiles { model.editor.open(URL(fileURLWithPath: f)) }
        if !cfg.openFiles.isEmpty && cfg.mode == nil { model.mode = .editor }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            let list = model.snapshot.prioritized
            if let i = cfg.select, i < list.count { model.select(list[i].id) }
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
        if cfg.probeDraw { Task { @MainActor in await DrawProbe.run(model: model) } }
        if cfg.startFallback {
            // The Herdr-screen pane is an interactive second client: this test hook may only run against a stand-in
            // (a socket directory outside ~/.config/herdr), never attach to a real session without a click.
            let real = NSHomeDirectory() + "/.config/herdr"
            let dir = (model.endpoint.socketDirectory as NSString).standardizingPath
            if dir == real || dir.hasPrefix(real + "/") {
                FileHandle.standardError.write("helm: --start-fallback refused: it would attach a second client to a real Herdr session\n".data(using: .utf8)!)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { model.mode = .herdr; model.fallback.start(endpoint: model.endpoint, theme: model.terminalTheme) }
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
        let m = Runtime.model
        urls.forEach { m.editor.open($0) }
        m.mode = .editor
    }

    @MainActor func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Runtime.model.editor.confirmQuit() ? .terminateNow : .terminateCancel
    }

    @MainActor func applicationWillTerminate(_ n: Notification) { Runtime.model.shutdown() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct HelmCommands: Commands {
    @ObservedObject var app: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Document") { app.mode = .editor; app.editor.newDocument() }.keyboardShortcut("n")
            Button("Open…") { app.mode = .editor; app.editor.showOpenPanel() }.keyboardShortcut("o")
        }
        CommandGroup(replacing: .saveItem) {
            Button("Save") { if let d = app.editor.current { app.editor.save(d) } }.keyboardShortcut("s").disabled(app.editor.current == nil)
            Button("Save As…") { if let d = app.editor.current { app.editor.saveAs(d) } }.keyboardShortcut("s", modifiers: [.command, .shift]).disabled(app.editor.current == nil)
            Button("Close Document") { if let d = app.editor.current { app.editor.close(d) } }.keyboardShortcut("w").disabled(app.editor.current == nil || app.mode != .editor)
        }
        CommandMenu("Agents") {
            Button("Quick Switcher…") { app.showSwitcher = true }.keyboardShortcut("k")
            Button("Next Agent") { app.cycle(1) }.keyboardShortcut("]")
            Button("Previous Agent") { app.cycle(-1) }.keyboardShortcut("[")
            Button("Next Agent Waiting on You") { app.jumpToWaiting() }.keyboardShortcut("j")
            Divider()
            ForEach(0..<9, id: \.self) { i in
                Button("Agent \(i + 1)") { app.selectNth(i) }.keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
            }
            Divider()
            Button(app.comparePaneID == nil ? "Compare with Previous Agent" : "Close Comparison") { app.toggleCompare() }.keyboardShortcut("\\")
        }
        CommandMenu("Layout") {
            ForEach(Array(CenterMode.allCases.enumerated()), id: \.element.id) { i, m in
                Button(m.rawValue) { app.mode = m }.keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: [.command, .option])
            }
            Divider()
            Toggle("Reader and Organizer", isOn: $app.showWeb).keyboardShortcut("r", modifiers: [.command, .option])
            Toggle("Reader Follows Selected Agent", isOn: $app.readerFollows).keyboardShortcut("f", modifiers: [.command, .option])
            Toggle("Privacy Mode", isOn: $app.privacy).keyboardShortcut("b", modifiers: [.command, .shift])
            Toggle("Sidebar", isOn: $app.sidebarVisible).keyboardShortcut("s", modifiers: [.command, .control])
            Divider()
            Button("Reload Web Panes") { app.reloadWeb() }.keyboardShortcut("r")
        }
    }
}

struct HelmApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    private let app = MainActor.assumeIsolated { Runtime.model }

    var body: some Scene {
        WindowGroup("Helm") {
            MainView()
                .environmentObject(app)
                .frame(minWidth: 1000, minHeight: 600)
        }
        .defaultSize(width: 1500, height: 920)
        .commands { HelmCommands(app: app) }

        MenuBarExtra {
            WaitingMenu().environmentObject(app)
        } label: {
            MenuBarLabel(app: app)
        }
        .menuBarExtraStyle(.window)
    }
}
